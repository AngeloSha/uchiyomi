/**
 * Following the other sources that carry a series, decided by the server at add time (#49).
 *
 * The manual follow (POST /api/admin/series/:id/sources) has two identity gates: the fill scan's title
 * match on the server, and a person confirming which source and which title they picked. This path has no
 * person, so it keeps BOTH gates on the server: the candidate's own title, as its source names it, must
 * match ours, and its numbering must line up with what we list. Coverage alone cannot do it -- lib/fill.ts's
 * header says why: a dense 1..N series is covered by any other long series -- and a title match alone
 * cannot either, because the fill scan's `contains` tier is exactly what a sequel or a spin-off shares with
 * its parent: "Tokyo Ghoul:re" contains "Tokyo Ghoul", "My Hero Academia" is inside "My Hero Academia:
 * Vigilantes", and each lists every number the other does. Followed, the next sweep would file the
 * sequel's chapters 21.. under the parent's title, which is the wrong-book hazard the whole of lib/fill.ts
 * exists to make hard. So the numbering is asked BOTH ways unless the titles are exactly equal and the
 * primary lists enough to be sure of (judgeCandidate says the rule in full); `title_differs` and
 * `numbering_differs` are the refusals that keep it so.
 *
 * Coverage is measured against the primary's LISTING (`series_listing`, written by the add), not against
 * `lib_books`: a fresh add holds nothing on disk, and a nothing-yet add never will until the sweep. The
 * fill scan's MIN_HAVE floor applies to that listing for the fill scan's reason -- two numbers prove
 * nothing, any long series covers them.
 *
 * Nothing here searches. The candidates are the pairs the add dialog already found, so an add costs at most
 * two calls per candidate (getSeries + listChapters), under the fill scan's concurrency slots and a total
 * wall budget; a candidate that never got its turn is `not_tried`, never "listed no chapters". The result
 * lands on the add's job card (routes/sources.ts) rather than on the add's answer, because on the download
 * path the listing -- and the row -- exist only after the first chapter lands, long after the dialog was
 * answered; the dialog polls the card anyway.
 */
import type { FastifyRequest } from 'fastify';
import { q, one, tx } from './db';
import { getSource } from './sources';
import { budgetFor } from './sources/budget';
import { SOLVER_CONCURRENCY } from './sources/flaresolverr';
import { healthAll, type SourceHealth } from './sourceHealth';
import { chooseReleases, type ReleasePrefs } from './releases';
import { effectivePrefsFor, readSeriesPrefs } from './scanlatorPrefs';
import { assess, verdict, followable, MIN_HAVE, MIN_COVERAGE } from './fill';
import { logAudit } from './audit';
import type { SourceChapter } from './sources/types';

/** How many sources a series may FOLLOW, on top of its primary. */
export const MAX_FOLLOWERS = 2;
/** How many of an add's candidates are asked at all; the rest are `not_tried`. */
export const MAX_AUTO_CANDIDATES = 6;
/**
 * How many numbers the primary must list before an EXACT title match may be judged on the primary's
 * numbers alone. Under it, or under a mere `contains` match, the candidate's numbers are measured too
 * (judgeCandidate). Three numbers -- MIN_HAVE -- are enough to say a source is not this book (two of the
 * three missing is unmistakable) but never enough to say it IS: 1..3 sits inside every long-running work
 * of the same name, of which a 300-chapter one is the wrong book more often than not. Ten is where a
 * same-titled listing that agrees on all of them stops being a coincidence.
 */
export const ONE_WAY_MIN_LISTED = 10;
/**
 * The whole judgement's wall budget for one add. Six solver-fronted candidates at budgetFor's 90 s each,
 * four at a time, is three minutes; nobody watches a dialog that long, and the card would say "Checking…"
 * for all of it. Whatever has not been asked when this runs out is `not_tried`, which the dialog words as
 * "not checked -- it took too long", and Find missing chapters on the series page is a tap away.
 */
