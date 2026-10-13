// Push reading progress to external trackers (AniList, MyAnimeList, Kitsu).
//
// Design constraints that shaped this:
//  * Reading must never wait on, or fail because of, a tracker. Every push is fire-and-forget, rate-limited,
//    and swallows its errors into `user_trackers.last_error` for the UI to show.
//  * AniList tokens last a year and there are NO refresh tokens. Silent expiry is the failure mode users
//    hate most, so expiry is stored and surfaced, and an auth failure disables the connection loudly.
//  * `provider` is carried everywhere so MAL/Kitsu could be added without a migration. They since were, and
//    that held: no schema changed. What was NOT abstracted was the calls that talk to a service, which now
//    live in trackerProviders.ts behind one adapter each (prove a token, push progress, read the list).
//  * A user may connect SEVERAL trackers at once, so every push fans out over their enabled connections.
//    One failing service must not stop the others, and each keeps its own error and its own high-water mark.
import { q, one } from './db';
import { seal, open as unseal } from './secretbox';
import { withGate } from './gate';
import { ADAPTERS, PROVIDERS, verdictOf, type Provider, type PushStatus, type SeriesState } from './trackerProviders';
import { ghostsEnabled, ghostNumbers } from './komgaGhosts';
import { continuousRun, marksFor, mergeRun, realRows } from './listingProgress';
import { noticeShown } from './noticeChapters';
import { lastNumber } from './chapterRanges';
import type { ScopedQuery } from './anilistPolicy';
import { incognitoOn } from './incognito';
export type { Provider } from './trackerProviders';


export interface TrackerStatus {
  provider: Provider;
  /** Display name and where to get a token, so the UI does not hardcode the provider list. */
  label: string;
  tokenHelp: string;
  /** A page that shows a token to copy (v0.61.0): AniList's, for the project's public client. Absent for the others. */
  authorizeUrl?: string;
  connected: boolean;
  accountName: string | null;
  expiresAt: string | null;
  /** true when the token lapses within 30 days — AniList can't refresh, so this needs a nudge */
  expiringSoon: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
}

const EXPIRY_WARN_DAYS = 30;

// ---- connection management -------------------------------------------------

export async function saveConnection(
  userId: string,
  provider: Provider,
  token: string,
  accountName: string | null,
  expiresAt: Date | null,
): Promise<void> {
  await q(
    `INSERT INTO user_trackers (user_id, provider, access_token, account_name, expires_at, enabled, last_error)
     VALUES ($1,$2,$3,$4,$5,true,NULL)
     ON CONFLICT (user_id, provider) DO UPDATE
       SET access_token = EXCLUDED.access_token, account_name = EXCLUDED.account_name,
           expires_at = EXCLUDED.expires_at, enabled = true, last_error = NULL`,
    [userId, provider, seal(token), accountName, expiresAt],
  );
}

export async function disconnect(userId: string, provider: Provider): Promise<void> {
  await q('DELETE FROM user_trackers WHERE user_id = $1 AND provider = $2', [userId, provider]);
}

export async function statusFor(userId: string): Promise<TrackerStatus[]> {
  const rows = await q<{
    provider: Provider; account_name: string | null; expires_at: string | null;
    enabled: boolean; last_sync_at: string | null; last_error: string | null;
  }>(
    `SELECT provider, account_name, expires_at, enabled, last_sync_at, last_error
       FROM user_trackers WHERE user_id = $1`,
    [userId],
  );
  // Every provider is listed, connected or not, so the UI can offer the ones a user has not set up without
  // knowing the list itself. A row that exists but is disabled is a connection whose token was rejected --
  // meaningfully different from never having connected, and the error explains which.
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  return PROVIDERS.map((p) => {
    const r = byProvider.get(p);
    // Additive (v0.61.0): only a provider with such a page carries the key at all.
    const authorizeUrl = ADAPTERS[p].authorizeUrl ? { authorizeUrl: ADAPTERS[p].authorizeUrl } : {};
    if (!r) {
      return {
        provider: p, connected: false, accountName: null, expiresAt: null,
        expiringSoon: false, lastSyncAt: null, lastError: null,
        label: ADAPTERS[p].label, tokenHelp: ADAPTERS[p].tokenHelp, ...authorizeUrl,
      };
    }
    return {
    label: ADAPTERS[p].label,
    tokenHelp: ADAPTERS[p].tokenHelp,
    ...authorizeUrl,
    provider: r.provider,
    connected: r.enabled,
    accountName: r.account_name,
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    expiringSoon: !!r.expires_at && new Date(r.expires_at).getTime() - Date.now() < EXPIRY_WARN_DAYS * 86_400_000,
    lastSyncAt: r.last_sync_at ? new Date(r.last_sync_at).toISOString() : null,
    lastError: r.last_error,
    };
  });
}

