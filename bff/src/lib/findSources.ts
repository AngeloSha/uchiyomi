// Find other sources (v0.49.1): a calm, paced background job that follows other sources for many series at once --
// above all for every series whose MAIN source has stopped answering.
//
// The idea is @TIGamingTV's ("Connect sources", PR #119), rebuilt on the server's own parts after its review. Why
// now: the owner's main source, aqua (195 series), has answered only "Aqua Manga is temporarily offline" since
// 2026-09-23, six of those series followed a second source, and the rest had no way to get a chapter. Following
// another source for each by hand is a Find missing chapters scan and a confirmation, 189 times over.
//
// Everything that decides anything is reused, never copied:
//   - which series: lib/findScope.ts (the admin's selection, or every series whose main source is the one named);
//   - where to look: scanOrder over the sources the admin who started the run may reach -- their own age cap, as
//     Discover and the manual follow route read it (visibility.sourceAllowedFor), NOT the hunt's sweepAllowedFor,
//     which drops every extension that flags itself adult for a series not rated 18+: most manhwa extensions do,
//     and on a typical library every series then had no source to ask (#132) -- and in the series' language
//     (v0.52.0, #123: a source in another language than the series is never asked), with the main source excluded
//     ALWAYS (it is the one that is down) and the sources it already follows, and health read per series, so a
//     source disabled or cooling down since the run started is not asked;
//   - how to look: the hunt's non-reporting search (sourceHunt.ts searchByNames) under the hunt's shared slots,
//     the title and up to three of the series' other names (lib/altTitles.ts), an other name matched exactly. A
//     series with no other name stored is first given the ones its stored description lists, and failing that the
//     ones its main source's description lists (learnNames below): a series added before v0.49.1 has none. A
//     search that fails is a source that did not answer: it never escalates a cooldown and never marks Health
//     failing, where #115 would confirm a failure after three in a row -- and a run over many series IS many in
//     a row;
//   - whether it is this series: autoFollow's judgeCandidate, unchanged (title, then the numbering, both ways
//     unless an exact main title on a long listing; its disabled and cooldown checks);
//   - the follow: followJudged, the one atomic write under the follower cap, with the admin who started the run
//     as added_by -- a person asked for it;
//   - what may never be followed: a series numbered by posting order (lib/numbering.ts, #116), whose followers are
//     never merged; a series already at the cap.
//
// Its manners are the slow archive's and bulk Fetch newest's: one run at a time, 1.5 s between the series it asks
// about, waiting while a sweep, a repair or the daily source check runs, stopping at a series boundary on shutdown
// or when an admin says stop. Per series it stops asking once the free follower slots are filled or three
// sources carry the title (the fill scan's three-source stop), and gives up after a wall; what a stop, the wall or
// a restart cut short is `not_tried` -- never "not found" -- and every other outcome says what it was (FindWhy).
//
// When it ends, every series that gained a follower gets a listing refresh (updateSeries with nothing to download,
// the follow route's own), 1.5 s apart in the background, so the new source's chapters show on the series page
// and the sweep takes them from there, without a burst. The run is kept in source_find_runs (newest 20), so the
// result outlives the tab and a restart. A shutdown gives the run a moment to close its own row (server.ts,
// findSettledWithin); a row still `running` after a restart is closed as `interrupted` all the same, with every
// series it never reached listed as `not_tried`, exactly as a stopped run lists them.
//
// Review first (v0.51.0, #132; the idea is @TIGamingTV's, PR #133): a run started with `review` searches and judges
// exactly as above and follows nothing. Each series keeps the candidates the judgement would follow (green) or that
// a person should look at (amber: the chapter numbers do not line up though a name matches exactly, or it matched
// only under another name) as `proposals` in its result, with the candidate's cover, so an admin confirms each by
// eye -- TI caught a wrong match by its cover that the automatic judgement would have followed. A proposal is then
// followed (decideProposal: checked again, then followJudged under the cap) or dismissed, one at a time, and says
// which it was. The mode is kept in the run's `scope` (`review: true`): no column, so v0.50.0 boots on the same rows.
//
// Replace (v0.54.0): the same run over every series of one source, `mode: 'replace'`, MOVES them off it. The owner,
// after a full Find run left all 195 aqua series on aqua: "i have to go one by one test and find replacement
// sources". Per series (replaceFor): its best working follower becomes its main source at once (lib/replaceSource.ts
// ranks them, lib/mainSource.ts switches), with no search; a series with none is searched for as above -- its dead
// followers not counting against the cap, and dropped only as far as a follow needs the room -- and the source it
// follows first becomes its main source. Series followers-first, so the instant promotions land first; paced only
// after a series that searched. Review first proposes instead: each series' followers, or what its search found,
// with the one it would promote marked, and promoteProposal applies one. `turnOff` turns the replaced source off once
// the run ends with no series left on it (lib/retireSource.ts). The mode rides in the run's `scope` as `review` does.
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { q, one, tx } from './db';
import { getSource, listSources } from './sources';
import type { SourceSeries } from './sources/types';
import { healthAll, isDisabled } from './sourceHealth';
import { scanOrder } from './scanOrder';
import {
  judgeCandidate, followJudged, bounded, titleMatch, MAX_FOLLOWERS, MIN_TRY_MS, type Judgement, type PrimaryFacts,
} from './autoFollow';
import { chooseReleases, type ReleasePrefs } from './releases';
import { effectivePrefsFor, readSeriesPrefs } from './scanlatorPrefs';
import { assess, MIN_HAVE } from './fill';
import { postingOrderSeries } from './numbering';
import { haveNumbers } from './libraryNumbers';
import { altTitlesFor, learnAltTitles, parseAltTitles, SEARCH_NAMES } from './altTitles';
import { searchByNames, takeHuntSlot, releaseHuntSlot } from './sourceHunt';
import { budgetFor } from './sources/budget';
import { seriesByIds, seriesOfMainSource } from './findScope';
import { runtime } from './runtime';
import { checkRunning } from './sourceWatchdog';
import { beginRun, endRun, stopRequested, type RunCard } from './downloadJobs';
import { say, type Part } from './said';
import { updateSeries } from './updater';
import { PACE_MS } from './bulkNewest';
import { scheduleHealthSummaryRefresh } from './healthSummary';
import { logAudit } from './audit';
import { seriesVisible, sourceAllowedFor, visibleToAll, type ViewCtx } from './visibility';
import { followGuard, seriesLanguage, sourceLanguage } from './seriesLang';
import { editionFollowing } from './editions';
import { mainSourceCounts } from './findScope';
import { renumberRunning } from './numbering';
import { runsInside } from './updater';
import { switchMainSource, type MainRefusal } from './mainSource';
import { retireSource } from './retireSource';
import { deadFollowers, rankFollowers, replaceCounts, replaceFacts, type RankedFollower, type SeriesFacts, type SkipWhy } from './replaceSource';
import { MIN_COVERAGE } from './fill';
import type { Standing } from './sourceStanding';

/** How long one series may spend searching and judging before what is left of it is `not_tried`. */
export const FIND_SERIES_WALL_MS = 90_000;
/** Sources that carry the title before a series stops asking more: the fill scan's SCAN_ENOUGH. */
export const FIND_CARRIERS = 3;
/** How often a run waiting on a sweep, a repair or the daily check looks again. */
export const FIND_QUIET_POLL_MS = 5_000;
/** How long a series' main source may take to give its description, for the other names it lists. */
const FIND_LOOKUP_MS = 20_000;
/** Runs kept in source_find_runs. */
export const FIND_KEEP = 20;
/** How long a stop waits for the series in flight to finish writing a follow it has started. */
const STOP_GRACE_MS = 1_000;
/**
 * How long a Replace run waits for a run inside a series -- the sweep, a check, a listing refresh -- before it says
 * `busy`: such a run read the series' main pair at its start, and a switch under it would be undone by its writes.
 */
export const FIND_BUSY_WAIT_MS = 30_000;
/**
 * How long a shutdown waits for the run to close its own row (server.ts): a stop is seen within a quarter of a
 * second and the series in flight gets STOP_GRACE_MS, so this is room to spare, and short enough for any shutdown.
 */
export const FIND_SHUTDOWN_MS = 3_000;

export type FindStatus = 'running' | 'done' | 'stopped' | 'failed' | 'interrupted';
/**
 * Why a series gained no source, each for exactly what happened (the web words every code):
 * - `posting_order`: numbered by posting order, so no follower is ever merged (not searched);
 * - `full`: it already follows MAX_FOLLOWERS sources (not searched), or a hunt filled the last slot meanwhile;
 * - `too_few`: it lists under MIN_HAVE chapter numbers, which no candidate can be measured against (not searched);
 * - `no_source`: no other source could be asked -- every one disabled, cooling down, beyond the starting admin's
 *   age cap, in another language than the series (v0.52.0), or one it already follows (not searched; the server log
 *   says which, by count);
 * - `refused`: a source carried the title and judgeCandidate refused it, by the title or by the chapter numbers;
 * - `no_answer`: the sources asked did not answer, or the one that carried the title did not answer for its
 *   chapters, so nothing could be judged;
 * - `followed_already`: every source that answered lists nothing that is this series, and the series already
 *   follows another source (which does list it: `no_match` would say no other source does);
 * - `no_match`: the sources that answered do not carry it, and it follows no other source;
 * - `not_tried`: a stop, the series' wall or a restart cut it short -- never "not found". (Rarely also a series
 *   deleted or merged away before or during its turn, or one whose own search failed outright: the server log
 *   says why.)
 */
