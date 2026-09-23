// @ts-check
'use strict';
/**
 * Uchiyomi Desktop, main process.
 *
 * One instance per data directory; a window onto http://127.0.0.1:<port>/ served by the bff itself; a tray
 * icon that keeps the app (and its scheduled sweeps) alive when the window closes; Quit stops everything in
 * order.
 *
 * Modes (argv):
 *   (none)               the app
 *   --smoke              boot postgres + bff headless, check /healthz, sign up, run the bff's own backup and a
 *                        pg_dump, stop in order, write logs/smoke-result.json, exit 0/1
 *   --bench              run the sharp page-hash benchmark inside a utilityProcess, exit
 *   --quit-for-update    ask the running instance to stop everything (what the updater does before an
 *                        install) and wait until it has exited
 *   --data-dir=<path>    use another data root (tests; see paths.js)
 *   --no-ascii-fallback  disable the Windows non-ASCII Postgres fallback (tests: prove the bug is real)
 *   --metrics-file=<p>   write app.getAppMetrics() there every 5 s once the app is up
 */
const T0 = Date.now();
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const os = require('node:os');
const net = require('node:net');
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, session, utilityProcess } = require('electron');

const paths = require('./paths');
const log = require('./log');
const stateFile = require('./state');
const { Supervisor } = require('./supervisor');

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const a = {};
  for (const x of argv.slice(1)) {
    const m = /^--([a-z0-9-]+)(?:=(.*))?$/i.exec(x);
    if (m) a[m[1]] = m[2] === undefined ? true : m[2];
  }
  return a;
}

const args = parseArgs(process.argv);
const root = paths.dataRoot(typeof args['data-dir'] === 'string' ? args['data-dir'] : undefined);
const L = paths.layout(root);
fs.mkdirSync(L.logs, { recursive: true });
log.open(L.logs);

// Chromium's profile (cookies, service worker, IndexedDB) beside the rest of the data, not in roaming
// %APPDATA%. Must happen before 'ready' and before the single-instance lock, which is keyed on this path --
// so two data roots are two independent instances, which the CI checks rely on.
app.setPath('userData', L.electron);
app.setAppLogsPath(L.logs);

const MODE = args.smoke ? 'smoke' : args.bench ? 'bench' : args['quit-for-update'] ? 'quit-for-update' : 'app';
log.info(`Uchiyomi Desktop ${app.getVersion()} starting`, {
  mode: MODE, root, packaged: app.isPackaged, electron: process.versions.electron, node: process.versions.node,
  chrome: process.versions.chrome, platform: process.platform, arch: process.arch, pid: process.pid,
  execPath: process.execPath,
});

