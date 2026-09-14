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
 */
import { rm, stat } from 'fs/promises';
import { dirname, resolve } from 'path';
import { q, one } from './db';
import { DL_ROOT } from './library';
import { allWritable, containedPath } from './fsGuard';
import { REFETCH_BAK } from './fsAtomic';
import { runtime, type CleanupResult } from './runtime';

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
           WHERE b.root = $1
             AND b.pruned_at IS NULL
             -- a series the admin has hidden is not this job's business: its files go through Delete files,
             -- on purpose, and examining its read chapters every hour would only ever find folders gone
             AND NOT EXISTS (SELECT 1 FROM lib_series hs WHERE hs.id = b.series_id AND hs.deleted_at IS NOT NULL)
             -- the last reader finished the copy that is on disk now, not the one this file replaced
             AND done.done_at >= to_timestamp(b.mtime / 1000.0)
             AND NOT EXISTS (SELECT 1 FROM bookmarks bm WHERE bm.book_id = b.id)
             AND NOT EXISTS (SELECT 1 FROM lib_series s WHERE s.cover_book_id = b.id)
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
 * of the deletion rather than of the last time something asked.
 */
export async function tombstoneBooks(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await q(
    `UPDATE lib_books
        SET pruned_at = now(), page_dims = NULL, fingerprint = NULL, fp_kind = NULL, fp_at = NULL, size = NULL
      WHERE id = ANY($1) AND pruned_at IS NULL`,
    [ids],
  );
  await q('DELETE FROM page_hashes WHERE book_id = ANY($1) AND override IS NULL', [ids]);
}

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
  if (!on) return empty('disabled');
  if (runtime.stopping) return empty('shutdown', days);

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
  const looked = await Promise.all(due.map(async (b) => {
    const abs = containedPath(b.root, b.file);
    if (!abs || abs === root) return { b, abs: null, st: null, folder: true };
    const st = await stat(abs).catch(() => null);
    const folder = st ? true : !!(await stat(dirname(abs)).catch(() => null));
    return { b, abs, st, folder };
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
  if (looked.every((x) => x.abs && !x.st && !x.folder)) {
    stopped = 'unmounted';
  } else {
    for (const { b, abs, st } of looked) {
      if (runtime.stopping) break; // between files, never mid-unlink
      if (!abs) continue;
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
      await tombstoneBooks([b.id]);
      deleted++;
    }
  }

  // Recounted rather than derived: rows pruned above no longer qualify, and a run that stopped early for a
  // shutdown must not report its leftovers as zero.
  const remaining = await dueCount(days).catch(() => 0);
  // Warm the panel's memo with what the run just measured, so the badge is right on the next poll instead
  // of showing the pre-run backlog for another half minute.
  cached = { days: clampDays(days), at: Date.now(), n: remaining };
  return { deleted, bytes, remaining, failed, ms: Date.now() - t0, days, ...(stopped ? { stopped } : {}) };
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
      if (r.stopped === 'unmounted') log?.warn(`cleanup: every due chapter's folder under ${DL_ROOT} is missing -- is the volume mounted? Nothing was marked; ${r.remaining} chapter(s) wait for the next run`);
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
        + (r.stopped === 'unmounted' ? ' (stopped: every due chapter\'s folder is missing, is the volume mounted?)' : '');
