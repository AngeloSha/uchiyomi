// The reader's tap gesture, and the double-click that turned a page.
//
// The bug these cover: a single tap was acted on 40 ms BEFORE a second tap stopped counting as a double, so
// a double-click whose clicks were 260-300 ms apart zoomed AND turned the page. It was unreachable by a test
// while the two numbers lived inside a 1,300-line component, which is why lib/readerGesture.ts exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  TAP_WINDOW_MS, UNDO_WINDOW_MS, isTap, readTap, singleTapDelay, tapZone, undoLeft, undoWindow,
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

// v0.61.0: tapZone takes the tap's height and the device's tap layout too (Reader → Tap zones). These two keep their
// cases, updated deliberately to the new arguments: the thirds are `auto` in paged mode, the default, unchanged.
test('the track is three zones, and the middle one is the chrome', () => {
  assert.equal(tapZone(100, 400, 1000, 800), 'back');
  assert.equal(tapZone(500, 400, 1000, 800), 'chrome');
  assert.equal(tapZone(900, 400, 1000, 800), 'forward');
  // Exactly on a boundary belongs to the middle: the edges are where a page turn is meant, and a tap that
  // lands on the line is not one.
  assert.equal(tapZone(300, 400, 1000, 800), 'chrome');
  assert.equal(tapZone(700, 400, 1000, 800), 'chrome');
});

test('a zero-width track does not divide by zero', () => {
  // Measured before layout, or in a headless test: answer the left edge rather than NaN, which would
  // compare false against every zone and silently drop the tap.
  assert.equal(tapZone(0, 0, 0, 0), 'back');
  for (const layout of ['auto', 'edges', 'lshape', 'kindle', 'off'] as const) {
    assert.ok(['back', 'forward', 'prev', 'next', 'chrome'].includes(tapZone(0, 0, 0, 0, layout)), `${layout} answers nothing on a zero-size track`);
  }
});

test('a dblclick takes back a click that has already acted, but not an old one', () => {
  // The mouse path: a slow OS double-click setting (Windows defaults to 500 ms) lets the single click act
  // first, so the reader undoes it when the browser finally says the two were one gesture.
  assert.equal(undoWindow(1000, 1000 + 480), true, 'a slow double-click is still one gesture');
  assert.equal(undoWindow(1000, 1000 + UNDO_WINDOW_MS + 1), false, 'a click from a minute ago stays done');
  assert.equal(undoWindow(null, 1000), false, 'nothing to take back');
});

test('a turn is held from progress for exactly as long as it can still be undone', () => {
  // The reader holds a tapped turn's progress for undoLeft ms. Were the hold shorter than the undo window,
  // a slow double-click could turn onto a chapter's last page, send "completed", and only then be undone.
  for (let d = 0; d <= UNDO_WINDOW_MS + 5; d++) {
    assert.equal(undoLeft(1000, 1000 + d) > 0, undoWindow(1000, 1000 + d), `disagree ${d} ms after the click`);
  }
  assert.equal(undoLeft(null, 1000), 0, 'nothing acted, nothing held');
  assert.equal(undoLeft(1000, 1000 + 200), UNDO_WINDOW_MS + 1 - 200);
});

test('a press right behind a double is the tail of that flurry, not a fresh single', () => {
  // Reintroduce by dropping the lastDoubleAt check: a triple-click zoomed, then turned a page 300 ms later.
  const behind = readTap({ ...tap(2000), lastDoubleAt: 1900 });
  assert.equal(behind.kind, 'none');
  const later = readTap({ ...tap(2000), lastDoubleAt: 1000 });
  assert.equal(later.kind, 'single', 'a press after the window is an ordinary tap again');
});

// ---- v0.61.0, Reader → Tap zones ----

/** v0.60's tapZone, kept here as the reference: `auto` must be exactly it. */
const oldThirds = (x: number, width: number) => {
  const w = Math.max(1, width);
  if (x < w * 0.3) return 'back';
  if (x > w * 0.7) return 'forward';
  return 'chrome';
};

