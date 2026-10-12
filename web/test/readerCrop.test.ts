// Crop page borders (v0.61.0, lib/readerCrop.ts): the margins of a page found from its pixels, one trim per chapter
// in the webtoon column, a spread's shared trim, and the geometry that draws a region of a page.
//
// The pages here are synthetic RGBA, the shape a canvas's getImageData hands the reader: a paper colour, a block of
// "art" somewhere on it, and whatever noise a case needs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  MAX_TRIM, WHOLE, LEFT_HALF, RIGHT_HALF, chapterSideCrop, contentBox, cropStyle, fitBox, halfCrop, pairCrop, type Region,
} from '../lib/readerCrop';
import { DEFAULT_PREFS, LOOK_KEYS, migratePrefs } from '../lib/readerPrefs';

const ROOT = join(__dirname, '..');
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

type RGB = [number, number, number];
/** A `w` x `h` page of `paper`, with `art` filled over [x0, x1) x [y0, y1) in a pattern of `ink`. */
function page(w: number, h: number, paper: RGB, art: { x0: number; y0: number; x1: number; y1: number } | null, ink: RGB = [30, 30, 30]) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inArt = art && x >= art.x0 && x < art.x1 && y >= art.y0 && y < art.y1;
      // Art is not flat: half its pixels are ink, half paper-ish, as a drawing is.
      const c = inArt && (x + y) % 2 === 0 ? ink : inArt ? [150, 150, 150] as RGB : paper;
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
    }
  }
  return px;
}
const set = (px: Uint8ClampedArray, w: number, x: number, y: number, c: RGB) => {
  const i = (y * w + x) * 4;
  px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2];
};
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;
const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];

test('a white border is found on every side', () => {
  // 128 x 200, art from 10..118 across and 20..170 down: the trims are those margins as shares of the page.
  const box = contentBox(page(128, 200, WHITE, { x0: 10, y0: 20, x1: 118, y1: 170 }), 128, 200);
  assert.ok(close(box.l, 10 / 128) && close(box.r, 10 / 128), JSON.stringify(box));
  assert.ok(close(box.t, 20 / 200) && close(box.b, 30 / 200), JSON.stringify(box));
});

test('a black border is found the same way', () => {
  const box = contentBox(page(128, 200, BLACK, { x0: 12, y0: 16, x1: 120, y1: 184 }, [240, 240, 240]), 128, 200);
  assert.ok(close(box.l, 12 / 128) && close(box.r, 8 / 128) && close(box.t, 16 / 200) && close(box.b, 16 / 200), JSON.stringify(box));
});

test('a speck of dust in the margin is not content', () => {
  // Reintroduce by counting any ink as content (CONTENT = 0): the speck at x = 3 ends the left trim there.
  const px = page(128, 200, WHITE, { x0: 10, y0: 20, x1: 118, y1: 170 });
  set(px, 128, 3, 50, BLACK);
  set(px, 128, 3, 51, BLACK);
  set(px, 128, 60, 5, BLACK);
  const box = contentBox(px, 128, 200);
  assert.ok(close(box.l, 10 / 128), `the speck moved the left trim: ${JSON.stringify(box)}`);
  assert.ok(close(box.t, 20 / 200), `the speck moved the top trim: ${JSON.stringify(box)}`);
});

test('art that touches an edge is not trimmed there, and one dark corner is not the paper', () => {
  // The art runs off the right edge and the bottom-right corner: three corners are still paper.
  const box = contentBox(page(128, 200, WHITE, { x0: 10, y0: 20, x1: 128, y1: 200 }), 128, 200);
  assert.equal(box.r, 0);
  assert.equal(box.b, 0);
  assert.ok(close(box.l, 10 / 128));
  // No paper to speak of -- two corners each way -- is no crop at all.
  const px = page(128, 200, WHITE, { x0: 0, y0: 0, x1: 128, y1: 100 }, BLACK);
  assert.deepEqual(contentBox(px, 128, 200), WHOLE);
});

