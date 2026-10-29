// Upgrade -> create a local profile -> exercise pre-profile JWT verification and refresh lookup. The old operations
// deliberately ignore loc/via and every new profile column. Rotating/recovering/resuming must retain the restriction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET ||= 'profile-downgrade-test-secret-at-least-16-chars';
  process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.LOCAL_NETWORKS = '192.168.1.0/24';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
const HOME = '192.168.1.9';
const AWAY = '203.0.113.9';
const cookie = (r: any, name: string): string | undefined => r.cookies.find((c: any) => c.name === name)?.value;
const oldSha = (s: string) => createHash('sha256').update(s).digest('hex');

test('local sessions fail closed after an image downgrade, through rotation, recovery and device resume', { skip }, async (t) => {
  const { migrate } = await import('../src/lib/migrate');
  const { q, one } = await import('../src/lib/db');
  const auth = await import('../src/lib/auth');
  const { refreshTokenHash } = await import('../src/lib/profileTokens');
  const ring = await import('../src/lib/deviceRing');
  await migrate();
  await q("DELETE FROM users WHERE username IN ('pd-guardian', 'pd-child')");
  const guardian = (await q<{ id: string }>(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
    VALUES ('pd-guardian', 'Guardian', 'x', 'user', 'password') RETURNING id`))[0].id;
  const child = (await q<{ id: string }>(`INSERT INTO users (username, display_name, password_hash, role, auth_kind, password_login, local_open, managed_by)
    VALUES ('pd-child', 'Child', 'x', 'user', 'none', false, true, $1) RETURNING id`, [guardian]))[0].id;
  const app = (await import('fastify')).default();
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/auth')).default);
  await app.ready();
  const refresh = (rt: string, remoteAddress = HOME) => app.inject({ method: 'POST', url: '/auth/refresh', remoteAddress, cookies: { yomi_rt: rt } });
  // This is v0.100.0's plain SHA-256 lookup, without any new via/local checks.
  const oldRefreshOwner = (rt: string) => one(`SELECT user_id FROM refresh_tokens
    WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() LIMIT 1`, [oldSha(rt)]);
  const oldRejects = async (res: any, rt?: string) => {
    assert.equal(res.statusCode, 200, res.body);
    assert.throws(() => app.jwt.verify(res.json().accessToken), 'old access verifier accepted a local session');
    assert.throws(() => app.jwt.verify(cookie(res, 'yomi_img')!), 'old image verifier accepted a local session');
    if (rt) assert.equal(await oldRefreshOwner(rt), null, 'old refresh handler resolved a local session');
  };
  const fresh = async (via: 'switch' | 'local-pick') => {
    const g = await auth.issueRefreshToken(guardian, { via: 'password' });
    const sid = (await auth.validateRefreshToken(g))!.sessionId;
    return auth.issueRefreshToken(child, { via, ...(via === 'switch' ? { parentSession: sid } : {}) });
  };
  try {
    await t.test('both local entry paths and ordinary refreshes remain unreadable to old code', async () => {
      for (const via of ['switch', 'local-pick'] as const) {
        let rt = await fresh(via);
        assert.equal(await oldRefreshOwner(rt), null);
        for (let i = 0; i < 3; i++) {
          assert.equal((await refresh(rt, AWAY)).statusCode, 401);
          const r = await refresh(rt);
          const next = cookie(r, 'yomi_rt')!;
          await oldRejects(r, next);
          await oldRejects(await refresh(rt)); // concurrent-tab grace leaves the good cookie alone
          rt = next;
        }
      }
    });
    await t.test('recovering a lost answer never makes a plain-hashed cookie', async () => {
      const first = await fresh('local-pick');
      const rotated = await refresh(first);
      const head = cookie(rotated, 'yomi_rt')!;
      await q(`UPDATE refresh_tokens SET revoked_at = now() - interval '2 minutes' WHERE token_hash = $1`, [refreshTokenHash(first)]);
      await q(`UPDATE refresh_tokens SET created_at = now() - interval '2 minutes' WHERE token_hash = $1`, [refreshTokenHash(head)]);
      const recovered = await refresh(first);
      const next = cookie(recovered, 'yomi_rt');
      assert.ok(next && next !== head, 'precondition: the lost answer was recovered');
      await oldRejects(recovered, next);
    });
    await t.test('a remembered local profile keeps the cryptographic restriction', async () => {
      const rt = await fresh('switch');
      const sid = (await auth.validateRefreshToken(rt))!.sessionId;
      const dev = randomBytes(32).toString('hex');
      await ring.rememberSession(dev, child, sid);
      const r = await app.inject({ method: 'POST', url: '/auth/resume', remoteAddress: HOME, cookies: { yomi_dev: dev }, payload: { profileId: child } });
      await oldRejects(r, cookie(r, 'yomi_rt'));
      assert.equal((await app.inject({ method: 'POST', url: '/auth/resume', remoteAddress: AWAY, cookies: { yomi_dev: dev }, payload: { profileId: child } })).statusCode, 401);
    });
    await t.test('ordinary credential sessions remain compatible with an older release', async () => {
      const rt = await auth.issueRefreshToken(guardian, { via: 'password' });
      assert.ok(await oldRefreshOwner(rt));
      const r = await refresh(rt, AWAY);
      assert.equal(r.statusCode, 200, r.body);
      assert.equal((app.jwt.verify(r.json().accessToken) as any).sub, guardian);
      assert.equal((app.jwt.verify(cookie(r, 'yomi_img')!) as any).sub, guardian);
      assert.ok(await oldRefreshOwner(cookie(r, 'yomi_rt')!));
    });
  } finally {
    await q('DELETE FROM audit_log WHERE user_id = ANY($1::uuid[])', [[guardian, child]]).catch(() => {});
    await q('DELETE FROM users WHERE id = ANY($1::uuid[])', [[guardian, child]]).catch(() => {});
    await app.close();
  }
});
