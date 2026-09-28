// The slow archive's pages (#117), measured at the fetch: one at a time, each after its own random gap.
//
// pace.test.ts pins what pagePace hands the downloader; this pins that the downloader does it. The adapter
// is the Suwayomi declaration -- four workers, no gap (issue #37) -- because overriding exactly that is the
// point: the engine's pool is tuned for a person waiting on one chapter, not for a back catalogue fetched
// over ten days. And the same adapter, outside withSlowPace, must still be four wide with no gap.
//
// No database: like pageConcurrency.test.ts, reportOk/reportFail fail quietly against the unused DSN.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { clearPace, withSlowPace } from '../src/lib/pace'; // pace.ts reads no env, so it may load before the env below

// Set before the module graph loads: DL_ROOT is read once, at import, and the downloader writes real files.
const ROOT = mkdtempSync(join(tmpdir(), 'uy-ap-'));
process.env.DL_ROOT = ROOT;
process.env.DOWNLOAD_PAGE_GAP_MS = '0';
process.env.DOWNLOAD_RESUME_WAIT_MS = '0,0,0'; // the 429 below waits only its Retry-After
process.env.DOWNLOAD_MIN_GAP_MS = '0';
process.env.MIN_FREE_GB = '0'; // the disk floor is diskGuard.test.ts's subject
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';

let downloadChapter: typeof import('../src/lib/downloader')['downloadChapter'];

const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
const HOLD = 25; // long enough that four overlapping requests are measurable
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let starts: number[] = [];
let ends: number[] = [];
let peak = 0;
let inflight = 0;
let limitedAt = -1; // index into `starts` of the request that got the 429
const realFetch = globalThis.fetch;

/** Serves every page after `hold` ms; request number `limitOn` (1-based) gets one 429 with Retry-After 1. */
function serve(limitOn = 0, hold = HOLD) {
  starts = []; ends = []; peak = 0; inflight = 0; limitedAt = -1;
  globalThis.fetch = (async () => {
    const n = starts.push(Date.now());
    inflight++;
    peak = Math.max(peak, inflight);
    try {
      await sleep(hold);
      if (n === limitOn) {
        limitedAt = n - 1;
        return new Response('slow down', { status: 429, headers: { 'retry-after': '1' } });
      }
      return new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
    } finally {
      inflight--;
      ends.push(Date.now());
    }
  }) as typeof fetch;
}

/** For each request after the first: how long after the previous page came back it started. */
const afterReply = () => starts.slice(1).map((t, i) => t - ends[i]);

/** A fixed sequence of draws, cycled, so the expected gap before every page is known. */
function sequence(values: number[]): () => number {
  let n = 0;
  return () => values[n++ % values.length];
}

const urls = (n: number) => Array.from({ length: n }, (_, i) => `https://example.invalid/a${i}.png`);

before(async () => {
  const { registerAdapter } = await import('../src/lib/sources/loader');
  ({ downloadChapter } = await import('../src/lib/downloader'));
  const base = { search: async () => [], getSeries: async () => null, listChapters: async () => [] };
  // What the Suwayomi adapter declares (sources/suwayomi/sources.ts): four at a time, no gap.
  registerAdapter({ ...base, id: 'arch-ext', name: 'Archive Ext', pageConcurrency: 4, pageGapMs: 0, getPageUrls: async () => urls(12) } as any);
});
beforeEach(clearPace); // a 429 in one test must not slow the next one's chapter for the wrong reason
after(async () => { globalThis.fetch = realFetch; await rm(ROOT, { recursive: true, force: true }); });

const chapter = (n: number) => ({ sourceId: `c${n}`, number: n });

