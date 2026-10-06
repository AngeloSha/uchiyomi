// The chapter list's arithmetic, with no React in it.
//
// The series page shows two kinds of thing in one list: the chapters on disk, and the chapters the sources
// list that this server does not hold ("ghosts"). Which ghost goes where, which ones collapse, and how many
// are shown before a "Show all" row are decisions a person will argue with, so they live here where a test
// can reach them without a browser.

import type { Book, Ghost } from './types';
import { keys, t as tr } from './i18n';

export type Row =
  | { kind: 'book'; book: Book }
  | { kind: 'ghost'; ghost: Ghost }
  /**
   * A stretch of consecutive `floor` ghosts, or of `archive` ones (#117: chapters an active slow archive will
   * fetch), shown as one line; `open` when the reader expanded it, in which case its ghosts follow it as rows.
   * Keyed by `from`, its lowest number, which is what `expandedRuns` holds.
   */
  | { kind: 'run'; why: RunWhy; from: number; to: number; count: number; open: boolean }
  /** The ghosts hidden behind "Show all {n}". Always the last row. */
  | { kind: 'more'; hidden: number };

/**
 * How many non-floor ghosts are shown before the rest fold behind a "Show all" row. A series that fell
 * behind by hundreds of chapters is a real case (a source moved, or a follower was added late), and a list
 * that is 90% grey rows buries the chapters somebody can actually read.
 */
export const GHOST_CAP = 50;

/** The ghosts that collapse into run rows: below a Latest-N floor, and on their way through the slow archive. */
export type RunWhy = 'floor' | 'archive';
const collapses = (g: Pick<Ghost, 'why'>): g is Ghost & { why: RunWhy } => g.why === 'floor' || g.why === 'archive';

/**
 * The numbers some books hold, as a test: a book's own number, and every number inside a file holding a range
 * (v0.55.2, #150: `Batman 01-07` holds 1 to 7). The server's rule (bff lib/chapterRanges.ts heldBy), for the lists
 * the page draws: a number a range file holds is never a ghost, never "not here", never a hollow chip.
 */
export function heldBy(books: ReadonlyArray<Pick<Book, 'number' | 'numberEnd'>>): { has(n: number): boolean } {
  const exact = new Set<number>();
  const ranges: Array<[number, number]> = [];
  for (const b of books) {
    exact.add(b.number);
    if (b.numberEnd != null && b.numberEnd > b.number) ranges.push([b.number, b.numberEnd]);
  }
  return { has: (n: number) => exact.has(n) || ranges.some(([a, z]) => n >= a && n <= z) };
}

/** The last chapter a book holds: the end of its range, else its number. */
export const lastOf = (b: Pick<Book, 'number' | 'numberEnd'>): number => (b.numberEnd != null && b.numberEnd > b.number ? b.numberEnd : b.number);

/**
 * The whole numbers some books hold something at: each book's, and every one inside a range. Counted in steps from
 * the start, never by `w++` on the number itself: past 2^53 a float's `+ 1` is the same float, and a chapter numbered
 * 1e20 looped for ever. A thousand steps at most, as the server bounds a range (bff lib/naming.ts MAX_RANGE).
 */
export function wholesHeld(books: ReadonlyArray<Pick<Book, 'number' | 'numberEnd'>>): Set<number> {
  const out = new Set<number>();
  for (const b of books) {
    const w = Math.floor(b.number);
    out.add(w);
    const steps = Math.min(1000, Math.floor(lastOf(b)) - w);
    for (let k = 1; k <= steps; k++) out.add(w + k);
  }
  return out;
}

