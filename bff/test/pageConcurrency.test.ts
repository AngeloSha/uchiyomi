// Page fetches inside one chapter overlap only when the source says they may.
//
// The quarter-second, one-at-a-time pacing in downloader.ts is what stopped the 429s on the sites we scrape
// ourselves, and it was applied to every source alike -- including extension sources, whose page URLs are
// the engine's own proxy paths, rate-limited by the engine towards the site. An extension chapter ran at the
// scraped-site pace for no reason (issue #37). Now an adapter declares `pageConcurrency` and `pageGapMs`;
// the downloader runs a small worker pool for one that does and stays exactly the sequential loop it was
// for one that does not.
//
// Every fetch here is held for ~40ms so overlap is measurable: peak in-flight is the observable.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path'; import { clearPace } from '../src/lib/pace'; // pace.ts reads no env, so it may load before the env below

// Set before the module graph loads: DL_ROOT is read once, at import, and the downloader writes real files.
const ROOT = mkdtempSync(join(tmpdir(), 'uy-pc-'));
process.env.DL_ROOT = ROOT;
// The default gap is production politeness, pinned by downloadPacing.int.test.ts. Here it would only add
// 110 x 250ms to the long-chapter tests; the paced adapter below declares its own gap instead.
process.env.DOWNLOAD_PAGE_GAP_MS = '0'; process.env.DOWNLOAD_RESUME_WAIT_MS = '0,0,0'; // resumes wait only Retry-After here; pacePersists.test.ts pins the wait
process.env.DOWNLOAD_MIN_GAP_MS ||= '0';
process.env.MIN_FREE_GB = '0'; // the disk floor is not the subject here; diskGuard.test.ts is
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.SUWAYOMI_URL ||= 'http://suwayomi.test:4567';
process.env.SUWAYOMI_PAGE_CONCURRENCY = '3'; // a non-default, so the last test can tell env from a literal

let downloadChapter: typeof import('../src/lib/downloader')['downloadChapter'];

/** A one-pixel PNG, comfortably over the 256-byte floor the downloader uses to skip blocked responses. */
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
const HOLD = 40;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Trace {
  asked: number;
  peak: number; // most requests in flight at once, over the whole chapter
  starts: number[]; // Date.now() at each request, in request order
  limited: boolean; // a 429 has been handed back
  peakAfterLimit: number; // most in flight at the start of any request made after that
}
let trace: Trace;
let inflight = 0;
const realFetch = globalThis.fetch;

/**
 * Serves every page, held for `hold(i)` ms, except that request n gets a 429 (Retry-After: 1) when
 * `limit(n)` says so. Each body ends in the page's own index byte so the zip can be checked for position.
 */
function serve(limit: (n: number) => boolean = () => false, hold: (i: number) => number = () => HOLD) {
  trace = { asked: 0, peak: 0, starts: [], limited: false, peakAfterLimit: 0 };
  inflight = 0;
  globalThis.fetch = (async (u: any) => {
    const i = Number(String(u).match(/p(\d+)\.png$/)?.[1] ?? -1);
    const n = ++trace.asked;
    trace.starts.push(Date.now());
    inflight++;
    trace.peak = Math.max(trace.peak, inflight);
    if (trace.limited) trace.peakAfterLimit = Math.max(trace.peakAfterLimit, inflight);
    try {
      await sleep(hold(i));
      if (limit(n)) {
        trace.limited = true;
        return new Response('slow down', { status: 429, headers: { 'retry-after': '1' } });
      }
      return new Response(Buffer.concat([PIXEL, Buffer.from([i])]), { status: 200, headers: { 'content-type': 'image/png' } });
    } finally {
      inflight--;
    }
  }) as typeof fetch;
}

const urls = (n: number) => Array.from({ length: n }, (_, i) => `https://example.invalid/p${i}.png`);

