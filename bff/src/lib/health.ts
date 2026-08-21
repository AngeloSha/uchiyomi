// Library health checks.
//
// The point of this file is to tell the operator about problems they would otherwise only discover by
// opening a chapter and finding it broken. Every check here was written against the real library and
// tuned until it stopped producing false positives, because a health page that cries wolf gets ignored
// and is worse than no health page at all.
//
// Two traps found while building it, both preserved as comments where they bite:
//  * `lib_books.pages` is filled in lazily on first read, so "pages = 0" means "never opened", not "broken".
//  * decimal chapters (12.5, 44.6) are overwhelmingly legitimate side-stories and "Notice!" pages, which are
//    genuinely one image long. Only whole-numbered chapters are worth flagging as too short.
import { q } from './db';

export type HealthStatus = 'ok' | 'warn' | 'problem';

export interface HealthItem {
  seriesId?: string;
  /** Every series this item is about. The duplicates check needs both, so a merge can act on them. */
  seriesIds?: string[];
  titles?: string[];
  title: string;
  detail: string;
}

export interface HealthCheck {
  id: string;
  title: string;
  status: HealthStatus;
  /** one-line human summary, already pluralised */
  summary: string;
  /** what this check cannot see — shown so nobody reads more into a green result than it deserves */
  note?: string;
  items: HealthItem[];
}

export interface HealthReport {
  generatedAt: string;
  checks: HealthCheck[];
}

const MAX_ITEMS = 50; // keep the payload sane; the summary always reports the true total

function truncate<T>(rows: T[]): { items: T[]; hidden: number } {
  return { items: rows.slice(0, MAX_ITEMS), hidden: Math.max(0, rows.length - MAX_ITEMS) };
}

// ---- individual checks ------------------------------------------------------

/** Missing runs of chapter numbers: either the source never had them, or a download failed. */
async function chapterGaps(): Promise<HealthCheck> {
  // Islands-and-gaps: group consecutive chapter numbers into runs, then report the holes between runs.
  const rows = await q<{ series_id: string; title: string; missing: number; ranges: string }>(
    `WITH n AS (SELECT DISTINCT series_id, floor(number)::int AS c FROM lib_books WHERE number > 0),
          b AS (SELECT series_id, c, c - row_number() OVER (PARTITION BY series_id ORDER BY c) AS grp FROM n),
          runs AS (SELECT series_id, min(c) lo, max(c) hi FROM b GROUP BY series_id, grp),
          ord AS (SELECT series_id, lo, hi, lag(hi) OVER (PARTITION BY series_id ORDER BY lo) AS prev FROM runs),
          gaps AS (SELECT series_id, prev + 1 AS gap_lo, lo - 1 AS gap_hi
                     FROM ord WHERE prev IS NOT NULL AND lo - prev > 1)
     SELECT g.series_id, ls.title,
            sum(gap_hi - gap_lo + 1)::int AS missing,
            string_agg(CASE WHEN gap_lo = gap_hi THEN gap_lo::text ELSE gap_lo || '-' || gap_hi END,
                       ', ' ORDER BY gap_lo) AS ranges
       FROM gaps g JOIN lib_series ls ON ls.id = g.series_id AND ls.deleted_at IS NULL AND ls.merged_into IS NULL
      GROUP BY g.series_id, ls.title
      ORDER BY missing DESC`,
  );
  const { items, hidden } = truncate(rows);
  return {
    id: 'chapter-gaps',
    title: 'Chapter gaps',
    status: rows.length ? 'warn' : 'ok',
    summary: rows.length
      ? `${rows.length} series ${rows.length === 1 ? 'has' : 'have'} missing chapters`
      : 'No gaps in any series',
    note:
      'Gaps are normal when a source skipped a number or a series is still being downloaded. Use "Update" on a ' +
      'series to try fetching what is missing.' + (hidden ? ` ${hidden} more not shown.` : ''),
    items: items.map((r) => ({
      seriesId: r.series_id,
      title: r.title,
      detail: `${r.missing} missing — ${r.ranges.length > 90 ? r.ranges.slice(0, 90) + '…' : r.ranges}`,
    })),
  };
}

/** Whole-numbered chapters that turned out to be one or two images: almost always a failed download. */
async function shortChapters(): Promise<HealthCheck> {
  // `pages` is only known for chapters somebody has actually opened, so this can never be exhaustive.
  // Decimal chapters are excluded on purpose: ".5" entries are usually author notices, legitimately 1 page.
  const rows = await q<{ series_id: string; title: string; number: number; pages: number }>(
    `SELECT b.series_id, ls.title, b.number, b.pages
       FROM lib_books b JOIN lib_series ls ON ls.id = b.series_id AND ls.deleted_at IS NULL AND ls.merged_into IS NULL
      WHERE b.pages BETWEEN 1 AND 2 AND b.number = floor(b.number)
      ORDER BY ls.title, b.number`,
  );
  const { items, hidden } = truncate(rows);
  return {
    id: 'short-chapters',
    title: 'Suspiciously short chapters',
    status: rows.length ? 'problem' : 'ok',
    summary: rows.length
      ? `${rows.length} chapter${rows.length === 1 ? '' : 's'} contain only one or two images`
      : 'No truncated chapters found',
    note:
      'Only counts chapters someone has already opened, because page counts are read on first open. ' +
      'Half-chapters are excluded since author notices really are one page.' +
      (hidden ? ` ${hidden} more not shown.` : ''),
    items: items.map((r) => ({
      seriesId: r.series_id,
      title: r.title,
      detail: `Chapter ${r.number} has ${r.pages} page${r.pages === 1 ? '' : 's'}`,
    })),
  };
}

