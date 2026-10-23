// The accounts one device remembers: the device keyring.
//
// A sign-in that ticks "Remember on this device" leaves its session here, by device, so the device can take it up
// again later without the password -- from the sign-in screen, or from the profile photo while someone else is signed
// in. It is several "stay signed in" cookies rather than one, and no more than that: the device is named by a cookie of
// its own (`yomi_dev`, httpOnly, sent to /auth only), only its hash is stored, and an entry opens only while its
// session is live. Signing out, a revoke, sign-out everywhere, a password change or a disable end the session and so
// the entry with it. Opt-in, so a shared tablet remembers nobody nobody asked it to.
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { q } from './db';
import { env } from '../env';

export const DEVICE_COOKIE = 'yomi_dev';
/** An admin remembered on a device is asked for its password again once its session is this old. */
export const ADMIN_RESUME_HOURS = 12;

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const KEY = /^[0-9a-f]{64}$/;

/** The device cookie: as long-lived as a refresh token, and sent to the sign-in routes alone. */
export const deviceCookieOptions = () => ({
  httpOnly: true, secure: 'auto' as const, sameSite: 'lax' as const, path: '/auth', maxAge: env.REFRESH_TTL_DAYS * 24 * 60 * 60,
});

/** This device's key, from its cookie; null when it has none, or something that is not one. */
export function deviceKeyOf(req: FastifyRequest): string | null {
  const v = req.cookies?.[DEVICE_COOKIE];
  return v && KEY.test(v) ? v : null;
}

/** This device's key, made and set on the answer when it has none yet. */
export function ensureDeviceKey(req: FastifyRequest, reply: FastifyReply): string {
  const have = deviceKeyOf(req);
  if (have) return have;
  const made = randomBytes(32).toString('hex');
  reply.setCookie(DEVICE_COOKIE, made, deviceCookieOptions());
  return made;
}

/** Remember this session on this device: one entry per account, the newest session. */
export async function rememberSession(deviceKey: string, userId: string, sessionId: string): Promise<void> {
  await q(
    `INSERT INTO device_ring (device_hash, user_id, session_id) VALUES ($1, $2, $3)
     ON CONFLICT (device_hash, user_id) DO UPDATE SET session_id = EXCLUDED.session_id, added_at = now(), last_used = NULL`,
    [sha(deviceKey), userId, sessionId]);
}

export interface Remembered {
  userId: string; displayName: string; avatar: unknown; role: string;
  /** How the session was entered (refresh_tokens.via): one entered without a credential holds at home only. */
  via: string | null;
  /** When the session was first signed in, for ADMIN_RESUME_HOURS. */
  startedAt: Date | null;
  /** The session's live token: what a resume supersedes. */
  head: { id: string; expiresAt: Date; deviceId: string | null; deviceName: string | null };
}

/** What this device remembers that still opens -- a live session of an enabled account -- or the one entry for `userId`. */
export async function ringOf(deviceKey: string, userId?: string): Promise<Remembered[]> {
  const rows = await q<{
    user_id: string; display_name: string; avatar: unknown; role: string; via: string | null; started_at: Date | null;
    head_id: string; expires_at: Date; device_id: string | null; device_name: string | null;
  }>(
    `SELECT r.user_id, u.display_name, u.avatar, u.role, h.via, s.created_at AS started_at,
            h.id AS head_id, h.expires_at, h.device_id, h.device_name
       FROM device_ring r
       JOIN users u ON u.id = r.user_id AND NOT u.disabled
       JOIN refresh_tokens h ON h.session_id = r.session_id AND h.revoked_at IS NULL AND h.expires_at > now()
       LEFT JOIN refresh_tokens s ON s.id = r.session_id
      WHERE r.device_hash = $1 AND ($2::uuid IS NULL OR r.user_id = $2)
      ORDER BY r.added_at, r.user_id`,
    [sha(deviceKey), userId ?? null]);
  return rows.map((r) => ({
    userId: r.user_id, displayName: r.display_name, avatar: r.avatar, role: r.role, via: r.via, startedAt: r.started_at,
    head: { id: r.head_id, expiresAt: r.expires_at, deviceId: r.device_id, deviceName: r.device_name },
  }));
}

/** Whether this session is the one this device remembers for its account. */
export async function isRemembered(deviceKey: string, sessionId: string): Promise<boolean> {
  return (await q('SELECT 1 FROM device_ring WHERE device_hash = $1 AND session_id = $2', [sha(deviceKey), sessionId])).length > 0;
}

export async function noteResumed(deviceKey: string, userId: string): Promise<void> {
  await q('UPDATE device_ring SET last_used = now() WHERE device_hash = $1 AND user_id = $2', [sha(deviceKey), userId]);
}

export async function forgetRemembered(deviceKey: string, userId: string): Promise<void> {
  await q('DELETE FROM device_ring WHERE device_hash = $1 AND user_id = $2', [sha(deviceKey), userId]);
}

/** The entries whose session has ended, every day beside the audit prune (server.ts). They open nothing meanwhile. */
export async function pruneRing(): Promise<void> {
  await q(`DELETE FROM device_ring r WHERE NOT EXISTS (
             SELECT 1 FROM refresh_tokens h WHERE h.session_id = r.session_id AND h.revoked_at IS NULL AND h.expires_at > now())`);
}
