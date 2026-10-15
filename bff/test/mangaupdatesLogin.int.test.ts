// POST /api/trackers/mangaupdates/login: MangaUpdates has no token page, so a username and password are traded for a
// session token once and only the token is kept. The service is answered by a stub `fetch` (the pattern of
// trackerVerdicts.int.test.ts). Skipped unless TEST_DATABASE_URL is set.
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

type Call = { method: string; url: URL; body: any };
const calls: Call[] = [];
let route: (c: Call) => Response | null = () => null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: any, init?: any) => {
  const url = new URL(String(u));
  if (url.hostname !== 'api.mangaupdates.com') return realFetch(u, init);
  let body: any = null;
  if (typeof init?.body === 'string') { try { body = JSON.parse(init.body); } catch { body = init.body; } }
  const c = { method: String(init?.method ?? 'GET').toUpperCase(), url, body };
  calls.push(c);
  return route(c) ?? new Response('unrouted', { status: 500 });
}) as typeof fetch;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

test('MangaUpdates sign-in over HTTP', { skip }, async (t) => {
  const { migrate } = await import('../src/lib/migrate');
  const { q, one } = await import('../src/lib/db');
  const personalRoutes = (await import('../src/routes/personal')).default;
  const { open: unseal } = await import('../src/lib/secretbox');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await migrate();
  const NAME = 'trk-mu-login';
  await q('DELETE FROM users WHERE username = $1', [NAME]);
  const [u] = await q<{ id: string }>(`INSERT INTO users (username, display_name, password_hash, role) VALUES ($1,$1,'x','user') RETURNING id`, [NAME]);
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(personalRoutes);
  await app.ready();
  const headers = { authorization: `Bearer ${app.jwt.sign({ sub: u.id, role: 'user' })}` };
  const login = (payload: unknown) => app.inject({ method: 'POST', url: '/api/trackers/mangaupdates/login', headers, payload: payload as any });
  const saved = () => one<{ access_token: string; account_name: string | null; enabled: boolean; expires_at: Date | null }>(
    'SELECT access_token, account_name, enabled, expires_at FROM user_trackers WHERE user_id = $1 AND provider = $2', [u.id, 'mangaupdates']);

  try {
    await t.test('a good sign-in keeps the token, not the password', async () => {
      calls.length = 0;
      route = (c) => (c.url.pathname === '/v1/account/login' ? json({ status: 'success', context: { session_token: 'session-token-abc', uid: 9 } })
        : c.url.pathname === '/v1/account/profile' ? json({ user_id: 9, username: 'reader9' }) : null);
      const r = await login({ username: ' reader9 ', password: 'correct horse' });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().account, 'reader9');
      assert.deepEqual(calls[0].body, { username: 'reader9', password: 'correct horse' });
      assert.equal(calls[1].url.pathname, '/v1/account/profile', 'the token is proved before it is kept');
      const row = await saved();
      assert.equal(row?.enabled, true);
      assert.equal(row?.account_name, 'reader9');
      assert.equal(row?.expires_at, null, 'a MangaUpdates session has no stated lifetime');
      assert.equal(unseal(row!.access_token), 'session-token-abc');
      assert.ok(!JSON.stringify(row).includes('correct horse'), 'the password is not stored');
      const list = await app.inject({ method: 'GET', url: '/api/trackers', headers });
      const mu = list.json().content.find((s: any) => s.provider === 'mangaupdates');
      assert.equal(mu.connected, true);
      assert.equal(mu.label, 'MangaUpdates');
    });

    await t.test('a refused sign-in is 400 rejected with the service\'s reason, and keeps nothing new', async () => {
      await q('DELETE FROM user_trackers WHERE user_id = $1', [u.id]);
      route = (c) => (c.url.pathname === '/v1/account/login' ? json({ status: 'exception', reason: 'Username or password is incorrect' }, 401) : null);
      const r = await login({ username: 'reader9', password: 'wrong' });
      assert.equal(r.statusCode, 400, r.body);
      assert.equal(r.json().error, 'rejected');
      assert.match(r.json().message, /incorrect/);
      assert.equal(await saved(), null);
    });

    await t.test('an outage is 502 unreachable, not a verdict on the password; an empty body is a 400', async () => {
      route = () => { throw new TypeError('fetch failed'); };
      const r = await login({ username: 'reader9', password: 'anything' });
      assert.equal(r.statusCode, 502, r.body);
      assert.equal(r.json().error, 'unreachable');
      assert.equal((await login({ username: 'reader9' })).statusCode, 400);
      assert.equal(await saved(), null);
    });
  } finally {
    await app.close();
    await q('DELETE FROM users WHERE username = $1', [NAME]).catch(() => {});
  }
});