before(async () => {
  const { registerAdapter } = await import('../src/lib/sources/loader');
  ({ downloadChapter } = await import('../src/lib/downloader'));
  const base = { search: async () => [], getSeries: async () => null, listChapters: async () => [] };
  // What the Suwayomi adapter declares: pages come off the engine's proxy, four at a time, no gap.
  registerAdapter({ ...base, id: 'ext-fast', name: 'Ext Fast', pageConcurrency: 4, pageGapMs: 0, getPageUrls: async (c: string) => urls(c === 'long' ? 110 : 8) } as any);
  // What every engine and pack site declares, which is nothing.
  registerAdapter({ ...base, id: 'ext-plain', name: 'Ext Plain', getPageUrls: async () => urls(8) } as any);
  // A pool AND a gap, to show the gap is a rate across the pool rather than a sleep in each worker.
  registerAdapter({ ...base, id: 'ext-paced', name: 'Ext Paced', pageConcurrency: 2, pageGapMs: 30, getPageUrls: async () => urls(6) } as any);
  // Sequential with a gap: what an engine looks like, at a gap the test can afford.
  registerAdapter({ ...base, id: 'ext-slow', name: 'Ext Slow', pageConcurrency: 1, pageGapMs: 30, getPageUrls: async () => urls(5) } as any);
});
beforeEach(clearPace); after(async () => { globalThis.fetch = realFetch; await rm(ROOT, { recursive: true, force: true }); }); // clearPace: a 429 in one test must not narrow the next test's pool (pacePersists.test.ts is where that is the subject)

const chapter = (id: string, n: number) => ({ sourceId: id, number: n });

test('a source that declares pageConcurrency 4 has four pages in flight at once', async () => {
  // Reintroduce by hard-coding `let workers = 1` in downloader.ts: the `four in flight` assertion fails
  // with peak 1, which is the sequential loop extension sources were stuck with.
  //
  // The hold is longer for lower indexes, so the first four pages come back in REVERSE order and the
  // position check below is not satisfied by arrival order alone.
  serve(() => false, (i) => HOLD + (3 - (i % 4)) * 10);
  const res = await downloadChapter({ sourceId: 'ext-fast', seriesFolder: 'Fast/S', chapter: chapter('c1', 1) });
  assert.equal(res.pages, 8);
  assert.equal(trace.peak, 4, `four in flight at once, saw a peak of ${trace.peak}`);
  assert.equal(trace.asked, 8, 'every page fetched exactly once');

  const AdmZip = (await import('adm-zip')).default;
  const entries = new AdmZip(join(ROOT, 'Fast/S/Chapter 1.cbz')).getEntries()
    .filter((e: any) => e.entryName !== 'ComicInfo.xml');
  assert.deepEqual(entries.map((e: any) => e.entryName), Array.from({ length: 8 }, (_, i) => `000${i + 1}.png`));
  assert.deepEqual(entries.map((e: any) => e.getData().at(-1)), [0, 1, 2, 3, 4, 5, 6, 7],
    'each entry holds the page it was fetched as: results land by position, not in arrival order');
});

test('a source that declares nothing is still fetched one page at a time', async () => {
  // Reintroduce by changing the default `src.pageConcurrency ?? 1` to `?? 4` in downloader.ts: the
  // `one at a time` assertion fails with peak 4. That default is every engine and pack site, where the
  // sequential pacing is what stopped the 429s, so it must not drift.
  serve();
  const res = await downloadChapter({ sourceId: 'ext-plain', seriesFolder: 'Plain/S', chapter: chapter('c1', 1) });
  assert.equal(res.pages, 8);
  assert.equal(trace.peak, 1, `one at a time, saw a peak of ${trace.peak}`);
});

test('a 429 still stops the burst at concurrency 4', async () => {
  // Reintroduce by dropping `!retryAfterMs &&` from the worker loop condition in run(): with no gap there
  // is no sleep and so no re-check, every worker drains the whole index list, and the `stop asking`
  // assertion fails with asked >= 110.
  serve((n) => n > 10);
  const err = await downloadChapter({ sourceId: 'ext-fast', seriesFolder: 'Fast/S', chapter: chapter('long', 2) })
    .then(() => null, (e) => e);
  assert.ok(err, 'still refused: the chapter is genuinely short');
  assert.ok(trace.asked < 40,
    `it must stop asking once told to slow down, asked ${trace.asked} times for a 110-page chapter`);
  assert.equal(err.blockStatus, 'rate_limited', 'and a 429 still ends the caller run');
});

