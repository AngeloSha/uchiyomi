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

test('deleted on purpose: the cleanup, Remove chapters, Delete files -- not either kind of missing file', () => {
  // The server's rule (bff lib/deletedGhosts.ts). Provenance, not ownership, is what makes a deletion deliberate:
  // an older hand-built row may be deliberately deleted too, while Rescan's absence has its own reason now.
  assert.equal(deliberatelyDeleted(book(1)), false, 'a chapter with its file');
  assert.equal(deliberatelyDeleted(book(1, { pruned: true, prunedReason: null, owned: true })), true, 'the cleanup / Remove chapters');
  assert.equal(deliberatelyDeleted(book(1, { pruned: true, prunedReason: 'deleted', owned: true })), true, 'Delete files');
  assert.equal(deliberatelyDeleted(book(1, { pruned: true, prunedReason: 'missing', owned: true })), false, 'Verify found it missing');
  assert.equal(deliberatelyDeleted(book(1, { pruned: true, prunedReason: 'rescan_missing', owned: false })), false, 'Rescan found it absent');
  assert.equal(deliberatelyDeleted(book(1, { pruned: true, prunedReason: 'deleted', owned: false })), true, 'a deliberate deletion does not lose its provenance when unowned');
});

test('the ghost carries stable identity, range, name, group, date and the reader\'s tick', () => {
  const g = ghostOfDeleted(book(7, { id: 'book-range-7', numberEnd: 9, pruned: true, chapterName: 'The Return', scanlator: 'Group A', sourceId: 'mangadex',
    metadata: { releaseDate: '2026-01-02T00:00:00Z' } as any, readProgress: { completed: true } as any }));
  assert.deepEqual(g, { bookId: 'book-range-7', number: 7, numberEnd: 9, title: 'The Return', publishedAt: '2026-01-02T00:00:00Z',
    scanlator: 'Group A', groups: ['Group A'], sourceId: 'mangadex', sourceName: '', why: 'deleted', deleted: true, read: true });
  assert.equal(ghostOfDeleted(book(8, { pruned: true })).read, undefined, 'unread has no tick');
  assert.deepEqual(whyLabel(g), { key: 'deleted', args: {} });
  assert.equal(countsAsBehind(g), false, 'a deleted chapter is not one the sweep is behind on');
});

test('two deliberate tombstones on the same number remain two rows with their own IDs and progress', () => {
  // Number is presentation; bookId is identity. Collapsing these by number makes one of two language/group copies
  // impossible to select, mark or restore, and a range must not lose its end while taking the ghost treatment.
  const first = ghostOfDeleted(book(12, { id: 'copy-a', numberEnd: 14, pruned: true, readProgress: { page: 5, completed: false } as any }));
  const second = ghostOfDeleted(book(12, { id: 'copy-b', pruned: true, readProgress: { page: 20, completed: true } as any }));
  const rows = mergeRows([], [first, second], true, false).filter((r) => r.kind === 'ghost');
  assert.deepEqual(rows.map((r) => r.ghost.bookId), ['copy-a', 'copy-b']);
  assert.deepEqual(rows.map((r) => r.ghost.numberEnd), [14, null]);
  assert.deepEqual(rows.map((r) => r.ghost.read), [undefined, true]);
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
  assert.match(src, /ghosts\.length > 0 \|\| deletedGhosts\.length > 0/, 'deleted-only series still expose the ghost control');
});

test('the series page keys, marks and restores deliberate tombstones by book ID, never by chapter number', () => {
  const src = readFileSync(join(__dirname, '..', 'app/series/page.tsx'), 'utf8');
  assert.match(src, /const ghostKey = \(g: Ghost\) => g\.bookId \? `book:\$\{g\.bookId\}` : `number:\$\{g\.number\}`/,
    'duplicate chapter numbers do not have stable independent selection keys');
  assert.match(src, /<GhostRow key=\{`g:\$\{r\.ghost\.bookId \?\? r\.ghost\.number\}`\}/,
    'React folds duplicate-number tombstones onto the same row');
  assert.match(src, /chapterLabel\(\{ number: ghost\.number, numberEnd: ghost\.numberEnd \}\)/,
    'a deleted range is presented as only its first chapter');

  assert.match(src, /const book = allBooks\.find\(\(b\) => b\.id === ghost\.bookId\);[\s\S]{0,160}await setRead\(\[book\], completed\)/,
    'marking a tombstone writes number-based listing progress instead of its original book progress');
  assert.match(src, /const fetchDeleted = \(bookId: string\) => startJob\(`\/api\/books\/\$\{bookId\}\/refetch`, \{\}\)/,
    'the member restore route is not addressed by the original book ID');
  assert.match(src, /r\.ghost\.bookId \? fetchDeleted\(r\.ghost\.bookId\) : fetchOne\(r\.ghost\.number\)/,
    'a row restore can silently choose another copy by number');
  assert.match(src, /ghost\?\.bookId \? fetchDeleted\(ghost\.bookId\) : copy \? pickGhost/,
    'the versions sheet can override a tombstone\'s stored canonical copy');
  assert.match(src, /\.\.\.deleted\.map\(\(bookId\) => \(\{ path: `\/api\/books\/\$\{bookId\}\/refetch`, body: \{\} \}\)\)/,
    'bulk restore does not keep duplicate-number tombstones distinct');
});