/** Record which external entry a series maps to. Called wherever an AniList match is resolved (art lookup,
 *  backfill, or an admin picking a match by hand) so the mapping is a by-product of work already happening.
 *  An explicit `linkedBy` marks a human choice, which automatic matching then leaves alone.
 *  `checked_at` (v0.55.7): every automatic caller resolves the entry through lib/anilist.ts fetchAniListArt, which
 *  holds it to the series' names (lib/onlineMatch.ts), so a link written here is checked; the background recheck
 *  (lib/matchCheck.ts) takes up only the rows written without the mark -- before v0.55.7, by an older version after a
 *  rollback, or copied by a statement that does not name the column. */
export async function linkSeriesWith(
  qq: ScopedQuery,
  seriesId: string,
  externalId: string | number,
  title: string | null,
  linkedBy: string | null = null,
  // Was hardcoded to 'anilist' in the INSERT below despite the table keying on provider, so every link a
  // second tracker made would have been written as an AniList one and then read back as the wrong id.
  provider: Provider = 'anilist',
): Promise<boolean> {
  const rows = await qq<{ linked: number }>(
    `INSERT INTO series_trackers (series_id, provider, external_id, title, linked_by, checked_at)
     VALUES ($1,$5,$2,$3,$4, now())
     ON CONFLICT (series_id, provider) DO UPDATE
       SET external_id = EXCLUDED.external_id, title = EXCLUDED.title,
           linked_by = COALESCE(EXCLUDED.linked_by, series_trackers.linked_by),
           updated_at = now(), checked_at = now()
     WHERE series_trackers.linked_by IS NULL OR EXCLUDED.linked_by IS NOT NULL
     RETURNING 1 AS linked`,
    [seriesId, String(externalId), title, linkedBy, provider],
  );
  return rows.length > 0;
}

/** Unconditional/manual wrapper. Automatic callers use `linkSeriesWith` inside `withAniListMutation`. */
export async function linkSeries(
  seriesId: string,
  externalId: string | number,
  title: string | null,
  linkedBy: string | null = null,
  provider: Provider = 'anilist',
): Promise<void> {
  await linkSeriesWith(q, seriesId, externalId, title, linkedBy, provider).catch(() => {});
}

/**
 * Record what a tracker already says about a series for this person, so the first push after an import can
 * never rewind their real entry: an import from a list at chapter 150 followed by reading chapter 1 here
 * would otherwise send "1" -- the one failure pushOne calls unrepairable, because the tracker takes a lower
 * number and rewrites the history. `pushed_at` stays NULL: nothing was sent, the tracker is simply ahead,
 * and pushOne treats such a floor as a quiet skip rather than a refusal worth an error.
 *
 * A fresh read REPLACES the floor, whatever stood there and whether or not a push had stamped it. The number
 * came from the tracker itself seconds ago, so it IS the entry's state: import at 150 (floor 150) → the
 * person fixes a mis-click on the site down to 20 → reads chapter 21 here → `21 < 150`, and with a floor
 * that could only ever rise, every chapter up to 150 was skipped quietly (no error by design, so the card
 * said "sync works" while the tracker never moved) and pressing Load list again did not help either, because
 * the new 20 lost to GREATEST. Load list again is the repair, so the seed must take the tracker's word. The
 * stamp goes too: a stamped floor meant "a number this app sent", and after a re-import the floor is the
 * tracker's, not ours -- unstamped is the truthful state, and below it pushOne skips quietly instead of
 * writing a refusal about a number nobody sent. ⚠️ Reintroduce by GREATEST(tracker_progress.chapters,
 * EXCLUDED.chapters), or by leaving pushed_at alone: the mis-click sequence above comes back.
 */
export async function seedTrackerFloor(userId: string, seriesId: string, provider: Provider, chapters: number): Promise<void> {
  if (!(chapters > 0)) return;
  await q(
    `INSERT INTO tracker_progress (user_id, series_id, provider, chapters, pushed_at)
     VALUES ($1, $2, $3, $4, NULL)
     ON CONFLICT (user_id, series_id, provider)
       DO UPDATE SET chapters = EXCLUDED.chapters, pushed_at = NULL`,
    [userId, seriesId, provider, Math.floor(chapters)],
  ).catch(() => {});
}

