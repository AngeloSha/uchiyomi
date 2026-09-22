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
import { join } from 'path'; import { clearPace } from '../src/lib/pace'; // pace.ts reads no env, so it may load before the env below

// Set before the module graph loads: DL_ROOT is read once, at import, and the downloader writes real files.
const ROOT = mkdtempSync(join(tmpdir(), 'uy-dl-'));
process.env.DL_ROOT = ROOT;
// Pacing is production politeness, not the subject here, and 110 pages x 250ms would add half a minute to
// every test in this file. downloadPacing.int.test.ts is where the delay itself is pinned.
process.env.DOWNLOAD_PAGE_GAP_MS = '0';
process.env.DOWNLOAD_MIN_GAP_MS ||= '0'; process.env.DOWNLOAD_RESUME_WAIT_MS = '0,0,0'; // resumes wait only Retry-After here; pacePersists.test.ts pins the wait
process.env.MIN_FREE_GB = '0'; // the disk floor is not the subject here; diskGuard.test.ts is
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
beforeEach(() => { served = []; clearPace(); }); // a 429 in one test must not slow the next test's source
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

test('a stale declared count cannot hide a failed URL returned by the source', async () => {
  // Five URLs came back while the listing still says four. The old `expected = chapter.pages` path packed
  // the first four as complete and left the failed fifth page unmarked forever.
  serve(4);
  await assert.rejects(
    downloadChapter({ sourceId: 'test-partial', seriesFolder: 'T/StaleCount', chapter: chapter(14, 4) } as any),
    /incomplete chapter: 4 of 5 pages/,
  );
  assert.equal(await exists('T/StaleCount/Chapter 14.cbz'), false, 'a URL the source returned was silently discarded');
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

test('the CBZ names the releasing group in ComicInfo, and says nothing when the source named nobody', async () => {
  // <Translator> is the ComicInfo v2.1 tag Mihon and Suwayomi write and Komga and Kavita read, so the
  // provenance travels with the file, not only in lib_books. The ampersand is the joint-release spelling
  // and has to survive XML escaping.
  //
  // Reintroduce by dropping `scanlator: input.chapter.scanlator` from the comicInfo() call in
  // lib/downloader.ts: "ComicInfo carries the group" fails, the tag is absent.
  const AdmZip = (await import('adm-zip')).default;
  const xmlOf = (rel: string) =>
    new AdmZip(join(ROOT, rel)).getEntry('ComicInfo.xml')!.getData().toString('utf8');

  serve(5);
  await downloadChapter({
    sourceId: 'test-partial', seriesFolder: 'T/Credited', chapter: { ...chapter(1), scanlator: 'Alpha & Beta' },
  } as any);
  assert.match(xmlOf('T/Credited/Chapter 1.cbz'), /<Translator>Alpha &amp; Beta<\/Translator>/, 'ComicInfo carries the group');

  serve(5);
  await downloadChapter({ sourceId: 'test-partial', seriesFolder: 'T/Credited', chapter: chapter(2) } as any);
  assert.doesNotMatch(xmlOf('T/Credited/Chapter 2.cbz'), /<Translator>/, 'no tag at all when nobody was named');
});

// ── v0.40.0: the evidence on the error, and the partial hold ──────────────────────────────────────────
//
// The truncation guard above stays exactly as it is: downloadChapter alone still never writes a short
// chapter. What changed is what the caller is HANDED when it refuses: which pages failed and how, and --
// when enough of the chapter arrived and the site did not say no -- a hold it can choose to write, with a
// placeholder at every missing index, once every other source has failed too (lib/chapterFallback.ts).

test('a shortfall names the pages that failed and what the site answered for each', async () => {
  // "109 of 110 pages" said nothing about which page or why, and a 404, an 88-byte body and a timeout have
  // three different fixes. Reintroduce by dropping `failedPages` from the thrown object in fetchChapter:
  // the deepEqual below reads undefined.
  serve(4); // page 5 (index 4) answers 503, on both passes
  const err = await downloadChapter({ sourceId: 'test-partial', seriesFolder: 'T/Evidence', chapter: chapter(8) } as any)
    .then(() => null, (e) => e);
  assert.ok(err);
  assert.deepEqual(err.failedPages, [{ index: 4, status: 503 }], 'the one failed page, 0-based, with its status');

  const { reasonOf } = await import('../src/lib/chapterFailures');
  assert.equal(reasonOf(err), 'incomplete chapter: 4 of 5 pages (page 5: 503)', 'the ledger shows it 1-based');
});

test('four pages of five is offered as a hold, and the hold is not a file until write() is called', async () => {
  // Reintroduce by dropping the `partial ? { partial } : {}` spread from the throw in fetchChapter: the
  // `typeof err.partial` assertion reads 'undefined' and nothing downstream can ever save a partial.
  serve(4);
  const err = await downloadChapter({ sourceId: 'test-partial', seriesFolder: 'T/Hold', chapter: chapter(9) } as any)
    .then(() => null, (e) => e);
  assert.ok(err);
  assert.match(String(err.message), /incomplete chapter: 4 of 5 pages/, 'still refused: the guard above is untouched');
  assert.equal(typeof err.partial, 'object', 'a hold rides on the error');
  assert.deepEqual(err.partial.missing, [4], '0-based: the fifth page is the placeholder');
  assert.equal(err.partial.expected, 5);
  assert.equal(err.partial.pages, 4, 'four real pages held');
  assert.equal(await exists('T/Hold/Chapter 9.cbz'), false, 'downloadChapter alone still writes nothing');

  const written = await err.partial.write();
  assert.deepEqual(written, { file: 'T/Hold/Chapter 9.cbz', pages: 5, missing: [4] });
  assert.equal(await exists('T/Hold/Chapter 9.cbz'), true);

  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip(join(ROOT, 'T/Hold/Chapter 9.cbz'));
  const names = zip.getEntries().map((e: any) => e.entryName).sort();
  assert.deepEqual(names, ['0001.png', '0002.png', '0003.png', '0004.png', '0005.png', 'ComicInfo.xml', 'uchiyomi-partial.json'],
    'five page entries by INDEX, a placeholder in the fifth slot, the manifest, and the ComicInfo');
  // The placeholder is a real image the reader can show. The fixture pages are not decodable, so the
  // nearest-page measurement falls back to the default size.
  const sharp = (await import('sharp')).default;
  const m = await sharp(zip.getEntry('0005.png')!.getData()).metadata();
  assert.equal(`${m.width}x${m.height}`, '800x1200', 'the placeholder decodes, at the fallback size');
  const manifest = JSON.parse(zip.getEntry('uchiyomi-partial.json')!.getData().toString('utf8'));
  assert.deepEqual(
    { ...manifest, writtenAt: typeof manifest.writtenAt },
    { version: 1, source: 'test-partial', chapterSourceId: 'c9', expected: 5, missing: [4], placeholder: { width: 800, height: 1200 }, writtenAt: 'string' },
    'the manifest says which indices are placeholders and where the real pages came from -- and carries no page URLs',
  );
  assert.ok(!JSON.stringify(manifest).includes('example.invalid'), 'no page URL leaks into an exported file');
  const { readPartialManifest } = await import('../src/lib/partial');
  assert.deepEqual((await readPartialManifest(join(ROOT, 'T/Hold/Chapter 9.cbz')))?.missing, [4], 'and the reader helper finds it');

  // write() is once: a second call returns the first result rather than writing the file again.
  assert.equal(await err.partial.write(), written, 'the same result object: written once');
});

test('THE COOLDOWN case is worth keeping: 109 of 110 carries a hold', async () => {
  // The live ledger was 153 rows of exactly this shape. Reintroduce by raising PARTIAL_CHAPTER_FLOOR's
  // default above 0.99: the hold disappears from the one case it exists for.
  serveExcept([7]);
  const err = await downloadChapter({ sourceId: 'test-long', seriesFolder: 'Long/Series', chapter: chapter(10) })
    .then(() => null, (e) => e);
  assert.ok(err);
  assert.equal(err.blockStatus, undefined, 'still no cooldown for one flaky page');
  assert.equal(typeof err.partial, 'object');
  assert.deepEqual(err.partial.missing, [7]);
  assert.deepEqual(err.failedPages, [{ index: 7, status: 503 }]);
  assert.equal(await exists('Long/Series/Chapter 10.cbz'), false, 'offered, not written');
});

test('never a hold on a refusal: a 403 or a 429 gets no partial however many pages arrived', async () => {
  // 403 and 429 are the site saying no. A file written on a refusal is a chapter the site will never be
  // asked to finish, and the cooldown -- not a file with holes in it -- is the answer to a refusal.
  // Reintroduce by dropping `!refusing &&` from the hold condition in fetchChapter: the 403 case, at 109
  // of 110, is over the floor and the `no hold on a 403` assertion reads 'object'.
  serveExcept([2], 403);
  const forbidden = await downloadChapter({ sourceId: 'test-long', seriesFolder: 'Long/Series', chapter: chapter(11) })
    .then(() => null, (e) => e);
  assert.ok(forbidden?.blockStatus, 'a refusal still carries blockStatus');
  assert.equal(forbidden.partial, undefined, 'no hold on a 403');
  assert.deepEqual(forbidden.failedPages, [{ index: 2, status: 403 }]);

  // A limit that never lifts, after 100 of 110 pages: over the floor, and still no hold.
  let asked = 0;
  served = [];
  globalThis.fetch = (async () => {
    asked++;
    if (asked > 100) return new Response('slow down', { status: 429, headers: { 'retry-after': '1' } });
    return new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;
  const limited = await downloadChapter({ sourceId: 'test-long', seriesFolder: 'Long/Series', chapter: chapter(12) })
    .then(() => null, (e) => e);
  assert.equal(limited?.blockStatus, 'rate_limited');
  assert.ok(limited.pages >= 100, `over the floor (${limited.pages} of 110)`);
  assert.equal(limited.partial, undefined, 'no hold on a 429');
  assert.equal(await exists('Long/Series/Chapter 12.cbz'), false);
});

test('a larger HTTP error cannot mask a refusal on another page', async () => {
  // Numeric `worst` is 503, but policy is not numeric: the 403 still means stop, cool down, and never write
  // a partial. Reintroduce by deriving `refusing` only from `worst` and this offers a 108/110 hold.
  globalThis.fetch = (async (u: any) => {
    const i = Number(String(u).match(/p(\d+)\.png$/)?.[1] ?? -1);
    if (i === 2) return new Response('forbidden', { status: 403 });
    if (i === 3) return new Response('down', { status: 503 });
    return new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;
  const err = await downloadChapter({ sourceId: 'test-long', seriesFolder: 'Long/Mixed', chapter: chapter(15) })
    .then(() => null, (e) => e);
  assert.equal(err?.worst, 503, 'the evidence still keeps the numerically largest status');
  assert.equal(err?.blockStatus, 'blocked', 'the independent refusal controls policy');
  assert.equal(err?.partial, undefined, 'a mixed-status refusal must never produce a hold');
  assert.equal(await exists('Long/Mixed/Chapter 15.cbz'), false);
});

test('the placeholder takes the size of the nearest real page', async () => {
  // A long strip keeps its width so the vertical reader's layout does not jump at the hole. Reintroduce by
  // returning `{ width: 800, height: 1200 }` unconditionally in holdFor: the placeholder is 800 wide.
  const sharp = (await import('sharp')).default;
  const wide = await sharp({ create: { width: 640, height: 300, channels: 3, background: '#ffffff' } }).png().toBuffer();
  served = [];
  globalThis.fetch = (async (u: any) => {
    if (String(u).endsWith('/c.png')) return new Response('nope', { status: 404 });
    return new Response(wide, { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;
  const err = await downloadChapter({ sourceId: 'test-partial', seriesFolder: 'T/Sized', chapter: chapter(13) } as any)
    .then(() => null, (e) => e);
  assert.deepEqual(err?.partial?.missing, [2]);
  assert.deepEqual(err.failedPages, [{ index: 2, status: 404 }]);
  await err.partial.write();
  const AdmZip = (await import('adm-zip')).default;
  const ph = new AdmZip(join(ROOT, 'T/Sized/Chapter 13.cbz')).getEntry('0003.png')!.getData();
  const m = await sharp(ph).metadata();
  assert.equal(`${m.width}x${m.height}`, '640x300', 'measured from the page beside it');
});
