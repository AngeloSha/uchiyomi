/**
 * The notices' rules, apart from React (v0.49.0): how long one stays, how a repeat merges, how many show,
 * and where on the screen they go. components/Toast.tsx draws them; web/test/notices.test.ts holds these.
 *
 * Until v0.49.0 a notice was a capsule at the TOP of the screen, above everything, for 3.2 s whatever it
 * said: over a phone dialog's title it hid what the dialog was, a long error was gone before it was read,
 * and five taps on one key stacked five identical capsules. The owner asked for the pill shapes to go, and
 * that a notice never cover a dialog's title. So a notice is now a card at the BOTTOM edge -- never the
 * top, where every dialog keeps its title -- placed by what lib/layers.ts says is on screen.
 *
 * ⚠️ Every class string here is a literal, for the reason lib/ring.ts gives. The offsets are not classes at
 * all: they are CSS lengths the viewport hands to two custom properties, because a select toolbar's
 * height is measured, not known (the series bar wraps to three rows at 390 px, the library's to two).
 */
import type { Layers } from './layers';
import type { Tone } from './status';

export type NoticeType = 'info' | 'success' | 'error';

/** The optional third argument of `useToast()`'s function. Every caller that passes two still works. */
export interface NoticeOpts {
  /**
   * A notice with the same key takes the place of the one on screen instead of adding a card: "Checking
   * for new chapters…" becomes "Library refreshed" where it stood.
   */
  key?: string;
  /**
   * The work goes on after the notice ("Fetching 3 chapters…"): a small turning ring stands where the glyph
   * would. Said by the caller, never guessed from the words -- a guess from a trailing "…" would depend on
   * the language, and a translation that drops the ellipsis would lose its ring (the critic's ruling).
   */
  busy?: boolean;
  /** How long it stays, in ms. Left out, it follows the length of the message (noticeDuration). */
  duration?: number;
}

export interface Notice {
  id: number;
  msg: string;
  type: NoticeType;
  /** How many times this very message came while it was up, shown as ×n instead of another card. */
  count: number;
  busy: boolean;
  duration: number;
  key?: string;
  /** Moved by a merge or a replacement: restarts the card's clock and its hairline. */
  bump: number;
}

export const NOTICE_MIN_MS = 4000;
export const NOTICE_MAX_MS = 10_000;
export const NOTICE_ERROR_MIN_MS = 6000;
/** At most this many at once. More would climb a phone screen past the thumb, toward the titles. */
export const MAX_NOTICES = 3;

/**
 * How long a notice stays: long enough to read. 3.5 s plus 55 ms a character (about the pace of reading
 * a short sentence), from 4 s to 10 s; an error at least 6 s, because an error is the one a person needs to
 * read to the end and act on. Characters, not UTF-16 units, so an emoji is one.
 */
export function noticeDuration(msg: string, type: NoticeType): number {
  const byLength = Math.min(NOTICE_MAX_MS, Math.max(NOTICE_MIN_MS, 3500 + 55 * [...msg].length));
  return type === 'error' ? Math.max(NOTICE_ERROR_MIN_MS, byLength) : byLength;
}

/**
 * The list after one more notice.
 * - The same key: that notice takes the new words, type and length, and starts its clock again.
 * - The same words in the same tone: one card, counted (×2), its clock started again -- five taps on a key
 *   that refuses are one card that says so five times, not five cards.
 * - Otherwise a new card; the oldest goes once there are more than MAX_NOTICES.
 * A merged or replaced notice keeps its id, so the card on screen is updated rather than replaced, and it
 * moves to the newest place: it is the latest word, and the latest word is the one a dialog lets show.
 */
