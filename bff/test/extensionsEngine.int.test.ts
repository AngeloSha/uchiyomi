// Admin → Extensions' engine status, Check again, Connect, and Health's engine row, against the strict fake
// engine (#72).
//
// The routes as the page drives them: GET /api/admin/extensions/status while the engine is down and after it
// came back (the self-heal that makes "Check again" bring the extensions back at once), the retry it shows,
// POST /api/admin/extensions/solver pointing the engine's own Cloudflare helper at Uchiyomi's -- through the
// engine's real setSettings, checked against the pinned schema -- and the Health check's 3-second limit and
// Cloudflare evidence.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const DSN = process.env.TEST_DATABASE_URL;
/** Uchiyomi's own solver (FLARESOLVERR_URL): the fake below, so Health can ping what Connect points the engine at. */
let OURS = '';
const SERIES = ['s_ee_one', 's_ee_two', 's_ee_gone', 's_ee_merged'];

/**
 * A FlareSolverr as its root answers a ping, and nothing more; `stop` is the container gone. `answerOnce` makes it
 * answer the next request and refuse every one after it -- two pings a moment apart that disagree -- and counts them.
 */
async function startFakeSolver() {
  let asked = 0;
  let once = false;
  const srv = createServer((_req, res) => {
    asked++;
    if (once && asked > 1) { res.writeHead(503); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ msg: 'FlareSolverr is ready!', version: '3.4.6' }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as { port: number };
  let open = true;
  // Keep-alive sockets included: a closed server still answers on a connection fetch kept open.
  const stop = () => (open ? new Promise<void>((r) => { open = false; srv.closeAllConnections(); srv.close(() => r()); }) : Promise.resolve());
  const answerOnce = (on: boolean) => { once = on; asked = 0; };
  return { url: `http://127.0.0.1:${port}`, stop, answerOnce, asked: () => asked };
}

async function setup() {
  const { startFakeSuwayomi, SOURCE_IDS } = await import('./fixtures/fakeSuwayomi');
  const fake = await startFakeSuwayomi();
  const solver = await startFakeSolver();
  OURS = solver.url;
  // ⚠️ Before anything from src: env.ts reads these once.
  process.env.DATABASE_URL = DSN;
  process.env.SUWAYOMI_URL = fake.url;
  process.env.EXTENSION_ENGINE = '1'; // as every v0.49.0 compose file passes it: the platform reads "compose"
  process.env.FLARESOLVERR_URL = OURS;
  process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';
  delete process.env.UCHIYOMI_PLATFORM;
  delete process.env.HOST_OS;
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const reg = await import('../src/lib/sources/suwayomi/register');
  const adminRoutes = (await import('../src/routes/admin')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await migrate();

  await q('DELETE FROM suwayomi_sources');
  await q(`DELETE FROM source_health WHERE source_id LIKE 'sw:%'`);
  await q(`INSERT INTO suwayomi_sources (source_id, name, lang, enabled) VALUES ($1,'Manga Ball','en',true), ($2,'Webtoons.com','en',true)`,
    [SOURCE_IDS.mangaBall, SOURCE_IDS.webtoons]);
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [SERIES]);
  for (const [id, deleted] of [['s_ee_one', false], ['s_ee_two', false], ['s_ee_gone', true]] as const) {
    await q(`INSERT INTO lib_series (id, source, title, folder, source_id, source_series_id, deleted_at)
             VALUES ($1,'test',$1,$1,$2,'1',$3)`, [id, `sw:${SOURCE_IDS.mangaBall}`, deleted ? new Date() : null]);
  }
  // Folded into s_ee_one: its chapters are the survivor's, and nothing routes it through the engine any more.
  await q(`INSERT INTO lib_series (id, source, title, folder, source_id, source_series_id, merged_into)
           VALUES ('s_ee_merged','test','s_ee_merged','s_ee_merged',$1,'2','s_ee_one')`, [`sw:${SOURCE_IDS.mangaBall}`]);
  await q(`DELETE FROM users WHERE username = 'ee-admin'`);
  const admin = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ('ee-admin','ee-admin','x','admin','password') RETURNING id`,
  ))[0].id;

  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(adminRoutes);
  await app.ready();
  const auth = { authorization: `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}` };
  const status = async () => (await app.inject({ method: 'GET', url: '/api/admin/extensions/status', headers: auth })).json();
  const connect = () => app.inject({ method: 'POST', url: '/api/admin/extensions/solver', headers: auth, payload: {} });
  return { fake, solver, q, reg, app, status, connect, SOURCE_IDS };
}

test('the extension engine, as Admin → Extensions and Health see it', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async (t) => {
  const { fake, solver, q, reg, app, status, connect, SOURCE_IDS } = await setup();
  const quiet = [console.warn, console.log] as const;
  console.warn = () => {};
  console.log = () => {};
  try {
    /**
     * Reintroduce by removing the self-heal from engineStatusReport (the `retrySuwayomiNow()` line): the engine
     * answers, but "registered" stays 0 -- Check again cannot bring back a registration that missed the engine,
     * and the page waits up to five minutes for the loop.
     */
    await t.test('Check again after the engine came back registers its sources at once', async () => {
      await fake.stop();
      const missed = await reg.loadSuwayomiSources();
      assert.equal(missed.reachable, false, 'the fake engine is down');
      const down = await status();
      assert.equal(down.configured, true);
      assert.equal(down.reachable, false);
      assert.ok(down.error, 'the reason it did not answer is shown');
      assert.equal(down.platform, 'compose');
      // Reintroduce by counting `deleted_at IS NULL` alone (as linkedSeriesCount first did): the merged-away row is
      // counted and this reads 3 -- and predicateHygiene.test.ts names the hand-written predicate.
      assert.equal(down.linkedSeries, 2, 'the series added through an extension, not the removed or merged-away one');
      assert.equal(down.engine, new URL(fake.url).host);
      assert.equal(down.retry, null, 'no loop was started in this test');
      assert.ok(Date.parse(down.lastTry) > 0, 'when it last tried');
      assert.equal(down.lastTryOk, false, 'and that it did not answer');
      assert.equal(down.solver, undefined, 'nothing to say about the helper of an engine that does not answer');

      await fake.start();
      const back = await status();
      assert.equal(back.reachable, true);
      assert.equal(back.registered, 2, 'the two enabled sources are registered by the status call itself');
      assert.equal(reg.lastSuwayomiLoad()?.reachable, true);
      assert.deepEqual(back.solver, { supported: true, enabled: false, wiring: 'off', connectable: true, url: 'http://localhost:8191' },
        'a fresh engine: its helper off, at its default address');
    });

    /**
     * v0.49.1: "Last tried" was the last registration. An engine that stops answering after a good one starts no retry,
     * so right after Check again the card named that registration, hours back, as its last try. Reintroduce by
     * answering the last load's time again (`lastSuwayomiLoadAt`, or noteSuwayomiTry out of engineStatusReport): the
     * look this call made is not the one named.
     */
    await t.test('Last tried is the last attempt to reach the engine, and says how it went', async () => {
      const loaded = await reg.loadSuwayomiSources();
      assert.equal(loaded.reachable, true, 'PREMISE: a registration that found the engine');
      const loadedAt = Date.now();
      await new Promise((r) => setTimeout(r, 25));
      await fake.stop();
      try {
        const s = await status();
        assert.equal(s.reachable, false);
        assert.equal(s.retry, null, 'PREMISE: no retry runs after a good registration');
        assert.ok(Date.parse(s.lastTry) > loadedAt, `the look this call made is the last try, not the registration before it (${s.lastTry})`);
        assert.equal(s.lastTryOk, false, 'and it did not answer');
      } finally {
        await fake.start();
      }
      const back = await status();
      assert.equal(back.lastTryOk, true, 'the engine back: the last try answered');
    });

    /**
     * v0.49.1: Health's look at the engine is a try too (extensionEngine.ts engineProbe notes it), so the card's "Last
     * tried" never names an older good one over it. Reintroduce by leaving it out (drop noteSuwayomiTry from
     * engineProbe): after a good registration, a probe that found the engine gone leaves the last try a good one.
     */
    await t.test("Health's look at the engine is a try of its own", async () => {
      const { engineProbe, forgetEngineProbe } = await import('../src/lib/extensionEngine');
      const loaded = await reg.loadSuwayomiSources();
      assert.equal(loaded.reachable, true, 'PREMISE: a registration that found the engine');
      assert.equal(reg.lastSuwayomiTry()?.ok, true, 'PREMISE: and that is the last try');
      await fake.stop();
      forgetEngineProbe();
      try {
        const probe = await engineProbe();
        assert.equal(probe.reachable, false, 'PREMISE: Health found the engine gone');
        assert.equal(reg.lastSuwayomiTry()?.ok, false, "Health's look at an engine that stopped answering is not the last try");
      } finally {
        await fake.start();
        forgetEngineProbe();
      }
    });

    await t.test('while the retry runs, the page can say how often it asked and when it asks next', async () => {
      await fake.stop();
      await reg.loadSuwayomiSources();
      reg.scheduleSuwayomiRetry([60_000], 60_000);
      try {
        const s = await status();
        assert.equal(s.reachable, false);
        assert.equal(s.retry.attempts, 1);
        assert.ok(Date.parse(s.retry.nextAt) > Date.parse(s.retry.since), 'the next try is after the start');
      } finally {
        reg.stopSuwayomiRetry();
        await fake.start();
        await reg.loadSuwayomiSources();
      }
    });

    /**
     * Reintroduce the automatic version (call setEngineSolver from engineStatusReport): the status GET changes the
     * engine's settings before anyone pressed anything, and "nothing changes the engine until Connect" fails.
     */
    await t.test("Connect points the engine's helper at Uchiyomi's, and only when pressed", async () => {
      await status();
      assert.equal(fake.graphqlCalls('setSettings').length, 0, 'nothing changes the engine until Connect');
      const before = fake.graphqlCalls().length;
      const r = await connect();
      assert.equal(r.statusCode, 200, r.body);
      assert.deepEqual(r.json(), { ok: true, enabled: true, wiring: 'ok' });
      assert.equal(fake.settings.flareSolverrEnabled, true);
      assert.equal(fake.settings.flareSolverrUrl, OURS);
      const calls = fake.graphqlCalls().slice(before);
      assert.deepEqual(calls.map((c) => c.fields?.[0]), ['settings', 'setSettings'], 'read first, then write');
      assert.ok(calls.every((c) => c.status === 'ok'), 'the engine accepted both');
      const audit = await q<{ detail: any }>(`SELECT detail FROM audit_log WHERE event = 'extension.solver' ORDER BY at DESC LIMIT 1`);
      assert.deepEqual(audit[0].detail, { wasEnabled: false, host: new URL(OURS).host });
      assert.ok(!JSON.stringify(audit[0].detail).includes('http'), 'the audit carries the host, never the address');
      assert.equal((await status()).solver.wiring, 'ok');
    });

    await t.test('no solver of our own: Connect refuses and the engine is left alone', async () => {
      const saved = process.env.FLARESOLVERR_URL;
      delete process.env.FLARESOLVERR_URL;
      try {
        const writes = fake.graphqlCalls('setSettings').length;
        const r = await connect();
        assert.equal(r.statusCode, 400);
        assert.equal(r.json().error, 'no_solver');
        assert.equal(fake.graphqlCalls('setSettings').length, writes, 'nothing was written');
        assert.equal((await status()).solver.connectable, false, 'the page knows not to offer it');
      } finally {
        process.env.FLARESOLVERR_URL = saved;
      }
    });

    await t.test('an engine that does not answer: 502, with its reason', async () => {
      await fake.stop();
      try {
        const r = await connect();
        assert.equal(r.statusCode, 502);
        assert.equal(r.json().error, 'unreachable');
      } finally {
        await fake.start();
      }
    });

    /**
     * Reintroduce by letting the probe use gql's own timeouts (drop the PROBE_TIMEOUT_MS wrapper in engineProbe):
     * the Health check waits the engine's full 8 seconds, and "Health never waits" fails.
     */
    await t.test('Health never waits on a slow engine, and asks it at most every 30 seconds', async () => {
      const { extensionEngineCheck } = await import('../src/lib/engineHealth');
      const { forgetEngineProbe } = await import('../src/lib/extensionEngine');
      fake.setMode({ mode: 'slow', ms: 9_000 });
      forgetEngineProbe();
      try {
        const t0 = Date.now();
        const c = await extensionEngineCheck();
        const took = Date.now() - t0;
        assert.ok(took < 4_500, `Health waited ${took} ms on the engine`);
        assert.equal(c?.status, 'warn');
        assert.match(c!.summary, /^Not answering/);
        const asked = fake.graphqlCalls().length;
        await extensionEngineCheck();
        assert.equal(fake.graphqlCalls().length, asked, 'a second Health read inside 30 s asks the engine nothing');
      } finally {
        fake.setMode('up');
        forgetEngineProbe();
      }
    });

    /**
     * #115's evidence meets #72's check. Reintroduce by dropping the `stages` arm from cloudflareEvidence: a
     * failure recorded only by a Test (the stage evidence #115 writes) no longer turns the row amber.
     */
    await t.test("a helper that is off turns the row amber once an extension is seen failing on it, and Connect clears it", async () => {
      const { extensionEngineCheck } = await import('../src/lib/engineHealth');
      const { forgetEngineProbe } = await import('../src/lib/extensionEngine');
      fake.reset();
      forgetEngineProbe();
      await reg.loadSuwayomiSources();
      const clean = await extensionEngineCheck();
      assert.equal(clean?.status, 'ok', 'off, but nothing is seen failing because of it');
      assert.deepEqual(clean?.items[0]?.actions, ['engine_solver']);

      const failAt = new Date().toISOString();
      await q(`INSERT INTO source_health (source_id, status, stages) VALUES ($1, 'ok', $2::jsonb)`, [
        `sw:${SOURCE_IDS.mangaBall}`,
        JSON.stringify({ search: { failAt, failBy: 'test', error: 'suwayomi: Exception while fetching data (/fetchSourceManga) : java.io.IOException: Cloudflare bypass currently disabled', kind: 'error' } }),
      ]);
      forgetEngineProbe();
      const amber = await extensionEngineCheck();
      assert.equal(amber?.status, 'warn', 'a failure a Test recorded turns the row amber');
      assert.equal(amber?.items.filter((i) => !i.info).length, 1);
      assert.deepEqual(amber?.items[0].actions, ['engine_solver']);
      assert.match(amber!.items[0].detail, /Manga Ball.* fails because of it/, 'the source it breaks is named');

      const r = await connect();
      assert.equal(r.statusCode, 200);
      const fixed = await extensionEngineCheck();
      assert.equal(fixed?.status, 'ok', 'Connect forgot the cached look, so the row clears at once');
      assert.match(fixed!.summary, /^Ready, and it can get past Cloudflare/);
    });

    /**
     * v0.49.1: the two rows read ONE ping of the solver (flaresolverr.ts solverPingShared). Two pings a moment apart
     * can disagree, and the page said "can get past Cloudflare" in one row beside "Not answering" in the other; a
     * solver that answers only its first request is that moment. Reintroduce by pinging in each row (solverPing in
     * engineHealth.ts extensionEngineCheck, or in health.ts solverHealth): the rows disagree.
     */
    await t.test("Health's engine row and solver row read one ping of the solver", async () => {
      const { extensionEngineCheck } = await import('../src/lib/engineHealth');
      const { solverHealth } = await import('../src/lib/health');
      const { forgetEngineProbe } = await import('../src/lib/extensionEngine');
      const { forgetSolverPing } = await import('../src/lib/sources/flaresolverr');
      assert.equal(fake.settings.flareSolverrUrl, OURS, 'PREMISE: the engine is connected to our solver');
      forgetEngineProbe();
      forgetSolverPing();
      solver.answerOnce(true);
      // A solver that answers has its row ask GitHub for its latest release: no opinion here, and nothing leaves.
      const realFetch = globalThis.fetch;
      globalThis.fetch = ((u: any, init?: any) => (String(u).startsWith('https://api.github.com/')
        ? Promise.resolve(new Response('', { status: 404 })) : realFetch(u, init))) as typeof fetch;
      try {
        const [engineRow, solverRow] = await Promise.all([extensionEngineCheck(), solverHealth()]);
        const solverUp = !/^Not answering/.test(solverRow.summary);
        const engineUp = !/Cloudflare helper is not answering/i.test(engineRow!.summary);
        assert.equal(engineUp, solverUp, `the two rows disagree about the solver: "${engineRow!.summary}" beside "${solverRow.summary}"`);
        assert.equal(solver.asked(), 1, 'the solver was asked once for both rows');
      } finally {
        globalThis.fetch = realFetch;
        solver.answerOnce(false);
        forgetSolverPing();
      }
    });

    /**
     * v0.49.1: after Connect the engine's way past Cloudflare IS Uchiyomi's solver, and the engine row said "it can get
     * past Cloudflare" beside the solver row's "Not answering". Reintroduce by leaving the solver out of the engine row
     * (drop `solverAnswering` from extensionEngineCheck): the engine row reads it can.
     */
    await t.test("with Uchiyomi's solver down, Health's engine row and solver row say the same", async () => {
      const { extensionEngineCheck } = await import('../src/lib/engineHealth');
      const { solverHealth } = await import('../src/lib/health');
      const { forgetEngineProbe } = await import('../src/lib/extensionEngine');
      const { forgetSolverPing } = await import('../src/lib/sources/flaresolverr');
      assert.equal(fake.settings.flareSolverrUrl, OURS, 'PREMISE: the engine is connected to our solver');
      await solver.stop();
      forgetEngineProbe();
      forgetSolverPing();
      const [engineRow, solverRow] = await Promise.all([extensionEngineCheck(), solverHealth()]);
      assert.match(solverRow.summary, /^Not answering/, 'PREMISE: the solver row says it is down');
      assert.doesNotMatch(engineRow!.summary, /can get past Cloudflare/, 'the engine row says it can get past Cloudflare beside a solver that is down');
      assert.match(engineRow!.summary, /its Cloudflare helper is not answering/i);
      // Manga Ball is still seen failing behind Cloudflare (the test before this one): a finding, not a greyed line.
      assert.equal(engineRow!.status, 'warn');
      assert.match(engineRow!.items[0].detail, /Cloudflare solver row/);
    });
  } finally {
    console.warn = quiet[0];
    console.log = quiet[1];
    reg.stopSuwayomiRetry();
    await app.close();
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [SERIES]).catch(() => {});
    await q(`DELETE FROM source_health WHERE source_id LIKE 'sw:%'`).catch(() => {});
    await fake.close();
    await solver.stop();
    const { pool } = await import('../src/lib/db');
    await pool.end().catch(() => {});
  }
});
