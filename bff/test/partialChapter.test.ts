// A chapter that did not fully download must not be written as if it had.
//
// This is behavioural on purpose. The repo already had regex-over-source guards standing in for coverage on
// exactly this path, and a regex cannot tell you that seventeen of twenty pages was packed and returned as
// success. The bug: `worst` was only consulted when EVERY page failed, so a partial chapter was written,
// reported as complete, and -- because an existing file is skipped on sight -- never fetched again. The
// reader simply stopped early, permanently, and nothing recorded it.
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// Set before the module graph loads: DL_ROOT is read once, at import, and the downloader writes real files.
const ROOT = mkdtempSync(join(tmpdir(), 'uy-dl-'));
process.env.DL_ROOT = ROOT;
// Pacing is production politeness, not the subject here, and 110 pages x 250ms would add half a minute to
// every test in this file. downloadPacing.int.test.ts is where the delay itself is pinned.
process.env.DOWNLOAD_PAGE_GAP_MS = '0';
process.env.DOWNLOAD_MIN_GAP_MS ||= '0';
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';

let downloadChapter: typeof import('../src/lib/downloader')['downloadChapter'];

/** A one-pixel PNG, comfortably over the 256-byte floor the downloader uses to skip blocked responses. */
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);

let served: number[] = [];
const realFetch = globalThis.fetch;

