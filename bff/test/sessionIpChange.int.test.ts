// A session refreshed from another network than its last is said in the activity log, once a day at most, and never
// acted on (routes/auth.ts /auth/refresh, lib/clientAddr.ts sameNetwork).
// Wi-Fi to mobile data looks the same from here as a copied cookie: a sign-out on it would sign out every phone that
// leaves the house. Skipped unless TEST_DATABASE_URL is set.
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

test('a session that moves', { skip }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const auth = await import('../src/lib/auth');
  await migrate();
  await q(`DELETE FROM users WHERE username = 'ipc-reader'`);
  const id = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ('ipc-reader', 'ipc-reader', 'x', 'user', 'password') RETURNING id`))[0].id;
  const app = (await import('fastify')).default();
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/auth')).default);
  await app.ready();
  const lines = async () => (await q(`SELECT 1 FROM audit_log WHERE event = 'session.ip_change' AND user_id = $1`, [id])).length;
  let rt = await auth.issueRefreshToken(id, { via: 'password', ip: '198.51.100.20' });
  const refresh = async (ip: string) => {
    const r = await app.inject({ method: 'POST', url: '/auth/refresh', remoteAddress: ip, cookies: { yomi_rt: rt } });
    assert.equal(r.statusCode, 200, 'a session that moved was refused: it must only be written down');
    rt = r.cookies.find((c: any) => c.name === 'yomi_rt')?.value ?? rt;
  };
  try {
    await refresh('198.51.100.99');
    assert.equal(await lines(), 0, 'the same /24 is the same network');
    await refresh('203.0.113.5');
    assert.equal(await lines(), 1, 'a session that moved is not said');
    await refresh('192.0.2.8');
    assert.equal(await lines(), 1, 'more than one line a day for one session');
  } finally {
    await q('DELETE FROM audit_log WHERE user_id = $1', [id]).catch(() => {});
    await q('DELETE FROM users WHERE id = $1', [id]).catch(() => {});
    await app.close();
  }
});
