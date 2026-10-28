// Opening the command palette from anywhere that is not the keyboard: a phone has no Ctrl+K or "/", so the
// search page carries a button, and a button cannot reach AppShell's state. AppShell listens
// for this event (components/AppShell.tsx); the palette itself stays where it was.
export const PALETTE_EVENT = 'uchiyomi:palette';

/** Ask the shell to open the command palette, optionally with text already in its box. */
export function openPalette(seed = ''): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<string>(PALETTE_EVENT, { detail: seed }));
}
