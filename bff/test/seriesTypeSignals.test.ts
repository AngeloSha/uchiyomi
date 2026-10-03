// What each piece of evidence says a series is (lib/seriesTypeSignals.ts), and the notice-chapter helpers that need
// no database (lib/noticeChapters.ts). Pure.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  typeFromGenres, typeFromLanguage, typeFromCountry, typeFromAniListMatch, SERIES_TYPE_FROM, GENRE_TYPE_TABLE,
} from '../src/lib/seriesTypeSignals';
import { isFractionalNumber, sanitiseNoticeTypes, noticeHidden } from '../src/lib/noticeChapters';

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

test('a notice is any number with a fraction', () => {
  for (const n of [100.1, 100.5, 0.5, 12.01]) assert.equal(isFractionalNumber(n), true, String(n));
  for (const n of [100, 0, -1, NaN, Infinity]) assert.equal(isFractionalNumber(n), false, String(n));
  // As Postgres hands a `real` back: 100.1 is 100.0999984741211, still a fraction.
  assert.equal(isFractionalNumber(Math.fround(100.1)), true);
});

test('the stored list keeps known types only, once each, in order', () => {
  assert.deepEqual(sanitiseNoticeTypes(['manhwa', 'manga', 'manhwa', 'nope', 3]), ['manga', 'manhwa']);
  assert.deepEqual(sanitiseNoticeTypes('manhwa'), []);
  assert.deepEqual(sanitiseNoticeTypes(null), []);
});

test('the SQL fragment tests the fraction before it reads any setting, and binds nothing', () => {
  const sql = noticeHidden('s', 'b.number');
  assert.ok(sql.indexOf('floor(b.number)') < sql.indexOf('server_settings'), 'the cheap test must come first');
  assert.doesNotMatch(sql, /\$\d/, 'a fragment interpolated into hand-numbered queries must not bind');
});
