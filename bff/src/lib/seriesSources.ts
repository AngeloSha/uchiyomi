// The sources a series is read from: the primary pair on lib_series, then the extras in series_sources.
//
// One shape for both, because the series page and the follow/unfollow routes have to agree on it -- the
// page seeds its list from GET /api/series/:id and replaces it with what the admin route returns after a
// change, and two hand-written versions of "primary first, then the followers" would drift the first time
// one gained a field. The primary is a row on lib_series and not on series_sources on purpose: everything
// that routes a series (updater, fill, "check for new") reads source_id there. It moves in exactly one place,
// lib/mainSource.ts (v0.54.0): Make main and the Replace run, which swap a follower's row with the pair.
import { q, one } from './db';
import { getSource } from './sources';
import { standingOf, standingRows, type Standing } from './sourceStanding';

export interface SeriesSource {
  sourceId: string;
  /** The adapter's display name, or the id when the adapter is not loaded: an uninstalled one still has to be named. */
  name: string;
  sourceSeriesId: string;
  primary: boolean;
  checkedAt: string | null;
  chapters: number | null;
  /**
   * Whether the adapter is loaded right now. A follower whose extension was uninstalled keeps its row --
   * the updater skips it and the health page says so -- and the series page must be able to show it as
   * something the admin can remove, rather than silently dropping it from the list.
   */
  registered: boolean;
  /**
   * Followed by the add-time auto-follow rather than by a person (lib/autoFollow.ts). The sheet reads it
   * as "followed for you", which is the one thing a reader needs to know before pressing × on a source
   * nobody in the house chose. `added_by` has only ever been written as the admin who confirmed a plan,
   * so NULL is the automatic path -- the same convention as `series_trackers.linked_by`. A human
   * re-following the same source through a plan clears it (the follow route's COALESCE). Always false for
   * the primary: it was added, not followed.
   */
  auto: boolean;
  /**
   * v0.54.0: whether the series can be updated through it now (lib/sourceStanding.ts): `usable`, `cooling`, `failing`,
   * `off` or `not_loaded`. The Sources sheet says it, and offers Make main on a usable or cooling follower.
   */
  standing: Standing;
  /**
   * v0.81.0, for an automatic follow (`auto`): when it was followed, and what found it, from its audit row
   * (series.follow_source): `scout` (lib/sourceScout.ts: the series' sources could not get its chapters),
   * `failed_chapter`, `short_chapter` or `gap` (the sweep's hunt and the nightly repair, lib/sourceHunt.ts), or `add`
   * (the add's own "also follow" switch, which writes no reason). The sheet says it under the source, so a reader knows
   * why a source nobody in the house chose is there before pressing ×. Null on a person's follow, and on a follow older
   * than its audit row.
   */
  followedAt: string | null;
  foundFor: 'scout' | 'failed_chapter' | 'short_chapter' | 'gap' | 'add' | null;
  /**
   * v0.82.0: a source of a backup extension (lib/backupExtensions.ts) -- one Uchiyomi installed by itself to finish
   * downloads and removes again once nothing needs it. The sheet says so under it.
   */
  backup: boolean;
}

const iso = (v: string | Date | null | undefined): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

/** Primary first (when the series has one), then the followers in the order they were added. */
export async function seriesSourcesFor(seriesId: string): Promise<SeriesSource[]> {
  const s = await one<{ source_id: string | null; source_series_id: string | null; source_checked_at: string | null; source_chapters: number | null }>(
    'SELECT source_id, source_series_id, source_checked_at, source_chapters FROM lib_series WHERE id = $1',
    [seriesId],
  );
  const extras = await q<{ source_id: string; source_series_id: string; checked_at: string | null; chapters: number | null; added_by: string | null; created_at: string | null }>(
    'SELECT source_id, source_series_id, checked_at, chapters, added_by, created_at FROM series_sources WHERE series_id = $1 ORDER BY created_at, source_id',
    [seriesId],
  );
  // What found each automatic follow: the newest automatic audit row per source. Best effort -- a sheet never fails over
  // its history -- and read only when there is an automatic follow to explain.
  const reasons = extras.some((r) => r.added_by == null)
    ? new Map((await q<{ source: string; reason: string | null }>(
      `SELECT DISTINCT ON (detail->>'source') detail->>'source' AS source, detail->>'reason' AS reason
         FROM audit_log WHERE event = 'series.follow_source' AND detail->>'id' = $1 AND detail->>'auto' = 'true'
        ORDER BY detail->>'source', at DESC`, [seriesId]).catch(() => [])).map((r) => [r.source, r.reason] as const))
    : new Map<string, string | null>();
  const foundFor = (source: string): SeriesSource['foundFor'] => {
    if (!reasons.has(source)) return null;
    const why = reasons.get(source);
    return why === 'scout' || why === 'failed_chapter' || why === 'short_chapter' || why === 'gap' ? why : 'add';
  };
  const now = Date.now();
  const rows = await standingRows([...(s?.source_id ? [s.source_id] : []), ...extras.map((r) => r.source_id)]).catch(() => new Map());
  const standing = (id: string) => standingOf(id, rows.get(id), now);
  const out: SeriesSource[] = [];
  if (s?.source_id) {
    out.push({
      sourceId: s.source_id,
      name: getSource(s.source_id)?.name ?? s.source_id,
      sourceSeriesId: s.source_series_id ?? '',
      primary: true,
      checkedAt: iso(s.source_checked_at),
      chapters: s.source_chapters ?? null,
      registered: !!getSource(s.source_id),
      auto: false,
      standing: standing(s.source_id),
      followedAt: null,
      foundFor: null,
      backup: !!getSource(s.source_id)?.backup,
    });
  }
  for (const r of extras) {
    // A row that names the primary's own adapter would be listed twice; the follow route refuses it, but
    // a row written before that rule existed must not double the list.
    if (r.source_id === s?.source_id) continue;
    out.push({
      sourceId: r.source_id,
      name: getSource(r.source_id)?.name ?? r.source_id,
      sourceSeriesId: r.source_series_id,
      primary: false,
      checkedAt: iso(r.checked_at),
      chapters: r.chapters ?? null,
      registered: !!getSource(r.source_id),
      auto: r.added_by == null,
      standing: standing(r.source_id),
      followedAt: r.added_by == null ? iso(r.created_at) : null,
      foundFor: r.added_by == null ? foundFor(r.source_id) : null,
      backup: !!getSource(r.source_id)?.backup,
    });
  }
  return out;
}
