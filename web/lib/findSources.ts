/**
 * Find other sources, and the other names a series goes by: the part with no React in it, so a test can hold the
 * words and the rules.
 *
 * An admin asks the server to look for other sources for every series of a source (Health), for a selection
 * (Library), or for one series (Sources & translations). ONE calm search at a time on the server -- 1.5 s between
 * series, pausing for a chapter sweep, a repair or the daily check -- that PROPOSES: nothing is followed until the
 * admin confirms it on the search's review page (app/admin/find/page.tsx). A green match is one autoFollow's
 * judgement would follow (a name matches and the chapter numbers line up both ways); an amber one has exactly the
 * same name and chapter numbers that do not line up, and is only ever followed on its own, from its chapter list.
 *
 * The idea, the review and the other-names list are @TIGamingTV's (PR #119), on the server's own follow rules (bff
 * lib/findSources.ts, lib/autoFollow.ts).
 */
import { keys, t as tr } from './i18n';
import { etaLine } from './format';
import { normTitle } from './normTitle';
import { waitingText } from './archive';
import type { ActionState } from './actionState';

// ---- the other names (bff routes: /api/admin/series/:id/alt-titles) ------------------------------------------

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

// ---- the server's shapes (bff routes/findSources.ts) ----------------------------------------------------------

/**
 * `running`: searching. `stopped` and `interrupted`: cut short by a stop or a restart, what it found kept, resumable.
 * `review`: candidates wait. `linking`: following what was confirmed. `done`: nothing left open.
 */
export type FindRunStatus = 'running' | 'stopped' | 'interrupted' | 'review' | 'linking' | 'done' | 'failed';

/** A kept run. Times are the server's: an ISO string, or epoch ms. */
export interface FindRunSummary {
  id: string;
  status: FindRunStatus;
  total: number;
  /** Series settled: searched, or skipped before any search. */
  done: number;
  /** Series it found at least one match for. */
  found: number;
  /** Matches waiting for a decision. */
  open: number;
  followed: number;
  failed: number;
  startedBy: string | null;
  startedAt: string | number;
  finishedAt?: string | number | null;
  sourceId?: string;
  sourceName?: string;
}

/** A run with what it is doing while it searches. */
export interface FindRun extends FindRunSummary {
  /** The series it is on; left out for one the viewer may not list. */
  current?: { seriesId: string; title: string } | null;
  /** What a searching run waits on before its next series: a chapter sweep, a repair or the daily source check. */
  waiting?: 'sweep' | 'repair' | 'check' | null;
}

/** GET /api/admin/sources/find. */
export interface FindStatus {
  running: boolean;
  run: FindRun | null;
  recent: FindRun[];
}

/** What POST /api/admin/sources/find takes: some series, or every visible series whose MAIN source is this one. */
export type FindScope = { seriesIds: string[] } | { sourceId: string };

/** `ok`: green, followed in bulk. `numbering_differs`: amber, the same name, followed only on its own. */
export type FindVerdict = 'ok' | 'numbering_differs';
/** Why a series was not searched. */
export type FindNote = 'posting_order' | 'full' | 'too_few' | 'no_source';

export interface FindCandidate {
  id: string;
  itemId: string;
  source: string;
  name: string;
  sourceSeriesId: string;
  theirTitle: string | null;
  cover: string | null;
  ourName: string | null;
  theirName: string | null;
  coverageFwd: number | null;
  coverageBack: number | null;
  verdict: FindVerdict;
  manual: boolean;
  /** Null while it is open; else what became of it. */
  status: string | null;
}

export interface FindItem {
  id: string;
  seriesId: string;
  title: string;
  names: string[];
  state: 'pending' | 'done' | 'skipped' | 'error';
  note?: FindNote | null;
  asked: number;
  unreachable: number;
  primary: { source: string; name: string } | null;
  following: { source: string; name: string }[];
  freeSlots: number;
  candidates: FindCandidate[];
}

/** GET /api/admin/sources/find/:id. */
export interface FindReview {
  run: FindRun & { maxFollowers?: number };
  hidden: number;
  items: FindItem[];
}