export type FindWhy =
  | 'posting_order' | 'full' | 'too_few' | 'no_source'
  | 'refused' | 'no_answer' | 'followed_already' | 'no_match' | 'not_tried'
  // v0.54.0, a Replace run: the series' main source is no longer the one replaced; a run stayed inside the series
  // past FIND_BUSY_WAIT_MS; its chapters wait to be renumbered.
  | 'moved' | 'busy' | 'renumber_pending';
export interface FoundSource { sourceId: string; name: string; chapters: number }
/**
 * A candidate a review-first run kept for an admin to confirm (v0.51.0), the best one per source -- the hunt's search
 * stops on a source at its first hit. `verdict` is green when the judgement would have followed it, amber when a
 * person should look first (`amber` says why). `coverUrl` is the source's own, as its search gave it: the web shows
 * it through the cover proxy (/img/sources/cover), as every source cover is shown. `ours` is how many of our chapter
 * numbers it lists, `theirs` how many of its numbers we list (whole numbers, as the judgement counts them). `state`
 * is set once an admin decided.
 */
export interface FindProposal {
  sourceId: string;
  sourceName: string;
  sourceSeriesId: string;
  url?: string;
  title: string;
  coverUrl?: string;
  chapters: number;
  ours: { lined: number; of: number };
  theirs: { lined: number; of: number };
  coverage: number | null;
  verdict: 'green' | 'amber';
  /**
   * Why a person should look first. A search's: the numbers do not line up though a name matches exactly, or it matched
   * only under another name. A follower's (v0.54.0, Replace): it is cooling down, it lists under MIN_COVERAGE of the
   * series' numbers, or it has not answered for its list within the week.
   */
  amber?: 'numbering' | 'other_name' | 'cooling' | 'coverage' | 'stale';
  /** `promoted` (v0.54.0): made the series' main source. */
  state?: 'followed' | 'dismissed' | 'promoted';
  // ---- v0.54.0, a Replace run's review only.
  /** A follower the series has (`follower`), or a source its search found (`search`). */
  kind?: 'follower' | 'search';
  /** The one the run would make the main source: the best follower, or the first green search match. */
  promote?: true;
  /** A follower's: chapters it lists past what the library holds, and its standing. */
  newer?: number;
  standing?: Standing;
}
/** v0.54.0, a Replace run: a series moved off the replaced source, and how. */
export interface Promoted {
  from: string; fromName: string; to: string; toName: string;
  /** A follower it had (`follower`), or a source its search found and followed (`search`). */
  via: 'follower' | 'search';
  /** The replaced source: dropped from the series' followers, or kept (a review's switch keeps nothing else). */
  old: 'dropped' | 'kept';
}
/**
 * `title` is left out for a series the viewer may not list (routes/findSources.ts), and for one a restart's close
 * could no longer find in the library. `proposals` only in a review-first run, for a series that has any: it then
 * carries no `why`, and `followed` gains each proposal an admin follows.
 */
export interface FindResult {
  seriesId: string; title?: string; followed: FoundSource[]; why?: FindWhy; proposals?: FindProposal[];
  // ---- v0.54.0, a Replace run. `why` is then set only when nothing was promoted.
  promoted?: Promoted;
  /** The followers passed over: switched off, failing, cooling down, not loaded, another language, beyond the age reach. */
  skipped?: Array<{ sourceId: string; name: string; why: SkipWhy }>;
  /** Dead followers dropped to make room for a source the search found. */
  dropped?: Array<{ sourceId: string; name: string }>;
}
export type FindScope = { seriesIds: string[] } | { sourceId: string };
/** `follow` (the default): add followers. `replace` (v0.54.0): move every series of one source off it. */
export type FindMode = 'follow' | 'replace';

interface ActiveRun {
  id: string;
  userId: string;
  startedAt: number;
  scope: FindScope;
  /** Review first: judge and keep the candidates, follow nothing. */
  review: boolean;
  /** v0.54.0: Replace -- move each series off `scope.sourceId` -- and turn that source off once none is left on it. */
  mode: FindMode;
  turnOff: boolean;
  /** Series moved to another main source. */
  promoted: number;
  /** The starting admin's age cap (ViewCtx.maxAgeRating; null for an admin): which sources the run may ask. */
  maxAgeRating: number | null;
  /** The starting admin's view: what a Replace run's switches act as (lib/mainSource.ts). */
  ctx: ViewCtx;
  /** Main sources whose description read failed in this run: not asked again for the next series. */
  dead: Set<string>;
  total: number;
  done: number;
  followed: number;
  results: FindResult[];
  current: { seriesId: string; title: string } | null;
  /** What it is waiting on before its next series, while it waits. */
  waiting: 'sweep' | 'repair' | 'check' | null;
  stop: boolean;
  /** Settles the moment a stop is asked for, from anywhere: /stop, the run card's Cancel, a shutdown. */
  stopped: Promise<void>;
  signal: () => void;
  card: RunCard;
}

let active: ActiveRun | null = null;
/** Claimed synchronously by a start, before its first await: two POSTs in one turn cannot both start a run. */
let claimed: string | null = null;
let paceMs = PACE_MS;
let wallMs = FIND_SERIES_WALL_MS;
let quietMs = FIND_QUIET_POLL_MS;
let busyMs = FIND_BUSY_WAIT_MS;
/** The run that is going or was last started in this process, for a caller that must wait for it (tests). */
let lastRun: Promise<void> = Promise.resolve();

const isStopped = (a: ActiveRun) => a.stop || runtime.stopping || stopRequested(a.card);
const nap = (a: ActiveRun, ms: number) => Promise.race([new Promise<void>((r) => setTimeout(r, ms)), a.stopped]);

/** The run going now, if any: its id. */
export const findRunning = (): string | null => active?.id ?? claimed;

/**
 * Close every row still `running` that is not the run this process is going: its process went away under it.
 * At boot (server.ts), and before every start and every read, so no row reads "running" for a run nobody runs.
 *
 * It closes as `interrupted` and, as a stopped run does, lists every series of its scope it never settled as
 * `not_tried`, in the run's order, with the title the library has for it: the answer accounts for the whole scope,
 * and the web offers those series again. The scope holds the resolved ids for either kind (startFind), so a run
 * over a source lists the series it resolved to then, not whatever that source's series are now. One statement:
 * two reads closing the same row at once cannot both append (the second finds it no longer running). Reintroduce by
 * setting the status alone: "a restart lists every series the run never reached as not tried" in
 * findSources.int.test.ts finds them missing.
 */
export async function closeInterruptedFindRuns(): Promise<void> {
  await q(
    `UPDATE source_find_runs r SET status = 'interrupted', finished_at = COALESCE(r.finished_at, now()),
            results = r.results || COALESCE((
              SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                       'seriesId', x.id, 'title', COALESCE(o.title, s.title), 'followed', '[]'::jsonb,
                       'why', 'not_tried')) ORDER BY x.n)
                FROM jsonb_array_elements_text(r.scope -> 'seriesIds') WITH ORDINALITY AS x(id, n)
                LEFT JOIN lib_series s ON s.id = x.id
                LEFT JOIN series_overrides o ON o.series_id = x.id
               WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r.results) e
                                  WHERE e ->> 'seriesId' = x.id)), '[]'::jsonb)
      WHERE r.status = 'running' AND r.id::text IS DISTINCT FROM $1`, [findRunning()]);
}

/**
 * Start a run. Answers `busy` (with the running run's id) while another is going, `empty` when the scope names no
 * series this viewer may see, else the new run's id and how many series it will ask about -- with the run already
 * going in the background. `from` is the request's IP and user agent for the audit line written when it ends.
 * `review`: review first (v0.51.0) -- the same run, which keeps its candidates for an admin instead of following.
 * `mode: 'replace'` (v0.54.0, a source's scope only): move every series off that source; `turnOff` (never with review)
 * then turns it off once none is left on it. Replace and Find share the one run at a time.
 */
export async function startFind(
  scope: FindScope, userId: string, ctx: ViewCtx, from?: FastifyRequest, o: { review?: boolean; mode?: FindMode; turnOff?: boolean } = {},
): Promise<{ runId: string; total: number } | { busy: string } | { empty: true }> {
  const review = o.review === true;
  const mode: FindMode = o.mode === 'replace' && 'sourceId' in scope ? 'replace' : 'follow';
  const turnOff = mode === 'replace' && !review && o.turnOff === true;
  const running = findRunning();
  if (running) return { busy: running };
  const id = randomUUID();
  claimed = id;
  try {
    const list = 'sourceId' in scope
      ? await seriesOfMainSource(scope.sourceId, ctx, { followersFirst: mode === 'replace' })
      : await seriesByIds(scope.seriesIds, ctx);
    if (!list.length) { claimed = null; return { empty: true }; }
    await closeInterruptedFindRuns();
    // The ids it resolved to, for either kind: what closeInterruptedFindRuns lists as not tried if the process goes
    // away under the run. Reintroduce by storing {sourceId} alone: "a restart lists every series the run never
    // reached as not tried" in findSources.int.test.ts finds no seriesIds in the scope.
    const ids = list.map((s) => s.id);
    const stored = {
      ...('sourceId' in scope ? { sourceId: scope.sourceId, seriesIds: ids } : { seriesIds: ids }), ...(review ? { review } : {}),
      ...(mode === 'replace' ? { mode } : {}), ...(turnOff ? { turnOff } : {}),
    };
    await q(`INSERT INTO source_find_runs (id, started_by, status, scope, total) VALUES ($1, $2, 'running', $3::jsonb, $4)`,
      [id, userId, JSON.stringify(stored), list.length]);
    const card = beginRun('find_sources', userId, list.length);
    // It searches and follows; it downloads nothing (the refresh at its end fetches no chapter either), so it is a
    // Server task that does not turn the Library ring.
    card.downloads = false;
    card.followed = 0;
    if (mode === 'replace') Object.assign(card, { mode, promoted: 0, left: list.length });
    let signal!: () => void;
    const stopped = new Promise<void>((r) => { signal = r; });
    const a: ActiveRun = {
      id, userId, startedAt: Date.now(), scope, review, mode, turnOff, promoted: 0, maxAgeRating: ctx.maxAgeRating, ctx, dead: new Set(),
      total: list.length, done: 0, followed: 0, results: [],
      current: null, waiting: null, stop: false, stopped, signal, card,
    };
    active = a;
    lastRun = runAll(a, list, from).catch((e) => console.warn(`[find] ${(e as Error)?.message || e}`));
    return { runId: id, total: list.length };
  } catch (e) {
    claimed = null;
    throw e;
  }
}

