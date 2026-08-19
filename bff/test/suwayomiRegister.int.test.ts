// Which extension sources actually get registered.
//
// This is the rule that decides whether the feature is usable at all rather than a nicety: cross-source
// search (GET /api/sources/search-all) fans out to EVERY registered source with a 20s timeout each, so
// registering the several hundred sources a full extension set exposes would make search unusable and would
// hit every one of those sites at once. Hence opt-in per source, plus a hard cap.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.SUWAYOMI_URL = process.env.SUWAYOMI_URL || 'http://suwayomi.test:4567';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}

const remote = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: String(i), name: `Source ${i}`, lang: 'en', supportsLatest: false }));

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const reg = await import('../src/lib/sources/suwayomi/register');
  const loader = await import('../src/lib/sources/loader');
  await migrate();
  await q('DELETE FROM suwayomi_sources');
  return { q, reg, loader };
}

test('extension source registration', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async (t) => {
  const { q, reg, loader } = await setup();
  const reset = () => loader.reloadSources('/nonexistent-so-this-just-clears-the-registry');

  await t.test('a source Suwayomi offers is remembered but NOT registered until switched on', async () => {
    reset();
    const r = await reg.loadSuwayomiSources(async () => remote(3));
    assert.equal(r.available, 3);
    assert.equal(r.registered, 0, 'sources must be opt-in, not registered on sight');
    const rows = await q<{ source_id: string; enabled: boolean }>('SELECT source_id, enabled FROM suwayomi_sources');
    assert.equal(rows.length, 3, 'they should still be remembered so the admin list can render');
    assert.ok(rows.every((x) => !x.enabled));
    assert.equal(loader.listSources().length, 0);
  });

  await t.test('only the enabled ones register', async () => {
    reset();
    await q(`UPDATE suwayomi_sources SET enabled = true WHERE source_id IN ('0','2')`);
    const r = await reg.loadSuwayomiSources(async () => remote(3));
    assert.equal(r.registered, 2);
    assert.deepEqual(loader.sourceIds().sort(), ['sw:0', 'sw:2']);
  });

  await t.test('re-listing keeps names fresh without turning anything on', async () => {
    reset();
    await reg.loadSuwayomiSources(async () => [{ id: '0', name: 'Renamed Source', lang: 'fr' }]);
    const row = await q<{ name: string; lang: string; enabled: boolean }>(
      `SELECT name, lang, enabled FROM suwayomi_sources WHERE source_id = '0'`,
    );
    assert.equal(row[0].name, 'Renamed Source');
    assert.equal(row[0].lang, 'fr');
    assert.equal(row[0].enabled, true, 'an existing choice must survive a refresh');
  });

  await t.test('the cap is enforced, and what it dropped is reported', async () => {
    reset();
    const { env } = await import('../src/env');
    const original = env.SUWAYOMI_MAX_SOURCES;
    (env as { SUWAYOMI_MAX_SOURCES: number }).SUWAYOMI_MAX_SOURCES = 2;
    try {
      await q('DELETE FROM suwayomi_sources');
      await reg.loadSuwayomiSources(async () => remote(5)); // remembers them, all disabled
      await q('UPDATE suwayomi_sources SET enabled = true');
      const r = await reg.loadSuwayomiSources(async () => remote(5));
      assert.equal(r.registered, 2);
      assert.equal(r.skipped, 3, 'over-cap sources must be counted, not silently dropped');
      assert.equal(loader.listSources().length, 2);
    } finally {
      (env as { SUWAYOMI_MAX_SOURCES: number }).SUWAYOMI_MAX_SOURCES = original;
    }
  });

  await t.test('an unreachable extension server registers nothing and does not throw', async () => {
    reset();
    const r = await reg.loadSuwayomiSources(async () => {
      throw new Error('fetch failed');
    });
    assert.equal(r.configured, true);
    assert.equal(r.reachable, false);
    assert.equal(r.registered, 0);
    assert.match(r.error || '', /fetch failed/);
    assert.equal(loader.listSources().length, 0);
  });

  await q('DELETE FROM suwayomi_sources');
});
