/**
 * Find other sources, and the other names a series goes by (v0.49.1): the part with no React in it, so a test can
 * hold the words and the rules.
 *
 * Why: aqua, the owner's main source, has served only its own "temporarily offline" page since 2026-09-23, and 189
 * of its 195 series had no second source to take new chapters from. An admin can now ask the server to look for
 * other sources for every series of a source (Health), for a selection (Library), or for one series (Sources &
 * translations): ONE calm run at a time on the server, 1.5 s between series, pausing for a chapter sweep, a repair
 * or the daily check, and following a source only where autoFollow's judgement (title and chapter numbers) says it
 * is the same series. The other names are what that search asks under besides the title.
 *
 * The idea, the other-names list and the name parsing are @TIGamingTV's (PR #119), rebuilt server-side on the
 * existing follow machinery (bff lib/autoFollow.ts, lib/sourceHunt.ts).
 *
 * Review first (v0.51.0, #132; @TIGamingTV's idea from PR #133): the same run, which follows nothing and keeps each
 * series' matches -- with their covers -- for an admin to follow or skip one by one. Automatic stays the default; the
 * start dialog offers both and remembers the admin's last choice on this device.
 *
 * ⚠️ 'not tried' is not 'not found'. A series the run never reached -- stopped, out of time, or cut short by a
 * restart -- says so in its own words and its own section, and is offered again; reading it as "no source has it"
 * would send the admin away from a series nobody searched for.
 */
import { keys, t as tr } from './i18n';
import { etaLine } from './format';
import { normTitle } from './normTitle';
import { waitingText } from './archive';
import type { ActionState } from './actionState';

// ---- the server's shapes (bff routes: /api/admin/series/:id/alt-titles, /api/admin/sources/find) ------------

/** Where a name came from: a source's own description, an admin's hand, or the tracker list an import read. */
export type AltOrigin = 'description' | 'admin' | 'import';

/** One other name of a series (GET/POST/DELETE /api/admin/series/:id/alt-titles answer `{ titles }`). */
export interface AltTitle {
  title: string;
  origin: AltOrigin;
  addedBy: string | null;
  createdAt: string;
  /** The stored key, when the server sends it; otherwise it is the title's key (`altKey`). */
  norm?: string;
}

/**
 * Why a series gained no source (bff source_find_runs.results[].why):
 * - `posting_order`: numbered by posting order, which refuses followers (bff lib/numbering.ts);
 * - `full`: it already follows as many other sources as a series may;
 * - `too_few`: it lists fewer than 3 chapter numbers, too few to compare a candidate's with -- decided without a
 *   search;
 * - `no_source`: no other source could be asked (switched off, cooling down, or left out);
 * - `no_answer`: other sources were asked, and none of them answered;
 * - `no_match`: searched, and no source that answered lists it under its title or other names;
 * - `followed_already`: searched, and no source that answered lists it -- but the one it already follows does, so it is
 *   not "no other source lists it" (the server's own reason since its review, in the same group as `no_match`);
 * - `refused`: a candidate was found and failed the title and chapter-number check;
 * - `not_tried`: never reached -- a stop, the run's time limit or a restart cut the run short. NOT searched.
 */
export type FindWhy =
  | 'posting_order' | 'no_match' | 'followed_already' | 'full' | 'refused' | 'too_few' | 'no_source' | 'no_answer' | 'not_tried'
  // v0.54.0, Replace: the series' main source changed while the run went, a check of the series held it past the wait,
  // or a renumbering waits for review first.
  | 'moved' | 'busy' | 'renumber_pending';

export interface FindFollowed { sourceId: string; name: string; chapters: number | null }

/**
 * v0.54.0, Replace: the series' new main source, and how it was found -- a source it already followed (`follower`),
 * or one the run searched for and followed first (`search`) -- and what became of the old one.
 */
export interface FindPromoted {
  from: string;
  fromName: string;
  to: string;
  toName: string;
  via: 'follower' | 'search';
  old: 'dropped' | 'kept';
}

/**
 * A match a review-first run kept (bff FindProposal, v0.51.0): green is what an automatic run would have followed,
 * amber is for a person to look at -- the chapter numbers do not line up though a name matches exactly (`numbering`),
 * or it lines up only under another name of the series (`other_name`). `ours` is how many of the series' chapter
 * numbers it lists, `theirs` how many of its numbers the series lists. `title`, `coverUrl` and `url` are left out for
 * a series the viewer may not list.
 */
