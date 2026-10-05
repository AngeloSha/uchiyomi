// MangaDex says how it rates each title, and its search results carry it (v0.55.4, #158).
//
// Discover's search filters 18+ results (lib/searchAll.ts ratingOf), and MangaDex is the one source that rates every
// title: search asks for safe, suggestive and erotica alike, and `toSeries` dropped `contentRating`, so an erotica title
// read like any other. Now it rides on the result; a value MangaDex does not define is left off rather than passed on.
import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mangadex, makeMangadex, _setMangadexPacing, _resetMangadexLimiter } from '../src/lib/sources/mangadex';

const realFetch = globalThis.fetch;
before(() => _setMangadexPacing({ apiGapMs: 0 }));
after(() => _setMangadexPacing(null));
afterEach(() => { globalThis.fetch = realFetch; _resetMangadexLimiter(); });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const title = (id: string, contentRating?: unknown) =>
  ({ id, type: 'manga', attributes: { title: { en: id.toUpperCase() }, ...(contentRating === undefined ? {} : { contentRating }) }, relationships: [] });

test("a search result carries MangaDex's content rating, and only one MangaDex defines", async () => {
  // Reintroduce by dropping the field from toSeries: every rating reads undefined.
  const urls: URL[] = [];
  globalThis.fetch = (async (input: any) => {
    urls.push(new URL(String(input)));
    return json({ data: [title('m-ero', 'erotica'), title('m-porn', 'pornographic'), title('m-safe', 'safe'), title('m-sugg', 'suggestive'), title('m-odd', 'gore'), title('m-none')] });
  }) as typeof fetch;
  const out = await mangadex.search('anything');
  assert.deepEqual(out.map((s) => [s.sourceId, s.contentRating]), [
    ['m-ero', 'erotica'], ['m-porn', 'pornographic'], ['m-safe', 'safe'], ['m-sugg', 'suggestive'], ['m-odd', undefined], ['m-none', undefined],
  ], "a search result carries MangaDex's content rating");
  assert.equal('contentRating' in out[5], false, 'absent, not undefined, when MangaDex says nothing');
  // What search asks for is unchanged: erotica is found, and the filter decides what is shown.
  assert.deepEqual(urls[0].searchParams.getAll('contentRating[]'), ['safe', 'suggestive', 'erotica']);
  // Every language's adapter maps it the same way.
  globalThis.fetch = (async () => json({ data: [title('m-es', 'erotica')] })) as typeof fetch;
  assert.equal((await makeMangadex('es-419').search('x'))[0].contentRating, 'erotica');
});
