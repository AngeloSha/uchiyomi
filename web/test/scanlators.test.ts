// The two rules behind "Also follow this source" and the scanlator priority arrows, tested away from React.
//
// `followable` decides which Find-missing candidates get a follow button, and the threshold in it is the
// difference between the updater fetching a source's "chapter 47" into our 47 and fetching something else
// there. `reorder` is what the arrow buttons call; an off-by-one in it would silently drop a group from the
// ranking rather than fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FOLLOW_COVERAGE, followable, hasGroup, normGroup, reorder, withoutGroup } from '../lib/scanlators';

const cand = (over: Partial<{ pinned: boolean; coverage: number; why: string }> = {}) =>
  ({ pinned: false, coverage: 0.95, why: 'ok', ...over });

test('a matching, unpinned source that answered is followable', () => {
  assert.equal(followable(cand()), true);
  // Having nothing we are missing today is not a reason to refuse: it is the normal state of a source that
  // is exactly up to date with us, which is the one worth following.
  assert.equal(followable(cand({ why: 'nothing_to_fill' })), true);
  assert.equal(followable(cand({ coverage: FOLLOW_COVERAGE })), true, 'the threshold itself is inclusive');
});

test('the coverage threshold holds at 0.9', () => {
  // Reintroduce by changing FOLLOW_COVERAGE (or the literal in followable) to 0.5: "a 0.7 candidate is
  // followable" fails below.
  assert.equal(followable(cand({ coverage: 0.7 })), false, 'a 0.7 candidate is followable');
  assert.equal(followable(cand({ coverage: 0.89 })), false);
  assert.equal(FOLLOW_COVERAGE, 0.9, 'the threshold moved -- update the dialog copy and this test together');
});

test('the series own source, and every non-answer, is not followable', () => {
  // Reintroduce by dropping the `!c.pinned` term from followable: "the pinned source is followed by
  // definition" fails. Dropping the `why` clause instead fails the loop below at numbering_mismatch.
  assert.equal(followable(cand({ pinned: true })), false, 'the pinned source is followed by definition');
  for (const why of ['numbering_mismatch', 'no_chapters', 'blocked', 'unreachable', 'not_tried', 'disabled', 'something_new']) {
    assert.equal(followable(cand({ why })), false, `${why} at 0.95 coverage must not be followable`);
  }
});

test('reorder moves one step and copies', () => {
  const list = ['a', 'b', 'c'];
  assert.deepEqual(reorder(list, 1, -1), ['b', 'a', 'c']);
  assert.deepEqual(reorder(list, 1, 1), ['a', 'c', 'b']);
  assert.deepEqual(list, ['a', 'b', 'c'], 'the input was mutated');
  const same = reorder(list, 0, -1);
  assert.deepEqual(same, list, 'the first item moved up should stay put');
  assert.notEqual(same, list, 'a no-op still returns a copy, so setState sees a new value');
});

test('reorder refuses to step off either end or from nowhere', () => {
  // Reintroduce by deleting the bounds check in reorder: "the last item moved down" fails with an
  // `undefined` swapped into the list, which is what the arrow at the bottom of a ranking would then save.
  const list = ['a', 'b', 'c'];
  assert.deepEqual(reorder(list, 2, 1), list, 'the last item moved down');
  assert.deepEqual(reorder(list, 3, -1), list);
  assert.deepEqual(reorder(list, -1, 1), list);
  assert.deepEqual(reorder([], 0, 1), []);
});

test('group equality matches the server', () => {
  // The server (bff/src/lib/releases.ts normGroup) folds case, width and punctuation. If this drifted, a
  // group already blocked on the server would get a second, unblocked-looking row here.
  // Reintroduce by dropping `.normalize('NFKC')` from normGroup: "full-width letters fold" fails.
  assert.equal(normGroup('Asura Scans'), 'asurascans');
  assert.equal(normGroup('asura-scans'), 'asurascans');
  assert.equal(normGroup('ＡＳＵＲＡ'), 'asura', 'full-width letters fold');
  assert.equal(normGroup(''), '');
  assert.equal(hasGroup(['Asura Scans'], 'asura_scans'), true);
  assert.equal(hasGroup(['Asura Scans'], 'Flame'), false);
  assert.deepEqual(withoutGroup(['Asura Scans', 'Flame'], 'ASURA-SCANS'), ['Flame']);
});
