// The notice-chapter reads that need the database (lib/noticeChapters.ts is the rule itself, and pure).
import { q, one } from './db';
import { hidesNotices, hiddenNoticeCount, sanitiseNoticeTypes } from './noticeChapters';
import type { SeriesType } from './seriesTypeSignals';

/** The server's switches. Read every time, never cached: a change applies to the next request. Off on a failed read. */
export async function noticeTypes(): Promise<SeriesType[]> {
  const r = await one<{ t: unknown }>('SELECT hide_notice_types AS t FROM server_settings WHERE id = 1').catch(() => null);
  return sanitiseNoticeTypes(r?.t);
}

/**
 * Whether one series hides its notice chapters, for code that works on lists in memory (the sweep). The same rule
 * as `hidesNotices`, through it. False on a failed read: a sweep that cannot tell downloads, as it always did.
 */
export async function seriesHidesNotices(seriesId: string): Promise<boolean> {
  const r = await one<{ h: boolean }>(`SELECT ${hidesNotices('s')} AS h FROM lib_series s WHERE s.id = $1`, [seriesId]).catch(() => null);
  return r?.h === true;
}

/** How many notice chapters of one series are hidden right now, downloaded or only listed, for the admin's sheet. */
export async function hiddenCount(seriesId: string): Promise<number> {
  const r = await q<{ n: number }>(`SELECT ${hiddenNoticeCount('s')} AS n FROM lib_series s WHERE s.id = $1`, [seriesId]).catch(() => []);
  return r[0]?.n ?? 0;
}
