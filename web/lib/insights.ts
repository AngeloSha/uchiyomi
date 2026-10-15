// The You page's insight sections, as plain functions (no React, no i18n): pace, streaks, mix, backlog, funnel, year.
//
// The server (bff lib/youInsights.ts, GET /api/stats/insights) sends raw material -- daily finishes, hour/weekday
// counts and one row per series the reader has recorded reading in -- and every figure on screen is worked out here, so
// each can be tested without a database. Days are UTC dates ("2026-10-13"), as /api/stats buckets them.

export interface InsightSeries {
  id: string; title: string; source: string; genres: string[];
  total: number; read: number;
  lastReadAt: string | null;
  recent: number; thisMonth: number; prevMonth: number;
}
export interface InsightsPayload {
  tz: string;
  now: string;
  daily: [string, number][];
  byHour: number[];
  byWeekday: number[];
  series: InsightSeries[];
}

const DAY = 86_400_000;
export const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const startOfDay = (ms: number): number => Math.floor(ms / DAY) * DAY;
const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0);

/* ---------------------------------- pace ---------------------------------- */

/** Chapters per 7-day bucket, oldest first, the last bucket ending today. */
export function weeklyCounts(daily: [string, number][], nowMs: number, weeks: number): number[] {
  const today = startOfDay(nowMs);
  const out = Array(weeks).fill(0);
  for (const [d, n] of daily) {
    const age = Math.floor((today - dayMs(d)) / DAY);
    if (age < 0 || age >= weeks * 7) continue;
    out[weeks - 1 - Math.floor(age / 7)] += n;
  }
  return out;
}

export interface PaceVsAverage { thisWeek: number; average: number; weeks: number; deltaPct: number | null }

/**
 * The last 7 days against the reader's own average over the weeks before (up to `weeks - 1`). Weeks before the first
 * recorded read are not counted as zero weeks: a new reader is not "behind" a pace they never had. `deltaPct` is null
 * when there is no earlier week to compare to or it averaged nothing.
 */
export function paceVsAverage(daily: [string, number][], nowMs: number, weeks = 8): PaceVsAverage {
  const counts = weeklyCounts(daily, nowMs, weeks);
  const first = daily.length ? Math.min(...daily.map(([d]) => dayMs(d))) : Infinity;
  const today = startOfDay(nowMs);
  // An earlier week counts once the reader had started by its last day.
  const prior = counts.slice(0, weeks - 1).filter((_, i) => today - (weeks - 1 - i) * 7 * DAY >= first);
  const average = prior.length ? sum(prior) / prior.length : 0;
  const thisWeek = counts[weeks - 1];
  return { thisWeek, average, weeks: prior.length, deltaPct: prior.length && average > 0 ? Math.round(((thisWeek - average) / average) * 100) : null };
}

export interface Projection { id: string; title: string; unread: number; days: number; date: string }

/**
 * When each series in progress would be finished at the pace of the last 28 days: unread chapters over chapters a day.
 * A series needs unread chapters, some read, and some reading in the window -- one nobody has touched in four weeks has
 * no pace to project. Beyond two years is "not soon" and left out. Soonest first.
 */
export function projections(series: InsightSeries[], nowMs: number, limit = 4): Projection[] {
  const out: Projection[] = [];
  for (const s of series) {
    const unread = unreadOf(s);
    if (s.read <= 0 || unread <= 0 || s.recent <= 0) continue;
    const days = Math.ceil(unread / (s.recent / 28));
    if (days > 730) continue;
    out.push({ id: s.id, title: s.title, unread, days, date: dayOf(nowMs + days * DAY) });
  }
  return out.sort((a, b) => a.days - b.days || a.title.localeCompare(b.title)).slice(0, limit);
}

export const unreadOf = (s: InsightSeries): number => Math.max(0, s.total - s.read);

/* --------------------------------- streaks -------------------------------- */

export interface StreakStats {
  current: number; longest: number;
  bestDay: { day: string; n: number } | null;
  bestWeek: { start: string; n: number } | null;
}

