// More of a search on one source (v0.96.0, #331): a site pages its search -- BatCave answers ten at a time, and "Star
// Trek" is 209 of them -- so a search on one source loads its next page as Discover's wall is scrolled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canSearchMore, freshCards, noMore, soloSource, SEARCH_MAX_PAGE } from '../lib/searchMore';

const card = (source: string, sourceId: string) => ({ source, sourceId, title: sourceId });

test('a search asked one source alone: the chosen one, or the only one asked', () => {
  // Reintroduce paging for every search (soloSource answering the first line): a search across several sources pages.
  assert.equal(soloSource('sw:batcave', undefined), 'sw:batcave');
  assert.equal(soloSource(null, [{ id: 'sw:batcave', state: 'ok' }]), 'sw:batcave');
  assert.equal(soloSource(null, [{ id: 'sw:batcave', state: 'ok' }, { id: 'mangadex', state: 'skipped' }]), 'sw:batcave', 'a skipped source was not asked');
  assert.equal(soloSource(null, [{ id: 'sw:batcave', state: 'ok' }, { id: 'mangadex', state: 'empty' }]), null);
  assert.equal(soloSource(null, []), null);
});

test('the next page is asked only for a search on one source that pages, under All, once everything answered', () => {
  const base = { solo: 'sw:batcave', pages: true, rating: 'all', pending: 0, firstPage: 10, more: noMore('k'), busy: false };
  assert.equal(canSearchMore(base), true);
  for (const [why, o] of [
    ['a search across several sources', { solo: null }],
    ["a source whose search has one page (a built-in's)", { pages: false }],
    ['Hide 18+ or 18+ only: the later pages are filtered by the age limit alone', { rating: 'safe' }],
    ['a source still being asked', { pending: 1 }],
    ['a first page with nothing on it', { firstPage: 0 }],
    ['the end reached', { more: { ...noMore('k'), done: true } }],
    ['a page on its way', { busy: true }],
    ['the cap', { more: { ...noMore('k'), page: SEARCH_MAX_PAGE } }],
  ] as const) assert.equal(canSearchMore({ ...base, ...o } as any), false, why);
});

test("a later page's cards are the ones not on the wall already, and a page with none ends it", () => {
  // Reintroduce appending the page whole: the cards a site repeats (or its first page again) show twice.
  const shown = [card('sw:b', '1'), card('sw:b', '2')];
  assert.deepEqual(freshCards(shown, [card('sw:b', '2'), card('sw:b', '3'), card('sw:b', '3')]).map((c) => c.sourceId), ['3']);
  assert.deepEqual(freshCards(shown, [card('sw:b', '1'), card('sw:b', '2')]), [], 'a site that ignores the page number');
});

test("Discover asks the next page of the search it is showing, through the search route's page", () => {
  // Reintroduce the request without `page`: every scroll asks the first page again, and nothing new ever lands.
  const src = readFileSync(join(__dirname, '../app/discover/page.tsx'), 'utf8');
  assert.match(src, /api<\{ content: SourceItem\[\] \}>\(`\/api\/sources\/search\?source=\$\{encodeURIComponent\(solo\)\}&q=\$\{encodeURIComponent\(term\)\}&page=\$\{next\}`\)/);
  assert.match(src, /items: moreCards\.length \? \[\.\.\.searchHits, \.\.\.moreCards\] : searchHits/, "the later pages are not on the wall");
  assert.match(src, /pages: !!sources\.find\(\(s\) => s\.id === solo\)\?\.searchPages/, 'a source that does not page is asked anyway');
});
