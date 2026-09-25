// Search across sources and add a new series to the library (queues its download). Backed by the source
// adapters + the downloader. The cover proxy lives under /img (cookie auth) so <img> tags can load it.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, userIdOf, roleOf } from '../lib/auth';
import { getSource, listSources, isSwAdapterId, SW_PREFIX, swAdapterId, withTimeout } from '../lib/sources';
import type { SourceAdapter, SourceSeries, SourceChapter } from '../lib/sources/types';
import { sanitize, type DownloadInput } from '../lib/downloader';
import { downloadWithFallback } from '../lib/chapterFallback';
import { selectChapters, type ChapterFrom } from '../lib/selectChapters';
import { noteChapterFailure } from '../lib/chapterFailures';
import { scanOrder } from '../lib/scanOrder';
import { searchAll, groupByTitle, bySource, SEARCH_FIRST_ANSWER_MS } from '../lib/searchAll';
import { budgetFor } from '../lib/sources/budget';
import { SOLVER_CONCURRENCY } from '../lib/sources/flaresolverr';

/**
 * How many searches a fill scan runs at once, and when it stops starting new ones.
 *
 * The scan used to fan out to every registered source at once with a 45s timeout each. The solver runs
 * SOLVER_CONCURRENCY solves at a time, so with 35 sources the tail of the queue spent its whole timeout
 * waiting for a slot and was then reported `unreachable`: in one live scan, 16 of 21 candidates were sources
 * that never got a turn. Now a search holds one of these slots BEFORE its clock starts, sources are asked in
 * relevance order (see scanOrder), and once SCAN_ENOUGH sources have the title the rest are not asked at all.
 */
const SCAN_CONCURRENCY = Math.max(1, Number(process.env.SCAN_CONCURRENCY || SOLVER_CONCURRENCY));
const SCAN_ENOUGH = Math.max(1, Number(process.env.SCAN_ENOUGH || 3));
const SCAN_SEARCH_MS = Number(process.env.SCAN_SEARCH_MS) || 45_000;
import { persistScan, setBookDates, setBookMeta, libraryIdFor, type LibraryRow, LIBRARY_ROOT, DL_ROOT } from '../lib/library';
import { diskSpelling } from '../lib/libraryAdmin';
import { isDesktop } from '../lib/desktop';
import { newSeriesId } from '../lib/ids';
import { cleanDescription } from '../lib/htmlText';
import { updateSeries } from '../lib/updater';
import { busyFolders } from '../lib/bulkNewest';
import { chooseReleases, groupsOf, releaseOrder } from '../lib/releases';
import { effectivePrefsFor, readSeriesPrefs } from '../lib/scanlatorPrefs';
import { copyToChapter, listingRows, replaceListing, type ListingCopy } from '../lib/seriesListing';
import { haveNumbers } from '../lib/libraryNumbers';
import { groupStats } from '../lib/groupStats';
import { fetchAniListArt, fetchTrendingManhwa, TrendingItem } from '../lib/anilist';
import { q, one } from '../lib/db';
import { healthAll, isDisabled, blockedNow, reportLatest, reportFail, reportSlow, classify } from '../lib/sourceHealth';
import { diagnose, EMPTY_SUSPECT } from '../lib/sourceDiagnosis';
import {
  gapsOf, assess, verdict, authorise, putPlan, getPlan, planKey, sweepPlans,
  MIN_HAVE, PLAN_TTL, type PlanCandidate, type Refusal,
} from '../lib/fill';

/**
 * The most chapters one confirmed fill may fetch.
 *
 * At the download gate's 1200ms minimum spacing plus fetch time, 300 chapters is several hours of background
 * work. A bound, not a policy: it exists so a mis-click cannot start something that runs all week.
 */
export const FILL_MAX_CHAPTERS = 300;
/** How long a Fetch waits for the listing refresh before the stale listing serves (see /api/sources/fetch). */
export const REFRESH_BUDGET_MS = 10_000;
import { logAudit } from '../lib/audit';
import { autoFollow, refusals, MAX_AUTO_CANDIDATES, type FollowCandidate, type FollowResult } from '../lib/autoFollow';
import { env } from '../env';
import { runtime } from '../lib/runtime';
// The "already in library" annotation is deliberately library-wide: it answers "would adding this be a
// duplicate on this server", which is a property of the server, not of the person asking.
//
// Which SOURCES you may reach is the opposite: entirely about who is asking, which is what `viewCtxFor` and
// `sourceAllowedFor` answer.
import { visibleToAll, viewCtxFor, sourceAllowedFor, sourceBrowsableFor, browsable, visible, seriesVisible, Params, type ViewCtx, hideAdult } from '../lib/visibility';

interface Job {
  title: string; total: number; done: number;
  status: 'downloading' | 'done' | 'error';
  reason?: string;
  /** When it stopped, so a finished one can age out. A FAILED one never does: it is the only record. */
  finishedAt?: number;
  /**
   * The library id of the series this job is filling (#67), for "Open in library" to navigate by.
   *
   * On the card and not on the add's answer, for the same reason `autoFollow` is: a fresh download has no
   * lib_series row when the dialog is answered -- persistScan mints it from the first chapter's folder,
   * which is minutes later -- so the id simply does not exist yet at that point. It lands here the moment
   * that scan has run, and the dialog is already polling this card every two seconds. Absent until then,
   * and absent for good on a job whose first chapter never landed.
   *
   * It is not a capability: every by-id route checks the viewer for itself (lib/visibility.ts), and a card
   * already carries the folder and the title, which say more about the series than an opaque id does.
   */
  seriesId?: string;
  /**
   * What became of the other sources the add named in `alsoFollow` (#49, lib/autoFollow.ts). On the card
   * and not on the add's answer, because the judgement needs the listing, which on the download path is
   * written after the first chapter lands -- long after the dialog was answered -- and the dialog polls
   * this card every two seconds anyway. `done: false` with no results while the sources are being asked;
   * a nothing-yet add, which has no download, gets a card with `total: 0` just to carry this.
   */
  autoFollow?: { done: boolean; results: FollowResult[] };
  /**
   * Chapters this job took from a source other than the one their copy named (lib/chapterFallback.ts):
   * the copy failed -- a missing page, a refusal -- and the same number from another followed source
   * landed instead. One entry per chapter, in job order; the card's `reason` words the latest one.
   */
  switched?: Array<{ number: number; from: string; to: string; why: string }>;
  /** How many chapters this job saved with placeholder pages (lib/partial.ts). */
  partial?: number;
}
const jobs = new Map<string, Job>();

/** How long a completed download stays listed. `jobs.delete` had exactly one call site -- the chapter-1
 *  failure path -- so a successful job was never removed and the strip filled with green cards that only a
 *  restart cleared. Swept lazily on read rather than on a timer: the client polls this often enough. */
const DONE_TTL = 5 * 60_000;
function sweepJobs(now = Date.now()): void {
  for (const [folder, j] of jobs) {
    if (j.status === 'done' && j.finishedAt && now - j.finishedAt > DONE_TTL) jobs.delete(folder);
  }
}

/**
 * Is a download running for this series folder right now. Jobs are keyed by folder, as lib_series.folder is.
 * The bulk "Fetch newest" run (lib/bulkNewest.ts) is a writer too, and one this map never sees: it goes
 * through updateSeries, not startDownloadJob. Its own set says which folder it is inside, so a Fetch on
 * that series page is refused rather than doubled while the run is on it -- the same 409 the strip's jobs
 * earn. Reintroduce by dropping the `busyFolders` test: "a series-page fetch during the run is refused as
 * busy" in bulkNewest.int.test.ts starts the second download.
 */
export function jobBusy(folder: string): boolean {
  return jobs.get(folder)?.status === 'downloading' || busyFolders.has(folder);
}

export interface DownloadJobInput {
  folder: string;
  title: string;
  seriesId: string;
  /**
   * Ascending. Every copy carries `source`: the adapter it is fetched through. A copy marked `pinned` is
   * one a person picked by name (a versions-list pick): it is fetched from that source and no other.
   */
  chapters: Array<SourceChapter & { pinned?: boolean }>;
  /** OUR series row's metadata, never a candidate's -- see the note on `meta` inside the loop. */
  meta: DownloadInput['meta'];
  /**
   * Which sources THIS viewer may reach (visibility.sourceAllowedFor), for the copies the job may fall
   * back to: a capped member's fetch must not have the server take a chapter from an adult source on
   * their behalf. Absent = every source (the admin's routes; admins are unrestricted by construction).
   */
  allowed?: (source: string) => boolean;
  /**
   * Called once per chapter with whether it landed: right after its attempt, or at the end of the job for
   * a chapter the job never reached (a full disk, a refusing source, a shutdown). The refetch route uses it
   * to drop or put back the copy it set aside; a job that ends must settle every chapter it was given, or
   * a chapter skipped by a refusal would leave its old file renamed away for good.
   */
  onSettled?: (ch: SourceChapter, landed: boolean) => Promise<void>;
}

/**
 * Fetch a list of chapters into a series folder as one job card, detached from the request.
 *
 * This is the fill's loop, lifted out so a manual fetch of ghost chapters and an admin's "fetch again"
 * run the same code rather than three copies of it. The job answers `total` at once; the work happens
 * after, and the client polls GET /api/sources/jobs. The generalisations over the fill's original: each
 * copy names its own source (the fill's chapters all name one, so it behaves as before); a source that
 * refuses is not asked again but the others still are; a copy that fails is taken from another FOLLOWED
 * source that lists the same number, or saved with placeholder pages when enough of it arrived
 * (lib/chapterFallback.ts -- the one download policy every loop shares); the loop ends when every source
 * the job could still draw on is refusing, which for a series with one source is the first refusal,
 * exactly as before; and it checks `runtime.stopping` between chapters, as the updater's does, so a
 * `docker compose up -d` mid-fetch ends at a chapter boundary instead of mid-write.
 *
 * The job never hunts for a NEW source: a person is watching this card, and a search across six sites is
 * the sweep's to run tonight, once, on its own budget. A copy the person picked by name (`pinned`) is
 * never switched either.
 *
 * The caller has already authorised the chapters and recorded the audit line; this function does neither.
 */
export function startDownloadJob(input: DownloadJobInput): { total: number } {
  const { folder, title, seriesId, chapters, meta } = input;
  jobs.set(folder, { title, total: chapters.length, done: 0, status: 'downloading' });
  const settle = async (ch: SourceChapter, landed: boolean) => {
    if (!input.onSettled) return;
    // A hook that throws must not take the job's tail with it: the scan and the stamps still have to run.
    await input.onSettled(ch, landed).catch((e) => console.warn(`[download] settle hook failed for ${folder} ch ${ch.number}: ${(e as Error)?.message || e}`));
  };
  const nameOf = (id: string) => getSource(id)?.name ?? id;

  void (async () => {
    let failures = 0;
    // What this job wrote, for the provenance stamp; a skipped copy was already on disk and is not ours.
    const landed: Array<{ number: number; scanlator?: string; source?: string; missing?: number[] }> = [];
    const settled = new Set<SourceChapter>();
    // A source that has refused once this job is not asked again, but the others still are: a rate-limited
    // primary must not stop the follower's chapters. Each source costs at most one strike per job. Written
    // by the helper (a copy that earns `blockStatus` puts its source here) and read by it.
    const refusing = new Set<string>();
    // What the helper called the failure that switched a chapter, per source, so a LATER chapter whose
    // chosen copy is merely skipped for refusing can still be worded as "asked us to slow down" when a
    // 429 was what started it.
    const whyBySource = new Map<string, string>();
    // The sources this job may draw on: the copies' own, and everything the series follows (the listing's
    // other copies are only ever taken from followed sources -- the same rule as a manual fetch, where a
    // listing row's source is trusted only while the series follows it). Read once, before any download.
    const sources = new Set(chapters.map((c) => c.source ?? ''));
    const followed = new Set([
      ...(await one<{ source_id: string | null }>('SELECT source_id FROM lib_series WHERE id = $1', [seriesId]).then((r) => (r?.source_id ? [r.source_id] : []), () => [])),
      ...(await q<{ source_id: string }>('SELECT source_id FROM series_sources WHERE series_id = $1', [seriesId]).catch(() => [])).map((r) => r.source_id),
    ]);
    const exhausted = () => [...sources, ...followed].every((sid) => refusing.has(sid));
    /** The listing's other copies of a number, from followed sources; the helper drops the copy's own source. */
    const alternatesOf = async (n: number): Promise<SourceChapter[]> => {
      const row = await one<{ title: string | null; copies: ListingCopy[] }>(
        'SELECT title, copies FROM series_listing WHERE series_id = $1 AND number = $2::real', [seriesId, n]).catch(() => null);
      return (row?.copies ?? []).filter((c) => followed.has(c.source)).map((c) => copyToChapter(c, { number: n, title: row!.title }));
    };
    for (const ch of chapters) {
      if (runtime.stopping) break; // between chapters, never mid-write
      const via = ch.source ?? '';
      settled.add(ch);
      let out;
      try {
        /**
         * `meta` comes from OUR series row, never from the candidate.
         *
         * `downloadChapter` writes meta.series into the CBZ's ComicInfo <Series>, and every persistScan
         * re-reads the FIRST chapter's ComicInfo and overwrites the series row's title, summary, author,
         * status, genres and web from it (lib/library.ts, ON CONFLICT DO UPDATE). Filling a gap at the
         * START of a series writes the new first chapter -- so passing the candidate's title here would
         * silently rename the series, for everyone, on the next scan. It fires even when the match is
         * RIGHT, because a right match is often under a different English title.
         */
        out = await downloadWithFallback({
          seriesId, title, folder, meta, chapter: ch,
          alternates: () => alternatesOf(ch.number),
          refusing, allowed: input.allowed, hunt: undefined,
        });
      } catch (e: any) {
        const j = jobs.get(folder);
        if (e?.diskFull) {
          if (j) { j.status = 'error'; j.reason = `Not enough free space: ${String(e.message)}. ${j.done} of ${j.total} chapters saved.`; j.finishedAt = Date.now(); }
          await settle(ch, false);
          break;
        }
        throw e;
      }
      const j = jobs.get(folder);
      if (out.kind === 'landed' || out.kind === 'partial') {
        landed.push({
          number: ch.number, scanlator: out.chapterUsed.scanlator, source: out.via,
          ...(out.kind === 'partial' ? { missing: out.missing.map((i) => i + 1) } : {}),
        });
        if (j) {
          j.done++;
          if (out.switched) {
            const why = out.switched.why === 'refusing' ? whyBySource.get(out.switched.from) ?? 'refusing' : out.switched.why;
            whyBySource.set(out.switched.from, why);
            (j.switched ??= []).push({ number: ch.number, from: out.switched.from, to: out.via, why });
            j.reason = why === 'rate_limited'
              ? `${nameOf(out.switched.from)} asked us to slow down \u2014 continued from ${nameOf(out.via)}`
              : `${nameOf(out.switched.from)} could not serve chapter ${ch.number} \u2014 took it from ${nameOf(out.via)}`;
          }
          if (out.kind === 'partial') {
            j.partial = (j.partial ?? 0) + 1;
            j.reason = `Chapter ${ch.number} saved with ${out.missing.length} page${out.missing.length === 1 ? '' : 's'} missing`;
          }
          if (j.done % 5 === 0) await persistScan().catch(() => {});
        }
        await settle(ch, true);
      } else if (out.kind === 'skipped') {
        // On disk already, or its source is refusing with nothing else to ask: neither is this job's
        // failure, and neither advances the bar.
        await settle(ch, false);
      } else {
        failures++;
        await noteChapterFailure({ seriesId, title, number: ch.number, sourceId: out.via, err: out.err });
        await settle(ch, false);
        if (refusing.has(out.via)) {
          if (j) {
            j.reason = `${nameOf(out.via)} stopped part-way. ${j.done} of ${j.total} chapters saved.`;
            if (exhausted()) { j.status = 'error'; j.finishedAt = Date.now(); }
          }
        } else if (j) {
          j.reason = `${failures} chapter${failures === 1 ? '' : 's'} could not be saved: ${String(out.err?.message || out.err).slice(0, 120)}`;
        }
        // NOT counted: a chapter that was not written must never advance the bar.
      }
      // Every source this job could draw on has refused: the rest of the queue has nowhere to land.
      if (refusing.size && exhausted()) {
        if (j && j.status !== 'error') { j.status = 'error'; j.reason ??= `${j.done} of ${j.total} chapters saved.`; j.finishedAt = Date.now(); }
        break;
      }
    }
    // Settled BEFORE the scan, so a copy the hook puts back is on disk when the scanner looks.
    for (const ch of chapters) if (!settled.has(ch)) await settle(ch, false);
    await persistScan().catch(() => {});
    await setBookDates(folder, chapters).catch(() => {});
    await setBookMeta(folder, landed).catch(() => {});
    const j = jobs.get(folder);
    if (j && j.status !== 'error') { j.status = failures ? 'error' : 'done'; j.finishedAt = Date.now(); }
  })();

  return { total: chapters.length };
}

