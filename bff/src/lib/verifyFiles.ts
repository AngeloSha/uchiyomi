/**
 * "Verify chapter files": mark the chapter rows whose file is not on disk, so the sweep fetches them again.
 *
 * WHY IT EXISTS
 *   A backup holds the database and the config, never the chapter files (docs/USAGE.md, "What isn't").
 *   A database restored onto a disk that lost them -- or onto a new one -- comes up with every lib_books
 *   row intact and no bytes behind them. Nothing repairs that by itself: persistScan only ever upserts what
 *   it finds (there is no DELETE FROM lib_books anywhere), and the updater's have-set trusts the rows, so
 *   every one of those chapters reads "up to date" forever while the reader opens onto "Chapter deleted".
 *
 * WHAT IT DOES
 *   One stat per un-pruned row, root by root, and a tombstone (lib/chapterCleanup.ts tombstoneBooks) with
 *   reason 'missing' for each DOWNLOAD-ROOT file that is not there. The row stays -- read_progress.book_id
 *   is ON DELETE RESTRICT and the row IS everyone's reading history of that chapter -- and the reason is
 *   what makes the sweep fetch it again: heldBooks() counts a cleanup or Delete-files tombstone as held and
 *   a 'missing' one as not (the column note in lib/migrate.ts). A re-fetched file lands at the same (root,
 *   file), so persistScan clears the mark on the same row and the history reattaches.
 *
 * ⚠️ ONLY ROWS UNDER DL_ROOT ARE MARKED. The downloader writes every chapter to DL_ROOT/<folder>/Chapter
 *   N.cbz (lib/downloader.ts) and persistScan keys rows on (root, file), so a read-library (LIBRARY_ROOT)
 *   row marked 'missing' would be "fetched again" into a DIFFERENT row: the tombstone would never clear,
 *   the series page would list the number twice and the reading history would stay on the dead row. The
 *   cleanup, the chapter delete and Fetch again all draw the same line (owned = root === DL_ROOT). A
 *   read-library file that is gone is COUNTED, in `readLibraryMissing`, for the admin to restore by hand or
 *   through the engine -- never marked. Reintroduce by dropping the root test from the marking branch:
 *   "a read-library row whose file is gone is counted, never marked" in verifyFiles.int.test.ts finds the
 *   row pruned and a second row for the same chapter after the re-fetch.
 *
 * ⚠️ THE WHOLE-BATCH RULE, PER ROOT (lib/chapterCleanup.ts, the unmounted stop). A NAS share that is not
 *   mounted right now leaves an empty, readable mount point behind, and the image itself ships /library
 *   and /library-dl as empty directories, so "every file is missing" is what an absent volume looks like
 *   from in here -- and it is also what an empty disk looks like. The two cannot be told apart, so a root
 *   where NO checked row's file is present (or the root itself cannot be read) marks NOTHING and is
 *   reported in `unmounted` for the admin to decide. Only a present FILE is proof of a mount: a folder is
 *   not, because the downloader mkdir -p's the series folder before every write and a sweep that ran while
 *   the share was down leaves exactly such empty folders in the bare mount point. Reintroduce by counting a
 *   present folder as proof (`l.present || l.folder`): "an empty folder a sweep left on a bare mount point
 *   is not proof the volume is there" finds 30 rows marked.
 *
 * ⚠️ THE 90 % RULE, PER ROOT. A root where more than nine rows in ten have no file is refused as well and
 *   reported the same way, with the percentage in the entry. One stray file on an otherwise bare mount --
 *   a download that landed in the overlay while the share was down -- would otherwise be the one present
 *   file that turns "unmounted" into "mark the other 29,999" (plus a page-hash re-decode of the lot when
 *   they come back). A root that far gone is the admin's decision, not the task's. Reintroduce by dropping
 *   the threshold: "a root with almost every file missing is refused, with the share of it in the reason"
 *   finds the rows marked.
 *
 * ⚠️ NEVER AT BOOT, NEVER ON A SCHEDULE. The one caller is the admin's Tasks panel (POST
 *   /api/admin/tasks/verify/run in routes/admin.ts). A boot-time walk with the volume not yet mounted
 *   would meet exactly the case above on every start, and the first draft of this feature (PR #53) did
 *   precisely that, with a hard DELETE. "verify never runs at boot" in verifyFiles.int.test.ts pins it.
 *
 * It is DETACHED from its route, like the sweep and the cleanup: one stat per row over a network share is
 * minutes on a large library, and a request that long dies at the reverse proxy while the walk keeps
 * marking rows -- the page would toast "Failed" over a run that finished fine. The route answers `started`,
 * the Tasks panel polls `running`, and the result is kept in `verifyState` for this process and in
 * server_settings.verify_last_run / verify_last_result for the next one, so a restart does not turn the
 * last run into "not run yet".
 */
