// The slow archive's decisions (#117) that need no database: which way a series is filled, where its boundary
// sits, why the whole archive or one series is waiting, what needs a person's attention, when a listing that
// could not be read is read again, how much of a cycle was not the archive's own pace, and which rows a viewer
// is shown.
//
// lib/archive.ts owns the state -- the queue, the per-source pace rows, the chapters in flight -- and asks
// these functions what the state means. They take everything as arguments (the clock included), so the unit
// tests pin the gate order and the wording keys without a Postgres, the same split as archivePace.ts, which
// owns the numbers.

/** Which way the archive walks a series' missing numbers, decided once when it is queued. */
export type ArchiveDirection = 'up' | 'down';

/**
 * Which way to fill a series, from the lowest LISTED number the library holds (`heldMin`) and the lowest
 * listed number it could fetch (`listedMin`).
 *
 * The design gave a rule ("nothing held below the boundary: up") and a reason beside it ("Latest-N grows down
 * from its own edge") that disagree: a Latest-N add is floored AT its lowest held number, so nothing is held
 * below the boundary and the rule says up. The reason wins, stated so it cannot disagree again:
 *
 * - Nothing held at all ('Nothing yet', or a series whose files all went): up, reading order, so a person can
 *   start at chapter one within the first break.
 * - The library already holds the top and not the start (Latest-N, or a catalogue the scanner found half of):
 *   down from the held block's own edge. Every chapter that lands then touches the block, so the series never
 *   has an interior hole and Health never reports a gap the archive is about to close.
 * - It holds the start: up, continuing where the reading order already is.
 *
 * `heldMin` counts only numbers the listing has, so an unlisted prologue at 0.5 does not turn a Latest-N
 * series into an upward fill with a hole the size of its back catalogue.
 */
export function directionFor(o: { heldMin: number | null | undefined; listedMin: number | null | undefined }): ArchiveDirection {
  if (o.heldMin == null || o.listedMin == null) return 'up';
  return o.heldMin > o.listedMin ? 'down' : 'up';
}

/**
 * Where the archive's work ends and the sweep's begins: the archive owns listed numbers strictly below it.
 *
 * The series' own floor when it has one -- a Latest-N add already says "the sweep's scope starts here" -- else
 * a hair above the newest listed number, the same `max + 0.001` a "Nothing yet" add floors at
 * (routes/sources.ts), so every number listed today is the archive's and the next release is the sweep's.
 * Null when there is no listing yet: the first pick refreshes it and asks again.
 */
export function boundaryFor(o: { floor: number | null | undefined; listedMax: number | null | undefined }): number | null {
  if (o.floor != null && Number.isFinite(o.floor)) return o.floor;
  if (o.listedMax != null && Number.isFinite(o.listedMax)) return o.listedMax + 0.001;
  return null;
}

/**
 * Why nothing on this server is being archived right now. `check` is the daily source check (or Check all
 * now), which walks every source in turn and would meet the archive on the one it is pacing.
 */
export type GlobalWaitWhy = 'stopping' | 'paused' | 'window' | 'sweep' | 'repair' | 'check' | 'disk';
export interface GlobalWait { why: GlobalWaitWhy; until?: number }

/**
 * The server-wide gates, in the order a person would want to hear them: a shutdown and the admin's own pause
 * first, since nothing else matters while they hold; then the hours it may run in; then the bounded jobs it
 * yields to; then the disk.
 *
 * `freeBytes` null is "cannot measure", and a guard that cannot measure must not stop everything -- the same
 * fail-open rule as the downloader's own floor (lib/downloader.ts).
 */