/** Ask the running run to stop at once: the series in flight ends `not_tried` unless it already followed one. */
export function stopFind(): boolean {
  const a = active;
  if (!a) return false;
  a.stop = true;
  a.card.cancelRequested = true;
  a.signal();
  return true;
}

/**
 * Wait until no sweep, repair or daily source check is running: they own the sources while they go. What it waits
 * on is the run's (GET /api/admin/sources/find, run.waiting) and its card's (GET /api/sources/jobs), so Server tasks
 * says why the run is paused. Reintroduce by leaving the card out: "it waits while a sweep runs, and says so" in
 * findSources.int.test.ts reads no `waiting` on the card.
 */
async function waitQuiet(a: ActiveRun): Promise<boolean> {
  for (;;) {
    if (isStopped(a)) return false;
    a.waiting = runtime.updating ? 'sweep' : runtime.repairing ? 'repair' : checkRunning() ? 'check' : null;
    if (a.waiting) a.card.waiting = a.waiting;
    else delete a.card.waiting;
    if (!a.waiting) return true;
    await nap(a, quietMs);
  }
}

async function runAll(a: ActiveRun, list: Array<{ id: string; title: string }>, from?: FastifyRequest): Promise<void> {
  const settled = new Set<string>();
  const refresh: string[] = [];
  let status: FindStatus = 'done';
  // The generic Cancel on the run's card (POST /api/sources/runs/find_sources/cancel) and a shutdown only set a
  // flag; this turns either into the stop signal the waits and the series in flight listen for.
  const watch = setInterval(() => { if (isStopped(a)) a.signal(); }, 250);
  try {
    for (let i = 0; i < list.length; i++) {
      if (!(await waitQuiet(a))) break;
      const s = list[i];
      a.current = { seriesId: s.id, title: s.title };
      a.card.current = { id: s.id, title: s.title };
      const progress: FoundSource[] = [];
      // What a Replace run's series has done before a stop could cut its answer short: its switch is one transaction,
      // and the answer must say it happened.
      const track: { promoted?: Promoted } = {};
      // One series failing outright (the database going away mid-series) is that series' `not_tried`, and the run
      // goes on: bulk Fetch newest's rule.
      const work = (a.mode === 'replace' ? replaceFor(s, a, progress, track) : findFor(s, a, progress)).catch((e) => {
        console.warn(`[find] ${s.id}: ${(e as Error)?.message || e}`);
        return null;
      });
      let outcome = await Promise.race([work, a.stopped.then(() => undefined)]);
      // A stop does not wait for the searches in flight (up to the wall), but it does give a follow being written
      // a moment to land, so the answer reports every source the run followed.
      if (outcome === undefined) outcome = await Promise.race([work, new Promise<undefined>((r) => setTimeout(() => r(undefined), STOP_GRACE_MS))]);
      // Stopped mid-series: whatever it followed (or promoted) before the stop stands, and the rest of it was not tried.
      const result: FindResult = outcome?.result ?? {
        seriesId: s.id, title: s.title, followed: [...progress],
        ...(track.promoted ? { promoted: track.promoted } : progress.length ? {} : { why: 'not_tried' as const }),
      };
      settled.add(s.id);
      a.results.push(result);
      // A series a stop cut short with nothing to show was not searched through: it is listed as not tried, and not
      // counted in `done`, which the run's card shows as "{done} of {total} series" -- it read "1 of 4 series" after a
      // stop during the first (v0.52.0). Reintroduce by counting every series settled: "one run at a time; ... a stop
      // ends it at once" in findSources.int.test.ts reads done 1.
      if (!(isStopped(a) && result.why === 'not_tried')) a.done++;
      a.followed += result.followed.length;
      a.card.done = a.done;
      a.card.followed = a.followed;
      if (result.promoted) a.card.promoted = ++a.promoted;
      // A new follower's chapters, or the new main's, show on the series page now: a series that followed a source, or
      // whose dropped main took listing rows with it (the sweep re-lists the rest).
      if (result.followed.length || (outcome as { refresh?: boolean } | null | undefined)?.refresh) refresh.push(s.id);
      if (a.mode === 'replace' && 'sourceId' in a.scope) {
        a.card.left = (await mainSourceCounts([a.scope.sourceId]).catch(() => null))?.get(a.scope.sourceId) ?? a.card.left;
      }
      await q(`UPDATE source_find_runs SET done = $2, followed = $3, results = results || jsonb_build_array($4::jsonb) WHERE id = $1`,
        [a.id, a.done, a.followed, JSON.stringify(result)]).catch((e) => console.warn(`[find] could not record ${s.id}: ${(e as Error)?.message || e}`));
      if (isStopped(a)) break;
      // Paced only after a series that asked a source: one decided from the database costs the sites nothing.
      if (outcome?.asked && i < list.length - 1) await nap(a, paceMs);
    }
    if (isStopped(a)) status = runtime.stopping ? 'interrupted' : 'stopped';
  } catch (e) {
    status = 'failed';
    console.warn(`[find] the run failed: ${(e as Error)?.message || e}`);
  } finally {
    clearInterval(watch);
    // Every series it never reached is listed as not tried, so the answer accounts for the whole scope.
    const rest: FindResult[] = list.filter((s) => !settled.has(s.id)).map((s) => ({ seriesId: s.id, title: s.title, followed: [], why: 'not_tried' }));
    a.results.push(...rest);
    a.current = null;
    a.waiting = null;
    delete a.card.waiting;
    await q(`UPDATE source_find_runs SET status = $2, finished_at = now(), done = $3, followed = $4,
                    results = results || $5::jsonb WHERE id = $1`,
      [a.id, status, a.done, a.followed, JSON.stringify(rest)]).catch((e) => console.warn(`[find] could not close the run: ${(e as Error)?.message || e}`));
    await q(`DELETE FROM source_find_runs WHERE id NOT IN (SELECT id FROM source_find_runs ORDER BY started_at DESC LIMIT $1)`, [FIND_KEEP])
      .catch(() => {});
    // Replace (v0.54.0): what is left on the replaced source, and -- asked for, and the run done with nothing left on
    // it -- the source turned off, its follows dropped with their listing rows (lib/retireSource.ts). A stopped or
    // failed run, or one that left a series behind, turns nothing off; retireSource refuses a source some series still
    // has as its main source as well. Reintroduce by dropping both checks: "turnOff turns the replaced source off only
    // when no series is left on it" in findSources.int.test.ts finds it off with a series on it.
    let replaced: { left: number; turnedOff: boolean } | null = null;
    if (a.mode === 'replace' && 'sourceId' in a.scope) {
      const X = a.scope.sourceId;
      const left = (await mainSourceCounts([X]).catch(() => null))?.get(X) ?? 0;
      if (a.turnOff && status === 'done' && left === 0) {
        await retireSource(X, { how: 'off', userId: a.userId, via: 'replace', runId: a.id })
          .catch((e) => console.warn(`[find] could not turn ${X} off: ${(e as Error)?.message || e}`));
      }
      replaced = { left, turnedOff: await isDisabled(X).catch(() => false) };
      Object.assign(a.card, replaced);
    }
    endRun(a.card, status === 'failed' ? 'error' : 'done', status === 'failed' ? say('run.failed') : undefined);
    await logAudit('source.find', {
      userId: a.userId,
      detail: {
        runId: a.id, scope: 'sourceId' in a.scope ? { sourceId: a.scope.sourceId } : { seriesIds: a.total },
        status, total: a.total, done: a.done, followed: a.followed,
        series: a.results.filter((r) => r.followed.length).length,
        ...(a.review ? { review: true, proposed: a.results.filter((r) => r.proposals?.length).length } : {}),
        ...(replaced ? { mode: 'replace', promoted: a.promoted, ...replaced } : {}),
      },
      req: from,
    });
    active = null;
    claimed = null;
    if (refresh.length) scheduleFindRefresh(refresh);
    // Health's sources and "can no longer update" rows count followers: the header catches up now, not in 6 h.
    scheduleHealthSummaryRefresh();
  }
}

