// Health's "Disk space and folders" against a real Postgres (lib/healthDisk.ts, v0.72.0, from #253): a folder that is
// empty while the library records chapters in it, a folder that is not there, and the slow archive's floor, which only
// matters while the archive has a series queued. The disk itself is a stand-in, so the levels do not depend on the
// machine the tests run on.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
const GB = 2 ** 30;

/** A disk with `freeGb` free; `empty` folders hold nothing, `missing` ones cannot be opened. */
const disk = (o: { freeGb?: number; empty?: string[]; missing?: string[] } = {}) => ({
  statfs: async () => ({ bavail: ((o.freeGb ?? 400) * GB) / 4096, bsize: 4096, blocks: (1000 * GB) / 4096 }),
  opendir: async (p: string) => {
    if (o.missing?.includes(p)) throw Object.assign(new Error(`ENOENT: no such file or directory, opendir '${p}'`), { code: 'ENOENT' });
    return { read: async () => (o.empty?.includes(p) ? null : { name: 'Some Series' }), close: async () => {} };
  },
});

after(async () => {
  if (!DSN) return;
  const { q } = await import('../src/lib/db');
  await q(`DELETE FROM lib_series WHERE id LIKE 'hd\\_%'`).catch(() => {});
  await q('UPDATE server_settings SET archive_min_free_gb = 20, archive_paused = false WHERE id = 1').catch(() => {});
});

test('a folder empty while the library records chapters in it is a problem; one it records nothing in is not', { skip }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  await migrate();
  const { q } = await import('../src/lib/db');
  const { LIBRARY_ROOT, DL_ROOT } = await import('../src/lib/library');
  const { diskAndFolders } = await import('../src/lib/healthDisk');
  const { englishOf } = await import('../src/lib/said');
  await q(`INSERT INTO lib_series (id, source, title, folder) VALUES ('hd_lib', 'test', 'HD Library', 'HD Library')`);
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, root)
           VALUES ('hd_b1', 'hd_lib', 'test', 'HD Library/1.cbz', 1, 'One', 10, $1),
                  ('hd_b2', 'hd_lib', 'test', 'HD Library/2.cbz', 2, 'Two', 10, $1),
                  ('hd_b3', 'hd_lib', 'test', 'HD Library/3.cbz', 3, 'Three', 10, $1)`, [LIBRARY_ROOT]);
  await q(`UPDATE lib_books SET pruned_at = now() WHERE id = 'hd_b3'`);

  // A share that is not mounted: an empty mount point, and the library still records its chapters.
  const card = await diskAndFolders(undefined, disk({ empty: [LIBRARY_ROOT, DL_ROOT] }));
  assert.equal(card.status, 'problem');
  const lib = card.items.find((i) => i.key === 'folder:library');
  assert.deepEqual(lib?.detailSaid, [{ code: 'disk.empty', params: { n: 2 } }], 'two live chapters recorded under it (a tombstone is not one)');
  assert.equal(lib?.title, 'Library / (the folder itself)');
  assert.equal(englishOf(card.summarySaid), card.summary);
  assert.equal(card.summary, '1 disk or folder needs a look');
  // Nothing recorded under the empty download folder: a fresh install, not a finding.
  assert.ok(!card.items.some((i) => i.key === 'folder:downloads'));

  // Not there at all, with chapters recorded under it.
  const gone = await diskAndFolders(undefined, disk({ missing: [LIBRARY_ROOT] }));
  assert.deepEqual(gone.items.find((i) => i.key === 'folder:library')?.detailSaid, [{ code: 'missing.folderUnreadable', params: { error: 'ENOENT' } }]);
  // ... and with nothing recorded under it: an install without that folder.
  const none = await diskAndFolders(undefined, disk({ missing: [DL_ROOT] }));
  assert.ok(!none.items.some((i) => i.key === 'folder:downloads'));
  assert.equal(none.status, 'ok');
});

test('amber under the slow archive\'s floor while it has a series queued, and only then', { skip }, async () => {
  const { q } = await import('../src/lib/db');
  const { diskAndFolders } = await import('../src/lib/healthDisk');
  await q('UPDATE server_settings SET archive_min_free_gb = 50, archive_paused = false WHERE id = 1');
  const nothingQueued = await diskAndFolders(undefined, disk({ freeGb: 30 }));
  assert.equal(nothingQueued.status, 'ok', 'under the floor, but the archive has nothing to fetch');

  await q(`INSERT INTO lib_series (id, source, title, folder) VALUES ('hd_arc', 'test', 'HD Archive', 'HD Archive')`);
  await q(`INSERT INTO archive_queue (series_id, state) VALUES ('hd_arc', 'queued')`);
  const waiting = await diskAndFolders(undefined, disk({ freeGb: 30 }));
  assert.equal(waiting.status, 'warn');
  const row = waiting.items.find((i) => i.key === 'space:downloads');
  assert.deepEqual(row?.detailSaid, [{ code: 'disk.archiveWaits', params: { free: 30, total: 1000, floor: 50 } }]);
  assert.match(waiting.note ?? '', /The slow archive waits below 50 GB/);

  // Paused, the archive waits for nobody's disk.
  await q('UPDATE server_settings SET archive_paused = true WHERE id = 1');
  assert.equal((await diskAndFolders(undefined, disk({ freeGb: 30 }))).status, 'ok');
  await q('UPDATE server_settings SET archive_paused = false WHERE id = 1');
  // An unmonitored series fetches nothing unattended, its archive included (lib/archive.ts tickOnce).
  await q(`UPDATE lib_series SET auto_update = false WHERE id = 'hd_arc'`);
  assert.equal((await diskAndFolders(undefined, disk({ freeGb: 30 }))).status, 'ok');
});

test('an ignored warning, stored and read back, does not silence downloads being refused', { skip }, async () => {
  const { q } = await import('../src/lib/db');
  const { findingOf } = await import('../src/lib/health');
  const { ignoreFinding, loadIgnores } = await import('../src/lib/healthIgnore');
  const { diskAndFolders } = await import('../src/lib/healthDisk');
  // What the route stores for an ignored warning (levelMembers('warn')), read back as the next report reads it.
  await ignoreFinding('disk', 'space:downloads', { title: 'Downloads disk', members: ['warn'] }, null);
  const ctx = await loadIgnores();
  const card = await diskAndFolders(ctx, disk({ freeGb: 4 }));
  const row = card.items.find((i) => i.key === 'space:downloads');
  assert.equal(card.status, 'problem', 'the ignored warning does not silence downloads being refused');
  assert.ok(!row?.info && !row?.ignored);
  // The route looks the card up by its id (findingOf): a key it does not have is gone, the route's 404.
  assert.equal(await findingOf('disk', 'nothing:here'), null);
  await q(`DELETE FROM health_ignored WHERE check_id = 'disk'`);
});
