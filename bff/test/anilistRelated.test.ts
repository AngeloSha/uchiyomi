// Related works and recommendations (v0.61.0): the pure parts -- what an AniList answer is kept as (lib/anilist.ts
// normaliseRelated), who may be shown an AniList entry (lib/anilistRelated.ts adultOk) and which library series an entry
// is (heldEntry). The job, the routes and the privacy rules run against Postgres in anilistRelated.int.test.ts.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import type { AdultCtx } from '../src/lib/anilistRelated';
import type { Held, LibraryIndex } from '../src/lib/discoverIdentity';

// The modules read the environment when they load, and a static import would load them before these lines run.
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
let normaliseRelated: typeof import('../src/lib/anilist').normaliseRelated;
let RELATIONS: typeof import('../src/lib/anilist').RELATIONS;
let RELATIONS_MAX = 0, RECS_MAX = 0;
let adultOk: typeof import('../src/lib/anilistRelated').adultOk;
let heldEntry: typeof import('../src/lib/anilistRelated').heldEntry;
before(async () => {
  ({ normaliseRelated, RELATIONS, RELATIONS_MAX, RECS_MAX } = await import('../src/lib/anilist'));
  ({ adultOk, heldEntry } = await import('../src/lib/anilistRelated'));
});

/** An AniList node as the related query selects it. */
const node = (id: number, o: Record<string, any> = {}) => ({
  id, type: 'MANGA', format: 'MANGA', status: 'FINISHED', isAdult: false, countryOfOrigin: 'KR',
  title: { romaji: `Romaji ${id}`, english: `English ${id}`, native: `ネイティブ${id}` }, synonyms: [`Other Name ${id}`],
  coverImage: { large: `https://s4.anilist.co/file/anilistcdn/media/manga/cover/medium/bx${id}.jpg` },
  genres: ['Action'], averageScore: 81.4, ...o,
});
const edge = (relationType: string, n: any) => ({ relationType, node: n });
const rec = (rating: number, n: any) => ({ rating, mediaRecommendation: n });

test('the answer kept: six kinds of relation in their order, recommendations voted up, manga only, each once', () => {
  const m = {
    id: 1,
    relations: {
      edges: [
        edge('SPIN_OFF', node(10)),
        edge('ADAPTATION', node(11, { type: 'ANIME', format: 'TV' })),
        edge('SEQUEL', node(12)),
        // A light novel is type MANGA on AniList: its format says what it is. Reintroduce by keeping it: "a light novel".
        edge('SOURCE', node(13, { format: 'NOVEL' })),
        edge('PREQUEL', node(14, { format: 'NOVEL' })),
        edge('PARENT', node(15)),
        edge('SEQUEL', node(16, { type: 'ANIME' })),
        edge('ALTERNATIVE', node(17, { format: 'ONE_SHOT' })),
        edge('SIDE_STORY', node(18)),
        edge('CHARACTER', node(19)),
        edge('SEQUEL', node(12)), // the same work twice
        edge('SEQUEL', node(1)), // the entry itself
        edge('PREQUEL', node(20, { title: { romaji: null, english: '  ', native: null } })), // no name at all
      ],
    },
    recommendations: {
      nodes: [
        rec(57, node(30)),
        rec(0, node(31)), // nobody voted it up
        rec(-3, node(32)),
        rec(12, node(33, { format: 'NOVEL' })),
        rec(9, null), // a recommendation whose entry was deleted
        rec(8, node(34, { isAdult: true, genres: ['Hentai'] })),
        rec(4, node(30)), // listed twice
      ],
    },
  };
  const r = normaliseRelated(m);
  assert.deepEqual(r.relations.map((x) => [x.rel, x.id]), [['SEQUEL', 12], ['PARENT', 15], ['SIDE_STORY', 18], ['SPIN_OFF', 10], ['ALTERNATIVE', 17]],
    'not the six kinds, in their order, manga only, each once');
  assert.deepEqual(r.recs.map((x) => [x.id, x.rating]), [[30, 57], [34, 8]], 'not the recommendations voted up, manga only, each once');
  const seq = r.relations[0];
  // The titles apart from the synonyms: a synonym names a work only when long enough (heldEntry).
  assert.deepEqual(seq.titles, ['Romaji 12', 'English 12', 'ネイティブ12']);
  assert.deepEqual(seq.synonyms, ['Other Name 12']);
  assert.equal(seq.title, 'English 12', 'the English title is the one shown');
  assert.equal(seq.score, 81, 'the score is a whole number');
  assert.equal(seq.cover, 'https://s4.anilist.co/file/anilistcdn/media/manga/cover/medium/bx12.jpg');
  assert.equal(seq.format, 'MANGA');
  assert.equal(seq.country, 'KR');
  // Kept raw: who may see an 18+ entry is decided per viewer when it is read, never in the shared copy.
  assert.equal(r.recs[1].adult, true);
  assert.deepEqual(r.recs[1].genres, ['Hentai']);
  assert.equal(seq.rating, undefined, 'a relation carries no rating');
  assert.equal(r.recs[0].rel, undefined, 'a recommendation carries no relation');
  assert.deepEqual([...RELATIONS], ['SEQUEL', 'PREQUEL', 'PARENT', 'SIDE_STORY', 'SPIN_OFF', 'ALTERNATIVE']);
});

