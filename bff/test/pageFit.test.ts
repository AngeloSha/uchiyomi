// A page asked for at a width is that width or the original, never a worse copy of something that already fit.
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { fitPageWidth } from '../src/lib/pageFit';

const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: '#336699' } })
  .composite([{ input: Buffer.alloc(w * 40 * 3, 200), raw: { width: w, height: 40, channels: 3 }, top: 10, left: 0 }])
  .png().toBuffer();

test('a page wider than asked comes back narrower, as webp', async () => {
  const src = await png(1600, 2400);
  const out = await fitPageWidth(src, 800, 'image/png');
  assert.equal(out.contentType, 'image/webp');
  assert.equal((await sharp(out.buffer).metadata()).width, 800);
});

test('a page already that narrow goes out untouched', async () => {
  const src = await png(700, 900);
  const out = await fitPageWidth(src, 800, 'image/png');
  assert.equal(out.buffer, src);
  assert.equal(out.contentType, 'image/png');
});

test('a strip too tall for webp is sent as jpeg, still the width asked for', async () => {
  const src = await png(1000, 40000);
  const out = await fitPageWidth(src, 900, 'image/png');
  assert.equal(out.contentType, 'image/jpeg');
  const m = await sharp(out.buffer).metadata();
  assert.equal(m.width, 900);
  assert.equal(m.height, 36000);
});

test('bytes sharp cannot read are passed through, not turned into an error', async () => {
  const junk = Buffer.from('not an image');
  const out = await fitPageWidth(junk, 800, 'image/jpeg');
  assert.equal(out.buffer, junk);
});

test('a page that does not come out smaller is kept as it is', async () => {
  const src = await sharp(Buffer.alloc(900 * 900 * 3, 0), { raw: { width: 900, height: 900, channels: 3 } }).png({ compressionLevel: 9 }).toBuffer();
  const out = await fitPageWidth(src, 800, 'image/png', async (b, w) => ({ buffer: Buffer.concat([b, b]), contentType: 'image/webp' }));
  assert.equal(out.buffer, src);
  assert.equal(out.contentType, 'image/png');
});
