// The chapter list's merge of on-disk chapters and the sources' ghosts, tested away from React.
//
// Each rule here is one a person will see on the series page: a ghost in the wrong place reads as a chapter
// out of order, a floor that does not collapse buries the readable chapters under a hundred grey rows, and
// a ghost that doubles a real chapter says "Ch. 12" twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GHOST_CAP, mergeRows, openableChapters, runLabel, whyLabel, type Row } from '../lib/chapterRows';
import type { Book, Ghost } from '../lib/types';

const book = (number: number, over: Partial<Book> = {}): Book =>
  ({ id: `b${number}`, seriesId: 's', seriesTitle: 'S', name: `Chapter ${number}`, number,
     media: { pagesCount: 20 }, metadata: {}, ...over } as Book);
const ghost = (number: number, why: Ghost['why'] = 'missing', over: Partial<Ghost> = {}): Ghost =>
  ({ number, title: null, publishedAt: null, scanlator: null, groups: [], sourceId: 'src', sourceName: 'Src', why, ...over });

const numbersOf = (rows: Row[]) => rows.map((r) =>
  r.kind === 'book' ? `b${r.book.number}` : r.kind === 'ghost' ? `g${r.ghost.number}` : r.kind === 'run' ? `run${r.from}-${r.to}` : `more${r.hidden}`);

test('ghosts interleave with chapters by number and follow the sort', () => {
  // Reintroduce by dropping the `entries.sort` line in mergeRows: the ascending list reads b1,b3,b5,g2,g4
  // and "ascending" fails below; dropping the `rows.reverse()` fails "descending" instead.
  const books = [book(1), book(3), book(5)];
  const ghosts = [ghost(4, 'held'), ghost(2)];
  assert.deepEqual(numbersOf(mergeRows(books, ghosts, true, false)), ['b1', 'g2', 'b3', 'g4', 'b5'], 'ascending');
  assert.deepEqual(numbersOf(mergeRows(books, ghosts, false, false)), ['b5', 'g4', 'b3', 'g2', 'b1'], 'descending');
  // A ghost past the end sits past the end, in both directions.
  assert.deepEqual(numbersOf(mergeRows(books, [ghost(6)], true, false)), ['b1', 'b3', 'b5', 'g6']);
  assert.deepEqual(numbersOf(mergeRows(books, [ghost(6)], false, false)), ['g6', 'b5', 'b3', 'b1']);
});

test('floor ghosts collapse into one run row', () => {
  // A "Latest 25 of 200" series: 175 numbers below the floor. Reintroduce by removing the `last.kind ===
  // 'run'` branch in mergeRows (push a run per floor ghost): "one run row" fails with 175 rows.
  const books = Array.from({ length: 25 }, (_, i) => book(176 + i));
  const floor = Array.from({ length: 175 }, (_, i) => ghost(1 + i, 'floor'));
  const rows = mergeRows(books, floor, true, false);
  const runs = rows.filter((r) => r.kind === 'run');
  assert.equal(runs.length, 1, 'one run row');
  assert.deepEqual(runs[0], { kind: 'run', why: 'floor', from: 1, to: 175, count: 175 });
  assert.equal(rows[0].kind, 'run', 'the run sits where the numbers are: before the first chapter');
  assert.equal(rows.length, 26, 'a run row plus the 25 chapters');
  // Descending, the run row goes to the end, since those numbers are the lowest.
  const desc = mergeRows(books, floor, false, false);
  assert.equal(desc[desc.length - 1].kind, 'run');
  // A floor stretch split by a chapter on disk is two runs: the sentence "Ch. 1–175" would be a lie
  // about a chapter in the middle of it that is there.
  const split = mergeRows([book(50), ...books], floor.filter((g) => g.number !== 50), true, false);
  assert.deepEqual(numbersOf(split).slice(0, 3), ['run1-49', 'b50', 'run51-175']);
  // A floor ghost never becomes a pill: the run row's sentence is its reason.
  assert.equal(whyLabel({ why: 'floor' }), null);
  assert.equal(whyLabel({ why: 'failed' }), 'Failed {n} times');
  assert.equal(whyLabel({ why: 'held' }), 'Waiting for a preferred group');
  assert.equal(whyLabel({ why: 'blocked' }), 'Only blocked groups released it');
  assert.equal(whyLabel({ why: 'missing' }), 'Not downloaded yet');
});

