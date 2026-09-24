// The bff's environment (contract 1) and the parts of it bff/src/lib/desktop.ts owns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { bffEnv, CONTRACT, EXTRA, DERIVED_BY_BFF, KEEP } = require('../src/env.js');
const { layout } = require('../src/paths.js');

const L = layout('/data/Uchiyomi');
const base = {
  L, resources: '/app/resources', uiPort: 41234, pgPort: 41235, pgPassword: 'pgpw', pgBinDir: '/app/resources/pg/bin',
  libraryDir: '/home/me/Uchiyomi Library', secret: 's'.repeat(43), solverUrl: 'http://127.0.0.1:41236/abcdef0123456789abcdef0123456789',
  enginePort: 41237, engineUser: 'uchiyomi-eu', enginePass: 'ep', osUser: 'Jösé',
  platform: 'linux',
  baseEnv: { PATH: '/usr/bin', HOME: '/home/me', PGHOST: 'elsewhere', DATABASE_URL: 'postgres://stray', NODE_OPTIONS: '--inspect', ELECTRON_RUN_AS_NODE: '1', CONFIG_DIR: '/config', LANG: 'de_DE.UTF-8' },
};

test('the shell sets exactly contract 1 (+ NODE_ENV, EMBEDDED_DB), nothing the bff derives, and only allowlisted OS variables', () => {
  // Reintroduce by setting CONFIG_DIR (or any DERIVED_BY_BFF name) in bffEnv: "nothing the bff derives" fails.
  const e = bffEnv(base);
  const ours = Object.keys(e).filter((k) => !KEEP.has(k.toUpperCase()) && k !== 'LD_LIBRARY_PATH');
  assert.deepEqual(ours.sort(), [...CONTRACT.filter((k) => k !== 'LIBRARY_ROOT'), ...EXTRA].sort());
  for (const k of DERIVED_BY_BFF) assert.equal(e[k], undefined, `${k} is derived by bff/src/lib/desktop.ts; the shell must not set it`);
  for (const k of ['PGHOST', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) assert.equal(e[k], undefined, `${k} leaked from the shell's environment`);
  assert.equal(e.DATABASE_URL, 'postgres://yomi@127.0.0.1:41235/yomi'); // ours, not the stray one, and no password in it
  assert.equal(e.LANG, 'de_DE.UTF-8');
});

test('contract 1 values', () => {
  // Reintroduce by setting SUWAYOMI_URL only once the engine is installed: it is missing here.
  const e = bffEnv(base);
  assert.equal(e.UCHIYOMI_DESKTOP, '1');
  assert.equal(e.UCHIYOMI_DATA_DIR, '/data/Uchiyomi');
  assert.equal(e.PORT, '41234');
  assert.equal(e.DL_ROOT, '/home/me/Uchiyomi Library');
  assert.ok(e.UCHIYOMI_DESKTOP_SECRET.length >= 32);
  assert.equal(e.PGPASSWORD, 'pgpw');
  assert.equal(e.PG_DUMP_PATH, path.join('/app/resources/pg/bin', 'pg_dump'));
  assert.equal(e.WEB_ROOT, path.join('/app/resources', 'web'));
  assert.equal(e.FLARESOLVERR_URL, base.solverUrl);
  // Always set, even before the engine is installed: the bff says "engine not running" until it is.
  assert.equal(e.SUWAYOMI_URL, 'http://127.0.0.1:41237');
  assert.equal(e.SUWAYOMI_USERNAME, 'uchiyomi-eu');
  assert.equal(e.SUWAYOMI_PASSWORD, 'ep');
  assert.equal(e.UCHIYOMI_DESKTOP_USER, 'Jösé');
  assert.equal(e.LIBRARY_ROOT, undefined);
  assert.equal(bffEnv({ ...base, readLibrary: '/mnt/manga' }).LIBRARY_ROOT, '/mnt/manga');
});

test('Windows: pg_dump.exe, and System32 right after the bundled bin/ on PATH (Git\'s GNU tar reads C:\\ as a host)', () => {
  // Reintroduce by dropping System32 from the bff's PATH.
  const e = bffEnv({ ...base, platform: 'win32', pgBinDir: 'C:\\app\\resources\\pg\\bin', baseEnv: { Path: 'C:\\Git\\usr\\bin;C:\\Windows', SystemRoot: 'C:\\Windows' } });
  assert.match(e.PG_DUMP_PATH, /pg_dump\.exe$/);
  assert.ok(e.Path.startsWith('C:\\app\\resources\\pg\\bin;'), e.Path);
  assert.ok(e.Path.includes(';C:\\Windows' + path.sep + 'System32;') || e.Path.includes(';C:\\Windows/System32;'), e.Path);
  assert.equal(e.PATH, undefined, 'the existing Path key is reused, not a second PATH');
});

test("bff/src/lib/desktop.ts accepts this environment and derives CONFIG_DIR/BACKUP_DIR where the shell's restore looks", async () => {
  // Reintroduce by renaming paths.js's backups folder: the shell restores from where the bff never writes.
  // The shell restores into L.config and opens L.backups; the bff derives both from UCHIYOMI_DATA_DIR. If the two
  // ever disagree, "Restore backup" would unpack the settings where the server never reads them.
  const { desktopPlan } = await import('../../bff/src/lib/desktop.ts');
  const plan = desktopPlan(bffEnv(base));
  assert.equal(plan.set.CONFIG_DIR, L.config);
  assert.equal(plan.set.BACKUP_DIR, L.backups);
  assert.equal(plan.set.LIBRARY_BACKEND, 'owned');
  assert.equal(plan.port, 41234);
});
