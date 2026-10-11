// The series page's ratings, said once (v0.60.0): components/RatingsPanel.tsx and what decides for it, lib/ratings.ts.
//
// AniList's score and the reader's own stars were said up to three times on one page (a chip over the banner, the meta
// line, a line under the stars). Now one panel: AniList's tile -- a big score over "/ 100", a thin meter, how many
// readers list it, the whole tile a link to the entry -- and the reader's five stars, of which the current one, tapped
// again, takes the rating back through `DELETE /api/ratings/:seriesId` (the web never called it before). What decides is
// run as functions, the panel is rendered statically, and the wiring a static render cannot reach is read from source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { anilistTile, anilistTileName, nextRating, ratingRequest, readersText } from '../lib/ratings';
import { RatingsPanel } from '../components/RatingsPanel';
import { compactText, setActiveLocale } from '../lib/format';
import { setActiveDict } from '../lib/i18n';
import type { AniListNumbers } from '../lib/types';

// Under tsx the components compile to the classic `React.createElement`, which they look up as a global.
(globalThis as { React?: unknown }).React = React;
setActiveLocale('en');
setActiveDict({});

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (src: string): string => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
/** What a reader sees: the isolates around a count are invisible. */
const seen = (s: string) => s.replace(/[⁦-⁩]/g, '');
const dict = (lang: string) => {
  const { _meta, ...d } = JSON.parse(read(`public/locales/${lang}.json`)) as Record<string, string>;
  return d;
};
const inLanguage = (lang: string, fn: () => void) => {
  setActiveDict(dict(lang));
  setActiveLocale(lang);
  try { fn(); } finally { setActiveDict({}); setActiveLocale('en'); }
};

const LINKED: AniListNumbers = { id: '21', score: 83.6, popularity: 312_071 };
const panel = (anilist: AniListNumbers | null | undefined, rating: number | null) =>
  renderToStaticMarkup(createElement(RatingsPanel, { anilist, rating, onRate: () => {} }));

test('a tap on your current star takes the rating back; on any other, that many stars', () => {
  // Reintroduce the old rule (every tap sets the stars, `(current, tapped) => tapped`): the rating could never be
  // cleared, and "tapping 4 again clears it" fails.
  assert.equal(nextRating(4, 4), null, 'tapping 4 again clears it');
  assert.equal(nextRating(4, 2), 2);
  assert.equal(nextRating(null, 3), 3);
  assert.equal(nextRating(undefined, 5), 5);
  assert.equal(nextRating(1, 1), null);
});

test('clearing is the DELETE route; rating is the PUT with the stars', () => {
  // personal.ts: PUT /api/ratings/:seriesId {stars} and DELETE /api/ratings/:seriesId. Reintroduce a PUT for a clear
  // (`{ stars: 0 }`, which the route refuses): "a clear is not a DELETE" fails.
  assert.deepEqual(ratingRequest('s1', null), { path: '/api/ratings/s1', init: { method: 'DELETE' } }, 'a clear is not a DELETE');
  assert.deepEqual(ratingRequest('s1', 4), { path: '/api/ratings/s1', init: { method: 'PUT', json: { stars: 4 } } });
  assert.equal(ratingRequest('a/b', 2).path, '/api/ratings/a%2Fb', 'the id is a path segment');
});

