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

test('Discover shows the rail while browsing only, and the rail draws nothing without a suggestion', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const page = readFileSync(new URL('../app/discover/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /\{mode === 'newest' && <RecommendationRail enabled=\{mayAdd\} onPick=\{\(title\) => setSeed\(\{ kind: 'trending', title \}\)\} \/>\}/);
  const rail = readFileSync(new URL('../components/RecommendationRail.tsx', import.meta.url), 'utf8');
  assert.match(rail, /enabled,\n/, 'it asks only when the page may add');
  assert.match(rail, /if \(!items\.length\) return null;/);
  // The seed's title is isolated in the sentence, as Discover's own rail does it. Reintroduce `{ title: because }`: this fails.
  assert.match(rail, /tr\('Because you read \{title\}', \{ title: `\\u2068\$\{because\}\\u2069` \}\)/, 'the seed title is not isolated');
});