import { stat } from 'fs/promises';
import { dirname } from 'path';
import { q } from './db';
import { DL_ROOT } from './library';
import { containedPath } from './fsGuard';
import { tombstoneBooks } from './chapterCleanup';
import { runtime } from './runtime';

export interface VerifyResult {
  ok: true;
  /** Rows whose file was looked for -- every un-pruned row under a root that was not skipped, both roots. */
  checked: number;
  /** Download-root rows marked pruned with reason 'missing' this run. */
  missing: number;
  /**
   * Read-library rows whose file is gone. Reported and NEVER marked (the header says why): those files are
   * the engine's or the admin's to put back, and a re-fetch could not land on the same row anyway.
   */
  readLibraryMissing: number;
  /**
   * Roots skipped by the whole-batch rule. A bare path means no file at all was found under it (or it could
   * not be read); a path followed by `(N % of M chapter files missing)` is the 90 % rule. Nothing under a
   * listed root was marked.
   */
  unmounted: string[];
  /** Roots that were checked and acted on; for the panel and the audit line. */
  roots: number;
  ms: number;
  /** A run that stopped between batches for a shutdown; what it had marked stays marked (it was true). */
  stopped?: 'shutdown';
}

export interface VerifyState {
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  lastResult: VerifyResult | null;
}

export const verifyState: VerifyState = { running: false, startedAt: null, finishedAt: null, lastResult: null };

/** How many stats are in flight at once: a NAS answers a handful in parallel well and thousands badly. */
const CONCURRENCY = 16;
/** Rows read per query per root; the ids are what is held in memory, not the files. */
const PAGE = 2000;
/** More than this share of a root's rows missing is refused, not marked (the header's 90 % rule). */
const REFUSE_ABOVE = 0.9;

interface Row { id: string; series_id: string; file: string }
interface Looked { row: Row; present: boolean; folder: boolean }

