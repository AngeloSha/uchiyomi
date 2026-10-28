import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEME_FILTER } from '../lib/readerPrefs';

// The page tones are CSS filter chains, so what a white page turns into is arithmetic: the W3C filter-effects matrices,
// clamped to 0..1 after each function as a browser does.
type V = [number, number, number];
const clamp = (v: number[]): V => v.map((x) => Math.min(1, Math.max(0, x))) as V;
const mul = (m: number[][], c: V): V => clamp(m.map((r) => r[0] * c[0] + r[1] * c[1] + r[2] * c[2]));
const FN: Record<string, (c: V, a: number) => V> = {
  brightness: (c, a) => clamp(c.map((x) => x * a)),
  sepia: (c, amt) => { const a = 1 - amt; return mul([[0.393 + 0.607 * a, 0.769 - 0.769 * a, 0.189 - 0.189 * a], [0.349 - 0.349 * a, 0.686 + 0.314 * a, 0.168 - 0.168 * a], [0.272 - 0.272 * a, 0.534 - 0.534 * a, 0.131 + 0.869 * a]], c); },
  saturate: (c, s) => mul([[0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s], [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s], [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s]], c),
  grayscale: (c, a) => { const m = 1 - a; return mul([[0.2126 + 0.7874 * m, 0.7152 - 0.7152 * m, 0.0722 - 0.0722 * m], [0.2126 - 0.2126 * m, 0.7152 + 0.2848 * m, 0.0722 - 0.0722 * m], [0.2126 - 0.2126 * m, 0.7152 - 0.7152 * m, 0.0722 + 0.9278 * m]], c); },
};
const run = (filter: string, c: V): V => {
  let out = c;
  for (const m of filter.matchAll(/(\w+)\(([\d.]+)\)/g)) { const f = FN[m[1]]; assert.ok(f, `test knows ${m[1]}()`); out = f(out, Number(m[2])); }
  return out;
};
const rgb = (v: V) => v.map((x) => Math.round(x * 255));

test('Paper turns a white page into light cream paper and leaves black alone', () => {
  const [r, g, b] = rgb(run(THEME_FILTER.paper, [1, 1, 1]));
  // About #F0E8D8: red above green above blue, each within a few steps of it.
  assert.ok(Math.abs(r - 240) <= 3 && Math.abs(g - 232) <= 3 && Math.abs(b - 216) <= 3, `white became ${r},${g},${b}`);
  assert.deepEqual(rgb(run(THEME_FILTER.paper, [0, 0, 0])), [0, 0, 0]);
});

test('Paper keeps the ordering that makes it paper: red > green > blue at every grey, and no clipping at white', () => {
  for (const level of [0.2, 0.5, 0.8, 1]) {
    const [r, g, b] = run(THEME_FILTER.paper, [level, level, level]);
    assert.ok(r > g && g > b, `at grey ${level}: ${rgb([r, g, b])}`);
  }
  assert.ok(run(THEME_FILTER.paper, [1, 1, 1])[0] < 1, 'red is not pinned at 1, or the tint would be lost in the highlights');
});

test('Paper is gentler than Sepia: its white is lighter and less yellow', () => {
  const [pr, pg, pb] = rgb(run(THEME_FILTER.paper, [1, 1, 1]));
  const [sr, sg, sb] = rgb(run(THEME_FILTER.sepia, [1, 1, 1]));
  assert.ok(pr - pb < sr - sb || sg === sr, 'sepia clips red and green together at white');
  assert.equal(sr, sg, 'Sepia white has red equal to green (a yellow-green cream), which is why Paper exists');
  assert.ok(pg < pr, 'Paper white keeps green under red');
});
