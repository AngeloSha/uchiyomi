// The admin's per-source age rating: what it makes of a source's permission and of its extension's adult flag.
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let R: typeof import('../src/lib/sourceRatings');
let V: typeof import('../src/lib/visibility');
let S: typeof import('../src/lib/searchAll');
before(async () => {
  R = await import('../src/lib/sourceRatings');
  V = await import('../src/lib/visibility');
  S = await import('../src/lib/searchAll');
});
beforeEach(() => R.applySourceRatings({}));

test('cleanSourceRatings keeps 0 and 18 on real ids, lowercases them and drops anything else', () => {
  assert.deepEqual(R.cleanSourceRatings({ 'SW:1': 18, a: 0, b: 18, c: 19, d: -1, e: 1.5, f: '13', 'bad id': 5, g: 17 }), { 'sw:1': 18, a: 0, b: 18 });
  for (const v of [null, undefined, [], 'x', 4]) assert.deepEqual(R.cleanSourceRatings(v), {});
});

test('without a rating the extension flag decides, as before', () => {
  assert.equal(V.sourceAllowedFor({ id: 'sw:1', isNsfw: true }, 16), false);
  assert.equal(V.sourceAllowedFor({ id: 'sw:1', isNsfw: true }, null), true);
  assert.equal(V.sourceAllowedFor({ id: 'sw:1' }, 6), true);
  assert.equal(V.sourceAllowedFor({ isNsfw: true }, 17), false, 'an adapter without an id still works');
});

test('Mixed clears an adult flag; Adult only makes an unflagged source adult', () => {
  R.applySourceRatings({ 'sw:1': 0, 'sw:2': 18 });
  assert.equal(V.sourceAllowedFor({ id: 'sw:1', isNsfw: true }, 6), true);
  assert.equal(R.isAdultSource({ id: 'sw:1', isNsfw: true }), false);
  assert.equal(V.sourceAllowedFor({ id: 'sw:2' }, 17), false);
  assert.equal(R.isAdultSource({ id: 'sw:2' }), true);
});

test('Show 18+ off: a flagged source is out unless Mixed, an Adult only one is out whatever its flag, no name decides', () => {
  const ctx = { ...V.SYSTEM_CTX, hideAdultLibraries: true };
  R.applySourceRatings({ 'sw:1': 0, 'sw:2': 18 });
  assert.equal(V.sourceBrowsableFor({ id: 'sw:1', isNsfw: true }, ctx), true, 'Mixed stays in the fan-out');
  assert.equal(V.sourceBrowsableFor({ id: 'sw:2' }, ctx), false);
  assert.equal(V.sourceBrowsableFor({ id: 'sw:3', isNsfw: true }, ctx), false, 'the flag condemns a source nobody rated');
  assert.equal(V.sourceBrowsableFor({ id: 'sw:4', name: 'Hentai Heaven' } as never, ctx), true, 'a name proves nothing');
});

test('ratedAdultIds and clearedIds split the overrides at 18', () => {
  R.applySourceRatings({ a: 18, c: 0 });
  assert.deepEqual(R.ratedAdultIds(), ['a']);
  assert.deepEqual(R.clearedIds(), ['c']);
});

test('a Mixed source is not condemned by its extension flag when ratings are judged', () => {
  const item = { genres: [], contentRating: undefined } as never;
  const lists = { genres: [], sources: [], cleared: ['sw:1'] };
  assert.equal(S.ratingOf(item, { id: 'sw:1', isNsfw: true }, lists), undefined);
  assert.equal(S.ratingOf(item, { id: 'sw:2', isNsfw: true }, lists), 'flagged');
  assert.equal(S.ratingOf(item, { id: 'sw:1', isNsfw: true }, { ...lists, sources: ['sw:1'] }), 'adult', 'Adult only is adult whatever else');
});

test('foldAdultSources moves the retired adult_sources list into ratings as 18, without overriding an entry', () => {
  assert.deepEqual(R.foldAdultSources(['SW:1', ' sw:2 ', 'sw:3'], { 'sw:2': 0, 'sw:9': 0 }), { 'sw:1': 18, 'sw:2': 0, 'sw:3': 18, 'sw:9': 0 });
  assert.deepEqual(R.foldAdultSources(['sw:1'], { 'sw:1': 0 }), { 'sw:1': 0 }, 'an explicit all-ages rating wins over the old list');
  assert.deepEqual(R.foldAdultSources([], { a: 17 }), {}, 'only 0 and 18 are ratings');
  assert.deepEqual(R.foldAdultSources(null, null), {});
  assert.deepEqual(R.foldAdultSources(['ok', 4, null, 'bad id'], {}), { ok: 18 }, 'junk entries are dropped');
});

test('foldAdultSources is idempotent: folding its own output with an emptied list changes nothing', () => {
  const once = R.foldAdultSources(['a', 'b'], { c: 0 });
  assert.deepEqual(R.foldAdultSources([], once), once);
  assert.deepEqual(R.foldAdultSources(['a', 'b'], once), once);
});
