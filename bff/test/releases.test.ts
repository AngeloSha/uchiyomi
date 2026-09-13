// The one rule for which copy of a chapter is kept, pinned case by case.
//
// Every adapter used to dedupe its own way and none of them knew what a group was, so a preference for one
// group's release had nowhere to go. Now the adapters hand over every copy and lib/releases.ts picks. The
// cases below are the rule's edges: joint releases against a block list, patience against the clock, copies
// that name no group at all, and the tie-breaks that decide when nothing else does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseReleases, groupsOf, mergePrefs, normGroup, ReleasePrefs, StoredPrefs } from '../src/lib/releases';
import type { SourceChapter } from '../src/lib/sources/types';

const DAY = 86_400_000;
const T0 = Date.parse('2026-09-01T00:00:00Z');
const iso = (t: number) => new Date(t).toISOString();

let n = 0;
/** A copy of chapter `number` by `scanlator`; ids are unique so the chosen copy can be told apart. */
const copy = (number: number, scanlator?: string, extra: Partial<SourceChapter> = {}): SourceChapter =>
  ({ sourceId: `c${++n}`, number, scanlator, ...extra });

const prefs = (p: Partial<ReleasePrefs> = {}): ReleasePrefs =>
  ({ priority: [], blocked: [], patienceMs: 0, ...p });

const chosen = (r: { releases: SourceChapter[] }, number: number) =>
  r.releases.find((c) => c.number === number)?.scanlator;

test('a ranked group beats the copy the source listed first', () => {
  // The source lists B first (its newest-first order), A is what the person asked for.
  //
  // Reintroduce by sorting copies by input order before rank (`a.idx - b.idx ||` at the front of `order`):
  // "chapter 1 is taken from A" reads B.
  const r = chooseReleases([copy(1, 'B'), copy(1, 'A')], prefs({ priority: ['A'] }));
  assert.equal(chosen(r, 1), 'A', 'chapter 1 is taken from A');
  assert.equal(r.releases.length, 1, 'exactly one copy per number');
});

test('a joint release is dropped only when EVERY group on it is blocked', () => {
  // Reintroduce by testing `keys.some(...)` instead of `keys.every(...)` in the block step: the first
  // assertion fails, "A & B survives a block on A alone" reads undefined.
  const one = chooseReleases([copy(1, 'A & B')], prefs({ blocked: ['A'] }));
  assert.equal(chosen(one, 1), 'A & B', 'A & B survives a block on A alone');

  const both = chooseReleases([copy(1, 'A & B'), copy(1, 'C')], prefs({ blocked: ['A', 'B'] }));
  assert.equal(chosen(both, 1), 'C', 'with A and B both blocked the joint copy is gone and C is taken');

  const only = chooseReleases([copy(1, 'A & B'), copy(2, 'C')], prefs({ blocked: ['A', 'B'] }));
  assert.deepEqual(only.releases.map((c) => c.number), [2], 'a number whose only copies are all blocked is absent');
});

test('a copy that names no group is never blocked and never withheld', () => {
  // An engine series lists no groups. With a priority list set for MangaDex and patience on, such a series
  // must not stall for two days on every new chapter waiting for a group that can never turn up.
  //
  // The block list names a group that is NOT the priority one: blocking the priority group itself would
  // empty the effective priority list and skip the patience branch before this guard was ever reached
  // (the first version of this test did exactly that and passed with the guard removed).
  //
  // Reintroduce by dropping the `if (!copies.some((x) => x.keys.length)) continue;` line (which treats a
  // group-less number like an unlisted group, rank Infinity, in the patience branch): "waiting is empty
  // for group-less copies" reads [1].
  const r = chooseReleases(
    [copy(1, undefined, { publishedAt: iso(T0) })],
    prefs({ priority: ['A'], blocked: ['Z'], patienceMs: 2 * DAY }),
    { now: T0 + 1 * DAY },
  );
  assert.deepEqual(r.releases.map((c) => c.number), [1], 'a group-less copy is not dropped by any block');
  assert.deepEqual(r.waiting, [], 'waiting is empty for group-less copies');
});

test('patience holds a number inside the window and releases it after', () => {
  // B released on T0; A is wanted; patience two days. One day in: wait. Three days in: take B.
  //
  // Reintroduce by dropping the `now - oldest < prefs.patienceMs` comparison (push whenever `oldest` is
  // finite): "released at +3 days" reads [1].
  const list = [copy(1, 'B', { publishedAt: iso(T0) })];
  const p = prefs({ priority: ['A'], patienceMs: 2 * DAY });

  const early = chooseReleases(list, p, { now: T0 + 1 * DAY });
  assert.deepEqual(early.waiting, [1], 'withheld at +1 day');
  assert.equal(chosen(early, 1), 'B', 'the best copy is still placed in releases while waiting');

  const late = chooseReleases(list, p, { now: T0 + 3 * DAY });
  assert.deepEqual(late.waiting, [], 'released at +3 days');
  assert.equal(chosen(late, 1), 'B');
});

test('never waits when the top-ranked group is present', () => {
  const r = chooseReleases(
    [copy(1, 'B', { publishedAt: iso(T0) }), copy(1, 'A', { publishedAt: iso(T0) })],
    prefs({ priority: ['A'], patienceMs: 2 * DAY }),
    { now: T0 },
  );
  assert.deepEqual(r.waiting, []);
  assert.equal(chosen(r, 1), 'A');
});