export const AUTO_FOLLOW_WALL_MS = 90_000;
/** What one candidate's two lookups get, before budgetFor raises it for a source behind the solver. */
export const AUTO_FOLLOW_LOOKUP_MS = 20_000;
/**
 * The fill scan's slot count, read from the same knob (routes/sources.ts SCAN_CONCURRENCY), so an add
 * asks sources at the rate a scan does and never more solves at once than the solver runs.
 */
const AUTO_FOLLOW_CONCURRENCY = Math.max(1, Number(process.env.SCAN_CONCURRENCY || SOLVER_CONCURRENCY));

/**
 * `withTimeout` (lib/sources) with its timer CLEARED once the race settles. The shared one leaves its timer
 * armed until it fires, which is harmless at 20 s but not at this file's 90-second wall: one armed per
 * add, it would hold a stopping process -- and every test runner -- for a minute and a half after the
 * last candidate answered. The rejection is tagged as the shared one's is, for anyone who classifies it.
 */
function bounded<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const clock = new Promise<T>((_, rej) => {
    timer = setTimeout(() => rej(Object.assign(new Error(`timeout after ${ms}ms`), { selfTimeout: true, ms })), ms);
  });
  return Promise.race([p, clock]).finally(() => clearTimeout(timer));
}

/** A pair the add dialog found: the source, and the series' id on it. Never searched for here. */
export interface FollowCandidate { source: string; sourceId: string }

/** What the series being added is known by, and what its own source lists. */
export interface PrimaryFacts {
  title: string;
  /** Other spellings the primary is known under (a tracker's synonyms, say); any of them may match. */
  altTitles: string[];
  /** The distinct chapter numbers the primary lists: the listing the add just wrote. */
  numbers: number[];
}

/** Why a candidate ended up followed or not. Every one is shown to the person; none is swallowed. */
export type FollowWhy =
  | 'followed'
  /**
   * It answered and its title matched, but the numbering does not line up: it lists under MIN_COVERAGE of
   * our numbers (or none at all), or -- when only its title was not enough to trust (judgeCandidate's
   * two-way rule) -- we list under MIN_COVERAGE of its numbers, as with a sequel that runs on past us.
   */
  | 'numbering_differs'
  /** Its own title is not ours by the fill scan's rule. The wrong-book guard; coverage is not consulted. */
  | 'title_differs'
  /** It threw or outran its budget. Never reported as "lists no chapters". */
  | 'unreachable'
  /** The PRIMARY lists fewer than MIN_HAVE numbers, so nothing can be measured; no source was asked. */
  | 'too_few_listed'
  /** Never asked: past the wall budget or the candidate cap. */
  | 'not_tried'
  /** It qualified, but the series already follows MAX_FOLLOWERS sources. */
  | 'cap'
  /** The primary itself, a disabled source, one in a cooldown, one not loaded, or one this viewer may not reach. */
  | 'unavailable';

export interface FollowResult {
  source: string;
  name: string;
  /** The title as the candidate's source names it, when it answered; what the dialog shows beside "Followed". */
  theirTitle: string | null;
  followed: boolean;
  /**
   * Of the primary's listed numbers, the share the candidate lists -- or, when the numbering was measured
   * both ways (judgeCandidate), the LOWER of the two shares, so a sequel that lists all of ours and 40 more
   * reads 0.33 and not 1. Null when it was never measured.
   */
  coverage: number | null;
  why: FollowWhy;
}

/** What judgeCandidate concluded. `ok` means followable; every other why is final. */
export interface Judgement {
  source: string;
  name: string;
  sourceSeriesId: string;
  theirTitle: string | null;
  coverage: number | null;
  why: 'ok' | Exclude<FollowWhy, 'followed' | 'cap' | 'not_tried'>;
}

/**
 * The same key as `norm` in routes/sources.ts. A lib cannot import a route (routes/sources.ts imports this
 * file), so the rule is repeated here and autoFollow.int.test.ts pins the two equal.
 */
const normTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** How the candidate's title relates to ours, or null when it does not. `exact` beats `contains`. */
export type TitleMatch = 'exact' | 'contains';

