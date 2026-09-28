// "The site says it is offline" end to end (v0.49.1): a real Madara engine whose site answers every request with its
// own offline notice (aqua's shape, HTTP 200), against the real updater, Discover's newest listing, the Test button
// and Health.
//
// What aqua did to v0.49.0, and must not do any more: the sweep took the notice for an empty listing, Discover counted
// it into the empty streak, and Health said "no results -- markup may not match this engine". Now the source is one
// that did not answer: the listing stands, no empty streak grows, the #115 evidence carries `site_offline` at the
// stage it happened, and the diagnosis says the site says it is offline.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.SOURCE_TEST_TIMEOUT_MS = '3000';
  // The shared withTimeout leaves its timer armed until it fires; a solver-fronted engine's budget is 90 s by default,
  // which would hold the process that long after the last test.
  process.env.SOLVER_BUDGET_MS = '2000';
  process.env.UPDATER_LIST_TIMEOUT_MS = '2000';
  process.env.SOURCE_LATEST_TIMEOUT_MS = '2000';
  process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const AQUA = 'so-aqua', BASE = 'https://so-aqua.test';
const LIB = 'lib_so', SERIES = 's_so_1', ADMIN = 'so-admin';
const OFFLINE = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Aqua Manga is temporarily offline</title>
<style>.card{max-width:440px;margin:10vh auto;padding:32px;border-radius:16px;background:#111a2e;color:#e2e8f0;text-align:center}</style></head>
<body><div class="card"><h1>We'll be back soon</h1><p>Aqua Manga is temporarily offline while we work on the site.</p>
<a href="https://discord.gg/aquamanga">Join our Discord</a></div></body></html>`;
const NOTICE = 'site_offline: the site says it is offline ("Aqua Manga is temporarily offline")';

let q: any, app: any, adminAuth: Record<string, string>;
const realFetch = globalThis.fetch;

before(async () => {
  if (!DSN) return;
  // FlareSolverr's HTTP API, answering every solve with the notice and a 200, as aqua's origin does; the bare
  // homepage probe of the Test button gets the same page. Nothing else in these paths leaves the process.
  globalThis.fetch = (async (u: any, init: any) => {
    const url = init?.body ? JSON.parse(init.body).url : String(u);
    if (init?.body) {
      return new Response(JSON.stringify({ status: 'ok', solution: { url, status: 200, response: OFFLINE, cookies: [], userAgent: 't' } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(OFFLINE, { status: 200, headers: { 'content-type': 'text/html' } });
  }) as any;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  await migrate();
  const { registerAdapter } = await import('../src/lib/sources');
  const { makeMadara } = await import('../src/lib/sources/engines/madara');
  registerAdapter(makeMadara({ id: AQUA, name: 'Aqua Test', base: BASE }));
  (await import('../src/lib/healthSummary')).setSummaryRefresh(async () => {}, { everyMs: 1 });
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'SO',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q('DELETE FROM users WHERE username = $1', [ADMIN]);
  const uid = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','admin','password') RETURNING id`, [ADMIN]))[0].id;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/sources')).default);
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  adminAuth = { authorization: `Bearer ${app.jwt.sign({ sub: uid, role: 'admin' })}` };
});

