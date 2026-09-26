// Where a Health finding's Open goes (lib/healthLinks.ts), and how the series page lands on a chapter.
//
// Open used to go to the home screen (a /series/<id> path the static export does not have), and even pointed
// right it only ever named the series. The owner's words: "when i click open it does not take me to that
// chapter". So a short chapter opens in the reader, and a gap or an impossible number opens the series turned to
// that chapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { chParam, healthLinks, landingNumber, readerHref, seriesHref } from '../lib/healthLinks';

test('links are the query shape, encoded, with ?ch= only for a real number', () => {
  assert.equal(seriesHref('s 1'), '/series/?id=s%201');
  assert.equal(seriesHref('s1', 12.5), '/series/?id=s1&ch=12.5');
  assert.equal(seriesHref('s1', 0), '/series/?id=s1&ch=0', 'chapter 0 is a chapter');
  assert.equal(seriesHref('s1', null), '/series/?id=s1');
  assert.equal(seriesHref('s1', Number.NaN), '/series/?id=s1');
  assert.equal(readerHref('b/1'), '/reader/?book=b%2F1');
});

test('each finding opens the chapter it is about', () => {
  // Reintroduce by returning the series for every check: a short chapter opens the series, not the chapter.
  assert.deepEqual(healthLinks('short-chapters', { title: 't', detail: 'd', seriesId: 's1', bookId: 'b9', number: 4 }), [{ href: '/reader/?book=b9' }]);
  assert.deepEqual(healthLinks('chapter-gaps', { title: 't', detail: 'd', seriesId: 's1', numbers: [14, 12, 13] }), [{ href: '/series/?id=s1&ch=12' }],
    'a gap opens at its first missing number');
  assert.deepEqual(healthLinks('outliers', { title: 't', detail: 'd', seriesId: 's1', numbers: [9001, 5000] }), [{ href: '/series/?id=s1&ch=9001' }]);
  assert.deepEqual(healthLinks('duplicates', { title: 'A + B', detail: 'd', seriesId: 'a', seriesIds: ['a', 'b'], titles: ['A', 'B'] }),
    [{ href: '/series/?id=a', label: 'A' }, { href: '/series/?id=b', label: 'B' }], 'both copies, not only the first');
  assert.deepEqual(healthLinks('frozen-series', { title: 't', detail: 'd', seriesId: 's1' }), [{ href: '/series/?id=s1' }]);
  assert.deepEqual(healthLinks('chapter-failures', { title: 'MangaDex', detail: 'd', sourceId: 'mangadex' }), [], 'a source is not a series');
  // A gap with no numbers falls back to the series rather than to nothing.
  assert.deepEqual(healthLinks('chapter-gaps', { title: 't', detail: 'd', seriesId: 's1' }), [{ href: '/series/?id=s1' }]);
});

test('?ch= lands on that chapter, or on the one just before a gap', () => {
  const held = [1, 2, 3, 7, 8, 8.5, 10];
  assert.equal(landingNumber(held, 7), 7);
  assert.equal(landingNumber(held, 7.0000001), 7, 'stored numbers are floats');
  assert.equal(landingNumber(held, 4), 3, 'a missing number lands where its gap begins');
  assert.equal(landingNumber(held, 9), 8.5);
  assert.equal(landingNumber(held, 0.5), 1, 'nothing below: the first one above');
  assert.equal(landingNumber([], 3), null);
});

test('an absent ?ch= is absent, not chapter 0', () => {
  // Reintroduce by `Number(params.get('ch'))`: every series link would jump to chapter 0.
  assert.equal(chParam(null), null);
  assert.equal(chParam(''), null);
  assert.equal(chParam('  '), null);
  assert.equal(chParam('abc'), null);
  assert.equal(chParam('0'), 0);
  assert.equal(chParam('12.5'), 12.5);
});

test('the series page reads ?ch= and lights the row it lands on', () => {
  const page = readFileSync(join(__dirname, '..', 'app', 'series', 'page.tsx'), 'utf8');
  assert.match(page, /chParam\(useSearchParams\(\)\.get\('ch'\)\)/);
  assert.match(page, /landingNumber\(held, wantCh\)/);
  assert.match(page, /lit=\{litCh === b\.number\}/);
  // Taken off the URL with the router's history state kept: dropping it makes Next reload the page on Back.
  assert.match(page, /replaceState\(window\.history\.state,/);
});