test('at most twelve relations and ten recommendations, the nearer kinds kept first', () => {
  const edges = [
    ...Array.from({ length: 14 }, (_, i) => edge('SIDE_STORY', node(100 + i))),
    edge('SEQUEL', node(200)),
  ];
  const nodes = Array.from({ length: 14 }, (_, i) => rec(50 - i, node(300 + i)));
  const r = normaliseRelated({ id: 1, relations: { edges }, recommendations: { nodes } });
  assert.equal(r.relations.length, RELATIONS_MAX);
  // Sorted before the cut: the sequel listed last is not the one dropped. Reintroduce the cut first: it is gone.
  assert.equal(r.relations[0].id, 200, 'the sequel was cut for side stories');
  assert.equal(r.recs.length, RECS_MAX);
  assert.deepEqual(r.recs.map((x) => x.id), Array.from({ length: 10 }, (_, i) => 300 + i), 'not the most voted first');
});

test('an answer with nothing in it keeps nothing, and anything malformed is left out', () => {
  assert.deepEqual(normaliseRelated({ id: 5 }), { relations: [], recs: [] });
  assert.deepEqual(normaliseRelated(null), { relations: [], recs: [] });
  const r = normaliseRelated({ id: 5, relations: { edges: [edge('SEQUEL', { id: 'x' }), edge('SEQUEL', { ...node(6), id: -1 })] },
    recommendations: { nodes: [{ rating: 3 }] } });
  assert.deepEqual(r, { relations: [], recs: [] });
  const bare = normaliseRelated({ id: 5, relations: { edges: [edge('SEQUEL', { id: 7, type: 'MANGA', format: null, title: { romaji: 'Bare' } })] } });
  assert.deepEqual(bare.relations[0], {
    id: 7, rel: 'SEQUEL', title: 'Bare', titles: ['Bare'], synonyms: [], cover: null, format: null, status: null, adult: false,
    genres: [], country: null, score: null,
  });
});

const ctx = (o: Partial<AdultCtx> = {}): AdultCtx => ({ maxAgeRating: null, hideAdultLibraries: false, adultGenres: [], ...o });

