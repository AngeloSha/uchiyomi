// Discover's rows inside the wall (v0.98.0). The owner: the picks rows "push down the newest and popular section too much".
// So the wall starts under the search, and the rows sit inside it: the picks row after the wall's first two rows of covers,
// then each trending row four rows further on -- where, at the very end of a wall of every source's newest, almost nobody
// had ever scrolled to them. Pure, so where a row lands is tested without a browser (test/shelves.test.ts).
//
// The wall's one rule holds: nothing already on screen moves. A row takes its place once and keeps it, and a row whose
// answer comes after the wall has filled past the places in front takes the next place below the covers already shown.
import { useEffect, useState } from 'react';

/** Rows of covers before the first of Discover's rows, and between one place and the next. */
export const FIRST_ROWS = 2;
export const EVERY_ROWS = 4;

/** Where place `j` is: how many covers come before it, in a wall `cols` across. */
export const placeAt = (j: number, cols: number): number => Math.floor(cols) * (FIRST_ROWS + EVERY_ROWS * j);

/**
 * Which place each row holds: the ones it held already, and for a row new to the wall the first free place at or past the
 * covers already shown (`shown`) -- in front of them there is no room without moving one. Rows no longer given are dropped.
 * A wall not measured yet (`cols` under 1) places nothing new.
 */
export function placeRows<K>(placed: ReadonlyMap<K, number>, rows: readonly K[], shown: number, cols: number): Map<K, number> {
  const next = new Map<K, number>();
  for (const k of rows) { const j = placed.get(k); if (j !== undefined) next.set(k, j); }
  if (!(Math.floor(cols) >= 1)) return next;
  const taken = new Set(next.values());
  for (const k of rows) {
    if (next.has(k)) continue;
    let j = 0;
    // Reintroduce the place in front of what is shown (drop `placeAt(j, cols) < shown`): "a row that comes late takes a
    // place below what is on screen" in shelves.test.ts fails -- the row lands among covers being read and moves them down.
    while (taken.has(j) || placeAt(j, cols) < shown) j++;
    next.set(k, j);
    taken.add(j);
  }
  return next;
}

/** A run of the wall's cards, `from` up to `to` (as slice), or one of the rows between them. */
export type WallPart<K> = { kind: 'cards'; from: number; to: number } | { kind: 'row'; key: K };

/**
 * The wall of `count` cards laid `cols` across, cut where its placed rows go, and the rows it has not reached yet.
 *
 * A row joins its place only once the wall has filled that far; until then it waits after the wall -- in order, where it
 * would sit anyway, below the last card. The cards always come first and last: the wall's last run holds what is still
 * loading.
 */
export function weave<K>(count: number, cols: number, placed: ReadonlyMap<K, number>): { parts: WallPart<K>[]; after: K[] } {
  const parts: WallPart<K>[] = [];
  const after: K[] = [];
  let from = 0;
  for (const [key, j] of [...placed.entries()].sort((a, b) => a[1] - b[1])) {
    const at = placeAt(j, cols);
    // Reintroduce a row placed before the wall has filled to it: "a row waits until the wall has filled to its place" in
    // shelves.test.ts fails.
    if (!(Math.floor(cols) >= 1) || after.length || at > count) { after.push(key); continue; }
    parts.push({ kind: 'cards', from, to: at }, { kind: 'row', key });
    from = at;
  }
  parts.push({ kind: 'cards', from, to: count });
  return { parts, after };
}

/**
 * How many columns a CSS grid lays out now: its computed `grid-template-columns`, read again whenever it resizes. The
 * wall's classes stay the one place its columns are decided; 0 until it has been measured. Takes the element itself (a
 * callback ref's), not a ref object: the wall mounts after the page's first answers, and an effect keyed on a ref object
 * would have looked once, at nothing, and never again.
 */
export function useGridCols(el: HTMLElement | null): number {
  const [cols, setCols] = useState(0);
  useEffect(() => {
    if (!el) return;
    const read = () => {
      const tracks = getComputedStyle(el).gridTemplateColumns;
      setCols(tracks && tracks !== 'none' ? tracks.trim().split(/\s+/).length : 0);
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return cols;
}
