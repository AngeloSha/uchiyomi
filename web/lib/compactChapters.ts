// The compact chapter list: an opt-in, per-device, denser chapter list for a computer.
//
// From @Squeaks72's #88, which made these rows the DEFAULT on desktop -- no thumbnail, no status dot, the two
// round buttons only on hover. The default look is deliberate and stays everyone's (lib/effects.ts): the thumbnail
// is each chapter's own first page, and it carries the read dimming, the accent progress bar and the dashed box of
// a deleted chapter. So the leaner row is a choice a reader makes, under Profile -> Settings, and with it off every
// class below is exactly what the row had before -- chapterRowClasses.test.ts pins those strings.
//
// "Desktop" is `lg:pointer-fine:`, never `lg:` alone: a tablet in landscape is lg wide with no hovering pointer,
// hover variants never fire there, and buttons faded out by `lg:opacity-0` would be invisible targets on it.

const KEY = 'uchiyomi.compactChapters';

/** Whether this device asked for the compact chapter list. Off unless it did; storage that throws reads as off. */
export function compactChaptersOn(): boolean {
  try { return localStorage.getItem(KEY) === 'on'; } catch { return false; }
}
export function setCompactChaptersOn(on: boolean): void {
  try { if (on) localStorage.setItem(KEY, 'on'); else localStorage.removeItem(KEY); } catch {}
}

/** The row's own line: tighter on a pointer, and a hover group for the buttons. */
export function rowClass(compact: boolean): string {
  return compact
    ? 'group flex items-center gap-3 py-2.5 lg:gap-2.5 lg:pointer-fine:py-1.5'
    : 'flex items-center gap-3 py-2.5 lg:gap-2.5';
}

/** What hides the thumbnail box on a pointer. Never in select mode: the box carries the selection bubble there. */
export function thumbHide(compact: boolean, selectable: boolean): string {
  return compact && !selectable ? ' lg:pointer-fine:hidden' : '';
}

/** What hides the status dot on a pointer, where the title's colour says the same. */
export function dotHide(compact: boolean): string {
  return compact ? ' lg:pointer-fine:hidden' : '';
}

/**
 * The buttons' wrapper, compact only: revealed on hover or keyboard focus, and pinned while a menu is open so the
 * dropdown does not vanish as the pointer leaves for it. With the list NOT compact there is no wrapper at all --
 * an empty one (a row with no buttons) would still take a flex gap and shift the row.
 */
export function buttonsClass(menuOpen: boolean): string {
  return `flex shrink-0 items-center gap-3 lg:gap-2.5 lg:transition-opacity lg:group-hover:opacity-100 lg:group-focus-within:opacity-100 ${menuOpen ? '' : 'lg:pointer-fine:opacity-0'}`;
}
