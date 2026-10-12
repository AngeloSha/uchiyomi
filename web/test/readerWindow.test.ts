// The webtoon column's window, prefetch, append and anchor (v0.61.0, lib/readerWindow.ts).
//
// The column kept a window of PAGES -- two behind, six ahead -- and a page can be anything from a 300 px slice to a
// 54,000 px strip. Over strips that is nine full-size images decoded at once (about 1.3 GB on the live server's
// Eleceed 215); over slices, two screens of lookahead. These tests build the reader's own height model (the same
// arithmetic as app/reader/page.tsx: a divider before each chapter after the first, a page as tall as colW * h / w)
// and check the window by what it covers on screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  AHEAD_SCREENS, APPEND_SCREENS, BEHIND_SCREENS, MAX_WINDOW_PAGES,
  anchorAt, indexAt, nearEnd, prefetchList, screenRange, scrollTopFor, windowSet,
} from '../lib/readerWindow';
import { renderWindow } from '../lib/readerFlow';

const ROOT = join(__dirname, '..');
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

interface Item { ci: number; width: number; height: number; collapsed?: boolean; firstOfChapter: boolean; key: string; number: number }
const DIVIDER_H = 60;
/** `chapters` of `pages` pages each, every page w x h. */
function flowOf(chapters: number, pages: number, w: number, h: number): Item[] {
  const out: Item[] = [];
  for (let c = 0; c < chapters; c++) for (let p = 0; p < pages; p++) out.push({ ci: c, width: w, height: h, firstOfChapter: p === 0, key: `c${c}:${p + 1}`, number: p + 1 });
  return out;
}
/** The reader's height model (app/reader/page.tsx): a collapsed page is a 48 px band, the rest are colW * h / w. */
function model(flow: Item[], colW: number, gap = 0) {
  const heights = flow.map((p) => (p.collapsed ? 48 : colW * (p.height / p.width)));
  const tops: number[] = [];
  let acc = 0;
  flow.forEach((p, i) => {
    if (p.firstOfChapter && p.ci > 0) acc += DIVIDER_H;
    tops.push(acc);
    acc += heights[i] + gap;
  });
  return { tops, heights, total: acc };
}
const SCREEN = 900;
const COL = 860;

test('a long strip spends the window', () => {
  // Five chapters of two 689 x 20,000 strips (the comfort fixture's Strip Long): each strip is ~25,000 px at 860.
  const flow = flowOf(5, 2, 689, 20000);
  const { tops, heights } = model(flow, COL);
  for (const top of [0, 12000, 24000, 40000, 60000, 99000]) {
    const view = { top, height: SCREEN };
    const current = indexAt(tops, top + SCREEN * 0.4);
    const win = windowSet(flow, screenRange(tops, heights, view, BEHIND_SCREENS, AHEAD_SCREENS), current);
    assert.ok(win.size <= 3, `at ${top} px the window holds ${win.size} strips (${[...win].join(', ')}), not at most three`);
    assert.ok(win.has(current), 'the strip being read is not in the window');
  }
  // What the window of pages held over the same flow -- the reason this module exists, and proof the flow is long
  // enough to show it.
  assert.equal(renderWindow(flow, 2, 2, 6).size, 9, 'the old window of pages no longer holds nine strips here: the fixture changed');
  // And the column uses it. Reintroduce the window of pages for the webtoon column (renderWindow(flat, current, …) in
  // app/reader/page.tsx's vertical branch): this fails.
  const page = code(readFileSync(join(ROOT, 'app/reader/page.tsx'), 'utf8'));
  assert.match(page, /\(prefs\.mode === 'vertical'\s*\? windowSet\(flat, win, current, MAX_WINDOW_PAGES\)\s*: renderWindow\(flat, current, WINDOW_BEHIND, WINDOW_AHEAD\)\)/,
    'the webtoon column no longer decides its window by screens');
});

