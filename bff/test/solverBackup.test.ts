// A backup Cloudflare solver (v0.55.4, FLARESOLVERR_FALLBACK_URL), against fake solvers that speak FlareSolverr's /v1
// over real HTTP: one that fails in each way a solver fails, one at an address where nothing listens, and a backup.
//
// The owner runs trawl (#144) as the main solver and keeps FlareSolverr "just in case". A request the main does not
// answer with a page goes once, unchanged, to the backup; when both fail the caller hears what a solver said about the
// site, under the `flaresolverr:` prefix Health and the diagnosis read as "the solver".
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.DATABASE_URL = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || 'postgres://x:x@127.0.0.1:1/x';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';

const load = () => import('../src/lib/sources/flaresolverr');

/**
 * A solver that cannot be reached at all: a port that was listened on and closed, so the connection is refused (port 1
 * would not do: fetch refuses it as a "bad port" before connecting, which is not what a stopped container does).
 */
let NOWHERE = '';
before(async () => {
  const srv = createServer();
  await new Promise<void>((go) => srv.listen(0, '127.0.0.1', go));
  NOWHERE = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  await new Promise<void>((go) => srv.close(() => go()));
});

type Reply = { status?: number; json?: unknown; raw?: string; hang?: boolean };
interface Fake { url: string; asked: string[]; reply: (body: any) => Reply; close: () => Promise<void> }
const fakes: Fake[] = [];

/** A solver that records every request body it is sent and answers with `reply` (a page of its own name by default). */
async function fakeSolver(name: string): Promise<Fake> {
  const fake: Fake = { url: '', asked: [], reply: (b) => ({ json: solved(b.url, `<html>${name}</html>`) }), close: async () => {} };
  const held: Array<() => void> = [];
  const srv: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      fake.asked.push(body);
      const r = fake.reply(JSON.parse(body || '{}'));
      if (r.hang) { held.push(() => res.destroy()); return; }
      res.writeHead(r.status ?? 200, { 'content-type': r.raw !== undefined ? 'text/html' : 'application/json' });
      res.end(r.raw ?? JSON.stringify(r.json));
    });
  });
  await new Promise<void>((go) => srv.listen(0, '127.0.0.1', go));
  fake.url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  fake.close = () => new Promise<void>((go) => { for (const h of held) h(); srv.close(() => go()); });
  fakes.push(fake);
  return fake;
}

const solved = (url: string, html: string, extra: Record<string, unknown> = {}) => ({
  status: 'ok', message: '',
  solution: { url, status: 200, response: html, cookies: [{ name: 'cf_clearance', value: 'x' }], userAgent: 'UA', ...extra },
});
/** FlareSolverr's own error envelope: HTTP 500, its words in `message`. */
const refused = (message: string): Reply => ({ status: 500, json: { status: 'error', message, solution: null } });

const TIMEOUT = 'Error: Error solving the challenge. Timeout after 60.0 seconds.';
const BLOCKED = 'Error: Error solving the challenge. Cloudflare has blocked this request. Probably your IP is banned for this site, check in your web browser.';

/** The solvers this process asks, for the length of one test. */
function use(main: string, backup?: string): void {
  process.env.FLARESOLVERR_URL = main;
  if (backup === undefined) delete process.env.FLARESOLVERR_FALLBACK_URL;
  else process.env.FLARESOLVERR_FALLBACK_URL = backup;
}

beforeEach(async () => {
  (await load()).setSolverTiming({ attemptMs: 95_000 });
});
after(async () => {
  for (const f of fakes) await f.close();
  delete process.env.FLARESOLVERR_FALLBACK_URL;
});

test('a main that answers with an error: the same request goes to the backup, once, and its page is the answer', async () => {
  // Reintroduce by asking the main alone (solveNow's loop over `solvers()` cut to the first): this rejects with the
  // main's timeout instead.
  const { cfGet, cfPost } = await load();
  const main = await fakeSolver('main');
  const backup = await fakeSolver('backup');
  main.reply = () => refused(TIMEOUT);
  use(main.url, backup.url);

  assert.equal(await cfGet('https://site.example/manga/a/'), '<html>backup</html>', 'the backup answered');
  assert.equal(main.asked.length, 1, 'the main was asked once');
  assert.equal(backup.asked.length, 1, 'and the backup once');
  assert.equal(backup.asked[0], main.asked[0], 'with exactly the request the main was sent');
  assert.deepEqual(JSON.parse(backup.asked[0]), { cmd: 'request.get', url: 'https://site.example/manga/a/', maxTimeout: 60000 });

  // A POST (madara's chapter list) goes the same way, its empty body and all.
  await cfPost('https://site.example/manga/a/ajax/chapters/', '');
  assert.deepEqual(JSON.parse(backup.asked[1]), { cmd: 'request.post', url: 'https://site.example/manga/a/ajax/chapters/', postData: '', maxTimeout: 60000 });
  assert.equal(backup.asked[1], main.asked[1]);
});

