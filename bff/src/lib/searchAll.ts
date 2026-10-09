// Search every source the viewer may reach, and answer before the slow ones do.
//
// The Discover search used to be one `Promise.all` over every registered source with a 20-second budget
// each -- 90 seconds for a source behind Cloudflare -- and the page showed skeletons until the LAST one
// settled. Nothing was cached and nothing was de-duplicated, so the same title typed twice was every site
// asked twice, and a source serving out a cooldown was asked anyway and burned its whole budget. "Takes
// forever" was the accurate description.
//
// Now one search is an ENTRY, keyed by the normalised term, that fills in as sources settle. A caller waits
// for the earlier of: everything it asked for settled, its own `waitMs`, or SEARCH_GRACE_MS after the first
// source with results -- and gets the state of every source it asked for, so the client can show "5 of 12
// answered, still asking …" and poll for the rest. Work that outlives the caller continues into the entry;
// the next call for the same term, from anyone, reads it.
//
// ⚠️ The entry is the UNION across viewers and every answer is filtered to the caller's own `ask` set.
// A capped account's set never contains an adult source, so it can neither start that source nor read
// what an uncapped viewer's search got from it. The cache holds raw per-source lists (what the SITE said,
// viewer-independent) and nothing about who asked -- the filter happens on every read, never on write.
import type { SourceAdapter, SourceSeries } from './sources/types';
import { budgetFor } from './sources/budget';
import { SOLVER_CONCURRENCY } from './sources/flaresolverr';
import { scanOrder } from './scanOrder';
import { classify, noteStage, reportFail, reportSlow, reportTimely, type SourceHealth } from './sourceHealth';
import { canonLang } from './lang';

/** An env knob: a finite number at or above `min`, else the default. An empty string is unset. */
const knob = (name: string, def: number, min = 0): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  return Number.isFinite(v) && v >= min ? v : def;
};

/** The most a first answer waits: the route clamps `wait` to this, so nobody holds a request longer. */
export const SEARCH_FIRST_ANSWER_MS = knob('SEARCH_FIRST_ANSWER_MS', 6000);
/**
 * Once ONE source has results, how much longer to wait for the others before answering. Long enough that
 * the two or three sources that answer in a second or two land in the first paint; short enough that a
 * fast source is never held hostage by a slow one.
 */
export const SEARCH_GRACE_MS = knob('SEARCH_GRACE_MS', 1500);
/** One source's budget for a search, before budgetFor raises it for a source behind the solver. */
export const SEARCH_SOURCE_MS = knob('SEARCH_SOURCE_MS', 20_000, 100);
/**
 * How many searches run at once PER LANE (solver-fronted sources, and the rest -- see the pool below),
 * across every term and every viewer. The same knob as the fill scan's (routes/sources.ts
 * SCAN_CONCURRENCY) unless set on its own, and both default to the solver's slot count: a Cloudflare
 * search that cannot get a solver slot only burns its budget in the solver's queue.
 */
export const SEARCH_CONCURRENCY = Math.max(1, knob('SEARCH_CONCURRENCY', knob('SCAN_CONCURRENCY', SOLVER_CONCURRENCY, 1), 1));
/** How long an entry answers repeat searches before the sources are asked again. */
export const SEARCH_TTL_MS = knob('SEARCH_TTL_MS', 300_000, 1000);
/** How many entries are kept; the oldest goes first. A bound on memory, not a policy. */
export const SEARCH_CACHE_MAX = Math.max(1, knob('SEARCH_CACHE_MAX', 50, 1));
/** Results kept per source, as the old fan-out sliced them. */
export const SEARCH_PER_SOURCE = 12;

export type SearchState = 'ok' | 'empty' | 'timeout' | 'failed' | 'skipped' | 'pending';
export interface SearchSourceLine { id: string; name: string; state: SearchState; ms?: number; why?: 'disabled' | 'cooldown' }
export interface SearchAnswer {
  /** Only the sources the caller asked for, each with what it said; `items` is at most SEARCH_PER_SOURCE long. */
  per: Map<string, { state: SearchState; items: SourceSeries[] }>;
  /** The same sources in the order they were asked, as lines for a progress indicator. */
  sources: SearchSourceLine[];
  /** Of the caller's sources, how many are still being asked. */
  pending: number;
  /** Of the caller's sources, how many were (or are being) asked at all -- everything but the skipped. */
  asked: number;
  /** When the entry these answers come from was started. */
  startedAt: number;
}

