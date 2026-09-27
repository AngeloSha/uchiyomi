// The Library page's Series | Downloads switch (v0.49.0): which view an address names, and that the page
// follows it. The view is read from the URL on every render and written through the page's one setParam, so
// Back, deep links and the desktop header button all land where they say.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { downloadsHref, readView } from '../lib/libraryView';

const ROOT = join(__dirname, '..');
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const page = () => code(readFileSync(join(ROOT, 'app/library/page.tsx'), 'utf8'));

test('?view=downloads is the Downloads view only for a viewer who may download', () => {
  // The route behind the view answers 403 to anyone else. Reintroduce by returning the raw param from
  // readView: "a member who may not download gets the Downloads view" fails.
  assert.equal(readView('downloads', true), 'downloads');
  assert.equal(readView('downloads', false), 'series', 'a member who may not download gets the Downloads view');
  assert.equal(readView('junk', true), 'series');
  assert.equal(readView(null, true), 'series');
  assert.equal(downloadsHref(), '/library/?view=downloads');
  assert.equal(downloadsHref('Asura/Solo Leveling'), '/library/?view=downloads&folder=Asura%2FSolo%20Leveling');
});

test('the page follows the URL on every render and switches through its one setParam', () => {
  // useTabParam reads the URL once; a link to ?view=downloads while already on /library does not remount the
  // page, so a value read once would not follow it. Reintroduce the switch as `history.pushState(...)`: the
  // count of URL writers holds (library.test.ts) and "the switch writes through setParam" fails.
  const src = page();
  assert.match(src, /const view: LibraryView = readView\(params\.get\('view'\), mayDownload\);/, 'the view is not read from the URL on every render');
  assert.match(src, /const mayDownload = authStatus === 'authed' && canDownload\(user\);/, 'the switch is not gated on the download permission');
  assert.match(src, /<ViewSwitch view=\{view\} onView=\{\(v\) => setParam\('view', v === 'series' \? '' : v\)\} \/>/, 'the switch writes through setParam');
  assert.match(src, /\{mayDownload && <ViewSwitch /, 'the switch shows to a viewer who may not download');
  assert.doesNotMatch(src, /pushState/, 'a switch adds a history entry');
  assert.match(src, /role="tablist"/);
  assert.match(src, /role="tab" aria-selected=\{on\}/);
});

test('the Downloads view fetches no grid and shows none of the series controls', () => {
  // Reintroduce by dropping `enabled: view === 'series'`: forty covers are fetched to sit unseen behind the view.
  const src = page();
  assert.match(src, /queryKey: \['library', [^\]]*\],\s*enabled: view === 'series',/, 'the grid is fetched in the Downloads view');
  assert.match(src, /\{series && <aside /, 'the filter sidebar shows beside the Downloads view');
  assert.match(src, /\{series && selecting && picked\.size > 0 && \(/, 'the select bar can show over the Downloads view');
  assert.match(src, /\{series && <>\s*<div data-library-grid/, 'the grid renders in the Downloads view');
  assert.match(src, /\{!series && <ServerDownloadsView focusFolder=\{params\.get\('folder'\)\} \/>\}/, 'the Downloads view is not the view');
  assert.match(src, /onRefresh=\{series \? onRefresh : \(\) => kickDownloads\(qc\)\}/, 'pull to refresh in Downloads rescans the library instead of asking for the jobs');
  // The selection belongs to the grid it was made in.
  assert.match(src, /\[read, status, genres\.join\(','\), sortKey, lib, view\]\);/, 'a selection outlives a switch to Downloads');
});

test('the underline slides only when motion is welcome', () => {
  // Reintroduce with a plain spring: "the underline slides under Reduce effects" fails.
  const src = page();
  const sw = src.slice(src.indexOf('function ViewSwitch('), src.indexOf('function MoveToLibrary('));
  assert.match(sw, /const plain = useReduceEffects\(\);\s*const still = useReducedMotion\(\);/);
  assert.match(sw, /layoutId="libview"/);
  assert.match(sw, /transition=\{plain \|\| still \? \{ duration: 0 \} : \{ type: 'spring'/, 'the underline slides under Reduce effects');
});
