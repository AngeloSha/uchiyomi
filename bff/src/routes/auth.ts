import { verify, hash } from '@node-rs/argon2';
import QRCode from 'qrcode';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../env';
import { one, q, tx } from '../lib/db';
import { logAudit, auditEvery } from '../lib/audit';
import {
  IMG_COOKIE,
  IMG_COOKIE_TTL,
  REFRESH_COOKIE,
  actsAsAdmin,
  authenticate,
  requireCredentialSession,
  withoutCredential,
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
  revokeSessionForUser,
  resumeHead,
  parentHeadOf,
  spendTotpStep,
  touchSession,
  userIdOf,
  validateRefreshToken,
  exchangeRefreshToken,
  refreshExpiresAt,
} from '../lib/auth';
import { generateRecoveryCodes, generateSecret, otpauthURL, recoveryCodeForm, sha256, totpStep } from '../lib/totp';
import { oidcEnabled, oidcName, beginLogin, completeLogin, isAdminByGroup, type OidcClaims } from '../lib/oidc';
import { randomBytes } from 'crypto';
import { SESSION_COOKIE as KOMGA_SESSION_COOKIE } from '../lib/komgaSession';
import { desktopFailAudit, desktopSecretMatches, isDesktop, isLoopback } from '../lib/desktop';
import { desktopUserId, ensureDesktopUser } from '../lib/desktopUser';
import { authMode, bootstrapSub, mayBootstrap, rescueAdmin, ssoOnly } from '../lib/authMode';
import { applyMemberDefaults } from '../lib/memberDefaults';
import { talkOn } from '../lib/comments';
import { verifyLoginPassword } from '../lib/loginPassword';
import { profileKind, type ProfileRow } from '../lib/profiles';
import { clientZone } from '../lib/clientAddr';
import {
  ADMIN_RESUME_HOURS, deviceKeyOf, ensureDeviceKey, forgetRemembered, isRemembered, noteResumed, rememberSession, ringOf,
} from '../lib/deviceRing';

