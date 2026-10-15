// A reader's own say on where a spread is (lib/spreadMarks.ts): marks applied to the flow, and the options offered per page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMarks, markFor, spreadOptions } from '../lib/spreadMarks';
import { pairSlides } from '../lib/readerSpread';

interface P { ci: number; number: number; width: number; height: number; join?: 'rtl' | 'ltr'; forced?: boolean; firstOfChapter: boolean }
const page = (number: number, extra: Partial<P> = {}): P => ({ ci: 0, number, width: 800, height: 1200, firstOfChapter: number === 1, ...extra });
const flat = [page(1), page(2, { join: 'rtl' }), page(3), page(4), page(5)];

test('no marks leaves the flow as it is, the very array', () => {
  assert.equal(applyMarks(flat, [undefined], 'rtl'), flat);
  assert.equal(applyMarks(flat, [{}], 'rtl'), flat);
});

test('split takes the detector\'s join off a pair; the input is not changed', () => {
  const out = applyMarks(flat, [{ 2: 'split' }], 'rtl');
  assert.equal(out[1].join, undefined);
  assert.equal(flat[1].join, 'rtl');
});

test('join pairs two pages the detector left alone, on the side the track reads from, and it is forced', () => {
  const rtl = applyMarks(flat, [{ 4: 'join' }], 'rtl');
  assert.deepEqual([rtl[3].join, rtl[3].forced], ['rtl', true]);
  assert.equal(applyMarks(flat, [{ 4: 'join' }], 'ltr')[3].join, 'ltr');
});

test('a page is in one spread only: a join takes the neighbours\' joins', () => {
  const f = [page(1), page(2, { join: 'rtl' }), page(3), page(4), page(5)];
  const out = applyMarks(f, [{ 3: 'join' }], 'rtl');
  assert.equal(out[1].join, undefined, 'the detector\'s 2-3 would take page 3 twice');
  assert.equal(out[2].join, 'rtl');
  const g = [page(1), page(2), page(3, { join: 'ltr' }), page(4)];
  assert.equal(applyMarks(g, [{ 2: 'join' }], 'rtl')[2].join, undefined, '3 is the second half of 2-3 now');
});

test('marks belong to their chapter', () => {
  const two = [page(1), page(2), page(1, { ci: 1 }), page(2, { ci: 1 })];
  assert.deepEqual(applyMarks(two, [undefined, { 1: 'join' }], 'rtl').map((p) => p.join), [undefined, undefined, 'rtl', undefined]);
});

test('a reader\'s join pairs the two pages even with "Join split double pages" off; the detector\'s does not', () => {
  const marked = applyMarks([page(1), page(2), page(3), page(4)], [{ 3: 'join' }], 'rtl');
  assert.deepEqual(pairSlides(marked, false, { joinSplit: false }).slides, [[0], [1], [2, 3]]);
  assert.deepEqual(pairSlides([page(1), page(2, { join: 'rtl' }), page(3), page(4)], false, { joinSplit: false }).slides, [[0], [1], [2], [3]]);
});

test('a joined pair offers its way apart, from either half; a reader\'s own join offers to be taken apart', () => {
  assert.deepEqual(spreadOptions(flat, 1, undefined, true), [{ kind: 'split', first: 2 }]);
  assert.deepEqual(spreadOptions(flat, 2, undefined, true), [{ kind: 'split', first: 2 }]);
  const mine = applyMarks(flat, [{ 4: 'join' }], 'rtl');
  assert.deepEqual(spreadOptions(mine, 3, { 4: 'join' }, true), [{ kind: 'unmerge', first: 4 }]);
});

test('a lone page offers the merges that exist, named by the side of the screen, which a right-to-left track turns around', () => {
  // Left to right: the next page is on the right.
  assert.deepEqual(spreadOptions(flat, 3, undefined, false), [{ kind: 'merge', side: 'left', first: 3 }, { kind: 'merge', side: 'right', first: 4 }]);
  // Right to left: the next page is on the left, so merging with it is "left".
  assert.deepEqual(spreadOptions(flat, 3, undefined, true), [{ kind: 'merge', side: 'left', first: 4 }, { kind: 'merge', side: 'right', first: 3 }]);
  // The ends of a chapter have one neighbour.
  assert.deepEqual(spreadOptions(flat, 0, undefined, false), [{ kind: 'merge', side: 'right', first: 1 }]);
  assert.deepEqual(spreadOptions(flat, 4, undefined, false), [{ kind: 'merge', side: 'left', first: 4 }]);
});

test('a pair the reader split can be given back, and never across a chapter or onto a wide page', () => {
  const split = applyMarks(flat, [{ 2: 'split' }], 'rtl');
  assert.deepEqual(spreadOptions(split, 1, { 2: 'split' }, false)[0], { kind: 'restore', first: 2 });
  assert.deepEqual(spreadOptions(split, 2, { 2: 'split' }, false)[0], { kind: 'restore', first: 2 });
  const w = [page(1), page(2, { width: 1600 }), page(3)];
  assert.deepEqual(spreadOptions(w, 1, undefined, false), [], 'a wide page is a spread already');
  assert.deepEqual(spreadOptions(w, 0, undefined, false), [], 'and has no one to merge with');
  assert.deepEqual(spreadOptions([page(5), page(1, { ci: 1 })], 0, undefined, false), []);
});

test('what each option writes', () => {
  assert.equal(markFor({ kind: 'split', first: 2 }), 'split');
  assert.equal(markFor({ kind: 'merge', side: 'left', first: 2 }), 'join');
  assert.equal(markFor({ kind: 'unmerge', first: 2 }), null);
  assert.equal(markFor({ kind: 'restore', first: 2 }), null);
});

test('the reader loads a chapter\'s marks with its pages, applies them to the flow, and offers the options in the sheet', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const page = readFileSync(join(__dirname, '..', 'app/reader/page.tsx'), 'utf8');
  assert.match(page, /Promise\.all\(\[api<PageInfo\[\]>\(`\/api\/books\/\$\{bookId\}\/pages`\), loadMarks\(bookId\)\]\)/);
  assert.match(page, /const flat: FlatItem\[\] = useMemo\(\s*\(\) => applyMarks\(detected, chapters\.map\(\(c\) => c\.marks\), rtl \|\| pagedRtl \? 'rtl' : 'ltr'\)/);
  assert.match(page, /spreadOptions=\{optionsAt\(current\)\.map/);
});
