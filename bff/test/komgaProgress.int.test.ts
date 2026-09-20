// The Mihon-tracker progress semantics (lib/komgaProgress), against a real Postgres.
//
// Both halves live in SQL and both have failure modes nothing on our side would notice: a GET that reports
// the MAX completed chapter instead of the leading run makes the phone mark unread chapters read; a PUT that
// compares in float8 never marks chapter 12.1; a PUT that accepts 0 marks every "Extra.cbz" read on the first
// bind. Each case below is a seeded series shaped for exactly one rule.
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

// Written out rather than imported: src/lib pulls in env.ts, which validates the environment at module load,
// before the block above has set DATABASE_URL. Sees every library; still respects soft delete.
const SYSTEM_CTX = { userId: null, libraryIds: null, maxAgeRating: null, hideAdultLibraries: false } as const;

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let readProgressV2: typeof import('../src/lib/komgaProgress')['readProgressV2'];
let markReadUpTo: typeof import('../src/lib/komgaProgress')['markReadUpTo'];

const P = 'k2p'; // id prefix; every row this file seeds carries it
const S = (name: string) => `s_${P}_${name}`;
const B = (series: string, name: string) => `b_${P}_${series}_${name}`;
let uid: string;

/** [series, book, number, file, pages] -- one series per rule. */
const SERIES: Record<string, Array<[string, number, number?]>> = {
  // the leading-run rule: 1 and 2 read, 3 untouched, 4 read -> 2
  run: [['1', 1], ['2', 2], ['3', 3], ['4', 4]],
  // float4 boundaries
  flt: [['1', 1.1], ['2', 2.5], ['3', 3]],
  // a number-0 prologue ("Extra.cbz") ahead of 1..3
  zero: [['extra', 0], ['1', 1], ['2', 2], ['3', 3]],
  // a pruned tombstone carries the highest number
  prn: [['1', 1], ['5', 5]],
  // an override moves chapter "2" to 5
  ov: [['1', 1], ['2', 2], ['3', 3]],
  // page GREATEST and the in-progress count
  pg: [['1', 1, 20], ['2', 2, 20]],
  // no books at all (a follow-only add)
  empty: [],
  // soft-deleted
  hid: [['1', 1]],
};

const rp = (series: string, book: string) =>
  q<{ page: number; completed: boolean; updated_at: string }>(
    `SELECT page, completed, updated_at FROM read_progress WHERE user_id = $1 AND book_id = $2`, [uid, B(series, book)],
  ).then((r) => r[0] ?? null);

