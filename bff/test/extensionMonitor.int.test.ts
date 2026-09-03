// The extension check, wired the way the server wires it: real database, real routes, fake extension server.
//
// extensionMonitor.test.ts proves the logic against an in-memory store. This proves the parts that only
// exist once it is plugged in -- the columns are really there, the result really persists, and the Tasks
// button really reaches the monitor. The route wiring is the half that has burned this codebase before: a
// function can be correct and still be reachable by nothing (see routeWiring.int.test.ts).
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';
// STATICALLY imported, unlike everything else in this file.
//
// The rest is imported dynamically because env has to be set before those modules load. zod does not read
// env, and it must not be dynamic here: `await import('zod')` resolves to a DIFFERENT module instance than
// the routes' own `import { z } from 'zod'`, so `err instanceof ZodError` is false in the handler below and
// a rejected schema comes back 500 instead of 400. Verified: the same error object answers false to the
// dynamic class and true to this one. Same family as the esbuild module-mocking trap.
import { ZodError } from 'zod';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  // The tasks list and the run route are both gated on there being an extension server at all.
  process.env.SUWAYOMI_URL = process.env.SUWAYOMI_URL || 'http://suwayomi.test:4567';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const USER = 'ext-admin';

function capturingLogger() {
  const lines: { level: string; msg: unknown }[] = [];
  const at = (level: string) => (msg: unknown) => { lines.push({ level, msg }); };
  const logger: any = { info: at('info'), warn: at('warn'), error: at('error'), fatal: at('fatal'), debug() {}, trace() {} };
  logger.child = () => logger;
  return { logger, lines };
}

async function until(cond: () => boolean, what: string, ms = 20_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`gave up waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const adminRoutes = (await import('../src/routes/admin')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await migrate();

  await q(`DELETE FROM users WHERE username = $1`, [USER]).catch(() => {});
  await q(`DELETE FROM extension_catalog WHERE pkg_name LIKE 'int.test.%'`).catch(() => {});
  await q(`UPDATE server_settings SET extension_repos = '[]', extension_last_run = NULL,
             extension_last_result = NULL, extension_hours = 6, extension_auto_update = true WHERE id = 1`);
  const admin = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind)
     VALUES ($1,$1,'x','admin','password') RETURNING id`, [USER]))[0].id;

  const { logger, lines } = capturingLogger();
  const app = Fastify({ loggerInstance: logger });
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  // The same handler server.ts installs, and BEFORE the routes for the same reason it documents: Fastify
  // resolves a route's error handler from the encapsulation context that existed when the route was
  // registered. Without it a rejected schema is a bare 500 here while the real server answers 400, and this
  // file would be asserting the harness rather than the server.
  app.setErrorHandler((err: any, req: any, reply: any) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'bad_request', fields: err.issues.map((i: any) => i.path.join('.')).filter(Boolean) });
    }
    const status = err.statusCode || 500;
    if (status >= 500) req.log.error(err);
    return reply.code(status).send({ error: status >= 500 ? 'internal' : err.message || 'error' });
  });
  await app.register(adminRoutes);
  await app.ready();
  const auth = { authorization: `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}` };
  return { q, app, auth, lines };
}

async function teardown(app: any, q: any) {
  await app.close();
  await q(`DELETE FROM users WHERE username = $1`, [USER]).catch(() => {});
  await q(`DELETE FROM extension_catalog WHERE pkg_name LIKE 'int.test.%'`).catch(() => {});
}

