import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import { q } from './db';
import { DL_ROOT } from './library';
import { deleteChapterFiles } from './libraryAdmin';
import { busyFolders } from './bulkNewest';
import { runsInside } from './updater';
import { logAudit } from './audit';
import { runtime } from './runtime';

export type BulkDeleteStatus = 'running' | 'done' | 'cancelled' | 'failed' | 'interrupted';
export type BulkDeleteSkip = 'not_found' | 'hidden' | 'merged' | 'busy' | 'nothing_to_delete' | 'refused' | 'cancelled';
export type BulkDeleteResult = {
  id: string;
  title?: string;
  outcome: 'applied' | 'skipped' | 'failed';
  reason?: BulkDeleteSkip | 'failed';
  message?: string;
  chapters: number;
  bytes: number;
  kept: number;
  paused: boolean;
  /** Counts for every stable reason returned by the shared chapter deletion guard. */
  chapterSkips: Record<string, number>;
};
export type BulkDeleteSummary = {
  applied: number;
  chapters: number;
  bytes: number;
  kept: number;
  paused: number;
  skipped: number;
  failed: number;
  chapterSkips: Record<string, number>;
};
export type BulkDeleteRun = {
  id: string;
  status: BulkDeleteStatus;
  startedAt: string;
  finishedAt: string | null;
  cancelRequested: boolean;
  pause: boolean;
  total: number;
  done: number;
  summary: BulkDeleteSummary;
  results: BulkDeleteResult[];
  error: string | null;
};

type Row = {
  id: string;
  started_at: Date | string;
  finished_at: Date | string | null;
  status: BulkDeleteStatus;
  cancel_requested: boolean;
  pause: boolean;
  total: number;
  done: number;
  summary: BulkDeleteSummary;
  results: BulkDeleteResult[];
  error: string | null;
};

const EMPTY_SUMMARY = (): BulkDeleteSummary => ({
  applied: 0, chapters: 0, bytes: 0, kept: 0, paused: 0, skipped: 0, failed: 0, chapterSkips: {},
});
const WORKER_ID = randomUUID();
let initialised: Promise<void> | null = null;

type TestHooks = {
  afterClaim?: (series: { id: string; title: string; folder: string }) => Promise<void> | void;
  afterPause?: (series: { id: string; title: string; folder: string }) => Promise<void> | void;
  afterSettled?: (result: BulkDeleteResult, done: number) => Promise<void> | void;
};
let testHooks: TestHooks = {};

/** Test-only scheduling gates. Production never sets these. */
export function setBulkChapterDeleteTestHooks(hooks: TestHooks): void { testHooks = hooks; }

const iso = (v: Date | string | null): string | null => v == null ? null : new Date(v).toISOString();
const toRun = (r: Row): BulkDeleteRun => ({
  id: r.id,
  status: r.status,
  startedAt: iso(r.started_at)!,
  finishedAt: iso(r.finished_at),
  cancelRequested: !!r.cancel_requested,
  pause: !!r.pause,
  total: Number(r.total),
  done: Number(r.done),
  summary: r.summary ?? EMPTY_SUMMARY(),
  results: r.results ?? [],
  error: r.error,
});

/**
 * A row still owned by another process cannot still have a worker after this process has booted. Closing it rather
 * than resuming is deliberate: file deletion and its tombstone are already atomic per chapter, while blindly
 * replaying an unknown in-flight unlink could make a destructive request surprising. The recorded partial result is
 * retained, and the admin may explicitly start another run for the remainder.
 */
export async function closeInterruptedBulkChapterDeleteRuns(): Promise<number> {
  const rows = await q<{ id: string }>(
    `UPDATE admin_bulk_delete_runs
        SET status = 'interrupted', finished_at = COALESCE(finished_at, now()), heartbeat_at = now(),
            error = COALESCE(error, 'The server stopped before this run finished.')
      WHERE status = 'running' AND worker_id <> $1::uuid
      RETURNING id`, [WORKER_ID],
  );
  return rows.length;
}

/** Called while the admin plugin registers, after migrate() has made the table. */
export async function initialiseBulkChapterDeleteRuns(): Promise<void> {
  if (!initialised) initialised = closeInterruptedBulkChapterDeleteRuns().then(() => undefined);
  await initialised;
}

export async function readBulkChapterDeleteRun(id?: string): Promise<BulkDeleteRun | null> {
  const rows = await q<Row>(
    `SELECT id, started_at, finished_at, status, cancel_requested, pause, total, done, summary, results, error
       FROM admin_bulk_delete_runs
      WHERE ($1::text IS NULL OR id::text = $1)
      ORDER BY started_at DESC LIMIT 1`, [id ?? null],
  );
  return rows[0] ? toRun(rows[0]) : null;
}

