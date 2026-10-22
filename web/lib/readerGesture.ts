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

/** How far apart two touch taps may land and still be a double-tap: the same spot, not two thumbs-widths away. */
export const DOUBLE_TAP_SLOP_PX = 48;

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

/**
 * Which part of the track a tap landed on, and so what it does.
 *
 * `back` and `forward` are PHYSICAL -- the left and the right of the screen -- and the reader turns them through the
 * track's direction, as it always has: on a right-to-left read the left edge goes forward. `prev` and `next` (v0.61.0)
 * are reading order, whichever way the track runs: the L shape's and the Kindle-style map's, as Mihon draws them,
 * where the bottom of the screen is the next page in either direction. `chrome` shows or hides the controls.
 */
export type TapZone = 'back' | 'forward' | 'prev' | 'next' | 'chrome';

/**
 * Where taps turn the page (v0.61.0, Reader → Tap zones, per device):
 *  - `auto`, the reader as it always was: paged, the left and right thirds turn and the middle shows the controls;
 *    the webtoon column turns nothing, every tap is the controls.
 *  - `edges`: the thirds, in both modes -- in the column the left third scrolls back and the right third on.
 *  - `lshape`: Mihon's L. The top row and the middle-left cell go back, the bottom row and the middle-right cell go on.
 *  - `kindle`: the top third shows the controls, a narrow left column goes back, everything else goes on.
 *  - `off`: no tap turns anything; every tap is the controls.
 */
export type TapLayout = 'auto' | 'edges' | 'lshape' | 'kindle' | 'off';
export const TAP_LAYOUTS: readonly TapLayout[] = ['auto', 'edges', 'lshape', 'kindle', 'off'];

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
 * What a tap at (`x`, `y`) on a `width` x `height` track does, under `layout`, in `mode`.
 *
 * The thirds are back | chrome | forward at 30 % and 70 %: physical, not reading order -- an RTL track turns the other
 * way, but the left edge of the screen is still the left edge of the screen, and the reader maps the zone through its
 * own direction sign. The L and the Kindle-style map divide the screen into thirds both ways (33 % and 66 %, Mihon's).
 * A track not measured yet (zero wide or tall) is never divided by zero: it is taken as one pixel.
 */
export function tapZone(x: number, y: number, width: number, height: number, layout: TapLayout = 'auto', mode: 'paged' | 'vertical' = 'paged'): TapZone {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const thirds = (): TapZone => (x < w * 0.3 ? 'back' : x > w * 0.7 ? 'forward' : 'chrome');
  if (layout === 'off') return 'chrome';
  if (layout === 'auto') return mode === 'paged' ? thirds() : 'chrome';
  if (layout === 'edges') return thirds();
  const col = x < w * 0.33 ? 0 : x < w * 0.66 ? 1 : 2;
  const row = y < h * 0.33 ? 0 : y < h * 0.66 ? 1 : 2;
  if (layout === 'lshape') {
    if (row === 0 || (row === 1 && col === 0)) return 'prev';
    if (row === 2 || (row === 1 && col === 2)) return 'next';
    return 'chrome';
  }
  // kindle
  if (row === 0) return 'chrome';
  return col === 0 ? 'prev' : 'next';
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
  /** The track's height, for a layout that divides it top to bottom (v0.61.0). */
  height?: number;
  /** Reader → Tap zones on this device, and the mode it reads in (v0.61.0): `auto` in paged mode is the thirds. */
  layout?: TapLayout;
  mode?: 'paged' | 'vertical';
  lastTapAt: number;
  /** Where that previous tap landed. Without it any two quick taps count, wherever they are. */
  lastTapPoint?: { x: number; y: number };
  doubleDetect: boolean;
  /** When the last double (touch or mouse) was recognised; 0 when there is none. */
  lastDoubleAt?: number;
}): TapAction {
  const { from, to, width, height = 0, layout = 'auto', mode = 'paged', lastTapAt, lastTapPoint, doubleDetect, lastDoubleAt = 0 } = args;
  if (!isTap(from, to)) return { kind: 'none' };
  // ⚠️ A third press right behind a double is the tail of the same flurry, not a new single. Without this a
  // triple-click (or a triple-tap) zoomed and then, 300 ms later, turned a page: the double reset the pairing
  // state, so the third press looked like the first of a fresh gesture.
  if (lastDoubleAt > 0 && to.t - lastDoubleAt < TAP_WINDOW_MS) return { kind: 'none' };
  const zone = tapZone(to.x, to.y, width, height, layout, mode);
  // ⚠️ A double-tap zooms, and only from the middle of the screen, on the spot of the first tap. Two quick taps on
  // the page-turning edge are two TURNS (a thumb paging through a chapter does exactly that), and two taps far
  // apart are two taps. Before this they zoomed the page, which in paged mode could not be panned.
  const near = !lastTapPoint || (Math.abs(to.x - lastTapPoint.x) <= DOUBLE_TAP_SLOP_PX && Math.abs(to.y - lastTapPoint.y) <= DOUBLE_TAP_SLOP_PX);
  if (doubleDetect && lastTapAt > 0 && to.t - lastTapAt < TAP_WINDOW_MS && near && zone === 'chrome') return { kind: 'double' };
  return { kind: 'single', zone, after: singleTapDelay() };
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

/**
 * A press that lands while the track is still moving is the reader stopping a fling, not asking for anything.
 * On a phone, catching a webtoon mid-scroll is the most common touch there is, and it used to toggle the
 * interface every time.
 */
export const CATCH_MS = 160;
export function isCatch(lastMovedAt: number, now: number): boolean {
  return lastMovedAt > 0 && now - lastMovedAt < CATCH_MS;
}
