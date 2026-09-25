/**
 * The nightly library repair: everything the Health page could only report, done.
 *
 * WHY IT EXISTS
 *   The owner, looking at Admin -> Health on their own server: "do we have any implementations that auto
 *   fix these issues?" The page said "Suspiciously short chapters 14", "Chapter gaps 40", "Chapters that
 *   would not download 183", "Cloudflare solver: 4 sources failed inside it" -- every one of them a finding
 *   with no button behind it, several of them months old. This job is the button, run once a night.
 *
 * WHAT IT WILL AND WILL NOT DO
 *   Five steps, in this order: the solver, page counts, capped download failures, short chapters, gaps.
 *   Each one is either REVERSIBLE (a stamp, a cooldown cleared, a chapter fetched) or PROVABLE (a short
 *   chapter is replaced only when another copy is measurably longer, and marked "this really is two pages"
 *   only when every copy answered and the search found nothing).
 *
 *   ⚠️ It never removes a file, never writes a tombstone, never merges two series and never renumbers a
 *   chapter. Duplicate series and impossible chapter numbers stay one-click actions an admin confirms, by
 *   decision: those four operations are the ones this project cannot undo, and a job that runs while
 *   nobody is watching must not be able to take them. A static test greps this file for the calls that
 *   would (test/repair.int.test.ts, "the nightly cannot delete, merge or renumber anything").
 *
 *   ⚠️ No container access, ever. "Restart the solver" is not available to this process and must not
 *   become available: the app can reset only what it itself remembers about the solver
 *   (resetSolverSessions) and what it wrote into source_health.
 *
 * LOAD
 *   Every step is bounded by a named constant or a documented environment knob, and several steps cost no
 *   network call at all. Per run, at most: REPAIR_COUNT_MAX archives opened on our own disk; one listing
 *   refresh plus at most REPAIR_SHORT_COPIES page lists (one per SOURCE), one search and one download for
 *   each of at most REPAIR_SHORT_MAX short chapters; one search and REPAIR_GAP_CHAPTERS downloads for each
 *   of at most REPAIR_GAPS_MAX series; REPAIR_HUNT_BUDGET searches for the whole run, shared between the
 *   steps but with at most REPAIR_SHORT_HUNT_MAX of them spendable by the short step, so the two hunting
 *   steps cannot starve each other. Every "checked" stamp is written BEFORE the network call it describes,
 *   so a crash mid-step never makes the same series the first thing tomorrow's run does again -- and a
 *   step with no searches left stops rather than stamp a series it cannot search.
 *
 * It is DETACHED from its route, like the sweep, the cleanup and the verify: the work is minutes, and a
 * request that long dies at the reverse proxy while the job keeps going. The route answers `started`, the
 * Tasks panel polls `running`, and the result lives in `repairState` for this process and in
 * server_settings.repair_last_run / repair_last_result for the next one.
 */
import { join } from 'path';
import { q, one } from './db';
import { runtime } from './runtime';
import { logAudit } from './audit';
import { containedPath } from './fsGuard';
import { countPages } from './pageCount';
import { haveNumbers } from './libraryNumbers';
import { DL_ROOT, persistScan, setBookDates, setBookMeta } from './library';
import { restampBook } from './partial';
import { chapterFileRel, downloadChapter, type DownloadInput } from './downloader';
import { getSource, withTimeout, type SourceChapter } from './sources';
import { budgetFor } from './sources/budget';
import { resetSolverSessions, solverPing } from './sources/flaresolverr';
import { blockedNow, clearBlock, isDisabled } from './sourceHealth';
import { copyToChapter, type ListingCopy } from './seriesListing';
import { busyFolders } from './bulkNewest';
import { updateSeries, CHAPTER_RETRY_CAP, type Landed } from './updater';
import { huntCandidates, huntSource, followHunted, seriesIsAdult, sweepAllowedFor } from './sourceHunt';
import { assess, gapsOf } from './fill';
// The Health page's own query for "which sources blame the solver", shared rather than copied: the solver
// step clears state only when something is really failing inside the solver, and that must be the same
// question the page answers or the button and the page disagree about whether there is anything to do.
import { solverBlaming } from './health';
import { visibleToAll } from './visibility';

/** Which of the five steps to run. `only` on the options picks a subset; the nightly runs them all. */
export type RepairStep = 'solver' | 'count' | 'failures' | 'short' | 'gaps';

/** In the order the run takes them, which is also the order a caller's `only` is reported in. */
export const REPAIR_STEPS: readonly RepairStep[] = ['solver', 'count', 'failures', 'short', 'gaps'];

/**
 * An integer knob from the environment, clamped. Out-of-range, unparseable and absent all fall back to the
 * default rather than to zero: a mistyped `REPAIR_COUNT_MAX=two thousand` must not silently switch a step
 * off, which is the failure mode a bare `Number(...) || 0` has.
 */
function envInt(name: string, def: number, lo: number, hi: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, Math.floor(n))) : def;
}

/** How often the nightly runs, counted from the END of the last completed run. server.ts owns the timer. */
export const REPAIR_HOURS = envInt('REPAIR_HOURS', 24, 1, 168);
/**
 * Chapter files whose pages one run counts. 2000 is about a minute of local disk on this install and drains
 * its 30,625 uncounted rows in a fortnight of nights; the point of a cap at all is that the count step runs
 * beside four other steps and must not be able to own the whole night.
 */
export const REPAIR_COUNT_MAX = envInt('REPAIR_COUNT_MAX', 2000, 1, 100_000);
/** Short chapters one run investigates. Each costs the sources up to three page lists and one download. */
export const REPAIR_SHORT_MAX = envInt('REPAIR_SHORT_MAX', 20, 1, 500);
/** Series one run searches other sources for, to fill a gap. Deliberately tiny: each one is a real search. */
export const REPAIR_GAPS_MAX = envInt('REPAIR_GAPS_MAX', 5, 1, 100);
/**
 * The pause between two series the failures step retries, as the sweep paces itself. Tests set it to 0.
 *
 * envInt cannot serve this one: zero is a legitimate value here and envInt rejects it. ⚠️ A typo must not
 * be read as zero either. This is the one knob that paces requests at the very moment they are riskiest --
 * up to ten series re-checked against a source that has just been refusing us -- and `Number('1.5s') || 0`
 * would silently remove the pause entirely (updater.ts:414 records what one unpaced burst costs: five
 * failures in 74 s, and a 15-minute cooldown escalated to 75).
 */
const REPAIR_PACE_MS = ((): number => {
  const raw = process.env.REPAIR_PACE_MS;
  // An unset knob and one set to nothing (`REPAIR_PACE_MS=`, or a stray space) are the same wish: the
  // default. Only a real number, zero included, turns the pause down.
  if (raw === undefined || !raw.trim()) return 1500;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1500;
})();

