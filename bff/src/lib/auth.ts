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

/** Issue (or rotate) a user's OPDS token. The raw token is shown once; only its hash is stored. */
/** How long a newly issued OPDS token lasts. Long, because it lives in a reader app nobody opens often. */
export const OPDS_TOKEN_DAYS = 365;

export async function issueOpdsToken(userId: string): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  await q(
    `INSERT INTO opds_tokens (user_id, token_hash, created_at, expires_at, last_seen)
     VALUES ($1, $2, now(), now() + ($3 || ' days')::interval, NULL)
     ON CONFLICT (user_id) DO UPDATE
       SET token_hash = EXCLUDED.token_hash, created_at = now(),
           expires_at = EXCLUDED.expires_at, last_seen = NULL`,
    [userId, sha256(token), String(OPDS_TOKEN_DAYS)],
  );
  return token;
}

/** Drop a user's OPDS token. Their readers stop working immediately, which is the point. */
export async function revokeOpdsToken(userId: string): Promise<void> {
  await q('DELETE FROM opds_tokens WHERE user_id = $1', [userId]);
}

/** What the profile page shows: whether a token exists, when it expires, when a reader last used it. */
export async function opdsTokenStatus(userId: string): Promise<
  { exists: boolean; createdAt?: string; expiresAt?: string; lastSeen?: string | null; expired?: boolean }
> {
  const row = await one<{ created_at: string; expires_at: string | null; last_seen: string | null; expired: boolean }>(
    `SELECT created_at, expires_at, last_seen,
            (expires_at IS NOT NULL AND expires_at <= now()) AS expired
       FROM opds_tokens WHERE user_id = $1`,
    [userId],
  );
  if (!row) return { exists: false };
  return {
    exists: true,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? undefined,
    lastSeen: row.last_seen,
    expired: row.expired,
  };
}

/** Resolve an HTTP Basic `Authorization` header (password = the OPDS token) to a user id, or null. */
export async function resolveOpdsBasic(authHeader?: string): Promise<string | null> {
  if (!authHeader || !/^basic /i.test(authHeader)) return null;
  let decoded = '';
  try { decoded = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf8'); } catch { return null; }
  const pass = decoded.slice(decoded.indexOf(':') + 1);
  if (!pass) return null;
  // The expiry is checked in SQL rather than in JS so there is no window where a token that has just
  // expired still resolves because two clocks disagree about which one is authoritative.
  const row = await one<{ user_id: string }>(
    `SELECT user_id FROM opds_tokens
      WHERE token_hash = $1 AND (expires_at IS NULL OR expires_at > now())`,
    [sha256(pass)],
  );
  // Stamped fire-and-forget, so authenticating a reader never waits on bookkeeping -- but scoped to the
  // token hash that was actually presented. Without that condition the write can land AFTER the user has
  // regenerated their token, marking a brand-new token as already used by a request that authenticated the
  // old one.
  //
  // NOT COVERED BY A TEST, deliberately. The failure needs the stamp to land in the window between a
  // regeneration and the check, and a test that arranges that is a test that asserts on a sleep -- it would
  // pass on a fast machine and fail on a loaded one, which is how the surrounding test behaved before it was
  // rewritten. The WHERE clause costs nothing and is obviously correct; a flaky guard would cost more than
  // it proves.
  if (row) {
    q('UPDATE opds_tokens SET last_seen = now() WHERE user_id = $1 AND token_hash = $2',
      [row.user_id, sha256(pass)]).catch(() => {});
  }
  return row?.user_id ?? null;
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
  if (roleOf(request) !== 'admin') return reply.code(403).send({ error: 'forbidden' });
  // An admin's API token still needs the admin scope, so a token left in a script cannot manage the server
  // just because its owner happens to be an admin. Session logins have no tokenScopes and are unaffected.
  const scopes = (request.user as { tokenScopes?: string[] }).tokenScopes;
  if (scopes && !scopes.includes('admin')) {
    return reply.code(403).send({ error: 'forbidden', message: 'This token does not have the admin scope.' });
  }
}


// ---- long-lived API tokens -------------------------------------------------
// Automation was hostile before these: every /api/* call needed a 15-minute JWT, and the only stable
// credential (the OPDS token) reaches /opds/* and /img/* only. These are opaque, hashed at rest, revocable,
// and scoped, so a token pasted into a cron job can be read-only and cannot touch the admin API.

/** Distinctive prefix so an API token is never mistaken for (or fed to) the JWT verifier. */
export const API_TOKEN_PREFIX = 'uy_';
export const API_SCOPES = ['read', 'write', 'admin'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface ApiTokenRow {
  id: string;
  name: string;
  scopes: string[];
  createdAt: string;
  lastSeen: string | null;
  expiresAt: string | null;
  expired: boolean;
}

/** Mint a token. The raw value is returned once and never stored; only its hash is kept. */
export async function issueApiToken(
  userId: string,
  name: string,
  scopes: ApiScope[],
  expiresAt: Date | null,
): Promise<{ id: string; token: string }> {
  const token = API_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const rows = await q<{ id: string }>(
    `INSERT INTO api_tokens (user_id, name, token_hash, scopes, expires_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [userId, name, sha256(token), scopes, expiresAt],
  );
  return { id: rows[0].id, token };
}

export async function listApiTokens(userId: string): Promise<ApiTokenRow[]> {
  const rows = await q<{
    id: string; name: string; scopes: string[]; created_at: string;
    last_seen: string | null; expires_at: string | null;
  }>(
    `SELECT id, name, scopes, created_at, last_seen, expires_at
       FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    scopes: r.scopes,
    createdAt: new Date(r.created_at).toISOString(),
    lastSeen: r.last_seen ? new Date(r.last_seen).toISOString() : null,
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    expired: !!r.expires_at && new Date(r.expires_at).getTime() < now,
  }));
}

