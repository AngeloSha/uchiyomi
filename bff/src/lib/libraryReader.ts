// A library's reading defaults: the "look" choices the reader remembers per title that describe the CONTENT -- how its
// pages are laid out (mode, pages per view, direction) -- set once for a whole library.
//
// No theme. A theme is a reader's own comfort (sepia at night, true black on OLED), not a fact about the comics, and a
// library default reaches every account that opens one of its series. A value stored or sent with one is dropped here,
// on the way in and on the way out. Reintroduce by accepting `theme`: libraryReader.test.ts "keeps only the content's
// look" fails.
const MODES = ['vertical', 'paged'];
const DIRECTIONS = ['ltr', 'rtl', 'series'];

export interface LibraryReader { mode?: string; spread?: boolean; pagedDirection?: string }

/** Keeps only valid look keys; null when nothing is left, so a cleared library stores nothing. */
export function cleanLibraryReader(x: unknown): LibraryReader | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const out: LibraryReader = {};
  if (typeof o.mode === 'string' && MODES.includes(o.mode)) out.mode = o.mode;
  if (typeof o.spread === 'boolean') out.spread = o.spread;
  if (typeof o.pagedDirection === 'string' && DIRECTIONS.includes(o.pagedDirection)) out.pagedDirection = o.pagedDirection;
  return Object.keys(out).length ? out : null;
}
