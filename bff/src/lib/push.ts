// Web Push (VAPID) notifications for new chapters. No-ops gracefully when VAPID keys aren't configured.
const webpush = require('web-push');
import { parse as legacyUrlParse } from 'node:url';
import { q } from './db';
import { env } from '../env';
import { viewCtxFor, seriesVisible } from './visibility';
import { wantsNews } from './nextUp';
import { assertPublicHost, BlockedAddress } from './ssrfGuard';
import { conversationRecipients, conversationPush } from './comments';
// A cycle, and a safe one: notify/index.ts calls notifyAdmins back when it switches a failing target off, and
// both sides only ever touch the other inside a function body, never while the modules load.
import { notifyTargetsOfHealth } from './notify';

const enabled = !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
if (enabled) {
  try {
    webpush.setVapidDetails(env.VAPID_SUBJECT || 'mailto:admin@uchiyomi.com', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  } catch { /* bad keys → leave disabled at send time */ }
}

export function pushEnabled(): boolean { return enabled; }
export function vapidPublicKey(): string { return env.VAPID_PUBLIC_KEY; }

/**
 * A push endpoint is a URL the SERVER will POST to on a member's behalf, so it gets the cover proxy's rule: https only,
 * and only a host on the public internet (ssrfGuard.assertPublicHost). Checked when it is stored AND before every send:
 * DNS can change in between, and rows saved before this check existed are still in the table.
 *
 * web-push dials what the legacy url.parse() reads, which is not always what WHATWG URL reads: https://2130706433/,
 * https://127.1/ and https://0x7f.1/ are 127.0.0.1 to the one and a bare name to the other. An endpoint the two
 * parsers disagree on is refused, so the host that is checked is the host that is dialled. Reintroduce by removing the
 * call in saveSubscription: pushGuards.int.test.ts subscribes a loopback endpoint with 200.
 */
export async function assertPushEndpoint(endpoint: string): Promise<void> {
  let u: URL, dialled: string;
  try {
    u = new URL(endpoint);
    dialled = legacyUrlParse(endpoint).hostname ?? '';
  } catch { throw new BlockedAddress(endpoint); }
  const bare = (h: string) => h.replace(/^\[|\]$/g, '');
  if (u.protocol !== 'https:' || bare(dialled) !== bare(u.hostname)) throw new BlockedAddress(u.host);
  await assertPublicHost(u.hostname);
}

export async function saveSubscription(userId: string, sub: { endpoint: string; keys: { p256dh: string; auth: string } }, deviceId?: string): Promise<void> {
  await assertPushEndpoint(sub.endpoint);
  await q(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device_id) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, device_id = EXCLUDED.device_id`,
    [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, deviceId ?? null],
  );
}

export async function removeSubscription(userId: string, endpoint: string): Promise<void> {
  await q('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [userId, endpoint]);
}

async function sendToUser(userId: string, payload: object): Promise<void> {
  if (!enabled) return;
  const subs = await q<{ endpoint: string; p256dh: string; auth: string }>(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1', [userId]);
  const body = JSON.stringify(payload);
  await Promise.all(subs.map(async (s) => {
    try {
      await assertPushEndpoint(s.endpoint); // a refused endpoint throws here and is never dialled
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body);
    } catch (e: any) {
      // 404/410 = subscription gone → prune it so we stop trying.
      // A refused endpoint (BlockedAddress) is skipped and left in place, never deleted: assertPublicHost throws it for a
      // DNS lookup that merely failed too, and the web client does not register a subscription again once the server
      // has dropped it, so deleting here would silently end a real device's notifications after one resolver failure.
      if (e?.statusCode === 404 || e?.statusCode === 410) await q('DELETE FROM push_subscriptions WHERE endpoint = $1', [s.endpoint]).catch(() => {});
    }
  }));
}

/**
 * Notify everyone who favorited a series that it got new chapter(s). Fire-and-forget from the updater. `numbers`: the
 * chapters that landed, for the accounts that only want the one they would read next (lib/nextUp.ts); without them
 * everyone who favorited it is told.
 */
export async function notifyNewChapter(seriesId: string, title: string, addedCount: number, numbers?: readonly number[]): Promise<void> {
  if (!enabled) return;
  const fans = await q<{ user_id: string; role: string }>(
    `SELECT f.user_id, u.role FROM favorites f JOIN users u ON u.id = f.user_id WHERE f.series_id = $1 AND NOT u.disabled`, [seriesId]);
  // Each recipient judged under their own view, at send time: a favourite says nothing about whether this member may
  // open the series now (a library taken away, an age cap lowered, a favourite planted by id), and the notification
  // names it. visible(), the permission, not the 18+ surfacing switch: a push has no per-device switch. A failed
  // lookup sends nothing. Reintroduce by sending to every favourite: pushGuards.int.test.ts delivers the hidden
  // title to the member granted another library.
  const users: Array<{ user_id: string }> = [];
  for (const f of fans) {
    const ok = await viewCtxFor(f.user_id, f.role).then((ctx) => seriesVisible(seriesId, ctx)).catch(() => false);
    if (!ok) continue;
    // An account that asked to hear only about the chapter it would read next (lib/nextUp.ts) is told only when one of these is it.
    if (!(await wantsNews(f.user_id, seriesId, numbers))) continue;
    users.push({ user_id: f.user_id });
  }
  if (!users.length) return;
  const payload = {
    title,
    body: addedCount > 1 ? `${addedCount} new chapters available` : 'A new chapter is available',
    url: `/series/?id=${seriesId}`,
    tag: `series-${seriesId}`,
  };
  await Promise.all(users.map((u) => sendToUser(u.user_id, payload)));
}

/**
 * A new comment on a chapter (v0.87.0), to the members already in that chapter's conversation and nobody else -- the
 * owner's ruling. Who they are, and that each may still open the series, is lib/comments.ts conversationRecipients's
 * call; this only sends. Fire-and-forget from the comment route: a push is never what a comment waits on.
 */
export async function notifyConversation(o: { bookId: string; authorId: string; author: string; seriesId: string; seriesTitle: string; chapter: string; body: string }): Promise<void> {
  if (!enabled) return;
  const users = await conversationRecipients(o.bookId, o.authorId);
  if (!users.length) return;
  const payload = conversationPush(o);
  await Promise.all(users.map((u) => sendToUser(u, payload)));
}

/**
 * Tell the operators something needs a decision.
 *
 * Admins only: these messages name sources, and the action they ask for lives behind Admin. A household
 * reader cannot act on "ManhuaUS is refusing this server" and should not be woken up for it.
 */
export async function notifyAdmins(title: string, body: string, url = '/admin/', tag = 'sources'): Promise<void> {
  // ⚠️ BEFORE the VAPID early return, and not awaited. The notification targets (lib/notify, #70) have
  // nothing to do with VAPID, and an install whose keys could not be written to a read-only /config is the
  // install that most needs another channel -- inside the return below, every target would be silently dead.
  // Not awaited because a target can take ten seconds and a retry to answer, and the callers (the source
  // watchdog, the extension monitor, the solver watch) should not wait on a webhook.
  // Reintroduce by moving this line under `if (!enabled) return;`: "a health notice reaches a target on an
  // install without push" in notifyTargets.int.test.ts never sees it arrive.
  void notifyTargetsOfHealth(title, body).catch(() => {});
  if (!enabled) return;
  const users = await q<{ id: string }>("SELECT id FROM users WHERE role = 'admin'").catch(() => []);
  await Promise.all(users.map((u) => sendToUser(u.id, { title, body, url, tag })));
}
