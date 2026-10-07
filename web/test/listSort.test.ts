// Sorting the series inside a list, and their unread badges (v0.55.7, #164).
//
// A list is one request and never paged, so lib/listSort.ts orders it on the page; every order is pinned here on a list
// where each order comes out different, with ties that must stay in the list's own order. The chosen order is kept per
// list on the account. The badge is the Library's own tile, so a list shows the same number the Library does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { LIST_SORTS, listSortOf, sortList, withListSort, type ListItem, type ListSort } from '../lib/listSort';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Source with its comments removed. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const NOW = Date.parse('2026-10-07T12:00:00Z');
const ago = (days: number | null) => (days == null ? null : new Date(NOW - days * 86_400_000).toISOString());
const item = (id: string, title: string, o: { unread: number; listed?: number; read: number | null; latest: number | null }): ListItem => ({
  id, name: title, metadata: { title }, booksUnreadCount: o.listed ?? o.unread,
  yomi: { favorite: false, rating: null, unread: o.unread }, lastReadAt: ago(o.read), latestChapterAt: ago(o.latest),
});

// The list's own order. `ash` is lower-case and claims 40 unread in the DTO's placeholder field while the reader's own
// count says 0; Volume 2 and Volume 10 need numbers compared as numbers; Éclair needs its accent set aside.
const LIST: ListItem[] = [
  item('gold', 'Golden Hour', { unread: 3, read: 1, latest: 2 }),
  item('ash', 'ashen Crown', { unread: 0, listed: 40, read: 12, latest: 30 }),
  item('moon', 'Moonlit Ledger', { unread: 27, read: null, latest: 1 }),
  item('vol10', 'Volume 10', { unread: 3, read: 3, latest: null }),
  item('vol2', 'Volume 2', { unread: 0, read: null, latest: 5 }),
  item('eclair', 'Éclair', { unread: 1, read: 0.2, latest: 2 }),
];
const order = (sort: ListSort) => sortList(LIST, sort).map((s) => s.id);

test("the list's own order is the default, and is kept as it is", () => {
  // Reintroduce by sorting the default (`default: return by(...)` on titles): the list someone arranged by hand opens
  // rearranged, and this fails.
  assert.deepEqual(order('manual'), ['gold', 'ash', 'moon', 'vol10', 'vol2', 'eclair']);
  assert.equal(LIST_SORTS[0].key, 'manual', 'the first choice is not the list\'s own order');
  assert.notEqual(sortList(LIST, 'manual'), LIST, 'the caller\'s array came back to be sorted in place later');
});

test('A–Z: by title, case and accents aside, numbers by value', () => {
  // Reintroduce a plain `a < b` comparison: "Volume 10" sorts before "Volume 2", "ashen" after "Volume", and "Éclair"
  // after them all.
  assert.deepEqual(order('az'), ['ash', 'eclair', 'gold', 'moon', 'vol2', 'vol10']);
});

test('Z–A: the same titles the other way round', () => {
  assert.deepEqual(order('za'), ['vol10', 'vol2', 'moon', 'gold', 'eclair', 'ash']);
});

test("Last read: the series this reader read most recently first, and the never-read ones after, in the list's order", () => {
  // Reintroduce by reading a missing date as now (`a ? Date.parse(a) : Date.now()`): the series never opened jump to
  // the top, and this fails. Ties (moon and vol2, both never read) stay in the list's order.
  assert.deepEqual(order('read'), ['eclair', 'gold', 'vol10', 'ash', 'moon', 'vol2']);
});

test("Most unread: by the unread badge's own number, ties in the list's order", () => {
  // Reintroduce by ordering on booksUnreadCount: `ash`'s placeholder 40 puts a series the reader has finished first,
  // and this fails. gold and vol10 (3 each) stay in the list's order.
  assert.deepEqual(order('unread'), ['moon', 'gold', 'vol10', 'eclair', 'ash', 'vol2']);
});

test('Latest chapter: the newest chapter first, a series without one last', () => {
  assert.deepEqual(order('latest'), ['moon', 'gold', 'eclair', 'vol2', 'ash', 'vol10']);
});

test('the order is kept per list on the account, and only a real order is read back', () => {
  // Reintroduce by storing `manual` (dropping `sort !== 'manual'`): the account keeps an entry for every list ever
  // touched -- "the default is stored" fails.
  const settings = { listSorts: { L1: 'az', L2: 'nonsense', L3: 42 } };
  assert.equal(listSortOf(settings, 'L1'), 'az');
  assert.equal(listSortOf(settings, 'L2'), 'manual', 'a value that is not an order is trusted');
  assert.equal(listSortOf(settings, 'L3'), 'manual');
  assert.equal(listSortOf(settings, 'L9'), 'manual', 'a list never sorted is not in its own order');
  assert.equal(listSortOf(undefined, 'L1'), 'manual');
  assert.equal(listSortOf({ listSorts: 'az' }, 'L1'), 'manual');
  // What is PUT is the whole map (the server merges top-level keys only): the other lists' orders ride along.
  assert.deepEqual(withListSort(settings.listSorts, 'L4', 'read'), { L1: 'az', L4: 'read' }, 'another list\'s order was lost');
  assert.deepEqual(withListSort({ L1: 'az', L4: 'read' }, 'L1', 'manual'), { L4: 'read' }, 'the default is stored');
  assert.deepEqual(Object.keys(withListSort({ L1: 'az', L4: 'read' }, 'L1', 'za')), ['L4', 'L1'], 'the latest choice is not last');
  assert.deepEqual(withListSort(null, 'L1', 'latest'), { L1: 'latest' });
  // Bounded: the oldest choices go first.
  const many = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`x${i}`, 'az']));
  const kept = withListSort(many, 'L1', 'read');
  assert.equal(Object.keys(kept).length, 100);
  assert.ok(!('x0' in kept) && 'x119' in kept && kept.L1 === 'read', 'the bound dropped the wrong choices');
});

test("a list's page shows the Library's tile, sorts with the chips, and saves the order to the account", () => {
  // The badge is the Library's because the tile is: the same component, the same `yomi.unread`. Reintroduce the list's
  // own cover markup (an <Img> in a bare box): "the list's items are not the Library's tile" fails.
  const page = code(read('app/collection/page.tsx'));
  assert.match(page, /import \{ SeriesTile \} from '@\/components\/cards';/, "the list's items are not the Library's tile");
  assert.match(page, /\) : \(\s*<SeriesTile key=\{s\.id\} series=\{s\} \/>\s*\)\)\}/, "the list's items are not the Library's tile");
  assert.match(page, /const shown = useMemo\(\(\) => sortList\(items, sort\), \[items, sort\]\);/, 'the grid is not sorted');
  assert.match(page, /\{shown\.map\(/, 'the grid draws the unsorted items');
  // The sort chips are the Library's chips: `chip` / `chip-active`, no new shape.
  assert.match(page, /className=\{`chip text-xs \$\{value === s\.key \? 'chip-active' : ''\}`\}/, 'the sort chips are not the Library\'s chips');
  assert.match(page, /const chosen = listSortOf\(user\?\.settings, id\);/, 'the order is not read from the account');
  assert.match(page, /api\('\/api\/settings', \{ method: 'PUT', json: \{ listSorts: map \} \}\)/, 'the order is not saved to the account');
  // A menu action on a list's tile (Mark all read) moves the list's badge too.
  assert.match(code(read('components/SeriesMenu.tsx')), /\['library'\], \['home'\], \['collection'\]/, "Mark all read from a list's tile leaves its badge stale");
});