export async function requestBulkChapterDeleteCancel(id?: string): Promise<string | null> {
  const rows = await q<{ id: string }>(
    `UPDATE admin_bulk_delete_runs SET cancel_requested = true, heartbeat_at = now()
      WHERE status = 'running' AND ($1::text IS NULL OR id::text = $1)
      RETURNING id`, [id ?? null],
  );
  return rows[0]?.id ?? null;
}

type StartInput = {
  ids: string[];
  pause: boolean;
  userId: string | null;
  req?: FastifyRequest;
  /** Includes source download cards as well as the shared bulk writer set. */
  busy: (folder: string) => boolean;
};

const errorText = (e: unknown) => ((e as Error)?.message || String(e)).slice(0, 500);
const conflict = (e: unknown) => (e as { code?: string })?.code === '23505';

/** Atomically records one run and detaches its worker. A database partial unique index is the final one-active guard. */
export async function startBulkChapterDelete(input: StartInput): Promise<{ id: string; total: number } | null> {
  const id = randomUUID();
  try {
    await q(
      `INSERT INTO admin_bulk_delete_runs (id, worker_id, started_by, pause, series_ids, total, summary, results)
       VALUES ($1::uuid, $2::uuid, (SELECT id FROM users WHERE id::text = $3), $4, $5, $6, $7::jsonb, '[]'::jsonb)`,
      [id, WORKER_ID, input.userId ?? '', input.pause, input.ids, input.ids.length, JSON.stringify(EMPTY_SUMMARY())],
    );
  } catch (e) {
    if (conflict(e)) return null;
    throw e;
  }
  setImmediate(() => { void run(id, input); });
  return { id, total: input.ids.length };
}

const chapterSkipCounts = (into: Record<string, number>, rows: Record<string, number>) => {
  for (const [reason, count] of Object.entries(rows)) into[reason] = (into[reason] ?? 0) + count;
};
const countedChapterSkips = (rows: Array<{ reason: string }>): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.reason] = (counts[row.reason] ?? 0) + 1;
  return counts;
};

async function cancelled(id: string): Promise<boolean> {
  const rows = await q<{ cancel_requested: boolean }>(
    'SELECT cancel_requested FROM admin_bulk_delete_runs WHERE id = $1 AND status = \'running\'', [id],
  );
  return !!rows[0]?.cancel_requested;
}

async function persistProgress(id: string, done: number, summary: BulkDeleteSummary, results: BulkDeleteResult[]): Promise<void> {
  await q(
    `UPDATE admin_bulk_delete_runs
        SET done = $2, summary = $3::jsonb, results = $4::jsonb, heartbeat_at = now()
      WHERE id = $1 AND status = 'running'`,
    [id, done, JSON.stringify(summary), JSON.stringify(results)],
  );
}

async function finish(
  id: string, status: Exclude<BulkDeleteStatus, 'running'>, done: number,
  summary: BulkDeleteSummary, results: BulkDeleteResult[], error: string | null = null,
): Promise<void> {
  await q(
    `UPDATE admin_bulk_delete_runs
        SET status = $2, done = $3, summary = $4::jsonb, results = $5::jsonb, error = $6,
            finished_at = now(), heartbeat_at = now()
      WHERE id = $1 AND status = 'running'`,
    [id, status, done, JSON.stringify(summary), JSON.stringify(results), error],
  );
  // Keep a useful history without growing forever: at least the newest fifty and everything from the last 90 days.
  await q(
    `DELETE FROM admin_bulk_delete_runs
      WHERE started_at < now() - interval '90 days'
        AND id NOT IN (SELECT id FROM admin_bulk_delete_runs ORDER BY started_at DESC LIMIT 50)`,
  ).catch(() => {});
}

function skipped(id: string, reason: BulkDeleteSkip, title?: string, message?: string, kept = 0,
  chapterSkips: Record<string, number> = {}): BulkDeleteResult {
  return { id, ...(title ? { title } : {}), outcome: 'skipped', reason, ...(message ? { message } : {}), chapters: 0, bytes: 0, kept, paused: false, chapterSkips };
}

