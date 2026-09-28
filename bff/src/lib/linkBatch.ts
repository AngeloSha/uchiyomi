/**
 * Connect sources: the library's bulk way to follow other sources for many series at once.
 *
 * A series follows its primary source and up to MAX_FOLLOWERS more (series_sources, lib/autoFollow.ts), and
 * the sweep takes a chapter from whichever of them has it -- so a series whose primary is down keeps
 * updating from a follower. Until now a follower was found one series at a time (Find missing chapters), at
 * add time (auto-follow) or by the nightly hunt, and always by the series' ONE title, which misses every site
 * that files the work under another name.
 *
 * This looks for the series on other sources under the names it goes by (lib/altTitles.ts) and hands the
 * admin a review -- the import review's shape (routes/admin.ts, import_batches) -- in which nothing is
 * followed until a person ticks it.
 *
 * ⚠️ It is a PACED BACKGROUND JOB, bounded like the hunt (lib/sourceHunt.ts), because every search is a real
 * request to a site and a failed one escalates that site's cooldown:
 *
 *  - one batch at a time server-wide, one series at a time, LINK_PACE_MS between series (bulkNewest's pace);
 *  - it waits while a sweep or a repair runs, and stops at a series boundary on shutdown (the batch then
 *    reads as interrupted and resumes where it stopped);
 *  - per series, sources are asked in `scanOrder` (the series' own language first), at most LINK_MAX_SOURCES
 *    of them and LINK_MAX_SEARCHES searches in all, under LINK_SERIES_WALL_MS -- and it STOPS as soon as the
 *    series' free follower slots are filled by followable candidates;
 *  - the searches call the adapter directly and report nothing (the hunt's rule): a Connect sources search
 *    must never be what puts a source into a cooldown, and it never takes Discover's search slots;
 *  - source health is read again for every series, so a source that goes into a cooldown mid-run is left
 *    alone from the next series on.
 *
 * The judgement is autoFollow's `judgeCandidate`, the one every automatic follow uses, with one opt-in: the
 * other names in the candidate's own description may match ours EXACTLY, and such a match is always measured
 * both ways (`descriptionNames`). A candidate it would follow is `ok`. A candidate whose name matches exactly
 * but whose numbering does not is kept as `numbering_differs`, shown, and never followed by a run: it can
 * only be followed one at a time, from its chapter list, after a person has looked (followSingle).
 *
 * Nothing here downloads anything. A follow only changes where the sweep LOOKS; the listings of the series a
 * run connected are refreshed afterwards one at a time, paced, and not at all while a sweep or repair runs.
 */
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
import { altTitleMatchingOn, altTitlesFor, exactNameMatch, learnAltTitles, recordAltTitles } from './altTitles';
import { logAudit } from './audit';
import { runtime } from './runtime';

const knob = (name: string, def: number, min = 1) => Math.max(min, Number(process.env[name] || def));
/** Names searched per source: the title and up to three others, as the import's RESOLVE_ALT_TITLES. */
export const LINK_TERMS_MAX = 4;
/** Sources asked per series, in scan order. The hunt asks six; a person is reviewing this, so a few more. */
export const LINK_MAX_SOURCES = knob('LINK_MAX_SOURCES', 8);
/** Searches per series in all, across its sources and names. */
export const LINK_MAX_SEARCHES = knob('LINK_MAX_SEARCHES', 12);
/** Search hits judged per source: every exact-name hit first, then the source's own top hit. */
export const LINK_JUDGE_PER_SOURCE = 2;
/** Sources asked at once for one series. Low on purpose: the job is paced, not fast. */
export const LINK_SEARCH_CONCURRENCY = knob('LINK_SEARCH_CONCURRENCY', 2);
/** One series' whole search-and-judge budget. What is not asked by then is simply not in the review. */
export const LINK_SERIES_WALL_MS = knob('LINK_SERIES_WALL_MS', 120_000, 10_000);
/** One search, before budgetFor raises it for a source behind the solver; capped by the wall. */
export const LINK_SEARCH_MS = knob('LINK_SEARCH_MS', 20_000, 1_000);
/** One judgement's two lookups, before budgetFor raises it. */
export const LINK_LOOKUP_MS = knob('LINK_LOOKUP_MS', 20_000, 1_000);
/** The pause between two series that asked a source, and between two listing refreshes: bulkNewest's PACE_MS. */
export const LINK_PACE_MS = 1500;
/** How often a batch waiting on a sweep or a repair looks again. */
export const LINK_WAIT_MS = 15_000;
/** How long finished and open batches are kept (the import sweep's rule, routes/admin.ts). */
const SWEEP_DONE_DAYS = 7;
const SWEEP_OPEN_DAYS = 30;