/**
 * The rows of the chapter list, in the list's direction.
 *
 *   * a number that has a book is a book row and NEVER a ghost, whatever the listing says -- the server
 *     applies the same rule, and this is the belt to its braces, because a stale listing that raced a
 *     download would otherwise show "Ch. 12" twice, once grey. A number inside a file holding a range is
 *     that book's (heldBy);
 *   * consecutive `floor` ghosts collapse into ONE run row. A "Latest 25 of 200" series has 175 numbers
 *     below its floor, and opening its page to 175 grey rows saying "not here yet" would bury the 25 that
 *     are. One line naming the range is what that situation needs -- and a run whose key (its lowest
 *     number) is in `expandedRuns` keeps that line, marked `open`, with its ghosts following it as ordinary
 *     ghost rows (asked for on #40: the sentence used to point at a dialog, now it unfolds);
 *   * `archive` ghosts (#117) collapse the same way into runs of their own, and a run is only ever one kind:
 *     a floor number between two archive numbers (a capped one, say) ends the archive run and starts a floor
 *     run, so each line's sentence stays true of every number under it;
 *   * when `!showAll` and there are more than `GHOST_CAP` other ghosts -- an expanded run's ghosts count
 *     as "other" the moment it is opened -- the `GHOST_CAP` nearest the highest on-disk number are kept
 *     (those are the ones the reader is about to reach; for an opened run that is the newest of the older
 *     ones) and a `more` row says how many are folded away.
 *
 * `books` is taken in ASCENDING order, as the API returns it; `asc` says which way the list is read. The
 * run row stays ABOVE its ghosts in both directions: it is the heading of that stretch, and a heading under
 * its own rows is a footer.
 */
