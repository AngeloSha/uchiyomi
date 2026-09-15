// The "first N" / "latest N" chapter selection at add time.
//
// Adapters return chapters ascending, so the old `chapters.slice(0, chapterCount)` silently meant the OLDEST
// N. The docs said "most recent", the dialog said "First", and a person catching up on a 200-chapter series
// who asked for 25 was handed 1..25. This pins both directions and the shape of the result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectChapters } from '../src/lib/selectChapters';

const ten = Array.from({ length: 10 }, (_, i) => i + 1);

test('oldest is the head of the ascending list, as first N always was', () => {
  assert.deepEqual(selectChapters(ten, 3, 'oldest'), [1, 2, 3]);
  assert.deepEqual(selectChapters(ten, 3), [1, 2, 3], 'and it is the default, so every existing caller is unchanged');
});

// Reintroduce by dropping the `from` branch (always `chapters.slice(0, count)`): the newest assertion below
// reads [1, 2, 3] instead of [8, 9, 10].
test('newest is the tail, still ascending so the download meets them in reading order', () => {
  assert.deepEqual(selectChapters(ten, 3, 'newest'), [8, 9, 10]);
});

test('no count, a zero count, or an oversize count means everything', () => {
  assert.deepEqual(selectChapters(ten, undefined), ten);
  assert.deepEqual(selectChapters(ten, 0), ten);
  assert.deepEqual(selectChapters(ten, 50, 'newest'), ten);
  assert.deepEqual(selectChapters(ten, 50, 'oldest'), ten);
});

// Reintroduce by moving the `from === 'none'` return in selectChapters below the count line: with no count,
// or a count past the list, "nothing" reads as "everything" and the first assertion sees all ten.
test('none selects nothing whatever the count', () => {
  assert.deepEqual(selectChapters(ten, undefined, 'none'), []);
  assert.deepEqual(selectChapters(ten, 0, 'none'), []);
  assert.deepEqual(selectChapters(ten, 3, 'none'), []);
  assert.deepEqual(selectChapters(ten, 50, 'none'), []);
  assert.deepEqual(selectChapters([], undefined, 'none'), []);
});
