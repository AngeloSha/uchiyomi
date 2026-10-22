// Discover's hero (v0.98.0). The owner: it "takes a while to load on phone or does not load at all". What these pin: its
// own box holds its place while the answer is on its way, the art it warms is the art it shows, it asks again only while
// the server is still pulling, and it moves as Home's does -- with a Pause key, and still under Reduce effects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiscoverHero, HERO_POLL_MAX, heroArt, heroPoll, TrendingCard, type Trending } from '../components/DiscoverHero';
import { setActiveLocale } from '../lib/format';

// Under tsx the components compile to the classic `React.createElement`, which they look up as a global.
(globalThis as { React?: unknown }).React = React;
setActiveLocale('en');

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file with its comments removed, JSX ones whole: comments here quote the code they replaced. */
const code = (src: string): string => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const slide = (title: string, o: Partial<Trending> = {}): Trending => ({
  id: 1, title, cover: `https://s4.anilist.co/large/${title}.jpg`, coverXL: `https://s4.anilist.co/xl/${title}.jpg`, banner: null,
  description: '', genres: ['Action'], score: 80, chapters: 100, status: 'RELEASING', ...o,
});
const hero = (props: Partial<Parameters<typeof DiscoverHero>[0]>) =>
  renderToStaticMarkup(createElement(DiscoverHero, { slides: [], onPick: () => {}, ...props }));
/** The hero's outermost box: React hoists the eager image's preload hint before it. */
const rootClass = (html: string) => /<div class="([^"]*)"/.exec(html)?.[1];

test('while the answer is on its way the hero\'s own box holds its place, and with nothing to show there is no box', () => {
  const waiting = hero({ waiting: true });
  assert.match(waiting, /data-hero-waiting/, 'nothing holds the hero\'s place');
  const shown = hero({ slides: [slide('A'), slide('B')] });
  // Reintroduce a stand-in of another size (or none): the page jumps when the hero lands.
  assert.equal(rootClass(waiting), rootClass(shown), 'the stand-in is not the hero\'s box');
  assert.match(rootClass(shown)!, /h-\[44vh\] min-h-\[300px\]/);
  assert.match(waiting, />Trending now</, 'the stand-in does not say what is coming');
  assert.equal(hero({ waiting: false }), '', 'an empty answer draws an empty box');
});

test('the art the hero warms is the art it shows: the biggest cover on a phone, the banner on a computer', () => {
  // Reintroduce the preload at 800 under a hero shown at 1600: every slide is fetched twice, the warm copy never used.
  const src = code(read('components/DiscoverHero.tsx'));
  assert.match(src, /const \{ src \} = heroArt\(next, wide\);/, 'the next slide is warmed at another address');
  assert.match(src, /const art = heroArt\(cur, wide\);/);
  assert.match(src, /<Img\s+src=\{art\.src\} alt=\{cur\.title\}/, 'the hero shows another address than it warms');
  assert.equal((src.match(/sourceCover\(undefined, [^)]*\b(?:800|1600)\)/g) ?? []).length, 2, 'a hero address outside heroArt');
  // A phone: the cover at its largest, 800 wide (AniList's covers are smaller), cropped from the top.
  const phone = heroArt(slide('A', { banner: 'https://s4.anilist.co/banner/A.jpg' }), false);
  assert.equal(phone.src, `/img/sources/cover?u=${encodeURIComponent('https://s4.anilist.co/xl/A.jpg')}&w=800&v=2`);
  assert.equal(phone.letterboxed, false);
  // An older server's answer has no coverXL: the cover it has.
  assert.match(heroArt(slide('A', { coverXL: undefined }), false).src, /large%2FA\.jpg&w=800/);
  // A computer: the banner, 1600 wide; without one, the cover letterboxed against its own blur.
  assert.match(heroArt(slide('A', { banner: 'https://s4.anilist.co/banner/A.jpg' }), true).src, /banner%2FA\.jpg&w=1600/);
  assert.deepEqual(heroArt(slide('A'), true).letterboxed, true);
});

test('the page asks again only while the server is still pulling, and only a dozen times', () => {
  assert.equal(heroPoll(undefined, 0), false);
  assert.equal(heroPoll({ pending: false }, 1), false, 'a finished answer is asked for again');
  assert.equal(typeof heroPoll({ pending: true }, 1), 'number');
  // Reintroduce the poll without a limit: AniList slow today turns an open tab into a request every five seconds.
  assert.equal(heroPoll({ pending: true }, HERO_POLL_MAX), false);
  // The page holds the stand-in only while it would still ask.
  assert.match(code(read('app/discover/page.tsx')),
    /const heroWaiting = trendQ\.isPending\s*\|\| heroPoll\(trending, qc\.getQueryState\(\['discover-trending', 'KR'\]\)\?\.dataUpdateCount \?\? 0\) !== false;/);
});

test('it moves as Home\'s does: segments that fill, a Pause key, a crossfade, and a phone\'s cover drifting -- still under either setting', () => {
  const html = hero({ slides: [slide('A'), slide('B'), slide('C')] });
  assert.match(html, /data-hero-slides/);
  assert.equal((html.match(/aria-label="(A|B|C)"/g) ?? []).length, 3, 'a slide without its segment');
  // WCAG 2.2.2: a moving picture can be stopped. Reintroduce the dots alone: no Pause key.
  assert.match(html, /aria-label="Pause"/, 'no Pause key');
  assert.doesNotMatch(hero({ slides: [slide('A')] }), /aria-label="Pause"|data-hero-slides/, 'one slide has nothing to pause');
  const src = code(read('components/DiscoverHero.tsx'));
  assert.match(src, /const plain = useReduceEffects\(\);\s*const still = useReducedMotion\(\);\s*const reduced = plain \|\| !!still;/);
  assert.match(src, /initial=\{reduced \? \{ opacity: 0 \} : \{ opacity: 0, scale: 1\.06 \}\}/, 'the slide still settles in under Reduce effects');
  // Reintroduce the drift without its `!reduced`: a phone's cover moves under Reduce effects.
  assert.match(src, /\$\{!wide && !reduced \? 'hero-drift' : ''\}/, 'the drift ignores the settings, or runs on a computer');
});

test('a trending row ranks its first cards as Home\'s Top 10 does, and a pick says why it is there', () => {
  const ranked = renderToStaticMarkup(createElement(TrendingCard, { t: slide('A'), onPick: () => {}, rank: 3 }));
  assert.match(ranked, /class="rank-numeral[^"]*"[^>]*>3</, 'the rank is not drawn as Home\'s Top 10');
  assert.match(ranked, /min-h-\[2lh\]/, 'a one-line title lifts the numeral off the cover\'s foot');
  const plain = renderToStaticMarkup(createElement(TrendingCard, { t: slide('A'), onPick: () => {} }));
  assert.doesNotMatch(plain, /rank-numeral|data-pick-why/);
  const why = renderToStaticMarkup(createElement(TrendingCard, {
    t: slide('A'), onPick: () => {}, why: { badge: 'AniList', reason: 'Because you read Berserk', tip: 'AniList: Berserk', art: '/img/series/s1/thumb?v=2' },
  }));
  assert.match(why, /title="AniList: Berserk"/);
  assert.match(why, />AniList</);
  assert.match(why, /data-pick-why/);
  assert.match(why, />Because you read Berserk</);
  // The title stays the card's one paragraph: the walks read `button p` for it.
  assert.equal((why.match(/<p\b/g) ?? []).length, 1);
});