/** Chapters a gap fetch may download for one series, so one series with a 200-chapter hole is not the night. */
const REPAIR_GAP_CHAPTERS = 20;
/** Searches the WHOLE run may start, shared by the short step, the gap step and the failures retry. */
const REPAIR_HUNT_BUDGET = 5;
/**
 * Of those, the most the SHORT step may spend, so the two hunting steps cannot starve each other.
 *
 * ⚠️ A shared pot alone is not fair when one step runs first. The short step runs before the gap step and
 * hunts once per short series, so a library with five short series spent the whole budget before the gap
 * step -- the headline step, and the one the owner was looking at -- had asked anything. The gap step now
 * keeps at least REPAIR_HUNT_BUDGET - REPAIR_SHORT_HUNT_MAX searches whatever the short step does, and
 * takes the rest when the short step leaves it. Reversing the two step orders would only move the
 * starvation onto the short step; a reserve is the fix that has no victim.
 */
const REPAIR_SHORT_HUNT_MAX = 2;
/** Ledger rows the nightly gives a second chance to. */
const REPAIR_FAILURES_MAX = 100;
/** Series the on-demand "retry this source" re-checks after resetting its ledger rows. */
const REPAIR_RETRY_SERIES = 10;
/** Copies of a short chapter that get asked for their page count, serving copy first. */
const REPAIR_SHORT_COPIES = 3;
/** How many archives the count step opens at once. Local disk, so this is I/O width and nothing else. */
const COUNT_CONCURRENCY = 8;
/** One copy's page list. Raised by budgetFor for a source behind the solver. */
const SHORT_PAGES_MS = 20_000;
/** The listing refresh before a series' short chapters are judged, as the refetch route bounds its own. */
const LISTING_REFRESH_MS = 10_000;
/** How long after a cooldown has lapsed the escalation memory is wiped as well. See the solver step. */
const EXPIRED_BLOCK_HOURS = 24;

export interface RepairOpts {
  /** Run only these steps. Absent (or empty) means all five, in REPAIR_STEPS order. */
  only?: RepairStep[];
  /** Gaps step only: this series alone, and its once-a-day stamp is ignored. */
  seriesId?: string;
  /** Short step only: this chapter alone, and its hunt is forced past the once-a-day stamp. */
  bookId?: string;
  /** Failures step only: this source's ledger rows are reset whatever their age, then its series retried. */
  sourceId?: string;
  /**
   * Who asked. Absent means NOBODY asked -- the nightly tick -- which is the one case that honours the
   * `repair_enabled` switch. An admin pressing Run now passes their id and the run happens whatever the
   * switch says: the switch exists to stop the server doing this by itself, and nothing here destroys
   * anything, so refusing a deliberate press would be a puzzle with no upside.
   */
  userId?: string | null;
}

export interface RepairResult {
  ok: true;
  ms: number;
  /** Echoed when the caller asked for a subset, so the Tasks panel can say which run this was. */
  only?: RepairStep[];
  /** Chapter files whose page count was stamped this run (0 counts as counted: see lib/pageCount.ts). */
  counted: number;
  /** Chapter files still waiting for a count when the run ended. */
  uncounted: number;
  short: {
    /** Short chapters investigated. */
    looked: number;
    /** Replaced with a longer copy from a source that has one. */
    replaced: number;
    /** Proven to be what every source holds, so the Health page stops reporting them. */
    confirmed: number;
    /** Neither: a copy could not be reached, or a download failed. Tomorrow's run tries again. */
    left: number;
  };
  gaps: {
    /** Series looked at. */
    series: number;
    /** Of those, ones where a new source was followed because it brackets the hole. */
    followed: number;
    /** Chapters that landed inside a gap. */
    fetched: number;
    /** Gap chapters no reachable source lists: the honest "nobody has these". */
    unfillable: number;
    /** Gap chapters a followed source already lists, which the ordinary sweep will fetch. */
    sweep: number;
  };
  failures: {
    /** Ledger rows put back to zero attempts. */
    reset: number;
    /** Only for an on-demand run against one source. */
    retried?: { series: number; added: number; failed: number };
  };
  solver: {
    /** Whether the in-process solver state was cleared (it answered, and sources were blaming it). */
    reset: boolean;
    /** Sources whose cooldown was cleared because their failure named the solver. */
    unblocked: number;
    /** Cooldowns that lapsed more than a day ago and whose escalation memory was wiped with them. */
    expired: number;
  };
  /** The nightly switch is off and nobody asked for this run. */
  skipped?: 'disabled';
  /** The run ended early: the server is going down, or the download disk is at its floor. */
  stopped?: 'shutdown' | 'disk';
}

/**
 * This process's view of the job, for the Tasks panel between polls. The persisted row is the source of
 * truth across a restart; this is what makes "running" answerable at all.
 */
export const repairState: {
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  lastResult: RepairResult | null;
} = { running: false, startedAt: null, finishedAt: null, lastResult: null };

type Log = { info: (m: string) => void; warn: (m: string) => void; error: (m: unknown) => void };

/** Work the post-run scan owes: what landed, so setBookDates/setBookMeta can stamp the rows it mints. */
type Dated = { folder: string; chapters: SourceChapter[]; landed: Landed[] };

