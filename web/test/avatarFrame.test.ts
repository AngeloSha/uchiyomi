// Avatar frames (v0.89.0, #267 part 3 by @CheetahDoesStuff; components/AvatarFrame.tsx): a badge's reward drawn round
// the avatar wherever it shows, in its badge's metal; the ring alone where a face is small, still where nothing may
// move, and nothing at all for a name the app does not know. Plus the picker's wiring by its source.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Avatar } from '../components/Avatar';
import { BADGES, BADGE_METALS, FRAMES, badgeOfFrame, isFrame } from '../lib/badges';

// Under tsx the components compile to the classic `React.createElement`, which they look up as a global.
(globalThis as any).React = React;

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const draw = (avatar: Record<string, unknown> | null, size = 44, frameLocked = false) =>
  renderToStaticMarkup(createElement(Avatar, { avatar: avatar as any, size, frameLocked }));

test('an avatar without a frame draws exactly as it always did', () => {
  const plain = draw({ emoji: '🦊', color: '#7c5cff' });
  assert.doesNotMatch(plain, /data-framed|data-avatar-frame/);
  assert.match(plain, /^<span class="grid shrink-0 place-items-center rounded-full" style="width:44px;height:44px;background:#7c5cff">/,
    'the face is the same element it was, so nothing round an unframed avatar moves');
  // Reintroduce by drawing whatever was stored: "diamond" draws a frame no badge gives.
  assert.equal(draw({ emoji: '🦊', frame: 'diamond' }), draw({ emoji: '🦊' }), 'a frame the app does not know is no frame');
});

test('each badge unlocks the frame cast in its metal, worn on the same box the face takes', () => {
  assert.deepEqual([...FRAMES], BADGES.map((b) => b.metal));
  for (const f of FRAMES) {
    assert.ok(isFrame(f));
    assert.equal(badgeOfFrame(f).metal, f);
    const html = draw({ emoji: '🦊', frame: f });
    assert.match(html, new RegExp(`data-framed="${f}"[^>]*style="width:44px;height:44px"`), `${f}: not on the face's own box`);
    assert.match(html, new RegExp(`data-avatar-frame="${f}"`));
    const [light] = BADGE_METALS[f];
    if (f !== 'aurora') assert.match(html, new RegExp(`stop-color="${light}"`), `${f} is not in its badge's metal`);
    assert.match(html, /inset:-12\.00%/, 'drawn a little past the face, never moving what is round it');
  }
  assert.match(draw({ frame: 'aurora' }), /stop-color="#5ce1ff"/, 'Legend\'s aurora');
});

test('from 40 px a frame wears its trim and moves; below, the ring alone, still', () => {
  const big = draw({ frame: 'gold' }, 44);
  assert.match(big, /data-frame-trim/, 'the laurel');
  assert.match(big, /class="frame-sheen"/);
  // Reintroduce by drawing the trim at every size: a comment's 22 px face wears a laurel it has no room for.
  const small = draw({ frame: 'gold' }, 22);
  assert.doesNotMatch(small, /data-frame-trim|frame-sheen/);
  assert.match(small, /data-frame-ring/);
  assert.match(draw({ frame: 'ember' }, 52), /class="frame-flicker"/, 'On a roll\'s flames');
  assert.equal((draw({ frame: 'ember' }, 52).match(/class="frame-flicker"/g) ?? []).length, 7, 'one flame a day of the streak');
  const legend = draw({ frame: 'aurora' }, 56);
  assert.match(legend, /data-frame-halo/);
  assert.match(legend, /class="frame-spin"/);
});

test('a frame not yet earned, in the picker: greyed, with no glow and nothing moving', () => {
  const locked = draw({ frame: 'moon' }, 40, true);
  assert.match(locked, /data-frame-locked/);
  assert.match(locked, /filter:grayscale\(1\)/);
  assert.doesNotMatch(locked, /frame-sheen|drop-shadow/);
});

test('both motion switches still every frame, in CSS, so no avatar has to be told', () => {
  // Reintroduce by leaving a class out of either rule: a framed avatar keeps moving under Reduce effects.
  const css = read('app/globals.css');
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  for (const c of ['frame-sheen', 'frame-spin', 'frame-halo', 'frame-flicker']) {
    assert.match(css, new RegExp(`html\\.reduce-effects \\.${c}[,\\s{]`), `${c} moves under Reduce effects`);
    assert.match(reduced.slice(0, reduced.indexOf('}\n}') + 3), new RegExp(`\\.${c}\\b`), `${c} moves under reduced motion`);
  }
});

test('the avatar editor offers None and every frame, saves only one that may be worn, and the badges point there', () => {
  const src = read('components/ProfileSettings.tsx');
  assert.match(src, /<Row id="avatar-frame" stacked label=\{tr\('Frame'\)\}/);
  assert.match(src, /data-frame-choice="none" onClick=\{\(\) => saveAvatar\(\{ frame: undefined \}, frameSave\)\}/, 'None takes it off');
  assert.match(src, /onClick=\{\(\) => \{ setAboutFrame\(fr\); if \(ok && !on\) void saveAvatar\(\{ frame: fr \}, frameSave\); \}\}/,
    'a locked frame says what it takes and saves nothing');
  const you = read('components/ProfileYou.tsx');
  assert.match(you, /const FRAMES_HREF = '\/profile\/\?tab=appearance&section=avatar-frame';/);
  assert.match(read('lib/settingsIndex.profile.ts'), /\{ id: 'avatar-frame', cat: 'appearance', label: 'Frame', editor: 'avatar'/);
});