/** Scoped to the owner on purpose: a user can only revoke their own tokens. */
export async function revokeApiToken(userId: string, id: string): Promise<boolean> {
  const rows = await q<{ id: string }>(
    'DELETE FROM api_tokens WHERE id = $1 AND user_id = $2 RETURNING id',
    [id, userId],
  );
  return rows.length > 0;
}

interface ResolvedToken { id: string; userId: string; role: string; scopes: string[] }

async function resolveApiToken(raw: string): Promise<ResolvedToken | null> {
  const row = await one<{ id: string; user_id: string; scopes: string[]; expires_at: string | null; role: string }>(
    `SELECT t.id, t.user_id, t.scopes, t.expires_at, u.role
       FROM api_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1`,
    [sha256(raw)],
  );
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
  // best-effort; a failed last_seen write must not fail the request
  q('UPDATE api_tokens SET last_seen = now() WHERE id = $1', [row.id]).catch(() => {});
  return { id: row.id, userId: row.user_id, role: row.role, scopes: row.scopes };
}

/** Preflight guard usable as a route preHandler. */
export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // An API token is recognised by its prefix and resolved from the database. Everything else takes the
  // original JWT path untouched, so sessions, 2FA and refresh behave exactly as before.
  const header = request.headers.authorization;
  if (header && /^bearer /i.test(header)) {
    const raw = header.slice(7).trim();
    if (raw.startsWith(API_TOKEN_PREFIX)) {
      const tok = await resolveApiToken(raw);
      if (!tok) return reply.code(401).send({ error: 'unauthorized' });
      if (!tok.scopes.includes('write') && !SAFE_METHODS.has(request.method)) {
        return reply.code(403).send({ error: 'forbidden', message: 'This token is read-only.' });
      }
      // shaped like a verified JWT payload so userIdOf/roleOf work unchanged downstream
      (request as { user?: unknown }).user = { sub: tok.userId, role: tok.role, tokenScopes: tok.scopes };
      return;
    }
  }
  try {
    await request.jwtVerify();
  } catch {
    reply.code(401).send({ error: 'unauthorized' });
  }
}
