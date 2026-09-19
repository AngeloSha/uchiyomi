// The engine-origin exemption in the cover proxy does not follow redirects. Proven, not described.
//
// The exemption trusts ONE origin -- the configured extension engine -- and skips the SSRF guard for it. Its
// own comment said "redirects are not followed here", and for two releases that was a sentence rather than
// a fact: the fetch used the default, which follows. So a 302 from the engine to a private address would
// have been followed, un-guarded, and the body returned as a cover. CodeQL flagged the line as request
// forgery; it cannot see the origin check, but it did prompt the re-read that caught the comment lying.
//
// A real HTTP server on loopback, a real redirect, the real fetch. A mock that "returns a 302" would only
// prove the mock was consulted.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

process.env.DATABASE_URL = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || 'postgres://x:x@127.0.0.1:1/x';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';

let engine: Server;
let engineUrl = '';
let hits: string[] = [];
const COVER = '/api/v1/manga/1/thumbnail';
const REDIRECTING = '/api/v1/manga/2/thumbnail';
let fetchCoverImage: typeof import('../src/routes/images').fetchCoverImage;

before(async () => {
  engine = createServer((req, res) => {
    hits.push(req.url || '');
    // ⚠️ Thumbnail-shaped paths, because since v0.37.0 the exemption is the engine's `/api/v1/manga/<id>/thumbnail`
    // and nothing else on the origin (coverProxy.test.ts); a `/redirect` here would be refused before any fetch.
    if (req.url === REDIRECTING) { res.writeHead(302, { location: `${engineUrl}/private` }); res.end(); return; }
    if (req.url === '/private') { res.writeHead(200, { 'content-type': 'image/png' }); res.end('SHOULD NEVER BE SERVED'); return; }
    res.writeHead(200, { 'content-type': 'image/png' }); res.end('ok-cover');
  });
  await new Promise<void>((r) => engine.listen(0, '127.0.0.1', r));
  const port = (engine.address() as { port: number }).port;
  engineUrl = `http://127.0.0.1:${port}`;
  // ⚠️ Set BEFORE the module loads: env.ts parses process.env once at import.
  process.env.SUWAYOMI_URL = engineUrl;
  ({ fetchCoverImage } = await import('../src/routes/images'));
});
after(async () => { await new Promise<void>((r) => engine.close(() => r())); });

test('a direct 200 from the engine origin is fetched', async () => {
  hits = [];
  const buf = await fetchCoverImage(`${engineUrl}${COVER}`);
  assert.equal(buf.toString(), 'ok-cover');
  assert.deepEqual(hits, [COVER]);
});

test('A REDIRECT FROM THE ENGINE ORIGIN IS REFUSED, not followed', async () => {
  // Reintroduce by removing `redirect: 'error'` from the engine-origin fetch: the second hit below appears,
  // the body is "SHOULD NEVER BE SERVED", and this test fails on both counts.
  hits = [];
  await assert.rejects(fetchCoverImage(`${engineUrl}${REDIRECTING}`), (e: any) => e?.statusCode === 502,
    'a redirect must surface as a 502, the same as any other non-2xx from the engine');
  assert.deepEqual(hits, [REDIRECTING], `the redirect target must never be requested; hits were ${JSON.stringify(hits)}`);
});

test('A NON-THUMBNAIL PATH ON THE ENGINE ORIGIN IS NEVER REQUESTED, with or without credentials', async () => {
  // Reintroduce by deciding the un-guarded fetch on `isEngineOrigin(u)` alone: `/api/v1/extension/list` is
  // requested from the engine (with its Basic credentials, in production) and `hits` is no longer empty.
  // Here the engine is on loopback, so once the exemption declines, the ordinary guard refuses the address
  // before any socket opens -- which is exactly the point: the path is judged before the network is touched.
  hits = [];
  await assert.rejects(fetchCoverImage(`${engineUrl}/api/v1/extension/list`), (e: any) => e?.statusCode === 400,
    'an engine path that is not a thumbnail is an unfetchable cover, not an engine fetch');
  assert.deepEqual(hits, [], `the engine must not be asked for it at all; hits were ${JSON.stringify(hits)}`);
});
