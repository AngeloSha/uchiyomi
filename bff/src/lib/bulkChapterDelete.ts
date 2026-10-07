import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import { rm, stat } from 'fs/promises';
import { dirname } from 'path';
import { q, tx } from './db';
import { DL_ROOT } from './library';
import { deleteChapterFiles, type ChapterDeleteJournalItem } from './libraryAdmin';
import { busyFolders } from './bulkNewest';
import { runsInside } from './updater';
import { logAudit } from './audit';
import { runtime } from './runtime';
import { realContainedPath } from './fsGuard';
import { tombstoneBooks } from './chapterCleanup';
import { REFETCH_BAK } from './fsAtomic';

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
export type BulkDeleteCurrent = {
  id: string;
  title: string;
  total: number;
  processed: number;
  chapters: number;
  bytes: number;
  kept: number;
  paused: boolean;
  chapterSkips: Record<string, number>;
};
type StoredCurrent = BulkDeleteCurrent & { baseKept: number };
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
  current: BulkDeleteCurrent | null;
  error: string | null;
};

type Row = {
  id: string;
  started_by: string | null;
  started_at: Date | string;
  finished_at: Date | string | null;
  status: BulkDeleteStatus;
  cancel_requested: boolean;
  pause: boolean;
  total: number;
  done: number;
  summary: BulkDeleteSummary;
  results: BulkDeleteResult[];
  current: StoredCurrent | null;
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
  /** Returning simulate_crash models process death after unlink and before the tombstone. */
  afterUnlink?: (item: ChapterDeleteJournalItem & { seriesId: string; runId: string }) => Promise<'simulate_crash' | void> | 'simulate_crash' | void;
  /** Throws in tests to model reconciliation itself becoming unavailable after the worker failed. */
  beforeRecovery?: (series: { id: string; title: string; folder: string; runId: string }) => Promise<void> | void;
  afterSettled?: (result: BulkDeleteResult, done: number) => Promise<void> | void;
};
let testHooks: TestHooks = {};

/** Test-only scheduling gates. Production never sets these. */
export function setBulkChapterDeleteTestHooks(hooks: TestHooks): void { testHooks = hooks; }

const iso = (v: Date | string | null): string | null => v == null ? null : new Date(v).toISOString();
const publicCurrent = (v: StoredCurrent | null): BulkDeleteCurrent | null => {
  if (!v) return null;
  const { baseKept: _baseKept, ...current } = v;
  return current;
};
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
  current: publicCurrent(r.current),
  error: r.error,
});

type JournalRow = {
  run_id: string;
  series_id: string;
  book_id: string;
  root: string;
  file: string;
  position: number;
  state: 'intent' | 'applied' | 'skipped' | 'unresolved';
  bytes: number;
  reason: string | null;
};

async function settleJournal(
  runId: string, bookId: string, state: Exclude<JournalRow['state'], 'intent'>, reason: string | null,
): Promise<void> {
  await q(
    `UPDATE admin_bulk_delete_items
        SET state = $3, reason = $4, updated_at = now()
      WHERE run_id = $1 AND book_id = $2`,
    [runId, bookId, state, reason],
  );
}

