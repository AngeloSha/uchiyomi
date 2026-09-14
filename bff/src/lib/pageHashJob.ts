import { join } from 'path';
import { pool, q } from './db';
import { cbzPageAt, LIBRARY_ROOT } from './library';
import { pageHash } from './pageHash';

/**
 * Fill in a perceptual hash for every page, in the background, so the reader can skip the pages that are
 * not the story. Shaped after `fingerprintJob.ts`, which is the established way to walk the whole library
 * without hurting a server that is also answering requests: an advisory lock so two processes cannot both
 * run it, a bounded worker pool, batches with a breath between them, and progress the Tasks panel can read.
 *
 * ⚠️ This opens every chapter archive and decodes every page, which is by far the most expensive job in the
 * app -- more than fingerprinting, which only reads a zip's central directory. Hence the smaller batch, the
 * lower concurrency, and the longer delay after boot. It is also why a page is stamped `checked_at` even
 * when it could not be read: without that, an unreadable page is retried on every pass, forever.
 */
const LOCK = 0x70616765; // 'page'
const BATCH = 40;        // chapters per batch, not pages -- one chapter is tens of decodes
const CONCURRENCY = 2;

export interface PageHashProgress {
  running: boolean;
  chapters: number;
  pages: number;
  failed: number;
  remaining: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  ms: number | null;
}

export const phState: PageHashProgress = {
  running: false, chapters: 0, pages: 0, failed: 0,
  remaining: null, startedAt: null, finishedAt: null, ms: null,
};

/**
 * Chapters with no page hashed yet. Cheap enough for an admin endpoint.
 *
 * A tombstone (lib/chapterCleanup.ts) is excluded here and in the batch query alike: its file is gone and its
 * computed hashes went with it, so without the clause it would be opened -- and fail -- on every run, forever,
 * and the count would never reach zero.
 */
export async function pageHashRemaining(): Promise<number> {
  const rows = await q<{ n: string }>(
    `SELECT count(*)::text n FROM lib_books b
      WHERE b.pruned_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM page_hashes p WHERE p.book_id = b.id AND p.page = 0)`,
  );
  return Number(rows[0]?.n ?? 0);
}

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