export type LinkVerdict = 'ok' | 'numbering_differs';
/** Why a series was not searched (link_items.note). */
export type LinkNote = 'posting_order' | 'full' | 'too_few';

/** What a series brings to the search: its names, what it lists, and what it already follows. */
export interface LinkFacts {
  seriesId: string;
  /** The title as shown (the admin's override first); `names[0]`. */
  title: string;
  /** Every name searched and matched against, main title first, distinct by key. */
  names: string[];
  numbers: number[];
  primary: string | null;
  followers: string[];
  /** lib_series.numbering: `posting_order` refuses every follower (#116). */
  numbering: string | null;
}

export interface LinkJudgement {
  source: string;
  sourceSeriesId: string;
  theirTitle: string | null;
  cover: string | null;
  ourName: string | null;
  theirName: string | null;
  coverageFwd: number | null;
  coverageBack: number | null;
  verdict: LinkVerdict;
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
 * Every chapter number the series has: what its sources list, and what is on disk (an admin's number
 * override first). ⚠️ A chapter with no number is left out in SQL: `Number(null)` is 0, and a phantom
 * chapter 0 would count against every candidate that starts at 1.
 */
export async function ourNumbers(seriesId: string): Promise<number[]> {
  const rows = await q<{ number: number }>(
    `SELECT number FROM series_listing WHERE series_id = $1
     UNION
     SELECT n FROM (SELECT COALESCE(bo.number, b.number) AS n FROM lib_books b LEFT JOIN book_overrides bo ON bo.book_id = b.id
                     WHERE b.series_id = $1) x WHERE n IS NOT NULL`,
    [seriesId]).catch(() => []);
  return [...new Set(rows.map((r) => Number(r.number)).filter((n) => Number.isFinite(n)))];
}

/**
 * The series as the search sees it. Null for a series that is gone, removed or merged away: following
 * onto a row nobody can open is the thing followConfirmed refuses too.
 *
 * With the switch on, the PRIMARY's own description is read for names first (and kept): that is where the
 * other names of a series added before this feature live, and it costs one lookup of a source the series
 * already follows -- skipped when that source is switched off or in a cooldown.
 */
export async function linkFactsFor(seriesId: string, opts: { learn?: boolean; health?: Map<string, SourceHealth> } = {}): Promise<LinkFacts | null> {
  const s = await one<{ id: string; title: string; shown: string; source_id: string | null; source_series_id: string | null; deleted_at: string | null; merged_into: string | null; numbering: string | null }>(
    `SELECT s.id, s.title, COALESCE(o.title, s.title) AS shown, s.source_id, s.source_series_id, s.deleted_at, s.merged_into, s.numbering
       FROM lib_series s LEFT JOIN series_overrides o ON o.series_id = s.id WHERE s.id = $1`, [seriesId]).catch(() => null);
  if (!s || s.deleted_at || s.merged_into) return null;
  const on = await altTitleMatchingOn();
  let learned: string[] = [];
  const primary = s.source_id ? getSource(s.source_id) : null;
  if (on && opts.learn !== false && primary && s.source_series_id && s.numbering !== 'posting_order'
      && !resting(opts.health?.get(primary.id), Date.now())) {
    try {
      const own = await bounded(primary.getSeries(s.source_series_id), budgetFor(primary, LINK_LOOKUP_MS));
      learned = await learnAltTitles(seriesId, own?.summary, primary.id);
    } catch { /* the primary is down -- which is often why this is being run; its stored names still count */ }
  }
  const stored = await altTitlesFor(seriesId, { includeDescription: on });
  const numbers = await ourNumbers(seriesId);
  const followers = (await q<{ source_id: string }>('SELECT source_id FROM series_sources WHERE series_id = $1', [seriesId]).catch(() => []))
    .map((r) => r.source_id).filter((id) => id !== s.source_id);
  return {
    seriesId,
    title: s.shown,
    names: distinctNames([s.shown, s.title, ...stored, ...learned]),
    numbers,
    primary: s.source_id,
    followers,
    numbering: s.numbering,
  };
}

/** How many more sources this series may follow. */
export const freeSlots = (f: Pick<LinkFacts, 'followers'>) => Math.max(0, MAX_FOLLOWERS - f.followers.length);

/**
 * A judgeCandidate verdict as a review row, or null when it is not worth showing. `ok` is kept whatever
 * matched -- it is what autoFollow itself would follow. `numbering_differs` is kept only when a name matched
 * EXACTLY: a name that merely contains ours with numbers that do not line up is what a sequel looks like,
 * and showing it would only invite the wrong book.
 */
export function toLinkJudgement(
  j: Judgement,
  facts: Pick<LinkFacts, 'names' | 'numbers'>,
  prefs: ReleasePrefs,
  cover: string | null = null,
): LinkJudgement | null {
  if (j.why !== 'ok' && j.why !== 'numbering_differs') return null;
  const theirs = [j.theirTitle ?? '', ...(j.matchedVia ? [j.matchedVia] : [])];
  const match = exactNameMatch(facts.names, theirs);
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
export function hitsToJudge(items: SourceSeries[], names: string[], max = LINK_JUDGE_PER_SOURCE): SourceSeries[] {
  const keys = new Set(names.map((n) => normTitle(n)).filter(Boolean));
  const list = items.filter((r) => !!r.sourceId);
  const exact = list.filter((r) => keys.has(normTitle(r.title)));
  const rest = list.filter((r) => !exact.includes(r)).slice(0, 1);
  return [...exact, ...rest].slice(0, max);
}

/**
 * Which sources to ask for this series, in the order to ask them: scanOrder over every loaded source,
 * without the ones it already reads from and the ones switched off or in a cooldown right now.
 */
export function sourcesToAsk(facts: Pick<LinkFacts, 'primary' | 'followers'>, health: Map<string, SourceHealth>, all: SourceAdapter[] = listSources(), now = Date.now()): string[] {
  const taken = new Set([...(facts.primary ? [facts.primary] : []), ...facts.followers]);
  const own = facts.primary ? getSource(facts.primary) : null;
  return scanOrder(all, own ? { id: own.id, lang: own.lang } : null)
    .filter((id) => !taken.has(id) && !resting(health.get(id), now) && !!getSource(id))
    .slice(0, LINK_MAX_SOURCES);
}

/**
 * Look for this series on the sources it does not read from, and answer the best judgement per source.
 * Stops as soon as the series' free slots are filled with `ok` candidates, at the wall, at the search cap,
 * or when `stop()` says so. A source is asked a later name only while nothing it answered matched by name.
 */
export async function findLinks(facts: LinkFacts, opts: {
  wallMs?: number; health?: Map<string, SourceHealth>; sources?: SourceAdapter[]; stop?: () => boolean; concurrency?: number;
} = {}): Promise<{ found: LinkJudgement[]; asked: number; unreachable: number }> {
  const free = freeSlots(facts);
  if (free <= 0 || facts.numbering === 'posting_order' || facts.numbers.length < MIN_HAVE) return { found: [], asked: 0, unreachable: 0 };
  const deadline = Date.now() + (opts.wallMs ?? LINK_SERIES_WALL_MS);
  const health = opts.health ?? await healthMap();
  const order = sourcesToAsk(facts, health, opts.sources);
  const descriptionNames = await altTitleMatchingOn();
  const prefs = await effectivePrefsFor(await readSeriesPrefs(facts.seriesId), 0);
  const primary = { title: facts.names[0] ?? facts.title, altTitles: facts.names.slice(1), numbers: facts.numbers };

  const best = new Map<string, LinkJudgement>();
  let ok = 0;
  let searches = 0;
  let asked = 0;
  let unreachable = 0;
  const left = () => deadline - Date.now();
  const done = () => ok >= free || left() < MIN_TRY_MS || searches >= LINK_MAX_SEARCHES || !!opts.stop?.();

  const askOne = async (id: string) => {
    const src = getSource(id);
    if (!src) return;
    asked++;
    let answered = false;
    const judged = new Set<string>();
    for (const term of facts.names.slice(0, LINK_TERMS_MAX)) {
      if (done() || best.has(id)) break;
      searches++;
      let items: SourceSeries[];
      try {
        // The adapter itself, not searchAll: nothing is reported, so this can never put a source in a
        // cooldown, and it never queues in front of Discover's searches.
        items = await bounded(src.search(term), Math.min(budgetFor(src, LINK_SEARCH_MS), left()));
        answered = true;
      } catch { continue; }
      for (const hit of hitsToJudge(items ?? [], facts.names)) {
        if (judged.has(hit.sourceId) || left() < MIN_TRY_MS || opts.stop?.()) continue;
        judged.add(hit.sourceId);
        const j = await bounded(
          judgeCandidate(primary, { source: id, sourceId: hit.sourceId }, { prefs, health, lookupMs: LINK_LOOKUP_MS, descriptionNames }),
          left(),
        ).catch(() => null);
        const lj = j ? toLinkJudgement(j, facts, prefs, hit.coverUrl ?? null) : null;
        if (!lj) continue;
        const prev = best.get(id);
        if (!prev || (prev.verdict !== 'ok' && lj.verdict === 'ok')) best.set(id, lj);
        if (lj.verdict === 'ok') { ok++; break; }
      }
    }
    if (!answered) unreachable++;
  };

  let next = 0;
  const worker = async () => {
    while (next < order.length && !done()) await askOne(order[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? LINK_SEARCH_CONCURRENCY, order.length) }, worker));
  return { found: [...best.values()], asked, unreachable };
}

// ---- following -------------------------------------------------------------------------------------------

export type FollowOutcome = 'inserted' | 'cap' | 'gone' | 'primary' | 'already_followed' | 'posting_order';

/**
 * Follow a confirmed candidate: one transaction, the series row locked, followJudged's shape
 * (lib/autoFollow.ts) with the admin as `added_by`. INSERT only: a source the series already follows is
 * `already_followed` and is never re-pointed -- a batch stays open for up to 30 days, and the series may
 * have followed that source another way since, possibly to a different entry. The series' posting-order
 * numbering (#116) is re-read under the same lock, so a series renumbered after the review refuses too.
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
 * Close the open candidates of a batch that can no longer be followed: their source is now the series'
 * primary or already followed (`already_followed`, `primary`), or the series has since been numbered by
 * posting order. Run on every read of the batch and before a run, so a follow made anywhere else -- the
 * Sources sheet, the hunt, another batch -- is reflected here rather than discovered by the run.
 */
export async function closeStale(batchId: string): Promise<void> {
  await q(
    `UPDATE link_candidates c
        SET status = CASE WHEN s.numbering = 'posting_order' THEN 'posting_order'
                          WHEN s.source_id = c.source THEN 'primary'
                          ELSE 'already_followed' END
       FROM link_items i JOIN lib_series s ON s.id = i.series_id
      WHERE c.item_id = i.id AND i.batch_id = $1 AND c.status IS NULL
        AND (s.numbering = 'posting_order' OR s.source_id = c.source
             OR EXISTS (SELECT 1 FROM series_sources ss WHERE ss.series_id = i.series_id AND ss.source_id = c.source))`,
    [batchId],
  );
}

// ---- batches ---------------------------------------------------------------------------------------------

export interface LinkBatchRow {
  id: string; user_id: string; state: 'searching' | 'review' | 'linking' | 'done';
  total: number; searched: number; linked: number; failed: number; created_at: string; updated_at: string;
}
export interface LinkItemRow {
  id: string; batch_id: string; ord: number; series_id: string; title: string; names: string[];
  state: 'pending' | 'done' | 'skipped' | 'error'; asked: number; unreachable: number; note: LinkNote | null;
}
export interface LinkCandidateRow {
  id: string; item_id: string; source: string; source_series_id: string; their_title: string | null; cover: string | null;
  our_name: string | null; their_name: string | null; coverage_fwd: number | null; coverage_back: number | null;
  verdict: string; manual: boolean; status: string | null;
}

/**
 * The batch whose search loop THIS process is running, or 'pending' while a POST is creating one. One at a
 * time server-wide, for the import's reason: two searches at once double the outbound rate to every source.
 */
let searchingBatch: string | null = null;
/** What the running search is waiting on before its next series, if anything. */
let waitingOn: 'sweep' | 'repair' | null = null;
const linkingBatches = new Set<string>();
const aborted = new Set<string>();

export const linkSearchBusy = () => searchingBatch !== null;
export const isSearching = (id: string) => searchingBatch === id;
export const isLinking = (id: string) => linkingBatches.has(id);
export const searchWaitingOn = (id: string) => (searchingBatch === id ? waitingOn : null);
/** Claim the search slot synchronously; false when another batch holds it. */
export function claimSearch(id: string): boolean {
  if (searchingBatch) return false;
  searchingBatch = id;
  return true;
}
export function releaseSearch(id: string): void { if (searchingBatch === id) searchingBatch = null; }

/** Stop whatever loop this batch has going; used by DELETE. The row in flight finishes and writes nothing that survives. */
export function abortBatch(id: string): void {
  if (searchingBatch === id || linkingBatches.has(id)) aborted.add(id);
  if (searchingBatch === id) searchingBatch = null;
}

export type SkipWhy = 'gone' | LinkNote;

/**
 * Create a batch over these series, in the order given. A series that cannot take a follower is left out
 * here and never searched: gone (removed or merged), numbered by posting order (#116 -- the follow route
 * answers 409 `posting_order`, auto-follow and the hunt refuse it), or already following MAX_FOLLOWERS.
 * Returns null, with the reasons, when none is left.
 */
export async function createLinkBatch(userId: string, seriesIds: string[]): Promise<{ id: string | null; total: number; skipped: Array<{ id: string; why: SkipWhy }> }> {
  const ids = [...new Set(seriesIds)];
  const rows = await q<{ id: string; title: string; deleted_at: string | null; merged_into: string | null; numbering: string | null; followers: number }>(
    `SELECT s.id, COALESCE(o.title, s.title) AS title, s.deleted_at, s.merged_into, s.numbering,
            (SELECT count(*)::int FROM series_sources ss WHERE ss.series_id = s.id AND ss.source_id IS DISTINCT FROM s.source_id) AS followers
       FROM lib_series s LEFT JOIN series_overrides o ON o.series_id = s.id WHERE s.id = ANY($1::text[])`, [ids]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const skipped: Array<{ id: string; why: SkipWhy }> = [];
  const kept: string[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r || r.deleted_at || r.merged_into) skipped.push({ id, why: 'gone' });
    else if (r.numbering === 'posting_order') skipped.push({ id, why: 'posting_order' });
    else if (r.followers >= MAX_FOLLOWERS) skipped.push({ id, why: 'full' });
    else kept.push(id);
  }
  if (!kept.length) return { id: null, total: 0, skipped };
  const batch = await one<{ id: string }>(
    `INSERT INTO link_batches (user_id, state, total) VALUES ($1, 'searching', $2) RETURNING id`, [userId, kept.length]);
  await q(
    `INSERT INTO link_items (batch_id, ord, series_id, title)
     SELECT $1, o, s, t FROM unnest($2::int[], $3::text[], $4::text[]) AS x(o, s, t)`,
    [batch!.id, kept.map((_, i) => i), kept, kept.map((id) => byId.get(id)!.title)],
  );
  return { id: batch!.id, total: kept.length, skipped };
}

/**
 * Search every pending item of a batch, one series at a time, writing each series' candidates as it
 * finishes so the page fills in under its poll. The caller must hold the search slot (claimSearch); it is
 * released here. `paceMs` / `waitMs` are test knobs.
 */
export async function searchBatch(batchId: string, opts: { paceMs?: number; waitMs?: number } = {}): Promise<void> {
  searchingBatch = batchId;
  const pace = opts.paceMs ?? LINK_PACE_MS;
  const stopped = () => aborted.has(batchId) || runtime.stopping;
  try {
    const items = await q<LinkItemRow>(`SELECT * FROM link_items WHERE batch_id = $1 AND state = 'pending' ORDER BY ord`, [batchId]);
    await q(`UPDATE link_batches SET searched = total - $2, updated_at = now() WHERE id = $1`, [batchId, items.length]).catch(() => {});
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      // Never beside a sweep or a repair: both ask the same sites, and the sweep is what the install is for.
      while (!stopped() && (runtime.updating || runtime.repairing)) {
        waitingOn = runtime.repairing ? 'repair' : 'sweep';
        await sleep(opts.waitMs ?? LINK_WAIT_MS);
      }
      waitingOn = null;
      // Shutdown or discard: stop at the series boundary. The rest stay `pending`, and after a restart the
      // batch reads as interrupted and resumes from here.
      if (stopped()) return;
      let asked = 0;
      try {
        const health = await healthMap();
        const facts = await linkFactsFor(item.series_id, { health });
        const skip = (note: LinkNote) => q(`UPDATE link_items SET state = 'skipped', note = $2 WHERE id = $1`, [item.id, note]);
        if (!facts) await q(`UPDATE link_items SET state = 'error' WHERE id = $1`, [item.id]);
        else if (facts.numbering === 'posting_order') await skip('posting_order');
        else if (freeSlots(facts) <= 0) await skip('full');
        else if (facts.numbers.length < MIN_HAVE) await skip('too_few');
        else {
          const r = await findLinks(facts, { health, stop: stopped });
          asked = r.asked;
          // Cut short by a shutdown or a discard: nothing is written, and a resume searches it again whole.
          if (stopped()) return;
          for (const j of r.found) await saveCandidate(item.id, j, false);
          await q(`UPDATE link_items SET state = 'done', names = $2, asked = $3, unreachable = $4 WHERE id = $1`,
            [item.id, facts.names, r.asked, r.unreachable]);
        }
      } catch {
        await q(`UPDATE link_items SET state = 'error' WHERE id = $1`, [item.id]).catch(() => {});
      }
      await q(`UPDATE link_batches SET searched = searched + 1, updated_at = now() WHERE id = $1`, [batchId]).catch(() => {});
      // Paced like bulkNewest: only after a series that actually asked a source.
      if (asked > 0 && i < items.length - 1) await sleep(pace);
    }
    await q(`UPDATE link_batches SET state = 'review', updated_at = now() WHERE id = $1 AND state = 'searching'`, [batchId]).catch(() => {});
  } finally {
    waitingOn = null;
    releaseSearch(batchId);
    aborted.delete(batchId);
  }
}

