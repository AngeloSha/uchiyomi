// The extension engine: the pin, the launch (spike S7's traps), and download -> verify -> unpack -> start ->
// stop against a fake pack whose `java` is a small Node script (fixtures/fake-engine.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { Engine, buildLaunch, resolvePack, platformKey, PIN } = require('../src/engine.js');
const { layout } = require('../src/paths.js');
const archive = require('../src/archive.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const POSIX = process.platform !== 'win32';

test('the pin: one pack per shipped platform, on the engine PRERELEASE tag; unpublished = no URL at all', () => {
  // Reintroduce by publishing the packs on a `v*` tag (engine-pin.json "tag"): electron-updater would offer it as the
  // app.
  assert.deepEqual(Object.keys(PIN.packs).sort(), ['mac-arm64', 'mac-x64', 'win-x64']);
  assert.match(PIN.tag, /^engine-v/, 'never a v* tag: electron-updater and the release trigger must not see it');
  assert.ok(PIN.baseUrl.endsWith(`/releases/download/${PIN.tag}`));
  for (const p of Object.values(PIN.packs)) assert.ok(p.sha256 === null || /^[0-9a-f]{64}$/.test(p.sha256));
  const unpublished = resolvePack({ ...PIN, packs: { 'win-x64': { file: 'x.zip', sha256: null } } }, {}, 'win-x64');
  assert.equal(unpublished.url, null);
  const pinned = resolvePack({ ...PIN, packs: { 'win-x64': { file: 'x.zip', sha256: 'A'.repeat(64), bytes: 5 } } }, {}, 'win-x64');
  assert.equal(pinned.url, `${PIN.baseUrl}/x.zip`);
  assert.equal(pinned.sha256, 'a'.repeat(64));
  assert.throws(() => resolvePack(PIN, { url: 'http://127.0.0.1/x.zip' }), /engine-pack-sha256/);
  assert.equal(platformKey('win32', 'arm64'), 'win-x64');
  assert.equal(platformKey('darwin', 'arm64'), 'mac-arm64');
  assert.equal(platformKey('darwin', 'x64'), 'mac-x64');
});

test("the launch keeps every S7 trap closed: kcef off, loopback, jar in bin/, no path or secret on the command line", () => {
  // Reintroduce by dropping kcefEnabled (or moving rootDir/the password to -D flags): this test names it.
  const l = buildLaunch({
    runtimeDir: 'C:\\ProgramData\\Uchiyomi\\abc\\engine-runtime\\v2.3.2243', rootDir: 'C:\\Users\\Jösé 名前\\AppData\\Local\\Uchiyomi\\engine',
    tmpDir: 'C:\\ProgramData\\Uchiyomi\\abc\\engine-tmp', port: 4567, fsUrl: 'http://127.0.0.1:1/tok', user: 'u', pass: 'sekret-pass',
    platform: 'win32', baseEnv: { Path: 'C:\\Windows', JAVA_TOOL_OPTIONS: '-Xmx8m', _JAVA_OPTIONS: '-x', CLASSPATH: 'c', JAVA_HOME: 'j', PGPASSWORD: 'pg', UCHIYOMI_DESKTOP_SECRET: 's', TEMP: 'C:\\Users\\Jösé 名前\\AppData\\Local\\Temp' },
  });
  const P = '-Dsuwayomi.tachidesk.config.server.';
  for (const flag of [`${P}kcefEnabled=false`, `${P}ip=127.0.0.1`, `${P}port=4567`, `${P}webUIEnabled=false`, `${P}systemTrayEnabled=false`,
    `${P}initialOpenInBrowserEnabled=false`, `${P}authMode=BASIC_AUTH`, `${P}flareSolverrEnabled=true`, '-Djava.awt.headless=true',
    '-Djava.util.prefs.PreferencesFactory=dev.uchiyomi.IsolatedPreferences$Factory']) {
    assert.ok(l.args.includes(flag), `missing ${flag}`);
  }
  assert.deepEqual(l.args.slice(l.args.indexOf('-cp'), l.args.indexOf('-cp') + 2), ['-cp', 'bin/Suwayomi-Server.jar;bin/uchiyomi-shim.jar']);
  assert.equal(l.args[l.args.length - 1], 'dev.uchiyomi.EngineShim');
  const argv = l.args.join(' ');
  for (const bad of ['Jösé', 'sekret-pass', '/tok', 'ProgramData', 'rootDir', 'authPassword']) assert.ok(!argv.includes(bad), `${bad} is on the command line`);
  assert.equal(l.cwd, 'C:\\ProgramData\\Uchiyomi\\abc\\engine-runtime\\v2.3.2243');
  assert.equal(l.cmd, path.join(l.cwd, 'jre', 'bin', 'java.exe'));
  assert.equal(l.env.UCHIYOMI_ENGINE_ROOT_DIR, 'C:\\Users\\Jösé 名前\\AppData\\Local\\Uchiyomi\\engine');
  assert.equal(l.env.UCHIYOMI_ENGINE_AUTH_PASSWORD, 'sekret-pass');
  assert.equal(l.env.UCHIYOMI_ENGINE_FLARESOLVERR_URL, 'http://127.0.0.1:1/tok');
  // The JVM's own startup temp dir is the ASCII one too, not the profile's.
  assert.equal(l.env.TEMP, 'C:\\ProgramData\\Uchiyomi\\abc\\engine-tmp');
  assert.equal(l.env.TMP, l.env.TEMP);
  for (const k of ['JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'CLASSPATH', 'JAVA_HOME', 'PGPASSWORD', 'UCHIYOMI_DESKTOP_SECRET']) assert.equal(l.env[k], undefined, `${k} reached the engine`);
});

/** A pack whose java runs fixtures/fake-engine.mjs; served over HTTP like the release asset. */
async function fakePack(dir) {
  const src = path.join(dir, 'pack-src');
  fs.mkdirSync(path.join(src, 'jre', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(src, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(src, 'jre', 'bin', 'java'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(here, 'fixtures', 'fake-engine.mjs')}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(src, 'bin', 'Suwayomi-Server.jar'), 'jar');
  fs.writeFileSync(path.join(src, 'bin', 'uchiyomi-shim.jar'), 'shim');
  fs.writeFileSync(path.join(src, 'engine.json'), JSON.stringify({ engine: 'suwayomi-server', version: 'vtest' }));
  const zip = path.join(dir, 'engine-pack-test.zip');
  await archive.writeZip(src, zip);
  const sha256 = await archive.sha256File(zip);
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    const body = fs.readFileSync(zip);
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': body.length });
    res.end(body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/engine-pack-test.zip`, sha256, close: () => srv.close(), hits: () => hits };
}

async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

const quiet = { info() {}, warn() {}, error() {} };

async function makeEngine(tmp, pack, extra = {}) {
  const L = layout(path.join(tmp, 'data'));
  fs.mkdirSync(L.logs, { recursive: true });
  const port = await freePort();
  const e = new Engine({
    L, log: quiet, pack: { version: 'vtest', key: 'test', bytes: null, file: 'engine-pack-test.zip', ...pack },
    port: () => port, creds: () => ({ user: 'eu', pass: 'ep' }), solverUrl: () => 'http://127.0.0.1:9/token', readyTimeoutMs: 20_000, ...extra,
  });
  const states = [];
  e.on('status', (s) => { if (states[states.length - 1] !== s.state) states.push(s.state); });
  return { e, L, port, states };
}

test('install: download -> verify -> unpack -> start -> "installed"; stop through stdin; a second install() joins the first', { skip: !POSIX }, async () => {
  let e, L, port, states;
  // Reintroduce by removing install()'s single-flight join: two clicks download the pack twice.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uchi-engine-'));
  const pack = await fakePack(tmp);
  try {
    const report = path.join(tmp, 'report.json');
    process.env.FAKE_ENGINE_REPORT = report;
    ({ e, L, port, states } = await makeEngine(tmp, { url: pack.url, sha256: pack.sha256 }));
    assert.equal(e.status().state, 'absent');
    let installed = 0;
    e.on('installed', () => installed++);
    await Promise.all([e.install(), e.install()]);
    assert.equal(pack.hits(), 1, 'two clicks, one download');
    assert.deepEqual(states, ['downloading', 'installing', 'starting', 'running']);
    assert.equal(installed, 1);
    assert.equal(e.installed(), true);
    assert.equal(fs.existsSync(path.join(L.root, 'engine-download', 'engine-pack-test.zip')), false, 'the 200 MB zip is deleted after unpacking');
    const r = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.equal(r.env.UCHIYOMI_ENGINE_ROOT_DIR, L.engine);
    assert.equal(r.env.UCHIYOMI_ENGINE_FLARESOLVERR_URL, 'http://127.0.0.1:9/token');
    assert.equal(r.cwd, e.runtimeDir);
    assert.ok(r.argv.includes(`-Dsuwayomi.tachidesk.config.server.port=${port}`));
    const authed = await fetch(`http://127.0.0.1:${port}/api/v1/settings/about`, { headers: { authorization: `Basic ${Buffer.from('eu:ep').toString('base64')}` } });
    assert.equal(authed.status, 200);
    assert.equal(await e.stop(), 'exited:0', 'the stdin lifeline, not a kill');
  } finally {
    await e?.stop();
    delete process.env.FAKE_ENGINE_REPORT;
    pack.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a pack that does not match its SHA-256 is refused before anything is unpacked', { skip: !POSIX }, async () => {
  // Reintroduce by skipping the digest comparison in download(): the tampered pack installs and runs.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uchi-engine-'));
  const pack = await fakePack(tmp);
  let e;
  try {
    let L, states;
    ({ e, L, states } = await makeEngine(tmp, { url: pack.url, sha256: crypto.createHash('sha256').update('something else').digest('hex') }));
    await assert.rejects(() => e.install(), /did not match its checksum/);
    assert.equal(e.status().state, 'failed');
    assert.match(e.status().error, /checksum/);
    assert.deepEqual(states, ['downloading', 'failed']);
    assert.equal(e.installed(), false);
    assert.equal(fs.existsSync(e.runtimeDir), false);
    assert.deepEqual(fs.readdirSync(path.join(L.root, 'engine-download')), [], 'no .part left behind');
  } finally {
    await e?.stop();
    pack.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('an unpublished pin fails with a sentence and touches no network', async () => {
  // Reintroduce by dropping the `!pack.url || !pack.sha256` refusal: the download is attempted.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uchi-engine-'));
  try {
    let fetched = 0;
    const { e } = await makeEngine(tmp, { url: null, sha256: null }, { fetch: () => { fetched++; throw new Error('no'); } });
    await assert.rejects(() => e.install(), /not available for this version/);
    assert.equal(fetched, 0);
    assert.equal(e.status().state, 'failed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('an engine that never answers (the ClassGraph trap) fails at the deadline and is stopped, not left running', { skip: !POSIX }, async () => {
  let e;
  // Reintroduce by dropping the stop() after the readiness deadline: the hung JVM keeps running.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uchi-engine-'));
  const pack = await fakePack(tmp);
  try {
    process.env.FAKE_ENGINE_MODE = 'hang';
    ({ e } = await makeEngine(tmp, { url: pack.url, sha256: pack.sha256 }, { readyTimeoutMs: 1500 }));
    await assert.rejects(() => e.install(), /did not start within/);
    assert.equal(e.status().state, 'failed');
    assert.equal(e.child, null, 'the hung JVM was stopped');
  } finally {
    await e?.stop();
    delete process.env.FAKE_ENGINE_MODE;
    pack.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a crash after it was running is restarted; one that dies while starting is reported, not looped', { skip: !POSIX }, async () => {
  let e, d;
  // Reintroduce by letting a child that was never ready trigger restartAfterCrash: the dying start loops.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uchi-engine-'));
  const pack = await fakePack(tmp);
  try {
    const report = path.join(tmp, 'report.json');
    process.env.FAKE_ENGINE_REPORT = report;
    process.env.FAKE_ENGINE_MODE = 'crash-once';
    let states;
    ({ e, states } = await makeEngine(tmp, { url: pack.url, sha256: pack.sha256 }));
    await e.install();
    for (let i = 0; i < 100 && !(fs.existsSync(`${report}.crashed`) && e.status().state === 'running' && states.length > 4); i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(states, ['downloading', 'installing', 'starting', 'running', 'starting', 'running']);
    await e.stop();
    process.env.FAKE_ENGINE_MODE = 'die';
    d = await makeEngine(fs.mkdtempSync(path.join(tmp, 'b-')), { url: pack.url, sha256: pack.sha256 });
    await assert.rejects(() => d.e.install(), /stopped while starting/);
    await new Promise((r) => setTimeout(r, 2500)); // longer than the first crash backoff
    assert.equal(d.e.status().state, 'failed', 'a start that dies is not retried behind the caller\'s back');
  } finally {
    await e?.stop();
    await d?.e?.stop();
    delete process.env.FAKE_ENGINE_REPORT;
    delete process.env.FAKE_ENGINE_MODE;
    pack.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
