// The matches stored by title before the title check existed, held to it (v0.55.7, #168).
//
// Until v0.55.7 AniList's answer to a title search -- and the art backfill's MangaDex and Kitsu answers -- was stored
// with no look at its name (lib/onlineMatch.ts says what that did). Every match stored from now on is checked as it is
// stored; this job checks the ones already there: every AUTOMATIC AniList link (series_trackers.linked_by NULL) and
// every series_art cover and banner served from AniList's or MangaDex's servers. Their names are needed, so it asks
// AniList (and MangaDex) by id -- the network, so never inside the migration's transaction: in the background a
// couple of minutes after boot, then every six hours for whatever is still unchecked (a link an edition copied from
// another, rows an older version wrote after a rollback), and on Admin → Tasks → Run now for everything again.
//
// What it removes, by the one rule (lib/onlineMatch.ts namesMatch, against every name the series goes by here,
// lib/altTitles.ts namesOfMany):
//   * an automatic link whose entry is named as none of the series' names -- and the floors progress pushes recorded
//     against it (lib/trackers.ts pushOne), which are about another work and would hold back the right entry;
//   * a stored cover or banner whose entry fails the same rule -- cleared to the miss a 404 stores, so the series
//     shows its source's cover if it has one, else its own first page, and its banner is made from its pages
//     (lib/autoHero.ts). An adaptation's banner (the anime of a manga with none of its own, which the art lookup
//     takes) also stands when the anime is related to a manga named as the series is.
// What it never touches: a link a person made (linked_by: an import from someone's tracker list), an admin's own art
// (series_overrides), a cover the series' source supplied (another server, or MangaDex's cover of a series whose
// source IS that MangaDex title), and anything it could not ask about. An entry the service no longer answers for is
// kept as it is (counted `unanswered`), and a service that does not answer at all stops the run with nothing decided
// for what it was to judge (`stopped`), to be asked again at the next run.
//
// Resumable by row: checked_at (series_trackers, series_art) is stamped as each verdict is written, and NULL is what
// is left to do, so a restart in the middle takes up where it stopped. AniList is asked fifty ids a request, paced as
// every AniList job here is (lib/anilist.ts), MangaDex a hundred, through its own limiter: the owner's 194 links and
// their art are a handful of requests.
import { q } from './db';
import { logAudit } from './audit';
import { fetchAniListEntries, type AniListEntry } from './anilist';
import { mangadexTitles } from './sources/mangadex';
import { namesOfMany } from './altTitles';
import { aniListMediaOf, mangaDexIdOf, namesMatch, type AniListMedia } from './onlineMatch';
import { withAniListMutation, type AniListAuthority } from './anilistPolicy';

type Log = { info: (m: string) => void; warn: (m: string) => void };

export interface MatchCheckResult {
  /**
   * Matches held to the title check: the links and the pictures below, together. Named `matches`, not `checked`: the
   * Tasks line tells the jobs' results apart by their keys (web lib/tasks.ts taskResult), and `checked` is Verify's.
   */
  matches: number;
  /** Of those, the ones that were another work's: links removed and pictures cleared, together. */
  removed: number;
  /** Automatic AniList links checked, and removed. */
  links: { checked: number; removed: number };
  /** Covers and banners found by a title search, checked, and cleared. */
  art: { checked: number; cleared: number };
  /** Asked about, and no longer known to the service: kept as they are. */
  unanswered: number;
  /** AniList or MangaDex did not answer at all: what it was to judge waits for the next run. */
  stopped?: 'unavailable';
  ms: number;
}

export interface MatchCheckState {
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  lastResult: MatchCheckResult | null;
}

export const matchCheckState: MatchCheckState = { running: false, startedAt: null, finishedAt: null, lastResult: null };

/** The links and pictures named in the audit line, at most: the counts are always whole. */
const AUDIT_NAMED = 50;

type Field = 'banner' | 'cover';
interface Judged { seriesId: string; field: Field; url: string; anilist?: AniListMedia; mangadex?: string }

/**
 * The candidate reads at the top of a background run are not a privacy grant: a series can move libraries while
 * names are being assembled.  Re-read its destination immediately before each outbound batch (and again before
 * applying the answer).  Explicit Admin “Run now” is manual and deliberately includes every library.
 */
async function currentlyAllowed(ids: readonly string[], all: boolean): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  if (all) return new Set(unique);
  if (!unique.length) return new Set();
  const rows = await q<{ id: string }>(
    `SELECT s.id FROM lib_series s JOIN libraries l ON l.id = s.library_id
      WHERE s.id = ANY($1::text[]) AND l.anilist_lookup`, [unique]);
  return new Set(rows.map((r) => r.id));
}

