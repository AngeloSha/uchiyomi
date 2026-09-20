// Two-factor enrolment is one way: setup cannot rotate a live secret.
//
// POST /auth/totp/setup writes a pending secret and returns it for the QR. It used to do that
// unconditionally, so a "Set up 2FA" button rendered from a stale `totpEnabled` (the profile's Account tab
// remounts with the auth context's copy of the user, which is re-read every twelve minutes) replaced the
// secret the authenticator app already held: the flag stayed on, the app's codes stopped matching, and the
// next login needed a recovery code. The web side now keeps its copy in step; this is the server belt --
// with two-factor on, setup is 409 `totp_enabled` and the row is not touched. The pending case is pinned
// too, because a setup pressed twice BEFORE enabling must still hand out a fresh secret (the QR on screen
// is the one that counts), and the disable route is pinned as the only way back to setup.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const USER = 'totp-setup-reader';
const PASSWORD = 'correct horse battery';

/**
 * The code an authenticator app would show for `secret` right now (RFC 6238: SHA-1, 6 digits, 30 s), written
 * out here rather than imported so the test does not verify the server's TOTP with the server's own TOTP.
 */
function codeFor(secret: string): string {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0; let value = 0; const bytes: number[] = [];
  for (const c of secret.toUpperCase()) {
    const idx = B32.indexOf(c);
    if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const h = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | ((h[o + 1] & 0xff) << 16) | ((h[o + 2] & 0xff) << 8) | (h[o + 3] & 0xff);
  return (n % 1_000_000).toString().padStart(6, '0');
}

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q, one } = await import('../src/lib/db');
  const { hash } = await import('@node-rs/argon2');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const authRoutes = (await import('../src/routes/auth')).default;

  await migrate();
  await q('DELETE FROM users WHERE username = $1', [USER]);
  const userId = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind)
     VALUES ($1,$1,$2,'user','password') RETURNING id`, [USER, await hash(PASSWORD)],
  ))[0].id;

  const app = Fastify();
  await app.register(cookie);
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(authRoutes);
  await app.ready();

  const headers = { authorization: `Bearer ${app.jwt.sign({ sub: userId, role: 'user' }, { expiresIn: 60 })}` };
  const post = (url: string, payload?: unknown) => app.inject({ method: 'POST', url, headers, payload });
  const row = async () => (await one<{ totp_enabled: boolean; totp_secret: string | null }>(
    'SELECT totp_enabled, totp_secret FROM users WHERE id = $1', [userId]))!;
  return { app, q, post, row };
}

test('two-factor setup refuses to touch a live secret', { skip }, async (t) => {
  const { app, q, post, row } = await setup();
  try {
    let pending = '';
    await t.test('setup hands out a pending secret, and a second setup before enabling replaces it', async () => {
      const first = await post('/auth/totp/setup');
      assert.equal(first.statusCode, 200, first.body);
      assert.match(first.json().secret, /^[A-Z2-7]{32}$/, 'the secret is not 20 base32 bytes');
      assert.equal((await row()).totp_secret, first.json().secret, 'the pending secret was not written');
      // Pressing the button twice is normal; the QR on screen must be the one the row holds. Reintroduce by
      // refusing setup whenever a secret exists rather than when the flag is on: this second call sees 409.
      const second = await post('/auth/totp/setup');
      assert.equal(second.statusCode, 200, `a second setup before enabling was refused: ${second.body.slice(0, 120)}`);
      assert.notEqual(second.json().secret, first.json().secret, 'a second setup handed out the same secret');
      const r = await row();
      assert.equal(r.totp_secret, second.json().secret, 'the second pending secret was not written');
      assert.equal(r.totp_enabled, false, 'setup alone turned two-factor on');
      pending = second.json().secret;
    });

    await t.test('a code from the app enables it', async () => {
      const wrong = await post('/auth/totp/enable', { code: '000000' });
      assert.equal(wrong.statusCode, 400, `a wrong code enabled two-factor: ${wrong.body}`);
      const ok = await post('/auth/totp/enable', { code: codeFor(pending) });
      assert.equal(ok.statusCode, 200, ok.body);
      assert.ok(Array.isArray(ok.json().recoveryCodes) && ok.json().recoveryCodes.length > 0, 'no recovery codes came back');
      const r = await row();
      assert.equal(r.totp_enabled, true);
      assert.equal(r.totp_secret, pending, 'enabling changed the secret the app was given');
    });

    await t.test('with two-factor on, setup is 409 totp_enabled and the row is untouched', async () => {
      // ⚠️ THE BELT. Reintroduce by dropping the `totp_enabled` check from the setup route (and the
      // `AND NOT totp_enabled` from its UPDATE): this sees 200 with a fresh secret, the row now holds a
      // secret no authenticator has, the flag is still on, and the next login needs a recovery code.
      const stale = await post('/auth/totp/setup');
      assert.equal(stale.statusCode, 409, `setup with two-factor on answered ${stale.statusCode}: ${stale.body.slice(0, 120)}`);
      assert.equal(stale.json().error, 'totp_enabled');
      assert.ok(typeof stale.json().message === 'string' && stale.json().message.length > 0, 'no message to show');
      assert.equal(stale.json().secret, undefined, 'a refused setup still leaked a secret');
      const r = await row();
      assert.equal(r.totp_secret, pending, 'a refused setup rotated the live secret anyway');
      assert.equal(r.totp_enabled, true, 'a refused setup turned two-factor off');
    });

    await t.test('disable needs the password, and is the way back to setup', async () => {
      const wrong = await post('/auth/totp/disable', { password: 'not it' });
      assert.equal(wrong.statusCode, 401, `a wrong password disabled two-factor: ${wrong.body}`);
      assert.equal(wrong.json().error, 'wrong_password');
      assert.equal((await row()).totp_enabled, true, 'a wrong password turned two-factor off');
      const ok = await post('/auth/totp/disable', { password: PASSWORD });
      assert.equal(ok.statusCode, 200, ok.body);
      const r = await row();
      assert.equal(r.totp_enabled, false);
      assert.equal(r.totp_secret, null, 'disable left the old secret in the row');
      // And the belt lifts: setup is a fresh enrolment again.
      const again = await post('/auth/totp/setup');
      assert.equal(again.statusCode, 200, `setup after disable answered ${again.statusCode}: ${again.body}`);
      assert.notEqual(again.json().secret, pending, 'setup after disable handed the old secret back');
    });
  } finally {
    await app.close();
    await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  }
});
