// The pairing rules for double-page mode.
//
// This lived as an inline useMemo in an 800-line component, where the only way to check it was to open a
// chapter and count. The rule that matters most -- a wide page and the page before it each get their own
// slide -- did not exist at all: a landscape double-page spread was pinned beside a portrait page, and every
// pair after it was off by one for the rest of the chapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { pairSlides, pageHeight, isWide, type SpreadItem } from '../lib/readerSpread';
import { DEFAULT_PREFS, LOOK_KEYS, migratePrefs } from '../lib/readerPrefs';

const ROOT = join(__dirname, '..');
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

/** `p` portrait, `w` wide, `?` unknown dimensions; `|` starts a new chapter. */
const parse = (spec: string): SpreadItem[] => {
  const items: SpreadItem[] = [];
  let ci = -1;
  let first = true;
  for (const c of spec) {
    if (c === '|') { ci += 1; first = true; continue; }
    const dims = c === 'p' ? { width: 800, height: 1200 }
      : c === 'w' ? { width: 1600, height: 1200 }
      : { width: null, height: null };
    items.push({ ci, firstOfChapter: first, ...dims });
    first = false;
  }
  return items;
};
const shape = (spec: string, spread = true) =>
  pairSlides(parse(spec), spread).slides.map((s) => s.join('+')).join(' ');

test('single-page mode gives every page its own slide', () => {
  assert.equal(shape('|pppp', false), '0 1 2 3');
});

test('the first page of a chapter is solo, the rest pair', () => {
  assert.equal(shape('|ppppp'), '0 1+2 3+4');
});

test('pages do not pair across a chapter boundary', () => {
  // Reintroduce by dropping the `nxt.ci !== it.ci` term: index 2 pairs with 3, and one slide shows the last
  // page of one chapter beside the first page of the next.
  assert.equal(shape('|ppp|ppp'), '0 1+2 3 4+5');
});

test('THE BUG: a wide page is solo, and so is the page before it', () => {
  // Reintroduce by dropping `isWide(nxt)`: the wide page at index 3 pairs with 2 and gets squeezed to half
  // width, and every pair after it is shifted by one for the rest of the chapter.
  assert.equal(shape('|ppwpp'), '0 1 2 3+4');
});

test('a wide page is solo even when it is the very next page', () => {
  assert.equal(shape('|pwpp'), '0 1 2+3');
});

test('two wide pages in a row are each solo', () => {
  assert.equal(shape('|pwwp'), '0 1 2 3');
});

test('a chapter that is entirely wide pages pairs nothing', () => {
  assert.equal(shape('|wwww'), '0 1 2 3');
});

test('unknown dimensions pair as portrait, not as wide', () => {
  // Reintroduce by treating a missing width/height as wide: every Komga-backed chapter, and every book the
  // dimension backfill has not reached, silently drops to single-page.
  assert.equal(shape('|?????'), '0 1+2 3+4');
  assert.equal(isWide({ ci: 0, firstOfChapter: false, width: null, height: null }), false);
  assert.equal(isWide({ ci: 0, firstOfChapter: false }), false);
});

test('a zero or negative dimension is not wide either', () => {
  // A 0x0 page is a failed probe, not a landscape one. `w > h` alone would call 0x0 portrait but 5x0 wide.
  assert.equal(isWide({ ci: 0, firstOfChapter: false, width: 0, height: 0 }), false);
  assert.equal(isWide({ ci: 0, firstOfChapter: false, width: 5, height: 0 }), false);
});

test('slideOf points every page at the slide that holds it', () => {
  const items = parse('|ppwpp');
  const { slides, slideOf } = pairSlides(items, true);
  assert.equal(slideOf.length, items.length, 'every page must have a slide');
  slideOf.forEach((s, k) => assert.ok(slides[s].includes(k), `page ${k} is not in slide ${s}`));
});

test('an empty chapter list produces no slides and does not throw', () => {
  // v0.61.0: pairSlides also says which half of a wide page each slide shows (Wide pages → Split), so the empty answer
  // carries an empty `half` too -- updated deliberately, the slides themselves are unchanged.
  assert.deepEqual(pairSlides([], true), { slides: [], slideOf: [], half: [] });
});

// ---- v0.61.0, Reader → Wide pages ----
//
// Split, a wide page is two slides of the paged track -- its halves, in reading order -- that hold the SAME page:
// progress, the page counter, the server, OPDS, Komga's API and the trackers count pages and must never see a half.

const split = (spec: string, rightFirst = false, spread = false) =>
  pairSlides(parse(spec), spread, { split: true, rightFirst });

test('with Split off, every case above is what it was', () => {
  // Reintroduce by splitting whenever a page is wide: the single-page shapes above gain slides and this fails.
  for (const spec of ['|pppp', '|ppwpp', '|pwwp', '|wwww', '|?????', '|ppp|ppp']) {
    for (const spread of [false, true]) {
      const before = pairSlides(parse(spec), spread);
      const off = pairSlides(parse(spec), spread, { split: false, rightFirst: true });
      assert.deepEqual(off, before, `${spec} spread=${spread}`);
      assert.ok(before.half.every((h) => h === null), 'a slide shows half a page with Split off');
    }
  }
});

