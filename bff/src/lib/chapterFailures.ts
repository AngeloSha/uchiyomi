// One place that says which chapter of which series failed, and why.
//
// Until this existed a failed chapter was `failed++` in the updater and a bumped counter on a job card in the
// fill loop, and the error itself was discarded on the spot. "12 chapters could not be saved" was the whole
// record: which series, which chapter, which source and why existed nowhere. Live, one night's sweep lost
// 164 of 226 series to a single chapter and `docker logs` had nothing to show for it. And because the next
// sweep recomputes `missing` from scratch and takes the oldest, it re-attempted the same doomed chapters every
// night, which is why that number was constant rather than shrinking.
//
// Two outputs from one call: a log line a person can grep, and one row per MISSING chapter (not per attempt)
// that the health page reads and persistScan deletes the moment the chapter lands.
import { q } from './db';
import type { PageFailure } from './downloader';

export interface ChapterFailure {
  seriesId: string;
  title: string;
  number: number;
  sourceId: string;
  err: unknown;
}

/** One failed page as the ledger shows it: `page 80: 200 image/webp 88 B`, `page 12: 404`, `page 3: timeout`. */
const pageLabel = (f: PageFailure): string =>
  `page ${f.index + 1}: ${f.status ? f.status : f.error || 'fetch failed'}${f.type ? ` ${f.type}` : ''}${f.bytes !== undefined ? ` ${f.bytes} B` : ''}`;

/**
 * The reason column: the error's message, plus the first three failed pages when the downloader recorded
 * them. "109 of 110 pages" said nothing about WHICH page or what the site answered for it, and the fix for
 * an 88-byte WebP, a 404 and a timeout are three different fixes. Pages are 1-based here, as a person
 * counts them in the reader; ≤ 300 characters, the column's working size.
 */
export const reasonOf = (e: any): string => {
  const base = String(e?.message || e || 'unknown error');
  const pages: PageFailure[] = Array.isArray(e?.failedPages) ? e.failedPages : [];
  const evidence = pages.slice(0, 3).map(pageLabel).join('; ');
  return (evidence ? `${base} (${evidence})` : base).slice(0, 300);
};

/**
 * What the ledger records as the status. A refusal keeps the source status the downloader attached; a
 * chapter that merely came up short is 'incomplete' whoever was blamed for it, because "how many pages" is
 * the question a person asks next and the reason column carries the ratio.
 */
const statusOf = (e: any): string => e?.blockStatus ?? (e?.pages !== undefined ? 'incomplete' : 'error');

/**
 * Failures follow the series (v0.55.3): a row filed under a source the series no longer uses -- neither its main source
 * nor one it follows -- is its main source's to retry, and is filed under it, its tries starting again. Live: Replace
 * moved two series off AllManga onto Natomanga, which lists every one of their chapters, and their 32 failed chapters
 * stayed filed under AllManga -- failing at its pages, switched off, followed by nothing. Health listed them there, the
 * failures step skips a source that fails at its pages, and every Fix everything run said "36 chapters no source can
 * download" though Natomanga could, once its rate limit passed.
 * Every way a series stops using a source files them: a main-source switch (lib/mainSource.ts: Replace, Make main, Fix
 * everything), the unfollow route, a retirement (lib/retireSource.ts), Replace making room (lib/findSources.ts
 * makeRoom) -- and, once, for the rows already left behind, the v0.55.3 data migration (lib/migrate.ts).
 * `status` becomes `moved` -- not tried at this source yet -- and the reason stays: why it failed where it was. When it
 * first failed stays too (Health's "failing since"). The key is (series, number) alone, one row per chapter whatever
 * the source, so a row moves where it is and never meets another. A series with no main source keeps its rows where
 * they are: there is nowhere to move them.
 * Reintroduce by dropping the NOT EXISTS: a row under a source the series still follows moves too ("a row under a
 * source the series still follows stays as it is" in mainSource.int.test.ts; t-ff-follower in migrate.int.test.ts).
 * By dropping `f.source_id <> s.source_id`: a row under the main source itself reads moved, its tries reset
 * (t-ff-main).
 */
export const REFILE_FAILURES_SQL = `
  UPDATE chapter_failures f
     SET source_id = s.source_id, status = 'moved', attempts = 0, first_at = COALESCE(f.first_at, f.at), at = now()
    FROM lib_series s
   WHERE s.id = f.series_id AND s.source_id IS NOT NULL AND f.source_id <> s.source_id
     AND NOT EXISTS (SELECT 1 FROM series_sources ss WHERE ss.series_id = f.series_id AND ss.source_id = f.source_id)
     AND ($1::text[] IS NULL OR f.series_id = ANY($1::text[]))
  RETURNING f.series_id`;

/**
 * Re-file the rows of these series (every series: null) under their main source, as REFILE_FAILURES_SQL says; `run` is
 * the query to do it with -- a transaction's own, when the caller holds one. How many rows moved.
 */
export async function refileFailures(
  run: (sql: string, params?: any[]) => Promise<unknown[]>, seriesIds: readonly string[] | null,
): Promise<number> {
  return (await run(REFILE_FAILURES_SQL, [seriesIds ? [...seriesIds] : null])).length;
}

export async function noteChapterFailure(f: ChapterFailure): Promise<void> {
  const e: any = f.err;
  const status = statusOf(e);
  const pages = e?.pages !== undefined && e?.expected ? `${e.pages}/${e.expected} pages, ` : '';
  const blame = e?.blockStatus ? `${e.blockStatus} (cooldown)` : `${status} (no cooldown)`;
  console.warn(`[updater] "${f.title}" ch ${f.number} via ${f.sourceId}: ${pages}${blame}: ${reasonOf(e)}`);
  if (e?.diskFull) return; // not the chapter's fault, and not the source's
  // `at` is the latest attempt; `first_at` (v0.49.0) the first failure, kept on every later one -- the Health
  // page's "failing since" -- and filled from `at` for a row written before the column (or by a rollback).
  await q(
    `INSERT INTO chapter_failures (series_id, number, source_id, status, reason, attempts, at, first_at)
     VALUES ($1, $2, $3, $4, $5, 1, now(), now())
     ON CONFLICT (series_id, number) DO UPDATE SET
       source_id = EXCLUDED.source_id, status = EXCLUDED.status, reason = EXCLUDED.reason,
       attempts = chapter_failures.attempts + 1, first_at = COALESCE(chapter_failures.first_at, chapter_failures.at),
       at = now()`,
    [f.seriesId, f.number, f.sourceId, status, reasonOf(e)],
  ).catch(() => {}); // best effort, like logAudit: a ledger must never be the thing that fails a download
}