export function pushNotice(list: readonly Notice[], next: Omit<Notice, 'count' | 'bump'>): Notice[] {
  const same = list.findIndex((n) => (next.key ? n.key === next.key : !n.key && n.msg === next.msg && n.type === next.type));
  if (same >= 0) {
    const old = list[same];
    const merged: Notice = next.key
      ? { ...next, id: old.id, count: 1, bump: old.bump + 1 }
      : { ...old, busy: next.busy, duration: next.duration, count: old.count + 1, bump: old.bump + 1 };
    return [...list.slice(0, same), ...list.slice(same + 1), merged];
  }
  return [...list, { ...next, count: 1, bump: 0 }].slice(-MAX_NOTICES);
}

export function dropNotice(list: readonly Notice[], id: number): Notice[] {
  return list.filter((n) => n.id !== id);
}

/**
 * Where the notices go.
 * - above-nav: a phone page, over the bottom nav.
 * - above-toolbar: a phone page in select mode, over the select bar (measured).
 * - nav-band: a dialog is open and there is a nav. The band the nav takes is the one strip no dialog can
 *   use -- the nav is a root-level layer painted over everything in <main>, where every dialog lives -- so a
 *   notice docked there hides nothing the nav did not already hide. It takes the nav bar's place exactly
 *   (its measured height, its width), so the bar is covered whole rather than half its icons showing.
 * - above-sheet: no nav (the reader), and a sheet that runs to the bottom edge is open (the chapter list,
 *   the page grid, the reader's settings). Docked at the bottom it would sit on the sheet's last rows; it
 *   rises above the sheet's top edge instead, by the sheet's measured reach.
 * - bottom: no nav, and nothing at the bottom edge -- the reader itself, the sign-in screen.
 * The decision is the same at every width; what differs from lg up is only the offset and the corner
 * (noticeOffset), because the bottom nav hides itself there while staying mounted.
 */
export type NoticePlace = 'above-nav' | 'above-toolbar' | 'nav-band' | 'above-sheet' | 'bottom';

export function noticePlace(l: Pick<Layers, 'dialog' | 'nav' | 'toolbar' | 'navBandFree' | 'sheetReach'>): NoticePlace {
  if (l.dialog > 0) {
    if (l.nav > 0) return 'nav-band';
    if (!l.navBandFree && l.sheetReach > 0) return 'above-sheet';
    return 'bottom';
  }
  if (l.toolbar > 0) return 'above-toolbar';
  return l.nav > 0 ? 'above-nav' : 'bottom';
}

/**
 * Over a dialog there is room for one notice, clamped to two lines: the nav band is 5.5 rem, and above a
 * sheet capped at 75 or 85 % of the screen there is little more. The others wait their turn, with their
 * clocks stopped (a card's clock runs only while it shows), so nothing said while a dialog was open is lost
 * unseen. Oldest first: in the bottom-anchored stack the newest is nearest the edge, and the thumb.
 */
export function visibleNotices(list: readonly Notice[], place: NoticePlace): Notice[] {
  return list.slice(-(oneAtATime(place) ? 1 : MAX_NOTICES));
}

export const oneAtATime = (place: NoticePlace): boolean => place === 'nav-band' || place === 'above-sheet';

/**
 * How far above the bottom edge the stack starts, as CSS lengths: `phone` below lg, `wide` from lg up,
 * where the bottom nav hides itself and a select bar sits at the very bottom.
 * - The nav band is 5.75 rem plus the safe area, where the select bars rest on the nav (and 5.5 rem is
 *   what Sheet's `overBottomNav` clears); a notice floats 0.5 rem above it.
 * - A select bar is measured (lib/layers.ts), and the stack goes 0.5 rem above it.
 * - Docked in the nav band, a notice's bottom is the nav bar's: the nav's `.safe-bottom` padding,
 *   max(0.8rem, safe area + 0.4rem), plus its inner `pb-2` (components/BottomNav.tsx).
 * - A reader sheet reports how far up it reaches, and the stack goes 0.75 rem above that.
 * env() is resolved by the browser where the length is used, so these are safe in a custom property.
 */
