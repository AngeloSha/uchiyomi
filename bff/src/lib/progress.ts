// Reading-progress writes.
//
// Extracted from the route so the completion rules can be tested directly — they are subtle, and getting them
// wrong is invisible: chapters silently stop counting, which starved streaks and the household leaderboard
// for weeks before anyone noticed the numbers looked low.
//
// The rules:
//  * Organic reading pings may only UPGRADE a chapter to completed. Re-opening something you've finished
//    must not mark it unread again.
//  * Explicit user intent (mark read / mark unread, sent with `silent`) writes exactly what it says, and is
//    kept out of reading_events so bulk-marking a backlog doesn't inflate this week's stats.
import { q } from './db';
import { pushSeriesProgressAsync } from './trackers';

export interface ProgressWrite {
  userId: string;
  bookId: string;
  seriesId: string;
  page: number;
  completed: boolean;
  /** explicit user action (mark read/unread): write verbatim, don't log a reading event */
  silent?: boolean;
  deviceId?: string | null;
  /** When the event happened, in client ms. Absent means now, which is every live ping. */
  at?: number;
}

export { reachedEnd } from './progressRules';

export async function writeProgress(w: ProgressWrite): Promise<void> {
  // `at` is when the event happened, not when it arrived. The offline outbox replays events minutes or days
  // later, and `page = EXCLUDED.page` applied them unconditionally -- so a queued page 12 landing after the
  // reader had gone on to page 60 on another device rewound the bookmark, and the reader resumed 48 pages
  // back. Only a page at least as recent as the stored one may move it.
  //
  // Note this is NOT `GREATEST(page)`: turning back a page is a real thing readers do and must still persist.
  // The rule is "the newest event wins", not "the furthest page wins".
  const at = w.at ? new Date(w.at) : null;
  await q(
    `INSERT INTO read_progress (user_id, book_id, series_id, page, completed)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, book_id)
     DO UPDATE SET page = CASE WHEN $7::timestamptz IS NULL OR $7 >= read_progress.updated_at
                               THEN EXCLUDED.page ELSE read_progress.page END,
       completed = CASE WHEN $6 THEN EXCLUDED.completed ELSE (read_progress.completed OR EXCLUDED.completed) END,
       updated_at = GREATEST(read_progress.updated_at, COALESCE($7::timestamptz, now()))`,
    [w.userId, w.bookId, w.seriesId, w.page, w.completed, !!w.silent, at],
  );
  if (!w.silent) {
    await q(
      `INSERT INTO reading_events (user_id, series_id, book_id, page, completed, device_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [w.userId, w.seriesId, w.bookId, w.page, w.completed, w.deviceId ?? null],
    );
  }
  // Finishing a chapter is the only thing worth telling an external tracker about. Fire-and-forget on
  // purpose: a tracker being slow or down must never delay a page turn or fail the write above.
  if (w.completed && w.seriesId && w.seriesId !== 'unknown') pushSeriesProgressAsync(w.userId, w.seriesId);
}
