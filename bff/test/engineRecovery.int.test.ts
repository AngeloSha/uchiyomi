// The extension engine coming back brings its sources back, with no reload by hand (#72).
//
// engineRetry.test.ts drives the loop with a mock clock; this is the real thing: the strict fake engine on a real
// port, closed (connection refused, as while a JVM boots or a container is stopped) and reopened, and the
// registry checked for the extension source. Two roads into an outage:
//   (a) the engine is down at the first load and comes up later -- the loop the boot starts registers it;
//   (b) a reloadAll runs while it is down, which clears the registry -- before v0.49.0 nothing registered the
//       extension sources again after that until someone reloaded by hand.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

test('extension sources come back when the engine does', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async (t) => {
  const { startFakeSuwayomi, SOURCE_IDS } = await import('./fixtures/fakeSuwayomi');
  const fake = await startFakeSuwayomi();
  process.env.DATABASE_URL = DSN;
  process.env.SUWAYOMI_URL = fake.url;
  process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';
  const { migrate } = await import('../src/lib/migrate');
  const { q, pool } = await import('../src/lib/db');
  const reg = await import('../src/lib/sources/suwayomi/register');
  const { getSource } = await import('../src/lib/sources/loader');
  const { reloadAll } = await import('../src/lib/sources/reload');
  await migrate();
  await q('DELETE FROM suwayomi_sources');
  await q(`INSERT INTO suwayomi_sources (source_id, name, lang, enabled) VALUES ($1,'Manga Ball','en',true)`, [SOURCE_IDS.mangaBall]);
  const id = `sw:${SOURCE_IDS.mangaBall}`;
  const quiet = [console.warn, console.log] as const;
  console.warn = () => {};
  console.log = () => {};
  try {
    /**
     * Reintroduce the old give-up after the fast phase: the engine comes up after it, nothing asks any more, and
     * "registered by a slow try" fails.
     */
    await t.test('down at the first load and past the fast phase, up later: a slow try registers it', async () => {
      await fake.stop();
      const first = await reg.loadSuwayomiSources();
      assert.equal(first.reachable, false);
      assert.ok(!getSource(id), 'nothing registered while the engine is down');
      reg.scheduleSuwayomiRetry([50, 50], 300);
      await new Promise((r) => setTimeout(r, 250));
      assert.equal(reg.suwayomiRetryState()?.attempts, 3, 'both fast tries failed, and the loop still runs');
      await fake.start();
      assert.ok(await until(() => !!getSource(id), 5_000), 'registered by a slow try');
      assert.equal(reg.suwayomiRetryState(), null, 'and the loop is over');
    });

    /**
     * Reintroduce by deleting the scheduleSuwayomiRetry() call from reloadAll (reload.ts): the reload during the
     * outage leaves no loop behind, and "the extension source comes back with no reload by hand" fails.
     */
    await t.test('a reload during an outage: the sources come back by themselves', async () => {
      await fake.stop();
      await reloadAll();
      assert.ok(!getSource(id), 'the reload cleared it and the engine was not there to list it');
      assert.ok(reg.suwayomiRetryState(), 'the reload left the retry running');
      await fake.start();
      // The loop's first try is 5 s after the reload.
      assert.ok(await until(() => !!getSource(id), 9_000), 'the extension source comes back with no reload by hand');
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
