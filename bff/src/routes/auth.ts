import { verify, hash } from '@node-rs/argon2';
import QRCode from 'qrcode';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../env';
import { one, q } from '../lib/db';
import { logAudit } from '../lib/audit';
import {
  IMG_COOKIE,
  IMG_COOKIE_TTL,
  REFRESH_COOKIE,
  authenticate,
  clientIp,
  cookieOptions,
  imgCookieOptions,
  issueRefreshToken,
  listSessions,
  lockedUntil,
  passwordError,
  recordFailedLogin,
  resetFailedLogins,
  revokeAllSessions,
  revokeRefreshToken,
  revokeRefreshTokenById,
  revokeSessionForUser,
  touchSession,
  userIdOf,
  validateRefreshToken,
} from '../lib/auth';
import { generateRecoveryCodes, generateSecret, otpauthURL, sha256, verifyTotp } from '../lib/totp';
import { oidcEnabled, oidcName, beginLogin, completeLogin, isAdminByGroup, type OidcClaims } from '../lib/oidc';
import { randomBytes } from 'crypto';

const loginBody = z.object({
  username: z.string().max(64).optional(),
  password: z.string().min(1),
  code: z.string().max(16).optional(), // TOTP or recovery code
  deviceId: z.string().max(128).optional(),
  deviceName: z.string().max(128).optional(),
});

interface FullUser {
  id: string;
  username: string | null;
  display_name: string;
  role: string;
  password_hash: string;
  disabled: boolean;
  locked_until: string | null;
  totp_enabled: boolean;
  totp_secret: string | null;
  recovery_codes: string[];
}
const USER_AUTH_COLS =
  'id, username, display_name, role, password_hash, disabled, locked_until, totp_enabled, totp_secret, recovery_codes';

function signAccess(app: FastifyInstance, userId: string, role: string): { accessToken: string; expiresIn: number } {
  return { accessToken: app.jwt.sign({ sub: userId, role }, { expiresIn: env.ACCESS_TTL_SECONDS }), expiresIn: env.ACCESS_TTL_SECONDS };
}
function setImgCookie(app: FastifyInstance, reply: any, userId: string) {
  reply.setCookie(IMG_COOKIE, app.jwt.sign({ sub: userId, typ: 'img' }, { expiresIn: IMG_COOKIE_TTL }), imgCookieOptions());
}

async function userPayload(userId: string) {
  const user = await one<{ id: string; username: string | null; display_name: string; role: string; avatar: unknown; totp_enabled: boolean; perms: unknown }>(
    'SELECT id, username, display_name, role, avatar, totp_enabled, perms FROM users WHERE id = $1',
    [userId],
  );
  const settings = await one<{ data: unknown }>('SELECT data FROM app_settings WHERE user_id = $1', [userId]);
  return {
    id: user?.id,
    username: user?.username ?? null,
    displayName: user?.display_name ?? 'me',
    role: user?.role ?? 'user',
    avatar: user?.avatar ?? {},
    totpEnabled: !!user?.totp_enabled,
    perms: user?.perms ?? {},
    settings: settings?.data ?? {},
  };
}