/** Sources that are failing or blocked, and how much of the library depends on them. */
async function sourceTrouble(): Promise<HealthCheck> {
  const rows = await q<{
    source_id: string; status: string; consecutive: number; disabled: boolean;
    blocked_until: string | null; last_error: string | null; series: number;
  }>(
    `SELECT sh.source_id, sh.status, sh.consecutive, sh.disabled, sh.blocked_until, sh.last_error,
            (SELECT count(*) FROM lib_series ls WHERE ls.source = sh.source_id AND ls.deleted_at IS NULL AND ls.merged_into IS NULL)::int AS series
       FROM source_health sh
      WHERE sh.status <> 'ok' OR sh.disabled = true
      ORDER BY sh.disabled DESC, sh.consecutive DESC`,
  );
  const now = Date.now();
  return {
    id: 'sources',
    title: 'Source health',
    status: rows.length ? 'warn' : 'ok',
    summary: rows.length
      ? `${rows.length} source${rows.length === 1 ? ' is' : 's are'} failing or blocked`
      : 'All sources responding normally',
    note: 'A blocked source usually means the site returned 403 or a Cloudflare challenge we could not solve.',
    items: rows.map((r) => {
      const until = r.blocked_until ? new Date(r.blocked_until).getTime() : 0;
      // A block whose deadline has passed is not actually holding anything back; say so rather than
      // leaving the operator thinking the source is still down.
      const state = r.disabled
        ? 'turned off'
        : until && until < now
          ? `block expired, will retry on next use (was ${r.status})`
          : until
            ? `${r.status} until ${new Date(until).toISOString().slice(0, 16).replace('T', ' ')}`
            : r.status;
      const err = r.last_error ? ` — ${r.last_error.slice(0, 80)}` : '';
      return {
        title: r.source_id,
        detail: `${state}; ${r.series} series use it${err}`,
      };
    }),
  };
}

/** The same manga added twice, spotted by two local series resolving to one AniList entry. */
async function duplicateSeries(): Promise<HealthCheck> {
  const rows = await q<{ external_id: string; titles: string; ids: string[] }>(
    `SELECT t.external_id, string_agg(ls.title, ' + ' ORDER BY ls.title) AS titles,
            array_agg(ls.id ORDER BY ls.title) AS ids
       FROM series_trackers t JOIN lib_series ls ON ls.id = t.series_id AND ls.deleted_at IS NULL AND ls.merged_into IS NULL
      WHERE t.provider = 'anilist'
      GROUP BY t.external_id HAVING count(*) > 1
      ORDER BY count(*) DESC`,
  );
  return {
    id: 'duplicates',
    title: 'Duplicate series',
    status: rows.length ? 'warn' : 'ok',
    summary: rows.length
      ? `${rows.length} title${rows.length === 1 ? ' appears' : 's appear'} to be in the library twice`
      : 'No duplicates found',
    note:
      'Detected by two series matching the same AniList entry, so it catches copies added from different ' +
      'sources under different names. Progress tracking works best with one copy of each.',
    items: rows.map((r) => ({
        seriesId: r.ids[0],
        seriesIds: r.ids,
        titles: r.titles.split(' + '),
        title: r.titles,
        detail: 'Same AniList entry',
      })),
  };
}

/** Chapter numbers far beyond the rest of the series: the sidebar-widget scraping bug's signature. */
async function outlierChapters(): Promise<HealthCheck> {
  const rows = await q<{ series_id: string; title: string; med: number; hi: number; n: number }>(
    `WITH s AS (SELECT series_id,
                       percentile_cont(0.5) WITHIN GROUP (ORDER BY number) AS med,
                       max(number) AS hi
                  FROM lib_books WHERE number > 0 GROUP BY series_id)
     SELECT s.series_id, ls.title, s.med, s.hi,
            (SELECT count(*) FROM lib_books b
              WHERE b.series_id = s.series_id AND b.number > GREATEST(s.med * 4, s.med + 500))::int AS n
       FROM s JOIN lib_series ls ON ls.id = s.series_id AND ls.deleted_at IS NULL AND ls.merged_into IS NULL
      WHERE s.hi > GREATEST(s.med * 4, s.med + 500)
      ORDER BY s.hi DESC`,
  );
  return {
    id: 'outliers',
    title: 'Impossible chapter numbers',
    status: rows.length ? 'problem' : 'ok',
    summary: rows.length
      ? `${rows.length} series ${rows.length === 1 ? 'has' : 'have'} chapters numbered far beyond the rest`
      : 'No out-of-range chapters',
    note:
      'Catches chapters scraped from a site\'s sidebar widget, which belong to a different series. The parser ' +
      'now guards against this, so anything here predates that fix.',
    items: rows.map((r) => ({
      seriesId: r.series_id,
      title: r.title,
      detail: `${r.n} chapter(s) up to ${r.hi}, but the series sits around ${Math.round(r.med)}`,
    })),
  };
}

// ---- report -----------------------------------------------------------------

export async function runHealthChecks(): Promise<HealthReport> {
  // Independent read-only queries: run them together rather than serially.
  const checks = await Promise.all([
    chapterGaps(),
    shortChapters(),
    outlierChapters(),
    duplicateSeries(),
    sourceTrouble(),
  ]);
  // worst first, so the page opens on whatever needs attention
  const rank: Record<HealthStatus, number> = { problem: 0, warn: 1, ok: 2 };
  checks.sort((a, b) => rank[a.status] - rank[b.status]);
  return { generatedAt: new Date().toISOString(), checks };
}