/** Resolve one committed intent without ever deleting a file during recovery. */
async function reconcileIntent(row: JournalRow): Promise<void> {
  const books = await q<{
    series_id: string; root: string | null; file: string; pruned_at: Date | string | null; pruned_reason: string | null;
  }>('SELECT series_id, root, file, pruned_at, pruned_reason FROM lib_books WHERE id = $1', [row.book_id]);
  const book = books[0];
  if (!book) return settleJournal(row.run_id, row.book_id, 'skipped', 'interrupted_row_missing');
  if (book.series_id !== row.series_id || book.root !== row.root || book.file !== row.file) {
    return settleJournal(row.run_id, row.book_id, 'unresolved', 'interrupted_row_changed');
  }
  if (book.pruned_at) {
    if (book.pruned_reason !== 'deleted') {
      return settleJournal(row.run_id, row.book_id, 'unresolved', 'interrupted_reason_changed');
    }
    // Idempotently completes the derived-cache half if the old process died between tombstoneBooks' statements.
    await tombstoneBooks([row.book_id], 'deleted');
    return settleJournal(row.run_id, row.book_id, 'applied', null);
  }
  if (row.root !== DL_ROOT) return settleJournal(row.run_id, row.book_id, 'unresolved', 'not_owned');
  const abs = await realContainedPath(row.root, row.file);
  if (!abs) return settleJournal(row.run_id, row.book_id, 'unresolved', 'outside_root');
  if (await stat(abs).catch(() => null)) {
    // The intent committed but unlink never completed. Recovery never retries destructive filesystem work.
    return settleJournal(row.run_id, row.book_id, 'skipped', 'interrupted_before_unlink');
  }
  if (!(await stat(dirname(abs)).catch(() => null))) {
    // An unavailable mount is not proof of deletion. Keep the live row and make the uncertainty explicit.
    return settleJournal(row.run_id, row.book_id, 'unresolved', 'interrupted_volume_unavailable');
  }
  // The ordinary delete removes this set-aside copy before tombstoning. A process can die in that tiny gap; leaving
  // it here would let the stale-temp reaper resurrect the deleted bytes behind the recovered tombstone.
  await rm(`${abs}${REFETCH_BAK}`, { force: true }).catch(() => {});
  await tombstoneBooks([row.book_id], 'deleted');
  await settleJournal(row.run_id, row.book_id, 'applied', null);
}

const addResult = (summary: BulkDeleteSummary, result: BulkDeleteResult): void => {
  summary.kept += result.kept;
  chapterSkipCounts(summary.chapterSkips, result.chapterSkips);
  if (result.outcome === 'applied') {
    summary.applied++;
    summary.chapters += result.chapters;
    summary.bytes += result.bytes;
    if (result.paused) summary.paused++;
  } else if (result.outcome === 'failed') summary.failed++;
  else summary.skipped++;
};

async function interruptedResult(runId: string, current: StoredCurrent): Promise<BulkDeleteResult> {
  const rows = await q<JournalRow>(
    `SELECT run_id, series_id, book_id, root, file, position, state, bytes, reason
       FROM admin_bulk_delete_items WHERE run_id = $1 AND series_id = $2 ORDER BY position`,
    [runId, current.id],
  );
  for (const row of rows) if (row.state === 'intent') await reconcileIntent(row);
  const settled = await q<JournalRow>(
    `SELECT run_id, series_id, book_id, root, file, position, state, bytes, reason
       FROM admin_bulk_delete_items WHERE run_id = $1 AND series_id = $2 ORDER BY position`,
    [runId, current.id],
  );
  const applied = settled.filter((r) => r.state === 'applied');
  const notApplied = settled.filter((r) => r.state !== 'applied');
  const chapterSkips: Record<string, number> = {};
  for (const row of notApplied) {
    const reason = row.reason ?? 'interrupted_unresolved';
    chapterSkips[reason] = (chapterSkips[reason] ?? 0) + 1;
  }
  // Chapters the old worker had not reached have no journal row and are known to remain untouched.
  const untouched = Math.max(0, current.total - settled.length);
  const chapters = applied.length;
  return {
    id: current.id,
    title: current.title,
    outcome: chapters ? 'applied' : 'failed',
    ...(chapters ? {} : { reason: 'failed' as const }),
    message: 'The server stopped during this series. Completed chapter deletions were recovered; untouched chapters were kept.',
    chapters,
    bytes: applied.reduce((sum, row) => sum + Number(row.bytes), 0),
    kept: current.baseKept + notApplied.length + untouched,
    paused: current.paused,
    chapterSkips,
  };
}

async function recoveryAuditOnce(
  event: string, userId: string | null, runId: string, seriesId: string, detail: Record<string, unknown>,
): Promise<void> {
  await q(
    `INSERT INTO audit_log (user_id, event, detail)
     SELECT $1::uuid, $2, $3::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM audit_log
         WHERE event = $2 AND detail->>'runId' = $4 AND detail->>'id' = $5
      )`,
    [userId, event, JSON.stringify(detail), runId, seriesId],
  );
}

