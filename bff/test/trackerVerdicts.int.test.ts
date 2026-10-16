// "Unreachable" and "refused" are not "rejected" (v0.61.0, #190).
//
// Connect answered every failure "AniList did not accept that token": a DNS failure, Cloudflare's text/plain 403 in front
// of graphql.anilist.co, a service having a bad minute. The person went back for a new token that was never the problem.
// Since v0.61.0 the adapters' errors carry the HTTP status, verdictOf (lib/trackerProviders.ts) reads them, Connect
// answers 400 `rejected` only for the service's verdict on the token and 502 `tracker_unreachable` / `tracker_refused`
// {status} for the rest, and Test connection (POST /api/trackers/:provider/test) says which, writing nothing.
//
// The three tracker hosts are answered by a per-test router, as in trackerProviders.int.test.ts; a router may also
// THROW, which is how a request that never got an answer looks to the adapters.
//
// The route tests are skipped unless TEST_DATABASE_URL is set; the adapter tests always run.
import test from 'node:test';
import assert from 'node:assert/strict';
// Static, unlike the modules below: it reads no environment and imports nothing.
import { resetAniListQuota } from '../src/lib/anilistLimit';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

type Call = { method: string; url: URL; body: any };
const calls: Call[] = [];
let route: (c: Call) => Response | null = () => null;
const TRACKER_HOSTS = ['graphql.anilist.co', 'api.myanimelist.net', 'kitsu.app', 'kitsu.io'];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: any, init?: any) => {
  const url = new URL(String(u));
  if (!TRACKER_HOSTS.includes(url.hostname)) return realFetch(u, init);
  let body: any = null;
  if (typeof init?.body === 'string') { try { body = JSON.parse(init.body); } catch { body = init.body; } }
  const c = { method: String(init?.method ?? 'GET').toUpperCase(), url, body };
  calls.push(c);
  return route(c) ?? new Response('unrouted', { status: 500 });
}) as typeof fetch;
// Each case starts with the server's AniList quota as a fresh process has it (v0.73.0, lib/anilistLimit.ts): a scripted
// 429 holds every AniList call for a minute, and a later case's call would be answered "busy" instead of by its script.
const reset = (r: typeof route) => { calls.length = 0; route = r; resetAniListQuota(); };
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

/** What undici throws when the name does not resolve or nothing listens: `TypeError: fetch failed`, the code on `cause`. */
const offline = (code = 'ENOTFOUND') => (): Response => {
  throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`getaddrinfo ${code} host`), { code }) });
};
/** What `AbortSignal.timeout(15000)` rejects a fetch with. */
const timedOut = (): Response => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
/** Cloudflare's answer to a client signature it dislikes: a verdict on the caller, never on the token. */
const cloudflare = () => new Response('error code: 1010', { status: 403, headers: { 'content-type': 'text/plain' } });
const anilistInvalidToken = () => json({ data: null, errors: [{ message: 'Invalid token', status: 400 }] }, 400);
const anilistViewer = (c: Call) => (/Viewer/.test(c.body?.query) ? json({ data: { Viewer: { id: 7, name: 'me' } } }) : null);

test('verdictOf: only the service\'s word on the token is "rejected"', async () => {
  const { verdictOf } = await import('../src/lib/trackerProviders');
  assert.deepEqual(verdictOf(Object.assign(new Error('tracker rejected the token'), { authFailed: true, status: 400 })), { verdict: 'rejected' });
  // No answer at all.
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
    let thrown: unknown;
    try { offline(code)(); } catch (e) { thrown = e; }
    assert.deepEqual(verdictOf(thrown), { verdict: 'unreachable' }, `${code} on the cause is no answer`);
  }
  assert.deepEqual(verdictOf(new TypeError('fetch failed')), { verdict: 'unreachable' }, 'undici\'s fetch failed is no answer');
  assert.deepEqual(verdictOf(new DOMException('timed out', 'TimeoutError')), { verdict: 'unreachable' }, 'a timeout is no answer');
  assert.deepEqual(verdictOf(new DOMException('aborted', 'AbortError')), { verdict: 'unreachable' });
  // An answer that turned the request down for another reason.
  assert.deepEqual(verdictOf(Object.assign(new Error('anilist 403'), { status: 403 })), { verdict: 'refused', status: 403 });
  assert.deepEqual(verdictOf(Object.assign(new Error('anilist 429'), { status: 429 })), { verdict: 'refused', status: 429 });
  assert.deepEqual(verdictOf(Object.assign(new Error('kitsu 503'), { status: 503 })), { verdict: 'refused', status: 503 });
  // A GraphQL error inside a 200, or a body that is not JSON: an answer, with no status to give.
  assert.deepEqual(verdictOf(new SyntaxError('Unexpected token < in JSON')), { verdict: 'refused' });
  assert.deepEqual(verdictOf(undefined), { verdict: 'refused' });
});