/** Write (or refresh) one candidate row. A manual pick stays manual when the search finds it again. */
export async function saveCandidate(itemId: string, j: LinkJudgement, manual: boolean): Promise<LinkCandidateRow | null> {
  return one<LinkCandidateRow>(
    `INSERT INTO link_candidates (item_id, source, source_series_id, their_title, cover, our_name, their_name, coverage_fwd, coverage_back, verdict, manual)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (item_id, source) DO UPDATE SET source_series_id = EXCLUDED.source_series_id, their_title = EXCLUDED.their_title,
       cover = COALESCE(EXCLUDED.cover, link_candidates.cover), our_name = EXCLUDED.our_name, their_name = EXCLUDED.their_name,
       coverage_fwd = EXCLUDED.coverage_fwd, coverage_back = EXCLUDED.coverage_back, verdict = EXCLUDED.verdict,
       manual = link_candidates.manual OR EXCLUDED.manual, status = NULL
     RETURNING *`,
    [itemId, j.source, j.sourceSeriesId, j.theirTitle, j.cover, j.ourName, j.theirName, j.coverageFwd, j.coverageBack, j.verdict, manual],
  );
}

export type PickError = 'gone' | 'posting_order' | 'full' | 'too_few' | 'already_followed' | 'unknown_source'
  | 'unavailable' | 'unreachable' | 'title_differs' | 'not_this_series';

