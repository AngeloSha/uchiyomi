// The hero's art, in the order it is tried (v0.51.0, lib/art.ts backdropSources).
//
// A series AniList has no banner for now shows the one the server makes from its own pages. What must hold on the
// web: that banner is asked for only when the payload says there is one (`autoHero`), under its seed so a new one is
// a new URL, in the frame the hero has room for -- and if the server cannot make it, the series' usual backdrop and
// then the genre art are still behind it, so a failure looks like today, never like an empty box.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { autoHeroUrl, backdropSources, backdropUrl } from '../lib/art';

const GENRE = '/art/bg/action.webp';

test('a series with an automatic banner tries it first, then its backdrop, then the genre art', () => {
  // Reintroduce by ignoring `autoHero` in backdropSources: the chain starts at the backdrop.
  assert.deepEqual(backdropSources('s_1', { seed: 7 }, { version: 3 }, GENRE),
    ['/img/series/s_1/hero?v=7', '/img/series/s_1/backdrop?av=3', GENRE]);
  // A new seed (Shuffle) is a new URL, so the browser does not keep showing the old banner from its cache.
  assert.notEqual(backdropSources('s_1', { seed: 8 }, {}, GENRE)[0], backdropSources('s_1', { seed: 7 }, {}, GENRE)[0]);
});

test('without one -- a real banner, 18+, or none could be made -- the chain is today\'s', () => {
  for (const none of [null, undefined]) {
    assert.deepEqual(backdropSources('s_1', none, { hero: true, wide: true }, GENRE),
      [backdropUrl('s_1', { hero: true, wide: true }), GENRE]);
  }
  assert.deepEqual(backdropSources(undefined, { seed: 7 }, {}, GENRE), [GENRE], 'no series, no request');
});

test('no hero URL is built without autoHero: backdropSources builds none, and nothing else builds one', () => {
  // The payload offers `autoHero` only once the banner is MADE (bff lib/autoHero.ts autoHeroFor), and the web must ask
  // for nothing else: a request for one that is not there is a 404 and a console error, on every page that shows the
  // series (the e2e gate on PR #138). Reintroduce by building the hero URL from `autoHero?.seed ?? 0` in
  // backdropSources: every shape below asks for a /hero.
  for (const none of [null, undefined]) for (const hero of [false, true]) for (const wide of [false, true]) for (const version of [undefined, 3]) {
    const chain = backdropSources('s_1', none, { hero, wide, version }, GENRE);
    assert.ok(!chain.some((u) => /\/hero(\?|$)/.test(u)), `${JSON.stringify({ none, hero, wide, version })} asks for ${chain.join(', ')}`);
  }
  // And no other file builds one: autoHeroUrl is lib/art.ts's own, and the route is spelt there alone.
  const root = join(__dirname, '..');
  for (const dir of ['app', 'components', 'lib']) {
    for (const f of readdirSync(join(root, dir), { recursive: true }) as string[]) {
      if (!/\.tsx?$/.test(f) || join(dir, f) === join('lib', 'art.ts')) continue;
      const src = readFileSync(join(root, dir, f), 'utf8');
      assert.doesNotMatch(src, /autoHeroUrl\(|\/img\/series\/[^'"`\n]*\/hero\b/, `${dir}/${f} builds a hero URL of its own`);
    }
  }
});

test('a portrait hero asks for the two-by-two frame; a wide one and the series page for the strip', () => {
  // Reintroduce by always asking for the wide frame: a phone's hero shows the gap between the middle two panels.
  assert.equal(backdropSources('s_1', { seed: 7 }, { hero: true, wide: false }, GENRE)[0], autoHeroUrl('s_1', 7, true));
  assert.equal(autoHeroUrl('s_1', 7, true), '/img/series/s_1/hero?v=7&ar=tall');
  assert.equal(backdropSources('s_1', { seed: 7 }, { hero: true, wide: true }, GENRE)[0], '/img/series/s_1/hero?v=7');
  assert.equal(backdropSources('s_1', { seed: 7 }, { wide: false }, GENRE)[0], '/img/series/s_1/hero?v=7', 'the series page is a strip on any screen');
  // The id is a path segment: encoded, as the backdrop's is.
  assert.equal(autoHeroUrl('a/b', 1), '/img/series/a%2Fb/hero?v=1');
});

test('the series page offers New banner to an admin, and only while the hero is an automatic one', () => {
  // A real banner is changed in Edit details; Shuffle answers 409 for it. Reintroduce by dropping the
  // `series?.autoHero &&` around the button: the assertion below fails.
  const src = readFileSync(join(__dirname, '..', 'app', 'series', 'page.tsx'), 'utf8');
  const at = src.indexOf('data-new-banner');
  assert.ok(at > 0, 'the New banner button is gone');
  const admin = src.lastIndexOf('{isAdmin && (', at);
  assert.ok(admin > 0, 'New banner sits outside the admin actions');
  assert.match(src.slice(admin, at), /\{series\?\.autoHero && \(\s*<button[^>]*$/, 'New banner must be offered only while the hero is an automatic one');
  assert.match(src, /\/api\/admin\/series\/\$\{encodeURIComponent\(id\)\}\/hero\/shuffle/);
  // v0.52.0: the pages give no other banner (`same`), and the page says so rather than "Banner changed" over the same
  // picture. Reintroduce by dropping the `same` branch: the toast below is gone.
  assert.match(src, /if \(r\.ok && r\.same\) toast\(tr\('This is the only banner this series’ pages give\.'\), 'info'\);\s*else if \(r\.ok\)/,
    'Shuffle says "Banner changed" when the pages give no other banner');
});