export interface FindProposal {
  sourceId: string;
  sourceName: string;
  sourceSeriesId: string;
  url?: string;
  title?: string;
  coverUrl?: string;
  chapters: number;
  ours: { lined: number; of: number };
  theirs: { lined: number; of: number };
  coverage: number | null;
  verdict: 'green' | 'amber';
  /**
   * v0.54.0, Replace's review adds why a source the series already follows is amber: it is cooling down, it lists too
   * few of the series' chapters (`coverage`), or it has not answered for the series lately (`stale`).
   */
  amber?: 'numbering' | 'other_name' | 'cooling' | 'coverage' | 'stale';
  state?: 'followed' | 'dismissed' | 'promoted';
  /** v0.54.0, Replace: a source the series follows already (`follower`), or a search's match (`search`). */
  kind?: 'follower' | 'search';
  /** v0.54.0, Replace: the one the run would make the main source -- what Make all green main takes. */
  promote?: boolean;
}

export interface FindResult {
  seriesId: string;
  /** Left out for a series the viewer may not list (the 18+ hide): the row says why rather than name it. */
  title?: string;
  followed: FindFollowed[];
  why?: FindWhy;
  /** A review-first run's matches for this series, in scan order (v0.51.0). */
  proposals?: FindProposal[];
  /** v0.54.0, Replace: the series' new main source. */
  promoted?: FindPromoted;
  /** v0.54.0, Replace: the followed sources it passed over, and why. */
  skipped?: Array<{ sourceId: string; name: string; why: 'off' | 'failing' | 'cooling' | 'not_loaded' | 'language' | 'age' }>;
  /** v0.54.0, Replace: dead followed sources dropped to make room for a new one. */
  dropped?: Array<{ sourceId: string; name: string }>;
}

export type FindRunStatus = 'running' | 'done' | 'stopped' | 'failed' | 'interrupted';

/** A kept run without its results (`recent`). Times are the server's: an ISO string, or epoch ms. */
export interface FindRunSummary {
  id: string;
  status: FindRunStatus;
  total: number;
  done: number;
  /** Follows it added: one per (series, source). */
  followed: number;
  startedBy: string | null;
  startedAt: string | number;
  finishedAt?: string | number | null;
  /** Review first (v0.51.0): it followed nothing itself; its results carry `proposals`. */
  review?: boolean;
  /**
   * v0.54.0: a Replace run (`replace`) moves each series off one source -- to a source it already follows, or to one it
   * finds -- where a Find run (`follow`, or absent from an older server) only adds sources to follow.
   */
  mode?: 'follow' | 'replace';
  /** v0.54.0, Replace: series whose main source it changed. */
  promoted?: number;
  /** v0.54.0, Replace: series still on the source. */
  left?: number;
  /** v0.54.0, Replace: the source was turned off at the end, nothing using it any more. */
  turnedOff?: boolean;
  /** The source a source-wide run is about, where the server says (v0.54.0 asks it to). */
  sourceId?: string;
  sourceName?: string;
}

/** The running run, or the newest finished one, with what it did per series. */
export interface FindRun extends FindRunSummary {
  /** The series it is on; left out for one the viewer may not list. */
  current?: { seriesId: string; title: string } | null;
  /**
   * What a running run waits on before its next series: a chapter sweep, a repair or the daily source check, which
   * own the sources while they go. `current` still names the series it asked about last.
   */
  waiting?: 'sweep' | 'repair' | 'check' | null;
  results: FindResult[];
}

/** GET /api/admin/sources/find. */
export interface FindStatus {
  running: boolean;
  run: FindRun | null;
  recent: FindRunSummary[];
}

/**
 * What POST /api/admin/sources/find takes: some series, or every visible series whose MAIN source is this one -- and,
 * for review first (v0.51.0), `review: true`.
 */
export type FindScope = ({ seriesIds: string[] } | { sourceId: string }) & {
  review?: boolean;
  /** v0.54.0: Replace the source (`sourceId` only); `turnOff` with it switches the source off once nothing uses it. */
  mode?: 'replace';
  turnOff?: boolean;
};

// ---- the other names -----------------------------------------------------------------------------------

