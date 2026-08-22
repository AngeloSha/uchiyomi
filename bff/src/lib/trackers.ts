// Push reading progress to an external tracker (AniList today).
//
// Design constraints that shaped this:
//  * Reading must never wait on, or fail because of, a tracker. Every push is fire-and-forget, rate-limited,
//    and swallows its errors into `user_trackers.last_error` for the UI to show.
//  * AniList tokens last a year and there are NO refresh tokens. Silent expiry is the failure mode users
//    hate most, so expiry is stored and surfaced, and an auth failure disables the connection loudly.
//  * `provider` is carried everywhere so MAL/Kitsu can be added without a migration.
import { q, one } from './db';
import { seal, open as unseal } from './secretbox';
import { withGate } from './gate';

export type Provider = 'anilist';

export interface TrackerStatus {
  provider: Provider;
  connected: boolean;
  accountName: string | null;
  expiresAt: string | null;
  /** true when the token lapses within 30 days — AniList can't refresh, so this needs a nudge */
  expiringSoon: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
}

const ANILIST_API = 'https://graphql.anilist.co';
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
  return rows.map((r) => ({
    provider: r.provider,
    connected: r.enabled,
    accountName: r.account_name,
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    expiringSoon: !!r.expires_at && new Date(r.expires_at).getTime() - Date.now() < EXPIRY_WARN_DAYS * 86_400_000,
    lastSyncAt: r.last_sync_at ? new Date(r.last_sync_at).toISOString() : null,
    lastError: r.last_error,
  }));
}

/** Record which external entry a series maps to. Called wherever an AniList match is resolved (art lookup,
 *  backfill, or an admin picking a match by hand) so the mapping is a by-product of work already happening.
 *  An explicit `linkedBy` marks a human choice, which automatic matching then leaves alone. */
export async function linkSeries(
  seriesId: string,
  externalId: string | number,
  title: string | null,
  linkedBy: string | null = null,
): Promise<void> {
  await q(
    `INSERT INTO series_trackers (series_id, provider, external_id, title, linked_by)
     VALUES ($1,'anilist',$2,$3,$4)
     ON CONFLICT (series_id, provider) DO UPDATE
       SET external_id = EXCLUDED.external_id, title = EXCLUDED.title,
           linked_by = COALESCE(EXCLUDED.linked_by, series_trackers.linked_by),
           updated_at = now()
     WHERE series_trackers.linked_by IS NULL OR EXCLUDED.linked_by IS NOT NULL`,
    [seriesId, String(externalId), title, linkedBy],
  ).catch(() => {});
}

// ---- AniList calls ---------------------------------------------------------

async function anilist(token: string, query: string, variables: Record<string, unknown>): Promise<any> {
  const r = await fetch(ANILIST_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000),
  });
  if (r.status === 401 || r.status === 400) throw Object.assign(new Error('tracker rejected the token'), { authFailed: true });
  if (!r.ok) throw new Error(`anilist ${r.status}`);
  const j: any = await r.json();
  if (j?.errors?.length) {
    const msg = j.errors[0]?.message || 'anilist error';
    throw Object.assign(new Error(msg), { authFailed: /invalid token|unauthorized/i.test(msg) });
  }
  return j.data;
}

/** Who the token belongs to — used at connect time to show the account name and prove the token works. */
export async function whoAmI(token: string): Promise<{ id: number; name: string } | null> {
  const d = await anilist(token, 'query{Viewer{id name}}', {});
  return d?.Viewer ? { id: d.Viewer.id, name: d.Viewer.name } : null;
}

// ---- progress push ---------------------------------------------------------

const SAVE = `mutation($mediaId:Int,$progress:Int,$status:MediaListStatus){
  SaveMediaListEntry(mediaId:$mediaId,progress:$progress,status:$status){ id progress status }
}`;

/**
 * What we would tell a tracker about this series: the highest chapter number the user has *completed*,
 * and whether every chapter is done.
 *
 * Deliberately the maximum completed chapter rather than the one just finished — re-reading chapter 3 of a
 * series you're 200 chapters into must not rewind the tracker, and a backfill pushing chapters in arbitrary
 * order must converge on the same answer. Exported so this rule can be tested without calling AniList.
 */
export async function seriesProgressFor(userId: string, seriesId: string): Promise<{ chapters: number; finished: boolean }> {
  const prog = await one<{ chapters: number; total: number; done: number }>(
    `SELECT COALESCE(MAX(b.number) FILTER (WHERE rp.completed), 0)::int AS chapters,
            count(*)::int AS total,
            count(*) FILTER (WHERE rp.completed)::int AS done
       FROM lib_books b
       LEFT JOIN read_progress rp ON rp.book_id = b.id AND rp.user_id = $2
      WHERE b.series_id = $1`,
    [seriesId, userId],
  );
  return {
    chapters: prog?.chapters ?? 0,
    finished: !!prog && prog.total > 0 && prog.done === prog.total,
  };
}

