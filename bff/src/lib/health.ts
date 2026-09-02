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
import { visibleToAll } from './visibility';
import { solverPing, solverUrl } from './sources/flaresolverr';
import { diagnose } from './sourceDiagnosis';

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
       FROM gaps g JOIN lib_series ls ON ls.id = g.series_id AND ${visibleToAll('ls')}
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
       FROM lib_books b JOIN lib_series ls ON ls.id = b.series_id AND ${visibleToAll('ls')}
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
/**
 * Chapters the updater or a fill could not save, by source.
 *
 * Rows clear themselves when the chapter lands (persistScan), so what is listed here is what is STILL
 * failing, and how many times it has been tried. Before the ledger existed one night's sweep lost 164 of 226
 * series to a single chapter and no surface, not even the log, said so.
 */
async function chapterFailures(): Promise<HealthCheck> {
  const rows = await q<{
    source_id: string; chapters: number; series: number; since: string; attempts: number;
    latest_title: string; latest_number: number; latest_status: string; latest_reason: string | null;
  }>(
    `SELECT f.source_id,
            count(*)::int AS chapters,
            count(DISTINCT f.series_id)::int AS series,
            min(f.at) AS since,
            max(f.attempts)::int AS attempts,
            (array_agg(ls.title  ORDER BY f.at DESC))[1] AS latest_title,
            (array_agg(f.number  ORDER BY f.at DESC))[1] AS latest_number,
            (array_agg(f.status  ORDER BY f.at DESC))[1] AS latest_status,
            (array_agg(f.reason  ORDER BY f.at DESC))[1] AS latest_reason
       FROM chapter_failures f JOIN lib_series ls ON ls.id = f.series_id AND ${visibleToAll('ls')}
      GROUP BY f.source_id ORDER BY chapters DESC`,
  ).catch(() => [] as any[]);
  const items: HealthItem[] = rows.slice(0, 20).map((r) => ({
    title: r.source_id,
    detail:
      `${r.chapters} chapter${r.chapters === 1 ? '' : 's'} in ${r.series} series since ` +
      `${new Date(r.since).toISOString().slice(0, 10)}, tried up to ${r.attempts} time${r.attempts === 1 ? '' : 's'}; ` +
      `latest: "${r.latest_title}" ch ${r.latest_number} (${r.latest_status}` +
      `${r.latest_reason ? `: ${String(r.latest_reason).slice(0, 80)}` : ''})`,
  }));
  const total = rows.reduce((n, r) => n + r.chapters, 0);
  return {
    id: 'chapter-failures',
    title: 'Chapters that would not download',
    status: rows.length ? 'warn' : 'ok',
    summary: rows.length
      ? `${total} chapter${total === 1 ? '' : 's'} across ${rows.length} source${rows.length === 1 ? '' : 's'} keep failing`
      : 'Every attempted chapter landed',
    note:
      'One entry per source, counting chapters still missing after an attempt and how often each has been tried. ' +
      'They clear themselves the moment the chapter lands.' + (rows.length > 20 ? ` ${rows.length - 20} more not shown.` : ''),
    items,
  };
}

