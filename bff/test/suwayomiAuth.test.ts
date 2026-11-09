// Real HTTP and WebSocket contracts. No engine credentials, database or running user engine are used.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { EngineAuth, EngineAuthError, EngineLoginError } from '../src/lib/sources/suwayomi/auth';
import { AUTH_OPS } from '../src/lib/sources/suwayomi/operations';

let server: Server;
let base: string;
const records: Array<{ path: string; auth?: string; cookie?: string; body: string }> = [];
let loginCount = 0, refreshCount = 0, apiCount = 0, mutationCount = 0;
let loginDelay = 0, refreshStatus = 200, loginStatus = 200, refused = 0, refusalStatus = 401;
let loginRedirect = '/engine/', pageRedirect = '', refreshInvalid = false;
let token = '', session = 'rotated';
let socketAuth: string | undefined, socketPath = '';
let legacyForm = false;
let tokenOverride = '', sessionOverride = '', expiredLogin = false;
let rejectedBearer = '';
let partialAuthFailure = false;
const jwt = (exp = Date.now() + 300_000) => `header.${Buffer.from(JSON.stringify({ exp: Math.floor(exp / 1000) })).toString('base64url')}.token-${loginCount}-${refreshCount}`;
const configured = (mode: 'auto' | 'none' | 'basic' | 'simple' | 'ui_login', username = 'engine-user') =>
  new EngineAuth({ base, mode, username, password: 'engine-pass' });

before(async () => {
  server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const path = req.url!;
    records.push({ path, auth: req.headers.authorization, cookie: req.headers.cookie, body });
    const json = (data: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (path === '/engine/login.html') {
      if (req.method === 'GET') {
        if (legacyForm) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<input type="text" name="user"/>'); return; }
        res.writeHead(200, { 'set-cookie': 'JSESSIONID=initial; Path=/engine; HttpOnly; SameSite=Strict', 'content-type': 'text/html' });
        res.end('<input type="hidden" name="csrf-token" value="csrf-123"/>'); return;
      }
      loginCount++;
      const fields = new URLSearchParams(body);
      assert.equal(req.headers.cookie, legacyForm ? undefined : 'JSESSIONID=initial');
      assert.equal(fields.get('user'), 'engine-user'); assert.equal(fields.get('pass'), 'engine-pass'); assert.equal(fields.get('csrf-token'), legacyForm ? null : 'csrf-123');
      res.writeHead(loginStatus === 200 ? 303 : loginStatus, { location: loginRedirect, 'set-cookie': `JSESSIONID=${sessionOverride || session}; Path=/engine; HttpOnly` });
      res.end(); return;
    }
    if (path === '/engine/api/graphql') {
      const data = JSON.parse(body);
      if (data.query === AUTH_OPS.login.doc) {
        loginCount++;
        assert.equal(req.headers.authorization, undefined); assert.equal(req.headers.cookie, undefined);
        assert.deepEqual(data.variables.input, { username: 'engine-user', password: 'engine-pass' });
        if (loginDelay) await new Promise((r) => setTimeout(r, loginDelay));
        if (loginStatus !== 200) { json({ error: 'private token should never appear in errors' }, loginStatus); return; }
        token = tokenOverride || jwt(expiredLogin ? Date.now() - 1000 : undefined); json({ data: { login: { accessToken: token, refreshToken: 'secret-refresh' } } }); return;
      }
      if (data.query === AUTH_OPS.refreshToken.doc) {
        refreshCount++;
        assert.equal(req.headers.authorization, undefined); assert.deepEqual(data.variables.input, { refreshToken: 'secret-refresh' });
        if (refreshStatus !== 200) { json({}, refreshStatus); return; }
        if (refreshInvalid) { json({ errors: [{ message: 'Token revoked by a password change' }], data: { refreshToken: null } }); return; }
        token = jwt(); json({ data: { refreshToken: { accessToken: token } } }); return;
      }
      apiCount++;
      if (refused-- > 0) {
        if (refusalStatus === 200) {
          if (partialAuthFailure) mutationCount++;
          json({ errors: [{ message: 'Exception while fetching data (/aboutServer) : Unauthorized' }], data: { aboutServer: null, ...(partialAuthFailure ? { changed: true } : {}) } });
        }
        else json({}, refusalStatus);
        return;
      }
      if (req.headers.authorization !== `Bearer ${token}`) { json({}, 401); return; }
      if (data.query.startsWith('mutation')) mutationCount++;
      json({ data: { aboutServer: { name: 'Private fixture' }, changed: true } }); return;
    }
    apiCount++;
    if (pageRedirect) { res.writeHead(302, { location: pageRedirect }); res.end(); return; }
    if (rejectedBearer && req.headers.authorization === rejectedBearer) { res.writeHead(401); res.end(); return; }
    if (refused-- > 0) { res.writeHead(refusalStatus); res.end(); return; }
    if (req.headers.authorization !== `Bearer ${token}` && req.headers.cookie !== `JSESSIONID=${session}` && !req.headers.authorization?.startsWith('Basic ')) { res.writeHead(401); res.end(); return; }
    res.writeHead(200, { 'content-type': 'image/png' }); res.end(path.endsWith('/page/0') ? Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]) : 'private-image');
  });
  server.on('upgrade', (req, socket) => {
    socketAuth = req.headers.authorization; socketPath = req.url!;
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', (data) => { if ((data[0] & 15) === 8) { socket.write(Buffer.from([0x88, 0])); socket.end(); } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/engine`;
  process.env.SUWAYOMI_URL = base; process.env.SUWAYOMI_AUTH_MODE = 'ui_login';
  process.env.SUWAYOMI_USERNAME = 'engine-user'; process.env.SUWAYOMI_PASSWORD = 'engine-pass';
  process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars'; process.env.DATABASE_URL ||= 'postgres://unused/unused';
});
after(async () => { await new Promise<void>((r) => server.close(() => r())); });
beforeEach(() => {
  records.length = 0; loginCount = 0; refreshCount = 0; apiCount = 0; mutationCount = 0;
  loginDelay = 0; loginStatus = 200; refreshStatus = 200; refused = 0; refusalStatus = 401;
  loginRedirect = '/engine/'; pageRedirect = ''; refreshInvalid = false;
  legacyForm = false;
  tokenOverride = ''; sessionOverride = ''; expiredLogin = false;
  rejectedBearer = '';
  partialAuthFailure = false;
});

