/**
 * The opt-in read-chapter cleanup: delete the file of a chapter everyone who started it has finished, once
 * it has been finished for N days.
 *
 * ⚠️ THIS IS THE ONLY SCHEDULED JOB IN THE PRODUCT THAT DESTROYS DATA. Everything below is shaped by that.
 *
 * WHAT IT DELETES
 *   Bytes, and only bytes, and only under DL_ROOT -- the directory this server downloaded into itself. The
 *   read library is somebody's own collection; we did not put those files there and we do not get to remove
 *   them. A chapter under DL_ROOT is one we fetched and, in principle, could fetch again, which is the only
 *   footing on which an unattended delete is defensible at all.
 *
 * WHAT IT KEEPS
 *   The lib_books row, marked `pruned_at`, and every read_progress row pointing at it. See the long note on
 *   the column in lib/migrate.ts: erasing the row would erase what people read (read_progress.book_id is ON
 *   DELETE RESTRICT precisely to stop that), and it would also make the chapter "missing" to the updater,
 *   whose have-set is `SELECT number FROM lib_books` -- so the next sweep would re-download exactly what
 *   this job just deleted, every night, forever. The tombstone is what makes the deletion stick.
 *
 * WHO COUNTS AS HAVING READ IT
 *   read_progress holds one row per (user, chapter) and a row exists only for someone who opened it. So:
 *     - at least one row, all of them `completed`  -> everyone who started it finished it
 *     - any row with completed = false             -> somebody is partway through; leave it alone
 *     - no rows at all                             -> nobody has read it; not this job's business
 *   The clock is `max(updated_at)` over those rows, so the grace period restarts if anyone touches it again,
 *   and the last person to finish gets the full N days rather than the first.
 *   ⚠️ `completed` alone is not "finished": a page ping never un-completes a row (lib/progress.ts keeps
 *   `completed OR EXCLUDED.completed`), so somebody re-reading a chapter they finished last year is on page
 *   3 of 40 with `completed = true` and a fresh `updated_at`. With N days of grace the restart of the clock
 *   covers them; at zero days it does not, and the first cut deleted the file out from under them. So a
 *   completed row counts as finished only when its page is at the end of the file (reachedEnd in
 *   lib/progressRules.ts: `page >= pages - 1`; "Mark read" writes `page = pages`, so it still qualifies), and
 *   a chapter whose page count is unknown (`pages <= 1`) keeps the plain rule, because there is no end to
 *   compare against.
 *
 * WHICH COPY THEY READ
 *   The reads have to be of the file that is on disk NOW, not of one this file replaced: `done_at` must be
 *   at or after the file's mtime. A prune leaves every reader's row `completed` with its old `updated_at`,
 *   so a chapter fetched again afterwards -- by an admin's "fetch again", by a re-copy, by a restore -- was
 *   otherwise due at the very next hourly run, and the pair of them would go round forever: fetch, delete,
 *   fetch, delete, a chapter nobody can keep. persistScan refreshes `mtime` on every scan and clears the
 *   mark, so a re-downloaded file always carries a fresh mtime; `mtime = 0` (stat failed) compares as 1970
 *   and degrades to the plain rule.
 *   The one side effect: an install whose files were copied without preserving mtimes (a `cp` without -p,
 *   a rsync without -t) has every chapter's mtime at the copy, so chapters finished BEFORE the copy are not
 *   due until somebody reads them again. That fails toward keeping, which is the only way this job may fail.
 *
 * ZERO DAYS IS A REAL SETTING and means "at the next run", not "off". `cleanup_read` is the off switch.
 *
 * TWO VETOES, both for things that point INTO the file rather than at the chapter:
 *   - a bookmark names a page number inside it, so deleting the pages turns it into a pointer at nothing.
 *     Progress survives a prune (it is a count); a bookmark does not.
 *   - the series' cover_book_id. Every cover, thumbnail and backdrop in the product falls back to the first
 *     page of that chapter when there is no artwork to fetch, so pruning it takes the art off the series,
 *     the library grid and the home rails. It is one chapter per series, and it is always the lowest number
 *     -- so this costs almost nothing and cannot drift, because persistScan recomputes it the same way.
 *
 * AND NEVER THE LAST COPY. "We could fetch it again" is a claim about the sources, and their last listing
 * (series_listing, lib/seriesListing.ts) is where it can be checked. Once a series has a listing, a chapter whose
 * number is no longer in it -- a takedown, a deleted post, a source that dropped it -- is a file nothing could
 * replace, so it stays. For a file holding a range (lib/chapterRanges.ts) that is every whole number it holds, not
 * only its start. A series with no listing at all says nothing either way and is judged as before.
 *     Listed means fetchable (FETCHABLE): a number listed only from blocked groups or in another language, or only
 *     as an external link -- MangaDex keeps a licensed chapter as a zero-page link to the publisher -- could not be
 *     downloaded again either, so it counts as not listed.
 */
