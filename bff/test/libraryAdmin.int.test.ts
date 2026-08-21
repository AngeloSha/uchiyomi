// Hiding and merging series, at the level where the data actually moves.
//
// The interesting cases are collisions. Favourites, ratings, series_seen and collection membership are all
// keyed on (something, series_id), so a user who had BOTH copies of a series would violate a primary key on
// a naive UPDATE. And the reason merge does not de-duplicate chapters is that deleting a chapter row forces
// two read_progress rows to be folded into one, which is how you silently mark something unread and then
// push that to someone's AniList account.
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
let admin: typeof import('../src/lib/libraryAdmin');

const A = 's_la_keep', B = 's_la_absorb';
const users: string[] = [];

async function seed() {
  for (const [id, title] of [[A, 'Keeper'], [B, 'Absorbed']] as const) {
    await q(
      `INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!la',$2,$1,0)
       ON CONFLICT (id) DO UPDATE SET deleted_at = NULL, merged_into = NULL, title = EXCLUDED.title`,
      [id, title],
    );
  }
  for (const [sid, n] of [[A, 1], [A, 2], [B, 3], [B, 4]] as const) {
    await q(
      `INSERT INTO lib_books (id, series_id, source, file, number, title, mtime, root)
       VALUES ($1,$2,'T!la',$3,$4,$1,$5,'/library')
       ON CONFLICT (id) DO UPDATE SET series_id = EXCLUDED.series_id`,
      [`b_la_${n}`, sid, `T!la/${sid}/ch${n}.cbz`, n, 1000 * n],
    );
  }
}

async function wipe() {
  for (const t of ['read_progress', 'reading_events', 'favorites', 'ratings', 'series_seen', 'collection_items', 'notes', 'offline_downloads', 'series_trackers']) {
    await q(`DELETE FROM ${t} WHERE series_id = ANY($1)`, [[A, B]]).catch(() => {});
  }
  await q(`DELETE FROM lib_books WHERE series_id = ANY($1)`, [[A, B]]);
  await q(`DELETE FROM lib_series WHERE id = ANY($1)`, [[A, B]]);
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  admin = await import('../src/lib/libraryAdmin');
  await migrate();
  for (const name of ['la_one', 'la_two']) {
    // uq_users_username is a PARTIAL unique index (WHERE username IS NOT NULL), so a bare ON CONFLICT
    // (username) does not match it. Simpler to make the fixture from scratch each run.
    await q(`DELETE FROM users WHERE username = $1`, [name]);
    const r = await q<{ id: string }>(
      `INSERT INTO users (display_name, username, role, password_hash, auth_kind)
       VALUES ($1,$1,'user','x','password') RETURNING id`,
      [name],
    );
    users.push(r[0].id);
  }
});

beforeEach(async () => { if (DSN) { await wipe(); await seed(); } });

after(async () => {
  if (!DSN) return;
  await wipe().catch(() => {});
  await q(`DELETE FROM users WHERE username = ANY($1)`, [['la_one', 'la_two']]).catch(() => {});
});

const booksOf = (id: string) => q(`SELECT id FROM lib_books WHERE series_id = $1 ORDER BY id`, [id]);
const seriesRow = (id: string) => q(`SELECT * FROM lib_series WHERE id = $1`, [id]).then((r) => r[0]);

test('delete: hides the series, keeps the chapters and the reading history', { skip }, async () => {
  await q(
    `INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,'b_la_1',$2,9,false)`,
    [users[0], A],
  );
  await q(
    `INSERT INTO reading_events (user_id, series_id, book_id, page, completed) VALUES ($1,$2,'b_la_1',9,true)`,
    [users[0], A],
  );
  await q(`INSERT INTO series_trackers (series_id, provider, external_id) VALUES ($1,'anilist','123')`, [A]);

  const r = await admin.deleteSeries(A);
  assert.equal(r.books, 2, 'wrong chapter count reported');

  const row = await seriesRow(A);
  assert.ok(row.deleted_at, 'the series was not hidden');
  assert.equal((await booksOf(A)).length, 2, 'hiding a series destroyed its chapters');
  assert.equal((await q(`SELECT 1 FROM read_progress WHERE series_id = $1`, [A])).length, 1, 'reading progress was destroyed');
  assert.equal((await q(`SELECT 1 FROM reading_events WHERE series_id = $1`, [A])).length, 1, 'reading history was destroyed');
  assert.equal(
    (await q(`SELECT 1 FROM series_trackers WHERE series_id = $1`, [A])).length,
    0,
    'the tracker link survived, so the duplicate health check will report it forever',
  );
});

test('delete: restoring puts it straight back', { skip }, async () => {
  await admin.deleteSeries(A);
  await admin.restoreSeries(A);
  assert.equal((await seriesRow(A)).deleted_at, null);
});

