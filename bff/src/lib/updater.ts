// New-chapter updater: for each owned series, ask its source for chapters we don't have yet and download
// them via the downloader. Replaces Suwayomi's update loop. Source routing comes straight from the
// lib_series.source_id / source_series_id columns stamped at add time (backfilled once for older rows) —
// no display-name keyword matching or <Web>-url reverse-parsing.
import { q, one } from './db';
import { getSource, SourceChapter, withTimeout } from './sources';
import { downloadChapter } from './downloader';
import { persistScan, setBookDates } from './library';
import { blockedNow } from './sourceHealth';
import { notifyNewChapter } from './push';
import { visibleToAll } from './visibility';

/**
 * Why a series produced nothing this run.
 *
 * Every one of these used to return the same bare `added: 0`, which is byte-identical to a healthy quiet
 * night -- and `added: 0` is all the admin panel ever showed. The whole library could stop updating and
 * every surface would say it was fine. That is the exact failure the source watchdog was built for; the
 * lesson had never reached the most-used background job in the product.
 */
export type UpdateOutcome =
  | 'ok'            // the source answered, whether or not anything was new
  | 'gone'          // hidden, merged or deleted since the sweep started
  | 'unrouted'      // no source installed, or the row was never stamped with one
  | 'blocked'       // the source is inside a back-off window
  | 'source_error'; // threw or timed out: the one that used to look like good news

/**
 * The same bound the add path uses (routes/sources.ts). Unbounded, one hung site held the whole sweep -- the
 * loop is sequential with a 1.5s pause, so every series behind it waited on undici's 300s default.
 */
const LIST_TIMEOUT = Number(process.env.UPDATER_LIST_TIMEOUT_MS) || 20_000;

export async function updateSeries(
  seriesId: string,
  maxNew = 10,
): Promise<{ title: string; added: number; available: number; outcome: UpdateOutcome; failed: number; folder?: string; chapters?: SourceChapter[] }> {
  const s = await one<any>(`SELECT id,title,source_id,source_series_id,web,folder,summary,author,genres,status FROM lib_series s WHERE s.id=$1 AND ${visibleToAll('s')}`, [seriesId]);
  if (!s) return { title: '', added: 0, available: 0, outcome: 'gone', failed: 0 };
  const src = s.source_id ? getSource(s.source_id) : null;
  const ref = s.source_series_id;
  if (!src || !ref) return { title: s.title, added: 0, available: 0, outcome: 'unrouted', failed: 0 };
  if (await blockedNow(s.source_id)) return { title: s.title, added: 0, available: 0, outcome: 'blocked', failed: 0 };

  // A throw and an empty list are NOT the same answer, and collapsing them is what made a broken source
  // indistinguishable from a series with nothing new. routes/sources.ts already separates these two, with a
  // comment saying why, two files away.
  let listFailed = false;
  const chapters = await withTimeout(src.listChapters(ref), LIST_TIMEOUT).catch(() => { listFailed = true; return [] as SourceChapter[]; });
  if (listFailed) return { title: s.title, added: 0, available: 0, outcome: 'source_error', failed: 0 };
  if (!chapters.length) return { title: s.title, added: 0, available: 0, outcome: 'ok', failed: 0 };

  const have = new Set((await q<{ number: number }>('SELECT number FROM lib_books WHERE series_id=$1', [seriesId])).map((r) => Number(r.number)));
  const missing = chapters.filter((c) => !have.has(c.number)).sort((a, b) => a.number - b.number);

  let added = 0;
  let failed = 0;
  // oldest-missing-first: a partial "first N" add fills forward coherently, and new releases (all > our max)
  // are still the only gap once a series is fully downloaded.
  for (const ch of missing.slice(0, maxNew)) {
    try {
      const res = await downloadChapter({
        sourceId: s.source_id,
        seriesFolder: s.folder,
        chapter: ch,
        meta: { series: s.title, summary: s.summary, author: s.author, genres: s.genres, url: s.web, status: s.status },
      });
      if (!res.skipped) added++;
    } catch (e: any) {
      failed++; // a failed chapter shouldn't abort the rest, but it must not vanish either
      // ...unless the SOURCE is refusing. Both other callers of downloadChapter already stop here; this one
      // did not, so a single rate-limit became five. Measured on this install: one unpaced burst against
      // mangakakalot produced five reportFail calls in 74 seconds, and because the cooldown escalates with
      // `consecutive` (15, 30, 45, 60, 75 minutes) it locked the source for 75 minutes instead of 15 --
      // long enough that the person's own manual retry was refused too.
      if (e?.blockStatus) break;
    }
  }
  if (added) notifyNewChapter(seriesId, s.title, added).catch(() => {});
  // backfill release dates onto already-scanned books; freshly downloaded ones are stamped after the sweep's scan
  await setBookDates(s.folder, chapters).catch(() => {});
  return { title: s.title, added, available: chapters.length, outcome: 'ok', failed, folder: s.folder, chapters };
}

/** Sweep the library for new chapters. onlyFavorites keeps a manual run quick; throttled for politeness. */
export async function runUpdateAll(opts: { onlyFavorites?: boolean; maxNew?: number } = {}): Promise<{
  series: number; added: number; failed: number; chapterFailures: number;
  outcomes: Record<UpdateOutcome | 'threw', number>; healthy: boolean;
}> {
  const ids = opts.onlyFavorites
      ? (await q<{ series_id: string }>(`SELECT DISTINCT f.series_id FROM favorites f JOIN lib_series s ON s.id = f.series_id WHERE s.auto_update AND ${visibleToAll('s')}`)).map((r) => r.series_id)
      : (await q<{ id: string }>(`SELECT id FROM lib_series s WHERE s.auto_update AND ${visibleToAll('s')} ORDER BY s.latest_mtime DESC`)).map((r) => r.id);
  let added = 0;
  let chapterFailures = 0;
  // Tallied so the caller can say what happened. `updateSeries` throwing outright is its own outcome:
  // catching it into `{ added: 0 }` is what made "the database went away mid-sweep" read as "nothing new".
  const outcomes: Record<UpdateOutcome | 'threw', number> = { ok: 0, gone: 0, unrouted: 0, blocked: 0, source_error: 0, threw: 0 };
  const dated: { folder: string; chapters: SourceChapter[] }[] = [];
  for (const id of ids) {
    const r = await updateSeries(id, opts.maxNew ?? 10)
      .catch(() => ({ added: 0, outcome: 'threw' as const, failed: 0 } as { added: number; outcome: 'threw'; failed: number; folder?: string; chapters?: SourceChapter[] }));
    added += r.added;
    chapterFailures += r.failed ?? 0;
    outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
    if (r.added && r.folder && r.chapters?.length) dated.push({ folder: r.folder, chapters: r.chapters });
    await new Promise((res) => setTimeout(res, 1500));
  }
  if (added) await persistScan();
  for (const d of dated) await setBookDates(d.folder, d.chapters).catch(() => {}); // stamp the books the scan just created
  // `healthy` is the question the admin panel should have been asking all along: was this a quiet night, or
  // did nothing work? A run where every source failed now looks nothing like one where nothing was new.
  const broken = outcomes.source_error + outcomes.threw;
  return {
    series: ids.length, added, failed: broken, chapterFailures, outcomes,
    healthy: broken === 0 && chapterFailures === 0,
  };
}