/** The lists that go into the audit row, so "what did it actually touch" is answerable without the logs. */
type Notes = { replaced: string[]; confirmed: string[]; followed: string[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** verifyFiles.ts's pool, copied rather than shared because it is four lines and importing a task from a task is worse. */
async function mapLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

/** "1, 3-7, 12" from [1,3,4,5,6,7,12]: how the Health page already writes a set of chapter numbers. */
function rangeText(nums: number[]): string[] {
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push(sorted[i] === sorted[j] ? String(sorted[i]) : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return out;
}

// ── the five steps ──────────────────────────────────────────────────────────────────────────────────────

/**
 * (e) The solver. Costs zero requests to any site.
 *
 * Two different repairs, and only one of them needs the solver to be alive. If the solver answers its ping
 * but sources keep failing INSIDE it, what this process remembers about it is stale: a `cf_clearance`
 * cookie Cloudflare has since rotated is re-sent with every image request until a restart, and an origin
 * stamped unsolvable is not re-solved for hours however healthy it has become. Clearing both, plus the
 * cooldowns those failures earned, is what "restart the solver" used to achieve by accident.
 *
 * The expired-cooldown sweep is unconditional and is not about the solver at all: a block whose
 * `blocked_until` lapsed more than a day ago keeps `status` and `consecutive` set, and `consecutive` is
 * what escalates the NEXT cooldown from 15 minutes to 75. A day of quiet should reset that escalation.
 * ⚠️ A day, not "lapsed at all": a source that refuses us every single night must keep its memory, or the
 * nightly would hand it a clean slate a few hours before it earns the same block again.
 */
async function stepSolver(r: RepairResult, log?: Log): Promise<void> {
  const ping = await solverPing();
  const blaming = await solverBlaming();
  if (ping.ok && blaming.length) {
    const cleared = resetSolverSessions();
    r.solver.reset = true;
    for (const id of blaming) {
      await clearBlock(id).catch(() => {});
      r.solver.unblocked++;
    }
    log?.info(`repair: solver answered, ${blaming.length} source(s) blaming it -- cleared ${cleared.sessions} session(s), `
      + `${cleared.unsolvable} unsolvable origin(s) and ${r.solver.unblocked} cooldown(s)`);
  } else if (!ping.ok && blaming.length) {
    // Nothing is cleared while the solver is down: the cookies would be re-earned by a solve that cannot
    // happen, and clearing the cooldowns would send every source straight back at a site it cannot reach.
    log?.warn(`repair: the solver is not answering (${ping.error || 'unreachable'}); `
      + `${blaming.length} source(s) blame it and nothing was reset -- this one is for the operator`);
  }
  const expired = await q<{ source_id: string }>(
    `UPDATE source_health SET status = 'ok', consecutive = 0, blocked_until = NULL, updated_at = now()
      WHERE blocked_until < now() - ($1 || ' hours')::interval AND status <> 'ok'
      RETURNING source_id`, [String(EXPIRED_BLOCK_HOURS)],
  ).catch(() => []);
  r.solver.expired = expired.length;
}

/**
 * (a) Page counts. Costs zero requests to any site: every read is of our own disk.
 *
 * `lib_books.pages` is stamped when somebody opens a chapter, so on this install 30,625 of 43,253 rows had
 * never been counted -- which is why the short-chapter check could only ever see the chapters people had
 * already read. This walks the queue newest file first (the partial index in lib/migrate.ts is that exact
 * order), opens each archive through cbzPages and stamps the answer.
 *
 * ⚠️ `AND pages = 0` on the UPDATE. Between the SELECT and the write, a reader can open the very chapter
 * being counted and stamp a count of their own from the same file -- and theirs is the fresher fact. The
 * guard is what makes this job a filler of blanks rather than a writer of counts.
 * ⚠️ `page_dims` is never touched here. It is a cache of every page's WIDTH AND HEIGHT, which this step
 * does not measure; writing it from a page count would tell the reader a 40-page chapter is 40 pages of
 * unknown size and take out every layout decision the reader makes.
 */
async function stepCount(r: RepairResult, log?: Log): Promise<void> {
  const rows = await q<{ id: string; root: string; file: string }>(
    `SELECT id, root, file FROM lib_books
      WHERE pages = 0 AND pages_checked_at IS NULL AND pruned_at IS NULL
      ORDER BY mtime DESC LIMIT $1`, [REPAIR_COUNT_MAX],
  );
  await mapLimit(rows, COUNT_CONCURRENCY, async (b) => {
    if (runtime.stopping) return;
    // A path that escapes its root is not a chapter to count; it is something for the health page. Left
    // unstamped as well as uncounted, exactly as the verify task leaves it out of `checked`.
    const abs = containedPath(b.root, b.file);
    if (!abs) return;
    const pages = await countPages(abs);
    const done = await q(
      'UPDATE lib_books SET pages = $1, pages_checked_at = now() WHERE id = $2 AND pages = 0 RETURNING id',
      [pages, b.id],
    ).catch(() => []);
    if (done.length) r.counted++;
  });
  const left = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM lib_books WHERE pages = 0 AND pages_checked_at IS NULL AND pruned_at IS NULL`,
  ).catch(() => null);
  r.uncounted = left?.n ?? 0;
  if (r.counted) log?.info(`repair: ${r.counted} chapter file(s) counted, ${r.uncounted} still to count`);
}

/**
 * (d) Download failures that hit the retry cap. Costs zero requests by itself; the retry costs a sweep.
 *
 * A chapter that failed CHAPTER_RETRY_CAP times is never attempted again by the sweep, which is right on
 * the night it happens and wrong a week later: live, 169 of the 183 parked rows were "page 1: 404; page 2:
 * 429" against one site during one bad evening. So the nightly puts the oldest of them back to zero
 * attempts and lets the sweep's own budget decide when to try them -- a second chance after the site has
 * calmed down, not a retry storm.
 *
 * With `sourceId` (the Health page's "Retry now" on one source) the age rule is dropped -- a person is
 * asking about this source, now -- and the run goes further: it re-checks up to REPAIR_RETRY_SERIES of the
 * affected series straight away. Not while that source is in a cooldown or switched off, because then the
 * retry would be a guaranteed second refusal and a second strike with it.
 */
async function stepFailures(r: RepairResult, opts: RepairOpts, budget: { left: number }, pending: Dated[], log?: Log): Promise<RepairResult['stopped']> {
  const reset = opts.sourceId
    ? await q<{ series_id: string }>(
        `UPDATE chapter_failures SET attempts = 0, at = now() WHERE source_id = $1 RETURNING series_id`, [opts.sourceId])
    : await q<{ series_id: string }>(
        `UPDATE chapter_failures f SET attempts = 0, at = now()
          WHERE (f.series_id, f.number) IN (
            SELECT series_id, number FROM chapter_failures
             WHERE attempts >= $1 AND at < now() - interval '7 days'
             ORDER BY at ASC LIMIT $2)
          RETURNING f.series_id`, [CHAPTER_RETRY_CAP, REPAIR_FAILURES_MAX]);
  r.failures.reset = reset.length;
  if (r.failures.reset) log?.info(`repair: ${r.failures.reset} capped chapter failure(s) given another chance`);
  if (!opts.sourceId || !reset.length) return undefined;

  if (await blockedNow(opts.sourceId).catch(() => null)) {
    log?.info(`repair: ${opts.sourceId} is in a cooldown; its ledger was reset but nothing was re-checked yet`);
    return undefined;
  }
  if (await isDisabled(opts.sourceId).catch(() => false)) {
    log?.info(`repair: ${opts.sourceId} is switched off; its ledger was reset but nothing was re-checked`);
    return undefined;
  }

  const wanted = [...new Set(reset.map((x) => x.series_id))].slice(0, REPAIR_RETRY_SERIES);
  const folders = new Map((await q<{ id: string; folder: string }>(
    `SELECT s.id, s.folder FROM lib_series s WHERE s.id = ANY($1) AND ${visibleToAll('s')}`, [wanted],
  ).catch(() => [])).map((s) => [s.id, s.folder]));
  let series = 0, added = 0, failed = 0;
  let stopped: RepairResult['stopped'];
  for (const id of wanted) {
    if (runtime.stopping) { stopped = 'shutdown'; break; }
    const folder = folders.get(id);
    if (!folder || busyFolders.has(folder)) continue;
    series++;
    busyFolders.add(folder);
    try {
      const up = await updateSeries(id, 10, { hunt: budget });
      added += up.added;
      failed += up.failed;
      if (up.added && up.folder && up.chapters?.length) pending.push({ folder: up.folder, chapters: up.chapters, landed: up.landed });
      if (up.diskFull) { stopped = 'disk'; break; }
    } catch (e: any) {
      if (e?.diskFull) { stopped = 'disk'; break; }
      log?.warn(`repair: re-checking ${id} after the reset threw: ${(e as Error)?.message || e}`);
    } finally {
      busyFolders.delete(folder);
    }
    if (REPAIR_PACE_MS) await sleep(REPAIR_PACE_MS);
  }
  r.failures.retried = { series, added, failed };
  return stopped;
}

/** One short chapter's row, joined to what the download needs. */
type ShortBook = {
  id: string; series_id: string; number: number; pages: number; root: string; file: string; source_id: string | null;
  title: string; folder: string; summary: string | null; author: string | null; genres: string[] | null;
  web: string | null; status: string | null;
};

/** The hunt verdicts that PROVE nothing else has this chapter. `cooldown` is silence, not an answer. */
const PROOF_WHY = new Set(['no_candidate', 'no_copy', 'off', 'cap']);

/**
 * (b) Suspiciously short chapters: a whole-numbered chapter that turned out to be one or two images.
 *
 * Live, these are two different things wearing one label. Childhood Friend of the Zenith 33, 39 and 42 are
 * the same 520 kB notice image from one CDN -- a failed download that looks like a chapter. Eleceed 215 is
 * a single 8 MB long strip, which is what that series IS. Nothing in the database can tell them apart, and
 * a job that guessed would either leave the broken ones or overwrite the real ones.
 *
 * So it asks. One copy per SOURCE the series still follows, serving source first, up to
 * REPAIR_SHORT_COPIES of them, is asked for its page list -- a page count, before anything is downloaded
 * and without a byte of the chapter being fetched. Then:
 *   - a copy with MORE pages than what is on disk wins, and only then is anything downloaded;
 *   - every copy answering "two or fewer", with none of them throwing or skipped, and a search that found
 *     no other source, is a PROOF that the chapter really is two pages: stamped, and the Health page stops
 *     reporting it;
 *   - anything else is left for tomorrow, because uncertainty is not a finding.
 *
 * ⚠️ Owned files only (`root = DL_ROOT` and the name the downloader would have written). A chapter in
 * somebody's read library is not ours to replace -- a re-fetch could not even land on the same row, since
 * rows are keyed on (root, file) -- so those get the "It's fine" chip and nothing else.
 * ⚠️ Replace iff `count > book.pages`, decided BEFORE the download. Reintroduce by dropping that test:
 * "a shorter copy never replaces a longer one" in repair.int.test.ts finds the file rewritten.
 * ⚠️ Reading progress and bookmarks are untouched. A reader who "finished" the two-page notice keeps their
 * completed mark on the twelve-page chapter; USAGE.md says so, because the alternative is this job
 * silently re-opening chapters people had closed.
 */
async function stepShort(r: RepairResult, opts: RepairOpts, budget: { left: number }, notes: Notes, log?: Log): Promise<RepairResult['stopped']> {
  // ⚠️ `b.file = <folder>/Chapter <n>.cbz` is chapterFileRel (lib/downloader.ts) written in SQL, which is
  // safe only because `b.number = floor(b.number)` is in the same WHERE: the cast to int is exact for a
  // whole number and nothing else. A file under any other name is somebody's own copy, not ours.
  const rows0 = await q<ShortBook>(
    `SELECT b.id, b.series_id, b.number::float8 AS number, b.pages, b.root, b.file, b.source_id,
            s.title, s.folder, s.summary, s.author, s.genres, s.web, s.status
       FROM lib_books b JOIN lib_series s ON s.id = b.series_id AND ${visibleToAll('s')}
      WHERE b.pages BETWEEN 1 AND 2 AND b.number = floor(b.number)
        AND b.pruned_at IS NULL AND b.short_confirmed_at IS NULL AND b.missing_pages IS NULL
        AND b.root = $1 AND b.file = s.folder || '/Chapter ' || (b.number::int)::text || '.cbz'
        ${opts.bookId ? 'AND b.id = $3' : ''}
      ORDER BY b.mtime DESC LIMIT $2`,
    opts.bookId ? [DL_ROOT, REPAIR_SHORT_MAX, opts.bookId] : [DL_ROOT, REPAIR_SHORT_MAX],
  );
  // And then asked again in TypeScript, of the real function. The SQL above is the bound (it is what makes
  // the LIMIT mean "twenty candidates"); this is the answer. If the two ever disagree -- a rename of the
  // downloader's layout, a locale that formats a number differently -- this one wins, and it fails in the
  // safe direction: a chapter skipped, never somebody's read-library file replaced.
  const books = rows0.filter((b) => b.file === chapterFileRel(b.folder, Number(b.number)));
  if (!books.length) return undefined;

  // Grouped by series, because the listing refresh and the busy hold are per series, not per chapter.
  const bySeries = new Map<string, ShortBook[]>();
  for (const b of books) {
    if (!bySeries.has(b.series_id)) bySeries.set(b.series_id, []);
    bySeries.get(b.series_id)!.push(b);
  }

  let stopped: RepairResult['stopped'];
  series: for (const [seriesId, rows] of bySeries) {
    if (runtime.stopping) { stopped = 'shutdown'; break; }
    const folder = rows[0].folder;
    // Somebody else is already downloading into this folder (a series-page fetch, a Fetch newest run).
    // Two writers on one path is a lost file and a rate-limit strike each; this one simply waits a night.
    if (busyFolders.has(folder)) continue;
    const allowed = await sweepAllowedFor(await seriesIsAdult(seriesId).catch(() => false));
    // The sources this series is actually followed on -- the primary pair plus series_sources, exactly as
    // listingAlternates builds it (lib/updater.ts). A listing row's source is trusted only while the
    // series still follows it: a copy left behind by a source somebody unfollowed is not ours to ask.
    const primary = await one<{ source_id: string | null }>('SELECT source_id FROM lib_series WHERE id = $1', [seriesId]).catch(() => null);
    const followed = new Set<string>(
      (await q<{ source_id: string }>('SELECT source_id FROM series_sources WHERE series_id = $1', [seriesId]).catch(() => [])).map((x) => x.source_id),
    );
    if (primary?.source_id) followed.add(primary.source_id);

    busyFolders.add(folder);
    try {
      // The listing the copies come from is as old as the last sweep, and a source that has since fixed a
      // broken chapter would not be noticed. `maxNew: 0` downloads nothing: it is a listing refresh, the
      // same one the refetch route does, under the same kind of wall so a dead source costs ten seconds.
      await withTimeout(updateSeries(seriesId, 0), LISTING_REFRESH_MS).catch(() => {});

      for (const book of rows) {
        if (runtime.stopping) { stopped = 'shutdown'; break series; }
        r.short.looked++;
        const abs = join(book.root, book.file);
        const listing = await one<{ title: string | null; copies: ListingCopy[] }>(
          'SELECT title, copies FROM series_listing WHERE series_id = $1 AND number = $2::real', [seriesId, book.number],
        ).catch(() => null);
        const ranked = (listing?.copies ?? [])
          .filter((c) => followed.has(c.source))
          // The copy this file came from first: it is the one that can be compared against what is on disk
          // without any numbering question at all, and it is the one most likely to have been fixed.
          .sort((a, b) => Number(b.source === book.source_id) - Number(a.source === book.source_id));
        // ⚠️ One ask per SOURCE, not per listing entry. `series_listing.copies` is EVERY copy of the
        // number, including two scanlation groups on one site, so slicing the raw list could spend all
        // three asks on one source and leave a whole followed source unasked -- and then call the chapter
        // "confirmed short at the source" on the strength of a source that was never asked. Deduped
        // first, the cap means three SOURCES; the sort has already put the best copy of each one first.
        const bySource = new Map<string, ListingCopy>();
        for (const c of ranked) if (!bySource.has(c.source)) bySource.set(c.source, c);
        const copies = [...bySource.values()].slice(0, REPAIR_SHORT_COPIES);
        // A copy we chose not to ask has said nothing, and silence is never a proof. With MAX_FOLLOWERS
        // this is rare (a series follows at most three sources), but "rare" is not "cannot", and the
        // chapter being left for tomorrow is the harmless end of that.
        const unasked = bySource.size - copies.length;

        /** A page count, or null when the source was not asked or did not answer -- which ends any proof. */
        const ask = async (sourceId: string, chapterSourceId: string): Promise<number | null> => {
          const src = getSource(sourceId);
          if (!src || !allowed(sourceId)) return null;
          if (await isDisabled(sourceId).catch(() => false)) return null;
          if (await blockedNow(sourceId).catch(() => null)) return null;
          try {
            // Nothing is reported to source_health from here. A page list asked on our own initiative must
            // never be what puts a source into a cooldown: the sweep's own failures are that signal.
            const urls = await withTimeout(src.getPageUrls(chapterSourceId), budgetFor(src, SHORT_PAGES_MS));
            // ⚠️ An EMPTY list is silence, not an answer of "zero pages". No site serves a zero-page
            // chapter, but every HTML engine returns [] rather than throwing when what it parsed was not
            // the reader page at all -- a Cloudflare interstitial, a moved domain's 404, a theme change
            // (mangathemesia.ts, madara.ts). Counted as an answer, a parse failure would be the whole
            // proof that a chapter "really is two pages", and the nightly would never look at it again.
            return urls.length || null;
          } catch {
            return null;
          }
        };

        let best = book.pages;
        let bestChapter: SourceChapter | null = null;
        let answered = 0;
        let silent = unasked > 0;
        for (const c of copies) {
          const chapter = copyToChapter(c, { number: book.number, title: listing?.title ?? null });
          const n = await ask(c.source, c.sourceId);
          if (n === null) { silent = true; continue; }
          answered++;
          if (n > best) { best = n; bestChapter = chapter; }
        }

        // Nothing the series already follows has more than we do: ask whether any other site does. With
        // `bookId` the hunt is forced past its once-a-day stamp -- a person pressed Fix on this chapter.
        let huntWhy: string = 'skipped';
        if (!bestChapter) {
          const h = await huntSource(seriesId, book.number, {
            allowed, budget, reason: 'short_chapter', force: !!opts.bookId,
          });
          huntWhy = h.why;
          if (h.followed) notes.followed.push(`${book.title} -> ${h.followed.source}`);
          if (h.chapter?.source) {
            const n = await ask(h.chapter.source, h.chapter.sourceId);
            if (n === null) silent = true;
            else { answered++; if (n > best) { best = n; bestChapter = h.chapter; } }
          }
        }

        if (bestChapter) {
          const done = await replaceShort(book, bestChapter, abs, opts, notes, log);
          if (done === 'disk') { stopped = 'disk'; break series; }
          if (done) { r.short.replaced++; continue; }
          r.short.left++;
          continue;
        }
        // ⚠️ PROVEN, or nothing. Every copy answered, none was skipped or threw, at least one really did
        // answer, and the search came back with no other source at all. A `cooldown` from the hunt means
        // it did not look, which is exactly the thing a proof cannot be built on.
        if (!silent && answered > 0 && PROOF_WHY.has(huntWhy)) {
          await q('UPDATE lib_books SET short_confirmed_at = now() WHERE id = $1', [book.id]).catch(() => {});
          r.short.confirmed++;
          notes.confirmed.push(`${book.title} ch ${book.number}`);
          log?.info(`repair: "${book.title}" ch ${book.number} really is ${book.pages} page(s) -- every copy agrees`);
        } else {
          r.short.left++;
        }
      }
    } finally {
      busyFolders.delete(folder);
    }
  }
  return stopped;
}

/**
 * Write the longer copy over the short one and stamp the row. `true` when the file changed.
 *
 * `downloadChapter({ replace: true })` writes through writeAtomic and only ever lands a COMPLETE chapter
 * (lib/downloader.ts, pinned by partialChapter.test.ts), so there is no window in which the short file is
 * gone and the long one has not arrived -- which is why this needs none of the refetch route's set-aside
 * dance and nothing is ever tombstoned here. A copy that arrives nearly whole is offered as a hold, and it
 * is taken only when it still beats what is on disk and the source did not refuse us.
 */
async function replaceShort(
  book: ShortBook, chapter: SourceChapter, abs: string, opts: RepairOpts, notes: Notes, log?: Log,
): Promise<boolean | 'disk'> {
  const via = chapter.source!;
  const meta: DownloadInput['meta'] = {
    series: book.title, summary: book.summary ?? undefined, author: book.author ?? undefined,
    genres: book.genres ?? undefined, url: book.web ?? undefined, status: book.status ?? undefined,
  };
  let missing: number[] = [];
  try {
    const landed = await downloadChapter({ sourceId: via, seriesFolder: book.folder, chapter, meta }, { replace: true });
    if (!landed) return false;
  } catch (e: any) {
    if (e?.diskFull) return 'disk';
    const hold = e?.partial;
    // A refusal (403/429) is the site saying no, and a chapter saved from a refusal would be a shorter
    // file dressed up as progress. `blockStatus` is set only when the SOURCE is at fault.
    if (!hold || e?.blockStatus || hold.pages <= book.pages) return false;
    await hold.write();
    missing = hold.missing;
  }
  // restampBook is the only writer of `pages` on the REPLACE path: the count that decided to download
  // came from the source's page list, and the count that gets stored has to come from the bytes that
  // landed. (The count step writes `pages` too, but only into a blank row -- `AND pages = 0` -- from a
  // file nobody had measured; the two never write the same row for the same reason.)
  await restampBook(book.id, abs, missing, { source: via, scanlator: chapter.scanlator });
  const now = await one<{ pages: number }>('SELECT pages FROM lib_books WHERE id = $1', [book.id]);
  const readers = await one<{ n: number }>('SELECT count(*)::int AS n FROM read_progress WHERE book_id = $1', [book.id]).catch(() => null);
  await logAudit('book.short_fixed', {
    userId: opts.userId ?? null,
    detail: {
      bookId: book.id, seriesId: book.series_id, title: book.title, number: book.number,
      from: book.source_id, to: via, pages: [book.pages, now?.pages ?? 0],
      ...(missing.length ? { missing_pages: missing.length } : {}),
      // How many people have a reading position in this chapter. Their progress is deliberately untouched,
      // and this is the number that says how many were affected by the page count changing under them.
      readers: readers?.n ?? 0,
    },
  });
  notes.replaced.push(`${book.title} ch ${book.number} (${book.pages} -> ${now?.pages ?? 0})`);
  log?.info(`repair: "${book.title}" ch ${book.number}: ${book.pages} -> ${now?.pages ?? 0} pages from ${via}`
    + (missing.length ? ` (${missing.length} page(s) still missing)` : ''));
  return true;
}

/** What one series' gap hunt concluded, stored on lib_series.gaps_result for the Health page to read. */
interface GapsResult {
  at: string;
  /** How many chapters the series held when this ran: the Health page re-reports once this changes. */
  have_count: number;
  /** Gap numbers no followed source lists -- what the search went looking for. 0 means no search ran. */
  scanned: number;
  followed: string | null;
  coverage: number | null;
  fetched: number;
  /** Gap numbers a followed source already lists: the ordinary sweep's job, not a search's. */
  sweep: number;
  /** Gap numbers parked at the retry cap: the failures step's job. */
  capped: number;
  /** Ranges no reachable source can supply, as "12-15". */
  unfillable: string[];
  /** Chapters that landed during the gap fetch in total, of which `fetched` were inside the hole. */
  landed: number;
  /**
   * `listed` means no search was needed at all. The other five are huntCandidates' verdicts; the Health
   * page shows the finding greyed while it is `no_candidate`, `cap` or `off`, because those three mean
   * "asked, and the answer was no" rather than "not asked yet".
   * ⚠️ `cooldown` here can only ever mean THIS series was hunted within the last day (by the short step,
   * or by a sweep) -- never "the run ran out of searches", which stops the step before anything is
   * stamped (see below). The Health page's "searched too recently to search again" is true of it.
   */
  why: 'followed' | 'no_candidate' | 'cooldown' | 'cap' | 'off' | 'listed';
}

/**
 * (c) Chapter gaps: holes in a series' numbering that no followed source can fill.
 *
 * Two thirds of the live findings are not this job's business and are recognised without a single request:
 * a gap number the listing already holds is a chapter the ordinary sweep will fetch, and one parked at the
 * retry cap is the failures step's. Only a number NO followed source lists is worth searching for.
 *
 * The search is huntCandidates with a `wants` of its own, and the judgement is autoFollow's -- the title
 * must be ours and the numbering must line up both ways (the Tokyo Ghoul:re guard). The extra condition is
 * the fill dialog's own rule, quoted: `assess().fillable` marks a number fillable only when the candidate
 * holds BOTH chapters bracketing the hole, so a source that restarts its numbering per season collapses
 * before it can offer to fill 5-7 with the wrong instalments.
 * ⚠️ Reintroduce by following the first candidate that is this series (dropping `wants`): "a source that
 * does not bracket the hole is never followed" in repair.int.test.ts follows the 60 % one.
 * ⚠️ `gaps_checked_at` is stamped BEFORE any network call, like source_hunt_at, so a crash mid-search does
 * not make this the first series tomorrow's run picks up again -- but AFTER the database-only split, so a
 * series the run has no search left for keeps yesterday's stamp instead of being parked for a day on a
 * search that never happened.
 */
async function stepGaps(r: RepairResult, opts: RepairOpts, budget: { left: number }, pending: Dated[], notes: Notes, log?: Log): Promise<RepairResult['stopped']> {
  // Series with something to look at. `gaps_checked_at` bounds the rescan; `seriesId` (a person pressing
  // "Fill now") ignores it, because they are asking about this series now.
  const candidates = await q<{ id: string; title: string; folder: string }>(
    `SELECT s.id, s.title, s.folder FROM lib_series s
      WHERE s.auto_update AND ${visibleToAll('s')}
        ${opts.seriesId ? 'AND s.id = $1' : "AND (s.gaps_checked_at IS NULL OR s.gaps_checked_at < now() - interval '24 hours')"}`,
    opts.seriesId ? [opts.seriesId] : [],
  );
  // One small indexed read per candidate. It is the only way to apply the override and tombstone rules
  // (lib/libraryNumbers.ts) per series, and a few hundred of them once a night is not a load worth
  // flattening into a query nobody can read.
  const ranked: Array<{ id: string; title: string; folder: string; have: number[]; missing: number; gapNums: number[] }> = [];
  for (const s of candidates) {
    const have = await haveNumbers(s.id);
    const gaps = gapsOf(have);
    if (!gaps.length) continue;
    const gapNums: number[] = [];
    for (const g of gaps) for (let n = g.lo; n <= g.hi; n++) gapNums.push(n);
    ranked.push({ ...s, have, missing: gapNums.length, gapNums });
  }
  ranked.sort((a, b) => b.missing - a.missing);

  let stopped: RepairResult['stopped'];
  for (const s of ranked.slice(0, REPAIR_GAPS_MAX)) {
    if (runtime.stopping) { stopped = 'shutdown'; break; }
    if (busyFolders.has(s.folder)) continue;

    const gapSet = new Set(s.gapNums);
    const listed = await q<{ number: number; status: string }>(
      'SELECT number::float8 AS number, status FROM series_listing WHERE series_id = $1', [s.id]).catch(() => []);
    const listedNums = new Set(listed.map((x) => Math.floor(Number(x.number))));
    const availNums = new Set(listed.filter((x) => x.status === 'available').map((x) => Math.floor(Number(x.number))));
    const cappedRows = await q<{ number: number }>(
      'SELECT number::float8 AS number FROM chapter_failures WHERE series_id = $1 AND attempts >= $2', [s.id, CHAPTER_RETRY_CAP],
    ).catch(() => []);
    const cappedNums = new Set(cappedRows.map((x) => Math.floor(Number(x.number))));
    const capped = s.gapNums.filter((n) => cappedNums.has(n));
    const sweepable = s.gapNums.filter((n) => availNums.has(n) && !cappedNums.has(n));
    const unlisted = new Set(s.gapNums.filter((n) => !listedNums.has(n)));

    // ⚠️ The split above is all database, so it is done BEFORE the stamp -- because a series this run
    // cannot search must keep the stamp it had. `gaps_checked_at` means "looked at today" and the filter
    // at the top of this step believes it for 24 hours; writing it with no search left would park the
    // series until tomorrow AND store a verdict (huntCandidates answers `cooldown` for a spent budget)
    // that the Health page reads as "searched too recently to search again" -- a sentence about a series
    // nothing ever searched. Stopping here instead costs the run nothing: every series left is one this
    // run had no search for, and they are still the emptiest ones tomorrow.
    if (unlisted.size && budget.left <= 0) {
      log?.info(`repair: no searches left this run -- "${s.title}" and any series behind it keep their place in the queue`);
      break;
    }
    r.gaps.series++;
    r.gaps.sweep += sweepable.length;
    await q('UPDATE lib_series SET gaps_checked_at = now() WHERE id = $1', [s.id]).catch(() => {});

    // Until a candidate is found, every unlisted gap number is one nobody has. The follow narrows it.
    let unfillable = [...unlisted];
    const out: GapsResult = {
      at: new Date().toISOString(), have_count: s.have.length, scanned: unlisted.size, followed: null,
      coverage: null, fetched: 0, landed: 0, sweep: sweepable.length, capped: capped.length,
      unfillable: rangeText(unfillable), why: 'listed',
    };

    if (unlisted.size) {
      const allowed = await sweepAllowedFor(await seriesIsAdult(s.id).catch(() => false));
      const found = await huntCandidates(s.id, {
        allowed, budget, reason: 'gap', force: !!opts.seriesId,
        // The candidate must be able to fill a hole nobody else lists. `assess` over the RAW list it
        // already fetched: this asks what the source HAS, and the release preferences decide later which
        // copy of it the sweep takes.
        wants: (j) => assess(s.have, (j.chapters ?? []).map((c) => c.number)).fillable.some((n) => unlisted.has(n)),
      });
      // huntCandidates never answers no_copy -- that verdict belongs to huntSource, which reaches it only
      // AFTER following a source that turned out to lack the number. Narrowed here so the stored why says
      // what was actually asked.
      out.why = found.why === 'no_copy' ? 'no_candidate' : found.why;
      if (found.chosen) {
        const fillable = assess(s.have, (found.chosen.chapters ?? []).map((c) => c.number)).fillable.filter((n) => unlisted.has(n));
        try {
          const f = await followHunted(s.id, found.title, found.chosen, 'gap', { numbers: fillable });
          out.followed = f.source;
          out.coverage = found.chosen.coverage;
          unfillable = [...unlisted].filter((n) => !fillable.includes(n));
          out.unfillable = rangeText(unfillable);
          r.gaps.followed++;
          notes.followed.push(`${s.title} -> ${f.source}`);
        } catch (e: any) {
          // followHunted writes nothing when it throws, so there is no half-followed state to undo.
          out.why = e?.why === 'cap' ? 'cap' : 'no_candidate';
          log?.warn(`repair: "${s.title}": could not follow the source that brackets its gaps (${out.why})`);
        }
      }
      if (out.followed) {
        busyFolders.add(s.folder);
        try {
          const up = await updateSeries(s.id, REPAIR_GAP_CHAPTERS, { hunt: false });
          const fetched = up.landed.filter((l) => gapSet.has(Math.floor(l.number)));
          out.fetched = fetched.length;
          // ⚠️ Two different numbers, and both are reported. The fetch is the ordinary sweep of the
          // freshly followed source, oldest missing chapter first up to REPAIR_GAP_CHAPTERS -- so
          // following a source with a longer catalogue can land twenty chapters of which three were the
          // gap. `fetched` answers "was the hole filled"; `landed` answers "what did the night cost",
          // and a line that reported only the first would understate the download by an order.
          out.landed = up.landed.length;
          r.gaps.fetched += fetched.length;
          if (up.landed.length) {
            log?.info(`repair: "${s.title}": ${up.landed.length} chapter(s) landed from ${out.followed}, `
              + `${fetched.length} of them inside the gap`);
          }
          if (up.added && up.folder && up.chapters?.length) pending.push({ folder: up.folder, chapters: up.chapters, landed: up.landed });
          if (up.diskFull) stopped = 'disk';
        } catch (e: any) {
          if (e?.diskFull) stopped = 'disk';
          else log?.warn(`repair: fetching "${s.title}"'s gaps threw: ${(e as Error)?.message || e}`);
        } finally {
          busyFolders.delete(s.folder);
        }
      }
    }
    // Counted in CHAPTERS, not series: "nobody lists these eleven chapters" is the finding an admin can
    // do something about (an alternative title, a manual add), and a count of series would hide whether
    // that is one stubborn hole or a series nothing else carries at all.
    r.gaps.unfillable += unfillable.length;
    await q('UPDATE lib_series SET gaps_result = $2::jsonb WHERE id = $1', [s.id, JSON.stringify(out)]).catch(() => {});
    if (stopped) break;
  }
  return stopped;
}

