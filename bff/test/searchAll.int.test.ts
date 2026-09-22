// The Discover search answers before the slow sources do, remembers what it heard, and never lets one
// viewer's search hand another viewer a source outside their reach.
//
// What this replaced: one Promise.all over every registered source with a 20-second budget each (90 for a
// source behind Cloudflare), no cache, no in-flight sharing, cooldown sources asked anyway, timeouts
// reported nowhere. The first paint waited for the LAST source. lib/searchAll.ts is the mechanism; this
// file drives it directly for the timing and health rules, and over HTTP for the shapes and the age cap.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  // The real per-source budget is 20 s and the solver's 90 s. A hanging fake must settle inside a test, and
  // the two must differ so the solver budget can be seen to apply to a source that declares the solver.
  process.env.SEARCH_SOURCE_MS = '3000';
  process.env.SOLVER_BUDGET_MS = '3600';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

/** Slow ones answer after this; longer than the grace, shorter than the budget, so they are still pending at the first answer. */
const SLOW_MS = 2500;
const FAST = 'sb-fast', SLOW1 = 'sb-slow1', SLOW2 = 'sb-slow2', HANG = 'sb-hang', CF = 'sb-cf', THROW = 'sb-throw';
const EMPTY = 'sb-empty', OFF = 'sb-off', COOL = 'sb-cool', ADULT = 'sb-adult', DETAIL = 'sb-detail';
const USERS = ['sb-plain', 'sb-capped'];

/** Counts calls so the entry can be shown to be doing something rather than assumed to be. */
const calls: Record<string, number> = {};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function fake(id: string, name: string, opts: { delay?: number; hang?: boolean; throws?: string; empty?: boolean; cf?: boolean; isNsfw?: boolean } = {}) {
  calls[id] = 0;
  const own = (q: string) => ({ sourceId: `${id}-own`, source: id, title: `${q} on ${name}`, coverUrl: `https://x/${id}.jpg` });
  // Every source that answers also carries the same shared title, so the title grouping has something to fold.
  const shared = () => ({ sourceId: `${id}-shared`, source: id, title: 'Shared Title', updatedAt: '2026-09-20T00:00:00Z' });
  return {
    id, name, requiresCloudflare: opts.cf, isNsfw: opts.isNsfw,
    async search(q: string) {
      calls[id]++;
      if (opts.hang) return new Promise<any[]>(() => { /* never settles, like a site behind a challenge */ });
      if (opts.throws) throw new Error(opts.throws);
      if (opts.delay) await sleep(opts.delay);
      if (opts.empty) return [];
      return [own(q), shared()];
    },
    async getSeries(sid: string) { return { ...own('x'), sourceId: sid }; },
    async listChapters() { return []; },
    async getPageUrls() { return []; },
  };
}

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let lib: typeof import('../src/lib/searchAll');
let health: typeof import('../src/lib/sourceHealth');
let routes: typeof import('../src/routes/sources');
let adapters: Record<string, ReturnType<typeof fake>>;
let app: any;
let ids: { plain: string; capped: string };
let tok: (id: string) => Record<string, string>;

const hmap = async () => new Map((await health.healthAll()).map((h) => [h.source_id, h] as const));
const rowNow = async (id: string) => (await q(
  'SELECT status, consecutive, slow_streak, blocked_until, last_error FROM source_health WHERE source_id = $1', [id],
))[0];
/** The lib reports health without awaiting the write (as latestPage does), so a row is read once it has landed. */
const row = async (id: string) => {
  for (let i = 0; i < 100; i++) { const r = await rowNow(id); if (r) return r; await sleep(20); }
  return undefined;
};
const ALL = [FAST, SLOW1, SLOW2, HANG, CF, THROW, EMPTY, OFF, COOL, ADULT, DETAIL];

