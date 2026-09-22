// Finding a source for a chapter the followed ones could not serve, and following it.
//
// The owner's ask: "find a source automatically with full pages and continue". The add-time auto-follow
// (lib/autoFollow.ts) never searches -- its candidates are the pairs the dialog already found -- and the
// sweep had no way to reach a source the series does not follow, so a chapter whose every followed copy
// was broken stayed broken. This module is the one place the server searches on its own initiative, and
// because every search is a real request to a site, it is bounded on every axis at once:
//
//   - the admin switch (`server_settings.auto_follow_on_failure`, on by default);
//   - once per series per HUNT_COOLDOWN_MS, stamped on `lib_series.source_hunt_at` BEFORE the search, so a
//     crash mid-hunt never re-hunts the same series every sweep;
//   - at most HUNT_MAX_PER_SWEEP hunts per sweep (the caller's `budget`), HUNT_MAX_SOURCES searched per
//     hunt, under the fill scan's concurrency slots and a HUNT_WALL_MS wall;
//   - never past MAX_FOLLOWERS, never a source the series already follows, never one that is disabled,
//     in a cooldown, or outside the caller's `allowed` rule -- for the sweep, that rule is "no adult source
//     on a clean series": a server-initiated follow must not attach one where no person would have.
//
// The identity judgement is autoFollow's `judgeCandidate`, unchanged: the candidate's own title must be
// ours and its numbering must line up, both ways unless the title is exact on a listing of at least ten.
// "Tokyo Ghoul:re" is still refused for "Tokyo Ghoul". The follow is `followJudged`, the same atomic
// write under the same cap, and the copy of the wanted number comes out of the chapter list the judgement
// already fetched (`Judgement.chapters`) -- so a hunt costs one search per candidate and two lookups per
// candidate judged, and nothing more.
import { q, one } from './db';
import { getSource, listSources, type SourceChapter } from './sources';
import { budgetFor } from './sources/budget';
import { SOLVER_CONCURRENCY } from './sources/flaresolverr';
import { healthAll } from './sourceHealth';
import { scanOrder } from './scanOrder';
import { pickBest } from './titleMatch';
import { judgeCandidate, followJudged, bounded, MAX_FOLLOWERS, MIN_TRY_MS, type PrimaryFacts, type Judgement } from './autoFollow';
import { chooseReleases } from './releases';
import { effectivePrefsFor, readSeriesPrefs } from './scanlatorPrefs';
import { MIN_HAVE } from './fill';
import { logAudit } from './audit';
import { ADULT_RATING } from './visibility';

/** How long after one hunt a series may be hunted for again, whatever became of the first. */
export const HUNT_COOLDOWN_MS = 24 * 3600_000;
/** The whole hunt's wall: searches and judgements together. What has not answered by then is not tried. */
export const HUNT_WALL_MS = 60_000;
/** How many sources one hunt may search. */
export const HUNT_MAX_SOURCES = 6;
/** How many hunts one sweep may run (the caller's `budget.left` starts here). */
export const HUNT_MAX_PER_SWEEP = 5;
/** What one search gets before budgetFor raises it for a source behind the solver; capped by the wall. */
const HUNT_SEARCH_MS = 20_000;
/** The fill scan's slot count (routes/sources.ts SCAN_CONCURRENCY), so a hunt never out-runs the solver. */
const HUNT_CONCURRENCY = Math.max(1, Number(process.env.SCAN_CONCURRENCY || SOLVER_CONCURRENCY));

// One pool for the process, not one pool per hunt. Several series can reach the completion/fallback pass
// together; a limiter allocated inside huntSource lets every one of them run HUNT_CONCURRENCY searches,
// defeating the cap precisely when a source is already struggling. A released slot is handed directly to
// the oldest waiter so a newcomer cannot slip in and take the pool over width.
let huntInFlight = 0;
const huntWaiting: Array<() => void> = [];
async function takeHuntSlot(): Promise<void> {
  if (huntInFlight < HUNT_CONCURRENCY) { huntInFlight++; return; }
  await new Promise<void>((go) => huntWaiting.push(go));
}
function releaseHuntSlot(): void {
  const next = huntWaiting.shift();
  if (next) next();
  else huntInFlight--;
}