// Trending recommendations are global + slow-moving; cache the AniList pull for a few hours.
let trendingCache: { at: number; items: TrendingItem[] } | null = null;
/** Canonical title key used for dedupe, grouping and "already in library" checks. */
export const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '');

// Provider order for cross-source "find": by each source's declared preferredOrder (Aqua = 0), then
// registry/load order. Derived from the loaded sources so it works with whatever the user has installed.
function findOrder(): string[] {
  return listSources().slice().sort((a, b) => (a.preferredOrder ?? 999) - (b.preferredOrder ?? 999)).map((s) => s.id);
}
// The title-match rule (`pickBest`, `pickBestScored`, `MatchConfidence`) moved to lib/titleMatch.ts in
// v0.40.0 so the source hunt -- a lib -- can apply it without importing this route. Re-exported so the
// type keeps its old address for anyone who imported it from here.
import { pickBest, pickBestScored, type MatchConfidence } from '../lib/titleMatch';
export type { MatchConfidence };

/**
 * Which of these titles the library already has.
 *
 * Was `SELECT s.title FROM lib_series` -- every row, every column value in memory, once per source per wall
 * paint, and again per page as you scroll. Six sources on a 214-series library is six full scans to answer a
 * question about twenty-four titles. The normalisation matches `norm()` and the duplicate check in
 * `addSeriesFromSource`, which has always compared this way.
 */
const NORM_SQL = "lower(regexp_replace(s.title, '[^a-zA-Z0-9]', '', 'g'))";
async function inLibrary(titles: Array<string | undefined>): Promise<Set<string>> {
  const keys = [...new Set(titles.map((t) => norm(t || '')).filter(Boolean))];
  if (!keys.length) return new Set();
  const rows = await q<{ k: string }>(
    `SELECT ${NORM_SQL} AS k FROM lib_series s WHERE ${visibleToAll('s')} AND ${NORM_SQL} = ANY($1)`,
    [keys],
  ).catch(() => []);
  return new Set(rows.map((r) => r.k));
}

/**
 * How long one source gets to answer "what is new".
 *
 * This handler was the only one of its siblings with no bound of its own: `search-all` caps the adapter at
 * 20s and `find` at 25s, while this called `src.latest()` bare and inherited whatever the adapter allowed
 * itself -- 30s for Suwayomi, 95s for a FlareSolverr-backed site. Production's worst measured call was 63.5s
 * for a single source, against a median of 355ms. Eight seconds is well past the p90 of 2.5s.
 */
const LATEST_TIMEOUT = env.SOURCE_LATEST_TIMEOUT_MS;
const LATEST_TTL = 10 * 60_000;
/** What the two lookups an add must do inline are allowed to take. Matches the /find handler's budget. */
const ADD_LOOKUP_TIMEOUT = 20_000;

/**
 * What `/api/sources/detail` just fetched, so an add does not fetch it all over again.
 *
 * The add dialog calls `detail` to show the cover, summary and chapter count, and `add` then made the exact
 * same two calls seconds later -- on a Cloudflare source that is two more challenge solves, and it was
 * measured at 22.8s of an add that had already moved its downloading to the background. Ten minutes,
 * not the ninety seconds this began with: the dialog now fetches the detail of a card's first providers
 * the moment the card opens, and the person may read the summary, compare sources and come back, so the
 * pre-warm has to outlive a slow decision -- and a chapter list that is ten minutes old is still the list
 * the sweep would act on. Anything a person adds within that window is what the site said within it.
 *
 * Keyed by source and series only: this is what the SITE said, identical for every viewer, exactly like
 * `latestCache` above. The in-flight map is what makes the dialog's pre-warm and the pick a single fetch:
 * without it the pick, arriving while the pre-warm is still solving a challenge, started a second solve
 * of its own and waited for the slower of the two.
 */
const DETAIL_TTL = 600_000;
const detailCache = new Map<string, { at: number; series: SourceSeries | null; chapters: SourceChapter[] }>();
const detailInflight = new Map<string, Promise<{ series: SourceSeries | null; chapters: SourceChapter[] }>>();

export async function seriesAndChapters(src: SourceAdapter, sourceId: string):
  Promise<{ series: SourceSeries | null; chapters: SourceChapter[] }> {
  const key = `${src.id}:${sourceId}`;
  const hit = detailCache.get(key);
  if (hit && Date.now() - hit.at < DETAIL_TTL) return { series: hit.series, chapters: hit.chapters };
  const flying = detailInflight.get(key);
  if (flying) return flying;

  const fetchBoth = async (): Promise<{ series: SourceSeries | null; chapters: SourceChapter[] }> => {
    // In parallel. `add` ran these one after the other while `detail` had always run them together, so an
    // add paid the sum of two solves where the dialog beside it paid the larger of the two.
    //
    // `failed` is tracked separately from the empty value, because the two are indistinguishable otherwise:
    // both `getSeries` and `listChapters` answer a timeout or a throw with null/[], which is exactly what a
    // title with genuinely nothing on it looks like.
    let failed = false;
    const [series, chapters] = await Promise.all([
      withTimeout(src.getSeries(sourceId), budgetFor(src, ADD_LOOKUP_TIMEOUT)).catch(() => { failed = true; return null; }),
      withTimeout(src.listChapters(sourceId), budgetFor(src, ADD_LOOKUP_TIMEOUT)).catch(() => { failed = true; return [] as SourceChapter[]; }),
    ]);
    // Only a real answer is remembered. Caching the failure -- which this did when the cache was added --
    // turns a hiccup into a confident "No readable chapters for this title on this source. Try a different
    // source." pinned for ten minutes, so retrying inside the window returns the same wrong advice. Before
    // the cache existed the same catch was here, but a retry worked; the cache is what made it stick. The
    // in-flight join below is not that: two callers of ONE attempt share its failure, and the next call
    // asks again.
    if (!failed) detailCache.set(key, { at: Date.now(), series, chapters });
    return { series, chapters };
  };

  // Registered before anything can await, and removed only if it is still the entry we put there -- the
  // `latestInflight` idiom below. ⚠️ Not named `run` (and this comment must not spell that declaration
  // out either): sourceSlow.int.test.ts finds the first arrow so named in this file's raw text and
  // expects it to be latestPage's, whose catch it inspects.
  const p = fetchBoth();
  detailInflight.set(key, p);
  void p.finally(() => { if (detailInflight.get(key) === p) detailInflight.delete(key); });
  return p;
}

/** Exposed for tests: the cache is process-global and would otherwise leak between cases. */
export function clearDetailCache(): void {
  detailCache.clear();
  detailInflight.clear();
}
const latestCache = new Map<string, { at: number; items: SourceSeries[] }>();
const latestInflight = new Map<string, Promise<SourceSeries[]>>();

/**
 * One source's newest page, cached and de-duplicated.
 *
 * Keyed by source and page and NOT by user, deliberately: a source's newest page is the same bytes for
 * everyone, and *which sources you may ask for* is decided before this is ever called. That separation is
 * also why the service worker must not cache this endpoint -- the Cache API keys by URL with no `Vary`, so
 * on a shared household device it would serve one account's wall to another.
 *
 * The in-flight map matters more than the TTL here: six chips, several tabs and a page refresh otherwise
 * become six identical outbound scrapes of the same site within a second of each other.
 */
export type ListMode = 'latest' | 'popular';

async function latestPage(src: SourceAdapter, page: number, mode: ListMode = 'latest'): Promise<SourceSeries[]> {
  // The mode belongs in the key. Without it the two listings share a cache entry and an in-flight promise,
  // so whichever is asked for first answers both -- Popular would serve Newest's results for ten minutes,
  // or the reverse, depending only on which the reader happened to open.
  const key = `${src.id}:${mode}:${page}`;
  const hit = latestCache.get(key);
  if (hit && Date.now() - hit.at < LATEST_TTL) return hit.items;
  const flying = latestInflight.get(key);
  if (flying) return flying;

  const run = async (): Promise<SourceSeries[]> => {
    try {
      const fetchList = mode === 'popular' ? src.popular! : src.latest!;
      const raw = await withTimeout(fetchList(page), LATEST_TIMEOUT);
      const seen = new Set<string>();
      // dedupe by sourceId (duplicate ids collide on the React key -> wrong cover/title on a card)
      const items = raw.filter((r) => !!r.sourceId && !seen.has(r.sourceId) && (seen.add(r.sourceId), true)).slice(0, 24);
      // An empty answer must not evict a good page. This ran unconditionally, and BEFORE the length check
      // below, so one transient empty reply both poisoned this source for the next ten minutes and could
      // overwrite a page that had real titles on it. Keep the older, better answer; leaving its timestamp
      // stale is deliberate, so the next visit retries instead of serving the empty one for ten minutes.
      if (items.length || !hit?.items.length) latestCache.set(key, { at: Date.now(), items });
      // Only a page with something on it counts as proof of life, and that has not changed: `reportLatest`
      // reports OK only when something came back. Several adapters answer a failed Cloudflare challenge with
      // an empty array rather than by throwing -- on this install Aqua Manga and Natomanga both do -- and
      // `reportOk` CLEARS `blocked_until` and resets the failure count, so browsing Discover would wipe a
      // cooldown the downloader had legitimately recorded.
      //
      // What HAS changed is that the empty case is no longer silent. It used to write nothing at all, which
      // meant a Cloudflare interstitial served as HTTP 200, and a site whose markup had drifted, were both
      // completely undetectable: "nothing new" and "I could not read the page" looked identical to the
      // server as well as to the reader. `reportLatest` records the empty streak and touches nothing else,
      // so the two can finally be told apart without a quiet source earning a cooldown for it. Page is
      // passed because only page 1 is evidence -- see the function.
      // Only the NEWEST listing is evidence about a source's health. An empty popular page much more often
      // means the source has no popularity listing worth the name than that its parser has drifted, and
      // feeding that into `empty_streak` would mark working sources as broken. Failures that throw still
      // report through the catch below, for either mode.
      if (mode === 'latest') void reportLatest(src.id, items.length, page);
      return items;
    } catch (e) {
      // Two different facts, recorded two different ways. A source that actually failed earns the escalating
      // cooldown, because asking a refusing site again soon is pure cost. A source that merely outran OUR
      // budget does not: it is counted, and at worst gets a short fixed breather. The escalating version
      // removed the very requests that would have shown it working, which is how a healthy source went
      // missing for a day while every diagnostic said it was fine.
      if ((e as { selfTimeout?: boolean })?.selfTimeout) {
        void reportSlow(src.id, (e as { ms?: number }).ms ?? LATEST_TIMEOUT);
      } else {
        // Nothing reported health from here, so a source that failed on every single visit kept its `ok`
        // status forever and the client's ranking kept putting it first. Reporting earns it a cooldown.
        void reportFail(src.id, classify(e) ?? 'down', (e as Error)?.message || `${mode} failed`);
      }
      // Stale beats empty: an old page is still this source's newest page, whereas an empty one reads as
      // "this source has nothing", which is a different and false statement. /api/discover/trending already
      // serves stale on failure for the same reason.
      return hit?.items ?? [];
    }
  };

  // Registered before anything can await, and removed only if it is still the entry we put there.
  const p = run();
  latestInflight.set(key, p);
  void p.finally(() => { if (latestInflight.get(key) === p) latestInflight.delete(key); });
  return p;
}

/** Whatever is on hand for this source and page, however old. Used when a source is in cooldown. */
const cachedLatest = (id: string, page: number, mode: ListMode = 'latest'): SourceSeries[] =>
  latestCache.get(`${id}:${mode}:${page}`)?.items ?? [];

/** Exposed for tests: the cache is process-global and would otherwise leak between cases. */
export function clearLatestCache(): void {
  latestCache.clear();
  latestInflight.clear();
}

export interface AddResult {
  ok: boolean; status: number; error?: string; message?: string;
  title?: string; folder?: string; chapters?: number;
  existing?: { id: string; title: string; source: string }; blockStatus?: string;
  /** The download was started rather than completed. Absent when the series was already in the library. */
  started?: boolean;
  /** A "nothing yet" add: the series was created and floored, and no chapter was fetched or queued. */
  nothing?: boolean;
  /**
   * The library id of the series this add landed on, whenever the add can know it (#67): the row it found
   * already there, the row it minted, the row it revived, and the row it stamped with nothing left to
   * fetch. Absent on a DETACHED fresh download and only then -- persistScan mints that row minutes after
   * the answer -- and the id reaches the dialog on the job card instead (`Job.seriesId`).
   *
   * ⚠️ This function is shared with the bulk importer and has no viewer, so it answers the id to its
   * caller unconditionally. The ROUTE is where the viewer lives, and it withholds the id from a caller
   * who may not see the series (`seriesVisible`). An id handed out here is a fact about the library; an
   * id handed out over HTTP is a fact about what the person asking may look at.
   */
  seriesId?: string;
  /**
   * How many of the chapters the person selected were already in the library, on the one branch where
   * that is ALL of them (#65): nothing was fetched, and `chapters` is 0. Absent otherwise -- including on
   * a partial re-add, where `chapters` is what is still to come and the rest needs no wording.
   */
  alreadyHere?: number;
}

/**
 * Judge an add's `alsoFollow` candidates against the listing just written, onto the series' job card.
 *
 * Detached, and never awaited by the add or by its download loop: the judgement is up to six sources
 * under the scan's slots with a 90-second wall (lib/autoFollow.ts), and the download loop can run for
 * hours. Run CONCURRENTLY with the loop rather than after it, because the person is watching the dialog
 * now -- the results are wanted within the minute, not when chapter 300 lands -- and the candidates are
 * OTHER sources, so the judgement neither competes for the primary's rate limit nor delays its pages; it
 * shares only the solver's slots, which the scan's concurrency already bounds. The card is marked `done`
 * whatever happens, or the dialog would read "Checking…" for good; a nothing-yet card (`total: 0`, no
 * loop to stamp it) is stamped finished here so the sweep can age it out. And it is marked done WITH a
 * line per candidate even when the judgement itself threw (a database error before any source was
 * asked, say): lib/autoFollow.ts answers every failure of a candidate's own as a value, so a rejection
 * here is the one failure that would otherwise leave the card reading done with an empty report -- and
 * the dialog prints nothing at all for an empty report, so the person would be told neither "followed"
 * nor why not. `not_tried` is the honest word: no source was asked.
 */
function judgeAlsoFollow(folder: string, seriesId: string, opts: {
  alsoFollow?: FollowCandidate[]; userId?: string | null; req?: FastifyRequest; sourceAllowed?: (source: string) => boolean;
}): void {
  const j = jobs.get(folder);
  if (!j || !opts.alsoFollow?.length) return;
  const candidates = opts.alsoFollow;
  j.autoFollow = { done: false, results: [] };
  void autoFollow(seriesId, candidates, { userId: opts.userId, req: opts.req, allowed: opts.sourceAllowed })
    .then((results) => { const card = jobs.get(folder); if (card?.autoFollow) card.autoFollow.results = results; })
    .catch((e) => {
      console.warn(`[add] auto-follow failed for ${folder}: ${(e as Error)?.message || e}`);
      const card = jobs.get(folder);
      if (card?.autoFollow) card.autoFollow.results = refusals(candidates, 'not_tried');
    })
    .finally(() => {
      const card = jobs.get(folder);
      if (!card) return;
      if (card.autoFollow) card.autoFollow.done = true;
      if (card.status !== 'downloading' && !card.finishedAt) card.finishedAt = Date.now();
    });
}

