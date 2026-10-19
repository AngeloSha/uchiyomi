// A reader's own say on where a spread is (v0.89.0, #262 by @Squeaks72, rebuilt): the marks applied to the flow, what
// the page being read offers, and the reader's wiring by its source, as readerJoin.test.ts holds the detector's joins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { applyMarks, markOf, spreadOptions, withMark } from '../lib/spreadMarks';
import { joinedOrder, pairSlides } from '../lib/readerSpread';
import { buildFlow } from '../lib/readerFlow';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

interface P { ci: number; number: number; width: number; height: number; firstOfChapter: boolean; join?: 'rtl' | 'ltr'; mark?: 'join' | 'split'; forced?: boolean; missing?: boolean }
/** One chapter of portrait pages numbered from 1, with `extra` per page number. */
const ch = (n: number, extra: Record<number, Partial<P>> = {}, ci = 0): P[] =>
  Array.from({ length: n }, (_, k) => ({ ci, number: k + 1, width: 800, height: 1200, firstOfChapter: k === 0, ...extra[k + 1] }));

test('nothing marked leaves the flow alone: the very array', () => {
  const flat = ch(6, { 3: { join: 'rtl' } });
  assert.equal(applyMarks(flat, 'rtl'), flat, 'a flow memoised on it must not change');
});

test('a merge joins a pair the detector left alone, drawn the way the book reads, and holds with joining off', () => {
  const flat = applyMarks(ch(6, { 4: { mark: 'join' } }), 'rtl');
  assert.equal(flat[3].join, 'rtl');
  assert.equal(flat[3].forced, true);
  // Reintroduce by dropping `!a?.forced` from pairSlides' joinAt: with Join split double pages off the merge is two pages.
  for (const spread of [false, true]) {
    const r = pairSlides(flat, spread, { joinSplit: false });
    const at = r.slides.findIndex((s) => s.includes(3));
    assert.deepEqual(r.slides[at], [3, 4], `the reader's merge is one slide (spread ${spread})`);
    assert.equal(r.joined[at], true);
  }
  // Drawn as a right-to-left book's spread: page 5 on the left. On a left-to-right read, page 4 on the left.
  assert.deepEqual(joinedOrder(3, 4, flat[3].join), [4, 3]);
  assert.deepEqual(joinedOrder(3, 4, applyMarks(ch(6, { 4: { mark: 'join' } }), 'ltr')[3].join), [3, 4]);
});

test('a split takes the detector\'s join apart, and the flow given in is not changed', () => {
  const given = ch(6, { 2: { join: 'rtl', mark: 'split' } });
  const flat = applyMarks(given, 'rtl');
  assert.equal(flat[1].join, undefined);
  assert.equal(given[1].join, 'rtl');
  assert.ok(pairSlides(flat, false, { joinSplit: true }).joined.every((j) => !j), 'nothing is joined');
});

test('a page is in one spread only: a merge takes the detector\'s joins off both neighbouring pairs', () => {
  // Detector: 3-4 and 5-6. The reader merges 4-5. Reintroduce by keeping the neighbours' joins: page 4 or 5 is in two spreads.
  const flat = applyMarks(ch(8, { 3: { join: 'rtl' }, 4: { mark: 'join' }, 5: { join: 'rtl' } }), 'rtl');
  assert.deepEqual(flat.map((p) => p.join ?? '-').join(' '), '- - - rtl - - - -');
  assert.deepEqual(pairSlides(flat, false, { joinSplit: true }).slides, [[0], [1], [2], [3, 4], [5], [6], [7]]);
});

test('a merge never joins across a chapter, past a hidden page, into a wide page or a placeholder', () => {
  // The flow's rules stand for a reader's merge as for the detector's: only consecutive portrait pages of one chapter.
  const two = [...ch(3, { 3: { mark: 'join' } }), ...ch(3, {}, 1)];
  assert.ok(pairSlides(applyMarks(two, 'ltr'), false).joined.every((j) => !j), 'not across chapters');
  const gap = ch(5, { 2: { mark: 'join' } }).filter((p) => p.number !== 3);
  assert.ok(pairSlides(applyMarks(gap, 'ltr'), false).joined.every((j) => !j), 'not past a page taken out of the flow');
  const wide = ch(4, { 2: { mark: 'join' }, 3: { width: 1600, height: 1200 } });
  assert.ok(pairSlides(applyMarks(wide, 'ltr'), false).joined.every((j) => !j), 'not into a wide page');
  const hole = ch(4, { 2: { mark: 'join' }, 3: { missing: true } });
  assert.ok(pairSlides(applyMarks(hole, 'ltr'), false).joined.every((j) => !j), 'not into a placeholder');
});

/** The options at page `n` of one chapter, as the reader asks for them: from the slides on screen. */
function optionsAt(flat: P[], n: number, o: { spread?: boolean; nextIsLeft?: boolean; detector?: boolean } = {}) {
  const shown = applyMarks(flat, o.nextIsLeft ? 'rtl' : 'ltr');
  const r = pairSlides(shown, !!o.spread, { joinSplit: o.detector ?? true });
  const at = shown.findIndex((p) => p.number === n);
  const s = r.slideOf[at];
  return spreadOptions(shown, at, { slide: r.slides[s], joined: r.joined[s], nextIsLeft: !!o.nextIsLeft, detector: o.detector ?? true });
}

