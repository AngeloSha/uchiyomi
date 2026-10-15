// Guards on leaving a chapter (lib/readerNav.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ARM_MS, NEAR_END_PAGES, chapterGap, pagesAfter, skipNeedsConfirm, stillArmed } from '../lib/readerNav';

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

test('chapterGap names the whole chapters skipped between neighbours', () => {
  assert.deepEqual(chapterGap(43, 100), { first: 44, last: 99 });
  assert.deepEqual(chapterGap(100, 102), { first: 101, last: 101 });
  assert.deepEqual(chapterGap(10.5, 12), { first: 11, last: 11 });
  assert.equal(chapterGap(43, 44), null);
  assert.equal(chapterGap(10, 10.5), null);
  assert.equal(chapterGap(10.5, 11), null);
  assert.equal(chapterGap(5, 5), null);
  assert.equal(chapterGap(9, 3), null, 'an order that does not run forward warns of nothing');
  assert.equal(chapterGap(undefined, 3), null);
  assert.equal(chapterGap(3, null), null);
  assert.equal(chapterGap(NaN, 3), null);
});

test('the reader says so when the chapter it moves to skips numbers, as the next one joins and on Next', () => {
  const src = readFileSync(join(__dirname, '..', 'app/reader/page.tsx'), 'utf8');
  // Reintroduce by dropping either call: the reader moves over a hole in silence.
  assert.match(src, /if \(outcome === 'ok'\) warnGap\(last\?\.id, next\.id\);/);
  assert.match(src, /warnGap\(activeChapter\?\.id, nextId\); goChapter\(nextId\)/);
});
