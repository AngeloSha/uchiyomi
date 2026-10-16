// A two-factor code signs in once (v0.77.1, RFC 6238 section 5.2).
//
// The code is checked against the steps either side of now as well, for clock drift, so each one was good for about a
// minute and a half -- a code read over a shoulder or out of a screen recording signed in again until it ran out. Now
// the step a code was made for must be later than the last one the account used, and is recorded in the statement that
// checks it (lib/auth.ts spendTotpStep, users.totp_last_step). The code that turns two-factor on is spent the same way,
// and a new secret starts with nothing spent.
//
// Every code below is made for a step counted from ONE moment taken at the start, never from "now" again, so a 30 s
// boundary passing mid-test changes which step is current but never which step a code belongs to.
// Skipped automatically unless TEST_DATABASE_URL is set.
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

const USER = 'totp-replay-reader';
const PASSWORD = 'correct horse battery';

/** The code an authenticator shows for `secret` at 30 s step `step` (RFC 6238), written out here. */
function codeAt(secret: string, step: number): string {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0; let value = 0; const bytes: number[] = [];
  for (const c of secret.toUpperCase()) {
    const idx = B32.indexOf(c);
    if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | ((h[o + 1] & 0xff) << 16) | ((h[o + 2] & 0xff) << 8) | (h[o + 3] & 0xff);
  return (n % 1_000_000).toString().padStart(6, '0');
}

test('a two-factor code signs in once', { skip }, async (t) => {
  const { migrate } = await import('../src/lib/migrate');
  const { q, one } = await import('../src/lib/db');
  const { hash } = await import('@node-rs/argon2');
  const Fastify = (await import('fastify')).default;

  await migrate();
  await q('DELETE FROM users WHERE username = $1', [USER]);
  const userId = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind)
     VALUES ($1,$1,$2,'user','password') RETURNING id`, [USER, await hash(PASSWORD)],
  ))[0].id;

  const app = Fastify();
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/auth')).default);
  await app.ready();

  const headers = { authorization: `Bearer ${app.jwt.sign({ sub: userId, role: 'user' }, { expiresIn: 300 })}` };
  const post = (url: string, payload?: unknown) => app.inject({ method: 'POST', url, headers, payload });
  const login = (code: string) => app.inject({ method: 'POST', url: '/auth/login', payload: { username: USER, password: PASSWORD, code } });
  const spent = async () => {
    const r = await one<{ s: string | null }>('SELECT totp_last_step::text AS s FROM users WHERE id = $1', [userId]);
    return r?.s == null ? null : Number(r.s);
  };
  // Between tests the lock is cleared: a refused replay counts as a wrong code (accountLock.int.test.ts), and this file
  // is about the step, not the count.
  const unlock = () => q('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [userId]);

  const S = Math.floor(Date.now() / 1000 / 30);
  try {
    const setup = await post('/auth/totp/setup');
    assert.equal(setup.statusCode, 200, setup.body);
    const secret: string = setup.json().secret;

    await t.test('the code that turns it on is spent', async () => {
      const on = await post('/auth/totp/enable', { code: codeAt(secret, S), password: PASSWORD });
      assert.equal(on.statusCode, 200, on.body);
      // Reintroduce by enabling without recording the step: this signs in with the very code just typed to turn it on.
      const again = await login(codeAt(secret, S));
      assert.equal(again.statusCode, 401, `the enabling code signed in: ${again.body}`);
      assert.equal(again.json().error, 'totp_invalid');
      assert.equal(await spent(), S, 'enabling did not record the step it was confirmed with');
      await unlock();
    });

    await t.test('a code signs in once, and only a later one after it', async () => {
      // Reintroduce by accepting any step in the window (spendTotpStep's `totp_last_step < $2` dropped): the second
      // sign-in with the same code is a 200 too.
      const first = await login(codeAt(secret, S + 1));
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(await spent(), S + 1);
      const replay = await login(codeAt(secret, S + 1));
      assert.equal(replay.statusCode, 401, `a code signed in twice: ${replay.body}`);
      assert.equal(replay.json().error, 'totp_invalid');
      // An earlier step than the last one used is no better than the same one.
      const older = await login(codeAt(secret, S));
      assert.equal(older.statusCode, 401, `a code older than the last one signed in: ${older.body}`);
      assert.equal(await spent(), S + 1, 'a refused code moved the step');
      await unlock();
    });

    await t.test('two sign-ins racing with one code: one session', async () => {
      // As for an account that turned two-factor on before v0.77.1: nothing spent yet.
      await q('UPDATE users SET totp_last_step = NULL WHERE id = $1', [userId]);
      // Reintroduce by reading the last step with the account and writing it afterwards: both are 200.
      const [a, b] = await Promise.all([login(codeAt(secret, S + 1)), login(codeAt(secret, S + 1))]);
      assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 401], `racing sign-ins answered ${a.statusCode} and ${b.statusCode}`);
      assert.equal(await spent(), S + 1);
      await unlock();
    });

    await t.test('a new secret starts with nothing spent', async () => {
      const off = await post('/auth/totp/disable', { password: PASSWORD });
      assert.equal(off.statusCode, 200, off.body);
      const again = await post('/auth/totp/setup');
      assert.equal(again.statusCode, 200, again.body);
      const fresh: string = again.json().secret;
      // The step the old secret last used, with the new secret's code for it: refused only if the old step had stayed.
      // Reintroduce by clearing totp_last_step in neither disable nor setup: this is a 400 totp_invalid.
      const on = await post('/auth/totp/enable', { code: codeAt(fresh, S + 1), password: PASSWORD });
      assert.equal(on.statusCode, 200, `a new secret was refused a step the old one had used: ${on.body}`);
      assert.equal(await spent(), S + 1);
    });
  } finally {
    await app.close();
    await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  }
});

test('totpStep names the latest step a code matches in the window, and nothing outside it', async () => {
  const { totpStep, generateSecret } = await import('../src/lib/totp');
  const secret = generateSecret();
  const now = Date.UTC(2026, 9, 16, 12, 0, 15);
  const S = Math.floor(now / 1000 / 30);
  for (const d of [-1, 0, 1]) assert.equal(totpStep(secret, codeAt(secret, S + d), 1, now), S + d, `step ${d}`);
  for (const d of [-3, -2, 2, 3]) {
    const c = codeAt(secret, S + d);
    // A code from outside the window may by chance equal one inside it (one in a million); that one is not this test's.
    if ([-1, 0, 1].some((w) => codeAt(secret, S + w) === c)) continue;
    assert.equal(totpStep(secret, c, 1, now), null, `step ${d} is outside the window`);
  }
  assert.equal(totpStep(secret, 'abcdef', 1, now), null);
  assert.equal(totpStep(secret, ` ${codeAt(secret, S)} `, 1, now), S, 'spaces around a code are forgiven');
});