/**
 * The fill scan's title rule (pickBestScored's `exact` and `contains` tiers), applied to the candidate's
 * OWN title rather than to a search result: after normalisation, equal, or one inside the other -- and it
 * says WHICH, because judgeCandidate trusts the two differently. The `fuzzy` tier (token overlap) is
 * deliberately not accepted here -- it is the tier a sequel passes. Both sides must be longer than two
 * characters for the containment half: the scan only guards the candidate's side, which is enough there
 * because its term is a real title, but a primary named "X" would otherwise match every title with an x
 * in it. An exact match on ANY of our titles wins over a containment on another: a tracker's synonyms
 * often include the bare parent title, and a candidate equal to one of them is not a sequel of it.
 */
export function titleMatch(theirs: string, primary: { title: string; altTitles?: string[] }): TitleMatch | null {
  const t = normTitle(theirs);
  if (!t) return null;
  let contains = false;
  for (const ours of [primary.title, ...(primary.altTitles ?? [])]) {
    const n = normTitle(ours);
    if (!n) continue;
    if (n === t) return 'exact';
    if (t.length > 2 && n.length > 2 && (t.includes(n) || n.includes(t))) contains = true;
  }
  return contains ? 'contains' : null;
}

/** `titleMatch` as a yes/no, for callers that only ask whether the title is ours at all. */
export function titleMatches(theirs: string, primary: { title: string; altTitles?: string[] }): boolean {
  return titleMatch(theirs, primary) !== null;
}

/**
 * May this one source be followed for this series? Reads the source, decides, writes nothing.
 *
 * The rule, in full. The candidate's own title must match ours (`titleMatch`; any of our alt titles
 * counts) or it is `title_differs`, whatever its numbers. Then its numbering is measured against the
 * primary's listing, and how much of it is asked depends on how sure the title made us:
 *
 * - An EXACT title match, when the primary lists at least ONE_WAY_MIN_LISTED numbers, is judged one way:
 *   the candidate must list at least MIN_COVERAGE of the primary's numbers (`followable`, the manual
 *   route's rule). A candidate that runs on past us is fine here -- "Followed Tale" 1..400 for our
 *   "Followed Tale" 1..20 is the same book, further along, and following it is the point.
 * - Otherwise -- a `contains` match, or an exact one on a primary listing fewer than ONE_WAY_MIN_LISTED --
 *   it is judged BOTH ways: the candidate must list at least MIN_COVERAGE of the primary's numbers AND the
 *   primary must list at least MIN_COVERAGE of the candidate's, or it is `numbering_differs`. This is the
 *   sequel guard. "Tokyo Ghoul:re" 1..60 lists all of "Tokyo Ghoul" 1..20 but we list a third of it;
 *   "My Hero Academia" 1..400 covers "My Hero Academia: Vigilantes" 1..15 forty times over; a same-named
 *   300-chapter work covers a 3-number listing entirely -- none of the three is this book, and each is
 *   refused. "Followed Tale (Official)" 1..22 for 1..20 still follows: 20 of 22 is 0.91.
 *   The reported `coverage` is then the lower of the two shares, so the person sees the number that
 *   decided.
 *
 * `prefs` and `health` are passed in by autoFollow so a whole add reads them once; a standalone call
 * reads its own. The two lookups run in parallel under ONE budget -- the larger of the two, bounded --
 * and any throw or timeout is `unreachable`: routes/sources.ts's seriesAndChapters swallows both into
 * null/[] for its own reasons, which is exactly what would make a source that did not answer read as
 * "numbering differs", so it is not used here.
 */
