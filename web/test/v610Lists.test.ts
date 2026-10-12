// Smart and shared Lists on the web (v0.61.0): the Library's address as a query and back, the list's name it suggests,
// where Save as list sits and what it is, a list page's keys by whose list it is and what kind, and one query key per
// shape of answer.
//
// The condition fixtures are test/fixtures/smartQueries.json, which the server's own test (bff test/smartLists.test.ts)
// holds its port of conditionFrom to: one file read by both sides, so neither can drift alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { conditionFrom, conditionOfQuery, libraryHref, queryOfParams, sameQuery, suggestListName, type SmartQuery } from '../lib/libraryQuery';
import { homeIdsOf } from '../lib/lists';
import { ListKeys, ListTags } from '../components/ListBits';
import { setActiveLocale } from '../lib/format';
import { setActiveDict } from '../lib/i18n';

// Under tsx the components compile to the classic `React.createElement`, which they look up as a global.
(globalThis as { React?: unknown }).React = React;
setActiveLocale('en');
setActiveDict({});

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (src: string): string => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const fixtures = JSON.parse(read('test/fixtures/smartQueries.json')) as Array<{ name: string; params: string; query: SmartQuery; condition: unknown }>;

test('the Library address reads as the query the server keeps, and the query opens the same address', () => {
  // Reintroduce by keeping a `dir` the order runs anyway, or by dropping `anysrc`: a fixture's query differs.
  assert.ok(fixtures.length >= 4, 'the shared fixtures are read');
  for (const f of fixtures) {
    const q = queryOfParams(new URLSearchParams(f.params));
    assert.deepEqual(q, f.query, f.name);
    assert.deepEqual(conditionOfQuery(q) ?? null, f.condition, `${f.name}: the condition`);
    const back = queryOfParams(new URLSearchParams(libraryHref(q).split('?')[1]));
    assert.deepEqual(back, q, `${f.name}: the round trip`);
  }
  // The shelf's own order is the one saved, the account's default included; its own direction is not kept.
  assert.deepEqual(queryOfParams(new URLSearchParams('genres=Isekai'), { sort: 'popular', dir: 'desc' }), { v: 1, genres: ['Isekai'], sort: 'popular' });
  assert.deepEqual(queryOfParams(new URLSearchParams(''), { sort: 'popular', dir: 'asc' }), { v: 1, sort: 'popular', dir: 'asc' });
  assert.deepEqual(queryOfParams(new URLSearchParams('read=HALF&sort=nonsense')), { v: 1, sort: 'updated' }, 'nothing the server would refuse');
  // Edit filters carries the list it came from, and the page's filters ignore it.
  const href = libraryHref({ v: 1, sort: 'az' }, 'list-1');
  assert.match(href, /[?&]list=list-1(&|$)/);
  assert.deepEqual(queryOfParams(new URLSearchParams(href.split('?')[1])), { v: 1, sort: 'az' });
  assert.ok(sameQuery({ v: 1, sort: 'az', genres: ['A'] }, { genres: ['A'], sort: 'az', v: 1 }));
  assert.ok(!sameQuery({ v: 1, sort: 'az' }, { v: 1, sort: 'az', dir: 'desc' }));
});

test('conditionFrom builds the same tree the Library always sent', () => {
  assert.equal(conditionFrom('', '', [], ''), undefined);
  assert.deepEqual(conditionFrom('READ', '', ['A'], 'lib1', '-', 'mdx'), { allOf: [
    { libraryId: { operator: 'is', value: 'lib1' } },
    { hasMainSource: { operator: 'isFalse' } },
    { anySource: { operator: 'is', value: 'mdx' } },
    { readStatus: { operator: 'is', value: 'READ' } },
    { genre: { operator: 'is', value: 'A' } },
  ] });
});