export function globalWait(o: {
  stopping: boolean; paused: boolean;
  windowFrom: number | null; windowTo: number | null; hour: number; now: number;
  opensAt?: (now: number, from: number) => number;
  inWindow: (hour: number, from: number | null, to: number | null) => boolean;
  updating: boolean; repairing: boolean; checking: boolean;
  freeBytes: number | null; minFreeGb: number;
}): GlobalWait | null {
  if (o.stopping) return { why: 'stopping' };
  if (o.paused) return { why: 'paused' };
  if (!o.inWindow(o.hour, o.windowFrom, o.windowTo)) {
    return { why: 'window', ...(o.opensAt && o.windowFrom != null ? { until: o.opensAt(o.now, o.windowFrom) } : {}) };
  }
  if (o.updating) return { why: 'sweep' };
  if (o.repairing) return { why: 'repair' };
  if (o.checking) return { why: 'check' };
  if (o.freeBytes !== null && o.minFreeGb > 0 && o.freeBytes < o.minFreeGb * 2 ** 30) return { why: 'disk' };
  return null;
}

/**
 * Why one series is waiting while the archive as a whole is running.
 *
 * - `turn`: another series on its source has the source's one slot, or the archive already has as many
 *   sources in flight as it may.
 * - `break`: its source is between chapters (archive_pace.next_at).
 * - `backoff`: its source refused a chapter and is being left alone (archive_pace.backoff_until).
 * - `source_busy`: somebody else's download is on its source's gate -- a person's Fetch, an add, a bulk run.
 * - `pace`: its source answered 429 recently and the downloader has slowed it (lib/pace.ts).
 * - `cooldown`: its source is in the server's own back-off (source_health.blocked_until).
 * - `disabled` / `source_missing`: the admin switched its source off, or no adapter is loaded for it.
 * - `series_busy`: a download for the series itself is running (a Fetch, an add's own loop).
 * - `listing`: its listing has to be read before its next chapter, and the last read gave none (the site failed,
 *   or lists nothing for it): it is read again at `until`, further apart each time (listingRetryAt).
 * - `renumbering`: a renumber (#116) is pending for the series; its numbers are about to change.
 */
export type SeriesWaitWhy =
  | 'turn' | 'break' | 'backoff' | 'source_busy' | 'pace' | 'cooldown' | 'disabled' | 'source_missing'
  | 'series_busy' | 'listing' | 'renumbering';
export interface SeriesWait { why: SeriesWaitWhy; until?: number; source?: string }

/** What a source looks like to the archive at one tick. Everything is read once per source per tick. */
export interface SourceState {
  loaded: boolean;
  disabled: boolean;
  /** source_health.blocked_until, ms, when it is in the future. */
  blockedUntil: number | null;
  /** Chapters on the source's download gate, running or waiting (lib/gate.ts gateDepth). */
  gate: { active: number; queued: number };
  /** lib/pace.ts paceLevel. */
  paceLevel: number;
  /** archive_pace, ms. */
  nextAt: number | null;
  backoffUntil: number | null;
  /** An archive chapter is in flight on it now. */
  inFlight: boolean;
}

/**
 * The per-source gates, in order: the archive's own slot, then its own rest (a backoff before a break, since
 * a backoff is the longer and the more telling), then everybody else's claims on the site, then whether the
 * site can be asked at all. The first that holds is the reason. Null: the source may take a chapter now.
 */
export function sourceWait(s: SourceState, now: number): Omit<SeriesWait, 'source'> | null {
  if (s.inFlight) return { why: 'turn' };
  if (s.backoffUntil != null && s.backoffUntil > now) return { why: 'backoff', until: s.backoffUntil };
  if (s.nextAt != null && s.nextAt > now) return { why: 'break', until: s.nextAt };
  if (!s.loaded) return { why: 'source_missing' };
  if (s.disabled) return { why: 'disabled' };
  if (s.blockedUntil != null && s.blockedUntil > now) return { why: 'cooldown', until: s.blockedUntil };
  if (s.gate.active + s.gate.queued > 0) return { why: 'source_busy' };
  if (s.paceLevel > 0) return { why: 'pace' };
  return null;
}

/** Why a queued series belongs under Needs attention rather than Queued. */
export type AttentionWhy = 'backoff' | 'source_missing' | 'disabled' | 'stalled' | 'disk' | 'finished_with_gaps';
export interface Attention { why: AttentionWhy; since: number }

