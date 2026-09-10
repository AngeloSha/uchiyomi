// Consent, driven over HTTP rather than asserted about the source.
//
// consentSurface.test.ts reads the code and checks it still says the right things. This runs the actual
// routes against a real database, because the promises are about STATE -- what is on disk after somebody
// flips a switch -- and a source scan cannot see state.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  // ⚠️ Empty, so nothing in this file can reach the network. The opt-out path calls sendForget() and the
  // default url is a live server -- a test suite must not ping the real collector on every CI run.
  process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q, one } = await import('../src/lib/db');
  const adminRoutes = (await import('../src/routes/admin')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await migrate();

  await q(`DELETE FROM users WHERE username LIKE 'ic-%'`).catch(() => {});
  const admin = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind)
     VALUES ('ic-admin','ic-admin','x','admin','password') RETURNING id`))[0].id;
  // Leave the row in its shipped state, whatever earlier tests did to it.
  await q('UPDATE server_settings SET install_ping = false, install_ping_secret = NULL, install_ping_last = NULL, update_check = true WHERE id = 1');

  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(adminRoutes);
  await app.ready();
  const auth = { authorization: `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}` };
  const settings = () => one<any>('SELECT * FROM server_settings WHERE id = 1');
  const patch = (body: any) => app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: auth, payload: body });
  return { app, auth, settings, patch, q };
}

test('the install count is opt-in, and opting out forgets', { skip }, async (t) => {
  const { app, auth, settings, patch } = await setup();
  try {
    await t.test('it ships off, with no secret to send under', async () => {
      const s = await settings();
      assert.equal(s.install_ping, false, 'the count must be off on a fresh install');
      assert.equal(s.install_ping_secret, null, 'a server that never consented must not hold an identifier');
      assert.equal(s.update_check, true, 'the update check, which tells nobody anything, may default on');
    });

    await t.test('previewing does not opt in', async () => {
      // ⚠️ Being shown what would be sent must not itself be the act of agreeing to send it.
      // Reintroduce by generating and STORING a secret in the preview route.
      const r = await app.inject({ method: 'GET', url: '/api/admin/install-ping/preview', headers: auth });
      assert.equal(r.statusCode, 200);
      const body = r.json();
      assert.deepEqual(Object.keys(body.payload).sort(), ['arch', 'db', 'id', 'layout', 'month', 'version']);
      assert.equal(body.sample, true, 'with no secret yet, the preview must say the id is a sample');

      const s = await settings();
      assert.equal(s.install_ping, false, 'previewing turned the count on');
      assert.equal(s.install_ping_secret, null, 'previewing minted and stored an identifier');
    });

    let firstSecret = '';
    await t.test('opting in mints a secret, and the preview then shows the real id', async () => {
      await patch({ installPing: true });
      const s = await settings();
      assert.equal(s.install_ping, true);
      assert.match(s.install_ping_secret ?? '', /^[0-9a-f]{64}$/, 'opting in must mint a per-install secret');
      firstSecret = s.install_ping_secret;

      const body = (await app.inject({ method: 'GET', url: '/api/admin/install-ping/preview', headers: auth })).json();
      assert.equal(body.sample, false, 'once opted in, the preview is the real id, not a sample');
      assert.ok(!JSON.stringify(body).includes(firstSecret), 'the secret leaked through the preview endpoint');
    });

    await t.test('opting in twice keeps the same identity rather than churning it', async () => {
      await patch({ installPing: true });
      assert.equal((await settings()).install_ping_secret, firstSecret, 'a no-op save must not re-roll the id');
    });

    await t.test('OPTING OUT DESTROYS THE SECRET', async () => {
      // ⚠️ The claim in the settings page. Reintroduce by only setting install_ping = false: the pings stop,
      // so nothing looks different, but a permanent identifier stays on disk and re-enabling re-links this
      // server to its own history.
      await patch({ installPing: false });
      const s = await settings();
      assert.equal(s.install_ping, false);
      assert.equal(s.install_ping_secret, null, 'opting out left the identifier behind');
      assert.equal(s.install_ping_last, null);
    });

    await t.test('opting back in cannot resume the old identity', async () => {
      await patch({ installPing: true });
      const s = await settings();
      assert.match(s.install_ping_secret ?? '', /^[0-9a-f]{64}$/);
      assert.notEqual(s.install_ping_secret, firstSecret, 're-enabling recovered the previous identifier');
      await patch({ installPing: false });
    });

    await t.test('the update check can be turned off, and reads back off', async () => {
      await patch({ updateCheck: false });
      assert.equal((await settings()).update_check, false);
      await patch({ updateCheck: true });
      assert.equal((await settings()).update_check, true);
    });
  } finally {
    await app.close();
  }
});