// ---- AniList calls ---------------------------------------------------------


/** Who the token belongs to — used at connect time to show the account name and prove the token works. */
export async function whoAmI(token: string, provider: Provider = 'anilist'): Promise<{ id: string; name: string } | null> {
  const adapter = ADAPTERS[provider];
  if (!adapter) return null;
  return adapter.whoAmI(token);
}

/** What Test connection found (v0.61.0): the token works, the service says no, or something between the two. */
export type TestVerdict = 'connected' | 'rejected' | 'unreachable' | 'refused' | 'expired' | 'not_connected';
export interface TestResult { ok: boolean; verdict: TestVerdict; account?: string; status?: number }

/**
 * Ask the service whether the saved token still works (v0.61.0, #190): unseal it and make the one call Connect proves a
 * token with (the adapter's whoAmI). It changes NOTHING -- not `enabled`, not `last_error`, not the account name: a
 * person checking a connection must not be able to disable it, and a service having a bad minute is not a verdict the
 * card should keep (verdictOf, trackerProviders.ts, says which answers are). Outside the push gate on purpose: behind a
 * backfill's queue a test would wait minutes; the route is rate-limited instead.
 *
 * `not_connected` is no row, a disabled one (GET /api/trackers says `connected: false` for it), or a token this server
 * can no longer unseal -- each needs a new token pasted, which is what reconnecting is. `expired` is said without
 * sending the token, as a push would not send it either (pushOne). Reintroduce a write (markError on a failure, say):
 * "test: each verdict, and nothing about the connection is written" in trackerVerdicts.int.test.ts fails.
 */
export async function testConnection(userId: string, provider: Provider): Promise<TestResult> {
  const row = await one<{ access_token: string; expires_at: string | null; enabled: boolean }>(
    'SELECT access_token, expires_at, enabled FROM user_trackers WHERE user_id = $1 AND provider = $2',
    [userId, provider],
  );
  if (!row || !row.enabled) return { ok: false, verdict: 'not_connected' };
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return { ok: false, verdict: 'expired' };
  const token = unseal(row.access_token);
  if (!token) return { ok: false, verdict: 'not_connected' };
  try {
    const who = await ADAPTERS[provider].whoAmI(token);
    return who ? { ok: true, verdict: 'connected', account: who.name } : { ok: false, verdict: 'rejected' };
  } catch (e) {
    const v = verdictOf(e);
    return { ok: false, verdict: v.verdict, ...(v.status ? { status: v.status } : {}) };
  }
}

// ---- progress push ---------------------------------------------------------


/**
 * What we would tell a tracker about this series: the highest chapter number the user has *completed*,
 * and whether every chapter here is done. ⚠️ Since v0.61.2 (#201) `finished` no longer decides the status a
 * tracker is told: every chapter on this server read is not the series read, so pushStatus asks the service.
 *
 * Deliberately the maximum completed chapter rather than the one just finished — re-reading chapter 3 of a
 * series you're 200 chapters into must not rewind the tracker, and a backfill pushing chapters in arbitrary
 * order must converge on the same answer. Exported so this rule can be tested without calling AniList.
 *
 * ⚠️ MARKS ON CHAPTERS THIS SERVER DOES NOT HOLD (#69, lib/listingProgress) reach the tracker ONLY through the
 * contiguous run -- continuousRun, the figure the Komga surface reports as lastReadContinuousNumberSort --
 * GREATEST-ed with the real MAX above, never through the MAX itself. A number pushed here is effectively
 * irreversible (the monotonic floor in pushOne), so one stray tick on chapter 1000 must add nothing, while
 * ticking 13..200 behind a real 12 pushes 200. Floored: a run ending on a marked 12.6 tells the tracker 12,
 * not a chapter 13 nobody ticked. ⚠️ And only with komga_ghost_chapters on, like the Komga surface: the two
 * must agree on one quantity (this file's header), and an install with the switch off (the default) sends
 * exactly what v0.42.0 sent. `finished` stays over the real rows, so a partly-ticked ghost list can never
 * flip an entry to COMPLETED. Reintroduce by pushing the max marked number: "one mark on chapter 1000 with
 * real progress at 12 pushes 12" in trackers.int.test.ts reads 1000.
 */
