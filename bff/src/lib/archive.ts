// The slow archive (#117): a whole back catalogue fetched over nights or days, never in a burst.
//
// Everything else that downloads is a burst someone is waiting on -- an add, a Fetch, the sweep's five a series
// -- and the issue asked for the opposite: "archive this series slowly, like a person reading it". So this is a
// queue of SERIES, never of chapters (archive_queue, one row each), worked by one scheduler that takes the
// sources in turn, one chapter in flight per source, with a jittered break after each (archivePace.ts) and every
// page at the slow pace (lib/pace.ts withSlowPace). What is missing is worked out on every pick from the listing
// the sweep persists (series_listing) minus what the library holds, below the row's `boundary`. Nothing per
// chapter is stored, so a restart has nothing to reconcile: a chapter that landed meanwhile, by the archive or
// by anyone else, simply drops out of the next pick.
//
// Since v0.55.4 (#158) a series whose chapters are one release on several followed sources takes them from those
// sources in turn: while one is in its break the next chapter comes from another (tickOnce, lib/seriesListing.ts
// sameRelease). And "a source" is a RATE KEY for every slot, break and backoff here (lib/pace.ts rateKeyOf): two sites
// whose pages come from one image server are one site to that server, and taking turns between them gains nothing.
//
// How it shares the work with the sweep. The sweep reads GREATEST(chapter_floor, boundary) as its floor while
// a row is queued or paused (lib/updater.ts), so the archive owns everything below the boundary and new
// releases above it stay the sweep's. chapter_floor itself is never rewritten while an archive runs: it is what
// the person asked for at add time, and it is the only piece of this that survives a rollback to v0.48.4, which
// ignores these tables and goes back to its five-a-sweep backfill. A clean finish clears the floor only if it is
// still the one the archive started from.
//
// What it waits for, in the order it is asked (lib/archivePlan.ts globalWait, sourceWait): a shutdown, the
// admin's pause, the hours it may run in, a sweep or a repair or the daily source check (all bounded runs that
// already hold the server-wide flags), the disk floor; then per source its own slot, its break or backoff, the
// source being loaded, enabled and out of a cooldown, anybody else's download on its gate, a pace level a 429
// earned; then per series a download already running for it. The break is reserved in archive_pace BEFORE a
// chapter starts, so neither a restart nor a crash loop can shorten one.
//
// ⚠️ Each chapter runs inside withOrigin('archive') and withSlowPace, both AsyncLocalStorage scopes, and anything
// created inside one inherits it. Timers and kicks are therefore armed through `atRoot`, a snapshot of the
// module's import-time context where neither is set, never from inside a download.
import { AsyncLocalStorage } from 'node:async_hooks';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { q, one } from './db';
import { runtime } from './runtime';
import { getSource } from './sources';
import { gateDepth } from './gate';
import { rateKeyOf, refusedLately, withSlowPace } from './pace';
import { classify } from './sourceHealth';
import { checkRunning } from './sourceWatchdog';
import { freeBytes, chapterFileRel } from './downloader';
import { DL_ROOT, persistScan, setBookDates, setBookMeta } from './library';
import { downloadWithFallback, type FallbackOutcome } from './chapterFallback';
import { noteChapterFailure } from './chapterFailures';
import { withOrigin } from './downloadActivity';
import { busyFolders } from './bulkNewest';
import { updateSeries, CHAPTER_RETRY_CAP, seriesIsMonitored, type Landed } from './updater';
import { automaticChapterAllowedFor, automaticCopiesFor, copyToChapter, declaredLang, sameRelease, seriesFollowsSource, type ListingCopy } from './seriesListing';
import { cleanSourceOrder } from './sourcePrefs';
import { heldBooks } from './chapterCleanup';
import { holds } from './chapterRanges';
import { seriesIsAdult, sweepAllowedFor } from './sourceHunt';
import { notInLibrary } from './downloadCensus';
import { visible, visibleToAll, sourceAllowedFor, Params, type ViewCtx } from './visibility';
import { firstRunFloor } from './desktop';
import { onBeforeRenumberPlan, onRenumbered } from './numbering';
import {
  ARCHIVE_DEFAULTS, PER_HOUR_RANGE, pageGapRange, nextBreakMs, backoffUntil, inWindow, windowOpensAt, ewmaCycle,
  etaMs, expectedCycleMs, openShare,
} from './archivePace';
import {
  directionFor, boundaryFor, globalWait, sourceWait, attentionOf, shownDone, rowsFor, listingRetryAt, outsideCycleMs,
  shownGlobalWait,
  type ArchiveDirection, type GlobalWait, type SeriesWait, type SourceState, type DoneNote, type Attention,
} from './archivePlan';
import { noticeListed } from './noticeChapters';

/** The import-time context: no origin, no slow pace. Every timer and kick is armed through it (see the header). */
const atRoot = AsyncLocalStorage.snapshot();

const MIN = 60_000;
/** How often the scheduler looks again when nothing is due sooner. */
const tickMs = () => Math.max(50, Number(process.env.ARCHIVE_TICK_MS) || MIN);
/** At most this many sources have an archive chapter in flight at once (env ARCHIVE_MAX_SOURCES). */
const maxSources = () => Math.max(1, Math.floor(Number(process.env.ARCHIVE_MAX_SOURCES) || 3));
/**
 * The shortest break between two chapters on one source. The owner's 45 s, unless the e2e rig asks for less
 * (ARCHIVE_MIN_BREAK_MS, test only): a walk cannot watch a chapter land if every one is followed by 45 s.
 */
const minBreakMs = (): number => {
  const raw = process.env.ARCHIVE_MIN_BREAK_MS;
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : ARCHIVE_DEFAULTS.minBreakMs;
};
/** A listing older than this is read again before the next chapter: a week-old list names chapters that moved. */
const LISTING_STALE_MS = 7 * 24 * 3600_000;
/** How many missing numbers are looked at per series per pick, for the ones already on disk to be stepped over. */
const PICK_DEPTH = 5;
/**
 * Landed chapters are scanned into the library in batches: persistScan walks the whole library. The first one an
 * archive lands for a series the library holds nothing of is the exception, scanned in at once (runChapter).
 */
const SCAN_BATCH = 5;
const SCAN_WAIT_MS = 20 * MIN;
/** A full disk stops everything for this long before the free space is measured again. */
const DISK_WAIT_MS = 30 * MIN;
/** The shared rows behind every viewer's view are read at most this often. */
const VIEW_TTL_MS = 10_000;
/**
 * What a chapter is taken to cost before a source has a running cycle of its own: the ETA's fallback, the same
 * minute the web's estimate assumes (web/lib/archive.ts TYPICAL_CHAPTER_MS), so the two say the same thing.
 */
const TYPICAL_CHAPTER_MS = 60_000;

export type ArchiveLog = { info(msg: string): void; warn(msg: string): void; error(err: unknown): void };
const consoleLog: ArchiveLog = {
  info: (m) => console.log(`[archive] ${m}`),
  warn: (m) => console.warn(`[archive] ${m}`),
  error: (e) => console.error('[archive]', e),
};

// ── state ─────────────────────────────────────────────────────────────────────────────────────────────────────

let deps: { busy: (folder: string) => boolean; log: ArchiveLog } = { busy: () => false, log: consoleLog };
let clock: () => number = () => Date.now();
/** Tests only: replace the clock, so a break can be waited out without waiting. `null` restores it. */
export function setArchiveClock(fn: (() => number) | null): void { clock = fn ?? (() => Date.now()); }
/**
 * Test seams: `beforeDownload` holds the boundary between a queue pick and its final policy read; `afterLanding` is
 * awaited between a chapter's landing and its count -- the moment the downloads view already lists what landed, and
 * the count has not yet said whether it was the series' first.
 */
export const archiveHooks: {
  beforeDownload?: (seriesId: string, number: number) => void | Promise<void>;
  afterLanding?: (seriesId: string, number: number) => void | Promise<void>;
} = {};

/** A chapter (or a listing refresh) in flight, by the source it is on. One per source. */
interface Flight { seriesId: string; number: number | null; folder: string; source: string; startedAt: number }
const flights = new Map<string, Flight>();
/**
 * Chapters on disk that the library has not scanned yet, per series. They are excluded from every pick until
 * the scan, and they are what the Updates baseline is raised by afterwards (`newRow`: no lib_books row of that
 * number existed before it landed, so the scan will add one to the series' count).
 */
interface Unscanned {
  folder: string;
  firstAt: number;
  /** `now`: a series' first landing, being scanned in at once (runChapter); archiveScanPending names it. */
  items: Map<number, { landed?: Landed; publishedAt?: string; newRow: boolean; now?: boolean }>;
}
const unscanned = new Map<string, Unscanned>();
/**
 * A series' first chapter from the archive while it is being fetched, by folder and number (flightKey): what
 * archiveScanPending names until its unscanned item carries `now`. The downloads view lists a chapter the moment it
 * lands, inside the download, and whether it was the first is known only after the count that follows: marked then, a
 * look in between listed it before the library held it (v0.49.1 review). Marked before the download instead.
 */
const firstInFlight = new Set<string>();
const flightKey = (folder: string, n: number): string => `${folder}\u0000${n}`;
/** Numbers a scan could not index although the file is there: stepped over until a restart, never refetched. */
const stuck = new Map<string, Set<number>>();
/**
 * The folders this module has put in bulkNewest's busyFolders, so jobBusy() (routes/sources.ts) refuses a Fetch
 * or an add into a series the archive is writing, and so a restart simulated by resetArchiveMemory takes back
 * exactly its own and nobody else's.
 */
const myFolders = new Set<string>();
/** Everything detached this module started, so a test (and a shutdown) can wait for it. */
const runs = new Set<Promise<unknown>>();
/** What the last tick concluded, for the view: the global wait and each series' own, each with since when. */
let lastGlobal: { wait: GlobalWait; since: number } | null = null;
const lastWaits = new Map<string, { wait: SeriesWait; since: number }>();
/** The source each queued series' next chapter is on, as the last tick found it: what its ETA shares. */
const sourceOf = new Map<string, string>();
/**
 * The sources a queued series' next chapter may come from, as the last tick found them, the chosen copy's first (v0.55.4,
 * #158): only for a series whose copies are the same release on several. Its ETA is divided among their rate keys, and
 * it is backing off only while every one of them is.
 */
const rotating = new Map<string, string[]>();
let timer: NodeJS.Timeout | null = null;
let started = false;
/** Wall-clock time of the first look after boot: a kick (an enqueue, a settings change) never brings it forward. */
let firstLookAt = 0;
let ticking: Promise<TickReport> | null = null;
/** Bumped by resetArchiveMemory: a run from before it must not write into the memory of the one after. */
let generation = 0;

const track = <T>(p: Promise<T>): Promise<T> => {
  runs.add(p);
  void p.finally(() => runs.delete(p)).catch(() => {});
  return p;
};

/** Tests: every chapter, refresh and scan this module has started has finished. */
export async function archiveIdle(): Promise<void> {
  while (runs.size || ticking) {
    await Promise.allSettled([...runs, ...(ticking ? [ticking] : [])]);
  }
}

/**
 * Tests: forget everything held in memory, as a restart does. What is in the database stays -- which is the
 * point of the restart test. A run still going from before is left to finish; its generation no longer matches,
 * so it cannot write into this memory.
 */
export function resetArchiveMemory(): void {
  generation++;
  for (const f of myFolders) busyFolders.delete(f);
  myFolders.clear();
  flights.clear();
  unscanned.clear();
  firstInFlight.clear();
  stuck.clear();
  lastGlobal = null;
  lastWaits.clear();
  sourceOf.clear();
  rotating.clear();
  viewCache = null;
  if (timer) { clearTimeout(timer); timer = null; }
  started = false;
  deps = { busy: () => false, log: consoleLog };
}

// ── settings ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface ArchiveSettings { paused: boolean; perHour: number; windowFrom: number | null; windowTo: number | null; minFreeGb: number }