test('a new list is named by what it narrows, else by its order', () => {
  assert.equal(suggestListName({ v: 1, q: 'solo', sort: 'updated' }), '“solo”');
  assert.equal(suggestListName({ v: 1, read: 'UNREAD', genres: ['Romance'], sort: 'az' }), 'Not started · Romance');
  assert.equal(suggestListName({ v: 1, sort: 'popular' }), 'Most popular');
  assert.equal(suggestListName({ v: 1, status: 'ONGOING', lib: 'lib_a', src: '-', sort: 'az' }, { lib: () => 'Manga' }), 'Ongoing · Manga · No source');
  assert.equal(suggestListName({ v: 1, anysrc: 'mdx', sort: 'az' }, { source: (id) => (id === 'mdx' ? 'MangaDex' : id) }), 'MangaDex');
  assert.ok(suggestListName({ v: 1, q: 'x'.repeat(300), sort: 'az' }).length <= 120, 'within the server\'s limit for a name');
});

test('Save as list is a key at the end of the active row, shown only when the shelf is narrowed, turned or ordered by the address', () => {
  // Reintroduce `chip` on it: the noPills scan names SaveListDialog.tsx; here, "Save as list is not a key" fails.
  const page = code(read('app/library/page.tsx'));
  const row = page.slice(page.indexOf('{(narrowed || reversed || validSort(urlSort)) && ('), page.indexOf('</>}', page.indexOf('{(narrowed || reversed || validSort(urlSort)) && (')));
  assert.ok(row.length > 100, 'the active row is not where this test looks');
  assert.match(row, /<SaveListKeys query=\{shownQuery\} listId=\{params\.get\('list'\) \|\| undefined\}/, 'the keys are not in the row');
  assert.ok(row.indexOf('<SaveListKeys') > row.indexOf("clearAll(true)"), 'the keys are not at its end');
  // The row's condition, evaluated: a bare shelf has no row and no key.
  const gate = /\{\((narrowed \|\| reversed \|\| validSort\(urlSort\))\) && \(/.exec(page)?.[1];
  assert.ok(gate, 'could not find the row\'s condition');
  const shows = (narrowed: boolean, reversed: boolean, urlSort: string | null) =>
    new Function('narrowed', 'reversed', 'urlSort', 'validSort', `return ${gate};`)(narrowed, reversed, urlSort, (v: unknown) => v === 'popular') as boolean;
  assert.equal(shows(false, false, null), false, 'a bare Library offers nothing to save');
  assert.equal(shows(true, false, null), true);
  assert.equal(shows(false, true, null), true);
  assert.equal(shows(false, false, 'popular'), true, 'an order from the address is a list too ("Most popular")');
  const keys = code(read('components/SaveListDialog.tsx'));
  assert.match(keys, /className="btn-key" data-save-list>\{tr\('Save as list'\)\}/, 'Save as list is not a key');
  assert.match(keys, /className="btn-key" data-update-list>/, 'Update is not a key');
  // Clear all keeps the list the shelf came from, so Update still finds it.
  assert.match(page.slice(page.indexOf('const clearAll = '), page.indexOf('\n  };', page.indexOf('const clearAll = '))),
    /if \(params\.get\('list'\)\) n\.set\('list', params\.get\('list'\)!\);/);
});

test("a list page's keys: Edit for a picked list, Edit filters for a smart one, Share for the owner, nothing for anyone else", () => {
  const keys = (list: Record<string, unknown>, hasItems = true) => renderToStaticMarkup(createElement(ListKeys, {
    list: { id: 'L1', kind: 'manual', shared: false, mine: true, ...list } as any,
    editing: false, hasItems, onEdit() {}, onShare() {}, busy: false,
  }));
  const picked = keys({});
  assert.match(picked, /data-list-edit[^>]*class="btn-key ?"|class="btn-key ?"[^>]*data-list-edit/, 'Edit is not a key');
  assert.doesNotMatch(picked, /data-list-filters/);
  assert.match(picked, />Share</);
  // Reintroduce Edit on a smart list: it would offer to remove what its search found back.
  const smart = keys({ kind: 'smart', query: { v: 1, genres: ['Romance'], sort: 'az' } });
  assert.doesNotMatch(smart, /data-list-edit/, 'a smart list has no Edit');
  assert.match(smart, /href="\/library\?genres=Romance&amp;sort=az&amp;list=L1"[^>]*data-list-filters|data-list-filters[^>]*href="\/library\?genres=Romance&amp;sort=az&amp;list=L1"/, 'Edit filters does not open its search');
  assert.match(keys({ shared: true }), />Stop sharing</);
  assert.equal(keys({ mine: false, shared: true }), '', "someone else's list is read-only");
  assert.doesNotMatch(keys({}, false), /data-list-edit/, 'nothing to edit in an empty picked list');
  // Tags: squared, and "Shared" only to the owner (anyone else is told whose it is).
  const tags = renderToStaticMarkup(createElement(ListTags, { list: { kind: 'smart', shared: true, mine: true } }));
  assert.match(tags, />Live list</);
  assert.match(tags, />Shared</);
  assert.match(tags, /rounded-\[4px\]/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(ListTags, { list: { kind: 'manual', shared: true, mine: false } })), /Shared/);
  // The page hands its keys the list, and they decide; Edit is no longer a chip there.
  const page = code(read('app/collection/page.tsx'));
  assert.match(page, /<ListKeys list=\{data\} editing=\{editing\} hasItems=\{items\.length > 0\}/);
  assert.doesNotMatch(page, /data-list-edit/, 'a second Edit on the page');
});

test("Home's lists: the account's choice, else the reader's own first three with something in them", () => {
  const lists = [
    { id: 'a', item_count: 0, mine: true }, { id: 'b', item_count: 2, mine: true }, { id: 's', item_count: 9, mine: false },
    { id: 'c', item_count: 1 }, { id: 'd', item_count: 4, mine: true }, { id: 'e', item_count: 5, mine: true },
  ];
  // Reintroduce by letting a shared list fill a legacy slot: 's' appears here, on a Home nobody chose it for.
  assert.deepEqual(homeIdsOf(undefined, lists), ['b', 'c', 'd']);
  assert.deepEqual(homeIdsOf(['s', 'gone', 'a'], lists), ['s', 'a'], 'a chosen shared list keeps its slot; a stale id is dropped');
  assert.deepEqual(homeIdsOf([], lists), []);
});

/** Every `queryKey: [...]` with the `/api/...` its own queryFn asks, in app/, components/ and lib/. */
function keyedCalls(): Array<{ key: string; call: string; where: string }> {
  const out: Array<{ key: string; call: string; where: string }> = [];
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const f = join(dir, n);
    return statSync(f).isDirectory() ? walk(f) : /\.tsx?$/.test(n) ? [f] : [];
  });
  for (const f of ['app', 'components', 'lib'].flatMap((d) => walk(join(ROOT, d)))) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((l, i) => {
      const k = /queryKey:\s*(\[[^\]]*\])/.exec(l);
      if (!k || /invalidateQueries|setQueryData/.test(l)) return;
      const near = lines.slice(i, i + 3).join(' ');
      const call = /['"`](\/api\/collections[^'"`]*)/.exec(near)?.[1];
      if (call) out.push({ key: k[1], call, where: `${f.slice(ROOT.length + 1)}:${i + 1}` });
    });
  }
  return out;
}

