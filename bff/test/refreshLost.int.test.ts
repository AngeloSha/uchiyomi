// A refresh whose answer never reached the browser: the endpoint, mounted for real, driven over HTTP.
//
// `POST /auth/refresh` rotates the `yomi_rt` cookie. When the browser abandons the request after the server
// has rotated -- the page reloads or navigates while the app's boot refresh is in flight, the tab is closed,
// the network drops the response -- the server has moved on and the cookie jar has not: it still holds the
// token the server just superseded. The grace window answered that token for 60 seconds and then refused it,
// so the device was signed out a minute later, by whatever refreshed next (a tab switch was enough).
//
// Reproduced 2026-09-25 in a real, headful Chrome with real keypresses: F5, and F5 again 200 ms later, over a
// 200 ms round trip (and again with nothing but DevTools' own "Slow 4G" preset). The first page's refresh was
// answered by the server and never by the browser; seventy seconds later switching tabs away and back put the
// sign-in screen up. On a LAN the answer outruns the reload and nothing happens, which is why it looked like
// an artefact of the e2e harness.
//
// The fix (planRefresh in lib/auth.ts, step 5) recovers such a token: once nothing newer in the session has
// ever been used and the newest token is older than the grace window, the old token gets a new one. The rest
// of this file is what that must NOT loosen: a session that was ended stays ended, a device that moved on is
// not undone by an old token, two holders of one session end it rather than share it, and nothing forks.
//
// Time is moved by ageing the rows, never by sleeping. Skipped automatically unless TEST_DATABASE_URL is set.
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

const USER = 'rl-reader';

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const auth = await import('../src/lib/auth');
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

  return { app, q, userId, auth };
}

/** The `yomi_rt` a response sets: the value, '' when it clears it, null when it leaves the jar alone. */
function rtCookie(res: any): string | null {
  const set = res.cookies?.find((c: any) => c.name === 'yomi_rt');
  return set ? set.value : null;
}

const refresh = (app: any, token: string) =>
  app.inject({ method: 'POST', url: '/auth/refresh', cookies: { yomi_rt: token } });