/** GET /api/admin/sources/find/items/:id/chapters: what a candidate lists, beside what the series has. */
export interface FindChapters {
  source: string;
  name: string;
  title: string | null;
  count: number;
  ourCount: number;
  shared: number;
  /** Numbers the series has that this source does not list. */
  missing: number[];
  chapters: { number: number; title: string | null; scanlator: string | null; publishedAt: string | null; ours: boolean }[];
}

/** Where a run's review is. The trailing slash is load-bearing (next.config.mjs `trailingSlash: true`). */
export const reviewHref = (runId: string): string => `/admin/find/?run=${encodeURIComponent(runId)}`;

// ---- how long ------------------------------------------------------------------------------------------

/**
 * The most one series takes: the search's 1.5 s pace, plus its wall per series (bff lib/findSources.ts
 * FIND_SERIES_WALL_MS, 120 s). Waiting for a sweep, a repair or the daily check is on top, and unbounded; the words
 * say the search pauses for them rather than fold them into a number.
 */
export const FIND_SERIES_MAX_MS = 1_500 + 120_000;

/** How long before the press: "Up to 7 hours" for 189 series; per series when the count is not known. */
export function findEta(n: number | null | undefined): string {
  return n && n > 0 ? etaLine({ maxMs: n * FIND_SERIES_MAX_MS }) : tr('Up to about two minutes per series');
}

// ---- what a run did ------------------------------------------------------------------------------------

/** Epoch ms of a server time, ISO or number; NaN when there is none. */
export const toMs = (t: string | number | null | undefined): number =>
  typeof t === 'number' ? t : t ? Date.parse(t) : NaN;

/** "1 source followed", "{n} sources followed". */
export const followedText = (n: number): string =>
  (n === 1 ? tr('1 source followed') : tr('{n} sources followed', { n }));

/** "Sources found for 1 series", "Sources found for {n} series": what a search turned up, before anything is followed. */
export const foundText = (n: number): string =>
  (n === 1 ? tr('Sources found for 1 series') : tr('Sources found for {n} series', { n }));

/** "1 match to review", "{n} matches to review". */
export const openText = (n: number): string =>
  (n === 1 ? tr('1 match to review') : tr('{n} matches to review', { n }));

/** How far a searching run has got: "12 of 189 series · Sources found for 3 series". A run of one series counts nothing. */
export function progressLine(run: Pick<FindRunSummary, 'done' | 'total' | 'found'>): string {
  const bits: string[] = [];
  if (run.total > 1) bits.push(tr('{done} of {total} series', { done: Math.min(run.done, run.total), total: run.total }));
  if (run.found > 0) bits.push(foundText(run.found));
  return bits.join(' · ');
}

/** A search that did not get to its end: what it found stands, and it can go on. */
export const cutShort = (status: FindRunStatus): boolean => status === 'stopped' || status === 'interrupted';

/**
 * What a run did, as one line: "Stopped before it finished · 50 of 189 series · Sources found for 40 series · 52
 * matches to review · 3 sources followed". `status: false` leaves the first words out where a label beside the line
 * already says them.
 */
export function findSummary(run: FindRunSummary, o: { status?: boolean } = {}): string {
  const bits: string[] = [];
  if (o.status !== false && run.status === 'stopped') bits.push(tr('Stopped before it finished'));
  if (o.status !== false && run.status === 'interrupted') bits.push(tr('Interrupted by a restart'));
  if (run.done < run.total) bits.push(tr('{done} of {total} series', { done: run.done, total: run.total }));
  bits.push(run.found > 0 ? foundText(run.found) : tr('Nothing found'));
  if (run.open > 0) bits.push(openText(run.open));
  if (run.followed > 0) bits.push(followedText(run.followed));
  return bits.join(' · ');
}

/**
 * A run as an action's status line (Health's row and card, Server tasks): working with how far it has got and what it
 * is on -- or what it waits for -- then what it found, amber when it was cut short or waits for a review.
 */
