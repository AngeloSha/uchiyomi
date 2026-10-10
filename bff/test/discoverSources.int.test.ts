// Discover and the sources behind it (v0.59.0), through the real routes.
//
// From the audit of the owner's extensions on the live server: Discover asks every source since v0.58.0, and the
// sources it asks were being judged by rules that punished the ones behind Cloudflare's solver -- the very sites the
// library comes from. Each rule here is one finding:
//
//   - a listing behind the solver gets the solver's time, not the bare 15 s (cold solves took 15-25 s);
//   - only page 1 makes a source slow, as only page 1 counts as evidence of an empty listing;
//   - a breather earned only by being slow does not blank a listing nothing has cached (a refusal's still does);
//   - slow is not quiet: the wall asks a quiet source last, and a slow one is still worth asking;
//   - the add dialog's "find this title" asks a few sources at a time, not every one at once.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ZodError } from 'zod';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.UCHIYOMI_PING_URL = '';
  // The bare budget and the solver's, scaled down: a page that takes 800 ms is over one and well inside the other.
  process.env.SOURCE_LATEST_TIMEOUT_MS = '300';
  process.env.SOURCE_LATEST_SOLVER_TIMEOUT_MS = '3000';
  // One solver slot, so a test can hold it (the fake solver below).
  process.env.SOLVER_CONCURRENCY = '1';
  delete process.env.FLARESOLVERR_FALLBACK_URL;
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const ADMIN = 'ds-admin';
const CF = 'ds-cf', PLAIN = 'ds-plain', REST = 'ds-rest', REFUSED = 'ds-refused', SLOW = 'ds-slow', EMPTY = 'ds-empty';
/** Behind the solver, and its listing really goes through it (cfGet): what a held solver slot keeps waiting. */
const QUEUED = 'ds-queued';
const FIND = Array.from({ length: 10 }, (_, i) => `ds-find${i}`);
const ALL = [CF, PLAIN, REST, REFUSED, SLOW, EMPTY, QUEUED, ...FIND];

/** A fake FlareSolverr: a URL with /hold waits until the test lets it go; everything else is solved at once. */
let solver: Server;
let holding: Array<() => void> = [];
let cfGet: (url: string) => Promise<string>;

const asked: string[] = [];
let inFlight = 0, mostAtOnce = 0;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const items = (id: string, page: number) => [1, 2, 3].map((n) => ({ sourceId: `${id}-p${page}-${n}`, source: id, title: `${id} page ${page} #${n}` }));

function fake(id: string, o: { cloudflare?: boolean; slowPages?: number[]; listMs?: number } = {}) {
  return {
    id, name: `Name ${id}`, lang: 'en', preferredOrder: ALL.indexOf(id), ...(o.cloudflare ? { requiresCloudflare: true } : {}),
    async search(term: string) {
      asked.push(`${id}:search`);
      inFlight++; mostAtOnce = Math.max(mostAtOnce, inFlight);
      try { await wait(60); } finally { inFlight--; }
      return [{ sourceId: `${id}-hit`, source: id, title: term }];
    },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: sid }; },
    async listChapters() { return []; },
    async getPageUrls() { return []; },
    async latest(page = 1) {
      asked.push(`${id}:latest:${page}`);
      if (id === QUEUED) await cfGet(`https://queued.discover-test.example/latest/${page}`);
      if (o.listMs || o.slowPages?.includes(page)) await wait(o.listMs ?? 800);
      return items(id, page);
    },
    async popular(page = 1) {
      asked.push(`${id}:popular:${page}`);
      return items(id, page);
    },
  };
}

let q: any, app: any, clearLatestCache: () => void;
const H: Record<string, string> = {};
const get = (url: string) => app.inject({ method: 'GET', url, headers: H });
/** The slow streak once the route's unawaited report has landed: at least `n`, then whatever it settles at. */
const settledSlow = async (id: string, n: number) => {
  const end = Date.now() + 3000;
  while (((await health(id))?.slow_streak ?? 0) < n && Date.now() < end) await wait(20);
  await wait(200);
  return (await health(id))?.slow_streak ?? 0;
};
const health = async (id: string) => (await q('SELECT status, consecutive, slow_streak, blocked_until FROM source_health WHERE source_id = $1', [id]))[0] ?? null;

