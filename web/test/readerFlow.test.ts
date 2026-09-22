// The reading flow, and the four bugs that came from filtering it.
//
// A repeated page — a scanlator credit page, an advert — used to be REMOVED from the list the reader indexes
// into. That is what made "flat index" and "page number" two different things, and four separate failures all
// grew out of that one gap. None of them were reachable by a test while the arithmetic lived inside an
// 800-line component, which is why this module exists at all.
//
// ⚠️ Every guard below is asserted under `hide` as well as `collapse`. Under `collapse` nothing is removed,
// so all four bugs are impossible by construction and a test that only covered that mode would pass whether
// or not the fix were real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFlow, startIndex, renderWindow, type FlowChapter } from '../lib/readerFlow';

const page = (n: number, junk = false) => ({ number: n, width: 800, height: 1200, junk: junk || undefined });

/** One chapter: a credit page, then three pages of story. The shape the feature is actually for. */
const chapter = (id: string): FlowChapter => ({ id, pages: [page(1, true), page(2), page(3), page(4)] });

test('a collapsed page is still in the flow', () => {
  // Reintroduce by filtering junk out in `collapse` mode: the length drops to 3 and every index below moves.
  const flow = buildFlow([chapter('c1')], 'collapse');
  assert.equal(flow.length, 4, 'nothing may be removed when pages are collapsed');
  assert.equal(flow[0].collapsed, true, 'the credit page is the collapsed one');
  assert.equal(flow[1].collapsed, false, 'a story page is not');
});

test('expanding a page un-collapses exactly that page', () => {
  const flow = buildFlow([chapter('c1')], 'collapse', new Set(['c1:1']));
  assert.equal(flow[0].collapsed, false);
  assert.equal(flow.length, 4);
});

test('show mode collapses nothing and hide mode removes', () => {
  assert.equal(buildFlow([chapter('c1')], 'show').every((f) => !f.collapsed), true);
  assert.deepEqual(buildFlow([chapter('c1')], 'hide').map((f) => f.number), [2, 3, 4]);
  // and a page asked for by hand comes back even in hide
  assert.deepEqual(buildFlow([chapter('c1')], 'hide', new Set(['c1:1'])).map((f) => f.number), [1, 2, 3, 4]);
});

test('the first page of a chapter is marked even when page 1 was removed', () => {
  // ⚠️ THE BUG: `firstOfChapter` was computed as "index 0 of the chapter" and then read on a list those pages
  // had been removed from, so when page 1 was the credit page NOTHING carried the flag. The reader draws the
  // "Up Next / chapter title" divider from it, and `pairSlides` keeps a chapter's first page solo from it —
  // so the divider vanished AND every double-page spread in that chapter shifted by one.
  // Reintroduce by setting firstOfChapter from the source page index instead of the output position.
  const flow = buildFlow([chapter('c1'), chapter('c2')], 'hide');
  const firsts = flow.filter((f) => f.firstOfChapter);
  assert.equal(firsts.length, 2, 'every chapter in the flow starts exactly once');
  assert.equal(firsts[1].ci, 1);
  assert.equal(firsts[1].number, 2, 'page 1 was removed, so page 2 is where the chapter starts');
});

test('a chapter that is nothing but furniture still reads', () => {
  // ⚠️ The guard used to be one check over the WHOLE list — `out.length ? out : all`. With a normal chapter
  // beside it the list is non-empty, so an all-furniture chapter was dropped entirely and continuous reading
  // walked from chapter 1 to chapter 3 with only a divider to show for it. Reachable by hand-marking, which
  // the server's one-third cap deliberately does not limit.
  // Reintroduce by testing the total length instead of each chapter's.
  const allJunk: FlowChapter = { id: 'c2', pages: [page(1, true), page(2, true)] };
  const flow = buildFlow([chapter('c1'), allJunk], 'hide');
  assert.deepEqual(flow.filter((f) => f.ci === 1).map((f) => f.number), [1, 2],
    'a chapter cannot be removed from the flow entirely');
});

