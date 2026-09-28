// The repair's worst case, from the code's own constants (lib/repairEstimate.ts). Pure, no database.
//
// The Health page promises "at most about N min of searching and waiting" before a press. These pin that the
// number is the SUM OF THE WAITS THE CODE BOUNDS -- not a figure someone typed -- and that downloads, which
// the code does not bound in time, stay a count.
import test from 'node:test';
import assert from 'node:assert/strict';
import { worstCase, SOLVER_STEP_MS, type EstimateLimits } from '../src/lib/repairEstimate';

// Round, distinct numbers, so a wrong term shows up as a wrong sum rather than a coincidence.
const L: EstimateLimits = {
  shortMax: 20, gapsMax: 5, huntBudget: 5, shortHuntMax: 2, gapChapters: 20, retrySeries: 10, shortCopies: 3,
  paceMs: 1_000, pageListMs: 20_000, listingRefreshMs: 10_000, listTimeoutMs: 30_000, huntWallMs: 60_000,
  solverBudgetMs: 90_000,
};

test('Fix on one chapter: a listing refresh, three page lists, one search and the found copy\'s page list', () => {
  assert.deepEqual(worstCase('fix_short', L), { boundedMs: 10_000 + 3 * 20_000 + 60_000 + 20_000, downloads: 1 });
  // Behind the solver a page list may take the solver's whole budget. Reintroduce by dropping the solver
  // branch: the two answers are equal.
  const behind = worstCase('fix_short', L, { solver: true });
  assert.equal(behind.boundedMs, 10_000 + 3 * 90_000 + 60_000 + 90_000);
  assert.notEqual(behind.boundedMs, worstCase('fix_short', L).boundedMs);
});

test('the chips and the card steps each follow their own bound', () => {
  assert.deepEqual(worstCase('fill', L), { boundedMs: 60_000 + 30_000, downloads: 20 });
  assert.deepEqual(worstCase('retry', L), { boundedMs: 10 * (30_000 + 1_000) + 5 * 60_000, downloads: 100 });
  assert.deepEqual(worstCase('steps:gaps', L), { boundedMs: 5 * 30_000 + 5 * 60_000, downloads: L.gapsMax * L.gapChapters },
    'the gap card downloads at most GAPS_MAX x GAP_CHAPTERS');
  assert.deepEqual(worstCase('steps:short', L), {
    boundedMs: 20 * (10_000 + 3 * 20_000) + 2 * (60_000 + 20_000), downloads: 20,
  });
  assert.deepEqual(worstCase('steps:short', L, { n: 3 }), {
    boundedMs: 3 * (10_000 + 3 * 20_000) + 2 * (60_000 + 20_000), downloads: 3,
  }, 'with fewer candidates than the cap, the candidates bound it');
  assert.deepEqual(worstCase('steps:failures:now', L), { boundedMs: 10 * 31_000, downloads: 100 });
  assert.deepEqual(worstCase('steps:failures', L), { boundedMs: 0, downloads: 0 }, 'the nightly reset asks nothing of anyone');
  assert.deepEqual(worstCase('steps:solver', L), { boundedMs: SOLVER_STEP_MS, downloads: 0 });
});

test('two hunting steps share one search budget, as the run does', () => {
  // Short hunts at most twice, gaps five times, and the run as a whole five: five walls, not seven, plus the
  // page list after each of the short step's two.
  const w = worstCase('steps:gaps+short', L);
  assert.equal(w.boundedMs, 20 * (10_000 + 3 * 20_000) + 5 * 30_000 + 5 * 60_000 + 2 * 20_000);
  assert.equal(w.downloads, 20 + 100);
});

test('a step the code bounds only by count makes the time unknown, never quietly shorter', () => {
  assert.equal(worstCase('full', L).boundedMs, null, 'the nightly counts pages and borrows names: "usually" only');
  assert.equal(worstCase('steps:count', L).boundedMs, null);
  assert.equal(worstCase('steps:count+solver', L).boundedMs, null);
  assert.deepEqual(worstCase('not-a-kind', L), { boundedMs: null, downloads: 0 });
});
