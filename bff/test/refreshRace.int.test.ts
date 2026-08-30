// Two tabs, one cookie jar: the refresh endpoint under a rotation race.
//
// A browser is one cookie jar but several refresh timers. Every mounted AuthProvider refreshes on load and
// then every twelve minutes (web/lib/auth.tsx), and the service worker refreshes on its own for background
// sync. Two tabs left open collide on that schedule for as long as they stay open.
//
// The loser's request is already in flight carrying the token the winner has just rotated away. This endpoint
// used to answer that with `reply.clearCookie(REFRESH_COOKIE)` -- which deletes the GOOD token the winner
// wrote a moment earlier, because both tabs share the jar. The tab, the other tab and the whole device were
// signed out, and on a household instance that means a child locked out until an adult resets the password.
//
// The fix forgives a token that was ROTATED within a grace window, and only a rotated one: `replaced_by` is
// set by rotation and left null by logout, by an admin revoke and by sign-out-everywhere, so ending a session
// still ends it immediately. Both halves are tested here, because a grace window that also forgave logout
// would be a worse bug than the one it replaced.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
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

const USER = 'rr-reader';

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { issueRefreshToken } = await import('../src/lib/auth');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const authRoutes = (await import('../src/routes/auth')).default;

  await migrate();
  await q('DELETE FROM users WHERE username = $1', [USER]);
  const userId = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind)
     VALUES ($1,$1,'x','user','password') RETURNING id`, [USER],
  ))[0].id;

  const app = Fastify();
  await app.register(cookie);
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(authRoutes);
  await app.ready();

  return { app, q, userId, issueRefreshToken };
}

/** The `yomi_rt` value a response sets, or null when it sets none. '' means it actively cleared it. */
function rtCookie(res: any): string | null {
  const set = res.cookies?.find((c: any) => c.name === 'yomi_rt');
  return set ? set.value : null;
}

const refresh = (app: any, token: string) =>
  app.inject({ method: 'POST', url: '/auth/refresh', cookies: { yomi_rt: token } });

test('refresh under a rotation race', { skip }, async (t) => {
  const { app, q, userId, issueRefreshToken } = await setup();

  try {
    await t.test('the winner rotates normally', async () => {
      const t1 = await issueRefreshToken(userId, { deviceName: 'tab-a' });
      const res = await refresh(app, t1);
      assert.equal(res.statusCode, 200);
      const t2 = rtCookie(res);
      assert.ok(t2 && t2 !== t1, 'a successful refresh should hand back a new token');
    });

    await t.test('the loser is not signed out, and does NOT clear the winner cookie', async () => {
      const t1 = await issueRefreshToken(userId, { deviceName: 'tab-a' });
      const winner = await refresh(app, t1);           // tab A rotates t1 -> t2
      const t2 = rtCookie(winner);
      assert.ok(t2, 'precondition: the winner got a token');

      const loser = await refresh(app, t1);            // tab B was in flight with t1
      assert.equal(loser.statusCode, 200, 'the loser of a rotation race must not be signed out');
      assert.ok(loser.json().accessToken || loser.json().token, 'the loser still needs a usable access token');
      // The decisive assertion. Setting yomi_rt to '' is what deleted the winner's token from the shared jar.
      assert.equal(rtCookie(loser), null, 'the loser must not touch the cookie the winner just wrote');

      // and the winner's token is still good afterwards, which is the thing the user actually experiences
      const after = await refresh(app, t2!);
      assert.equal(after.statusCode, 200, 'the winner token should survive the loser request');
    });

    await t.test('a logged-out token is refused at once, grace or no grace', async () => {
      const tok = await issueRefreshToken(userId, { deviceName: 'tab-a' });
      const out = await app.inject({ method: 'POST', url: '/auth/logout', cookies: { yomi_rt: tok } });
      assert.equal(out.statusCode, 200);

      const res = await refresh(app, tok);
      assert.equal(res.statusCode, 401, 'logout must end the session immediately, not after the grace window');
      assert.equal(rtCookie(res), '', 'a genuinely dead token should still clear the cookie');
    });

    await t.test('sign-out-everywhere is not forgiven either', async () => {
      const { revokeAllSessions } = await import('../src/lib/auth');
      const tok = await issueRefreshToken(userId, { deviceName: 'tab-a' });
      await revokeAllSessions(userId);
      const res = await refresh(app, tok);
      assert.equal(res.statusCode, 401, 'revoking every session must take effect immediately');
    });

    await t.test('a rotation older than the grace window is refused', async () => {
      const tok = await issueRefreshToken(userId, { deviceName: 'tab-a' });
      await refresh(app, tok);                          // rotates it, setting replaced_by
      // age the revocation past the window rather than sleeping through it
      await q(`UPDATE refresh_tokens SET revoked_at = now() - interval '10 minutes'
               WHERE user_id = $1 AND replaced_by IS NOT NULL`, [userId]);
      const res = await refresh(app, tok);
      assert.equal(res.statusCode, 401, 'the grace window must be a window, not an open door');
    });
  } finally {
    await app.close();
    await q('DELETE FROM users WHERE username = $1', [USER]);
  }
});