test('every adapter: a network throw is unreachable, a text/plain 403 refused, a bad token rejected', async () => {
  // Reintroduce the old reading -- every failure the token's -- by returning `rejected` last in verdictOf: the
  // network throw and the timeout below read `rejected`. Put `|| r.status === 403` back in anilistCall's authFail
  // condition: Cloudflare's 403 reads `rejected`.
  const { anilistAdapter, malAdapter, kitsuAdapter, verdictOf } = await import('../src/lib/trackerProviders');
  const verdict = async (p: Promise<unknown>) => {
    try { await p; } catch (e) { return verdictOf(e); }
    assert.fail('the call did not fail');
  };
  for (const a of [anilistAdapter, malAdapter, kitsuAdapter]) {
    reset(offline());
    assert.deepEqual(await verdict(a.whoAmI('tok-good-enough')), { verdict: 'unreachable' }, `${a.id}: a name that did not resolve`);
    reset(offline('ECONNREFUSED'));
    assert.deepEqual(await verdict(a.whoAmI('tok-good-enough')), { verdict: 'unreachable' }, `${a.id}: a refused connection`);
    reset(timedOut);
    assert.deepEqual(await verdict(a.whoAmI('tok-good-enough')), { verdict: 'unreachable' }, `${a.id}: a timeout`);
    reset(cloudflare);
    assert.deepEqual(await verdict(a.whoAmI('tok-good-enough')), { verdict: 'refused', status: 403 }, `${a.id}: a text/plain 403 is refused, not rejected`);
    reset(() => json({ error: 'too_many' }, 429));
    assert.deepEqual(await verdict(a.whoAmI('tok-good-enough')), { verdict: 'refused', status: 429 }, `${a.id}: a 429`);
    reset(() => new Response('upstream down', { status: 503 }));
    assert.deepEqual(await verdict(a.whoAmI('tok-good-enough')), { verdict: 'refused', status: 503 }, `${a.id}: a 503`);
  }
  // The token's own verdicts.
  reset(anilistInvalidToken);
  assert.deepEqual(await verdict(anilistAdapter.whoAmI('bad')), { verdict: 'rejected' }, 'AniList: a 400 "Invalid token" is rejected');
  reset(() => json({ errors: [{ message: 'Validation error: Variable "$x" got invalid value', status: 400 }] }, 400));
  assert.deepEqual(await verdict(anilistAdapter.whoAmI('good')), { verdict: 'refused', status: 400 }, 'AniList: any other 400 is not about the token');
  reset(() => json({ error: 'invalid_token' }, 401));
  assert.deepEqual(await verdict(malAdapter.whoAmI('bad')), { verdict: 'rejected' }, 'MyAnimeList: a 401 is rejected');
  reset(() => json({ errors: [{ status: '401' }] }, 401));
  assert.deepEqual(await verdict(kitsuAdapter.whoAmI('bad')), { verdict: 'rejected' }, 'Kitsu: a 401 is rejected');
  // The messages `lastError` shows are unchanged by the status they now carry.
  reset(cloudflare);
  await assert.rejects(anilistAdapter.whoAmI('good'), (e) => (e as Error).message === 'anilist 403' && (e as any).status === 403);
});

