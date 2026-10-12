// A reload must not empty the registry while it waits for the engine (v0.60.1, found in Squeaks72's fork).
//
// reloadAll() used to clear the registry first and ask the engine for its sources after. An engine busy installing an
// extension answers slowly, so for seconds every extension source was unregistered: Health listed every extension
// series as "its source is no longer installed", the sweep skipped them, a download in flight threw `unknown source`
// and Discover lost them -- on every install, update and uninstall, and every reload Fix everything or the watchdog
// makes. The registry is now swapped in one synchronous step after the engine has answered (register.ts
// `beforeRegister`).
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;

test('the sources stay registered while a reload waits for the engine', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async (t) => {
  const { startFakeSuwayomi, SOURCE_IDS } = await import('./fixtures/fakeSuwayomi');
  const fake = await startFakeSuwayomi();
  process.env.DATABASE_URL = DSN;
  process.env.SUWAYOMI_URL = fake.url;
  process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';
  const { migrate } = await import('../src/lib/migrate');
  const { q, pool } = await import('../src/lib/db');
  const reg = await import('../src/lib/sources/suwayomi/register');
  const { listRemoteSources } = await import('../src/lib/sources/suwayomi/sources');
  const { getSource, reloadSources } = await import('../src/lib/sources/loader');
  const { reloadAll } = await import('../src/lib/sources/reload');
  await migrate();
  await q('DELETE FROM suwayomi_sources');
  await q(`INSERT INTO suwayomi_sources (source_id, name, lang, enabled) VALUES ($1,'Manga Ball','en',true)`, [SOURCE_IDS.mangaBall]);
  const id = `sw:${SOURCE_IDS.mangaBall}`;
  const quiet = [console.warn, console.log] as const;
  console.warn = () => {};
  console.log = () => {};
  try {
    await reg.loadSuwayomiSources();
    assert.ok(getSource(id), 'registered to begin with');

    /**
     * Reintroduce by clearing the registry before the engine is asked (reload.ts running reloadSources() ahead of
     * loadSuwayomiSources, or register.ts calling `beforeRegister` before `await list()`): the source is gone while the
     * engine is still answering, and "still registered while the engine is slow" fails.
     */
    await t.test('a slow engine: the old sources stay until the swap, and come back right after it', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let swapped = false;
      const slow = reg.loadSuwayomiSources(async () => { await gate; return listRemoteSources(); }, {
        beforeRegister: () => { swapped = true; reloadSources(); },
      });
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(swapped, false, 'the swap waits for the engine');
      assert.ok(getSource(id), 'the extension source is still registered while the engine is slow');
      release();
      const r = await slow;
      assert.equal(swapped, true);
      assert.equal(r.reachable, true);
      assert.ok(getSource(id), 'and registered again right after the swap');
    });

    // The hook still runs when the engine cannot be listed, so a reload during an outage still reloads the pack, the
    // built-ins and the sites added by URL (and the retry the boot starts brings the extension sources back, #72).
    await t.test('an engine that fails to list still gets the swap, once', async () => {
      let swaps = 0;
      const r = await reg.loadSuwayomiSources(async () => { throw new Error('connect ECONNREFUSED'); }, {
        quiet: true, beforeRegister: () => { swaps++; reloadSources(); },
      });
      reg.stopSuwayomiRetry();
      assert.equal(r.reachable, false);
      assert.equal(swaps, 1, 'the swap runs exactly once on the failed load');
      assert.equal(getSource(id), null, 'an engine that cannot list leaves no extension source, as before');
    });

    // And the real thing end to end: a whole reloadAll against an engine slow to answer. Reintroduce by putting
    // reload.ts back to clearing the registry before it asks (reloadSources() ahead of loadSuwayomiSources): the source
    // is gone mid-reload and "while the engine answers slowly" fails.
    await t.test('reloadAll keeps the extension source registered while the engine answers slowly', async () => {
      await reloadAll(); // registered again after the failed load above
      assert.ok(getSource(id), 'PREMISE: registered before the slow reload');
      fake.setMode({ mode: 'slow', ms: 800 });
      try {
        const pending = reloadAll();
        await new Promise((r) => setTimeout(r, 250));
        assert.ok(getSource(id), 'still registered while the engine answers slowly');
        const r = await pending;
        assert.ok(r.suwayomi >= 1, 'the engine registered its sources');
        assert.ok(getSource(id), 'and registered after the reload');
      } finally {
        fake.setMode('up');
      }
    });
  } finally {
    console.warn = quiet[0];
    console.log = quiet[1];
    reg.stopSuwayomiRetry();
    await q('DELETE FROM suwayomi_sources').catch(() => {});
    await fake.close();
    await pool.end().catch(() => {});
  }
});