test('merge: chapters move and the absorbed series points at its survivor', { skip }, async () => {
  const r = await admin.mergeSeries(B, A);
  assert.equal(r.moved, 2, 'the absorbed chapters did not move');
  assert.equal((await booksOf(A)).length, 4);
  assert.equal((await booksOf(B)).length, 0);
  assert.equal((await seriesRow(B)).merged_into, A);
  assert.equal((await seriesRow(A)).books_count, 4, 'the survivor kept a stale chapter count');
  assert.ok((await seriesRow(A)).cover_book_id, 'the survivor lost its cover');
});

test('merge: a user who favourited BOTH ends up with one favourite, not a crash', { skip }, async () => {
  for (const s of [A, B]) {
    await q(`INSERT INTO favorites (user_id, series_id) VALUES ($1,$2)`, [users[0], s]);
  }
  // and a second user who only had the absorbed one
  await q(`INSERT INTO favorites (user_id, series_id) VALUES ($1,$2)`, [users[1], B]);

  await admin.mergeSeries(B, A);

  const favs = await q(`SELECT user_id FROM favorites WHERE series_id = $1 ORDER BY user_id`, [A]);
  assert.equal(favs.length, 2, 'the two users did not both end up favouriting the survivor');
  assert.equal((await q(`SELECT 1 FROM favorites WHERE series_id = $1`, [B])).length, 0, 'stale favourites left behind');
});

test('merge: colliding ratings keep the survivor\'s, and the other user\'s carries over', { skip }, async () => {
  await q(`INSERT INTO ratings (user_id, series_id, stars) VALUES ($1,$2,5)`, [users[0], A]);
  await q(`INSERT INTO ratings (user_id, series_id, stars) VALUES ($1,$2,2)`, [users[0], B]);
  await q(`INSERT INTO ratings (user_id, series_id, stars) VALUES ($1,$2,3)`, [users[1], B]);

  await admin.mergeSeries(B, A);

  const rows = await q<{ user_id: string; stars: number }>(
    `SELECT user_id, stars FROM ratings WHERE series_id = $1`, [A],
  );
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.user_id === users[0])!.stars, 5, "the survivor's own rating was overwritten");
  assert.equal(rows.find((r) => r.user_id === users[1])!.stars, 3, 'the other rating did not carry over');
});

test('merge: every reading-progress row survives and follows its chapter', { skip }, async () => {
  await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,'b_la_1',$2,3,false)`, [users[0], A]);
  await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,'b_la_3',$2,7,true)`, [users[0], B]);
  await q(`INSERT INTO reading_events (user_id, series_id, book_id, page, completed) VALUES ($1,$2,'b_la_3',7,true)`, [users[0], B]);

  await admin.mergeSeries(B, A);

  const prog = await q<{ book_id: string; page: number; completed: boolean }>(
    `SELECT book_id, page, completed FROM read_progress WHERE series_id = $1 ORDER BY book_id`, [A],
  );
  assert.equal(prog.length, 2, 'a progress row was lost in the merge');
  assert.equal(prog.find((p) => p.book_id === 'b_la_3')!.page, 7, 'progress on the absorbed chapter changed');
  assert.equal(prog.find((p) => p.book_id === 'b_la_3')!.completed, true, 'a completed chapter was marked unread');
  assert.equal((await q(`SELECT 1 FROM reading_events WHERE series_id = $1`, [A])).length, 1, 'reading history was lost');
  assert.equal((await q(`SELECT 1 FROM read_progress WHERE series_id = $1`, [B])).length, 0);
});

test('merge: collection membership de-duplicates instead of failing', { skip }, async () => {
  const c = await q<{ id: string }>(
    `INSERT INTO collections (user_id, name) VALUES ($1,'la-test') RETURNING id`, [users[0]],
  );
  for (const s of [A, B]) {
    await q(`INSERT INTO collection_items (collection_id, series_id, position) VALUES ($1,$2,0)`, [c[0].id, s]);
  }

  await admin.mergeSeries(B, A);

  const items = await q(`SELECT series_id FROM collection_items WHERE collection_id = $1`, [c[0].id]);
  assert.equal(items.length, 1, 'the collection ended up with the series twice, or lost it');
  assert.equal(items[0].series_id, A);
  await q(`DELETE FROM collections WHERE id = $1`, [c[0].id]);
});

test('merge: duplicate chapter numbers are kept, not silently dropped', { skip }, async () => {
  // Both series have a chapter the other also has. Merge keeps both rows: de-duplicating would mean
  // deleting one and folding two progress rows together, which is where irreversible loss lives.
  await q(
    `INSERT INTO lib_books (id, series_id, source, file, number, title, mtime, root)
     VALUES ('b_la_dup',$1,'T!la','T!la/dup/ch1.cbz',1,'dup',5,'/library')`,
    [B],
  );

  await admin.mergeSeries(B, A);

  const ones = await q(`SELECT id FROM lib_books WHERE series_id = $1 AND number = 1`, [A]);
  assert.equal(ones.length, 2, 'a duplicate chapter was dropped during the merge');
});
