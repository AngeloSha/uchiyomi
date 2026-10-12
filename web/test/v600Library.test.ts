// v0.60.0, the Library made easier to use: a toolbar over the grid (search, one Sort menu with a direction, Comfortable /
// Compact / List, Select and the sparkle), covers that say how far in you are, and a shelf that does not blank while it
// changes.
//
// The owner asked to "think how we can make the library look better UX-wise" and approved the whole design. What is pure
// (the orders and their directions, the device's layout, a series' progress) runs here; the cards and the toolbar are
// rendered statically, as v580Ratings.test.ts renders its tiles; the page's wiring, which a static render cannot reach, is
// read from source, as v558Preferences.test.ts reads its own. Every guard names the edit that makes it fail again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SeriesCard, SeriesRow, SeriesTile } from '../components/cards';
import { LibraryToolbar } from '../components/LibraryToolbar';
import { AuthProvider } from '../lib/auth';
import { SORTS, dirChoices, dirLabel, naturalDir, sortDirOf, sortString, validDir } from '../lib/librarySort';
import { LIBRARY_LAYOUTS, gridClass, libraryLayoutOn, setLibraryLayout } from '../lib/libraryLayout';
import { coverProgress, seriesProgress } from '../lib/seriesProgress';
import { sortValue } from '../lib/sortValue';
import { isTypingTarget } from '../lib/typeToSearch';
import { setActiveLocale } from '../lib/format';
import type { Series } from '../lib/types';

// Under tsx the components compile to the classic `React.createElement`, which they look up as a global.
(globalThis as { React?: unknown }).React = React;
setActiveLocale('en');

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file with its comments removed, JSX ones whole: comments here quote the lines they explain. */
const code = (src: string): string => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const slice = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `${from} … ${to} is not where this test looks`);
  return src.slice(a, b);
};
const page = () => code(read('app/library/page.tsx'));
const sortOf = (key: string) => SORTS.find((s) => s.key === key)!;

const series = (over: Partial<Series> = {}, yomi: Partial<NonNullable<Series['yomi']>> = {}): Series => ({
  id: 's1', libraryId: 'l1', name: 'Walk Tale', booksCount: 201, booksReadCount: 41, booksUnreadCount: 160, booksInProgressCount: 0,
  metadata: { title: 'Walk Tale' }, yomi: { favorite: false, rating: null, unread: 160, ...yomi }, ...over,
});
/** As the app mounts a card: under the session (its menu asks who is reading) and the query client. */
const mounted = (el: React.ReactElement) => renderToStaticMarkup(createElement(AuthProvider, null,
  createElement(QueryClientProvider, { client: new QueryClient() }, el)));

/* ================================================================ the order and its direction */

test('every order runs both ways: the natural direction first, worded for what it sorts', () => {
  // Reintroduce one direction per order (an Order switch that only says "High to low"): the pairs below fail. The words
  // say which end comes first -- never "ascending".
  const pairs = SORTS.map((s) => [s.key, dirChoices(s)]);
  assert.deepEqual(pairs, [
    ['updated', [['desc', 'Newest first'], ['asc', 'Oldest first']]],
    ['read', [['desc', 'Newest first'], ['asc', 'Oldest first']]],
    ['new', [['desc', 'Newest first'], ['asc', 'Oldest first']]],
    // v0.61.0, deliberately added: Releasing soon (the release radar's estimate), a time still to come, so its two ways
    // are "Soonest first" (its own) and "Latest first".
    ['soon', [['asc', 'Soonest first'], ['desc', 'Latest first']]],
    ['popular', [['desc', 'High to low'], ['asc', 'Low to high']]],
    ['score', [['desc', 'High to low'], ['asc', 'Low to high']]],
    ['rating', [['desc', 'High to low'], ['asc', 'Low to high']]],
    ['chapters', [['desc', 'Most first'], ['asc', 'Fewest first']]],
    ['unread', [['desc', 'Most first'], ['asc', 'Fewest first']]],
    ['az', [['asc', 'A–Z'], ['desc', 'Z–A']]],
  ]);
  for (const s of SORTS) assert.equal(dirChoices(s)[0][0], naturalDir(s), `${s.key}: the switch does not start at its own direction`);
  assert.equal(dirLabel(sortOf('az'), 'desc'), 'Z–A');
  assert.equal(validDir('asc') && validDir('desc'), true);
  assert.equal(validDir('ASC') || validDir('') || validDir(null) || validDir(1), false, 'junk is a direction');
});

