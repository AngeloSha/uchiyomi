// The progress ring (v0.49.0): one ring for the Library tab, the Downloads view's covers and Health's rows.
//
// The geometry is run as plain functions; the components are rendered to markup with react-dom/server, so
// what is asserted is what a browser would receive, not how the source happens to be written. Reduced
// motion is framer-motion's own state (its `prefersReducedMotion`), set here the way a matchMedia answer
// would set it. Reduce effects cannot be set in a server render (its store answers `false` there, by
// design), so its half of the one motion rule is held by `ringMotion` itself plus a guard that the ring
// feeds it the switch. Every guard names the edit that makes it fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { hasReducedMotionListener, prefersReducedMotion } from 'framer-motion';
import {
  RING_SIZES, clampProgress, dashOffset, ringCount, ringDims, ringFraction, ringGeometry, ringMotion, ringValueText,
  stillDash,
} from '../lib/ring';
import { CoverProgress, ProgressRing, RingIcon } from '../components/ProgressRing';

// Under tsx the components compile to the classic `React.createElement` (tsconfig's `jsx: preserve` is for
// Next), which they look up as a global when they render.
(globalThis as any).React = React;

const ROOT = join(__dirname, '..');
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const html = (el: React.ReactElement) => renderToStaticMarkup(el);

/** Render with the system's reduced-motion setting on (and without framer-motion's console note about it). */
function reducedMotion<T>(fn: () => T): T {
  const was = [hasReducedMotionListener.current, prefersReducedMotion.current] as const;
  const warn = console.warn;
  console.warn = (...a: unknown[]) => { if (!/Reduced Motion enabled/.test(String(a[0]))) warn(...a); };
  hasReducedMotionListener.current = true;
  prefersReducedMotion.current = true;
  try { return fn(); } finally {
    [hasReducedMotionListener.current, prefersReducedMotion.current] = was;
    console.warn = warn;
  }
}

/* ================================================================ lib/ring.ts */

test('a job that has not sized itself turns instead of showing an empty ring', () => {
  // lib/jobs.ts reads "0 of 0" as unsized. Reintroduce by returning 0 for a zero total: the first line fails.
  assert.equal(ringFraction(0, 0), 'spin', 'a job that has not sized itself shows an empty ring');
  assert.equal(ringFraction(3, NaN), 'spin');
  assert.equal(ringFraction(3, 10), 0.3);
  assert.equal(ringFraction(12, 10), 1, 'a count that moved under us overdraws the ring');
  assert.equal(ringFraction(0, 10), 0);
});

test('the geometry: clamped fractions, the offset that shows them, and a nav ring that clears its icon', () => {
  assert.equal(clampProgress(NaN), null);
  assert.equal(clampProgress('0.5'), null);
  assert.equal(clampProgress(-1), 0);
  assert.equal(clampProgress(1.4), 1);
  const { r, c, center } = ringGeometry(30, 2);
  assert.equal(r, 14);
  assert.equal(center, 15);
  assert.ok(Math.abs(c - 2 * Math.PI * 14) < 1e-9);
  assert.ok(Math.abs(dashOffset(c, 0.25) - 0.75 * c) < 1e-9);
  assert.equal(RING_SIZES.nav.px - 22, 8, 'the nav ring no longer clears the 22 px tab icon by 4 px a side');
  assert.equal(RING_SIZES.bar.px, 40, 'the bar ring is no longer the 40 px of the header buttons it borders');
  assert.deepEqual(ringDims('cover'), { px: 56, stroke: 3.5 });
  assert.deepEqual(ringDims(12), { px: 12, stroke: 1.5 });
});

test('the count keeps its shape: nothing at 0, never more than three characters', () => {
  assert.equal(ringCount(0), '');
  assert.equal(ringCount(-2), '');
  assert.equal(ringCount(7), '7');
  assert.equal(ringCount(99), '99');
  assert.equal(ringCount(120), '99+');
  assert.equal(ringValueText(3, 10), '3 of 10');
  assert.equal(ringValueText(0, 0), '', 'an unsized ring has no value to read out');
});

test('the still ring is one pattern at every size', () => {
  for (const size of ['row', 'nav', 'bar', 'cover'] as const) {
    const { px, stroke } = RING_SIZES[size];
    const { c } = ringGeometry(px, stroke);
    const [dash, gap] = stillDash(c).split(' ').map(Number);
    const n = c / (dash + gap);
    assert.ok(n >= 7.99 && n <= 32.01, `${size}: ${n} dashes`);
    assert.ok(Math.abs(dash - gap) < 0.01, `${size}: dashes and gaps differ (${dash} / ${gap})`);
  }
});

