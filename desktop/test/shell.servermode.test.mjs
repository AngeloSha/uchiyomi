// Server mode (v0.45.0): the desktop app as a plain window onto the person's own Uchiyomi server. What must hold:
// no desktop bridge and no secret for a server page (even one on this PC at http://127.0.0.1:8080), a typed
// address becomes an origin that is proven to be an Uchiyomi SERVER, self-signed certificates only ever by an
// explicit pin, never silently re-pinned, and nothing standalone runs or is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8');
const electronPath = require.resolve('electron');
const preloadPath = require.resolve('../src/preload.js');
const {
  normaliseOrigin, checkConfig, probeServer, certDecision, pinUpdate, fingerprintOf, certSummary, pinsOf, pickStartup,
  appOriginFor, navDecision, forgetServerState, relaunchArgs, isCertErrorCode, isCertErrorName,
} = require('../src/servermode.js');
const { installBridge } = require('../src/bridge.js');
const { installOnQuit } = require('../src/updates.js');

/** preload.js as it runs in a window started in `mode` at `url` (shell.bridge.test.mjs has the same rig). */
function loadPreload(url, mode) {
  const exposed = {};
  const ipcRenderer = { invoke: async () => null, send() {}, on() {}, removeListener() {} };
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } }, ipcRenderer } };
  delete require.cache[preloadPath];
  const argv = process.argv;
  globalThis.location = new URL(url);
  process.argv = [...argv, '--uchiyomi-version=0.45.0', '--uchiyomi-lang=en', ...(mode ? [`--uchiyomi-mode=${mode}`] : [])];
  try {
    require(preloadPath);
  } finally {
    process.argv = argv;
    delete globalThis.location;
    delete require.cache[electronPath];
  }
  return exposed;
}

// ---------------------------------------------------------------- the window's surface
test('server mode: no desktop bridge -- not even for a server on this PC at http://127.0.0.1:8080 -- only an inert marker', () => {
  // Reintroduce by dropping `mode === 'standalone' &&` from preload.js's onApp: the local server's page gets
  // window.uchiyomiDesktop, its web app waits for a desktop sign-in that never comes, and nobody can sign in.
  for (const u of ['http://127.0.0.1:8080/', 'http://127.0.0.1:8080/library', 'https://manga.example.com/', 'http://192.168.1.10:8080/']) {
    const x = loadPreload(u, 'server');
    assert.deepEqual(Object.keys(x), ['uchiyomiShell'], u);
    assert.deepEqual(x.uchiyomiShell, { mode: 'server', version: '0.45.0' }, `${u}: data only, no functions`);
  }
  // The shell's own pages keep their surface in server mode (the error / certificate page is one of them).
  assert.equal(typeof loadPreload('file:///app/resources/app.asar/src/welcome.html', 'server').uchiyomiShell.welcome.trust, 'function');
});

test('the bridge needs the standalone mode argument: none, or the first-launch window, gets nothing on http', () => {
  // Reintroduce by treating a missing --uchiyomi-mode as standalone: a window started without it (a future
  // code path, a regression) hands 127.0.0.1 pages the bridge again.
  assert.deepEqual(loadPreload('http://127.0.0.1:41234/', null), {});
  assert.deepEqual(loadPreload('http://127.0.0.1:41234/', 'choose'), {});
  assert.deepEqual(Object.keys(loadPreload('http://127.0.0.1:41234/', 'standalone')), ['uchiyomiDesktop']);
});

test("appOrigin is never the person's server: every desktop:* call from its page is refused", async () => {
  // Reintroduce by returning `http://127.0.0.1:${uiPort}` whatever the mode in appOriginFor: the server page at
  // http://127.0.0.1:8080 could install the engine, restore a backup or install an update.
  assert.equal(appOriginFor({ mode: 'server', uiPort: 8080 }), 'http://127.0.0.1:0');
  assert.equal(appOriginFor({ mode: 'choose', uiPort: 8080 }), 'http://127.0.0.1:0');
  assert.equal(appOriginFor({ mode: 'standalone', uiPort: 0 }), 'http://127.0.0.1:0');
  assert.equal(appOriginFor({ mode: 'standalone', uiPort: 41234 }), 'http://127.0.0.1:41234');
  const handlers = new Map();
  const win = { webContents: { id: 1 }, isDestroyed: () => false };
  let installs = 0;
  let restores = 0;
  installBridge({
    ipcMain: { handle: (ch, f) => handlers.set(ch, f), on: (ch, f) => handlers.set(ch, f) },
    win: () => win, appOrigin: () => appOriginFor({ mode: 'server', uiPort: 8080 }), log: { info() {}, warn() {}, error() {} },
    engine: () => ({ install: async () => { installs++; }, status: () => ({}) }), updates: { status: () => ({}) }, installUpdate() {},
    revealLibrary() {}, revealBackups() {}, restoreBackup: async () => { restores++; }, strings: () => ({}), relaunch() {}, openLogs() {},
    firstRun: { defaults: () => ({}), choose: async () => null, confirm: () => ({}), back: () => ({}) },
    welcome: { info: () => ({}), connect: async () => ({}), trust: () => ({}), use: () => ({}), local: () => ({}), cancel: () => ({}), retry: () => ({}) },
  });
  const fromServer = { sender: win.webContents, senderFrame: { url: 'http://127.0.0.1:8080/admin', parent: null } };
  await assert.rejects(() => handlers.get('desktop:engine-install')(fromServer), /not allowed/);
  await assert.rejects(() => handlers.get('desktop:restore-backup')(fromServer), /not allowed/);
  await assert.rejects(() => handlers.get('desktop:update-status')(fromServer), /not allowed/);
  await assert.rejects(() => handlers.get('welcome:use')(fromServer), /not allowed/, 'nor the welcome page\'s calls');
  assert.equal(installs + restores, 0);
});

