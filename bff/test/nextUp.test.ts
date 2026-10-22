// "Only tell me about a new chapter when it is the one I'd read next": the rule (lib/nextUpRule.ts), on plain rows. The same
// rule is held to the series page's reading button in web/test/nextUpParity.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextUpIn, nextUpNumber, type NextUpRow } from '../src/lib/nextUpRule';

const b = (number: number, done = false, page = 0, pruned = false): NextUpRow => ({ number, done, page, pruned });

test('caught up: the new chapter is next', () => {
  assert.equal(nextUpIn([b(1, true), b(2, true), b(3)], [3]), true);
});

test('an older unread chapter after the highest finished one is next, not the new one', () => {
  assert.equal(nextUpIn([b(1, true), b(2), b(3)], [3]), false, 'chapter 2 is next');
  assert.equal(nextUpIn([b(1, true), b(2), b(3), b(4)], [3, 4]), false);
});

test('a chapter skipped BEFORE the highest finished one does not count', () => {
  assert.equal(nextUpIn([b(1, true), b(2), b(3, true), b(4)], [4]), true);
});

test('a part-read chapter is the one to continue, so nothing new is next', () => {
  assert.equal(nextUpIn([b(1, true), b(2, false, 5), b(3)], [3]), false);
  // Page 0 is "Mark unread", not reading.
  assert.equal(nextUpIn([b(1, true), b(2, true), b(3, false, 0)], [3]), true);
});

test('nothing read: only the first chapter is next', () => {
  assert.equal(nextUpIn([b(1), b(2), b(3)], [3]), false);
  assert.equal(nextUpIn([b(1)], [1]), true);
});

test('chapters that landed together: the lowest of them being next is enough', () => {
  assert.equal(nextUpIn([b(1, true), b(2), b(3)], [2, 3]), true);
});

test('a chapter whose file the server let go still says how far the reader is, and is never the one to open', () => {
  // 1 and 2 read, then pruned; 3 is new: caught up.
  assert.equal(nextUpIn([b(1, true, 0, true), b(2, true, 0, true), b(3)], [3]), true);
  // The highest finished one is pruned: an unread chapter below it is NOT next (the button says Next after it).
  assert.equal(nextUpIn([b(1), b(2, true, 0, true), b(3)], [3]), true);
  // An unread pruned chapter after the highest finished is skipped, it cannot be opened.
  assert.equal(nextUpIn([b(1, true), b(2, false, 0, true), b(3)], [3]), true);
});

test('with nothing after the highest finished one, the lowest unread chapter is next (a back-filled chapter)', () => {
  assert.deepEqual(nextUpNumber([b(1, true), b(2), b(3, true)]), { kind: 'next', number: 2 });
  assert.equal(nextUpIn([b(1, true), b(2), b(3, true)], [2]), true);
});

test('everything read, or nothing to open: no chapter is next', () => {
  assert.equal(nextUpNumber([b(1, true), b(2, true)]), null);
  assert.equal(nextUpNumber([b(1, false, 0, true)]), null);
  assert.equal(nextUpNumber([]), null);
  assert.equal(nextUpIn([b(1, true)], [1]), false);
});

test('half-numbers match within a thousandth', () => {
  assert.equal(nextUpIn([b(1, true), b(1.5)], [1.5]), true);
});
