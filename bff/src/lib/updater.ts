// New-chapter updater: for each owned series, ask its source for chapters we don't have yet and download
// them via the downloader. Replaces Suwayomi's update loop. Source routing comes straight from the
// lib_series.source_id / source_series_id columns stamped at add time (backfilled once for older rows) —
// no display-name keyword matching or <Web>-url reverse-parsing.
import { q, one } from './db';
import { getSource, SourceChapter, withTimeout } from './sources';
import { downloadChapter } from './downloader';
import { persistScan, setBookDates } from './library';
import { blockedNow } from './sourceHealth';
import { noteChapterFailure } from './chapterFailures';
import { notifyNewChapter } from './push';
import { visibleToAll } from './visibility';
import { runtime } from './runtime';

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

/**
 * Attempts (added + failed) one sweep may spend before it stops and says so.
 *
 * Until this existed the only cap was `maxNew` per series, so a sweep's ceiling was 226 x 5 = 1,130
 * chapters -- and after v0.13.0 revived 176 series that were ~12,000 chapters behind, that was the plan for
 * every night, on a disk at 87%. 150 fits inside the 6-hour interval with the page pacing (~55s a chapter
 * plus ~45 min of listings), drains that backlog in about three weeks, and is a number an operator can read.
 * Chapters already on disk are skipped for free and do not count.
 */
const SWEEP_MAX = Number(process.env.UPDATER_SWEEP_MAX) || 150;

export type SweepStop = 'budget' | 'disk' | 'shutdown';

/** What the source said, kept on the row. See the migrate comment on source_chapters. */
async function stampChecked(seriesId: string, chapters: number | null, missing: number | null): Promise<void> {
  await q(
    `UPDATE lib_series SET source_checked_at = now(), source_chapters = $2, source_missing = $3 WHERE id = $1`,
    [seriesId, chapters, missing],
  ).catch(() => {});
}

