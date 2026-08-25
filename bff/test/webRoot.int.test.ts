// Serving the web app from the API process.
//
// The single-container build mounts the static export on the same Fastify instance that serves the API, so
// two things have to hold or it is worse than the nginx it replaces:
//
//   1. AN API ROUTE ALWAYS WINS. A static file that happens to sit at /api/... must never shadow a route,
//      and a 404 under /api must come back as JSON rather than the app shell -- a client that asked for
//      JSON and got HTML fails in a much more confusing way than a clean 404.
//   2. The cache headers move with it. nginx was doing real work here: the service worker and the manifest
//      must never be cached, or an installed PWA pins itself to an old build and stops updating, which
//      reads to the user as "the app is broken" rather than "your browser kept a file".
//
// The SPA fallback is the third: Next's export writes /library/index.html for the route /library, and nginx
// reached it by 301-ing to add a trailing slash -- which is what dropped the port on every deep link. This
// resolves it in-process instead, so there is no redirect to get wrong.
//
// Pure unit tests: no database, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.DATABASE_URL = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL
  || 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';

async function buildExport(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'uchiyomi-web-'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>shell</title>');
  await writeFile(join(root, 'sw.js'), '// service worker');
  await writeFile(join(root, 'manifest.webmanifest'), '{"name":"Uchiyomi"}');
  await mkdir(join(root, '_next/static/chunks'), { recursive: true });
  await writeFile(join(root, '_next/static/chunks/app.js'), 'console.log(1)');
  // Two sizes on purpose: compression has a 1 KB threshold, so a fixture that only has tiny files would
  // let a broken registration pass. This one is ~8 KB and highly compressible, like a real chunk.
  await writeFile(join(root, '_next/static/chunks/big.js'), `// ${'x'.repeat(8000)}\n`);
  await mkdir(join(root, 'icons'), { recursive: true });
  await writeFile(join(root, 'icons/icon.png'), 'png');
  await mkdir(join(root, 'library'), { recursive: true });
  await writeFile(join(root, 'library/index.html'), '<!doctype html><title>library</title>');
  await writeFile(join(root, 'about.html'), '<!doctype html><title>about</title>');
  // The trap: a file that would shadow an API route if static were mounted first.
  await mkdir(join(root, 'api'), { recursive: true });
  await writeFile(join(root, 'api/setup'), 'STATIC FILE THAT MUST NEVER WIN');
  return root;
}

async function makeApp(root: string) {
  // WEB_ROOT is read when registerWebRoot runs, not when the module loads, so one plain import serves both
  // the configured and the unset case. The previous cache-busting import worked on Node 18 and returned a
  // module with no exports on Node 22, which CI caught and a local run did not.
  process.env.WEB_ROOT = root;
  const mod = await import('../src/lib/webRoot');
  const Fastify = (await import('fastify')).default;
  const app = Fastify();
  // Stand in for the real routes: same shape, same registration order (API first, web root last).
  app.get('/api/setup/status', async () => ({ needsSetup: true }));
  app.post('/api/setup', async () => ({ ok: true }));
  app.get('/healthz', async () => ({ ok: true }));
  await mod.registerWebRoot(app);
  await app.ready();
  return app;
}

/** The same instance, plus compression registered exactly as src/server.ts registers it. */
async function makeCompressedApp(root: string) {
  process.env.WEB_ROOT = root;
  const mod = await import('../src/lib/webRoot');
  const Fastify = (await import('fastify')).default;
  const compress = (await import('@fastify/compress')).default;
  const app = Fastify();
  await app.register(compress, { threshold: 1024, encodings: ['br', 'gzip', 'deflate'] });
  await mod.registerWebRoot(app);
  await app.ready();
  return app;
}