/** Add one series from a source to the library (downloads chapter 1 synchronously, the rest in background).
 *  Shared by POST /api/sources/add and the bulk importer. Returns a result instead of touching the reply. */
export async function addSeriesFromSource(opts: {
  source?: string; sourceId?: string; force?: boolean; chapterCount?: number; autoUpdate?: boolean;
  /** Which end of the list `chapterCount` counts from. Adapters list ascending, so the default is the oldest N. */
  chapterFrom?: ChapterFrom;
  /**
   * Await the first chapter before returning.
   *
   * The bulk importer does, because it counts what actually landed and has its own progress surface. A
   * person pressing a button must not: that await is the whole of this request's cost -- measured at 15.5s,
   * 48.3s and 59.2s on one install -- and it held the button on "Working…" for all of it while the download
   * had in fact already started. Defaults to true so every existing caller is unchanged.
   */
  wait?: boolean;
  /**
   * Other sources the dialog found carrying this title, to be judged and followed once the listing exists
   * (lib/autoFollow.ts). Results land on the job card, never on this answer. Only the add route passes it.
   */
  alsoFollow?: FollowCandidate[];
  /** Who is adding, for the follow audit lines; the follower rows themselves are written as automatic. */
  userId?: string | null;
  req?: FastifyRequest;
  /** Which sources THIS viewer may reach; a candidate outside it is reported `unavailable` and never asked. */
  sourceAllowed?: (source: string) => boolean;
}): Promise<AddResult> {
  const { source, sourceId, force, chapterCount, chapterFrom, autoUpdate } = opts;
  const src = source ? getSource(source) : null;
  if (!src || !sourceId) return { ok: false, status: 400, error: 'bad_request' };
  if (await isDisabled(source!)) return { ok: false, status: 403, error: 'disabled', message: `${src.name} is disabled by the admin.` };

  // The only network work left inline. It decides what to TELL the caller -- does it exist, is it a
  // duplicate, has it any chapters -- so it cannot move behind the reply. Shared with `/api/sources/detail`,
  // which the add dialog calls seconds earlier for the very same two things: without that, opening the
  // dialog and pressing Add paid for four challenge solves to learn two facts.
  const { series, chapters } = await seriesAndChapters(src, sourceId);
  // No title, no add. This used to fall back to the literal string 'Series', which becomes the folder --
  // so a `getSeries` that timed out while `listChapters` succeeded filed the title under `<Source>/Series`,
  // and the NEXT one to do that was told "already in library" and quietly merged into the same shelf.
  // A network hiccup could therefore collapse unrelated titles into one, which is library corruption rather
  // than a failed add, and nothing anywhere would have said so.
  const title = series?.title?.trim();
  if (!title) {
    return {
      ok: false, status: 503, error: 'no_title',
      message: `${src.name} did not return this title just now. Try again in a moment.`,
    };
  }
  // ⚠️ Windows: the source's name is the first folder, and a custom site's name is whatever the admin typed --
  // `Site: EN` is not a legal Windows name at all (the colon names a data stream) and `CON` or a trailing dot
  // is one Explorer cannot open -- so there it gets the same treatment as the title. Linux keeps the name
  // exactly: every folder already on a server is spelled that way.
  const srcDir = process.platform === 'win32' ? sanitize(src.name) : src.name;
  let folder = `${srcDir}/${sanitize(title)}`;
  // ⚠️ Desktop, case-insensitive disks (NTFS, APFS): a source that now spells the title `Solo leveling`
  // still downloads into the existing `Solo Leveling` folder, and the scanner reads that folder back with
  // its on-disk spelling -- so a row keyed on the new spelling never met its own chapters, and the series
  // split in two. Reuse the spelling already stored, then the one already on disk; only a folder that
  // exists nowhere keeps the new one. The server's disks are case-sensitive and keep the exact match.
  if (isDesktop()) {
    const stored = await one<{ folder: string }>(
      'SELECT folder FROM lib_series WHERE lower(folder) = lower($1) ORDER BY (deleted_at IS NOT NULL), created_at LIMIT 1', [folder]);
    folder = stored?.folder ?? await diskSpelling([DL_ROOT, LIBRARY_ROOT], folder);
  }

  // A deleted series does not count as present: re-adding it is how you undo a delete from the app side.
  const existing = await one<{ id: string; deleted_at: string | null }>(
    'SELECT id, deleted_at FROM lib_series WHERE folder = $1', [folder]);
  if (existing?.deleted_at) {
    await q('UPDATE lib_series SET deleted_at = NULL WHERE id = $1', [existing.id]).catch(() => {});
  }
  if (existing && !existing.deleted_at) {
    return { ok: true, status: 200, title, folder, chapters: 0, seriesId: existing.id, message: 'already in library' };
  }
  if (!force) {
    // ⚠️ `visibleToAll` stays: this asks "would adding this be a duplicate on THIS SERVER", which is a
    // property of the server, not of the person asking (the same reasoning as `inLibrary` above), so it
    // has to catch a copy in a library the caller cannot open. The id now comes back with it so the
    // dialog can offer "Open it" -- and precisely because the row may be one the caller cannot see, the
    // route gates the id on `seriesVisible` before it answers. The title and the source were always
    // answered here and are unchanged.
    const dup = await one<{ id: string; title: string; source: string }>(
      `SELECT id, title, source FROM lib_series
        WHERE lower(regexp_replace(title, '[^a-zA-Z0-9]', '', 'g')) = $1 AND folder <> $2
          AND ${visibleToAll('lib_series')} LIMIT 1`,
      [norm(title), folder]);
    if (dup) return { ok: false, status: 409, error: 'duplicate', existing: dup, message: `You already have "${dup.title}" from ${dup.source}. Add this copy anyway?` };
  }

  // One copy per chapter number, chosen under the GLOBAL preferences: the series row does not exist yet,
  // so there is nothing per-series to merge, and patience is 0 because a person is waiting on this add.
  // The blacklist has to apply here and not only in the sweep. The updater never replaces a chapter that
  // is already on disk, so a blocked group's copy taken at add time -- the first row a source lists is as
  // often the group nobody wanted as the one they did -- would be locked in for the life of the series.
  const prefs = await effectivePrefsFor(null, 0);
  const { releases: chosen } = chooseReleases(chapters, prefs);
  // The description as the page will show it: MangaDex writes Markdown, and this is what goes into every
  // ComicInfo the downloader writes and, through the scanner, into lib_series.summary.
  const meta = { series: title, summary: cleanDescription(series?.summary), author: series?.author, genres: series?.genres, url: series?.url, status: series?.status };

  /**
   * "Nothing yet": the series is created and followed, and no chapter is fetched.
   *
   * ⚠️ The row has to be written HERE. Every other add lets persistScan mint it from the first chapter's
   * folder, but findSeriesDirs only registers a directory that directly holds chapters (library.ts), so a
   * folder with nothing in it -- there is not even a folder yet -- would never become a row, and the add
   * would have created nothing to follow. The columns are the ones persistScan writes plus the routing
   * stamps the normal path adds afterwards; `library_id` is the same `libraryIdFor` answer persistScan would
   * pick for a brand-new folder, so when the first chapter arrives its `ON CONFLICT (library_id, folder)`
   * lands on THIS row and updates it in place rather than minting a second id -- and so the row sits in
   * the library its folder says it is in, as every scanned row does.
   *
   * The floor is a hair ABOVE the newest listed number, not at it: `chapter_floor` is inclusive from below
   * (`number < floor` is below, seriesListing.ts; `number >= floor` is wanted, updater.ts), so a floor of
   * `max + 0.001` puts every number the source lists today below the sweep's scope and the next release --
   * `max + 0.5`, `max + 1` -- inside it. A chapter numbered between `max` and `max + 0.001` would read as
   * older; no real numbering does that, and the openapi description says so. NULL when the source lists
   * nothing: there is nothing to be above, and every future chapter is wanted. An empty listing is not
   * `no_chapters` here -- an announced title with no chapters yet is the one this add exists for.
   *
   * No job, no download, no persistScan: the listing and the cover are written as the normal path writes
   * them, and the AniList art call runs as it does for every add. Re-adding hits the `existing` check above.
   * The next sweep (or a person fetching from the series page) creates the folder through the downloader's
   * mkdir, and persistScan then finds the row by folder.
   *
   * ⚠️ A row this folder already has is REVIVED, not shadowed. `existing` reaches this point only when the
   * row was deleted and the check above has just un-deleted it -- and the unique index is (library_id,
   * folder), so a plain INSERT answered 23505 for a series removed from the library and added back as
   * "nothing yet", AFTER the un-delete had already put it back: the dialog read "Add failed. Try another
   * source." for a series that was in the library again, and the next tap read "already in library". The
   * conflict lands on that row and refreshes its routing in place, so its id -- and every favourite, note
   * and read mark hung on it -- survives, as persistScan's own upsert keeps them across a rescan. The
   * library has to be the row's OWN for the conflict to find it: an admin can move a series to a library
   * its path would not pick (a deliberate UPDATE, library.ts), and `libraryIdFor` would then mint a second
   * row of the same folder one library over, which is exactly the stranding the index exists to stop.
   * Only a brand-new folder is assigned by path, as persistScan assigns one.
   *
   * Stamped as CHECKED, as stampChecked in updater.ts stamps a row after every sweep: this add has just
   * asked the source. Left NULL, the series page read `not checked yet` above a run row that listed the
   * very chapters this check had found, and the sources sheet showed no count and no "checked {ago}",
   * until the first sweep reached the row. `source_chapters` is the chooser's count -- one per number,
   * what the sweep stamps -- and `source_missing` is 0: every listed number is below the floor, so the
   * sweep wants none of them.
   */
  if (chapterFrom === 'none') {
    const floor = chosen.length ? Math.max(...chosen.map((c) => c.number)) + 0.001 : null;
    const libs = await q<LibraryRow>('SELECT id, path FROM libraries ORDER BY length(path) DESC');
    const libraryId = existing
      ? (await one<{ library_id: string }>('SELECT library_id FROM lib_series WHERE id = $1', [existing.id]))?.library_id ?? libraryIdFor(folder, libs)
      : libraryIdFor(folder, libs);
    const { id } = (await q<{ id: string }>(
      `INSERT INTO lib_series (id, source, title, summary, author, status, genres, web, folder, books_count, library_id, scanned_at,
                               auto_update, source_id, source_series_id, chapter_floor, source_checked_at, source_chapters, source_missing)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,now(),$11,$12,$13,$14,now(),$15,0)
       ON CONFLICT (library_id, folder) DO UPDATE SET
         auto_update = EXCLUDED.auto_update, source_id = EXCLUDED.source_id, source_series_id = EXCLUDED.source_series_id,
         chapter_floor = EXCLUDED.chapter_floor, scanned_at = now(), deleted_at = NULL,
         source_checked_at = now(), source_chapters = EXCLUDED.source_chapters, source_missing = EXCLUDED.source_missing
       RETURNING id`,
      [newSeriesId(), src.name, title, meta.summary || null, meta.author ?? null, meta.status ?? null, meta.genres ?? [], meta.url ?? null,
       folder, libraryId, autoUpdate !== false, source, sourceId, floor, chosen.length],
    ))[0];
    await replaceListing(id, listingRows(chapters.map((c) => ({ ...c, source: source! })), chosen, new Set(), source!, releaseOrder(prefs))).catch(() => {});
    // The other sources are judged only now, against the listing above: it is what stands in for "what
    // we hold" on a series that holds nothing. A nothing-yet add has no download and so no card, so one
    // is minted purely to carry the results to the dialog's poll -- and only when there is something to
    // judge, as "nothing was fetched, queued or created" is what a plain nothing-yet add promises.
    if (opts.alsoFollow?.length) {
      jobs.set(folder, { title, total: 0, done: 0, status: 'done' });
      judgeAlsoFollow(folder, id, opts);
    }
    if (series?.coverUrl) {
      await q(`INSERT INTO series_art (series_id, cover) VALUES ($1, $2)
        ON CONFLICT (series_id) DO UPDATE SET cover = COALESCE(series_art.cover, EXCLUDED.cover)`, [id, series.coverUrl]).catch(() => {});
    }
    fetchAniListArt(title)
      .then((a) => q(`INSERT INTO series_art (series_id, banner, cover) VALUES ($1, $2, $3)
        ON CONFLICT (series_id) DO UPDATE SET banner = COALESCE(series_art.banner, EXCLUDED.banner), cover = COALESCE(series_art.cover, EXCLUDED.cover)`, [id, a.banner, a.cover]))
      .catch(() => {});
    return { ok: true, status: 200, title, folder, chapters: 0, started: false, nothing: true, seriesId: id };
  }

  if (!chosen.length) return { ok: false, status: 404, error: 'no_chapters', message: 'No readable chapters for this title on this source. Try a different source.' };
  const selected = selectChapters(chosen, chapterCount, chapterFrom);

  /**
   * What the library ALREADY holds under this folder, so an add never downloads a chapter that is here (#65).
   *
   * `deleteSeries` (lib/libraryAdmin.ts) only stamps `lib_series.deleted_at` and leaves every `lib_books`
   * row alive, so Remove + "add it again with all chapters" -- which is the app's own advice when a series
   * looks wrong -- re-fetched the whole back catalogue and then filed every chapter a SECOND time:
   * persistScan merges both roots onto one series row by folder, so `Official_Chapter 1.cbz` under the read
   * library and `Chapter 1.cbz` under the download root are two rows with the same number. On the owner's
   * install that is 33,854 chapters under the read-only root, 30 series of which exist ONLY there.
   *
   * Three deliberate decisions:
   *  - By FOLDER, not by `existing?.id`: the folder is what persistScan keys on, and the row may predate
   *    this add entirely. A series the scanner found in the read library was never added through Discover,
   *    so `existing` is null for it -- and that is exactly the case that re-downloads the most.
   *  - `pruned_at IS NULL`, deliberately NOT `heldBooks()` (lib/chapterCleanup.ts). The sweep counts a
   *    Delete-files tombstone as HELD so it does not undo a deliberate deletion every night; an add is a
   *    person asking for those chapters NOW, so a tombstone must be fetched again. This is the one place
   *    in the product where the two rules differ, and it differs on purpose.
   *  - BOTH roots, because persistScan merges them onto the one row (lib/library.ts): the read-only
   *    library is where the missing chapters live, and the path check in lib/downloader.ts can only ever
   *    see DL_ROOT, under one filename convention.
   * The RAW number, as the sweep's own have-set reads it (lib/updater.ts): these numbers came out of a
   * source listing and are compared against one.
   * ⚠️ A failure here reads as "we hold nothing" and the add fetches everything, which is what it did
   * before this existed. Fetching twice is the old bug; skipping a chapter nobody holds would be a new one.
   */
  const have = new Set((await q<{ number: number }>(
    `SELECT DISTINCT b.number FROM lib_books b JOIN lib_series s ON s.id = b.series_id
      WHERE s.folder = $1 AND b.pruned_at IS NULL AND b.number IS NOT NULL`,
    [folder],
  ).catch(() => [])).map((r) => Number(r.number)));
  const toFetch = selected.filter((c) => !have.has(c.number));

  // "Latest 25 of 200" leaves 1..175 on the source that we do not hold, and the updater treats every
  // chapter it lists that we lack as missing, oldest first. Without this floor the sweep would backfill
  // those 175 five at a time, night after night, with each new release queued behind them -- the exact
  // opposite of what a person who picked "latest" asked for. Below the floor is left to "Find missing
  // chapters", which offers that run from the series' own source. Written on every add, NULL included: a
  // series soft-deleted and added again as "All" must not keep the floor from its earlier life, or a
  // download that stops part-way leaves a remainder the sweep will never touch. The lowest of the
  // selection, not its first element -- a plugin adapter is under no obligation to list ascending.
  // ⚠️ From `selected` and never from `toFetch`: the floor records what the person ASKED for, and a
  // re-add of a series we already hold in full would otherwise floor it at its own maximum and the sweep
  // would stop fetching anything. Computed here, above both writers, so the two cannot drift.
  const floor = chapterFrom === 'newest' && selected.length < chosen.length
    ? Math.min(...selected.map((c) => c.number)) : null;

  /**
   * Nothing left to fetch: every chapter the person selected is already in the library.
   *
   * ⚠️ This branch is not an optimisation, it is a correctness requirement. Everything an add owes the
   * series row -- the routing stamps, the listing, the cover and the AniList art -- is written inside
   * `run()` AFTER the first chapter lands, so with `toFetch` empty and no branch here the add would call
   * `fetchOne(undefined)`, have the throw swallowed into `blockReason = null`, and answer 422 "this title
   * may be licensed" for a series we hold in full -- while the row it just revived kept no source, no
   * floor and no listing. So the stamping is done here directly, in the same order and best-effort as in
   * the run, and the caller is told plainly how many chapters were already here.
   */
  if (!toFetch.length) {
    // By folder, as the run reads it after its own scan: the row exists by construction here, because a
    // non-empty have-set is rows joined to a series with this folder.
    const heldId = (await q<{ id: string }>('SELECT id FROM lib_series WHERE folder = $1', [folder]).catch(() => []))[0]?.id;
    await q('UPDATE lib_series SET auto_update = $1, source_id = $2, source_series_id = $3, chapter_floor = $5 WHERE folder = $4',
      [autoUpdate !== false, source, sourceId, folder, floor]).catch(() => {});
    // The same call the run makes on its full selection, and for the same reason: these dates are the
    // source's own, and the chapters they belong to are here -- they were simply fetched by somebody else.
    await setBookDates(folder, selected).catch(() => {});
    if (heldId) {
      await replaceListing(heldId, listingRows(chapters.map((c) => ({ ...c, source: source! })), chosen, new Set(), source!, releaseOrder(prefs))).catch(() => {});
      // As on the nothing-yet branch: no download means no card, so one is minted purely to carry the
      // judgement to the dialog's poll, and only when there is something to judge.
      if (opts.alsoFollow?.length) {
        jobs.set(folder, { title, total: 0, done: 0, status: 'done', seriesId: heldId });
        judgeAlsoFollow(folder, heldId, opts);
      }
    }
    if (series?.coverUrl) {
      await q(`INSERT INTO series_art (series_id, cover) SELECT id, $1 FROM lib_series WHERE folder = $2
        ON CONFLICT (series_id) DO UPDATE SET cover = COALESCE(series_art.cover, EXCLUDED.cover)`, [series.coverUrl, folder]).catch(() => {});
    }
    fetchAniListArt(title)
      .then((a) => q(`INSERT INTO series_art (series_id, banner, cover) SELECT id, $1, $2 FROM lib_series WHERE folder = $3
        ON CONFLICT (series_id) DO UPDATE SET banner = COALESCE(series_art.banner, EXCLUDED.banner), cover = COALESCE(series_art.cover, EXCLUDED.cover)`, [a.banner, a.cover, folder]))
      .catch(() => {});
    return { ok: true, status: 200, title, folder, chapters: 0, started: false, alreadyHere: selected.length, seriesId: heldId };
  }

  jobs.set(folder, { title, total: toFetch.length, done: 0, status: 'downloading' });

  /**
   * Everything from here is the WORK, as opposed to the decision.
   *
   * It used to run before the reply, which is why the button sat on "Working…" for up to a minute: the
   * first chapter is fetched a page at a time, up to 45s each, behind a queue with no bound, and on a
   * Cloudflare source every step is a real challenge solve. The job row already existed by this point, so
   * the Discover strip knew the download had started while the caller was still waiting to be told.
   */
  const run = async (): Promise<AddResult> => {
    // Which chapters this run wrote, for the provenance stamp. Only what LANDED, never the selection: a
    // copy the downloader skipped because the file was already there is somebody else's work.
    const landed: Array<{ number: number; scanlator?: string; source?: string; missing?: number[] }> = [];
    // The add has one source by definition, but it still goes through the same policy as every other
    // download path: pacing, refusal accounting and an explicit partial hold all live in the helper. There
    // are deliberately no alternates and no hunt here -- no followed series exists until chapter one has
    // been scanned, and an Add from one named source must not quietly become an Add from another.
    const refusing = new Set<string>();
    const fetchOne = (chapter: SourceChapter) => downloadWithFallback({
      // A brand-new add has no lib_series id until persistScan sees chapter one. The helper does not query
      // by this id; keeping the field empty is more honest than inventing an id that persistScan will not use.
      seriesId: existing?.id ?? '', title, folder, meta,
      chapter: { ...chapter, source: source! },
      alternates: async () => [], refusing, allowed: opts.sourceAllowed, hunt: undefined,
    });
    let firstPages = 0; let blockReason: string | null = null; let diskFull: string | null = null;
    try {
      // `toFetch`, not `selected`: the first chapter this run actually has to go and get. A selection
      // whose first chapters are already in the library starts at the first one that is not (#65).
      const out = await fetchOne(toFetch[0]);
      if (out.kind === 'landed' || out.kind === 'partial') {
        firstPages = out.pages;
        landed.push({
          number: toFetch[0].number, scanlator: out.chapterUsed.scanlator, source: out.via,
          ...(out.kind === 'partial' ? { missing: out.missing.map((i) => i + 1) } : {}),
        });
        if (out.kind === 'partial') {
          const j = jobs.get(folder);
          if (j) {
            j.partial = (j.partial ?? 0) + 1;
            j.reason = `Chapter ${toFetch[0].number} saved with ${out.missing.length} page${out.missing.length === 1 ? '' : 's'} missing`;
          }
        }
      } else if (out.kind === 'skipped' && out.why === 'on_disk') {
        firstPages = 1;
      } else if (out.kind === 'failed') {
        blockReason = out.err?.blockStatus || null;
      }
    }
    catch (e: any) { blockReason = e?.blockStatus || null; diskFull = e?.diskFull ? String(e.message) : null; }
    if (!firstPages) {
      // A full disk used to read as "this title may be licensed", which sends a person off to try another
      // source for a problem no source can fix.
      const why = diskFull
        ? `Not enough free space to download: ${diskFull}.`
        : blockReason
        ? `${src.name} is currently ${blockReason === 'rate_limited' ? 'rate-limiting' : blockReason === 'blocked' ? 'blocking' : 'unreachable for'} downloads.`
        : 'No downloadable chapters here — this title may be licensed or hosted externally on this source.';
      if (opts.wait === false) {
        // Detached: the caller has already been told the download started, so this card IS the failure
        // report. It is deliberately not swept -- see sweepJobs -- and is dismissed by hand.
        const j = jobs.get(folder); if (j) { j.status = 'error'; j.reason = why; j.finishedAt = Date.now(); }
      } else {
        // Awaited: the caller gets a real HTTP answer and has its own reporting, so leaving a card behind
        // would just be noise -- the bulk importer would strand one per failed title.
        jobs.delete(folder);
      }
      if (diskFull) return { ok: false, status: 507, error: 'disk_full', message: why };
      if (blockReason) {
        return { ok: false, status: 429, error: 'blocked', blockStatus: blockReason, message: `${why} Wait a bit or pick another source.` };
      }
      return { ok: false, status: 422, error: 'undownloadable', message: `${why} Try a different source.` };
    }
    const j0 = jobs.get(folder); if (j0) j0.done = 1;
    await persistScan().catch(() => {});
    await setBookDates(folder, selected).catch(() => {});
    await setBookMeta(folder, landed).catch(() => {});
    // The floor the person's selection earns, computed above the "nothing left to fetch" branch so both
    // writers use the one expression -- and from `selected`, which is what was asked for.
    await q('UPDATE lib_series SET auto_update = $1, source_id = $2, source_series_id = $3, chapter_floor = $5 WHERE folder = $4',
      [autoUpdate !== false, source, sourceId, folder, floor]).catch(() => {});
    // The listing the series page and "Who scanlates this" read is written here from the chapters this add
    // already fetched -- no second call to the source -- so a title opened straight from Discover shows
    // its groups and versions at once instead of only what is on disk until the sweep reaches it. Held is
    // empty on purpose: the add ran with patience 0. Best effort, like every stamp above.
    const seriesId = (await q<{ id: string }>('SELECT id FROM lib_series WHERE folder = $1', [folder]).catch(() => []))[0]?.id;
    if (seriesId) {
      // The dialog's "Open in library" navigates by this (#67). A fresh download had no row to name when
      // the add was answered -- persistScan minted it from the chapter above -- so the id reaches the
      // dialog on the card it is already polling, rather than through a title search that can find the
      // wrong series. Set before the listing and the judgement, because neither is waited for.
      const card = jobs.get(folder); if (card) card.seriesId = seriesId;
      await replaceListing(seriesId, listingRows(chapters.map((c) => ({ ...c, source: source! })), chosen, new Set(), source!, releaseOrder(prefs))).catch(() => {});
      // Only once the listing is written, and only from here: the row did not exist when the dialog was
      // answered (persistScan minted it from chapter 1 above), and the judgement measures against this
      // listing -- against `lib_books` it would see one chapter and refuse everything as `too_few_listed`
      // (autoFollow.int.test.ts, "a download add carries the results on its job card"). Detached; the
      // loop below does not wait for it.
      judgeAlsoFollow(folder, seriesId, opts);
    }
    if (series?.coverUrl) {
      await q(`INSERT INTO series_art (series_id, cover) SELECT id, $1 FROM lib_series WHERE folder = $2
        ON CONFLICT (series_id) DO UPDATE SET cover = COALESCE(series_art.cover, EXCLUDED.cover)`, [series.coverUrl, folder]).catch(() => {});
    }
    fetchAniListArt(title)
      .then((a) => q(`INSERT INTO series_art (series_id, banner, cover) SELECT id, $1, $2 FROM lib_series WHERE folder = $3
        ON CONFLICT (series_id) DO UPDATE SET banner = COALESCE(series_art.banner, EXCLUDED.banner), cover = COALESCE(series_art.cover, EXCLUDED.cover)`, [a.banner, a.cover, folder]))
      .catch(() => {});
    void (async () => {
      let failures = 0;
      for (const ch of toFetch.slice(1)) {
        let out: Awaited<ReturnType<typeof downloadWithFallback>>;
        try {
          out = await fetchOne(ch);
        } catch (e: any) {
          const j = jobs.get(folder);
          if (e?.diskFull) {
            if (j) {
              j.status = 'error';
              j.reason = `Not enough free space: ${String(e.message)}. ${j.done} of ${j.total} chapters saved.`;
              j.finishedAt = Date.now();
            }
            break;
          }
          failures++;
          if (seriesId) await noteChapterFailure({ seriesId, title, number: ch.number, sourceId: source!, err: e }).catch(() => {});
          if (j) j.reason = `${failures} chapter${failures === 1 ? '' : 's'} could not be saved: ${String(e?.message || e).slice(0, 120)}`;
          continue;
        }
        const j = jobs.get(folder);
        if (out.kind === 'landed' || out.kind === 'partial') {
          landed.push({
            number: ch.number, scanlator: out.chapterUsed.scanlator, source: out.via,
            ...(out.kind === 'partial' ? { missing: out.missing.map((i: number) => i + 1) } : {}),
          });
          if (j) {
            j.done++;
            if (out.kind === 'partial') {
              j.partial = (j.partial ?? 0) + 1;
              j.reason = `Chapter ${ch.number} saved with ${out.missing.length} page${out.missing.length === 1 ? '' : 's'} missing`;
            }
            if (j.done % 5 === 0) await persistScan().catch(() => {});
          }
          continue;
        }
        if (out.kind === 'skipped') {
          // An old file in a revived folder is part of the requested result; a refusal is not. With no
          // alternate source the latter leaves every remaining chapter nowhere to go, so stop at one strike.
          if (out.why === 'on_disk') {
            if (j) { j.done++; if (j.done % 5 === 0) await persistScan().catch(() => {}); }
            continue;
          }
          if (j) {
            j.status = 'error';
            j.reason = `${src.name} stopped part-way. ${j.done} of ${j.total} chapters saved.`;
            j.finishedAt = Date.now();
          }
          break;
        }

        failures++;
        if (seriesId) await noteChapterFailure({ seriesId, title, number: ch.number, sourceId: out.via, err: out.err }).catch(() => {});
        if (refusing.has(out.via)) {
          if (j) {
            const status = out.err?.blockStatus;
            j.status = 'error';
            j.reason = `${src.name} stopped part-way: it is ${status === 'rate_limited' ? 'rate-limiting' : status === 'blocked' ? 'blocking' : 'unreachable for'} downloads. ${j.done} of ${j.total} chapters saved.`;
            j.finishedAt = Date.now();
          }
          break;
        }
        // ANY other failure -- a permission error, a chapter with no readable pages -- must not advance
        // the bar. The next chapter may still be healthy, so keep going as the old loop did.
        if (j) j.reason = `${failures} chapter${failures === 1 ? '' : 's'} could not be saved: ${String(out.err?.message || out.err).slice(0, 120)}`;
      }
      await persistScan().catch(() => {});
      await setBookDates(folder, selected).catch(() => {});
      await setBookMeta(folder, landed).catch(() => {});
      const j = jobs.get(folder);
      if (j && j.status !== 'error') {
        // "Done" has to mean everything landed. A run that lost chapters ends as an error carrying the
        // count, because a green tick over a short library is worse than no tick at all: it tells you to
        // stop looking.
        j.status = failures ? 'error' : 'done';
        j.finishedAt = Date.now();
      }
    })();
    // `chapters` is what this add will FETCH, which is why it counts `toFetch`: a re-add that finds half
    // the run on disk is downloading half a run, and telling the dialog otherwise would put a progress
    // bar over a count the job can never reach. An awaited caller is answered after the scan above, so
    // the id is known here whatever the branch -- `existing?.id` is only the revive case (#67).
    return { ok: true, status: 200, title, folder, chapters: toFetch.length, seriesId: seriesId ?? existing?.id };
  };

  if (opts.wait !== false) return run();
  // Detached. `started` is what lets the caller say "downloading now" rather than guessing from
  // `chapters === 0`, which is the only signal an already-in-library answer has ever had.
  //
  // ⚠️ The only branch that cannot answer with a series id: this returns before `run()` has fetched
  // anything, so on a first add persistScan has not minted the row yet. A revive already has its id;
  // everything else reads it off the job card once chapter one is scanned (`Job.seriesId`).
  void run().catch(() => {});
  return { ok: true, status: 200, title, folder, chapters: toFetch.length, started: true, seriesId: existing?.id };
}

