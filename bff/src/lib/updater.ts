// New-chapter updater: for each owned series, ask its source for chapters we don't have yet and download
// them via the downloader. Replaces Suwayomi's update loop. Source routing comes straight from the
// lib_series.source_id / source_series_id columns stamped at add time (backfilled once for older rows) —
// no display-name keyword matching or <Web>-url reverse-parsing.
import { q, one } from './db';
import { getSource, SourceChapter, withTimeout } from './sources';
import { persistScan, setBookDates, setBookMeta, DL_ROOT } from './library';
import { blockedNow, isDisabled } from './sourceHealth';
import { noteChapterFailure } from './chapterFailures';
import { budgetFor } from './sources/budget';
import { notifyNewChapter } from './push';
import { sendDigest, type Landed as DigestSeries } from './notify';
import { visibleToAll } from './visibility';
import { runtime } from './runtime';
import { chooseReleases, copiesOf, releaseOrder } from './releases';
import { effectivePrefsFor, readSeriesPrefs } from './scanlatorPrefs';
import { copyToChapter, listingRows, replaceListing, type ListingCopy } from './seriesListing';
import { heldBooks } from './chapterCleanup';
import { downloadWithFallback, type FallbackOutcome } from './chapterFallback';
import { huntSource, seriesIsAdult, sweepAllowedFor, HUNT_MAX_PER_SWEEP } from './sourceHunt';
import { completePartial, PARTIAL_COMPLETE_MAX } from './partial';

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

/** A chapter that landed in this run, and what setBookMeta stamps onto the book the scan mints for it. `missing` = 1-based placeholder pages of a partial (lib/partial.ts). */
export type Landed = { number: number; scanlator?: string; source?: string; missing?: number[] };

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
}

const nothing = (title: string, outcome: UpdateOutcome): UpdateResult =>
  ({ title, added: 0, available: 0, outcome, failed: 0, waiting: 0, switched: 0, partial: 0, landed: [], asked: false });

