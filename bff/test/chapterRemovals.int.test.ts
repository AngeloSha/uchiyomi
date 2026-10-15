// Remove from series, against a real database and a scratch download folder: the number's file goes, the number is
// recorded and stops being listed, a chapter of the read library is refused (and not recorded), and Restore lets the
// number back. Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '', DL = '', LIB_ROOT = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-rm-'));
  DL = join(ROOT, 'dl');
  LIB_ROOT = join(ROOT, 'lib');
  process.env.DL_ROOT = DL;
  process.env.LIBRARY_ROOT = LIB_ROOT;
  process.env.CACHE_DIR = join(ROOT, 'cache');
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.MIN_FREE_GB = '0';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_rm', S = 's_rm_series', FOLDER = 'T!rm/Rm Series';
let q: any, removeChapters: any, restoreRemoved: any, removedNumbers: any;

const file = (root: string, n: number) => join(root, FOLDER, `Chapter ${n}.cbz`);

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ removeChapters, restoreRemoved, removedNumbers } = (await import('../src/lib/chapterRemovals')) as any);
  await migrate();
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Rm',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q('DELETE FROM lib_series WHERE id = $1', [S]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id) VALUES ($1,'T!rm','Rm Series',$2,3,$3)`, [S, FOLDER, LIB]);
  mkdirSync(join(DL, FOLDER), { recursive: true });
  mkdirSync(join(LIB_ROOT, FOLDER), { recursive: true });
  for (const [id, n, root] of [['b_rm_1', 1, DL], ['b_rm_half', 1.5, DL], ['b_rm_lib', 2, LIB_ROOT]] as const) {
    writeFileSync(file(root, n), 'x');
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, root) VALUES ($1,$2,'T!rm',$3,$4,$5,1,$6)`,
      [id, S, `${FOLDER}/Chapter ${n}.cbz`, n, `Chapter ${n}`, root]);
  }
});

after(async () => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  if (!DSN) return;
  await q('DELETE FROM lib_series WHERE id = $1', [S]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
});

test('a removed number loses its file, is recorded, and a restore lets it back', { skip }, async () => {
  const r = await removeChapters(S, [1.5], { userId: null });
  assert.deepEqual(r.removed, [1.5]);
  assert.equal(r.applied, 1);
  assert.equal(existsSync(file(DL, 1.5)), false, 'the file is deleted');
  assert.equal(existsSync(file(DL, 1)), true, 'another number is untouched');
  assert.deepEqual(await removedNumbers(S), [1.5]);
  // The row stays as a tombstone (reading history), pruned.
  const [row] = await q('SELECT pruned_at FROM lib_books WHERE id = $1', ['b_rm_half']);
  assert.ok(row.pruned_at);
  assert.deepEqual(await restoreRemoved(S, [1.5], { userId: null }), [1.5]);
  assert.deepEqual(await removedNumbers(S), []);
});

test('a chapter of the read library is refused and not recorded', { skip }, async () => {
  const r = await removeChapters(S, [2], { userId: null });
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.skipped, [{ number: 2, reason: 'not_owned' }]);
  assert.equal(existsSync(file(LIB_ROOT, 2)), true);
  assert.deepEqual(await removedNumbers(S), []);
});

test('the catalog and the listing leave a removed number out, Restore all brings it back', { skip }, async () => {
  await q(`INSERT INTO series_listing (series_id, number, source_id, chosen, status) VALUES ($1, 7, 'rm-src', '{}'::jsonb, 'available') ON CONFLICT DO NOTHING`, [S]);
  const r = await removeChapters(S, [7], { userId: null });
  assert.deepEqual(r.removed, [7]);
  assert.equal((await q('SELECT 1 FROM series_listing WHERE series_id = $1 AND number = 7', [S])).length, 0, 'its listing row is dropped');
  assert.deepEqual(await removedNumbers(S), [7]);
  assert.deepEqual(await restoreRemoved(S, 'all', { userId: null }), [7]);
});
