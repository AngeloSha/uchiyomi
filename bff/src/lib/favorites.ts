// Favourites, in the order their reader chose (v0.97.0).
//
// A favourite was ordered by when it was made, newest first, everywhere it is listed -- Home's rail, GET /api/favorites,
// OPDS -- and the only way to move one was to unfavourite it and favourite it again. Now each person's favourites carry
// a `position` (lib/migrate.ts), set by Home's Favourites sheet, and every list of them reads FAVORITE_ORDER: placed
// ones in their places, a favourite not placed yet (one made since) first, newest first, so a series just favourited is
// where it always was until it is moved.
import { q } from './db';

/** How one person's favourites are listed, over the favorites row `alias` (or the table itself). */
export const favoriteOrder = (alias = ''): string => {
  const c = alias ? `${alias}.` : '';
  return `${c}position ASC NULLS FIRST, ${c}created_at DESC`;
};

/**
 * Put one person's favourites in this order: `ids` first, as given, then every favourite of theirs not in it, in the
 * order it was listed in -- one the page could not show (an 18+ one under Hide 18+) keeps its place among the rest
 * rather than jumping to the front. An id that is not their favourite is nothing. Answers how many were placed.
 * Reintroduce by placing only the ids given: "a favourite the sheet did not show keeps its place after the ones it
 * did" in favoritesOrder.int.test.ts finds it first.
 */
export async function orderFavorites(userId: string, ids: readonly string[]): Promise<number> {
  const want = [...new Set(ids)];
  const rows = await q(
    `WITH want AS (SELECT x.id, x.pos FROM unnest($2::text[]) WITH ORDINALITY AS x(id, pos)),
          ranked AS (
            SELECT f.series_id, row_number() OVER (ORDER BY (w.pos IS NULL), w.pos, ${favoriteOrder('f')}) AS n
              FROM favorites f LEFT JOIN want w ON w.id = f.series_id
             WHERE f.user_id = $1
          )
     UPDATE favorites f SET position = r.n FROM ranked r
      WHERE f.user_id = $1 AND f.series_id = r.series_id
     RETURNING 1`,
    [userId, want],
  );
  return rows.length;
}
