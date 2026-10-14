// A REAL extension engine, through Uchiyomi's own code: what the weekly canary asks of a new Suwayomi-Server before
// anybody runs it (.github/workflows/engine-canary.yml).
//
//   SUWAYOMI_LIVE_URL=http://127.0.0.1:4567 SUWAYOMI_LIVE_STORE=http://host.docker.internal:8099/index.min.json \
//     node --import tsx --test test/engineLive.test.ts
//
// Skipped unless SUWAYOMI_LIVE_URL is set. The engine must be a throwaway one: the canary's, started fresh with the
// Local manga of scripts/engine/seedLocal.mjs and able to reach the fixture store of scripts/engine/serveStatic.mjs.
// ⚠️ It refuses to run against an engine that holds an installed extension, or any store but the fixture's -- that is
// somebody's library, and this test adds and removes a store and clears the page cache.
//
// Every step goes through product code (the adapters, client.ts's transport, operations.ts's documents), so what
// passes here is what an install would do with this engine: the Local source end to end (popular, the series, its
// chapters with real dates, a page and a cover over HTTP), the Cloudflare helper's setting, an extension store added,
// listed and removed, the page cache, and a source's preferences. At the end, the engine must have refused nothing.
// Reintroduce by dropping uploadedAt's `* 1000` (sources.ts) and run it against a fresh v2.3.2243: "the Local source,
// end to end" fails on chapter 1 -- the seeded chapter the Local source gives no date, which that engine stamps in
// seconds -- with no date at all (measured 2026-10-14; before the fix it read as 1970-01-21).
import test from 'node:test';
import assert from 'node:assert/strict';

const LIVE = process.env.SUWAYOMI_LIVE_URL;
const STORE = process.env.SUWAYOMI_LIVE_STORE;
const skip = LIVE ? false : 'set SUWAYOMI_LIVE_URL (and SUWAYOMI_LIVE_STORE) to a throwaway engine to run';
if (LIVE) {
  // ⚠️ Before anything from src: env.ts parses these once.
  process.env.SUWAYOMI_URL = LIVE;
  process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
  process.env.DATABASE_URL ||= 'postgres://unused/unused';
  process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';
}

test('a real engine answers everything Uchiyomi asks of it', { skip }, async (t) => {
  const client = await import('../src/lib/sources/suwayomi/client');
  const sources = await import('../src/lib/sources/suwayomi/sources');
  const ext = await import('../src/lib/sources/suwayomi/extensions');
  const { getEngineSolver } = await import('../src/lib/sources/suwayomi/engineSolver');
  const { clearEnginePageCache } = await import('../src/lib/sources/suwayomi/cache');
  const { readSourcePrefs } = await import('../src/lib/sources/suwayomi/prefs');
  const { engineStanding } = await import('../src/lib/sources/suwayomi/enginePin');
  client.forgetEngineRefusals();

  const about = await client.aboutServer();
  t.diagnostic(`engine ${about.name} ${about.version} (${about.buildType}), ${engineStanding(about.version)} against the tested one`);

  // A library is never touched: no installed extension, and no store but the fixture's.
  const installed = (await ext.listExtensions()).filter((e) => e.installed);
  assert.deepEqual(installed.map((e) => e.pkgName), [], 'REFUSING TO RUN: this engine has installed extensions -- point the test at a throwaway one');
  const stores = await ext.getRepos();
  assert.ok(stores.every((u) => STORE && ext.repoKey(u) === ext.repoKey(STORE)), `REFUSING TO RUN: this engine holds stores (${stores.join(', ')})`);

  await t.test('the Local source, end to end', async () => {
    const remote = await sources.listRemoteSources();
    const local = remote.find((s) => s.id === '0');
    assert.ok(local, `no Local source among ${remote.map((s) => s.id).join(', ')}`);
    assert.equal(local!.isNsfw, false, `the Local source reads adult: its contentWarning is ${local!.contentWarning}`);
    const a = sources.makeSuwayomiAdapter(local!);
    const hit = (await a.popular!(1)).find((s) => s.title === 'Canary Manga');
    assert.ok(hit, 'the seeded Local manga is not listed (scripts/engine/seedLocal.mjs)');
    assert.equal((await a.getSeries(hit!.sourceId))?.title, 'Canary Manga');
    const chapters = await a.listChapters(hit!.sourceId);
    assert.deepEqual(chapters.map((c) => c.number), [1, 2]);
    // Real dates, whatever unit the engine stamped them in: the one the Local source gave no date is "now".
    for (const c of chapters) {
      const at = Date.parse(c.publishedAt ?? '');
      assert.ok(at > Date.UTC(2000, 0, 1) && at < Date.now() + 2 * 86_400_000, `chapter ${c.number} is dated ${c.publishedAt}`);
    }
    const pages = await a.getPageUrls(chapters[0].sourceId);
    assert.ok(pages.length >= 1, 'no pages');
    const page = await fetch(pages[0], { headers: client.suwayomiImageHeaders() });
    assert.equal(page.status, 200, `a page: ${pages[0]}`);
    assert.match(page.headers.get('content-type') ?? '', /^image\//);
    assert.ok(hit!.coverUrl, 'no cover');
    const cover = await fetch(hit!.coverUrl!, { headers: client.suwayomiImageHeaders() });
    assert.equal(cover.status, 200, `the cover: ${hit!.coverUrl}`);
  });

  await t.test('the Cloudflare helper setting is there to read', async () => {
    const s = await getEngineSolver();
    assert.equal(s.supported, true, 'the engine no longer reports flareSolverrEnabled / flareSolverrUrl');
  });

  await t.test('an extension store: added, listed with its extension, removed', { skip: STORE ? false : 'no SUWAYOMI_LIVE_STORE' }, async () => {
    const added = await ext.addRepo(STORE!);
    assert.ok(added.indexUrl, 'the add answered no address');
    assert.ok((await ext.getRepos()).includes(added.indexUrl), 'the store is not listed');
    await ext.refreshExtensions();
    const offered = (await ext.listExtensions()).filter((e) => e.repo === added.indexUrl);
    assert.deepEqual(offered.map((e) => [e.pkgName, e.nsfw]), [['eu.kanade.tachiyomi.extension.en.canaryfixture', false]]);
    assert.equal(await ext.removeRepo(added.indexUrl), true);
    assert.ok(!(await ext.getRepos()).includes(added.indexUrl), 'the store is still listed');
  });

  await t.test('the page cache can be emptied', async () => {
    assert.equal(await clearEnginePageCache(), true);
  });

  await t.test("a source's preferences can be read", async () => {
    const p = await readSourcePrefs('0');
    assert.equal(p.source.id, '0');
    assert.ok(Array.isArray(p.preferences));
  });

  await t.test('nothing Uchiyomi asked was refused', () => {
    assert.deepEqual(client.engineRefusals(), []);
  });
});