import { rm } from 'fs/promises';
import { dirname, resolve } from 'path';
import { q, one } from './db';
import { DL_ROOT, LIBRARY_ROOT } from './library';
import { allWritable, containedPath, rootUnavailable, statOrGone } from './fsGuard';
import { catalogFileCounts, looksUnmounted } from './catalogRootGuard';
import { REFETCH_BAK } from './fsAtomic';
import { runtime, type CleanupResult } from './runtime';
import { atHiddenNumber, hiddenNumbersActive } from './noticeChapters';
import { rangeEnd } from './chapterRanges';
import { logLevel } from '../env';

/**
 * A listing row the sweep could fetch again (see the header): not `blocked` -- every copy from a blocked group or in
 * another language (lib/releases.ts) -- and not a zero-page external link, which cannot be downloaded (repair.ts skips
 * them for the same reason). A row whose page count is unknown counts as fetchable, as before.
 */
const FETCHABLE = `sl.status <> 'blocked' AND (sl.chosen->>'pages') IS DISTINCT FROM '0'`;

/**
 * "Never the last copy" (the header) over the lib_books row `b` and its LEFT JOINed book_overrides row `ov`: true when the
 * series has a listing and some number the file holds is not in it as a row the sweep could fetch again. One fragment
 * for the job (dueSql) and for its explanation (keptReasons), so the two cannot drift.
 */
const lastCopy = `(EXISTS (SELECT 1 FROM series_listing sl WHERE sl.series_id = b.series_id)
                      AND (NOT EXISTS (SELECT 1 FROM series_listing sl
                                        WHERE sl.series_id = b.series_id AND sl.number = COALESCE(ov.number, b.number)
                                          AND ${FETCHABLE})
                           OR EXISTS (SELECT 1 FROM generate_series(floor(b.number)::numeric + 1, floor(${rangeEnd('b', 'ov')})::numeric) held(n)
                                       WHERE NOT EXISTS (SELECT 1 FROM series_listing sl
                                                          WHERE sl.series_id = b.series_id AND sl.number = held.n::real
                                                            AND ${FETCHABLE}))))`;

/**
 * Most chapters one run will delete. Not a performance limit -- unlink is cheap -- but a blast radius:
 * the first run after switching this on, on a library that has been read for years, is the one run whose
 * scale nobody has an intuition for. Whatever is left over is taken by the next tick an hour later.
 */
const MAX_PER_RUN = Number(process.env.CLEANUP_MAX_PER_RUN) || 500;

/** The settings row, clamped. Defaults are the OFF ones, so an unreadable row cannot start a delete. */
export async function cleanupSettings(): Promise<{ on: boolean; days: number }> {
  const row = await one<{ on: boolean; days: number }>(
    'SELECT cleanup_read AS on, cleanup_read_days AS days FROM server_settings WHERE id = 1',
  ).catch(() => null);
  return { on: row?.on === true, days: clampDays(row?.days) };
}

/** 0 is meaningful (delete at the next run); the ceiling is only there to keep the interval arithmetic sane. */
export const clampDays = (d: unknown): number =>
  Math.min(3650, Math.max(0, Math.floor(Number(d ?? 30) || 0)));

interface Due { id: string; root: string; file: string }

/**
 * Chapters whose bytes may go, oldest-finished first.
 *
 * The grouped subquery is the whole rule in one place: a group exists only for a chapter someone opened,
 * `bool_and(completed)` is "and everyone who opened it finished it", and `max(updated_at)` is when the last
 * of them did. HAVING rather than a WHERE on the outer query so the aggregate is filtered before the join.
 */