/**
 * A candidate an admin picked by hand from the search sheet, judged by the same rule as a found one
 * (judgeCandidate, health read now) and saved as `manual`. Everything that would refuse the follow refuses
 * the pick first, before any lookup: a series numbered by posting order, one with no free slot, the primary
 * and the sources already followed. Names are the stored ones: the primary's description was read when the
 * batch searched, and a person waiting on a pick should not pay for a second read.
 */
export async function judgeManualPick(
  seriesId: string,
  pick: { source: string; sourceSeriesId: string; cover?: string | null },
): Promise<{ error: PickError; theirTitle?: string | null } | LinkJudgement> {
  const facts = await linkFactsFor(seriesId, { learn: false });
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
    { prefs, health: await healthMap(), lookupMs: LINK_LOOKUP_MS, descriptionNames: await altTitleMatchingOn() },
  );
  if (j.why === 'unavailable' || j.why === 'posting_order') return { error: 'unavailable' };
  if (j.why === 'unreachable' || j.why === 'too_few_listed') return { error: j.why === 'unreachable' ? 'unreachable' : 'too_few' };
  if (j.why === 'title_differs') return { error: 'title_differs', theirTitle: j.theirTitle };
  return toLinkJudgement(j, facts, prefs, pick.cover ?? null) ?? { error: 'not_this_series', theirTitle: j.theirTitle };
}

