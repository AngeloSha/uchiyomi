// Server mode's certificate and address guards after the V1 security review of v0.45.0 (each found in the REAL
// app under Xvfb): a server whose certificate this computer trusted is pinned as such, so someone in the middle
// with a self-signed one meets the loud warning, not the one-click prompt (S4); the probe sees every redirect
// hop, so sign-in portals and http -> https upgrades work (S7); only a probe of the server's OWN origin can put a
// certificate prompt up, never a page's request or another host (S2g, S2h, S5); one double-click never replaces
// a pin (S3b); IPv6 literals key pins the way Chromium does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8');
const {
  probeServer, hopFetch, certDecision, pinUpdate, serverPins, OS_PIN, loadFailedStep, afterServerCheck, pinHost,
  originHost, forgetServerState, promptableCert,
} = require('../src/servermode.js');

const FP = 'D4:AE:E2:86:66:D4:12:2B:22:D7:6C:64:78:9B:11:B9:2D:0A:45:BF:13:2C:CC:A7:06:9B:88:5E:D1:72:1E:29';
const OTHER = 'AA:'.repeat(31) + 'AA';
const SERVER = { serverName: 'Home manga', allowRegistration: false, oidc: { enabled: false, name: 'SSO' } };

// ---------------------------------------------------------------- the probe sees every hop
/**
 * A fake electron net.request, event for event as Electron 44 emits them (checked in the real app): 'redirect'
 * (status, method, to) that is cancelled unless followRedirect() is called synchronously, 'response' with
 * statusCode/headers and 'data'/'end', 'error' with a `net::ERR_*` message.
 * routes[url]: { redirect } | { status, headers, body } | { error } | { hang: true }
 */
function fakeNet(routes) {
  const made = [];
  const visited = [];
  const request = (o) => {
    made.push(o);
    const req = new EventEmitter();
    let at = o.url;
    let aborted = false;
    req.abort = () => { if (aborted) return; aborted = true; setImmediate(() => req.emit('abort')); };
    const step = () => {
      if (aborted) return;
      visited.push(at);
      const r = routes[at];
      if (!r) { req.emit('error', new Error('net::ERR_CONNECTION_REFUSED')); return; }
      if (r.error) { req.emit('error', new Error(r.error)); return; }
      if (r.hang) return;
      if (r.redirect) {
        const to = new URL(r.redirect, at).href;
        let go = false;
        req.followRedirect = () => { go = true; };
        req.emit('redirect', r.status || 302, 'GET', to, {});
        if (aborted) return;
        if (go) { at = to; setImmediate(step); } else req.emit('error', new Error('net::ERR_ABORTED'));
        return;
      }
      const res = new EventEmitter();
      res.statusCode = r.status || 200;
      res.headers = r.headers || {};
      req.emit('response', res);
      const body = Buffer.from(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? ''));
      setImmediate(() => {
        for (let i = 0; i < body.length && !aborted; i += 65536) res.emit('data', body.subarray(i, i + 65536));
        if (!aborted) res.emit('end');
      });
    };
    req.end = () => setImmediate(step);
    return req;
  };
  const fetch = (u, init) => hopFetch(request, u, init);
  return { fetch, made, visited };
}

test('probe: a sign-in portal in front is a portal -- the redirect is seen, not read as "not an Uchiyomi server"', async () => {
  // Reintroduce by resolving hopFetch the way Electron 44's session.fetch answers after a redirect (`url: ''`,
  // no `hops`): the portal below reads as 'not-uchiyomi' and could never be added.
  const n = fakeNet({
    'http://127.0.0.1:8080/auth/config': { redirect: '/login?rd=%2Fauth%2Fconfig' },
    'http://127.0.0.1:8080/login?rd=%2Fauth%2Fconfig': { body: '<!doctype html><title>Sign in</title>' },
  });
  const r = await probeServer('http://127.0.0.1:8080', { fetch: n.fetch });
  assert.equal(r.error, 'portal', JSON.stringify(r));
  assert.equal(r.portal, '127.0.0.1:8080');
  assert.equal(r.origin, 'http://127.0.0.1:8080', 'continued with the server, never the portal');
  // What the probe asks for, and how: no cookies, no credentials (a proxy's 401 comes back AS a 401), hop by hop.
  assert.deepEqual({ ...n.made[0], headers: undefined }, { url: 'http://127.0.0.1:8080/auth/config', method: 'GET', redirect: 'manual', credentials: 'omit', headers: undefined });
  assert.equal(n.made[0].headers.accept, 'application/json');
});

