// Find more by an author (v0.100.0, #338): each name on a series' author line opens the Library showing every series by
// that person, and the Library holds the author as a chip of its own, beside the search.
//
// The split is held to test/fixtures/authorNames.json, which the server's twin (bff lib/authorNames.ts) reads too: the
// name a link carries is a name the server's whole-name match finds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthorLinks } from '../components/AuthorLinks';
import { authorHref, authorNames } from '../lib/authorNames';
import { setActiveLocale } from '../lib/format';
import { setActiveDict } from '../lib/i18n';

// Under tsx the components compile to the classic `React.createElement`, which they look up as a global.
(globalThis as { React?: unknown }).React = React;

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file with its comments removed, JSX ones whole: comments here quote the code they replaced. */
const code = (src: string): string => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const links = (line: string) => renderToStaticMarkup(createElement(AuthorLinks, { line }));
/** The author each link asks the Library for (next/link writes `/library/?` as `/library?`). */
const asked = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => {
  const u = new URL(m[1].replace(/&amp;/g, '&'), 'http://x');
  return `${u.pathname.replace(/\/$/, '')}|${u.searchParams.get('author')}`;
});

test('an author line splits into its names as the server splits it', () => {
  const fixtures = JSON.parse(read('test/fixtures/authorNames.json')) as Array<{ line: string; names: string[] }>;
  assert.ok(fixtures.length >= 8, 'the shared fixtures are read');
  for (const f of fixtures) assert.deepEqual(authorNames(f.line), f.names, f.line);
});

test('each name is a link to the Library showing that person, the line read in the reader\'s own words', () => {
  setActiveDict({});
  setActiveLocale('en');
  const html = links('Chugong (추공), Gi So-Ryeong (기소령), h-goon (현군)');
  // Reintroduce by linking the whole line: one link, to a name nobody's series carries alone.
  assert.deepEqual(asked(html), ['/library|Chugong (추공)', '/library|Gi So-Ryeong (기소령)', '/library|h-goon (현군)']);
  assert.match(html, /^<span[^>]*data-series-authors[^>]*>by </, 'the translation\'s words before the names');
  assert.match(html, /<bdi>Chugong \(추공\)<\/bdi><\/a>, <a/, 'joined the reader\'s way');
  assert.match(html, /, and <a[^>]*><bdi>h-goon/);
  assert.equal(authorHref('Chugong (추공)'), '/library/?author=Chugong%20(%EC%B6%94%EA%B3%B5)');
  // A computer's title block over the banner is pointer-events-none: every name must take its clicks back.
  const anchors = [...html.matchAll(/<a [^>]*>/g)].map((m) => m[0]);
  assert.ok(anchors.length === 3 && anchors.every((a) => /class="[^"]*\bpointer-events-auto\b/.test(a)), 'a name over the banner cannot be clicked');
  assert.equal(links(' - , ? '), '', 'a line of punctuation names no one');

  setActiveDict({ 'by {author}': '作：{author}' });
  setActiveLocale('ja');
  const ja = links('Chugong (추공), Gi So-Ryeong (기소령)');
  assert.match(ja, /data-series-authors[^>]*>作：<a/, 'a translation whose words come first keeps them first');
  assert.match(ja, /<\/a>、<a|<\/a>和<a|<\/a>と<a/, 'Japanese joins names its own way');
  setActiveDict({});
  setActiveLocale('en');
});

test('the series page links the author\'s names, and only the author\'s', () => {
  const page = code(read('app/series/page.tsx'));
  // Reintroduce by linking `author` (which falls back to the publisher): a publisher's name lists nothing.
  assert.match(page, /meta\?\.author \? <AuthorLinks line=\{meta\.author\} \/>/);
});

test('the Library reads the author from its address, asks the server for the whole name, and shows it as a chip', () => {
  const lib = code(read('app/library/page.tsx'));
  assert.match(lib, /const author = \(params\.get\('author'\) \|\| ''\)\.trim\(\);/);
  // Into the condition, the query key (a new author refetches from page 0) and what resets a selection.
  assert.match(lib, /conditionFrom\(read, status, genres, lib, src, anysrc, author\)/);
  assert.match(lib, /queryKey: \['library', [^\]]*\bauthor\b[^\]]*\]/);
  assert.match(lib, /anchor\.current = null; \}, \[[^\]]*\bauthor\b[^\]]*\]\);/);
  // Narrowed (an empty grid is "nothing matches") but not a filter the panel holds: not in the badge's count.
  assert.match(lib, /const narrowed = activeCount > 0 \|\| !!q \|\| !!author;/);
  assert.doesNotMatch(lib.match(/const activeCount = [^;]+;/)![0], /author/);
  assert.match(lib, /data-chip-author/);
  assert.match(lib, /setParam\('author', ''\)/);
  // The panel's own Clear all clears the panel, and leaves the author as it leaves the search.
  assert.match(lib, /if \(!alsoSearch && author\) n\.set\('author', author\);/);
});