export function mergeRows(books: Book[], ghosts: Ghost[], asc: boolean, showAll: boolean, expandedRuns: { has(n: number): boolean } = new Set<number>()): Row[] {
  // Reintroduce `new Set(books.map((b) => b.number))`: "a range file's numbers are no ghost rows" in
  // chapterRows.test.ts finds 2 to 6 listed grey under `Batman 01-07`.
  const have = heldBy(books);
  const missing = ghosts.filter((g) => Number.isFinite(g.number) && !have.has(g.number));
  const floor = missing.filter(collapses).sort((a, b) => a.number - b.number);
  let rest = missing.filter((g) => !collapses(g));

  // The runs, from every floor and archive ghost, before any cap: a run's sentence names the whole stretch
  // however much of it is shown. A book between two such ghosts splits them (books are sorted ascending
  // already), and so does a change of kind: a floor run and an archive run are never one line.
  // Reintroduce by dropping `last.why === g.why`: "an archive run and a floor run are two lines" in
  // chapterRows.test.ts reads one run saying "not here yet" over chapters the archive is fetching.
  type Run = { why: RunWhy; from: number; to: number; count: number; open: boolean; ghosts: Ghost[] };
  const runs: Run[] = [];
  const bookNumbers = books.map((b) => b.number).sort((a, b) => a - b);
  for (const g of floor) {
    const last = runs[runs.length - 1];
    const bookBetween = last && bookNumbers.some((n) => n > last.to && n < g.number);
    if (last && !bookBetween && last.why === g.why) { last.to = g.number; last.count += 1; last.ghosts.push(g); continue; }
    runs.push({ why: g.why, from: g.number, to: g.number, count: 1, open: false, ghosts: [g] });
  }
  for (const r of runs) if (expandedRuns.has(r.from)) { r.open = true; rest = rest.concat(r.ghosts); }

  // A deleted chapter drawn as a ghost (ghostOfDeleted) was a row before the switch and stays one: it is never folded
  // behind "Show all", or turning the switch on would take a library's read-and-deleted chapters off the page.
  const pinned = rest.filter((g) => g.why === 'deleted');
  rest = rest.filter((g) => g.why !== 'deleted');
  let hidden = 0;
  if (!showAll && rest.length > GHOST_CAP) {
    // Nearest the top of what is on disk first; at equal distance the higher number, since a reader moves
    // forward. With nothing on disk at all "the top" is the highest ghost, which keeps the newest.
    const top = books.length ? Math.max(...books.map(lastOf)) : Math.max(...rest.map((g) => g.number));
    const ranked = [...rest].sort((a, b) => Math.abs(a.number - top) - Math.abs(b.number - top) || b.number - a.number);
    hidden = rest.length - GHOST_CAP;
    rest = ranked.slice(0, GHOST_CAP);
  }
  rest = rest.concat(pinned);
  const kept = new Set(rest);

  // One block per row, and one per run: the run's own ghost rows (those that survived the cap) travel
  // with it, so reversing the list for `asc = false` reverses the blocks and the ghosts inside a block but
  // leaves the run row first in its block.
  type Block = { n: number; rows: Row[] };
  const blocks: Block[] = [
    ...books.map((book): Block => ({ n: book.number, rows: [{ kind: 'book', book }] })),
    ...rest.filter((g) => !collapses(g)).map((ghost): Block => ({ n: ghost.number, rows: [{ kind: 'ghost', ghost }] })),
    ...runs.map((r): Block => ({
      n: r.from,
      rows: [
        { kind: 'run', why: r.why, from: r.from, to: r.to, count: r.count, open: r.open },
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
const WHY_LABELS = keys('not here yet', 'waiting for {g} · {n} days left', 'waiting for a preferred group', 'failed {n} times', 'only a blocked group has it', 'another split of a chapter you have', 'another site’s split of this chapter', 'another split', 'another site’s split', 'deleted');

/**
 * The ghost row's caption: the string key and its arguments, for `tr(key, args)`. Null for `floor` and
 * `archive`: those ghosts are only ever shown under a run row, and the run row's sentence already says why.
 *
 * `held` names the group the chapter waits for and the days left when the server sent them
 * (`waitingFor`/`waitDaysLeft`, v0.34.0); an older server, or a series whose every preferred group is
 * blocked, gets the wording without a name -- "waiting for  · undefined days left" is what the named form
 * would render then.
 *
 * `covered` (v0.50.0): another site numbers or splits this chapter's parts differently, and the chapter is here in
 * the other split -- its 78.1 ... 78.9 beside the whole 78 on disk. The sweep leaves it; Fetch still takes it. With
 * nothing of the chapter here yet (`wholeHere` false: no book at its whole number), it is the other split of a new
 * chapter whose first-ranked source is fetched instead (bff lib/partAlias.ts R3), and "a chapter you have" would be
 * untrue: it says another site's split of this chapter. Reintroduce by wording both the same: "a covered part of a
 * chapter nothing of is here" in chapterRows.test.ts reads "a chapter you have".
 * The caption is the short form, "another split" or "another site's split", and the sentence goes in `full`: the row
 * shows the caption, then the copy's group and "via {source}", and at 390 px and in the desktop grid the sentence
 * cut itself off at "another split of a cha…" with the source never shown (the v0.50.0 browser check). The row's
 * title and its screen-reader text say the sentence (RowCaption `lead.full`).
 */
export function whyLabel(
  g: Pick<Ghost, 'why'> & Partial<Pick<Ghost, 'attempts' | 'waitingFor' | 'waitDaysLeft'>>, o: { wholeHere?: boolean } = {},
): { key: string; args: Record<string, string | number>; full?: { key: string; args: Record<string, string | number> } } | null {
  switch (g.why) {
    case 'missing': return { key: WHY_LABELS[0], args: {} };
    case 'held': return g.waitingFor && g.waitDaysLeft != null
      ? { key: WHY_LABELS[1], args: { g: g.waitingFor, n: g.waitDaysLeft } }
      : { key: WHY_LABELS[2], args: {} };
    case 'failed': return { key: WHY_LABELS[3], args: { n: g.attempts ?? 0 } };
    case 'blocked': return { key: WHY_LABELS[4], args: {} };
    case 'covered': return o.wholeHere === false
      ? { key: WHY_LABELS[8], args: {}, full: { key: WHY_LABELS[6], args: {} } }
      : { key: WHY_LABELS[7], args: {}, full: { key: WHY_LABELS[5], args: {} } };
    case 'deleted': return { key: WHY_LABELS[9], args: {} };
    default: return null;
  }
}

/**
 * Does this ghost count as "not here" on the series page's supply line -- something the sweep would take? Not a
 * floor or archive ghost (the run rows say those), and not a covered one (v0.50.0): another site's split of a
 * chapter that IS here is not a chapter behind. Reintroduce by dropping the `covered` test: "another site's split"
 * in chapterRows.test.ts counts it.
 */
export const countsAsBehind = (g: Pick<Ghost, 'why'>): boolean => g.why !== 'floor' && g.why !== 'archive' && g.why !== 'covered' && g.why !== 'deleted';

// Declared through `keys()` for the same reason as WHY_LABELS: they reach `tr()` through runLabel's return.
const RUN_LABELS = keys('Ch. {a}–{b} · {n} older chapters not here yet', 'Ch. {n} · 1 older chapter not here yet');
const ARCHIVE_RUN_LABELS = keys('Ch. {a}–{b} · {n} chapters being archived slowly', 'Ch. {n} · 1 chapter being archived slowly');
const PAUSED_RUN_LABELS = keys('Ch. {a}–{b} · {n} chapters in a paused slow archive', 'Ch. {n} · 1 chapter in a paused slow archive');

/**
 * The run row's sentence: the string key and its arguments, for `tr(key, args)`.
 *
 * A run of ONE floor ghost is a real case (a Latest-N series exactly one below its floor, or a single gap
 * under it), and the range form read "Ch. 5–5 · 1 older chapters" for it -- a range with one end and a
 * plural with one thing. The singular is its own key rather than an `s` bolted on, because in most of the
 * eight languages the plural is not a suffix.
 *
 * `paused`: the series' archive is paused, or everyone's is. Its numbers still read `archive` (they are its, below
 * its boundary), but nothing is fetching them, and "being archived slowly" said it was (v0.49.1).
 */
export function runLabel(r: Extract<Row, { kind: 'run' }>, o: { paused?: boolean } = {}): { key: string; args: Record<string, string | number> } {
  const labels = r.why === 'archive' ? (o.paused ? PAUSED_RUN_LABELS : ARCHIVE_RUN_LABELS) : RUN_LABELS;
  return r.count === 1
    ? { key: labels[1], args: { n: r.from } }
    : { key: labels[0], args: { a: r.from, b: r.to, n: r.count } };
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
 * How many numbers one "mark read / unread" request for chapters the server does not hold may carry: the
 * route's LISTING_MARK_MAX (bff/src/lib/listingProgress.ts), past which it answers 400. Larger than
 * FETCH_CHUNK because a mark is one small row and a fetch is a download.
 */
export const MARK_CHUNK = 500;

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

/**
 * The words on a tombstone's chip, by why its file is gone (Book.prunedReason, v0.55.4). A chapter in a library you
 * built by hand that Rescan everything found gone -- `deleted`, and not one this server downloaded -- says "File no
 * longer on disk": nothing deleted it, the file simply is not there, and a file put back is picked up by the next
 * scan. Every other tombstone keeps "Deleted from the server", as before. Null for a chapter with its file.
 * Reintroduce one wording for every tombstone: "a chapter whose file went from your own folder says so" in
 * chapterRows.test.ts reads "Deleted from the server".
 */
export function prunedLabel(b: Pick<Book, 'pruned' | 'prunedReason' | 'owned'>): string | null {
  if (!b.pruned) return null;
  return b.prunedReason === 'deleted' && b.owned === false ? tr('File no longer on disk') : tr('Deleted from the server');
}

/**
 * Was this chapter's file deleted ON PURPOSE -- the cleanup, Remove chapters, Delete files? The server's rule (bff
 * lib/deletedGhosts.ts deliberatelyDeleted): not a file Verify found missing (the sweep fetches those back), and not a
 * chapter of a library built by hand that Rescan everything found gone ("File no longer on disk": nothing deleted it).
 */
export function deliberatelyDeleted(b: Pick<Book, 'pruned' | 'prunedReason' | 'owned'>): boolean {
  if (!b.pruned) return false;
  if (b.prunedReason === 'missing') return false;
  return !(b.prunedReason === 'deleted' && b.owned === false);
}

/**
 * A deleted chapter as a ghost row, for the admin's "Show deleted chapters as ghosts" (Listing.deletedAsGhosts): its
 * number, name, date and group, why `deleted`, and the reader's tick from its own progress -- a tombstone's history
 * is on its row, and the ghost row's Mark read/unread writes there too (bff lib/listingProgress markNumbers).
 */
export function ghostOfDeleted(b: Book): Ghost {
  return {
    number: b.number,
    title: b.chapterName ?? null,
    publishedAt: b.metadata?.releaseDate ?? null,
    scanlator: b.scanlator ?? null,
    groups: b.scanlator ? [b.scanlator] : [],
    sourceId: b.sourceId ?? '',
    sourceName: '',
    why: 'deleted',
    ...(b.readProgress?.completed ? { read: true } : {}),
  };
}
