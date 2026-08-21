// Destructive library operations: hide a series, restore it, and merge one into another.
//
// Deleting HIDES rather than erases. The id survives, so favourites, ratings, notes and -- above all --
// reading history stay attached to something real, the action is undoable, and we never have to choose
// between erasing someone's reading events (which silently rewrites their stats, streaks and Wrapped) and
// leaving a dead series in Trending. persistScan() knows to skip a hidden folder, or the next scan would
// simply bring it back under a new id.
//
// Merging does NOT de-duplicate chapters, deliberately. Every chapter row and every progress row survives
// exactly as it is. The moment you delete a chapter because it looks like a duplicate, you have to fold two
// read_progress rows into one, and getting that wrong silently marks chapters unread -- which then syncs
// outward to the user's AniList account and cannot be undone. Duplicate chapter numbers are a tidiness
// problem the health page can surface; lost reading progress is not recoverable.
import { rm } from 'fs/promises';
import { q, one, tx } from './db';
import { artFile } from './seriesArt';

export interface SeriesRow {
  id: string;
  title: string;
  folder: string;
  deleted_at: string | null;
  merged_into: string | null;
}

export const getSeriesRow = (id: string) =>
  one<SeriesRow>(`SELECT id, title, folder, deleted_at, merged_into FROM lib_series WHERE id = $1`, [id]);

/** Remove the derived, per-series art: the DB row and the two files nothing else ever sweeps. */
async function dropArt(id: string): Promise<void> {
  await q(`DELETE FROM series_art WHERE series_id = $1`, [id]).catch(() => {});
  await q(`DELETE FROM series_overrides WHERE series_id = $1`, [id]).catch(() => {});
  for (const kind of ['cover', 'banner'] as const) {
    await rm(artFile(id, kind), { force: true }).catch(() => {});
  }
}

/**
 * Hide a series. Its chapters, and everything a user owns about it, stay in place.
 *
 * The tracker link goes, because it is what the duplicate-series health check matches on: leaving it means
 * the check reports the pair forever, and a later re-add flags as a duplicate of something invisible.
 */
export async function deleteSeries(id: string): Promise<{ ok: true; books: number }> {
  const books = await one<{ n: number }>(`SELECT count(*)::int n FROM lib_books WHERE series_id = $1`, [id]);
  await tx(async (qq) => {
    await qq(`UPDATE lib_series SET deleted_at = now() WHERE id = $1`, [id]);
    await qq(`DELETE FROM series_trackers WHERE series_id = $1`, [id]);
  });
  return { ok: true, books: books?.n ?? 0 };
}

export async function restoreSeries(id: string): Promise<{ ok: true }> {
  await q(`UPDATE lib_series SET deleted_at = NULL WHERE id = $1`, [id]);
  return { ok: true };
}

export interface MergeResult {
  ok: true;
  moved: number;
  favorites: number;
  ratings: number;
  collections: number;
}

/**
 * Fold `fromId` into `intoId`. Everything the absorbed series held moves; nothing is deleted.
 *
 * The tables keyed `(user_id, series_id)` are the awkward ones: a user who had BOTH series favourited would
 * violate the primary key on a plain UPDATE, so those are insert-if-absent then drop. series_seen's counter
 * is recomputed rather than carried over -- summing two "how many chapters had you seen" values would give
 * everyone a phantom NEW badge, or hide one.
 */
export async function mergeSeries(fromId: string, intoId: string): Promise<MergeResult> {
  return tx(async (qq) => {
    const moved = await qq<{ id: string }>(
      `UPDATE lib_books SET series_id = $2 WHERE series_id = $1 RETURNING id`,
      [fromId, intoId],
    );

    // (user_id, series_id) — union, keeping whatever the survivor already had
    const favs = await qq<{ user_id: string }>(
      `INSERT INTO favorites (user_id, series_id, created_at)
       SELECT user_id, $2, created_at FROM favorites WHERE series_id = $1
       ON CONFLICT (user_id, series_id) DO NOTHING RETURNING user_id`,
      [fromId, intoId],
    );
    await qq(`DELETE FROM favorites WHERE series_id = $1`, [fromId]);

    const rates = await qq<{ user_id: string }>(
      `INSERT INTO ratings (user_id, series_id, stars, updated_at)
       SELECT user_id, $2, stars, updated_at FROM ratings WHERE series_id = $1
       ON CONFLICT (user_id, series_id) DO NOTHING RETURNING user_id`,
      [fromId, intoId],
    );
    await qq(`DELETE FROM ratings WHERE series_id = $1`, [fromId]);

    const cols = await qq<{ collection_id: string }>(
      `INSERT INTO collection_items (collection_id, series_id, position)
       SELECT collection_id, $2, position FROM collection_items WHERE series_id = $1
       ON CONFLICT (collection_id, series_id) DO NOTHING RETURNING collection_id`,
      [fromId, intoId],
    );
    await qq(`DELETE FROM collection_items WHERE series_id = $1`, [fromId]);

    // NEW badges: recompute against the merged size rather than carrying a stale count across
    await qq(
      `INSERT INTO series_seen (user_id, series_id, seen_books_count, seen_at)
       SELECT user_id, $2, 0, seen_at FROM series_seen WHERE series_id = $1
       ON CONFLICT (user_id, series_id) DO NOTHING`,
      [fromId, intoId],
    );
    await qq(`DELETE FROM series_seen WHERE series_id = $1`, [fromId]);

    // Keyed on book_id, so the books moving is enough — no collision is possible, and every progress row
    // and every reading event survives untouched. This is the whole reason merge does not de-duplicate.
    for (const t of ['read_progress', 'reading_events', 'notes', 'offline_downloads']) {
      await qq(`UPDATE ${t} SET series_id = $2 WHERE series_id = $1`, [fromId, intoId]);
    }

    // Point the absorbed row at its survivor instead of deleting it: its folder still exists on disk, and
    // persistScan needs this to keep putting those files under the merged series.
    await qq(`UPDATE lib_series SET merged_into = $2 WHERE id = $1`, [fromId, intoId]);
    await qq(`DELETE FROM series_trackers WHERE series_id = $1`, [fromId]);

    // The survivor's rollups are now wrong
    await qq(
      `UPDATE lib_series s SET books_count = c.n, latest_mtime = COALESCE(c.mt, 0)
         FROM (SELECT count(*) n, max(mtime) mt FROM lib_books WHERE series_id = $1) c
        WHERE s.id = $1`,
      [intoId],
    );
    await qq(
      `UPDATE lib_series SET cover_book_id = (
         SELECT id FROM lib_books WHERE series_id = $1 ORDER BY number ASC, file ASC LIMIT 1
       ) WHERE id = $1`,
      [intoId],
    );

    return {
      ok: true as const,
      moved: moved.length,
      favorites: favs.length,
      ratings: rates.length,
      collections: cols.length,
    };
  }).then(async (r) => {
    // outside the transaction: filesystem work must not hold it open
    await dropArt(fromId);
    return r;
  });
}
