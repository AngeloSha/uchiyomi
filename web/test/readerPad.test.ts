// A game controller in the reader (v0.61.0, lib/readerPad.ts): presses from polled state, a held page turn repeating
// like a held key, and nothing else ever repeating.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_PAD, PAD_IDLE, REPEAT_DELAY, REPEAT_EVERY, bindButton, cleanPadOverrides, padActions, padMapFor, pressedButton,
  unbindButton, type PadState,
} from '../lib/readerPad';
import type { ReaderAction } from '../lib/readerKeys';

/** Buttons down: the indices given. */
const down = (...i: number[]) => { const b = Array(17).fill(false); for (const k of i) b[k] = true; return b; };

/** Run frames 16 ms apart with `buttons(t)` down; every action that fired, with when. */
function run(ms: number, buttons: (t: number) => boolean[], axes: (t: number) => number[] = () => [0, 0]) {
  let prev = down();
  let state: PadState = PAD_IDLE;
  const out: { t: number; a: ReaderAction }[] = [];
  for (let t = 0; t <= ms; t += 16) {
    const now = buttons(t);
    const r = padActions(prev, now, axes(t), DEFAULT_PAD, t, state);
    prev = now;
    state = r.state;
    for (const a of r.actions) out.push({ t, a });
  }
  return out;
}

test('a press acts once, on the frame it goes down', () => {
  // Reintroduce level-triggering (act whenever a button is down): one press of A turns a page every frame.
  const r = run(200, (t) => (t >= 32 && t < 100 ? down(0) : down()));
  assert.deepEqual(r, [{ t: 32, a: 'next' }]);
  // Two presses, two turns.
  const twice = run(400, (t) => ((t >= 32 && t < 100) || (t >= 200 && t < 260) ? down(15) : down()));
  assert.deepEqual(twice.map((x) => x.a), ['pageRight', 'pageRight']);
});

test('a held page turn repeats after 400 ms, then every 150 ms', () => {
  const r = run(1000, () => down(13)).map((x) => x.t);
  assert.equal(r[0], 0, 'the press itself');
  assert.ok(r[1] >= REPEAT_DELAY && r[1] < REPEAT_DELAY + 16, `the first repeat came at ${r[1]} ms`);
  for (let k = 2; k < r.length; k++) assert.ok(r[k] - r[k - 1] >= REPEAT_EVERY && r[k] - r[k - 1] < REPEAT_EVERY + 16, `repeat ${k} came ${r[k] - r[k - 1]} ms after the last`);
  assert.ok(r.length >= 5, `only ${r.length} turns in a second held`);
});

test('nothing but a page turn ever repeats', () => {
  // Reintroduce repeating every action: a held shoulder button walks through chapter after chapter.
  for (const b of [4, 5, 9]) {
    const r = run(2000, () => down(b));
    assert.equal(r.length, 1, `button ${b} held for two seconds acted ${r.length} times`);
  }
});

test('the left stick is the D-pad', () => {
  const r = run(200, () => down(), (t) => (t >= 32 && t < 120 ? [0, 0.9] : [0, 0]));
  assert.deepEqual(r, [{ t: 32, a: 'next' }]);
  const left = run(200, () => down(), (t) => (t >= 32 ? [-0.8, 0] : [0, 0]));
  assert.deepEqual(left.map((x) => x.a), ['pageLeft']);
  assert.deepEqual(run(200, () => down(), () => [0.3, -0.3]), [], 'a stick barely leaning turned a page');
});

test('the default buttons, and a device\'s own', () => {
  assert.deepEqual(DEFAULT_PAD.nextChapter, [5]);
  assert.deepEqual(DEFAULT_PAD.prevChapter, [4]);
  assert.deepEqual(DEFAULT_PAD.menu, [9]);
  assert.deepEqual(DEFAULT_PAD.exit, [], 'a stray press must not leave the reader');
  const { overrides, from } = bindButton({}, 'exit', 1);
  assert.equal(from, 'prev', 'B moved from Previous page without saying so');
  assert.deepEqual(padMapFor(overrides).exit, [1]);
  assert.ok(!padMapFor(overrides).prev.includes(1));
  assert.deepEqual(unbindButton(overrides, 'exit', 1).exit, []);
  assert.deepEqual(cleanPadOverrides({ next: [0, 0, 3.5, -1, 40, 'a'], bogus: [1], prev: 2 }), { next: [0] }, 'junk survived storage');
  assert.equal(pressedButton(down(2), down(2, 7)), 7);
  assert.equal(pressedButton(down(2), down(2)), null);
});

test('the reader polls a controller only while one is connected, and only on a secure page', () => {
  // Reintroduce an always-running loop (requestAnimationFrame from mount): a reader with no controller polls 60 times a
  // second for nothing.
  const hook = readFileSync(join(__dirname, '..', 'lib/useGamepad.ts'), 'utf8');
  assert.match(hook, /window\.isSecureContext === true/, 'the controller is offered on a page the browser will not give one to');
  assert.match(hook, /const start = \(\) => \{ if \(!raf && firstPad\(\) && document\.visibilityState === 'visible'\) raf = requestAnimationFrame\(tick\); \};/);
  assert.match(hook, /if \(!p \|\| document\.visibilityState !== 'visible'\) \{ prev = \[\]; state = PAD_IDLE; return; \}/, 'the loop keeps running with no pad, or in a hidden tab');
  assert.match(hook, /window\.addEventListener\('gamepadconnected', start\);/);
  // The reader turns its presses through the same `perform` as a key.
  assert.match(readFileSync(join(__dirname, '..', 'app/reader/page.tsx'), 'utf8'), /useGamepad\(\(a\) => performRef\.current\(a\), padMap, showSettings \|\| showPages \|\| showChapters \|\| showKeys\)/);
});
