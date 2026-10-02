// MangaDex's Newest, per language (v0.52.0, #123).
//
// Newest ordered /manga by `latestUploadedChapter`, which counts a chapter in ANY language: a title whose last
// English chapter was a year old headed English Newest the day an Indonesian group uploaded one, and with an adapter
// per language every language's Newest would have been the same list. Newest now reads the chapter list in the
// adapter's language, newest first, and asks for those chapters' series in one more request: two a page.
import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeMangadex, mangadex, _setMangadexPacing, _resetMangadexLimiter } from '../src/lib/sources/mangadex';

const realFetch = globalThis.fetch;
before(() => _setMangadexPacing({ apiGapMs: 0 }));
after(() => _setMangadexPacing(null));
afterEach(() => { globalThis.fetch = realFetch; _resetMangadexLimiter(); });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
/** One row of the chapter list: a chapter of `manga`, readable from `at`. */
const ch = (id: string, manga: string, at: string) =>
  ({ id, type: 'chapter', attributes: { readableAt: at }, relationships: [{ id: 'g', type: 'scanlation_group' }, { id: manga, type: 'manga' }] });
const title = (id: string) => ({ id, type: 'manga', attributes: { title: { en: id.toUpperCase() }, updatedAt: '2020-01-01T00:00:00Z' }, relationships: [] });

/** Serve `feed` as the chapter list and every title asked for, in an order of MangaDex's own (reversed). */
function serve(feed: unknown[]): URL[] {
  const urls: URL[] = [];
  globalThis.fetch = (async (input: any) => {
    const u = new URL(String(input));
    urls.push(u);
    if (u.pathname === '/chapter') return json({ data: feed });
    return json({ data: u.searchParams.getAll('ids[]').reverse().map(title) });
  }) as typeof fetch;
  return urls;
}

test("Newest is the language's chapter list, newest first, then those series in feed order, each once", async () => {
  // Reintroduce the old query (/manga?order[latestUploadedChapter]=desc&availableTranslatedLanguage[]=…): the first
  // request is not /chapter, and "never sends latestUploadedChapter" fails with it.
  const urls = serve([
    ch('c1', 'm-b', '2026-10-02T10:00:00Z'), ch('c2', 'm-a', '2026-10-02T09:00:00Z'),
    ch('c3', 'm-b', '2026-10-02T08:00:00Z'), ch('c4', 'm-c', '2026-10-01T00:00:00Z'),
  ]);
  const out = await makeMangadex('es-419').latest!(2);
  assert.equal(urls.length, 2, 'two requests a page');
  const [feed, titles] = urls;
  assert.equal(feed.pathname, '/chapter');
  assert.equal(feed.searchParams.get('translatedLanguage[]'), 'es-la');
  assert.equal(feed.searchParams.get('order[readableAt]'), 'desc');
  assert.equal(feed.searchParams.get('limit'), '100');
  assert.equal(feed.searchParams.get('offset'), '100', 'page 2 starts a hundred chapters in');
  for (const k of ['includeExternalUrl', 'includeFuturePublishAt', 'includeEmptyPages']) assert.equal(feed.searchParams.get(k), '0', k);
  assert.deepEqual(feed.searchParams.getAll('contentRating[]'), ['safe', 'suggestive', 'erotica']);
  assert.equal(titles.pathname, '/manga');
  assert.deepEqual(titles.searchParams.getAll('ids[]'), ['m-b', 'm-a', 'm-c'], 'each series once, in feed order');
  assert.deepEqual(titles.searchParams.getAll('includes[]'), ['cover_art', 'author']);
  assert.deepEqual(out.map((s) => s.sourceId), ['m-b', 'm-a', 'm-c'], 'in feed order, not in the order MangaDex listed the titles');
  assert.equal(out[0].updatedAt, '2026-10-02T10:00:00Z', "a series' time is its newest chapter's, not the title's own updatedAt");
  assert.equal(out[0].source, 'mangadex-es-419');
  for (const u of urls) assert.ok(!u.search.includes('latestUploadedChapter'), 'never sends latestUploadedChapter');
});

test('a page shows at most 24 series, English Newest is English chapters, and nothing is asked past the window', async () => {
  // Forty series on one page of the feed: the first 24 are the page.
  const urls = serve(Array.from({ length: 40 }, (_, i) => ch(`c${i}`, `m-${i}`, '2026-10-02T00:00:00Z')));
  const out = await mangadex.latest!(1);
  assert.equal(urls[0].searchParams.get('translatedLanguage[]'), 'en', 'English Newest counts English chapters only');
  assert.equal(urls[0].searchParams.get('offset'), '0');
  assert.equal(urls[1].searchParams.getAll('ids[]').length, 24);
  assert.equal(out.length, 24);
  // MangaDex refuses offset + limit past 10,000; page 101 would be exactly that.
  urls.length = 0;
  assert.deepEqual(await mangadex.latest!(101), []);
  assert.equal(urls.length, 0, 'asked for a page MangaDex refuses');
  // A feed with nothing in it is one request, not two.
  const none = serve([]);
  assert.deepEqual(await makeMangadex('fr').latest!(1), []);
  assert.equal(none.length, 1);
});
