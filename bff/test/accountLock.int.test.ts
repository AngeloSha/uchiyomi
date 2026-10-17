// The account lock, wherever a password or a second-step code is checked (v0.77.1).
//
//   - a failure after a lock has run out counts from one, so the account locks again only after five more;
//   - a wrong second-step code at sign-in counts as a wrong password does;
//   - the three password checks behind a session -- changing the password, turning two-factor on or off -- count and
//     lock as sign-in does, are not checked at all while the account is locked, and carry sign-in's per-address limit;
//   - turning two-factor on asks for the password, as turning it off does.
//
// Against the real routes and real rows. Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
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

const PASSWORD = 'correct horse battery';
const PREFIX = 'acct-lock-';

/** The code an authenticator app shows for `secret`, `steps` 30 s steps from now (RFC 6238), written out here. */
function codeFor(secret: string, steps = 0): string {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0; let value = 0; const bytes: number[] = [];
  for (const c of secret.toUpperCase()) {
    const idx = B32.indexOf(c);
    if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30) + steps));
  const h = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | ((h[o + 1] & 0xff) << 16) | ((h[o + 2] & 0xff) << 8) | (h[o + 3] & 0xff);
  return (n % 1_000_000).toString().padStart(6, '0');
}

/** Six digits no step in the drift window answers with, so a "wrong code" is wrong by construction. */
function wrongCode(secret: string): string {
  const near = new Set([-2, -1, 0, 1, 2].map((s) => codeFor(secret, s)));
  for (let n = 0; ; n++) { const c = String(n).padStart(6, '0'); if (!near.has(c)) return c; }
}

let q: any, one: any, hash: any;
let app: any;
let limited: any;

/** The routes as server.ts mounts them, with or without the limiter (it is registered at the root there). */
async function mount(withLimiter: boolean) {
  const Fastify = (await import('fastify')).default;
  const a = Fastify();
  if (withLimiter) await a.register((await import('@fastify/rate-limit')).default, { global: false });
  await a.register((await import('@fastify/cookie')).default);
  await a.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await a.register((await import('../src/routes/auth')).default);
  await a.ready();
  return a;
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  await migrate();
  ({ q, one } = (await import('../src/lib/db')) as any);
  ({ hash } = await import('@node-rs/argon2'));
  await q('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}%`]);
  app = await mount(false);
  limited = await mount(true);
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  await limited?.close();
  await q('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}%`]).catch(() => {});
});

async function account(name: string): Promise<string> {
  const [row] = await q(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1, $1, $2, 'user', 'password') RETURNING id`,
    [PREFIX + name, await hash(PASSWORD)]);
  return row.id;
}
const bearer = (id: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub: id, role: 'user' }, { expiresIn: 300 })}` });
const login = (name: string, password: string, code?: string) =>
  app.inject({ method: 'POST', url: '/auth/login', payload: { username: PREFIX + name, password, ...(code ? { code } : {}) } });
const post = (id: string, url: string, payload: unknown, on = app) => on.inject({ method: 'POST', url, headers: bearer(id), payload });
const lockOf = async (id: string) => {
  const r = await one('SELECT failed_logins, locked_until > now() AS locked FROM users WHERE id = $1', [id]);
  return { count: Number(r.failed_logins), locked: r.locked === true };
};

/** Two-factor on, through the routes; the secret the authenticator holds. */
async function enrol(id: string): Promise<string> {
  const setup = await post(id, '/auth/totp/setup', {});
  assert.equal(setup.statusCode, 200, setup.body);
  const secret = setup.json().secret;
  const on = await post(id, '/auth/totp/enable', { code: codeFor(secret), password: PASSWORD });
  assert.equal(on.statusCode, 200, on.body);
  return secret;
}

test('a failure after a lock has run out counts from one', { skip }, async () => {
  const id = await account('expired');
  // Five failures, fifteen minutes ago: the lock they made has just run out.
  await q(`UPDATE users SET failed_logins = 5, locked_until = now() - interval '1 second' WHERE id = $1`, [id]);
  // Reintroduce by dropping the `locked_until <= now()` cases in recordFailedLogin (lib/auth.ts): this first failure
  // is the sixth, and locks the account again at once -- one wrong password every fifteen minutes keeps it locked.
  const first = await login('expired', 'not the password');
  assert.equal(first.statusCode, 401, `the first failure after the lock locked it again: ${first.body}`);
  assert.equal(first.json().error, 'invalid_credentials');
  assert.deepEqual(await lockOf(id), { count: 1, locked: false }, 'the count did not start again at one');
  // And it takes the usual five to lock it again.
  for (let n = 2; n <= 4; n++) assert.equal((await login('expired', 'not the password')).statusCode, 401, `failure ${n}`);
  const fifth = await login('expired', 'not the password');
  assert.equal(fifth.statusCode, 401, fifth.body);
  assert.deepEqual(await lockOf(id), { count: 5, locked: true });
  // While it lasts, even the right password is refused unread.
  assert.equal((await login('expired', PASSWORD)).statusCode, 401);
});

