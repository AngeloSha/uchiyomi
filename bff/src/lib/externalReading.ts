import { one, q, tx } from './db';
import { incognitoOn } from './incognito';
import { pushSeriesProgressAsync } from './trackers';

export type ExternalOrigin = 'komga' | 'koreader';
export const EXTERNAL_COMPLETION_CAP = 3;
export interface ExternalReaderSettings { externalReadingStats: boolean; opdsEstimatedBookmarks: boolean }
export async function externalReaderSettings(userId: string): Promise<ExternalReaderSettings> {
  const row = await one<{ data: Record<string, unknown> }>('SELECT data FROM app_settings WHERE user_id=$1', [userId]);
  return { externalReadingStats: row?.data?.externalReadingStats === true, opdsEstimatedBookmarks: row?.data?.opdsEstimatedBookmarks === true };
}
export async function externalReaderCounts(userId:string):Promise<Array<{origin:ExternalOrigin;chapters:number}>>{
  return q(`SELECT origin,count(DISTINCT book_id)::int AS chapters FROM reading_events
    WHERE user_id=$1 AND origin IN ('komga','koreader') GROUP BY origin`,[userId]);
}
/** External events are claims of completion, never a measured page-turn timeline or a competition score. */
export const organicEvent = (alias = 'e') => `${alias}.origin = 'web'`;

type Query = Parameters<Parameters<typeof tx>[0]>[0];
export interface ExternalCompletedBook { book_id: string; series_id: string; page: number }
/** Call in the same transaction as the progress upsert. Initial links, jumps and replays stay silent. */
export async function externalCompletions(
  qq: Query, userId: string, origin: ExternalOrigin, scope: string, cursor: number,
  changed: ExternalCompletedBook[], incognito: boolean,
): Promise<void> {
  const previous = await qq<{ cursor: number }>(
    'SELECT cursor FROM external_sync_baselines WHERE user_id=$1 AND origin=$2 AND scope_key=$3 FOR UPDATE', [userId, origin, scope]);
  await qq(`INSERT INTO external_sync_baselines(user_id,origin,scope_key,cursor) VALUES($1,$2,$3,$4)
    ON CONFLICT(user_id,origin,scope_key) DO UPDATE SET cursor=GREATEST(external_sync_baselines.cursor,EXCLUDED.cursor)`, [userId, origin, scope, cursor]);
  if (incognito || !previous.length || !changed.length || changed.length > EXTERNAL_COMPLETION_CAP) return;
  if (origin === 'komga' && (cursor <= previous[0].cursor || cursor - previous[0].cursor > EXTERNAL_COMPLETION_CAP)) return;
  const setting = await qq<{ on: boolean }>(`SELECT (data->'externalReadingStats'='true'::jsonb AND data->'incognito' IS DISTINCT FROM 'true'::jsonb) AS on FROM app_settings WHERE user_id=$1`, [userId]);
  if (setting[0]?.on !== true) return;
  // A web completion, even after an explicit mark-unread, must not be reclassified as a newly synced read.
  for (const b of changed) await qq(`INSERT INTO reading_events(user_id,series_id,book_id,page,completed,device_id,origin,is_private)
    SELECT $1,$2,$3,$4,true,$5,$5,EXISTS(SELECT 1 FROM lib_series s WHERE s.id=$2 AND s.is_private)
    WHERE NOT EXISTS(SELECT 1 FROM reading_events WHERE user_id=$1 AND book_id=$3 AND completed)
    ON CONFLICT (user_id,book_id) WHERE origin IN ('komga','koreader') DO NOTHING`, [userId,b.series_id,b.book_id,b.page,origin]);
}

/** Account-wide lock also covers two simultaneous first links, where no baseline row exists to lock yet. */
export async function externalLock(qq: Query, userId: string): Promise<void> {
  await qq('SELECT pg_advisory_xact_lock(hashtextextended($1,718))', [userId]);
}

/** Explicit KOReader positions: furthest known page, completion never downgraded, retries never move timestamps. */
export async function writeExternalBook(userId: string, book: { id: string; seriesId: string; pages: number }, page: number, document: string, explicitlyFinished = false): Promise<void> {
  let incognito = true;
  const changed = await tx(async qq => {
    await externalLock(qq, userId);
    incognito = await incognitoOn(userId);
    const prior = await qq<{completed:boolean}>('SELECT completed FROM read_progress WHERE user_id=$1 AND book_id=$2 FOR UPDATE',[userId,book.id]);
    const rows = await qq<ExternalCompletedBook>(`INSERT INTO read_progress(user_id,book_id,series_id,page,completed,incognito,is_private)
      VALUES($1,$2,$3,$4,$5,$6,EXISTS(SELECT 1 FROM lib_series s WHERE s.id=$3 AND s.is_private))
      ON CONFLICT(user_id,book_id) DO UPDATE SET page=GREATEST(read_progress.page,EXCLUDED.page),
        completed=read_progress.completed OR EXCLUDED.completed,updated_at=now(),
        incognito=read_progress.incognito AND EXCLUDED.incognito,is_private=read_progress.is_private OR EXCLUDED.is_private
      WHERE read_progress.page<EXCLUDED.page OR (NOT read_progress.completed AND EXCLUDED.completed)
      RETURNING book_id,series_id,page,completed`, [userId,book.id,book.seriesId,page,explicitlyFinished || (book.pages > 0 && page >= book.pages),incognito]);
    const completed = prior[0]?.completed ? [] : rows.filter((r: any) => r.completed);
    await externalCompletions(qq,userId,'koreader',document,page,completed,incognito);
    return completed.length > 0;
  });
  if (changed && !incognito) pushSeriesProgressAsync(userId,book.seriesId);
}

/** Estimates are deliberately separate: not canonical read progress, completion, events, or tracker writes. */
export async function rememberOpdsEstimate(userId: string, bookId: string, page: number): Promise<void> {
  if (!(await externalReaderSettings(userId)).opdsEstimatedBookmarks) return;
  await q(`INSERT INTO opds_estimated_bookmarks(user_id,book_id,page) VALUES($1,$2,$3)
    ON CONFLICT(user_id,book_id) DO UPDATE SET page=GREATEST(opds_estimated_bookmarks.page,EXCLUDED.page),updated_at=now()
    WHERE opds_estimated_bookmarks.page<EXCLUDED.page`,[userId,bookId,page]);
}

/** Opaque EPUB positions establish sync history without inventing a canonical page. */
export async function rememberExternalBaseline(userId:string,document:string,cursor:number):Promise<void>{
  await tx(async qq=>{await externalLock(qq,userId);await externalCompletions(qq,userId,'koreader',document,cursor,[],await incognitoOn(userId));});
}