test('welcome:* answer only welcome.html; firstrun:back only firstrun.html; "replace" must be exactly true', async () => {
  // Reintroduce by gating welcome:trust on fromShellPage(e, win) without the page name: the folder page (or
  // loading.html) could pin a certificate.
  const handlers = new Map();
  const win = { webContents: { id: 1 }, isDestroyed: () => false };
  const dir = path.join(here, '..', 'src');
  const page = (n) => ({ sender: win.webContents, senderFrame: { url: pathToFileURL(path.join(dir, n)).href, parent: null } });
  const calls = [];
  installBridge({
    ipcMain: { handle: (ch, f) => handlers.set(ch, f), on: (ch, f) => handlers.set(ch, f) },
    win: () => win, appOrigin: () => 'http://127.0.0.1:0', log: { info() {}, warn() {}, error() {} },
    engine: () => null, updates: null, installUpdate() {}, revealLibrary() {}, revealBackups() {}, restoreBackup: async () => {},
    strings: () => ({}), relaunch() {}, openLogs() {},
    firstRun: { defaults: () => ({}), choose: async () => null, confirm: () => ({}), back: () => { calls.push('back'); return { ok: true }; } },
    welcome: {
      info: () => ({ step: 'choose' }), connect: async (a) => { calls.push(`connect:${a}`); return { ok: false }; },
      trust: (h, f, r) => { calls.push(`trust:${h}:${r}`); return { ok: true }; },
      use: () => ({ ok: true }), local: () => ({ ok: true }), cancel: () => ({ ok: true }), retry: () => ({ ok: true }),
    },
  });
  for (const ch of ['welcome:info', 'welcome:connect', 'welcome:trust', 'welcome:use', 'welcome:local', 'welcome:cancel', 'welcome:retry']) {
    await assert.rejects(async () => handlers.get(ch)(page('firstrun.html'), 'x', 'y', true), /not allowed/, ch);
    await assert.rejects(async () => handlers.get(ch)(page('loading.html'), 'x', 'y', true), /not allowed/, ch);
  }
  await assert.rejects(async () => handlers.get('firstrun:back')(page('welcome.html')), /not allowed/);
  await handlers.get('firstrun:back')(page('firstrun.html'));
  await handlers.get('welcome:connect')(page('welcome.html'), 'manga.example.com');
  await handlers.get('welcome:trust')(page('welcome.html'), 'manga.example.lan', 'AB', 'yes');
  await handlers.get('welcome:trust')(page('welcome.html'), 'manga.example.lan', 'AB', true);
  assert.deepEqual(calls, ['back', 'connect:manga.example.com', 'trust:manga.example.lan:false', 'trust:manga.example.lan:true']);
});

// ---------------------------------------------------------------- the address
test('what the person types becomes an http(s) origin: https added, path dropped (and reported), junk refused', () => {
  // Reintroduce by keeping the path in the origin (u.href): /auth/config is then asked at /manga/auth/config.
  const ok = (input, origin, extra = {}) => assert.deepEqual(normaliseOrigin(input), { ok: true, origin, host: new URL(origin).host, path: '', schemeAdded: false, ...extra }, input);
  ok('https://Manga.Example.com', 'https://manga.example.com');
  ok('  https://manga.example.com:443/  ', 'https://manga.example.com');
  ok('manga.example.com', 'https://manga.example.com', { schemeAdded: true });
  ok('192.168.1.10:8080', 'https://192.168.1.10:8080', { schemeAdded: true });
  ok('localhost:8080', 'https://localhost:8080', { schemeAdded: true });
  ok('http://192.168.1.10:8080', 'http://192.168.1.10:8080');
  ok('http://127.0.0.1:8080/library?x=1', 'http://127.0.0.1:8080', { path: '/library?x=1' });
  ok('https://example.org/uchiyomi/', 'https://example.org', { path: '/uchiyomi' });
  ok('HTTP://[::1]:8080', 'http://[::1]:8080');
  const bad = (input, error) => assert.deepEqual(normaliseOrigin(input), { ok: false, error }, String(input));
  bad('', 'empty');
  bad('   ', 'empty');
  bad(undefined, 'empty');
  bad('ftp://example.org', 'scheme');
  bad('file:///C:/Windows', 'scheme');
  bad('javascript:alert(1)', 'scheme');
  bad('data:text/html,hi', 'scheme');
  bad('http:manga.example.com', 'invalid');
  bad('https://', 'invalid');
  bad('manga example.com', 'invalid');
  bad('https://admin:hunter2@manga.example.com', 'credentials');
  bad('admin:hunter2@manga.example.com', 'credentials');
});

test('/auth/config decides: an Uchiyomi server is accepted, a desktop instance is refused, anything else is not Uchiyomi', () => {
  // Reintroduce by dropping the `desktop === true` check: another desktop app's bff (desktop: true) is accepted.
  assert.deepEqual(checkConfig({ serverName: 'Home manga', allowRegistration: false, oidc: { enabled: false, name: 'SSO' } }), { ok: true, name: 'Home manga' });
  assert.deepEqual(checkConfig({ serverName: 'Uchiyomi', oidc: { enabled: false }, desktop: true }), { ok: false, error: 'desktop' });
  assert.deepEqual(checkConfig({ serverName: '  ', oidc: {} }), { ok: true, name: 'Uchiyomi' });
  assert.deepEqual(checkConfig({ serverName: 'a\nb', oidc: {} }), { ok: true, name: 'a b' });
  for (const j of [null, 'x', [], {}, { serverName: 'x' }, { oidc: {} }, { serverName: 1, oidc: {} }]) assert.deepEqual(checkConfig(j), { ok: false, error: 'not-uchiyomi' }, JSON.stringify(j));
});

