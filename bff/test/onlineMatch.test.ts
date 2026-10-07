// The one title check for an online match (v0.55.7, #168): lib/onlineMatch.ts, and the lookups that apply it as they
// ask -- AniList's art search, its anime search, Kitsu's banner, and the by-id lookups the recheck uses
// (lib/matchCheck.ts). Pure: no database, and the network is a stub that answers like the services do. The stored half
// -- the art routes, the add, the backfill, the recheck, Health -- is onlineMatch.int.test.ts and matchCheck.int.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { namesMatch, titleKey, aniListMediaOf, mangaDexIdOf } from '../src/lib/onlineMatch';
import { fetchAniListArt, fetchAnimeBanner, fetchAniListEntries } from '../src/lib/anilist';
import { fetchKitsuBanner } from '../src/lib/kitsu';
import { mangadexTitles, _setMangadexPacing, _resetMangadexLimiter } from '../src/lib/sources/mangadex';

const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('an entry is the series only when one of its names IS one of the series\' names, folded', () => {
  // Any of the entry's names, against any of the series' -- its title, an admin's, its other names.
  assert.ok(namesMatch(['Seoul Station Druid'], ['Seoul-yeok Druid', 'The Druid of Seoul Station', 'Seoul Station Druid']));
  assert.ok(namesMatch(['Scanned Name', 'The Druid of Seoul Station'], ['the druid of seoul station']), 'an other name of the series');
  // Case, accents, punctuation and bracketed asides are set aside; any script is kept.
  assert.ok(namesMatch('Pokémon Adventures (Remake)', ['Pokemon Adventures']));
  assert.ok(namesMatch('[Oshi no Ko]', ['Oshi no Ko']));
  assert.ok(namesMatch('Kaguya-sama: Love Is War', ['Kaguya-sama: Love is War']));
  assert.ok(namesMatch(['나 혼자만 레벨업'], ['Na Honjaman Level Up', '나 혼자만 레벨업']), 'a Korean title is compared as Korean');
  assert.equal(titleKey('俺だけレベルアップな件'), '俺だけレベルアップな件');
  // What SEARCH_MATCH really answered: another work entirely.
  assert.ok(!namesMatch('No Direction', ['Dear Green: Hitomi no Ounowa', 'ディアグリーン']));
  assert.ok(!namesMatch('Boundless Necromancer', ['Boundless Ascension', 'Wujin Shengtian']));
  // Nothing to compare is no agreement, either way round.
  assert.ok(!namesMatch('', ['']));
  assert.ok(!namesMatch(['(2016)'], ['2016']), 'a name that folds to nothing matches nothing');
  assert.ok(!namesMatch('X', []));
  assert.ok(!namesMatch('X', null));
  assert.ok(!namesMatch([], ['X']));
});

test('a spin-off is not the work: containment never matches, either way round', () => {
  // Kedryn's comics (#168): "Morgan Lost" and the series beside it are different works; so are a sequel and its parent.
  // Reintroduce containment (`k.includes(w) || w.includes(k)` in namesMatch): the first assertion accepts it.
  assert.ok(!namesMatch('Morgan Lost', ['Morgan Lost: Dark Novels']), 'a spin-off is not the work');
  assert.ok(!namesMatch('Morgan Lost: Dark Novels', ['Morgan Lost']), 'nor the work its spin-off');
  assert.ok(!namesMatch('Tokyo Ghoul', ['Tokyo Ghoul:re']));
  assert.ok(!namesMatch('Solo Leveling', ['Solo Leveling: Ragnarok', 'Na Honjaman Level Up: Ragnarok']));
});