/** Monday (UTC) of the week a day falls in. */
const mondayOf = (ms: number): number => { const d = startOfDay(ms); return d - ((new Date(d).getUTCDay() + 6) % 7) * DAY; };

/**
 * Current streak (today or yesterday anchors it, as the profile hero counts), longest ever, the busiest single day and the
 * busiest Monday-to-Sunday week.
 */
export function streakStats(daily: [string, number][], nowMs: number): StreakStats {
  const days = daily.filter(([, n]) => n > 0);
  const set = new Set(days.map(([d]) => d));
  let current = 0;
  let cur = startOfDay(nowMs);
  if (!set.has(dayOf(cur))) cur -= DAY;
  while (set.has(dayOf(cur))) { current++; cur -= DAY; }
  let longest = 0, run = 0, prev = NaN;
  for (const [d] of [...days].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const t = dayMs(d);
    run = t - prev === DAY ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = t;
  }
  let bestDay: StreakStats['bestDay'] = null;
  const weeks = new Map<number, number>();
  for (const [d, n] of days) {
    if (!bestDay || n > bestDay.n || (n === bestDay.n && d > bestDay.day)) bestDay = { day: d, n };
    const w = mondayOf(dayMs(d));
    weeks.set(w, (weeks.get(w) ?? 0) + n);
  }
  let bestWeek: StreakStats['bestWeek'] = null;
  for (const [w, n] of weeks) if (!bestWeek || n > bestWeek.n || (n === bestWeek.n && dayOf(w) > bestWeek.start)) bestWeek = { start: dayOf(w), n };
  return { current, longest, bestDay, bestWeek };
}

/* ------------------------------- when you read ---------------------------- */

/** The index of the largest value, or -1 when everything is zero. */
export function peakIndex(values: number[]): number {
  let best = -1, max = 0;
  values.forEach((v, i) => { if (v > max) { max = v; best = i; } });
  return best;
}

/* ----------------------------------- mix ---------------------------------- */

export interface MixRow { label: string; count: number; share: number; prevShare: number | null; deltaPts: number | null }
export type MixField = 'genre' | 'source';

/**
 * Share of chapters finished this month by genre or by source, against the month before. A chapter counts toward every genre
 * its series carries (so genre shares can add up to more than 100%) and toward one source. `deltaPts` is the change in
 * percentage points, null when the label had no reading last month (a new one, not a rise from zero).
 */
export function mixRows(series: InsightSeries[], by: MixField, limit = 5): { rows: MixRow[]; total: number } {
  const labelsOf = (s: InsightSeries): string[] => (by === 'source' ? (s.source ? [s.source] : []) : [...new Set(s.genres.map((g) => g.trim()).filter(Boolean))]);
  const now = new Map<string, number>(), before = new Map<string, number>();
  let totalNow = 0, totalPrev = 0;
  for (const s of series) {
    totalNow += s.thisMonth; totalPrev += s.prevMonth;
    for (const l of labelsOf(s)) {
      if (s.thisMonth) now.set(l, (now.get(l) ?? 0) + s.thisMonth);
      if (s.prevMonth) before.set(l, (before.get(l) ?? 0) + s.prevMonth);
    }
  }
  const pct = (n: number, tot: number) => (tot > 0 ? Math.round((n / tot) * 100) : 0);
  const rows = [...now].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([label, count]) => {
    const share = pct(count, totalNow);
    const p = before.get(label);
    const prevShare = p && totalPrev > 0 ? pct(p, totalPrev) : null;
    return { label, count, share, prevShare, deltaPts: prevShare == null ? null : share - prevShare };
  });
  return { rows, total: totalNow };
}

/* --------------------------------- backlog -------------------------------- */

export interface BacklogRow { id: string; title: string; unread: number; idleDays: number | null }

/** Series with unread chapters, most unread first. */
export function backlogRows(series: InsightSeries[], nowMs: number, limit = 5): { rows: BacklogRow[]; totalUnread: number; seriesCount: number } {
  const open = series.filter((s) => s.read > 0 && unreadOf(s) > 0);
  const rows = open
    .map((s) => ({ id: s.id, title: s.title, unread: unreadOf(s), idleDays: idleDays(s, nowMs) }))
    .sort((a, b) => b.unread - a.unread || a.title.localeCompare(b.title));
  return { rows: rows.slice(0, limit), totalUnread: sum(rows.map((r) => r.unread)), seriesCount: rows.length };
}