export function dueSql(limit: number | null): string {
  // lib_books is joined INTO the aggregate for its page count: a completed row whose page is not at the end
  // is somebody re-reading, and the whole chapter is vetoed for it (see WHO COUNTS AS HAVING READ IT above).
  // Reintroduce by reducing the HAVING to `bool_and(rp.completed)`: "a reader re-reading a chapter they
  // finished keeps it" in chapterCleanup.int.test.ts deletes the file they are on page 3 of.
  return `SELECT b.id, b.root, b.file
            FROM lib_books b
            JOIN (
              SELECT rp.book_id, max(rp.updated_at) AS done_at
                FROM read_progress rp
                JOIN lib_books lb ON lb.id = rp.book_id
               GROUP BY rp.book_id
              HAVING bool_and(rp.completed AND (lb.pages <= 1 OR rp.page >= lb.pages - 1))
                 AND max(rp.updated_at) <= now() - make_interval(days => $2)
            ) done ON done.book_id = b.id
            LEFT JOIN book_overrides ov ON ov.book_id = b.id
           WHERE b.root = $1
             AND b.pruned_at IS NULL
             -- a series the admin has hidden is not this job's business: its files go through Delete files,
             -- on purpose, and examining its read chapters every hour would only ever find folders gone
             AND NOT EXISTS (SELECT 1 FROM lib_series hs WHERE hs.id = b.series_id AND hs.deleted_at IS NOT NULL)
             -- the last reader finished the copy that is on disk now, not the one this file replaced
             AND done.done_at >= to_timestamp(b.mtime / 1000.0)
             AND NOT EXISTS (SELECT 1 FROM bookmarks bm WHERE bm.book_id = b.id)
             AND NOT EXISTS (SELECT 1 FROM lib_series s WHERE s.cover_book_id = b.id)
             -- never the last copy (see the header): once the series has a listing, every number the file holds is
             -- in it. The number is override-aware, as the listing's are under posting order; an admin's number
             -- cancels a range (rangeEnd is NULL, and generate_series gives nothing). Reintroduce by dropping the
             -- clause: "a chapter the sources no longer list is never deleted" in lastCopyGuard.int.test.ts finds
             -- the file gone.
             AND NOT ${lastCopy}${hiddenNumbersActive() ? `
             -- a chapter at a number an admin hid (#240) is left exactly as it is: Restore brings back what was there
             AND NOT ${atHiddenNumber('b')}` : ''}
           ORDER BY done.done_at ASC` + (limit === null ? '' : `\n           LIMIT ${limit}`);
}

/** How many chapters are due right now. Exact, and used for `remaining` at the end of a run. */
export const dueCount = async (days: number): Promise<number> =>
  (await one<{ n: number }>(
    `SELECT count(*)::int n FROM (${dueSql(null)}) d`,
    [DL_ROOT, clampDays(days)],
  ))?.n ?? 0;

/**
 * The same number for the admin panel, memoised for half a minute.
 *
 * The Tasks view polls every five seconds while it is open, and this is a group-aggregate over the whole of
 * read_progress -- a table with a row per person per chapter ever opened. An exact figure is worth having;
 * an exact figure recomputed twelve times a minute so that a badge can say "1,842" instead of "1,842" is
 * not. The job itself never reads this.
 */
const CACHE_MS = 30_000;
let cached: { days: number; at: number; n: number } | null = null;
export async function dueCountCached(days: number): Promise<number> {
  const d = clampDays(days);
  // Keyed on the day count as well as the clock: changing the setting must change the number at once, which
  // is the whole point of showing it on the page where the setting is changed.
  if (cached && cached.days === d && Date.now() - cached.at < CACHE_MS) return cached.n;
  const n = await dueCount(d);
  cached = { days: d, at: Date.now(), n };
  return n;
}

/**
 * LOG_LEVEL=debug (#332): `[cleanup]` lines in the server log on every run, saying why each read chapter on the download
 * disk stays. @TIGamingTV's read chapters stopped going and the log said only "0 read chapter(s) deleted": each rule
 * above that keeps a file is right on its own, and nothing said which one was holding his. Mutable for the tests.
 */
export const cleanupLog = { on: logLevel === 'debug' || logLevel === 'trace' };
const trace = (line: string) => { if (cleanupLog.on) console.log(`[cleanup] ${line}`); };

/** Why a read chapter on the download disk stays this run: the first rule that holds it, in dueSql's order. */
export type KeptWhy = 'reading' | 'recent' | 'changed' | 'removed' | 'bookmarked' | 'cover' | 'last_copy' | 'hidden';

export interface KeptReasons {
  /** Chapters on the download disk somebody opened, not deleted yet. */
  read: number;
  /** Of them, the ones the job would delete now: dueSql's count, by the same rules. */
  due: number;
  /** The rest, by the first rule that keeps each, with a few of them by series title and number. */
  kept: Array<{ why: KeptWhy; n: number; examples: string[] }>;
}

/**
 * What keeps each read chapter on the download disk: the first rule that applies, as dueSql applies them. A chapter
 * nobody opened is not this job's business and is not counted. The last-copy rule is dueSql's own fragment; the rest
 * are its clauses turned round. Reintroduce a rule dueSql has and this lacks: "every read chapter is either due or
 * kept for a reason" in cleanupWhy.int.test.ts finds a chapter in neither.
 */
export async function keptReasons(days: number): Promise<KeptReasons> {
  const rows = await q<{ why: KeptWhy | null; title: string; number: number }>(
    `WITH done AS (
       SELECT rp.book_id, max(rp.updated_at) AS done_at,
              bool_and(rp.completed AND (lb.pages <= 1 OR rp.page >= lb.pages - 1)) AS finished
         FROM read_progress rp
         JOIN lib_books lb ON lb.id = rp.book_id
        WHERE lb.root = $1 AND lb.pruned_at IS NULL
        GROUP BY rp.book_id
     )
     SELECT CASE
              WHEN NOT COALESCE(done.finished, false) THEN 'reading'
              WHEN done.done_at > now() - make_interval(days => $2) THEN 'recent'
              WHEN done.done_at < to_timestamp(b.mtime / 1000.0) THEN 'changed'
              WHEN s.deleted_at IS NOT NULL THEN 'removed'
              WHEN EXISTS (SELECT 1 FROM bookmarks bm WHERE bm.book_id = b.id) THEN 'bookmarked'
              WHEN EXISTS (SELECT 1 FROM lib_series cs WHERE cs.cover_book_id = b.id) THEN 'cover'
              WHEN ${lastCopy} THEN 'last_copy'
              WHEN ${atHiddenNumber('b')} THEN 'hidden'
            END AS why,
            s.title, COALESCE(ov.number, b.number)::float8 AS number
       FROM lib_books b
       JOIN done ON done.book_id = b.id
       JOIN lib_series s ON s.id = b.series_id
       LEFT JOIN book_overrides ov ON ov.book_id = b.id
      WHERE b.root = $1 AND b.pruned_at IS NULL
      ORDER BY done.done_at ASC`,
    [DL_ROOT, clampDays(days)],
  );
  const kept = new Map<KeptWhy, { why: KeptWhy; n: number; examples: string[] }>();
  let due = 0;
  for (const r of rows) {
    if (!r.why) { due++; continue; }
    const k = kept.get(r.why) ?? { why: r.why, n: 0, examples: [] };
    k.n++;
    if (k.examples.length < 3) k.examples.push(`${JSON.stringify(r.title)} ${Number(r.number)}`);
    kept.set(r.why, k);
  }
  return { read: rows.length, due, kept: [...kept.values()].sort((a, b) => b.n - a.n) };
}

/** Each rule in words, for the `[cleanup]` lines. */
const KEPT_LINE: Record<KeptWhy, (days: number) => string> = {
  reading: () => 'someone who opened it has not finished it',
  recent: (days) => `finished less than ${days} day${days === 1 ? '' : 's'} ago`,
  changed: () => 'the file on disk is newer than the last read of it (fetched again since)',
  removed: () => 'its series is removed (Delete files is for those)',
  bookmarked: () => 'it has a bookmark',
  cover: () => "it is the series' cover chapter",
  last_copy: () => 'the sources no longer list it as one they could fetch again, so it is the last copy',
  hidden: () => 'its number is hidden by hand',
};

/** The `[cleanup]` lines for one run, before it looks at any file. Best effort: never fails the run. */
async function explainRun(days: number): Promise<void> {
  try {
    const r = await keptReasons(days);
    trace(`on, after ${days} day${days === 1 ? '' : 's'}: ${r.read} read chapter${r.read === 1 ? '' : 's'} under ${DL_ROOT}, ${r.due} due now`);
    for (const k of r.kept) trace(`${k.n} kept: ${KEPT_LINE[k.why](days)} -- e.g. ${k.examples.join(', ')}`);
  } catch (e) {
    trace(`could not say why chapters are kept: ${(e as Error)?.message || e}`);
  }
}

/**
 * A tombstone forgets everything derived from the bytes, so a file that comes back is re-measured.
 *
 * `page_dims` is a cache that outlives the pages, and so are the fingerprint and the size. A chapter fetched
 * again from another group has a different page count and different page sizes; had the old dims stayed on
 * the row, the reader would lay the new file out to the old measurements and the fingerprint would claim
 * the new bytes were the old ones. Nulling them here means the next scan and the next backfill measure
 * what is actually there. Computed page hashes go for the same reason; a page somebody marked by hand
 * (`override` set) is a decision about the chapter, not a measurement of the file, and is kept.
 *
 * Idempotent on the pruned_at guard: a row already marked is not re-stamped, so the mark keeps the time
 * of the deletion rather than of the last time something asked -- and keeps its REASON, so a verify run
 * over a library the cleanup has pruned cannot relabel a deliberate deletion as a missing file.
 *
 * `reason` says why the bytes are gone (the column note in lib/migrate.ts): this job passes nothing, the
 * admin's Delete files passes 'deleted', Verify passes 'missing', and Rescan passes 'rescan_missing'. The
 * latter two are observations rather than deliberate deletions, so the updater recovers both -- see heldBooks.
 */
export type PrunedReason = 'deleted' | 'missing' | 'rescan_missing';

export async function tombstoneBooks(ids: string[], reason: PrunedReason | null = null): Promise<void> {
  if (!ids.length) return;
  await q(
    `UPDATE lib_books
        SET pruned_at = now(), pruned_reason = $2, page_dims = NULL, fingerprint = NULL, fp_kind = NULL, fp_at = NULL, size = NULL
      WHERE id = ANY($1) AND pruned_at IS NULL`,
    [ids, reason],
  );
  await q('DELETE FROM page_hashes WHERE book_id = ANY($1) AND override IS NULL', [ids]);
}

/**
 * SQL predicate for the rows the library still counts as HELD -- the updater's have-set, and the one
 * place the meaning of a tombstone's reason is spelled out.
 *
 * A live row is held. A cleanup tombstone (reason NULL) and a Delete-files tombstone ('deleted') are held
 * too: the bytes went on purpose, and the whole point of keeping the row (the note on pruned_at in
 * lib/migrate.ts) is that the sweep does not fetch them back every night. A 'missing' tombstone is NOT
 * held: the verify task wrote it because the file was simply not there -- a database restored without its
 * chapter files -- and fetching it again is exactly what the person wants. A `rescan_missing` tombstone is
 * the same nondeliberate fact discovered by Rescan, and must be recoverable too.
 * ⚠️ `IS DISTINCT FROM`, not `<>`: a NULL reason compared with `<>` is NULL, which reads as false, and
 * every cleanup tombstone would silently become "missing".
 * Reintroduce by returning `${col}pruned_at IS NULL`: "a cleanup tombstone is still held, so the sweep
 * does not fetch it back" in verifyFiles.int.test.ts downloads the chapter the cleanup deleted.
 */
export const heldBooks = (alias = ''): string => {
  const col = alias ? `${alias}.` : '';
  return `(${col}pruned_at IS NULL OR (${col}pruned_reason IS DISTINCT FROM 'missing' AND ${col}pruned_reason IS DISTINCT FROM 'rescan_missing'))`;
};

/**
 * Clear the mark on chapters whose file the boot-time reaper (reapStaleTemp in lib/fsAtomic.ts) has just
 * put back: `files` are relative to `root` the way lib_books.file is. Called from server.ts right after the
 * reap, because nothing else would: there is no boot scan, the sweep scans only when it added something and
 * this job skips tombstones -- so without this the restored chapter read "deleted" until an unrelated scan
 * happened to run. Nothing derived from the bytes is put back (the scan re-measures the file it finds).
 * Reintroduce by dropping the UPDATE: "an interrupted refetch is put back at boot" in
 * chapterActions.int.test.ts finds the row still marked with its file on disk.
 */
export async function unpruneRestored(root: string, files: string[]): Promise<number> {
  if (!files.length) return 0;
  const rows = await q<{ id: string }>(
    'UPDATE lib_books SET pruned_at = NULL WHERE root = $1 AND file = ANY($2) AND pruned_at IS NOT NULL RETURNING id',
    [root, files],
  );
  return rows.length;
}

/**
 * Is the download share there, judged by every live chapter row under DL_ROOT -- Verify's two whole-root rules
 * (lib/verifyFiles.ts, shared through lib/catalogRootGuard.ts), asked before this job marks any row whose file it
 * did not find. Only a file the catalog knows is proof, and one in ten is not enough. Null when the share answers for
 * its files, or what was seen when it does not.
 */
async function shareMissing(): Promise<{ missing: number; of: number } | null> {
  const c = await catalogFileCounts(DL_ROOT, LIBRARY_ROOT);
  return looksUnmounted(c) ? { missing: c.missing, of: c.present + c.missing } : null;
}

/**
 * One pass. Returns what it did; never throws for a file it could not remove.
 *
 * The order per chapter is delete-then-mark, deliberately. Marking first and then failing to unlink would
 * leave a row claiming the bytes are gone while they are still on disk and still counted by nothing -- an
 * invisible leak. This way a failed unlink is simply retried on the next run.
 */
export async function runCleanupOnce(): Promise<CleanupResult> {
  const t0 = Date.now();
  const empty = (skipped?: CleanupResult['skipped'], days?: number): CleanupResult =>
    ({ deleted: 0, bytes: 0, remaining: 0, failed: 0, ms: Date.now() - t0, ...(skipped ? { skipped } : {}), ...(days === undefined ? {} : { days }) });

  const { on, days } = await cleanupSettings();
  // Consent is re-read here rather than passed in, so the off switch stops a run that is about to start as
  // well as one that is scheduled -- and so the manual button cannot route around it.
  // At debug the off switch is said too: a disabled tick records nothing anywhere else (runChapterCleanup).
  if (!on) { trace('switched off (Admin → Settings → Downloads → Delete read chapters): nothing is looked at'); return empty('disabled'); }
  if (runtime.stopping) return empty('shutdown', days);
  if (cleanupLog.on) await explainRun(days);

  const due = await q<Due>(dueSql(MAX_PER_RUN), [DL_ROOT, days]);
  if (!due.length) return empty(undefined, days);

  // Probed only when there is something to do: this writes a temp directory, and doing that hourly to prove
  // a point about a job with nothing to delete is noise on somebody's NAS.
  const w = await allWritable([DL_ROOT]);
  if (!w.ok) return empty('read_only', days);

  let deleted = 0;
  let bytes = 0;
  let failed = 0;
  let stopped: CleanupResult['stopped'];
  const root = resolve(DL_ROOT);
  // Where every due file is, looked up before anything is touched. A path that escapes its root is not
  // something to "clean up"; it is something to leave alone and let the health page argue about. The root
  // ITSELF is refused on the same footing: containedPath accepts it (it is "inside" trivially), and the rm
  // below is recursive, so a row whose file resolves to `.` -- only a hand-edited row can, today -- would
  // take the whole download directory with it. One comparison against the entire library is a cheap guard.
  // Reintroduce by dropping the `abs === root` check: "the download root itself is never the file" in
  // chapterCleanup.int.test.ts finds the directory gone.
  // A file it may not look at (EACCES from a folder whose mode bits slipped, a dropped share's ENOTCONN) is NOT a
  // file already gone (statOrGone, #321's rule): it is left, row and all, and counted as not removed. Marked on that
  // evidence it would vanish from every reader while its bytes sit on disk, and its deleted record would stop the
  // sweep from fetching it back. Reintroduce `stat(abs).catch(() => null)`: "a chapter in a folder the server may not
  // look into is left unmarked" in chapterCleanup.int.test.ts finds it marked.
  // And a folder is proof of a mount only when it holds something (#323): the downloader mkdir -p's a series folder
  // before it writes, so a sweep that ran while the share was down leaves EMPTY folders on the bare mount point
  // (Verify says the same). Reintroduce `stat(dirname(abs))` for the folder: "... on a bare mount point with an empty
  // folder a sweep left" in libraryRootGone.int.test.ts finds the chapters tombstoned.
  const looked = await Promise.all(due.map(async (b) => {
    const abs = containedPath(b.root, b.file);
    if (!abs || abs === root) return { b, abs: null, st: null, folder: true, unreadable: null };
    const seen = await statOrGone(abs);
    if (typeof seen === 'string') return { b, abs, st: null, folder: true, unreadable: seen };
    const folder = seen ? true : !(await rootUnavailable(dirname(abs)));
    return { b, abs, st: seen, folder, unreadable: null };
  }));
  // ⚠️ WHEN EVERY DUE CHAPTER'S FOLDER IS MISSING, THE VOLUME IS NOT THERE. A NAS share that is not mounted
  // right now leaves an empty, writable mount point behind, so the preflight above passes and every stat
  // fails. Marking on that evidence would tombstone up to MAX_PER_RUN chapters an hour as "deleted" while
  // their files are fine on the unmounted disk -- hidden from every reader until some scan happened to run,
  // and every measured page dimension and page hash thrown away for good. So nothing is marked and the run
  // says why. It is deliberately the WHOLE batch that decides: one missing folder among present ones is a
  // series whose files were removed (the product's own Delete files, or a hand) and its rows are honestly
  // marked below -- the first version of this guard stopped at the first such row and, because those rows
  // are the oldest-finished and sort first, wedged the job for good after an ordinary series removal.
  // Reintroduce by marking rows whose folder is missing regardless of the others: "a missing download
  // folder stops the run instead of marking chapters deleted" in chapterCleanup.int.test.ts finds pruned_at
  // set; drop the "every" and make it per-row again: "a removed series does not wedge the cleanup" finds
  // the live series' chapter still on disk.
  // ⚠️ AND A FOLDER THAT HOLDS SOMETHING IS NOT PROOF EITHER, when what it holds is what a sweep fetched onto the bare
  // mount point while the share was down: a new chapter of a known series fills that series' folder, the check above
  // passes, and every other due chapter -- on the share, intact -- would be tombstoned 'deleted', which is held, so
  // the sweep never fetches it back. So before any row is marked without its file, the whole download root answers
  // (shareMissing above): no catalogued file present, or more than nine in ten missing, is the share not being there,
  // and nothing is marked or deleted. Only such a run pays for the walk (one stat per live row); an ordinary run
  // finds every due file and never asks. A series removed by hand is a few rows in many and is still marked.
  // Reintroduce by dropping the shareMissing() call: "... a sweep wrote a new chapter of a KNOWN series into marks
  // nothing" in cleanupBareMount.int.test.ts finds four chapters tombstoned; drop the 90 % rule and "... after a
  // scan indexed the new chapter" does.
  let share: { missing: number; of: number } | null = null;
  if (looked.every((x) => x.abs && !x.st && !x.folder)) {
    stopped = 'unmounted';
  } else if (looked.some((x) => x.abs && !x.st && !x.unreadable) && (share = await shareMissing())) {
    stopped = 'unmounted';
  } else {
    for (const { b, abs, st, unreadable } of looked) {
      if (runtime.stopping) break; // between files, never mid-unlink
      if (!abs) continue;
      if (unreadable) {
        console.warn(`[cleanup] ${b.file} could not be looked at (${unreadable}) -- left as it is`);
        failed++;
        continue;
      }
      if (st) {
        try {
          await rm(abs, { recursive: true, force: true });
        } catch {
          failed++;
          continue;
        }
        bytes += st.size;
        // A set-aside copy from a refetch the process died in (`<file>.refetch-bak` beside a landed file,
        // which reapStaleTemp deliberately leaves alone) must not outlive this delete: at the next boot the
        // reaper would see a bak with no original, put it back, and the chapter this job deleted would be on
        // disk again with its space unreclaimed -- to be deleted once more an hour later, round and round.
        await rm(`${abs}${REFETCH_BAK}`, { force: true }).catch(() => {});
      }
      // st === null means the file was already gone -- alone, or with its whole folder while other folders
      // are present, which is a series whose files were removed. Mark it anyway: the row was claiming bytes
      // that do not exist, and leaving it unmarked means re-examining it on every run for as long as the
      // install lives.
      // The cleanup deliberately removed this owned file, just like the chapter/series Delete files
      // actions. Keep that provenance so the chapter can be offered as an ID-bound restore and is never
      // confused with Verify/Rescan evidence that bytes vanished outside an explicit delete.
      await tombstoneBooks([b.id], 'deleted');
      deleted++;
    }
  }

  // Recounted rather than derived: rows pruned above no longer qualify, and a run that stopped early for a
  // shutdown must not report its leftovers as zero.
  const remaining = await dueCount(days).catch(() => 0);
  // Warm the panel's memo with what the run just measured, so the badge is right on the next poll instead
  // of showing the pre-run backlog for another half minute.
  cached = { days: clampDays(days), at: Date.now(), n: remaining };
  return { deleted, bytes, remaining, failed, ms: Date.now() - t0, days, ...(stopped ? { stopped } : {}), ...(share ? { share } : {}) };
}

/**
 * Run it the way the schedule runs it: one at a time, result kept, outcome logged, last-run persisted.
 *
 * Same contract as runSweep in lib/updater.ts -- returns `false` when a run is already in flight, otherwise
 * the promise -- so the hourly tick and the admin's Run now button get identical treatment and can see each
 * other. Returning the promise rather than awaiting lets the route answer immediately.
 */
export function runChapterCleanup(log?: { info: (m: string) => void; warn: (m: string) => void; error: (e: any) => void }): Promise<CleanupResult> | false {
  if (runtime.cleaning) return false;
  runtime.cleaning = true;
  return (async () => {
    try {
      const r = await runCleanupOnce();
      // A disabled tick is a no-op, not an event, and nothing about it is recorded -- not the timestamp, not
      // the result, not a log line. Recording it would mean that switching the job on showed a "last run"
      // from an hour ago that had never looked at anything, and a schedule line under a job that had been
      // off for a month claiming it ran at the top of the hour.
      if (r.skipped !== 'disabled') {
        runtime.lastCleanup = Date.now();
        runtime.lastCleanupResult = r;
        await q(
          'UPDATE server_settings SET cleanup_read_last_run = now(), cleanup_read_last_result = $1::jsonb WHERE id = 1',
          [JSON.stringify(r)],
        ).catch(() => {});
        log?.info(summarise(r));
      }
      if (r.stopped === 'unmounted' && r.share) log?.warn(`cleanup: ${r.share.missing} of ${r.share.of} chapter files under ${DL_ROOT} are missing -- is the volume mounted? Nothing was marked or deleted; ${r.remaining} chapter(s) wait for the next run`);
      else if (r.stopped === 'unmounted') log?.warn(`cleanup: every due chapter's folder under ${DL_ROOT} is missing -- is the volume mounted? Nothing was marked; ${r.remaining} chapter(s) wait for the next run`);
      else if (r.failed) log?.warn(`cleanup: ${r.failed} chapter file(s) could not be deleted; they will be retried`);
      return r;
    } catch (e) {
      // Never leave yesterday's healthy result standing after a run that threw -- the same reasoning as the
      // sweep's. An admin reading "freed 4 GB" about a run that died is worse off than one reading nothing.
      runtime.lastCleanup = Date.now();
      runtime.lastCleanupResult = null;
      log?.error(e);
      throw e;
    } finally {
      runtime.cleaning = false;
    }
  })();
}

const summarise = (r: CleanupResult): string =>
  r.skipped === 'read_only'
    ? `cleanup: ${DL_ROOT} is not writable, nothing deleted`
    : r.skipped === 'shutdown'
      ? 'cleanup: stopped for shutdown'
      : `cleanup: ${r.deleted} read chapter(s) deleted, ${r.bytes} bytes freed`
        + (r.remaining ? `, ${r.remaining} still due` : '')
        + (r.failed ? `, ${r.failed} failed` : '')
        + (r.stopped === 'unmounted' && r.share ? ` (stopped: ${r.share.missing} of ${r.share.of} chapter files are missing, is the volume mounted?)`
          : r.stopped === 'unmounted' ? ' (stopped: every due chapter\'s folder is missing, is the volume mounted?)' : '');