export async function judgeCandidate(
  primary: PrimaryFacts,
  candidate: FollowCandidate,
  opts: { prefs?: ReleasePrefs; health?: Map<string, SourceHealth>; lookupMs?: number; now?: number } = {},
): Promise<Judgement> {
  const src = getSource(candidate.source);
  const base = {
    source: candidate.source, name: src?.name ?? candidate.source, sourceSeriesId: candidate.sourceId,
    theirTitle: null as string | null, coverage: null as number | null,
  };
  if (!src) return { ...base, why: 'unavailable' };
  const h = opts.health
    ? opts.health.get(candidate.source) ?? null
    : await one<Pick<SourceHealth, 'disabled' | 'blocked_until'>>(
      'SELECT disabled, blocked_until FROM source_health WHERE source_id = $1', [candidate.source]).catch(() => null);
  if (h?.disabled) return { ...base, why: 'unavailable' };
  if (h?.blocked_until && new Date(h.blocked_until).getTime() > (opts.now ?? Date.now())) return { ...base, why: 'unavailable' };
  // Before any network: coverage against two numbers proves nothing at all, whatever the source says.
  if (primary.numbers.length < MIN_HAVE) return { ...base, why: 'too_few_listed' };

  let theirTitle: string | null;
  let raw: SourceChapter[];
  try {
    const [series, chapters] = await bounded(
      Promise.all([src.getSeries(candidate.sourceId), src.listChapters(candidate.sourceId)]),
      budgetFor(src, opts.lookupMs ?? AUTO_FOLLOW_LOOKUP_MS),
    );
    theirTitle = series?.title?.trim() || null;
    raw = chapters ?? [];
  } catch {
    return { ...base, why: 'unreachable' };
  }
  // It answered without naming the title. There is nothing to judge identity by, and the add path treats
  // the very same answer as transient (`no_title`, 503): a source that cannot say what this is right now
  // has not been reached in any sense that matters, and must not be followed on numbering alone.
  if (!theirTitle) return { ...base, why: 'unreachable' };
  const match = titleMatch(theirTitle, primary);
  if (!match) return { ...base, theirTitle, why: 'title_differs' };

  // One copy per number, under the same preferences the add chose its own copies with: a source whose
  // every copy of a number is from a blocked group does not list that number, as far as the sweep is
  // concerned, and the sweep is who this follow is for.
  const prefs = opts.prefs ?? await effectivePrefsFor(null, 0);
  const nums = chooseReleases(raw, prefs).releases.map((c) => c.number);
  const a = assess(primary.numbers, nums);
  // The sequel guard (the rule above): only an exact title on a listing long enough to be sure of is
  // trusted on the primary's numbers alone. Everything else must also be mostly INSIDE the primary --
  // `assess` the other way round is the share of the candidate's numbers that we list -- and the lower
  // of the two shares is what is reported, because it is the one that decided.
  const oneWay = match === 'exact' && primary.numbers.length >= ONE_WAY_MIN_LISTED;
  const back = oneWay ? 1 : assess(nums, primary.numbers).coverage;
  const decided = Math.min(a.coverage, back);
  const coverage = Math.round(decided * 100) / 100;
  if (!followable({ coverage: a.coverage, why: verdict(a, nums.length) }) || back < MIN_COVERAGE) {
    return { ...base, theirTitle, coverage, why: 'numbering_differs' };
  }
  return { ...base, theirTitle, coverage, why: 'ok' };
}

export interface AutoFollowOpts {
  /** Who triggered the add, for the audit line. The rows themselves are written with `added_by` NULL. */
  userId?: string | null;
  req?: FastifyRequest;
  /** Other spellings the primary is known by; a candidate matching any of them passes the title check. */
  altTitles?: string[];
  /**
   * Which sources THIS viewer may reach (the age cap). A candidate that fails it is `unavailable` and never
   * asked: which sources you may reach is entirely about who is asking (lib/visibility.ts), and a capped
   * account naming an adult source must not have the server follow it on their behalf.
   */
  allowed?: (source: string) => boolean;
  /** Test knobs. The route never passes them. */
  wallMs?: number;
  lookupMs?: number;
  concurrency?: number;
}

/**
 * The candidates autoFollow would report, one entry per source, first mention wins: the same source twice
 * would be judged twice and reported twice, and its second follow would only ever update the first.
 */
function distinctCandidates(candidates: FollowCandidate[]): FollowCandidate[] {
  const seen = new Set<string>();
  const list: FollowCandidate[] = [];
  for (const c of candidates) {
    if (seen.has(c.source)) continue;
    seen.add(c.source);
    list.push(c);
  }
  return list;
}