test('probe: http -> https on the same host keeps the https origin (not plain http at every launch)', async () => {
  // Reintroduce by leaving `origin: final.origin` out of probeServer's `at` (the typed origin kept): the http
  // origin is saved -- an SSL-strip window at every launch, and Forget clears the wrong origin.
  const n = fakeNet({
    'http://manga.example.com/auth/config': { redirect: 'https://manga.example.com/auth/config', status: 301 },
    'https://manga.example.com/auth/config': { body: SERVER },
  });
  const r = await probeServer('http://manga.example.com', { fetch: n.fetch });
  assert.equal(r.ok, true);
  assert.equal(r.origin, 'https://manga.example.com');
  assert.equal(r.redirectedFrom, 'http://manga.example.com');
  assert.equal(r.newHost, undefined, 'the same host: no question to ask');
  // No redirect: nothing extra in the answer.
  const same = fakeNet({ 'https://manga.example.com/auth/config': { body: SERVER } });
  assert.deepEqual(await probeServer('https://manga.example.com', { fetch: same.fetch }), { ok: true, origin: 'https://manga.example.com', host: 'manga.example.com', path: '', schemeAdded: false, name: 'Home manga' });
});

test('probe: sent on to ANOTHER host is flagged, so the page shows where and waits for Continue', async () => {
  // Reintroduce by dropping `newHost` from probeServer: a plain-http answer re-homes the app to any host,
  // silently and for good.
  const n = fakeNet({
    'http://192.168.1.10:8080/auth/config': { redirect: 'https://elsewhere.example/auth/config' },
    'https://elsewhere.example/auth/config': { body: SERVER },
  });
  const r = await probeServer('http://192.168.1.10:8080', { fetch: n.fetch });
  assert.equal(r.ok, true);
  assert.equal(r.origin, 'https://elsewhere.example');
  assert.equal(r.newHost, true);
  assert.equal(r.redirectedFrom, 'http://192.168.1.10:8080');
  // Behind a portal after an upgrade: the SERVER's origin is the last hop still at /auth/config (https).
  const p = fakeNet({
    'http://manga.example.com/auth/config': { redirect: 'https://manga.example.com/auth/config' },
    'https://manga.example.com/auth/config': { redirect: 'https://auth.example.com/?rd=https%3A%2F%2Fmanga.example.com%2Fauth%2Fconfig' },
    'https://auth.example.com/?rd=https%3A%2F%2Fmanga.example.com%2Fauth%2Fconfig': { body: '<html>sign in</html>' },
  });
  const rp = await probeServer('http://manga.example.com', { fetch: p.fetch });
  assert.deepEqual([rp.error, rp.origin, rp.portal, rp.newHost], ['portal', 'https://manga.example.com', 'auth.example.com', undefined]);
});

