// v0.55.8 account preferences that change navigation rather than data: the Library's default order and the
// zero-to-three Lists shown on Home. These decisions live in page components, so this test pins the source contract
// the same way libraryView.test.ts does; browser walks cover the rendered controls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SORTS, naturalDir, sortDirOf, sortString } from '../lib/librarySort';

const ROOT = join(__dirname, '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('a valid Library URL sort wins for this visit, then the account default, then Updated', () => {
  const src = code(read('app/library/page.tsx'));
  assert.match(src, /const validSort = \(v: unknown\): v is string => typeof v === 'string' && SORTS\.some\(\(s\) => s\.key === v\)/,
    'unknown and obsolete setting values must not become backend sort expressions');
  assert.match(src, /const urlSort = params\.get\('sort'\);\s*const sortKey = validSort\(urlSort\) \? urlSort : validSort\(user\?\.settings\?\.librarySort\) \? user!\.settings\.librarySort : 'updated';/,
    'the precedence is not URL, saved account value, Updated');
  assert.match(src, /const active = useMemo\(\(\) => SORTS\.find\(\(s\) => s\.key === sortKey\) \|\| SORTS\[0\], \[sortKey\]\)/,
    'the chosen key does not resolve through the public sort definitions');
  // v0.60.0: its direction by the same precedence -- the URL's `dir`, then the account's, but the account's only with
  // the account's own order -- and the two together are the sort string the series query sends.
  assert.match(src, /const dir: SortDir = sortDirOf\(active, params\.get\('dir'\), validSort\(urlSort\) \? null : user\?\.settings\?\.librarySortDir\);/,
    'the direction does not follow the URL, then the account (with its own order only), then the order\'s natural one');
  assert.match(src, /const sortBy = sortString\(active, dir\);/);
  assert.match(src, /api<Page<Series>>\('\/api\/series\/search', \{ json: \{ page: pageParam, size: 40, sort: sortBy, condition/,
    'the resolved sort does not control the series query');
});

test('the direction: the URL wins, then the account\'s saved with its order, then the order\'s own -- and junk is nothing', () => {
  // Run, not read: what sortDirOf answers is what the page sends (sortString). Reintroduce the account's direction for an
  // order from a shared URL (pass it unconditionally): the page pin above fails; make junk count (`url ?? account`):
  // "a junk dir in the URL" fails.
  const popular = SORTS.find((s) => s.key === 'popular')!;
  const az = SORTS.find((s) => s.key === 'az')!;
  assert.equal(sortDirOf(popular, 'asc', 'desc'), 'asc', 'the URL\'s dir does not win for this visit');
  assert.equal(sortDirOf(popular, null, 'asc'), 'asc', 'the saved direction is not the default');
  assert.equal(sortDirOf(popular, null, null), 'desc', 'with nothing said, Most popular does not start at the most popular');
  assert.equal(sortDirOf(az, null, undefined), 'asc', 'with nothing said, A–Z does not start at A');
  assert.equal(sortDirOf(popular, 'sideways', 'asc'), 'asc', 'a junk dir in the URL');
  assert.equal(sortDirOf(popular, 'DESC', 'nope'), 'desc', 'a junk saved direction');
  assert.equal(sortString(popular, sortDirOf(popular, null, 'asc')), 'popularity,asc');
  assert.equal(sortString(az, 'desc'), 'metadata.titleSort,desc');
  assert.equal(sortString(popular, naturalDir(popular)), popular.sort, 'the natural direction changed the sort string');
});

test('only a direct sort click saves the default, without undoing the current URL on failure', () => {
  const page = code(read('app/library/page.tsx'));
  const toolbar = code(read('components/LibraryToolbar.tsx'));
  const start = page.indexOf('const setParam = ');
  const end = page.indexOf('const clearAll = ', start);
  assert.ok(start >= 0 && end > start, 'setParam is where the test expects it');
  const setParam = page.slice(start, end);

  // v0.60.0: the orders are the toolbar's Sort menu (a menu from lg up, a sheet on a phone). Each pick is a click on that
  // order -- the menu's item and the sheet's row -- and only another order than the one in force is a change.
  assert.match(toolbar, /onSelect: \(\) => pickSort\(s\.key\),/, 'the menu\'s orders no longer identify an explicit sort click');
  assert.match(toolbar, /onPick=\{\(\) => pickSort\(s\.key\)\}/, 'the sheet\'s orders no longer identify an explicit sort click');
  assert.match(toolbar, /const pickSort = \(key: string\) => \{ if \(key !== active\.key\) onSort\(key\); \};/, 'the menu saves the order already in force');
  assert.match(toolbar, /const pickSort = \(key: string\) => \{ onClose\(\); if \(key !== active\.key\) onSort\(key\); \};/, 'the sheet saves the order already in force');
  assert.match(page, /onSort=\{\(k\) => setParam\('sort', k\)\} onDir=\{\(d\) => setParam\('dir', d\)\}/, 'the toolbar\'s picks do not reach setParam');
  assert.match(setParam, /router\.replace\(`\/library\?\$\{next\.toString\(\)\}`\);\s*if \(k === 'sort' && validSort\(v\)\)/,
    'the URL must update first and non-sort controls must not save a default');
  // A new order drops the old one's direction from the URL, and is saved with its own natural one; a direction is saved
  // with the order it was picked for. Nothing else saves.
  assert.match(setParam, /if \(k === 'sort'\) next\.delete\('dir'\);/, 'a new order keeps the direction picked for the last one');
  assert.match(setParam, /if \(k === 'sort' && validSort\(v\)\) saveOrder\(v, naturalDir\(SORTS\.find\(\(s\) => s\.key === v\)!\)\);\s*else if \(k === 'dir' && validDir\(v\)\) saveOrder\(sortKey, v\);/,
    'an order or a direction is not saved as a pair');
  assert.equal((page.match(/api\('\/api\/settings'/g) ?? []).length, 1,
    'a URL read/effect appears to save librarySort, or the click saves it twice');
  assert.equal((page.match(/saveOrder\(/g) ?? []).length, 2, 'something other than a sort or direction pick saves the order');
  assert.match(setParam, /const previous = \{ librarySort: user\?\.settings\?\.librarySort, librarySortDir: user\?\.settings\?\.librarySortDir \};\s*setSettings\(\{ librarySort: sort, librarySortDir: sortDir \}\);/,
    'the click is not applied optimistically to the account');
  assert.match(setParam, /api\('\/api\/settings', \{ method: 'PUT', json: \{ librarySort: sort, librarySortDir: sortDir \} \}\)/, 'the direction is not saved with its order');
  assert.match(setParam, /\.catch\(\(\) => \{\s*setSettings\(previous\);\s*toast\(tr\('Could not save'\), 'error'\);\s*\}\)/,
    'a failed save does not restore the former default and tell the reader');
  const catchBody = /\.catch\(\(\) => \{([\s\S]*?)\}\)/.exec(setParam)?.[1] ?? '';
  assert.doesNotMatch(catchBody, /router\.(replace|push)/,
    'a failed save must retain the current view instead of navigating away from the clicked sort');
});

test('Home keeps the legacy first three nonempty Lists only until an explicit ordered setting exists', () => {
  const src = code(read('app/page.tsx'));
  assert.match(src, /const saved = user\?\.settings\?\.homeCollections;/);
  assert.match(src, /const cols = Array\.isArray\(saved\)\s*\? saved\.slice\(0, 3\)\.map\(\(id\) => all\.find\(\(c\) => c\.id === id\)\)\.filter/,
    'an explicit order is not followed or is not limited to three owned rows');
  assert.match(src, /: all\.filter\(\(c\) => Number\(c\.item_count\) > 0\)\.slice\(0, 3\)/,
    'an account with no setting lost the legacy first-three-nonempty behaviour');
  assert.match(src, /if \(!cols\.length\) return null;/,
    'an explicit empty array should mean no Home List rails');
  assert.match(src, /const items = data\?\.items \?\? \[\];\s*if \(!items\.length\) return null;/,
    'a selected empty List should retain its slot quietly until it has a series');
  assert.match(src, /items\.slice\(0, 12\)\.map/,
    'a Home List rail shows more than the public twelve-series cap');
});

test('Lists edits clean stale IDs, refuse a fourth choice, and expose ordered accessible controls', () => {
  const src = code(read('app/collections/page.tsx'));
  assert.match(src, /savedHome\.filter\(\(id\): id is string => typeof id === 'string' && items\.some\(\(c\) => c\.id === id\)\)/,
    'stale, deleted or foreign collection IDs survive the next edit');
  assert.match(src, /items\.filter\(\(c\) => Number\(c\.item_count\) > 0\)\.slice\(0, 3\)\.map\(\(c\) => c\.id\)/,
    'the editor does not mirror legacy Home before the account has a setting');
  assert.match(src, /if \(homeIds\.length >= 3\) \{\s*toast\(tr\('Choose up to 3 lists for Home'\), 'error'\);\s*return;/,
    'choosing a fourth List is not refused with an explanation');
  assert.match(src, /api\('\/api\/settings', \{ method: 'PUT', json: \{ homeCollections: next \} \}\)/,
    'the complete cleaned order is not persisted');
  assert.match(src, /homeIds\.includes\(c\.id\) \? tr\('Home \{n\}', \{ n: homeIds\.indexOf\(c\.id\) \+ 1 \}\) : tr\('Show on Home'\)/,
    'cards do not expose their translated, bidi-safe Home positions');
  assert.match(src, /aria-label=\{tr\('Move earlier'\)\}[\s\S]{0,500}aria-label=\{tr\('Move later'\)\}/,
    'the order controls are not named to assistive technology');
  assert.match(src, /onClick=\{\(\) => moveHome\(c\.id, -1\)\}[\s\S]{0,350}\{rtl \? <IcChevronRight[^:]*: <IcChevronLeft/,
    'the earlier arrow does not mirror in RTL');
  assert.match(src, /onClick=\{\(\) => moveHome\(c\.id, 1\)\}[\s\S]{0,350}\{rtl \? <IcChevronLeft[^:]*: <IcChevronRight/,
    'the later arrow does not mirror in RTL');
});
