import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { q, one } from './db';
import { env } from '../env';
import { isDesktop } from './desktop';

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
  { exists: boolean; createdAt?: string; expiresAt?: string; lastSeen?: string | null; expired?: boolean; showAdult?: boolean }
> {
  const row = await one<{ created_at: string; expires_at: string | null; last_seen: string | null; expired: boolean; show_adult: boolean }>(
    `SELECT created_at, expires_at, last_seen, show_adult,
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
    showAdult: row.show_adult,
  };
}

/**
 * Let this reader list 18+ libraries, or stop it.
 *
 * On the credential rather than the account, because the two things a person points at this feed -- the
 * phone in their pocket and the e-reader on the shelf -- are different audiences. Returns false when there
 * is no token to set it on, so the route can say so rather than silently succeeding.
 */
export async function setOpdsShowAdult(userId: string, on: boolean): Promise<boolean> {
  const r = await q<{ user_id: string }>(
    'UPDATE opds_tokens SET show_adult = $2 WHERE user_id = $1 RETURNING user_id', [userId, on],
  );
  return r.length > 0;
}

/** Who an OPDS credential belongs to, and the one thing it is allowed to say about how it wants to browse. */
export interface OpdsIdentity { userId: string; showAdult: boolean }

/**
 * Resolve an HTTP Basic `Authorization` header (password = the OPDS token) to its owner, or null.
 *
 * Returns the identity object rather than a bare id because the token carries a browsing preference of its
 * own (`show_adult`), and a reader has no other channel to express one: no session, no query parameter
 * the app controls, no button. Callers that only want the id read `.userId`.
 */
export async function resolveOpdsBasic(authHeader?: string): Promise<OpdsIdentity | null> {
  // Desktop has no OPDS: a token that arrived inside a restored server database must not open /img/ either.
  if (isDesktop()) return null;
  if (!authHeader || !/^basic /i.test(authHeader)) return null;
  let decoded = '';
  try { decoded = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf8'); } catch { return null; }
  const pass = decoded.slice(decoded.indexOf(':') + 1);
  if (!pass) return null;
  // The expiry is checked in SQL rather than in JS so there is no window where a token that has just
  // expired still resolves because two clocks disagree about which one is authoritative.
  //
  // `NOT u.disabled`, like TOKEN_SELECT below: disabling an account revoked its refresh sessions and (since
  // v0.38.0) its API tokens, but the OPDS token -- the one credential with no scopes, typed once into an
  // e-reader and never looked at again -- kept opening /opds and every /img byte route for as long as it
  // lived. A disabled account must lose every credential at once. Reintroduce by dropping the JOIN and the
  // clause: "a disabled owner's OPDS token opens neither the feed nor a page" in opdsToken.int.test.ts sees 200.
  const row = await one<{ user_id: string; show_adult: boolean }>(
    `SELECT t.user_id, t.show_adult FROM opds_tokens t JOIN users u ON u.id = t.user_id
      WHERE NOT u.disabled AND t.token_hash = $1 AND (t.expires_at IS NULL OR t.expires_at > now())`,
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
  return row ? { userId: row.user_id, showAdult: !!row.show_adult } : null;
}

/**
 * Issue a fresh opaque refresh token and persist its hash. Returns the raw token.
 *
 * `replaces` marks this as a rotation: the old row is revoked and pointed at the new one. Rotating through
 * here rather than with a bare revoke is what lets `validateRefreshForRotation` tell a device that simply
 * moved on from a session someone deliberately ended.
 */
/**
 * When a refresh token minted right now would expire, in ms since the epoch.
 *
 * Published to the client so an installed app can honour the SAME expiry offline that the server would
 * enforce online. It cannot work this out for itself: `REFRESH_TTL_DAYS` is an operator setting, and the
 * cookie carrying the token is httpOnly, so the browser can neither read it nor see its lifetime. Hardcoding
 * 60 days in the frontend would silently disagree with any operator who changed it.
 */
export const refreshExpiresAt = () => Date.now() + env.REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000;

export async function issueRefreshToken(
  userId: string,
  opts: { deviceId?: string; deviceName?: string; ip?: string | null; userAgent?: string | null; replaces?: string } = {},
): Promise<string> {
  const token = randomBytes(48).toString('hex');
  const expires = new Date(refreshExpiresAt());
  const row = await one<{ id: string }>(
    `INSERT INTO refresh_tokens (user_id, token_hash, device_id, device_name, expires_at, ip, user_agent, last_seen)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     RETURNING id`,
    [userId, sha256(token), opts.deviceId ?? null, opts.deviceName ?? null, expires, opts.ip ?? null, (opts.userAgent ?? null)?.slice(0, 200) ?? null],
  );
  if (opts.replaces) {
    await q('UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1 AND revoked_at IS NULL',
      [opts.replaces, row!.id]);
  }
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

/**
 * How long a token this device just rotated away still answers a refresh.
 *
 * One browser is one cookie jar, but it runs several refresh timers over it: every mounted AuthProvider
 * refreshes on load and then every twelve minutes, and the service worker refreshes on its own for background
 * sync. Two tabs left open collide on that schedule forever. The loser's request was already in flight
 * carrying the token the winner had just rotated, and answering it by clearing the cookie deleted the good
 * token the winner had written one moment earlier -- signing out the tab, the other tab, and the device.
 */
export const REFRESH_GRACE_MS = 60_000;

/**
 * Validate for the refresh endpoint, which forgives a token this device rotated a moment ago.
 *
 * `stale` marks the loser of that race. Only a ROTATED token qualifies, because only a rotation sets
 * `replaced_by`: a token killed by logout, by an admin, or by sign-out-everywhere has it null and is refused
 * on the spot, so ending a session still means ending it.
 */
export async function validateRefreshForRotation(
  token: string,
  graceMs: number = REFRESH_GRACE_MS,
): Promise<{ userId: string; id: string; deviceId: string | null; deviceName: string | null; stale: boolean; expiresAt: Date } | null> {
  const row = await one<{ id: string; user_id: string; device_id: string | null; device_name: string | null; revoked_at: Date | null; expires_at: Date }>(
    `SELECT id, user_id, device_id, device_name, revoked_at, expires_at FROM refresh_tokens
     WHERE token_hash = $1
       AND expires_at > now()
       AND (revoked_at IS NULL
            OR (replaced_by IS NOT NULL AND revoked_at > now() - make_interval(secs => $2)))
     LIMIT 1`,
    [sha256(token), graceMs / 1000],
  );
  if (!row) return null;
  return {
    userId: row.user_id, id: row.id, deviceId: row.device_id, deviceName: row.device_name,
    stale: row.revoked_at != null,
    // ⚠️ The row's OWN expiry, for the stale-race branch in routes/auth.ts, which rotates nothing. Answering
    // that branch with `refreshExpiresAt()` would hand the device a full fresh TTL every time two tabs raced
    // -- an offline grace that renews itself without a single token ever being issued.
    expiresAt: row.expires_at,
  };
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

/**
 * Client IP from the proxy chain.
 *
 * ⚠️ This reads X-Forwarded-For whatever `trustProxy` is set to. On the desktop app nothing sits in front of the
 * server, so a forwarded-for header there is only ever one a local process invented, and it is ignored.
 */
export function clientIp(req: FastifyRequest): string | null {
  const xff = isDesktop() ? '' : (req.headers['x-forwarded-for'] as string) || '';
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
/**
 * Routes that are a POST only because their input is a JSON body, not because they change anything. A
 * read-only token may use them: the whole point of the `read` scope is "this credential can look but not
 * touch", and a search that takes a filter tree is looking. Keyed on the route *pattern* (not the request
 * URL) so a query string cannot dress a mutation up as one of these.
 */
const READ_SHAPED_POSTS = new Set(['/api/series/search']);

export interface ApiTokenRow {
  id: string;
  name: string;
  scopes: string[];
  createdAt: string;
  lastSeen: string | null;
  expiresAt: string | null;
  expired: boolean;
  /** Whether the Komga-compatible API lists 18+ libraries to this token. See `show_adult` in migrate.ts. */
  showAdult: boolean;
}

/**
 * Mint a token. The raw value is returned once and never stored; only its hash is kept.
 *
 * `showAdult` mirrors the OPDS token's flag: the Komga-compatible API is another feed a client cannot filter,
 * so whether 18+ libraries appear in its listings is decided on the credential, off by default.
 */
export async function issueApiToken(
  userId: string,
  name: string,
  scopes: ApiScope[],
  expiresAt: Date | null,
  showAdult = false,
): Promise<{ id: string; token: string }> {
  const token = API_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const rows = await q<{ id: string }>(
    `INSERT INTO api_tokens (user_id, name, token_hash, scopes, expires_at, show_adult)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [userId, name, sha256(token), scopes, expiresAt, showAdult],
  );
  return { id: rows[0].id, token };
}