// ── the run ─────────────────────────────────────────────────────────────────────────────────────────────

function blank(): RepairResult {
  return {
    ok: true, ms: 0, counted: 0, uncounted: 0,
    short: { looked: 0, replaced: 0, confirmed: 0, left: 0 },
    gaps: { series: 0, followed: 0, fetched: 0, unfillable: 0, sweep: 0 },
    failures: { reset: 0 },
    solver: { reset: false, unblocked: 0, expired: 0 },
  };
}

/** The one-line summary the log and the audit row carry. The web writes its own, translated. */
function summaryOf(r: RepairResult): string {
  return `${r.counted} counted (${r.uncounted} left), short ${r.short.replaced} replaced / ${r.short.confirmed} confirmed `
    + `/ ${r.short.left} left of ${r.short.looked}, gaps ${r.gaps.series} series / ${r.gaps.followed} followed / `
    + `${r.gaps.fetched} fetched, ${r.failures.reset} failures reset, solver ${r.solver.reset ? 'reset' : 'untouched'} `
    + `(${r.solver.unblocked} unblocked, ${r.solver.expired} expired)`;
}

/** One pass. Exported for the tests; everything else goes through runRepair, which owns the flags. */
export async function repairLibrary(log?: Log, opts: RepairOpts = {}): Promise<RepairResult> {
  const t0 = Date.now();
  const r = blank();
  if (opts.only?.length) r.only = REPAIR_STEPS.filter((s) => opts.only!.includes(s));

  // The switch is honoured only for a run nobody asked for (see RepairOpts.userId).
  if (opts.userId === undefined) {
    const on = await one<{ on: boolean }>('SELECT repair_enabled AS "on" FROM server_settings WHERE id = 1').catch(() => null);
    if (on?.on === false) return { ...r, ms: Date.now() - t0, skipped: 'disabled' };
  }

  const want = (s: RepairStep) => !opts.only?.length || opts.only.includes(s);
  const budget = { left: REPAIR_HUNT_BUDGET };
  const pending: Dated[] = [];
  const notes: Notes = { replaced: [], confirmed: [], followed: [] };
  let stopped: RepairResult['stopped'];

  for (const step of REPAIR_STEPS) {
    if (runtime.stopping) { stopped = 'shutdown'; break; }
    if (stopped) break;
    if (!want(step)) continue;
    if (step === 'solver') await stepSolver(r, log);
    else if (step === 'count') await stepCount(r, log);
    else if (step === 'failures') stopped = await stepFailures(r, opts, budget, pending, log);
    else if (step === 'short') {
      // A RESERVE, not a second budget: the short step is handed a view of the shared pot capped at
      // REPAIR_SHORT_HUNT_MAX, and whatever it spent out of that view is charged to the pot when it
      // returns. The run's total is still REPAIR_HUNT_BUDGET searches; only the share one step can take
      // in a night is bounded, so the gap step below always has some left to spend.
      const reserve = { left: Math.min(budget.left, REPAIR_SHORT_HUNT_MAX) };
      const had = reserve.left;
      stopped = await stepShort(r, opts, reserve, notes, log);
      budget.left -= had - reserve.left;
    } else if (step === 'gaps') stopped = await stepGaps(r, opts, budget, pending, notes, log);
  }

  // What landed needs rows, and the rows need their dates and provenance: persistScan is what mints them
  // (and what clears the ledger rows for chapters that are now on disk, lib/library.ts). Exactly the
  // sequence the sweep runs after its own download loop.
  if (pending.length) {
    await persistScan().catch((e) => log?.warn(`repair: the post-run scan threw: ${(e as Error)?.message || e}`));
    for (const d of pending) {
      await setBookDates(d.folder, d.chapters).catch(() => {});
      await setBookMeta(d.folder, d.landed).catch(() => {});
    }
  }

  const out: RepairResult = { ...r, ms: Date.now() - t0, ...(stopped ? { stopped } : {}) };
  await logAudit('library.repair', {
    userId: opts.userId ?? null,
    detail: {
      ...(out.only ? { only: out.only } : {}),
      ...(opts.seriesId ? { seriesId: opts.seriesId } : {}),
      ...(opts.bookId ? { bookId: opts.bookId } : {}),
      ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
      summary: summaryOf(out),
      ...(stopped ? { stopped } : {}),
      // Capped lists, not counts: enough to answer "which chapters did it touch last night" from the audit
      // page alone, bounded so one run cannot write a megabyte of JSON into the log.
      replaced: notes.replaced.slice(0, REPAIR_SHORT_MAX),
      confirmed: notes.confirmed.slice(0, REPAIR_SHORT_MAX),
      followed: notes.followed.slice(0, REPAIR_GAPS_MAX),
    },
  });
  return out;
}

