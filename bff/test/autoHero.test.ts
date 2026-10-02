// Automatic hero banners (v0.51.0, lib/autoHero.ts): the parts that decide, on pixels and numbers.
//
// The scoring is pure on purpose, so what it prefers can be pinned here rather than only judged by eye on the
// owner's library: a window a third paper (a gutter) is refused outright, a text box loses to drawn art because of
// what makes it a text box, and the same seed always picks the same chapters and pages.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import type { Pixels, Candidate } from '../src/lib/autoHero';
import { runtime } from '../src/lib/runtime';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

// lib/autoHero imports the database module, which refuses to load without DATABASE_URL: imported after it.
let h: typeof import('../src/lib/autoHero');
before(async () => { h = await import('../src/lib/autoHero'); });

const W = 256;
/** One third of a test page, in rows: a window of the strip's shape at full width (256 / 0.745) fits in it. */
const BAND = 344;

/** Drawn art: three colour waves that move independently, and soft diagonal hatching. No paper, no flat fill. */
function art(px: Uint8Array, y0: number, y1: number) {
  for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3, hatch = (x + y) % 9 < 2 ? 30 : 0;
    px[i] = 120 + 90 * Math.sin(x / 13 + y / 29) - hatch;
    px[i + 1] = 110 + 80 * Math.cos(y / 11 - x / 31) - hatch;
    px[i + 2] = 120 + 90 * Math.sin((x + y) / 17) - hatch;
  }
}
/** A game-system text box: a flat blue fill and rows of small white glyphs, the Solo Bug Player kind. */
function textBox(px: Uint8Array, y0: number, y1: number) {
  for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    // 7-pixel glyphs on 16-pixel lines, 8 pixels apart: a vertical stroke, and a bar at the top, middle and bottom.
    const ly = (y - y0) % 16, gx = x % 8;
    const glyph = ly < 7 && gx < 5 && (gx === 0 || gx === 4 || ly === 0 || ly === 3 || ly === 6) && ((x >> 3) + (y >> 4)) % 2 === 0;
    const [r, g, b] = glyph ? [250, 250, 250] : [40, 90, 200];
    px[i] = r; px[i + 1] = g; px[i + 2] = b;
  }
}
/** Paper over rows [y0, y1) and columns [x0, x1). */
const paper = (px: Uint8Array, y0: number, y1: number, x0 = 0, x1 = W) => {
  for (let y = y0; y < y1; y++) px.fill(255, (y * W + x0) * 3, (y * W + x1) * 3);
};
/** Where the speech bubble of the first band sits: the middle of it, clear of every side. */
const BUBBLE = { y0: Math.round(BAND * 0.3), y1: Math.round(BAND * 0.7), x0: W / 4, x1: (3 * W) / 4 };

/**
 * A page of four bands, top to bottom: art with a speech bubble in it, art, a text box, and art under a white gutter
 * a third of the band deep. The plain art is second, clear of the 8 % edges.
 */
function page(): Pixels {
  const data = new Uint8Array(W * BAND * 4 * 3);
  art(data, 0, 2 * BAND);
  paper(data, BUBBLE.y0, BUBBLE.y1, BUBBLE.x0, BUBBLE.x1);
  textBox(data, 2 * BAND, 3 * BAND);
  art(data, 3 * BAND, 4 * BAND);
  paper(data, 3 * BAND, 3 * BAND + Math.round(BAND / 3));
  return { data, width: W, height: 4 * BAND, channels: 3 };
}

test('a white-gutter window and a text-box window lose to an art window', () => {
  const g = h.pageGrid(page());
  const band = BAND / g.block, cols = g.cols, rows = Math.round(cols / (477 / 640));
  const at = (r0: number) => h.scoreFeatures(h.windowFeatures(g, 0, r0, cols, rows), g.grey);
  const artScore = at(band);
  assert.ok(Number.isFinite(artScore) && artScore > 0, `the art scores (${artScore})`);
  // The Heavenly Path crop: the top third of the window a white gutter. Never used.
  assert.equal(at(3 * band), -Infinity, 'a window under a white gutter must never be used');
  // A speech bubble a fifth of the window, touching none of its sides, is refused for its paper alone. Reintroduce by
  // dropping the whiteCap test in scoreFeatures: it scores.
  assert.equal(at(0), -Infinity, 'a window a fifth paper must never be used');
  // So is a window whose edge runs along paper, however little of it there is: here the top edge cuts through the
  // bottom of that bubble, under 3 % white in all. Reintroduce by dropping the gutterCap test: it scores.
  assert.equal(at(Math.floor(BUBBLE.y1 / g.block) - 2), -Infinity, 'a window whose edge cuts through a bubble must never be used');
  // The box has the colour and the edges to outbid the art, and less white than the cap; what sinks it is what makes
  // it a text box -- the flat fill, the white strokes on it (glare) and the lettering cells. Reintroduce by dropping
  // those three terms from scoreFeatures: the box wins.
  const boxScore = at(2 * band);
  assert.ok(boxScore < artScore, `the text box (${boxScore.toFixed(2)}) must lose to the art (${artScore.toFixed(2)})`);
  // And the scan over the whole page lands on the plain art, the second band.
  const best = h.bestWindow(g, 720);
  assert.ok(best && Math.abs(best.y - 1 / 4) < 0.02, `the best window starts at ${best?.y.toFixed(2)}, not on the art`);
});