/** Re-read on every tick, like the repair's switch: an admin's pause takes effect without a restart. */
export async function archiveSettings(): Promise<ArchiveSettings> {
  const r = await one<{ paused: boolean; per_hour: number; wfrom: number | null; wto: number | null; min_free: number }>(
    `SELECT archive_paused AS paused, archive_per_hour AS per_hour, archive_window_from AS wfrom,
            archive_window_to AS wto, archive_min_free_gb AS min_free FROM server_settings WHERE id = 1`,
  ).catch(() => null);
  return {
    paused: r?.paused === true,
    perHour: Number(r?.per_hour) || ARCHIVE_DEFAULTS.perHour,
    windowFrom: r?.wfrom ?? null,
    windowTo: r?.wto ?? null,
    minFreeGb: r?.min_free == null ? 20 : Number(r.min_free),
  };
}

/** The columns GET /api/admin/settings adds for the Downloads section (routes/admin.ts SETTINGS_COLS). */
export const ARCHIVE_SETTINGS_COLS = 'archive_paused, archive_per_hour, archive_window_from, archive_window_to, archive_min_free_gb';

/**
 * PATCH /api/admin/settings' archive fields, spread into its schema. Admin only by that route's own guard: the
 * pace is the whole server's politeness towards every site, so no member sets it.
 */
const hour = z.number().int().min(0).max(23).nullable();
export const ARCHIVE_SETTINGS_SHAPE = {
  archivePaused: z.boolean().optional(),
  archivePerHour: z.number().int().min(PER_HOUR_RANGE[0]).max(PER_HOUR_RANGE[1]).optional(),
  archiveWindowFrom: hour.optional(),
  archiveWindowTo: hour.optional(),
  archiveMinFreeGb: z.number().int().min(1).max(2000).optional(),
};
type ArchiveSettingsBody = { [K in keyof typeof ARCHIVE_SETTINGS_SHAPE]?: z.infer<(typeof ARCHIVE_SETTINGS_SHAPE)[K]> };

/**
 * The window's two ends come together or not at all, and are both set or both cleared: one end alone is a
 * window with no meaning, and a half-cleared one would read "from 22:00 until any time". Refused, not guessed.
 */
export function archiveWindowPair(b: ArchiveSettingsBody, ctx: z.RefinementCtx): void {
  const from = b.archiveWindowFrom;
  const to = b.archiveWindowTo;
  if ((from === undefined) !== (to === undefined) || (from === null) !== (to === null)) {
    ctx.addIssue({ code: 'custom', path: ['archiveWindowFrom'], message: 'archiveWindowFrom and archiveWindowTo are set, or cleared, together' });
  }
}

/** Write what the PATCH named. Any change reaches the running scheduler at once: the view is re-read, a tick runs. */
export async function applyArchiveSettings(b: ArchiveSettingsBody): Promise<void> {
  let changed = false;
  const set = async (col: string, v: unknown) => {
    await q(`UPDATE server_settings SET ${col} = $1, updated_at = now() WHERE id = 1`, [v]);
    changed = true;
  };
  if (b.archivePaused !== undefined) await set('archive_paused', b.archivePaused);
  if (b.archivePerHour !== undefined) await set('archive_per_hour', b.archivePerHour);
  if (b.archiveWindowFrom !== undefined) await set('archive_window_from', b.archiveWindowFrom);
  if (b.archiveWindowTo !== undefined) await set('archive_window_to', b.archiveWindowTo);
  if (b.archiveMinFreeGb !== undefined) await set('archive_min_free_gb', b.archiveMinFreeGb);
  if (changed) { invalidateArchiveView(); kick(); }
}

/** Free space under the download root in GiB, one decimal, for the settings page's floor; null when unknown. */
export async function archiveFreeGb(): Promise<number | null> {
  const b = await freeBytes();
  return b === null ? null : Math.round((b / 2 ** 30) * 10) / 10;
}

// ── queueing ──────────────────────────────────────────────────────────────────────────────────────────────────

export type EnqueueOutcome = 'queued' | 'already' | 'nothing' | 'unrouted' | 'denied' | 'not_found';

/**
 * The listing numbers the archive may still fetch for series `alias`.series_id: available (not held for a group,
 * not blocked), strictly below the boundary IN THE LISTING'S OWN TYPE (both are real: against a numeric, a
 * floor of 45.3 would count chapter 45.3 as below itself), under the sweep's retry cap, and with no held book of
 * that number -- override-aware, as the ghost rows are (lib/seriesListing.ts listingFor), and by the sweep's own
 * held rule, so a Delete-files tombstone is not fetched back and a verify-marked missing file is. A number inside a
 * file holding a range is held (lib/chapterRanges.ts `holds`), as the ghost rows have it. Reintroduce the plain
 * equality: "the slow archive leaves a range file's chapters out" in chapterRanges.int.test.ts counts seven left.
 */
function eligibleSql(l: string, a: string, capParam: string): string {
  return `${l}.status = 'available' AND ${l}.number < ${a}.boundary
    AND COALESCE((SELECT f.attempts FROM chapter_failures f WHERE f.series_id = ${l}.series_id AND f.number = ${l}.number), 0) < ${capParam}
    AND NOT EXISTS (
      SELECT 1 FROM lib_books b LEFT JOIN book_overrides ov ON ov.book_id = b.id
       WHERE b.series_id = ${l}.series_id AND ${holds('b', 'ov', `${l}.number`)} AND ${heldBooks('b')})
    -- Not a notice the admin hides, by what the listing says of it (lib/noticeChapters.ts): the sweep does not fetch
    -- those, nor does this.
    AND NOT ${noticeListed(l)}`;
}

/**
 * Queue a series to be fetched slowly, on behalf of `by`, seen through `ctx`.
 *
 * Who may: admins, and members with canDownload (the sources plugin's own preHandler says who reaches this) for a
 * series they may see (visible(), not browsable(): a series someone opened is not a listing), and only when
 * every source it follows is inside their age cap -- the archive fetches from whichever copy the release rules
 * choose, so a capped member cannot queue a series half of whose copies are on an adult source. The archive
 * never follows or hunts a new source, so nothing a member queues changes what the sweep does for everyone, and
 * the pace is per SOURCE: five hundred series queued on one site still share its few chapters an hour.
 *
 * A finished row is re-opened with its counts reset. `nothing` when the listing leaves nothing to fetch below
 * the boundary; a series with no listing yet is queued, and its first turn reads one.
 *
 * ⚠️ A series whose numbers are about to change (#116: a renumber waits for an admin's review, or a journal for
 * its finish) is queued WITHOUT a boundary: one placed now would be in the numbers the renumber replaces, and the
 * listing it counts "nothing left" from is the old one. The tick skips the row while the renumber is pending
 * ('renumbering') and its first turn afterwards reads the renumbered listing and places the boundary there -- the
 * enqueue the critic asked to happen after the settle, kept on the row so a restart keeps it too. The add path
 * answers such an enqueue `later` (routes/sources.ts archiveRest).
 * Reintroduce by placing the boundary anyway: "queued behind a pending renumber" in archive.int.test.ts finds a
 * boundary in the source's numbers.
 */
