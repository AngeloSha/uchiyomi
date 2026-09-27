/**
 * Stable keys for Health rows (v0.49.0).
 *
 * The rows were keyed by their index in the card. A row now holds state of its own -- a Fix working with its
 * clock, a Test's verdict, what the last press did -- and when a re-check removed the row above it (the fixed
 * chapter drops off the list), React handed that state to the next row down: the result of one chapter's Fix
 * landed on another chapter. A key made of what the finding is ABOUT follows the finding wherever it moves.
 *
 * `item.key` comes first: it is the server's own identity for a finding (lib/healthIgnore.ts, and #115's
 * `source:ID`), stable across runs by design.
 */
import type { HealthItem } from './types';

export function itemKey(checkId: string, it: HealthItem): string {
  if (it.key) return it.key;
  if (it.bookId) return `book:${it.bookId}`;
  if (it.bookIds?.length) return `books:${[...it.bookIds].sort().join(',')}`;
  if (it.seriesIds?.length) return `pair:${[...it.seriesIds].sort().join(',')}`;
  if (it.sourceId) return `source:${it.sourceId}`;
  if (it.seriesId) return `series:${it.seriesId}`;
  return `title:${checkId}:${it.title}`;
}

/**
 * Keys for a card's rows, unique within it: a second row with the same identity (two findings about one
 * source, say) gets `#2`, `#3` in the order they come, so a key never collides and the first keeps its own.
 */
export function keysFor(checkId: string, items: readonly HealthItem[]): string[] {
  const seen = new Map<string, number>();
  return items.map((it) => {
    const k = itemKey(checkId, it);
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return n === 1 ? k : `${k}#${n}`;
  });
}
