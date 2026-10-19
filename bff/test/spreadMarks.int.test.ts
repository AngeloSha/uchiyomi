// A reader's own merges and splits of a chapter's pages (v0.89.0, #262 by @Squeaks72, rebuilt; lib/spreadMarks.ts):
// saved per account and never shared, applied only to the file they were made on, carried by the page list and the
// download manifest, and refused for a chapter the account cannot open.
//
// Driven through the real routes. The chapters carry `page_dims`, so their page lists never touch a disk.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
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

const OPEN = 's_sm_open', HIDDEN = 's_sm_hidden';
const BOOK = 'b_sm_open', HIDDEN_BOOK = 'b_sm_hidden';
const A = 'sm-reader-a', B = 'sm-reader-b';
const dims = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ name: `${String(i + 1).padStart(3, '0')}.png`, width: 800, height: 1200 })));
let q: any, app: any;
const H: Record<string, { authorization: string }> = {};

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await migrate();
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [[OPEN, HIDDEN]]);
  await q('DELETE FROM users WHERE username = ANY($1)', [[A, B]]);
  for (const [s, b] of [[OPEN, BOOK], [HIDDEN, HIDDEN_BOOK]]) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!sm',$1,$2,1)`, [s, `T!sm/${s}`]);
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, page_dims) VALUES ($1,$2,'T!sm',$3,1,'Chapter 1',6,$4)`,
      [b, s, `T!sm/${s}/ch1.cbz`, dims(6)]);
  }
  await q('UPDATE lib_series SET deleted_at = now() WHERE id = $1', [HIDDEN]);
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/catalog')).default);
  await app.register((await import('../src/routes/downloads')).default);
  await app.ready();
  for (const name of [A, B]) {
    const id = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','user','password') RETURNING id`, [name]))[0].id;
    H[name] = { authorization: `Bearer ${app.jwt.sign({ sub: id, role: 'user' })}` };
  }
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [[OPEN, HIDDEN]]).catch(() => {});
  await q('DELETE FROM users WHERE username = ANY($1)', [[A, B]]).catch(() => {});
});

const put = (who: string, page: number | string, mark: unknown, book = BOOK) =>
  app.inject({ method: 'PUT', url: `/api/books/${book}/pages/${page}/spread`, headers: H[who], payload: { mark } });
/** The page list's marks, as the reader reads them: `{ page: mark }`. */
const listed = async (who: string, book = BOOK) => Object.fromEntries(
  (await app.inject({ method: 'GET', url: `/api/books/${book}/pages`, headers: H[who] })).json()
    .filter((p: any) => p.mark).map((p: any) => [p.number, p.mark]));

test('a mark is the account\'s own: saved, answered, listed on the page list, and nobody else\'s', { skip }, async () => {
  assert.deepEqual(await listed(A), {}, 'PREMISE: nothing marked');
  const r = await put(A, 2, 'split');
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().marks, { 2: 'split' });
  assert.deepEqual((await put(A, 4, 'join')).json().marks, { 2: 'split', 4: 'join' });
  assert.deepEqual(await listed(A), { 2: 'split', 4: 'join' }, 'the page list carries them');
  // Reintroduce by keying the rows on the chapter alone: B's reader shows A's merge.
  assert.deepEqual(await listed(B), {}, 'another account\'s reader is not changed');
  // The detector's answer is not touched: the marks live beside it.
  assert.equal((await q('SELECT spreads FROM lib_books WHERE id = $1', [BOOK]))[0].spreads, null);
});

test('a page is in one spread only, and a mark given back leaves the detector\'s answer', { skip }, async () => {
  await put(A, 2, null); await put(A, 4, null);
  await put(A, 2, 'join');
  // Joining 3-4 takes the account's join off 2-3 (they share page 3); a neighbour's split would stay.
  assert.deepEqual((await put(A, 3, 'join')).json().marks, { 3: 'join' });
  await put(A, 5, 'split');
  assert.deepEqual((await put(A, 4, 'split')).json().marks, { 3: 'join', 4: 'split', 5: 'split' }, 'splits do not share pages');
  assert.deepEqual((await put(A, 3, null)).json().marks, { 4: 'split', 5: 'split' }, 'given back to the detector');
});

