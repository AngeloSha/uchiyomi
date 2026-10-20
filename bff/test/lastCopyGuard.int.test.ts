// The read-chapter cleanup never deletes the last copy (lib/chapterCleanup.ts dueSql): a finished chapter goes as it
// always did, except one the sources no longer list -- its series has a listing and the number is not in it -- because
// nothing could fetch that file again. Against a real database and a real filesystem.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
const DL = join(tmpdir(), `uchiyomi-lcg-${process.pid}`);
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.DL_ROOT = DL;
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let dueSql: (limit: number | null) => string;
let runCleanupOnce: () => Promise<any>;
const S = 's_lcg_series';
const FOLDER = 'T!lcg/Last Copy';
const USER = 'lcg-reader';
/** A realistic mtime, so the "read after it landed" clause is not vacuously true (chapterCleanup.int.test.ts). */
const LANDED_AT = Date.now() - 10 * 86_400_000;

const exists = (p: string) => stat(p).then(() => true).catch(() => false);
const fileOf = (n: number) => join(DL, FOLDER, `ch${n}.cbz`);

/** The numbers the cleanup would delete right now, at zero days of grace. */
const due = async () => (await q<{ number: number }>(
  `SELECT b.number::float8 AS number FROM lib_books b WHERE b.id IN (SELECT id FROM (${dueSql(null)}) d) ORDER BY b.number`, [DL, 0],
)).map((r) => Number(r.number));

/** Replace the series' listing with these numbers, as the sweep's replaceListing does. */
const listing = async (numbers: number[]) => {
  await q('DELETE FROM series_listing WHERE series_id = $1', [S]);
  for (const n of numbers) {
    await q(`INSERT INTO series_listing (series_id, number, source_id, chosen) VALUES ($1, $2, 'lcg-src', '{}'::jsonb)`, [S, n]);
  }
};

/** Book 4 as a file holding chapters 4 to `end` (lib/chapterRanges.ts), or one chapter again with null. */
const asRange = (end: number | null) => q('UPDATE lib_books SET number_end = $2 WHERE id = $1', ['b_lcg_4', end]);

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ dueSql, runCleanupOnce } = (await import('../src/lib/chapterCleanup')) as any);
  await migrate();
  await q('DELETE FROM lib_series WHERE id = $1', [S]);
  await q('DELETE FROM users WHERE username = $1', [USER]);
  const [u] = await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1, $1, 'x', 'user', 'password') RETURNING id`, [USER]);
  await mkdir(join(DL, FOLDER), { recursive: true });
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1, 'T!lcg', 'Last Copy', $2, 4)`, [S, FOLDER]);
  for (const n of [1, 2, 3, 4]) {
    await writeFile(fileOf(n), 'x'.repeat(100));
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root, mtime, pages)
             VALUES ($1, $2, 'T!lcg', $3, $4, $5, $6, $7, 10)`, [`b_lcg_${n}`, S, `${FOLDER}/ch${n}.cbz`, n, `Chapter ${n}`, DL, LANDED_AT]);
  }
  // Chapter 1 is the series' cover, which the cleanup never takes; 2, 3 and 4 were read to the end a day ago.
  await q('UPDATE lib_series SET cover_book_id = $2 WHERE id = $1', [S, 'b_lcg_1']);
  for (const n of [2, 3, 4]) {
    await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed, updated_at)
             VALUES ($1, $2, $3, 10, true, now() - interval '1 day')`, [u.id, `b_lcg_${n}`, S]);
  }
});

after(async () => {
  if (!DSN) return;
  await q('DELETE FROM series_listing WHERE series_id = $1', [S]).catch(() => {});
  await q('DELETE FROM read_progress WHERE series_id = $1', [S]).catch(() => {});
  await q('UPDATE lib_series SET cover_book_id = NULL WHERE id = $1', [S]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = $1', [S]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [S]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  await q('UPDATE server_settings SET cleanup_read = false, cleanup_read_days = 30, cleanup_read_last_run = NULL, cleanup_read_last_result = NULL WHERE id = 1').catch(() => {});
  await rm(DL, { recursive: true, force: true }).catch(() => {});
});

test('a series with no listing at all is judged as before: every finished chapter is due', { skip }, async () => {
  await listing([]);
  assert.deepEqual(await due(), [2, 3, 4]);
});

test('every finished chapter still listed is due, as before', { skip }, async () => {
  await listing([1, 2, 3, 4]);
  assert.deepEqual(await due(), [2, 3, 4]);
});

test('a chapter the sources no longer list is not due: the file is the last copy', { skip }, async () => {
  await listing([1, 3, 4]);
  assert.deepEqual(await due(), [3, 4]);
});

test('a range file is kept when any chapter it holds is no longer listed, not only its start', { skip }, async () => {
  await asRange(6);
  try {
    await listing([1, 2, 3, 4, 5, 6]);
    assert.deepEqual(await due(), [2, 3, 4], 'all of 4 to 6 listed: cleaned up as before');
    await listing([1, 2, 3, 4, 6]);
    assert.deepEqual(await due(), [2, 3], 'chapter 5 is unlisted: the file holding 4 to 6 is its last copy');
    await listing([1, 2, 3, 4, 5]);
    assert.deepEqual(await due(), [2, 3], 'the end of the range, 6, is unlisted: kept too');
  } finally {
    await asRange(null);
  }
});

test("an admin's number is the one the listing is checked against, and it cancels the range", { skip }, async () => {
  await q(`INSERT INTO book_overrides (book_id, number) VALUES ('b_lcg_4', 8)`);
  await asRange(6);
  try {
    await listing([1, 2, 3, 8]);
    assert.deepEqual(await due(), [2, 3, 4], 'the book is chapter 8, which is listed; 5 and 6 are not its chapters');
    await listing([1, 2, 3, 4]);
    assert.deepEqual(await due(), [2, 3], 'chapter 8 is unlisted: kept, though the file\'s own 4 is listed');
  } finally {
    await q(`DELETE FROM book_overrides WHERE book_id = 'b_lcg_4'`);
    await asRange(null);
  }
});

test('a chapter the sources no longer list is never deleted', { skip }, async () => {
  await listing([1, 3, 4]);
  await q('UPDATE server_settings SET cleanup_read = true, cleanup_read_days = 0 WHERE id = 1');
  try {
    const r = await runCleanupOnce();
    assert.equal(r.deleted, 2, 'chapters 3 and 4, which a source still lists, go as before');
    assert.equal(await exists(fileOf(3)), false);
    assert.equal(await exists(fileOf(4)), false);
    assert.equal(await exists(fileOf(2)), true, 'chapter 2 is listed nowhere: its file is the last copy');
    const [b2] = await q<{ pruned_at: Date | null }>(`SELECT pruned_at FROM lib_books WHERE id = 'b_lcg_2'`);
    assert.equal(b2.pruned_at, null, 'and its row is not marked deleted');
    assert.equal(r.remaining, 0, 'nor is it counted as still due');
  } finally {
    await q('UPDATE server_settings SET cleanup_read = false WHERE id = 1');
  }
});