/** May a run follow this candidate? Only what judgeCandidate would follow itself. Everything else is one at a time. */
export const mayFollow = (c: Pick<LinkCandidateRow, 'verdict'>): boolean => c.verdict === 'ok';

/** The coverage a follow records: the lower of the two shares, as judgeCandidate reports it. */
const coverageOf = (c: Pick<LinkCandidateRow, 'coverage_fwd' | 'coverage_back'>) =>
  c.coverage_fwd == null ? null : Math.min(c.coverage_fwd, c.coverage_back ?? c.coverage_fwd);

/** After a follow: the name the source uses becomes a confirmed other name, and the audit says who and how. */
async function afterFollow(
  c: LinkCandidateRow & { series_id: string; series_title: string },
  userId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  if (c.their_title) await recordAltTitles(c.series_id, [c.their_title], 'confirmed', { sourceId: c.source, userId }).catch(() => 0);
  await logAudit('series.follow_source', {
    userId,
    detail: {
      id: c.series_id, title: c.series_title, source: c.source, sourceSeriesId: c.source_series_id, theirTitle: c.their_title,
      coverage: coverageOf(c), verdict: c.verdict, matchedVia: c.their_name, ...detail,
    },
  });
}

/**
 * Follow the chosen candidates of a batch, one after another, in the background. Only `ok` candidates are
 * run (the route filters; this checks again). Each is written with followConfirmed. The series whose follow
 * went through are handed to the paced refresh queue once the batch is settled, so the page is never held
 * in "Connecting…" by listings.
 */