/** The series with chapters left that have gone longest without a recorded read, longest first. */
export function neglectedRows(series: InsightSeries[], nowMs: number, limit = 3): BacklogRow[] {
  return series
    .filter((s) => s.read > 0 && unreadOf(s) > 0 && s.lastReadAt)
    .map((s) => ({ id: s.id, title: s.title, unread: unreadOf(s), idleDays: idleDays(s, nowMs) }))
    .sort((a, b) => (b.idleDays ?? 0) - (a.idleDays ?? 0) || a.title.localeCompare(b.title))
    .slice(0, limit);
}

function idleDays(s: InsightSeries, nowMs: number): number | null {
  if (!s.lastReadAt) return null;
  return Math.max(0, Math.floor((nowMs - Date.parse(s.lastReadAt)) / DAY));
}

/* --------------------------------- funnel --------------------------------- */

/** A series untouched this long, with chapters left, counts as dropped. */
export const DROP_AFTER_DAYS = 60;

export interface Funnel { started: number; finished: number; dropped: number; active: number; dropMedian: number | null; dropPct: number | null }

function median(a: number[]): number | null {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/**
 * Of the series the reader started (some chapter finished): how many they finished (every chapter read), dropped (chapters
 * left and nothing read for DROP_AFTER_DAYS) and are still reading. The typical drop-off is the median number of chapters
 * read in the dropped ones, and that as a share of their length -- null with no dropped series.
 */
export function funnel(series: InsightSeries[], nowMs: number): Funnel {
  let finished = 0, dropped = 0, active = 0;
  const reads: number[] = [], pcts: number[] = [];
  for (const s of series) {
    if (s.read <= 0) continue;
    if (s.total > 0 && s.read >= s.total) { finished++; continue; }
    const idle = idleDays(s, nowMs);
    if (idle != null && idle >= DROP_AFTER_DAYS) {
      dropped++;
      reads.push(s.read);
      if (s.total > 0) pcts.push(Math.round((s.read / s.total) * 100));
    } else active++;
  }
  const dropPct = median(pcts);
  return { started: finished + dropped + active, finished, dropped, active, dropMedian: median(reads), dropPct };
}

/* ---------------------------------- year ---------------------------------- */

export interface YearReview {
  year: number;
  thisYear: number[]; lastYear: number[];
  thisTotal: number; lastTotal: number;
  /** last year's chapters up to the same day of the year, the fair comparison for a year still running */
  lastSamePeriod: number;
  deltaPct: number | null;
}

export function yearReview(daily: [string, number][], nowMs: number): YearReview {
  const now = new Date(nowMs);
  const year = now.getUTCFullYear();
  const thisYear = Array(12).fill(0), lastYear = Array(12).fill(0);
  const cutoff = Date.UTC(year - 1, now.getUTCMonth(), now.getUTCDate());
  let lastSamePeriod = 0;
  for (const [d, n] of daily) {
    const t = dayMs(d);
    const dt = new Date(t);
    const y = dt.getUTCFullYear();
    if (y === year) thisYear[dt.getUTCMonth()] += n;
    else if (y === year - 1) { lastYear[dt.getUTCMonth()] += n; if (t <= cutoff) lastSamePeriod += n; }
  }
  const thisTotal = sum(thisYear);
  return { year, thisYear, lastYear, thisTotal, lastTotal: sum(lastYear), lastSamePeriod, deltaPct: lastSamePeriod > 0 ? Math.round(((thisTotal - lastSamePeriod) / lastSamePeriod) * 100) : null };
}

/** Whether there is anything to show at all: a brand-new account has no finished chapter. */
export const hasInsights = (p: InsightsPayload | undefined): boolean => !!p && (p.daily.length > 0 || p.series.length > 0);
