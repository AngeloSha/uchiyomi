// Read marks on chapters this server does NOT hold (issue #69): "I have read chapter 57" for a number the
// sources list and the library never fetched -- a ghost row on the series page, a "not downloaded" row in
// Mihon under the ghost opt-in.
//
// A mark is a row in listing_progress (the table's note in lib/migrate.ts says why it is not read_progress and
// not a fabricated lib_books row). Everything that reads reading history -- the read-chapter cleanup, Continue
// Reading, the shelf's unread count, OPDS, stats, streaks, Wrapped -- reads read_progress and reading_events,
// and so keeps meaning "of what is actually here" without knowing this table exists. Only three things read
// the marks: the series page (lib/seriesListing's listingFor draws the tick), the Komga surface
// (lib/komgaProgress, behind komga_ghost_chapters) and the tracker push (lib/trackers' seriesProgressFor, behind
// the same switch). The rule the last two share lives here, in continuousRun, so they can never drift apart.
//
// What must never happen, each pinned by a named test:
//   1. Absence is never a read. No path infers read-ness for a number nobody marked.
//   2. A tick on a number we do not hold moves an external tracker only as part of a CONTIGUOUS run from the
//      bottom -- never a lone high tick, whose number is effectively irreversible on AniList.
//   3. The run reported to a paired phone never falls below what v0.42.0 answered.
//   4. A mark never writes reading_events: ticking a backlog is not reading in the app, and streaks, the
//      leaderboard and Wrapped must not inflate from it.
//   5. Reconciliation never makes a just-landed file due for the read-chapter cleanup.
import { q, tx } from './db';

/** A statement runner: the module-level `q`, or the scoped one a `tx` callback is handed. */
type Run = <R = any>(text: string, params?: any[]) => Promise<R[]>;

/**
 * How many numbers one request may name. The fetch route's ceiling is 300 because every number there is a
 * download; a mark costs one small row, and a reader ticking "chapters 1-450" from select mode should not
 * have to do it twice. Still bounded, because the listing is the authorisation and an unbounded array is an
 * unbounded write.
 */
export const LISTING_MARK_MAX = 500;

/** One chapter in the order the leading run is walked: a real row (tombstones included) or a ghost. */
export interface RunEntry {
  number: number;
  /** read_progress.completed for a real row (null = never opened); for a ghost, true when marked, else null. */
  completed: boolean | null;
  ghost: boolean;
}

/**
 * Merge the real rows with the ghost numbers into the ascending order the run is walked in. A ghost is
 * `completed: true` only when THIS reader marked it -- a mark on a number that is no longer a ghost (the
 * listing dropped it, or a chapter landed and has not been reconciled yet) plays no part, because only
 * numbers in `ghosts` are looked up.
 */
export function mergeRun(real: Array<{ number: number; completed: boolean | null }>, ghosts: number[], marks: Set<number>): RunEntry[] {
  const all: RunEntry[] = [
    ...real.map((r) => ({ number: Number(r.number), completed: r.completed, ghost: false })),
    ...ghosts.map((number) => ({ number, completed: marks.has(number) ? true : null, ghost: true })),
  ];
  // Stable, so real rows sharing a number keep the (number, file) order the caller read them in. A ghost can
  // never share a number with a real row: ghostNumbers' anti-join excludes it.
  if (ghosts.length) all.sort((a, b) => a.number - b.number);
  return all;
}

/**
 * How far this reader has read without a gap: the number Mihon turns into `last_chapter_read`, and the one
 * the tracker push may raise AniList/MAL/Kitsu to.
 *
 * ⚠️ TWO WALKS, AND THE MAX OF THEM.
 *   `skip`   is v0.42.0's rule: a ghost is skipped, so one never-fetched chapter 5 cannot pin a reader at
 *            chapter 1000 back to 4 (and drag their tracker back on the next sync).
 *   `strict` is the rule issue #69 asks for: a ghost the reader MARKED is a chapter they read, and one they
 *            did not mark is a chapter they did not, so it breaks the run like any unread chapter.
 * The max is never below `skip`, which is exactly today's answer -- no install regresses and no paired phone
 * watches its progress drop -- and it only rises above it through a contiguous run of explicit ticks, so a
 * single tick on chapter 1000 with 989 unmarked ghosts below it adds nothing.
 *
 * ⚠️ THE ADJACENCY BREAK. "The next entry in the list" is not "the next chapter": a listing is only what the
 * sources list, and sources list sparsely -- a licensed or DMCA'd middle, a follow-only series whose source
 * starts at 200, a site that shows only the newest chapter. Without the break, real 1..12 read plus one mark
 * on 951 in a listing of 951..1000 walks straight across the hole and tells AniList 951. So a marked ghost may
 * extend the run only when no whole number is missing before it; real rows are not held to that (a real row
 * is a chapter this library has, and v0.42.0's walk already passed over holes between them).
 *
 * Reintroduce by keeping either walk alone: with `strict` alone "a ghost in the MIDDLE never stalls the run"
 * (komgaGhosts.int.test.ts) fails; with `skip` alone "a follow-only series read to 5 reports 5" fails. Merge
 * them into one skip-and-extend loop and "a lone tick far ahead reports nothing" fails. Drop the adjacency
 * break and "one tick past a hole in the listing reports nothing" (listingProgress.int.test.ts) fails.
 *
 * Returns the raw number (it may be fractional, e.g. 12.5); the tracker push floors it, so a run that ends
 * on a fractional mark never tells a tracker about the whole chapter after it.
 */
