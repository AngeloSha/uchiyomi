// The sign-in handshake's shell half (contract 2): the secret, and the one request that carries it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { newSecret, isExchange, headersFor, ShellSession, HEADER } = require('../src/signin.js');

test('the secret: 256 bits, base64url, fresh every time', () => {
  // Reintroduce by drawing 16 bytes: 22 characters, under the bff's 32-character floor.
  const a = newSecret();
  const b = newSecret();
  assert.equal(a.length, 43);
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
});

test('the header rides on exactly POST http://127.0.0.1:<port>/auth/desktop and on nothing else', () => {
  // Reintroduce by matching with startsWith (or ignoring the method, or the host): one of the near-misses
  // below receives the secret.
  const port = 40000;
  const secret = newSecret();
  const got = (method, url) => headersFor({ method, url, requestHeaders: { Accept: '*/*' } }, port, secret)[HEADER];
  assert.equal(got('POST', 'http://127.0.0.1:40000/auth/desktop'), secret);
  const nearMisses = [
    ['GET', 'http://127.0.0.1:40000/auth/desktop'],
    ['POST', 'http://127.0.0.1:40000/auth/desktop?next=1'],
    ['POST', 'http://127.0.0.1:40000/auth/desktop/'],
    ['POST', 'http://127.0.0.1:40000/auth/desktopx'],
    ['POST', 'http://127.0.0.1:40000/auth/refresh'],
    ['POST', 'http://127.0.0.1:40001/auth/desktop'],
    ['POST', 'http://localhost:40000/auth/desktop'],
    ['POST', 'https://127.0.0.1:40000/auth/desktop'],
    ['POST', 'http://evil.test/auth/desktop'],
    ['POST', 'http://127.0.0.1:40000/api/x/../../auth/desktop'],
  ];
  for (const [m, u] of nearMisses) assert.equal(got(m, u), undefined, `${m} ${u} must not carry the secret`);
  assert.equal(isExchange({ method: 'POST', url: 'http://127.0.0.1:40000/auth/desktop' }, 0), false, 'no port yet: nothing matches');
});

test("a page-set X-Uchiyomi-Desktop is stripped, and the exchange carries the shell's value, not the page's", () => {
  // Reintroduce by dropping the delete loop in headersFor: the forged header rides along.
  const port = 40000;
  const secret = newSecret();
  const other = headersFor({ method: 'POST', url: 'http://127.0.0.1:40000/api/x', requestHeaders: { 'x-uchiyomi-desktop': 'forged' } }, port, secret);
  assert.deepEqual(Object.keys(other).filter((k) => k.toLowerCase() === 'x-uchiyomi-desktop'), []);
  const ex = headersFor({ method: 'POST', url: 'http://127.0.0.1:40000/auth/desktop', requestHeaders: { 'X-UCHIYOMI-DESKTOP': 'forged' } }, port, secret);
  assert.deepEqual(Object.entries(ex).filter(([k]) => k.toLowerCase() === 'x-uchiyomi-desktop'), [[HEADER, secret]]);
});

test("the shell's own session: one exchange, reused, and a new one after a 401", async () => {
  // Reintroduce by dropping the 401 retry in ShellSession.fetch: the tray check fails after a restore.
  const secret = newSecret();
  let exchanges = 0;
  let expireNext = false;
  const srv = http.createServer((req, res) => {
    if (req.url === '/auth/desktop' && req.method === 'POST') {
      if (req.headers['x-uchiyomi-desktop'] !== secret) { res.writeHead(401); return res.end(); }
      exchanges++;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ accessToken: `t${exchanges}` }));
    }
    if (req.url === '/api/admin/tasks/update/run') {
      if (expireNext && req.headers.authorization === 'Bearer t1') { res.writeHead(401); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, auth: req.headers.authorization }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const s = new ShellSession(() => port, secret);
    const a = await (await s.fetch('/api/admin/tasks/update/run', { method: 'POST' })).json();
    const b = await (await s.fetch('/api/admin/tasks/update/run', { method: 'POST' })).json();
    assert.equal(a.auth, 'Bearer t1');
    assert.equal(b.auth, 'Bearer t1');
    assert.equal(exchanges, 1, 'a burst of tray clicks is one sign-in');
    expireNext = true; // the bff restarted with a new JWT secret (a restore)
    const c = await (await s.fetch('/api/admin/tasks/update/run', { method: 'POST' })).json();
    assert.equal(c.auth, 'Bearer t2');
    const wrong = new ShellSession(() => port, newSecret());
    await assert.rejects(() => wrong.accessToken(), /refused/);
  } finally {
    srv.close();
  }
});
