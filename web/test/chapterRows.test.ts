// The chapter list's merge of on-disk chapters and the sources' ghosts, tested away from React.
//
// Each rule here is one a person will see on the series page: a ghost in the wrong place reads as a chapter
// out of order, a floor that does not collapse buries the readable chapters under a hundred grey rows, and
// a ghost that doubles a real chapter says "Ch. 12" twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FETCH_CHUNK, GHOST_CAP, chaptersLeft, chunkNumbers, mergeRows, openableChapters, runLabel, whyLabel, type Row } from '../lib/chapterRows';
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
  assert.deepEqual(runs[0], { kind: 'run', why: 'floor', from: 1, to: 175, count: 175, open: false });
  assert.equal(rows[0].kind, 'run', 'the run sits where the numbers are: before the first chapter');
  assert.equal(rows.length, 26, 'a run row plus the 25 chapters');
  // Descending, the run row goes to the end, since those numbers are the lowest.
  const desc = mergeRows(books, floor, false, false);
  assert.equal(desc[desc.length - 1].kind, 'run');
  // A floor stretch split by a chapter on disk is two runs: the sentence "Ch. 1–175" would be a lie
  // about a chapter in the middle of it that is there.
  const split = mergeRows([book(50), ...books], floor.filter((g) => g.number !== 50), true, false);
  assert.deepEqual(numbersOf(split).slice(0, 3), ['run1-49', 'b50', 'run51-175']);
  // A floor ghost never gets a caption of its own: the run row's sentence is its reason.
  assert.equal(whyLabel({ why: 'floor' }), null);
  assert.deepEqual(whyLabel({ why: 'failed', attempts: 3 }), { key: 'failed {n} times', args: { n: 3 } });
  assert.deepEqual(whyLabel({ why: 'blocked' }), { key: 'only a blocked group has it', args: {} });
  assert.deepEqual(whyLabel({ why: 'missing' }), { key: 'not here yet', args: {} });
});

test('a held chapter names the group it waits for and the days left, when the server says', () => {
  // Reintroduce by returning the named key without the `waitingFor` test: "an older server" fails with
  // args { g: undefined, n: undefined } -- which rendered as "waiting for  · undefined days left".
  assert.deepEqual(whyLabel({ why: 'held', waitingFor: 'Asura Scans', waitDaysLeft: 2 }),
    { key: 'waiting for {g} · {n} days left', args: { g: 'Asura Scans', n: 2 } });
  assert.deepEqual(whyLabel({ why: 'held' }), { key: 'waiting for a preferred group', args: {} }, 'an older server');
  // Every preferred group blocked: the server sends no name, and the caption must not invent one.
  assert.deepEqual(whyLabel({ why: 'held', waitDaysLeft: 2 }), { key: 'waiting for a preferred group', args: {} });
  // Zero days left is still a number, not "absent".
  assert.deepEqual(whyLabel({ why: 'held', waitingFor: 'Asura Scans', waitDaysLeft: 0 })!.args, { g: 'Asura Scans', n: 0 });
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
  // 'Ch. {a}–{b} · {n} older chapters not here yet' and args {a: 5, b: 5, n: 1} -- which rendered as
  // "Ch. 5–5 · 1 older chapters not here yet".
  const one = mergeRows([book(6)], [ghost(5, 'floor')], true, false);
  assert.equal(one[0].kind, 'run');
  const single = runLabel(one[0] as Extract<Row, { kind: 'run' }>);
  assert.equal(single.key, 'Ch. {n} · 1 older chapter not here yet', 'singular');
  assert.deepEqual(single.args, { n: 5 });
  const many = mergeRows([book(6)], [ghost(3, 'floor'), ghost(4, 'floor'), ghost(5, 'floor')], true, false);
  const range = runLabel(many[0] as Extract<Row, { kind: 'run' }>);
  assert.equal(range.key, 'Ch. {a}–{b} · {n} older chapters not here yet', 'range');
  assert.deepEqual(range.args, { a: 3, b: 5, n: 3 });
});

