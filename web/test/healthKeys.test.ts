// Stable keys for Health rows (v0.49.0, lib/healthKeys.ts).
//
// The rows were keyed by index, and a row now holds state: a Fix's clock, a Test's verdict, what the last press
// did. When a re-check removed the row above, React moved that state onto the next row down -- the result of
// one chapter's Fix landed on another chapter. Keys made of what a finding is ABOUT follow the finding.
import test from 'node:test';
import assert from 'node:assert/strict';
import { itemKey, keysFor } from '../lib/healthKeys';
import type { HealthItem } from '../lib/types';

// One item shaped like each of the twelve checks' findings.
const FIXTURES: Array<[string, HealthItem]> = [
  ['chapter-gaps', { title: 'Walk Gap', detail: '3 missing', seriesId: 'g1', numbers: [6, 7, 8], key: 'series:g1' }],
  ['short-chapters', { title: 'Walk Tale', detail: 'Chapter 3 has 2 pages', seriesId: 't1', bookId: 'b3' }],
  ['short-chapters', { title: 'Walk Tale', detail: 'Chapter 4 has 2 pages', seriesId: 't1', bookId: 'b4' }],
  ['chapter-failures', { title: 'fake-a', detail: '3 chapters', sourceId: 'fake-a' }],
  ['frozen-series', { title: 'Old', detail: 'no source', seriesId: 'o1', key: 'series:o1' }],
  ['sources', { title: 'fake-b', detail: 'blocked', sourceId: 'fake-b', key: 'source:fake-b' }],
  ['duplicates', { title: 'A / B', detail: 'same AniList id', seriesIds: ['z', 'a'], titles: ['A', 'B'], key: 'anilist:1' }],
  ['outliers', { title: 'Walk Tale', detail: 'Chapter 9000', seriesId: 't1', bookIds: ['b9000', 'b8000'] }],
  ['solver', { title: 'http://solver:8191', detail: 'not answering' }],
  ['update', { title: 'v0.49.0', detail: 'newer', info: true }],
  ['extension-cap', { title: 'Source limit', detail: '3 not registered' }],
  ['library-scan', { title: '/library/bad', detail: 'cannot index', key: 'folder:/library/bad' }],
];

test('every kind of finding gets a key from what it is about, the server\'s own key first', () => {
  // Reintroduce `return String(index)`-style keys: "a key that stays with its finding" below fails.
  assert.equal(itemKey('sources', FIXTURES[5][1]), 'source:fake-b', 'the server\'s key was not preferred');
  assert.equal(itemKey('short-chapters', FIXTURES[1][1]), 'book:b3');
  assert.equal(itemKey('outliers', FIXTURES[7][1]), 'books:b8000,b9000', 'several chapters are keyed in a stable order');
  assert.equal(itemKey('duplicates', { ...FIXTURES[6][1], key: undefined }), 'pair:a,z');
  assert.equal(itemKey('chapter-failures', FIXTURES[3][1]), 'source:fake-a');
  assert.equal(itemKey('solver', FIXTURES[8][1]), 'title:solver:http://solver:8191');
  const all = FIXTURES.map(([c, it]) => `${c}|${itemKey(c, it)}`);
  assert.equal(new Set(all).size, all.length, 'two different findings share a key');
});

test('a key stays with its finding when the rows above it go or move', () => {
  // The Fix on chapter 3 replaced it, the re-check dropped its row, and chapter 4's row must keep ITS key --
  // with index keys it inherited chapter 3's and, with it, chapter 3's "Replaced with a longer copy".
  const items = FIXTURES.filter(([c]) => c === 'short-chapters').map(([, it]) => it);
  const before = keysFor('short-chapters', items);
  const after = keysFor('short-chapters', items.slice(1));
  assert.equal(after[0], before[1], 'chapter 4 took chapter 3\'s key');
  const reversed = keysFor('short-chapters', [...items].reverse());
  assert.deepEqual([...reversed].reverse(), before, 'reordering changed the keys');
});

test('two findings with one identity are told apart, and the first keeps its own key', () => {
  const twin: HealthItem = { title: 'fake-a', detail: 'again', sourceId: 'fake-a' };
  assert.deepEqual(keysFor('chapter-failures', [FIXTURES[3][1], twin, twin]), ['source:fake-a', 'source:fake-a#2', 'source:fake-a#3']);
});