export async function enqueueArchive(seriesId: string, by: string | null, ctx: ViewCtx): Promise<EnqueueOutcome> {
  const p = new Params();
  const s = await one<{ id: string; source_id: string | null; floor: number | null; extra: string[]; renumbering: boolean }>(
    `SELECT s.id, s.source_id, s.chapter_floor::real AS floor,
            ARRAY(SELECT ss.source_id FROM series_sources ss WHERE ss.series_id = s.id) AS extra,
            (s.numbering_pending IS NOT NULL OR s.renumber_plan IS NOT NULL) AS renumbering
       FROM lib_series s WHERE s.id = ${p.add(seriesId)} AND ${visible('s', ctx, p)}`,
    p.values as any[],
  );
  if (!s) return 'not_found';
  const followed = [...new Set([s.source_id, ...(s.extra ?? [])].filter((x): x is string => !!x))];
  const loaded = followed.filter((id) => getSource(id));
  if (!loaded.length) return 'unrouted';
  // Reintroduce by dropping this: "who may queue" in archiveRoutes.int.test.ts reads queued for a capped member's
  // series on an adult source.
  if (loaded.some((id) => !sourceAllowedFor(getSource(id), ctx.maxAgeRating))) return 'denied';

  const row = await one<{ state: string }>('SELECT state FROM archive_queue WHERE series_id = $1', [seriesId]);
  if (row && row.state !== 'done') return 'already';

  const floor = s.floor == null ? null : Number(s.floor);
  const lst = s.renumbering ? null : await one<{ max: number | null; min: number | null }>(
    'SELECT max(number) AS max, min(number) AS min FROM series_listing WHERE series_id = $1', [seriesId]);
  const boundary = s.renumbering ? null : boundaryFor({ floor, listedMax: lst?.max == null ? null : Number(lst.max) });
  let direction: ArchiveDirection = 'up';
  if (boundary != null && lst?.max != null) {
    const left = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM series_listing l, (SELECT $2::real AS boundary) a
        WHERE l.series_id = $1 AND ${eligibleSql('l', 'a', '$3')}`, [seriesId, boundary, CHAPTER_RETRY_CAP]);
    if (!left?.n) return 'nothing';
    direction = await directionOf(seriesId, lst.min == null ? null : Number(lst.min));
  }
  const now = new Date(clock());
  const ins = await q<{ series_id: string }>(
    `INSERT INTO archive_queue (series_id, state, boundary, floor_at_start, direction, added_by, created_at)
     VALUES ($1, 'queued', $2::real, $3::real, $4, $5, $6)
     ON CONFLICT (series_id) DO UPDATE SET
       state = 'queued', boundary = EXCLUDED.boundary, floor_at_start = EXCLUDED.floor_at_start,
       direction = EXCLUDED.direction, added_by = EXCLUDED.added_by, created_at = EXCLUDED.created_at,
       started_at = NULL, finished_at = NULL, last_at = NULL, done_count = 0, failed_count = 0, bytes = 0,
       current_number = NULL, note = NULL
     WHERE archive_queue.state = 'done'
     RETURNING series_id`,
    [seriesId, boundary, floor, direction, by, now],
  );
  // Nothing returned: somebody queued it between the read above and this write.
  if (!ins.length) return 'already';
  invalidateArchiveView();
  kick();
  return 'queued';
}

/** directionFor, from the database: the lowest LISTED number the library holds against the lowest listed. */
async function directionOf(seriesId: string, listedMin: number | null): Promise<ArchiveDirection> {
  const h = await one<{ n: number | null }>(
    `SELECT min(l.number) AS n FROM series_listing l
      WHERE l.series_id = $1 AND EXISTS (
        SELECT 1 FROM lib_books b LEFT JOIN book_overrides ov ON ov.book_id = b.id
         WHERE b.series_id = l.series_id AND ${holds('b', 'ov', 'l.number')} AND ${heldBooks('b')})`,
    [seriesId]);
  return directionFor({ heldMin: h?.n == null ? null : Number(h.n), listedMin });
}

export type ArchiveActOutcome = 'ok' | 'not_found' | 'forbidden' | 'done';

/** A row's `renumbered` mark (#116), carried into a note that replaces the rest: `{}` when it has none. */
const KEEP_RENUMBERED = `CASE WHEN note ? 'renumbered' THEN jsonb_build_object('renumbered', note->'renumbered') ELSE '{}'::jsonb END`;

/**
 * Pause, resume or stop one archive. Its enqueuer may, and any admin; anyone else who can see the series is
 * refused (403), and one who cannot is told there is nothing there (404), as for a download card. Pause and
 * resume answer `done` on a finished archive; stop removes any row, which on a finished one is its dismissal.
 *
 * A chapter already in flight finishes: stopping is between chapters, never mid-write, like every Cancel here.
 * Stopped, the boundary goes with the row, and the sweep's own backfill below the floor resumes.
 */
export async function archiveAct(act: 'pause' | 'resume' | 'stop', seriesId: string, who: { userId: string | null; admin: boolean; ctx: ViewCtx }): Promise<ArchiveActOutcome> {
  const p = new Params();
  const row = await one<{ state: string; added_by: string | null }>(
    `SELECT a.state, a.added_by FROM archive_queue a JOIN lib_series s ON s.id = a.series_id
      WHERE a.series_id = ${p.add(seriesId)} AND ${visible('s', who.ctx, p)}`,
    p.values as any[],
  );
  if (!row) return 'not_found';
  // Reintroduce by dropping this: "pause, resume and stop: the enqueuer or an admin" in archiveRoutes.int.test.ts
  // reads 200 for another member's pause.
  if (!who.admin && !(who.userId && row.added_by === who.userId)) return 'forbidden';
  if (act === 'stop') {
    await q('DELETE FROM archive_queue WHERE series_id = $1', [seriesId]);
    // What it landed and has not scanned yet is scanned now: stopped, nothing else would until the next batch --
    // up to twenty minutes of a series page reading "0 chapters" over chapters that came in (#117 review).
    // Reintroduce by dropping this: "a stop scans in what it landed" in archive.int.test.ts finds no book rows.
    // Started, not waited for: it is a walk of the whole library, and a Stop that waited on one inside its request
    // could outlive the proxy on a large library and read as failed although it went through (integration-2 review).
    // Reintroduce by waiting: "a stop does not wait for the library scan" there.
    if (unscanned.has(seriesId)) void track(flushArchiveScan());
  } else {
    if (row.state === 'done') return 'done';
    // A pause and a resume replace the note, but not the mark a renumber left on it (`renumbered`, #116): a paused
    // row is not looked at, so the renumber's new direction is settled at its first look after the resume -- dropped
    // here, it was never settled, and the archive went on filling in the direction of the old numbers (integration-2
    // review).
    // Reintroduce by building the note without it: "a renumber moves a paused archive too" in archive.int.test.ts
    // starts chapter 1.
    if (act === 'pause') {
      await q(`UPDATE archive_queue SET state = 'paused', note = jsonb_build_object('pausedAt', $2::timestamptz) || ${KEEP_RENUMBERED}
                WHERE series_id = $1 AND state = 'queued'`, [seriesId, new Date(clock())]);
    } else {
      // Resumed is a fresh start: its three days without progress (attentionOf) count from now, and a listing that
      // failed is read at its next turn rather than on the ladder it was paused on.
      await q(`UPDATE archive_queue SET state = 'queued', note = jsonb_build_object('progressAt', $2::text) || ${KEEP_RENUMBERED}
                WHERE series_id = $1 AND state = 'paused'`, [seriesId, new Date(clock()).toISOString()]);
    }
  }
  invalidateArchiveView();
  kick();
  return 'ok';
}

/**
 * Forget what this process remembers about one series' archive: the landed-but-unscanned numbers, the ones a
 * scan could not index, and why it last waited. For a renumber (#116), whose settle rewrites the series' numbers
 * and remaps archive_queue.boundary and floor_at_start itself: numbers remembered from before would name the
 * wrong chapters afterwards. The files stay; the next pick finds any still unscanned on disk and scans them in.
 */
export function archiveForget(seriesId: string): void {
  unscanned.delete(seriesId);
  stuck.delete(seriesId);
  lastWaits.delete(seriesId);
  sourceOf.delete(seriesId);
  rotating.delete(seriesId);
  invalidateArchiveView();
}

// A renumber (#116), from both sides (the critic's "issue-116 vs issue-117"). Before its plan reads the series' books,
// what this archive landed and has not scanned yet is scanned in: a plan is built from lib_books, so a file with no
// row would keep its old name through the renames and be scanned in afterwards under a number that is another
// post's by then. The scan is started, not waited for, and the plan says `busy` until it is done (lib/numbering.ts
// beforePlan). After it commits, the numbers remembered for the series are forgotten; the commit has moved the row's
// boundary and floor itself, and the next tick settles its direction (note.renumbered).
// Reintroduce by dropping the first: "scanned in before the plan read the books" in archive.int.test.ts finds no
// book in the plan (and "scanned in before the apply read the books", none in the apply).
onBeforeRenumberPlan((seriesId) => {
  if (!unscanned.has(seriesId)) return false;
  void track(flushArchiveScan());
  return true;
});
onRenumbered((_folder, _map, seriesId) => archiveForget(seriesId));

/** A slow-archive chapter is being fetched into this folder right now: the fetch route's 409 says so. */
export function archiveBusy(folder: string): boolean {
  for (const f of flights.values()) if (f.folder === folder) return true;
  return false;
}

// ── the scheduler ─────────────────────────────────────────────────────────────────────────────────────────────

export interface TickReport {
  /** Why nothing ran at all, when nothing did for a server-wide reason. */
  waiting: GlobalWait | null;
  /** What this tick started: a chapter, or a listing read before one. */
  started: Array<{ seriesId: string; number: number | null; source: string; kind: 'chapter' | 'listing' }>;
  /** Why each queued series that did not start is waiting. */
  waits: Record<string, SeriesWait>;
  /** Series this tick found nothing left for, and so marked done. */
  finished: string[];
}

/**
 * archive_queue.note on a queued row: when it last moved forward (a chapter came in, its first listing placed the
 * boundary, it was resumed; created_at before any of those), the ladder of a listing that could not be read, how
 * many turns it has FINISHED since its last progress with nothing to show (`idleTurns`: a failed chapter, a read
 * that gave no listing), since when its source has been missing or switched off (`goneSince`, so a restart does
 * not start that day again), and that a renumber moved its numbers (`renumbered`, #116: its direction is settled
 * again at the next look). A paused row's note is {pausedAt}, a finished one's the DoneNote; each replaces this.
 */
interface QueuedNote {
  progressAt?: string; listingFails?: number; listingRetryAt?: string; idleTurns?: number; goneSince?: string; renumbered?: string;
}

interface QueuedRow {
  series_id: string; boundary: number | null; direction: ArchiveDirection; added_by: string | null; note: QueuedNote | null;
  title: string; folder: string; summary: string | null; author: string | null; genres: string[] | null;
  web: string | null; status: string | null; source_id: string | null; source_checked_at: Date | null;
  renumbering: boolean; by_role: string | null; by_cap: number | null; extra: string[];
  /** Whether its chapters may come from another copy of the same release (rotates): not under posting order, not with an order of its own. */
  numbering: string | null; source_prefs: unknown;
}
interface PaceRow { source_id: string; next_at: Date | null; backoff_level: number; backoff_until: Date | null; cycle_ms: number | null; last_at: Date | null }
interface Candidate { number: number; title: string | null; copies: ListingCopy[] | null; publishedAt: string | null }

const ms = (d: Date | string | null | undefined): number | null => (d == null ? null : new Date(d).getTime());

/**
 * archive_pace by RATE KEY (lib/pace.ts rateKeyOf) rather than by source (v0.55.4): the latest break and backoff any
 * source on the key is under, its latest turn, its highest backoff level. Two sites whose pages come from one image
 * server are one site to that server, so a break or a refusal earned on either holds both: kept per source, rotating
 * a series between Natomanga and Mangakakalot would have asked their one CDN twice as often as the pace allows.
 */
interface KeyPace { nextAt: number | null; backoffUntil: number | null; lastAt: number | null; backoffLevel: number }
function paceByKey(rows: Iterable<PaceRow>): Map<string, KeyPace> {
  const later = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : Math.max(a, b));
  const out = new Map<string, KeyPace>();
  for (const p of rows) {
    const key = rateKeyOf(p.source_id);
    const mine: KeyPace = { nextAt: ms(p.next_at), backoffUntil: ms(p.backoff_until), lastAt: ms(p.last_at), backoffLevel: Number(p.backoff_level) || 0 };
    const had = out.get(key);
    out.set(key, !had ? mine : {
      nextAt: later(had.nextAt, mine.nextAt), backoffUntil: later(had.backoffUntil, mine.backoffUntil),
      lastAt: later(had.lastAt, mine.lastAt), backoffLevel: Math.max(had.backoffLevel, mine.backoffLevel),
    });
  }
  return out;
}

/** An archive chapter or listing read is in flight on some source of this rate key. */
const keyInFlight = (key: string): boolean => [...flights.values()].some((f) => rateKeyOf(f.source) === key);

/** May this series' chapters come from another copy of the same release: not under posting order, nor with its own source order. */
const rotates = (r: Pick<QueuedRow, 'numbering' | 'source_prefs'>): boolean =>
  r.numbering !== 'posting_order' && !cleanSourceOrder((r.source_prefs as { priority?: unknown } | null)?.priority).length;

/**
 * Look once: start what may start, say why the rest waits, finish what has nothing left. Ticks never overlap --
 * a call during one waits for it and then looks again -- and the scheduler's own timer re-arms after each.
 */
export function archiveTick(opts: TickOpts = {}): Promise<TickReport> {
  const prev = ticking;
  const next: Promise<TickReport> = (async () => {
    if (prev) await prev.catch(() => {});
    return tickOnce(opts);
  })();
  ticking = next;
  void next.finally(() => { if (ticking === next) ticking = null; }).catch(() => {});
  return next;
}

/** `rand`: where the breaks and page gaps draw from. `busy`: jobBusy, when a test drives ticks without startArchive. */
export interface TickOpts { rand?: () => number; busy?: (folder: string) => boolean }

async function tickOnce(opts: TickOpts): Promise<TickReport> {
  const rand = opts.rand ?? Math.random;
  const busy = opts.busy ?? deps.busy;
  const now = clock();
  const report: TickReport = { waiting: null, started: [], waits: {}, finished: [] };
  maybeFlush(now);

  const set = await archiveSettings();
  // Measured only when there is a floor to keep: statfs is cheap, but not free, and 0 means no floor.
  const free = set.minFreeGb > 0 ? await freeBytes() : null;
  const g = globalWait({
    stopping: runtime.stopping, paused: set.paused,
    windowFrom: set.windowFrom, windowTo: set.windowTo, hour: new Date(now).getHours(), now, opensAt: windowOpensAt, inWindow,
    updating: runtime.updating, repairing: runtime.repairing, checking: checkRunning(),
    freeBytes: free, minFreeGb: set.minFreeGb,
  });
  if (g) {
    lastGlobal = lastGlobal?.wait.why === g.why ? { wait: g, since: lastGlobal.since } : { wait: g, since: now };
    report.waiting = g;
    return report;
  }
  lastGlobal = null;

  const rows = await q<QueuedRow>(
    `SELECT a.series_id, a.boundary, a.direction, a.added_by, a.note,
            s.title, s.folder, s.summary, s.author, s.genres, s.web, s.status, s.source_id, s.source_checked_at,
            (s.numbering_pending IS NOT NULL OR s.renumber_plan IS NOT NULL) AS renumbering, s.numbering, s.source_prefs,
            u.role AS by_role, u.max_age_rating AS by_cap,
            ARRAY(SELECT ss.source_id FROM series_sources ss WHERE ss.series_id = s.id ORDER BY ss.created_at, ss.source_id) AS extra
       FROM archive_queue a
       JOIN lib_series s ON s.id = a.series_id
       LEFT JOIN users u ON u.id = a.added_by
      WHERE a.state = 'queued' AND ${visibleToAll('s')}
        -- An unmonitored series (auto_update off) fetches nothing unattended: its archive stays queued, where it was,
        -- and goes on when the series is monitored again.
        AND s.auto_update
      ORDER BY a.last_at ASC NULLS FIRST, a.created_at ASC, a.series_id`,
  );
  const seen = new Set(rows.map((r) => r.series_id));
  for (const id of [...lastWaits.keys()]) if (!seen.has(id)) lastWaits.delete(id);
  if (!rows.length) return report;

  // Which of them have a stored listing at all. A renumber (#116) deletes the series' listing and its check writes
  // the new one a moment later; a look in between found no candidate and FINISHED the archive -- boundary lifted,
  // floor cleared -- with the back catalogue never fetched. No listing is read first, like no boundary.
  // Reintroduce by dropping `!listed.has`: "a look between a renumber and its listing" in archive.int.test.ts
  // finds the archive done.
  const listed = new Set((await q<{ series_id: string }>(
    'SELECT DISTINCT series_id FROM series_listing WHERE series_id = ANY($1::text[])', [[...seen]]).catch(() => [])).map((r) => r.series_id));
  const needsListing = (r: QueuedRow) => r.boundary == null || !listed.has(r.series_id) || (ms(r.source_checked_at) ?? 0) < now - LISTING_STALE_MS;
  for (const r of rows) {
    if (r.renumbering || needsListing(r)) continue;
    // A renumber moved the series' numbers under its row (#116): which way it fills is settled again, from the
    // renumbered listing, as it was at the enqueue (the commit moved the boundary and the floor itself).
    // Reintroduce by keeping the direction: "a renumber moves the archive" in archive.int.test.ts reads 'up'.
    if (r.note?.renumbered) {
      const lst = await one<{ min: number | null }>('SELECT min(number) AS min FROM series_listing WHERE series_id = $1', [r.series_id]).catch(() => null);
      r.direction = await directionOf(r.series_id, lst?.min == null ? null : Number(lst.min));
      await q(`UPDATE archive_queue SET direction = $2, note = note - 'renumbered' WHERE series_id = $1`, [r.series_id, r.direction]).catch(() => {});
    }
    // A listing ladder from a failed REFRESH, with the listing still in hand: updateSeries stamps a source that did
    // not answer as checked, so the listing reads fresh again and chapters go on from it -- and the ladder is over.
    // Left on the row, the next failed read a week on resumed it at the old rung.
    if (r.note?.listingFails) await noteListing(r.series_id, true, false, now);
  }
  const picking = rows.filter((r) => !r.renumbering && !needsListing(r)).map((r) => r.series_id);
  const cands = await candidatesFor(picking);

  // Every source any of these may be on, read once.
  const followedOf = (r: QueuedRow) => [...new Set([r.source_id, ...(r.extra ?? [])].filter((x): x is string => !!x))];
  const allSources = [...new Set(rows.flatMap(followedOf))];
  // Every row, not only the followed sources': a site on the same image server as one of them rests with it (paceByKey),
  // whichever series last asked it. One row per source the archive has ever asked.
  const paceRows = new Map((await q<PaceRow>(
    'SELECT source_id, next_at, backoff_level, backoff_until, cycle_ms, last_at FROM archive_pace')).map((r) => [r.source_id, r]));
  const keyPace = paceByKey(paceRows.values());
  const health = new Map((await q<{ source_id: string; blocked_until: Date | null; disabled: boolean }>(
    'SELECT source_id, blocked_until, disabled FROM source_health WHERE source_id = ANY($1::text[])', [allSources])
    .catch(() => [])).map((r) => [r.source_id, r]));
  const stateOf = (src: string): SourceState => {
    // The gate is the rate group's (pace.ts rateKeyOf): a Spanish MangaDex download keeps English waiting too. So since
    // v0.55.4 are the break, the backoff and the chapter in flight: a source whose pages come from the same image server
    // as one the archive is resting, backing off or fetching on is that server asked again.
    const key = rateKeyOf(src);
    const kp = keyPace.get(key);
    const h = health.get(src);
    return {
      loaded: !!getSource(src), disabled: h?.disabled === true, blockedUntil: ms(h?.blocked_until),
      gate: gateDepth(key), paced: refusedLately(src),
      nextAt: kp?.nextAt ?? null, backoffUntil: kp?.backoffUntil ?? null, inFlight: keyInFlight(key),
    };
  };

  /**
   * The rate keys this look has started something on. By key, not by source (v0.55.4): two sources on one image server
   * both started in one look -- the gate that would have held the second is entered only once the first is under way.
   * Reintroduce by claiming the source: "two sources on one image server" in archive.int.test.ts starts both series.
   */
  const claimed = new Set<string>();
  /** The archive's slots for a source: one chapter per rate key, and at most so many sources at once; then its own state. */
  const slotWait = (src: string): Omit<SeriesWait, 'source'> | null => {
    const key = rateKeyOf(src);
    if (claimed.has(key) || (!keyInFlight(key) && flights.size >= maxSources())) return { why: 'turn' };
    return sourceWait(stateOf(src), now);
  };
  /** Notes a look writes on the rows (goneSince), awaited before it answers: a view read right after sees them. */
  const notes: Array<Promise<unknown>> = [];
  const wait = (r: QueuedRow, w: SeriesWait) => {
    report.waits[r.series_id] = w;
    const had = lastWaits.get(r.series_id);
    // Since when a source has been missing or switched off is kept on the row as well: in memory only, every restart
    // started its day again, and on the desktop app -- which restarts with the app -- it could never reach a day
    // and show under Needs attention (#117 review).
    const gone = w.why === 'source_missing' || w.why === 'disabled';
    const kept = gone && r.note?.goneSince ? Date.parse(r.note.goneSince) : NaN;
    const since = Number.isFinite(kept) ? Math.min(kept, had?.wait.why === w.why ? had.since : now)
      : had?.wait.why === w.why ? had.since : now;
    lastWaits.set(r.series_id, { wait: w, since });
    if (gone && !r.note?.goneSince) {
      notes.push(q(`UPDATE archive_queue SET note = COALESCE(note, '{}'::jsonb) || jsonb_build_object('goneSince', $2::text)
                      WHERE series_id = $1 AND state = 'queued'`, [r.series_id, new Date(since).toISOString()]).catch(() => []));
    } else if (!gone && r.note?.goneSince) {
      notes.push(q(`UPDATE archive_queue SET note = note - 'goneSince' WHERE series_id = $1`, [r.series_id]).catch(() => []));
    }
  };

  for (const r of rows) {
    if (r.renumbering) { wait(r, { why: 'renumbering' }); continue; }
    const followed = followedOf(r);
    // The enqueuer's age cap travels with the row: a capped member's archive never takes a chapter from a
    // source their cap shuts out, whatever the series has come to follow since. An admin, or an enqueuer whose
    // account is gone, is the server's.
    const cap = r.by_role === 'admin' || r.added_by == null ? null : r.by_cap;
    const capOk = (src: string) => sourceAllowedFor(getSource(src), cap);

    let S: string | null = null;
    let pick: { number: number; title: string | null; copy: ListingCopy; publishedAt: string | null } | null = null;
    if (needsListing(r)) {
      // The listing is read first, as that source's turn: a boundary cannot be placed without one, and a
      // week-old list names chapters the site may have moved.
      S = followed.find((src) => getSource(src) && capOk(src)) ?? null;
      if (!S) { wait(r, { why: 'source_missing' }); continue; }
      // A read that gave no listing is not repeated at the source's next turn: the series waits on its own ladder
      // (runListing), and the other series on the site go in the meantime.
      // Reintroduce by dropping this: "a listing that cannot be read is asked for less and less often" in
      // archive.int.test.ts asks the site for it every few minutes.
      const retryAt = ms(r.note?.listingRetryAt);
      if (retryAt != null && retryAt > now) { wait(r, { why: 'listing', until: retryAt, source: getSource(S)?.name ?? S }); continue; }
      rotating.delete(r.series_id);
      sourceOf.set(r.series_id, S);
      const sw = slotWait(S);
      if (sw) { wait(r, { ...sw, source: getSource(S)?.name ?? S }); continue; }
    } else {
      const list = cands.get(r.series_id) ?? [];
      // One chapter of a series at a time: its next one waits for the one in flight, wherever that is. Rotating, the next
      // could otherwise start on another site beside it (production's busy(), jobBusy, says so too, as series_busy).
      const own = [...flights.values()].find((f) => f.seriesId === r.series_id);
      if (own) { wait(r, { why: 'turn', source: getSource(own.source)?.name ?? own.source }); continue; }
      if (!list.length) {
        // Its last chapters are on disk but not yet in the library: scan them in first, so what is left is
        // counted from the library and the Updates baseline is raised before the row says done.
        if (unscanned.has(r.series_id)) await flushArchiveScan();
        if (await finishSeries(r.series_id, now)) report.finished.push(r.series_id);
        continue;
      }
      let copies: ListingCopy[] = [];
      for (const c of list) {
        // Already on disk -- landed before a restart, or by a download nobody scanned: not fetched again (the
        // downloader would skip it anyway, but only after the source's turn was spent). Scanned in shortly.
        if (await onDisk(r.folder, c.number)) { await noteUnscanned(r.series_id, r.folder, c.number, {}, now); continue; }
        const open = await automaticCopiesFor(r.series_id, c.copies ?? []);
        const copy = open.find((cp) => followed.includes(cp.source) && getSource(cp.source) && capOk(cp.source));
        if (!copy) continue;
        pick = { number: c.number, title: c.title, copy, publishedAt: c.publishedAt };
        copies = open;
        break;
      }
      if (!pick) {
        const anyLoaded = followed.some((src) => getSource(src));
        wait(r, anyLoaded && unscanned.has(r.series_id) ? { why: 'turn' } : { why: 'source_missing' });
        continue;
      }
      // Where the chapter may come from (v0.55.4, #158): the copy the release rules chose, and on a series that may
      // rotate, the same release on every other followed source (lib/seriesListing.ts sameRelease) that the enqueuer's
      // cap and the sweep's adult rule allow. A second site on the chosen one's image server is the same server: it waits
      // with it (stateOf is by key) and loses their tie, so taking turns between the two never asks it more often.
      // Reintroduce by keeping the chosen copy alone: "a series rotates to a site that is not resting" in
      // archive.int.test.ts waits out the chosen site's break.
      const options = [pick.copy];
      if (rotates(r)) {
        const same = sameRelease(pick.copy, copies, { followed, langOf: declaredLang }).slice(1).filter((cp) => getSource(cp.source) && capOk(cp.source));
        if (same.length) {
          // The rule the chapter's alternates are held to (runChapter `allowed`), beside the enqueuer's cap above: never an
          // adult source on a clean series. Reintroduce by dropping either: "never onto an adult source" in
          // archive.int.test.ts takes a second chapter from the adult site.
          const sweepRule = await sweepAllowedFor(await seriesIsAdult(r.series_id));
          for (const cp of same) if (sweepRule(cp.source)) options.push(cp);
        }
      }
      if (options.length > 1) rotating.set(r.series_id, options.map((cp) => cp.source));
      else rotating.delete(r.series_id);
      // A free key, of those: the one whose last chapter was longest ago, the chosen copy's on a tie -- so each takes its
      // turn, and a series with one site behaves exactly as before.
      const waits = options.map((cp) => slotWait(cp.source));
      const lastAt = (cp: ListingCopy) => keyPace.get(rateKeyOf(cp.source))?.lastAt ?? -Infinity;
      let go: ListingCopy | null = null;
      for (let i = 0; i < options.length; i++) if (!waits[i] && (!go || lastAt(options[i]) < lastAt(go))) go = options[i];
      if (!go) {
        // Nothing free: the chosen copy's reason -- unless it is backing off and another site is only between chapters. A
        // series another site takes in a few minutes is not "left alone after refusals"; backing off is when every one is.
        const at = waits[0]!.why === 'backoff' ? Math.max(0, waits.findIndex((w) => w!.why !== 'backoff')) : 0;
        sourceOf.set(r.series_id, options[at].source);
        wait(r, { ...waits[at]!, source: getSource(options[at].source)?.name ?? options[at].source });
        continue;
      }
      pick.copy = go;
      S = pick.copy.source;
      sourceOf.set(r.series_id, S);
    }
    const name = getSource(S)?.name ?? S;

    // Reintroduce by dropping this: "it yields" in archive.int.test.ts starts the chapter of a series a Fetch is
    // already writing.
    if (busy(r.folder)) { wait(r, { why: 'series_busy', source: name }); continue; }
    // The queue query is a snapshot. Unmonitor may be pressed while another series takes its turn; claim
    // neither a source slot nor a folder for a row that is no longer automatic work.
    if (!(await seriesIsMonitored(r.series_id))) continue;
    // Monitoring is a database read. A user download or destructive cleanup can reserve the folder while it is
    // awaited; make that reservation authoritative at the last synchronous boundary before begin() marks our turn.
    if (busy(r.folder)) { wait(r, { why: 'series_busy', source: name }); continue; }

    claimed.add(rateKeyOf(S));
    lastWaits.delete(r.series_id);
    const pace = paceRows.get(S) ?? null;
    if (pick) {
      report.started.push({ seriesId: r.series_id, number: pick.number, source: S, kind: 'chapter' });
      await begin(r, S, pick.number);
      track(runChapter(r, S, pick, followed, capOk, pace, set, rand, generation));
    } else {
      report.started.push({ seriesId: r.series_id, number: null, source: S, kind: 'listing' });
      await begin(r, S, null);
      track(runListing(r, S, set, rand, generation));
    }
  }
  await Promise.all(notes);
  return report;
}

/**
 * The next few missing numbers of each series, in its direction, excluding what is already on its way and what a
 * scan could not index. Excluded IN the query, so the PICK_DEPTH it takes are all numbers that can be fetched:
 * filtered afterwards, five stuck numbers in a row left an empty list, and the series was finished early with the
 * rest of its back catalogue never asked for.
 * Reintroduce by filtering `stuck` after the query: "numbers a scan could not index are stepped over" in
 * archive.int.test.ts finishes the series with chapters 6 and 7 still missing.
 */
async function candidatesFor(seriesIds: string[]): Promise<Map<string, Candidate[]>> {
  const out = new Map<string, Candidate[]>();
  if (!seriesIds.length) return out;
  const exSid: string[] = [];
  const exNum: number[] = [];
  for (const [sid, u] of unscanned) for (const n of u.items.keys()) { exSid.push(sid); exNum.push(n); }
  for (const f of flights.values()) if (f.number != null) { exSid.push(f.seriesId); exNum.push(f.number); }
  for (const [sid, nums] of stuck) for (const n of nums) { exSid.push(sid); exNum.push(n); }
  const rows = await q<{ series_id: string; number: number; title: string | null; copies: ListingCopy[] | null; published_at: Date | null }>(
    `SELECT x.series_id, x.number, x.title, x.copies, x.published_at FROM (
       SELECT l.series_id, l.number, l.title, l.copies, l.published_at,
              row_number() OVER (PARTITION BY l.series_id
                                 ORDER BY CASE WHEN a.direction = 'down' THEN -l.number ELSE l.number END) AS rk
         FROM series_listing l JOIN archive_queue a ON a.series_id = l.series_id
        WHERE l.series_id = ANY($1::text[]) AND ${eligibleSql('l', 'a', '$2')}
          AND NOT EXISTS (SELECT 1 FROM unnest($3::text[], $4::real[]) AS x(sid, n) WHERE x.sid = l.series_id AND x.n = l.number)
     ) x WHERE x.rk <= $5 ORDER BY x.series_id, x.rk`,
    [seriesIds, CHAPTER_RETRY_CAP, exSid, exNum, PICK_DEPTH],
  );
  for (const r of rows) {
    const list = out.get(r.series_id) ?? [];
    list.push({ number: Number(r.number), title: r.title, copies: r.copies, publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null });
    out.set(r.series_id, list);
  }
  return out;
}

const onDisk = (folder: string, n: number): Promise<boolean> =>
  stat(join(DL_ROOT, chapterFileRel(folder, n))).then(() => true, () => false);

/**
 * The start of a turn, written down before anything is asked of the site: the source's next start is reserved
 * a minimum break out, so a crash mid-chapter -- or a crash loop -- restarts into a break, never into a burst.
 * Reintroduce by writing next_at only after the chapter: "a chapter cut off by a crash comes back into a break"
 * in archive.int.test.ts finds nothing reserved while the chapter is in flight.
 */
async function begin(r: QueuedRow, S: string, number: number | null): Promise<void> {
  const now = clock();
  flights.set(S, { seriesId: r.series_id, number, folder: r.folder, source: S, startedAt: now });
  busyFolders.add(r.folder);
  myFolders.add(r.folder);
  await q(
    `INSERT INTO archive_pace (source_id, next_at) VALUES ($1, $2)
     ON CONFLICT (source_id) DO UPDATE SET next_at = GREATEST(archive_pace.next_at, EXCLUDED.next_at)`,
    [S, new Date(now + minBreakMs())],
  ).catch((e) => deps.log.warn(`could not reserve the next start on ${S}: ${(e as Error)?.message || e}`));
  await q(
    `UPDATE archive_queue SET current_number = $2, started_at = COALESCE(started_at, $3), last_at = $3 WHERE series_id = $1`,
    [r.series_id, number, new Date(now)],
  ).catch(() => {});
  invalidateArchiveView();
}

/** The end of a turn: the slot, the busy mark and the view, whatever happened. */
function end(r: QueuedRow, S: string, gen: number): void {
  if (gen !== generation) return;
  flights.delete(S);
  busyFolders.delete(r.folder);
  myFolders.delete(r.folder);
  invalidateArchiveView();
  kick();
}

/**
 * Read a series' listing as its source's turn: the first read places a boundary, a later one refreshes a list a
 * week old.
 *
 * ⚠️ What the read gave decides what follows. A read that gave nothing -- the site failed or timed out (updateSeries
 * says `source_error`), it lists nothing for the series (a moved or delisted series: the boundary is still null),
 * the source was in a cooldown, or the read threw -- used to be followed by the same 45 s rest as a good one, and
 * the next tick asked again: about 1,400 requests a day to a site for a listing that is not there, and a row that
 * stayed "queued" with no reason shown. Now the SOURCE rests a whole break, as after a chapter, and the SERIES waits
 * on its own ladder (listingRetryAt: 1 h, 3 h, 12 h, then a day) kept on its row, so a restart keeps it too. Three
 * days of that and Needs attention shows it (attentionOf, 'stalled'). The row stays queued: a listing that comes
 * back is picked up at the next read, as a site that stops refusing is.
 */
async function runListing(r: QueuedRow, S: string, set: ArchiveSettings, rand: () => number, gen: number): Promise<void> {
  const t0 = clock();
  // The source answered, and the series now has a boundary to work below (a refresh already had one).
  let got = false;
  // This read placed the boundary: the series' first step forward.
  let placed = false;
  try {
    // maxNew 0: listed, persisted and stamped, nothing downloaded. Never a hunt: the archive does not go looking.
    const res = await withOrigin('archive', r.added_by, () => updateSeries(r.series_id, 0, { hunt: false, unattended: true, folderHeld: true }));
    if (res.outcome !== 'ok') {
      deps.log.warn(`the listing of "${r.title}" could not be read (${res.outcome})`);
    } else if (r.boundary != null) {
      // A refresh counts when a listing is there afterwards: a source that answers with nothing leaves the previous
      // listing standing (lib/updater.ts), and after a renumber (#116) there is none to leave. Counted as read on
      // the answer alone, a series whose listing a renumber had deleted was asked for it again every minute.
      got = !!(await one('SELECT 1 AS x FROM series_listing WHERE series_id = $1 LIMIT 1', [r.series_id]));
      if (!got) deps.log.warn(`the source of "${r.title}" lists no chapters for it`);
    } else {
      const f = await one<{ floor: number | null }>('SELECT chapter_floor::real AS floor FROM lib_series WHERE id = $1', [r.series_id]);
      const lst = await one<{ max: number | null; min: number | null }>(
        'SELECT max(number) AS max, min(number) AS min FROM series_listing WHERE series_id = $1', [r.series_id]);
      const boundary = boundaryFor({ floor: f?.floor == null ? null : Number(f.floor), listedMax: lst?.max == null ? null : Number(lst.max) });
      if (boundary != null) {
        const direction = await directionOf(r.series_id, lst?.min == null ? null : Number(lst.min));
        await q('UPDATE archive_queue SET boundary = $2::real, direction = $3 WHERE series_id = $1 AND boundary IS NULL',
          [r.series_id, boundary, direction]);
        got = placed = true;
      } else {
        deps.log.warn(`the source of "${r.title}" lists no chapters for it`);
      }
    }
  } catch (e) {
    deps.log.warn(`reading the listing of "${r.title}" failed: ${(e as Error)?.message || e}`);
  } finally {
    const now = clock();
    // A listing that came back is one request, not a chapter: the minimum rest. One that did not rests the source
    // a whole break, as a chapter would, so a site that is failing is not asked again within the minute by the
    // next series queued on it.
    // Reintroduce by resting the minimum whatever came back: "a listing that cannot be read" in archive.int.test.ts
    // finds the source free again in 45 s.
    const rest = got ? minBreakMs() : nextBreakMs({ perHour: set.perHour, chapterMs: now - t0, rand, minBreakMs: minBreakMs() }).ms;
    await q(`UPDATE archive_pace SET next_at = $2, last_reason = $3 WHERE source_id = $1`,
      [S, new Date(now + rest), got ? 'listing' : 'no_listing']).catch(() => {});
    await noteListing(r.series_id, got, placed, now);
    await q('UPDATE archive_queue SET current_number = NULL WHERE series_id = $1', [r.series_id]).catch(() => {});
    end(r, S, gen);
  }
}

/**
 * The listing ladder on the series' row (archive_queue.note, QueuedNote): cleared by a read that gave a listing --
 * the first one, which placed the boundary, is progress -- and one step higher after a read that did not, with
 * when to read again; a read that did not is also a turn with nothing to show (idleTurns). Queued rows only: a
 * pause replaces the note, and a resume starts afresh anyway.
 */
async function noteListing(seriesId: string, got: boolean, placed: boolean, now: number): Promise<void> {
  const at = new Date(now).toISOString();
  if (got) {
    await q(
      `UPDATE archive_queue SET note = (COALESCE(note, '{}'::jsonb) - 'listingFails' - 'listingRetryAt')
              || CASE WHEN $2 THEN jsonb_build_object('progressAt', $3::text, 'idleTurns', 0) ELSE '{}'::jsonb END
        WHERE series_id = $1 AND state = 'queued'`,
      [seriesId, placed, at],
    ).catch(() => {});
    return;
  }
  const row = await one<{ note: QueuedNote | null }>('SELECT note FROM archive_queue WHERE series_id = $1', [seriesId]).catch(() => null);
  const fails = (Number(row?.note?.listingFails) || 0) + 1;
  const retry = new Date(listingRetryAt(fails, now, ARCHIVE_DEFAULTS.backoffMs)).toISOString();
  await q(
    `UPDATE archive_queue SET note = COALESCE(note, '{}'::jsonb) || jsonb_build_object('listingFails', $2::int, 'listingRetryAt', $3::text,
              'idleTurns', COALESCE((note->>'idleTurns')::int, 0) + 1)
      WHERE series_id = $1 AND state = 'queued'`,
    [seriesId, fails, retry],
  ).catch((e) => deps.log.warn(`could not write when to read the listing again: ${(e as Error)?.message || e}`));
}

/**
 * A chapter's turn is over: the idle count on the series' row (attentionOf 'stalled' reads it). A chapter that came
 * in is progress and starts the count again, a failed one adds to it; one found on disk, or cut short by the disk
 * floor, is neither -- nothing was asked of the site, or the site was never at fault.
 */
async function noteTurn(seriesId: string, landed: boolean, now: number): Promise<void> {
  await q(
    landed
      ? `UPDATE archive_queue SET note = COALESCE(note, '{}'::jsonb) || jsonb_build_object('progressAt', $2::text, 'idleTurns', 0)
          WHERE series_id = $1 AND state = 'queued'`
      : `UPDATE archive_queue SET note = COALESCE(note, '{}'::jsonb) || jsonb_build_object('idleTurns', COALESCE((note->>'idleTurns')::int, 0) + 1)
          WHERE series_id = $1 AND state = 'queued'`,
    landed ? [seriesId, new Date(now).toISOString()] : [seriesId],
  ).catch(() => {});
}

async function runChapter(
  r: QueuedRow, S: string, pick: { number: number; title: string | null; copy: ListingCopy; publishedAt: string | null },
  followed: string[], capOk: (src: string) => boolean, pace: PaceRow | null, set: ArchiveSettings, rand: () => number, gen: number,
): Promise<void> {
  const t0 = clock();
  const n = pick.number;
  let out: FallbackOutcome | null = null;
  let diskFull = false;
  let bytes = 0;
  // Every source this chapter asked, with what it failed with (undefined: it answered). The chosen copy's, and
  // each alternate downloadWithFallback turned to after it: every one of them was a request to a site.
  const asked = new Map<string, unknown>();
  // The series' first chapter from its archive: scanned in the moment it lands (below), and marked for its whole
  // flight.
  let first = false;
  const key = flightKey(r.folder, n);
  try {
    // Asked BEFORE the download, so what the scan adds can be told apart from a row that was already there (a
    // verify-marked missing file coming back is not a new chapter for the Updates count).
    const had = await one<{ x: number }>('SELECT 1 AS x FROM lib_books WHERE series_id = $1 AND number = $2::real LIMIT 1', [r.series_id, n]);
    // Whether it is the first, asked beside `had` and before the download for the same reason. Only for a series the
    // library holds nothing of: the scan walks the whole library, and a series the library already shows reads no
    // "0 chapters" while a chapter waits for its batch. Every first landing walked it, and a bulk enqueue lands one
    // first chapter per series on each source's first pass: a full scan each (v0.49.1 review).
    // Reintroduce by leaving the library out (drop `in_library`): "a series the library already holds" in
    // archive.int.test.ts finds a scan run, and chapter 3 in the library before its batch.
    const was = await one<{ done: number; in_library: boolean }>(
      `SELECT a.done_count AS done, EXISTS (SELECT 1 FROM lib_books b WHERE b.series_id = a.series_id) AS in_library
         FROM archive_queue a WHERE a.series_id = $1`, [r.series_id]).catch(() => null);
    first = !!was && Number(was.done) === 0 && !was.in_library;
    // Reintroduce by marking it only once it is counted (drop this line): "listed in the downloads once the library
    // holds it" in archive.int.test.ts finds it listed between its landing and its count.
    if (first && gen === generation) firstInFlight.add(key);
    const sweepRule = await sweepAllowedFor(await seriesIsAdult(r.series_id));
    const allowed = (src: string) => sweepRule(src) && capOk(src);
    const meta = { series: r.title, summary: r.summary ?? undefined, author: r.author ?? undefined, genres: r.genres ?? undefined, url: r.web ?? undefined, status: r.status ?? undefined };
    try {
      await archiveHooks.beforeDownload?.(r.series_id, n);
      out = await withOrigin('archive', r.added_by, () => withSlowPace({ pageGapMs: pageGapRange(), rand }, () => downloadWithFallback({
        seriesId: r.series_id, title: r.title, folder: r.folder, meta,
        chapter: copyToChapter(pick.copy, { number: n, title: pick.title }),
        // The listing's other copies, from followed sources the archive is not resting or fetching on: an
        // alternate is a request to a site too, and a site in its break is not asked on the side.
        alternates: () => alternatesOf(r.series_id, n, pick.copy, followed),
        refusing: new Set<string>(),
        allowed,
        hunt: undefined,
        admit: () => seriesIsMonitored(r.series_id),
        automaticAllowed: (candidate) => automaticChapterAllowedFor(r.series_id, candidate),
        sourceAllowedNow: async (candidate) => {
          const id = candidate.source ?? '';
          if (!id || !(await seriesFollowsSource(r.series_id, id))) return false;
          const current = await sweepAllowedFor(await seriesIsAdult(r.series_id));
          return current(id) && capOk(id);
        },
        onAsked: (src, err) => { asked.set(src, err); },
      })));
    } catch (e: any) {
      if (e?.diskFull) diskFull = true;
      else throw e;
    }
    if (out && (out.kind === 'landed' || out.kind === 'partial')) {
      bytes = await stat(join(DL_ROOT, chapterFileRel(r.folder, n))).then((s) => s.size, () => 0);
      // The source chapter it came from rides on the landing, as the sweep's does (updater.ts Landed.chapterId):
      // setBookMeta stamps lib_books.source_chapter_id with it after the scan, so a later renumber (#116) knows
      // exactly which post the file is.
      const landed: Landed = {
        number: n, scanlator: out.chapterUsed.scanlator, source: out.via, title: out.chapterUsed.title, chapterId: out.chapterUsed.sourceId,
        ...(out.kind === 'partial' ? { missing: out.missing.map((i) => i + 1) } : {}),
      };
      await archiveHooks.afterLanding?.(r.series_id, n);
      // A chapter in is progress: its three days without any (attentionOf) start again, and so do its idle turns.
      const counted = await q<{ n: number }>(`UPDATE archive_queue SET done_count = done_count + 1, bytes = bytes + $2,
                note = COALESCE(note, '{}'::jsonb) || jsonb_build_object('progressAt', $3::text, 'idleTurns', 0) WHERE series_id = $1
                RETURNING done_count AS n`,
      [r.series_id, bytes, new Date(clock()).toISOString()]).catch(() => [] as Array<{ n: number }>);
      // Taken as waiting for its scan in the step that counts it, and the view's rows read again: `left` loses it as
      // `done` gains it. Noted before the count, a look in between took it off `left` while `done` did not count it yet,
      // and so did rows read before the count, cached until the turn ended: "0 of 13" of 14 (v0.49.1 final walk).
      // Reintroduce by noting it before the count: "at its landing" in archive.int.test.ts reads 0 of 13; by dropping the
      // invalidateArchiveView() here: "once counted" does.
      if (gen === generation) {
        await noteUnscanned(r.series_id, r.folder, n, {
          landed, publishedAt: out.chapterUsed.publishedAt ?? pick.publishedAt ?? undefined, newRow: !had,
        }, clock());
        invalidateArchiveView();
      }
      // The first chapter an archive lands for a series the library holds nothing of (`first`) is scanned in at once;
      // the rest wait for a batch (maybeFlush). Until the batch, a series added with nothing but its archive read
      // "0 chapters · none fetched yet" under a band saying "1 of 14", and Came in today showed its tile with no cover
      // (v0.49.1). Not awaited: the source's break and pace are this chapter's to write, whatever the scan takes.
      // Reintroduce by leaving it to the batch: "the first chapter an archive lands" in archive.int.test.ts finds no
      // book row.
      if (first && Number(counted[0]?.n) === 1 && gen === generation) {
        // `now` takes over from the flight's mark (firstInFlight), which ends with this chapter's turn: it keeps the
        // chapter out of the downloads view until the scan is done. Reintroduce by dropping it: "listed in the
        // downloads once the library holds it" in archive.int.test.ts finds it listed once its turn is over.
        const item = unscanned.get(r.series_id)?.items.get(n);
        if (item) item.now = true;
        void track(flushArchiveScan());
      }
      // A chapter the site let through ends its refusal run. Taken from another followed source instead, the
      // chosen one did NOT let it through: a refusal there still backs it off, landed or not -- and so does one
      // from an alternate asked on the way.
      if (out.switched) await backOff(S, { blockStatus: out.switched.why });
      await backOffAlternates(asked, [S, out.via]);
      await q(`UPDATE archive_pace SET backoff_level = 0, backoff_until = NULL, last_reason = 'ok' WHERE source_id = $1`, [out.via]).catch(() => {});
    } else if (out?.kind === 'skipped' && out.why === 'on_disk') {
      if (gen === generation) await noteUnscanned(r.series_id, r.folder, n, {}, clock());
    } else if (out?.kind === 'failed') {
      await noteChapterFailure({ seriesId: r.series_id, title: r.title, number: n, sourceId: out.via, err: out.err });
      await q('UPDATE archive_queue SET failed_count = failed_count + 1 WHERE series_id = $1', [r.series_id]).catch(() => {});
      await noteTurn(r.series_id, false, clock());
      await backOff(out.via || S, out.err);
      await backOffAlternates(asked, [S, out.via]);
    }
  } catch (e) {
    deps.log.warn(`"${r.title}" ch ${n}: ${(e as Error)?.message || e}`);
  } finally {
    const now = clock();
    // The break that makes this look like a person: jittered, paid for by the chapter's own time, now and then
    // a long one. None after a chapter that was already on disk -- nothing was asked of the site.
    const skippedWithoutAsk = out?.kind === 'skipped' && (out.why === 'on_disk' || out.why === 'paused');
    const brk = skippedWithoutAsk ? 0 : nextBreakMs({ perHour: set.perHour, chapterMs: now - t0, rand, minBreakMs: minBreakMs() }).ms;
    const nextAt = diskFull ? now + DISK_WAIT_MS : now + brk;
    // One cycle on this source: from the end of its last chapter to the end of this one, less what was the window's
    // or the site's rather than the pace's (archivePlan.ts outsideCycleMs) -- the hours outside the window, a
    // backoff beyond its break. The running average is how long a chapter takes, and the ETA is built from it.
    // Reintroduce by feeding the whole span: "the running cycle is the chapter's time" in archive.int.test.ts reads
    // an average pulled up by the night and by the backoff.
    const lastAt = ms(pace?.last_at);
    const sample = lastAt != null
      ? now - lastAt - outsideCycleMs({
        from: lastAt, to: t0, breakEnd: ms(pace?.next_at), backoffUntil: ms(pace?.backoff_until),
        windowFrom: set.windowFrom, windowTo: set.windowTo, inWindow,
      })
      : now - t0 + brk;
    // The running average moves only on a chapter the site was asked for: one found on disk cost it nothing.
    // Capped against what a chapter of this length really costs at this rate (expectedCycleMs, lane 2's arithmetic),
    // not the configured cycle: past the floor a chapter and its break outrun the hour's share, and a cap at
    // the share cut every real sample short.
    const cycle = skippedWithoutAsk ? pace?.cycle_ms ?? null
      : ewmaCycle(pace?.cycle_ms ?? null, sample, expectedCycleMs({ perHour: set.perHour, chapterMs: now - t0, minBreakMs: minBreakMs() }));
    const reason = diskFull ? 'disk'
      : out?.kind === 'failed' ? String(out.err?.blockStatus ?? classify(out.err) ?? 'failed')
      : out?.kind ?? 'error';
    // next_at is the break alone. A backoff written by backOff() above stays in backoff_until, which every gate
    // reads beside it (sourceWait, alternatesOf, the view), so the break never shortens it -- and kept apart, the
    // next chapter's cycle can tell the break (the pace) from the backoff beyond it (the site's).
    // Reintroduce by keeping only the reservation made in begin(): "a restart keeps its place and its break" in
    // archive.int.test.ts starts chapter two a minute after chapter one.
    await q(
      `INSERT INTO archive_pace (source_id, next_at, cycle_ms, last_at, last_reason) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (source_id) DO UPDATE SET next_at = EXCLUDED.next_at,
         cycle_ms = EXCLUDED.cycle_ms, last_at = EXCLUDED.last_at, last_reason = EXCLUDED.last_reason`,
      [S, new Date(nextAt), cycle, new Date(now), reason],
    ).catch((e) => deps.log.warn(`could not write the break on ${S}: ${(e as Error)?.message || e}`));
    // Every other site this chapter asked -- the one it was taken from, an alternate that failed on the way -- was
    // a request too: each rests as long.
    // Reintroduce by resting only the source it landed from: "an alternate asked inside a failed chapter" in
    // archive.int.test.ts finds the alternate free at once.
    const via = out && 'via' in out ? out.via : '';
    for (const src of new Set([...asked.keys(), via])) {
      if (!src || src === S) continue;
      await q(
        `INSERT INTO archive_pace (source_id, next_at, last_reason) VALUES ($1, $2, $3)
         ON CONFLICT (source_id) DO UPDATE SET next_at = GREATEST(EXCLUDED.next_at, archive_pace.next_at),
           last_reason = EXCLUDED.last_reason`,
        [src, new Date(nextAt), reason],
      ).catch(() => {});
    }
    await q('UPDATE archive_queue SET current_number = NULL WHERE series_id = $1', [r.series_id]).catch(() => {});
    if (diskFull) deps.log.warn(`the library disk is at the downloader's floor; the archive waits ${DISK_WAIT_MS / MIN} minutes`);
    if (gen === generation) maybeFlush(now);
    // The first chapter's mark goes with its flight; `now`, set when it was counted, holds it from here. Only this
    // generation's: after a reset the same chapter's new flight may have put its own.
    if (gen === generation) firstInFlight.delete(key);
    end(r, S, gen);
  }
}