/** Complete every durable side effect that normally follows the chapter loop; safe to repeat after another crash. */
async function finalizeRecoveredSeries(
  runId: string, result: BulkDeleteResult, pauseRequested: boolean, userId: string | null,
): Promise<void> {
  if (!result.chapters) return;
  const applied = await q<{ book_id: string }>(
    `SELECT book_id FROM admin_bulk_delete_items
      WHERE run_id = $1 AND series_id = $2 AND state = 'applied' ORDER BY position`,
    [runId, result.id],
  );
  await q(
    `UPDATE lib_series SET cover_book_id = (
       SELECT id FROM lib_books WHERE series_id = $1
        ORDER BY (pruned_at IS NOT NULL), number ASC, file ASC LIMIT 1
     ) WHERE id = $1`, [result.id],
  );
  await recoveryAuditOnce('series.chapters_delete', userId, runId, result.id, {
    id: result.id,
    title: result.title ?? null,
    bookIds: applied.map((row) => row.book_id),
    applied: result.chapters,
    bytes: result.bytes,
    via: 'bulk_recovery',
    runId,
  });
  if (pauseRequested) {
    await q('UPDATE lib_series SET auto_update = false WHERE id = $1 AND auto_update', [result.id]);
    result.paused = true;
    await recoveryAuditOnce('series.settings', userId, runId, result.id, {
      id: result.id,
      title: result.title ?? null,
      autoUpdate: false,
      via: 'bulk_delete_recovery',
      runId,
    });
  }
}

/**
 * A row owned by the previous process has no worker after boot. Before closing it, reconcile every durable unlink
 * intent: an absent file in a still-mounted owned folder gets its tombstone, while a present/unsafe/unavailable path
 * stays live. The partially processed series becomes a persisted terminal result; later selections remain untouched.
 */
export async function closeInterruptedBulkChapterDeleteRuns(): Promise<number> {
  // The run-row locks are held through filesystem inspection, tombstoning, pause and audit. SKIP LOCKED means two
  // BFFs booting together cannot both reconcile one destructive run. If this process dies, the transaction releases
  // the lock while idempotent journal/audit side effects remain, and the next boot safely tries the still-running row.
  return tx(async (qq) => {
    const stale = await qq<Row>(
      `SELECT id, started_by, started_at, finished_at, status, cancel_requested, pause, total, done,
              summary, results, current, error
         FROM admin_bulk_delete_runs
        WHERE status = 'running' AND worker_id <> $1::uuid
        ORDER BY started_at FOR UPDATE SKIP LOCKED`,
      [WORKER_ID],
    );
    let closed = 0;
    for (const row of stale) {
      const summary: BulkDeleteSummary = {
        ...(row.summary ?? EMPTY_SUMMARY()),
        chapterSkips: { ...(row.summary?.chapterSkips ?? {}) },
      };
      const results = [...(row.results ?? [])];
      let done = Number(row.done);
      if (row.current && !results.some((r) => r.id === row.current!.id)) {
        const result = await interruptedResult(row.id, row.current);
        await finalizeRecoveredSeries(row.id, result, !!row.pause, row.started_by);
        results.push(result);
        addResult(summary, result);
        done = Math.min(Number(row.total), done + 1);
      }
      const changed = await qq<{ id: string }>(
        `UPDATE admin_bulk_delete_runs
            SET status = 'interrupted', done = $2, summary = $3::jsonb, results = $4::jsonb, current = NULL,
                finished_at = COALESCE(finished_at, now()), heartbeat_at = now(),
                error = COALESCE(error, 'The server stopped before this run finished.')
          WHERE id = $1 AND status = 'running'
          RETURNING id`,
        [row.id, done, JSON.stringify(summary), JSON.stringify(results)],
      );
      closed += changed.length;
    }
    return closed;
  });
}

/** Called while the admin plugin registers, after migrate() has made the table. */
export async function initialiseBulkChapterDeleteRuns(): Promise<void> {
  if (!initialised) initialised = closeInterruptedBulkChapterDeleteRuns().then(() => undefined);
  await initialised;
}

