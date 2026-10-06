// "Show all chapters at once": the account's switch that puts a series' whole chapter list on one page, every
// ghost shown and every older-chapters run unfolded. Off unless the account says exactly `true`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openRuns, showAllChaptersOn } from '../lib/showAllChapters';
import { CHAPTER_PAGE, pageCount, pageSizeFor, pageSlice } from '../lib/chapterPages';
import { GHOST_CAP, mergeRows } from '../lib/chapterRows';
import type { Book, Ghost } from '../lib/types';

const book = (number: number): Book =>
  ({ id: `b${number}`, seriesId: 's', seriesTitle: 'S', name: `Chapter ${number}`, number, media: { pagesCount: 20 }, metadata: {} } as Book);
const ghost = (number: number, why: Ghost['why'] = 'missing'): Ghost =>
  ({ number, title: null, publishedAt: null, scanlator: null, groups: [], sourceId: 'src', sourceName: 'Src', why });

test('only an account that says true has it on', () => {
  assert.equal(showAllChaptersOn({ showAllChapters: true }), true);
  for (const s of [undefined, null, {}, { showAllChapters: 'true' }, { showAllChapters: 1 }, { showAllChapters: false }]) {
    assert.equal(showAllChaptersOn(s as any), false, JSON.stringify(s));
  }
});

test('on, the whole list is one page; off, a hundred at a time', () => {
  const rows = Array.from({ length: 1193 }, (_, i) => i);
  assert.equal(pageCount(rows.length, pageSizeFor(true, rows.length)), 1);
  assert.equal(pageSlice(rows, 0, pageSizeFor(true, rows.length)).length, 1193);
  assert.equal(pageSizeFor(false, rows.length), CHAPTER_PAGE);
  assert.equal(pageCount(rows.length, pageSizeFor(false, rows.length)), 12);
  // An empty list is still one (empty) page, never a NaN-sized slice.
  assert.equal(pageSizeFor(true, 0), 1);
  assert.deepEqual(pageSlice([], 0, pageSizeFor(true, 0)), []);
});

test('on, every run is open except the ones folded; off, only the ones opened', () => {
  const opened = new Set([5]);
  const folded = new Set([9]);
  const on = openRuns(true, opened, folded);
  assert.equal(on.has(1), true);
  assert.equal(on.has(9), false, 'a run folded while it is on stays folded');
  const off = openRuns(false, opened, folded);
  assert.equal(off.has(5), true);
  assert.equal(off.has(1), false);
});

test('on, mergeRows shows every ghost and unfolds the floor run', () => {
  const books = [book(200)];
  const missing = Array.from({ length: GHOST_CAP + 30 }, (_, i) => ghost(100 + i));
  const floor = Array.from({ length: 10 }, (_, i) => ghost(1 + i, 'floor'));
  const rows = mergeRows(books, [...missing, ...floor], true, true, openRuns(true, new Set(), new Set()));
  assert.equal(rows.filter((r) => r.kind === 'more').length, 0, 'no Show all row');
  assert.equal(rows.filter((r) => r.kind === 'ghost').length, missing.length + floor.length, 'every ghost, floor ones included');
  const run = rows.find((r) => r.kind === 'run');
  assert.ok(run && run.kind === 'run' && run.open, 'the run is open');
});

test('the series page reads the account switch and pages by its size', () => {
  const src = readFileSync(join(__dirname, '..', 'app/series/page.tsx'), 'utf8');
  assert.match(src, /showAllChaptersOn\(user\?\.settings\)/);
  assert.match(src, /pageSizeFor\(everything, rows\.length\)/);
  assert.match(src, /mergeRows\(filteredBooks, filteredGhosts, asc, showAll \|\| everything, runsOpen\)/);
  assert.doesNotMatch(src, /\/ CHAPTER_PAGE\)/, 'every turn-to-a-page divides by the page size in use');
  const settings = readFileSync(join(__dirname, '..', 'components/ProfileSettings.tsx'), 'utf8');
  assert.match(settings, /json: \{ showAllChapters: next \}/, 'saved to the account, not this device');
});