/**
 * A chapter failed. A REFUSAL (403, 429: the site said no to us) leaves the source alone for longer each time
 * in a row, 1 h, 3 h, 12 h, then a day, never less than the server's own cooldown; a site that was down gets a
 * flat half hour. The row stays queued: a site saying "not now" is not "never", and ending the archive on it
 * is the job card's rule for a person watching, not this one's.
 * Reintroduce by skipping this write: "a refusal backs off and keeps the queue" in archive.int.test.ts starts
 * a chapter half an hour later.
 */
async function backOff(src: string, err: any): Promise<void> {
  const status = err?.blockStatus ?? classify(err);
  if (status !== 'rate_limited' && status !== 'blocked' && status !== 'down') return;
  const now = clock();
  const cur = await one<{ backoff_level: number }>('SELECT backoff_level FROM archive_pace WHERE source_id = $1', [src]);
  const h = await one<{ blocked_until: Date | null }>('SELECT blocked_until FROM source_health WHERE source_id = $1', [src]).catch(() => null);
  const refused = status !== 'down';
  const level = (cur?.backoff_level ?? 0) + (refused ? 1 : 0);
  const until = backoffUntil(level, h?.blocked_until ?? null, now, refused ? 'refused' : 'down');
  await q(
    `INSERT INTO archive_pace (source_id, backoff_level, backoff_until, last_reason) VALUES ($1, $2, $3, $4)
     ON CONFLICT (source_id) DO UPDATE SET backoff_level = $2, backoff_until = $3, last_reason = $4`,
    [src, level, new Date(until), status],
  );
}

