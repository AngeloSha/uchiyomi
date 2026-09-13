// The sources a series is read from: the primary pair on lib_series, then the extras in series_sources.
//
// One shape for both, because the series page and the follow/unfollow routes have to agree on it -- the
// page seeds its list from GET /api/series/:id and replaces it with what the admin route returns after a
// change, and two hand-written versions of "primary first, then the followers" would drift the first time
// one gained a field. The primary is a row on lib_series and not on series_sources on purpose: everything
// that routes a series (updater, fill, "check for new") reads source_id there, and moving it would touch all
// of them for no gain.
import { q, one } from './db';
import { getSource } from './sources';

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
}

const iso = (v: string | Date | null | undefined): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

/** Primary first (when the series has one), then the followers in the order they were added. */
export async function seriesSourcesFor(seriesId: string): Promise<SeriesSource[]> {
  const s = await one<{ source_id: string | null; source_series_id: string | null; source_checked_at: string | null; source_chapters: number | null }>(
    'SELECT source_id, source_series_id, source_checked_at, source_chapters FROM lib_series WHERE id = $1',
    [seriesId],
  );
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
    });
  }
  const extras = await q<{ source_id: string; source_series_id: string; checked_at: string | null; chapters: number | null }>(
    'SELECT source_id, source_series_id, checked_at, chapters FROM series_sources WHERE series_id = $1 ORDER BY created_at, source_id',
    [seriesId],
  );
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
    });
  }
  return out;
}
