/**
 * Connect sources: the library's bulk way to follow other sources for many series at once (v0.49.0).
 *
 * A series follows its primary source and up to MAX_FOLLOWERS more (series_sources, lib/autoFollow.ts), and
 * the sweep takes a chapter from whichever of them has it -- so a series whose primary is down keeps
 * updating from a follower. Until now a follower was found one series at a time (Find missing chapters) or
 * automatically by the series' ONE title, which misses every site that files the work under another name.
 *
 * This searches every source for every name a series goes by (lib/altTitles.ts), judges each hit, and
 * hands the admin a review -- the import review's shape (routes/admin.ts, import_batches) -- in which
 * nothing is followed until a person ticks it. The judgement:
 *
 *  - NAME. One of our names must EQUAL (normalised) the candidate's title or one of the names in its own
 *    description (`exactNameMatch`). Never containment, never word overlap: that is what a sequel shares
 *    with its parent. A hit whose name does not match is not kept at all.
 *  - NUMBERING, both ways. The candidate must list MIN_COVERAGE of our numbers AND we must list
 *    MIN_COVERAGE of its numbers -- the sequel guard of lib/autoFollow.ts judgeCandidate. The one-way
 *    shortcut applies only to a main-title-to-main-title match on a listing of ONE_WAY_MIN_LISTED or more,
 *    exactly as there; a match through an other name is always measured both ways.
 *
 * A name match whose numbering does not line up is still shown, as a warning the admin may override: the
 * same work numbered by volume, or a site that restarted its numbering per season, is followable by a
 * person who has looked -- and the override is written to the audit log as one.
 *
 * Nothing here downloads anything. A follow only changes where the sweep LOOKS; the listing is refreshed
 * once so the chapters the new source has show up on the series page at once.
 */
import { q, one, tx } from './db';
import { getSource, listSources } from './sources';
import type { SourceAdapter, SourceChapter, SourceSeries } from './sources/types';
import { budgetFor } from './sources/budget';
import { healthAll, type SourceHealth } from './sourceHealth';
import { searchAll } from './searchAll';
import { chooseReleases, type ReleasePrefs } from './releases';
import { effectivePrefsFor, readSeriesPrefs } from './scanlatorPrefs';
import { assess, MIN_HAVE, MIN_COVERAGE } from './fill';
import { bounded, MAX_FOLLOWERS, ONE_WAY_MIN_LISTED, MIN_TRY_MS } from './autoFollow';
import { normTitle } from './titleMatch';
import { altTitleMatchingOn, altTitlesFor, exactNameMatch, learnAltTitles, parseAltTitles, recordAltTitles } from './altTitles';
import { logAudit } from './audit';

/** Series searched at once within a batch. Each one fans out to every source, so two is plenty. */
export const LINK_SERIES_CONCURRENCY = Math.max(1, Number(process.env.LINK_SERIES_CONCURRENCY || 2));
/** Candidate judgements (getSeries + listChapters) at once, across the whole batch. */
export const LINK_JUDGE_CONCURRENCY = Math.max(1, Number(process.env.LINK_JUDGE_CONCURRENCY || 3));
/** Names searched per series: the title and up to three others, as the import's RESOLVE_ALT_TITLES. */
export const LINK_TERMS_MAX = 4;
/** Search hits judged per source: every exact-name hit first, then the source's own top hit. */
export const LINK_JUDGE_PER_SOURCE = 2;
/** One series' whole search-and-judge budget. What is not asked by then is simply not in the review. */
export const LINK_SERIES_WALL_MS = Math.max(10_000, Number(process.env.LINK_SERIES_WALL_MS || 180_000));
/** One judgement's two lookups, before budgetFor raises it for a solver-fronted source. */
export const LINK_LOOKUP_MS = Math.max(1_000, Number(process.env.LINK_LOOKUP_MS || 20_000));
/** How long finished and open batches are kept (the import sweep's rule, routes/admin.ts). */
const SWEEP_DONE_DAYS = 7;
const SWEEP_OPEN_DAYS = 30;

export type LinkVerdict = 'ok' | 'numbering_differs' | 'too_few' | 'title_differs';

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
  verdict: LinkVerdict | 'unreachable';
}