test('the same seed picks the same chapters and pages; another seed picks others', () => {
  // Reintroduce by drawing from Math.random in spread(): the first two assertions fail.
  assert.deepEqual(h.samplePlan(180, 48271), h.samplePlan(180, 48271));
  assert.deepEqual(h.pagePlan(40, 6, h.rng(48271)), h.pagePlan(40, 6, h.rng(48271)));
  assert.notDeepEqual(h.samplePlan(180, 48271), h.samplePlan(180, 7));
  // Seed 0 is the banner every series starts with: the middle of each stretch, no chance involved.
  assert.deepEqual(h.samplePlan(180, 0), h.samplePlan(180, 0));
  // Never a chapter's first or last two pages, where the credits sit.
  for (const p of h.pagePlan(12, 6, h.rng(3))) assert.ok(p >= 2 && p <= 9, `page ${p} of 12 is a credits page`);
});

test('four crops from four chapters while there are good ones, and never one under the floor', () => {
  const c = (chapter: number, page: number, score: number): Candidate =>
    ({ chapter, page, crop: { x: 0, y: 0, w: 1, h: 1, score, f: {} as any } });
  const picks = h.chooseCrops([c(1, 3, 5), c(1, 4, 4.9), c(1, 5, 4.8), c(2, 3, 3), c(3, 3, 2), c(4, 3, 1), c(5, 3, 0.1)]);
  // Reintroduce by taking the top four regardless of chapter: chapter 1 fills three of the four.
  assert.deepEqual(picks.map((p) => p.chapter), [1, 2, 3, 4]);
  // The floor: a crop scoring under TUNE.minScore is never used, even to make up the four.
  assert.ok(!h.chooseCrops([c(1, 3, 5), c(2, 3, 4), c(3, 3, 3), c(4, 3, 0.1)]).some((p) => p.chapter === 4));
});

test('the seed chooses among near-equal crops, and a reach that is long enough finds the next best', () => {
  // v0.52.0: a short series has every page read whatever the seed, so these are the crops every Shuffle sees. Five
  // within TUNE.near of each other and a sixth far below. Reintroduce by ranking on the score alone in chooseCrops:
  // every seed draws the same four, and "the seed never chooses" fails.
  const c = (chapter: number, score: number): Candidate => ({ chapter, page: 3, crop: { x: 0, y: 0, w: 1, h: 1, score, f: {} as any } });
  const cands = [c(1, 3), c(2, 2.95), c(3, 2.9), c(4, 2.85), c(5, 2.8), c(6, 1)];
  const four = (picks: Candidate[]) => picks.map((p) => p.chapter).sort().join(',');
  assert.equal(four(h.chooseCrops(cands)), '1,2,3,4', 'seed 0 is not the best four');
  const near = new Set<string>();
  for (let seed = 1; seed <= 40; seed++) near.add(four(h.chooseCrops(cands, 4, { rand: h.rng(seed), reach: h.TUNE.near })));
  assert.ok(near.size > 1, 'the seed never chooses among near-equal crops');
  assert.ok(![...near].some((f) => f.includes('6')), 'a near reach took the crop two points below');
  // A seed whose first draw reaches far (choiceOf) can take it: what Shuffle needs on a series with nothing near.
  const far = new Set<string>();
  for (let seed = 1; seed <= 200; seed++) far.add(four(h.chooseCrops(cands, 4, { rand: h.rng(seed), reach: 40 * h.TUNE.near })));
  assert.ok([...far].some((f) => f.includes('6')), 'no reach takes the next best crop');
  // And the seed alone decides: the same seed, the same four.
  assert.equal(four(h.chooseCrops(cands, 4, h.choiceOf(48271))), four(h.chooseCrops(cands, 4, h.choiceOf(48271))));
});

test('one banner is made at a time, server-wide', async () => {
  let inside = 0, most = 0;
  const job = () => h.withHeroSlot(async () => {
    inside++; most = Math.max(most, inside);
    await new Promise((r) => setTimeout(r, 30));
    inside--;
  }, 1000);
  await Promise.all([job(), job(), job()]);
  // Reintroduce by calling fn() without waiting for `running`: three run at once.
  assert.equal(most, 1, 'two banners were being made at the same time');
  // A view that cannot get its turn in time gives up rather than queueing forever, and says why.
  const long = h.withHeroSlot(() => new Promise((r) => setTimeout(r, 200)), 1000);
  await assert.rejects(h.withHeroSlot(async () => {}, 20), (e) => e instanceof h.HeroUnavailable && e.reason === 'busy');
  await long;
});

test('the warm-up stands aside for a sweep and a repair', () => {
  // Reintroduce by dropping runtime.updating from heroWaitsFor: the first assertion reads null.
  try {
    runtime.updating = true;
    assert.equal(h.heroWaitsFor(), 'sweep');
    runtime.updating = false; runtime.repairing = true;
    assert.equal(h.heroWaitsFor(), 'repair');
    runtime.repairing = false;
    assert.equal(h.heroWaitsFor(), null);
  } finally {
    runtime.updating = false; runtime.repairing = false;
  }
});
