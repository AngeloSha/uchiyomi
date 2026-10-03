// EXTENSION_ENGINE=0 with the bundled address: the engine was switched off on purpose (#72).
//
// Its own file because env.ts reads the switch once per process: this one runs as a Compose install whose .env
// says EXTENSION_ENGINE=0 while SUWAYOMI_URL still names uchiyomi-suwayomi. The status route says WHY there is no
// engine (so the setup screen can say "turned off" rather than "not answering" or "not set up"), Connect is
// refused like every extension route, Health's engine row is an info line, and the series that came from
// extensions wait "because the extension engine is off" -- not over a source limit.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.SUWAYOMI_URL = 'http://uchiyomi-suwayomi:4567';
  process.env.EXTENSION_ENGINE = '0';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  delete process.env.UCHIYOMI_PLATFORM;
  delete process.env.HOST_OS;
}
const SERIES = ['s_eo_one', 's_eo_two'];

test('the engine switched off on purpose', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async (t) => {
  const { migrate } = await import('../src/lib/migrate');
  const { q, pool } = await import('../src/lib/db');
  const adminRoutes = (await import('../src/routes/admin')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await migrate();
  await q('DELETE FROM suwayomi_sources');
  await q(`DELETE FROM lib_series WHERE source_id LIKE 'sw:%'`);
  await q(`INSERT INTO suwayomi_sources (source_id, name, lang, enabled) VALUES ('77001','Engine Off Source','en',true)`);
  for (const id of SERIES) {
    await q(`INSERT INTO lib_series (id, source, title, folder, source_id, source_series_id, books_count)
             VALUES ($1,'test',$1,$1,'sw:77001','1',4)`, [id]);
  }
  await q(`DELETE FROM users WHERE username = 'eo-admin'`);
  const admin = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ('eo-admin','eo-admin','x','admin','password') RETURNING id`,
  ))[0].id;
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(adminRoutes);
  await app.ready();
  const auth = { authorization: `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}` };
  try {
    /**
     * Reintroduce by answering the old `{ configured: false, reachable: false }`: the setup screen cannot tell a
     * switched-off engine from a missing one, and tells a Compose admin who set EXTENSION_ENGINE=0 to put back a
     * SUWAYOMI_URL line that was never removed ("off is 'switch'" fails).
     */
    await t.test('the status says it is off by the switch, where, and what depends on it', async () => {
      const r = await app.inject({ method: 'GET', url: '/api/admin/extensions/status', headers: auth });
      assert.equal(r.statusCode, 200);
      assert.deepEqual(r.json(), { configured: false, reachable: false, off: 'switch', platform: 'compose', linkedSeries: 2 },
        "off is 'switch'");
    });

    await t.test('Connect is refused like every extension route', async () => {
      const r = await app.inject({ method: 'POST', url: '/api/admin/extensions/solver', headers: auth, payload: {} });
      assert.equal(r.statusCode, 400);
      assert.equal(r.json().error, 'not_configured');
    });

    await t.test("Health: the engine row is an info line, and the waiting series say it is the engine", async () => {
      const { runHealthChecks } = await import('../src/lib/health');
      const report = await runHealthChecks();
      const engine = report.checks.find((c) => c.id === 'extension-engine');
      assert.ok(engine, 'the engine row is there while series depend on it');
      assert.equal(engine!.status, 'ok');
      assert.equal(engine!.summary, 'Switched off');
      const frozen = report.checks.find((c) => c.id === 'frozen-series')!;
      const row = frozen.items.find((i) => i.seriesId === SERIES[0]);
      assert.ok(row, 'a series from a switched-off engine is still listed as waiting');
      assert.match(row!.detail, /because the extension engine is off$/);
      assert.doesNotMatch(row!.detail, /source limit/);
      assert.match(frozen.note ?? '', /wait for the extension engine; Admin → Sources shows how to bring it back/);
    });
  } finally {
    await app.close();
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [SERIES]).catch(() => {});
    await q('DELETE FROM suwayomi_sources').catch(() => {});
    await pool.end().catch(() => {});
  }
});