/** Every chapter number the series lists or holds: what a candidate's numbering is measured against. */
async function numbersOf(seriesId: string): Promise<number[]> {
  const listed = await q<{ number: number }>('SELECT DISTINCT number::float8 AS number FROM series_listing WHERE series_id = $1', [seriesId]);
  const held = await haveNumbers(seriesId);
  return [...new Set([...listed.map((r) => Number(r.number)), ...held])].filter((n) => Number.isFinite(n));
}

/**
 * Give a series the other names its own description lists before it is searched for. Names are otherwise kept only
 * when a series is added or its main source is looked up (lib/altTitles.ts), so a series added before v0.49.1 -- or
 * on an install whose series_alt_titles could not be read (migrate.ts, the fork-shaped table) -- has none, and was
 * searched under its own title alone: a manhwa whose sites each use another romanisation then matched nothing.
 * First its stored summary, which costs no request; only when that gives none and no name is stored is the main
 * source asked for its description, once, bounded, and never when it is switched off, cooling down or already failed
 * this run (`a.dead`): the main source being down is often why the run was started. Kept as `description` names, so
 * a name an admin removed stays removed. Best effort: never throws.
 */
async function learnNames(
  seriesId: string, row: { source_id: string | null; source_series_id: string | null; summary: string | null },
  a: ActiveRun, resting: (sourceId: string) => boolean,
): Promise<void> {
  try {
    if (parseAltTitles(row.summary).length) await learnAltTitles(seriesId, row.summary);
    if ((await altTitlesFor(seriesId, 1)).length) return;
    const main = row.source_id ? getSource(row.source_id) : null;
    if (!main || !row.source_series_id || a.dead.has(main.id) || resting(main.id) || isStopped(a)) return;
    try {
      const own = await bounded(main.getSeries(row.source_series_id), budgetFor(main, FIND_LOOKUP_MS));
      await learnAltTitles(seriesId, own?.summary);
    } catch { a.dead.add(main.id); }
  } catch (e) {
    console.warn(`[find] ${seriesId}: other names not read: ${(e as Error)?.message || e}`);
  }
}

/**
 * A judgement as a review's proposal (v0.51.0), or null when it is not one to show. Green is exactly what an automatic
 * run follows -- `ok` -- on our own title (equal, or one inside the other, as titleMatch reads it). Amber is for a
 * person to look at: `ok` only because the candidate is equal to one of the series' OTHER names (`other_name`), or a
 * name matched EXACTLY and the chapter numbers do not line up (`numbering`). Out: a title that differs, a source that
 * did not answer, and -- PR #133's rule -- numbers that do not line up under a title that merely contains ours, which
 * is what a sequel or a spin-off looks like. The line-up is counted as judgeCandidate counts it: one copy per number
 * under the series' release preferences, whole numbers, both ways.
 */
function proposalOf(j: Judgement, hit: SourceSeries | null, primary: PrimaryFacts, prefs: ReleasePrefs): FindProposal | null {
  if (!j.theirTitle || (j.why !== 'ok' && j.why !== 'numbering_differs')) return null;
  // Reintroduce by dropping this line: "a review-first run follows nothing" reads Kappa Story's sequel proposed.
  if (j.why === 'numbering_differs' && titleMatch(j.theirTitle, primary) !== 'exact') return null;
  const byTitle = titleMatch(j.theirTitle, { title: primary.title }) !== null;
  const nums = chooseReleases(j.chapters ?? [], prefs).releases.map((c) => c.number);
  const whole = (xs: number[]) => new Set(xs.map((n) => Math.floor(n))).size;
  const green = j.why === 'ok' && byTitle;
  return {
    sourceId: j.source, sourceName: j.name, sourceSeriesId: j.sourceSeriesId,
    ...(hit?.url ? { url: hit.url } : {}),
    title: j.theirTitle,
    ...(hit?.coverUrl ? { coverUrl: hit.coverUrl } : {}),
    chapters: new Set((j.chapters ?? []).map((c) => c.number)).size,
    ours: { lined: assess(primary.numbers, nums).matched, of: whole(primary.numbers) },
    theirs: { lined: assess(nums, primary.numbers).matched, of: whole(nums) },
    coverage: j.coverage,
    verdict: green ? 'green' : 'amber',
    ...(green ? {} : { amber: j.why === 'ok' ? 'other_name' as const : 'numbering' as const }),
  };
}

/**
 * One series: search, judge, follow. `progress` receives each follow the moment it is written, so a run stopped
 * part-way through a series still reports what it did. `asked` is whether any source was searched.
 *
 * For a Replace run's series that no follower can take over (v0.54.0), `dead` names its followers that carry
 * nothing -- switched off, failing, not loaded -- which do not count against the follower cap, and before each follow
 * as many of them as the cap needs are dropped (worst first) and reported in `dropped`; a review marks the first green
 * match as the one it would promote.
 */