/**
 * The route's `norm` (routes/sources.ts), copied rather than imported: this file must not import a route
 * module, and a test holds the two against each other on real titles so they cannot drift apart.
 */
export const normTerm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * The cache key for a term.
 *
 * ⚠️ Not `normTerm` alone: it strips everything that is not a-z0-9, so every Japanese, Korean or Cyrillic
 * title normalises to the EMPTY string and would share one entry -- the first such search would answer
 * every later one. Those fall back to the trimmed, lower-cased spelling.
 */
const keyOf = (term: string): string => normTerm(term) || term.trim().toLowerCase();

interface Cell { state: SearchState; items: SourceSeries[]; ms?: number; settledAt?: number }
interface Entry { startedAt: number; per: Map<string, Cell>; waiters: Set<() => void>; cancelled: boolean }
const entries = new Map<string, Entry>();

// ---- the pool ----------------------------------------------------------------------------------------
// A slot is held BEFORE a search's clock starts, as the fill scan holds one, so the budget measures the
// source and not the queue. The queue is FIFO, so sources are asked in the order calls enqueued them.
// A freed slot is handed straight to the next waiter rather than released and re-taken: the release-then-
// increment shape lets a newcomer slip in between the two steps and run one over the limit.
//
// Two lanes, each SEARCH_CONCURRENCY wide: one for sources behind the solver, one for the rest. The pool
// exists because a solver-fronted search that cannot get a solver slot burns its budget in the solver's
// queue -- a fact about the solver, not about a plain site that answers in a second. With one lane, the
// four solver sources the ask order puts first (packs pin no language, so they lead) held every slot for
// their solves, and the plain sources behind them were still queued when the first answer went out: a
// six-second first paint with nothing on it, which is the complaint this file exists to end.
class Lane {
  private inFlight = 0;
  private waiting: Array<{ entry: Entry; go: (acquired: boolean) => void }> = [];
  constructor(private readonly width: number) {}
  take(entry: Entry): Promise<boolean> {
    return new Promise<boolean>((go) => {
      if (entry.cancelled) go(false);
      else if (this.inFlight < this.width) { this.inFlight++; go(true); }
      else this.waiting.push({ entry, go });
    });
  }
  /** Remove queued work for an entry that no longer has a cache owner. Active requests remain bounded. */
  cancel(entry: Entry): void {
    const keep: typeof this.waiting = [];
    for (const ticket of this.waiting) {
      if (ticket.entry === entry) ticket.go(false);
      else keep.push(ticket);
    }
    this.waiting = keep;
  }
  free(): void {
    for (;;) {
      const next = this.waiting.shift();
      if (!next) { this.inFlight--; return; }
      if (next.entry.cancelled) { next.go(false); continue; }
      // Transfer this slot directly; `inFlight` is unchanged.
      next.go(true);
      return;
    }
  }
}
const lanes = { solver: new Lane(SEARCH_CONCURRENCY), plain: new Lane(SEARCH_CONCURRENCY) };
const laneFor = (src: SourceAdapter): Lane => (src.requiresCloudflare ? lanes.solver : lanes.plain);

/**
 * `withTimeout` (lib/sources) with its timer CLEARED once the race settles, as lib/autoFollow.ts does. The
 * shared one leaves its timer armed until it fires; at this file's 90-second solver budget, one per source
 * per search would hold a stopping process for a minute and a half. Tagged exactly as the shared one is,
 * because `selfTimeout` is what separates "we gave up" from "the site refused" below.
 */
function bounded<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const clock = new Promise<T>((_, rej) => {
    timer = setTimeout(() => rej(Object.assign(new Error(`timeout after ${ms}ms`), { selfTimeout: true, ms })), ms);
  });
  return Promise.race([p, clock]).finally(() => clearTimeout(timer));
}

/** Every call waiting on this entry re-checks its own conditions; a settled source may be the last one it needed. */
function wake(entry: Entry): void {
  const ws = [...entry.waiters];
  entry.waiters.clear();
  for (const w of ws) w();
}

/** Cancel everything that has not acquired a lane yet and wake callers still waiting on this entry. */
function cancelEntry(entry: Entry): void {
  if (entry.cancelled) return;
  entry.cancelled = true;
  lanes.solver.cancel(entry);
  lanes.plain.cancel(entry);
  const now = Date.now();
  for (const cell of entry.per.values()) {
    if (cell.state === 'pending') Object.assign(cell, { state: 'timeout' as const, settledAt: now });
  }
  wake(entry);
}

