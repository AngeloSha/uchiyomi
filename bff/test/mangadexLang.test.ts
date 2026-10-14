// MangaDex in one language is that language, and nothing else.
//
// A title with no English chapters used to be empty to English MangaDex, and the fix then was a fallback:
// English asked Spanish, Portuguese, French, Russian and Indonesian in turn and kept the first that answered. That
// was how a server set to English only downloaded a Spanish series with nothing on screen to say why (reported in
// v0.61.2). v0.52.0 (#123) made every other language an adapter of its own, so the fallback had nothing left to do
// but that: since v0.62.0 English asks for English alone, in its chapter lists and in its search, and a Spanish-only
// title is added from MangaDex (ES-419).
//
// The rest pins what the feed carries per row: the scanlation groups, expanded by `includes[]=scanlation_group`, and
// every release of a number, and a row's language in the app's code ("es-419", never MangaDex's "es-la").
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mangadex, makeMangadex, _setMangadexPacing, _resetMangadexLimiter } from '../src/lib/sources/mangadex';

const realFetch = globalThis.fetch;

interface Row { n: number; pages?: number; groups?: string[]; relationships?: unknown[] }

/**
 * Serve a chapter feed only for the languages named, and record every language actually asked for, plus
 * every URL. `groups` becomes expanded scanlation_group relationships (what `includes[]` returns); a raw
 * `relationships` array is passed through as-is for the shapes the include does NOT produce.
 */