before(async () => {
  if (!DSN) return;
  ({ q } = await import('../src/lib/db'));
  await (await import('../src/lib/migrate')).migrate();
  lib = await import('../src/lib/searchAll');
  health = await import('../src/lib/sourceHealth');
  routes = await import('../src/routes/sources');
  const { registerAdapter } = await import('../src/lib/sources');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;

  adapters = {
    [FAST]: fake(FAST, 'Fast Source'),
    [SLOW1]: fake(SLOW1, 'Slow One', { delay: SLOW_MS }),
    [SLOW2]: fake(SLOW2, 'Slow Two', { delay: SLOW_MS }),
    [HANG]: fake(HANG, 'Hanging Source', { hang: true }),
    [CF]: fake(CF, 'Solver Source', { hang: true, cf: true }),
    [THROW]: fake(THROW, 'Refusing Source', { throws: 'HTTP 403 forbidden' }),
    [EMPTY]: fake(EMPTY, 'Empty Source', { empty: true }),
    [OFF]: fake(OFF, 'Disabled Source'),
    [COOL]: fake(COOL, 'Cooling Source'),
    [ADULT]: fake(ADULT, 'Adult Source', { isNsfw: true }),
    [DETAIL]: fake(DETAIL, 'Detail Source', { delay: 200 }),
  };
  // The detail lookup is two calls; the one that answers last is the one a second caller would wait on.
  adapters[DETAIL].getSeries = async (sid: string) => { calls[DETAIL]++; await sleep(200); return { sourceId: sid, source: DETAIL, title: 'Detail Title' }; };
  for (const a of Object.values(adapters)) registerAdapter(a as any);

  await q('DELETE FROM source_health WHERE source_id = ANY($1)', [ALL]);
  await q('DELETE FROM users WHERE username = ANY($1)', [USERS]);
  const mk = async (username: string, cap: number | null) =>
    (await q<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms, max_age_rating)
       VALUES ($1,$1,'x','user','password','{}',$2) RETURNING id`,
      [username, cap],
    ))[0].id;
  ids = { plain: await mk('sb-plain', null), capped: await mk('sb-capped', 13) };

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(routes.default);
  await app.ready();
  tok = (id: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub: id, role: 'user' })}` });
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  await q('DELETE FROM source_health WHERE source_id = ANY($1)', [ALL]);
  await q('DELETE FROM users WHERE username = ANY($1)', [USERS]);
});

test('the first answer comes a grace after the fast source, with the slow ones still pending', { skip }, async () => {
  // Reintroduce by making `graceEnd` Infinity in searchAll's wait loop (waiting for every source, as the
  // old fan-out did): the answer arrives when the slow pair settles at SLOW_MS, "pending" reads 0 and fails.
  const ask = [adapters[FAST], adapters[SLOW1], adapters[SLOW2]];
  const t0 = Date.now();
  const a = await lib.searchAll('Grace Term', ask as any, { waitMs: 6000, health: await hmap() });
  const ms = Date.now() - t0;
  assert.equal(a.pending, 2, `the slow pair should still be pending at the first answer (answered after ${ms}ms)`);
  assert.equal(a.asked, 3);
  assert.equal(a.per.get(FAST)?.state, 'ok');
  assert.equal(a.per.get(FAST)?.items.length, 2, 'the fast source\'s results are in the first answer');
  assert.ok(ms >= lib.SEARCH_GRACE_MS - 50, `answered at ${ms}ms, before the grace had run`);
  assert.ok(ms < lib.SEARCH_GRACE_MS + 700, `answered at ${ms}ms: the fast source was held hostage by the slow ones`);
  // The lines say the same thing, in the order the sources were asked, with a duration only for the settled.
  assert.deepEqual(a.sources.map((s) => [s.id, s.state, typeof s.ms]), [[FAST, 'ok', 'number'], [SLOW1, 'pending', 'undefined'], [SLOW2, 'pending', 'undefined']]);
});

test('a second search for the same term reads the entry: no adapter is asked again, and the rest fills in', { skip }, async () => {
  // Reintroduce by not storing the entry (drop `entries.set(key, entry)`): every call starts every source
  // again, so the wait=0 call below finds nothing ("did not hand back") and the counters move.
  const ask = [adapters[FAST], adapters[SLOW1], adapters[SLOW2]];
  const before = { [FAST]: calls[FAST], [SLOW1]: calls[SLOW1], [SLOW2]: calls[SLOW2] };
  const b = await lib.searchAll('grace-term', ask as any, { waitMs: 0, health: await hmap() });
  assert.equal(b.per.get(FAST)?.items.length, 2, 'the entry did not hand back what the fast source said');
  assert.equal(b.pending, 2, 'wait=0 must answer at once with whatever the entry holds');
  // Background work continues into the entry: a later call with a wait sees the slow pair settle.
  const c = await lib.searchAll('GRACE TERM', ask as any, { waitMs: 6000, health: await hmap() });
  assert.equal(c.pending, 0, 'the slow pair never settled into the entry');
  assert.equal(c.per.get(SLOW1)?.state, 'ok');
  assert.equal(c.per.get(SLOW2)?.items.length, 2);
  assert.deepEqual({ [FAST]: calls[FAST], [SLOW1]: calls[SLOW1], [SLOW2]: calls[SLOW2] }, before, 'a repeat search asked the sites again');
});

