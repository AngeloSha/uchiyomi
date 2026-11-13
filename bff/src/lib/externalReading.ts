import { one, q, tx } from './db';
import { incognitoOn } from './incognito';
import { pushSeriesProgressAsync } from './trackers';
import { EXTERNAL_ORIGINS } from './externalReaderSchema';

export type ExternalOrigin = 'komga' | 'koreader' | 'opds';
export const EXTERNAL_COMPLETION_CAP = 3;
export interface ExternalReaderSettings { externalReadingStats: boolean; opdsEstimatedBookmarks: boolean }
export async function externalReaderSettings(userId: string): Promise<ExternalReaderSettings> {
  const row = await one<{ data: Record<string, unknown> }>('SELECT data FROM app_settings WHERE user_id=$1', [userId]);
  return { externalReadingStats: row?.data?.externalReadingStats === true, opdsEstimatedBookmarks: row?.data?.opdsEstimatedBookmarks === true };
}
export async function externalReaderCounts(userId:string):Promise<Array<{origin:ExternalOrigin;chapters:number}>>{
  return q(`SELECT origin,count(DISTINCT book_id)::int AS chapters FROM reading_events
    WHERE user_id=$1 AND origin IN (${EXTERNAL_ORIGINS}) GROUP BY origin`,[userId]);
}
/** External events are claims of completion, never a measured page-turn timeline or a competition score. */
export const organicEvent = (alias = 'e') => `${alias}.origin = 'web'`;

type Query = Parameters<Parameters<typeof tx>[0]>[0];
export interface ExternalCompletedBook { book_id: string; series_id: string; page: number }
/**
 * Call in the same transaction as the progress upsert. Initial links, jumps and replays stay silent. An OPDS completion
 * (#377) has no initial link to stay silent about: it is one sitting watched page by page (rememberOpdsEstimate), never
 * a catch-up, so it keeps no baseline and is judged by the rest.
 */
export async function externalCompletions(
  qq: Query, userId: string, origin: ExternalOrigin, scope: string, cursor: number,
  changed: ExternalCompletedBook[], incognito: boolean,
): Promise<void> {
  const watched = origin === 'opds';
  const previous = watched ? [] : await qq<{ cursor: number }>(
    'SELECT cursor FROM external_sync_baselines WHERE user_id=$1 AND origin=$2 AND scope_key=$3 FOR UPDATE', [userId, origin, scope]);
  if (!watched) await qq(`INSERT INTO external_sync_baselines(user_id,origin,scope_key,cursor) VALUES($1,$2,$3,$4)
    ON CONFLICT(user_id,origin,scope_key) DO UPDATE SET cursor=GREATEST(external_sync_baselines.cursor,EXCLUDED.cursor)`, [userId, origin, scope, cursor]);
  if (incognito || (!watched && !previous.length) || !changed.length || changed.length > EXTERNAL_COMPLETION_CAP) return;
  if (origin === 'komga' && (cursor <= previous[0].cursor || cursor - previous[0].cursor > EXTERNAL_COMPLETION_CAP)) return;
  const setting = await qq<{ on: boolean }>(`SELECT (data->'externalReadingStats'='true'::jsonb AND data->'incognito' IS DISTINCT FROM 'true'::jsonb) AS on FROM app_settings WHERE user_id=$1`, [userId]);
  if (setting[0]?.on !== true) return;
  // A web completion, even after an explicit mark-unread, must not be reclassified as a newly synced read.
  for (const b of changed) await qq(`INSERT INTO reading_events(user_id,series_id,book_id,page,completed,device_id,origin,is_private)
    SELECT $1,$2,$3,$4,true,$5,$5,EXISTS(SELECT 1 FROM lib_series s WHERE s.id=$2 AND s.is_private)
    WHERE NOT EXISTS(SELECT 1 FROM reading_events WHERE user_id=$1 AND book_id=$3 AND completed)
    ON CONFLICT (user_id,book_id) WHERE origin IN (${EXTERNAL_ORIGINS}) DO NOTHING`, [userId,b.series_id,b.book_id,b.page,origin]);
}

/** Account-wide lock also covers two simultaneous first links, where no baseline row exists to lock yet. */
export async function externalLock(qq: Query, userId: string): Promise<void> {
  await qq('SELECT pg_advisory_xact_lock(hashtextextended($1,718))', [userId]);
}

/**
 * Explicit KOReader positions, and (#377) the end of an OPDS sitting: furthest known page, completion never downgraded,
 * retries never move timestamps. Incognito the same for both: the place and the completion are kept, with no event and
 * no tracker push.
 *
 * An OPDS completion is `inferred` -- a guess from page requests, which the read-chapter cleanup deletes no file on
 * (lib/chapterCleanup.ts). A guess never stands in for a real completion, and a real one replaces the guess: this one
 * from KOReader, writeProgress's from the web reader and Mark read (a Komga PUT cannot: lib/komgaProgress.ts
 * markReadUpTo). Reintroduce `inferred = EXCLUDED.inferred`: "re-streaming a finished chapter never downgrades it" in
 * opdsPse.int.test.ts finds a chapter read in the web reader turned into a guess.
 */
