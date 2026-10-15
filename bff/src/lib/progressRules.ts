// Pure reading-progress rules. Kept free of the db/env imports so they can be unit-tested on their own.

/** True when a page ping has reached the end of a book, i.e. it counts as finished even if the client never
 *  sent an explicit completion (fast scrolling blows past the last page). `pagesCount` is 0/unknown for some
 *  books, so only a real count is trusted — otherwise every first page would mark a book read.
 *
 *  Pages are numbered from 1, so `pagesCount - 1` is the page BEFORE the last. It reads like "the last index", but it
 *  is kept (#264, 2026-10-16): it is when a chapter has counted as read since the first release -- the last page is
 *  often a credits page nobody waits on -- and read-chapter cleanup (chapterCleanup.ts) holds a file by the same rule.
 *  Its cost is that one read-through writes two completed events: this page's ping, upgraded here, and the last page's
 *  own. So nothing counts completed EVENTS: every count of finished chapters is count(DISTINCT book_id)
 *  (finishedOnce.int.test.ts). */
export function reachedEnd(page: number, pagesCount: number): boolean {
  return pagesCount > 1 && page >= pagesCount - 1;
}

/** How far back a client's clock is believed (v0.61.0): further than this is a dead clock, not a long flight. */
export const AT_FLOOR_MS = 90 * 86_400_000;

/**
 * When a reading event happened, as the server will store it (v0.61.0). The offline outbox replays page turns hours or
 * days later with the time they happened (`at`); until v0.61.0 only the bookmark's ordering used it, and the reading
 * itself -- history, streaks, the weekly board, Wrapped -- was dated when the phone came back online. Never later than
 * now: a device whose clock runs fast would otherwise date reading ahead of every other device and freeze their
 * bookmarks. Not believed past AT_FLOOR_MS back (a dead clock reads 1970): null, and the arrival time stands, as it
 * always did. Reintroduce by dropping `created_at` from writeProgress's reading_events INSERT: "a replayed page is
 * dated when it was read" in offlineDates.int.test.ts finds it dated today.
 */
export function eventTime(at: number | undefined | null, now: number = Date.now()): Date | null {
  if (!at || !Number.isFinite(at)) return null;
  if (at < now - AT_FLOOR_MS) return null;
  return new Date(Math.min(now, at));
}