/** Hash every page of one chapter. Returns how many pages were read and how many could not be. */
async function hashChapter(b: Row): Promise<{ ok: number; bad: number }> {
  const abs = join(b.root || LIBRARY_ROOT, b.file);
  let ok = 0;
  let bad = 0;
  const rows: Array<[string, number, string | null]> = [];
  for (let i = 0; ; i++) {
    let page: Awaited<ReturnType<typeof cbzPageAt>> = null;
    try {
      page = await cbzPageAt(abs, i);
    } catch {
      break; // the archive itself is unreadable; stop rather than spin
    }
    if (!page) break;
    const h = await pageHash(page.bytes);
    rows.push([b.id, i + 1, h]);
    if (h) ok++; else bad++;
    if (i + 1 >= page.total) break;
  }
  // ⚠️ EVERY chapter gets the page-0 mark, whether or not it produced anything. That row is what "this
  // chapter has been looked at" MEANS, and the queue below asks for exactly that -- so the two can never
  // disagree.
  //
  // It started as a mark only for chapters that produced nothing, because a chapter with no rows at all is
  // indistinguishable from one never visited, and the job would pick the same broken chapter forever. That
  // fixed the spin but left the same conflation pointing the other way: ANY row made a chapter look done.
  // `setPageOverride` writes a row -- a person marking an advert by hand on a chapter the job had not
  // reached yet -- and that single row silently retired the whole chapter from the queue, so its other
  // pages were never fingerprinted and the automatic rule never ran there again. Marking one page turned
  // the feature off for the chapter, which is the exact opposite of what the reader asked for.
  //
  // Page 0 is safe as the mark because it is not a real page number: `junkPagesFor` returns page numbers,
  // and this row carries no hash and no override, so it is never returned to a reader.
  // Reintroduce by writing it only when `rows` is empty: hand-mark a page on an unfingerprinted chapter and
  // that chapter is never fingerprinted, however many times the job runs.
  const written: Array<[string, number, string | null]> = [...rows, [b.id, 0, null]];
  const values = written.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3}, now())`).join(',');
  // `override` is deliberately NOT touched: a person's decision about a page outranks the heuristic and
  // must survive every re-run of this job.
  await q(
    `INSERT INTO page_hashes (book_id, page, hash, checked_at) VALUES ${values}
     ON CONFLICT (book_id, page) DO UPDATE SET hash = EXCLUDED.hash, checked_at = now()`,
    written.flat(),
  ).catch(() => {});
  return { ok, bad };
}

/** Hash pages for every chapter not yet looked at. Safe to call repeatedly; safe to interrupt. */
export async function runPageHashBackfill(opts: { max?: number } = {}): Promise<PageHashProgress> {
  const client = await pool.connect();
  let held = false;
  try {
    const got = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [LOCK]);
    held = !!got.rows[0]?.ok;
    if (!held) return phState;
  } finally {
    if (!held) client.release();
  }

  phState.running = true;
  phState.startedAt = Date.now();
  phState.finishedAt = null;
  phState.chapters = 0;
  phState.pages = 0;
  phState.failed = 0;
  const limit = opts.max ?? Infinity;

  try {
    for (;;) {
      const batch = await q<Row>(
        `SELECT b.id, b.root, b.file FROM lib_books b
          WHERE b.pruned_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM page_hashes p WHERE p.book_id = b.id AND p.page = 0)
          ORDER BY b.id LIMIT $1`,
        [Math.min(BATCH, Math.max(0, limit - phState.chapters))],
      );
      if (!batch.length) break;

      await pool_(batch, CONCURRENCY, async (b) => {
        const r = await hashChapter(b);
        phState.chapters++;
        phState.pages += r.ok;
        phState.failed += r.bad;
      });

      phState.remaining = await pageHashRemaining().catch(() => null);
      if (phState.chapters >= limit) break;
      await new Promise((r) => setImmediate(r));
    }
    return phState;
  } finally {
    phState.running = false;
    phState.finishedAt = Date.now();
    phState.ms = phState.finishedAt - (phState.startedAt ?? phState.finishedAt);
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => {});
    client.release();
    if (phState.chapters) {
      console.log(`[pagehash] ${phState.chapters} chapters, ${phState.pages} pages, ${phState.failed} unreadable, ${phState.ms}ms`);
    }
  }
}

/** How often to look for chapters that have arrived since the last pass. */
export const RECHECK_MS = 6 * 60 * 60_000;

/**
 * Start well after boot -- later than the fingerprint job, because this one is heavier and there is no
 * hurry: a page that is not hashed yet is simply not skipped -- and then KEEP CHECKING.
 *
 * ⚠️ The re-arm is the whole point, and its absence was a real bug rather than a missing nicety. This used
 * to be a single `setTimeout`: one pass, five minutes after boot, and nothing afterwards. Nothing else calls
 * the job either -- not `persistScan`, not the updater sweep, not adding a series from Discover -- so on a
 * server that simply stays up, every chapter downloaded after that one pass went un-fingerprinted forever
 * and the feature silently stopped applying to anything new. Measured on a real library the day it shipped:
 * 22 chapters, all added after that morning's boot, still untouched hours later, with ~50-80 more arriving
 * daily. A well-behaved server that never restarts was the worst case, which is exactly backwards.
 *
 * The shape is the one `server.ts` already uses for the source check, the updater and backups: a tick that
 * schedules the next one at the END of the run, INCLUDING after a run that threw -- a job that stops
 * rescheduling because one batch failed is the same bug wearing a different hat.
 *
 * A pass with nothing to do costs one indexed count, so six hours is generous rather than tuned.
 * Reintroduce by dropping the re-arm: the job runs once and a chapter added afterwards is never hashed.
 */
/**
 * `run` is injectable ONLY so the schedule can be tested. ⚠️ Not decoration: mocking a module export does
 * not work in this codebase -- esbuild compiles them to getters and the reassignment silently no-ops, which
 * has produced tests that passed against broken code before. A parameter is the seam that actually holds.
 */
export function schedulePageHashBackfill(delayMs = 5 * 60_000, everyMs = RECHECK_MS, run = runPageHashBackfill): void {
  const tick = async () => {
    try {
      await run();
    } catch (e) {
      console.warn('[pagehash] backfill failed', (e as Error)?.message);
    }
    setTimeout(tick, everyMs).unref?.();
  };
  setTimeout(tick, delayMs).unref?.();
}
