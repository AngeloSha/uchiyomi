// Keyboard navigation: "g" then a letter goes somewhere (g h Home, g l Library ...), "?" lists them. Pure, so
// which chords exist for whom is testable; components/Shortcuts.tsx binds them.
import { t as tr } from './i18n';
import { downloadsHref } from './libraryView';
import { isTypingTarget } from './typeToSearch';

export interface Chord { key: string; label: string; href: string }
export interface ShortcutCtx { admin: boolean; mayDownload: boolean; desktop: boolean }

/** How long "g" waits for its second key, in ms. */
export const CHORD_MS = 1200;

export function chords(ctx: ShortcutCtx): Chord[] {
  return [
    { key: 'h', label: tr('Home'), href: '/' },
    { key: 'l', label: tr('Library'), href: '/library/' },
    { key: 's', label: tr('Search'), href: '/search/' },
    ...(ctx.mayDownload ? [{ key: 'd', label: tr('Discover'), href: '/discover/' }] : []),
    { key: 'u', label: tr('Updates'), href: '/updates/' },
    { key: 'c', label: tr('Lists'), href: '/collections/' },
    { key: 'f', label: tr('Favorites'), href: '/collection/?id=favorites' },
    { key: 'm', label: tr('Moments'), href: '/moments/' },
    { key: 'y', label: tr('Reading history'), href: '/history/' },
    { key: 'w', label: tr('Wrapped'), href: '/wrapped/' },
    ...(ctx.mayDownload ? [{ key: 'v', label: tr('Library → Downloads'), href: downloadsHref() }] : []),
    // The chapters saved on this device: not on Uchiyomi Desktop, where they are already on the disk.
    ...(ctx.mayDownload && !ctx.desktop ? [{ key: 'o', label: tr('Offline downloads'), href: '/downloads/' }] : []),
    { key: 'p', label: tr('Profile & settings'), href: '/profile/' },
    ...(ctx.admin ? [{ key: 'a', label: tr('Admin'), href: '/admin/' }] : []),
  ];
}

/**
 * Whether a keydown may start or finish a shortcut: nothing modified, nobody typing (an input, a textarea, a select,
 * contentEditable), no open dialog or menu, not mid-composition. `typing` / `modalOpen` are read by the caller.
 */
export function shortcutKeyOk(e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; defaultPrevented?: boolean; repeat?: boolean; isComposing?: boolean; keyCode?: number }, ctx: { typing: boolean; modalOpen: boolean }): boolean {
  if (ctx.typing || ctx.modalOpen) return false;
  if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || e.repeat) return false;
  if (e.isComposing || e.keyCode === 229) return false;
  return true;
}

export { isTypingTarget };