export async function runLinks(
  batchId: string,
  rows: Array<LinkCandidateRow & { series_id: string; series_title: string }>,
  opts: { userId: string; refresh: (seriesId: string) => Promise<unknown>; paceMs?: number },
): Promise<void> {
  linkingBatches.add(batchId);
  const connected = new Set<string>();
  try {
    for (const c of rows) {
      if (aborted.has(batchId)) return;
      let status: string;
      if (!mayFollow(c)) continue;
      // Not installed, or switched off by the admin: the manual follow route refuses both, and so does this.
      if (!getSource(c.source) || await isDisabled(c.source).catch(() => false)) status = 'unavailable';
      else {
        try {
          const w = await followConfirmed(c.series_id, { source: c.source, sourceSeriesId: c.source_series_id, theirTitle: c.their_title, coverage: coverageOf(c) }, opts.userId);
          status = w === 'inserted' ? 'linked' : w;
          if (w === 'inserted') {
            await afterFollow(c, opts.userId, { via: 'link_batch', batchId });
            connected.add(c.series_id);
          }
        } catch { status = 'error'; }
      }
      await q(`UPDATE link_candidates SET status = $2 WHERE id = $1`, [c.id, status]).catch(() => {});
      await q(`UPDATE link_batches SET ${status === 'linked' ? 'linked = linked + 1' : 'failed = failed + 1'}, updated_at = now() WHERE id = $1`, [batchId]).catch(() => {});
    }
  } finally {
    linkingBatches.delete(batchId);
    aborted.delete(batchId);
    await settleBatch(batchId).catch(() => {});
    queueRefresh(connected, opts.refresh, opts.paceMs);
  }
}