test('wrong second-step codes lock the account', { skip }, async () => {
  const id = await account('codes');
  const secret = await enrol(id);
  // Reintroduce by only writing a wrong code down (login.totp_fail) without recordFailedLogin: all five are 401
  // totp_invalid and the count stays 0 -- six digits tried at the address limit's pace for as long as anyone likes.
  const wrong = [wrongCode(secret), '00000-00000-00000-00000', wrongCode(secret), wrongCode(secret)];
  for (const [i, code] of wrong.entries()) {
    const r = await login('codes', PASSWORD, code);
    assert.equal(r.statusCode, 401, `wrong code ${i + 1}: ${r.body}`);
    assert.equal(r.json().error, 'totp_invalid');
    assert.deepEqual(await lockOf(id), { count: i + 1, locked: false }, `wrong code ${i + 1} was not counted`);
  }
  const fifth = await login('codes', PASSWORD, wrongCode(secret));
  assert.equal(fifth.statusCode, 423, `five wrong codes did not lock the account: ${fifth.body}`);
  assert.equal(fifth.json().error, 'locked');
  // Locked means locked: the right code is not even looked at.
  const right = await login('codes', PASSWORD, codeFor(secret, 1));
  assert.equal(right.statusCode, 401, right.body);
  // Once the lock runs out the right code signs in, and the count is cleared.
  await q(`UPDATE users SET locked_until = now() - interval '1 second' WHERE id = $1`, [id]);
  const after = await login('codes', PASSWORD, codeFor(secret, 1));
  assert.equal(after.statusCode, 200, after.body);
  assert.deepEqual(await lockOf(id), { count: 0, locked: false });
});

test('a session cannot guess the password', { skip }, async () => {
  const id = await account('session');
  // Reintroduce by checking the password alone in currentPasswordRefusal (routes/auth.ts): five 401s, and then the
  // right password is accepted -- a borrowed phone or a stolen refresh cookie guesses at full speed.
  const guesses: Array<[string, Record<string, string>]> = [
    ['/auth/password', { current: 'guess 1', next: 'a new password' }],
    ['/auth/totp/disable', { password: 'guess 2' }],
    ['/auth/totp/enable', { code: '123456', password: 'guess 3' }],
    ['/auth/password', { current: 'guess 4', next: 'a new password' }],
  ];
  for (const [i, [url, body]] of guesses.entries()) {
    const r = await post(id, url, body);
    assert.equal(r.statusCode, 401, `${url}: ${r.body}`);
    assert.equal(r.json().error, 'wrong_password');
    assert.deepEqual(await lockOf(id), { count: i + 1, locked: false }, `${url} did not count the wrong password`);
  }
  const fifth = await post(id, '/auth/totp/disable', { password: 'guess 5' });
  assert.equal(fifth.statusCode, 423, `five wrong passwords behind a session did not lock the account: ${fifth.body}`);
  assert.equal(fifth.json().error, 'locked');
  // While it lasts the right password is refused unread, here and at sign-in, and nothing changes.
  const right = await post(id, '/auth/password', { current: PASSWORD, next: 'a new password' });
  assert.equal(right.statusCode, 423, right.body);
  assert.equal((await login('session', PASSWORD)).statusCode, 401);
  assert.equal((await login('session', 'a new password')).statusCode, 401, 'the password changed while the account was locked');
  // Once it runs out the right password works, and clears the count as a sign-in does.
  await q(`UPDATE users SET locked_until = now() - interval '1 second' WHERE id = $1`, [id]);
  const ok = await post(id, '/auth/password', { current: PASSWORD, next: 'a new password' });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(await lockOf(id), { count: 0, locked: false });
});

test('the password checks behind a session carry sign-in\'s per-address limit', { skip }, async () => {
  const id = await account('limit');
  // Bodies the route refuses before any password is read, so the count and the lock stay out of it: only the limit can
  // turn the eleventh answer into a 429. Reintroduce by dropping `config: SIGN_IN_LIMIT` from a route: its eleventh
  // request in five minutes is answered 400 like the ten before it.
  for (const url of ['/auth/password', '/auth/totp/enable', '/auth/totp/disable', '/auth/login']) {
    for (let n = 1; n <= 10; n++) {
      const r = await post(id, url, { nothing: true }, limited);
      assert.equal(r.statusCode, 400, `${url} request ${n}: ${r.body}`);
    }
    const eleventh = await post(id, url, { nothing: true }, limited);
    assert.equal(eleventh.statusCode, 429, `${url} answered its eleventh request in five minutes: ${eleventh.statusCode}`);
  }
  assert.deepEqual(await lockOf(id), { count: 0, locked: false });
});

test('turning two-factor on asks for the password', { skip }, async () => {
  const id = await account('enable');
  const setup = await post(id, '/auth/totp/setup', {});
  assert.equal(setup.statusCode, 200, setup.body);
  const secret = setup.json().secret;
  const enabled = async () => (await one('SELECT totp_enabled FROM users WHERE id = $1', [id])).totp_enabled;

  // A session alone, with the code from the authenticator it just scanned, is not enough.
  const none = await post(id, '/auth/totp/enable', { code: codeFor(secret) });
  assert.equal(none.statusCode, 400, `two-factor went on with no password: ${none.body}`);
  assert.equal(await enabled(), false);
  // Reintroduce by dropping the password check from /auth/totp/enable: this is a 200, and the owner's next sign-in asks
  // for a code from an authenticator they have never seen.
  const wrong = await post(id, '/auth/totp/enable', { code: codeFor(secret), password: 'not the password' });
  assert.equal(wrong.statusCode, 401, `two-factor went on with a wrong password: ${wrong.body}`);
  assert.equal(wrong.json().error, 'wrong_password');
  assert.equal(await enabled(), false);
  assert.deepEqual(await lockOf(id), { count: 1, locked: false }, 'the wrong password was not counted');
  const ok = await post(id, '/auth/totp/enable', { code: codeFor(secret), password: PASSWORD });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(await enabled(), true);
  assert.equal(ok.json().recoveryCodes.length, 8);
  assert.deepEqual(await lockOf(id), { count: 0, locked: false }, 'the right password did not clear the count');
});
