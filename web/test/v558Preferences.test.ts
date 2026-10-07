// v0.55.8 account preferences that change navigation rather than data: the Library's default order and the
// zero-to-three Lists shown on Home. These decisions live in page components, so this test pins the source contract
// the same way libraryView.test.ts does; browser walks cover the rendered controls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  assert.match(src, /api<Page<Series>>\('\/api\/series\/search', \{ json: \{ page: pageParam, size: 40, sort: active\.sort, condition/,
    'the resolved sort does not control the series query');
});

test('only a direct sort click saves the default, without undoing the current URL on failure', () => {
  const page = code(read('app/library/page.tsx'));
  const filters = code(read('components/LibraryFilters.tsx'));
  const start = page.indexOf('const setParam = ');
  const end = page.indexOf('const clearAll = ', start);
  assert.ok(start >= 0 && end > start, 'setParam is where the test expects it');
  const setParam = page.slice(start, end);

  assert.match(filters, /onClick=\{\(\) => onSet\('sort', s\.key\)\}/, 'sort controls no longer identify an explicit sort click');
  assert.match(setParam, /router\.replace\(`\/library\?\$\{next\.toString\(\)\}`\);\s*if \(k === 'sort' && validSort\(v\)\)/,
    'the URL must update first and non-sort controls must not save a default');
  assert.equal((page.match(/api\('\/api\/settings'/g) ?? []).length, 1,
    'a URL read/effect appears to save librarySort, or the click saves it twice');
  assert.match(setParam, /const previous = user\?\.settings\?\.librarySort;\s*setSettings\(\{ librarySort: v \}\);/,
    'the click is not applied optimistically to the account');
  assert.match(setParam, /\.catch\(\(\) => \{\s*setSettings\(\{ librarySort: previous \}\);\s*toast\(tr\('Could not save'\), 'error'\);\s*\}\)/,
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
  assert.match(src, /homeIds\.includes\(c\.id\) \? `\$\{tr\('Home'\)\} \$\{homeIds\.indexOf\(c\.id\) \+ 1\}` : tr\('Show on Home'\)/,
    'cards do not expose their Home positions');
  assert.match(src, /aria-label=\{tr\('Move earlier'\)\}[\s\S]{0,500}aria-label=\{tr\('Move later'\)\}/,
    'the order controls are not named to assistive technology');
  assert.match(src, /onClick=\{\(\) => moveHome\(c\.id, -1\)\}[\s\S]{0,350}\{rtl \? <IcChevronRight[^:]*: <IcChevronLeft/,
    'the earlier arrow does not mirror in RTL');
  assert.match(src, /onClick=\{\(\) => moveHome\(c\.id, 1\)\}[\s\S]{0,350}\{rtl \? <IcChevronLeft[^:]*: <IcChevronRight/,
    'the later arrow does not mirror in RTL');
});