test('left and right are the screen\'s: on a right-to-left track the next page is the one on the left', () => {
  // Reintroduce by naming the next page "right" whatever the track: the Arabic and Japanese readers merge the wrong page.
  assert.deepEqual(optionsAt(ch(6), 3), [
    { kind: 'merge', side: 'left', first: 2 },
    { kind: 'merge', side: 'right', first: 3 },
  ]);
  assert.deepEqual(optionsAt(ch(6), 3, { nextIsLeft: true }), [
    { kind: 'merge', side: 'left', first: 3 },
    { kind: 'merge', side: 'right', first: 2 },
  ]);
});

test('the ends of a chapter, a wide page and a placeholder offer what they can, and no more', () => {
  assert.deepEqual(optionsAt(ch(6), 1), [{ kind: 'merge', side: 'right', first: 1 }], 'page 1 has no page before it');
  assert.deepEqual(optionsAt(ch(6), 6), [{ kind: 'merge', side: 'left', first: 5 }], 'the last page none after it');
  assert.deepEqual(optionsAt(ch(6, { 3: { width: 1600, height: 1200 } }), 3), [], 'a wide page is a spread already');
  assert.deepEqual(optionsAt(ch(6, { 4: { width: 1600, height: 1200 } }), 3), [{ kind: 'merge', side: 'left', first: 2 }]);
  assert.deepEqual(optionsAt(ch(6, { 4: { missing: true } }), 4), []);
});

test('a joined pair offers its way apart: the detector\'s is split, the reader\'s own undone, and a split given back', () => {
  assert.deepEqual(optionsAt(ch(6, { 3: { join: 'rtl' } }), 4), [{ kind: 'split', first: 3 }], 'from either page of it');
  assert.deepEqual(optionsAt(ch(6, { 3: { mark: 'join' } }), 3), [{ kind: 'unmerge', first: 3 }]);
  // Split, the pair is two pages again: each can be given back, and still merges with its other neighbour.
  assert.deepEqual(optionsAt(ch(6, { 3: { join: 'rtl', mark: 'split' } }), 4), [
    { kind: 'restore', first: 3 },
    { kind: 'merge', side: 'left', first: 3 },
    { kind: 'merge', side: 'right', first: 4 },
  ]);
  // With Join split double pages off the detector's joins are not shown, so there is nothing to give back to.
  assert.deepEqual(optionsAt(ch(6, { 3: { join: 'rtl', mark: 'split' } }), 4, { detector: false }).map((o) => o.kind), ['merge', 'merge']);
});

test('the marks an option writes, and the set the reader shows before the server answers', () => {
  assert.equal(markOf({ kind: 'merge', side: 'left', first: 2 }), 'join');
  assert.equal(markOf({ kind: 'split', first: 2 }), 'split');
  assert.equal(markOf({ kind: 'unmerge', first: 2 }), null);
  assert.equal(markOf({ kind: 'restore', first: 2 }), null);
  // As the server keeps them (bff lib/spreadMarks.ts setMark): a merge takes the reader's merges off its neighbours.
  const m = withMark(new Map([[2, 'join'], [4, 'join'], [7, 'split']] as const), 3, 'join');
  assert.deepEqual([...m].sort(), [[3, 'join'], [7, 'split']]);
  assert.deepEqual([...withMark(m, 3, null)], [[7, 'split']]);
});

test('the mark rides the flow from the page list, the download and the reader', () => {
  // Reintroduce by leaving `mark` off buildFlow's item: nothing the reader marked is ever applied.
  const flow = buildFlow([{ id: 'c', pages: [{ number: 1, width: 1, height: 2 }, { number: 2, width: 1, height: 2, mark: 'join' }] }], 'show');
  assert.equal(flow[1].mark, 'join');
  const reader = code(read('app/reader/page.tsx'));
  assert.match(reader, /join: p\.join, mark: p\.mark \}/, 'the page list\'s `mark` is kept');
  assert.match(reader, /applyMarks\(buildFlow\(chapters, flowJunk, expanded\) as FlatItem\[\], markDir\)/, 'the marks are applied to the flow');
  const dl = code(read('lib/downloads.ts'));
  assert.match(dl, /join: p\.join, mark: p\.mark \}/, 'a downloaded chapter keeps the account\'s marks');
  // The same choices in the reader settings sheet and on the right-click menu.
  assert.match(reader, /spreadChoices=\{spreadChoices\.map\(/);
  assert.match(reader, /for \(const o of spreadChoices\) items\.push\(\{ label: spreadLabel\(o\), onSelect: \(\) => applySpread\(o\) \}\)/);
});

test('a pair taken apart shows its first page, the one being read; any other change keeps the page being read', () => {
  // `current` is a two-page slide's LAST page (completion fires on it), so re-anchoring on it put Undo the merge on the
  // pair's second page. Found by the v0.89.0 browser walk. Reintroduce by anchoring on `current` alone: this fails.
  const reader = code(read('app/reader/page.tsx'));
  assert.match(reader, /const apart = !!was && was\.length === 2 && shownJoined\.current\[pagedSlide\.current\] && slideOf\[was\[0\]\] !== slideOf\[was\[1\]\];\s*const anchor = apart \? was\[0\] : current;\s*placeTrack\(el, slideOf\[anchor\] \?\? anchor\);/);
  // What the effect compares with is the slides on screen before this render: kept by a passive effect, after the layout one.
  assert.match(reader, /useEffect\(\(\) => \{ shownSlides\.current = slides; shownJoined\.current = joined; \}\);/);
});