test('ONE motion rule: a ring turns only with neither Reduce effects nor reduced motion, and never when static', () => {
  // The owner's default for v0.49.0. Reintroduce the first draft's rule -- the turn kept under Reduce
  // effects (`turn: !still && !isStatic`) -- and "the ring turns under Reduce effects" fails.
  assert.deepEqual(ringMotion(false, false), { turn: true, ease: true, glow: true, tail: true });
  assert.equal(ringMotion(true, false).turn, false, 'the ring turns under Reduce effects');
  assert.equal(ringMotion(false, true).turn, false, 'the ring turns under prefers-reduced-motion');
  assert.equal(ringMotion(false, false, true).turn, false, 'a static ring turns');
  assert.equal(ringMotion(true, false).glow, false, 'the glow stays on under Reduce effects');
  assert.equal(ringMotion(true, false).tail, false, 'the comet tail stays on under Reduce effects');
  assert.equal(ringMotion(true, false).ease, false, 'the fill still eases under Reduce effects');
  assert.equal(ringMotion(false, true).glow, true, 'reduced motion alone took the glow, which does not move');
});

/* ================================================================ ProgressRing, rendered */

test('an indeterminate ring turns by default, and is a still dashed circle under reduced motion', () => {
  // The global reduced-motion rule shortens an infinite animation to 0.001ms without stopping it, so a
  // spinner under it jitters. Reintroduce by always adding `animate-ring` (dropping `anim.turn`): "the ring
  // spins under prefers-reduced-motion" fails.
  const on = html(createElement(ProgressRing, { progress: 'spin' }));
  assert.match(on, /data-ring="spin"/);
  assert.match(on, /class="[^"]*\banimate-ring\b/, 'the ring no longer turns by default');
  const still = reducedMotion(() => html(createElement(ProgressRing, { progress: 'spin' })));
  assert.doesNotMatch(still, /animate-ring/, 'the ring spins under prefers-reduced-motion (the global 0.001ms rule makes it jitter)');
  assert.match(still, /data-ring="still"/);
  assert.match(still, /stroke-dasharray="[\d.]+ [\d.]+" stroke-opacity="0.7"/, 'the still ring is not the dashed circle');
  assert.doesNotMatch(still, /transition-\[stroke-dashoffset\]/);
});

test('a static ring never turns: the slow archive\'s calm mark', () => {
  // Reintroduce by ignoring `static` in ringMotion: "a static ring turns" fails, and so does this render.
  const s = html(createElement(ProgressRing, { progress: 'spin', static: true, tone: 'amber' }));
  assert.doesNotMatch(s, /animate-ring/);
  assert.match(s, /data-ring="still"/);
  const v = html(createElement(ProgressRing, { progress: 0.4, static: true, tone: 'amber' }));
  assert.doesNotMatch(v, /transition-\[stroke-dashoffset\]/, 'a static ring still eases its fill');
  assert.match(v, /text-amber-400/);
});