test('a wide page split is two slides that hold the same page', () => {
  const { slides, slideOf, half } = split('|pwp');
  assert.deepEqual(slides, [[0], [1], [1], [2]]);
  assert.deepEqual(half, [null, 'left', 'right', null]);
  assert.equal(slideOf[1], 1, 'a page points at its FIRST half');
  assert.equal(slideOf[2], 3);
});

test('left to right reads the left half first, right to left the right half', () => {
  // Reintroduce by ignoring rightFirst: a right-to-left spread reads its left half -- its second page -- first.
  assert.deepEqual(split('|w').half, ['left', 'right']);
  assert.deepEqual(split('|w', true).half, ['right', 'left']);
});

test('spread mode ignores Split: a wide page there already has a slide of its own', () => {
  const { slides, half } = split('|ppwpp', false, true);
  assert.deepEqual(slides.map((x) => x.join('+')), ['0', '1', '2', '3+4']);
  assert.ok(half.every((h) => h === null));
});

test('a page whose size is not known is never split', () => {
  assert.deepEqual(split('|?w?').slides, [[0], [1], [1], [2]]);
});

test('every page of the flow is on a slide, and no slide holds a page twice', () => {
  for (const spec of ['|pwwp|wpw', '|wwww', '|p?w|pp', '|ppwpp']) {
    for (const rightFirst of [false, true]) {
      const items = parse(spec);
      const { slides, slideOf, half } = pairSlides(items, false, { split: true, rightFirst });
      assert.deepEqual([...new Set(slides.flat())].sort((a, b) => a - b), items.map((_, k) => k), spec);
      assert.equal(half.length, slides.length);
      slides.forEach((idxs) => assert.equal(new Set(idxs).size, idxs.length));
      slideOf.forEach((s, k) => assert.ok(slides[s].includes(k) && (s === 0 || !slides[s - 1].includes(k)), `page ${k} does not start at its first slide`));
    }
  }
});

test('how tall a page stands in the webtoon column', () => {
  const tall = { ci: 0, firstOfChapter: false, width: 800, height: 1200 };
  const wide = { ci: 0, firstOfChapter: false, width: 2400, height: 1700 };
  const unknown = { ci: 0, firstOfChapter: false, width: null, height: null };
  assert.equal(pageHeight(tall, 400), 600, 'a page is colW x h / w');
  assert.equal(pageHeight(tall, 400, 'split'), 600, 'a page that is not wide is never split');
  assert.equal(pageHeight(tall, 400, 'rotate'), 600, 'a page that is not wide is never turned');
  // The same arithmetic as before v0.61.0, to the last bit: colW * (h / w), so no height in the column moved.
  assert.equal(pageHeight(wide, 400), 400 * (1700 / 2400), 'a wide page whole');
  assert.equal(pageHeight(wide, 400, 'split'), 4 * 400 * (1700 / 2400), 'split: two halves, each colW wide');
  assert.equal(pageHeight(wide, 400, 'rotate'), 400 * (2400 / 1700), 'turned: colW wide, colW x w / h tall');
  assert.equal(pageHeight(unknown, 400, 'split'), 560, 'unknown is the portrait guess of 1.4, never split');
});

test('Wide pages is stored like any reader default, and anything unknown reads as Whole', () => {
  // An older build's settings row has no `widePages`; a junk value must not split anybody's pages.
  // Reintroduce by dropping the WIDE_PAGES check in migratePrefs: the junk value survives.
  assert.equal(migratePrefs({}).widePages, 'whole');
  assert.equal(migratePrefs({ widePages: 'sideways' }).widePages, 'whole');
  assert.equal(migratePrefs({ widePages: 'split' }).widePages, 'split');
  assert.equal(DEFAULT_PREFS.widePages, 'whole', 'the default changed what every install shows');
  assert.ok(!(LOOK_KEYS as readonly string[]).includes('widePages'), 'Wide pages became a title\'s look');
});

test('the paged track counts a key press from the slide on screen, and re-anchors when the split changes', () => {
  // F4. `slideOf[current]` is a split page's FIRST half: from its second half the next press went back to the half
  // already on screen. Reintroduce `(slideOf[current] ?? current) + d` in the keyboard's step: this fails.
  const src = code(readFileSync(join(ROOT, 'app/reader/page.tsx'), 'utf8'));
  assert.match(src, /const to = Math\.max\(0, Math\.min\(last, slideNow\(\) \+ d\)\);/, 'the keyboard counts from slideOf[current] again');
  assert.doesNotMatch(src, /\(slideOf\[current\] \?\? current\) \+ d/, 'a key press counts from the page, not the slide on screen');
  // Turning the phone adds or removes a slide for every wide page before the one being read.
  assert.match(src, /laidOutSplit\.current === splitTrack\) return;\s*laidOutSplit\.current = splitTrack;\s*el\.scrollLeft = trackSign \* \(slideOf\[current\] \?\? current\) \* el\.clientWidth;/,
    'a change of split does not put the track back on the page being read');
  // And a split is drawn only upright and never in spread mode.
  assert.match(src, /const wideMode: WidePages = portrait && !\(prefs\.mode === 'paged' && prefs\.spread\) \? prefs\.widePages : 'whole';/);
});
