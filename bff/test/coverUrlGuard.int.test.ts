// A cover value that is not a URL must produce a placeholder, not a 500.
//
// `/img/sources/cover?u=...` takes its URL from a query string, and the web client got one call's arguments
// the wrong way round -- `sourceCover(c.coverUrl, c.source)` against a `(source, u)` signature -- so the
// SOURCE ID arrived where the cover URL belongs. `fetchCoverImage` had no reason to doubt it and handed it
// straight to `new URL()` and `fetch()`, which is how the live server logged level-50 TypeErrors behind an
// `<img>`:
//
//   TypeError: Invalid URL ... "input":"mangakakalot"     -- a plain id: `new URL` throws outright
//   TypeError: fetch failed: unknown scheme               -- a Suwayomi id, `sw:8796296375202334266`:
//                                                            it PARSES, origin is the string "null", and
//                                                            undici rejects the scheme instead
//
// Two shapes, one cause, and a guard written against only the first would have let the second straight
// through -- so both are pinned here. The failure was never the reader's to fix and never retryable: the
// right answer is the same missing-cover tile they were going to see anyway.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  // Its own cache root, or a placeholder written here would be served to the live variant key and back.
  process.env.CACHE_DIR = process.env.CACHE_DIR || mkdtempSync(join(tmpdir(), 'uchiyomi-cover-cache-'));
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const USER = 'cover-guard-user';

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const imageRoutes = (await import('../src/routes/images')).default;
  const { IMG_COOKIE } = await import('../src/lib/auth');

  await migrate();
  await q(`DELETE FROM users WHERE username = $1`, [USER]);
  const u = await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind)
     VALUES ($1,$1,'x','user','password') RETURNING id`, [USER],
  );

  const app = Fastify();
  await app.register(cookie);
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(imageRoutes);
  await app.ready();

  // A browser <img> cannot send an Authorization header, so this route family authorizes by cookie.
  const imgCookie = `${IMG_COOKIE}=${app.jwt.sign({ sub: u[0].id, typ: 'img' })}`;
  return { app, q, imgCookie };
}

test('a cover value that is not a fetchable URL answers a placeholder, not a 500', { skip }, async (t) => {
  const { app, q, imgCookie } = await setup();
  try {
    // Both live failures, by the value that actually caused each one.
    for (const [u, why] of [
      ['mangakakalot', 'a plain source id -- new URL() throws ERR_INVALID_URL'],
      ['natomanga', 'the same, from the second custom site in the same dialog'],
      ['sw:8796296375202334266', 'a Suwayomi source id -- parses, then "fetch failed: unknown scheme"'],
      ['/relative/cover.jpg', 'a path with no origin'],
      ['ftp://example.invalid/cover.jpg', 'absolute, parseable, and not something we fetch'],
      // SSRF. These are http(s) and perfectly parseable -- the old guard checked the scheme and stopped.
      // They must be indistinguishable from every other unfetchable value above: same 200, same placeholder,
      // no timing difference from an actual connection attempt. A distinct status here would rebuild the
      // internal port scanner the guard exists to remove.
      ['http://127.0.0.1:5432/', 'loopback -- Postgres, on this very host'],
      ['http://169.254.169.254/latest/meta-data/', 'cloud metadata, the classic SSRF prize'],
      ['http://10.0.0.5/', 'RFC1918'],
      ['http://192.168.1.1/', 'the home router'],
      ['http://[::1]:4567/', 'loopback again, in IPv6 notation'],
      ['http://[::ffff:127.0.0.1]/', 'and again, wearing an IPv6 hat'],
      ['http://localhost:8191/', 'a name that means this machine'],
      ['http://db.internal/', 'a name that means this network'],
    ] as const) {
      await t.test(`${u} (${why})`, async () => {
        const r = await app.inject({
          method: 'GET',
          url: `/img/sources/cover?u=${encodeURIComponent(u)}`,
          headers: { cookie: imgCookie },
        });
        assert.equal(r.statusCode, 200, `expected a placeholder image, got ${r.statusCode} ${r.payload.slice(0, 120)}`);
        assert.equal(r.headers['content-type'], 'image/webp');
        // A real image, not an empty body dressed as one.
        assert.ok(r.rawPayload.length > 0, 'the placeholder had no bytes');
        assert.equal(r.rawPayload.subarray(0, 4).toString('latin1'), 'RIFF', 'not a webp');
      });
    }

    await t.test('the placeholder is a cover, not a stretched icon', async () => {
      const sharp = (await import('sharp')).default;
      const r = await app.inject({
        method: 'GET',
        url: '/img/sources/cover?u=mangakakalot&w=800',
        headers: { cookie: imgCookie },
      });
      const meta = await sharp(r.rawPayload).metadata();
      assert.equal(meta.width, 800, `asked for w=800, got ${meta.width}`);
      // 2:3 is the aspect every cover tile in the app is laid out at.
      assert.equal(meta.height, 1200, `expected a 2:3 tile, got ${meta.width}x${meta.height}`);
    });

    await t.test('a missing u is still a 400 -- the guard did not swallow the old check', async () => {
      const r = await app.inject({ method: 'GET', url: '/img/sources/cover', headers: { cookie: imgCookie } });
      assert.equal(r.statusCode, 400);
    });

    await t.test('and none of it is reachable without the image cookie', async () => {
      const r = await app.inject({ method: 'GET', url: '/img/sources/cover?u=mangakakalot' });
      assert.equal(r.statusCode, 401);
    });
  } finally {
    await app.close();
    await q(`DELETE FROM users WHERE username = $1`, [USER]).catch(() => {});
  }
});

// The predicate itself, so the two failure shapes are readable without a server. `fetchableCoverUrl` is the
// only thing standing between a bad value and `fetch()`, and "does new URL() survive it" is NOT the same
// question -- `sw:...` passes that one and still cannot be fetched.
// (`{ skip }` because importing the route module parses env, which requires DATABASE_URL.)
test('the upstream status is never reflected to the caller', { skip }, async () => {
  // Reaching the reflecting branch needs a real upstream that returns a real error, which a unit test has
  // no business arranging -- so this pins the source instead, the way downloadsVersion.test.ts pins the
  // IndexedDB version. Reintroduce by restoring `statusCode: r.status`: a 404 from an internal service
  // comes back as a 404, a refused port as a 500, and the difference between them is the scanner.
  const src = await readFile(new URL('../src/routes/images.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /statusCode:\s*r\.status/,
    'the cover fetch must not hand the caller the upstream status');
  assert.match(src, /statusCode:\s*502/, 'a failed upstream fetch should answer a flat 502');
  // And redirects must be walked by hand, or a public URL can bounce into the private range unchecked.
  const transport = await readFile(new URL('../src/lib/publicConnection.ts', import.meta.url), 'utf8');
  assert.match(src, /fetchPublicHop\(/, 'cover requests must use the guarded transport');
  assert.match(transport, /redirect:\s*'manual'/, "the cover fetch must not let fetch() follow redirects itself");
});

test('fetchableCoverUrl accepts http(s) and nothing else', { skip }, async () => {
  const { fetchableCoverUrl } = await import('../src/routes/images');

  for (const good of [
    'https://cdn.example.com/cover.jpg',
    'http://cdn.example.com/cover.jpg?w=400',
    'https://uploads.mangadex.org/covers/abc/def.jpg.512.jpg',
  ]) assert.ok(fetchableCoverUrl(good), `${good} should be fetchable`);

  for (const bad of [
    'mangakakalot', 'natomanga', 'aqua', 'mangadex',   // custom-site + built-in ids
    'sw:8796296375202334266',                          // a Suwayomi id: parses, unknown scheme
    'data:image/png;base64,AAAA', 'file:///etc/passwd', 'ftp://h/x.jpg',
    '//cdn.example.com/cover.jpg',                     // protocol-relative: no base, no origin
    '', null, undefined,
  ] as const) assert.equal(fetchableCoverUrl(bad), null, `${bad} should not be fetchable`);
  // Reintroduce by deleting the isBlockedHost() line in fetchableCoverUrl: every one of these becomes a
  // URL the server will happily go and fetch for whoever asked.
  for (const bad of [
    'http://127.0.0.1/x.jpg', 'http://169.254.169.254/', 'http://10.0.0.1/', 'http://[::1]/',
    'http://localhost/x.jpg', 'https://foo.localhost/x.jpg', 'http://nas.local/x.jpg',
  ] as const) assert.equal(fetchableCoverUrl(bad), null, `${bad} is not a public address`);
});

// ---------------------------------------------------------------------------------------------------
// The /img/ prefix guard, and the trap it closes.
//
// Image auth used to be a preHandler INSIDE imageRoutes. Fastify encapsulates hooks, so it protected only
// the routes that plugin registered -- and the way to serve unauthenticated image bytes was therefore to
// add a different plugin. A downstream fork did exactly that: an /img/stream/:sessionId/:pageIndex byte
// proxy, in its own plugin, with a preHandler that only guarded its /api/ half. It shipped wide open.
//
// server.ts now guards the whole prefix at the root, so a plugin that forgets auth INHERITS it instead of
// escaping it. This mounts a deliberately careless plugin to prove that.
test('a careless plugin cannot serve bytes under /img/ without auth', { skip }, async (t) => {
  process.env.DATABASE_URL = DSN;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const { authorizeImageRequest } = await import('../src/routes/images');

  const app = Fastify();
  await app.register(cookie);
  await app.register(jwt, { secret: process.env.JWT_SECRET! });

  // Exactly what server.ts does.
  // Reintroduce by deleting this hook: the rogue route below answers 200 with the bytes.
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/img/')) return;
    await authorizeImageRequest(app, req, reply);
  });

  // A plugin that serves image bytes and never thinks about auth.
  await app.register(async (scope) => {
    scope.get('/img/rogue/:id', async () => 'SECRET-BYTES');
    scope.get('/api/rogue', async () => ({ ok: true }));
  });
  await app.ready();

  try {
    await t.test('the rogue /img/ route is refused', async () => {
      const r = await app.inject({ method: 'GET', url: '/img/rogue/anything' });
      assert.equal(r.statusCode, 401, `a new plugin served image bytes unauthenticated: ${r.payload.slice(0, 80)}`);
      assert.doesNotMatch(r.payload, /SECRET-BYTES/, 'the handler ran anyway and its bytes escaped');
    });

    await t.test('the guard is scoped to /img/ and does not gate everything else', async () => {
      // A root hook that refused every route would "pass" the test above for the wrong reason.
      const r = await app.inject({ method: 'GET', url: '/api/rogue' });
      assert.equal(r.statusCode, 200, 'the prefix guard leaked outside /img/');
    });
  } finally {
    await app.close();
  }
});