test('the AniList adapter offers the token page for the project\'s public client, and no secret', async () => {
  // Reintroduce the old help ("create a client, then copy the access token") and this fails: AniList's client page
  // shows a client ID and a secret, never a token (#190).
  const { anilistAdapter, malAdapter, kitsuAdapter, ANILIST_TOKEN_URL } = await import('../src/lib/trackerProviders');
  assert.equal(ANILIST_TOKEN_URL, 'https://anilist.co/api/v2/oauth/authorize?client_id=53603&response_type=token');
  assert.equal(anilistAdapter.authorizeUrl, ANILIST_TOKEN_URL);
  assert.ok(anilistAdapter.tokenHelp.includes(ANILIST_TOKEN_URL), 'the English help names the link');
  assert.doesNotMatch(anilistAdapter.tokenHelp, /create a client/i);
  assert.equal(malAdapter.authorizeUrl, undefined, 'no MyAnimeList page shows a token');
  assert.equal(kitsuAdapter.authorizeUrl, undefined, 'no Kitsu page shows a token');
  assert.match(malAdapter.tokenHelp, /no token on any page/);
  assert.match(kitsuAdapter.tokenHelp, /kitsu\.io\/api\/oauth\/token/);
});

test('Connect and Test connection over HTTP', { skip }, async (t) => {
  const { migrate } = await import('../src/lib/migrate');
  const { q, one } = await import('../src/lib/db');
  const trackers = await import('../src/lib/trackers');
  const personalRoutes = (await import('../src/routes/personal')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await migrate();
  const NAMES = ['trk-verdict-a', 'trk-verdict-b', 'trk-verdict-c'];
  await q('DELETE FROM users WHERE username = ANY($1)', [NAMES]);
  const [a, b, c] = await Promise.all(NAMES.map(async (n) => (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role) VALUES ($1,$1,'x','user') RETURNING id`, [n]))[0]));
  // Mounted bare, with no limiter at the root: the plugin brings its own (routes/personal.ts), as server.ts would.
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(personalRoutes);
  await app.ready();
  const auth = (id: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub: id, role: 'user' })}` });
  const connect = (id: string, provider: string, token = 'a-token-long-enough-to-pass') =>
    app.inject({ method: 'POST', url: `/api/trackers/${provider}/connect`, headers: auth(id), payload: { token } });
  const testIt = (id: string, provider: string) => app.inject({ method: 'POST', url: `/api/trackers/${provider}/test`, headers: auth(id) });
  const row = (id: string, provider: string) => one<{ access_token: string; account_name: string | null; enabled: boolean; last_error: string | null; expires_at: Date | null }>(
    'SELECT access_token, account_name, enabled, last_error, expires_at FROM user_trackers WHERE user_id = $1 AND provider = $2', [id, provider]);

  try {
    await t.test('connect: a network throw is 502 tracker_unreachable, and nothing is saved', async () => {
      // Reintroduce by answering 400 `rejected` in connectTracker's catch again: this reads 400.
      reset(offline());
      const r = await connect(a.id, 'anilist');
      assert.equal(r.statusCode, 502, r.body);
      assert.equal(r.json().error, 'tracker_unreachable');
      assert.equal(await row(a.id, 'anilist'), null);
    });

    await t.test('connect: Cloudflare\'s text/plain 403 is 502 tracker_refused with its status', async () => {
      reset(cloudflare);
      const r = await connect(a.id, 'anilist');
      assert.equal(r.statusCode, 502, r.body);
      assert.equal(r.json().error, 'tracker_refused');
      assert.equal(r.json().status, 403);
      reset(() => new Response('maintenance', { status: 503 }));
      const k = await connect(a.id, 'kitsu');
      assert.deepEqual([k.statusCode, k.json().error, k.json().status], [502, 'tracker_refused', 503]);
      assert.equal(await row(a.id, 'anilist'), null);
    });

    await t.test('connect: the service\'s verdict on the token is still 400 rejected', async () => {
      reset(anilistInvalidToken);
      const r = await connect(a.id, 'anilist');
      assert.equal(r.statusCode, 400, r.body);
      assert.equal(r.json().error, 'rejected');
      reset(() => json({ error: 'invalid_token' }, 401));
      const m = await connect(a.id, 'myanimelist');
      assert.deepEqual([m.statusCode, m.json().error], [400, 'rejected']);
      // A short paste never reaches the service.
      reset(() => assert.fail('a token under ten characters was sent to the service'));
      const short = await connect(a.id, 'anilist', '53603');
      assert.deepEqual([short.statusCode, short.json().error], [400, 'bad_request']);
    });

    await t.test('connect: a good token is saved, and GET /api/trackers offers AniList\'s token page', async () => {
      reset(anilistViewer);
      const r = await connect(a.id, 'anilist');
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().account, 'me');
      assert.equal((await row(a.id, 'anilist'))?.enabled, true);
      const list = await app.inject({ method: 'GET', url: '/api/trackers', headers: auth(a.id) });
      const byId = Object.fromEntries(list.json().content.map((s: any) => [s.provider, s]));
      assert.equal(byId.anilist.authorizeUrl, 'https://anilist.co/api/v2/oauth/authorize?client_id=53603&response_type=token');
      assert.ok(!('authorizeUrl' in byId.myanimelist) && !('authorizeUrl' in byId.kitsu), 'only a service with such a page carries the key');
    });

    await t.test('test: each verdict, and nothing about the connection is written', async () => {
      // Reintroduce a write -- `markError` on a failed test, or disabling on `rejected` -- and "nothing is written"
      // fails: checking a connection must never be able to break it.
      const before = await row(a.id, 'anilist');
      reset(anilistViewer);
      let r = await testIt(a.id, 'anilist');
      assert.equal(r.statusCode, 200, r.body);
      assert.deepEqual(r.json(), { ok: true, verdict: 'connected', account: 'me' });
      assert.equal(calls.length, 1, 'one call to the service');
      reset(anilistInvalidToken);
      r = await testIt(a.id, 'anilist');
      assert.deepEqual(r.json(), { ok: false, verdict: 'rejected' });
      reset(offline('EAI_AGAIN'));
      r = await testIt(a.id, 'anilist');
      assert.deepEqual(r.json(), { ok: false, verdict: 'unreachable' });
      reset(() => new Response('bad gateway', { status: 503 }));
      r = await testIt(a.id, 'anilist');
      assert.deepEqual(r.json(), { ok: false, verdict: 'refused', status: 503 });
      assert.deepEqual(await row(a.id, 'anilist'), before, 'nothing is written');
    });

    await t.test('test: an expired token is not sent; no connection is not_connected', async () => {
      await q(`UPDATE user_trackers SET expires_at = now() - interval '1 day' WHERE user_id = $1 AND provider = 'anilist'`, [a.id]);
      reset(() => assert.fail('an expired token was sent'));
      let r = await testIt(a.id, 'anilist');
      assert.deepEqual(r.json(), { ok: false, verdict: 'expired' });
      r = await testIt(a.id, 'kitsu');
      assert.deepEqual(r.json(), { ok: false, verdict: 'not_connected' });
      assert.equal(calls.length, 0);
    });

    await t.test('test: an unknown provider is a 404; a disabled connection is not_connected', async () => {
      let r = await testIt(b.id, 'goodreads');
      assert.deepEqual([r.statusCode, r.json().error], [404, 'unknown_provider']);
      // A push that met a rejected token disables the row; GET /api/trackers calls it not connected, and so does this.
      await trackers.saveConnection(b.id, 'myanimelist', 'tok-mal', 'me-on-mal', new Date(Date.now() + 86_400_000));
      await q(`UPDATE user_trackers SET enabled = false WHERE user_id = $1 AND provider = 'myanimelist'`, [b.id]);
      reset(() => assert.fail('a disabled connection was tested against the service'));
      r = await testIt(b.id, 'myanimelist');
      assert.deepEqual(r.json(), { ok: false, verdict: 'not_connected' });
    });

    await t.test('the seventh test in a minute is a 429', async () => {
      // Two used above by this account; four more pass, the seventh is refused. Reintroduce by dropping the route's
      // rateLimit config: it answers 200.
      reset(() => assert.fail('no service is asked for an unconnected provider'));
      for (let i = 3; i <= 6; i++) assert.equal((await testIt(b.id, 'kitsu')).statusCode, 200, `test ${i}`);
      const seventh = await testIt(b.id, 'kitsu');
      assert.equal(seventh.statusCode, 429, seventh.body);
      // Per account, not per address (every inject comes from one): another account is not held up by it.
      assert.equal((await testIt(c.id, 'kitsu')).statusCode, 200, 'one account\'s tests held up another\'s');
    });
  } finally {
    await app.close();
    await q('DELETE FROM users WHERE username = ANY($1)', [NAMES]).catch(() => {});
  }
});
