// SSO-only mode (v0.63.0, #208), pinned against the real routes, a real provider -- an issuer with keys, discovery and
// a token endpoint, as oidc.test.ts serves them -- and a database of its own: a new server's first admin is made by its
// first sign-in, so this file needs a users table that is empty whatever ran before it, and creates one for that.
//
//   - the password routes are not there at all, and the sign-in config says the server signs in through SSO only;
//   - a new server's first sign-in makes its admin: the subject OIDC_BOOTSTRAP_ADMIN_SUB names, else the admin group;
//   - two first sign-ins at once make one admin;
//   - the server's last admin stays one when the provider puts them outside the admin group;
//   - Members makes no account and sets no password;
//   - the rescue opens one admin's password sign-in and nobody else's;
//   - a link from Profile → Account joins an identity to the account signed in on that browser, never another, and
//     that account then signs in through the provider.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, createSign } from 'node:crypto';
import type { AddressInfo } from 'node:net';

const DSN = process.env.TEST_DATABASE_URL;
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
const CLIENT_ID = 'uchiyomi-sso-test';
const GROUP = 'uchi-admins';
const ORIGIN = 'http://uchi.test';
const PASS = 'rescue-passw0rd-1';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

let idp: Server;
let issuer = '';
/** The identity the provider answers each authorization code with, and the nonce of the sign-in it belongs to. */
const codes = new Map<string, Record<string, unknown>>();

