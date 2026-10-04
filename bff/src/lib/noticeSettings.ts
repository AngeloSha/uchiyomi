// The notice-chapter reads that need the database (lib/noticeChapters.ts is the rule itself, and pure).
import { q, one } from './db';
import { hidesNotices, hiddenNoticeCount, noticesActive, sanitiseNoticeTypes, setNoticesActive, setNoticesShortOnly } from './noticeChapters';
import type { SeriesType } from './seriesTypeSignals';

/** The server's switches. Read every time, never cached: a change applies to the next request. Off on a failed read. */
export async function noticeTypes(): Promise<SeriesType[]> {
  const r = await one<{ t: unknown }>('SELECT hide_notice_types AS t FROM server_settings WHERE id = 1').catch(() => null);
  return sanitiseNoticeTypes(r?.t);
}

/**
 * Whether one series hides its notice chapters, for code that works on lists in memory (the sweep). The same rule
 * as `hidesNotices`, through it. False on a failed read: a sweep that cannot tell downloads, as it always did. And
 * false without asking while nothing hides anything: the sweep visits every followed series.
 */
export async function seriesHidesNotices(seriesId: string): Promise<boolean> {
  if (!noticesActive()) return false;
  const r = await one<{ h: boolean }>(`SELECT ${hidesNotices('s')} AS h FROM lib_series s WHERE s.id = $1`, [seriesId]).catch(() => null);
  return r?.h === true;
}

/** How many notice chapters of one series are hidden right now, downloaded or only listed, for the admin's sheet. */
export async function hiddenCount(seriesId: string): Promise<number> {
  const r = await q<{ n: number }>(`SELECT ${hiddenNoticeCount('s')} AS n FROM lib_series s WHERE s.id = $1`, [seriesId]).catch(() => []);
  return r[0]?.n ?? 0;
}

/**
 * Whether anything hides notices, into lib/noticeChapters.ts: at boot (server.ts) and after either switch is written
 * (routes/admin.ts). Off on a failed read, which is what every query ran before this feature.
 * Reintroduce by dropping the call after PATCH /api/admin/series/:id: "a series' own switch alone turns the hide on"
 * in noticeChapters.int.test.ts lists its 1.5.
 *
 * v0.55.3: and which rule they hide by, "Only hide short ones" (hide_notice_short_only): on, the default, also on a
 * failed read. Reintroduce by leaving it out: "only short ones ships on, and the settings route turns it off" in
 * noticeChapters.int.test.ts finds the queries built by the old rule after the PATCH.
 */
export async function refreshNoticesActive(): Promise<void> {
  const r = await one<{ active: boolean; short_only: boolean | null }>(
    `SELECT COALESCE((SELECT hide_notice_types <> '[]'::jsonb FROM server_settings WHERE id = 1), false)
         OR EXISTS (SELECT 1 FROM lib_series WHERE hide_notices) AS active,
            (SELECT hide_notice_short_only FROM server_settings WHERE id = 1) AS short_only`).catch(() => null);
  setNoticesActive(r?.active === true);
  setNoticesShortOnly(r?.short_only !== false);
}
