// Right-click and long-press menus for series and chapters (#100, @Squeaks72's proposal): the pure parts.
//
// Everything a series can have done to it lived on its page, one load away from wherever the series was on
// screen. components/ContextMenu.tsx is one menu, opened four ways -- right-click, a press-and-hold on a
// touchscreen, the row's own ⋯ button, and Shift+F10 / the Menu key -- and every surface contributes its own
// short list of items to it.
//
// Taking the browser's menu away is what annoys exactly the people who use a browser on purpose, so it is
// taken only where there is nothing of the browser's worth keeping: never on selected text, never in a text
// field, never with Shift held (the convention for "give me the real one"), and not at all on this device
// once the switch under Profile -> Settings -> Appearance is off. The cards are links, so the menu offers
// the two things the browser's would have: Open in a new tab and Copy link.

const KEY = 'uchiyomi.contextMenus';

/** On unless this device switched it off. Storage that throws reads as on: the menus are the default. */
export function contextMenusOn(): boolean {
  try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; }
}
export function setContextMenusOn(on: boolean): void {
  try { if (on) localStorage.removeItem(KEY); else localStorage.setItem(KEY, 'off'); } catch { /* private window */ }
}

/** How long a finger must stay down, and how far it may drift, for a press to be a long-press. */
export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP = 10;

/**
 * Whether a right-click here should open OUR menu, or be left to the browser's.
 *
 * `selection` is the page's selected text, and `inSelection` whether the click landed inside it: selected text
 * is copied from the browser's menu, and taking that away is the annoyance this is careful about.
 */
export function wantsOwnMenu(e: { shiftKey: boolean; editable: boolean; selection: string; inSelection: boolean }, enabled: boolean): boolean {
  if (!enabled || e.shiftKey || e.editable) return false;
  if (e.selection.trim() && e.inSelection) return false;
  return true;
}

/**
 * Where the menu goes: at the point, flipped to the other side of it at a viewport edge, and never closer to an
 * edge than `margin` (the safe-area insets on a phone are about that).
 */
export function placeMenu(
  at: { x: number; y: number },
  size: { w: number; h: number },
  viewport: { w: number; h: number },
  margin = 8,
): { left: number; top: number } {
  let left = at.x + size.w + margin > viewport.w ? at.x - size.w : at.x;
  let top = at.y + size.h + margin > viewport.h ? at.y - size.h : at.y;
  left = Math.max(margin, Math.min(left, viewport.w - size.w - margin));
  top = Math.max(margin, Math.min(top, viewport.h - size.h - margin));
  return { left, top };
}
