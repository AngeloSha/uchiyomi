// New-member defaults (#208, item 6), pinned against the real routes, a real provider -- an issuer with keys, discovery
// and a token endpoint, as ssoOnly.int.test.ts serves them -- and a database of this file's own: the first admin is one of
// the accounts the defaults must leave alone, and only a server with no account makes one.
//
//   - with nothing set, a sign-up and a first sign-in through the provider are made exactly as before;
//   - a sign-up, and a first sign-in through the provider, start with each default: the libraries, the age limit and
//     no downloads -- in SSO-only mode too;
//   - none is none, and a default library that is gone leaves the choice of none, never every library;
//   - one the provider makes an admin is unrestricted while it is one, and limited the day the provider makes it a member;
//   - the first admin (setup, or SSO-only mode's first sign-in) and an account an admin makes in Members start with
//     everything, and changing the defaults changes no account that exists;
//   - PATCH refuses what a member's PATCH refuses, and writes nothing then.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, createSign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
// STATICALLY imported: `await import('zod')` resolves to a different module instance than the routes' own, so
// `instanceof ZodError` would be false in the handler below and a refused body would read 500 instead of 400.
import { ZodError } from 'zod';

const DSN = process.env.TEST_DATABASE_URL;
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
const CLIENT_ID = 'uchiyomi-defaults-test';
const GROUP = 'nd-admins';
const ORIGIN = 'http://uchi.test';
const PASSWORD = 'a-long-enough-passw0rd';
const KIDS = 'lib_0d0d0d0d0d0d0d01';
const TEENS = 'lib_0d0d0d0d0d0d0d02';
const GONE = 'lib_0d0d0d0d0d0d0d03';

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
let q: any, one: any, pool: any, viewCtxFor: any;

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

  const { Client } = await import('pg');
  const admin = new Client({ connectionString: DSN });
  await admin.connect();
  DBNAME = `${decodeURIComponent(new URL(DSN).pathname.slice(1))}_defaults`;
  await admin.query(`DROP DATABASE IF EXISTS "${DBNAME}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${DBNAME}"`);
  await admin.end();
  const url = new URL(DSN);
  url.pathname = `/${DBNAME}`;
  process.env.DATABASE_URL = url.toString();
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.PUBLIC_ORIGIN = ORIGIN;
  process.env.OIDC_ISSUER = issuer;
  process.env.OIDC_CLIENT_ID = CLIENT_ID;
  process.env.OIDC_ADMIN_GROUP = GROUP;
  // A first sign-in makes an account: the second of the two paths the defaults are for.
  process.env.OIDC_ALLOW_SIGNUP = 'true';
  delete process.env.OIDC_LINK_BY_USERNAME;
  delete process.env.INITIAL_USER_PASSWORD_HASH_B64;
  delete process.env.AUTH_RESCUE_ADMIN;
  delete process.env.OIDC_BOOTSTRAP_ADMIN_SUB;
  process.env.AUTH_MODE = 'local';

  const { migrate } = await import('../src/lib/migrate');
  await migrate();
  ({ q, one, pool } = (await import('../src/lib/db')) as any);
  ({ viewCtxFor } = await import('../src/lib/visibility'));
  await q('UPDATE server_settings SET allow_registration = true WHERE id = 1');
  for (const [id, name] of [[KIDS, 'Kids'], [TEENS, 'Teens'], [GONE, 'Gone soon']]) {
    await q('INSERT INTO libraries (id, name, path) VALUES ($1, $2, $3)', [id, name, `nd/${name}`]);
  }
});

after(async () => {
  if (!DSN) return;
  for (const k of ['AUTH_MODE', 'OIDC_BOOTSTRAP_ADMIN_SUB', 'OIDC_ALLOW_SIGNUP']) delete process.env[k];
  await pool?.end();
  idp?.close();
  const { Client } = await import('pg');
  const admin = new Client({ connectionString: DSN });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${DBNAME}" WITH (FORCE)`).catch(() => {});
  await admin.end();
});

/** A server in a mode, as the routes read it when they are registered (lib/authMode.ts reads the environment then). */
async function appFor(mode: 'local' | 'oidc-only' = 'local') {
  process.env.AUTH_MODE = mode;
  const Fastify = (await import('fastify')).default;
  const app = Fastify();
  // The handler server.ts installs, before the routes, so a refused schema answers 400 here as it does there.
  app.setErrorHandler((err: any, _req: any, reply: any) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'bad_request' });
    const status = err.statusCode || 500;
    return reply.code(status).send({ error: status >= 500 ? 'internal' : err.message || 'error' });
  });
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/auth')).default);
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  return app;
}

