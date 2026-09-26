// Node's own fetch still reads a compressed answer once the `undici` package is loaded.
//
// Every built-in source, MangaDex first, calls the global `fetch`. That fetch is Node's bundled copy of undici,
// but it sends through whatever dispatcher sits at `Symbol.for('undici.globalDispatcher.1')` -- and the undici
// PACKAGE, which komga.ts and notify/send.ts import in every bff process, puts its own there. So the package's
// version decides how the sources' requests go out, while the package itself never appears in their code.
//
// undici 8.11.0 (Dependabot #96, 2026-09-25) kept HTTP/2 for requests from that older caller (nodejs/undici#5811),
// and on HTTP/2 the answer reached Node's fetch without its `content-encoding`: MangaDex's gzip body came back
// as raw bytes and `r.json()` threw. Nothing but the desktop app's MangaDex smoke saw it, as "latest answered
// 200 with 0 candidates" -- the same line a rate-limited runner prints, which is how it nearly got re-run
// and merged. Here it is local: an HTTPS server that offers HTTP/2 as MangaDex does, and gzips its answer.
// undici 8.11.2 passes it (and MangaDex answers again), so v0.48.0 takes that instead of #96's 8.11.0; the test
// stays, because the next minor can bring the same break back.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http2 from 'node:http2';
import tls from 'node:tls';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';

/** A certificate needs openssl; the CI runner has it, so there a missing openssl is a failure, not a skip. */
function haveOpenssl(): boolean {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const skip = haveOpenssl() || process.env.CI ? false : 'openssl is not installed';

let dir = '';
let server: http2.Http2SecureServer | null = null;
let origin = '';
const versions: string[] = [];

before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), 'uchiyomi-fetch-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  // HTTP/2 offered, HTTP/1.1 allowed: what api.mangadex.org's TLS answers with.
  server = http2.createSecureServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')), allowHTTP1: true },
    (req, res) => {
      versions.push(req.httpVersion);
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(zlib.gzipSync(JSON.stringify({ result: 'ok', data: [1, 2, 3] })));
    });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  origin = `https://localhost:${(server.address() as AddressInfo).port}`;
  // Trusted, not waved through: the certificate joins this process's default CA store, which is what the
  // global fetch verifies against. Each test file runs in its own process, so nothing else ever trusts it.
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), readFileSync(join(dir, 'cert.pem'), 'utf8')]);
});

after(async () => {
  server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('the global fetch decodes a gzipped answer over HTTPS, with the undici package loaded as the app loads it', { skip }, async () => {
  // Loaded, not used: what komga.ts / notify/send.ts do. Reintroduce with undici 8.11.0 in bff/node_modules:
  // the body arrives still gzipped and this fails on the JSON.
  await import('undici');
  const r = await fetch(`${origin}/manga`);
  assert.equal(r.status, 200);
  const text = await r.text();
  let body: unknown;
  assert.doesNotThrow(() => { body = JSON.parse(text); },
    `the answer reached the sources still compressed (over HTTP ${versions.at(-1)}): ${JSON.stringify(text.slice(0, 16))}`);
  assert.deepEqual(body, { result: 'ok', data: [1, 2, 3] });
  assert.equal(r.headers.get('content-encoding'), 'gzip', 'the content-encoding header was lost on the way to fetch');
});
