// Deciding which source may supply a series' missing chapters.
//
// The danger this file exists for: `downloadChapter` names its output purely from the chapter number, so a
// chapter taken from the WRONG series lands as `Chapter 47.cbz` exactly where the right one should be, looks
// identical in every listing, and is only found by opening it. There is no undo that a reader would think to
// reach for, because nothing looks broken.
//
// So the rules below are deliberately more willing to refuse than to guess, and each refusal has a name that
// is shown to the person rather than swallowed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gapsOf, assess, verdict, authorise, putPlan, getPlan, _clearPlans, planKey, MIN_COVERAGE, PLAN_TTL } from '../src/lib/fill';

const ch = (n: number) => ({ sourceId: `u/${n}`, number: n, title: `Chapter ${n}` });

test('the gap in the series that started this: chapter 0, then 93 onwards', () => {
  const have = [0, ...Array.from({ length: 49 }, (_, i) => 93 + i)];
  const gaps = gapsOf(have);
  assert.equal(gaps.length, 1);
  assert.deepEqual({ lo: gaps[0].lo, hi: gaps[0].hi, count: gaps[0].count }, { lo: 1, hi: 92, count: 92 });
});

test('a half chapter neither creates a gap nor hides one', () => {
  // 12.5 sitting between 12 and 13 must not make 13 look missing.
  assert.deepEqual(gapsOf([11, 12, 12.5, 13]), []);
  // and a real hole is still a hole when a half chapter sits beside it
  assert.deepEqual(gapsOf([11, 12.5, 15]).map((g) => [g.lo, g.hi]), [[13, 14]]);
});

test('a source carrying our numbering can fill the hole', () => {
  const have = [0, 93, 94, 95];
  const theirs = Array.from({ length: 96 }, (_, i) => i); // 0..95
  const a = assess(have, theirs);
  assert.equal(a.coverage, 1, 'it lists every chapter we hold');
  assert.equal(a.fillable.length, 92, 'and can supply 1..92');
  assert.equal(verdict(a, theirs.length), 'ok');
});

test('THE WRONG MANGA: a source that does not carry our numbers is refused', () => {
  // A long series that happens to exist. It covers none of our sparse high numbers.
  const have = [0, 93, 94, 95];
  const theirs = Array.from({ length: 60 }, (_, i) => i + 1); // 1..60
  const a = assess(have, theirs);
  assert.ok(a.coverage < MIN_COVERAGE, `coverage ${a.coverage} should fail the gate`);
  assert.equal(verdict(a, theirs.length), 'numbering_mismatch');
});

test('a renumbered source is refused, and the coverage says which kind of wrong it is', () => {
  // Right series, restarted numbering for a second season: offset, not unrelated.
  const have = [40, 41, 42, 43, 44, 45];
  const theirs = [1, 2, 3, 4, 5, 6, 7, 8];
  const a = assess(have, theirs);
  assert.equal(a.matched, 0);
  assert.equal(verdict(a, theirs.length), 'numbering_mismatch');
});

test('an unanchored run is not offered: that is extrapolation, not repair', () => {
  // We hold 1..5. They hold 1..20. 6..20 is not a gap, it is chapters we never got to.
  const a = assess([1, 2, 3, 4, 5], Array.from({ length: 20 }, (_, i) => i + 1));
  assert.deepEqual(a.fillable, [], 'nothing to repair');
  assert.deepEqual(a.newer, Array.from({ length: 15 }, (_, i) => i + 6), 'reported separately, opt-in');
  assert.equal(verdict(a, 20), 'nothing_to_fill');
});

test('a hole is only filled when BOTH its brackets are chapters they also have', () => {
  // We hold 1,2, 10,11. They hold 1,2, 5,6,7, 10,11 — but not 3,4,8,9.
  // They can supply 5,6,7 inside our 3..9 gap only because they hold 2 and 10, the chapters either side.
  const a = assess([1, 2, 10, 11], [1, 2, 5, 6, 7, 10, 11]);
  assert.deepEqual(a.fillable, [5, 6, 7]);
  // now take away one bracket: no longer a claim about the same stretch of the story
  const b = assess([1, 2, 10, 11], [1, 2, 5, 6, 7]);
  assert.deepEqual(b.fillable, [], 'without both brackets, nothing is offered');
});

test('a plan expires rather than lingering', () => {
  _clearPlans();
  const p = putPlan({ seriesId: 's1', folder: 'f', chapters: new Map(), candidates: [] });
  assert.ok(getPlan(p.id), 'live now');
  assert.equal(getPlan(p.id, Date.now() + PLAN_TTL + 1), null, 'gone after its window');
});

test('ONLY what the plan offered may be filled', () => {
  _clearPlans();
  const cand = {
    source: 'src', name: 'Src', sourceSeriesId: 'x', title: 'T', count: 3, first: 1, last: 3,
    coverage: 1, matched: 2, fillable: [2], newer: [], why: 'ok' as const, pinned: false,
  };
  const p = putPlan({
    seriesId: 's1', folder: 'f',
    chapters: new Map([[planKey('src', 'x'), [ch(2), ch(9)]]]),
    candidates: [cand],
  });

  assert.equal(authorise(p, 'src', 'x', [2], 100).ok, true, 'the offered one goes');

  const sneaky = authorise(p, 'src', 'x', [9], 100);
  assert.equal(sneaky.ok, false);
  assert.equal((sneaky as any).error, 'not_offered',
    'chapter 9 exists in the plan but was never offered, so it must be refused');

  const other = authorise(p, 'other', 'x', [2], 100);
  assert.equal(other.ok, false);
  assert.equal((other as any).error, 'not_in_plan', 'a source that was not a candidate cannot be filled from');

  const tooMany = authorise(p, 'src', 'x', [2], 0);
  assert.equal(tooMany.ok, false);
  assert.equal((tooMany as any).error, 'too_many');
});

test('a candidate that was shown as refused cannot then be filled from', () => {
  _clearPlans();
  const p = putPlan({
    seriesId: 's1', folder: 'f',
    chapters: new Map([[planKey('src', 'x'), [ch(2)]]]),
    candidates: [{
      source: 'src', name: 'Src', sourceSeriesId: 'x', title: 'T', count: 1, first: 2, last: 2,
      coverage: 0.1, matched: 1, fillable: [2], newer: [], why: 'numbering_mismatch', pinned: false,
    }],
  });
  const r = authorise(p, 'src', 'x', [2], 100);
  assert.equal(r.ok, false, 'the gate has to hold at fill time too, not only in the dialog');
  assert.equal((r as any).error, 'not_in_plan');
});
