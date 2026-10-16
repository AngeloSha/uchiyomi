// Profile → Insights, as plain functions (no React, no i18n): "at this pace, finished by", the genre and source mix,
// the backlog and the completion funnel. From @Squeaks72's #249, reduced to what the Reading studio and Wrapped do not
// already show.
//
// The server (bff lib/readingInsights.ts, GET /api/stats/insights) sends the raw material -- the best day and week, and
// one row per series the reader has recorded reading in, each finished chapter counted once (#264) -- and every figure
// on screen is worked out here, so each can be tested without a database. Days are UTC dates ("2026-10-13"), as
// /api/stats buckets them.

export interface InsightSeries {
  id: string; title: string; source: string; genres: string[];
  /** Chapters in the series, hidden notice chapters left out. */
  total: number;
  /** Of them, the ones the reader has finished. */
  read: number;
  lastReadAt: string | null;
  /** Chapters of it finished in the last PACE_DAYS days, this UTC month and the month before, each once. */
  recent: number; thisMonth: number; prevMonth: number;
}
export interface InsightsPayload {
  now: string;
  bestDay: { day: string; chapters: number } | null;
  bestWeek: { start: string; chapters: number } | null;
  series: InsightSeries[];
}

const DAY = 86_400_000;
/** The window the server counts `recent` over (bff lib/readingInsights.ts PACE_DAYS). */
export const PACE_DAYS = 28;
export const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0);

export const unreadOf = (s: InsightSeries): number => Math.max(0, s.total - s.read);

/** Whether there is anything to show at all: a reader who has finished nothing has no insight yet. */
export const hasInsights = (p: InsightsPayload | undefined): boolean => !!p && (!!p.bestDay || p.series.some((s) => s.read > 0));

/* ------------------------------ at this pace ------------------------------ */

export interface Projection { id: string; title: string; unread: number; days: number; date: string }

/**
 * When each series in progress would be finished at the pace of the last PACE_DAYS days: its unread chapters over the
 * chapters of it read a day. A series needs chapters left, some read, and some reading in the window -- one nobody has
 * touched in four weeks has no pace to project. Beyond two years is not "soon" and is left out. Soonest first.
 */
export function projections(series: InsightSeries[], nowMs: number, limit = 5): Projection[] {
  const out: Projection[] = [];
  for (const s of series) {
    const unread = unreadOf(s);
    if (s.read <= 0 || unread <= 0 || s.recent <= 0) continue;
    const days = Math.ceil(unread / (s.recent / PACE_DAYS));
    if (days > 730) continue;
    out.push({ id: s.id, title: s.title, unread, days, date: dayOf(nowMs + days * DAY) });
  }
  return out.sort((a, b) => a.days - b.days || a.title.localeCompare(b.title)).slice(0, limit);
}

/* ----------------------------------- mix ---------------------------------- */

export interface MixRow { label: string; count: number; share: number; prevShare: number | null; deltaPts: number | null }
export type MixField = 'genre' | 'source';

/**
 * Share of the chapters finished this month by genre or by source, against the month before. A chapter counts toward
 * every genre its series carries (so genre shares can add up to more than 100%) and toward one source. `deltaPts` is the
 * change in percentage points, null when the label had no reading last month (new, not a rise from zero).
 */
export function mixRows(series: InsightSeries[], by: MixField, limit = 5): { rows: MixRow[]; total: number } {
  const labelsOf = (s: InsightSeries): string[] =>
    by === 'source' ? (s.source ? [s.source] : []) : [...new Set(s.genres.map((g) => g.trim()).filter(Boolean))];
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

export interface BacklogRow { id: string; title: string; unread: number; lastReadAt: string | null }

/** Series the reader has started and not finished, most unread first, with the totals over all of them. */
export function backlogRows(series: InsightSeries[], limit = 5): { rows: BacklogRow[]; totalUnread: number; seriesCount: number } {
  const rows = series
    .filter((s) => s.read > 0 && unreadOf(s) > 0)
    .map((s) => ({ id: s.id, title: s.title, unread: unreadOf(s), lastReadAt: s.lastReadAt }))
    .sort((a, b) => b.unread - a.unread || a.title.localeCompare(b.title));
  return { rows: rows.slice(0, limit), totalUnread: sum(rows.map((r) => r.unread)), seriesCount: rows.length };
}

/** The started series with chapters left that have gone longest without a recorded read, longest first. */
export function waitingRows(series: InsightSeries[], limit = 3): BacklogRow[] {
  return series
    .filter((s) => s.read > 0 && unreadOf(s) > 0 && s.lastReadAt)
    .map((s) => ({ id: s.id, title: s.title, unread: unreadOf(s), lastReadAt: s.lastReadAt }))
    .sort((a, b) => Date.parse(a.lastReadAt!) - Date.parse(b.lastReadAt!) || a.title.localeCompare(b.title))
    .slice(0, limit);
}

/* --------------------------------- funnel --------------------------------- */

/** A started series untouched this long, with chapters left, counts as dropped ("two months" in its definition line). */
export const DROP_AFTER_DAYS = 60;

export interface Funnel { started: number; finished: number; dropped: number; active: number; dropMedian: number | null; dropPct: number | null }

function median(a: number[]): number | null {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/**
 * Of the series the reader started (a chapter finished): how many they finished (every chapter read), dropped (chapters
 * left and nothing read for DROP_AFTER_DAYS) and are still reading. Where they usually stop is the median number of
 * chapters read in the dropped ones, and that as a share of their length -- null with nothing dropped.
 */
export function funnel(series: InsightSeries[], nowMs: number): Funnel {
  let finished = 0, dropped = 0, active = 0;
  const reads: number[] = [], pcts: number[] = [];
  for (const s of series) {
    if (s.read <= 0) continue;
    if (s.total > 0 && s.read >= s.total) { finished++; continue; }
    const idle = s.lastReadAt ? Math.floor((nowMs - Date.parse(s.lastReadAt)) / DAY) : null;
    if (idle != null && idle >= DROP_AFTER_DAYS) {
      dropped++;
      reads.push(s.read);
      if (s.total > 0) pcts.push(Math.round((s.read / s.total) * 100));
    } else active++;
  }
  return { started: finished + dropped + active, finished, dropped, active, dropMedian: median(reads), dropPct: median(pcts) };
}