export function continuousRun(all: RunEntry[]): number {
  let skip = 0;
  for (const r of all) {
    // A chapter nobody can read cannot be the thing that says how far this reader has got.
    if (r.ghost) continue;
    if (r.completed !== true) break;
    skip = r.number;
  }
  let strict = 0;
  for (const r of all) {
    if (r.completed !== true) break;
    if (r.ghost && Math.floor(r.number) > Math.floor(strict) + 1) break;
    strict = r.number;
  }
  return Math.max(skip, strict);
}

/**
 * This reader's marks on one series, split by WHO MADE THEM, as the numbers Postgres hands back for `real`
 * (so they compare with ghostNumbers').
 *   `all`  every mark. What the run is walked over: a chapter the reader ticked on the phone is one they read.
 *   `own`  the marks a PERSON made here (`source <> 'komga'`).
 *
 * ⚠️ THE SPLIT IS LOAD-BEARING, and `source` is not the support-only column its first note called it.
 * markReadUpTo marks every listed ghost at or below the number a phone PUTs, and Mihon PUTs on every bind and
 * refresh -- so a mark can be nothing but this server's own answer echoed back. Anything that asks "has this
 * reader engaged with the ghosts?" must ask `own`, or a routine refresh answers yes for a reader who did
 * nothing (lib/komgaProgress readProgressDetail, and the failure it names).
 */
export async function marksByOrigin(userId: string, seriesId: string, run: Run = q): Promise<{ all: Set<number>; own: Set<number> }> {
  const rows = await run<{ number: string | number; source: string }>(
    'SELECT number, source FROM listing_progress WHERE user_id = $1 AND series_id = $2',
    [userId, seriesId],
  );
  return {
    all: new Set(rows.map((r) => Number(r.number))),
    own: new Set(rows.filter((r) => r.source !== 'komga').map((r) => Number(r.number))),
  };
}

/** Every mark on one series, whoever made it: the set the run is walked over. */
export async function marksFor(userId: string, seriesId: string, run: Run = q): Promise<Set<number>> {
  return (await marksByOrigin(userId, seriesId, run)).all;
}

/**
 * Every chapter row of a series with this reader's completion, in the order the run is walked: the
 * override-aware number (what lib/ownedCatalog hands Mihon as numberSort and what the tracker is told), then
 * the file, over EVERY row including tombstones -- a pruned chapter's row is what this reader's history refers
 * to. The Komga progress endpoint and the tracker push both read it, so they walk the same list.
 */
export async function realRows(userId: string, seriesId: string): Promise<Array<{ number: number; completed: boolean | null }>> {
  return q<{ number: number; completed: boolean | null }>(
    `SELECT COALESCE(ov.number, b.number) AS number, rp.completed
       FROM lib_books b
       LEFT JOIN book_overrides ov ON ov.book_id = b.id
       LEFT JOIN read_progress rp ON rp.book_id = b.id AND rp.user_id = $2
      WHERE b.series_id = $1
      ORDER BY COALESCE(ov.number, b.number) ASC, b.file ASC`,
    [seriesId, userId],
  );
}

/** The override-aware "this series holds a chapter with this number" test, tombstones included. */
const HELD = (seriesCol: string, numberCol: string) => `EXISTS (
  SELECT 1 FROM lib_books b LEFT JOIN book_overrides ov ON ov.book_id = b.id
   WHERE b.series_id = ${seriesCol} AND COALESCE(ov.number, b.number) = ${numberCol})`;

export interface MarkResult {
  /** New listing_progress rows this call wrote (a number already marked is not counted again). */
  marked: number;
  /** read_progress rows this call moved to completed, for numbers the library does hold. */
  viaBook: number;
  /** Numbers neither listed nor held: nothing was written for them. */
  skipped: Array<{ number: number; reason: 'not_listed' }>;
}