export async function seriesProgressFor(userId: string, seriesId: string): Promise<{ chapters: number; finished: boolean }> {
  const prog = await one<{ chapters: number; total: number; done: number }>(
    // COALESCE the override: if an admin corrected "Vol 2 Ch 5" from chapter 2 to chapter 5, the tracker
    // has to be told 5, or it disagrees with the number the reader is showing the user.
    // FLOORED, as the contiguous run below is: `::int` on a real ROUNDS, so a completed 12.6 -- every N.5x
    // chapter anywhere, and every part of an episode a source numbers N.01..N.73 (#116) -- told the tracker
    // N+1, a chapter nobody had read, and a push is effectively irreversible.
    // Reintroduce by casting without floor(): "a completed 12.6 tells the tracker 12" in trackers.int.test.ts
    // reads 13.
    // A completed file holding a range counts its END (v0.55.2, lib/chapterRanges.ts): finishing `Batman 01-07` is
    // reading chapter 7, and AniList is told 7, not 1. `total`/`done` stay counts of files: the file is read or not.
    // Reintroduce the start: "finishing a range file tells the tracker its end" in chapterRanges.int.test.ts reads 1.
    `SELECT floor(COALESCE(MAX(${lastNumber('b', 'ov')}) FILTER (WHERE rp.completed), 0))::int AS chapters,
            count(*)::int AS total,
            count(*) FILTER (WHERE rp.completed)::int AS done
       FROM lib_books b
       JOIN lib_series s ON s.id = b.series_id
       LEFT JOIN book_overrides ov ON ov.book_id = b.id
       LEFT JOIN read_progress rp ON rp.book_id = b.id AND rp.user_id = $2
      WHERE b.series_id = $1
        -- Not a notice chapter the admin hides (lib/noticeChapters.ts): an unread notice must not keep a series
        -- that is read to the end from being finished.
        AND ${noticeShown('s', 'b', 'ov')}`,
    [seriesId, userId],
  );
  const out = {
    chapters: prog?.chapters ?? 0,
    finished: !!prog && prog.total > 0 && prog.done === prog.total,
  };
  // The cheap exits first, so a reader with no marks (nearly everyone) pays one indexed probe at most.
  if (!(await ghostsEnabled())) return out;
  const marks = await marksFor(userId, seriesId);
  if (!marks.size) return out;
  const ghosts = await ghostNumbers(seriesId);
  if (!ghosts.some((n) => marks.has(n))) return out;
  const run = continuousRun(mergeRun(await realRows(userId, seriesId), ghosts, marks));
  out.chapters = Math.max(out.chapters, Math.floor(run));
  return out;
}

/**
 * What a push tells a tracker, from what the service already holds (v0.61.2, #201) -- or null, nothing at all.
 *
 * - The service holds this chapter or a later one: nothing. Saying it again could only rewind the entry, or move it
 *   between lists for no new reading. `lower` is the resync's deliberate way down (POST /api/trackers/:p/resync).
 * - COMPLETED only when the SERVICE says the series has ended and gives a chapter count this reaches: Mihon's rule.
 *   It used to be "every chapter on this server is read", which a series still coming out reaches at every catch-up,
 *   so the entry sat under Completed between releases (#201). An ended series with no count stays reading.
 * - A re-read stays a re-read; an entry completed on a series that has ended stays completed (the person put it
 *   there, and Mihon keeps it too).
 * - Everything else is reading: a planned, paused or dropped entry picked up again, a new entry, and an entry left
 *   under Completed on a series still coming out -- which is how the ones this bug completed come back.
 * Reintroduce the old rule by returning 'completed' for any entry at the end of the local chapters:
 * trackerStatus.test.ts "a series still coming out, read to its newest chapter, stays reading" fails.
 */
export function pushStatus(chapters: number, s: SeriesState, opts: { lower?: boolean } = {}): PushStatus | null {
  const e = s.entry;
  if (e && e.progress >= chapters && !opts.lower) return null;
  if (s.ended && s.total != null && chapters >= s.total) return 'completed';
  if (e?.status === 'rereading') return 'rereading';
  if (e?.status === 'completed' && s.ended) return 'completed';
  return 'reading';
}

/**
 * Push one series to every tracker this user has connected. The highest completed chapter is resolved rather
 * than the chapter just finished, so reading out of order (or backfilling) can't move a tracker backwards.
 *
 * Fans out because a user may have AniList and MyAnimeList on at once, and one service being down or having
 * rejected its token must not stop the other from receiving progress. Each connection keeps its own error,
 * its own high-water mark, and its own gate lane. `lower` names the one provider a resync may take DOWN.
 */