export interface HuntResult {
  /** The source this hunt followed, when it followed one. */
  followed: { source: string; sourceSeriesId: string } | null;
  /** That source's copy of the wanted number, tagged with `source`, when it lists one. */
  chapter: SourceChapter | null;
  why:
    | 'off'          // the admin switch is off
    | 'cooldown'     // hunted within HUNT_COOLDOWN_MS, or the sweep's budget is spent (nothing searched)
    | 'cap'          // the series already follows MAX_FOLLOWERS sources
    | 'no_candidate' // nothing to search, or no searched source both carries the title and is this series
    | 'no_copy'      // followed, but the new source does not list the wanted number
    | 'followed';
}

/**
 * The effective rating rule of lib/visibility.ts (`visible()`): the admin's override, then what the scan
 * read, then the library's own rating; NULL is not adult. Asked once per series by the sweep, before the
 * download loop, so the rule below can be a plain predicate.
 */
export async function seriesIsAdult(seriesId: string): Promise<boolean> {
  const r = await one<{ adult: boolean | null }>(
    `SELECT COALESCE(
       (SELECT o.age_rating FROM series_overrides o WHERE o.series_id = s.id),
       s.age_rating,
       (SELECT l.age_rating FROM libraries l WHERE l.id = s.library_id)) >= $2 AS adult
     FROM lib_series s WHERE s.id = $1`, [seriesId, ADULT_RATING],
  ).catch(() => null);
  return r?.adult === true;
}

/**
 * The sweep's rule for which sources it may reach on a series' behalf: any source for an adult series,
 * and only sources that do not declare themselves adult for every other. A viewer-driven path passes the
 * viewer's own cap (visibility.sourceAllowedFor) instead; this is for the paths that have no viewer.
 */
export function sweepAllowedFor(adult: boolean): (sourceId: string) => boolean {
  return (id) => !getSource(id)?.isNsfw || adult;
}

async function huntOn(): Promise<boolean> {
  const row = await one<{ on: boolean }>('SELECT auto_follow_on_failure AS "on" FROM server_settings WHERE id = 1').catch(() => null);
  return row?.on !== false;
}

/**
 * Search the sources this series does not follow for one that is this series, follow it, and hand back
 * its copy of `number`. Every early return is a `why`; nothing throws for a source's sake.
 *
 * Order: the switch; the sweep's budget (before anything is stamped, so a series the budget turned away
 * is hunted by the next sweep and not tomorrow's); the series row and its stamp; the follower cap; the
 * listing (under MIN_HAVE numbers there is nothing to judge against, and no source is asked); THEN the
 * stamp, and only then the network. Searches run in parallel under the slots, judgements in scan order
 * one at a time, stopping at the first candidate that is this series AND lists the number. A candidate
 * that is this series but lacks the number is remembered and followed when nothing better turns up:
 * it will serve the next chapter, which is what following is for.
 */