test('auto preserves legacy Basic or no-auth; explicit none ignores saved credentials', async () => {
  assert.deepEqual(await configured('auto').headers(), { authorization: `Basic ${Buffer.from('engine-user:engine-pass').toString('base64')}` });
  assert.deepEqual(await configured('auto', '').headers(), {});
  assert.deepEqual(await configured('none').headers(), {});
  assert.equal(records.length, 0);
});

test('Simple Login submits CSRF and rotated session cookie, reusing one login', async () => {
  const auth = configured('simple');
  assert.deepEqual(await auth.headers(), { cookie: 'JSESSIONID=rotated' });
  assert.equal((await auth.fetch(`${base}/api/v1/manga/1/thumbnail`)).status, 200);
  assert.equal(loginCount, 1);
  assert.ok(records.every((r) => !r.auth), 'no Basic or Bearer offered in simple mode');
});

test('supported v2.3/v2.4 Simple Login forms establish the session on POST without a CSRF field', async () => {
  legacyForm = true;
  const auth = configured('simple');
  assert.deepEqual(await auth.headers(), { cookie: 'JSESSIONID=rotated' });
  assert.equal((await auth.fetch(`${base}/api/v1/page`)).status, 200); assert.equal(loginCount, 1);
});

test('Simple Login refuses failed credentials and cross-origin login redirects without following them', async () => {
  loginStatus = 200; loginRedirect = 'https://attacker.invalid/';
  await assert.rejects(configured('simple').headers(), EngineLoginError);
  assert.equal(records.length, 2);
  loginStatus = 200; loginRedirect = '/engine/login.html';
  // A login page rendered again is HTTP 200, rather than the documented 303 success.
  loginStatus = 400;
  await assert.rejects(configured('simple').headers(), EngineLoginError);
});

test('Simple Login renews the session after an explicit HTTP401 only once', async () => {
  const auth = configured('simple'); await auth.headers(); refused = 1;
  assert.equal((await auth.fetch(`${base}/api/v1/page`)).status, 200); assert.equal(loginCount, 2); assert.equal(apiCount, 2);
});

