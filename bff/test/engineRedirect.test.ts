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
let fetchCoverImage: typeof import('../src/routes/images').fetchCoverImage;

before(async () => {
  engine = createServer((req, res) => {
    hits.push(req.url || '');
    if (req.url === '/redirect') { res.writeHead(302, { location: `${engineUrl}/private` }); res.end(); return; }
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
  const buf = await fetchCoverImage(`${engineUrl}/cover.png`);
  assert.equal(buf.toString(), 'ok-cover');
  assert.deepEqual(hits, ['/cover.png']);
});

test('A REDIRECT FROM THE ENGINE ORIGIN IS REFUSED, not followed', async () => {
  // Reintroduce by removing `redirect: 'error'` from the engine-origin fetch: the second hit below appears,
  // the body is "SHOULD NEVER BE SERVED", and this test fails on both counts.
  hits = [];
  await assert.rejects(fetchCoverImage(`${engineUrl}/redirect`), (e: any) => e?.statusCode === 502,
    'a redirect must surface as a 502, the same as any other non-2xx from the engine');
  assert.deepEqual(hits, ['/redirect'], `the redirect target must never be requested; hits were ${JSON.stringify(hits)}`);
});
