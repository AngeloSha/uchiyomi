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
  /**
   * A stretch of consecutive `floor` ghosts, shown as one line; `open` when the reader expanded it, in which
   * case its ghosts follow it as rows. Keyed by `from`, its lowest number, which is what `expandedRuns` holds.
   */
  | { kind: 'run'; why: 'floor'; from: number; to: number; count: number; open: boolean }
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
 *     below its floor, and opening its page to 175 grey rows saying "not here yet" would bury the 25 that
 *     are. One line naming the range is what that situation needs -- and a run whose key (its lowest
 *     number) is in `expandedRuns` keeps that line, marked `open`, with its ghosts following it as ordinary
 *     ghost rows (asked for on #40: the sentence used to point at a dialog, now it unfolds);
 *   * when `!showAll` and there are more than `GHOST_CAP` other ghosts -- an expanded run's ghosts count
 *     as "other" the moment it is opened -- the `GHOST_CAP` nearest the highest on-disk number are kept
 *     (those are the ones the reader is about to reach; for an opened run that is the newest of the older
 *     ones) and a `more` row says how many are folded away.
 *
 * `books` is taken in ASCENDING order, as the API returns it; `asc` says which way the list is read. The
 * run row stays ABOVE its ghosts in both directions: it is the heading of that stretch, and a heading under
 * its own rows is a footer.
 */
export function mergeRows(books: Book[], ghosts: Ghost[], asc: boolean, showAll: boolean, expandedRuns: ReadonlySet<number> = new Set()): Row[] {
  const have = new Set(books.map((b) => b.number));
  const missing = ghosts.filter((g) => Number.isFinite(g.number) && !have.has(g.number));
  const floor = missing.filter((g) => g.why === 'floor').sort((a, b) => a.number - b.number);
  let rest = missing.filter((g) => g.why !== 'floor');

  // The runs, from every floor ghost, before any cap: a run's sentence names the whole stretch however much
  // of it is shown. A book between two floor ghosts splits them (books are sorted ascending already).
  type Run = { from: number; to: number; count: number; open: boolean; ghosts: Ghost[] };
  const runs: Run[] = [];
  const bookNumbers = books.map((b) => b.number).sort((a, b) => a - b);
  for (const g of floor) {
    const last = runs[runs.length - 1];
    const bookBetween = last && bookNumbers.some((n) => n > last.to && n < g.number);
    if (last && !bookBetween) { last.to = g.number; last.count += 1; last.ghosts.push(g); continue; }
    runs.push({ from: g.number, to: g.number, count: 1, open: false, ghosts: [g] });
  }
  for (const r of runs) if (expandedRuns.has(r.from)) { r.open = true; rest = rest.concat(r.ghosts); }

  let hidden = 0;
  if (!showAll && rest.length > GHOST_CAP) {
    // Nearest the top of what is on disk first; at equal distance the higher number, since a reader moves
    // forward. With nothing on disk at all "the top" is the highest ghost, which keeps the newest.
    const top = books.length ? Math.max(...books.map((b) => b.number)) : Math.max(...rest.map((g) => g.number));
    const ranked = [...rest].sort((a, b) => Math.abs(a.number - top) - Math.abs(b.number - top) || b.number - a.number);
    hidden = rest.length - GHOST_CAP;
    rest = ranked.slice(0, GHOST_CAP);
  }
  const kept = new Set(rest);

  // One block per row, and one per run: the run's own ghost rows (those that survived the cap) travel
  // with it, so reversing the list for `asc = false` reverses the blocks and the ghosts inside a block but
  // leaves the run row first in its block.
  type Block = { n: number; rows: Row[] };
  const blocks: Block[] = [
    ...books.map((book): Block => ({ n: book.number, rows: [{ kind: 'book', book }] })),
    ...rest.filter((g) => g.why !== 'floor').map((ghost): Block => ({ n: ghost.number, rows: [{ kind: 'ghost', ghost }] })),
    ...runs.map((r): Block => ({
      n: r.from,
      rows: [
        { kind: 'run', why: 'floor', from: r.from, to: r.to, count: r.count, open: r.open },
        ...(r.open ? r.ghosts.filter((g) => kept.has(g)).map((ghost): Row => ({ kind: 'ghost', ghost })) : []),
      ],
    })),
  ];
  // Stable, so two books on the same number keep the server's order between them, and a book always
  // precedes a ghost on the same number (there cannot be one, per the rule above, but the order is fixed
  // anyway so a bug there would at least be deterministic).
  blocks.sort((a, b) => a.n - b.n);
  if (!asc) {
    blocks.reverse();
    for (const b of blocks) if (b.rows.length > 1) b.rows = [b.rows[0], ...b.rows.slice(1).reverse()];
  }
  const rows = blocks.flatMap((b) => b.rows);
  if (hidden > 0) rows.push({ kind: 'more', hidden });
  return rows;
}

// Declared through `keys()` because they reach `tr()` through whyLabel's return value, which the string
// extractor cannot see (lib/i18n.ts says why that has shipped untranslated labels three times).
const WHY_LABELS = keys('not here yet', 'waiting for {g} · {n} days left', 'waiting for a preferred group', 'failed {n} times', 'only a blocked group has it');

/**
 * The ghost row's caption: the string key and its arguments, for `tr(key, args)`. Null for `floor`: a floor
 * ghost is only ever shown under a run row, and the run row's sentence already says why.
 *
 * `held` names the group the chapter waits for and the days left when the server sent them
 * (`waitingFor`/`waitDaysLeft`, v0.34.0); an older server, or a series whose every preferred group is
 * blocked, gets the wording without a name -- "waiting for  · undefined days left" is what the named form
 * would render then.
 */
export function whyLabel(g: Pick<Ghost, 'why'> & Partial<Pick<Ghost, 'attempts' | 'waitingFor' | 'waitDaysLeft'>>): { key: string; args: Record<string, string | number> } | null {
  switch (g.why) {
    case 'missing': return { key: WHY_LABELS[0], args: {} };
    case 'held': return g.waitingFor && g.waitDaysLeft != null
      ? { key: WHY_LABELS[1], args: { g: g.waitingFor, n: g.waitDaysLeft } }
      : { key: WHY_LABELS[2], args: {} };
    case 'failed': return { key: WHY_LABELS[3], args: { n: g.attempts ?? 0 } };
    case 'blocked': return { key: WHY_LABELS[4], args: {} };
    default: return null;
  }
}

// Declared through `keys()` for the same reason as WHY_LABELS: they reach `tr()` through runLabel's return.
const RUN_LABELS = keys('Ch. {a}–{b} · {n} older chapters not here yet', 'Ch. {n} · 1 older chapter not here yet');

/**
 * The run row's sentence: the string key and its arguments, for `tr(key, args)`.
 *
 * A run of ONE floor ghost is a real case (a Latest-N series exactly one below its floor, or a single gap
 * under it), and the range form read "Ch. 5–5 · 1 older chapters" for it -- a range with one end and a
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

/**
 * How many numbers one fetch request may carry: the route's FILL_MAX_CHAPTERS (bff/src/routes/sources.ts),
 * which it refuses to exceed with a 400. "Fetch all {n}" on a run of 500 is therefore two requests.
 */
export const FETCH_CHUNK = 300;

/**
 * A run's numbers cut into requests of at most `size`, in order, none empty. ⚠️ The requests are for ONE
 * series and the route answers 409 `busy` while that series' job is running, so the page posts them one
 * after the other, waiting for each job to end (`fetchMany` in the series page); this only decides the
 * cuts, where a test can count them.
 */
export function chunkNumbers(numbers: number[], size = FETCH_CHUNK): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < numbers.length; i += size) out.push(numbers.slice(i, i + size));
  return out;
}

/**
 * What the downloads pill counts: the chapters still to come across the running jobs, not their sizes --
 * a 300-chapter job at 290/300 is "Fetching 10 chapters", which is what its own progress line says
 * beneath (it read "Fetching 300 chapters" over a `290/300`). When that comes to nothing -- a job that has
 * not sized itself yet, or one on its last chapter -- the pill counts the jobs instead, so it never reads
 * "Fetching 0 chapters" while something is plainly running.
 */
export function chaptersLeft(jobs: { total: number; done: number }[]): number {
  return jobs.reduce((sum, j) => sum + Math.max(0, (j.total || 0) - (j.done || 0)), 0) || jobs.length;
}
