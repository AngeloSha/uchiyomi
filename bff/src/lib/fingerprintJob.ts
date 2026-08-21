// Fills in lib_books.fingerprint for the whole library, in the background.
//
// This deliberately is NOT a migration. runOnce() steps hold a transaction open during boot, and this one
// reads every archive on disk — on a real library that is 40,000 files, so boot time would grow with the
// size of someone's collection. It runs after the server is already listening and serving pages instead.
//
// Everything about it is designed so that not finishing is fine: the cursor is "whatever is still NULL", so
// it resumes wherever it stopped, and nothing reads the column it fills yet.
import { join } from 'path';
import { q, pool } from './db';
import { fingerprintChapter } from './fingerprint';
import { LIBRARY_ROOT } from './library';

// Separate from MIGRATE_LOCK, and taken with try_ rather than blocking: if another replica is already
// doing this, the loser should decline, not queue up behind it.
const FP_LOCK = 8_263_196;

const BATCH = 500;
const CONCURRENCY = 4;

export interface FingerprintProgress {
  running: boolean;
  done: number;
  failed: number;
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
  remaining: null,
  startedAt: null,
  finishedAt: null,
  ms: null,
};

/** How many books still have no fingerprint attempt. Cheap enough to call from an admin endpoint. */
export async function fingerprintRemaining(): Promise<number> {
  const rows = await q<{ n: string }>(`SELECT count(*)::text n FROM lib_books WHERE fp_at IS NULL`);
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

async function fingerprintOne(b: Row): Promise<boolean> {
  const abs = join(b.root || LIBRARY_ROOT, b.file);
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
 * Returns immediately if another process (or another call) already holds the lock.
 */
export async function runFingerprintBackfill(opts: { max?: number } = {}): Promise<FingerprintProgress> {
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
  const limit = opts.max ?? Infinity;

  try {
    for (;;) {
      const batch = await q<Row>(
        `SELECT id, root, file FROM lib_books WHERE fp_at IS NULL ORDER BY id LIMIT $1`,
        [Math.min(BATCH, Math.max(0, limit - fpState.done - fpState.failed))],
      );
      if (!batch.length) break;

      await pool_(batch, CONCURRENCY, async (b) => {
        const ok = await fingerprintOne(b);
        if (ok) fpState.done++;
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
    if (fpState.done || fpState.failed) {
      console.log(
        `[fingerprint] ${fpState.done} fingerprinted, ${fpState.failed} unreadable, ${fpState.ms}ms`,
      );
    }
  }
}

/**
 * Kick the backfill off a while after boot, so it never competes with a server that is still warming up and
 * never delays it. Never awaited, never throws.
 */
export function scheduleFingerprintBackfill(delayMs = 60_000): void {
  setTimeout(() => {
    void runFingerprintBackfill().catch((e) => console.warn('[fingerprint] backfill failed', (e as Error)?.message));
  }, delayMs).unref?.();
}