test('thin slices fill at least four screens ahead', () => {
  // 120 slices of 720 x 300 at 720 wide: 300 px each, three to a screen. Six pages ahead was two screens.
  const flow = flowOf(1, 120, 720, 300);
  const { tops, heights } = model(flow, 720);
  const view = { top: 9000, height: SCREEN };
  const current = indexAt(tops, view.top + SCREEN * 0.4);
  const win = windowSet(flow, screenRange(tops, heights, view, BEHIND_SCREENS, AHEAD_SCREENS), current);
  const last = Math.max(...win);
  const first = Math.min(...win);
  assert.ok(tops[last] + heights[last] >= view.top + view.height + AHEAD_SCREENS * view.height,
    `the window ends ${(tops[last] + heights[last] - view.top - view.height) / SCREEN} screens below the one in view`);
  assert.ok(tops[first] <= view.top - BEHIND_SCREENS * view.height, 'the window does not keep a screen and a half behind');
  // The old window's reach on the same flow, for contrast: two screens.
  const old = renderWindow(flow, current, 2, 6);
  assert.ok(tops[Math.max(...old)] + 300 < view.top + view.height + 2.5 * SCREEN, 'the fixture no longer shows the old window falling short');
});

test('the cap holds however thin the pages, and spends itself ahead first', () => {
  const flow = flowOf(1, 400, 720, 40); // 40 px slivers: 6.5 screens is ~146 of them
  const { tops, heights } = model(flow, 720);
  const view = { top: 6000, height: SCREEN };
  const current = indexAt(tops, view.top + SCREEN * 0.4);
  const win = windowSet(flow, screenRange(tops, heights, view, BEHIND_SCREENS, AHEAD_SCREENS), current);
  assert.equal(win.size, MAX_WINDOW_PAGES);
  assert.ok([...win].every((i) => i >= current), 'pages behind were kept while pages ahead were dropped');
});

test('a collapsed page is never in the window and never counts against it', () => {
  // Reintroduce by dropping the `collapsed` checks in windowSet: a collapsed page is in the set, and with the cap
  // reached the last page ahead falls out.
  const flow = flowOf(1, 30, 720, 900);
  flow[11].collapsed = true;
  flow[12].collapsed = true;
  const { tops, heights } = model(flow, 720);
  const view = { top: tops[10], height: SCREEN };
  const range = screenRange(tops, heights, view, BEHIND_SCREENS, AHEAD_SCREENS);
  const win = windowSet(flow, range, 10);
  assert.ok(!win.has(11) && !win.has(12), 'a collapsed page is in the window');
  const capped = windowSet(flow, range, 10, 4);
  assert.deepEqual([...capped].sort((a, b) => a - b), [10, 13, 14, 15], 'collapsed pages spent the cap');
  // A collapsed current page is drawn from its thumbnail, so it is not in either.
  assert.ok(!windowSet(flow, range, 11).has(11));
});

test('the next chapter is appended six screens from the end', () => {
  // A chapter of two strips: the end is ~50,000 px down, and six screens before it the tail says so.
  const strips = flowOf(1, 2, 689, 20000);
  const s = model(strips, COL);
  const at = (bottom: number) => ({ top: bottom - SCREEN, height: SCREEN });
  assert.equal(nearEnd(s.total, at(s.total - APPEND_SCREENS * SCREEN), APPEND_SCREENS), true, 'six screens from the end of a 2-strip chapter is not the tail');
  assert.equal(nearEnd(s.total, at(s.total - APPEND_SCREENS * SCREEN - 1), APPEND_SCREENS), false, 'more than six screens from the end is already the tail');
  // Thin slices: "four pages before the end" is a screen and a third, which is why the column also appends by screens.
  const slices = flowOf(1, 120, 720, 300);
  const m = model(slices, 720);
  const fourBefore = { top: m.tops[116] - SCREEN * 0.4, height: SCREEN };
  assert.ok(m.total - (fourBefore.top + SCREEN) < 2 * SCREEN, 'the fixture no longer shows the page rule firing late');
  assert.equal(nearEnd(m.total, { top: m.total - 7 * SCREEN + 1, height: SCREEN }, APPEND_SCREENS), true);
  // And the reader asks it. Reintroduce the page rule alone (drop `&& tail`'s clause from the append effect): fails.
  const page = code(readFileSync(join(ROOT, 'app/reader/page.tsx'), 'utf8'));
  assert.match(page, /if \(current < flat\.length - 4 && !\(prefs\.mode === 'vertical' && tail\)\) return;/, 'the webtoon column no longer appends from the tail');
  assert.match(page, /const t = nearEnd\(total, view, APPEND_SCREENS\);/, 'the tail is no longer APPEND_SCREENS from the end');
});

