// The You page's insight sections (GET /api/stats/insights): one read of the reader's own history that the web turns into
// pace, streaks, when they read, genre/source mix, backlog, the completion funnel and the year in review (web lib/insights.ts).
//
// Two rules decide what is in it:
//  * Incognito reading leaves no reading_events row (lib/incognito.ts), so everything counted from events -- the daily
//    counts, the hours, the monthly shares, "last read" -- already leaves it out. The per-series list is therefore limited to
//    series that have at least one event: a series read only incognito is not listed at all, and its idle time is the time
//    since its last RECORDED read. (read_progress keeps the place even while incognito, so the chapters-read count may
//    include incognito chapters of a series that is also read in the open; that is state, not a trace of when.)
//  * Names come only from `browsable()`, the listing rule every rail uses: 18+ libraries, ratings and genres follow the
//    request's Show 18+ switch, and a series the reader may not open is absent. The daily/hour counts carry no names.
import { q } from './db';
import { browsable, Params, type ViewCtx } from './visibility';
import { noticeBook } from './noticeChapters';
import { validTz } from './readingTime';
import { bucketTimes } from './insightsBuckets';

const DAY = 86_400_000;

export interface InsightSeries {
  id: string; title: string; source: string; genres: string[];
  total: number; read: number;
  lastReadAt: string | null;
  recent: number; thisMonth: number; prevMonth: number;
}
export interface Insights {
  tz: string;
  now: string;
  daily: [string, number][];
  byHour: number[];
  byWeekday: number[];
  series: InsightSeries[];
}

export async function insightsFor(uid: string, ctx: ViewCtx, tzIn: unknown, nowMs = Date.now()): Promise<Insights> {
  const tz = validTz(tzIn);
  const n = new Date(nowMs);
  const monthStart = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1);
  const prevStart = Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 1, 1);

  const dailyRows = await q<{ day: string; n: number }>(
    `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS n
       FROM reading_events WHERE user_id = $1 AND completed = true GROUP BY 1 ORDER BY 1`,
    [uid],
  );
  const timeRows = await q<{ t: string }>(
    `SELECT created_at AS t FROM reading_events WHERE user_id = $1 AND completed = true AND created_at > $2::timestamptz`,
    [uid, new Date(nowMs - 365 * DAY).toISOString()],
  );
  const { byHour, byWeekday } = bucketTimes(timeRows.map((r) => new Date(r.t).getTime()), tz);

  const p = new Params();
  const uidP = p.add(uid);
  const recentP = p.add(new Date(nowMs - 28 * DAY).toISOString());
  const monthP = p.add(new Date(monthStart).toISOString());
  const prevP = p.add(new Date(prevStart).toISOString());
  const rows = await q<{
    id: string; title: string; source: string; genres: string[] | null; total: number; read: number;
    last_at: string | null; recent: number; this_month: number; prev_month: number;
  }>(
    `SELECT s.id, s.title, s.source, COALESCE(o.genres, s.genres) AS genres,
            (SELECT count(*)::int FROM lib_books b WHERE b.series_id = s.id AND NOT ${noticeBook('b.id')}) AS total,
            (SELECT count(*)::int FROM read_progress rp JOIN lib_books rb ON rb.id = rp.book_id
              WHERE rp.user_id = ${uidP} AND rp.series_id = s.id AND rp.completed AND NOT ${noticeBook('rb.id')}) AS read,
            ev.last_at, ev.recent, ev.this_month, ev.prev_month
       FROM lib_series s
       JOIN (SELECT series_id, max(created_at) AS last_at,
                    count(*) FILTER (WHERE completed AND created_at >= ${recentP}::timestamptz)::int AS recent,
                    count(*) FILTER (WHERE completed AND created_at >= ${monthP}::timestamptz)::int AS this_month,
                    count(*) FILTER (WHERE completed AND created_at >= ${prevP}::timestamptz AND created_at < ${monthP}::timestamptz)::int AS prev_month
               FROM reading_events WHERE user_id = ${uidP} GROUP BY series_id) ev ON ev.series_id = s.id
       LEFT JOIN series_overrides o ON o.series_id = s.id
      WHERE ${browsable('s', ctx, p)}`,
    p.values as any[],
  );
  return {
    tz,
    now: n.toISOString(),
    daily: dailyRows.map((r) => [r.day, r.n]),
    byHour,
    byWeekday,
    series: rows.map((r) => ({
      id: r.id, title: r.title, source: r.source, genres: r.genres ?? [],
      total: r.total, read: r.read, lastReadAt: r.last_at ? new Date(r.last_at).toISOString() : null,
      recent: r.recent, thisMonth: r.this_month, prevMonth: r.prev_month,
    })),
  };
}
