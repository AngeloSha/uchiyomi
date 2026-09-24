// The supervisor's order of battle, with every child faked: start postgres -> solver -> engine -> bff, stop
// bff -> engine -> solver -> postgres (an installer must never find postgres.exe or java.exe running).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Supervisor } = require('../src/supervisor.js');
const { layout } = require('../src/paths.js');
const { CONTRACT } = require('../src/env.js');

const quiet = { info() {}, warn() {}, error() {} };

function fakes(order, { installed = false, silentPort = false } = {}) {
  const opts = { silentPort };
  const pg = {
    port: 0, password: '', binDir: '/pg/bin', pgdata: '/pg/data',
    prepare: async () => { order.push('pg.prepare'); return { fallback: null }; },
    recoverStale: async () => 'clean',
    initialized: () => true,
    initdb: async () => {},
    start: async (p) => { pg.port = p; order.push('pg.start'); },
    ensureDatabase: async () => { order.push('pg.db'); },
    running: () => true,
    stop: async () => { order.push('pg.stop'); return 'fast'; },
    pidFromFile: () => 0,
  };
  const engine = Object.assign(new EventEmitter(), {
    installed: () => installed,
    start: async () => { order.push('engine.start'); },
    stop: async () => { order.push('engine.stop'); return 'exited:0'; },
    status: () => ({ state: installed ? 'running' : 'absent' }),
  });
  const forks = [];
  const utilityProcess = {
    fork: (_entry, _args, o) => {
      order.push('bff.fork');
      const child = Object.assign(new EventEmitter(), { pid: 4242, stdout: null, stderr: null, env: o.env, messages: [] });
      const srv = http.createServer((req, res) => { res.writeHead(200); res.end('{"ok":true}'); });
      // Like bff-entry.cjs: our own child says which port it bound -- unless the test plays a squatted port.
      srv.once('listening', () => { if (!opts.silentPort) child.emit('message', { type: 'listening', port: srv.address().port, address: '127.0.0.1' }); });
      srv.listen(Number(o.env.PORT), '127.0.0.1');
      child.postMessage = (m) => { child.messages.push(m); order.push(`bff.message:${JSON.stringify(m)}`); srv.close(() => setImmediate(() => child.emit('exit', 0))); };
      child.kill = () => { srv.close(() => child.emit('exit', 1)); };
      setImmediate(() => child.emit('spawn'));
      forks.push(child);
      return child;
    },
  };
  const startSolver = async () => { order.push('solver.start'); return { url: 'http://127.0.0.1:1/solvertoken0123456789', port: 1, close: async () => { order.push('solver.close'); } }; };
  return { pg, engine, utilityProcess, startSolver, forks };
}

function make(tmp, f, extra = {}) {
  const L = layout(path.join(tmp, 'data'));
  return new Supervisor({
    L, resources: '/app/resources', log: quiet, version: '0.44.0', utilityProcess: f.utilityProcess,
    libraryDir: path.join(tmp, 'Uchiyomi Library'), secret: 'x'.repeat(43), osUser: 'me', startSolver: f.startSolver,
    enginePack: { version: 'v', key: 'k', url: null, sha256: null, bytes: null, file: '' },
    makePostgres: () => f.pg, makeEngine: () => f.engine, healthTimeoutMs: 10_000, ...extra,
  });
}

