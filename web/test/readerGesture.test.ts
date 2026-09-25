// The reader's tap gesture, and the double-click that turned a page.
//
// The bug these cover: a single tap was acted on 40 ms BEFORE a second tap stopped counting as a double, so
// a double-click whose clicks were 260-300 ms apart zoomed AND turned the page. It was unreachable by a test
// while the two numbers lived inside a 1,300-line component, which is why lib/readerGesture.ts exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TAP_WINDOW_MS, UNDO_WINDOW_MS, isTap, readTap, singleTapDelay, tapZone, undoWindow,
} from '../lib/readerGesture';

const at = (t: number, x = 500, y = 400) => ({ x, y, t });
const tap = (t: number, x = 500) => ({ from: at(t, x), to: at(t + 30, x), width: 1000, lastTapAt: 0, doubleDetect: true });

test('a single tap may not act before a double can still arrive', () => {
  // The invariant the bug broke. Reintroduce by making the delay shorter than the window -- 260 against
  // 300, as it was -- and this fails with the exact overlap that let both actions run.
  assert.ok(singleTapDelay() >= TAP_WINDOW_MS, 'a tap must wait out the whole double-tap window');
});

test('the second tap of a pair zooms and nothing else', () => {
  const first = readTap(tap(1000));
  assert.equal(first.kind, 'single');
  // A second tap 280 ms later: inside the window, and -- because the first one has not acted yet -- the
  // only action this gesture produces.
  const second = readTap({ ...tap(1280 - 30), lastTapAt: 1000 });
  assert.equal(second.kind, 'double');
});

test('a tap just outside the window is a fresh single tap, not a double', () => {
  const r = readTap({ ...tap(1400 - 30), lastTapAt: 1000 });
  assert.equal(r.kind, 'single', '400 ms apart is two taps');
});

test('a mouse is never double-detected here', () => {
  // The OS owns the double-click interval; the reader listens for `dblclick` instead. Detecting it here as
  // well would zoom twice for one gesture -- straight back out again.
  const r = readTap({ ...tap(1280 - 30), lastTapAt: 1000, doubleDetect: false });
  assert.equal(r.kind, 'single');
});

test('a press that moved is a scroll, not a tap', () => {
  assert.equal(isTap(at(0, 500, 400), at(100, 500, 460)), false, 'dragged down the page');
  assert.equal(isTap(at(0, 500, 400), at(100, 508, 404)), true, 'a few pixels of wobble is still a tap');
});

test('a press that was held is a long press, not a tap', () => {
  assert.equal(isTap(at(0), at(TAP_WINDOW_MS + 1)), false);
});

test('the track is three zones, and the middle one is the chrome', () => {
  assert.equal(tapZone(100, 1000), 'back');
  assert.equal(tapZone(500, 1000), 'chrome');
  assert.equal(tapZone(900, 1000), 'forward');
  // Exactly on a boundary belongs to the middle: the edges are where a page turn is meant, and a tap that
  // lands on the line is not one.
  assert.equal(tapZone(300, 1000), 'chrome');
  assert.equal(tapZone(700, 1000), 'chrome');
});

test('a zero-width track does not divide by zero', () => {
  // Measured before layout, or in a headless test: answer the left edge rather than NaN, which would
  // compare false against every zone and silently drop the tap.
  assert.equal(tapZone(0, 0), 'back');
});

test('a dblclick takes back a click that has already acted, but not an old one', () => {
  // The mouse path: a slow OS double-click setting (Windows defaults to 500 ms) lets the single click act
  // first, so the reader undoes it when the browser finally says the two were one gesture.
  assert.equal(undoWindow(1000, 1000 + 480), true, 'a slow double-click is still one gesture');
  assert.equal(undoWindow(1000, 1000 + UNDO_WINDOW_MS + 1), false, 'a click from a minute ago stays done');
  assert.equal(undoWindow(null, 1000), false, 'nothing to take back');
});