export function noticeOffset(place: NoticePlace, l: Pick<Layers, 'toolbarHeight' | 'sheetReach'>): { phone: string; wide: string } {
  switch (place) {
    case 'above-nav': return { phone: 'calc(6.25rem + env(safe-area-inset-bottom))', wide: '1.5rem' };
    case 'above-toolbar': return {
      phone: `calc(5.75rem + env(safe-area-inset-bottom) + ${l.toolbarHeight}px + 0.5rem)`,
      wide: `calc(${l.toolbarHeight}px + 0.75rem)`,
    };
    case 'nav-band': return { phone: 'max(1.3rem, calc(env(safe-area-inset-bottom) + 0.9rem))', wide: '1.5rem' };
    case 'above-sheet': return { phone: `calc(${l.sheetReach}px + 0.75rem)`, wide: `calc(${l.sheetReach}px + 0.75rem)` };
    case 'bottom': return { phone: 'max(1rem, env(safe-area-inset-bottom))', wide: '1.5rem' };
  }
}

/**
 * From lg up the stack is a 22 rem column in the bottom-end corner (where the downloads pill was). Beside
 * a centred dialog it narrows to the gutter the dialog leaves: the widest centred panel in the app is 36 rem
 * (a Sheet's max-w-xl; Modal is 28 or 32), so from the viewport's centre that is 18 rem, plus the corner's
 * 1.5 rem and a 0.5 rem gap. At 1024 px that is 12 rem; at 1440 the full 22. Above a reader sheet it keeps
 * its width, because it is already clear of the sheet.
 */
export const WIDE_COLUMN = 'lg:w-[22rem]';
export const WIDE_BESIDE_DIALOG = 'lg:w-[min(22rem,calc(50vw-20rem))]';

export function wideWidth(place: NoticePlace, dialog: number): string {
  return dialog > 0 && place !== 'above-sheet' ? WIDE_BESIDE_DIALOG : WIDE_COLUMN;
}

/** A notice's tone: an error is a problem, a success is the accent's "done" (as Settings' "✓ Saved"), the rest neutral. */
export function noticeTone(type: NoticeType): Tone {
  return type === 'error' ? 'problem' : type === 'success' ? 'accent' : 'info';
}

/**
 * The text for a live region after a new message. A screen reader announces a live region when its text
 * CHANGES, so the same sentence twice in a row (a key pressed twice, a merged notice) would be said once;
 * a zero-width space on every other repeat makes it a change.
 */
export function announceText(prev: string, msg: string): string {
  return prev === msg ? `${msg}\u200b` : msg;
}

/**
 * A notice's clock, which stops while it is hovered, touched, focused or the page is hidden, and carries on
 * from where it stopped. Plain JavaScript and not the hairline's `animationend`: under reduced motion the
 * global CSS rule shortens every animation to 0.001ms, so an animationend clock would end every notice at
 * once. The timer functions are parameters so a test can run it.
 */
export interface Countdown {
  /** Start or resume. Does nothing while running or once ended. */
  run(): void;
  /** Stop, keeping what is left. */
  pause(): void;
  /** Start again from a full `ms` (a merge or a replacement), paused until `run`. */
  reset(ms: number): void;
  left(): number;
}

type SetT = (fn: () => void, ms: number) => unknown;
type ClearT = (id: any) => void;

export function createCountdown(ms: number, onEnd: () => void, setT: SetT = setTimeout, clearT: ClearT = clearTimeout, clock: () => number = Date.now): Countdown {
  let left = ms;
  let started = 0;
  let timer: unknown = null;
  let ended = false;
  const pause = () => {
    if (timer === null) return;
    clearT(timer);
    timer = null;
    left = Math.max(0, left - (clock() - started));
  };
  return {
    run() {
      if (timer !== null || ended) return;
      started = clock();
      timer = setT(() => { timer = null; left = 0; ended = true; onEnd(); }, left);
    },
    pause,
    reset(next) { pause(); left = next; ended = false; },
    left: () => (timer === null ? left : Math.max(0, left - (clock() - started))),
  };
}
