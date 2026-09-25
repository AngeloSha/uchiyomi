// The source order (bff/src/lib/sourcePrefs.ts), as the two screens that edit it see it: Admin → Settings for
// the server's, and a series' Sources & translations sheet for its own. From @Squeaks72's #93.
//
// ⚠️ EVERY STORED ID IS KEPT, including one no source answers to right now. The list of sources comes from the
// registry, and an extension source is only registered while the extension engine is running: #93 built the
// order from that list, so moving one row during an engine restart saved an order with every extension gone
// from it. An id the registry does not know is shown as unavailable and stays where it was until someone
// removes it.

export interface OrderRow {
  id: string;
  /** The source's name, or null when no loaded source has this id right now. */
  name: string | null;
}

/** The stored order as rows, in order, every stored id kept. */
export function orderRows(order: readonly string[], all: readonly { id: string; name: string }[]): OrderRow[] {
  const names = new Map(all.map((s) => [s.id, s.name] as const));
  return order.map((id) => ({ id, name: names.get(id) ?? null }));
}

/** Sources that can still be added: loaded, and not in the order yet. */
export function addable<T extends { id: string }>(order: readonly string[], all: readonly T[]): T[] {
  return all.filter((s) => !order.includes(s.id));
}

/** Row `i` moved `by` places (±1), or the order unchanged when that would leave the list. */
export function moveIn(order: readonly string[], i: number, by: number): string[] {
  const j = i + by;
  if (i < 0 || i >= order.length || j < 0 || j >= order.length) return [...order];
  const next = [...order];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/**
 * A series' order with `first` at its head and the rest of its sources behind, in their follow order.
 *
 * The whole list, not just the winner: an order naming one source leaves the others unranked, which is
 * fine while the preferred source has a chapter and says nothing when it does not.
 */
export function preferFirst(first: string, follow: readonly string[]): string[] {
  return [first, ...follow.filter((id) => id !== first)];
}