/**
 * Map a Mihon backup entry's source id to an installed, enabled Suwayomi extension adapter, if any.
 *
 * Suwayomi stores the very same 64-bit Mihon source id in `suwayomi_sources.source_id` (written by
 * `remember()` in lib/sources/suwayomi/register.ts), as a decimal string. Whether that string is the signed
 * or unsigned rendering of the id depends on how the source plugin computed its hash, so both forms parsed
 * out of the backup (`BackupEntry.sourceIdUnsigned` / `sourceIdSigned`) are checked. Only Suwayomi-backed
 * sources can match here — MangaDex, engine sites and custom sites have no Mihon source id to compare
 * against, and fall through to title search in `resolveCandidate` below like they always did.
 */
export async function mihonSourceToAdapter(ids: { sourceIdUnsigned?: string; sourceIdSigned?: string }): Promise<string | null> {
  const candidates = [...new Set([ids.sourceIdUnsigned, ids.sourceIdSigned].filter((x): x is string => !!x))];
  if (!candidates.length) return null;
  const rows = await q<{ source_id: string }>(
    'SELECT source_id FROM suwayomi_sources WHERE source_id = ANY($1) AND enabled = true',
    [candidates],
  ).catch(() => []);
  if (!rows.length) return null;
  const id = swAdapterId(rows[0].source_id);
  if (await isDisabled(id).catch(() => false)) return null;
  return getSource(id) ? id : null;
}

