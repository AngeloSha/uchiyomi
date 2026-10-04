// A 429 slows the NEXT chapter on that source too, not just the one that was told to slow down.
//
// The resume loop in downloader.ts has narrowed to one worker and doubled the gap after a 429 since
// v0.14, and both were locals of fetchChapter: the next chapter started four wide at full speed against a
// site that had just said no. Live, that read as five rate-limit strikes in 74 seconds on one source. Now
// the resume notes the source's pace level (lib/pace.ts), the next chapter starts from it, and the chapter
// gate between downloads widens with it.
//
// Every fetch is held for ~40ms so overlap is measurable, as in pageConcurrency.test.ts.
//
// v0.55.3: and the slow-down reaches further. While a level is raised the source downloads one chapter at a time; a
// 429 to one chapter is a rest the chapter beside it sits out too, and that one goes on one page at a time; a steady run
// of whole chapters takes the level down a step once it has been held an hour; and two sources whose pages come from
// one image server are slowed together from the moment both have shown their pages.
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
let pace: typeof import('../src/lib/pace');

const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
const HOLD = 40;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SRC = 'pp-src';
/** Two sources on one image CDN (v0.55.3): their pages are on img-a and img-b of sharedcdn.com. */
const CDN_A = 'pp-cdn-a', CDN_B = 'pp-cdn-b';

interface Trace {
  asked: number; peak: number; firstStart: number; limitedAt: number; resumedAt: number;
  /** When the last request of the chapter came back. */
  lastDone: number;
  /** Every request: when it started and when it came back. */
  spans: Array<[number, number]>;
}
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
    const t = traces.get(ch) ?? { asked: 0, peak: 0, firstStart: Date.now(), limitedAt: 0, resumedAt: 0, lastDone: 0, spans: [] };
    traces.set(ch, t);
    const n = ++t.asked;
    if (t.limitedAt && !t.resumedAt) t.resumedAt = Date.now();
    const now = (inflight.get(ch) ?? 0) + 1;
    inflight.set(ch, now);
    t.peak = Math.max(t.peak, now);
    const span: [number, number] = [Date.now(), 0];
    t.spans.push(span);
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
      span[1] = t.lastDone = Date.now();
    }
  }) as typeof fetch;
}

before(async () => {
  const { registerAdapter } = await import('../src/lib/sources/loader');
  ({ downloadChapter } = await import('../src/lib/downloader'));
  pace = await import('../src/lib/pace');
  ({ clearPace, paceLevel } = pace);
  // What the Suwayomi adapter declares: four at a time, no gap. The widest pool, so the narrowing shows. A `long-`
  // chapter has 120 pages, still running (about a second, four at a time) well after its neighbour is refused.
  registerAdapter({
    id: SRC, name: 'Pace Persists', pageConcurrency: 4, pageGapMs: 0,
    search: async () => [], getSeries: async () => null, listChapters: async () => [],
    getPageUrls: async (c: string) => Array.from({ length: c.startsWith('long-') ? 120 : 8 }, (_, i) => `https://example.invalid/${c}/p${i}.png`),
  } as any);
  for (const [id, host] of [[CDN_A, 'img-a'], [CDN_B, 'img-b']]) {
    registerAdapter({
      id, name: id, pageConcurrency: 4, pageGapMs: 0,
      search: async () => [], getSeries: async () => null, listChapters: async () => [],
      getPageUrls: async (c: string) => Array.from({ length: 8 }, (_, i) => `https://${host}.sharedcdn.com/${c}/p${i}.png`),
    } as any);
  }
  clearPace();
});
after(async () => { globalThis.fetch = realFetch; clearPace(); await rm(ROOT, { recursive: true, force: true }); });

const dl = (c: string, n: number, sourceId = SRC) => downloadChapter({ sourceId, seriesFolder: `PP/${sourceId}`, chapter: { sourceId: c, number: n } });

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

