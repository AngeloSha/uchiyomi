// "Fetch newest" over many series at once: the Library page's select bar, one detached job.
//
// Per series it takes the newest LISTED release if we do not hold it, and nothing else (the rule lives in
// updateSeries's `newestOnly`, with the trap it avoids). What this module owns is everything a bulk action
// over up to 500 series needs that a single request cannot give:
//
// - It is DETACHED. Awaiting up to 500 listings and downloads inside one HTTP request meets the reverse
//   proxy's timeout first; the person sees "could not fetch" while the server keeps downloading, and a
//   re-click starts a second loop on top of the first. The route starts this and answers 202; the page
//   polls `bulkNewestState()`. One at a time: a second start while one runs is refused, never queued.
// - It PACES like the sweep (runUpdateAll's 1500 ms between series): the fan-out is the same shape, and
//   an unpaced burst against one site is what earned this install its 75-minute cooldowns.
// - It SCANS once at the end, then stamps dates and provenance onto the rows the scan minted (the sweep's
//   own order). A downloaded file is only a file until a scan makes it a book; the single-series "Check"
//   route learned this the hard way, and PR #53 re-learned it.
// - It STOPS on SIGTERM between series (runtime.stopping, the sweep's rule) and marks the rest skipped,
//   so a `docker compose up -d` mid-run ends at a chapter boundary with the status saying so, rather than
//   with a job card polling a dead run.
// - It is VISIBLE to the other writers: the folder it is inside is in `busyFolders`, which jobBusy in
//   routes/sources.ts reads, so a series-page Fetch or an admin refetch on that series is refused (409
//   busy) for as long as this run is on it, instead of a second job downloading the same chapter onto
//   the same path.
//
// State is in-memory, like the single-series checks and the download strip: a restart forgets it, and the
// page's poll reads `running: false` with whatever finished before the restart.
import { one } from './db';
import { updateSeries, type Landed } from './updater';
import { persistScan, setBookDates, setBookMeta } from './library';
import { runtime } from './runtime';
import type { SourceChapter } from './sources';
import { beginRun, endRun, stopRequested, type RunCard } from './downloadJobs';
import { withOrigin } from './downloadActivity';

export type NewestOutcome = 'downloaded' | 'up_to_date' | 'skipped' | 'failed';

export interface NewestResult {
  id: string;
  /** Empty for an id that is not in the caller's library: there is no row to read it from. */
  title: string;
  outcome: NewestOutcome;
  /** A sentence, present on every outcome but `downloaded`. */
  reason?: string;
}

export interface BulkNewestState {
  running: boolean;
  /** Series settled so far, including the ones skipped before any source was asked. */
  done: number;
  total: number;
  startedAt: string | null;
  /** In the order the ids were given, which is the order they were started. */
  results: NewestResult[];
}

const state: BulkNewestState = { running: false, done: 0, total: 0, startedAt: null, results: [] };
/** Who started the current (or last) run; the results are theirs to read, and an admin's. */
let startedBy: string | null = null;

/**
 * The current run, or the last one. What GET /api/library/bulk/newest returns.
 *
 * The counts go to every signed-in viewer: a 409 already tells them a run exists, and the page needs
 * `running` to know when the chip comes back. The RESULTS carry titles, and only the person who started
 * the run (or an admin) gets them: a member granted one library must not learn what another member's
 * selection in a library they cannot see is called, one "Fetch newest" at a time.
 * Reintroduce by returning `state.results` for every viewer: "a run's results are the starter's and an
 * admin's to read" in bulkNewest.int.test.ts finds a title.
 */
export function bulkNewestState(viewer?: { userId: string; admin: boolean }): BulkNewestState {
  const mine = !!viewer && (viewer.admin || viewer.userId === startedBy);
  return { ...state, results: mine ? [...state.results] : [] };
}

/** runUpdateAll's pause between series; a test shortens it, the route never does. */
export const PACE_MS = 1500;

/**
 * The series folder this run is inside updateSeries for, while it is: what routes/sources.ts's jobBusy
 * consults beside its own download jobs. Without it the run is invisible to every other writer: a person
 * on the series page pressing Fetch for the very chapter this run is downloading starts a second job on
 * the same path through the same source -- two writers on one file (the last rename wins) and a
 * rate-limit strike each. Keyed by folder as the jobs map is, because that is what lib_series.folder is.
 * Added right before updateSeries and removed in a finally, so a series that throws does not stay busy
 * until a restart. At most one entry, since one run goes at a time.
 * Reintroduce by dropping the `busyFolders.has` test in jobBusy: "a series-page fetch during the run is
 * refused as busy" in bulkNewest.int.test.ts starts the second download.
 */
export const busyFolders = new Set<string>();