export function findRunState(run: FindRun | null | undefined, o: { onStop?: () => void; stopping?: boolean; status?: boolean } = {}): ActionState {
  if (!run) return { kind: 'idle' };
  const started = toMs(run.startedAt);
  const finished = toMs(run.finishedAt);
  if (run.status === 'running') {
    const counts = progressLine(run);
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
  const timed = run.status !== 'interrupted' && Number.isFinite(started) && Number.isFinite(finished);
  return {
    kind: 'done',
    finishedAt: at,
    ...(timed ? { tookMs: finished - started } : {}),
    outcome: findSummary(run, { status: o.status }),
    partial: cutShort(run.status) || run.open > 0 || undefined,
  };
}

/** Whether a find key may start now: never while another search runs -- the server answers `busy` -- and why. */
export function findGate(status: FindStatus | null | undefined, own = false): { disabled?: true; disabledWhy?: string } {
  return status?.running && !own ? { disabled: true, disabledWhy: busyLine() } : {};
}

/** The one-search-at-a-time refusal (409 `busy`), as a key's title and a refusal's words. */
export const busyLine = (): string => tr('Another search for other sources is running; this can start when it ends');

/**
 * A refused start in words, by the server's code: 409 `busy` (another search), 400 `empty_scope` (nothing here the
 * server may search for), `too_many` (more than 500 series). Anything else is the caller's fallback.
 */
export function startRefusal(status: number | null | undefined, code: string | null | undefined): string | null {
  if (code === 'busy' || (status === 409 && !code)) return busyLine();
  if (code === 'empty_scope') return tr('No series to search for');
  if (code === 'too_many') return tr('Too many series for one search: 500 at most');
  return null;
}

// ---- the review ----------------------------------------------------------------------------------------

/**
 * Chapter numbers as runs: [1,2,3,5,7,8] -> "1–3, 5, 7–8". Whole numbers join a run; a decimal (12.5) stands alone.
 * At most `max` parts, then "+ {n} more", so a source missing 300 scattered numbers stays one line.
 */
export function ranges(nums: number[], max = 12): string {
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && Number.isInteger(sorted[j]) && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return parts.length > max ? `${parts.slice(0, max).join(', ')} ${tr('+ {n} more', { n: parts.length - max })}` : parts.join(', ');
}

/** A match that is still waiting for a decision. */
export const isOpen = (c: Pick<FindCandidate, 'status'>): boolean => !c.status;

/**
 * Whether a bulk follow takes this match -- bff lib/findSources.ts `mayFollow`, word for word: only green. There is
 * no bulk override; an amber one is followed on its own from its chapter list.
 */
export const mayFollow = (c: Pick<FindCandidate, 'verdict'>): boolean => c.verdict === 'ok';

/**
 * What "Select exact matches" ticks: per series, its open green matches, best-covered first, as many as it has free
 * places. An amber one is never ticked for anyone: following one is a decision, not a default.
 */
export function preselect(items: readonly FindItem[]): Set<string> {
  const out = new Set<string>();
  for (const it of items) {
    const ok = it.candidates.filter((c) => isOpen(c) && mayFollow(c))
      .sort((a, b) => Math.min(b.coverageFwd ?? 0, b.coverageBack ?? 0) - Math.min(a.coverageFwd ?? 0, a.coverageBack ?? 0));
    for (const c of ok.slice(0, it.freeSlots)) out.add(c.id);
  }
  return out;
}

/** How many of a series' matches are ticked; an unticked box locks once they fill its free places. */
export const pickedFor = (it: Pick<FindItem, 'candidates'>, selected: ReadonlySet<string>): number =>
  it.candidates.filter((c) => selected.has(c.id)).length;

/** A match's verdict, beside its source. */
export const verdictLabel = (v: FindVerdict | string): string =>
  (v === 'ok' ? tr('Same series') : tr('Chapter numbers differ'));
export const verdictColor = (v: FindVerdict | string): string => (v === 'ok' ? 'text-emerald-400' : 'text-amber-400');

/** Both shares as the row prints them: "Has 98% of this series' chapters · this series has 95% of its". */
export function coverageLine(c: Pick<FindCandidate, 'coverageFwd' | 'coverageBack'>): string | null {
  if (c.coverageFwd == null || c.coverageBack == null) return null;
  return tr('Has {a}% of this series’ chapters · this series has {b}% of its', { a: Math.round(c.coverageFwd * 100), b: Math.round(c.coverageBack * 100) });
}

/** What became of a match. Every branch a literal, so the locale files see each. */
export function candidateStatusLabel(status: string): string {
  switch (status) {
    case 'linked': return tr('Followed');
    case 'already_followed': return tr('Already followed');
    case 'cap': return tr('Not followed: already follows as many other sources as a series may');
    case 'primary': return tr('Not followed: it is this series’ main source');
    case 'posting_order': return tr('Not followed: this series is numbered by posting order');
    case 'gone': return tr('Not followed: the series is no longer in the library');
    case 'unavailable': return tr('Not followed: that source is switched off or not installed');
  }
  return tr('Could not follow it');
}
export const candidateStatusColor = (status: string): string =>
  (status === 'linked' || status === 'already_followed' ? 'text-emerald-400' : 'text-rose-300');

/** Why a series was not searched, or what its search found when it found nothing. */
export function itemLine(it: Pick<FindItem, 'state' | 'note' | 'asked' | 'unreachable' | 'candidates'>): string | null {
  if (it.state === 'pending') return tr('Not searched yet');
  if (it.state === 'error') return tr('This series could not be read: it may have been removed or merged');
  if (it.state === 'skipped') {
    switch (it.note) {
      case 'posting_order': return tr('Numbered by posting order: no other source’s numbers line up with it');
      case 'full': return tr('Already follows as many other sources as a series may');
      case 'too_few': return tr('Too few chapters to compare (fewer than 3)');
      case 'no_source': return tr('No other source could be asked');
    }
    return tr('Not searched');
  }
  if (it.candidates.length) return null;
  if (it.asked > 0 && it.unreachable >= it.asked) return tr('No other source answered');
  return tr('No other source lists it under its title or other names');
}

/** "1 source did not answer", "{n} sources did not answer": beside a series nothing was found for. */
export const unreachableText = (n: number): string =>
  (n === 1 ? tr('1 source did not answer') : tr('{n} sources did not answer', { n }));

/** A run's status as its review's head says it. */
export function runStatusLine(s: FindRunStatus): string {
  switch (s) {
    case 'running': return tr('Searching other sources');
    case 'stopped': return tr('Stopped before it finished');
    case 'interrupted': return tr('Interrupted by a restart');
    case 'review': return tr('Ready to review');
    case 'linking': return tr('Following…');
    case 'done': return tr('Done');
    case 'failed': return tr('The search failed; the server log says why');
  }
}

/**
 * A refused follow, pick, resume or discard in words, by the server's code. Null for a code it does not know, which
 * the caller says with the server's own message.
 */
export function findRefusalLine(code: string | null | undefined, theirTitle?: string | null): string | null {
  switch (code) {
    case 'gone': return tr('That series is no longer in the library.');
    case 'posting_order': return tr('Numbered by posting order: no other source’s numbers line up with it');
    case 'full': case 'cap': return tr('Already follows as many other sources as a series may');
    case 'too_few': return tr('Too few chapters to compare (fewer than 3)');
    case 'already_followed': return tr('This series already reads from that source.');
    case 'primary': return tr('Not followed: it is this series’ main source');
    case 'unknown_source': return tr('That source is not installed.');
    case 'unavailable': return tr('That source is switched off or cooling down right now.');
    case 'unreachable': return tr('That source did not answer. Try again in a moment.');
    case 'title_differs': return theirTitle
      ? tr('None of its names is one of this series’ names: it is called “{title}”.', { title: theirTitle })
      : tr('None of its names is one of this series’ names.');
    case 'not_this_series': return tr('Its title only contains this series’ title, and its chapters do not line up: most likely a sequel or a spin-off.');
    case 'changed': return tr('That source no longer lists it under a name of this series.');
    case 'closed': return tr('That match was already dealt with.');
    case 'busy': return tr('This search is busy right now. Try again in a moment.');
    case 'still_searching': return tr('Stop the search, or wait for it to finish, first.');
    case 'not_followable': return tr('The chapters of what you selected do not line up. Open its chapters to follow one on its own.');
    case 'nothing_to_follow': return tr('Nothing selected is waiting to be followed.');
    case 'not_resumable': return tr('Every series of this search has been searched.');
    case 'not_found': return tr('That search is gone.');
  }
  return null;
}
