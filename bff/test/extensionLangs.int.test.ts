// Hiding extension languages (issue #38): the standing instruction, the bulk switch, and the route.
//
// The helpers are pure SQL, so the rule "a hidden language stays off on install" is proved here without an
// engine. The route is driven over HTTP the way installConsent.int.test.ts does it, against the same
// unroutable SUWAYOMI_URL extensionMonitor.int.test.ts uses: reloadAll() fails soft against it, which is
// exactly what the route must survive.
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
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const USER = 'xl-admin';

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const langs = await import('../src/lib/sources/suwayomi/langs');
  await migrate();
  await q('DELETE FROM suwayomi_sources');
  await q(`UPDATE server_settings SET hidden_langs = '[]' WHERE id = 1`);
  await q(`INSERT INTO suwayomi_sources (source_id, name, lang, enabled) VALUES
             ('a', 'A', 'en', true), ('b', 'B', 'ru', true), ('c', 'C', 'ru', true)`);
  return { q, langs };
}

const state = async (q: any) =>
  Object.fromEntries((await q('SELECT source_id, enabled FROM suwayomi_sources ORDER BY 1')).map((r: any) => [r.source_id, r.enabled]));
const hidden = async (q: any) => (await q('SELECT hidden_langs FROM server_settings WHERE id = 1'))[0].hidden_langs;

test('hiding a language turns its sources off, and stays hidden', { skip }, async (t) => {
  const { q, langs } = await setup();
  try {
    await t.test('by language: the sources flip and the preference is recorded', async () => {
      const r = await langs.setSourcesEnabled({ langs: ['ru'], enabled: false });
      assert.equal(r.changed, 2, 'both Russian sources should have flipped');
      assert.deepEqual(await state(q), { a: true, b: false, c: false });
      // Reintroduce by dropping the hidden_langs write in setSourcesEnabled: "the language is remembered" fails,
      // and the next install turns Russian straight back on.
      assert.ok((await hidden(q)).includes('ru'), 'the language is remembered as hidden');
      assert.deepEqual(r.hiddenLangs, ['ru']);
    });

    await t.test('installing an extension leaves a hidden language off', async () => {
      const r = await langs.adoptExtensionSources([
        { id: 'd', name: 'D', lang: 'en' }, { id: 'e', name: 'E', lang: 'ru' },
      ], true);
      // Reintroduce by writing `enable` instead of `want` into the INSERT in adoptExtensionSources: "e stays
      // off" fails -- the row for the Russian source comes back enabled.
      assert.deepEqual(await state(q), { a: true, b: false, c: false, d: true, e: false }, 'e stays off');
      assert.deepEqual(r, { on: 1, hidden: 1 });
    });

    await t.test('showing it again turns every source of that language on and forgets the preference', async () => {
      const r = await langs.setSourcesEnabled({ langs: ['ru'], enabled: true });
      assert.equal(r.changed, 3, 'b, c and the newly adopted e');
      assert.deepEqual(await state(q), { a: true, b: true, c: true, d: true, e: true });
      assert.ok(!(await hidden(q)).includes('ru'), 'the code is removed');
      assert.deepEqual(r.hiddenLangs, []);
    });

    await t.test('by id: the source flips and the preference is untouched', async () => {
      await langs.setSourcesEnabled({ langs: ['ru'], enabled: false });
      const before = await hidden(q);
      const r = await langs.setSourcesEnabled({ ids: ['a'], enabled: false });
      assert.equal(r.changed, 1);
      assert.equal((await state(q)).a, false);
      // Reintroduce by treating ids like langs (recording the ids' languages in hidden_langs, or clearing the
      // list when enabling by id): "hidden_langs unchanged" fails.
      assert.deepEqual(await hidden(q), before, 'hidden_langs unchanged');
      await langs.setSourcesEnabled({ ids: ['a'], enabled: true });
      assert.deepEqual(await hidden(q), before, 'hidden_langs unchanged after enabling by id too');
    });

    await t.test('two languages hidden at the same moment are both remembered', async () => {
      // The panel disables only the button that was pressed while its call sits in a reload round-trip, so a
      // second language can be hidden before the first write lands. Without the row lock each call reads the
      // list, and the last writer wins with the other language's code missing: sources off, preference
      // forgotten, next install turns them back on. Reintroduce by dropping FOR UPDATE from readHidden()
      // (call it with forUpdate false): the `both remembered` assertion fails with one code.
      //
      // Ten rounds, not one: a single pair interleaves the wrong way most of the time but not every time
      // (measured 19 of 20 without the lock), and a guard that passes on a lucky ordering guards nothing.
      await q(`INSERT INTO suwayomi_sources (source_id, name, lang, enabled) VALUES ('f', 'F', 'fr', true) ON CONFLICT (source_id) DO NOTHING`);
      let lost = 0;
      for (let round = 0; round < 10; round++) {
        await q(`UPDATE server_settings SET hidden_langs = '[]' WHERE id = 1`);
        await q(`UPDATE suwayomi_sources SET enabled = true`);
        await Promise.all([
          langs.setSourcesEnabled({ langs: ['ru'], enabled: false }),
          langs.setSourcesEnabled({ langs: ['fr'], enabled: false }),
        ]);
        if ([...(await hidden(q))].sort().join() !== 'fr,ru') lost++;
      }
      assert.equal(lost, 0, 'both remembered');
      await langs.setSourcesEnabled({ langs: ['fr'], enabled: true });
      await q(`DELETE FROM suwayomi_sources WHERE source_id = 'f'`);
      await langs.setSourcesEnabled({ langs: ['ru'], enabled: false }); // back to the state the next test expects
    });

    await t.test('the overview counts sources, enabled and series per language', async () => {
      await q(`DELETE FROM lib_series WHERE id = 's_xl_ru'`);
      await q(`INSERT INTO lib_series (id, source, title, folder, source_id, source_series_id)
               VALUES ('s_xl_ru', 'test', 'XL Fixture', 's_xl_ru', 'sw:b', '1')`);
      try {
        const rows = await langs.langOverview();
        const ru = rows.find((r) => r.lang === 'ru');
        assert.deepEqual(ru, { lang: 'ru', sources: 3, enabled: 0, used: 1, hidden: true });
        const en = rows.find((r) => r.lang === 'en');
        assert.deepEqual(en, { lang: 'en', sources: 2, enabled: 2, used: 0, hidden: false });
      } finally {
        await q(`DELETE FROM lib_series WHERE id = 's_xl_ru'`);
      }
    });
  } finally {
    await q('DELETE FROM suwayomi_sources');
    await q(`UPDATE server_settings SET hidden_langs = '[]' WHERE id = 1`);
  }
});