/** A fake net.fetch: routes by URL; `final` is the URL after redirects (Response.url). */
function fakeFetch(routes) {
  const asked = [];
  const f = async (url, init) => {
    asked.push({ url, init });
    const r = routes[url];
    if (!r) throw Object.assign(new Error('net::ERR_CONNECTION_REFUSED'), {});
    if (r.throw) throw r.throw;
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return { url: r.final || url, status: r.status || 200, ok: (r.status || 200) < 400, headers: new Map(Object.entries(r.headers || {})), text: async () => body };
  };
  return { f, asked };
}
const SERVER = { serverName: 'Home manga', allowRegistration: false, oidc: { enabled: false, name: 'SSO' } };

test('probe: a server answers; the FINAL origin of an http -> https redirect is the one kept', async () => {
  // Reintroduce by keeping the typed origin after a redirect: the window then loads plain http every launch.
  const a = fakeFetch({ 'https://manga.example.com/auth/config': { body: SERVER } });
  assert.deepEqual(await probeServer('manga.example.com', { fetch: a.f }), { ok: true, origin: 'https://manga.example.com', host: 'manga.example.com', path: '', schemeAdded: true, name: 'Home manga' });
  assert.equal(a.asked[0].init.redirect, 'follow');
  const b = fakeFetch({ 'http://manga.example.com/auth/config': { body: SERVER, final: 'https://manga.example.com/auth/config' } });
  const rb = await probeServer('http://manga.example.com/library', { fetch: b.f });
  assert.equal(rb.ok, true);
  assert.equal(rb.origin, 'https://manga.example.com');
  // A server on this PC, over plain http, is a server like any other.
  const c = fakeFetch({ 'http://127.0.0.1:8080/auth/config': { body: SERVER } });
  assert.equal((await probeServer('http://127.0.0.1:8080', { fetch: c.f })).ok, true);
});

test('probe: refusals say why -- desktop app, not Uchiyomi, HTTP errors, unreachable, certificate, portal, basic auth', async () => {
  // Reintroduce by treating any 200 as a server: the HTML page below is "connected".
  const f = fakeFetch({
    'https://desk.example/auth/config': { body: { ...SERVER, desktop: true } },
    'https://html.example/auth/config': { body: '<!doctype html><title>NAS</title>' },
    'https://missing.example/auth/config': { status: 404, body: 'nope' },
    'https://down.example/auth/config': { status: 502, body: 'Bad gateway' },
    'https://self.example/auth/config': { throw: new Error('net::ERR_CERT_AUTHORITY_INVALID') },
    'https://tls.example/auth/config': { throw: new Error('net::ERR_SSL_PROTOCOL_ERROR') },
    'https://slow.example/auth/config': { throw: Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) },
    'https://sso.example/auth/config': { final: 'https://auth.example/?rd=https%3A%2F%2Fsso.example%2Fauth%2Fconfig', body: '<html>sign in</html>' },
    'https://basic.example/auth/config': { status: 401, headers: { 'www-authenticate': 'Basic realm="x"' }, body: '' },
  }).f;
  const why = async (u) => { const r = await probeServer(u, { fetch: f }); return [r.ok, r.error, r.detail ?? r.status ?? r.portal ?? null]; };
  assert.deepEqual(await why('https://desk.example'), [false, 'desktop', null]);
  assert.deepEqual(await why('https://html.example'), [false, 'not-uchiyomi', null]);
  assert.deepEqual(await why('https://missing.example'), [false, 'not-uchiyomi', 404]);
  assert.deepEqual(await why('https://down.example'), [false, 'http', 502]);
  assert.deepEqual(await why('https://nothing.example'), [false, 'unreachable', 'ERR_CONNECTION_REFUSED']);
  assert.deepEqual(await why('https://self.example'), [false, 'cert', 'ERR_CERT_AUTHORITY_INVALID']);
  assert.deepEqual(await why('https://tls.example'), [false, 'tls', 'ERR_SSL_PROTOCOL_ERROR']);
  assert.deepEqual(await why('https://slow.example'), [false, 'unreachable', 'ERR_TIMED_OUT']);
  assert.deepEqual(await why('https://sso.example'), [false, 'portal', 'auth.example']);
  assert.deepEqual(await why('https://basic.example'), [false, 'basic-auth', null]);
  // A portal is continued with the address TYPED, never the portal's.
  assert.equal((await probeServer('https://sso.example', { fetch: f })).origin, 'https://sso.example');
  assert.deepEqual(await probeServer('ftp://x', { fetch: f }), { ok: false, error: 'scheme' });
  assert.equal(isCertErrorName('ERR_CERT_DATE_INVALID'), true);
  assert.equal(isCertErrorName('ERR_SSL_PROTOCOL_ERROR'), false);
  assert.equal(isCertErrorCode(-202), true);
  assert.equal(isCertErrorCode(-200), true);
  assert.equal(isCertErrorCode(-105), false);
  assert.equal(isCertErrorCode(-3), false);
});

