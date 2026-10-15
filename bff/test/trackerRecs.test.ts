// Recommendations from connected trackers: which of the person's titles seed them, how the answers are
// combined, and what is left out. The calls to the services are in trackerRecs.int.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickSeeds, buildRecs, exclusionsFrom, tasteFactor, type SeedRecs } from '../src/lib/trackerRecsCore';
import type { LibraryEntry, RecItem } from '../src/lib/trackerProviders';

const entry = (id: string, title: string, status: LibraryEntry['status'], progress: number, score?: number, format: LibraryEntry['format'] = 'manga', altTitles: string[] = []): LibraryEntry =>
  ({ externalId: id, title, altTitles, status, progress, format, ...(score != null ? { score } : {}) });
const item = (id: string, title: string, over: Partial<RecItem> = {}): RecItem =>
  ({ id, title, altTitles: [], cover: `c${id}`, url: `u${id}`, score: 80, adult: false, format: 'manga', votes: 5, ...over });

test('seeds: liked titles first by score, then unrated reads; low scores, dropped, planned and novels never seed', () => {
  const list = [
    entry('1', 'Low', 'completed', 90, 4),
    entry('2', 'Ten', 'completed', 10, 10),
    entry('3', 'Nine', 'reading', 50, 9),
    entry('4', 'Unrated long', 'completed', 300),
    entry('5', 'Unrated short', 'completed', 3),
    entry('6', 'Dropped', 'dropped', 40, 9),
    entry('7', 'Planned', 'plan_to_read', 0, 9),
    entry('8', 'Novel', 'completed', 12, 10, 'novel'),
    entry('9', 'Paused unrated', 'on_hold', 20),
    entry('10', 'Paused liked', 'on_hold', 20, 8),
  ];
  // Reintroduce by seeding from every status: the dropped and planned titles come back, and a 4/10 seeds more of itself.
  assert.deepEqual(pickSeeds(list, 10).map((e) => e.title), ['Ten', 'Nine', 'Paused liked', 'Unrated long', 'Unrated short']);
  assert.deepEqual(pickSeeds(list, 2).map((e) => e.title), ['Ten', 'Nine']);
  assert.deepEqual(pickSeeds(list, 0), []);
});

test('seeds: a few chapters of an unfinished series never seed; twenty of a huge one do; three stars is enough, two is not', () => {
  const list = [
    entry('1', 'Sampled', 'reading', 4, 10),
    { ...entry('2', 'Huge', 'reading', 20, 9), total: 1200 },
    entry('3', 'Short and done', 'completed', 2, 8),
    entry('4', 'Three stars', 'completed', 50, 6),
    entry('5', 'Two stars', 'completed', 90, 4),
  ];
  assert.deepEqual(pickSeeds(list, 10).map((e) => e.title), ['Huge', 'Short and done', 'Three stars']);
});

test('seeds: what was read long ago counts for less than the same read lately', () => {
  const now = Date.now();
  const list = [
    { ...entry('1', 'Old', 'reading', 100, 9), lastRead: now - 3 * 365 * 86_400_000 },
    { ...entry('2', 'Fresh', 'reading', 100, 8), lastRead: now - 2 * 86_400_000 },
  ];
  assert.deepEqual(pickSeeds(list, 2).map((e) => e.title), ['Fresh', 'Old']);
});

test('taste: a genre of well-rated series lifts a suggestion, one of badly rated series sinks it, no taste changes nothing', () => {
  const taste = new Map([['action', 0.8], ['romance', -0.8]]);
  assert.ok(tasteFactor(['Action'], taste) > 1);
  assert.ok(tasteFactor(['Romance'], taste) < 1);
  assert.equal(tasteFactor(['Action'], undefined), 1);
  assert.equal(tasteFactor(undefined, taste), 1);
  const seed = entry('1', 'S', 'completed', 50, 9);
  const out = buildRecs([{ provider: 'anilist', seed, items: [item('a', 'Love Story', { genres: ['Romance'] }), item('b', 'Fight Story', { genres: ['Action'] })] }],
    exclusionsFrom(new Map()), { restrictAdult: false, taste });
  assert.deepEqual(out.map((r) => r.title), ['Fight Story', 'Love Story']);
});

