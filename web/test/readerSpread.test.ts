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
  // carries an empty `half` too -- updated deliberately, the slides themselves are unchanged. And since v0.77.0 (#229)
  // which slides are a joined spread: `joined`, empty too.
  assert.deepEqual(pairSlides([], true), { slides: [], slideOf: [], half: [], joined: [] });
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
  // (v0.61.0, G5: keys, the controller and taps all turn through `perform`, which counts from `from = slideNow()`.)
  assert.match(src, /const from = slideNow\(\);\s*const to = Math\.max\(0, Math\.min\(last, from \+ d\)\);/, 'the keyboard counts from slideOf[current] again');
  assert.doesNotMatch(src, /\(slideOf\[current\] \?\? current\) \+ d/, 'a key press counts from the page, not the slide on screen');
  // Turning the phone adds or removes a slide for every wide page before the one being read.
  // (Through placeTrack since #263: the place it puts the track is also the place a resize in the same turn keeps.)
  assert.match(src, /laidOutSplit\.current === splitTrack\) return;\s*laidOutSplit\.current = splitTrack;\s*placeTrack\(el, slideOf\[current\] \?\? current\);/,
    'a change of split does not put the track back on the page being read');
  // And a split is drawn only upright and never in spread mode.
  assert.match(src, /const wideMode: WidePages = portrait && !\(prefs\.mode === 'paged' && prefs\.spread\) \? prefs\.widePages : 'whole';/);
});

// Shift pairs by one page.
test('shifted, a chapter pairs from its first page; not shifted, page 1 stays solo as before', async () => {
  // Reintroduce by dropping `&& !opts.shift` in pairSlides: a chapter file whose page 1 is a story page stays one off.
  const { pairSlides } = await import('../lib/readerSpread');
  const ch = (n: number, ci = 0) => Array.from({ length: n }, (_, i) => ({ ci, firstOfChapter: i === 0, width: 800, height: 1200 }));
  assert.deepEqual(pairSlides(ch(5), true).slides, [[0], [1, 2], [3, 4]]);
  assert.deepEqual(pairSlides(ch(5), true, { shift: true }).slides, [[0, 1], [2, 3], [4]]);
  // still never across chapters, and a wide page still stands alone
  const two = [...ch(3, 0), ...ch(2, 1).map((p) => ({ ...p }))];
  assert.deepEqual(pairSlides(two, true, { shift: true }).slides, [[0, 1], [2], [3, 4]]);
  const wide = ch(4); wide[2] = { ...wide[2], width: 1600, height: 1200 };
  assert.deepEqual(pairSlides(wide, true, { shift: true }).slides, [[0, 1], [2], [3]]);
});

// Shift pairs by one page, fuzzed (deterministic randomized coverage): whatever the chapter, every page is on
// exactly one slide in order, pairs are two neighbours of one chapter, a wide page and the page before it are alone,
// and shifting only moves where the pairs fall.
test('shift: random chapters keep every page once, in order, and the wide-page rules', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let run = 0; run < 500; run++) {
    const items: SpreadItem[] = [];
    let ci = -1;
    const n = Math.floor(rnd() * 40);
    for (let k = 0; k < n; k++) {
      const first = k === 0 || rnd() < 0.08;
      if (first) ci++;
      const r = rnd();
      items.push({ ci, firstOfChapter: first, ...(r < 0.15 ? { width: 2000, height: 1400 } : r < 0.25 ? {} : { width: 1000, height: 1400 }) });
    }
    for (const shift of [false, true]) {
      const { slides, slideOf } = pairSlides(items, true, { shift });
      assert.deepEqual(slides.flat(), items.map((_, k) => k));
      slides.forEach((s, i) => {
        assert.ok(s.length === 1 || s.length === 2);
        for (const k of s) assert.equal(slideOf[k], i);
        if (s.length === 2) {
          assert.equal(s[1], s[0] + 1);
          assert.equal(items[s[0]].ci, items[s[1]].ci);
          assert.ok(!isWide(items[s[0]]) && !isWide(items[s[1]]));
          assert.ok(!items[s[1]].firstOfChapter);
          if (!shift) assert.ok(!items[s[0]].firstOfChapter);
        }
      });
    }
  }
});

test('shift pairs page 1 with page 2, and a wide page still restarts the pairing', () => {
  const its = (spec: string): SpreadItem[] => [...spec].map((c, k) => ({ ci: 0, firstOfChapter: k === 0, ...(c === 'w' ? { width: 2, height: 1 } : { width: 1, height: 2 }) }));
  assert.deepEqual(pairSlides(its('pppp'), true, { shift: true }).slides, [[0, 1], [2, 3]]);
  assert.deepEqual(pairSlides(its('pppp'), true).slides, [[0], [1, 2], [3]]);
  assert.deepEqual(pairSlides(its('pppwppp'), true, { shift: true }).slides, [[0, 1], [2], [3], [4, 5], [6]]);
});

test('the reader re-pairs when Shift is toggled: spreadShift is in the slides memo and re-anchors the track', () => {
  const src = code(readFileSync(join(ROOT, 'app/reader/page.tsx'), 'utf8'));
  // v0.77.1 merge: v0.77.0's Join split double pages (prefs.joinSplit) is in the same memo now, after spreadShift.
  assert.match(src, /\[flat, prefs\.mode, prefs\.spread, splitTrack, rightFirst, spreadShift, prefs\.joinSplit\]/);
  assert.match(src, /\}, \[prefs\.spread, spreadShift\]\);/);
});

test('shift preserves explicit detected joins and has no effect outside double spread mode', () => {
  const items = parse('pppp').map((p, i) => ({ ...p, number: i + 1 }));
  items[0] = { ...items[0], join: 'rtl' };
  const paired = pairSlides(items, true, { shift: true, joinSplit: true });
  assert.deepEqual(paired.slides, [[0, 1], [2, 3]]);
  assert.deepEqual(paired.joined, [true, false]);
  assert.deepEqual(pairSlides(items, false, { shift: true }).slides, [[0], [1], [2], [3]]);
});