/**
 * Ask one source, under a slot, and write what it said into the entry. Never throws: the state is the report. `slow`:
 * the health read this search made shows the source on a slow streak, which an answer inside the budget ends.
 */
async function askOne(entry: Entry, src: SourceAdapter, term: string, slow = false): Promise<void> {
  const cell = entry.per.get(src.id)!;
  const lane = laneFor(src);
  if (!(await lane.take(entry))) return;
  const t0 = Date.now();
  const budget = budgetFor(src, SEARCH_SOURCE_MS);
  try {
    if (entry.cancelled) return;
    const raw = await bounded(src.search(term), budget);
    const items = (Array.isArray(raw) ? raw : []).slice(0, SEARCH_PER_SOURCE);
    // Empty is a normal answer -- the title is not on this source -- and is reported nowhere: the newest
    // listing's empty-streak evidence is about page 1 of a listing, not about a search for one title.
    Object.assign(cell, { state: items.length ? 'ok' : 'empty', items, ms: Date.now() - t0, settledAt: Date.now() });
    // #115: a search that found something is evidence the search stage works (non-escalating, throttled).
    if (items.length) void noteStage(src.id, 'search', 'ok');
    // v0.55.10: in time, found or not, so a slow streak ends here (lib/sourceHealth.ts reportTimely) -- asked only of a
    // source on one, since for every other source the write would change nothing. Reintroduce by dropping it: "a search
    // answered in time ends the slow streak" in searchAll.int.test.ts reads the streak still counting.
    if (slow) void reportTimely(src.id);
  } catch (e) {
    // Two different facts, recorded two different ways, exactly as the newest listing records them (see
    // routes/sources.ts latestPage): outrunning OUR budget is counted and at worst earns a short fixed
    // breather; a real failure earns the escalating cooldown, because asking a refusing site again is cost.
    if ((e as { selfTimeout?: boolean })?.selfTimeout) {
      void reportSlow(src.id, (e as { ms?: number }).ms ?? budget);
      Object.assign(cell, { state: 'timeout', ms: Date.now() - t0, settledAt: Date.now() });
    } else {
      const error = (e as Error)?.message || 'search failed';
      // And evidence for Health, at the stage it happened (#115) -- after the count, never beside it. The note
      // creates the row when the source has none, and side by side that bare row could land first: to anything
      // reading in between (the next search's cooldown check, Health, a test) a source with no failure on record.
      // Chained, the evidence can neither get ahead of the count nor hold it up. Not our own timeout: that is
      // reportSlow's. Reintroduce by firing the two side by side: "a refusal must count against the source" in
      // searchAll.int.test.ts reads the bare row.
      void reportFail(src.id, classify(e) ?? 'down', error).then(() => noteStage(src.id, 'search', 'fail', { error }));
      Object.assign(cell, { state: 'failed', ms: Date.now() - t0, settledAt: Date.now() });
    }
  } finally {
    lane.free();
    wake(entry);
  }
}

/** Drop the oldest entries until there is room for one more, and any that have outlived the TTL. */
function makeRoom(now: number): void {
  for (const [k, e] of entries) {
    if (now - e.startedAt >= SEARCH_TTL_MS) { cancelEntry(e); entries.delete(k); }
  }
  while (entries.size >= SEARCH_CACHE_MAX) {
    let oldest: string | null = null;
    for (const [k, e] of entries) if (oldest === null || e.startedAt < entries.get(oldest)!.startedAt) oldest = k;
    if (oldest === null) break;
    const entry = entries.get(oldest);
    if (entry) cancelEntry(entry);
    entries.delete(oldest);
  }
}

/**
 * Search `term` on every adapter in `ask`, answering within `opts.waitMs`.
 *
 * `ask` is the caller's whole reachable set, in any order; they are asked in `scanOrder` (sources that pin
 * no language first, then the rest by preference). `opts.health` is ONE `healthAll()` read the route
 * made: a disabled source, or one whose cooldown has not run out, is `skipped` and never asked -- and is
 * not written to the entry, so the next call re-reads its health and asks it once the cooldown has passed.
 */