before(async () => {
  if (!DSN) return;
  solver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = String(JSON.parse(body || '{}').url);
      const answer = () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', message: '', solution: { url, status: 200, response: '<html>ok</html>', cookies: [], userAgent: 'UA' } }));
      };
      if (/\/hold/.test(url)) holding.push(answer); else answer();
    });
  });
  await new Promise<void>((go) => solver.listen(0, '127.0.0.1', go));
  process.env.FLARESOLVERR_URL = `http://127.0.0.1:${(solver.address() as AddressInfo).port}`;
  ({ cfGet } = await import('../src/lib/sources/flaresolverr'));
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  await migrate();
  const { registerAdapter } = await import('../src/lib/sources');
  registerAdapter(fake(CF, { cloudflare: true, listMs: 800 }) as any);
  registerAdapter(fake(PLAIN, { slowPages: [1, 3] }) as any);
  registerAdapter(fake(QUEUED, { cloudflare: true }) as any);
  for (const id of [REST, REFUSED, SLOW, EMPTY, ...FIND]) registerAdapter(fake(id) as any);
  ({ clearLatestCache } = await import('../src/routes/sources'));
  await q('DELETE FROM users WHERE username = $1', [ADMIN]);
  const admin = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms)
                          VALUES ($1,$1,'x','admin','password','{}') RETURNING id`, [ADMIN]))[0].id;
  const Fastify = (await import('fastify')).default;
  app = Fastify();
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  app.setErrorHandler((err: any, _req: any, reply: any) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'bad_request' });
    return reply.code(err.statusCode || 500).send({ error: err.message || 'error' });
  });
  await app.register((await import('@fastify/rate-limit')).default, { global: false });
  await app.register((await import('../src/routes/sources')).default);
  await app.ready();
  H.authorization = `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}`;
});

beforeEach(async () => {
  if (!DSN) return;
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [ALL]);
  clearLatestCache();
  asked.length = 0;
  inFlight = 0; mostAtOnce = 0;
});

after(async () => {
  if (!DSN) return;
  for (const go of holding.splice(0)) go();
  solver?.close();
  await app?.close();
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [ALL]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [ADMIN]).catch(() => {});
  await (await import('../src/lib/db')).pool.end().catch(() => {});
});

test("a source behind the solver gets the solver's time on Newest", { skip }, async () => {
  // Natomanga's cold solve took 15.2 s on the owner's install, against a bare 15 s: the first visit of the day lost it
  // and counted it slow. Reintroduce the bare budget for every source: the page times out and comes back empty.
  const r = await get(`/api/sources/latest?source=${CF}&page=1`);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().content.length, 3, 'the page that took longer than the bare budget arrived');
  assert.equal((await health(CF))?.slow_streak ?? 0, 0, 'and nothing counted it slow');
  // PREMISE: the same page from a source with no solver is over the bare budget -- the budget is per kind of source.
  const plain = await get(`/api/sources/latest?source=${PLAIN}&page=1`);
  assert.equal(plain.json().content.length, 0, 'PREMISE: 800 ms is over the bare budget');
  // Its slow report is written without being awaited: let it land here, not in the next test's clean table.
  await settledSlow(PLAIN, 1);
});

test('a listing whose solve waited past its budget is slow, not failing', { skip }, async () => {
  // The solver's one slot is held; the listing's own solve queues behind it and is dropped at the listing's deadline,
  // a moment before the listing's own timeout would fire. That is the listing's budget running out -- slowness --
  // never the site failing: reportFail would hand a working site an escalating cooldown. Reintroduce the drop's error
  // without selfTimeout: the source reads down, in a cooldown.
  const held = cfGet('https://hold.discover-test.example/hold');
  const end = Date.now() + 3000;
  while (!holding.length && Date.now() < end) await wait(10);
  assert.equal(holding.length, 1, 'PREMISE: the one slot is held');
  try {
    const r = await get(`/api/sources/latest?source=${QUEUED}&page=1`);
    assert.deepEqual(r.json().content, [], 'PREMISE: the page did not arrive in time');
    assert.equal(await settledSlow(QUEUED, 1), 1, 'counted slow');
    const h = await health(QUEUED);
    assert.deepEqual([h.status, h.consecutive, h.blocked_until], ['ok', 0, null], 'and not as a failure');
  } finally {
    for (const go of holding.splice(0)) go();
    await held;
  }
});

test('only page 1 makes a source slow', { skip }, async () => {
  // Five working sites read "slow" for a day on the owner's install: their later pages, asked while the reader
  // scrolled and queued behind the solver, timed out and every one was counted. Reintroduce by reporting every page:
  // the streak reads 2.
  const p3 = await get(`/api/sources/latest?source=${PLAIN}&page=3`);
  assert.equal(p3.json().content.length, 0, 'PREMISE: page 3 timed out');
  const p1 = await get(`/api/sources/latest?source=${PLAIN}&page=1`);
  assert.equal(p1.json().content.length, 0, 'PREMISE: page 1 timed out');
  assert.equal(await settledSlow(PLAIN, 1), 1, 'page 1 counted, page 3 did not');
});

test("a slow source's breather does not blank a listing it has never cached", { skip }, async () => {
  // reportSlow's five-minute breather left five working sites answering Popular with nothing on the owner's install:
  // a breather serves the cache, and Popular's is rarely filled. Reintroduce by always serving the cache: the
  // listing comes back empty and the source is never asked.
  await q(`INSERT INTO source_health (source_id, status, slow_streak, last_slow_at, blocked_until)
           VALUES ($1, 'ok', 3, now(), now() + interval '5 minutes')`, [REST]);
  const r = await get(`/api/sources/popular?source=${REST}&page=1`);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().content.length, 3, 'asked anyway, and answered');
  assert.deepEqual(asked, [`${REST}:popular:1`]);
  // A refusal's cooldown is unchanged: a site that refused us is not asked again early, on either listing.
  await q(`INSERT INTO source_health (source_id, status, consecutive, last_error, blocked_until)
           VALUES ($1, 'blocked', 3, 'HTTP 403', now() + interval '30 minutes')`, [REFUSED]);
  asked.length = 0;
  for (const mode of ['latest', 'popular']) {
    const x = await get(`/api/sources/${mode}?source=${REFUSED}&page=1`);
    assert.deepEqual(x.json().content, [], `a refused source's ${mode} stays empty`);
  }
  assert.deepEqual(asked, [], 'and is not asked');
});

