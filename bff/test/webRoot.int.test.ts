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
