// On desktop, the hidden routes answer 404 and the route table is the server's minus OPDS and the Komga API,
// plus the sign-in handshake -- nothing else moves.
//
// Builds the app the way openapiCoverage.test.ts does (the real route plugins, in server.ts's order), with the
// desktop switch ON and the guard installed where server.ts installs it. desktopSwitchHygiene.test.ts pins that
// server.ts really does skip exactly those two plugins and install exactly this guard.
//
// No database for the table and the 404s: the guard answers before any handler runs. The one check that needs
// a handler to run (`/api/push/key`) is skipped unless TEST_DATABASE_URL is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

const DSN = process.env.TEST_DATABASE_URL;
const DATA = mkdtempSync(join(tmpdir(), 'uchi-desk-routes-'));
const WEB = join(DATA, 'web');
mkdirSync(WEB);
writeFileSync(join(WEB, 'index.html'), '<!doctype html><title>Uchiyomi</title>');
const PORT = 43125;
const HOST = `127.0.0.1:${PORT}`;
process.env.UCHIYOMI_DESKTOP = '1';
process.env.UCHIYOMI_DATA_DIR = DATA;
process.env.PORT = String(PORT);
process.env.DL_ROOT = join(DATA, 'dl');
process.env.UCHIYOMI_DESKTOP_SECRET = 'd'.repeat(64);
process.env.WEB_ROOT = WEB;
process.env.DATABASE_URL = DSN || 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
delete process.env.CONFIG_DIR;

const REPO = join(__dirname, '..', '..');
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const key = (m: string, p: string) => `${m.toUpperCase()} ${p}`;
const toOpenApi = (p: string) => p.replace(/:([A-Za-z]+)/g, '{$1}');
const ROUTES = ['auth', 'admin', 'notify', 'catalog', 'images', 'personal', 'downloads', 'sources', 'opds', 'komgaCompat'];

/**
 * The OFF table: openapi.yaml's operations plus the two inline routes. openapiCoverage.test.ts proves this IS
 * the route table the server registers with the switch off, in both directions, so it stands in for building
 * the off app here (the switch is decided once per process).
 */
function offTable(): Set<string> {
  const spec = parseYaml(readFileSync(join(REPO, 'bff', 'openapi.yaml'), 'utf8'));
  const ops = new Set<string>(['GET /livez', 'GET /healthz']);
  for (const [p, item] of Object.entries<any>(spec.paths)) {
    for (const m of Object.keys(item)) if (METHODS.has(m.toUpperCase())) ops.add(key(m, p));
  }
  return ops;
}

/** The routes one set of plugins registers, as `METHOD /path` in OpenAPI form. */
function collector(app: any): Set<string> {
  const seen = new Set<string>();
  app.addHook('onRoute', (r: any) => {
    for (const m of Array.isArray(r.method) ? r.method : [r.method]) if (m !== 'HEAD') seen.add(key(m, toOpenApi(r.url)));
  });
  return seen;
}

/** The desktop app, as server.ts builds it with the switch on. */
async function desktopApp() {
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const { isDesktop } = await import('../src/lib/desktop');
  const { installDesktopGuards } = await import('../src/lib/desktopGuard');
  const { registerWebRoot } = await import('../src/lib/webRoot');
  assert.equal(isDesktop(), true);
  const app = Fastify();
  const seen = collector(app);
  await app.register(cookie);
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  if (isDesktop()) installDesktopGuards(app);
  app.get('/livez', async () => ({ ok: true }));
  app.get('/healthz', async () => ({ ok: true }));
  for (const mod of ROUTES) {
    if (isDesktop() && (mod === 'opds' || mod === 'komgaCompat')) continue; // server.ts: `if (!isDesktop())`
    await app.register((await import(`../src/routes/${mod}`)).default);
  }
  const table = new Set(seen); // before the web root, whose per-file static routes are not API
  await registerWebRoot(app);
  await app.ready();
  return { app, table };
}

/** What the OPDS and Komga-compatible plugins register (they are not switch-dependent themselves). */
async function sharingRoutes(): Promise<Set<string>> {
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const app = Fastify();
  const seen = collector(app);
  await app.register(cookie);
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  for (const mod of ['opds', 'komgaCompat']) await app.register((await import(`../src/routes/${mod}`)).default);
  await app.ready();
  await app.close();
  return seen;
}

const sorted = (s: Iterable<string>) => [...s].sort();
const UUID = '00000000-0000-4000-8000-000000000000';

test('every hidden route is a real route of the server build', async () => {
  const { DESKTOP_HIDDEN_ROUTES } = await import('../src/lib/desktop');
  const off = offTable();
  // Reintroduce by renaming a hidden route (or misspelling an entry): it silently stops being hidden on
  // desktop, and this names it.
  const missing = DESKTOP_HIDDEN_ROUTES.filter((r) => { const [m, p] = r.split(' '); return !off.has(key(m, toOpenApi(p))); });
  assert.deepEqual(missing, [], 'DESKTOP_HIDDEN_ROUTES entries that are not routes of the server');
  assert.equal(new Set(DESKTOP_HIDDEN_ROUTES).size, DESKTOP_HIDDEN_ROUTES.length, 'a hidden route is listed twice');
});

