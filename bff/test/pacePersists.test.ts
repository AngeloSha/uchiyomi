// A 429 slows the NEXT chapter on that source too, not just the one that was told to slow down.
//
// The resume loop in downloader.ts has narrowed to one worker and doubled the gap after a 429 since
// v0.14, and both were locals of fetchChapter: the next chapter started four wide at full speed against a
// site that had just said no. Live, that read as five rate-limit strikes in 74 seconds on one source. Now
// the resume notes the source's pace level (lib/pace.ts), the next chapter starts from it, and the chapter
// gate between downloads widens with it.
//
// Every fetch is held for ~40ms so overlap is measurable, as in pageConcurrency.test.ts.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const ROOT = mkdtempSync(join(tmpdir(), 'uy-pp-'));
process.env.DL_ROOT = ROOT;
process.env.DOWNLOAD_PAGE_GAP_MS = '0';
/** The chapter gate at level 0. Doubled by the first 429; the test below measures it between two chapters. */
const GATE = 100;
process.env.DOWNLOAD_MIN_GAP_MS = String(GATE);
/** The first resume waits at least this long, whatever Retry-After said. The last test measures it. */
const RESUME = 1500;
process.env.DOWNLOAD_RESUME_WAIT_MS = `${RESUME},0,0`;
process.env.MIN_FREE_GB = '0';
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';

let downloadChapter: typeof import('../src/lib/downloader')['downloadChapter'];
let clearPace: () => void;
let paceLevel: (id: string) => number;

const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
const HOLD = 40;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SRC = 'pp-src';

interface Trace { asked: number; peak: number; firstStart: number; limitedAt: number; resumedAt: number }
/** Per chapter id: how many requests it made, its peak in-flight, and when its first request started. */
let traces: Map<string, Trace>;
const realFetch = globalThis.fetch;

/** Serves every page of every chapter, held for HOLD ms; request number `limitAt` of chapter `limitCh` gets one 429. */
function serve(limitCh = '', limitAt = 0) {
  traces = new Map();
  const inflight = new Map<string, number>();
  let tripped = false;
  globalThis.fetch = (async (u: any) => {
    const [, ch, idx] = String(u).match(/\/([^/]+)\/p(\d+)\.png$/)!;
    const t = traces.get(ch) ?? { asked: 0, peak: 0, firstStart: Date.now(), limitedAt: 0, resumedAt: 0 };
    traces.set(ch, t);
    const n = ++t.asked;
    if (t.limitedAt && !t.resumedAt) t.resumedAt = Date.now();
    const now = (inflight.get(ch) ?? 0) + 1;
    inflight.set(ch, now);
    t.peak = Math.max(t.peak, now);
    try {
      await sleep(HOLD);
      if (ch === limitCh && n === limitAt && !tripped) {
        tripped = true;
        t.limitedAt = Date.now();
        return new Response('slow down', { status: 429, headers: { 'retry-after': '1' } });
      }
      return new Response(Buffer.concat([PIXEL, Buffer.from([Number(idx)])]), { status: 200, headers: { 'content-type': 'image/png' } });
    } finally {
      inflight.set(ch, inflight.get(ch)! - 1);
    }
  }) as typeof fetch;
}

before(async () => {
  const { registerAdapter } = await import('../src/lib/sources/loader');
  ({ downloadChapter } = await import('../src/lib/downloader'));
  ({ clearPace, paceLevel } = await import('../src/lib/pace'));
  // What the Suwayomi adapter declares: four at a time, no gap. The widest pool, so the narrowing shows.
  registerAdapter({
    id: SRC, name: 'Pace Persists', pageConcurrency: 4, pageGapMs: 0,
    search: async () => [], getSeries: async () => null, listChapters: async () => [],
    getPageUrls: async (c: string) => Array.from({ length: 8 }, (_, i) => `https://example.invalid/${c}/p${i}.png`),
  } as any);
  clearPace();
});
after(async () => { globalThis.fetch = realFetch; clearPace(); await rm(ROOT, { recursive: true, force: true }); });

