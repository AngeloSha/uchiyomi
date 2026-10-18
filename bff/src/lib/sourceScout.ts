// The scout (v0.80.0): finding another source for a series its own sources cannot get its chapters from.
//
// The owner's ask (2026-10-17): when a site rate-limits, blocks or stalls, look for the series on the other installed
// sources and carry on from one of them -- and from the next when that one limits too -- for series added from
// Discover, "Find missing chapters" and the scheduled checks alike, until every chapter is downloaded. v0.79.0 made a
// series use the sources it already follows while one cools down; this finds new ones. One series at a time, in the
// background (server.ts, every SCOUT_TICK_MS):
//
//   1. Which series. The ones put forward where they got stuck (lib/scoutRequests.ts), most pressing first. With none
//      waiting, a behind series none of whose sources can be asked now, and once an hour a series whose every source
//      is broken. Each series has its own backoff (`series_scout.next_at`), so none is looked at over and over.
//   2. Whether it needs one. Its wanted chapters -- listed, not here, at or above its floor -- that no source it follows
//      can serve now: every copy is on a source that is cooling, failing or switched off, or the chapter is at its retry
//      cap. None, and nothing is searched.
//   3. Where to look. Every installed source the series may use (its language, the 18+ rule) that it does not follow,
//      that is not on the image server of one it follows (a site's twin cools with it: Mangakakalot cannot rescue
//      Natomanga), that has not said "not this series" lately (lib/scoutMemory.ts), and that can be asked now: a source
//      that is cooling, or behind the solver while the solver is queueing, waits for the next look. Ranked: sources it
//      already knows are this series, then sources that downloaded well here this week, then the rest; within each,
//      the series' language first, then the image servers with the least already waiting on them -- which is where the
//      other series downloading from the same sites count.
//   4. Judging. The add's own rule (lib/autoFollow.ts judgeCandidate: the title, the language, the numbering), and it
//      must list a chapter the series is waiting for, or one newer than any the series lists.
//   5. Following. The first that passes is followed -- never made the main source: the owner's call -- its capped
//      chapters get their tries back, and the series goes to the front of the finishing sweep (lib/finishDownloads.ts),
//      which takes the chapters from wherever they can come now.
//
// Bounded on every axis: one scout at a time; SCOUT_MAX_SOURCES sources, SCOUT_MAX_SEARCHES searches and SCOUT_WALL_MS
// per scout; SCOUT_SEARCHES_PER_HOUR searches an hour in all (0 turns the scout off); the follower limit
// (lib/followLimit.ts, where a follower that cannot carry the series is not counted); the hunt's shared search slots;
// and the admin switch "Use other sources on their own" (server_settings.auto_follow_on_failure).
import { q, one } from './db';
import { getSource, listSources, SW_PREFIX } from './sources';
import { healthAll } from './sourceHealth';
import { scanOrder, scanRank, type Orderable } from './scanOrder';
import { judgeCandidate, bounded, MAX_FOLLOWERS, MIN_TRY_MS, type Judgement, type PrimaryFacts } from './autoFollow';
import { searchByNames, takeHuntSlot, releaseHuntSlot, seriesIsAdult, sweepAllowedFor, followHunted, rememberJudgement } from './sourceHunt';
import { standingsOf, carries, type Standing } from './sourceStanding';
import { rateKeyOf } from './pace';
import { chooseReleases, type ReleasePrefs } from './releases';
import { effectivePrefsFor, readSeriesPrefs } from './scanlatorPrefs';
import { altTitlesFor, SEARCH_NAMES } from './altTitles';
import { followGuard, seriesLanguage } from './seriesLang';
import { MIN_HAVE } from './fill';
import { visibleToAll } from './visibility';
import { verdictsFor, verdictHolds, verdictExpires, recordVerdict } from './scoutMemory';
import { solverQueueing } from './sources/flaresolverr';
import { engineState } from './sources/suwayomi/engineState';
import { runtime } from './runtime';
import { findRunning } from './findSources';
import { CHAPTER_RETRY_CAP, seriesIsMonitored } from './updater';
import { finishDownloadsOn, retryCapFor, backFirst } from './finishDownloads';
import type { ScoutReason } from './scoutRequests';
import {
  backupsAllowed, stuckLongEnough, parkedLinksFor, dropLink, makeRoom, installTrial, settleTrial, parkingNow,
  backupRows, backupLimits, trialAllowed, recordMiss, missedRecently,
} from './backupExtensions';
import { BUSY, installLockHolder } from './sources/suwayomi/installLock';
import { listExtensions, extensionFacts, type ExtensionInfo } from './sources/suwayomi/extensions';
import { getHiddenLangs } from './sources/suwayomi/langs';
import { downloadsPerDay, groupsOf, pkgFits, rankPackages } from './extensionRank';
import { normGroup } from './releases';