async function findFor(
  s: { id: string; title: string }, a: ActiveRun, progress: FoundSource[],
  replacing?: { dead: ReadonlyArray<{ sourceId: string; name: string }>; dropped: Array<{ sourceId: string; name: string }> },
): Promise<{ result: FindResult; asked: boolean }> {
  const end = (why: FindWhy | undefined, asked: boolean) =>
    ({ result: { seriesId: s.id, title: s.title, followed: [...progress], ...(why && !progress.length ? { why } : {}) }, asked });
  const row = await one<{ title: string; source_id: string | null; source_series_id: string | null; summary: string | null; numbering: string | null }>(
    `SELECT s.title, s.source_id, s.source_series_id, s.summary, s.numbering FROM lib_series s WHERE s.id = $1 AND ${visibleToAll('s')}`, [s.id]);
  // Hidden or merged away since the run started: nothing to follow onto, and nothing asked.
  if (!row) return end('not_tried', false);
  // Before anything else: no follower of a posting-order series is ever merged (lib/updater.ts), so none is sought.
  if (row.numbering === 'posting_order') return end('posting_order', false);
  const followers = new Set((await q<{ source_id: string }>('SELECT source_id FROM series_sources WHERE series_id = $1', [s.id]))
    .map((r) => r.source_id).filter((id) => id !== row.source_id));
  // The followers that count against the cap: for a Replace run, only the ones that still carry the series.
  // Reintroduce by counting every follower: "a series with no working follower is searched" in findSources.int.test.ts
  // reads full for the series whose two followers are switched off.
  const dead = new Set((replacing?.dead ?? []).map((d) => d.sourceId));
  const live = [...followers].filter((id) => !dead.has(id));
  const free = MAX_FOLLOWERS - live.length;
  if (free <= 0) return end('full', false);
  const numbers = await numbersOf(s.id);
  // judgeCandidate refuses every candidate of a series listing under MIN_HAVE numbers before asking anything, so
  // no source is searched for one: `too_few`, decided from the database -- not `refused`, which says a candidate was
  // found and failed the check. Reintroduce by answering `refused` here: "each series says why it gained nothing"
  // in findSources.int.test.ts reads refused for the series with two numbers.
  if (numbers.length < MIN_HAVE) return end('too_few', false);

  const health = new Map((await healthAll().catch(() => [])).map((h) => [h.source_id, h]));
  const now = Date.now();
  const resting = (id: string) => {
    const h = health.get(id);
    return !!h?.disabled || (!!h?.blocked_until && new Date(h.blocked_until).getTime() > now);
  };
  await learnNames(s.id, row, a, resting);
  const names = await altTitlesFor(s.id, SEARCH_NAMES);
  // The starting admin's reach, not the hunt's: an admin has no age cap, so every source -- including the many
  // manhwa extensions that flag themselves adult -- may be asked for a series that is not rated 18+. Reintroduce
  // the hunt's sweepAllowedFor: "an adult-flagged source is asked for a clean series" in findSources.int.test.ts
  // reads no_match.
  const allowed = (id: string) => sourceAllowedFor(getSource(id), a.maxAgeRating);
  // The series' language (v0.52.0, #123): its own first in the order, and a source in another language never searched
  // nor proposed -- a series whose every other source is in another language is `no_source`. Reintroduce by dropping
  // `fits`: "a Find other sources run never searches a source in another language" in languageGuard.int.test.ts
  // finds it searched.
  const lang = await seriesLanguage(s.id);
  const fits = await followGuard(s.id);
  const all = listSources();
  const order = scanOrder(all.filter((src) => allowed(src.id)), { id: row.source_id ?? '', lang: lang.lang })
    .filter(fits)
    .filter((id) => {
      // The main source ALWAYS: it is the one this run is working around.
      if (id === row.source_id || followers.has(id)) return false;
      if (resting(id)) return false;
      return !!getSource(id);
    });
  // Nothing left to ask: `no_source`, never `not_tried`, which is only what a stop, the wall or a restart cut short.
  // Reintroduce by answering not_tried: "each series says why it gained nothing" reads it for the series whose
  // every other source is turned off.
  if (!order.length) {
    // Said in the server log, by count: "no other source could be asked" on every series is a setup to fix (every
    // source switched off, cooling down, beyond the age cap, in another language, or none loaded), and the result
    // cannot say which.
    const taken = new Set([...(row.source_id ? [row.source_id] : []), ...followers]);
    const others = all.filter((x) => !taken.has(x.id));
    console.warn(`[find] ${s.id}: no source to ask -- ${all.length} loaded, ${all.length - others.length} its own, `
      + `${others.filter((x) => resting(x.id)).length} switched off or cooling down, `
      + `${others.filter((x) => !allowed(x.id)).length} beyond the age cap, `
      + `${others.filter((x) => !fits(x.id)).length} in another language than ${lang.lang ?? 'the series'}`);
    return end('no_source', false);
  }

  const primary: PrimaryFacts = { title: row.title, altTitles: names, numbers, lang: lang.lang, exactLang: lang.sameBaseSibling };
  const prefs = await effectivePrefsFor(await readSeriesPrefs(s.id), 0);
  const deadline = Date.now() + wallMs;
  const left = () => deadline - Date.now();
  const judged: Array<Judgement | null> = new Array(order.length).fill(null);
  // The search hit behind each judgement: its cover and page, for a review's proposal.
  const hits: Array<SourceSeries | null> = new Array(order.length).fill(null);
  let carriers = 0, ok = 0, answered = 0, asked = false, refused = false, unjudged = false, cut = false;
  const enough = () => ok >= free || carriers >= FIND_CARRIERS;
  // Scan order, under the hunt's slots (FIFO, so the order is the order sources are asked in). A source whose turn
  // comes after enough carried the title is not asked at all.
  await Promise.all(order.map(async (id, i) => {
    await takeHuntSlot();
    try {
      if (enough() || isStopped(a)) return;
      const src = getSource(id);
      if (!src) return;
      if (left() < MIN_TRY_MS) { cut = true; return; }
      asked = true;
      const found = await searchByNames(src, row.title, names, left);
      if (found.answered) answered++;
      if (!found.hit || enough() || isStopped(a)) return;
      carriers++;
      if (left() < MIN_TRY_MS) { cut = true; return; }
      // judgeCandidate answers its own failures as values; a throw out of this race is the wall's.
      const j = await bounded(judgeCandidate(primary, { source: id, sourceId: found.hit.sourceId }, { prefs, health }), left())
        .catch(() => null);
      if (!j) { cut = true; return; }
      judged[i] = j;
      hits[i] = found.hit;
      if (j.why === 'ok') ok++;
      // Failed the title or the chapter-number check: the one thing `refused` says. (`too_few_listed` cannot come
      // back: a series listing too few numbers ended `too_few` before any search.)
      else if (j.why === 'title_differs' || j.why === 'numbering_differs') refused = true;
      // `unreachable` / `unavailable`: the source that carried the title did not answer for its chapters, so the
      // candidate could not be judged -- a source that did not answer, not a refusal and not the wall.
      else unjudged = true;
    } finally { releaseHuntSlot(); }
  }));

  // Review first: nothing is followed. What the judgement found is kept for an admin, in scan order, and a series
  // with any of it ends here; one with none says why exactly as an automatic run would. Cut short by a stop, it is
  // `not_tried` (below), as automatic mode's series in flight is: what was found so far is not the whole answer.
  if (a.review) {
    const proposals = isStopped(a) ? [] : judged.flatMap((j, i) => {
      const p = j ? proposalOf(j, hits[i], primary, prefs) : null;
      return p ? [p] : [];
    });
    // Replace (v0.54.0): each is a source the search found, and the first green one is what the run would follow and
    // make the main source.
    if (replacing) {
      for (const p of proposals) p.kind = 'search';
      const green = proposals.find((p) => p.verdict === 'green');
      if (green) green.promote = true;
    }
    if (proposals.length) return { result: { seriesId: s.id, title: s.title, followed: [], proposals }, asked };
  }

  // The follows, in scan order, so which of several good sources the series takes is the order they were asked
  // in and not whichever answered first. Under followJudged's cap and lock: a hunt that followed one meanwhile
  // turns the next into `cap`. Never in review mode: an admin follows from the proposals (decideProposal).
  // Reintroduce by dropping the review branch above and this guard: "a review-first run follows nothing" in
  // findSources.int.test.ts finds its series following the sources it should have proposed.
  let capped = false, gone = false;
  for (const j of a.review ? [] : judged) {
    if (!j || j.why !== 'ok') continue;
    if (progress.length >= free || isStopped(a)) break;
    if (replacing) await makeRoom(s.id, replacing.dead, replacing.dropped);
    const written = await followJudged(s.id, j, { addedBy: a.userId }).catch(() => 'gone' as const);
    if (written === 'cap') { capped = true; break; }
    // Deleted or merged away while its turn ran (or the write failed): nothing to follow onto, and a source that
    // lines up was found -- so not "no match". Reintroduce by breaking without it: "a series deleted while its search
    // runs ends not tried" in findSources.int.test.ts reads no_match.
    if (written !== 'inserted') { gone = true; break; }
    const chapters = new Set((j.chapters ?? []).map((c) => c.number)).size;
    progress.push({ sourceId: j.source, name: j.name, chapters });
    await logAudit('series.follow_source', {
      userId: a.userId,
      detail: {
        id: s.id, title: row.title, source: j.source, sourceSeriesId: j.sourceSeriesId, coverage: j.coverage, theirTitle: j.theirTitle,
        via: replacing ? 'replace' : 'find_sources', runId: a.id,
      },
    });
  }
  if (progress.length) return end(undefined, asked);
  if (capped) return end('full', asked);
  if (gone || isStopped(a)) return end('not_tried', asked);
  if (refused) return end('refused', asked);
  // The wall: a source it never got to ask, or a judgement it could not wait for.
  if (cut) return end('not_tried', asked);
  // Every source in the order went away before its turn (uninstalled mid-series): none could be asked after all.
  if (!asked) return end('no_source', false);
  // Asked, and no answer to judge by: none of the sources answered, or the one that carried the title did not
  // answer for its chapters. Reintroduce `not_tried` for either: "each series says why it gained nothing" reads it
  // for the series whose one source throws, and for the one whose carrier's chapter list does not load.
  if (unjudged || !answered) return end('no_answer', asked);
  // Every source that answered was asked under every name and lists nothing that is this series. "No other source
  // lists it" would be false for a series that already follows one -- that source does -- so it says so instead.
  // (Not for a follower that carries nothing: that one lists nothing a sweep can take.)
  // Reintroduce by dropping this line: "each series says why it gained nothing" reads no_match for the series that
  // follows a source already.
  if (live.length) return end('followed_already', asked);
  return end('no_match', asked);
}

// ---- Replace (v0.54.0) ------------------------------------------------------------------------------------------

/**
 * Room under the follower cap for one more follow: as many of the series' dead followers as it takes, worst first
 * (failing, then not loaded, then switched off), each with its listing rows as an unfollow takes them, and each
 * written into `dropped`. The cap is counted as followJudged counts it, every row. Nothing is dropped while there is
 * room.
 */
async function makeRoom(
  seriesId: string, dead: ReadonlyArray<{ sourceId: string; name: string }>, dropped: Array<{ sourceId: string; name: string }>,
): Promise<void> {
  const [{ n }] = await q<{ n: number }>('SELECT count(*)::int AS n FROM series_sources WHERE series_id = $1', [seriesId]);
  let over = Number(n) - MAX_FOLLOWERS + 1;
  for (const d of dead) {
    if (over <= 0) break;
    if (dropped.some((x) => x.sourceId === d.sourceId)) continue;
    const gone = await q('DELETE FROM series_sources WHERE series_id = $1 AND source_id = $2 RETURNING source_id', [seriesId, d.sourceId]);
    if (!gone.length) continue;
    await q('DELETE FROM series_listing WHERE series_id = $1 AND source_id = $2', [seriesId, d.sourceId]).catch(() => {});
    dropped.push({ sourceId: d.sourceId, name: d.name });
    over--;
  }
}

/**
 * Wait, stop-aware, until no run is inside the series -- the sweep, a check, a listing refresh: such a run read the main
 * pair at its start and would write its listing and stamps from it after a switch (lib/mainSource.ts `busy`). Past
 * FIND_BUSY_WAIT_MS the series is `busy`; a re-run picks it up.
 */
async function waitOut(a: ActiveRun, seriesId: string): Promise<'clear' | 'busy' | 'stopped'> {
  const until = Date.now() + busyMs;
  while (runsInside(seriesId) > 0) {
    if (isStopped(a)) return 'stopped';
    const left = until - Date.now();
    if (left <= 0) return 'busy';
    await nap(a, Math.min(250, left));
  }
  return isStopped(a) ? 'stopped' : 'clear';
}

/** A switch refused, as the series' answer. A follower made the main source meanwhile is a series that moved. */
const whyOfRefusal = (r: MainRefusal): FindWhy =>
  r === 'moved' || r === 'is_main' ? 'moved'
    : r === 'busy' ? 'busy' : r === 'renumber_pending' ? 'renumber_pending' : r === 'posting_order' ? 'posting_order' : 'not_tried';

/** A review's proposals for a series' followers, best first, the first marked as the one the run would promote. */
function followerProposals(ranked: RankedFollower[], f: SeriesFacts): FindProposal[] {
  const whole = (xs: readonly number[]) => new Set(xs.map((n) => Math.floor(n))).size;
  return ranked.map((x, i) => {
    const listed = x.listed ?? [];
    const amber = x.standing === 'cooling' ? 'cooling' as const : x.cover < MIN_COVERAGE ? 'coverage' as const : x.tier === 1 ? 'stale' as const : undefined;
    return {
      kind: 'follower' as const, sourceId: x.sourceId, sourceName: x.name, sourceSeriesId: x.sourceSeriesId, title: x.title || x.name,
      chapters: x.chapters ?? new Set(listed).size,
      ours: { lined: assess(f.numbers, listed).matched, of: whole(f.numbers) },
      theirs: { lined: assess(listed, f.numbers).matched, of: whole(listed) },
      coverage: x.cover, newer: x.newer, standing: x.standing,
      verdict: amber ? 'amber' as const : 'green' as const, ...(amber ? { amber } : {}),
      ...(i === 0 ? { promote: true as const } : {}),
    };
  });
}