test("an AniList cover or banner names the entry it came from; anything else names none", () => {
  assert.deepEqual(aniListMediaOf('https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx105398-b673Vt5ZSuz3.jpg'), { type: 'MANGA', id: 105398 });
  assert.deepEqual(aniListMediaOf('https://s4.anilist.co/file/anilistcdn/media/manga/cover/medium/b30013-hbbRSqLs1hTa.png'), { type: 'MANGA', id: 30013 });
  assert.deepEqual(aniListMediaOf('https://s4.anilist.co/file/anilistcdn/media/manga/cover/extraLarge/nx30002-7EzO7o21jzeF.jpg'), { type: 'MANGA', id: 30002 });
  assert.deepEqual(aniListMediaOf('https://s4.anilist.co/file/anilistcdn/media/manga/banner/105398-ZsAsNhOyDxlD.jpg'), { type: 'MANGA', id: 105398 });
  assert.deepEqual(aniListMediaOf('https://s4.anilist.co/file/anilistcdn/media/anime/banner/16498-8jpFCOcDmneX.jpg'), { type: 'ANIME', id: 16498 });
  for (const u of [
    'https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/default.jpg', // no id
    'https://example.com/file/anilistcdn/media/manga/cover/large/bx105398-x.jpg', // another host
    'https://s4.anilist.co.example.com/file/anilistcdn/media/manga/cover/large/bx105398-x.jpg',
    'https://uploads.mangadex.org/covers/8f3e1818-a015-491d-bd81-3addc4d7d56a/c.jpg',
    'not a url', '', null,
  ]) assert.equal(aniListMediaOf(u), null, String(u));
});

test('a MangaDex cover names the title it came from; anything else names none', () => {
  assert.equal(mangaDexIdOf('https://uploads.mangadex.org/covers/8F3E1818-a015-491d-bd81-3addc4d7d56a/3b0e7e4c.jpg.512.jpg'), '8f3e1818-a015-491d-bd81-3addc4d7d56a');
  for (const u of ['https://uploads.mangadex.org/covers/not-a-uuid/x.jpg', 'https://mangadex.org.example/covers/8f3e1818-a015-491d-bd81-3addc4d7d56a/x.jpg',
    'https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx1-x.jpg', '', null]) assert.equal(mangaDexIdOf(u), null, String(u));
});

/** AniList's GraphQL endpoint, answering a title search with `media` and recording what it was asked. */
function fakeAniList(media: unknown, asked: any[] = []) {
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    assert.equal(new URL(String(url)).host, 'graphql.anilist.co', `unexpected request in a test: ${url}`);
    const body = JSON.parse(String(init?.body ?? '{}'));
    asked.push(body);
    return json({ data: { Media: media } });
  }) as typeof fetch;
  return asked;
}

test("AniList's art is kept only from an entry named as the series is; another work's answer is a miss that says which", async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const manga = {
    id: 777, title: { romaji: 'Sasaki to Miyano', english: 'Sasaki and Miyano', native: '佐々木と宮野' }, synonyms: ['Morgan Lost? No'],
    countryOfOrigin: 'JP', coverImage: { extraLarge: 'https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx777-a.jpg' },
    bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/manga/banner/777-b.jpg', relations: { edges: [] },
  };
  const asked = fakeAniList(manga);
  // Reintroduce by returning the entry unchecked (no namesMatch in fetchAniListArt): Morgan Lost takes the manga's art.
  const miss = await fetchAniListArt('Morgan Lost', ['Morgan Lost']);
  assert.equal(miss.cover, null, "another work's cover was kept");
  assert.equal(miss.banner, null, "another work's banner was kept");
  assert.equal(miss.mediaId ?? null, null, "another work's entry would be linked");
  assert.deepEqual(miss.refused, { id: 777, title: 'Sasaki and Miyano' });
  assert.equal(asked[0].variables.s, 'Morgan Lost', 'the search asks by the title as before');
  // Named as the series is -- by any of its names -- and everything comes back as it always did.
  const hit = await fetchAniListArt('Sasaki & Miyano (Official)', ['Sasaki & Miyano (Official)', 'Sasaki to Miyano']);
  assert.equal(hit.cover, manga.coverImage.extraLarge);
  assert.equal(hit.banner, manga.bannerImage);
  assert.equal(hit.mediaId, 777);
  assert.equal(hit.refused, undefined);
  // No entry at all is the plain miss it always was.
  fakeAniList(null);
  assert.deepEqual(await fetchAniListArt('Nothing Like It', ['Nothing Like It']), { banner: null, cover: null, mediaId: null, mediaTitle: null, country: null, titles: [] });
});

