// The chapter list pages over its merged rows and opens on the page holding "Continue".
import test from 'node:test';
import assert from 'node:assert/strict';
import { pageCount, pageOf, pageSlice, clampPage } from '../lib/chapterPages';

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