test('a raised pace downloads one chapter at a time', async () => {
  // v0.55.3: two chapters at once were two page streams to a server that had asked for fewer requests. Reintroduce
  // `concurrency: DL_CONCURRENCY` in underGate (downloader.ts): the two chapters overlap and `one at a time` fails.
  clearPace();
  pace.noteRateLimited(SRC);
  serve();
  await Promise.all([dl('one-1', 21), dl('one-2', 22)]);
  const [first, second] = [traces.get('one-1')!, traces.get('one-2')!].sort((a, b) => a.firstStart - b.firstStart);
  assert.ok(second.firstStart >= first.lastDone,
    `one at a time: the second chapter started ${first.lastDone - second.firstStart}ms before the first had finished`);
});

test('a 429 to one chapter slows the chapter beside it: it rests as long, then goes one page at a time', async () => {
  // Two chapters at level 0, four pages at a time each. The first is refused (Retry-After 1, resumed after RESUME ms);
  // the second used to carry on four wide against the same server, collecting 429s of its own. Reintroduce by dropping
  // the rest and the level check before each page in fetchPages' run() (`restLeft` and `follow()`): the second asks
  // again inside the first one's rest and the `rests` assertion fails.
  clearPace();
  serve('long-a', 3);
  await Promise.all([dl('long-a', 31), dl('long-b', 32)]);
  const a = traces.get('long-a')!, b = traces.get('long-b')!;
  assert.ok(a.limitedAt, 'the first chapter was refused');
  // From 200 ms on: the rest is noted once the refused chapter's requests in flight are back (one HOLD), and a loaded
  // machine is slower to get there than this one; at full speed the neighbour asks every few ms until past a second.
  const during = b.spans.filter(([start]) => start > a.limitedAt + 200 && start < a.limitedAt + RESUME - 100);
  assert.deepEqual(during.map(([start]) => start - a.limitedAt), [], 'the chapter beside it rests while the refused one does');
  const after = b.spans.filter(([start]) => start >= a.limitedAt + RESUME - 100).sort((x, y) => x[0] - y[0]);
  assert.ok(after.length > 0, 'and then carries on');
  for (let i = 1; i < after.length; i++) {
    assert.ok(after[i][0] >= after[i - 1][1], `one page at a time after the rest: a page started ${after[i - 1][1] - after[i][0]}ms early`);
  }
  assert.equal(b.asked, 120, 'every page of it was asked for once');
});

test('a raised pace comes down a step after a steady run of whole chapters, once held an hour', async () => {
  // Reintroduce by dropping `noteDownloaded(src.id)` from fetchChapter: ten whole chapters land and the level stays 1.
  clearPace();
  pace.noteRateLimited(SRC);
  pace.setPaceClock(() => Date.now() + pace.PACE_HOLD_MS); // the hour since the 429 has passed
  try {
    serve();
    for (let i = 0; i < pace.PACE_STEADY_RUN - 1; i++) await dl(`run-${i}`, 41 + i);
    assert.equal(paceLevel(SRC), 1, 'a run one short of a run changes nothing');
    await dl('run-last', 60);
    assert.equal(paceLevel(SRC), 0, `${pace.PACE_STEADY_RUN} whole chapters and an hour take the level down`);
  } finally { pace.setPaceClock(null); }
});

test('two sources on one image server are slowed together once both have shown their pages', async () => {
  // Natomanga and Mangakakalot (v0.55.3). Reintroduce by dropping `notePageHosts(src, urls)` from fetchPages: B's first
  // chapter after A's 429 runs four wide at level 0, and the `slowed with A` assertions fail.
  clearPace();
  serve('cdn-a1', 3);
  assert.equal((await dl('cdn-a1', 71, CDN_A))?.pages, 8, 'A lands after its 429');
  assert.equal(paceLevel(CDN_A), 1);
  assert.equal(paceLevel(CDN_B), 0, 'B has not shown its pages yet');
  serve();
  assert.equal((await dl('cdn-b1', 72, CDN_B))?.pages, 8);
  assert.equal(paceLevel(CDN_B), 1, 'B is slowed with A');
  assert.equal(traces.get('cdn-b1')!.peak, 1, "B's first chapter already went one page at a time");
  assert.equal(pace.rateKeyOf(CDN_A), pace.rateKeyOf(CDN_B), 'one key, one gate');
});