test('a main that cannot be reached, does not answer in time, answers something that is not its JSON, or an empty page: the backup answers', async () => {
  // Each is a way the main fails to give a page, and each must reach the backup. Reintroduce by asking the main alone:
  // every case rejects; by keeping an empty page as an answer (`{ solution: s }` whatever its response): "an empty page"
  // returns '' from the main.
  const { cfGet, setSolverTiming } = await load();
  const backup = await fakeSolver('backup');
  setSolverTiming({ attemptMs: 400 });

  use(NOWHERE, backup.url);
  assert.equal(await cfGet('https://site.example/unreachable'), '<html>backup</html>', 'a main nothing listens at');

  const hangs = await fakeSolver('hangs');
  hangs.reply = () => ({ hang: true });
  use(hangs.url, backup.url);
  const t0 = Date.now();
  assert.equal(await cfGet('https://site.example/slow'), '<html>backup</html>', 'a main that never answers');
  assert.ok(Date.now() - t0 < 5_000, 'it was given up on after its attempt\'s time');
  assert.equal(hangs.asked.length, 1);

  const proxy = await fakeSolver('proxy');
  proxy.reply = () => ({ status: 502, raw: '<html><body>502 Bad Gateway</body></html>' });
  use(proxy.url, backup.url);
  assert.equal(await cfGet('https://site.example/proxied'), '<html>backup</html>', 'a main whose answer is not its JSON');

  const empty = await fakeSolver('empty');
  empty.reply = (b) => ({ json: solved(b.url, '') });
  use(empty.url, backup.url);
  assert.equal(await cfGet('https://site.example/empty'), '<html>backup</html>', 'a main that answers an empty page');
  assert.equal(backup.asked.length, 4, 'the backup answered all four');
});

test('when both fail, the caller hears what a solver said, under the flaresolverr: prefix', async () => {
  // A backup that cannot be reached says nothing about the site; neither does the main. Reintroduce the last failure
  // (`failed.at(-1)` in solveNow): the first case reads the backup's "fetch failed" instead of the main's timeout.
  const { cfGet } = await load();
  const main = await fakeSolver('main');
  const backup = await fakeSolver('backup');

  main.reply = () => refused(TIMEOUT);
  use(main.url, NOWHERE);
  await assert.rejects(cfGet('https://site.example/a'), (e: Error) => e.message === `flaresolverr: ${TIMEOUT}`, 'the main said it, the backup could not be asked');

  backup.reply = () => refused(BLOCKED);
  use(NOWHERE, backup.url);
  await assert.rejects(cfGet('https://site.example/b'), (e: Error) => e.message === `flaresolverr: ${BLOCKED}`, 'the backup said it, the main could not be asked');

  // Both said something: the main's, which was asked first.
  use(main.url, backup.url);
  await assert.rejects(cfGet('https://site.example/c'), (e: Error) => e.message === `flaresolverr: ${TIMEOUT}`);

  // An empty page is something said, and it keeps the status the site answered for classify() to read.
  const empty = await fakeSolver('empty');
  empty.reply = (b) => ({ json: solved(b.url, '', { status: 403 }) });
  use(NOWHERE, empty.url);
  await assert.rejects(cfGet('https://site.example/d'), (e: any) => e.message === 'flaresolverr: empty body (HTTP 403) from site.example' && e.status === 403);
});

test('no backup, or a backup at the main\'s own address: the main is asked once, and its failure is the answer, as before', async () => {
  // Reintroduce by not comparing the two addresses (backupSolverUrl): the main is asked twice for one request.
  const { cfGet } = await load();
  const main = await fakeSolver('main');
  main.reply = () => refused(BLOCKED);

  use(main.url);
  await assert.rejects(cfGet('https://site.example/x'), (e: Error) => e.message === `flaresolverr: ${BLOCKED}`);
  assert.equal(main.asked.length, 1);

  use(main.url, `${main.url}/`);
  await assert.rejects(cfGet('https://site.example/y'), (e: Error) => e.message === `flaresolverr: ${BLOCKED}`);
  assert.equal(main.asked.length, 2, 'the same solver is not asked twice for one request');

  // Unset and empty are the same: no backup.
  use(main.url, '  ');
  await assert.rejects(cfGet('https://site.example/z'));
  assert.equal(main.asked.length, 3);
});
