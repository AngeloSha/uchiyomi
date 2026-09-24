// Contract 3: the preload bridge's exact shape, and the main process refusing calls from the wrong page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const electronPath = require.resolve('electron');
const preloadPath = require.resolve('../src/preload.js');
const { installBridge, fromOrigin, fromShellPage } = require('../src/bridge.js');

/**
 * Load preload.js as if it ran in a window at `url`, against a fake electron; returns what it exposed. `mode` is
 * the window's --uchiyomi-mode (main.js createWindow); null leaves the argument out.
 */
function loadPreload(url, mode = 'standalone') {
  const exposed = {};
  const calls = [];
  const listeners = new Map();
  const ipcRenderer = {
    invoke: async (ch, ...a) => { calls.push(['invoke', ch, ...a]); return ch === 'desktop:engine-status' ? { state: 'absent' } : ch === 'desktop:update-status' ? { available: false } : 'x'; },
    send: (ch, ...a) => { calls.push(['send', ch, ...a]); },
    on: (ch, h) => { calls.push(['on', ch]); listeners.set(ch, [...(listeners.get(ch) || []), h]); },
    removeListener: (ch, h) => { listeners.set(ch, (listeners.get(ch) || []).filter((x) => x !== h)); },
  };
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } }, ipcRenderer } };
  delete require.cache[preloadPath];
  const argv = process.argv;
  globalThis.location = new URL(url);
  process.argv = [...argv, '--uchiyomi-version=0.44.0', '--uchiyomi-lang=de', ...(mode ? [`--uchiyomi-mode=${mode}`] : [])];
  try {
    require(preloadPath);
  } finally {
    process.argv = argv;
    delete globalThis.location;
    delete require.cache[electronPath];
  }
  return { exposed, calls, listeners };
}

const shape = (v) => (typeof v === 'function' ? 'fn' : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape(v[k])])) : typeof v);

test('on the app origin: window.uchiyomiDesktop, exactly contract 3 -- and nothing for the shell pages', () => {
  // Reintroduce by renaming or adding a key (say `installEngine`): the web app's feature test reads THIS shape.
  const { exposed } = loadPreload('http://127.0.0.1:41234/library/');
  assert.deepEqual(Object.keys(exposed), ['uchiyomiDesktop']);
  assert.deepEqual(shape(exposed.uchiyomiDesktop), {
    engine: { install: 'fn', onStatus: 'fn', status: 'fn' },
    platform: 'string',
    restoreBackup: 'fn',
    revealBackups: 'fn',
    revealLibrary: 'fn',
    update: { installNow: 'fn', status: 'fn' },
    version: 'string',
  });
  assert.equal(exposed.uchiyomiDesktop.version, '0.44.0');
  assert.equal(exposed.uchiyomiDesktop.platform, process.platform);
});

test('the shell pages get their own small surface, and any other origin gets nothing', () => {
  // Reintroduce by accepting `localhost` in preload.js's onApp: http://localhost:41234/ gets the bridge.
  assert.deepEqual(Object.keys(loadPreload('file:///app/resources/app.asar/src/firstrun.html').exposed), ['uchiyomiShell']);
  for (const u of ['https://example.com/', 'http://localhost:41234/', 'http://192.168.1.5:41234/']) {
    assert.deepEqual(loadPreload(u).exposed, {}, u);
  }
});

test('calls resolve as the contract says (void where it says void); onStatus hands back an unsubscribe', async () => {
  // Reintroduce by making onStatus's unsubscribe a no-op: the listener is still registered afterwards.
  const { exposed, calls, listeners } = loadPreload('http://127.0.0.1:41234/');
  const d = exposed.uchiyomiDesktop;
  assert.deepEqual(await d.engine.status(), { state: 'absent' });
  assert.equal(await d.engine.install(), undefined);
  assert.equal(await d.restoreBackup(), undefined);
  assert.deepEqual(await d.update.status(), { available: false });
  d.revealLibrary(); d.revealBackups(); d.update.installNow();
  const got = [];
  const off = d.engine.onStatus((s) => got.push(s));
  for (const h of listeners.get('desktop:engine-status-changed')) h({ sender: 'the IPC event stays here' }, { state: 'downloading', progress: 0.5 });
  off();
  assert.deepEqual(got, [{ state: 'downloading', progress: 0.5 }], 'the status only; the IPC event never reaches the page');
  assert.equal((listeners.get('desktop:engine-status-changed') || []).length, 0);
  const channels = new Set(calls.map((c) => c[1]));
  // Every channel the preload uses is one bridge.js answers.
  const registered = new Set();
  installBridge({ ipcMain: { handle: (ch) => registered.add(ch), on: (ch) => registered.add(ch) }, win: () => null, appOrigin: () => '', log: { info() {}, warn() {}, error() {} }, engine: () => null, updates: null, installUpdate() {}, revealLibrary() {}, revealBackups() {}, restoreBackup: async () => {}, strings: () => ({}), relaunch() {}, openLogs() {}, firstRun: {} });
  for (const ch of channels) if (ch !== 'desktop:engine-status-changed') assert.ok(registered.has(ch), `${ch} has no handler in bridge.js`);
});