// ⚠️ Never touch the macOS Keychain while the app is unsigned: an ad-hoc signature changes with every build, so
// a Keychain item created by one version is a stranger's to the next (a blocking password prompt on every update).
// With the cookie-encryption fuse off Chromium should not need it; the mock keychain makes sure nothing else does.
if (process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain');

if (MODE === 'smoke' || MODE === 'bench') {
  // Headless modes: no window, no GPU process to go wrong on a CI runner or under another user's logon.
  app.disableHardwareAcceleration();
}

// ---------------------------------------------------------------- single instance
const gotLock = app.requestSingleInstanceLock({ cmd: MODE });
if (MODE === 'quit-for-update') {
  quitForUpdateClient(gotLock);
} else if (!gotLock) {
  log.info('another instance owns this data directory; handing over and exiting');
  app.exit(0);
} else {
  app.on('second-instance', (_e, argv, _cwd, data) => {
    const cmd = /** @type {any} */ (data)?.cmd;
    log.info('second instance', { cmd, argv });
    if (cmd === 'quit-for-update' || argv.includes('--quit-for-update')) void quit('update');
    else showWindow();
  });
  app.whenReady().then(() => {
    if (MODE === 'smoke') return runSmoke();
    if (MODE === 'bench') return runBench();
    return runApp();
  }).catch((e) => {
    log.error('fatal during startup', { error: e });
    app.exit(1);
  });
}

/**
 * The client half of --quit-for-update: the lock is held by the running app, which receives our request as a
 * 'second-instance' event. Then wait for its main process to be gone, so a caller (the updater, or CI) can run
 * the installer the moment this returns.
 * @param {boolean} gotLockHere
 */
function quitForUpdateClient(gotLockHere) {
  if (gotLockHere) {
    log.info('quit-for-update: nothing is running');
    app.releaseSingleInstanceLock();
    app.exit(0);
    return;
  }
  const s = stateFile.read(L.state);
  const pid = Number(s.mainPid) || 0;
  log.info('quit-for-update: asked the running instance to stop', { pid });
  const t0 = Date.now();
  const tick = setInterval(() => {
    let alive = false;
    if (pid) { try { process.kill(pid, 0); alive = true; } catch { alive = false; } }
    if (!alive || Date.now() - t0 > 90_000) {
      clearInterval(tick);
      log.info(`quit-for-update: running instance ${alive ? 'STILL ALIVE after 90 s' : 'has exited'} (${Date.now() - t0} ms)`);
      app.exit(alive ? 1 : 0);
    }
  }, 250);
}

// ---------------------------------------------------------------- the app
/** @type {Supervisor | null} */
let sup = null;
/** @type {BrowserWindow | null} */
let win = null;
/** @type {Tray | null} */
let tray = null;
let quitting = false;

function makeSupervisor() {
  return new Supervisor({
    L,
    resources: paths.resourcesDir(app),
    log,
    version: app.getVersion(),
    asciiFallback: !args['no-ascii-fallback'],
    utilityProcess,
  });
}

async function runApp() {
  sup = makeSupervisor();
  sup.timeline.mainStart = T0;
  sup.mark('ready');
  sup.on('fatal', (e) => showError(String(e?.message || e)));
  createTray();
  createWindow();
  try {
    await sup.start();
    sup.mark('windowLoadApp');
    await win?.loadURL(sup.url);
    log.info('window: app loaded', { url: sup.url, timeline: sup.relTimeline(), sinceMainStart: Date.now() - T0 });
    if (typeof args['metrics-file'] === 'string') startMetrics(args['metrics-file']);
  } catch (e) {
    log.error('startup failed', { error: e });
    showError(String(/** @type {any} */ (e)?.message || e));
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    minHeight: 500,
    show: false,
    title: 'Uchiyomi',
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => { sup?.mark('readyToShow'); win?.show(); });
  win.on('close', (e) => {
    // Closing the window keeps the app (and its scheduled sweeps) running in the tray; Quit stops it.
    if (!quitting) { e.preventDefault(); win?.hide(); }
  });
  const wc = win.webContents;
  wc.on('did-finish-load', () => log.info('window: did-finish-load', { url: wc.getURL(), sinceMainStart: Date.now() - T0 }));
  wc.on('render-process-gone', (_e, d) => log.error('window: renderer gone', d));
  // Links out of the app open in the user's browser; the window only ever shows our own origin.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !isOwnOrigin(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (isOwnOrigin(url) || url.startsWith('file:')) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
  void win.loadFile(path.join(__dirname, 'loading.html'));
}

function isOwnOrigin(url) {
  try { return sup !== null && new URL(url).origin === new URL(sup.url).origin; } catch { return false; }
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function showError(msg) {
  if (!win) return;
  void win.loadFile(path.join(__dirname, 'loading.html'), { query: { error: msg.slice(0, 1500) } });
  showWindow();
}

function createTray() {
  const icon = path.join(paths.resourcesDir(app), 'web', 'icons', 'icon-192.png');
  let img = nativeImage.createFromPath(icon);
  if (!img.isEmpty()) img = img.resize({ width: process.platform === 'darwin' ? 18 : 16 });
  tray = new Tray(img);
  tray.setToolTip('Uchiyomi');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Uchiyomi', click: () => showWindow() },
    { type: 'separator' },
    { label: 'Quit Uchiyomi', click: () => void quit('tray') },
  ]));
  tray.on('click', () => showWindow());
}

app.on('window-all-closed', () => { /* stay in the tray */ });
app.on('activate', () => showWindow());
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  void quit('before-quit');
});

/** @param {string} reason */
async function quit(reason) {
  if (quitting) return;
  quitting = true;
  log.info(`quit: ${reason}`);
  // app.exit() below skips Chromium's orderly shutdown, and the cookie store is written to disk lazily (about
  // every 30 s). The bff ROTATES the refresh cookie on use, so a rotation in the last seconds before Quit was
  // lost and the next launch presented the previous, already-spent token: signed out (CI run 3, macOS x64).
  try {
    await session.defaultSession.cookies.flushStore();
    session.defaultSession.flushStorageData();
  } catch (e) {
    log.warn('quit: could not flush the browser profile', { error: String(e) });
  }
  try {
    const r = await sup?.stop(reason);
    log.info('quit: children stopped', r);
  } catch (e) {
    log.error('quit: stop failed', { error: e });
  }
  tray?.destroy();
  app.exit(0);
}

