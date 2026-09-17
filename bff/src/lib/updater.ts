// New-chapter updater: for each owned series, ask its source for chapters we don't have yet and download
// them via the downloader. Replaces Suwayomi's update loop. Source routing comes straight from the
// lib_series.source_id / source_series_id columns stamped at add time (backfilled once for older rows) —
// no display-name keyword matching or <Web>-url reverse-parsing.
import { q, one } from './db';
import { getSource, SourceChapter, withTimeout } from './sources';
import { downloadChapter } from './downloader';
import { persistScan, setBookDates, setBookMeta } from './library';
import { blockedNow } from './sourceHealth';
import { noteChapterFailure } from './chapterFailures';
import { budgetFor } from './sources/budget';
import { notifyNewChapter } from './push';
import { visibleToAll } from './visibility';
import { runtime } from './runtime';
import { chooseReleases, releaseOrder } from './releases';
import { effectivePrefsFor, readSeriesPrefs } from './scanlatorPrefs';
import { listingRows, replaceListing } from './seriesListing';

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

/**
 * After this many failed attempts a chapter is left alone by the sweep.
 *
 * Measured over three scheduled sweeps: the same 17 chapters failed three times with IDENTICAL shortfalls
 * (94 of 95 pages, 151 of 176 ...), nothing that had failed twice ever landed, and together they were
 * costing 26 of every 150 attempts, every sweep, forever. A capped chapter still shows on the health page
 * with its count, and "find missing chapters" can still fetch it on purpose; only the unattended sweep
 * stops trying. The ledger row is cleared the moment the chapter lands, so a source that fixes its file
 * clears the cap by itself.
 */
export const CHAPTER_RETRY_CAP = Math.max(1, Number(process.env.CHAPTER_RETRY_CAP) || 3);

export type SweepStop = 'budget' | 'disk' | 'shutdown';

/** What the source said, kept on the row. See the migrate comment on source_chapters. */
async function stampChecked(seriesId: string, chapters: number | null, missing: number | null): Promise<void> {
  await q(
    `UPDATE lib_series SET source_checked_at = now(), source_chapters = $2, source_missing = $3 WHERE id = $1`,
    [seriesId, chapters, missing],
  ).catch(() => {});
}

/** A chapter that landed in this run, and what setBookMeta stamps onto the book the scan mints for it. */
export type Landed = { number: number; scanlator?: string; source?: string };

export interface UpdateResult {
  title: string;
  added: number;
  /** Distinct chapter numbers across every source the series is followed on, after the release choice. */
  available: number;
  outcome: UpdateOutcome;
  failed: number;
  /** Missing numbers the sweep left alone because their preferred group has not released yet (lib/releases.ts). */
  waiting: number;
  landed: Landed[];
  capped?: number;
  folder?: string;
  /** The chosen copy per number, ascending: what setBookDates is stamped from after the scan. */
  chapters?: SourceChapter[];
  diskFull?: boolean;
}

const nothing = (title: string, outcome: UpdateOutcome): UpdateResult =>
  ({ title, added: 0, available: 0, outcome, failed: 0, waiting: 0, landed: [] });