let n = 0;
/** A sign-in through the provider, as a browser makes one: start, the provider answering with `who`, the callback. */
async function viaProvider(app: any, who: { sub: string; preferred_username?: string; groups?: string[] }) {
  const start = await app.inject({ method: 'GET', url: '/auth/oidc/start' });
  assert.equal(start.statusCode, 302, start.body);
  const at = new URL(String(start.headers.location));
  const code = `code-${++n}`;
  codes.set(code, { ...who, nonce: at.searchParams.get('nonce') });
  const ticket = start.cookies.find((c: any) => c.name === 'yomi_oidc')?.value;
  const cb = await app.inject({ method: 'GET', url: `/auth/oidc/callback?code=${code}&state=${at.searchParams.get('state')}`, cookies: { yomi_oidc: ticket } });
  assert.equal(cb.statusCode, 302, cb.body);
  const to = new URL(String(cb.headers.location));
  assert.equal(to.searchParams.get('sso_error'), null, `the sign-in was refused: ${to.href}`);
  const row = await one('SELECT id, role FROM users WHERE oidc_issuer = $1 AND oidc_sub = $2', [issuer, who.sub]);
  assert.ok(row, `no account for ${who.sub}`);
  return row as { id: string; role: string };
}

async function signUp(app: any, username: string) {
  const r = await app.inject({ method: 'POST', url: '/auth/register', payload: { username, password: PASSWORD } });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().user.id as string;
}

/** An admin to drive the admin routes with, made the way a test makes one: by hand, not by any path under test. */
async function adminHeaders(app: any) {
  let row = await one(`SELECT id FROM users WHERE username = 'nd-root'`);
  if (!row) {
    [row] = await q(`INSERT INTO users (display_name, username, role, password_hash, auth_kind) VALUES ('nd-root', 'nd-root', 'admin', 'x', 'password') RETURNING id`);
  }
  return { authorization: `Bearer ${app.jwt.sign({ sub: row.id, role: 'admin' })}` };
}

const setDefaults = async (app: any, newMemberDefaults: Record<string, unknown>) => {
  const r = await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: await adminHeaders(app), payload: { newMemberDefaults } });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().newMemberDefaults;
};
const NOTHING = { libraries: null, maxAgeRating: null, perms: {} };

/** What an account was made with: its grant rows, its age limit and its permissions, as the database holds them. */
async function made(id: string) {
  const u = await one('SELECT max_age_rating, perms FROM users WHERE id = $1', [id]);
  const rows = await q('SELECT library_id FROM user_libraries WHERE user_id = $1 ORDER BY library_id', [id]);
  return { libraries: rows.map((r: any) => r.library_id), maxAgeRating: u.max_age_rating, perms: u.perms };
}
const ASIS = { libraries: [], maxAgeRating: null, perms: {} };

test('with nothing set, a sign-up and a first sign-in through the provider are made exactly as before', { skip }, async () => {
  const app = await appFor();
  try {
    const got = (await app.inject({ method: 'GET', url: '/api/admin/settings', headers: await adminHeaders(app) })).json();
    assert.deepEqual(got.newMemberDefaults, NOTHING, 'a server that never set the defaults reads some');
    // No grant rows (every library), no age limit, perms {}: what the INSERT alone made before. Reintroduce a write of
    // `{"canDownload": true}` for "allowed": the perms differ from every account made before.
    assert.deepEqual(await made(await signUp(app, 'nd-plain')), ASIS);
    assert.deepEqual(await made((await viaProvider(app, { sub: 'plain-sub', preferred_username: 'nd-plain-sso' })).id), ASIS);
    // Downloads switched off and back on is "allowed" again, stored as an account stores it.
    await setDefaults(app, { perms: { canDownload: false } });
    assert.deepEqual(await setDefaults(app, { perms: { canDownload: true } }), NOTHING);
    assert.deepEqual((await one('SELECT new_member_perms AS p FROM server_settings WHERE id = 1')).p, {}, 'stored unlike an account');
    assert.deepEqual(await made(await signUp(app, 'nd-plain-again')), ASIS);
  } finally {
    await app.close();
  }
});

test('a sign-up starts with the defaults: the libraries, the age limit and no downloads', { skip }, async () => {
  const app = await appFor();
  try {
    const saved = await setDefaults(app, { libraries: [KIDS, TEENS], maxAgeRating: 13, perms: { canDownload: false } });
    assert.deepEqual(saved, { libraries: [KIDS, TEENS], maxAgeRating: 13, perms: { canDownload: false } }, 'PATCH does not answer what it saved');
    // Reintroduce by dropping the call in /auth/register: every library open, no limit, downloads allowed.
    const id = await signUp(app, 'nd-kid');
    assert.deepEqual(await made(id), { libraries: [KIDS, TEENS], maxAgeRating: 13, perms: { canDownload: false } });
    // And they hold: the account's view is restricted from its first request (visibility.ts reads these rows).
    const ctx = await viewCtxFor(id, 'user');
    assert.deepEqual([[...ctx.libraryIds].sort(), ctx.maxAgeRating], [[KIDS, TEENS], 13]);
    // Members shows them on the account's card, as if they had been set there.
    const list = (await app.inject({ method: 'GET', url: '/api/admin/users', headers: await adminHeaders(app) })).json();
    const card = list.content.find((u: any) => u.id === id);
    assert.deepEqual([[...card.libraries].sort(), card.max_age_rating, card.perms], [[KIDS, TEENS], 13, { canDownload: false }]);
  } finally {
    await app.close();
  }
});