export default async function authRoutes(app: FastifyInstance) {
  // ---- first-run setup: create the very first admin from the browser, no env secret needed ----
  app.get('/api/setup/status', async () => {
    const c = await one<{ c: number }>('SELECT count(*)::int AS c FROM users');
    return { needsSetup: (c?.c ?? 0) === 0 };
  });

  app.post('/api/setup', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const b = z.object({ username: z.string().min(2).max(64).regex(/^[a-zA-Z0-9._-]+$/), password: z.string() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'Username: letters, numbers, . _ - (2–64 chars).' });
    // once any user exists, setup is closed forever
    if (await one('SELECT id FROM users LIMIT 1')) return reply.code(403).send({ error: 'already_configured', message: 'This server is already set up.' });
    const pwErr = passwordError(b.data.password);
    if (pwErr) return reply.code(400).send({ error: 'weak_password', message: pwErr });
    const row = await one<{ id: string }>(
      `INSERT INTO users (display_name, username, role, password_hash, auth_kind) VALUES ($1, $2, 'admin', $3, 'password') RETURNING id`,
      [b.data.username, b.data.username, await hash(b.data.password)],
    );
    if (!row) return reply.code(500).send({ error: 'setup_failed' });
    await q(`INSERT INTO app_settings (user_id, data) VALUES ($1, '{}'::jsonb) ON CONFLICT (user_id) DO NOTHING`, [row.id]);
    await logAudit('setup.complete', { userId: row.id, username: b.data.username, req });
    const refresh = await issueRefreshToken(row.id, { ip: clientIp(req), userAgent: (req.headers['user-agent'] as string) || null });
    reply.setCookie(REFRESH_COOKIE, refresh, cookieOptions());
    setImgCookie(app, reply, row.id);
    return reply.send({ ...signAccess(app, row.id, 'admin'), user: await userPayload(row.id) });
  });

  app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (req, reply) => {
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });
    const { password, code, deviceId, deviceName } = parsed.data;
    const username = (parsed.data.username || 'admin').trim();
    const ip = clientIp(req);
    const ua = (req.headers['user-agent'] as string) || null;

    const user = await one<FullUser>(`SELECT ${USER_AUTH_COLS} FROM users WHERE username = $1`, [username]);
    if (!user) {
      await logAudit('login.fail', { username, detail: { reason: 'no_user' }, req });
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    if (user.disabled) {
      await logAudit('login.blocked', { userId: user.id, username, detail: { reason: 'disabled' }, req });
      return reply.code(403).send({ error: 'disabled', message: 'This account is disabled.' });
    }
    const lock = lockedUntil(user);
    if (lock) return reply.code(423).send({ error: 'locked', until: lock.toISOString(), message: 'Account locked after too many attempts. Try again later.' });

    let ok = false;
    try { ok = await verify(user.password_hash, password); } catch { ok = false; }
    if (!ok) {
      const nowLocked = await recordFailedLogin(user.id);
      await logAudit('login.fail', { userId: user.id, username, detail: { reason: 'bad_password', locked: nowLocked }, req });
      if (nowLocked) return reply.code(423).send({ error: 'locked', message: 'Account locked after too many failed attempts. Try again in 15 minutes.' });
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    // second factor
    if (user.totp_enabled) {
      if (!code) return reply.code(401).send({ error: 'totp_required' });
      const clean = code.trim();
      let pass = user.totp_secret ? verifyTotp(user.totp_secret, clean) : false;
      if (!pass && /^[0-9a-f]{4}-[0-9a-f]{6}$/i.test(clean)) {
        const h = sha256(clean.toLowerCase());
        if (user.recovery_codes.includes(h)) {
          pass = true;
          await q('UPDATE users SET recovery_codes = array_remove(recovery_codes, $2) WHERE id = $1', [user.id, h]);
        }
      }
      if (!pass) {
        await logAudit('login.totp_fail', { userId: user.id, username, req });
        return reply.code(401).send({ error: 'totp_invalid', message: 'Incorrect authentication code.' });
      }
    }

    await resetFailedLogins(user.id);
    const refresh = await issueRefreshToken(user.id, { deviceId, deviceName, ip, userAgent: ua });
    reply.setCookie(REFRESH_COOKIE, refresh, cookieOptions());
    setImgCookie(app, reply, user.id);
    await logAudit('login.ok', { userId: user.id, username, req });
    return reply.send({ ...signAccess(app, user.id, user.role), user: await userPayload(user.id) });
  });

  // public branding + whether sign-up is open (for the login screen)
  app.get('/auth/config', async () => {
    const s = await one<{ server_name: string; allow_registration: boolean }>('SELECT server_name, allow_registration FROM server_settings WHERE id = 1');
    return {
      serverName: s?.server_name || 'Uchiyomi',
      allowRegistration: !!s?.allow_registration,
      oidc: oidcEnabled() ? { enabled: true, name: oidcName() } : { enabled: false, name: '' },
    };
  });


  // ---- OIDC / SSO -----------------------------------------------------------
  // An additional way in, never a replacement: password login, 2FA, lockout and session revocation are
  // untouched, and the callback finishes by minting exactly the session a password login would.
  const OIDC_COOKIE = 'yomi_oidc';

  app.get('/auth/oidc/start', async (req, reply) => {
    if (!oidcEnabled()) return reply.code(404).send({ error: 'not_configured' });
    let start;
    try {
      start = await beginLogin();
    } catch (e) {
      app.log.error({ err: e }, 'oidc: could not start login');
      return reply.code(502).send({ error: 'oidc_unavailable', message: 'Could not reach the login provider.' });
    }
    // The PKCE verifier and nonce must survive the round trip but must not be readable by scripts, and
    // must not outlive the login attempt.
    const ticket = app.jwt.sign(
      { typ: 'oidc', state: start.state, nonce: start.nonce, verifier: start.verifier },
      { expiresIn: 600 },
    );
    reply.setCookie(OIDC_COOKIE, ticket, {
      httpOnly: true, secure: 'auto', sameSite: 'lax', path: '/auth/oidc', maxAge: 600,
    });
    return reply.redirect(start.url);
  });

  app.get('/auth/oidc/callback', async (req, reply) => {
    if (!oidcEnabled()) return reply.code(404).send({ error: 'not_configured' });
    const fail = async (reason: string, detail?: string) => {
      await logAudit('login.oidc_fail', { detail: { reason, detail }, req });
      reply.clearCookie(OIDC_COOKIE, { path: '/auth/oidc' });
      const origin = env.PUBLIC_ORIGIN.replace(/\/$/, '');
      return reply.redirect(`${origin}/login?sso_error=${encodeURIComponent(reason)}`);
    };

    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
    if (error) return fail(error);
    if (!code || !state) return fail('missing_code');

    const raw = (req.cookies as Record<string, string | undefined>)[OIDC_COOKIE];
    if (!raw) return fail('expired');
    let ticket: { typ?: string; state?: string; nonce?: string; verifier?: string };
    try {
      ticket = app.jwt.verify(raw);
    } catch {
      return fail('expired');
    }
    if (ticket.typ !== 'oidc' || !ticket.state || ticket.state !== state) return fail('state_mismatch');

    let claims: OidcClaims;
    try {
      claims = await completeLogin(code, ticket.verifier!, ticket.nonce!);
    } catch (e) {
      app.log.error({ err: e }, 'oidc: login failed');
      return fail('exchange_failed', (e as Error).message);
    }
    reply.clearCookie(OIDC_COOKIE, { path: '/auth/oidc' });

    let userId: string;
    try {
      userId = await resolveOidcUser(claims);
    } catch (e) {
      return fail((e as Error).message);
    }

    const row = await one<{ role: string; disabled: boolean; username: string | null }>(
      'SELECT role, disabled, username FROM users WHERE id = $1', [userId],
    );
    if (!row || row.disabled) return fail('disabled');

    const refresh = await issueRefreshToken(userId, {
      deviceName: 'SSO', ip: clientIp(req), userAgent: (req.headers['user-agent'] as string) || null,
    });
    reply.setCookie(REFRESH_COOKIE, refresh, cookieOptions());
    setImgCookie(app, reply, userId);
    await logAudit('login.oidc_ok', { userId, username: row.username || undefined, req });
    // The session lives in the refresh cookie; the app picks it up on load and exchanges it for an access token.
    return reply.redirect(env.PUBLIC_ORIGIN.replace(/\/$/, '') + '/');
  });

  /** Map an OIDC identity to a local account, creating or adopting one only where configured to. */
  async function resolveOidcUser(claims: OidcClaims): Promise<string> {
    const existing = await one<{ id: string }>(
      'SELECT id FROM users WHERE oidc_issuer = $1 AND oidc_sub = $2', [claims.issuer, claims.sub],
    );
    if (existing) {
      // keep the role in step with the IdP when group mapping is configured
      if (env.OIDC_ADMIN_GROUP) {
        await q('UPDATE users SET role = $2 WHERE id = $1', [existing.id, isAdminByGroup(claims) ? 'admin' : 'user']);
      }
      return existing.id;
    }

    const wanted = (claims.username || claims.email?.split('@')[0] || '').replace(/[^a-zA-Z0-9._-]/g, '');
    if (!wanted) throw new Error('no_username');

    if (env.OIDC_LINK_BY_USERNAME) {
      const local = await one<{ id: string; oidc_sub: string | null }>(
        'SELECT id, oidc_sub FROM users WHERE username = $1', [wanted],
      );
      // Never steal an account already bound to a different SSO identity.
      if (local && !local.oidc_sub) {
        await q('UPDATE users SET oidc_issuer = $2, oidc_sub = $3 WHERE id = $1', [local.id, claims.issuer, claims.sub]);
        await logAudit('user.oidc_linked', { userId: local.id, username: wanted, detail: { issuer: claims.issuer } });
        return local.id;
      }
      if (local) throw new Error('username_taken');
    }

    if (!env.OIDC_ALLOW_SIGNUP) throw new Error('no_account');

    // Unusable password: this account can only ever be reached through the IdP.
    const placeholder = await hash(randomBytes(32).toString('base64url'));
    let username = wanted;
    for (let i = 2; await one('SELECT 1 FROM users WHERE username = $1', [username]); i++) username = `${wanted}${i}`;
    const rows = await q<{ id: string }>(
      `INSERT INTO users (display_name, username, role, password_hash, auth_kind, oidc_issuer, oidc_sub)
       VALUES ($1,$2,$3,$4,'oidc',$5,$6) RETURNING id`,
      [claims.displayName || username, username, isAdminByGroup(claims) ? 'admin' : 'user',
       placeholder, claims.issuer, claims.sub],
    );
    await logAudit('user.oidc_created', { userId: rows[0].id, username, detail: { issuer: claims.issuer } });
    return rows[0].id;
  }

  // self-registration (only when the admin enabled it) → creates a plain user + logs in
  app.post('/auth/register', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const s = await one<{ allow_registration: boolean }>('SELECT allow_registration FROM server_settings WHERE id = 1');
    if (!s?.allow_registration) return reply.code(403).send({ error: 'registration_disabled', message: 'Registration is disabled.' });
    const b = z.object({ username: z.string().min(2).max(64).regex(/^[a-zA-Z0-9._-]+$/), password: z.string(), displayName: z.string().max(64).optional() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const pwErr = passwordError(b.data.password);
    if (pwErr) return reply.code(400).send({ error: 'weak_password', message: pwErr });
    if (await one('SELECT id FROM users WHERE username = $1', [b.data.username])) return reply.code(409).send({ error: 'username_taken' });
    const row = await one<{ id: string }>(
      `INSERT INTO users (display_name, username, role, password_hash, auth_kind) VALUES ($1, $2, 'user', $3, 'password') RETURNING id`,
      [b.data.displayName || b.data.username, b.data.username, await hash(b.data.password)],
    );
    if (row) await q(`INSERT INTO app_settings (user_id, data) VALUES ($1, '{}'::jsonb) ON CONFLICT (user_id) DO NOTHING`, [row.id]);
    await logAudit('user.register', { userId: row?.id, username: b.data.username, req });
    const refresh = await issueRefreshToken(row!.id, { ip: clientIp(req), userAgent: (req.headers['user-agent'] as string) || null });
    reply.setCookie(REFRESH_COOKIE, refresh, cookieOptions());
    setImgCookie(app, reply, row!.id);
    return reply.send({ ...signAccess(app, row!.id, 'user'), user: await userPayload(row!.id) });
  });

  app.post('/auth/refresh', async (req, reply) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) return reply.code(401).send({ error: 'no_refresh' });
    const valid = await validateRefreshToken(token);
    if (!valid) {
      reply.clearCookie(REFRESH_COOKIE, { path: '/' });
      return reply.code(401).send({ error: 'invalid_refresh' });
    }
    const disabled = await one<{ disabled: boolean; role: string }>('SELECT disabled, role FROM users WHERE id = $1', [valid.userId]);
    if (disabled?.disabled) {
      await revokeAllSessions(valid.userId);
      reply.clearCookie(REFRESH_COOKIE, { path: '/' });
      return reply.code(403).send({ error: 'disabled' });
    }
    await revokeRefreshTokenById(valid.id);
    const next = await issueRefreshToken(valid.userId, {
      deviceId: valid.deviceId ?? undefined,
      deviceName: valid.deviceName ?? undefined,
      ip: clientIp(req),
      userAgent: (req.headers['user-agent'] as string) || null,
    });
    reply.setCookie(REFRESH_COOKIE, next, cookieOptions());
    setImgCookie(app, reply, valid.userId);
    return reply.send({ ...signAccess(app, valid.userId, disabled?.role ?? 'user'), user: await userPayload(valid.userId) });
  });

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (token) await revokeRefreshToken(token);
    reply.clearCookie(REFRESH_COOKIE, { path: '/' });
    reply.clearCookie(IMG_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });

  app.get('/auth/me', { preHandler: [authenticate] }, async (req) => userPayload(userIdOf(req)));

  // ---- sessions / devices ----
  app.get('/auth/sessions', { preHandler: [authenticate] }, async (req) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    const cur = token ? await validateRefreshToken(token) : null;
    if (cur) await touchSession(cur.id, clientIp(req), (req.headers['user-agent'] as string) || null);
    const rows = await listSessions(userIdOf(req));
    return { content: rows.map((s: any) => ({ ...s, current: cur?.id === s.id })) };
  });

  app.delete('/auth/sessions/:id', { preHandler: [authenticate] }, async (req) => {
    await revokeSessionForUser(userIdOf(req), (req.params as { id: string }).id);
    await logAudit('session.revoke', { userId: userIdOf(req), req });
    return { ok: true };
  });

  app.post('/auth/logout-all', { preHandler: [authenticate] }, async (req, reply) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    const cur = token ? await validateRefreshToken(token) : null;
    await revokeAllSessions(userIdOf(req), cur?.id); // keep this device
    await logAudit('session.logout_all', { userId: userIdOf(req), req });
    return reply.send({ ok: true });
  });

  // ---- change own password ----
  app.post('/auth/password', { preHandler: [authenticate] }, async (req, reply) => {
    const body = z.object({ current: z.string(), next: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const uid = userIdOf(req);
    const u = await one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [uid]);
    if (!u || !(await verify(u.password_hash, body.data.current).catch(() => false))) return reply.code(401).send({ error: 'wrong_password' });
    const pwErr = passwordError(body.data.next);
    if (pwErr) return reply.code(400).send({ error: 'weak_password', message: pwErr });
    const token = req.cookies?.[REFRESH_COOKIE];
    const cur = token ? await validateRefreshToken(token) : null;
    await q('UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1', [uid, await hash(body.data.next)]);
    await revokeAllSessions(uid, cur?.id); // log out other devices
    await logAudit('password.change', { userId: uid, req });
    return reply.send({ ok: true });
  });

  // ---- TOTP 2FA ----
  app.post('/auth/totp/setup', { preHandler: [authenticate] }, async (req) => {
    const uid = userIdOf(req);
    const u = await one<{ username: string | null }>('SELECT username FROM users WHERE id = $1', [uid]);
    const secret = generateSecret();
    await q('UPDATE users SET totp_secret = $2 WHERE id = $1', [uid, secret]); // pending until enabled
    const uri = otpauthURL(secret, u?.username || 'user');
    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 240 }).catch(() => '');
    return { secret, otpauth: uri, qr };
  });

  app.post('/auth/totp/enable', { preHandler: [authenticate] }, async (req, reply) => {
    const body = z.object({ code: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const uid = userIdOf(req);
    const u = await one<{ totp_secret: string | null }>('SELECT totp_secret FROM users WHERE id = $1', [uid]);
    if (!u?.totp_secret || !verifyTotp(u.totp_secret, body.data.code)) return reply.code(400).send({ error: 'totp_invalid', message: 'Incorrect code — try again.' });
    const codes = generateRecoveryCodes();
    await q('UPDATE users SET totp_enabled = true, recovery_codes = $2 WHERE id = $1', [uid, codes.map((c) => sha256(c))]);
    await logAudit('totp.enable', { userId: uid, req });
    return reply.send({ ok: true, recoveryCodes: codes });
  });

  app.post('/auth/totp/disable', { preHandler: [authenticate] }, async (req, reply) => {
    const body = z.object({ password: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const uid = userIdOf(req);
    const u = await one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [uid]);
    if (!u || !(await verify(u.password_hash, body.data.password).catch(() => false))) return reply.code(401).send({ error: 'wrong_password' });
    await q("UPDATE users SET totp_enabled = false, totp_secret = NULL, recovery_codes = '{}' WHERE id = $1", [uid]);
    await logAudit('totp.disable', { userId: uid, req });
    return reply.send({ ok: true });
  });
}