export async function pushSeriesProgress(userId: string, seriesId: string, opts: { lower?: Provider } = {}): Promise<void> {
  const conns = await q<{ provider: Provider; access_token: string; expires_at: string | null }>(
    `SELECT provider, access_token, expires_at FROM user_trackers
      WHERE user_id = $1 AND enabled = true`,
    [userId],
  );
  if (!conns.length) return;

  const { chapters } = await seriesProgressFor(userId, seriesId);
  if (chapters <= 0) return;

  await Promise.all(conns.map((conn) => pushOne(userId, seriesId, conn, chapters, opts.lower === conn.provider)));
}

async function pushOne(
  userId: string,
  seriesId: string,
  conn: { provider: Provider; access_token: string; expires_at: string | null },
  chapters: number,
  lower: boolean,
): Promise<void> {
  const adapter = ADAPTERS[conn.provider];
  if (!adapter) return;

  const link = await one<{ external_id: string }>(
    `SELECT external_id FROM series_trackers WHERE series_id = $1 AND provider = $2`,
    [seriesId, conn.provider],
  );
  if (!link) return; // this series was never matched on this service

  if (conn.expires_at && new Date(conn.expires_at).getTime() < Date.now()) {
    await markError(userId, conn.provider, 'the access token has expired -- reconnect to resume syncing');
    return;
  }
  const token = unseal(conn.access_token);
  if (!token) {
    await markError(userId, conn.provider, 'stored token could not be read -- reconnect to resume syncing');
    return;
  }

  // Never push a number lower than the last one we sent. A tracker takes a lower progress and rewrites the
  // entry, so a merge, a renumbered chapter or a bulk mark-unread would quietly walk someone's real reading
  // history backwards on an account this app does not own and cannot repair. Going forward is always safe;
  // going backwards needs a person to ask for it: re-importing their list (seedTrackerFloor takes the
  // tracker's current number) or the resync endpoint.
  const floor = await one<{ chapters: number; pushed_at: string | null }>(
    `SELECT chapters, pushed_at FROM tracker_progress WHERE user_id = $1 AND series_id = $2 AND provider = $3`,
    [userId, seriesId, conn.provider],
  );
  // A floor with no timestamp was seeded from the tracker's own entry when the series was imported or
  // linked: nothing was ever sent, the tracker is simply ahead of (or level with) what has been read here,
  // and someone reading chapter 1 of a title they are at chapter 150 on is not an error worth a banner on
  // their profile. Pass quietly; the first count that passes the floor pushes and stamps it.
  // ⚠️ EQUAL skips too, for an unstamped floor only: the tracker already holds this exact number, so there
  // is nothing new to say -- and a push would say it with `status: CURRENT` unless every local chapter is
  // read, flipping a COMPLETED entry to reading because the person re-read its last chapter here. A stamped
  // floor keeps the strict `<` below: equal to a number this app sent is a no-op push, not a refusal.
  // Reintroduce by `chapters < floor.chapters` here: the re-read of the tracker's last chapter pushes.
  if (floor && floor.pushed_at == null && chapters <= floor.chapters) return;
  // The ENTRY's floor (v0.52.0, #72): the highest count this person's OTHER series on the same tracker entry have
  // recorded. The language editions of one work are one AniList or MyAnimeList entry, so reading the Spanish
  // edition, which is twenty chapters behind, must not tell the tracker 30 over the 50 the English one sent -- and
  // a shorter edition read to its end must not mark the entry COMPLETED below it. A quiet no-op, not an error: the
  // entry is simply ahead, as an import-seeded floor is. Two copies of one title added by accident are the same
  // case and gain the same protection. Reintroduce by dropping it: "an edition behind the other pushes nothing" in
  // trackers.int.test.ts sees 10 sent.
  const entry = await one<{ chapters: number | null }>(
    `SELECT max(tp.chapters)::int AS chapters FROM tracker_progress tp
       JOIN series_trackers st ON st.series_id = tp.series_id AND st.provider = tp.provider
      WHERE tp.user_id = $1 AND tp.provider = $2 AND st.external_id = $3 AND tp.series_id <> $4`,
    [userId, conn.provider, link.external_id, seriesId],
  );
  if (entry?.chapters != null && chapters <= entry.chapters) return;
  if (floor && chapters < floor.chapters) {
    // ⚠️ Reintroduce by dropping the unstamped return above: every chapter finished below an imported floor
    // writes last_error.
    await markError(
      userId,
      conn.provider,
      `not syncing: this series now works out to chapter ${chapters}, below the ${floor.chapters} already sent. ` +
        'Import your list again under Admin → Import (From your tracker) to take the tracker\'s current number, or ask an admin to.',
    );
    return;
  }

  // one lane per user AND provider: a burst of completions trickles out politely to each service, and a slow
  // one cannot hold up a fast one. 2.4 s apart since v0.61.2: a push is a read and a write now, so the calls per
  // minute are what the 1.2 s of one write each used to be.
  await withGate(`tracker:${userId}:${conn.provider}`, async () => {
    try {
      // What the service holds first (v0.61.2, #201): whether the series has ended, its chapter count, and this
      // account's entry -- pushStatus decides from those, never from the chapters on this server alone.
      const state = await adapter.seriesState(token, link.external_id);
      const status = pushStatus(chapters, state, { lower });
      if (status) await adapter.setProgress(token, link.external_id, chapters, status, state);
      await q('UPDATE user_trackers SET last_sync_at = now(), last_error = NULL WHERE user_id=$1 AND provider=$2',
        [userId, conn.provider]);
      // The service is level or ahead and nothing was sent: no floor to raise, nothing this app said.
      if (!status) return;
      // raise the floor only after the tracker actually accepted it
      await q(
        `INSERT INTO tracker_progress (user_id, series_id, provider, chapters, pushed_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (user_id, series_id, provider)
           DO UPDATE SET chapters = GREATEST(tracker_progress.chapters, EXCLUDED.chapters), pushed_at = now()`,
        [userId, seriesId, conn.provider, chapters],
      );
    } catch (e) {
      const err = e as Error & { authFailed?: boolean };
      // a bad token will fail on every future chapter too -- disable it rather than retry forever
      if (err.authFailed) {
        await q('UPDATE user_trackers SET enabled=false, last_error=$3 WHERE user_id=$1 AND provider=$2',
          [userId, conn.provider, 'the tracker rejected the saved token -- reconnect to resume syncing']);
      } else {
        await markError(userId, conn.provider, err.message?.slice(0, 200) || 'sync failed');
      }
    }
  }, { concurrency: 1, minGapMs: 2400 });
}

