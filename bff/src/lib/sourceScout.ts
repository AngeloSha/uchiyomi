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
import { getSource, listSources } from './sources';
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
  const held = await one<{ top: number | null }>(
    'SELECT max(number)::float8 AS top FROM lib_books WHERE series_id = $1 AND number IS NOT NULL', [seriesId]).catch(() => null);
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
  // What the request named (a chapter saved with pages missing, a fill's numbers): wanted whatever the listing says.
  for (const n of asked) if (Number.isFinite(n)) numbers.add(n);
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
  /** The source it followed, and how many chapters it lists that the series was waiting for. */
  followed?: { source: string; sourceSeriesId: string; brings: number };
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
  const pool = listSources().filter((src) => !mine.includes(src.id) && allowed(src.id) && fits(src.id) && !taken.has(rateKeyOf(src.id)));
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

  for (const id of order) {
    if (runtime.stopping || deadline - Date.now() < MIN_TRY_MS) { left = true; break; }
    if (!(await admit().catch(() => false))) return done('not_needed', null);
    const src = getSource(id);
    if (!src) continue;
    let ref = knownIds.get(id) ?? null;
    if (!ref) {
      if (searches >= limits.maxSearches || scoutSearchesLeft() <= 0) { left = true; break; }
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
        found = await searchByNames(counted, s.title, names, () => deadline - Date.now(), SEARCH_MS, admit);
      } finally {
        releaseHuntSlot();
      }
      if (found.paused) return done('not_needed', null);
      asked.push(id);
      if (outOfSearches && !found.hit) { left = true; break; }
      if (!found.hit?.sourceId) {
        // Answered and not there; or never answered at all. Searched under every name either way.
        await recordVerdict(seriesId, id, found.answered ? 'no_hit' : 'unreachable', { ourCount });
        continue;
      }
      ref = found.hit.sourceId;
    } else {
      asked.push(id);
    }
    const room = deadline - Date.now();
    if (room < MIN_TRY_MS) { left = true; break; }
    const j = await bounded(judgeCandidate(primary, { source: id, sourceId: ref }, { prefs, health, admit }), room).catch(() => null);
    // The wall cut it short: nothing is known about the source, and it is asked next time.
    if (!j) { left = true; break; }
    if (j.why === 'unavailable') { deferred++; continue; }
    await rememberJudgement(seriesId, j, ourCount);
    if (j.why !== 'ok') continue;
    const brings = bringsOf(j, prefs, need);
    // It is this series, and lists nothing it is waiting for: remembered as `ok`, and judged first next time.
    if (!brings.length) continue;
    try {
      const followed = await followHunted(seriesId, s.title, j, 'scout', { brings: brings.length }, admit);
      await afterFollow(seriesId, need, brings);
      return done('followed', SCOUT_BACKOFF.followed, { followed: { ...followed, brings: brings.length } });
    } catch (e) {
      if ((e as { why?: string })?.why === 'cap') return done('cap', SCOUT_BACKOFF.cap);
      // Gone, unmonitored, or a lost race: not this source's fault, and the next candidate is not asked either.
      return done('not_needed', null);
    }
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
  await q(
    `INSERT INTO series_scout (series_id, reason, next_at, last_at, fruitless, verdict, detail)
     SELECT $1, $2, $3, now(), $4, $5, $6::jsonb WHERE EXISTS (SELECT 1 FROM lib_series WHERE id = $1)
     ON CONFLICT (series_id) DO UPDATE SET
       next_at = EXCLUDED.next_at, last_at = now(), verdict = EXCLUDED.verdict, detail = EXCLUDED.detail,
       fruitless = CASE $7 WHEN 'reset' THEN 0 WHEN 'add' THEN series_scout.fruitless + 1 ELSE series_scout.fruitless END,
       priority = CASE WHEN series_scout.asked_at > $8 THEN series_scout.priority ELSE 0 END,
       numbers = CASE WHEN series_scout.asked_at > $8 OR EXCLUDED.verdict <> 'followed' THEN series_scout.numbers ELSE '{}' END,
       seeds = CASE WHEN series_scout.asked_at > $8 THEN series_scout.seeds ELSE '{}' END`,
    [seriesId, reason, out.nextAt, count === 'add' ? 1 : 0, out.verdict,
      JSON.stringify({ asked: out.asked.length, searches: out.searches, ...(out.followed ? { followed: out.followed.source } : {}) }),
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
      console.log(`[scout] "${out.title}": followed ${out.followed.source}, which lists ${out.followed.brings} chapter${out.followed.brings === 1 ? '' : 's'} it was waiting for (${out.asked.length} source${out.asked.length === 1 ? '' : 's'} asked)`);
    } else if (out.asked.length) {
      console.log(`[scout] "${out.title}": ${out.verdict} after asking ${out.asked.length} source${out.asked.length === 1 ? '' : 's'} (${out.searches} search${out.searches === 1 ? '' : 'es'})`);
    }
    return { ...out, seriesId: pick.seriesId };
  } finally {
    scouting = false;
  }
}
