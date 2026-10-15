// Fill what a series is missing (description, genres, author, cover) from the other sources it is attached to.
//
// A series is scanned from its files, which carry what its main source gave when they were written. A series with a
// follower source -- or a main source that never described it -- can be missing a field another attached source
// has. Only EMPTY fields are filled; nothing already set (by a scan, a source, or a person) is ever replaced.
// Text goes to series_overrides, the one place a scan does not overwrite; a cover goes to series_art.cover (the
// automatic cover, below any cover a person chose).
import { one, q } from './db';
import { visibleToAll } from './visibility';
import { getSource } from './sources';
import { bounded } from './autoFollow';
import { isDisabled } from './sourceHealth';

const LOOKUP_MS = 20_000;

export interface FillResult { filled: Array<'summary' | 'genres' | 'author' | 'cover'>; from: string[]; tried: number }

interface Have { summary: boolean; genres: boolean; author: boolean; cover: boolean }

async function whatIsMissing(seriesId: string): Promise<Have | null> {
  const r = await one<{ summary: boolean; genres: boolean; author: boolean; cover: boolean }>(
    `SELECT COALESCE(NULLIF(btrim(o.summary), ''), NULLIF(btrim(s.summary), '')) IS NULL AS summary,
            COALESCE(cardinality(COALESCE(NULLIF(o.genres, '{}'::text[]), s.genres)), 0) = 0 AS genres,
            COALESCE(NULLIF(btrim(o.author), ''), NULLIF(btrim(s.author), '')) IS NULL AS author,
            (COALESCE(o.cover, '') = '' AND COALESCE(a.cover, '') = ''
              AND NOT EXISTS (SELECT 1 FROM lib_books b WHERE b.series_id = s.id AND b.pruned_at IS NULL)) AS cover
       FROM lib_series s
       LEFT JOIN series_overrides o ON o.series_id = s.id
       LEFT JOIN series_art a ON a.series_id = s.id
      WHERE s.id = $1 AND ${visibleToAll('s')}`, [seriesId]);
  return r ?? null;
}

/** Fill the series' empty fields from its attached sources, in order (main first). Never throws. */
export async function fillMissingMeta(seriesId: string): Promise<FillResult> {
  const out: FillResult = { filled: [], from: [], tried: 0 };
  try {
    const miss = await whatIsMissing(seriesId);
    if (!miss || !(miss.summary || miss.genres || miss.author || miss.cover)) return out;
    const main = await one<{ source_id: string | null; source_series_id: string | null }>(
      'SELECT source_id, source_series_id FROM lib_series WHERE id = $1', [seriesId]);
    const followers = await q<{ source_id: string; source_series_id: string }>(
      'SELECT source_id, source_series_id FROM series_sources WHERE series_id = $1 ORDER BY created_at, source_id', [seriesId]);
    const where = [
      ...(main?.source_id && main.source_series_id ? [{ source_id: main.source_id, source_series_id: main.source_series_id }] : []),
      ...followers,
    ];
    for (const w of where) {
      if (!(miss.summary || miss.genres || miss.author || miss.cover)) break;
      const src = getSource(w.source_id);
      if (!src || (await isDisabled(w.source_id).catch(() => true))) continue;
      out.tried++;
      let info;
      try { info = await bounded(src.getSeries(w.source_series_id), LOOKUP_MS); } catch { continue; }
      if (!info) continue;
      const got: FillResult['filled'] = [];
      const summary = (info.summary ?? '').trim();
      const genres = (info.genres ?? []).map((g) => g.trim()).filter(Boolean);
      const author = (info.author ?? '').trim();
      if (miss.summary && summary) {
        await q(`INSERT INTO series_overrides (series_id, summary) VALUES ($1, $2)
                 ON CONFLICT (series_id) DO UPDATE SET summary = $2, updated_at = now()
                 WHERE NULLIF(btrim(series_overrides.summary), '') IS NULL`, [seriesId, summary]);
        miss.summary = false; got.push('summary');
      }
      if (miss.genres && genres.length) {
        await q(`INSERT INTO series_overrides (series_id, genres) VALUES ($1, $2::text[])
                 ON CONFLICT (series_id) DO UPDATE SET genres = $2::text[], updated_at = now()
                 WHERE COALESCE(cardinality(series_overrides.genres), 0) = 0`, [seriesId, genres]);
        miss.genres = false; got.push('genres');
      }
      if (miss.author && author) {
        await q(`INSERT INTO series_overrides (series_id, author) VALUES ($1, $2)
                 ON CONFLICT (series_id) DO UPDATE SET author = $2, updated_at = now()
                 WHERE NULLIF(btrim(series_overrides.author), '') IS NULL`, [seriesId, author]);
        miss.author = false; got.push('author');
      }
      if (miss.cover && info.coverUrl) {
        await q(`INSERT INTO series_art (series_id, cover, checked_at) VALUES ($1, $2, NULL)
                 ON CONFLICT (series_id) DO UPDATE SET cover = $2, checked_at = NULL
                 WHERE COALESCE(series_art.cover, '') = ''`, [seriesId, info.coverUrl]);
        miss.cover = false; got.push('cover');
      }
      if (got.length) { out.filled.push(...got); out.from.push(w.source_id); }
    }
  } catch (e) {
    console.warn(`[metaFill] ${seriesId}: ${(e as Error)?.message || e}`);
  }
  return out;
}

/** Series with something missing and a source to ask, for the nightly pass. */
export async function seriesMissingMeta(limit: number): Promise<string[]> {
  const rows = await q<{ id: string }>(
    `SELECT s.id FROM lib_series s
       LEFT JOIN series_overrides o ON o.series_id = s.id
       LEFT JOIN series_art a ON a.series_id = s.id
      WHERE ${visibleToAll('s')} AND (s.source_id IS NOT NULL OR EXISTS (SELECT 1 FROM series_sources f WHERE f.series_id = s.id))
        AND (COALESCE(NULLIF(btrim(o.summary), ''), NULLIF(btrim(s.summary), '')) IS NULL
          OR COALESCE(cardinality(COALESCE(NULLIF(o.genres, '{}'::text[]), s.genres)), 0) = 0
          OR (COALESCE(o.cover, '') = '' AND COALESCE(a.cover, '') = ''
              AND NOT EXISTS (SELECT 1 FROM lib_books b WHERE b.series_id = s.id AND b.pruned_at IS NULL)))
      ORDER BY random() LIMIT $1`, [limit]);
  return rows.map((r) => r.id);
}