export async function searchAll(
  term: string,
  ask: SourceAdapter[],
  opts: { waitMs: number; health: Map<string, SourceHealth> },
): Promise<SearchAnswer> {
  const key = keyOf(term);
  const callStart = Date.now();
  let entry = entries.get(key);
  if (entry && callStart - entry.startedAt >= SEARCH_TTL_MS) {
    cancelEntry(entry);
    entries.delete(key);
    entry = undefined;
  }
  if (!entry) {
    makeRoom(callStart);
    entry = { startedAt: callStart, per: new Map(), waiters: new Set(), cancelled: false };
    entries.set(key, entry);
  }

  const byId = new Map(ask.map((a) => [a.id, a] as const));
  const order = scanOrder(ask, null);
  const skipped = new Map<string, 'disabled' | 'cooldown'>();
  for (const id of order) {
    if (entry.per.has(id)) continue;
    const h = opts.health.get(id);
    if (h?.disabled) { skipped.set(id, 'disabled'); continue; }
    if (h?.blocked_until && new Date(h.blocked_until).getTime() > callStart) { skipped.set(id, 'cooldown'); continue; }
    entry.per.set(id, { state: 'pending', items: [] });
    void askOne(entry, byId.get(id)!, term, (h?.slow_streak ?? 0) > 0);
  }

  // Wait for the earliest of: everything mine settled, my own wait, or the grace after the first source
  // with results. The grace counts from that settle or from this call, whichever is later: a hit that
  // landed before this call still gives the call a grace's worth of fresh settles rather than answering
  // at once with whatever a previous viewer's timing left.
  const mine = order.filter((id) => !skipped.has(id));
  const deadline = callStart + Math.max(0, opts.waitMs);
  for (;;) {
    const cells = mine.map((id) => entry.per.get(id)!);
    if (!cells.some((c) => c.state === 'pending')) break;
    const now = Date.now();
    let firstHit = Infinity;
    for (const c of cells) if (c.state === 'ok' && c.settledAt !== undefined && c.settledAt < firstHit) firstHit = c.settledAt;
    const graceEnd = firstHit === Infinity ? Infinity : Math.max(firstHit, callStart) + SEARCH_GRACE_MS;
    const until = Math.min(deadline, graceEnd);
    if (now >= until) break;
    const e = entry;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, until - now);
      function done() { clearTimeout(timer); e.waiters.delete(done); resolve(); }
      e.waiters.add(done);
    });
  }

  const per = new Map<string, { state: SearchState; items: SourceSeries[] }>();
  const sources: SearchSourceLine[] = [];
  let pending = 0;
  let asked = 0;
  for (const id of order) {
    const name = byId.get(id)!.name;
    const why = skipped.get(id);
    if (why) {
      per.set(id, { state: 'skipped', items: [] });
      sources.push({ id, name, state: 'skipped', why });
      continue;
    }
    const c = entry.per.get(id)!;
    asked++;
    if (c.state === 'pending') pending++;
    per.set(id, { state: c.state, items: c.items });
    sources.push({ id, name, state: c.state, ...(c.ms !== undefined ? { ms: c.ms } : {}) });
  }
  return { per, sources, pending, asked, startedAt: entry.startedAt };
}

// ---- shaping ------------------------------------------------------------------------------------------
// The two shapes the route answered before this file existed, byte for byte in their keys: Discover reads
// the title-grouped one, the import review sheet the per-source one. `order` is the route's provider order
// (by declared preference), which is what "the first provider is the default pick" rests on -- NOT the
// ask order above, which puts language-less sources first and would change every card's default source.

// ---- the 18+ filter (v0.55.4, #158) -------------------------------------------------------------------------------------
// DannyDynamite39's second ask: "certain extensions don't expose content rating ... when searching a series in the
// Discover tab, such filtering options should be visible". A search result says what it can: its source may be adult (an
// extension that declares it, or one the admin named), MangaDex rates every title, and the admin's adult genres
// (Admin -> Settings -> 18+ filter) can be matched against the genres a result carries. Worked out here, on READ, for one
// viewer's answer: the entry above is every viewer's, and must never hold anyone's filter.

/** What a search result is known to be: 18+, or not. Absent when nothing says either. */
export type Rating = 'adult' | 'safe';
/**
 * What one result is known to be, before a card weighs it (v0.55.5): `flagged` when the ONLY thing that says 18+ is its
 * source's own declaration. An extension's flag covers its whole site, and the extension index flags a site that hosts
 * any adult title at all, so general aggregators carry it beside hentai sites: AllManga (EN), 11toon, Manga Bab. A
 * flagged result still reads `adult` in what is answered; groupByTitle is where it weighs less.
 */
