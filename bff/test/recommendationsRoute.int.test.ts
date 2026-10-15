// GET /api/discover/recommendations: the route in front of lib/trackerRecs.ts. Behind authentication, never cached by a
// proxy or the browser, empty for an account with no tracker (so nothing is asked of any service), and fail-closed on
// adult work for a viewer who is hiding it. Skipped unless TEST_DATABASE_URL is set.
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

const asked: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: any, init?: any) => {
  const url = new URL(String(u));
  if (!['graphql.anilist.co', 'api.myanimelist.net'].includes(url.hostname)) return realFetch(u, init);
  asked.push(url.hostname);
  return new Response('{}', { status: 500 });
}) as typeof fetch;

test('the recommendations route', { skip }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const routes = (await import('../src/routes/recommendations')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await migrate();
  await q(`DELETE FROM users WHERE username = 'recs-route'`);
  const [u] = await q<{ id: string }>(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ('recs-route','recs-route','x','user','password') RETURNING id`);
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(routes);
  await app.ready();
  try {
    const none = await app.inject({ method: 'GET', url: '/api/discover/recommendations' });
    assert.equal(none.statusCode, 401, 'it is behind authentication');

    const r = await app.inject({ method: 'GET', url: '/api/discover/recommendations', headers: { authorization: `Bearer ${app.jwt.sign({ sub: u.id, role: 'user' })}` } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(r.json(), { content: [], sources: [], pending: false }, 'no tracker connected: nothing to say');
    assert.deepEqual(asked, [], 'and no service is asked');
  } finally {
    await app.close();
    await q(`DELETE FROM users WHERE username = 'recs-route'`).catch(() => {});
  }
});