test('under withSlowPace a Suwayomi source is fetched one page at a time, each after its own random gap', async () => {
  // Two reintroductions, two assertions:
  // - In pagePace (lib/pace.ts), return `workers: pace.workers` under the slow pace: the adapter's four
  //   workers survive and the `one page at a time` assertion fails with a peak above 1.
  // - In run() (downloader.ts), use `const g = gap` instead of the per-page draw: every gap is the range's
  //   low end, and the first page whose draw was above it fails `waited at least its drawn N ms`.
  const draws = [0.9, 0, 0.5, 0.99, 0.1, 0.7]; // → 112, 40, 80, 119, 48, 96 ms over [40, 120]
  const expected = (k: number) => Math.round(40 + 80 * draws[k % draws.length]);
  // Each page is held longer than any gap, or four workers could never overlap: slots are spaced from the
  // previous START too, and a page that answers inside its gap is back before the next one begins.
  serve(0, 150);
  const res = await withSlowPace({ pageGapMs: [40, 120], rand: sequence(draws) }, () =>
    downloadChapter({ sourceId: 'arch-ext', seriesFolder: 'Arch/S', chapter: chapter(1) }));
  assert.equal(res?.pages, 12);
  assert.equal(starts.length, 12, 'every page fetched exactly once');
  assert.equal(peak, 1, `one page at a time, saw a peak of ${peak}`);

  // Page k's slot was drawn with the k-th draw (page 0's draw is spent too; it just has nothing to wait
  // for). Timers fire late, never early, so each gap is at least its draw.
  const gaps = afterReply();
  gaps.forEach((g, i) => assert.ok(g >= expected(i + 1) - 2,
    `page ${i + 1} waited at least its drawn ${expected(i + 1)} ms after the previous reply, saw ${g} (${gaps.join(', ')})`));
  assert.ok(gaps.every((g) => g >= 38), `never under the range's 40 ms, even though the adapter declares 0: ${gaps.join(', ')}`);
  const spread = Math.max(...gaps) - Math.min(...gaps);
  assert.ok(spread >= 50, `the gap varies from page to page: ${gaps.join(', ')}`);
});

test('the same source outside withSlowPace, straight after, is exactly as fast as before', async () => {
  // The override is scoped to the archive's own chapters. Reintroduce by keeping the slow pace in a
  // module-level variable that withSlowPace sets and nothing clears: this chapter runs one wide and the
  // `four in flight` assertion fails with a peak of 1. pageConcurrency.test.ts pins the rest.
  serve();
  await withSlowPace({ pageGapMs: [5, 10] }, () =>
    downloadChapter({ sourceId: 'arch-ext', seriesFolder: 'Arch/S', chapter: chapter(2) }));
  serve();
  const res = await downloadChapter({ sourceId: 'arch-ext', seriesFolder: 'Arch/S', chapter: chapter(3) });
  assert.equal(res?.pages, 12);
  assert.equal(peak, 4, `four in flight, as the adapter declares, saw a peak of ${peak}`);
  assert.ok(Math.min(...afterReply()) < 5, 'and no gap: the engine paces the site');
});

test('a 429 under the slow pace resumes with both ends of the range doubled', async () => {
  // The resume after a refusal may not be the fast part of an archive chapter. The doubled fixed gap
  // already lifts the LOW end (it is each draw's floor), so the draws here sit at the top of the range,
  // which only the range's own doubling can move: [20, 40] drawn at 0.99 is 40 before the 429, and 80 from
  // [40, 80] after it. Reintroduce by deleting the `if (jitter) jitter = ...` line in the resume branch of
  // fetchPages: the range stays [40 (the doubled floor), 40], and `doubled after the 429` fails with ~40.
  serve(4);
  const res = await withSlowPace({ pageGapMs: [20, 40], rand: () => 0.99 }, () =>
    downloadChapter({ sourceId: 'arch-ext', seriesFolder: 'Arch/S', chapter: chapter(4) }));
  assert.equal(res?.pages, 12, 'the chapter completes once the pause is honoured');
  assert.equal(limitedAt, 3, 'the 429 was actually served');
  assert.equal(peak, 1, 'one at a time throughout');
  const gaps = afterReply();
  const before = gaps.slice(0, limitedAt);
  const resumed = gaps.slice(limitedAt + 1); // after the resumed first page, which waits out the Retry-After
  assert.ok(before.every((g) => g >= 38 && g < 70), `about 40 ms before the 429: ${before.join(', ')}`);
  assert.ok(resumed.length >= 6 && resumed.every((g) => g >= 78), `doubled after the 429: ${resumed.join(', ')}`);
});
