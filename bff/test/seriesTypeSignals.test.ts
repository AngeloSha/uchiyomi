// What each piece of evidence says a series is (lib/seriesTypeSignals.ts), and the notice-chapter helpers that need
// no database (lib/noticeChapters.ts). Pure.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  typeFromGenres, typeFromLanguage, typeFromCountry, typeFromAniListMatch, SERIES_TYPE_FROM, GENRE_TYPE_TABLE,
} from '../src/lib/seriesTypeSignals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isFractionalNumber, isListedNotice, listedPagesOf, sanitiseNoticeTypes, noticeHidden, noticeShown, noticeBook, noticeListed, listedHidden, listedShown,
  visibleBookCount, setNoticesActive,
} from '../src/lib/noticeChapters';

test('a genre naming the origin beats a Webtoon genre, whatever the order', () => {
  // The user's rule: a series tagged both is the origin one. Reintroduce by testing Webtoon first: this reads webtoon.
  assert.deepEqual(typeFromGenres(['Webtoon', 'Manhwa']), { type: 'manhwa', from: 'genre' });
  assert.deepEqual(typeFromGenres(['Action', 'manhua ']), { type: 'manhua', from: 'genre' });
  assert.deepEqual(typeFromGenres(['Comic']), { type: 'comic', from: 'genre' });
  // "Manga" is what many sites call the whole medium: the more specific origin wins.
  assert.deepEqual(typeFromGenres(['Manga', 'Manhwa']), { type: 'manhwa', from: 'genre' });
  assert.deepEqual(typeFromGenres(['Manga']), { type: 'manga', from: 'genre' });
  // A Webtoon genre alone is the weakest evidence there is.
  assert.deepEqual(typeFromGenres(['Web  Comic']), { type: 'webtoon', from: 'webtoon' });
  assert.equal(typeFromGenres(['Action', 'Romance']), null);
  assert.equal(typeFromGenres([]), null);
  assert.equal(typeFromGenres(null), null);
});

test('the original language and the country of origin', () => {
  assert.equal(typeFromLanguage('ja'), 'manga');
  assert.equal(typeFromLanguage('KO'), 'manhwa');
  assert.equal(typeFromLanguage('zh-hk'), 'manhua');
  assert.equal(typeFromLanguage('en'), null, 'an English original could be anything');
  assert.equal(typeFromCountry('kr'), 'manhwa');
  assert.equal(typeFromCountry('TW'), 'manhua');
  assert.equal(typeFromCountry('JP'), 'manga');
  assert.equal(typeFromCountry('US'), null);
});

test('AniList speaks only for an entry that is visibly this series', () => {
  assert.equal(typeFromAniListMatch('Solo Leveling', { country: 'KR', titles: ['Na Honjaman Level Up', 'Solo Leveling'] }), 'manhwa');
  assert.equal(typeFromAniListMatch('No Direction', { country: 'JP', titles: ['Dear Green'] }), null);
  assert.equal(typeFromAniListMatch('x', null), null);
});

test('the evidence ranks, least trusted first, and the backfill table keeps the origin genres ahead of Webtoon', () => {
  assert.deepEqual([...SERIES_TYPE_FROM], ['webtoon', 'anilist', 'source', 'genre']);
  assert.equal(GENRE_TYPE_TABLE[GENRE_TYPE_TABLE.length - 1][0], 'webtoon');
});