test('a page that is mostly blank, or blank, is not trimmed', () => {
  // A title page: a little text in the middle of a white page. Trimming to it would blow the text up to the screen.
  assert.deepEqual(contentBox(page(128, 200, WHITE, { x0: 50, y0: 90, x1: 78, y1: 110 }), 128, 200), WHOLE);
  assert.deepEqual(contentBox(page(128, 200, WHITE, null), 128, 200), WHOLE, 'a blank page');
});

test('a trim under 1 % is not made, and none passes 15 %', () => {
  const thin = contentBox(page(400, 400, WHITE, { x0: 2, y0: 40, x1: 398, y1: 360 }), 400, 400);
  assert.equal(thin.l, 0, '2 px of 400 is not worth a jump');
  const wide = contentBox(page(200, 400, WHITE, { x0: 40, y0: 40, x1: 180, y1: 360 }), 200, 400);
  assert.equal(wide.l, MAX_TRIM, 'a 20 % margin is trimmed by 15 % at most');
  assert.equal(wide.r, 0.1);
});

test('the webtoon column looks at the sides only', () => {
  const px = page(128, 400, WHITE, { x0: 9, y0: 100, x1: 119, y1: 300 });
  const sides = contentBox(px, 128, 400, { sidesOnly: true });
  assert.ok(close(sides.l, 9 / 128) && close(sides.r, 9 / 128));
  assert.equal(sides.t, 0);
  assert.equal(sides.b, 0);
  // Half the strip's height is blank, which refuses a four-sided crop -- but not the sides.
  assert.deepEqual(contentBox(page(128, 400, WHITE, { x0: 9, y0: 150, x1: 119, y1: 250 }), 128, 400), WHOLE);
  assert.ok(contentBox(page(128, 400, WHITE, { x0: 9, y0: 150, x1: 119, y1: 250 }), 128, 400, { sidesOnly: true }).l > 0);
});

test('a chapter is trimmed by its pages\' smallest margins, and not at all where they disagree', () => {
  const b = (l: number, r: number): Region => ({ l, t: 0, r, b: 0 });
  assert.equal(chapterSideCrop([b(0.06, 0.06), b(0.065, 0.06)]), null, 'two pages of a long chapter is not enough to decide');
  assert.deepEqual(chapterSideCrop([b(0.06, 0.07), b(0.065, 0.06), b(0.07, 0.065)]), { l: 0.06, r: 0.06 });
  // Reintroduce by taking the minimum whatever the spread: the left side here would be trimmed by 1 %.
  assert.deepEqual(chapterSideCrop([b(0.01, 0.06), b(0.08, 0.06), b(0.07, 0.065)]), { l: 0, r: 0.06 }, 'margins 7 % apart were trimmed');
  // A short chapter -- two strips -- decides on what it has.
  assert.deepEqual(chapterSideCrop([b(0, 0), b(0, 0)], 2), { l: 0, r: 0 });
  assert.equal(chapterSideCrop([], 0), null, 'a chapter with no story page has nothing to decide on');
  // Only the first three count.
  assert.deepEqual(chapterSideCrop([b(0.05, 0.05), b(0.05, 0.05), b(0.05, 0.05), b(0.0, 0.0)]), { l: 0.05, r: 0.05 });
});

test('a spread shares its top and bottom, and keeps its gutter', () => {
  // Reintroduce by trimming each page by its own margins: the gutter is cut and the drawing across it no longer joins.
  const [a, b] = pairCrop({ l: 0.05, t: 0.04, r: 0.06, b: 0.03 }, { l: 0.07, t: 0.02, r: 0.05, b: 0.05 });
  assert.deepEqual(a, { l: 0.05, t: 0.02, r: 0, b: 0.03 });
  assert.deepEqual(b, { l: 0, t: 0.02, r: 0.05, b: 0.03 });
  // A split half keeps its outer side and its top and bottom, never the middle.
  assert.deepEqual(halfCrop('left', { l: 0.05, t: 0.04, r: 0.06, b: 0.03 }), { l: 0.05, t: 0.04, r: 0.5, b: 0.03 });
  assert.deepEqual(halfCrop('right', { l: 0.05, t: 0.04, r: 0.06, b: 0.03 }), { l: 0.5, t: 0.04, r: 0.06, b: 0.03 });
});