/** A paused archive this old is flagged: paused and forgotten, it hides the back catalogue from the sweep. */
export const STALLED_MS = 7 * 24 * 3600_000;
/**
 * A queued archive that has kept taking its turns this long with nothing to show for them is flagged: every
 * read of its listing failed, or every chapter it asked for did.
 */
export const NO_PROGRESS_MS = 3 * 24 * 3600_000;
/** A source missing or switched off this long is flagged. Shorter is an extension reload, or an admin's minute. */
export const SOURCE_GONE_MS = 24 * 3600_000;

/** What finished with something left behind, and why each was left. */
export interface DoneNote { capped: number; held: number; blocked: number }

/**
 * Needs attention, or not. A finished archive with anything left behind stays there until dismissed (DELETE);
 * a queued one is flagged when the disk floor has stopped everything, when its source has been gone or switched
 * off for a day, when its source keeps refusing (two in a row: one refusal is one bad hour), or when it has made
 * no progress for three days although it had its turns; a paused one after a week.
 *
 * `progressSince`: when the series last moved forward -- a chapter came in, its first listing placed the
 * boundary, it was queued or resumed. `lastTurnAt`: when it last had its source's turn (archive_queue.last_at).
 * ⚠️ A turn is not progress: every read of a listing that keeps failing, and every chapter that keeps failing,
 * is a turn, and counting turns as progress is how a series that asked its site for a dead listing once a
 * minute for days looked healthy. But a series that has had NO turn since its last progress is waiting behind
 * the others on its source -- five hundred series on one site at four an hour take days each to come round --
 * which is the archive working as the admin set it, not a stall.
 *
 * ⚠️ `waitSince` is kept in memory, so a restart starts a missing source's day again. Flagged a day late after a
 * restart is the price; flagged at once, every extension reload put series under Needs attention.
 */
export function attentionOf(o: {
  state: 'queued' | 'paused' | 'done';
  now: number;
  failed: number;
  note: Partial<DoneNote> | null | undefined;
  finishedAt: number | null;
  pausedAt: number | null;
  backoffLevel: number;
  backoffSince: number | null;
  wait: SeriesWait | null | undefined;
  waitSince: number | null;
  global: GlobalWait | null | undefined;
  progressSince: number | null;
  lastTurnAt: number | null;
}): Attention | null {
  if (o.state === 'done') {
    const gaps = (o.note?.capped ?? 0) + (o.note?.held ?? 0) + (o.note?.blocked ?? 0);
    return o.failed > 0 || gaps > 0 ? { why: 'finished_with_gaps', since: o.finishedAt ?? o.now } : null;
  }
  if (o.state === 'paused') {
    return o.pausedAt != null && o.now - o.pausedAt >= STALLED_MS ? { why: 'stalled', since: o.pausedAt } : null;
  }
  if (o.global?.why === 'disk') return { why: 'disk', since: o.waitSince ?? o.now };
  // Reintroduce by dropping the age check: "a series whose source is gone waits, and says so" in
  // archive.int.test.ts flags it on the first look.
  if ((o.wait?.why === 'source_missing' || o.wait?.why === 'disabled') && o.waitSince != null && o.now - o.waitSince >= SOURCE_GONE_MS) {
    return { why: o.wait.why, since: o.waitSince };
  }
  if (o.backoffLevel >= 2) return { why: 'backoff', since: o.backoffSince ?? o.now };
  // Reintroduce by dropping this: "no progress for three days while queued" in archivePlan.test.ts reads null, and
  // a series that has asked its site for a dead listing for days shows nothing under Needs attention.
  if (o.progressSince != null && o.now - o.progressSince >= NO_PROGRESS_MS && o.lastTurnAt != null && o.lastTurnAt > o.progressSince) {
    return { why: 'stalled', since: o.progressSince };
  }
  return null;
}

/**
 * How long a series whose listing could not be read waits before the next read: 1 h, 3 h, 12 h, then a day for
 * every failure after that -- the refusal ladder (archivePace.ts backoffMs), since a listing that is not there is
 * asked about as rarely as a site that says no. `fails` counts the failed reads in a row, this one included.
 *
 * Per SERIES, not per source: a site that lists nothing for one series (moved, delisted) still serves the others
 * queued on it, and a whole site that is down fails their chapters too, which back the source off on their own.
 */
