// New-chapter updater: for each owned series, ask its source for chapters we don't have yet and download
// them via the downloader. Replaces Suwayomi's update loop. Source routing comes straight from the
// lib_series.source_id / source_series_id columns stamped at add time (backfilled once for older rows) —
// no display-name keyword matching or <Web>-url reverse-parsing.
import { q, one } from './db';
import { getSource, SourceChapter, withTimeout } from './sources';
import { persistScan, setBookDates, setBookMeta, DL_ROOT } from './library';
import { blockedNow, isDisabled, noteStage } from './sourceHealth';
import { standingsOf, switchedOff } from './sourceStanding';
import { noteChapterFailure } from './chapterFailures';
import { budgetFor } from './sources/budget';
import { notifyNewChapter } from './push';
import { sendDigest, type Landed as DigestSeries } from './notify';
import { visibleToAll } from './visibility';
import { runtime } from './runtime';
import { chooseReleases, copiesOf, releaseOrder } from './releases';
import { effectivePrefsFor, readSeriesPrefs } from './scanlatorPrefs';
import { automaticChapterAllowedFor, automaticCopiesFor, copyToChapter, listingRows, replaceListing, seriesFollowsSource, type ListingCopy } from './seriesListing';
import { heldBooks } from './chapterCleanup';
import { downloadWithFallback, type FallbackOutcome } from './chapterFallback';
import { huntSource, seriesIsAdult, sweepAllowedFor, HUNT_MAX_PER_SWEEP } from './sourceHunt';
import { completePartial, PARTIAL_COMPLETE_MAX } from './partial';
import { effectiveSourcePriority, rankSources } from './sourcePrefs';
import { languageRulesFor } from './copyLanguage';
import { beginRun, endRun, stopRequested, type RunCard } from './downloadJobs';
import { say } from './said';
import { withOrigin } from './downloadActivity';
import { decideNumbering, folderBusy, numberedChapters, renumberRunning, resumeRenumber, settleNumbering, NUMBERING_COLUMNS, type Settled } from './numbering';
import { aliasParts, partRulesApply } from './partAlias';
import { atHiddenNumber, isListedNotice } from './noticeChapters';
import { hiddenNumbersOf } from './hiddenChapters';
import { numKey } from './postingOrder';
import { seriesHidesNotices } from './noticeSettings';
import { heldBy, rangeEnd, rawRangeEnd } from './chapterRanges';
import { isDue, refreshRadar } from './releaseRadar';
import { finishDownloadsOn, retryCapFor, BEHIND_SQL, FINISH_MINUTES, FINISH_LANES, clearQuiet, quietWanted } from './finishDownloads';
import { requestScout } from './scoutRequests';
import { rateKeyOf } from './pace';
import { routeCopy, sameReleaseChapters } from './copyRouter';

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
  | 'busy'          // another writer owns the series folder; nothing was read or written
  | 'gone'          // hidden, merged or deleted since the sweep started
  | 'unrouted'      // no source installed, or the row was never stamped with one
  | 'blocked'       // the source is inside a back-off window
  | 'source_error'  // threw or timed out: the one that used to look like good news
  | 'renumber_pending' // held until an admin confirms a renumber (lib/numbering.ts): nothing listed, nothing fetched
  | 'off'           // v0.54.0: every source it follows is switched off, so none was asked (not a failure: a choice)
  | 'paused';       // an unattended run (UpdateOpts.unattended) on a series that is not monitored: nothing asked or fetched

/**
 * The same bound the add path uses (routes/sources.ts). Unbounded, one hung site held the whole sweep -- the
 * loop is sequential with a 1.5s pause, so every series behind it waited on undici's 300s default.
 */
export const LIST_TIMEOUT = Number(process.env.UPDATER_LIST_TIMEOUT_MS) || 20_000;

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

/** `cancelled`: an admin pressed Cancel on the run's card (lib/downloadJobs.ts), and it stopped after the chapter in flight. */
/** `yield` (v0.79.0): a finishing sweep that gave way to another job (lib/finishDownloads.ts wantQuiet). */
export type SweepStop = 'budget' | 'disk' | 'shutdown' | 'cancelled' | 'yield';

/**
 * When the first of these sources, which did not answer this run, can be asked again (v0.79.0, `finish_after`): a cooling
 * one at the end of its cooldown; one that threw, or is resting (Fix everything's run-long pause), a finishing interval on.
 */
async function staleUntil(stale: ReadonlyMap<string, 'cooling' | 'threw'>): Promise<Date> {
  const soon = Date.now() + FINISH_MINUTES * 60_000;
  const cooling = [...stale].filter(([, why]) => why === 'cooling').map(([id]) => id);
  const rows = cooling.length
    ? await q<{ until: Date }>('SELECT blocked_until AS until FROM source_health WHERE source_id = ANY($1) AND blocked_until > now()', [cooling]).catch(() => [])
    : [];
  const ends = rows.map((r) => new Date(r.until).getTime());
  if (ends.length < stale.size) ends.push(soon);
  return new Date(Math.min(...ends));
}

/**
 * What the source said, kept on the row. See the migrate comment on source_chapters. No answer (`missing` null) clears
 * finish_missing too: the finishing sweep (lib/finishDownloads.ts) must not go back every quarter of an hour to a source
 * that is not answering -- the scheduled sweep asks it again.
 */
async function stampChecked(seriesId: string, chapters: number | null, missing: number | null): Promise<void> {
  await q(
    `UPDATE lib_series SET source_checked_at = now(), source_chapters = $2, source_missing = $3,
            finish_missing = CASE WHEN $3::int IS NULL THEN NULL ELSE finish_missing END,
            finish_after = CASE WHEN $3::int IS NULL THEN NULL ELSE finish_after END WHERE id = $1`,
    [seriesId, chapters, missing],
  ).catch(() => {});
}

/**
 * A chapter that landed in this run, and what setBookMeta stamps onto the book the scan mints for it. `missing` =
 * 1-based placeholder pages of a partial (lib/partial.ts); `title` = the source's name for it; `chapterId` = the
 * source chapter the file was written from, so a later remap of the series' numbers knows exactly which post
 * the file is (lib/numbering.ts).
 */
export type Landed = { number: number; scanlator?: string; source?: string; missing?: number[]; title?: string; chapterId?: string };

export interface UpdateResult {
  title: string;
  added: number;
  /** Distinct chapter numbers across every source the series is followed on, after the release choice. */
  available: number;
  outcome: UpdateOutcome;
  failed: number;
  /** Missing numbers the sweep left alone because their preferred group has not released yet (lib/releases.ts). */
  waiting: number;
  /** Of `added`, how many came from a source other than the chosen copy's (lib/chapterFallback.ts). */
  switched: number;
  /** Of `added`, how many were saved with placeholder pages (`Landed.missing`; lib/partial.ts). */
  partial: number;
  landed: Landed[];
  capped?: number;
  folder?: string;
  /** The chosen copy per number, ascending: what setBookDates is stamped from after the scan. */
  chapters?: SourceChapter[];
  diskFull?: boolean;
  /**
   * Whether at least one followed source was asked for its listing this run. False on every early return
   * (gone, unrouted, every source in a cooldown, every source disabled): those cost no network call, and
   * a caller that paces between series for the sources' sake (lib/bulkNewest.ts) has nothing to pace for.
   */
  asked: boolean;
  /** Only with `newestOnly`: what became of the newest listed release. See `NewestVerdict`. */
  newest?: NewestVerdict;
  /** A pending numbering change this run settled or held (lib/numbering.ts): what it did, and the plan. */
  renumber?: Settled;
}

/**
 * The verdict on the one number a "Fetch newest" run cares about (lib/bulkNewest.ts).
 *
 * `queued`: it was not on disk and went through the download loop -- `added` / `failed` say how that went.
 * `on_disk`: the row was missing but the file was already there (a download nobody scanned), so nothing
 * was fetched and a scan is what the caller owes. The rest fetched nothing, each for a reason the person
 * is told: `up_to_date` (a live row holds it, or the series is Latest-N and caught up), `deleted` (we hold
 * it only as a tombstone the read-chapter cleanup or Delete files left -- the bytes went on purpose, and
 * "already here" would send the person to a row with no pages behind it; the series page's Fetch again is
 * the deliberate way back), `held` (its preferred group has not released it yet -- a person who wants this
 * copy anyway picks it on the series page), `disabled` (the admin switched its source off; `number` is
 * null when every followed source was disabled, because none was asked for a listing), `denied` (an adult
 * source on a capped account), `unlisted` (the sources answered with no chapters at all).
 */
export type NewestVerdict = {
  number: number | null;
  state: 'queued' | 'on_disk' | 'up_to_date' | 'deleted' | 'held' | 'disabled' | 'denied' | 'unlisted';
};

export interface UpdateOpts {
  /**
   * Take the newest LISTED release and nothing else, ignoring `chapter_floor` for that one number only.
   *
   * ⚠️ Not "the newest MISSING number". A series added as Latest-25 of 200 that is fully caught up has
   * chapters 1..175 missing under its floor, and "newest missing" is 175: the button would backfill the
   * back catalogue one chapter per click and report each as a download. The rule here is max(listed);
   * if the have-set holds it the series is up to date, whatever sits below the floor. The floor itself
   * is not moved, so the next sweep still wants >= floor, and a "Nothing yet" series (floored a hair above
   * everything its source lists) behaves the same as before once its newest chapter has landed.
   */
  newestOnly?: boolean;
  /** The viewer's age gate for the newest copy's source (visibility.sourceAllowedFor). Absent = allowed. */
  sourceAllowed?: (sourceId: string) => boolean;
  /**
   * The source hunt's budget for this run (lib/sourceHunt.ts): how many hunts may still start. The sweep
   * hands ONE budget to every series it visits, so a night costs at most HUNT_MAX_PER_SWEEP searches
   * however many chapters fail; a standalone "Check now" gets a budget of its own (it runs the same code,
   * and the hunt's own once-a-day stamp bounds it); `false` turns the hunt off for the run. "Fetch newest"
   * never hunts: a person is watching a bulk progress surface, and the sweep tonight will.
   */
  hunt?: { left: number } | false;
  /**
   * Asked between chapters, beside `runtime.stopping`: true stops the run after the chapter in flight. The
   * sweep, the repair and a bulk "Fetch newest" pass their run card's cancel flag (lib/downloadJobs.ts, #82);
   * nothing else stops a series part-way.
   */
  cancelled?: () => boolean;
  /**
   * Fetch below an active slow archive's boundary as well (#117): Health's Fill now on an archived series is a
   * person asking for those chapters now, at normal pace, rather than waiting for the archive's turn.
   */
  ignoreArchiveBoundary?: boolean;
  /**
   * An admin has seen the plan of this series' pending numbering change and confirmed it (lib/numbering.ts
   * requestNumbering): the run applies it even though files are renamed. Nothing else passes it -- a series in
   * a library is never renumbered unattended.
   * `'clean'` (v0.55.0): Fix everything, which the owner allowed to apply a plan only when the plan built at the apply
   * is marked `clean` (lib/postingOrder.ts: nothing parked, no guess, no collision, no tracker push, no download
   * running); any other plan stays held for an admin.
   */
  confirmRenumber?: boolean | 'clean';
  /**
   * v0.55.1, Fix everything's chapters phase: sources this run leaves alone as if they were in a cooldown -- cooling
   * down or rate-limited when the phase began (lib/autofix.ts). Never asked for a listing, never downloaded from, never
   * hunted: the owner's first run re-checked failed chapters through Natomanga and Mangakakalot while they answered
   * 429, and 28 chapters failed again inside four minutes. Their chapters are the sweep's once the site is ready.
   */
  resting?: (sourceId: string) => boolean;
  /**
   * A run nobody asked for on this series: a repair step, Fix everything, a retry of failed chapters. Such a run leaves
   * an unmonitored series alone (`lib_series.auto_update` off, "Unmonitor" in the library's select bar): it answers
   * `paused` before asking any source, so no new chapter is searched for or downloaded. A listing-only run (maxNew 0)
   * downloads nothing and still goes ahead. Absent for everything a person starts on the series itself -- Check now,
   * Fetch, Fetch again, Fill now -- which an unmonitored series still answers.
   */
  unattended?: boolean;
  /**
   * Admin -> Settings "Finish downloads on their own" (lib/finishDownloads.ts), read once by the sweep and handed to
   * every series it visits. Absent, the series reads the switch itself. On, a chapter a site refused (rate-limited,
   * blocked) gets REFUSAL_RETRY_CAP tries instead of CHAPTER_RETRY_CAP before this run leaves it alone.
   */
  finish?: boolean;
  /**
   * The caller already owns this folder's shared writer mark (`busyFolders`). Internal only: bulk newest,
   * archive and repair take the mark synchronously before entering updateSeries and must be allowed through
   * their own guard. Every unmarked entry point is refused while any writer owns the folder.
   */
  folderHeld?: boolean;
}

