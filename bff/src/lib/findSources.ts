// Find other sources: look for a series on the sources it does not read from, under every name it goes by, and
// hand an admin a REVIEW -- nothing is followed until a person confirms it. Above all for the series whose main
// source has stopped answering (Health's button on a failing source), for a Library selection, or for one series
// (the Sources & translations sheet). The idea, the review and the other names are @TIGamingTV's (PR #119).
//
// A run is a source_find_runs row, one source_find_items row per series and one source_find_candidates row per
// (series, source) it found (migrate.ts). It goes through three phases:
//
//   1. SEARCH, a paced background job on the server's own parts:
//      - which series: lib/findScope.ts (the selection, or every series whose MAIN source is the one named);
//      - never searched: a series numbered by posting order (#116, whose followers are never merged), one already
//        following MAX_FOLLOWERS sources, one listing under MIN_HAVE numbers -- each said so in the review;
//      - where to look: scanOrder over the sources the admin who started it may reach (their own age cap, as Discover
//        and the manual follow route read it -- NOT the hunt's sweepAllowedFor, which drops every extension that
//        flags itself adult for a series not rated 18+: most manhwa extensions do, and a search on a clean library
//        then had no source at all to ask; here a person confirms every follow, so the admin's reach is the rule),
//        without its main source, the ones it follows and the ones disabled or cooling down -- health read again for
//        every series -- at most FIND_MAX_SOURCES of them and FIND_MAX_SEARCHES searches in all, stopping once the
//        free follower slots are filled by candidates autoFollow would follow;
//      - how to look: the adapter's own search, under the hunt's shared slots (sourceHunt.ts takeHuntSlot), reporting
//        nothing -- a failed search never escalates a cooldown or marks a source failing -- and a source that fails
//        one search is not asked the next name;
//      - whether it is this series: autoFollow's judgeCandidate, with one opt-in (`descriptionNames`: a name in the
//        candidate's own description may equal one of ours, measured both ways). An `ok` verdict is a green
//        candidate; a `numbering_differs` one is kept, amber, only when a name matched EXACTLY;
//      - manners: one run at a time, PACE_MS between series that asked a source, waiting while a sweep, a repair or
//        the daily source check runs, stopping at a series boundary when stopped, cancelled or shut down. A stopped
//        or interrupted run keeps what it found and can be resumed from where it stopped.
//   2. REVIEW: the admin reads each series' candidates (their names, the chapter numbers both ways, the chapter
//      list itself), ticks green ones, searches by hand where the run found nothing (judged by the same rule).
//   3. FOLLOW: only green candidates are followed in bulk. An amber one is followed one at a time from its chapter
//      list, judged again first, and its audit line says it was an override. Every follow is INSERT-only, under the
//      series row's lock with its posting-order numbering re-read: a source the series follows already is
//      `already_followed` and is never re-pointed. Open candidates whose source was followed elsewhere since are
//      closed on every read. The listings of the series that gained a source are refreshed afterwards, PACE_MS
//      apart, and not at all while a sweep or a repair runs (the sweep reads every followed source anyway).
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { q, one, tx } from './db';
import { getSource, listSources } from './sources';
import type { SourceAdapter, SourceSeries } from './sources/types';
import { budgetFor } from './sources/budget';
import { healthAll, isDisabled, type SourceHealth } from './sourceHealth';
import { scanOrder } from './scanOrder';
import { chooseReleases, type ReleasePrefs } from './releases';
import { effectivePrefsFor, readSeriesPrefs } from './scanlatorPrefs';
import { assess, MIN_HAVE } from './fill';
import { bounded, judgeCandidate, MAX_FOLLOWERS, MIN_TRY_MS, type Judgement } from './autoFollow';
import { normTitle } from './titleMatch';
import { altTitlesFor, exactNameMatch, learnAltTitles, parseAltTitles, SEARCH_NAMES } from './altTitles';
import { takeHuntSlot, releaseHuntSlot } from './sourceHunt';
import { seriesByIds, seriesOfMainSource } from './findScope';
import { runtime } from './runtime';
import { checkRunning } from './sourceWatchdog';
import { beginRun, endRun, stopRequested, type RunCard } from './downloadJobs';
import { say } from './said';
import { updateSeries } from './updater';
import { PACE_MS } from './bulkNewest';
import { scheduleHealthSummaryRefresh } from './healthSummary';
import { logAudit } from './audit';
import { sourceAllowedFor, viewCtxFor, visibleToAll, type ViewCtx } from './visibility';

const knob = (name: string, def: number, min = 1) => Math.max(min, Number(process.env[name] || def));
/** Names searched per source: the title and up to SEARCH_NAMES others, the hunt's and the fill scan's cap. */
export const FIND_TERMS_MAX = 1 + SEARCH_NAMES;
/** Sources asked per series, in scan order. The hunt asks six; a person reviews these, so a few more. */
export const FIND_MAX_SOURCES = knob('FIND_MAX_SOURCES', 8);
/** Searches per series in all, across its sources and names. */
export const FIND_MAX_SEARCHES = knob('FIND_MAX_SEARCHES', 12);
/** Search hits judged per source: every exact-name hit first, then the source's own top hit. */
export const FIND_JUDGE_PER_SOURCE = 2;
/** Sources asked at once for one series, each under a hunt slot. Low on purpose: the job is paced, not fast. */
export const FIND_SEARCH_CONCURRENCY = 2;
/** One series' whole search-and-judge budget. What is not asked by then is simply not in the review. */
export const FIND_SERIES_WALL_MS = 120_000;
/** One search, before budgetFor raises it for a source behind the solver; capped by the wall. */
const FIND_SEARCH_MS = 20_000;
/** One judgement's two lookups, before budgetFor raises it; also the main source's description read. */
const FIND_LOOKUP_MS = 20_000;
/** How often a run waiting on a sweep, a repair or the daily check looks again. */
export const FIND_QUIET_POLL_MS = 5_000;
/** Finished runs kept (a run still waiting for its review is never pruned by count, only by age). */
export const FIND_KEEP = 20;
/** How long a finished run, and one left open, are kept (the import sweep's rule, routes/admin.ts). */
const SWEEP_DONE_DAYS = 7;
const SWEEP_OPEN_DAYS = 30;
/** How long a shutdown waits for the run to close its own row (server.ts). */
export const FIND_SHUTDOWN_MS = 3_000;

/**
 * running (searching, in this process), stopped (an admin's stop or the card's Cancel) and interrupted (a restart):
 * both resumable, what they found kept; review (the search is over, candidates wait); linking (following what was
 * confirmed); done (nothing left open); failed.
 */
