// The one sources list (lib/sourcesOverview.ts, v0.54.0, GET /api/admin/sources/overview), through the real route.
//
// Providers listed only the extension sources registered, Extensions counted every source of an extension, and Health
// merged the off-switches with SQL of its own -- three lists that disagreed. These pin the one answer: every source of
// every kind (a pack's, MangaDex, a site added by address, an extension's switched on, off or not loaded, one a series
// still names), each with Health's own state and its standing, its series counted the way Replace counts them, the
// sources that need a look first and the switched-off ones last.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let DIR = '';
if (DSN) {
  DIR = mkdtempSync(join(tmpdir(), 'yomi-overview-'));
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.CUSTOM_SITES_FILE = join(DIR, 'sites.json');
  process.env.SOURCES_DIR = join(DIR, 'pack');
  process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_ov', ADMIN = 'ov-admin';
const LOADED = ['ov-off', 'ov-off2', 'ov-a', 'ov-fail', 'ov-used'];
const SW = ['9990011', '9990012', '9990013'];
const S = (k: string) => `s_ov_${k}`;
let q: any, app: any, auth: Record<string, string>, hiddenWas: unknown;

async function series(key: string, main: string, follows: string[] = []) {
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id)
           VALUES ($1,'T!ov',$1,$1,1,$2,$3,$4)`, [S(key), LIB, main, `${main}|${key}`]);
  for (const f of follows) await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1, $2, $3)`, [S(key), f, `${f}|${key}`]);
}
const clean = async () => {
  await q('DELETE FROM lib_series WHERE library_id = $1', [LIB]);
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[...LOADED, ...SW.map((x) => `sw:${x}`), 'ovsite', 'ov-pack']]);
  await q('DELETE FROM suwayomi_sources WHERE source_id = ANY($1::text[])', [SW]);
};

before(async () => {
  if (!DSN) return;
  // A source pack, and a site added by address, as the server loads them.
  mkdirSync(process.env.SOURCES_DIR!, { recursive: true });
  writeFileSync(join(process.env.SOURCES_DIR!, 'ovpack.cjs'), `exports.ovPack = { id: 'ov-pack', name: 'OV Pack',
    search: async () => [], getSeries: async () => null, listChapters: async () => [], getPageUrls: async () => [] };`);
  writeFileSync(process.env.CUSTOM_SITES_FILE!, JSON.stringify([{ engine: 'madara', id: 'ovsite', name: 'OV Site', base: 'https://ov-site.invalid', order: 100 }]));
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  await migrate();
  const { reloadAll, registerAdapter } = await import('../src/lib/sources');
  await reloadAll();
  for (const id of LOADED) {
    registerAdapter({ id, name: `Name ${id}`, search: async () => [], getSeries: async () => null, listChapters: async () => [], getPageUrls: async () => [] } as any);
  }
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Overview',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q('DELETE FROM users WHERE username = $1', [ADMIN]);
  const adminId = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','admin','password') RETURNING id`, [ADMIN]))[0].id;
  [{ hidden_langs: hiddenWas }] = await q('SELECT hidden_langs FROM server_settings WHERE id = 1');
  const Fastify = (await import('fastify')).default;
  app = Fastify();
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  auth = { authorization: `Bearer ${app.jwt.sign({ sub: adminId, role: 'admin' })}` };
  await clean();
});

after(async () => {
  if (DIR) rmSync(DIR, { recursive: true, force: true });
  if (!DSN) return;
  await app?.close();
  await clean().catch(() => {});
  await q('UPDATE server_settings SET hidden_langs = $1::jsonb WHERE id = 1', [JSON.stringify(hiddenWas ?? [])]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [ADMIN]).catch(() => {});
  await (await import('../src/lib/db')).pool.end().catch(() => {});
});

