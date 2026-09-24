// The desktop sign-in handshake cannot be had without the shell's secret, or from anywhere but this PC.
// (No database: every refusal happens before one is needed. desktopAuth.int.test.ts covers the success.)
//
// Uchiyomi Desktop has no sign-in screen. The shell starts the server with a fresh 256-bit secret on every
// launch and adds it, below the page, to exactly one request: `POST /auth/desktop`. Anything that can reach
// 127.0.0.1 -- another account on the PC, a web page doing DNS rebinding, a browser tab -- must get nothing.
// This file also covers what lib/desktop.ts does with the shell's environment when the switch is on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path, { join } from 'path';

const DATA = mkdtempSync(join(tmpdir(), 'uchi-desk-'));
const PORT = 43123;
const SECRET = 'f3'.repeat(32); // 64 characters, like the shell's hex secret
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HOST = `127.0.0.1:${PORT}`;

// The shell's environment (contract 1), set before anything imports lib/desktop.ts.
process.env.UCHIYOMI_DESKTOP = '1';
process.env.UCHIYOMI_DATA_DIR = DATA;
process.env.PORT = String(PORT);
process.env.DL_ROOT = join(DATA, 'Uchiyomi Library') + path.sep; // a trailing separator, to be normalised away
process.env.UCHIYOMI_DESKTOP_SECRET = SECRET;
process.env.UCHIYOMI_DESKTOP_USER = 'Jösé';
process.env.PUBLIC_ORIGIN = 'https://someone-elses.example'; // forced back to the loopback origin
process.env.OIDC_ISSUER = 'https://idp.example';
process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET = 'test-secret-at-least-16-chars';
delete process.env.CONFIG_DIR;
delete process.env.LIBRARY_ROOT;

async function app() {
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const { installDesktopGuards } = await import('../src/lib/desktopGuard');
  const authRoutes = (await import('../src/routes/auth')).default;
  const a = Fastify();
  // In server.ts's order: the guard before any route.
  installDesktopGuards(a);
  await a.register(cookie);
  await a.register(jwt, { secret: process.env.JWT_SECRET! });
  await a.register(authRoutes);
  await a.ready();
  return a;
}

const exchange = (a: any, o: { secret?: string; host?: string; origin?: string; remoteAddress?: string } = {}) =>
  a.inject({
    method: 'POST',
    url: '/auth/desktop',
    remoteAddress: o.remoteAddress ?? '127.0.0.1',
    headers: {
      host: o.host ?? HOST,
      ...(o.origin !== undefined ? { origin: o.origin } : {}),
      ...(o.secret !== undefined ? { 'x-uchiyomi-desktop': o.secret } : {}),
    },
  });

test('the secret leaves process.env as soon as the switch is read', async () => {
  const d = await import('../src/lib/desktop');
  assert.equal(d.isDesktop(), true);
  // ⚠️ Children inherit the environment: pg_dump for the nightly backup would carry the secret, and on macOS
  // `ps -E` shows another process's environment to the same user.
  // Reintroduce by deleting the `delete process.env.UCHIYOMI_DESKTOP_SECRET` line in lib/desktop.ts.
  assert.equal(process.env.UCHIYOMI_DESKTOP_SECRET, undefined, 'the secret is still in process.env');
  assert.equal(d.desktopSecretMatches(SECRET), true, 'the module lost the secret it took out of the environment');
});

test('no secret, a wrong one, or one that is merely close: 401', async () => {
  const a = await app();
  try {
    // Reintroduce by answering 200 when desktopSecretMatches is false (or dropping the check): all three pass.
    assert.equal((await exchange(a)).statusCode, 401, 'no header');
    assert.equal((await exchange(a, { secret: 'wrong' })).statusCode, 401, 'a wrong secret');
    assert.equal((await exchange(a, { secret: SECRET.slice(0, -1) })).statusCode, 401, 'the secret minus its last character');
    assert.equal((await exchange(a, { secret: SECRET + 'x' })).statusCode, 401, 'the secret plus a character');
    assert.equal((await exchange(a, { secret: SECRET.toUpperCase() })).statusCode, 401, 'the secret in another case');
    const r = await exchange(a, { secret: 'wrong' });
    assert.deepEqual(r.json(), { error: 'unauthorized' });
    assert.equal(r.headers['set-cookie'], undefined, 'a refusal set a cookie');
  } finally { await a.close(); }
});

