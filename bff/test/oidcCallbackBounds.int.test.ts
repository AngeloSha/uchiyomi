// The unauthenticated OIDC routes do bounded work per request (v0.69.1).
//
// The audit drove the real routes with a mock provider: 60 bare callbacks wrote 60 audit rows, a 15.7 KB ?error= was
// stored verbatim (17 KB of table per request; 500 of them pushed every real event out of the admin activity feed),
// one /start ticket replayed ten times made ten token-endpoint POSTs with this server's client credentials, and no
// rate limit applied. Now: refusal rows before an identity is proven are throttled per kind and carry a short reason,
// a ticket is spent by its first callback, the routes are rate limited, and refusal rows are pruned (only those).
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
const TMP = mkdtempSync(join(tmpdir(), 'uy-oidcb-'));
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

let idp: Server;
let tokenPosts = 0;
let app: any, q: any, one: any;

before(async () => {
  if (!DSN) return;
  idp = createServer((rq, rs) => {
    rq.resume();
    rq.on('end', () => {
      rs.setHeader('content-type', 'application/json');
      const issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
      if (rq.url === '/.well-known/openid-configuration') {
        rs.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` }));
      } else if (rq.url === '/token' && rq.method === 'POST') {
        tokenPosts++;
        rs.statusCode = 400;
        rs.end('{"error":"invalid_grant"}');
      } else { rs.statusCode = 404; rs.end('{}'); }
    });
  });
  await new Promise<void>((go) => idp.listen(0, '127.0.0.1', go));
  Object.assign(process.env, {
    DATABASE_URL: DSN,
    JWT_SECRET: process.env.JWT_SECRET || 'test-secret-at-least-16-chars',
    CONFIG_DIR: join(TMP, 'config'),
    PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
    OIDC_ISSUER: `http://127.0.0.1:${(idp.address() as AddressInfo).port}`,
    OIDC_CLIENT_ID: 'bounds-client',
    OIDC_CLIENT_SECRET: 'bounds-secret',
  });
  delete process.env.AUTH_MODE;
  ({ q, one } = (await import('../src/lib/db')) as any);
  await (await import('../src/lib/migrate')).migrate();
  await q(`DELETE FROM audit_log WHERE event = 'login.oidc_fail'`);
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
  await new Promise((r) => idp.close(r));
  rmSync(TMP, { recursive: true, force: true });
});

const rows = async () => Number((await one(`SELECT count(*)::int AS n FROM audit_log WHERE event = 'login.oidc_fail'`)).n);

test('refusals before an identity is proven are throttled, and carry a short reason', { skip }, async () => {
  // Reintroduce by logging every refusal: twenty bare callbacks write twenty rows.
  const before = await rows();
  for (let i = 0; i < 20; i++) {
    const r = await app.inject({ method: 'GET', url: '/auth/oidc/callback' });
    assert.equal(r.statusCode, 302);
  }
  assert.equal(await rows() - before, 1, 'one row stands for the burst');
  const long = 'x'.repeat(15_000);
  await app.inject({ method: 'GET', url: `/auth/oidc/callback?error=${long}` });
  const max = Number((await one(`SELECT max(length(detail->>'reason'))::int AS n FROM audit_log WHERE event = 'login.oidc_fail'`)).n);
  assert.ok(max <= 64, `a stored reason was ${max} characters of the caller's text`);
});

test('a login ticket is spent by its first callback: one /start buys one token exchange', { skip }, async () => {
  // Reintroduce by dropping spend(): the replay reaches the provider's token endpoint a second time.
  const start = await app.inject({ method: 'GET', url: '/auth/oidc/start' });
  assert.equal(start.statusCode, 302, start.body);
  const state = new URL(start.headers.location as string).searchParams.get('state');
  const cookie = (start.cookies as Array<{ name: string; value: string }>).find((c) => c.name === 'yomi_oidc')!;
  const headers = { cookie: `yomi_oidc=${cookie.value}` };
  tokenPosts = 0;
  for (const code of ['first', 'replayed', 'again']) {
    await app.inject({ method: 'GET', url: `/auth/oidc/callback?code=${code}&state=${state}`, headers });
  }
  assert.equal(tokenPosts, 1, 'the ticket bought more than one token exchange');
});

test('the OIDC routes are rate limited', { skip }, async () => {
  let limited = 0;
  let header = false;
  for (let i = 0; i < 40; i++) {
    const r = await app.inject({ method: 'GET', url: '/auth/oidc/callback' });
    if (r.statusCode === 429) limited++;
    header ||= 'x-ratelimit-limit' in r.headers;
  }
  assert.ok(header, 'no rate limit applies');
  assert.ok(limited > 0, 'forty more callbacks from one address were never refused');
});

test('only refusal rows are pruned: the rows other code reads back as evidence stay', { skip }, async () => {
  // Reintroduce a blanket prune (every event by age): the old series.chapters_delete row goes, and migrate.ts then
  // lets the updater fetch a deliberately deleted chapter again.
  const { pruneAudit } = await import('../src/lib/audit');
  await q(`INSERT INTO audit_log (event, detail, at) VALUES ('login.oidc_fail', '{}', now() - interval '400 days'),
           ('series.chapters_delete', '{"marker":"bounds-evidence"}', now() - interval '400 days')`);
  await pruneAudit(180, 50_000);
  assert.equal(Number((await one(`SELECT count(*)::int AS n FROM audit_log WHERE event = 'login.oidc_fail' AND at < now() - interval '180 days'`)).n), 0);
  assert.equal(Number((await one(`SELECT count(*)::int AS n FROM audit_log WHERE detail->>'marker' = 'bounds-evidence'`)).n), 1);
  await q(`DELETE FROM audit_log WHERE detail->>'marker' = 'bounds-evidence'`);
});
