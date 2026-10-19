// A reader's own say on where a double-page spread is (v0.89.0, #262 by @Squeaks72, rebuilt on v0.77.0's joining).
//
// The server's detector finds the two halves of a spread a source served as two pages (`join` on the first page, bff
// lib/spreadJoin.ts). It is good, not perfect: it joins pairs that are not spreads and misses ones that are. So a reader
// can say otherwise about the pair (page, page + 1) of a chapter: `join` shows them as one spread where it found none,
// `split` shows a pair it joined as two pages (bff lib/spreadMarks.ts). Per account: nobody else's reader changes.
//
// The marks ride on the page list as `mark` (and in a download's manifest), and are applied to the flow once it is built
// (applyMarks), so the pairing rules in lib/readerSpread.ts know of them only that a reader's own join holds with Join
// split double pages off (`forced`): they asked for that one.
import { api } from './api';

export type SpreadMark = 'join' | 'split';

interface Markable { ci: number; number: number; join?: 'rtl' | 'ltr'; mark?: SpreadMark; forced?: boolean }

/**
 * `items` with the reader's marks applied: a `join` mark joins its page to the next, drawn the `dir` way -- 'rtl' (the
 * second page on the left) for a right-to-left track or series, as a spread is one drawing and reads from the right --
 * and a `split` mark takes the detector's join off its page. The very array when nothing is marked, so a flow memoised
 * on it does not change.
 *
 * A page is in one spread only: a reader's join on page N takes the detector's join off page N - 1 (it would end in N)
 * and off page N + 1 (N's second half would start another spread). Reintroduce by dropping that: "a page is in one
 * spread only" in spreadMarks.test.ts joins page 5 twice.
 */
export function applyMarks<T extends Markable>(items: T[], dir: 'rtl' | 'ltr'): T[] {
  if (!items.some((it) => it.mark)) return items;
  const ownJoins = new Set(items.filter((it) => it.mark === 'join').map((it) => `${it.ci}:${it.number}`));
  return items.map((it): T => {
    if (it.mark === 'join') return { ...it, join: dir, forced: true };
    if (it.join && (it.mark === 'split' || ownJoins.has(`${it.ci}:${it.number - 1}`) || ownJoins.has(`${it.ci}:${it.number + 1}`))) {
      return { ...it, join: undefined };
    }
    return it;
  });
}

/**
 * What a reader may do about the page being read. `first` is the number of the first page of the pair concerned.
 * - `split`: the detector joined this pair; show it as two pages.
 * - `unmerge`: the reader joined it; take it apart again.
 * - `restore`: the reader split a pair the detector joined; join it again.
 * - `merge`: join this page with its neighbour on that side of the screen.
 */
export type SpreadOption =
  | { kind: 'split' | 'unmerge' | 'restore'; first: number }
  | { kind: 'merge'; side: 'left' | 'right'; first: number };

interface Page extends Markable { width?: number | null; height?: number | null; missing?: boolean }

const wide = (p: Page) => typeof p.width === 'number' && typeof p.height === 'number' && p.width > 0 && p.height > 0 && p.width > p.height;

/**
 * The options at flow index `at`, from what is on screen: `flat` is the flow with the marks applied, `slide` the flow
 * indexes on the slide being read and `joined` whether that slide is a joined pair (lib/readerSpread.ts pairSlides).
 * `nextIsLeft`: the track runs right to left, so the next page is the one on the left -- left and right are always the
 * sides of the screen. `detector`: Join split double pages is on, so a pair the reader split can be given back to it.
 *
 * A joined pair offers only its way apart. A page on its own offers to join a neighbour in its chapter, the page before
 * or after it by number, when neither is wide (a wide page is a spread already) or a placeholder. Reintroduce by
 * offering the next page as "right" on a right-to-left track: "left and right are the screen's" in spreadMarks.test.ts.
 */
export function spreadOptions(
  flat: readonly Page[], at: number, view: { slide: readonly number[]; joined: boolean; nextIsLeft: boolean; detector: boolean },
): SpreadOption[] {
  const me = flat[at];
  if (!me) return [];
  if (view.joined && view.slide.length === 2) {
    const a = flat[view.slide[0]];
    return a ? [{ kind: a.forced ? 'unmerge' : 'split', first: a.number }] : [];
  }
  if (wide(me) || me.missing) return [];
  const out: SpreadOption[] = [];
  const prev = flat[at - 1], next = flat[at + 1];
  const pairs = (p: Page | undefined, n: number): p is Page => !!p && p.ci === me.ci && p.number === n && !wide(p) && !p.missing;
  if (view.detector) {
    if (me.mark === 'split' && next?.ci === me.ci) out.push({ kind: 'restore', first: me.number });
    else if (prev?.mark === 'split' && prev.ci === me.ci && prev.number === me.number - 1) out.push({ kind: 'restore', first: prev.number });
  }
  const before = pairs(prev, me.number - 1) ? { kind: 'merge' as const, side: view.nextIsLeft ? 'right' as const : 'left' as const, first: prev!.number } : null;
  const after = pairs(next, me.number + 1) ? { kind: 'merge' as const, side: view.nextIsLeft ? 'left' as const : 'right' as const, first: me.number } : null;
  // Left first, as the two keys sit on the screen.
  for (const m of [before, after].filter((x) => !!x).sort((x, y) => (x!.side === 'left' ? -1 : 1) - (y!.side === 'left' ? -1 : 1))) out.push(m!);
  return out;
}

/** The mark an option writes: null clears the reader's mark, and the detector's answer stands. */
export const markOf = (o: SpreadOption): SpreadMark | null => (o.kind === 'split' ? 'split' : o.kind === 'merge' ? 'join' : null);

/**
 * The chapter's marks after setting `first`'s, as the server keeps them (bff lib/spreadMarks.ts setMark): a join takes
 * the reader's join off either neighbouring pair. For the reader to show at once, before the server answers.
 */
export function withMark(marks: ReadonlyMap<number, SpreadMark>, first: number, mark: SpreadMark | null): Map<number, SpreadMark> {
  const next = new Map(marks);
  if (mark === null) next.delete(first);
  else {
    if (mark === 'join') for (const n of [first - 1, first + 1]) if (next.get(n) === 'join') next.delete(n);
    next.set(first, mark);
  }
  return next;
}

/** Saves the reader's mark on the pair starting at page `first`; answers the chapter's marks as the server now has them. */
export async function saveMark(bookId: string, first: number, mark: SpreadMark | null): Promise<Map<number, SpreadMark>> {
  const r = await api<{ marks: Record<string, SpreadMark> }>(
    `/api/books/${encodeURIComponent(bookId)}/pages/${first}/spread`, { method: 'PUT', json: { mark } });
  return new Map(Object.entries(r.marks ?? {}).map(([k, v]) => [Number(k), v]));
}