export async function listApiTokens(userId: string): Promise<ApiTokenRow[]> {
  const rows = await q<{
    id: string; name: string; scopes: string[]; created_at: string;
    last_seen: string | null; expires_at: string | null; show_adult: boolean;
  }>(
    `SELECT id, name, scopes, created_at, last_seen, expires_at, show_adult
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
    showAdult: !!r.show_adult,
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

export interface ResolvedToken {
  id: string;
  userId: string;
  role: string;
  scopes: string[];
  /** The token's own 18+ listing preference (api_tokens.show_adult); a surfacing choice, not a permission. */
  showAdult: boolean;
  /** When the row expires, so a session cookie derived from it can be capped to the same instant. */
  expiresAt: Date | null;
}

type TokenRow = { id: string; user_id: string; scopes: string[]; expires_at: string | null; role: string; show_adult: boolean };

/**
 * The one SELECT behind both resolvers, so the two can never disagree about what makes a token usable.
 *
 * `AND NOT u.disabled`: disabling an account revokes its refresh sessions and nothing else, so its API tokens
 * -- and now the Komga session cookies minted from them -- kept working for as long as they lived. A disabled
 * account must lose every credential at once; this is the one place API tokens are turned into a subject
 * (OPDS tokens have their own SELECT in resolveOpdsBasic above, with the same clause for the same reason).
 * Reintroduce by dropping the clause: "a disabled account's token and cookie both stop working" in
 * komgaCompat.int.test.ts sees 200.
 */
const TOKEN_SELECT = `SELECT t.id, t.user_id, t.scopes, t.expires_at, t.show_adult, u.role
       FROM api_tokens t JOIN users u ON u.id = t.user_id
      WHERE NOT u.disabled AND `;

function resolved(row: TokenRow | null): ResolvedToken | null {
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
  // best-effort; a failed last_seen write must not fail the request
  q('UPDATE api_tokens SET last_seen = now() WHERE id = $1', [row.id]).catch(() => {});
  return {
    id: row.id, userId: row.user_id, role: row.role, scopes: row.scopes, showAdult: !!row.show_adult,
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
  };
}

export async function resolveApiToken(raw: string): Promise<ResolvedToken | null> {
  // API tokens are hidden on desktop (owner decision): one arriving in a restored server database opens nothing.
  if (isDesktop()) return null;
  return resolved(await one<TokenRow>(`${TOKEN_SELECT} t.token_hash = $1`, [sha256(raw)]));
}

/**
 * The same resolution by row id, for the Komga session cookie (lib/komgaSession.ts), which names the row
 * rather than carrying the secret. Re-read on EVERY cookie use: that is what makes revoking the token, letting
 * it expire, or disabling the account end the cookie too, with no session table and no revocation list.
 */
export async function resolveApiTokenById(id: string): Promise<ResolvedToken | null> {
  if (isDesktop()) return null;
  // A uuid column; anything else is a cast error in Postgres, and a malformed id is simply not a token.
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return resolved(await one<TokenRow>(`${TOKEN_SELECT} t.id = $1`, [id]));
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
      const readShaped = SAFE_METHODS.has(request.method)
        || (request.method === 'POST' && READ_SHAPED_POSTS.has(request.routeOptions?.url ?? ''));
      if (!tok.scopes.includes('write') && !readShaped) {
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
    return reply.code(401).send({ error: 'unauthorized' });
  }
  // ⚠️ A verified signature is not enough. Every JWT this server signs uses the same secret, and only the
  // ACCESS token is meant to open /api/*: the `yomi_img` cookie ({ sub, typ: 'img' }, routes/auth.ts) and the
  // OIDC ticket ({ typ: 'oidc', ... }) verified here just as well, so a seven-day httpOnly image cookie
  // pasted into an Authorization header was a full API session. Access tokens carry no `typ` claim
  // (signAccess in routes/auth.ts), so any payload that has one was minted for something else.
  // Reintroduce by dropping this check: "a yomi_img cookie value is not an API session" in
  // komgaCompat.int.test.ts sees 200.
  if ((request.user as { typ?: unknown })?.typ !== undefined) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
}