export type SingleOutcome = { ok: true; status: 'linked' } | { ok: false; error: string; status?: string };

/**
 * Follow ONE candidate, from its chapter list, after a person has looked at it: the only way a
 * `numbering_differs` candidate is ever followed. The pair is judged again first (judgeCandidate, health
 * now): the candidate may be weeks old, and what a person confirms must still be a name match today.
 */
export async function followSingle(candidateId: string, userId: string, opts: { refresh: (seriesId: string) => Promise<unknown> }): Promise<SingleOutcome> {
  const c = await one<LinkCandidateRow & { series_id: string; series_title: string; batch_id: string; batch_state: string }>(
    `SELECT c.*, i.series_id, i.title AS series_title, i.batch_id, b.state AS batch_state
       FROM link_candidates c JOIN link_items i ON i.id = c.item_id JOIN link_batches b ON b.id = i.batch_id WHERE c.id = $1`, [candidateId]);
  if (!c) return { ok: false, error: 'not_found' };
  if (c.status) return { ok: false, error: 'closed', status: c.status };
  if (c.batch_state === 'searching' || c.batch_state === 'linking') return { ok: false, error: 'busy' };
  const facts = await linkFactsFor(c.series_id, { learn: false });
  if (!facts) return { ok: false, error: 'gone' };
  if (facts.numbering === 'posting_order') return { ok: false, error: 'posting_order' };
  if (!getSource(c.source) || await isDisabled(c.source).catch(() => false)) return { ok: false, error: 'unavailable' };
  const prefs = await effectivePrefsFor(await readSeriesPrefs(c.series_id), 0);
  const j = await judgeCandidate(
    { title: facts.names[0] ?? facts.title, altTitles: facts.names.slice(1), numbers: facts.numbers },
    { source: c.source, sourceId: c.source_series_id },
    { prefs, health: await healthMap(), lookupMs: LINK_LOOKUP_MS, descriptionNames: await altTitleMatchingOn() },
  );
  if (j.why === 'unreachable') return { ok: false, error: 'unreachable' };
  if (j.why === 'unavailable') return { ok: false, error: 'unavailable' };
  const lj = toLinkJudgement(j, facts, prefs);
  if (!lj) return { ok: false, error: 'changed' };
  const w = await followConfirmed(c.series_id, { source: c.source, sourceSeriesId: c.source_series_id, theirTitle: j.theirTitle, coverage: j.coverage }, userId);
  const status = w === 'inserted' ? 'linked' : w;
  await q(`UPDATE link_candidates SET status = $2, verdict = $3 WHERE id = $1`, [c.id, status, lj.verdict]).catch(() => {});
  await q(`UPDATE link_batches SET ${status === 'linked' ? 'linked = linked + 1' : 'failed = failed + 1'}, updated_at = now() WHERE id = $1`, [c.batch_id]).catch(() => {});
  if (w !== 'inserted') return { ok: false, error: status, status };
  await afterFollow({ ...c, their_title: j.theirTitle, verdict: lj.verdict }, userId, { via: 'link_preview', batchId: c.batch_id, override: lj.verdict !== 'ok' });
  queueRefresh([c.series_id], opts.refresh);
  return { ok: true, status: 'linked' };
}

