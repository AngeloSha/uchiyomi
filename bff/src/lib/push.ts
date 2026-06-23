// Web Push (VAPID) notifications for new chapters. No-ops gracefully when VAPID keys aren't configured.
const webpush = require('web-push');
import { q } from './db';
import { env } from '../env';

const enabled = !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
if (enabled) {
  try {
    webpush.setVapidDetails(env.VAPID_SUBJECT || 'mailto:admin@koryomi.app', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  } catch { /* bad keys → leave disabled at send time */ }
}

export function pushEnabled(): boolean { return enabled; }
export function vapidPublicKey(): string { return env.VAPID_PUBLIC_KEY; }

export async function saveSubscription(userId: string, sub: { endpoint: string; keys: { p256dh: string; auth: string } }, deviceId?: string): Promise<void> {
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
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body);
    } catch (e: any) {
      // 404/410 = subscription gone → prune it so we stop trying
      if (e?.statusCode === 404 || e?.statusCode === 410) await q('DELETE FROM push_subscriptions WHERE endpoint = $1', [s.endpoint]).catch(() => {});
    }
  }));
}

/** Notify everyone who favorited a series that it got new chapter(s). Fire-and-forget from the updater. */
export async function notifyNewChapter(seriesId: string, title: string, addedCount: number): Promise<void> {
  if (!enabled) return;
  const users = await q<{ user_id: string }>('SELECT user_id FROM favorites WHERE series_id = $1', [seriesId]);
  if (!users.length) return;
  const payload = {
    title,
    body: addedCount > 1 ? `${addedCount} new chapters available` : 'A new chapter is available',
    url: `/series/?id=${seriesId}`,
    tag: `series-${seriesId}`,
  };
  await Promise.all(users.map((u) => sendToUser(u.user_id, payload)));
}
