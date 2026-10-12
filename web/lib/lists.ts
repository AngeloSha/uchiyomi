// A reader's Lists as the app shows them (v0.61.0): their own, hand-picked or smart, and the household's shared ones.
//
// GET /api/collections?scope=all (bff lib/lists.ts listsFor) answers them all, counted for this viewer. It has its own
// query key, ['lists-all'], and never ['collections']: that key is the plain answer -- this reader's hand-picked lists
// alone -- which the series page's "Add to collection" sheet offers, and one key must mean one shape
// (test/queryKeys.test.ts says why).
import type { SmartQuery } from './libraryQuery';

/** The colours a list can carry: the New collection dialog's and Save as list's swatches. */
export const ACCENTS = ['#7c5cff', '#ff4dd2', '#22d3ee', '#34d399', '#fbbf24', '#f87171'] as const;

export interface ListOwner { id: string; name: string; avatar?: { emoji?: string; color?: string } | null }

/** One row of GET /api/collections?scope=all. */
export interface ListRow {
  id: string;
  name: string;
  accent: string | null;
  sort_order: number;
  /** How many series it shows this reader. */
  item_count: number;
  kind?: 'manual' | 'smart';
  shared?: boolean;
  /** Absent from a server older than v0.61.0, where every list is the reader's own. */
  mine?: boolean;
  owner?: ListOwner;
  query?: SmartQuery;
}

/** The list's own, or -- from an older server, which only ever sent the reader's own -- every one. */
export const isMine = (l: Pick<ListRow, 'mine'>): boolean => l.mine !== false;

/**
 * The lists on Home, in their order: the account's explicit choice -- ids it can no longer read dropped, the order
 * kept -- or, with no choice made, the reader's own first three lists that hold something (the pre-v0.55.8 rule; a
 * list someone else shares never fills a slot nobody chose for it). At most three.
 */
export function homeIdsOf(saved: unknown, lists: ReadonlyArray<Pick<ListRow, 'id' | 'item_count' | 'mine'>>): string[] {
  const ids = Array.isArray(saved)
    ? saved.filter((id): id is string => typeof id === 'string' && lists.some((c) => c.id === id))
    : lists.filter((c) => isMine(c) && Number(c.item_count) > 0).map((c) => c.id);
  return ids.slice(0, 3);
}