/**
 * A name's key, as DELETE /api/admin/series/:id/alt-titles/:norm takes it: the server's own when it sent one, else
 * the title normalised as the server keys it (lib/normTitle.ts, the same rule as bff lib/titleMatch.ts normTitle).
 */
export const altKey = (a: Pick<AltTitle, 'title' | 'norm'>): string => a.norm || normTitle(a.title);

const ORIGIN_KEYS = keys('from a source’s description', 'added by an admin', 'from an import');
/** Where a name came from, beside it. A newer server's origin reads as nothing rather than as its code. */
export function altOriginLabel(o: string): string {
  return o === 'description' ? tr(ORIGIN_KEYS[0]) : o === 'admin' ? tr(ORIGIN_KEYS[1]) : o === 'import' ? tr(ORIGIN_KEYS[2]) : '';
}

/**
 * Why a name was refused, under the field: the server's code in words (400 `too_short` -- its key is under five
 * letters or digits -- or `non_latin`; 409 `exists`). Null for anything else, which the caller says generically.
 */
export function altRefusal(code: string | null | undefined): string | null {
  switch (code) {
    case 'too_short': return tr('Too short: a name needs at least 5 letters or digits.');
    case 'non_latin': return tr('Only names in Latin letters can be matched: English or romanised.');
    case 'exists': return tr('This series already has that name.');
  }
  return null;
}

// ---- how long ------------------------------------------------------------------------------------------

/**
 * The most one series takes: the run's 1.5 s pace, plus the run's own wall per series (bff lib/findSources.ts
 * FIND_SERIES_WALL_MS, 90 s: what has not answered by then is not tried). The hunt's 60 s wall made aqua's 189
 * series "up to 4 hours" for a run that may take nearly five. Waiting for a sweep, a repair or the daily check is on
 * top, and unbounded; the words say the run pauses for them rather than fold them into a number.
 */
export const FIND_SERIES_MAX_MS = 1_500 + 90_000;

/** How long before the press: "Up to 5 hours" for 189 series; per series when the count is not known. */
export function findEta(n: number | null | undefined): string {
  return n && n > 0 ? etaLine({ maxMs: n * FIND_SERIES_MAX_MS }) : tr('Up to about a minute and a half per series');
}

// ---- what a run did ------------------------------------------------------------------------------------

/**
 * One series' reason, in words. `posting_order` is Health's sentence for the same fact (healthCopy GAP_WHY).
 * ⚠️ Each reason says only what happened: a series with too few chapters was never searched, and one no source could
 * be asked about, or none answered for, is neither "not found" nor "stopped" -- the server sent `refused` and
 * `not_tried` for them until the v0.49.1 review.
 */
export function findWhyLine(why: string | null | undefined): string {
  switch (why) {
    case 'no_match': return tr('No other source lists it under its title or other names');
    case 'followed_already': return tr('No other source lists it besides the one it already follows');
    case 'refused': return tr('Found a possible match, but it did not pass the title and chapter-number check');
    case 'full': return tr('Already follows as many other sources as a series may');
    case 'posting_order': return tr('Numbered by posting order: no other source’s numbers line up with it');
    case 'too_few': return tr('Too few chapters to compare (fewer than 3)');
    case 'no_source': return tr('No other source could be asked');
    case 'no_answer': return tr('No other source answered');
    case 'not_tried': return tr('Not tried: the search was stopped, ran out of time or was interrupted by a restart before it got there');
    // v0.54.0, Replace.
    case 'moved': return tr('Its main source changed while the run went; it was left as it is');
    case 'busy': return tr('It was being checked for new chapters; replace again later');
    case 'renumber_pending': return tr('A renumbering waits for your review on its series page first');
  }
  return tr('Nothing found');
}

export interface FindGroups {
  /** v0.54.0, Replace: series with a new main source. */
  moved: FindResult[];
  /** A review-first run's series with matches (v0.51.0), decided or not: each is shown with its matches. */
  review: FindResult[];
  /** Gained at least one source. */
  found: FindResult[];
  /** Searched, and nothing followed: no match, a match that did not line up, or no source that answered. */
  nothing: FindResult[];
  /**
   * Not searched, decided from what the server already knew: numbered by posting order, no free follower slot, too
   * few chapters to compare, or no other source it could ask.
   */
  skipped: FindResult[];
  /** Never reached: a stop, the run's time or a restart. ⚠️ Its own group, never "nothing found". */
  notTried: FindResult[];
}

