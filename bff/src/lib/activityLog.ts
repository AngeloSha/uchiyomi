/**
 * What the server finished downloading, written down so a restart does not forget it (v0.49.0).
 *
 * The download activity (lib/downloadActivity.ts) lives in memory, a day deep. Every release restarts the
 * server, so the morning after an update the Downloads view's "Came in today" was empty, and so was the
 * failed-chapter half of Needs attention -- exactly when someone looks to see whether last night went well.
 *
 * So each finished chapter is written to `download_log` AFTER the fact, never in the way of the download: the
 * insert is not awaited by the loop, and a failed one is logged and dropped (the feed in memory is still
 * right; only the next restart would miss that line). The feed is read back ONCE, at boot, into the same
 * in-memory list, so a poll every few seconds still costs no query. Rows are kept a week and pruned at most
 * once an hour; the feed only ever shows the last day.
 *
 * Nothing here runs unless `startActivityLog()` is called (server.ts, after the migration), so unit tests that
 * record downloads never need a database.
 */
import { q } from './db';
import {
  onDismissed, onFinished, onHealed, reasonSaidOf, restoreFinished, ACTIVITY_TTL_MS, FINISHED_CAP,
  type ActivityEntry, type ActivityStatus, type Origin,
} from './downloadActivity';

/** How long a row stays in download_log. Longer than the feed's day, so a slow week can still be looked at. */
export const LOG_KEEP_MS = 7 * 24 * 3600_000;
/** The prune is one indexed DELETE; there is no reason to run it on every chapter of a sweep. */
const PRUNE_EVERY_MS = 3600_000;

let listening = false;
let lastPrune = 0;
/**
 * The writes, one after another. So the log's ids follow the order things finished in, and a restart reads
 * entries that finished in the same millisecond back in that order rather than in whichever order parallel
 * inserts happened to commit. One small INSERT per chapter; a chapter takes seconds, so this never queues.
 */
let tail: Promise<void> = Promise.resolve();
const warn = (what: string) => (err: unknown) => console.warn(`[activity] ${what}: ${(err as Error)?.message || err}`);

function write(e: Readonly<ActivityEntry>): void {
  tail = tail.then(() => q(
    `INSERT INTO download_log (folder, title, number, source, origin, by_user, status, pages, reason, started_at, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [e.folder, e.title, e.number, e.source, e.origin, e.by, e.status, e.pages ?? null, e.reason ?? null,
     new Date(e.startedAt), new Date(e.finishedAt ?? Date.now())],
  )).then(() => {}, warn(`could not write down ${e.folder} ch ${e.number}`));
  const now = Date.now();
  if (now - lastPrune > PRUNE_EVERY_MS) {
    lastPrune = now;
    tail = tail.then(() => pruneActivityLog(now)).then(() => {}, warn('could not prune the download log'));
  }
}

/**
 * A chapter written down as `partial` is whole now (downloadActivity.ts healFinished): its rows say landed, so a
 * restart does not bring the "saved with pages missing" back. After the writes queued before it, in the same line:
 * the row it rewrites may be one of them.
 */
function heal(folder: string, number: number): void {
  tail = tail.then(() => q(
    `UPDATE download_log SET status = 'done', reason = NULL WHERE folder = $1 AND number = $2::real AND status = 'partial'`,
    [folder, number],
  )).then(() => {}, warn(`could not write down that ${folder} ch ${number} is whole now`));
}

/**
 * A folder's failed chapters were dismissed (downloadActivity.ts dismissFailed): their rows go too, or a restart reads
 * the card back. In the same line as the writes: a row it deletes may be one of them.
 */
function dismiss(folder: string, by: string | null): void {
  tail = tail.then(() => q(
    `DELETE FROM download_log WHERE folder = $1 AND status = 'failed' AND origin <> 'archive' AND ($2::text IS NULL OR by_user = $2)`,
    [folder, by],
  )).then(() => {}, warn(`could not forget the failed chapters of ${folder}`));
}

/** Wait for every write (and prune) started so far. */
export async function flushActivityLog(): Promise<void> {
  for (let t = tail; ; t = tail) { await t; if (t === tail) return; }
}

/** Drop rows older than a week. Returns how many went. */
export async function pruneActivityLog(now = Date.now()): Promise<number> {
  lastPrune = now;
  const [r] = await q<{ n: number }>(
    'WITH gone AS (DELETE FROM download_log WHERE finished_at < $1 RETURNING 1) SELECT count(*)::int AS n FROM gone',
    [new Date(now - LOG_KEEP_MS)]);
  return r?.n ?? 0;
}

/**
 * Start writing finished downloads down, and put the last day back into the feed. Once at boot; calling it again
 * (a test simulating a restart after clearActivity) reads the log again but never listens twice.
 *
 * The read keeps the feed's own caps, per class: the newest FINISHED_CAP.main of everything but the slow archive
 * and the newest FINISHED_CAP.archive of the archive, oldest first. ⚠️ One `ORDER BY finished_at DESC LIMIT`
 * over both would hand a busy archive the whole budget, and a restart would lose the day's adds and sweeps --
 * the thing the separate caps exist to stop. The `origin = 'archive'` below is downloadActivity's capClass.
 */
export async function startActivityLog(now = Date.now()): Promise<number> {
  if (!listening) {
    listening = true;
    onFinished(write);
    onHealed(heal);
    onDismissed(dismiss);
  }
  await pruneActivityLog(now);
  const since = new Date(now - ACTIVITY_TTL_MS);
  const cols = 'id, folder, title, number, source, origin, by_user, status, pages, reason, started_at, finished_at';
  const rows = await q<{
    id: number; folder: string; title: string; number: number; source: string; origin: string; by_user: string | null;
    status: string; pages: number | null; reason: string | null; started_at: Date; finished_at: Date;
  }>(
    `SELECT * FROM (
       (SELECT ${cols} FROM download_log WHERE finished_at > $1 AND origin <> 'archive' ORDER BY finished_at DESC, id DESC LIMIT $2)
       UNION ALL
       (SELECT ${cols} FROM download_log WHERE finished_at > $1 AND origin = 'archive' ORDER BY finished_at DESC, id DESC LIMIT $3)
     ) x ORDER BY finished_at, id`,
    [since, FINISHED_CAP.main, FINISHED_CAP.archive],
  );
  restoreFinished(rows.map((r) => ({
    folder: r.folder, title: r.title, number: Number(r.number), source: r.source,
    // Written by this module from the same types, so read back as them. A value a newer version wrote (read
    // after a rollback) passes through as itself, and the web words an origin it does not know as the server's.
    origin: r.origin as Origin, by: r.by_user, status: r.status as ActivityStatus,
    startedAt: new Date(r.started_at).getTime(), finishedAt: new Date(r.finished_at).getTime(),
    ...(r.pages !== null ? { pages: r.pages } : {}),
    // Only the English was stored: its codes are read back from it, where this server wrote it (v0.49.1).
    ...(r.reason !== null ? { reason: r.reason, ...(reasonSaidOf(r.reason) ? { reasonSaid: reasonSaidOf(r.reason) } : {}) } : {}),
  })));
  return rows.length;
}
