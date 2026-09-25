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
  keyCode?: number;
  defaultPrevented?: boolean;
  repeat?: boolean;
}

const TYPEABLE = /^[\p{L}\p{N}]$/u;

/** The character to seed the palette with, or null when this key should be left to the page. */
export function typeToSearchKey(e: KeyLike, ctx: { typing: boolean; modalOpen: boolean }): string | null {
  if (ctx.typing || ctx.modalOpen) return null;
  if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || e.repeat) return null;
  // Mid-composition, in every spelling a browser uses: Safari reports an IME keystroke as keyCode 229 with
  // key "Process" and no isComposing.
  if (e.isComposing || e.keyCode === 229 || e.key === 'Process') return null;
  return TYPEABLE.test(e.key) ? e.key : null;
}

/**
 * The text to open the palette with, for this key under this interface language.
 *
 * With nothing focused the browser does not route keys through the input method at all, so under a Japanese or
 * Chinese interface the palette used to open holding the raw Latin letter, and the IME then composed the rest
 * after it -- "w" + "あんぴーす". There it opens EMPTY and focused, and the IME composes the title properly
 * from the next keystroke.
 */
export function seedFor(ch: string, lang: string): string {
  return /^(ja|zh)(-|$)/i.test(lang) ? '' : ch;
}

const OFF_KEY = 'uchiyomi.typeToSearch';

/**
 * Whether single-key search shortcuts (type-to-search and "/") are on, on THIS device.
 *
 * WCAG 2.1.4: a shortcut made of one character key has to be possible to turn off -- a speech-input user or
 * anyone with a tremor sets them off by accident. Per device rather than per account: whether a keyboard is at
 * hand is a property of the device. Ctrl/Cmd+K is not a single-key shortcut and stays.
 */
export function typeToSearchOn(): boolean {
  try { return localStorage.getItem(OFF_KEY) !== 'off'; } catch { return true; }
}
export function setTypeToSearchOn(on: boolean): void {
  try { if (on) localStorage.removeItem(OFF_KEY); else localStorage.setItem(OFF_KEY, 'off'); } catch {}
}

/** An element that takes typed text, so keys pressed there are the element's, not the palette's. */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const h = el as HTMLElement;
  return h.tagName === 'INPUT' || h.tagName === 'TEXTAREA' || h.tagName === 'SELECT' || !!h.isContentEditable;
}
