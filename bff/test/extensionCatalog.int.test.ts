// Admin → Extensions' catalogue and sources, against the strict fake engine and a repository the size of a real one
// (v0.53.0, discussion #121).
//
// What the redesigned page asks of the routes: every extension of a 1,300-extension repository reachable a page at a
// time (the catalogue answered its first 400 and said "narrow the search"); the updates filter; the 18+ extensions a
// search would have found; "Turn on its sources" for an extension installed in the engine's own page, which showed as
// installed with every source off; a language switch on such an extension's source, which had no row to flip; and the
// series each source brought, beside its language.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
const SERIES = ['s_xc_one', 's_xc_two', 's_xc_gone'];
/** The made-up repository: past CATALOG_PAGE_MAX however many of its 18+ extensions are hidden. */
const REPO_SIZE = 600;

async function setup() {
  const { startFakeSuwayomi, catalogueSeed, catalogueExtensions, SOURCE_IDS, PKG } = await import('./fixtures/fakeSuwayomi');
  const seed = catalogueSeed(REPO_SIZE);
  const fake = await startFakeSuwayomi({ seed: seed as any });
  // ⚠️ Before anything from src: env.ts reads these once.
  process.env.DATABASE_URL = DSN;
  process.env.SUWAYOMI_URL = fake.url;
  process.env.EXTENSION_ENGINE = '1';
  process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const admin = await import('../src/routes/admin');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await migrate();

  await q('DELETE FROM suwayomi_sources');
  await q(`UPDATE server_settings SET hidden_langs = '[]' WHERE id = 1`);
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [SERIES]);
  // Two series from Manga Ball and one removed: the removed one is not "from" it any more.
  for (const [id, deleted] of [['s_xc_one', false], ['s_xc_two', false], ['s_xc_gone', true]] as const) {
    await q(`INSERT INTO lib_series (id, source, title, folder, source_id, source_series_id, deleted_at)
             VALUES ($1,'test',$1,$1,$2,$1,$3)`, [id, `sw:${SOURCE_IDS.mangaBall}`, deleted ? new Date() : null]);
  }
  await q(`DELETE FROM users WHERE username = 'xc-admin'`);
  const userId = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ('xc-admin','xc-admin','x','admin','password') RETURNING id`,
  ))[0].id;

  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(admin.default);
  await app.ready();
  const headers = { authorization: `Bearer ${app.jwt.sign({ sub: userId, role: 'admin' })}` };
  const get = async (url: string) => {
    const r = await app.inject({ method: 'GET', url, headers });
    assert.equal(r.statusCode, 200, `${url}: ${r.body}`);
    return r.json();
  };
  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers, payload: payload as any });
  const rows = async () => Object.fromEntries(
    (await q<{ source_id: string; enabled: boolean }>('SELECT source_id, enabled FROM suwayomi_sources')).map((r) => [r.source_id, r.enabled]),
  );
  return { fake, seed, q, app, get, post, rows, CATALOG_PAGE_MAX: admin.CATALOG_PAGE_MAX, made: catalogueExtensions(REPO_SIZE), SOURCE_IDS, PKG };
}

test('Admin → Extensions on a repository the size of a real one', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async (t) => {
  const { fake, seed, q, app, get, post, rows, CATALOG_PAGE_MAX, made, SOURCE_IDS, PKG } = await setup();
  const quiet = [console.warn, console.log] as const;
  console.warn = () => {};
  console.log = () => {};
  try {
    // What the catalogue lists with the 18+ filter on (its default): every extension that is not adult, and the
    // installed ones whatever they are.
    const shown = seed.extensions.filter((e: { isNsfw?: boolean; installed: boolean }) => !e.isNsfw || e.installed).map((e: { pkgName: string }) => e.pkgName);

    /**
     * Reintroduce the old answer (`.slice(0, 400)` whatever `offset` says): every page past the first repeats it, so the
     * walk meets the same extensions again and "no extension on two pages" fails.
     */
    await t.test('every extension is on some page, once, and a page past the 400th answers', async () => {
      assert.ok(shown.length > CATALOG_PAGE_MAX + 50, `PREMISE: more extensions than one answer held (${shown.length})`);
      const first = await get('/api/admin/extensions/catalog');
      assert.equal(first.content.length, CATALOG_PAGE_MAX, 'asked for no page, it answers the first 400 as it always did');
      assert.equal(first.matched, shown.length);
      assert.equal(first.offset, 0);
      const seen: string[] = [];
      for (let offset = 0; offset < first.matched; offset += 100) {
        const page = await get(`/api/admin/extensions/catalog?offset=${offset}&limit=100`);
        assert.equal(page.offset, offset);
        assert.equal(page.limit, 100);
        assert.equal(page.shown, page.content.length);
        assert.equal(page.matched, first.matched, 'the count of matches does not change with the page');
        seen.push(...page.content.map((e: { pkgName: string }) => e.pkgName));
      }
      assert.equal(new Set(seen).size, seen.length, 'no extension on two pages');
      assert.deepEqual(new Set(seen), new Set(shown), 'every extension is on some page');
      const last = await get(`/api/admin/extensions/catalog?offset=${CATALOG_PAGE_MAX}&limit=50`);
      assert.ok(last.content.length > 0 && !first.content.some((e: { pkgName: string }) => e.pkgName === last.content[0].pkgName),
        'a page past the 400th holds extensions the first answer did not');
      // Installed first, then the rest by name, across the pages as within one.
      assert.deepEqual(seen.slice(0, 3).sort(), [PKG.mangaBall, PKG.nightShelf, PKG.webtoons].sort(), 'the installed ones lead');
    });

    await t.test('a page is never larger than 400, and a nonsense page is the first', async () => {
      const big = await get('/api/admin/extensions/catalog?limit=5000');
      assert.equal(big.limit, CATALOG_PAGE_MAX);
      assert.equal(big.content.length, CATALOG_PAGE_MAX);
      const junk = await get('/api/admin/extensions/catalog?offset=-7&limit=abc');
      assert.equal(junk.offset, 0);
      assert.equal(junk.limit, CATALOG_PAGE_MAX);
      const past = await get(`/api/admin/extensions/catalog?offset=${shown.length + 10}&limit=20`);
      assert.deepEqual(past.content, [], 'past the end: an empty page, not an error');
      assert.equal(past.matched, shown.length);
    });

    /** Reintroduce by dropping the `updates` filter: "only the extensions with an update waiting" fails. */
    await t.test('updates=true lists only the extensions with an update waiting', async () => {
      fake.extension(PKG.mangaBall).hasUpdate = true;
      fake.extension(made.extensions[3].pkgName).hasUpdate = true;
      try {
        const r = await get('/api/admin/extensions/catalog?updates=true&nsfw=true');
        assert.deepEqual(r.content.map((e: { pkgName: string }) => e.pkgName).sort(), [PKG.mangaBall, made.extensions[3].pkgName].sort(),
          'only the extensions with an update waiting');
        assert.equal(r.updatable, 2);
      } finally {
        fake.extension(PKG.mangaBall).hasUpdate = false;
        fake.extension(made.extensions[3].pkgName).hasUpdate = false;
      }
    });

    /**
     * Reintroduce the whole catalogue's count (`all.filter(...)` for hiddenAdult): a search that matches one 18+
     * extension says every 18+ extension in the repository is hidden, and "counts the 18+ extensions the search found"
     * fails.
     */
    await t.test('hiddenAdult counts the 18+ extensions the search found, not the whole repository', async () => {
      const adult = made.extensions.find((e) => e.isNsfw)!;
      const r = await get(`/api/admin/extensions/catalog?q=${encodeURIComponent(adult.name)}`);
      assert.ok(!r.content.some((e: { pkgName: string }) => e.pkgName === adult.pkgName), 'PREMISE: an 18+ extension stays out by default');
      assert.equal(r.hiddenAdult, made.extensions.filter((e) => e.isNsfw && e.name.toLowerCase().includes(adult.name.toLowerCase())).length,
        'counts the 18+ extensions the search found');
      assert.ok(r.hiddenAdult >= 1);
      const shownToo = await get(`/api/admin/extensions/catalog?q=${encodeURIComponent(adult.name)}&nsfw=true`);
      assert.ok(shownToo.content.some((e: { pkgName: string }) => e.pkgName === adult.pkgName), 'nsfw=true shows it');
      assert.equal(shownToo.hiddenAdult, 0);
    });

    /**
     * The engine's own page installed Webtoons.com, Manga Ball and Night Shelf: Uchiyomi has no rows for their sources.
     * Reintroduce by dropping the `enable` branch (and its enum value): the route answers 400 and 'the route takes
     * "enable"' fails.
     */
    await t.test('"Turn on its sources" switches on an extension installed in the engine\'s own page', async () => {
      await q('DELETE FROM suwayomi_sources');
      const r = await post(`/api/admin/extensions/catalog/${PKG.mangaBall}`, { action: 'enable' });
      assert.equal(r.statusCode, 200, `the route takes "enable": ${r.body}`);
      assert.deepEqual({ ...r.json(), registered: undefined }, { ok: true, sources: 1, on: 1, hidden: 0, registered: undefined });
      assert.equal((await rows())[SOURCE_IDS.mangaBall], true, 'turns its sources on');
      assert.ok(fake.graphqlCalls('updateExtension').length === 0, 'the engine was asked to install nothing');
      const audit = await q<{ detail: any }>(`SELECT detail FROM audit_log WHERE event = 'extension.enable' ORDER BY at DESC LIMIT 1`);
      assert.deepEqual(audit[0]?.detail, { pkgName: PKG.mangaBall, on: 1 });
    });

    /**
     * Reintroduce `enabled = EXCLUDED.enabled` in turnOnExtensionSources (adoptExtensionSources' rule): the source in a
     * hidden language that someone switched on by hand goes off, and "never switches one off" fails.
     */
    await t.test('a hidden language stays off, and a source switched on by hand stays on', async () => {
      const multi = made.extensions.find((e) => e.lang === 'all' && made.sources.filter((s) => s.pkgName === e.pkgName).length >= 2)!;
      const [keep, hide] = made.sources.filter((s) => s.pkgName === multi.pkgName);
      fake.extension(multi.pkgName).installed = true;
      try {
        await q(`UPDATE server_settings SET hidden_langs = $1::jsonb WHERE id = 1`, [JSON.stringify([hide.lang])]);
        const r = await post(`/api/admin/extensions/catalog/${multi.pkgName}`, { action: 'enable' });
        assert.equal(r.statusCode, 200, r.body);
        assert.equal(r.json().hidden, 1, 'one source left off for its language');
        let now = await rows();
        assert.equal(now[keep.id], true);
        assert.equal(now[hide.id], false, 'a hidden language stays off');
        const byHand = await post('/api/admin/extensions/sources/bulk', { ids: [hide.id], enabled: true });
        assert.equal(byHand.statusCode, 200, byHand.body);
        const again = await post(`/api/admin/extensions/catalog/${multi.pkgName}`, { action: 'enable' });
        assert.equal(again.statusCode, 200, again.body);
        now = await rows();
        assert.equal(now[hide.id], true, 'never switches one off');
      } finally {
        fake.extension(multi.pkgName).installed = false;
        await q(`UPDATE server_settings SET hidden_langs = '[]' WHERE id = 1`);
      }
    });

    await t.test('"Turn on its sources" on an extension that is not installed says so, and writes nothing', async () => {
      const before = await rows();
      const r = await post(`/api/admin/extensions/catalog/${PKG.shelfTwo}`, { action: 'enable' });
      assert.equal(r.statusCode, 409);
      assert.equal(r.json().error, 'no_sources');
      assert.deepEqual(await rows(), before);
    });

    /**
     * Reintroduce by dropping rememberMissing from the bulk route: the switch updates no row for a source Uchiyomi has
     * not recorded yet, answers changed: 0, and "a source with no row yet is switched on" fails.
     */
    await t.test('a language switch on a source Uchiyomi has not recorded yet switches it on', async () => {
      await q('DELETE FROM suwayomi_sources WHERE source_id = $1', [SOURCE_IDS.webtoons]);
      const r = await post('/api/admin/extensions/sources/bulk', { ids: [SOURCE_IDS.webtoons], enabled: true });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().changed, 1, 'a source with no row yet is switched on');
      assert.equal((await rows())[SOURCE_IDS.webtoons], true, 'and its row says so');
      // A source it knows costs the engine nothing more than the reload it always did.
      const asked = fake.graphqlCalls('sources').length;
      const off = await post('/api/admin/extensions/sources/bulk', { ids: [SOURCE_IDS.webtoons], enabled: false });
      assert.equal(off.statusCode, 200, off.body);
      assert.equal(fake.graphqlCalls('sources').length - asked, 1, 'the reload\'s one look, and no other');
    });

    /** Reintroduce by dropping `used` from the rows: "the series that came from it" fails. */
    await t.test('each source says how many series came from it', async () => {
      const r = await get(`/api/admin/extensions/sources?pkg=${encodeURIComponent(PKG.mangaBall)}`);
      assert.equal(r.content.length, 1);
      assert.equal(r.content[0].used, 2, 'the series that came from it, not the removed one');
      const w = await get(`/api/admin/extensions/sources?pkg=${encodeURIComponent(PKG.webtoons)}`);
      assert.equal(w.content[0].used, 0);
    });
  } finally {
    [console.warn, console.log] = quiet;
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [SERIES]).catch(() => {});
    await q('DELETE FROM suwayomi_sources').catch(() => {});
    await app.close();
    await fake.close();
    const { pool } = await import('../src/lib/db');
    await pool.end().catch(() => {});
  }
});
