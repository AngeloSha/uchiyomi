// Profile → Insights (GET /api/stats/insights): one read of the reader's own history, which the web turns into the
// backlog, the completion funnel, the genre and source mix, "at this pace, finished by" and the best day and week
// (web lib/insights.ts). From @Squeaks72's #249, reduced to what the Reading studio and Wrapped do not already show.
//
// Three rules decide what is in it:
//  * Each finished chapter counts once within its window (#264, v0.70.0): the best day, the best week, the last four
//    weeks and the two months are all `count(DISTINCT book_id)`, never a count of completed events, of which one
//    read-through writes two.
//  * Incognito reading leaves no reading_events row (lib/incognito.ts), so everything counted from events already leaves
//    it out, and a series is listed only once it has a recorded read: one read only incognito is not listed at all, and
//    its idle time is the time since its last RECORDED read. (read_progress keeps the place even while incognito, so a
//    series' read count may include incognito chapters of a series also read in the open; that is state, not a trace.)
//  * Names come only from `browsable()`, the listing rule every rail uses: 18+ libraries, ratings and genres follow the
//    request's Show 18+ switch, and a series the reader may not open is absent. The best day and week carry no names.
import { q } from './db';
import { browsable, Params, type ViewCtx } from './visibility';
import { noticeBook } from './noticeChapters';

const DAY = 86_400_000;
/** The window "at this pace" reads the pace from. */
export const PACE_DAYS = 28;

export interface InsightSeries {
  id: string; title: string; source: string; genres: string[];
  /** Chapters in the series, hidden notice chapters left out. */
  total: number;
  /** Of them, the ones the reader has finished (read_progress). */
  read: number;
  /** The reader's last recorded reading in it. */
  lastReadAt: string | null;
  /** Chapters of it finished in the last PACE_DAYS days, this UTC month and the month before: each once. */
  recent: number; thisMonth: number; prevMonth: number;
}
export interface Insights {
  now: string;
  /** The UTC day with the most chapters finished, each once; the later of a tie. */
  bestDay: { day: string; chapters: number } | null;
  /** The Monday-to-Sunday (UTC) week with the most chapters finished, each once; `start` is its Monday. */
  bestWeek: { start: string; chapters: number } | null;
  series: InsightSeries[];
}

export async function insightsFor(uid: string, ctx: ViewCtx, nowMs = Date.now()): Promise<Insights> {
  const n = new Date(nowMs);
  const monthStart = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1);
  const prevStart = Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 1, 1);

  // date_trunc('week') is ISO: weeks start on Monday. Reintroduce count(*): "the best day and week count each chapter
  // once" in readingInsights.int.test.ts finds the doubled pair.
  const best = async (unit: 'day' | 'week') => (await q<{ at: string; chapters: number }>(
    `SELECT to_char(date_trunc('${unit}', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS at, count(DISTINCT book_id)::int AS chapters
       FROM reading_events WHERE user_id = $1 AND completed = true
      GROUP BY 1 ORDER BY 2 DESC, 1 DESC LIMIT 1`,
    [uid],
  ))[0] ?? null;
  const [day, week] = [await best('day'), await best('week')];

  const p = new Params();
  const uidP = p.add(uid);
  const recentP = p.add(new Date(nowMs - PACE_DAYS * DAY).toISOString());
  const monthP = p.add(new Date(monthStart).toISOString());
  const prevP = p.add(new Date(prevStart).toISOString());
  const rows = await q<{
    id: string; title: string; source: string; genres: string[] | null; total: number; read: number;
    last_at: string | null; recent: number; this_month: number; prev_month: number;
  }>(
    `SELECT s.id, COALESCE(NULLIF(btrim(o.title), ''), s.title) AS title, s.source, COALESCE(o.genres, s.genres) AS genres,
            (SELECT count(*)::int FROM lib_books b WHERE b.series_id = s.id AND NOT ${noticeBook('b.id')}) AS total,
            (SELECT count(*)::int FROM read_progress rp JOIN lib_books rb ON rb.id = rp.book_id
              WHERE rp.user_id = ${uidP} AND rp.series_id = s.id AND rp.completed AND NOT ${noticeBook('rb.id')}) AS read,
            ev.last_at, ev.recent, ev.this_month, ev.prev_month
       FROM lib_series s
       JOIN (SELECT series_id, max(created_at) AS last_at,
                    count(DISTINCT book_id) FILTER (WHERE completed AND created_at >= ${recentP}::timestamptz)::int AS recent,
                    count(DISTINCT book_id) FILTER (WHERE completed AND created_at >= ${monthP}::timestamptz)::int AS this_month,
                    count(DISTINCT book_id) FILTER (WHERE completed AND created_at >= ${prevP}::timestamptz
                                                     AND created_at < ${monthP}::timestamptz)::int AS prev_month
               FROM reading_events WHERE user_id = ${uidP} GROUP BY series_id) ev ON ev.series_id = s.id
       LEFT JOIN series_overrides o ON o.series_id = s.id
      WHERE ${browsable('s', ctx, p)}`,
    p.values as any[],
  );
  return {
    now: n.toISOString(),
    bestDay: day ? { day: day.at, chapters: day.chapters } : null,
    bestWeek: week ? { start: week.at, chapters: week.chapters } : null,
    series: rows.map((r) => ({
      id: r.id, title: r.title, source: r.source, genres: r.genres ?? [],
      total: r.total, read: r.read, lastReadAt: r.last_at ? new Date(r.last_at).toISOString() : null,
      recent: r.recent, thisMonth: r.this_month, prevMonth: r.prev_month,
    })),
  };
}