export interface ResolvedCandidate {
  source: string; sourceId: string; title: string; coverUrl?: string; confidence: MatchConfidence;
  /** The alternate title the match was found under; null when the search title itself found it. */
  matchedVia: string | null;
}

/** How many of an entry's other names one resolve tries: each is one more outbound search per source that misses. */
const RESOLVE_ALT_TITLES = 3;

/**
 * A Mihon manga url and a Suwayomi `path` for the same entry can differ by a leading or trailing slash
 * (extensions are inconsistent about both), and by nothing else -- so that is all this forgives. Anything
 * looser (case, query string, host) would let two different entries compare equal, which is the one
 * mistake the url exists to rule out.
 */
export const normPath = (p: string) => p.trim().replace(/^\/+/, '').replace(/\/+$/, '');

/**
 * Best cross-source match for one import-batch title, source-id-aware.
 *
 * If the backup entry says which Mihon source it came from and that source is installed here, THAT source
 * is searched first. A hit there is `same_source` ONLY when its extension-relative `path` equals the url
 * the backup stored for the manga: source id + url is Mihon's identity for a manga, so that pair proves
 * "the same catalogue entry" even after the site retitled it. Without that proof a home-source hit is
 * judged by title like any other source's (`pickBestScored`'s own tiers), and then the preferred-order
 * search across every other source runs, same as `findBestMatch`.
 *
 * ⚠️ NEVER take the home source's first result when nothing matched: a source's first result for a title it
 * lacks is an unrelated manga (the "wrong manga" bug `pickBest` exists to prevent), and here it would have
 * carried the top confidence tier, rendered green, and been hidden from "Needs attention". No confident
 * hit anywhere means `null`, and the row stays `unresolved` for a person to search by hand.
 *
 * `altTitles` (a tracker entry's romaji title and synonyms) are searched AFTER the search title, in order,
 * and the first confident tier under any of them wins: a source that carries "Attack on Titan" only as
 * "Shingeki no Kyojin" is the same match, and without the second try every such row sat in "no match
 * found". Each hit is scored against the term that was searched, and `matchedVia` says which alternate
 * found it (null for the search title) so the review row can say so instead of flagging a romaji hit as a
 * wrong pick. Capped at `RESOLVE_ALT_TITLES`: every alternate is one more outbound search on every source
 * that misses, and the batch already runs several rows in parallel.
 *
 * ⚠️ The TERM loop is the outer one in the cross-source pass: the title on every source, then the first
 * alternate on every source, and so on. Nested the other way (every term on source 1, then source 2), an
 * alternate's weak `contains` hit on the first source pre-empted an exact hit for the title on the second
 * -- AniList synonyms are user-contributed ("AoT", "Atak Tytanów"), and "AoT" on a site that lacks the
 * series answered "Chaotic Love Story" while the next site carried "Attack on Titan" exactly and was never
 * asked. The home source keeps its own block above: a backup names its own source and carries no alternates,
 * so there is nothing to interleave.
 */
export async function resolveCandidate(entry: { title: string; altTitles?: string[]; url?: string; sourceIdUnsigned?: string; sourceIdSigned?: string }): Promise<ResolvedCandidate | null> {
  // The search title first, then each distinct alternate; an alternate that normalises to the title (or to
  // an earlier alternate) would only repeat a search that already missed.
  const terms: string[] = [entry.title];
  for (const a of entry.altTitles ?? []) {
    if (terms.length - 1 >= RESOLVE_ALT_TITLES) break;
    const t = a.trim();
    if (t && !terms.some((x) => norm(x) === norm(t))) terms.push(t);
  }
  const viaOf = (term: string): string | null => (term === entry.title ? null : term);

  const home = await mihonSourceToAdapter(entry);
  if (home) {
    const src = getSource(home);
    if (src) {
      for (const term of terms) {
        try {
          const raw = await withTimeout(src.search(term), budgetFor(src, 20000));
          // The url proof only against the search title's results: a backup names ONE entry, and its
          // alternates (none today -- backups carry no synonyms) would prove nothing more.
          const want = term === entry.title && entry.url ? normPath(entry.url) : '';
          const byUrl = want ? raw.find((r) => !!r.sourceId && !!r.path && normPath(r.path) === want) : undefined;
          if (byUrl) return { source: home, sourceId: byUrl.sourceId, title: byUrl.title, coverUrl: byUrl.coverUrl, confidence: 'same_source', matchedVia: null };
          const best = pickBestScored(raw, term);
          if (best?.item.sourceId) return { source: home, sourceId: best.item.sourceId, title: best.item.title, coverUrl: best.item.coverUrl, confidence: best.confidence, matchedVia: viaOf(term) };
        } catch { /* fall through to the next term, then the cross-source search */ }
      }
    }
  }
  // The sources to ask, settled once: with the terms outside, the disabled check would otherwise run once
  // per term per source.
  const order: Array<{ id: string; src: NonNullable<ReturnType<typeof getSource>> }> = [];
  for (const id of findOrder()) {
    if (id === home) continue; // already tried above
    const src = getSource(id);
    if (!src) continue;
    if (await isDisabled(id).catch(() => false)) continue;
    order.push({ id, src });
  }
  for (const term of terms) {
    for (const { id, src } of order) {
      try {
        const best = pickBestScored(await withTimeout(src.search(term), budgetFor(src, 20000)), term);
        if (best?.item.sourceId) return { source: id, sourceId: best.item.sourceId, title: best.item.title, coverUrl: best.item.coverUrl, confidence: best.confidence, matchedVia: viaOf(term) };
      } catch { /* try the next source, then the next term */ }
    }
  }
  return null;
}

/** Best single cross-source match for a title (searches sources in preferred order, returns the first real hit). */
export async function findBestMatch(term: string): Promise<{ source: string; sourceId: string; title: string } | null> {
  const r = await resolveCandidate({ title: term });
  return r ? { source: r.source, sourceId: r.sourceId, title: r.title } : null;
}