const SKIPPED: ReadonlySet<string> = new Set<FindWhy>(['full', 'posting_order', 'too_few', 'no_source', 'moved', 'busy', 'renumber_pending']);

/** A run's results in the groups the results sheet shows, each in the order the run took them. */
export function groupResults(results: readonly FindResult[] | null | undefined): FindGroups {
  const g: FindGroups = { moved: [], review: [], found: [], nothing: [], skipped: [], notTried: [] };
  for (const r of results ?? []) {
    if (r.promoted) g.moved.push(r);
    else if (r.proposals?.length) g.review.push(r);
    else if (r.followed?.length) g.found.push(r);
    else if (r.why === 'not_tried') g.notTried.push(r);
    else if (r.why && SKIPPED.has(r.why)) g.skipped.push(r);
    else g.nothing.push(r);
  }
  return g;
}

/** Epoch ms of a server time, ISO or number; NaN when there is none. */
export const toMs = (t: string | number | null | undefined): number =>
  typeof t === 'number' ? t : t ? Date.parse(t) : NaN;

/** "1 source followed", "{n} sources followed": what the run card and the row say about follows. */
export const followedText = (n: number): string =>
  (n === 1 ? tr('1 source followed') : tr('{n} sources followed', { n }));

/** v0.54.0, Replace: "1 series moved", "{n} series moved" -- series whose main source the run changed. */
export const movedText = (n: number): string => (n === 1 ? tr('1 series moved') : tr('{n} series moved', { n }));

/** A Replace run (v0.54.0): it moves series off a source, where a Find run adds sources to follow. */
export const isReplace = (run: Pick<FindRunSummary, 'mode'> | null | undefined): boolean => run?.mode === 'replace';

/**
 * The news a run has to tell about its series so far: a Replace run's moves -- a search's follow is how a series got
 * its new main source there, never news of its own -- and a Find run's follows.
 */
function newsOf(run: Pick<FindRunSummary, 'followed' | 'mode' | 'promoted'>, results?: readonly FindResult[]): string | null {
  if (isReplace(run)) {
    const moved = run.promoted ?? (results ? results.filter((r) => r.promoted).length : 0);
    return moved > 0 ? movedText(moved) : null;
  }
  return run.followed > 0 ? followedText(run.followed) : null;
}

/**
 * How far a running run has got: "12 of 189 series · 3 sources followed" ("· 180 series moved" for a Replace run). A
 * run for one series (the Sources sheet's) counts nothing -- "0 of 1 series" says less than the step itself.
 */
export function progressLine(run: Pick<FindRunSummary, 'done' | 'total' | 'followed' | 'mode' | 'promoted'>): string {
  const bits: string[] = [];
  if (run.total > 1) bits.push(tr('{done} of {total} series', { done: Math.min(run.done, run.total), total: run.total }));
  const news = newsOf(run);
  if (news) bits.push(news);
  return bits.join(' · ');
}

/**
 * A Replace run's three counts, the run view's big numbers: moved to a source the series already followed, moved to
 * a source found by searching, and no replacement -- searched with nothing to show, or skipped. A series still to
 * review (review first) and one never reached are neither, and are not counted here.
 */
export function replaceCounts(run: Pick<FindRun, 'results'> | null | undefined): { moved: number; found: number; none: number; review: number } {
  const out = { moved: 0, found: 0, none: 0, review: 0 };
  for (const r of run?.results ?? []) {
    if (r.promoted) out[r.promoted.via === 'search' ? 'found' : 'moved']++;
    else if (r.proposals?.some((p) => !p.state)) out.review++;
    else if (r.why !== 'not_tried') out.none++;
  }
  return out;
}

/**
 * A run stopped by hand and one a restart cut short are the same to their reader: neither got to the end, what each
 * did stands, and the series it never reached are not tried -- counted, listed and offered again. The server lists
 * those as `not_tried` rows for both (since the v0.49.1 review); before, an interrupted run read as a red failure
 * that counted none of them.
 */
const cutShort = (status: FindRunStatus): boolean => status === 'stopped' || status === 'interrupted';

