// A cover URL a caller hands the proxy must never reach the Cloudflare solver on the caller's say-so.
//
// `GET /img/sources/cover?u=…&source=…` is open to any signed-in reader, and `u` is theirs to choose. The
// v0.21.0 guard refused private addresses -- but only in front of the plain fetch. For a source marked
// `requiresCloudflare`, `fetchCoverImage` first handed `u` to `cfSession`, which asks FlareSolverr to open the
// URL's origin and then the URL itself, and the DNS half of the guard ran only afterwards. The cheap half
// (`isBlockedHost`) knew literal private IPs and four suffixes, not bare names, so `http://uchiyomi-suwayomi:4567/…`
// or `http://yomi-db:5432/` went straight to the solver.
//
// ⚠️ THE SOLVER IS A BROWSER, NOT A FETCH. It sits on the same Docker network as the engine and the database,
// follows redirects by itself, and runs the JavaScript of whatever page it opens -- so "the host resolved to
// a public address" is not enough either: a public page an outsider controls can redirect it, or script it,
// into the network. A caller-supplied URL therefore reaches the solver only on a host the SOURCE vouched for:
// its own admin-configured site, or a host it has actually served covers from. Library covers are not
// caller-supplied (they come from series_art) and keep the solver as before -- Aqua's covers live on a
// Cloudflare-protected CDN that answers 403 without it.
//
// The fake FlareSolverr below records every URL it is asked to open, and the assertions are on that record:
// a refused URL that still reached the solver is exactly the bug, even though the call rejects either way. Since
// v0.55.3 a backup solver (FLARESOLVERR_FALLBACK_URL) is asked whatever the main could not answer, so a fake backup
// writes into the same record ("backup: <url>"): every guard stands in front of both.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.DATABASE_URL = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || 'postgres://x:x@127.0.0.1:1/x';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';

const asked: string[] = [];
let solver: Server;
let backup: Server;

type Images = typeof import('../src/routes/images');
let fetchCoverImage: Images['fetchCoverImage'];
let UnfetchableCoverUrl: Images['UnfetchableCoverUrl'];
let sourceCoverInput: ((u: string, source?: string) => Promise<Buffer>) | undefined;
let cfSession: typeof import('../src/lib/sources/flaresolverr').cfSession;
let getSource: typeof import('../src/lib/sources/loader').getSource;
let solverMayVisit: ((src: { id: string; base?: string }, hostname: string) => boolean) | undefined;

// Its own site is on `.invalid` (RFC 2606: guaranteed never to resolve), so the DNS half of the guard can be
// observed refusing it without this test depending on anybody's resolver answering anything.
const CF = {
  id: 'cf-guard-fake',
  name: 'CF guard fake',
  requiresCloudflare: true,
  base: 'https://site.cover-guard.invalid',
  search: async () => [{ sourceId: '1', source: 'cf-guard-fake', title: 'T', coverUrl: 'https://cdn.learned-host.example/c.jpg' }],
  getSeries: async () => null,
  listChapters: async () => [],
  getPageUrls: async () => [],
};
const OTHER = {
  id: 'cf-guard-other',
  name: 'CF guard other',
  requiresCloudflare: true,
  base: 'https://other.cover-guard.invalid',
  search: async () => [{ sourceId: '1', source: 'cf-guard-other', title: 'T', coverUrl: 'https://cdn.other-source.example/c.jpg' }],
  getSeries: async () => null,
  listChapters: async () => [],
  getPageUrls: async () => [],
};

/** A fake solver that refuses everything and records what it was asked to open, under `tag`. */
async function fakeSolver(tag: string): Promise<Server> {
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { asked.push(tag + String(JSON.parse(body).url)); } catch { asked.push(`${tag}(unreadable request)`); }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'error', message: 'fake solver: refusing to solve' }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return srv;
}

