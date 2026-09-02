// The pause between page requests inside one chapter.
//
// The download gate spaces CHAPTERS by DOWNLOAD_MIN_GAP_MS, and for a long time nothing at all spaced the
// images inside one. A chapter on this install is 110-130 images fetched back to back, two chapters at a
// time, which is several requests a second sustained for minutes. Measured live at the moment mangakakalot
// and natomanga started refusing: ~1.9 pages/second, right up to the 429.
//
// That is the whole cause. The sites did not change and we were not IP-banned -- cache-busted probes at
// 0.3 req/s were served normally minutes later. We were simply going too fast, and then blaming the site
// for saying so.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '';
const GAP = 40;
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-pace-'));
  process.env.DATABASE_URL = DSN;
  process.env.DL_ROOT = ROOT;
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.DOWNLOAD_PAGE_GAP_MS = String(GAP);
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const SRC = 'pace-src';
const PAGES = 6;
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
let q: any, downloadChapter: any;
let stamps: number[] = [];

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const { registerAdapter } = await import('../src/lib/sources/loader');
  ({ downloadChapter } = (await import('../src/lib/downloader')) as any);
  await migrate();
  registerAdapter({
    id: SRC, name: 'Pace Source',
    search: async () => [], getSeries: async () => null, listChapters: async () => [],
    getPageUrls: async () => Array.from({ length: PAGES }, (_, i) => `https://example.invalid/q${i}.png`),
  } as any);
});

after(async () => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  if (!DSN) return;
  await q('DELETE FROM source_health WHERE source_id = $1', [SRC]).catch(() => {});
});

/**
 * Reintroduce by deleting the `if (i && gap) await sleep(gap)` line in downloader.ts: the pages arrive in a
 * burst, the smallest gap collapses to roughly zero, and this fails.
 */
test('pages inside a chapter are spaced, not fired in a burst', { skip }, async () => {
  stamps = [];
  globalThis.fetch = (async () => {
    stamps.push(Date.now());
    return new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;

  const res = await downloadChapter({ sourceId: SRC, seriesFolder: 'P/S', chapter: { sourceId: 'p1', number: 1 } });

  assert.equal(res.pages, PAGES);
  assert.equal(stamps.length, PAGES, 'every page was fetched exactly once');
  const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
  const smallest = Math.min(...gaps);
  // Timers fire late, never early, so the floor is the assertion. A burst measures ~0.
  assert.ok(smallest >= GAP * 0.7,
    `pages should be at least ~${GAP}ms apart, smallest was ${smallest}ms (${gaps.join(', ')})`);
});
