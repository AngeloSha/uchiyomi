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
import { q, one } from './db';
import { DL_ROOT } from './library';
import { allWritable, containedPath } from './fsGuard';
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
  return `SELECT b.id, b.root, b.file
            FROM lib_books b
            JOIN (
              SELECT book_id, max(updated_at) AS done_at
                FROM read_progress
               GROUP BY book_id
              HAVING bool_and(completed)
                 AND max(updated_at) <= now() - make_interval(days => $2)
            ) done ON done.book_id = b.id
           WHERE b.root = $1
             AND b.pruned_at IS NULL
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
  for (const b of due) {
    if (runtime.stopping) break; // between files, never mid-unlink
    const abs = containedPath(b.root, b.file);
    // A path that escapes its root is not something to "clean up"; it is something to leave alone and let
    // the health page argue about. Not counted as a failure -- there is nothing to retry.
    if (!abs) continue;
    const st = await stat(abs).catch(() => null);
    if (st) {
      try {
        await rm(abs, { recursive: true, force: true });
      } catch {
        failed++;
        continue;
      }
      bytes += st.size;
    }
    // st === null means the file was already gone. Mark it anyway: the row was claiming bytes that do not
    // exist, and leaving it unmarked means re-examining it on every run for as long as the install lives.
    await q('UPDATE lib_books SET pruned_at = now() WHERE id = $1', [b.id]);
    deleted++;
  }

  // Recounted rather than derived: rows pruned above no longer qualify, and a run that stopped early for a
  // shutdown must not report its leftovers as zero.
  const remaining = await dueCount(days).catch(() => 0);
  // Warm the panel's memo with what the run just measured, so the badge is right on the next poll instead
  // of showing the pre-run backlog for another half minute.
  cached = { days: clampDays(days), at: Date.now(), n: remaining };
  return { deleted, bytes, remaining, failed, ms: Date.now() - t0, days };
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
      if (r.failed) log?.warn(`cleanup: ${r.failed} chapter file(s) could not be deleted; they will be retried`);
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
        + (r.failed ? `, ${r.failed} failed` : '');