export async function huntSource(
  seriesId: string,
  number: number,
  opts: { allowed: (sourceId: string) => boolean; budget: { left: number }; now?: number },
): Promise<HuntResult> {
  const none = (why: HuntResult['why']): HuntResult => ({ followed: null, chapter: null, why });
  if (!(await huntOn())) return none('off');
  if (opts.budget.left <= 0) return none('cooldown');

  const s = await one<{ id: string; title: string; source_id: string | null; deleted_at: string | null; merged_into: string | null; source_hunt_at: string | null }>(
    'SELECT id, title, source_id, deleted_at, merged_into, source_hunt_at FROM lib_series WHERE id = $1', [seriesId]).catch(() => null);
  if (!s || s.deleted_at || s.merged_into) return none('no_candidate');
  const now = opts.now ?? Date.now();
  if (s.source_hunt_at && now - new Date(s.source_hunt_at).getTime() < HUNT_COOLDOWN_MS) return none('cooldown');

  const followers = (await q<{ source_id: string }>('SELECT source_id FROM series_sources WHERE series_id = $1', [seriesId]).catch(() => []))
    .map((r) => r.source_id);
  // The same count followJudged applies under its lock; checked here so a capped series costs no search.
  if (followers.filter((id) => id !== s.source_id).length >= MAX_FOLLOWERS) return none('cap');
  const numbers = (await q<{ number: number }>('SELECT DISTINCT number FROM series_listing WHERE series_id = $1', [seriesId]).catch(() => []))
    .map((r) => Number(r.number)).filter((n) => Number.isFinite(n));
  if (numbers.length < MIN_HAVE) return none('no_candidate');

  // ⚠️ Stamped BEFORE the search and charged to the budget BEFORE the search: whatever happens from here
  // on -- a crash, a wall, six sources that all say no -- this series is not searched for again today.
  await q('UPDATE lib_series SET source_hunt_at = now() WHERE id = $1', [seriesId]);
  opts.budget.left--;

  const health = new Map((await healthAll().catch(() => [])).map((h) => [h.source_id, h]));
  const followed = new Set([...(s.source_id ? [s.source_id] : []), ...followers]);
  const own = s.source_id ? getSource(s.source_id) : null;
  const candidates = scanOrder(listSources().filter((src) => opts.allowed(src.id)), own ? { id: own.id, lang: own.lang } : null)
    .filter((id) => {
      if (followed.has(id)) return false;
      const h = health.get(id);
      if (h?.disabled) return false;
      if (h?.blocked_until && new Date(h.blocked_until).getTime() > now) return false;
      return !!getSource(id);
    })
    .slice(0, HUNT_MAX_SOURCES);
  if (!candidates.length) return none('no_candidate');

  // `opts.now` is the cooldown clock seam, not a wall-clock replacement. Tests may put it in the past;
  // deriving this deadline from it would make every candidate time out without ever being searched.
  const deadline = Date.now() + HUNT_WALL_MS;
  const remaining = () => deadline - Date.now();
  // A slot is held before a search's clock starts, as the fill scan holds one, so the budget measures the
  // source and not the queue; the wall is checked once the slot is held, so a source that waited its turn
  // out is simply not tried rather than charged for the wait.
  const hits: Array<{ source: string; sourceId: string } | null> = new Array(candidates.length).fill(null);
  await Promise.all(candidates.map(async (id, i) => {
    await takeHuntSlot();
    try {
      const src = getSource(id);
      const left = remaining();
      if (!src || left < MIN_TRY_MS) return;
      // A search that throws or outruns its budget is a source that did not answer -- not a health event:
      // a hunt must never be what puts a source into a cooldown, so nothing here reports.
      const hit = pickBest(await bounded(src.search(s.title), Math.min(budgetFor(src, HUNT_SEARCH_MS), left)), s.title);
      if (hit?.sourceId) hits[i] = { source: id, sourceId: hit.sourceId };
    } catch { /* not this series' problem */ } finally { releaseHuntSlot(); }
  }));

  const prefs = await effectivePrefsFor(await readSeriesPrefs(seriesId), 0);
  const primary: PrimaryFacts = { title: s.title, altTitles: [], numbers };
  const copyOf = (j: Judgement): SourceChapter | null => {
    const c = chooseReleases(j.chapters ?? [], prefs).releases.find((x) => x.number === number);
    return c ? { ...c, source: j.source } : null;
  };
  // Judged in scan order, one at a time: the first that is this series and lists the number wins, and
  // nothing past it is asked. One that is this series but lacks the number is kept as the fallback.
  let fallback: Judgement | null = null;
  let chosen: { j: Judgement; chapter: SourceChapter | null } | null = null;
  for (const hit of hits) {
    if (!hit) continue;
    const left = remaining();
    if (left < MIN_TRY_MS) break;
    const j = await bounded(judgeCandidate(primary, hit, { prefs, health }), left).catch(() => null);
    if (!j || j.why !== 'ok') continue;
    const chapter = copyOf(j);
    if (chapter) { chosen = { j, chapter }; break; }
    fallback ??= j;
  }
  if (!chosen && fallback) chosen = { j: fallback, chapter: null };
  if (!chosen) return none('no_candidate');

  const { j, chapter } = chosen;
  const written = await followJudged(seriesId, j).catch(() => 'gone' as const);
  if (written === 'cap') return none('cap');
  if (written !== 'inserted') return none('no_candidate');
  await logAudit('series.follow_source', {
    userId: null,
    detail: {
      id: seriesId, title: s.title, source: j.source, sourceSeriesId: j.sourceSeriesId, coverage: j.coverage, theirTitle: j.theirTitle,
      auto: true, reason: 'failed_chapter', number,
    },
  });
  console.log(`[hunt] "${s.title}": followed ${j.source} for chapter ${number}${chapter ? '' : ' (it does not list that number yet)'}`);
  return { followed: { source: j.source, sourceSeriesId: j.sourceSeriesId }, chapter, why: chapter ? 'followed' : 'no_copy' };
}