export type Judged = Rating | 'flagged';
/** What a search shows: everything, everything not known to be 18+ (`safe`), or only what is (`adult`). */
export type RatingFilter = 'all' | 'safe' | 'adult';
/** The admin's 18+ filter lists (lib/visibility.ts adultFilter): genres as typed, source ids lowercased. */
export interface AdultLists { genres: readonly string[]; sources: readonly string[] }

/**
 * Whether a search result is 18+, by every signal it carries.
 *
 * 18+ when the admin named its source on the 18+ list, when MangaDex rates the title erotica or pornographic, or when
 * one of its genres is on the admin's adult list -- folded as browsable() folds them (lib/visibility.ts: trimmed and
 * case-blind on both sides). `flagged` when nothing but its extension's own declaration says so (Judged), and that comes
 * before any `safe`: a site that declares itself adult is not made safe by a title whose genres the admin's list misses.
 * Not 18+ when MangaDex rates it safe or suggestive, or when it names genres, the admin's list has some, and none of them
 * match. Anything else is unknown: most extensions name no genres in a search, and an unknown result is shown under All
 * and Hide 18+, never under 18+ only. Reintroduce by matching genres without the fold: "a genre is matched as the
 * library matches it" in adultFilter.int.test.ts keeps the 18+ result under Hide 18+.
 */
export function ratingOf(
  item: Pick<SourceSeries, 'genres' | 'contentRating'>, src: { id?: string; isNsfw?: boolean } | null | undefined, lists: AdultLists,
): Judged | undefined {
  if (src?.id && lists.sources.includes(String(src.id).toLowerCase())) return 'adult';
  if (item.contentRating === 'erotica' || item.contentRating === 'pornographic') return 'adult';
  const fold = (g: string) => g.trim().toLowerCase();
  const adult = new Set(lists.genres.map(fold).filter(Boolean));
  const genres = (Array.isArray(item.genres) ? item.genres : []).filter((g): g is string => typeof g === 'string').map(fold).filter(Boolean);
  if (genres.some((g) => adult.has(g))) return 'adult';
  if (src?.isNsfw) return 'flagged';
  if (item.contentRating === 'safe' || item.contentRating === 'suggestive') return 'safe';
  if (genres.length && adult.size) return 'safe';
  return undefined;
}

/**
 * A card's rating, from its providers' (v0.55.5). 18+ when any provider is known to be by the title itself (or by a
 * source the admin named), or when EVERY provider is `flagged`: a title that only sites declaring themselves adult carry.
 * A site's own flag never outweighs another site carrying the same title unflagged. v0.55.4 let it: a card was 18+ when
 * any provider was, and AllManga's flag put every manhwa it shares with Asura or Natomanga under 18+ only, marked 18+
 * under All and gone from Hide 18+. Then safe when any provider says so; else unknown. Reintroduce "any provider": the
 * flagged-and-plain card in searchAll.int.test.ts reads 18+.
 */
export function cardRating(judged: ReadonlyArray<Judged | undefined>): Rating | undefined {
  if (judged.some((j) => j === 'adult')) return 'adult';
  if (judged.length && judged.every((j) => j === 'flagged')) return 'adult';
  if (judged.some((j) => j === 'safe')) return 'safe';
  return undefined;
}

/** What one result answers: a `flagged` one reads 18+, its source's own word for what it is. */
const answered = (j: Judged | undefined): Rating | undefined => (j === 'flagged' ? 'adult' : j);

/** How a shaping rates and filters: the rating of one result from one source, and what the viewer is shown. */
export interface Rated { of: (item: SourceSeries, src: SourceAdapter) => Judged | undefined; want: RatingFilter }
/** Whether a result (or a card) of this rating is shown under `want`. Unknown is shown under all and safe, not adult. */
const shows = (want: RatingFilter, r: Rating | undefined): boolean => (want === 'all' ? true : want === 'safe' ? r !== 'adult' : r === 'adult');

/**
 * `lang` (v0.52.0): the language the source declares, as an app code; null when it says nothing or serves every one.
 * `rating` (v0.55.4): what the result is known to be, absent when nothing says (ratingOf); 18+ also when only its site's
 * own flag says so (v0.55.5, Judged), which the card weighs less.
 */
export interface Provider { source: string; name: string; sourceId: string; coverUrl?: string; title: string; lang: string | null; rating?: Rating }
/**
 * `rating` (v0.55.4; weighed by cardRating since v0.55.5): 18+, safe, or absent when nothing says. `work` (v0.56.0): the
 * key the card was folded by, when the caller gave one (groupByTitle's keyOf).
 */
