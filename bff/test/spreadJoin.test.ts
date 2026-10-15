import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { edgeProfile, JOIN_VERSION, joinDirection, joinsFor, stitchSpread } from '../src/lib/spreadJoin';

// A picture with structure at many heights, so an edge carries a recognisable pattern, drawn at `w` x `h`.
async function picture(w: number, h: number, seed: number): Promise<Buffer> {
  const stripes = Array.from({ length: 24 }, (_, i) => {
    const y = Math.round(((i * 37 + seed * 11) % 100) / 100 * h);
    const g = (i * 53 + seed * 29) % 256;
    return `<rect x="${(i * 173 + seed * 7) % Math.round(w * 0.7)}" y="${y}" width="${Math.round(w * 0.5 + ((i * 61) % Math.round(w * 0.5)))}" height="${Math.round(h / 40)}" fill="rgb(${g},${g},${g})"/>`;
  }).join('');
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="white"/>${stripes}</svg>`)).jpeg({ quality: 92 }).toBuffer();
}
const cut = async (spread: Buffer, w: number, h: number) => ({
  left: await sharp(spread).extract({ left: 0, top: 0, width: w, height: h }).jpeg().toBuffer(),
  right: await sharp(spread).extract({ left: w, top: 0, width: w, height: h }).jpeg().toBuffer(),
});

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

test('a run of matching neighbours is a repeating background, not a spread', async () => {
  const w = 400, h = 600;
  const { left, right } = await cut(await picture(2 * w, h, 3), w, h);
  const L = (await edgeProfile(left))!, R = (await edgeProfile(right))!, X = (await edgeProfile(await picture(w, h, 9)))!;
  assert.deepEqual(joinsFor([X, R, L, X]), [null, 'rtl', null, null]);
  assert.deepEqual(joinsFor([R, L, X]), ['rtl', null, null], 'page 1 can be half of a spread');
  assert.deepEqual(joinsFor([L, R, L, R]), [null, null, null, null], 'every pair matching proves nothing');
});

test('the stitched spread is both pages side by side', async () => {
  const w = 400, h = 600;
  const spread = await picture(2 * w, h, 3);
  const { left, right } = await cut(spread, w, h);
  const out = await stitchSpread(right, left, 'rtl');
  const m = await sharp(out).metadata();
  assert.deepEqual([m.width, m.height], [2 * w, h]);
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

test('JOIN_VERSION is a positive integer a cache row can be compared with', () => {
  assert.ok(Number.isInteger(JOIN_VERSION) && JOIN_VERSION >= 2);
});
