import { readTab } from './tabParam';

/**
 * The Library page's two views (v0.49.0): the series grid, and Library -> Downloads, what the server is
 * fetching. One page with a switch rather than a second route, because the owner asked for the switch on the
 * Library page -- and the view lives in the URL (`/library/?view=downloads`, with `&folder=` to point at one
 * series), so Back from a series opened in Downloads comes back to Downloads, and the add dialog, the series
 * band, the palette, the desktop's header button and Discover can all link straight to it.
 */
export const LIBRARY_VIEWS = ['series', 'downloads'] as const;
export type LibraryView = (typeof LIBRARY_VIEWS)[number];

/**
 * The view a `?view=` value names. Downloads only for a viewer who may download: the route behind it refuses
 * everyone else, so for them the address shows the series, as a hand-typed `?view=junk` does.
 */
export function readView(v: string | null, mayDownload: boolean): LibraryView {
  return mayDownload ? readTab(v, LIBRARY_VIEWS, 'series') : 'series';
}

/** The address of the Downloads view, pointing at one series when there is one to point at. */
export function downloadsHref(folder?: string | null): string {
  return folder ? `/library/?view=downloads&folder=${encodeURIComponent(folder)}` : '/library/?view=downloads';
}
