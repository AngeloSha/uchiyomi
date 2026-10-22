import test from 'node:test';
import assert from 'node:assert/strict';
import { badgeOf, becauseOf, pollAfter, provenance, POLL_MAX, type Recommendation, type Recommendations } from '../lib/recommendations';

const rec = (sources: Recommendation['sources']): Recommendation => ({ title: 'Monster', altTitles: [], cover: null, score: 80, sources });
const src = (provider: string, label: string, because: string) => ({ provider, label, because, url: null });

test('the badge names where a suggestion came from, short, and both services when both suggested it', () => {
  assert.equal(badgeOf(rec([src('anilist', 'AniList', 'Berserk')])), 'AniList');
  assert.equal(badgeOf(rec([src('myanimelist', 'MyAnimeList', 'Vagabond')])), 'MAL');
  assert.equal(badgeOf(rec([src('anilist', 'AniList', 'Berserk'), src('myanimelist', 'MyAnimeList', 'Vagabond')])), 'AniList · MAL');
});

test('"because you read" is the first service\'s seed, and the tooltip carries every one', () => {
  const r = rec([src('anilist', 'AniList', 'Berserk'), src('myanimelist', 'MyAnimeList', 'Vagabond')]);
  assert.equal(becauseOf(r), 'Berserk');
  assert.equal(provenance(r), 'AniList: Berserk · MyAnimeList: Vagabond');
  assert.equal(becauseOf(rec([])), null);
});

test('the rail polls only while the server is still refreshing, and only a few times', () => {
  const data = (pending: boolean): Recommendations => ({ content: [], sources: [], pending });
  assert.equal(pollAfter(undefined, 0), false);
  assert.equal(pollAfter(data(false), 0), false, 'a finished answer is not asked for again');
  assert.equal(typeof pollAfter(data(true), 1), 'number');
  // Reintroduce by polling without a limit: a slow service turns an open tab into a request every few seconds.
  assert.equal(pollAfter(data(true), POLL_MAX), false);
});

test('Discover asks for suggestions while browsing only, draws the row only with a pick, and isolates the read', () => {
  // v0.98.0: the rail became Discover's one picks row (lib/forYou.ts), asked by the page itself so the wall knows whether
  // the row has cards.
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const page = readFileSync(new URL('../app/discover/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /queryKey: \['discover-recommendations'\],\s*queryFn: \(\) => api<Recommendations>\('\/api\/discover\/recommendations'\),\s*enabled: mayAdd && mode === 'newest' && heroSettled,/,
    'it asks when the page may not add, or while searching');
  // Reintroduce the poll without its limit: a slow service turns an open tab into a request every few seconds.
  assert.match(page, /refetchInterval: \(qy\) => pollAfter\(qy\.state\.data, qy\.state\.dataUpdateCount\),/);
  assert.match(page, /ROWS\.filter\(\(k\) => \(k === 'foryou' \? picks\.length : trendRails\[TREND_RAILS\.indexOf\(k\)\]\.length\) > 0\)/,
    'a row without a card is drawn');
  // The read's title is isolated in the sentence, as Home's rail does it. Reintroduce `{ title: pk.from.because }`: this fails.
  assert.match(page, /tr\('Because you read \{title\}', \{ title: `\\u2068\$\{pk\.from\.because\}\\u2069` \}\)/, 'the read\'s title is not isolated');
});
