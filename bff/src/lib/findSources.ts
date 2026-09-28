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
//   - where to look: scanOrder over the sources the series may reach -- the adult rule is the hunt's
//     (sweepAllowedFor: an adult source only for an adult series) -- with the main source excluded ALWAYS (it is
//     the one that is down) and the sources it already follows, and health read per series, so a source disabled
//     or cooling down since the run started is not asked;
//   - how to look: the hunt's non-reporting search (sourceHunt.ts searchByNames) under the hunt's shared slots,
//     the title and up to three of the series' other names (lib/altTitles.ts), an other name matched exactly. A
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
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { q, one } from './db';
import { getSource, listSources } from './sources';
import { healthAll } from './sourceHealth';
import { scanOrder } from './scanOrder';
import { judgeCandidate, followJudged, bounded, MAX_FOLLOWERS, MIN_TRY_MS, type Judgement, type PrimaryFacts } from './autoFollow';
import { effectivePrefsFor, readSeriesPrefs } from './scanlatorPrefs';
import { MIN_HAVE } from './fill';
import { haveNumbers } from './libraryNumbers';
import { altTitlesFor, SEARCH_NAMES } from './altTitles';
import { searchByNames, seriesIsAdult, sweepAllowedFor, takeHuntSlot, releaseHuntSlot } from './sourceHunt';
import { seriesByIds, seriesOfMainSource } from './findScope';
import { runtime } from './runtime';
import { checkRunning } from './sourceWatchdog';
import { beginRun, endRun, stopRequested, type RunCard } from './downloadJobs';
import { say } from './said';
import { updateSeries } from './updater';
import { PACE_MS } from './bulkNewest';
import { scheduleHealthSummaryRefresh } from './healthSummary';
import { logAudit } from './audit';
import { visibleToAll, type ViewCtx } from './visibility';

/** How long one series may spend searching and judging before what is left of it is `not_tried`. */
export const FIND_SERIES_WALL_MS = 90_000;
/** Sources that carry the title before a series stops asking more: the fill scan's SCAN_ENOUGH. */
export const FIND_CARRIERS = 3;
/** How often a run waiting on a sweep, a repair or the daily check looks again. */
export const FIND_QUIET_POLL_MS = 5_000;
/** Runs kept in source_find_runs. */
export const FIND_KEEP = 20;
/** How long a stop waits for the series in flight to finish writing a follow it has started. */
const STOP_GRACE_MS = 1_000;
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
 * - `no_source`: no other source could be asked -- every one disabled, cooling down, adult for a clean series, or
 *   one it already follows (not searched);
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
  | 'refused' | 'no_answer' | 'followed_already' | 'no_match' | 'not_tried';
export interface FoundSource { sourceId: string; name: string; chapters: number }
/**
 * `title` is left out for a series the viewer may not list (routes/findSources.ts), and for one a restart's close
 * could no longer find in the library.
 */
export interface FindResult { seriesId: string; title?: string; followed: FoundSource[]; why?: FindWhy }
export type FindScope = { seriesIds: string[] } | { sourceId: string };

