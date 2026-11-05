// Paged mode, Page fit → Fit width (#398): a single page as wide as the slide, scrolled when it is taller, and the
// default -- the whole page on the screen -- left exactly as it was.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fitBox, fitWidthBox } from '../lib/readerCrop';
import { drawnWidth } from '../lib/readerFit';
import { DEFAULT_PREFS, LOOK_KEYS, migratePrefs } from '../lib/readerPrefs';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');

test('fitWidthBox is as wide as the slide however tall that makes the page; fitBox still contains it', () => {
  // A 800 x 2400 strip-like page on a 390 x 844 phone held upright.
  assert.deepEqual(fitWidthBox(800, 2400, 390), { width: 390, height: 1170 });
  const whole = fitBox(800, 2400, 390, 844);
  assert.equal(Math.round(whole.height), 844, 'the whole page: as tall as the screen');
  assert.ok(whole.width < 390);
  assert.deepEqual(fitWidthBox(0, 10, 390), { width: 0, height: 0 }, 'unmeasured');
  assert.deepEqual(fitWidthBox(10, 10, 0), { width: 0, height: 0 });
});

test('a fit-wide slide asks for the slide width; the default layout still asks for the contained width', () => {
  const slide = { mode: 'slide' as const, w: 1280, h: 800, zoom: 1, pair: false, half: false, rotate: false, crop: false };
  const portrait = { width: 800, height: 1200 };
  assert.equal(Math.round(drawnWidth(portrait, slide)), 533, 'a computer: as tall as the screen, as before');
  assert.equal(drawnWidth(portrait, { ...slide, fitWide: true }), 1280, 'fit width: as wide as the slide');
  assert.equal(drawnWidth(portrait, { ...slide, fitWide: false }), drawnWidth(portrait, slide));
  // A pair, a split page and a turned page keep fitting whole.
  assert.equal(Math.round(drawnWidth(portrait, { ...slide, pair: true, fitWide: true })), 533);
  assert.equal(drawnWidth(portrait, { ...slide, half: true, fitWide: true }), drawnWidth(portrait, { ...slide, half: true }));
  assert.equal(drawnWidth(portrait, { ...slide, rotate: true, fitWide: true }), drawnWidth(portrait, { ...slide, rotate: true }));
  // A page of unknown size is as wide as it may be either way.
  assert.equal(drawnWidth({}, { ...slide, fitWide: true }), 1280);
  // The zoom still multiplies it.
  assert.equal(drawnWidth(portrait, { ...slide, fitWide: true, zoom: 2 }), 2560);
});

test('Page fit defaults to the whole page, survives a round trip, and junk reads as the default', () => {
  assert.equal(DEFAULT_PREFS.pagedFit, 'page');
  assert.equal(migratePrefs({}).pagedFit, 'page', 'an older row has none');
  assert.equal(migratePrefs({ pagedFit: 'width' }).pagedFit, 'width');
  assert.equal(migratePrefs({ pagedFit: 'banana' }).pagedFit, 'page');
  assert.equal(migratePrefs({ pagedFit: 7 }).pagedFit, 'page');
  assert.ok(!(LOOK_KEYS as readonly string[]).includes('pagedFit'), 'not a title\'s look: one setting for every title');
});

test('the reader only lays a page out fit-wide in paged mode, unzoomed, and the sheet shows the choice only there', () => {
  const page = read('app/reader/page.tsx');
  assert.match(page, /prefs\.pagedFit === 'width' && zoom === 1/, 'the slide needs Fit width AND no zoom (a zoomed page is panned by panBy)');
  assert.match(page, /fitWide: prefs\.pagedFit === 'width'/, 'the fetched width follows the layout');
  const sheet = read('components/ReaderSettings.tsx');
  assert.match(sheet, /prefs\.mode === 'paged' && \(\s*<Row label=\{tr\('Page fit'\)\}/, 'Page fit is shown in paged mode only');
});
