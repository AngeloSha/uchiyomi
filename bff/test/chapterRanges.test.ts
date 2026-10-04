// A file holding several chapters, without a database (lib/chapterRanges.ts): the JS twin the have-sets use, the
// display string, and the rules the SQL fragments carry. chapterRanges.int.test.ts runs them against Postgres.
import test from 'node:test';
import assert from 'node:assert/strict';
import { heldBy, numberText, isRange, rangeEnd, holds } from '../src/lib/chapterRanges';
import { MAX_RANGE } from '../src/lib/naming';

test('heldBy: a book holds its number, and a range every number from its start to its end', () => {
  const held = heldBy([{ number: 1, end: 7 }, { number: 8 }, { number: 10, end: null }]);
  for (const n of [1, 2, 3.5, 7, 8, 10]) assert.equal(held.has(n), true, `${n} is held`);
  for (const n of [0, 0.5, 7.5, 9, 11]) assert.equal(held.has(n), false, `${n} is not held`);
  // pg hands a `real` back as a string through some paths: the numbers are read, not compared as text.
  assert.equal(heldBy([{ number: '1', end: '7' }]).has(5), true);
});

test('heldBy: an end not above the number, or past MAX_RANGE, is no range', () => {
  // What a v0.55.1 scan leaves after a rollback: the number rewritten, the end untouched (lib/chapterRanges.ts).
  // Reintroduce by trusting every end: 500 is held by a "range" a thousand and one wide.
  assert.equal(heldBy([{ number: 1987, end: 7 }]).has(1000), false);
  assert.equal(heldBy([{ number: 1, end: 2 + MAX_RANGE }]).has(500), false);
  assert.equal(heldBy([{ number: 1, end: 1 + MAX_RANGE }]).has(500), true);
});

test('numberText: the range as it is read out, else the number', () => {
  assert.equal(numberText(1, 7), '1–7');
  assert.equal(numberText(12.5, null), '12.5');
  assert.equal(numberText(12, undefined), '12');
  assert.equal(numberText(1987, 7), '1987', 'an end not above the number says nothing');
});

test('the SQL fragments carry the same rules', () => {
  // Never NULL, so `NOT isRange(b)` keeps a single chapter (whose number_end IS NULL) rather than dropping it.
  assert.match(isRange('b'), /^COALESCE\(.*, false\)$/);
  assert.match(isRange('b'), new RegExp(`b\\.number_end <= b\\.number \\+ ${MAX_RANGE}`));
  // An admin's number replaces the range: the end is read only while there is none.
  assert.match(rangeEnd('b', 'ov'), /ov\.number IS NULL AND/);
  // holds: the override-aware number, or the range.
  assert.match(holds('b', 'ov', 'l.number'), /^\(COALESCE\(ov\.number, b\.number\) = l\.number OR l\.number BETWEEN b\.number AND /);
});