// ---- the main-process half ------------------------------------------------------------------------------
const win = { webContents: { id: 1 }, isDestroyed: () => false };
const ev = (url, { sender = win.webContents, parent = null } = {}) => ({ sender, senderFrame: url === null ? null : { url, parent } });

test('fromOrigin: the app window, its top frame, the app origin -- nothing else', () => {
  // Reintroduce by dropping the `e.senderFrame.parent` check in fromOrigin: the iframe passes.
  const o = 'http://127.0.0.1:41234';
  assert.equal(fromOrigin(ev('http://127.0.0.1:41234/admin?tab=Extensions'), win, o), true);
  assert.equal(fromOrigin(ev('http://127.0.0.1:41235/'), win, o), false, 'another loopback port');
  assert.equal(fromOrigin(ev('http://localhost:41234/'), win, o), false);
  assert.equal(fromOrigin(ev('http://127.0.0.1:41234/', { parent: {} }), win, o), false, 'an iframe');
  assert.equal(fromOrigin(ev('http://127.0.0.1:41234/', { sender: { id: 2 } }), win, o), false, 'another webContents (a solver window)');
  assert.equal(fromOrigin(ev(null), win, o), false, 'a frame that is gone');
  assert.equal(fromOrigin(ev('file:///x/firstrun.html'), win, o), false);
  const dir = path.join(path.parse(process.cwd()).root, 'Program Files', 'Uchiyomi', 'resources', 'app.asar', 'src');
  const ours = (n) => pathToFileURL(path.join(dir, n)).href;
  assert.equal(fromShellPage(ev(ours('firstrun.html')), win, 'firstrun.html', dir), true);
  assert.equal(fromShellPage(ev(`${ours('loading.html')}?error=x`), win, undefined, dir), true);
  assert.equal(fromShellPage(ev(ours('loading.html')), win, 'firstrun.html', dir), false);
  // Reintroduce by matching the file NAME only (endsWith): a firstrun.html anywhere else on disk passes.
  assert.equal(fromShellPage(ev(pathToFileURL(path.join(path.parse(process.cwd()).root, 'tmp', 'firstrun.html')).href), win, 'firstrun.html', dir), false);
  assert.equal(fromShellPage(ev('http://127.0.0.1:41234/firstrun.html'), win, 'firstrun.html', dir), false);
});

test('a refused call never reaches the action (engine install from the wrong page)', async () => {
  // Reintroduce by dropping the `if (!app(e))` line in the install handler: install() runs for a foreign page.
  const handlers = new Map();
  let installs = 0;
  installBridge({
    ipcMain: { handle: (ch, f) => handlers.set(ch, f), on: (ch, f) => handlers.set(ch, f) },
    win: () => win, appOrigin: () => 'http://127.0.0.1:41234', log: { info() {}, warn() {}, error() {} },
    engine: () => ({ install: async () => { installs++; }, status: () => ({ state: 'absent' }) }),
    updates: { status: () => ({ available: false }) }, installUpdate() {}, revealLibrary() {}, revealBackups() {}, restoreBackup: async () => {},
    strings: () => ({}), relaunch() {}, openLogs() {}, firstRun: { defaults: () => ({}), choose: async () => null, confirm: () => ({}) },
  });
  await assert.rejects(() => handlers.get('desktop:engine-install')(ev('http://127.0.0.1:9999/')), /not allowed/);
  await assert.rejects(() => handlers.get('desktop:engine-install')(ev('http://127.0.0.1:41234/', { sender: { id: 7 } })), /not allowed/);
  await assert.rejects(() => handlers.get('firstrun:confirm')(ev('http://127.0.0.1:41234/'), '/x', true), /not allowed/);
  assert.equal(installs, 0);
  await handlers.get('desktop:engine-install')(ev('http://127.0.0.1:41234/admin'));
  assert.equal(installs, 1);
});
