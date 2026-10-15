// The reader's own say on where a double-page spread is (bff lib/spreadMarks.ts).
//
// The server's detector says which neighbouring pages are one spread a source cut in two (`join` on the first page). It joins
// pairs that are not spreads and misses ones that are, so a reader can say otherwise, per chapter, on the pair (page, page + 1):
// `join` shows them as one spread where the detector found none, `split` shows a pair it joined as two pages. Marks are applied
// to the flow after it is built, so the pairing rules in lib/readerSpread.ts need to know nothing about where a join came from --
// except that a reader's own join holds even with "Join split double pages" off (`forced`), because they asked for that one.
import { api } from './api';

export type SpreadMark = 'join' | 'split';
export type Marks = Record<number, SpreadMark>;

interface Joinable { ci: number; number: number; join?: 'rtl' | 'ltr' | null; forced?: boolean }

/**
 * `items` with the marks applied; `marksByCi[ci]` is chapter `ci`'s. `dir` is the side the second page goes on for a join the
 * reader made: 'rtl' when the track reads right to left, as the detector's own answer is for that kind of spread.
 * The very array when there is nothing to apply, so a flow memoised on it does not change.
 *
 * A page is in one spread only. A join on page N therefore takes the detector's join off page N-1 (it would end in N), and
 * the page after N is its second half and starts no spread of its own; a join the detector found on N+1 is dropped for the
 * same reason. Two marked joins cannot be neighbours (the server refuses the second), so a pair never needs three pages.
 */
export function applyMarks<T extends Joinable>(items: T[], marksByCi: ReadonlyArray<Marks | undefined>, dir: 'rtl' | 'ltr'): T[] {
  if (!marksByCi.some((m) => m && Object.keys(m).length)) return items;
  return items.map((it) => {
    const m = marksByCi[it.ci];
    if (!m) return it;
    const own = m[it.number];
    if (own === 'join') return { ...it, join: dir, forced: true };
    if (own === 'split') return it.join ? { ...it, join: undefined } : it;
    if (it.join && (m[it.number - 1] === 'join' || m[it.number + 1] === 'join')) return { ...it, join: undefined };
    return it;
  });
}

/** What may be done to the page being looked at. `first` is the number of the first page of the pair concerned. */
export type SpreadOption =
  /** The detector joined this pair: show it as two pages. */
  | { kind: 'split'; first: number }
  /** The reader joined this pair themselves: take it apart again. */
  | { kind: 'unmerge'; first: number }
  /** The reader split a pair the detector joined: let the detector's answer stand again. */
  | { kind: 'restore'; first: number }
  /** Join this page with its neighbour on that side of the screen. */
  | { kind: 'merge'; side: 'left' | 'right'; first: number };

/**
 * The options for the page at flow index `at`. `flat` is the flow with the marks applied (what is on screen), and
 * `nextIsLeft` whether the next page sits to the left (a right-to-left track), which is what "left" and "right" mean for a
 * neighbour. Pages pair only inside one chapter, as consecutive numbers, and never when either is wide (a wide page is already
 * a spread). A joined pair offers only its way apart; a lone page offers the merges that are possible.
 */
export function spreadOptions(
  flat: ReadonlyArray<{ ci: number; number: number; join?: 'rtl' | 'ltr' | null; width?: number | null; height?: number | null }>,
  at: number,
  marks: Marks | undefined,
  nextIsLeft: boolean,
): SpreadOption[] {
  const me = flat[at];
  if (!me) return [];
  const wide = (p?: { width?: number | null; height?: number | null }) => !!p && typeof p.width === 'number' && typeof p.height === 'number' && p.width > p.height;
  const startsAt = (i: number): number | null => {
    const a = flat[i], b = flat[i + 1];
    return a && b && a.ci === me.ci && b.ci === a.ci && a.join && b.number === a.number + 1 ? a.number : null;
  };
  const joined = startsAt(at) ?? startsAt(at - 1);
  if (joined !== null) return [{ kind: marks?.[joined] === 'join' ? 'unmerge' : 'split', first: joined }];
  if (wide(me)) return [];
  const out: SpreadOption[] = [];
  const restore = marks?.[me.number] === 'split' ? me.number : marks?.[me.number - 1] === 'split' ? me.number - 1 : null;
  if (restore !== null) out.push({ kind: 'restore', first: restore });
  const near = (i: number) => { const p = flat[i]; return p && p.ci === me.ci && !wide(p) ? p : null; };
  const prev = near(at - 1), next = near(at + 1);
  const merges: SpreadOption[] = [];
  if (prev && prev.number + 1 === me.number) merges.push({ kind: 'merge', side: nextIsLeft ? 'right' : 'left', first: prev.number });
  if (next && next.number === me.number + 1) merges.push({ kind: 'merge', side: nextIsLeft ? 'left' : 'right', first: me.number });
  merges.sort((a, b) => (a.kind === 'merge' && b.kind === 'merge' && a.side === 'left' ? -1 : 1));
  return [...out, ...merges];
}

/** The mark an option writes (null clears it, back to the detector's answer). */
export const markFor = (o: SpreadOption): SpreadMark | null =>
  o.kind === 'split' ? 'split' : o.kind === 'merge' ? 'join' : null;

export const loadMarks = (bookId: string): Promise<Marks> =>
  api<{ marks: Marks }>(`/api/books/${encodeURIComponent(bookId)}/spread-marks`).then((r) => r.marks ?? {}).catch(() => ({}));

export const saveMark = (bookId: string, page: number, mark: SpreadMark | null): Promise<Marks> =>
  api<{ marks: Marks }>(`/api/books/${encodeURIComponent(bookId)}/spread-marks/${page}`, { method: 'PUT', json: { mark } }).then((r) => r.marks ?? {});
