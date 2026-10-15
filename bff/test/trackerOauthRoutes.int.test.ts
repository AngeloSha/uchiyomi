// The routes behind signing in to a tracker through a registered application: the admin's one-time setup, what
// GET /api/trackers then offers every member, and MyAnimeList's code exchange (POST /api/trackers/myanimelist/oauth).
// `fetch` answers MyAnimeList; everything else passes through. Skipped unless TEST_DATABASE_URL is set.
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

type Call = { method: string; url: URL; body: string };
const calls: Call[] = [];
let route: (c: Call) => Response | null = () => null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: any, init?: any) => {
  const url = new URL(String(u));
  if (!['myanimelist.net', 'api.myanimelist.net'].includes(url.hostname)) return realFetch(u, init);
  const c = { method: String(init?.method ?? 'GET').toUpperCase(), url, body: String(init?.body ?? '') };
  calls.push(c);
  return route(c) ?? new Response('unrouted', { status: 500 });
}) as typeof fetch;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

test('tracker sign-in: setup by an admin, offered to everyone, MyAnimeList code exchange', { skip }, async (t) => {
  const { migrate } = await import('../src/lib/migrate');
  const { q, one } = await import('../src/lib/db');
  const adminRoutes = (await import('../src/routes/admin')).default;
  const personalRoutes = (await import('../src/routes/personal')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await migrate();
  await q(`DELETE FROM users WHERE username LIKE 'trk-oa-%'`);
  const mk = async (name: string, role: string) => (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x',$2,'password') RETURNING id`, [name, role]))[0].id;
  const admin = await mk('trk-oa-admin', 'admin');
  const member = await mk('trk-oa-member', 'user');
  await q('DELETE FROM tracker_oauth_apps');
  delete process.env.ANILIST_CLIENT_ID; delete process.env.MYANIMELIST_CLIENT_ID;
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(adminRoutes);
  await app.register(personalRoutes);
  await app.ready();
  const as = (id: string, role: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub: id, role })}` });
  const offered = async () => Object.fromEntries((await app.inject({ method: 'GET', url: '/api/trackers', headers: as(member, 'user') })).json().content.map((s: any) => [s.provider, s]));

  try {
    await t.test('before setup nothing is configured, and a service with nothing to register takes a token', async () => {
      const by = await offered();
      assert.equal(by.anilist.configured, false);
      assert.equal(by.anilist.method, 'oauth-implicit');
      assert.equal(by.myanimelist.configured, false);
      assert.equal(by.myanimelist.method, 'oauth-code');
      assert.deepEqual([by.kitsu.method, by.kitsu.configured], ['token', true]);
    });

    await t.test('only an admin sets the application up; the secret is sealed and never returned', async () => {
      const put = (headers: any, payload: any) => app.inject({ method: 'PUT', url: '/api/admin/trackers/apps/myanimelist', headers, payload });
      assert.equal((await put(as(member, 'user'), { clientId: 'x' })).statusCode, 403);
      assert.equal((await app.inject({ method: 'PUT', url: '/api/admin/trackers/apps/kitsu', headers: as(admin, 'admin'), payload: { clientId: 'x' } })).statusCode, 404);
      assert.equal((await put(as(admin, 'admin'), { clientId: 'mal-id', clientSecret: 'mal-secret' })).statusCode, 200);
      const list = (await app.inject({ method: 'GET', url: '/api/admin/trackers/apps', headers: as(admin, 'admin') })).json().content;
      assert.deepEqual(list.find((a: any) => a.provider === 'myanimelist'), { provider: 'myanimelist', clientId: 'mal-id', hasSecret: true, source: 'settings' });
      assert.ok(!JSON.stringify(list).includes('mal-secret'));
      // a blank secret on a later save keeps the one saved; a blank id clears the application
      await put(as(admin, 'admin'), { clientId: 'mal-id-2', clientSecret: '' });
      assert.equal((await q<{ client_id: string }>(`SELECT client_id FROM tracker_oauth_apps WHERE provider='myanimelist'`))[0].client_id, 'mal-id-2');
      assert.equal((await (await import('../src/lib/trackerOauth')).getApp('myanimelist'))!.clientSecret, 'mal-secret');
      const by = await offered();
      assert.equal(by.myanimelist.configured, true);
      assert.equal(by.myanimelist.clientId, 'mal-id-2');
      assert.ok(!JSON.stringify(by).includes('mal-secret'), 'the member never receives the secret');
    });

    await t.test('the code exchange saves the token with the service\'s own lifetime', async () => {
      calls.length = 0;
      route = (c) => (c.url.pathname === '/v1/oauth2/token' ? json({ access_token: 'mal-access-token-value', expires_in: 2678400 })
        : c.url.pathname === '/v2/users/@me' ? json({ id: 5, name: 'malreader' }) : null);
      const r = await app.inject({ method: 'POST', url: '/api/trackers/myanimelist/oauth', headers: as(member, 'user'),
        payload: { code: 'the-code', verifier: 'v'.repeat(50), redirectUri: 'http://timnode:3000/tracker-callback/' } });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().account, 'malreader');
      const sent = new URLSearchParams(calls[0].body);
      assert.deepEqual([sent.get('client_id'), sent.get('client_secret'), sent.get('code_verifier')], ['mal-id-2', 'mal-secret', 'v'.repeat(50)]);
      const row = await one<{ expires_at: Date }>(`SELECT expires_at FROM user_trackers WHERE user_id=$1 AND provider='myanimelist'`, [member]);
      const days = (new Date(row!.expires_at).getTime() - Date.now()) / 86_400_000;
      assert.ok(days > 30.9 && days < 31.1, `expires_in (31 days) is used, got ${days}`);
    });

    await t.test('a refused exchange is 400 rejected, an outage 502, a malformed body 400, and nothing is saved', async () => {
      await q('DELETE FROM user_trackers WHERE user_id = $1', [member]);
      const go = (payload: any) => app.inject({ method: 'POST', url: '/api/trackers/myanimelist/oauth', headers: as(member, 'user'), payload });
      const ok = { code: 'the-code', verifier: 'v'.repeat(50), redirectUri: 'http://timnode:3000/tracker-callback/' };
      route = () => json({ error: 'invalid_grant', error_description: 'code expired' }, 400);
      const bad = await go(ok);
      assert.equal(bad.statusCode, 400);
      assert.equal(bad.json().error, 'rejected');
      route = () => { throw new TypeError('fetch failed'); };
      assert.equal((await go(ok)).statusCode, 502);
      assert.equal((await go({ code: 'x' })).statusCode, 400);
      assert.equal(await one(`SELECT 1 FROM user_trackers WHERE user_id = $1`, [member]), null);
    });
  } finally {
    await app.close();
    await q('DELETE FROM tracker_oauth_apps').catch(() => {});
    await q(`DELETE FROM users WHERE username LIKE 'trk-oa-%'`).catch(() => {});
  }
});
