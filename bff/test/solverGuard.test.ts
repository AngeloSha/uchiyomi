// Every URL the Cloudflare solver is asked to open is a public http(s) host (lib/sources/flaresolverr.ts assertSolvable,
// v0.69.1). The solver is a browser on the Docker network beside the engine and the database; the URLs came from a
// site's own HTML (a chapter link, a page image) and reached it with no check, so a site could walk it into the network.
// A fake solver on loopback counts what it is asked. No database.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';

let solver: Server;
const asked: string[] = [];

before(async () => {
  solver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const b = JSON.parse(body || '{}');
      asked.push(b.url);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', message: '', solution: { url: b.url, status: 200, response: '<html>ok</html>', cookies: [], userAgent: 'UA' } }));
    });
  });
  await new Promise<void>((go) => solver.listen(0, '127.0.0.1', go));
  process.env.FLARESOLVERR_URL = `http://127.0.0.1:${(solver.address() as AddressInfo).port}`;
  delete process.env.FLARESOLVERR_FALLBACK_URL;
  process.env.FAKE_SOURCE_URLS = 'fake-cf=http://127.0.0.1:18150';
});
after(async () => { await new Promise((r) => solver.close(r)); });

test('a private or local URL never reaches the solver', async () => {
  // Reintroduce by removing assertSolvable from solve(): the solver is asked for every one of these.
  const { cfGet } = await import('../src/lib/sources/flaresolverr');
  asked.length = 0;
  for (const u of ['http://10.0.0.5/admin', 'http://127.0.0.1:4567/api/graphql', 'http://localhost/x', 'http://yomi-db:5432/',
    'http://169.254.169.254/latest/meta-data/', 'file:///etc/passwd']) {
    await assert.rejects(cfGet(u), `${u} was not refused`);
  }
  assert.deepEqual(asked, []);
});

test('a public site still is solved, and so is the e2e fake source', async () => {
  const { cfGet } = await import('../src/lib/sources/flaresolverr');
  asked.length = 0;
  assert.equal(await cfGet('https://93.184.216.34/manga/a/'), '<html>ok</html>');
  assert.equal(await cfGet('http://127.0.0.1:18150/series/a'), '<html>ok</html>', 'FAKE_SOURCE_URLS names it');
  assert.deepEqual(asked, ['https://93.184.216.34/manga/a/', 'http://127.0.0.1:18150/series/a']);
});