test('after a 429 the resume runs one page at a time', async () => {
  // The burst is what was refused; resuming it four wide would earn the next one. Reintroduce by deleting
  // `workers = 1` in the Retry-After branch of the resume loop: the `one at a time after the 429` assertion
  // fails with a peak of 4.
  let tripped = false;
  serve((n) => { if (n === 11 && !tripped) { tripped = true; return true; } return false; });
  const res = await downloadChapter({ sourceId: 'ext-fast', seriesFolder: 'Fast/S', chapter: chapter('long', 3) })
    .catch(() => null);
  assert.ok(res, 'the chapter completes once the pause is honoured');
  assert.equal(res!.pages, 110);
  assert.ok(trace.limited, 'the 429 was actually served');
  assert.equal(trace.peakAfterLimit, 1, `one at a time after the 429, saw a peak of ${trace.peakAfterLimit}`);
});

test('the gap is a rate across the pool, not a sleep inside each worker', async () => {
  // Two workers each sleeping the gap on their own would start their pages together and halve the spacing
  // the source asked for. Reintroduce by replacing the slot reservation in run() with a plain
  // `if (gap) await sleep(gap)` inside the worker: both workers wake at once, the smallest gap between
  // starts collapses to roughly zero, and the `starts spaced` assertion fails.
  serve();
  const res = await downloadChapter({ sourceId: 'ext-paced', seriesFolder: 'Paced/S', chapter: chapter('c1', 1) });
  assert.equal(res.pages, 6);
  assert.equal(trace.peak, 2, 'the pool was actually two wide');
  const gaps = trace.starts.slice(1).map((t, i) => t - trace.starts[i]);
  const smallest = Math.min(...gaps);
  // Timers fire late, never early, so the floor is the assertion.
  assert.ok(smallest >= 21, `starts spaced at least ~30ms apart, smallest was ${smallest}ms (${gaps.join(', ')})`);
});

test('a slow site is not asked again until the gap after the previous page has PASSED', async () => {
  // The loop this pool replaced slept `gap` after each page came back, so a site that takes 500ms to
  // answer saw a request every 750ms. Spacing STARTS alone would put the next request `gap` after the
  // previous one began -- which, when the page takes longer than the gap, is straight after it returns:
  // a 500ms site is back at ~2 requests/second, the very rate that earned the 429s, while every "starts
  // are spaced" assertion stays green. So the floor is measured from the previous completion as well.
  //
  // Reintroduce by dropping `lastDone + gap` from the slot reservation in run(): with pages held for 60ms
  // and a 30ms gap the next start follows the previous completion immediately, and the `gap after the
  // reply` assertion fails with an end-to-start distance of ~0.
  serve(() => false, () => 60);
  const ends: number[] = [];
  const inner = globalThis.fetch;
  globalThis.fetch = (async (u: any) => { try { return await inner(u); } finally { ends.push(Date.now()); } }) as typeof fetch;
  const res = await downloadChapter({ sourceId: 'ext-slow', seriesFolder: 'Slow/S', chapter: chapter('c1', 1) });
  assert.equal(res.pages, 5);
  assert.equal(trace.peak, 1, 'sequential, so each start has exactly one previous completion');
  // for each request after the first: how long after the previous page came back did it start
  const afterReply = trace.starts.slice(1).map((t, i) => t - ends[i]);
  assert.ok(Math.min(...afterReply) >= 21,
    `gap after the reply: at least ~30ms between a page coming back and the next request, saw ${afterReply.join(', ')}`);
});

test('the Suwayomi adapter is the source that declares it', async () => {
  // The pool exists for extension sources, and the only thing that makes one an extension source to the
  // downloader is this declaration. Reintroduce by deleting `pageConcurrency: env.SUWAYOMI_PAGE_CONCURRENCY`
  // from the adapter literal in sources/suwayomi/sources.ts: the `declares the env knob` assertion fails
  // with undefined, and every extension chapter is back at the scraped-site pace with nothing else failing.
  const { makeSuwayomiAdapter } = await import('../src/lib/sources/suwayomi/sources');
  const a = makeSuwayomiAdapter({ id: '1', name: 'Local' }, (async () => ({})) as any);
  assert.equal(a.pageConcurrency, 3, 'declares the env knob, not a literal');
  assert.equal(a.pageGapMs, 0, 'and no gap: the engine paces the site, not us');
});
