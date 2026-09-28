/**
 * The slow archive (#117) as the web app shows it: the rules, with no React in them.
 *
 * The server keeps a queue of SERIES to be fetched slowly (bff lib/archive.ts), and sends it as the `archive`
 * object of GET /api/sources/jobs -- the one ['source-jobs'] query AppShell already polls, so the archive adds
 * no timer of its own. This file turns that object into what Library -> Downloads draws (`archiveItems`), the
 * words for every state it can be in, the add dialog's "Archive the rest slowly" line, and the outcomes of
 * queueing one series or a Library selection.
 *
 * ⚠️ The archive is NOT a download in progress. It takes a chapter every quarter of an hour or so, for days, so
 * it never turns the Library ring, never counts on it, never makes the poll faster and never puts a cover in
 * Running: its home is Queued, as a cover with a STILL amber ring (lib/serverDownloads.ts holds those rules,
 * each with its own test). The owner's call.
 */
import { t as tr } from './i18n';
import { durationText, etaText, untilText } from './format';
import { ringFraction, type RingValue } from './ring';

// ---------------------------------------------------------------------------------------------------------
// The `archive` object, as bff lib/archive.ts ArchiveView sends it.

export type ArchiveState = 'queued' | 'paused' | 'done';

/** Why nothing on the server is being archived right now (bff lib/archivePlan.ts globalWait). */
export type GlobalWaitWhy = 'stopping' | 'paused' | 'window' | 'sweep' | 'repair' | 'check' | 'disk';
/** Why one series waits while the archive as a whole runs (bff lib/archivePlan.ts SeriesWaitWhy). */
export type SeriesWaitWhy =
  | 'turn' | 'break' | 'backoff' | 'source_busy' | 'pace' | 'cooldown' | 'disabled' | 'source_missing'
  | 'series_busy' | 'listing' | 'renumbering';
/** Why a series is under Needs attention rather than Queued (bff lib/archivePlan.ts attentionOf). */
export type ArchiveAttentionWhy = 'backoff' | 'source_missing' | 'disabled' | 'stalled' | 'disk' | 'finished_with_gaps';

/** What a finished archive left behind, and why: given up after retries, waiting for a group, only from a blocked one. */
export interface ArchiveNote { capped: number; held: number; blocked: number }

export interface ArchiveEntry {
  seriesId: string;
  title: string;
  state: ArchiveState;
  /** Which way it fills: `up` oldest first, `down` newest first (from the edge of what the library holds). */
  direction: 'up' | 'down';
  done: number;
  /** What it may still fetch; null until the series' chapter list has been read (and on a finished row). */
  left: number | null;
  failed: number;
  bytes: number;
  /** This viewer queued it: with an admin, who may pause, resume and stop it. */
  mine: boolean;
  current?: { number: number; startedAt: string };
  nextAt?: string;
  etaMs?: number;
  waiting?: { why: SeriesWaitWhy; until?: string; source?: string };
  attention?: { why: ArchiveAttentionWhy; since: string };
  queuedAt: string;
  startedAt: string | null;
  finishedAt?: string;
  note?: ArchiveNote;
}

export interface ArchiveView {
  /** The admin's server-wide pause (Admin -> Settings -> Downloads). */
  paused: boolean;
  perHour: number;
  window: { from: number; to: number } | null;
  waiting?: { why: GlobalWaitWhy; until?: string };
  series: ArchiveEntry[];
}

/** What GET /api/series/:id/listing carries as `archive`: this series' row, or null. */
export interface ListingArchive {
  state: string;
  done: number;
  left: number | null;
  failed: number;
  etaMs?: number;
  nextAt?: string;
  waiting?: ArchiveEntry['waiting'];
  attention?: ArchiveEntry['attention'];
  mine: boolean;
}

/** POST /api/sources/archive's answer, one per series asked for. */
export type EnqueueOutcome = 'queued' | 'already' | 'nothing' | 'unrouted' | 'denied' | 'not_found';
export interface EnqueueResult { id: string; title?: string; outcome: EnqueueOutcome }

// ---------------------------------------------------------------------------------------------------------
// How fast it goes: the server's arithmetic, for an estimate made before the server has timed anything.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * bff lib/archivePace.ts ARCHIVE_DEFAULTS, the parts an estimate needs. ⚠️ A mirror: the web cannot import the
 * server's module, so archive.test.ts pins expectedCycleMs to the server's own numbers, and checks it against
 * the server's function wherever that is in the tree.
 */