before(async () => {
  solver = await fakeSolver('');
  backup = await fakeSolver('backup: ');
  // Set before anything imports flaresolverr.ts (which since v0.55.3 reads both when it asks).
  process.env.FLARESOLVERR_URL = `http://127.0.0.1:${(solver.address() as AddressInfo).port}`;
  process.env.FLARESOLVERR_FALLBACK_URL = `http://127.0.0.1:${(backup.address() as AddressInfo).port}`;

  const images = await import('../src/routes/images');
  ({ fetchCoverImage, UnfetchableCoverUrl } = images);
  sourceCoverInput = (images as any).sourceCoverInput;
  ({ cfSession } = await import('../src/lib/sources/flaresolverr'));
  const loader = await import('../src/lib/sources/loader');
  getSource = loader.getSource;
  solverMayVisit = ((await import('../src/lib/sources/imageHosts').catch(() => ({}))) as any).solverMayVisit;
  assert.equal(loader.registerAdapter(CF as any), true, 'the fake Cloudflare source registered');
  assert.equal(loader.registerAdapter(OTHER as any), true, 'the second fake source registered');
});

after(() => { solver.close(); backup.close(); });
beforeEach(() => { asked.length = 0; });

const unfetchable = (e: unknown) => e instanceof UnfetchableCoverUrl;

test('the fake solver is really the one the app calls (so an empty record below means something)', async () => {
  // Without this, every "the solver was never asked" assertion would pass against a solver nobody talks to.
  await cfSession('http://93.184.215.14/probe.jpg');
  assert.ok(asked.length > 0, 'cfSession reached the fake FlareSolverr');
  // ...and the backup, once the main refused (v0.55.3): an empty record below covers both solvers.
  assert.ok(asked.some((u) => u.startsWith('backup: ')), 'cfSession reached the fake backup after the main refused');
});

test('a bare Docker service name never reaches the solver', async () => {
  // Reintroduce by moving the requiresCloudflare block back above the DNS check AND dropping the dotless-name
  // rule in isBlockedHost: the solver is asked to open the engine, twice (origin, then the URL).
  for (const u of [
    'http://uchiyomi-suwayomi:4567/api/v1/settings/about',
    'http://yomi-suwayomi:4567/api/v1/extension/list',
    'http://yomi-db:5432/',
    'http://uchiyomi-flaresolverr:8191/v1',
  ]) {
    await assert.rejects(fetchCoverImage(u, CF.id), unfetchable, `${u} is refused`);
    assert.deepEqual(asked, [], `the solver was asked to open ${u}`);
  }
});

test("the DNS half of the guard runs before the solver, even on the source's own site", async () => {
  // The source's own host is exactly the case the allowlist permits, so only the ORDER protects it here: the
  // host does not resolve, and the solver must never hear about it. Reintroduce by moving the
  // assertPublicHost call back below the requiresCloudflare block -- the solver is asked for this URL.
  const u = 'https://site.cover-guard.invalid/wp-content/uploads/cover.jpg';
  await assert.rejects(fetchCoverImage(u, CF.id), unfetchable, 'an unresolvable host is refused');
  assert.deepEqual(asked, [], 'the solver was asked to open a host that failed the DNS check');
});

test('a literal private address never reaches the solver (refused before v0.45.1 too)', async () => {
  for (const u of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:5432/', 'http://[::1]/']) {
    await assert.rejects(fetchCoverImage(u, CF.id), unfetchable, `${u} is refused`);
    assert.deepEqual(asked, [], `the solver was asked to open ${u}`);
  }
});

test("the solver visits only the source's own site, or a host that source has served covers from", async () => {
  assert.ok(solverMayVisit, 'imageHosts.solverMayVisit exists');
  const may = (h: string, src: { id: string; base?: string } = CF) => solverMayVisit!(src, h);

  assert.equal(may('site.cover-guard.invalid'), true, 'its own site');
  assert.equal(may('www.site.cover-guard.invalid'), true, 'its own site, www');
  assert.equal(may('img.site.cover-guard.invalid'), true, 'a subdomain of its own site');
  assert.equal(may('SITE.cover-guard.invalid.'), true, 'case and a trailing dot do not matter');

  // Reintroduce by returning true for any host: every one of these becomes a page the solver will open.
  assert.equal(may('attacker.example'), false, 'a host the source never mentioned');
  assert.equal(may('site.cover-guard.invalid.attacker.example'), false, 'its own name as a prefix');
  assert.equal(may('evilsite.cover-guard.invalid'), false, 'its own name as a suffix without the dot');
  assert.equal(may('cdn.learned-host.example'), false, 'a CDN before the source has served anything from it');

  // A host counts once the source itself hands out a cover there, through the adapter the app registered.
  await getSource(CF.id)!.search('anything');
  assert.equal(may('cdn.learned-host.example'), true, 'the CDN the source served a cover from');

  // ...and only for that source.
  await getSource(OTHER.id)!.search('anything');
  assert.equal(may('cdn.other-source.example'), false, "another source's CDN");
  assert.equal(may('cdn.other-source.example', OTHER), true, "the other source's own CDN, for that source");
});

