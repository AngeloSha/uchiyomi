// Two-factor recovery codes sign a person in, once each.
//
// Since the codes went from 5 to 10 random bytes (lib/totp.ts generateRecoveryCodes, v0.21.0) they are made as
// xxxxx-xxxxx-xxxxx-xxxxx, 23 characters, while sign-in still capped the code at 16 and tried only the old
// xxxx-xxxxxx shape. No code handed out since was ever accepted, and with no admin reset for two-factor a lost
// authenticator was a lost account. Pinned here against the real route and a real row: a code from /auth/totp/enable
// signs in, the same code a second time does not, a code typed without dashes or in capitals still works, and a code
// of the old shape an account may still hold keeps working.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const USER = 'recovery-code-reader';
const PASSWORD = 'correct horse battery';

/** The code an authenticator app would show for `secret` now (RFC 6238), written out so the server is not its own judge. */
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

test('two-factor recovery codes sign in, once each', { skip }, async (t) => {
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
  const login = (code: string) => app.inject({ method: 'POST', url: '/auth/login', payload: { username: USER, password: PASSWORD, code } });
  const left = async () => (await one<{ n: number }>('SELECT cardinality(recovery_codes)::int AS n FROM users WHERE id = $1', [userId]))!.n;

  try {
    const setup = await app.inject({ method: 'POST', url: '/auth/totp/setup', headers });
    assert.equal(setup.statusCode, 200, setup.body);
    const enable = await app.inject({ method: 'POST', url: '/auth/totp/enable', headers, payload: { code: codeFor(setup.json().secret), password: PASSWORD } });
    assert.equal(enable.statusCode, 200, enable.body);
    const codes: string[] = enable.json().recoveryCodes;
    assert.equal(codes.length, 8);
    for (const c of codes) assert.match(c, /^[0-9a-f]{5}-[0-9a-f]{5}-[0-9a-f]{5}-[0-9a-f]{5}$/, 'the code shape this test is about');

    await t.test('a code exactly as it was shown signs in, and is used up', async () => {
      // Reintroduce by putting back `max(16)` on the login body, or the `{4}-{6}` test alone: this is 400 / 401.
      const ok = await login(codes[0]);
      assert.equal(ok.statusCode, 200, ok.body);
      assert.ok(ok.json().accessToken, 'no session from a good recovery code');
      assert.equal(await left(), 7, 'the used code was not removed');
      const again = await login(codes[0]);
      assert.equal(again.statusCode, 401, `a recovery code worked twice: ${again.body}`);
      assert.equal(again.json().error, 'totp_invalid');
    });

    await t.test('without its dashes, in capitals, with spaces around: still the code', async () => {
      const typed = `  ${codes[1].replace(/-/g, '').toUpperCase()} `;
      const ok = await login(typed);
      assert.equal(ok.statusCode, 200, ok.body);
      assert.equal(await left(), 6);
    });

    await t.test('two sign-ins racing with one code: one session', async () => {
      // Reintroduce by reading the array and removing afterwards (the old two-step): both are 200.
      const [a, b] = await Promise.all([login(codes[2]), login(codes[2])]);
      assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 401], `racing sign-ins answered ${a.statusCode} and ${b.statusCode}`);
      assert.equal(await left(), 5);
    });

    await t.test('a code of the old xxxx-xxxxxx shape an account still holds keeps working', async () => {
      const old = 'abcd-ef0123';
      await q('UPDATE users SET recovery_codes = array_append(recovery_codes, $2) WHERE id = $1',
        [userId, createHash('sha256').update(old).digest('hex')]);
      const ok = await login(old);
      assert.equal(ok.statusCode, 200, ok.body);
      assert.equal(await left(), 5);
    });

    await t.test('something that is no code is refused without touching the codes', async () => {
      const bad = await login('00000-00000-00000-00000');
      assert.equal(bad.statusCode, 401, bad.body);
      assert.equal(bad.json().error, 'totp_invalid');
      assert.equal(await left(), 5);
    });
  } finally {
    await app.close();
    await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  }
});