test('the desktop route table = the server table - OPDS - Komga API + POST /auth/desktop', async () => {
  const { app, table } = await desktopApp();
  await app.close();
  const off = offTable();
  const sharing = await sharingRoutes();
  assert.ok(sharing.size >= 20, `only ${sharing.size} OPDS/Komga routes found -- did a plugin fail to load?`);
  const expected = new Set([...off].filter((r) => !sharing.has(r)));
  expected.add('POST /auth/desktop');
  // Reintroduce by registering a route only when isDesktop() anywhere else, or by skipping another plugin on
  // desktop: the diff names it.
  assert.deepEqual(sorted([...table].filter((r) => !expected.has(r))), [], 'routes only the desktop app has');
  assert.deepEqual(sorted([...expected].filter((r) => !table.has(r))), [], 'server routes the desktop app lost');
  // And the sharing routes really are OPDS and the Komga API, nothing else of the server's.
  assert.deepEqual(sorted([...sharing].filter((r) => !/^\w+ \/(opds|api\/v[12])\b/.test(r))), []);
});

test('every hidden route answers 404 JSON on desktop, even to a valid admin', async () => {
  const { DESKTOP_HIDDEN_ROUTES } = await import('../src/lib/desktop');
  const { app } = await desktopApp();
  try {
    const token = app.jwt.sign({ sub: UUID, role: 'admin' });
    const bad: string[] = [];
    for (const r of DESKTOP_HIDDEN_ROUTES) {
      const [method, url] = r.split(' ');
      for (const m of method === 'GET' ? ['GET', 'HEAD'] : [method]) {
        const res = await app.inject({
          method: m as any, url: url.replace(':id', UUID),
          headers: { host: HOST, authorization: `Bearer ${token}` },
          ...(m === 'GET' || m === 'HEAD' ? {} : { payload: {} }),
        });
        // Reintroduce by emptying the Set in desktopGuard.ts (or dropping the hook): these answer 200/400/500.
        if (res.statusCode !== 404 || (m !== 'HEAD' && res.json().error !== 'not_found')) bad.push(`${m} ${url} -> ${res.statusCode} ${res.body.slice(0, 80)}`);
      }
    }
    assert.deepEqual(bad, [], 'hidden routes that still answered');
    // Before authentication: no token at all is the same 404, not 401.
    assert.equal((await app.inject({ method: 'GET', url: '/auth/sessions', headers: { host: HOST } })).statusCode, 404);
  } finally { await app.close(); }
});

test('OPDS and the Komga-compatible API do not exist on desktop', async () => {
  const { app } = await desktopApp();
  try {
    for (const url of ['/opds', '/opds/v1.2/catalog', '/api/v1/libraries', '/api/v2/users/me']) {
      const res = await app.inject({ method: 'GET', url, headers: { host: HOST } });
      assert.equal(res.statusCode, 404, url);
      assert.deepEqual(res.json(), { error: 'not_found' }, `${url} fell through to the app shell`);
    }
  } finally { await app.close(); }
});

test('what stays: sign-out, the members LIST, the web app -- and a foreign Host gets none of it', async () => {
  const { app } = await desktopApp();
  try {
    // Kept routes are not caught by the guard (whatever they then answer without a database).
    const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers: { host: HOST } });
    assert.equal(logout.statusCode, 200);
    const users = await app.inject({ method: 'GET', url: '/api/admin/users', headers: { host: HOST } });
    assert.equal(users.statusCode, 401, 'GET /api/admin/users must stay (the Library tab reads it): it should reach auth');
    const page = await app.inject({ method: 'GET', url: '/library', headers: { host: HOST } });
    assert.equal(page.statusCode, 200);
    // DNS rebinding: the same requests under someone else's name.
    for (const [method, url] of [['POST', '/auth/logout'], ['GET', '/library'], ['GET', '/livez'], ['GET', '/index.html']]) {
      const res = await app.inject({ method: method as any, url, headers: { host: `rebind.evil.test:${PORT}` } });
      assert.equal(res.statusCode, 421, `${method} ${url} answered a foreign Host`);
    }
  } finally { await app.close(); }
});

test('web push is off on desktop: no keys, and /api/push/key says so', async () => {
  const { pushEnabled, vapidPublicKey } = await import('../src/lib/push');
  // Reintroduce by generating the keys on desktop too (env.ts `const vapid = ensureVapidKeys()`).
  assert.equal(pushEnabled(), false);
  assert.equal(vapidPublicKey(), '');
});

test('/api/push/key over HTTP reports disabled', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  await migrate();
  // Its own account, removed afterwards: CI shares one database across every integration test.
  await q("DELETE FROM users WHERE username = 'dr-push'");
  const [{ id: uid }] = await q<{ id: string }>(
    "INSERT INTO users (display_name, username, role, password_hash, auth_kind) VALUES ('dr', 'dr-push', 'admin', 'x', 'desktop') RETURNING id");
  const { app } = await desktopApp();
  try {
    const res = await app.inject({ method: 'GET', url: '/api/push/key', headers: { host: HOST, authorization: `Bearer ${app.jwt.sign({ sub: uid, role: 'admin' })}` } });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { enabled: false, key: '' });
  } finally {
    await app.close();
    await q("DELETE FROM users WHERE username = 'dr-push'");
  }
});
