// Discover's For you band (v0.99.0). The owner, of v0.98.0's picks row inside the wall: the picks "are hiding inside,
// barely noticeable". What these pin: the band says what it is (the hero's tag, its own heading), the top pick is the big
// card and the row holds the rest, the glow behind it is the top pick's own cover, and the covers beside "Because you
// read…" are the reads the picks came from.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ForYouBand } from '../components/ForYouBand';
import type { CardWhy } from '../components/DiscoverHero';
import { sourceCover } from '../components/cards';
import { seedsOf, type Pick } from '../lib/forYou';
import { setActiveLocale } from '../lib/format';

// Under tsx the components compile to the classic `React.createElement`, which they look up as a global.
(globalThis as { React?: unknown }).React = React;
setActiveLocale('en');

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file with its comments removed, JSX ones whole: comments here quote the code they replaced. */
const code = (src: string): string => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const readPick = (title: string, seriesId: string, because: string): Pick => ({
  id: null, title, cover: `https://s4.anilist.co/large/${title.replace(/\s/g, '-')}.jpg`, score: 80,
  from: { kind: 'read', seriesId, because },
});
const trackerPick = (title: string): Pick => ({
  id: null, title, cover: `https://s4.anilist.co/large/${title.replace(/\s/g, '-')}.jpg`, score: 70,
  from: { kind: 'tracker', badge: 'AniList', because: 'Berserk', tip: 'AniList: Berserk' },
});
const whyOf = (pk: Pick): CardWhy => (pk.from.kind === 'tracker'
  ? { badge: pk.from.badge, reason: `Because you read ${pk.from.because}`, tip: pk.from.tip }
  : { reason: `Because you read ${pk.from.because}`, art: `/img/series/${pk.from.seriesId}/thumb` });
const band = (picks: Pick[]) => renderToStaticMarkup(createElement(ForYouBand, { picks, whyOf, onPick: () => {} }));
/** An attribute value as React writes it. */
const attr = (s: string) => s.replace(/&/g, '&amp;');
/** The top pick's card: the spotlight button, which holds no other button. */
const spotlightOf = (html: string) => {
  const at = html.indexOf('data-foryou-spotlight');
  return at < 0 ? '' : html.slice(at, html.indexOf('</button>', at));
};
/** The titles of the row's cards (TrendingCard's title line), in order. */
const rowTitles = (html: string) => {
  const row = html.slice(html.indexOf('</button>', html.indexOf('data-foryou-spotlight')));
  return [...row.matchAll(/<p class="mt-1\.5 line-clamp-2[^"]*" dir="auto">([^<]*)<\/p>/g)].map((m) => m[1]);
};

const PICKS = [
  readPick('Pick Me Up', 's1', 'Dungeon Odyssey'),
  trackerPick('Kill the Hero'),
  readPick('Astral Sutra', 's2', 'Tales of Demons'),
  readPick('Doom Breaker', 's1', 'Dungeon Odyssey'),
];

test('no picks, no band; with picks it says what it is: the hero\'s tag and its own heading', () => {
  assert.equal(band([]), '', 'an empty band is drawn');
  const html = band(PICKS);
  // The same selector the page's rows and the walks have always found the picks by.
  assert.match(html, /^<section data-anilist-rail="foryou" data-foryou-band="true" class="bleed relative isolate /);
  assert.match(html, /<svg[^>]*>[\s\S]*?<\/svg>For you<\/span>/, 'no For you tag');
  assert.match(html, /<h2 class="font-display text-2xl font-bold [^"]*lg:text-4xl">Recommended for you<\/h2>/, 'no heading of its own');
});

test('the top pick is the big card, saying why it is here, and the row holds every other pick once', () => {
  const html = band(PICKS);
  const spot = spotlightOf(html);
  assert.match(spot, /Pick Me Up/, 'the big card is not the top pick');
  assert.match(spot, /data-pick-why[\s\S]*Because you read Dungeon Odyssey/, 'the big card does not say why');
  assert.match(spot, />Find and add</, 'the big card has no key to add it');
  // Reintroduce the row over every pick: the top pick is on the screen twice.
  assert.deepEqual(rowTitles(html), ['Kill the Hero', 'Astral Sutra', 'Doom Breaker']);
  assert.equal((html.match(/data-pick-why/g) ?? []).length, PICKS.length, 'a pick does not say why it is here');
  // One pick: the big card alone, no row to swipe.
  const one = band(PICKS.slice(0, 1));
  assert.match(spotlightOf(one), /Pick Me Up/);
  assert.doesNotMatch(one, /role="group"/, 'an empty row is drawn');
  assert.deepEqual(rowTitles(one), []);
});

test('the glow is the top pick\'s cover, the very address its card shows, and it stands still', () => {
  const html = band(PICKS);
  // Reintroduce the band without its glow: this fails, and the band is a row of covers on the page's black again.
  const glow = /data-foryou-glow="true"[^>]*>[\s\S]*?<img[^>]*src="([^"]+)"/.exec(html);
  assert.ok(glow, 'the band has no glow');
  assert.equal(glow![1], attr(sourceCover(undefined, PICKS[0].cover)), 'the glow is not the top pick\'s cover');
  assert.match(spotlightOf(html), new RegExp(`src="${attr(sourceCover(undefined, PICKS[0].cover)).replace(/[.?]/g, '\\$&')}"`),
    'the glow fetches an address the card does not show');
  // A top pick with no cover lights nothing: Img's broken-image tile, blurred across the band, was a grey wash.
  const bare = band([{ ...PICKS[0], cover: null }, ...PICKS.slice(1)]);
  assert.doesNotMatch(bare, /data-foryou-glow/, 'a pick with no cover lights a broken tile behind the band');
  const src = code(read('components/ForYouBand.tsx'));
  assert.match(src, /const glow = sourceCover\(undefined, shown\.cover\);/);
  // Nor is the loading shimmer blurred across the band: the glow is a plain img.
  assert.doesNotMatch(src.slice(src.indexOf('data-foryou-glow'), src.indexOf('</AnimatePresence>')), /<Img\b/, 'the glow is Img again');
  // Still: a big blurred layer that moved would be re-blurred every frame on a phone. Only its crossfade animates.
  assert.doesNotMatch(src, /hero-drift|animate=\{\{ (scale|x|y)/, 'the glow moves');
  // The pointer lights a card after a moment, a mouse only (a finger swiping the row lights nothing), and leaving the band
  // brings the top pick's glow back.
  assert.match(src, /timer\.current = setTimeout\(\(\) => setLitKey\(key\), LIGHT_MS\);/);
  assert.match(src, /onPointerEnter=\{\(e\) => \{ if \(e\.pointerType === 'mouse'\) light\(keyOf\(pk\)\); \}\}/);
  assert.match(src, /onPointerLeave=\{\(e\) => \{ if \(e\.pointerType === 'mouse'\) light\(null\); \}\}/);
});

test('beside "Because you read…", the covers of the reads the picks came from, and none when every pick is a tracker\'s', () => {
  const html = band(PICKS);
  const seeds = /data-foryou-seeds="true"[\s\S]*?<\/p>/.exec(html)?.[0] ?? '';
  assert.match(seeds, /Because you read…/);
  assert.deepEqual([...seeds.matchAll(/title="([^"]+)"/g)].map((m) => m[1]), seedsOf(PICKS).map((s) => s.title));
  assert.deepEqual(seedsOf(PICKS).map((s) => s.title), ['Dungeon Odyssey', 'Tales of Demons']);
  assert.doesNotMatch(band([trackerPick('A'), trackerPick('B')]), /data-foryou-seeds/, 'covers of reads nobody made');
});