function mint(payload: Record<string, unknown>): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: 'k1' };
  const now = Math.floor(Date.now() / 1000);
  const body = { iss: issuer, aud: CLIENT_ID, iat: now, exp: now + 300, ...payload };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(body))}`;
  return `${input}.${b64u(createSign('RSA-SHA256').update(input).sign(privateKey))}`;
}

let DBNAME = '';
let q: any, one: any, pool: any, hash: any;

before(async () => {
  if (!DSN) return;
  idp = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/.well-known/openid-configuration') {
        res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` }));
      } else if (req.url === '/jwks') {
        res.end(JSON.stringify({ keys: [jwk] }));
      } else if (req.url === '/token' && req.method === 'POST') {
        const who = codes.get(new URLSearchParams(body).get('code') ?? '');
        if (!who) { res.statusCode = 400; res.end('{"error":"invalid_grant"}'); return; }
        res.end(JSON.stringify({ id_token: mint(who) }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  await new Promise<void>((go) => idp.listen(0, '127.0.0.1', go));
  issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;

  // A database of this file's own: the first sign-in on a server with no account is the case under test.
  const { Client } = await import('pg');
  const admin = new Client({ connectionString: DSN });
  await admin.connect();
  DBNAME = `${decodeURIComponent(new URL(DSN).pathname.slice(1))}_sso`;
  await admin.query(`DROP DATABASE IF EXISTS "${DBNAME}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${DBNAME}"`);
  await admin.end();
  const url = new URL(DSN);
  url.pathname = `/${DBNAME}`;
  process.env.DATABASE_URL = url.toString();
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.PUBLIC_ORIGIN = ORIGIN;
  process.env.OIDC_ISSUER = issuer;
  process.env.OIDC_CLIENT_ID = CLIENT_ID;
  process.env.OIDC_ADMIN_GROUP = GROUP;
  delete process.env.OIDC_ALLOW_SIGNUP;
  delete process.env.OIDC_LINK_BY_USERNAME;
  ({ hash } = await import('@node-rs/argon2'));
  // An install that seeded its admin from the environment, now in SSO-only mode: the seed is skipped, or the first test
  // finds an account where it expects none. Reintroduce by dropping `!ssoOnly()` from migrate()'s seed.
  process.env.INITIAL_USER_PASSWORD_HASH_B64 = Buffer.from(await hash('seed-passw0rd-1')).toString('base64');
  process.env.AUTH_MODE = 'oidc-only';

  const { migrate } = await import('../src/lib/migrate');
  await migrate();
  ({ q, one, pool } = (await import('../src/lib/db')) as any);
  // Open registration on, so that SSO-only mode's "no sign-up" is the mode's doing and not the setting's.
  await q('UPDATE server_settings SET allow_registration = true WHERE id = 1');
});

after(async () => {
  if (!DSN) return;
  for (const k of ['AUTH_MODE', 'AUTH_RESCUE_ADMIN', 'OIDC_BOOTSTRAP_ADMIN_SUB', 'INITIAL_USER_PASSWORD_HASH_B64']) delete process.env[k];
  await pool?.end();
  idp?.close();
  const { Client } = await import('pg');
  const admin = new Client({ connectionString: DSN });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${DBNAME}" WITH (FORCE)`).catch(() => {});
  await admin.end();
});

/** A server in a mode, as the routes read it when they are registered (lib/authMode.ts reads the environment then). */
async function appFor(o: { mode: 'oidc-only' | 'local'; rescue?: string }) {
  process.env.AUTH_MODE = o.mode;
  if (o.rescue) process.env.AUTH_RESCUE_ADMIN = o.rescue;
  else delete process.env.AUTH_RESCUE_ADMIN;
  const Fastify = (await import('fastify')).default;
  const app = Fastify();
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/auth')).default);
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  return app;
}

type Who = { sub: string; preferred_username?: string; groups?: string[] };
let n = 0;

/**
 * A sign-in through the provider, as a browser makes one: `/auth/oidc/start` (or `/auth/oidc/link` with this
 * browser's session cookie), the provider answering with `who`, the callback. Where it ended up, the reason the
 * sign-in screen is given, the link result the profile is given, and the session cookie when one was set.
 */
async function viaProvider(app: any, who: Who, o: { path?: string; rt?: string } = {}) {
  const start = await app.inject({ method: 'GET', url: o.path ?? '/auth/oidc/start', cookies: o.rt ? { yomi_rt: o.rt } : {} });
  assert.equal(start.statusCode, 302, start.body);
  const at = new URL(String(start.headers.location));
  if (!at.href.startsWith(issuer)) return { to: at, reason: null, link: null, rt: undefined as string | undefined };
  const code = `code-${++n}`;
  codes.set(code, { ...who, nonce: at.searchParams.get('nonce') });
  const ticket = start.cookies.find((c: any) => c.name === 'yomi_oidc')?.value;
  const cb = await app.inject({ method: 'GET', url: `/auth/oidc/callback?code=${code}&state=${at.searchParams.get('state')}`, cookies: { yomi_oidc: ticket } });
  assert.equal(cb.statusCode, 302, cb.body);
  const to = new URL(String(cb.headers.location));
  return { to, reason: to.searchParams.get('sso_error'), link: to.searchParams.get('sso_link'), rt: cb.cookies.find((c: any) => c.name === 'yomi_rt')?.value as string | undefined };
}

const userBy = (field: string, value: string) => one(`SELECT id, username, role, oidc_sub, password_hash FROM users WHERE ${field} = $1`, [value]);
const accounts = async () => Number((await one('SELECT count(*)::int AS c FROM users')).c);
/** An account with a password and no link: what every account is on a server that has never used SSO. */
async function local(username: string, role: 'admin' | 'user') {
  const [row] = await q(`INSERT INTO users (display_name, username, role, password_hash, auth_kind) VALUES ($1, $1, $2, $3, 'password') RETURNING id`,
    [username, role, await hash(PASS)]);
  return row.id as string;
}

test('the password routes are not there at all, and the sign-in config says SSO only', { skip }, async () => {
  const app = await appFor({ mode: 'oidc-only' });
  try {
    // Reintroduce any one (drop its `if (local)` in routes/auth.ts): its line here reads 400 or 401, not 404.
    for (const url of ['/api/setup', '/auth/login', '/auth/register', '/auth/password', '/auth/totp/setup', '/auth/totp/enable', '/auth/totp/disable']) {
      const r = await app.inject({ method: 'POST', url, payload: {} });
      assert.equal(r.statusCode, 404, `POST ${url} answered ${r.statusCode}`);
    }
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/setup/status' })).json(), { needsSetup: false }, 'a new server offers a setup form');
    const c = (await app.inject({ method: 'GET', url: '/auth/config' })).json();
    assert.deepEqual([c.mode, c.allowRegistration, c.oidc.enabled, 'rescue' in c], ['oidc-only', false, true, false]);
  } finally {
    await app.close();
  }
  // The same server in local mode: every route is back, and Open registration says so.
  const lo = await appFor({ mode: 'local' });
  try {
    assert.equal((await lo.inject({ method: 'POST', url: '/auth/login', payload: {} })).statusCode, 400);
    assert.equal((await lo.inject({ method: 'GET', url: '/auth/config' })).json().allowRegistration, true);
  } finally {
    await lo.close();
  }
});

test('a new server\'s first sign-in makes its admin: the subject OIDC_BOOTSTRAP_ADMIN_SUB names', { skip }, async () => {
  process.env.OIDC_BOOTSTRAP_ADMIN_SUB = 'boss-sub';
  const app = await appFor({ mode: 'oidc-only' });
  try {
    assert.equal(await accounts(), 0, 'PREMISE: a server with no account');
    // Anyone else first -- even in the admin group, with a subject named -- is told the server is not set up yet.
    // Reintroduce the group as a second door: the stranger takes the server.
    const early = await viaProvider(app, { sub: 'stranger-sub', preferred_username: 'stranger', groups: [GROUP] });
    assert.equal(early.reason, 'not_set_up');
    assert.equal(await accounts(), 0);
    // The named subject is the admin, whatever OIDC_ALLOW_SIGNUP says (off here): this is the server's admin, not a sign-up.
    const boss = await viaProvider(app, { sub: 'boss-sub', preferred_username: 'boss', groups: [] });
    assert.equal(boss.reason, null);
    assert.equal(boss.to.href, `${ORIGIN}/`);
    assert.ok(boss.rt, 'the first admin is signed in');
    const row = await userBy('oidc_sub', 'boss-sub');
    assert.deepEqual([row.username, row.role], ['boss', 'admin']);
    assert.ok(await one(`SELECT 1 FROM audit_log WHERE event = 'setup.complete' AND user_id = $1`, [row.id]), 'the setup is not in the activity log');
    // Past the first admin, anyone new is a sign-up, and sign-up is off.
    assert.equal((await viaProvider(app, { sub: 'stranger-sub', preferred_username: 'stranger', groups: [GROUP] })).reason, 'no_account');
    assert.equal(await accounts(), 1);
  } finally {
    await app.close();
  }
});

test('the server\'s last admin stays one when the provider puts them outside the admin group', { skip }, async () => {
  const app = await appFor({ mode: 'oidc-only' });
  try {
    // OIDC_ADMIN_GROUP is set and the first admin is in no group: roles follow the provider at every sign-in...
    await viaProvider(app, { sub: 'boss-sub', preferred_username: 'boss', groups: [] });
    // ...but never the last admin out of being one. Reintroduce by dropping the guard in resolveOidcUser: user.
    assert.equal((await userBy('oidc_sub', 'boss-sub')).role, 'admin');
    // Another admin: the provider's word stands again.
    await q(`INSERT INTO users (display_name, username, role, password_hash, auth_kind, oidc_issuer, oidc_sub)
             VALUES ('second', 'second', 'admin', 'x', 'oidc', $1, 'second-sub')`, [issuer]);
    await viaProvider(app, { sub: 'boss-sub', preferred_username: 'boss', groups: [] });
    assert.equal((await userBy('oidc_sub', 'boss-sub')).role, 'user');
    await q(`UPDATE users SET role = 'admin' WHERE oidc_sub = 'boss-sub'`);
    await q(`DELETE FROM users WHERE oidc_sub = 'second-sub'`);
  } finally {
    await app.close();
  }
});

test('Members makes no account and sets no password', { skip }, async () => {
  const app = await appFor({ mode: 'oidc-only' });
  try {
    const boss = await userBy('oidc_sub', 'boss-sub');
    const member = await local('member-pw', 'user');
    const headers = { authorization: `Bearer ${app.jwt.sign({ sub: boss.id, role: 'admin' })}` };
    // Reintroduce by dropping either refusal in routes/admin.ts: a 200, and an account with a password.
    const made = await app.inject({ method: 'POST', url: '/api/admin/users', headers, payload: { username: 'newbie', password: 'long-enough-1' } });
    assert.deepEqual([made.statusCode, made.json().error], [403, 'sso_only'], made.body);
    assert.equal(await userBy('username', 'newbie'), null);
    const before = (await userBy('id', member)).password_hash;
    const set = await app.inject({ method: 'PATCH', url: `/api/admin/users/${member}`, headers, payload: { password: 'long-enough-2', displayName: 'Changed' } });
    assert.deepEqual([set.statusCode, set.json().error], [403, 'sso_only'], set.body);
    assert.equal((await userBy('id', member)).password_hash, before, 'the password changed');
    assert.equal((await one('SELECT display_name FROM users WHERE id = $1', [member])).display_name, 'member-pw', 'half the refused change was written');
    // Everything else Members does still works.
    const named = await app.inject({ method: 'PATCH', url: `/api/admin/users/${member}`, headers, payload: { displayName: 'Renamed' } });
    assert.equal(named.statusCode, 200, named.body);
    const list = (await app.inject({ method: 'GET', url: '/api/admin/users', headers })).json();
    assert.deepEqual(list.auth, { mode: 'oidc-only', sso: 'SSO', signup: false });
    const sso = Object.fromEntries(list.content.map((u: any) => [u.username, u.sso]));
    assert.deepEqual([sso.boss, sso['member-pw']], [true, false], 'Members cannot tell linked accounts from the rest');
  } finally {
    await app.close();
  }
});

test('the rescue opens one admin\'s password sign-in and nobody else\'s', { skip }, async () => {
  await local('rescuer', 'admin');
  await local('member-rescue', 'user');
  const login = (app: any, username: string, password = PASS) => app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } });
  const shut = await appFor({ mode: 'oidc-only' });
  try {
    assert.equal((await login(shut, 'rescuer')).statusCode, 404, 'with no rescue named, password sign-in is not there');
  } finally {
    await shut.close();
  }
  const open = await appFor({ mode: 'oidc-only', rescue: 'rescuer' });
  try {
    const ok = await login(open, 'rescuer');
    assert.equal(ok.statusCode, 200, ok.body);
    assert.ok(await one(`SELECT 1 FROM audit_log WHERE event = 'login.rescue'`), 'a rescue sign-in is not written down as one');
    // Reintroduce by dropping the rescue check in /auth/login: the member signs in with a password.
    assert.equal((await login(open, 'member-rescue')).statusCode, 401);
    assert.equal((await login(open, 'rescuer', 'wrong-passw0rd-1')).statusCode, 401);
    assert.equal((await open.inject({ method: 'GET', url: '/auth/config' })).json().rescue, true);
    // Sign-in only: the other password routes stay away.
    for (const url of ['/auth/register', '/auth/password', '/auth/totp/setup', '/api/setup']) {
      assert.equal((await open.inject({ method: 'POST', url, payload: {} })).statusCode, 404, url);
    }
  } finally {
    await open.close();
  }
  // A rescue name that is no admin opens nothing.
  const member = await appFor({ mode: 'oidc-only', rescue: 'member-rescue' });
  try {
    assert.equal((await login(member, 'member-rescue')).statusCode, 401);
  } finally {
    await member.close();
  }
});