test('probe: redirects only to http(s), at most ten; a certificate refused on a later hop names THAT host', async () => {
  // Reintroduce by dropping the http(s) check on a redirect in hopFetch: the file: hop is followed (Chromium
  // itself refuses that one today; this does not lean on it).
  const n = fakeNet({
    'http://a.example/auth/config': { redirect: 'file:///etc/passwd' },
    'http://loop.example/auth/config': { redirect: '/auth/config?again' },
    'http://loop.example/auth/config?again': { redirect: '/auth/config' },
    'http://up.example/auth/config': { redirect: 'https://self.example/auth/config' },
    'https://self.example/auth/config': { error: 'net::ERR_CERT_AUTHORITY_INVALID' },
    'https://slow.example/auth/config': { hang: true },
    'https://basic.example/auth/config': { status: 401, headers: { 'www-authenticate': ['Basic realm="x"'] }, body: '' },
    'https://big.example/auth/config': { body: 'x'.repeat(2_000_000) },
  });
  const a = await probeServer('http://a.example', { fetch: n.fetch });
  assert.deepEqual([a.error, a.detail], ['unreachable', 'ERR_UNSAFE_REDIRECT']);
  assert.ok(!n.visited.some((u) => u.startsWith('file:')), 'the file: hop was never followed');
  const loop = await probeServer('http://loop.example', { fetch: n.fetch });
  assert.deepEqual([loop.error, loop.detail], ['unreachable', 'ERR_TOO_MANY_REDIRECTS']);
  assert.ok(n.visited.filter((u) => u.startsWith('http://loop.example')).length <= 11);
  const up = await probeServer('http://up.example', { fetch: n.fetch });
  assert.deepEqual([up.error, up.failedHost], ['cert', 'self.example']);
  const slow = await probeServer('https://slow.example', { fetch: n.fetch, timeoutMs: 50 });
  assert.deepEqual([slow.error, slow.detail], ['unreachable', 'ERR_TIMED_OUT']);
  assert.equal((await probeServer('https://basic.example', { fetch: n.fetch })).error, 'basic-auth');
  assert.equal((await probeServer('https://big.example', { fetch: n.fetch })).error, 'not-uchiyomi', 'a huge answer is cut, not waited for');
});

// ---------------------------------------------------------------- a server this computer trusted
test("saving an https server this computer trusted pins it as OS-trusted, so a self-signed certificate later is 'changed'", () => {
  // Reintroduce by returning null from serverPins (saveServer then stores no pin): the host has no pin, and a
  // man in the middle's self-signed certificate gets the friendly one-click "Trust this server's certificate?".
  assert.deepEqual(serverPins({}, 'https://manga.example.com'), { 'manga.example.com': OS_PIN });
  assert.deepEqual(serverPins({ 'nas.lan': FP }, 'https://manga.example.com'), { 'nas.lan': FP, 'manga.example.com': OS_PIN }, 'other pins kept');
  assert.equal(serverPins({ 'manga.example.lan': FP }, 'https://manga.example.lan'), null, 'the fingerprint the person trusted stays');
  assert.equal(serverPins({}, 'http://192.168.1.10:8080'), null, 'plain http has no certificate');
  assert.deepEqual(serverPins({}, 'https://[fd00::1]:8443'), { 'fd00::1': OS_PIN }, 'keyed the way the verify proc names the host');
  // Reintroduce by treating 'os' as no pin in certDecision: 'ask' comes back here.
  assert.equal(certDecision({ host: 'manga.example.com', fingerprint: FP, chromiumOk: false, pins: { 'manga.example.com': OS_PIN } }), 'changed');
  assert.equal(certDecision({ host: 'manga.example.com', fingerprint: '', chromiumOk: false, pins: { 'manga.example.com': OS_PIN } }), 'changed');
  assert.equal(certDecision({ host: 'manga.example.com', fingerprint: FP, chromiumOk: true, pins: { 'manga.example.com': OS_PIN } }), 'accept', 'a renewed trusted certificate is still fine');
  // ... and it is never replaced from the warning, however explicitly: Forget, then connect again.
  // Reintroduce by deleting `if (had === OS_PIN)` from pinUpdate: `replace: true` pins the new certificate.
  const presented = { host: 'manga.example.com', fingerprint: FP };
  assert.deepEqual(pinUpdate({ pins: { 'manga.example.com': OS_PIN }, host: 'manga.example.com', fingerprint: FP, presented, replace: true }), { ok: false, error: 'changed' });
  assert.deepEqual(forgetServerState({ mode: 'server', serverOrigin: 'https://manga.example.com', certPins: { 'manga.example.com': OS_PIN } }, 'manga.example.com'), { mode: 'choose', certPins: {} });
});

// ---------------------------------------------------------------- who may raise the prompt
test('a failed page load prompts only for the SERVER\'s name -- any other host gets the error page, never "Trust"', () => {
  // Reintroduce by dropping `pinHost(host) === pinHost(serverHost)` from loadFailedStep: a navigation to a
  // third-party host with a self-signed certificate offers "Trust this server" for THAT host, and pins it.
  assert.equal(loadFailedStep({ code: -202, host: 'other.test', serverHost: 'manga.example.lan' }), 'error');
  assert.equal(loadFailedStep({ code: -202, host: 'manga.example.lan', serverHost: 'manga.example.lan' }), 'check');
  assert.equal(loadFailedStep({ code: -105, host: 'manga.example.lan', serverHost: 'manga.example.lan' }), 'error', 'not a certificate problem');
  assert.equal(loadFailedStep({ code: -202, host: '', serverHost: '' }), 'error');
  assert.equal(loadFailedStep({ code: -202, host: '[fd00::1]', serverHost: 'fd00::1' }), 'check', 'IPv6 with or without brackets is one host');
});