/**
 * One refusal per candidate, with no source asked -- the shape autoFollow answers when nothing can be
 * judged, and what the add's job card is filled with when the judgement itself threw (routes/sources.ts
 * judgeAlsoFollow), so that the dialog has a line to print for every source rather than none: a card
 * that reads done with no results is the one silence this file promises not to leave.
 */
export function refusals(candidates: FollowCandidate[], why: FollowWhy): FollowResult[] {
  return distinctCandidates(candidates).map((c) =>
    ({ source: c.source, name: getSource(c.source)?.name ?? c.source, theirTitle: null, followed: false, coverage: null, why }));
}

/**
 * Judge every candidate for a series that already has its listing, follow the ones that qualify, and say
 * what became of each -- in the order they were given.
 *
 * The judgements run in parallel under the scan's slots; the follows are written afterwards in body
 * order, so "which two of three good ones" is the order the dialog listed them and not whichever source
 * answered first. Each follow is one transaction that locks the series row and inserts only while the
 * series follows fewer than MAX_FOLLOWERS OTHER sources: two adds of the same title racing each other
 * (a double tap before the dialog's busy state paints) both read the count under the lock, so the second
 * sees the first's rows and reads `cap`. A re-follow of a source already followed always goes through --
 * it counts the others -- and keeps a human's `added_by` through the COALESCE, as the manual route does.
 *
 * A series that is gone, deleted or merged refuses everything as `unavailable` without asking a source:
 * following onto a merged row would hang a source on a series nobody can open.
 */
export async function autoFollow(seriesId: string, candidates: FollowCandidate[], opts: AutoFollowOpts = {}): Promise<FollowResult[]> {
  const deadline = Date.now() + (opts.wallMs ?? AUTO_FOLLOW_WALL_MS);
  const nameOf = (s: string) => getSource(s)?.name ?? s;
  const list = distinctCandidates(candidates);
  const refuseAll = (why: FollowWhy): FollowResult[] => refusals(list, why);
  if (!list.length) return [];

  const row = await one<{ id: string; title: string; source_id: string | null; deleted_at: string | null; merged_into: string | null }>(
    'SELECT id, title, source_id, deleted_at, merged_into FROM lib_series WHERE id = $1', [seriesId]).catch(() => null);
  if (!row || row.deleted_at || row.merged_into) return refuseAll('unavailable');
  const numbers = (await q<{ number: number }>('SELECT DISTINCT number FROM series_listing WHERE series_id = $1', [seriesId]).catch(() => []))
    .map((r) => Number(r.number)).filter((n) => Number.isFinite(n));
  // Decided once for the whole add rather than per candidate: no source is asked when nothing can be
  // measured, and the dialog sees one reason rather than six.
  if (numbers.length < MIN_HAVE) return refuseAll('too_few_listed');
  const primary: PrimaryFacts = { title: row.title, altTitles: opts.altTitles ?? [], numbers };
  // The series' own release preferences over the global ones, with patience off, as the fill scan reads
  // them: the question is what each source LISTS, and a copy held for a group is still listed.
  const prefs = await effectivePrefsFor(await readSeriesPrefs(seriesId), 0);
  const health = new Map((await healthAll().catch(() => [])).map((h) => [h.source_id, h]));

  // A slot is held before a candidate's clock starts, as the fill scan holds one before a search, so the
  // per-source budget measures the source and not the queue -- and the wall is checked only once the slot
  // is held, so a candidate that waited its turn out is `not_tried` rather than charged for the wait.
  const concurrency = Math.max(1, opts.concurrency ?? AUTO_FOLLOW_CONCURRENCY);
  let inFlight = 0;
  const waiting: Array<() => void> = [];
  const slot = async () => { if (inFlight >= concurrency) await new Promise<void>((r) => waiting.push(r)); inFlight++; };
  const free = () => { inFlight--; waiting.shift()?.(); };

  // A judgement, or the one verdict judgeCandidate never gives: it was never asked.
  type Outcome = Omit<Judgement, 'why'> & { why: Judgement['why'] | 'not_tried' };
  const judged: Outcome[] = new Array(list.length);
  await Promise.all(list.map(async (c, i) => {
    const base = { source: c.source, name: nameOf(c.source), sourceSeriesId: c.sourceId, theirTitle: null, coverage: null };
    // Following the primary would list every chapter twice, as the manual route says.
    if (c.source === row.source_id) { judged[i] = { ...base, why: 'unavailable' }; return; }
    if (opts.allowed && !opts.allowed(c.source)) { judged[i] = { ...base, why: 'unavailable' }; return; }
    if (i >= MAX_AUTO_CANDIDATES) { judged[i] = { ...base, why: 'not_tried' }; return; }
    await slot();
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 0) { judged[i] = { ...base, why: 'not_tried' }; return; }
      // judgeCandidate answers every failure of its own as a value, so a throw out of this race is the
      // wall's -- the candidate WAS asked, but the add stopped waiting for it -- which the person is told
      // as "not checked", never as a verdict on the source.
      judged[i] = await bounded(judgeCandidate(primary, c, { prefs, health, lookupMs: opts.lookupMs }), remaining)
        .catch(() => ({ ...base, why: 'not_tried' as const }));
    } finally { free(); }
  }));

  const results: FollowResult[] = [];
  for (const j of judged) {
    const out = { source: j.source, name: j.name, theirTitle: j.theirTitle, coverage: j.coverage };
    if (j.why !== 'ok') { results.push({ ...out, followed: false, why: j.why }); continue; }
    const written = await followUnderCap(seriesId, j).catch(() => 'gone' as const);
    if (written !== 'inserted') {
      results.push({ ...out, followed: false, why: written === 'cap' ? 'cap' : 'unavailable' });
      continue;
    }
    await logAudit('series.follow_source', {
      userId: opts.userId ?? null, req: opts.req,
      detail: { id: seriesId, title: row.title, source: j.source, sourceSeriesId: j.sourceSeriesId, coverage: j.coverage, theirTitle: j.theirTitle, auto: true },
    });
    results.push({ ...out, followed: true, why: 'followed' });
  }
  return results;
}

