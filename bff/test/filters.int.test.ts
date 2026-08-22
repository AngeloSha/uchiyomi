// Library filters.
//
// condSql understood exactly one predicate, genre, and returned TRUE for everything else. So a read-status
// filter did not return an error or an empty list: it silently returned the entire library. That is why the
// library page shipped four sort chips and no filters at all, and it is the reason unknown predicates now
// throw instead.
//
// The other thing pinned here is that filtering happens in SQL. enrichSeries runs after LIMIT/OFFSET, so
// filtering the page afterwards would give short pages and a totalElements that disagrees with them.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let owned: any;
let UnsupportedFilter: any;

// three series, two chapters each: one untouched, one part-read, one finished
const SERIES = [
  { id: 's_fl_unread', title: 'Fl Unread', status: 'ONGOING', author: 'Aoki', genres: ['Action'] },
  { id: 's_fl_partial', title: 'Fl Partial', status: 'ONGOING', author: 'Benta', genres: ['Action', 'Romance'] },
  { id: 's_fl_done', title: 'Fl Done', status: 'COMPLETED', author: 'Aoki', genres: ['Romance'] },
];
const ALL = SERIES.map((s) => s.id);
let uidA: string, uidB: string;

const ids = (r: any) => r.content.map((s: any) => s.id).filter((i: string) => ALL.includes(i));
const search = (condition: any, ctx?: any, sort?: string) =>
  owned.searchSeries(condition ? { condition } : {}, 0, 100, sort, ctx);

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const oc = await import('../src/lib/ownedCatalog');
  owned = (oc as any).owned;
  UnsupportedFilter = (oc as any).UnsupportedFilter;
  await migrate();

  for (const name of ['fl_a', 'fl_b']) await q(`DELETE FROM users WHERE username = $1`, [name]);
  const a = await q<{ id: string }>(`INSERT INTO users (display_name, username, role, password_hash, auth_kind)
    VALUES ('A','fl_a','user','x','password') RETURNING id`);
  const b = await q<{ id: string }>(`INSERT INTO users (display_name, username, role, password_hash, auth_kind)
    VALUES ('B','fl_b','user','x','password') RETURNING id`);
  uidA = a[0].id; uidB = b[0].id;
});

beforeEach(async () => {
  if (!DSN) return;
  await q(`DELETE FROM read_progress WHERE series_id = ANY($1)`, [ALL]).catch(() => {});
  await q(`DELETE FROM lib_books WHERE series_id = ANY($1)`, [ALL]);
  await q(`DELETE FROM lib_series WHERE id = ANY($1)`, [ALL]);
  for (const s of SERIES) {
    await q(
      `INSERT INTO lib_series (id, source, title, folder, books_count, status, author, genres)
       VALUES ($1,'T!fl',$2,$1,2,$3,$4,$5)`,
      [s.id, s.title, s.status, s.author, s.genres],
    );
    for (const n of [1, 2]) {
      await q(
        `INSERT INTO lib_books (id, series_id, source, file, number, title, root)
         VALUES ($1,$2,'T!fl',$3,$4,$5,'/library')`,
        [`b_${s.id}_${n}`, s.id, `T!fl/${s.id}/ch${n}.cbz`, n, `Chapter ${n}`],
      );
    }
  }
  // user A: partial has one of two done, done has both
  const done = (u: string, sid: string, n: number) =>
    q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,$2,$3,20,true)`,
      [u, `b_${sid}_${n}`, sid]);
  await done(uidA, 's_fl_partial', 1);
  await done(uidA, 's_fl_done', 1);
  await done(uidA, 's_fl_done', 2);
});

after(async () => {
  if (!DSN) return;
  await q(`DELETE FROM read_progress WHERE series_id = ANY($1)`, [ALL]).catch(() => {});
  await q(`DELETE FROM lib_books WHERE series_id = ANY($1)`, [ALL]).catch(() => {});
  await q(`DELETE FROM lib_series WHERE id = ANY($1)`, [ALL]).catch(() => {});
  await q(`DELETE FROM users WHERE username = ANY($1)`, [['fl_a', 'fl_b']]).catch(() => {});
});

test('status filter', { skip }, async () => {
  const r = await search({ status: { operator: 'is', value: 'COMPLETED' } });
  assert.deepEqual(ids(r).sort(), ['s_fl_done']);
});

test('author filter matches within a free-text field', { skip }, async () => {
  const r = await search({ author: { operator: 'is', value: 'Aoki' } });
  assert.deepEqual(ids(r).sort(), ['s_fl_done', 's_fl_unread']);
});

test('allOf of two genres is AND, anyOf is OR', { skip }, async () => {
  const and = await search({ allOf: [{ genre: { value: 'Action' } }, { genre: { value: 'Romance' } }] });
  assert.deepEqual(ids(and).sort(), ['s_fl_partial']);
  const or = await search({ anyOf: [{ genre: { value: 'Action' } }, { genre: { value: 'Romance' } }] });
  assert.deepEqual(ids(or).sort(), ['s_fl_done', 's_fl_partial', 's_fl_unread']);
});

test('THE BUG: readStatus used to return the whole library; UNREAD now means unread', { skip }, async () => {
  const r = await search({ readStatus: { operator: 'is', value: 'UNREAD' } }, { userId: uidA });
  assert.deepEqual(ids(r).sort(), ['s_fl_unread']);
});

test('IN_PROGRESS is started but not finished', { skip }, async () => {
  const r = await search({ readStatus: { operator: 'is', value: 'IN_PROGRESS' } }, { userId: uidA });
  assert.deepEqual(ids(r).sort(), ['s_fl_partial']);
});

test('READ is every chapter done', { skip }, async () => {
  const r = await search({ readStatus: { operator: 'is', value: 'READ' } }, { userId: uidA });
  assert.deepEqual(ids(r).sort(), ['s_fl_done']);
});

test('read state is per user: B has read nothing', { skip }, async () => {
  const r = await search({ readStatus: { operator: 'is', value: 'UNREAD' } }, { userId: uidB });
  assert.deepEqual(ids(r).sort(), ['s_fl_done', 's_fl_partial', 's_fl_unread']);
});

test('totalElements agrees with the rows actually returned', { skip }, async () => {
  // The assertion that catches filtering in the wrong layer. Post-filtering a page would leave
  // totalElements counting the unfiltered set.
  const r = await owned.searchSeries(
    { condition: { readStatus: { operator: 'is', value: 'UNREAD' } } }, 0, 100, undefined, { userId: uidA });
  assert.equal(r.totalElements, r.content.length, 'the count disagrees with the page');
});

test('an unknown predicate is refused, not silently widened', { skip }, async () => {
  await assert.rejects(
    () => search({ releaseDate: { operator: 'is', value: '2020' } }),
    (e: any) => e instanceof UnsupportedFilter && e.predicate === 'releaseDate',
  );
});

test('readStatus without a user is refused rather than answered wrongly', { skip }, async () => {
  await assert.rejects(
    () => search({ readStatus: { operator: 'is', value: 'UNREAD' } }),
    (e: any) => e instanceof UnsupportedFilter,
  );
});

test('the plain unfiltered query still works and needs no user', { skip }, async () => {
  const r = await owned.searchSeries({}, 0, 100);
  assert.ok(ids(r).length === 3, 'the ordinary library query regressed');
});

test('sorting by unread uses the real per-user count', { skip }, async () => {
  const r = await search(null, { userId: uidA }, 'unread,desc');
  const got = ids(r);
  assert.equal(got[0], 's_fl_unread', 'the series with the most unread should lead');
  assert.equal(got[got.length - 1], 's_fl_done', 'a finished series should be last');
});
