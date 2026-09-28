// Which series a Find other sources run over ONE source is about (v0.49.1): every series the viewer may see whose
// MAIN source it is -- the "aqua is down" case, where the source is the one that stopped answering.
//
// A module of its own, with nothing but the database and the visibility rule behind it, because two places must
// say the same number: the run's scope (lib/findSources.ts) and the count Health puts beside the button on a
// failing source (lib/health.ts). health.ts cannot import the run -- the run refreshes the Health summary, which
// runs health.ts -- and a copy of the query in each would drift.
import { q } from './db';
import { visible, Params, SYSTEM_CTX, type ViewCtx } from './visibility';

/**
 * The series whose main source is `sourceId`, as this viewer may see them (an admin sees every series that is not
 * hidden or merged away), with their titles. Ordered for the run: the series that follow nothing come first --
 * they are the ones the dead source has frozen -- then by title.
 */
export async function seriesOfMainSource(sourceId: string, ctx: ViewCtx = SYSTEM_CTX): Promise<Array<{ id: string; title: string }>> {
  const p = new Params();
  const src = p.add(sourceId);
  return q<{ id: string; title: string }>(
    `SELECT s.id, COALESCE(o.title, s.title) AS title
       FROM lib_series s LEFT JOIN series_overrides o ON o.series_id = s.id
      WHERE s.source_id = ${src} AND ${visible('s', ctx, p)}
      ORDER BY (SELECT count(*) FROM series_sources ss WHERE ss.series_id = s.id AND ss.source_id <> s.source_id),
               lower(COALESCE(o.title, s.title)), s.id`,
    p.values as any[],
  );
}

/** How many series each of these sources is the main source of: seriesOfMainSource's count, for every id at once. */
export async function mainSourceCounts(sourceIds: readonly string[], ctx: ViewCtx = SYSTEM_CTX): Promise<Map<string, number>> {
  if (!sourceIds.length) return new Map();
  const p = new Params();
  const ids = p.add([...new Set(sourceIds)]);
  const rows = await q<{ source_id: string; n: number }>(
    `SELECT s.source_id, count(*)::int AS n FROM lib_series s
      WHERE s.source_id = ANY(${ids}) AND ${visible('s', ctx, p)} GROUP BY s.source_id`,
    p.values as any[],
  );
  return new Map(rows.map((r) => [r.source_id, Number(r.n)]));
}

/**
 * The admin's selection, as this viewer may see it, in the order given: an id that is hidden, merged away or not a
 * series is dropped, and a repeated one counted once.
 */
export async function seriesByIds(ids: readonly string[], ctx: ViewCtx = SYSTEM_CTX): Promise<Array<{ id: string; title: string }>> {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return [];
  const p = new Params();
  const arr = p.add(list);
  return q<{ id: string; title: string }>(
    `SELECT s.id, COALESCE(o.title, s.title) AS title
       FROM lib_series s LEFT JOIN series_overrides o ON o.series_id = s.id
      WHERE s.id = ANY(${arr}) AND ${visible('s', ctx, p)}
      ORDER BY array_position(${arr}::text[], s.id)`,
    p.values as any[],
  );
}