async function processSeries(runId: string, seriesId: string, input: StartInput): Promise<BulkDeleteResult> {
  // Re-read at execution time. A title may have been hidden, merged, renamed or moved while this detached run waited.
  const rows = await q<{
    id: string; title: string; folder: string; deleted_at: string | null; merged_into: string | null; cover_book_id: string | null;
  }>(
    `SELECT id, title, folder, deleted_at, merged_into, cover_book_id FROM lib_series WHERE id = $1`, [seriesId],
  );
  const series = rows[0];
  if (!series) return skipped(seriesId, 'not_found');
  if (series.deleted_at) return skipped(seriesId, 'hidden', series.title);
  if (series.merged_into) return skipped(seriesId, 'merged', series.title);

  // There must be no await between the shared checks and this claim. Every in-process writer observes the same set;
  // once this turn claims it, a download, repair, rescan or renumber cannot start in the gap before the book query.
  if (input.busy(series.folder) || runsInside(seriesId) > 0) return skipped(seriesId, 'busy', series.title);
  busyFolders.add(series.folder);
  try {
    await testHooks.afterClaim?.({ id: series.id, title: series.title, folder: series.folder });
    const live = await q<{ id: string; root: string | null }>(
      `SELECT id, root FROM lib_books WHERE series_id = $1 AND pruned_at IS NULL
        ORDER BY number ASC, file ASC`, [seriesId],
    );
    const owned = live.filter((r) => r.root === DL_ROOT);
    // A cover outside the download root is already safe. Otherwise preserve the selected cover, or the lowest owned
    // chapter when no selected cover is currently downloadable.
    const cover = owned.some((r) => r.id === series.cover_book_id) ? series.cover_book_id : owned[0]?.id ?? null;
    const todo = owned.map((r) => r.id).filter((bookId) => bookId !== cover);
    const baseKept = live.length - todo.length; // cover plus every hand-managed/non-download-root chapter
    if (!todo.length) return skipped(seriesId, 'nothing_to_delete', series.title, undefined, baseKept);

    const deleted = await deleteChapterFiles(seriesId, todo, { userId: input.userId, req: input.req });
    if ('refused' in deleted) {
      return skipped(seriesId, 'refused', series.title, deleted.refused.reason, baseKept + todo.length);
    }
    const kept = baseKept + deleted.skipped.length;
    let paused = false;
    // The pause and its audit happen while this worker still owns the folder. Otherwise a sweep can refetch the files
    // after unlinking and before auto_update becomes false.
    if (input.pause && deleted.applied > 0) {
      await q('UPDATE lib_series SET auto_update = false WHERE id = $1 AND auto_update', [seriesId]);
      await logAudit('series.settings', {
        userId: input.userId,
        detail: { id: seriesId, title: series.title, autoUpdate: false, via: 'bulk_delete', runId },
        req: input.req,
      });
      paused = true;
      await testHooks.afterPause?.({ id: series.id, title: series.title, folder: series.folder });
    }
    if (!deleted.applied) {
      return skipped(seriesId, 'nothing_to_delete', series.title, undefined, kept, countedChapterSkips(deleted.skipped));
    }
    return {
      id: seriesId, title: series.title, outcome: 'applied', chapters: deleted.applied, bytes: deleted.bytes,
      kept, paused, chapterSkips: countedChapterSkips(deleted.skipped),
    };
  } finally {
    busyFolders.delete(series.folder);
  }
}

async function run(id: string, input: StartInput): Promise<void> {
  const summary = EMPTY_SUMMARY();
  const results: BulkDeleteResult[] = [];
  let done = 0;
  try {
    for (let index = 0; index < input.ids.length; index++) {
      // Cancellation and shutdown are observed only between series. An unlink already in progress always reaches its
      // tombstone, optional pause and audit before the shared folder claim is released.
      if (runtime.stopping) {
        await finish(id, 'interrupted', done, summary, results, 'The server stopped before this run finished.');
        return;
      }
      if (await cancelled(id)) {
        for (const remaining of input.ids.slice(index)) {
          results.push(skipped(remaining, 'cancelled'));
          summary.skipped++;
        }
        done = input.ids.length;
        await finish(id, 'cancelled', done, summary, results);
        return;
      }

      let result: BulkDeleteResult;
      try {
        result = await processSeries(id, input.ids[index], input);
      } catch (e) {
        result = {
          id: input.ids[index], outcome: 'failed', reason: 'failed', message: errorText(e), chapters: 0, bytes: 0,
          kept: 0, paused: false, chapterSkips: {},
        };
      }
      results.push(result);
      done++;
      summary.kept += result.kept;
      chapterSkipCounts(summary.chapterSkips, result.chapterSkips);
      if (result.outcome === 'applied') {
        summary.applied++;
        summary.chapters += result.chapters;
        summary.bytes += result.bytes;
        if (result.paused) summary.paused++;
      } else if (result.outcome === 'failed') summary.failed++;
      else summary.skipped++;
      await persistProgress(id, done, summary, results);
      await testHooks.afterSettled?.(result, done);
    }
    await finish(id, 'done', done, summary, results);
  } catch (e) {
    await finish(id, 'failed', done, summary, results, errorText(e)).catch(() => {});
  }
}
