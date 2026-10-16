// Fill in what a series is missing -- a description, genres, an author, and for a series with no chapters yet a cover --
// from AniList and from the other sources the series is attached to (v0.73.0). @Squeaks72's two ideas, rebuilt on the
// house's parts: #257 asked the series' own source, then the ones it follows; #245 asked Kitsu and MangaUpdates by title,
// and is ported AniList-first here, as one batched request by id for series already linked there.
//
// WHERE IT GOES. Its own layer, series_auto_details, BELOW the scan (lib/autoDetailsSql.ts): read only where the series'
// own value (lib_series, what its files or its source said) and an admin's edit (series_overrides) are both empty. The
// first version wrote into series_overrides, the admin's layer, where it shadowed every better description a later scan
// brought, refilled a genre list an admin had cleared on purpose (`{}`), and could change what the 18+ switch hides.
// Here a scan that brings real data wins by itself, an admin's edit wins over everything, and the 18+ filter judges the
// genres a series shows, filled-in ones included (visibility.ts browsable).
//
// WHEN. The nightly repair's ninth step (lib/repair.ts stepDetails), and only when an admin switches on Admin ->
// Settings -> Fill in missing details (server_settings.fill_details, off by default): asking sources for series is
// traffic to sites, and AniList descriptions are English text. Like borrowing chapter names (lib/borrowNames.ts):
//   - AniList first, for series linked there (a checked link, as the scores use) in a library whose AniList lookups are
//     on -- the per-library switch already says "art and metadata" -- and in English, the language AniList writes in.
//     Fifty series a request, a few requests a night at most (ANILIST_DETAILS_MAX);
//   - then the sources, for at most REPAIR_DETAILS_MAX series a night that are kept updated (auto_update, re-checked
//     per series as seriesIsMonitored), each asked of its own source and then the ones it follows in the series'
//     language, only while a source is usable (not off, failing or cooling down: lib/sourceStanding.ts, then blockedNow
//     right before the lookup), each lookup bounded by the source's own budget and the series by DETAILS_WALL_MS;
//   - a series is asked again only after DETAILS_RETRY_MS (sources_at, anilist_at), so one that nobody can describe is
//     not asked every night;
//   - a manual follow (POST /api/admin/series/:id/sources) asks at once, past the stamp: the new source may have it.
// Text goes through cleanDescription and cleanGenres, as an add does. Switching it off deletes the layer, and puts back
// any cover it set that is still the one it set (clearAutoDetails).
import { q, one } from './db';
import { getSource } from './sources';
import type { SourceSeries } from './sources/types';
import { budgetFor } from './sources/budget';
import { bounded } from './autoFollow';
import { blockedNow } from './sourceHealth';
import { standingsOf } from './sourceStanding';
import { cleanDescription } from './htmlText';
import { cleanGenres } from './genres';
import { visibleToAll } from './visibility';
import { effectiveLang, seriesLanguage } from './seriesLang';
import { baseLang, sameLanguage } from './lang';
import { fetchAniListDetails } from './anilist';
import { runtime } from './runtime';
import { AUTO_DETAILS } from './autoDetailsSql';

type Log = { info: (m: string) => void; warn: (m: string) => void };

/** A series that was asked, and still lacks something, is asked again after this. Descriptions rarely appear later. */
export const DETAILS_RETRY_MS = 30 * 24 * 3600_000;
/** One source's lookup, before budgetFor raises it for a source behind the solver. */
const DETAILS_LOOKUP_MS = 20_000;
/** The whole of one series: no more sources are asked about it after this. */
const DETAILS_WALL_MS = 60_000;
/** Series one night asks AniList about: ten requests at most. */
export const ANILIST_DETAILS_MAX = 500;
/** The longest author name kept: a field, not a paragraph. */
const AUTHOR_MAX = 200;

export type DetailField = 'summary' | 'genres' | 'author' | 'cover';
export interface DetailsFill {
  /** The fields filled in, in the order they were. */
  filled: DetailField[];
  /** Where from: 'anilist', or the source ids that gave something. */
  from: string[];
  /** Sources asked (a lookup started). */
  asked: number;
}

/**
 * SQL over `s` (lib_series), `o` (series_overrides), `m` (series_auto_details) and `a` (series_art): what a series lacks.
 * An admin's edit counts as having it, cleared genres (`{}`) included; a value only in this layer counts as having it.
 * A cover is only looked for while the series has no live chapter -- after that its first page is its cover.
 */
