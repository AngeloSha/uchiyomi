// Fills in lib_books.fingerprint for the whole library, in the background.
//
// This deliberately is NOT a migration. runOnce() steps hold a transaction open during boot, and this one
// reads every archive on disk — on a real library that is 40,000 files, so boot time would grow with the
// size of someone's collection. It runs after the server is already listening and serving pages instead.
//
// Everything about it is designed so that not finishing is fine: the cursor is "whatever is still NULL", so
// it resumes wherever it stopped, and what reads the column -- Rescan everything telling a moved or renamed file
// from a gone one (lib/rescan.ts), LIBRARY_REMATCH a moved folder (lib/rematch.ts) -- reads a row without one as
// "not known", never as a match.
//
// ⚠️ WHEN matters as much as whether (v0.55.7, #150). A file can only be recognised after a move if its row was
// fingerprinted BEFORE the move: once the file is gone its old row can never be read again. @Kedryn unpacked Zagor into
// folders of 100 chapters and merged them into one folder soon after; the backfill ran a minute after boot and then
// every six hours, so none of them had been read, and Rescan everything called every chapter gone. So a scan that
// meets files with no fingerprint (new ones, and ones whose mtime moved -- the scan clears the old fingerprint then)
// arms a pass AFTER_SCAN_MS on. A scheduled pass leaves a file written in the last minute for later (YOUNG_MS): an
// archive read while it is still being unpacked has no entry table yet, and a failure is stamped for good.
import { join } from 'path';
import { stat } from 'fs/promises';
import { q, pool } from './db';
import { fingerprintChapter } from './fingerprint';
import { LIBRARY_ROOT, onUnprintedFiles } from './library';

// Separate from MIGRATE_LOCK, and taken with try_ rather than blocking: if another replica is already
// doing this, the loser should decline, not queue up behind it.
const FP_LOCK = 8_263_196;

const BATCH = 500;
const CONCURRENCY = 4;
/**
 * A file written less than this long ago may still be being written -- unpacked, copied in over the network -- and
 * a scheduled pass leaves it for a later one (the header). A file whose mtime is AHEAD of this clock (a NAS whose
 * clock runs fast) is not young: skipped as one, it would be skipped forever.
 */
export const YOUNG_MS = 60_000;
/** How long after a scan that met files with no fingerprint its pass runs (the header): time for an unpack to end. */
export const AFTER_SCAN_MS = 3 * 60_000;

export interface FingerprintProgress {
  running: boolean;
  done: number;
  failed: number;
  /** Files a scheduled pass left for a later one: written in the last minute (YOUNG_MS). */
  young: number;
  /** Rows still lacking an attempt, as of the last batch boundary. */
  remaining: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  ms: number | null;
}

export const fpState: FingerprintProgress = {
  running: false,
  done: 0,
  failed: 0,
  young: 0,
  remaining: null,
  startedAt: null,
  finishedAt: null,
  ms: null,
};

/**
 * How many books still have no fingerprint attempt. Cheap enough to call from an admin endpoint.
 *
 * A tombstone (lib/chapterCleanup.ts) is excluded here and in the batch query alike: its file is gone and its
 * fp_at was cleared with it, so without the clause it would be attempted -- and fail -- on every run, forever,
 * and the count would never reach zero.
 */
export async function fingerprintRemaining(): Promise<number> {
  const rows = await q<{ n: string }>(`SELECT count(*)::text n FROM lib_books WHERE fp_at IS NULL AND pruned_at IS NULL`);
  return Number(rows[0]?.n ?? 0);
}