// ---------------------------------------------------------------- certificates
const PEM = `-----BEGIN CERTIFICATE-----
MIIBjjCCATOgAwIBAgIUUrHLXjSHsDKxvV3H/meosLrWl3QwCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRbWFuZ2EuZXhhbXBsZS5sYW4wHhcNMjYwOTI0MDc0NzU2WhcN
MzYwOTIxMDc0NzU2WjAcMRowGAYDVQQDDBFtYW5nYS5leGFtcGxlLmxhbjBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABBCKb/XXCTc5JlGCqTfVHA7DbVPx8xhmHYl2
edc9S40FwgUcumEv+2U6eElnqSQbVIik0LRUkf+0ici4iZ7Ye/CjUzBRMB0GA1Ud
DgQWBBTTSrj3FbM/hqqCux93qSHA16AsPjAfBgNVHSMEGDAWgBTTSrj3FbM/hqqC
ux93qSHA16AsPjAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0kAMEYCIQDR
6CcW/JP3aj3Uwt4jqLQ208ssrjfSA6D5q250iQndDgIhANxHJFAKZj4wkZpfvRJs
98iZe1Gl4MV9HUZQw69g63cr
-----END CERTIFICATE-----
`;
// `openssl x509 -in fx.pem -noout -fingerprint -sha256` of the certificate above.
const FP = 'D4:AE:E2:86:66:D4:12:2B:22:D7:6C:64:78:9B:11:B9:2D:0A:45:BF:13:2C:CC:A7:06:9B:88:5E:D1:72:1E:29';
const OTHER = 'AA:'.repeat(31) + 'AA';

test('the fingerprint is the SHA-256 of the certificate, as openssl and browsers print it', () => {
  // Reintroduce by hashing the PEM text instead of the DER: the value no longer matches what the server shows.
  assert.equal(fingerprintOf({ data: PEM }), FP);
  // Electron's own `sha256/<base64>` field, when the PEM is missing, gives the same value.
  assert.equal(fingerprintOf({ fingerprint: `sha256/${Buffer.from(FP.replace(/:/g, ''), 'hex').toString('base64')}` }), FP);
  assert.equal(fingerprintOf({ data: 'not a certificate' }), '');
  assert.equal(fingerprintOf(null), '');
  const s = certSummary('manga.example.lan', { data: PEM, subjectName: 'manga.example.lan', issuerName: 'manga.example.lan', validExpiry: 2105655476 });
  assert.equal(s.fingerprint, FP);
  assert.equal(s.validTo, new Date(2105655476 * 1000).toISOString());
});

test('certDecision: Chromium-trusted or EXACTLY the pinned certificate; a pinned host with another one is "changed"', () => {
  // Reintroduce by returning 'accept' whenever the host has any pin (or 'ask' instead of 'changed'): the
  // changed-certificate warning -- the one defence against someone in the middle -- never shows.
  const pins = { 'manga.example.lan': FP };
  assert.equal(certDecision({ host: 'public.example', fingerprint: '', chromiumOk: true, pins: {} }), 'accept');
  assert.equal(certDecision({ host: 'manga.example.lan', fingerprint: OTHER, chromiumOk: true, pins }), 'accept', 'a publicly valid certificate needs no pin');
  assert.equal(certDecision({ host: 'manga.example.lan', fingerprint: FP, chromiumOk: false, pins }), 'accept');
  assert.equal(certDecision({ host: 'MANGA.example.lan', fingerprint: FP, chromiumOk: false, pins }), 'accept');
  assert.equal(certDecision({ host: 'manga.example.lan', fingerprint: OTHER, chromiumOk: false, pins }), 'changed');
  assert.equal(certDecision({ host: 'manga.example.lan', fingerprint: '', chromiumOk: false, pins }), 'changed', 'unreadable is never the pin');
  assert.equal(certDecision({ host: 'other.example.lan', fingerprint: FP, chromiumOk: false, pins }), 'ask', 'pins are per host');
  assert.equal(certDecision({ host: 'manga.example.lan', fingerprint: FP, chromiumOk: false, pins: {} }), 'ask');
  // No accept-all path: whatever state.json holds, an untrusted certificate is accepted only by an equal pin.
  for (const junk of [null, undefined, 'x', [], { 'manga.example.lan': '' }, { 'manga.example.lan': true }, { '*': FP }, Object.create({ 'manga.example.lan': FP })]) {
    assert.notEqual(certDecision({ host: 'manga.example.lan', fingerprint: FP, chromiumOk: false, pins: /** @type {any} */ (junk) }), 'accept', JSON.stringify(junk));
  }
  assert.equal(certDecision({ host: '__proto__', fingerprint: FP, chromiumOk: false, pins: {} }), 'ask');
});

test('Trust pins only the certificate the server is presenting now; replacing a pin needs the explicit second step', () => {
  // Reintroduce by dropping the `!replace` check in pinUpdate: a changed certificate is re-pinned in one click.
  const presented = { host: 'manga.example.lan', fingerprint: FP };
  assert.deepEqual(pinUpdate({ pins: {}, host: 'manga.example.lan', fingerprint: FP, presented }), { ok: true, pins: { 'manga.example.lan': FP }, replaced: '' });
  assert.deepEqual(pinUpdate({ pins: {}, host: 'manga.example.lan', fingerprint: OTHER, presented }), { ok: false, error: 'stale' }, 'a fingerprint the page made up');
  assert.deepEqual(pinUpdate({ pins: {}, host: 'manga.example.lan', fingerprint: FP, presented: null }), { ok: false, error: 'stale' });
  assert.deepEqual(pinUpdate({ pins: {}, host: 'other.lan', fingerprint: FP, presented }), { ok: false, error: 'stale' });
  assert.deepEqual(pinUpdate({ pins: {}, host: 'manga.example.lan', fingerprint: 'AB', presented }), { ok: false, error: 'invalid' });
  assert.deepEqual(pinUpdate({ pins: {}, host: '__proto__', fingerprint: FP, presented: { host: '__proto__', fingerprint: FP } }), { ok: false, error: 'invalid' });
  const old = { 'manga.example.lan': OTHER, 'nas.lan': OTHER };
  assert.deepEqual(pinUpdate({ pins: old, host: 'manga.example.lan', fingerprint: FP, presented }), { ok: false, error: 'changed' });
  assert.deepEqual(pinUpdate({ pins: old, host: 'manga.example.lan', fingerprint: FP, presented, replace: true }), { ok: true, pins: { 'nas.lan': OTHER, 'manga.example.lan': FP }, replaced: OTHER });
  assert.deepEqual(pinsOf({ certPins: 'x' }), {});
  assert.deepEqual(pinsOf({ certPins: { a: FP } }), { a: FP });
});

