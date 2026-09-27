'use client';
// The progress ring, and the two things built from it (v0.49.0, "no more pills").
//
// One ring for every surface that shows work in progress: the Library tab and the desktop's downloads
// button while the server fetches (RingIcon), a cover in the Downloads view filling like an app install
// (CoverProgress), a Health row while its repair runs. lib/ring.ts holds the geometry and the colours.
//
// ⚠️ MOTION. The ring turns only when nothing asked for stillness: under EITHER Reduce effects or the
// system's reduced-motion setting it draws a still dashed circle instead, and the live clock and step text
// beside it still say the work is moving. Checked here in JS, because the global reduced-motion rule
// (app/globals.css, pinned by effects.test.ts) shortens an infinite animation to 0.001ms without stopping
// it -- a spinner under that rule jitters instead of resting. Reduce effects also drops the glow, the comet
// tail and the fill's easing, as its help text promises ("the animated background, blur, smooth scrolling
// and transitions").
//
// A ring is a clock, so it fills clockwise from the top in every language, Arabic included: nothing here is
// mirrored.
import type { AriaAttributes, CSSProperties, ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useReduceEffects } from '@/lib/effects';
import {
  ARC_CLASS, COVER_TRACK_CLASS, GLOW, TRACK_CLASS, clampProgress, dashOffset, ringCount, ringDims, ringGeometry,
  ringMotion, stillDash, type RingSize, type RingTone, type RingValue,
} from '@/lib/ring';
import { IcAlert, IcCheck, IcClock } from './icons';

export interface ProgressRingProps {
  progress: RingValue;
  size?: RingSize;
  tone?: RingTone;
  /** Makes it a named progressbar. Without one the ring is decoration and hidden from screen readers. */
  label?: string;
  /** "3 of 10", for the progressbar's aria-valuetext. */
  valueText?: string;
  className?: string;
  /** Drawn over a cover: a lighter track, which the veil under it keeps readable. */
  onCover?: boolean;
  /**
   * Still on purpose, whatever the motion settings: no turn and no easing. The slow archive's calm mark --
   * the owner asked that a series fetched over days never animate the ring.
   */
  static?: boolean;
}

export function ProgressRing({ progress, size = 'row', tone = 'accent', label, valueText, className, onCover, static: isStatic }: ProgressRingProps) {
  // Both hooks on every render and in this order: `a() || b()` would skip the second whenever the first is
  // true, and a hook that is sometimes not called breaks every hook after it.
  const plain = useReduceEffects();
  const still = useReducedMotion();
  const anim = ringMotion(plain, !!still, isStatic);
  const { px, stroke } = ringDims(size);
  const { r, c, center } = ringGeometry(px, stroke);
  const spin = progress === 'spin';
  const v = typeof progress === 'number' ? (clampProgress(progress) ?? 0) : null;
  const a11y: AriaAttributes & { role?: string } = label
    ? {
      role: 'progressbar', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100,
      // An indeterminate progressbar has no value at all, rather than a 0 that says nothing has happened.
      'aria-valuenow': v === null ? undefined : Math.round(v * 100),
      'aria-valuetext': valueText || undefined,
    }
    : { 'aria-hidden': true };
  const circle = { cx: center, cy: center, r, fill: 'none', stroke: 'currentColor', strokeWidth: stroke };
  const glow: CSSProperties | undefined = anim.glow ? { filter: `drop-shadow(0 0 3px ${GLOW[tone]})` } : undefined;
  return (
    <span {...a11y} className={`inline-block shrink-0 leading-none ${className ?? ''}`} style={{ width: px, height: px }}
      data-ring={spin ? (anim.turn ? 'spin' : 'still') : v === null ? 'idle' : 'value'}>
      {/* The turn is on the ROOT svg, so the compositor runs it without repainting the arc. */}
      <svg width={px} height={px} viewBox={`0 0 ${px} ${px}`} className={`block -rotate-90 overflow-visible ${spin && anim.turn ? 'animate-ring' : ''}`}>
        <circle {...circle} className={onCover ? COVER_TRACK_CLASS : TRACK_CLASS} />
        {v !== null && (
          <circle {...circle} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={dashOffset(c, v)}
            // A round cap draws a dot at 0 %: nothing started reads as nothing drawn.
            strokeOpacity={v === 0 ? 0 : 1}
            className={`${ARC_CLASS[tone]} ${anim.ease ? 'transition-[stroke-dashoffset] duration-700 ease-[cubic-bezier(0.22,1,0.36,1)]' : ''}`}
            style={glow} />
        )}
        {spin && anim.turn && (
          <>
            {/* A faint tail behind the arc's head, so the turn reads as a direction and not a flicker. */}
            {anim.tail && <circle {...circle} strokeLinecap="round" strokeDasharray={`${c * 0.14} ${c}`} strokeOpacity={0.35} className={ARC_CLASS[tone]} />}
            <circle {...circle} strokeLinecap="round" strokeDasharray={`${c * 0.28} ${c}`} strokeDashoffset={-c * 0.14}
              className={ARC_CLASS[tone]} style={glow} />
          </>
        )}
        {spin && !anim.turn && (
          <circle {...circle} strokeDasharray={stillDash(c)} strokeOpacity={0.7} className={ARC_CLASS[tone]} />
        )}
      </svg>
    </span>
  );
}

