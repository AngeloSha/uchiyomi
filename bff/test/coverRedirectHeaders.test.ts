// A cover redirected to another origin carries none of the first one's credentials (v0.77.1).
//
// fetchCoverImage follows redirects by hand so every hop is checked, and it sent the same headers on every hop: a
// source's own extra headers (imageHeaders), and after a Cloudflare solve the solver's clearance cookie, wherever the
// redirect pointed. fetchFollowingPublic has kept credentials to the first origin since v0.69.1; the cover proxy now
// keeps the same rule (lib/safeFetch.ts withoutCredentials) and drops the source's extras off that origin too.
//
// A fetch stub stands in for both hosts and for the solver, and records the headers each hop was sent. The hosts are
// public address literals, so the DNS half of the guard has nothing to look up. No network, no database.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || 'postgres://x:x@127.0.0.1:1/x';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
const SOLVER = 'http://solver.cover-redirect.invalid:8191';
process.env.FLARESOLVERR_URL = SOLVER; // read when the solver is asked: set before anything imports it
delete process.env.FLARESOLVERR_FALLBACK_URL;

const A = 'http://93.184.215.14';
const B = 'http://93.184.215.15';
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
const SECRETS = { cookie: 'session=for-the-source', authorization: 'Bearer for-the-source', 'x-source-key': 'for-the-source' };

const hops: Array<{ url: string; headers: Record<string, string> }> = [];
const realFetch = globalThis.fetch;

/** A source whose images need its own headers -- an image proxy behind a login, say. */
const KEYED = {
  id: 'cover-redirect-keyed', name: 'Keyed', base: `${A}/`, imageHeaders: SECRETS,
  search: async () => [], getSeries: async () => null, listChapters: async () => [], getPageUrls: async () => [],
};
/** A source behind Cloudflare: its covers are refused until the solver's cookie comes along. */
const GUARDED = {
  id: 'cover-redirect-guarded', name: 'Guarded', base: `${A}/`, requiresCloudflare: true,
  search: async () => [], getSeries: async () => null, listChapters: async () => [], getPageUrls: async () => [],
};

let fetchCoverImage: typeof import('../src/routes/images').fetchCoverImage;

before(async () => {
  globalThis.fetch = (async (input: any, init?: any) => {
    const u = String(input instanceof URL ? input.href : input?.url ?? input);
    if (new URL(u).origin === SOLVER) {
      // FlareSolverr's answer to a solve: a clearance cookie and the user agent it belongs to.
      const body = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({
        status: 'ok',
        solution: { url: body.url, status: 200, response: '<html></html>', userAgent: 'SolverBrowser/1.0', cookies: [{ name: 'cf_clearance', value: 'solved' }] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    hops.push({ url: u, headers });
    assert.equal(init?.redirect, 'manual', 'PREMISE: the proxy follows redirects itself');
    if (u === `${A}/guarded.jpg` && !headers.cookie) return new Response('challenge', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
    if (u === `${A}/cover.jpg` || u === `${A}/guarded.jpg`) return new Response(null, { status: 302, headers: { location: `${B}/moved.jpg` } });
    if (u === `${A}/same.jpg`) return new Response(null, { status: 302, headers: { location: `${A}/moved.jpg` } });
    return new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;
  ({ fetchCoverImage } = await import('../src/routes/images'));
  const loader = await import('../src/lib/sources/loader');
  assert.equal(loader.registerAdapter(KEYED as any), true, 'the keyed source registered');
  assert.equal(loader.registerAdapter(GUARDED as any), true, 'the guarded source registered');
});
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => { hops.length = 0; });

test("a redirect to another origin carries none of the first one's credentials", async () => {
  const body = await fetchCoverImage(`${A}/cover.jpg`, KEYED.id);
  assert.ok(body.equals(PIXEL), 'the cover still arrives');
  assert.deepEqual(hops.map((h) => h.url), [`${A}/cover.jpg`, `${B}/moved.jpg`]);
  const [first, second] = hops;
  for (const [k, v] of Object.entries(SECRETS)) assert.equal(first.headers[k], v, `PREMISE: the source's ${k} goes to its own host`);
  // Reintroduce by sending `sourceHeaders` on every hop in fetchCoverImage (routes/images.ts): all three arrive at B.
  for (const k of Object.keys(SECRETS)) assert.equal(second.headers[k], undefined, `the source's ${k} went to another origin`);
  assert.match(second.headers['user-agent'] ?? '', /Mozilla/, 'the ordinary request headers still go');
  assert.ok(second.headers.accept, 'the ordinary request headers still go');
});

test('a redirect within the same origin keeps them', async () => {
  await fetchCoverImage(`${A}/same.jpg`, KEYED.id);
  assert.deepEqual(hops.map((h) => h.url), [`${A}/same.jpg`, `${A}/moved.jpg`]);
  for (const [k, v] of Object.entries(SECRETS)) assert.equal(hops[1].headers[k], v, `the source's ${k} was dropped on its own origin`);
});

test("the solver's clearance cookie stays with the origin it was solved for", async () => {
  const body = await fetchCoverImage(`${A}/guarded.jpg`, GUARDED.id);
  assert.ok(body.equals(PIXEL), 'the cover still arrives');
  // Refused, solved, asked again with the cookie, sent on to B.
  assert.deepEqual(hops.map((h) => h.url), [`${A}/guarded.jpg`, `${A}/guarded.jpg`, `${B}/moved.jpg`]);
  assert.equal(hops[1].headers.cookie, 'cf_clearance=solved', 'PREMISE: the solved cookie goes to the origin it was solved for');
  assert.equal(hops[1].headers['user-agent'], 'SolverBrowser/1.0', 'PREMISE: with the user agent it belongs to');
  // Reintroduce by sending `sourceHeaders` on every hop: the clearance cookie arrives at B.
  assert.equal(hops[2].headers.cookie, undefined, 'the solver\'s clearance cookie went to another origin');
});
