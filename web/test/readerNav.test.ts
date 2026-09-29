// Guards on leaving a chapter (lib/readerNav.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ARM_MS, NEAR_END_PAGES, pagesAfter, skipNeedsConfirm, stillArmed } from '../lib/readerNav';

test('skipping ahead from mid-chapter asks twice; the last pages do not', () => {
  assert.equal(skipNeedsConfirm(30), true);
  assert.equal(skipNeedsConfirm(NEAR_END_PAGES), true);
  assert.equal(skipNeedsConfirm(NEAR_END_PAGES - 1), false, 'one page left is finishing, not skipping');
  assert.equal(skipNeedsConfirm(0), false);
});

test('the arm lapses, and never arms itself', () => {
  assert.equal(stillArmed(null, 5000), false);
  assert.equal(stillArmed(1000, 1000 + ARM_MS), true);
  assert.equal(stillArmed(1000, 1000 + ARM_MS + 1), false);
});

test('pagesAfter counts only the current chapter', () => {
  const flow = [{ ci: 0 }, { ci: 0 }, { ci: 0 }, { ci: 1 }, { ci: 1 }];
  assert.equal(pagesAfter(flow, 0), 2);
  assert.equal(pagesAfter(flow, 2), 0, 'the next chapter\'s pages are not this chapter\'s');
  assert.equal(pagesAfter(flow, 9), 0);
});