async function sourceTrouble(): Promise<HealthCheck> {
  const rows = await q<{
    source_id: string; status: string; consecutive: number; disabled: boolean;
    blocked_until: string | null; last_error: string | null; empty_streak: number; last_ok_at: string | null;
    series: number;
  }>(
    `SELECT sh.source_id, sh.status, sh.consecutive, sh.disabled, sh.blocked_until, sh.last_error,
            sh.empty_streak, sh.last_ok_at,
            -- ls.source_id, NOT ls.source: the former is the adapter id ('aqua'), the latter is the
            -- display name as it was at add time ('Aqua Manga (EN)'). This compared a name to an id, so it
            -- matched nothing and every row of this check has always reported "0 series use it".
            (SELECT count(*) FROM lib_series ls WHERE ls.source_id = sh.source_id AND ${visibleToAll('ls')})::int AS series
       FROM source_health sh
      WHERE sh.status <> 'ok' OR sh.disabled = true OR sh.empty_streak >= 3
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
    note: 'A blocked source usually means the site returned 403 or a Cloudflare challenge we could not solve. '
        + 'If several fail at once and all of them mention the solver, check the solver rather than the sites.',
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
      // The plain-language cause and its fix, rather than the raw string. This page is admin-only, so it
      // gets the operator half of the diagnosis, which is the half that names what to actually go and do.
      const d = diagnose({
        status: r.status as any, lastError: r.last_error, consecutive: r.consecutive,
        lastOkAt: r.last_ok_at, emptyStreak: r.empty_streak ?? 0,
        blockedUntil: r.blocked_until, disabled: r.disabled,
      });
      const why = d.code === 'ok' ? '' : ` — ${d.fix || d.reason}`;
      return {
        title: r.source_id,
        detail: `${state}; ${r.series} series use it${why}`,
      };
    }),
  };
}

/** The same manga added twice, spotted by two local series resolving to one AniList entry. */
async function duplicateSeries(): Promise<HealthCheck> {
  const rows = await q<{ external_id: string; titles: string; ids: string[] }>(
    `SELECT t.external_id, string_agg(ls.title, ' + ' ORDER BY ls.title) AS titles,
            array_agg(ls.id ORDER BY ls.title) AS ids
       FROM series_trackers t JOIN lib_series ls ON ls.id = t.series_id AND ${visibleToAll('ls')}
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
       FROM s JOIN lib_series ls ON ls.id = s.series_id AND ${visibleToAll('ls')}
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

/**
 * The Cloudflare solver, as its own line.
 *
 * When it dies, every source behind it fails and each records the failure against ITSELF, so the operator
 * sees four broken websites and nothing pointing at the one container they all share. On this install it
 * ran for 62 days with Docker's default 64 MB of shared memory, which is far too little for Chrome: it kept
 * crashing mid-challenge, and the app dutifully reported that the sites were blocking us.
 */
async function solverHealth(): Promise<HealthCheck> {
  const ping = await solverPing();
  // Sources whose own recorded failure blames the solver. This is the correlation that turns "four sites
  // are broken" into "one container is broken".
  const blaming = await q<{ source_id: string }>(
    `SELECT source_id FROM source_health
      WHERE disabled = false AND last_error ILIKE '%flaresolverr%'
        AND (status <> 'ok' OR blocked_until > now())`,
  ).catch(() => []);

  const url = solverUrl();
  if (!ping.ok) {
    return {
      id: 'solver',
      title: 'Cloudflare solver',
      status: blaming.length ? 'problem' : 'warn',
      summary: `Not answering at ${url}${ping.error ? ` (${ping.error})` : ''}`,
      note: 'Sources on Cloudflare-protected sites cannot work without it. Check the container is running '
          + 'and that FLARESOLVERR_URL points at it.',
      // The solver itself is the first item, not just the sources blaming it. Every other check on this page
      // holds "no items means ok", and a solver that is simply absent has nothing to list -- so without this
      // it would report a warning with an empty body, which reads as a page bug rather than a finding.
      items: [
        { title: url, detail: ping.error ? `not answering (${ping.error})` : 'not answering' },
        ...blaming.map((b) => ({ title: b.source_id, detail: 'failing, and its recorded error names the solver' })),
      ],
    };
  }
  return {
    id: 'solver',
    title: 'Cloudflare solver',
    status: blaming.length ? 'warn' : 'ok',
    summary: blaming.length
      ? `Answering, but ${blaming.length} source${blaming.length === 1 ? '' : 's'} recently failed inside it`
      : `Ready${ping.version ? ` (v${ping.version})` : ''}`,
    note: blaming.length
      ? 'It responds, but it has been failing mid-request. Chrome needs far more than Docker\'s default '
      + '64 MB of shared memory (set shm_size: 1gb), and the solver leaks memory, so it wants a restart.'
      : undefined,
    items: blaming.map((b) => ({ title: b.source_id, detail: 'its last failure happened inside the solver' })),
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
    chapterFailures(),
    solverHealth(),
  ]);
  // worst first, so the page opens on whatever needs attention
  const rank: Record<HealthStatus, number> = { problem: 0, warn: 1, ok: 2 };
  checks.sort((a, b) => rank[a.status] - rank[b.status]);
  return { generatedAt: new Date().toISOString(), checks };
}