export interface TitleGroup { title: string; coverUrl?: string; updatedAt?: string; providers: Provider[]; rating?: Rating; work?: string }
export interface SourceRail { source: string; name: string; lang: string | null; results: Array<SourceSeries & { name: string; rating?: Rating }> }

/**
 * One card per normalised title (or per `keyOf`, v0.56.0) carrying every provider that has it; most providers first, at
 * most `max`.
 *
 * With `rated`, each provider and card says what it is known to be, and the cards the viewer does not want are left out
 * BEFORE the cap: filtered after it, "18+ only" was what happened to be among the thirty, often nothing. A card's rating
 * is cardRating's: 18+ when any provider is known to be by the title, or when only self-declared adult sites carry it.
 * Reintroduce the filter after the slice: "filtered before the cap" in searchAll.int.test.ts finds fewer cards.
 */
export function groupByTitle(
  per: SearchAnswer['per'], order: SourceAdapter[], max = 30, rated?: Rated, keyOf?: (item: SourceSeries, src: SourceAdapter) => string,
): TitleGroup[] {
  const groups = new Map<string, TitleGroup>();
  // Each card's providers as ratingOf judged them, `flagged` kept apart: what is answered folds it into `adult`.
  const judged = new Map<TitleGroup, Array<Judged | undefined>>();
  for (const src of order) {
    for (const r of per.get(src.id)?.items ?? []) {
      if (!r.sourceId || !r.title) continue;
      // v0.56.0: the caller's key -- Discover's work (lib/discoverIdentity.ts workOf), under which two sites naming one series
      // differently are one card -- else the normalised title, as every caller before it. A work key is never empty, so a
      // title in another script is a card of its own, where the ASCII key dropped it.
      const key = keyOf ? keyOf(r, src) : normTerm(r.title);
      if (!key) continue;
      let g = groups.get(key);
      if (!g) {
        g = { title: r.title, coverUrl: r.coverUrl, updatedAt: r.updatedAt, providers: [], ...(keyOf ? { work: key } : {}) };
        groups.set(key, g); judged.set(g, []);
      }
      if (!g.coverUrl && r.coverUrl) g.coverUrl = r.coverUrl;
      if (!g.updatedAt && r.updatedAt) g.updatedAt = r.updatedAt;
      if (!g.providers.some((p) => p.source === r.source)) {
        const j = rated?.of(r, src);
        const rating = answered(j);
        judged.get(g)!.push(j);
        g.providers.push({
          source: r.source, name: src.name, sourceId: r.sourceId, coverUrl: r.coverUrl, title: r.title, lang: canonLang(src.lang),
          ...(rating ? { rating } : {}),
        });
      }
    }
  }
  const all = [...groups.values()];
  for (const g of all) {
    const rating = cardRating(judged.get(g) ?? []);
    if (rating) g.rating = rating;
  }
  return (rated ? all.filter((g) => shows(rated.want, g.rating)) : all).sort((a, b) => b.providers.length - a.providers.length).slice(0, max);
}

/**
 * One rail per source that had results (Mihon's global-search screen); each result carries its source's name. With
 * `rated`, each result says what it is known to be, the ones the viewer does not want are left out, and a rail left
 * with nothing is not drawn. A rail is one site, so nothing else vouches for its titles: a `flagged` result is 18+ here.
 */
export function bySource(per: SearchAnswer['per'], order: SourceAdapter[], rated?: Rated): SourceRail[] {
  const out: SourceRail[] = [];
  for (const src of order) {
    const list = per.get(src.id)?.items ?? [];
    if (!list.length) continue;
    const results = list.filter((r) => !!r.sourceId).flatMap((r) => {
      const rating = answered(rated?.of(r, src));
      return !rated || shows(rated.want, rating) ? [{ ...r, name: src.name, ...(rating ? { rating } : {}) }] : [];
    });
    if (rated && !results.length) continue;
    out.push({ source: src.id, name: src.name, lang: src.lang ?? null, results });
  }
  return out;
}

/** Exposed for tests: the cache is process-global and would otherwise leak between cases. */
export function clearSearchCache(): void {
  for (const entry of entries.values()) cancelEntry(entry);
  entries.clear();
}

/** Exposed for tests: moves every entry's start back by `ms`, so the TTL can be crossed without waiting it out. */
export function ageSearchCache(ms: number): void { for (const e of entries.values()) e.startedAt -= ms; }