const loginBody = z.object({
  username: z.string().max(64).optional(),
  password: z.string().min(1),
  code: z.string().max(32).optional(), // TOTP or recovery code (xxxxx-xxxxx-xxxxx-xxxxx is 23)
  deviceId: z.string().max(128).optional(),
  deviceName: z.string().max(128).optional(),
  // Remember on this device (lib/deviceRing.ts): this session can be taken up again here later without the password.
  remember: z.boolean().optional(),
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
  password_login: boolean;
}
const USER_AUTH_COLS =
  'id, username, display_name, role, password_hash, disabled, locked_until, totp_enabled, totp_secret, recovery_codes, password_login';

/**
 * `local`: the session was entered without a credential (lib/auth.ts withoutCredential), so the token says `loc: true`
 * and is good at home only (authenticate). Every other token is byte-for-byte what it was.
 */
function signAccess(app: FastifyInstance, userId: string, role: string, local = false): { accessToken: string; expiresIn: number; desktop?: true } {
  // `desktop: true` tells the web app it is inside Uchiyomi Desktop (web/lib/desktop.ts). Spread in only when
  // on, so every server response is byte-for-byte what it was.
  return {
    accessToken: app.jwt.sign({ sub: userId, role, ...(local ? { loc: true } : {}) }, { expiresIn: env.ACCESS_TTL_SECONDS }),
    expiresIn: env.ACCESS_TTL_SECONDS,
    ...(isDesktop() ? { desktop: true as const } : {}),
  };
}
/** The image cookie of a session entered without a credential carries `loc` too (routes/images.ts): it lasts a week. */
function setImgCookie(app: FastifyInstance, reply: any, userId: string, local = false) {
  reply.setCookie(IMG_COOKIE, app.jwt.sign({ sub: userId, typ: 'img', ...(local ? { loc: true } : {}) }, { expiresIn: IMG_COOKIE_TTL }), imgCookieOptions());
}

async function userPayload(userId: string) {
  const user = await one<{ id: string; username: string | null; display_name: string; role: string; avatar: unknown; totp_enabled: boolean; perms: unknown; sso: boolean } & ProfileRow>(
    `SELECT id, username, display_name, role, avatar, totp_enabled, perms, oidc_sub IS NOT NULL AS sso,
            password_login, local_open, auth_kind
       FROM users WHERE id = $1`,
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
    // Linked to an identity at the OIDC provider (v0.63.0): Profile → Account offers Link to … until it is.
    sso: !!user?.sso,
    // What kind of profile this is (lib/profiles.ts): every account before profiles is `password`.
    kind: user ? profileKind(user) : 'password',
    perms: user?.perms ?? {},
    settings: settings?.data ?? {},
    // v0.90.0: whether this server has chapter comments at all (lib/comments.ts talkOn: the owned library and two or more
    // members), so Profile → Settings → Reading offers Comments and reactions only where there is talk to switch off.
    talk: await talkOn(),
  };
}

/**
 * Test seam: how long a new server's first admin waits between counting the accounts and being made -- an SSO-only
 * server's first sign-in (firstAdmin) and first-run setup (/api/setup). Zero in the server. A race test holds the window
 * open with it, so two first admins meet inside it every time rather than once in a while: with the lock they are made
 * one after the other, without it two admins.
 */
let firstAdminPauseMs = 0;
export function _setFirstAdminPause(ms: number): void { firstAdminPauseMs = ms; }

/** The username an identity at the provider asks for, cleaned to what a username here may hold; '' when it names none. */
const usernameFor = (claims: OidcClaims): string =>
  (claims.username || claims.email?.split('@')[0] || '').replace(/[^a-zA-Z0-9._-]/g, '');

/** Sign-in's per-address limit, on every route that checks a password (v0.77.1 for the three behind a session). */
const SIGN_IN_LIMIT = { rateLimit: { max: 10, timeWindow: '5 minutes' } };

const LOCKED_NOW = { error: 'locked', message: 'Account locked after too many failed attempts. Try again in 15 minutes.' };

/**
 * The current password, asked for behind a session: changing it, and turning two-factor on or off. These failures
 * share the account-wide second-factor counter (recordFailedLogin), and are not checked while the account is
 * locked, so a session alone -- a borrowed phone, a stolen refresh cookie -- cannot guess its way to the password; the
 * routes carry SIGN_IN_LIMIT too. Public password failures instead use a source/name budget. A right password
 * clears the authenticated-check count. Null when it is right, else the
 * refusal to send. Reintroduce by checking the password alone: "a session cannot guess the password" in
 * accountLock.int.test.ts is never locked.
 */
async function currentPasswordRefusal(req: FastifyRequest, password: string): Promise<{ status: number; body: object } | null> {
  const uid = userIdOf(req);
  const u = await one<{ username: string | null; password_hash: string; locked_until: string | null }>(
    'SELECT username, password_hash, locked_until FROM users WHERE id = $1', [uid]);
  if (!u) return { status: 401, body: { error: 'wrong_password' } };
  const lock = lockedUntil(u);
  if (lock) return { status: 423, body: { error: 'locked', until: lock.toISOString(), message: 'Account locked after too many attempts. Try again later.' } };
  if (!(await verify(u.password_hash, password).catch(() => false))) {
    const nowLocked = await recordFailedLogin(uid);
    await logAudit('login.fail', { userId: uid, username: u.username, detail: { reason: 'bad_password', route: req.url.split('?')[0], locked: nowLocked }, req });
    return nowLocked ? { status: 423, body: LOCKED_NOW } : { status: 401, body: { error: 'wrong_password' } };
  }
  await resetFailedLogins(uid);
  return null;
}

export default async function authRoutes(app: FastifyInstance) {
  if (!app.hasDecorator('createRateLimit')) await app.register(rateLimit, { global: false });
  // Check failed attempts before looking up the account, for every name. A caller can exhaust only this
  // (address, username) pair; merely knowing a username must never suspend its owner everywhere.
  const signInPair = app.createRateLimit({
    max: 5, timeWindow: '15 minutes',
    keyGenerator: (req) => JSON.stringify([clientIp(req), (req.body as { username?: string })?.username?.trim() || 'admin']),
  });
  /**
   * v0.63.0 (#208, lib/authMode.ts): in SSO-only mode the routes that take a password are not registered at all --
   * first-run setup, sign-up, password change, two-factor -- and sign-in only while AUTH_RESCUE_ADMIN names an admin.
   * Not refused: absent, a 404 like any path that never existed, so there is nothing to guess at, rate-limit or watch.
   * Read once, here, as the routes are: the mode is the environment's, and the environment does not change under a
   * running server. Reintroduce any one of them: its line in ssoOnly.int.test.ts finds it answering.
   */
  const local = !ssoOnly();

  // ---- first-run setup: create the very first admin from the browser, no env secret needed ----
  app.get('/api/setup/status', async () => {
    // SSO-only mode has no setup form: the first admin is whoever the provider says, at their first sign-in
    // (resolveOidcUser), so a new server shows the sign-in screen's one button.
    if (!local) return { needsSetup: false };
    const c = await one<{ c: number }>('SELECT count(*)::int AS c FROM users');
    return { needsSetup: (c?.c ?? 0) === 0 };
  });

  if (local) app.post('/api/setup', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const b = z.object({ username: z.string().min(2).max(64).regex(/^[a-zA-Z0-9._-]+$/), password: z.string() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'Username: letters, numbers, . _ - (2–64 chars).' });
    const closed = () => reply.code(403).send({ error: 'already_configured', message: 'This server is already set up.' });
    // once any user exists, setup is closed forever
    if (await one('SELECT id FROM users LIMIT 1')) return closed();
    const pwErr = passwordError(b.data.password);
    if (pwErr) return reply.code(400).send({ error: 'weak_password', message: pwErr });
    // Hashed before the lock is taken, so the lock is held for two short statements and not for argon2.
    const passwordHash = await hash(b.data.password);
    // Counted again and made under firstAdmin's lock (v0.77.1), as an SSO-only server's first sign-in makes its admin:
    // two setups at once make one admin, and the other is told the server is set up. Reintroduce by checking outside
    // the lock: "two setups at once make one admin" in setupRace.int.test.ts finds two.
    const row = await tx(async (qq) => {
      await qq('SELECT pg_advisory_xact_lock(6301)');
      if ((await qq('SELECT 1 FROM users LIMIT 1')).length) return null;
      if (firstAdminPauseMs) await new Promise((go) => setTimeout(go, firstAdminPauseMs));
      const [made] = await qq<{ id: string }>(
        `INSERT INTO users (display_name, username, role, password_hash, auth_kind) VALUES ($1, $2, 'admin', $3, 'password') RETURNING id`,
        [b.data.username, b.data.username, passwordHash],
      );
      await qq(`INSERT INTO app_settings (user_id, data) VALUES ($1, '{}'::jsonb) ON CONFLICT (user_id) DO NOTHING`, [made.id]);
      return made;
    });
    if (!row) return closed();
    await logAudit('setup.complete', { userId: row.id, username: b.data.username, req });
    const refresh = await issueRefreshToken(row.id, { ip: clientIp(req), userAgent: (req.headers['user-agent'] as string) || null, via: 'setup' });
    reply.setCookie(REFRESH_COOKIE, refresh, cookieOptions());
    setImgCookie(app, reply, row.id);
    return reply.send({ ...signAccess(app, row.id, 'admin'), user: await userPayload(row.id), refreshExpiresAt: refreshExpiresAt() });
  });

  if (local || rescueAdmin()) app.post('/auth/login', { config: SIGN_IN_LIMIT }, async (req, reply) => {
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });
    const { password, code, deviceId, deviceName } = parsed.data;
    const username = (parsed.data.username || 'admin').trim();
    const ip = clientIp(req);
    const ua = (req.headers['user-agent'] as string) || null;
    const budget = await signInPair(req, { increment: false });
    if (!budget.isAllowed && budget.isExceeded) {
      return reply.code(429).header('Retry-After', String(budget.ttlInSeconds))
        .send({ error: 'too_many_requests', message: 'Too many sign-in attempts. Try again later.' });
    }

    // SSO-only mode's way back in (lib/authMode.ts rescueAdmin): this route answers only while AUTH_RESCUE_ADMIN names
    // an admin, and then for that account alone. Any other name, or a rescue name that is no admin, is refused exactly
    // as a wrong password is, so the answer says nothing about who exists. Reintroduce by dropping the check: "the
    // rescue opens one admin's password sign-in and nobody else's" in ssoRescue.int.test.ts signs a member in.
    const rescue = local ? null : rescueAdmin();
    const user = await one<FullUser>(`SELECT ${USER_AUTH_COLS} FROM users WHERE username = $1`, [username]);
    // A profile without a password (password_login false) is refused here like a name nobody has: its placeholder hash
    // matches nothing anyway, and the answer must not say which names are such profiles. Reintroduce by dropping the
    // case: uniformPasswordRefusal.int.test.ts signs its profile without a password in with the hash's own password.
    const refusal = !local && (username !== rescue || user?.role !== 'admin') ? 'sso_only'
      : !user ? 'no_user' : !user.password_login ? 'no_password' : null;
    // Before a password is accepted every refusal is one answer, after one verification each (lib/loginPassword.ts): a
    // name nobody has, a name SSO-only mode does not let in, and a wrong password. A disabled or locked account is
    // checked against its own password, and only the right password is told why it cannot sign in -- someone who has
    // it learns the account's state, nobody else does, and its owner is not told "wrong password" for the right one.
    // Reintroduce by answering a disabled account before its password: "pre-password account states have uniform
    // refusals" in uniformPasswordRefusal.int.test.ts sees a 403; by folding the states into the 401: "wrong
    // second-step codes lock the account" in accountLock.int.test.ts sees the right password told it is wrong.
    const ok = await verifyLoginPassword(!refusal && user ? user.password_hash : null, password);
    if (!user || refusal || !ok) {
      // Public password failures never increment the account-wide counter. Keep that counter for
      // authenticated password checks and wrong second factors, where the attacker already has a credential.
      const why = refusal ?? (user?.disabled ? 'disabled' : user && lockedUntil(user) ? 'locked' : 'bad_password');
      await logAudit('login.fail', { userId: user?.id, username, detail: { reason: why }, req });
      const failed = await signInPair(req);
      if (!failed.isAllowed && failed.isExceeded) {
        return reply.code(429).header('Retry-After', String(failed.ttlInSeconds))
          .send({ error: 'too_many_requests', message: 'Too many sign-in attempts. Try again later.' });
      }
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    if (user.disabled) {
      await logAudit('login.blocked', { userId: user.id, username, detail: { reason: 'disabled' }, req });
      return reply.code(403).send({ error: 'disabled', message: 'This account is disabled.' });
    }
    const lock = lockedUntil(user);
    if (lock) return reply.code(423).send({ error: 'locked', until: lock.toISOString(), message: 'Account locked after too many attempts. Try again later.' });
    // second factor
    if (user.totp_enabled) {
      if (!code) return reply.code(401).send({ error: 'totp_required' });
      const clean = code.trim();
      // A code is good once: its step is spent in the statement that checks it is later than the last (spendTotpStep).
      const step = user.totp_secret ? totpStep(user.totp_secret, clean) : null;
      let pass = step !== null && (await spendTotpStep(user.id, step));
      const recovery = recoveryCodeForm(clean);
      if (!pass && recovery) {
        // Used up in the same statement that finds it, so two sign-ins racing with one code get one session.
        const h = sha256(recovery);
        pass = !!(await one('UPDATE users SET recovery_codes = array_remove(recovery_codes, $2) WHERE id = $1 AND $2 = ANY(recovery_codes) RETURNING id', [user.id, h]));
      }
      if (!pass) {
        // A wrong code counts toward the lock exactly as a wrong password does (v0.77.1), so six digits cannot be tried
        // for as long as the address limit allows. Reintroduce by only writing it down: "wrong second-step codes lock the
        // account" in accountLock.int.test.ts is never locked.
        const nowLocked = await recordFailedLogin(user.id);
        await logAudit('login.totp_fail', { userId: user.id, username, detail: { locked: nowLocked }, req });
        // At this point the caller proved the password; keep the second-step UX and its brute-force lock.
        if (nowLocked) return reply.code(423).send(LOCKED_NOW);
        return reply.code(401).send({ error: 'totp_invalid', message: 'Incorrect authentication code.' });
      }
    }

    await resetFailedLogins(user.id);
    const refresh = await issueRefreshToken(user.id, { deviceId, deviceName, ip, userAgent: ua, via: 'password' });
    reply.setCookie(REFRESH_COOKIE, refresh, cookieOptions());
    setImgCookie(app, reply, user.id);
    if (parsed.data.remember && !isDesktop()) {
      const live = await validateRefreshToken(refresh);
      if (live) await rememberSession(ensureDeviceKey(req, reply), user.id, live.sessionId);
    }
    // A rescue sign-in is said in the log as well as written down: it is the door SSO-only mode exists to keep shut.
    if (rescue) app.log.warn(`[auth] rescue sign-in by the admin "${username}" (AUTH_RESCUE_ADMIN)`);
    await logAudit(rescue ? 'login.rescue' : 'login.ok', { userId: user.id, username, req });
    return reply.send({ ...signAccess(app, user.id, user.role), user: await userPayload(user.id), refreshExpiresAt: refreshExpiresAt() });
  });

  // public branding + whether sign-up is open (for the login screen)
  app.get('/auth/config', async () => {
    const s = await one<{ server_name: string; allow_registration: boolean }>('SELECT server_name, allow_registration FROM server_settings WHERE id = 1');
    return {
      serverName: s?.server_name || 'Uchiyomi',
      // Desktop has one person and no sign-up form, whatever a restored server database says; SSO-only mode (v0.63.0)
      // has no sign-up route at all.
      allowRegistration: !isDesktop() && local && !!s?.allow_registration,
      oidc: oidcEnabled() ? { enabled: true, name: oidcName() } : { enabled: false, name: '' },
      // v0.63.0 (#208): `oidc-only` is a sign-in screen with the provider's button alone, and `rescue` the password form
      // beside it while AUTH_RESCUE_ADMIN reopens it for one admin (components/LoginScreen.tsx).
      mode: authMode(),
      ...(rescueAdmin() ? { rescue: true as const } : {}),
      // What a browser tab pointed at the desktop app's port sees instead of a sign-in form (LoginScreen.tsx).
      ...(isDesktop() ? { desktop: true as const } : {}),
    };
  });

  /**
   * The desktop sign-in handshake: how Uchiyomi Desktop's own window gets a session with no sign-in screen.
   *
   * The shell starts this server with a fresh 256-bit secret on every launch (lib/desktop.ts takes it out of
   * the environment), and its main process adds `X-Uchiyomi-Desktop: <secret>` to exactly this request, below
   * the page -- page JavaScript never sees it. Success answers exactly like `/auth/login`: the same body and the
   * same `yomi_rt` + `yomi_img` cookies, so every other route, image loading and refresh work unchanged.
   *
   * Registered ONLY when the desktop switch is on, so the server's route table (openapiCoverage.test.ts) is
   * untouched, and deliberately not in openapi.yaml: it is a private handshake with the shell, not an API.
   *
   * Checked in this order, each answer saying as little as possible:
   *   1. not from this machine -> 404 (as if the route did not exist, so a future LAN mode cannot expose it);
   *   2. an Origin that is not the app's own -> 403 (a page elsewhere cannot trigger it -- the header would be
   *      missing anyway, but a no-cors POST from another origin must not even reach the comparison);
   *   3. the secret, compared by digest in constant time -> 401, audited when one was offered (at most a row
   *      a minute, so a flood cannot grow the database).
   * No rate limit and no lockout, on purpose: everything arrives from 127.0.0.1, so another local account could
   * exhaust a limit and lock the real window out, and a 256-bit secret needs none. No 2FA: holding the OS
   * account and the shell's secret IS the factor.
   *
   * Reintroduce by dropping any one check: desktopAuth.test.ts names each answer.
   */
  if (isDesktop()) {
    app.post('/auth/desktop', async (req, reply) => {
      if (!isLoopback(req.socket.remoteAddress)) return reply.code(404).send({ error: 'not_found' });
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== env.PUBLIC_ORIGIN) return reply.code(403).send({ error: 'forbidden' });
      const header = req.headers['x-uchiyomi-desktop'];
      if (!desktopSecretMatches(header)) {
        // ⚠️ With no rate limit, a row per refusal let anything on the PC grow audit_log without bound. A request
        // that offered no secret guessed nothing and is not written down; wrong secrets are, one row a minute
        // at most, counting the attempts it stands for (lib/desktop.ts desktopFailAudit).
        const attempts = header ? desktopFailAudit() : null;
        if (attempts !== null) await logAudit('login.desktop_fail', { detail: { reason: 'bad_secret', attempts }, req });
        return reply.code(401).send({ error: 'unauthorized' });
      }
      // The window may name itself (the same device id the sign-in form sends), and nothing else is read.
      const b = z.object({ deviceId: z.string().max(128).optional() }).safeParse(req.body ?? {});
      const userId = (await desktopUserId()) ?? (await ensureDesktopUser());
      const user = await one<{ role: string; username: string | null }>('SELECT role, username FROM users WHERE id = $1', [userId]);
      const meta = { ip: clientIp(req), userAgent: (req.headers['user-agent'] as string) || null };
      // Back from a profile switched to on this PC: the owner's own session,
      // the one the profile was opened from, is taken up again and the profile's is ended -- rather than a new owner
      // session each time, and the old ones left live with no cookie anywhere. Reintroduce a fresh session here:
      // "back to the owner takes up the session the profile came from" in desktopProfiles.int.test.ts counts two.
      const held = req.cookies?.[REFRESH_COOKIE];
      const cur = held ? await validateRefreshToken(held) : null;
      const from = cur && withoutCredential(cur.via) ? await parentHeadOf(cur.sessionId, userId) : null;
      if (cur && withoutCredential(cur.via)) await revokeRefreshToken(held!);
      const resumed = from ? await resumeHead(from, meta) : null;
      const refresh = resumed ?? await issueRefreshToken(userId, {
        deviceId: b.success ? b.data.deviceId : undefined, deviceName: 'This PC', via: 'desktop', ...meta,
      });
      const expires = resumed ? from!.expiresAt.getTime() : refreshExpiresAt();
      reply.setCookie(REFRESH_COOKIE, refresh, { ...cookieOptions(), maxAge: Math.max(1, Math.floor((expires - Date.now()) / 1000)) });
      setImgCookie(app, reply, userId);
      await logAudit('login.desktop', { userId, username: user?.username ?? undefined, ...(resumed ? { detail: { from: cur!.userId } } : {}), req });
      return reply.send({ ...signAccess(app, userId, user?.role ?? 'admin'), user: await userPayload(userId), refreshExpiresAt: expires });
    });
  }


  // ---- OIDC / SSO -----------------------------------------------------------
  // An additional way in, never a replacement: password login, 2FA, lockout and session revocation are
  // untouched, and the callback finishes by minting exactly the session a password login would.
  const OIDC_COOKIE = 'yomi_oidc';

  /**
   * The unauthenticated OIDC routes (v0.69.1). They declared no rate limit and did unconditional work per request: every
   * refusal at the callback wrote an audit row holding the caller's own ?error= text (17 KB of table each), and the
   * login ticket was good for any number of callbacks, each one a token-endpoint POST with this server's client
   * credentials. The limit is a speed bump only -- its key is req.ip -- so the rows are throttled (auditEvery) and the
   * ticket is spent once. Reintroduce any one: oidcCallbackBounds.int.test.ts counts the rows or the token POSTs.
   */
  const oidcLimit = { config: { rateLimit: { max: 30, timeWindow: '5 minutes' } } };
  /** Refusals that come before any identity is proven: from anyone on the network, so throttled per kind. */
  const PRE_IDENTITY = new Set(['missing_code', 'expired', 'state_mismatch', 'exchange_failed']);
  /** Ticket ids already used, until their ten minutes are up. One process, so memory is enough. */
  const spent = new Map<string, number>();
  const spend = (jti: string | undefined): boolean => {
    const now = Date.now();
    // Added in expiry order, so the expired ones are at the front: stop at the first live one rather than visiting
    // every spent id on every callback.
    for (const [k, exp] of spent) { if (exp >= now) break; spent.delete(k); }
    if (!jti || spent.has(jti)) return false;
    spent.set(jti, now + 600_000);
    return true;
  };

  /** Off to the provider: `link` names the account signed in here that the identity it answers with is linked to. */
  const toProvider = async (reply: any, link?: string) => {
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
      { typ: 'oidc', jti: randomBytes(12).toString('base64url'), state: start.state, nonce: start.nonce, verifier: start.verifier, ...(link ? { link } : {}) },
      { expiresIn: 600 },
    );
    reply.setCookie(OIDC_COOKIE, ticket, {
      httpOnly: true, secure: 'auto', sameSite: 'lax', path: '/auth/oidc', maxAge: 600,
    });
    return reply.redirect(start.url);
  };

  app.get('/auth/oidc/start', oidcLimit, async (_req, reply) => {
    if (!oidcEnabled()) return reply.code(404).send({ error: 'not_configured' });
    return toProvider(reply);
  });

  /**
   * Link the account signed in on this browser to an identity at the provider (v0.63.0, #208): Profile → Account's
   * Link to …. How an install moves accounts that already exist to SSO before it turns SSO-only mode on, and how the
   * rescue admin links theirs. A top-level navigation, so the account is the one whose session cookie comes with it,
   * never one a request names; the provider's answer lands on the callback below, which links rather than signs in.
   * A browser with no session goes to the sign-in screen. Reintroduce by taking the account from the query: "a link
   * names the account signed in on this browser, never another" in ssoLink.int.test.ts links the wrong one.
   */
  app.get('/auth/oidc/link', oidcLimit, async (req, reply) => {
    if (!oidcEnabled()) return reply.code(404).send({ error: 'not_configured' });
    const token = req.cookies?.[REFRESH_COOKIE];
    const cur = token ? await validateRefreshToken(token) : null;
    if (!cur) return reply.redirect(`${env.PUBLIC_ORIGIN.replace(/\/$/, '')}/login`);
    // A profile entered without a credential does not get one from the provider either: a link would let it in from
    // anywhere (lib/auth.ts requireCredentialSession, which this cookie-only route cannot use).
    if (withoutCredential(cur.via)) return reply.redirect(`${env.PUBLIC_ORIGIN.replace(/\/$/, '')}/profile/?tab=Account&sso_link=failed`);
    return toProvider(reply, cur.userId);
  });

  app.get('/auth/oidc/callback', oidcLimit, async (req, reply) => {
    if (!oidcEnabled()) return reply.code(404).send({ error: 'not_configured' });
    const fail = async (reason: string, detail?: string, identityProven = false) => {
      // Before an identity is proven the caller is anyone on the network: one row a minute per kind, counting the
      // attempts it stands for, and never more of the caller's own text than a short token.
      const shown = String(reason).slice(0, 64);
      const attempts = identityProven ? 1 : auditEvery(`login.oidc_fail:${PRE_IDENTITY.has(reason) ? reason : 'provider_error'}`);
      if (attempts !== null) await logAudit('login.oidc_fail', { detail: { reason: shown, detail: detail?.slice(0, 200), attempts }, req });
      reply.clearCookie(OIDC_COOKIE, { path: '/auth/oidc' });
      const origin = env.PUBLIC_ORIGIN.replace(/\/$/, '');
      return reply.redirect(`${origin}/login?sso_error=${encodeURIComponent(shown)}`);
    };

    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
    if (error) return fail(error);
    if (!code || !state) return fail('missing_code');

    const raw = (req.cookies as Record<string, string | undefined>)[OIDC_COOKIE];
    if (!raw) return fail('expired');
    let ticket: { typ?: string; jti?: string; state?: string; nonce?: string; verifier?: string; link?: string };
    try {
      ticket = app.jwt.verify(raw);
    } catch {
      return fail('expired');
    }
    if (ticket.typ !== 'oidc' || !ticket.state || ticket.state !== state) return fail('state_mismatch');
    // One callback per ticket: a replay never reaches the provider's token endpoint.
    if (!spend(ticket.jti)) return fail('expired');

    let claims: OidcClaims;
    try {
      claims = await completeLogin(code, ticket.verifier!, ticket.nonce!);
    } catch (e) {
      app.log.error({ err: e }, 'oidc: login failed');
      return fail('exchange_failed', (e as Error).message);
    }
    reply.clearCookie(OIDC_COOKIE, { path: '/auth/oidc' });

    // A link from Profile → Account (above): the identity joins the account that asked, and nobody is signed in --
    // that browser already is. Back to the profile, saying how it went.
    if (ticket.link) {
      const back = (result: string) => reply.redirect(`${env.PUBLIC_ORIGIN.replace(/\/$/, '')}/profile/?tab=Account&sso_link=${result}`);
      const taken = await one<{ id: string }>('SELECT id FROM users WHERE oidc_issuer = $1 AND oidc_sub = $2', [claims.issuer, claims.sub]);
      // Never two accounts for one identity: it would sign in as whichever the lookup found first.
      if (taken && taken.id !== ticket.link) {
        await logAudit('login.oidc_fail', { userId: ticket.link, detail: { reason: 'link_taken' }, req });
        return back('taken');
      }
      const u = await one<{ username: string | null; disabled: boolean }>('SELECT username, disabled FROM users WHERE id = $1', [ticket.link]);
      if (!u || u.disabled) return back('failed');
      await q('UPDATE users SET oidc_issuer = $2, oidc_sub = $3 WHERE id = $1', [ticket.link, claims.issuer, claims.sub]);
      await logAudit('user.oidc_linked', { userId: ticket.link, username: u.username ?? undefined, detail: { issuer: claims.issuer, via: 'profile' }, req });
      return back('ok');
    }

    let userId: string;
    try {
      userId = await resolveOidcUser(claims);
    } catch (e) {
      const reason = (e as Error).message;
      // A new SSO-only server refusing a first sign-in says whose (v0.63.0): the subject to copy into
      // OIDC_BOOTSTRAP_ADMIN_SUB is in the log, where only the operator reads it.
      if (reason === 'not_set_up') app.log.warn(`[auth] a first sign-in, by the subject "${claims.sub}", is not this server's first admin (OIDC_BOOTSTRAP_ADMIN_SUB, OIDC_ADMIN_GROUP)`);
      return fail(reason, undefined, true);
    }

    const row = await one<{ role: string; disabled: boolean; username: string | null }>(
      'SELECT role, disabled, username FROM users WHERE id = $1', [userId],
    );
    if (!row || row.disabled) return fail('disabled', undefined, true);

    const refresh = await issueRefreshToken(userId, {
      deviceName: 'SSO', ip: clientIp(req), userAgent: (req.headers['user-agent'] as string) || null, via: 'oidc',
    });
    reply.setCookie(REFRESH_COOKIE, refresh, cookieOptions());
    setImgCookie(app, reply, userId);
    await logAudit('login.oidc_ok', { userId, username: row.username || undefined, req });
    // The session lives in the refresh cookie; the app picks it up on load and exchanges it for an access token.
    return reply.redirect(env.PUBLIC_ORIGIN.replace(/\/$/, '') + '/');
  });

  /** Map an OIDC identity to a local account, creating or adopting one only where configured to. */
  async function resolveOidcUser(claims: OidcClaims): Promise<string> {
    const existing = await one<{ id: string; role: string }>(
      'SELECT id, role FROM users WHERE oidc_issuer = $1 AND oidc_sub = $2', [claims.issuer, claims.sub],
    );
    if (existing) {
      // keep the role in step with the IdP when group mapping is configured
      if (env.OIDC_ADMIN_GROUP) {
        let role = isAdminByGroup(claims) ? 'admin' : 'user';
        // ...but never the server's last admin out of being one (v0.63.0): an SSO-only server's first admin may come
        // from OIDC_BOOTSTRAP_ADMIN_SUB and be in no group, and with no password to fall back on, demoting them would
        // leave nobody able to run the server. Admin → Members refuses the same (last_admin). Reintroduce by dropping
        // it: "the first admin stays one while nobody else is" in ssoOnly.int.test.ts reads user.
        if (role === 'user' && existing.role === 'admin') {
          const others = await one<{ c: number }>(
            `SELECT count(*)::int AS c FROM users WHERE role = 'admin' AND NOT disabled AND id <> $1`, [existing.id]);
          if ((others?.c ?? 0) === 0) {
            role = 'admin';
            app.log.warn(`[auth] the provider puts the last admin outside ${env.OIDC_ADMIN_GROUP}: kept as admin`);
          }
        }
        await q('UPDATE users SET role = $2 WHERE id = $1', [existing.id, role]);
      }
      return existing.id;
    }

    // SSO-only mode (v0.63.0, #208): a new server's first account is its first admin, made here rather than by a setup
    // form (firstAdmin, below). Past it, an unknown identity is a sign-up like any other.
    if (!local) {
      const first = await firstAdmin(claims);
      if (first) return first;
    }

    const wanted = usernameFor(claims);
    if (!wanted) throw new Error('no_username');

    if (env.OIDC_LINK_BY_USERNAME) {
      // Adopt only by the username the provider itself reports, exactly -- what the setting promises (env.ts). `wanted`
      // is a name for a NEW account: it falls back to the email's local part (email_verified unread, the domain
      // dropped) and strips characters, so adopting by it handed an existing account, an admin's included, to any
      // identity whose email or cleaned name happened to match (v0.69.1). Reintroduce by looking up `wanted`:
      // oidcLinkByUsername.int.test.ts adopts 'admin' for an identity that reports no username at all.
      const reported = claims.username;
      // Never a profile without a password, nor one another account manages: a provider that reports `bob` does not
      // take over the reading of the child's profile called bob. Reintroduce by
      // dropping the clause: "a managed profile is never adopted" in oidcLinkByUsername.int.test.ts links it.
      const local = reported
        ? await one<{ id: string; oidc_sub: string | null }>(
          'SELECT id, oidc_sub FROM users WHERE username = $1 AND managed_by IS NULL AND password_login', [reported])
        : null;
      // Never steal an account already bound to a different SSO identity.
      if (local && !local.oidc_sub) {
        await q('UPDATE users SET oidc_issuer = $2, oidc_sub = $3 WHERE id = $1', [local.id, claims.issuer, claims.sub]);
        await logAudit('user.oidc_linked', { userId: local.id, username: reported, detail: { issuer: claims.issuer } });
        // Linked now, so the linked account's path runs: OIDC_ADMIN_GROUP sets the role from this first sign-in on,
        // where adoption used to keep whatever role the account had (an admin outside the group stayed one).
        return resolveOidcUser(claims);
      }
      if (local) throw new Error('username_taken');
    }

    if (!env.OIDC_ALLOW_SIGNUP) throw new Error('no_account');

    // Unusable password: this account can only ever be reached through the IdP.
    const placeholder = await hash(randomBytes(32).toString('base64url'));
    let username = wanted;
    for (let i = 2; await one('SELECT 1 FROM users WHERE username = $1', [username]); i++) username = `${wanted}${i}`;
    const role = isAdminByGroup(claims) ? 'admin' : 'user';
    // A sign-up like /auth/register's: it starts with what Admin → Members → When someone signs up says
    // (lib/memberDefaults.ts), written with the account so its first request already has it -- an admin by the group
    // too, for the day the group sync makes it a member. Reintroduce by dropping the call, or by making it for members
    // only: "a first sign-in through the provider starts with the defaults" in memberDefaults.int.test.ts finds every
    // library open.
    const id = await tx(async (qq) => {
      const [row] = await qq<{ id: string }>(
        `INSERT INTO users (display_name, username, role, password_hash, auth_kind, oidc_issuer, oidc_sub)
         VALUES ($1,$2,$3,$4,'oidc',$5,$6) RETURNING id`,
        [claims.displayName || username, username, role, placeholder, claims.issuer, claims.sub],
      );
      await applyMemberDefaults(qq, row.id);
      return row.id;
    });
    await logAudit('user.oidc_created', { userId: id, username, detail: { issuer: claims.issuer } });
    return id;
  }

  /**
   * A new SSO-only server's first admin, from this sign-in -- or null when the server has an account already. The
   * subject OIDC_BOOTSTRAP_ADMIN_SUB names, else anyone in OIDC_ADMIN_GROUP (lib/authMode.ts mayBootstrap), whatever
   * OIDC_ALLOW_SIGNUP says: this is the server's admin, not a sign-up. Anyone else before them is told the server is
   * not set up yet (`not_set_up`), and gets no account. One lock and one count, so two first sign-ins at once make one
   * admin. Reintroduce by checking outside the lock: "two first sign-ins at once make one admin" in
   * ssoOnly.int.test.ts finds two.
   */
  async function firstAdmin(claims: OidcClaims): Promise<string | null> {
    // An unusable password, hashed before the lock: the account is reached through the provider alone.
    const placeholder = await hash(randomBytes(32).toString('base64url'));
    const username = usernameFor(claims) || 'admin';
    const id = await tx(async (qq) => {
      await qq('SELECT pg_advisory_xact_lock(6301)');
      if ((await qq('SELECT 1 FROM users LIMIT 1')).length) return null;
      if (!mayBootstrap(claims, { bootstrapSub: bootstrapSub(), adminGroup: env.OIDC_ADMIN_GROUP })) throw new Error('not_set_up');
      if (firstAdminPauseMs) await new Promise((go) => setTimeout(go, firstAdminPauseMs));
      const [row] = await qq<{ id: string }>(
        `INSERT INTO users (display_name, username, role, password_hash, auth_kind, oidc_issuer, oidc_sub)
         VALUES ($1, $2, 'admin', $3, 'oidc', $4, $5) RETURNING id`,
        [claims.displayName || username, username, placeholder, claims.issuer, claims.sub],
      );
      await qq(`INSERT INTO app_settings (user_id, data) VALUES ($1, '{}'::jsonb) ON CONFLICT (user_id) DO NOTHING`, [row.id]);
      return row.id;
    });
    if (id) await logAudit('setup.complete', { userId: id, username, detail: { via: 'oidc', issuer: claims.issuer } });
    return id;
  }

  // self-registration (only when the admin enabled it) → creates a plain user + logs in
  //
  // v0.61.0: the sign-in screen has a form for this at last (web/components/LoginScreen.tsx -- Open registration in
  // Admin → Settings did nothing visible before), so it answers like a sign-in in three more ways:
  //  * the device names itself, as at /auth/login, so the new session reads as this phone in the sessions list;
  //  * a name that differs from an existing one only in case is taken. uq_users_username is case-sensitive, so a
  //    stranger could sign up as `Admin` beside `admin` and be told apart only by a capital letter. Reintroduce by
  //    comparing `username = $1`: "a lookalike of an existing name is taken" in register.int.test.ts gets a 200;
  //  * check and insert run under one advisory lock on the lower-cased name, so sign-ups racing for `bob` and `Bob`
  //    end in one account and 409s; and a unique violation from any other writer (an admin creating the same name
  //    that instant) is a 409 too, never a 500. Reintroduce by dropping the lock: "sign-ups racing for one name in
  //    different cases end in one account" in register.int.test.ts sees several; drop the 23505 mapping: "a unique
  //    violation from another writer is a 409, not a 500" sees a 500.
  if (local) app.post('/auth/register', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const s = await one<{ allow_registration: boolean }>('SELECT allow_registration FROM server_settings WHERE id = 1');
    if (!s?.allow_registration) return reply.code(403).send({ error: 'registration_disabled', message: 'Registration is disabled.' });
    const b = z.object({
      username: z.string().min(2).max(64).regex(/^[a-zA-Z0-9._-]+$/),
      password: z.string(),
      displayName: z.string().max(64).optional(),
      deviceId: z.string().max(128).optional(),
      deviceName: z.string().max(128).optional(),
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const pwErr = passwordError(b.data.password);
    if (pwErr) return reply.code(400).send({ error: 'weak_password', message: pwErr });
    const { username, deviceId, deviceName } = b.data;
    const taken = () => reply.code(409).send({ error: 'username_taken', message: 'That username is taken.' });
    // Hashed before the lock is taken, so the lock is held for two short statements and not for argon2.
    const passwordHash = await hash(b.data.password);
    let row: { id: string } | null;
    try {
      row = await tx(async (qq) => {
        await qq('SELECT pg_advisory_xact_lock(hashtextextended(lower($1), 6100))', [username]);
        if ((await qq('SELECT 1 FROM users WHERE lower(username) = lower($1)', [username])).length) return null;
        const [made] = await qq<{ id: string }>(
          `INSERT INTO users (display_name, username, role, password_hash, auth_kind) VALUES ($1, $2, 'user', $3, 'password') RETURNING id`,
          [b.data.displayName || username, username, passwordHash],
        );
        await qq(`INSERT INTO app_settings (user_id, data) VALUES ($1, '{}'::jsonb) ON CONFLICT (user_id) DO NOTHING`, [made.id]);
        // What Admin → Members → When someone signs up says a member starts with (lib/memberDefaults.ts), in this
        // transaction, so the session answered below already has it. Reintroduce by dropping the call: "a sign-up
        // starts with the defaults" in memberDefaults.int.test.ts finds every library open.
        await applyMemberDefaults(qq, made.id);
        return made;
      });
    } catch (e) {
      if ((e as { code?: string })?.code === '23505') return taken();
      throw e;
    }
    if (!row) return taken();
    await logAudit('user.register', { userId: row.id, username, req });
    const refresh = await issueRefreshToken(row.id, { deviceId, deviceName, ip: clientIp(req), userAgent: (req.headers['user-agent'] as string) || null, via: 'register' });
    reply.setCookie(REFRESH_COOKIE, refresh, cookieOptions());
    setImgCookie(app, reply, row.id);
    return reply.send({ ...signAccess(app, row.id, 'user'), user: await userPayload(row.id), refreshExpiresAt: refreshExpiresAt() });
  });

  app.post('/auth/refresh', async (req, reply) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) return reply.code(401).send({ error: 'no_refresh' });
    // The decision and its reasons live in planRefresh (lib/auth.ts).
    const r = await exchangeRefreshToken(token, {
      ip: clientIp(req), userAgent: (req.headers['user-agent'] as string) || null, zone: clientZone(req),
    });
    if (r.kind === 'refused') {
      reply.clearCookie(REFRESH_COOKIE, { path: '/' });
      return reply.code(401).send({ error: 'invalid_refresh' });
    }
    // A session entered without a password, outside the home network. The cookie is left alone: back home it works
    // again, and it opens nothing out here (lib/auth.ts exchangeRefreshToken).
    if (r.kind === 'remote') return reply.code(401).send({ error: 'local_only' });
    if (r.kind === 'disabled') {
      reply.clearCookie(REFRESH_COOKIE, { path: '/' });
      return reply.code(403).send({ error: 'disabled' });
    }
    // `grace`: lost a rotation race -- to another tab, or to the page before a reload -- and the winner's token
    // is in the cookie jar they share, or on its way there. The one thing we must not do here is touch the
    // cookie: clearing it, which is what this used to do, throws away the winner's token and signs the device out.
    // `rotated` and `recovered` carry the token the device holds from now on, and the cookie lives exactly as
    // long as it does: a recovered token keeps the lifetime of the one it replaces.
    if (r.kind !== 'grace') {
      reply.setCookie(REFRESH_COOKIE, r.token, { ...cookieOptions(), maxAge: Math.max(1, Math.floor((r.expiresAt - Date.now()) / 1000)) });
      // A session refreshed from another network than its last (lib/clientAddr.ts sameNetwork): said in the activity log,
      // once a day per session at most, and never acted on -- Wi-Fi to mobile data looks the same from here as a copied
      // cookie does. Reintroduce a sign-out here and every phone that leaves
      // the house is signed out.
      if (r.kind === 'rotated' && r.moved && !(await one(
        `SELECT 1 FROM audit_log WHERE event = 'session.ip_change' AND detail->>'session' = $1 AND at > now() - interval '1 day'`,
        [r.moved.session]))) {
        await logAudit('session.ip_change', { userId: r.userId, detail: { session: r.moved.session, from: r.moved.from }, req });
      }
    }
    setImgCookie(app, reply, r.userId, r.local);
    return reply.send({ ...signAccess(app, r.userId, r.role, r.local), user: await userPayload(r.userId), refreshExpiresAt: r.expiresAt });
  });

  // ---- "who is reading?" at home ----

  /** Whether an admin turned the sign-in screen's "who is reading?" on (Admin -> Settings -> Server). Never on desktop. */
  const localPickOn = async () => !isDesktop()
    && !!(await one<{ on: boolean }>('SELECT local_pick AS on FROM server_settings WHERE id = 1'))?.on;

  /**
   * The profiles the sign-in screen offers at home without a password, when an admin turned it on: the enabled ones that
   * open at home. Outside the home network, or with it off, none -- the same answer either way, so it says nothing
   * about which.
   */
  app.get('/auth/pick', async (req) => {
    if (clientZone(req) !== 'local' || !(await localPickOn())) return { content: [] };
    const rows = await q<{ id: string; display_name: string; avatar: unknown }>(
      `SELECT id, display_name, avatar FROM users WHERE local_open AND NOT disabled AND role <> 'admin' ORDER BY lower(display_name), id`);
    return { content: rows.map((r) => ({ id: r.id, displayName: r.display_name, avatar: r.avatar ?? {} })) };
  });

  /**
   * Sign in as one of those profiles from the sign-in screen, at home, without a password: a session of its own
   * (`via: 'local-pick'`), held to home on every request and making no credential, as a switched-to one is. Every
   * refusal is one answer -- off, outside, no such profile -- written down at most once a minute: the route answers
   * anyone at home. Reintroduce any check by dropping it: its case in profileLocalPick.int.test.ts signs in.
   */
  app.post('/auth/profile-login', { config: SIGN_IN_LIMIT }, async (req, reply) => {
    const b = z.object({ profileId: z.string().uuid(), deviceId: z.string().max(128).optional(), deviceName: z.string().max(128).optional() })
      .safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const target = clientZone(req) === 'local' && (await localPickOn())
      ? await one<{ id: string; role: string; username: string | null }>(
        `SELECT id, role, username FROM users WHERE id = $1 AND local_open AND NOT disabled AND role <> 'admin'`, [b.data.profileId])
      : null;
    if (!target) {
      const attempts = auditEvery('login.fail:local_pick');
      if (attempts !== null) await logAudit('login.fail', { detail: { reason: 'local_pick', attempts }, req });
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    const refresh = await issueRefreshToken(target.id, {
      via: 'local-pick', deviceId: b.data.deviceId, deviceName: b.data.deviceName,
      ip: clientIp(req), userAgent: (req.headers['user-agent'] as string) || null,
    });
    reply.setCookie(REFRESH_COOKIE, refresh, cookieOptions());
    setImgCookie(app, reply, target.id, true);
    reply.clearCookie(KOMGA_SESSION_COOKIE, { path: '/' });
    await logAudit('login.ok', { userId: target.id, username: target.username ?? undefined, detail: { via: 'local-pick' }, req });
    return reply.send({ ...signAccess(app, target.id, target.role, true), user: await userPayload(target.id), refreshExpiresAt: refreshExpiresAt() });
  });

  // ---- the device keyring (lib/deviceRing.ts) ----

  /**
   * The accounts this device remembers, for the sign-in screen and the profile photo: no session needed, the device's
   * own cookie is the key, as the refresh cookie is. A session entered without a password is listed at home only, where
   * it opens.
   */
  app.get('/auth/ring', async (req) => {
    const key = deviceKeyOf(req);
    if (!key || isDesktop()) return { content: [] };
    const home = clientZone(req) === 'local';
    return {
      content: (await ringOf(key)).filter((r) => home || !withoutCredential(r.via))
        .map((r) => ({ id: r.userId, displayName: r.displayName, avatar: r.avatar ?? {} })),
    };
  });

  /**
   * Take up a session this device remembers, without its password: its token is superseded as a refresh would, and the
   * device's cookie becomes it. An admin remembered longer than ADMIN_RESUME_HOURS signs in again (`reauth`, and the
   * entry is forgotten); a session entered without a password does so at home only. A session the device held and did
   * not remember is ended rather than left live with no cookie anywhere. The sign-in limit applies: the route answers
   * without a session. Reintroduce any check by dropping it: its case in deviceRing.int.test.ts resumes.
   */
  app.post('/auth/resume', { config: SIGN_IN_LIMIT }, async (req, reply) => {
    const b = z.object({ profileId: z.string().uuid() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const key = deviceKeyOf(req);
    const [r] = key && !isDesktop() ? await ringOf(key, b.data.profileId) : [];
    if (!key || !r) {
      // Anyone can ask this, with no session: written down at most once a minute, as "who is reading?" is, and against
      // nobody -- the id is the caller's word, not an account that tried to sign in.
      const attempts = auditEvery('login.fail:not_remembered');
      if (attempts !== null) await logAudit('login.fail', { detail: { reason: 'not_remembered', attempts }, req });
      return reply.code(401).send({ error: 'not_remembered' });
    }
    const local = withoutCredential(r.via);
    if (local && clientZone(req) !== 'local') return reply.code(401).send({ error: 'local_only' });
    if (r.role === 'admin' && (!r.startedAt || r.startedAt.getTime() < Date.now() - ADMIN_RESUME_HOURS * 3600_000)) {
      await forgetRemembered(key, r.userId);
      return reply.code(401).send({ error: 'reauth' });
    }
    const held = req.cookies?.[REFRESH_COOKIE];
    const cur = held ? await validateRefreshToken(held) : null;
    const token = await resumeHead(r.head, { ip: clientIp(req), userAgent: (req.headers['user-agent'] as string) || null });
    if (!token) return reply.code(401).send({ error: 'not_remembered' });
    if (cur && cur.userId !== r.userId && !(await isRemembered(key, cur.sessionId))) await revokeRefreshToken(held!);
    await noteResumed(key, r.userId);
    reply.setCookie(REFRESH_COOKIE, token, { ...cookieOptions(), maxAge: Math.max(1, Math.floor((r.head.expiresAt.getTime() - Date.now()) / 1000)) });
    setImgCookie(app, reply, r.userId, local);
    reply.clearCookie(KOMGA_SESSION_COOKIE, { path: '/' });
    await logAudit('login.switch', { userId: r.userId, detail: { from: cur?.userId ?? null, via: 'ring' }, req });
    return reply.send({ ...signAccess(app, r.userId, r.role, local), user: await userPayload(r.userId), refreshExpiresAt: r.head.expiresAt.getTime() });
  });

  /**
   * Sign in as someone else without forgetting who was here: a session this device remembers is put aside -- the cookies
   * go, the session stays live for /auth/resume -- and any other is ended, exactly as /auth/logout ends it.
   */
  app.post('/auth/leave', async (req, reply) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    const cur = token ? await validateRefreshToken(token) : null;
    const key = deviceKeyOf(req);
    const kept = !!(cur && key && (await isRemembered(key, cur.sessionId)));
    if (token && !kept) await revokeRefreshToken(token);
    reply.clearCookie(REFRESH_COOKIE, { path: '/' });
    reply.clearCookie(IMG_COOKIE, { path: '/' });
    reply.clearCookie(KOMGA_SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true, remembered: kept });
  });

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (token) await revokeRefreshToken(token);
    reply.clearCookie(REFRESH_COOKIE, { path: '/' });
    reply.clearCookie(IMG_COOKIE, { path: '/' });
    // The Komga-compatible API mints its seven-day UCHIYOMI-SESSION cookie on every credentialed request, and a
    // BROWSER gets one too the moment it calls /api/v1/* with an X-API-Key -- the API reference's "try it", a
    // same-origin fetch. Signing out must not leave a cookie behind that still opens the compat routes as
    // that token until it expires. Same attributes as the mint (path '/'), or the browser keeps the old one.
    // Reintroduce by dropping this line: "signing out clears the Komga session cookie too" in
    // komgaCompat.int.test.ts sees no Set-Cookie for it.
    reply.clearCookie(KOMGA_SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });

  app.get('/auth/me', { preHandler: [authenticate] }, async (req) => userPayload(userIdOf(req)));

  // ---- switching to a profile that opens at home ----

  /**
   * The profiles this session may switch to: the ones that open at home and this account manages -- every one, for an
   * admin. From home only, where switching to them works; outside the list is empty and says why (`zone`), and so is
   * it for a session that was itself entered without a password, which switches nowhere.
   */
  app.get('/auth/profiles', { preHandler: [authenticate] }, async (req) => {
    const zone = clientZone(req);
    if (zone !== 'local' || (req.user as { loc?: unknown }).loc === true) return { zone, content: [] };
    const me = userIdOf(req);
    const rows = await q<{ id: string; display_name: string; avatar: unknown }>(
      `SELECT id, display_name, avatar FROM users
        WHERE local_open AND NOT disabled AND id <> $1 AND (managed_by = $1 OR $2)
        ORDER BY lower(display_name), id`, [me, actsAsAdmin(req)]);
    return { zone, content: rows.map((r) => ({ id: r.id, displayName: r.display_name, avatar: r.avatar ?? {} })) };
  });

  /**
   * Switch this device to a profile that opens at home, without its password. The caller is a session
   * entered with a credential -- the device's own, by its refresh cookie, not just an access token a script could hold
   * -- of the account that manages the profile, or of an admin, at home. The profile's session is opened FROM it
   * (`parent_session`): it ends when that one ends (lib/auth.ts revokeDerived), lasts no longer than it would, holds at
   * home only, and makes no credential (`via: 'switch'`). The answer is a sign-in's, and the device's cookie becomes
   * the profile's. Reintroduce any check by dropping it: its case in profileSwitch.int.test.ts switches.
   */
  app.post('/auth/switch', { preHandler: [authenticate, requireCredentialSession], config: SIGN_IN_LIMIT }, async (req, reply) => {
    const b = z.object({ profileId: z.string().uuid() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const me = userIdOf(req);
    const token = req.cookies?.[REFRESH_COOKIE];
    const cur = token ? await validateRefreshToken(token) : null;
    if (!cur || cur.userId !== me) return reply.code(401).send({ error: 'no_session' });
    if (withoutCredential(cur.via)) return reply.code(403).send({ error: 'credential_required' });
    if (clientZone(req) !== 'local') return reply.code(401).send({ error: 'local_only' });
    const target = await one<{ id: string; role: string; username: string | null; disabled: boolean; local_open: boolean; managed_by: string | null }>(
      'SELECT id, role, username, disabled, local_open, managed_by FROM users WHERE id = $1', [b.data.profileId]);
    if (!target || target.disabled || !target.local_open || target.id === me || (target.managed_by !== me && !actsAsAdmin(req))) {
      await logAudit('login.fail', { userId: me, detail: { reason: 'switch_denied', profile: b.data.profileId }, req });
      return reply.code(403).send({ error: 'switch_denied' });
    }
    const refresh = await issueRefreshToken(target.id, {
      via: 'switch', parentSession: cur.sessionId, expiresAt: cur.expiresAt,
      deviceId: cur.deviceId ?? undefined, deviceName: cur.deviceName ?? undefined,
      ip: clientIp(req), userAgent: (req.headers['user-agent'] as string) || null,
    });
    reply.setCookie(REFRESH_COOKIE, refresh, { ...cookieOptions(), maxAge: Math.max(1, Math.floor((cur.expiresAt.getTime() - Date.now()) / 1000)) });
    setImgCookie(app, reply, target.id, true);
    // As at sign-out: a Komga session cookie a browser picked up belongs to the account it leaves.
    reply.clearCookie(KOMGA_SESSION_COOKIE, { path: '/' });
    await logAudit('login.switch', { userId: target.id, username: target.username ?? undefined, detail: { from: me, via: 'guardian' }, req });
    return reply.send({ ...signAccess(app, target.id, target.role, true), user: await userPayload(target.id), refreshExpiresAt: cur.expiresAt.getTime() });
  });

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
  if (local) app.post('/auth/password', { preHandler: [authenticate, requireCredentialSession], config: SIGN_IN_LIMIT }, async (req, reply) => {
    const body = z.object({ current: z.string(), next: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const uid = userIdOf(req);
    const refused = await currentPasswordRefusal(req, body.data.current);
    if (refused) return reply.code(refused.status).send(refused.body);
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
  if (local) app.post('/auth/totp/setup', { preHandler: [authenticate, requireCredentialSession] }, async (req, reply) => {
    const uid = userIdOf(req);
    const u = await one<{ username: string | null; totp_enabled: boolean }>('SELECT username, totp_enabled FROM users WHERE id = $1', [uid]);
    // ⚠️ Setup is for an account WITHOUT a second step. With 2FA on, the secret in the row is the one the
    // authenticator app holds, and this route used to overwrite it unconditionally, so a stale "Set up 2FA"
    // button (a profile tab remounted with an old `totpEnabled`) rotated a live secret: the app's codes
    // stopped matching, the flag stayed true, and the next login needed a recovery code. Off first, then
    // set up again; the disable route is the only way out. Reintroduce by dropping this check.
    const refuse = () => reply.code(409).send({ error: 'totp_enabled', message: 'Two-factor authentication is already on. Turn it off first to set it up again.' });
    if (!u) return reply.code(401).send({ error: 'unauthorized' }); // a token that outlived its account
    if (u.totp_enabled) return refuse();
    const secret = generateSecret();
    // The write carries the same condition, so an enable that lands between the SELECT and this UPDATE
    // (two tabs) still cannot have its live secret replaced; a row it did not touch is the same refusal.
    // A new secret has used no step yet (lib/auth.ts spendTotpStep), so the last one goes with the old secret.
    const wrote = await q<{ id: string }>('UPDATE users SET totp_secret = $2, totp_last_step = NULL WHERE id = $1 AND NOT totp_enabled RETURNING id', [uid, secret]); // pending until enabled
    if (!wrote.length) return refuse();
    const uri = otpauthURL(secret, u.username || 'user');
    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 240 }).catch(() => '');
    return { secret, otpauth: uri, qr };
  });

  if (local) app.post('/auth/totp/enable', { preHandler: [authenticate, requireCredentialSession], config: SIGN_IN_LIMIT }, async (req, reply) => {
    const body = z.object({ code: z.string(), password: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const uid = userIdOf(req);
    // The password first (v0.77.1), as turning two-factor off asks for it: a session alone must not be able to put its
    // own authenticator on the account and leave the owner's next sign-in asking for a code they cannot give.
    // Reintroduce by dropping the check: "turning two-factor on asks for the password" in accountLock.int.test.ts
    // enables it with a wrong one.
    const refused = await currentPasswordRefusal(req, body.data.password);
    if (refused) return reply.code(refused.status).send(refused.body);
    const invalid = () => reply.code(400).send({ error: 'totp_invalid', message: 'Incorrect code — try again.' });
    const u = await one<{ totp_secret: string | null }>('SELECT totp_secret FROM users WHERE id = $1', [uid]);
    const step = u?.totp_secret ? totpStep(u.totp_secret, body.data.code) : null;
    if (step === null) return invalid();
    const codes = generateRecoveryCodes();
    // The code that turns it on is spent like a sign-in's (spendTotpStep), in the write, and only against the secret it
    // was checked with: a setup in another tab between the two statements changes nothing.
    const done = await one(
      `UPDATE users SET totp_enabled = true, recovery_codes = $2, totp_last_step = $3
        WHERE id = $1 AND totp_secret = $4 AND (totp_last_step IS NULL OR totp_last_step < $3) RETURNING id`,
      [uid, codes.map((c) => sha256(c)), step, u!.totp_secret]);
    if (!done) return invalid();
    await logAudit('totp.enable', { userId: uid, req });
    return reply.send({ ok: true, recoveryCodes: codes });
  });

  if (local) app.post('/auth/totp/disable', { preHandler: [authenticate, requireCredentialSession], config: SIGN_IN_LIMIT }, async (req, reply) => {
    const body = z.object({ password: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const uid = userIdOf(req);
    const refused = await currentPasswordRefusal(req, body.data.password);
    if (refused) return reply.code(refused.status).send(refused.body);
    await q("UPDATE users SET totp_enabled = false, totp_secret = NULL, recovery_codes = '{}', totp_last_step = NULL WHERE id = $1", [uid]);
    await logAudit('totp.disable', { userId: uid, req });
    return reply.send({ ok: true });
  });
}
