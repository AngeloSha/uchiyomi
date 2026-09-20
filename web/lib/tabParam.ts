// The `?tab=` half of a console's address, as pure functions so a test can call them without a browser.
//
// /admin and /profile are one route each with a tab row on top, and until v0.39.0 the tab lived only in
// component state: a refresh, the back button and every deep link landed on the first tab, and a language
// change -- which remounts the whole subtree, see lib/I18nProvider.tsx -- snapped the profile back to You
// from the very tab that holds the language picker. These two functions are the whole contract between
// the URL and that state; `useTabParam` (lib/useTabParam.ts) is the React wrapper around them.

/** The tab a query value names, or the fallback for anything that is not one of the tabs. */
export const readTab = <T extends string>(v: string | null, tabs: readonly T[], fallback: T): T =>
  typeof v === 'string' && (tabs as readonly string[]).includes(v) ? (v as T) : fallback;

/**
 * `href` with its `tab` set to `tab`.
 *
 * The first tab is the page's own address, so `tab=` is DROPPED when it names the fallback rather than
 * written out: `/admin/` and `/admin/?tab=Overview` must not become two histories of the same screen.
 * Every other parameter survives untouched -- the import page arrives with `card=tracking` beside the tab
 * and a tab switch must not strip it. Returns path + query + hash only: `history.replaceState` takes a
 * relative URL, and the answer is then the same whether the caller passed `location.href` or a bare path.
 */
export function withTab(href: string, tab: string, fallback: string): string {
  const u = new URL(href, 'http://localhost');
  u.searchParams.delete('tab');
  if (tab !== fallback) u.searchParams.append('tab', tab);
  return `${u.pathname}${u.search}${u.hash}`;
}