/**
 * Hold every unchecked match to the title check -- every automatic one, checked or not, with `all` (Run now). Writes
 * each verdict as it is reached; answers what it did. Throws only on a database failure.
 */
export async function checkMatches(log: Log, opts: { all?: boolean } = {}): Promise<MatchCheckResult> {
  const t0 = Date.now();
  const all = !!opts.all;
  const authority: AniListAuthority = all ? 'manual' : 'automatic';
  const out: MatchCheckResult = { matches: 0, removed: 0, links: { checked: 0, removed: 0 }, art: { checked: 0, cleared: 0 }, unanswered: 0, ms: 0 };
  const links = await q<{ series_id: string; external_id: string }>(
    `SELECT t.series_id, t.external_id FROM series_trackers t JOIN lib_series s ON s.id = t.series_id
       JOIN libraries l ON l.id = s.library_id
      WHERE ($1 OR l.anilist_lookup) AND t.provider = 'anilist' AND t.linked_by IS NULL
        AND t.external_id ~ '^[0-9]{1,10}$' AND ($1 OR t.checked_at IS NULL)
      ORDER BY t.series_id`, [all]);
  // `own`: the ids the series has on its sources, main and followed -- a MangaDex cover of one of them is the source's.
  const arts = await q<{ series_id: string; banner: string | null; cover: string | null; own: string[] }>(
    `SELECT a.series_id, a.banner, a.cover,
            array_remove(ARRAY[s.source_series_id] || ARRAY(SELECT ss.source_series_id FROM series_sources ss WHERE ss.series_id = s.id), NULL) AS own
       FROM series_art a JOIN lib_series s ON s.id = a.series_id
       JOIN libraries l ON l.id = s.library_id
      WHERE ($1 OR l.anilist_lookup) AND ($1 OR a.checked_at IS NULL)
      ORDER BY a.series_id`, [all]);

  const fields: Judged[] = [];
  const artSnapshots = new Map(arts.map((a) => [a.series_id, { banner: a.banner, cover: a.cover }]));
  for (const a of arts) {
    const own = new Set(a.own.map((x) => String(x).toLowerCase()));
    for (const field of ['banner', 'cover'] as const) {
      const url = a[field];
      if (!url) continue;
      const anilist = aniListMediaOf(url);
      if (anilist) { fields.push({ seriesId: a.series_id, field, url, anilist }); continue; }
      const mangadex = mangaDexIdOf(url);
      if (mangadex && !own.has(mangadex)) fields.push({ seriesId: a.series_id, field, url, mangadex });
    }
  }
  // Do not stamp a row that holds only a source cover (or no art). NULL is also the add/lazy lookup's durable
  // “title enrichment not completed” state; only the title lookup itself may turn that into a cached miss. Marking it
  // here consumed the retry before a newly enabled library had ever sent the title.
  if (!links.length && !fields.length) {
    out.ms = Date.now() - t0;
    return out;
  }

  const names = await namesOfMany([...new Set([...links.map((l) => l.series_id), ...fields.map((f) => f.seriesId)])]);
  const namesOfSeries = (id: string) => names.get(id) ?? [];

  // AniList, by id: every linked entry and every entry a stored picture came from. An adaptation's banner whose anime
  // is not named as the series is judged by the manga it is related to as well, so those are asked in a second round.
  const alCandidates = [...new Set([...links.map((l) => l.series_id), ...fields.filter((f) => f.anilist).map((f) => f.seriesId)])];
  let allowed = await currentlyAllowed(alCandidates, all);
  let activeLinks = links.filter((l) => allowed.has(l.series_id));
  let anilistFields = fields.filter((f) => f.anilist && allowed.has(f.seriesId));
  const alIds = [...new Set([...activeLinks.map((l) => Number(l.external_id)), ...anilistFields.map((f) => f.anilist!.id)])];
  let entries: Map<number, AniListEntry> | null = null;
  if (alIds.length) {
    try {
      entries = await fetchAniListEntries(alIds);
      const related = new Set<number>();
      // A move can happen while the first AniList request is in flight.  Related ids are a separate outbound set,
      // so take the same last-boundary policy snapshot for it rather than carrying the earlier grant forward.
      allowed = await currentlyAllowed(anilistFields.map((f) => f.seriesId), all);
      anilistFields = anilistFields.filter((f) => allowed.has(f.seriesId));
      for (const f of anilistFields) {
        const e = f.anilist?.type === 'ANIME' ? entries.get(f.anilist.id) : undefined;
        if (!e || namesMatch(namesOfSeries(f.seriesId), e.titles)) continue;
        for (const r of e.related) if (r.type === 'MANGA' && !entries.has(r.id)) related.add(r.id);
      }
      if (related.size) for (const [id, e] of await fetchAniListEntries([...related])) entries.set(id, e);
    } catch (e) {
      log.warn(`matches: AniList did not answer (${(e as Error)?.message || e}); its matches are checked at the next run`);
      entries = null;
      out.stopped = 'unavailable';
    }
  }
  let mangadexFields = fields.filter((f) => f.mangadex);
  allowed = await currentlyAllowed(mangadexFields.map((f) => f.seriesId), all);
  mangadexFields = mangadexFields.filter((f) => allowed.has(f.seriesId));
  const mdIds = [...new Set(mangadexFields.map((f) => f.mangadex!))];
  let md: Map<string, string[]> | null = null;
  if (mdIds.length) {
    try {
      md = await mangadexTitles(mdIds);
    } catch (e) {
      log.warn(`matches: MangaDex did not answer (${(e as Error)?.message || e}); its covers are checked at the next run`);
      out.stopped = 'unavailable';
    }
  }

  const removed: Array<{ id: string; title: string | null; anilist?: number; was?: string | null; cleared?: Field }> = [];

  // The links. A verdict is written only where AniList answered at all.
  if (entries) {
    allowed = await currentlyAllowed(activeLinks.map((l) => l.series_id), all);
    activeLinks = activeLinks.filter((l) => allowed.has(l.series_id));
    for (const l of activeLinks) {
      const id = Number(l.external_id);
      const e = entries.get(id);
      const mine = namesOfSeries(l.series_id);
      if (!e) {
        const applied = await withAniListMutation({ id: l.series_id }, authority, async (qq, seriesId) => {
          const rows = await qq(
            `UPDATE series_trackers SET checked_at = now()
              WHERE series_id = $1 AND provider = 'anilist' AND external_id = $2 AND linked_by IS NULL
              RETURNING 1`,
            [seriesId, l.external_id],
          );
          return rows.length > 0;
        });
        if (applied.applied && applied.value) out.unanswered++;
        continue;
      }
      if (namesMatch(mine, e.titles)) {
        const applied = await withAniListMutation({ id: l.series_id }, authority, async (qq, seriesId) => {
          const rows = await qq(
            `UPDATE series_trackers SET checked_at = now()
              WHERE series_id = $1 AND provider = 'anilist' AND external_id = $2 AND linked_by IS NULL
              RETURNING 1`,
            [seriesId, l.external_id],
          );
          return rows.length > 0;
        });
        if (applied.applied && applied.value) out.links.checked++;
        continue;
      }
      // Another work. Still the automatic link to this entry it was when it was read, or nothing is removed: a person
      // may have linked the series meanwhile. Its floors go with it in the SAME policy-locked transaction.
      const applied = await withAniListMutation({ id: l.series_id }, authority, async (qq, seriesId) => {
        const gone = await qq(
          `DELETE FROM series_trackers
            WHERE series_id = $1 AND provider = 'anilist' AND external_id = $2 AND linked_by IS NULL
            RETURNING 1`,
          [seriesId, l.external_id],
        );
        if (!gone.length) return false;
        await qq(`DELETE FROM tracker_progress WHERE series_id = $1 AND provider = 'anilist'`, [seriesId]);
        return true;
      });
      if (!applied.applied || !applied.value) continue;
      out.links.checked++;
      out.links.removed++;
      if (removed.length < AUDIT_NAMED) removed.push({ id: l.series_id, title: mine[0] ?? null, anilist: id, was: e.titles[0] ?? null });
    }
  }

  // The pictures, a row at a time: a field is cleared only while it still holds the URL that was judged, and the row is
  // stamped only once every field on it has a verdict.
  allowed = await currentlyAllowed([...anilistFields, ...mangadexFields].map((f) => f.seriesId), all);
  const bySeries = new Map<string, Judged[]>();
  for (const f of [...anilistFields, ...mangadexFields]) {
    if (allowed.has(f.seriesId)) bySeries.set(f.seriesId, [...(bySeries.get(f.seriesId) ?? []), f]);
  }
  for (const [seriesId, list] of bySeries) {
    const mine = namesOfSeries(seriesId);
    const clear: Partial<Record<Field, string>> = {};
    let pending = false;
    let checked = 0;
    let unanswered = 0;
    for (const f of list) {
      let titles: string[] | undefined;
      let related: AniListEntry['related'] = [];
      if (f.anilist) {
        if (!entries) { pending = true; continue; }
        const e = entries.get(f.anilist.id);
        titles = e?.titles;
        related = e?.type === 'ANIME' ? e.related : [];
      } else if (f.mangadex) {
        if (!md) { pending = true; continue; }
        titles = md.get(f.mangadex);
      }
      if (!titles) { unanswered++; continue; }
      checked++;
      const ok = namesMatch(mine, titles)
        || related.some((r) => r.type === 'MANGA' && namesMatch(mine, entries?.get(r.id)?.titles));
      if (!ok) clear[f.field] = f.url;
    }
    const snapshot = artSnapshots.get(seriesId);
    if (!snapshot) continue;
    const applied = await withAniListMutation({ id: seriesId }, authority, async (qq, lockedId) => {
      const rows = await qq<{ banner: boolean; cover: boolean }>(
        `UPDATE series_art a
            SET banner = CASE WHEN a.banner = $4 THEN NULL ELSE a.banner END,
                cover  = CASE WHEN a.cover  = $5 THEN NULL ELSE a.cover  END,
                checked_at = CASE WHEN $6::boolean THEN a.checked_at ELSE now() END
          WHERE a.series_id = $1
            AND a.banner IS NOT DISTINCT FROM $2::text
            AND a.cover  IS NOT DISTINCT FROM $3::text
        RETURNING ($4::text IS NOT NULL AND a.banner IS NULL) AS banner,
                  ($5::text IS NOT NULL AND a.cover IS NULL) AS cover`,
        [lockedId, snapshot.banner, snapshot.cover, clear.banner ?? null, clear.cover ?? null, pending],
      );
      return rows[0] ?? null;
    });
    if (!applied.applied || !applied.value) continue;
    out.art.checked += checked;
    out.unanswered += unanswered;
    const rows = [applied.value];
    for (const field of ['banner', 'cover'] as const) {
      if (!rows[0]?.[field]) continue;
      out.art.cleared++;
      if (removed.length < AUDIT_NAMED) removed.push({ id: seriesId, title: mine[0] ?? null, cleared: field });
    }
  }

  out.matches = out.links.checked + out.art.checked;
  out.removed = out.links.removed + out.art.cleared;
  out.ms = Date.now() - t0;
  log.info(`matches: ${out.links.checked} AniList link(s) checked, ${out.links.removed} removed as another work's; `
    + `${out.art.checked} cover(s) and banner(s) checked, ${out.art.cleared} cleared`
    + (out.unanswered ? `; ${out.unanswered} no longer known online, kept` : '') + (out.stopped ? ' (stopped: a service did not answer)' : ''));
  if (out.matches || out.unanswered || out.stopped) {
    await logAudit('library.match_check', {
      detail: { links: out.links, art: out.art, unanswered: out.unanswered, ...(out.stopped ? { stopped: out.stopped } : {}), ...(all ? { all } : {}), removed },
    });
  }
  return out;
}

