// With the desktop switch OFF, the server is the server (runs in its own process, switch unset).
//
// Uchiyomi Desktop runs this same code with `UCHIYOMI_DESKTOP=1`. Every desktop difference goes through
// lib/desktop.ts, and each of its exports has a server arm that must hand back exactly what the server used
// before the desktop work existed. This file proves those arms, with the environment a server has: no flag.
// The route table half of "unchanged" is openapiCoverage.test.ts, which registers every plugin with the switch
// off and fails on any route the spec does not describe -- `/auth/desktop` included.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// The environment a server has: no flag. A stray secret, to prove it is left exactly where it was.
delete process.env.UCHIYOMI_DESKTOP;
const STRAY_SECRET = 'a'.repeat(64);
process.env.UCHIYOMI_DESKTOP_SECRET = STRAY_SECRET;

test('importing lib/desktop.ts with the switch off changes nothing in process.env', async () => {
  const before = { ...process.env };
  const d = await import('../src/lib/desktop');
  // Reintroduce by writing a desktop default outside `if (ON)` in lib/desktop.ts (say `process.env.MIN_FREE_GB
  // ||= '5'`): the Docker image quietly boots with a desktop setting.
  assert.deepEqual({ ...process.env }, before, 'lib/desktop.ts changed the environment of a server');
  // Reintroduce by deleting the secret outside `if (ON)`: harmless here, but it means the module is acting
  // on the environment while it claims to be off.
  assert.equal(process.env.UCHIYOMI_DESKTOP_SECRET, STRAY_SECRET, 'the secret variable was touched while off');
  assert.equal(d.isDesktop(), false);
});

test('every server arm hands back the server value', async () => {
  const d = await import('../src/lib/desktop');
  // Reintroduce by returning DESKTOP_FLOORS[key] whatever the switch says: a server's first sweep after a
  // deploy runs two minutes in instead of ten.
  for (const key of Object.keys(d.DESKTOP_FLOORS) as Array<keyof typeof d.DESKTOP_FLOORS>) {
    for (const ms of [0, 1, 10 * 60 * 1000, 30 * 60 * 1000]) {
      assert.equal(d.firstRunFloor(ms, key), ms, `firstRunFloor(${ms}, '${key}') is not the server's value`);
    }
  }
  // Reintroduce by swapping forDesktop's arms: every Docker/PUID message turns into desktop wording.
  assert.equal(d.forDesktop('server words', 'desktop words'), 'server words');
  const obj = { a: 1 };
  assert.equal(d.forDesktop(obj, { a: 2 }), obj, 'forDesktop must hand back the very same server value');
  // Off, nothing can open the sign-in handshake -- not even the secret that happens to be in the environment.
  assert.equal(d.desktopSecretMatches(STRAY_SECRET), false);
  assert.deepEqual(d.desktopHosts(), []);
  assert.equal(d.desktopPort(), 0);
});

test('the flag reads words the way envFlag does: "false", "0" and "" are off', async () => {
  const { flagOn } = await import('../src/lib/desktop');
  // Reintroduce by parsing with Boolean(v): the STRING "false" is truthy and a server with
  // UCHIYOMI_DESKTOP=false in its compose file boots as a desktop app on 127.0.0.1.
  for (const v of [undefined, '', '   ', 'false', 'FALSE', '0', 'no', 'off', 'desktop', '2'])
    assert.equal(flagOn(v), false, `${JSON.stringify(v)} should mean off`);
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' 1 '])
    assert.equal(flagOn(v), true, `${JSON.stringify(v)} should mean on`);
});

test('env.ts still makes the push keys on a server (the desktop arm skips them)', async () => {
  // The one line env.ts changed: `isDesktop() ? null : ensureVapidKeys()`.
  // Reintroduce by swapping the arms: a server's Notifications card goes dark with no error anywhere.
  const dir = mkdtempSync(join(tmpdir(), 'uchi-off-'));
  process.env.CONFIG_DIR = dir;
  process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
  process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  const { env } = await import('../src/env');
  assert.ok(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY, 'the server did not generate its VAPID keys');
  assert.ok(existsSync(join(dir, 'vapid.json')), 'the keys were not persisted beside the JWT secret');
  // And none of the desktop defaults leaked in on the way.
  assert.equal(env.PUBLIC_ORIGIN, process.env.PUBLIC_ORIGIN ?? 'http://localhost:3000');
  assert.equal(env.CACHE_MAX_BYTES, 16 * 1024 * 1024 * 1024);
});

test('a typed library path is kept exactly as typed on a server (diskSpelling is desktop-only)', async () => {
  // After the env test on purpose: importing libraryAdmin loads env.ts, which must see that test's CONFIG_DIR.
  // Reintroduce by dropping `!isDesktop() ||` from diskSpelling's early return: a Linux server rewrites typed
  // Admin → Library paths (folder browser, preview, create, re-path) and rename destinations to the case already
  // on disk, so `manga/seinen` is stored as `Manga/Seinen` -- on a case-sensitive disk, another folder.
  process.env.CONFIG_DIR ||= mkdtempSync(join(tmpdir(), 'uchi-off-'));
  process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
  process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
  const root = mkdtempSync(join(tmpdir(), 'uchi-off-spell-'));
  mkdirSync(join(root, 'Manga', 'Seinen'), { recursive: true });
  const { diskSpelling } = await import('../src/lib/libraryAdmin');
  assert.equal(await diskSpelling([root], 'manga/seinen'), 'manga/seinen', 'the server respelled a typed path to the disk');
});
