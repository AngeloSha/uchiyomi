// How slowly the slow archive (#117) fetches a back catalogue: the arithmetic, and nothing else.
//
// The issue asks for a whole series "over nights or days" without the site ever seeing a burst. The paced
// downloader already spaces pages and chapters, but at fixed intervals, and a fixed interval sustained for
// ten days is exactly what a script looks like. So the archive reads more like a person: a random pause
// between pages, a random break between chapters, now and then a long "put the phone down" break, and a
// site that says no is left alone for hours rather than retried at the next tick.
//
// No database and no timers here -- every function takes its randomness and its clock as arguments, so
// the unit tests can pin bounds and long-run rates with a seeded generator instead of waiting ten days.
// The scheduler that uses them (lib/archive.ts) owns the state; this owns the numbers.

const MIN = 60_000;
const HOUR = 60 * MIN;

/** The defaults the owner approved, in one place so the settings, the env knobs and the tests agree. */
export const ARCHIVE_DEFAULTS = {
  /** Chapters an hour, per source. Settings clamp it to PER_HOUR_RANGE. */
  perHour: 4,
  /** A fresh uniform draw from this range between pages, one page at a time (env ARCHIVE_PAGE_GAP_MS). */
  pageGapMs: [1500, 4000] as [number, number],
  /**
   * The shortest break between two chapters on one source, whatever the budget says. A chapter that took
   * longer than its whole cycle has already spent the budget, and starting the next one straight away is
   * the back-to-back fetching the archive exists to avoid.
   */
  minBreakMs: 45_000,
  /** How often a chapter is followed by a long break as well, and how long that break is. */
  longBreakChance: 0.1,
  longBreakMs: [20 * MIN, 45 * MIN] as [number, number],
  /**
   * How long a source that refused a chapter (429 or 403) is left alone, by how many times in a row it has.
   * The last rung repeats: about one attempt a day at a site that keeps saying no.
   */
  backoffMs: [1 * HOUR, 3 * HOUR, 12 * HOUR, 24 * HOUR],
  /** A source that was down rather than refusing gets one flat wait: it is not telling us to go away. */
  downBackoffMs: 30 * MIN,
};

/** The settings range for chapters an hour. 30 an hour is a chapter every two minutes, already brisk. */
export const PER_HOUR_RANGE: [number, number] = [1, 30];

const clampPerHour = (perHour: number): number => {
  const n = Number(perHour);
  if (!Number.isFinite(n)) return ARCHIVE_DEFAULTS.perHour;
  return Math.min(PER_HOUR_RANGE[1], Math.max(PER_HOUR_RANGE[0], n));
};

/** One chapter's share of the hour at `perHour`: the budget a chapter and the break after it spend together. */
export const cycleMs = (perHour: number): number => HOUR / clampPerHour(perHour);

/**
 * The page-gap range from ARCHIVE_PAGE_GAP_MS ("1500,4000"), read at call time so a test or the e2e rig can
 * set it after import. One number is a fixed gap; two in either order are a range; anything unreadable is
 * the default rather than no gap at all, since a typo must never make the archive FASTER.
 */
export function pageGapRange(env: Record<string, string | undefined> = process.env): [number, number] {
  const raw = env.ARCHIVE_PAGE_GAP_MS;
  if (raw === undefined || raw.trim() === '') return [...ARCHIVE_DEFAULTS.pageGapMs];
  const parts = raw.split(',').map((s) => s.trim());
  const nums = parts.map(Number);
  if (parts.length > 2 || parts.some((s) => s === '') || nums.some((n) => !Number.isFinite(n) || n < 0)) {
    return [...ARCHIVE_DEFAULTS.pageGapMs];
  }
  const [a, b = a] = nums;
  return [Math.min(a, b), Math.max(a, b)];
}

/**
 * One page gap: uniform over [lo, hi], never below `floorMs`. The floor is the gap the chapter would have
 * run at anyway (an adapter's own gap, or a pace level a 429 earned), so jitter only ever slows it down.
 */
export function drawGap(range: [number, number], floorMs = 0, rand: () => number = Math.random): number {
  const lo = Math.max(range[0], floorMs);
  const hi = Math.max(range[1], lo);
  return Math.min(hi, Math.round(lo + (hi - lo) * rand()));
}