/**
 * One series of a Replace run: move it off the replaced source (`scope.sourceId`), or say why not.
 *   1. Said without anything written: hidden or merged since the run started (`not_tried`), no longer on that source
 *      (`moved`), numbered by posting order (`posting_order`: the series reads its numbering source alone), a renumber
 *      waiting (`renumber_pending`), or a run inside it past FIND_BUSY_WAIT_MS (`busy`).
 *   2. Its best working follower becomes its main source (lib/replaceSource.ts ranks them), the replaced source
 *      dropped from it. No search, no pacing: decided from the database.
 *   3. None can: it is searched for as Find does (findFor), its dead followers not counting against the cap, and the
 *      first source it follows becomes its main source. A search that finds nothing says so in Find's words.
 * Review first proposes instead (nothing is written): its followers, or what the search found. `track` hears of a
 * promotion the moment it is made, for an answer a stop cut short.
 */
async function replaceFor(
  s: { id: string; title: string }, a: ActiveRun, progress: FoundSource[], track: { promoted?: Promoted },
): Promise<{ result: FindResult; asked: boolean; refresh: boolean }> {
  const X = (a.scope as { sourceId: string }).sourceId;
  const fromName = getSource(X)?.name ?? X;
  let skipped: NonNullable<FindResult['skipped']> = [];
  const dropped: Array<{ sourceId: string; name: string }> = [];
  const done = (o: { why?: FindWhy; asked?: boolean; refresh?: boolean; proposals?: FindProposal[] } = {}) => ({
    result: {
      seriesId: s.id, title: s.title, followed: [...progress],
      ...(track.promoted ? { promoted: track.promoted } : o.why ? { why: o.why } : {}),
      ...(o.proposals?.length ? { proposals: o.proposals } : {}),
      // A dead follower dropped to make room is said once, as dropped.
      ...(skipped.some((x) => !dropped.some((d) => d.sourceId === x.sourceId))
        ? { skipped: skipped.filter((x) => !dropped.some((d) => d.sourceId === x.sourceId)) } : {}),
      ...(dropped.length ? { dropped } : {}),
    } as FindResult,
    asked: !!o.asked, refresh: !!o.refresh,
  });
  const row = await one<{ source_id: string | null; numbering: string | null; pending: boolean }>(
    `SELECT s.source_id, s.numbering, (s.numbering_pending IS NOT NULL OR s.renumber_plan IS NOT NULL) AS pending
       FROM lib_series s WHERE s.id = $1 AND ${visibleToAll('s')}`, [s.id]);
  if (!row) return done({ why: 'not_tried' });
  // Before anything is read or searched for it: the switch would refuse it too (`expect`), but only after a series with
  // no follower had been searched for and given followers it never asked for. Reintroduce by dropping it: "a series
  // moved off the source after the run started" in findSources.int.test.ts is searched for.
  if (row.source_id !== X) return done({ why: 'moved' });
  // The switch refuses it too (lib/mainSource.ts); said here before anything is read for it.
  if (row.numbering === 'posting_order') return done({ why: 'posting_order' });
  if (row.pending || renumberRunning(s.id)) return done({ why: 'renumber_pending' });
  const first = await waitOut(a, s.id);
  if (first !== 'clear') return done({ why: first === 'busy' ? 'busy' : 'not_tried' });

  const facts = (await replaceFacts([s.id], { maxAgeRating: a.maxAgeRating, numbers: true })).get(s.id);
  if (!facts) return done({ why: 'not_tried' });
  const { ranked, skipped: passed } = rankFollowers(facts.followers, { numbers: facts.numbers, held: facts.held });
  skipped = passed;
  // ---- 2: a follower takes over -----------------------------------------------------------------------------------
  if (ranked.length) {
    if (a.review) return done({ proposals: followerProposals(ranked, facts) });
    for (const f of ranked) {
      if (isStopped(a)) return done({ why: 'not_tried' });
      const out = await switchMainSource(s.id, f.sourceId, { old: 'drop', ctx: a.ctx, userId: a.userId, via: 'replace', runId: a.id, expect: X });
      if ('ok' in out) {
        track.promoted = { from: X, fromName, to: f.sourceId, toName: f.name, via: 'follower', old: out.old };
        // Passed over: the ones that could not, and a cooling one that was not the one taken.
        skipped = [...passed, ...ranked.filter((x) => x !== f && x.standing === 'cooling').map((x) => ({ sourceId: x.sourceId, name: x.name, why: 'cooling' as const }))];
        // The listing again, through the new main, only when the old main took rows with it: the sweep re-lists the rest.
        return done({ refresh: out.listingDropped > 0 });
      }
      // The follower went between the ranking and the switch (switched off, unfollowed, another language now): the next
      // may still take over. Anything else is the series' own answer.
      if (out.refused === 'source_unavailable' || out.refused === 'not_followed' || out.refused === 'language_differs') continue;
      return done({ why: whyOfRefusal(out.refused) });
    }
  }
  // ---- 3: none can -- search, follow, promote ----------------------------------------------------------------------
  const found = await findFor(s, a, progress, { dead: deadFollowers(facts), dropped });
  if (a.review || !progress.length) {
    const proposals = found.result.proposals;
    return done(proposals?.length ? { proposals, asked: found.asked } : { why: found.result.why ?? 'no_match', asked: found.asked });
  }
  const again = await waitOut(a, s.id);
  if (again !== 'clear') return done({ why: again === 'busy' ? 'busy' : 'not_tried', asked: found.asked, refresh: true });
  const to = progress[0];
  // Reintroduce by not promoting after a follow: "a series with no working follower is searched, followed and
  // promoted" in findSources.int.test.ts finds it still on the replaced source.
  const out = await switchMainSource(s.id, to.sourceId, { old: 'drop', ctx: a.ctx, userId: a.userId, via: 'replace', runId: a.id, expect: X });
  if ('ok' in out) track.promoted = { from: X, fromName, to: to.sourceId, toName: to.name, via: 'search', old: out.old };
  return done({ ...('ok' in out ? {} : { why: whyOfRefusal(out.refused) }), asked: found.asked, refresh: true });
}

/**
 * GET /api/admin/sources/:id/replace-preview (v0.54.0): what a Replace run over this source would do, as the dialog
 * says it before Start -- the series whose main source it is, those a follower would take over at once, those it would
 * search for, those it leaves alone (posting order) -- and whether a run is going already (one at a time).
 */
export async function replacePreview(sourceId: string, ctx: ViewCtx): Promise<{
  main: number; withBackup: number; toSearch: number; postingOrder: number; busy: boolean;
}> {
  const list = await seriesOfMainSource(sourceId, ctx);
  const counts = await replaceCounts(list.map((x) => x.id), ctx.maxAgeRating);
  return { main: list.length, ...counts, busy: !!findRunning() };
}

// ---- the refresh after a run --------------------------------------------------------------------------------

const refreshQueue: string[] = [];
let refreshing: Promise<void> | null = null;

/**
 * A listing refresh of every series that gained a follower, one at a time and PACE_MS apart, in the background:
 * the follow route's own refresh (updateSeries with nothing to download), so the new source's chapters show on the
 * series page as rows to fetch and the sweep takes them from there. Two runs' refreshes share one queue.
 */
function scheduleFindRefresh(ids: readonly string[]): void {
  for (const id of ids) if (!refreshQueue.includes(id)) refreshQueue.push(id);
  if (refreshing) return;
  refreshing = (async () => {
    try {
      while (refreshQueue.length && !runtime.stopping) {
        const id = refreshQueue.shift()!;
        await updateSeries(id, 0).catch((e) => console.warn(`[find] refresh of ${id} failed: ${(e as Error)?.message || e}`));
        if (refreshQueue.length) await new Promise((r) => setTimeout(r, paceMs));
      }
    } finally { refreshing = null; }
  })();
}

// ---- deciding a review --------------------------------------------------------------------------------------

/** Why a proposal was not followed or dismissed; the route answers each with its own status and words. */
export type DecideRefusal =
  | 'not_found' | 'decided' | 'posting_order' | 'source_unavailable' | 'language_differs' | 'already_followed' | 'full';

/** A refusal, with the proposal's state when it was decided already, and the edition to add when it is the language. */
export type DecideRefused = {
  refused: DecideRefusal; state?: FindProposal['state']; edition?: { of: string; lang: string; existing?: { id: string; lang: string } };
};

/** One decision at a time in this process: the check, the follow and the mark of one never interleave another's. */
let deciding: Promise<unknown> = Promise.resolve();