/**
 * Run the check unless one is running (`null` then): the Tasks panel's Run now (every automatic match again, `all`)
 * and the background pass (what is unchecked). A run that held something to the check, or that a service stopped,
 * is the Tasks line's -- in memory, and persisted for a restart; a background pass with nothing to check leaves the
 * line about the last run that did something.
 */
export function runMatchCheck(log: Log, opts: { all?: boolean } = {}): Promise<MatchCheckResult> | null {
  if (matchCheckState.running) return null;
  matchCheckState.running = true;
  matchCheckState.startedAt = Date.now();
  return (async () => {
    try {
      const r = await checkMatches(log, opts);
      if (r.matches || r.unanswered || r.stopped || opts.all) {
        matchCheckState.finishedAt = Date.now();
        matchCheckState.lastResult = r;
        await q('UPDATE server_settings SET match_check_last_run = now(), match_check_last_result = $1::jsonb WHERE id = 1',
          [JSON.stringify(r)]).catch(() => {});
      }
      return r;
    } finally {
      matchCheckState.running = false;
    }
  })();
}

/**
 * The background pass: a couple of minutes after boot -- the upgrade's one look at everything stored before -- then
 * every six hours for whatever is still unchecked, which is nothing on most runs and costs one query then.
 */
export function scheduleMatchCheck(log: Log, delayMs = 2 * 60_000, everyMs = 6 * 60 * 60_000): void {
  const tick = async () => {
    try {
      await runMatchCheck(log);
    } catch (e) {
      log.warn(`matches: the check failed: ${(e as Error)?.message || e}`);
    }
    setTimeout(tick, everyMs).unref?.();
  };
  setTimeout(tick, delayMs).unref?.();
}
