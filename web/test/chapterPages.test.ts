// The chapter list pages over its merged rows and opens on the page holding "Continue".
import test from 'node:test';
import assert from 'node:assert/strict';
import { pageCount, pageOf, pageSlice, clampPage, pageLabel } from '../lib/chapterPages';
import type { Row } from '../lib/chapterRows';

const rows = Array.from({ length: 1193 }, (_, i) => i + 1); // One Piece, chapters 1..1193

test('page count rounds up and is never zero', () => {
  assert.equal(pageCount(1193, 100), 12);
  assert.equal(pageCount(100, 100), 1);
  assert.equal(pageCount(0, 100), 1);
});

test('opens on the page holding the target', () => {
  assert.equal(pageOf(rows, (n) => n === 956, 100), 9);
  assert.equal(pageOf(rows, (n) => n === 1, 100), 0);
  assert.equal(pageOf(rows, (n) => n === 1193, 100), 11);
  assert.equal(pageOf(rows, () => false, 100), 0);
});

test('slices past chapter 1000 and clamps a stale page', () => {
  assert.deepEqual(pageSlice(rows, 11, 100), rows.slice(1100));
  assert.deepEqual(pageSlice(rows, 99, 100), rows.slice(1100)); // filter shrank the list under the pager
  assert.equal(clampPage(-1, 1193, 100), 0);
  assert.equal(pageSlice([], 0, 100).length, 0);
});

const book = (n: number) => ({ kind: 'book', book: { id: `b${n}`, number: n } }) as unknown as Row;
const ghost = (n: number) => ({ kind: 'ghost', ghost: { number: n } }) as unknown as Row;
const run = (from: number, to: number) => ({ kind: 'run', why: 'floor', from, to, count: to - from + 1, open: false }) as Row;
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

test('a page is named by the chapters it shows, in the order it shows them', () => {
  const asc = range(1, 1193).map(book);
  assert.equal(pageLabel(asc, 0, true, 100), '1–100');
  assert.equal(pageLabel(asc, 11, true, 100), '1101–1193');
  // Newest first, the first page holds 1193..1094 and says so. Reintroduce by naming pages by row position:
  // this reads "1–100".
  assert.equal(pageLabel([...asc].reverse(), 0, false, 100), '1193–1094');
});

test('ghost and run rows are named by their chapters; row count is not chapter count', () => {
  // A run of ten older chapters, 50 books, a ghost at 60.5, 50 more books: 102 rows, 110 chapters.
  const asc = [run(1, 10), ...range(11, 60).map(book), ghost(60.5), ...range(61, 110).map(book)];
  assert.equal(pageLabel(asc, 0, true, 100), '1–108');
  assert.equal(pageLabel(asc, 1, true, 100), '109–110');
  const desc = [...asc].reverse();
  assert.equal(pageLabel(desc, 0, false, 100), '110–12');
  assert.equal(pageLabel(desc, 1, false, 100), '11–1', 'a run newest first reads from its top chapter down');
});

test('float noise from a real column is not shown, and an unnumbered page falls back to its position', () => {
  assert.equal(pageLabel([book(20.100000381), book(21)], 0, true, 100), '20.1–21');
  assert.equal(pageLabel([book(7)], 0, true, 100), '7');
  assert.equal(pageLabel([{ kind: 'more', hidden: 3 }], 0, true, 100), '1');
});
