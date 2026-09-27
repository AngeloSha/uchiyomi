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
  /**
   * How often a chapter is followed by a long break as well, and how long that break is. The chance is this
   * much at the default rate and up to about 8 an hour; above that it shrinks with the cycle (longBreakChance()
   * below), so a fast setting still comes out at the rate it names.
   */
  longBreakChance: 0.1,
  longBreakMs: [20 * MIN, 45 * MIN] as [number, number],
  /**
   * The most of a cycle's spare time -- what is left once an average short break at the floor is paid for --
   * the long breaks may take on average. The rest is the chapter's own.
   */
  longShareMax: 0.5,
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
 * The range a short break is drawn from: centred on `base` wherever the floor allows, never under `minBreak`,
 * and never narrower than half of it.
 *
 * ⚠️ The floor is part of the draw, not a clamp after it. `max(minBreak, base x uniform[0.5, 1.5])` sent every
 * draw below the middle to exactly minBreak once the budget was spent (a long chapter, a fast setting): half of
 * all breaks were 45.000 s to the millisecond, the fixed interval this module exists to avoid. Here a break at
 * the floor is uniform over [45 s, 67.5 s], and its average is max(base, 1.25 x minBreak) -- which is what
 * expectedCycleMs counts on.
 */
function shortBreakRange(base: number, minBreak: number): [number, number] {
  const lo = Math.max(minBreak, base / 2);
  return [lo, Math.max(2 * base - lo, lo + minBreak / 2)];
}

/** The average of a short break drawn from shortBreakRange(base, minBreak). */
const shortBreakMean = (base: number, minBreak: number): number => Math.max(base, 1.25 * minBreak);

const meanLongMs = (): number => (ARCHIVE_DEFAULTS.longBreakMs[0] + ARCHIVE_DEFAULTS.longBreakMs[1]) / 2;

/**
 * The chance of a long break after a chapter at `perHour`.
 *
 * ARCHIVE_DEFAULTS.longBreakChance while the cycle has room for it; less once it does not. With a flat one in
 * ten, the long breaks' share was 3.25 minutes a chapter whatever the setting: more than a whole cycle above
 * 18 an hour, so 15, 20 and 30 an hour all came out near 13 with the shortest chapters, and near 7 with
 * five-minute ones. Capped at half of the cycle's spare time, 30 an hour still takes a long break about once
 * every two hours, and a chapter of up to about half a minute keeps the rate it names.
 */
export function longBreakChance(perHour: number, minBreakMs: number = ARCHIVE_DEFAULTS.minBreakMs): number {
  const spare = Math.max(0, cycleMs(perHour) - shortBreakMean(0, Math.max(0, minBreakMs)));
  return Math.min(ARCHIVE_DEFAULTS.longBreakChance, (ARCHIVE_DEFAULTS.longShareMax * spare) / meanLongMs());
}

/** The short break's centre: what is left of the cycle once the chapter and the long breaks' share are paid for. */
function shortBreakBase(perHour: number, chapterMs: number, minBreak: number): { base: number; chance: number } {
  const chance = longBreakChance(perHour, minBreak);
  const base = Math.max(minBreak, cycleMs(perHour) - Math.max(0, chapterMs || 0) - chance * meanLongMs());
  return { base, chance };
}

/**
 * The break after a chapter that took `chapterMs`, before the next one on the same source.
 *
 * The short break is what is left of the chapter's cycle once the chapter itself and the long breaks' average
 * share are paid for -- max(minBreak, cycle - chapter - chance x mean long break) -- drawn from half of that to
 * one and a half times it, and never under minBreak (shortBreakRange). Now and then (longBreakChance: one
 * chapter in ten at the default) a chapter ALSO gets a long break of 20-45 minutes on top. On top, not
 * instead: the short breaks have already paid for the long ones' average, which is what makes the long-run
 * rate come out at `perHour` rather than a few percent over it. When a chapter overruns its cycle the floor
 * wins and the rate simply falls below `perHour` (expectedCycleMs says by how much); the archive never hurries
 * to catch up.
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
  const [lmin, lmax] = ARCHIVE_DEFAULTS.longBreakMs;
  const { base, chance } = shortBreakBase(o.perHour, o.chapterMs, minBreak);
  const [lo, hi] = shortBreakRange(base, minBreak);
  const short = Math.round(lo + (hi - lo) * rand());
  const long = rand() < chance;
  const longMs = long ? Math.round(lmin + (lmax - lmin) * rand()) : 0;
  return { ms: short + longMs, long, longMs };
}

/**
 * How long one chapter's cycle takes on average -- the chapter, its short break and the long breaks' share --
 * for chapters that take `chapterMs`. That is the configured cycle while a chapter and a break at the floor fit
 * in it, and chapter + 1.25 x minBreak + the long share once they do not: the achievable rate, from the same
 * arithmetic as nextBreakMs. What an estimate made before any chapter has run (the Settings help, an ETA
 * with no running average yet) is built from, and what ewmaCycle caps a sample against.
 */
export function expectedCycleMs(o: { perHour: number; chapterMs: number; minBreakMs?: number }): number {
  const minBreak = Math.max(0, o.minBreakMs ?? ARCHIVE_DEFAULTS.minBreakMs);
  const { base, chance } = shortBreakBase(o.perHour, o.chapterMs, minBreak);
  return Math.max(0, o.chapterMs || 0) + shortBreakMean(base, minBreak) + chance * meanLongMs();
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
 * `expectedMs` is expectedCycleMs for the chapter the sample is from. Each sample is capped at three of those
 * plus the longest long break first: one night outside the window, or a restart that sat out a 12-hour
 * backoff, is not how long a chapter takes, and uncapped it would read "about 40 days" for a week afterwards.
 * ⚠️ But a long break is: a cycle that took one is real and counts in full. Capped at three cycles alone,
 * every long break at 30 an hour (three cycles = 6 minutes) was cut, and the ETA read a quarter to a third short.
 */
export function ewmaCycle(prev: number | null | undefined, sampleMs: number, expectedMs: number): number {
  const cap = 3 * Math.max(0, expectedMs) + ARCHIVE_DEFAULTS.longBreakMs[1];
  const s = Math.min(Math.max(0, sampleMs), cap);
  if (prev == null || !(prev > 0)) return Math.round(s);
  return Math.round(prev + EWMA_ALPHA * (s - prev));
}

/**
 * About how long until `left` chapters are in: series on one source take turns, so each of this series'
 * chapters waits for one from each of the other `sharing - 1` series queued on that source. `cycleMs` is the
 * source's running average (ewmaCycle), or expectedCycleMs before it has one.
 */
export function etaMs(o: { left: number; sharing: number; cycleMs: number }): number {
  return Math.max(0, o.left) * Math.max(1, o.sharing) * Math.max(0, o.cycleMs);
}
