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

export interface ProgressWrite {
  userId: string;
  bookId: string;
  seriesId: string;
  page: number;
  completed: boolean;
  /** explicit user action (mark read/unread): write verbatim, don't log a reading event */
  silent?: boolean;
  deviceId?: string | null;
}

export { reachedEnd } from './progressRules';

export async function writeProgress(w: ProgressWrite): Promise<void> {
  await q(
    `INSERT INTO read_progress (user_id, book_id, series_id, page, completed)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, book_id)
     DO UPDATE SET page = EXCLUDED.page,
       completed = CASE WHEN $6 THEN EXCLUDED.completed ELSE (read_progress.completed OR EXCLUDED.completed) END,
       updated_at = now()`,
    [w.userId, w.bookId, w.seriesId, w.page, w.completed, !!w.silent],
  );
  if (!w.silent) {
    await q(
      `INSERT INTO reading_events (user_id, series_id, book_id, page, completed, device_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [w.userId, w.seriesId, w.bookId, w.page, w.completed, w.deviceId ?? null],
    );
  }
}
