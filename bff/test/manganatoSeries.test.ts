// A Manganato-family series page's genres: its own, not the site's whole genre menu (v0.55.5).
//
// Natomanga's series pages carry the site's genre menu in a sidebar (div.panel-category: "All, Completed, Ongoing,
// Action, Adaptation, Adult, ..." 59 links) beside the series' own genres, which the page lists twice: the info panel's
// "Genres" row and a genre box. The engine read every genre link on the page, and twelve series on the owner's library
// held all 69 genres, Hentai and Smut among them. The markup below is the live page's (natomanga.com, 2026-10-06),
// trimmed to the three blocks and a menu cut to the genres that matter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeManganato, seriesGenres } from '../src/lib/sources/engines/manganato';

const BASE = 'https://example.test';
const SLUG = 'a-series';
const cfg = { id: 'test-nato', name: 'Test Nato', base: BASE };

const OWN: Array<[string, string]> = [
  ['comedy', 'Comedy'], ['drama', 'Drama'], ['fantasy', 'Fantasy'], ['action', 'Action'], ['adventure', 'Adventure'],
  ['slice-of-life', 'Slice of life'], ['martial-arts', 'Martial arts'], ['demons', 'Demons'],
];
const MENU = ['Action', 'Adaptation', 'Adult', 'Adventure', 'Comedy', 'Ecchi', 'Erotica', 'Hentai', 'Manga', 'Manhua', 'Manhwa',
  'Mature', 'Smut', 'Webtoons', 'Yaoi', 'Yuri'];
const link = ([slug, name]: [string, string]) => `<a href="${BASE}/genre/${slug}">\n    ${name}\n  </a>`;

const genreBox = `<div class="genres-wrap">\n  <h4>Genres</h4>\n  <div class="genre-list">\n${OWN.map(link).join('\n')}\n  </div>\n</div>`;
const infoPanel = `<div class="manga-info-content">\n<ul class="manga-info-text">\n  <li>\n    <h1>Return of the War God</h1>\n  </li>\n`
  + '  <li>Author(s) : Myosu (묘수) </li>\n  <li>Status : Ongoing</li>\n'
  + `  <li class="genres">Genres : ${OWN.map(link).join(', ')} </li>\n</ul>\n</div>`;
const menu = '<div class="panel-category">\n<h3 class="panel-category-title">GENRES</h3>\n<table><tbody>\n<tr class="bordertop">'
  + `<td><a rel="nofollow" class="ctg-select" href="${BASE}/genre/all?type=latest&amp;state=all&amp;page=1">All</a></td>`
  + `<td><a rel="nofollow" class="" href="${BASE}/genre/all?type=latest&amp;state=completed&amp;page=1">Completed</a></td>`
  + `<td><a rel="nofollow" class="" href="${BASE}/genre/all?type=latest&amp;state=ongoing&amp;page=1">Ongoing</a></td></tr>\n`
  + MENU.map((n) => `<tr><td><a rel="nofollow" class="" href="${BASE}/genre/${n.toLowerCase()}?type=latest">${n}</a></td></tr>`).join('\n')
  + '\n</tbody></table>\n</div>';
const page = (...blocks: string[]) => '<html><head><title>Return of the War God</title></head><body>'
  + `<a href="${BASE}/manga/${SLUG}/chapter-1" rel="nofollow">Start Reading</a>\n${blocks.join('\n')}</body></html>`;

/** Stubs the FlareSolverr HTTP boundary, which is the only place these adapters touch the network. */
function stubSolver(body: string) {
  globalThis.fetch = (async (_u: any, init: any) => {
    const { url } = JSON.parse(init.body);
    return new Response(JSON.stringify({ status: 'ok', solution: { url, status: 200, response: body, cookies: [], userAgent: 'test' } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
}

const names = OWN.map(([, n]) => n);

test("a series page's own genres, not the site's menu", async () => {
  // Reintroduce the page-wide read (every /genre/ link): the series reads its genres twice, then All, Completed and
  // Ongoing, then Adult, Hentai and Smut.
  stubSolver(page(genreBox, infoPanel, menu));
  const s = await makeManganato(cfg).getSeries(SLUG);
  assert.deepEqual(s.genres, names);
  assert.equal(s.title, 'Return of the War God', 'PREMISE: the series page was read');
});

test('the genre box when the info panel has no Genres row, and an older page by its Genres cell', () => {
  assert.deepEqual(seriesGenres(page(genreBox, menu)), names);
  const older = '<table class="variations-tableInfo"><tbody><tr><td class="table-label"><i class="info-genres"></i>Genres :</td>'
    + '<td class="table-value"><a class="a-h" href="https://manganato.com/genre-2">Action</a> - '
    + '<a class="a-h" href="https://manganato.com/genre-4">Comedy</a></td></tr></tbody></table>';
  assert.deepEqual(seriesGenres(page(older, menu)), ['Action', 'Comedy']);
});

test('a page whose own genres none of the blocks hold has none, never the menu', () => {
  assert.deepEqual(seriesGenres(page(menu)), []);
  // A listing card's class is not the Genres row's: `genres-item` is not `genres`.
  assert.deepEqual(seriesGenres(page(`<li class="genres-item"><a href="${BASE}/genre/yaoi">Yaoi</a></li>`, infoPanel, menu)), names);
});
