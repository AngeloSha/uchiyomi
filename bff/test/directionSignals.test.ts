// What each piece of evidence says about which way a series reads (#102), and the two batch lookups the
// nightly repair makes. Pure: no database, and the network is a stub that records what was asked. The
// database half -- precedence, the override, every surface that reports it -- is readingDirection.int.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { directionFromComicInfo, directionFromLanguage, directionFromCountry, directionFromAniListMatch, titleKey, isReadingDirection } from '../src/lib/directionSignals';
import { mangadex, mangadexOriginalLanguages } from '../src/lib/sources/mangadex';
import { fetchAniListCountries } from '../src/lib/anilist';

const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('ComicInfo names a direction only with YesAndRightToLeft', () => {
  assert.equal(directionFromComicInfo('YesAndRightToLeft'), 'RIGHT_TO_LEFT');
  assert.equal(directionFromComicInfo(' yesandrighttoleft '), 'RIGHT_TO_LEFT');
  // `No` is what tagging tools write when nobody chose; `Yes` says manga without saying which way.
  for (const v of ['No', 'Yes', 'Unknown', '', null, undefined, 'YesAndRightToLeftish']) assert.equal(directionFromComicInfo(v as any), null, String(v));
});

test('an original language and a country of origin map the same way, and say nothing otherwise', () => {
  assert.equal(directionFromLanguage('ja'), 'RIGHT_TO_LEFT');
  for (const l of ['ko', 'zh', 'zh-hk', 'KO']) assert.equal(directionFromLanguage(l), 'WEBTOON', l);
  for (const l of ['en', 'fr', 'ja-ro', '', null]) assert.equal(directionFromLanguage(l as any), null, String(l));
  assert.equal(directionFromCountry('JP'), 'RIGHT_TO_LEFT');
  for (const c of ['KR', 'CN', 'TW', 'kr']) assert.equal(directionFromCountry(c), 'WEBTOON', c);
  for (const c of ['US', 'FR', '', null]) assert.equal(directionFromCountry(c as any), null, String(c));
  assert.ok(isReadingDirection('VERTICAL'));
  assert.ok(!isReadingDirection('rtl'));
});

test("AniList's country counts only from an entry that is visibly the series", () => {
  // What SEARCH_MATCH really answered for a series called "No Direction". Reintroduce by returning
  // directionFromCountry(match.country) unconditionally: the first assertion reads RIGHT_TO_LEFT.
  assert.equal(directionFromAniListMatch('No Direction', { country: 'JP', titles: ['Dear Green: Hitomi no Ounowa', 'ディアグリーン'] }), null);
  // Any of the entry's names will do, spelled the way people spell it.
  assert.equal(directionFromAniListMatch('Solo Leveling', { country: 'KR', titles: ['Na Honjaman Level Up', 'Solo Leveling'] }), 'WEBTOON');
  assert.equal(directionFromAniListMatch('Kaguya-sama: Love Is War', { country: 'JP', titles: ['Kaguya-sama wa Kokurasetai', 'Kaguya-sama: Love is War'] }), 'RIGHT_TO_LEFT');
  assert.equal(directionFromAniListMatch('[Oshi no Ko]', { country: 'JP', titles: ['Oshi no Ko'] }), 'RIGHT_TO_LEFT');
  assert.equal(directionFromAniListMatch('Pokémon Adventures (Remake)', { country: 'JP', titles: ['Pokemon Adventures'] }), 'RIGHT_TO_LEFT');
  // Either of the series' titles (the scanned one, the admin's) may match.
  assert.equal(directionFromAniListMatch(['Scanned Name', 'Real Name'], { country: 'JP', titles: ['real name'] }), 'RIGHT_TO_LEFT');
  // Nothing to compare is no agreement.
  assert.equal(directionFromAniListMatch('', { country: 'JP', titles: [''] }), null);
  assert.equal(directionFromAniListMatch('X', { country: 'JP', titles: [] }), null);
  assert.equal(directionFromAniListMatch('X', null), null);
  // Scripts other than Latin are kept, not stripped to nothing.
  assert.equal(titleKey('俺だけレベルアップな件'), '俺だけレベルアップな件');
});

test("MangaDex's series carries the direction its original language implies", async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const lang: Record<string, string> = { 'md-ja': 'ja', 'md-ko': 'ko', 'md-en': 'en' };
  globalThis.fetch = (async (url: any) => {
    const id = String(url).match(/\/manga\/([^?]+)/)?.[1] ?? '';
    return json({ data: { id, attributes: { title: { en: id }, originalLanguage: lang[id] } } });
  }) as typeof fetch;
  assert.equal((await mangadex.getSeries('md-ja'))?.readingDirection, 'RIGHT_TO_LEFT');
  assert.equal((await mangadex.getSeries('md-ko'))?.readingDirection, 'WEBTOON');
  assert.equal((await mangadex.getSeries('md-en'))?.readingDirection, undefined);
});

test("MangaDex's batch lookup asks 100 ids at a time, every content rating, and keeps only real answers", async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const urls: string[] = [];
  globalThis.fetch = (async (url: any) => {
    const u = new URL(String(url));
    urls.push(u.toString());
    const ids = u.searchParams.getAll('ids[]');
    return json({ data: ids.map((id, i) => ({ id, attributes: i % 2 ? {} : { originalLanguage: 'ja' } })) });
  }) as typeof fetch;
  const ids = Array.from({ length: 150 }, (_, i) => `id-${i}`);
  const out = await mangadexOriginalLanguages(ids);
  assert.equal(urls.length, 2, 'not batched by 100');
  assert.equal(new URL(urls[0]).searchParams.getAll('ids[]').length, 100);
  // An adult title in the library must still be answered for; the default filter would drop it silently.
  assert.ok(new URL(urls[0]).searchParams.getAll('contentRating[]').includes('pornographic'));
  assert.equal(out.size, 75, 'a row without an original language was kept');
  assert.equal(out.get('id-0'), 'ja');

  globalThis.fetch = (async () => json({}, 503)) as typeof fetch;
  await assert.rejects(mangadexOriginalLanguages(['x']), /mangadex 503/, 'a failure read as "no answers"');
});

test("AniList's country lookup sends the ids as integers, keeps real answers, and throws on a failure", async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const bodies: any[] = [];
  globalThis.fetch = (async (_u: any, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body));
    bodies.push(b);
    return json({ data: { Page: { media: b.variables.ids.map((id: number) => ({
      id, countryOfOrigin: id === 2 ? null : 'JP', title: { romaji: `Romaji ${id}`, english: null, native: `ネイティブ${id}` }, synonyms: [`Syn ${id}`],
    })) } } });
  }) as typeof fetch;
  const out = await fetchAniListCountries([1, 2, 3]);
  assert.equal(bodies.length, 1);
  assert.match(bodies[0].query, /id_in:\$ids/);
  assert.match(bodies[0].query, /synonyms/, 'the titles the agreement check needs were not asked for');
  assert.deepEqual(bodies[0].variables.ids, [1, 2, 3]);
  assert.deepEqual([...out.keys()], [1, 3]);
  assert.deepEqual(out.get(1), { country: 'JP', titles: ['Romaji 1', 'ネイティブ1', 'Syn 1'] });

  globalThis.fetch = (async () => json({}, 500)) as typeof fetch;
  await assert.rejects(fetchAniListCountries([1]), /anilist 500/);
});
