// The series page on a phone (UI refresh, phone pass; the owner: "it should fill the full hero ... no blur, it should be
// an actual [picture]"). The cover is the hero: a 2:3 cover the screen's width is the shape of a phone held upright.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const page = readFileSync(join(__dirname, '..', 'app/series/page.tsx'), 'utf8');
const hero = page.slice(page.indexOf('<div data-series-hero'), page.indexOf('{/* content */}'));
const cover = page.slice(page.indexOf('function PhoneHeroCover('), page.indexOf('function ChapterEditModal('));

test('a phone\'s hero is the cover, filling it: the sharp 1600-px copy, cropped to fit, nothing blurred', () => {
  assert.ok(hero && cover, 'the hero or PhoneHeroCover is not where this test looks');
  // Reintroduce the banner on a phone (drop the `wide ?`): this fails.
  assert.match(hero, /\{wide \? <HeroArt series=\{series\} version=\{series\.artVersion\} banner className="absolute inset-0" \/> : <PhoneHeroCover id=\{id\} version=\{series\.artVersion\} still=\{reduced\} \/>\}/);
  assert.match(cover, /<Img src=\{img\.seriesThumb\(id, version, 1600\)\} alt="" eager className="h-full w-full" imgClassName="object-cover object-top" \/>/);
  assert.doesNotMatch(cover, /blur/, 'the phone hero is blurred');
  // As tall as the cover's own shape at the screen's width, and never so tall the reading button falls off the screen.
  assert.match(hero.split('\n')[0], /h-\[min\(150vw,82svh\)\]/);
});

test('the cover drifts only when both motion switches allow it', () => {
  // `reduced` is Reduce effects OR the system's reduced motion, both read on every render (effects.test.ts). Reintroduce
  // an ungated drift: this fails.
  assert.match(cover, /animate=\{still \? \{ scale: 1 \} : \{ scale: \[1, 1\.07\] \}\}/);
  assert.match(cover, /transition=\{still \? \{ duration: 0 \} : \{[^}]*repeat: Infinity[^}]*\}\}/);
  assert.match(page, /const reduced = plain \|\| !!still;/);
});

test('the phone bar is clear over the cover and glass with the title once the cover\'s title has gone', () => {
  // It faded to transparent the whole way down, and the reading button scrolling under it showed through as a collision.
  // Reintroduce the gradient bar: this fails.
  const bar = page.slice(page.indexOf('<div data-series-bar='), page.indexOf('{/* A phone\'s hero is the cover itself'));
  assert.ok(bar, 'the bar is not where this test looks');
  assert.doesNotMatch(bar, /bg-linear-to-b from-ink-950 to-transparent/, 'the see-through gradient bar is back');
  assert.match(bar, /\$\{!wide && titleOut \? 'glass-strong[^']*' : ''\}/, 'the bar does not turn glass on a phone');
  assert.match(bar, /\$\{titleOut \? 'opacity-100' : 'opacity-0'\}/, 'the bar shows the title over the cover, where the cover says it');
  assert.match(page, /const titleOut = useOutOfView\(heroTitleRef, '-72px 0px 0px 0px'\);/);
});

test('a phone reads the reading button first under the art, and swipes one row of genres', () => {
  const left = page.slice(page.indexOf('{/* The poster, a desktop\'s'), page.indexOf('{/* info + chapters */}'));
  assert.ok(left.indexOf('{Actions}') >= 0 && left.indexOf('{Actions}') < left.indexOf('<RatingsPanel'), 'the reading button is not first');
  // The poster is a desktop's, and a phone does not even fetch it.
  assert.match(left, /className="hidden overflow-hidden rounded-2xl [^"]*lg:block lg:w-full">\s*\{series && wide && <Img/);
  const genres = page.slice(page.indexOf('const Genres = '), page.indexOf('const Summary = '));
  assert.match(genres, /<div data-lenis-prevent className="-mx-4 flex gap-2 overflow-x-auto [^"]*lg:flex-wrap[^"]*">/);
});