/**
 * The break after a chapter that took `chapterMs`, before the next one on the same source.
 *
 * The short break is what is left of the chapter's cycle once the chapter itself and the long breaks'
 * average share are paid for -- max(minBreak, cycle - chapter - chance x mean long break) -- jittered by
 * uniform[0.5, 1.5], and never under minBreak after the jitter either. One chapter in ten then ALSO gets a
 * long break of 20-45 minutes on top. On top, not instead: the short breaks have already paid for the long
 * ones' average, which is what makes the long-run rate come out at `perHour` rather than a few percent
 * over it. When a chapter overruns its cycle the floor wins and the rate simply falls below `perHour`;
 * the archive never hurries to catch up.
 *
 * `longMs` is the long part alone (0 when there is none), so a view can say which kind of break it is.
 */
export function nextBreakMs(o: {
  perHour: number;
  chapterMs: number;
  rand?: () => number;
  minBreakMs?: number;
}): { ms: number; long: boolean; longMs: number } {
  const rand = o.rand ?? Math.random;
  const minBreak = Math.max(0, o.minBreakMs ?? ARCHIVE_DEFAULTS.minBreakMs);
  const { longBreakChance: chance, longBreakMs: [lmin, lmax] } = ARCHIVE_DEFAULTS;
  const longBudget = chance * (lmin + lmax) / 2;
  const base = Math.max(minBreak, cycleMs(o.perHour) - Math.max(0, o.chapterMs || 0) - longBudget);
  const short = Math.max(minBreak, Math.round(base * (0.5 + rand())));
  const long = rand() < chance;
  const longMs = long ? Math.round(lmin + (lmax - lmin) * rand()) : 0;
  return { ms: short + longMs, long, longMs };
}

/**
 * Until when a source is left alone after a refusal: `level` is how many refusals in a row, this one
 * included. 1 h, 3 h, 12 h, then 24 h for every refusal after that. 'down' (a timeout, a 5xx) is a flat
 * 30 minutes whatever the level.
 *
 * ⚠️ Never earlier than the source's own cooldown (source_health.blocked_until): the archive may choose to
 * wait longer than the rest of the server, never less, or its first attempt after an hour's backoff lands
 * inside a cooldown the site asked for and escalates both.
 */
export function backoffUntil(
  level: number,
  blockedUntil: number | Date | null | undefined,
  now: number = Date.now(),
  why: 'refused' | 'down' = 'refused',
): number {
  const ladder = ARCHIVE_DEFAULTS.backoffMs;
  const step = why === 'down'
    ? ARCHIVE_DEFAULTS.downBackoffMs
    : level >= 1 ? ladder[Math.min(Math.floor(level), ladder.length) - 1] : 0;
  const blocked = blockedUntil == null ? 0 : +blockedUntil;
  return Math.max(now + step, Number.isFinite(blocked) ? blocked : 0);
}

/**
 * Whether `hour` (0-23, the server's local time) is inside the window [from, to). NULL on either end is
 * "any time", the default. A window may cross midnight: 22-6 is 22:00 to 05:59.
 *
 * `from === to` is also any time. A window with no length would never open, and an archive that silently
 * never runs again, with nothing to say why, is worse than one that runs all day.
 */
export function inWindow(hour: number, from: number | null | undefined, to: number | null | undefined): boolean {
  if (from == null || to == null || from === to) return true;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/** The next time the local clock reads `from`:00, `now` included: when a closed window opens. */
export function windowOpensAt(now: number, from: number): number {
  const d = new Date(now);
  d.setHours(from, 0, 0, 0);
  if (d.getTime() < now) {
    d.setDate(d.getDate() + 1);
    d.setHours(from, 0, 0, 0); // again: a DST change overnight moves the wall clock under setDate
  }
  return d.getTime();
}

/** How strongly one chapter's real cycle moves the running average: about the last ten chapters count. */
const EWMA_ALPHA = 0.2;

/**
 * The running average of real time per chapter on a source, breaks and waits included -- what the ETA is
 * built from, so the time lost to a busy source or a closed window shows up in it.
 *
 * Each sample is capped at three configured cycles first: one night outside the window, or a restart that
 * sat out a 12-hour backoff, is not how long a chapter takes, and uncapped it would read "about 40 days"
 * for a week afterwards.
 */
export function ewmaCycle(prev: number | null | undefined, sampleMs: number, cfgCycleMs: number): number {
  const s = Math.min(Math.max(0, sampleMs), 3 * cfgCycleMs);
  if (prev == null || !(prev > 0)) return Math.round(s);
  return Math.round(prev + EWMA_ALPHA * (s - prev));
}

/**
 * About how long until `left` chapters are in: series on one source take turns, so each of this series'
 * chapters waits for one from each of the other `sharing - 1` series queued on that source.
 */
export function etaMs(o: { left: number; sharing: number; cycleMs: number }): number {
  return Math.max(0, o.left) * Math.max(1, o.sharing) * Math.max(0, o.cycleMs);
}
