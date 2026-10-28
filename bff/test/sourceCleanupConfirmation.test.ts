// Preview acknowledgements are signed state tokens, never account credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'source-cleanup-confirmation-test-secret';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

const preview = { sources: [{ source: 'kept', ref: 'kept-series' }], fresh: [1, 2], left: { others: ['kept'], books: [], numbers: [3], readers: 1 } };
const identity = { userId: '11111111-1111-4111-8111-111111111111', seriesId: 'series', sourceId: 'removed' };

test('confirmation JWTs bind purpose, account, series, source, exact preview and a five-minute expiry', async () => {
  const app = (await import('fastify')).default();
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  const { cleanupConfirmation } = await import('../src/lib/sourceLeftovers');
  try {
    const token = cleanupConfirmation(app, preview, identity);
    const claims = app.jwt.decode(token) as any;
    assert.equal(claims.typ, 'source-cleanup-preview');
    assert.equal(claims.exp - claims.iat, 300);
    assert.equal(cleanupConfirmation(app, preview, identity, token), true);
    for (const different of [{ ...identity, userId: 'someone-else' }, { ...identity, seriesId: 'other-series' }, { ...identity, sourceId: 'other-source' }]) {
      assert.equal(cleanupConfirmation(app, preview, different, token), false);
    }
    assert.equal(cleanupConfirmation(app, { ...preview, fresh: [1, 2, 3] }, identity, token), false);
    assert.equal(cleanupConfirmation(app, { ...preview, left: { ...preview.left, readers: 2 } }, identity, token), false);
    const now = Math.floor(Date.now() / 1000);
    for (const invalid of [
      { ...claims, typ: 'img' }, { ...claims, aud: 'other-purpose' }, { ...claims, snapshot: 'changed' },
      { ...claims, iat: now - 301, exp: now - 1 }, { ...claims, iat: now, exp: now + 301 },
      { ...claims, iat: now + 10, exp: now + 20 }, { ...claims, exp: undefined },
    ]) assert.equal(cleanupConfirmation(app, preview, identity, app.jwt.sign(invalid)), false);
    const pieces = token.split('.');
    pieces[2] = (pieces[2][0] === 'a' ? 'b' : 'a') + pieces[2].slice(1);
    assert.equal(cleanupConfirmation(app, preview, identity, pieces.join('.')), false);
  } finally { await app.close(); }
});

test('a valid preview JWT cannot authenticate as an access token or image cookie', async () => {
  const app = (await import('fastify')).default();
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  const { cleanupConfirmation } = await import('../src/lib/sourceLeftovers');
  const { authenticate } = await import('../src/lib/auth');
  const { authorizeImageRequest } = await import('../src/routes/images');
  app.get('/api/probe', { preHandler: authenticate }, async () => ({ ok: true }));
  app.get('/img/probe', { preHandler: (req, reply) => authorizeImageRequest(app, req, reply) }, async () => ({ ok: true }));
  try {
    const token = cleanupConfirmation(app, preview, identity);
    assert.equal((await app.inject({ url: '/api/probe', headers: { authorization: `Bearer ${token}` } })).statusCode, 401);
    assert.equal((await app.inject({ url: '/img/probe', cookies: { yomi_img: token } })).statusCode, 401);
  } finally { await app.close(); }
});
