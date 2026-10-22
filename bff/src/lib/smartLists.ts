// Smart lists (v0.61.0): a List that is a saved Library search, answered afresh for whoever opens it.
//
// The query is the Library's own URL, word for word (web/lib/libraryQuery.ts writes it, and the Library's address
// reads it back), so "Save as list" keeps exactly the shelf on screen and "Edit filters" reopens it. It is answered by
// the Library's exact search -- content.searchSeries with one card per work -- through the viewer's own ViewCtx: a list
// shared with the household shows each member only what they may open, and "Unread" follows each member's own reading.
import { z } from 'zod';
import { content } from './backend';
import { UnsupportedFilter } from './ownedCatalog';
import type { ViewCtx } from './visibility';

/**
 * The Library's orders (web/lib/librarySort.ts SORTS) and the server's sort string for each, in its natural direction.
 * THE one table: the query's `sort` enum is its keys, and smartLists.test.ts reads librarySort.ts so an order the
 * Library gains without a twin here fails.
 */
export const SMART_SORTS = {
  updated: 'lastModified,desc',
  read: 'lastRead,desc',
  new: 'createdDate,desc',
  // v0.61.0: the release radar's Releasing soon (lane RT), which lane LS's table was written before. A list saved from the
  // Library in that order was refused as a query the Library could not have written.
  soon: 'releasing,asc',
  popular: 'popularity,desc',
  score: 'score,desc',
  rating: 'rating,desc',
  chapters: 'chapters,desc',
  unread: 'unread,desc',
  az: 'metadata.titleSort,asc',
} as const;
export type SmartSort = keyof typeof SMART_SORTS;
const SORT_KEYS = Object.keys(SMART_SORTS) as [SmartSort, ...SmartSort[]];

/** The Library's "No source" (#149), as its URL spells it (web/components/LibraryFilters.tsx NO_SOURCE). */
export const NO_SOURCE = '-';

/**
 * A smart list's query: the Library's URL parameters. Strict -- an unknown key is refused, not stored -- and bounded,
 * because it is kept in the database and replayed into a query on every open.
 */
export const smartQuery = z.object({
  v: z.literal(1),
  q: z.string().trim().min(1).max(200).optional(),
  read: z.enum(['UNREAD', 'IN_PROGRESS', 'READ']).optional(),
  status: z.string().min(1).max(40).optional(),
  genres: z.array(z.string().min(1).max(60)).max(20).optional(),
  lib: z.string().min(1).max(120).optional(),
  src: z.string().min(1).max(120).optional(),
  anysrc: z.string().min(1).max(120).optional(),
  // v0.100.0 (#338): one author, by name, as the series page's link names them (lib/ownedCatalog.ts resolveAuthorNames).
  author: z.string().trim().min(1).max(200).optional(),
  sort: z.enum(SORT_KEYS),
  dir: z.enum(['asc', 'desc']).optional(),
}).strict();
export type SmartQuery = z.infer<typeof smartQuery>;

/** A stored query as it is now, or null for anything that no longer reads as one (an older or hand-edited row). */
export const parseQuery = (raw: unknown): SmartQuery | null => {
  const r = smartQuery.safeParse(raw);
  return r.success ? r.data : null;
};

/**
 * The Library's condition tree for a query: web/lib/libraryQuery.ts conditionFrom, ported in the same order, so a saved
 * list asks the server exactly what the Library asked when it was saved. Undefined when nothing narrows.
 */
export function conditionOf(q: SmartQuery): { allOf: unknown[] } | undefined {
  const all: unknown[] = [];
  if (q.lib) all.push({ libraryId: { operator: 'is', value: q.lib } });
  // "No source" is a condition of its own, never mainSource with the sentinel (#149, ownedCatalog condSql).
  if (q.src === NO_SOURCE) all.push({ hasMainSource: { operator: 'isFalse' } });
  else if (q.src) all.push({ mainSource: { operator: 'is', value: q.src } });
  if (q.anysrc) all.push({ anySource: { operator: 'is', value: q.anysrc } });
  if (q.read) all.push({ readStatus: { operator: 'is', value: q.read } });
  if (q.status) all.push({ status: { operator: 'is', value: q.status } });
  for (const g of q.genres ?? []) all.push({ genre: { operator: 'is', value: g } });
  if (q.author) all.push({ authorName: { operator: 'is', value: q.author } });
  return all.length ? { allOf: all } : undefined;
}

/** The server's sort string for a query: its order's field, in the query's direction or the order's own. */
export function sortOf(q: SmartQuery): string {
  const [field, natural] = SMART_SORTS[q.sort].split(',');
  return `${field},${q.dir ?? natural}`;
}

export interface SmartPage {
  content: any[];
  totalElements: number;
  /** The backend cannot answer this query (a Komga server has no source filters): the list reads as empty. */
  unsupported: boolean;
}

/**
 * One page of a smart list for this viewer: the Library's exact search -- the browsable shelf, the per-viewer reading
 * state, one card per work -- so the list and the Library can never disagree about what a filter means.
 */
export async function evaluate(ctx: ViewCtx, q: SmartQuery, page: number, size: number): Promise<SmartPage> {
  try {
    const res = await content.searchSeries(ctx, { condition: conditionOf(q), fullTextSearch: q.q, collapseEditions: true }, page, size, sortOf(q));
    return { content: res.content ?? [], totalElements: res.totalElements ?? 0, unsupported: false };
  } catch (e) {
    if (e instanceof UnsupportedFilter) return { content: [], totalElements: 0, unsupported: true };
    throw e;
  }
}