export const ARCHIVE_PACE = {
  perHour: 4,
  perHourRange: [1, 30] as [number, number],
  minBreakMs: 45_000,
  longBreakChance: 0.1,
  longBreakMs: [20 * MIN, 45 * MIN] as [number, number],
  longShareMax: 0.5,
};

/**
 * How long one chapter takes to fetch at the slow pace, for an estimate: about twenty pages, each after a gap
 * drawn from 1.5-4 s (2.75 s on average), is just under a minute. The server's own ETA uses the real running
 * average instead, once there is one.
 */
export const TYPICAL_CHAPTER_MS = 60_000;

const clampPerHour = (n: number): number => {
  const v = Number(n);
  if (!Number.isFinite(v)) return ARCHIVE_PACE.perHour;
  return Math.min(ARCHIVE_PACE.perHourRange[1], Math.max(ARCHIVE_PACE.perHourRange[0], v));
};
const cycleMs = (perHour: number): number => HOUR / clampPerHour(perHour);
const shortBreakMean = (base: number, minBreak: number): number => Math.max(base, 1.25 * minBreak);
const meanLongMs = (): number => (ARCHIVE_PACE.longBreakMs[0] + ARCHIVE_PACE.longBreakMs[1]) / 2;

/**
 * How long one chapter's cycle takes on average -- the chapter, its break and the long breaks' share -- at
 * `perHour` for chapters that take `chapterMs`: bff lib/archivePace.ts expectedCycleMs, step for step.
 *
 * Not simply an hour over `perHour`: every chapter is followed by at least 45 seconds' break, so past about
 * 18 an hour the setting names a rate the archive cannot reach, and "30 an hour, 720 a day" would promise
 * nearly a third more than it does.
 */
export function expectedCycleMs(perHour: number, chapterMs: number = TYPICAL_CHAPTER_MS): number {
  const minBreak = ARCHIVE_PACE.minBreakMs;
  const spare = Math.max(0, cycleMs(perHour) - shortBreakMean(0, minBreak));
  const chance = Math.min(ARCHIVE_PACE.longBreakChance, (ARCHIVE_PACE.longShareMax * spare) / meanLongMs());
  const base = Math.max(minBreak, cycleMs(perHour) - Math.max(0, chapterMs || 0) - chance * meanLongMs());
  return Math.max(0, chapterMs || 0) + shortBreakMean(base, minBreak) + chance * meanLongMs();
}

/**
 * About how long `left` chapters take at `perHour`, when the server has not said: each series on a source
 * waits for one chapter of every other series queued there, which a page cannot see, so this is the time for
 * this series alone -- the add dialog's "About 10 days at the current pace".
 */
export function archiveEtaMs(left: number, perHour: number): number {
  return Math.max(0, left) * expectedCycleMs(perHour);
}

/** "About 96 a day per source; 1,000 chapters take about 10 days." -- the Settings row's help, as it is saved. */
export function archivePaceHelp(perHour: number): string {
  const cycle = expectedCycleMs(perHour);
  // At the slowest setting that is 24 a day and 42 days, at the fastest about 580 and 2: never 1 of either.
  return tr('About {n} a day per source; 1,000 chapters take about {d} days.', {
    n: Math.round(DAY / cycle),
    d: Math.max(1, Math.round((1000 * cycle) / DAY)),
  });
}

// ---------------------------------------------------------------------------------------------------------
// What Library -> Downloads draws.

/** One archived series where the Downloads view shows it. */
export interface ArchiveItem {
  seriesId: string;
  title: string;
  entry: ArchiveEntry;
  /**
   * Queued (queued or paused, its own home), Needs attention (a source that keeps refusing or is gone, a full
   * disk, a week paused, finished with chapters left behind), or Came in today (finished with nothing left).
   */
  section: 'queued' | 'attention' | 'today';
  /** done / (done + left), drawn still: the archive never animates a ring. */
  progress: RingValue;
  /**
   * Taking chapters, the breaks between them included: queued, and neither it nor the whole archive paused.
   * The one thing that puts the calm "slow" mark on the Library ring when nothing else is running.
   */
  live: boolean;
  /** What this viewer may do to it: the one who queued it, or an admin (the server refuses anyone else). */
  may: { pause: boolean; resume: boolean; stop: boolean; dismiss: boolean };
}

/**
 * The `archive` object as the Downloads view's items, in the order the server sends them (the order they were
 * queued). The server has already decided what needs attention and which finished rows are still shown (a day,
 * or until dismissed); this places them and says who may do what.
 *
 * Reintroduce by dropping the attention branch: "a source that keeps refusing is under Needs attention" in
 * archive.test.ts finds it in Queued.
 */