/**
 * What a run did, as one line: "40 sources followed · Nothing found for 140 series · 3 series skipped · 6 series not
 * tried", with how far it got first when it did not get to the end ("Stopped before it finished · 50 of 189 series",
 * "Interrupted by a restart · …"). `status: false` leaves that first word out, where a label beside the line already
 * says it (the results sheet's head, an earlier search's line). Without results (a `recent` summary) it is the counts
 * the summary carries.
 */
export function findSummary(run: FindRunSummary & { results?: FindResult[] }, o: { status?: boolean } = {}): string {
  const bits: string[] = [];
  // The same words as a stopped or interrupted repair's (healthCopy.ts runStatusWord), which this file does not
  // import: healthCopy imports it.
  if (o.status !== false && run.status === 'stopped') bits.push(tr('Stopped before it finished'));
  if (o.status !== false && run.status === 'interrupted') bits.push(tr('Interrupted by a restart'));
  const g = run.results ? groupResults(run.results) : null;
  // How far it got, in series it settled with an outcome. Before v0.52.0 the server's `done` counted every series it
  // settled, the one a Stop caught in flight among them, which it lists as not tried; the rest, listed after them, it
  // did not count. So a run over 4 stopped during its first read "1 of 4 series · 4 series not tried", as if one had
  // been searched. The server counts only the series it searched through now, and runs kept from before still read
  // right through this. Reintroduce `run.done` as it is: "a series a stop caught in flight counts as searched" in
  // findSources.test.ts.
  const untriedSettled = g ? Math.max(0, g.notTried.length - Math.max(0, run.results!.length - run.done)) : 0;
  const through = Math.max(0, run.done - untriedSettled);
  if (run.status !== 'done' && run.total > 0 && through > 0) bits.push(tr('{done} of {total} series', { done: Math.min(through, run.total), total: run.total }));
  // A follow is news; "0 sources followed" beside the groups that say why was not. A Replace run's news is its moves.
  const news = newsOf(run, run.results);
  if (news) bits.push(news);
  if (g) {
    // A review's series whose matches still wait for a decision (v0.51.0); a decided one is counted by its follows.
    const open = g.review.filter((r) => r.proposals!.some((p) => !p.state)).length;
    if (open) bits.push(open === 1 ? tr('1 series to review') : tr('{n} series to review', { n: open }));
    const n = g.nothing.length;
    const s = g.skipped.length;
    // Counted from the results rather than `total - done`: a series the server never reached may carry no row.
    const t = g.notTried.length + (cutShort(run.status) ? Math.max(0, run.total - run.results!.length) : 0);
    if (n) bits.push(n === 1 ? tr('Nothing found for 1 series') : tr('Nothing found for {n} series', { n }));
    if (s) bits.push(s === 1 ? tr('1 series skipped') : tr('{n} series skipped', { n: s }));
    if (t) bits.push(t === 1 ? tr('1 series not tried') : tr('{n} series not tried', { n: t }));
  }
  // v0.54.0, Replace: whether the source is done with -- the series still on it, or turned off with none left.
  if (isReplace(run) && run.status !== 'running') {
    if (run.turnedOff) bits.push(run.sourceName ? tr('{name} turned off', { name: `\u2068${run.sourceName}\u2069` }) : tr('The source is turned off'));
    else if (run.left) bits.push(run.left === 1 ? tr('1 series is still on it') : tr('{n} series are still on it', { n: run.left }));
  }
  // Nothing else to say -- a kept run without its results, say, that followed nothing -- and that is what it did.
  if (!bits.length) bits.push(isReplace(run) ? tr('No series moved') : tr('No source followed'));
  return bits.join(' · ');
}

/** The series the run never reached, to search again: its `not_tried` rows. */
export const notTriedIds = (run: FindRun | null | undefined): string[] => groupResults(run?.results).notTried.map((r) => r.seriesId);

/**
 * The kept runs listed under Earlier searches, each a key that opens it in the sheet (v0.52.0, GET ...?runId=): every
 * one but the newest -- the sheet's own view, a key away while another is open -- and the one open now, newest first,
 * at most five. Before, only the newest run could be read in full, so a review-first run with matches still waiting
 * could not be reopened once another search had run.
 */
export function earlierRuns(recent: readonly FindRunSummary[] | null | undefined, open: string | null): FindRunSummary[] {
  const list = recent ?? [];
  return list.filter((r, i) => i > 0 && r.id !== open).slice(0, 5);
}

