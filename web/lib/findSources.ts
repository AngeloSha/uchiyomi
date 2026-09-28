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
 * ⚠️ 'not tried' is not 'not found'. A series the run never reached -- stopped, or out of time -- says so in its
 * own words and its own section, and is offered again; reading it as "no source has it" would send the admin away
 * from a series nobody searched for.
 */
import { keys, t as tr } from './i18n';
import { etaLine } from './format';
import { normTitle } from './normTitle';
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
 * - `no_match`: searched, and no source lists it under its title or other names;
 * - `full`: it already follows as many other sources as a series may;
 * - `refused`: a candidate was found and failed the title and chapter-number judgement;
 * - `not_tried`: a stop or the run's time cut it short -- NOT searched.
 */
export type FindWhy = 'posting_order' | 'no_match' | 'full' | 'refused' | 'not_tried';

export interface FindFollowed { sourceId: string; name: string; chapters: number | null }

export interface FindResult {
  seriesId: string;
  title: string;
  followed: FindFollowed[];
  why?: FindWhy;
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
}

/** The running run, or the newest finished one, with what it did per series. */
export interface FindRun extends FindRunSummary {
  /** The series it is on; left out for one the viewer may not list. */
  current?: { seriesId: string; title: string } | null;
  results: FindResult[];
}

/** GET /api/admin/sources/find. */
export interface FindStatus {
  running: boolean;
  run: FindRun | null;
  recent: FindRunSummary[];
}

/** What POST /api/admin/sources/find takes: some series, or every visible series whose MAIN source is this one. */
export type FindScope = { seriesIds: string[] } | { sourceId: string };

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
 * The most one series takes: the run's 1.5 s pace, plus the non-reporting search's wall (bff lib/sourceHunt.ts
 * HUNT_WALL_MS, 60 s: what has not answered by then is not tried). Waiting for a sweep, a repair or the daily check
 * is on top, and unbounded; the words say the run pauses for them rather than fold them into a number.
 */
export const FIND_SERIES_MAX_MS = 1_500 + 60_000;

/** How long before the press: "Up to 4 hours" for 189 series; per series when the count is not known. */
export function findEta(n: number | null | undefined): string {
  return n && n > 0 ? etaLine({ maxMs: n * FIND_SERIES_MAX_MS }) : tr('Up to about a minute per series');
}

// ---- what a run did ------------------------------------------------------------------------------------

/** One series' reason, in words. `posting_order` is Health's sentence for the same fact (healthCopy GAP_WHY). */
export function findWhyLine(why: string | null | undefined): string {
  switch (why) {
    case 'no_match': return tr('No other source lists it under its title or other names');
    case 'refused': return tr('Found a possible match, but it did not pass the title and chapter-number check');
    case 'full': return tr('Already follows as many other sources as a series may');
    case 'posting_order': return tr('Numbered by posting order: no other source’s numbers line up with it');
    case 'not_tried': return tr('Not tried: the search was stopped or ran out of time before it got there');
  }
  return tr('Nothing found');
}

export interface FindGroups {
  /** Gained at least one source. */
  found: FindResult[];
  /** Searched, and nothing followed: no match, or a match that did not line up. */
  nothing: FindResult[];
  /** Not searched on purpose: numbered by posting order, or no free follower slot. */
  skipped: FindResult[];
  /** Never reached: a stop or the run's time. ⚠️ Its own group, never "nothing found". */
  notTried: FindResult[];
}