export async function readBulkChapterDeleteRun(id?: string): Promise<BulkDeleteRun | null> {
  const rows = await q<Row>(
    `SELECT id, started_by, started_at, finished_at, status, cancel_requested, pause, total, done, summary, results, current, error
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
class SimulatedWorkerExit extends Error {}
class RecoveryDeferred extends Error {}

/** Keep the durable snapshot active: only startup recovery may clear it after reconciliation succeeds. */
async function deferRecovery(runId: string, workerError: unknown, recoveryError: unknown): Promise<never> {
  const message = `${errorText(workerError)}; recovery deferred: ${errorText(recoveryError)}`.slice(0, 500);
  await q(
    `UPDATE admin_bulk_delete_runs SET error = $2, heartbeat_at = now()
      WHERE id = $1 AND status = 'running' AND current IS NOT NULL`,
    [runId, message],
  ).catch(() => {});
  throw new RecoveryDeferred(message);
}

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
        SET done = $2, summary = $3::jsonb, results = $4::jsonb, current = NULL, heartbeat_at = now()
      WHERE id = $1 AND status = 'running'`,
    [id, done, JSON.stringify(summary), JSON.stringify(results)],
  );
}

async function persistCurrent(id: string, current: StoredCurrent): Promise<void> {
  const rows = await q<{ id: string }>(
    `UPDATE admin_bulk_delete_runs SET current = $2::jsonb, heartbeat_at = now()
      WHERE id = $1 AND status = 'running' RETURNING id`,
    [id, JSON.stringify(current)],
  );
  if (!rows.length) throw new Error('bulk delete run is no longer active');
}

async function journalIntent(runId: string, seriesId: string, item: ChapterDeleteJournalItem): Promise<void> {
  await tx(async (qq) => {
    await qq(
      `INSERT INTO admin_bulk_delete_items
         (run_id, series_id, book_id, root, file, position, state, bytes)
       VALUES ($1,$2,$3,$4,$5,$6,'intent',$7)
       ON CONFLICT (run_id, book_id) DO UPDATE
         SET root = EXCLUDED.root, file = EXCLUDED.file, position = EXCLUDED.position,
             state = 'intent', bytes = EXCLUDED.bytes, reason = NULL, updated_at = now()`,
      [runId, seriesId, item.id, item.root, item.file, item.position, item.bytes],
    );
    await qq('UPDATE admin_bulk_delete_runs SET heartbeat_at = now() WHERE id = $1 AND status = \'running\'', [runId]);
  });
}

async function journalSettled(
  runId: string, seriesId: string, current: StoredCurrent,
  item: ChapterDeleteJournalItem & { outcome: 'applied' | 'skipped'; reason?: string },
): Promise<StoredCurrent> {
  const next: StoredCurrent = {
    ...current,
    processed: current.processed + 1,
    chapters: current.chapters + (item.outcome === 'applied' ? 1 : 0),
    bytes: current.bytes + (item.outcome === 'applied' ? item.bytes : 0),
    kept: current.kept + (item.outcome === 'skipped' ? 1 : 0),
    chapterSkips: { ...current.chapterSkips },
  };
  if (item.outcome === 'skipped') {
    const reason = item.reason ?? 'unknown';
    next.chapterSkips[reason] = (next.chapterSkips[reason] ?? 0) + 1;
  }
  await tx(async (qq) => {
    await qq(
      `INSERT INTO admin_bulk_delete_items
         (run_id, series_id, book_id, root, file, position, state, bytes, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (run_id, book_id) DO UPDATE
         SET root = EXCLUDED.root, file = EXCLUDED.file, position = EXCLUDED.position,
             state = EXCLUDED.state, bytes = EXCLUDED.bytes, reason = EXCLUDED.reason, updated_at = now()`,
      [runId, seriesId, item.id, item.root, item.file, item.position, item.outcome, item.bytes, item.reason ?? null],
    );
    const changed = await qq<{ id: string }>(
      `UPDATE admin_bulk_delete_runs SET current = $2::jsonb, heartbeat_at = now()
        WHERE id = $1 AND status = 'running' RETURNING id`,
      [runId, JSON.stringify(next)],
    );
    if (!changed.length) throw new Error('bulk delete run is no longer active');
  });
  return next;
}