/**
 * The alternates a chapter asked, each backed off for what it failed with, as the chosen copy's source is: a site
 * that refused on the side is left alone as long as one that refused the chosen copy. `skip`: the chosen source
 * and the failure's own `via` (their own backOff call covers them), or the source the chapter was taken from (it
 * let it through).
 * Reintroduce by backing off only the chosen source: "an alternate asked inside a failed chapter" in
 * archive.int.test.ts finds the alternate with no backoff.
 */
async function backOffAlternates(asked: Map<string, unknown>, skip: readonly string[]): Promise<void> {
  for (const [src, err] of asked) {
    if (skip.includes(src) || err === undefined) continue;
    await backOff(src, err).catch((e) => deps.log.warn(`could not back off ${src}: ${(e as Error)?.message || e}`));
  }
}

/**
 * The listing's other copies of `n` from followed sources the archive is not resting or busy on -- by rate key since
 * v0.55.4: a site on the image server the archive is resting, backing off or fetching on is that server asked on the
 * side (paceByKey). The chosen copy's own key is in flight, this chapter, so a copy on it is never an alternate.
 */
async function alternatesOf(seriesId: string, n: number, chosen: ListingCopy, followed: string[]) {
  const row = await one<{ title: string | null; copies: ListingCopy[] }>(
    'SELECT title, copies FROM series_listing WHERE series_id = $1 AND number = $2::real', [seriesId, n]).catch(() => null);
  const now = clock();
  const resting = new Set((await q<{ source_id: string }>(
    `SELECT source_id FROM archive_pace WHERE next_at > $1 OR backoff_until > $1`, [new Date(now)]).catch(() => [])).map((r) => rateKeyOf(r.source_id)));
  const free = (src: string) => {
    const key = rateKeyOf(src);
    const gate = gateDepth(key);
    return !resting.has(key) && !keyInFlight(key) && gate.active + gate.queued === 0 && !refusedLately(src);
  };
  const open = await automaticCopiesFor(seriesId, row?.copies ?? []);
  return open
    .filter((c) => c.source !== chosen.source && followed.includes(c.source) && free(c.source))
    .map((c) => copyToChapter(c, { number: n, title: row!.title }));
}