/**
 * The slow archive's boundary while it is queued or paused (#117), as a column of `lib_series s`: the sweep's floor
 * rises to it. Read with the row, and again wherever a renumber (#116) may just have moved it.
 */
const ARCHIVE_BOUNDARY = `(SELECT a.boundary FROM archive_queue a WHERE a.series_id = s.id AND a.state IN ('queued', 'paused')) AS archive_boundary`;

const nothing = (title: string, outcome: UpdateOutcome): UpdateResult =>
  ({ title, added: 0, available: 0, outcome, failed: 0, waiting: 0, switched: 0, partial: 0, landed: [], asked: false });

/**
 * How many runs of updateSeries are inside each series right now: the sweep, a check, a listing refresh, Fill, a
 * bulk fetch, the slow archive's listing. A renumber (#116) is carried out only by the one run inside its series
 * (lib/numbering.ts settleNumbering), and a confirmation is refused while any run is (routes/numbering.ts):
 * busyFolders and the activity list cover only the moments a chapter is downloading, and a run that read its
 * listing and have-set before the renames would fetch into the old numbers after them (#116 review).
 */
const inside = new Map<string, number>();
export function runsInside(seriesId: string): number { return inside.get(seriesId) ?? 0; }

/** The last-responsible-moment guard shared by every unattended downloader. Missing/hidden rows fail closed. */
export async function seriesIsMonitored(seriesId: string): Promise<boolean> {
  const row = await one<{ auto_update: boolean }>(
    `SELECT auto_update FROM lib_series s WHERE s.id = $1 AND ${visibleToAll('s')}`, [seriesId]).catch(() => null);
  return row?.auto_update === true;
}

export async function updateSeries(seriesId: string, maxNew = 10, opts: UpdateOpts = {}): Promise<UpdateResult> {
  inside.set(seriesId, runsInside(seriesId) + 1);
  try {
    return await visitSeries(seriesId, maxNew, opts);
  } finally {
    const left = runsInside(seriesId) - 1;
    if (left > 0) inside.set(seriesId, left);
    else inside.delete(seriesId);
  }
}