export async function updateSeries(seriesId: string, maxNew = 10, opts: UpdateOpts = {}): Promise<UpdateResult> {
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
  let followed = [
    ...(s.source_id && s.source_series_id && getSource(s.source_id)
      ? [{ source: s.source_id as string, ref: s.source_series_id as string, primary: true }] : []),
    ...extras.filter((e) => e.source_id !== s.source_id && getSource(e.source_id)).map((e) => ({ source: e.source_id, ref: e.source_series_id, primary: false })),
  ];
  if (!followed.length) return nothing(s.title, 'unrouted');

  // "Fetch newest" does not ask a source the admin has switched off, for anything. The verdict below
  // gates only the DOWNLOAD on isDisabled, which for the sweep is the right place (a disabled adapter
  // stays loaded, and the sweep's listing keeps the series page's ghost rows current); but a bulk button
  // over 500 series on one disabled source would ask that source for 500 listings, 1.5 s apiece, to say
  // "disabled" 500 times. Filtered out of `followed` here so the listing loop, the source ranks and the
  // refusal set below all see only sources that may be asked; a series with nothing left is its verdict
  // with no network call (`asked: false`, so bulkNewest does not pace for it either). A source disabled
  // between this filter and the verdict still meets the check below.
  // Reintroduce by dropping this filter: "a disabled source is never asked for its listing" in
  // updater.int.test.ts counts one listing call.
  if (opts.newestOnly) {
    const askable: typeof followed = [];
    for (const f of followed) if (!(await isDisabled(f.source).catch(() => false))) askable.push(f);
    if (!askable.length) return { ...nothing(s.title, 'ok'), newest: { number: null, state: 'disabled' } };
    followed = askable;
  }

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
  if (!answered) { await stampChecked(seriesId, null, null); return { ...nothing(s.title, 'source_error'), asked: true }; }

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
  // "On disk" includes the tombstones the library keeps on purpose -- a chapter the read-chapter cleanup
  // or Delete files removed is not fetched back every night -- but NOT a row the verify task marked
  // `missing`: that file is gone without anyone deciding so (a database-only restore), and fetching it
  // again is the recovery. heldBooks in lib/chapterCleanup.ts is that rule, in one place.
  // Reintroduce by dropping the heldBooks predicate: "the sweep fetches a chapter the verify task marked
  // missing" in verifyFiles.int.test.ts asks for nothing.
  const heldRows = await q<{ number: number; pruned_at: string | null }>(`SELECT number, pruned_at FROM lib_books WHERE series_id=$1 AND ${heldBooks()}`, [seriesId]);
  const have = new Set(heldRows.map((r) => Number(r.number)));
  // The held numbers a LIVE row stands behind. The sweep needs only `have`; "Fetch newest" tells a
  // number we hold as pages apart from one we hold only as a deliberate tombstone (see the verdict below).
  const live = new Set(heldRows.filter((r) => r.pruned_at == null).map((r) => Number(r.number)));
  const missing = wanted.filter((c) => !have.has(c.number)).sort((a, b) => a.number - b.number);
  await stampChecked(seriesId, releases.length, missing.length);
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
  const cappedNums = new Set(ledger.filter((r) => Number(r.attempts) >= CHAPTER_RETRY_CAP).map((r) => Number(r.number)));
  const persistentVia = new Map(
    ledger
      .filter((r) => (r.status === 'rate_limited' || r.status === 'blocked') && Number(r.attempts) >= 2)
      .map((r) => [Number(r.number), r.source_id]),
  );
  // A number being held for its preferred group is still missing -- "{n} behind" must say so -- but it is
  // not fetched: the whole point of the hold is that the copy on offer is not the one wanted yet.
  const heldNums = new Set(held);
  const eligible = missing.filter((c) => !cappedNums.has(c.number) && !heldNums.has(c.number));
  const capped = missing.filter((c) => cappedNums.has(c.number)).length;
  const waiting = missing.filter((c) => heldNums.has(c.number)).length;

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
    const top = releases.reduce<SourceChapter | null>((best, c) => (best && best.number >= c.number ? best : c), null);
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
  if (tagged.length) await replaceListing(seriesId, listingRows(tagged, releases, heldNums, s.source_id, releaseOrder(prefs, chooseOpts))).catch(() => {});

  let added = 0;
  let failed = 0;
  let switched = 0;
  let partial = 0;
  let diskFull = false;
  let attempts = 0;
  const landed: Landed[] = [];
  // A source that has refused once this run is not asked again, but the others still are: a rate-limited
  // primary must not stop the follower's chapters, which are the reason the follower was added. The loop
  // ends only when every followed source is refusing -- which for a series with one source is the first
  // refusal, as before -- so each source still costs at most one strike per run. The set is written by
  // the fallback helper (a copy that earns `blockStatus` puts its source here) and read by it (a chosen
  // copy on a refusing source is skipped, and the number is taken from another followed source instead).
  const refusing = new Set<string>();
  // Which sources the sweep may reach on this series' behalf, for the alternates and the hunt: never an
  // adult source on a clean series (lib/sourceHunt.ts sweepAllowedFor), and never past the viewer's own
  // cap when a viewer drove the run. The chosen copy itself is not gated -- a person followed that source.
  // Asked only when there is something to download: a listing refresh (maxNew 0) costs no extra query.
  const adult = queue.length > 0 && maxNew > 0 ? await seriesIsAdult(seriesId) : false;
  const sweepRule = await sweepAllowedFor(adult);
  const allowed = (id: string) => sweepRule(id) && (opts.sourceAllowed?.(id) ?? true);
  const huntBudget = opts.hunt === false || opts.newestOnly ? null : (opts.hunt ?? { left: HUNT_MAX_PER_SWEEP });
  const meta = { series: s.title, summary: s.summary, author: s.author, genres: s.genres, url: s.web, status: s.status };
  // oldest-missing-first: a partial "first N" add fills forward coherently, and new releases (all > our max)
  // are still the only gap once a series is fully downloaded. (`queue` is `eligible` unless newestOnly.)
  for (const ch of queue) {
    if (attempts >= maxNew) break;
    if (runtime.stopping) break; // between chapters, never mid-write
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
        alternates: async () => copiesOf(tagged, ch.number, prefs, chooseOpts).filter((c) => c !== ch),
        refusing, allowed,
        hunt: huntBudget ? async () => (await huntSource(seriesId, ch.number, { allowed, budget: huntBudget })).chapter : undefined,
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
        number: ch.number, scanlator: out.chapterUsed.scanlator, source: out.via,
        // 1-based, as setBookMeta writes lib_books.missing_pages; the helper reports indices.
        ...(out.kind === 'partial' ? { missing: out.missing.map((i) => i + 1) } : {}),
      });
    } else if (out.kind === 'skipped') {
      // The file was there but no row was: a download nobody scanned. Told apart from `queued` so "Fetch
      // newest" scans the folder and reports the chapter as already here rather than as a failed fetch.
      if (out.why === 'on_disk' && newest && newest.number === ch.number) newest = { ...newest, state: 'on_disk' };
      // Never asked -- its source is refusing and nothing else lists it -- is the old loop's `continue`:
      // not an attempt, not a failure, and no ledger row towards the retry cap for a chapter nobody tried.
      if (out.why === 'refusing') attempts--;
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
  if (added) notifyNewChapter(seriesId, s.title, added).catch(() => {});
  // backfill release dates onto already-scanned books; freshly downloaded ones are stamped after the sweep's scan
  await setBookDates(s.folder, releases).catch(() => {});
  // Provenance goes only onto what LANDED, never onto the whole listing: the chosen copy for a number can
  // change between runs, and the file on disk does not change with it.
  await setBookMeta(s.folder, landed).catch(() => {});
  return { title: s.title, added, available: releases.length, outcome: 'ok', failed, waiting, switched, partial, landed, capped, folder: s.folder, chapters: releases, diskFull, asked: true, ...(newest ? { newest } : {}) };
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
  /** Of `added`, chapters taken from another source than the chosen copy's, and chapters saved with pages missing. */
  switched: number; partial: number;
  /** Partial chapters from earlier sweeps that this one made whole (the completion pass, lib/partial.ts). */
  completed: number;
  /** Every series this sweep landed chapters for, with its title and how many: the digest's material
   *  (lib/notify, #70). Optional so a test's stand-in sweep need not invent one. */
  newChapters?: DigestSeries[];
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
  let switched = 0;
  let partial = 0;
  let completed = 0;
  let stopped: SweepStop | undefined;
  // One hunt budget for the whole night (lib/sourceHunt.ts): however many chapters fail, the sweep
  // searches other sources at most HUNT_MAX_PER_SWEEP times.
  const huntBudget = { left: HUNT_MAX_PER_SWEEP };
  // Tallied so the caller can say what happened. `updateSeries` throwing outright is its own outcome:
  // catching it into `{ added: 0 }` is what made "the database went away mid-sweep" read as "nothing new".
  // `skipped` is what the budget or a parked source left unvisited: not a failure, and not nothing either.
  const outcomes: Record<UpdateOutcome | 'threw' | 'skipped', number> = { ok: 0, gone: 0, unrouted: 0, blocked: 0, source_error: 0, threw: 0, skipped: 0 };
  const dated: { folder: string; chapters: SourceChapter[]; landed: Landed[] }[] = [];
  const newChapters: DigestSeries[] = [];

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
      const r = await updateSeries(id, Math.min(opts.maxNew ?? 10, Math.max(1, sweepMax - spent)), { hunt: huntBudget })
        .catch(() => ({ added: 0, outcome: 'threw' as const, failed: 0, landed: [] } as { added: number; outcome: 'threw'; failed: number; folder?: string; chapters?: SourceChapter[]; landed: Landed[]; diskFull?: boolean; switched?: number; partial?: number }));
      added += r.added;
      chapterFailures += r.failed ?? 0;
      capped += (r as { capped?: number }).capped ?? 0;
      switched += r.switched ?? 0;
      partial += r.partial ?? 0;
      spent += r.added + (r.failed ?? 0);
      outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
      if (r.added && r.folder && r.chapters?.length) dated.push({ folder: r.folder, chapters: r.chapters, landed: r.landed });
      // The throw fallback above has `added: 0` and no title, so it can never reach the digest.
      if (r.added && (r as { title?: string }).title) newChapters.push({ id, title: (r as { title: string }).title, added: r.added });
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

  // The completion pass: partial chapters from earlier sweeps, oldest-stamped first, each asked for exactly
  // its missing pages (lib/partial.ts). Only when the sweep itself ran to its end -- a night the budget,
  // the disk or a shutdown cut short leaves them for the next one -- and each attempt counts against the
  // budget like a chapter, so a full night's work stays a full night's work. 1500 ms apart, as the series
  // loop paces itself. A partial whose source is in a cooldown is skipped by completePartial itself.
  if (!stopped && PARTIAL_COMPLETE_MAX > 0) {
    const partials = await q<{ id: string; series_id: string; root: string; file: string; number: number; missing_pages: number[]; source_id: string | null }>(
      `SELECT b.id, b.series_id, b.root, b.file, b.number, b.missing_pages, b.source_id
         FROM lib_books b JOIN lib_series s ON s.id = b.series_id
        WHERE b.missing_pages IS NOT NULL AND b.pruned_at IS NULL AND b.root = $1 AND ${visibleToAll('s')}
        ORDER BY b.updated_at ASC LIMIT $2`, [DL_ROOT, PARTIAL_COMPLETE_MAX],
    ).catch(() => []);
    for (const b of partials) {
      if (runtime.stopping) { stopped = 'shutdown'; break; }
      if (spent >= sweepMax) { stopped = 'budget'; break; }
      spent++;
      try {
        const allowed = await sweepAllowedFor(await seriesIsAdult(b.series_id));
        const r = await completePartial(
          { ...b, number: Number(b.number) },
          {
            alternates: () => listingAlternates(b.series_id, Number(b.number), b.source_id),
            allowed,
            hunt: async () => (await huntSource(b.series_id, Number(b.number), { allowed, budget: huntBudget })).chapter,
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
  }
  // `healthy` is the question the admin panel should have been asking all along: was this a quiet night, or
  // did nothing work? A run where every source failed now looks nothing like one where nothing was new.
  const broken = outcomes.source_error + outcomes.threw;
  return {
    series: rows.length, visited, added, failed: broken, chapterFailures, capped, outcomes, stopped, switched, partial, completed,
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
  return row.copies
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
export function runSweep(opts: SweepOpts, log: SweepLog, sweep: typeof runUpdateAll = runUpdateAll): Promise<SweepResult | null> | false {
  if (runtime.updating || runtime.repairing) return false;
  // Set before the first await, so two starts in the same turn of the event loop cannot both get through.
  runtime.updating = true;
  return (async () => {
    try {
      const r = await sweep(opts);
      runtime.lastUpdate = Date.now();
      // Persisted so a restart schedules the remainder of the interval rather than a whole new one.
      await q(`UPDATE server_settings SET updater_last_run = now() WHERE id = 1`).catch(() => {});
      runtime.lastUpdateResult = {
        series: r.series, visited: r.visited, added: r.added, failed: r.failed,
        chapterFailures: r.chapterFailures, switched: r.switched, partial: r.partial,
        completed: r.completed, healthy: r.healthy, stopped: r.stopped,
      };
      // A sweep that added nothing because nothing was new, and one that added nothing because every source
      // was down, used to print the identical line. They no longer do. Nor does a sweep that finished look
      // like one the budget or the disk cut short.
      const scope = `visited ${r.visited} of ${r.series} series${r.stopped ? ` (stopped: ${r.stopped})` : ''}`;
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
      runtime.lastUpdate = Date.now();
      runtime.lastUpdateResult = null;
      log.error(e);
      return null;
    } finally {
      runtime.updating = false;
    }
  })();
}
