import { hash } from '@node-rs/argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { q, one, tx } from '../lib/db';
import { postingOrderSeries, POSTING_ORDER_REFUSAL } from '../lib/numbering';
import numberingRoutes from './numbering';
import { lastNumber } from '../lib/chapterRanges';
import findSourcesRoutes from './findSources';
import autoHeroRoutes from './autoHero';
import rescanRoutes from './rescan';
import { content as komga } from '../lib/backend';
import { cacheBytes } from '../lib/imageCache';
import { runtime } from '../lib/runtime';
import { persistScan, libraryIdFor, libraryRows, LIBRARY_ROOT, DL_ROOT, setBookDates, setBookMeta } from '../lib/library';
import { applyMoves, heldElsewhere, lockLibrarySaves, previewMoves, setFolders, storedFolders, underSql, LIBRARY_MAX_FOLDERS } from '../lib/libraryFolders';
import { containedPath, allWritable } from '../lib/fsGuard';
import { deleteSeries, restoreSeries, mergeSeries, mergeRefusal, getSeriesRow, deleteSeriesFiles, renameSeriesFolder, forgetSeries, diskSpelling, deleteChapterFiles } from '../lib/libraryAdmin';
import { editionFollowing, linkEdition, linkPair, unlinkEdition, workRows } from '../lib/editions';
import { toStoredRel, trimTrailingSlashes } from '../lib/relPath';
import { runFingerprintBackfill, fingerprintRemaining, fpState } from '../lib/fingerprintJob';
import { runPageHashBackfill, pageHashRemaining, phState } from '../lib/pageHashJob';
import { runBackup } from '../lib/backup';
import { runUpdateAll, updateSeries, runSweep } from '../lib/updater';
import { ARCHIVE_SETTINGS_COLS, ARCHIVE_SETTINGS_SHAPE, archiveWindowPair, applyArchiveSettings, archiveFreeGb } from '../lib/archive';
import { runChapterCleanup, cleanupSettings, dueCountCached, tombstoneBooks } from '../lib/chapterCleanup';
import { runVerify, verifyState } from '../lib/verifyFiles';
import { startRescan } from '../lib/rescan';
import { runRepair, repairState, repairLiveSnapshot, REPAIR_HOURS, REPAIR_LIMITS, REPAIR_STEPS, REPAIR_SHORT_MAX, REPAIR_GAPS_MAX, type RepairSkip, type RepairStep } from '../lib/repair';
import { listRunRecords, runDigest, type RunTarget } from '../lib/repairRuns';
import { worstCase } from '../lib/repairEstimate';
import { authenticate, requireAdmin, userIdOf, roleOf, revokeAllSessions, revokeRefreshTokenById, passwordError } from '../lib/auth';
import { logAudit, recentAudit } from '../lib/audit';
import { recordAltTitles } from '../lib/altTitles';
import { healthAllWithEvidence, setDisabled, clearBlock, pruneOrphanedHealth, isDisabled, blockedNow } from '../lib/sourceHealth';
import { smokeTest } from '../lib/sourceProbe';
import { startSourceCheck, checkRunning, checkProgress } from '../lib/sourceWatchdog';
import { testSource } from '../lib/sourceCheck';
import { currentFailures, stageLines } from '../lib/sourceEvidence';
import { runExtensionMonitor, runExtensionCheck, extState, liveStore as extensionStore } from '../lib/extensionMonitor';
import { readSites, writeSites } from '../lib/sources/customSites';
import { reloadAll, listSources, getSource, detectEngine, listRemoteSources, suwayomiConfigured, suwayomiAbout, swAdapterId, withTimeout } from '../lib/sources';
import {
  listExtensions, refreshExtensions, setExtensionState, sourcesOfExtension, getRepos, setRepos, altRepoUrl,
  parseRepoInput, repoKey, contributedBy, engineReason, REPO_MESSAGES, type ExtensionInfo,
} from '../lib/sources/suwayomi/extensions';
import { getHiddenLangs, setSourcesEnabled, adoptExtensionSources, langOverview, turnOnExtensionSources } from '../lib/sources/suwayomi/langs';
import { lastSuwayomiLoad, rememberMissing } from '../lib/sources/suwayomi/register';
import { engineStatusReport, connectEngineSolver } from '../lib/extensionEngine';
import { env } from '../env';
import { readFile, writeFile, mkdir, rm, rename, stat } from 'fs/promises';
import { dirname, resolve } from 'path';
import sharp from 'sharp';
import { ART_BODY_LIMIT, ART_DIR, artFile, artOverview } from '../lib/seriesArt';
import { writePreflight } from '../lib/fsGuard';
// Admin stats report on the whole library by definition; this route is already behind requireAdmin.
import { NO_LIBRARIES, SYSTEM_CTX, visibleToAll, sanitiseAdultList, sanitiseSourceIds, invalidateAdultFilter, browsableIds, nameableIds, viewCtxFor, hideAdult } from '../lib/visibility';
import { cleanSourceOrder, invalidateSourcePrefs } from '../lib/sourcePrefs';
import { borrowNamesFor, clearBorrowedNames } from '../lib/borrowNames';
import { sanitiseNoticeTypes } from '../lib/noticeChapters';
import { seriesHidesNotices, hiddenCount, refreshNoticesActive } from '../lib/noticeSettings';
import { SERIES_TYPES, isKnownSeriesType, learnTypeFromAniList } from '../lib/seriesType';
import { addSeriesFromSource, findBestMatch, resolveCandidate, norm, jobBusy, startDownloadJob, clearLatestCache, FILL_MAX_CHAPTERS, REFRESH_BUDGET_MS } from './sources';
import { confirmsTitle } from '../lib/confirmTitle';
import { chapterFileRel } from '../lib/downloader';
import { REFETCH_BAK } from '../lib/fsAtomic';
import type { SourceChapter } from '../lib/sources/types';
import { getPlan, followable } from '../lib/fill';
import { followGuard, seriesLanguage, sourceLanguage } from '../lib/seriesLang';
import { say, saidOf } from '../lib/said';
import { prefsSchema, readGlobalPrefs, readSeriesPrefs, effectivePrefsFor } from '../lib/scanlatorPrefs';
import { groupsOf, normGroup } from '../lib/releases';
import { groupStats, emptyGroupStat, type StatCopy } from '../lib/groupStats';
import { copyToChapter, type ListingCopy } from '../lib/seriesListing';
import { seriesSourcesFor } from '../lib/seriesSources';
import { switchMainSource } from '../lib/mainSource';
import { refileFailures } from '../lib/chapterFailures';
import { mainUses, retireSource } from '../lib/retireSource';
import { sourcesOverview } from '../lib/sourcesOverview';
import { titlesFromBackup, entriesFromBackup, type BackupEntry } from '../lib/tachibk';
import { linkSeries, seedTrackerFloor } from '../lib/trackers';
import { ADAPTERS, PROVIDERS, LIST_STATUSES, TRACKER_LIST_MAX, type Provider, type LibraryEntry } from '../lib/trackerProviders';
import { open as unseal } from '../lib/secretbox';
import { findingOf, runHealthChecks } from '../lib/health';
import { autofixRun, autofixSeriesIds, autofixState, scrubAutofixRecord, scrubAutofixRun, startAutofix, stopAutofix } from '../lib/autofix';
import { IGNORABLE_CHECKS, ignoreFinding, unignoreFinding } from '../lib/healthIgnore';
import { readHealthSummary, scheduleHealthSummaryRefresh, storeHealthSummary } from '../lib/healthSummary';
import { titlesFromMangadexList, entriesFromMangadexList } from '../lib/mangadexList';
import { MANGADEX_LANGS, canonLang, mdLang, setUnstatedLang } from '../lib/lang';
import { cleanMangadexLangs, mangadexLangs, setMangadexLangs, syncMangadexSources } from '../lib/sources/mangadexLangs';
import { fetchAniListArt, fetchAniListCandidates, fetchAnimeBanner } from '../lib/anilist';
import { READING_DIRECTIONS } from '../lib/komgaDto';
import { learnDirection, directionFromAniListMatch } from '../lib/readingDirection';
import { fetchKitsuBanner } from '../lib/kitsu';
import { randomBytes } from 'crypto';
import { appVersion } from '../lib/appVersion';
import { PING_URL, buildPayload, installFacts, monthlyId, newSecret, sendForget } from '../lib/installPing';
import { withOrigin } from '../lib/downloadActivity';

type ImportJob = { running: boolean; total: number; done: number; added: number; already: number; notFound: number; failed: number; startedAt: number; details: Array<{ title: string; status: string; source?: string }> };
let importJob: ImportJob | null = null;

/**
 * Reviewable import (backup / MangaDex list / paste → per-title match review → add), the fix for "import
 * forces an entry with no way to correct it". Unlike `importJob` above, this has a human in the middle who
 * may take a long time, so state lives in `import_batches`/`import_candidates` (migrate.ts) rather than in
 * memory — a restart or a closed tab must not throw away a finished resolve pass or a reviewer's picks.
 *
 * `resolvingBatch` is still an in-memory guard, same idea as `importJob.running`: it caps the SEARCH FAN-OUT
 * to one batch at a time server-wide (matching or resuming another batch while this one is mid-resolve would
 * double the outbound request rate to every source). It does not gate `/run` — adding series after review is
 * cheap to run concurrently with a second batch's resolve pass, and gating it too would only serve to make
 * reviewing batch A slower while batch B imports.
 *
 * `importingBatches` is the same kind of witness for `/run`: the batches whose add loops THIS process is
 * running -- a set, not one id, precisely because `/run` is not serialised across batches and a second
 * batch's run must not make the first look abandoned. A batch that reads `importing` in the database while
 * nobody here is importing it was stranded by a restart mid-run; GET flips it back to `review` (its rows
 * without a status are still ready, and `/run` only ever picks up rows it has not processed, so running
 * again is safe). Without that, such a batch polled "Importing…" forever: `/run` answered busy, `/resume`
 * answered not-resolving, the sweep skipped it.
 *
 * `aborted` is how DELETE reaches a loop already in flight. Both loops check it before picking up their next
 * row, so discarding a batch mid-resolve stops the searching (the fan-out the guard above exists to cap --
 * before this, clearing `resolvingBatch` let a NEW batch start while the old loop kept searching) and
 * discarding mid-run stops adding series for a batch that no longer exists. The row in flight finishes;
 * its writes then target rows the CASCADE removed and affect nothing.
 */
let resolvingBatch: string | null = null;
const importingBatches = new Set<string>();
const aborted = new Set<string>();
const RESOLVE_CONCURRENCY = 3;
/** Batches nobody is reviewing any more: a finished batch a week on, an unfinished one a month on. */
const SWEEP_DONE_DAYS = 7;
const SWEEP_OPEN_DAYS = 30;

interface ImportBatchRow {
  id: string; user_id: string; origin: string; state: string;
  /** Which service a `tracker` batch was read from; null for the other intakes. */
  tracker: string | null;
  total: number; resolved: number; added: number; already: number; failed: number;
  /** The intake's note about the read (migrate.ts): novels dropped, and whether the list was cut at 500. */
  skipped_novels: number; truncated: boolean;
  created_at: string; updated_at: string;
}
/**
 * A batch as the routes answer it: the intake note under the names the POST already answers with
 * (`skippedNovels`, `truncated`), so the page reads one shape whether it came from the POST or from a later
 * GET, and the snake-case column does not ride along as a second copy of the same number.
 */
function batchDto<T extends ImportBatchRow>(row: T): Omit<T, 'skipped_novels'> & { skippedNovels: number } {
  const { skipped_novels: skippedNovels, ...rest } = row;
  return { ...rest, skippedNovels };
}
interface ImportCandidateRow {
  id: string; batch_id: string; ord: number; backup_title: string;
  backup_source_id_unsigned: string | null; backup_source_id_signed: string | null; backup_url: string | null;
  in_library: boolean; decision: string; confidence: string | null;
  match_source: string | null; match_source_id: string | null; match_title: string | null; match_cover: string | null;
  auto_source: string | null; auto_source_id: string | null; auto_title: string | null; auto_cover: string | null; auto_confidence: string | null;
  status: string | null;
  /** Tracker rows only (migrate.ts says what each is for); null / empty on the other intakes. */
  tracker: string | null; external_id: string | null; alt_titles: string[]; matched_via: string | null; progress: number | null;
}

/**
 * One entry as the intakes hand it to the batch: a backup entry, plus what a tracker's list knows that a
 * backup does not. Local to this file rather than widening `BackupEntry` in lib/tachibk.ts, which is the
 * shape of ONE file format and should not grow fields no backup carries.
 */
type IntakeEntry = BackupEntry & {
  altTitles?: string[];
  tracker?: Provider;
  externalId?: string;
  progress?: number;
};

/**
 * Link an imported (or already-owned) series to the tracker entry its row came from, and record how far
 * the person is there. `userId` is the account whose list was read -- the batch's owner, which at intake is
 * the caller and at /run may not be -- and it is `linked_by`, not null: the id came off THEIR list, which
 * is a human's choice and must not be overwritten by the art path's automatic AniList match
 * (routes/images.ts links with linked_by NULL and leaves a human's link alone). ⚠️ The floor is not
 * optional, and it is the owner's for the same reason: `seedTrackerFloor` is what
 * keeps the first chapter finished here from pushing chapter 1 over an entry at chapter 150 -- the failure
 * lib/trackers.ts calls unrepairable. Both writes swallow their own errors, so a tracker hiccup never fails
 * the import.
 */
async function linkImportedSeries(
  row: { tracker: string | null; external_id: string | null; backup_title: string; progress: number | null },
  seriesId: string,
  userId: string,
): Promise<boolean> {
  if (!row.tracker || !row.external_id || !PROVIDERS.includes(row.tracker as Provider)) return false;
  const provider = row.tracker as Provider;
  await linkSeries(seriesId, row.external_id, row.backup_title, userId, provider);
  // Every language edition of its work is the same entry (v0.52.0): linked too, so progress syncs from whichever is
  // read. The floor is seeded once, here: lib/trackers.ts pushOne holds the entry's floor over all of them.
  const siblings = await q<{ id: string }>(
    `SELECT o.id FROM lib_series s JOIN lib_series o ON o.work_id = s.work_id AND o.id <> s.id
      WHERE s.id = $1 AND s.work_id IS NOT NULL AND o.merged_into IS NULL`, [seriesId]).catch(() => [] as Array<{ id: string }>);
  for (const sib of siblings) await linkSeries(sib.id, row.external_id, row.backup_title, userId, provider);
  await seedTrackerFloor(userId, seriesId, provider, row.progress ?? 0);
  return true;
}

/** How a tracker read ends: entries for the batch, or an answer the route sends as-is. */
type TrackerRead =
  | { entries: IntakeEntry[]; skippedNovels: number; capped: boolean }
  | { status: 404 | 422 | 502; error: 'not_connected' | 'tracker_rejected' | 'token_expired' | 'tracker_unavailable'; message: string };

/** The sentence a rejected token leaves on the connection -- pushOne's (lib/trackers.ts), word for word. */
const TOKEN_REJECTED_ERROR = 'the tracker rejected the saved token -- reconnect to resume syncing';
/** The sentence a lapsed token leaves on the connection -- pushOne's again, word for word. */
const TOKEN_EXPIRED_ERROR = 'the access token has expired -- reconnect to resume syncing';
const CONNECT_HINT = 'Profile → Connections → Progress tracking';

/**
 * Read the requesting admin's OWN list from a tracker, as batch entries. Only their own `user_trackers` row
 * is consulted: an admin cannot import from another member's account, whatever the request names.
 *
 * Failures are answers rather than throws because each means something different to the person: no
 * connection (404 `not_connected`); a token the service refused (422 `tracker_rejected` -- and the
 * connection is disabled with the same sentence a rejected push writes, since a token the service refuses
 * will refuse every future chapter too, and Profile then shows one message for both); a service that did
 * not answer (502 `tracker_unavailable`, nothing changed); a token past its `expires_at` (422
 * `token_expired`, answered BEFORE the service is called and without disabling -- the same note a push
 * leaves, because MyAnimeList answers a lapsed token with 401, which the branch below would otherwise read
 * as a refusal and switch the connection off, so one condition got two explanations and one of them killed
 * sync). ⚠️ Only `authFailed` disables: the adapters promise a plain error for anything else, and a 400 or
 * a timeout must never switch someone's sync off.
 * ⚠️ 422, not 401, for the refused token: the web's `api()` answers a 401 by refreshing the session and
 * retrying the request once, and that retry would find the connection just disabled and read
 * `not_connected` -- the person would never see why.
 *
 * Light novels are dropped and counted: tracker "manga" lists carry them, and a novel resolves to its
 * manga adaptation on every source, so importing one would link the NOVEL entry to the manga and push
 * manga chapter counts into it. Entries are deduped by their id and by the normalised form of EVERY name
 * they go by, because an English row and a romaji row of one work otherwise resolve to two source titles
 * and both get added.
 */
async function readTrackerList(userId: string, provider: Provider, statuses: (typeof LIST_STATUSES)[number][]): Promise<TrackerRead> {
  const label = ADAPTERS[provider].label;
  const conn = await one<{ access_token: string; enabled: boolean; expires_at: string | null }>(
    'SELECT access_token, enabled, expires_at FROM user_trackers WHERE user_id = $1 AND provider = $2', [userId, provider],
  );
  if (!conn || !conn.enabled) {
    return { status: 404, error: 'not_connected', message: `Connect ${label} under ${CONNECT_HINT} first.` };
  }
  if (conn.expires_at && new Date(conn.expires_at).getTime() < Date.now()) {
    // Reported, not disabled, and the service is not asked: a lapsed token is a known condition with a
    // known repair, and pushOne (lib/trackers.ts) already says so on the connection in these words.
    await q('UPDATE user_trackers SET last_error = $3 WHERE user_id = $1 AND provider = $2',
      [userId, provider, TOKEN_EXPIRED_ERROR]).catch(() => {});
    return { status: 422, error: 'token_expired', message: `The ${label} token has expired — reconnect it under ${CONNECT_HINT}.` };
  }
  const token = unseal(conn.access_token);
  if (!token) {
    // Not a refusal by the service, so the connection stays enabled; the same note pushOne leaves.
    await q('UPDATE user_trackers SET last_error = $3 WHERE user_id = $1 AND provider = $2',
      [userId, provider, 'stored token could not be read -- reconnect to resume syncing']).catch(() => {});
    return { status: 422, error: 'tracker_rejected', message: `The saved ${label} token could not be read — reconnect it under ${CONNECT_HINT}.` };
  }
  let list: LibraryEntry[];
  try {
    list = await ADAPTERS[provider].listLibrary(token, { statuses, max: TRACKER_LIST_MAX });
  } catch (e) {
    const err = e as Error & { authFailed?: boolean };
    if (err.authFailed) {
      await q('UPDATE user_trackers SET enabled=false, last_error=$3 WHERE user_id=$1 AND provider=$2',
        [userId, provider, TOKEN_REJECTED_ERROR]).catch(() => {});
      return { status: 422, error: 'tracker_rejected', message: `${label} rejected the saved token — reconnect it under ${CONNECT_HINT}.` };
    }
    return { status: 502, error: 'tracker_unavailable', message: `${label} did not answer just now. Try again in a moment.` };
  }

  const entries: IntakeEntry[] = [];
  let skippedNovels = 0;
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  for (const e of list) {
    if (e.format === 'novel') { skippedNovels++; continue; }
    const title = (e.title ?? '').trim();
    if (!title || !e.externalId) continue;
    if (seenIds.has(e.externalId)) continue;
    const titleKey = norm(title);
    const altTitles: string[] = [];
    for (const raw of e.altTitles ?? []) {
      const a = raw.trim();
      const k = norm(a);
      if (!a || !k || k === titleKey || altTitles.some((x) => norm(x) === k)) continue;
      altTitles.push(a);
    }
    const names = [titleKey, ...altTitles.map(norm)].filter(Boolean);
    if (names.some((n) => seenNames.has(n))) continue;
    seenIds.add(e.externalId);
    for (const n of names) seenNames.add(n);
    entries.push({ title, altTitles, tracker: provider, externalId: e.externalId, progress: Math.max(0, Math.floor(e.progress || 0)) });
  }
  // `capped`: the read stopped at the cap, so the list may hold more than was seen -- reported as
  // truncated even when novels and duplicates brought the kept rows under 500.
  return { entries, skippedNovels, capped: list.length >= TRACKER_LIST_MAX };
}

/**
 * Resolve every still-unresolved, non-skipped row of a batch against the user's sources, `RESOLVE_CONCURRENCY`
 * at a time, writing each result as it lands so `GET .../batches/:id` fills in progressively under a 2s poll
 * instead of staying empty for the whole pass. Rows the resolve pass can't match are left `unresolved` — once
 * the batch flips to `review` that means "no match found" rather than "not looked at yet", which is exactly
 * the ambiguity the batch's own `state` exists to remove (see the column comment in migrate.ts).
 */
async function resolveBatch(batchId: string): Promise<void> {
  resolvingBatch = batchId;
  try {
    const rows = await q<ImportCandidateRow>(
      `SELECT * FROM import_candidates WHERE batch_id = $1 AND decision = 'unresolved' ORDER BY ord`,
      [batchId],
    );
    // `resolved` restarts from the rows this pass will NOT touch (already owned, matched, picked or skipped),
    // not from where the previous pass left it: a resumed batch re-queues every row that got no match the
    // first time, and counting those a second time pushed the progress bar past its total.
    await q(`UPDATE import_batches SET resolved = total - $2, updated_at = now() WHERE id = $1`, [batchId, rows.length]).catch(() => {});
    let next = 0;
    const worker = async () => {
      for (;;) {
        if (aborted.has(batchId)) return; // discarded mid-pass: do not pick up another row
        const row = rows[next++];
        if (!row) return;
        try {
          const m = await resolveCandidate({
            title: row.backup_title,
            // A tracker row's other names (romaji, synonyms): searched only after the English title finds
            // nothing, because a source that carries the work under its romaji title is the same match.
            altTitles: row.alt_titles?.length ? row.alt_titles : undefined,
            url: row.backup_url ?? undefined,
            sourceIdUnsigned: row.backup_source_id_unsigned ?? undefined,
            sourceIdSigned: row.backup_source_id_signed ?? undefined,
          });
          if (m) {
            // `matched_via` is the alternate that found it (null for the search title), so the review row
            // can say "matched under its other name" instead of flagging a romaji hit as a wrong pick.
            await q(
              `UPDATE import_candidates SET decision = 'auto', confidence = $2,
                 match_source = $3, match_source_id = $4, match_title = $5, match_cover = $6,
                 auto_source = $3, auto_source_id = $4, auto_title = $5, auto_cover = $6, auto_confidence = $2,
                 matched_via = $7
               WHERE id = $1`,
              [row.id, m.confidence, m.source, m.sourceId, m.title, m.coverUrl ?? null, m.matchedVia ?? null],
            );
          }
        } catch { /* leave unresolved — surfaces as "no match found" once the batch reaches review */ }
        await q(`UPDATE import_batches SET resolved = resolved + 1, updated_at = now() WHERE id = $1`, [batchId]).catch(() => {});
      }
    };
    await Promise.all(Array.from({ length: Math.min(RESOLVE_CONCURRENCY, rows.length) || 1 }, worker));
    // Only from 'resolving': a batch deleted mid-pass (DELETE cascades the rows away) or already moved on
    // must not be resurrected by a resolve loop that started before either happened.
    await q(`UPDATE import_batches SET state = 'review', updated_at = now() WHERE id = $1 AND state = 'resolving'`, [batchId]).catch(() => {});
  } finally {
    if (resolvingBatch === batchId) resolvingBatch = null;
    aborted.delete(batchId);
  }
}

/**
 * Close a `review` batch that has nothing left to import: every row is either skipped or carries a
 * status. Returns the batch when it was closed, null when it was left alone.
 *
 * `/run`'s tail applies this rule, but only at the end of a run. A batch whose leftovers -- a title no
 * source carries, a matched row left unselected -- were skipped AFTERWARDS never got a second run (`/run`
 * refuses with `nothing_to_import`), so it read "Ready to review" in the Open imports list for the thirty
 * days until the sweep, and the only exit was Discard, whose dialog says the review is thrown away.
 * Called after a skip (the act that makes a batch leftover-free) and on every GET of a `review` batch (a
 * batch closed under the old rule by someone else's tab, or left half-done by a version without this).
 *
 * ⚠️ Only a batch a run has been through (`EXISTS ... status IS NOT NULL`). A backup whose every title
 * is already in the library skips every row up front and is leftover-free from its first second; closing
 * it here would show "Done — 0 added · 0 already had" on first view and hide the one thing that batch has
 * to say, which is that every row is already owned. Its exit stays Discard.
 */
async function closeBatchIfSettled(batchId: string): Promise<ImportBatchRow | null> {
  return one<ImportBatchRow>(
    `UPDATE import_batches SET state = 'done', updated_at = now()
      WHERE id = $1 AND state = 'review'
        AND EXISTS (SELECT 1 FROM import_candidates WHERE batch_id = $1 AND status IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM import_candidates WHERE batch_id = $1 AND status IS NULL AND decision <> 'skip')
      RETURNING *`,
    [batchId],
  ).catch(() => null);
}

/**
 * Drop import batches nobody will come back to. Called daily from server.ts. Finished and discarded batches
 * go after `SWEEP_DONE_DAYS`: the series they added are their own lib_series rows, and each batch carries up
 * to 500 candidate rows. Batches still `resolving`/`review`/`importing` get `SWEEP_OPEN_DAYS` -- long enough
 * for a person genuinely working through 500 rows over a few evenings, short enough that a batch whose tab
 * was closed and forgotten does not sit in the "Open imports" list for ever. `updated_at`, not `created_at`,
 * so every review action pushes the deadline out.
 */
export async function sweepImportBatches(): Promise<{ removed: number }> {
  const rows = await q<{ id: string }>(
    `DELETE FROM import_batches
      WHERE (state IN ('done','cancelled') AND updated_at < now() - make_interval(days => $1))
         OR (state IN ('resolving','review','importing') AND updated_at < now() - make_interval(days => $2))
      RETURNING id`,
    [SWEEP_DONE_DAYS, SWEEP_OPEN_DAYS],
  );
  return { removed: rows.length };
}

type ArtJob = { running: boolean; total: number; done: number; banners: number; covers: number; misses: number; startedAt: number };
let artJob: ArtJob | null = null;
// per-series "check for new chapters" runs, so the UI can poll instead of blocking on a long download
const seriesChecks = new Map<string, { running: boolean; added?: number; waiting?: number; error?: string; startedAt?: number; finishedAt?: number }>();
// The known-group list for GET /api/admin/scanlators, memoised for KNOWN_GROUPS_TTL (see the route).
let knownGroups: { at: number; content: Array<{ name: string; onDisk: number; listed: number; series: number }> } | null = null;
const KNOWN_GROUPS_TTL = 30_000;

/**
 * Stop a member's grant list from collapsing into "everything".
 *
 * Removing their last row leaves zero rows, and zero rows means EVERY library. So every path that can take
 * away the last one has to backstop it, or "remove their access" reads as "give them all of it".
 */