test('outrunning our own budget is recorded as slowness, never as a failure -- at the solver budget for a solver source', { skip }, async () => {
  // Reintroduce by routing the selfTimeout branch of askOne through reportFail: `consecutive` reads 1.
  const a = await lib.searchAll('Hang Term', [adapters[HANG], adapters[CF]] as any, { waitMs: 6000, health: await hmap() });
  assert.equal(a.per.get(HANG)?.state, 'timeout');
  assert.equal(a.per.get(CF)?.state, 'timeout');
  const h = await row(HANG);
  assert.equal(h.consecutive, 0, 'a self-timeout must never touch the failure counter');
  assert.equal(h.slow_streak, 1, 'and it must be counted as slowness');
  assert.equal(h.status, 'ok');
  assert.equal(h.last_error, 'timeout after 3000ms', 'the plain source got SEARCH_SOURCE_MS');
  // budgetFor: a source that declares the solver is given the solver's budget, not the search's.
  assert.equal((await row(CF)).last_error, 'timeout after 3600ms', 'the solver source was cut at the search budget');
});

test('a source that throws is recorded as a failure; an empty answer is recorded nowhere', { skip }, async () => {
  // Reintroduce by routing the catch's else-branch through reportSlow: `consecutive` reads 0 and status 'ok'.
  const a = await lib.searchAll('Throw Term', [adapters[THROW], adapters[EMPTY]] as any, { waitMs: 3000, health: await hmap() });
  assert.equal(a.per.get(THROW)?.state, 'failed');
  const h = await row(THROW);
  assert.equal(h.consecutive, 1, 'a refusal must count against the source');
  assert.equal(h.status, 'blocked', 'a 403 classifies as blocked, exactly as the newest listing would record it');
  assert.ok(h.blocked_until, 'and earns the cooldown');
  assert.equal(a.per.get(EMPTY)?.state, 'empty');
  assert.equal(await rowNow(EMPTY), undefined, 'not carrying a title is not a health event');
});

test('a disabled source and one serving a cooldown are skipped and never asked', { skip }, async () => {
  // Reintroduce by dropping the `h?.disabled` (or the `blocked_until`) check in searchAll: the counter moves.
  await health.setDisabled(OFF, true);
  await health.reportFail(COOL, 'blocked', 'HTTP 403');
  const a = await lib.searchAll('Skip Term', [adapters[FAST], adapters[OFF], adapters[COOL]] as any, { waitMs: 3000, health: await hmap() });
  assert.equal(calls[OFF], 0, 'the disabled source was asked');
  assert.equal(calls[COOL], 0, 'the cooling source was asked -- that is what the cooldown is FOR');
  assert.equal(a.asked, 1);
  assert.equal(a.pending, 0);
  assert.deepEqual(a.sources.filter((s) => s.id !== FAST), [
    { id: OFF, name: 'Disabled Source', state: 'skipped', why: 'disabled' },
    { id: COOL, name: 'Cooling Source', state: 'skipped', why: 'cooldown' },
  ]);
  assert.equal(a.per.get(OFF)?.state, 'skipped');
});