test('an expanded run emits its ghosts as rows and folds past the cap', () => {
  // A "Latest 6" series that is 295 chapters behind, the reader taps Show on the run. Reintroduce by
  // dropping the `expandedRuns.has(r.from)` line in mergeRows: "the run is open" fails, and so does
  // "fifty ghost rows" with 0. Reintroduce the fold by concatenating the run's ghosts AFTER the cap is
  // applied: "the fold counts the run's ghosts" fails with no `more` row.
  const books = [book(302), book(303)];
  const floor = Array.from({ length: 295 }, (_, i) => ghost(7 + i, 'floor'));
  const closed = mergeRows(books, floor, true, false);
  assert.deepEqual(numbersOf(closed), ['run7-301', 'b302', 'b303'], 'a run not in the set stays one line');
  assert.equal((closed[0] as Extract<Row, { kind: 'run' }>).open, false);

  const rows = mergeRows(books, floor, true, false, new Set([7]));
  const run = rows[0] as Extract<Row, { kind: 'run' }>;
  assert.equal(run.kind, 'run');
  assert.equal(run.open, true, 'the run is open');
  assert.deepEqual({ from: run.from, to: run.to, count: run.count }, { from: 7, to: 301, count: 295 }, 'the sentence still names the whole stretch');
  const shown = rows.filter((r) => r.kind === 'ghost').map((r) => (r as Extract<Row, { kind: 'ghost' }>).ghost.number);
  assert.equal(shown.length, GHOST_CAP, 'fifty ghost rows');
  assert.deepEqual(shown, Array.from({ length: 50 }, (_, i) => 252 + i), 'the newest of the older ones, in list order, right under the run row');
  assert.equal(rows[1].kind, 'ghost', 'the ghosts follow their run row');
  const more = rows[rows.length - 1];
  assert.deepEqual(more, { kind: 'more', hidden: 245 }, 'the fold counts the run\'s ghosts');
  assert.deepEqual(numbersOf(rows).slice(-3), ['b302', 'b303', 'more245']);

  // Descending: the run row still HEADS its ghosts (a heading under its own rows is a footer), the
  // ghosts inside it are newest first, and the whole block sits at the end where the low numbers are.
  const desc = mergeRows(books, floor, false, false, new Set([7]));
  assert.deepEqual(numbersOf(desc).slice(0, 3), ['b303', 'b302', 'run7-301']);
  const descShown = desc.filter((r) => r.kind === 'ghost').map((r) => (r as Extract<Row, { kind: 'ghost' }>).ghost.number);
  assert.equal(descShown[0], 301);
  assert.equal(descShown[49], 252);
  assert.equal(desc[desc.length - 1].kind, 'more');

  // Show all: every ghost of the run, no fold.
  const all = mergeRows(books, floor, true, true, new Set([7]));
  assert.equal(all.filter((r) => r.kind === 'ghost').length, 295);
  assert.equal(all.some((r) => r.kind === 'more'), false);

  // A 0-chapter series ("Nothing yet"): the run is the only content and its key is its lowest number.
  const nothing = mergeRows([], Array.from({ length: 8 }, (_, i) => ghost(1 + i, 'floor')), true, false, new Set([1]));
  assert.deepEqual(numbersOf(nothing), ['run1-8', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8']);

  // Two runs split by a chapter: opening one leaves the other folded.
  const two = mergeRows([book(50), book(302)], floor.filter((g) => g.number !== 50), true, true, new Set([51]));
  assert.deepEqual(numbersOf(two).slice(0, 3), ['run7-49', 'b50', 'run51-301']);
  assert.equal(numbersOf(two)[3], 'g51');
  assert.equal(two.filter((r) => r.kind === 'ghost').length, 301 - 51 + 1);
});

test('a Fetch all past the route cap is several requests of at most the cap, in order, none empty', () => {
  // The route refuses more than FILL_MAX_CHAPTERS numbers with a 400, so a 700-number run must be three
  // requests -- 300, 300, 100 -- and never a fourth empty one. Reintroduce by slicing with `size + 1` (a
  // chunk of 301): "at most the cap" fails; or by pushing `numbers.slice(i)` (everything from i on):
  // "in order, none repeated" fails.
  const run = Array.from({ length: 700 }, (_, i) => i + 1);
  const chunks = chunkNumbers(run);
  assert.equal(FETCH_CHUNK, 300, 'the cap is the route\'s FILL_MAX_CHAPTERS');
  assert.deepEqual(chunks.map((c) => c.length), [300, 300, 100], 'at most the cap');
  assert.deepEqual(chunks.flat(), run, 'in order, none repeated');
  assert.deepEqual(chunkNumbers([1, 2, 3]), [[1, 2, 3]], 'a short run is one request');
  assert.deepEqual(chunkNumbers([]), [], 'nothing to fetch is no request');
  assert.deepEqual(chunkNumbers([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]], 'the cut is the size given');
});

test('the downloads pill counts the chapters still to come, not the size of every job', () => {
  // Reintroduce by summing `j.total` instead of `total - done`: "a job at 290/300 has 10 to come" fails
  // with 300. Or by dropping the `|| jobs.length` fallback: "a job that has not sized itself yet counts as
  // one" fails with 0.
  assert.equal(chaptersLeft([{ total: 300, done: 290 }]), 10, 'a job at 290/300 has 10 to come');
  assert.equal(chaptersLeft([{ total: 300, done: 290 }, { total: 12, done: 0 }]), 22, 'summed across jobs');
  assert.equal(chaptersLeft([{ total: 0, done: 0 }]), 1, 'a job that has not sized itself yet counts as one');
  assert.equal(chaptersLeft([{ total: 5, done: 5 }, { total: 0, done: 0 }]), 2, 'and so does a job on its last chapter');
  assert.equal(chaptersLeft([{ total: 5, done: 7 }]), 1, 'never negative');
});