async function finish(
  id: string, status: Exclude<BulkDeleteStatus, 'running'>, done: number,
  summary: BulkDeleteSummary, results: BulkDeleteResult[], error: string | null = null,
): Promise<void> {
  await q(
    `UPDATE admin_bulk_delete_runs
        SET status = $2, done = $3, summary = $4::jsonb, results = $5::jsonb, error = $6,
            current = NULL, finished_at = now(), heartbeat_at = now()
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
  // Autofix holds this while it scans/merges/deletes. It also takes the folder lock for each destructive step, which
  // closes the reverse ordering (a bulk run that claimed first); this check closes Autofix-first before our Set write.
  if (runtime.repairing || input.busy(series.folder) || runsInside(seriesId) > 0) return skipped(seriesId, 'busy', series.title);
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

    let current: StoredCurrent = {
      id: seriesId, title: series.title, total: todo.length, processed: 0, chapters: 0, bytes: 0,
      kept: baseKept, baseKept, paused: false, chapterSkips: {},
    };
    // Persist the series snapshot before deleteChapterFiles can reach any filesystem operation. Each callback below
    // then atomically advances its chapter journal and this progress snapshot.
    await persistCurrent(runId, current);
    const deleted = await deleteChapterFiles(seriesId, todo, {
      userId: input.userId,
      req: input.req,
      runId,
      journal: {
        beforeUnlink: (item) => journalIntent(runId, seriesId, item),
        afterUnlink: async (item) => {
          if ((await testHooks.afterUnlink?.({ ...item, seriesId, runId })) === 'simulate_crash') {
            throw new SimulatedWorkerExit('simulated process exit after unlink');
          }
        },
        settled: async (item) => { current = await journalSettled(runId, seriesId, current, item); },
      },
    });
    if ('refused' in deleted) {
      return skipped(seriesId, 'refused', series.title, deleted.refused.reason, baseKept + todo.length);
    }
    const kept = baseKept + deleted.skipped.length;
    let paused = false;
    // The pause and its audit happen while this worker still owns the folder. Otherwise a sweep can refetch the files
    // after unlinking and before auto_update becomes false.
    if (input.pause && deleted.applied > 0) {
      current = { ...current, paused: true };
      await tx(async (qq) => {
        await qq('UPDATE lib_series SET auto_update = false WHERE id = $1 AND auto_update', [seriesId]);
        await qq(
          'UPDATE admin_bulk_delete_runs SET current = $2::jsonb, heartbeat_at = now() WHERE id = $1 AND status = \'running\'',
          [runId, JSON.stringify(current)],
        );
      });
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
  } catch (e) {
    // Test-only exact crash point: a dead process drops its in-memory lock and leaves the durable intent for startup
    // recovery. Every live failure is instead reconciled before this finally releases the shared folder claim, so a
    // download/update cannot enter between unlink and the recovered tombstone, cover, pause or audit side effects.
    if (e instanceof SimulatedWorkerExit) throw e;
    let rows: Array<{ current: StoredCurrent | null }>;
    try {
      rows = await q<{ current: StoredCurrent | null }>(
        'SELECT current FROM admin_bulk_delete_runs WHERE id = $1 AND status = \'running\'', [runId],
      );
    } catch (recoveryError) {
      return await deferRecovery(runId, e, recoveryError);
    }
    if (rows[0]?.current) {
      try {
        await testHooks.beforeRecovery?.({ id: series.id, title: series.title, folder: series.folder, runId });
        const result = await interruptedResult(runId, rows[0].current);
        await finalizeRecoveredSeries(runId, result, input.pause, input.userId);
        result.message = `${result.message} Worker error: ${errorText(e)}`;
        return result;
      } catch (recoveryError) {
        return await deferRecovery(runId, e, recoveryError);
      }
    }
    return {
      id: seriesId, title: series.title, outcome: 'failed', reason: 'failed', message: errorText(e), chapters: 0,
      bytes: 0, kept: 0, paused: false, chapterSkips: {},
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
        // Leave the row and intent exactly as a dead process would. The next boot owns reconciliation. Every ordinary
        // worker failure after the folder claim is handled inside processSeries while that claim is still retained.
        if (e instanceof SimulatedWorkerExit || e instanceof RecoveryDeferred) return;
        result = {
          id: input.ids[index], outcome: 'failed', reason: 'failed', message: errorText(e), chapters: 0, bytes: 0,
          kept: 0, paused: false, chapterSkips: {},
        };
      }
      results.push(result);
      done++;
      addResult(summary, result);
      await persistProgress(id, done, summary, results);
      await testHooks.afterSettled?.(result, done);
    }
    await finish(id, 'done', done, summary, results);
  } catch (e) {
    await finish(id, 'failed', done, summary, results, errorText(e)).catch(() => {});
  }
}