function startMetrics(file) {
  const write = () => {
    try {
      const m = app.getAppMetrics().map((p) => ({ pid: p.pid, type: p.type, name: p.name, serviceName: p.serviceName, workingSetKB: p.memory.workingSetSize, peakKB: p.memory.peakWorkingSetSize, privateKB: p.memory.privateBytes, cpu: p.cpu.percentCPUUsage }));
      fs.writeFileSync(file, JSON.stringify({ t: Date.now(), sinceMainStart: Date.now() - T0, bffPid: sup?.bff?.pid, pgPid: sup?.pg.pidFromFile(), metrics: m }, null, 2));
    } catch (e) {
      log.warn('metrics: write failed', { error: String(e) });
    }
  };
  write();
  setInterval(write, 5000).unref();
}

// ---------------------------------------------------------------- --smoke
async function runSmoke() {
  const res = /** @type {any} */ ({ mode: 'smoke', version: app.getVersion(), platform: process.platform, arch: process.arch, user: safeUser(), root, checks: {}, ok: false });
  const user = typeof args['smoke-user'] === 'string' ? args['smoke-user'] : 'smoke';
  const pass = typeof args['smoke-pass'] === 'string' ? args['smoke-pass'] : 'smoke-passw0rd-123';
  sup = makeSupervisor();
  sup.timeline.mainStart = T0;
  const c = res.checks;
  try {
    await sup.start();
    res.fallback = sup.fallback;
    res.staleRecovery = sup.staleRecovery;
    res.pgdata = sup.pg.pgdata;
    res.pgBinDir = sup.pg.binDir;
    res.uiPort = sup.uiPort;
    const base = `http://127.0.0.1:${sup.uiPort}`;

    const hz = await fetch(`${base}/healthz`);
    c.healthz = { status: hz.status, body: await hz.text(), pass: hz.status === 200 };
    const st = await fetch(`${base}/api/setup/status`);
    const stBody = await st.json().catch(() => null);
    c.setupStatus = { status: st.status, body: stBody, pass: st.status === 200 && typeof stBody?.needsSetup === 'boolean' };
    const web = await fetch(`${base}/`);
    const html = await web.text();
    c.webRoot = { status: web.status, bytes: html.length, pass: web.status === 200 && /<html/i.test(html) };
    c.listen = await listenScope(sup.uiPort);

    // An account, then the bff's OWN backup task: pg_dump found on PATH (the bundled one), tar for config.
    let token = '';
    if (stBody?.needsSetup) {
      const r = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: user, password: pass }) });
      const j = await r.json().catch(() => ({}));
      token = j.accessToken || '';
      c.account = { how: 'setup', status: r.status, pass: r.status === 200 && !!token };
    } else {
      const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: user, password: pass }) });
      const j = await r.json().catch(() => ({}));
      token = j.accessToken || '';
      c.account = { how: 'login', status: r.status, pass: r.status === 200 && !!token };
    }
    if (token) c.bffBackup = await bffBackup(base, token);
    else c.bffBackup = { pass: false, error: 'no token' };

    // And the shell's own dump with the same binary, straight from Postgres.
    const f = path.join(L.backups, `smoke-${Date.now()}.sql`);
    const d = await sup.pg.dump(f);
    const sql = fs.readFileSync(f, 'utf8');
    c.shellDump = { ...d, file: f, hasUsersTable: /CREATE TABLE public\.users /.test(sql), tables: (sql.match(/CREATE TABLE /g) || []).length };
    c.shellDump.pass = d.bytes > 0 && c.shellDump.hasUsersTable;
  } catch (e) {
    res.error = String(/** @type {any} */ (e)?.stack || e);
  } finally {
    res.stop = await sup.stop('smoke');
    res.stop.pass = /^exited:0$/.test(res.stop.bff) && /^(fast|not-running)$/.test(res.stop.postgres);
    res.timeline = sup.relTimeline();
    res.sinceMainStart = Date.now() - T0;
  }
  res.ok = !res.error && Object.values(c).every((x) => x.pass !== false) && res.stop.pass;
  const out = typeof args.result === 'string' ? args.result : path.join(L.logs, 'smoke-result.json');
  fs.writeFileSync(out, JSON.stringify(res, null, 2));
  log.info(`SMOKE ${res.ok ? 'PASS' : 'FAIL'}`, res);
  app.exit(res.ok ? 0 : 1);
}