test('flipping the direction flips the sort string the server is sent, and only its suffix', () => {
  // The server reads `field,asc|desc` for every order (bff ownedCatalog sortSql), empty values last either way. Reintroduce
  // a sort string that ignores the direction (`sortString = (s) => s.sort`): every flipped order below fails -- the Order
  // switch would tick and the shelf would not move.
  for (const s of SORTS) {
    const field = s.sort.split(',')[0];
    const other = naturalDir(s) === 'desc' ? 'asc' : 'desc';
    assert.equal(sortString(s, naturalDir(s)), s.sort, `${s.key}: its natural direction changed the sort string`);
    assert.equal(sortString(s, other), `${field},${other}`, `${s.key}: flipping it does not reach the server`);
  }
  // And the page sends exactly that, under a key that changes with it (a new direction is a new list, from page 0).
  const src = page();
  assert.match(src, /const sortBy = sortString\(active, dir\);/);
  assert.match(src, /json: \{ page: pageParam, size: 40, sort: sortBy, condition,/, 'the query does not send the direction');
  assert.match(src, /queryKey: \['library', active\.key, dir, /, 'a new direction appends to the list the old one fetched');
});

test('a shared order reads as it is named; the account\'s direction goes with the account\'s order only', () => {
  // URL -> account -> the order's own (v558Preferences.test.ts pins the page's line). The account's direction is the
  // one saved WITH its order: following `?sort=popular` from someone else must not run it in the direction this reader
  // last ran their own default. Reintroduce `sortDirOf(active, params.get('dir'), user?.settings?.librarySortDir)`:
  // "a shared URL is run in the account's direction" fails.
  const src = page();
  const call = /sortDirOf\(active, params\.get\('dir'\), ([^;]*)\);/.exec(src)?.[1];
  assert.ok(call, 'the page does not resolve the direction through sortDirOf');
  const accountArg = (urlSort: string | null, saved: unknown) =>
    new Function('validSort', 'urlSort', 'user', `return ${call};`)((v: unknown) => SORTS.some((s) => s.key === v), urlSort, { settings: { librarySortDir: saved } });
  const popular = sortOf('popular');
  assert.equal(sortDirOf(popular, null, accountArg('popular', 'asc')), 'desc', 'a shared URL is run in the account\'s direction');
  assert.equal(sortDirOf(popular, null, accountArg(null, 'asc')), 'asc', 'the account\'s own order loses its saved direction');
  assert.equal(sortDirOf(popular, 'asc', accountArg('popular', 'desc')), 'asc', 'the URL\'s direction does not win');
  assert.equal(sortDirOf(popular, null, accountArg('junk', 'asc')), 'asc', 'a junk URL order is not the account\'s');
});

test('Clear all keeps the order and its direction; the direction has its own chip; a new order starts natural', () => {
  // Reintroduce clearAll without `dir`: a reversed shelf flips back as a side effect of a button that says it removes
  // restrictions -- "Clear all drops the direction" fails.
  const src = page();
  const clear = slice(src, 'const clearAll = (alsoSearch: boolean) => {', '\n  };');
  assert.match(clear, /if \(sortKey\) n\.set\('sort', sortKey\);\s*if \(reversed\) n\.set\('dir', dir\);/, 'Clear all drops the direction');
  // The filter panel's own Clear all keeps the search; the active row's clears it too.
  assert.match(clear, /if \(!alsoSearch && q\) n\.set\('q', q\);/);
  assert.match(src, /<button onClick=\{\(\) => clearAll\(false\)\} className="mt-5 w-full/, 'the sidebar\'s Clear all clears the search');
  assert.match(src, /\{narrowed && <button onClick=\{\(\) => clearAll\(true\)\} className="chip text-xs text-fog-500">\{tr\('Clear all'\)\}<\/button>\}/);
  assert.equal((src.match(/router\.replace\(/g) ?? []).length, 2, 'a third URL writer');
  // A reversed order says so where the filters do, and its × puts the natural direction back, through setParam.
  assert.match(src, /\{reversed && \(\s*<button onClick=\{\(\) => setParam\('dir', naturalDir\(active\)\)\} className="chip text-xs" data-chip-dir>\s*\{tr\(dirLabel\(active, dir\)\)\} ×/,
    'a reversed order is not shown with the filters, or its chip cannot undo it');
  assert.match(slice(src, 'const setParam = ', 'const saveOrder = '), /if \(k === 'sort'\) next\.delete\('dir'\);/);
});

test('the Sort key says the order in force, and which way it runs when that is the other way', () => {
  // Rendered: one key, its icon upside down while reversed and its name saying so -- the icon alone says it to nobody.
  // Reintroduce the plain label as its only name: "a reversed order is not named" fails.
  const render = (key: string, dir: 'asc' | 'desc') => renderToStaticMarkup(createElement(LibraryToolbar, {
    q: '', onSearch() {}, active: sortOf(key), dir, onSort() {}, onDir() {}, onSortSheet() {}, layout: 'comfortable', onLayout() {},
    filterCount: 0, onFilters() {}, selecting: false, onSelecting() {}, onSelectAll() {}, onSurprise() {},
  }));
  const natural = render('popular', 'desc');
  const key = (html: string) => /<button [^>]*data-library-sort="[^"]*"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0] ?? '';
  assert.match(key(natural), /data-library-sort="popular" data-sort-dir="desc"/);
  assert.match(key(natural), /aria-label="Sorted by most popular"/);
  assert.match(key(natural), /<span class="min-w-0 truncate">Most popular<\/span>/);
  assert.doesNotMatch(key(natural), /-scale-y-100/, 'the natural order draws its icon upside down');
  const flipped = render('popular', 'asc');
  assert.match(key(flipped), /aria-label="Sorted by most popular · low to high"/, 'a reversed order is not named');
  assert.match(key(flipped), /-scale-y-100/, 'a reversed order does not turn its icon over');
  // A menu from lg up, a sheet below: what it opens is what it says it opens.
  assert.match(key(natural), /aria-haspopup="menu"/);
  const src = code(read('components/LibraryToolbar.tsx'));
  assert.match(src, /onClick=\{\(e\) => \(wide \? menu\.openFrom\(e\.currentTarget\) : onSheet\(\)\)\}/);
  assert.match(src, /aria-haspopup=\{wide \? 'menu' : 'dialog'\}/);
  // ⚠️ The phone's sheet is the PAGE's, beside its Filters sheet, never the toolbar's own: the toolbar sits in the phone's
  // sticky, blurred header -- the containing block of anything `fixed` in it -- and a sheet portalled to <body> would sit
  // over the bottom nav that every sheet on the page clears. Reintroduce `{sheet && <Sheet …>}` in the toolbar: "the sort
  // sheet opens inside the header" fails. The Order switch is its pinned footer: nine orders are taller than a phone.
  assert.doesNotMatch(src, /useState\(false\)|OnBody/, 'the sort sheet opens inside the header');
  const lib = page();
  assert.match(lib, /\{sortSheet && \(\s*<LibrarySortSheet active=\{active\} dir=\{dir\} onSort=\{\(k\) => setParam\('sort', k\)\} onDir=\{\(d\) => setParam\('dir', d\)\} onClose=\{\(\) => setSortSheet\(false\)\} \/>/);
  assert.ok(lib.indexOf('<LibrarySortSheet') > lib.indexOf('</header>'), 'the sort sheet opens inside the header');
  assert.match(src, /<Sheet title=\{tr\('Sort by'\)\} onClose=\{onClose\} overBottomNav\s*footer=\{\s*<div data-library-sort-order[^>]*>\s*<p [^>]*>\{tr\('Order'\)\}<\/p>\s*<Segmented square label=\{tr\('Order'\)\} value=\{dir\} onChange=\{pickDir\}/,
    'the Order switch scrolls with the orders, or the sheet does not clear the nav');
  // The menu: the four groups, each order a ticked choice under its group's heading, then the Order switch.
  assert.match(src, /label: tr\(s\.label\), heading: i === 0 \? tr\(g\.label\) : undefined, checked: s\.key === active\.key/);
  assert.match(src, /label: tr\(label\), heading: i === 0 \? tr\('Order'\) : undefined, checked: d === dir/);
  assert.match(src, /const pickDir = \(d: SortDir\) => \{ if \(d !== dir\) onDir\(d\); \};/);
});

/* ================================================================ the toolbar */

test('the toolbar: a real search field, the phone\'s Filters key, Select and Select all, the sparkle -- all keys', () => {
  // Reintroduce the Select chip: noPills.test.ts fails on the capsule; here, "Select is not a key" fails.
  const base = {
    q: 'blue', onSearch() {}, active: sortOf('updated'), dir: 'desc' as const, onSort() {}, onDir() {}, onSortSheet() {}, layout: 'compact' as const,
    onLayout() {}, filterCount: 2, onFilters() {}, onSelecting() {}, onSelectAll() {}, onSurprise() {},
  };
  const idle = renderToStaticMarkup(createElement(LibraryToolbar, { ...base, selecting: false }));
  const input = /<input [^>]*data-library-search[^>]*\/>/.exec(idle)?.[0] ?? '';
  assert.match(input, /placeholder="Search your library…"/, 'the field has no prompt');
  assert.match(input, /value="blue"/, 'the field does not show the search in the URL');
  assert.match(idle, /aria-label="Clear search"/, 'a search cannot be emptied with one tap');
  assert.match(idle, /<button type="button" aria-haspopup="dialog" class="btn-key h-9 lg:hidden btn-key-accent">[\s\S]*?Filters · 2<\/button>/,
    'the phone\'s Filters key does not count the filters, or shows beside the open sidebar');
  assert.match(idle, /<button type="button" class="btn-key h-9 ">Select<\/button>/, 'Select is not a key');
  assert.doesNotMatch(idle, />Select all</, 'Select all outside select mode');
  assert.match(idle, /aria-label="Surprise me" class="btn-key h-9 w-9 px-0"/);
  // The layouts: one radio group, the device's choice checked.
  assert.match(idle, /data-library-layout="compact"/);
  assert.match(idle, /role="radiogroup" aria-label="Layout"/);
  assert.match(idle, /<button type="button" role="radio" aria-checked="true"[^>]*title="Compact"/);
  const choosing = renderToStaticMarkup(createElement(LibraryToolbar, { ...base, selecting: true }));
  assert.match(choosing, /class="btn-key h-9">Select all<\/button>/);
  assert.match(choosing, /class="btn-key h-9 btn-key-accent">Done<\/button>/);
  assert.doesNotMatch(choosing, /Surprise me/, 'the sparkle leaves the page in the middle of a selection');
  // A real <input>: type-to-search leaves the keys typed in it alone.
  assert.equal(isTypingTarget({ tagName: 'INPUT' } as unknown as Element), true);
});

test('the search follows a pause in the typing, Escape empties it, and the URL carries it to the server', () => {
  // Reintroduce the search per keystroke (no timer): "the field does not wait for a pause" fails; drop `q` from the key:
  // a new search appends to the list the old one fetched.
  const src = code(read('components/LibraryToolbar.tsx'));
  assert.match(src, /export const SEARCH_DEBOUNCE_MS = 300;/);
  assert.match(src, /const h = setTimeout\(\(\) => \{ sent\.current = next; write\.current\(next\); \}, SEARCH_DEBOUNCE_MS\);\s*return \(\) => clearTimeout\(h\);/,
    'the field does not wait for a pause');
  // ⚠️ Through the writer of the moment it fires: the page's setParam is built over the params it was rendered with, and
  // the one captured by the keystroke would write a filter picked during the pause back out. Reintroduce `onSearch(next)`
  // in the timer: "a filter picked during the pause is lost" fails.
  assert.match(src, /const write = useRef\(onSearch\);\s*write\.current = onSearch;/, 'a filter picked during the pause is lost');
  assert.match(src, /else if \(e\.key === 'Escape'\) \{\s*e\.preventDefault\(\);\s*if \(typed\) commit\(''\);\s*else e\.currentTarget\.blur\(\);/, 'Escape does not empty the field');
  // The field follows the URL when something else moves it (Clear all, a chip, Back).
  assert.match(src, /if \(q !== sent\.current\) \{ sent\.current = q; setTyped\(q\); \}/);
  const lib = page();
  assert.match(lib, /const q = \(params\.get\('q'\) \|\| ''\)\.trim\(\);/);
  assert.match(lib, /q=\{q\} onSearch=\{\(v\) => setParam\('q', v\)\}/, 'the search does not go through the page\'s one URL writer');
  assert.match(lib, /queryKey: \['library', active\.key, dir, read, status, genres\.join\(','\), lib, src, anysrc, q\],/);
  assert.match(lib, /query: q \|\| undefined, collapseEditions: true/, 'the search is not sent');
  // The count says how many match, and an empty search says so -- never "your library is empty".
  assert.match(lib, /\(total === 1 \? tr\('1 series matches'\) : tr\('\{n\} series match', \{ n: total \}\)\)/);
  assert.match(lib, /\{q \? tr\('No series match “\{query\}”\.', \{ query: q \}\) : tr\('Nothing matches those filters\.'\)\}/);
  assert.match(lib, /\{q && \(\s*<button onClick=\{\(\) => setParam\('q', ''\)\}/, 'the search has no chip to clear it with');
});

/* ================================================================ Comfortable, Compact, List */

test('the layout is per device: Comfortable until this device picks another, and it survives a reload', () => {
  // Reintroduce a layout read during render (`useState(libraryLayoutOn())`): the static export's first client render no
  // longer matches it -- "read after mount" fails; store it under `view` (the Series | Downloads param's name): the key fails.
  const mem = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  try {
    assert.equal(libraryLayoutOn(), 'comfortable', 'a new device does not start Comfortable');
    setLibraryLayout('list');
    assert.equal(mem.get('uchiyomi.libraryView'), 'list', 'the layout is not this device\'s, under its own key');
    assert.equal(libraryLayoutOn(), 'list', 'the layout does not survive a reload');
    setLibraryLayout('compact');
    assert.equal(libraryLayoutOn(), 'compact');
    setLibraryLayout('comfortable');
    assert.equal(mem.has('uchiyomi.libraryView'), false, 'the default is stored as something');
    mem.set('uchiyomi.libraryView', 'giant');
    assert.equal(libraryLayoutOn(), 'comfortable', 'junk in storage is a layout');
    (globalThis as any).localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
    assert.equal(libraryLayoutOn(), 'comfortable', 'storage that throws breaks the Library');
    assert.doesNotThrow(() => setLibraryLayout('list'));
  } finally { delete (globalThis as any).localStorage; }
  assert.deepEqual([...LIBRARY_LAYOUTS], ['comfortable', 'compact', 'list']);
  const src = page();
  assert.match(src, /const \[layout, setLayout\] = useState<LibraryLayout>\('comfortable'\);\s*useEffect\(\(\) => \{ setLayout\(libraryLayoutOn\(\)\); \}, \[\]\);/, 'the layout is not read after mount');
  assert.match(src, /onLayout=\{\(v\) => \{ setLayout\(v\); setLibraryLayout\(v\); \}\}/, 'a pick is not remembered on the device');
  assert.doesNotMatch(read('lib/libraryLayout.ts'), /'uchiyomi\.view'|searchParams|params\.get/, 'the layout rides the URL');
});

test('Comfortable is exactly the grid that shipped; Compact has more columns at every step; every layout is the measured grid', () => {
  // layout.mjs measures [data-library-grid] beside the sidebar in Comfortable. Reintroduce a restyled default: "the
  // Comfortable grid changed" fails.
  assert.equal(gridClass('comfortable'),
    'grid grid-cols-3 gap-x-3 gap-y-5 px-4 pt-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-5 lg:gap-x-4 lg:px-0 xl:grid-cols-6 2xl:grid-cols-7 3xl:grid-cols-8 4xl:grid-cols-10',
    'the Comfortable grid changed');
  const cols = (cls: string) => Object.fromEntries([...cls.matchAll(/(?:^|\s)(?:([a-z0-9]+):)?grid-cols-(\d+)/g)].map((m) => [m[1] ?? 'base', Number(m[2])]));
  const comfy = cols(gridClass('comfortable'));
  const dense = cols(gridClass('compact'));
  for (const step of ['base', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl']) {
    assert.ok(dense[step] > comfy[step], `Compact is not denser than Comfortable at ${step} (${dense[step]} vs ${comfy[step]})`);
  }
  assert.match(gridClass('list'), /^grid grid-cols-1 /);
  const src = page();
  assert.match(src, /<div data-library-grid data-layout=\{layout\} aria-busy=\{refreshing \|\| undefined\} className=\{`relative isolate \$\{gridClass\(layout\)\}`\}>/);
  assert.match(src, /\(layout === 'list'\s*\? <SeriesRow key=\{s\.id\} series=\{s\} eager=\{i < 12\} note=\{sortValue\(s, active\.key\)\}\s*selectable=\{selecting\} selected=\{picked\.has\(s\.id\)\} onToggle=\{\(\) => togglePick\(s\.id\)\} \/>/,
    'a list row is not the same link, select toggle and value line as a tile');
  assert.match(src, /compact=\{layout === 'compact'\}/);
});

/* ================================================================ how far in */

test('a series\' progress: nothing read is no bar, finished is the whole edge, and junk is nothing', () => {
  // Reintroduce a bar for an untouched series (coverProgress returning seriesProgress): "nothing read draws a bar" fails.
  assert.deepEqual(seriesProgress({ booksCount: 201, booksReadCount: 41 }), { read: 41, total: 201, fraction: 41 / 201, finished: false });
  assert.equal(coverProgress({ booksCount: 201, booksReadCount: 0 }), null, 'nothing read draws a bar');
  assert.equal(seriesProgress({ booksCount: 201, booksReadCount: 0 })?.fraction, 0, 'a list row has no track to draw');
  assert.deepEqual(coverProgress({ booksCount: 12, booksReadCount: 12 }), { read: 12, total: 12, fraction: 1, finished: true });
  assert.equal(coverProgress({ booksCount: 12, booksReadCount: 15 })?.fraction, 1, 'a read count past the total runs past the edge');
  assert.equal(coverProgress({ booksCount: 12, booksReadCount: 15 })?.finished, true);
  assert.equal(seriesProgress({ booksCount: 0, booksReadCount: 0 }), null, 'a series with no chapters has progress');
  assert.equal(seriesProgress({ booksCount: Number.NaN, booksReadCount: 3 }), null);
  assert.equal(coverProgress({ booksCount: 10, booksReadCount: -2 }), null);
});

test('the covers draw it: 3 px along the bottom, nothing when unread, the whole edge in the accent when finished', () => {
  // Rendered, Library tile and Home card alike. Reintroduce the bar's colour for a finished series (`bg-fog-100/90` for
  // both): "a finished series is not drawn finished" fails.
  const bar = (html: string) => /<span aria-hidden="true" data-read-progress="([^"]*)" class="([^"]*)"><span class="([^"]*)" style="width:([^"]*)"><\/span><\/span>/.exec(html);
  for (const [name, el] of [['tile', SeriesTile], ['card', SeriesCard]] as const) {
    const draw = (over: Partial<Series>) => mounted(createElement(el as typeof SeriesTile, { series: series(over) }));
    const some = bar(draw({ booksReadCount: 41 }));
    assert.ok(some, `${name}: a series 41 chapters in has no bar`);
    assert.equal(some![1], '20', `${name}: the bar does not say how far in`);
    assert.match(some![2], /\babsolute inset-x-0 bottom-0\b.*\bh-\[3px\]/, `${name}: the bar is not 3 px along the bottom edge`);
    assert.match(some![3], /bg-fog-100\/90/);
    assert.equal(some![4], '20.4%');
    assert.equal(bar(draw({ booksReadCount: 0 })), null, `${name}: nothing read draws a bar`);
    const done = bar(draw({ booksReadCount: 201 }));
    assert.ok(done && done[1] === 'done' && /\bbg-accent\b/.test(done[3]) && done[4] === '100%', `${name}: a finished series is not drawn finished`);
  }
  // The list row writes it out: "41 / 201", left to right in every language.
  const row = mounted(createElement(SeriesRow, { series: series() }));
  assert.match(row, /<span dir="ltr" data-row-progress="true" class="[^"]*">41 \/ 201<\/span>/);
});

test('the tags are squared and mirror in Arabic, and the select bubble no longer sits on the heart', () => {
  // "No more pills": every count tag in the app is squared since v0.49.0 but these two. Reintroduce `rounded-full` on the
  // unread count: "a capsule tag" fails; a physical `left-`: "a badge that does not mirror" fails.
  // ⚠️ And the direction is on the count's TEXT, the box around it in the page's own: a box's own direction decides where
  // `end` is, and the ltr box sat top-right in Arabic (seen in this release's shots). Reintroduce `dir="ltr"` on the
  // positioned tag: "the tag carries its own direction" fails.
  const fav = series({ yomi: { favorite: true, rating: null, unread: 120, newCount: 2 } });
  for (const [name, el] of [['tile', SeriesTile], ['card', SeriesCard], ['row', SeriesRow]] as const) {
    const html = mounted(createElement(el as typeof SeriesTile, { series: fav }));
    const unread = /<span ([^>]*)><span dir="ltr" data-unread="120">99\+<\/span><\/span>/.exec(html);
    assert.ok(unread, `${name}: the unread count is not capped "99+" in a left-to-right box`);
    assert.match(unread![1], /^class="[^"]*"$/, `${name}: the tag carries its own direction (or another attribute)`);
    assert.match(unread![1], /rounded-\[4px\]/, `${name}: a capsule tag`);
    assert.doesNotMatch(unread![1], /rounded-full/, `${name}: a capsule tag`);
    if (name !== 'row') assert.match(unread![1], /\babsolute end-[\d.]+ top-[\d.]+\b/, `${name}: the tag is not at the top end`);
    const fresh = /<span class="([^"]*)">New<\/span>/.exec(html);
    assert.ok(fresh && /rounded-\[4px\]/.test(fresh[1]) && !/rounded-full/.test(fresh[1]), `${name}: NEW is a capsule`);
  }
  const cards = code(read('components/cards.tsx'));
  for (const fn of ['export function SeriesCard(', 'export function SeriesTile(', 'export function SeriesRow(']) {
    const body = slice(cards, fn, '\n}\n');
    assert.doesNotMatch(body, /(?<![\w-])(?:left|right)-(?:\d|\[|full)/, `${fn}: a badge that does not mirror (physical left/right)`);
    assert.doesNotMatch(body, /\btext-left\b/, `${fn}: a physical text alignment`);
  }
  // In select mode the bubble takes top-start, and the heart steps down under it.
  const picking = mounted(createElement(SeriesTile, { series: fav, selectable: true, selected: true }));
  assert.match(picking, /<span class="absolute start-1\.5 top-9 z-10 rounded-full bg-black\/55/, 'the select bubble covers the heart');
  assert.match(mounted(createElement(SeriesTile, { series: fav })), /<span class="absolute start-1\.5 top-1\.5 z-10 rounded-full bg-black\/55/);
  assert.match(picking, /<button type="button" aria-pressed="true" class="group block w-full text-start">/, 'a selected tile does not say so');
});

test('the card\'s ⋯: a mouse\'s way to the card menu, beside the link (never in it), and not while selecting', () => {
  // Reintroduce the ⋯ inside the link: a button in an <a> is two targets in one -- "the ⋯ is inside the link" fails; show
  // it on a touchscreen: "the ⋯ shows without a fine pointer" fails.
  for (const [name, el] of [['tile', SeriesTile], ['card', SeriesCard], ['row', SeriesRow]] as const) {
    const html = mounted(createElement(el as typeof SeriesTile, { series: series() }));
    const more = /<button type="button" data-card-more="true" aria-label="Actions for Walk Tale" aria-haspopup="menu" aria-expanded="false" class="([^"]*)">/.exec(html);
    assert.ok(more, `${name}: no ⋯, or it does not name its series`);
    const link = html.slice(html.indexOf('<a '), html.indexOf('</a>'));
    assert.ok(link && !link.includes('data-card-more'), `${name}: the ⋯ is inside the link`);
    // Only from lg up with a fine pointer: on the key itself (the row) or on the box that carries it (the covers).
    const shown = name === 'row' ? more![1] : (/<div class="([^"]*)"[^>]*>\s*<button type="button" data-card-more/.exec(html)?.[1] ?? '');
    assert.match(shown, /\bhidden\b/, `${name}: the ⋯ shows without a fine pointer`);
    assert.match(shown, /\blg:pointer-fine:(?:block|grid)\b/, `${name}: the ⋯ shows without a fine pointer`);
    assert.match(more![1], /\bopacity-0 group-hover:opacity-100\b/, `${name}: the ⋯ is not a hover reveal`);
    assert.match(more![1], /\bfocus-visible:opacity-100\b/, `${name}: the ⋯ cannot be reached from the keyboard`);
    assert.match(more![1], /\btransition-opacity\b/);
    // Home's card has no select mode; the Library's tile and row do.
    if (name !== 'card') {
      const picking = mounted(createElement(el as typeof SeriesTile, { series: series(), selectable: true }));
      assert.doesNotMatch(picking, /data-card-more/, `${name}: a ⋯ in select mode`);
    }
  }
  const cards = code(read('components/cards.tsx'));
  assert.match(cards, /onClick=\{\(e\) => menu\.openFrom\(e\.currentTarget\)\}/, 'the ⋯ does not open the card\'s own menu');
  // The cover's ⋯ moves with the cover: the same lift, and on Home the same tilt.
  assert.match(cards, /<div style=\{\{ transform: tilt\.style\?\.transform, transition: tilt\.style\?\.transition \}\}/, 'Home\'s ⋯ does not tilt with its card');
});

/* ================================================================ a shelf that does not blank */

test('a new order, filter or search keeps the shelf on screen, veiled, with a line along its top', () => {
  // Reintroduce the query without placeholderData: every chip tap and every pause in the typing flashes the grid to
  // fourteen skeletons -- "the shelf blanks while it changes" fails.
  const src = page();
  const query = slice(src, 'useInfiniteQuery({', '\n  });');
  assert.match(query, /placeholderData: keepPreviousData,/, 'the shelf blanks while it changes');
  assert.match(src, /import \{ keepPreviousData, useInfiniteQuery, useQuery, useQueryClient \} from '@tanstack\/react-query';/);
  assert.match(src, /const refreshing = isPlaceholderData;/);
  // Skeletons only for the very first load, when there is nothing to keep.
  assert.match(src, /\{isLoading\s*\? Array\.from\(\{ length: 14 \}\)/);
  // The veil and the line: keyed on the placeholder, still under reduced motion or Reduce effects.
  assert.match(src, /const plain = useReduceEffects\(\);\s*const still = useReducedMotion\(\);\s*const calm = plain \|\| !!still;/);
  assert.match(src, /bg-ink-950\/45 \$\{refreshing \? 'opacity-100' : 'opacity-0'\} \$\{calm \? '' : 'transition-opacity duration-300'\}/, 'the veil fades under Reduce effects');
  const line = slice(src, '{refreshing && (', '</div>\n        )}');
  assert.match(line, /data-library-refreshing/);
  assert.match(line, /\{calm\s*\? <div className="h-full w-full bg-accent\/60" \/>\s*: <div className="[^"]*\banimate-indeterminate\b[^"]*" \/>\}/, 'the line runs under Reduce effects or reduced motion');
  assert.equal((src.match(/animate-indeterminate/g) ?? []).length, 1, 'the line runs somewhere without asking');
  assert.match(read('app/globals.css'), /--animate-indeterminate: indeterminate [^;]+ infinite;/);
  // The next page is never asked for on the placeholder's behalf (react-query's hasNextPage reads the real data), and a
  // page that failed is not asked for again by the observer.
  assert.match(src, /if \(e\[0\]\.isIntersecting && hasNextPage && !isFetchingNextPage && !isFetchNextPageError\) fetchNextPage\(\);/);
});

test('a failed load says so, with Try again -- never "your library is empty", never skeletons that never fill', () => {
  // `isError` was never read: a failed request left the grid empty with nothing said, or -- with no filter on -- an empty
  // answer and "Your library is empty." Reintroduce `!isLoading` for `settled`: an error reads as an empty library.
  const src = page();
  assert.match(src, /\{isError && !items\.length && \(\s*<div data-library-error[^>]*>\s*<p [^>]*>\{tr\('Couldn’t load your library'\)\}<\/p>\s*<button type="button" onClick=\{\(\) => \{ void refetch\(\); \}\} disabled=\{isFetching\} className="btn-key mt-3">\{tr\('Try again'\)\}<\/button>/,
    'a failed load has no state of its own, or no way to ask again');
  assert.match(src, /const settled = !isLoading && !isPlaceholderData && !isError;/);
  assert.match(src, /\{settled && total === 0 && !narrowed && \(/, 'an error reads as an empty library');
  assert.match(src, /\{settled && !items\.length && narrowed && \(/);
  // A later page that failed keeps the shelf so far, and asks once.
  assert.match(src, /\{isFetchNextPageError && !isFetchingNextPage && \([\s\S]*?\{tr\('Couldn’t load more'\)\}\s*<button type="button" onClick=\{\(\) => \{ void fetchNextPage\(\); \}\}/);
});

/* ================================================================ the page around it */

test('the toolbar sticks under the top bar, the filter panel clears it, and the phone header lines up with the grid', () => {
  // TopNav is 65 px and sticky; the sidebar used `top-6`, so its first sections slid under the bar. The phone header was
  // `px-5` over a `px-4` grid. Reintroduce either: this fails.
  const src = page();
  assert.match(src, /<div className="sticky top-\[65px\] max-h-\[calc\(100dvh-65px\)\] overflow-y-auto pb-8 pt-6" data-lenis-prevent>/, 'the filter panel slides under the top bar');
  assert.match(src, /<header className="safe-top sticky top-0 z-30 bg-ink-950\/85 px-4 pb-3 backdrop-blur-xl lg:contents">/, 'the phone header is not on the grid\'s gutter');
  assert.match(src, /className="mt-3 lg:sticky lg:top-\[65px\] lg:z-20 /, 'the toolbar does not stick under the top bar');
  assert.match(read('components/TopNav.tsx'), /<header className="sticky top-0 z-40 hidden border-b border-ink-800\/70 bg-ink-950\/80 backdrop-blur-xl lg:block">\s*<div className="shell flex items-center gap-3 py-3 xl:gap-6">/,
    'the top bar changed height: 65 px is its 40 px keys, py-3 and the border');
  // The filter panel is filters only; the order is the toolbar's.
  const filters = code(read('components/LibraryFilters.tsx'));
  assert.doesNotMatch(filters, /Sort by|SORTS|onSet\('sort'/, 'the filter panel still holds the orders');
  // The phone's filter sheet pins Clear all and Done under the list.
  const sheet = slice(src, "<Sheet title={tr('Filters')}", '</Sheet>');
  assert.match(sheet, /footer=\{[\s\S]*?clearAll\(false\)[\s\S]*?\{tr\('Clear all'\)\}[\s\S]*?setSheet\(false\)\} className="btn-key btn-key-primary h-10 flex-1">\{tr\('Done'\)\}/, 'Done is not pinned under the filters');
});
