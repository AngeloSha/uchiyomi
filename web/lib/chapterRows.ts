// The chapter list's arithmetic, with no React in it.
//
// The series page shows two kinds of thing in one list: the chapters on disk, and the chapters the sources
// list that this server does not hold ("ghosts"). Which ghost goes where, which ones collapse, and how many
// are shown before a "Show all" row are decisions a person will argue with, so they live here where a test
// can reach them without a browser.

import type { Book, Ghost } from './types';
import { keys } from './i18n';

export type Row =
  | { kind: 'book'; book: Book }
  | { kind: 'ghost'; ghost: Ghost }
  /** A stretch of consecutive `floor` ghosts, shown as one line pointing at Find missing chapters. */
  | { kind: 'run'; why: 'floor'; from: number; to: number; count: number }
  /** The ghosts hidden behind "Show all {n}". Always the last row. */
  | { kind: 'more'; hidden: number };

/**
 * How many non-floor ghosts are shown before the rest fold behind a "Show all" row. A series that fell
 * behind by hundreds of chapters is a real case (a source moved, or a follower was added late), and a list
 * that is 90% grey rows buries the chapters somebody can actually read.
 */
export const GHOST_CAP = 50;

/**
 * The rows of the chapter list, in the list's direction.
 *
 *   * a number that has a book is a book row and NEVER a ghost, whatever the listing says -- the server
 *     applies the same rule, and this is the belt to its braces, because a stale listing that raced a
 *     download would otherwise show "Ch. 12" twice, once grey;
 *   * consecutive `floor` ghosts collapse into ONE run row. A "Latest 25 of 200" series has 175 numbers
 *     below its floor, and opening its page to 175 grey rows saying "not downloaded" would bury the 25
 *     that are. One line naming the range, pointing at Find missing chapters, is what that situation needs;
 *   * when `!showAll` and there are more than `GHOST_CAP` other ghosts, the `GHOST_CAP` nearest the highest
 *     on-disk number are kept -- those are the ones the reader is about to reach -- and a `more` row says
 *     how many are folded away.
 *
 * `books` is taken in ASCENDING order, as the API returns it; `asc` says which way the list is read.
 */
export function mergeRows(books: Book[], ghosts: Ghost[], asc: boolean, showAll: boolean): Row[] {
  const have = new Set(books.map((b) => b.number));
  const missing = ghosts.filter((g) => Number.isFinite(g.number) && !have.has(g.number));
  const floor = missing.filter((g) => g.why === 'floor');
  let rest = missing.filter((g) => g.why !== 'floor');

  let hidden = 0;
  if (!showAll && rest.length > GHOST_CAP) {
    // Nearest the top of what is on disk first; at equal distance the higher number, since a reader moves
    // forward. With nothing on disk at all "the top" is the highest ghost, which keeps the newest.
    const top = books.length ? Math.max(...books.map((b) => b.number)) : Math.max(...rest.map((g) => g.number));
    const ranked = [...rest].sort((a, b) => Math.abs(a.number - top) - Math.abs(b.number - top) || b.number - a.number);
    hidden = rest.length - GHOST_CAP;
    rest = ranked.slice(0, GHOST_CAP);
  }

  type Entry = { n: number; row: Row };
  const entries: Entry[] = [
    ...books.map((book): Entry => ({ n: book.number, row: { kind: 'book', book } })),
    ...rest.map((ghost): Entry => ({ n: ghost.number, row: { kind: 'ghost', ghost } })),
    ...floor.map((ghost): Entry => ({ n: ghost.number, row: { kind: 'ghost', ghost } })),
  ];
  // Stable, so two books on the same number keep the server's order between them, and a book always
  // precedes a ghost on the same number (there cannot be one, per the rule above, but the order is fixed
  // anyway so a bug there would at least be deterministic).
  entries.sort((a, b) => a.n - b.n);

  const rows: Row[] = [];
  for (const { row } of entries) {
    const last = rows[rows.length - 1];
    if (row.kind === 'ghost' && row.ghost.why === 'floor') {
      if (last && last.kind === 'run') { last.to = row.ghost.number; last.count += 1; continue; }
      rows.push({ kind: 'run', why: 'floor', from: row.ghost.number, to: row.ghost.number, count: 1 });
      continue;
    }
    rows.push(row);
  }
  if (!asc) rows.reverse();
  if (hidden > 0) rows.push({ kind: 'more', hidden });
  return rows;
}

// Declared through `keys()` because they reach `tr()` through whyLabel's return value, which the string
// extractor cannot see (lib/i18n.ts says why that has shipped untranslated labels three times).
const WHY_LABELS = keys('Not downloaded yet', 'Waiting for a preferred group', 'Failed {n} times', 'Only blocked groups released it');

/**
 * The string key for a ghost's reason pill (`Failed {n} times` takes `n` = attempts). Null for `floor`: a
 * floor ghost is only ever shown as a run row, and the run row's sentence already says why.
 */
export function whyLabel(g: Pick<Ghost, 'why'>): string | null {
  switch (g.why) {
    case 'missing': return WHY_LABELS[0];
    case 'held': return WHY_LABELS[1];
    case 'failed': return WHY_LABELS[2];
    case 'blocked': return WHY_LABELS[3];
    default: return null;
  }
}

// Declared through `keys()` for the same reason as WHY_LABELS: they reach `tr()` through runLabel's return.
const RUN_LABELS = keys('Ch. {a}–{b}: {n} older chapters left to Find missing chapters', 'Ch. {n}: 1 older chapter left to Find missing chapters');

/**
 * The run row's sentence: the string key and its arguments, for `tr(key, args)`.
 *
 * A run of ONE floor ghost is a real case (a Latest-N series exactly one below its floor, or a single gap
 * under it), and the range form read "Ch. 5–5: 1 older chapters left" for it -- a range with one end and a
 * plural with one thing. The singular is its own key rather than an `s` bolted on, because in most of the
 * eight languages the plural is not a suffix.
 */
export function runLabel(r: Extract<Row, { kind: 'run' }>): { key: string; args: Record<string, string | number> } {
  return r.count === 1
    ? { key: RUN_LABELS[1], args: { n: r.from } }
    : { key: RUN_LABELS[0], args: { a: r.from, b: r.to, n: r.count } };
}

/**
 * The chapters the reader may step to with next/prev: everything except a chapter the server deleted --
 * UNLESS that chapter is saved on this device, in which case the offline copy is the last one in the world
 * and stepping onto it is exactly right. Without this the reader's own next/prev landed on a tombstone and
 * showed "Chapter deleted" in the middle of a series that was otherwise all there.
 */
export function openableChapters<T extends { id: string; pruned?: boolean }>(books: T[], savedIds: Set<string>): T[] {
  return books.filter((b) => !b.pruned || savedIds.has(b.id));
}
