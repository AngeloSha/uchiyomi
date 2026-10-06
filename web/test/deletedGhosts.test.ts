// "Show deleted chapters as ghosts" (the admin's switch, Listing.deletedAsGhosts): a chapter deleted on purpose is
// drawn as a ghost row. Which tombstones count, what the row carries, and that the rows never fold behind "Show all".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GHOST_CAP, countsAsBehind, deliberatelyDeleted, ghostOfDeleted, mergeRows, whyLabel } from '../lib/chapterRows';
import type { Book, Ghost } from '../lib/types';

const book = (number: number, over: Partial<Book> = {}): Book =>
  ({ id: `b${number}`, seriesId: 's', seriesTitle: 'S', name: `Chapter ${number}`, number, media: { pagesCount: 20 }, metadata: {}, ...over } as Book);
const ghost = (number: number): Ghost =>
  ({ number, title: null, publishedAt: null, scanlator: null, groups: [], sourceId: 'src', sourceName: 'Src', why: 'missing' });

test('deleted on purpose: the cleanup, Remove chapters, Delete files -- not a missing file, nor a hand-built library\'s', () => {
  // The server's rule (bff lib/deletedGhosts.ts). Reintroduce "every tombstone": Verify's missing files read as deleted.
  assert.equal(deliberatelyDeleted(book(1)), false, 'a chapter with its file');
  assert.equal(deliberatelyDeleted(book(1, { pruned: true, prunedReason: null, owned: true })), true, 'the cleanup / Remove chapters');
  assert.equal(deliberatelyDeleted(book(1, { pruned: true, prunedReason: 'deleted', owned: true })), true, 'Delete files');
  assert.equal(deliberatelyDeleted(book(1, { pruned: true, prunedReason: 'missing', owned: true })), false, 'Verify found it missing');
  assert.equal(deliberatelyDeleted(book(1, { pruned: true, prunedReason: 'deleted', owned: false })), false, 'File no longer on disk');
});

test('the ghost carries the chapter\'s name, group, date and the reader\'s tick, and says "deleted"', () => {
  const g = ghostOfDeleted(book(7, { pruned: true, chapterName: 'The Return', scanlator: 'Group A', sourceId: 'mangadex',
    metadata: { releaseDate: '2026-01-02T00:00:00Z' } as any, readProgress: { completed: true } as any }));
  assert.deepEqual(g, { number: 7, title: 'The Return', publishedAt: '2026-01-02T00:00:00Z', scanlator: 'Group A', groups: ['Group A'],
    sourceId: 'mangadex', sourceName: '', why: 'deleted', read: true });
  assert.equal(ghostOfDeleted(book(8, { pruned: true })).read, undefined, 'unread has no tick');
  assert.deepEqual(whyLabel(g), { key: 'deleted', args: {} });
  assert.equal(countsAsBehind(g), false, 'a deleted chapter is not one the sweep is behind on');
});

test('deleted ghosts are rows before the switch and stay rows: never folded behind Show all', () => {
  // Reintroduce by letting the cap rank them with the rest: a library that pruned what it read loses those rows.
  const deleted = Array.from({ length: GHOST_CAP + 10 }, (_, i) => ghostOfDeleted(book(1 + i, { pruned: true })));
  const missing = Array.from({ length: GHOST_CAP + 5 }, (_, i) => ghost(500 + i));
  const rows = mergeRows([book(1000)], [...deleted, ...missing], true, false);
  const shown = rows.filter((r) => r.kind === 'ghost').map((r) => (r as any).ghost as Ghost);
  assert.equal(shown.filter((g) => g.why === 'deleted').length, deleted.length, 'every deleted chapter is shown');
  assert.equal(shown.filter((g) => g.why === 'missing').length, GHOST_CAP, 'the cap still applies to the rest');
  assert.deepEqual(rows.filter((r) => r.kind === 'more'), [{ kind: 'more', hidden: 5 }]);
});

test('the series page turns them into ghost rows only under the switch, and keeps a copy saved on this device a chapter', () => {
  const src = readFileSync(join(__dirname, '..', 'app/series/page.tsx'), 'utf8');
  assert.match(src, /listing\?\.deletedAsGhosts === true && deliberatelyDeleted\(b\) && !downloaded\.has\(b\.id\)/);
  assert.match(src, /allBooks\.filter\(asGhost\)\.map\(ghostOfDeleted\)/);
  assert.match(src, /group === ALL_GROUPS \? rowBooks : rowBooks\.filter/, 'the deleted chapters are still drawn as chapter rows');
});