beforeEach(async () => {
  if (!DSN) return;
  await q('DELETE FROM lib_series WHERE library_id = $1', [LIB]);
  await q('DELETE FROM source_health WHERE source_id = $1', [AQUA]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update, source_chapters)
           VALUES ($1,'Aqua Test','Offline Tale',$1,0,$2,$3,$4,true,10)`, [SERIES, LIB, AQUA, `${BASE}/manga/offline-tale/`]);
  for (let n = 1; n <= 10; n++) {
    await q(`INSERT INTO series_listing (series_id, number, source_id, chosen) VALUES ($1,$2,$3,$4::jsonb)`,
      [SERIES, n, AQUA, JSON.stringify({ sourceId: `${BASE}/manga/offline-tale/chapter-${n}/`, number: n, source: AQUA })]);
  }
});

after(async () => {
  globalThis.fetch = realFetch;
  if (!DSN) return;
  (await import('../src/lib/healthSummary')).setSummaryRefresh();
  await app?.close();
  await q('DELETE FROM lib_series WHERE library_id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [ADMIN]).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = $1', [AQUA]).catch(() => {});
  await (await import('../src/lib/db')).pool.end().catch(() => {});
});

const health = async () => (await q('SELECT * FROM source_health WHERE source_id = $1', [AQUA]))[0];

test('the sweep takes the notice for a source that did not answer: the listing stands, the evidence says site_offline', { skip }, async () => {
  const { updateSeries } = await import('../src/lib/updater');
  const r = await updateSeries(SERIES, 5);
  // Reintroduce by letting Madara's listChapters answer [] for the notice (drop its throwIfOffline): the outcome is
  // `ok` over an empty listing, source_chapters reads 0, and no evidence is written.
  assert.equal(r.outcome, 'source_error');
  assert.equal(r.added, 0);
  assert.equal((await q('SELECT count(*)::int AS n FROM series_listing WHERE series_id = $1', [SERIES]))[0].n, 10, 'the listing stands');
  const [row] = await q('SELECT source_chapters FROM lib_series WHERE id = $1', [SERIES]);
  assert.notEqual(row.source_chapters, 0, 'no "the source lists nothing" stamped over the series');
  await new Promise((res) => setTimeout(res, 100)); // noteStage is detached
  const h = await health();
  // Reintroduce by dropping the kind from noteStage (sourceHealth.ts): the kind reads 'error'.
  assert.equal(h.stages.chapters.kind, 'site_offline');
  assert.equal(h.stages.chapters.error, NOTICE);
  assert.equal(h.status, 'ok', 'evidence only: the sweep never escalates a cooldown');
  assert.equal(h.empty_streak, 0);
});

test("Discover's newest listing counts no empty streak for the notice, and Health says what the site said", { skip }, async () => {
  const r = await app.inject({ method: 'GET', url: `/api/sources/latest?source=${AQUA}&adult=1`, headers: adminAuth });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().content, []);
  await new Promise((res) => setTimeout(res, 100));
  const h = await health();
  // Reintroduce by answering [] for the notice (Madara's `listing`): reportLatest counts empty_streak 1.
  assert.equal(h.empty_streak, 0);
  assert.equal(h.last_error, NOTICE);
  // The stored words alone are read as the site saying so, not as markup drift.
  const { runHealthChecks } = await import('../src/lib/health');
  const sources = (await runHealthChecks()).checks.find((c) => c.id === 'sources')!;
  const row = sources.items.find((i) => i.sourceId === AQUA)!;
  assert.equal(row.diagnosis!.code, 'site_offline');
  assert.equal(row.diagnosis!.fix, 'Wait for the site to come back, or find other sources for its series.');
});

test('the Test button fails the source at search with kind site_offline, and Health leads with it', { skip }, async () => {
  const r = await app.inject({ method: 'POST', url: `/api/admin/sources/${AQUA}/test`, headers: adminAuth });
  assert.equal(r.statusCode, 200, r.body);
  const t = r.json();
  assert.equal(t.ok, false);
  assert.equal(t.state, 'fail');
  assert.equal(t.stage, 'search');
  // Reintroduce by recording a thrown error as kind 'error' in the smoke test: the diagnosis reads unknown.
  assert.equal(t.checks[0].kind, 'site_offline');
  assert.equal(t.diagnosis.code, 'site_offline');
  assert.equal(t.diagnosis.reason, 'The site says it is offline (its own page)');
  const { runHealthChecks } = await import('../src/lib/health');
  const row = (await runHealthChecks()).checks.find((c) => c.id === 'sources')!.items.find((i) => i.sourceId === AQUA)!;
  assert.equal(row.info, undefined, 'a confirmed failure, not a greyed row');
  assert.match(row.detail, /^Search failing since .* — The site says it is offline \(its own page\)\. /);
  assert.equal(row.diagnosis!.code, 'site_offline');
  assert.equal(row.evidence!.find((e) => e.stage === 'search')!.kind, 'site_offline');
  assert.ok(row.actions!.includes('find_sources'), 'its series need other sources');
  assert.equal(row.findSeries, 1);
});