test('concurrent UI logins and expiry refreshes are coalesced', async () => {
  const auth = configured('ui_login'); loginDelay = 20;
  const headers = await Promise.all(Array.from({ length: 12 }, () => auth.headers()));
  assert.equal(loginCount, 1); assert.ok(headers.every((h) => h.authorization === `Bearer ${token}`));
  auth.invalidate(headers[0]);
  await Promise.all(Array.from({ length: 12 }, () => auth.headers()));
  assert.equal(refreshCount, 1); assert.equal(loginCount, 1);
});

test('concurrent rejected requests refresh one generation instead of logging in for every page', async () => {
  const auth = configured('ui_login'); rejectedBearer = (await auth.headers()).authorization;
  const results = await Promise.all(Array.from({ length: 12 }, () => auth.fetch(`${base}/api/v1/page`)));
  assert.ok(results.every((r) => r.status === 200), `statuses: ${results.map((r) => r.status)}`); assert.equal(loginCount, 1); assert.equal(refreshCount, 1); assert.equal(apiCount, 24);
});

test('JWT expiry renews before starting the next request, without first sending the expired token', async () => {
  const auth = configured('ui_login'); expiredLogin = true;
  await auth.headers(); expiredLogin = false;
  assert.equal((await auth.fetch(`${base}/api/v1/page`)).status, 200);
  assert.equal(refreshCount, 1); assert.equal(apiCount, 1);
});

test('one caller abort does not cancel another reader sharing login', async () => {
  const auth = configured('ui_login'); loginDelay = 45;
  const aborted = auth.headers(AbortSignal.timeout(10)); const remaining = auth.headers();
  await assert.rejects(aborted, { name: 'TimeoutError' }); assert.ok((await remaining).authorization); assert.equal(loginCount, 1);
});

test('invalid refresh relogs once, but unavailable refresh never retries credentials', async () => {
  const auth = configured('ui_login'); const headers = await auth.headers();
  auth.invalidate(headers); refreshInvalid = true;
  await auth.headers(); assert.equal(refreshCount, 1); assert.equal(loginCount, 2);
  auth.invalidate(await auth.headers()); refreshInvalid = false; refreshStatus = 503;
  await assert.rejects(auth.headers(), /suwayomi 503/); assert.equal(loginCount, 2);
});

