// How the Library lays its series out (v0.60.0): Comfortable (the grid it always had), Compact (more columns, one-line
// titles, smaller badges) or List (a row per series, with its progress written out).
//
// Per DEVICE, in localStorage, like the compact chapter list (lib/compactChapters.ts): a phone held at arm's length and
// a 27-inch screen want different densities from the same account. Read after mount -- the static export renders
// without storage, and the first client render must match it -- and storage that throws reads as the default.
//
// ⚠️ Not `?view=`: that is the page's Series | Downloads switch (lib/libraryView.ts), and a link to Downloads must not
// also say how dense the shelf is.

export const LIBRARY_LAYOUTS = ['comfortable', 'compact', 'list'] as const;
export type LibraryLayout = (typeof LIBRARY_LAYOUTS)[number];

const KEY = 'uchiyomi.libraryView';

const isLayout = (v: unknown): v is LibraryLayout => typeof v === 'string' && (LIBRARY_LAYOUTS as readonly string[]).includes(v);

/** This device's layout. Comfortable unless it chose another; junk and storage that throws read as Comfortable. */
export function libraryLayoutOn(): LibraryLayout {
  try {
    const v = localStorage.getItem(KEY);
    return isLayout(v) ? v : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

/** Remember `v` on this device. Comfortable is the default, so it is stored as nothing at all. */
export function setLibraryLayout(v: LibraryLayout): void {
  try {
    if (v === 'comfortable') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, v);
  } catch { /* a private window: this visit keeps it, the next starts Comfortable */ }
}

/**
 * The grid's own classes per layout. Comfortable is exactly the grid that shipped before v0.60.0 -- its column steps are
 * what layout.mjs measures beside the filter sidebar. Compact is about two columns more per step (one more on a phone,
 * where a fifth column would be thumbnails); List is one column of rows, two side by side once a row would be wider than
 * a sentence. Written out whole: Tailwind only generates a class it can read.
 */
export function gridClass(layout: LibraryLayout): string {
  switch (layout) {
    case 'compact':
      return 'grid grid-cols-4 gap-x-2 gap-y-3.5 px-4 pt-4 sm:grid-cols-6 md:grid-cols-7 lg:grid-cols-7 lg:gap-x-3 lg:px-0 xl:grid-cols-8 2xl:grid-cols-9 3xl:grid-cols-10 4xl:grid-cols-12';
    case 'list':
      return 'grid grid-cols-1 gap-2 px-4 pt-4 lg:px-0 xl:grid-cols-2 xl:gap-x-4 4xl:grid-cols-3';
    default:
      return 'grid grid-cols-3 gap-x-3 gap-y-5 px-4 pt-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-5 lg:gap-x-4 lg:px-0 xl:grid-cols-6 2xl:grid-cols-7 3xl:grid-cols-8 4xl:grid-cols-10';
  }
}