export function archiveItems(view: ArchiveView | null | undefined, { admin }: { admin: boolean }): ArchiveItem[] {
  return (view?.series ?? []).map((e) => {
    const own = admin || !!e.mine;
    const section: ArchiveItem['section'] = e.attention ? 'attention' : e.state === 'done' ? 'today' : 'queued';
    return {
      seriesId: e.seriesId,
      title: e.title,
      entry: e,
      section,
      progress: e.state === 'done' ? 1 : e.left == null ? 'spin' : ringFraction(e.done, e.done + e.left),
      live: e.state === 'queued' && !view?.paused,
      may: {
        pause: own && e.state === 'queued',
        resume: own && e.state === 'paused',
        stop: own && e.state !== 'done',
        dismiss: own && e.state === 'done',
      },
    };
  });
}

/** "120 of 900", or how many so far while the chapter list has not been read yet. */
export function archiveProgressText(e: Pick<ArchiveEntry, 'done' | 'left' | 'state'>): string {
  if (e.state === 'done') return e.done === 1 ? tr('Archive finished · 1 chapter') : tr('Archive finished · {n} chapters', { n: e.done });
  if (e.left == null) return e.done === 1 ? tr('1 chapter so far') : tr('{n} chapters so far', { n: e.done });
  return tr('{done} of {total}', { done: e.done, total: e.done + e.left });
}

/** The series page's archive run row adds how far its archive has got: " · 120 of 900". */
export function listingArchiveLine(a: ListingArchive | null | undefined): string {
  if (!a) return '';
  return archiveProgressText({ done: a.done, left: a.left, state: a.state === 'done' ? 'done' : 'queued' });
}

const hh = (h: number): string => `${String(h).padStart(2, '0')}:00`;
const msUntil = (iso: string | undefined, now: number): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t - now : null;
};

/**
 * Why the whole archive, or this one series, is waiting, as a sentence -- every reason the server can send has
 * one here (archive.test.ts walks them all). `view` gives the hours of a window; `now` makes "trying again in 2
 * hours" testable.
 *
 * ⚠️ A window's hours are the SERVER's local time (bff lib/archivePace.ts inWindow), and Docker is often UTC: "only
 * runs between 01:00 and 07:00" read the wrong hours to anyone elsewhere. So the wait says when it opens, relative
 * and the same everywhere -- the server sends `until` with it -- and names the hours only as a fallback, as server
 * time.
 */
export function waitingText(
  w: { why: GlobalWaitWhy | SeriesWaitWhy; until?: string } | null | undefined,
  view: Pick<ArchiveView, 'window'> | null | undefined,
  now: number = Date.now(),
): string {
  if (!w) return '';
  const left = msUntil(w.until, now);
  const when = left !== null && left > 0 ? untilText(left) : null;
  switch (w.why) {
    case 'stopping': return tr('The server is shutting down');
    case 'paused': return tr('Paused for everyone by an admin');
    case 'window': return when ? tr('Outside the hours it may run; it starts again {when}', { when })
      : view?.window ? tr('Only runs between {from} and {to}, server time', { from: hh(view.window.from), to: hh(view.window.to) })
      : tr('Outside the hours it may run');
    case 'sweep': return tr('Waiting for the scheduled check to finish');
    case 'repair': return tr('Waiting for the library repair to finish');
    case 'check': return tr('Waiting for the source check to finish');
    case 'disk': return tr('Waiting for free disk space');
    case 'turn': return tr('Waiting its turn on its source');
    case 'break': return when ? tr('Next chapter {when}', { when }) : tr('Taking a break between chapters');
    case 'backoff': return when ? tr('The site asked us to slow down; trying again {when}', { when }) : tr('The site asked us to slow down');
    case 'source_busy': return tr('Waiting for another download from the same site');
    case 'pace': return tr('The site asked for a slower pace; waiting');
    case 'cooldown': return when ? tr('The site is cooling down; trying again {when}', { when }) : tr('The site is cooling down');
    case 'disabled': return tr('Its source is switched off');
    case 'source_missing': return tr('Its source is not available on this server');
    case 'series_busy': return tr('Waiting for another download of this series');
    // The last read of its chapter list gave nothing; the next is on a ladder -- an hour, 3, 12, then a day
    // (bff lib/archivePlan.ts listingRetryAt).
    case 'listing': return when ? tr('Its chapter list could not be read; trying again {when}', { when }) : tr('Its chapter list could not be read; trying again soon');
    case 'renumbering': return tr('Waiting for its chapters to be renumbered');
    default: return '';
  }
}

