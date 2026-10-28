/**
 * More of a search on one source (v0.96.0, #331), the React-free half: which source a search asked alone, whether it may
 * load another page, and which cards of a page are new, so a test can hold the rules without a browser.
 *
 * Why: a site pages its search. BatCave answers ten at a time and has 209 for "Star Trek", and Discover showed the first
 * ten. A search across every source still shows each one's first page -- another page of all of them would be a dozen
 * more requests per scroll -- but a search on one source (the one chosen with the source chip, or the only one there is)
 * loads its next page as the wall is scrolled, the way Newest does.
 */
import type { SourceItem } from '@/components/cards';

/** A single-source search response knows its source from the request, not from each result. */
export type SourcePageItem = Omit<SourceItem, 'source'>;

/** Bind later pages to the source that was asked, as the grouped first page already does. */
export function sourcePageCards(source: string, items: readonly SourcePageItem[]): SourceItem[] {
  return items.map((item) => ({ ...item, source }));
}

/** The furthest page a search on one source is scrolled to: the server's own cap (bff routes/sources.ts SEARCH_MAX_PAGE). */
export const SEARCH_MAX_PAGE = 30;

/** Keep the search's field on later pages; omitting it changes an author query into a title query. */
export function sourceSearchPage(source: string, term: string, page: number, kind: 'title' | 'author' | 'artist' = 'title'): string {
  return `/api/sources/search?source=${encodeURIComponent(source)}&q=${encodeURIComponent(term)}&page=${page}${kind === 'title' ? '' : `&creator=${kind}`}`;
}

/**
 * The one source a search asked: the chosen one, or the only source the answer says it asked (a skipped source was not).
 * Null for a search across several.
 */
export function soloSource(selected: string | null, asked: ReadonlyArray<{ id: string; state: string }> | undefined): string | null {
  if (selected) return selected;
  const lines = (asked ?? []).filter((s) => s.state !== 'skipped');
  return lines.length === 1 ? lines[0].id : null;
}

/** What a search on one source has loaded past its first page. `key` is the search it belongs to; another key is none. */
export interface SearchMore { key: string; items: SourceItem[]; page: number; done: boolean }
export const noMore = (key = ''): SearchMore => ({ key, items: [], page: 1, done: false });

/**
 * Whether the next page may be asked: a search on one source that pages (`pages`), under the "All" 18+ filter (the later
 * pages are filtered by the account's age limit only), with every source answered, a first page that had something, and
 * neither the end nor the cap reached.
 */
export function canSearchMore(o: {
  solo: string | null; pages: boolean; rating: string; pending: number; firstPage: number; more: SearchMore; busy: boolean;
}): boolean {
  return !!o.solo && o.pages && o.rating === 'all' && o.pending === 0 && o.firstPage > 0
    && !o.more.done && !o.busy && o.more.page < SEARCH_MAX_PAGE;
}

/**
 * The cards of a later page not on the wall already, by source and id. An answer with none ends the search: a site past
 * its last page answers nothing, and one that ignores the page number answers its first page again.
 */
export function freshCards(shown: ReadonlyArray<Pick<SourceItem, 'source' | 'sourceId'>>, page: readonly SourceItem[]): SourceItem[] {
  const seen = new Set(shown.map((it) => `${it.source}:${it.sourceId}`));
  const out: SourceItem[] = [];
  for (const it of page) {
    const k = `${it.source}:${it.sourceId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}
