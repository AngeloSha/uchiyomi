// A person's Lists (the `collections` tables), read in one place (v0.61.0): the Lists routes (routes/personal.ts) and the
// OPDS shelves (routes/opds.ts) both answer from here, so a list reads the same in the app and in an e-reader.
//
// Two kinds since v0.61.0, fixed when a list is made: hand-picked (`query` NULL, the series in collection_items) and
// smart (`query` a saved Library search, lib/smartLists.ts). And a list may be shared with the household: read-only
// for everyone else (the owner's ruling), and listed to a member only when it shows them at least one series they may
// open. Everything a list shows is per VIEWER -- their libraries, age cap and 18+ switch, their reading -- whoever made
// it: a shared list can never show a member a series they could not have found themselves.
import { q, one } from './db';
import { content } from './backend';
import { Params, browsable, browsableIds, type ViewCtx } from './visibility';
import { evaluate, parseQuery, type SmartQuery } from './smartLists';

export interface ListRow {
  id: string;
  user_id: string;
  name: string;
  accent: string | null;
  sort_order: number;
  /** A smart list's saved search; null for a list picked by hand. */
  query: unknown | null;
  shared: boolean;
}

export type ListKind = 'manual' | 'smart';
export const kindOf = (l: Pick<ListRow, 'query'>): ListKind => (l.query == null ? 'manual' : 'smart');

/** Who made a list someone else is reading. */
export interface ListOwner { id: string; name: string; avatar: unknown }

/** A list as GET /api/collections?scope=all and the OPDS root describe it. */
export interface ListSummary {
  id: string;
  name: string;
  accent: string | null;
  sort_order: number;
  /** How many series it shows THIS viewer. */
  item_count: number;
  kind: ListKind;
  shared: boolean;
  mine: boolean;
  /** Someone else's list: whose. */
  owner?: ListOwner;
  /** The owner's own smart list: its search, for Edit filters. Never sent to anyone else. */
  query?: SmartQuery;
  /**
   * Its first series this viewer may see, at most PREVIEW of them, in the list's own order: the covers its card shows
   * (UI refresh). `all` scope only; absent from a server older than this.
   */
  preview?: string[];
}

/** How many covers a list's card shows. */
export const PREVIEW = 4;

const COLS = 'c.id, c.user_id, c.name, c.accent, c.sort_order, c.query, c.shared';

/** A list id is a uuid: anything else names no list. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One list the caller may READ -- their own, or one shared with the household -- or null. A malformed id is no list (a
 * 404) rather than the uuid cast error it was, which answered 500. Another member's private list is null too: whether
 * an id exists is not theirs to learn.
 */
export async function listFor(uid: string, id: string): Promise<ListRow | null> {
  // Reintroduce by dropping this: "another account's private list, and a malformed id, are 404" in lists.int.test.ts
  // reads 500.
  if (!UUID.test(id)) return null;
  return one<ListRow>(`SELECT ${COLS} FROM collections c WHERE c.id = $1 AND (c.user_id = $2 OR c.shared)`, [id, uid]);
}

/** One list the caller may CHANGE: their own. A shared list is read-only for everyone else, so it answers null. */
export async function ownListFor(uid: string, id: string): Promise<ListRow | null> {
  if (!UUID.test(id)) return null;
  return one<ListRow>(`SELECT ${COLS} FROM collections c WHERE c.id = $1 AND c.user_id = $2`, [id, uid]);
}

/**
 * How many of each hand-picked list's series this viewer may see, and the first PREVIEW of them in the list's order
 * (its card's covers), in one query.
 */
async function manualCounts(ids: string[], ctx: ViewCtx): Promise<Map<string, { n: number; preview: string[] }>> {
  if (!ids.length) return new Map();
  const p = new Params();
  const rows = await q<{ id: string; n: number; preview: string[] | null }>(
    `SELECT ci.collection_id AS id, count(*)::int AS n,
            (array_agg(ci.series_id ORDER BY ci.position, ci.series_id))[1:${PREVIEW}] AS preview
       FROM collection_items ci JOIN lib_series s ON s.id = ci.series_id AND ${browsable('s', ctx, p)}
      WHERE ci.collection_id = ANY(${p.add(ids)}) GROUP BY ci.collection_id`,
    p.values as any[],
  );
  return new Map(rows.map((r) => [r.id, { n: r.n, preview: r.preview ?? [] }]));
}