/**
 * Run it the way the Tasks panel runs it: one at a time, never beside a sweep, result kept and persisted.
 *
 * Same contract as runSweep, runChapterCleanup and runVerify -- `false`, synchronously, when it must not
 * start, otherwise the promise. Two reasons to refuse, and the route tells them apart: a repair is already
 * running, or a chapter sweep is. ⚠️ The two jobs must never overlap. Both download into the same series
 * folders and both write lib_books for what landed, so a chapter this job is replacing could be the very
 * file the sweep is scanning, and two persistScans racing over one folder mint rows twice. `runSweep`
 * refuses in the same way while `runtime.repairing` is set, and server.ts's ticks defer around each other.
 */
export function runRepair(log?: Log, opts: RepairOpts = {}): Promise<RepairResult> | false {
  if (repairState.running || runtime.updating) return false;
  repairState.running = true;
  runtime.repairing = true;
  repairState.startedAt = Date.now();
  repairState.finishedAt = null;
  return (async () => {
    try {
      const r = await repairLibrary(log, opts);
      repairState.finishedAt = Date.now();
      repairState.lastResult = r;
      // Persisted like the cleanup's and the verify's: the Tasks panel promises to keep the last run, and a
      // restart must not turn it back into "not run yet". Reintroduce by dropping this UPDATE: "the last
      // result survives a restart" in repair.int.test.ts finds the row empty.
      await q(
        'UPDATE server_settings SET repair_last_run = now(), repair_last_result = $1::jsonb WHERE id = 1',
        [JSON.stringify(r)],
      ).catch(() => {});
      log?.info(`repair: ${summaryOf(r)}${r.skipped ? ' (switched off)' : ''}${r.stopped ? ` (stopped: ${r.stopped})` : ''} in ${r.ms} ms`);
      return r;
    } catch (e) {
      // Never leave an older healthy result standing after a run that threw, in memory or in the row a
      // restart reads: "20 chapters replaced" about a run that died halfway is worse than no line at all.
      repairState.finishedAt = Date.now();
      repairState.lastResult = null;
      await q('UPDATE server_settings SET repair_last_run = now(), repair_last_result = NULL WHERE id = 1').catch(() => {});
      log?.error(e);
      throw e;
    } finally {
      repairState.running = false;
      runtime.repairing = false;
    }
  })();
}