async function visitSeries(seriesId: string, maxNew: number, opts: UpdateOpts): Promise<UpdateResult> {
  let s = await one<any>(`SELECT id,title,source_id,source_series_id,web,folder,summary,author,genres,status,chapter_floor,scanlator_prefs,source_prefs,auto_update,
    ${NUMBERING_COLUMNS}, ${ARCHIVE_BOUNDARY} FROM lib_series s WHERE s.id=$1 AND ${visibleToAll('s')}`, [seriesId]);
  if (!s) return nothing('', 'gone');
  // This is the common boundary for direct Check/update calls as well as background refreshes. Route-level
  // jobBusy checks make the usual answer a 409, but only this last-responsible-moment check closes the gap in
  // which a destructive bulk run claims the folder after a request's lookup and before updateSeries starts.
  // Callers that deliberately took the shared mark pass folderHeld; nobody else may list, stamp or download
  // while a delete, rescan, renumber, archive turn or download job owns the folder.
  // A second check is deliberately allowed to join an in-process renumber journal: it waits for the first runner,
  // re-reads the journal, and then continues under the finished numbering. That mark is the numbering operation's
  // own shared claim, not an unrelated writer. `runsInside` prevents a destructive writer from entering meanwhile.
  if (!opts.folderHeld && folderBusy(s.folder) && !(s.renumber_plan && renumberRunning(seriesId))) {
    return nothing(s.title, 'busy');
  }
  // Unmonitored (UpdateOpts.unattended): nothing searched for or downloaded by a run nobody started on this series.
  if (opts.unattended && s.auto_update === false) return nothing(s.title, 'paused');
  // A renumber a crash interrupted is finished before anything here reads lib_books: its files are at their new
  // names and its rows at their old ones until then. One that cannot be finished keeps the series held. A journal
  // whose apply is still running (a check that starts during a confirmed renumber finds it on the row) is waited for
  // and then found finished, never run a second time (lib/numbering.ts runJournal).
  if (s.renumber_plan) {
    const done = await resumeRenumber(seriesId).then(() => true, (e) => {
      console.warn(`[numbering] ${s.title}: the interrupted renumber could not be finished: ${(e as Error)?.message || e}`);
      return false;
    });
    if (!done) return nothing(s.title, 'renumber_pending');
    s = { ...s, ...(await one<any>(`SELECT chapter_floor, ${ARCHIVE_BOUNDARY}, ${NUMBERING_COLUMNS} FROM lib_series s WHERE s.id = $1`, [seriesId])) };
  }

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
  let followed = [
    ...(s.source_id && s.source_series_id && getSource(s.source_id)
      ? [{ source: s.source_id as string, ref: s.source_series_id as string, primary: true }] : []),
    ...extras.filter((e) => e.source_id !== s.source_id && getSource(e.source_id)).map((e) => ({ source: e.source_id, ref: e.source_series_id, primary: false })),
  ];
  // Numbered by posting order: the series takes its chapters from the source whose posts were numbered and from
  // nowhere else. A follower's chapter 20 is its own chapter 20 -- another site numbers these posts its own way,
  // usually the very way this series was renumbered to get away from -- so merging it would file a different
  // post as a version of ours. The followers stay followed; they are just not merged while this lasts.
  // Reintroduce by keeping `followed` whole: "followers are not merged under posting order" in
  // numbering.int.test.ts finds the follower asked for its list ("a follower is not even asked").
  const numberingSource: string | null = s.numbering === 'posting_order' ? (s.numbering_source ?? s.source_id) : s.source_id;
  if (s.numbering === 'posting_order') followed = followed.filter((f) => f.source === numberingSource);
  if (!followed.length) return nothing(s.title, 'unrouted');

  // A source the admin switched off is never asked, by any run, for anything: not for its listing, and not for a
  // chapter (v0.54.0). Until then only "Fetch newest" filtered it here, and the sweep and Check asked it on every
  // visit and downloaded its chosen copies -- while Health, the Turn off confirmation and the Sources page all said
  // it was no longer asked. The ghost-rows reason that kept it did not hold: a listing nobody answered is kept
  // anyway (stale beats empty, below), its rows cannot be fetched while it is off (the fetch route refuses a
  // switched-off source), and asking an offline site behind the Cloudflare solver costs up to 90 s a series -- for
  // aqua's 195 series, hours a sweep, each ending `source_error`, so every night read unhealthy. Filtered out of
  // `followed` here so the listing loop, the source ranks, the refusal set and the parts rules below all see only
  // sources that may be asked. A series with nothing left is said so with no network call (`asked: false`, no
  // stamp, its listing standing): "Fetch newest"'s `disabled` verdict, and the sweep's own outcome `off`. A source
  // switched off after this filter is not downloaded from either (lib/chapterFallback.ts, the chosen copy).
  // Reintroduce the newestOnly-only filter: "the sweep never asks a switched-off main" in updater.int.test.ts finds
  // the main listed. Reintroduce by keeping an all-off series' sources: "a series whose every source is off" reads
  // source_error after one listing call.
  const off = await switchedOff(followed.map((f) => f.source));
  if (off.size) {
    const on = followed.filter((f) => !off.has(f.source));
    if (!on.length) {
      // Nothing to fetch it from: not behind for the finishing sweep until a source is switched back on and a sweep says so.
      await q('UPDATE lib_series SET finish_missing = 0, finish_after = NULL WHERE id = $1', [seriesId]).catch(() => {});
      return opts.newestOnly ? { ...nothing(s.title, 'ok'), newest: { number: null, state: 'disabled' } } : nothing(s.title, 'off');
    }
    followed = on;
  }

  // A throw and an empty list are NOT the same answer, and collapsing them is what made a broken source
  // indistinguishable from a series with nothing new. routes/sources.ts already separates these two, with a
  // comment saying why, two files away.
  let tagged: SourceChapter[] = [];
  let blocked = 0;
  let answered = 0;
  let askedSource = false;
  // v0.79.0: which followed sources answered with chapters this run (`fresh`), and which said nothing because they could
  // not be asked or did not answer (`stale`: cooling, resting, a throw or our own timeout). A stale source's chapters are
  // still its chapters -- see the merge after the parts rules below.
  const fresh = new Set<string>();
  const stale = new Map<string, 'cooling' | 'threw'>();
  // The numbering source's own list, untouched: what the detector judges and what posting numbers are given to.
  let rawNumbering: SourceChapter[] | null = null;
  for (const f of followed) {
    // The queue was built from monitored rows, but Unmonitor can be pressed while earlier series/sources run.
    // Re-read immediately before every new listing request; after one source answered, stop rather than ask
    // another and accurately report that this run did touch a source.
    if (opts.unattended && !(await seriesIsMonitored(seriesId))) {
      return { ...nothing(s.title, 'paused'), asked: askedSource };
    }
    if (opts.resting?.(f.source) || await blockedNow(f.source)) { blocked++; stale.set(f.source, 'cooling'); continue; }
    // Looked up again after the awaits above: an extension refresh can unregister an adapter between
    // building the list and asking it, and that is a source that did not answer, not a crash.
    const adapter = getSource(f.source);
    if (!adapter) continue;
    askedSource = true;
    const list = await withTimeout(adapter.listChapters(f.ref), budgetFor(adapter, LIST_TIMEOUT)).catch((e) => {
      // #115: the sweep asks every followed source every night and used to keep what it learned to itself. A
      // throw is chapter-stage evidence (non-escalating: it never touches the cooldown); our own timeout is not.
      if (!e?.selfTimeout) void noteStage(f.source, 'chapters', 'fail', { error: String(e?.message || 'listChapters failed') });
      return null;
    });
    if (!list) { stale.set(f.source, 'threw'); continue; }
    // On the RAW list, before any numbering or choosing: the source answered with chapters.
    if (list.length) { void noteStage(f.source, 'chapters', 'ok'); fresh.add(f.source); }
    answered++;
    if (f.source === numberingSource) rawNumbering = list;
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
  // v0.80.0: a behind series none of whose sources could be asked, or answered, is put forward for the scout
  // (lib/sourceScout.ts), which looks for it on the other installed sources. Reintroduce by dropping either:
  // "a series every source of which is cooling is put forward for the scout" in sourceScout.int.test.ts finds no row.
  if (blocked === followed.length) {
    if (s.numbering !== 'posting_order') await requestScout(seriesId, 'stuck', { ifBehind: true });
    return nothing(s.title, 'blocked');
  }
  if (!answered) {
    await stampChecked(seriesId, null, null);
    if (s.numbering !== 'posting_order') await requestScout(seriesId, 'stuck', { ifBehind: true });
    return { ...nothing(s.title, 'source_error'), asked: true };
  }

  // Numbering (#116, lib/numbering.ts), in the listing layer: before the chooser, the floor, the have-set and the
  // stored listing, so every one of them sees the same numbers. The detector's verdict first, on the source's own
  // list; then a pending change is settled -- applied when an admin confirmed it or nothing is on disk to rename,
  // otherwise the series is HELD: its listing stays as it was and nothing downloads, because every chapter fetched
  // now would land under a number the pending plan is about to move. Settled BEFORE the have-set on purpose: a
  // renumber moves `Chapter 2.cbz` to 20, and a have-set read first would still hold 2 and skip post 2.
  let renumber: Settled | undefined;
  if (rawNumbering?.length && numberingSource) {
    const decided = await decideNumbering(s, numberingSource, rawNumbering).catch(() => null);
    if (decided) s = { ...s, ...decided };
  }
  if (s.numbering_pending) {
    // Held or not, the source was asked: the series goes to the back of the sweep's queue like any other, or a
    // series waiting for review would be the first one visited every night.
    const held = async (r?: Settled): Promise<UpdateResult> => {
      // Held, it fetches nothing: not behind for the finishing sweep (lib/finishDownloads.ts) until the review is done.
      await q('UPDATE lib_series SET source_checked_at = now(), finish_missing = 0, finish_after = NULL WHERE id = $1', [seriesId]).catch(() => {});
      return { ...nothing(s.title, 'renumber_pending'), asked: true, ...(r ? { renumber: r } : {}) };
    };
    if (!rawNumbering?.length || !numberingSource) return held();
    renumber = await settleNumbering(s, numberingSource, rawNumbering, { confirm: opts.confirmRenumber === 'clean' ? 'clean' : !!opts.confirmRenumber });
    if (renumber.state !== 'applied' && renumber.state !== 'none') return held(renumber);
    // The apply moved chapter_floor and the slow archive's boundary into the new numbers (numbering.ts commit):
    // both are read again, or this run's floor would hold a source number against posting numbers.
    const moved = await one<any>(`SELECT chapter_floor, ${ARCHIVE_BOUNDARY} FROM lib_series s WHERE s.id = $1`, [seriesId]);
    s = { ...s, ...renumber.numbering, chapter_floor: moved?.chapter_floor ?? null, archive_boundary: moved?.archive_boundary ?? null };
  }
  const posting = s.numbering === 'posting_order';
  if (posting && rawNumbering && numberingSource) {
    // The numbering source alone, followers dropped: `followed` was filtered above, but a renumber applied a
    // moment ago started this run in source numbers, with the followers' copies already in hand.
    const numbered = await numberedChapters({ seriesId, sourceId: numberingSource, persist: true }, rawNumbering);
    tagged = numbered.map((c) => ({ ...c, source: numberingSource }));
  }

  // One copy per number out of everything listed, by the release preferences: the series' own over the
  // global ones, with the series' patience in force -- this is the sweep, and "Check now" runs the same
  // code, so a number held for the preferred group is held on both. The series' row is only parsed when it
  // has something of its own, which almost none do.
  const prefs = await effectivePrefsFor(s.scanlator_prefs == null ? null : await readSeriesPrefs(seriesId));
  // The source order (lib/sourcePrefs.ts), the series' own or the server's, ranks the copies of a number ahead
  // of the follow order: a listed source before every unlisted one, the follow order breaking what is left.
  // It sits below the group ranking and the hosted-before-external rule in `releaseOrder`, so it only decides
  // between copies the release rules call equal -- the decision the follow order used to make alone, where
  // the primary won every tie. With no order set this is the follow order, unchanged. An order that will not
  // load is no order: the sweep goes on as it always did rather than failing a series over a preference.
  // Reintroduce by going back to the follow order alone: "a new chapter comes from the higher-ranked source"
  // in sourceOrder.int.test.ts takes it from the primary.
  const priority = await effectiveSourcePriority(s.source_prefs).catch(() => null);
  // v0.62.0: the series' language (lib/copyLanguage.ts). A copy known to be in another language is left out, and a
  // copy of unknown language keeps to the group of the series' latest chapters. The rules are the stored listing's
  // too (lib/seriesListing.ts decisionAfterSeries), so what the sweep downloads and what the listing calls the
  // server's pick agree. A read that fails is no rule: the sweep goes on as it did before v0.62.0.
  // Reintroduce by dropping the spread: "an English series never downloads the Spanish copy" in
  // copyLanguage.int.test.ts downloads it.
  const language = await languageRulesFor(seriesId, followed.map((f) => f.source)).catch(() => ({}));
  // A source that did not answer this run (v0.79.0, `stale`) ranks after every source that did: its copies are kept (the
  // merge below) but cannot be fetched now, so a number another followed source lists is taken from that one. An
  // explicit source order still wins (rankSources puts it first), and the fallback helper then takes the number from
  // another source anyway, the stale one being in `refusing`.
  const followOrder = [...followed.filter((f) => !stale.has(f.source)), ...followed.filter((f) => stale.has(f.source))].map((f) => f.source);
  const chooseOpts = { sourceRank: rankSources(priority, followOrder), ...language };
  // Chapter parts that sources number or split differently (lib/partAlias.ts): another site's N.1 / N.6 for the N /
  // N.5 on disk is renumbered onto them (R1), and another site's split of a chapter already here (R2), or of a new one
  // whose first-ranked source splits it another way (R3), is `covered` --
  // listed and shown on the series page, fetchable by hand, never fetched by the sweep nor counted as missing. Here,
  // before the chooser, so the chooser, the floor, the have-set and the stored listing all see one numbering. Not
  // under posting order, nor while the numbering is in question. The disk is what the have-set below calls held,
  // override-aware, with each file's origin; a read that fails leaves the listing as the sources gave it.
  // Reintroduce by dropping this block: "a follower's other numbering of the parts on disk" in updater.int.test.ts
  // downloads 12.1 and 12.6.
  let covered = new Set<number>();
  if (partRulesApply(s)) {
    const disk = await q<{ number: number; source_id: string | null }>(
      `SELECT COALESCE(ov.number, b.number) AS number, b.source_id FROM lib_books b LEFT JOIN book_overrides ov ON ov.book_id = b.id
        WHERE b.series_id = $1 AND ${heldBooks('b')}`, [seriesId]).catch(() => null);
    if (disk) {
      ({ tagged, covered } = aliasParts({
        tagged, held: disk.map((r) => ({ number: Number(r.number), sourceId: r.source_id })), primary: s.source_id ?? null,
        sourceRank: chooseOpts.sourceRank,
      }));
    }
  }
  // v0.79.0: a followed source that could not be asked this run (cooling, resting) or did not answer keeps the chapters it
  // listed last time. The listing was rewritten from the sources that answered, so a main in a cooldown lost every number
  // only it lists: "{n} behind" and the finishing sweep's count dropped, the series read caught up, and its chapters
  // waited for the scheduled check -- the stall the owner saw on every Natomanga series whose follower answered. Its
  // stored copies (already in this series' numbering, as written last time) go back into the pool, ranked last, never
  // asked for pages this run (`refusing` below); a covered row is another site's split and stays out. Only for a source
  // still worth waiting for -- usable or cooling, never failing, switched off or gone -- and never under posting order.
  // Reintroduce by dropping the merge: "a cooling main's numbers stay listed and behind while a follower answers" in
  // updater.int.test.ts finds them gone from the listing and finish_missing 0.
  if (!posting && fresh.size && stale.size) {
    const standing = await standingsOf([...stale.keys()]).catch(() => new Map<string, string>());
    const keep = new Set([...stale.keys()].filter((id) => standing.get(id) === 'usable' || standing.get(id) === 'cooling'));
    if (keep.size) {
      const rows = await q<{ number: number; title: string | null; copies: ListingCopy[] | null; status: string; unblocked_status: string | null }>(
        'SELECT number::float8 AS number, title, copies, status, unblocked_status FROM series_listing WHERE series_id = $1', [seriesId],
      ).catch(() => []);
      for (const row of rows) {
        if (row.status === 'covered' || row.unblocked_status === 'covered') continue;
        for (const copy of row.copies ?? []) if (keep.has(copy.source)) tagged.push(copyToChapter(copy, row));
      }
    }
  }
  const { releases, waiting: held } = chooseReleases(tagged, prefs, chooseOpts);

  // A series added as "latest N" carries a floor, and what the source lists below it is not this job's
  // business: the sweep exists to fetch new releases, and the oldest-first loop below would otherwise spend
  // every night on the back catalogue with the new chapter queued behind it. Applied before `missing` is
  // computed, so the source_missing stamp -- "{n} behind" on the series page -- counts only what the sweep
  // would actually fetch. source_chapters still records the full count: that is what the sources said.
  // A slow archive (#117, lib/archive.ts) owns everything below its boundary while it is queued or paused, so the
  // floor is the higher of the two: the sweep keeps the new releases and never races the archive for the back
  // catalogue, and `source_missing` counts only the sweep's own work. chapter_floor itself is never rewritten.
  // Reintroduce by reading chapter_floor alone: "the sweep and the archive split the work" in archive.int.test.ts
  // fetches below the boundary.
  const archiveBoundary = s.archive_boundary == null || opts.ignoreArchiveBoundary ? -Infinity : Number(s.archive_boundary);
  const floor = Math.max(s.chapter_floor == null ? -Infinity : Number(s.chapter_floor), archiveBoundary);
  // Notice chapters the admin hides (lib/noticeChapters.ts), for a series whose type or own switch says so: a number
  // with a fraction that its copies say is NOTICE_MAX_PAGES pages or fewer (the most any copy says, as the listing
  // reads it). Not fetched, not "behind", not in the count of what the sources list -- the sweep leaves them in the
  // listing, so the series page and Mihon show them again the moment the switch goes off, and the next sweep fetches
  // them then. A fractional number its copies say nothing about, or say is longer, is fetched like any chapter: it
  // may be a real one in parts, and once it is here its own counted pages decide. Reintroduce by dropping `notice`:
  // "the sweep skips only a notice its source says is short" in noticeChapters.int.test.ts finds 2.5 asked for; by
  // going back to any fraction, it finds 3.5 and 4.5 never asked.
  const hidesNotice = await seriesHidesNotices(seriesId);
  const pagesOf = new Map<number, unknown[]>();
  if (hidesNotice) {
    for (const c of tagged) { const l = pagesOf.get(c.number); if (l) l.push(c.pages); else pagesOf.set(c.number, [c.pages]); }
  }
  const notice = (n: number) => hidesNotice && isListedNotice(n, pagesOf.get(n) ?? []);
  // And the numbers an admin hid by hand (#240, lib/hiddenChapters.ts), the same way: not fetched, not "behind", not in
  // the count of what the sources list, and kept in the listing, so Restore shows the grey row again at once and the
  // next sweep fetches it. Read here, after the sources answered, so a hide made while they did is already in force; one
  // made after still never downloads (lib/chapterFallback.ts reads them again at the source's door). By the number's
  // key: a source's 7.0200005 is the 7.02 hidden. Reintroduce by dropping `hidden`: "the sweep never fetches a hidden
  // number" in hiddenChapters.int.test.ts finds it asked for.
  const hiddenNums = await hiddenNumbersOf(seriesId);
  const hidden = (n: number) => notice(n) || hiddenNums.has(numKey(n));
  const wanted = releases.filter((c) => c.number >= floor && !hidden(c.number));
  // What is on disk is never replaced, whoever released it: a copy from a better-ranked group appearing
  // later is not a missing chapter. (A deliberate "replace with the preferred group" would be its own path.)
  // "On disk" includes the tombstones the library keeps on purpose -- a chapter the read-chapter cleanup
  // or Delete files removed is not fetched back every night -- but NOT a row the verify task marked
  // `missing`: that file is gone without anyone deciding so (a database-only restore), and fetching it
  // again is the recovery. heldBooks in lib/chapterCleanup.ts is that rule, in one place.
  // Reintroduce by dropping the heldBooks predicate: "the sweep fetches a chapter the verify task marked
  // missing" in verifyFiles.int.test.ts asks for nothing.
  // Override-aware under posting order: a book in a root the renumber could not rename carries its posting number
  // in book_overrides (lib/numbering.ts), and its raw number is the source's, which means another post now.
  // Source-numbered series compare the raw number, as they always have: these numbers came out of a listing.
  // A file holding a range (v0.55.2, lib/chapterRanges.ts) holds every number in it, `Batman 01-07` 1 to 7: none of
  // them is fetched or counted behind. Reintroduce by testing the start alone: "the sweep does not fetch what a
  // range file holds" in chapterRanges.int.test.ts queues 2 to 7.
  const heldRows = await q<{ number: number; end: number | null; pruned_at: string | null }>(posting
    ? `SELECT COALESCE(ov.number, b.number) AS number, ${rangeEnd('b', 'ov')} AS end, b.pruned_at
         FROM lib_books b LEFT JOIN book_overrides ov ON ov.book_id = b.id
        WHERE b.series_id=$1 AND ${heldBooks('b')}`
    : `SELECT b.number, ${rawRangeEnd('b')} AS end, b.pruned_at FROM lib_books b WHERE b.series_id=$1 AND ${heldBooks('b')}`, [seriesId]);
  const have = heldBy(heldRows);
  // The held numbers a LIVE row stands behind. The sweep needs only `have`; "Fetch newest" tells a
  // number we hold as pages apart from one we hold only as a deliberate tombstone (see the verdict below).
  const live = heldBy(heldRows.filter((r) => r.pruned_at == null));
  // A covered number is another site's split of a chapter (R2, R3): not this sweep's to fetch, and not "behind" either.
  const missing = wanted.filter((c) => !have.has(c.number) && !covered.has(c.number)).sort((a, b) => a.number - b.number);
  await stampChecked(seriesId, releases.filter((c) => !hidden(c.number)).length, missing.length);
  // The ledger for this series, read once: which chapters have already failed CHAPTER_RETRY_CAP times and
  // are not attempted again by the sweep, and which have been REFUSED twice by the very source that still
  // lists them. The second set is `persistent` for the fallback helper (lib/chapterFallback.ts): a refusal
  // never starts a source hunt, because a 429 today is a busy site and the cooldown is the answer -- but
  // the same site refusing the same number across two sweeps, days apart, is a chapter it is not going to
  // serve (live: 169 chapters parked for weeks on "page 1: 404; page 2: 429" with a second copy on a
  // followed source that was never asked). Only a refusal (`rate_limited`, `blocked`) counts, only from
  // the source the chosen copy is on (a refusal from a source the series no longer routes through says
  // nothing about this one), and only at two: one refusal is still one bad night.
  // Reintroduce by lowering `attempts >= 2` to `>= 1`: "a refusal is hunted only after two sweeps" in
  // updater.int.test.ts sees the hunt run on the first refusal.
  const ledger = await q<{ number: number; attempts: number; status: string; source_id: string }>(
    `SELECT number, attempts, status, source_id FROM chapter_failures WHERE series_id = $1`, [seriesId],
  ).catch(() => []);
  // "Finish downloads on their own" (lib/finishDownloads.ts): a site's refusal is a later, not a never, so it is capped
  // at REFUSAL_RETRY_CAP tries while the switch is on; a chapter that broke is capped at three either way. The refusal
  // still counts toward `persistentVia` below at two, so a site that keeps refusing a number sends the sweep to other
  // sources for it long before the cap. Reintroduce by capping every status at CHAPTER_RETRY_CAP: "a refused chapter
  // is tried past three with the switch on" in finishDownloads.int.test.ts finds it left alone.
  const finish = opts.finish ?? await finishDownloadsOn();
  const cappedNums = new Set(ledger.filter((r) => Number(r.attempts) >= retryCapFor(r.status, finish, CHAPTER_RETRY_CAP)).map((r) => Number(r.number)));
  const persistentVia = new Map(
    ledger
      .filter((r) => (r.status === 'rate_limited' || r.status === 'blocked') && Number(r.attempts) >= 2)
      .map((r) => [Number(r.number), r.source_id]),
  );
  // A number being held for its preferred group is still missing -- "{n} behind" must say so -- but it is
  // not fetched: the whole point of the hold is that the copy on offer is not the one wanted yet.
  const heldNums = new Set(held);
  const eligible = missing.filter((c) => !cappedNums.has(c.number) && !heldNums.has(c.number));
  // "Finish downloads on their own" (lib/finishDownloads.ts) goes back for what this queue would fetch, not for the whole
  // of `missing`: a series behind only on chapters left alone at the cap, or held for their group, is not behind for it,
  // or every quarter of an hour its sources would be asked for a list that can fetch nothing. Reintroduce by stamping
  // `missing.length`: "a series behind only on chapters it leaves alone is not gone back for" in
  // finishDownloads.int.test.ts finds it three behind for the finishing sweep, and asked.
  // v0.79.0: and only what it can fetch NOW. A number whose every copy is on a source that did not answer this run (the
  // kept copies above) is still behind -- source_missing counts it -- but asking again before that source can answer
  // fetches nothing and costs the others a listing each quarter of an hour. Such a series is gone back to when the
  // source's cooldown ends (`finish_after`, BEHIND_SQL), or a quarter of an hour on for one that did not answer.
  // Reintroduce by stamping `eligible.length`: "a series waiting only on its cooling main is gone back to when the
  // cooldown ends" in updater.int.test.ts finds it behind at once.
  const reachable = stale.size ? new Set(tagged.filter((c) => !stale.has(c.source ?? '')).map((c) => c.number)) : null;
  const fetchable = reachable ? eligible.filter((c) => reachable.has(c.number)).length : eligible.length;
  const after = fetchable < eligible.length ? await staleUntil(stale) : null;
  await q('UPDATE lib_series SET finish_missing = $2, finish_after = $3 WHERE id = $1', [seriesId, fetchable, after]).catch(() => {});
  const capped = missing.filter((c) => cappedNums.has(c.number)).length;
  const waiting = missing.filter((c) => heldNums.has(c.number)).length;
  // v0.80.0: chapters left at their retry cap are chapters no source it follows could serve: the scout looks for one
  // that can (lib/sourceScout.ts), and they get their tries back if it follows one.
  if (capped && !posting) {
    await requestScout(seriesId, 'capped', { numbers: missing.filter((c) => cappedNums.has(c.number)).map((c) => c.number) });
  }

  // "Fetch newest" (lib/bulkNewest.ts) replaces the sweep's queue with the newest LISTED release, floor
  // ignored for that one number -- see UpdateOpts.newestOnly for why it is max(listed) and never "the
  // newest missing", which turns a caught-up Latest-N series into a reverse back-catalogue backfill.
  // `have` is the same set the sweep trusts, so a tombstone the verify task marked `missing` counts as
  // not held here too. The retry cap is reset for that number, as a manual fetch on the series page is:
  // "try it again on purpose" is what the cap leaves room for. A hold is honoured: this is a bulk button
  // over many series, not the series page's explicit pick of one copy, and the copy on offer is by
  // definition not the one the person asked to wait for. The source gates are the fetch route's: a
  // disabled source and an adult source on a capped account fetch nothing and say which it was.
  // Reintroduce by selecting the newest MISSING number (`releases.filter((c) => !have.has(c.number))`
  // and taking its last element): "a caught-up Latest-N series answers up to date" in updater.int.test.ts
  // downloads a chapter below the floor.
  //
  // A number that is held but has no live row is a tombstone the cleanup or Delete files left on purpose
  // -- which is exactly where "Put back" sends a person, and where they then press Fetch newest to get the
  // chapter back. The have-set is right not to fetch it (the sweep must not undo a deliberate deletion
  // every night), but "Chapter N is already here." over a row the series page shows as deleted from the
  // server is a lie: told apart as `deleted`, so the sentence can point at the way back (Fetch again on
  // the series page). A live row beside a tombstone of the same number is simply held: live wins.
  // Reintroduce by answering `up_to_date` for every held number (dropping the `live.has` test): "a newest
  // chapter deleted on purpose is told apart from one we hold" in updater.int.test.ts reads up_to_date.
  let queue = eligible;
  let newest: NewestVerdict | undefined;
  if (opts.newestOnly) {
    // A covered number is never the newest chapter: it is another site's split of one, here already (R2) or owned by
    // the source that ranks first (R3, whose own parts are the ones to fetch). Reintroduce by taking the top of every
    // release: "Fetch newest takes the newest chapter, not another site's part of one" in updater.int.test.ts finds
    // 78.9 queued for download.
    const top = releases.filter((c) => !covered.has(c.number) && !hidden(c.number))
      .reduce<SourceChapter | null>((best, c) => (best && best.number >= c.number ? best : c), null);
    const via = top ? (top.source ?? (s.source_id as string)) : '';
    if (!top) newest = { number: null, state: 'unlisted' };
    else if (have.has(top.number)) newest = { number: top.number, state: live.has(top.number) ? 'up_to_date' : 'deleted' };
    else if (heldNums.has(top.number)) newest = { number: top.number, state: 'held' };
    else if (await isDisabled(via).catch(() => false)) newest = { number: top.number, state: 'disabled' };
    else if (opts.sourceAllowed && !opts.sourceAllowed(via)) newest = { number: top.number, state: 'denied' };
    else {
      newest = { number: top.number, state: 'queued' };
      await q('DELETE FROM chapter_failures WHERE series_id = $1 AND number = $2::real', [seriesId, top.number]).catch(() => {});
    }
    queue = newest.state === 'queued' && top ? [top] : [];
  }

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
  if (fresh.size) await replaceListing(seriesId, listingRows(tagged, releases, heldNums, s.source_id, releaseOrder(prefs, chooseOpts), covered)).catch(() => {});

  let added = 0;
  let failed = 0;
  let switched = 0;
  let partial = 0;
  let diskFull = false;
  let attempts = 0;
  let paused = false;
  const landed: Landed[] = [];
  // A source that has refused once this run is not asked again, but the others still are: a rate-limited
  // primary must not stop the follower's chapters, which are the reason the follower was added. The loop
  // ends only when every followed source is refusing -- which for a series with one source is the first
  // refusal, as before -- so each source still costs at most one strike per run. The set is written by
  // the fallback helper (a copy that earns `blockStatus` puts its source here) and read by it (a chosen
  // copy on a refusing source is skipped, and the number is taken from another followed source instead).
  // v0.79.0: a source that did not answer this run is not asked for pages either (`stale`, above): its kept copies wait
  // for its next answer, and a number another source lists is taken from that one by the fallback helper.
  // Reintroduce by starting the set empty: "a shared number comes from the follower" in updater.int.test.ts finds the
  // cooling main asked for pages.
  const refusing = new Set<string>(stale.keys());
  // Which sources the sweep may reach on this series' behalf, for the alternates and the hunt: never an
  // adult source on a clean series (lib/sourceHunt.ts sweepAllowedFor), and never past the viewer's own
  // cap when a viewer drove the run. The chosen copy itself is not held to the adult rule -- a person followed
  // that source -- only to the viewer's cap and the rest (`chosenVia` below).
  // ⚠️ v0.55.8 checked the chosen copy against the adult rule at the download's preflight: every new chapter of a
  // clean series on an extension marked NSFW was listed and never fetched (asked by nobody, so not even a failure),
  // while a manual download still worked. Reintroduce by dropping `chosenVia`: "the sweep downloads a clean series'
  // new chapters from the adult source it follows" in updater.int.test.ts lands nothing.
  // Asked only when there is something to download: a listing refresh (maxNew 0) costs no extra query.
  const adult = queue.length > 0 && maxNew > 0 ? await seriesIsAdult(seriesId) : false;
  const sweepRule = await sweepAllowedFor(adult);
  const allowed = (id: string) => sweepRule(id) && (opts.sourceAllowed?.(id) ?? true) && !opts.resting?.(id);
  // Per chapter, for the fallback helper: its chosen copy's source passes the adult rule. The helper never takes an
  // alternate or a hunted copy from that same source, so this opens the chosen copy and nothing else.
  const allowedBeside = (chosenVia: string) => (id: string) =>
    (id === chosenVia || sweepRule(id)) && (opts.sourceAllowed?.(id) ?? true) && !opts.resting?.(id);
  const sourceAllowedNowBeside = (chosenVia: string) => async (candidate: SourceChapter): Promise<boolean> => {
    const id = candidate.source ?? '';
    if (!id || !(await seriesFollowsSource(seriesId, id))) return false;
    // Library adult state and the server's automatic-source policy can change while a chapter waits on its
    // source gate. Rebuild the rule at that boundary; the closure above remains only a cheap early filter.
    const current = id === chosenVia ? () => true : await sweepAllowedFor(await seriesIsAdult(seriesId));
    return current(id) && (opts.sourceAllowed?.(id) ?? true) && !opts.resting?.(id);
  };
  // No hunt under posting order: a source found for the purpose numbers these posts its own way.
  const huntBudget = opts.hunt === false || opts.newestOnly || posting ? null : (opts.hunt ?? { left: HUNT_MAX_PER_SWEEP });
  const meta = { series: s.title, summary: s.summary, author: s.author, genres: s.genres, url: s.web, status: s.status };
  // oldest-missing-first: a partial "first N" add fills forward coherently, and new releases (all > our max)
  // are still the only gap once a series is fully downloaded. (`queue` is `eligible` unless newestOnly.)
  // v0.81.0: of the same release on several followed sources, the copy at full speed on the quietest image server, and
  // not the one that failed this chapter last (lib/copyRouter.ts). Never for a copy someone picked, a series with a
  // source order (its own or the server's: an admin who ranked the sources gets their ranking), a series numbered by
  // posting order, or Fetch newest. Reintroduce by downloading the chosen copy always: "a slowed main gives way to the
  // same release on a follower at full speed" in copyRouter.int.test.ts asks the main.
  const routable = !posting && !opts.newestOnly && !(priority?.order.length);
  const followedIds = followed.map((f) => f.source);
  const blamedFor = new Map(ledger.map((r) => [Number(r.number), r.source_id] as const));
  for (const chosen of queue) {
    if (attempts >= maxNew) break;
    if (runtime.stopping || opts.cancelled?.()) break; // between chapters, never mid-write
    if (opts.unattended && !(await seriesIsMonitored(seriesId))) { paused = true; break; }
    const ch = routable && !(chosen as { pinned?: boolean }).pinned
      ? routeCopy(chosen, sameReleaseChapters(chosen, copiesOf(tagged, chosen.number, prefs, chooseOpts), followedIds), {
        may: (src) => !!getSource(src) && !refusing.has(src) && (src === (chosen.source ?? s.source_id) || allowed(src)),
        blamed: blamedFor.get(chosen.number) ?? null,
        backup: (src) => !!getSource(src)?.backup,
      })
      : chosen;
    // A preference save can land after the listing/queue was built. Never let that stale chosen copy put a
    // blocked group through the automatic path; an explicit versions pick is the sole exception, and never
    // reaches updateSeries.
    if (!(await automaticChapterAllowedFor(seriesId, ch))) continue;
    const via = ch.source ?? (s.source_id as string);
    attempts++;
    let out: FallbackOutcome;
    try {
      // The helper is the whole download policy for one chapter (lib/chapterFallback.ts): the chosen copy
      // unless its source is refusing, then the same number from another followed source (the copies the
      // listing already holds, ranked as the release rules rank them, minus this one), then -- when every
      // followed source failed for a reason other than a refusal -- a source found for the purpose, and
      // last the chapter with placeholder pages when enough of it arrived.
      out = await downloadWithFallback({
        seriesId, title: s.title, folder: s.folder, meta,
        chapter: ch.source ? ch : { ...ch, source: via },
        alternates: async () => {
          if (opts.unattended && !(await seriesIsMonitored(seriesId))) return [];
          if (posting) return [];
          const candidates = copiesOf(tagged, ch.number, prefs, chooseOpts).filter((c) => c !== ch);
          const open: SourceChapter[] = [];
          for (const c of candidates) if (await automaticChapterAllowedFor(seriesId, c)) open.push(c);
          return open;
        },
        refusing, allowed: allowedBeside(via),
        hunt: huntBudget ? async () => {
          if (opts.unattended && !(await seriesIsMonitored(seriesId))) return null;
          return (await huntSource(seriesId, ch.number, {
            allowed, budget: huntBudget,
            ...(opts.unattended ? { admit: () => seriesIsMonitored(seriesId) } : {}),
          })).chapter;
        } : undefined,
        ...(opts.unattended ? { admit: () => seriesIsMonitored(seriesId) } : {}),
        automaticAllowed: (candidate) => automaticChapterAllowedFor(seriesId, candidate),
        sourceAllowedNow: sourceAllowedNowBeside(via),
        // Twice refused by the source this very copy is on (the ledger read above): the hunt may run on a
        // third refusal. A refusal from some other source is not this copy's history.
        persistent: persistentVia.get(ch.number) === via,
      });
    } catch (e: any) {
      // The library disk is at its floor: not this chapter's fault, not the source's, and pointless to try
      // the next one. Stop here and let the sweep say so.
      if (e?.diskFull) { diskFull = true; break; }
      throw e;
    }
    if (out.kind === 'landed' || out.kind === 'partial') {
      added++;
      if (out.switched) switched++;
      if (out.kind === 'partial') partial++;
      landed.push({
        number: ch.number, scanlator: out.chapterUsed.scanlator, source: out.via, title: out.chapterUsed.title, chapterId: out.chapterUsed.sourceId,
        // 1-based, as setBookMeta writes lib_books.missing_pages; the helper reports indices.
        ...(out.kind === 'partial' ? { missing: out.missing.map((i) => i + 1) } : {}),
      });
    } else if (out.kind === 'skipped') {
      // The file was there but no row was: a download nobody scanned. Told apart from `queued` so "Fetch
      // newest" scans the folder and reports the chapter as already here rather than as a failed fetch.
      if (out.why === 'on_disk' && newest && newest.number === ch.number) newest = { ...newest, state: 'on_disk' };
      // Never asked -- its source is refusing and nothing else lists it -- is the old loop's `continue`:
      // not an attempt, not a failure, and no ledger row towards the retry cap for a chapter nobody tried. Nor is a
      // number hidden while the queue waited (#240).
      if (out.why === 'refusing' || out.why === 'hidden') attempts--;
    } else {
      failed++; // a failed chapter shouldn't abort the rest, but it must not vanish either
      await noteChapterFailure({ seriesId, title: s.title, number: ch.number, sourceId: out.via, err: out.err });
    }
    // ...unless every SOURCE is refusing. Both other callers already stopped on a refusal; this one did
    // not, so a single rate-limit became five. Measured on this install: one unpaced burst against
    // mangakakalot produced five reportFail calls in 74 seconds, and because the cooldown escalates with
    // `consecutive` (15, 30, 45, 60, 75 minutes) it locked the source for 75 minutes instead of 15 --
    // long enough that the person's own manual retry was refused too. Checked after every outcome, since
    // the helper is what adds to the set now, and a chapter that landed from the follower after the
    // primary refused has still left the primary refusing.
    if (refusing.size && followed.every((f) => refusing.has(f.source))) break;
  }
  // v0.80.0: every source it follows refused it and nothing came: the scout looks further (lib/sourceScout.ts).
  if (!added && !posting && refusing.size && followed.every((f) => refusing.has(f.source))) {
    await requestScout(seriesId, 'stuck', { ifBehind: true });
  }
  if (added) notifyNewChapter(seriesId, s.title, added, landed.map((c) => c.number)).catch(() => {});
  // backfill release dates onto already-scanned books; freshly downloaded ones are stamped after the sweep's scan
  await setBookDates(s.folder, releases).catch(() => {});
  // Provenance goes only onto what LANDED, never onto the whole listing: the chosen copy for a number can
  // change between runs, and the file on disk does not change with it.
  await setBookMeta(s.folder, landed).catch(() => {});
  return { title: s.title, added, available: releases.length, outcome: paused ? 'paused' : 'ok', failed, waiting, switched, partial, landed, capped, folder: s.folder, chapters: releases, diskFull, asked: true, ...(newest ? { newest } : {}), ...(renumber ? { renumber } : {}) };
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
export async function runUpdateAll(opts: {
  onlyFavorites?: boolean; maxNew?: number; sweepMax?: number;
  /** The run's card (lib/downloadJobs.ts): progress written to it as the sweep goes, and its cancel flag obeyed. */
  card?: RunCard;
  /**
   * v0.61.0, the smart update checks (Admin -> Settings, server_settings.update_smart, off by default): only the
   * series that are due by lib/releaseRadar.ts isDue are visited, `hoursMs` being the update interval. Passed by the
   * scheduled tick alone (server.ts) and only while the switch is on: Run now, Check now, Fetch newest, the repair, Fix
   * everything and the slow archive ask every series they mean to, as before.
   */
  smart?: { hoursMs: number };
  /**
   * "Finish downloads on their own" (lib/finishDownloads.ts): visit only the series that are behind -- their source lists
   * chapters they do not have (`source_missing`, the sweep's own stamp), or no sweep has checked them yet -- the
   * finishing sweep server.ts starts every FINISH_MINUTES and after a cooldown ends. Every other sweep visits them all.
   */
  behindOnly?: boolean;
} = {}): Promise<{
  series: number; visited: number; added: number; failed: number; chapterFailures: number; capped: number;
  outcomes: Record<UpdateOutcome | 'threw' | 'skipped', number>; healthy: boolean; stopped?: SweepStop;
  /** Of `added`, chapters taken from another source than the chosen copy's, and chapters saved with pages missing. */
  switched: number; partial: number;
  /** Partial chapters from earlier sweeps that this one made whole (the completion pass, lib/partial.ts). */
  completed: number;
  /** Every series this sweep landed chapters for, with its title and how many: the digest's material
   *  (lib/notify, #70). Optional so a test's stand-in sweep need not invent one. */
  newChapters?: DigestSeries[];
  /**
   * v0.61.0: monitored series the smart checks left for a later sweep, quiet and not due (`smart`); 0 without it.
   * Not in `series`, which counts what this sweep set out to visit, nor in `outcomes.skipped`.
   */
  rested: number;
}> {
  const sweepMax = opts.sweepMax ?? SWEEP_MAX;
  // Rows never checked sort first, so the first sweep after this change visits in the old order.
  const order = 'ORDER BY s.source_checked_at ASC NULLS FIRST, s.latest_mtime DESC';
  // What each series is asked through, for its queue below: its followers in follow order, and its numbering.
  const routing = `ARRAY(SELECT ss.source_id FROM series_sources ss WHERE ss.series_id = s.id ORDER BY ss.created_at, ss.source_id) AS extra,
    s.numbering, s.numbering_source`;
  // What the smart checks read (lib/releaseRadar.ts DueInput): selected only for a smart sweep, so every other sweep's
  // query is the one it always was.
  const dueCols = opts.smart
    ? `, s.source_checked_at AS checked_at, s.source_missing, s.latest_mtime AS latest_ms, s.created_at,
       (SELECT r.next_at FROM series_radar r WHERE r.series_id = s.id) AS next_at,
       (SELECT r.due_until FROM series_radar r WHERE r.series_id = s.id) AS due_until,
       (SELECT r.last_at FROM series_radar r WHERE r.series_id = s.id) AS last_at`
    : '';
  type SweepRow = {
    id: string; source_id: string | null; title: string; folder: string; extra: string[] | null; numbering: string | null; numbering_source: string | null;
    checked_at?: Date | null; source_missing?: number | null; latest_ms?: number | string | null; created_at?: Date | null;
    next_at?: Date | null; due_until?: Date | null; last_at?: Date | null;
  };
  // The finishing sweep (lib/finishDownloads.ts) takes the behind series alone. Reintroduce by dropping the filter:
  // "the finishing sweep visits only the series that are behind" in finishDownloads.int.test.ts finds the caught-up one asked.
  const behind = opts.behindOnly ? ` AND ${BEHIND_SQL}` : '';
  let rows = opts.onlyFavorites
      ? await q<SweepRow>(`SELECT DISTINCT s.id, s.source_id, s.title, s.folder, s.source_checked_at, s.latest_mtime, ${routing}${dueCols} FROM favorites f JOIN lib_series s ON s.id = f.series_id WHERE s.auto_update AND ${visibleToAll('s')}${behind} ${order}`)
      : await q<SweepRow>(`SELECT s.id, s.source_id, s.title, s.folder, ${routing}${dueCols} FROM lib_series s WHERE s.auto_update AND ${visibleToAll('s')}${behind} ${order}`);
  // The switch, read once for the whole sweep and handed to every series it visits (UpdateOpts.finish).
  const finish = await finishDownloadsOn();
  // v0.61.0: the smart checks rest the series that are not due BEFORE the per-source queues are built, so a rested
  // series costs its source nothing, takes no turn and no pause, and is not counted on the run's card. Reintroduce by
  // filtering nothing: "a smart sweep rests the quiet series that are not due, and asks the rest" in smartSweep.int.test.ts
  // finds the quiet one asked.
  let rested = 0;
  if (opts.smart) {
    const now = Date.now();
    const t = (v: Date | null | undefined) => (v ? new Date(v).getTime() : null);
    const due = rows.filter((r) => isDue({
      checkedAt: t(r.checked_at), sourceMissing: r.source_missing ?? null, nextAt: t(r.next_at), dueUntil: t(r.due_until),
      lastAt: t(r.last_at), latestMtime: Number(r.latest_ms) || null, createdAt: t(r.created_at),
    }, now, opts.smart!.hoursMs));
    rested = rows.length - due.length;
    rows = due;
  }
  const card = opts.card;
  const titles = new Map(rows.map((r) => [r.id, r.title] as const));
  const folders = new Map(rows.map((r) => [r.id, r.folder] as const));
  /** Series put back once because their folder was held when their turn came (the hold's note in the loop). */
  const deferred = new Set<string>();
  if (card) card.total = rows.length;

  // One queue per source the series is ASKED through: the first it follows that is loaded and not switched off, in
  // updateSeries's own order (the main source, then the followers; the numbering source alone under posting order).
  // Keyed on the main source alone, a main that is never asked -- switched off, or gone -- still decided its series'
  // parking and un-parking by its own cooldown, and one series blocked on its follower parked every series of the
  // dead main behind it (v0.54.0: aqua off, 195 series). Reintroduce by keying on `source_id`: "queues follow the
  // source a series is asked through" in updater.int.test.ts finds the series on the fine follower skipped.
  //
  // v0.79.0: and one that can be asked NOW. A main in a cooldown is still loaded and switched on, so it kept the queue of
  // every series it is the main of: the first of them whose followers were cooling too came back `blocked`, parked the
  // queue, and every series behind it -- the ones a working follower would have served -- was skipped until the
  // cooldown ended. The owner's Natomanga series waited exactly so. A series goes on the queue of the first source on
  // its route that is not cooling; one with none waits aside (`waiting`), costs nothing, joins a queue the moment a
  // source on its route comes out of its cooldown, and counts as `blocked` if none does before the sweep ends. And when
  // a queue parks, the series still in it move on to the next source on their own route that can be asked.
  // Reintroduce by keying on the first loaded source: "a cooling-main series goes on its follower's queue" in
  // updater.int.test.ts finds it skipped; by dropping the move on parking: "a parked queue hands its series on" there.
  const offNow = await switchedOff(rows.flatMap((r) => [r.source_id ?? '', ...(r.extra ?? [])]));
  const coolingSet = async (): Promise<Set<string>> =>
    new Set((await q<{ source_id: string }>('SELECT source_id FROM source_health WHERE blocked_until > now()').catch(() => [])).map((r) => r.source_id));
  let coolingNow = await coolingSet();
  const routeOf = (r: SweepRow): string[] =>
    (r.numbering === 'posting_order' ? [r.numbering_source ?? r.source_id] : [r.source_id, ...(r.extra ?? [])]).filter((id): id is string => !!id);
  const askable = (id: string) => !!getSource(id) && !offNow.has(id);
  const routes = new Map(rows.map((r) => [r.id, routeOf(r)] as const));
  const queues = new Map<string, string[]>();
  const enqueue = (src: string, id: string) => { if (!queues.has(src)) queues.set(src, []); queues.get(src)!.push(id); };
  const waiting = new Set<string>();
  for (const r of rows) {
    const route = routes.get(r.id)!;
    const k = route.find((id) => askable(id) && !coolingNow.has(id));
    if (k) enqueue(k, r.id);
    // Nothing on its route that may be asked at all (unloaded, switched off): the queue it always had, where the
    // visit says so (`unrouted`, `off`) without asking anyone.
    else if (!route.some(askable)) enqueue(r.source_id || '', r.id);
    else waiting.add(r.id);
  }
  const parked = new Set<string>();

  let added = 0;
  let chapterFailures = 0;
  let capped = 0;
  let visited = 0;
  let spent = 0;
  let switched = 0;
  let partial = 0;
  let completed = 0;
  let stopped: SweepStop | undefined;
  // One hunt budget for the whole night (lib/sourceHunt.ts): however many chapters fail, the sweep
  // searches other sources at most HUNT_MAX_PER_SWEEP times.
  const huntBudget = { left: HUNT_MAX_PER_SWEEP };
  // Tallied so the caller can say what happened. `updateSeries` throwing outright is its own outcome:
  // catching it into `{ added: 0 }` is what made "the database went away mid-sweep" read as "nothing new".
  // `skipped` is what the budget, a parked source or a hold (below) left unvisited: not a failure, and not nothing either.
  const outcomes: Record<UpdateOutcome | 'threw' | 'skipped', number> = { ok: 0, busy: 0, gone: 0, unrouted: 0, blocked: 0, source_error: 0, renumber_pending: 0, off: 0, paused: 0, threw: 0, skipped: 0 };
  const dated: { id: string; folder: string; chapters: SourceChapter[]; landed: Landed[] }[] = [];
  const newChapters: DigestSeries[] = [];

  // The finishing sweep's give-way, as a visit asks it between chapters. A visit it cut short is a sweep that gave way,
  // said so at the end even when no turn was left to refuse (every lane was already inside its series).
  let cutByYield = false;
  const yielded = () => {
    const y = !!opts.behindOnly && quietWanted();
    if (y) cutByYield = true;
    return y;
  };
  // One series' visit, start to pause, with `take` chapters to spend at most: what both loops below run for each turn.
  const visitOne = async (src: string, id: string, take: number): Promise<void> => {
    visited++;
    if (card) card.current = { id, title: titles.get(id) ?? '' };
    // The card's cancel reaches INSIDE the series too: a series with ten new chapters is a few minutes of
    // downloading, and "Cancel" that waits for all ten reads as "Cancel does nothing".
    // ...and between chapters: a series with ten chapters to fetch is minutes of downloading.
    const r = await updateSeries(id, take, { hunt: huntBudget, unattended: true, finish, ...(card ? { cancelled: () => stopRequested(card) || yielded() } : { cancelled: yielded }) })
      .catch(() => ({ added: 0, outcome: 'threw' as const, failed: 0, landed: [] } as { added: number; outcome: 'threw'; failed: number; folder?: string; chapters?: SourceChapter[]; landed: Landed[]; diskFull?: boolean; switched?: number; partial?: number }));
    added += r.added;
    chapterFailures += r.failed ?? 0;
    capped += (r as { capped?: number }).capped ?? 0;
    switched += r.switched ?? 0;
    partial += r.partial ?? 0;
    spent += r.added + (r.failed ?? 0);
    outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
    if (r.added && r.folder && r.chapters?.length) dated.push({ id, folder: r.folder, chapters: r.chapters, landed: r.landed });
    // The throw fallback above has `added: 0` and no title, so it can never reach the digest.
    if (r.added && (r as { title?: string }).title) newChapters.push({ id, title: (r as { title: string }).title, added: r.added, numbers: r.landed.map((c) => c.number) });
    if (card) { card.done = visited; card.fetched = added; card.failed = chapterFailures; }
    if (r.diskFull) { stopped = 'disk'; return; }
    if (r.outcome === 'blocked') {
      parked.add(src);
      coolingNow = await coolingSet();
      const rest = queues.get(src) ?? [];
      const stay: string[] = [];
      for (const other of rest) {
        const to = (routes.get(other) ?? []).find((s) => s !== src && askable(s) && !coolingNow.has(s) && !parked.has(s));
        if (to) enqueue(to, other);
        else stay.push(other);
      }
      rest.splice(0, rest.length, ...stay);
    }
    // The pause is for the sources' sake: a series no source was asked about (gone, unrouted, every source in a
    // cooldown or switched off) cost them nothing, as bulk Fetch newest already reads it. A throw counts as asked.
    if ((r as { asked?: boolean }).asked !== false) await new Promise((res) => setTimeout(res, 1500));
  };
  /** Why the sweep stops before its next turn, if it does: a shutdown, the card's cancel, a yield, the budget. */
  const stopNow = (reserved: number): SweepStop | undefined => {
    if (runtime.stopping) return 'shutdown';
    if (stopRequested(card)) return 'cancelled';
    // v0.79.0: the finishing sweep gives way between series when another job asked (lib/finishDownloads.ts).
    if (opts.behindOnly && quietWanted()) return 'yield';
    if (spent + reserved >= sweepMax) return 'budget';
    return undefined;
  };
  // ⚠️ A HELD SERIES WAITS (v0.55.7, #150). Every other writer honours the one busy mark (numbering.ts folderBusy:
  // bulkNewest's busyFolders, a download running into the folder): Rescan everything's Apply holds each series it
  // marks, merges or renumbers, a renumber the folder it renames, the slow archive the one it fetches into, a
  // Fetch newest the series it is in. The sweep never asked, and downloaded into a series an Apply was changing --
  // chapters chosen by numbers the Apply was about to move. It goes to the back of its queue once; held still when
  // its turn comes again, it is `skipped`: not asked, not stamped, so the next sweep takes it first. The test and
  // updateSeries (which counts itself inside the series, runsInside, before its first await) are one turn: a hold
  // taken after this sees the sweep inside and leaves the series alone (lib/rescan.ts holdSeries).
  // Reintroduce by dropping the test: "the sweep leaves a held series for later" in updater.int.test.ts finds the
  // held series listed and its chapter fetched.
  const heldNow = (id: string, ids: string[]): boolean => {
    const folder = folders.get(id);
    if (!folder || !folderBusy(folder)) return false;
    if (deferred.has(id)) outcomes.skipped++;
    else { deferred.add(id); ids.push(id); }
    return true;
  };
  /**
   * Only parked queues and waiting series remain, and nothing is running: ask once whether any cooldown has lapsed, and
   * give a waiting series the first source on its route that has come out of its own. False: the sweep is over.
   */
  const freeSome = async (): Promise<boolean> => {
    let freed = false;
    for (const src of parked) if (!(await blockedNow(src))) { parked.delete(src); freed = true; }
    // And a series that had no source to go on at the start takes the first that has come out of its cooldown.
    if (waiting.size) {
      coolingNow = await coolingSet();
      for (const id of [...waiting]) {
        const to = (routes.get(id) ?? []).find((s) => askable(s) && !coolingNow.has(s) && !parked.has(s));
        if (to) { waiting.delete(id); enqueue(to, id); freed = true; }
      }
    }
    return freed;
  };

  // v0.81.0: the finishing sweep works on up to FINISH_LANES series at once (lib/finishDownloads.ts), each on its own
  // image server (pace.ts rateKeyOf of the source its queue is asked through), never two through the extension engine
  // and never two behind the Cloudflare solver: one site's slow chapters no longer hold up the series on every other
  // site. Each lane reserves the chapters it may spend before it starts, so the budget holds across lanes; a stop
  // (shutdown, cancel, yield, the budget, a full disk) starts nothing more, and the lanes already running stop between
  // chapters through `cancelled`. Every other sweep -- the scheduled one, Run now, the repair's -- stays one series at
  // a time. Reintroduce by running the finishing sweep one lane wide: "two series on two image servers finish side by
  // side" in finishLanes.int.test.ts sees a peak of one.
  const lanes = opts.behindOnly ? FINISH_LANES : 1;
  if (lanes <= 1) {
    sweep: while (queues.size || waiting.size) {
      let progressed = false;
      for (const [src, ids] of [...queues]) {
        if (!ids.length) { queues.delete(src); continue; }
        if (parked.has(src)) continue;
        const why = stopNow(0);
        if (why) { stopped = why; break sweep; }
        const id = ids.shift()!;
        progressed = true;
        if (heldNow(id, ids)) continue;
        await visitOne(src, id, Math.min(opts.maxNew ?? 10, Math.max(1, sweepMax - spent)));
        if (stopped) break sweep;
      }
      if (!progressed && !(await freeSome())) break;
    }
  } else {
    /** The visits running now, by image server. */
    const running = new Map<string, { engine: boolean; solver: boolean; done: Promise<void> }>();
    let reserved = 0;
    const kindOf = (src: string) => ({ engine: src.startsWith('sw:'), solver: !!getSource(src)?.requiresCloudflare });
    sweep: while (true) {
      let started = false;
      for (const [src, ids] of [...queues]) {
        if (running.size >= lanes) break;
        if (!ids.length) { queues.delete(src); continue; }
        if (parked.has(src)) continue;
        const key = rateKeyOf(src);
        if (running.has(key)) continue;
        const kind = kindOf(src);
        const busy = [...running.values()];
        if ((kind.engine && busy.some((l) => l.engine)) || (kind.solver && busy.some((l) => l.solver))) continue;
        const why = stopNow(reserved);
        if (why) { stopped = why; break sweep; }
        const id = ids.shift()!;
        if (heldNow(id, ids)) { started = true; continue; }
        const take = Math.max(1, Math.min(opts.maxNew ?? 10, sweepMax - spent - reserved));
        reserved += take;
        started = true;
        const lane = { ...kind, done: Promise.resolve() };
        lane.done = visitOne(src, id, take).finally(() => { reserved -= take; running.delete(key); });
        running.set(key, lane);
        // Round the queues: this one goes last, so a lane that frees is offered to the other image servers first.
        queues.delete(src);
        queues.set(src, ids);
      }
      if (stopped) break;
      if (running.size) { await Promise.race([...running.values()].map((l) => l.done)); continue; }
      if (!started && !(await freeSome())) break;
    }
    // What is running when the sweep stops finishes its chapter (it stops between chapters on a cancel or a yield).
    await Promise.all([...running.values()].map((l) => l.done));
  }
  if (!stopped && cutByYield) stopped = 'yield';
  for (const ids of queues.values()) outcomes.skipped += ids.length;
  // Never asked, because every source it could be asked through was cooling the whole sweep long: blocked, as the
  // visit itself would have said, not "skipped" -- nothing was left over for lack of time. v0.80.0: and put forward
  // for the scout, which looks for it elsewhere (lib/sourceScout.ts).
  outcomes.blocked += waiting.size;
  for (const id of waiting) await requestScout(id, 'stuck', { ifBehind: true });

  // The completion pass: partial chapters from earlier sweeps, oldest-stamped first, each asked for exactly
  // its missing pages (lib/partial.ts). Only when the sweep itself ran to its end -- a night the budget,
  // the disk or a shutdown cut short leaves them for the next one -- and each attempt counts against the
  // budget like a chapter, so a full night's work stays a full night's work. 1500 ms apart, as the series
  // loop paces itself. A partial whose source is in a cooldown is skipped by completePartial itself.
  if (!stopped && PARTIAL_COMPLETE_MAX > 0) {
    const partials = await q<{ id: string; series_id: string; root: string; file: string; number: number; missing_pages: number[]; source_id: string | null; scanlator: string | null }>(
      `SELECT b.id, b.series_id, b.root, b.file, b.number, b.missing_pages, b.source_id, b.scanlator
         FROM lib_books b JOIN lib_series s ON s.id = b.series_id
        WHERE b.missing_pages IS NOT NULL AND b.pruned_at IS NULL AND b.root = $1 AND ${visibleToAll('s')}
          -- An unmonitored series (auto_update off) gets nothing unattended, its missing pages included.
          AND s.auto_update
          -- Nor a chapter at a number an admin hid (#240): its file is left exactly as it is.
          AND NOT ${atHiddenNumber('b')}
        ORDER BY b.updated_at ASC LIMIT $2`, [DL_ROOT, PARTIAL_COMPLETE_MAX],
    ).catch(() => []);
    for (const b of partials) {
      if (runtime.stopping) { stopped = 'shutdown'; break; }
      if (stopRequested(card)) { stopped = 'cancelled'; break; }
      if (spent >= sweepMax) { stopped = 'budget'; break; }
      if (!(await seriesIsMonitored(b.series_id))) continue;
      spent++;
      try {
        const adultRule = await sweepAllowedFor(await seriesIsAdult(b.series_id));
        // The partial's own copy is on the source the series took the chapter from: as the sweep's chosen copy
        // (#177), it is held to the adult rule no more than a person who follows that source is. The rule stays
        // for what is reached on the series' behalf -- the alternates (listingAlternates leaves the own source
        // out) and the hunt. Before, a clean series on an extension marked NSFW never had its holes filled.
        // Reintroduce by passing adultRule as `allowed`: "a clean series' partial is completed from the adult
        // source it follows" in partialComplete.int.test.ts leaves the hole.
        const own = b.source_id ?? '';
        const allowed = (id: string) => (own !== '' && id === own) || adultRule(id);
        const r = await completePartial(
          { ...b, number: Number(b.number) },
          {
            alternates: async () => (await seriesIsMonitored(b.series_id))
              ? listingAlternates(b.series_id, Number(b.number), b.source_id)
              : [],
            allowed,
            hunt: async () => (await seriesIsMonitored(b.series_id))
              ? (await huntSource(b.series_id, Number(b.number), {
                allowed: adultRule, budget: huntBudget, admit: () => seriesIsMonitored(b.series_id),
              })).chapter
              : null,
            admit: () => seriesIsMonitored(b.series_id),
            // An old partial is not a user pin. Re-read the blocklist before each operation on its original copy.
            automaticAllowed: (chapter) => automaticChapterAllowedFor(b.series_id, chapter),
            sourceAllowedNow: async (chapter) => {
              const id = chapter.source ?? '';
              if (!id || !(await seriesFollowsSource(b.series_id, id))) return false;
              const current = id === own ? () => true : await sweepAllowedFor(await seriesIsAdult(b.series_id));
              return current(id);
            },
          },
        );
        if (r === 'completed') completed++;
      } catch (e: any) {
        if (e?.diskFull) { stopped = 'disk'; break; }
        console.warn(`[updater] completing ${b.file} threw: ${(e as Error)?.message || e}`);
      }
      await new Promise((res) => setTimeout(res, 1500));
    }
  }

  if (added) await persistScan();
  for (const d of dated) { // stamp the books the scan just created
    await setBookDates(d.folder, d.chapters).catch(() => {});
    await setBookMeta(d.folder, d.landed).catch(() => {});
    // v0.61.0: the chapters that just arrived are the radar's newest evidence (lib/releaseRadar.ts), and the listing
    // refresh inside updateSeries ran before they were downloaded. Reintroduce by dropping it: "a sweep that lands a
    // chapter dates the radar from it" in releaseRadar.int.test.ts keeps the radar of before the chapter came.
    await refreshRadar(d.id).catch(() => null);
  }
  // `healthy` is the question the admin panel should have been asking all along: was this a quiet night, or
  // did nothing work? A run where every source failed now looks nothing like one where nothing was new.
  const broken = outcomes.source_error + outcomes.threw;
  return {
    series: rows.length, visited, added, failed: broken, chapterFailures, capped, outcomes, stopped, switched, partial, completed, rested,
    healthy: broken === 0 && chapterFailures === 0 && stopped !== 'disk' && stopped !== 'shutdown',
    newChapters,
  };
}

/**
 * The other copies of a number the series' listing holds, from sources it still FOLLOWS, as the
 * completion pass's alternates: the same footing as a manual fetch (routes/sources.ts), where a listing
 * row's source is trusted only while the series follows it. Minus the copy the partial came from -- the
 * completion pass asked that one itself -- and best first, as the listing stores them.
 */
async function listingAlternates(seriesId: string, number: number, except: string | null): Promise<SourceChapter[]> {
  const row = await one<{ title: string | null; copies: ListingCopy[] }>(
    'SELECT title, copies FROM series_listing WHERE series_id = $1 AND number = $2::real', [seriesId, number]).catch(() => null);
  if (!row?.copies?.length) return [];
  const s = await one<{ source_id: string | null }>('SELECT source_id FROM lib_series WHERE id = $1', [seriesId]).catch(() => null);
  const followed = new Set([
    ...(s?.source_id ? [s.source_id] : []),
    ...(await q<{ source_id: string }>('SELECT source_id FROM series_sources WHERE series_id = $1', [seriesId]).catch(() => [])).map((r) => r.source_id),
  ]);
  const open = await automaticCopiesFor(seriesId, row.copies);
  return open
    .filter((c) => c.source !== except && followed.has(c.source))
    .map((c) => copyToChapter(c, { number, title: row.title }));
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
 *
 * Also `false` while the nightly repair runs (`runtime.repairing`, lib/repair.ts): both jobs download into
 * the same series folders and both write lib_books for what landed, and a chapter the repair is replacing
 * could be the file the sweep is scanning. server.ts's tick re-arms itself ten minutes on; the panel's
 * "Run now" is told a repair is running. The repair refuses to start while `updating` is set, so the two
 * never hold each other's flag at once.
 * Reintroduce by dropping `runtime.repairing` from the check: "the sweep stands down while a repair runs"
 * in updater.int.test.ts gets a promise instead of false.
 */
export function runSweep(
  opts: SweepOpts & {
    by?: string | null;
    /**
     * The finishing sweep (lib/finishDownloads.ts, server.ts): the behind series alone, every quarter of an hour. It is
     * not "the last sweep": it neither moves `updater_last_run` (the full sweep's interval, which a restart resumes) nor
     * replaces the panel's last result, and it sends no digest -- a back catalogue arriving ten chapters at a time is
     * not news every fifteen minutes; the full sweep's digest is. Reintroduce by persisting it: "the finishing sweep
     * leaves the full sweep's clock alone" in finishDownloads.int.test.ts sees updater_last_run move.
     */
    finishing?: boolean;
  },
  log: SweepLog, sweep: typeof runUpdateAll = runUpdateAll,
): Promise<SweepResult | null> | false {
  if (runtime.updating || runtime.repairing) return false;
  // Set before the first await, so two starts in the same turn of the event loop cannot both get through.
  runtime.updating = true;
  // The run's card in Library -> Downloads (lib/downloadJobs.ts, #82): the sweep writes its progress there and
  // stops when an admin presses its Cancel. `by` is who pressed Run now; the schedule is nobody.
  const { by, finishing, ...rest } = opts ?? {};
  // v0.79.0: the finishing sweep says so on the flag, so a job that wants its place can ask it to give way
  // (lib/finishDownloads.ts wantQuiet); any other sweep is that place taken, and the request is answered.
  runtime.finishing = !!finishing;
  if (!finishing) clearQuiet();
  const sweepOpts = finishing ? { ...rest, behindOnly: true } : rest;
  const card = beginRun('sweep', by ?? null);
  // Every chapter this run downloads is the sweep's, for the downloads view (lib/downloadActivity.ts).
  return withOrigin('sweep', by ?? null, async () => {
    try {
      const r = await sweep({ ...sweepOpts, card });
      endRun(card, r.stopped === 'disk' ? 'error' : 'done',
        r.stopped === 'disk' ? say('run.diskFull')
          : r.stopped === 'budget' ? say('run.chapterLimit')
          : undefined);
      if (finishing) {
        // The finishing sweep's own line, and nothing else: the full sweep's clock, result and digest are its own.
        log.info(`updater (finishing downloads): +${r.added} chapters, visited ${r.visited} of ${r.series} behind series`
          + `${r.stopped ? ` (stopped: ${r.stopped})` : ''}${r.failed ? `, ${r.failed} did not answer` : ''}`);
        return r;
      }
      runtime.lastUpdate = Date.now();
      // Persisted so a restart schedules the remainder of the interval rather than a whole new one.
      await q(`UPDATE server_settings SET updater_last_run = now() WHERE id = 1`).catch(() => {});
      runtime.lastUpdateResult = {
        series: r.series, visited: r.visited, added: r.added, failed: r.failed,
        chapterFailures: r.chapterFailures, switched: r.switched, partial: r.partial,
        completed: r.completed, healthy: r.healthy, stopped: r.stopped,
        // v0.61.0: the series the smart checks left for a later sweep (Admin -> Tasks: "184 quiet series not due").
        rested: r.rested ?? 0,
      };
      // A sweep that added nothing because nothing was new, and one that added nothing because every source
      // was down, used to print the identical line. They no longer do. Nor does a sweep that finished look
      // like one the budget or the disk cut short.
      // v0.61.0: and how many quiet series the smart checks left for a later sweep, when the switch rested any.
      const scope = `visited ${r.visited} of ${r.series} series${r.stopped ? ` (stopped: ${r.stopped})` : ''}`
        + (r.rested ? ` (${r.rested} quiet series not due)` : '');
      // What the fallback chain did, when it did anything: a chapter taken from another followed source,
      // one saved with placeholder pages, a partial from an earlier night made whole. Silent when zero,
      // so a quiet night's line is the line it always was.
      const extras = [
        r.switched ? `${r.switched} chapter${r.switched === 1 ? '' : 's'} taken from another source` : '',
        r.partial ? `${r.partial} chapter${r.partial === 1 ? '' : 's'} saved with pages missing` : '',
        r.completed ? `${r.completed} chapter${r.completed === 1 ? '' : 's'} completed` : '',
      ].filter(Boolean);
      const fallback = extras.length ? `; ${extras.join(', ')}` : '';
      if (r.healthy) log.info(`updater: +${r.added} chapters, ${scope}${fallback}`);
      else log.warn(
        `updater: +${r.added} chapters, ${scope}, but ${r.failed} series failed to answer` +
        `${r.chapterFailures ? ` and ${r.chapterFailures} chapters could not be saved` : ''}` +
        `${r.capped ? ` (${r.capped} left alone after ${CHAPTER_RETRY_CAP} failed tries)` : ''} ` +
        `(${Object.entries(r.outcomes).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`).join(' ')})${fallback}`,
      );
      // The notification targets' digest (lib/notify, #70): ONE message per target for the whole sweep,
      // after it has finished, and nothing when nothing landed. Not awaited -- a Home Assistant that takes
      // ten seconds and a retry to answer must not hold `runtime.updating` for the next tick -- and it never
      // throws. A per-series "check now" does not come through here, so it sends nothing.
      void sendDigest(r.newChapters ?? []).catch(() => {});
      return r;
    } catch (e) {
      // The rule the backup path already follows: the panel must not keep showing the last good run as if it
      // were this one. Last run moves to now, the result is cleared, and the reason is in `docker logs`.
      // A finishing sweep is not the panel's run, so it leaves both alone.
      if (!finishing) {
        runtime.lastUpdate = Date.now();
        runtime.lastUpdateResult = null;
      }
      endRun(card, 'error', say('run.updateFailed'));
      log.error(e);
      return null;
    } finally {
      runtime.updating = false;
      runtime.finishing = false;
    }
  });
}
