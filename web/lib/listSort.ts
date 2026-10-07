// Sorting the series inside a list (v0.55.7, #164).
//
// A list arrives whole in one request (GET /api/collections/:id) and is never paged, so the page sorts it here and a
// change of order needs no round trip. Every order leaves its ties in the list's own order, which is also the default:
// a list someone arranged by hand opens the way they left it.
//
// The choice is kept per list, on the account (`listSorts` in /api/settings: list id -> order, `manual` never stored).
// Per list, because lists have purposes -- "Reading now" wants Last read, "Plan to read" A–Z -- and on the account
// because a list is one person's own and the settings row already follows them to their other devices, as the reader's
// defaults do; it needs no new table and no new route. Not in the URL: one place to read it from, and the nav's Lists
// link still opens a list the way it was last sorted.
import { keys } from './i18n';
import { activeLocale } from './format';
import type { Series } from './types';

export type ListSort = 'manual' | 'az' | 'za' | 'read' | 'unread' | 'latest';

// Rendered as `tr(label)`, so the labels are declared rather than inline (lib/i18n.ts). 'A–Z' and 'Most unread' are the
// Library's own words for the same two orders.
const LABELS = keys('Your order', 'A–Z', 'Z–A', 'Last read', 'Most unread', 'Latest chapter');
export const LIST_SORTS: ReadonlyArray<{ key: ListSort; label: string }> = [
  { key: 'manual', label: LABELS[0] },
  { key: 'az', label: LABELS[1] },
  { key: 'za', label: LABELS[2] },
  { key: 'read', label: LABELS[3] },
  { key: 'unread', label: LABELS[4] },
  { key: 'latest', label: LABELS[5] },
];

const isListSort = (v: unknown): v is ListSort => LIST_SORTS.some((s) => s.key === v);

/** How many lists' orders the account keeps: the oldest choice goes first, so the row cannot grow without bound. */
const LIST_SORTS_CAP = 100;

/** A list item: a series as the list route sends it, with the two dates only that route adds. */
export type ListItem = Pick<Series, 'id' | 'name' | 'metadata' | 'booksUnreadCount' | 'yomi' | 'lastReadAt' | 'latestChapterAt'>;

/** The unread badge's own number (components/cards.tsx), so "Most unread" orders by what the covers say. */
const unreadOf = (s: ListItem): number => s.yomi?.unread ?? s.booksUnreadCount ?? 0;
const titleOf = (s: ListItem): string => s.metadata?.title || s.name;
/** Newest first; a series with no date goes after every series with one. */
const newestFirst = (a?: string | null, b?: string | null): number => {
  const x = a ? Date.parse(a) : NaN;
  const y = b ? Date.parse(b) : NaN;
  if (Number.isNaN(x)) return Number.isNaN(y) ? 0 : 1;
  if (Number.isNaN(y)) return -1;
  return y - x;
};

/**
 * The list's items in `sort`'s order. `items` is the list's own order, as the server keeps it, and every tie keeps it:
 * Array.prototype.sort is stable, so two series read the same day, or with the same unread count, stay as the list has
 * them. A copy, always: the caller's array is the query's data.
 *
 * Titles compare in the interface's language, numbers by value ("Vol 2" before "Vol 10"), case and accents aside -- as
 * the Sources tab sorts names (lib/sourcesPanel.ts). "Last read" is the reader's own last read (the server's
 * `lastReadAt`); "Latest chapter" is when the newest chapter arrived (`latestChapterAt`); a series without one goes last.
 */
export function sortList<T extends ListItem>(items: readonly T[], sort: ListSort): T[] {
  const by = (cmp: (a: T, b: T) => number): T[] => [...items].sort(cmp);
  const name = new Intl.Collator(activeLocale(), { numeric: true, sensitivity: 'base' });
  switch (sort) {
    case 'az': return by((a, b) => name.compare(titleOf(a), titleOf(b)));
    case 'za': return by((a, b) => name.compare(titleOf(b), titleOf(a)));
    case 'read': return by((a, b) => newestFirst(a.lastReadAt, b.lastReadAt));
    case 'unread': return by((a, b) => unreadOf(b) - unreadOf(a));
    case 'latest': return by((a, b) => newestFirst(a.latestChapterAt, b.latestChapterAt));
    default: return [...items];
  }
}

/** The order chosen for list `listId`, from the account's settings: the list's own order when none was, or junk was. */
export function listSortOf(settings: Record<string, unknown> | null | undefined, listId: string): ListSort {
  const map = settings?.listSorts;
  const v = map && typeof map === 'object' ? (map as Record<string, unknown>)[listId] : undefined;
  return isListSort(v) ? v : 'manual';
}

/**
 * The account's `listSorts` with list `listId` set to `sort`: what to PUT, whole, since /api/settings merges top-level
 * keys only. `manual` is the default and is not stored; the choice just made goes last, and past LIST_SORTS_CAP the
 * oldest go -- a deleted list's choice among them, in time.
 */
export function withListSort(map: unknown, listId: string, sort: ListSort): Record<string, ListSort> {
  const out: Record<string, ListSort> = {};
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    for (const [k, v] of Object.entries(map)) if (k !== listId && isListSort(v) && v !== 'manual') out[k] = v;
  }
  if (sort !== 'manual') out[listId] = sort;
  const ids = Object.keys(out);
  for (const k of ids.slice(0, Math.max(0, ids.length - LIST_SORTS_CAP))) delete out[k];
  return out;
}