test('the static export is compressed, as nginx compressed it', async (t) => {
  // nginx gzipped CSS, JS, JSON, SVG and the manifest above 1 KB (web/nginx.conf:30-32). The single
  // container has no nginx, so without this the app ships 736 KB of JS and CSS where the split layout
  // shipped 261 KB -- measured against the live site, not estimated.
  const root = await buildExport();
  const app = await makeCompressedApp(root);
  try {
    await t.test('a chunk over the threshold comes back compressed, and says so', async () => {
      const r = await app.inject({
        method: 'GET', url: '/_next/static/chunks/big.js',
        headers: { 'accept-encoding': 'gzip' },
      });
      assert.equal(r.statusCode, 200);
      assert.equal(r.headers['content-encoding'], 'gzip', 'a large JS chunk was served uncompressed');
      // nginx ran `gzip on` with no `gzip_vary`, so it never sent this -- a shared cache in front of it
      // could hand a gzipped body to a client that never asked. Parity would have kept the hazard.
      assert.match(String(r.headers.vary ?? ''), /accept-encoding/i, 'no Vary: Accept-Encoding');
    });

    await t.test('a client that cannot decompress still gets plain bytes', async () => {
      const r = await app.inject({
        method: 'GET', url: '/_next/static/chunks/big.js',
        headers: { 'accept-encoding': 'identity' },
      });
      assert.equal(r.statusCode, 200);
      assert.equal(r.headers['content-encoding'], undefined);
      assert.ok(r.body.length > 8000, 'the identity response should be the full file');
    });

    await t.test('the 1 KB threshold does NOT apply to static files, and that is fine', async () => {
      // Worth pinning because it is surprising and I got it wrong first: @fastify/static streams, so there
      // is no Content-Length for @fastify/compress to compare the threshold against, and it compresses
      // regardless of size. nginx's `gzip_min_length 1024` did skip small files. A 14-byte chunk comes back
      // as 34 bytes of gzip framing -- worse than sending it raw, and completely immaterial.
      //
      // The threshold is not pointless: buffered JSON replies DO carry a Content-Length, so it still keeps
      // small API responses uncompressed. This asserts the real behaviour so nobody "fixes" a passing test
      // into a false one later.
      const r = await app.inject({
        method: 'GET', url: '/_next/static/chunks/app.js',
        headers: { 'accept-encoding': 'gzip' },
      });
      assert.equal(r.statusCode, 200);
      assert.equal(r.headers['content-length'], undefined, 'static is streamed; if this ever gains a length, the threshold starts applying');
      assert.equal(r.headers['content-encoding'], 'gzip');
    });

    await t.test('the cache-control contract survives compression', async () => {
      // Compression sits in front of the static handler, so it is a plausible place for the headers that
      // keep a PWA from pinning itself to an old build to get lost.
      const sw = await app.inject({ method: 'GET', url: '/sw.js', headers: { 'accept-encoding': 'gzip' } });
      assert.match(String(sw.headers['cache-control']), /no-store|no-cache/);
      const chunk = await app.inject({
        method: 'GET', url: '/_next/static/chunks/big.js', headers: { 'accept-encoding': 'gzip' },
      });
      assert.match(String(chunk.headers['cache-control']), /immutable/);
    });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the web app served from the API process', async (t) => {
  const root = await buildExport();
  const app = await makeApp(root);

  try {
    await t.test('THE RULE: an API route beats a static file at the same path', async () => {
      const r = await app.inject({ method: 'GET', url: '/api/setup/status' });
      assert.equal(r.statusCode, 200);
      assert.deepEqual(r.json(), { needsSetup: true });

      const p = await app.inject({ method: 'POST', url: '/api/setup' });
      assert.equal(p.statusCode, 200, 'a real route must answer, not the file sitting at that path');
      assert.deepEqual(p.json(), { ok: true });
      assert.ok(!p.body.includes('MUST NEVER WIN'), 'a static file shadowed an API route');
    });

    await t.test('an unknown API path is JSON, not the app shell', async () => {
      const r = await app.inject({ method: 'GET', url: '/api/nope' });
      assert.equal(r.statusCode, 404);
      assert.equal(r.json().error, 'not_found');
      assert.ok(!/<!doctype/i.test(r.body), 'an API 404 returned HTML, which breaks every JSON client');
      for (const prefix of ['/auth/nope', '/img/nope', '/opds/nope']) {
        const x = await app.inject({ method: 'GET', url: prefix });
        assert.ok(!/<!doctype/i.test(x.body), `${prefix} fell through to the app shell`);
      }
    });

    await t.test('the app is served at the root', async () => {
      const r = await app.inject({ method: 'GET', url: '/' });
      assert.equal(r.statusCode, 200);
      assert.match(r.body, /<title>shell<\/title>/);
    });

    await t.test('THE REDIRECT THAT WAS: a deep link resolves without one', async () => {
      // nginx answered this with 301 -> /library/, built from its own port, which is what broke every
      // bookmark on the documented default of 8080.
      const r = await app.inject({ method: 'GET', url: '/library' });
      assert.equal(r.statusCode, 200, `expected the page, got ${r.statusCode} ${r.headers.location ?? ''}`);
      assert.match(r.body, /<title>library<\/title>/, 'should serve library/index.html, not the shell');
      assert.equal(r.headers.location, undefined, 'there should be no redirect at all');

      const slash = await app.inject({ method: 'GET', url: '/library/' });
      assert.equal(slash.statusCode, 200, 'the trailing-slash form must work too');
    });

    await t.test('a .html sibling resolves, and an unknown route falls back to the shell', async () => {
      const a = await app.inject({ method: 'GET', url: '/about' });
      assert.equal(a.statusCode, 200);
      assert.match(a.body, /<title>about<\/title>/);

      const client = await app.inject({ method: 'GET', url: '/series/some-client-side-route' });
      assert.equal(client.statusCode, 200, 'client-side routes must reach the shell');
      assert.match(client.body, /<title>shell<\/title>/);
    });

    await t.test('cache headers match what nginx sent, rule for rule', async () => {
      const cc = async (url: string) => (await app.inject({ method: 'GET', url })).headers['cache-control'];
      assert.equal(await cc('/sw.js'), 'no-cache, no-store, must-revalidate',
        'a cached service worker pins an installed PWA to an old build');
      assert.equal(await cc('/manifest.webmanifest'), 'no-cache');
      assert.equal(await cc('/_next/static/chunks/app.js'), 'public, max-age=31536000, immutable');
      assert.equal(await cc('/icons/icon.png'), 'public, max-age=604800');
      assert.equal(await cc('/'), 'no-cache');
    });

    await t.test('the manifest keeps its content type', async () => {
      const r = await app.inject({ method: 'GET', url: '/manifest.webmanifest' });
      assert.match(String(r.headers['content-type']), /application\/manifest\+json/,
        'browsers ignore a manifest served as the wrong type, and the PWA stops being installable');
    });

    await t.test('a write to an unknown path is not answered with a page', async () => {
      const r = await app.inject({ method: 'POST', url: '/whatever' });
      assert.equal(r.statusCode, 404);
      assert.ok(!/<!doctype/i.test(r.body));
    });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
    delete process.env.WEB_ROOT;
  }
});

test('with WEB_ROOT unset the API is unchanged', async () => {
  // The two-container setup has to keep behaving exactly as it did, so this is the no-op case.
  delete process.env.WEB_ROOT;
  const mod = await import('../src/lib/webRoot');
  const Fastify = (await import('fastify')).default;
  const app = Fastify();
  app.get('/api/setup/status', async () => ({ needsSetup: true }));
  await mod.registerWebRoot(app);
  await app.ready();
  try {
    assert.equal(mod.webRootConfigured(), false, 'no WEB_ROOT means nothing is mounted');
    const r = await app.inject({ method: 'GET', url: '/' });
    assert.equal(r.statusCode, 404, 'the API alone must not start answering for the web app');
    const ok = await app.inject({ method: 'GET', url: '/api/setup/status' });
    assert.equal(ok.statusCode, 200);
  } finally {
    await app.close();
  }
});
