// Health: "Tracker sync" (v0.72.0, @Squeaks72's card from #253).
//
// Every member sees their own tracker connections under Profile → Connections -- a sign-in the tracker refused, the
// last sync's error, a sign-in ending within 30 days (lib/trackers.ts statusFor) -- and nobody saw them across members.
// An AniList sign-in lasts a year and cannot be renewed, so a member who never opens Profile found out when their list
// had stopped moving for weeks. This is the admin's roll-up: whose, which tracker, what is wrong. Only the member can
// sign in again, so nothing here acts on it, and Fix everything lists it under Needs you.
//
// A tracker is named by its adapter (lib/trackerProviders.ts), never by a list of this card's own, so a tracker added
// later is named here without touching this file. Ignoring a finding records what was wrong (`members`), so an ignored
// "ends in ten days" does not silence "the tracker refused the sign-in". Reintroduce empty members: "ignoring an ending
// sign-in does not silence a refused one" in healthTrackers.int.test.ts finds the refusal quiet.
import { q } from './db';
import { ADAPTERS } from './trackerProviders';
import { applyIgnores, noIgnores, type IgnoreCtx } from './healthIgnore';
import { DAY_MS, ignoredPart, hiddenPart, truncate, verdict } from './healthKit';
import { detailOf, joined, noteOf, say, summaryOf, type Part } from './said';
import type { HealthCheck, HealthItem } from './health';
import { isRateLimitedError } from './trackerPace';

/** A sign-in ending this soon is a finding. */
const SOON_MS = 14 * DAY_MS;
/** And this soon, listed for reference: the Connections tab's own "expires soon" (lib/trackers.ts EXPIRY_WARN_DAYS). */
const HEADS_UP_MS = 30 * DAY_MS;

/** A tracker by its adapter's name; the stored id for one this build has no adapter for. */
const trackerName = (provider: string): string =>
  (ADAPTERS as Record<string, { label: string } | undefined>)[provider]?.label ?? provider;

export async function trackerSync(ctx: IgnoreCtx = noIgnores()): Promise<HealthCheck> {
  const rows = await q<{
    user_id: string; provider: string; username: string; enabled: boolean; expires_at: Date | null; last_error: string | null;
  }>(
    `SELECT t.user_id, t.provider, u.username, t.enabled, t.expires_at, t.last_error
       FROM user_trackers t JOIN users u ON u.id = t.user_id
      ORDER BY t.provider, u.username`,
  );
  const now = Date.now();
  const all: Array<HealthItem & { members?: string[] }> = [];
  for (const r of rows) {
    const left = r.expires_at ? new Date(r.expires_at).getTime() - now : null;
    const at = r.expires_at ? new Date(r.expires_at).toISOString() : '';
    // A refused sign-in's error is our own "reconnect" line (lib/trackers.ts syncFailed): the refusal says it. A tracker
    // that asked us to wait (v0.73.0, lib/trackerPace.ts) is a pace the next push clears, not a finding for an admin.
    // Reintroduce by counting it: "a 429 that does not end" in anilistQuota.int.test.ts finds the member listed.
    const failed = r.enabled && !!r.last_error && !isRateLimitedError(r.last_error);
    const ended = left !== null && left <= 0;
    const ending = left !== null && left > 0 && left <= HEADS_UP_MS;
    // Side by side, each its own sentence: "The tracker refused the saved sign-in · The sign-in ends 3 Nov".
    const parts: Part[] = [
      ...(!r.enabled ? [say('trackers.refused')] : []),
      ...(failed ? [say('trackers.failed', { error: r.last_error!.slice(0, 200) })] : []),
      ...(ended ? [say('trackers.ended', { at })] : ending ? [say('trackers.ending', { at })] : []),
    ].map((p, i) => (i ? joined('dot', p) : p));
    if (!parts.length) continue;
    const finding = !r.enabled || failed || ended || (ending && left! <= SOON_MS);
    all.push({
      title: `${trackerName(r.provider)} · ${r.username}`,
      ...detailOf(parts),
      key: `${r.provider}:${r.user_id}`,
      members: parts.map((p) => p.code),
      ...(finding ? {} : { info: true }),
    });
  }
  const ignored = applyIgnores('trackers', all, ctx);
  const live = all.filter((i) => !i.info).length;
  const { items, hidden } = truncate(all);
  return {
    id: 'trackers',
    title: 'Tracker sync',
    status: verdict(all),
    ...summaryOf([
      live ? say('trackers.live', { n: live }) : rows.length ? say('trackers.fine', { n: rows.length }) : say('trackers.none'),
      ignoredPart(ignored),
    ]),
    ...noteOf([say('trackers.note'), hiddenPart(hidden)]),
    items,
  };
}