// ---- the judgement pool ---------------------------------------------------------------------------------
// Process-wide, like the hunt's slots (lib/sourceHunt.ts): two batches -- or one batch and a manual pick --
// never judge more than LINK_JUDGE_CONCURRENCY candidates at once between them.
let judging = 0;
const judgeQueue: Array<() => void> = [];
const takeJudgeSlot = async () => { if (judging >= LINK_JUDGE_CONCURRENCY) await new Promise<void>((r) => judgeQueue.push(r)); judging++; };
const freeJudgeSlot = () => { judging--; judgeQueue.shift()?.(); };

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
 * The series as the search sees it. Null for a series that is gone, removed or merged away: following
 * onto a row nobody can open is the thing followJudged refuses too.
 *
 * With the switch on, the PRIMARY's own description is read for names first (and kept): that is where the
 * other names of a series added before this feature live, and it costs one lookup of a source the series
 * already follows.
 */
export async function linkFactsFor(seriesId: string, opts: { learn?: boolean } = {}): Promise<LinkFacts | null> {
  const s = await one<{ id: string; title: string; shown: string; source_id: string | null; source_series_id: string | null; deleted_at: string | null; merged_into: string | null }>(
    `SELECT s.id, s.title, COALESCE(o.title, s.title) AS shown, s.source_id, s.source_series_id, s.deleted_at, s.merged_into
       FROM lib_series s LEFT JOIN series_overrides o ON o.series_id = s.id WHERE s.id = $1`, [seriesId]).catch(() => null);
  if (!s || s.deleted_at || s.merged_into) return null;
  const on = await altTitleMatchingOn();
  let learned: string[] = [];
  const primary = s.source_id ? getSource(s.source_id) : null;
  if (on && opts.learn !== false && primary && s.source_series_id) {
    try {
      const own = await bounded(primary.getSeries(s.source_series_id), budgetFor(primary, LINK_LOOKUP_MS));
      learned = await learnAltTitles(seriesId, own?.summary, primary.id);
    } catch { /* the primary is down -- which is often why this is being run; its stored names still count */ }
  }
  const stored = await altTitlesFor(seriesId, { includeDescription: on });
  const numbers = (await q<{ number: number }>(
    `SELECT number FROM series_listing WHERE series_id = $1
     UNION SELECT COALESCE(bo.number, b.number) FROM lib_books b LEFT JOIN book_overrides bo ON bo.book_id = b.id WHERE b.series_id = $1`,
    [seriesId]).catch(() => []))
    .map((r) => Number(r.number)).filter((n) => Number.isFinite(n));
  const followers = (await q<{ source_id: string }>('SELECT source_id FROM series_sources WHERE series_id = $1', [seriesId]).catch(() => []))
    .map((r) => r.source_id).filter((id) => id !== s.source_id);
  return {
    seriesId,
    title: s.shown,
    names: distinctNames([s.shown, s.title, ...stored, ...learned]),
    numbers: [...new Set(numbers)],
    primary: s.source_id,
    followers,
  };
}

/**
 * Judge one candidate against a series. Reads the source, decides, writes nothing. Every failure is a
 * value: a source that threw or ran out of time is `unreachable`, never "lists nothing".
 *
 * `theirNames` is the candidate's title and, with the switch on, the names in its own description -- the
 * half of the rule that finds "Only I Level Up" when its page lists "Solo Leveling" among its names.
 */