/**
 * A run as an action's status line (Health's row and card, the results sheet): working with how far it has got and
 * what it is on -- or what it waits for -- then what it did, amber when it stopped, was cut short by a restart or
 * left a series untried; or that it failed.
 */
export function findRunState(run: FindRun | null | undefined, o: { onStop?: () => void; stopping?: boolean; status?: boolean } = {}): ActionState {
  if (!run) return { kind: 'idle' };
  const started = toMs(run.startedAt);
  const finished = toMs(run.finishedAt);
  if (run.status === 'running') {
    const counts = progressLine(run);
    // A sweep, a repair or the daily check owns the sources while it goes, and the run waits for it -- for as long as
    // it takes, with nothing moving: said in the words the slow archive uses for the same three waits. Meanwhile
    // `current` still names the series it asked about last, which is not what it is doing.
    const wait = run.waiting ? waitingText({ why: run.waiting }, null) : '';
    return {
      kind: 'working',
      startedAt: Number.isFinite(started) ? started : Date.now(),
      step: counts || wait || tr('Searching other sources'),
      ...(run.total > 1 ? { progress: Math.min(1, run.done / run.total) } : {}),
      detail: (wait ? (counts ? wait : '') : run.current?.title) || undefined,
      onStop: o.onStop,
      stopping: !!o.stopping,
    };
  }
  const at = Number.isFinite(finished) ? finished : Date.now();
  if (run.status === 'failed') return { kind: 'failed', finishedAt: at, reason: tr('The search failed; the server log says why') };
  const g = groupResults(run.results);
  // An interrupted run has no honest "Took": the server closes it when it comes back up, not when it went down.
  const timed = run.status !== 'interrupted' && Number.isFinite(started) && Number.isFinite(finished);
  return {
    kind: 'done',
    finishedAt: at,
    ...(timed ? { tookMs: finished - started } : {}),
    outcome: findSummary(run, { status: o.status }),
    // A Replace run that left series on its source did not finish the job: amber, as a run cut short is.
    partial: cutShort(run.status) || g.notTried.length > 0 || (isReplace(run) && !!run.left) || undefined,
  };
}

/** One series' outcome in a run: what it followed, or why nothing. Null while the run has not answered for it. */
export function seriesOutcome(run: FindRun | null | undefined, seriesId: string): { text: string; partial?: boolean } | null {
  if (!run) return null;
  const r = run.results?.find((x) => x.seriesId === seriesId);
  // v0.54.0, Replace: what the series' main source is now.
  if (r?.promoted) return { text: tr('Its main source is now {source}', { source: r.promoted.toName }) };
  if (r?.followed?.length) return { text: tr('Followed {source}', { source: r.followed.map((f) => f.name).join(', ') }) };
  // Review first: its matches wait below the key, or were all skipped.
  if (r?.proposals?.length) {
    const open = r.proposals.filter((p) => !p.state).length;
    return open ? { text: open === 1 ? tr('1 match to review') : tr('{n} matches to review', { n: open }) } : { text: tr('No source followed'), partial: true };
  }
  if (r) return { text: findWhyLine(r.why), partial: true };
  // Never reached: a run that stopped, failed or was cut short by a restart before this series, whose results hold no
  // row for it.
  if (run.status === 'running') return null;
  return { text: findWhyLine('not_tried'), partial: true };
}

// ---- following one run ---------------------------------------------------------------------------------

/** What a press did, until its run has been read back (lib/useFindRun.tsx keeps one per key). */
export interface FindSlot {
  phase: 'starting' | 'awaiting' | 'settling' | 'ended' | 'refused' | 'failed';
  runId?: string;
  startedAt: number;
  finishedAt?: number;
  reason?: string;
  stopping?: boolean;
}

/**
 * The status line of the key that started a run: starting, then the run working (with its Stop), then "Checking the
 * result…" while the page is asked again, then what the run did -- or the refusal, or the failure. `run` is the run
 * this slot started, once the status names it.
 */