export async function updateSeries(
  seriesId: string,
  maxNew = 10,
): Promise<{ title: string; added: number; available: number; outcome: UpdateOutcome; failed: number; folder?: string; chapters?: SourceChapter[]; diskFull?: boolean }> {
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
  // Stamped on every path where the source was ASKED, so a dead source's series still rotate to the back of
  // the queue instead of sitting at its front forever. Not stamped above, on the cooldown path: never asked.
  if (listFailed) { await stampChecked(seriesId, null, null); return { title: s.title, added: 0, available: 0, outcome: 'source_error', failed: 0 }; }
  if (!chapters.length) { await stampChecked(seriesId, 0, 0); return { title: s.title, added: 0, available: 0, outcome: 'ok', failed: 0 }; }

  const have = new Set((await q<{ number: number }>('SELECT number FROM lib_books WHERE series_id=$1', [seriesId])).map((r) => Number(r.number)));
  const missing = chapters.filter((c) => !have.has(c.number)).sort((a, b) => a.number - b.number);
  await stampChecked(seriesId, chapters.length, missing.length);

  let added = 0;
  let failed = 0;
  let diskFull = false;
  // oldest-missing-first: a partial "first N" add fills forward coherently, and new releases (all > our max)
  // are still the only gap once a series is fully downloaded.
  for (const ch of missing.slice(0, maxNew)) {
    if (runtime.stopping) break; // between chapters, never mid-write
    try {
      const res = await downloadChapter({
        sourceId: s.source_id,
        seriesFolder: s.folder,
        chapter: ch,
        meta: { series: s.title, summary: s.summary, author: s.author, genres: s.genres, url: s.web, status: s.status },
      });
      if (!res.skipped) added++;
    } catch (e: any) {
      // The library disk is at its floor: not this chapter's fault, not the source's, and pointless to try
      // the next one. Stop here and let the sweep say so.
      if (e?.diskFull) { diskFull = true; break; }
      failed++; // a failed chapter shouldn't abort the rest, but it must not vanish either
      await noteChapterFailure({ seriesId, title: s.title, number: ch.number, sourceId: s.source_id, err: e });
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
  return { title: s.title, added, available: chapters.length, outcome: 'ok', failed, folder: s.folder, chapters, diskFull };
}

/**
 * Sweep the library for new chapters.
 *
 * Three things this loop did not do, and what each cost on the night it was measured:
 *
 * - It had no budget. The only cap was maxNew per series, so a sweep's ceiling was every series times five.
 * - It walked series in `latest_mtime DESC` order, freshest first. The 54 series furthest behind sorted LAST,
 *   so anything that cut a sweep short starved exactly them, every night.
 * - It walked them in one flat line. 192 of 226 series share one source, and when that source went into a
 *   cooldown 28 series in, the remaining 164 were skipped one after another -- and the 34 series on other
 *   sources behind them in the line never got their turn either.
 *
 * Now: one queue per source, visited round-robin, least-recently-checked first; a source that goes into a
 * cooldown parks its own queue and nobody else's; attempts stop at SWEEP_MAX; a full disk stops everything
 * and says so. Chapters already on disk cost nothing against the budget.
 */
export async function runUpdateAll(opts: { onlyFavorites?: boolean; maxNew?: number; sweepMax?: number } = {}): Promise<{
  series: number; visited: number; added: number; failed: number; chapterFailures: number;
  outcomes: Record<UpdateOutcome | 'threw' | 'skipped', number>; healthy: boolean; stopped?: SweepStop;
}> {
  const sweepMax = opts.sweepMax ?? SWEEP_MAX;
  // Rows never checked sort first, so the first sweep after this change visits in the old order.
  const order = 'ORDER BY s.source_checked_at ASC NULLS FIRST, s.latest_mtime DESC';
  const rows = opts.onlyFavorites
      ? await q<{ id: string; source_id: string | null }>(`SELECT DISTINCT s.id, s.source_id, s.source_checked_at, s.latest_mtime FROM favorites f JOIN lib_series s ON s.id = f.series_id WHERE s.auto_update AND ${visibleToAll('s')} ${order}`)
      : await q<{ id: string; source_id: string | null }>(`SELECT s.id, s.source_id FROM lib_series s WHERE s.auto_update AND ${visibleToAll('s')} ${order}`);

  const queues = new Map<string, string[]>();
  for (const r of rows) {
    const k = r.source_id || '';
    if (!queues.has(k)) queues.set(k, []);
    queues.get(k)!.push(r.id);
  }
  const parked = new Set<string>();

  let added = 0;
  let chapterFailures = 0;
  let visited = 0;
  let spent = 0;
  let stopped: SweepStop | undefined;
  // Tallied so the caller can say what happened. `updateSeries` throwing outright is its own outcome:
  // catching it into `{ added: 0 }` is what made "the database went away mid-sweep" read as "nothing new".
  // `skipped` is what the budget or a parked source left unvisited: not a failure, and not nothing either.
  const outcomes: Record<UpdateOutcome | 'threw' | 'skipped', number> = { ok: 0, gone: 0, unrouted: 0, blocked: 0, source_error: 0, threw: 0, skipped: 0 };
  const dated: { folder: string; chapters: SourceChapter[] }[] = [];

  sweep: while (queues.size) {
    let progressed = false;
    for (const [src, ids] of [...queues]) {
      if (!ids.length) { queues.delete(src); continue; }
      if (parked.has(src)) continue;
      if (runtime.stopping) { stopped = 'shutdown'; break sweep; }
      if (spent >= sweepMax) { stopped = 'budget'; break sweep; }
      const id = ids.shift()!;
      progressed = true;
      visited++;
      const r = await updateSeries(id, Math.min(opts.maxNew ?? 10, Math.max(1, sweepMax - spent)))
        .catch(() => ({ added: 0, outcome: 'threw' as const, failed: 0 } as { added: number; outcome: 'threw'; failed: number; folder?: string; chapters?: SourceChapter[]; diskFull?: boolean }));
      added += r.added;
      chapterFailures += r.failed ?? 0;
      spent += r.added + (r.failed ?? 0);
      outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
      if (r.added && r.folder && r.chapters?.length) dated.push({ folder: r.folder, chapters: r.chapters });
      if (r.diskFull) { stopped = 'disk'; break sweep; }
      if (r.outcome === 'blocked') parked.add(src);
      await new Promise((res) => setTimeout(res, 1500));
    }
    if (!progressed) {
      // Only parked queues remain. Ask once whether any cooldown has lapsed; if none has, the sweep is over.
      let freed = false;
      for (const src of parked) if (!(await blockedNow(src))) { parked.delete(src); freed = true; }
      if (!freed) break;
    }
  }
  for (const ids of queues.values()) outcomes.skipped += ids.length;

  if (added) await persistScan();
  for (const d of dated) await setBookDates(d.folder, d.chapters).catch(() => {}); // stamp the books the scan just created
  // `healthy` is the question the admin panel should have been asking all along: was this a quiet night, or
  // did nothing work? A run where every source failed now looks nothing like one where nothing was new.
  const broken = outcomes.source_error + outcomes.threw;
  return {
    series: rows.length, visited, added, failed: broken, chapterFailures, outcomes, stopped,
    healthy: broken === 0 && chapterFailures === 0 && stopped !== 'disk' && stopped !== 'shutdown',
  };
}

/** The part of a Fastify logger the sweep reports through. A test hands in one that captures. */
export type SweepLog = { info(msg: string): void; warn(msg: string): void; error(err: unknown): void };
export type SweepOpts = Parameters<typeof runUpdateAll>[0];
export type SweepResult = Awaited<ReturnType<typeof runUpdateAll>>;

/**
 * Run one sweep the way the scheduled one is run: flagged as running while it goes, refused if one already
 * is, its result kept for the admin panel, and one summary line in the log when it ends.
 *
 * All of that lived in server.ts's tick, and the panel's "Run now" button did none of it. It called
 * runUpdateAll bare, so a manual sweep reported `running: false` for its whole duration (measured live:
 * well over ten minutes, with `lastResult` still saying whatever the night before had said), wrote nothing
 * to the log when it finished, swallowed a throw with a `.catch(() => {})`, and -- since `runtime.updating`
 * is the tick's only overlap guard -- a scheduled sweep could start on top of it.
 *
 * Returns `false`, synchronously and without starting, when a sweep is already running. Otherwise the
 * promise of the result, which resolves to null if the sweep itself threw: that is logged here, so no
 * caller has to remember to, and none needs a `.catch(() => {})` again.
 *
 * `sweep` is the seam a test uses to make the sweep itself throw. No fake source can: a source that throws
 * is a per-series `source_error`, which is the sweep working as designed.
 */
export function runSweep(opts: SweepOpts, log: SweepLog, sweep: typeof runUpdateAll = runUpdateAll): Promise<SweepResult | null> | false {
  if (runtime.updating) return false;
  // Set before the first await, so two starts in the same turn of the event loop cannot both get through.
  runtime.updating = true;
  return (async () => {
    try {
      const r = await sweep(opts);
      runtime.lastUpdate = Date.now();
      // Persisted so a restart schedules the remainder of the interval rather than a whole new one.
      await q(`UPDATE server_settings SET updater_last_run = now() WHERE id = 1`).catch(() => {});
      runtime.lastUpdateResult = { series: r.series, visited: r.visited, added: r.added, failed: r.failed, chapterFailures: r.chapterFailures, healthy: r.healthy, stopped: r.stopped };
      // A sweep that added nothing because nothing was new, and one that added nothing because every source
      // was down, used to print the identical line. They no longer do. Nor does a sweep that finished look
      // like one the budget or the disk cut short.
      const scope = `visited ${r.visited} of ${r.series} series${r.stopped ? ` (stopped: ${r.stopped})` : ''}`;
      if (r.healthy) log.info(`updater: +${r.added} chapters, ${scope}`);
      else log.warn(
        `updater: +${r.added} chapters, ${scope}, but ${r.failed} series failed to answer` +
        `${r.chapterFailures ? ` and ${r.chapterFailures} chapters could not be saved` : ''} ` +
        `(${Object.entries(r.outcomes).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`).join(' ')})`,
      );
      return r;
    } catch (e) {
      // The rule the backup path already follows: the panel must not keep showing the last good run as if it
      // were this one. Last run moves to now, the result is cleared, and the reason is in `docker logs`.
      runtime.lastUpdate = Date.now();
      runtime.lastUpdateResult = null;
      log.error(e);
      return null;
    } finally {
      runtime.updating = false;
    }
  })();
}