export async function judgeLink(
  facts: Pick<LinkFacts, 'names' | 'numbers'>,
  cand: { source: string; sourceSeriesId: string },
  opts: { prefs: ReleasePrefs; readDescriptions: boolean; lookupMs?: number },
): Promise<LinkJudgement> {
  const base: LinkJudgement = {
    source: cand.source, sourceSeriesId: cand.sourceSeriesId, theirTitle: null, cover: null,
    ourName: null, theirName: null, coverageFwd: null, coverageBack: null, verdict: 'unreachable',
  };
  const src = getSource(cand.source);
  if (!src) return base;
  let series: SourceSeries | null;
  let raw: SourceChapter[];
  await takeJudgeSlot();
  try {
    [series, raw] = await bounded(
      Promise.all([src.getSeries(cand.sourceSeriesId), src.listChapters(cand.sourceSeriesId)]),
      budgetFor(src, opts.lookupMs ?? LINK_LOOKUP_MS),
    );
  } catch {
    return base;
  } finally { freeJudgeSlot(); }
  const theirTitle = series?.title?.trim() || null;
  // No title is no identity: the add path calls the same answer transient (`no_title`), and so does this.
  if (!theirTitle) return base;
  const theirNames = [theirTitle, ...(opts.readDescriptions ? parseAltTitles(series?.summary) : [])];
  const match = exactNameMatch(facts.names, theirNames);
  const out: LinkJudgement = { ...base, theirTitle, cover: series?.coverUrl ?? null, ourName: match?.ours ?? null, theirName: match?.theirs ?? null };

  const nums = chooseReleases(raw ?? [], opts.prefs).releases.map((c) => c.number);
  if (facts.numbers.length >= MIN_HAVE && nums.length) {
    out.coverageFwd = Math.round(assess(facts.numbers, nums).coverage * 100) / 100;
    out.coverageBack = Math.round(assess(nums, facts.numbers).coverage * 100) / 100;
  }
  if (!match) return { ...out, verdict: 'title_differs' };
  // Too little to measure on our side: nothing can be said about the numbering, so a person must decide.
  if (facts.numbers.length < MIN_HAVE) return { ...out, verdict: 'too_few' };
  if (!nums.length || out.coverageFwd == null || out.coverageBack == null) return { ...out, verdict: 'numbering_differs' };
  const oneWay = match.main && facts.numbers.length >= ONE_WAY_MIN_LISTED;
  const lines = out.coverageFwd >= MIN_COVERAGE && (oneWay || out.coverageBack >= MIN_COVERAGE);
  return { ...out, verdict: lines ? 'ok' : 'numbering_differs' };
}

/**
 * A candidate an admin picked by hand from the search sheet, judged by the same rule as a found one and
 * saved as `manual`. The primary and the sources already followed are refused before any lookup. Names are
 * the stored ones: the primary's description was read when the batch searched, and a person waiting on a
 * pick should not pay for a second read.
 */