/** Serves `ok` pages, then fails the rest — the exact shape of a chapter that dies part-way. */
function serve(ok: number) {
  served = [];
  globalThis.fetch = (async (u: any) => {
    const n = served.length; served.push(n);
    if (n < ok) {
      return new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return new Response('nope', { status: 503 });
  }) as typeof fetch;
}

before(async () => {
  const { registerAdapter } = await import('../src/lib/sources/loader');
  ({ downloadChapter } = await import('../src/lib/downloader'));
  registerAdapter({
    id: 'test-partial',
    name: 'Test Partial',
    search: async () => [],
    getSeries: async () => null,
    listChapters: async () => [],
    // Five pages, always.
    getPageUrls: async () => ['a', 'b', 'c', 'd', 'e'].map((p) => `https://example.invalid/${p}.png`),
  } as any);
  // A long chapter, so the difference between "lost one page in a hundred" and "lost a fifth of it" can be
  // expressed at all. On a five-page chapter every shortfall is a large one.
  registerAdapter({
    id: 'test-long',
    name: 'Test Long',
    search: async () => [],
    getSeries: async () => null,
    listChapters: async () => [],
    getPageUrls: async () => Array.from({ length: 110 }, (_, i) => `https://example.invalid/p${i}.png`),
  } as any);
});
beforeEach(() => { served = []; });
after(async () => { globalThis.fetch = realFetch; await rm(ROOT, { recursive: true, force: true }); });

const chapter = (n: number, pages?: number) => ({ sourceId: `c${n}`, number: n, pages });
const exists = (rel: string) => stat(join(ROOT, rel)).then(() => true).catch(() => false);

test('a complete chapter is written', async () => {
  serve(5);
  const r = await downloadChapter({ sourceId: 'test-partial', seriesFolder: 'T/Whole', chapter: chapter(1) } as any);
  assert.equal(r.pages, 5);
  assert.equal(await exists('T/Whole/Chapter 1.cbz'), true);
});

test('THE TRUNCATION: a chapter missing pages is refused, not written', async () => {
  // Four of five. Before this, that was packed and returned `{ pages: 4 }` as a success.
  //
  // Reintroduce by consulting `worst` only when `n === 0`: this resolves instead of throwing, and the
  // assertion below that no file was left behind is the one that really matters -- a written short chapter
  // is skipped forever afterwards.
  serve(4);
  await assert.rejects(
    downloadChapter({ sourceId: 'test-partial', seriesFolder: 'T/Short', chapter: chapter(2) } as any),
    /incomplete chapter: 4 of 5 pages/,
  );
  assert.equal(await exists('T/Short/Chapter 2.cbz'), false, 'a truncated chapter was left on disk and will never be retried');
});

test('the source\'s own page count wins over the number of urls', async () => {
  // MangaDex reports `pages` per chapter. If it says 5 and the url list is short, the chapter is still
  // incomplete -- trusting the url list alone would call it whole.
  serve(5);
  await assert.rejects(
    downloadChapter({ sourceId: 'test-partial', seriesFolder: 'T/Declared', chapter: chapter(3, 9) } as any),
    /incomplete chapter: 5 of 9 pages/,
  );
  assert.equal(await exists('T/Declared/Chapter 3.cbz'), false);
});

test('a chapter where nothing downloaded still reports as blocked', async () => {
  // The pre-existing behaviour, which must survive: zero pages is a source problem, not just a short read.
  serve(0);
  await assert.rejects(
    downloadChapter({ sourceId: 'test-partial', seriesFolder: 'T/None', chapter: chapter(4) } as any),
    (e: any) => !!e.blockStatus,
  );
});

/** Fails exactly the pages at `bad`, every time they are asked for. Everything else serves. */
function serveExcept(bad: number[], status = 503) {
  const fail = new Set(bad);
  served = [];
  globalThis.fetch = (async (u: any) => {
    const i = Number(String(u).match(/p(\d+)\.png$/)?.[1] ?? -1);
    served.push(i);
    if (fail.has(i)) return new Response('nope', { status });
    return new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;
}

test('THE COOLDOWN: losing one page in a hundred must not condemn the source', async () => {
  // This is the regression. The first version of the guard called reportFail on ANY shortfall, so a single
  // flaky image put the whole source into an escalating cooldown -- which on the live install blocked
  // mangakakalot over 98 of 101 pages and stopped a 92-chapter fill after three.
  serveExcept([7]);
  const err = await downloadChapter({
    sourceId: 'test-long', seriesFolder: 'Long/Series', chapter: chapter(1),
  }).then(() => null, (e) => e);

  assert.ok(err, 'the chapter is still refused: an incomplete chapter must never be written');
  assert.match(String(err.message), /incomplete chapter: 109 of 110/);
  assert.equal(err.blockStatus, undefined,
    'and crucially it carries NO blockStatus, so the caller keeps going instead of ending the whole run');
  assert.equal(await exists('Long/Series/Chapter 1.cbz'), false);
});

test('the pages that failed are retried once, and only once', async () => {
  serveExcept([3, 9]);
  await downloadChapter({ sourceId: 'test-long', seriesFolder: 'Long/Series', chapter: chapter(2) })
    .catch(() => {});
  const asked = (i: number) => served.filter((x) => x === i).length;
  assert.equal(asked(3), 2, 'the failed page is asked for a second time');
  assert.equal(asked(9), 2);
  assert.equal(asked(4), 1, 'a page that arrived is not asked again');
  assert.equal(served.length, 112, '110 pages plus exactly two retries, not a loop');
});

test('a retry that succeeds saves the chapter, in the right order', async () => {
  // Fail page 5 on the first pass only, then serve it. This is the ordinary flaky-CDN case, and before the
  // retry existed it cost the chapter AND a day of cooldown.
  let firstPass = true;
  served = [];
  globalThis.fetch = (async (u: any) => {
    const i = Number(String(u).match(/p(\d+)\.png$/)?.[1] ?? -1);
    served.push(i);
    if (i === 5 && firstPass) { firstPass = false; return new Response('nope', { status: 503 }); }
    return new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;

  const res = await downloadChapter({ sourceId: 'test-long', seriesFolder: 'Long/Series', chapter: chapter(3) });
  assert.equal(res.pages, 110, 'all 110 pages made it');
  assert.equal(await exists('Long/Series/Chapter 3.cbz'), true);

  const AdmZip = (await import('adm-zip')).default;
  const names = new AdmZip(join(ROOT, 'Long/Series/Chapter 3.cbz')).getEntries()
    .map((e: any) => e.entryName).filter((x: string) => x !== 'ComicInfo.xml');
  assert.deepEqual(names, [...names].sort(),
    'the retried page keeps its place: pages are held by position, not appended as they arrive');
  assert.equal(names.length, 110);
});

test('a source that is REFUSING still stops the run, however few pages it lost', async () => {
  // 403 and 429 are the source saying no. That must still end the caller's run even at 109 of 110, which is
  // the one case where a near-complete chapter is not a flaky CDN.
  serveExcept([2], 403);
  const err = await downloadChapter({
    sourceId: 'test-long', seriesFolder: 'Long/Series', chapter: chapter(4),
  }).then(() => null, (e) => e);
  assert.ok(err);
  assert.ok(err.blockStatus, 'a refusal still carries blockStatus');
});

test('a large shortfall is still the source\'s fault', async () => {
  // 17 of 20 was the original bug and must stay caught: refused, unwritten, and blamed on the source.
  serveExcept(Array.from({ length: 30 }, (_, i) => i + 80));
  const err = await downloadChapter({
    sourceId: 'test-long', seriesFolder: 'Long/Series', chapter: chapter(5),
  }).then(() => null, (e) => e);
  assert.ok(err);
  assert.match(String(err.message), /incomplete chapter: 80 of 110/);
  assert.equal(await exists('Long/Series/Chapter 5.cbz'), false);
});

test('a 429 stops the burst instead of collecting a hundred more of them', async () => {
  // Live, mangakakalot answered 429 partway through a 108-page chapter and the loop asked for every
  // remaining page anyway, so 12 arrived and 96 refusals were collected. Stopping on the first 429 turns
  // that into a pause the retry can recover from.
  let asked = 0;
  served = [];
  globalThis.fetch = (async (u: any) => {
    asked++;
    served.push(asked);
    if (asked > 10) return new Response('slow down', { status: 429, headers: { 'retry-after': '1' } });
    return new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;

  const err = await downloadChapter({
    sourceId: 'test-long', seriesFolder: 'Long/Series', chapter: chapter(6),
  }).then(() => null, (e) => e);

  assert.ok(err, 'still refused: the chapter is genuinely short');
  assert.ok(asked < 40,
    `it must stop asking once told to slow down, asked ${asked} times for a 110-page chapter`);
  assert.equal(err.blockStatus, 'rate_limited', 'and a 429 still ends the caller run, which is correct');
});

test('a rate limit that lifts is recovered by the retry', async () => {
  // The ordinary case: a burst trips the limit, we wait the Retry-After, and the rest of the chapter arrives.
  let asked = 0;
  let limited = true;
  served = [];
  globalThis.fetch = (async (u: any) => {
    asked++;
    if (limited && asked > 10) { limited = false; return new Response('slow', { status: 429, headers: { 'retry-after': '1' } }); }
    return new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;

  const res = await downloadChapter({ sourceId: 'test-long', seriesFolder: 'Long/Series', chapter: chapter(7) })
    .catch(() => null);
  assert.ok(res, 'the chapter completes once the pause is honoured');
  assert.equal(res!.pages, 110);
});