test('ProgressRing reads both motion settings, unconditionally, and feeds them to the one rule', () => {
  // A server render cannot switch Reduce effects on, so this half is read from source. Reintroduce by
  // writing `const plain = false` or `useReduceEffects() || useReducedMotion()`: this fails.
  const src = code(readFileSync(join(ROOT, 'components/ProgressRing.tsx'), 'utf8'));
  const body = src.slice(src.indexOf('export function ProgressRing('), src.indexOf('export function RingIcon('));
  assert.match(body, /const plain = useReduceEffects\(\);\s*const still = useReducedMotion\(\);\s*const anim = ringMotion\(plain, !!still, isStatic\);/,
    'ProgressRing does not feed both settings to ringMotion');
  assert.equal((body.match(/animate-ring/g) || []).length, 1, 'animate-ring is applied somewhere without asking ringMotion');
  assert.match(body, /spin && anim\.turn \? 'animate-ring' : ''/, 'animate-ring is applied without asking ringMotion');
  assert.match(body, /anim\.glow \? \{ filter:/, 'the glow is not gated on ringMotion');
  assert.match(body, /anim\.ease \? 'transition-\[stroke-dashoffset\]/, 'the fill easing is not gated on ringMotion');
  assert.match(body, /anim\.tail && <circle/, 'the tail is not gated on ringMotion');
});

test('a determinate ring fills from the top, and is a named progressbar only when it has a label', () => {
  // Reintroduce by always giving it role=progressbar: the unlabelled render fails ("an unnamed progressbar").
  const bare = html(createElement(ProgressRing, { progress: 0.3 }));
  assert.match(bare, /aria-hidden="true"/);
  assert.doesNotMatch(bare, /role="progressbar"/, 'an unnamed progressbar');
  assert.match(bare, /class="block -rotate-90/, 'the ring no longer starts at the top');
  const named = html(createElement(ProgressRing, { progress: 0.3, label: 'Fetching', valueText: '3 of 10' }));
  assert.match(named, /role="progressbar" aria-label="Fetching" aria-valuemin="0" aria-valuemax="100" aria-valuenow="30" aria-valuetext="3 of 10"/);
  const spin = html(createElement(ProgressRing, { progress: 'spin', label: 'Fetching' }));
  assert.match(spin, /role="progressbar"/);
  assert.doesNotMatch(spin, /aria-valuenow/, 'an indeterminate ring claims a value');
  const zero = html(createElement(ProgressRing, { progress: 0 }));
  assert.match(zero, /stroke-opacity="0"/, 'a round cap draws a dot at 0 %');
  const idle = html(createElement(ProgressRing, { progress: 'idle' }));
  assert.equal((idle.match(/<circle/g) || []).length, 1, 'an idle ring draws more than its track');
});

/* ================================================================ RingIcon and CoverProgress */

test('RingIcon: a squared count, an amber dot, nothing at all on an idle nav tab', () => {
  // Reintroduce the round count (`rounded-full px-1`) and "the count is a capsule" fails.
  const busy = html(createElement(RingIcon, { progress: 0.5, size: 'nav', count: 120, attention: true, srLabel: 'Library — fetching', children: 'icon' }));
  const tag = busy.match(/<span aria-hidden="true" data-ring-count="true" class="([^"]*)">([^<]*)<\/span>/);
  assert.ok(tag, 'no count tag');
  assert.doesNotMatch(tag![1], /rounded-full/, 'the count is a capsule');
  assert.match(tag![1], /rounded-\[4px\]/, 'the count lost its squared corners');
  assert.equal(tag![2], '99+');
  assert.match(busy, /data-ring-attention="true" class="[^"]*h-1\.5 w-1\.5 rounded-full bg-amber-400/, 'no amber attention dot');
  assert.match(busy, /<span class="sr-only">Library — fetching<\/span>/);
  assert.match(busy, /pointer-events-none absolute -inset-1/, 'the nav ring is not absolutely placed around the icon');
  assert.doesNotMatch(busy, /role="progressbar"/, 'a progressbar nested inside the tab\'s link');
  const idleNav = html(createElement(RingIcon, { progress: 'idle', size: 'nav', children: 'icon' }));
  assert.doesNotMatch(idleNav, /<svg/, 'an idle nav tab wears a ring');
  assert.doesNotMatch(idleNav, /data-ring-count|data-ring-attention/);
  const idleBar = html(createElement(RingIcon, { progress: 'idle', size: 'bar', children: 'icon' }));
  assert.match(idleBar, /-inset-\[10\.5px\]/);
  assert.match(idleBar, /data-ring="idle"/, 'the idle desktop button lost its outline track');
});

test('RingIcon: a static ring is the slow archive\'s still mark, with its glyph in the count\'s corner', () => {
  // The owner: "Library ring during a slow archive: a calm, still slow mark. The ring animates only for
  // normal downloads." Reintroduce by not passing `static` through to the ring: "the Library ring turns
  // during a slow archive" fails.
  const slow = html(createElement(RingIcon, { progress: 'spin', size: 'nav', tone: 'amber', static: true, glyph: createElement('i', { 'data-slow': '' }), children: 'icon' }));
  assert.doesNotMatch(slow, /animate-ring/, 'the Library ring turns during a slow archive');
  assert.match(slow, /data-ring="still"/, 'the Library ring turns during a slow archive');
  const filling = html(createElement(RingIcon, { progress: 0.4, size: 'nav', tone: 'amber', static: true, children: 'icon' }));
  assert.doesNotMatch(filling, /transition-\[stroke-dashoffset\]|animate-ring/, 'a static Library ring eases its fill');
  assert.match(slow, /<span aria-hidden="true" data-ring-glyph="true" class="[^"]*text-amber-400[^"]*"><i data-slow=""><\/i><\/span>/, 'the slow mark has no glyph');
  // A count wins the corner: the glyph is for the archive alone.
  const both = html(createElement(RingIcon, { progress: 'spin', size: 'nav', count: 3, glyph: createElement('i', { 'data-slow': '' }), children: 'icon' }));
  assert.doesNotMatch(both, /data-ring-glyph/, 'the glyph covers the count');
  assert.match(both, /data-ring-count/);
  // And a normal download still turns.
  assert.match(html(createElement(RingIcon, { progress: 'spin', size: 'nav', children: 'icon' })), /animate-ring/);
});

test('CoverProgress: a veil and a ring per state, a glyph slot, a still amber ring for the slow archive, a check when done', () => {
  const running = html(createElement(CoverProgress, { state: 'running', progress: 0.4, caption: '4/10', label: 'Fetching 4 of 10 chapters' }));
  assert.match(running, /role="img" aria-label="Fetching 4 of 10 chapters"/);
  assert.match(running, /bg-ink-950\/45/);
  assert.match(running, /<span>4\/10<\/span>/);
  assert.match(running, /text-white\/15/, 'the cover ring lost its light track');
  assert.doesNotMatch(running, /backdrop-/, 'a blurred veil on every cover is what #71 measured as slow');
  // #117: queued in the slow archive, a still amber ring with its own glyph. Reintroduce by not passing
  // `static` through to the ring: the easing class comes back and this fails.
  const archive = html(createElement(CoverProgress, { state: 'waiting', progress: 0.25, tone: 'amber', static: true, label: 'Archiving slowly', glyph: createElement('i', { 'data-slow': '' }) }));
  assert.match(archive, /text-amber-400/);
  assert.doesNotMatch(archive, /transition-\[stroke-dashoffset\]|animate-ring/, 'the slow archive\'s ring moves');
  assert.match(archive, /<i data-slow="">/, 'the glyph slot is ignored');
  // An archive whose chapter list is not read yet ('spin'): the still dashed circle, as its sheet and band draw it,
  // never a turn. Reintroduce the waiting state's 'idle' for every non-number: a bare track, "nothing done".
  const unread = html(createElement(CoverProgress, { state: 'waiting', progress: 'spin', tone: 'amber', static: true, label: 'Archiving slowly' }));
  assert.match(unread, /data-ring="still"/, 'an archive not sized yet shows a bare track, unlike its sheet and band');
  assert.doesNotMatch(unread, /animate-ring/, 'the slow archive\'s cover turns');
  const queued = html(createElement(CoverProgress, { state: 'waiting', label: 'Queued' }));
  assert.match(queued, /data-ring="idle"/, 'a queued cover without a fraction shows one');
  // A queued download is not "working": without `static` a 'spin' stays the bare track, never a turn in Queued.
  assert.match(html(createElement(CoverProgress, { state: 'waiting', progress: 'spin', label: 'Queued' })), /data-ring="idle"/, 'a queued cover turns');
  assert.match(queued, /M12 7v5l3 2/, 'a queued cover has no clock');
  const attention = html(createElement(CoverProgress, { state: 'attention', label: 'Failed' }));
  assert.match(attention, /text-red-400/);
  const done = html(createElement(CoverProgress, { state: 'done', label: 'Done' }));
  assert.doesNotMatch(done, /data-ring=|bg-ink-950\/(45|65|70|60)/, 'a finished cover keeps its veil and ring');
  assert.match(done, /rounded-md bg-ink-950\/80 text-accent/, 'a finished cover has no check');
});

test('the cover veil appears and leaves without motion under either setting', () => {
  // The critic's list of animated surfaces that must honour the switch. Reintroduce by writing
  // `initial={{ opacity: 0 }}`: this fails.
  const src = code(readFileSync(join(ROOT, 'components/ProgressRing.tsx'), 'utf8'));
  const body = src.slice(src.indexOf('export function CoverProgress('));
  assert.match(body, /const plain = useReduceEffects\(\);\s*const still = useReducedMotion\(\);\s*const reduced = plain \|\| !!still;/);
  assert.match(body, /initial=\{reduced \? false : \{ opacity: 0 \}\}/, 'the veil fades in under Reduce effects');
  assert.match(body, /transition=\{reduced \? \{ duration: 0 \} : \{ duration: 0\.45/, 'the veil fades out under Reduce effects');
});