export interface BulkNewestInput {
  /** Every id the caller asked for, in order. Ones not in `live` are reported skipped, never fetched. */
  ids: string[];
  /** The subset the caller may act on (liveSeries(vc) in routes/personal.ts). Fails closed: absent = none. */
  live: Set<string>;
  /** routes/sources.ts jobBusy: a series with a download running is skipped, not doubled. */
  busy: (folder: string) => boolean;
  /** visibility.sourceAllowedFor for this viewer, applied to the newest copy's source inside updateSeries. */
  sourceAllowed: (sourceId: string) => boolean;
  /** The starter, who may read the results afterwards. */
  userId: string;
  paceMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Start a run. Returns `false`, synchronously and without starting, when one is already running: the route
 * turns that into 409 `busy`. Otherwise the total, with the run already detached.
 *
 * `runtime.updating` (the sweep) is deliberately NOT a reason to refuse: a sweep runs for minutes to hours,
 * and a person who selected ten series should not be locked out for its whole duration. Both paths go
 * through updateSeries, whose downloader skips a file that is already on disk, so the worst overlap is one
 * listing asked twice.
 */
export function startBulkNewest(input: BulkNewestInput): { total: number } | false {
  if (state.running) return false;
  // Set before the first await, so two starts in the same turn of the event loop cannot both get through.
  state.running = true;
  state.done = 0;
  state.total = input.ids.length;
  state.startedAt = new Date().toISOString();
  state.results = [];
  startedBy = input.userId;
  // The run's card on the download pill (lib/downloadJobs.ts, #82), with a Cancel for an admin: "select all"
  // fans this out over hundreds of series, a second and a half apart.
  const card = beginRun('newest', input.userId, input.ids.length);
  void withOrigin('bulk', input.userId ?? null, () => run(input, card)).catch((e) => {
    // The loop below settles every series itself; only something outside it (a state write) can reach
    // here, and the run must still end, or every later click is a 409 until a restart.
    console.warn(`[bulk/newest] run failed: ${(e as Error)?.message || e}`);
    endRun(card, 'error', 'The run failed. The server log has the details.');
  }).finally(() => { state.running = false; if (card.status === 'running') endRun(card, 'done'); });
  return { total: input.ids.length };
}

/** The sentence the person reads for a series that fetched nothing, keyed by what updateSeries said. */
function explain(r: Awaited<ReturnType<typeof updateSeries>>): { outcome: NewestOutcome; reason: string } {
  switch (r.outcome) {
    case 'gone': return { outcome: 'skipped', reason: 'Not in your library any more.' };
    case 'unrouted': return { outcome: 'skipped', reason: 'No source is installed for this series.' };
    case 'blocked': return { outcome: 'skipped', reason: 'Its source is in a cooldown. Try again later.' };
    case 'source_error': return { outcome: 'failed', reason: 'Its source did not answer.' };
    default: break;
  }
  const n = r.newest;
  switch (n?.state) {
    case 'up_to_date': return { outcome: 'up_to_date', reason: `Chapter ${n.number} is already here.` };
    // Skipped, not up to date: the bytes are gone by someone's decision, and the person who selected this
    // series after Put back is exactly the one who wants them back. The sweep will not do it (a deliberate
    // deletion is held, lib/chapterCleanup.ts heldBooks), so the sentence names the button that does.
    case 'deleted': return { outcome: 'skipped', reason: `Chapter ${n.number} was deleted from this server on purpose. Fetch again on the series page brings it back.` };
    case 'on_disk': return { outcome: 'up_to_date', reason: `Chapter ${n.number} was already on disk and is in the library now.` };
    case 'held': return { outcome: 'skipped', reason: `Chapter ${n.number} is being held for the preferred group. Pick a copy on the series page to take it now.` };
    case 'disabled': return { outcome: 'skipped', reason: 'Its source is disabled by the admin.' };
    case 'denied': return { outcome: 'skipped', reason: 'That source is not available on this account.' };
    case 'unlisted': return { outcome: 'skipped', reason: 'Its source lists no chapters.' };
    case 'queued':
      if (r.diskFull) return { outcome: 'failed', reason: 'The library disk is full.' };
      // Queued, nothing added and nothing failed: the only way through updateSeries's loop without an
      // attempt is its own between-chapter stop check. That is a shutdown, not a chapter that would not
      // save, and the person must not be sent to the Health page for it.
      if (!r.failed && runtime.stopping) return { outcome: 'skipped', reason: 'The server is shutting down.' };
      return { outcome: 'failed', reason: `Chapter ${n.number} could not be saved. The Health page has the details.` };
    default:
      return { outcome: 'failed', reason: 'The check produced no verdict.' };
  }
}

async function run(input: BulkNewestInput, card?: RunCard): Promise<void> {
  const pace = input.paceMs ?? PACE_MS;
  // Collected rather than scanned per series: persistScan walks the whole library, and "select all" fans
  // this out over hundreds of series. One scan at the end, then the stamps against the rows it minted.
  const dated: { folder: string; chapters: SourceChapter[]; landed: Landed[] }[] = [];
  const settle = (r: NewestResult) => {
    state.results.push(r);
    state.done++;
    if (card) {
      card.done = state.done;
      if (r.outcome === 'downloaded') card.fetched++;
      if (r.outcome === 'failed') card.failed++;
    }
  };

  for (const id of input.ids) {
    if (runtime.stopping) { settle({ id, title: '', outcome: 'skipped', reason: 'The server is shutting down.' }); continue; }
    if (stopRequested(card)) { settle({ id, title: '', outcome: 'skipped', reason: 'Cancelled.' }); continue; }
    if (!input.live.has(id)) { settle({ id, title: '', outcome: 'skipped', reason: 'Not in your library.' }); continue; }
    // Folder and title read here rather than trusted from the caller: the busy check is keyed by folder,
    // and a series hidden between the request and its turn is `gone` below, not a stale title.
    const row = await one<{ title: string; folder: string }>('SELECT title, folder FROM lib_series WHERE id = $1', [id]).catch(() => null);
    if (!row) { settle({ id, title: '', outcome: 'skipped', reason: 'Not in your library any more.' }); continue; }
    if (input.busy(row.folder)) { settle({ id, title: row.title, outcome: 'skipped', reason: 'A download for that series is already running.' }); continue; }

    // A throw counts as asked: the check may have died anywhere, including mid-listing.
    let asked = true;
    busyFolders.add(row.folder);
    if (card) card.current = { id, title: row.title };
    try {
      const r = await updateSeries(id, 1, { newestOnly: true, sourceAllowed: input.sourceAllowed, ...(card ? { cancelled: () => stopRequested(card) } : {}) });
      // Only a run that actually asked a source for a listing pays the pause below. The earlier rule
      // (`outcome !== 'gone' && !== 'unrouted'`) counted a cooldown as asked, so 500 series on one
      // cooled-down source slept 12.5 minutes to say "in a cooldown" 500 times; updateSeries now says
      // itself whether any network call was made, which also covers a source that was disabled before
      // it was listed. Reintroduce by setting `asked = true` here: "series that no source was asked
      // about are not paced" in bulkNewest.int.test.ts takes seconds.
      asked = r.asked;
      if (r.added > 0) {
        if (r.folder && r.chapters?.length) dated.push({ folder: r.folder, chapters: r.chapters, landed: r.landed });
        settle({ id, title: r.title, outcome: 'downloaded' });
      } else {
        // A file that was on disk with no row behind it gets its row from the scan below, same as a
        // download would; the date stamp is what makes it sort with its neighbours.
        if (r.newest?.state === 'on_disk' && r.folder && r.chapters?.length) dated.push({ folder: r.folder, chapters: r.chapters, landed: [] });
        // Queued with nothing added and nothing failed is updateSeries's between-chapters stop: after a
        // Cancel that is the cancel, not "could not be saved" and a trip to the Health page.
        const stoppedHere = stopRequested(card) && !r.failed && r.newest?.state === 'queued';
        settle({ id, title: r.title || row.title, ...(stoppedHere ? { outcome: 'skipped' as const, reason: 'Cancelled.' } : explain(r)) });
      }
    } catch (e) {
      // updateSeries throwing outright (the database going away mid-run) is this series' failure, and the
      // run goes on: catching it into "up to date" is the sweep's old mistake.
      settle({ id, title: row.title, outcome: 'failed', reason: (e as Error)?.message || 'The check threw.' });
    } finally {
      busyFolders.delete(row.folder);
    }
    // Paced only after a source was actually asked: the pause is for the network, and a run over ids that
    // were all skipped before any listing should not take 1.5 s a piece to say so.
    if (asked && state.done < state.total) await sleep(pace);
  }

  if (dated.length) {
    // Logged, not swallowed: a failed scan here leaves "downloaded" over a series page with no new row,
    // and the log line is the only trace of why.
    const warn = (step: string, folder?: string) => (e: unknown) =>
      console.warn(`[bulk/newest] ${step} failed${folder ? ` for ${folder}` : ''}: ${(e as Error)?.message || e}`);
    await persistScan().catch(warn('scan'));
    for (const d of dated) {
      await setBookDates(d.folder, d.chapters).catch(warn('date stamp', d.folder));
      await setBookMeta(d.folder, d.landed).catch(warn('provenance stamp', d.folder));
    }
  }
}
