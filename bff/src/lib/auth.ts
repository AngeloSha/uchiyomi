import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { q, one } from './db';
import { env } from '../env';

export const REFRESH_COOKIE = 'yomi_rt';
// Stateless JWT cookie that authorizes <img> requests to /img/* (which can't send a Bearer header).
export const IMG_COOKIE = 'yomi_img';
export const IMG_COOKIE_TTL = 7 * 24 * 60 * 60;

// secure:'auto' => Secure over HTTPS, but still delivered over plain HTTP so images
// (which rely on the cookie) don't silently break before Force-SSL is enabled.
export function cookieOptions() {
  return {
    httpOnly: true,
    secure: 'auto' as const,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: env.REFRESH_TTL_DAYS * 24 * 60 * 60,
  };
}

export function imgCookieOptions() {
  return { httpOnly: true, secure: 'auto' as const, sameSite: 'lax' as const, path: '/', maxAge: IMG_COOKIE_TTL };
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Issue a fresh opaque refresh token and persist its hash. Returns the raw token. */
export async function issueRefreshToken(
  userId: string,
  opts: { deviceId?: string; deviceName?: string; ip?: string | null; userAgent?: string | null } = {},
): Promise<string> {
  const token = randomBytes(48).toString('hex');
  const expires = new Date(Date.now() + env.REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
  await q(
    `INSERT INTO refresh_tokens (user_id, token_hash, device_id, device_name, expires_at, ip, user_agent, last_seen)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
    [userId, sha256(token), opts.deviceId ?? null, opts.deviceName ?? null, expires, opts.ip ?? null, (opts.userAgent ?? null)?.slice(0, 200) ?? null],
  );
  return token;
}

/** Validate a refresh token; returns the owning user id + device info, or null. */
export async function validateRefreshToken(
  token: string,
): Promise<{ userId: string; id: string; deviceId: string | null; deviceName: string | null } | null> {
  const row = await one<{ id: string; user_id: string; device_id: string | null; device_name: string | null }>(
    `SELECT id, user_id, device_id, device_name FROM refresh_tokens
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
     LIMIT 1`,
    [sha256(token)],
  );
  return row ? { userId: row.user_id, id: row.id, deviceId: row.device_id, deviceName: row.device_name } : null;
}

// ---- account security: brute-force lockout + password policy ----
export const PASSWORD_MIN = 8;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export function passwordError(pw: string): string | null {
  return !pw || pw.length < PASSWORD_MIN ? `Password must be at least ${PASSWORD_MIN} characters.` : null;
}

/** Bump the failed-login counter; lock the account once it crosses the threshold. Returns whether now locked. */
export async function recordFailedLogin(userId: string): Promise<boolean> {
  const row = await one<{ failed_logins: number }>(
    `UPDATE users SET failed_logins = failed_logins + 1,
       locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
     WHERE id = $1 RETURNING failed_logins`,
    [userId, MAX_FAILED, LOCK_MINUTES],
  );
  return (row?.failed_logins ?? 0) >= MAX_FAILED;
}
export const resetFailedLogins = (userId: string) =>
  q('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [userId]);

/** Returns the unlock time if the account is currently locked, else null. */
export function lockedUntil(user: { locked_until?: string | Date | null }): Date | null {
  if (!user.locked_until) return null;
  const t = new Date(user.locked_until);
  return t.getTime() > Date.now() ? t : null;
}

// ---- sessions / devices ----
export const touchSession = (id: string, ip?: string | null, ua?: string | null) =>
  q('UPDATE refresh_tokens SET last_seen = now(), ip = COALESCE($2, ip), user_agent = COALESCE($3, user_agent) WHERE id = $1', [id, ip ?? null, (ua ?? null)?.slice(0, 200) ?? null]).catch(() => {});
export const listSessions = (userId: string) =>
  q(`SELECT id, device_name, device_id, ip, user_agent, created_at, last_seen FROM refresh_tokens
     WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen DESC`, [userId]);
export const revokeSessionForUser = (userId: string, id: string) =>
  q('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [id, userId]);
export const revokeAllSessions = (userId: string, exceptId?: string) =>
  q(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL${exceptId ? ' AND id <> $2' : ''}`,
    exceptId ? [userId, exceptId] : [userId]);

/** Client IP from the proxy chain. */
export function clientIp(req: FastifyRequest): string | null {
  const xff = (req.headers['x-forwarded-for'] as string) || '';
  return (xff.split(',')[0].trim() || req.ip || '').slice(0, 64) || null;
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await q(`UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [
    sha256(token),
  ]);
}

export async function revokeRefreshTokenById(id: string): Promise<void> {
  await q(`UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, [id]);
}

/** Pull the authenticated user id out of a verified JWT. */
export function userIdOf(request: FastifyRequest): string {
  return (request.user as { sub: string }).sub;
}

export function roleOf(request: FastifyRequest): string {
  return (request.user as { role?: string }).role || 'user';
}

/** Route guard: 403 unless the verified user is an admin. Run after `authenticate`. */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (roleOf(request) !== 'admin') reply.code(403).send({ error: 'forbidden' });
}

/** Preflight guard usable as a route preHandler. */
export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    reply.code(401).send({ error: 'unauthorized' });
  }
}