test('the cover route asks the solver only about hosts the source vouched for', async () => {
  // `2001:db8::/32` is the IPv6 documentation prefix: public as far as the guard can tell, routed nowhere, so the
  // plain fetch after the solver decision fails at once instead of reaching anyone. Only the decision is
  // under test. Reintroduce by dropping `callerSupplied` from the route's call: the solver is asked.
  assert.ok(sourceCoverInput, 'images.sourceCoverInput exists');
  const u = 'http://[2001:db8::1]/cover.jpg';
  await assert.rejects(sourceCoverInput!(u, CF.id));
  assert.deepEqual(asked, [], 'the solver was asked to open a host the source never vouched for');
});

// ---- v0.59.0: plain first ----------------------------------------------------------------------------------------
// A public address for the CDN (an IP literal: no resolver involved), whose answers the test scripts through fetch;
// the solvers' own requests pass through to the fakes above.
const CDN = 'https://93.184.215.14';
const withCdn = async (answer: (n: number) => Response, fn: () => Promise<void>) => {
  const real = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async (u: any, init?: any) => {
    if (String(u).startsWith(CDN)) return answer(++n);
    return real(u, init);
  }) as typeof fetch;
  try { await fn(); } finally { globalThis.fetch = real; }
};
const PNG = () => new Response(Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64, 1)]), { status: 200, headers: { 'content-type': 'image/png' } });

test('a cover the CDN serves never asks the solver', async () => {
  // The owner's install: ~89 solves for one cover CDN, every one failed, each holding a solver slot, while the plain
  // fetch served every cover with a 200 -- and Discover's listings timed out behind them. A library cover (not a
  // caller's) of a source behind Cloudflare is the case that always solved first. Reintroduce the solve-first order:
  // the solver is asked to open the CDN.
  await withCdn(() => PNG(), async () => {
    const img = await fetchCoverImage(`${CDN}/covers/served.png`, CF.id);
    assert.ok(img.length > 8, 'the cover arrived');
  });
  assert.deepEqual(asked, [], 'no solver was asked for a cover the CDN served');
});

test("a refused caller's cover asks for its CDN's clearance once -- its origin, never the image URL", async () => {
  // Cloudflare refused the plain fetch: now, and only now, the solver is asked -- for the origin's root. A caller's
  // cover never has the image URL itself solved (cfSession solveUrl: false): an image is no page. The fake solvers
  // refuse, so there are no cookies and no second fetch, and the refusal stands (502). Reintroduce solveUrl for every
  // cover: the record holds the image URL too.
  const { noteImageHost } = await import('../src/lib/sources/imageHosts');
  noteImageHost(CF.id, `${CDN}/covers/served.png`);
  assert.equal(solverMayVisit!(CF as any, '93.184.215.14'), true, 'PREMISE: the source has served covers from this CDN');
  let fetched = 0;
  let caught: unknown = null;
  await withCdn((n) => {
    fetched = n;
    return new Response('denied', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
  }, async () => {
    caught = await fetchCoverImage(`${CDN}/covers/refused.png`, CF.id, { callerSupplied: true }).then(() => null, (e) => e);
  });
  assert.equal((caught as any)?.statusCode, 502, 'the refusal stands');
  assert.equal(fetched, 1, 'no cookies, no second fetch');
  assert.ok(asked.length > 0, 'PREMISE: the refusal asked for clearance');
  assert.ok(asked.every((u) => u.replace(/^backup: /, '') === `${CDN}/`), `only the origin was solved: ${asked.join(', ')}`);
});