async function keepRestricted(qq: typeof q, userId: string): Promise<void> {
  const n = await qq<{ c: number }>('SELECT count(*)::int AS c FROM user_libraries WHERE user_id = $1', [userId]);
  if (!n[0]?.c) {
    await qq('INSERT INTO user_libraries (user_id, library_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [userId, NO_LIBRARIES]);
  }
}

/**
 * Which of these series this admin may see NAMED (v0.49.0): a repair run's target and current series are a
 * listing, so they follow /api/sources/jobs' rule for a run's "now on ..." -- the count stays, the title of a
 * series the viewer may not list (the 18+ hide, above all) goes. One query, and none when there is nothing.
 */
async function listable(req: FastifyRequest, ids: Array<string | undefined>): Promise<Set<string>> {
  const list = ids.filter((x): x is string => !!x);
  if (!list.length) return new Set();
  return browsableIds(list, await viewCtxFor(userIdOf(req), roleOf(req), { hideAdult: hideAdult(req) }));
}
/**
 * Which of these series this admin may see named in Fix everything's lines and its "Now:" (v0.55.1): their reach, judged
 * on each series as it stands whatever became of it since -- a merge names the series it merged away (visibility.ts
 * nameableIds). Asked only for an admin who hides 18+: with the reveal on, an admin's reach is everything. One query,
 * and none when there is nothing to ask.
 */
async function nameable(req: FastifyRequest, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  return nameableIds(ids, await viewCtxFor(userIdOf(req), roleOf(req), { hideAdult: hideAdult(req) }));
}
const scrubTarget = (t: RunTarget, ok: Set<string>): RunTarget =>
  (t.seriesId && !ok.has(t.seriesId) ? { ...t, label: undefined } : t);
const scrubSkips = (skips: RepairSkip[] | undefined, ok: Set<string>): RepairSkip[] =>
  (skips ?? []).map((k) => (k.target?.seriesId && !ok.has(k.target.seriesId) ? { ...k, target: { ...k.target, title: undefined } } : k));
/** The series a stored result's skips name, for `listable`. */
const skipIds = (r: { skips?: RepairSkip[] } | null | undefined) => (r?.skips ?? []).map((k) => k.target?.seriesId);
/**
 * A stored result as this admin may read it: its skips name series too (folder_busy, no_searches_left), on the
 * Tasks line's result, the latest one-off fix's and the status route's last full run. Reintroduce by sending any
 * of them as stored: "an admin who hides 18+ reads no adult title in the repair's answers" in
 * repairRoutes.int.test.ts finds the title.
 */
const scrubResult = <R extends { skips?: RepairSkip[] } | null | undefined>(r: R, ok: Set<string>): R =>
  (r?.skips?.length ? { ...r, skips: scrubSkips(r.skips, ok) } : r);

/** The run kinds the status route always estimates: the Health page's three chips, its cards and the nightly. */
const ESTIMATED_KINDS = ['full', 'fix_short', 'fill', 'retry', 'steps:solver', 'steps:short', 'steps:gaps', 'steps:failures', 'steps:failures:now'];

/** The most extensions GET /api/admin/extensions/catalog answers at once, and how many it answers when not asked. */
export const CATALOG_PAGE_MAX = 400;

export default async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireAdmin);
  // #116's extension settings and numbering routes: a child of this plugin, so the two hooks above gate them.
  await app.register(numberingRoutes);
  // v0.49.1: a series' other names and Find other sources, the same way (routes/findSources.ts).
  await app.register(findSourcesRoutes);
  // v0.51.0: a new automatic banner for a series, the same way (routes/autoHero.ts).
  await app.register(autoHeroRoutes);
  // v0.55.4: Rescan everything's preview and plan, the same way (routes/rescan.ts).
  await app.register(rescanRoutes);

  // Owned-library scan (Phase 1): walk the CBZ folder and upsert lib_series/lib_books. Stamps lastScan like
  // POST /api/refresh does (the Tasks row's "last run", and that route's one-a-minute rule), and asks the
  // header summary to catch up with what the scan found (v0.49.0).
  app.post('/api/admin/library/scan', async () => {
    runtime.lastScan = Date.now();
    const r = await persistScan();
    scheduleHealthSummaryRefresh();
    return r;
  });

  // Owned downloader/updater (Phase 2): pull new chapters from the source for one series or the whole library.
  app.post('/api/admin/update/:id', async (req) => withOrigin('check', userIdOf(req), () => updateSeries((req.params as { id: string }).id, Number((req.body as any)?.maxNew) || 10)));
  // Through runSweep, as the schedule and Run now are (#117): `runtime.updating` is the flag every other job --
  // the repair, the slow archive -- stands aside for, and a bare runUpdateAll here ran without it. 409 while a
  // sweep or a repair runs; the sweep's result, as before, when it ends.
  // Reintroduce by calling runUpdateAll bare: "POST /api/admin/update is refused while a sweep runs" in
  // sweepRunner.int.test.ts starts a second sweep on top of the first.
  app.post('/api/admin/update', async (req, reply) => {
    const run = runSweep({ onlyFavorites: !!(req.body as any)?.favorites, maxNew: Number((req.body as any)?.maxNew) || 10, by: userIdOf(req) }, app.log);
    if (!run) return reply.code(409).send({ error: 'busy', message: 'A chapter sweep or a library repair is already running.' });
    const r = await run;
    if (!r) return reply.code(500).send({ error: 'failed', message: 'The update run failed. The server log has the details.' });
    return r;
  });

  app.get('/api/admin/users', async () => ({
    content: await q(`SELECT u.id, u.username, u.display_name, u.role, u.avatar, u.created_at, u.disabled, u.perms, u.totp_enabled,
        u.max_age_rating,
        (SELECT max(created_at) FROM reading_events e WHERE e.user_id = u.id) AS last_active,
        -- NULL, not an empty array, when unrestricted: the UI must tell "every library, including ones
        -- added later" apart from "exactly these", and an empty array is a real setting meaning nothing.
        -- The NO_LIBRARIES marker is a row rather than a library, so it is filtered out of the list while
        -- still counting as "restricted" -- which is the whole point of it existing.
        (SELECT CASE WHEN count(*) = 0 THEN NULL
                     ELSE coalesce(array_agg(ul.library_id) FILTER (WHERE ul.library_id <> ''), '{}')
                END
           FROM user_libraries ul WHERE ul.user_id = u.id) AS libraries
      FROM users u ORDER BY u.created_at`),
  }));

  // ---- server settings ----
  const SETTINGS_COLS = 'server_name, allow_registration, updater_hours, extension_hours, extension_auto_update, '
    + 'update_check, install_ping, install_ping_last, scanlator_prefs, cleanup_read, cleanup_read_days, backup_hour, auto_follow_on_failure, '
    + 'repair_enabled, komga_ghost_chapters, adult_genres, adult_sources, source_prefs, group_upgrade, borrow_names, '
    + 'mangadex_langs, unstated_lang, hide_notice_types, '
    + ARCHIVE_SETTINGS_COLS;
  // `extensions_configured` is not a column: extension_hours has a NOT NULL default, so its presence says
  // nothing about whether there is an engine to check. The settings page needs to know, or it offers two
  // controls for a job that can never run.
  const settingsRow = async () => {
    const row = await one<any>(`SELECT ${SETTINGS_COLS} FROM server_settings WHERE id = 1`);
    // v0.55.0: what the nightly runs, `repair` (the safe repair) or `autofix` (Fix everything). Read apart from the
    // columns above and said as the contract names it; an unknown value reads as the default.
    const mode = await one<{ m: string | null }>('SELECT nightly_mode AS m FROM server_settings WHERE id = 1').catch(() => null);
    // v0.55.3 (#147): "Only hide short ones" -- the notice switches' rule (lib/noticeChapters.ts). Read apart and said
    // as the contract names it, as nightlyMode is; on unless the column says off.
    const shortOnly = await one<{ s: boolean | null }>('SELECT hide_notice_short_only AS s FROM server_settings WHERE id = 1').catch(() => null);
    return {
      ...row,
      nightlyMode: mode?.m === 'autofix' ? 'autofix' : 'repair',
      hideNoticeShortOnly: shortOnly?.s !== false,
      extensions_configured: suwayomiConfigured(),
      // How many chapters the read-chapter cleanup would delete if it ran now, at the CURRENT day setting.
      // Computed here rather than only in the tasks list because the tasks list does not show the job until
      // it is switched on, and the number is wanted before the switch, not after: "turn on this irreversible
      // thing and then go and see how much it took" is the wrong order to learn it in. Null if it cannot be
      // counted -- an unavailable figure must not stop the settings page loading.
      cleanup_read_due: await dueCountCached(row?.cleanup_read_days ?? 30).catch(() => null),
      // The slow archive's disk floor is set against this (#117): GiB free under the download root, null unknown.
      archive_free_gb: await archiveFreeGb().catch(() => null),
      // v0.52.0 (#123): every language MangaDex is offered in, English first -- what Admin → Providers' picker
      // offers. `mangadex_langs` beside it is the ones besides English that are on.
      mangadex_available: MANGADEX_LANGS.map((l) => l.code),
    };
  };
  /**
   * Turn the opt-in install count on or off.
   *
   * ⚠️ CONSENT IS THE SECRET. Opting in mints one; opting out DESTROYS it, so the id this server reported
   * under can never be recomputed by anyone, including us. That is also why opting back in later produces a
   * different id rather than resuming the old one -- which is the honest behaviour, even though it means
   * the count cannot tell a returning install from a new one.
   * Reintroduce by keeping the secret across an opt-out: the off switch stops the sending but leaves a
   * permanent identifier on disk, and re-enabling silently re-links this server to its own history.
   */
  const setInstallPing = async (on: boolean) => {
    if (!on) {
      const row = await one<{ secret: string | null }>('SELECT install_ping_secret AS secret FROM server_settings WHERE id = 1');
      // Best effort, and never blocking the opt-out: what we control is that we stop sending.
      if (row?.secret) await sendForget(monthlyId(row.secret)).catch(() => false);
      await q('UPDATE server_settings SET install_ping = false, install_ping_secret = NULL, install_ping_last = NULL, updated_at = now() WHERE id = 1');
      return;
    }
    await q(
      `UPDATE server_settings
          SET install_ping = true,
              install_ping_secret = COALESCE(install_ping_secret, $1),
              updated_at = now()
        WHERE id = 1`,
      [newSecret()],
    );
  };

  app.get('/api/admin/settings', settingsRow);

  /**
   * Exactly what the install count would send, if it were on.
   *
   * ⚠️ THIS IS THE CONSENT SURFACE AND IT MUST NOT BE A DESCRIPTION. It returns the output of the same
   * `buildPayload` the background job sends, so what the settings page shows an admin cannot drift away
   * from what actually leaves the server -- a hand-written summary in the UI could, and would, eventually.
   * The id is computed from a throwaway secret when none exists yet, so previewing does not itself opt in.
   */
  app.get('/api/admin/install-ping/preview', async () => {
    const row = await one<{ secret: string | null }>('SELECT install_ping_secret AS secret FROM server_settings WHERE id = 1');
    return {
      url: PING_URL,
      payload: buildPayload(row?.secret ?? newSecret(), installFacts(appVersion())),
      sample: !row?.secret,
    };
  });
  app.patch('/api/admin/settings', async (req, reply) => {
    const b = z.object({
      serverName: z.string().min(1).max(64).optional(),
      allowRegistration: z.boolean().optional(),
      updaterHours: z.number().int().min(1).max(168).optional(),
      extensionHours: z.number().int().min(1).max(168).optional(),
      extensionAutoUpdate: z.boolean().optional(),
      updateCheck: z.boolean().optional(),
      autoFollowOnFailure: z.boolean().optional(),
      installPing: z.boolean().optional(),
      scanlatorPrefs: prefsSchema.optional(),
      // The opt-in read-chapter cleanup. `cleanupReadDays: 0` is a value, not an absence: it means "at the
      // next run". The switch and the number are separate so turning the job off does not destroy the
      // setting, and so `.min(0)` cannot be mistaken for the off state.
      cleanupRead: z.boolean().optional(),
      cleanupReadDays: z.number().int().min(0).max(3650).optional(),
      // The local hour of the nightly backup. Until v0.39.0 it was shown under Tasks and editable nowhere.
      backupHour: z.number().int().min(0).max(23).optional(),
      // The nightly repair (lib/repair.ts). Off stops the SCHEDULE only: "Run now" and the Health page's
      // chips keep working, because nothing the repair does is destructive -- it never deletes, merges or
      // renumbers anything. The tick re-reads this column every time, so switching it off takes effect
      // without a restart.
      repairEnabled: z.boolean().optional(),
      /**
       * v0.55.0: what the nightly runs -- `repair`, the safe repair (the default, as before), or `autofix`, Health's Fix
       * everything (lib/autofix.ts). `repairEnabled` still switches the nightly off entirely; the scheduler reads this
       * every tick, so a change applies to the next run without a restart.
       */
      nightlyMode: z.enum(['repair', 'autofix']).optional(),
      // Ghost chapters on the Komga surface (lib/komgaGhosts.ts). Affects nothing this server stores and
      // nothing the web app shows: it widens one API's chapter list so the trackers behind it can count.
      komgaGhostChapters: z.boolean().optional(),
      /**
       * What the 18+ switch hides besides 18+ libraries: genres to treat as adult, and sources to treat
       * as adult whatever their extension says. Both are surfacing preferences -- nothing here changes
       * who may open a series, and an individual title can be exempted from the genre rule on its own
       * page (`adultExempt` on the series meta route).
       */
      adultGenres: z.array(z.string().min(1).max(60)).max(60).optional(),
      adultSources: z.array(z.string().min(1).max(120)).max(200).optional(),
      /**
       * Source ids, most preferred first (lib/sourcePrefs.ts): which copy of a chapter the server does not
       * have yet is taken, when a series follows more than one source. Checked by shape, not against the
       * sources registered now, so an order saved while the extension engine restarts keeps its extensions.
       */
      sourcePrefs: z.object({ priority: z.array(z.string().min(1).max(120)).max(100) }).optional(),
      /**
       * Group upgrades (lib/repair.ts stepGroups, #81): the nightly repair replaces a chapter with the
       * preferred group's copy once it exists. Off by default -- it replaces files on disk.
       */
      groupUpgrade: z.boolean().optional(),
      /**
       * Chapter names borrowed from another source (lib/borrowNames.ts, #85), the repair's seventh step. Off by
       * default. Off takes back the names it gave every series that follows this switch.
       */
      borrowNames: z.boolean().optional(),
      /**
       * MangaDex in other languages (v0.52.0, #123): the languages besides English that are on, replaced whole, as
       * app codes from lib/lang.ts MANGADEX_LANGS ("es-419", "pt-BR"; MangaDex's own "es-la" is read as es-419).
       * Applied live: each language turned on becomes its own source, each turned off goes. English is always on,
       * so it is refused here, like a code MangaDex is not offered in.
       */
      mangadexLangs: z.array(z.string().min(1).max(20)).max(100).optional(),
      /**
       * The language of sources and series that do not say (lib/lang.ts unstatedLang): English unless this server's
       * sites are in another. The same-language guard on automatic follows reads it.
       */
      unstatedLang: z.string().min(1).max(35).optional(),
      /**
       * Notice chapters (lib/noticeChapters.ts): the series types whose notice chapters are hidden everywhere, replaced
       * whole. A notice is numbered with a fraction (100.5) and has 3 pages or fewer, known -- a longer one, one not
       * counted yet and a file holding a range of chapters are chapters -- and one its sources list as that short is
       * not downloaded. Empty is off, the default. A series' own switch (`hideNotices` on PATCH
       * /api/admin/series/:id) outranks its type's.
       */
      hideNoticeTypes: z.array(z.enum(SERIES_TYPES)).max(SERIES_TYPES.length).optional(),
      /**
       * v0.55.3 (#147, TIGamingTV): "Only hide short ones (3 pages or fewer)", on by default -- the rule above. Off, every
       * chapter numbered with a fraction of the types (and series) switched on is a notice, real chapters a site split
       * into parts included; a file holding a range of chapters never is, either way.
       */
      hideNoticeShortOnly: z.boolean().optional(),
      // The slow archive's pause and pacing (#117, lib/archive.ts): the window's two ends together or not at all.
      ...ARCHIVE_SETTINGS_SHAPE,
    }).superRefine(archiveWindowPair).parse(req.body);
    // The languages are checked before anything is written: a refused field writes nothing, as for every other.
    if (b.mangadexLangs) {
      const unknown = b.mangadexLangs.find((c) => !mdLang(c));
      if (unknown !== undefined) {
        return reply.code(400).send({ error: 'unknown_language', message: `MangaDex is not offered in "${unknown}".` });
      }
      if (b.mangadexLangs.some((c) => canonLang(c) === 'en')) {
        return reply.code(400).send({ error: 'english_always_on', message: 'English is always on: list only the other languages.' });
      }
    }
    if (b.unstatedLang !== undefined && !canonLang(b.unstatedLang)) {
      return reply.code(400).send({ error: 'unknown_language', message: `"${b.unstatedLang}" is not one language.` });
    }
    if (b.serverName !== undefined) await q('UPDATE server_settings SET server_name = $1, updated_at = now() WHERE id = 1', [b.serverName]);
    if (b.allowRegistration !== undefined) await q('UPDATE server_settings SET allow_registration = $1, updated_at = now() WHERE id = 1', [b.allowRegistration]);
    if (b.updaterHours !== undefined) await q('UPDATE server_settings SET updater_hours = $1, updated_at = now() WHERE id = 1', [b.updaterHours]);
    if (b.extensionHours !== undefined) await q('UPDATE server_settings SET extension_hours = $1, updated_at = now() WHERE id = 1', [b.extensionHours]);
    if (b.extensionAutoUpdate !== undefined) await q('UPDATE server_settings SET extension_auto_update = $1, updated_at = now() WHERE id = 1', [b.extensionAutoUpdate]);
    if (b.updateCheck !== undefined) await q('UPDATE server_settings SET update_check = $1, updated_at = now() WHERE id = 1', [b.updateCheck]);
    if (b.autoFollowOnFailure !== undefined) await q('UPDATE server_settings SET auto_follow_on_failure = $1, updated_at = now() WHERE id = 1', [b.autoFollowOnFailure]);
    if (b.installPing !== undefined) await setInstallPing(b.installPing);
    if (b.scanlatorPrefs !== undefined) await q('UPDATE server_settings SET scanlator_prefs = $1::jsonb, updated_at = now() WHERE id = 1', [JSON.stringify(b.scanlatorPrefs)]);
    if (b.cleanupRead !== undefined) await q('UPDATE server_settings SET cleanup_read = $1, updated_at = now() WHERE id = 1', [b.cleanupRead]);
    if (b.cleanupReadDays !== undefined) await q('UPDATE server_settings SET cleanup_read_days = $1, updated_at = now() WHERE id = 1', [b.cleanupReadDays]);
    if (b.repairEnabled !== undefined) await q('UPDATE server_settings SET repair_enabled = $1, updated_at = now() WHERE id = 1', [b.repairEnabled]);
    if (b.nightlyMode !== undefined) await q('UPDATE server_settings SET nightly_mode = $1, updated_at = now() WHERE id = 1', [b.nightlyMode]);
    // The scheduler is re-armed at once, so the change applies to the NEXT run rather than the one after: the
    // timer used to re-read the hour only when it fired (server.ts, the backup block says why).
    if (b.backupHour !== undefined) { await q('UPDATE server_settings SET backup_hour = $1, updated_at = now() WHERE id = 1', [b.backupHour]); runtime.rearmBackup?.(); }
    if (b.komgaGhostChapters !== undefined) await q('UPDATE server_settings SET komga_ghost_chapters = $1, updated_at = now() WHERE id = 1', [b.komgaGhostChapters]);
    // Sanitised here as well as in visibility.ts: what is stored should be what is enforced, so a
    // name that could never match is rejected at the door rather than sitting in the settings page
    // looking as though it does something.
    if (b.adultGenres !== undefined) {
      await q('UPDATE server_settings SET adult_genres = $1::jsonb, updated_at = now() WHERE id = 1',
        [JSON.stringify(sanitiseAdultList(b.adultGenres))]);
    }
    if (b.adultSources !== undefined) {
      await q('UPDATE server_settings SET adult_sources = $1::jsonb, updated_at = now() WHERE id = 1',
        [JSON.stringify(sanitiseSourceIds(b.adultSources))]);
    }
    // The view context caches these for a few seconds; a save must take effect on the next request,
    // not whenever that window happens to lapse.
    if (b.adultGenres !== undefined || b.adultSources !== undefined) invalidateAdultFilter();
    if (b.groupUpgrade !== undefined) await q('UPDATE server_settings SET group_upgrade = $1, updated_at = now() WHERE id = 1', [b.groupUpgrade]);
    if (b.borrowNames !== undefined) {
      await q('UPDATE server_settings SET borrow_names = $1, updated_at = now() WHERE id = 1', [b.borrowNames]);
      // "Stop doing that" means the names it wrote go too; a series switched on for itself keeps its own.
      if (!b.borrowNames) await clearBorrowedNames('following-server').catch(() => 0);
    }
    if (b.sourcePrefs !== undefined) {
      await q('UPDATE server_settings SET source_prefs = $1::jsonb, updated_at = now() WHERE id = 1',
        [JSON.stringify({ priority: cleanSourceOrder(b.sourcePrefs.priority) })]);
      invalidateSourcePrefs();
    }
    if (b.mangadexLangs !== undefined) {
      const before = mangadexLangs();
      const next = cleanMangadexLangs(b.mangadexLangs);
      await q('UPDATE server_settings SET mangadex_langs = $1::jsonb, updated_at = now() WHERE id = 1', [JSON.stringify(next)]);
      // Live: the list in memory, then the registry to match it -- a language on is searchable on the next request.
      setMangadexLangs(next);
      const { removed } = syncMangadexSources();
      // Discover's pages are cached per source for ten minutes: drop them, so a language switched off is not served
      // from the cache and one switched on is asked at once.
      clearLatestCache();
      // A language switched off freezes its series; the header's Health mark should say so now, not at the next look.
      if (removed.length) scheduleHealthSummaryRefresh();
      if (before.join() !== next.join()) await logAudit('settings.mangadex_langs', { userId: userIdOf(req), detail: { from: before, to: next }, req });
    }
    if (b.unstatedLang !== undefined) {
      const lang = canonLang(b.unstatedLang)!;
      await q('UPDATE server_settings SET unstated_lang = $1, updated_at = now() WHERE id = 1', [lang]);
      // The guard compares synchronously (lib/lang.ts): the next follow decision reads the new language.
      setUnstatedLang(lang);
    }
    if (b.hideNoticeTypes !== undefined) {
      // Read live by every query (lib/noticeChapters.ts): the next request lists, counts and sweeps by it -- once the
      // in-process flag that says whether anything hides at all has been read again, here.
      await q('UPDATE server_settings SET hide_notice_types = $1::jsonb, updated_at = now() WHERE id = 1',
        [JSON.stringify(sanitiseNoticeTypes(b.hideNoticeTypes))]);
      await refreshNoticesActive();
    }
    if (b.hideNoticeShortOnly !== undefined) {
      // The rule is written into each query as it is built (lib/noticeChapters.ts), so it is read again here, as the
      // types' flag is: the next request lists, counts and sweeps by it.
      await q('UPDATE server_settings SET hide_notice_short_only = $1, updated_at = now() WHERE id = 1', [b.hideNoticeShortOnly]);
      await refreshNoticesActive();
    }
    await applyArchiveSettings(b);
    await logAudit('settings.update', { userId: userIdOf(req), detail: b, req });
    return settingsRow();
  });

  // ---- scheduled tasks ----
  /**
   * A task's schedule three ways (v0.49.0): `schedule` in English exactly as before, for the API; and the
   * English sentence as a KEY with its values, which the page translates (web/public/locales, keyed by the
   * English string like every other tr() key). A new schedule sentence here is a new locale key there.
   */
  const sched = (key: string, vars: Record<string, string | number> = {}) => ({
    schedule: key.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k])),
    scheduleKey: key,
    scheduleVars: vars,
  });
  app.get('/api/admin/tasks', async (req) => {
    const s = await one<{ updater_hours: number; backup_hour: number; backup_last_run: string | null; backup_last_result: any; extension_hours: number; extension_auto_update: boolean; extension_last_run: string | null; extension_last_result: any; cleanup_read: boolean; cleanup_read_days: number; cleanup_read_last_run: string | null; cleanup_read_last_result: any; verify_last_run: string | null; verify_last_result: any; repair_enabled: boolean; repair_last_run: string | null; repair_last_result: any }>(
      `SELECT updater_hours, backup_hour, backup_last_run, backup_last_result,
              extension_hours, extension_auto_update, extension_last_run, extension_last_result,
              cleanup_read, cleanup_read_days, cleanup_read_last_run, cleanup_read_last_result,
              verify_last_run, verify_last_result,
              repair_enabled, repair_last_run, repair_last_result
         FROM server_settings WHERE id = 1`,
    );
    // the backup's last run is persisted, so prefer the DB value over the in-memory one (which resets on restart)
    const backupLast = runtime.lastBackup || (s?.backup_last_run ? new Date(s.backup_last_run).getTime() : null);
    // The repair's history: the Tasks line's origin and the latest one-off fix beside it (lib/repairRuns.ts).
    const digest = await runDigest().catch(() => null);
    // Memory wins once this process has run it (see the row below); both are the last FULL run's.
    const repairLast = repairState.finishedAt ? repairState.lastResult : (s?.repair_last_result ?? null);
    const seen = await listable(req, [
      digest?.latestOther?.target.seriesId, ...skipIds(digest?.latestOther?.result), ...skipIds(repairLast),
    ]);
    const latestOther = digest?.latestOther
      ? { ...digest.latestOther, target: scrubTarget(digest.latestOther.target, seen), result: scrubResult(digest.latestOther.result, seen) }
      : null;
    // Who started the run on the Tasks line: the history's newest full run, and only while it IS that run (the
    // result names its run). Between a run writing its result and the history catching up, say nothing rather
    // than the previous run's origin. Reintroduce by leaving skipped runs out of the digest's lastFull
    // (repairRuns.ts): "the Tasks line's origin is the run it shows" in repairRoutes.int.test.ts finds no
    // 'nightly' beside a nightly's result (and without the run check below, the manual run's before it).
    const lastFull = digest?.lastFull;
    const lastOrigin = lastFull && (!repairLast?.run || repairLast.run === lastFull.id) ? lastFull.origin : null;
    return { content: [
      { id: 'scan', name: 'Library scan', ...sched('on demand'), lastRun: runtime.lastScan || null, running: false },
      { id: 'update', name: 'Check for new chapters', ...sched('every {h}h', { h: s?.updater_hours ?? 6 }), lastRun: runtime.lastUpdate || null, lastResult: runtime.lastUpdateResult, running: runtime.updating },
      { id: 'backup', name: 'Backup database & config', ...sched('daily at {hh}:00', { hh: String(s?.backup_hour ?? 3).padStart(2, '0') }), lastRun: backupLast, lastResult: runtime.lastBackupResult ?? s?.backup_last_result ?? null, running: runtime.backingUp },
      {
        id: 'fingerprint',
        name: 'Fingerprint library files',
        ...sched('in the background, rechecked every 6h'),
        lastRun: fpState.finishedAt,
        lastResult: fpState.finishedAt ? { done: fpState.done, failed: fpState.failed, ms: fpState.ms } : null,
        running: fpState.running,
        remaining: await fingerprintRemaining().catch(() => null),
      },
      {
        id: 'pagehash',
        name: 'Find repeated pages',
        ...sched('in the background, rechecked every 6h'),
        lastRun: phState.finishedAt,
        lastResult: phState.finishedAt
          ? { chapters: phState.chapters, pages: phState.pages, failed: phState.failed, ms: phState.ms }
          : null,
        running: phState.running,
        remaining: await pageHashRemaining().catch(() => null),
      },
      // On demand only, and never at boot (the header of lib/verifyFiles.ts says why): the repair for a
      // database restored without its chapter files. Listed always, because the moment it is needed is the
      // moment after a restore, when nobody remembers a task that only appears under some setting.
      {
        id: 'verify',
        name: 'Verify chapter files',
        ...sched('on demand · after a database-only restore'),
        // Persisted like the cleanup's, so a restart keeps the last run. Memory wins once this process has
        // run it -- including a run that threw (finishedAt set, lastResult null): falling through to the
        // stored row there would put an older healthy result back on the panel over a walk that died.
        lastRun: verifyState.finishedAt || (s?.verify_last_run ? new Date(s.verify_last_run).getTime() : null),
        lastResult: verifyState.finishedAt ? verifyState.lastResult : (s?.verify_last_result ?? null),
        running: verifyState.running,
      },
      // The nightly repair (lib/repair.ts). Listed whether it is on or off, and the schedule text says
      // which: unlike the read-chapter cleanup there is no "are you sure" to attach to its Run now, because
      // nothing it does deletes, merges or renumbers anything. The schedule also states the one constraint
      // an admin would otherwise discover from a refusal -- it never runs beside a chapter sweep.
      {
        id: 'repair',
        name: 'Repair library',
        ...(s?.repair_enabled === false
          ? sched('switched off · on demand')
          : sched('every {h}h · never during a chapter sweep', { h: REPAIR_HOURS })),
        // Memory wins once this process has run it, including a run that threw (finishedAt set, lastResult
        // null): the verify's precedent above says why falling through to the stored row there would put an
        // older healthy result back on the panel over a run that died.
        // ⚠️ Since v0.49.0 both are the last FULL run's (the nightly, or Run now here): a one-row Health fix
        // is in the history, and in `latestOther` below, and no longer replaces this line.
        lastRun: repairState.finishedAt || (s?.repair_last_run ? new Date(s.repair_last_run).getTime() : null),
        lastResult: scrubResult(repairLast, seen),
        lastOrigin,
        running: repairState.running,
        startedAt: repairState.running ? repairState.startedAt : null,
        run: repairState.live?.id ?? null,
        nextAt: repairState.nextAt,
        latestOther,
        // What one run takes on at most, so the Health page's "Fix all issues" can say so rather than guess.
        caps: { short: REPAIR_SHORT_MAX, gaps: REPAIR_GAPS_MAX },
      },
      // Only when it is switched on -- same rule as the extension task below. This one additionally must
      // not be listed while it is off because a "Run now" button beside a job an admin has not consented to
      // is an invitation to delete files by clicking something to see what it does.
      ...(s?.cleanup_read ? [{
        id: 'cleanup',
        name: 'Delete read chapters',
        ...(s.cleanup_read_days === 0
          ? sched('hourly · as soon as everyone has finished')
          // The singular spells its count, as the page's counted pairs do ("1 day" / "{n} days").
          : s.cleanup_read_days === 1 ? sched('hourly · 1 day after everyone has finished')
          : sched('hourly · {n} days after everyone has finished', { n: s.cleanup_read_days })),
        lastRun: runtime.lastCleanup || (s.cleanup_read_last_run ? new Date(s.cleanup_read_last_run).getTime() : null),
        lastResult: runtime.lastCleanupResult ?? s.cleanup_read_last_result ?? null,
        running: runtime.cleaning,
        // What it would delete if it ran now. The one number an admin wants before turning this on, and the
        // reason the settings page can ask "are you sure" with a figure in it rather than a warning.
        remaining: await dueCountCached(s.cleanup_read_days).catch(() => null),
      }] : []),
      // Only when there is an extension server to check. Listing a task that cannot run reads as a broken
      // one, and every install without the optional engine would show it permanently "never run".
      ...(suwayomiConfigured() ? [{
        id: 'extensions',
        name: 'Extension updates',
        ...sched(s?.extension_auto_update === false ? 'every {h}h · check only' : 'every {h}h', { h: s?.extension_hours ?? 6 }),
        lastRun: extState.lastRun || (s?.extension_last_run ? new Date(s.extension_last_run).getTime() : null),
        lastResult: extState.lastResult ?? s?.extension_last_result ?? null,
        running: extState.running,
      }] : []),
    ] };
  });
  /**
   * The five steps of the repair, as a zod enum, taken FROM the job rather than written out again: a step
   * added to lib/repair.ts and not to this list would be a body the route rejects for a job that supports
   * it. The cast is only the shape zod wants (a non-empty tuple) over an array the module exports.
   */
  const STEPS = REPAIR_STEPS as unknown as [RepairStep, ...RepairStep[]];
  const repairBody = z.object({
    only: z.array(z.enum(STEPS)).min(1).max(STEPS.length)
      .refine((a) => new Set(a).size === a.length, { message: 'each step at most once' })
      .optional(),
    seriesId: z.string().min(1).max(64).optional(),
    bookId: z.string().min(1).max(64).optional(),
    sourceId: z.string().min(1).max(100).optional(),
    // "Fix all issues" on the Health page (lib/repair.ts RepairOpts.now). Only for the whole library -- with a
    // target it would widen a one-row chip into every source -- and only where the failures step runs, the one
    // step it changes; anywhere else it would be a flag that does nothing and is audited as if it had.
    now: z.boolean().optional(),
  })
    .refine((b) => !b.now || (!b.seriesId && !b.bookId && !b.sourceId), { message: 'now is for the whole library, not one target' })
    .refine((b) => !b.now || !b.only || b.only.includes('failures'), { message: 'now only changes the failures step' })
    // Each of the three targets belongs to exactly one step, and a target without its step is not a smaller
    // run -- it is a FULL nightly with an argument the other four steps ignore, which is the opposite of
    // what a chip on one Health row means. Refused here rather than quietly widened.
    .refine((b) => !b.seriesId || (b.only?.length === 1 && b.only[0] === 'gaps'), {
      message: 'seriesId only applies to the gaps step (send only: ["gaps"])',
    })
    .refine((b) => !b.bookId || (b.only?.length === 1 && b.only[0] === 'short'), {
      message: 'bookId only applies to the short-chapter step (send only: ["short"])',
    })
    .refine((b) => !b.sourceId || (b.only?.length === 1 && b.only[0] === 'failures'), {
      message: 'sourceId only applies to the failures step (send only: ["failures"])',
    });

  /**
   * The library repair, live (v0.49.0): what the running run is on, how far it has got and what it skipped,
   * plus the limits and estimates the Health page's action rows show BEFORE a press, the last runs, and when
   * the nightly is next. Polled every two seconds while a run is going, so it reads memory and the history's
   * memoised digest (lib/repairRuns.ts) -- one settings read aside, no query grows with the library.
   * `?kinds=a,b` asks for estimates of further run kinds (a "Fix all issues" plan), at most ten.
   */
  app.get('/api/admin/tasks/repair/status', async (req) => {
    const me = userIdOf(req);
    const extra = String((req.query as { kinds?: string } | undefined)?.kinds ?? '')
      .split(',').map((k) => k.trim()).filter((k) => /^[a-z_+:]{1,80}$/.test(k)).slice(0, 10);
    const [digest, settings] = await Promise.all([
      runDigest(),
      one<{ on: boolean }>('SELECT repair_enabled AS "on" FROM server_settings WHERE id = 1').catch(() => null),
    ]);
    const snap = repairLiveSnapshot();
    const ok = await listable(req, [
      snap?.target.seriesId, snap?.current?.seriesId, ...(snap?.skips ?? []).map((k) => k.target?.seriesId),
      ...digest.recent.map((r) => r.target.seriesId), ...skipIds(digest.lastFull?.result),
    ]);
    let run = null;
    if (snap) {
      const { by, current, target, skips, ...rest } = snap;
      run = {
        ...rest,
        mine: !!by && by === me,
        target: scrubTarget(target, ok),
        current: current?.seriesId && !ok.has(current.seriesId) ? { ...current, title: undefined } : current,
        skips: scrubSkips(skips, ok),
      };
    }
    // Conservative: any source behind Cloudflare stretches a page list and a listing to the solver's budget.
    const solver = listSources().some((a) => a.requiresCloudflare);
    const estimates: Record<string, { typicalMs: number | null; runs: number; worstMs: number | null; downloads: number }> = {};
    for (const kind of new Set([...ESTIMATED_KINDS, ...Object.keys(digest.typical), ...extra])) {
      const w = worstCase(kind, REPAIR_LIMITS, { solver });
      estimates[kind] = { typicalMs: digest.typical[kind]?.typicalMs ?? null, runs: digest.typical[kind]?.runs ?? 0, worstMs: w.boundedMs, downloads: w.downloads };
    }
    const r0 = digest.recent[0];
    return {
      running: repairState.running,
      sweepRunning: runtime.updating,
      enabled: settings?.on !== false,
      nextAt: repairState.nextAt,
      run,
      last: repairState.last ?? (r0 && r0.finishedAt ? { id: r0.id, finishedAt: r0.finishedAt, status: r0.status, kind: r0.kind } : null),
      recent: digest.recent.map((r) => ({ ...r, target: scrubTarget(r.target, ok) })),
      lastFull: digest.lastFull ? { ...digest.lastFull, result: scrubResult(digest.lastFull.result, ok) } : null,
      limits: REPAIR_LIMITS,
      estimates,
      stepTypicalMs: digest.stepTypicalMs,
    };
  });

  /** Every kept repair run, newest first (lib/repairRuns.ts): Health's "Recent repairs", or one run by id. */
  app.get('/api/admin/tasks/repair/runs', async (req, reply) => {
    const p = z.object({
      limit: z.coerce.number().int().min(1).max(50).optional(),
      id: z.string().uuid().optional(),
    }).safeParse(req.query ?? {});
    if (!p.success) return reply.code(400).send({ error: 'bad_request', message: p.error.issues[0]?.message ?? 'Bad query' });
    const content = await listRunRecords({ ...p.data, me: userIdOf(req) });
    const ok = await listable(req, content.flatMap((r) => [r.target.seriesId, ...(r.result?.skips ?? []).map((k) => k.target?.seriesId)]));
    // `notes` names series by title alone ("<title> ch 5 (3 -> 20)", "<title> -> source"), with no id to hold each
    // one to the listing rule, so an admin who hides 18+ gets none of them rather than an adult title among them
    // (integration-1 review). The page never reads them; a script that wants them asks with "Show 18+" on.
    // Reintroduce by sending them as stored: "an admin who hides 18+ reads no adult title" in
    // repairRoutes.int.test.ts finds the title in the history.
    const noNotes = hideAdult(req);
    // A Fix everything run's record (v0.55.0) names series in its lines, by title: since v0.55.1 each line with the ids of
    // the series it names, held to them as its own routes hold it (lib/autofix.ts scrubAutofixRecord), since Recent
    // repairs reads it from here.
    const named = noNotes ? await nameable(req, content.flatMap((r) => (r.kind === 'autofix' ? autofixSeriesIds(r.result) : []))) : undefined;
    return {
      content: content.map((r) => ({
        ...r,
        target: scrubTarget(r.target, ok),
        result: r.kind === 'autofix' ? scrubAutofixRecord(r.result, noNotes, named) : scrubResult(r.result, ok),
        ...(noNotes ? { notes: null } : {}),
      })),
    };
  });

  app.post('/api/admin/tasks/:id/run', async (req, reply) => {
    const { id } = req.params as { id: string };
    await logAudit('task.run', { userId: userIdOf(req), detail: { task: id }, req });
    if (id === 'scan') {
      runtime.lastScan = Date.now();
      const r = await persistScan();
      scheduleHealthSummaryRefresh();
      return { ok: true, ...r };
    }
    if (id === 'repair') {
      const b = repairBody.safeParse(req.body ?? {});
      if (!b.success) return reply.code(400).send({ error: 'bad_request', message: b.error.issues[0]?.message ?? 'Bad body' });
      // ⚠️ The two jobs must never overlap (both download into the same series folders and both write
      // lib_books for what landed). runRepair refuses on its own, but it cannot say WHY, and "busy" on a
      // press the admin made while a sweep is running reads as "the repair is stuck". Answered separately
      // so the page can say "a chapter sweep is running; try again in a few minutes".
      if (runtime.updating) return { ok: false, error: 'sweep_running' };
      // Never awaited: a full repair opens two thousand archives and can download chapters. The panel polls
      // `running` and keeps the persisted result, exactly as the verify and the sweep do.
      // ⚠️ `userId` is always passed, even though it is the admin's own id: an explicit run ignores the
      // nightly switch (nothing it does is destructive), and lib/repair.ts reads "somebody asked for this"
      // from userId being present at all. The tick passes none.
      const run = runRepair(app.log, { ...b.data, userId: userIdOf(req) ?? null });
      if (!run) return { ok: false, error: 'busy' };
      run.catch(() => {}); // runRepair logs it and clears the result; this only stops an unhandled rejection
      // The run's id (v0.49.0), set synchronously by runRepair: the page watches GET
      // /api/admin/tasks/repair/status for THIS id to leave `running` and land in `last`/`recent`, which is
      // how it knows its own run ended -- a one-row fix no longer moves the Tasks line it used to watch.
      // Reintroduce by dropping it: "the run answer names the run" in repairRoutes.int.test.ts fails.
      return { ok: true, started: true, run: repairState.live?.id };
    }
    if (id === 'verify') {
      // ⚠️ Never awaited, like the sweep and the cleanup. One stat per row over a network share is minutes
      // on a large library, and the first cut of this route awaited it: the reverse proxy cut the request
      // at 60-120 s, the page toasted "Failed", and the walk went on marking rows behind a toast that said
      // it had not. The Tasks panel polls `running` and shows the persisted result. runVerify refuses a
      // second walk on top of a first. Audited with its counts when the walk ends: marking hundreds of
      // rows "missing" is a library-wide change and the Activity feed must show who did it and what it
      // found. Reintroduce by awaiting `run` here: "the verify button answers started and the panel shows
      // the run" in verifyFiles.int.test.ts finds the counts in the answer instead of `started`.
      const run = runVerify(app.log);
      if (!run) return { ok: false, error: 'busy' };
      const userId = userIdOf(req);
      run.then(
        (r) => logAudit('library.verify', { userId, detail: { checked: r.checked, missing: r.missing, readLibraryMissing: r.readLibraryMissing, unmounted: r.unmounted, ms: r.ms }, req }),
        () => {}, // runVerify logs it and clears the result; this only stops an unhandled rejection
      );
      return { ok: true, started: true };
    }
    if (id === 'rescan') {
      // Never awaited, for Verify's reason (lib/rescan.ts): a scan and one stat per chapter over a share is minutes, and
      // a request that long dies at the proxy while the walk goes on. The Tasks panel polls
      // GET /api/admin/tasks/rescan/status for the phase and the plan; startRescan refuses a second preview on top of a
      // first. Reintroduce by awaiting `run` here: "the preview answers started" in rescan.int.test.ts finds no `started`.
      const run = startRescan(app.log);
      if (!run) return { ok: false, error: 'busy' };
      run.catch(() => {}); // startRescan logs it and records the failure; this only stops an unhandled rejection
      return { ok: true, started: true };
    }
    if (id === 'update') {
      // ⚠️ The repair's clash is answered separately, exactly as the repair branch above answers a sweep's:
      // runSweep refuses while a repair is running (updater.ts's `runtime.updating || runtime.repairing`)
      // and every refusal here used to be `busy`, which this panel words as "Already running" -- a sentence
      // about a sweep that is not running at all, and the same wrong story the repair branch added
      // `sweep_running` to avoid, in the other direction. Reintroduce by deleting this line: "Run now on
      // the chapter sweep says the repair is running" in web/test/healthActions.test.ts.
      if (runtime.repairing) return { ok: false, error: 'repair_running' };
      // Never awaited: a sweep is minutes to hours, and the caller is an admin clicking a button. runSweep
      // marks it running, keeps the result, logs the summary and refuses to start on top of another one --
      // everything this path used to skip, which is why the panel showed a manual sweep as idle throughout.
      if (!runSweep({ maxNew: 10, by: userIdOf(req) }, app.log)) return { ok: false, error: 'busy' };
      return { ok: true, started: true };
    }
    if (id === 'extensions') {
      if (!suwayomiConfigured()) return { ok: false, error: 'not_configured' };
      // Not awaited: re-reading every repository index and installing an APK is minutes, and the caller is
      // an admin clicking a button. runExtensionMonitor does the flag, the stored result and the log line.
      if (!runExtensionMonitor(app.log)) return { ok: false, error: 'busy' };
      return { ok: true, started: true };
    }
    if (id === 'cleanup') {
      // The switch is checked here as well as inside the job. Not redundant: this is what turns "the task
      // is off" into a refusal the panel can show, instead of a run that reports having done nothing.
      const { on } = await cleanupSettings();
      if (!on) return { ok: false, error: 'not_enabled' };
      // Not awaited: deleting several hundred files across a network mount is not a request's worth of time.
      const run = runChapterCleanup(app.log);
      if (!run) return { ok: false, error: 'busy' };
      run.catch(() => {}); // runChapterCleanup logs it; this only stops an unhandled rejection
      return { ok: true, started: true };
    }
    if (id === 'pagehash') {
      if (phState.running) return { ok: false, error: 'busy' };
      // Never awaited: this decodes every page in the library, which is minutes to hours.
      runPageHashBackfill().catch(() => {});
      return { ok: true, started: true };
    }
    if (id === 'fingerprint') {
      if (fpState.running) return { ok: false, error: 'busy' };
      // never awaited: on a large library this is minutes, and the caller is an admin clicking a button
      runFingerprintBackfill().catch(() => {});
      return { ok: true, started: true };
    }
    if (id === 'backup') {
      if (runtime.backingUp) return { ok: false, error: 'busy' };
      runtime.backingUp = true;
      runBackup()
        .then((r) => { runtime.lastBackup = Date.now(); runtime.lastBackupResult = { bytes: r.bytes, ms: r.ms }; })
        // Never swallow this. An admin pressing Backup and seeing the panel still report yesterday's healthy
        // run is worse than an error: runBackup persists the failure itself, and this logs it so the reason
        // is in `docker logs` too.
        .catch((e) => { runtime.lastBackup = Date.now(); runtime.lastBackupResult = null; app.log.error(e); })
        .finally(() => { runtime.backingUp = false; });
      return { ok: true, started: true };
    }
    return { ok: false };
  });

  // ---- audit / activity feed ----
  app.get('/api/admin/audit', async (req) => ({ content: await recentAudit(Number((req.query as any)?.limit) || 150) }));

  // reload source plugins from SOURCES_DIR (after dropping in / updating a source pack) — no restart needed
  app.post('/api/admin/sources/reload', async (req) => {
    const r = await reloadAll(); // rescan pack + re-add built-ins, config sites and extension sources
    await logAudit('source.reload', { userId: userIdOf(req), detail: r, req });
    return { ok: true, ...r, available: listSources().length };
  });

  // ---- custom "template" sites (Madara/Manganato added by name+URL, no code). The core only reads/writes
  // a JSON file; the source pack's custom plugin instantiates the adapters from it on reload. ----
  // readSites/writeSites moved to lib/sources/customSites so the watchdog can follow a moved site too.
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40);
  /** A source some series still has as its main source cannot be retired or removed (v0.54.0): how many, in words. */
  const inUse = (main: number) => {
    const said = say('retire.inUse', { n: main });
    return { error: 'in_use', main, message: said.text, messageSaid: saidOf(said) };
  };

  app.get('/api/admin/sources/custom', async () => ({ content: await readSites() }));
  app.post('/api/admin/sources/custom', async (req, reply) => {
    const b = z.object({ engine: z.enum(['auto', 'madara', 'manganato', 'mangathemesia']), name: z.string().min(1).max(60), base: z.string().url() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'Pick an engine, a name, and a valid https URL.' });
    // auto-detect the engine from the site's homepage so the user can just paste a URL
    let engine = b.data.engine as string;
    if (engine === 'auto') {
      const detected = await detectEngine(b.data.base);
      if (!detected) return reply.code(422).send({ error: 'undetected', message: "Couldn't detect the site's engine — pick Madara, MangaThemesia, or Manganato manually." });
      engine = detected;
    }
    const id = slug(b.data.name) || slug(new URL(b.data.base).hostname.replace(/^www\./, ''));
    if (!id) return reply.code(400).send({ error: 'bad_name' });
    const list = await readSites();
    if (getSource(id) || list.some((s) => s.id === id)) return reply.code(409).send({ error: 'exists', message: `A source named "${b.data.name}" already exists — pick another name.` });
    list.push({ engine, id, name: b.data.name, base: b.data.base.replace(/\/+$/, ''), order: 100 });
    await writeSites(list);
    await reloadAll();
    await logAudit('source.custom_add', { userId: userIdOf(req), detail: { id, engine, base: b.data.base }, req });
    // Verify the freshly-added site actually works, bounded so a slow/Cloudflare-heavy site can't hang the request.
    const added = getSource(id);
    // No Promise.race any more: `smokeTest` carries its own wall-clock deadline. The race returned after 30s
    // but did not cancel, so the adapter kept scraping behind an answered request, and its own worst case
    // (four search terms at up to 95s each) was twelve times the guard it sat behind.
    const smoke = added
      ? await smokeTest(added)
      : { ok: false, checks: [{ name: 'Verify', ok: false, detail: 'source failed to load' }] };
    return reply.send({ ok: true, id, engine, available: listSources().length, smoke });
  });
  /**
   * Change a custom site's address, and nothing else.
   *
   * There was no way to do this: only add and delete existed, so "the site moved to a new domain" -- far and
   * away the most common real failure -- meant deleting and re-adding. That is a trap, because the id is
   * `slug(name)` and `lib_series.source_id` is keyed on it, so re-adding under any other name orphans every
   * series that came from it. Editing the base in place keeps the id, and therefore keeps the library.
   *
   * `base` only. Name and engine stay put, precisely because the id derives from the name.
   */
  app.patch('/api/admin/sources/custom/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ base: z.string().url() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'Give a valid https URL.' });
    const list = await readSites();
    const site = list.find((s) => s.id === id);
    if (!site) return reply.code(404).send({ error: 'not_found' });
    const from = site.base;
    site.base = b.data.base.replace(/\/+$/, '');
    await writeSites(list);
    await reloadAll();
    // A moved site's recorded failures describe an address that no longer exists, and leaving the cooldown
    // in place would suppress the very first request that could prove the new one works.
    await clearBlock(id).catch(() => {});
    await logAudit('source.custom_edit', { userId: userIdOf(req), detail: { id, from, to: site.base }, req });
    const src = getSource(id);
    return reply.send({ ok: true, id, base: site.base, smoke: src ? await smokeTest(src) : null });
  });
  // Refused while the site is some series' main source (v0.54.0): it was removed at once, with no check, and every series
  // from it froze -- "no longer installed". Replace moves them first. Reintroduce by dropping the guard: "the custom
  // site's delete is refused while it is in use" in retireSource.int.test.ts removes it.
  app.delete('/api/admin/sources/custom/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const main = await mainUses(id);
    if (main > 0) return reply.code(409).send(inUse(main));
    await writeSites((await readSites()).filter((s) => s.id !== id));
    await reloadAll();
    await logAudit('source.custom_remove', { userId: userIdOf(req), detail: { id }, req });
    return { ok: true, available: listSources().length };
  });

  // ---- admin-editable series metadata + art overrides (Jellyfin-style) ----
  // Edit title/summary; an empty value clears the override (back to the source's own metadata).
  // Per-series settings. auto_update could only ever be chosen at add time, and the UI never read it back,
  // so there was no way to stop the updater chasing a series you had finished with. scanlatorPrefs is the
  // series' own release preferences (lib/releases.ts); null clears them, so the series inherits the global
  // ones again. sourcePrefs is the series' own source order (lib/sourcePrefs.ts), which REPLACES the server's;
  // null, or an empty list, clears it. borrowNames switches chapter-name borrowing (lib/borrowNames.ts) for this
  // series, null to follow the server. Each field is written on its own, so a body naming one leaves the rest.
  //
  // v0.52.0: `lang` states the language the series is in (lib/seriesLang.ts), null to infer it again -- refused for an
  // edition, since every row in a work states its language, and for a language another edition of its work holds.
  // `chapterFloor` is "Mark caught up" (discussion #72): 'caught_up' floors the series just above the newest chapter
  // the sources list or the library holds -- the "Nothing yet" add's floor (routes/sources.ts), so the back catalogue
  // is never fetched and every later release is -- and a number or null puts back the floor the answer reported as
  // `previous`, which is the Undo.
  app.patch('/api/admin/series/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({
      autoUpdate: z.boolean().optional(),
      scanlatorPrefs: prefsSchema.nullable().optional(),
      sourcePrefs: z.object({ priority: z.array(z.string().min(1).max(120)).max(100) }).nullable().optional(),
      borrowNames: z.boolean().nullable().optional(),
      lang: z.string().min(1).max(35).nullable().optional(),
      chapterFloor: z.union([z.literal('caught_up'), z.number().min(0).max(1e6), z.null()]).optional(),
      // Notice chapters (lib/noticeChapters.ts): this series' own switch, outranking its type's; null follows the type.
      hideNotices: z.boolean().nullable().optional(),
    }).strict().safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    if (b.data.autoUpdate === undefined && b.data.scanlatorPrefs === undefined && b.data.sourcePrefs === undefined
        && b.data.borrowNames === undefined && b.data.lang === undefined && b.data.chapterFloor === undefined
        && b.data.hideNotices === undefined) {
      return reply.code(400).send({ error: 'bad_request', message: 'Nothing to change.' });
    }
    const row = await getSeriesRow(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    // Every refusal before the first write: the fields below are written one by one.
    const lang = b.data.lang == null ? null : canonLang(b.data.lang);
    if (b.data.lang != null && !lang) return reply.code(400).send({ error: 'bad_lang', message: 'That is not a language code.' });
    if (b.data.lang !== undefined) {
      const work = await workRows(id);
      if (lang === null && work.length > 1) {
        return reply.code(409).send({ error: 'edition_lang', message: 'An edition always says which language it is in. Unlink it first to make it automatic.' });
      }
      const other = lang ? work.find((r) => r.id !== id && r.lang === lang) : undefined;
      if (other) return reply.code(409).send({ error: 'edition_exists', message: `"${other.title}" is already this work's edition in that language.`, existing: { id: other.id, title: other.title, lang } });
    }
    let caughtUp: { floor: number | null; previous: number | null } | undefined;
    if (b.data.chapterFloor !== undefined) {
      const prev = await one<{ floor: string | null; top: number | null }>(
        `SELECT s.chapter_floor AS floor,
                (SELECT max(n) FROM (SELECT l.number::float8 AS n FROM series_listing l WHERE l.series_id = s.id
                                     UNION ALL
                                     SELECT (${lastNumber('bk', 'ov')})::float8 FROM lib_books bk LEFT JOIN book_overrides ov ON ov.book_id = bk.id
                                      WHERE bk.series_id = s.id) x) AS top
           FROM lib_series s WHERE s.id = $1`, [id]);
      const previous = prev?.floor == null ? null : Number(prev.floor);
      if (b.data.chapterFloor === 'caught_up' && prev?.top == null) {
        return reply.code(409).send({ error: 'nothing_listed', message: 'No chapter of this series is listed or here yet. Check for new chapters first.' });
      }
      // A hair above the newest number, as the "Nothing yet" add floors: `chapter_floor` is inclusive from below. A file
      // holding a range is as new as its END (lib/chapterRanges.ts): caught up past `Batman 01-07` is past 7.
      // Reintroduce the start above: "Mark caught up floors the series above a range file's end" in
      // chapterRanges.int.test.ts finds the floor at 1.001.
      caughtUp = { floor: b.data.chapterFloor === 'caught_up' ? Number(prev!.top) + 0.001 : b.data.chapterFloor, previous };
    }
    const detail: Record<string, unknown> = { id };
    if (b.data.lang !== undefined) {
      // The unique index is the last word: an edition linked in the same moment can still take the language.
      const ok = await q('UPDATE lib_series SET lang = $2 WHERE id = $1', [id, lang]).then(() => true, (e) => {
        if ((e as { code?: string })?.code === '23505') return false;
        throw e;
      });
      if (!ok) return reply.code(409).send({ error: 'edition_exists', message: 'Another edition of this work is already in that language.' });
      detail.lang = lang;
    }
    if (caughtUp) {
      await q('UPDATE lib_series SET chapter_floor = $2 WHERE id = $1', [id, caughtUp.floor]);
      detail.chapterFloor = caughtUp;
    }
    if (b.data.autoUpdate !== undefined) {
      await q('UPDATE lib_series SET auto_update = $2 WHERE id = $1', [id, b.data.autoUpdate]);
      detail.autoUpdate = b.data.autoUpdate;
    }
    if (b.data.scanlatorPrefs !== undefined) {
      await q('UPDATE lib_series SET scanlator_prefs = $2::jsonb WHERE id = $1',
        [id, b.data.scanlatorPrefs === null ? null : JSON.stringify(b.data.scanlatorPrefs)]);
      detail.scanlatorPrefs = b.data.scanlatorPrefs;
    }
    if (b.data.sourcePrefs !== undefined) {
      // An empty order is stored as NULL, not as an empty list: both mean "the server's order applies", and one
      // spelling of that is what the series page reads back to show "Server default".
      const order = b.data.sourcePrefs === null ? [] : cleanSourceOrder(b.data.sourcePrefs.priority);
      await q('UPDATE lib_series SET source_prefs = $2::jsonb WHERE id = $1', [id, order.length ? JSON.stringify({ priority: order }) : null]);
      detail.sourcePrefs = order.length ? { priority: order } : null;
    }
    if (b.data.borrowNames !== undefined) {
      await q('UPDATE lib_series SET borrow_names = $2 WHERE id = $1', [id, b.data.borrowNames]);
      detail.borrowNames = b.data.borrowNames;
      const own = await one<{ borrow_names: boolean | null }>('SELECT borrow_names FROM lib_series WHERE id = $1', [id]).catch(() => null);
      const on = own?.borrow_names ?? !!(await one<{ b: boolean }>('SELECT borrow_names AS b FROM server_settings WHERE id = 1').catch(() => null))?.b;
      // On is a request for names now, for this one series -- bounded like a night's step, and not awaited.
      // Off takes back what it wrote, which is the only honest meaning of "stop doing that".
      if (on) void borrowNamesFor(id, { force: true }).catch(() => {});
      else await clearBorrowedNames({ seriesId: id }).catch(() => 0);
    }
    let notices: { hideNotices: boolean | null; hideNoticesEffective: boolean; hiddenNotices: number } | undefined;
    if (b.data.hideNotices !== undefined) {
      // Nothing to move: every read applies the switch as it stands (lib/noticeChapters.ts), and the next sweep
      // fetches what it no longer hides. Answered with what applies now and how many chapters that hides. A series'
      // own switch alone can turn the hide on, so the flag that says whether anything hides is read again first.
      await q('UPDATE lib_series SET hide_notices = $2 WHERE id = $1', [id, b.data.hideNotices]);
      await refreshNoticesActive();
      detail.hideNotices = b.data.hideNotices;
      const effective = await seriesHidesNotices(id);
      notices = { hideNotices: b.data.hideNotices, hideNoticesEffective: effective, hiddenNotices: effective ? await hiddenCount(id) : 0 };
    }
    await logAudit('series.settings', { userId: userIdOf(req), detail, req });
    return {
      ok: true, ...(b.data.autoUpdate !== undefined ? { autoUpdate: b.data.autoUpdate } : {}),
      ...(b.data.lang !== undefined ? { lang } : {}), ...(caughtUp ? { chapterFloor: caughtUp } : {}),
      ...(notices ?? {}),
    };
  });

  /**
   * Every scanlation group this server knows of, for the Settings page's picker.
   *
   * The names come from the two places the per-series route reads -- the files on disk (lib_books.scanlator,
   * split the way a joint release is) and the persisted listings of every source -- but from the listings
   * TABLE rather than the sources themselves: this is one call for the whole library, and asking forty
   * sites to build a chip list is not on. Merged by the server's own group equality (normGroup), first
   * spelling wins and disk beats listing, as the per-series route does. Memoised for half a minute at
   * module level because the Settings page refetches it on every focus and the number only has to be
   * right, not live: a group that appears tonight is in the list tomorrow morning either way.
   */
  app.get('/api/admin/scanlators', async () => {
    if (knownGroups && Date.now() - knownGroups.at < KNOWN_GROUPS_TTL) return { content: knownGroups.content };
    const groups = new Map<string, { name: string; onDisk: number; listed: number; series: Set<string> }>();
    const entry = (name: string) => {
      const key = normGroup(name);
      if (!key) return null;
      let g = groups.get(key);
      if (!g) { g = { name, onDisk: 0, listed: 0, series: new Set() }; groups.set(key, g); }
      return g;
    };
    const onDisk = await q<{ scanlator: string; series_id: string; n: number }>(
      `SELECT b.scanlator, b.series_id, count(*)::int AS n FROM lib_books b JOIN lib_series s ON s.id = b.series_id
        WHERE b.scanlator IS NOT NULL AND ${visibleToAll('s')} GROUP BY 1, 2`);
    for (const r of onDisk) for (const name of groupsOf({ scanlator: r.scanlator })) {
      const g = entry(name);
      if (g) { g.onDisk += r.n; g.series.add(r.series_id); }
    }
    const listed = await q<{ name: string; series_id: string; n: number }>(
      `SELECT g AS name, l.series_id, count(*)::int AS n FROM series_listing l JOIN lib_series s ON s.id = l.series_id, unnest(l.groups) AS g
        WHERE ${visibleToAll('s')} GROUP BY 1, 2`).catch(() => []);
    for (const r of listed) {
      const g = entry(r.name);
      if (g) { g.listed += r.n; g.series.add(r.series_id); }
    }
    const content = [...groups.values()]
      .map((g) => ({ name: g.name, onDisk: g.onDisk, listed: g.listed, series: g.series.size }))
      .sort((a, b) => (b.onDisk + b.listed) - (a.onDisk + a.listed) || a.name.localeCompare(b.name));
    knownGroups = { at: Date.now(), content };
    return { content };
  });

  /**
   * The groups an admin can rank or block for one series, and where the current preferences stand.
   *
   * Two places know a group name: the files on disk (lib_books.scanlator, stamped as chapters land) and the
   * listing the updater persisted at the last check, every copy from the primary and the followed sources
   * alike (series_listing.copies). Both are read, because each misses what the other has -- a group that
   * released the early chapters and then disbanded is only on disk, a group that just picked the title up
   * is only in the listing. The names already in the prefs are added as a third set: a blocked group that
   * has since vanished from the listing has to stay visible or there is no control left to unblock it with.
   *
   * ⚠️ The persisted listing, never the sources themselves: the series page mounts this for every admin
   * visit, and asking each followed source live -- as v0.32.0 did, when only Edit details read it -- put a
   * listing call per source, a FlareSolverr solve for a Cloudflare one, in front of the card on every page
   * open, and gave the admin live figures where the docs promise "as old as the last check". The same
   * rule GET /api/series/:id/listing gives (routes/catalog.ts). A source that is down leaves its last
   * listing standing, so there is no error path to swallow here any more.
   *
   * Each entry carries the same figures as GET /api/series/:id/groups (lib/groupStats.ts, one aggregator
   * for both) plus `listed`, kept equal to `releases` for clients written against the v0.31.0 shape: the
   * editor is the panel with buttons, and two counts of the same thing would disagree the first time one
   * of them changed.
   */
  app.get('/api/admin/series/:id/scanlators', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await getSeriesRow(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const prefs = await readSeriesPrefs(id);
    const global = await readGlobalPrefs();
    const eff = await effectivePrefsFor(prefs);

    // Reintroduce by listing each followed source live (seriesAndChapters) instead: "the report reads the
    // persisted listing, not the sources" in scanlatorPrefs.int.test.ts finds Group D, which no persisted
    // row names, and misses Group E, which only a persisted row names.
    const listed = await q<{ number: number; copies: ListingCopy[] }>('SELECT number, copies FROM series_listing WHERE series_id = $1', [id]);
    const copies: StatCopy[] = [];
    for (const r of listed) for (const c of r.copies ?? []) copies.push({ ...c, number: Number(r.number) });
    // Live rows only, as GET /api/series/:id/groups counts them: a tombstone's group is a file that is no
    // longer here, and the admin's "3 on this server" must be the member's.
    // Reintroduce by dropping `pruned_at IS NULL`: "the admin editor carries the same figures" in
    // groupsAndVersions.int.test.ts reads Group C onDisk 1 where GET /groups reads 0.
    const onDisk = await q<{ number: number; scanlator: string }>(
      'SELECT number, scanlator FROM lib_books WHERE series_id = $1 AND pruned_at IS NULL AND scanlator IS NOT NULL', [id]);
    const stats = groupStats(copies, onDisk.map((b) => ({ number: Number(b.number), scanlator: b.scanlator })));
    const have = new Set(stats.map((g) => normGroup(g.name)));
    // The effective set already holds the series' own names (a series priority replaces the global list, a
    // series block joins it), so one pass over it covers both rows. A name nothing lists or holds gets a
    // row of zeros: still a row, still a button.
    // Reintroduce by dropping this loop: "a blocked group that vanished from the listing is still offered"
    // in scanlatorPrefs.int.test.ts fails -- the name is in `blocked` and absent from `groups`.
    for (const name of [...eff.priority, ...eff.blocked]) {
      const key = normGroup(name);
      if (!key || have.has(key)) continue;
      have.add(key);
      stats.push(emptyGroupStat(name));
    }

    // How old the figures are, as GET /api/series/:id/groups reports it: the editor is the panel with
    // buttons, and it says the same "as of" the panel does. (getSeriesRow is an explicit column list
    // without this column -- read it here rather than widen a helper twenty routes share.)
    const at = (await one<{ source_checked_at: Date | string | null }>('SELECT source_checked_at FROM lib_series WHERE id = $1', [id]))?.source_checked_at ?? null;
    return {
      checkedAt: at == null ? null : at instanceof Date ? at.toISOString() : new Date(at).toISOString(),
      prefs,
      global,
      effective: { priority: eff.priority, blocked: eff.blocked, patienceDays: Math.round(eff.patienceMs / 86_400_000) },
      groups: stats.map((g) => ({ ...g, listed: g.releases }))
        .sort((a, b) => (b.onDisk + b.listed) - (a.onDisk + a.listed) || a.name.localeCompare(b.name)),
    };
  });

  /**
   * Follow another source for a series: its chapter list is merged with the primary's on every check, so a
   * chapter the primary lacks, or lists only from a blocked group, can come from here instead.
   *
   * The candidate must come from a fill-scan plan, and the plan must have found it followable -- the one
   * rule in lib/fill.ts followable(): coverage at or over MIN_COVERAGE with a verdict that says the
   * numbering lines up. There are two ways into a follow, this route and the add-time auto-follow
   * (POST /api/sources/add `alsoFollow`, lib/autoFollow.ts), and both make the "same series?" judgement on
   * the SERVER (lib/fill.ts explains why it is a judgement and not a proof): here from the plan, there from
   * the listing the add just wrote plus the candidate's own title. Neither takes a bare (source, id) pair
   * on trust, which would let a client follow anything it could name -- for a source that numbers a
   * different story 1..N, every "new chapter" is the wrong book. The primary is refused as well: following
   * it would list the same chapters twice.
   */
  app.post('/api/admin/series/:id/sources', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({
      planId: z.string().min(1).max(64),
      source: z.string().min(1).max(128),
      sourceSeriesId: z.string().min(1).max(512),
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const { planId, source, sourceSeriesId } = b.data;
    // Numbered by posting order (#116): a follower would never be merged (lib/updater.ts), so following one is
    // refused with the reason rather than accepted and silently ignored.
    if (await postingOrderSeries(id)) return reply.code(409).send({ error: 'posting_order', message: POSTING_ORDER_REFUSAL });
    const plan = getPlan(planId);
    if (!plan) return reply.code(409).send({ error: 'plan_stale', message: 'That list has moved on. Scan again.' });
    if (plan.seriesId !== id) return reply.code(400).send({ error: 'bad_request', message: 'That plan is for another series.' });
    const cand = plan.candidates.find((c) => c.source === source && c.sourceSeriesId === sourceSeriesId);
    if (!cand) return reply.code(400).send({ error: 'not_in_plan', message: 'That source was not one of the options.' });
    // The plan's own mark, and the series' main source NOW (v0.54.0): a plan lives five minutes, and a Make main in
    // between can make one of its candidates the main source -- following that would list every chapter twice.
    // Reintroduce by checking `cand.pinned` alone: "a fill plan made before a switch cannot follow the series' own
    // main source" in seriesSources.int.test.ts is answered 200, with a row naming the main.
    if (cand.pinned || source === (await one<{ source_id: string | null }>('SELECT source_id FROM lib_series WHERE id = $1', [id]))?.source_id) {
      return reply.code(409).send({ error: 'is_primary', message: 'That is already the series’ own source.' });
    }
    // The one rule, shared with the add-time auto-follow (lib/fill.ts followable(): coverage at or over
    // MIN_COVERAGE with a verdict that says the numbering lines up), so the two paths cannot disagree
    // about what may be followed.
    // Reintroduce by deleting this guard: "a source with a different story is refused" in
    // seriesSources.int.test.ts fails with 200 -- the plan carries the WRONG fixture with its refusal
    // attached, and nothing else between the plan and the INSERT reads it.
    if (!followable(cand)) {
      // The reason is the scan's own verdict; only a numbering mismatch is a fault of the source, the rest is
      // a source that could not be judged this time (in a cooldown, unreachable, not tried).
      const message = cand.why === 'numbering_mismatch' || cand.why === 'ok' || cand.why === 'nothing_to_fill'
        ? 'That source does not line up with the chapters you hold.'
        : cand.why === 'no_chapters' ? 'That source lists no chapters for this title.'
        : 'That source could not be checked this time. Scan again.';
      return reply.code(400).send({ error: 'not_followable', reason: cand.why, coverage: cand.coverage, message });
    }
    if (!getSource(source) || await isDisabled(source).catch(() => false)) {
      return reply.code(409).send({ error: 'source_unavailable', message: 'That source is not available right now.' });
    }
    // The same-language guard's backstop (v0.52.0, #123), once the source is known to be there (one that is not
    // declares no language). The fill scan never offers a source in another language, so only a plan from before the
    // series' language changed reaches this: refused with both languages and the way to have both, an edition --
    // `edition` is the add route's own `{of, lang}`. Reintroduce by dropping it: "the manual follow refuses a stale
    // plan's source in another language" in languageGuard.int.test.ts follows it.
    // When the work holds an edition in that language already, the way on is that edition (`existing`): the sentence
    // says to follow it there, and the web's key opens it instead of adding a second. Reintroduce by always offering a
    // new edition: "the refusal points at the edition the work holds in that language" in languageGuard.int.test.ts.
    if (!(await followGuard(id))(source)) {
      const theirs = sourceLanguage(source);
      const ours = (await seriesLanguage(id)).lang;
      const existing = await editionFollowing(id, source, SYSTEM_CTX);
      const said = existing
        ? say('follow.languageDiffersEdition', { theirs, ours, edition: existing.lang })
        : say('follow.languageDiffers', { theirs, ours });
      return reply.code(409).send({
        error: 'language_differs', message: said.text, messageSaid: saidOf(said),
        edition: { of: id, lang: theirs, ...(existing ? { existing } : {}) },
      });
    }
    const row = await getSeriesRow(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    // `added_by` is who chose the source: NULL means the add-time auto-follow did (lib/autoFollow.ts), and
    // the sheet reads that as "followed for you". A person confirming the same source through a plan is a
    // human choice and must be recorded as one, so the upsert keeps the newest non-null author rather than
    // the row's -- and the automatic path, whose EXCLUDED.added_by is NULL, can never demote a human's.
    await q(
      `INSERT INTO series_sources (series_id, source_id, source_series_id, title, coverage, added_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (series_id, source_id) DO UPDATE SET source_series_id = EXCLUDED.source_series_id,
         title = EXCLUDED.title, coverage = EXCLUDED.coverage,
         added_by = COALESCE(EXCLUDED.added_by, series_sources.added_by)`,
      [id, source, sourceSeriesId, cand.title || null, cand.coverage, userIdOf(req)],
    );
    await logAudit('series.follow_source', { userId: userIdOf(req), detail: { id, title: row.title, source, sourceSeriesId, coverage: cand.coverage }, req });
    // The answer is the list as the follow left it, read BEFORE the refresh below starts: a follow is not a check.
    // Read after it, the answer raced the refresh's own stamp on the new source (updater.ts writes
    // series_sources.checked_at as soon as the source answers) and said "never checked" or "checked just now" by
    // a millisecond, whichever of the two drew the warmer pooled connection -- #115's evidence writes left the
    // answer one that had never read these tables, and on an idle machine it lost every time. The refresh's check
    // shows on the next read.
    // Reintroduce by reading this after the refresh has started: "never checked yet" in seriesSources.int.test.ts.
    const list = await seriesSourcesFor(id);
    // The listing again, now with this source in it, as an unfollow does (below): the chapters it has that the
    // series lacks show up on the series page at once, as rows to fetch, instead of at the next sweep -- which
    // is when the owner expected them and saw nothing (v0.48.3). Not waited for: a Cloudflare source can take
    // a minute to list, and the Find missing dialog's "Follow and download" asks the fetch route, which
    // refreshes the listing itself before it picks a copy.
    void updateSeries(id, 0).catch(() => {});
    return { ok: true, sources: list };
  });

  /**
   * Make a source the series follows its main source (v0.54.0, lib/mainSource.ts): the Sources sheet's Make main.
   * Body `{sourceId, old?}`: `old` is what becomes of the old main -- `auto` (the default) keeps it as the last
   * follower while it still carries the series (usable or cooling), `keep` and `drop` decide. 200 `{ok, from, to, old:
   * kept|dropped, langPinned?, sources}`; 404 `not_found`; 409 with the refusal's code, its English and its said code
   * (`is_main`, `not_followed`, `posting_order`, `renumber_pending`, `busy`, `source_unavailable`, `moved`, and
   * `language_differs` with `edition {of, lang, existing?}`, as the follow route answers it).
   */
  app.post('/api/admin/series/:id/main-source', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ sourceId: z.string().min(1).max(200), old: z.enum(['auto', 'keep', 'drop']).optional() }).strict().safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'Name the source ({sourceId}), and optionally what becomes of the old main ({old}).' });
    const out = await switchMainSource(id, b.data.sourceId, {
      old: b.data.old ?? 'auto', ctx: await viewCtxFor(userIdOf(req), roleOf(req)), userId: userIdOf(req), via: 'manual', req,
    });
    if ('refused' in out) {
      if (out.refused === 'not_found' || !out.said) return reply.code(404).send({ error: 'not_found' });
      return reply.code(409).send({
        error: out.refused, message: out.said.text, messageSaid: saidOf(out.said), ...(out.edition ? { edition: out.edition } : {}),
      });
    }
    // Read before the refresh starts, as the follow's answer is (above): the switch is not a check.
    const list = await seriesSourcesFor(id);
    // The listing again, through the new main: its chapters show on the series page now, not at the next sweep.
    void updateSeries(id, 0).catch(() => {});
    return { ok: true, from: out.from, to: out.to, old: out.old, ...(out.langPinned ? { langPinned: out.langPinned } : {}), sources: list };
  });

  app.delete('/api/admin/series/:id/sources/:sourceId', async (req, reply) => {
    const { id, sourceId } = req.params as { id: string; sourceId: string };
    const gone = await q<{ source_id: string }>(
      'DELETE FROM series_sources WHERE series_id = $1 AND source_id = $2 RETURNING source_id', [id, sourceId]);
    if (!gone.length) return reply.code(404).send({ error: 'not_found' });
    // The listing rows this source carried go with it. A listing row is the authorisation for a manual
    // fetch (POST /api/sources/fetch, the refetch below), and the rows are otherwise rewritten only by the
    // series' next successful check -- a full sweep cycle away on a large install, never if auto_update is
    // off -- so until then a member could still fetch through the source the admin just removed, and the
    // series page kept showing ghosts from it. Best effort: an unfollow must not fail on its ledger.
    // Reintroduce by dropping this DELETE: "unfollowing a source takes its listing rows with it" in
    // chapterActions.int.test.ts still finds the number listed.
    await q('DELETE FROM series_listing WHERE series_id = $1 AND source_id = $2', [id, sourceId]).catch(() => {});
    // Failures follow the series (v0.55.3, lib/chapterFailures.ts): what this source failed is the main source's to
    // retry now, filed under it with its tries starting again -- never left under a source the series no longer reads,
    // where Health listed it and Fix everything called it a person's. Best effort, as the listing's DELETE.
    // Reintroduce by dropping it: "unfollowing a source files the chapters it failed under the main source" in
    // mainSource.int.test.ts finds chapter 6 under ms-c, capped.
    await refileFailures(q, [id]).catch(() => 0);
    // The DELETE is the guarantee; the rewrite is the courtesy. A number both sources listed whose CHOSEN
    // copy was the follower's went with the rows above, so until the next check it is neither a ghost nor
    // fetchable even though the primary lists it. A listing pass with nothing to download (maxNew 0) puts
    // those numbers back under the primary within seconds; if the primary does not answer, the DELETE has
    // already done the part that matters. Not awaited: an unfollow answers at once.
    void updateSeries(id, 0).catch(() => {});
    await logAudit('series.unfollow_source', { userId: userIdOf(req), detail: { id, source: sourceId }, req });
    return { ok: true, sources: await seriesSourcesFor(id) };
  });

  // "Check for new chapters" for one series. updateSeries downloads synchronously and can run for minutes,
  // so this starts it and returns; the UI polls the status below rather than holding a request open.
  app.post('/api/admin/series/:id/check', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (seriesChecks.get(id)?.running) return reply.code(409).send({ error: 'busy', message: 'Already checking that series.' });
    const row = await getSeriesRow(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    seriesChecks.set(id, { running: true, startedAt: Date.now() });
    // A followed source's chapters arrive through this check, so its downloads are the check's (#82 follow-up).
    void withOrigin('check', userIdOf(req), () => updateSeries(id, Number((req.body as any)?.maxNew) || 10))
      .then(async (r) => {
        // A downloaded file is only a file until a scan makes it a book. The sweep scans after its loop;
        // this path never did, so a chapter "Check" had just fetched stayed invisible until the next sweep
        // -- the button appeared to do nothing, and the status said "1 added" about a series page that
        // showed no new row. The stamps go on after the scan for the same reason the sweep orders them so:
        // there is no row to stamp before it.
        if (r.added > 0 && r.folder) {
          // Logged, not swallowed: a failed scan here leaves the status saying "N added" over a page with no
          // new rows, and the log line is the only trace of why.
          const warn = (step: string) => (e: unknown) => console.warn(`[check] ${step} failed for ${r.folder}: ${(e as Error)?.message || e}`);
          await persistScan().catch(warn('scan'));
          await setBookDates(r.folder, r.chapters ?? []).catch(warn('date stamp'));
          await setBookMeta(r.folder, r.landed).catch(warn('provenance stamp'));
        }
        // `waiting` is how many numbers are being held for the preferred group (lib/releases.ts), so the
        // page can say "2 held for <group>" instead of leaving "0 added" to look like nothing is new.
        seriesChecks.set(id, { running: false, added: r.added, ...(r.waiting ? { waiting: r.waiting } : {}), finishedAt: Date.now() });
      })
      .catch((e) => seriesChecks.set(id, { running: false, error: (e as Error)?.message || 'failed', finishedAt: Date.now() }));
    await logAudit('series.check', { userId: userIdOf(req), detail: { id, title: row.title }, req });
    return { ok: true, started: true };
  });

  app.get('/api/admin/series/:id/check', async (req) => {
    const { id } = req.params as { id: string };
    return seriesChecks.get(id) ?? { running: false };
  });

  // ---- library management: hide, restore, merge ----
  // Delete HIDES the series rather than erasing it: the id survives, so favourites, ratings, notes and
  // reading history stay attached to something real, and the action is undoable. Files are never touched.
  app.delete('/api/admin/series/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await getSeriesRow(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (row.deleted_at) return reply.code(400).send({ error: 'already_deleted', message: 'That series is already hidden.' });
    if (row.merged_into) return reply.code(400).send({ error: 'merged', message: 'That series was merged into another one.' });
    const r = await deleteSeries(id);
    await logAudit('series.delete', { userId: userIdOf(req), detail: { id, title: row.title, books: r.books }, req });
    return r;
  });

  // The library page's "Remove from library" over a selection: the single DELETE above, once per id, and
  // nothing more. ⚠️ Hide ONLY -- never the files. Deleting files is the irreversible step, it walks the
  // person's own read library too (libraryAdmin.ts), and it stays behind the per-title typed confirm on
  // Content → Library; a bulk that did both would let "Select all" plus one tap wipe hand-curated folders
  // with no undo. A series that cannot be hidden is SKIPPED with the reason the single route would have
  // answered, rather than failing the whole batch: the rest of the selection is still what the person
  // asked for. One `series.delete` audit row per series, with its title, exactly as the single route
  // writes it -- the audit page then reads the same whichever way it was done, and a batch of 200 is not
  // one opaque line of ids.
  app.post('/api/admin/series/bulk/hide', async (req, reply) => {
    const b = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(500) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'Which series should be removed?' });
    let hidden = 0;
    const skipped: Array<{ id: string; reason: 'merged' | 'already_hidden' | 'not_found' }> = [];
    // One id listed twice is one series: the second pass would read `already_hidden` and mislabel it.
    for (const id of new Set(b.data.ids)) {
      const row = await getSeriesRow(id);
      if (!row) { skipped.push({ id, reason: 'not_found' }); continue; }
      if (row.deleted_at) { skipped.push({ id, reason: 'already_hidden' }); continue; }
      if (row.merged_into) { skipped.push({ id, reason: 'merged' }); continue; }
      const r = await deleteSeries(id);
      hidden++;
      await logAudit('series.delete', { userId: userIdOf(req), detail: { id, title: row.title, books: r.books }, req });
    }
    return { ok: true, hidden, skipped };
  });

  app.post('/api/admin/series/:id/restore', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await getSeriesRow(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (!row.deleted_at) return reply.code(400).send({ error: 'not_deleted', message: 'That series is not hidden.' });
    await restoreSeries(id);
    await logAudit('series.restore', { userId: userIdOf(req), detail: { id, title: row.title }, req });
    return { ok: true };
  });

  /**
   * Hidden series, so the admin can see and undo what was deleted.
   *
   * `live_books` / `pruned_books` are counted from lib_books rather than trusting books_count, which the
   * scan wrote before anything was deleted: they are how the panel knows a series whose files Delete files
   * has already removed (every row pruned) and says so on its Put back, instead of offering a restore that
   * lists chapters which 404 -- and how it knows there is nothing left for a second Delete files to do.
   */
  app.get('/api/admin/series/deleted', async () => ({
    content: await q(
      `SELECT s.id, s.title, s.folder, s.books_count, s.deleted_at,
              (SELECT count(*)::int FROM lib_books b WHERE b.series_id = s.id AND b.pruned_at IS NULL) AS live_books,
              (SELECT count(*)::int FROM lib_books b WHERE b.series_id = s.id AND b.pruned_at IS NOT NULL) AS pruned_books
         FROM lib_series s
        WHERE s.deleted_at IS NOT NULL ORDER BY s.deleted_at DESC`,
    ),
  }));

  // Merge :id INTO the series named in the body. Chapters and everything a user owns move across; nothing
  // is de-duplicated and no chapter row is deleted, so no reading progress can be lost.
  app.post('/api/admin/series/:id/merge', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ into: z.string().min(1).max(64) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'Which series should it merge into?' });
    // lib/libraryAdmin.ts mergeRefusal (v0.55.0): the checks in one place, which Fix everything's merges ask too.
    // Two language editions of one work are two languages' chapters (v0.52.0): merged, the list would hold both under
    // one number each, in whichever language came first. Reintroduce by dropping that check: "a merge inside one work
    // is refused" in editions.int.test.ts answers 200 and moves the chapters.
    const no = await mergeRefusal(id, b.data.into);
    if (no) {
      switch (no.refused) {
        case 'same_series': return reply.code(400).send({ error: 'same_series', message: 'A series cannot merge into itself.' });
        case 'not_found': return reply.code(404).send({ error: 'not_found' });
        case 'deleted': return reply.code(400).send({ error: 'deleted', message: `The ${no.which} series is hidden. Restore it first.` });
        case 'merged': return reply.code(400).send({ error: 'merged', message: `The ${no.which} series was already merged into another one.` });
        case 'same_work': return reply.code(409).send({ error: 'same_work', message: 'These are two language editions of one work. Unlink one first if they really are the same edition.' });
      }
    }
    const from = (await getSeriesRow(id))!;
    const into = (await getSeriesRow(b.data.into))!;
    const r = await mergeSeries(id, into.id);
    await logAudit('series.merge', {
      userId: userIdOf(req),
      detail: { from: id, fromTitle: from.title, into: into.id, intoTitle: into.title, ...r },
      req,
    });
    return r;
  });

  /**
   * Link two series already in the library as language editions of one work (v0.52.0, #72): Health's "Link as
   * editions" on a duplicate pair in two languages. `lang` states :id's language and `withLang` `with`'s, each where
   * the series does not state one (otherwise what it is inferred to be). A series already in a work brings the work:
   * the other joins it. Refused when both are in one language (merge them instead), when the language is taken in
   * the work, and when each is already in a different work.
   */
  app.post('/api/admin/series/:id/editions', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({
      with: z.string().min(1).max(64), lang: z.string().min(1).max(35).optional(), withLang: z.string().min(1).max(35).optional(),
    }).strict().safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'Which series should it be linked with?' });
    // lib/editions.ts linkPair (v0.55.0): the rules in one place, which Fix everything's duplicates phase runs too.
    const r = await linkPair(id, b.data.with, { lang: b.data.lang, withLang: b.data.withLang });
    if ('refused' in r) {
      switch (r.refused) {
        case 'same_series': return reply.code(400).send({ error: 'same_series', message: 'A series cannot be an edition of itself.' });
        case 'not_found': return reply.code(404).send({ error: 'not_found' });
        case 'deleted': return reply.code(400).send({ error: 'deleted', message: 'One of the two is removed from the library. Put it back first.' });
        case 'same_work': return reply.code(409).send({ error: 'same_work', message: 'These two are already editions of one work.' });
        case 'other_work': return reply.code(409).send({ error: 'other_work', message: 'Each is already an edition of another work. Unlink one of them first.' });
        case 'same_lang': return reply.code(409).send({ error: 'same_lang', message: 'Both are in the same language: merge them instead.' });
        case 'edition_exists': return reply.code(409).send({ error: 'edition_exists', message: 'That language already has its edition in this work.' });
      }
    }
    await logAudit('series.edition_link', {
      userId: userIdOf(req), detail: { id: r.joiner.id, title: r.joiner.title, of: r.of.id, ofTitle: r.of.title, lang: r.lang }, req,
    });
    return { ok: true, workId: r.workId, lang: r.lang };
  });

  /** Take a series out of its work (v0.52.0): it stays in the library on its own; a work left with one edition dissolves. */
  app.delete('/api/admin/series/:id/edition', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await getSeriesRow(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const r = await unlinkEdition(id);
    if (!r) return reply.code(409).send({ error: 'not_an_edition', message: 'That series is not an edition of another.' });
    await logAudit('series.edition_unlink', { userId: userIdOf(req), detail: { id, title: row.title, workId: r.workId }, req });
    return { ok: true };
  });

  app.put('/api/admin/series/:id/meta', async (req, reply) => {
    const { id } = req.params as { id: string };
    // Status is free text with a generous cap rather than an enum: the scanner writes whatever ComicInfo's
    // PublishingStatus said, so validating against a fixed list here would reject values Uchiyomi itself
    // produced. The UI offers the four common ones plus an escape hatch.
    const b = z.object({
      title: z.string().max(300).nullish(),
      summary: z.string().max(8000).nullish(),
      author: z.string().max(300).nullish(),
      status: z.string().max(60).nullish(),
      genres: z.array(z.string().min(1).max(60)).max(50).nullish(),
      // A minimum age, or null to fall back to whatever ComicInfo said. See lib/ageRating.ts.
      ageRating: z.number().int().min(0).max(18).nullish(),
      /**
       * "Always show": keep this series visible when the 18+ switch would hide it (its genres, its rating, its
       * library). A shelf switch only: an account whose age limit is below the series' rating still cannot open it.
       *
       * Absent leaves the flag as it is, which matters because this route writes every other column
       * unconditionally: the edit modal does not send this field, and without the COALESCE below an
       * ordinary retitle would quietly clear the exemption.
       */
      adultExempt: z.boolean().nullish(),
      /**
       * Which way the series reads (#102), one of Komga's four, or null for "automatic": whatever ComicInfo,
       * the source or AniList said (lib/readingDirection.ts), WEBTOON when none did.
       *
       * ABSENT leaves it as it is and NULL clears it -- the three states the column needs. A COALESCE, as
       * adultExempt has, cannot clear, and writing it unconditionally like the rest would let an edit modal
       * from before this field (a cached PWA) wipe the direction on every retitle.
       */
      readingDirection: z.enum(READING_DIRECTIONS).nullable().optional(),
      /**
       * What kind of comic it is (lib/seriesType.ts) -- manga, manhwa, manhua, webtoon, comic -- or null for
       * "automatic": what the genres, the source or AniList said, unknown when none did. The notice-chapter switches
       * go by it (lib/noticeChapters.ts). Absent leaves it, null clears it, as readingDirection.
       */
      seriesType: z.enum(SERIES_TYPES).nullable().optional(),
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const norm = (v: string | null | undefined) => { const s = (v ?? '').trim(); return s ? s : null; };
    // Genres are a set, not a string: trim, drop blanks, de-duplicate case-insensitively keeping the first
    // spelling, preserve order. null means "inherit what was scanned"; [] means "cleared on purpose", and
    // COALESCE in SERIES_SRC treats those two differently, which is the whole point of the distinction.
    const normGenres = (v: string[] | null | undefined): string[] | null => {
      if (v == null) return null;
      const seen = new Set<string>();
      const out: string[] = [];
      for (const g of v) {
        const t = g.trim();
        if (!t || seen.has(t.toLowerCase())) continue;
        seen.add(t.toLowerCase());
        out.push(t);
      }
      return out;
    };
    // Every column is written on every call, so the client must send the whole object. The edit modal
    // already holds all six fields; a partial PUT would silently clear the ones it omitted.
    //
    // `ageRating` was added to this statement without being added to the parameter array, so the SQL asked
    // for $7 and got six values. Postgres refused the statement, the handler has no try/catch, and every
    // save from the edit modal 500'd -- not just rating changes: retitling, the summary, the author and the
    // genres all failed the same way, under a message that only said "Could not save". `?? null` because
    // the field is nullish: absent and null both mean "inherit whatever ComicInfo said".
    const sentDirection = b.data.readingDirection !== undefined;
    const sentType = b.data.seriesType !== undefined;
    // "unknown" is the absence of a type, not one: stored as NULL, so "Automatic" and "Unknown" cannot disagree.
    const type = isKnownSeriesType(b.data.seriesType) ? b.data.seriesType : null;
    await tx(async (qq) => {
      await qq(
        `INSERT INTO series_overrides (series_id, title, summary, author, status, genres, age_rating, adult_exempt, reading_direction, series_type, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $10, $12, now())
         ON CONFLICT (series_id) DO UPDATE SET title = $2, summary = $3, author = $4, status = $5,
           genres = $6, age_rating = $7,
           adult_exempt = COALESCE($8, series_overrides.adult_exempt),
           reading_direction = CASE WHEN $9::boolean THEN $10 ELSE series_overrides.reading_direction END,
           series_type = CASE WHEN $11::boolean THEN $12 ELSE series_overrides.series_type END,
           updated_at = now()`,
        [id, norm(b.data.title), norm(b.data.summary), norm(b.data.author), norm(b.data.status),
         normGenres(b.data.genres), b.data.ageRating ?? null, b.data.adultExempt ?? null,
         sentDirection, b.data.readingDirection ?? null, sentType, type],
      );
      // The 18+ rating is the WORK's (v0.52.0, #72): written onto every other language edition in the same
      // transaction, so a capped account can never open the Spanish copy of a work rated 18+ in English, nor the 18+
      // switch tidy one edition away and leave the other. Only the rating and "Always show": a title or a summary is
      // each edition's own. Reintroduce by dropping this: "rating one edition 18+ hides the other from a capped
      // account" in editions.int.test.ts opens the sibling.
      await qq(
        `INSERT INTO series_overrides (series_id, age_rating, adult_exempt)
         SELECT o.id, $2, $3 FROM lib_series s JOIN lib_series o ON o.work_id = s.work_id AND o.id <> s.id
          WHERE s.id = $1 AND s.work_id IS NOT NULL
         ON CONFLICT (series_id) DO UPDATE SET age_rating = EXCLUDED.age_rating,
           adult_exempt = COALESCE(EXCLUDED.adult_exempt, series_overrides.adult_exempt), updated_at = now()`,
        [id, b.data.ageRating ?? null, b.data.adultExempt ?? null],
      );
    });
    await logAudit('series.meta_override', { userId: userIdOf(req), detail: { id }, req });
    return { ok: true };
  });

  /**
   * Correct one chapter's number or title.
   *
   * Chapter numbers are parsed out of filenames by the row's name rule (lib/naming.ts numberByRule). Rule 1,
   * numFromName, takes the first number it finds, so a "Vol 2 Ch 5.cbz" scanned before v0.55.2 is chapter 2.
   * That misorders the reader and is what gets reported to a tracker. A number set here on a file holding a range
   * of chapters makes it that one chapter (lib/chapterRanges.ts).
   *
   * Deliberately one chapter at a time. A bulk re-parse with a smarter rule would renumber hundreds at once,
   * and every renumbered chapter that is already COMPLETED changes what AniList is told -- which is why rule 2
   * reads only the files the scanner meets from v0.55.2 on. The response
   * reports how many people have finished this chapter so the UI can say so before the change is made
   * rather than after.
   */
  app.put('/api/admin/books/:id/meta', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({
      number: z.number().min(0).max(100000).nullish(),
      title: z.string().max(300).nullish(),
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });

    const book = await one<{ number: number }>('SELECT number FROM lib_books WHERE id = $1', [id]);
    if (!book) return reply.code(404).send({ error: 'not_found' });

    const title = (b.data.title ?? '').trim() || null;
    const number = b.data.number ?? null;
    if (number == null && title == null) {
      await q('DELETE FROM book_overrides WHERE book_id = $1', [id]);
    } else {
      await q(
        `INSERT INTO book_overrides (book_id, number, title, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (book_id) DO UPDATE SET number = $2, title = $3, updated_at = now()`,
        [id, number, title],
      );
    }
    const affected = await one<{ n: number }>(
      'SELECT count(*)::int n FROM read_progress WHERE book_id = $1 AND completed', [id],
    );
    await logAudit('book.meta_override', {
      userId: userIdOf(req),
      detail: { id, from: book.number, to: number, title },
      req,
    });
    return { ok: true, affectedUsers: affected?.n ?? 0 };
  });

  /**
   * "It's fine": this chapter really is one or two pages at the source.
   *
   * The Health page reports every whole-numbered chapter of one or two images as a probably-failed
   * download, and some of them are simply true -- a long strip published as two files, an announcement.
   * Without a way to say so, those rows sat on the page for ever and the nightly repair asked three sources
   * about them again every night for nothing.
   *
   * The nightly writes this stamp ITSELF, but only when it has proof (every source that has the chapter
   * answered, none of them silent or in a cooldown). This route is the human version of the same judgement,
   * and `confirmed: false` is how it is withdrawn -- after which the chapter is an open finding again and
   * the repair will look at it on its next run. The stamp is also cleared automatically whenever the file
   * changes underneath it (restampBook, and persistScan's mtime CASE), because the proof was about bytes
   * that are no longer there.
   */
  app.post('/api/admin/books/:id/confirm-short', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ confirmed: z.boolean().optional() }).safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const confirmed = b.data.confirmed ?? true;
    const book = await one<{ series_id: string; number: number; pages: number; title: string }>(
      `SELECT b.series_id, b.number::float8 AS number, b.pages, ls.title
         FROM lib_books b JOIN lib_series ls ON ls.id = b.series_id
        WHERE b.id = $1`,
      [id],
    );
    if (!book) return reply.code(404).send({ error: 'not_found' });
    // short_result (v0.49.0) says who decided and when, so the greyed row reads "marked fine by an admin"
    // rather than "confirmed short at the source" -- the repair's proof is a different claim. Withdrawn with
    // the stamp: the chapter is an open finding again, and the repair's next look writes its own.
    await q(`UPDATE lib_books SET short_confirmed_at = CASE WHEN $2 THEN now() ELSE NULL END,
                    short_result = CASE WHEN $2 THEN jsonb_build_object('at', now(), 'why', 'confirmed_by_admin',
                                   'by', (SELECT u.username FROM users u WHERE u.id::text = $3)) ELSE NULL END
              WHERE id = $1`, [id, confirmed, userIdOf(req) ?? '']);
    await logAudit('book.short_confirmed', {
      userId: userIdOf(req),
      detail: { id, seriesId: book.series_id, title: book.title, number: Number(book.number), pages: book.pages, confirmed },
      req,
    });
    return { ok: true };
  });

  // ---- file operations on the user's own library ----
  //
  // The only routes in the app that write to a collection the user owns. Both take one series, both are
  // explicitly confirmed by the client, and both refuse rather than half-apply.

  /** Is the library writable at all, so the UI can say so before anyone clicks. */
  app.get('/api/admin/library/writable', async () => {
    const roots = (await q<{ root: string }>('SELECT DISTINCT root FROM lib_books WHERE root IS NOT NULL')).map((r) => r.root);
    const checks = await Promise.all(roots.map(async (root) => ({ root, ...(await writePreflight(root)) })));
    return { content: checks, ok: checks.every((c) => c.ok) };
  });

  /**
   * The typed confirmation, compared the way a person can actually type it: the fold in lib/confirmTitle.ts,
   * which is the same file ConfirmDialog.tsx enables the button from. A title read off a macOS-written share
   * or a ComicInfo.xml can be NFD ("Cafe" + a combining accent) while every keyboard produces the
   * precomposed "Café" (R3's probe P6), and a scraped one can carry a curly apostrophe, an en dash, a
   * literal `&amp;` or a non-breaking space that no keyboard produces at all -- 38 of the owner's 241 series
   * do (#66). Byte-for-byte none of those ever matched. The rule lives in one file on purpose: loosening
   * only the client would have turned a dead button into a 400 from here. Reintroduce by comparing
   * `typed.trim().normalize('NFC')` with the same of `title`: "route: a straight apostrophe confirms a
   * curly-apostrophe title" in forgetSeries.int.test.ts reads confirm_mismatch (the NFD sibling still
   * passes, which is why that one alone was never enough).
   */
  const sameTitle = (typed: string, title: string) => confirmsTitle(typed, title);

  app.post('/api/admin/series/:id/delete-files', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ confirm: z.string() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const row = await getSeriesRow(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (!sameTitle(b.data.confirm, row.title)) {
      return reply.code(400).send({ error: 'confirm_mismatch', message: 'Type the series title to confirm — typography does not have to match.' });
    }
    const r = await deleteSeriesFiles(id);
    if (!r.ok) return reply.code(409).send({ error: 'refused', message: r.reason, fix: r.fix });
    await logAudit('series.delete_files', { userId: userIdOf(req), detail: { id, files: r.files, bytes: r.bytes }, req });
    return r;
  });

  /**
   * The third step after Remove and Delete files: erase the series row and everyone's history on it.
   *
   * Same typed confirmation as Delete files, for a larger blast radius: this is the one action in the app
   * that rewrites other members' stats, streaks, leaderboard and Wrapped, and it has no Put back. Every
   * precondition (live row, a chapter row still claiming a file, a root that is not there, a folder that
   * still holds chapters) is checked inside forgetSeries' transaction and answered here as 409 with the
   * reason and the fix, exactly as Delete files refuses; the client shows both.
   */
  app.post('/api/admin/series/:id/forget', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ confirm: z.string() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const row = await getSeriesRow(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (!sameTitle(b.data.confirm, row.title)) {
      return reply.code(400).send({ error: 'confirm_mismatch', message: 'Type the series title to confirm — typography does not have to match.' });
    }
    const r = await forgetSeries(id);
    if (!r.ok) {
      if (r.refused === 'not_found') return reply.code(404).send({ error: 'not_found' });
      return reply.code(409).send({ error: 'refused', message: r.message, fix: r.fix });
    }
    await logAudit('series.forget', {
      userId: userIdOf(req),
      detail: { id, title: r.title, folder: r.folder, books: r.books, absorbed: r.absorbed, absorbedIds: r.absorbedIds, users: r.users, rowsByTable: r.rowsByTable },
      req,
    });
    return { ok: true, books: r.books, absorbed: r.absorbed, users: r.users };
  });

  // ---- chapter-level file operations ----
  //
  // Both touch DL_ROOT only, on the same footing as the read-chapter cleanup (lib/chapterCleanup.ts): a
  // file under DL_ROOT is one this server fetched and could fetch again, and the read library is somebody's
  // own collection that we did not put there. Neither takes a typed confirmation -- that is the series-level
  // rule, where the blast radius is a whole folder -- and the client confirms with a dialog naming the count.

  /** The rows a chapter action was asked about, with everything the classification below needs. */
  const chapterRows = (seriesId: string, ids: string[]) =>
    q<{ id: string; root: string | null; file: string; number: number; pruned_at: string | null }>(
      'SELECT id, root, file, number, pruned_at FROM lib_books WHERE series_id = $1 AND id = ANY($2)', [seriesId, ids]);

  /**
   * Delete the files of chosen chapters and keep their rows as tombstones, so reading history survives and
   * the updater's have-set still contains the number (the same reasoning as the cleanup's, on the column's
   * note in lib/migrate.ts). Delete-then-mark per file, so a failed unlink leaves an honest row.
   */
  app.post('/api/admin/series/:id/chapters/delete', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ bookIds: z.array(z.string().min(1).max(64)).min(1).max(500) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const row = await getSeriesRow(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    // lib/libraryAdmin.ts deleteChapterFiles (v0.55.0): the route's own rules, in one place, which Fix everything's files
    // phase runs too -- the bookmark veto, the download folder only, the root itself never.
    const r = await deleteChapterFiles(id, b.data.bookIds, { userId: userIdOf(req), req });
    if ('refused' in r) return reply.code(409).send({ error: 'refused', message: r.refused.reason, fix: r.refused.fix });
    return { ok: true, applied: r.applied, bytes: r.bytes, skipped: r.skipped };
  });

  /**
   * Fetch chosen chapters again -- the copy the release rules choose NOW, which after a change of priority
   * or a follow may be another group's -- onto the SAME rows, so progress stays attached.
   *
   * Only a file at exactly the path the downloader would write (`Chapter <n>.cbz` in the series folder,
   * lib/downloader.ts chapterFileRel) is eligible: the downloader names its output from the number, so only
   * that path lands back on the same lib_books row (the scanner conflicts on (root, file)), which is what
   * keeps read_progress attached and lets persistScan clear the tombstone mark. A file named any other way
   * would come back as a second row beside the old one.
   *
   * The old copy is set aside as `<file>.refetch-bak` -- a suffix the scanner does not read as a chapter --
   * until the new one lands, and put back if it does not: a re-download that fails must never cost the
   * chapter that was there. A restart mid-refetch leaves the bak orphaned; reapStaleTemp (lib/fsAtomic.ts)
   * puts those back at boot.
   *
   * A pick -- `{ bookId, source, sourceId }` -- replaces the row's file with ONE named copy out of the
   * number's stored versions rather than with the rules' choice: "this chapter, but group B's version".
   * The row's number selects the listing row and the pick selects the copy in it (`not_listed` when no
   * stored copy matches). As on POST /api/sources/fetch, a pick ignores the group rules including the
   * blocklist: the versions list labels the copy blocked, and an admin who asks for it anyway has chosen
   * that copy on purpose. Everything after the choice -- set aside, mark, settle -- is the same path.
   */
  app.post('/api/admin/series/:id/chapters/refetch', async (req, reply) => {
    const { id } = req.params as { id: string };
    const bookId = z.string().min(1).max(64);
    const b = z.object({
      bookIds: z.array(bookId).max(FILL_MAX_CHAPTERS).optional(),
      picks: z.array(z.object({ bookId, source: z.string().min(1).max(200), sourceId: z.string().min(1).max(200) })).max(FILL_MAX_CHAPTERS).optional(),
    })
      // One cap over both lists, as on the member-facing fetch: one job, one documented size.
      .refine((v) => (v.bookIds?.length ?? 0) + (v.picks?.length ?? 0) >= 1, { message: 'nothing named' })
      .refine((v) => (v.bookIds?.length ?? 0) + (v.picks?.length ?? 0) <= FILL_MAX_CHAPTERS, { message: 'too many' })
      .safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const s = await one<any>(
      `SELECT id, title, folder, summary, author, genres, web, status, source_id FROM lib_series WHERE id = $1`, [id]);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    // First pick per row wins; a row named in both lists is fetched as its pick, the more specific ask. A
    // second pick for the same row is reported as `duplicate`, as on POST /api/sources/fetch, rather than
    // dropped without a word.
    const skipped: Array<{ id: string; reason: string; source?: string; sourceId?: string }> = [];
    const pickOf = new Map<string, { source: string; sourceId: string }>();
    for (const pk of b.data.picks ?? []) {
      if (!pickOf.has(pk.bookId)) pickOf.set(pk.bookId, pk);
      // Named like the fetch route's entry: a scripted caller sending two copies for one row must be able
      // to tell WHICH one was ignored.
      else skipped.push({ id: pk.bookId, reason: 'duplicate', source: pk.source, sourceId: pk.sourceId });
    }
    const ids = [...new Set([...(b.data.bookIds ?? []), ...pickOf.keys()])];
    const rows = new Map((await chapterRows(id, ids)).map((r) => [r.id, r]));

    const eligible: Array<{ id: string; number: number; file: string; abs: string; pruned: boolean }> = [];
    const root = resolve(DL_ROOT);
    for (const bid of ids) {
      const r = rows.get(bid);
      if (!r) { skipped.push({ id: bid, reason: 'not_found' }); continue; }
      if (r.root !== DL_ROOT) { skipped.push({ id: bid, reason: 'not_owned' }); continue; }
      const number = Number(r.number);
      const abs = containedPath(DL_ROOT, r.file);
      // The root itself can never be the chapter file (the path check below already forbids it: a chapter
      // file ends in `Chapter <n>.cbz`), but the rename below is a destructive move and the comparison is
      // free -- the same guard the delete route and the cleanup carry.
      if (!abs || abs === root || r.file !== chapterFileRel(s.folder, number)) { skipped.push({ id: bid, reason: 'not_ours' }); continue; }
      eligible.push({ id: bid, number, file: r.file, abs, pruned: !!r.pruned_at });
    }
    // The listing is refreshed FIRST, so the copy fetched is the one the release rules choose NOW -- which
    // is the promise this route makes ("after a change of priority ... another group's"). A preferences
    // save never touches series_listing, so without this the row still held the copy the LAST sweep chose:
    // an admin who ranked Group B and clicked Fetch again got Group A's identical copy back and a toast
    // saying nothing had changed. maxNew 0 lists and persists and breaks before any download; a source
    // that does not answer leaves the previous listing standing (stale beats empty, lib/updater.ts), and
    // the not_listed / source_unavailable paths below handle that. Best effort: the refresh must never be
    // the thing that stops a fetch.
    // Reintroduce by dropping this call: "fetch again takes the copy the rules choose now, not the one the
    // last check chose" in chapterActions.int.test.ts downloads the old group's copy.
    // Bounded like the member-facing fetch (REFRESH_BUDGET_MS, see routes/sources.ts), and only once the
    // folder is known to be free: a busy folder is a 409 either way, and it should not cost a source call.
    if (eligible.length) {
      if (jobBusy(s.folder)) return reply.code(409).send({ error: 'busy', message: 'A download for that series is already running.' });
      await withTimeout(updateSeries(id, 0), REFRESH_BUDGET_MS).catch(() => {});
    }
    // The listing is the authorisation, exactly as POST /api/sources/fetch: what is fetched is the chosen
    // copy in it, and a number the sources no longer list has nothing to fetch.
    const listed = new Map((await q<{ number: number; title: string | null; source_id: string; status: string; chosen: SourceChapter; copies: ListingCopy[] }>(
      'SELECT number, title, source_id, status, chosen, copies FROM series_listing WHERE series_id = $1 AND number = ANY($2::real[])',
      [id, eligible.map((e) => e.number)],
    )).map((r) => [Number(r.number), r]));
    // A listing row's source_id is trusted only while the series still follows that source: the primary,
    // or a series_sources row. An unfollow drops the rows it carried (the route above), but a stale row --
    // one the next check has not rewritten yet, or one the unfollow's best-effort DELETE missed -- must
    // never authorise a download from a source the admin removed.
    // Reintroduce by dropping the `followed` check in stateOf: "a stale listing row never authorises a
    // source the series does not follow" in chapterActions.int.test.ts starts a download from it.
    const followed = new Set([
      ...(s.source_id ? [s.source_id as string] : []),
      ...(await q<{ source_id: string }>('SELECT source_id FROM series_sources WHERE series_id = $1', [id]).catch(() => [])).map((r) => r.source_id),
    ]);
    const sourceState = new Map<string, 'ok' | 'source_unavailable' | 'cooldown'>();
    const stateOf = async (sid: string) => {
      let st = sourceState.get(sid);
      if (st) return st;
      if (!followed.has(sid) || !getSource(sid) || await isDisabled(sid).catch(() => false)) st = 'source_unavailable';
      else if (await blockedNow(sid).catch(() => null)) st = 'cooldown';
      else st = 'ok';
      sourceState.set(sid, st);
      return st;
    };
    const todo: Array<{ row: typeof eligible[number]; chapter: SourceChapter }> = [];
    for (const e of eligible) {
      const l = listed.get(e.number);
      const pick = pickOf.get(e.id);
      if (pick) {
        // The named copy, and nothing about the number's status: the blocklist is the sweep's rule, not
        // the admin's hand (the route comment). The source gate still applies to the copy's own source.
        const copy = l?.copies?.find((c) => c.source === pick.source && c.sourceId === pick.sourceId);
        if (!l || !copy) { skipped.push({ id: e.id, reason: 'not_listed' }); continue; }
        const st = await stateOf(copy.source);
        if (st !== 'ok') { skipped.push({ id: e.id, reason: st }); continue; }
        todo.push({ row: e, chapter: copyToChapter(copy, { number: e.number, title: l.title }) });
        continue;
      }
      if (!l) { skipped.push({ id: e.id, reason: 'not_listed' }); continue; }
      if (l.status === 'blocked') { skipped.push({ id: e.id, reason: 'blocked_group' }); continue; }
      const st = await stateOf(l.source_id);
      if (st !== 'ok') { skipped.push({ id: e.id, reason: st }); continue; }
      todo.push({ row: e, chapter: { ...l.chosen, source: l.source_id } });
    }
    if (!todo.length) {
      return reply.code(409).send({ error: 'nothing_to_fetch', message: 'None of those chapters can be fetched again right now.', skipped });
    }
    if (jobBusy(s.folder)) return reply.code(409).send({ error: 'busy', message: 'A download for that series is already running.' });
    const w = await allWritable([DL_ROOT]);
    if (!w.ok) return reply.code(409).send({ error: 'refused', message: w.reason, fix: w.fix });

    // Set aside, mark, forget the failures -- per row, before the job starts, so the downloader's own
    // "already on disk" check does not skip the very file we are replacing.
    const byNumber = new Map(todo.map((t) => [t.row.number, t.row]));
    for (const t of todo) {
      await rename(t.row.abs, `${t.row.abs}${REFETCH_BAK}`).catch((e: any) => {
        // No file behind a tombstone is expected; anything else is worth a line, and the settle hook
        // below still handles it (the file is where it was, so the downloader skips and the mark clears).
        if (e?.code !== 'ENOENT') console.warn(`[refetch] could not set aside ${t.row.file}: ${e?.message || e}`);
      });
      await tombstoneBooks([t.row.id]);
    }
    await q('DELETE FROM chapter_failures WHERE series_id = $1 AND number = ANY($2::real[])',
      [id, todo.map((t) => t.row.number)]).catch(() => {});
    const picks = todo.filter((t) => pickOf.has(t.row.id)).map((t) => ({ bookId: t.row.id, number: t.row.number, source: t.chapter.source, sourceId: t.chapter.sourceId }));
    await logAudit('series.chapters_refetch', {
      userId: userIdOf(req),
      detail: { id, title: s.title, bookIds: todo.map((t) => t.row.id), numbers: todo.map((t) => t.row.number), ...(picks.length ? { picks } : {}), skipped },
      req,
    });
    const { total } = startDownloadJob({
      origin: 'refetch',
      folder: s.folder, title: s.title, seriesId: id,
      chapters: todo.map((t) => t.chapter).sort((a, b) => a.number - b.number),
      meta: { series: s.title, summary: s.summary, author: s.author, genres: s.genres, url: s.web, status: s.status },
      by: userIdOf(req),
      // A Cancel (#82) settles every chapter the job did not reach as not landed, so each set-aside copy
      // below is put back exactly as for a chapter that failed.
      onSettled: async (ch, landed) => {
        const r = byNumber.get(ch.number);
        if (!r) return;
        const bak = `${r.abs}${REFETCH_BAK}`;
        if (landed) {
          await rm(bak, { force: true });
          // A copy picked by name is the admin's choice, and the nightly group upgrade (lib/repair.ts
          // stepGroups) leaves it alone; a plain Fetch again hands the choice back to the preferences.
          await q('UPDATE lib_books SET picked_at = $2 WHERE id = $1', [r.id, pickOf.has(r.id) ? new Date() : null]).catch(() => {});
          return;
        }
        // Not landed: put the old copy back if it was set aside, and un-mark the row whenever a file is
        // there to read -- the restored one, or the original a failed rename left in place. A row that had
        // no file to begin with (a tombstone being fetched again) keeps its mark: the bytes are still gone.
        const exists = (p: string) => stat(p).then(() => true, () => false);
        if (await exists(bak) && !(await exists(r.abs))) await rename(bak, r.abs).catch(() => {});
        if (await exists(r.abs)) await q('UPDATE lib_books SET pruned_at = NULL WHERE id = $1', [r.id]).catch(() => {});
      },
    });
    return { ok: true, started: true, folder: s.folder, total, skipped };
  });

  /**
   * Move one series into a library by hand, regardless of where its folder lives.
   *
   * This is what makes a library more than a folder: "everything under Manga/Seinen, plus these twelve
   * titles that live somewhere else". The move is PINNED, so neither the folder rule nor creating a library
   * whose path contains this series takes it back.
   *
   * Passing null unpins it and lets the folder rule decide again, which is the way back out.
   */
  app.post('/api/admin/series/:id/library', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ libraryId: z.string().min(1).max(64).nullable() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });

    const series = await one<{ folder: string }>('SELECT folder FROM lib_series WHERE id = $1', [id]);
    if (!series) return reply.code(404).send({ error: 'not_found' });

    if (b.data.libraryId === null) {
      const libs = await libraryRows();
      await q('UPDATE lib_series SET library_id = $2, library_pinned = false WHERE id = $1',
        [id, libraryIdFor(series.folder, libs)]);
      await logAudit('series.library', { userId: userIdOf(req), detail: { id, libraryId: null }, req });
      return { ok: true, pinned: false };
    }

    const lib = await one<{ id: string }>('SELECT id FROM libraries WHERE id = $1', [b.data.libraryId]);
    if (!lib) return reply.code(404).send({ error: 'no_such_library' });
    await q('UPDATE lib_series SET library_id = $2, library_pinned = true WHERE id = $1', [id, b.data.libraryId]);
    await logAudit('series.library', { userId: userIdOf(req), detail: { id, libraryId: b.data.libraryId }, req });
    return { ok: true, pinned: true };
  });

  /**
   * The same move, for a selection.
   *
   * Looping the single-series route from the browser would work and would fire one request per title; a
   * bulk move of a whole shelf is exactly the case where that is worst. Reports what it skipped rather
   * than quietly applying to fewer series than were ticked, which is the shape every other bulk route here
   * already uses.
   */
  app.post('/api/admin/series/library', async (req, reply) => {
    const b = z.object({
      seriesIds: z.array(z.string().min(1).max(64)).min(1).max(500),
      libraryId: z.string().min(1).max(64).nullable(),
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });

    const found = await q<{ id: string; folder: string }>(
      'SELECT id, folder FROM lib_series WHERE id = ANY($1)', [b.data.seriesIds]);
    const skipped = b.data.seriesIds.filter((id) => !found.some((f) => f.id === id)).map((id) => ({ id }));

    if (b.data.libraryId === null) {
      const libs = await libraryRows();
      for (const s of found) {
        await q('UPDATE lib_series SET library_id = $2, library_pinned = false WHERE id = $1',
          [s.id, libraryIdFor(s.folder, libs)]);
      }
    } else {
      const lib = await one<{ id: string }>('SELECT id FROM libraries WHERE id = $1', [b.data.libraryId]);
      if (!lib) return reply.code(404).send({ error: 'no_such_library' });
      await q('UPDATE lib_series SET library_id = $2, library_pinned = true WHERE id = ANY($1)',
        [found.map((s) => s.id), b.data.libraryId]);
    }
    await logAudit('series.library', {
      userId: userIdOf(req), detail: { n: found.length, libraryId: b.data.libraryId }, req });
    return { applied: found.length, skipped };
  });

  app.post('/api/admin/series/:id/rename-folder', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ folder: z.string().min(1).max(400) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await renameSeriesFolder(id, b.data.folder);
    if (!r.ok) return reply.code(409).send({ error: 'refused', message: r.reason, fix: r.fix });
    await logAudit('series.rename_folder', { userId: userIdOf(req), detail: { id, folder: b.data.folder }, req });
    return r;
  });

  /** The 409 for a folder another library holds: which folder, and whose, named in the message too. */
  const heldAnswer = (held: { path: string; id: string; name: string }) => ({
    error: 'duplicate', message: `"${held.name}" already covers ${held.path}.`, path: held.path, library: { id: held.id, name: held.name },
  });

  // ---- libraries ----
  //
  // Declared, never inferred from disk. The obvious rule (each top-level folder is a library) is wrong on a
  // real install: that level holds source names written by the downloader, so inferring would rename one
  // library into several named after scrapers. Library zero covers the whole root and always exists.

  app.get('/api/admin/libraries', async () => {
    const rows = await q<{ id: string; name: string; path: string; paths: string[]; age_rating: number | null; n: number; pinned: number; members: string[] }>(
      // `paths`: every folder it holds (v0.55.1, #148), the first -- `path`, all a v0.55.0 reads -- first, then by name.
      `SELECT l.id, l.name, l.path, l.age_rating,
              (SELECT coalesce(array_agg(lp.path ORDER BY lp.path <> l.path, lp.path), '{}') FROM library_paths lp
                WHERE lp.library_id = l.id) AS paths,
              (SELECT count(*)::int FROM lib_series s WHERE s.library_id = l.id AND ${visibleToAll('s')}) AS n,
              (SELECT count(*)::int FROM lib_series s WHERE s.library_id = l.id AND s.library_pinned
                 AND ${visibleToAll('s')}) AS pinned,
              -- Who can open it. A member with NO grant rows sees every library, so they count as allowed
              -- here even though nothing links them to this row -- which is what the UI has to show, or
              -- "nobody can see this" would be wrong for a brand-new install.
              (SELECT coalesce(array_agg(u.id), '{}') FROM users u
                WHERE u.role <> 'admin'
                  AND (NOT EXISTS (SELECT 1 FROM user_libraries ul WHERE ul.user_id = u.id)
                       OR EXISTS (SELECT 1 FROM user_libraries ul WHERE ul.user_id = u.id AND ul.library_id = l.id))
              ) AS members
         FROM libraries l ORDER BY l.sort_order, l.name`,
    );
    // Candidate subdirectories: folders that hold series but are not yet a library. Annotated where the name
    // matches a known source, because that is the case an admin should NOT usually promote.
    const sources = new Set((await q<{ source: string }>('SELECT DISTINCT source FROM lib_series')).map((r) => r.source));
    const taken = new Set(rows.flatMap((r) => r.paths));
    // EVERY ancestor of every series folder, not just the first segment. The top level of a real library
    // root holds source names written by the downloader -- which this list then flags as such -- so offering
    // only that level meant the one folder an admin actually wanted was unreachable.
    const seen = new Map<string, number>();
    for (const r of await q<{ folder: string }>(`SELECT folder FROM lib_series s WHERE ${visibleToAll('s')}`)) {
      const parts = r.folder.split('/');
      // Stop before the last segment: that is the series folder itself, and a library of exactly one series
      // is not a library.
      for (let i = 1; i < parts.length; i++) {
        const prefix = parts.slice(0, i).join('/');
        if (!prefix || taken.has(prefix)) continue;
        seen.set(prefix, (seen.get(prefix) ?? 0) + 1);
      }
    }
    const candidates = [...seen.entries()]
      .map(([path, n]) => ({ path, series: n, looksLikeSource: sources.has(path), depth: path.split('/').length }))
      // Source-named folders sort LAST rather than merely being labelled: they are the ones not to promote,
      // so they should not be the first thing offered.
      .sort((a, b) => Number(a.looksLikeSource) - Number(b.looksLikeSource) || b.series - a.series)
      .slice(0, 60);
    return { content: rows, candidates };
  });

  // ⚠️ Every typed library path in the four routes below goes through toStoredRel (a `\` typed on Windows is a
  // separator, and the database stores `/`: lib/relPath.ts) and, on the desktop, diskSpelling -- NTFS and
  // APFS find `manga/seinen` for `Manga/Seinen`, but lib_series.folder and a library's folders are compared as
  // exact strings with the on-disk spelling, so the typed case would match nothing. Both are identities on
  // the server. The folder browser does it here; the preview, create and edit take every folder through
  // storedFolders (lib/libraryFolders.ts).

  /**
   * The folders that actually exist, at any depth.
   *
   * Nothing listed what was on disk, so picking a library folder meant choosing from a list of guesses or
   * knowing the path by heart. Both roots are walked, because a series routinely lives half in the read
   * library and half in the downloads folder, and an admin should not have to know which.
   *
   * Every path goes through containedPath() before it reaches the filesystem -- the same guard the rename
   * and delete paths use, and the only thing between a query parameter and the disk.
   */
  app.get('/api/admin/libraries/folders', async (req, reply) => {
    const raw = await diskSpelling([LIBRARY_ROOT, DL_ROOT],
      trimTrailingSlashes(toStoredRel(String((req.query as { path?: string }).path ?? '')).replace(/^\/+/, '')).trim());
    const { readdir } = await import('node:fs/promises');

    const names = new Set<string>();
    for (const root of [LIBRARY_ROOT, DL_ROOT]) {
      const abs = raw ? containedPath(root, raw) : root;
      if (!abs) return reply.code(400).send({ error: 'bad_path' });
      for (const e of await readdir(abs, { withFileTypes: true }).catch(() => [])) {
        if (e.isDirectory() && !e.name.startsWith('.')) names.add(e.name);
      }
    }
    if (!names.size && raw) {
      // Distinguish "no subfolders" from "that path is not there", because the difference is what the person
      // typing it needs to know. containedPath() only answers whether the path would be INSIDE the root, so
      // asking it here would call every typo a real but empty folder.
      const { stat } = await import('node:fs/promises');
      const real = await Promise.all([LIBRARY_ROOT, DL_ROOT].map(async (r) => {
        const abs = containedPath(r, raw);
        return abs ? await stat(abs).then((st) => st.isDirectory()).catch(() => false) : false;
      }));
      if (!real.some(Boolean)) return reply.code(404).send({ error: 'not_found' });
    }

    // How many series each child would bring, so the count is visible before anything is committed.
    const children = [...names].sort((a, b) => a.localeCompare(b));
    const counts = new Map<string, number>();
    if (children.length) {
      const prefixes = children.map((c) => (raw ? `${raw}/${c}` : c));
      const rows = await q<{ p: string; n: number }>(
        `SELECT p, count(*)::int AS n
           FROM unnest($1::text[]) AS p
           JOIN lib_series s ON ${underSql('s.folder', 'p')} AND ${visibleToAll('s')}
          GROUP BY p`,
        [prefixes],
      );
      for (const r of rows) counts.set(r.p, r.n);
    }

    return {
      path: raw,
      parent: raw.includes('/') ? raw.slice(0, raw.lastIndexOf('/')) : (raw ? '' : null),
      folders: children.map((name) => {
        const path = raw ? `${raw}/${name}` : name;
        return { name, path, series: counts.get(path) ?? 0 };
      }),
    };
  });

  /**
   * What promoting a path WOULD do, without doing it. Same habit as the chapter-override route.
   *
   * The statement the save runs, short of its UPDATE (lib/libraryFolders.ts), or the preview promises something other
   * than what happens. With `id` it is an edit of that library, and counts what leaves it as well as what comes in.
   * `paths` (repeated, since v0.55.1) is every folder the library would hold; `path` alone is one. A folder another
   * library holds is refused as the save refuses it.
   */
  app.get('/api/admin/libraries/preview', async (req, reply) => {
    const qs = req.query as { path?: string; paths?: string | string[]; id?: string };
    const raw = qs.paths !== undefined ? [qs.paths].flat() : qs.path !== undefined ? [qs.path] : [];
    if (!raw.length || raw.length > LIBRARY_MAX_FOLDERS) return reply.code(400).send({ error: 'bad_request' });
    const paths = await storedFolders(raw.map(String));
    if (!paths) return reply.code(400).send({ error: 'bad_path', message: 'Use a folder path relative to your library root.' });
    const held = await heldElsewhere(q, qs.id || '', paths);
    if (held) return reply.code(409).send(heldAnswer(held));
    return { path: paths[0], paths, ...(await previewMoves(q, qs.id || null, paths)) };
  });

  app.post('/api/admin/libraries', async (req, reply) => {
    const b = z.object({
      name: z.string().min(1).max(80),
      // relative, posix, no escaping the root. Containment is checked again at the filesystem layer.
      path: z.string().min(1).max(300).optional(),
      // Every folder it holds (v0.55.1, #148), the first being the one `path` names alone -- what a rollback to v0.55.0
      // reads. Several, so one library can be "these source folders" without the ones kept apart.
      paths: z.array(z.string().min(1).max(300)).min(1).max(LIBRARY_MAX_FOLDERS).optional(),
      // Accepted here so creating a rated library is ONE request. The UI used to POST the library and then
      // PATCH the rating, which meant a failed second call left a library that silently showed everything
      // to everyone under a "Created" toast.
      ageRating: z.number().int().min(0).max(18).nullable().optional(),
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const raw = b.data.paths ?? (b.data.path !== undefined ? [b.data.path] : null);
    if (!raw) return reply.code(400).send({ error: 'bad_request' });
    const paths = await storedFolders(raw);
    if (!paths) return reply.code(400).send({ error: 'bad_path', message: 'Use a folder path relative to your library root.' });
    const id = `lib_${randomBytes(8).toString('hex')}`;
    const out = await tx(async (qq) => {
      await lockLibrarySaves(qq);
      // Nesting is allowed. libraryIdFor() resolves the MOST SPECIFIC folder containing a series, so
      // `Manga/Seinen` inside `Manga` is unambiguous -- and refusing it blocked the obvious thing an admin
      // wants, which is to carve a big library into parts. Only a folder another library holds is refused.
      // Checked under the lock, so two saves cannot both take one folder.
      const held = await heldElsewhere(qq, id, paths);
      if (held) return { held };
      await qq(`INSERT INTO libraries (id, name, path, age_rating) VALUES ($1,$2,$3,$4)`,
        [id, b.data.name.trim(), paths[0], b.data.ageRating ?? null]);
      // Reassignment is deliberate and happens here, not in a scan: the scanner keeps an existing folder in
      // the library it is already in, precisely so it can never re-mint an id by recomputing. The longest folder
      // wins, so a new `Manga/Seinen` takes from `Manga` and never the other way, and a pinned series stays put:
      // an admin who filed one somewhere on purpose should not have it taken back by a folder rule they were
      // working around (lib/libraryFolders.ts).
      const moved = await applyMoves(qq, id, paths);
      await setFolders(qq, id, paths);
      return { moved };
    });
    if (out.held) return reply.code(409).send(heldAnswer(out.held));
    await logAudit('library.create', { userId: userIdOf(req), detail: { id, paths, moved: out.moved }, req });
    return { ok: true, id, moved: out.moved };
  });

  app.patch('/api/admin/libraries/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({
      name: z.string().min(1).max(80).optional(),
      // Changing the path used to mean delete-and-recreate, which also dropped every access grant on it.
      path: z.string().max(300).optional(),
      // Every folder it holds, replaced whole (v0.55.1, #148); `path` alone is one. Ignored for the default library,
      // whose empty path is "everything no other library holds".
      paths: z.array(z.string().max(300)).min(1).max(LIBRARY_MAX_FOLDERS).optional(),
      // A default its series inherit. null clears it.
      ageRating: z.number().int().min(0).max(18).nullable().optional(),
      // Who may see it. See the note below: this is not simply "insert a row".
      members: z.array(z.string()).optional(),
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });

    // Folders are checked before anything is written, so a refused save changes nothing.
    const raw = id === 'lib' ? null : b.data.paths ?? (b.data.path !== undefined ? [b.data.path] : null);
    const paths = raw && await storedFolders(raw);
    if (raw && !paths) return reply.code(400).send({ error: 'bad_path', message: 'Use a folder path relative to your library root.' });
    if (!(await one('SELECT 1 FROM libraries WHERE id = $1', [id]))) return reply.code(404).send({ error: 'not_found' });

    let moved = 0;
    if (paths) {
      // In one transaction: what the old folders held that the new ones do not goes to whichever library DOES
      // hold it, resolved as the scanner would -- not blindly to the default, which would tear a nested library's
      // contents out of its parent -- and what the new ones hold comes in (lib/libraryFolders.ts).
      const out = await tx(async (qq) => {
        await lockLibrarySaves(qq);
        const held = await heldElsewhere(qq, id, paths);
        if (held) return { held };
        const n = await applyMoves(qq, id, paths);
        await setFolders(qq, id, paths);
        return { moved: n };
      });
      if (out.held) return reply.code(409).send(heldAnswer(out.held));
      moved = out.moved ?? 0;
    }

    if (b.data.name !== undefined) {
      await q('UPDATE libraries SET name = $2 WHERE id = $1', [id, b.data.name.trim()]);
    }
    if (b.data.ageRating !== undefined) {
      await q('UPDATE libraries SET age_rating = $2 WHERE id = $1', [id, b.data.ageRating]);
    }

    /**
     * Access, from the library's side.
     *
     * user_libraries having NO ROWS for a member means EVERY library. So naively inserting one row to
     * "grant" access to an unrestricted member would restrict them to only this one -- the exact opposite of
     * what the button says, and the easiest way to lock someone out of their own library.
     *
     * So granting to an unrestricted member is a no-op, and REVOKING from one has to first write out every
     * other library explicitly, because that is the only way to express "everything except this".
     */
    if (b.data.members !== undefined) {
      const want = new Set(b.data.members);
      await tx(async (qq) => {
        const users = await qq<{ id: string; role: string }>(`SELECT id, role FROM users WHERE role <> 'admin'`);
        const libs = await qq<{ id: string }>('SELECT id FROM libraries');
        for (const u of users) {
          const rows = await qq<{ library_id: string }>('SELECT library_id FROM user_libraries WHERE user_id = $1', [u.id]);
          const unrestricted = rows.length === 0;
          const has = unrestricted || rows.some((r) => r.library_id === id);
          if (want.has(u.id) === has) continue;

          if (want.has(u.id)) {
            await qq('INSERT INTO user_libraries (user_id, library_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [u.id, id]);
            // They can open something now, so the "nothing" marker is no longer true.
            await qq('DELETE FROM user_libraries WHERE user_id = $1 AND library_id = $2', [u.id, NO_LIBRARIES]);
          } else if (unrestricted) {
            // "Everything except this one" can only be said as a full list.
            for (const l of libs) {
              if (l.id === id) continue;
              await qq('INSERT INTO user_libraries (user_id, library_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [u.id, l.id]);
            }
            // And if this was the ONLY library, that list is empty -- which would read as unrestricted again.
            await keepRestricted(qq, u.id);
          } else {
            await qq('DELETE FROM user_libraries WHERE user_id = $1 AND library_id = $2', [u.id, id]);
            await keepRestricted(qq, u.id);
          }
        }
      });
    }

    await logAudit('library.update', { userId: userIdOf(req), detail: { id, ...b.data, moved }, req });
    return { ok: true, moved };
  });

  app.delete('/api/admin/libraries/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === 'lib') {
      return reply.code(400).send({ error: 'cannot_delete', message: 'The default library cannot be removed.' });
    }
    const moved = await tx(async (qq) => {
      await lockLibrarySaves(qq);
      // Back to whichever library still holds each folder -- the enclosing one for a nested library, the
      // default otherwise. Sending everything to the default would tear a nested library's contents out of
      // its parent on delete, which is not what "remove this library" means. What it held by hand moves too.
      //
      // The FK is RESTRICT on purpose: read_progress cascades from lib_series, so a cascading library delete
      // would destroy reading history two hops away.
      const n = await applyMoves(qq, id, [], true);
      // Whoever was granted this one specifically. Taking their row away can leave them with none at all,
      // and none means every library -- so removing a shelf would quietly hand them the whole collection.
      const granted = await qq<{ user_id: string }>('SELECT user_id FROM user_libraries WHERE library_id = $1', [id]);
      await qq('DELETE FROM user_libraries WHERE library_id = $1', [id]);
      for (const g of granted) await keepRestricted(qq, g.user_id);
      // Its library_paths rows go with it (ON DELETE CASCADE).
      await qq('DELETE FROM libraries WHERE id = $1', [id]);
      return n;
    });
    await logAudit('library.delete', { userId: userIdOf(req), detail: { id, moved }, req });
    return { ok: true, moved };
  });

  // Set/replace a cover or background: paste a URL, upload an image (base64 data URL), or reset to automatic. The body
  // limit fits the largest picture Edit details takes once it is base64 (lib/seriesArt.ts ART_BODY_LIMIT).
  app.put('/api/admin/series/:id/art', { bodyLimit: ART_BODY_LIMIT }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({
      kind: z.enum(['cover', 'banner']),
      mode: z.enum(['url', 'upload', 'reset']),
      url: z.string().url().optional(),
      dataUrl: z.string().optional(),
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const { kind, mode } = b.data;
    let value: string | null = null;
    if (mode === 'url') {
      if (!b.data.url) return reply.code(400).send({ error: 'no_url', message: 'Paste an image URL.' });
      value = b.data.url;
      await rm(artFile(id, kind), { force: true }).catch(() => {});
    } else if (mode === 'upload') {
      const m = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(b.data.dataUrl || '');
      if (!m) return reply.code(400).send({ error: 'bad_image', message: 'Upload a valid image.' });
      let buf: Buffer;
      try {
        const maxW = kind === 'banner' ? 1600 : 1000;
        buf = await sharp(Buffer.from(m[1], 'base64')).rotate().resize({ width: maxW, withoutEnlargement: true }).webp({ quality: 86 }).toBuffer();
      } catch { return reply.code(400).send({ error: 'bad_image', message: "That file isn't a readable image." }); }
      await mkdir(ART_DIR, { recursive: true }).catch(() => {});
      await writeFile(artFile(id, kind), buf);
      value = 'upload';
    } else {
      await rm(artFile(id, kind), { force: true }).catch(() => {});
      value = null;
    }
    const col = kind === 'cover' ? 'cover' : 'banner';
    await q(
      `INSERT INTO series_overrides (series_id, ${col}, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (series_id) DO UPDATE SET ${col} = $2, updated_at = now()`,
      [id, value],
    );
    await logAudit('series.art_override', { userId: userIdOf(req), detail: { id, kind, mode }, req });
    return { ok: true };
  });

  // ---- art review: per-series art status + candidates + bulk backfill ----

  // Every series with its art status, worst-first — feeds the admin Art Review gallery.
  // The query lives in lib/seriesArt so a test can execute it; see the note there.
  app.get('/api/admin/art/overview', async () => ({ content: await artOverview() }));

  // Art options for one series: AniList matches (banner + cover) and MangaDex covers — the admin picks one.
  app.get('/api/admin/art/candidates/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = await one<{ title: string }>('SELECT title FROM lib_series WHERE id = $1', [id]);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    const cleaned = s.title.replace(/\([^)]*\)/g, '').replace(/\s*[-–—:].*$/, '').trim() || s.title;
    const [anilist, anilistLoose, kitsu, md] = await Promise.all([
      fetchAniListCandidates(s.title).catch(() => []),
      cleaned !== s.title ? fetchAniListCandidates(cleaned).catch(() => []) : Promise.resolve([]),
      fetchKitsuBanner(s.title).then((b) => (b ? [{ title: s.title, banner: b, cover: null as string | null }] : [])).catch(() => []),
      (async () => {
        try {
          const mdSrc = getSource('mangadex');
          if (!mdSrc) return [];
          const res = await mdSrc.search(s.title);
          return (res || []).slice(0, 5).map((r) => ({ title: r.title, banner: null as string | null, cover: r.coverUrl || null }));
        } catch { return []; }
      })(),
    ]);
    // merge, dedupe by image URL, label the origin
    const seen = new Set<string>();
    const out: Array<{ origin: string; title: string; banner: string | null; cover: string | null }> = [];
    for (const [origin, list] of [['anilist', anilist], ['anilist', anilistLoose], ['kitsu', kitsu], ['mangadex', md]] as const) {
      for (const c of list) {
        const key = c.banner || c.cover || '';
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({ origin, ...c });
      }
    }
    return { title: s.title, content: out };
  });

  // Bulk backfill: re-hunt art for series missing a banner (or any art). AniList first (cleaned-title retry),
  // MangaDex cover as a second source. Runs in the background; poll /api/admin/art/backfill/status.
  app.post('/api/admin/art/backfill', async (req, reply) => {
    if (artJob?.running) return reply.code(409).send({ error: 'busy', message: 'A backfill is already running.' });
    const targets = await q<{ id: string; title: string }>(
      `SELECT s.id, s.title FROM lib_series s
       LEFT JOIN series_art a ON a.series_id = s.id
       LEFT JOIN series_overrides o ON o.series_id = s.id
       WHERE ${visibleToAll('s')} AND (a.banner IS NULL OR a.banner = '') AND o.banner IS NULL
       ORDER BY s.title`,
    );
    const job: ArtJob = { running: true, total: targets.length, done: 0, banners: 0, covers: 0, misses: 0, startedAt: Date.now() };
    artJob = job;
    await logAudit('art.backfill_start', { userId: userIdOf(req), detail: { count: targets.length }, req });
    void (async () => {
      for (const t of targets) {
        try {
          // banner hunt, widest net first-hit-wins: AniList manga (banner or its anime adaptation's, same
          // query) → harsher-cleaned retry → direct AniList ANIME search → Kitsu wide cover.
          let art = await fetchAniListArt(t.title).catch(() => ({ banner: null as string | null, cover: null as string | null }));
          const harsh = t.title.replace(/\([^)]*\)/g, '').replace(/\s*[-–—:].*$/, '').trim();
          if (!art.banner && harsh && harsh !== t.title) {
            const retry = await fetchAniListArt(harsh).catch(() => ({ banner: null, cover: null }));
            art = { banner: retry.banner ?? art.banner, cover: art.cover ?? retry.cover };
          }
          if (!art.banner) art.banner = await fetchAnimeBanner(t.title).catch(() => null);
          if (!art.banner) art.banner = await fetchKitsuBanner(t.title);
          if (!art.banner && harsh && harsh !== t.title) art.banner = await fetchKitsuBanner(harsh);
          if (!art.cover) {
            try {
              const mdSrc = getSource('mangadex');
              const res = mdSrc ? await mdSrc.search(t.title) : [];
              art.cover = res?.[0]?.coverUrl || null;
            } catch { /* mangadex miss is fine */ }
          }
          if (art.banner || art.cover) {
            await q(
              `INSERT INTO series_art (series_id, banner, cover) VALUES ($1, $2, $3)
               ON CONFLICT (series_id) DO UPDATE SET
                 banner = COALESCE(EXCLUDED.banner, series_art.banner),
                 cover  = COALESCE(EXCLUDED.cover,  series_art.cover), fetched_at = now()`,
              [t.id, art.banner, art.cover],
            );
            if ((art as any).mediaId) {
              await linkSeries(t.id, (art as any).mediaId, (art as any).mediaTitle ?? null);
              await learnDirection({ id: t.id }, directionFromAniListMatch(t.title, art as any), 'anilist').catch(() => {});
              await learnTypeFromAniList({ id: t.id }, t.title, art as any);
            }
            if (art.banner) job.banners++;
            else job.covers++;
          } else job.misses++;
        } catch { job.misses++; }
        job.done++;
        await new Promise((r) => setTimeout(r, 2200)); // stay under AniList's ~30 req/min
      }
      job.running = false;
    })();
    return { ok: true, total: targets.length };
  });
  app.get('/api/admin/art/backfill/status', async () => ({ job: artJob }));

  // ---- extensions (Mihon/Tachiyomi sources, via an optional Suwayomi server) ----
  // Uchiyomi is the remote control, the engine does the work: the catalogue below asks Suwayomi to fetch its
  // repositories and to install, update or remove an extension, and the routes after it choose WHICH of an
  // extension's sources become Uchiyomi sources. Nothing here downloads an APK into this process. (This
  // comment used to claim the opposite -- that installing was a link out to Suwayomi's UI -- which stopped
  // being true the day the catalogue block below was written.)
  // What the engine is doing and why, for the Extensions tab and its setup screen (#72): lib/extensionEngine.ts.
  // ⚠️ It registers the engine's sources when it answers again after a registration that missed it, so the
  // setup screen's "Check again" -- a refetch of this -- brings the extensions back at once.
  app.get('/api/admin/extensions/status', async () => engineStatusReport());

  // Every extension route from here down answers 400 rather than a confusing 502 when there is no engine.
  const needExt = (reply: FastifyReply) =>
    suwayomiConfigured() ? null : reply.code(400).send({ error: 'not_configured', message: 'No extension server is configured.' });

  // The full source list, joined with what we have switched on. Falls back to the remembered rows when the
  // extension server is briefly unreachable, so the page still renders something useful.
  app.get('/api/admin/extensions/sources', async (req) => {
    if (!suwayomiConfigured()) return { content: [], reachable: false };
    // `pkg` (#116): one extension's sources, for its settings sheet's language select.
    const { q: term, lang, pkg } = req.query as { q?: string; lang?: string; pkg?: string };
    let remote: Array<{ id: string; name: string; displayName?: string | null; lang?: string | null; isNsfw?: boolean | null; supportsLatest?: boolean | null; extension?: { pkgName?: string | null } | null }> = [];
    let reachable = true;
    try {
      remote = await listRemoteSources();
    } catch {
      reachable = false;
      // The persisted `nsfw` is read here rather than defaulting to false: this fallback renders the whole
      // source list when Suwayomi is briefly down, and an adult source shown as clean is the one mistake
      // this list must not make.
      remote = (await q<{ source_id: string; name: string; lang: string | null; nsfw: boolean }>(
        'SELECT source_id, name, lang, nsfw FROM suwayomi_sources ORDER BY name',
      )).map((r) => ({ id: r.source_id, name: r.name, lang: r.lang, isNsfw: r.nsfw }));
    }
    const on = new Set(
      (await q<{ source_id: string }>('SELECT source_id FROM suwayomi_sources WHERE enabled = true')).map((r) => r.source_id),
    );
    // How many series came from each source (v0.53.0), switched on or not: Admin → Extensions says it beside each of an
    // extension's languages, and what removing the extension leaves without updates. By the same rule the Languages
    // overview counts by, keyed on the engine's id (`lib_series.source_id` holds 'sw:' + it).
    const used = new Map(
      (await q<{ source_id: string; n: number }>(
        `SELECT s.source_id, count(*)::int AS n FROM lib_series s
          WHERE s.source_id LIKE 'sw:%' AND ${visibleToAll('s')} GROUP BY s.source_id`,
      )).map((r) => [r.source_id.slice('sw:'.length), r.n]),
    );
    const needle = (term || '').trim().toLowerCase();
    const content = remote
      .map((s) => ({
        id: String(s.id),
        name: s.displayName?.trim() || s.name,
        lang: s.lang || null,
        nsfw: !!s.isNsfw,
        supportsLatest: !!s.supportsLatest,
        enabled: on.has(String(s.id)),
        pkgName: s.extension?.pkgName ?? null,
        used: used.get(String(s.id)) ?? 0,
      }))
      .filter((s) => (!needle || s.name.toLowerCase().includes(needle)) && (!lang || s.lang === lang) && (!pkg || s.pkgName === pkg))
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
    // The per-language overview rides along unfiltered: `q` and `lang` narrow the source list, and a
    // Languages panel that only knew about the language you had just filtered to would be no panel.
    return { content, reachable, total: remote.length, langs: await langOverview(), hiddenLangs: await getHiddenLangs() };
  });

  /**
   * Many sources at once, by id or by language, in one statement and one reload.
   *
   * The per-source route below reloads the registry and smoke-tests the adapter on every call, which is
   * right for one source and wrong for thirty: "hide Russian" would be thirty reloads and thirty probes of
   * thirty sites. There is deliberately no smoke test here -- what this changes is which sources are
   * registered, and a language is switched off far more often than on.
   */
  app.post('/api/admin/extensions/sources/bulk', async (req, reply) => {
    const b = z.object({
      ids: z.array(z.string().min(1).max(64)).max(500).optional(),
      langs: z.array(z.string().min(1).max(16)).max(100).optional(),
      enabled: z.boolean(),
    }).refine((v) => (v.ids?.length ?? 0) + (v.langs?.length ?? 0) > 0, { message: 'ids or langs' }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    if (needExt(reply)) return;
    const { ids = [], langs = [] } = b.data;
    // A source of an extension installed in the engine's own page since the last registration has no row yet, and
    // the switch below only flips rows: recorded first, or switching it on was a quiet no-op (v0.53.0).
    await rememberMissing(ids);
    const r = await setSourcesEnabled({ ids, langs, enabled: b.data.enabled });
    const load = await reloadAll();
    await logAudit(b.data.enabled ? 'source.extension_enable' : 'source.extension_disable', {
      userId: userIdOf(req), detail: { ids, langs, changed: r.changed }, req,
    });
    const after = lastSuwayomiLoad();
    return { ok: true, changed: r.changed, hiddenLangs: r.hiddenLangs, registered: load.suwayomi, skipped: after?.skipped ?? 0 };
  });

  app.post('/api/admin/extensions/sources/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    if (!suwayomiConfigured()) return reply.code(400).send({ error: 'not_configured', message: 'No extension server is configured.' });

    // Take the name from the live list so the row is meaningful even before the source is ever used.
    const remote = await listRemoteSources().catch(() => []);
    const match = remote.find((s) => String(s.id) === id);
    await q(
      // COALESCE on nsfw for the same reason as the name: when the remote list is unreachable `match` is
      // undefined, and defaulting to false there would silently un-flag an adult source on every toggle.
      `INSERT INTO suwayomi_sources (source_id, name, lang, nsfw, enabled) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (source_id) DO UPDATE SET enabled = EXCLUDED.enabled,
         name = COALESCE(NULLIF(EXCLUDED.name, ''), suwayomi_sources.name),
         nsfw = COALESCE(EXCLUDED.nsfw, suwayomi_sources.nsfw)`,
      [id, match ? (match.displayName?.trim() || match.name) : id, match?.lang ?? null,
       match ? !!match.isNsfw : null, b.data.enabled],
    );
    await reloadAll();
    await logAudit(b.data.enabled ? 'source.extension_enable' : 'source.extension_disable', {
      userId: userIdOf(req), detail: { id, name: match?.name }, req,
    });

    // Prove it actually works now rather than letting the user discover it later from an empty search.
    let smoke = null;
    if (b.data.enabled) {
      const adapter = getSource(swAdapterId(id));
      if (adapter) smoke = await smokeTest(adapter);
    }
    return { ok: true, smoke };
  });

  // ---- the extension catalogue ----
  // Uchiyomi is a remote control for the operator's own extension server here: the catalogue comes from
  // repositories THEY configured, and that server does the fetching and installing. No repository URL ships
  // in this codebase and nothing is fetched until one is added.
  app.get('/api/admin/extensions/catalog', async (req, reply) => {
    if (needExt(reply)) return;
    const { q: term, lang, installed, nsfw, updates, offset: rawOffset, limit: rawLimit } = req.query as {
      q?: string; lang?: string; installed?: string; nsfw?: string; updates?: string; offset?: string; limit?: string;
    };
    // A page of the matches (v0.53.0): `offset` from 0, `limit` up to CATALOG_PAGE_MAX, which is also the default -- the
    // first 400, as the route always answered. ⚠️ It answered ONLY those: on a 1,300-extension repository the panel said
    // "Showing 400 of 570 matches -- narrow the search", and an extension past the 400th could not be reached by
    // scrolling (discussion #121). Admin → Extensions now asks for the next page as it scrolls.
    const offset = Math.min(1_000_000, Math.max(0, Math.floor(Number(rawOffset)) || 0));
    const limit = Math.min(CATALOG_PAGE_MAX, Math.max(1, Math.floor(Number(rawLimit)) || CATALOG_PAGE_MAX));
    let all;
    try {
      all = await listExtensions();
    } catch (e) {
      return reply.code(502).send({ error: 'unreachable', message: (e as Error)?.message || 'Could not reach the extension server.' });
    }
    const needle = (term || '').trim().toLowerCase();
    const matching = all
      .filter((e) => (!needle || e.name.toLowerCase().includes(needle) || e.pkgName.toLowerCase().includes(needle)))
      .filter((e) => (!lang || lang === 'all' ? true : e.lang === lang))
      .filter((e) => (installed === 'true' ? e.installed : true))
      // `updates` (v0.53.0): only the extensions with a newer version waiting.
      .filter((e) => (updates === 'true' ? e.hasUpdate : true));
    const filtered = matching
      // adult extensions are hidden unless asked for — this is a household server by default, and they
      // otherwise dominate the top of an alphabetical list
      .filter((e) => (nsfw === 'true' ? true : !e.nsfw || e.installed))
      // installed first, then updatable, then alphabetical — the things you can act on float up
      .sort((a, b) => Number(b.installed) - Number(a.installed) || Number(b.hasUpdate) - Number(a.hasUpdate) || a.name.localeCompare(b.name));
    const langs = [...new Set(all.map((e) => e.lang).filter(Boolean))].sort() as string[];
    // Serve icons through our own origin; the extension server is not reachable from a browser.
    const page = filtered.slice(offset, offset + limit).map((e) => ({ ...e, iconUrl: e.iconUrl ? `/img/extensions/icon/${e.pkgName}` : null }));
    return {
      content: page,
      total: all.length,
      shown: page.length,
      matched: filtered.length,
      offset,
      limit,
      installed: all.filter((e) => e.installed).length,
      updatable: all.filter((e) => e.hasUpdate).length,
      // The 18+ extensions the other filters match and the 18+ filter keeps out (v0.53.0; the whole catalogue's before):
      // what "Nothing matches" can offer to show.
      hiddenAdult: nsfw === 'true' ? 0 : matching.filter((e) => e.nsfw && !e.installed).length,
      // The 18+ extensions in the whole catalogue that are not installed, whatever was asked: what Browse leaves out
      // while Show 18+ extensions is off. The Browse tab counts `total` less these, as its list does -- it said
      // "Browse 1,304" over a list that ended at "1,118 of 1,118".
      adultTotal: all.filter((e) => e.nsfw && !e.installed).length,
      langs,
    };
  });

  /**
   * Update every installed extension that has a newer version.
   *
   * Deliberately the same function the scheduled check runs, rather than a second loop that would drift from
   * it -- and this route is the reason that matters. It used to call the updater directly, which meant it
   * inherited the scheduled job's bug: nothing re-read the repositories first, so "Update all" pressed
   * without "Refresh" pressed before it compared against a catalogue that could be weeks old and answered
   * "Everything is already up to date".
   *
   * Failures come back per extension with a reason instead of a count, because "3 could not update" tells an
   * operator nothing they can act on.
   */
  app.post('/api/admin/extensions/update-all', async (req, reply) => {
    if (needExt(reply)) return;
    if (extState.running) return reply.code(409).send({ error: 'busy', message: 'An extension check is already running.' });
    const r = await runExtensionCheck({ forceUpdate: true });
    await logAudit('extension.update_all', {
      userId: userIdOf(req), detail: { updated: r.updated.length, failed: r.failed.length, refreshed: r.refreshed }, req,
    });
    // `updated` stays a list of names on the wire: the admin page reads it that way, and the version pair is
    // in `updatedDetail` for anything that wants it.
    return { ok: true, ...r, updated: r.updated.map((u) => u.name), updatedDetail: r.updated };
  });

  app.post('/api/admin/extensions/refresh', async (req, reply) => {
    if (needExt(reply)) return;
    try {
      const n = await refreshExtensions();
      await logAudit('extension.refresh', { userId: userIdOf(req), detail: { count: n }, req });
      return { ok: true, count: n };
    } catch (e) {
      return reply.code(502).send({ error: 'unreachable', message: (e as Error)?.message || 'Could not refresh.' });
    }
  });

  /**
   * Point the engine's own Cloudflare helper at the one Uchiyomi uses, and switch it on (#72, #54): Health's
   * "Connect the Cloudflare helper" and the Extensions tab's Connect. Only ever on a press -- it changes a setting
   * on someone's engine (lib/sources/suwayomi/engineSolver.ts). The audit names the solver's host, never its
   * address: on desktop that carries the in-app helper's token.
   */
  app.post('/api/admin/extensions/solver', async (req, reply) => {
    if (needExt(reply)) return;
    const r = await connectEngineSolver();
    if (!r.ok) return reply.code(r.status).send({ error: r.error, message: r.message });
    await logAudit('extension.solver', { userId: userIdOf(req), detail: r.audit, req });
    return { ok: true, enabled: r.enabled, wiring: r.wiring };
  });

  app.post('/api/admin/extensions/catalog/:pkgName', async (req, reply) => {
    if (needExt(reply)) return;
    const { pkgName } = req.params as { pkgName: string };
    const b = z.object({ action: z.enum(['install', 'uninstall', 'update', 'enable']) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });

    // "Turn on its sources" (v0.53.0): an installed extension's sources switched on as its install would have, and the
    // engine asked for nothing but the list. An extension installed in the engine's own page showed as installed with
    // every source off, and Remove then Add again was the only way to switch them on (discussion #121).
    if (b.data.action === 'enable') {
      let provided: Awaited<ReturnType<typeof sourcesOfExtension>>;
      try {
        provided = await sourcesOfExtension(pkgName);
      } catch (e) {
        return reply.code(502).send({ error: 'unreachable', message: (e as Error)?.message || 'Could not reach the extension server.' });
      }
      if (!provided.length) {
        return reply.code(409).send({ error: 'no_sources', message: 'That extension is not installed, or provides no source.' });
      }
      const turned = await turnOnExtensionSources(provided);
      await logAudit('extension.enable', { userId: userIdOf(req), detail: { pkgName, on: turned.on }, req });
      const load = await reloadAll();
      return { ok: true, sources: provided.length, on: turned.on, hidden: turned.hidden, registered: load.suwayomi };
    }

    // Ask which sources this extension provides BEFORE acting: once it is uninstalled it provides none, and
    // we would leave the rows behind claiming sources that no longer exist.
    const enable = b.data.action !== 'uninstall';
    const priorSources = enable ? [] : await sourcesOfExtension(pkgName).catch(() => []);

    try {
      await setExtensionState(pkgName, b.data.action);
    } catch (e) {
      return reply.code(502).send({ error: 'failed', message: (e as Error)?.message || 'The extension server refused that.' });
    }
    await logAudit(`extension.${b.data.action}`, { userId: userIdOf(req), detail: { pkgName }, req });

    // Installing an extension and then having to hunt for its sources in a second list is exactly the
    // friction this feature exists to remove, so switch them on (or off) as part of the same action --
    // except the ones in a language the operator has hidden, which stay off and are counted back.
    const provided = enable ? await sourcesOfExtension(pkgName).catch(() => []) : priorSources;
    const adopted = await adoptExtensionSources(provided, enable);
    if (b.data.action === 'uninstall') {
      // the sources are gone from the server too; don't leave rows implying otherwise
      await q('DELETE FROM suwayomi_sources WHERE source_id = ANY($1)', [provided.map((s) => s.id)]).catch(() => {});
      // ...and neither their health rows, which nothing else ever deletes. Live this had accumulated twelve
      // orphans, three of them recording 404s from the very evening their extensions were pulled. A row whose
      // source still has series is kept: it is the only record that source ever existed, and those series
      // are frozen, not gone -- the health page says so.
      await pruneOrphanedHealth(provided.map((s) => `sw:${s.id}`));
    }
    const r = await reloadAll();
    return { ok: true, sources: provided.length, on: adopted.on, hidden: adopted.hidden, registered: r.suwayomi };
  });

  // ---- extension repositories ----
  app.get('/api/admin/extensions/repos', async (req, reply) => {
    if (needExt(reply)) return;
    try {
      return { content: await getRepos() };
    } catch (e) {
      return reply.code(502).send({ error: 'unreachable', message: (e as Error)?.message || 'Could not reach the extension server.' });
    }
  });

  /**
   * Keep the extension monitor's copy of the list (`server_settings.extension_repos`, the one that survives
   * the engine's volume being deleted and is put back by the scheduled check) in step with an add or a remove
   * made here. ⚠️ Until v0.45.0 nothing but the monitor's first-run adoption ever wrote it, so a repository
   * removed here was RESTORED by the next check, six hours later, and one added here was never protected.
   *
   * Additive and subtractive by key, never an overwrite with the engine's list: if the engine's volume was
   * wiped, the engine's list is empty and ours is the only record of the others, which the next check puts
   * back. Best effort: a failure here leaves the old behaviour, not a broken add.
   */
  const syncMonitorRepos = async (engineList: string[], add: string[], dropKey: string | null) => {
    try {
      const saved = (await extensionStore.settings()).repos;
      // Never adopted yet (no check has run): start from the engine's list, as the check itself would.
      const base = saved.length ? saved : engineList;
      const addKeys = new Set(add.map(repoKey));
      const kept = base.filter((u) => !addKeys.has(repoKey(u)) && (dropKey === null || repoKey(u) !== dropKey));
      await extensionStore.saveRepos([...kept, ...add]);
    } catch { /* the next check adopts or restores from the engine, as before */ }
  };

  /**
   * Add a repository, and keep it only if it actually yields extensions.
   *
   * Every refusal says what to do next in plain words, and the answer is judged by what THIS repository put in
   * the catalogue (contributedBy), never by the catalogue's size. ⚠️ Until v0.45.0: a pasted add-repo link, a
   * GitHub page or a typo was saved verbatim; a repository that yielded nothing was KEPT and the user had to
   * find Remove; a broken second repository toasted "Added — 1396 extensions" (the first one's count); an
   * engine refusal was a 500 the panel showed as "Could not add that repository"; and a failed read of the
   * current list was taken as "no repositories" and the write that followed dropped all the others.
   */
  app.post('/api/admin/extensions/repos', async (req, reply) => {
    if (needExt(reply)) return;
    const b = z.object({ url: z.string().max(2000) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_url', message: REPO_MESSAGES.bad_url });
    const parsed = parseRepoInput(b.data.url);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error, message: parsed.message });
    const wanted = parsed.url;

    // ⚠️ Never build the new list from a failed read: `[]` here and the write below would drop every other
    // repository the engine has.
    let current: string[];
    try {
      current = await getRepos();
    } catch (e) {
      return reply.code(502).send({ error: 'unreachable', message: `Could not reach the extension engine: ${engineReason(e)}`, reason: engineReason(e) });
    }
    const dupe = current.find((u) => repoKey(u) === repoKey(wanted));
    if (dupe) return reply.code(409).send({ error: 'exists', message: 'That repository is already added.', url: dupe });

    const before = await listExtensions().catch((): ExtensionInfo[] => []);
    let reason: string | undefined;
    let total = before.length;

    // Suwayomi applies a settings change asynchronously, so the FIRST read after adding a repository still
    // sees the old list and comes back empty. Retry until this repository shows up in the catalogue.
    const attempt = async (url: string): Promise<number> => {
      await setRepos([...current, url]); // a throw is the engine refusing the write itself: see the catch below
      let n = 0;
      for (let i = 0; i < 4; i++) {
        try {
          await refreshExtensions();
          reason = undefined;
        } catch (e) {
          reason = engineReason(e);
        }
        const all = await listExtensions().catch((): ExtensionInfo[] | null => null);
        if (all) { total = all.length; n = contributedBy(all, before, current); }
        if (n > 0) break;
        if (i < 3) await new Promise((r) => setTimeout(r, 700));
      }
      return n;
    };

    let used = wanted;
    let added = 0;
    try {
      added = await attempt(wanted);
      // Still nothing after retrying? Repository layouts vary, so try the one alternative form of the same
      // address (altRepoUrl), keeping it only if it yielded something.
      if (added === 0) {
        const alt = altRepoUrl(wanted);
        if (alt && alt !== wanted) {
          const n = await attempt(alt);
          if (n > 0) { used = alt; added = n; }
        }
      }
    } catch (e) {
      // Put the list back as it was; the engine may have taken the first write and refused the second.
      await setRepos(current).catch(() => {});
      await logAudit('extension.repo_add_refused', { userId: userIdOf(req), detail: { url: wanted, reason: engineReason(e) }, req });
      return reply.code(502).send({
        error: 'engine_refused', message: `The extension engine refused that address: ${engineReason(e)}`, reason: engineReason(e),
      });
    }

    if (added === 0) {
      // Nothing from it, even after the alternative: take it back out, so a wrong address is never left
      // saved for someone to find and remove by hand.
      let removed = true;
      try { await setRepos(current); } catch { removed = false; }
      await logAudit('extension.repo_add_refused', { userId: userIdOf(req), detail: { url: wanted, reason: reason ?? 'no extensions', removed }, req });
      return reply.code(422).send({
        error: 'empty',
        message: 'That address gave no extensions, so it was not kept. Check that it is the repository’s index.min.json link, not a web page — or it may only list extensions you already have.'
          + (reason ? ` The engine said: ${reason}` : '')
          + (removed ? '' : ' It could not be taken back out — press Remove next to it.'),
        reason, removed,
      });
    }

    // The engine's own spelling of what was just added (it may have swapped the address -- see repoKey), for
    // the monitor's copy; what was sent if the list cannot be read back.
    const after = await getRepos().catch((): string[] => [...current, used]);
    const fresh = after.filter((u) => !current.some((c) => repoKey(c) === repoKey(u)));
    await syncMonitorRepos(after, fresh.length ? fresh : [used], null);
    await logAudit('extension.repo_add', { userId: userIdOf(req), detail: { url: used, extensions: added }, req });
    return { ok: true, url: used, corrected: used !== wanted, added, total, error: reason };
  });

  app.delete('/api/admin/extensions/repos', async (req, reply) => {
    if (needExt(reply)) return;
    const b = z.object({ url: z.string().min(1).max(2000) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    // ⚠️ The same trap as the add: a failed read taken as `[]` made this write an empty list, removing
    // every repository instead of one.
    let current: string[];
    try {
      current = await getRepos();
    } catch (e) {
      return reply.code(502).send({ error: 'unreachable', message: `Could not reach the extension engine: ${engineReason(e)}`, reason: engineReason(e) });
    }
    // By key, so every spelling of the one repository goes (see repoKey) and nothing else does.
    const key = repoKey(b.data.url);
    const next = current.filter((u) => u !== b.data.url && repoKey(u) !== key);
    try {
      await setRepos(next);
    } catch (e) {
      return reply.code(502).send({ error: 'engine_refused', message: `The extension engine refused that: ${engineReason(e)}`, reason: engineReason(e) });
    }
    await syncMonitorRepos(current, [], key);
    await refreshExtensions().catch(() => 0);
    await logAudit('extension.repo_remove', { userId: userIdOf(req), detail: { url: b.data.url }, req });
    return { ok: true, removed: current.length - next.length };
  });

  // ---- library health ----
  // Read-only aggregate over the library. Every check is a plain query, so this is safe to hit whenever
  // the tab is opened rather than needing a background job.
  app.get('/api/admin/health', async () => {
    const report = await runHealthChecks();
    // What the header shows (#101): refreshed whenever somebody looks, so it never disagrees with the page.
    await storeHealthSummary(report).catch(() => {});
    return report;
  });
  // The header's question, answered from what is stored: never runs the checks (lib/healthSummary.ts).
  app.get('/api/admin/health/summary', async () => ({ summary: await readHealthSummary() }));

  /**
   * Ignore a Health finding, or stop ignoring it (v0.48.3, lib/healthIgnore.ts).
   *
   * The finding is looked up again here, by its key, rather than trusting what the page sent: an ignore covers
   * everything the finding is about -- every missing number of a gap, not the hundred the page carries -- and a
   * finding that is gone by the time the button is pressed is answered 404 rather than recorded. Admin-only by
   * the prefix hook, audited both ways; no confirmation, because nothing is deleted and "Stop ignoring" undoes it.
   */
  const ignoreBody = z.object({
    check: z.enum(IGNORABLE_CHECKS),
    key: z.string().min(1).max(500),
    ignored: z.boolean(),
  });
  app.post('/api/admin/health/ignore', async (req, reply) => {
    const b = ignoreBody.safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: b.error.issues[0]?.message ?? 'Bad body' });
    const { check, key, ignored } = b.data;
    if (ignored) {
      const f = await findingOf(check, key);
      if (!f) return reply.code(404).send({ error: 'gone', message: 'That finding is not there any more.' });
      await ignoreFinding(check, key, f, userIdOf(req) ?? null);
      await logAudit('health.ignore', { userId: userIdOf(req), detail: { check, key, title: f.title, members: f.members.length }, req });
    } else {
      await unignoreFinding(check, key);
      await logAudit('health.unignore', { userId: userIdOf(req), detail: { check, key }, req });
    }
    return { ok: true };
  });

  // ---- Fix everything (v0.55.0, lib/autofix.ts) ----

  /**
   * Start Health's Fix everything: one background run, 202 with its id. 409 `busy` with what is going -- `autofix`,
   * `repair`, `find` or `sweep` -- beside another run, a repair, a Find or Replace, or a chapter sweep. It runs as the
   * admin who pressed it: their age reach is what its Replace and Find runs may ask, as theirs (#141).
   */
  app.post('/api/admin/health/autofix', async (req, reply) => {
    const b = z.object({}).strict().safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'Fix everything takes no options.' });
    const ctx = await viewCtxFor(userIdOf(req), roleOf(req));
    const r = startAutofix(userIdOf(req) ?? null, { ctx, origin: 'manual', log: app.log, req });
    if ('busy' in r) return reply.code(409).send({ error: 'busy', running: r.busy });
    return reply.code(202).send({ ok: true, runId: r.runId });
  });
  /** The run going now, and the newest finished one: what the Health page polls every two seconds while one runs. */
  app.get('/api/admin/health/autofix', async (req) => {
    const st = await autofixState();
    const hide = hideAdult(req);
    const named = hide ? await nameable(req, [...autofixSeriesIds(st.run), ...autofixSeriesIds(st.last)]) : undefined;
    return { run: scrubAutofixRun(st.run, hide, named), last: scrubAutofixRun(st.last, hide, named) };
  });
  /** One run, live or kept (repair_runs keeps them as it keeps repairs); 404 when none has that id. */
  app.get('/api/admin/health/autofix/:runId', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    if (!runId || runId.length > 64) return reply.code(400).send({ error: 'bad_request' });
    const r = await autofixRun(runId);
    if (!r) return reply.code(404).send({ error: 'not_found' });
    const hide = hideAdult(req);
    return scrubAutofixRun(r, hide, hide ? await nameable(req, autofixSeriesIds(r)) : undefined);
  });
  /**
   * Stop the run at its next safe point -- between series, steps, sources or pairs, never inside a merge, a delete or a
   * renumber; its Find or Replace run in flight stops at once. `stopping: false` when nothing is running.
   */
  app.post('/api/admin/health/autofix/stop', async (req) => {
    const stopping = stopAutofix();
    if (stopping) await logAudit('library.autofix_stop', { userId: userIdOf(req), detail: {}, req });
    return { ok: stopping, stopping };
  });

  // ---- link existing series to AniList entries so tracker sync has an anchor ----
  // Art was matched long before trackers existed, so those series have cached art but no link. This
  // re-resolves only what's missing, paced for AniList's ~30 req/min limit.
  let relinkJob: { running: boolean; total: number; done: number; linked: number; misses: number } | null = null;
  app.post('/api/admin/trackers/relink', async (req, reply) => {
    if (relinkJob?.running) return reply.code(409).send({ error: 'busy' });
    const targets = await q<{ id: string; title: string }>(
      `SELECT s.id, s.title FROM lib_series s
         LEFT JOIN series_trackers t ON t.series_id = s.id AND t.provider = 'anilist'
        WHERE ${visibleToAll('s')} AND t.series_id IS NULL ORDER BY s.books_count DESC`,
    );
    const job = { running: true, total: targets.length, done: 0, linked: 0, misses: 0 };
    relinkJob = job;
    await logAudit('tracker.relink_start', { userId: userIdOf(req), detail: { count: targets.length }, req });
    void (async () => {
      for (const t of targets) {
        try {
          const m = await fetchAniListArt(t.title);
          if (m.mediaId) {
            await linkSeries(t.id, m.mediaId, m.mediaTitle ?? null);
            await learnDirection({ id: t.id }, directionFromAniListMatch(t.title, m), 'anilist').catch(() => {});
            await learnTypeFromAniList({ id: t.id }, t.title, m);
            job.linked++;
          }
          else job.misses++;
        } catch { job.misses++; }
        job.done++;
        await new Promise((r) => setTimeout(r, 2200)); // stay under AniList's rate limit
      }
      job.running = false;
    })();
    return { ok: true, total: targets.length };
  });
  app.get('/api/admin/trackers/relink/status', async () => ({ job: relinkJob }));

  // ---- import intake: turn a Mihon/Tachiyomi backup or a MangaDex list into a reviewable title list ----
  // Parsing is separate from importing on purpose: adding hundreds of series is slow and hits other people's
  // servers, so the admin gets to see and trim the list first.
  app.post('/api/admin/import/parse', { bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
    const b = z
      .object({
        // a .tachibk / .proto.gz as a data URL (there's no multipart plugin; this mirrors the art upload)
        dataUrl: z.string().optional(),
        // a public MangaDex list URL or id
        mangadexList: z.string().optional(),
      })
      .safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });

    let titles: string[] = [];
    let origin = '';
    try {
      if (b.data.dataUrl) {
        const m = /^data:[^;]*;base64,(.+)$/s.exec(b.data.dataUrl);
        if (!m) return reply.code(400).send({ error: 'bad_request', message: 'Could not read that file.' });
        titles = titlesFromBackup(Buffer.from(m[1], 'base64'));
        origin = 'backup';
      } else if (b.data.mangadexList) {
        titles = await titlesFromMangadexList(b.data.mangadexList);
        origin = 'mangadex';
      } else {
        return reply.code(400).send({ error: 'bad_request', message: 'Provide a backup file or a MangaDex list.' });
      }
    } catch (e) {
      return reply.code(422).send({ error: 'parse_failed', message: (e as Error)?.message || 'Could not read that.' });
    }

    // flag what's already here so the admin isn't re-importing their own library
    const have = new Set((await q<{ title: string }>('SELECT title FROM lib_series')).map((r) => norm(r.title)));
    const items = titles.slice(0, 500).map((title) => ({ title, inLibrary: have.has(norm(title)) }));
    return { origin, total: titles.length, truncated: titles.length > 500, items };
  });

  // ---- bulk import: paste a list of titles, match each to a source, add it ----
  app.post('/api/admin/import', async (req, reply) => {
    if (importJob?.running) return reply.code(409).send({ error: 'busy', message: 'An import is already running.' });
    const b = z.object({
      titles: z.array(z.string()).min(1).max(500), autoUpdate: z.boolean().optional(),
      chapterCount: z.number().int().positive().optional(), chapterFrom: z.enum(['oldest', 'newest']).optional(),
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'Paste at least one title.' });
    const titles = [...new Set(b.data.titles.map((t) => t.replace(/^[-*•\d.\s]+/, '').trim()).filter(Boolean))].slice(0, 500);
    if (!titles.length) return reply.code(400).send({ error: 'bad_request', message: 'No titles found.' });
    const job: ImportJob = { running: true, total: titles.length, done: 0, added: 0, already: 0, notFound: 0, failed: 0, startedAt: Date.now(), details: [] };
    importJob = job;
    await logAudit('import.start', { userId: userIdOf(req), detail: { count: titles.length }, req });
    void (async () => {
      for (const title of titles) {
        try {
          const m = await findBestMatch(title);
          if (!m) { job.notFound++; job.details.push({ title, status: 'not_found' }); }
          else {
            const r = await addSeriesFromSource({ source: m.source, sourceId: m.sourceId, autoUpdate: b.data.autoUpdate, chapterCount: b.data.chapterCount, chapterFrom: b.data.chapterFrom });
            if (r.ok && (r.chapters ?? 0) > 0) { job.added++; job.details.push({ title, status: 'added', source: m.source }); }
            else if (r.ok) { job.already++; job.details.push({ title, status: 'already', source: m.source }); }
            else { job.failed++; job.details.push({ title, status: r.error || 'failed', source: m.source }); }
          }
        } catch { job.failed++; job.details.push({ title, status: 'error' }); }
        job.done++;
      }
      job.running = false;
    })();
    return { ok: true, total: titles.length };
  });
  app.get('/api/admin/import/status', async () => ({ job: importJob }));

  // ---- reviewable import: parse into a batch, resolve matches in the background, let the admin correct
  // them, THEN add. Same three intakes as /import/parse above, but every title gets its own row that the
  // admin can inspect, override with a manual search, or skip — instead of silently taking the first
  // cross-source hit above the confidence threshold. See migrate.ts for the two tables this uses. ----

  // Both id columns are uuid, and Postgres answers `WHERE id = 'abc'` with 22P02, which the error handler
  // reads as a 500. A malformed id is a client's not-found, so it is checked before any query.
  const uuidParam = z.string().uuid();
  const batchIdOf = (req: { params: unknown }, reply: FastifyReply): string | null => {
    const r = uuidParam.safeParse((req.params as { id?: string }).id);
    if (!r.success) { reply.code(404).send({ error: 'not_found' }); return null; }
    return r.data;
  };

  // Newest first, every state: the web's "Open imports" list is how a batch whose tab was closed is found
  // again (a `review` batch is otherwise reachable only by its own URL), and a finished one stays listed
  // until the sweep removes it so the admin can still read its counts. Rows are not returned -- a batch
  // can carry 500 of them and this is a summary; GET /batches/:id has them.
  app.get('/api/admin/import/batches', async () => {
    const rows = await q<ImportBatchRow>(
      `SELECT id, origin, tracker, state, total, resolved, added, already, failed, skipped_novels, truncated, created_at, updated_at
         FROM import_batches ORDER BY created_at DESC LIMIT 50`,
    );
    // The same `stale` GET /batches/:id reports, for the same reason: a batch left `resolving` by a
    // restart otherwise read "Matching… 12/40" on the intake card when nobody was matching anything, and
    // only opening it revealed the Resume button. In-memory, no query -- the guard is this process's.
    return { content: rows.map((r) => ({ ...batchDto(r), stale: r.state === 'resolving' && resolvingBatch !== r.id })) };
  });

  app.post('/api/admin/import/batches', { bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
    if (resolvingBatch) return reply.code(409).send({ error: 'busy', message: 'An import is already resolving. Wait for it to finish, or cancel it.' });
    // Claimed synchronously, right after the check: everything below awaits (file parse, lib_series read,
    // two INSERTs), and two POSTs inside that window -- a double-tap on "Start matching", or a file and a
    // paste from two tabs -- both passed the check and both resolved, doubling the outbound search rate the
    // guard exists to cap. `resolveBatch` replaces the placeholder with the real id before its first await;
    // every other way out of this handler (a 4xx, a throw) releases it in the `finally`.
    resolvingBatch = 'pending';
    let started = false;
    try {
      const b = z
        .object({
          dataUrl: z.string().optional(),
          mangadexList: z.string().optional(),
          titles: z.array(z.string()).optional(),
          // The fourth intake: `origin: 'tracker'` names it, `tracker` says which service, `statuses` which
          // of the person's lists to read (at least one; Reading + Plan to read when omitted, the two a
          // reader most wants brought over).
          origin: z.literal('tracker').optional(),
          tracker: z.enum(PROVIDERS as [Provider, ...Provider[]]).optional(),
          statuses: z.array(z.enum(LIST_STATUSES)).min(1).max(LIST_STATUSES.length).optional(),
        })
        .safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: 'bad_request' });

      const userId = userIdOf(req);
      let entries: IntakeEntry[] = [];
      let origin: 'backup' | 'mangadex' | 'paste' | 'tracker';
      let tracker: Provider | null = null;
      let skippedNovels = 0;
      let capped = false;
      try {
        if (b.data.origin === 'tracker' || b.data.tracker) {
          if (!b.data.tracker) return reply.code(400).send({ error: 'bad_request', message: 'Say which tracker to read: anilist, myanimelist or kitsu.' });
          tracker = b.data.tracker;
          const read = await readTrackerList(userId, tracker, b.data.statuses ?? ['reading', 'plan_to_read']);
          if ('error' in read) return reply.code(read.status).send({ error: read.error, message: read.message });
          entries = read.entries;
          skippedNovels = read.skippedNovels;
          capped = read.capped;
          origin = 'tracker';
        } else if (b.data.dataUrl) {
          const m = /^data:[^;]*;base64,(.+)$/s.exec(b.data.dataUrl);
          if (!m) return reply.code(400).send({ error: 'bad_request', message: 'Could not read that file.' });
          entries = entriesFromBackup(Buffer.from(m[1], 'base64'));
          origin = 'backup';
        } else if (b.data.mangadexList) {
          entries = await entriesFromMangadexList(b.data.mangadexList);
          origin = 'mangadex';
        } else if (b.data.titles?.length) {
          // same bullet-stripping + dedupe as the one-shot /import route, so pasted lists behave identically
          const seen = new Set<string>();
          for (const raw of b.data.titles) {
            const title = raw.replace(/^[-*•\d.\s]+/, '').trim();
            if (!title) continue;
            const k = norm(title);
            if (seen.has(k)) continue;
            seen.add(k);
            entries.push({ title });
          }
          origin = 'paste';
        } else {
          return reply.code(400).send({ error: 'bad_request', message: 'Provide a backup file, a MangaDex list, or at least one title.' });
        }
      } catch (e) {
        return reply.code(422).send({ error: 'parse_failed', message: (e as Error)?.message || 'Could not read that.' });
      }
      if (!entries.length) return reply.code(400).send({ error: 'bad_request', message: 'No titles found.' });

      // Flag what's already here up front so the review screen can default those rows to skipped, visibly.
      // The map carries the series id because a tracker row the library already holds is LINKED right here
      // (below): an existing reader connecting AniList gets sync for the titles they have, which is the most
      // valuable thing this intake does for them, and /run never sees a skipped row. ⚠️ A DELETED namesake
      // is not owned: a deleted series is hidden, not gone (migrate.ts), and it used to read as owned, so a
      // tracker row got a link and a floor on a series nobody can open, while the add path would have
      // revived it. Left unowned, the row resolves and /run adds (revives) it like any other title.
      // A MERGED-away title is the opposite case and IS owned, under its SURVIVOR's id: mergeSeries moves
      // the chapters across and leaves the absorbed row's own title behind, so a backup or tracker list
      // that still carries that spelling would otherwise be offered back as "not in your library", and
      // /run -- whose duplicate check (addSeriesFromSource) also sees only visible rows -- would add a
      // second copy, via another source, of the series the admin had just folded together. Mapping to the
      // survivor, not the absorbed id, is what puts the tracker link and floor on the series that actually
      // holds the chapters; and only while the survivor is itself visible, because a survivor hidden since
      // is the deleted case above under another name. The rank column keeps the survivor's own title
      // ahead of a merged title that happens to normalise the same (the first hit wins below).
      const have = new Map<string, string>();
      // Oldest first within a rank (v0.52.0): a title held in two language editions maps to the original, every time,
      // rather than to whichever row the planner happened to read first.
      for (const r of await q<{ id: string; title: string }>(
        `SELECT s.id, s.title, 0 AS rank, s.created_at FROM lib_series s WHERE ${visibleToAll('s')}
         UNION ALL
         SELECT t.id, m.title, 1 AS rank, t.created_at FROM lib_series m JOIN lib_series t ON t.id = m.merged_into WHERE ${visibleToAll('t')}
         ORDER BY rank, created_at, id`,
      )) {
        const k = norm(r.title);
        if (k && !have.has(k)) have.set(k, r.id);
      }
      // A title the library holds under one of the entry's OTHER names counts as owned too: the same
      // work, spelled the way the source that added it spells it. Which name it was is kept (`via`), the
      // way the resolve pass keeps `matched_via`: an AniList synonym is user-contributed and can be a generic
      // word, so a row linked through one must be able to say "matched under its other name" rather than
      // present the link as self-evident.
      const ownedBy = (e: IntakeEntry): { id: string; via: string | null } | null => {
        const exact = have.get(norm(e.title));
        if (exact) return { id: exact, via: null };
        for (const a of e.altTitles ?? []) {
          const id = have.get(norm(a));
          if (id) return { id, via: a };
        }
        return null;
      };
      // The 500 is a cap on the titles to SEARCH (v0.51.0, discussion #121): every row not already here is
      // matched against the sources, a search per title per source, and 500 keeps one import from hammering
      // them. Owned rows never enter that loop, so they do not count: counted over every entry, a backup of
      // more than 500 titles imported a second time landed on the same first 500 -- by then mostly owned and
      // skipped -- and could never reach the rest. The list is cut just before its 501st title not owned, so
      // `truncated` still says some remain, and importing the list again once these are in picks them up. A
      // tracker read keeps its own cap besides (TRACKER_LIST_MAX, `capped`).
      // Reintroduce by cutting at the 500th ENTRY again: "titles already in the library do not count toward
      // the 500" in importBatch.int.test.ts keeps 500 rows, not 503.
      let toSearch = 0;
      let cut = entries.length;
      for (let i = 0; i < entries.length; i++) {
        if (ownedBy(entries[i])) continue;
        if (++toSearch > 500) { cut = i; break; }
      }
      const truncated = capped || cut < entries.length;
      entries = entries.slice(0, cut);
      const owned = entries.map(ownedBy);
      const inLib = owned.map((o) => !!o);
      const initialResolved = inLib.filter(Boolean).length; // already-owned rows never enter the resolve loop
      // An owned tracker row is finished the moment it is linked: it reads `already`, the batch counts it
      // under `already`, and the review row can say "linked for progress sync". Owned rows of the other
      // intakes keep a NULL status, so a backup whose every title is owned still stays open to be looked at.
      const linkedAtIntake = entries.map((e, i) => !!(tracker && e.externalId && owned[i]));

      // `skipped_novels` and `truncated` ride on the row, not only in this answer: the page that started
      // the intake is not always the page that shows its done line (a reload, an Open-imports tap).
      const batch = await one<{ id: string }>(
        `INSERT INTO import_batches (user_id, origin, tracker, state, total, resolved, already, skipped_novels, truncated)
         VALUES ($1,$2,$3,'resolving',$4,$5,$6,$7,$8) RETURNING id`,
        [userId, origin, tracker, entries.length, initialResolved, linkedAtIntake.filter(Boolean).length, skippedNovels, truncated],
      );
      const batchId = batch!.id;
      // One round trip for up to 500 rows via unnest, rather than 500 sequential INSERTs. ⚠️ `alt_titles`
      // rides as `jsonb[]` (one JSON array per row) unpacked per row in the SELECT: `unnest` over a `text[][]`
      // flattens it, and a plain `jsonb` cannot yield one array per row.
      await q(
        `INSERT INTO import_candidates (batch_id, ord, backup_title, backup_source_id_unsigned, backup_source_id_signed, backup_url, in_library, decision,
                                        tracker, external_id, alt_titles, progress, status, matched_via)
         SELECT $1, o, t, su, ss, u, il, CASE WHEN il THEN 'skip' ELSE 'unresolved' END,
                tr, ex, ARRAY(SELECT jsonb_array_elements_text(x.al))::text[], pr, st, mv
         FROM unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::boolean[],
                     $8::text[], $9::text[], $10::jsonb[], $11::int[], $12::text[], $13::text[]) AS x(o, t, su, ss, u, il, tr, ex, al, pr, st, mv)`,
        [
          batchId,
          entries.map((_, i) => i),
          entries.map((e) => e.title),
          entries.map((e) => e.sourceIdUnsigned ?? null),
          entries.map((e) => e.sourceIdSigned ?? null),
          entries.map((e) => e.url ?? null),
          inLib,
          entries.map((e) => e.tracker ?? null),
          entries.map((e) => e.externalId ?? null),
          entries.map((e) => JSON.stringify(e.altTitles ?? [])),
          entries.map((e) => (e.tracker ? e.progress ?? 0 : null)),
          linkedAtIntake.map((l) => (l ? 'already' : null)),
          owned.map((o) => o?.via ?? null),
        ],
      );
      let linked = 0;
      for (let i = 0; i < entries.length; i++) {
        if (!linkedAtIntake[i]) continue;
        const e = entries[i];
        await linkImportedSeries({ tracker: e.tracker!, external_id: e.externalId!, backup_title: e.title, progress: e.progress ?? null }, owned[i]!.id, userId);
        linked++;
      }
      await logAudit('import.batch.start', {
        userId, req,
        detail: { batchId, origin, count: entries.length, ...(tracker ? { tracker, statuses: b.data.statuses ?? ['reading', 'plan_to_read'], skippedNovels, linked } : {}) },
      });
      void resolveBatch(batchId).catch(() => {});
      started = true;
      return { batchId, total: entries.length, truncated, skippedNovels };
    } finally {
      if (!started && resolvingBatch === 'pending') resolvingBatch = null;
    }
  });

  app.get('/api/admin/import/batches/:id', async (req, reply) => {
    const id = batchIdOf(req, reply);
    if (!id) return;
    let batch = await one<ImportBatchRow>('SELECT * FROM import_batches WHERE id = $1', [id]);
    if (!batch) return reply.code(404).send({ error: 'not_found' });
    // An `importing` batch this process is not importing was stranded by a restart mid-run. Back to
    // `review`: the rows /run never reached still have no status and are still ready, and /run only ever
    // picks up rows without one, so the admin can simply press Import again -- or to `done` when every
    // row was in fact processed and only the loop's final write was lost, the same rule the loop's own
    // tail applies. Persisted, not just reported, so /run's own state check agrees with what the page shows.
    if (batch.state === 'importing' && !importingBatches.has(id)) {
      const flipped = await one<ImportBatchRow>(
        `UPDATE import_batches SET updated_at = now(), state = CASE
           WHEN EXISTS (SELECT 1 FROM import_candidates WHERE batch_id = $1 AND status IS NULL AND decision <> 'skip') THEN 'review'
           ELSE 'done' END
         WHERE id = $1 AND state = 'importing' RETURNING *`, [id],
      );
      if (flipped) batch = flipped;
    }
    // A `review` batch with nothing left waiting is finished (closeBatchIfSettled says why here and not
    // only at the end of a run). Persisted before the rows are read, so the page never shows a review
    // list for a batch the list card already calls done.
    if (batch.state === 'review') {
      const closed = await closeBatchIfSettled(id);
      if (closed) batch = closed;
    }
    // `linked` is read from series_trackers rather than remembered on the row, so it says what is true now:
    // a tracker row whose series carries this entry's id (linked at intake for an owned title, at /run for
    // an added one) reads "linked for progress sync"; a row whose link failed, or that was never run, does
    // not claim it.
    const items = await q<ImportCandidateRow & { linked: boolean }>(
      `SELECT c.*, (c.tracker IS NOT NULL AND c.external_id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM series_trackers st WHERE st.provider = c.tracker AND st.external_id = c.external_id)) AS linked
         FROM import_candidates c WHERE c.batch_id = $1 ORDER BY c.ord`, [id],
    );
    // A batch stuck in 'resolving' with nobody actually resolving it (this process restarted mid-pass) is
    // stale: the UI offers Resume instead of a progress bar that will never move again.
    const stale = batch.state === 'resolving' && resolvingBatch !== id;
    return { batch: { ...batchDto(batch), stale }, items };
  });

  app.post('/api/admin/import/batches/:id/resume', async (req, reply) => {
    const id = batchIdOf(req, reply);
    if (!id) return;
    if (resolvingBatch === id) return { ok: true }; // already running in this process, nothing to resume
    if (resolvingBatch) return reply.code(409).send({ error: 'busy', message: 'Another import is already resolving.' });
    // Claimed synchronously, the way POST /batches claims `'pending'`: the SELECT below is one await, and a
    // /resume and a POST inside that window both passed their checks and both resolved -- two search loops
    // at once, the exact fan-out the guard caps. Claimed as the batch's own id rather than `'pending'` so
    // a double-tap on Resume reads as the idempotent `ok` above, not as "another import is resolving".
    // Every way out that does not start the loop (404, not_resolving, a throw) releases it in the `finally`.
    resolvingBatch = id;
    let started = false;
    try {
      const batch = await one<{ id: string; state: string }>('SELECT id, state FROM import_batches WHERE id = $1', [id]);
      if (!batch) return reply.code(404).send({ error: 'not_found' });
      if (batch.state !== 'resolving') return reply.code(409).send({ error: 'not_resolving', message: 'This batch is not waiting to resolve.' });
      void resolveBatch(id).catch(() => {});
      started = true;
      return { ok: true };
    } finally {
      if (!started && resolvingBatch === id) resolvingBatch = null;
    }
  });

  app.patch('/api/admin/import/candidates/:cid', async (req, reply) => {
    const cidParsed = uuidParam.safeParse((req.params as { cid?: string }).cid);
    if (!cidParsed.success) return reply.code(404).send({ error: 'not_found' });
    const cid = cidParsed.data;
    const b = z
      .discriminatedUnion('decision', [
        z.object({ decision: z.literal('manual'), source: z.string().min(1), sourceId: z.string().min(1), title: z.string().min(1), coverUrl: z.string().optional() }),
        z.object({ decision: z.literal('skip') }),
        z.object({ decision: z.literal('auto') }),
      ])
      .safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });

    const row = await one<{ id: string; batch_id: string; auto_source_id: string | null }>(
      'SELECT id, batch_id, auto_source_id FROM import_candidates WHERE id = $1',
      [cid],
    );
    if (!row) return reply.code(404).send({ error: 'not_found' });

    if (b.data.decision === 'skip') {
      await q(`UPDATE import_candidates SET decision = 'skip' WHERE id = $1`, [cid]);
      // Skipping the last open row is how a batch with leftovers gets finished: nothing else will run
      // over it again (`/run` answers nothing_to_import), so the batch closes here or not at all.
      await closeBatchIfSettled(row.batch_id);
    } else if (b.data.decision === 'auto') {
      // "use the auto match" after a manual override — restores what the resolve pass actually found,
      // never a fresh search, so this can't disagree with what the review row showed before it was edited.
      if (!row.auto_source_id) return reply.code(409).send({ error: 'no_auto_match', message: 'There is no automatic match for this title.' });
      await q(
        `UPDATE import_candidates SET decision = 'auto', confidence = auto_confidence,
           match_source = auto_source, match_source_id = auto_source_id, match_title = auto_title, match_cover = auto_cover
         WHERE id = $1`,
        [cid],
      );
    } else {
      // `matched_via` names the alternate that found the CURRENT match, and a hand-picked one was found by
      // a person: left in place, the row read "matched under its other name" about a match that no longer
      // exists. (The auto branch above leaves it alone -- it belongs to the auto match, and a pick made after
      // a manual detour simply loses the note; the amber verdict never depended on it.)
      await q(
        `UPDATE import_candidates SET decision = 'manual', confidence = NULL, matched_via = NULL,
           match_source = $2, match_source_id = $3, match_title = $4, match_cover = $5
         WHERE id = $1`,
        [cid, b.data.source, b.data.sourceId, b.data.title, b.data.coverUrl ?? null],
      );
    }
    await q(`UPDATE import_batches SET updated_at = now() WHERE id = $1`, [row.batch_id]).catch(() => {});
    return { ok: true };
  });

  // ---- "Import selected" — add every selected, matched, not-yet-imported row. Adds only: chapterFrom is
  // forced to 'none' so this never downloads anything, the same "nothing yet" path the add dialog offers —
  // the batch is a bulk catalogue move, not a bulk download, and hundreds of full downloads back to back is
  // exactly the "hammer the sites you're pulling from" scenario the docs warn a big import risks. Chapters
  // arrive afterwards through auto-update (or a manual fetch from the series page), same as any other title
  // added "nothing yet". ----
  app.post('/api/admin/import/batches/:id/run', async (req, reply) => {
    const id = batchIdOf(req, reply);
    if (!id) return;
    const b = z
      .object({
        autoUpdate: z.boolean().optional(),
        // Which rows to add. Omitted means "every matched, not-yet-imported row" (the whole-batch shortcut
        // the one-shot importer always did); the review screen's bulk actions pass an explicit list so a
        // row that is only *selected*, not skipped, can still be left for later without erroring.
        // `.uuid()` for the same reason `batchIdOf` exists: the ids go into `id = ANY($2)` on a uuid column,
        // and one malformed entry made Postgres raise 22P02, which the error handler answered as a 500
        // carrying the raw database message. A batch never holds more than 500 rows to add (since v0.51.0
        // it may also hold the titles already owned, skipped at intake), so a longer list is a client bug too. ⚠️ Not a 404 like the path params: the body is malformed, not a thing missing.
        candidateIds: z.array(z.string().uuid()).max(500).optional(),
      })
      .safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });

    // `user_id` rides along because it is the account the tracker rows belong to (see `owner` below).
    const batch = await one<{ id: string; state: string; user_id: string }>('SELECT id, state, user_id FROM import_batches WHERE id = $1', [id]);
    if (!batch) return reply.code(404).send({ error: 'not_found' });
    if (batch.state === 'importing') return reply.code(409).send({ error: 'busy', message: 'This batch is already importing.' });
    if (batch.state === 'resolving') return reply.code(409).send({ error: 'still_resolving', message: 'Wait for matching to finish first.' });

    // Gated on decision + a match id + not already run, regardless of what the caller selected: a skipped
    // or still-unresolved row in `candidateIds` (an admin who pressed "Select all" rather than "Select ready
    // to import") is silently left out rather than erroring the whole request, and a row this same endpoint
    // already imported on an earlier call is never re-added. That is what makes calling this a SECOND time
    // on the same batch -- after fixing the rows an admin found manually -- safe: it only ever picks up
    // what is newly ready.
    // `tracker`, `external_id`, `backup_title` and `progress` ride along so a tracker row can be linked
    // (and floored) once its series exists, without a second read per row.
    const rows = await q<{ id: string; match_source: string; match_source_id: string; tracker: string | null; external_id: string | null; backup_title: string; progress: number | null; alt_titles: string[] | null }>(
      b.data.candidateIds
        ? `SELECT id, match_source, match_source_id, tracker, external_id, backup_title, progress, alt_titles FROM import_candidates
           WHERE batch_id = $1 AND decision IN ('auto','manual') AND match_source_id IS NOT NULL AND status IS NULL
             AND id = ANY($2) ORDER BY ord`
        : `SELECT id, match_source, match_source_id, tracker, external_id, backup_title, progress, alt_titles FROM import_candidates
           WHERE batch_id = $1 AND decision IN ('auto','manual') AND match_source_id IS NOT NULL AND status IS NULL ORDER BY ord`,
      b.data.candidateIds ? [id, b.data.candidateIds] : [id],
    );
    if (!rows.length) return reply.code(400).send({ error: 'nothing_to_import', message: 'Nothing selected is ready to import.' });

    // The state checks above are advisory; THIS is the guard. Two /run requests that both read `review`
    // before either wrote (a double-tap, two tabs) each selected the same rows and each ran its own add
    // loop over them. The conditional UPDATE is atomic in Postgres: the second one finds `importing` and
    // gets no row back, and answers busy instead of adding everything twice.
    const claimed = await one<{ id: string }>(
      `UPDATE import_batches SET state = 'importing', updated_at = now()
        WHERE id = $1 AND state NOT IN ('importing','resolving') RETURNING id`, [id],
    );
    if (!claimed) return reply.code(409).send({ error: 'busy', message: 'This batch is already importing.' });
    importingBatches.add(id);
    // Captured here: the loop below outlives the request, and `req` must not be read from it.
    const userId = userIdOf(req);
    // ⚠️ The tracker link and its floor belong to the account whose LIST was read -- the batch's owner --
    // never to whoever pressed Import. Batches are shared between admins, and when another admin ran a
    // tracker batch the floor landed on THEIR tracker_progress: the owner's first chapter here then pushed
    // chapter 1 over their entry at 150 (the rewind seedTrackerFloor exists to prevent), and the runner
    // carried a silent 150 floor on a list that was never theirs. The runner stays in the audit row only.
    const owner = batch.user_id;
    await logAudit('import.batch.run', { userId, detail: { batchId: id, count: rows.length, owner }, req });
    /**
     * The series an add answered about, for the tracker link. The add hands back its folder (a fresh row,
     * or the same folder already here) or, for `duplicate`, the title+source it found the work under; the
     * id is looked up the way addSeriesFromSource itself found the row. Null when neither is known, and
     * then nothing is linked -- a link must never be guessed.
     */
    const seriesIdOf = async (r: { folder?: string; existing?: { title: string; source?: string } }): Promise<string | null> => {
      if (r.folder) {
        return (await one<{ id: string }>(`SELECT s.id FROM lib_series s WHERE s.folder = $1 ORDER BY (${visibleToAll('s')}) DESC LIMIT 1`, [r.folder]))?.id ?? null;
      }
      if (r.existing) {
        return (await one<{ id: string }>(`SELECT s.id FROM lib_series s WHERE s.title = $1 AND s.source = $2 AND ${visibleToAll('s')} LIMIT 1`, [r.existing.title, r.existing.source ?? '']))?.id ?? null;
      }
      return null;
    };
    // Fire-and-forget, same as the one-shot /import route: adding hundreds of series is too slow to hold a
    // request open for, even with no chapter downloaded per title.
    void (async () => {
      try {
        for (const row of rows) {
          if (aborted.has(id)) return; // discarded mid-run: the batch is gone, stop adding for it
          try {
            const r = await addSeriesFromSource({ source: row.match_source, sourceId: row.match_source_id, autoUpdate: b.data.autoUpdate, chapterFrom: 'none' });
            // `nothing: true` is the 'none' path's own signal for "a fresh row was created" (routes/sources.ts)
            // -- `chapters` is always 0 under chapterFrom:'none', so the old `chapters > 0` test that told a
            // fresh add from an existing one would have called EVERY add here "already", including the first.
            if (r.ok && r.nothing) {
              // The other spellings the list carried (a tracker's romaji and synonyms) become the new series' own
              // other names (v0.49.1, lib/altTitles.ts): the searches for other sources ask under them. Only for a
              // series this import added, and before the row reads `added`; best effort, never failing the add.
              if (row.alt_titles?.length) {
                const sid = r.seriesId ?? await seriesIdOf(r).catch(() => null);
                if (sid) await recordAltTitles(sid, row.alt_titles, 'import', { userId }).catch(() => []);
              }
              await q(`UPDATE import_candidates SET status = 'added' WHERE id = $1`, [row.id]);
              await q(`UPDATE import_batches SET added = added + 1, updated_at = now() WHERE id = $1`, [id]);
            } else if (r.ok || r.error === 'duplicate') {
              // `ok` without `nothing` is "this exact folder is already here"; `duplicate` (409 from
              // addSeriesFromSource) is "this title is already here from another source" -- the backup
              // spelled it differently, so the up-front in_library check missed it and the resolve pass
              // matched it anyway. Both mean the library has the title, which is what the row should say;
              // before, the second read "Failed — duplicate" in red and counted against the batch.
              await q(`UPDATE import_candidates SET status = 'already' WHERE id = $1`, [row.id]);
              await q(`UPDATE import_batches SET already = already + 1, updated_at = now() WHERE id = $1`, [id]);
            } else {
              // The code, not a sentence: the web maps each code (`no_chapters`, `disabled`, `blocked`…)
              // to its own wording, and the rows are its only reader.
              await q(`UPDATE import_candidates SET status = $2 WHERE id = $1`, [row.id, r.error || 'failed']);
              await q(`UPDATE import_batches SET failed = failed + 1, updated_at = now() WHERE id = $1`, [id]);
            }
            // Added, or the library had it: either way the series exists now, so a tracker row is linked to
            // the entry it came from and the OWNER's progress there becomes the owner's floor -- sync from
            // the first chapter, and never a push below what the tracker already holds.
            if (row.tracker && (r.ok || r.error === 'duplicate')) {
              try {
                const sid = await seriesIdOf(r);
                if (sid) await linkImportedSeries(row, sid, owner);
              } catch { /* the add stands and is already counted; the row simply reads unlinked */ }
            }
          } catch {
            await q(`UPDATE import_candidates SET status = 'error' WHERE id = $1`, [row.id]).catch(() => {});
            await q(`UPDATE import_batches SET failed = failed + 1, updated_at = now() WHERE id = $1`, [id]).catch(() => {});
          }
        }
        // 'review', not 'done', while anything could still become an import: a still-unresolved row a person
        // can go find manually (the "second import try"), or a matched row that was left unselected on
        // purpose. Only once nothing is left waiting does the batch read as finished.
        const remaining = await one<{ n: number }>(
          `SELECT count(*)::int AS n FROM import_candidates WHERE batch_id = $1 AND status IS NULL AND decision <> 'skip'`, [id],
        );
        const nextState = (remaining?.n ?? 0) > 0 ? 'review' : 'done';
        // Only from 'importing': a batch discarded during the loop must not be written back into existence
        // by its own tail, and a GET that already flipped a stranded run to 'review' is left alone.
        await q(`UPDATE import_batches SET state = $2, updated_at = now() WHERE id = $1 AND state = 'importing'`, [id, nextState]).catch(() => {});
      } finally {
        importingBatches.delete(id);
        aborted.delete(id);
      }
    })();
    return { ok: true, total: rows.length };
  });

  // Discard. Nothing is written as 'cancelled' -- the row is removed, so the state has no reader. It stays
  // in the sweep's IN-list only because the column comment in migrate.ts still names it.
  app.delete('/api/admin/import/batches/:id', async (req, reply) => {
    const id = batchIdOf(req, reply);
    if (!id) return;
    // Does not wait on an in-flight loop: the row it is on finishes (its writes target rows the CASCADE just
    // removed and affect nothing) and the loop stops before the next one, because both check `aborted`.
    // `resolvingBatch` is released now rather than when that loop notices, so the admin can start the next
    // batch without waiting out a search timeout.
    if (resolvingBatch === id || importingBatches.has(id)) aborted.add(id);
    if (resolvingBatch === id) resolvingBatch = null;
    const gone = await q<{ id: string }>('DELETE FROM import_batches WHERE id = $1 RETURNING id', [id]);
    if (gone.length) await logAudit('import.batch.discard', { userId: userIdOf(req), detail: { batchId: id }, req });
    return { ok: true };
  });

  // ---- provider/source health control ----
  /**
   * Every source's stored health, plus what the admin surfaces need and readers never get (#115): the last live
   * verdict (`live`) and the failures that are open and confirmed now (`failing`, lib/sourceEvidence.ts). The
   * Providers card overlays these on the public status, which stays exactly what GET /api/sources says: that one
   * is a single cache key for every account and feeds Discover's ordering. `evidence` is the same per-stage lines
   * Health's rows carry, so the card and the row are drawn from one reading of `stages`; `testMs` is how long one
   * Test may take, for the Test button's clock (the same number Health's sources check sends).
   */
  app.get('/api/admin/sources', async () => {
    const now = Date.now();
    return {
      content: (await healthAllWithEvidence()).map((h) => ({
        ...h,
        failing: currentFailures(h.stages, now).map(({ confirmed: _c, stale: _s, ...f }) => f),
        live: h.live_at
          ? { at: h.live_at, by: h.live_by, state: h.live_state, stage: h.live_stage, code: h.live_code, checks: h.live_checks }
          : null,
        evidence: stageLines(h.stages),
      })),
      testMs: env.SOURCE_TEST_TIMEOUT_MS + 8000,
    };
  });
  /**
   * Go and look at this source right now, and say what is wrong with it.
   *
   * Its own route rather than another arm of the `:action` switch below: Fastify ranks a static segment
   * above a parametric one, so `/:id/test` wins, and this needs its own timeout, response shape and audit
   * line, none of which fit a switch whose every arm returns `{ok: true}`.
   *
   * Three deliberate non-features, each of which looks like an omission:
   *
   * - **It does not consult the cooldown.** `blockedNow` is read in exactly two places and neither is on
   *   this path, so nothing had to be added to bypass it. Do not "fix" that for consistency: running while
   *   the source is blocked is the entire point of the button.
   * - **It records what it found as evidence, and never changes the cooldown** (v0.49.0, #115). The verdict
   *   goes to live_* and the per-stage evidence Health reads (lib/sourceCheck.ts). No `reportFail`: three
   *   impatient clicks would take `consecutive` from 3 to 6 and the cooldown from 90 minutes to its ceiling. No
   *   status, and no checked_at either: the desktop app schedules the daily check from max(checked_at)
   *   (server.ts), so a Test that stamped it would postpone the check. Before v0.49.0 it wrote nothing at all,
   *   which is how a source could fail its Test while Health said "All good".
   * - **Passing does not clear the block.** It reports `canClear` and leaves the decision to the admin. The
   *   smoke test stops at listing page URLs and never fetches an image byte, while the downloader's own
   *   failures are about bytes: hotlink protection, HTML served where a JPEG was promised. Green here is not
   *   proof it will download. Auto-clearing would also reset `consecutive` to 0, so the next failure would
   *   earn a SHORTER cooldown than the one before it.
   */
  /**
   * Run the source watchdog now, rather than waiting for its daily sweep.
   *
   * Same code path as the schedule, including the auto-fixes, so what an admin sees here is exactly what
   * happens unattended. It can take a while -- every source is probed and smoke-tested one at a time, on
   * purpose, because they share one Cloudflare solver -- so since v0.49.0 it runs in the background: this
   * answers 202 with the progress at once, and GET on the same path reads it until `running` is false and
   * `result` holds the sweep's answer. One request held open for the whole sweep was cut by reverse proxies.
   */
  app.post('/api/admin/sources/check', async (req, reply) => {
    const userId = userIdOf(req);
    // The audit line is written when the sweep ends, long after this answer, and req.ip reads the socket, which
    // may be gone by then: the two things logAudit reads of a request, its IP and user agent, are taken now.
    const h = req.headers;
    const from = { ip: req.ip, headers: { 'x-forwarded-for': h['x-forwarded-for'], 'user-agent': h['user-agent'] } } as unknown as FastifyRequest;
    const started = !checkRunning() && startSourceCheck({ by: 'admin' }, (r) => logAudit('source.check', {
      userId,
      detail: { checked: r.sources.length, attention: r.needsAttention.length, inconclusive: r.inconclusive.length },
      req: from,
    }));
    if (!started) return reply.code(409).send({ error: 'busy', message: 'A source check is already running.', progress: checkProgress() });
    return reply.code(202).send(checkProgress());
  });
  app.get('/api/admin/sources/check', async () => checkProgress());

  /**
   * Every source the server knows, of every kind, in one answer (v0.54.0, lib/sourcesOverview.ts): the one Sources
   * section reads it. `attention` is what it leads with: the sources to Replace, the failing ones nothing uses, and how
   * many extensions have an update waiting. The extension engine's own state stays GET /api/admin/extensions/status's.
   */
  app.get('/api/admin/sources/overview', async () => sourcesOverview());

  app.post('/api/admin/sources/:id/test', async (req, reply) => {
    const { id } = req.params as { id: string };
    const src = getSource(id);
    if (!src) return reply.code(404).send({ error: 'not_found' });
    // lib/sourceCheck.ts testSource: the check, recorded and audited, one Test of a source at a time -- Fix everything's
    // Tests included (v0.55.0).
    const r = await testSource(src, { userId: userIdOf(req), req });
    if (r === 'busy') return reply.code(409).send({ error: 'busy', message: 'That source is already being tested.' });
    return reply.send({
      ok: r.smoke.ok, timedOut: r.smoke.timedOut, checks: r.smoke.checks, probe: r.probe, diagnosis: r.diagnosis,
      canClear: r.smoke.ok && r.blocked,
      state: r.state, stage: r.stage, ms: r.smoke.ms, recorded: true,
    });
  });

  /**
   * Retire a source no series has as its main source (v0.54.0, lib/retireSource.ts): its follows are dropped with their
   * listing rows, then `how: 'off'` (the default) switches it off, and `remove` takes a site added by address out of
   * the list, switches an extension's source off in the extension, and turns anything else (MangaDex, a built-in, a
   * pack) off -- `done` says which: `turned_off`, `removed` or `switched_off`. 409 `in_use` {main} while it is some
   * series' main source: Replace it first. Its own route, which Fastify ranks above `/:id/:action` as it ranks `/test`.
   */
  app.post('/api/admin/sources/:id/retire', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ how: z.enum(['off', 'remove']).optional() }).strict().safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'How to retire it: {how: "off" | "remove"}.' });
    const r = await retireSource(id, { how: b.data.how ?? 'off', userId: userIdOf(req), req });
    if ('inUse' in r) return reply.code(409).send(inUse(r.inUse));
    return r;
  });

  app.post('/api/admin/sources/:id/:action', async (req, reply) => {
    const { id, action } = req.params as { id: string; action: string };
    if (action === 'disable') await setDisabled(id, true);
    else if (action === 'enable') await setDisabled(id, false);
    else if (action === 'unblock') await clearBlock(id);
    else return reply.code(400).send({ error: 'bad_action' });
    await logAudit(`source.${action}`, { userId: userIdOf(req), detail: { source: id }, req });
    return reply.send({ ok: true });
  });

  // ---- sessions across all users ----
  app.get('/api/admin/sessions', async () => ({
    content: await q(`SELECT r.id, r.user_id, u.username, u.display_name, r.device_name, r.ip, r.user_agent, r.created_at, r.last_seen
      FROM refresh_tokens r JOIN users u ON u.id = r.user_id
      WHERE r.revoked_at IS NULL AND r.expires_at > now() ORDER BY r.last_seen DESC LIMIT 300`),
  }));
  app.delete('/api/admin/sessions/:id', async (req) => {
    await revokeRefreshTokenById((req.params as { id: string }).id);
    await logAudit('admin.session_revoke', { userId: userIdOf(req), req });
    return { ok: true };
  });

  app.get('/api/admin/stats', async () => {
    const [libs, seriesPage, cb, members, backlog, activity] = await Promise.all([
      komga.libraries(SYSTEM_CTX).catch(() => [] as any[]),
      komga.searchSeries(SYSTEM_CTX, {}, 0, 1).catch(() => ({ totalElements: 0 } as any)),
      cacheBytes().catch(() => 0),
      one<{ c: number }>('SELECT count(*)::int AS c FROM users'),
      // How far behind the library is, from what the sources said last time the updater asked. Before the
      // columns existed this was unknowable without asking every source again.
      one<{ chapters: number; series: number }>(
        `SELECT coalesce(sum(s.source_missing), 0)::int AS chapters,
                count(*) FILTER (WHERE s.source_missing > 0)::int AS series
           FROM lib_series s WHERE s.auto_update AND ${visibleToAll('s')}`,
      ).catch(() => null),
      q(
        // What each member last read, so the admin overview can show a person against the cover of the
        // thing they were reading rather than against another flat card. Admin-only by construction: this
        // route is behind requireAdmin, and the same fact is deliberately NOT added to /api/leaderboard,
        // which every member can read -- "who is reading what" is a different disclosure from "who read
        // how much", and the leaderboard is not the place to make it.
        //
        // The lateral join runs once per member and is index-served by idx_events_recent
        // (user_id, created_at DESC); the alternative, a window function over every event row, is not.
        `SELECT u.id, u.display_name, u.username, u.avatar,
                count(e.*) FILTER (WHERE e.completed)::int AS total,
                count(e.*) FILTER (WHERE e.completed AND e.created_at > now() - interval '7 days')::int AS week,
                max(e.created_at) AS last_active,
                l.series_id AS last_series_id,
                l.title     AS last_series_title
         FROM users u
         LEFT JOIN reading_events e ON e.user_id = u.id
         LEFT JOIN LATERAL (
           SELECT ev.series_id, COALESCE(o.title, s.title) AS title
             FROM reading_events ev
             JOIN lib_series s ON s.id = ev.series_id AND ${visibleToAll('s')}
             LEFT JOIN series_overrides o ON o.series_id = s.id
            WHERE ev.user_id = u.id
            ORDER BY ev.created_at DESC
            LIMIT 1
         ) l ON true
         GROUP BY u.id, l.series_id, l.title ORDER BY total DESC`,
      ),
    ]);
    return {
      libraries: (libs as any[]).map((l) => ({ name: l.name })),
      seriesTotal: (seriesPage as any).totalElements ?? 0,
      cacheBytes: cb,
      lastScan: runtime.lastScan || null,
      members: members?.c ?? 0,
      backlog: { chapters: backlog?.chapters ?? 0, series: backlog?.series ?? 0 },
      // Where the database lives. The entrypoint exports EMBEDDED_DB=1 only when it started Postgres itself
      // (DATABASE_URL was unset); an install talking to its own database never sees the variable.
      database: process.env.EMBEDDED_DB === '1' ? 'embedded' : 'external',
      activity,
    };
  });

  // canDownload is the only permission that is actually enforced (sources.ts, adding a series). A flag
  // that is toggleable and checked nowhere is worse than no flag, so there is deliberately only one.
  const permsShape = z.object({ canDownload: z.boolean().optional() });

  app.post('/api/admin/users', async (req, reply) => {
    const b = z
      .object({
        username: z.string().min(2).max(64).regex(/^[a-zA-Z0-9._-]+$/, 'letters, numbers, . _ - only'),
        password: z.string().min(1).max(200),
        displayName: z.string().max(64).optional(),
        role: z.enum(['admin', 'user']).default('user'),
        perms: permsShape.optional(),
      })
      .safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', detail: b.error.flatten().fieldErrors });
    const { username, password, displayName, role, perms } = b.data;
    const pwErr = passwordError(password);
    if (pwErr) return reply.code(400).send({ error: 'weak_password', message: pwErr });

    const exists = await one('SELECT id FROM users WHERE username = $1', [username]);
    if (exists) return reply.code(409).send({ error: 'username_taken' });

    const ph = await hash(password);
    const row = await one<{ id: string }>(
      `INSERT INTO users (display_name, username, role, password_hash, auth_kind, perms)
       VALUES ($1, $2, $3, $4, 'password', $5)
       RETURNING id, username, display_name, role, created_at`,
      [displayName || username, username, role, ph, JSON.stringify(perms || {})],
    );
    if (row) await q(`INSERT INTO app_settings (user_id, data) VALUES ($1, '{}'::jsonb) ON CONFLICT (user_id) DO NOTHING`, [row.id]);
    await logAudit('user.create', { userId: userIdOf(req), detail: { username, role }, req });
    return reply.send(row);
  });

  app.patch('/api/admin/users/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z
      .object({
        password: z.string().min(1).max(200).optional(),
        displayName: z.string().max(64).optional(),
        role: z.enum(['admin', 'user']).optional(),
        disabled: z.boolean().optional(),
        perms: permsShape.optional(),
        // null means every library, including ones created later. A list means exactly these.
        // Absent means leave the current setting alone.
        libraries: z.array(z.string()).nullable().optional(),
        // The highest age rating this member may see. null means no cap, matching `libraries`.
        maxAgeRating: z.number().int().min(0).max(18).nullable().optional(),
      })
      .parse(req.body);
    // safety: never lock yourself out, never remove the last active admin
    if (id === userIdOf(req) && (b.disabled || b.role === 'user')) return reply.code(400).send({ error: 'cannot_demote_self' });
    if (b.disabled || b.role === 'user') {
      const t = await one<{ role: string }>('SELECT role FROM users WHERE id = $1', [id]);
      if (t?.role === 'admin') {
        const admins = await one<{ c: number }>(`SELECT count(*)::int AS c FROM users WHERE role = 'admin' AND NOT disabled`);
        if ((admins?.c ?? 0) <= 1) return reply.code(400).send({ error: 'last_admin' });
      }
    }
    if (b.password) {
      const pwErr = passwordError(b.password);
      if (pwErr) return reply.code(400).send({ error: 'weak_password', message: pwErr });
      await q('UPDATE users SET password_hash = $2, password_changed_at = now(), failed_logins = 0, locked_until = NULL WHERE id = $1', [id, await hash(b.password)]);
      await revokeAllSessions(id); // force re-login after an admin password reset
    }
    if (b.displayName) await q('UPDATE users SET display_name = $2 WHERE id = $1', [id, b.displayName]);
    if (b.maxAgeRating !== undefined) {
      await q('UPDATE users SET max_age_rating = $2 WHERE id = $1', [id, b.maxAgeRating]);
      await logAudit('user.age_cap', { userId: userIdOf(req), detail: { id, maxAgeRating: b.maxAgeRating }, req });
    }
    if (b.libraries !== undefined) {
      // Three states, and they are not interchangeable:
      //   null  -> unrestricted, which IS the absence of rows, so clearing is the whole operation;
      //   [...] -> exactly these;
      //   []    -> nothing, which cannot be said by writing no rows because that is state one. It gets the
      //            marker instead. Before this, unticking every box handed the member the whole collection.
      const want = b.libraries;
      await tx(async (qq) => {
        await qq('DELETE FROM user_libraries WHERE user_id = $1', [id]);
        if (want === null) return;
        for (const lid of want) {
          await qq(
            `INSERT INTO user_libraries (user_id, library_id) SELECT $1, id FROM libraries WHERE id = $2
             ON CONFLICT DO NOTHING`,
            [id, lid],
          );
        }
        // Also covers a list of ids that no longer exist, which inserts nothing and would otherwise read as
        // unrestricted rather than as the empty selection it was.
        await keepRestricted(qq, id);
      });
      await logAudit('user.libraries', { userId: userIdOf(req), detail: { id, libraries: b.libraries }, req });
    }
    if (b.role) await q('UPDATE users SET role = $2 WHERE id = $1', [id, b.role]);
    if (b.perms) await q('UPDATE users SET perms = $2 WHERE id = $1', [id, JSON.stringify(b.perms)]);
    if (b.disabled !== undefined) {
      await q('UPDATE users SET disabled = $2 WHERE id = $1', [id, b.disabled]);
      if (b.disabled) await revokeAllSessions(id); // kick out a suspended account
    }
    await logAudit('user.update', { userId: userIdOf(req), detail: { target: id, role: b.role, disabled: b.disabled, perms: b.perms, password: b.password ? '***' : undefined }, req });
    return one('SELECT id, username, display_name, role, disabled, perms, totp_enabled FROM users WHERE id = $1', [id]);
  });

  app.delete('/api/admin/users/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === userIdOf(req)) return reply.code(400).send({ error: 'cannot_delete_self' });
    const target = await one<{ role: string; username: string }>('SELECT role, username FROM users WHERE id = $1', [id]);
    if (!target) return reply.code(404).send({ error: 'not_found' });
    if (target.role === 'admin') {
      const admins = await one<{ c: number }>(`SELECT count(*)::int AS c FROM users WHERE role = 'admin'`);
      if ((admins?.c ?? 0) <= 1) return reply.code(400).send({ error: 'last_admin' });
    }
    // Seventeen tables cascade from users(id) -- read progress, reading events, favourites, ratings, notes,
    // collections, bookmarks, offline downloads, trackers. This was the ONLY mutating route in this file with
    // no audit entry, out of thirty-nine, so the single most destructive action the admin UI offers was also
    // the one that left no record of having happened or of who did it. Counted BEFORE the delete, because
    // afterwards there is nothing left to count.
    const lost = await one<{ progress: number; events: number; favorites: number }>(
      `SELECT (SELECT count(*)::int FROM read_progress  WHERE user_id = $1) AS progress,
              (SELECT count(*)::int FROM reading_events WHERE user_id = $1) AS events,
              (SELECT count(*)::int FROM favorites      WHERE user_id = $1) AS favorites`, [id]).catch(() => null);
    await logAudit('user.delete', {
      userId: userIdOf(req),
      detail: { target: id, username: target.username, role: target.role, destroyed: lost ?? 'uncounted' },
      req,
    });
    await q('DELETE FROM users WHERE id = $1', [id]);
    return reply.send({ ok: true });
  });
}