test('GET401 refreshes once; 403, 503 and mutation refusal never replay', async () => {
  const auth = configured('ui_login'); await auth.headers(); refused = 1;
  assert.equal((await auth.fetch(`${base}/api/v1/page`)).status, 200); assert.equal(refreshCount, 1); assert.equal(apiCount, 2);
  for (const status of [403, 503]) { refused = 1; refusalStatus = status; const before = apiCount; assert.equal((await auth.fetch(`${base}/api/v1/page`)).status, status); assert.equal(apiCount, before + 1); }
  refused = 1; refusalStatus = 401; const before = apiCount;
  assert.equal((await auth.fetch(`${base}/api/v1/page`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal(apiCount, before + 1); assert.equal(refreshCount, 1);
});

test('a repeated GET401 stops after two requests', async () => {
  const auth = configured('ui_login'); refused = 5;
  assert.equal((await auth.fetch(`${base}/api/v1/page`)).status, 401); assert.equal(apiCount, 2); assert.equal(refreshCount, 1);
  await auth.headers(); assert.equal(refreshCount, 2, 'the second refused generation is also invalidated');
});

test('engine redirects stay unfollowed, and other origins cannot trigger login or receive credentials', async () => {
  const auth = configured('ui_login');
  await assert.rejects(auth.fetch('https://attacker.invalid/private'), /refusing credentials/); assert.equal(loginCount, 0);
  pageRedirect = 'https://attacker.invalid/private';
  assert.equal((await auth.fetch(`${base}/api/v1/page`)).status, 302);
  assert.equal(records.length, 2); assert.ok(records.every((r) => r.path.startsWith('/engine/')));
});

test('login refusal hides upstream bodies and passwords', async () => {
  loginStatus = 401;
  await assert.rejects(configured('ui_login').headers(), (e: Error) => e instanceof EngineLoginError && !/engine-pass|secret|private token/.test(e.message));
  assert.equal(loginCount, 1);
});

test('malformed upstream token and session values fail before HTTP header construction can quote them', async () => {
  tokenOverride = 'upstream-private-token\u0000';
  await assert.rejects(configured('ui_login').headers(), (e: Error) => e instanceof EngineAuthError && !/upstream-private-token/.test(e.message));
  tokenOverride = ''; sessionOverride = 'upstream-private-session\tbroken';
  await assert.rejects(configured('simple').headers(), (e: Error) => e instanceof EngineAuthError && !/upstream-private-session/.test(e.message));
});

test('real client renews HTTP200 RequireAuth query refusal and never resubmits mutation fields', async () => {
  const { gql } = await import('../src/lib/sources/suwayomi/client');
  await gql('{aboutServer{name}}'); refused = 1; refusalStatus = 200;
  const before = apiCount; assert.ok((await gql<any>('{aboutServer{name}}')).aboutServer); assert.equal(apiCount, before + 2);
  refused = 1;
  await assert.rejects(gql('mutation{updateExtension(input:{id:1}){clientMutationId}}'), /suwayomi 401/);
  assert.equal(mutationCount, 0); assert.equal(apiCount, before + 3);
});

test('an engine authentication failure cannot trigger the adapter website retry, even with partial mutation data', async () => {
  const { makeSuwayomiAdapter } = await import('../src/lib/sources/suwayomi/sources');
  const site = await import('../src/lib/sources/suwayomi/siteSessions');
  site.setSitesOpened(['42']); let visits = 0;
  site.setBrowserOpener((async () => { visits++; throw new Error('not a website failure'); }) as never);
  refused = 1; refusalStatus = 200; partialAuthFailure = true;
  try {
    const source = makeSuwayomiAdapter({ id: '42', name: 'Private fixture', lang: 'en', homeUrl: 'https://example.invalid/' } as any);
    await assert.rejects(source.popular!(1), (e: any) => e instanceof EngineAuthError && e.status === 401);
    assert.equal(mutationCount, 1); assert.equal(apiCount, 1); assert.equal(visits, 0);
  } finally { site.setSitesOpened([]); site.setBrowserOpener(); }
});

test('the cover proxy and engine image fetches share UI session; WebView sends Bearer in its header', async () => {
  const { fetchCoverImage } = await import('../src/routes/images');
  const { suwayomiFetch } = await import('../src/lib/sources/suwayomi/client');
  assert.equal((await fetchCoverImage(`${base}/api/v1/manga/1/thumbnail`)).toString(), 'private-image');
  assert.equal((await suwayomiFetch(`${base}/api/v1/extension/icon/pkg`)).status, 200);
  assert.equal((await suwayomiFetch(`${base}/api/v1/source/1/icon`)).status, 200);
  const { openEngineBrowser, engineBrowserUrl } = await import('../src/lib/sources/suwayomi/engineBrowser');
  assert.equal(new URL(engineBrowserUrl()).pathname, '/engine/api/v1/webview');
  // The cached token/session can be revoked (or the engine restarted) before its local expiry.
  rejectedBearer = `Bearer ${token}`;
  const beforeRefresh = refreshCount;
  const browser = await openEngineBrowser({}); assert.equal(browser.open, true);
  assert.equal(refreshCount, beforeRefresh + 1);
  assert.equal(records.filter((r) => r.path === '/engine/api/v1/settings/about').length, 2);
  assert.equal(socketAuth, `Bearer ${token}`); assert.equal(socketPath, '/engine/api/v1/webview'); await browser.close();
});

test('the real downloader uses UI credentials and refuses an engine redirect into the private network', async () => {
  const { fetchPages } = await import('../src/lib/downloader');
  const { makeSuwayomiAdapter } = await import('../src/lib/sources/suwayomi/sources');
  const source = makeSuwayomiAdapter({ id: '42', name: 'Private fixture', lang: 'en' } as any);
  assert.deepEqual(await (source.imageHeaders as (url: string) => any)('https://attacker.invalid/cover'), {});
  const opts = { chapterSourceId: 'c1', gap: 0, workers: 1 };
  const result = await fetchPages(source, [`${base}/api/v1/manga/1/chapter/1/page/0`], [0], opts);
  assert.ok(result.page[0]); assert.equal(records.at(-1)?.auth, `Bearer ${token}`);
  const before = records.length; pageRedirect = `${new URL(base).origin}/private`;
  const blocked = await fetchPages(source, [`${base}/api/v1/manga/1/chapter/1/page/0`], [0], opts);
  assert.equal(blocked.page[0], null); assert.equal(records.length, before + 1);
  assert.ok(!records.some((r) => r.path === '/private'));
});