test('one query key per shape: every list, the plain answer, a list, and a rail of one', () => {
  // ['collections'] is the plain answer (the reader's own picked lists) the series page's sheet reads; ?scope=all is a
  // different shape and has its own key. Reintroduce ['collections'] on a ?scope=all call: whichever page loads first
  // would hand the other its shape. And a rail's twelve under the list page's key would show a list cut short.
  const calls = keyedCalls();
  assert.ok(calls.length >= 5, `the scan found the list calls (${calls.length})`);
  for (const c of calls) {
    if (c.call.includes('scope=all')) assert.equal(c.key, "['lists-all']", c.where);
    if (c.key === "['lists-all']") assert.match(c.call, /\?scope=all$/, c.where);
    if (c.key === "['collections']") assert.equal(c.call, '/api/collections', c.where);
    if (c.call.includes('limit=')) assert.match(c.key, /'rail'\]$/, c.where);
  }
  assert.ok(calls.some((c) => c.where.startsWith('app/series/page.tsx') && c.key === "['collections']"), 'the Add to collection sheet reads the plain answer');
  for (const f of ['app/page.tsx', 'app/collections/page.tsx', 'components/ProfileYou.tsx']) {
    assert.ok(calls.some((c) => c.where.startsWith(f) && c.key === "['lists-all']")
      || code(read(f)).includes('useListsAll('), `${f} does not read every list`);
  }
});
