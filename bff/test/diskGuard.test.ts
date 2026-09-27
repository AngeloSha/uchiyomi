// The library disk has a floor.
//
// Nothing consulted free space before a download. The first sign would have been ENOSPC part-way through a
// chapter, on a filesystem that was already at 87% and holds the library, every download and the only
// backup. And after v0.13.0 revived 176 series that were ~12,000 chapters behind, the nightly sweep's plan
// was to walk all of it with no idea the disk existed.
//
// The floor is read at import, so this file owns it; every other download test sets MIN_FREE_GB=0.
process.env.MIN_FREE_GB = '100000000'; // no disk on earth clears this, so the guard MUST fire
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'yomi-disk-'));
process.env.DL_ROOT = ROOT;
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';

test('a nearly full disk refuses the download before the source is even asked', async () => {
  const { downloadChapter } = await import('../src/lib/downloader');
  const { registerAdapter } = await import('../src/lib/sources/loader');
  let asked = 0;
  registerAdapter({
    id: 'disk-src', name: 'Disk Source',
    search: async () => [], getSeries: async () => null, listChapters: async () => [],
    getPageUrls: async () => { asked++; return ['https://example.invalid/x.png']; },
  } as any);

  const err = await downloadChapter({ sourceId: 'disk-src', seriesFolder: 'D/S', chapter: { sourceId: 'c1', number: 1 } })
    .then(() => null, (e) => e);

  assert.ok(err?.diskFull, 'refused, and marked as the disk rather than the chapter or the source');
  assert.match(err.message, /floor is 100000000 GiB/);
  assert.equal(err.blockStatus, undefined, 'no source is blamed for our disk');
  assert.equal(asked, 0, 'and the source was never asked: the refusal is entirely ours');
  rmSync(ROOT, { recursive: true, force: true });
});

test('freeBytes measures the download disk the guard measures, and fails open with null', async () => {
  // The slow archive gates on its own, higher floor (lib/archive.ts) through this, so it has to read the
  // same disk the same way as the guard above. Reintroduce by returning `null` from freeBytes: the guard
  // above fails open and stops refusing, and the `measures the disk` assertion here fails too.
  const { freeBytes } = await import('../src/lib/downloader');
  mkdirSync(ROOT, { recursive: true }); // the test above removed it
  const f = statfsSync(ROOT);
  const want = Number(f.bavail) * Number(f.bsize);
  const got = await freeBytes();
  assert.ok(typeof got === 'number' && got > 0, `measures the disk, got ${got}`);
  // Free space moves while the suite runs; a gibibyte either way is the same disk.
  assert.ok(Math.abs(got - want) < 2 ** 30, `the same disk statfs sees under DL_ROOT: ${got} vs ${want}`);

  rmSync(ROOT, { recursive: true, force: true });
  assert.equal(await freeBytes(), null, 'a DL_ROOT statfs cannot read is null, which every caller treats as room');
});