export function findSlotState(slot: FindSlot | null | undefined, run: FindRun | null | undefined, onStop?: () => void): ActionState {
  if (!slot) return { kind: 'idle' };
  switch (slot.phase) {
    case 'starting': return { kind: 'starting' };
    case 'refused': return { kind: 'refused', reason: slot.reason ?? '' };
    case 'failed': return { kind: 'failed', finishedAt: slot.finishedAt, reason: slot.reason ?? '' };
    case 'settling': return { kind: 'working', startedAt: slot.startedAt, step: tr('Checking the result…') };
    case 'awaiting':
      // Pressed, and the status has not shown the run yet: working, from the press.
      return run?.status === 'running' ? findRunState(run, { onStop, stopping: slot.stopping }) : { kind: 'working', startedAt: slot.startedAt, step: tr('Working…') };
  }
  return run ? findRunState(run) : { kind: 'done', finishedAt: slot.finishedAt ?? Date.now(), outcome: tr('Done') };
}

/**
 * The runs that ended between two answers of GET /api/admin/sources/find:
 * - the one that was running at the last answer and is not now;
 * - one THIS page started (`awaiting`, the ids its POSTs answered) that the answer shows finished -- as the newest
 *   run or among the recent ones. ⚠️ Never merely because it is not the running one: an answer from before the
 *   press does not show it yet, and reading that as "over" put the PREVIOUS run's outcome on the row.
 */
export function findEndedRunIds(prev: FindStatus | null | undefined, next: FindStatus, awaiting: Iterable<string>): string[] {
  const out = new Set<string>();
  const live = next.running && next.run ? next.run.id : null;
  if (prev?.running && prev.run && prev.run.id !== live) out.add(prev.run.id);
  for (const id of awaiting) {
    if (!id || id === live) continue;
    const over = (next.run?.id === id && next.run.status !== 'running') || (next.recent ?? []).some((r) => r.id === id && r.status !== 'running');
    if (over) out.add(id);
  }
  return [...out];
}

/** Whether a find key may start now: never while another run goes -- the server answers `busy` -- and why. */
export function findGate(status: FindStatus | null | undefined, own: boolean): { disabled?: true; disabledWhy?: string } {
  return status?.running && !own ? { disabled: true, disabledWhy: busyLine() } : {};
}

/** The one-run-at-a-time refusal (409 `busy`), as a key's title and a refusal's words. */
export const busyLine = (): string => tr('Another search for other sources is running; this can start when it ends');

/**
 * A refused start in words, by the server's code:
 * - 409 `busy`: another run;
 * - 400 `empty_scope`: no series here the server may search for (none visible, or none whose main source this is);
 * - 400 `bad_request`: a scope the route will not take, which from this page means more than 500 series (bff
 *   routes/findSources.ts: a Library selection, or "Search the {n} series not tried" after a big source's run).
 * ⚠️ The code, never the status: every 400 read "No series to search for", over a selection of 600 too.
 * Anything else is the caller's fallback.
 */
export function startRefusal(status: number | null | undefined, code: string | null | undefined): string | null {
  if (status === 409 || code === 'busy') return busyLine();
  if (code === 'empty_scope') return tr('No series to search for');
  if (code === 'bad_request') return tr('Too many series for one search: 500 at most');
  return null;
}

// ---- review first (v0.51.0) ----------------------------------------------------------------------------

const MODE_KEY = 'uchiyomi.findReview';

/**
 * Whether the start dialog opens on "Review first": the admin's last choice, on this device. Automatic is the
 * default, and storage that throws (a private window) reads as it. Reintroduce the read without its try/catch: "the
 * start dialog remembers the last choice" in findSources.test.ts throws.
 */
export function findReviewFirst(): boolean {
  try { return localStorage.getItem(MODE_KEY) === 'on'; } catch { return false; }
}
export function setFindReviewFirst(on: boolean): void {
  try { if (on) localStorage.setItem(MODE_KEY, 'on'); else localStorage.removeItem(MODE_KEY); } catch { /* a private window */ }
}

/** "13 of our 14 chapters line up · We list 13 of its 15": the line-up both ways, in words. */
export function lineUpText(p: Pick<FindProposal, 'ours' | 'theirs'>): string {
  return [
    tr('{lined} of our {of} chapters line up', { lined: p.ours.lined, of: p.ours.of }),
    tr('We list {lined} of its {of}', { lined: p.theirs.lined, of: p.theirs.of }),
  ].join(' · ');
}

