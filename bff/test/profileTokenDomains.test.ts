// An older release ignores loc: local-only sessions must fail its cryptographic verification instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'profile-domains-test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

test('local-only access and image tokens cannot verify under an older release JWT key', async () => {
  const app = (await import('fastify')).default();
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  const { signSessionJwt, verifyLocalSessionJwt } = await import('../src/lib/profileTokens');
  try {
    for (const payload of [{ sub: 'reader', role: 'user' }, { sub: 'reader', typ: 'img' }]) {
      assert.equal((app.jwt.verify(signSessionJwt(app, payload, 60)) as any).sub, 'reader');
      const local = signSessionJwt(app, payload, 60, true);
      assert.throws(() => app.jwt.verify(local), 'old verifier accepted a passwordless token');
      assert.equal(verifyLocalSessionJwt(app, local).loc, true);
      assert.throws(() => verifyLocalSessionJwt(app, signSessionJwt(app, payload, -1, true)));
      assert.throws(() => verifyLocalSessionJwt(app, signSessionJwt(app, payload, 60)));
    }
  } finally { await app.close(); }
});

test('a plain SHA-256 refresh lookup cannot resolve a local-only opaque cookie', async () => {
  const { newRefreshValue, refreshTokenHash, LOCAL_REFRESH_PREFIX } = await import('../src/lib/profileTokens');
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const normal = newRefreshValue(false);
  assert.match(normal, /^[0-9a-f]{96}$/);
  assert.equal(refreshTokenHash(normal), sha(normal), 'existing credential cookie format changed');
  const local = newRefreshValue(true);
  assert.ok(local.startsWith(LOCAL_REFRESH_PREFIX));
  assert.notEqual(refreshTokenHash(local), sha(local));
  // A public prefix in an unkeyed hash would let an attacker prepend that prefix and present it to old code.
  for (const s of [local.slice(LOCAL_REFRESH_PREFIX.length), `uchiyomi/local-profile/refresh/v1${local}`, `local\0${local}`]) {
    assert.notEqual(refreshTokenHash(local), sha(s));
  }
  assert.equal(refreshTokenHash(local), refreshTokenHash(local));
});