function stubFeed(byLang: Record<string, Row[]>, urls: string[] = []) {
  const asked: string[] = [];
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    urls.push(u);
    const lang = new URL(u).searchParams.get('translatedLanguage[]') ?? '';
    if (!asked.includes(lang)) asked.push(lang);
    const rows = byLang[lang] ?? [];
    return new Response(JSON.stringify({
      total: rows.length,
      data: rows.map((r, i) => ({
        id: `${lang}-ch-${r.n}-${i}`,
        attributes: { chapter: String(r.n), translatedLanguage: lang, pages: r.pages ?? 10, publishAt: '2026-01-01T00:00:00Z' },
        relationships: r.relationships ?? [
          { id: 'user-1', type: 'user' },
          ...(r.groups ?? []).map((g, k) => ({ id: `grp-${k}`, type: 'scanlation_group', attributes: { name: g } })),
        ],
      })),
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return asked;
}

// The shared limiter's spacing is not what these pin: no gap between requests.
before(() => _setMangadexPacing({ apiGapMs: 0, atHomeGapMs: 0 }));
after(() => _setMangadexPacing(null));
test.afterEach(() => { globalThis.fetch = realFetch; _resetMangadexLimiter(); });

test('English asks for English, and one request is all a title with English chapters costs', async () => {
  const asked = stubFeed({ en: [{ n: 1 }, { n: 2 }], 'es-la': [{ n: 1 }] });
  const out = await mangadex.listChapters!('series-1');
  assert.deepEqual(out.map((c) => c.number), [1, 2]);
  assert.ok(out.every((c) => c.lang === 'en'), 'English chapters expected');
  assert.deepEqual(asked, ['en'], 'a title with English chapters must cost exactly one language request');
});

test('THE BUG: English never answers in another language, so English only stays English', async () => {
  // Reintroduce the fallback chain (en, es-la, es, pt-br, fr, ru, id until one answers): this returns the Spanish
  // chapters, and a server set to English only downloads them.
  const asked = stubFeed({ 'es-la': [{ n: 1 }, { n: 2 }, { n: 3 }], 'pt-br': [{ n: 7 }] });
  const out = await mangadex.listChapters!('series-2');
  assert.deepEqual(out, [], 'a title with no English chapters has none in English');
  assert.deepEqual(asked, ['en'], 'asks en and nothing else');
});

test("English search finds only titles with English chapters", async () => {
  // A hit English cannot serve is a series added with no chapters. Reintroduce the unfiltered English search
  // (`english ? '' : ...`): the URL carries no availableTranslatedLanguage and this fails.
  const urls: string[] = [];
  globalThis.fetch = (async (url: any) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  await mangadex.search('solo leveling');
  const asked = urls.filter((u) => new URL(u).pathname.endsWith('/manga'));
  assert.equal(asked.length, 1);
  assert.deepEqual(new URL(asked[0]).searchParams.getAll('availableTranslatedLanguage[]'), ['en']);
});

test('MangaDex in another language asks for that language alone, and never falls back to English', async () => {
  // Reintroduce by giving every adapter a fallback chain that starts at English: MangaDex (ES-419) answers with the
  // English chapters, and "asks es-la and nothing else" fails.
  const asked = stubFeed({ en: [{ n: 1 }, { n: 2 }], 'es-la': [] });
  const es = makeMangadex('es-419');
  assert.deepEqual(await es.listChapters('series-es'), [], 'a title with no Spanish chapters has none in Spanish');
  assert.deepEqual(asked, ['es-la'], 'asks es-la and nothing else');
  // And when it has them, they are its own, in the app's code.
  const asked2 = stubFeed({ en: [{ n: 1 }], 'es-la': [{ n: 1 }, { n: 2 }] });
  const out = await es.listChapters('series-es');
  assert.deepEqual(out.map((c) => [c.number, c.lang]), [[1, 'es-419'], [2, 'es-419']]);
  assert.deepEqual(asked2, ['es-la']);
});

test('a chapter with a non-numeric number is skipped, not NaN-sorted', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    total: 2,
    data: [
      { id: 'a', attributes: { chapter: 'oneshot', translatedLanguage: 'en', pages: 5 } },
      { id: 'b', attributes: { chapter: '4', translatedLanguage: 'en', pages: 5 } },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  const out = await mangadex.listChapters!('series-6');
  assert.deepEqual(out.map((c) => c.number), [4]);
});

test('the feed asks for scanlation groups, and each row says who released it', async () => {
  // Without `includes[]=scanlation_group` a relationship is a bare {id,type} and the name is a second
  // request per group. Reintroduce by dropping the parameter from the feed URL: the URL assertion fails.
  const urls: string[] = [];
  stubFeed({ en: [{ n: 1, groups: ['Alpha Scans'] }, { n: 2 }] }, urls);
  const out = await mangadex.listChapters!('series-7');
  assert.ok(urls.length >= 1);
  for (const u of urls) {
    assert.ok(new URL(u).searchParams.getAll('includes[]').includes('scanlation_group'), `feed URL must include scanlation_group: ${u}`);
  }
  assert.deepEqual(out.map((c) => c.number), [1, 2]);
  // Reintroduce by not reading relationships in feedFor: both fields read undefined on chapter 1.
  assert.deepEqual(out[0].groups, ['Alpha Scans']);
  assert.equal(out[0].scanlator, 'Alpha Scans');
  // No group attached means no group known -- absent, never [] or '' -- because the chooser never blocks
  // a copy with no groups but would try to match one against an empty name.
  assert.equal(out[1].groups, undefined);
  assert.equal(out[1].scanlator, undefined);
});

test('a joint release keeps its groups apart and joins them for display', async () => {
  // MangaDex is the one source that lists groups structurally, so `groups` carries them one per entry
  // and `scanlator` is the ' & ' spelling Mihon and the ComicInfo Translator tag use. Reintroduce by
  // joining with ', ' instead: the scanlator assertion fails.
  stubFeed({ en: [{ n: 5, groups: ['Alpha Scans', 'Beta TL'] }] });
  const [c] = await mangadex.listChapters!('series-8');
  assert.deepEqual(c.groups, ['Alpha Scans', 'Beta TL']);
  assert.equal(c.scanlator, 'Alpha Scans & Beta TL');
});

test('a relationship without attributes, or of another type, names no group', async () => {
  // The shape the API returns when the include is missing (bare {id,type}), and an unrelated type that
  // happens to carry a name: neither is a group name. Reintroduce by mapping every relationship's
  // attributes.name regardless of type: chapter 1 reads a group called 'Someone'.
  stubFeed({ en: [
    { n: 1, relationships: [{ id: 'u', type: 'user', attributes: { name: 'Someone' } }, { id: 'g', type: 'scanlation_group' }] },
    { n: 2, relationships: [{ id: 'g', type: 'scanlation_group', attributes: { name: '   ' } }] },
  ] });
  const out = await mangadex.listChapters!('series-9');
  assert.equal(out[0].groups, undefined);
  assert.equal(out[0].scanlator, undefined);
  assert.equal(out[1].groups, undefined, 'a blank name is not a group');
});

test('two releases of one number both come back, hosted or not, ascending', async () => {
  // The adapter used to keep one row per number -- a hosted copy over an external one, else the first
  // seen -- which threw away the second group's release before anyone could prefer it. That choice now
  // lives in lib/releases.ts, which has `pages` on the row for the hosted-beats-external tie-break.
  // Reintroduce by restoring the byNum collapse in feedFor: the length drops from 5 to 3 and 'Beta TL'
  // is nowhere in the result.
  stubFeed({ en: [
    { n: 2, groups: ['Alpha Scans'] },
    { n: 1, pages: 0, groups: ['Publisher'] },
    { n: 1, groups: ['Beta TL'] },
    { n: 2, groups: ['Beta TL'] },
    { n: 3 },
  ] });
  const out = await mangadex.listChapters!('series-10');
  assert.equal(out.length, 5);
  assert.deepEqual(out.map((c) => c.number), [1, 1, 2, 2, 3]);
  assert.ok(out.some((c) => c.scanlator === 'Beta TL' && c.number === 2), 'the second group\'s release of chapter 2 is reported');
  assert.ok(out.some((c) => c.pages === 0 && c.number === 1), 'the external copy is reported too; hosted-vs-external is the chooser\'s tie-break');
  // Stable within a number: the feed's own order, so the chooser's final tie-break (input order) is the
  // source's order, not the adapter's.
  assert.deepEqual(out.filter((c) => c.number === 1).map((c) => c.scanlator), ['Publisher', 'Beta TL']);
});
