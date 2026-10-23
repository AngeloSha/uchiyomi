// A session's lineage (refresh_tokens.session_id, parent_session, via; lib/auth.ts issueRefreshToken, supersede,
// revokeDerived): a profile entered from another account's session must end when that session ends, however it ends,
// and must keep its parent through every rotation of either. Nothing opens such a
// session yet; these hold the plumbing the profile switch will stand on. Skipped unless TEST_DATABASE_URL is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const NAMES = ['sl-guardian', 'sl-child', 'sl-reader'];
const PASSWORD = 'sl-password-only-for-this-test';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q, one } = await import('../src/lib/db');
  const auth = await import('../src/lib/auth');
  const { hash } = await import('@node-rs/argon2');
  const Fastify = (await import('fastify')).default;
  const authRoutes = (await import('../src/routes/auth')).default;

  await migrate();
  await q('DELETE FROM users WHERE username = ANY($1)', [NAMES]);
  const ph = await hash(PASSWORD);
  const make = async (name: string) => (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1, $1, $2, 'user', 'password') RETURNING id`,
    [name, ph]))[0].id;
  const guardian = await make('sl-guardian');
  const child = await make('sl-child');
  const reader = await make('sl-reader');

  const app = Fastify();
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register(authRoutes);
  await app.ready();
  return { app, q, one, auth, guardian, child, reader };
}

const rtCookie = (res: any): string | null => res.cookies?.find((c: any) => c.name === 'yomi_rt')?.value ?? null;

test('session lineage', { skip }, async (t) => {
  const { app, q, one, auth, guardian, child, reader } = await setup();
  const row = (token: string) => one<{ id: string; session_id: string | null; parent_session: string | null; via: string | null; revoked: boolean }>(
    `SELECT id, session_id, parent_session, via, revoked_at IS NOT NULL AS revoked FROM refresh_tokens WHERE token_hash = $1`, [sha(token)]);
  const refresh = (token: string) => app.inject({ method: 'POST', url: '/auth/refresh', cookies: { yomi_rt: token } });
  const bearer = (userId: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub: userId, role: 'user' })}` });
  /** A guardian's session and a child session opened from it: the shape the profile switch will write. */
  const family = async () => {
    const g = await auth.issueRefreshToken(guardian, { deviceName: 'tablet', via: 'password' });
    const c = await auth.issueRefreshToken(child, { deviceName: 'tablet', parentSession: (await row(g))!.session_id! });
    return { g, c };
  };
  const childLives = async (c: string) => (await refresh(c)).statusCode === 200;

  try {
    await t.test('a sign-in starts a session named by its first token, and says how it was entered', async () => {
      const res = await app.inject({ method: 'POST', url: '/auth/login', remoteAddress: '198.51.100.40',
        payload: { username: 'sl-reader', password: PASSWORD } });
      assert.equal(res.statusCode, 200);
      const r = await row(rtCookie(res)!);
      assert.equal(r?.session_id, r?.id, 'a new session is named by its first token');
      assert.equal(r?.via, 'password');
      assert.equal(r?.parent_session, null);
    });

    await t.test('a session keeps its name, its parent and its way in through every rotation', async () => {
      // Reintroduce by leaving the three columns out of supersede: the rotated child has no parent and outlives it.
      const { g, c } = await family();
      const first = (await row(c))!;
      let token = c;
      for (let i = 0; i < 2; i++) {
        const res = await refresh(token);
        assert.equal(res.statusCode, 200);
        token = rtCookie(res)!;
        const r = (await row(token))!;
        assert.notEqual(r.id, first.id, 'precondition: rotated to a new token');
        assert.deepEqual([r.session_id, r.parent_session], [first.session_id, first.parent_session]);
      }
      // The guardian rotates too: the child still names the session, not a token of it.
      const g2 = rtCookie(await refresh(g))!;
      assert.equal((await row(g2))!.session_id, (await row(g))!.session_id);
      assert.equal((await row(g2))!.via, 'password', 'the way in is carried to the next token');
      await app.inject({ method: 'POST', url: '/auth/logout', cookies: { yomi_rt: g2 } });
      assert.equal(await childLives(token), false, 'the child outlived its parent across rotations');
    });

    await t.test('ending the parent ends the child, whichever way it ends', async (tt) => {
      await tt.test('signing out', async () => {
        const { g, c } = await family();
        await app.inject({ method: 'POST', url: '/auth/logout', cookies: { yomi_rt: g } });
        assert.equal(await childLives(c), false);
      });
      await tt.test('a revoke from Profile -> Account -> Sessions', async () => {
        const { g, c } = await family();
        const res = await app.inject({ method: 'DELETE', url: `/auth/sessions/${(await row(g))!.id}`, headers: bearer(guardian) });
        assert.equal(res.statusCode, 200);
        assert.equal(await childLives(c), false);
      });
      await tt.test('sign out everywhere else, from another device', async () => {
        const { g, c } = await family();
        const here = await auth.issueRefreshToken(guardian, { deviceName: 'phone' });
        const kept = await auth.issueRefreshToken(child, { parentSession: (await row(here))!.session_id! });
        const res = await app.inject({ method: 'POST', url: '/auth/logout-all', headers: bearer(guardian), cookies: { yomi_rt: here } });
        assert.equal(res.statusCode, 200);
        assert.equal((await row(g))!.revoked, true, 'precondition: the other device was signed out');
        assert.equal(await childLives(c), false, 'the child of the device signed out lives on');
        assert.equal(await childLives(kept), true, 'the child of the device that stays was signed out with the others');
      });
      await tt.test('a password change, a reset or a disable (revokeAllSessions)', async () => {
        const { c } = await family();
        await auth.revokeAllSessions(guardian);
        assert.equal(await childLives(c), false);
      });
      await tt.test('an admin revoking the session (revokeRefreshTokenById)', async () => {
        const { g, c } = await family();
        await auth.revokeRefreshTokenById((await row(g))!.id);
        assert.equal(await childLives(c), false);
      });
      await tt.test('two jars holding one session: planRefresh ends it (step 3)', async () => {
        // A token superseded by a recovery before its holder used it, presented after the grace window: the session
        // is ended so neither jar keeps it, and what was opened from it goes too.
        const sid = '5e550000-0000-4000-8000-0000000000a1';
        const stale = 'sl-stale-token';
        await q(
          `INSERT INTO refresh_tokens (id, session_id, user_id, token_hash, expires_at, created_at, last_seen)
           VALUES ($1, $1, $2, $3, now() + interval '1 day', now() - interval '1 hour', now())`,
          [sid, guardian, sha('sl-head-token')]);
        await q(
          `INSERT INTO refresh_tokens (session_id, user_id, token_hash, expires_at, revoked_at, replaced_by, created_at, last_seen)
           VALUES ($1, $2, $3, now() + interval '1 day', now() - interval '10 minutes', $1, now() - interval '2 hours', now())`,
          [sid, guardian, sha(stale)]);
        const c = await auth.issueRefreshToken(child, { parentSession: sid });
        assert.equal((await refresh(stale)).statusCode, 401, 'precondition: the stale token is refused');
        assert.equal(await childLives(c), false);
      });
    });

    await t.test('a session from before the columns is its own first token', async () => {
      // Rows written before this release have no session_id. The session is then named by the row's id, and keeps
      // that name once it rotates, so a child opened from it is still found when it ends.
      const legacy = 'sl-legacy-token';
      const legacyId = (await q<{ id: string }>(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, last_seen) VALUES ($1, $2, now() + interval '1 day', now()) RETURNING id`,
        [guardian, sha(legacy)]))[0].id;
      const c = await auth.issueRefreshToken(child, { parentSession: legacyId });
      const rotated = rtCookie(await refresh(legacy))!;
      assert.equal((await row(rotated))!.session_id, legacyId, 'the rotated token names the session after the old row');
      await app.inject({ method: 'POST', url: '/auth/logout', cookies: { yomi_rt: rotated } });
      assert.equal(await childLives(c), false);
    });

    await t.test('two sessions naming each other end without looping', async () => {
      const a = await auth.issueRefreshToken(reader, { deviceName: 'a' });
      const b = await auth.issueRefreshToken(reader, { deviceName: 'b', parentSession: (await row(a))!.session_id! });
      await q('UPDATE refresh_tokens SET parent_session = $1 WHERE token_hash = $2', [(await row(b))!.session_id, sha(a)]);
      await app.inject({ method: 'POST', url: '/auth/logout', cookies: { yomi_rt: a } });
      assert.equal((await row(b))!.revoked, true);
    });
  } finally {
    await q('DELETE FROM audit_log WHERE username = ANY($1)', [NAMES]).catch(() => {});
    await q('DELETE FROM users WHERE username = ANY($1)', [NAMES]).catch(() => {});
    await app.close();
  }
});