const dl = (c: string, n: number) => downloadChapter({ sourceId: SRC, seriesFolder: 'PP/S', chapter: { sourceId: c, number: n } });

test('a 429 in one chapter narrows the NEXT chapter on that source to one page at a time', async () => {
  // Reintroduce by deleting `noteRateLimited(src.id)` from the resume loop in fetchPages (and the one after
  // it): chapter 1 still lands, the level stays 0, and chapter 2 runs four wide -- the `one at a time`
  // assertion reads a peak of 4.
  serve('c1', 3);
  const first = await dl('c1', 1);
  assert.equal(first?.pages, 8, 'chapter 1 lands after the resume');
  assert.equal(traces.get('c1')!.peak, 4, 'it started four wide, as declared');
  assert.equal(paceLevel(SRC), 1, 'the source is now at level 1');

  const second = await dl('c2', 2);
  assert.equal(second?.pages, 8);
  assert.equal(traces.get('c2')!.peak, 1, `one at a time on the next chapter, saw a peak of ${traces.get('c2')!.peak}`);
});

test('the chapter gate doubles with the level: two chapters start twice as far apart', async () => {
  // Reintroduce by passing `minGapMs: DL_MIN_GAP_MS` (no `2 ** paceLevel`) to withGate in underGate: the
  // two starts are ~GATE apart and the `twice the gate` assertion fails.
  assert.equal(paceLevel(SRC), 1, 'carried over from the previous test: the level persists');
  serve();
  await Promise.all([dl('c3', 3), dl('c4', 4)]);
  const a = traces.get('c3')!.firstStart;
  const b = traces.get('c4')!.firstStart;
  const apart = Math.abs(b - a);
  // Timers fire late, never early, so the floor is the assertion: 2 x GATE less the few ms between the
  // gate and the first request.
  assert.ok(apart >= GATE * 2 - 15, `twice the gate between chapter starts at level 1, saw ${apart}ms`);
});

test('a 429 with no resume pass still raises the level: the completion pass is not exempt', async () => {
  // fetchPages with `retry: false` is what the completion pass calls (one request per hole, no resume). A
  // 429 there is a 429 like any other and must slow the source's next chapters. Reintroduce by deleting the
  // `if (retryAfterMs) noteRateLimited(src.id)` after the resume loop in fetchPages: the level reads 0.
  clearPace();
  serve('c6', 2);
  const { fetchPages } = await import('../src/lib/downloader');
  const { getSource } = await import('../src/lib/sources/loader');
  const src = getSource(SRC)!;
  const urls = await src.getPageUrls('c6');
  const got = await fetchPages(src, urls, urls.map((_, i) => i), { chapterSourceId: 'c6', retry: false });
  assert.ok(got.retryAfterMs > 0, 'the 429 was served and never resumed');
  assert.ok([...got.failed.values()].some((f) => f.status === 429), 'and it is on the evidence');
  assert.equal(paceLevel(SRC), 1, 'one 429, one level, with no resume loop to note it');
});

test('the resume waits the configured floor even when Retry-After asked for less', async () => {
  // Retry-After: 1 says one second; the first resume floor is 1.5s. A site that has just refused a burst is
  // not ready one second later whatever the header said. Reintroduce by sleeping `retryAfterMs` alone in the
  // resume loop: the resume comes ~1000ms after the 429 and the floor assertion fails.
  clearPace();
  serve('c5', 3);
  const res = await dl('c5', 5);
  assert.equal(res?.pages, 8);
  const t = traces.get('c5')!;
  assert.ok(t.limitedAt && t.resumedAt, 'the 429 was served and the chapter resumed');
  const waited = t.resumedAt - t.limitedAt;
  assert.ok(waited >= RESUME - 20, `resumed at least ${RESUME}ms after the 429, saw ${waited}ms`);
});
