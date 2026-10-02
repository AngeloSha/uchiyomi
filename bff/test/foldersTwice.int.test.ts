// Health's "Folders scanned twice" (v0.52.0, discussion #134), through a real scan of real folders.
//
// @Kedryn mounted /epaper at /library while his downloads folder, /epaper/uchiyomi_manga, was /library-dl: the scan
// read every downloaded chapter twice, once in a series with its source and once, inside the library, in a series
// with none. Two mounts of one folder cannot be made without root, so this puts the downloads folder inside the
// library by path, which both the path check and the scan's walk see (scanWalk.test.ts holds the walk alone, with a
// filesystem that behaves like two mounts).
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
const ROOT = join(tmpdir(), `uchiyomi-twice-${process.pid}`);
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.LIBRARY_ROOT = join(ROOT, 'epaper');
  process.env.DL_ROOT = join(ROOT, 'epaper', 'uchiyomi_manga');
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

let q: any;

before(async () => {
  if (!DSN) return;
  rmSync(ROOT, { recursive: true, force: true });
  // A series of the reader's own in the library, and one Uchiyomi downloaded.
  for (const [dir, file] of [['epaper/comics/Own Tale', 'Chapter 1.cbz'], ['epaper/uchiyomi_manga/MangaDex/Twice Tale', 'Chapter 1.cbz']]) {
    mkdirSync(join(ROOT, dir), { recursive: true });
    writeFileSync(join(ROOT, dir, file), 'x');
  }
  ({ q } = (await import('../src/lib/db')) as any);
  await (await import('../src/lib/migrate')).migrate();
  await q(`DELETE FROM lib_series WHERE folder LIKE '%Twice Tale' OR folder LIKE '%Own Tale'`);
});

after(async () => {
  if (!DSN) return;
  await q(`DELETE FROM lib_series WHERE folder LIKE '%Twice Tale' OR folder LIKE '%Own Tale'`).catch(() => {});
  rmSync(ROOT, { recursive: true, force: true });
  await (await import('../src/lib/db')).pool.end().catch(() => {});
});

test('the downloads folder inside the library: Health says so, where, and how to mount them', { skip }, async () => {
  const { persistScan, lastScanReport } = await import('../src/lib/library');
  const { runHealthChecks } = await import('../src/lib/health');
  await persistScan();
  // The symptom: one downloaded series, twice.
  const twice = (await q(`SELECT folder FROM lib_series WHERE folder LIKE '%Twice Tale' ORDER BY folder`)).map((r: any) => r.folder);
  assert.deepEqual(twice, ['MangaDex/Twice Tale', 'uchiyomi_manga/MangaDex/Twice Tale']);
  // The scan's walk met the downloads folder's own folder inside the library.
  assert.deepEqual(lastScanReport()?.nested, { root: 'library', folder: 'uchiyomi_manga' });

  const report = await runHealthChecks();
  const card = report.checks.find((c) => c.id === 'folders-twice');
  // Reintroduce by leaving foldersScannedTwice out of runHealthChecks: there is no card.
  assert.ok(card, `no card for a downloads folder inside the library: ${report.checks.map((c) => c.id).join(', ')}`);
  assert.equal(card.status, 'warn');
  assert.deepEqual(card.summarySaid, [{ code: 'nested.downloadsInside', params: { folder: 'uchiyomi_manga' } }]);
  assert.match(card.summary, /^The downloads folder is inside the library, at uchiyomi_manga, so every downloaded chapter is scanned twice$/);
  assert.match(card.note!, /Mount them side by side, each in a folder of its own/);
  assert.deepEqual(card.noteSaid, [{ code: 'nested.note', params: { lib: process.env.LIBRARY_ROOT, dl: process.env.DL_ROOT } }]);
  assert.deepEqual(card.items.map((i) => [i.title, i.detailSaid?.[0]?.code]), [['Library / uchiyomi_manga', 'nested.byPath']]);
});
