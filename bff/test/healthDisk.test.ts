// Health's "Disk space and folders" (lib/healthDisk.ts, v0.72.0, from #253): its levels, what an ignore of one keeps, and
// how little of a folder it reads. The rows that need the database (chapters recorded under a root, the archive's queue)
// are healthDisk.int.test.ts's.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

const GB = 2 ** 30;

/** A disk of `totalGb` with `freeGb` free, whose folders each hold a first entry; counts what the card opens and reads. */
function disk(freeGb: number, totalGb = 1000) {
  const seen = { opened: [] as string[], reads: 0, sizes: [] as number[] };
  return {
    seen,
    fsx: {
      statfs: async () => ({ bavail: (freeGb * GB) / 4096, bsize: 4096, blocks: (totalGb * GB) / 4096 }),
      opendir: async (p: string, o: { bufferSize: number }) => {
        seen.opened.push(p);
        seen.sizes.push(o.bufferSize);
        return { read: async () => { seen.reads++; return { name: 'Some Series' }; }, close: async () => {} };
      },
    },
  };
}

test('red at the downloader\'s own floor, amber under the archive\'s only while it has a series queued', async () => {
  const { spaceLevel } = await import('../src/lib/healthDisk');
  const floors = { download: 10, archive: 20, archiveQueued: true };
  // #253 had a floor of its own, 5 GB: between 5 and 10 GB it said fine while the downloader refused every chapter.
  assert.equal(spaceLevel(9.9 * GB, floors), 'problem', 'downloads are refused under 10 GB, so the card is red');
  assert.equal(spaceLevel(7 * GB, floors), 'problem');
  assert.equal(spaceLevel(15 * GB, floors), 'warn', 'the archive waits under its 20 GB');
  assert.equal(spaceLevel(15 * GB, { ...floors, archiveQueued: false }), 'ok', 'an archive with nothing queued waits for nothing');
  assert.equal(spaceLevel(15 * GB, { ...floors, archive: 0 }), 'ok', 'no archive floor (or a paused archive)');
  assert.equal(spaceLevel(25 * GB, floors), 'ok');
  assert.equal(spaceLevel(1 * GB, { download: 0, archive: 0, archiveQueued: true }), 'ok', 'MIN_FREE_GB 0 is no floor, as the downloader reads it');
});

test('the card is red at the downloader\'s floor, saying where downloads stop', async () => {
  const { diskAndFolders } = await import('../src/lib/healthDisk');
  const { MIN_FREE_GB } = await import('../src/lib/downloader');
  assert.equal(MIN_FREE_GB, 10, 'the premise: the default floor');
  const card = await diskAndFolders(undefined, disk(6.5, 500).fsx);
  assert.equal(card.status, 'problem');
  const row = card.items.find((i) => i.key === 'space:downloads');
  assert.deepEqual(row?.detailSaid, [{ code: 'disk.full', params: { free: 6.5, total: 500, floor: 10 } }]);
  assert.equal(row?.detail, '6.5 GB free of 500 GB: new downloads stop under 10 GB');
  assert.deepEqual(row?.actions, ['ignore']);
  // Plenty free: one row for reference, nothing to ignore, and the summary says how much.
  const fine = await diskAndFolders(undefined, disk(400).fsx);
  assert.equal(fine.status, 'ok');
  assert.deepEqual(fine.items.map((i) => [i.detailSaid?.[0]?.code, !!i.info, i.key ?? null]), [['disk.free', true, null]]);
  assert.equal(fine.summary, '400 GB free for downloads');
});

test('the folder check reads one entry of each folder, never the whole folder', async () => {
  // A readdir of a library's top is tens of thousands of names on a NAS and spins up every disk of an Unraid array, and
  // this card runs every six hours and after every scan. Reintroduce a readdir (or a bigger buffer): this fails.
  const { diskAndFolders } = await import('../src/lib/healthDisk');
  const { LIBRARY_ROOT, DL_ROOT } = await import('../src/lib/library');
  const d = disk(400);
  await diskAndFolders(undefined, d.fsx);
  assert.deepEqual(d.seen.opened, [LIBRARY_ROOT, DL_ROOT], 'the library and the download folder, once each');
  assert.equal(d.seen.reads, 2, 'one entry each');
  assert.deepEqual(d.seen.sizes, [1, 1], 'a buffer of one entry');
});

test('an ignore keeps the level: an ignored warning does not silence a problem; an ignored problem stays quiet as a warning', async () => {
  // #253's rows ignored with no members, which every later finding is covered by (lib/healthIgnore.ts covered): ignoring
  // "the archive waits" silenced "downloads are refused" for good. Reintroduce `members: []`: the first assertion fails.
  const { levelMembers } = await import('../src/lib/healthDisk');
  const { applyIgnores, noIgnores } = await import('../src/lib/healthIgnore');
  const ignoredAt = (level: 'warn' | 'problem') => {
    const ctx = noIgnores();
    ctx.ign.set('disk\u0000space:downloads', { members: new Set(levelMembers(level)), at: '2026-10-16T00:00:00.000Z', by: 'admin' });
    return ctx;
  };
  const row = (level: 'warn' | 'problem') => [{ title: 'Downloads disk', detail: '', key: 'space:downloads', members: levelMembers(level) }];
  const worse = row('problem');
  assert.equal(applyIgnores('disk', worse, ignoredAt('warn')), 0, 'a problem after an ignored warning is news');
  assert.ok(!(worse[0] as { info?: boolean }).info);
  const eased = row('warn');
  assert.equal(applyIgnores('disk', eased, ignoredAt('problem')), 1, 'a problem ignored stays quiet when it eases to a warning');
  const same = row('warn');
  assert.equal(applyIgnores('disk', same, ignoredAt('warn')), 1, 'and an ignored warning stays quiet while it is one');
});
