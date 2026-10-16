import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { detail, edgeProfile, JOIN_VERSION, joinDirection, joinsFor, sameTexture, SEAM } from '../src/lib/spreadJoin';

// #229's tests (@Squeaks72), with the pictures given a drawn texture: a real spread's seam is ink and screentone, and
// v0.77.0's detector refuses an edge that is nearly all blank paper as a page's border.

// A picture with structure at many heights, so an edge carries a recognisable pattern, drawn at `w` x `h`: grey bands
// at many heights over a fine diagonal tone, as a page's screentone is.
async function picture(w: number, h: number, seed: number): Promise<Buffer> {
  const stripes = Array.from({ length: 60 }, (_, i) => {
    const y = Math.round(((i * 37 + seed * 11) % 100) / 100 * h);
    const g = 30 + ((i * 53 + seed * 29) % 190);
    return `<rect x="${(i * 173 + seed * 7) % Math.round(w * 0.7)}" y="${y}" width="${Math.round(w * 0.5 + ((i * 61) % Math.round(w * 0.5)))}" height="${Math.round(h / 60)}" fill="rgb(${g},${g},${g})"/>`;
  }).join('');
  const tone = `<pattern id="t" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(${30 + seed * 7})"><rect width="6" height="6" fill="#d8d8d8"/><rect width="3" height="6" fill="#a8a8a8"/></pattern>`;
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs>${tone}</defs><rect width="${w}" height="${h}" fill="url(#t)"/>${stripes}</svg>`)).jpeg({ quality: 92 }).toBuffer();
}
const cut = async (spread: Buffer, w: number, h: number) => ({
  left: await sharp(spread).extract({ left: 0, top: 0, width: w, height: h }).jpeg().toBuffer(),
  right: await sharp(spread).extract({ left: w, top: 0, width: w, height: h }).jpeg().toBuffer(),
});
/** A page's worth of border: black down `side`'s edge for the top third, white below, a drawn panel kept off the edge. */
async function bordered(w: number, h: number, side: 'left' | 'right', seed: number): Promise<Buffer> {
  const x = side === 'left' ? 0 : w - 60;
  const inner = await sharp(await picture(w - 120, h - 120, seed)).toBuffer();
  return sharp({ create: { width: w, height: h, channels: 3, background: '#ffffff' } })
    .composite([{ input: { create: { width: 60, height: Math.round(h / 3), channels: 3, background: '#000000' } }, left: x, top: 0 }, { input: inner, left: 60, top: 60 }])
    .jpeg({ quality: 92 }).toBuffer();
}

test('the two halves of one picture join, in the direction the picture runs', async () => {
  const w = 400, h = 600;
  const { left, right } = await cut(await picture(2 * w, h, 3), w, h);
  const L = (await edgeProfile(left))!, R = (await edgeProfile(right))!;
  // Right-to-left: the first file in reading order is the RIGHT half, so the next page (the left half) sits on its left.
  assert.equal(joinDirection(R, L), 'rtl');
  assert.equal(joinDirection(L, R), 'ltr');
});

test('unrelated pages, blank edges and webtoon strips do not join', async () => {
  const w = 400, h = 600;
  const A = (await edgeProfile(await picture(w, h, 1)))!, B = (await edgeProfile(await picture(w, h, 7)))!;
  assert.equal(joinDirection(A, B), null);
  const blank = (await edgeProfile(await sharp({ create: { width: w, height: h, channels: 3, background: '#fff' } }).jpeg().toBuffer()))!;
  assert.equal(joinDirection(blank, blank), null);
  // A tall strip cut from a wider picture would match edge to edge; it is a webtoon, not a spread.
  const { left, right } = await cut(await picture(2 * 300, 4000, 3), 300, 4000);
  assert.equal(joinDirection((await edgeProfile(left))!, (await edgeProfile(right))!), null);
  // Pages of different sizes are not halves of one drawing.
  const small = (await edgeProfile(await picture(300, 600, 3)))!;
  assert.equal(joinDirection(A, small), null);
});

test('two facing pages whose borders line up are not one picture (v0.77.0)', async () => {
  // The calibration's most common false join: a black bleed down both inner edges at the same heights, the rest white
  // paper. The two edges are the same few bands and correlate at almost 1 -- and neither is a drawing.
  // Reintroduce by dropping the border test from sameTexture: this pair joins.
  const w = 400, h = 600;
  const a = (await edgeProfile(await bordered(w, h, 'left', 2)))!, b = (await edgeProfile(await bordered(w, h, 'right', 5)))!;
  assert.equal(joinDirection(a, b), null);
});

test('a run of matching neighbours is a repeating background, not a spread', async () => {
  const w = 400, h = 600;
  const { left, right } = await cut(await picture(2 * w, h, 3), w, h);
  const L = (await edgeProfile(left))!, R = (await edgeProfile(right))!, X = (await edgeProfile(await picture(w, h, 9)))!;
  assert.deepEqual(joinsFor([X, R, L, X]), [null, 'rtl', null, null]);
  assert.deepEqual(joinsFor([R, L, X]), ['rtl', null, null], 'page 1 can be half of a spread');
  assert.deepEqual(joinsFor([L, R, L, R]), [null, null, null, null], 'every pair matching proves nothing');
});

test('an edge that fits another page of its chapter as well proves nothing (v0.77.0)', async () => {
  // Two pages built on one layout fit each other, and a dozen other pages too; a seam through one drawing fits only
  // its own other half. Reintroduce by dropping onlyFit from joinsFor: the first assertion sees 'rtl'.
  const w = 400, h = 600;
  const spread = await picture(2 * w, h, 3);
  const { left, right } = await cut(spread, w, h);
  const L = (await edgeProfile(left))!, R = (await edgeProfile(right))!, X = (await edgeProfile(await picture(w, h, 9)))!;
  // The same left half again, re-encoded, further on: R's edge meets it as well as it meets L.
  const again = (await edgeProfile(await sharp(left).jpeg({ quality: 80 }).toBuffer()))!;
  assert.deepEqual(joinsFor([R, L, X, again]), [null, null, null, null]);
  assert.deepEqual(joinsFor([R, L, X, X]), ['rtl', null, null, null], 'with no rival the same seam joins');
});

test('the same texture both sides, and the small steps lining up', () => {
  const n = 250;
  // Grey values 60-190 from a hash of (i, seed): two seeds are two unrelated edges.
  const noise = (seed: number) => Float32Array.from({ length: n }, (_, i) => { const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453; return 60 + 130 * (x - Math.floor(x)); });
  const a = noise(1);
  assert.ok(sameTexture(a, a));
  assert.ok(detail(a, a) > 0.99);
  assert.ok(Math.abs(detail(a, noise(2))) < 0.3, 'two unrelated edges barely line up');
  // A border: black for a third, white for the rest. The same border on the other page is no texture at all.
  const border = Float32Array.from({ length: n }, (_, i) => (i < n / 3 ? 0 : 255));
  assert.equal(sameTexture(border, border), false);
  // Drawn on one side, paper on the other: not two columns of one picture.
  const paper = Float32Array.from({ length: n }, (_, i) => (i % 50 < 40 ? 250 : 60 + (i % 7) * 20));
  assert.equal(sameTexture(a, paper), false);
  assert.ok(SEAM.textureTol > 0 && SEAM.rival > SEAM.minDetail);
});

test('a webtoon chapter never joins, even where two pages happen to meet', async () => {
  const w = 400, h = 600;
  const { left, right } = await cut(await picture(2 * w, h, 3), w, h);
  const R = (await edgeProfile(right))!, L = (await edgeProfile(left))!;
  assert.deepEqual(joinsFor([R, L]), ['rtl', null]);
  const strip = (await edgeProfile(await picture(w, 1400, 9)))!;
  assert.deepEqual(joinsFor([R, L, strip, strip]), [null, null, null, null]);
});

test('halves whose tones differ and whose cut lost a pixel or two still join (One Piece 1154)', async () => {
  const w = 400, h = 600;
  const spread = await picture(2 * w, h, 3);
  // The scan's two pages are not one exposure: the right half is a little darker, and the cut took 2 px of picture.
  const left = await sharp(spread).extract({ left: 0, top: 0, width: w, height: h }).jpeg().toBuffer();
  const right = await sharp(spread).extract({ left: w + 2, top: 0, width: w - 2, height: h }).extend({ right: 2, background: '#fff' }).linear(0.92, -6).jpeg().toBuffer();
  const L = (await edgeProfile(left))!, R = (await edgeProfile(right))!;
  assert.equal(joinDirection(R, L), 'rtl');
});

test('JOIN_VERSION is a positive integer a stored answer can be compared with', () => {
  // 3 since v0.77.0's texture, detail and rival tests: an answer the first detector gave is measured again.
  assert.ok(Number.isInteger(JOIN_VERSION) && JOIN_VERSION >= 3);
});