/**
 * Why the whole archive waits, as the view should say it: the admin's pause from the `paused` flag, which is the
 * setting itself, and otherwise the scheduler's last reason -- except a `paused` one the flag no longer backs.
 * The reason is what the scheduler found at its last look, so for a moment after Resume all it still says
 * paused; the flag is already right. Reintroduce by returning `view.waiting` as it is: "a stale pause" in
 * archive.test.ts reads "Paused for everyone by an admin" after Resume all.
 */
export function globalWaitOf(view: Pick<ArchiveView, 'paused' | 'waiting'> | null | undefined): ArchiveView['waiting'] {
  if (!view) return undefined;
  if (view.paused) return { why: 'paused' };
  return view.waiting?.why === 'paused' ? undefined : view.waiting;
}

/** What a finished archive left behind, one line per reason, for the sheet. */
export function leftBehindLines(note: ArchiveNote | null | undefined): string[] {
  if (!note) return [];
  const out: string[] = [];
  if (note.capped) out.push(note.capped === 1 ? tr('1 failed too many times') : tr('{n} failed too many times', { n: note.capped }));
  if (note.held) out.push(note.held === 1 ? tr('1 is waiting for a preferred group') : tr('{n} are waiting for a preferred group', { n: note.held }));
  if (note.blocked) out.push(note.blocked === 1 ? tr('1 is only from a blocked group') : tr('{n} are only from a blocked group', { n: note.blocked }));
  return out;
}

/** Why an archive is under Needs attention, as a sentence. */
export function attentionText(e: ArchiveEntry, now: number = Date.now()): string {
  switch (e.attention?.why) {
    case 'finished_with_gaps': {
      const n = e.note ? e.note.capped + e.note.held + e.note.blocked : 0;
      const gaps = n || e.failed;
      return gaps === 1 ? tr('Finished · 1 chapter could not be fetched') : tr('Finished · {n} chapters could not be fetched', { n: gaps });
    }
    case 'backoff': {
      const left = msUntil(e.nextAt ?? e.waiting?.until, now);
      return left !== null && left > 0
        ? tr('The site keeps refusing; trying again {when}', { when: untilText(left) })
        : tr('The site keeps refusing');
    }
    case 'source_missing': return tr('Its source is not available on this server');
    case 'disabled': return tr('Its source is switched off');
    // Two cases share the reason (bff lib/archivePlan.ts attentionOf): a row paused for a week, and a queued one that
    // has had its turns and brought nothing in for three days -- a site that lists nothing for it any more. `since`
    // is when it last brought something in.
    case 'stalled': {
      if (e.state === 'paused') return tr('Paused for over a week');
      const since = Date.parse(e.attention?.since ?? '');
      return Number.isFinite(since) && now > since
        ? tr('Nothing has come in for {d}', { d: durationText(now - since) })
        : tr('Nothing has come in for days');
    }
    case 'disk': return tr('Waiting for free disk space');
    default: return '';
  }
}

/**
 * The line under a cover and in the series band: paused, the chapter coming in, why it waits, else how long is
 * left. The ETA is the server's (built from how long its chapters really took), never recomputed here.
 */
export function archiveStateText(item: ArchiveItem, view: Pick<ArchiveView, 'paused' | 'waiting' | 'window'> | null | undefined, now: number = Date.now()): string {
  const e = item.entry;
  // Under Needs attention it can still be taking a chapter -- the retry after a backoff: said first, or the one
  // chapter coming in was nowhere but the sheet.
  if (item.section === 'attention') return [e.current ? tr('Fetching Ch. {n}', { n: e.current.number }) : '', attentionText(e, now)].filter(Boolean).join(' · ');
  if (e.state === 'done') return '';
  if (e.state === 'paused') return tr('Paused');
  if (view?.paused) return tr('Paused for everyone');
  if (e.current) return tr('Fetching Ch. {n}', { n: e.current.number });
  const everyone = globalWaitOf(view);
  if (everyone) return waitingText(everyone, view, now);
  if (e.etaMs != null) return etaText(e.etaMs);
  return waitingText(e.waiting, view, now);
}

// ---------------------------------------------------------------------------------------------------------
// Where a person turns it on.

/** The add dialog's chapter pick, as far as the archive cares: nothing now, the first N, or the latest N. */
export type AddPick = 'none' | 'first' | 'latest';

