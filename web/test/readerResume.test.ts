// Two ways the reader lost its place, pinned as source guards (the behaviour is the browser's; see the comments in
// app/reader/page.tsx):
//   1. A paged track whose WIDTH changed (the window dragged to a screen of another size) kept its scrollLeft in pixels,
//      so the same offset read as another slide and progress was saved for a different page or chapter.
//   2. Continuous reading appends chapters to one track while the address kept naming the first, so a refresh reopened
//      the chapter the reader was opened on, not the one being read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(join(__dirname, '..', 'app/reader/page.tsx'), 'utf8');

test('a change of track width puts the track back on its slide instead of reading a new page from it', () => {
  assert.match(src, /pagedWidth\.current && pagedWidth\.current !== w/);
  assert.match(src, /new ResizeObserver/);
  assert.match(src, /trackSign \* pagedSlide\.current \* w/);
});

test('every deliberate placing of the track is the place a resize keeps, the split of a turned phone above all', () => {
  // Reintroduce `el.scrollLeft = trackSign * (slideOf[current] ?? current) * el.clientWidth` in the split effect: turning a
  // phone with Wide pages: Split put back the slide read before the halves moved (walk263's WebKit rotation, another page).
  const split = src.slice(src.indexOf('laidOutSplit.current === splitTrack) return;'));
  assert.match(split.slice(0, 600), /placeTrack\(el, slideOf\[current\] \?\? current\)/);
  assert.match(src, /pagedWidth\.current = w;\n\s*pagedSlide\.current = slide;/, 'placeTrack records the place');
  assert.doesNotMatch(src, /el\.scrollLeft = trackSign \* \(slideOf\[current\] \?\? current\)/, 'no placing that the guard does not know of');
});

test('the address follows the chapter on screen, without reloading the reader for it', () => {
  assert.match(src, /urlSynced\.current = readingChapterId/);
  assert.match(src, /if \(urlSynced\.current === bookId\) \{ urlSynced\.current = null; return; \}/);
  // Not while a jump to another chapter is loading: the address is then not the one the reader knows. The first cut tested
  // `chapters[0]?.id !== bookId`, which after the first crossing was true for good (walk263 holds the behaviour).
  assert.match(src, /bookId !== addressed\.current \|\| !didInitScroll\.current\) return;/);
  assert.doesNotMatch(src, /chapters\[0\]\?\.id !== bookId/);
  assert.match(src, /addressed\.current = readingChapterId;/, 'the address it moved to is the one it knows');
});
