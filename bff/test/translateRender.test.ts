// Translated pages (v0.85.0), the picture: lib/translate/render.ts paints over each translated bubble in its own colour
// and shape and sets the translation inside; a sound effect drawn on the art is left alone, and a longer caption on the
// art gets a box. The copy keeps the page's size and format. Pure sharp; no model, no database. The fonts come with the
// engine's download, so here sharp falls back to whatever it has: the tests count ink, they never read the letters.
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { renderPage, type Region } from '../src/lib/translate/render';

const W = 400, H = 300;
const NO_FONTS = '/nonexistent-fonts';

/** A white page with black "lettering" blocks, and a closed speech bubble (an ellipse's outline) around them when asked. */
async function page(opts: { bubble: boolean; format?: 'png' | 'jpeg' }): Promise<Buffer> {
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${H}" fill="white"/>
    ${opts.bubble ? '<ellipse cx="200" cy="150" rx="120" ry="70" fill="white" stroke="black" stroke-width="4"/>' : ''}
    <rect x="135" y="125" width="130" height="15" fill="black"/>
    <rect x="145" y="160" width="110" height="15" fill="black"/>
  </svg>`;
  const img = sharp(Buffer.from(svg));
  return opts.format === 'jpeg' ? img.jpeg({ quality: 95 }).toBuffer() : img.png().toBuffer();
}

/** Dark pixels inside a rectangle of a page. */
async function ink(bytes: Buffer, [x0, y0, x1, y1]: [number, number, number, number]): Promise<number> {
  const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * info.width + x) * info.channels;
    if (data[i] + data[i + 1] + data[i + 2] < 180) n++;
  }
  return n;
}

const TEXT_BOX: Region['box'] = [130, 120, 270, 180];
const region = (o: Partial<Region> = {}): Region => ({ box: TEXT_BOX, text: 'Hi', source: 'こんにちは世界', letter: 15, ...o });

test('a closed bubble is painted over in its own shape, its outline kept, and the translation set inside', async () => {
  const before = await page({ bubble: true });
  const out = await renderPage(before, [region()], 'en', NO_FONTS);
  const meta = await sharp(out.buffer).metadata();
  assert.deepEqual([meta.width, meta.height, out.contentType], [W, H, 'image/png'], 'the page\'s size and format');
  const was = await ink(before, TEXT_BOX);
  const now = await ink(out.buffer, TEXT_BOX);
  assert.ok(was > 3000, `the old lettering: ${was}`);
  // Reintroduce by skipping the fill (text drawn over the original): the old lettering is all still there.
  assert.ok(now < was / 4, `the old lettering is painted over: ${was} -> ${now}`);
  assert.ok(now > 0, 'and the translation is written in it');
  // The outline stays: at its top (x 200, y 78-82), and where it curves at the top left (through 138,90 and 116,100).
  // Reintroduce by painting the bubble's bounding box rather than its shape: the curve is painted over.
  assert.ok(await ink(out.buffer, [190, 77, 210, 83]) > 40, 'the outline is still there');
  assert.ok(await ink(out.buffer, [112, 88, 142, 102]) > 50, 'all the way round');
  assert.equal(await ink(out.buffer, [0, 0, 60, 60]), 0, 'nothing outside the bubble changed');
});

test('a sound effect on the art is left as drawn; a longer caption on the art gets a box', async () => {
  const before = await page({ bubble: false });
  const was = await ink(before, TEXT_BOX);
  // Reintroduce by boxing every region: "ドン" gets a white box over the art.
  const sfx = await renderPage(before, [region({ source: 'ドン!', text: 'Boom!' })], 'en', NO_FONTS);
  assert.equal(await ink(sfx.buffer, TEXT_BOX), was, 'the sound effect is untouched');
  const caption = await renderPage(before, [region({ source: 'その頃、東京では', text: 'Meanwhile, in Tokyo' })], 'en', NO_FONTS);
  assert.ok(await ink(caption.buffer, TEXT_BOX) < was / 2, 'the caption is boxed and rewritten');
});

test('a page keeps its format, and a region with nothing to say changes nothing', async () => {
  const jpg = await page({ bubble: true, format: 'jpeg' });
  const out = await renderPage(jpg, [region()], 'en', NO_FONTS);
  assert.equal(out.contentType, 'image/jpeg');
  assert.equal((await sharp(out.buffer).metadata()).format, 'jpeg');
  // An empty translation (OCR noise, per the prompt) leaves the bubble as it was.
  const png = await page({ bubble: true });
  const same = await renderPage(png, [region({ text: '  ' })], 'en', NO_FONTS);
  assert.equal(await ink(same.buffer, TEXT_BOX), await ink(png, TEXT_BOX));
});

/** A white page drawn from SVG shapes, and ink counted in rectangles of it. */
const svgPage = async (shapes: string) => sharp(Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="white"/>${shapes}</svg>`)).png().toBuffer();