/** Why a match is amber, under it; null for a green one. */
export function amberNote(p: Pick<FindProposal, 'verdict' | 'amber'>): string | null {
  if (p.verdict !== 'amber') return null;
  switch (p.amber) {
    case 'other_name': return tr('Amber: it matched only under another name of this series, not its title. Check the covers before you follow it.');
    // v0.54.0, Replace's review: a source the series already follows, amber for its own reasons.
    case 'cooling': return tr('Amber: this source is cooling down after refusing requests; it is asked again once that ends.');
    case 'coverage': return tr('Amber: it lists only some of this series’ chapters.');
    case 'stale': return tr('Amber: it has not answered for this series lately.');
  }
  return tr('Amber: a name matches, but the chapter numbers do not line up. Follow it only if the covers show the same series.');
}

/**
 * What "Follow all green" follows, in the run's order: every green match not decided yet, of a series the page names.
 * ⚠️ Never an amber one -- each of those is followed on its own, after a look at its covers -- and never one of a
 * series hidden by the 18+ filter, whose covers nobody saw. Reintroduce by dropping the verdict test: "review first:
 * green and amber in words" in findSources.test.ts finds the amber ones followed.
 */
export function greenToFollow(run: Pick<FindRun, 'results'> | null | undefined): Array<{ seriesId: string; sourceId: string }> {
  const out: Array<{ seriesId: string; sourceId: string }> = [];
  for (const r of groupResults(run?.results).review) {
    if (!r.title) continue;
    for (const p of r.proposals!) if (p.verdict === 'green' && !p.state) out.push({ seriesId: r.seriesId, sourceId: p.sourceId });
  }
  return out;
}

/**
 * What "Make all green main" makes main, in the run's order (v0.54.0, Replace's review): for each series the page
 * names, the match the run suggests (`promote`) when it is green and not decided yet -- one per series, since a series
 * has one main source. ⚠️ Never an amber one, and never one of a series hidden by the 18+ filter.
 */
export function greenToPromote(run: Pick<FindRun, 'results'> | null | undefined): Array<{ seriesId: string; sourceId: string }> {
  const out: Array<{ seriesId: string; sourceId: string }> = [];
  for (const r of groupResults(run?.results).review) {
    if (!r.title || r.proposals!.some((p) => p.state === 'promoted')) continue;
    const p = r.proposals!.find((x) => x.promote && x.verdict === 'green' && !x.state);
    if (p) out.push({ seriesId: r.seriesId, sourceId: p.sourceId });
  }
  return out;
}

/**
 * A Make main the server refused (POST …/find/:runId/promote) that its own words do not cover: a match decided already.
 * Every other refusal is the main-source switch's, which the server says itself (`messageSaid`, lib/mainSource.ts).
 */
export function promoteRefusal(code: string | null | undefined): string | null {
  return code === 'decided' ? tr('Made main or skipped already') : null;
}

/** What Make all green main did, as its status line: the moves, and how many the server refused (amber). */
export function promoteOutcome(moved: number, refused: number): { outcome: string; partial?: true } {
  const bits = [moved ? movedText(moved) : tr('No series moved')];
  if (refused) bits.push(refused === 1 ? tr('1 could not be moved') : tr('{n} could not be moved', { n: refused }));
  return { outcome: bits.join(' · '), ...(refused ? { partial: true as const } : {}) };
}

/** A follow or a skip the server refused, by its code (bff routes/findSources.ts); null for anything else. */
export function decideRefusal(code: string | null | undefined): string | null {
  switch (code) {
    case 'decided': return tr('Followed or skipped already');
    case 'posting_order': return findWhyLine('posting_order');
    case 'full': return findWhyLine('full');
    case 'already_followed': return tr('The series follows that source already');
    case 'source_unavailable': return tr('That source is not available for this series right now');
    // v0.52.0 (#123): a match kept from before the language guard, or a series whose language was set since.
    case 'language_differs': return tr('That source is in another language than this series');
    case 'not_found': return tr('That match is no longer in the search');
  }
  return null;
}

/** What Follow all green did, as its status line: the follows, and how many the server refused (amber). */
export function bulkOutcome(followed: number, refused: number): { outcome: string; partial?: true } {
  const bits = [followed ? followedText(followed) : tr('No source followed')];
  if (refused) bits.push(refused === 1 ? tr('1 could not be followed') : tr('{n} could not be followed', { n: refused }));
  return { outcome: bits.join(' · '), ...(refused ? { partial: true as const } : {}) };
}