test('from another machine: 404, as if there were no such route', async () => {
  const a = await app();
  try {
    // With the RIGHT secret -- the address check is first, so a future LAN mode cannot expose the handshake.
    // Reintroduce by dropping the isLoopback check: this answers 500 (it goes on to the database) or 200.
    const r = await exchange(a, { secret: SECRET, remoteAddress: '192.168.1.5' });
    assert.equal(r.statusCode, 404);
    assert.deepEqual(r.json(), { error: 'not_found' });
    assert.equal((await exchange(a, { secret: SECRET, remoteAddress: '::ffff:10.0.0.7' })).statusCode, 404);
  } finally { await a.close(); }
});

test('a foreign Host (DNS rebinding): 421, before anything else runs', async () => {
  const a = await app();
  try {
    // A page on evil.test that re-points its own name at 127.0.0.1 sends `Host: evil.test:<port>`.
    // Reintroduce by dropping the Host check in lib/desktopGuard.ts: this answers 401 (it reaches the secret).
    const r = await exchange(a, { secret: SECRET, host: `evil.test:${PORT}` });
    assert.equal(r.statusCode, 421);
    // Our own names on the wrong port are not ours either, and neither is a missing port.
    assert.equal((await exchange(a, { secret: SECRET, host: '127.0.0.1:1' })).statusCode, 421);
    assert.equal((await exchange(a, { secret: SECRET, host: '127.0.0.1' })).statusCode, 421);
    // localhost on our port is, case-insensitively (the check still goes on to the secret).
    assert.equal((await exchange(a, { secret: 'wrong', host: `LOCALHOST:${PORT}` })).statusCode, 401);
  } finally { await a.close(); }
});

test('a foreign Origin: 403, even with the right secret', async () => {
  const a = await app();
  try {
    // Reintroduce by dropping the Origin check: a page elsewhere that somehow held the header would be let in.
    assert.equal((await exchange(a, { secret: SECRET, origin: 'https://evil.test' })).statusCode, 403);
    assert.equal((await exchange(a, { secret: SECRET, origin: 'null' })).statusCode, 403, 'an opaque origin');
    assert.equal((await exchange(a, { secret: SECRET, origin: `http://localhost:${PORT}` })).statusCode, 403,
      'only the one origin the window loads is the app');
    // The app's own origin passes on to the secret check.
    assert.equal((await exchange(a, { secret: 'wrong', origin: ORIGIN })).statusCode, 401);
  } finally { await a.close(); }
});

test('the comparison is by digest, in constant time', async () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'lib', 'desktop.ts'), 'utf8');
  const fn = src.slice(src.indexOf('export function desktopSecretMatches'), src.indexOf('export const desktopPort'));
  // Reintroduce by comparing with `===`: the time to the first differing byte leaks the secret a byte at a time.
  assert.match(fn, /timingSafeEqual\(sha\(header\), secretDigest\)/, 'desktopSecretMatches does not use timingSafeEqual on digests');
  assert.doesNotMatch(fn, /===\s*secret|secret\s*===/);
  const { desktopSecretMatches } = await import('../src/lib/desktop');
  for (const bad of [undefined, null, '', ['a', 'b'], 42, [SECRET]]) assert.equal(desktopSecretMatches(bad), false, `${JSON.stringify(bad)}`);
});

test('wrong secrets are audited once a minute at most, counting every attempt', async () => {
  // ⚠️ No rate limit on the handshake, so a row per refusal grew audit_log without bound (3,744 rows in 5 s).
  // desktopAuth.int.test.ts floods the real route; this pins the arithmetic. The earlier tests' refusals share
  // this module's state, so start far past them.
  const { desktopFailAudit, DESKTOP_FAIL_AUDIT_MS: M } = await import('../src/lib/desktop');
  const t0 = 1e12;
  assert.notEqual(desktopFailAudit(t0), null, 'the first refusal after a quiet minute is written at once');
  // Reintroduce by returning 1 whenever desktopFailAudit is called (no coalescing): these are not null.
  assert.equal(desktopFailAudit(t0 + 1), null);
  assert.equal(desktopFailAudit(t0 + M - 1), null);
  // Reintroduce by resetting `attempts` to 1 instead of `swallowed + 1`: this says 1 and the guessing is hidden.
  assert.equal(desktopFailAudit(t0 + M), 3, 'the next row stands for the two swallowed attempts and itself');
  assert.equal(desktopFailAudit(t0 + M + 1), null, 'the minute restarts from the row just written');
  // A clock that went backwards must not silence the log until it catches up.
  // Reintroduce by dropping `since >= 0 &&` in desktopFailAudit: this is null.
  assert.equal(desktopFailAudit(t0), 2);
});