const LACKS: Record<DetailField, string> = {
  summary: `(o.summary IS NULL AND btrim(COALESCE(s.summary, '')) = '' AND btrim(COALESCE(m.summary, '')) = '')`,
  genres: `(o.genres IS NULL AND COALESCE(cardinality(s.genres), 0) = 0 AND COALESCE(cardinality(m.genres), 0) = 0)`,
  author: `(o.author IS NULL AND btrim(COALESCE(s.author, '')) = '' AND btrim(COALESCE(m.author, '')) = '')`,
  cover: `(o.cover IS NULL AND COALESCE(a.cover, '') = ''
           AND NOT EXISTS (SELECT 1 FROM lib_books b WHERE b.series_id = s.id AND b.pruned_at IS NULL))`,
};
const JOINS = `LEFT JOIN series_overrides o ON o.series_id = s.id
  LEFT JOIN ${AUTO_DETAILS} m ON m.series_id = s.id
  LEFT JOIN series_art a ON a.series_id = s.id`;
const LACKS_ANY = `(${LACKS.summary} OR ${LACKS.genres} OR ${LACKS.author} OR ${LACKS.cover})`;

type Lacks = Record<DetailField, boolean>;
const anyOf = (l: Lacks) => l.summary || l.genres || l.author || l.cover;

/** Whether an admin switched it on (server_settings.fill_details). A read that fails is off. */
export async function fillDetailsOn(): Promise<boolean> {
  const r = await one<{ on: boolean }>('SELECT fill_details AS "on" FROM server_settings WHERE id = 1').catch(() => null);
  return r?.on === true;
}

/** What one series lacks now, or null when it is not there (deleted, merged away). */
async function lacksOf(seriesId: string): Promise<Lacks | null> {
  return one<Lacks>(
    `SELECT ${LACKS.summary} AS summary, ${LACKS.genres} AS genres, ${LACKS.author} AS author, ${LACKS.cover} AS cover
       FROM lib_series s ${JOINS}
      WHERE s.id = $1 AND ${visibleToAll('s')}`, [seriesId]);
}

/**
 * Write what `got` gives for the fields `lacks` names, each only into an empty slot of this layer (never over a value it
 * already holds), marked with where it came from. Answers the fields written; `lacks` is updated in place.
 */
async function store(seriesId: string, lacks: Lacks, got: { summary?: string; genres?: string[]; author?: string; cover?: string }, from: string): Promise<DetailField[]> {
  const out: DetailField[] = [];
  if (lacks.summary && got.summary) {
    await q(`INSERT INTO ${AUTO_DETAILS} (series_id, summary, summary_from) VALUES ($1, $2, $3)
             ON CONFLICT (series_id) DO UPDATE SET summary = EXCLUDED.summary, summary_from = EXCLUDED.summary_from, updated_at = now()
             WHERE ${AUTO_DETAILS}.summary IS NULL`, [seriesId, got.summary, from]);
    lacks.summary = false; out.push('summary');
  }
  if (lacks.genres && got.genres?.length) {
    await q(`INSERT INTO ${AUTO_DETAILS} (series_id, genres, genres_from) VALUES ($1, $2::text[], $3)
             ON CONFLICT (series_id) DO UPDATE SET genres = EXCLUDED.genres, genres_from = EXCLUDED.genres_from, updated_at = now()
             WHERE COALESCE(cardinality(${AUTO_DETAILS}.genres), 0) = 0`, [seriesId, got.genres, from]);
    lacks.genres = false; out.push('genres');
  }
  if (lacks.author && got.author) {
    await q(`INSERT INTO ${AUTO_DETAILS} (series_id, author, author_from) VALUES ($1, $2, $3)
             ON CONFLICT (series_id) DO UPDATE SET author = EXCLUDED.author, author_from = EXCLUDED.author_from, updated_at = now()
             WHERE ${AUTO_DETAILS}.author IS NULL`, [seriesId, got.author, from]);
    lacks.author = false; out.push('author');
  }
  if (lacks.cover && got.cover) {
    // The automatic cover (series_art), as an add stores its source's: below any cover an admin chose, and only into an
    // empty slot. Recorded here too, so switching this off takes back exactly this cover and nothing found otherwise.
    const set = await q(`INSERT INTO series_art (series_id, cover, checked_at) VALUES ($1, $2, NULL)
                         ON CONFLICT (series_id) DO UPDATE SET cover = EXCLUDED.cover WHERE COALESCE(series_art.cover, '') = ''
                         RETURNING series_id`, [seriesId, got.cover]);
    if (set.length) {
      await q(`INSERT INTO ${AUTO_DETAILS} (series_id, cover, cover_from) VALUES ($1, $2, $3)
               ON CONFLICT (series_id) DO UPDATE SET cover = EXCLUDED.cover, cover_from = EXCLUDED.cover_from, updated_at = now()`,
      [seriesId, got.cover, from]);
      out.push('cover');
    }
    lacks.cover = false;
  }
  return out;
}

