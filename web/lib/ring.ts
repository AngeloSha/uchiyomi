/**
 * The progress ring's geometry and vocabulary, with no React in it (v0.49.0, "no more pills").
 *
 * One ring serves every surface that shows work in progress: the Library tab while the server downloads, a
 * cover in the Downloads view filling like an app install, a Health row while its repair runs. Five drafts
 * of this release each drew their own ring with its own API; this is the one that exists
 * (components/ProgressRing.tsx draws it), so the "app install" look is the same wherever it appears.
 *
 * ⚠️ Every class string here is a literal. Tailwind v4 compiles only class names it can find in source
 * (app/globals.css scans lib/), so a class assembled as `text-${tone}-400` would produce no rule at all.
 */
import { t as tr } from './i18n';

/**
 * The four sizes, each fitted to what it wraps:
 * - nav: 30 px around the BottomNav's 22 px icon, 4 px clear of it on every side, so the tab does not move;
 * - bar: 40 px, the TopNav's round buttons, whose border the ring replaces;
 * - row: 18 px, beside a line of text;
 * - cover: 56 px, centred on a cover in the Downloads view.
 */
export const RING_SIZES = {
  nav: { px: 30, stroke: 2 },
  bar: { px: 40, stroke: 2 },
  row: { px: 18, stroke: 2.5 },
  cover: { px: 56, stroke: 3.5 },
} as const;

export type RingSize = keyof typeof RING_SIZES | number;

/**
 * What the ring shows, said explicitly rather than with a nullable number: a fraction fills it, `'spin'`
 * turns an arc (the amount of work is not known yet), `'idle'` draws the track alone. With `null` meaning
 * one and `undefined` the other, a single wrong fallback shows an empty ring for a job that has simply not
 * sized itself yet.
 */
export type RingValue = number | 'spin' | 'idle';

export type RingTone = 'accent' | 'amber' | 'red' | 'muted';

/** A size's pixels and stroke. A bare number is a custom size whose stroke scales with it. */
export function ringDims(size: RingSize): { px: number; stroke: number } {
  if (typeof size === 'number') {
    const px = Number.isFinite(size) && size > 0 ? size : RING_SIZES.row.px;
    return { px, stroke: Math.max(1.5, Math.round((px / 8) * 2) / 2) };
  }
  return RING_SIZES[size] ?? RING_SIZES.row;
}

/** The circle inside a `px` box with a `stroke` line: its radius, circumference and centre. */
export function ringGeometry(px: number, stroke: number): { r: number; c: number; center: number } {
  const r = (px - stroke) / 2;
  return { r, c: 2 * Math.PI * r, center: px / 2 };
}

/** A fraction to draw, clamped to 0..1; anything that is not a finite number is `null` (nothing to draw). */
export function clampProgress(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(1, Math.max(0, v));
}

/** The stroke-dashoffset that shows `v` of a circle of circumference `c`, starting at the top. */
export function dashOffset(c: number, v: number): number {
  return c * (1 - v);
}

/**
 * done / total as a ring value. A total of 0 is a job that has not sized itself yet (lib/jobs.ts reads
 * "0 of 0" the same way), so it turns rather than showing an empty ring that looks like nothing is
 * happening; more done than total (a count that moved under us) is a full ring, never an overdrawn one.
 */
export function ringFraction(done: number, total: number): RingValue {
  if (!Number.isFinite(total) || total <= 0) return 'spin';
  return clampProgress(done / total) ?? 0;
}

/** The count beside a ring: nothing at 0, and never more than three characters, so the tag keeps its shape. */
export function ringCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  return n > 99 ? '99+' : String(Math.floor(n));
}

/** What a screen reader says for a sized ring ("3 of 10"); nothing for one that has not sized itself. */
export function ringValueText(done: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '';
  return tr('{done} of {total}', { done: Math.min(done, total), total });
}

/**
 * The dash pattern of the still ring: the circle drawn as short, evenly spaced dashes, which reads as
 * "working" without anything moving. Drawn where the arc would turn but motion is off (Reduce effects, or
 * the system's reduced-motion setting), and on a still ring by request (the slow archive's calm mark).
 *
 * Sized from the circumference, one dash about every 5 px (8 to 32 of them), so the 18 px row ring and
 * the 56 px cover ring look like the same pattern rather than a dotted line and a dashed one.
 */
export function stillDash(c: number): string {
  const n = Math.min(32, Math.max(8, Math.round(c / 5)));
  const seg = c / n;
  const dash = +(seg * 0.5).toFixed(3);
  return `${dash} ${+(seg - dash).toFixed(3)}`;
}

/**
 * What a ring may do, given the two motion settings and its own `static` flag. The ONE rule for every ring
 * in the app (components/ProgressRing.tsx is its only reader):
 * - it turns only when neither Reduce effects (`plain`) nor the system's reduced-motion setting (`still`) is
 *   on, and it is not static; otherwise an indeterminate ring is the still dashed circle;
 * - its fill eases between values under the same condition;
 * - the glow and the comet tail are finish, and Reduce effects -- the switch that owns the finish -- drops
 *   them; reduced motion alone keeps the glow, which does not move.
 *
 * The owner's default for v0.49.0: stop under EITHER setting. The switch's help text promises that
 * "transitions" go, and the clock and the step text beside a ring still say the work is moving.
 */
export function ringMotion(plain: boolean, still: boolean, isStatic = false): { turn: boolean; ease: boolean; glow: boolean; tail: boolean } {
  const moving = !plain && !still && !isStatic;
  return { turn: moving, ease: moving, glow: !plain, tail: moving };
}

/** The arc's colour per tone. `currentColor` on the stroke picks it up. */
export const ARC_CLASS: Record<RingTone, string> = {
  accent: 'text-accent',
  amber: 'text-amber-400',
  red: 'text-red-400',
  muted: 'text-fog-500',
};

/** The track under the arc: faint on the page, lighter over a cover, where the veil darkens what is behind. */
export const TRACK_CLASS = 'text-fog-500/25';
export const COVER_TRACK_CLASS = 'text-white/15';

/** The glow under a lit arc (dropped under Reduce effects, like every other glow the switch owns). */
export const GLOW: Record<RingTone, string> = {
  accent: 'rgb(var(--accent) / 0.55)',
  amber: 'rgb(251 191 36 / 0.45)',
  red: 'rgb(248 113 113 / 0.45)',
  muted: 'rgb(111 111 129 / 0.3)',
};