/** Nothing left to fetch below the boundary: done, with what was left behind and why. */
async function finishSeries(seriesId: string, now: number): Promise<boolean> {
  const note = await one<DoneNote>(
    `SELECT count(*) FILTER (WHERE l.status = 'available')::int AS capped,
            count(*) FILTER (WHERE l.status = 'held')::int AS held,
            count(*) FILTER (WHERE l.status = 'blocked')::int AS blocked
       FROM series_listing l JOIN archive_queue a ON a.series_id = l.series_id
      WHERE l.series_id = $1 AND l.number < a.boundary
        AND NOT ${noticeListed('l')}
        AND NOT EXISTS (
          SELECT 1 FROM lib_books b LEFT JOIN book_overrides ov ON ov.book_id = b.id
           WHERE b.series_id = l.series_id AND ${holds('b', 'ov', 'l.number')} AND ${heldBooks('b')})`,
    [seriesId]);
  // One statement: the row ends and, when the series' floor is still the one the archive started from, the
  // floor goes with it -- nothing is left below it for it to keep out of the sweep, and the capped numbers are
  // the repair's weekly retry's to bring back. A floor someone changed since is theirs and stays.
  // Reintroduce by leaving the row queued: "done with gaps" in archive.int.test.ts never finishes.
  const r = await one<{ ended: number }>(
    `WITH done AS (
       UPDATE archive_queue SET state = 'done', finished_at = $2, note = $3::jsonb, current_number = NULL
        WHERE series_id = $1 AND state = 'queued' RETURNING series_id, floor_at_start),
     floor AS (
       UPDATE lib_series s SET chapter_floor = NULL FROM done
        WHERE s.id = done.series_id AND done.floor_at_start IS NOT NULL AND s.chapter_floor::real = done.floor_at_start
        RETURNING s.id)
     SELECT (SELECT count(*) FROM done)::int AS ended`,
    [seriesId, new Date(now), JSON.stringify({ capped: note?.capped ?? 0, held: note?.held ?? 0, blocked: note?.blocked ?? 0 })],
  );
  const ended = (r?.ended ?? 0) > 0;
  if (ended) {
    lastWaits.delete(seriesId);
    sourceOf.delete(seriesId);
    rotating.delete(seriesId);
    invalidateArchiveView();
  }
  return ended;
}

