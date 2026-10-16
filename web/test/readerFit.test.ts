// Pages at the size this screen shows them (#234, lib/readerFit.ts): the width a page is DRAWN at, in device pixels,
// rounded up -- never softer than the screen, and never asked for again at less.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CROP_GROWS, FIT_WIDTHS, drawnWidth, fitWidth, neverSofter } from '../lib/readerFit';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

test('the width asked for is the drawn width in device pixels, rounded up; past the last width the page as scanned', () => {
  assert.deepEqual([...FIT_WIDTHS], [720, 1080, 1440, 2000]);
  assert.equal(fitWidth(0, 3), 0, 'nothing measured: the page as scanned');
  assert.equal(fitWidth(360, 1), 720);
  assert.equal(fitWidth(390, 3), 1440, 'a phone at 3x');
  assert.equal(fitWidth(400, 4), 1440, 'counted at 3x at most');
  assert.equal(fitWidth(860, 2), 2000);
  assert.equal(fitWidth(1100, 2), 0, 'more than 2,000 device pixels: the scan itself');
  assert.equal(fitWidth(300, 0), 720);
  assert.equal(fitWidth(300, NaN), 720);
  assert.equal(fitWidth(Infinity, 1), 0);
});

test('a page in the column is drawn as wide as the column, twice that split, its width down the column turned', () => {
  const portrait = { width: 800, height: 1200 };
  const spread = { width: 2400, height: 1700 };
  const col = { mode: 'column' as const, colW: 400, wide: 'whole' as const, crop: false };
  assert.equal(drawnWidth(portrait, col), 400);
  // Reintroduce the column's width for every page: a split spread is drawn at 800 and comes at a width for 400.
  assert.equal(drawnWidth(spread, { ...col, wide: 'split' }), 800);
  assert.equal(Math.round(drawnWidth(spread, { ...col, wide: 'rotate' })), Math.round(400 * 2400 / 1700));
  assert.equal(drawnWidth(portrait, { ...col, crop: true }), 400 * CROP_GROWS, 'a crop stretches the page by what it trims');
  assert.equal(drawnWidth({ width: null, height: null }, col), 400, 'a page of unknown size: the column');
});

test('a page on a slide is fitted into it, by the zoom, one of a pair in half the slide, a half twice over, turned on its side', () => {
  const slide = { mode: 'slide' as const, w: 390, h: 844, zoom: 1, pair: false, half: false, rotate: false, crop: false };
  const portrait = { width: 800, height: 1200 };
  const spread = { width: 2400, height: 1700 };
  assert.equal(drawnWidth(portrait, slide), 390, 'a phone held upright: as wide as the screen');
  assert.equal(Math.round(drawnWidth(portrait, { ...slide, w: 1280, h: 800 })), 533, 'a computer: as tall as the screen');
  // Reintroduce the width before the zoom: a double-tap zoom upscales a copy made for half the size.
  assert.equal(drawnWidth(portrait, { ...slide, zoom: 2 }), 780);
  assert.equal(Math.round(drawnWidth(portrait, { ...slide, w: 1280, h: 800, pair: true })), 533);
  assert.equal(drawnWidth(portrait, { ...slide, w: 1000, h: 800, pair: true }), 500, 'half the slide when that is narrower');
  // Split on a phone: each half is as wide as the screen, so the page is drawn at twice it (the 1.6-1.75x the review measured).
  assert.equal(drawnWidth(spread, { ...slide, half: true }), 780);
  // Rotate on a phone: the page's width lies along the screen's height.
  assert.equal(Math.round(drawnWidth(spread, { ...slide, rotate: true })), Math.round(Math.min(390 * 2400 / 1700, 844)));
  assert.equal(drawnWidth(portrait, { ...slide, crop: true }), 390 * CROP_GROWS);
  assert.equal(drawnWidth({ width: null, height: null }, { ...slide, pair: true, zoom: 2 }), 390, 'unknown size: as wide as it may be');
});

test('a page once asked for sharper is never asked for at less', () => {
  assert.equal(neverSofter(undefined, 1080), 1080);
  assert.equal(neverSofter(1440, 1080), 1440, 'a zoom out keeps the sharper copy');
  assert.equal(neverSofter(1080, 1440), 1440, 'a zoom in asks for more');
  assert.equal(neverSofter(0, 720), 0, 'once as scanned, as scanned');
  assert.equal(neverSofter(720, 0), 0);
  assert.equal(neverSofter(undefined, 0), 0);
});

test('Fit pages to my screen is this device\'s, off until chosen, and only it asks for ?fit=', () => {
  const page = read('app/reader/page.tsx');
  // Reintroduce the PR's default (every page through ?w=): the reader asks for re-encoded pages with the switch off.
  assert.match(page, /\(device\.fitPages \? img\.pageFit\(ch\.id, flat\[i\]\.number, fitFor\(i\)\) : img\.page\(ch\.id, flat\[i\]\.number\)\)/);
  // The column's look-ahead warms the address the page then asks for.
  assert.match(page, /void fetch\(onlineSrc\(ch, i\),/);
  assert.doesNotMatch(page, /pageWidthBucket/);
  assert.match(read('lib/api.ts'), /pageFit: \(bookId: string, n: number, fit: number\) =>/);
  assert.match(read('components/ReaderSettings.tsx'), /on=\{device\.fitPages\} onChange=\{\(fitPages\) => setDevice\(\{ fitPages \}\)\}/);
});