/**
 * Push a series' progress for one user. Resolves the highest completed chapter rather than the chapter
 * just finished, so reading out of order (or backfilling) can't move a tracker backwards.
 */
export async function pushSeriesProgress(userId: string, seriesId: string): Promise<void> {
  const link = await one<{ external_id: string }>(
    `SELECT external_id FROM series_trackers WHERE series_id = $1 AND provider = 'anilist'`,
    [seriesId],
  );
  if (!link) return; // series was never matched to an AniList entry

  const conn = await one<{ access_token: string; expires_at: string | null }>(
    `SELECT access_token, expires_at FROM user_trackers
      WHERE user_id = $1 AND provider = 'anilist' AND enabled = true`,
    [userId],
  );
  if (!conn) return;
  if (conn.expires_at && new Date(conn.expires_at).getTime() < Date.now()) {
    await markError(userId, 'anilist', 'the access token has expired — reconnect to resume syncing');
    return;
  }
  const token = unseal(conn.access_token);
  if (!token) {
    await markError(userId, 'anilist', 'stored token could not be read — reconnect to resume syncing');
    return;
  }

  const { chapters, finished } = await seriesProgressFor(userId, seriesId);
  if (chapters <= 0) return;

  // Never push a number lower than the last one we sent. AniList takes a lower progress and rewrites the
  // entry, so a merge, a renumbered chapter or a bulk mark-unread would quietly walk someone's real reading
  // history backwards on an account this app does not own and cannot repair. Going forward is always safe;
  // going backwards needs a person to ask for it, which is what the resync endpoint is for.
  const floor = await one<{ chapters: number }>(
    `SELECT chapters FROM tracker_progress WHERE user_id = $1 AND series_id = $2 AND provider = 'anilist'`,
    [userId, seriesId],
  );
  if (floor && chapters < floor.chapters) {
    await markError(
      userId,
      'anilist',
      `not syncing: this series now works out to chapter ${chapters}, below the ${floor.chapters} already sent. ` +
        'Resync from the series page if the lower number is the correct one.',
    );
    return;
  }

  // one lane per user: a burst of completions (a binge, or the backfill) trickles out politely
  await withGate(`tracker:${userId}`, async () => {
    try {
      await anilist(token, SAVE, {
        mediaId: Number(link.external_id),
        progress: chapters,
        status: finished ? 'COMPLETED' : 'CURRENT',
      });
      await q(`UPDATE user_trackers SET last_sync_at = now(), last_error = NULL WHERE user_id=$1 AND provider='anilist'`, [userId]);
      // raise the floor only after the tracker actually accepted it
      await q(
        `INSERT INTO tracker_progress (user_id, series_id, provider, chapters, pushed_at)
         VALUES ($1, $2, 'anilist', $3, now())
         ON CONFLICT (user_id, series_id, provider)
           DO UPDATE SET chapters = GREATEST(tracker_progress.chapters, EXCLUDED.chapters), pushed_at = now()`,
        [userId, seriesId, chapters],
      );
    } catch (e) {
      const err = e as Error & { authFailed?: boolean };
      // a bad token will fail on every future chapter too — disable it rather than retry forever
      if (err.authFailed) {
        await q(`UPDATE user_trackers SET enabled=false, last_error=$2 WHERE user_id=$1 AND provider='anilist'`,
          [userId, 'the tracker rejected the saved token — reconnect to resume syncing']);
      } else {
        await markError(userId, 'anilist', err.message?.slice(0, 200) || 'sync failed');
      }
    }
  }, { concurrency: 1, minGapMs: 1200 });
}

async function markError(userId: string, provider: Provider, msg: string): Promise<void> {
  await q('UPDATE user_trackers SET last_error = $3 WHERE user_id = $1 AND provider = $2', [userId, provider, msg]).catch(() => {});
}

/** Fire-and-forget wrapper used from the reading path — must never delay or fail a page turn. */
export function pushSeriesProgressAsync(userId: string, seriesId: string): void {
  void pushSeriesProgress(userId, seriesId).catch(() => {});
}

/**
 * Forget the high-water mark for one series, so the next push is allowed to go backwards.
 *
 * The escape hatch for the case the floor exists to prevent: the tracker is ahead because the old number was
 * wrong, and the correction is the lower one. Deliberately a separate, explicit action rather than something
 * that happens automatically, because it is the only way to lower a number on someone's real account.
 */
export async function clearTrackerFloor(userId: string, seriesId: string, provider: Provider = 'anilist'): Promise<void> {
  await q(`DELETE FROM tracker_progress WHERE user_id = $1 AND series_id = $2 AND provider = $3`,
    [userId, seriesId, provider]);
}