// ── scanning what landed ──────────────────────────────────────────────────────────────────────────────────────

async function noteUnscanned(seriesId: string, folder: string, n: number, item: { landed?: Landed; publishedAt?: string; newRow?: boolean }, now: number): Promise<void> {
  let u = unscanned.get(seriesId);
  if (!u) { u = { folder, firstAt: now, items: new Map() }; unscanned.set(seriesId, u); }
  if (item.newRow === undefined) {
    // Found on disk rather than landed here: whether it adds a row is asked of the library now.
    const had = await one('SELECT 1 FROM lib_books WHERE series_id = $1 AND number = $2::real LIMIT 1', [seriesId, n]).catch(() => null);
    item = { ...item, newRow: !had };
  }
  u.items.set(n, { landed: item.landed, publishedAt: item.publishedAt, newRow: item.newRow ?? false });
}

/**
 * A series' first chapter from the archive, from before it is fetched (firstInFlight) until the scan it starts when it
 * lands is done (`now`, runChapter). The downloads view lists it only once the library holds it (routes/sources.ts
 * activityFor): a library scan takes seconds on a large library, and listed at once it put a tile with no cover in
 * Came in today, and the series page re-read its chapters on the landing and still found none (v0.49.1). A later
 * chapter, or the first of a series the library already holds, waits for its batch in plain sight, as before.
 */
export function archiveScanPending(folder: string, number: number): boolean {
  if (firstInFlight.has(flightKey(folder, number))) return true;
  for (const u of unscanned.values()) if (u.folder === folder && u.items.get(number)?.now) return true;
  return false;
}

/** Scan when five chapters are waiting, or the oldest has waited twenty minutes. */
function maybeFlush(now: number): void {
  let count = 0;
  let oldest = Infinity;
  for (const u of unscanned.values()) { count += u.items.size; oldest = Math.min(oldest, u.firstAt); }
  if (count && (count >= SCAN_BATCH || now - oldest >= SCAN_WAIT_MS)) void track(flushArchiveScan());
}

let flushing: Promise<void> | null = null;

/**
 * Scan what the archive landed into the library, then stamp it as the sweep stamps what it lands: release dates,
 * group and source, and the source chapter it came from (lib_books.source_chapter_id, through setBookMeta and
 * Landed.chapterId, so a later renumber, #116, matches the file exactly). Serialised; a call during one waits for
 * it and then scans again.
 *
 * ⚠️ AND RAISE THE UPDATES BASELINE by exactly the rows the scan added. /api/updates counts a favourite's
 * chapters minus what its reader has seen (series_seen), so without this a favourite being archived would read
 * "+96 new" every morning for a back catalogue nobody asked to be told about. Raised by the archive's own new
 * rows only, so a real release the sweep landed beside them still counts; and never past the series' count.
 * No push and no digest for them either: nothing here calls notifyNewChapter or sendDigest.
 * Reintroduce by dropping the series_seen update: "archived chapters are not updates" in archive.int.test.ts
 * sees the new count rise.
 */
export function flushArchiveScan(): Promise<void> {
  const prev = flushing;
  const next = (async () => {
    if (prev) await prev.catch(() => {});
    if (!unscanned.size) return;
    const gen = generation;
    const batch = [...unscanned.entries()].map(([sid, u]) => [sid, { ...u, items: new Map(u.items) }] as const);
    await persistScan().catch((e) => deps.log.warn(`the library scan after archived chapters threw: ${(e as Error)?.message || e}`));
    for (const [seriesId, u] of batch) {
      const nums = [...u.items.keys()];
      const items = [...u.items.values()];
      await setBookDates(u.folder, nums.flatMap((n) => (u.items.get(n)?.publishedAt ? [{ number: n, publishedAt: u.items.get(n)!.publishedAt }] : []))).catch(() => {});
      await setBookMeta(u.folder, items.flatMap((i) => (i.landed ? [i.landed] : []))).catch(() => {});
      const unindexed = new Set(await notInLibrary(u.folder, nums).catch(() => [] as number[]));
      if (unindexed.size && gen === generation) {
        const set = stuck.get(seriesId) ?? new Set<number>();
        for (const n of unindexed) set.add(n);
        stuck.set(seriesId, set);
        deps.log.warn(`${unindexed.size} archived chapter(s) of ${u.folder} are on disk but the library scan did not add them; Admin -> Health lists them`);
      }
      const fresh = nums.filter((n) => u.items.get(n)?.newRow && !unindexed.has(n)).length;
      if (fresh) {
        await q(
          `UPDATE series_seen ss SET seen_books_count = LEAST(ss.seen_books_count + $2, s.books_count)
             FROM lib_series s WHERE ss.series_id = $1 AND s.id = ss.series_id`,
          [seriesId, fresh],
        ).catch((e) => deps.log.warn(`could not raise the Updates baseline of ${u.folder}: ${(e as Error)?.message || e}`));
      }
      if (gen === generation) {
        const live = unscanned.get(seriesId);
        if (live) { for (const n of nums) live.items.delete(n); if (!live.items.size) unscanned.delete(seriesId); }
      }
    }
    // The shared rows counted `left` before these were in the library; the view subtracts what is still unscanned.
    invalidateArchiveView();
  })();
  flushing = next;
  void next.finally(() => { if (flushing === next) flushing = null; }).catch(() => {});
  return next;
}

// ── the loop ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Look again soon: after a chapter, an enqueue, a pause, a settings change. Coalesced into one tick. */
function kick(): void {
  if (!started) return;
  atRoot(() => arm(Math.max(250, firstLookAt - Date.now())));
}

function arm(delay: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void archiveTick().then(
      () => { if (started && !timer) arm(tickMs()); },
      (e) => { deps.log.error(e); if (started && !timer) arm(tickMs()); },
    );
  }, delay);
  timer.unref?.();
}

/**
 * At boot: nothing is in flight in a process that has just started, so a `current_number` left by the last one
 * is a chapter that died with it. Its break was reserved before it started (`begin`), so it is not retried early.
 */
export async function archiveBoot(): Promise<void> {
  await q('UPDATE archive_queue SET current_number = NULL WHERE current_number IS NOT NULL').catch(() => {});
}

/**
 * Start the scheduler (server.ts, owned mode). The first look waits ten minutes after a boot, like the sweep, so
 * a restart loop cannot become a burst and a server that has just started answers readers first (three on
 * desktop, which is only on while someone uses it); ARCHIVE_FIRST_RUN_MS is the e2e rig's. It never starts before
 * a persisted break or backoff has run out either: those are gates in every tick.
 */
export function startArchive(d: { busy: (folder: string) => boolean; log: ArchiveLog }): void {
  deps = d;
  started = true;
  const raw = process.env.ARCHIVE_FIRST_RUN_MS;
  const first = raw !== undefined && raw.trim() !== '' && Number.isFinite(Number(raw))
    ? Math.max(0, Number(raw)) : firstRunFloor(10 * MIN, 'archive');
  firstLookAt = Date.now() + first;
  void track(archiveBoot());
  d.log.info(`archive: first look in ${Math.round(first / 1000)} s`);
  atRoot(() => arm(first));
}

// ── what a viewer is shown ────────────────────────────────────────────────────────────────────────────────────

