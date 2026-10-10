// v0.58.0 on Discover: every source asked, and a card at the wall's end naming who is still loading.
//
// The owner has 29 sources and wanted all of them on the wall. It asked the best six, widening to ten as sources
// answered with nothing, out of a ranked list capped at twelve. Now the wall asks every source in the pool, best first,
// through the same gate -- four asking at once, each answer releasing the next -- so the burst does not grow and the wall
// just keeps filling, in Newest and Popular alike. Filling for longer, its end had to say more was coming: while a
// source asked has not answered, the last tile is a card the size of a series card naming them ("Still loading", three
// names, "+N"), in browsing and in a search. The gate's arithmetic and the card run here; the page's wiring is read
// from source, as sourcePicker.test.ts and discoverSearch.test.ts read theirs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StillLoadingCard } from '../components/cards';
import { SourceListSheet } from '../components/SourceListSheet';
import { answeredPage, budgetForMode, WALL_IN_FLIGHT, type Src, type SrcState } from '../lib/sourceGroups';
import { setActiveDict } from '../lib/i18n';
import { setActiveLocale } from '../lib/format';

// Under tsx the components compile to the classic `React.createElement`, which they look up as a global.
(globalThis as { React?: unknown }).React = React;
setActiveLocale('en');

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file with its comments removed, JSX ones whole: comments here quote the code they replaced. */
const code = (src: string): string => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const PAGE = 'app/discover/page.tsx';
const src = (p: Partial<Src> & { id: string }): Src => ({ name: p.id, lang: null, latest: true, status: 'ok', ...p }) as Src;
/** The owner's install, in size: 29 sources, two in three able to rank their own titles, the most used first. */
const OWNERS = Array.from({ length: 29 }, (_, i) => src({ id: `s${i}`, name: `Source ${i}`, popular: i % 3 !== 0, used: 29 - i }));