test('a narrow column of vertical text is found in its wide bubble', async () => {
  // One column, 20 px wide, in a bubble 320 px wide: a search window the size of the column runs out of the bubble on
  // both sides. Reintroduce the fixed window (the box grown by its own size): the bubble reads as open, the line is
  // short (a sound effect, by that rule), and the Japanese is left as it was.
  const before = await svgPage('<ellipse cx="200" cy="150" rx="160" ry="70" fill="white" stroke="black" stroke-width="4"/><rect x="270" y="105" width="20" height="90" fill="black"/>');
  const column: Region['box'] = [266, 101, 294, 199];
  const out = await renderPage(before, [{ box: column, text: 'An enemy?', source: '敵か', letter: 20 }], 'en', NO_FONTS);
  assert.ok(await ink(before, [270, 105, 290, 195]) > 1500);
  assert.ok(await ink(out.buffer, [270, 105, 290, 195]) < 200, 'the column is painted over');
  assert.ok(await ink(out.buffer, [195, 77, 205, 83]) > 10, 'and the outline kept');
});

test('two lines in one bubble with two lobes are both painted over, and drawn as one', async () => {
  // Two circles joined into one shape, a column in each lobe, read right to left.
  const before = await svgPage([
    '<circle cx="250" cy="150" r="70" fill="white" stroke="black" stroke-width="4"/>',
    '<circle cx="150" cy="150" r="70" fill="white" stroke="black" stroke-width="4"/>',
    '<circle cx="250" cy="150" r="67" fill="white"/><circle cx="150" cy="150" r="67" fill="white"/>',
    '<rect x="240" y="110" width="20" height="80" fill="black"/><rect x="140" y="120" width="20" height="60" fill="black"/>',
  ].join(''));
  const out = await renderPage(before, [
    { box: [236, 106, 264, 194], text: "You're still breathing.", source: '息はあるな', letter: 20 },
    { box: [136, 116, 164, 184], text: 'An enemy?', source: '敵か？', letter: 20 },
  ], 'en', NO_FONTS);
  // Reintroduce the fixed window: the left lobe's line is read as open and short, and stays in Japanese.
  assert.ok(await ink(out.buffer, [240, 110, 260, 190]) < 400, 'the right lobe');
  assert.ok(await ink(out.buffer, [140, 120, 160, 180]) < 400, 'the left lobe');
});

test('a light panel closed off by the art is not a bubble: its art stays', async () => {
  // A caption in an empty-looking panel with a figure in it. The fill from the caption covers the whole panel and closes;
  // painted as a bubble, the figure went with it. Reintroduce by dropping the "holds its text and nothing else" check:
  // the circle is painted white.
  const before = await svgPage('<rect x="20" y="20" width="360" height="260" fill="white" stroke="black" stroke-width="4"/><circle cx="100" cy="150" r="40" fill="black"/><rect x="220" y="120" width="120" height="25" fill="black"/><rect x="220" y="155" width="100" height="25" fill="black"/>');
  const figure: [number, number, number, number] = [70, 120, 130, 180];
  const out = await renderPage(before, [{ box: [216, 116, 344, 184], text: 'Meanwhile, at the castle', source: 'その頃、城では', letter: 22 }], 'en', NO_FONTS);
  assert.equal(await ink(out.buffer, figure), await ink(before, figure), 'the figure is untouched');
  assert.ok(await ink(out.buffer, [220, 120, 340, 180]) < 2000, 'and the caption is boxed and rewritten');
});