const complete = (series: string, book: string, page = 1, completed = true) =>
  q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, book_id) DO UPDATE SET page = $4, completed = $5`, [uid, B(series, book), S(series), page, completed]);

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ readProgressV2, markReadUpTo } = await import('../src/lib/komgaProgress'));
  await migrate();
  await q(`DELETE FROM users WHERE username = $1`, [`${P}-test`]);
  const u = await q<{ id: string }>(
    `INSERT INTO users (display_name, username, role, password_hash, auth_kind)
     VALUES ('K2','${P}-test','user','x','password') RETURNING id`,
  );
  uid = u[0].id;
});

beforeEach(async () => {
  if (!DSN) return;
  await q(`DELETE FROM read_progress WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM reading_events WHERE user_id = $1`, [uid]);
  await q(`DELETE FROM lib_series WHERE id LIKE $1`, [`s_${P}_%`]); // cascades lib_books, book_overrides
  for (const [name, books] of Object.entries(SERIES)) {
    await q(
      `INSERT INTO lib_series (id, source, title, folder, books_count, deleted_at)
       VALUES ($1,'T!k2',$2,$1,$3, CASE WHEN $4 THEN now() ELSE NULL END)`,
      [S(name), `K2 ${name}`, books.length, name === 'hid'],
    );
    for (const [bk, number, pages] of books) {
      await q(
        `INSERT INTO lib_books (id, series_id, source, file, number, title, root, pages, pruned_at)
         VALUES ($1,$2,'T!k2',$3,$4,$5,'/library',$6, CASE WHEN $7 THEN now() ELSE NULL END)`,
        [B(name, bk), S(name), `T!k2/${name}/${bk}.cbz`, number, `Chapter ${bk}`, pages ?? 10, name === 'prn' && bk === '5'],
      );
    }
  }
  await q(`INSERT INTO book_overrides (book_id, number) VALUES ($1, 5)`, [B('ov', '2')]);
});

after(async () => {
  if (!DSN) return;
  await q(`DELETE FROM read_progress WHERE user_id = $1`, [uid]).catch(() => {});
  await q(`DELETE FROM reading_events WHERE user_id = $1`, [uid]).catch(() => {});
  await q(`DELETE FROM lib_series WHERE id LIKE $1`, [`s_${P}_%`]).catch(() => {});
  await q(`DELETE FROM users WHERE username = $1`, [`${P}-test`]).catch(() => {});
});

// ---- GET ----------------------------------------------------------------------------------------------------

test('the leading-run rule: 1 and 2 read, 3 unread, 4 read reports 2, not 4', { skip }, async () => {
  // Reintroduce by computing `last` as the MAX completed number (what lib/trackers' seriesProgressFor does for
  // AniList): the phone then marks chapter 3 read because 3 <= 4.
  await complete('run', '1');
  await complete('run', '2');
  await complete('run', '4');
  const p = await readProgressV2(SYSTEM_CTX, uid, S('run'));
  assert.deepEqual(p, {
    booksCount: 4, booksReadCount: 3, booksUnreadCount: 1, booksInProgressCount: 0,
    lastReadContinuousNumberSort: 2, maxNumberSort: 4,
  });
});

test('a series with no books reports zeros, never nulls', { skip }, async () => {
  // Reintroduce by returning `MAX(number)` from SQL unguarded: an empty aggregate is null, a required Float.
  const p = await readProgressV2(SYSTEM_CTX, uid, S('empty'));
  assert.deepEqual(p, {
    booksCount: 0, booksReadCount: 0, booksUnreadCount: 0, booksInProgressCount: 0,
    lastReadContinuousNumberSort: 0, maxNumberSort: 0,
  });
});

test('a row that exists but is not completed is in progress, and it ends the leading run', { skip }, async () => {
  await complete('run', '1');
  await complete('run', '2', 4, false);
  await complete('run', '3');
  const p = await readProgressV2(SYSTEM_CTX, uid, S('run'));
  assert.deepEqual([p!.booksReadCount, p!.booksInProgressCount, p!.booksUnreadCount, p!.lastReadContinuousNumberSort], [2, 1, 1, 1]);
});

test('an unread number-0 prologue at the head reports 0, the protocol\'s own sentinel', { skip }, async () => {
  // Cannot be told apart from "nothing read" on the wire; Mihon then marks local number-0 chapters read
  // (`chapterNumber <= 0`), which is exactly what they are. Documented rather than worked around.
  await complete('zero', '1');
  await complete('zero', '2');
  const p = await readProgressV2(SYSTEM_CTX, uid, S('zero'));
  assert.equal(p!.lastReadContinuousNumberSort, 0);
  assert.equal(p!.booksReadCount, 2);
  await complete('zero', 'extra');
  assert.equal((await readProgressV2(SYSTEM_CTX, uid, S('zero')))!.lastReadContinuousNumberSort, 2, 'with the prologue read the run reaches 2');
});

test('pruned tombstones count: in booksCount and in maxNumberSort', { skip }, async () => {
  // Reintroduce by adding `AND b.pruned_at IS NULL` to the GET: the total shrinks to 1 and maxNumberSort to 1,
  // and a member whose history is on the pruned chapter loses it from the run.
  const p = await readProgressV2(SYSTEM_CTX, uid, S('prn'));
  assert.equal(p!.booksCount, 2);
  assert.equal(p!.maxNumberSort, 5);
  await complete('prn', '1');
  await complete('prn', '5');
  assert.equal((await readProgressV2(SYSTEM_CTX, uid, S('prn')))!.lastReadContinuousNumberSort, 5);
});

test('the number an admin overrode is the number reported (max and run)', { skip }, async () => {
  // Reintroduce by ordering/reading `b.number` instead of `COALESCE(ov.number, b.number)`: the tracker would
  // see 3 as the max while the chapter list shows 5.
  const p = await readProgressV2(SYSTEM_CTX, uid, S('ov'));
  assert.equal(p!.maxNumberSort, 5);
  await complete('ov', '1');
  await complete('ov', '3');
  assert.equal((await readProgressV2(SYSTEM_CTX, uid, S('ov')))!.lastReadContinuousNumberSort, 3, 'the run is 1, 3 -- the overridden 5 comes after');
});

test('a series the viewer may not see is null (the route\'s 404), not a zero report', { skip }, async () => {
  // Reintroduce by dropping the seriesVisible gate: a deleted series answers counts, confirming it exists.
  assert.equal(await readProgressV2(SYSTEM_CTX, uid, S('hid')), null);
  assert.equal(await readProgressV2(SYSTEM_CTX, uid, 's_k2p_nope'), null);
  const capped = { userId: uid, libraryIds: ['lib_somewhere_else'], maxAgeRating: null, hideAdultLibraries: false };
  assert.equal(await readProgressV2(capped, uid, S('run')), null, 'a library the viewer is not granted');
});

// ---- PUT ----------------------------------------------------------------------------------------------------

test('marks every chapter with number <= n completed, and reports how many it changed', { skip }, async () => {
  // Reintroduce by `<` instead of `<=`: chapter 3 stays unread after "read up to 3".
  const r = await markReadUpTo(uid, S('run'), 3);
  assert.equal(r.changed, 3);
  assert.deepEqual(
    await Promise.all(['1', '2', '3', '4'].map((b) => rp('run', b).then((x) => x?.completed ?? null))),
    [true, true, true, null],
  );
  assert.equal((await readProgressV2(SYSTEM_CTX, uid, S('run')))!.lastReadContinuousNumberSort, 3);
});

test('numbers 1.1 and 2.5 mark exactly, because the comparison is in float4', { skip }, async () => {
  // Reintroduce by `$3::float8` (or `::numeric`): 1.1f stored is 1.10000002384186 in float8, which is > 1.1,
  // so "read up to 1.1" marks nothing -- and the echo Mihon sends back, 1.100000023841858, marks 1.1 only by
  // luck of the promotion direction. Both forms must mark the same rows.
  assert.equal((await markReadUpTo(uid, S('flt'), 1.1)).changed, 1);
  assert.equal((await rp('flt', '1'))?.completed, true);
  assert.equal(await rp('flt', '2'), null);
  // What Mihon actually PUTs: the Float it parsed, widened to a Double.
  assert.equal((await markReadUpTo(uid, S('flt'), Math.fround(2.5))).changed, 1);
  assert.equal((await rp('flt', '2'))?.completed, true);
  assert.equal(await rp('flt', '3'), null);
  assert.equal((await markReadUpTo(uid, S('flt'), 1.100000023841858)).changed, 0, 'the float4 echo of 1.1 is 1.1');
});

test('already-completed rows are skipped: updated_at untouched, not counted as changed', { skip }, async () => {
  // Reintroduce by dropping `WHERE NOT read_progress.completed` from the conflict branch: every refresh bumps
  // updated_at on the whole series (Continue-reading reorders) and `changed` says N when nothing moved --
  // which is one AniList push per Mihon refresh.
  await complete('run', '1');
  await q(`UPDATE read_progress SET updated_at = '2020-01-01T00:00:00Z' WHERE user_id = $1 AND book_id = $2`, [uid, B('run', '1')]);
  const r = await markReadUpTo(uid, S('run'), 2);
  assert.equal(r.changed, 1, 'only chapter 2 is new');
  assert.equal(new Date((await rp('run', '1'))!.updated_at).toISOString(), '2020-01-01T00:00:00.000Z');
  assert.equal((await markReadUpTo(uid, S('run'), 2)).changed, 0, 'the same PUT again changes nothing');
});

test('n <= 0 writes nothing: the number-0 prologue survives the PUT Mihon sends on every bind', { skip }, async () => {
  // Reintroduce by removing the `n <= 0` guard: `number <= 0` marks "Extra.cbz" read for this user on the first
  // bind, with updated_at bumped.
  assert.equal((await markReadUpTo(uid, S('zero'), 0)).changed, 0);
  assert.equal((await markReadUpTo(uid, S('zero'), -1)).changed, 0);
  assert.equal((await markReadUpTo(uid, S('zero'), NaN)).changed, 0);
  assert.equal((await q(`SELECT 1 FROM read_progress WHERE user_id = $1 AND series_id = $2`, [uid, S('zero')])).length, 0);
  // Komga parity above zero: "read up to 1" does include the prologue, which sorts before 1.
  assert.equal((await markReadUpTo(uid, S('zero'), 1)).changed, 2);
});

test('page is GREATEST: a chapter someone is part-way through is completed without rewinding the page', { skip }, async () => {
  // Reintroduce by `page = EXCLUDED.page`: a reader on page 30 of a 20-page (mis-counted) chapter is sent back.
  await complete('pg', '1', 30, false);
  await complete('pg', '2', 3, false);
  const before = await readProgressV2(SYSTEM_CTX, uid, S('pg'));
  assert.equal(before!.booksInProgressCount, 2);
  assert.equal((await markReadUpTo(uid, S('pg'), 2)).changed, 2);
  assert.deepEqual(await rp('pg', '1').then((x) => [x!.page, x!.completed]), [30, true]);
  assert.deepEqual(await rp('pg', '2').then((x) => [x!.page, x!.completed]), [20, true], 'page becomes the chapter\'s page count');
});

test('the override-aware number is what n is compared against', { skip }, async () => {
  // Reintroduce by comparing `b.number` alone: "read up to 3" marks the chapter the admin renumbered to 5.
  assert.equal((await markReadUpTo(uid, S('ov'), 3)).changed, 2);
  assert.equal(await rp('ov', '2'), null, 'the overridden 5 is above 3');
  assert.equal((await markReadUpTo(uid, S('ov'), 5)).changed, 1);
});

test('a PUT reaches only the named series, and writes no reading_events', { skip }, async () => {
  // Reintroduce by dropping `b.series_id = $2`: every series in the library is marked. And by adding the
  // reading_events insert of writeProgress: a phone sync inflates streaks, the leaderboard and Wrapped.
  await markReadUpTo(uid, S('run'), 100);
  assert.equal((await q(`SELECT 1 FROM read_progress WHERE user_id = $1 AND series_id <> $2`, [uid, S('run')])).length, 0);
  assert.equal((await q(`SELECT 1 FROM reading_events WHERE user_id = $1`, [uid])).length, 0);
});

test('pruned tombstones are marked too: they are what this member\'s history refers to', { skip }, async () => {
  assert.equal((await markReadUpTo(uid, S('prn'), 5)).changed, 2);
  assert.equal((await rp('prn', '5'))?.completed, true);
});
