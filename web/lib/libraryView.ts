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

/**
 * Where a card in Discover's strip leads: its series once it has one; else its place in the Downloads view --
 * only where that view shows it with a highlight (a download running, or one that failed), or at all (one
 * stopped by its Cancel, listed under Came in today). Otherwise nowhere: a "Nothing yet" add's card that only
 * carries the check of other sources, or a finished one whose series this viewer cannot open, is on no list of
 * that view, and a link would open it on nothing. Reintroduce by linking every card to its folder: "a card the
 * Downloads view does not list leads there anyway" in libraryView.test.ts.
 */
export function stripHref(j: { folder: string; status: string; seriesId?: string | null; cancelled?: boolean }): string | null {
  if (j.seriesId) return `/series/?id=${encodeURIComponent(j.seriesId)}`;
  if (j.status === 'downloading' || j.status === 'error') return downloadsHref(j.folder);
  if (j.cancelled) return downloadsHref();
  return null;
}
