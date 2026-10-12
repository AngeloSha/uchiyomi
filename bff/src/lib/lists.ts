// A person's Lists (the `collections` tables), read in one place (v0.61.0): the Lists routes (routes/personal.ts) and the
// OPDS shelves (routes/opds.ts) both answer from here, so a list reads the same in the app and in an e-reader.
import { q, one } from './db';
import { content } from './backend';
import { browsableIds, type ViewCtx } from './visibility';

export interface ListRow {
  id: string;
  user_id: string;
  name: string;
  accent: string | null;
  sort_order: number;
}

/** A list id is a uuid: anything else names no list. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One list the caller may read, or null. A malformed id is no list -- a 404 -- rather than the uuid cast error it was,
 * which answered 500.
 */
export async function listFor(uid: string, id: string): Promise<ListRow | null> {
  if (!UUID.test(id)) return null;
  return one<ListRow>('SELECT id, user_id, name, accent, sort_order FROM collections WHERE id = $1 AND user_id = $2', [id, uid]);
}

/** The caller's lists, in their order, each with how many series it holds. */
export async function listsFor(uid: string): Promise<Array<ListRow & { item_count: number }>> {
  return q(
    `SELECT c.id, c.name, c.accent, c.sort_order,
            (SELECT count(*) FROM collection_items ci WHERE ci.collection_id = c.id) AS item_count
     FROM collections c WHERE c.user_id = $1 ORDER BY c.sort_order, c.created_at`,
    [uid],
  );
}

/**
 * A list's series as this viewer may see them, in the list's own order: `size` of them from `page` on (all of them
 * without `size`), and how many there are in all.
 *
 * A list is a listing like any other, so a title in an 18+ library stays out of it while hidden. Nothing is removed
 * from the list itself -- reordering and membership are untouched.
 */
export async function listItems(list: ListRow, ctx: ViewCtx, page = 0, size?: number): Promise<{ items: any[]; total: number }> {
  const ids = (
    await q<{ series_id: string }>('SELECT series_id FROM collection_items WHERE collection_id = $1 ORDER BY position', [list.id])
  ).map((r) => r.series_id);
  const shown = await browsableIds(ids, ctx);
  const visibleIds = ids.filter((sid) => shown.has(sid));
  const slice = size == null ? visibleIds : visibleIds.slice(page * size, (page + 1) * size);
  const items = (await Promise.all(slice.map((sid) => content.series(ctx, sid).catch(() => null)))).filter(Boolean);
  return { items, total: visibleIds.length };
}