function safeUser() {
  try { return os.userInfo().username; } catch { return null; }
}

/** Is the bff reachable on a non-loopback address? (It should not be; see env.js HOST.) */
async function listenScope(port) {
  const addrs = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => /** @type {any} */ (a).address);
  const reach = [];
  for (const a of addrs) {
    const okc = await new Promise((r) => {
      const s = net.connect({ host: a, port, timeout: 2000 }, () => { s.destroy(); r(true); });
      s.on('error', () => r(false));
      s.on('timeout', () => { s.destroy(); r(false); });
    });
    reach.push({ address: a, reachable: okc });
  }
  const exposed = reach.some((x) => x.reachable);
  // Not a pass/fail of this spike: v0.43.0's bff hard-codes 0.0.0.0, and that is a finding for Phase 1.
  return { lanAddresses: reach, exposedBeyondLoopback: exposed, note: exposed ? 'bff binds 0.0.0.0 (server.ts:552); Phase 1 must honour HOST' : 'loopback only' };
}

/** Run the bff's backup task over its admin API and read what it wrote. */
async function bffBackup(base, token) {
  const h = { authorization: `Bearer ${token}` };
  const before = new Set(fs.existsSync(L.backups) ? fs.readdirSync(L.backups) : []);
  const t0 = Date.now();
  const r = await fetch(`${base}/api/admin/tasks/backup/run`, { method: 'POST', headers: h });
  const started = await r.json().catch(() => ({}));
  let task = null;
  while (Date.now() - t0 < 120_000) {
    await new Promise((x) => setTimeout(x, 500));
    const t = await fetch(`${base}/api/admin/tasks`, { headers: h }).then((x) => x.json()).catch(() => null);
    const list = Array.isArray(t) ? t : t?.tasks || t?.content || [];
    task = list.find((x) => x.id === 'backup') || null;
    if (task && !task.running && task.lastRun && task.lastRun >= t0 - 1000) break;
  }
  const dirs = (fs.existsSync(L.backups) ? fs.readdirSync(L.backups) : []).filter((d) => !before.has(d) && fs.statSync(path.join(L.backups, d)).isDirectory());
  const dir = dirs.sort().pop();
  const out = /** @type {any} */ ({ started, task, dir, ms: Date.now() - t0 });
  if (!dir) { out.pass = false; out.error = 'no new backup directory'; return out; }
  const files = fs.readdirSync(path.join(L.backups, dir));
  out.files = Object.fromEntries(files.map((f) => [f, fs.statSync(path.join(L.backups, dir, f)).size]));
  const gz = path.join(L.backups, dir, 'db.sql.gz');
  if (fs.existsSync(gz)) {
    const sql = zlib.gunzipSync(fs.readFileSync(gz)).toString('utf8');
    out.sqlBytes = sql.length;
    out.hasUsersTable = /CREATE TABLE public\.users /.test(sql);
    out.tables = (sql.match(/CREATE TABLE /g) || []).length;
  }
  out.pass = !!out.hasUsersTable && (out.files['db.sql.gz'] || 0) > 20;
  return out;
}

// ---------------------------------------------------------------- --bench
function runBench() {
  const bffDir = path.join(paths.resourcesDir(app), 'bff');
  const out = typeof args.result === 'string' ? args.result : path.join(L.logs, 'bench-utility.json');
  const child = utilityProcess.fork(path.join(__dirname, 'bench', 'sharp-bench.cjs'), ['--bff', bffDir, '--out', out, '--label', 'electron-utilityProcess', ...(typeof args.images === 'string' ? ['--images', args.images] : [])], { stdio: 'pipe', serviceName: 'sharp bench' });
  child.stdout?.on('data', (b) => { try { process.stdout.write(b); } catch { /* no console */ } fs.appendFileSync(path.join(L.logs, 'bench.log'), b); });
  child.stderr?.on('data', (b) => { try { process.stderr.write(b); } catch { /* no console */ } fs.appendFileSync(path.join(L.logs, 'bench.log'), b); });
  child.once('exit', (code) => { log.info(`bench: exited ${code}`, { out }); app.exit(code || 0); });
}