/** A run's results in the four groups the results sheet shows, each in the order the run took them. */
export function groupResults(results: readonly FindResult[] | null | undefined): FindGroups {
  const g: FindGroups = { found: [], nothing: [], skipped: [], notTried: [] };
  for (const r of results ?? []) {
    if (r.followed?.length) g.found.push(r);
    else if (r.why === 'not_tried') g.notTried.push(r);
    else if (r.why === 'full' || r.why === 'posting_order') g.skipped.push(r);
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

/**
 * How far a running run has got: "12 of 189 series · 3 sources followed". A run for one series (the Sources sheet's)
 * counts nothing -- "0 of 1 series" says less than the step itself.
 */
export function progressLine(run: Pick<FindRunSummary, 'done' | 'total' | 'followed'>): string {
  const bits: string[] = [];
  if (run.total > 1) bits.push(tr('{done} of {total} series', { done: Math.min(run.done, run.total), total: run.total }));
  if (run.followed > 0) bits.push(followedText(run.followed));
  return bits.join(' · ');
}

/**
 * What a run did, as one line: "40 sources followed · Nothing found for 140 series · 3 series skipped · 6 series not
 * tried", with how far it got first when it did not get to the end ("Stopped before it finished · 50 of 189 series").
 * `status: false` leaves the stop out, where a label beside the line already says it (the results sheet's head).
 * Without results (a `recent` summary) it is the counts the summary carries.
 */
export function findSummary(run: FindRunSummary & { results?: FindResult[] }, o: { status?: boolean } = {}): string {
  const bits: string[] = [];
  // The same words as a stopped repair's (healthCopy.ts runStatusWord), which this file does not import: healthCopy
  // imports it.
  if (run.status === 'stopped' && o.status !== false) bits.push(tr('Stopped before it finished'));
  if (run.status !== 'done' && run.total > 0) bits.push(tr('{done} of {total} series', { done: Math.min(run.done, run.total), total: run.total }));
  bits.push(followedText(run.followed));
  if (run.results) {
    const g = groupResults(run.results);
    const n = g.nothing.length;
    const s = g.skipped.length;
    // Counted from the results rather than `total - done`: a series the server never reached may carry no row.
    const t = g.notTried.length + (run.status === 'stopped' ? Math.max(0, run.total - run.results.length) : 0);
    if (n) bits.push(n === 1 ? tr('Nothing found for 1 series') : tr('Nothing found for {n} series', { n }));
    if (s) bits.push(s === 1 ? tr('1 series skipped') : tr('{n} series skipped', { n: s }));
    if (t) bits.push(t === 1 ? tr('1 series not tried') : tr('{n} series not tried', { n: t }));
  }
  return bits.join(' · ');
}

/** The series the run never reached, to search again: its `not_tried` rows. */
export const notTriedIds = (run: FindRun | null | undefined): string[] => groupResults(run?.results).notTried.map((r) => r.seriesId);

/**
 * A run as an action's status line (Health's row and card, the results sheet): working with how far it has got and
 * what it is on, then what it did -- amber when it stopped or left a series untried -- or why it did not finish.
 */
export function findRunState(run: FindRun | null | undefined, o: { onStop?: () => void; stopping?: boolean; status?: boolean } = {}): ActionState {
  if (!run) return { kind: 'idle' };
  const started = toMs(run.startedAt);
  const finished = toMs(run.finishedAt);
  if (run.status === 'running') {
    return {
      kind: 'working',
      startedAt: Number.isFinite(started) ? started : Date.now(),
      step: progressLine(run) || tr('Searching other sources'),
      ...(run.total > 1 ? { progress: Math.min(1, run.done / run.total) } : {}),
      detail: run.current?.title || undefined,
      onStop: o.onStop,
      stopping: !!o.stopping,
    };
  }
  const at = Number.isFinite(finished) ? finished : Date.now();
  if (run.status === 'failed') return { kind: 'failed', finishedAt: at, reason: tr('The search failed; the server log says why') };
  if (run.status === 'interrupted') return { kind: 'failed', finishedAt: at, reason: tr('Interrupted by a restart') };
  const g = groupResults(run.results);
  return {
    kind: 'done',
    finishedAt: at,
    ...(Number.isFinite(started) && Number.isFinite(finished) ? { tookMs: finished - started } : {}),
    outcome: findSummary(run, { status: o.status }),
    partial: run.status === 'stopped' || g.notTried.length > 0 || undefined,
  };
}

/** One series' outcome in a run: what it followed, or why nothing. Null while the run has not answered for it. */
export function seriesOutcome(run: FindRun | null | undefined, seriesId: string): { text: string; partial?: boolean } | null {
  if (!run) return null;
  const r = run.results?.find((x) => x.seriesId === seriesId);
  if (r?.followed?.length) return { text: tr('Followed {source}', { source: r.followed.map((f) => f.name).join(', ') }) };
  if (r) return { text: findWhyLine(r.why), partial: true };
  // Never reached: a run that stopped (or failed) before this series, whose results hold no row for it.
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
 * A refused start in words: 409 `busy` is another run, 400 an empty scope -- no series here the server may search
 * for (none visible, or none whose main source this is). Anything else is the caller's fallback.
 */
export function startRefusal(status: number | null | undefined, code: string | null | undefined): string | null {
  if (status === 409 || code === 'busy') return busyLine();
  if (status === 400) return tr('No series to search for');
  return null;
}