test('a first sign-in through the provider starts with the defaults; one it makes an admin has them for the day it is not', { skip }, async () => {
  const app = await appFor();
  try {
    await setDefaults(app, { libraries: [KIDS], maxAgeRating: 10, perms: { canDownload: false } });
    // Reintroduce by dropping the call in resolveOidcUser: every library open.
    const kid = await viaProvider(app, { sub: 'kid-sub', preferred_username: 'nd-kid-sso' });
    assert.equal(kid.role, 'user');
    assert.deepEqual(await made(kid.id), { libraries: [KIDS], maxAgeRating: 10, perms: { canDownload: false } });
    // In the admin group: an admin, unrestricted as every admin is, carrying the defaults all the same...
    const boss = await viaProvider(app, { sub: 'boss-sub', preferred_username: 'nd-boss-sso', groups: [GROUP] });
    assert.equal(boss.role, 'admin');
    assert.deepEqual(await made(boss.id), { libraries: [KIDS], maxAgeRating: 10, perms: { canDownload: false } });
    const asAdmin = await viewCtxFor(boss.id, 'admin');
    assert.deepEqual([asAdmin.libraryIds, asAdmin.maxAgeRating], [null, null], 'an admin is limited by what it carries');
    // ...for the day the provider puts it outside the group: then it is a member nobody chose for. Reintroduce by applying
    // them to members only (resolveOidcUser or applyMemberDefaults): that member opens every library.
    const demoted = await viaProvider(app, { sub: 'boss-sub', preferred_username: 'nd-boss-sso', groups: [] });
    assert.equal(demoted.role, 'user');
    const asMember = await viewCtxFor(boss.id, 'user');
    assert.deepEqual([asMember.libraryIds, asMember.maxAgeRating], [[KIDS], 10]);
  } finally {
    await app.close();
  }
});

test('each default lands on its own, and only it', { skip }, async () => {
  const app = await appFor();
  try {
    // One at a time, the other two unset: each write stands on its own, not on another's being set.
    await setDefaults(app, { libraries: [TEENS], maxAgeRating: null, perms: {} });
    assert.deepEqual(await made(await signUp(app, 'nd-only-libs')), { libraries: [TEENS], maxAgeRating: null, perms: {} });
    await setDefaults(app, { libraries: null, maxAgeRating: 15 });
    assert.deepEqual(await made(await signUp(app, 'nd-only-age')), { libraries: [], maxAgeRating: 15, perms: {} });
    await setDefaults(app, { maxAgeRating: null, perms: { canDownload: false } });
    assert.deepEqual(await made((await viaProvider(app, { sub: 'only-dl-sub', preferred_username: 'nd-only-dl' })).id),
      { libraries: [], maxAgeRating: null, perms: { canDownload: false } });
    // A field left out of the PATCH is left as it was.
    assert.deepEqual(await setDefaults(app, { maxAgeRating: 6 }), { libraries: null, maxAgeRating: 6, perms: { canDownload: false } });
  } finally {
    await setDefaults(app, NOTHING).catch(() => {});
    await app.close();
  }
});

test('none is none, and a default library that is gone leaves the choice of none, never every library', { skip }, async () => {
  const app = await appFor();
  try {
    // [] cannot be said by writing no rows -- that is every library. Reintroduce by dropping keepRestricted in
    // applyMemberDefaults: the account opens everything.
    assert.deepEqual((await setDefaults(app, { libraries: [] })).libraries, []);
    const none = await signUp(app, 'nd-none');
    assert.deepEqual((await made(none)).libraries, [''], 'not the "no libraries" marker');
    assert.deepEqual((await viewCtxFor(none, 'user')).libraryIds, [''], 'an account with no libraries sees some');
    // A library that is removed leaves the defaults; one gone before a PATCH is never stored.
    await setDefaults(app, { libraries: [GONE] });
    const del = await app.inject({ method: 'DELETE', url: `/api/admin/libraries/${GONE}`, headers: await adminHeaders(app) });
    assert.equal(del.statusCode, 200, del.body);
    // Reintroduce by reading the column as stored (memberDefaults): Members offers a library that does not exist.
    const got = (await app.inject({ method: 'GET', url: '/api/admin/settings', headers: await adminHeaders(app) })).json();
    assert.deepEqual(got.newMemberDefaults.libraries, [], 'the gone library is still a default, or the list became every library');
    assert.deepEqual((await made(await signUp(app, 'nd-gone'))).libraries, ['']);
    assert.deepEqual(await setDefaults(app, { libraries: ['lib_nope', KIDS, KIDS] }), { libraries: [KIDS], maxAgeRating: null, perms: {} });
    // Reintroduce by storing the list as sent (saveMemberDefaults): the row keeps ids no library has.
    assert.deepEqual((await one('SELECT new_member_libraries AS l FROM server_settings WHERE id = 1')).l, [KIDS]);
  } finally {
    await setDefaults(app, NOTHING).catch(() => {});
    await app.close();
  }
});