/** A fake extension server that only ever admits to an update AFTER its repositories have been re-read. */
function fakeGql(state: { refreshed: boolean; updated: string[] }) {
  return (async (query: string, variables: Record<string, any> = {}) => {
    if (/fetchExtensions/.test(query)) { state.refreshed = true; return { fetchExtensions: { extensions: [{ pkgName: 'int.test.a' }] } }; }
    if (/updateExtension\(/.test(query)) { state.updated.push(variables.id); return { updateExtension: { extension: { pkgName: variables.id, isInstalled: true } } }; }
    if (/setSettings/.test(query)) return { setSettings: { settings: { extensionRepos: variables.r } } };
    if (/extensionRepos/.test(query)) return { settings: { extensionRepos: ['https://r/index.json'] } };
    return { extensions: { nodes: [{
      pkgName: 'int.test.a', name: 'Integration One', lang: 'en',
      versionName: state.updated.length ? '2.0' : '1.0', iconUrl: null,
      isInstalled: true, hasUpdate: state.refreshed && !state.updated.length,
      isObsolete: false, isNsfw: false, repo: 'https://r/index.json',
    }] } };
  }) as never;
}

test('a check persists its run, its result and its catalogue', { skip }, async (t) => {
  const { q, app, auth } = await setup();
  const { runExtensionCheck, liveStore } = await import('../src/lib/extensionMonitor');
  try {
    const state = { refreshed: false, updated: [] as string[] };
    const r = await runExtensionCheck({}, {
      gql: fakeGql(state), store: liveStore,
      reloadAll: (async () => ({ loaded: 0, files: 0, suwayomi: 0 })) as any,
      logAudit: (async () => {}) as any, notifyAdmins: (async () => {}) as any,
      sweepRunning: () => false,
    } as any);

    assert.equal(r.refreshed, true);
    assert.deepEqual(r.updated.map((u) => u.name), ['Integration One'], 'the update was not applied');

    const s = await q<{ extension_last_run: Date | null; extension_last_result: any; extension_repos: any }>(
      `SELECT extension_last_run, extension_last_result, extension_repos FROM server_settings WHERE id = 1`);
    assert.ok(s[0].extension_last_run, 'extension_last_run was not stamped, so a restart re-runs immediately');
    assert.equal(s[0].extension_last_result?.refreshed, true, 'the result did not survive to the database');
    // Reintroduce by not adopting the engine's repositories: a wiped volume then has nothing to restore from.
    assert.deepEqual(s[0].extension_repos, ['https://r/index.json'], 'the repository list was not adopted');

    const rows = await q<{ pkg_name: string; installed: boolean; last_seen: Date }>(
      `SELECT pkg_name, installed, last_seen FROM extension_catalog WHERE pkg_name = 'int.test.a'`);
    assert.equal(rows.length, 1, 'the catalogue snapshot was not written');
    assert.equal(rows[0].installed, true);

    // A second run must move last_seen forward: that is how "no repository offers this any more" is spelled.
    const first = rows[0].last_seen.getTime();
    await new Promise((r2) => setTimeout(r2, 20));
    await runExtensionCheck({}, {
      gql: fakeGql({ refreshed: false, updated: ['int.test.a'] }), store: liveStore,
      reloadAll: (async () => ({ loaded: 0, files: 0, suwayomi: 0 })) as any,
      logAudit: (async () => {}) as any, notifyAdmins: (async () => {}) as any, sweepRunning: () => false,
    } as any);
    const again = await q<{ last_seen: Date }>(`SELECT last_seen FROM extension_catalog WHERE pkg_name = 'int.test.a'`);
    assert.ok(again[0].last_seen.getTime() > first, 'last_seen did not advance on the second check');
  } finally {
    await teardown(app, q);
  }
});

test('the Tasks panel can see and start the check', { skip }, async (t) => {
  const { q, app, auth } = await setup();
  const { extState } = await import('../src/lib/extensionMonitor');
  try {
    await t.test('it is listed as a task', async () => {
      // Reintroduce by deleting the extensions entry from GET /api/admin/tasks: the job runs on a schedule
      // nobody can see, and "Run now" has nothing to attach to.
      const r = await app.inject({ method: 'GET', url: '/api/admin/tasks', headers: auth });
      assert.equal(r.statusCode, 200);
      const t2 = r.json().content.find((x: any) => x.id === 'extensions');
      assert.ok(t2, 'no extensions task in the list');
      assert.match(t2.schedule, /every \d+h/);
    });

    await t.test('THE WIRING: Run now reaches the monitor, and refuses a second start', async () => {
      // Reintroduce by deleting the `id === 'extensions'` branch from POST /api/admin/tasks/:id/run: the
      // route falls through to `{ ok: false }` and the button silently does nothing.
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const { runExtensionMonitor } = await import('../src/lib/extensionMonitor');
      // Hold one open by starting it directly, then prove the ROUTE refuses while it runs.
      const held = runExtensionMonitor({ info() {}, warn() {}, error() {} },
        (async () => { await gate; return { refreshed: true, known: 1, installed: 1, updated: [], failed: [], obsolete: [], updatesAvailable: [] } as any; }) as any);
      assert.notEqual(held, false);
      await until(() => extState.running, 'the held check to mark itself running');

      const busy = await app.inject({ method: 'POST', url: '/api/admin/tasks/extensions/run', headers: auth });
      assert.equal(busy.statusCode, 200);
      assert.deepEqual(busy.json(), { ok: false, error: 'busy' }, 'the route started a second check on top of one already running');

      const listed = await app.inject({ method: 'GET', url: '/api/admin/tasks', headers: auth });
      assert.equal(listed.json().content.find((x: any) => x.id === 'extensions').running, true,
        'the panel showed the running check as idle');

      release();
      await held;
      assert.equal(extState.running, false);
    });

    await t.test('starting it is audited', async () => {
      const r = await app.inject({ method: 'GET', url: '/api/admin/audit?limit=20', headers: auth });
      const rows = r.json().content ?? r.json();
      assert.ok((rows as any[]).some((a) => a.event === 'task.run' && a.detail?.task === 'extensions'),
        'starting the check left no audit trail');
    });
  } finally {
    await teardown(app, q);
  }
});

test('the interval and the kill switch round-trip through settings', { skip }, async (t) => {
  const { q, app, auth } = await setup();
  try {
    // Reintroduce by removing the two fields from the settings zod schema: the PATCH is accepted and
    // silently ignored, which is the worst of both.
    const r = await app.inject({
      method: 'PATCH', url: '/api/admin/settings', headers: auth,
      payload: { extensionHours: 12, extensionAutoUpdate: false },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().extension_hours, 12);
    assert.equal(r.json().extension_auto_update, false);
    // Not a column. The settings page gates its two extension cards on this, and extension_hours cannot
    // stand in for it: that has a NOT NULL default, so it is set on every install, engine or no engine.
    // Reintroduce by dropping the flag: an install with no extension server offers controls for a job that
    // can never run.
    assert.equal(r.json().extensions_configured, true, 'the settings response does not say whether an engine exists');

    const listed = await app.inject({ method: 'GET', url: '/api/admin/tasks', headers: auth });
    const task = listed.json().content.find((x: any) => x.id === 'extensions');
    assert.match(task.schedule, /every 12h/);
    assert.match(task.schedule, /check only/, 'with auto-update off the schedule should say so');

    // Reintroduce by removing .min(1) from extensionHours: a zero-hour interval is accepted, and the tick
    // clamps it back to 1 anyway, so the setting silently does not mean what it says.
    const bad = await app.inject({
      method: 'PATCH', url: '/api/admin/settings', headers: auth, payload: { extensionHours: 0 },
    });
    assert.equal(bad.statusCode, 400, 'an interval of zero was accepted');
    const unchanged = await app.inject({ method: 'GET', url: '/api/admin/settings', headers: auth });
    assert.equal(unchanged.json().extension_hours, 12, 'the rejected value was written anyway');
  } finally {
    await q(`UPDATE server_settings SET extension_hours = 6, extension_auto_update = true WHERE id = 1`).catch(() => {});
    await teardown(app, q);
  }
});
