// The Cloudflare solver's queue (v0.59.0, lib/sources/flaresolverr.ts): one solve per origin however many ask at once,
// and a queued solve whose caller stopped waiting is never started. Against a fake solver speaking FlareSolverr's /v1
// over real HTTP, with one slot (SOLVER_CONCURRENCY=1), as solverBackup.test.ts fakes it.
//
// From the audit of the owner's live server: a wall of covers from one CDN started a solve per cover (and then another
// per image URL) -- ~89 solves, all failed, each holding a slot -- and Discover's listings, queued behind them, timed
// out at 15 s and were solved minutes later for nobody.
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.DATABASE_URL = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || 'postgres://x:x@127.0.0.1:1/x';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
process.env.SOLVER_CONCURRENCY = '1';
delete process.env.FLARESOLVERR_FALLBACK_URL;

const asked: string[] = [];
let srv: Server;
let fs: typeof import('../src/lib/sources/flaresolverr');

before(async () => {
  srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { url } = JSON.parse(body || '{}');
      asked.push(String(url));
      // A slow page holds the one slot; everything answers with a solved page and a clearance cookie.
      const wait = /slow/.test(String(url)) ? 400 : 60;
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', message: '', solution: { url, status: 200, response: '<html>ok</html>', cookies: [{ name: 'cf_clearance', value: 'x' }], userAgent: 'UA' } }));
      }, wait);
    });
  });
  await new Promise<void>((go) => srv.listen(0, '127.0.0.1', go));
  process.env.FLARESOLVERR_URL = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  fs = await import('../src/lib/sources/flaresolverr');
});
after(() => { srv.close(); });
beforeEach(() => { asked.length = 0; fs.resetSolverSessions(); });

test('one origin is solved once however many ask at once', async () => {
  const all = await Promise.all(Array.from({ length: 8 }, (_, i) => fs.cfSession(`https://cdn.queue-test.example/covers/${i}.jpg`, { solveUrl: false })));
  // Reintroduce a solve per caller (drop the `solving` map): eight root solves.
  assert.deepEqual(asked, ['https://cdn.queue-test.example/'], 'the root, once');
  assert.ok(all.every((s) => /cf_clearance=x/.test(s.cookie)), 'every caller got the one session');
});

test('a queued solve whose caller gave up is never started', async () => {
  const first = fs.cfGet('https://a.queue-test.example/slow');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fs._solverQueue().inFlight, 1, 'PREMISE: the one slot is taken');
  const t0 = Date.now();
  // Reintroduce queueing without the deadline: this waits for the slot, is solved, and the record holds b.
  await assert.rejects(fs.withSolverDeadline(100, () => fs.cfGet('https://b.queue-test.example/page')), /stopped waiting/);
  assert.ok(Date.now() - t0 < 350, 'dropped at its deadline, not when the slot freed');
  await first;
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(asked, ['https://a.queue-test.example/slow'], 'b was never solved');
  assert.deepEqual(fs._solverQueue(), { inFlight: 0, waiting: 0 });
});

test('a dropped solve is our own timeout, and does not mark its origin unsolvable', async () => {
  // The drop fires at the caller's own deadline, a moment before its withTimeout would: it must read as that timeout
  // (selfTimeout), which discoverSources.int.test.ts pins at the route. And it never reached the site, so the next
  // caller for that origin still asks. Reintroduce marking it unsolvable: the second cfSession gets no session, unasked.
  const first = fs.cfGet('https://f.queue-test.example/slow');
  await new Promise((r) => setTimeout(r, 20));
  const err: any = await fs.withSolverDeadline(100, () => fs.cfGet('https://g.queue-test.example/page')).then(() => null, (e) => e);
  assert.equal(err?.selfTimeout, true, 'read as the caller\'s own timeout');
  const dropped = await fs.withSolverDeadline(100, () => fs.cfSession('https://h.queue-test.example/c.jpg', { solveUrl: false }));
  assert.equal(dropped.cookie, '', 'PREMISE: dropped, no session');
  await first;
  const next = await fs.cfSession('https://h.queue-test.example/c.jpg', { solveUrl: false });
  assert.match(next.cookie, /cf_clearance=x/, 'the next caller still asks, and gets one');
  assert.deepEqual(asked, ['https://f.queue-test.example/slow', 'https://h.queue-test.example/']);
});

test('a caller with time left is served as before', async () => {
  const first = fs.cfGet('https://c.queue-test.example/slow');
  const second = fs.withSolverDeadline(5000, () => fs.cfGet('https://d.queue-test.example/page'));
  assert.equal(await second, '<html>ok</html>');
  await first;
  assert.deepEqual(asked, ['https://c.queue-test.example/slow', 'https://d.queue-test.example/page']);
});