/**
 * Put a batch back in the state its rows say: `linking` only while this process is running it, `done` once
 * no candidate is left unrun, otherwise `review`. Called at the end of a run and on every GET, so a batch a
 * restart stranded mid-run reads as reviewable again rather than "Linking…" for ever.
 */
export async function settleBatch(batchId: string): Promise<LinkBatchRow | null> {
  if (linkingBatches.has(batchId) && !aborted.has(batchId)) return null;
  return one<LinkBatchRow>(
    `UPDATE link_batches SET updated_at = now(), state = CASE
        WHEN EXISTS (SELECT 1 FROM link_candidates c JOIN link_items i ON i.id = c.item_id
                      WHERE i.batch_id = $1 AND c.status IS NULL) THEN 'review'
        ELSE 'done' END
      WHERE id = $1 AND state = 'linking' RETURNING *`, [batchId]);
}

// ---- the refreshes after a run ------------------------------------------------------------------------------

/**
 * The listings to refresh after follows, one series at a time, LINK_PACE_MS apart: an unpaced burst of
 * updateSeries against one site is what earned this install its 75-minute cooldowns (bulkNewest's note).
 * Dropped, not deferred, while a sweep or a repair runs or on shutdown: the sweep reads every followed
 * source anyway, so the refresh would only be the same listing asked twice.
 */
const refreshQueue: string[] = [];
let draining = false;
export function queueRefresh(ids: Iterable<string>, refresh: (id: string) => Promise<unknown>, paceMs = LINK_PACE_MS): void {
  for (const id of ids) if (!refreshQueue.includes(id)) refreshQueue.push(id);
  if (draining || !refreshQueue.length) return;
  draining = true;
  void (async () => {
    try {
      while (refreshQueue.length) {
        if (runtime.stopping || runtime.updating || runtime.repairing) { refreshQueue.length = 0; break; }
        const id = refreshQueue.shift()!;
        await refresh(id).catch(() => {});
        if (refreshQueue.length) await sleep(paceMs);
      }
    } finally { draining = false; }
  })();
}
/** Exposed for tests. */
export const pendingRefreshes = () => [...refreshQueue];

/** Drop batches nobody will come back to; daily from server.ts, the import sweep's rule. */
export async function sweepLinkBatches(): Promise<{ removed: number }> {
  const rows = await q<{ id: string }>(
    `DELETE FROM link_batches
      WHERE (state = 'done' AND updated_at < now() - make_interval(days => $1))
         OR (state IN ('searching','review','linking') AND updated_at < now() - make_interval(days => $2))
      RETURNING id`,
    [SWEEP_DONE_DAYS, SWEEP_OPEN_DAYS],
  );
  return { removed: rows.length };
}

/** Exposed for tests: the in-memory guards are process-global. */
export function _resetLinkState(): void {
  searchingBatch = null;
  waitingOn = null;
  linkingBatches.clear();
  aborted.clear();
  refreshQueue.length = 0;
}