test('the page rates through the panel\'s hook, which clears, rolls back and says so', () => {
  // Until v0.60.0 `setStars` swallowed every failure (`catch {}`) and the stars lied. Reintroduce a tap that always
  // PUTs (`ratingRequest(seriesId, tapped)`): "the tap does not go through nextRating" fails.
  const src = code(read('components/RatingsPanel.tsx'));
  const hook = src.slice(src.indexOf('export function useSeriesRating('), src.indexOf('const TILE'));
  assert.match(hook, /const before = qc\.getQueryData<Series>\(key\)\?\.yomi\?\.rating \?\? null;\s*const next = nextRating\(before, tapped\);/, 'the tap does not go through nextRating');
  assert.match(hook, /const \{ path, init \} = ratingRequest\(seriesId, next\);/);
  assert.match(hook, /await api\(path, init\);/);
  assert.match(hook, /for \(const k of \[\['library'\], \['home'\]\]\) qc\.invalidateQueries\(\{ queryKey: k \}\);/, 'the Library and Home keep the old rating');
  assert.match(hook, /catch \{\s*if \(ticket\.current === mine\) put\(before\);\s*toast\(tr\('Could not save your rating'\), 'error'\);/, 'a refusal is swallowed again');
  // The star the tap lands on is the one handed over: a star is a button that rates by its own number.
  assert.match(src, /onClick=\{\(\) => \{ setPreview\(null\); onRate\(n\); \}\}/);
  const page = code(read('app/series/page.tsx'));
  assert.match(page, /const rate = useSeriesRating\(id\);/);
  assert.match(page, /const rating = series\?\.yomi\?\.rating \?\? null;/, 'the page keeps a second copy of the rating');
  assert.doesNotMatch(page, /\/api\/ratings\//, 'the page rates by itself again, beside the panel');
});

test('five stars, each a button that says what it does, the current one pressed', () => {
  const html = panel(null, 4);
  const stars = [...html.matchAll(/<button type="button" aria-label="Rate (\d) of 5" aria-pressed="(true|false)"/g)].map((m) => [Number(m[1]), m[2]]);
  assert.deepEqual(stars, [[1, 'false'], [2, 'false'], [3, 'false'], [4, 'true'], [5, 'false']]);
  // Four drawn filled.
  assert.equal((html.match(/<svg[^>]*fill="currentColor"[^>]*>(?:(?!<\/svg>).)*m12 3 2\.6/g) ?? []).length, 4, 'not four filled stars');
  assert.match(html, /role="group" aria-labelledby="[^"]+"/, 'the stars are not one labelled group');
  assert.match(html, /Your rating/);
  assert.match(html, /Tap again to clear/, 'a rated series does not say how to take it back');
  assert.match(panel(null, null), /Rate this/);
  assert.doesNotMatch(panel(null, null), /aria-pressed="true"/);
});

test('AniList\'s tile: the score over "/ 100", the meter, the readers, and the entry on AniList', () => {
  const html = panel(LINKED, null);
  assert.match(html, /<a href="https:\/\/anilist\.co\/manga\/21" target="_blank" rel="noopener noreferrer" aria-label="84% on AniList · ⁨[^"]+⁩ readers" title="Average score on AniList, and how many people there have it on a list" data-anilist-tile="true"/,
    'the tile is not a named link to the entry, opened in a new tab');
  assert.match(html, /<span dir="ltr"[^>]*><span[^>]*>84<\/span><span[^>]*>\/ 100<\/span><\/span>/, 'the score does not read "84 / 100" left to right');
  assert.match(html, /style="width:84%;[^"]*"/, 'the meter is not filled to the score');
  assert.match(seen(html), /312K readers/);
  // Never a ring: a ring is work in progress everywhere else in the app.
  assert.doesNotMatch(html, /data-ring|-rotate-90/, 'the score is drawn as a ring');
  // Both tiles side by side.
  assert.match(html, /data-ratings-panel="true" class="grid gap-2 grid-cols-2/);
});

test('no checked AniList link: no tile, and the reader\'s own takes the row', () => {
  // Reintroduce a tile for a series with nothing from AniList: "an empty AniList tile" fails.
  for (const none of [null, undefined, { score: null, popularity: null }, { id: '21', score: null, popularity: 0 }] as const) {
    const html = panel(none as AniListNumbers | null | undefined, 2);
    assert.doesNotMatch(html, /data-anilist-tile/, `an empty AniList tile for ${JSON.stringify(none)}`);
    assert.match(html, /class="grid gap-2 grid-cols-1/, 'the reader\'s tile is half a grid beside an empty cell');
    assert.match(html, /data-your-rating="2" class="[^"]*flex-row items-center justify-between/, 'alone, the reader\'s tile is not one row');
  }
  // An older server (no id): the tile, not linked.
  const unlinked = panel({ score: 70, popularity: 500_000 }, null);
  assert.match(unlinked, /<div role="group" aria-label="70% on AniList · [^"]+" title="[^"]+" data-anilist-tile="true"/);
  assert.doesNotMatch(unlinked, /anilist\.co/);
});

test('the tile\'s numbers, made safe to draw', () => {
  assert.deepEqual(anilistTile(LINKED), { score: 84, popularity: 312_071, url: 'https://anilist.co/manga/21' });
  assert.equal(anilistTile({ id: 'not-an-id', score: 50, popularity: null })?.url, null, 'an id that is not AniList\'s is linked');
  assert.equal(anilistTile({ id: 21 as unknown as string, score: 50, popularity: null })?.url, 'https://anilist.co/manga/21');
  assert.equal(anilistTile({ score: 140, popularity: -3 })?.score, 100);
  assert.equal(anilistTile({ score: Number.NaN, popularity: 'x' as unknown as number }), null);
  assert.deepEqual(anilistTile({ score: null, popularity: 950 }), { score: null, popularity: 950, url: null });
  // Said: the score as the app says it elsewhere, and the readers -- or, with no score, the count on AniList.
  assert.equal(seen(anilistTileName(anilistTile(LINKED)!)), '84% on AniList · 312K readers');
  assert.equal(seen(anilistTileName(anilistTile({ score: null, popularity: 950 })!)), '950 on AniList');
  assert.equal(readersText(1), '1 reader');
  assert.equal(readersText(312_071), `⁨${compactText(312_071)}⁩ readers`, 'the count is not isolated');
  assert.equal(seen(panel({ score: null, popularity: 950 }, null)).match(/>–<\/span><span[^>]*>\/ 100</)?.length, 1, 'no score is not a dash');
});

test('in Arabic the score still reads "84 / 100", the count keeps its word, and nothing of it is bare English', () => {
  inLanguage('ar', () => {
    const html = panel(LINKED, 3);
    assert.match(html, /<span dir="ltr"[^>]*><span[^>]*>84<\/span><span[^>]*>\/ 100<\/span><\/span>/, 'the score is not one left-to-right run');
    const count = compactText(312_071);
    assert.match(html, new RegExp(`القرّاء: ⁨${count}⁩`), 'the Arabic count is not isolated after its word');
    assert.match(html, /aria-label="قيّمها بـ3 من 5" aria-pressed="true"/);
    assert.match(html, /تقييمك/);
    assert.match(html, /اضغط ثانيةً لإلغاء التقييم/);
    // Western digits beside Arabic words, as every number in the app (lib/format.ts intlTag's -u-nu-latn).
    assert.doesNotMatch(html, /[٠-٩]/, 'Arabic-Indic digits beside the Western ones');
  });
});

test('the series page says its ratings once: no chip over the banner, nothing in the meta line, no line under the stars', () => {
  // v0.58.0 said both up to three times. Reintroduce any of the three -- `data-anilist-chip`, `data-anilist-meta`,
  // `data-anilist-rating`, or "★ {rating}/5" -- and this names it.
  const page = code(read('app/series/page.tsx'));
  for (const old of ['data-anilist-chip', 'data-anilist-meta', 'data-anilist-rating', 'anilistLine', '<StarRating', 'StarRating(']) {
    assert.ok(!page.includes(old), `the series page says it again: ${old}`);
  }
  assert.doesNotMatch(page, /★ \{rating\}/, 'the reader\'s stars are said beside the panel again');
  // One panel per layout: under the cover on a phone, atop the right column from lg -- each hidden in the other.
  const mounts = [...page.matchAll(/<div className="([^"]*)"><RatingsPanel anilist=\{series\.yomi\?\.anilist\} rating=\{rating\} onRate=\{rate\}[^>]*\/><\/div>/g)].map((m) => m[1]);
  assert.deepEqual(mounts, ['mt-4 lg:hidden', 'hidden lg:block'], `the panel is not mounted once per layout: ${JSON.stringify(mounts)}`);
  assert.equal((page.match(/<RatingsPanel\b/g) ?? []).length, 2);
  // The phone's under the cover and the title, before the reading button; the desktop's before the supply line.
  assert.ok(page.indexOf('<div className="mt-4 lg:hidden"><RatingsPanel') < page.indexOf('{Actions}'), 'the phone\'s panel is not above the reading button');
  assert.ok(page.indexOf('<div className="hidden lg:block"><RatingsPanel') < page.indexOf('<SupplyLine parts={supplyWide}'), 'the desktop panel is not the right column\'s first row');
  // Nowhere else in the app draws the panel.
  const elsewhere = ['app', 'components'].flatMap((d) => (readdirSync(join(ROOT, d), { recursive: true }) as string[])
    .filter((f) => /\.tsx$/.test(f)).map((f) => join(d, f)))
    .filter((f) => f !== join('app', 'series', 'page.tsx') && f !== join('components', 'RatingsPanel.tsx') && /<RatingsPanel\b/.test(read(f)));
  assert.deepEqual(elsewhere, []);
});