test('an account an admin makes, and every account that exists, keep what they have', { skip }, async () => {
  const app = await appFor();
  try {
    const before = await signUp(app, 'nd-before');
    await setDefaults(app, { libraries: [KIDS], maxAgeRating: 13, perms: { canDownload: false } });
    // Saving the defaults touches no account: they are what an account starts with, not a policy over every one.
    assert.deepEqual(await made(before), ASIS);
    // Members' New account is the admin choosing; its card sets the rest. Reintroduce by calling applyMemberDefaults in
    // POST /api/admin/users: the member the admin just made starts limited.
    const r = await app.inject({ method: 'POST', url: '/api/admin/users', headers: await adminHeaders(app), payload: { username: 'nd-by-hand', password: PASSWORD, role: 'user' } });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(await made(r.json().id), ASIS);
  } finally {
    await setDefaults(app, NOTHING).catch(() => {});
    await app.close();
  }
});

test('PATCH refuses what a member\'s PATCH refuses, and writes nothing then', { skip }, async () => {
  const app = await appFor();
  try {
    await setDefaults(app, { maxAgeRating: 13 });
    for (const bad of [{ maxAgeRating: 19 }, { maxAgeRating: 1.5 }, { libraries: 'Kids' }, { libraries: [KIDS], maxAgeRating: -1 }, { perms: { canDownload: 'no' } }]) {
      const r = await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: await adminHeaders(app), payload: { newMemberDefaults: bad } });
      assert.equal(r.statusCode, 400, `${JSON.stringify(bad)}: ${r.body}`);
    }
    const got = (await app.inject({ method: 'GET', url: '/api/admin/settings', headers: await adminHeaders(app) })).json();
    assert.deepEqual(got.newMemberDefaults, { libraries: null, maxAgeRating: 13, perms: {} }, 'a refused PATCH wrote something');
  } finally {
    await setDefaults(app, NOTHING).catch(() => {});
    await app.close();
  }
});

test('the first admin starts with everything, by setup or by SSO-only mode\'s first sign-in; the sign-ups after it do not', { skip }, async () => {
  // A new server, defaults already set (they live on server_settings, which outlives every account).
  await q('TRUNCATE users CASCADE');
  const DEFAULTS = { libraries: [KIDS], maxAgeRating: 13, perms: { canDownload: false } };
  await q(`UPDATE server_settings SET new_member_libraries = $1, new_member_max_age_rating = 13, new_member_perms = '{"canDownload": false}' WHERE id = 1`, [[KIDS]]);
  const local = await appFor('local');
  try {
    const r = await local.inject({ method: 'POST', url: '/api/setup', payload: { username: 'nd-setup', password: PASSWORD } });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(await made(r.json().user.id), ASIS, 'the server\'s first admin starts limited');
    // The sign-up after it is a member like any other.
    assert.deepEqual(await made(await signUp(local, 'nd-after-setup')), DEFAULTS);
  } finally {
    await local.close();
  }
  await q('TRUNCATE users CASCADE');
  process.env.OIDC_BOOTSTRAP_ADMIN_SUB = 'first-sub';
  const sso = await appFor('oidc-only');
  try {
    const first = await viaProvider(sso, { sub: 'first-sub', preferred_username: 'nd-first' });
    assert.equal(first.role, 'admin');
    assert.deepEqual(await made(first.id), ASIS, 'SSO-only mode\'s first admin starts limited');
    // In SSO-only mode the provider is the only way in, and a new account its sign-up: it starts with the defaults.
    const kid = await viaProvider(sso, { sub: 'sso-kid-sub', preferred_username: 'nd-sso-kid' });
    assert.deepEqual([kid.role, await made(kid.id)], ['user', DEFAULTS]);
  } finally {
    delete process.env.OIDC_BOOTSTRAP_ADMIN_SUB;
    await sso.close();
  }
});