test('THE LEAK: the shared entry never hands a capped viewer a source outside their reach', { skip }, async () => {
  // An uncapped viewer searches first, so the entry holds the adult source's answer. Reintroduce by
  // building the answer from the entry's own keys (`for (const [id] of entry.per)`) instead of the caller's
  // ask order: the adult id appears in `sources` and in the card's providers.
  const plain = await app.inject({ method: 'GET', url: '/api/sources/search-all?q=Shared%20Title', headers: tok(ids.plain) });
  assert.equal(plain.statusCode, 200);
  const pj = plain.json();
  assert.ok(pj.content.some((g: any) => g.providers.some((p: any) => p.source === ADULT)), 'the uncapped viewer lost the adult source');
  assert.ok(pj.sources.some((s: any) => s.id === ADULT), 'the uncapped viewer\'s lines lost the adult source');
  assert.equal(calls[ADULT], 1);

  const capped = await app.inject({ method: 'GET', url: '/api/sources/search-all?q=Shared%20Title', headers: tok(ids.capped) });
  assert.equal(capped.statusCode, 200);
  const cj = capped.json();
  const providers = cj.content.flatMap((g: any) => g.providers.map((p: any) => p.source));
  assert.equal(providers.includes(ADULT), false, 'search-all handed a 13+ account the adult source from the cache');
  assert.equal(cj.sources.some((s: any) => s.id === ADULT), false, 'the progress lines name the adult source to a 13+ account');
  assert.equal(JSON.stringify(cj).includes('Adult Source'), false, 'the adult source\'s name crossed the wire');
  assert.equal(calls[ADULT], 1, 'the capped viewer\'s search asked the adult source');
  // And the capped viewer still gets the shared card, with everyone else on it.
  assert.ok(cj.content.some((g: any) => g.title === 'Shared Title' && g.providers.some((p: any) => p.source === FAST)));
});

test('both shapes are what they always were, with the progress fields beside them', { skip }, async () => {
  // Reintroduce by renaming a key in groupByTitle/bySource (say `providers` to `sources`): the key lists differ.
  const before = calls[FAST];
  const r = await app.inject({ method: 'GET', url: '/api/sources/search-all?q=Shared%20Title&wait=0', headers: tok(ids.plain) });
  const j = r.json();
  assert.deepEqual(Object.keys(j).sort(), ['asked', 'content', 'pending', 'sources']);
  const card = j.content.find((g: any) => g.title === 'Shared Title');
  assert.ok(card, 'the shared title was not folded into one card');
  assert.deepEqual(Object.keys(card).sort(), ['inLibrary', 'providers', 'title', 'updatedAt'], 'the card shape changed');
  assert.deepEqual(Object.keys(card.providers[0]).sort(), ['name', 'source', 'sourceId', 'title'], 'the provider shape changed');
  assert.equal(j.content[0], card, 'the card with the most providers is not first');
  assert.equal(card.inLibrary, false);
  assert.deepEqual(Object.keys(j.sources[0]).sort(), ['id', 'ms', 'name', 'state'], 'the source line shape changed');
  assert.equal(typeof j.pending, 'number');
  assert.equal(typeof j.asked, 'number');

  const s = await app.inject({ method: 'GET', url: '/api/sources/search-all?q=Shared%20Title&groupBy=source&wait=0', headers: tok(ids.plain) });
  const sj = s.json();
  assert.deepEqual(Object.keys(sj).sort(), ['asked', 'content', 'pending', 'sources']);
  const rail = sj.content.find((g: any) => g.source === FAST);
  assert.ok(rail, 'the fast source has no rail');
  assert.deepEqual(Object.keys(rail).sort(), ['lang', 'name', 'results', 'source'], 'the rail shape changed');
  assert.deepEqual(Object.keys(rail.results[0]).sort(), ['coverUrl', 'inLibrary', 'name', 'source', 'sourceId', 'title'], 'the result shape changed');
  assert.equal(rail.results[0].name, 'Fast Source', 'a result no longer carries its source\'s display name');
  assert.equal(sj.content.some((g: any) => g.source === EMPTY), false, 'a source with nothing must not get an empty rail');
  // wait=0 read the entry: nothing was asked again for either shape.
  assert.equal(calls[FAST], before, 'the shapes re-asked the fast source');
});

test('an empty term answers the same shape without asking anyone', { skip }, async () => {
  const r = await app.inject({ method: 'GET', url: '/api/sources/search-all?q=%20', headers: tok(ids.plain) });
  assert.deepEqual(r.json(), { content: [], sources: [], pending: 0, asked: 0 });
});