test("a refusal for the server's name shows something only when a probe of the server's OWN origin is refused", () => {
  // (main.js wiring below: onServerCertRefused used to show the refusal's own certificate -- an <img> from
  // another port put up the "has changed" warning with ANOTHER service's certificate, and two clicks pinned it.)
  // Reintroduce by dropping the `if (failed)` condition in afterServerCheck: every refused request of the page
  // replaces the working server with an error page.
  assert.equal(afterServerCheck({ probe: { ok: true, origin: 'https://127.0.0.1:8443' }, failed: null }), null);
  const cert = { host: '127.0.0.1', fingerprint: FP, changed: true, pinned: OTHER };
  assert.deepEqual(afterServerCheck({ probe: { ok: false, error: 'cert', cert } }), { step: 'cert', cert });
  assert.deepEqual(afterServerCheck({ probe: { ok: true }, failed: { code: 'ERR_CERT_AUTHORITY_INVALID', host: '127.0.0.1' } }), { step: 'error', error: { code: 'ERR_CERT_AUTHORITY_INVALID', host: '127.0.0.1' } });
  assert.equal(afterServerCheck({ probe: { ok: false, error: 'cert' }, failed: null }), null, 'no certificate seen: nothing to trust');
  assert.equal(afterServerCheck({ probe: { ok: false, error: 'unreachable' }, failed: null }), null);
});

test('a probe offers to trust only the certificate of the host it was ASKED about, never one met along a redirect', () => {
  // Reintroduce by dropping `at === asked` from promptableCert: a server (or a plain-http answer) that sends the
  // probe to another host with a self-signed certificate gets "Trust this server's certificate?" for THAT host.
  const cert = { host: 'auth.example.lan', fingerprint: FP };
  const seen = (h) => (h === 'auth.example.lan' ? cert : h === 'home.example.lan' ? { host: 'home.example.lan', fingerprint: FP } : undefined);
  assert.deepEqual(promptableCert({ error: 'cert', origin: 'https://home.example.lan', failedHost: 'auth.example.lan' }, seen), { cert: null, host: 'auth.example.lan' });
  assert.deepEqual(promptableCert({ error: 'cert', origin: 'http://home.example.lan:8080', failedHost: 'home.example.lan' }, seen).cert?.host, 'home.example.lan', 'http -> https on the same name is still asked');
  assert.deepEqual(promptableCert({ error: 'cert', origin: 'https://home.example.lan' }, seen).cert?.host, 'home.example.lan');
  assert.deepEqual(promptableCert({ error: 'cert', origin: 'https://[fd00::1]:8443', failedHost: 'fd00::1' }, (h) => (h === 'fd00::1' ? cert : undefined)).cert, cert);
  assert.deepEqual(promptableCert({ error: 'cert', origin: 'https://nothing.lan' }, () => undefined), { cert: null, host: 'nothing.lan' });
});

test('IPv6 literals: one key for a pin, however the host is spelled', () => {
  // Reintroduce by keying with new URL(...).hostname (brackets kept): the verify proc's `fd00::1` never meets
  // the pin, the changed warning never shows, Forget leaves the pin.
  assert.equal(pinHost('[FD00::1]'), 'fd00::1');
  assert.equal(pinHost('fd00::1'), 'fd00::1');
  assert.equal(originHost('https://[fd00::1]:8443/x'), 'fd00::1');
  assert.equal(originHost('https://Manga.Example.lan'), 'manga.example.lan');
  assert.equal(originHost('not a url'), '');
  assert.equal(certDecision({ host: 'fd00::1', fingerprint: FP, chromiumOk: false, pins: { 'fd00::1': FP } }), 'accept');
  assert.deepEqual(forgetServerState({ certPins: { 'fd00::1': FP } }, '[fd00::1]').certPins, {});
});