async function look(root: string, row: Row): Promise<Looked | null> {
  const abs = containedPath(root, row.file);
  // A path that escapes its root is not a missing chapter; it is something for the health page. Left out
  // of `checked` as well, so the count means what it says.
  if (!abs) return null;
  const st = await stat(abs).catch(() => null);
  if (st) return { row, present: true, folder: true };
  const folder = !!(await stat(dirname(abs)).catch(() => null));
  return { row, present: false, folder };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

/** One pass over every root that has un-pruned rows. Exported for the tests; the route goes through runVerify. */
export async function verifyChapterFiles(): Promise<VerifyResult> {
  const t0 = Date.now();
  const unmounted: string[] = [];
  const affected = new Set<string>();
  let checked = 0;
  let missing = 0;
  let readLibraryMissing = 0;
  let roots = 0;
  let stopped: VerifyResult['stopped'];

  const rootRows = await q<{ root: string }>(
    'SELECT DISTINCT root FROM lib_books WHERE root IS NOT NULL AND pruned_at IS NULL ORDER BY root',
  );
  outer: for (const { root } of rootRows) {
    if (runtime.stopping) { stopped = 'shutdown'; break; }
    // The root itself first. An unreadable root is the unmounted case before a single row is looked at,
    // and reading every row of a 40,000-chapter library to conclude that is not worth the disk time.
    if (!(await stat(root).catch(() => null))) { unmounted.push(root); continue; }

    // Everything under this root is looked at BEFORE anything is marked: the whole-batch rule needs the
    // whole batch. Paged reads keep the query bounded; the ids of what is missing are what stays in memory.
    const gone: Looked[] = [];
    let seen = 0;
    let anyPresent = false;
    let after = '';
    for (;;) {
      if (runtime.stopping) { stopped = 'shutdown'; break outer; }
      const page = await q<Row>(
        `SELECT id, series_id, file FROM lib_books
          WHERE root = $1 AND pruned_at IS NULL AND id > $2
          ORDER BY id LIMIT $3`,
        [root, after, PAGE],
      );
      if (!page.length) break;
      after = page[page.length - 1].id;
      const looked = (await mapLimit(page, CONCURRENCY, (r) => look(root, r))).filter((x): x is Looked => !!x);
      seen += looked.length;
      for (const l of looked) {
        // ⚠️ A present FILE, never a folder: the downloader leaves empty series folders on a bare mount
        // point (the header). `folder` is kept on the row for the log line only.
        if (l.present) anyPresent = true;
        else gone.push(l);
      }
    }
    if (!seen) continue;
    // ⚠️ The whole-batch decision (see the header): no file present is a volume that is not there, or a
    // disk with nothing on it, and neither is evidence about any single chapter.
    if (!anyPresent) { unmounted.push(root); continue; }
    // ⚠️ The 90 % rule: one stray present file must not turn "unmounted" into "mark everything else".
    if (gone.length > seen * REFUSE_ABOVE) {
      unmounted.push(`${root} (${Math.round((100 * gone.length) / seen)} % of ${seen} chapter files missing)`);
      continue;
    }
    roots++;
    checked += seen;
    if (root !== DL_ROOT) {
      // ⚠️ The read library is counted, never marked (the header): a re-fetch could not land on these rows.
      readLibraryMissing += gone.length;
      continue;
    }
    const ids = gone.map((l) => l.row.id);
    for (let i = 0; i < ids.length; i += 500) await tombstoneBooks(ids.slice(i, i + 500), 'missing');
    missing += ids.length;
    for (const l of gone) affected.add(l.row.series_id);
  }

  // The cover follows the lowest LIVE chapter, the way persistScan, mergeSeries and the chapter delete
  // pick it: every thumbnail falls back to the cover chapter's first page, and a tombstone has none.
  for (const sid of affected) {
    await q(
      `UPDATE lib_series SET cover_book_id = (
         SELECT id FROM lib_books WHERE series_id = $1 ORDER BY (pruned_at IS NOT NULL), number ASC, file ASC LIMIT 1
       ) WHERE id = $1`, [sid]).catch(() => {});
  }

  return { ok: true, checked, missing, readLibraryMissing, unmounted, roots, ms: Date.now() - t0, ...(stopped ? { stopped } : {}) };
}

type Log = { info: (m: string) => void; warn: (m: string) => void; error?: (e: any) => void };

/**
 * Run it the way the Tasks panel runs it: one at a time, result kept and persisted, outcome logged.
 *
 * Same contract as runChapterCleanup and runSweep -- `false` when a run is already in flight, otherwise the
 * promise -- so a second click while the first walk is still on the NAS is a refusal the panel can show
 * ("Already running"), not a second walk racing the first over the same rows. The route does NOT await the
 * promise (the header says why); it is what the tests and the audit line hang off.
 */
export function runVerify(log?: Log): Promise<VerifyResult> | false {
  if (verifyState.running) return false;
  verifyState.running = true;
  verifyState.startedAt = Date.now();
  return (async () => {
    try {
      const r = await verifyChapterFiles();
      verifyState.finishedAt = Date.now();
      verifyState.lastResult = r;
      // Persisted the way the cleanup persists its run: the Tasks panel promises to keep the last run, and
      // a process restart -- the very next thing after a restore, often enough -- must not turn it back
      // into "not run yet". Reintroduce by dropping this UPDATE: "the last result survives a restart" in
      // verifyFiles.int.test.ts finds the row empty.
      await q(
        'UPDATE server_settings SET verify_last_run = now(), verify_last_result = $1::jsonb WHERE id = 1',
        [JSON.stringify(r)],
      ).catch(() => {});
      log?.info(`verify: ${r.checked} chapter file(s) checked, ${r.missing} missing and marked for the next sweep`
        + (r.readLibraryMissing ? `, ${r.readLibraryMissing} missing in the read library (not marked: not ours to fetch)` : '')
        + (r.stopped ? ' (stopped for shutdown)' : ''));
      for (const root of r.unmounted) {
        log?.warn(`verify: ${root}: no file (or almost none) behind its chapter rows -- is the volume mounted? Nothing under it was marked`);
      }
      return r;
    } catch (e) {
      // Never leave an older healthy result standing after a run that threw: "312 missing, marked" about a
      // walk that died halfway is worse than no line at all -- in memory AND in the row a restart reads.
      verifyState.finishedAt = Date.now();
      verifyState.lastResult = null;
      await q('UPDATE server_settings SET verify_last_run = now(), verify_last_result = NULL WHERE id = 1').catch(() => {});
      log?.error?.(e);
      throw e;
    } finally {
      verifyState.running = false;
    }
  })();
}