/** What one source's answer gives, cleaned as an add cleans it (routes/sources.ts addSeriesFromSource). */
function fromSource(info: SourceSeries): { summary?: string; genres?: string[]; author?: string; cover?: string } {
  const summary = cleanDescription(info.summary);
  const genres = cleanGenres(info.genres);
  const author = typeof info.author === 'string' ? info.author.replace(/\s+/g, ' ').trim().slice(0, AUTHOR_MAX) : '';
  const cover = typeof info.coverUrl === 'string' && /^https?:\/\//i.test(info.coverUrl.trim()) ? info.coverUrl.trim() : '';
  return { ...(summary ? { summary } : {}), ...(genres.length ? { genres } : {}), ...(author ? { author } : {}), ...(cover ? { cover } : {}) };
}

/**
 * Ask the series' own source, then the sources it follows in its language, for what it lacks, in that order, until
 * nothing is missing. Never throws; stamps `sources_at` whatever it found, so the nightly waits DETAILS_RETRY_MS before
 * asking about this series again (the manual follow does not wait).
 */
export async function fillDetailsFromSources(seriesId: string, log?: Log): Promise<DetailsFill> {
  const out: DetailsFill = { filled: [], from: [], asked: 0 };
  try {
    const lacks = await lacksOf(seriesId);
    if (!lacks || !anyOf(lacks)) return out;
    const s = await one<{ source_id: string | null; source_series_id: string | null }>(
      'SELECT source_id, source_series_id FROM lib_series WHERE id = $1', [seriesId]);
    const followers = await q<{ source_id: string; source_series_id: string }>(
      `SELECT source_id, source_series_id FROM series_sources
        WHERE series_id = $1 AND source_id IS DISTINCT FROM $2 ORDER BY created_at, source_id`, [seriesId, s?.source_id ?? null]);
    // A follower in another language would describe the series in that language (and a source in every language could
    // in any): the series' own language only, by the follow guard's rule (lib/lang.ts sameLanguage).
    const lang = await seriesLanguage(seriesId);
    const asks = [
      ...(s?.source_id && s.source_series_id ? [{ source_id: s.source_id, source_series_id: s.source_series_id }] : []),
      ...followers.filter((f) => sameLanguage(lang.lang, getSource(f.source_id)?.lang, { exact: lang.sameBaseSibling })),
    ];
    const standing = await standingsOf(asks.map((a) => a.source_id));
    const started = Date.now();
    for (const a of asks) {
      if (!anyOf(lacks) || runtime.stopping || Date.now() - started > DETAILS_WALL_MS) break;
      const src = getSource(a.source_id);
      // Usable only: never one switched off, failing at a step an update needs, or cooling down -- and the cooldown
      // asked again right before the lookup, since a sweep may have started one since.
      if (!src || standing.get(a.source_id) !== 'usable') continue;
      if (await blockedNow(a.source_id).then(Boolean, () => true)) continue;
      out.asked++;
      let info: SourceSeries | null = null;
      try {
        info = await bounded(src.getSeries(a.source_series_id), budgetFor(src, DETAILS_LOOKUP_MS));
      } catch {
        // A source that did not answer is one that did not answer: nothing here reports it, so a lookup for a
        // description can never put a series' own source into a cooldown (lib/borrowNames.ts says why).
        continue;
      }
      if (!info) continue;
      const got = await store(seriesId, lacks, fromSource(info), a.source_id);
      if (got.length) { out.filled.push(...got); out.from.push(a.source_id); }
    }
  } catch (e) {
    log?.warn(`details: ${seriesId}: ${(e as Error)?.message || e}`);
  } finally {
    await q(`INSERT INTO ${AUTO_DETAILS} (series_id, sources_at) SELECT id, now() FROM lib_series WHERE id = $1
             ON CONFLICT (series_id) DO UPDATE SET sources_at = now()`, [seriesId]).catch(() => {});
  }
  return out;
}

/** What one night's AniList pass did: series asked about (in one batch, fifty a request), and series given something. */
export interface AniListDetailsOutcome { asked: number; filled: number }

/**
 * AniList, for the series linked there that lack a description or genres: one batched request by id per fifty
 * (lib/anilist.ts fetchAniListDetails), never a search. Only a checked link (a person made it, or the online-match check
 * confirmed it -- as lib/anilistScores.ts reads them), only in a library whose AniList lookups are on, and only for a
 * series in English: AniList writes in English, and a French series is better left empty than described in another
 * language. A series considered is stamped `anilist_at` whatever AniList said; a failed request stamps nothing and
 * throws, so the step says so and the next night asks again.
 */
