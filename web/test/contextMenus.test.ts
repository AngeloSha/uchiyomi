// #100: when a right-click opens the app's menu rather than the browser's, and where the menu goes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { placeMenu, wantsOwnMenu } from '../lib/contextMenus';

const click = (o: Partial<{ shiftKey: boolean; editable: boolean; selection: string; inSelection: boolean }> = {}) =>
  ({ shiftKey: false, editable: false, selection: '', inSelection: false, ...o });

test("the browser's menu is left alone where it is worth something", () => {
  assert.equal(wantsOwnMenu(click(), true), true, 'a plain right-click on a card opens ours');
  // Reintroduce by dropping any of these: the annoyance the proposal was careful about.
  assert.equal(wantsOwnMenu(click({ shiftKey: true }), true), false, 'Shift+right-click is the way to the real one');
  assert.equal(wantsOwnMenu(click({ editable: true }), true), false, 'a text field keeps paste');
  assert.equal(wantsOwnMenu(click({ selection: 'Romance Dawn', inSelection: true }), true), false, 'selected text keeps copy');
  assert.equal(wantsOwnMenu(click({ selection: 'elsewhere', inSelection: false }), true), true,
    'a selection somewhere else on the page is no reason to give up the menu on this card');
  assert.equal(wantsOwnMenu(click(), false), false, 'switched off on this device');
});

test('the menu opens at the point, and flips at the viewport edges', () => {
  const vp = { w: 400, h: 800 };
  const size = { w: 208, h: 200 };
  assert.deepEqual(placeMenu({ x: 50, y: 60 }, size, vp), { left: 50, top: 60 });
  // Near the right edge it opens to the LEFT of the point; near the bottom, above it.
  assert.deepEqual(placeMenu({ x: 390, y: 60 }, size, vp), { left: 182, top: 60 });
  assert.deepEqual(placeMenu({ x: 50, y: 790 }, size, vp), { left: 50, top: 590 });
});

test('it never leaves the screen or touches its edge, even when it cannot fit either side', () => {
  const r = placeMenu({ x: 100, y: 100 }, { w: 208, h: 900 }, { w: 400, h: 800 });
  assert.equal(r.top, 8, 'a menu taller than the screen starts at the margin');
  const l = placeMenu({ x: -50, y: 10 }, { w: 208, h: 100 }, { w: 400, h: 800 });
  assert.equal(l.left, 8, 'a ⋯ button near the left edge anchors the menu at the margin, not off screen');
});
