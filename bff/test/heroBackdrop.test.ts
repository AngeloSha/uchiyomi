// How a series' backdrop is drawn for the style a page asks for (v0.53.0, lib/heroFrame.ts backdropLook).
//
// The series page shows a series' REAL banner -- AniList's, or one an admin set -- sharp, as the owner asked; it was the
// blurred ambient wash, the same as the cover blown up to stand in for a banner a series does not have. That stand-in
// stays blurred (a stretched cover looks bad sharp), and so does the first page when there is no art at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { backdropLook } from '../src/lib/heroFrame';

test('the series page draws a real banner sharp, and a cover standing in for one blurred', () => {
  // Reintroduce `if (style === 'banner' && art.hasUrl)` (any art, not a banner): "a cover standing in for a banner stays
  // blurred" fails.
  assert.equal(backdropLook('banner', { hasUrl: true, fromBanner: true }), 'banner', 'a real banner is drawn sharp');
  assert.equal(backdropLook('banner', { hasUrl: true, fromBanner: false }), 'ambient', 'a cover standing in for a banner stays blurred');
  assert.equal(backdropLook('banner', { hasUrl: false, fromBanner: false }), 'ambient', 'no art: the first page, blurred');
});

test('a banner that could not be fetched is the first page, and that is never drawn sharp', () => {
  // The producer falls back to the series' first page when the banner's address does not answer; `fromBanner` is then
  // false, and the page is the wash, never a manga page stretched across a banner's frame.
  assert.equal(backdropLook('banner', { hasUrl: true, fromBanner: false }), 'ambient', 'the first page in a banner\'s place is the wash');
});

test('the home hero and every page that asks for no style are as they were', () => {
  assert.equal(backdropLook('hero', { hasUrl: true, fromBanner: false }), 'hero', 'the hero shows a cover sharp, framed');
  assert.equal(backdropLook('hero', { hasUrl: true, fromBanner: true }), 'hero');
  assert.equal(backdropLook('hero', { hasUrl: false, fromBanner: false }), 'ambient', 'the hero with no art at all: the wash');
  assert.equal(backdropLook(null, { hasUrl: true, fromBanner: true }), 'ambient', 'no style is the wash, banner or not (the admin header)');
});

test('the backdrop route takes style=banner and draws both of its paths by backdropLook', () => {
  // Reintroduce by dropping `|| asked === 'banner'` from the route: the style never reaches the recipe, and "the route
  // takes style=banner" fails; draw the override banner by `hero` alone again and "both paths" fails.
  const src = readFileSync(join(__dirname, '..', 'src', 'routes', 'images.ts'), 'utf8');
  assert.match(src, /const style = asked === 'hero' \|\| asked === 'banner' \? asked : null;/, 'the route takes style=banner');
  const recipe = src.slice(src.indexOf('async function backdropRecipe('), src.indexOf('export async function warmHeroBackdrops('));
  assert.equal((recipe.match(/const look = backdropLook\(style, /g) ?? []).length, 2, 'both paths (an admin\'s banner and the fetched art) draw by backdropLook');
  assert.equal((recipe.match(/look === 'banner' \? await bannerSharp\(input\)/g) ?? []).length, 2);
});