/**
 * Follow one proposal of a review-first run, or dismiss it (v0.51.0; POST /api/admin/sources/find/:runId/follow and
 * …/dismiss). The client names a series and a source; WHAT is followed -- the source's series id, its title, the
 * coverage -- is the run's own record, never the client's, as the manual route takes a candidate only from its own
 * scan plan. A follow is checked again against what may have changed since the run judged it, and refused with the
 * reason:
 *   - `not_found`: no such run, proposal or series, or a series this admin may not see;
 *   - `decided`: followed or dismissed already (with `state`) -- a dismissed proposal stays dismissed;
 *   - `posting_order`: numbered by posting order since (#116), whose followers are never merged;
 *   - `source_unavailable`: the source is no longer loaded, is switched off, is the series' main source now, or is
 *     beyond the deciding admin's age cap (the run's own rule);
 *   - `language_differs`: the source is in another language than the series (v0.52.0, #123) -- a run kept from
 *     before the guard, or a series whose language an admin has set since -- with `edition`, the add route's own
 *     `{of, lang}`: what has both is that language as an edition, as the manual follow's refusal says;
 *   - `already_followed`: the series follows that source already. INSERT-only, PR #133's rule: a run is kept for
 *     weeks, and a source followed another way since may point at another entry, which a stale proposal must not
 *     re-point;
 *   - `full`: followJudged's cap -- the same write as every other follow, under the series row's lock.
 * Followed, it is written with this admin as its author and gets the listing refresh an automatic run's follows get.
 */
export function decideProposal(
  runId: string, seriesId: string, sourceId: string, decision: 'follow' | 'dismiss', userId: string, ctx: ViewCtx,
): Promise<{ result: FindResult } | DecideRefused> {
  const next = deciding.then(() => decide(runId, seriesId, sourceId, decision, userId, ctx));
  deciding = next.catch(() => {});
  return next;
}

async function decide(
  runId: string, seriesId: string, sourceId: string, decision: 'follow' | 'dismiss', userId: string, ctx: ViewCtx,
): Promise<{ result: FindResult } | DecideRefused> {
  const find = (results: FindResult[] | undefined) => {
    const r = results?.find((x) => x.seriesId === seriesId);
    return { r, p: r?.proposals?.find((x) => x.sourceId === sourceId) };
  };
  const stored = await one<{ scope: { review?: boolean } | null; results: FindResult[] }>(
    'SELECT scope, results FROM source_find_runs WHERE id::text = $1', [runId]);
  const { p } = find(stored?.scope?.review ? stored.results : undefined);
  if (!p || !(await seriesVisible(seriesId, ctx))) return { refused: 'not_found' };
  // Final: reintroduce by dropping this line and "a dismissed proposal stays dismissed" follows it.
  if (p.state) return { refused: 'decided', state: p.state };
  if (decision === 'follow') {
    const series = await one<{ title: string; source_id: string | null }>('SELECT title, source_id FROM lib_series WHERE id = $1', [seriesId]);
    if (!series) return { refused: 'not_found' };
    // The manual route's refusal, before anything is written. Reintroduce by dropping it, or the already-followed
    // line, or the `cap` arm below: "following a proposal follows exactly that one" fails by the rule's own name.
    if (await postingOrderSeries(seriesId)) return { refused: 'posting_order' };
    const h = await one<{ disabled: boolean }>('SELECT disabled FROM source_health WHERE source_id = $1', [sourceId]).catch(() => null);
    // The deciding admin's reach, the run's own rule (findFor): a source the run could ask, it can follow.
    const src = getSource(sourceId);
    if (!src || h?.disabled || series.source_id === sourceId || !sourceAllowedFor(src, ctx.maxAgeRating)) return { refused: 'source_unavailable' };
    // The same-language guard, again at the follow: a review can wait for weeks. Reintroduce by dropping it: "a
    // proposal in another language is refused" in languageGuard.int.test.ts follows it. The refusal carries the
    // edition to add instead, which the web offers as a key beside it -- or, when the work holds one that may follow
    // the source already, that edition (`existing`), which the key opens instead.
    if (!(await followGuard(seriesId))(sourceId)) {
      const existing = await editionFollowing(seriesId, sourceId, ctx);
      return { refused: 'language_differs', edition: { of: seriesId, lang: sourceLanguage(sourceId), ...(existing ? { existing } : {}) } };
    }
    if (await one('SELECT 1 FROM series_sources WHERE series_id = $1 AND source_id = $2', [seriesId, sourceId])) return { refused: 'already_followed' };
    const written = await followJudged(seriesId,
      { source: sourceId, name: p.sourceName, sourceSeriesId: p.sourceSeriesId, theirTitle: p.title, coverage: p.coverage },
      { addedBy: userId }).catch(() => 'gone' as const);
    if (written === 'cap') return { refused: 'full' };
    if (written !== 'inserted') return { refused: 'not_found' };
    await logAudit('series.follow_source', {
      userId,
      detail: {
        id: seriesId, title: series.title, source: sourceId, sourceSeriesId: p.sourceSeriesId, coverage: p.coverage, theirTitle: p.title,
        via: 'find_review', runId, verdict: p.verdict, ...(p.amber ? { amber: p.amber } : {}),
      },
    });
  }
  const state = decision === 'follow' ? 'followed' as const : 'dismissed' as const;
  const mark = (r: FindResult, prop: FindProposal) => {
    prop.state = state;
    if (state === 'followed' && !r.followed.some((f) => f.sourceId === prop.sourceId)) {
      r.followed.push({ sourceId: prop.sourceId, name: prop.sourceName, chapters: prop.chapters });
    }
  };
  // Marked under the run row's lock: the run itself may be appending the next series' result meanwhile.
  const result = await tx(async (qq) => {
    const row = (await qq<{ results: FindResult[] }>('SELECT results FROM source_find_runs WHERE id::text = $1 FOR UPDATE', [runId]))[0];
    const { r, p: prop } = find(row?.results);
    if (!row || !r || !prop) return null;
    mark(r, prop);
    await qq('UPDATE source_find_runs SET results = $2::jsonb, followed = followed + $3 WHERE id::text = $1',
      [runId, JSON.stringify(row.results), state === 'followed' ? 1 : 0]);
    return r;
  });
  // The run going now is read from memory (findState), which must say the same.
  const a = active;
  if (a?.id === runId) {
    const { r, p: prop } = find(a.results);
    if (r && prop) mark(r, prop);
    if (state === 'followed') a.card.followed = ++a.followed;
  }
  if (state === 'followed') {
    scheduleFindRefresh([seriesId]);
    scheduleHealthSummaryRefresh();
  }
  return result ? { result } : { refused: 'not_found' };
}

/** Why a Replace review's proposal was not made the main source (v0.54.0): a decision's refusals, and a switch's. */
export type PromoteRefusal = DecideRefusal | 'moved' | 'busy' | 'renumber_pending' | 'not_followed' | 'is_main';
export type PromoteRefused = Omit<DecideRefused, 'refused'> & { refused: PromoteRefusal; said?: Part };

/**
 * Make one proposal of a Replace review the series' main source (v0.54.0; POST /api/admin/sources/find/:runId/promote).
 * As a decision: the run's own record of what is promoted, never the client's, in the same one-at-a-time chain.
 *   - a follower's proposal is switched to (lib/mainSource.ts), the replaced source dropped from the series;
 *   - a search's is checked again as a follow is (decide's checks), followed under the cap -- dead followers making
 *     room as the run's own follows would -- and then switched to.
 * Refused: `not_found`, `decided` (with `state`), the follow's refusals (`posting_order`, `source_unavailable`,
 * `language_differs` with `edition`, `full`), and the switch's (`moved` -- the series is no longer on the replaced
 * source -- `busy`, `renumber_pending`, `not_followed`, `is_main`), each with its said code where it has one.
 * Promoted, the proposal reads `promoted` and the series' result carries `promoted`.
 */
export function promoteProposal(
  runId: string, seriesId: string, sourceId: string, userId: string, ctx: ViewCtx,
): Promise<{ result: FindResult } | PromoteRefused> {
  const next = deciding.then(() => promote(runId, seriesId, sourceId, userId, ctx));
  deciding = next.catch(() => {});
  return next;
}