/**
 * The lists the caller may read.
 *
 * `manual`: their own hand-picked lists with the stored count, exactly what GET /api/collections answered before
 * v0.61.0 -- the series page's "Add to collection" sheet offers these, and an older client reads them.
 *
 * `all`: their own lists of both kinds, then the household's shared ones, each counted for THIS viewer (the series they
 * may see; the count used to include titles the 18+ switch hides). Someone else's shared list that shows them nothing is
 * left out: it would be a name and nothing behind it, and a list of what another member keeps is not theirs to see.
 */
export async function listsFor(uid: string, ctx: ViewCtx, scope: 'manual' | 'all'): Promise<ListSummary[]> {
  if (scope === 'manual') {
    const rows = await q<ListRow & { item_count: string | number }>(
      `SELECT c.id, c.name, c.accent, c.sort_order,
              (SELECT count(*) FROM collection_items ci WHERE ci.collection_id = c.id) AS item_count
       FROM collections c WHERE c.user_id = $1 AND c.query IS NULL ORDER BY c.sort_order, c.created_at`,
      [uid],
    );
    return rows as any;
  }
  const rows = await q<ListRow & { owner_name: string | null; owner_username: string | null; owner_avatar: unknown }>(
    `SELECT ${COLS}, u.display_name AS owner_name, u.username AS owner_username, u.avatar AS owner_avatar
       FROM collections c JOIN users u ON u.id = c.user_id
      WHERE c.user_id = $1 OR c.shared
      ORDER BY (c.user_id = $1) DESC, c.sort_order, c.created_at`,
    [uid],
  );
  const counts = await manualCounts(rows.filter((r) => kindOf(r) === 'manual').map((r) => r.id), ctx);
  const out: ListSummary[] = [];
  for (const r of rows) {
    const mine = r.user_id === uid;
    const kind = kindOf(r);
    let n = 0;
    let preview: string[] = [];
    if (kind === 'manual') ({ n, preview } = counts.get(r.id) ?? { n: 0, preview: [] });
    else {
      const query = parseQuery(r.query);
      if (query) {
        // The same search the count needed, asked for its first PREVIEW series rather than one.
        const res = await evaluate(ctx, query, 0, PREVIEW);
        n = res.totalElements;
        preview = res.content.map((x: { id: string }) => x.id);
      }
    }
    // Reintroduce by keeping it: "a shared list that shows a member nothing is left out for them" in lists.int.test.ts
    // finds it listed with 0.
    if (!mine && n === 0) continue;
    const query = mine && kind === 'smart' ? parseQuery(r.query) : null;
    out.push({
      id: r.id, name: r.name, accent: r.accent, sort_order: r.sort_order, item_count: n, kind, shared: r.shared, mine, preview,
      ...(mine ? {} : { owner: { id: r.user_id, name: r.owner_name || r.owner_username || '', avatar: r.owner_avatar ?? null } }),
      ...(query ? { query } : {}),
    });
  }
  return out;
}

/**
 * A list's series as this viewer may see them, and how many there are in all: `size` of them from `page` on (every one
 * without `size`, for a hand-picked list).
 *
 * Hand-picked: the list's own order, a title the viewer may not see left out -- nothing is removed from the list
 * itself; reordering and membership are untouched. Smart: the Library's search for the viewer (lib/smartLists.ts), in
 * the list's own order; `size` is required, a smart list may match the whole library. A stored search that no longer
 * reads as one shows nothing rather than everything.
 */
export async function listItems(list: ListRow, ctx: ViewCtx, page = 0, size?: number): Promise<{ items: any[]; total: number }> {
  if (kindOf(list) === 'smart') {
    const query = parseQuery(list.query);
    if (!query) return { items: [], total: 0 };
    const res = await evaluate(ctx, query, page, size ?? 200);
    return { items: res.content, total: res.totalElements };
  }
  const ids = (
    await q<{ series_id: string }>('SELECT series_id FROM collection_items WHERE collection_id = $1 ORDER BY position', [list.id])
  ).map((r) => r.series_id);
  const shown = await browsableIds(ids, ctx);
  const visibleIds = ids.filter((sid) => shown.has(sid));
  const slice = size == null ? visibleIds : visibleIds.slice(page * size, (page + 1) * size);
  const items = (await Promise.all(slice.map((sid) => content.series(ctx, sid).catch(() => null)))).filter(Boolean);
  return { items, total: visibleIds.length };
}

/** Who made a list, for a reader of someone else's. */
export async function ownerOf(list: ListRow): Promise<ListOwner> {
  const u = await one<{ display_name: string | null; username: string | null; avatar: unknown }>(
    'SELECT display_name, username, avatar FROM users WHERE id = $1', [list.user_id]);
  return { id: list.user_id, name: u?.display_name || u?.username || '', avatar: u?.avatar ?? null };
}