test('the shell environment becomes the desktop defaults', async () => {
  await import('../src/lib/desktop');
  const lib = join(DATA, 'library');
  // Derived from the data dir, because every bff default is a POSIX path (`/config` is `C:\config` on Windows).
  assert.equal(process.env.CONFIG_DIR, join(DATA, 'config'));
  assert.equal(process.env.CACHE_DIR, join(DATA, 'cache'));
  assert.equal(process.env.BACKUP_DIR, join(DATA, 'backups'));
  assert.equal(process.env.SOURCES_DIR, join(DATA, 'sources'));
  assert.equal(process.env.CUSTOM_SITES_FILE, join(DATA, 'config', 'sites.json'));
  assert.equal(process.env.LIBRARY_ROOT, lib);
  assert.equal(process.env.MIN_FREE_GB, '5');
  assert.equal(process.env.CACHE_MAX_BYTES, String(4 * 1024 ** 3));
  // Forced whatever the environment said.
  assert.equal(process.env.PUBLIC_ORIGIN, ORIGIN);
  assert.equal(process.env.LIBRARY_BACKEND, 'owned');
  assert.equal(process.env.OIDC_ISSUER, '');
  assert.equal(process.env.VAPID_PUBLIC_KEY, '');
  // The download root normalised (no trailing separator), and NOT created: it may be on a drive that is not
  // plugged in, and creating it would put an empty library on the system disk.
  // Reintroduce by pushing DL_ROOT into `mkdirs` in desktopPlan: the folder below exists.
  assert.equal(process.env.DL_ROOT, join(DATA, 'Uchiyomi Library'));
  assert.equal(existsSync(join(DATA, 'Uchiyomi Library')), false, 'DL_ROOT was created by the server');
  for (const d of ['config', 'cache', 'backups', 'sources', 'library']) assert.ok(existsSync(join(DATA, d)), `${d} was not created`);
  const { desktopHosts, desktopUserName } = await import('../src/lib/desktop');
  assert.deepEqual(desktopHosts(), [HOST, `localhost:${PORT}`]);
  assert.equal(desktopUserName(), 'Jösé');
  // env.ts on desktop: no push keys generated, and the forced values are what the server sees.
  const { env } = await import('../src/env');
  assert.equal(env.VAPID_PUBLIC_KEY, '');
  assert.equal(existsSync(join(DATA, 'config', 'vapid.json')), false, 'env.ts generated VAPID keys on desktop');
  assert.equal(env.PUBLIC_ORIGIN, ORIGIN);
  assert.equal(env.OIDC_ISSUER, '');
});

test('desktopPlan refuses a half-configured shell, and says everything that is wrong at once', async () => {
  const { desktopPlan } = await import('../src/lib/desktop');
  // Reintroduce by dropping a required variable's check: that variable's name disappears from the message.
  assert.throws(() => desktopPlan({}), (e: Error) =>
    ['UCHIYOMI_DATA_DIR', 'DL_ROOT', 'PORT', 'UCHIYOMI_DESKTOP_SECRET'].every((v) => e.message.includes(v)));
  const ok = { UCHIYOMI_DATA_DIR: '/d', DL_ROOT: '/lib', PORT: '4000', UCHIYOMI_DESKTOP_SECRET: 'x'.repeat(32) };
  assert.doesNotThrow(() => desktopPlan(ok));
  assert.throws(() => desktopPlan({ ...ok, UCHIYOMI_DESKTOP_SECRET: 'x'.repeat(31) }), /UCHIYOMI_DESKTOP_SECRET/);
  for (const port of ['0', '70000', '12.5', 'abc', '']) assert.throws(() => desktopPlan({ ...ok, PORT: port }), /PORT/, port);
  // The shell may still point any derived folder elsewhere.
  assert.equal(desktopPlan({ ...ok, CONFIG_DIR: '/elsewhere' }).set.CUSTOM_SITES_FILE, path.join('/elsewhere', 'sites.json'));
  assert.equal(desktopPlan({ ...ok, MIN_FREE_GB: '2' }).set.MIN_FREE_GB, '2');
  // A read library the shell chose is used as given and never created (it may be an unplugged drive).
  const withLib = desktopPlan({ ...ok, LIBRARY_ROOT: '/mnt/manga/' });
  assert.equal(withLib.set.LIBRARY_ROOT, '/mnt/manga');
  assert.ok(!withLib.mkdirs.includes('/mnt/manga') && !withLib.mkdirs.includes('/lib'));
});

