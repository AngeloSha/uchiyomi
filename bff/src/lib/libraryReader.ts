// A library's reading defaults: the four "look" choices the reader remembers per title, set once for a whole library.
const MODES = ['vertical', 'paged'];
const THEMES = ['amoled', 'sepia', 'gray'];
const DIRECTIONS = ['ltr', 'rtl', 'series'];

export interface LibraryReader { mode?: string; theme?: string; spread?: boolean; pagedDirection?: string }

/** Keeps only valid look keys; null when nothing is left, so a cleared library stores nothing. */
export function cleanLibraryReader(x: unknown): LibraryReader | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const out: LibraryReader = {};
  if (typeof o.mode === 'string' && MODES.includes(o.mode)) out.mode = o.mode;
  if (typeof o.theme === 'string' && THEMES.includes(o.theme)) out.theme = o.theme;
  if (typeof o.spread === 'boolean') out.spread = o.spread;
  if (typeof o.pagedDirection === 'string' && DIRECTIONS.includes(o.pagedDirection)) out.pagedDirection = o.pagedDirection;
  return Object.keys(out).length ? out : null;
}