interface SharedRow {
  seriesId: string; title: string; folder: string; state: 'queued' | 'paused' | 'done'; direction: ArchiveDirection;
  done: number; failed: number; bytes: number; left: number | null; addedBy: string | null; primary: string | null;
  createdAt: number; startedAt: number | null; finishedAt: number | null; lastAt: number | null;
  note: (Partial<DoneNote> & QueuedNote & { pausedAt?: string }) | null;
  /** The numbers `left` counts: compose() takes a chapter waiting for its scan off `left` only while it is one of them. */
  leftNumbers: number[];
}
let viewCache: { at: number; rows: SharedRow[]; pace: Map<string, PaceRow>; settings: ArchiveSettings } | null = null;
export function invalidateArchiveView(): void { viewCache = null; }

/** Every archive row, unfiltered, read at most every ten seconds. Never handed to a viewer as it is. */
async function sharedRows(): Promise<NonNullable<typeof viewCache>> {
  const now = clock();
  if (viewCache && now - viewCache.at < VIEW_TTL_MS) return viewCache;
  const rows = await q<any>(
    `SELECT a.series_id, s.title, s.folder, a.state, a.direction, a.done_count, a.failed_count, a.bytes, a.added_by, s.source_id,
            a.created_at, a.started_at, a.finished_at, a.last_at, a.note,
            CASE WHEN a.state = 'done' OR a.boundary IS NULL THEN NULL ELSE ARRAY(
              SELECT l.number FROM series_listing l WHERE l.series_id = a.series_id AND ${eligibleSql('l', 'a', '$1')}) END AS left_numbers
       FROM archive_queue a JOIN lib_series s ON s.id = a.series_id
      WHERE ${visibleToAll('s')}
      ORDER BY a.created_at, a.series_id`,
    [CHAPTER_RETRY_CAP],
  );
  const shared: SharedRow[] = rows.map((r) => ({
    seriesId: r.series_id, title: r.title, folder: r.folder, state: r.state, direction: r.direction,
    done: Number(r.done_count) || 0, failed: Number(r.failed_count) || 0, bytes: Number(r.bytes) || 0,
    left: r.left_numbers == null ? null : r.left_numbers.length, addedBy: r.added_by, primary: r.source_id,
    createdAt: ms(r.created_at) ?? now, startedAt: ms(r.started_at), finishedAt: ms(r.finished_at), lastAt: ms(r.last_at), note: r.note,
    leftNumbers: r.left_numbers ?? [],
  }));
  const pace = new Map((await q<PaceRow>('SELECT source_id, next_at, backoff_level, backoff_until, cycle_ms, last_at FROM archive_pace')
    .catch(() => [])).map((p) => [p.source_id, p]));
  viewCache = { at: now, rows: shared, pace, settings: await archiveSettings() };
  return viewCache;
}

export interface ArchiveSeriesView {
  seriesId: string; title: string; state: 'queued' | 'paused' | 'done'; direction: ArchiveDirection;
  done: number; left: number | null; failed: number; bytes: number;
  current?: { number: number; startedAt: string };
  nextAt?: string; etaMs?: number;
  waiting?: { why: SeriesWait['why']; until?: string; source?: string };
  attention?: { why: Attention['why']; since: string };
  queuedAt: string; startedAt: string | null; finishedAt?: string; note?: DoneNote;
}
export interface ArchiveView {
  paused: boolean; perHour: number; window: { from: number; to: number } | null;
  waiting?: { why: GlobalWait['why']; until?: string };
  series: Array<ArchiveSeriesView & { mine: boolean }>;
}

const iso = (t: number | null | undefined): string | undefined => (t == null ? undefined : new Date(t).toISOString());

/** One shared row with the scheduler's memory folded in: what is in flight, why it waits, when it next goes. */
function compose(
  r: SharedRow, c: NonNullable<typeof viewCache>, queuedOn: Map<string, number>, now: number, keyPace: Map<string, KeyPace>,
): (ArchiveSeriesView & { addedBy: string | null }) | null {
  const src = sourceOf.get(r.seriesId) ?? r.primary ?? null;
  const pace = src ? c.pace.get(src) : undefined;
  // The rate keys its next chapter may come from (v0.55.4): every site of the same release it rotates over, else its
  // one source's. It goes when the first of them is free, takes a share of each one's hour, and is backing off only
  // while every one of them is -- one site refusing while another carries on is not worth a look.
  // Reintroduce by reading the one source's row: "a series that rotates backs off only when every site does" in
  // archive.int.test.ts puts it under Needs attention while the other site carries on.
  const keys = [...new Set(((r.state === 'queued' ? rotating.get(r.seriesId) : undefined) ?? (src ? [src] : [])).map(rateKeyOf))];
  const kps = keys.map((k) => keyPace.get(k));
  const flight = [...flights.values()].find((f) => f.seriesId === r.seriesId && f.number != null);
  const w = r.state === 'queued' ? lastWaits.get(r.seriesId) : undefined;
  const pausedAt = r.note?.pausedAt ? Date.parse(r.note.pausedAt) : null;
  const note = r.state === 'done' && r.note ? { capped: r.note.capped ?? 0, held: r.note.held ?? 0, blocked: r.note.blocked ?? 0 } : undefined;
  const progressAt = r.state === 'queued' ? Date.parse(r.note?.progressAt ?? '') : NaN;
  const attention = attentionOf({
    state: r.state, now, failed: r.failed, note, finishedAt: r.finishedAt, pausedAt: Number.isFinite(pausedAt) ? pausedAt : null,
    backoffLevel: kps.length ? Math.min(...kps.map((p) => p?.backoffLevel ?? 0)) : 0, backoffSince: ms(pace?.last_at),
    wait: w?.wait ?? null, waitSince: w?.since ?? null,
    global: r.state === 'queued' ? lastGlobal?.wait ?? null : null,
    progressSince: Number.isFinite(progressAt) ? progressAt : r.createdAt, idleTurns: Number(r.note?.idleTurns) || 0,
  });
  if (!shownDone({ state: r.state, finishedAt: r.finishedAt, attention, now })) return null;
  // When it next goes: the end of its source's break or backoff -- the first to end of its keys' -- or its own listing
  // ladder when that is what it waits on.
  const restEnd = (p: KeyPace | undefined) => Math.max(p?.nextAt ?? 0, p?.backoffUntil ?? 0);
  const nextAtMs = r.state === 'queued'
    ? Math.max(kps.length ? Math.min(...kps.map(restEnd)) : 0, w?.wait.why === 'listing' ? w.wait.until ?? 0 : 0)
    : 0;
  // Before the source has a running average, what a typical chapter costs at this rate (lane 2's expectedCycleMs,
  // which the web's own estimate mirrors, web/lib/archive.ts), not the hour's bare share.
  const cyc = pace?.cycle_ms ?? expectedCycleMs({ perHour: c.settings.perHour, chapterMs: TYPICAL_CHAPTER_MS, minBreakMs: minBreakMs() });
  // Landed and not scanned yet is not left: the library does not hold it until the batch scan, and "1 of 15" over
  // a series that has all fourteen of its chapters on disk read as work to come (#117 review).
  // Reintroduce by answering the stored count: "left counts what is still to come" in archive.int.test.ts.
  // Taken off only while `left` still counts it, by its number: the scan puts a chapter in the library before
  // flushArchiveScan lets it go, and rows read in between no longer count it. Taken off by how many waited, it went
  // twice there, and a series' first chapter, which is scanned in at once, read "1 of 13" of its 14 (v0.49.1 final walk).
  // Reintroduce by subtracting how many wait: "in the library and still waiting" in archive.int.test.ts reads 1 of 13.
  const waiting = unscanned.get(r.seriesId)?.items;
  const left = r.left == null ? null : r.left - (waiting ? r.leftNumbers.filter((n) => waiting.has(n)).length : 0);
  // Calendar time, not running time: the running average leaves the hours outside the window out
  // (outsideCycleMs), so an ETA from it alone read "about a day" for what a 01:00-07:00 window takes four to do.
  const share = openShare(c.settings.windowFrom, c.settings.windowTo);
  return {
    seriesId: r.seriesId, title: r.title, state: r.state, direction: r.direction,
    done: r.done, left, failed: r.failed, bytes: r.bytes, addedBy: r.addedBy,
    ...(flight ? { current: { number: flight.number!, startedAt: iso(flight.startedAt)! } } : {}),
    ...(nextAtMs > now && !flight ? { nextAt: iso(nextAtMs) } : {}),
    ...(r.state !== 'done' && left != null
      ? { etaMs: Math.round(etaMs({ left, sharing: (src && queuedOn.get(src)) || 1, cycleMs: cyc }) / Math.max(1, keys.length) / share) } : {}),
    ...(w ? { waiting: { why: w.wait.why, ...(w.wait.until ? { until: iso(w.wait.until) } : {}), ...(w.wait.source ? { source: w.wait.source } : {}) } } : {}),
    ...(attention ? { attention: { why: attention.why, since: iso(attention.since)! } } : {}),
    queuedAt: iso(r.createdAt)!, startedAt: iso(r.startedAt) ?? null,
    ...(r.finishedAt ? { finishedAt: iso(r.finishedAt) } : {}),
    ...(note ? { note } : {}),
  };
}

/** The ids of every archive row, for the caller's one browsable() query over them (routes/sources.ts). */
export async function archiveSeriesIds(): Promise<string[]> {
  return (await sharedRows()).rows.map((r) => r.seriesId);
}

/**
 * The `archive` object of GET /api/sources/jobs (and GET /api/sources/archive): the settings a viewer needs to
 * read the rows, the server-wide wait, and the rows `mayBrowse` lets through. The same rule as the view's cards
 * and activity (browsable(), by series id), applied after the shared cache, on every call (archivePlan.rowsFor).
 */
export async function archiveView(mayBrowse: (seriesId: string) => boolean, me: string | null): Promise<ArchiveView> {
  const c = await sharedRows();
  const now = clock();
  const queuedOn = new Map<string, number>();
  for (const r of c.rows) {
    if (r.state !== 'queued') continue;
    const src = sourceOf.get(r.seriesId) ?? r.primary;
    if (src) queuedOn.set(src, (queuedOn.get(src) ?? 0) + 1);
  }
  const keyPace = paceByKey(c.pace.values());
  const rows = c.rows.map((r) => compose(r, c, queuedOn, now, keyPace)).filter((x): x is NonNullable<typeof x> => !!x);
  const s = c.settings;
  // What the last look concluded, unless the settings have moved on since: a 'paused' left from before a Resume all
  // (or a window since cleared) lingered on the view until the next look (#117 review).
  const g = shownGlobalWait({ paused: s.paused, windowFrom: s.windowFrom, windowTo: s.windowTo }, lastGlobal?.wait ?? null);
  return {
    paused: s.paused, perHour: s.perHour,
    window: s.windowFrom != null && s.windowTo != null && s.windowFrom !== s.windowTo ? { from: s.windowFrom, to: s.windowTo } : null,
    ...(g ? { waiting: { why: g.why, ...(g.until ? { until: iso(g.until) } : {}) } } : {}),
    series: rowsFor(rows, mayBrowse, me),
  };
}

/**
 * The series page's line (GET /api/series/:id/listing `archive`): its one row, or null. The route has already
 * checked the viewer may see the series.
 */
export async function archiveSummaryFor(seriesId: string, me: string | null): Promise<{
  state: string; done: number; left: number | null; failed: number; etaMs?: number; nextAt?: string;
  waiting?: ArchiveSeriesView['waiting']; attention?: ArchiveSeriesView['attention']; mine: boolean;
  pausedForAll: boolean;
} | null> {
  const v = await archiveView((id) => id === seriesId, me);
  const r = v.series.find((x) => x.seriesId === seriesId);
  if (!r) return null;
  return {
    state: r.state, done: r.done, left: r.left, failed: r.failed, mine: r.mine,
    // The admin's pause of every archive, which a queued row's state does not show. The page reads it from the queue
    // (GET /api/sources/jobs), which a viewer who may not download is refused, and their run row said "being archived
    // slowly" under it (v0.49.1). Reintroduce by leaving it out: "the series page" in archiveRoutes.int.test.ts finds
    // the line silent about it.
    pausedForAll: v.paused,
    ...(r.etaMs !== undefined ? { etaMs: r.etaMs } : {}), ...(r.nextAt ? { nextAt: r.nextAt } : {}),
    ...(r.waiting ? { waiting: r.waiting } : {}), ...(r.attention ? { attention: r.attention } : {}),
  };
}
