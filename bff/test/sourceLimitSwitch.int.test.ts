// Switching an extension's source off or on in Health while the source limit is full (v0.59.0, POST
// /api/admin/sources/:id/:action), against the strict fake engine.
//
// A source switched off in Health registers after every working one (suwayomi/register.ts), so while the limit leaves
// something out, a switch changes which sources fit. The flag was all a switch wrote: switched back on, a source the
// limit had left out stayed out of everything -- Discover, the searches, its series' updates -- until the next restart.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FakeSeed, FakeSuwayomi } from './fixtures/fakeSuwayomi';

const DSN = process.env.TEST_DATABASE_URL;
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
/** In the engine's order. */
const ID = { a: '7200000000000000100', b: '7200000000000000200', c: '7200000000000000300' };
const IDS = Object.values(ID);
const sw = (id: string) => `sw:${id}`;
const ADMIN = 'lsw-admin';

function seed(): FakeSeed {
  const pkg = (k: string) => `eu.kanade.tachiyomi.extension.en.limit${k}`;
  return {
    sources: Object.entries(ID).map(([k, id]) => ({
      id, name: `Limit ${k.toUpperCase()}`, lang: 'en', pkgName: pkg(k), supportsLatest: true, isNsfw: false, baseUrl: `https://limit-${k}.example`, mangas: [],
    })),
    extensions: Object.keys(ID).map((k) => ({ pkgName: pkg(k), name: `Limit ${k.toUpperCase()}`, lang: 'en', versionName: '1.0.0', installed: true, isNsfw: false, versionCode: 1 })),
    settings: {},
  };
}

let fake: FakeSuwayomi | null = null, ROOT = '';
let q: any, app: any, env: any, sources: typeof import('../src/lib/sources'), limitWas = 0;
const H: Record<string, string> = {};
/** Which of the three are registered, in the engine's order. */
const registered = () => IDS.map(sw).filter((id) => !!sources.getSource(id));
const post = (id: string, action: string) => app.inject({ method: 'POST', url: `/api/admin/sources/${encodeURIComponent(id)}/${action}`, headers: H });

before(async () => {
  if (!DSN) return;
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-lsw-'));
  const { startFakeSuwayomi } = await import('./fixtures/fakeSuwayomi');
  fake = await startFakeSuwayomi({ seed: seed() });
  // ⚠️ Before anything from src: env.ts reads these once.
  process.env.DATABASE_URL = DSN;
  process.env.SUWAYOMI_URL = fake.url;
  process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.UCHIYOMI_PING_URL = '';
  process.env.SOURCES_DIR = join(ROOT, 'pack');
  process.env.CUSTOM_SITES_FILE = join(ROOT, 'sites.json');
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  await migrate();
  ({ env } = await import('../src/env'));
  limitWas = env.SUWAYOMI_MAX_SOURCES;
  sources = await import('../src/lib/sources');
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [IDS.map(sw)]);
  await q('DELETE FROM suwayomi_sources WHERE source_id = ANY($1::text[])', [IDS]);
  await q(`INSERT INTO suwayomi_sources (source_id, name, lang, enabled) SELECT id, id, 'en', true FROM unnest($1::text[]) AS id`, [IDS]);
  await q('DELETE FROM users WHERE username = $1', [ADMIN]);
  const adminId = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','admin','password') RETURNING id`, [ADMIN]))[0].id;
  const Fastify = (await import('fastify')).default;
  app = Fastify();
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  H.authorization = `Bearer ${app.jwt.sign({ sub: adminId, role: 'admin' })}`;
});

after(async () => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  if (!DSN) return;
  if (env) env.SUWAYOMI_MAX_SOURCES = limitWas;
  await app?.close();
  await fake?.close();
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [IDS.map(sw)]).catch(() => {});
  await q('DELETE FROM suwayomi_sources WHERE source_id = ANY($1::text[])', [IDS]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [ADMIN]).catch(() => {});
  await (await import('../src/lib/db')).pool.end().catch(() => {});
});

test('switched back on, it takes its slot at once; switched off, its slot goes to a working source', { skip }, async () => {
  // Reintroduce by only setting the flag: A stays unregistered after it is switched back on.
  await q(`INSERT INTO source_health (source_id, disabled) VALUES ($1, true)`, [sw(ID.a)]);
  env.SUWAYOMI_MAX_SOURCES = 2;
  await sources.reloadAll();
  assert.deepEqual(registered(), [sw(ID.b), sw(ID.c)], 'PREMISE: the switched-off source is the one the limit left out');

  const on = await post(sw(ID.a), 'enable');
  assert.equal(on.statusCode, 200, on.body);
  assert.deepEqual(registered(), [sw(ID.a), sw(ID.b)], 'switched back on, it is registered at once, in the engine\'s order');

  const off = await post(sw(ID.b), 'disable');
  assert.equal(off.statusCode, 200, off.body);
  assert.deepEqual(registered(), [sw(ID.a), sw(ID.c)], 'switched off, its slot went to the working source the limit had left out');
});

test('with nothing left out, a switch asks the engine nothing', { skip }, async () => {
  // Every source fits: a switch changes no registration, so it loads nothing. Reintroduce by loading on every switch:
  // the engine is asked for its sources.
  env.SUWAYOMI_MAX_SOURCES = 3;
  await sources.reloadAll();
  assert.equal(registered().length, 3, 'PREMISE: all three fit');
  const before = fake!.graphqlCalls().length;
  assert.equal((await post(sw(ID.c), 'disable')).statusCode, 200);
  assert.equal((await post(sw(ID.c), 'enable')).statusCode, 200);
  assert.equal(fake!.graphqlCalls().length, before, 'no load');
});