test('a refresh whose answer never arrived', { skip }, async (t) => {
  const { app, q, userId, auth } = await setup();

  /** Everything this account's tokens did happened ten minutes earlier: well past the grace window. */
  const age = () => q(
    `UPDATE refresh_tokens SET created_at = created_at - interval '10 minutes',
            revoked_at = revoked_at - interval '10 minutes', last_seen = last_seen - interval '10 minutes'
      WHERE user_id = $1`, [userId]);
  const live = async () => Number((await q<{ n: string }>(
    'SELECT count(*) AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL', [userId]))[0].n);
  /** A token the server rotated for a request whose answer the browser then threw away. */
  const lostRotation = async (t0: string) => {
    const res = await refresh(app, t0);
    assert.equal(res.statusCode, 200, 'precondition: the rotation itself succeeded');
    assert.ok(rtCookie(res), 'precondition: the server did rotate');
    return rtCookie(res)!; // the token the browser never saw
  };
  const fresh = async () => {
    await q('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
    return auth.issueRefreshToken(userId, { deviceName: 'phone' });
  };

  try {
    await t.test('the device keeps its session: the old token is recovered, not signed out', async () => {
      const t0 = await fresh();
      await lostRotation(t0);

      // Inside the grace window nothing tells a lost answer from one still on its way, so this is the race
      // answer, exactly as before: an access token, and the jar left alone.
      const soon = await refresh(app, t0);
      assert.equal(soon.statusCode, 200);
      assert.equal(rtCookie(soon), null, 'inside the grace window the cookie must not be touched');

      await age();
      // The decisive request. It used to be 401 plus a cleared cookie: signed out.
      const later = await refresh(app, t0);
      assert.equal(later.statusCode, 200, 'a device whose refresh answer was lost must not be signed out');
      const t2 = rtCookie(later);
      assert.ok(t2 && t2 !== t0, 'the recovery must SET a new token, or the jar keeps the dead one forever');
      assert.ok(later.json().accessToken, 'and the app needs an access token');

      // and from here the device is simply back in rotation
      const next = await refresh(app, t2!);
      assert.equal(next.statusCode, 200, 'the recovered token must work');
      assert.ok(rtCookie(next) && rtCookie(next) !== t2, 'and rotate like any other');
      assert.equal(await live(), 1, 'still ONE session for the device, not one per recovery');
    });

    await t.test('a recovered token keeps the lifetime of the one it replaces', async () => {
      const t0 = await fresh();
      await lostRotation(t0);
      // Give the lost token a lifetime no fresh token would get, so the answer cannot be right by accident.
      const until = (await q<{ e: Date }>(
        `UPDATE refresh_tokens SET expires_at = now() + interval '3 days'
          WHERE user_id = $1 AND revoked_at IS NULL RETURNING expires_at AS e`, [userId]))[0].e;
      await age();

      const res = await refresh(app, t0);
      assert.equal(res.statusCode, 200, 'precondition: the lost answer is recovered');
      assert.ok(rtCookie(res), 'precondition: recovered');
      // A stale token must never renew the session: the recovery re-delivers what was lost, nothing more.
      assert.ok(Math.abs(res.json().refreshExpiresAt - until.getTime()) < 1000,
        `refreshExpiresAt should be the replaced token's expiry (${until.toISOString()}), got ${new Date(res.json().refreshExpiresAt).toISOString()}`);
      const cookie = res.cookies.find((c: any) => c.name === 'yomi_rt');
      assert.ok(Math.abs(cookie.maxAge - 3 * 86400) < 60, `the cookie should live 3 days like the token, not ${cookie.maxAge} s`);
      const row = (await q<{ e: Date }>(
        'SELECT expires_at AS e FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL', [userId]))[0];
      assert.equal(row.e.getTime(), until.getTime(), 'the stored token too');
    });

    await t.test('an old token does not undo a device that moved on', async () => {
      const t0 = await fresh();
      const t1 = await lostRotation(t0);   // this time the answer DID land ...
      const used = await refresh(app, t1); // ... and the device went on to use it
      assert.equal(used.statusCode, 200);
      const t2 = rtCookie(used)!;
      await age();

      const res = await refresh(app, t0);
      assert.equal(res.statusCode, 401, 'a token behind one the device has since used is simply old');
      assert.equal(rtCookie(res), '', 'and is cleared like any dead token');
      assert.equal((await refresh(app, t2)).statusCode, 200, 'without harming the session that moved on');
    });

    await t.test('signing out with the stale cookie ends the session', async () => {
      const t0 = await fresh();
      await lostRotation(t0);
      // The jar still holds t0, so that is what sign-out presents. Revoking only t0 left the token the
      // browser never received live -- and t0 could then have recovered it: a session back from a sign-out.
      const out = await app.inject({ method: 'POST', url: '/auth/logout', cookies: { yomi_rt: t0 } });
      assert.equal(out.statusCode, 200);
      assert.equal(await live(), 0, 'sign-out must end the whole session, not just the token it was handed');
      await age();
      assert.equal((await refresh(app, t0)).statusCode, 401, 'and nothing may bring it back');
    });

    await t.test('sign-out-everywhere and an admin revoke are final at once, even inside the grace', async () => {
      const t0 = await fresh();
      await lostRotation(t0);
      await auth.revokeAllSessions(userId);
      // No ageing: this is inside the grace window, which used to forgive a superseded token even here.
      const a = await refresh(app, t0);
      assert.equal(a.statusCode, 401, 'sign-out-everywhere must not leave a minute of grace behind');

      const t0b = await fresh();
      await lostRotation(t0b);
      const head = (await q<{ id: string }>(
        'SELECT id FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL', [userId]))[0].id;
      await auth.revokeRefreshTokenById(head); // what DELETE /api/admin/sessions/:id does
      assert.equal((await refresh(app, t0b)).statusCode, 401, 'an admin revoke must end it at once too');
      await age();
      assert.equal((await refresh(app, t0b)).statusCode, 401, 'and it must not be recovered later');
    });

    await t.test('two holders of one session end it rather than share it', async () => {
      const t0 = await fresh();
      const t1 = await lostRotation(t0); // the device got t1; someone else kept a copy of t0
      await age();

      const thief = await refresh(app, t0); // looks exactly like a lost answer, and is recovered as one
      assert.equal(thief.statusCode, 200, 'precondition: t0 recovered');
      const n1 = rtCookie(thief)!;

      // The device's t1 was superseded by that recovery. A moment later it is the grace answer ...
      const soon = await refresh(app, t1);
      assert.equal(soon.statusCode, 200);
      assert.equal(rtCookie(soon), null);
      // ... but once the grace is over, two jars are holding one session. Neither keeps it: without this the
      // two would trade it back and forth (each recovering the other's newest token) for as long as they liked.
      await age();
      const device = await refresh(app, t1);
      assert.equal(device.statusCode, 401, 'a token superseded by someone else\'s recovery is not recovered itself');
      assert.equal((await refresh(app, n1)).statusCode, 401, 'and the recovered copy is ended with it');
      assert.equal(await live(), 0, 'no live token left in that session');
    });

    await t.test('two refreshes of one token at once cannot fork the session', async () => {
      const t0 = await fresh();
      const [a, b] = await Promise.all([refresh(app, t0), refresh(app, t0)]);
      assert.deepEqual([a.statusCode, b.statusCode], [200, 200], 'neither request may be signed out');
      const set = [rtCookie(a), rtCookie(b)].filter(Boolean);
      assert.equal(set.length, 1, `exactly one of them rotates; the other is the race answer (set: ${set.length})`);
      assert.equal(await live(), 1, 'one live token: two would be two sessions for one device');

      // The same for two recoveries at once: one recovers, the other leaves the jar to it.
      const u0 = await fresh();
      await lostRotation(u0);
      await age();
      const [c, d] = await Promise.all([refresh(app, u0), refresh(app, u0)]);
      assert.deepEqual([c.statusCode, d.statusCode], [200, 200]);
      assert.equal([rtCookie(c), rtCookie(d)].filter(Boolean).length, 1, 'exactly one of them recovers');
      assert.equal(await live(), 1, 'one live token after two recoveries at once');
    });
  } finally {
    await app.close();
    await q('DELETE FROM users WHERE username = $1', [USER]);
  }
});