test('a link joins an identity to the account signed in on that browser, never another, and it then signs in by SSO', { skip }, async () => {
  const linker = await local('linker', 'user');
  const bystander = await local('bystander', 'user');
  const app = await appFor({ mode: 'local' });
  const rtOf = async (username: string) => (await app.inject({ method: 'POST', url: '/auth/login', payload: { username, password: PASS } }))
    .cookies.find((c: any) => c.name === 'yomi_rt')?.value as string;
  try {
    // No session on this browser: to the sign-in screen, and nothing is asked of the provider.
    assert.equal((await viaProvider(app, { sub: 'x' }, { path: '/auth/oidc/link' })).to.href, `${ORIGIN}/login`);
    // The account is the session's. A query naming another is ignored. Reintroduce by taking it from the query:
    // the bystander's account is the one linked.
    const done = await viaProvider(app, { sub: 'linker-sub', preferred_username: 'someone-else' },
      { path: `/auth/oidc/link?user=${bystander}`, rt: await rtOf('linker') });
    assert.equal(done.link, 'ok');
    assert.equal(done.to.pathname, '/profile/');
    assert.equal(done.rt, undefined, 'a link signs nobody in');
    assert.equal((await userBy('id', linker)).oidc_sub, 'linker-sub');
    assert.equal((await userBy('id', bystander)).oidc_sub, null);
    // One identity, one account: the same identity from the bystander's browser is refused.
    const twice = await viaProvider(app, { sub: 'linker-sub' }, { path: '/auth/oidc/link', rt: await rtOf('bystander') });
    assert.equal(twice.link, 'taken');
    assert.equal((await userBy('id', bystander)).oidc_sub, null);
  } finally {
    await app.close();
  }
  // Turned on afterwards, SSO-only mode lets the linked account in through the provider.
  const sso = await appFor({ mode: 'oidc-only' });
  try {
    const back = await viaProvider(sso, { sub: 'linker-sub', preferred_username: 'linker' });
    assert.equal(back.reason, null);
    assert.ok(back.rt);
    // The session is the linker's, and the account says it is linked (Profile → Account reads `sso`).
    const me = (await sso.inject({ method: 'POST', url: '/auth/refresh', cookies: { yomi_rt: back.rt! } })).json().user;
    assert.deepEqual([me.id, me.sso], [linker, true]);
  } finally {
    await sso.close();
  }
});

test('two first sign-ins at once make one admin', { skip }, async () => {
  // A new server again, its first admin from the group this time (no subject named).
  await q('TRUNCATE users CASCADE');
  delete process.env.OIDC_BOOTSTRAP_ADMIN_SUB;
  const app = await appFor({ mode: 'oidc-only' });
  // The window between counting the accounts and making the admin held open, so the two meet inside it every run.
  const { _setFirstAdminPause } = await import('../src/routes/auth');
  _setFirstAdminPause(300);
  try {
    const both = await Promise.all([
      viaProvider(app, { sub: 'race-a', preferred_username: 'race-a', groups: [GROUP] }),
      viaProvider(app, { sub: 'race-b', preferred_username: 'race-b', groups: [GROUP] }),
    ]);
    // Reintroduce by counting outside the lock (drop the advisory lock in firstAdmin, routes/auth.ts): two admins.
    assert.equal(Number((await one(`SELECT count(*)::int AS c FROM users WHERE role = 'admin'`)).c), 1);
    assert.deepEqual(both.map((b) => b.reason).sort(), ['no_account', null].sort());
  } finally {
    _setFirstAdminPause(0);
    await app.close();
  }
});
