// A page for a screen (#234, the reader's Fit pages to my screen): the real encoder, pageAtWidth at READ_QUALITY, or the
// page exactly as it is wherever a copy could only be worse. No second encoder: the PR's fitPageWidth carried a fallback
// of its own that production never ran, and most of its tests exercised only that.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

process.env.DATABASE_URL = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || 'postgres://x:x@127.0.0.1:1/x';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';

let pageForScreen: typeof import('../src/routes/images').pageForScreen;
let pageAtWidth: typeof import('../src/routes/images').pageAtWidth;
let READ_QUALITY: number;
before(async () => {
  ({ pageForScreen, pageAtWidth, READ_QUALITY } = await import('../src/routes/images'));
});

/** A page with something on it: a band of grey across a blue field. */
const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: '#336699' } })
  .composite([{ input: Buffer.alloc(w * 40 * 3, 200), raw: { width: w, height: 40, channels: 3 }, top: 10, left: 0 }])
  .png().toBuffer();

test('a page wider than the screen shows comes through the one encoder, at the reading quality', async () => {
  assert.ok(READ_QUALITY > 74, 'reading is not a thumbnail: above the 74 the ?w= previews use');
  const src = await png(2400, 3400);
  const out = await pageForScreen(src, 'image/png', 1080);
  assert.equal(out.contentType, 'image/webp');
  const m = await sharp(out.buffer).metadata();
  assert.deepEqual([m.format, m.width, m.height], ['webp', 1080, 1530]);
  // Byte for byte what pageAtWidth makes at READ_QUALITY: the real path, not a copy of it.
  assert.ok(out.buffer.equals((await pageAtWidth(src, 1080, READ_QUALITY)).buffer));
});

test('a strip too tall for WebP at that width comes as JPEG, as pageAtWidth makes it', async () => {
  const src = await png(1200, 40000);
  const out = await pageForScreen(src, 'image/png', 720);
  assert.equal(out.contentType, 'image/jpeg');
  const m = await sharp(out.buffer).metadata();
  assert.deepEqual([m.width, m.height], [720, 24000]);
});

test('a page that already fits, an animation, and bytes sharp cannot read go out exactly as they are', async () => {
  // Reintroduce by sending every page through pageAtWidth: the narrow page comes back re-encoded, softer for nothing.
  const narrow = await png(700, 1000);
  const kept = await pageForScreen(narrow, 'image/png', 720);
  assert.equal(kept.buffer, narrow, 'the same bytes, not a copy');
  assert.equal(kept.contentType, 'image/png');
  const frame = (bg: string) => sharp({ create: { width: 1600, height: 1000, channels: 3, background: bg } }).png().toBuffer();
  const gif = await sharp([await frame('#ff0000'), await frame('#0000ff')], { join: { animated: true } }).gif().toBuffer();
  assert.equal((await sharp(gif).metadata()).pages, 2, 'premise: an animation');
  const anim = await pageForScreen(gif, 'image/gif', 720);
  assert.equal(anim.buffer, gif, 'an animation keeps every frame');
  assert.equal(anim.contentType, 'image/gif');
  const junk = Buffer.from('not an image');
  assert.equal((await pageForScreen(junk, 'image/jpeg', 720)).buffer, junk);
});

test('a copy that would come out bigger than the page is not sent', async () => {
  // Noise saved as a very rough JPEG: 2,000 px of it at quality 1 is smaller than any honest 1,080 px WebP of it.
  const noise = Buffer.alloc(2000 * 2000 * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = ((i * 2654435761) >>> 24) & 255;
  const rough = await sharp(noise, { raw: { width: 2000, height: 2000, channels: 3 } }).jpeg({ quality: 1 }).toBuffer();
  assert.ok((await pageAtWidth(rough, 1080, READ_QUALITY)).buffer.length > rough.length, 'premise: the copy is bigger');
  const out = await pageForScreen(rough, 'image/jpeg', 1080);
  assert.equal(out.buffer, rough);
  assert.equal(out.contentType, 'image/jpeg');
});