// ---------------------------------------------------------------- modes
test('startup: a v0.44.0 profile stays standalone without the chooser; a saved choice beats a flag', () => {
  // Reintroduce by checking `state.mode` alone: every v0.44.0 install is asked the first-launch question.
  assert.deepEqual(pickStartup({ state: { libraryDir: 'C:\\Users\\a\\Uchiyomi Library', uiPort: 41234 } }), { mode: 'standalone' });
  assert.deepEqual(pickStartup({ state: {} }), { mode: 'choose' });
  assert.deepEqual(pickStartup({}), { mode: 'choose' });
  assert.deepEqual(pickStartup({ state: {}, libraryDir: '/tmp/lib' }), { mode: 'standalone' });
  assert.deepEqual(pickStartup({ state: {}, serverUrl: 'http://127.0.0.1:8080' }), { mode: 'server', probe: 'http://127.0.0.1:8080' });
  const saved = { mode: 'server', serverOrigin: 'https://manga.example.com', serverName: 'Home manga' };
  assert.deepEqual(pickStartup({ state: saved }), { mode: 'server', origin: 'https://manga.example.com', name: 'Home manga' });
  assert.deepEqual(pickStartup({ state: saved, serverUrl: 'http://other:1', libraryDir: '/x' }), { mode: 'server', origin: 'https://manga.example.com', name: 'Home manga' });
  assert.deepEqual(pickStartup({ state: { mode: 'server', serverOrigin: 'https://manga.example.com' } }), { mode: 'server', origin: 'https://manga.example.com', name: 'manga.example.com' });
  assert.deepEqual(pickStartup({ state: { mode: 'server', serverOrigin: 'https://manga.example.com/x' } }), { mode: 'choose' }, 'not an origin: ask again');
  assert.deepEqual(pickStartup({ state: { mode: 'server', serverOrigin: 'javascript:alert(1)' } }), { mode: 'choose' });
  assert.deepEqual(pickStartup({ state: { mode: 'standalone' }, serverUrl: 'http://x:1' }), { mode: 'standalone' });
  // "Forget this server" leaves 'choose': asked again although a standalone library exists.
  assert.deepEqual(pickStartup({ state: { mode: 'choose', libraryDir: '/lib' } }), { mode: 'choose' });
});

test('navigation: standalone as in v0.44.0; server mode allows its origin and https sign-in round trips', () => {
  // Reintroduce by allowing file: pages from a web page in server mode: the server's page could navigate the
  // window to welcome.html and drive its calls.
  const isShell = (u) => /\/src\/(welcome|firstrun|loading)\.html/.test(u);
  const d = (mode, url, own, current = '') => navDecision({ mode, url, own, current, isShell });
  const app = 'http://127.0.0.1:41234';
  assert.equal(d('standalone', `${app}/library`, app), 'allow');
  assert.equal(d('standalone', 'https://github.com/x', app), 'external');
  assert.equal(d('standalone', 'http://127.0.0.1:9999/', app), 'external');
  assert.equal(d('standalone', 'file:///app/src/firstrun.html', app), 'allow');
  assert.equal(d('standalone', 'file:///etc/passwd', app), 'block');
  assert.equal(d('standalone', 'javascript:alert(1)', app), 'block');
  const srv = 'http://192.168.1.10:8080';
  assert.equal(d('server', `${srv}/library`, srv), 'allow');
  assert.equal(d('server', 'https://auth.example.com/login?rd=x', srv), 'allow', 'SSO / forward auth stays in the window');
  assert.equal(d('server', 'http://auth.example.com/', srv), 'external');
  assert.equal(d('server', 'file:///app/src/welcome.html', srv, `${srv}/`), 'block');
  assert.equal(d('server', 'file:///app/src/welcome.html', srv, 'file:///app/src/loading.html'), 'allow');
  assert.equal(d('choose', 'https://example.com/', ''), 'external');
});

test('switching modes never touches standalone data; forgetting drops only that server and its pin', () => {
  // Reintroduce by deleting certPins wholesale in forgetServerState: the other server's pin goes too.
  const s = { libraryDir: '/lib', uiPort: 41234, pgPort: 41235, mode: 'server', serverOrigin: 'https://manga.example.lan', serverName: 'Home', certPins: { 'manga.example.lan': FP, 'nas.lan': OTHER }, mainPid: 5 };
  assert.deepEqual(forgetServerState(structuredClone(s), 'manga.example.lan'), { libraryDir: '/lib', uiPort: 41234, pgPort: 41235, mode: 'choose', certPins: { 'nas.lan': OTHER }, mainPid: 5 });
  assert.deepEqual(relaunchArgs(['/opt/Uchiyomi', '--hidden', '--data-dir=/d', '--server-url=http://x:1', '--server-url', '--no-sandbox']), ['--data-dir=/d', '--no-sandbox']);
});

