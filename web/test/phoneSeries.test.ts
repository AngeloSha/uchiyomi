// The series page on a phone (UI refresh, phone pass; the owner: "it should fill the full hero ... no blur, it should be
// an actual [picture]"). The cover is the hero: a 2:3 cover the screen's width is the shape of a phone held upright.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const page = readFileSync(join(__dirname, '..', 'app/series/page.tsx'), 'utf8');
const hero = page.slice(page.indexOf('<div data-series-hero'), page.indexOf('{/* content */}'));
// The component's code, its comments left out: they say "nothing blurred".
const cover = readFileSync(join(__dirname, '..', 'components/PhoneHeroCover.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

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
  assert.match(cover, /<div data-phone-hero-cover className=\{`absolute inset-0 \$\{still \? '' : 'hero-drift'\}`\}>/);
  assert.match(page, /const reduced = plain \|\| !!still;/);
  // ...and plays. It was framer keyframes until v0.75.0 and never ran: a page loaded directly mounts under the page
  // transition's AnimatePresence initial={false}, which starts every motion component in it at its last keyframe and plays
  // nothing -- with every line of this test passing. Reintroduce the motion.div: this fails, and so does run.mjs's phone
  // walk ("the hero cover does not drift"), which reads the moving transform.
  assert.doesNotMatch(cover, /motion\./, 'the drift is framer keyframes again, which never play on a page loaded directly');
  const css = readFileSync(join(__dirname, '..', 'app/globals.css'), 'utf8');
  assert.match(css, /@keyframes hero-drift \{ from \{ transform: scale\(1\); \} to \{ transform: scale\(1\.07\); \} \}/);
  assert.match(css, /\.hero-drift \{ animation: hero-drift 24s ease-in-out infinite alternate; \}/);
  // Stopped by both switches in CSS too, or the reduced-motion rule's 0.001 ms flickers an infinite animation.
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.fx-mesh \{ animation: none; \}\s*\.hero-drift \{ animation: none; \}/);
  assert.match(css, /html\.reduce-effects \.hero-drift \{ animation: none; \}/);
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
  // Nothing renders between the art and the reading button: #242 put an admin's full-width Change cover key there, and
  // Continue dropped a row on a phone. Reintroduce any element before {Actions}: this fails. (Comments may sit there.)
  const beforeActions = left.slice(left.indexOf('</motion.div>') + '</motion.div>'.length, left.indexOf('{Actions}'))
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  assert.equal(beforeActions.trim(), '', `something sits between the art and the reading button: ${beforeActions.trim().slice(0, 80)}`);
  // The poster is a desktop's, and a phone does not even fetch it.
  assert.match(left, /className="hidden overflow-hidden rounded-2xl [^"]*lg:block lg:w-full">\s*\{series && wide && (?:<Img|\(isAdmin)/);
  const genres = page.slice(page.indexOf('const Genres = '), page.indexOf('const Summary = '));
  assert.match(genres, /<div data-lenis-prevent-horizontal className="-mx-4 flex gap-2 overflow-x-auto [^"]*lg:flex-wrap[^"]*">/);
});

test('Home\'s hero on a phone is its slide\'s cover too, filling it; a computer keeps the banner and the strips', () => {
  // v0.67.1, the owner: the phone hero "still shows the mashup of panels". Reintroduce the strips on a phone (drop the
  // `wide ?`): this fails.
  const hero = readFileSync(join(__dirname, '..', 'components/HeroCarousel.tsx'), 'utf8');
  assert.match(hero, /\{wide \? <HeroArt series=\{cur\} hero className="absolute inset-0" \/> : <PhoneHeroCover id=\{cur\.id\} version=\{cur\.artVersion\} still=\{reduced\} \/>\}/);
  assert.match(hero, /data-home-hero\s+className="[^"]*\bh-\[min\(150vw,82svh\)\][^"]*lg:h-\[64vh\]/, 'the phone hero is not the cover\'s shape');
  // A phone fades only the foot, where the title and keys are; the desktop's wash across the art is a computer's.
  assert.match(hero, /<div className="absolute inset-0 hidden bg-linear-to-r [^"]*lg:block" \/>/);
  assert.match(hero, /<div className="absolute inset-x-0 bottom-0 h-\[65%\] bg-linear-to-t [^"]*lg:hidden" \/>/);
  // The next slide's art is warmed before it shows -- on a phone, its cover.
  assert.match(hero, /im\.src = wide \? backdropSources\([^)]*\)\[0\] : img\.seriesThumb\(nxt\.id, nxt\.artVersion, 1600\);/);
  // Home's skeleton holds the same height, so the page does not jump when the hero arrives.
  const home = readFileSync(join(__dirname, '..', 'app/page.tsx'), 'utf8');
  assert.match(home, /skeleton bleed-lg under-topbar under-phone-header h-\[min\(150vw,82svh\)\] lg:h-\[62vh\]/);
});