test('start order, the env the bff gets, and the ordered stop', async () => {
  // Reintroduce by stopping postgres before the engine (or the bff): the order below differs.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uchi-sup-'));
  const order = [];
  const f = fakes(order, { installed: true });
  const sup = make(tmp, f);
  try {
    await sup.start();
    // The engine starts after the solver (it is handed the solver's URL) and nobody waits for it.
    assert.deepEqual(order, ['pg.prepare', 'pg.start', 'pg.db', 'solver.start', 'engine.start', 'bff.fork']);
    const env = f.forks[0].env;
    for (const k of CONTRACT.filter((x) => x !== 'LIBRARY_ROOT')) assert.ok(env[k] !== undefined && env[k] !== '', `${k} missing from the bff env`);
    assert.equal(env.FLARESOLVERR_URL, 'http://127.0.0.1:1/solvertoken0123456789');
    assert.equal(env.SUWAYOMI_URL, `http://127.0.0.1:${sup.state.enginePort}`);
    // Secrets persisted 0600, ports persisted (chosen once).
    const secrets = JSON.parse(fs.readFileSync(sup.L.secrets, 'utf8'));
    assert.ok(secrets.pgPassword && secrets.engineUser && secrets.enginePass);
    if (process.platform !== 'win32') assert.equal(fs.statSync(sup.L.secrets).mode & 0o777, 0o600);
    const st = JSON.parse(fs.readFileSync(sup.L.state, 'utf8'));
    assert.ok(st.uiPort && st.pgPort && st.enginePort);
    // Another owner writes state.json meanwhile (main.js's one-time tray notice): the stop must keep it.
    // Reintroduce by writing back the copy read at start (state.write(L.state, this.state)) in stop().
    fs.writeFileSync(sup.L.state, JSON.stringify({ ...st, trayNoticeShown: true }));
    order.length = 0;
    const r = await sup.stop('test');
    assert.deepEqual(order, ['bff.message:{"type":"shutdown"}', 'engine.stop', 'solver.close', 'pg.stop']);
    assert.equal(r.bff, 'exited:0');
    const after = JSON.parse(fs.readFileSync(sup.L.state, 'utf8'));
    assert.equal(after.trayNoticeShown, true, "the stop wrote back a stale copy of state.json");
    assert.equal(after.mainPid, undefined);
    assert.equal(after.uiPort, st.uiPort);
    assert.equal(await sup.stop('again'), r, 'a second stop joins the first');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a process squatting the UI port is never trusted: no health, no secret, no window origin', async () => {
  // Another account on the same PC binds the UI port first and answers /livez like a healthy bff. Our own child
  // never gets to confirm the port (bff-entry.cjs posts it only for a port IT bound), so start-up must NOT report
  // healthy and trustedPort() must stay 0 -- the sign-in header, the window and the bridge all read trustedPort().
  // Reintroduce by dropping the trustedPort() wait in waitHealthy: "a squatted port was trusted" fails.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uchi-sup-'));
  const order = [];
  const f = fakes(order, { silentPort: true });
  const sup = make(tmp, f, { healthTimeoutMs: 2_000 });
  try {
    const err = await sup.start().then(() => null, (e) => e);
    assert.ok(err, 'a squatted port was trusted: start-up reported healthy although our child never confirmed its port');
    assert.match(String(err.message), /waiting for the server to bind its port/);
    assert.equal(sup.trustedPort(), 0, 'a squatted port was trusted');
  } finally {
    await sup.stop('test').catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('trustedPort follows our own child: set when it confirms the UI port, cleared when it exits', async () => {
  // Reintroduce by not clearing bffPort on exit: "trustedPort survived the bff's exit" fails.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uchi-sup-'));
  const order = [];
  const f = fakes(order);
  const sup = make(tmp, f);
  try {
    await sup.start();
    assert.equal(sup.trustedPort(), sup.uiPort);
    assert.ok(sup.uiPort > 0);
    const child = f.forks[0];
    // A message naming another port (or from a child that is no longer ours) never makes a port trusted.
    child.emit('message', { type: 'listening', port: sup.uiPort + 1, address: '127.0.0.1' });
    assert.equal(sup.trustedPort(), 0, 'a port our child did not bind was trusted');
    child.emit('message', { type: 'listening', port: sup.uiPort, address: '127.0.0.1' });
    assert.equal(sup.trustedPort(), sup.uiPort);
    await sup.stop('test');
    assert.equal(sup.trustedPort(), 0, "trustedPort survived the bff's exit");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a freshly installed engine restarts the bff exactly once (contract 5), without counting as a crash', async () => {
  // Reintroduce by not marking the deliberate stop (`cycling`): the restart is counted as a crash and respawned.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uchi-sup-'));
  const order = [];
  const f = fakes(order);
  const sup = make(tmp, f);
  try {
    await sup.start();
    assert.ok(!order.includes('engine.start'), 'not installed: not started');
    const restarted = new Promise((r) => sup.once('bff-restarted', r));
    f.engine.emit('installed');
    await restarted;
    assert.equal(f.forks.length, 2);
    assert.deepEqual(f.forks[0].messages, [{ type: 'shutdown' }]);
    assert.equal(sup.crashes.length, 0);
    await new Promise((r) => setTimeout(r, 1300)); // longer than the first crash backoff: no third fork
    assert.equal(f.forks.length, 2);
  } finally {
    await sup.stop('test');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a bff that dies on its own is started again (backoff), and five crashes in two minutes stop the loop', async () => {
  // Reintroduce by raising the crash limit: the fifth crash in two minutes is respawned instead of reported.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uchi-sup-'));
  const order = [];
  const f = fakes(order);
  const sup = make(tmp, f);
  let fatal = null;
  sup.on('fatal', (e) => { fatal = e; });
  try {
    await sup.start();
    f.forks[0].kill();
    for (let i = 0; i < 40 && f.forks.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(f.forks.length, 2, 'respawned after ~1 s');
    sup.crashes = [Date.now(), Date.now(), Date.now(), Date.now()]; // this kill is the fifth in two minutes
    f.forks[1].kill();
    await new Promise((r) => setTimeout(r, 200));
    assert.match(String(fatal?.message), /keeps stopping/);
  } finally {
    await sup.stop('test');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