test('the bulk route: one statement, one reload', { skip }, async (t) => {
  const { q } = await setup();
  const adminRoutes = (await import('../src/routes/admin')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await q(`DELETE FROM users WHERE username = $1`, [USER]).catch(() => {});
  const admin = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind)
     VALUES ($1, $1, 'x', 'admin', 'password') RETURNING id`, [USER]))[0].id;
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(adminRoutes);
  await app.ready();
  const auth = { authorization: `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}` };
  const post = (payload: unknown) => app.inject({ method: 'POST', url: '/api/admin/extensions/sources/bulk', headers: auth, payload });
  try {
    await t.test('an empty selection is refused', async () => {
      // Reintroduce by removing the .refine from the bulk route's schema: `{ enabled: false }` is accepted,
      // matches nothing, reloads for nothing, and answers 200 with changed 0.
      for (const body of [{}, { enabled: false }, { ids: [], langs: [], enabled: false }]) {
        const r = await post(body);
        assert.equal(r.statusCode, 400, `${JSON.stringify(body)} should be a bad request`);
        assert.equal(r.json().error, 'bad_request');
      }
    });

    await t.test('a language is switched off in one call', async () => {
      const r = await post({ langs: ['ru'], enabled: false });
      assert.equal(r.statusCode, 200, r.body);
      const body = r.json();
      assert.equal(body.changed, 2, 'two sources should have flipped in the one call');
      assert.deepEqual(body.hiddenLangs, ['ru']);
      // the response echoes what setSourcesEnabled computed; the setting is what the next install reads
      assert.deepEqual(await hidden(q), ['ru'], 'persisted, not just echoed');
      assert.equal(typeof body.registered, 'number');
      assert.equal(typeof body.skipped, 'number');
      assert.deepEqual(await state(q), { a: true, b: false, c: false });
      const audit = await q(`SELECT event, detail FROM audit_log WHERE event = 'source.extension_disable' ORDER BY at DESC LIMIT 1`);
      assert.equal(audit[0]?.detail?.changed, 2, 'the audit row should carry the count');
    });

    await t.test('the status and source routes report the preference', async () => {
      const st = (await app.inject({ method: 'GET', url: '/api/admin/extensions/status', headers: auth })).json();
      assert.deepEqual(st.hiddenLangs, ['ru']);
      assert.equal(typeof st.cap, 'number');
      const src = (await app.inject({ method: 'GET', url: '/api/admin/extensions/sources', headers: auth })).json();
      assert.deepEqual(src.hiddenLangs, ['ru']);
      const ru = src.langs.find((l: any) => l.lang === 'ru');
      assert.ok(ru?.hidden, 'the overview should mark Russian hidden');
    });
  } finally {
    await app.close();
    await q('DELETE FROM suwayomi_sources');
    await q(`UPDATE server_settings SET hidden_langs = '[]' WHERE id = 1`);
    await q(`DELETE FROM users WHERE username = $1`, [USER]).catch(() => {});
  }
});