// ---------------------------------------------------------------- main.js wiring (static: it needs Electron to run)
const main = read('src/main.js');
/** The source of one top-level function of main.js. */
function fn(name) {
  const at = main.search(new RegExp(`\\n(async )?function ${name}\\(`));
  assert.ok(at >= 0, `main.js has no function ${name}`);
  const end = main.indexOf('\n}\n', at);
  return main.slice(at, end + 3);
}

test('main.js: server mode starts none of the standalone machinery', () => {
  // Reintroduce by moving `const secret = newSecret();` (or installSignIn, the onBeforeRequest gate, the
  // supervisor) up into runApp before the mode branch: this names it.
  // Calls, not words: the comments may name them.
  const forbidden = ['newSecret(', 'installSignIn(', 'ShellSession(', 'onBeforeRequest(', 'makeSupervisor(', 'sup.start(', 'Supervisor(', 'startSolver(', 'libraryDir()'];
  for (const f of ['runServer', 'loadServer', 'runApp', 'firstLaunch', 'showWelcome', 'probe', 'installCertCheck', 'saveServer', 'useLocal', 'forgetServer', 'replaceWindow']) {
    const body = fn(f);
    for (const x of forbidden) assert.ok(!body.includes(x), `${f} reaches ${x}`);
  }
  // They exist, in runStandalone (and the headless smoke).
  const sa = fn('runStandalone');
  for (const x of ['newSecret()', 'installSignIn(', 'new ShellSession(', 'onBeforeRequest(', 'makeSupervisor(']) assert.ok(sa.includes(x), `runStandalone lost ${x}`);
  assert.equal(main.split('installSignIn(session').length - 1, 1, 'installSignIn is called once, in runStandalone');
  // runApp hands server mode to runServer and standalone to runStandalone, and nothing else.
  const ra = fn('runApp');
  assert.match(ra, /if \(start\.mode === 'standalone'\) return await runStandalone\(\);/);
  assert.match(ra, /return await runServer\(sv\);/);
  assert.match(ra, /appOrigin: \(\) => appOriginFor\(\{ mode: appMode, uiPort: sup\?\.uiPort \|\| 0 \}\)/);
});

test('main.js: mainPid is written from the first moment in every mode, so --quit-for-update waits for server mode too', () => {
  // Reintroduce by deleting the mainPid line from runApp: in server mode (no supervisor) nothing writes it, and
  // quitForUpdateClient returns at once while the app still runs -- the installer then replaces its files.
  const ra = fn('runApp');
  const pid = ra.indexOf('stateFile.update(L.state, (s) => { s.mainPid = process.pid; });');
  assert.ok(pid > 0, 'runApp does not write mainPid');
  assert.ok(pid < ra.indexOf('createWindow(') && pid < ra.indexOf('runServer(') && pid < ra.indexOf('runStandalone()'), 'mainPid is written after the mode branch');
  const q = fn('quitForUpdateClient');
  assert.match(q, /const pid = Number\(s\.mainPid\) \|\| 0;/);
});

