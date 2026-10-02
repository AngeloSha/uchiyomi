// A source that asks its API for one language has to say so -- and has to ask for exactly that one.
//
// Discover groups sources by the language they declare, and a source that declares none joins EVERY group —
// deliberately, because a genuinely multi-language source belongs in all of them. MangaDex declared none and was
// not multi-language in practice: its requests pinned `en` and nothing else. So picking the Japanese chip produced
// a wall of one Japanese source, four universals, and English-only MangaDex, which is precisely the "says
// Japanese, serves English" that got reported.
//
// v0.52.0 (#123): MangaDex is one adapter per language. This drives every one of them through every method that
// asks for a language and reads what was actually sent, rather than the source text: each request pins exactly
// that adapter's MangaDex code, and the adapter declares the app's code for it. English search is the one request
// with no language at all -- it finds every title, as it always did, because English's chapter list falls back to
// the other languages.
import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MANGADEX_LANGS } from '../src/lib/lang';
import { MANGADEX_GROUP, makeMangadex, mangadex, _setMangadexPacing, _resetMangadexLimiter } from '../src/lib/sources/mangadex';

const realFetch = globalThis.fetch;
/** The two ways a MangaDex request names a language: a chapter's, and a title's chapters'. */
const LANG_PARAMS = ['translatedLanguage[]', 'availableTranslatedLanguage[]'];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** Record every URL asked, answering with one title and one chapter so each method runs to its last request. */
function record(): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    urls.push(String(input));
    const u = new URL(String(input));
    const manga = { id: 'm-1', type: 'manga', attributes: { title: { en: 'T' } }, relationships: [] };
    if (u.pathname === '/chapter') {
      return json({ data: [{ id: 'c-1', attributes: { readableAt: '2026-10-01T00:00:00Z' }, relationships: [{ id: 'm-1', type: 'manga' }] }] });
    }
    if (u.pathname.endsWith('/feed')) return json({ total: 1, data: [{ id: 'c-1', attributes: { chapter: '1', pages: 3 } }] });
    return json({ data: [manga] });
  }) as typeof fetch;
  return urls;
}

// The shared limiter's spacing is not what this pins; with no gap, 26 languages cost no time.
before(() => _setMangadexPacing({ apiGapMs: 0, atHomeGapMs: 0 }));
after(() => _setMangadexPacing(null));
afterEach(() => { globalThis.fetch = realFetch; _resetMangadexLimiter(); });

test('every MangaDex adapter asks for exactly its own language, and declares it', async () => {
  // Reintroduce by hardcoding `en` in any request builder -- `availableTranslatedLanguage[]=en` in popular(), say:
  // "MangaDex (ES-419) popular asked en" fails. Declare `lang: 'en'` for every adapter: "declares en" fails.
  assert.equal(MANGADEX_LANGS.length, 26);
  for (const { code, md } of MANGADEX_LANGS) {
    const a = makeMangadex(code);
    assert.equal(a.lang, code, `${a.name} declares ${a.lang}`);
    const methods: Array<[string, () => Promise<unknown>]> = [
      ['search', () => a.search('x')],
      ['latest', () => a.latest!(1)],
      ['popular', () => a.popular!(1)],
      ['chapters', () => a.listChapters('m-1')],
    ];
    for (const [what, run] of methods) {
      const urls = record();
      await run();
      const pinned = [...new Set(urls.flatMap((u) => LANG_PARAMS.flatMap((p) => new URL(u).searchParams.getAll(p))))];
      if (code === 'en' && what === 'search') {
        assert.deepEqual(pinned, [], 'English search must find titles in every language, as it always did');
        continue;
      }
      assert.deepEqual(pinned, [md], `${a.name} ${what} asked ${pinned.join(', ') || 'no language'}`);
    }
  }
});

test('English is the MangaDex it always was; every other language is a source of its own in one rate group', async () => {
  // Reintroduce by naming English like the others ("MangaDex (EN)", `mangadex-en`): every series added from it
  // would point at a source id nothing registers.
  assert.equal(mangadex.id, 'mangadex');
  assert.equal(mangadex.name, 'MangaDex');
  assert.equal(mangadex.lang, 'en');
  const es = makeMangadex('es-419');
  assert.deepEqual([es.id, es.name, es.lang], ['mangadex-es-419', 'MangaDex (ES-419)', 'es-419']);
  const zh = makeMangadex('zh-Hant');
  assert.deepEqual([zh.id, zh.name], ['mangadex-zh-hant', 'MangaDex (ZH-HANT)']);
  // MangaDex's own spelling is read as the app's: es-la is es-419.
  assert.equal(makeMangadex('es-la').id, 'mangadex-es-419');
  for (const a of [mangadex, es, zh]) assert.equal(a.rateGroup, MANGADEX_GROUP, `${a.name} is outside the shared rate limit`);
  assert.throws(() => makeMangadex('xx'), /not offered/);
  assert.throws(() => makeMangadex('all'), /not offered/);

  // English search, byte for byte as before v0.52.0.
  const urls = record();
  await mangadex.search('solo leveling');
  assert.deepEqual(urls, [
    'https://api.mangadex.org/manga?title=solo%20leveling&limit=12&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica&includes[]=cover_art&includes[]=author&order[relevance]=desc',
  ]);
  // A hit names the adapter it came from, so it is added from that language.
  const hits = await es.search('x');
  assert.equal(hits[0].source, 'mangadex-es-419');
});