test('only a pair can be marked, only with join, split or nothing, and only in a chapter the account may open', { skip }, async () => {
  for (const [page, mark, code] of [[6, 'join', 400], [0, 'join', 400], [7, 'split', 400], ['x', 'join', 400], [2, 'yes', 400], [2, undefined, 400]] as const) {
    assert.equal((await put(A, page, mark)).statusCode, code, `page ${page}, mark ${String(mark)}`);
  }
  // Reintroduce by writing from :id unchecked (dropping the page list's resolve): a mark lands in a hidden series.
  assert.equal((await put(A, 2, 'join', HIDDEN_BOOK)).statusCode, 404, 'a chapter the account may not open');
  assert.equal((await q('SELECT count(*)::int AS n FROM spread_marks WHERE book_id = $1', [HIDDEN_BOOK]))[0].n, 0);
  assert.equal((await put(A, 2, 'join', 'b_sm_nothing')).statusCode, 404);
});

test('a mark made on another file of the chapter is not applied; the download carries the account\'s marks', { skip }, async () => {
  for (const p of [1, 2, 3, 4, 5]) await put(B, p, null);
  await put(B, 1, 'join');
  const manifest = (await app.inject({ method: 'GET', url: `/api/books/${BOOK}/download-manifest`, headers: H[B] })).json();
  assert.deepEqual(manifest.pages.filter((p: any) => p.mark).map((p: any) => [p.number, p.mark]), [[1, 'join']], 'the download keeps them');
  // The file is replaced by one with a page more: page 1 is no longer what was merged. Reintroduce by dropping the
  // `pages = $3` match in marksFor: the old merge joins the new file's first two pages.
  await q('UPDATE lib_books SET pages = 7, page_dims = $2 WHERE id = $1', [BOOK, dims(7)]);
  assert.deepEqual(await listed(B), {}, 'not applied to another file');
  assert.deepEqual((await put(B, 3, 'split')).json().marks, { 3: 'split' }, 'and gone once the account marks the new one');
  assert.equal((await q(`SELECT count(*)::int AS n FROM spread_marks s JOIN users u ON u.id = s.user_id
                          WHERE s.book_id = $1 AND s.pages = 6 AND u.username = $2`, [BOOK, B]))[0].n, 0, 'the old file\'s marks are dropped');
  await q('UPDATE lib_books SET pages = 6, page_dims = $2 WHERE id = $1', [BOOK, dims(6)]);
});

test('the marks go with their chapter and with their account', { skip }, async () => {
  await put(A, 2, 'join');
  await q('DELETE FROM users WHERE username = $1', [A]);
  assert.equal((await q(`SELECT count(*)::int AS n FROM spread_marks s JOIN users u ON u.id = s.user_id WHERE u.username = $1`, [A]))[0].n, 0);
  await put(B, 2, 'join');
  await q('DELETE FROM lib_books WHERE id = $1', [BOOK]);
  assert.equal((await q('SELECT count(*)::int AS n FROM spread_marks WHERE book_id = $1', [BOOK]))[0].n, 0);
});

test('a mark from a copy of another file of the chapter is refused, and two joins sent at once leave one', { skip }, async () => {
  const B2 = 'b_sm_two';
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, page_dims) VALUES ($1,$2,'T!sm',$3,2,'Chapter 2',8,$4)`,
    [B2, OPEN, `T!sm/${OPEN}/ch2.cbz`, dims(8)]);
  try {
    // A downloaded copy of 7 pages, the file now 8: its page numbers are not this file's. Reintroduce by ignoring `pages`.
    const stale = await app.inject({ method: 'PUT', url: `/api/books/${B2}/pages/3/spread`, headers: H[B], payload: { mark: 'join', pages: 7 } });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json().error, 'pages_changed');
    assert.equal((await q('SELECT count(*)::int AS n FROM spread_marks WHERE book_id = $1', [B2]))[0].n, 0, 'nothing written');
    assert.equal((await app.inject({ method: 'PUT', url: `/api/books/${B2}/pages/3/spread`, headers: H[B], payload: { mark: 'join', pages: 8 } })).statusCode, 200);
    await put(B, 3, null, B2);
    // Two neighbouring joins at once, many times: a page is never left in two. Reintroduce by dropping setMark's lock.
    const uid = (await q('SELECT id FROM users WHERE username = $1', [B]))[0].id;
    const { setMark } = await import('../src/lib/spreadMarks');
    for (let i = 0; i < 25; i++) {
      await q('DELETE FROM spread_marks WHERE book_id = $1', [B2]);
      await Promise.all([setMark(uid, B2, 4, 'join', 8), setMark(uid, B2, 5, 'join', 8)]);
      const joins = (await q(`SELECT page FROM spread_marks WHERE book_id = $1 AND mark = 'join' ORDER BY page`, [B2])).map((r: any) => Number(r.page));
      assert.equal(joins.length, 1, `round ${i}: joins on ${joins.join(' and ')}`);
    }
  } finally {
    await q('DELETE FROM lib_books WHERE id = $1', [B2]);
  }
});