test('after the TTL the sources are asked again', { skip }, async () => {
  // Reintroduce by dropping the TTL check at the top of searchAll: the entry answers forever and the
  // counter does not move.
  const before = calls[FAST];
  lib.ageSearchCache(lib.SEARCH_TTL_MS);
  const a = await lib.searchAll('Grace Term', [adapters[FAST]] as any, { waitMs: 3000, health: await hmap() });
  assert.equal(calls[FAST], before + 1, 'an expired entry still answered instead of asking again');
  assert.equal(a.per.get(FAST)?.state, 'ok');
});

test('evicting pending entries cancels their queued source work', { skip }, async () => {
  // Concurrency bounds what is active, but without queue cancellation every evicted term remains retained
  // behind the lane and eventually reaches the source. Add enough overflow to evict both active and queued
  // entries: active work may finish, while evicted queued work must never start.
  lib.clearSearchCache();
  let started = 0;
  const releases: Array<() => void> = [];
  const queued = {
    id: 'sb-queue', name: 'Queued Source', requiresCloudflare: false,
    search: async () => {
      started++;
      await new Promise<void>((resolve) => releases.push(resolve));
      return [];
    },
    getSeries: async () => null, listChapters: async () => [], getPageUrls: async () => [],
  };
  const total = lib.SEARCH_CACHE_MAX + lib.SEARCH_CONCURRENCY + 3;
  for (let i = 0; i < total; i++) {
    await lib.searchAll(`Queue ${i}`, [queued] as any, { waitMs: 0, health: new Map() });
  }
  assert.equal(started, lib.SEARCH_CONCURRENCY, 'more work than the lane width started at once');

  let released = 0;
  while (released < releases.length) {
    const batch = releases.slice(released);
    released = releases.length;
    for (const resolve of batch) resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(started, lib.SEARCH_CACHE_MAX + lib.SEARCH_CONCURRENCY,
    'queued searches from evicted entries still reached the source');
  lib.clearSearchCache();
});

test("normTerm is the route's norm, title for title", { skip }, () => {
  // The entry key and the title grouping use the lib's copy; the library check uses the route's. Two rules
  // would be two answers to "is this the same title". The titles cover every class the rule strips (space,
  // apostrophe, colon, hyphen, brackets, digits kept, non-Latin dropped), so letting any one of them through
  // on one side shows. Reintroduce by changing either regex (say, keeping `-` in normTerm): Re:Zero disagrees.
  for (const t of ['Solo Leveling', "JoJo's Bizarre Adventure: Part 7", 'ONE PIECE!!', 'Re:Zero -Starting Life in Another World-', 'Kimetsu no Yaiba — 鬼滅の刃 (2019)']) {
    assert.equal(lib.normTerm(t), routes.norm(t), `the two rules disagree on "${t}"`);
  }
  assert.equal(lib.normTerm('SOLO LEVELING!'), 'sololeveling', 'the rule itself changed');
});

test('the detail lookup is one fetch for a pre-warm and the pick that joins it, then a cached answer', { skip }, async () => {
  // The add dialog fetches a card's first providers' detail the moment the card opens; the pick arrives
  // while that is still in flight and used to start a second fetch of its own -- two challenge solves for
  // one answer. Reintroduce by dropping the `detailInflight.get(key)` return in seriesAndChapters: the
  // two concurrent callers count as two fetches.
  routes.clearDetailCache();
  const src = adapters[DETAIL] as any;
  calls[DETAIL] = 0;
  const [a, b] = await Promise.all([routes.seriesAndChapters(src, 'd-1'), routes.seriesAndChapters(src, 'd-1')]);
  assert.equal(calls[DETAIL], 1, 'two concurrent lookups of the same pair fetched twice');
  assert.equal(a.series?.title, 'Detail Title');
  assert.equal(b, a, 'the joiner did not get the same answer object as the fetcher');
  const c = await routes.seriesAndChapters(src, 'd-1');
  assert.equal(calls[DETAIL], 1, 'a lookup inside the TTL fetched again');
  assert.equal(c.series?.title, 'Detail Title');
  routes.clearDetailCache();
  await routes.seriesAndChapters(src, 'd-1');
  assert.equal(calls[DETAIL], 2, 'clearDetailCache left the answer behind');
});
