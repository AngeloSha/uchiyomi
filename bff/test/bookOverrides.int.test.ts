// Correcting one chapter's number.
//
// numFromName() takes the first number in a filename, so "Vol 2 Ch 5.cbz" is chapter 2. That puts it between
// chapters 1 and 3 in the reader, and 2 is what gets reported to AniList. On the instance this was written
// against, 254 chapters carry a Vol prefix and are numbered by volume.
//
// The reason this is a manual, per-chapter override rather than a smarter filename parser: re-parsing would
// renumber all 254 at once, and every renumbered chapter that is already completed changes what a tracker is
// told. See trackerFloor.int.test.ts for the guard that makes that survivable.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
// A viewer that sees every library. Written out rather than imported because importing from
// src/lib pulls in env.ts, which validates the environment at module load, before the block below
// has set DATABASE_URL. Note this still respects soft delete: it only bypasses library scoping.
const SYSTEM_CTX = { userId: null, libraryIds: null, maxAgeRating: null } as const;

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let owned: any;
let seriesProgressFor: typeof import('../src/lib/trackers')['seriesProgressFor'];
let setBookDates: typeof import('../src/lib/library')['setBookDates'];

const S = 's_bo_series';
let uid: string;

// "Vol 2 Ch 5" is the real-world shape: numFromName gives 2, the truth is 5.
const BOOKS: Array<[string, string, number]> = [
  ['b_bo_1', 'T!bo/Bo/Chapter 1.cbz', 1],
  ['b_bo_2', 'T!bo/Bo/Vol 2 Ch 5.cbz', 2],
  ['b_bo_3', 'T!bo/Bo/Chapter 9.cbz', 9],
];

const override = (bookId: string, number: number | null, title: string | null = null) =>
  q(
    `INSERT INTO book_overrides (book_id, number, title, updated_at) VALUES ($1,$2,$3, now())
     ON CONFLICT (book_id) DO UPDATE SET number = $2, title = $3, updated_at = now()`,
    [bookId, number, title],
  );

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ owned } = (await import('../src/lib/ownedCatalog')) as any);
  ({ seriesProgressFor } = await import('../src/lib/trackers'));
  ({ setBookDates } = await import('../src/lib/library'));
  await migrate();

  await q(`DELETE FROM users WHERE username = 'bo-test'`);
  const u = await q<{ id: string }>(
    `INSERT INTO users (display_name, username, role, password_hash, auth_kind)
     VALUES ('Bo','bo-test','user','x','password') RETURNING id`,
  );
  uid = u[0].id;
});

beforeEach(async () => {
  if (!DSN) return;
  await q(`DELETE FROM read_progress WHERE user_id = $1`, [uid]).catch(() => {});
  await q(`DELETE FROM book_overrides WHERE book_id = ANY($1)`, [BOOKS.map((b) => b[0])]).catch(() => {});
  await q(`DELETE FROM lib_books WHERE series_id = $1`, [S]);
  await q(`DELETE FROM lib_series WHERE id = $1`, [S]);
  await q(
    `INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!bo','Bo Test',$1,3)`,
    [S],
  );
  for (const [id, file, number] of BOOKS) {
    await q(
      `INSERT INTO lib_books (id, series_id, source, file, number, title, root)
       VALUES ($1,$2,'T!bo',$3,$4,$5,'/library')`,
      [id, S, file, number, file.split('/').pop()!.replace(/\.cbz$/, '')],
    );
  }
});

after(async () => {
  if (!DSN) return;
  await q(`DELETE FROM read_progress WHERE user_id = $1`, [uid]).catch(() => {});
  await q(`DELETE FROM lib_books WHERE series_id = $1`, [S]).catch(() => {});
  await q(`DELETE FROM lib_series WHERE id = $1`, [S]).catch(() => {});
  await q(`DELETE FROM users WHERE username = 'bo-test'`).catch(() => {});
});

const numbers = async () =>
  (await owned.seriesBooks(SYSTEM_CTX, S, 0, 50)).content.map((b: any) => b.number);

test('without an override, the filename wins and the order is wrong', { skip }, async () => {
  // Pinning the bug this feature exists for: "Vol 2 Ch 5" reads as 2.
  assert.deepEqual(await numbers(), [1, 2, 9]);
});

test('THE FIX: an overridden number reorders the chapter list', { skip }, async () => {
  await override('b_bo_2', 5);
  assert.deepEqual(await numbers(), [1, 5, 9]);
});

test('an overridden title is what the reader shows', { skip }, async () => {
  await override('b_bo_2', 5, 'Chapter 5');
  const book = await owned.book(SYSTEM_CTX, 'b_bo_2');
  assert.equal(book.name, 'Chapter 5');
  assert.equal(book.metadata.title, 'Chapter 5');
  assert.equal(book.number, 5);
});

test('the override survives a rescan', { skip }, async () => {
  await override('b_bo_2', 5);
  // what persistScan does to an existing row
  await q(
    `UPDATE lib_books SET number = 2, title = 'Vol 2 Ch 5', updated_at = now() WHERE id = 'b_bo_2'`,
  );
  assert.deepEqual(await numbers(), [1, 5, 9], 'a rescan undid the correction');
});

test('the tracker is told the corrected number, not the filename one', { skip }, async () => {
  await override('b_bo_2', 5);
  await q(
    `INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,'b_bo_2',$2,20,true)`,
    [uid, S],
  );
  assert.equal((await seriesProgressFor(uid, S)).chapters, 5, 'the tracker would have been told 2');
});

test('next chapter follows the corrected order', { skip }, async () => {
  await override('b_bo_2', 5);
  const next = await owned.bookNext(SYSTEM_CTX, 'b_bo_1');
  assert.equal(next.id, 'b_bo_2');
  assert.equal((await owned.bookNext(SYSTEM_CTX, 'b_bo_2')).id, 'b_bo_3');
});

test('two chapters sharing a number do not make next return the same book', { skip }, async () => {
  // Renumbering makes duplicates far more likely, and `number > n` alone used to be ambiguous here.
  await override('b_bo_2', 1);
  const next = await owned.bookNext(SYSTEM_CTX, 'b_bo_1');
  assert.notEqual(next.id, 'b_bo_1', 'next chapter returned the book we are already on');
  assert.equal(next.id, 'b_bo_2', 'with equal numbers, file order should break the tie');
});

test('release-date matching still uses the raw parsed number', { skip }, async () => {
  // setBookDates matches numbers the SOURCE reported for its own chapters, which line up with what was
  // parsed from the filename. Honouring the override here would stop dates matching at all.
  await override('b_bo_2', 5);
  await setBookDates(S, [{ number: 2, publishedAt: '2026-01-02T00:00:00.000Z' }]);
  const row = await q<{ published_at: string | null }>(`SELECT published_at FROM lib_books WHERE id = 'b_bo_2'`);
  assert.ok(row[0].published_at, 'the release date did not match on the raw number');
});

test('clearing the override falls back to the filename', { skip }, async () => {
  await override('b_bo_2', 5);
  assert.deepEqual(await numbers(), [1, 5, 9]);
  await q(`DELETE FROM book_overrides WHERE book_id = 'b_bo_2'`);
  assert.deepEqual(await numbers(), [1, 2, 9]);
});