/**
 * Mark numbers read for one reader on one series.
 *
 * Resolved per number, in the order a reader would expect:
 *   held        a lib_books row has this override-aware number (a live chapter or a tombstone). It is marked
 *               the way the library's bulk mark-read marks one -- read_progress, completed, GREATEST on page --
 *               because a chapter that landed between the page load and the tap is simply a chapter now, and
 *               a tombstone's history is keyed to its row. ⚠️ Override-aware and tombstones included: matched
 *               on the raw number or on live rows only, a renumbered chapter or a pruned one would be stored as a
 *               ghost mark beside its own row and sit inert until the next scan.
 *   listed      series_listing has the number and no row holds it: a listing_progress row. ⚠️ THE LISTING IS THE
 *               AUTHORISATION, as it is for a manual fetch: a client cannot mint marks on arbitrary floats.
 *   neither     skipped as `not_listed`.
 *
 * ONE set-based statement per kind in one transaction, never writeProgress per number: writeProgress pushes to
 * the trackers on every completed write (lib/progress.ts), which would be 500 AniList calls for one tap. The
 * route pushes once, after this returns. ⚠️ No reading_events row, on either path.
 *
 * ⚠️ Does NOT check visibility: the route answers 404 for a series the caller cannot open before calling this.
 */
export async function markNumbers(userId: string, seriesId: string, numbers: number[], source: 'web' | 'komga' = 'web'): Promise<MarkResult> {
  if (!numbers.length) return { marked: 0, viaBook: 0, skipped: [] };
  return tx(async (qq) => {
    // `WHERE NOT completed` on the conflict branch: a chapter already read keeps its updated_at (Continue
    // Reading orders by it, and the cleanup's which-copy rule reads it) and is not counted as moved.
    const viaBook = await qq<{ book_id: string }>(
      `INSERT INTO read_progress (user_id, book_id, series_id, page, completed)
       SELECT $1, b.id, b.series_id, COALESCE(b.pages, 0), true
         FROM lib_books b
         LEFT JOIN book_overrides ov ON ov.book_id = b.id
        WHERE b.series_id = $2 AND COALESCE(ov.number, b.number) = ANY($3::real[])
       ON CONFLICT (user_id, book_id) DO UPDATE
         SET completed = true, page = GREATEST(read_progress.page, EXCLUDED.page), updated_at = now()
         WHERE NOT read_progress.completed
       RETURNING book_id`,
      [userId, seriesId, numbers],
    );
    // ON CONFLICT DO NOTHING keeps the FIRST completed_at: the earliest claim is the one reconciliation has
    // to honour, and re-ticking a number must not make an older mark look new.
    const marked = await qq<{ number: number }>(
      `INSERT INTO listing_progress (user_id, series_id, number, source)
       SELECT $1, l.series_id, l.number, $4
         FROM series_listing l
        WHERE l.series_id = $2 AND l.number = ANY($3::real[]) AND NOT ${HELD('l.series_id', 'l.number')}
       ON CONFLICT (user_id, series_id, number) DO NOTHING
       RETURNING number`,
      [userId, seriesId, numbers, source],
    );
    const skipped = await qq<{ number: string | number }>(
      `SELECT DISTINCT a.number FROM unnest($2::real[]) AS a(number)
        WHERE NOT EXISTS (SELECT 1 FROM series_listing l WHERE l.series_id = $1 AND l.number = a.number)
          AND NOT ${HELD('$1', 'a.number')}
        ORDER BY a.number`,
      [seriesId, numbers],
    );
    return {
      marked: marked.length,
      viaBook: viaBook.length,
      skipped: skipped.map((r) => ({ number: Number(r.number), reason: 'not_listed' as const })),
    };
  });
}

/**
 * Un-mark numbers for one reader on one series. A DELETE, like the library's bulk mark-unread: leaving a
 * row behind with completed=false would make an untouched chapter read as in progress.
 *
 * ⚠️ NOT authorised against the listing, deliberately. It only ever deletes the caller's own rows, and a mark
 * can outlive its listing row (the sweep rewrites a series' listing whole, and a number a source stops listing
 * keeps its mark). Requiring the number to be listed would leave that mark impossible to clear.
 *
 * Nothing is pushed to the trackers: this leaves them ahead of the app, the safe direction, which the
 * monotonic floor in lib/trackers makes explicit.
 */
