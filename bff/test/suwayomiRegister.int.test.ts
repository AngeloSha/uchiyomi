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

  await t.test('the adult flag survives a re-register rather than being reset', async () => {
    // `isNsfw` was selected in SOURCES_Q and then discarded at every step: no column, nothing on the
    // adapter, nothing in the API. It is now the ONLY signal keeping an age-capped account out of an adult
    // source, so an extension that turns adult in a later version must not keep an old `false`, and one that
    // is already adult must not be un-flagged by the next refresh.
    reset();
    await q('DELETE FROM suwayomi_sources');
    await reg.loadSuwayomiSources(async () => [{ id: '9', name: 'Clean', lang: 'en' }]);
    assert.equal((await q<{ nsfw: boolean }>(`SELECT nsfw FROM suwayomi_sources WHERE source_id = '9'`))[0].nsfw, false);

    await reg.loadSuwayomiSources(async () => [{ id: '9', name: 'Clean', lang: 'en', isNsfw: true }]);
    assert.equal(
      (await q<{ nsfw: boolean }>(`SELECT nsfw FROM suwayomi_sources WHERE source_id = '9'`))[0].nsfw, true,
      'a source that became adult stayed marked clean',
    );

    await q(`UPDATE suwayomi_sources SET enabled = true WHERE source_id = '9'`);
    await reg.loadSuwayomiSources(async () => [{ id: '9', name: 'Clean', lang: 'en', isNsfw: true }]);
    const adapter = loader.getSource('sw:9');
    assert.ok(adapter, 'the enabled source should be registered');
    assert.equal(adapter!.isNsfw, true, 'the flag reached the database but not the adapter the routes check');
    assert.equal(adapter!.lang, 'en', 'the language must reach the adapter too, or it joins every group');
  });

  await t.test('which extension a source came out of is remembered, refreshed, and tolerated when missing', async () => {
    // One package can expose dozens of sources (3Hentai: twenty-nine language variants) and `pkgName` is
    // the only thing they share that is not a guess; the Providers page folds them into one card by it.
    // The engine answers `extension { pkgName name }` on every node today, but the value is nullable on
    // our side on purpose: a node without it must still register, with the columns null rather than ''.
    // Reintroduce by dropping pkg_name/ext_name from the upsert's DO UPDATE SET (keep the INSERT columns):
    // "a re-list refreshes the package" fails -- the row keeps the old package.
    reset();
    await q('DELETE FROM suwayomi_sources');
    const ext = { pkgName: 'eu.kanade.tachiyomi.extension.all.hentai3', name: '3Hentai' };
    await reg.loadSuwayomiSources(async () => [
      { id: '30', name: '3Hentai', displayName: '3Hentai (EN)', lang: 'en', extension: ext },
      { id: '31', name: '3Hentai', displayName: '3Hentai (JA)', lang: 'ja', extension: ext },
      { id: '32', name: 'Bare', lang: 'en' },
      { id: '33', name: 'Blank', lang: 'en', extension: { pkgName: '  ', name: '' } },
    ]);
    const rows = await q<{ source_id: string; pkg_name: string | null; ext_name: string | null }>(
      `SELECT source_id, pkg_name, ext_name FROM suwayomi_sources WHERE source_id IN ('30','31','32','33') ORDER BY source_id`,
    );
    assert.deepEqual(rows, [
      { source_id: '30', pkg_name: ext.pkgName, ext_name: '3Hentai' },
      { source_id: '31', pkg_name: ext.pkgName, ext_name: '3Hentai' },
      { source_id: '32', pkg_name: null, ext_name: null },
      { source_id: '33', pkg_name: null, ext_name: null },
    ], 'two variants of one package share pkg_name; a node without one stores null, never the empty string');

    await reg.loadSuwayomiSources(async () => [
      { id: '32', name: 'Bare', lang: 'en', extension: { pkgName: 'eu.kanade.tachiyomi.extension.en.bare', name: 'Bare' } },
    ]);
    const after = await q<{ pkg_name: string | null }>(`SELECT pkg_name FROM suwayomi_sources WHERE source_id = '32'`);
    assert.equal(after[0].pkg_name, 'eu.kanade.tachiyomi.extension.en.bare', 'a re-list refreshes the package');
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
      // v0.55.1: and which, by id -- what Health's frozen row and the sources overview read (leftOutByLimit), where both
      // took "switched on and not loaded" for it. Reintroduce by not recording them in load(): "the sources the limit
      // left out are known by id" fails.
      assert.deepEqual(['0', '1', '2', '3', '4'].filter((id) => reg.leftOutByLimit(`sw:${id}`)), ['2', '3', '4'],
        'the sources the limit left out are known by id');
      assert.ok(!reg.leftOutByLimit('2') && !reg.leftOutByLimit(null), 'by their adapter id alone');

      // ...and reported somewhere a person looks. The count above went to one console.warn at boot and
      // nowhere else, so search quietly reached fewer sources than the panel said were on.
      // Reintroduce by not recording `last` in loadSuwayomiSources (return load(list) directly): "the cap
      // overflow reaches the health page" fails -- the check reads ok with nothing skipped.
      const { runHealthChecks } = await import('../src/lib/health');
      const cap = (await runHealthChecks()).checks.find((c) => c.id === 'extension-cap');
      assert.ok(cap, 'the extension-cap check exists when an engine is configured');
      assert.equal(cap!.status, 'warn', 'the cap overflow reaches the health page');
      assert.match(cap!.summary, /3 enabled sources are not registered/);
      assert.match(cap!.items[0]?.detail ?? '', /the limit is 2/);
    } finally {
      (env as { SUWAYOMI_MAX_SOURCES: number }).SUWAYOMI_MAX_SOURCES = original;
    }
  });

  await t.test('the sources series use register first under the limit, and wouldFit counts what the next load would', async () => {
    // v0.55.0: the limit took the engine's order alone, so a source switched on later could sort ahead of one a
    // hundred series update from and push it out -- they froze as "over the source limit". Fix everything installs
    // extensions by itself, so used sources go first. Reintroduce by registering in the engine's order (drop the
    // used-first sort in load()): the two used sources, last in the engine's list, are the ones skipped.
    reset();
    const { env } = await import('../src/env');
    const original = env.SUWAYOMI_MAX_SOURCES;
    (env as { SUWAYOMI_MAX_SOURCES: number }).SUWAYOMI_MAX_SOURCES = 2;
    const SERIES = ['s_reg_main', 's_reg_follow', 's_reg_hidden'];
    try {
      await q('DELETE FROM lib_series WHERE id = ANY($1)', [SERIES]);
      await q('DELETE FROM suwayomi_sources');
      await reg.loadSuwayomiSources(async () => remote(5));
      await q('UPDATE suwayomi_sources SET enabled = true');
      // One series reads source 4 as its main, another follows source 3; a removed series on source 0 counts for nothing.
      await q(`INSERT INTO lib_series (id, source, title, folder, source_id, source_series_id, deleted_at) VALUES
                 ('s_reg_main','t','s_reg_main','s_reg_main','sw:4','1',NULL),
                 ('s_reg_follow','t','s_reg_follow','s_reg_follow','other','1',NULL),
                 ('s_reg_hidden','t','s_reg_hidden','s_reg_hidden','sw:0','1',now())`);
      await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ('s_reg_follow','sw:3','9')`);
      const r = await reg.loadSuwayomiSources(async () => remote(5));
      assert.equal(r.registered, 2);
      assert.equal(r.skipped, 3);
      assert.deepEqual(loader.sourceIds().sort(), ['sw:3', 'sw:4'], 'the two sources series read through, though the engine lists them last');

      // wouldFit: the switched-on sources the engine offered at the last load, plus the ones asked about.
      (env as { SUWAYOMI_MAX_SOURCES: number }).SUWAYOMI_MAX_SOURCES = 4;
      await q(`UPDATE suwayomi_sources SET enabled = (source_id IN ('0','1','2'))`);
      await q(`INSERT INTO suwayomi_sources (source_id, name, lang, enabled) VALUES ('gone','Gone','en',true)`);
      await reg.loadSuwayomiSources(async () => remote(5));
      // Reintroduce by counting every enabled row (drop the `offered` filter): the row for a source the engine no longer
      // offers takes a slot it never uses, and this first answer reads false.
      assert.equal(await reg.wouldFit(['3']), true, 'three on and one more is four, the limit; the row the engine no longer offers takes no slot');
      assert.equal(await reg.wouldFit(['3', '4']), false, 'five would leave one out');
      assert.equal(await reg.wouldFit(['1']), true, 'a source already on takes no new slot');
    } finally {
      (env as { SUWAYOMI_MAX_SOURCES: number }).SUWAYOMI_MAX_SOURCES = original;
      await q('DELETE FROM series_sources WHERE series_id = ANY($1)', [SERIES]);
      await q('DELETE FROM lib_series WHERE id = ANY($1)', [SERIES]);
    }
  });

  await t.test('an unreachable extension server registers nothing and does not throw', async () => {
    reset();
    // A load that left something out first: an engine that does not answer leaves nothing out after it -- no extension
    // source is loaded at all then, and the reason is the engine's, never the limit's (v0.55.1).
    const { env } = await import('../src/env');
    const original = env.SUWAYOMI_MAX_SOURCES;
    (env as { SUWAYOMI_MAX_SOURCES: number }).SUWAYOMI_MAX_SOURCES = 1;
    try {
      await q('UPDATE suwayomi_sources SET enabled = true');
      await reg.loadSuwayomiSources(async () => remote(3));
      assert.ok(reg.leftOutByLimit('sw:2'), 'PREMISE: the limit left a source out');
    } finally {
      (env as { SUWAYOMI_MAX_SOURCES: number }).SUWAYOMI_MAX_SOURCES = original;
    }
    reset();
    const r = await reg.loadSuwayomiSources(async () => {
      throw new Error('fetch failed');
    });
    assert.equal(r.configured, true);
    assert.equal(r.reachable, false);
    assert.equal(r.registered, 0);
    assert.match(r.error || '', /fetch failed/);
    assert.equal(loader.listSources().length, 0);
    assert.equal(reg.leftOutByLimit('sw:2'), false, 'an engine that does not answer leaves nothing out');
  });

  await q('DELETE FROM suwayomi_sources');
});
