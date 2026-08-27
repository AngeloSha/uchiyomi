// The hero's position dots, once there are more slides than room for them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dotWindow } from '../lib/carousel';

test('a short carousel shows every dot', () => {
  assert.deepEqual(dotWindow(3, 1).items, [0, 1, 2]);
  assert.equal(dotWindow(3, 1).moreBefore, false);
  assert.equal(dotWindow(3, 1).moreAfter, false);
});

test('THE OVERFLOW: the dot row is a fixed width whatever the slide count', () => {
  // The hero went from 5 slides to 10. One dot per slide put ~130px of dots on the same row as a padded
  // button inside a padded container, and the browser suite fails Discover on any horizontal overflow at
  // phone width. A window decouples slide count from layout entirely.
  //
  // Reintroduce by returning every index regardless of `total`: the length assertion below fails at once.
  for (const active of [0, 3, 7, 9]) {
    assert.equal(dotWindow(10, active).items.length, 5, `active=${active} drew a different number of dots`);
  }
  assert.equal(dotWindow(40, 20).items.length, 5, 'forty slides must still draw five dots');
});

test('the window never runs off either end', () => {
  // Reintroduce by dropping the clamp (`Math.min(..., total - max)`): active=9 yields [7,8,9,10,11], and
  // indices 10 and 11 do not exist, so the hero would crash reading slides[k].title.
  const first = dotWindow(10, 0);
  assert.deepEqual(first.items, [0, 1, 2, 3, 4]);
  assert.equal(first.moreBefore, false, 'nothing precedes the first slide');
  assert.equal(first.moreAfter, true);

  const last = dotWindow(10, 9);
  assert.deepEqual(last.items, [5, 6, 7, 8, 9]);
  assert.equal(last.moreAfter, false, 'nothing follows the last slide');
  assert.equal(last.moreBefore, true);

  for (const active of [0, 1, 5, 8, 9]) {
    for (const k of dotWindow(10, active).items) {
      assert.ok(k >= 0 && k < 10, `active=${active} produced out-of-range index ${k}`);
    }
  }
});

test('the window follows the active slide once it leaves the middle', () => {
  assert.deepEqual(dotWindow(10, 5).items, [3, 4, 5, 6, 7]);
  assert.ok(dotWindow(10, 5).items.includes(5), 'the active slide must always have a dot');
  for (let a = 0; a < 10; a++) assert.ok(dotWindow(10, a).items.includes(a), `active ${a} had no dot`);
});
