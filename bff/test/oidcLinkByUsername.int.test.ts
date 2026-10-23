// OIDC_LINK_BY_USERNAME adopts an existing account only by the username the provider itself reports, exactly, and the
// adopted account's role follows OIDC_ADMIN_GROUP from that first sign-in (v0.69.1).
//
// It adopted by a DERIVED name -- the email's local part when no username was reported (email_verified never read, the
// domain dropped), with characters stripped -- so the audit's fixture provider handed the unlinked 'admin' account, and
// an admin session, to an identity that reported no username and an unverified admin@evil.example. And adoption kept the
// account's stored role for the first session even outside the admin group.
//
// Its own database (the identity rows it makes are global). Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, createSign } from 'node:crypto';
import type { AddressInfo } from 'node:net';

const DSN = process.env.TEST_DATABASE_URL;
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
const CLIENT_ID = 'uchiyomi-link-test';
const GROUP = 'link-admins';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
let idp: Server;
let issuer = '';
const codes = new Map<string, Record<string, unknown>>();
let n = 0;

function mint(payload: Record<string, unknown>): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: 'k1' };
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify({ iss: issuer, aud: CLIENT_ID, iat: now, exp: now + 300, ...payload }))}`;
  return `${input}.${b64u(createSign('RSA-SHA256').update(input).sign(privateKey))}`;
}

let DBNAME = '';
let q: any, one: any, pool: any, app: any;

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
      } else { res.statusCode = 404; res.end('{}'); }
    });
  });
  await new Promise<void>((go) => idp.listen(0, '127.0.0.1', go));
  issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
  const { Client } = await import('pg');
  const admin = new Client({ connectionString: DSN });
  await admin.connect();
  DBNAME = `${decodeURIComponent(new URL(DSN).pathname.slice(1))}_link`;
  await admin.query(`DROP DATABASE IF EXISTS "${DBNAME}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${DBNAME}"`);
  await admin.end();
  const url = new URL(DSN);
  url.pathname = `/${DBNAME}`;
  Object.assign(process.env, {
    DATABASE_URL: url.toString(),
    JWT_SECRET: process.env.JWT_SECRET || 'test-secret-at-least-16-chars',
    CONFIG_DIR: process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config',
    PUBLIC_ORIGIN: 'http://link.test',
    OIDC_ISSUER: issuer, OIDC_CLIENT_ID: CLIENT_ID, OIDC_ADMIN_GROUP: GROUP, OIDC_LINK_BY_USERNAME: 'true',
  });
  delete process.env.OIDC_ALLOW_SIGNUP;
  delete process.env.AUTH_MODE;
  await (await import('../src/lib/migrate')).migrate();
  ({ q, one, pool } = (await import('../src/lib/db')) as any);
  for (const [u, role] of [['admin', 'admin'], ['alice', 'user'], ['carol', 'admin'], ['dave', 'user']]) {
    await q(`INSERT INTO users (display_name, username, role, password_hash, auth_kind) VALUES ($1,$1,$2,'x','password')`, [u, role]);
  }
  await q(`UPDATE users SET oidc_issuer = $1, oidc_sub = 'someone-else' WHERE username = 'dave'`, [issuer]);
  // A child's profile alice manages, and one with no password that nobody manages.
  await q(`INSERT INTO users (display_name, username, role, password_hash, auth_kind, password_login, local_open, managed_by)
           SELECT 'erin', 'erin', 'user', 'x', 'none', false, true, id FROM users WHERE username = 'alice'`);
  await q(`INSERT INTO users (display_name, username, role, password_hash, auth_kind, password_login, local_open)
           VALUES ('frank', 'frank', 'user', 'x', 'none', false, true)`);
  const Fastify = (await import('fastify')).default;
  app = Fastify();
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('@fastify/rate-limit')).default, { global: false });
  await app.register((await import('../src/routes/auth')).default);
  await app.ready();
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  await pool?.end();
  idp?.close();
  const { Client } = await import('pg');
  const admin = new Client({ connectionString: DSN });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${DBNAME}" WITH (FORCE)`).catch(() => {});
  await admin.end();
});

/** One sign-in through the provider as `who`; the answer's sso_error, or null for a session. */
async function signIn(who: Record<string, unknown>): Promise<string | null> {
  const start = await app.inject({ method: 'GET', url: '/auth/oidc/start' });
  assert.equal(start.statusCode, 302, start.body);
  const at = new URL(String(start.headers.location));
  const code = `code-${++n}`;
  codes.set(code, { ...who, nonce: at.searchParams.get('nonce') });
  const ticket = start.cookies.find((c: any) => c.name === 'yomi_oidc')?.value;
  const cb = await app.inject({ method: 'GET', url: `/auth/oidc/callback?code=${code}&state=${at.searchParams.get('state')}`, cookies: { yomi_oidc: ticket } });
  assert.equal(cb.statusCode, 302, cb.body);
  return new URL(String(cb.headers.location)).searchParams.get('sso_error');
}
const user = (name: string) => one(`SELECT role, oidc_sub FROM users WHERE username = $1`, [name]);

test('an identity that reports no username adopts nothing, whatever its email says', { skip }, async () => {
  assert.equal(await signIn({ sub: 'evil-1', email: 'admin@evil.example', email_verified: false }), 'no_account');
  assert.equal((await user('admin')).oidc_sub, null, "the admin account was handed to the provider's identity");
});

test('a reported username is matched exactly, not after characters are stripped', { skip }, async () => {
  assert.equal(await signIn({ sub: 'evil-2', preferred_username: 'alice+' }), 'no_account');
  assert.equal((await user('alice')).oidc_sub, null);
});

test('an exact match is adopted, and its role follows the admin group from the first sign-in', { skip }, async () => {
  assert.equal(await signIn({ sub: 'carol-1', preferred_username: 'carol', groups: [] }), null);
  const carol = await user('carol');
  assert.equal(carol.oidc_sub, 'carol-1');
  assert.equal(carol.role, 'user', 'outside the admin group, yet still an admin for the first session');
});

test("an account linked to another identity is never taken", { skip }, async () => {
  assert.equal(await signIn({ sub: 'dave-2', preferred_username: 'dave' }), 'username_taken');
});

test('a managed profile is never adopted, nor one without a password', { skip }, async () => {
  // A provider reporting `erin` must not take over the reading of the child's profile alice manages; nor `frank`, a
  // profile that opens at home with no password. With sign-up off, nothing is made either.
  assert.equal(await signIn({ sub: 'erin-at-idp', preferred_username: 'erin' }), 'no_account');
  assert.equal((await user('erin')).oidc_sub, null, "the child's profile was handed to the provider's identity");
  assert.equal(await signIn({ sub: 'frank-at-idp', preferred_username: 'frank' }), 'no_account');
  assert.equal((await user('frank')).oidc_sub, null);
});