test('who may be shown an AniList entry: the age cap, the 18+ switch and the adult genres', () => {
  const plain = { adult: false, genres: ['Action', 'Romance'] };
  const adult = { adult: true, genres: ['Hentai'] };
  const ecchi = { adult: false, genres: ['  ecchi ', 'Comedy'] };
  // [who, plain, adult, ecchi]
  const matrix: Array<[string, AdultCtx, boolean, boolean, boolean]> = [
    ['no cap, showing 18+', ctx(), true, true, true],
    ['no cap, hiding 18+', ctx({ hideAdultLibraries: true }), true, false, true],
    ['no cap, hiding 18+, Ecchi named adult', ctx({ hideAdultLibraries: true, adultGenres: ['Ecchi'] }), true, false, false],
    // The genres are the admin's, applied only while the viewer hides 18+ -- as browsable() applies them.
    ['no cap, showing 18+, Ecchi named adult', ctx({ adultGenres: ['Ecchi'] }), true, true, true],
    // An account capped below 18 never sees an 18+ entry, whatever its request says.
    ['capped at 13, showing', ctx({ maxAgeRating: 13 }), true, false, true],
    ['capped at 13, hiding, Ecchi named', ctx({ maxAgeRating: 13, hideAdultLibraries: true, adultGenres: ['ECCHI'] }), true, false, false],
    ['capped at 18, showing', ctx({ maxAgeRating: 18 }), true, true, true],
    ['capped at 18, hiding', ctx({ maxAgeRating: 18, hideAdultLibraries: true }), true, false, true],
  ];
  for (const [who, c, p, a, e] of matrix) {
    assert.equal(adultOk(plain, c), p, `${who}: a plain entry`);
    assert.equal(adultOk(adult, c), a, `${who}: an 18+ entry`);
    assert.equal(adultOk(ecchi, c), e, `${who}: an entry in a genre the admin may name`);
  }
  // Reintroduce a case-blind miss (`genres.includes(g)`): "capped at 13, hiding, Ecchi named" shows the Ecchi entry.
  assert.equal(adultOk({ genres: ['Boys’ Love'] }, ctx({ hideAdultLibraries: true, adultGenres: [' boys’ love '] })), false);
  assert.equal(adultOk({}, ctx({ maxAgeRating: 0, hideAdultLibraries: true, adultGenres: ['Ecchi'] })), true, 'an entry with no genres is plain');
});

const held = (id: string, work = `lib:${id}`): Held => ({ id, lang: 'en', work });
const index = (o: { byName?: Record<string, Held[]>; byWork?: Record<string, Held[]> }): LibraryIndex => ({
  byPair: new Map(), byName: new Map(Object.entries(o.byName ?? {})), byWork: new Map(Object.entries(o.byWork ?? {})),
});

test('which library series an entry is: its AniList entry first, then a title exactly, a synonym only when long enough', () => {
  const linked = held('s_linked');
  const titled = held('s_titled');
  const idx = index({
    byWork: { 'al:500': [linked] },
    byName: {
      solosomething: [titled], // "Solo Something"
      'ネイティブ600': [held('s_native')],
      return: [held('s_return')], // a short synonym is many works' name
      longenoughname: [held('s_syn')],
      tower: [held('s_tower')],
    },
  });
  // The entry itself wins over a name.
  assert.deepEqual(heldEntry(idx, { id: 500, titles: ['Solo Something'], synonyms: [] }), [linked], 'not by its AniList entry first');
  assert.deepEqual(heldEntry(idx, { id: 501, titles: ['Romaji', 'Solo Something!'], synonyms: [] }), [titled], 'not by an English title, folded');
  assert.deepEqual(heldEntry(idx, { id: 600, titles: ['ネイティブ600'] }), [held('s_native')], 'not by a native title');
  // Reintroduce every synonym (drop the length rule): "a short synonym holds nothing" finds s_return.
  assert.deepEqual(heldEntry(idx, { id: 502, titles: ['Nothing Here'], synonyms: ['Return'] }), [], 'a short synonym holds nothing');
  assert.deepEqual(heldEntry(idx, { id: 503, titles: ['Nothing Here'], synonyms: ['Long Enough Name'] }), [held('s_syn')], 'a long synonym is a name');
  // Exact names only, never containment: "Tower" is not "Tower of God".
  assert.deepEqual(heldEntry(idx, { id: 504, titles: ['Tower of God'], synonyms: [] }), [], 'containment counted as the same work');
  assert.deepEqual(heldEntry(idx, { id: 505 }), [], 'an entry with no names');
});