const envInt = (name: string, fallback: number, min: number, max: number): number => {
  const raw = process.env[name];
  const n = raw === undefined || raw === '' ? NaN : Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** How often the worker looks for a series to scout (server.ts). One scout per look at most. */
export const SCOUT_TICK_MS = 3 * MIN;

/**
 * The scout's limits. `perHour` is SCOUT_SEARCHES_PER_HOUR (default 40, 0 turns the scout off): search requests in any
 * hour, across every scout. The rest bound one scout. Tests narrow them (_setScoutLimits).
 */
const limits = {
  perHour: envInt('SCOUT_SEARCHES_PER_HOUR', 40, 0, 1000),
  maxSources: 12,
  maxSearches: 16,
  wallMs: 180_000,
};
export const SCOUT_SEARCHES_PER_HOUR = limits.perHour;
export const SCOUT_MAX_SOURCES = limits.maxSources;
export const SCOUT_MAX_SEARCHES = limits.maxSearches;
export const SCOUT_WALL_MS = limits.wallMs;
/** What one search gets before budgetFor raises it for a source behind the solver: the hunt's. */
const SEARCH_MS = 20_000;
/** A source searched by any scout this recently goes last: one site is not searched twice in a row. */
const SEARCHED_LATELY_MS = MIN;

/** When a series is looked at again, by what its last look found. */
export const SCOUT_BACKOFF = {
  /** It followed a source: the chapters now come from it; look again only if it gets stuck again later. */
  followed: 6 * HOUR,
  /** Its followers fill the limit, every one able to carry it. */
  cap: 24 * HOUR,
  /** Every source left to ask was cooling, or behind a busy solver. */
  deferred: 15 * MIN,
  /** It stopped with sources still to ask (the time, the searches): 1, 2, 4, then 8 hours. */
  left: [1, 2, 4, 8].map((h) => h * HOUR),
  /** Every source answered and none will do: when the first of their answers runs out, between these two. */
  exhaustedMin: HOUR,
  exhaustedMax: 3 * DAY,
  /** Too little listed to judge any source against. */
  tooFew: 3 * DAY,
} as const;

// The searches of the last hour, across scouts, and when each source was last searched. In memory: a restart may allow
// one more hour's worth, which is the same bound the hunt keeps.
const searchedAt: number[] = [];
const lastSearched = new Map<string, number>();
let scouting = false;
let lastFrozenLook = 0;

/** Search requests the scouts may still make this hour. */
export function scoutSearchesLeft(now = Date.now()): number {
  while (searchedAt.length && now - searchedAt[0] >= HOUR) searchedAt.shift();
  return Math.max(0, limits.perHour - searchedAt.length);
}

/** Tests only. */
export function _resetScout(): void {
  searchedAt.length = 0;
  lastSearched.clear();
  scouting = false;
  lastFrozenLook = 0;
}
/** Tests only: narrow the limits (restored by passing the defaults back). */
export function _setScoutLimits(next: Partial<typeof limits>): void { Object.assign(limits, next); }
export const _scoutLimits = (): Readonly<typeof limits> => ({ ...limits });

/** One source the scout may ask, with what decides its turn. */
export interface ScoutCandidate extends Orderable {
  /** Known to be this series: a remembered `ok` (asked again without a search) or a seed its request named. */
  known: boolean;
  /** Chapters downloaded from it this week, and downloads from it that failed (download_log). */
  landed: number;
  failed: number;
  /** The image server it downloads under (pace.ts rateKeyOf). */
  key: string;
  /** Searched by a scout within the last minute. */
  searchedLately?: boolean;
}

/** A candidate's tier, best first: 0 known, 1 downloading well here, 2 the rest, 3 mostly failing here lately. Pure. */
export function scoutTier(c: Pick<ScoutCandidate, 'known' | 'landed' | 'failed'>): number {
  if (c.known) return 0;
  const n = c.landed + c.failed;
  if (c.landed > 0 && c.failed * 2 < n) return 1;
  if (n > 0 && c.failed * 2 >= n) return 3;
  return 2;
}

/**
 * The order the scout asks candidates in. Pure. A source searched within the last minute goes last; then by tier; then
 * the series' language first (scanRank); then the image server with the smallest backlog waiting on it (`backlog`, by
 * rate key: the chapters behind series are waiting for there); then the scan order (scanOrder.ts: preferred order, as
 * listed). Reintroduce by sorting on scan order alone: "known sources first, then the ones downloading well" in
 * scoutOrder.test.ts reads the other order.
 */
export function scoutOrder(
  cands: readonly ScoutCandidate[],
  own: { id: string; lang?: string | null },
  backlog: ReadonlyMap<string, number> = new Map(),
): string[] {
  const scan = new Map(scanOrder([...cands], own).map((id, i) => [id, i]));
  return [...cands].sort((a, b) =>
    Number(!!a.searchedLately) - Number(!!b.searchedLately)
    || scoutTier(a) - scoutTier(b)
    || scanRank(a, own) - scanRank(b, own)
    || (backlog.get(a.key) ?? 0) - (backlog.get(b.key) ?? 0)
    || (scan.get(a.id) ?? 0) - (scan.get(b.id) ?? 0),
  ).map((c) => c.id);
}

/** What the series is waiting for, from its listing and its failures ledger. */
interface Need {
  /** Wanted numbers no source it follows can serve now. */
  numbers: Set<number>;
  /** Of those, the ones at their retry cap. */
  capped: number[];
  /** Every number its listing holds: what a candidate's numbering is measured against. */
  listed: number[];
  /** The highest number it lists or holds. */
  top: number;
  /** Every source it follows is broken (none can carry it, and not because an admin switched them all off). */
  frozen: boolean;
}

async function needOf(
  seriesId: string, floor: number | null, mine: readonly string[], standing: ReadonlyMap<string, Standing>, asked: readonly number[],
): Promise<Need> {
  const finish = await finishDownloadsOn();
  const rows = await q<{ number: number; status: string; copies: Array<{ source?: string }> | null }>(
    'SELECT number::float8 AS number, status, copies FROM series_listing WHERE series_id = $1', [seriesId]);
  const fails = new Map((await q<{ number: number; status: string; attempts: number }>(
    'SELECT number::float8 AS number, status, attempts FROM chapter_failures WHERE series_id = $1', [seriesId]))
    .map((r) => [Number(r.number), r]));
  const held = await one<{ top: number | null; whole: number[] | null }>(
    `SELECT max(number)::float8 AS top,
            array_agg(number::float8) FILTER (WHERE number IS NOT NULL AND (missing_pages IS NULL OR cardinality(missing_pages) = 0)) AS whole
       FROM lib_books WHERE series_id = $1 AND number IS NOT NULL`, [seriesId]).catch(() => null);
  const numbers = new Set<number>();
  const capped: number[] = [];
  const listed: number[] = [];
  let top = Number(held?.top ?? -Infinity);
  for (const r of rows) {
    const n = Number(r.number);
    if (!Number.isFinite(n)) continue;
    listed.push(n);
    if (n > top) top = n;
    if (r.status !== 'available' || (floor != null && n < floor)) continue;
    const f = fails.get(n);
    if (f && Number(f.attempts) >= retryCapFor(f.status, finish, CHAPTER_RETRY_CAP)) { capped.push(n); numbers.add(n); continue; }
    if (!(r.copies ?? []).some((c) => !!c.source && standing.get(c.source) === 'usable')) numbers.add(n);
  }
  // What the request named (a chapter saved with pages missing, a fill's numbers): wanted whatever the listing says,
  // until a whole copy of it is here. Reintroduce by keeping them all: "a chapter that came whole since it was asked
  // for is not looked for" in sourceScout.int.test.ts searches.
  const whole = new Set((held?.whole ?? []).map(Number));
  for (const n of asked) if (Number.isFinite(n) && !whole.has(n)) numbers.add(n);
  const frozen = mine.length > 0 && mine.every((id) => !carries(standing.get(id) ?? 'usable'))
    && !mine.every((id) => standing.get(id) === 'off');
  return { numbers, capped, listed: [...new Set(listed)], top, frozen };
}

/** The numbers a judged candidate would bring: ones the series waits for, or newer than any it lists. */
function bringsOf(j: Judgement, prefs: ReleasePrefs, need: Need): number[] {
  const theirs = chooseReleases(j.chapters ?? [], prefs).releases.map((c) => Number(c.number)).filter((n) => Number.isFinite(n));
  return [...new Set(theirs.filter((n) => need.numbers.has(n) || n > need.top))].sort((a, b) => a - b);
}

/** Chapters landed and failed per source this week (download_log keeps a week). */
async function recentRecord(): Promise<Map<string, { landed: number; failed: number }>> {
  const rows = await q<{ source: string; landed: number; failed: number }>(
    `SELECT source, count(*) FILTER (WHERE status IN ('done', 'partial'))::int AS landed, count(*) FILTER (WHERE status = 'failed')::int AS failed
       FROM download_log WHERE finished_at > now() - interval '7 days' GROUP BY source`).catch(() => []);
  return new Map(rows.map((r) => [r.source, { landed: Number(r.landed), failed: Number(r.failed) }]));
}

/** Chapters behind series are waiting for, per image server: what each candidate's site already has queued. */
async function backlogByKey(): Promise<Map<string, number>> {
  const rows = await q<{ src: string; m: number }>(
    `SELECT src, sum(m)::int AS m FROM (
       SELECT s.source_id AS src, COALESCE(s.finish_missing, s.source_missing, 0) AS m FROM lib_series s
        WHERE s.auto_update AND ${visibleToAll('s')} AND s.source_id IS NOT NULL AND COALESCE(s.finish_missing, s.source_missing, 0) > 0
       UNION ALL
       SELECT ss.source_id, COALESCE(s.finish_missing, s.source_missing, 0) FROM series_sources ss JOIN lib_series s ON s.id = ss.series_id
        WHERE s.auto_update AND ${visibleToAll('s')} AND COALESCE(s.finish_missing, s.source_missing, 0) > 0
     ) x GROUP BY src`).catch(() => []);
  const out = new Map<string, number>();
  for (const r of rows) {
    const k = rateKeyOf(r.src);
    out.set(k, (out.get(k) ?? 0) + Number(r.m));
  }
  return out;
}

export type ScoutVerdictKind =
  | 'followed' | 'cap' | 'deferred' | 'left' | 'exhausted' | 'too_few'
  /** Nothing to look for: caught up, unmonitored, gone, or numbered by posting order. The request is dropped. */
  | 'not_needed';

/** What one scout did. */
export interface ScoutOutcome {
  verdict: ScoutVerdictKind;
  title: string;
  /**
   * The source it followed, and how many chapters it lists that the series was waiting for. `backup`: the package of a
   * backup extension put back for it (v0.82.0, lib/backupExtensions.ts).
   */
  followed?: { source: string; sourceSeriesId: string; brings: number; backup?: string };
  /** Search requests made, and the sources asked (searched, or judged from memory), in order. */
  searches: number;
  asked: string[];
  /** When the series may be looked at again; null drops its request. */
  nextAt: Date | null;
}

/** What a request carries into a scout. */
export interface ScoutAsk {
  numbers?: readonly number[];
  seeds?: readonly string[];
  /** Looks in a row that found nothing to follow: the `left` backoff grows with it. */
  fruitless?: number;
  /**
   * v0.83.0: ask this one source alone -- a repository extension being tried (storeLook) -- and put no backup back
   * first.
   */
  only?: string;
}

/** Look for another source for one series, and follow it when one will do. Never throws for a source's sake. */
export async function runScout(seriesId: string, ask: ScoutAsk = {}): Promise<ScoutOutcome> {
  const deadline = Date.now() + limits.wallMs;
  let searches = 0;
  const asked: string[] = [];
  let title = '';
  const done = (verdict: ScoutVerdictKind, waitMs: number | null, extra: Partial<ScoutOutcome> = {}): ScoutOutcome =>
    ({ verdict, title, searches, asked, nextAt: waitMs === null ? null : new Date(Date.now() + waitMs), ...extra });

  const s = await one<{ id: string; title: string; source_id: string | null; numbering: string | null; auto_update: boolean; chapter_floor: string | null }>(
    `SELECT id, title, source_id, numbering, auto_update, chapter_floor FROM lib_series s WHERE s.id = $1 AND ${visibleToAll('s')}`,
    [seriesId]).catch(() => null);
  if (!s || s.auto_update === false || s.numbering === 'posting_order') return done('not_needed', null);
  title = s.title;
  const followers = (await q<{ source_id: string }>('SELECT source_id FROM series_sources WHERE series_id = $1', [seriesId]))
    .map((r) => r.source_id).filter((id) => id !== s.source_id);
  const mine = [...new Set([...(s.source_id ? [s.source_id] : []), ...followers])];
  const standing = await standingsOf(mine);
  // The follower limit counts only followers that can carry the series (lib/sourceStanding.ts): a broken one is kept,
  // and not counted. Reintroduce by counting them all: "a broken follower does not hold the series at its limit"
  // in sourceScout.int.test.ts reads cap.
  if (followers.filter((id) => carries(standing.get(id) ?? 'usable')).length >= MAX_FOLLOWERS) return done('cap', SCOUT_BACKOFF.cap);

  const floor = s.chapter_floor != null && s.chapter_floor !== '' ? Number(s.chapter_floor) : null;
  const need = await needOf(seriesId, Number.isFinite(floor as number) ? floor : null, mine, standing, ask.numbers ?? []);
  // Reintroduce by scouting every behind series: "a series its own sources can serve is not scouted" in
  // sourceScout.int.test.ts finds a search.
  if (!need.numbers.size && !need.frozen) return done('not_needed', null);
  if (need.listed.length < MIN_HAVE) return done('too_few', SCOUT_BACKOFF.tooFew);
  const ourCount = need.listed.length;

  // Who may be asked.
  const allowed = await sweepAllowedFor(await seriesIsAdult(seriesId));
  const fits = await followGuard(seriesId, { mixed: false });
  const lang = await seriesLanguage(seriesId);
  const memory = await verdictsFor(seriesId);
  // A source on the image server of one the series follows shares its cooldowns and its blocks. Reintroduce by
  // dropping the rule: "a source on a followed source's image server is not asked" in sourceScout.int.test.ts searches it.
  const taken = new Set(mine.map(rateKeyOf));
  // A backup extension being removed right now is nobody's to follow (v0.82.0, lib/backupExtensions.ts parkingNow).
  const pool = listSources().filter((src) => !mine.includes(src.id) && allowed(src.id) && fits(src.id) && !taken.has(rateKeyOf(src.id))
    && !(src.backup && parkingNow()) && (!ask.only || src.id === ask.only));
  const poolStanding = await standingsOf(pool.map((p) => p.id));
  const record = await recentRecord();
  const seeds = new Set(ask.seeds ?? []);
  const knownIds = new Map<string, string>();
  const cands: ScoutCandidate[] = [];
  let deferred = 0;
  for (const src of pool) {
    const v = memory.get(src.id);
    const holds = !!v && verdictHolds(v, ourCount);
    // It said "not this series" lately, or an admin unfollowed it from this one. Reintroduce by asking anyway: "a
    // source that said no is not asked again" in sourceScout.int.test.ts counts its search.
    if (v && holds && v.verdict !== 'ok') continue;
    const st = poolStanding.get(src.id) ?? 'usable';
    if (st === 'off' || st === 'not_loaded' || st === 'failing') continue;
    // Not now, and nothing is said about it: the next look asks it.
    if (st === 'cooling' || (src.requiresCloudflare && solverQueueing()) || (src.id.startsWith('sw:') && engineState() !== 'up')) {
      deferred++;
      continue;
    }
    if (v?.verdict === 'ok' && holds && v.source_series_id) knownIds.set(src.id, v.source_series_id);
    const r = record.get(src.id) ?? { landed: 0, failed: 0 };
    cands.push({
      id: src.id, lang: src.lang ?? null, preferredOrder: src.preferredOrder ?? null,
      known: knownIds.has(src.id) || seeds.has(src.id), landed: r.landed, failed: r.failed, key: rateKeyOf(src.id),
      searchedLately: Date.now() - (lastSearched.get(src.id) ?? 0) < SEARCHED_LATELY_MS,
    });
  }
  const order = scoutOrder(cands, { id: s.source_id ?? '', lang: lang.lang }, await backlogByKey()).slice(0, limits.maxSources);

  const names = await altTitlesFor(seriesId, SEARCH_NAMES);
  const prefs = await effectivePrefsFor(await readSeriesPrefs(seriesId), 0);
  const health = new Map((await healthAll().catch(() => [])).map((h) => [h.source_id, h]));
  const primary: PrimaryFacts = { title: s.title, altTitles: names, numbers: need.listed, lang: lang.lang, exactLang: lang.sameBaseSibling };
  const admit = () => seriesIsMonitored(seriesId);
  let left = order.length < cands.length;
  /** The look ran out of time or searches before the installed sources' turn. */
  let cut = false;

  /**
   * Ask one source for the series: by the id it is known under there (`known`), else searched for under every name it
   * goes by (and `more`). What came of it: followed (the outcome to return), the follower limit (`cap`), nothing to do
   * any more (`not_needed`), out of time or searches (`left`), not now (`deferred`), not this series (`no`), or a known
   * id that no longer is (`stale`).
   */
  type Asked = { followed: ScoutOutcome } | 'cap' | 'not_needed' | 'left' | 'deferred' | 'no' | 'stale';
  const askOne = async (id: string, known: string | null, more: readonly string[] = []): Promise<Asked> => {
    if (runtime.stopping || deadline - Date.now() < MIN_TRY_MS) return 'left';
    if (!(await admit().catch(() => false))) return 'not_needed';
    const src = getSource(id);
    if (!src) return 'no';
    let ref = known;
    if (!ref) {
      if (searches >= limits.maxSearches || scoutSearchesLeft() <= 0) return 'left';
      // Every search is counted against this scout and the hour before it is made; one past either is not made.
      let outOfSearches = false;
      const counted = {
        requiresCloudflare: src.requiresCloudflare,
        search: async (term: string) => {
          if (searches >= limits.maxSearches || scoutSearchesLeft() <= 0) { outOfSearches = true; throw new Error('scout: out of searches'); }
          searches++;
          searchedAt.push(Date.now());
          lastSearched.set(id, Date.now());
          return src.search(term);
        },
      };
      await takeHuntSlot();
      let found: Awaited<ReturnType<typeof searchByNames>>;
      try {
        found = await searchByNames(counted, s.title, [...names, ...more.filter((m) => !names.includes(m))], () => deadline - Date.now(), SEARCH_MS, admit);
      } finally {
        releaseHuntSlot();
      }
      if (found.paused) return 'not_needed';
      asked.push(id);
      if (outOfSearches && !found.hit) return 'left';
      if (!found.hit?.sourceId) {
        // Answered and not there; or never answered at all. Searched under every name either way.
        await recordVerdict(seriesId, id, found.answered ? 'no_hit' : 'unreachable', { ourCount });
        return 'no';
      }
      ref = found.hit.sourceId;
    } else {
      asked.push(id);
    }
    const room = deadline - Date.now();
    if (room < MIN_TRY_MS) return 'left';
    const j = await bounded(judgeCandidate(primary, { source: id, sourceId: ref }, { prefs, health, admit }), room).catch(() => null);
    // The wall cut it short: nothing is known about the source, and it is asked next time.
    if (!j) return 'left';
    if (j.why === 'unavailable') return 'deferred';
    await rememberJudgement(seriesId, j, ourCount);
    if (j.why !== 'ok') return known ? 'stale' : 'no';
    const brings = bringsOf(j, prefs, need);
    // It is this series, and lists nothing it is waiting for: remembered as `ok`, and judged first next time.
    if (!brings.length) return 'no';
    try {
      const followed = await followHunted(seriesId, s.title, j, 'scout', { brings: brings.length }, admit);
      await afterFollow(seriesId, need, brings);
      return { followed: done('followed', SCOUT_BACKOFF.followed, { followed: { ...followed, brings: brings.length } }) };
    } catch (e) {
      if ((e as { why?: string })?.why === 'cap') return 'cap';
      // Gone, unmonitored, or a lost race: not this source's fault, and the next candidate is not asked either.
      return 'not_needed';
    }
  };

  // v0.82.0: a backup extension that carried this series before, and that Uchiyomi removed once nothing needed it
  // (lib/backupExtensions.ts), is put back first -- the owner's "when there is new chapters it will just use main until
  // it rate limits or fail again and then it can reinstall/reuse those" -- once the series has waited an hour, so a
  // cooldown of a few minutes never reinstalls anything. One per look, the newest; asked by the id it had there, and
  // searched for again when that id is gone (a reinstall can renumber the engine's series). Reintroduce by trusting the
  // stored id: "a series stuck an hour gets its backup back, found again by its title" in backupExtensions.int.test.ts
  // never follows it.
  if (!ask.only && await backupsAllowed() && await stuckLongEnough(seriesId)) {
    const link = (await parkedLinksFor(seriesId))[0];
    if (link && engineState() === 'up' && installLockHolder() === null && await makeRoom()) {
      const got = await installTrial(link.pkg_name, {
        name: link.name, lang: link.lang ?? lang.lang, via: link.via ?? 'scout', who: 'backup', want: link.source_id.slice(SW_PREFIX.length),
        reason: 'link',
      });
      if (got !== BUSY) {
        // An install the engine refused is no answer: the link stays for the next look.
        let r: Asked = got ? 'no' : 'left';
        const id = got?.sourceId || '';
        if (id && getSource(id) && allowed(id) && fits(id) && !taken.has(rateKeyOf(id))) {
          r = await askOne(id, link.source_series_id);
          if (r === 'stale') r = await askOne(id, null, link.their_title ? [link.their_title] : []);
        }
        // The link is used up once the source has answered -- followed, or not this series. Out of time or searches,
        // not now, at the follower limit, or the series caught up meanwhile: it stays, and the backup is put back again
        // the next time the series is stuck. Before the settle, which keeps the package parked only while a link names
        // it. Reintroduce by dropping it whatever the answer: "a backup the look ran out of time for is kept for the
        // next" in backupExtensions.int.test.ts finds the link gone.
        if (typeof r === 'object' || r === 'no' || r === 'stale') await dropLink(seriesId, link.source_id);
        if (got) await settleTrial(link.pkg_name, { via: link.via ?? 'scout', who: 'backup', why: 'no_series' });
        if (typeof r === 'object') return { ...r.followed, followed: { ...r.followed.followed!, backup: link.pkg_name } };
        if (r === 'cap') return done('cap', SCOUT_BACKOFF.cap);
        if (r === 'not_needed') return done('not_needed', null);
        if (r === 'left') { left = true; cut = true; }
      }
    }
  }

  for (const id of order) {
    if (cut) break;
    const r = await askOne(id, knownIds.get(id) ?? null);
    if (typeof r === 'object') return r.followed;
    if (r === 'cap') return done('cap', SCOUT_BACKOFF.cap);
    if (r === 'not_needed') return done('not_needed', null);
    if (r === 'left') { left = true; break; }
    if (r === 'deferred') deferred++;
  }

  const fruitless = (ask.fruitless ?? 0) + 1;
  if (left) return done('left', SCOUT_BACKOFF.left[Math.min(fruitless, SCOUT_BACKOFF.left.length) - 1]);
  if (deferred) return done('deferred', SCOUT_BACKOFF.deferred);
  // Every source answered: look again when the first of their answers runs out.
  const after = await verdictsFor(seriesId);
  const ends = pool.map((p) => after.get(p.id)).filter((v) => !!v).map((v) => verdictExpires(v!)).filter((t): t is number => t !== null);
  const wait = ends.length ? Math.min(...ends) - Date.now() : SCOUT_BACKOFF.exhaustedMax;
  return done('exhausted', Math.min(SCOUT_BACKOFF.exhaustedMax, Math.max(SCOUT_BACKOFF.exhaustedMin, wait)));
}

/**
 * Once a source is followed: the chapters at their retry cap that it lists get their tries back (they were capped
 * because no source the series followed could serve them), and the series goes to the front of the finishing sweep,
 * which lists every source again and fetches from wherever each chapter can come now.
 */
async function afterFollow(seriesId: string, need: Need, brings: readonly number[]): Promise<void> {
  const fresh = need.capped.filter((n) => brings.includes(n));
  if (fresh.length) {
    await q('UPDATE chapter_failures SET attempts = 0 WHERE series_id = $1 AND number = ANY($2::real[])', [seriesId, fresh]).catch(() => {});
  }
  await backFirst(seriesId);
}

/** Write what a scout found onto its request row: its backoff, or the row dropped when nothing is needed. */
export async function settleScout(seriesId: string, reason: ScoutReason, out: ScoutOutcome, started: Date): Promise<void> {
  if (!out.nextAt) {
    // A request that came in while it looked (asked_at after the start) stands, and is looked at next.
    await q('DELETE FROM series_scout WHERE series_id = $1 AND asked_at <= $2', [seriesId, started]).catch(() => {});
    return;
  }
  const count = out.verdict === 'followed' ? 'reset' : out.verdict === 'left' || out.verdict === 'exhausted' ? 'add' : 'keep';
  // Since when it has been stuck (v0.82.0, lib/backupExtensions.ts stuckLongEnough): kept across looks, and over once a
  // source is followed -- the next time it is stuck is a new wait.
  await q(
    `INSERT INTO series_scout (series_id, reason, next_at, last_at, fruitless, verdict, detail, stuck_since)
     SELECT $1, $2, $3, now(), $4, $5, $6::jsonb, CASE WHEN $5 = 'followed' THEN NULL ELSE now() END
      WHERE EXISTS (SELECT 1 FROM lib_series WHERE id = $1)
     ON CONFLICT (series_id) DO UPDATE SET
       stuck_since = CASE WHEN EXCLUDED.verdict = 'followed' THEN NULL ELSE COALESCE(series_scout.stuck_since, now()) END,
       next_at = EXCLUDED.next_at, last_at = now(), verdict = EXCLUDED.verdict, detail = EXCLUDED.detail,
       fruitless = CASE $7 WHEN 'reset' THEN 0 WHEN 'add' THEN series_scout.fruitless + 1 ELSE series_scout.fruitless END,
       priority = CASE WHEN series_scout.asked_at > $8 THEN series_scout.priority ELSE 0 END,
       numbers = CASE WHEN series_scout.asked_at > $8 OR EXCLUDED.verdict <> 'followed' THEN series_scout.numbers ELSE '{}' END,
       seeds = CASE WHEN series_scout.asked_at > $8 THEN series_scout.seeds ELSE '{}' END`,
    [seriesId, reason, out.nextAt, count === 'add' ? 1 : 0, out.verdict,
      JSON.stringify({
        asked: out.asked.length, searches: out.searches,
        ...(out.followed ? { followed: out.followed.source, ...(out.followed.backup ? { backup: out.followed.backup } : {}) } : {}),
      }),
      count, started],
  ).catch(() => {});
}

interface ScoutPick { seriesId: string; reason: ScoutReason; numbers: number[]; seeds: string[]; fruitless: number }

/** The most pressing request whose backoff is over, on a monitored series anyone can see. */
async function nextRequested(): Promise<ScoutPick | null> {
  const r = await one<{ series_id: string; reason: ScoutReason; numbers: number[] | null; seeds: string[] | null; fruitless: number }>(
    `SELECT r.series_id, r.reason, r.numbers, r.seeds, r.fruitless FROM series_scout r JOIN lib_series s ON s.id = r.series_id
      WHERE r.next_at <= now() AND s.auto_update AND ${visibleToAll('s')}
      ORDER BY r.priority DESC, r.next_at ASC LIMIT 1`).catch(() => null);
  return r ? { seriesId: r.series_id, reason: r.reason, numbers: (r.numbers ?? []).map(Number), seeds: r.seeds ?? [], fruitless: Number(r.fruitless) } : null;
}

/**
 * With nothing put forward: the behind series with the most to come none of whose sources can be asked now, and once an
 * hour, a monitored series whose every source is broken (behind or not: a broken source lists nothing new).
 */
async function idlePick(): Promise<ScoutPick | null> {
  const notWaiting = `NOT EXISTS (SELECT 1 FROM series_scout r WHERE r.series_id = s.id AND r.next_at > now())`;
  const routed = `ARRAY(SELECT ss.source_id FROM series_sources ss WHERE ss.series_id = s.id) AS extra`;
  const pickFrom = async (rows: Array<{ id: string; source_id: string | null; extra: string[] | null }>, ok: (st: Standing[]) => boolean) => {
    const st = await standingsOf([...new Set(rows.flatMap((r) => [r.source_id ?? '', ...(r.extra ?? [])]).filter(Boolean))]);
    for (const r of rows) {
      const mine = [r.source_id ?? '', ...(r.extra ?? [])].filter(Boolean);
      if (mine.length && ok(mine.map((id) => st.get(id) ?? 'usable'))) return { seriesId: r.id, reason: 'idle' as const, numbers: [], seeds: [], fruitless: 0 };
    }
    return null;
  };
  const behind = await q<{ id: string; source_id: string | null; extra: string[] | null }>(
    `SELECT s.id, s.source_id, ${routed} FROM lib_series s
      WHERE s.auto_update AND ${visibleToAll('s')} AND s.numbering IS DISTINCT FROM 'posting_order' AND s.source_checked_at IS NOT NULL
        AND (COALESCE(s.finish_missing, s.source_missing) > 0 OR s.finish_after IS NOT NULL) AND ${notWaiting}
      ORDER BY COALESCE(s.finish_missing, s.source_missing, 0) DESC, s.id LIMIT 60`).catch(() => []);
  const stuck = await pickFrom(behind, (st) => !st.includes('usable'));
  if (stuck) return stuck;
  if (Date.now() - lastFrozenLook < HOUR) return null;
  lastFrozenLook = Date.now();
  const all = await q<{ id: string; source_id: string | null; extra: string[] | null }>(
    `SELECT s.id, s.source_id, ${routed} FROM lib_series s
      WHERE s.auto_update AND ${visibleToAll('s')} AND s.numbering IS DISTINCT FROM 'posting_order' AND s.source_id IS NOT NULL AND ${notWaiting}
      ORDER BY s.source_checked_at ASC NULLS FIRST, s.id LIMIT 500`).catch(() => []);
  return pickFrom(all, (st) => st.every((x) => !carries(x)) && !st.every((x) => x === 'off'));
}

/** The admin switch the hunt reads too: "Use other sources on their own" (auto_follow_on_failure), on unless turned off. */
async function scoutOn(): Promise<boolean> {
  const r = await one<{ on: boolean }>('SELECT auto_follow_on_failure AS "on" FROM server_settings WHERE id = 1').catch(() => null);
  return r?.on !== false;
}

/**
 * One look (server.ts, every SCOUT_TICK_MS): the most pressing series, scouted, and its row settled. Nothing while
 * another look runs, the server stops, Fix everything or a Find other sources run has the sources' attention, the
 * switch is off, or the hour's searches are spent. Returns what the look did, or null when it did not look.
 */
export async function scoutTick(): Promise<(ScoutOutcome & { seriesId: string }) | null> {
  if (scouting || runtime.stopping || runtime.autofixing || findRunning()) return null;
  if (limits.perHour <= 0 || scoutSearchesLeft() <= 0) return null;
  scouting = true;
  try {
    if (!(await scoutOn())) return null;
    const pick = (await nextRequested()) ?? (await idlePick());
    if (!pick) return null;
    const started = new Date();
    const out = await runScout(pick.seriesId, pick);
    await settleScout(pick.seriesId, pick.reason, out, started);
    if (out.followed) {
      const back = out.followed.backup ? `, a backup extension put back (${out.followed.backup})` : '';
      console.log(`[scout] "${out.title}": followed ${out.followed.source}${back}, which lists ${out.followed.brings} chapter${out.followed.brings === 1 ? '' : 's'} it was waiting for (${out.asked.length} source${out.asked.length === 1 ? '' : 's'} asked)`);
    } else if (out.asked.length) {
      console.log(`[scout] "${out.title}": ${out.verdict} after asking ${out.asked.length} source${out.asked.length === 1 ? '' : 's'} (${out.searches} search${out.searches === 1 ? '' : 'es'})`);
    }
    return { ...out, seriesId: pick.seriesId };
  } finally {
    scouting = false;
  }
}

// ---- trying extensions from the repository (v0.83.0) -----------------------------------------------------------------
//
// The owner's answer (2026-10-18): when no installed source has a series, try extensions from the repository -- "a few
// at a time": the best matches first, one install at a time, a handful a day, never an 18+ one for a series that is
// not 18+. The series this is for are the ones the scout asked every installed source about in vain (`exhausted`), that
// have waited an hour, and that have no backup of their own to put back. One install is asked about every such series
// in its language -- up to SERIES_PER_TRIAL -- before it is kept (a backup now) or removed, and what it did not have is
// remembered for a month (lib/backupExtensions.ts recordMiss), Fix everything's own tries included.

/** A series waiting for the repository: its language, and whether an 18+ extension may be tried for it. */
interface StoreSeries { id: string; title: string; lang: string; adult: boolean }

/** The series every installed source said no to, waiting an hour or more, with no backup of their own to put back. */
async function storeQueue(): Promise<StoreSeries[]> {
  const rows = await q<{ id: string; title: string }>(
    `SELECT r.series_id AS id, s.title FROM series_scout r JOIN lib_series s ON s.id = r.series_id
      WHERE r.verdict = 'exhausted' AND s.auto_update AND ${visibleToAll('s')} AND s.numbering IS DISTINCT FROM 'posting_order'
        AND r.stuck_since IS NOT NULL AND r.stuck_since <= now() - ($1 || ' milliseconds')::interval
        AND NOT EXISTS (SELECT 1 FROM backup_links l JOIN backup_extensions b ON b.pkg_name = l.pkg_name AND b.state = 'parked'
                         WHERE l.series_id = r.series_id)
      ORDER BY r.priority DESC, r.stuck_since ASC LIMIT 30`, [String(backupLimits().stuckMs)]).catch(() => []);
  const hidden = new Set(await getHiddenLangs().catch(() => [] as string[]));
  const out: StoreSeries[] = [];
  for (const r of rows) {
    const lang = (await seriesLanguage(r.id).catch(() => null))?.lang;
    // A series in a language the admin hides is theirs to decide, as Fix everything's rule is.
    if (!lang || hidden.has(lang)) continue;
    out.push({ id: r.id, title: r.title, lang, adult: await seriesIsAdult(r.id).catch(() => false) });
  }
  return out;
}

/** What one look in the repository did. */
export interface StoreLook {
  pkg: string;
  name: string;
  lang: string;
  /** The series it was asked about, and the ones that follow it now. */
  asked: string[];
  followed: string[];
  /** Kept as a backup (something follows it), or removed at once. */
  kept: boolean;
}

/**
 * One look (server.ts, with the backup upkeep): the best extension from the repository for the language with the most
 * series waiting, installed, asked about each of them (runScout over that one source), then kept as a backup when one
 * follows it, else removed -- and what it did not have remembered. Nothing while another look runs, the server stops, a
 * sweep, a repair, Fix everything or a Find run has the sources, the engine is not up, someone holds the install lock,
 * the switch is off, or an hour's or a day's installs are spent (lib/backupExtensions.ts trialAllowed). Null when it did
 * not look.
 */
export async function storeLook(): Promise<StoreLook | null> {
  if (scouting || runtime.stopping || runtime.updating || runtime.repairing || runtime.autofixing || findRunning()) return null;
  if (engineState() !== 'up' || installLockHolder() !== null) return null;
  if (limits.perHour <= 0 || scoutSearchesLeft() <= 0) return null;
  if (!(await backupsAllowed()) || !(await trialAllowed())) return null;
  scouting = true;
  try {
    const queue = await storeQueue();
    if (!queue.length) return null;
    const byLang = new Map<string, StoreSeries[]>();
    for (const x of queue) byLang.set(x.lang, [...(byLang.get(x.lang) ?? []), x]);
    const [lang, waiting] = [...byLang].sort((a, b) => b[1].length - a[1].length)[0];
    let catalogue: ExtensionInfo[];
    try { catalogue = await listExtensions(); } catch { return null; }
    const hidden = new Set(await getHiddenLangs().catch(() => [] as string[]));
    // Never one a person removed (`refused`), one already installed, an obsolete one, or one in another language.
    const refused = new Set([...(await backupRows())].filter(([, r]) => r.state === 'refused').map(([k]) => k));
    const missed = await missedRecently();
    // For each package, the waiting series it may be asked about: not missed for them (or their language) within the
    // month, and an 18+ package only for a series rated 18+. Reintroduce the 18+ rule's absence: "never an 18+ extension
    // for a series that is not" in backupStore.int.test.ts finds it installed.
    const forIt = (e: ExtensionInfo) => waiting.filter((x) => !missed(e.pkgName, x.id, lang) && (!e.nsfw || x.adult));
    const open = catalogue.filter((e) => !e.installed && !e.obsolete && !refused.has(e.pkgName) && pkgFits(e, lang)
      && !(e.lang && hidden.has(e.lang)) && forIt(e).length > 0);
    if (!open.length) return null;
    // Fix everything's order (lib/extensionRank.ts): the series' own translation groups first, then not 18+, then the
    // most downloaded a day, then the most updated.
    const groups = new Map<string, Set<string>>();
    for (const x of waiting) groups.set(x.id, await groupsOf(x.id));
    const facts = await extensionFacts();
    const perDay = await downloadsPerDay(open.map((e) => {
      const f = facts.get(e.pkgName);
      return { pkgName: e.pkgName, apkUrl: f?.apkUrl ?? null, jarUrl: f?.jarUrl ?? null, apkName: f?.apkName ?? null, index: f?.index ?? e.repo };
    }));
    const ranked = rankPackages(open.map((e) => {
      const key = normGroup(e.name);
      const named = key.length >= 3 ? waiting.filter((x) => [...groups.get(x.id)!].some((g) => g.includes(key) || key.includes(g))).length : 0;
      return { e, pkgName: e.pkgName, name: e.name, nsfw: e.nsfw, named, perDay: perDay.get(e.pkgName) ?? null, versionCode: facts.get(e.pkgName)?.versionCode ?? null };
    }));
    const pick = ranked[0].e;
    const ask = forIt(pick).slice(0, backupLimits().seriesPerTrial);
    // Room first (BACKUP_EXTENSIONS_MAX, the engine's source limit): the one needed longest ago makes way, never one in
    // use. Reintroduce by installing whatever the cap says: "the cap holds for the repository's extensions too" in
    // backupStore.int.test.ts finds a sixth installed.
    if (!(await makeRoom())) return null;
    const got = await installTrial(pick.pkgName, { name: pick.name, lang, via: 'scout', who: 'backup', reason: 'store' });
    if (got === BUSY || !got) return null;
    const out: StoreLook = { pkg: pick.pkgName, name: pick.name, lang, asked: [], followed: [], kept: false };
    if (!got.sourceId) {
      // No source in this language: it has none of these series, nor any other in the language, for a month.
      await recordMiss(pick.pkgName, { lang });
    } else {
      for (const x of ask) {
        if (runtime.stopping) break;
        const started = new Date();
        const r = await runScout(x.id, { only: got.sourceId });
        if (r.verdict === 'followed') {
          out.followed.push(x.id);
          await settleScout(x.id, 'stuck', r, started);
        }
        if (r.asked.includes(got.sourceId)) out.asked.push(x.id);
        // Asked, and not this series (or nothing it waits for): not tried for it again for a month.
        if (r.verdict !== 'followed' && r.asked.includes(got.sourceId)) await recordMiss(pick.pkgName, { seriesId: x.id });
      }
    }
    out.kept = (await settleTrial(pick.pkgName, { via: 'scout', who: 'backup', why: 'no_series' })) === 'kept';
    console.log(`[scout] tried ${pick.name} from the repository for ${out.asked.length} series in ${lang}: ${out.kept
      ? `kept as a backup, followed by ${out.followed.length}` : 'none of them there, removed'}`);
    return out;
  } finally {
    scouting = false;
  }
}
