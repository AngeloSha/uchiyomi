// Type-to-search: on desktop, a letter or digit pressed while nothing is focused for typing opens the
// command palette with that character already in the box, so "start typing a title" just works.
//
// Deliberately narrow. Only letters and digits count -- punctuation keeps any meaning a page may give it
// ("/" already opens the palette empty, and Space scrolls). Any modifier except Shift means a shortcut, not
// text. A key another handler already claimed (defaultPrevented), an IME mid-composition, and any open
// modal (`aria-modal="true"`: Modal, ConfirmDialog, ConsoleNav's sheet) are left alone -- a keystroke there
// belongs to the dialog, and a palette opening over it would steal focus from a half-filled form.

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  repeat?: boolean;
}

const TYPEABLE = /^[\p{L}\p{N}]$/u;

/** The character to seed the palette with, or null when this key should be left to the page. */
export function typeToSearchKey(e: KeyLike, ctx: { typing: boolean; modalOpen: boolean }): string | null {
  if (ctx.typing || ctx.modalOpen) return null;
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.defaultPrevented || e.repeat) return null;
  return TYPEABLE.test(e.key) ? e.key : null;
}

/** An element that takes typed text, so keys pressed there are the element's, not the palette's. */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const h = el as HTMLElement;
  return h.tagName === 'INPUT' || h.tagName === 'TEXTAREA' || h.tagName === 'SELECT' || !!h.isContentEditable;
}