test('seeds: the same list always gives the same seeds, so the per-title cache can work', () => {
  const list = [entry('20', 'B', 'completed', 5, 8), entry('3', 'A', 'completed', 5, 8), entry('100', 'C', 'completed', 5, 8)];
  const a = pickSeeds(list, 3).map((e) => e.externalId);
  const b = pickSeeds([...list].reverse(), 3).map((e) => e.externalId);
  assert.deepEqual(a, b);
  assert.deepEqual(a, ['3', '20', '100'], 'ties break by id, numerically');
});

test('what the person already has is left out: by id at the same service, by any name anywhere', () => {
  const mine = new Map<'anilist' | 'myanimelist', LibraryEntry[]>([
    ['anilist', [entry('1', 'Berserk', 'completed', 300, 10), entry('2', 'Planned One', 'plan_to_read', 0)]],
    ['myanimelist', [entry('50', 'Vagabond', 'reading', 10, 9, 'manga', ['Vagabond (Takehiko Inoue)'])]],
  ]);
  const seed: SeedRecs = {
    provider: 'anilist', seed: mine.get('anilist')![0],
    items: [
      item('1', 'Berserk'),                                  // the seed itself, by id
      item('2', 'Planned One'),                              // on the list as planned: still known to them
      item('900', 'Vagabond', { altTitles: [] }),            // on the OTHER service's list, by name
      item('901', 'vagabond!!'),                             // normalised the same
      item('902', 'Monster'),
    ],
  };
  const out = buildRecs([seed], exclusionsFrom(mine), { restrictAdult: false });
  assert.deepEqual(out.map((r) => r.title), ['Monster']);
});

test('the same series suggested by both services is one card naming both, and by several seeds ranks higher', () => {
  const s1 = entry('1', 'Berserk', 'completed', 300, 10);
  const s2 = entry('2', 'Vinland Saga', 'completed', 200, 8);
  const m1 = entry('77', 'Vagabond', 'completed', 300, 9);
  const out = buildRecs([
    { provider: 'anilist', seed: s1, items: [item('10', 'Monster', { votes: 30 }), item('11', 'Only Berserk', { votes: 30 })] },
    { provider: 'anilist', seed: s2, items: [item('10', 'Monster', { votes: 2 })] },
    { provider: 'myanimelist', seed: m1, items: [item('700', 'MONSTER', { cover: null, score: null, votes: 4 })] },
  ], exclusionsFrom(new Map()), { restrictAdult: false });
  assert.equal(out[0].title, 'Monster', 'three pairings beat one');
  assert.deepEqual(out[0].sources.map((s) => [s.provider, s.because]).sort(), [['anilist', 'Berserk'], ['myanimelist', 'Vagabond']],
    'each service names the seed ITS strongest pairing came from');
  assert.equal(out[0].cover, 'c10');
  assert.equal(out.filter((r) => r.title.toLowerCase() === 'monster').length, 1);
});

test('an adult or unknown-rating title is withheld from a restricted viewer, and light novels are never shown', () => {
  const seed: SeedRecs = {
    provider: 'myanimelist', seed: entry('5', 'X', 'completed', 10, 9),
    items: [item('1', 'Safe'), item('2', 'Adult', { adult: true }), item('3', 'Unknown', { adult: null }), item('4', 'A Novel', { format: 'novel' })],
  };
  // Reintroduce by testing `adult === true` instead of `!== false`: Unknown (MyAnimeList said nothing and AniList did not know it) is shown.
  assert.deepEqual(buildRecs([seed], exclusionsFrom(new Map()), { restrictAdult: true }).map((r) => r.title), ['Safe']);
  assert.deepEqual(buildRecs([seed], exclusionsFrom(new Map()), { restrictAdult: false }).map((r) => r.title), ['Adult', 'Safe', 'Unknown']);
});

test('one seed cannot fill the whole rail', () => {
  const many = Array.from({ length: 12 }, (_, i) => item(String(i), `Pick ${i}`, { votes: 50 - i }));
  const other = [item('99', 'Other seed pick', { votes: 1 })];
  const out = buildRecs([
    { provider: 'anilist', seed: entry('1', 'Big', 'completed', 1, 10), items: many },
    { provider: 'anilist', seed: entry('2', 'Small', 'completed', 1, 7), items: other },
  ], exclusionsFrom(new Map()), { restrictAdult: false });
  assert.equal(out.filter((r) => r.sources[0].because === 'Big').length, 5);
  assert.ok(out.some((r) => r.title === 'Other seed pick'));
});
