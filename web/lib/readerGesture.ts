// What one press on the reader's page track means.
//
// Three actions share that one target -- turn the page, toggle the chrome, zoom -- and only timing tells
// them apart. The reader used to do that arithmetic inline with two constants that disagreed: a single tap
// was acted on after 260 ms, while a second tap still counted as a double for 300 ms. Any double-click whose
// two clicks were 260-300 ms apart therefore did BOTH -- the page turned and then the zoom arrived -- and in
// paged mode the turn is what the reader saw: a double-click to zoom walked them a page on, every time, and
// because the page the reader is on drives the progress ping, the stray turn was also written down as
// reading (a turn onto the last page of a chapter marks the chapter finished).
//
// One window governs both here: a tap is acted on only once a second one can no longer arrive. That is the
// whole invariant, and `singleTapDelay` returning TAP_WINDOW_MS is how a test pins it.
//
// A MOUSE is deliberately not double-detected by this module. The interval that decides what counts as a
// double-click belongs to the operating system -- Windows defaults to 500 ms, twice this window -- and a web
// page cannot read it, so competing with it means guessing. The reader hands mouse doubles to the browser's
// own `dblclick`, which knows the real setting, and uses `undoWindow` below to take back a single-click
// action that had already fired by the time it arrived.

/**
 * How long a tap waits to see whether it is half of a double.
 *
 * Both halves of the gesture, deliberately: the double-tap window AND the delay before a single tap acts.
 * They were separate numbers once, which is the bug this module exists for.
 */
export const TAP_WINDOW_MS = 300;

/** How far a press may travel and still be a tap rather than a scroll. */
export const TAP_SLOP_PX = 10;

/**
 * How long after a single click its effect may still be taken back by a `dblclick`.
 *
 * Generous on purpose: it covers a slow OS double-click setting (Windows' default is 500 ms and it can be
 * set slower still). It only ever undoes an action this module itself scheduled, and only when the browser
 * has just said those two clicks were one gesture, so a long window costs nothing.
 */
export const UNDO_WINDOW_MS = 700;

export interface TapPoint {
  x: number;
  y: number;
  /** ms, as `Date.now()` */
  t: number;
}

/** Which part of the track a tap landed on. In vertical mode only `chrome` is used: nothing turns pages. */
export type TapZone = 'back' | 'forward' | 'chrome';

export type TapAction =
  /** A scroll, a long press, or a pinch that ended: not a tap at all. */
  | { kind: 'none' }
  /** The second tap of a pair. Zoom, and cancel whatever the first one had scheduled. */
  | { kind: 'double' }
  /** A tap that may yet turn out to be the first of a pair, so it acts only after `after` ms. */
  | { kind: 'single'; zone: TapZone; after: number };

/** A press that moved, or was held, is a scroll or a long-press -- never a tap. */
export function isTap(from: TapPoint, to: TapPoint): boolean {
  return Math.abs(to.x - from.x) <= TAP_SLOP_PX
    && Math.abs(to.y - from.y) <= TAP_SLOP_PX
    && to.t - from.t <= TAP_WINDOW_MS;
}

/**
 * The thirds of the track: back | chrome | forward, at 30% and 70%.
 *
 * Physical, not reading-order: an RTL track turns the other way, but the left edge of the screen is still
 * the left edge of the screen. The reader maps the zone through its own direction sign.
 */
export function tapZone(x: number, width: number): TapZone {
  const w = Math.max(1, width);
  if (x < w * 0.3) return 'back';
  if (x > w * 0.7) return 'forward';
  return 'chrome';
}

/** The delay before a single tap may act. Equal to the double window, which is the point of this module. */
export function singleTapDelay(): number {
  return TAP_WINDOW_MS;
}

/**
 * What a press that just ended means.
 *
 * `lastTapAt` is when the previous tap of this pair landed (0 when there is none), and `now` when this one
 * did. `doubleDetect` is false for a mouse, where the browser's `dblclick` owns the pairing.
 */
export function readTap(args: {
  from: TapPoint;
  to: TapPoint;
  width: number;
  lastTapAt: number;
  doubleDetect: boolean;
}): TapAction {
  const { from, to, width, lastTapAt, doubleDetect } = args;
  if (!isTap(from, to)) return { kind: 'none' };
  if (doubleDetect && lastTapAt > 0 && to.t - lastTapAt < TAP_WINDOW_MS) return { kind: 'double' };
  return { kind: 'single', zone: tapZone(to.x, width), after: singleTapDelay() };
}

/** Whether a `dblclick` arriving at `now` should take back a single click's action from `at`. */
export function undoWindow(at: number | null, now: number): boolean {
  return at != null && now - at <= UNDO_WINDOW_MS;
}

/**
 * How much longer, in ms, a single click's action from `at` can still be taken back: above 0 exactly when
 * `undoWindow` says yes. The reader holds a tapped page turn's reading progress for this long, because an
 * undone turn must not have been written down as reading first.
 */
export function undoLeft(at: number | null, now: number): number {
  return at == null ? 0 : Math.max(0, UNDO_WINDOW_MS + 1 - (now - at));
}