/**
 * An icon wearing a ring: the Library tab on a phone (`nav`, 30 px around its 22 px icon) and the desktop
 * header's downloads button (`bar`, 40 px, where the ring takes the place of the button's round border).
 *
 * The ring is absolutely positioned, so the nav keeps the height the select toolbars are placed against.
 * The count is a small SQUARED tag -- a round one grows into a capsule at "9+", which the owner ruled out --
 * and `attention` is a 6 px amber dot for something that failed. Everything visual is aria-hidden; the
 * state reaches a screen reader as `srLabel`, inside the link's own name, rather than as a progressbar
 * nested in a link.
 */
export function RingIcon({ children, progress, count, tone = 'accent', size, srLabel, attention }: {
  children: ReactNode;
  progress: RingValue;
  count?: number;
  tone?: RingTone;
  size: 'nav' | 'bar';
  srLabel?: string;
  attention?: boolean;
}) {
  // An idle nav tab is just its icon; an idle desktop button keeps its round outline as the track.
  const ring = progress !== 'idle' || size === 'bar';
  const n = ringCount(count ?? 0);
  return (
    <span className="relative inline-grid place-items-center" data-ring-icon={size}>
      {children}
      {ring && (
        <span aria-hidden className={`pointer-events-none absolute ${size === 'nav' ? '-inset-1' : '-inset-[10.5px]'}`}>
          <ProgressRing progress={progress} size={size} tone={tone} />
        </span>
      )}
      {n && (
        <span aria-hidden data-ring-count
          className={`absolute -end-3 -top-2 min-w-[14px] rounded-[4px] bg-ink-950 px-[3px] text-center text-[9px] font-bold leading-[13px] tabular-nums ring-1 ring-current/35 ${ARC_CLASS[tone]}`}>
          {n}
        </span>
      )}
      {attention && (
        <span aria-hidden data-ring-attention className="absolute -bottom-1 -end-1 h-1.5 w-1.5 rounded-full bg-amber-400 ring-2 ring-ink-950" />
      )}
      {srLabel && <span className="sr-only">{srLabel}</span>}
    </span>
  );
}

export type CoverState = 'running' | 'waiting' | 'paused' | 'attention' | 'done';

// How dark the veil is per state: lightest while it fills, so the cover still reads as the series.
const VEIL: Record<Exclude<CoverState, 'done'>, string> = {
  running: 'bg-ink-950/45',
  waiting: 'bg-ink-950/65',
  paused: 'bg-ink-950/70',
  attention: 'bg-ink-950/60',
};

/**
 * The "app install" veil over a cover in the Downloads view. Put it inside a `relative overflow-hidden`
 * cover. While the series downloads the cover dims under a 56 px ring; when it is done the veil fades away,
 * as an installed app's icon does, and a small check stays in the corner.
 *
 * - running: the ring shows `progress` (a fraction, or 'spin' before the job has sized itself);
 * - waiting: queued. A clock, or `glyph`; a fraction when there is one (the slow archive's progress);
 * - paused: a muted track;
 * - attention: a full red ring and a warning sign;
 * - `static`: never turns or eases -- the slow archive's still amber mark (#117).
 *
 * No backdrop-filter on the veil: thirty blurred covers in one grid is what #71 measured as slow in Firefox.
 */
export function CoverProgress({ state, progress = 'spin', caption, label, tone, glyph, static: isStatic }: {
  state: CoverState;
  progress?: RingValue;
  /** Centre text, "4/10". */
  caption?: string;
  /** What a screen reader hears for the whole cover: "Fetching 4 of 10 chapters". */
  label: string;
  tone?: RingTone;
  /** A glyph for the centre in place of the state's own (the slow archive's mark). */
  glyph?: ReactNode;
  static?: boolean;
}) {
  const plain = useReduceEffects();
  const still = useReducedMotion();
  const reduced = plain || !!still;
  const ring: { value: RingValue; tone: RingTone } =
    state === 'running' ? { value: progress, tone: tone ?? 'accent' }
    : state === 'waiting' ? { value: typeof progress === 'number' ? progress : 'idle', tone: tone ?? 'accent' }
    : state === 'attention' ? { value: 1, tone: 'red' }
    : { value: 'idle', tone: 'muted' };
  const centre = glyph
    ?? (state === 'waiting' ? <IcClock width={18} height={18} /> : state === 'attention' ? <IcAlert width={18} height={18} className="text-red-300" /> : null);
  return (
    <div role="img" aria-label={label} data-cover-state={state} className="pointer-events-none absolute inset-0">
      <AnimatePresence initial={false}>
        {state !== 'done' && (
          <motion.div key="veil" className={`absolute inset-0 grid place-items-center ${VEIL[state]}`}
            initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={reduced ? { duration: 0 } : { duration: 0.45, ease: [0.22, 1, 0.36, 1] }}>
            <span className="relative grid place-items-center">
              <ProgressRing progress={ring.value} size="cover" tone={ring.tone} onCover static={isStatic} />
              <span className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 text-[11px] font-semibold tabular-nums text-fog-50 [text-shadow:0_1px_4px_rgb(0_0_0/0.8)]">
                {centre}
                {caption && <span>{caption}</span>}
              </span>
            </span>
          </motion.div>
        )}
      </AnimatePresence>
      {state === 'done' && (
        <span className="absolute bottom-1.5 end-1.5 grid h-5 w-5 place-items-center rounded-md bg-ink-950/80 text-accent">
          <IcCheck width={12} height={12} strokeWidth={2.6} />
        </span>
      )}
    </div>
  );
}