test('overlapping library roots are refused (every file would be scanned twice)', async () => {
  const { desktopPlan } = await import('../src/lib/desktop');
  const ok = { UCHIYOMI_DATA_DIR: '/d', DL_ROOT: '/lib', PORT: '4000', UCHIYOMI_DESKTOP_SECRET: 'x'.repeat(32) };
  // Reintroduce by dropping the rootsOverlap check: all three boot.
  assert.throws(() => desktopPlan({ ...ok, LIBRARY_ROOT: '/lib' }), /inside one another/);
  assert.throws(() => desktopPlan({ ...ok, LIBRARY_ROOT: '/lib/manga' }), /inside one another/);
  assert.throws(() => desktopPlan({ ...ok, DL_ROOT: '/d' }), /inside one another/, 'DL_ROOT above the default read library');
  assert.doesNotThrow(() => desktopPlan({ ...ok, LIBRARY_ROOT: '/library' }), '/lib and /library are siblings, not nested');
});

test('Windows roots are stored one way: absolute, no trailing separator, drive letter upper-cased', async () => {
  const { desktopPlan, normRoot, rootsOverlap } = await import('../src/lib/desktop');
  const w = path.win32;
  // `lib_books.root` is compared as an exact string, so `c:\Lib\` and `C:\Lib` would be two libraries.
  // Reintroduce by dropping the upper-casing in normRoot: the first assertion sees `c:\...`.
  assert.equal(normRoot('c:\\Users\\A\\Uchiyomi Library\\', w), 'C:\\Users\\A\\Uchiyomi Library');
  assert.equal(normRoot('C:\\', w), 'C:\\', 'a drive root keeps its separator');
  assert.equal(normRoot('/', path.posix), '/');
  const plan = desktopPlan({
    UCHIYOMI_DATA_DIR: 'C:\\Users\\A\\AppData\\Local\\Uchiyomi', DL_ROOT: 'd:\\Manga\\', PORT: '4000',
    UCHIYOMI_DESKTOP_SECRET: 'x'.repeat(32),
  }, w);
  assert.equal(plan.set.DL_ROOT, 'D:\\Manga');
  assert.equal(plan.set.LIBRARY_ROOT, 'C:\\Users\\A\\AppData\\Local\\Uchiyomi\\library');
  assert.equal(plan.set.CONFIG_DIR, 'C:\\Users\\A\\AppData\\Local\\Uchiyomi\\config');
  // NTFS is case-insensitive: these are the same folder.
  assert.equal(rootsOverlap('C:\\Manga', 'c:\\manga\\Read', w), true);
  assert.equal(rootsOverlap('C:\\Manga', 'D:\\Manga', w), false);
});

test('isLoopback: 127/8 and ::1, IPv6-mapped or not; nothing else', async () => {
  const { isLoopback } = await import('../src/lib/desktop');
  for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopback(a), true, a);
  for (const a of [undefined, '', '192.168.1.5', '10.0.0.1', '::ffff:192.168.1.5', '0.0.0.0', 'fe80::1', '127.0.0.1.evil', '1127.0.0.1'])
    assert.equal(isLoopback(a), false, String(a));
});

test('on desktop the forwarded-for header is ignored', async () => {
  const { clientIp } = await import('../src/lib/auth');
  // Reintroduce by reading x-forwarded-for unconditionally in clientIp: sessions and the audit log record '6.6.6.6'.
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '6.6.6.6' }, ip: '127.0.0.1' } as any), '127.0.0.1');
});

test('on desktop API and OPDS tokens open nothing', async () => {
  const { resolveApiToken, resolveApiTokenById, resolveOpdsBasic } = await import('../src/lib/auth');
  // No database behind this test: a resolver that queried would throw (ECONNREFUSED) rather than answer null.
  // Reintroduce by removing the `if (isDesktop()) return null;` from resolveApiToken: this rejects.
  assert.equal(await resolveApiToken('uy_' + 'a'.repeat(40)), null);
  assert.equal(await resolveApiTokenById('00000000-0000-0000-0000-000000000000'), null);
  assert.equal(await resolveOpdsBasic('Basic ' + Buffer.from('me:token').toString('base64')), null);
});
