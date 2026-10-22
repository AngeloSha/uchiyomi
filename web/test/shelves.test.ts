// Discover's rows inside the wall (v0.98.0, lib/shelves.ts): the picks after the wall's first row of covers (two until
// v0.99.0, when they became their own band and moved up a row), each trending row four rows further on, a row the wall has not reached yet waiting after it, and a row that comes late
// placed below what is on screen -- so nothing on screen moves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EVERY_ROWS, FIRST_ROWS, placeAt, placeRows, weave } from '../lib/shelves';

const ROWS = ['foryou', 'KR', 'JP', 'CN'] as const;
type Row = (typeof ROWS)[number];
const fresh = (rows: readonly Row[] = ROWS, shown = 0, cols = 3) => placeRows(new Map<Row, number>(), rows, shown, cols);

test('the first row sits after one row of covers, and each next one four rows further on', () => {
  // v0.99.0: the picks band right after the first row. Reintroduce two: the owner's "hiding inside" scrolls a row deeper.
  assert.equal(FIRST_ROWS, 1);
  assert.equal(EVERY_ROWS, 4);
  assert.deepEqual([0, 1, 2, 3].map((j) => placeAt(j, 3)), [3, 15, 27, 39]);
  // A phone: three across. Sixty cards reach all four places.
  const { parts, after } = weave(60, 3, fresh());
  assert.deepEqual(parts, [
    { kind: 'cards', from: 0, to: 3 }, { kind: 'row', key: 'foryou' },
    { kind: 'cards', from: 3, to: 15 }, { kind: 'row', key: 'KR' },
    { kind: 'cards', from: 15, to: 27 }, { kind: 'row', key: 'JP' },
    { kind: 'cards', from: 27, to: 39 }, { kind: 'row', key: 'CN' },
    { kind: 'cards', from: 39, to: 60 },
  ]);
  assert.deepEqual(after, []);
  // A computer: eight across, so the first row comes after eight.
  assert.deepEqual(weave(100, 8, fresh(ROWS, 0, 8)).parts.slice(0, 2), [{ kind: 'cards', from: 0, to: 8 }, { kind: 'row', key: 'foryou' }]);
});

test('a row waits until the wall has filled to its place, and the rows after it wait with it, in order', () => {
  // Reintroduce a row placed before the wall reaches it: the picks land among the first covers, or at the top of an empty
  // wall, and every card after it moves when the next source lands.
  assert.deepEqual(weave(2, 3, fresh()), { parts: [{ kind: 'cards', from: 0, to: 2 }], after: ['foryou', 'KR', 'JP', 'CN'] });
  assert.deepEqual(weave(0, 3, fresh()), { parts: [{ kind: 'cards', from: 0, to: 0 }], after: ['foryou', 'KR', 'JP', 'CN'] });
  // Filled exactly to the place: the row is there, the cards that come later go after it.
  assert.deepEqual(weave(3, 3, fresh()), {
    parts: [{ kind: 'cards', from: 0, to: 3 }, { kind: 'row', key: 'foryou' }, { kind: 'cards', from: 3, to: 3 }],
    after: ['KR', 'JP', 'CN'],
  });
  const twenty = weave(20, 3, fresh());
  assert.deepEqual(twenty.parts.filter((p) => p.kind === 'row').map((p) => (p as { key: string }).key), ['foryou', 'KR']);
  assert.deepEqual(twenty.after, ['JP', 'CN']);
});

test('a row keeps its place, and a row that comes late takes a place below what is on screen', () => {
  // The trending rows answered first; forty covers are on screen when the picks come.
  const early = fresh(['KR', 'JP', 'CN'], 0);
  assert.deepEqual([...early], [['KR', 0], ['JP', 1], ['CN', 2]]);
  // With 40 covers shown, place 3 (after 39) is in front of them, so place 4 (after 51) is the first free place at or past
  // them. Reintroduce the first free place whatever is shown: the picks land at 3, among the covers on screen.
  const late = placeRows(early, ['foryou', 'KR', 'JP', 'CN'], 40, 3);
  assert.equal(late.get('foryou'), 4, 'a late row lands among the covers on screen');
  assert.equal(late.get('KR'), 0, 'a placed row moved');
  // With nothing held, a late row still never lands in front of what is shown: 50 shown, place 4 (51).
  assert.equal(placeRows(new Map<Row, number>(), ['foryou'], 50, 3).get('foryou'), 4);
  // A row that goes (every card added) gives its place back; the others keep theirs.
  const gone = placeRows(late, ['foryou', 'JP', 'CN'], 60, 3);
  assert.deepEqual([...gone].sort(), [['CN', 2], ['JP', 1], ['foryou', 4]]);
  // The wall laid out by those places: the picks after 51 covers, below the three trending rows.
  const rows = weave(60, 3, late).parts.filter((p) => p.kind === 'row').map((p) => (p as { key: string }).key);
  assert.deepEqual(rows, ['KR', 'JP', 'CN', 'foryou']);
});

test('a wall not measured yet places nothing new, and a turned phone keeps every row after the same rows of covers', () => {
  // Reintroduce `Math.max(1, cols)`: the picks are placed by a wall one card across.
  for (const cols of [0, NaN, -1, 0.5]) assert.deepEqual([...fresh(ROWS, 0, cols)], [], `cols ${cols}`);
  // Places are rows of covers, not counts: three across or seven, the picks follow the first row.
  const p = fresh();
  assert.deepEqual(weave(100, 7, p).parts.slice(0, 2), [{ kind: 'cards', from: 0, to: 7 }, { kind: 'row', key: 'foryou' }]);
  // Unmeasured, a placed row waits after the wall rather than land anywhere.
  assert.deepEqual(weave(40, 0, p).after, ['foryou', 'KR', 'JP', 'CN']);
});

test('the wall always starts and ends with its cards, and only the rows placed are drawn', () => {
  for (const [count, cols] of [[0, 3], [7, 3], [61, 7], [500, 10]] as const) {
    const { parts } = weave(count, cols, fresh(['KR', 'CN'], 0, cols));
    assert.equal(parts[0].kind, 'cards');
    assert.equal(parts[parts.length - 1].kind, 'cards');
    const runs = parts.filter((x) => x.kind === 'cards') as { from: number; to: number }[];
    assert.equal(runs[0].from, 0);
    for (let i = 1; i < runs.length; i++) assert.equal(runs[i].from, runs[i - 1].to);
    assert.equal(runs[runs.length - 1].to, count);
  }
  // No rows: one run, the whole wall -- a search.
  assert.deepEqual(weave(30, 3, new Map()), { parts: [{ kind: 'cards', from: 0, to: 30 }], after: [] });
});
