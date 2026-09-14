// Which known group names the Settings blocklist and priority offer as chips, and in what order.
//
// A bare text field asked the admin to type a scanlator's name exactly as the source spells it, which is
// the one thing nobody knows without looking. The server keeps every name it has seen; this picks the ones
// worth showing next to what has been typed so far.

import type { KnownGroup } from './types';
import { normGroup } from './scanlators';

/**
 * Up to `limit` known groups matching `draft`, busiest first.
 *
 * Matching is a substring test on `normGroup` -- the SERVER's equality (case, width and punctuation folded)
 * -- so "asura" finds "Asura Scans" and "asura-scans" alike, and a name already placed as a chip is never
 * offered again by that same equality, or the suggestion would add a chip the server folds into the one
 * already there on save. Busiest means chapters on disk plus numbers listed: the group an admin most
 * likely means is the one their library is full of.
 */
export function suggestGroups(known: KnownGroup[], draft: string, exclude: string[], limit = 8): KnownGroup[] {
  const q = normGroup(draft);
  const placed = new Set(exclude.map(normGroup));
  return known
    .filter((g) => {
      const k = normGroup(g.name);
      return !!k && !placed.has(k) && (!q || k.includes(q));
    })
    .sort((a, b) => (b.onDisk + b.listed) - (a.onDisk + a.listed) || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, limit));
}