test('every source of every kind in one answer, each with its state, standing and series, what needs a look first and the switched-off last', { skip }, async () => {
  // Reintroduce by leaving the extensions' own rows out of the ids: the switched-off extension sources nothing uses are
  // missing. By counting every follower as a backup (not the Replace rule): ov-off reads withBackup 3. By dropping
  // the attention rank from the order: the failing source nothing uses is not second.
  const at = new Date().toISOString();
  await q(`INSERT INTO suwayomi_sources (source_id, name, lang, enabled, pkg_name) VALUES
             ('9990011', 'Ext On', 'en', true, 'eu.kanade.ov'), ('9990012', 'Ext Hidden', 'ru', false, 'eu.kanade.ov'),
             ('9990013', 'Ext Off', 'xx', false, 'eu.kanade.ov')`);
  await q(`UPDATE server_settings SET hidden_langs = '["ru"]'::jsonb WHERE id = 1`);
  await q(`INSERT INTO source_health (source_id, disabled, stages, live_at, live_by, live_state, live_stage) VALUES
             ('ov-off', true, '{}'::jsonb, NULL, NULL, NULL, NULL),
             ('ov-off2', true, '{}'::jsonb, NULL, NULL, NULL, NULL),
             ('ov-fail', false, $1::jsonb, $2, 'test', 'fail', 'chapters')`,
    [JSON.stringify({ chapters: { failAt: at, failBy: 'test', since: at, kind: 'error', error: 'HTTP 500' } }), at]);
  // ov-off is the main source of three: two follow a working source, one only a switched-off one.
  await series('1', 'ov-off', ['ov-a']);
  await series('2', 'ov-off', ['ov-a']);
  await series('3', 'ov-off', ['ov-off2']);
  // ov-used is followed by two series and the main source of none; one is on a site, one on an extension not loaded.
  await series('4', 'ovsite', ['ov-used']);
  await series('5', 'ov-a', ['ov-used']);
  await series('6', 'sw:9990011');

  const r = await app.inject({ method: 'GET', url: '/api/admin/sources/overview', headers: auth });
  assert.equal(r.statusCode, 200, r.body);
  const { sources, attention, ...rest } = r.json();
  assert.deepEqual(Object.keys(rest), [], 'the engine stays GET /api/admin/extensions/status\'s');
  const by = Object.fromEntries(sources.map((s: any) => [s.id, s]));

  assert.deepEqual(by['ov-off'], {
    id: 'ov-off', name: 'Name ov-off', kind: 'builtin', lang: null, standing: 'off', offBy: 'admin', state: 'off', stage: null,
    cooldown: null, offline: false, main: 3, followed: 0, withBackup: 2, lastTestedAt: null, icon: false,
  }, 'a switched-off main source, its series and how many a working follower would take over');
  assert.deepEqual([by['ov-fail'].standing, by['ov-fail'].state, by['ov-fail'].stage, by['ov-fail'].lastTestedAt], ['failing', 'failing', 'chapters', at]);
  assert.deepEqual([by['ov-used'].main, by['ov-used'].followed], [0, 2], 'followed without being the main source');
  assert.deepEqual([by['ov-a'].main, by['ov-a'].followed, by['ov-a'].standing], [1, 2, 'usable']);
  assert.deepEqual([by.ovsite.kind, by.ovsite.address, by.ovsite.main], ['site', 'https://ov-site.invalid', 1], 'a site added by address, with its address');
  assert.equal(by['ov-pack'].kind, 'pack', "a source pack's");
  assert.deepEqual([by.mangadex?.kind, by.mangadex?.lang], ['mangadex', 'en'], 'MangaDex');
  assert.deepEqual([by['sw:9990011'].kind, by['sw:9990011'].standing, by['sw:9990011'].pkgName, by['sw:9990011'].name, by['sw:9990011'].main],
    ['extension', 'not_loaded', 'eu.kanade.ov', 'Ext On', 1], "an extension's source no engine has registered, named as the engine named it");
  assert.ok(by['sw:9990012'] && by['sw:9990013'], 'the switched-off extension sources nothing uses are listed');
  assert.deepEqual([by['sw:9990012'].standing, by['sw:9990012'].offBy, by['sw:9990012'].state, by['sw:9990012'].lang], ['off', 'language', 'off', 'ru'],
    'switched off by hiding its language');
  assert.deepEqual([by['sw:9990013'].standing, by['sw:9990013'].offBy], ['off', 'extension'], 'switched off in its extension');
  assert.equal('pkgName' in by['ov-a'], false, 'pkgName is an extension source\'s alone');

  assert.ok(attention.replace.includes('ov-off'), 'the source to replace: off, and the main source of series');
  assert.equal(attention.replace.includes('ov-off2'), false, 'one off with no series of its own is nothing to replace');
  assert.ok(attention.failingUnused.includes('ov-fail'), 'a failing source nothing uses');
  assert.equal(attention.updates, 0, 'no extension engine, no updates');
  const order = sources.map((s: any) => s.id);
  assert.deepEqual(order.slice(0, 2), ['ov-off', 'ov-fail'], 'what needs a look first, the most used first');
  const firstOff = sources.findIndex((s: any) => s.standing === 'off' && !attention.replace.includes(s.id));
  assert.ok(firstOff > 0 && sources.slice(firstOff).every((s: any) => s.standing === 'off'), `switched off last: ${order.join(' ')}`);
  assert.ok(order.indexOf('ov-a') < order.indexOf('ov-used'), 'then by how many series use it');
});