export async function fillDetailsFromAniList(max = ANILIST_DETAILS_MAX): Promise<AniListDetailsOutcome> {
  const rows = await q<{ id: string; lang: string | null; source_id: string | null; anilist_id: string; summary: boolean; genres: boolean }>(
    `SELECT s.id, s.lang, s.source_id, t.external_id AS anilist_id,
            ${LACKS.summary} AS summary, ${LACKS.genres} AS genres
       FROM lib_series s
       JOIN libraries l ON l.id = s.library_id AND l.anilist_lookup
       JOIN series_trackers t ON t.series_id = s.id AND t.provider = 'anilist'
                             AND (t.linked_by IS NOT NULL OR t.checked_at IS NOT NULL) AND t.external_id ~ '^[0-9]{1,10}$'
       ${JOINS}
      WHERE ${visibleToAll('s')} AND (${LACKS.summary} OR ${LACKS.genres})
        AND (m.anilist_at IS NULL OR m.anilist_at < now() - ($1::bigint * interval '1 millisecond'))
      ORDER BY m.anilist_at NULLS FIRST, s.id
      LIMIT $2`,
    [DETAILS_RETRY_MS, max],
  );
  if (!rows.length) return { asked: 0, filled: 0 };
  const english = rows.filter((r) => baseLang(effectiveLang(r.lang, r.source_id)) === 'en');
  const got = english.length ? await fetchAniListDetails(english.map((r) => Number(r.anilist_id))) : new Map();
  let filled = 0;
  for (const r of english) {
    const d = got.get(Number(r.anilist_id));
    if (!d) continue;
    const wrote = await store(r.id, { summary: r.summary, genres: r.genres, author: false, cover: false }, {
      ...(cleanDescription(d.description) ? { summary: cleanDescription(d.description) } : {}),
      ...(cleanGenres(d.genres).length ? { genres: cleanGenres(d.genres) } : {}),
    }, 'anilist');
    if (wrote.length) filled++;
  }
  // Every series considered, the ones in another language too: each waits DETAILS_RETRY_MS before it is looked at again,
  // so a library full of French series cannot keep the English ones from their turn.
  await q(`INSERT INTO ${AUTO_DETAILS} (series_id, anilist_at) SELECT id, now() FROM lib_series WHERE id = ANY($1::text[])
           ON CONFLICT (series_id) DO UPDATE SET anilist_at = now()`, [rows.map((r) => r.id)]);
  return { asked: english.length, filled };
}

/**
 * The series one night asks their sources about: kept updated, attached to a source, lacking something, and not asked
 * within DETAILS_RETRY_MS -- never asked first, then the longest ago, then the most recently updated.
 */
export async function seriesLackingDetails(limit: number): Promise<Array<{ id: string; title: string }>> {
  return q<{ id: string; title: string }>(
    `SELECT s.id, s.title FROM lib_series s ${JOINS}
      WHERE ${visibleToAll('s')} AND s.auto_update
        AND (s.source_id IS NOT NULL OR EXISTS (SELECT 1 FROM series_sources f WHERE f.series_id = s.id))
        AND ${LACKS_ANY}
        AND (m.sources_at IS NULL OR m.sources_at < now() - ($1::bigint * interval '1 millisecond'))
      ORDER BY m.sources_at NULLS FIRST, s.latest_mtime DESC NULLS LAST, s.id
      LIMIT $2`,
    [DETAILS_RETRY_MS, limit],
  );
}

/**
 * Switched off: take back everything this layer added. Its rows go -- descriptions, genres and authors with them, so every
 * series shows exactly what it showed before -- and a cover it put in series_art is cleared where it is still the one it
 * put there (one found or set since is left alone). Answers how many series had something.
 */
export async function clearAutoDetails(): Promise<number> {
  await q(`UPDATE series_art a SET cover = NULL FROM ${AUTO_DETAILS} d
            WHERE d.series_id = a.series_id AND d.cover IS NOT NULL AND a.cover = d.cover`);
  // The stamps go too: switched on again, every series is asked again.
  const gone = await q<{ had: boolean }>(
    `DELETE FROM ${AUTO_DETAILS}
     RETURNING (summary IS NOT NULL OR genres IS NOT NULL OR author IS NOT NULL OR cover IS NOT NULL) AS had`);
  return gone.filter((r) => r.had).length;
}
