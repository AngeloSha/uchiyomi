// "Popular", for a library that belongs to one person.
//
// Mihon requires every source to answer a popular listing. For a personal shelf the honest meaning is: what
// you starred, then what you are furthest behind on. Both halves are PER USER, which is the thing to test:
// a sort that leaked one member's favourites into another member's listing would be a small privacy bug
// wearing a ranking's clothes.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const S = ['s_fs_alpha', 's_fs_bravo', 's_fs_charlie', 's_fs_delta'] as const;
let q: any, pool: any, owned: any, viewCtxFor: any;
let alice = '', bob = '';

before(async () => {
  if (!DSN) return;
  ({ q, pool } = await import('../src/lib/db'));
  await (await import('../src/lib/migrate')).migrate();
  ({ owned } = await import('../src/lib/ownedCatalog'));
  ({ viewCtxFor } = await import('../src/lib/visibility'));

  await q(`DELETE FROM read_progress WHERE series_id = ANY($1)`, [S]);
  await q(`DELETE FROM favorites WHERE series_id = ANY($1)`, [S]);
  await q(`DELETE FROM lib_books WHERE series_id = ANY($1)`, [S]);
  await q(`DELETE FROM lib_series WHERE id = ANY($1)`, [S]);
  await q(`DELETE FROM users WHERE username LIKE 'fs-%'`);

  // Four series with 10 chapters each, so unread counts are only ever moved by read_progress.
  for (const id of S) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!fs',$2,$1,10)`, [id, id.slice(2)]);
    for (let n = 1; n <= 10; n++) {
      await q(`INSERT INTO lib_books (id, series_id, source, file, number, title) VALUES ($1,$2,'T!fs',$3,$4,$5)`,
        [`b_${id}_${n}`, id, `T!fs/${id}/${n}.cbz`, n, `Chapter ${n}`]);
    }
  }
  const mk = async (name: string) => (await q(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','user','password') RETURNING id`, [name]))[0].id;
  alice = await mk('fs-alice'); bob = await mk('fs-bob');

  // Alice starred delta; Bob starred alpha. Alice has read 9 of charlie (1 unread) and 0 of the rest.
  await q(`INSERT INTO favorites (user_id, series_id) VALUES ($1,'s_fs_delta')`, [alice]);
  await q(`INSERT INTO favorites (user_id, series_id) VALUES ($1,'s_fs_alpha')`, [bob]);
  for (let n = 1; n <= 9; n++) {
    await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,$2,'s_fs_charlie',1,true)`, [alice, `b_s_fs_charlie_${n}`]);
  }
});
after(async () => {
  if (!DSN) return;
  await q(`DELETE FROM read_progress WHERE series_id = ANY($1)`, [S]);
  await q(`DELETE FROM favorites WHERE series_id = ANY($1)`, [S]);
  await q(`DELETE FROM lib_books WHERE series_id = ANY($1)`, [S]);
  await q(`DELETE FROM lib_series WHERE id = ANY($1)`, [S]);
  await q(`DELETE FROM users WHERE username LIKE 'fs-%'`);
  await pool.end();
});

const order = async (userId: string) => {
  const ctx = await viewCtxFor(userId, 'user');
  const res = await owned.searchSeries(ctx, { fullTextSearch: 'fs_' }, 0, 40, 'favorites,desc');
  return res.content.map((s: any) => s.id.slice(5));
};

test("Alice's popular: her favourite first, then most unread, then the rest by title", { skip }, async () => {
  // Reintroduce by dropping the `fav` join and its ORDER BY term: delta falls back into the unread order,
  // and charlie (1 unread) sorts last of the unread group -- the favourite is no longer first.
  assert.deepEqual(await order(alice), ['delta', 'alpha', 'bravo', 'charlie'],
    'delta is starred; alpha and bravo are 10 unread (tied, title order); charlie is 1 unread');
});

test("Bob's popular is Bob's: his favourite, not Alice's", { skip }, async () => {
  // ⚠️ The per-user property. Reintroduce by joining favorites WITHOUT the user_id predicate (or by reading
  // $1 for the wrong user): Bob's listing puts Alice's delta first.
  assert.deepEqual(await order(bob), ['alpha', 'bravo', 'charlie', 'delta'],
    'alpha is starred; the rest are 10 unread each for Bob, so title order');
});

test('the sort is only computed when asked for, and only with a user', { skip }, async () => {
  // Without a user there are no favourites and no progress; the query must not try to read $1.
  const anon = await viewCtxFor(null);
  const res = await owned.searchSeries(anon, { fullTextSearch: 'fs_' }, 0, 40, 'favorites,desc');
  assert.equal(res.content.length, 4, 'an anonymous listing still lists');
  assert.deepEqual(res.content.map((s: any) => s.id.slice(5)), ['alpha', 'bravo', 'charlie', 'delta'], 'plain title order');
});