async function markError(userId: string, provider: Provider, msg: string): Promise<void> {
  await q('UPDATE user_trackers SET last_error = $3 WHERE user_id = $1 AND provider = $2', [userId, provider, msg]).catch(() => {});
}

/**
 * Fire-and-forget wrapper used from the reading path — must never delay or fail a page turn.
 *
 * Every AUTOMATIC push goes through here -- the reader's progress write, Mihon's read-progress PUT, a listing's read
 * marks, a bulk Mark read -- so this is where Incognito reading (v0.61.0, lib/incognito.ts) stops them, whichever
 * client wrote the progress. The deliberate ones on Profile → Connections (Push everything finished, Resync) call
 * pushSeriesProgress directly and still go: the person asked for them. Once Incognito is off, the next push for a series
 * sends its real highest chapter, so the tracker catches up then. Reintroduce by pushing without the check: "a Mihon
 * read-progress PUT pushes nothing under Incognito" in incognito.int.test.ts sees a push.
 */
export function pushSeriesProgressAsync(userId: string, seriesId: string): void {
  void (async () => {
    if (await incognitoOn(userId)) return;
    await pushSeriesProgress(userId, seriesId);
  })().catch(() => {});
}

/**
 * Forget the high-water mark for one series, so the next push is allowed to go backwards.
 *
 * The escape hatch for the case the floor exists to prevent: the tracker is ahead because the old number was
 * wrong, and the correction is the lower one. Deliberately a separate, explicit action rather than something
 * that happens automatically, because it is the only way to lower a number on someone's real account.
 */
export async function clearTrackerFloor(userId: string, seriesId: string, provider: Provider = 'anilist'): Promise<void> {
  // Every series on the same tracker entry (v0.52.0): the editions of one work share the entry's floor (pushOne), so
  // clearing this series' own would leave a sibling's standing in the way of the lower number asked for.
  await q(
    `DELETE FROM tracker_progress WHERE user_id = $1 AND provider = $3 AND (series_id = $2 OR series_id IN (
       SELECT o.series_id FROM series_trackers o JOIN series_trackers me ON me.provider = o.provider AND me.external_id = o.external_id
        WHERE me.series_id = $2 AND me.provider = $3))`,
    [userId, seriesId, provider]);
}