async function promote(
  runId: string, seriesId: string, sourceId: string, userId: string, ctx: ViewCtx,
): Promise<{ result: FindResult } | PromoteRefused> {
  const find = (results: FindResult[] | undefined) => {
    const r = results?.find((x) => x.seriesId === seriesId);
    return { r, p: r?.proposals?.find((x) => x.sourceId === sourceId) };
  };
  const stored = await one<{ scope: { review?: boolean; mode?: string; sourceId?: string } | null; results: FindResult[] }>(
    'SELECT scope, results FROM source_find_runs WHERE id::text = $1', [runId]);
  const X = stored?.scope?.review && stored.scope.mode === 'replace' ? stored.scope.sourceId : undefined;
  const { p } = find(X ? stored!.results : undefined);
  if (!X || !p || !(await seriesVisible(seriesId, ctx))) return { refused: 'not_found' };
  // Final, as a decision is: reintroduce by dropping it, and "promote does exactly that" promotes twice.
  if (p.state) return { refused: 'decided', state: p.state };
  if (p.kind === 'search') {
    const series = await one<{ source_id: string | null }>('SELECT source_id FROM lib_series WHERE id = $1', [seriesId]);
    if (!series) return { refused: 'not_found' };
    if (series.source_id !== X) return { refused: 'moved', said: say('main.moved') };
    if (await postingOrderSeries(seriesId)) return { refused: 'posting_order', said: say('numbering.postingRefusal') };
    const h = await one<{ disabled: boolean }>('SELECT disabled FROM source_health WHERE source_id = $1', [sourceId]).catch(() => null);
    const src = getSource(sourceId);
    if (!src || h?.disabled || !sourceAllowedFor(src, ctx.maxAgeRating)) return { refused: 'source_unavailable', said: say('main.unavailable') };
    if (!(await followGuard(seriesId))(sourceId)) {
      const existing = await editionFollowing(seriesId, sourceId, ctx);
      return { refused: 'language_differs', edition: { of: seriesId, lang: sourceLanguage(sourceId), ...(existing ? { existing } : {}) } };
    }
    if (!(await one('SELECT 1 FROM series_sources WHERE series_id = $1 AND source_id = $2', [seriesId, sourceId]))) {
      const facts = (await replaceFacts([seriesId], { maxAgeRating: ctx.maxAgeRating })).get(seriesId);
      const dropped: Array<{ sourceId: string; name: string }> = [];
      if (facts) await makeRoom(seriesId, deadFollowers(facts), dropped);
      const written = await followJudged(seriesId,
        { source: sourceId, name: p.sourceName, sourceSeriesId: p.sourceSeriesId, theirTitle: p.title, coverage: p.coverage },
        { addedBy: userId }).catch(() => 'gone' as const);
      if (written === 'cap') return { refused: 'full' };
      if (written !== 'inserted') return { refused: 'not_found' };
      await logAudit('series.follow_source', {
        userId,
        detail: {
          id: seriesId, source: sourceId, sourceSeriesId: p.sourceSeriesId, coverage: p.coverage, theirTitle: p.title,
          via: 'replace_review', runId, verdict: p.verdict, ...(dropped.length ? { dropped: dropped.map((d) => d.sourceId) } : {}),
        },
      });
    }
  }
  const out = await switchMainSource(seriesId, sourceId, { old: 'drop', ctx, userId, via: 'review', runId, expect: X });
  if ('refused' in out) {
    return out.refused === 'not_found' ? { refused: 'not_found' }
      : { refused: out.refused, ...(out.said ? { said: out.said } : {}), ...(out.edition ? { edition: out.edition } : {}) };
  }
  const promoted: Promoted = {
    from: X, fromName: getSource(X)?.name ?? X, to: sourceId, toName: p.sourceName, via: p.kind === 'search' ? 'search' : 'follower', old: out.old,
  };
  const mark = (r: FindResult, prop: FindProposal) => {
    prop.state = 'promoted';
    r.promoted = promoted;
    delete r.why;
    if (p.kind === 'search' && !r.followed.some((f) => f.sourceId === sourceId)) r.followed.push({ sourceId, name: p.sourceName, chapters: p.chapters });
  };
  // Marked under the run row's lock: the run itself may be appending the next series' result meanwhile.
  const result = await tx(async (qq) => {
    const row = (await qq<{ results: FindResult[] }>('SELECT results FROM source_find_runs WHERE id::text = $1 FOR UPDATE', [runId]))[0];
    const { r, p: prop } = find(row?.results);
    if (!row || !r || !prop) return null;
    mark(r, prop);
    await qq('UPDATE source_find_runs SET results = $2::jsonb, followed = followed + $3 WHERE id::text = $1',
      [runId, JSON.stringify(row.results), p.kind === 'search' ? 1 : 0]);
    return r;
  });
  const a = active;
  if (a?.id === runId) {
    const { r, p: prop } = find(a.results);
    if (r && prop) mark(r, prop);
    a.card.promoted = ++a.promoted;
    if (p.kind === 'search') a.card.followed = ++a.followed;
  }
  scheduleFindRefresh([seriesId]);
  scheduleHealthSummaryRefresh();
  return result ? { result } : { refused: 'not_found' };
}

// ---- reading it back ----------------------------------------------------------------------------------------

export interface FindRunSummary {
  id: string;
  status: FindStatus;
  total: number;
  done: number;
  followed: number;
  /** The account that started it, by name (never its id), or null for an account since deleted. */
  startedBy: string | null;
  startedAt: string;
  finishedAt?: string;
  /** The source whose series it was about, when the scope was a source: what the Health button asked. */
  sourceId?: string;
  sourceName?: string;
  /** Review first (v0.51.0): it followed nothing itself, and its results carry `proposals`. */
  review?: true;
  /** v0.54.0: a Replace run, and how many of its series it moved to another main source (counted from its results). */
  mode?: 'replace';
  promoted?: number;
}
export interface FindRun extends FindRunSummary {
  /**
   * v0.54.0, a Replace run read in full: how many series are on the replaced source now, and whether it is switched off
   * now (source_health.disabled) -- whether this run's `turnOff` did it, or an admin before.
   */
  left?: number;
  turnedOff?: boolean;
  current?: { seriesId: string; title: string };
  /** What a running run waits on before its next series. */
  waiting?: 'sweep' | 'repair' | 'check';
  results: FindResult[];
}

type Row = {
  id: string; status: FindStatus; total: number; done: number; followed: number; promoted: number; username: string | null;
  started_at: Date; finished_at: Date | null; scope: { sourceId?: string; review?: boolean; mode?: string } | null; results?: FindResult[];
};
const iso = (d: Date | string) => new Date(d).toISOString();
const scopeOf = (scope: Row['scope'] | null | undefined) => ({
  ...(scope?.sourceId ? { sourceId: scope.sourceId, sourceName: getSource(scope.sourceId)?.name ?? scope.sourceId } : {}),
  ...(scope?.review === true ? { review: true as const } : {}),
});
const summaryOf = (r: Row): FindRunSummary => ({
  id: r.id, status: r.status, total: Number(r.total), done: Number(r.done), followed: Number(r.followed),
  startedBy: r.username, startedAt: iso(r.started_at), ...(r.finished_at ? { finishedAt: iso(r.finished_at) } : {}),
  ...scopeOf(r.scope),
  ...(r.scope?.mode === 'replace' ? { mode: 'replace' as const, promoted: Number(r.promoted) } : {}),
});

/**
 * GET /api/admin/sources/find: whether a run is going, the running run or else the newest one in full, and the
 * kept runs as summaries, newest first. The running run is read from memory, which is ahead of its row.
 *
 * `runId` (v0.52.0): that kept run in full instead -- an earlier search reopened from the results sheet, above all a
 * review-first run whose matches still wait for a decision, which only the newest run could be read for. `run` is
 * null when no kept run has that id. Reintroduce by reading the newest whatever is asked: "an earlier search opens by
 * its id" in findSources.int.test.ts reads the newer run.
 */
export async function findState(o: { runId?: string } = {}): Promise<{ running: boolean; run: FindRun | null; recent: FindRunSummary[] }> {
  await closeInterruptedFindRuns().catch(() => {});
  // `promoted` from the results themselves (v0.54.0): no column, so v0.53.x boots on the same rows.
  const rows = await q<Row>(
    `SELECT r.id, r.status, r.total, r.done, r.followed, u.username, r.started_at, r.finished_at, r.scope,
            (SELECT count(*) FROM jsonb_array_elements(r.results) e WHERE e ? 'promoted')::int AS promoted
       FROM source_find_runs r LEFT JOIN users u ON u.id::text = r.started_by
      ORDER BY r.started_at DESC LIMIT $1`, [FIND_KEEP]);
  const a = active;
  const recent = rows.map(summaryOf).map((r) => (a && r.id === a.id
    ? { ...r, done: a.done, followed: a.followed, ...(a.mode === 'replace' ? { promoted: a.promoted } : {}) } : r));
  let run: FindRun | null = null;
  const lead = o.runId !== undefined ? recent.find((r) => r.id === o.runId) : recent[0];
  if (a && lead?.id === a.id) {
    run = {
      ...lead, results: [...a.results],
      ...(a.current ? { current: { ...a.current } } : {}),
      ...(a.waiting ? { waiting: a.waiting } : {}),
    };
  } else if (lead) {
    const full = await one<{ results: FindResult[] }>('SELECT results FROM source_find_runs WHERE id = $1', [lead.id]);
    run = { ...lead, results: full?.results ?? [] };
  }
  // A Replace run's source as it is now: how many series are still on it, and whether it is switched off.
  if (run?.mode === 'replace' && run.sourceId) {
    const X = run.sourceId;
    run.left = (await mainSourceCounts([X]).catch(() => null))?.get(X) ?? 0;
    run.turnedOff = await isDisabled(X).catch(() => false);
  }
  return { running: !!a, run, recent };
}

// ---- test seams ---------------------------------------------------------------------------------------------

/** Tests: shorter pauses, wall, polling and busy wait; pass nothing to put the defaults back. */
export function setFindTiming(t: { paceMs?: number; wallMs?: number; quietMs?: number; busyMs?: number } = {}): void {
  paceMs = t.paceMs ?? PACE_MS;
  wallMs = t.wallMs ?? FIND_SERIES_WALL_MS;
  quietMs = t.quietMs ?? FIND_QUIET_POLL_MS;
  busyMs = t.busyMs ?? FIND_BUSY_WAIT_MS;
}
/** Tests: the run in flight (or the last one) and the refresh queue behind it, settled. */
export async function findSettled(): Promise<void> {
  await lastRun.catch(() => {});
  await refreshing?.catch(() => {});
}

/**
 * A shutdown (server.ts, once runtime.stopping is set): wait for the run going now to close its own row --
 * `interrupted`, every series it never reached listed as `not_tried`, its audit line written -- but never longer
 * than `ms`, because a shutdown must not hang on a slow site. Whatever it does not finish, the next boot's
 * closeInterruptedFindRuns does. Reintroduce by not waiting (dropping the call from server.ts): "a shutdown lets
 * the run close its own row" in findSources.int.test.ts finds the handler without it.
 */
export async function findSettledWithin(ms = FIND_SHUTDOWN_MS): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([findSettled(), new Promise<void>((r) => { timer = setTimeout(r, ms); })]);
  clearTimeout(timer);
}