export type FindStatus = 'running' | 'stopped' | 'interrupted' | 'review' | 'linking' | 'done' | 'failed';
export type FindVerdict = 'ok' | 'numbering_differs';
/** Why a series was not searched (source_find_items.note). */
export type FindNote = 'posting_order' | 'full' | 'too_few' | 'no_source';
export type FindScope = { seriesIds: string[] } | { sourceId: string };

/** What a series brings to the search: its names, what it lists, and what it already follows. */
export interface SeriesFacts {
  seriesId: string;
  /** The title as shown (the admin's override first); `names[0]`. */
  title: string;
  /** Every name searched and matched against, the shown title first, distinct by key. */
  names: string[];
  numbers: number[];
  primary: string | null;
  followers: string[];
  /** lib_series.numbering: `posting_order` refuses every follower (#116). */
  numbering: string | null;
}

/** A judgeCandidate verdict as a review row. */
export interface FoundCandidate {
  source: string;
  sourceSeriesId: string;
  theirTitle: string | null;
  cover: string | null;
  ourName: string | null;
  theirName: string | null;
  coverageFwd: number | null;
  coverageBack: number | null;
  verdict: FindVerdict;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const healthMap = async () => new Map((await healthAll().catch(() => [] as SourceHealth[])).map((h) => [h.source_id, h]));
/** Disabled by the admin, or in a cooldown right now. */
const resting = (h: SourceHealth | undefined, now: number) =>
  !!h && (h.disabled || (!!h.blocked_until && new Date(h.blocked_until).getTime() > now));

/** Distinct by normalised key, first spelling wins, empties dropped. */
function distinctNames(names: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const t = (raw ?? '').trim();
    const k = normTitle(t);
    if (!t || !k || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/**
 * Every chapter number the series has: what its sources list, and what is on disk (an admin's number override
 * first). ⚠️ A chapter with no number is left out in SQL: `Number(null)` is 0, and a phantom chapter 0 would count
 * against every candidate that starts at 1.
 */
export async function ourNumbers(seriesId: string): Promise<number[]> {
  const rows = await q<{ number: number }>(
    `SELECT number::float8 AS number FROM series_listing WHERE series_id = $1
     UNION
     SELECT n::float8 FROM (SELECT COALESCE(bo.number, b.number) AS n FROM lib_books b LEFT JOIN book_overrides bo ON bo.book_id = b.id
                             WHERE b.series_id = $1) x WHERE n IS NOT NULL`,
    [seriesId]).catch(() => []);
  return [...new Set(rows.map((r) => Number(r.number)).filter((n) => Number.isFinite(n)))];
}

/**
 * The series as the search sees it; null for one that is gone, hidden or merged away.
 *
 * Its other names are the stored ones (lib/altTitles.ts), and first the ones its own stored description lists: a
 * series added before v0.49.1 has none stored, and its summary is its main source's description, already on disk,
 * so reading it costs no request. Kept as `description` names -- a name an admin removed stays removed. Only when
 * that finds none is the main source itself asked for its description (`remote`), once, bounded, and never when
 * it is switched off, cooling down or already failed this run (`dead`): the main source being down is often why
 * the run was started.
 */
export async function factsFor(
  seriesId: string,
  opts: { remote?: boolean; health?: Map<string, SourceHealth>; dead?: Set<string> } = {},
): Promise<SeriesFacts | null> {
  const s = await one<{ title: string; shown: string; summary: string | null; source_id: string | null; source_series_id: string | null; numbering: string | null }>(
    `SELECT s.title, COALESCE(o.title, s.title) AS shown, COALESCE(o.summary, s.summary) AS summary,
            s.source_id, s.source_series_id, s.numbering
       FROM lib_series s LEFT JOIN series_overrides o ON o.series_id = s.id WHERE s.id = $1 AND ${visibleToAll('s')}`,
    [seriesId]).catch(() => null);
  if (!s) return null;
  if (s.numbering !== 'posting_order') {
    if (parseAltTitles(s.summary).length) await learnAltTitles(seriesId, s.summary);
    const primary = s.source_id ? getSource(s.source_id) : null;
    if (opts.remote && primary && s.source_series_id && !(await altTitlesFor(seriesId, 1)).length
        && !opts.dead?.has(primary.id) && !resting(opts.health?.get(primary.id), Date.now())) {
      try {
        const own = await bounded(primary.getSeries(s.source_series_id), budgetFor(primary, FIND_LOOKUP_MS));
        await learnAltTitles(seriesId, own?.summary);
      } catch { opts.dead?.add(primary.id); }
    }
  }
  const stored = await altTitlesFor(seriesId);
  const followers = (await q<{ source_id: string }>('SELECT source_id FROM series_sources WHERE series_id = $1', [seriesId]).catch(() => []))
    .map((r) => r.source_id).filter((id) => id !== s.source_id);
  return {
    seriesId,
    title: s.shown,
    names: distinctNames([s.shown, s.title, ...stored]),
    numbers: await ourNumbers(seriesId),
    primary: s.source_id,
    followers,
    numbering: s.numbering,
  };
}

/** How many more sources this series may follow. */
export const freeSlots = (f: Pick<SeriesFacts, 'followers'>) => Math.max(0, MAX_FOLLOWERS - f.followers.length);

/**
 * A judgeCandidate verdict as a review row, or null when it is not worth showing. `ok` is kept whatever matched --
 * it is what autoFollow itself would follow. `numbering_differs` is kept only when a name matched EXACTLY: a title
 * that merely contains ours with numbers that do not line up is what a sequel looks like, and showing it would only
 * invite the wrong book.
 */
export function toCandidate(
  j: Judgement,
  facts: Pick<SeriesFacts, 'names' | 'numbers'>,
  prefs: ReleasePrefs,
  cover: string | null = null,
): FoundCandidate | null {
  if (j.why !== 'ok' && j.why !== 'numbering_differs') return null;
  const match = exactNameMatch(facts.names, [j.theirTitle ?? '', ...(j.matchedVia ? [j.matchedVia] : [])]);
  if (j.why === 'numbering_differs' && !match) return null;
  const nums = chooseReleases(j.chapters ?? [], prefs).releases.map((c) => c.number);
  const measured = facts.numbers.length >= MIN_HAVE && nums.length > 0;
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    source: j.source, sourceSeriesId: j.sourceSeriesId, theirTitle: j.theirTitle, cover,
    ourName: match?.ours ?? null, theirName: match?.theirs ?? null,
    coverageFwd: measured ? round(assess(facts.numbers, nums).coverage) : null,
    coverageBack: measured ? round(assess(nums, facts.numbers).coverage) : null,
    verdict: j.why,
  };
}

/** Which hits of one source are worth judging: every exact-name hit, then the source's own top hit. */
export function hitsToJudge(items: SourceSeries[], names: string[], max = FIND_JUDGE_PER_SOURCE): SourceSeries[] {
  const keys = new Set(names.map((n) => normTitle(n)).filter(Boolean));
  const list = items.filter((r) => !!r.sourceId);
  const exact = list.filter((r) => keys.has(normTitle(r.title)));
  const rest = list.filter((r) => !exact.includes(r)).slice(0, 1);
  return [...exact, ...rest].slice(0, max);
}

/**
 * Which sources to ask for this series, in the order to ask them: scanOrder over every loaded source it may reach,
 * without the ones it already reads from and the ones switched off or cooling down right now, at most
 * FIND_MAX_SOURCES.
 */
export function sourcesToAsk(
  facts: Pick<SeriesFacts, 'primary' | 'followers'>,
  health: Map<string, SourceHealth>,
  allowed: (sourceId: string) => boolean = () => true,
  all: SourceAdapter[] = listSources(),
  now = Date.now(),
): string[] {
  const taken = new Set([...(facts.primary ? [facts.primary] : []), ...facts.followers]);
  const own = facts.primary ? getSource(facts.primary) : null;
  return scanOrder(all.filter((s) => allowed(s.id)), own ? { id: own.id, lang: own.lang } : null)
    .filter((id) => !taken.has(id) && !resting(health.get(id), now) && !!getSource(id))
    .slice(0, FIND_MAX_SOURCES);
}

/**
 * Look for this series on the sources it does not read from, and answer the best candidate per source. Stops as
 * soon as the series' free slots are filled with `ok` candidates, at the wall, at the search cap, or when `stop()`
 * says so. A source is asked a later name only while nothing it answered matched, and not at all once one of its
 * searches failed: a throw on one name is a throw on the next.
 */
export async function findCandidates(facts: SeriesFacts, opts: {
  wallMs?: number; health?: Map<string, SourceHealth>; sources?: SourceAdapter[]; stop?: () => boolean;
  /** Which sources may be asked: the starting admin's reach. Default: every source (an admin's, uncapped). */
  allowed?: (sourceId: string) => boolean;
} = {}): Promise<{ found: FoundCandidate[]; asked: number; unreachable: number; order: number }> {
  const free = freeSlots(facts);
  const none = { found: [], asked: 0, unreachable: 0, order: 0 };
  if (free <= 0 || facts.numbering === 'posting_order' || facts.numbers.length < MIN_HAVE) return none;
  const deadline = Date.now() + (opts.wallMs ?? wallMs);
  const health = opts.health ?? await healthMap();
  const allowed = opts.allowed ?? (() => true);
  const order = sourcesToAsk(facts, health, allowed, opts.sources);
  if (!order.length) {
    // Said in the server log, by count: "no other source could be asked" on every series is a setup to fix (every
    // source switched off, cooling down, beyond the admin's age cap, or none loaded), and the review cannot say which.
    const all = opts.sources ?? listSources();
    const taken = new Set([...(facts.primary ? [facts.primary] : []), ...facts.followers]);
    const now = Date.now();
    console.warn(`[find] ${facts.seriesId}: no source to ask -- ${all.length} loaded, ${all.filter((x) => taken.has(x.id)).length} its own, `
      + `${all.filter((x) => !taken.has(x.id) && resting(health.get(x.id), now)).length} switched off or cooling down, `
      + `${all.filter((x) => !taken.has(x.id) && !allowed(x.id)).length} beyond the age cap`);
    return none;
  }
  const prefs = await effectivePrefsFor(await readSeriesPrefs(facts.seriesId), 0);
  const primary = { title: facts.names[0] ?? facts.title, altTitles: facts.names.slice(1), numbers: facts.numbers };

  const best = new Map<string, FoundCandidate>();
  let ok = 0;
  let searches = 0;
  let asked = 0;
  let unreachable = 0;
  const left = () => deadline - Date.now();
  const done = () => ok >= free || left() < MIN_TRY_MS || searches >= FIND_MAX_SEARCHES || !!opts.stop?.();

  const askOne = async (id: string) => {
    const src = getSource(id);
    if (!src) return;
    await takeHuntSlot();
    try {
      if (done()) return;
      asked++;
      let answered = false;
      const judged = new Set<string>();
      for (const term of facts.names.slice(0, FIND_TERMS_MAX)) {
        if (done() || best.get(id)?.verdict === 'ok') break;
        searches++;
        const items = await bounded(src.search(term), Math.min(budgetFor(src, FIND_SEARCH_MS), left())).catch(() => null);
        if (!items) break;
        answered = true;
        for (const hit of hitsToJudge(items, facts.names)) {
          if (judged.has(hit.sourceId) || left() < MIN_TRY_MS || opts.stop?.()) continue;
          judged.add(hit.sourceId);
          const j = await bounded(
            judgeCandidate(primary, { source: id, sourceId: hit.sourceId }, { prefs, health, lookupMs: FIND_LOOKUP_MS, descriptionNames: true }),
            left(),
          ).catch(() => null);
          const c = j ? toCandidate(j, facts, prefs, hit.coverUrl ?? null) : null;
          if (!c) continue;
          const prev = best.get(id);
          if (!prev || (prev.verdict !== 'ok' && c.verdict === 'ok')) best.set(id, c);
          if (c.verdict === 'ok') { ok++; break; }
        }
      }
      if (!answered) unreachable++;
    } finally { releaseHuntSlot(); }
  };

  let next = 0;
  const worker = async () => {
    while (next < order.length && !done()) await askOne(order[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(FIND_SEARCH_CONCURRENCY, order.length) }, worker));
  return { found: [...best.values()], asked, unreachable, order: order.length };
}

// ---- following -------------------------------------------------------------------------------------------

export type FollowOutcome = 'inserted' | 'cap' | 'gone' | 'primary' | 'already_followed' | 'posting_order';

/**
 * Follow a confirmed candidate: one transaction, the series row locked, followJudged's shape (lib/autoFollow.ts)
 * with the admin as `added_by`. INSERT only: a source the series already follows is `already_followed` and is never
 * re-pointed -- a run stays open for weeks, and the series may have followed that source another way since,
 * possibly to a different entry. The posting-order numbering (#116) is re-read under the same lock, so a series
 * renumbered after the review refuses too.
 */
export async function followConfirmed(
  seriesId: string,
  c: { source: string; sourceSeriesId: string; theirTitle: string | null; coverage: number | null },
  userId: string,
): Promise<FollowOutcome> {
  return tx(async (qq) => {
    const row = (await qq<{ source_id: string | null; deleted_at: string | null; merged_into: string | null; numbering: string | null }>(
      'SELECT source_id, deleted_at, merged_into, numbering FROM lib_series WHERE id = $1 FOR UPDATE', [seriesId]))[0];
    if (!row || row.deleted_at || row.merged_into) return 'gone';
    if (row.numbering === 'posting_order') return 'posting_order';
    if (row.source_id === c.source) return 'primary';
    const had = await qq('SELECT 1 FROM series_sources WHERE series_id = $1 AND source_id = $2', [seriesId, c.source]);
    if (had.length) return 'already_followed';
    const r = await qq<{ source_id: string }>(
      `INSERT INTO series_sources (series_id, source_id, source_series_id, title, coverage, added_by)
       SELECT $1::text, $2::text, $3::text, $4::text, $5::real, $7::uuid
        WHERE (SELECT count(*) FROM series_sources WHERE series_id = $1 AND source_id IS DISTINCT FROM $8::text) < $6::int
       ON CONFLICT (series_id, source_id) DO NOTHING
       RETURNING source_id`,
      [seriesId, c.source, c.sourceSeriesId, c.theirTitle, c.coverage, MAX_FOLLOWERS, userId, row.source_id]);
    return r.length ? 'inserted' : 'cap';
  });
}

/**
 * Close the open candidates of a run that can no longer be followed: their source is now the series' main source or
 * followed already, or the series has since been numbered by posting order. Run on every read of the run and before
 * a follow, so a follow made anywhere else -- the Sources sheet, the hunt, another run -- is reflected here rather
 * than discovered by the follow.
 */
export async function closeStale(runId: string): Promise<void> {
  await q(
    `UPDATE source_find_candidates c
        SET status = CASE WHEN s.numbering = 'posting_order' THEN 'posting_order'
                          WHEN s.source_id = c.source THEN 'primary'
                          ELSE 'already_followed' END
       FROM source_find_items i JOIN lib_series s ON s.id = i.series_id
      WHERE c.item_id = i.id AND i.run_id = $1 AND c.status IS NULL
        AND (s.numbering = 'posting_order' OR s.source_id = c.source
             OR EXISTS (SELECT 1 FROM series_sources ss WHERE ss.series_id = i.series_id AND ss.source_id = c.source))`,
    [runId],
  );
}

// ---- runs ------------------------------------------------------------------------------------------------

export interface ItemRow {
  id: string; run_id: string; ord: number; series_id: string; title: string; names: string[];
  state: 'pending' | 'done' | 'skipped' | 'error'; note: FindNote | null; asked: number; unreachable: number;
}
export interface CandidateRow {
  id: string; item_id: string; source: string; source_series_id: string; their_title: string | null; cover: string | null;
  our_name: string | null; their_name: string | null; coverage_fwd: number | null; coverage_back: number | null;
  verdict: string; manual: boolean; status: string | null;
}

interface ActiveSearch {
  id: string;
  userId: string;
  card: RunCard;
  stop: boolean;
  current: { seriesId: string; title: string } | null;
  waiting: 'sweep' | 'repair' | 'check' | null;
  /** Settles the moment a stop is asked for, from anywhere: /stop, the card's Cancel, a shutdown. */
  stopped: Promise<void>;
  signal: () => void;
  /** Main sources whose description read failed in this run: not asked again for the next series. */
  dead: Set<string>;
  /** The starting admin's age cap: which sources the search may ask (sourceAllowedFor). Null: every source. */
  maxAgeRating: number | null;
}

let active: ActiveSearch | null = null;
/** Claimed synchronously by a start or a resume, before its first await: two POSTs in one turn cannot both search. */
let claimed: string | null = null;
const linking = new Set<string>();
let paceMs = PACE_MS;
let wallMs = FIND_SERIES_WALL_MS;
let quietMs = FIND_QUIET_POLL_MS;
let refresh: (seriesId: string) => Promise<unknown> = (id) => updateSeries(id, 0);
/** The search going now or last started in this process, for a caller that must wait for it (tests, shutdown). */
let lastRun: Promise<void> = Promise.resolve();

const isStopped = (a: ActiveSearch) => a.stop || runtime.stopping || stopRequested(a.card);
const nap = (a: ActiveSearch, ms: number) => Promise.race([new Promise<void>((r) => setTimeout(r, ms)), a.stopped]);

/** The run searching now, if any: its id. */
export const findRunning = (): string | null => active?.id ?? claimed;
export const isLinking = (id: string) => linking.has(id);

/**
 * Close every row that says it is working when this process is not: a `running` row is `interrupted` (resumable, what
 * it found kept), a `linking` row is settled. At boot (server.ts), and before every start and every read.
 */
export async function closeInterruptedFindRuns(): Promise<void> {
  await q(`UPDATE source_find_runs SET status = 'interrupted', finished_at = COALESCE(finished_at, now()), updated_at = now()
            WHERE status = 'running' AND id::text IS DISTINCT FROM $1`, [findRunning()]);
  const stranded = await q<{ id: string }>(`SELECT id FROM source_find_runs WHERE status = 'linking'`);
  for (const r of stranded) if (!linking.has(r.id)) await settleRun(r.id);
}

/** What a series is skipped for before any search, from what the database knows; null when it may be searched. */
function skipFor(r: { numbering: string | null; followers: number }): FindNote | null {
  if (r.numbering === 'posting_order') return 'posting_order';
  if (r.followers >= MAX_FOLLOWERS) return 'full';
  return null;
}

/**
 * Start a run. Answers `busy` (with the searching run's id) while another searches, `empty` when the scope names no
 * series this viewer may see, else the new run's id and how many series it holds -- with the search already going in
 * the background. A series numbered by posting order or already at the follower cap is in the run, skipped, so the
 * review says why it was not searched. `from` is the request's IP and user agent for the audit line.
 */
export async function startFind(
  scope: FindScope, userId: string, ctx: ViewCtx, from?: FastifyRequest,
): Promise<{ runId: string; total: number; skipped: number } | { busy: string } | { empty: true }> {
  const running = findRunning();
  if (running) return { busy: running };
  const id = randomUUID();
  claimed = id;
  try {
    const list = 'sourceId' in scope ? await seriesOfMainSource(scope.sourceId, ctx) : await seriesByIds(scope.seriesIds, ctx);
    if (!list.length) { claimed = null; return { empty: true }; }
    await closeInterruptedFindRuns();
    const ids = list.map((s) => s.id);
    const facts = new Map((await q<{ id: string; numbering: string | null; followers: number }>(
      `SELECT s.id, s.numbering,
              (SELECT count(*)::int FROM series_sources ss WHERE ss.series_id = s.id AND ss.source_id IS DISTINCT FROM s.source_id) AS followers
         FROM lib_series s WHERE s.id = ANY($1::text[])`, [ids])).map((r) => [r.id, r]));
    const notes = list.map((s) => { const f = facts.get(s.id); return f ? skipFor(f) : null; });
    const skipped = notes.filter(Boolean).length;
    const stored = 'sourceId' in scope ? { sourceId: scope.sourceId, seriesIds: ids } : { seriesIds: ids };
    await tx(async (qq) => {
      await qq(`INSERT INTO source_find_runs (id, started_by, status, scope, total, done) VALUES ($1, $2, 'running', $3::jsonb, $4, $5)`,
        [id, userId, JSON.stringify(stored), list.length, skipped]);
      await qq(
        `INSERT INTO source_find_items (run_id, ord, series_id, title, state, note)
         SELECT $1, o, s, t, CASE WHEN n IS NULL THEN 'pending' ELSE 'skipped' END, n
           FROM unnest($2::int[], $3::text[], $4::text[], $5::text[]) AS x(o, s, t, n)`,
        [id, list.map((_, i) => i), ids, list.map((s) => s.title), notes]);
    });
    // Finished runs beyond the newest FIND_KEEP go; one still waiting for its review is left to the daily sweep.
    await q(`DELETE FROM source_find_runs WHERE status IN ('done', 'failed') AND id NOT IN
               (SELECT id FROM source_find_runs ORDER BY started_at DESC LIMIT $1)`, [FIND_KEEP]).catch(() => {});
    launch(id, userId, list.length, skipped, ctx.maxAgeRating, from);
    return { runId: id, total: list.length, skipped };
  } catch (e) {
    claimed = null;
    throw e;
  }
}

/** Search on from where a stopped or interrupted run left off. */
export async function resumeFind(runId: string, userId: string, from?: FastifyRequest): Promise<'ok' | 'busy' | 'not_found' | 'not_resumable'> {
  const running = findRunning();
  if (running) return running === runId ? 'ok' : 'busy';
  if (linking.has(runId)) return 'busy';
  claimed = runId;
  try {
    await closeInterruptedFindRuns();
    const r = await one<{ total: number; done: number; pending: number }>(
      `SELECT total, done, (SELECT count(*)::int FROM source_find_items i WHERE i.run_id = r.id AND i.state = 'pending') AS pending
         FROM source_find_runs r WHERE r.id = $1 AND r.status NOT IN ('linking', 'running', 'failed')`, [runId]);
    if (!r) {
      claimed = null;
      return (await one('SELECT 1 FROM source_find_runs WHERE id = $1', [runId])) ? 'not_resumable' : 'not_found';
    }
    if (!r.pending) { claimed = null; return 'not_resumable'; }
    await q(`UPDATE source_find_runs SET status = 'running', finished_at = NULL, updated_at = now() WHERE id = $1`, [runId]);
    const ctx = await viewCtxFor(userId, 'admin');
    launch(runId, userId, Number(r.total), Number(r.total) - Number(r.pending), ctx.maxAgeRating, from);
    return 'ok';
  } catch (e) {
    claimed = null;
    throw e;
  }
}

function launch(id: string, userId: string, total: number, done: number, maxAgeRating: number | null, from?: FastifyRequest): void {
  const card = beginRun('find_sources', userId, total);
  // It searches; it follows nothing and downloads nothing, so it is a Server task that does not turn the Library ring.
  card.downloads = false;
  card.runId = id;
  card.done = done;
  card.found = 0;
  let signal!: () => void;
  const stopped = new Promise<void>((r) => { signal = r; });
  const a: ActiveSearch = { id, userId, card, stop: false, current: null, waiting: null, stopped, signal, dead: new Set(), maxAgeRating };
  active = a;
  claimed = null;
  lastRun = searchRun(a, from).catch((e) => console.warn(`[find] ${(e as Error)?.message || e}`));
}

/** Ask the searching run to stop at once: the series in flight stays unsearched, and the run can be resumed. */
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
 * on is the run's (GET /api/admin/sources/find) and its card's (GET /api/sources/jobs), so both say why it paused.
 */
async function waitQuiet(a: ActiveSearch): Promise<boolean> {
  for (;;) {
    if (isStopped(a)) return false;
    a.waiting = runtime.updating ? 'sweep' : runtime.repairing ? 'repair' : checkRunning() ? 'check' : null;
    if (a.waiting) a.card.waiting = a.waiting;
    else delete a.card.waiting;
    if (!a.waiting) return true;
    await nap(a, quietMs);
  }
}

const countFound = (runId: string) =>
  one<{ n: number }>(`SELECT count(DISTINCT i.id)::int AS n FROM source_find_items i JOIN source_find_candidates c ON c.item_id = i.id
                       WHERE i.run_id = $1`, [runId]).then((r) => Number(r?.n ?? 0)).catch(() => 0);

async function searchRun(a: ActiveSearch, from?: FastifyRequest): Promise<void> {
  let status: FindStatus = 'review';
  const watch = setInterval(() => { if (isStopped(a)) a.signal(); }, 250);
  a.card.found = await countFound(a.id);
  try {
    const items = await q<ItemRow>(`SELECT * FROM source_find_items WHERE run_id = $1 AND state = 'pending' ORDER BY ord`, [a.id]);
    for (let i = 0; i < items.length; i++) {
      if (!(await waitQuiet(a))) break;
      const item = items[i];
      a.current = { seriesId: item.series_id, title: item.title };
      a.card.current = { id: item.series_id, title: item.title };
      const work = searchOne(item, a).catch(async (e) => {
        console.warn(`[find] ${item.series_id}: ${(e as Error)?.message || e}`);
        await q(`UPDATE source_find_items SET state = 'error' WHERE id = $1`, [item.id]).catch(() => {});
        return { asked: 0, found: false };
      });
      // A stop does not wait for the searches in flight: the series stays pending, and nothing it finds is written.
      const out = await Promise.race([work, a.stopped.then(() => null)]);
      if (!out || isStopped(a)) break;
      await q(`UPDATE source_find_runs SET done = done + 1, updated_at = now() WHERE id = $1`, [a.id]).catch(() => {});
      a.card.done++;
      if (out.found) a.card.found = (a.card.found ?? 0) + 1;
      // Paced only after a series that asked a source: one decided from the database costs the sites nothing.
      if (out.asked && i < items.length - 1) await nap(a, paceMs);
    }
    if (isStopped(a)) status = runtime.stopping ? 'interrupted' : 'stopped';
  } catch (e) {
    status = 'failed';
    console.warn(`[find] the run failed: ${(e as Error)?.message || e}`);
  } finally {
    clearInterval(watch);
    a.current = null;
    a.waiting = null;
    delete a.card.waiting;
    if (status === 'review') {
      const open = await one('SELECT 1 FROM source_find_candidates c JOIN source_find_items i ON i.id = c.item_id WHERE i.run_id = $1 AND c.status IS NULL LIMIT 1', [a.id]).catch(() => null);
      if (!open) status = 'done';
    }
    await q(`UPDATE source_find_runs SET status = $2, finished_at = now(), updated_at = now() WHERE id = $1`, [a.id, status])
      .catch((e) => console.warn(`[find] could not close the run: ${(e as Error)?.message || e}`));
    endRun(a.card, status === 'failed' ? 'error' : 'done', status === 'failed' ? say('run.failed') : undefined);
    await logAudit('source.find', {
      userId: a.userId,
      detail: { runId: a.id, status, total: a.card.total, done: a.card.done, found: a.card.found ?? 0 },
      req: from,
    }).catch(() => {});
    if (active === a) active = null;
  }
}

/** One series: its facts, its skip reasons, its search, its candidates written. Null when a stop cut it short. */
async function searchOne(item: ItemRow, a: ActiveSearch): Promise<{ asked: number; found: boolean } | null> {
  const health = await healthMap();
  const facts = await factsFor(item.series_id, { remote: true, health, dead: a.dead });
  const skip = async (note: FindNote) => {
    await q(`UPDATE source_find_items SET state = 'skipped', note = $2, names = $3 WHERE id = $1`, [item.id, note, facts?.names ?? []]);
    return { asked: 0, found: false };
  };
  if (!facts) {
    await q(`UPDATE source_find_items SET state = 'error' WHERE id = $1`, [item.id]);
    return { asked: 0, found: false };
  }
  if (facts.numbering === 'posting_order') return skip('posting_order');
  if (freeSlots(facts) <= 0) return skip('full');
  if (facts.numbers.length < MIN_HAVE) return skip('too_few');
  const r = await findCandidates(facts, { health, stop: () => isStopped(a), allowed: (id) => sourceAllowedFor(getSource(id), a.maxAgeRating) });
  if (isStopped(a)) return null;
  if (!r.order) return skip('no_source');
  for (const c of r.found) await saveCandidate(item.id, c, false);
  await q(`UPDATE source_find_items SET state = 'done', names = $2, asked = $3, unreachable = $4 WHERE id = $1`,
    [item.id, facts.names, r.asked, r.unreachable]);
  return { asked: r.asked, found: r.found.length > 0 };
}

/** Write (or refresh) one candidate row. A manual pick stays manual when the search finds it again. */
export async function saveCandidate(itemId: string, c: FoundCandidate, manual: boolean): Promise<CandidateRow | null> {
  return one<CandidateRow>(
    `INSERT INTO source_find_candidates (item_id, source, source_series_id, their_title, cover, our_name, their_name,
                                         coverage_fwd, coverage_back, verdict, manual)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (item_id, source) DO UPDATE SET source_series_id = EXCLUDED.source_series_id, their_title = EXCLUDED.their_title,
       cover = COALESCE(EXCLUDED.cover, source_find_candidates.cover), our_name = EXCLUDED.our_name, their_name = EXCLUDED.their_name,
       coverage_fwd = EXCLUDED.coverage_fwd, coverage_back = EXCLUDED.coverage_back, verdict = EXCLUDED.verdict,
       manual = source_find_candidates.manual OR EXCLUDED.manual, status = NULL
     RETURNING *`,
    [itemId, c.source, c.sourceSeriesId, c.theirTitle, c.cover, c.ourName, c.theirName, c.coverageFwd, c.coverageBack, c.verdict, manual],
  );
}

export type PickError = 'gone' | 'posting_order' | 'full' | 'too_few' | 'already_followed' | 'unknown_source'
  | 'unavailable' | 'unreachable' | 'title_differs' | 'not_this_series';

/**
 * A candidate an admin picked by hand from the search sheet, judged by the same rule as a found one (judgeCandidate,
 * health read now) and saved as `manual`. Everything that would refuse the follow refuses the pick first, before any
 * lookup: a series numbered by posting order (`posting_order`), one with no free slot, its main source and the
 * sources it follows already.
 */
export async function judgeManualPick(
  seriesId: string,
  pick: { source: string; sourceSeriesId: string; cover?: string | null },
): Promise<{ error: PickError; theirTitle?: string | null } | FoundCandidate> {
  const facts = await factsFor(seriesId);
  if (!facts) return { error: 'gone' };
  if (facts.numbering === 'posting_order') return { error: 'posting_order' };
  if (pick.source === facts.primary || facts.followers.includes(pick.source)) return { error: 'already_followed' };
  if (!getSource(pick.source)) return { error: 'unknown_source' };
  if (freeSlots(facts) <= 0) return { error: 'full' };
  if (facts.numbers.length < MIN_HAVE) return { error: 'too_few' };
  const prefs = await effectivePrefsFor(await readSeriesPrefs(seriesId), 0);
  const j = await judgeCandidate(
    { title: facts.names[0] ?? facts.title, altTitles: facts.names.slice(1), numbers: facts.numbers },
    { source: pick.source, sourceId: pick.sourceSeriesId },
    { prefs, health: await healthMap(), lookupMs: FIND_LOOKUP_MS, descriptionNames: true },
  );
  if (j.why === 'unavailable' || j.why === 'posting_order') return { error: 'unavailable' };
  if (j.why === 'unreachable') return { error: 'unreachable' };
  if (j.why === 'too_few_listed') return { error: 'too_few' };
  if (j.why === 'title_differs') return { error: 'title_differs', theirTitle: j.theirTitle };
  return toCandidate(j, facts, prefs, pick.cover ?? null) ?? { error: 'not_this_series', theirTitle: j.theirTitle };
}

/** May a bulk follow take this candidate? Only what judgeCandidate would follow itself. Everything else is one at a time. */
export const mayFollow = (c: Pick<CandidateRow, 'verdict'>): boolean => c.verdict === 'ok';

/** The coverage a follow records: the lower of the two shares, as judgeCandidate reports it. */
const coverageOf = (c: Pick<CandidateRow, 'coverage_fwd' | 'coverage_back'>) =>
  c.coverage_fwd == null ? null : Math.min(c.coverage_fwd, c.coverage_back ?? c.coverage_fwd);

type RunCandidate = CandidateRow & { series_id: string; series_title: string };

const followAudit = (c: RunCandidate, userId: string, detail: Record<string, unknown>) =>
  logAudit('series.follow_source', {
    userId,
    detail: {
      id: c.series_id, title: c.series_title, source: c.source, sourceSeriesId: c.source_series_id, theirTitle: c.their_title,
      coverage: coverageOf(c), verdict: c.verdict, matchedVia: c.their_name, via: 'find_sources', ...detail,
    },
  }).catch(() => {});

/** Record one candidate's outcome on it and on its run's counts. */
async function recordOutcome(runId: string, candidateId: string, status: string, verdict?: string): Promise<void> {
  await q(`UPDATE source_find_candidates SET status = $2, verdict = COALESCE($3, verdict) WHERE id = $1`, [candidateId, status, verdict ?? null]).catch(() => {});
  await q(`UPDATE source_find_runs SET ${status === 'linked' ? 'followed = followed + 1' : 'failed = failed + 1'}, updated_at = now() WHERE id = $1`, [runId]).catch(() => {});
}

/**
 * Claim a run for following, atomically: never while it searches or is already following. The route's guard, as the
 * import's /run: a double tap finds `linking` and gets nothing.
 */
export async function claimFollow(runId: string): Promise<boolean> {
  if (findRunning() === runId || linking.has(runId)) return false;
  linking.add(runId);
  const r = await one(`UPDATE source_find_runs SET status = 'linking', updated_at = now()
                        WHERE id = $1 AND status NOT IN ('linking', 'running') RETURNING id`, [runId]).catch(() => null);
  if (!r) linking.delete(runId);
  return !!r;
}

/**
 * Follow the confirmed candidates of a run, one after another, in the background (the caller claimed it). Only `ok`
 * candidates are followed; this checks again. The series that gained a source go to the paced refresh once the run
 * is settled.
 */
export async function followCandidates(runId: string, rows: RunCandidate[], userId: string): Promise<void> {
  const gained = new Set<string>();
  try {
    for (const c of rows) {
      if (!mayFollow(c)) continue;
      let status: string;
      // Not installed, or switched off by the admin: the manual follow route refuses both, and so does this.
      if (!getSource(c.source) || await isDisabled(c.source).catch(() => false)) status = 'unavailable';
      else {
        try {
          const w = await followConfirmed(c.series_id, { source: c.source, sourceSeriesId: c.source_series_id, theirTitle: c.their_title, coverage: coverageOf(c) }, userId);
          status = w === 'inserted' ? 'linked' : w;
          if (w === 'inserted') {
            await followAudit(c, userId, { runId });
            gained.add(c.series_id);
          }
        } catch { status = 'error'; }
      }
      await recordOutcome(runId, c.id, status);
    }
  } finally {
    linking.delete(runId);
    await settleRun(runId).catch(() => {});
    queueRefresh(gained);
    if (gained.size) scheduleHealthSummaryRefresh();
  }
}

export type SingleOutcome = { ok: true } | { ok: false; error: string };

/**
 * Follow ONE candidate, from its chapter list, after a person has looked at it: the only way a `numbering_differs`
 * candidate is ever followed. The pair is judged again first (judgeCandidate, health now): the candidate may be weeks
 * old, and what a person confirms must still be a name match today. The audit says it was an override when it is not
 * `ok`.
 */
export async function followOne(candidateId: string, userId: string): Promise<SingleOutcome> {
  const c = await one<RunCandidate & { run_id: string; run_status: string }>(
    `SELECT c.*, i.series_id, i.title AS series_title, i.run_id, r.status AS run_status
       FROM source_find_candidates c JOIN source_find_items i ON i.id = c.item_id JOIN source_find_runs r ON r.id = i.run_id
      WHERE c.id = $1`, [candidateId]);
  if (!c) return { ok: false, error: 'not_found' };
  if (c.status) return { ok: false, error: 'closed' };
  if (findRunning() === c.run_id || linking.has(c.run_id) || c.run_status === 'linking') return { ok: false, error: 'busy' };
  const facts = await factsFor(c.series_id);
  if (!facts) return { ok: false, error: 'gone' };
  if (facts.numbering === 'posting_order') return { ok: false, error: 'posting_order' };
  if (!getSource(c.source) || await isDisabled(c.source).catch(() => false)) return { ok: false, error: 'unavailable' };
  const prefs = await effectivePrefsFor(await readSeriesPrefs(c.series_id), 0);
  const j = await judgeCandidate(
    { title: facts.names[0] ?? facts.title, altTitles: facts.names.slice(1), numbers: facts.numbers },
    { source: c.source, sourceId: c.source_series_id },
    { prefs, health: await healthMap(), lookupMs: FIND_LOOKUP_MS, descriptionNames: true },
  );
  if (j.why === 'unreachable') return { ok: false, error: 'unreachable' };
  if (j.why === 'unavailable') return { ok: false, error: 'unavailable' };
  const now = toCandidate(j, facts, prefs);
  if (!now) return { ok: false, error: 'changed' };
  const w = await followConfirmed(c.series_id, { source: c.source, sourceSeriesId: c.source_series_id, theirTitle: j.theirTitle, coverage: j.coverage }, userId);
  const status = w === 'inserted' ? 'linked' : w;
  await recordOutcome(c.run_id, c.id, status, now.verdict);
  await settleRun(c.run_id).catch(() => {});
  if (w !== 'inserted') return { ok: false, error: status };
  await followAudit({ ...c, their_title: j.theirTitle, verdict: now.verdict }, userId, { runId: c.run_id, preview: true, override: now.verdict !== 'ok' });
  queueRefresh([c.series_id]);
  scheduleHealthSummaryRefresh();
  return { ok: true };
}

/**
 * Put a run that is not searching back in the state its rows say: series still unsearched -> `stopped` (resumable),
 * candidates still open -> `review`, else `done`. After a follow, on every read, and at boot for a run a restart
 * stranded mid-follow. Leaves a run this process is following, or searching, alone.
 */
export async function settleRun(runId: string): Promise<void> {
  if (linking.has(runId) || findRunning() === runId) return;
  await q(
    `UPDATE source_find_runs r SET updated_at = now(), status = CASE
        WHEN EXISTS (SELECT 1 FROM source_find_items i WHERE i.run_id = r.id AND i.state = 'pending')
          THEN CASE WHEN r.status = 'interrupted' THEN 'interrupted' ELSE 'stopped' END
        WHEN EXISTS (SELECT 1 FROM source_find_candidates c JOIN source_find_items i ON i.id = c.item_id
                      WHERE i.run_id = r.id AND c.status IS NULL) THEN 'review'
        ELSE 'done' END
      WHERE r.id = $1 AND r.status IN ('linking', 'review', 'stopped', 'interrupted')`, [runId]);
}

/** Forget a run (the admin's Discard): stops its search first when it is the one searching. */
export async function discardFind(runId: string): Promise<boolean> {
  if (active?.id === runId) { stopFind(); await lastRun.catch(() => {}); }
  if (linking.has(runId)) return false;
  const gone = await q<{ id: string }>('DELETE FROM source_find_runs WHERE id = $1 RETURNING id', [runId]);
  return gone.length > 0;
}

// ---- the refreshes after a follow ---------------------------------------------------------------------------

/**
 * The listings to refresh after follows, one series at a time, PACE_MS apart: an unpaced burst of updateSeries
 * against one site is what earned an install its 75-minute cooldowns (bulkNewest's note). Dropped, not deferred,
 * while a sweep or a repair runs or on shutdown: the sweep reads every followed source anyway.
 */
const refreshQueue: string[] = [];
let refreshing: Promise<void> | null = null;
export function queueRefresh(ids: Iterable<string>): void {
  for (const id of ids) if (!refreshQueue.includes(id)) refreshQueue.push(id);
  if (refreshing || !refreshQueue.length) return;
  refreshing = (async () => {
    try {
      while (refreshQueue.length) {
        if (runtime.stopping || runtime.updating || runtime.repairing) { refreshQueue.length = 0; break; }
        const id = refreshQueue.shift()!;
        await refresh(id).catch((e) => console.warn(`[find] refresh of ${id} failed: ${(e as Error)?.message || e}`));
        if (refreshQueue.length) await sleep(paceMs);
      }
    } finally { refreshing = null; }
  })();
}

/** Drop runs nobody will come back to; daily from server.ts, on the import sweep's tick and rule. */
export async function sweepFindRuns(): Promise<{ removed: number }> {
  const rows = await q<{ id: string }>(
    `DELETE FROM source_find_runs
      WHERE id::text IS DISTINCT FROM $3
        AND ((status IN ('done', 'failed') AND updated_at < now() - make_interval(days => $1))
          OR (status IN ('review', 'stopped', 'interrupted') AND updated_at < now() - make_interval(days => $2)))
      RETURNING id`,
    [SWEEP_DONE_DAYS, SWEEP_OPEN_DAYS, findRunning()],
  );
  return { removed: rows.length };
}

// ---- reading it back ----------------------------------------------------------------------------------------

export interface FindRunSummary {
  id: string;
  status: FindStatus;
  total: number;
  /** Series settled: searched, or skipped before any search. */
  done: number;
  /** Series it found at least one candidate for. */
  found: number;
  /** Candidates still waiting for a decision. */
  open: number;
  followed: number;
  failed: number;
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
  /** What a searching run waits on before its next series. */
  waiting?: 'sweep' | 'repair' | 'check';
}

type Row = {
  id: string; status: FindStatus; total: number; done: number; followed: number; failed: number; found: number; open: number;
  username: string | null; started_at: Date; finished_at: Date | null; scope: { sourceId?: string } | null;
};
const iso = (d: Date | string) => new Date(d).toISOString();
const RUN_SQL = `SELECT r.id, r.status, r.total, r.done, r.followed, r.failed, u.username, r.started_at, r.finished_at, r.scope,
         (SELECT count(DISTINCT i.id)::int FROM source_find_items i JOIN source_find_candidates c ON c.item_id = i.id WHERE i.run_id = r.id) AS found,
         (SELECT count(*)::int FROM source_find_items i JOIN source_find_candidates c ON c.item_id = i.id
           WHERE i.run_id = r.id AND c.status IS NULL) AS open
    FROM source_find_runs r LEFT JOIN users u ON u.id::text = r.started_by`;

function summaryOf(r: Row): FindRun {
  const out: FindRun = {
    id: r.id, status: r.status, total: Number(r.total), done: Number(r.done), found: Number(r.found), open: Number(r.open),
    followed: Number(r.followed), failed: Number(r.failed), startedBy: r.username, startedAt: iso(r.started_at),
    ...(r.finished_at ? { finishedAt: iso(r.finished_at) } : {}),
    ...(r.scope?.sourceId ? { sourceId: r.scope.sourceId, sourceName: getSource(r.scope.sourceId)?.name ?? r.scope.sourceId } : {}),
  };
  const a = active;
  if (a && a.id === r.id) {
    out.done = a.card.done;
    if (a.current) out.current = { ...a.current };
    if (a.waiting) out.waiting = a.waiting;
  }
  return out;
}

/**
 * GET /api/admin/sources/find: whether a run is searching, the searching run or else the newest one, and the kept runs
 * as summaries, newest first.
 */
export async function findState(): Promise<{ running: boolean; run: FindRun | null; recent: FindRun[] }> {
  await closeInterruptedFindRuns().catch(() => {});
  const rows = await q<Row>(`${RUN_SQL} ORDER BY r.started_at DESC LIMIT $1`, [FIND_KEEP]);
  const recent = rows.map(summaryOf);
  const a = active;
  const run = (a && recent.find((r) => r.id === a.id)) || recent[0] || null;
  return { running: !!a, run, recent };
}

/** One run, settled first, with its series and their candidates (GET /api/admin/sources/find/:id). */
export async function findRun(runId: string): Promise<{ run: FindRun; items: ItemRow[]; candidates: CandidateRow[] } | null> {
  await closeInterruptedFindRuns().catch(() => {});
  if (!linking.has(runId)) {
    await closeStale(runId).catch(() => {});
    await settleRun(runId).catch(() => {});
  }
  const row = await one<Row>(`${RUN_SQL} WHERE r.id = $1`, [runId]);
  if (!row) return null;
  const items = await q<ItemRow>('SELECT * FROM source_find_items WHERE run_id = $1 ORDER BY ord', [runId]);
  const candidates = await q<CandidateRow>(
    `SELECT c.* FROM source_find_candidates c JOIN source_find_items i ON i.id = c.item_id WHERE i.run_id = $1
      ORDER BY c.verdict = 'ok' DESC, c.coverage_fwd DESC NULLS LAST, c.source`, [runId]);
  return { run: summaryOf(row), items, candidates };
}

// ---- test seams ---------------------------------------------------------------------------------------------

/** Tests: shorter pauses, wall and polling, and a stand-in for the listing refresh; nothing puts the defaults back. */
export function setFindTiming(t: { paceMs?: number; wallMs?: number; quietMs?: number; refresh?: (id: string) => Promise<unknown> } = {}): void {
  paceMs = t.paceMs ?? PACE_MS;
  wallMs = t.wallMs ?? FIND_SERIES_WALL_MS;
  quietMs = t.quietMs ?? FIND_QUIET_POLL_MS;
  refresh = t.refresh ?? ((id) => updateSeries(id, 0));
}
/** Tests: the search in flight (or the last one) and the refresh queue behind it, settled. */
export async function findSettled(): Promise<void> {
  await lastRun.catch(() => {});
  await refreshing?.catch(() => {});
}
/** Tests: the refreshes still queued. */
export const pendingRefreshes = () => [...refreshQueue];
/** Tests: the in-memory guards are process-global. */
export function _resetFindState(): void {
  active = null;
  claimed = null;
  linking.clear();
  refreshQueue.length = 0;
}

/**
 * A shutdown (server.ts, once runtime.stopping is set): wait for the searching run to close its own row --
 * `interrupted`, resumable -- but never longer than `ms`; what it does not finish, the next boot's
 * closeInterruptedFindRuns does.
 */
export async function findSettledWithin(ms = FIND_SHUTDOWN_MS): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([lastRun.catch(() => {}), new Promise<void>((r) => { timer = setTimeout(r, ms); })]);
  clearTimeout(timer);
}