test("the anime search's banner is kept only from an anime named as the series is", async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const asked = fakeAniList({ title: { romaji: 'Tokyo Ghoul:re', english: 'Tokyo Ghoul:re' }, synonyms: [], bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/1-x.jpg' });
  assert.equal(await fetchAnimeBanner('Tokyo Ghoul', ['Tokyo Ghoul']), null, "a sequel's banner was taken for the parent");
  assert.match(asked[0].query, /synonyms/, 'the anime search does not ask for the names it is checked by');
  fakeAniList({ title: { romaji: 'Tokyo Ghoul' }, synonyms: [], bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/2-x.jpg' });
  assert.equal(await fetchAnimeBanner('Tokyo Ghoul', ['Tokyo Ghoul']), 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/2-x.jpg');
});

test("Kitsu's banner is kept only from an entry named as the series is, never one that merely contains its name", async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const entry = (canonicalTitle: string, url: string) => ({ attributes: { canonicalTitle, titles: { en: canonicalTitle }, abbreviatedTitles: [], coverImage: { original: url } } });
  globalThis.fetch = (async () => json({ data: [entry('Morgan Lost: Dark Novels', 'https://media.kitsu.app/spin.jpg')] })) as typeof fetch;
  // Kitsu's own check was containment both ways. Reintroduce it: the spin-off's banner is taken.
  assert.equal(await fetchKitsuBanner('Morgan Lost', ['Morgan Lost']), null, "a spin-off's banner was taken");
  globalThis.fetch = (async () => json({ data: [entry('Morgan Lost: Dark Novels', 'https://media.kitsu.app/spin.jpg'), entry('Morgan Lost', 'https://media.kitsu.app/work.jpg')] })) as typeof fetch;
  assert.equal(await fetchKitsuBanner('Morgan Lost', ['Morgan Lost']), 'https://media.kitsu.app/work.jpg');
});

test("AniList's entries by id: manga and anime, every name, what each is related to, fifty a request", async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const bodies: any[] = [];
  globalThis.fetch = (async (_u: any, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body));
    bodies.push(b);
    return json({ data: { Page: { media: b.variables.ids.filter((id: number) => id !== 2).map((id: number) => ({
      id, type: id === 3 ? 'ANIME' : 'MANGA', title: { romaji: `Romaji ${id}`, english: null, native: null }, synonyms: [`Syn ${id}`],
      relations: { edges: id === 3 ? [{ node: { id: 1, type: 'MANGA' } }, { node: { id: 9, type: 'NOVEL' } }] : [] },
    })) } } });
  }) as typeof fetch;
  const out = await fetchAniListEntries([1, 2, 3, 3]);
  assert.equal(bodies.length, 1);
  assert.match(bodies[0].query, /id_in:\$ids/);
  assert.doesNotMatch(bodies[0].query, /type:MANGA/, 'an anime banner\'s entry would never be answered');
  assert.deepEqual(bodies[0].variables.ids, [1, 2, 3], 'an id asked twice');
  assert.deepEqual([...out.keys()], [1, 3], 'an id AniList does not answer for is absent');
  assert.deepEqual(out.get(3), { id: 3, type: 'ANIME', titles: ['Romaji 3', 'Syn 3'], related: [{ id: 1, type: 'MANGA' }] });
  globalThis.fetch = (async () => json({}, 500)) as typeof fetch;
  await assert.rejects(fetchAniListEntries([1]), /anilist 500/, 'a failure read as "no answers"');
});

test("MangaDex's names by id: every title and alternative title, a hundred a request, a failure thrown", async (t) => {
  t.after(() => { globalThis.fetch = realFetch; _setMangadexPacing(null); _resetMangadexLimiter(); });
  _setMangadexPacing({ apiGapMs: 0 });
  const urls: URL[] = [];
  globalThis.fetch = (async (url: any) => {
    const u = new URL(String(url));
    urls.push(u);
    return json({ data: u.searchParams.getAll('ids[]').map((id) => ({ id: id.toUpperCase(), attributes: {
      title: { en: `Title ${id}` }, altTitles: [{ ko: `제목 ${id}` }, { 'ja-ro': `Romaji ${id}` }],
    } })) });
  }) as typeof fetch;
  const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`);
  const out = await mangadexTitles(ids);
  assert.equal(urls.length, 2, 'not batched by 100');
  assert.ok(urls[0].searchParams.getAll('contentRating[]').includes('pornographic'), 'an adult title would go unanswered');
  assert.deepEqual(out.get('id-0'), ['Title id-0', '제목 id-0', 'Romaji id-0'], 'keyed by the lower-case id, every name');
  globalThis.fetch = (async () => json({}, 503)) as typeof fetch;
  await assert.rejects(mangadexTitles(['x']), /mangadex 503/);
});