export async function writeExternalBook(
  userId: string, book: { id: string; seriesId: string; pages: number }, page: number, document: string,
  explicitlyFinished = false, origin: 'koreader' | 'opds' = 'koreader',
): Promise<void> {
  let incognito = true;
  const changed = await tx(async qq => {
    await externalLock(qq, userId);
    incognito = await incognitoOn(userId);
    const prior = await qq<{completed:boolean}>('SELECT completed FROM read_progress WHERE user_id=$1 AND book_id=$2 FOR UPDATE',[userId,book.id]);
    const rows = await qq<ExternalCompletedBook>(`INSERT INTO read_progress(user_id,book_id,series_id,page,completed,incognito,is_private,inferred)
      VALUES($1,$2,$3,$4,$5,$6,EXISTS(SELECT 1 FROM lib_series s WHERE s.id=$3 AND s.is_private),$5 AND $7)
      ON CONFLICT(user_id,book_id) DO UPDATE SET page=GREATEST(read_progress.page,EXCLUDED.page),
        completed=read_progress.completed OR EXCLUDED.completed,updated_at=now(),
        incognito=read_progress.incognito AND EXCLUDED.incognito,is_private=read_progress.is_private OR EXCLUDED.is_private,
        inferred=CASE WHEN read_progress.completed THEN read_progress.inferred AND (EXCLUDED.inferred OR NOT EXCLUDED.completed)
                      ELSE EXCLUDED.inferred END
      WHERE read_progress.page<EXCLUDED.page OR (NOT read_progress.completed AND EXCLUDED.completed)
        OR (read_progress.inferred AND EXCLUDED.completed AND NOT EXCLUDED.inferred)
      RETURNING book_id,series_id,page,completed`, [userId,book.id,book.seriesId,page,explicitlyFinished || (book.pages > 0 && page >= book.pages),incognito,origin === 'opds']);
    const completed = prior[0]?.completed ? [] : rows.filter((r: any) => r.completed);
    await externalCompletions(qq,userId,origin,document,page,completed,incognito);
    return completed.length > 0;
  });
  if (changed && !incognito) pushSeriesProgressAsync(userId,book.seriesId);
}

let clock: () => number = () => Date.now();
/** Tests only: replace the clock OPDS sittings are timed by, so one can be paced without waiting. `null` restores it. */
export function setOpdsClock(fn: (() => number) | null): void { clock = fn ?? (() => Date.now()); }

/**
 * The quickest an OPDS sitting may reach a chapter's last page and still have read it (#377): 20 s, or half a second a
 * page. 1,601 sittings in the web reader took a median 12 s a page, a 5th percentile 1.9 s, and 2.3 % went faster than
 * half a second; a reader loading every page at once goes faster still.
 */
export const opdsSittingFloorMs = (pages: number): number => Math.max(20_000, 500 * pages);

/**
 * A page an OPDS reader fetched at reading size (routes/opds.ts says which fetches count), under the account's switch.
 * The furthest page is an estimated bookmark, shown where no real place exists (routes/opds.ts estimatedPlaces), and the
 * pages before the end stay just that (#377). The fetch that first reaches the last page reads the chapter when the
 * sitting it belongs to also
 *   - reached at least half the pages going forward (`forward`: fetches that moved the furthest page on), which a jump
 *     to the end, or a run of pages fetched out of order, has not; and
 *   - began opdsSittingFloorMs before, which a reader loading the whole chapter at once has not.
 * A sitting is a chapter's fetches with no six-hour gap between two of them, so a chapter opened yesterday and preloaded
 * today is today's preload. Errors fall on the side of a chapter read and not counted, short of a reader that loads a few
 * pages ahead and so is counted a few pages early; and what is counted is written as a guess (writeExternalBook).
 */
export async function rememberOpdsEstimate(userId: string, book: { id: string; seriesId: string; pages: number }, page: number): Promise<void> {
  if (!(await externalReaderSettings(userId)).opdsEstimatedBookmarks) return;
  const at = new Date(clock());
  // `was` is the furthest page before this fetch: a last page reached already is not reached again, so a reader that
  // preloads the chapter every time it is opened never qualifies on a later opening. Reintroduce by dropping the `was`
  // test below: "a preload ... is not a read" in opdsPse.int.test.ts completes the chapter on the second preload.
  const r = await one<{ was: number | null; forward: number; session_at: Date }>(
    `WITH was AS (SELECT page FROM opds_estimated_bookmarks WHERE user_id=$1 AND book_id=$2),
     up AS (INSERT INTO opds_estimated_bookmarks AS e(user_id,book_id,page,updated_at,session_at,forward) VALUES($1,$2,$3,$4,$4,1)
       ON CONFLICT(user_id,book_id) DO UPDATE SET
         session_at=CASE WHEN EXCLUDED.updated_at-e.updated_at>=interval '6 hours' THEN EXCLUDED.updated_at ELSE e.session_at END,
         forward=CASE WHEN EXCLUDED.updated_at-e.updated_at>=interval '6 hours' THEN 0 ELSE e.forward END+(EXCLUDED.page>e.page)::int,
         page=GREATEST(e.page,EXCLUDED.page),updated_at=GREATEST(e.updated_at,EXCLUDED.updated_at)
       RETURNING forward,session_at)
     SELECT (SELECT page FROM was) AS was,forward,session_at FROM up`,[userId,book.id,page,at]);
  if (!r || !(book.pages > 0) || page !== book.pages || (r.was ?? 0) >= book.pages) return;
  if (r.forward * 2 < book.pages || at.getTime() - new Date(r.session_at).getTime() < opdsSittingFloorMs(book.pages)) return;
  await writeExternalBook(userId, book, book.pages, book.id, false, 'opds');
}

/** Opaque EPUB positions establish sync history without inventing a canonical page. */
export async function rememberExternalBaseline(userId:string,document:string,cursor:number):Promise<void>{
  await tx(async qq=>{await externalLock(qq,userId);await externalCompletions(qq,userId,'koreader',document,cursor,[],await incognitoOn(userId));});
}
