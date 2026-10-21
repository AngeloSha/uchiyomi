import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropSpot, moveTo, type Box } from '../lib/dragReorder';

// Four rows of 40 px stacked, 10 px apart: 0-40, 50-90, 100-140, 150-190, full width.
const column: Box[] = [0, 1, 2, 3].map((i) => ({ left: 0, right: 300, top: i * 50, bottom: i * 50 + 40 }));
// Five chips on two lines (three, then two), 60 wide: x 0-60, 70-130, 140-200; the second line the same.
const chip = (col: number, line: number): Box => ({ left: col * 70, right: col * 70 + 60, top: line * 30, bottom: line * 30 + 24 });
const flow: Box[] = [chip(0, 0), chip(1, 0), chip(2, 0), chip(0, 1), chip(1, 1)];

test('moveTo: the item ends at the index asked, the rest keep their order', () => {
  assert.deepEqual(moveTo(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveTo(['a', 'b', 'c', 'd'], 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveTo(['a', 'b', 'c', 'd'], 1, 2), ['a', 'c', 'b', 'd']);
});

test('moveTo: out of range or in place is an unchanged copy', () => {
  const l = ['a', 'b', 'c'];
  for (const r of [moveTo(l, 1, 1), moveTo(l, -1, 0), moveTo(l, 0, 3), moveTo(l, 5, 0)]) {
    assert.deepEqual(r, l);
    assert.notEqual(r, l);
  }
});

test('column: a pointer past the last row drops at the end, above the first at the start', () => {
  assert.deepEqual(dropSpot(column, 0, 100, 400, 'column'), { to: 3, beside: 3, side: 'after' });
  assert.deepEqual(dropSpot(column, 3, 100, -20, 'column'), { to: 0, beside: 0, side: 'before' });
});

test('column: the middle of a row is the line between before and after it', () => {
  // Dragging row 0: over the upper half of row 2 lands before it (index 1 among the others), the lower half after it.
  assert.deepEqual(dropSpot(column, 0, 100, 110, 'column'), { to: 1, beside: 2, side: 'before' });
  assert.deepEqual(dropSpot(column, 0, 100, 130, 'column'), { to: 2, beside: 3, side: 'before' });
});

test('column: dropping where the item already is changes nothing', () => {
  assert.equal(dropSpot(column, 1, 100, 70, 'column'), null);
  assert.equal(dropSpot(column, 0, 100, 5, 'column'), null);
  assert.equal(dropSpot(column, 3, 100, 900, 'column'), null);
});

test('column: a list of one has nothing to drop among', () => {
  assert.equal(dropSpot([column[0]], 0, 10, 10, 'column'), null);
  assert.equal(dropSpot([], 0, 10, 10, 'column'), null);
});

test('column: an item that is not on screen (no box) is skipped', () => {
  assert.deepEqual(dropSpot([column[0], null, column[2]], 0, 100, 500, 'column'), { to: 1, beside: 2, side: 'after' });
});

test('flow: on a line, the pointer goes between the chips on either side of it', () => {
  // Dragging chip 4 (second line): over the right half of chip 0 lands between chips 0 and 1.
  assert.deepEqual(dropSpot(flow, 4, 45, 10, 'flow'), { to: 1, beside: 1, side: 'before' });
  // The left half of chip 0 is before it.
  assert.deepEqual(dropSpot(flow, 4, 10, 10, 'flow'), { to: 0, beside: 0, side: 'before' });
});

test('flow: a pointer below a whole line is behind it', () => {
  // Dragging chip 0, pointer on the second line past its last chip: the end.
  assert.deepEqual(dropSpot(flow, 0, 400, 40, 'flow'), { to: 4, beside: 4, side: 'after' });
  // Between the lines, nothing on the second line is behind it yet but the whole first line is.
  assert.deepEqual(dropSpot(flow, 0, 10, 27, 'flow'), { to: 2, beside: 3, side: 'before' });
});

test('flow: the same line mirrors in a right-to-left page', () => {
  // On screen the first chip is at the right in Arabic; boxes are given as they are on screen.
  const rtl: Box[] = flow.map((b) => ({ ...b, left: 300 - b.right, right: 300 - b.left }));
  assert.deepEqual(dropSpot(rtl, 4, 255, 10, 'flow', true), { to: 1, beside: 1, side: 'before' });
  assert.deepEqual(dropSpot(rtl, 4, 290, 10, 'flow', true), { to: 0, beside: 0, side: 'before' });
});