test('the anchor keeps its point through a double zoom and a page growing above it', () => {
  // Reintroduce `el.scrollTop = tops[current]` on a zoom (F5): the point returns to the TOP of the page, not where the
  // reader was in it -- frac 0.62 of a strip is 15,000 px down it.
  const flow = flowOf(2, 6, 720, 1600);
  const z1 = model(flow, 720, 4);
  const probe = SCREEN * 0.4;
  const y = z1.tops[3] + 0.62 * z1.heights[3];
  const a = anchorAt(z1.tops, z1.heights, y);
  assert.equal(a.index, 3);
  assert.ok(Math.abs(a.frac - 0.62) < 1e-9);
  const z2 = model(flow, 1440, 4);
  const top2 = scrollTopFor(a, z2.tops, z2.heights, probe);
  const back = anchorAt(z2.tops, z2.heights, top2 + probe);
  assert.equal(back.index, 3, 'the zoom moved the reader to another page');
  assert.ok(Math.abs(back.frac - 0.62) < 1e-9, `the zoom moved the reader within the page (${back.frac})`);
  // A page above grows (a repeated page opened, a crop measured): the point moves down by exactly that much.
  const grown = flow.map((p, i) => (i === 1 ? { ...p, height: p.height + 500 } : p));
  const g = model(grown, 720, 4);
  const shifted = scrollTopFor(a, g.tops, g.heights, probe);
  assert.ok(Math.abs(shifted - (y - probe) - (g.tops[3] - z1.tops[3])) < 1e-6, 'a page growing above the anchor moved the point being read');
  // The anchored page itself changing height keeps the same fraction of it.
  const self = flow.map((p, i) => (i === 3 ? { ...p, height: p.height * 1.5 } : p));
  const sm = model(self, 720, 4);
  const at = anchorAt(sm.tops, sm.heights, scrollTopFor(a, sm.tops, sm.heights, probe) + probe);
  assert.ok(at.index === 3 && Math.abs(at.frac - 0.62) < 1e-9);
  // The column restores it. Reintroduce the snap to the page's top in the zoom effect, or drop the layout effect: fails.
  const page = code(readFileSync(join(ROOT, 'app/reader/page.tsx'), 'utf8'));
  assert.doesNotMatch(page, /el\.scrollTop = tops\[current\];/, 'the zoom snaps the column to the top of the page again (F5)');
  assert.match(page, /const target = scrollTopFor\(\{ index: i, frac: a\.frac \}, tops, heights, el\.clientHeight \* PROBE\);/, 'the column no longer puts the anchor back');
  assert.match(page, /\}, \[tops, heights\]\);/, 'the anchor is no longer restored when the layout changes');
});

test('the window and the anchor read the same page as the probe always did', () => {
  // The page being read is the one under a line 40 % down the screen. indexAt is that binary search.
  const flow = flowOf(1, 10, 720, 900);
  const { tops } = model(flow, 720);
  assert.equal(indexAt(tops, 0), 0);
  assert.equal(indexAt(tops, 899), 0);
  assert.equal(indexAt(tops, 900), 1);
  assert.equal(indexAt(tops, 1e9), 9);
  assert.equal(indexAt([], 100), 0, 'an empty column reads page 0, as the old search did');
  assert.deepEqual(screenRange([], [], { top: 0, height: SCREEN }, 1, 1), { from: 0, to: -1 });
});

test('the prefetch takes six pages or 48 megapixels after the window, whichever comes first', () => {
  const slices = flowOf(1, 30, 720, 1000);
  assert.deepEqual(prefetchList(slices, 9), [10, 11, 12, 13, 14, 15], 'six pages');
  const strips = flowOf(2, 4, 689, 20000); // 13.8 MP each
  assert.deepEqual(prefetchList(strips, 0), [1, 2, 3], 'a fourth strip would pass 48 MP');
  const huge = flowOf(1, 3, 2000, 40000); // 80 MP: over the budget alone, and still the first is fetched
  assert.deepEqual(prefetchList(huge, 0), [1]);
  const withBand = flowOf(1, 6, 720, 1000);
  withBand[2].collapsed = true;
  assert.deepEqual(prefetchList(withBand, 0), [1, 3, 4, 5], 'a collapsed page, drawn from a thumbnail, was fetched in full');
  assert.deepEqual(prefetchList(slices, 29), [], 'nothing after the last page');
});