export default async function sourceRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  /**
   * Every route in this file is "add something to the library", or a step towards it.
   *
   * `canDownload: false` was enforced in exactly one place in the entire server -- the final POST -- so a
   * denied account could still list every source, search them, browse their newest pages and read full
   * series detail. It only met a wall on the last button. One hook removes the whole surface, and folds in
   * the copy of this check that used to live inside `add`.
   *
   * Semantics are otherwise unchanged: only the literal `false` denies, an absent permission is allowed, and
   * admins are exempt. The one deliberate change is denying when the user row cannot be read, where the old
   * check fell through to allowed -- a database blip should not open the one route that writes to disk.
   */
  app.addHook('preHandler', async (req, reply) => {
    const me = await one<{ role: string; perms: { canDownload?: boolean } | null }>(
      'SELECT role, perms FROM users WHERE id = $1', [userIdOf(req)]).catch(() => null);
    if (!me) return reply.code(403).send({ error: 'forbidden', message: 'Could not check your permissions.' });
    if (me.role !== 'admin' && me.perms?.canDownload === false) {
      return reply.code(403).send({ error: 'forbidden', message: "You don't have permission to add series." });
    }
    // Resolved once per request, as in catalog.ts. Only `maxAgeRating` is read here, but taking the whole
    // context means this file cannot drift from everyone else's idea of who the viewer is.
    (req as any).viewCtx = await viewCtxFor(userIdOf(req), roleOf(req), { hideAdult: hideAdult(req) });
  });

  const vc = (req: FastifyRequest): ViewCtx => (req as any).viewCtx as ViewCtx;
  /** Same shape for every by-id rejection, and it does not say what is being withheld. */
  const denySource = (reply: FastifyReply) =>
    reply.code(403).send({ error: 'forbidden', message: 'That source is not available on this account.' });
  /** The sources this viewer may reach, in registry order. This is the ACCESS rule and nothing else. */
  const reachable = (req: FastifyRequest): SourceAdapter[] =>
    listSources().filter((s) => sourceAllowedFor(s, vc(req).maxAgeRating));
  /**
   * The sources this viewer may be SHOWN, in registry order: `reachable` minus the adult ones while the
   * "Show 18+" chip is off.
   *
   * This is lib/visibility.ts's `browsable()` / `visible()` split applied to the source registry, for the
   * same reason and with the same shape. `reachable` is `visible()`: an account capped below 18 may not
   * have an adult source at all, and every by-id route refuses it. `surfaceable` is `browsable()`: it
   * answers "do not put this in front of me unasked", it is a preference carried per request (`?adult=1`,
   * see `hideAdult`), and it applies only to routes that LIST sources or paint their covers. Without it the
   * chip hid 18+ libraries while Discover kept listing twelve adult providers and their newest covers --
   * issue #64, and docs/api.md promised the opposite in writing. `/api/sources/jobs` below already does
   * exactly this for download cards, keyed on the series folder; this is the same rule keyed on the source.
   *
   * ⚠️ Deliberately NOT applied to `fill/scan`, `detail` or `add`. Those are explicit acts on a series or a
   * source the person just named, and a series whose own source is adult must stay fillable and fetchable
   * while the chip is off -- hiding it there would break the library rather than tidy a screen, which is
   * the very line `browsable()` draws against `visible()`.
   */
  const surfaceable = (req: FastifyRequest): SourceAdapter[] => {
    // Through `sourceBrowsableFor` rather than `isNsfw` alone, so a source the admin NAMED as adult in
    // server_settings.adult_sources drops out too, even though its extension does not flag itself.
    const ctx = vc(req);
    return reachable(req).filter((s) => sourceBrowsableFor(s, ctx));
  };

  app.get('/api/sources', async (req) => {
    const health = new Map((await healthAll()).map((h) => [h.source_id, h]));
    // Which language a source serves is an operator's choice recorded per source, not a property of the
    // adapter (adapters are code), so it lives only in suwayomi_sources. Discover groups by it: forty-five
    // sources across thirty languages is a list nobody can use, and most of them are the same site repeated.
    // A 45-row read on a route the client already polls. `pkg_name`/`ext_name` ride along on the same read:
    // which extension package a source came out of is likewise something only the engine told us at
    // registration, and the Providers page folds one package's language variants into one card by it.
    const swRows = new Map(
      (await q<{ source_id: string; lang: string | null; pkg_name: string | null; ext_name: string | null }>(
        'SELECT source_id, lang, pkg_name, ext_name FROM suwayomi_sources WHERE enabled = true',
      ).catch(() => [])).map((r) => [r.source_id, r]),
    );
    /**
     * The extension behind an `sw:` source, or null for every other kind of source. When the engine gave
     * no package name -- rows remembered before the columns existed and not re-listed since -- the display
     * name minus its trailing ` (EN)` / ` (PT-BR)` / ` (ALL)` stands in as the name, with `pkgName` null so
     * the client knows it is grouping on a guess. The suffix is what Suwayomi appends to a multi-language
     * extension's variants, so stripping it is what makes "3Hentai (EN)" and "3Hentai (JA)" fold together.
     */
    // Only a SHORT, upper-case, letters-and-hyphens tag in the last bracket is a language suffix. Anything
    // else in brackets is part of the name: a site called "Manga (Reader)" must stay one word, not fold.
    const stripLangSuffix = (name: string): string => name.replace(/\s\((?:[A-Z]{2,3}(?:-[A-Z]{2,4})?|ALL)\)$/, '').trim() || name;
    const extensionOf = (s: SourceAdapter): { pkgName: string | null; name: string } | null => {
      if (!isSwAdapterId(s.id)) return null;
      const row = swRows.get(s.id.slice(SW_PREFIX.length));
      if (row?.pkg_name || row?.ext_name) return { pkgName: row.pkg_name ?? null, name: row.ext_name || stripLangSuffix(s.name) };
      return { pkgName: null, name: stripLangSuffix(s.name) };
    };
    // How many series the library actually holds from each source, keyed on the ADAPTER ID rather than the
    // display name. `lib_series.source` is the folder's parent, which is the name the source had when the
    // series was added, so renaming a source orphans its history: on this install the same adapter reads as
    // 13 under "Aqua Manga" and 176 under "Aqua Manga (EN)", when it is one source with 189. `source_id` is
    // written by addSeriesFromSource and is the id the ranking is applied to. NULL means "not from a
    // source" -- filed by hand, or imported -- which is not a vote for anything.
    const used = new Map(
      (await q<{ source_id: string; n: string }>(
        `SELECT source_id, count(*)::text AS n FROM lib_series s
          WHERE ${visibleToAll('s')} AND s.source_id IS NOT NULL GROUP BY source_id`,
      ).catch(() => [])).map((r) => [r.source_id, Number(r.n)]),
    );
    const now = Date.now();
    // Both taken from the same registry snapshot, so the count below and the list beside it can never
    // disagree about how many sources were dropped.
    const mayReach = reachable(req);
    const show = surfaceable(req);
    return {
      /**
       * How many sources this viewer may reach but is not being shown, i.e. the adult ones the chip is
       * hiding right now. It exists so Discover can render the reveal chip at all: `AdultToggle` otherwise
       * appears only where an 18+ LIBRARY exists, and an install with adult sources and no adult shelf
       * would lose those sources with no way to ask for them back.
       *
       * ⚠️ Counted as reachable minus surfaceable, never over the whole registry. For an account capped
       * below 18 `reachable` has already dropped every adult source, so this is 0 by construction and a
       * capped account cannot learn from a number what it is not allowed to be told by name.
       */
      hiddenAdult: mayReach.length - show.length,
      // An adult source is not merely hidden from the wall: it never appears in the list the client fans out
      // over, so a capped account cannot learn its id here and then ask for it directly. `surfaceable` adds
      // the reveal chip's own hide on top of that cap (#64) -- see its comment for why the two are separate.
      content: show.map((s) => {
        const h = health.get(s.id);
        const blocked = !!(h?.blocked_until && new Date(h.blocked_until).getTime() > now);
        const suspect = (h?.empty_streak ?? 0) >= EMPTY_SUSPECT || (h?.slow_streak ?? 0) >= EMPTY_SUSPECT;
        const d = (blocked || suspect) && h
          ? diagnose({
              status: h.status, lastError: h.last_error, consecutive: h.consecutive,
              lastOkAt: h.last_ok_at, emptyStreak: h.empty_streak ?? 0,
              blockedUntil: h.blocked_until, disabled: !!h.disabled,
              slowStreak: h.slow_streak ?? 0, budgetMs: LATEST_TIMEOUT,
            })
          : null;
        return {
          id: s.id,
          name: s.name,
          // null means "declares no single language", which is not the same as "serves none": a source
          // like MangaDex belongs in every group rather than in an orphan bucket. An adapter may now declare
          // one itself, which is how MangaDex -- hardcoded to ask for English -- stops joining all thirty.
          lang: s.lang ?? (isSwAdapterId(s.id) ? (swRows.get(s.id.slice(SW_PREFIX.length))?.lang ?? null) : null),
          // Which extension package an `sw:` source came out of; null for built-ins, packs and custom sites.
          // Providers groups by `pkgName` (or by `name` when that is null) so 3Hentai's twenty-nine language
          // variants are one card rather than twenty-nine.
          extension: extensionOf(s),
          latest: typeof s.latest === 'function',
          // Reported from the method's presence, exactly as `latest` is. A source without it simply
          // drops out of the wall while Popular is selected, the same way one without `latest` does.
          popular: typeof s.popular === 'function',
          // What the reader has actually used. Health-then-alphabetical put "18 Porn Comic" and "1Manga.co"
          // at the front of this install's English group while Aqua Manga -- 176 of its 214 series, answering
          // in 2.5s -- was never in the first six fetched.
          used: used.get(s.id) ?? 0,
          // `quiet` is new, and it is the one state that used to be unrepresentable. A source whose listing
          // has drifted answers 200 with an empty page and throws nothing, so it never earned a cooldown and
          // `status` stayed 'ok' forever while the wall kept fetching it first. `budgetFor` sorts on
          // `status !== 'ok'`, so naming it is all it takes to stop ranking it above sources that work.
          status: h?.disabled ? 'disabled' : blocked ? h!.status : suspect ? 'quiet' : 'ok',
          blockedUntil: blocked ? h!.blocked_until : null,
          // The PUBLIC sentence only, and only when something is actually wrong. Never `fix`, which names
          // containers and config files, and never `last_error`, which carries internal hostnames and ports.
          // This route is cached client-side under one query key that does not vary by account, so there is
          // deliberately no admin branch here: two shapes for one cache key leak on a shared device.
          note: d ? d.reason : null,
        };
      }),
    };
  });

  // GET /api/sources/status was here, and is deliberately gone. It answered any AUTHENTICATED caller (this
  // file's preHandler is `authenticate`, not `requireAdmin`) with the raw source_health row, `last_error`
  // included -- the very field the comment fifteen lines above forbids exposing, because it carries internal
  // hostnames and ports. Its own comment said "for the admin provider dashboard", and the admin dashboard
  // has always called the properly gated twin at GET /api/admin/sources (routes/admin.ts). Nothing else ever
  // called this one. Deleted rather than gated, because a second door to the same room is what went wrong.

  app.get('/api/sources/search', async (req, reply) => {
    const { source, q: query } = req.query as { source?: string; q?: string };
    const src = source ? getSource(source) : null;
    if (!src || !query?.trim()) return { content: [] };
    if (!sourceAllowedFor(src, vc(req).maxAgeRating)) return denySource(reply);
    // Reachable but not surfaceable: the chip is off and this source is adult. An empty page, NOT
    // `denySource` -- 403 is the permission answer and this is not a permission (the same account with
    // `?adult=1` gets the results), and `{ content: [] }` is already what this route answers for a source
    // that has nothing. The source is never even asked, so hiding it costs nothing outbound either.
    if (!surfaceable(req).some((s) => s.id === src.id)) return { content: [] };
    const raw = await src.search(query.trim()).catch(() => []);
    // dedupe by sourceId (duplicate ids collide on the React key → wrong cover/title on a card)
    const seen = new Set<string>();
    const results = raw.filter((r) => !!r.sourceId && !seen.has(r.sourceId) && (seen.add(r.sourceId), true)).slice(0, 24);
    // flag titles already in the library so the UI can mark them instead of offering a duplicate add
    const have = await inLibrary(results.map((r) => r.title));
    return { content: results.map((r) => ({ ...r, inLibrary: have.has(norm(r.title)) })) };
  });

  // Search a title across ALL enabled providers at once, grouped so one card carries every source that
  // has it — the UI then lets you choose which source to add from (like the trending flow).
  /**
   * What is missing from a series, and who could supply it.
   *
   * Read-only. Answers with a plan id; the chapter URLs stay on this side of the wire and the fill below
   * quotes the id back. The client therefore names a chapter NUMBER and nothing else, so no request can
   * point the downloader at content a person was never shown.
   *
   * POST rather than GET because it fans out across every reachable source, and a GET would be prefetchable
   * and service-worker-cacheable -- the same reasoning as `latestPage` above.
   */
  app.post('/api/sources/fill/scan', async (req, reply) => {
    const { seriesId, altTitle } = (req.body ?? {}) as { seriesId?: string; altTitle?: string };
    if (!seriesId) return reply.code(400).send({ error: 'bad_request' });

    // Visible to THIS viewer, not merely present: otherwise a capped member could learn about, and write
    // into, a series they are walled off from. Fails closed, as the permission hook above does.
    // One lookup, through visible(): it carries the deleted/merged rule, the per-library grant and the age
    // cap together, so this route cannot drift from the others by hand-writing part of it. Fails closed --
    // a database blip must not make a series someone cannot see fillable. visible(), NOT browsable(): this
    // acts on a series someone opened by id, and "Show 18+" is a surfacing preference, not a permission --
    // through browsable() "Find missing chapters" answered 404 on any series in an 18+ library (and, with
    // the configurable filter, on any series with a genre marked adult) whenever the switch was off.
    const p = new Params();
    const rows = await q<any>(
      `SELECT s.id, s.title, s.folder, s.source_id, s.source_series_id, s.summary, s.author, s.genres, s.web, s.status,
              s.chapter_floor, s.scanlator_prefs
         FROM lib_series s WHERE s.id = ${p.add(seriesId)} AND ${visible('s', vc(req), p)}`, p.values,
    ).then((r) => r, () => null);
    if (rows === null) return reply.code(503).send({ error: 'unavailable' });
    const s = rows[0];
    if (!s) return reply.code(404).send({ error: 'not_found' });

    // What this series HOLDS, by the one definition (lib/libraryNumbers.ts): a chapter an admin renumbered
    // counts under its new number, a chapter they deliberately deleted is not a hole to offer filling, and
    // a file the verify task found gone is. This query used to be a bare SELECT of the raw number over
    // every row, so the dialog offered to re-fetch a deletion and disagreed with the Health page next door
    // about which chapters were missing at all.
    const have = await haveNumbers(seriesId);
    // The sources the updater already merges into this series (series_sources), so the dialog can mark a
    // candidate as followed rather than offer to follow it twice.
    const following = (await q<{ source_id: string }>(
      'SELECT source_id FROM series_sources WHERE series_id = $1 ORDER BY created_at', [seriesId],
    ).catch(() => [])).map((r) => r.source_id);
    // Coverage measured against two chapters proves nothing at all: any long series covers them.
    if (have.length < MIN_HAVE) {
      return { seriesId, title: s.title, have: { count: have.length }, gaps: [], candidates: [], following,
        refusal: { code: 'too_few_chapters', message: 'Too few chapters here to match against another source.' } };
    }
    const gaps = gapsOf(have);

    // Candidates: the series' own source first (no cross-source guessing at all -- it is where the series
    // already comes from), then one best match per other reachable source.
    const terms = [...new Set([s.title, (altTitle || '').trim()].filter(Boolean))] as string[];
    // `reachable`, deliberately NOT `surfaceable`: filling is an explicit act on a series already in the
    // library, so the 18+ chip must not reach it -- a series whose own source is adult would otherwise
    // become unfillable the moment the chip is off, which is data loss dressed up as tidying (#64).
    const allowed = new Set(reachable(req).map((x) => x.id));
    const found: { source: string; name: string; sourceId: string; title: string; coverUrl?: string; pinned: boolean }[] = [];
    if (s.source_id && s.source_series_id && allowed.has(s.source_id)) {
      const own = getSource(s.source_id);
      if (own) found.push({ source: own.id, name: own.name, sourceId: s.source_series_id, title: s.title, pinned: true });
    }
    // Sources that were asked and did not answer, and sources never asked because enough already had the
    // title. Both are shown; neither is "does not have it", and the old scan called all of them `unreachable`.
    const unreachable: { source: string; name: string }[] = [];
    const notTried: { source: string; name: string }[] = [];
    const ownSrc = s.source_id ? getSource(s.source_id) : null;
    const order = scanOrder(
      findOrder().filter((id) => allowed.has(id)).map((id) => getSource(id)).filter((x): x is NonNullable<typeof x> => !!x),
      ownSrc ? { id: ownSrc.id, lang: ownSrc.lang } : null,
    );
    // A slot is held before the search starts, so the timeout measures the search and not the queue. The
    // queue is FIFO, so relevance order is the order sources actually get asked in.
    let inFlight = 0;
    const waiting: Array<() => void> = [];
    const slot = async () => { if (inFlight >= SCAN_CONCURRENCY) await new Promise<void>((r) => waiting.push(r)); inFlight++; };
    const free = () => { inFlight--; waiting.shift()?.(); };
    const enough = () => found.filter((f) => !f.pinned).length >= SCAN_ENOUGH;
    await Promise.all(order.map(async (id) => {
      if (found.some((f) => f.source === id && f.pinned)) return;
      await slot();
      try {
        const src = getSource(id);
        if (!src || await isDisabled(id).catch(() => false)) return;
        if (enough()) { notTried.push({ source: src.id, name: src.name }); return; }
        let failed = false;
        for (const term of terms) {
          try {
            const hit = pickBest(await withTimeout(src.search(term), budgetFor(src, SCAN_SEARCH_MS)), term);
            if (hit?.sourceId) {
              found.push({ source: src.id, name: src.name, sourceId: hit.sourceId, title: hit.title, coverUrl: hit.coverUrl, pinned: false });
              return;
            }
          } catch { failed = true; /* one source failing is not the scan failing -- but it must not be silent */ }
        }
        if (failed) unreachable.push({ source: src.id, name: src.name });
      } finally { free(); }
    }));

    // Only now, and only for sources that produced a match, do we pay for a chapter list. Routed through the
    // shared lookup so it reuses whatever the add dialog already fetched.
    const chapters = new Map<string, SourceChapter[]>();
    const candidates: PlanCandidate[] = [];
    // The series' own release preferences over the global ones, with patience off: a person is choosing
    // from this list now, and holding a chapter for a group that may never post here would read as "not
    // on this source".
    const prefs = await effectivePrefsFor(await readSeriesPrefs(seriesId), 0);
    // One read for every source, rather than one blockedNow() per candidate: the same row answers "is it
    // in a cooldown" and "what is its record", and the record is what the dialog was never told.
    const health = new Map((await healthAll().catch(() => [])).map((h) => [h.source_id, h]));
    await Promise.all(found.map(async (f) => {
      const src = getSource(f.source);
      if (!src) return;
      let raw: SourceChapter[] = [];
      let why: Refusal = 'ok';
      const h = health.get(f.source);
      if (h?.blocked_until && new Date(h.blocked_until).getTime() > Date.now()) why = 'blocked';
      else {
        try { raw = (await seriesAndChapters(src, f.sourceId)).chapters; }
        catch { why = 'no_chapters'; }
      }
      // One copy per number BEFORE the list is assessed or stored in the plan. `authorise` filters the
      // stored list by number, so a plan holding two copies of chapter 5 would answer a fill of [5] with
      // both: the second is skipped at the file check, but the job's total counts it, and the bar ends
      // one short of full on a fill that did everything it was asked.
      const list = chooseReleases(raw, prefs).releases;
      const nums = list.map((c) => c.number);
      // The run below a "Latest N" add is offered from the series' own source and nowhere else: this is the
      // dialog the add hint sends people to for the older chapters, and it must be able to deliver them.
      const a = assess(have, nums, { older: f.pinned && s.chapter_floor != null });
      chapters.set(planKey(f.source, f.sourceId), list);
      candidates.push({
        source: f.source, name: f.name, sourceSeriesId: f.sourceId, title: f.title, coverUrl: f.coverUrl,
        count: list.length, first: nums.length ? Math.min(...nums) : null, last: nums.length ? Math.max(...nums) : null,
        coverage: Math.round(a.coverage * 100) / 100, matched: a.matched,
        fillable: a.fillable, newer: a.newer, older: a.older,
        why: why === 'ok' ? verdict(a, list.length) : why,
        pinned: f.pinned,
        health: h && (h.status !== 'ok' || h.consecutive > 0)
          ? { status: h.status, consecutive: h.consecutive, lastFailAt: h.last_fail_at, lastOkAt: h.last_ok_at }
          : null,
      });
    }));

    for (const u of notTried) {
      candidates.push({
        source: u.source, name: u.name, sourceSeriesId: '', title: '',
        count: 0, first: null, last: null, coverage: 0, matched: 0,
        fillable: [], newer: [], older: [], why: 'not_tried', pinned: false,
      });
    }
    for (const u of unreachable) {
      candidates.push({
        source: u.source, name: u.name, sourceSeriesId: '', title: '',
        count: 0, first: null, last: null, coverage: 0, matched: 0,
        fillable: [], newer: [], older: [], why: 'unreachable', pinned: false,
      });
    }

    // Usable first, the series' own source ahead of the rest, then by how much each would repair.
    candidates.sort((x, y) =>
      Number(y.why === 'ok') - Number(x.why === 'ok') ||
      Number(y.pinned) - Number(x.pinned) ||
      y.fillable.length - x.fillable.length);

    const plan = putPlan({ seriesId, folder: s.folder, chapters, candidates });
    return {
      seriesId, title: s.title, folder: s.folder,
      have: { count: have.length, first: Math.min(...have), last: Math.max(...have) },
      gaps, candidates, following, planId: plan.id, expiresIn: PLAN_TTL, fillMax: FILL_MAX_CHAPTERS,
      refusal: gaps.length || candidates.some((c) => c.newer.length || c.older.length) ? null
        : { code: 'no_gaps', message: 'Nothing is missing between the chapters you already have.' },
    };
  });

  /** Fetch the chapters a person picked, from the source they picked, and nothing else. */
  app.post('/api/sources/fill', async (req, reply) => {
    const { planId, source, sourceSeriesId, numbers } = (req.body ?? {}) as
      { planId?: string; source?: string; sourceSeriesId?: string; numbers?: number[] };
    if (!planId || !source || !sourceSeriesId || !Array.isArray(numbers)) {
      return reply.code(400).send({ error: 'bad_request' });
    }
    const plan = getPlan(planId);
    if (!plan) return reply.code(409).send({ error: 'plan_stale', message: 'That list has moved on. Scan again.' });

    const auth = authorise(plan, source, sourceSeriesId, numbers.map(Number), FILL_MAX_CHAPTERS);
    if (!auth.ok) return reply.code(400).send({ error: auth.error, message: auth.message });

    const maxAgeRating = vc(req).maxAgeRating;
    const src = getSource(source);
    if (!src) return reply.code(400).send({ error: 'bad_request' });
    if (!sourceAllowedFor(src, maxAgeRating)) return denySource(reply);
    if (await isDisabled(source).catch(() => false)) return reply.code(409).send({ error: 'disabled' });
    if (await blockedNow(source).catch(() => false)) return reply.code(429).send({ error: 'blocked' });

    const s = await one<any>(
      `SELECT id, title, folder, summary, author, genres, web, status FROM lib_series WHERE id = $1`, [plan.seriesId]);
    if (!s) return reply.code(404).send({ error: 'not_found' });

    if (jobBusy(s.folder)) return reply.code(409).send({ error: 'busy' });

    const picked = auth.chapters;
    await logAudit('series.fill', {
      userId: userIdOf(req),
      detail: { seriesId: plan.seriesId, title: s.title, source, sourceSeriesId, numbers: picked.map((c) => c.number) },
      req,
    });
    // Every copy stamped with the source the person picked: the shared loop routes each chapter by its own.
    const { total } = startDownloadJob({
      folder: s.folder, title: s.title, seriesId: plan.seriesId,
      chapters: picked.map((c) => ({ ...c, source })),
      meta: { series: s.title, summary: s.summary, author: s.author, genres: s.genres, url: s.web, status: s.status },
      allowed: (id) => {
        const candidate = getSource(id);
        return !!candidate && sourceAllowedFor(candidate, maxAgeRating);
      },
    });
    return { ok: true, started: true, folder: s.folder, total };
  });

  /**
   * Fetch chapters the sources list but this server lacks -- the ghost rows on the series page.
   *
   * The last listing (lib/seriesListing.ts) IS the authorisation: a client names chapter NUMBERS, and only
   * a number the sources listed at the last check has a row to fetch from. The same footing as the fill
   * plan, for the same reason: no chapter URL crosses the wire, and a number nobody listed cannot be asked
   * for from anywhere. What is fetched is the copy the release rules chose at that check.
   *
   * Patience is ignored by construction: the chosen copy of a held number is the best copy on offer, and
   * a person clicking Fetch on a "waiting for group B" row is saying they will take it. The BLOCKLIST is
   * never ignored for a NUMBER: a number only blocked groups released has no chosen copy at all
   * (`blocked_group`), and the way to fetch it is to unblock the group and check again. A manual fetch also
   * resets the retry cap -- the ledger row goes, and a failure re-creates it at one attempt -- because "try
   * it again on purpose" is exactly what the cap was designed to leave room for.
   *
   * A PICK names one specific copy -- `{ number, source, sourceId }` out of the versions list -- and is
   * authorised by finding exactly that copy among the number's stored `copies` (`not_listed` otherwise):
   * still no chapter URL crosses the wire, and still only what a source has been seen to list can be asked
   * for. A pick ignores the group rules INCLUDING the blocklist. The blocklist governs what the sweep takes
   * on its own; the versions list labels a copy "blocked" and a person who taps Fetch on it anyway has made
   * an explicit choice of that one copy, which is a different act from asking for "the number". What a pick
   * never overrides is `already_here`: a live row for the number means the action is "fetch again", the
   * admin's, and a member must not be able to replace a file by naming another copy of it.
   */
  app.post('/api/sources/fetch', async (req, reply) => {
    // Bounded, not merely finite: the numbers are cast to `real[]` below, and a value past float4 range
    // (1e308 passes `finite()`) made Postgres throw 22003 -- a 500 carrying the driver's message, logged
    // as a server error, for what is a client mistake. No chapter is numbered negative or past a million.
    // Reintroduce by dropping `.min(0).max(1e6)`: "a chapter number outside float range is a bad request,
    // not a server error" in chapterActions.int.test.ts reads 500.
    const chapterNumber = z.number().finite().min(0).max(1e6);
    const b = z.object({
      seriesId: z.string().min(1).max(64),
      numbers: z.array(chapterNumber).max(FILL_MAX_CHAPTERS).optional(),
      picks: z.array(z.object({
        number: chapterNumber,
        source: z.string().min(1).max(200),
        sourceId: z.string().min(1).max(200),
      })).max(FILL_MAX_CHAPTERS).optional(),
    })
      // One cap over both lists: the job is one job whichever way its chapters were named, and 300 numbers
      // plus 300 picks would be a 600-chapter job through a route documented as 300.
      // Reintroduce by dropping this refine: "picks and numbers together stay under the cap" in
      // chapterActions.int.test.ts reads 200.
      .refine((v) => (v.numbers?.length ?? 0) + (v.picks?.length ?? 0) >= 1, { message: 'nothing named' })
      .refine((v) => (v.numbers?.length ?? 0) + (v.picks?.length ?? 0) <= FILL_MAX_CHAPTERS, { message: 'too many' })
      .safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const { seriesId } = b.data;
    const maxAgeRating = vc(req).maxAgeRating;
    // First pick per number wins, and a number with a pick leaves `numbers`: the explicit choice is the
    // more specific ask, and fetching the number's chosen copy beside it would land two files on one path.
    // A second pick for the same number is reported, not dropped: the web client never sends two, but a
    // scripted caller that does would otherwise see one copy fetched and hear nothing about the other.
    // Reintroduce by dropping the `else` branch: "a second pick for the same number is skipped as a
    // duplicate" in chapterActions.int.test.ts finds `skipped` empty.
    const skipped: Array<{ number: number; reason: string; source?: string; sourceId?: string }> = [];
    const pickOf = new Map<number, { number: number; source: string; sourceId: string }>();
    for (const pk of b.data.picks ?? []) {
      if (!pickOf.has(pk.number)) pickOf.set(pk.number, pk);
      else skipped.push({ number: pk.number, reason: 'duplicate', source: pk.source, sourceId: pk.sourceId });
    }
    const plain = [...new Set(b.data.numbers ?? [])].filter((n) => !pickOf.has(n)).sort((x, y) => x - y);
    const numbers = [...new Set([...plain, ...pickOf.keys()])].sort((x, y) => x - y);

    // Visible to THIS viewer, as the fill scan requires: a capped member must not be able to write into a
    // series they are walled off from, or learn which of its numbers are listed. Fails closed. visible(), not
    // browsable(), for the fill scan's reason: a fetch on a series someone opened is not a listing.
    const p = new Params();
    const rows = await q<any>(
      `SELECT s.id, s.title, s.folder, s.summary, s.author, s.genres, s.web, s.status, s.source_id
         FROM lib_series s WHERE s.id = ${p.add(seriesId)} AND ${visible('s', vc(req), p)}`, p.values,
    ).then((r) => r, () => null);
    if (rows === null) return reply.code(503).send({ error: 'unavailable' });
    const s = rows[0];
    if (!s) return reply.code(404).send({ error: 'not_found' });
    if (jobBusy(s.folder)) return reply.code(409).send({ error: 'busy', message: 'A download for that series is already running.' });

    // The listing is refreshed first, so what is fetched is the copy the release rules choose NOW rather
    // than the one the last sweep chose: a preferences save never touches series_listing, and a person who
    // has just ranked a group expects the next Fetch to honour it. maxNew 0 lists and persists and breaks
    // before any download; a source that does not answer leaves the previous listing standing (stale beats
    // empty, lib/updater.ts), and the not_listed / source_unavailable paths below handle that. Best effort:
    // the refresh must never be the thing that stops a fetch, and it runs only after the viewer's gate, so
    // a walled-off member cannot make this server ask a source about a series they cannot see.
    // Reintroduce by dropping this call: "fetch again takes the copy the rules choose now, not the one the
    // last check chose" in chapterActions.int.test.ts downloads the old group's copy.
    // ⚠️ Bounded on its own, not by the source's listing budget: a Cloudflare-fronted source may take 90 s
    // to answer (SOLVER_BUDGET_MS), and a Fetch button that holds the request that long meets the reverse
    // proxy's timeout first while the job starts anyway. Ten seconds covers every direct source; past that
    // the stale listing serves and the refresh finishes in the background for the next click.
    await withTimeout(updateSeries(seriesId, 0), REFRESH_BUDGET_MS).catch(() => {});
    const listed = new Map((await q<{ number: number; title: string | null; source_id: string; status: string; chosen: SourceChapter; copies: ListingCopy[] }>(
      'SELECT number, title, source_id, status, chosen, copies FROM series_listing WHERE series_id = $1 AND number = ANY($2::real[])',
      [seriesId, numbers],
    )).map((r) => [Number(r.number), r]));
    // A listing row's source_id is trusted only while the series still follows that source (the primary,
    // or a series_sources row): an unfollow drops the rows it carried, but a stale row must never authorise
    // a download from a source the admin removed. Same check as the admin's refetch.
    // Reintroduce by dropping the `followed` check in stateOf: "a stale listing row never authorises a
    // source the series does not follow" in chapterActions.int.test.ts starts a download from it.
    const followed = new Set([
      ...(s.source_id ? [s.source_id as string] : []),
      ...(await q<{ source_id: string }>('SELECT source_id FROM series_sources WHERE series_id = $1', [seriesId]).catch(() => [])).map((r) => r.source_id),
    ]);
    // A live row, not a tombstone: a chapter the cleanup let go is fetchable again, and "already here"
    // would send the person to a row with no pages behind it.
    const here = new Set((await q<{ number: number }>(
      'SELECT number FROM lib_books WHERE series_id = $1 AND number = ANY($2::real[]) AND pruned_at IS NULL',
      [seriesId, numbers],
    )).map((r) => Number(r.number)));

    const chapters: Array<SourceChapter & { pinned?: boolean }> = [];
    // Health is per source, asked once per source rather than once per number.
    const sourceState = new Map<string, 'ok' | 'source_unavailable' | 'cooldown' | 'denied'>();
    const stateOf = async (sid: string) => {
      let st = sourceState.get(sid);
      if (st) return st;
      const src = getSource(sid);
      if (!followed.has(sid) || !src || await isDisabled(sid).catch(() => false)) st = 'source_unavailable';
      else if (!sourceAllowedFor(src, vc(req).maxAgeRating)) st = 'denied';
      else if (await blockedNow(sid).catch(() => null)) st = 'cooldown';
      else st = 'ok';
      sourceState.set(sid, st);
      return st;
    };
    for (const n of numbers) {
      const row = listed.get(n);
      const pick = pickOf.get(n);
      if (pick) {
        // A pick is authorised by the stored copy it names, and by nothing else: the row's status (the
        // group rules' verdict on the NUMBER, blocklist included) is deliberately not consulted -- see the
        // route comment. Same source gate as a plain fetch: the copy's source must still be followed,
        // loaded, enabled, and out of cooldown.
        // Reintroduce by adding `if (row.status === 'blocked') { skipped.push(...blocked_group); continue; }`
        // ahead of this lookup: "a pick fetches that copy and no other, blocklist or not" in
        // chapterActions.int.test.ts reads 409.
        const copy = row?.copies?.find((c) => c.source === pick.source && c.sourceId === pick.sourceId);
        if (!row || !copy) { skipped.push({ number: n, reason: 'not_listed', source: pick.source, sourceId: pick.sourceId }); continue; }
        if (here.has(n)) { skipped.push({ number: n, reason: 'already_here', source: pick.source, sourceId: pick.sourceId }); continue; }
        const st = await stateOf(copy.source);
        if (st === 'denied') return denySource(reply);
        if (st !== 'ok') { skipped.push({ number: n, reason: st, source: pick.source, sourceId: pick.sourceId }); continue; }
        chapters.push({ ...copyToChapter(copy, { number: n, title: row.title }), pinned: true });
        continue;
      }
      if (!row) { skipped.push({ number: n, reason: 'not_listed' }); continue; }
      if (row.status === 'blocked') { skipped.push({ number: n, reason: 'blocked_group' }); continue; }
      if (here.has(n)) { skipped.push({ number: n, reason: 'already_here' }); continue; }
      const st = await stateOf(row.source_id);
      // The same by-id rejection the rest of this file gives, and it does not say what is being withheld.
      if (st === 'denied') return denySource(reply);
      if (st !== 'ok') { skipped.push({ number: n, reason: st }); continue; }
      chapters.push({ ...row.chosen, source: row.source_id });
    }
    chapters.sort((a, b) => a.number - b.number);
    if (!chapters.length) {
      // The first reason that is about a chapter, not about the body: a duplicate pick is never why
      // nothing was fetched, since its number was handled once through its first pick.
      const first = skipped.find((x) => x.reason !== 'duplicate')?.reason ?? skipped[0]?.reason;
      const message = first === 'not_listed' ? 'Not in the last listing -- run Check for new chapters first.'
        : first === 'blocked_group' ? 'Only blocked groups released that chapter. Unblock the group and check again.'
        : first === 'already_here' ? 'That chapter is already here.'
        : first === 'cooldown' ? 'That source is in a cooldown. Try again later.'
        : 'That source is not available right now.';
      return reply.code(409).send({ error: 'nothing_to_fetch', message, skipped });
    }

    await q('DELETE FROM chapter_failures WHERE series_id = $1 AND number = ANY($2::real[])',
      [seriesId, chapters.map((c) => c.number)]).catch(() => {});
    const picks = chapters.filter((c) => pickOf.has(c.number)).map((c) => ({ number: c.number, source: c.source, sourceId: c.sourceId }));
    await logAudit('series.chapters_fetch', {
      userId: userIdOf(req),
      detail: { seriesId, title: s.title, numbers: chapters.map((c) => c.number), ...(picks.length ? { picks } : {}), skipped },
      req,
    });
    const { total } = startDownloadJob({
      folder: s.folder, title: s.title, seriesId, chapters,
      meta: { series: s.title, summary: s.summary, author: s.author, genres: s.genres, url: s.web, status: s.status },
      allowed: (id) => {
        const candidate = getSource(id);
        return !!candidate && sourceAllowedFor(candidate, maxAgeRating);
      },
    });
    return { ok: true, started: true, folder: s.folder, total, skipped };
  });

  /**
   * Search every source this viewer may reach, answering within `wait` (lib/searchAll.ts has the whole
   * mechanism). `content` is shaped exactly as it always was; `sources`, `pending` and `asked` are additive,
   * so a client that ignores them -- the import review sheet -- keeps working, and one that reads `pending`
   * polls the same URL with a short `wait` until it is 0.
   */
  app.get('/api/sources/search-all', async (req) => {
    const { q: rawQ, groupBy, wait, source } = req.query as { q?: string; groupBy?: string; wait?: string; source?: string };
    const term = (rawQ || '').trim();
    if (!term) return { content: [], sources: [], pending: 0, asked: 0 };
    // Absent means the full first-answer wait, so a caller written before `wait` existed gets the most
    // complete answer one request can give; anything above the cap is clamped rather than refused.
    const asked = wait === undefined || wait === '' ? SEARCH_FIRST_ANSWER_MS : Number(wait);
    const waitMs = Math.min(SEARCH_FIRST_ANSWER_MS, Math.max(0, Number.isFinite(asked) ? asked : SEARCH_FIRST_ANSWER_MS));
    // Filtered rather than rejected: a fan-out has no single source to refuse, and a capped account asking
    // for a title that only exists on adult sources should get "nobody has it", not a partial denial.
    // ⚠️ `ask` is the ONLY thing that decides which sources this viewer starts or reads from the shared
    // entry, so it must be the viewer's surfaceable set and nothing wider: the age cap AND, since #64, the
    // "Show 18+" chip. The chip belongs here and not only in the shaping below, because a source left in
    // `ask` is a source this request STARTS -- an outbound query to an adult site on behalf of someone who
    // asked not to see one, and its results would then also land in the shared entry under this term.
    const all = surfaceable(req);
    // `source` narrows the fan-out to one source, for a search made while Discover is filtered to it. The
    // filter was display-only before, and did not survive a search at all: submitting a term asked every
    // source and answered with everything, so choosing a source and then searching within it was not
    // possible. Narrowing here rather than filtering the answer also makes it one outbound request instead
    // of a dozen, which is the difference between an instant answer and the slowest source's timeout.
    //
    // It only ever narrows `surfaceable`, never widens it: an id outside that set -- an adult source with
    // the reveal off, one an age cap puts out of reach, or one that does not exist -- leaves `ask` empty,
    // nobody is asked, and the answer is the ordinary nothing-found shape. The entry is still keyed by the
    // term alone, so a narrowed search and a full one share whatever the sources have already answered.
    const only = typeof source === 'string' ? source : '';
    const ask = only ? all.filter((s) => s.id === only) : all;
    const health = new Map((await healthAll().catch(() => [])).map((h) => [h.source_id, h] as const));
    const ans = await searchAll(term, ask, { waitMs, health });
    const byId = new Map(ask.map((s) => [s.id, s] as const));
    // Shaped in provider-preference order, as before: the first provider of a card is the default pick.
    const order = findOrder().map((id) => byId.get(id)).filter((s): s is SourceAdapter => !!s);
    const rest = { sources: ans.sources, pending: ans.pending, asked: ans.asked };

    // Same fan-out either way; only the shaping differs. groupBy=source mirrors Mihon's global-search
    // screen (one rail per provider) for the import-review "search manually" sheet — the title-grouped
    // shape below groups all providers of the SAME title into one card instead, which is what Discover
    // wants but hides which specific source a manual pick would come from.
    if (groupBy === 'source') {
      const rails = bySource(ans.per, order);
      const have = await inLibrary(rails.flatMap((g) => g.results.map((r) => r.title)));
      return {
        content: rails.map((g) => ({ ...g, results: g.results.map((r) => ({ ...r, inLibrary: have.has(norm(r.title)) })) })),
        ...rest,
      };
    }

    // group by normalized title → one card that carries every provider offering it (preferred order preserved)
    const groups = groupByTitle(ans.per, order);
    const have = await inLibrary(groups.map((g) => g.title));
    return { content: groups.map((g) => ({ ...g, inLibrary: have.has(norm(g.title)) })), ...rest };
  });

  // Browse a source's newest / recently-updated series (no query). Same card shape as search.
  app.get('/api/sources/latest', async (req, reply) => {
    const { source, page } = req.query as { source?: string; page?: string };
    const src = source ? getSource(source) : null;
    if (!src || typeof src.latest !== 'function') return { content: [] };
    // Refused by id, not merely hidden in the list. The web app is a static export, so a UI-only filter
    // would leave this returning twenty-four adult covers as JSON to a capped account holding the id.
    if (!sourceAllowedFor(src, vc(req).maxAgeRating)) return denySource(reply);
    // …and hidden, not refused, while the "Show 18+" chip is off: the wall is a listing, so this is the
    // surfacing rule rather than the permission one, and it answers exactly what a source with nothing new
    // answers. It sits beside the disabled short-circuit because it means the same thing to the caller --
    // this source paints no covers right now -- and above it because it needs no database read (#64).
    if (!surfaceable(req).some((s) => s.id === src.id)) return { content: [] };
    if (await isDisabled(source!).catch(() => false)) return { content: [] };
    const p = Math.max(1, parseInt(page || '1', 10) || 1);
    // A source serving out a cooldown is not asked again -- that is what the cooldown is FOR. Reporting
    // health from here was only affecting the client's ordering, so a source that had already proved it
    // cannot answer still cost the full timeout on every single visit: on this install two of them burned
    // 8s each, every time, for nothing. Whatever was last cached is still served, because an old page is
    // better than a blank one. blocked_until expires on its own, so the source heals without intervention.
    if (await blockedNow(source!).catch(() => null)) {
      const stale = cachedLatest(src.id, p);
      const had = await inLibrary(stale.map((r) => r.title));
      return { content: stale.map((r) => ({ ...r, inLibrary: had.has(norm(r.title)) })) };
    }
    const results = await latestPage(src, p);
    const have = await inLibrary(results.map((r) => r.title));
    return { content: results.map((r) => ({ ...r, inLibrary: have.has(norm(r.title)) })) };
  });

  /**
   * Browse what a source itself considers popular.
   *
   * Every guard the newest listing has applies identically -- the adult refusal by id, the 18+ hide, the
   * disabled check, the cooldown short-circuit -- so this is deliberately the same handler shape rather
   * than a clever shared one: the two differ only in which adapter method runs, and a wrapper that hid that
   * would make the access checks harder to see rather than easier.
   */
  app.get('/api/sources/popular', async (req, reply) => {
    const { source, page } = req.query as { source?: string; page?: string };
    const src = source ? getSource(source) : null;
    if (!src || typeof src.popular !== 'function') return { content: [] };
    if (!sourceAllowedFor(src, vc(req).maxAgeRating)) return denySource(reply);
    // The 18+ hide, exactly as on the newest listing above and for the same reason (#64).
    if (!surfaceable(req).some((s) => s.id === src.id)) return { content: [] };
    if (await isDisabled(source!).catch(() => false)) return { content: [] };
    const p = Math.max(1, parseInt(page || '1', 10) || 1);
    if (await blockedNow(source!).catch(() => null)) {
      const stale = cachedLatest(src.id, p, 'popular');
      const had = await inLibrary(stale.map((r) => r.title));
      return { content: stale.map((r) => ({ ...r, inLibrary: had.has(norm(r.title)) })) };
    }
    const results = await latestPage(src, p, 'popular');
    const have = await inLibrary(results.map((r) => r.title));
    return { content: results.map((r) => ({ ...r, inLibrary: have.has(norm(r.title)) })) };
  });

  app.get('/api/sources/jobs', async (req) => {
    sweepJobs();
    const all = [...jobs.entries()].map(([folder, j]) => ({ folder, ...j }));
    if (!vc(req).hideAdultLibraries) return { content: all };
    // A download job carries the series title, so the strip on Discover is a listing like any other. Jobs
    // are keyed by folder, which is exactly what lib_series.folder holds, so the filter is one lookup. A
    // job for a series not yet scanned in has no row and stays visible: it cannot be in a library yet.
    const p = new Params();
    const arr = p.add(all.map((j) => j.folder));
    const hidden = new Set((await q<{ folder: string }>(
      `SELECT s.folder FROM lib_series s WHERE s.folder = ANY(${arr}) AND NOT (${browsable('s', vc(req), p)})`,
      p.values as any[],
    ).catch(() => [])).map((r) => r.folder));
    return { content: all.filter((j) => !hidden.has(j.folder)) };
  });

  /**
   * Dismiss a finished or failed download.
   *
   * A failed one is never swept, because it is the only record that the download did not work -- an add now
   * answers before the download starts, so this card is where a blocked source or an unreadable chapter
   * actually surfaces. It therefore has to be dismissible, or it would sit there for good.
   */
  app.delete('/api/sources/jobs/:folder', async (req, reply) => {
    const { folder } = req.params as { folder: string };
    const j = jobs.get(folder);
    if (!j) return reply.code(404).send({ error: 'not_found' });
    // Only something that has stopped. Dropping a running job would orphan a download that is still going
    // and leave no way to see it again. A judgement still running counts the same way: a nothing-yet
    // carrier card is `done` from birth, and dropping it mid-judgement would let the follows land (the
    // judgement does not read the card) while the report they belong to was gone -- and the dialog, which
    // polls this card until it reads `autoFollow.done`, would show "Checking…" until closed.
    if (j.status === 'downloading' || (j.autoFollow && !j.autoFollow.done)) return reply.code(409).send({ error: 'running' });
    jobs.delete(folder);
    return { ok: true };
  });

  // How many trending titles reach the client. The hero takes the first ten and the rail shows the rest, so
  // this is both budgets at once. AniList returns 40 in the one query already, so raising it costs nothing.
  const TREND_KEEP = 36;

  // Globally trending manhwa you don't already have, for the Discover recommendations rail.
  app.get('/api/discover/trending', async (_req, reply) => {
    reply.header('cache-control', 'no-store'); // never let a stale/empty copy get pinned client-side
    if (!trendingCache || Date.now() - trendingCache.at > 6 * 3600_000) {
      try {
        let items = await fetchTrendingManhwa();
        // A second page, only when the first cannot fill the wall. On a large library most of page 1 is
        // already owned: measured on a 215-series install, 40 fetched became 28 after the library filter,
        // and only 7 of those carried the wide art the hero prefers. The common case still costs one
        // request per six-hour cache miss, and the page argument has been there unused since this shipped.
        if (items.length < TREND_KEEP + 8) {
          const more = await fetchTrendingManhwa(2).catch(() => [] as typeof items);
          const seen = new Set(items.map((t) => norm(t.title)));
          items = items.concat(more.filter((t) => !seen.has(norm(t.title))));
        }
        trendingCache = { at: Date.now(), items };
      } catch { if (!trendingCache) return { content: [] }; }
    }
    // No per-user filter here on purpose: `isAdult:false` is an argument to the AniList query, so adult
    // titles never arrive, and the cache is shared for six hours -- filtering it per viewer would pin one
    // capped account's view for everyone.
    const have = await inLibrary(trendingCache.items.map((t) => t.title));
    // Deduped by normalised title, not raw: the hero and its dots are keyed by title, so two spellings of
    // the same series would collide on a React key and swap art under the reader. Rare on one page, less so
    // across two.
    const seen = new Set<string>();
    const out = trendingCache.items.filter((t) => {
      const k = norm(t.title);
      return !have.has(k) && !seen.has(k) && (seen.add(k), true);
    });
    return { content: out.slice(0, TREND_KEEP) };
  });

  // Find a title across all providers (Aqua first) → the best match per provider that carries it.
  app.get('/api/sources/find', async (req) => {
    const { q: raw, sources } = req.query as { q?: string; sources?: string };
    const term = (raw || '').trim();
    if (!term) return { content: [] };
    // Scoped, because unscoped this is one outbound request per registered source: forty-five sites hit for
    // one tap. The client already knows which sources the reader is browsing and passes them.
    const wanted = sources ? new Set(sources.split(',').map((x) => x.trim()).filter(Boolean)) : null;
    // `surfaceable`, like search-all above: this is the other cross-source fan-out Discover runs, so a
    // source the "Show 18+" chip is hiding must be neither asked nor listed here (#64). A client naming it
    // in `sources` does not override the hide -- `wanted` only narrows the set, it never widens it.
    const allowed = new Set(surfaceable(req).map((x) => x.id));
    const found = await Promise.all(
      findOrder().filter((id) => allowed.has(id) && (!wanted || wanted.has(id))).map(async (id) => {
        const src = getSource(id);
        if (!src) return null;
        // search-all and latest both skip disabled sources and this did not, so it offered a provider an
        // admin had switched off and the add then failed with "disabled by the admin".
        if (await isDisabled(id).catch(() => false)) return null;
        try {
          const best = pickBest(await withTimeout(src.search(term), budgetFor(src, 25000)), term);
          return best ? { source: id, name: src.name, sourceId: best.sourceId, title: best.title, coverUrl: best.coverUrl } : null;
        } catch { return null; }
      }),
    );
    return { content: found.filter(Boolean) };
  });

  // Detail for one provider's match: description + chapter count/range (drives the add dialog).
  app.get('/api/sources/detail', async (req, reply) => {
    const { source, sourceId } = req.query as { source?: string; sourceId?: string };
    const src = source ? getSource(source) : null;
    if (!src || !sourceId) return reply.code(400).send({ error: 'bad_request' });
    // The cap only. This route resolves ONE series the person just named on a source they just named, so
    // the "Show 18+" chip has no business here: it hides what appears unasked, and nothing here is
    // unasked. Same for the add below, which is the button this dialog leads to (#64).
    if (!sourceAllowedFor(src, vc(req).maxAgeRating)) return denySource(reply);
    // Through the shared lookup so the add that usually follows this reuses it rather than re-solving.
    const { series, chapters } = await seriesAndChapters(src, sourceId);
    // Counted the way the add will take them -- one copy per number, the global blacklist applied -- so
    // the dialog's "120 chapters" is the 120 the add lands and not the 200 rows the source listed.
    const chosen = chooseReleases(chapters, await effectivePrefsFor(null, 0)).releases;
    const nums = chosen.map((c) => c.number);
    // Who scanlates it and how many numbers come in more than one version, from the list already in hand
    // -- no second source call. The dialog shows the top groups with their rhythm so a person can see,
    // before adding, whether the title is still being worked on and by whom; `onDisk` is 0 by construction
    // (nothing is on disk before the add) and `chapters` is present for the contract's sake.
    const perNumber = new Map<number, number>();
    for (const c of chapters) if (Number.isFinite(c.number)) perNumber.set(c.number, (perNumber.get(c.number) ?? 0) + 1);
    let versions = 0;
    for (const n of perNumber.values()) if (n > 1) versions++;
    return {
      source, sourceId,
      // Plain text: MangaDex describes in Markdown, and the dialog shows this as prose.
      title: series?.title || '', summary: cleanDescription(series?.summary), coverUrl: series?.coverUrl || null,
      genres: series?.genres || [], status: series?.status || '',
      count: chosen.length, first: nums.length ? Math.min(...nums) : null, last: nums.length ? Math.max(...nums) : null,
      groups: groupStats(chapters.map((c) => ({ number: c.number, groups: groupsOf(c), scanlator: c.scanlator, publishedAt: c.publishedAt, lang: c.lang, source })), []),
      versions,
    };
  });

  app.post('/api/sources/add', async (req, reply) => {
    // A plain cast let anything through: `chapterCount: "abc"` became NaN and quietly meant "all", and a
    // misspelt `chapterFrom` would have meant "oldest". A missing source or sourceId is still the same 400.
    // `alsoFollow` (#49): the other (source, id) pairs the dialog already found for this title, judged
    // server-side once the listing exists and followed when they qualify (lib/autoFollow.ts). Bounded at
    // the candidate cap so the body cannot name more sources than will ever be asked; the strings are
    // bounded as every source id and series id is elsewhere in this file. No search runs for them.
    const b = z.object({
      source: z.string(), sourceId: z.string(), force: z.boolean().optional(),
      chapterCount: z.number().int().positive().optional(), chapterFrom: z.enum(['oldest', 'newest', 'none']).optional(),
      autoUpdate: z.boolean().optional(),
      alsoFollow: z.array(z.object({ source: z.string().min(1).max(200), sourceId: z.string().min(1).max(200) })).max(MAX_AUTO_CANDIDATES).optional(),
    }).safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const { source, sourceId, force, chapterCount, chapterFrom, autoUpdate } = b.data;
    if (!source || !sourceId) return reply.code(400).send({ error: 'bad_request' });
    // Following stays an admin act. The manual follow route (POST /api/admin/series/:id/sources) and the
    // sheet's unfollow are admin-only, so a member whose add followed two sources could never undo it --
    // and a follower decides what the sweep downloads for everyone. A member's `alsoFollow` is therefore
    // dropped here, before the add, rather than refused: the add itself is theirs to make, and it goes
    // through exactly as if the switch had been off (no judgement, no carrier card). The dialog hides the
    // switch from members; this is the server's half of that.
    const alsoFollow = roleOf(req) === 'admin' ? b.data.alsoFollow : undefined;
    // canDownload is now checked for the whole plugin in the preHandler above, including this route.
    if (!sourceAllowedFor(getSource(source), vc(req).maxAgeRating)) return denySource(reply);
    // `wait: false` -- answer once the decision is made and download afterwards. Everything that decides
    // what to tell the caller (disabled, already present, duplicate, no chapters) still happens inline and
    // still gets its proper status code; only the fetching moves behind the reply. The auto-follow runs
    // behind it too, onto the job card: a candidate this viewer may not reach (the age cap, as for the
    // primary above) is reported `unavailable` there rather than refused here, so the rest still go. An
    // admin is exempt from the cap (lib/visibility.ts), so with `alsoFollow` admin-only this guard never
    // fires today; it stays wired because the lib honours it, so the day the switch is offered to a
    // capped account again nothing has to be remembered here.
    const maxAge = vc(req).maxAgeRating;
    const r = await addSeriesFromSource({
      source, sourceId, force, chapterCount, chapterFrom, autoUpdate, wait: false,
      alsoFollow, userId: userIdOf(req), req, sourceAllowed: (s) => sourceAllowedFor(getSource(s), maxAge),
    });
    if (!r.ok) {
      // ⚠️ The duplicate answer names a series the caller may not be allowed to open: the check behind it
      // is deliberately server-wide (`visibleToAll`), because "is this a duplicate" is a question about
      // the library, not about the viewer. So the title and the source go back as they always have -- that
      // wording is the whole point of the prompt -- but the ID, which is what "Open it" would navigate by,
      // only when this viewer may see that series. `seriesVisible` is the same check every by-id route
      // makes, asked here because this is where the viewer is (#67).
      const seen = r.existing && await seriesVisible(r.existing.id, vc(req)).catch(() => false);
      const existing = r.existing && { title: r.existing.title, source: r.existing.source, ...(seen ? { id: r.existing.id } : {}) };
      return reply.code(r.status).send({ error: r.error, message: r.message, existing, status: r.blockStatus });
    }
    // Audited here rather than after the download, so a slow or failing download does not delay the record
    // of who asked for it. What actually landed is the job's business.
    logAudit('download.add', { userId: (req as any).user?.sub, detail: { title: r.title, source, chapters: r.chapters }, req });
    // The id of the series this add landed on, for "Open in library" (#67) -- gated the same way as the
    // duplicate's above, and for the same reason: an add can answer with a row the caller cannot see (an
    // "already in library" for a series in a library they were not granted). Absent on a fresh download,
    // where no row exists yet; the dialog reads it off the job card instead.
    const seriesId = r.seriesId && await seriesVisible(r.seriesId, vc(req)).catch(() => false) ? r.seriesId : undefined;
    // `nothing` is how the dialog tells "added, chapters will come" from "already in your library": both
    // answer `chapters: 0, started: false`, and before this flag the second wording was the only one.
    // `alreadyHere` is the third of those (#65): nothing was fetched because the library holds it all.
    return {
      ok: true, title: r.title, folder: r.folder, chapters: r.chapters, started: !!r.started, nothing: !!r.nothing,
      ...(seriesId ? { seriesId } : {}), ...(r.alreadyHere === undefined ? {} : { alreadyHere: r.alreadyHere }),
    };
  });
}