/**
 * The follow itself: one transaction, the series row locked, the INSERT conditional on the count.
 *
 * The count excludes the candidate's own source so a re-follow is an update and not a `cap`; `added_by`
 * is NULL -- the automatic path's signature (seriesSources.ts `auto`) -- and the COALESCE keeps a human's
 * choice where one already stands. Reintroduce by dropping the `WHERE (SELECT count(*) …)` clause: "the
 * third good candidate reads cap" in autoFollow.int.test.ts counts three rows, and the racing test six
 * follows. The `FOR UPDATE` is belt to that brace: without it two adds whose INSERTs evaluate the count
 * in the same instant could both pass it (READ COMMITTED sees neither's row yet). That window is
 * microseconds wide -- the racing test does not open it, and passes with the lock removed -- so the lock
 * is here for the day the window is hit, not because a test says so.
 */
async function followUnderCap(seriesId: string, j: Omit<Judgement, 'why'>): Promise<'inserted' | 'cap' | 'gone'> {
  return tx(async (qq) => {
    const row = (await qq<{ deleted_at: string | null; merged_into: string | null }>(
      'SELECT deleted_at, merged_into FROM lib_series WHERE id = $1 FOR UPDATE', [seriesId]))[0];
    if (!row || row.deleted_at || row.merged_into) return 'gone';
    const r = await qq<{ source_id: string }>(
      `INSERT INTO series_sources (series_id, source_id, source_series_id, title, coverage, added_by)
       SELECT $1::text, $2::text, $3::text, $4::text, $5::real, NULL::uuid
        WHERE (SELECT count(*) FROM series_sources WHERE series_id = $1 AND source_id <> $2) < $6::int
       ON CONFLICT (series_id, source_id) DO UPDATE SET source_series_id = EXCLUDED.source_series_id,
         title = EXCLUDED.title, coverage = EXCLUDED.coverage,
         added_by = COALESCE(EXCLUDED.added_by, series_sources.added_by)
       RETURNING source_id`,
      [seriesId, j.source, j.sourceSeriesId, j.theirTitle, j.coverage, MAX_FOLLOWERS]);
    return r.length ? 'inserted' : 'cap';
  });
}