test('Automatic is the reader as it was: the thirds when paged, the controls in the column', () => {
  // Reintroduce the thirds in the webtoon column under `auto`: the column starts turning on taps it never turned on.
  for (let x = 0; x <= 1000; x += 5) {
    for (const y of [0, 333, 500, 999]) {
      assert.equal(tapZone(x, y, 1000, 1000, 'auto', 'paged'), oldThirds(x, 1000), `paged (${x}, ${y})`);
      assert.equal(tapZone(x, y, 1000, 1000, 'auto', 'vertical'), 'chrome', `vertical (${x}, ${y})`);
    }
  }
  // And readTap with no layout given is Automatic in paged mode.
  const r = readTap({ from: at(1000, 100), to: at(1030, 100), width: 1000, lastTapAt: 0, doubleDetect: true });
  assert.deepEqual(r, { kind: 'single', zone: 'back', after: singleTapDelay() });
});

test('Edges are the thirds in both modes', () => {
  for (const mode of ['paged', 'vertical'] as const) {
    assert.equal(tapZone(100, 500, 1000, 1000, 'edges', mode), 'back');
    assert.equal(tapZone(500, 500, 1000, 1000, 'edges', mode), 'chrome');
    assert.equal(tapZone(900, 500, 1000, 1000, 'edges', mode), 'forward');
  }
});

/** A layout as its 3 x 3 grid, row by row: B back, F forward, P prev, N next, M the controls. */
const grid = (layout: 'lshape' | 'kindle' | 'off' | 'edges', mode: 'paged' | 'vertical' = 'paged') => {
  const letter = { back: 'B', forward: 'F', prev: 'P', next: 'N', chrome: 'M' } as const;
  return [0, 1, 2].map((r) => [0, 1, 2].map((c) => letter[tapZone(c * 300 + 150, r * 300 + 150, 900, 900, layout, mode)]).join('')).join('/');
};

test('the L shape and the Kindle-style map are Mihon\'s, and in reading order', () => {
  // Reintroduce physical zones for the L (back/forward): a right-to-left read turns forward from the top row.
  assert.equal(grid('lshape'), 'PPP/PMN/NNN');
  assert.equal(grid('lshape', 'vertical'), 'PPP/PMN/NNN', 'the L is the same in the column');
  assert.equal(grid('kindle'), 'MMM/PNN/PNN');
  assert.equal(grid('off'), 'MMM/MMM/MMM');
  assert.equal(grid('edges'), 'BMF/BMF/BMF');
  // readTap hands its height and layout on.
  const r = readTap({ from: { x: 450, y: 850, t: 1000 }, to: { x: 450, y: 850, t: 1030 }, width: 900, height: 900, layout: 'lshape', lastTapAt: 0, doubleDetect: true });
  assert.deepEqual(r, { kind: 'single', zone: 'next', after: singleTapDelay() });
});

test('the reader turns a physical zone through the track\'s direction and a reading-order zone as it is', () => {
  // runTap's mapping: back and forward are the page to the left and to the right (perform turns them through the
  // track's sign); prev and next are actions of their own. Reintroduce `perform(zone === 'back' ? 'prev' : 'next')`:
  // a right-to-left read turns backwards from the right edge.
  const src = readFileSync(join(__dirname, '..', 'app/reader/page.tsx'), 'utf8');
  assert.match(src, /perform\(zone === 'back' \? 'pageLeft' : zone === 'forward' \? 'pageRight' : zone, \{ tap: true \}\);/);
  assert.match(src, /const d = action === 'next' \? 1 : action === 'prev' \? -1 : \(action === 'pageRight' \? 1 : -1\) \* trackSign;/);
  // A tapped step down the column can be taken back by a double-click, and is held from progress until then.
  assert.match(src, /if \(o\.tap\) acted\.current = \{ kind: 'scroll', top: el\.scrollTop, at: Date\.now\(\) \};/);
  assert.match(src, /else if \(a\.kind === 'scroll' && el\) el\.scrollTo\(\{ top: a\.top \}\);/);
  assert.match(src, /const hold = a\?\.kind === 'turn' \|\| a\?\.kind === 'scroll' \? undoLeft\(a\.at, Date\.now\(\)\) : 0;/);
});