test('a fraction, and a listed notice: a fraction its copies say is 3 pages or fewer', () => {
  for (const n of [100.1, 100.5, 0.5, 12.01]) assert.equal(isFractionalNumber(n), true, String(n));
  for (const n of [100, 0, -1, NaN, Infinity]) assert.equal(isFractionalNumber(n), false, String(n));
  // As Postgres hands a `real` back: 100.1 is 100.0999984741211, still a fraction.
  assert.equal(isFractionalNumber(Math.fround(100.1)), true);
  // The sweep's half of the owner's rule (the listing's, lib/noticeChapters.ts listedIsNotice, is the same).
  assert.equal(isListedNotice(44.5, [2]), true, 'a two-page 44.5 is a notice');
  assert.equal(isListedNotice(44.5, [3, undefined]), true, 'three pages is still a notice');
  assert.equal(isListedNotice(12.5, [20]), false, 'a twenty-page 12.5 is a chapter in parts');
  assert.equal(isListedNotice(7.5, [undefined, null, 0]), false, 'nobody knows how long 7.5 is: fetched, and judged once counted');
  // The most any copy says: one group's two-page teaser is not another group's eighteen-page chapter.
  assert.equal(isListedNotice(9.5, [2, 18]), false);
  assert.equal(isListedNotice(44, [1]), false, 'a whole number is never a notice');
  assert.equal(listedPagesOf([0, -4, 'x', 2]), 2);
  assert.equal(listedPagesOf([]), null);
});

test('the stored list keeps known types only, once each, in order', () => {
  assert.deepEqual(sanitiseNoticeTypes(['manhwa', 'manga', 'manhwa', 'nope', 3]), ['manga', 'manhwa']);
  assert.deepEqual(sanitiseNoticeTypes('manhwa'), []);
  assert.deepEqual(sanitiseNoticeTypes(null), []);
});

test('while nothing hides, every fragment is a constant: each query is the one the previous release ran', () => {
  // The review measured the fragments' cost with every switch off: the Library grid 9.5 -> 84 ms, Continue Reading
  // 10 -> 118 ms, every reader page 0.47 -> 1.17 ms, because the planner prices a per-series count and a per-row EXISTS
  // whether or not they can match. Reintroduce by dropping the `active` gate: every one of these is SQL again.
  const off = {
    hidden: noticeHidden('s', 'b', 'b.number'), shown: noticeShown('s', 'b', 'b.number'), book: noticeBook('b.id'),
    listedHidden: listedHidden('s', 'l'), listedShown: listedShown('s', 'l'), listed: noticeListed('l'), count: visibleBookCount('s'),
  };
  assert.deepEqual(off, {
    hidden: 'false', shown: 'true', book: 'false', listedHidden: 'false', listedShown: 'true', listed: 'false', count: 's.books_count',
  });
  setNoticesActive(true);
  try {
    // And the real thing the moment anything hides.
    assert.match(noticeShown('s', 'b', 'b.number'), /^NOT \(/);
    assert.match(listedShown('s', 'l'), /^NOT \(/);
    assert.match(noticeBook('b.id'), /^EXISTS \(/);
    assert.match(noticeListed('l'), /^EXISTS \(/);
    assert.match(visibleBookCount('s'), /^GREATEST\(0, s\.books_count - /);
  } finally {
    setNoticesActive(false);
  }
});

test('the server reads whether anything hides before it serves a request', () => {
  // Off at boot whatever the database says, a restarted server would show every notice chapter until somebody
  // flipped a switch. Reintroduce by dropping the call from main(): this finds no refresh before listen().
  const src = readFileSync(join(__dirname, '..', 'src', 'server.ts'), 'utf8');
  const main = src.slice(src.indexOf('async function main()'));
  const at = main.indexOf('await refreshNoticesActive()');
  assert.ok(at > 0 && at < main.indexOf('.listen('), 'main() does not refresh the notice flag before listening');
});

test('the SQL fragment tests the fraction before it reads any setting, and binds nothing', () => {
  setNoticesActive(true);
  try {
    const sql = noticeHidden('s', 'b', 'b.number');
    assert.ok(sql.indexOf('floor(b.number)') < sql.indexOf('server_settings'), 'the cheap test must come first');
    assert.doesNotMatch(sql, /\$\d/, 'a fragment interpolated into hand-numbered queries must not bind');
  } finally {
    setNoticesActive(false);
  }
});