test('main.js: the window carries its mode; server mode quits on close, reloads its server, shows the shell page on failure', () => {
  // Reintroduce by leaving `--uchiyomi-mode=${mode}` out of additionalArguments: the preload then gives nobody the
  // bridge (the standalone app breaks) -- and the check below names it first.
  const cw = fn('createWindow');
  assert.match(cw, /additionalArguments: \[`--uchiyomi-version=\$\{app\.getVersion\(\)\}`, `--uchiyomi-lang=\$\{lang\}`, `--uchiyomi-mode=\$\{mode\}`\]/);
  assert.match(cw, /if \(mode !== 'standalone'\) \{\s*w\.hide\(\);\s*void quit\('window-closed'\);/);
  // Reintroduce by deleting the 'closed' handler: a page's window.close() leaves server mode running windowless
  // (the product smoke's "closing the window quits" check caught exactly that).
  assert.match(cw, /w\.on\('closed', \(\) => \{\s*if \(mode !== 'standalone' && !quitting && !retired\.has\(w\)\) void quit\('window-closed'\);/);
  assert.match(fn('replaceWindow'), /retired\.add\(old\);[\s\S]*old\.destroy\(\)/);
  assert.match(cw, /if \(mode === 'server' && server\) setTimeout\(\(\) => void loadServer\(\), 1000\);/);
  assert.match(cw, /wc\.on\('did-fail-load', \(_e, code, desc, url, isMainFrame\) => \{\s*if \(isMainFrame && !quitting && \/\^https\?:\/i\.test\(url\)\) onServerLoadFailed\(code, desc, url\);/);
  assert.match(cw, /navDecision\(\{ mode, url, own: ownOrigin\(\), current: wc\.getURL\(\)/);
  // A first-launch choice continues in a NEW window started in the chosen mode.
  assert.match(fn('runApp'), /appMode = choice\.mode;\s*replaceWindow\(\);/);
});

test('main.js: certificates -- no accept-all path, no certificate-error handler, pins written only through pinUpdate', () => {
  // Reintroduce by answering cb(0) for every hostname with a pin (skipping certDecision): this fails.
  assert.doesNotMatch(main, /\.on\(\s*['"]certificate-error['"]/, 'a certificate-error handler can accept what the verify proc refused');
  const cc = fn('installCertCheck');
  assert.equal(cc.split('cb(0)').length - 1, 1, 'one accept');
  assert.match(cc, /if \(d === 'accept'\) \{ cb\(0\); return; \}/);
  assert.match(cc, /const d = certDecision\(\{ host, fingerprint: info\.fingerprint, chromiumOk: false, pins \}\);/);
  assert.match(cc, /if \(req\.errorCode === 0\) \{ cb\(-3\); return; \}/);
  // Two writers, each through its pure rule: Trust (pinUpdate) and saving a server (serverPins, the OS pin).
  assert.equal(main.split('certPins =').length - 1, 2, 'certPins is written in two places');
  assert.match(fn('saveServer'), /const pins = serverPins\(pinsOf\(s\), v\.origin\);\s*if \(pins\) s\.certPins = pins;/);
  // Reintroduce by probing with the window's own session (net.fetch): Chromium caches the refusal there, and the
  // certificate the person just trusted keeps failing until a restart (seen in the real app under Xvfb).
  assert.match(fn('probe'), /async function probe\(address, ses = probeSes\(\)\)/);
  assert.doesNotMatch(fn('probe'), /net\.fetch/);
  assert.match(fn('probeSes'), /session\.fromPartition\(`uchiyomi-probe-\$\{\+\+probeSessions\}`\);\s*installCertCheck\(probeSession\);/);
  assert.match(main, /presented\.delete\(h\);\s*probeSession = null;\s*checkSession = null;\s*pinChanged = true;/);
  assert.match(main, /if \(appMode === 'server' && \(pinChanged \|\| windowRefused\.has\(serverHostname\(\)\)\)\) switchRelaunch\(\);/);
  // Reintroduce by deleting the onServerCertRefused line from the verify proc: with the server's service worker
  // answering from its cache, a changed certificate showed NO warning (seen under Xvfb).
  assert.match(cc, /windowRefused\.add\(host\);[\s\S]*setImmediate\(\(\) => onServerCertRefused\(host\)\);/);
  // (What onServerCertRefused may show -- only what a probe of the server's own origin saw -- is
  // shell.servercert.test.mjs's.)
  assert.match(main, /const u = pinUpdate\(\{ pins: pinsOf\(s\), host: h, fingerprint, presented: presented\.get\(h\), replace \}\);\s*if \(u\.ok\) s\.certPins = u\.pins;/);
});

test('main.js: mode switches go through stateFile.update and the ordered quit', () => {
  // Reintroduce by writing a state copy read earlier (stateFile.write) in saveServer: a port or pid the
  // supervisor wrote since is lost.
  for (const f of ['saveServer', 'useLocal', 'forgetServer', 'saveLibraryDir']) {
    const b = fn(f);
    assert.match(b, /stateFile\.update\(L\.state/, f);
    assert.doesNotMatch(b, /stateFile\.write\(/, f);
  }
  assert.match(fn('switchRelaunch'), /app\.relaunch\(\{ args: relaunchArgs\(process\.argv\) \}\);\s*void quit\('relaunch'\);/);
  // Saving a server writes the server's keys (and its OS pin) and nothing of standalone's.
  const ss = fn('saveServer');
  assert.match(ss, /\(s\) => \{\s*s\.mode = 'server'; s\.serverOrigin = v\.origin; s\.serverName = v\.name;/);
  assert.doesNotMatch(ss, /s\.(libraryDir|uiPort|pgPort|readLibrary|mainPid)\s*=|delete s\./);
});

test("closing the server-mode window is Quit: a downloaded Windows update installs, as on the tray's Quit", () => {
  // Reintroduce by leaving 'window-closed' out of installOnQuit: a server-mode user, who never uses the tray's
  // Quit, never gets the downloaded update installed.
  assert.equal(installOnQuit('window-closed'), true);
  assert.equal(installOnQuit('relaunch'), false, 'a mode switch relaunches without installing');
});

// ---------------------------------------------------------------- the library on this computer (V2 review)
/** The source of one member of an object literal in main.js (`  name: (...) => {` up to its closing `  },`). */
function member(obj, name) {
  const at = main.indexOf(`const ${obj} = {`);
  assert.ok(at >= 0, `main.js has no ${obj}`);
  const start = main.indexOf(`\n  ${name}: `, at);
  assert.ok(start > at, `${obj} has no ${name}`);
  return main.slice(start, main.indexOf('\n  },', start) + 5);
}

test('"On this computer" after "Forget this server" goes back into the library that exists, never the folder page', () => {
  // Reintroduce by deleting the `=== 'resume'` branch from welcomeApi.local: the folder page offered the DEFAULT
  // folder and "Use this folder" re-pointed the existing database at an empty one (found under Xvfb) -- "the
  // first-launch choice resumes the existing library" fails.
  const { localStart } = require('../src/servermode.js');
  const s = { libraryDir: 'D:\\Manga', uiPort: 41234, mode: 'server', serverOrigin: 'https://manga.example.lan', serverName: 'Home', certPins: {} };
  const after = forgetServerState(structuredClone(s), 'manga.example.lan');
  assert.equal(after.mode, 'choose');
  assert.equal(localStart(after), 'resume', 'forgetting a server keeps the library on this computer');
  assert.equal(localStart({ libraryDir: '/lib' }), 'resume');
  for (const none of [{}, { libraryDir: '' }, { libraryDir: 42 }, null, undefined]) assert.equal(localStart(/** @type {any} */ (none)), 'folder', JSON.stringify(none));
  const local = member('welcomeApi', 'local');
  const resume = local.indexOf("if (localStart(stateFile.read(L.state)) === 'resume') {");
  assert.ok(resume > 0, 'the first-launch choice resumes the existing library');
  const branch = local.slice(resume, local.indexOf('\n      }', resume));
  assert.match(branch, /stateFile\.update\(L\.state, \(s\) => \{ s\.mode = 'standalone'; \}\);/, 'the resumed choice is not saved: the next launch asks again');
  assert.match(branch, /c\.resolve\(\{ mode: 'standalone' \}\);\s*return \{ ok: true \};/);
  assert.doesNotMatch(branch, /showFolderStep|firstrun\.html|libraryDir =/, 'the resumed choice goes through the folder page or moves the library');
  assert.ok(resume < local.indexOf('showFolderStep('), 'the folder page is decided before the existing library');
});

test('"Use on this computer instead" with no library yet: the folder page first, nothing saved until a folder is chosen, Back returns to the server', () => {
  // Reintroduce by restoring `stateFile.update(L.state, (s) => { s.mode = 'standalone'; })` as useLocal's first
  // line: mode 'standalone' is saved with no library, the next launch opens a folder page with no Back and a
  // tray whose way back to the server stays disabled -- "useLocal saves the mode before a folder exists" fails.
  const ul = fn('useLocal');
  const folder = ul.indexOf("if (localStart(stateFile.read(L.state)) === 'folder') {");
  assert.ok(folder > 0, 'useLocal does not ask whether a library exists');
  assert.ok(folder < ul.indexOf("s.mode = 'standalone'"), 'useLocal saves the mode before a folder exists');
  const branch = ul.slice(folder, ul.indexOf('\n  }', folder));
  assert.match(branch, /showFolderStep\(\(dir\) => \{ saveLibraryDir\(dir\); switchRelaunch\(\); \}, \(\) => void loadServer\(\)\);\s*return;/);
  assert.doesNotMatch(branch, /stateFile\.update/, 'the folder branch saves something before a folder is chosen');
  // The folder step saves nothing itself, and its Back is whatever the choice that opened it said.
  const step = fn('showFolderStep');
  assert.doesNotMatch(step, /stateFile\.|saveLibraryDir/);
  assert.match(step, /folderBack = back;/);
  assert.match(step, /\{ query: \{ back: '1' \} \}/);
  const back = member('firstRunApi', 'back');
  assert.match(back, /const b = folderBack;\s*if \(!b\) return \{ ok: false \};\s*folderBack = null;\s*firstRunDone = \(\) => \{\};\s*b\(\);/);
  // saveLibraryDir is what makes it standalone: the folder AND the mode, in one update.
  assert.match(fn('saveLibraryDir'), /stateFile\.update\(L\.state, \(s\) => \{ s\.libraryDir = dir; s\.mode = 'standalone'; \}\);/);
});

test('a server-mode load REPLACED by a newer one (ERR_ABORTED) is not an error page', () => {
  // Reintroduce by deleting the loadWasReplaced line from onServerLoadFailed: "Switch server…" while the server
  // was loading showed "Can't reach <server>" (detail "-3") over the address page (V2 review, 1 run in 3).
  const { loadWasReplaced } = require('../src/servermode.js');
  assert.equal(loadWasReplaced(-3), true);
  for (const code of [-2, -6, -7, -21, -100, -102, -105, -106, -118, -200, -202, -324, 0]) assert.equal(loadWasReplaced(code), false, String(code));
  const f = fn('onServerLoadFailed');
  const early = f.indexOf("if (loadWasReplaced(code)) { log.info('window: a load was replaced by a newer one', { host }); return; }");
  assert.ok(early > 0, 'onServerLoadFailed shows an error page for a replaced load');
  assert.ok(early < f.indexOf('showWelcome(') && early < f.indexOf('checkServerCert('), 'the replaced-load check comes after the page is shown');
});

test('probe: a sign-in portal that answers 401/403 itself (Authelia, to a request for JSON) can be continued', async () => {
  // Reintroduce by deleting the `r.status === 401 || r.status === 403` line from probeServer: a server behind
  // Authelia reads "answered with an error (HTTP 401)" with no Continue -- no way to connect at all -- and
  // "a 401 without Basic is a portal" fails.
  const f = fakeFetch({
    'https://authelia.example/auth/config': { status: 401, body: '{"status":"KO","message":"Unauthorized"}' },
    'https://bearer.example/auth/config': { status: 401, headers: { 'www-authenticate': 'Bearer realm="x"' }, body: '' },
    'https://forbidden.example/auth/config': { status: 403, body: '<html>Sign in first</html>' },
    'https://basic.example/auth/config': { status: 401, headers: { 'www-authenticate': 'Basic realm="x"' }, body: '' },
    'https://down.example/auth/config': { status: 502, body: 'Bad gateway' },
  }).f;
  const a = await probeServer('authelia.example/library', { fetch: f });
  assert.deepEqual([a.ok, a.error, a.status, a.portal], [false, 'portal', 401, ''], 'a 401 without Basic is a portal');
  assert.equal(a.origin, 'https://authelia.example', 'continued with the address typed (its origin)');
  assert.equal((await probeServer('https://bearer.example', { fetch: f })).error, 'portal');
  assert.deepEqual([(await probeServer('https://forbidden.example', { fetch: f })).error, (await probeServer('https://forbidden.example', { fetch: f })).status], ['portal', 403]);
  // Still what they were: a proxy's password prompt, and a server error.
  assert.equal((await probeServer('https://basic.example', { fetch: f })).error, 'basic-auth');
  assert.equal((await probeServer('https://down.example', { fetch: f })).error, 'http');
  // The page words it without a portal address, and Continue is offered for it as for a redirect.
  const page = read('src/welcome.html');
  assert.match(page, /r\.portal \? t\('welcome\.portal', \{ host: r\.host \|\| '', portal: r\.portal \}\) : t\('welcome\.signinFirst', \{ host: r\.host \|\| '', status: r\.status \|\| '' \}\)/);
  const { S } = require('../src/i18n.js');
  for (const [lang, strings] of Object.entries(S)) assert.match(strings['welcome.signinFirst'] || '', /\{host\}[\s\S]*\{status\}/, lang);
});