test('the wall asks every source in the pool, best first, in Newest and Popular alike', () => {
  // Reintroduce a cap (`pool.slice(0, 12)`, or the old `Math.min(ranked.length, 10, 6 + emptied)`): "the wall asks a
  // slice of the pool" fails -- and 19 of the owner's 29 sources are never on his wall, as before.
  const page = code(read(PAGE));
  assert.match(page, /const pool = useMemo\(\(\) => budgetForMode\(sources, listMode, Infinity\), \[sources, listMode\]\);/);
  assert.match(page, /const budget = pool;/, 'the wall asks a slice of the pool');
  assert.doesNotMatch(page, /pool\.slice\(|\branked\b|6 \+ emptied|emptiedCount/, 'a cap on the sources asked is back');
  assert.match(page, /\{mode === 'newest' && budget\.map\(\(s, i\) => \(\s*<SourceLatest key=\{`\$\{listMode\}:\$\{s\.id\}:\$\{page\}`\} source=\{s\} listMode=\{listMode\}\s*page=\{page\} enabled=\{i < gate\} onSettled=\{onSettled\} \/>/,
    'not every source asked has its request');
  // The pool: all 29 for Newest, every one that can rank its own titles for Popular, the most used first.
  const newest = budgetForMode(OWNERS, 'newest', Infinity);
  assert.equal(newest.length, 29);
  assert.deepEqual(newest.slice(0, 3).map((s) => s.id), ['s0', 's1', 's2'], 'not best first');
  assert.deepEqual(budgetForMode(OWNERS, 'popular', Infinity).map((s) => s.id), OWNERS.filter((s) => s.popular).map((s) => s.id));
  // The hero's add does NOT follow: /api/sources/find asks every source it is given at once, with no gate, so it keeps
  // the ten best-ranked -- the most the wall asked before. Reintroduce `budget.map(...)`: a hero tap on the owner's
  // install would be 29 simultaneous searches, most of them through the solver.
  assert.match(page, /const budgetIds = useMemo\(\(\) => budget\.slice\(0, HERO_FIND_SOURCES\)\.map\(\(s\) => s\.id\), \[budget\]\);/,
    'the hero\'s lookup fans out to every source at once');
  assert.match(page, /const HERO_FIND_SOURCES = 10;/);
  assert.match(page, /<AddSeriesDialog\s+seed=\{seed\}\s+sources=\{budgetIds\}/);
});

test('the burst does not grow: four sources asking at once, on every page, and a page waits for the last', () => {
  // The gate, run: 29 sources, each enabled while its index is under the gate, one answering at a time. Counted by the
  // page being fetched -- the gate used to count the sources that had ever answered, which from page 2 on is every one,
  // so page 2 asked all of them at once. Reintroduce that count: "page 2 asked 29 at once" fails.
  const keys = OWNERS.map((s) => `newest:${s.id}`);
  const upTo: Record<string, number> = {};
  for (const page of [1, 2, 3]) {
    let peak = 0;
    for (let step = 0; step <= keys.length; step++) {
      const gate = WALL_IN_FLIGHT + answeredPage(keys, upTo, page);
      const asking = keys.filter((k, i) => i < gate && (upTo[k] ?? 0) < page);
      peak = Math.max(peak, asking.length);
      if (!asking.length) break;
      // Whichever is asked answers; the slowest first is the hardest case for the gate, and order is not its business.
      upTo[asking[asking.length - 1]] = page;
    }
    assert.equal(peak, WALL_IN_FLIGHT, `page ${page} asked ${peak} at once`);
    assert.equal(answeredPage(keys, upTo, page), 29, `page ${page} did not ask every source`);
  }
  assert.equal(WALL_IN_FLIGHT, 4, 'the gate is not the four it has always been');
  // The page runs exactly that: each settle records its page; the gate and the next page count by it.
  const page = code(read(PAGE));
  assert.match(page, /setUpTo\(\(prev\) => \(\(prev\[id\] \?\? 0\) >= at \? prev : \{ \.\.\.prev, \[id\]: at \}\)\);/, 'a settle does not record the page it answered');
  assert.match(page, /const answered = answeredPage\(budget\.map\(\(s\) => kOf\(s\.id\)\), upTo, page\);\s*const gate = WALL_IN_FLIGHT \+ answered;/,
    'the gate does not count the page being fetched');
  assert.match(page, /const canPage = mode === 'newest' && answered >= budget\.length && budget\.length > 0 && page < 5;/,
    'a page starts while the last one is still being asked: the sources the gate had not reached are skipped');
  assert.match(code(read('components/SourcePicker.tsx')),
    /if \(isSuccess\) onSettled\(key, data\?\.content \?\? \[\], true, page\);\s*else if \(isError\) onSettled\(key, \[\], false, page\);/,
    'a source does not say which page it answered');
});

test('the picker and its sheet list every source, and the footer says every one is asked', () => {
  // Reintroduce `sources.slice(0, 12)` in SourcePicker: "the picker lists a slice" fails, and the sheet's rows stop at 12.
  const picker = code(read('components/SourcePicker.tsx'));
  assert.doesNotMatch(picker, /\.slice\(0, 1[0-2]\)/, 'the picker lists a slice');
  assert.match(picker, /<SourceListSheet sources=\{sources\} total=\{count\}/);
  const sheet = (rows: Src[], total: number) => renderToStaticMarkup(createElement(SourceListSheet, {
    sources: rows, total, stateOf: (): SrcState => 'idle', selected: null, onSelect: () => {}, onExplain: () => {}, onClose: () => {},
  }));
  const all = sheet(OWNERS, 29);
  for (const s of OWNERS) assert.ok(all.includes(`>${s.name}</span>`), `${s.name} is not in the sheet`);
  assert.match(all, /Asking every source · tap one to browse it alone/, 'the footer does not say every source is asked');
  assert.doesNotMatch(all, /Asking 29 of 29/, '"Asking 29 of 29" is a puzzle, not a fact');
  // Should the rows ever be fewer than the pool, the footer still reconciles the two numbers.
  assert.match(sheet(OWNERS.slice(0, 9), 29), /Asking 9 of 29 · tap a source to browse it alone/);
});

test('the still-loading card: a series card\'s size, three names, the rest counted left to right', () => {
  // Reintroduce every name (`names.map`): a 29-source wall's last card is a column of 26 names longer than a cover --
  // "more names than shown" fails; drop the `<bdi dir="ltr">`: "+26" reads "26+" in Arabic.
  const card = (names: string[]) => renderToStaticMarkup(createElement(StillLoadingCard, { names, shown: 3 }));
  const five = card(['Mangakakalot', 'Natomanga', 'Weeb Central', 'Asura Scans', 'Bato']);
  assert.match(five, /data-still-loading="5"/);
  assert.match(five, /class="[^"]*\baspect-\[2\/3\][^"]*"/, 'not a series card\'s size');
  assert.match(five, />Still loading</);
  assert.match(five, />Mangakakalot<\/li><li[^>]*>Natomanga<\/li><li[^>]*>Weeb Central<\/li>/);
  assert.doesNotMatch(five, /Asura Scans|Bato/, 'more names than shown');
  assert.match(five, /<bdi dir="ltr">\+2<\/bdi>/, 'the rest are not counted, or not left to right');
  assert.match(five, /data-ring="(spin|still)"/, 'no spinner');
  const three = card(['A', 'B', 'C']);
  assert.doesNotMatch(three, /\+\d/, 'a "+0" under three names');
  setActiveDict({ 'Still loading': 'Lädt noch' });
  try { assert.match(card(['A']), />Lädt noch</, 'the card is English in every language'); } finally { setActiveDict({}); }
});

test('the wall ends on the card while anyone asked has not answered, and skeletons only hold an empty wall', () => {
  // Who: browsing, the sources asked for the page being fetched that have not answered it -- just the one browsed alone
  // when one is; a search, the ones its latest answer says are pending. Reintroduce the card before the skeletons, or
  // anywhere but last in the grid: "the card is not the wall's last tile" fails. Reintroduce skeletons beside cards:
  // with every source asked, eighteen of them sat under the covers for as long as the slowest source took.
  const page = code(read(PAGE));
  assert.match(page, /if \(mode === 'search'\) return \(searchQ\.data\?\.sources \?\? \[\]\)\.filter\(\(s\) => s\.state === 'pending'\)\.map\(\(s\) => s\.name\);/,
    'a search\'s card does not name the sources its answer says are pending');
  assert.match(page, /return budget\.filter\(\(s\) => \(!selected \|\| s\.id === selected\) && \(upTo\[kOf\(s\.id\)\] \?\? 0\) < page\)\.map\(\(s\) => s\.name\);/,
    'the wall\'s card does not name the sources yet to answer this page');
  assert.match(page, /\{!wall\.items\.length && Array\.from\(\{ length: Math\.min\(18, pending \* 6\) \}\)\.map\(\(_, i\) => \(/,
    'skeletons sit beside real tiles while the last sources load');
  assert.match(page, /<div key=\{`sk\$\{i\}`\} className="skeleton aspect-\[2\/3\] rounded-2xl" \/>\s*\)\)\}\s*\{waitingOn\.length > 0 && <StillLoadingCard names=\{waitingOn\} shown=\{SEARCH_NAMES_SHOWN\} \/>\}\s*<\/div>/,
    'the card is not the wall\'s last tile');
  assert.equal((page.match(/<StillLoadingCard\b/g) ?? []).length, 1, 'one card, for every mode');
});

test('the two new strings are in all eight languages', () => {
  const dir = join(ROOT, 'public/locales');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 8);
  for (const f of files) {
    const d = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, string>;
    for (const k of ['Still loading', 'Asking every source · tap one to browse it alone']) {
      assert.ok(typeof d[k] === 'string' && d[k].trim(), `${f} has no "${k}"`);
    }
  }
});