export function listingRetryAt(fails: number, now: number, ladder: readonly number[]): number {
  const step = ladder[Math.min(Math.max(1, Math.floor(fails)), ladder.length) - 1] ?? 0;
  return now + step;
}

/**
 * How much of the time between two chapters on one source, [from, to), was the window's or the site's rather
 * than the archive's own pace: the hours outside the window it may run in, and the part of a refusal's backoff
 * that outlasted the break after the chapter before (`breakEnd`, archive_pace.next_at; `backoffUntil`). Taken off
 * a cycle sample before it reaches the running average (archivePace.ts ewmaCycle): a night outside the window, or
 * an hour of backoff, is not how long a chapter takes, and even capped, one night took the default rate's average
 * from 15 minutes to over 20.
 *
 * A stretch that is both is counted once. The break itself stays in: it is the pace. Not counted out: the admin's
 * pause, a sweep or a repair holding everything, a restart -- rarer, and the cap in ewmaCycle bounds them.
 * Walked an hour at a time in local time (the window is in local hours); past a month the rest counts as outside.
 */
export function outsideCycleMs(o: {
  from: number; to: number;
  breakEnd: number | null; backoffUntil: number | null;
  windowFrom: number | null; windowTo: number | null;
  inWindow: (hour: number, from: number | null, to: number | null) => boolean;
}): number {
  if (!(o.to > o.from)) return 0;
  const bStart = Math.max(o.from, o.breakEnd ?? o.from);
  const bEnd = o.backoffUntil == null ? -Infinity : Math.min(o.to, o.backoffUntil);
  const backoffIn = (a: number, b: number) => Math.max(0, Math.min(b, bEnd) - Math.max(a, bStart));
  if (o.windowFrom == null || o.windowTo == null || o.windowFrom === o.windowTo) return backoffIn(o.from, o.to);
  let out = 0;
  let a = o.from;
  for (let i = 0; a < o.to && i < 31 * 24; i++) {
    const next = new Date(a);
    next.setMinutes(60, 0, 0); // the next local hour boundary, DST included
    const b = Math.min(o.to, next.getTime());
    out += o.inWindow(new Date(a).getHours(), o.windowFrom, o.windowTo) ? backoffIn(a, b) : b - a;
    a = b;
  }
  return out + Math.max(0, o.to - a);
}

/** How long a finished archive with nothing left behind stays on the Downloads view. */
export const DONE_SHOWN_MS = 24 * 3600_000;

/**
 * Whether a finished archive is still shown: for a day, or until dismissed while something was left behind.
 * A queued or paused one always is.
 */
export function shownDone(o: { state: string; finishedAt: number | null; attention: Attention | null; now: number }): boolean {
  if (o.state !== 'done') return true;
  if (o.attention) return true;
  return o.finishedAt != null && o.now - o.finishedAt < DONE_SHOWN_MS;
}

/**
 * One viewer's rows, out of the rows every viewer shares.
 *
 * ⚠️ The shared rows are cached unfiltered (lib/archive.ts, ten seconds) and filtered HERE, per call: a cache of
 * one viewer's filtered answer replayed to the next would hand a capped member the admin's list, or the admin
 * a member's. `mayBrowse` is the viewer's browsable() answer by series id -- the same rule as the Downloads
 * view's cards and activity (routes/sources.ts downloadsAudience). Who queued a row stays on the server;
 * `mine` says whether it was this viewer, which is what decides Pause, Resume and Stop besides an admin.
 */
export function rowsFor<R extends { seriesId: string; addedBy: string | null }>(
  rows: readonly R[], mayBrowse: (seriesId: string) => boolean, me: string | null,
): Array<Omit<R, 'addedBy'> & { mine: boolean }> {
  return rows.filter((r) => mayBrowse(r.seriesId)).map(({ addedBy, ...r }) => ({ ...r, mine: !!me && addedBy === me }));
}