/**
 * The add dialog's line under "Archive the rest slowly": how many come in, in which order, and about how
 * long that takes at the server's pace. `rest` is what the pick leaves: every listed chapter for "Nothing yet",
 * the listing less the pick otherwise. The order is the server's (bff lib/archivePlan.ts directionFor): with
 * nothing held, or the first N held, it fills upward from the oldest; with the latest N held it grows down
 * from their edge, newest first, so the series never has a hole in the middle.
 */
export function archiveSwitchHelp(pick: AddPick, rest: number, perHour: number): string {
  const n = Math.max(0, Math.floor(rest));
  const count = pick === 'none'
    ? (n === 1 ? tr('1 chapter comes in slowly in the background.') : tr('{n} chapters come in slowly in the background.', { n }))
    : pick === 'first'
      ? (n === 1 ? tr('1 more chapter comes in slowly in the background.') : tr('{n} more chapters come in slowly in the background.', { n }))
      : (n === 1 ? tr('1 older chapter comes in slowly in the background.') : tr('{n} older chapters come in slowly in the background.', { n }));
  const order = n > 1 ? (pick === 'latest' ? tr('Newest first.') : tr('Oldest first.')) : '';
  const eta = tr('{eta} at the current pace.', { eta: etaText(archiveEtaMs(n, perHour)) });
  return [count, order, eta].filter(Boolean).join(' ');
}

/**
 * The add dialog's done step: what became of "Archive the rest slowly" (POST /api/sources/add `archive`).
 * `whole` is a "Nothing yet" add, where the rest is every chapter.
 */
export function archiveAddLine(outcome: EnqueueOutcome | 'later' | null | undefined, whole = false): string {
  switch (outcome) {
    case undefined: case null: return '';
    // `later`: the add's own chapters download first, and the rest is queued once they are in.
    case 'queued': case 'later': return whole
      ? tr('Its chapters come in slowly in the background. Library → Downloads shows how far it has got.')
      : tr('The rest comes in slowly in the background. Library → Downloads shows how far it has got.');
    case 'already': return tr('The rest was already being archived slowly.');
    case 'nothing': return tr('Nothing older was left to archive.');
    default: return tr('The rest could not be queued for the slow archive.');
  }
}

export type Tone = 'success' | 'info' | 'error';

/** One series queued from its page or its card menu: the notice for its one outcome. */
export function archiveOutcomeNotice(outcome: EnqueueOutcome | undefined, title: string): { msg: string; tone: Tone } {
  switch (outcome) {
    case 'queued': return { msg: tr('Archiving {title} slowly', { title }), tone: 'success' };
    case 'already': return { msg: tr('Already being archived slowly'), tone: 'info' };
    case 'nothing': return { msg: tr('Nothing older to fetch'), tone: 'info' };
    case 'unrouted': return { msg: tr('This series has no source to fetch from'), tone: 'error' };
    case 'denied': return { msg: tr('Not available on this account'), tone: 'error' };
    default: return { msg: tr('That series is no longer in the library'), tone: 'error' };
  }
}

/**
 * A Library selection queued: one notice for all of it, "12 series queued for the slow archive · 3 had nothing
 * older to fetch". Error tone only when nothing at all was queued or already being archived.
 */
export function archiveBulkNotice(results: readonly EnqueueResult[]): { msg: string; tone: Tone } {
  const n = (o: EnqueueOutcome[]) => results.filter((r) => o.includes(r.outcome)).length;
  const queued = n(['queued']);
  const already = n(['already']);
  const nothing = n(['nothing']);
  const failed = n(['unrouted', 'denied', 'not_found']);
  const parts: string[] = [];
  if (queued) parts.push(queued === 1 ? tr('1 series queued for the slow archive') : tr('{n} series queued for the slow archive', { n: queued }));
  if (already) parts.push(already === 1 ? tr('1 already being archived') : tr('{n} already being archived', { n: already }));
  if (nothing) parts.push(nothing === 1 ? tr('1 had nothing older to fetch') : tr('{n} had nothing older to fetch', { n: nothing }));
  if (failed) parts.push(failed === 1 ? tr('1 could not be queued') : tr('{n} could not be queued', { n: failed }));
  return { msg: parts.join(' · ') || tr('Nothing older to fetch'), tone: queued || already ? 'success' : nothing && !failed ? 'info' : 'error' };
}

/** How many series POST /api/sources/archive takes in one request (the route's ARCHIVE_MAX_SERIES). */
export const ARCHIVE_MAX_SERIES = 500;
