// Discover's one picks row (v0.98.0, lib/forYou.ts): the trackers' suggestions and the reads' picks in turn, one card a
// title by any of its names or its AniList entry, and each card saying where it came from.
import test from 'node:test';
import assert from 'node:assert/strict';
import { anilistIdOf, mergePicks, PICKS_MAX, type ReadPick } from '../lib/forYou';
import type { Recommendation } from '../lib/recommendations';

const rec = (title: string, o: Partial<Recommendation> = {}): Recommendation => ({
  title, altTitles: [], cover: `https://c/${title}.jpg`, score: 80,
  sources: [{ provider: 'anilist', label: 'AniList', because: 'Berserk', url: null }], ...o,
});
const read = (title: string, id: number | null = null, because = { id: 's1', title: 'Solo Leveling' }): ReadPick =>
  ({ id, title, cover: `https://c/${title}.jpg`, score: 70, because });

test('a tracker\'s suggestion, then a read\'s pick, in turn, each list in its own order', () => {
  const out = mergePicks([rec('A'), rec('B'), rec('C')], [read('x'), read('y')]);
  // Reintroduce one list after the other: the reads' picks sit behind every suggestion.
  assert.deepEqual(out.map((p) => p.title), ['A', 'x', 'B', 'y', 'C']);
  assert.deepEqual(out[0].from, { kind: 'tracker', badge: 'AniList', because: 'Berserk', tip: 'AniList: Berserk' });
  assert.deepEqual(out[1].from, { kind: 'read', seriesId: 's1', because: 'Solo Leveling' });
  // Either list alone is a row.
  assert.deepEqual(mergePicks([], [read('x'), read('y')]).map((p) => p.title), ['x', 'y']);
  assert.deepEqual(mergePicks([rec('A')], []).map((p) => p.title), ['A']);
  assert.deepEqual(mergePicks([], []), []);
});

test('one card per title: by any name the suggestion goes by, or by its AniList entry, the first to name it keeping it', () => {
  const out = mergePicks(
    [rec('Omniscient Reader', { altTitles: ['Jeonjijeok Dokja Sijeom'] }), rec('Tower of God', { sources: [{ provider: 'anilist', label: 'AniList', because: 'X', url: 'https://anilist.co/manga/85143' }] })],
    [read('JEONJIJEOK DOKJA SIJEOM!'), read('Kami no Tou', 85143), read('Solo Max-Level Newbie')],
  );
  // Reintroduce the plain concatenation: Omniscient Reader is two cards (its Korean name), and Tower of God two (its entry).
  assert.deepEqual(out.map((p) => p.title), ['Omniscient Reader', 'Tower of God', 'Solo Max-Level Newbie']);
  // A title of no Latin letters is not a name every such title shares.
  assert.equal(mergePicks([], [read('나 혼자만 레벨업'), read('전지적 독자 시점')]).length, 2);
});

test('the AniList entry of a suggestion is read off its AniList page address, and only AniList\'s', () => {
  assert.equal(anilistIdOf(rec('A', { sources: [{ provider: 'anilist', label: 'AniList', because: 'B', url: 'https://anilist.co/manga/30013' }] })), 30013);
  assert.equal(anilistIdOf(rec('A', { sources: [{ provider: 'myanimelist', label: 'MyAnimeList', because: 'B', url: 'https://myanimelist.net/manga/2' }] })), null);
  assert.equal(anilistIdOf(rec('A')), null);
});

test('the row holds at most forty, and a pick from an older server names the answer\'s one read', () => {
  const many = Array.from({ length: 30 }, (_, i) => rec(`T${i}`));
  const reads = Array.from({ length: 30 }, (_, i) => read(`R${i}`));
  assert.equal(PICKS_MAX, 40);
  assert.equal(mergePicks(many, reads).length, 40);
  // Before v0.98.0 the server named one read for the whole rail, as `seed`, and none on the picks.
  const old = mergePicks([], [{ id: 1, title: 'Old', cover: null, score: null }], { id: 's9', title: 'Vagabond' });
  assert.deepEqual(old[0].from, { kind: 'read', seriesId: 's9', because: 'Vagabond' });
  // With no read named at all, a pick has nothing to say why it is there, and is left out.
  assert.deepEqual(mergePicks([], [{ id: 1, title: 'Old', cover: null, score: null }]), []);
});