test('cropStyle draws exactly the region it is given', () => {
  // Round trip: lay the image out in a box the way the CSS does and read back which part of the image the box shows.
  for (const region of [WHOLE, LEFT_HALF, RIGHT_HALF, { l: 0.067, t: 0.047, r: 0.067, b: 0.047 }, { l: 0.5, t: 0.04, r: 0.06, b: 0.03 }]) {
    const st = cropStyle(region);
    const boxW = 300 * st.sx; // a 300 x 400 image's region, drawn at scale 1
    const boxH = 400 * st.sy;
    const imgW = boxW * (parseFloat(st.img.width) / 100);
    const imgH = boxH * (parseFloat(st.img.height) / 100);
    const m = /translate\(-([\d.]+)%, -([\d.]+)%\)/.exec(st.img.transform);
    const shiftX = m ? imgW * (parseFloat(m[1]) / 100) : 0;
    const shiftY = m ? imgH * (parseFloat(m[2]) / 100) : 0;
    // To a hundredth of a pixel: the percentages are written to four decimals, a millionth of the box.
    assert.ok(close(imgW, 300, 0.01) && close(imgH, 400, 0.01), `the image is not drawn at its own size: ${imgW} x ${imgH}`);
    assert.ok(close(shiftX / imgW, region.l, 1e-5) && close(shiftY / imgH, region.t, 1e-5), `the region starts elsewhere: ${JSON.stringify(region)}`);
    assert.ok(close((shiftX + boxW) / imgW, 1 - region.r, 1e-5) && close((shiftY + boxH) / imgH, 1 - region.b, 1e-5), `the region ends elsewhere: ${JSON.stringify(region)}`);
  }
  assert.deepEqual(fitBox(1, 2, 300, 300), { width: 150, height: 300 });
  assert.deepEqual(fitBox(2, 1, 300, 600), { width: 300, height: 150 });
  assert.deepEqual(fitBox(0, 1, 300, 600), { width: 0, height: 0 }, 'an unmeasured box fits nothing');
});

test('Crop page borders is off by default, stored like any reader default, and only a real true turns it on', () => {
  assert.equal(DEFAULT_PREFS.cropBorders, false);
  assert.equal(migratePrefs({}).cropBorders, false);
  assert.equal(migratePrefs({ cropBorders: 'yes' }).cropBorders, false);
  assert.equal(migratePrefs({ cropBorders: true }).cropBorders, true);
  assert.ok(!(LOOK_KEYS as readonly string[]).includes('cropBorders'));
});

test('the reader measures pages only while Crop page borders is on, and makes a trimmed row as tall as it draws it', () => {
  // Reintroduce `onLoaded={onPageLoad}` unconditionally: every page of every chapter is read back through a canvas for
  // a setting that is off. Drop the crop from the height model: the column's model and the DOM part ways.
  const src = code(readFileSync(join(ROOT, 'app/reader/page.tsx'), 'utf8'));
  assert.match(src, /onLoaded=\{prefs\.cropBorders \? onPageLoad : undefined\}/, 'the column measures pages with the setting off');
  assert.match(src, /const loaded = cropOn \? \(el: HTMLImageElement\) => onPageLoad\(p\.key, el\) : undefined;/, 'the paged track measures pages with the setting off');
  assert.match(src, /return pageHeight\(p, crop \? colW \/ \(1 - crop\.l - crop\.r\) : colW, wide\);/, 'a trimmed row is not reserved the height it is drawn at');
  // And a page waiting for its margins is hidden, not animated: opacity, at once, with its 300 ms way out.
  const row = code(readFileSync(join(ROOT, 'components/ReaderPage.tsx'), 'utf8'));
  assert.match(row, /opacity: pending && !late\.on \? 0 : undefined/);
  assert.match(row, /setTimeout\(\(\) => setOn\(true\), 300\)/, 'a page whose margins never arrive is never shown');
  assert.doesNotMatch(row, /transition/, 'a page waiting for its margins fades in: new motion');
});
