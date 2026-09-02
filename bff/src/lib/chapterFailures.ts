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

export interface ChapterFailure {
  seriesId: string;
  title: string;
  number: number;
  sourceId: string;
  err: unknown;
}

const reasonOf = (e: any): string => String(e?.message || e || 'unknown error').slice(0, 300);

/**
 * What the ledger records as the status. A refusal keeps the source status the downloader attached; a
 * chapter that merely came up short is 'incomplete' whoever was blamed for it, because "how many pages" is
 * the question a person asks next and the reason column carries the ratio.
 */
const statusOf = (e: any): string => e?.blockStatus ?? (e?.pages !== undefined ? 'incomplete' : 'error');

export async function noteChapterFailure(f: ChapterFailure): Promise<void> {
  const e: any = f.err;
  const status = statusOf(e);
  const pages = e?.pages !== undefined && e?.expected ? `${e.pages}/${e.expected} pages, ` : '';
  const blame = e?.blockStatus ? `${e.blockStatus} (cooldown)` : `${status} (no cooldown)`;
  console.warn(`[updater] "${f.title}" ch ${f.number} via ${f.sourceId}: ${pages}${blame}: ${reasonOf(e)}`);
  if (e?.diskFull) return; // not the chapter's fault, and not the source's
  await q(
    `INSERT INTO chapter_failures (series_id, number, source_id, status, reason, attempts, at)
     VALUES ($1, $2, $3, $4, $5, 1, now())
     ON CONFLICT (series_id, number) DO UPDATE SET
       source_id = EXCLUDED.source_id, status = EXCLUDED.status, reason = EXCLUDED.reason,
       attempts = chapter_failures.attempts + 1, at = now()`,
    [f.seriesId, f.number, f.sourceId, status, reasonOf(e)],
  ).catch(() => {}); // best effort, like logAudit: a ledger must never be the thing that fails a download
}