test('a tombstone is a chapter row, never a ghost', () => {
  // The server's rule is "no lib_books row"; a pruned chapter still has one, and a listing written before
  // a download landed could name a number that is now on disk. Reintroduce by dropping the `!have.has`
  // filter in mergeRows: "the number on disk is not doubled" fails with a g12 beside b12.
  const books = [book(11), book(12, { pruned: true }), book(13)];
  const ghosts = [ghost(12, 'missing'), ghost(12, 'floor'), ghost(14)];
  const rows = mergeRows(books, ghosts, true, false);
  assert.deepEqual(numbersOf(rows), ['b11', 'b12', 'b13', 'g14'], 'the number on disk is not doubled');
  assert.equal(rows.filter((r) => r.kind === 'run').length, 0, 'a floor ghost on an on-disk number is dropped too');
});

test('more than fifty ghosts fold behind a Show all row', () => {
  // Reintroduce by changing `rest.length > GHOST_CAP` to `rest.length > Infinity` (never cap): "fifty ghost
  // rows" fails with 120. Changing the ranking to keep the LOWEST numbers fails "the nearest to the top".
  const books = [book(100), book(101)];
  const ghosts = Array.from({ length: 120 }, (_, i) => ghost(i < 100 ? i : 102 + (i - 100)));  // 0..99 and 102..121
  const rows = mergeRows(books, ghosts, true, false);
  const shown = rows.filter((r) => r.kind === 'ghost').map((r) => (r as any).ghost.number as number);
  assert.equal(shown.length, GHOST_CAP, 'fifty ghost rows');
  assert.equal(GHOST_CAP, 50);
  const more = rows[rows.length - 1];
  assert.deepEqual(more, { kind: 'more', hidden: 70 }, 'the fold is the last row and counts what it hides');
  // The 50 kept are the nearest to 101: every one of 102..121 (20) and the 30 just below 100.
  assert.ok(shown.every((n) => n >= 70), `the nearest to the top are kept, got ${Math.min(...shown)}`);
  assert.ok(shown.includes(121) && shown.includes(70));
  assert.deepEqual([...shown].sort((a, b) => a - b), shown, 'the kept ghosts are still in list order');
  // Show all: everything, and no fold row.
  const all = mergeRows(books, ghosts, true, true);
  assert.equal(all.filter((r) => r.kind === 'ghost').length, 120);
  assert.equal(all.some((r) => r.kind === 'more'), false);
  // Exactly the cap does not fold: a "Show all 0" row would be a button that does nothing.
  const exact = mergeRows(books, ghosts.slice(0, 50), true, false);
  assert.equal(exact.some((r) => r.kind === 'more'), false);
  // Floor ghosts do not count against the cap: they are one row however many there are.
  const floored = mergeRows(books, [...ghosts.slice(0, 40), ...Array.from({ length: 300 }, (_, i) => ghost(-1 - i, 'floor'))], true, false);
  assert.equal(floored.some((r) => r.kind === 'more'), false);
  assert.equal(floored.filter((r) => r.kind === 'run').length, 1);
});

test('the reader steps over a deleted chapter unless this device still holds it', () => {
  // Reintroduce by returning `books` unchanged from openableChapters: "the tombstone is not a stop" fails.
  const books = [book(1), book(2, { pruned: true }), book(3, { pruned: true }), book(4)];
  assert.deepEqual(openableChapters(books, new Set()).map((b) => b.number), [1, 4], 'the tombstone is not a stop');
  assert.deepEqual(openableChapters(books, new Set(['b3'])).map((b) => b.number), [1, 3, 4], 'the saved copy is the last one and stays');
});

test('a run of one floor ghost is one chapter, not a range of one and a plural', () => {
  // Reintroduce by returning the range key for every count in runLabel: "singular" fails with
  // 'Ch. {a}–{b}: {n} older chapters left…' and args {a: 5, b: 5, n: 1} -- which rendered as
  // "Ch. 5–5: 1 older chapters left".
  const one = mergeRows([book(6)], [ghost(5, 'floor')], true, false);
  assert.equal(one[0].kind, 'run');
  const single = runLabel(one[0] as Extract<Row, { kind: 'run' }>);
  assert.equal(single.key, 'Ch. {n}: 1 older chapter left to Find missing chapters', 'singular');
  assert.deepEqual(single.args, { n: 5 });
  const many = mergeRows([book(6)], [ghost(3, 'floor'), ghost(4, 'floor'), ghost(5, 'floor')], true, false);
  const range = runLabel(many[0] as Extract<Row, { kind: 'run' }>);
  assert.equal(range.key, 'Ch. {a}–{b}: {n} older chapters left to Find missing chapters', 'range');
  assert.deepEqual(range.args, { a: 3, b: 5, n: 3 });
});
