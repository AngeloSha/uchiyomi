// The badge emblems (components/BadgeEmblem.tsx, v0.74.0, the owner's approved design): drawn earned and locked, a
// streak's rim one notch per day with the days done lit, a chapter badge's ring as far round as its progress, in the
// reader's accent, no sheen or turning halo under either motion switch, and ids no two emblems share.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BADGES, type Badge } from '../lib/badges';
import { BadgeEmblem, RING } from '../components/BadgeEmblem';

// Under tsx the components compile to the classic `React.createElement`, which they look up as a global.
(globalThis as any).React = React;

const B = (label: string): Badge => BADGES.find((b) => b.label === label)!;
const draw = (label: string, earned: boolean, have: number, o: Partial<{ size: number; detail: boolean; still: boolean }> = {}) =>
  renderToStaticMarkup(createElement(BadgeEmblem, { badge: B(label), earned, have, size: 56, still: false, ...o }));
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

test('earned: the medal in its metal with its glyph filled and a glow; locked: ink, the glyph outlined', () => {
  const on = draw('Reader', true, 10);
  assert.match(on, /data-emblem="earned"/);
  assert.match(on, /stop-color="#ffd9b0"/, 'Reader is not bronze');
  assert.match(on, /<path d="M60,50 C53,45\.5[^"]*" fill="url\(#[^)]+g\)"/, 'the book is not filled with the metal');
  assert.match(on, /filter:drop-shadow\(0 6px 16px rgba\(207,138,82,\.35\)\)/, 'an earned medal has no glow');
  const off = draw('Reader', false, 4);
  assert.match(off, /data-emblem="locked"/);
  assert.doesNotMatch(off, /#ffd9b0|drop-shadow/, 'a locked medal wears its metal or its glow');
  assert.match(off, /<path d="M60,50 C53,45\.5[^"]*" fill="none" stroke="#5d5d6c"/, 'the locked book is not an outline');
  // Every badge draws both ways, in its own metal, and no emoji is left anywhere.
  const metals: Record<string, string> = { Reader: '#ffd9b0', Bookworm: '#ffffff', 'On a roll': '#ffe3a8', Centurion: '#fff5c4', Devoted: '#eef1ff', Legend: '#5ce1ff' };
  for (const b of BADGES) {
    assert.match(draw(b.label, true, b.goal), new RegExp(`stop-color="${metals[b.label]}"`), `${b.label} is not in its metal`);
    assert.match(draw(b.label, false, 0), /data-emblem="locked"/);
  }
  assert.match(draw('Centurion', true, 100), />100<\/text>/, 'Centurion\'s laurel has no 100');
});

test('a streak\'s rim: one notch per day of its goal, the days done lit in the accent while it is locked, every one once earned', () => {
  // Reintroduce `lit = count` for a locked badge: "3 of 7 days lit" fails.
  const roll = draw('On a roll', false, 3);
  assert.equal(count(roll, /data-notch=/g), 7, 'one notch per day of a 7-day streak');
  assert.equal(count(roll, /data-notch="lit"/g), 3, '3 of 7 days lit');
  assert.equal(count(roll, /data-notch="lit"[^>]*style="fill:var\(--color-accent\)"/g), 3, 'the days done are not the accent');
  const devoted = draw('Devoted', false, 9);
  assert.equal(count(devoted, /data-notch=/g), 30);
  assert.equal(count(devoted, /data-notch="lit"/g), 9);
  assert.equal(count(draw('Devoted', false, 45), /data-notch="lit"/g), 30, 'more days than the goal light more notches than there are');
  const earned = draw('On a roll', true, 12);
  assert.equal(count(earned, /data-notch="lit"/g), 7, 'an earned streak lights its whole rim');
  assert.equal(count(earned, /fill="#ffe3a8"[^>]*opacity="0\.9"/g), 7, 'an earned rim is the metal\'s light');
  assert.equal(count(draw('Reader', false, 3), /data-notch=/g), 0, 'a chapter badge has no notches');
});

test('a chapter badge\'s ring: as far round as the chapters read, in the accent, only while it is locked', () => {
  // Reintroduce a ring that ignores progress (or the preview's hard-coded violet): this fails.
  const dash = (html: string) => /data-emblem-ring[^>]*stroke-dasharray="([\d.]+) ([\d.]+)"/.exec(html)!.slice(1).map(Number);
  for (const [have, share] of [[64, 0.64], [0, 0], [25, 0.25], [140, 1]] as const) {
    const [on, all] = dash(draw('Centurion', false, have));
    assert.equal(all, Number(RING.toFixed(2)));
    assert.equal(on, Number((RING * share).toFixed(2)), `${have} of 100 chapters`);
  }
  assert.match(draw('Centurion', false, 64), /data-emblem-ring[^>]*style="stroke:var\(--color-accent\)"/, 'the ring is not the accent');
  assert.doesNotMatch(draw('Centurion', true, 100), /data-emblem-ring/, 'an earned badge has a progress ring');
  assert.doesNotMatch(draw('On a roll', false, 3), /data-emblem-ring/, 'a streak badge has a ring as well as its notches');
  for (const b of BADGES) for (const on of [true, false]) assert.doesNotMatch(draw(b.label, on, 3), /7c5cff/i, 'a hard-coded accent');
});

test('no sheen and no turning halo under either motion switch: the sheen is not drawn, the halo holds still', () => {
  // Reintroduce the sheen without its `still` gate: "a still emblem shines" fails.
  const moving = draw('Legend', true, 500, { still: false });
  assert.match(moving, /<rect data-emblem-sheen="true" class="badge-sheen"/);
  assert.match(moving, /data-emblem-halo="true" class="[^"]*badge-halo/);
  const still = draw('Legend', true, 500, { still: true });
  assert.doesNotMatch(still, /data-emblem-sheen|badge-sheen/, 'a still emblem shines');
  assert.match(still, /data-emblem-halo/, 'Legend loses its halo instead of holding it still');
  assert.doesNotMatch(still, /badge-halo/, 'the halo turns under a motion switch');
  assert.doesNotMatch(draw('Reader', false, 3), /data-emblem-sheen/, 'a locked medal shines');
  assert.doesNotMatch(draw('Centurion', true, 100), /data-emblem-halo/, 'only Legend has a halo');
});

test('two emblems never share an id, and every reference finds its own', () => {
  // Reintroduce fixed ids ("g", "rim"…): the second emblem paints with the first one's gradients.
  const html = renderToStaticMarkup(createElement('div', null,
    createElement(BadgeEmblem, { badge: B('Devoted'), earned: true, have: 30, size: 56, still: false }),
    createElement(BadgeEmblem, { badge: B('Devoted'), earned: false, have: 9, size: 56, still: false })));
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, 2 * 7, 'seven defs and the moon\'s mask each');
  assert.equal(new Set(ids).size, ids.length, `ids repeat: ${ids.join(' ')}`);
  for (const ref of html.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids.includes(ref[1]), `url(#${ref[1]}) points nowhere`);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]+$/, `${id} needs quoting in a url()`);
});

test('the goal\'s tab only where there is room: above 40 px, "10" or "7 days"', () => {
  assert.match(draw('Reader', true, 10), /data-emblem-tab[\s\S]*>10<\/text>/);
  assert.match(draw('On a roll', false, 2), /data-emblem-tab[\s\S]*>7 days<\/text>/);
  assert.doesNotMatch(draw('Reader', true, 10, { size: 32 }), /data-emblem-tab/, 'a 32-px emblem keeps its tab');
  assert.doesNotMatch(draw('Reader', true, 10, { detail: false }), /data-emblem-tab/);
});