interface ActiveRun {
  id: string;
  userId: string;
  startedAt: number;
  scope: FindScope;
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
 */
export async function startFind(
  scope: FindScope, userId: string, ctx: ViewCtx, from?: FastifyRequest,
): Promise<{ runId: string; total: number } | { busy: string } | { empty: true }> {
  const running = findRunning();
  if (running) return { busy: running };
  const id = randomUUID();
  claimed = id;
  try {
    const list = 'sourceId' in scope ? await seriesOfMainSource(scope.sourceId, ctx) : await seriesByIds(scope.seriesIds, ctx);
    if (!list.length) { claimed = null; return { empty: true }; }
    await closeInterruptedFindRuns();
    // The ids it resolved to, for either kind: what closeInterruptedFindRuns lists as not tried if the process goes
    // away under the run. Reintroduce by storing {sourceId} alone: "a restart lists every series the run never
    // reached as not tried" in findSources.int.test.ts finds no seriesIds in the scope.
    const ids = list.map((s) => s.id);
    const stored = 'sourceId' in scope ? { sourceId: scope.sourceId, seriesIds: ids } : { seriesIds: ids };
    await q(`INSERT INTO source_find_runs (id, started_by, status, scope, total) VALUES ($1, $2, 'running', $3::jsonb, $4)`,
      [id, userId, JSON.stringify(stored), list.length]);
    const card = beginRun('find_sources', userId, list.length);
    // It searches and follows; it downloads nothing (the refresh at its end fetches no chapter either), so it is a
    // Server task that does not turn the Library ring.
    card.downloads = false;
    card.followed = 0;
    let signal!: () => void;
    const stopped = new Promise<void>((r) => { signal = r; });
    const a: ActiveRun = {
      id, userId, startedAt: Date.now(), scope, total: list.length, done: 0, followed: 0, results: [],
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
      // One series failing outright (the database going away mid-series) is that series' `not_tried`, and the run
      // goes on: bulk Fetch newest's rule.
      const work = findFor(s, a, progress).catch((e) => {
        console.warn(`[find] ${s.id}: ${(e as Error)?.message || e}`);
        return null;
      });
      let outcome = await Promise.race([work, a.stopped.then(() => undefined)]);
      // A stop does not wait for the searches in flight (up to the wall), but it does give a follow being written
      // a moment to land, so the answer reports every source the run followed.
      if (outcome === undefined) outcome = await Promise.race([work, new Promise<undefined>((r) => setTimeout(() => r(undefined), STOP_GRACE_MS))]);
      // Stopped mid-series: whatever it followed before the stop stands, and the rest of it was not tried.
      const result: FindResult = outcome?.result ?? { seriesId: s.id, title: s.title, followed: [...progress], ...(progress.length ? {} : { why: 'not_tried' as const }) };
      settled.add(s.id);
      a.results.push(result);
      a.done++;
      a.followed += result.followed.length;
      a.card.done = a.done;
      a.card.followed = a.followed;
      if (result.followed.length) refresh.push(s.id);
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
    endRun(a.card, status === 'failed' ? 'error' : 'done', status === 'failed' ? say('run.failed') : undefined);
    await logAudit('source.find', {
      userId: a.userId,
      detail: {
        runId: a.id, scope: 'sourceId' in a.scope ? { sourceId: a.scope.sourceId } : { seriesIds: a.total },
        status, total: a.total, done: a.done, followed: a.followed,
        series: a.results.filter((r) => r.followed.length).length,
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
 * One series: search, judge, follow. `progress` receives each follow the moment it is written, so a run stopped
 * part-way through a series still reports what it did. `asked` is whether any source was searched.
 */
async function findFor(
  s: { id: string; title: string }, a: ActiveRun, progress: FoundSource[],
): Promise<{ result: FindResult; asked: boolean }> {
  const end = (why: FindWhy | undefined, asked: boolean) =>
    ({ result: { seriesId: s.id, title: s.title, followed: [...progress], ...(why && !progress.length ? { why } : {}) }, asked });
  const row = await one<{ title: string; source_id: string | null; numbering: string | null }>(
    `SELECT s.title, s.source_id, s.numbering FROM lib_series s WHERE s.id = $1 AND ${visibleToAll('s')}`, [s.id]);
  // Hidden or merged away since the run started: nothing to follow onto, and nothing asked.
  if (!row) return end('not_tried', false);
  // Before anything else: no follower of a posting-order series is ever merged (lib/updater.ts), so none is sought.
  if (row.numbering === 'posting_order') return end('posting_order', false);
  const followers = new Set((await q<{ source_id: string }>('SELECT source_id FROM series_sources WHERE series_id = $1', [s.id]))
    .map((r) => r.source_id).filter((id) => id !== row.source_id));
  const free = MAX_FOLLOWERS - followers.size;
  if (free <= 0) return end('full', false);
  const numbers = await numbersOf(s.id);
  // judgeCandidate refuses every candidate of a series listing under MIN_HAVE numbers before asking anything, so
  // no source is searched for one: `too_few`, decided from the database -- not `refused`, which says a candidate was
  // found and failed the check. Reintroduce by answering `refused` here: "each series says why it gained nothing"
  // in findSources.int.test.ts reads refused for the series with two numbers.
  if (numbers.length < MIN_HAVE) return end('too_few', false);

  const names = await altTitlesFor(s.id, SEARCH_NAMES);
  const allowed = await sweepAllowedFor(await seriesIsAdult(s.id));
  const health = new Map((await healthAll().catch(() => [])).map((h) => [h.source_id, h]));
  const now = Date.now();
  const own = row.source_id ? getSource(row.source_id) : null;
  const order = scanOrder(listSources().filter((src) => allowed(src.id)), own ? { id: own.id, lang: own.lang } : null)
    .filter((id) => {
      // The main source ALWAYS: it is the one this run is working around.
      if (id === row.source_id || followers.has(id)) return false;
      const h = health.get(id);
      if (h?.disabled) return false;
      if (h?.blocked_until && new Date(h.blocked_until).getTime() > now) return false;
      return !!getSource(id);
    });
  // Nothing left to ask: `no_source`, never `not_tried`, which is only what a stop, the wall or a restart cut short.
  // Reintroduce by answering not_tried: "each series says why it gained nothing" reads it for the series whose
  // every other source is turned off.
  if (!order.length) return end('no_source', false);

  const primary: PrimaryFacts = { title: row.title, altTitles: names, numbers };
  const prefs = await effectivePrefsFor(await readSeriesPrefs(s.id), 0);
  const deadline = Date.now() + wallMs;
  const left = () => deadline - Date.now();
  const judged: Array<Judgement | null> = new Array(order.length).fill(null);
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
      if (j.why === 'ok') ok++;
      // Failed the title or the chapter-number check: the one thing `refused` says. (`too_few_listed` cannot come
      // back: a series listing too few numbers ended `too_few` before any search.)
      else if (j.why === 'title_differs' || j.why === 'numbering_differs') refused = true;
      // `unreachable` / `unavailable`: the source that carried the title did not answer for its chapters, so the
      // candidate could not be judged -- a source that did not answer, not a refusal and not the wall.
      else unjudged = true;
    } finally { releaseHuntSlot(); }
  }));

  // The follows, in scan order, so which of several good sources the series takes is the order they were asked
  // in and not whichever answered first. Under followJudged's cap and lock: a hunt that followed one meanwhile
  // turns the next into `cap`.
  let capped = false, gone = false;
  for (const j of judged) {
    if (!j || j.why !== 'ok') continue;
    if (progress.length >= free || isStopped(a)) break;
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
        via: 'find_sources', runId: a.id,
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
  // Reintroduce by dropping this line: "each series says why it gained nothing" reads no_match for the series that
  // follows a source already.
  if (followers.size) return end('followed_already', asked);
  return end('no_match', asked);
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
}
export interface FindRun extends FindRunSummary {
  current?: { seriesId: string; title: string };
  /** What a running run waits on before its next series. */
  waiting?: 'sweep' | 'repair' | 'check';
  results: FindResult[];
}

type Row = {
  id: string; status: FindStatus; total: number; done: number; followed: number; username: string | null;
  started_at: Date; finished_at: Date | null; scope: { sourceId?: string } | null; results?: FindResult[];
};
const iso = (d: Date | string) => new Date(d).toISOString();
const scopeOf = (scope: { sourceId?: string } | null | undefined) =>
  (scope?.sourceId ? { sourceId: scope.sourceId, sourceName: getSource(scope.sourceId)?.name ?? scope.sourceId } : {});
const summaryOf = (r: Row): FindRunSummary => ({
  id: r.id, status: r.status, total: Number(r.total), done: Number(r.done), followed: Number(r.followed),
  startedBy: r.username, startedAt: iso(r.started_at), ...(r.finished_at ? { finishedAt: iso(r.finished_at) } : {}),
  ...scopeOf(r.scope),
});

/**
 * GET /api/admin/sources/find: whether a run is going, the running run or else the newest one in full, and the
 * kept runs as summaries, newest first. The running run is read from memory, which is ahead of its row.
 */
export async function findState(): Promise<{ running: boolean; run: FindRun | null; recent: FindRunSummary[] }> {
  await closeInterruptedFindRuns().catch(() => {});
  const rows = await q<Row>(
    `SELECT r.id, r.status, r.total, r.done, r.followed, u.username, r.started_at, r.finished_at, r.scope
       FROM source_find_runs r LEFT JOIN users u ON u.id::text = r.started_by
      ORDER BY r.started_at DESC LIMIT $1`, [FIND_KEEP]);
  const a = active;
  const recent = rows.map(summaryOf).map((r) => (a && r.id === a.id ? { ...r, done: a.done, followed: a.followed } : r));
  let run: FindRun | null = null;
  const lead = recent[0];
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
  return { running: !!a, run, recent };
}

// ---- test seams ---------------------------------------------------------------------------------------------

/** Tests: shorter pauses, wall and polling; pass nothing to put the defaults back. */
export function setFindTiming(t: { paceMs?: number; wallMs?: number; quietMs?: number } = {}): void {
  paceMs = t.paceMs ?? PACE_MS;
  wallMs = t.wallMs ?? FIND_SERIES_WALL_MS;
  quietMs = t.quietMs ?? FIND_QUIET_POLL_MS;
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