// ---------------------------------------------------------------- main.js wiring (static: it needs Electron)
const main = read('src/main.js');
function fn(name) {
  const at = main.search(new RegExp(`\\n(async )?function ${name}\\(`));
  assert.ok(at >= 0, `main.js has no function ${name}`);
  return main.slice(at, main.indexOf('\n}\n', at) + 3);
}

test("main.js: only a probe of the server's own origin puts a certificate up; the window's refusals only ask", () => {
  // Reintroduce by showing presented.get(host) straight from onServerCertRefused (or onServerLoadFailed): the
  // page's own requests raise the prompt again.
  const refused = fn('onServerCertRefused');
  assert.match(refused, /void checkServerCert\(\);/);
  assert.doesNotMatch(refused, /presented|showWelcome\(/);
  const failed = fn('onServerLoadFailed');
  assert.match(failed, /loadFailedStep\(\{ code, host, serverHost: serverHostname\(\) \}\)/);
  assert.doesNotMatch(failed, /presented/);
  const once = fn('checkServerCertOnce');
  assert.match(once, /await ses\.closeAllConnections\(\)[\s\S]*await probe\(sv\.origin, ses\)[\s\S]*afterServerCheck\(\{ probe: r, failed \}\)/);
  // The verify proc records a sighting for a PROBE session only; the window's refusals never reach `presented`.
  const cc = fn('installCertCheck');
  assert.doesNotMatch(cc, /presented\.set/);
  assert.match(cc, /if \(!isWindow\) \{[\s\S]*sightings[\s\S]*return;\s*\}\s*windowRefused\.add\(host\);/);
  // ... and a probe takes the certificate from ITS session, and only the asked host's (promptableCert).
  assert.match(fn('probe'), /const p = promptableCert\(r, \(h\) => sightings\.get\(ses\)\?\.get\(h\)\);\s*if \(p\.cert\) \{ r\.cert = p\.cert; presented\.set\(p\.cert\.host, p\.cert\); \}/);
});

test('main.js: the probe goes hop by hop (net.request), never through fetch; a new host is never saved unasked', () => {
  // Reintroduce by probing with `ses.fetch(u, init)` again: Electron 44 reports no final address, and the
  // portal / http -> https cases break in the real app while the unit tests above still pass.
  const pr = fn('probe');
  assert.match(pr, /require\('electron'\)\.net\.request\(\{ \.\.\.o, session: ses \}\)/);
  assert.match(pr, /fetch: \(u, init\) => hopFetch\(request, u, init\)/);
  assert.doesNotMatch(pr, /ses\.fetch\(|net\.fetch/);
  assert.match(fn('runApp'), /if \(r\.ok && !r\.newHost\) sv = saveServer\(/);
  assert.match(fn('firstLaunch'), /showWelcome\([^)]*\);[\s\S]*if \(pre\.result\) verified = verifiedFrom\(pre\.result\);/);
  assert.match(main, /verified = verifiedFrom\(r\);/);
  // One way to name a host for pins everywhere.
  assert.match(fn('serverHostname'), /originHost\(server\.origin\)/);
  assert.match(fn('forgetServer'), /const host = originHost\(sv\.origin\);/);
  assert.match(main, /trust: \(host, fingerprint, replace\) => \{\s*const h = pinHost\(host\);/);
});

// ---------------------------------------------------------------- welcome.html, run for real in a fake DOM
/** welcome.html's own script against a minimal DOM; `clock` drives Date.now(), `timers` collects setTimeout. */
function welcomePage(info) {
  const html = read('src/welcome.html');
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const els = new Map();
  const classes = () => { const s = new Set(); return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c), toggle: (c, on) => ((on ?? !s.has(c)) ? s.add(c) : s.delete(c)) }; };
  const el = (id) => {
    if (!els.has(id)) els.set(id, { id, hidden: false, textContent: '', value: '', disabled: false, className: '', dataset: {}, classList: classes(), focus() {} });
    return els.get(id);
  };
  const page = { clock: 1_000_000, timers: [], calls: [] };
  class FakeDate extends Date { static now() { return page.clock; } }
  const shell = {
    lang: 'en',
    strings: async () => ({}),
    welcome: {
      info: async () => info,
      trust: async (...a) => { page.calls.push(['trust', ...a]); return { ok: true }; },
      use: async () => { page.calls.push(['use']); return { ok: true }; },
      retry: () => { page.calls.push(['retry']); },
      connect: async () => ({ ok: false, error: 'busy' }), cancel: () => {}, local: () => {},
    },
  };
  const document = { getElementById: el, querySelectorAll: () => [], documentElement: { lang: '', dir: '' } };
  vm.runInNewContext(script, { window: { uchiyomiShell: shell }, document, URL, Date: FakeDate, setTimeout: (f, ms) => { page.timers.push({ f, ms }); }, console, String, Object });
  page.el = el;
  return page;
}
const settle = () => new Promise((r) => setImmediate(r));

test('the changed-certificate warning: one double-click only ARMS the replacement; a separate click confirms', async () => {
  // Reintroduce by removing the armedAt check (`e.detail > 1 || Date.now() - armedAt < 600`) from the #replace
  // handler: the double-click's second click event confirms, and the pin is replaced.
  const p = welcomePage({ from: 'server', step: 'cert', cert: { host: 'manga.example.lan', fingerprint: FP, changed: true, pinned: OTHER } });
  await settle(); await settle();
  const replace = p.el('replace');
  assert.equal(replace.hidden, false, 'the warning offers the replacement');
  assert.equal(p.el('trust').hidden, true, 'and no one-click trust');
  replace.onclick({ detail: 1 });
  p.clock += 30;
  replace.onclick({ detail: 2 });
  await settle();
  assert.deepEqual(p.calls, [], 'one double-click replaced the pin');
  assert.equal(replace.classList.contains('armed'), true);
  p.clock += 2000;
  replace.onclick({ detail: 1 });
  await settle();
  assert.deepEqual(p.calls[0], ['trust', 'manga.example.lan', FP, true], 'a second, separate click does');
});

test('the warning for a server this computer trusted before offers no way to trust the new certificate', async () => {
  // Reintroduce by leaving `|| os` out of `$('replace').hidden = !changed || os`: the two clicks re-pin a
  // server that went from a trusted certificate to a self-signed one.
  const p = welcomePage({ from: 'server', step: 'cert', cert: { host: 'manga.example.com', fingerprint: FP, changed: true, pinned: 'os' } });
  await settle(); await settle();
  assert.equal(p.el('replace').hidden, true);
  assert.equal(p.el('trust').hidden, true);
  assert.equal(p.el('cBefore').textContent, 'cert.beforeOs', '"Trusted before" says a certificate this computer trusts, not "os"');
  assert.equal(p.el('certBody').textContent, 'cert.osBody');
});

test('Connect: sent on to another host waits for Continue; the same host (http -> https) goes on by itself', async () => {
  // Reintroduce by dropping the `if (r.newHost)` branch from onResult: welcome:use is scheduled and saves the
  // other host with nobody asked.
  const moved = welcomePage({ from: 'first', step: 'address', address: 'http://192.168.1.10:8080', result: { ok: true, name: 'Home', origin: 'https://elsewhere.example', host: 'elsewhere.example', redirectedFrom: 'http://192.168.1.10:8080', newHost: true } });
  await settle(); await settle();
  assert.equal(moved.timers.length, 0, 'nothing scheduled: no automatic save');
  assert.equal(moved.el('portalGo').hidden, false, 'Continue is offered');
  assert.equal(moved.el('moved').hidden, false);
  assert.equal(moved.el('moved').textContent, 'welcome.moved');
  assert.equal(moved.el('connected').textContent, 'welcome.connectedAt', 'says where it ended');
  const upgraded = welcomePage({ from: 'first', step: 'address', address: 'http://manga.example.com', result: { ok: true, name: 'Home', origin: 'https://manga.example.com', host: 'manga.example.com', redirectedFrom: 'http://manga.example.com' } });
  await settle(); await settle();
  assert.equal(upgraded.timers.length, 1);
  assert.equal(upgraded.el('moved').hidden, true);
  upgraded.timers[0].f();
  await settle();
  assert.deepEqual(upgraded.calls, [['use']]);
});