/** Run `worker` over `items` with a fixed number of slots. Order is irrelevant here. */
async function pool_<T>(items: T[], n: number, worker: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

interface Row { id: string; root: string | null; file: string }

/**
 * One book, stamped as the backfill stamps it. Also Rescan everything's, for the files it pairs (lib/rescan.ts).
 * `skipYoung`, a scheduled pass's: a file written in the last minute is not read at all and the answer is null --
 * no stamp, so a later pass reads it (the header). Rescan's pairing and the admin's own run read every file: a person
 * is waiting on them, and a file they copied in a moment ago is the one they want recognised.
 */
export async function fingerprintOne(b: Row, o: { skipYoung?: boolean } = {}): Promise<boolean | null> {
  const abs = join(b.root || LIBRARY_ROOT, b.file);
  if (o.skipYoung) {
    const st = await stat(abs).catch(() => null);
    const age = st ? Date.now() - st.mtimeMs : -1;
    if (age >= 0 && age < YOUNG_MS) return null;
  }
  const r = await fingerprintChapter(abs);
  // fp_at is stamped even when the read failed, so an unreadable file is attempted once rather than
  // retried on every pass forever. A "retry errors" action just nulls fp_at again.
  await q(
    `UPDATE lib_books SET fingerprint = $2, fp_kind = $3, size = $4, fp_at = now() WHERE id = $1`,
    [b.id, r.fingerprint, r.kind, r.size],
  ).catch(() => {});
  return r.fingerprint !== null;
}

/**
 * Fingerprint every book that has not been attempted yet. Safe to call repeatedly; safe to interrupt.
 * Returns immediately if another process (or another call) already holds the lock. `skipYoung`: the scheduled
 * passes' (scheduledPass), see fingerprintOne.
 */
export async function runFingerprintBackfill(opts: { max?: number; skipYoung?: boolean } = {}): Promise<FingerprintProgress> {
  const client = await pool.connect();
  let held = false;
  try {
    const got = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [FP_LOCK]);
    held = !!got.rows[0]?.ok;
    if (!held) return fpState; // someone else is on it
  } finally {
    if (!held) client.release();
  }

  fpState.running = true;
  fpState.startedAt = Date.now();
  fpState.finishedAt = null;
  fpState.done = 0;
  fpState.failed = 0;
  fpState.young = 0;
  const limit = opts.max ?? Infinity;

  try {
    // Keyset, not "the first rows still NULL": a young file is left NULL on purpose, and would be the first row of
    // every batch again -- a pass that never ends.
    let after = '';
    for (;;) {
      const batch = await q<Row>(
        `SELECT id, root, file FROM lib_books WHERE fp_at IS NULL AND pruned_at IS NULL AND id > $2 ORDER BY id LIMIT $1`,
        [Math.min(BATCH, Math.max(0, limit - fpState.done - fpState.failed)), after],
      );
      if (!batch.length) break;
      after = batch[batch.length - 1].id;

      await pool_(batch, CONCURRENCY, async (b) => {
        const ok = await fingerprintOne(b, { skipYoung: opts.skipYoung });
        if (ok === null) fpState.young++;
        else if (ok) fpState.done++;
        else fpState.failed++;
      });

      fpState.remaining = await fingerprintRemaining().catch(() => null);
      if (fpState.done + fpState.failed >= limit) break;
      // let the event loop breathe between batches — this shares a process with the API
      await new Promise((r) => setImmediate(r));
    }
    return fpState;
  } finally {
    fpState.running = false;
    fpState.finishedAt = Date.now();
    fpState.ms = fpState.finishedAt - (fpState.startedAt ?? fpState.finishedAt);
    await client.query('SELECT pg_advisory_unlock($1)', [FP_LOCK]).catch(() => {});
    client.release();
    if (fpState.done || fpState.failed || fpState.young) {
      console.log(
        `[fingerprint] ${fpState.done} fingerprinted, ${fpState.failed} unreadable, ${fpState.ms}ms`
          + (fpState.young ? `; ${fpState.young} written in the last minute, left for a later pass` : ''),
      );
    }
  }
}

/** A scheduled pass: every pass the server starts by itself leaves a file still being written for a later one. */
export const scheduledPass = (): Promise<FingerprintProgress> => runFingerprintBackfill({ skipYoung: true });

/** The pass a scan armed, while it waits: one at a time, however many scans meet new files meanwhile. */
let afterScan: ReturnType<typeof setTimeout> | null = null;

/**
 * Kick the backfill off a while after boot, so it never competes with a server that is still warming up and
 * never delays it, then every `everyMs`, and `afterScanMs` after a scan that met files with no fingerprint (the
 * header). Never awaited, never throws.
 * Reintroduce by dropping the onUnprintedFiles line: "a scan that meets new files arms a pass a few minutes on" in
 * fingerprintJob.int.test.ts finds no pass run.
 */
export function scheduleFingerprintBackfill(
  delayMs = 60_000, everyMs = 6 * 60 * 60_000, run: () => Promise<unknown> = scheduledPass, afterScanMs = AFTER_SCAN_MS,
): void {
  // ⚠️ Re-armed, for the same reason as the page-hash job beside it: a one-shot pass leaves every chapter
  // added after boot unfingerprinted until the container restarts, and this column feeds folder rematch.
  // Reintroduce by dropping the re-arm: it runs once and new chapters are never picked up.
  const tick = async () => {
    try {
      await run();
    } catch (e) {
      console.warn('[fingerprint] backfill failed', (e as Error)?.message);
    }
    setTimeout(tick, everyMs).unref?.();
  };
  setTimeout(tick, delayMs).unref?.();
  // A pass already armed reads every row still unattempted when it runs: the scans meanwhile add theirs to it.
  onUnprintedFiles(() => {
    if (afterScan) return;
    afterScan = setTimeout(() => {
      afterScan = null;
      run().catch((e) => console.warn('[fingerprint] backfill after a scan failed', (e as Error)?.message));
    }, afterScanMs);
    afterScan.unref?.();
  });
}