test('a slow source is not quiet', { skip }, async () => {
  // The wall asks a quiet source last, and a slow one was labelled quiet: Natomanga, with 114 of the owner's series,
  // was asked 24th of 29. Reintroduce by folding the two together: the slow source reads quiet.
  await q(`INSERT INTO source_health (source_id, status, slow_streak, last_slow_at) VALUES ($1, 'ok', 3, now())`, [SLOW]);
  await q(`INSERT INTO source_health (source_id, status, empty_streak, last_empty_at) VALUES ($1, 'ok', 3, now())`, [EMPTY]);
  const r = await get('/api/sources');
  assert.equal(r.statusCode, 200, r.body);
  const by = Object.fromEntries(r.json().content.map((s: any) => [s.id, s]));
  assert.equal(by[SLOW]?.status, 'ok', 'slow, and still asked in its turn');
  assert.ok(by[SLOW]?.noteCode, 'the sheet still says it has been slow');
  assert.equal(by[EMPTY]?.status, 'quiet', 'an empty listing is still quiet');
});

test("the add dialog's search asks a few sources at a time", { skip }, async () => {
  // Discover asks every source since v0.58.0, and the add dialog names them all: every search went on the wire at
  // the same moment, the solver's among them. Reintroduce Promise.all over every source: ten at once.
  const r = await get(`/api/sources/find?q=${encodeURIComponent('A Title')}&sources=${FIND.join(',')}`);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(asked.filter((a) => a.endsWith(':search')).length, FIND.length, 'every source named was asked');
  assert.equal(mostAtOnce, 6, 'six at a time');
  assert.deepEqual(r.json().content.map((h: any) => h.source), FIND, 'each answer kept in the ask order');
});