export async function updateSeries(seriesId: string, maxNew = 10, newestOnly = false): Promise<UpdateResult> {
  const s = await one<any>(`SELECT id,title,source_id,source_series_id,web,folder,summary,author,genres,status,chapter_floor,scanlator_prefs FROM lib_series s WHERE s.id=$1 AND ${visibleToAll('s')}`, [seriesId]);
  if (!s) return nothing('', 'gone');

  // Everything the series is followed on: the primary pair first, then series_sources in the order they
  // were added. That order is the tie-break chooseReleases applies between two copies that are otherwise
  // equal, which is what makes the primary win by default. A source whose adapter is not loaded is skipped
  // -- the primary included: a series whose extension was uninstalled but which follows a site that is
  // still here keeps updating from that site, which is the whole reason to follow one, and is what the
  // Health page promises when it lists such a series as reference rather than frozen. Only a series with
  // nothing loaded at all is unrouted. A row naming the primary's own adapter would list it twice: the
  // follow route refuses one, but a row older than that rule must not double the listing.
  const extras = await q<{ source_id: string; source_series_id: string }>(
    'SELECT source_id, source_series_id FROM series_sources WHERE series_id = $1 ORDER BY created_at, source_id', [seriesId],
  ).catch(() => []);
  const followed = [
    ...(s.source_id && s.source_series_id && getSource(s.source_id)
      ? [{ source: s.source_id as string, ref: s.source_series_id as string, primary: true }] : []),
    ...extras.filter((e) => e.source_id !== s.source_id && getSource(e.source_id)).map((e) => ({ source: e.source_id, ref: e.source_series_id, primary: false })),
  ];
  if (!followed.length) return nothing(s.title, 'unrouted');

  // A throw and an empty list are NOT the same answer, and collapsing them is what made a broken source
  // indistinguishable from a series with nothing new. routes/sources.ts already separates these two, with a
  // comment saying why, two files away.
  const tagged: SourceChapter[] = [];
  let blocked = 0;
  let answered = 0;
  for (const f of followed) {
    if (await blockedNow(f.source)) { blocked++; continue; }
    // Looked up again after the awaits above: an extension refresh can unregister an adapter between
    // building the list and asking it, and that is a source that did not answer, not a crash.
    const adapter = getSource(f.source);
    if (!adapter) continue;
    const list = await withTimeout(adapter.listChapters(f.ref), budgetFor(adapter, LIST_TIMEOUT)).catch(() => null);
    if (!list) continue;
    answered++;
    // Copied, not annotated in place: an adapter may hand back the very array its detail cache holds, and
    // a `source` written onto those objects would be there for every later caller of the cache.
    for (const c of list) tagged.push({ ...c, source: f.source });
    // The follower's own stamp, mirroring source_checked_at / source_chapters on the primary below.
    if (!f.primary) {
      await q(`UPDATE series_sources SET checked_at = now(), chapters = $3 WHERE series_id = $1 AND source_id = $2`,
        [seriesId, f.source, new Set(list.map((c) => c.number)).size]).catch(() => {});
    }
  }
  // Stamped on every path where a source was ASKED, so a dead source's series still rotate to the back of
  // the queue instead of sitting at its front forever. Not stamped on the cooldown path: never asked.
  if (blocked === followed.length) return nothing(s.title, 'blocked');
  if (!answered) { await stampChecked(seriesId, null, null); return nothing(s.title, 'source_error'); }

  // One copy per number out of everything listed, by the release preferences: the series' own over the
  // global ones, with the series' patience in force -- this is the sweep, and "Check now" runs the same
  // code, so a number held for the preferred group is held on both. The series' row is only parsed when it
  // has something of its own, which almost none do.
  const prefs = await effectivePrefsFor(s.scanlator_prefs == null ? null : await readSeriesPrefs(seriesId));
  const rank = new Map(followed.map((f, i) => [f.source, i]));
  const chooseOpts = { sourceRank: (id?: string) => rank.get(id ?? '') ?? followed.length };
  const { releases, waiting: held } = chooseReleases(tagged, prefs, chooseOpts);

  // A series added as "latest N" carries a floor, and what the source lists below it is not this job's
  // business: the sweep exists to fetch new releases, and the oldest-first loop below would otherwise spend
  // every night on the back catalogue with the new chapter queued behind it. Applied before `missing` is
  // computed, so the source_missing stamp -- "{n} behind" on the series page -- counts only what the sweep
  // would actually fetch. source_chapters still records the full count: that is what the sources said.
  const floor = s.chapter_floor == null ? -Infinity : Number(s.chapter_floor);
  const wanted = releases.filter((c) => c.number >= floor);
  // What is on disk is never replaced, whoever released it: a copy from a better-ranked group appearing
  // later is not a missing chapter. (A deliberate "replace with the preferred group" would be its own path.)
  const have = new Set((await q<{ number: number }>('SELECT number FROM lib_books WHERE series_id=$1', [seriesId])).map((r) => Number(r.number)));
  const missing = wanted.filter((c) => !have.has(c.number)).sort((a, b) => a.number - b.number);
  await stampChecked(seriesId, releases.length, missing.length);
  // The floor is the SWEEP's rule, not the button's. A follow-only series -- a "Nothing yet" add, or a row
  // imported by the Mihon-backup wizard, which adds every candidate with chapterFrom 'none' -- is floored a
  // hair above everything its source lists today, so `wanted`/`missing` are empty and "Download newest"
  // would answer "already at latest" over a series holding no chapters at all. The explicit action picks
  // from EVERY release instead: the floor exists to stop the unattended sweep backfilling a back catalogue,
  // and a person who clicked the button is not the sweep. `missing` above is still what gets stamped, so
  // "{n} behind" keeps counting only what the sweep would fetch.
  const newestMissing = newestOnly
    ? releases.filter((c) => !have.has(c.number)).sort((a, b) => a.number - b.number)
    : [];
  // Chapters that have already failed CHAPTER_RETRY_CAP times are not attempted again by the sweep.
  const cappedNums = new Set(
    (await q<{ number: number }>(`SELECT number FROM chapter_failures WHERE series_id = $1 AND attempts >= $2`, [seriesId, CHAPTER_RETRY_CAP])
      .catch(() => [])).map((r) => Number(r.number)),
  );
  // A number being held for its preferred group is still missing -- "{n} behind" must say so -- but it is
  // not fetched: the whole point of the hold is that the copy on offer is not the one wanted yet.
  const heldNums = new Set(held);
  const eligible = missing.filter((c) => !cappedNums.has(c.number) && !heldNums.has(c.number));
  const capped = missing.filter((c) => cappedNums.has(c.number)).length;
  const waiting = missing.filter((c) => heldNums.has(c.number)).length;
  // "Download newest" (the library toolbar) queues ONLY the newest missing chapter, floor ignored
  // (newestMissing above). The sweep's oldest-first order is for backfilling; this action is named for the
  // latest release, so the newest takes the queue. Neither the retry cap nor a hold filters it: an explicit
  // click is the series page's manual-fetch precedent, and those guards exist to hold back the unattended
  // sweep, not a person. Everything else (stamps, clearance, the refusal break) is this same loop with one
  // row in the queue.
  const queue = newestOnly ? newestMissing.slice(-1) : eligible;

  // What the sources listed, kept for the series page and for manual fetches (lib/seriesListing.ts).
  // Persisted BEFORE the download loop so a listing survives a run the budget or the disk cuts short --
  // the loop below can break out on the first chapter, and a series page that says "as of tonight" over
  // last week's rows would be lying. It sits AFTER the unrouted / blocked / source_error early returns on
  // purpose: a source that did not answer leaves the previous listing standing, because stale beats empty
  // -- the same rule as the latestPage cache in routes/sources.ts. Best effort, like the stamps: a ledger
  // must never be the thing that stops a download.
  //
  // ⚠️ An EMPTY list is not an answer either. A moved domain serving a 404 page, a parser regression, a
  // site that has hidden its chapter list behind a challenge -- every one of these resolves listChapters
  // to `[]` rather than throwing (the moved-domain trap this install has already been through), and
  // `answered` counts it as a source that spoke. Writing that through would replace a two-hundred-row
  // listing with nothing: every ghost row gone from the series page, every manual fetch `not_listed`,
  // the known-group picker blind to the series -- silently, for as long as the source stays broken. So
  // a source that lists nothing leaves the previous listing standing, exactly like one that did not answer.
  // Reintroduce by dropping the `tagged.length` guard: "a source that answered with nothing leaves the
  // previous listing standing" in seriesListing.int.test.ts reads 0 rows.
  // The copies of each number are stored in the same order the chooser ranked them (releaseOrder with
  // the same source ranks), so the listing's "best first" is the sweep's, not a second opinion.
  if (tagged.length) await replaceListing(seriesId, listingRows(tagged, releases, heldNums, s.source_id, releaseOrder(prefs, chooseOpts))).catch(() => {});

  let added = 0;
  let failed = 0;
  let diskFull = false;
  let attempts = 0;
  const landed: Landed[] = [];
  // A source that has refused once this run is not asked again, but the others still are: a rate-limited
  // primary must not stop the follower's chapters, which are the reason the follower was added. The loop
  // ends only when every followed source is refusing -- which for a series with one source is the first
  // refusal, as before -- so each source still costs at most one strike per run.
  const refusing = new Set<string>();
  // oldest-missing-first: a partial "first N" add fills forward coherently, and new releases (all > our max)
  // are still the only gap once a series is fully downloaded.
  for (const ch of queue) {
    if (attempts >= maxNew) break;
    if (runtime.stopping) break; // between chapters, never mid-write
    const via = ch.source ?? (s.source_id as string);
    if (refusing.has(via)) continue;
    attempts++;
    try {
      const res = await downloadChapter({
        sourceId: via,
        seriesFolder: s.folder,
        chapter: ch,
        meta: { series: s.title, summary: s.summary, author: s.author, genres: s.genres, url: s.web, status: s.status },
      });
      if (!res.skipped) { added++; landed.push({ number: ch.number, scanlator: ch.scanlator, source: via }); }
    } catch (e: any) {
      // The library disk is at its floor: not this chapter's fault, not the source's, and pointless to try
      // the next one. Stop here and let the sweep say so.
      if (e?.diskFull) { diskFull = true; break; }
      failed++; // a failed chapter shouldn't abort the rest, but it must not vanish either
      await noteChapterFailure({ seriesId, title: s.title, number: ch.number, sourceId: via, err: e });
      // ...unless the SOURCE is refusing. Both other callers of downloadChapter already stop here; this one
      // did not, so a single rate-limit became five. Measured on this install: one unpaced burst against
      // mangakakalot produced five reportFail calls in 74 seconds, and because the cooldown escalates with
      // `consecutive` (15, 30, 45, 60, 75 minutes) it locked the source for 75 minutes instead of 15 --
      // long enough that the person's own manual retry was refused too.
      if (e?.blockStatus) {
        refusing.add(via);
        if (followed.every((f) => refusing.has(f.source))) break;
      }
    }
  }
  if (added) notifyNewChapter(seriesId, s.title, added).catch(() => {});
  // backfill release dates onto already-scanned books; freshly downloaded ones are stamped after the sweep's scan
  await setBookDates(s.folder, releases).catch(() => {});
  // Provenance goes only onto what LANDED, never onto the whole listing: the chosen copy for a number can
  // change between runs, and the file on disk does not change with it.
  await setBookMeta(s.folder, landed).catch(() => {});
  return { title: s.title, added, available: releases.length, outcome: 'ok', failed, waiting, landed, capped, folder: s.folder, chapters: releases, diskFull };
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
  series: number; visited: number; added: number; failed: number; chapterFailures: number; capped: number;
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
  let capped = 0;
  let visited = 0;
  let spent = 0;
  let stopped: SweepStop | undefined;
  // Tallied so the caller can say what happened. `updateSeries` throwing outright is its own outcome:
  // catching it into `{ added: 0 }` is what made "the database went away mid-sweep" read as "nothing new".
  // `skipped` is what the budget or a parked source left unvisited: not a failure, and not nothing either.
  const outcomes: Record<UpdateOutcome | 'threw' | 'skipped', number> = { ok: 0, gone: 0, unrouted: 0, blocked: 0, source_error: 0, threw: 0, skipped: 0 };
  const dated: { folder: string; chapters: SourceChapter[]; landed: Landed[] }[] = [];

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
        .catch(() => ({ added: 0, outcome: 'threw' as const, failed: 0, landed: [] } as { added: number; outcome: 'threw'; failed: number; folder?: string; chapters?: SourceChapter[]; landed: Landed[]; diskFull?: boolean }));
      added += r.added;
      chapterFailures += r.failed ?? 0;
      capped += (r as { capped?: number }).capped ?? 0;
      spent += r.added + (r.failed ?? 0);
      outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
      if (r.added && r.folder && r.chapters?.length) dated.push({ folder: r.folder, chapters: r.chapters, landed: r.landed });
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
  for (const d of dated) { // stamp the books the scan just created
    await setBookDates(d.folder, d.chapters).catch(() => {});
    await setBookMeta(d.folder, d.landed).catch(() => {});
  }
  // `healthy` is the question the admin panel should have been asking all along: was this a quiet night, or
  // did nothing work? A run where every source failed now looks nothing like one where nothing was new.
  const broken = outcomes.source_error + outcomes.threw;
  return {
    series: rows.length, visited, added, failed: broken, chapterFailures, capped, outcomes, stopped,
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
        `${r.chapterFailures ? ` and ${r.chapterFailures} chapters could not be saved` : ''}` +
        `${r.capped ? ` (${r.capped} left alone after ${CHAPTER_RETRY_CAP} failed tries)` : ''} ` +
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