test('resume resolves a page NUMBER, not an index', () => {
  // ⚠️ THE BUG: `startPage - 1`. That is an index into a list holding every page, which stops being true the
  // moment one is removed — and the drift is silent, so you simply resume a little past where you left off.
  // Reintroduce by returning `pageNumber - 1`: the hide case below lands on page 4 instead of page 3.
  const collapse = buildFlow([chapter('c1')], 'collapse');
  assert.equal(collapse[startIndex(collapse, 0, 3)].number, 3);
  const hide = buildFlow([chapter('c1')], 'hide');
  assert.equal(hide[startIndex(hide, 0, 3)].number, 3, 'a saved Moment on page 3 must open page 3');
  assert.notEqual(startIndex(hide, 0, 3), 3 - 1, 'and it is not the same as subtracting one');
});

test('a page that was removed still resolves to somewhere sensible', () => {
  const hide = buildFlow([chapter('c1')], 'hide');
  assert.equal(hide[startIndex(hide, 0, 1)].number, 2, 'the removed page lands on the next one that survived');
});

test('every page of the chapter has a real index to jump to', () => {
  // ⚠️ THE BUG: the page grid looked each tile up in the reading flow, which returned -1 for a removed page,
  // and `jumpTo` clamps -1 to 0 — so tapping a dimmed tile scrolled to the top of the entire library.
  // Reintroduce by resolving a grid tile with `flow.findIndex(f => f.key === key)` on a filtered list.
  for (const mode of ['show', 'collapse', 'hide'] as const) {
    const flow = buildFlow([chapter('c1')], mode);
    for (const n of [1, 2, 3, 4]) {
      assert.ok(startIndex(flow, 0, n) >= 0, `page ${n} has nowhere to jump to in ${mode} mode`);
    }
  }
});

test('a collapsed page does not spend the prefetch budget', () => {
  // Reintroduce by counting every index in the window: with a strip at current+1 the last real page of the
  // lookahead falls out of the set, and the reader waits on a decode it should already have had.
  const ch: FlowChapter = { id: 'c1', pages: [page(1), page(2, true), page(3), page(4), page(5)] };
  const flow = buildFlow([ch], 'collapse');
  const win = renderWindow(flow, 0, 0, 2);
  assert.equal(win.has(1), false, 'the collapsed page needs no full-size decode');
  assert.deepEqual([...win].sort((a, b) => a - b), [0, 2, 3], 'and two REAL pages are still looked ahead');
});

test('expanding a page puts it back in the window', () => {
  const ch: FlowChapter = { id: 'c1', pages: [page(1), page(2, true), page(3)] };
  const flow = buildFlow([ch], 'collapse', new Set(['c1:2']));
  assert.equal(renderWindow(flow, 0, 0, 2).has(1), true);
});

// ---- v0.40.0: a page the source never served ----

test('a missing page passes through the flow untouched, in every mode', () => {
  // The server saves a chapter short with a flat placeholder at the hole and marks that page `missing`
  // (`/api/books/:id/pages`). The reader draws its caption from the flag on the FLOW item, so the flag has
  // to survive the trip through `buildFlow` -- and the page has to stay a page: never collapsed, never
  // removed, whatever the junk mode. Collapsing it would put two lines of caption on a 48 px strip; hiding
  // it would make "flat index" and "page number" differ again for exactly the page whose number the
  // caption prints. Reintroduce by leaving `missing: p.missing` off the flow item in buildFlow: the caption
  // has nothing to key on and the placeholder renders as a blank grey page.
  // A placeholder may inherit `junk` from an earlier scan or a stale/manual classification. `missing` wins:
  // hiding or collapsing the only evidence of the hole would make the page silently disappear again.
  const ch: FlowChapter = { id: 'c1', pages: [page(1), { number: 2, width: 800, height: 1200, junk: true, missing: true }, page(3, true), page(4)] };
  for (const mode of ['show', 'collapse', 'hide'] as const) {
    const flow = buildFlow([ch], mode);
    const hole = flow.find((f) => f.number === 2);
    assert.ok(hole, `${mode}: the missing page is still in the flow`);
    assert.equal(hole.missing, true, `${mode}: the missing flag reaches the flow item`);
    assert.equal(hole.collapsed, false, `${mode}: a missing page is never collapsed`);
    assert.equal(flow.find((f) => f.number === 1)?.missing, undefined, `${mode}: a served page carries no flag`);
  }
  // And the hole keeps its place: page 2 is index 1 with nothing before it removed.
  assert.equal(startIndex(buildFlow([ch], 'show'), 0, 2), 1);
});