test('never waits at patienceMs 0', () => {
  const r = chooseReleases(
    [copy(1, 'B', { publishedAt: iso(T0) })],
    prefs({ priority: ['A'], patienceMs: 0 }),
    { now: T0 },
  );
  assert.deepEqual(r.waiting, []);
  assert.equal(chosen(r, 1), 'B');
});

test('an undated copy is taken now', () => {
  // Nothing to be patient against: a date-less copy would otherwise wait forever.
  const r = chooseReleases([copy(1, 'B')], prefs({ priority: ['A'], patienceMs: 2 * DAY }), { now: T0 });
  assert.deepEqual(r.waiting, []);
  assert.equal(chosen(r, 1), 'B');
});

test('tie-break: hosted before external', () => {
  // MangaDex marks an external (publisher) link with pages 0. An unknown page count is not external.
  const r = chooseReleases([copy(1, 'B', { pages: 0 }), copy(1, 'C', { pages: 20 })], prefs());
  assert.equal(chosen(r, 1), 'C');
  const unknown = chooseReleases([copy(1, 'B'), copy(1, 'C', { pages: 0 })], prefs());
  assert.equal(chosen(unknown, 1), 'B', 'undefined pages ranks as hosted, ahead of an explicit 0');
});

test('tie-break: the primary source before a follower', () => {
  const rank = (s?: string) => (s === 'primary' ? 0 : 1);
  const r = chooseReleases(
    [copy(1, 'B', { source: 'follower' }), copy(1, 'B', { source: 'primary' })],
    prefs(),
    { sourceRank: rank },
  );
  assert.equal(r.releases[0].source, 'primary');
});

test('tie-break: the earliest release, undated last', () => {
  const r = chooseReleases(
    [copy(1, 'B'), copy(1, 'C', { publishedAt: iso(T0 + DAY) }), copy(1, 'D', { publishedAt: iso(T0) })],
    prefs(),
  );
  assert.equal(chosen(r, 1), 'D');
});

test('tie-break: input order when nothing else separates them', () => {
  const r = chooseReleases([copy(1, 'B'), copy(1, 'C')], prefs());
  assert.equal(chosen(r, 1), 'B');
});

test('releases are one per number, ascending', () => {
  const r = chooseReleases([copy(3, 'A'), copy(1, 'A'), copy(2, 'B'), copy(2, 'A'), copy(1, 'B')], prefs());
  assert.deepEqual(r.releases.map((c) => c.number), [1, 2, 3]);
});

test('mergePrefs: blocks accumulate, a series priority replaces the global one, patience falls back', () => {
  // Reintroduce by concatenating the priorities (`[...global.priority, ...series.priority]`): "series
  // priority replaces" reads ['G', 'S'] and index 0 is the global group.
  const global: StoredPrefs = { priority: ['G'], blocked: ['X'], patienceDays: 2 };
  const series: StoredPrefs = { priority: ['S'], blocked: ['Y', 'x'], patienceDays: null };
  const m = mergePrefs(global, series);
  assert.deepEqual(m.priority, ['S'], 'series priority replaces');
  assert.deepEqual(m.blocked, ['X', 'Y'], 'blocks are the union, deduped by normGroup, first spelling kept');
  assert.equal(m.patienceMs, 2 * DAY, 'a null series patience inherits the global days');

  const empty = mergePrefs(global, { priority: [], blocked: [], patienceDays: 5 });
  assert.deepEqual(empty.priority, ['G'], 'an empty series priority falls back to the global list');
  assert.equal(empty.patienceMs, 5 * DAY);

  assert.equal(mergePrefs({ priority: [], blocked: [], patienceDays: null }, null).patienceMs, 2 * DAY,
    'with nothing set anywhere the built-in patience is two days');
});

test('groupsOf: splits a joint display string and dedupes; an explicit groups array wins', () => {
  assert.deepEqual(groupsOf({ scanlator: 'Alpha & Beta' }), ['Alpha', 'Beta']);
  assert.deepEqual(groupsOf({ scanlator: 'Alpha / Beta, Gamma' }), ['Alpha', 'Beta', 'Gamma']);
  assert.deepEqual(groupsOf({ scanlator: 'Alpha & alpha' }), ['Alpha'], 'deduped by normGroup');
  assert.deepEqual(groupsOf({ scanlator: 'Alpha & Beta', groups: ['Alpha & Beta'] }), ['Alpha & Beta'],
    'a structural groups array is taken as-is, not split');
  assert.deepEqual(groupsOf({}), []);
  assert.deepEqual(groupsOf({ scanlator: '  ' }), []);
});

test('normGroup: NFKC, case and punctuation insensitive', () => {
  assert.equal(normGroup('Asura Scans'), normGroup('asura-scans'));
  assert.equal(normGroup('Ｆｌａｍｅ'), normGroup('flame'), 'full-width letters fold to ASCII');
  assert.equal(normGroup('Luminous_Scans!'), 'luminousscans');
  assert.notEqual(normGroup('Alpha'), normGroup('Alpha2'));
});