export async function unmarkNumbers(userId: string, seriesId: string, numbers: number[]): Promise<{ unmarked: number; viaBook: number }> {
  if (!numbers.length) return { unmarked: 0, viaBook: 0 };
  return tx(async (qq) => {
    const viaBook = await qq(
      `DELETE FROM read_progress rp
        USING lib_books b LEFT JOIN book_overrides ov ON ov.book_id = b.id
        WHERE rp.user_id = $1 AND rp.book_id = b.id
          AND b.series_id = $2 AND COALESCE(ov.number, b.number) = ANY($3::real[])
       RETURNING 1`,
      [userId, seriesId, numbers],
    );
    const gone = await qq(
      'DELETE FROM listing_progress WHERE user_id = $1 AND series_id = $2 AND number = ANY($3::real[]) RETURNING 1',
      [userId, seriesId, numbers],
    );
    return { unmarked: gone.length, viaBook: viaBook.length };
  });
}

/**
 * Turn every mark whose number now has a chapter row into ordinary progress on that row, then drop the mark.
 * Called by persistScan (the only place a number stops being a ghost) and by mergeSeries (the survivor may
 * already hold numbers the absorbed series had marked); `seriesId` narrows it to one series.
 *
 * ⚠️ THE TIMESTAMP IS THE MARK'S, AND STRICTLY BEFORE THE FILE. The read-chapter cleanup deletes a chapter
 * whose readers finished THE COPY ON DISK NOW: `done_at >= to_timestamp(mtime)` (dueSql, lib/chapterCleanup).
 * Stamped now(), a reconciled row satisfies that at once and the file the sweep just fetched is deleted within
 * the hour at 0 days -- and the tombstone keeps it from ever being fetched back. The mark's own time is not
 * enough on its own either: persistScan runs once at the END of a sweep, so a chapter can sit on disk while
 * the page still draws it as a ghost, and a tick in that window postdates the file. LEAST(mark, mtime - 1 ms)
 * keeps the original time except in that race. A row with no mtime (0) keeps the mark's time. Reintroduce by
 * carrying lp.completed_at unclamped: "a mark made after the file landed still does not make it cleanup-due"
 * in listingProgress.int.test.ts deletes the file.
 * ⚠️ And LEAST, not GREATEST, when the reader already has an unfinished row on that chapter (a merge carried
 * a mark onto a chapter the survivor holds and they had started, or a scan whose reconcile failed left the
 * mark beside a chapter they then opened). That row's updated_at is when they opened THIS copy, after it
 * landed; flipped to completed while keeping it, the chapter is due at once and deleted out from under
 * someone who was partway through it. The earlier stamp keeps it until they really finish it (the reader's
 * own completed write then stamps now()). Reintroduce by GREATEST: "a mark reconciled onto a chapter the
 * reader had started leaves the file" in listingProgress.int.test.ts deletes the file.
 *
 * ⚠️ OVERRIDE-AWARE, as every ghost comparison is: matched on the raw number, a renumbered chapter would keep a
 * ghost mark forever beside its own row.
 *
 * Two statements rather than one DELETE ... RETURNING feeding the INSERT: when two files share a number (two
 * groups' copies), a DELETE USING returns one join row per MARK, so only one copy would be marked. The INSERT
 * marks every copy, which is what "I have read chapter 57" means. No reading_events row.
 */
export async function reconcileListingProgress(opts: { run?: Run; seriesId?: string } = {}): Promise<number> {
  const body = async (qq: Run): Promise<number> => {
    const only = opts.seriesId ? 'AND lp.series_id = $1' : '';
    const params = opts.seriesId ? [opts.seriesId] : [];
    const moved = await qq(
      `INSERT INTO read_progress (user_id, book_id, series_id, page, completed, updated_at)
       SELECT lp.user_id, b.id, b.series_id, COALESCE(b.pages, 0), true,
              CASE WHEN b.mtime > 0
                   THEN LEAST(lp.completed_at, to_timestamp(b.mtime / 1000.0) - interval '1 millisecond')
                   ELSE lp.completed_at END
         FROM listing_progress lp
         JOIN lib_books b ON b.series_id = lp.series_id
         LEFT JOIN book_overrides ov ON ov.book_id = b.id
        WHERE COALESCE(ov.number, b.number) = lp.number ${only}
       ON CONFLICT (user_id, book_id) DO UPDATE
         SET completed = true,
             page = GREATEST(read_progress.page, EXCLUDED.page),
             updated_at = LEAST(read_progress.updated_at, EXCLUDED.updated_at)
         WHERE NOT read_progress.completed
       RETURNING 1`,
      params,
    );
    await qq(
      `DELETE FROM listing_progress lp
        USING lib_books b LEFT JOIN book_overrides ov ON ov.book_id = b.id
        WHERE b.series_id = lp.series_id AND COALESCE(ov.number, b.number) = lp.number ${only}`,
      params,
    );
    return moved.length;
  };
  return opts.run ? body(opts.run) : tx(body);
}