export async function judgeManualPick(
  seriesId: string,
  pick: { source: string; sourceSeriesId: string },
): Promise<{ error: 'gone' | 'already_followed' | 'unknown_source' } | LinkJudgement> {
  const facts = await linkFactsFor(seriesId, { learn: false });
  if (!facts) return { error: 'gone' };
  if (pick.source === facts.primary || facts.followers.includes(pick.source)) return { error: 'already_followed' };
  if (!getSource(pick.source)) return { error: 'unknown_source' };
  const prefs = await effectivePrefsFor(await readSeriesPrefs(seriesId), 0);
  return judgeLink(facts, pick, { prefs, readDescriptions: await altTitleMatchingOn() });
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
 * Search every source this series does not already follow for every name it goes by, judge the hits, and
 * answer the best judgement per source. A source is asked a later name only while no hit on it has
 * matched by name: once "Only I Level Up" is found on a site, searching that site for "Solo Leveling" too
 * is load for nothing.
 */
export async function findLinks(facts: LinkFacts, opts: { wallMs?: number; health?: Map<string, SourceHealth>; sources?: SourceAdapter[] } = {}): Promise<{
  found: LinkJudgement[]; asked: number; unreachable: number;
}> {
  const deadline = Date.now() + (opts.wallMs ?? LINK_SERIES_WALL_MS);
  const health = opts.health ?? new Map((await healthAll().catch(() => [])).map((h) => [h.source_id, h]));
  const skip = new Set([...(facts.primary ? [facts.primary] : []), ...facts.followers]);
  const all = (opts.sources ?? listSources()).filter((s) => !skip.has(s.id));
  const readDescriptions = await altTitleMatchingOn();
  const prefs = await effectivePrefsFor(await readSeriesPrefs(facts.seriesId), 0);

  const best = new Map<string, LinkJudgement>();
  const judged = new Set<string>();
  const answered = new Set<string>();
  const failed = new Set<string>();
  const rank = (j: LinkJudgement) => (j.verdict === 'ok' ? 3 : j.verdict === 'numbering_differs' ? 2 : j.verdict === 'too_few' ? 1 : 0);

  for (const term of facts.names.slice(0, LINK_TERMS_MAX)) {
    const ask = all.filter((s) => !best.has(s.id) || rank(best.get(s.id)!) < 3);
    if (!ask.length || Date.now() >= deadline - MIN_TRY_MS) break;
    // searchAll answers early (a grace after the first hit) and keeps filling its entry; asked again, it
    // answers from the entry and waits for the rest -- so this loops until every source settled or the wall.
    let ans = await searchAll(term, ask, { waitMs: Math.max(0, deadline - Date.now()), health });
    while (ans.pending > 0 && Date.now() < deadline - MIN_TRY_MS) {
      ans = await searchAll(term, ask, { waitMs: Math.max(0, deadline - Date.now()), health });
    }
    const keys = new Set(facts.names.map((n) => normTitle(n)).filter(Boolean));
    const work: Array<{ source: string; hit: SourceSeries; exact: boolean }> = [];
    for (const [id, cell] of ans.per) {
      if (cell.state === 'skipped' || cell.state === 'pending') continue;
      if (cell.state === 'timeout' || cell.state === 'failed') { failed.add(id); continue; }
      answered.add(id);
      for (const hit of hitsToJudge(cell.items, facts.names)) {
        const key = `${id}\u0000${hit.sourceId}`;
        if (judged.has(key)) continue;
        judged.add(key);
        work.push({ source: id, hit, exact: keys.has(normTitle(hit.title)) });
      }
    }
    // Exact-name hits first, across every source: under the wall, the likeliest matches are the ones judged.
    work.sort((x, y) => Number(y.exact) - Number(x.exact));
    await Promise.all(work.map(async ({ source, hit }) => {
      const left = deadline - Date.now();
      if (left < MIN_TRY_MS) return;
      if (best.has(source) && rank(best.get(source)!) === 3) return;
      const j = await bounded(judgeLink(facts, { source, sourceSeriesId: hit.sourceId }, { prefs, readDescriptions }), left)
        .catch(() => null);
      if (!j || j.verdict === 'unreachable' || j.verdict === 'title_differs') return;
      if (!j.cover && hit.coverUrl) j.cover = hit.coverUrl;
      const prev = best.get(source);
      if (!prev || rank(j) > rank(prev)) best.set(source, j);
    }));
  }
  const unreachable = [...failed].filter((id) => !answered.has(id)).length;
  return { found: [...best.values()], asked: answered.size + unreachable, unreachable };
}

// ---- following -------------------------------------------------------------------------------------------

/**
 * Follow a confirmed candidate: one transaction, the series row locked, the INSERT conditional on the
 * follower count -- followJudged's shape (lib/autoFollow.ts), with the admin as `added_by`, because a
 * person confirmed it. The series' own primary is refused: following it would list every chapter twice.
 */
export async function followConfirmed(
  seriesId: string,
  c: { source: string; sourceSeriesId: string; theirTitle: string | null; coverage: number | null },
  userId: string,
): Promise<'inserted' | 'cap' | 'gone' | 'primary'> {
  return tx(async (qq) => {
    const row = (await qq<{ source_id: string | null; deleted_at: string | null; merged_into: string | null }>(
      'SELECT source_id, deleted_at, merged_into FROM lib_series WHERE id = $1 FOR UPDATE', [seriesId]))[0];
    if (!row || row.deleted_at || row.merged_into) return 'gone';
    if (row.source_id === c.source) return 'primary';
    const r = await qq<{ source_id: string }>(
      `INSERT INTO series_sources (series_id, source_id, source_series_id, title, coverage, added_by)
       SELECT $1::text, $2::text, $3::text, $4::text, $5::real, $7::uuid
        WHERE (SELECT count(*) FROM series_sources WHERE series_id = $1 AND source_id <> $2) < $6::int
       ON CONFLICT (series_id, source_id) DO UPDATE SET source_series_id = EXCLUDED.source_series_id,
         title = EXCLUDED.title, coverage = EXCLUDED.coverage,
         added_by = COALESCE(EXCLUDED.added_by, series_sources.added_by)
       RETURNING source_id`,
      [seriesId, c.source, c.sourceSeriesId, c.theirTitle, c.coverage, MAX_FOLLOWERS, userId]);
    return r.length ? 'inserted' : 'cap';
  });
}

// ---- batches ---------------------------------------------------------------------------------------------

export interface LinkBatchRow {
  id: string; user_id: string; state: 'searching' | 'review' | 'linking' | 'done';
  total: number; searched: number; linked: number; failed: number; created_at: string; updated_at: string;
}
export interface LinkItemRow {
  id: string; batch_id: string; ord: number; series_id: string; title: string; names: string[];
  state: 'pending' | 'done' | 'error'; asked: number; unreachable: number;
}
export interface LinkCandidateRow {
  id: string; item_id: string; source: string; source_series_id: string; their_title: string | null; cover: string | null;
  our_name: string | null; their_name: string | null; coverage_fwd: number | null; coverage_back: number | null;
  verdict: LinkVerdict; manual: boolean; status: string | null;
}

/**
 * The batch whose search loop THIS process is running, or 'pending' while a POST is creating one. One at a
 * time server-wide, for the import's reason: two searches at once double the outbound rate to every source.
 */
let searchingBatch: string | null = null;
const linkingBatches = new Set<string>();
const aborted = new Set<string>();

export const linkSearchBusy = () => searchingBatch !== null;
export const isSearching = (id: string) => searchingBatch === id;
export const isLinking = (id: string) => linkingBatches.has(id);
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

/** Create a batch over these series, in the order given. Returns null when none of them is a live series. */
export async function createLinkBatch(userId: string, seriesIds: string[]): Promise<{ id: string; total: number; skipped: string[] } | null> {
  const ids = [...new Set(seriesIds)];
  const rows = await q<{ id: string; title: string; deleted_at: string | null; merged_into: string | null }>(
    `SELECT s.id, COALESCE(o.title, s.title) AS title, s.deleted_at, s.merged_into
       FROM lib_series s LEFT JOIN series_overrides o ON o.series_id = s.id WHERE s.id = ANY($1::text[])`, [ids]);
  const live = new Map(rows.filter((r) => !r.deleted_at && !r.merged_into).map((r) => [r.id, r.title]));
  const kept = ids.filter((id) => live.has(id));
  if (!kept.length) return null;
  const batch = await one<{ id: string }>(
    `INSERT INTO link_batches (user_id, state, total) VALUES ($1, 'searching', $2) RETURNING id`, [userId, kept.length]);
  await q(
    `INSERT INTO link_items (batch_id, ord, series_id, title)
     SELECT $1, o, s, t FROM unnest($2::int[], $3::text[], $4::text[]) AS x(o, s, t)`,
    [batch!.id, kept.map((_, i) => i), kept, kept.map((id) => live.get(id)!)],
  );
  return { id: batch!.id, total: kept.length, skipped: ids.filter((id) => !live.has(id)) };
}

/**
 * Search every pending item of a batch, LINK_SERIES_CONCURRENCY at a time, writing each series' candidates
 * as it finishes so the page fills in under its poll. The caller must hold the search slot (claimSearch);
 * it is released here.
 */
export async function searchBatch(batchId: string): Promise<void> {
  searchingBatch = batchId;
  try {
    const items = await q<LinkItemRow>(`SELECT * FROM link_items WHERE batch_id = $1 AND state = 'pending' ORDER BY ord`, [batchId]);
    await q(`UPDATE link_batches SET searched = total - $2, updated_at = now() WHERE id = $1`, [batchId, items.length]).catch(() => {});
    const health = new Map((await healthAll().catch(() => [])).map((h) => [h.source_id, h]));
    let next = 0;
    const worker = async () => {
      for (;;) {
        if (aborted.has(batchId)) return;
        const item = items[next++];
        if (!item) return;
        try {
          const facts = await linkFactsFor(item.series_id);
          if (!facts) {
            await q(`UPDATE link_items SET state = 'error' WHERE id = $1`, [item.id]);
          } else {
            const r = await findLinks(facts, { health });
            if (aborted.has(batchId)) return;
            for (const j of r.found) await saveCandidate(item.id, j, false);
            await q(`UPDATE link_items SET state = 'done', names = $2, asked = $3, unreachable = $4 WHERE id = $1`,
              [item.id, facts.names, r.asked, r.unreachable]);
          }
        } catch {
          await q(`UPDATE link_items SET state = 'error' WHERE id = $1`, [item.id]).catch(() => {});
        }
        await q(`UPDATE link_batches SET searched = searched + 1, updated_at = now() WHERE id = $1`, [batchId]).catch(() => {});
      }
    };
    await Promise.all(Array.from({ length: Math.min(LINK_SERIES_CONCURRENCY, items.length) || 1 }, worker));
    await q(`UPDATE link_batches SET state = 'review', updated_at = now() WHERE id = $1 AND state = 'searching'`, [batchId]).catch(() => {});
  } finally {
    releaseSearch(batchId);
    aborted.delete(batchId);
  }
}

/** Write (or refresh) one candidate row. A manual pick stays manual when the search finds it again. */
export async function saveCandidate(itemId: string, j: LinkJudgement, manual: boolean): Promise<LinkCandidateRow | null> {
  if (j.verdict === 'unreachable') return null;
  return one<LinkCandidateRow>(
    `INSERT INTO link_candidates (item_id, source, source_series_id, their_title, cover, our_name, their_name, coverage_fwd, coverage_back, verdict, manual)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (item_id, source) DO UPDATE SET source_series_id = EXCLUDED.source_series_id, their_title = EXCLUDED.their_title,
       cover = EXCLUDED.cover, our_name = EXCLUDED.our_name, their_name = EXCLUDED.their_name, coverage_fwd = EXCLUDED.coverage_fwd,
       coverage_back = EXCLUDED.coverage_back, verdict = EXCLUDED.verdict, manual = link_candidates.manual OR EXCLUDED.manual, status = NULL
     RETURNING *`,
    [itemId, j.source, j.sourceSeriesId, j.theirTitle, j.cover, j.ourName, j.theirName, j.coverageFwd, j.coverageBack, j.verdict, manual],
  );
}

/**
 * May this candidate be followed on this request? `ok` always; a name match whose numbering does not line
 * up (or cannot be measured) only with the admin's explicit override; a candidate whose NAME does not
 * match only when a person picked it by hand AND overrode -- the search never offers one.
 */
export function mayFollow(c: Pick<LinkCandidateRow, 'verdict' | 'manual'>, override: boolean): boolean {
  if (c.verdict === 'ok') return true;
  if (c.verdict === 'numbering_differs' || c.verdict === 'too_few') return override;
  return c.manual && override;
}

/**
 * Follow the chosen candidates of a batch, one after another, in the background. Each is re-read under
 * the batch (a candidate from another batch, or one already run, is left out), checked against
 * `mayFollow`, and written with followConfirmed. The name the source uses is kept as a confirmed other
 * name of the series: a person has now said it is this work.
 */
export async function runLinks(
  batchId: string,
  rows: Array<LinkCandidateRow & { series_id: string; series_title: string }>,
  opts: { userId: string; override: boolean; refresh: (seriesId: string) => void },
): Promise<void> {
  linkingBatches.add(batchId);
  const refreshed = new Set<string>();
  try {
    for (const c of rows) {
      if (aborted.has(batchId)) return;
      let status: string;
      if (!mayFollow(c, opts.override)) status = 'not_confirmed';
      else if (!getSource(c.source)) status = 'unavailable';
      else {
        try {
          const coverage = c.coverage_fwd == null ? null : Math.min(c.coverage_fwd, c.coverage_back ?? c.coverage_fwd);
          const w = await followConfirmed(c.series_id, { source: c.source, sourceSeriesId: c.source_series_id, theirTitle: c.their_title, coverage }, opts.userId);
          status = w === 'inserted' ? 'linked' : w;
          if (w === 'inserted') {
            if (c.their_title) await recordAltTitles(c.series_id, [c.their_title], 'confirmed', { sourceId: c.source, userId: opts.userId }).catch(() => 0);
            await logAudit('series.follow_source', {
              userId: opts.userId,
              detail: {
                id: c.series_id, title: c.series_title, source: c.source, sourceSeriesId: c.source_series_id, theirTitle: c.their_title,
                coverage, via: 'link_batch', batchId, verdict: c.verdict, matchedVia: c.their_name, override: c.verdict !== 'ok',
              },
            });
            refreshed.add(c.series_id);
          }
        } catch { status = 'error'; }
      }
      await q(`UPDATE link_candidates SET status = $2 WHERE id = $1`, [c.id, status]).catch(() => {});
      await q(`UPDATE link_batches SET ${status === 'linked' ? 'linked = linked + 1' : 'failed = failed + 1'}, updated_at = now() WHERE id = $1`, [batchId]).catch(() => {});
    }
  } finally {
    // One listing refresh per series, after all its follows: the chapters the new sources carry show up on
    // the series page now rather than at the next sweep (the manual follow route does the same).
    for (const id of refreshed) opts.refresh(id);
    linkingBatches.delete(batchId);
    aborted.delete(batchId);
    await settleBatch(batchId).catch(() => {});
  }
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
  linkingBatches.clear();
  aborted.clear();
  judging = 0;
  judgeQueue.length = 0;
}
