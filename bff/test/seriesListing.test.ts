// The persisted listing's pure half: how a source's chapter list becomes one row per number, and how a
// row becomes a reason on the series page.
//
// No database: listingRows and whyOf are functions over their arguments. The database half -- the sweep
// writing rows, the route reading them back -- is seriesListing.int.test.ts.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

// Imported after the environment is set, not with it: a static import is hoisted above these assignments,
// and lib/env refuses to load without DATABASE_URL. Nothing here connects -- the DSN points nowhere.
let listingRows: typeof import('../src/lib/seriesListing')['listingRows'];
let whyOf: typeof import('../src/lib/seriesListing')['whyOf'];
let chooseReleases: typeof import('../src/lib/releases')['chooseReleases'];
let CHAPTER_RETRY_CAP: number;
before(async () => {
  ({ listingRows, whyOf } = await import('../src/lib/seriesListing'));
  ({ chooseReleases } = await import('../src/lib/releases'));
  ({ CHAPTER_RETRY_CAP } = await import('../src/lib/updater'));
});

const ch = (n: number, extra: Record<string, unknown> = {}) => ({ sourceId: `c/${n}/${extra.scanlator ?? ''}`, number: n, title: `Chapter ${n}`, ...extra });
const noPrefs = { priority: [], blocked: [], patienceMs: 0 };

test('one row per number, carrying every group of every copy and the chosen copy\'s source', () => {
  // Chapter 3 is listed by two groups on the primary and again by the follower; chapter 4 by the follower only.
  const tagged = [
    ch(1, { source: 'pri' }),
    ch(3, { scanlator: 'Group A', source: 'pri' }),
    ch(3, { scanlator: 'Group B', source: 'pri' }),
    ch(3, { scanlator: 'Group A', source: 'fol' }), // the same group again: deduped, not listed twice
    ch(4, { scanlator: 'Group C', source: 'fol' }),
    { sourceId: 'x', number: NaN, source: 'pri' }, // an unparsable number is not a chapter
  ];
  const { releases, waiting } = chooseReleases(tagged, { ...noPrefs, priority: ['Group B'] }, { sourceRank: (s) => (s === 'pri' ? 0 : 1) });
  const rows = listingRows(tagged, releases, new Set(waiting), 'pri');

  assert.deepEqual(rows.map((r) => r.number), [1, 3, 4], 'one row per finite number, ascending');
  const three = rows[1];
  assert.deepEqual(three.groups, ['Group A', 'Group B'], 'every group that released ANY copy, deduped');
  assert.equal(three.scanlator, 'Group B', 'the chosen copy is the ranked group\'s');
  assert.equal(three.chosen.sourceId, 'c/3/Group B');
  assert.equal(three.sourceId, 'pri');
  assert.equal(three.status, 'available');
  assert.equal(rows[2].sourceId, 'fol', 'a number only the follower lists is fetched through the follower');
  assert.equal(rows[0].sourceId, 'pri');
  assert.deepEqual(rows[0].groups, [], 'a copy naming no group contributes no group');
});

test('a number only blocked groups released is kept as blocked, with a copy to show', () => {
  // chooseReleases drops every copy of 7, so the number has no release. It must still be a row -- the
  // series page has to say "only blocked groups released it", and a picker has to be able to name them --
  // and it needs a copy for the title and the date.
  const tagged = [ch(6, { source: 'pri' }), ch(7, { scanlator: 'Spam Group', source: 'pri', publishedAt: '2026-09-01T00:00:00Z' })];
  const { releases, waiting } = chooseReleases(tagged, { ...noPrefs, blocked: ['spam group'] });
  assert.deepEqual(releases.map((r) => r.number), [6], 'the chooser dropped 7 -- the premise of this test');
  const rows = listingRows(tagged, releases, new Set(waiting), 'pri');
  const seven = rows.find((r) => r.number === 7)!;
  assert.ok(seven, 'the blocked number is still a row');
  assert.equal(seven.status, 'blocked');
  assert.deepEqual(seven.groups, ['Spam Group']);
  assert.equal(seven.publishedAt, '2026-09-01T00:00:00Z', 'the first copy is kept for display');
  assert.equal(rows.find((r) => r.number === 6)!.status, 'available');
});

test('a number the chooser is holding for the preferred group is held', () => {
  const tagged = [ch(5, { scanlator: 'Group A', source: 'pri', publishedAt: new Date().toISOString() })];
  const { releases, waiting } = chooseReleases(tagged, { priority: ['Group B'], blocked: [], patienceMs: 2 * 86_400_000 });
  assert.deepEqual(waiting, [5], 'the chooser is holding 5 -- the premise of this test');
  const rows = listingRows(tagged, releases, new Set(waiting), 'pri');
  assert.equal(rows[0].status, 'held');
  assert.equal(rows[0].scanlator, 'Group A', 'and the copy on offer today is still the row\'s copy');
});

test('a copy an adapter tagged with nothing falls back to the series\' own source', () => {
  const tagged = [ch(1)];
  const rows = listingRows(tagged, tagged, new Set(), 'pri');
  assert.equal(rows[0].sourceId, 'pri');
});

/**
 * The precedence is the contract the series page draws from: floor > blocked > failed > held > missing.
 * Reintroduce by swapping any two branches in whyOf -- the `held` and `failed` checks, say: "a capped
 * chapter that is also held is failed" then reads held.
 */
test('whyOf: floor beats blocked beats failed beats held beats missing', () => {
  const cap = CHAPTER_RETRY_CAP;
  assert.equal(whyOf('available', 4, null, 0), 'missing', 'nothing wrong with it: the sweep has not got to it');
  assert.equal(whyOf('held', 4, null, 0), 'held');
  assert.equal(whyOf('held', 4, null, cap), 'failed', 'a capped chapter that is also held is failed');
  assert.equal(whyOf('available', 4, null, cap - 1), 'missing', 'one try short of the cap is still being tried');
  assert.equal(whyOf('blocked', 4, null, cap), 'blocked', 'a number with no takeable copy is blocked whatever its ledger says');
  assert.equal(whyOf('blocked', 4, 10, cap), 'floor', 'below the floor nothing more specific may leak out of the run');
  assert.equal(whyOf('available', 10, 10, 0), 'missing', 'the floor itself is not below the floor');
  assert.equal(whyOf('held', 9.5, 10, 0), 'floor', 'a half chapter below the floor is below the floor');
});
