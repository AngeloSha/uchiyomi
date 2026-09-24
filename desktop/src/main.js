// @ts-check
'use strict';
/**
 * Uchiyomi Desktop, main process.
 *
 * One instance per data directory; a window onto http://127.0.0.1:<port>/ served by the bff itself, signed in
 * without a sign-in screen (signin.js); a tray / menu-bar icon that keeps the app -- and its scheduled sweeps --
 * alive when the window closes; Quit stops everything in order.
 *
 * Modes (argv):
 *   (none)                 the app
 *   --smoke                headless: boot postgres + solver + bff, sign in the way the window does, check the
 *                          handshake's refusals, run the bff's own backup and a pg_dump, optionally install the
 *                          engine (--engine-pack-url), stop in order, write logs/smoke-result.json, exit 0/1
 *   --quit-for-update      ask the running instance to stop everything (what an installer must do first) and
 *                          wait until it has exited
 *   --data-dir=<path>      use another data root (tests; see paths.js)
 *   --library-dir=<path>   first run without the folder page (CI; an already chosen library is kept)
 *   --hidden               start in the tray without showing the window (the login item uses it)
 *   --engine-pack-url=<u> --engine-pack-sha256=<hex>
 *                          download the extension engine from here instead of the pinned release (CI serves a
 *                          locally built pack; both are required, the hash is still enforced)
 *   --no-ascii-fallback    disable the Windows non-ASCII Postgres fallback (tests: prove the bug is real)
 *   --metrics-file=<p>     write app.getAppMetrics() there every 5 s once the app is up
 */
const T0 = Date.now();
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const os = require('node:os');
const net = require('node:net');
const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, shell, session, utilityProcess, ipcMain, dialog } = require('electron');

const paths = require('./paths');
const log = require('./log');
const stateFile = require('./state');
const { Supervisor } = require('./supervisor');
const { newSecret, installSignIn, ShellSession, HEADER } = require('./signin');
const { resolvePack, PIN } = require('./engine');
const { Updates, installOnQuit } = require('./updates');
const { installBridge, freeGB, isShellPage } = require('./bridge');
const firstrun = require('./firstrun');
const { restore, inspectBackup } = require('./restore');
const { pickLang, translator, pageStrings } = require('./i18n');
const { startSolver, setUserAgent } = require('./solver');
const { installSessionEnd } = require('./sessionend');

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
const str = (v) => (typeof v === 'string' ? v : undefined);

const args = parseArgs(process.argv);
const root = paths.dataRoot(str(args['data-dir']));
const L = paths.layout(root);
fs.mkdirSync(L.logs, { recursive: true });
log.open(L.logs);

// Chromium's profile (cookies, service worker, IndexedDB) beside the rest of the data, not in roaming
// %APPDATA%. Must happen before 'ready' and before the single-instance lock, which is keyed on this path --
// so two data roots are two independent instances, which the CI checks rely on.
app.setPath('userData', L.electron);
app.setAppLogsPath(L.logs);

const MODE = args.smoke ? 'smoke' : args['quit-for-update'] ? 'quit-for-update' : 'app';
log.info(`Uchiyomi Desktop ${app.getVersion()} starting`, {
  mode: MODE, root, packaged: app.isPackaged, electron: process.versions.electron, node: process.versions.node,
  chrome: process.versions.chrome, platform: process.platform, arch: process.arch, pid: process.pid,
  execPath: process.execPath,
});

// ⚠️ Never touch the macOS Keychain while the app is unsigned: an ad-hoc signature changes with every build, so
// a Keychain item created by one version is a stranger's to the next (a blocking password prompt on every update).
// With the cookie-encryption fuse off Chromium should not need it; the mock keychain makes sure nothing else does.
if (process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain');
// Windows: the same AppUserModelID as the installer's shortcut (electron-builder's appId), or notifications
// from the tray do not show and the taskbar does not group the window with its pinned icon.
if (process.platform === 'win32') app.setAppUserModelId('com.uchiyomi.desktop');

if (MODE === 'smoke') {
  // Headless mode: no window, no GPU process to go wrong on a CI runner or under another user's logon.
  app.disableHardwareAcceleration();
}

// The solver's one User-Agent, process-wide, before ANY session exists (solver.js says why).
const persisted = stateFile.read(L.state);
if (MODE !== 'quit-for-update') {
  try {
    const ua = setUserAgent(app, str(persisted.solverUserAgent));
    log.info('user agent', ua);
  } catch (e) {
    log.error('could not set the user agent (is out/ built? npm run build)', { error: String(e) });
  }
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
    if (cmd === 'quit-for-update' || argv.includes('--quit-for-update')) void quit('quit-for-update');
    else showWindow();
  });
  app.whenReady().then(() => {
    if (MODE === 'smoke') return runSmoke();
    return runApp();
  }).catch((e) => {
    log.error('fatal during startup', { error: e });
    app.exit(1);
  });
}

/**
 * The client half of --quit-for-update: the lock is held by the running app, which receives our request as a
 * 'second-instance' event. Then wait for its main process to be gone, so a caller (an installer, or CI) can
 * replace the files the moment this returns.
 * ⚠️ The caller must wait with an ASYNC spawn: spawnSync blocks libuv, so an exited child stays an unreaped
 * zombie and kill(pid, 0) keeps saying "alive" (spike finding).
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

// ---------------------------------------------------------------- shared by the app and --smoke
/** @type {Supervisor | null} */
let sup = null;
/** @type {BrowserWindow | null} */
let win = null;
/** @type {Tray | null} */
let tray = null;
let quitting = false;
/** The ordered stop in quit() has finished (sessionend.js skips its last-resort postgres stop then). */
let stopped = false;
let lang = 'en';
let t = translator('en');
/** @type {Updates | null} */
let updates = null;
/** @type {ShellSession | null} */
let shellSession = null;
let needsHuman = '';

function enginePack() {
  const url = str(args['engine-pack-url']);
  const sha256 = str(args['engine-pack-sha256']);
  return resolvePack(PIN, url || sha256 ? { url, sha256 } : {});
}

function osUser() {
  try { return os.userInfo().username; } catch { return ''; }
}

/**
 * @param {{ libraryDir: string, secret: string }} o
 */
function makeSupervisor(o) {
  const s = stateFile.read(L.state);
  const external = str(s.flaresolverrUrl);
  return new Supervisor({
    L,
    resources: paths.resourcesDir(app),
    log,
    version: app.getVersion(),
    asciiFallback: !args['no-ascii-fallback'],
    utilityProcess,
    libraryDir: o.libraryDir,
    readLibrary: str(s.readLibrary) || null,
    secret: o.secret,
    osUser: osUser(),
    startSolver: external
      ? async () => { log.warn('solver: using the external FlareSolverr in state.json', { url: external.replace(/\/[^/]*$/, '/…') }); return { url: external, port: 0, close: async () => {} }; }
      : () => startSolver({ version: app.getVersion(), log, onNeedsHuman: (host) => onNeedsHuman(host) }),
    enginePack: enginePack(),
    // Chromium's network stack: the user's proxy settings and certificate store apply to the 200 MB download.
    engineFetch: /** @type {any} */ (require('electron').net.fetch),
  });
}

// ---------------------------------------------------------------- the library folder (first run)
/**
 * The library folder: state.json's, else --library-dir (CI), else ask with firstrun.html.
 * @returns {Promise<string>}
 */
async function libraryDir() {
  const s = stateFile.read(L.state);
  if (typeof s.libraryDir === 'string' && s.libraryDir) {
    // Asked once, kept forever. A drive that is not plugged in is NOT re-asked or re-created here: the bff's
    // verify/cleanup rely on a missing root LOOKING missing (an empty folder on C: would not).
    return s.libraryDir;
  }
  const flag = str(args['library-dir']);
  if (flag) {
    const c = firstrun.checkLibraryDir(path.resolve(flag), { dataRoot: root });
    if (!c.ok) throw new Error(`--library-dir: ${c.error}`);
    const p = firstrun.prepareLibraryDir(c.dir);
    if (!p.ok) throw new Error(`--library-dir: ${p.error}`);
    return saveLibraryDir(c.dir);
  }
  return new Promise((resolve) => {
    // Once: a second confirm (a double click, or anything that reaches the page later) must not move the library.
    firstRunDone = (dir) => { firstRunDone = () => {}; resolve(saveLibraryDir(dir)); };
    showWindow();
    void win?.loadFile(path.join(__dirname, 'firstrun.html'));
  });
}
/** @type {(dir: string) => void} */
let firstRunDone = () => {};

function saveLibraryDir(dir) {
  const s = stateFile.read(L.state);
  s.libraryDir = dir;
  stateFile.write(L.state, s);
  log.info('library folder chosen', { dir });
  return dir;
}

const firstRunApi = {
  defaults: () => {
    const dir = firstrun.defaultLibraryDir();
    const c = firstrun.checkLibraryDir(dir, { dataRoot: root });
    return { ...c, freeGB: freeGB(c.dir) };
  },
  choose: async () => {
    const r = await dialog.showOpenDialog(/** @type {any} */ (win), {
      title: t('first.title'),
      defaultPath: os.homedir(),
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const c = firstrun.checkLibraryDir(r.filePaths[0], { dataRoot: root });
    return { ...c, freeGB: freeGB(c.dir) };
  },
  confirm: (dir, anyway) => {
    const c = firstrun.checkLibraryDir(dir, { dataRoot: root });
    if (!c.ok) return { ...c, freeGB: freeGB(c.dir) };
    if (c.warning && !anyway) return { ...c, ok: false, freeGB: freeGB(c.dir) };
    const p = firstrun.prepareLibraryDir(c.dir);
    if (!p.ok) return { ok: false, dir: c.dir, error: p.error, freeGB: freeGB(c.dir) };
    void win?.loadFile(path.join(__dirname, 'loading.html'));
    firstRunDone(c.dir);
    return { ok: true, dir: c.dir };
  },
};

// ---------------------------------------------------------------- the app
async function runApp() {
  lang = pickLang(app.getLocale());
  t = translator(lang);
  const hidden = !!args.hidden || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);
  updates = new Updates({ version: app.getVersion(), packaged: app.isPackaged, log, openExternal: (u) => void shell.openExternal(u) });
  updates.on('status', () => buildTrayMenu());
  installBridge({
    ipcMain,
    win: () => win,
    // The plain origin check is enough here: a document from the UI origin can only have been loaded while our
    // own bff child held the port -- the onBeforeRequest gate below cancels every request to it otherwise -- so a
    // squatter's page never exists to ask. Reading trustedPort() here broke our OWN page during the bff's restart
    // after an engine install ("not allowed" on desktop:engine-status, run 35949994672 on win-x64 and mac-x64).
    appOrigin: () => (sup && sup.uiPort ? `http://127.0.0.1:${sup.uiPort}` : 'http://127.0.0.1:0'),
    log,
    engine: () => /** @type {any} */ (sup).engine,
    updates,
    installUpdate: () => void installUpdate(),
    revealLibrary: () => { const d = stateFile.read(L.state).libraryDir; if (d) void shell.openPath(d); },
    revealBackups: () => { fs.mkdirSync(L.backups, { recursive: true }); void shell.openPath(L.backups); },
    // From Admin -> Tasks, whose own danger dialog has already asked (and whose toast reports a refusal).
    restoreBackup: () => restoreBackupFlow({ fromWeb: true }),
    strings: () => ({ ...pageStrings(lang, 'loading.'), ...pageStrings(lang, 'first.') }),
    relaunch: () => { app.relaunch(); void quit('relaunch'); },
    openLogs: () => void shell.openPath(L.logs),
    firstRun: firstRunApi,
  });
  createTray();
  createWindow(!hidden);
  try {
    const dir = await libraryDir();
    const secret = newSecret();
    sup = makeSupervisor({ libraryDir: dir, secret });
    sup.timeline.mainStart = T0;
    sup.mark('ready');
    // The window signs in with the per-launch secret on exactly one request (contract 2) -- and only to a port
    // our own bff child has confirmed it holds, so a process squatting the port never receives the secret.
    installSignIn(session.defaultSession, () => sup?.trustedPort() || 0, secret);
    shellSession = new ShellSession(() => sup?.trustedPort() || 0, secret);
    // ⚠️ And the window loads nothing from the UI port while it is not ours (start-up, or the gap while the bff
    // restarts): the web's reconnect splash retries until it is. The session's ONE onBeforeRequest listener.
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://127.0.0.1/*', 'http://127.0.0.1:*/*'] }, (d, cb) => {
      let port = 0;
      try { port = Number(new URL(d.url).port) || 80; } catch { /* not a URL: let it fail on its own */ }
      cb({ cancel: !!sup && sup.uiPort > 0 && port === sup.uiPort && !sup.trustedPort() });
    });
    sup.on('fatal', (e) => showError(String(e?.message || e)));
    sup.on('engine-status', (s) => {
      const wc = win?.webContents;
      if (wc && !wc.isDestroyed() && wc.getURL().startsWith(`http://127.0.0.1:${sup?.uiPort}/`)) wc.send('desktop:engine-status-changed', s);
    });
    await sup.start();
    sup.mark('windowLoadApp');
    await win?.loadURL(sup.url);
    log.info('window: app loaded', { url: sup.url, timeline: sup.relTimeline(), sinceMainStart: Date.now() - T0 });
    buildTrayMenu();
    updates.start();
    if (typeof args['metrics-file'] === 'string') startMetrics(args['metrics-file']);
  } catch (e) {
    log.error('startup failed', { error: e });
    showError(String(/** @type {any} */ (e)?.message || e));
  }
}

/** @param {boolean} show */
function createWindow(show) {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    minHeight: 500,
    show: false,
    title: 'Uchiyomi',
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    icon: trayIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      additionalArguments: [`--uchiyomi-version=${app.getVersion()}`, `--uchiyomi-lang=${lang}`],
    },
  });
  win.once('ready-to-show', () => { sup?.mark('readyToShow'); if (show) win?.show(); });
  win.on('close', (e) => {
    // Closing the window keeps the app (and its scheduled sweeps) running in the tray; Quit stops it.
    if (quitting) return;
    e.preventDefault();
    win?.hide();
    trayNoticeOnce();
  });
  // Windows shutting down, restarting or signing out never reaches before-quit: the ordered stop runs from here.
  installSessionEnd(/** @type {any} */ (win), {
    log,
    quit: (reason) => quit(reason),
    stopped: () => stopped,
    stopPostgresNow: () => sup?.stopPostgresNow() ?? 'not-started',
  });
  const wc = win.webContents;
  wc.on('did-finish-load', () => log.info('window: did-finish-load', { url: wc.getURL().replace(/\?.*$/, ''), sinceMainStart: Date.now() - T0 }));
  wc.on('render-process-gone', (_e, d) => {
    log.error('window: renderer gone', d);
    // Bring the app back rather than leaving a dead window: the bff is still up.
    if (!quitting && sup?.uiPort) setTimeout(() => void win?.loadURL(sup?.url || ''), 1000);
  });
  // Links out of the app open in the user's browser; the window only ever shows our own origin.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !isOwnOrigin(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    // Our origin, or the shell's own two local pages -- never another local file.
    if (isOwnOrigin(url) || (url.startsWith('file:') && isShellPage(url))) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
  // The window asks for nothing a manga reader needs (camera, location, notifications through the web API...).
  // Fullscreen for the reader is the one permission it uses.
  wc.session.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'fullscreen' || perm === 'clipboard-sanitized-write'));
  void win.loadFile(path.join(__dirname, 'loading.html'));
}

function isOwnOrigin(url) {
  // The plain origin (see appOrigin in the bridge): during the bff's restart gap a click on our own link must not
  // open in the system browser; the request gate holds the load until the port is ours again.
  try { return sup !== null && sup.uiPort > 0 && new URL(url).origin === `http://127.0.0.1:${sup.uiPort}`; } catch { return false; }
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (needsHuman) { needsHuman = ''; buildTrayMenu(); app.dock?.setBadge(''); }
}

function showError(msg) {
  if (!win) return;
  void win.loadFile(path.join(__dirname, 'loading.html'), { query: { error: msg.slice(0, 1500) } });
  showWindow();
}

function trayNoticeOnce() {
  const s = stateFile.read(L.state);
  if (s.trayNoticeShown || process.platform === 'darwin') return; // on a Mac the dock icon says it all
  s.trayNoticeShown = true;
  stateFile.write(L.state, s);
  if (Notification.isSupported()) new Notification({ title: 'Uchiyomi', body: t('note.tray') }).show();
}

// ---------------------------------------------------------------- tray / menu bar
function trayIconPath() {
  return path.join(paths.resourcesDir(app), 'web', 'icons', 'icon-192.png');
}

function createTray() {
  let img = nativeImage.createFromPath(trayIconPath());
  if (!img.isEmpty()) img = img.resize({ width: process.platform === 'darwin' ? 18 : 16 });
  tray = new Tray(img);
  tray.setToolTip('Uchiyomi');
  tray.on('click', () => showWindow());
  buildTrayMenu();
}

function buildTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const u = updates?.status() || { available: false };
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const items = [{ label: t('tray.open'), click: () => showWindow() }];
  if (needsHuman) items.push({ label: t('tray.verify', { host: needsHuman }), click: () => showWindow() });
  items.push({ label: t('tray.check'), enabled: !!sup?.uiPort, click: () => void checkNow() });
  // The shell's own way in to "Restore a backup" (the web can call the same flow through the bridge).
  items.push({ label: `${t('restore.title')}…`, enabled: !!sup?.uiPort, click: () => { showWindow(); restoreBackupFlow().catch(() => { /* shown in a dialog */ }); } });
  if (u.available && u.version) {
    items.push({ type: 'separator' });
    if (process.platform === 'win32' && u.ready) items.push({ label: t('tray.restartUpdate', { v: u.version }), click: () => void installUpdate() });
    else items.push({ label: t('tray.downloadUpdate', { v: u.version }), click: () => updates?.openDownload() });
  }
  items.push({ type: 'separator' });
  if (process.platform === 'win32' || process.platform === 'darwin') {
    const on = app.getLoginItemSettings().openAtLogin;
    items.push({
      label: t('tray.login'),
      type: 'checkbox',
      checked: on,
      click: (mi) => {
        // Off by default (owner). The login item starts in the tray: nobody wants a window at every boot.
        app.setLoginItemSettings({ openAtLogin: mi.checked, args: ['--hidden'] });
        log.info(`login item ${mi.checked ? 'on' : 'off'}`);
      },
    });
    items.push({ type: 'separator' });
  }
  items.push({ label: t('tray.quit'), click: () => void quit('tray') });
  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.setToolTip(needsHuman ? t('tray.verify', { host: needsHuman }) : 'Uchiyomi');
}

/** The solver's hidden window needs a human and nobody was at the machine: a quiet mark, never a pop-up. */
function onNeedsHuman(host) {
  needsHuman = host;
  buildTrayMenu();
  app.dock?.setBadge('!');
}

/**
 * The Tasks panel's "Run now" on the chapter sweep, with the app's own session (the same exchange the window
 * makes, from the main process).
 * @param {ShellSession} ss
 */
async function runSweepNow(ss) {
  const r = await ss.fetch('/api/admin/tasks/update/run', { method: 'POST' });
  return { status: r.status, answer: /** @type {any} */ (await r.json().catch(() => ({}))) };
}

/** Tray: "Check for new chapters". */
async function checkNow() {
  if (!shellSession) return;
  const note = (body) => { if (Notification.isSupported()) new Notification({ title: 'Uchiyomi', body }).show(); };
  try {
    const { status, answer: j } = await runSweepNow(shellSession);
    if (j.ok) note(t('note.checking'));
    else if (j.error === 'busy') note(t('note.busy'));
    else if (j.error === 'repair_running') note(t('note.repair'));
    else note(t('note.checkFailed', { e: j.error || `HTTP ${status}` }));
    log.info('tray: check for new chapters', { status, answer: j });
  } catch (e) {
    log.warn('tray: check for new chapters failed', { error: String(e) });
    note(t('note.checkFailed', { e: String(/** @type {any} */ (e)?.message || e) }));
  }
}

// ---------------------------------------------------------------- restore
/**
 * @param {{ fromWeb?: boolean }} [o] fromWeb: Admin -> Tasks called it through the bridge. Its danger dialog
 *   has already asked, so the shell's own question is not asked a second time, and its toast shows a refusal
 *   (the tray has neither, so there the shell asks and says why itself).
 */
async function restoreBackupFlow({ fromWeb = false } = {}) {
  if (!sup) throw new Error('Uchiyomi is still starting.');
  const pick = await dialog.showOpenDialog(/** @type {any} */ (win), {
    title: t('restore.pick'),
    defaultPath: fs.existsSync(L.backups) ? L.backups : os.homedir(),
    properties: ['openFile'],
    filters: [{ name: 'db.sql.gz', extensions: ['gz'] }],
  });
  if (pick.canceled || !pick.filePaths[0]) return;
  let b;
  try {
    b = inspectBackup(pick.filePaths[0]);
  } catch (e) {
    // A server's backup is refused (restore.js inspectBackup), in the shell's language.
    const why = /** @type {any} */ (e)?.code === 'SERVER_BACKUP' ? t('restore.server') : String(/** @type {any} */ (e)?.message || e);
    if (!fromWeb) void dialog.showMessageBox(/** @type {any} */ (win), { type: 'info', title: t('restore.title'), message: why });
    throw new Error(why);
  }
  if (!fromWeb) {
    const ask = await dialog.showMessageBox(/** @type {any} */ (win), {
      type: 'warning',
      title: t('restore.title'),
      message: t('restore.ask', { date: b.date.toLocaleString(lang === 'en' ? undefined : lang) }),
      detail: t('restore.detail'),
      buttons: [t('restore.ok'), t('restore.cancel')],
      defaultId: 1,
      cancelId: 1,
    });
    if (ask.response !== 0) return;
  }
  const s = /** @type {Supervisor} */ (sup);
  log.info('restore: starting', { dump: b.dump, config: b.config });
  try {
    const r = await restore({
      dump: b.dump, config: b.config, configDir: L.config, backupsDir: L.backups, pg: s.pg,
      stopBff: () => s.stopBff(), startBff: () => s.startBff(), log,
    });
    log.info('restore: done', r);
  } catch (e) {
    log.error('restore: failed', { error: String(e) });
    void dialog.showMessageBox(/** @type {any} */ (win), { type: 'error', title: t('restore.title'), message: t('restore.failed'), detail: String(/** @type {any} */ (e)?.message || e) });
    throw e;
  }
}

// ---------------------------------------------------------------- quit + updates
app.on('window-all-closed', () => { /* stay in the tray */ });
app.on('activate', () => showWindow());
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  void quit('before-quit');
});

/** "Restart to update" (Windows, a downloaded update) or "download" (macOS). */
async function installUpdate() {
  const u = updates?.status();
  if (process.platform === 'win32' && u?.ready) return quit('update', { install: true });
  updates?.openDownload();
}

/**
 * @param {string} reason
 * @param {{ install?: boolean }} [o]
 */
async function quit(reason, o = {}) {
  if (quitting) return;
  quitting = true;
  log.info(`quit: ${reason}`);
  // app.exit() below skips Chromium's orderly shutdown, and the cookie store is written to disk lazily (about
  // every 30 s). The bff ROTATES the refresh cookie on use, so a rotation in the last seconds before Quit was
  // lost and the next launch presented the previous, already-spent token: signed out (spike CI run 3, macOS).
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
  stopped = true;
  // ⚠️ Only now, with postgres and the engine stopped, may the installer run (spike S5). A downloaded Windows
  // update is also installed on a plain Quit (the tray's Quit, or the app menu's), silently, without starting the
  // app again -- but NOT when another installer asked us to stop (--quit-for-update: build/installer.nsh), which
  // would start a second installer beside it, nor on a relaunch, nor when Windows is ending the session
  // ('session-end': an installer started then can be killed half-way). updates.js installOnQuit decides.
  const u = updates?.status();
  if (process.platform === 'win32' && u?.ready && updates && installOnQuit(reason, o)) {
    log.info(`quit: installing ${u.version}`, { relaunch: !!o.install });
    tray?.destroy();
    try {
      // quitAndInstall starts the installer and calls app.quit(); before-quit lets it through (quitting).
      if (updates.installDownloaded(!!o.install)) return;
    } catch (e) {
      log.error('quit: the update could not start', { error: String(e) });
    }
  }
  tray?.destroy();
  app.exit(0);
}

function startMetrics(file) {
  const write = () => {
    try {
      const m = app.getAppMetrics().map((p) => ({ pid: p.pid, type: p.type, name: p.name, serviceName: p.serviceName, workingSetKB: p.memory.workingSetSize, peakKB: p.memory.peakWorkingSetSize, privateKB: p.memory.privateBytes, cpu: p.cpu.percentCPUUsage }));
      fs.writeFileSync(file, JSON.stringify({ t: Date.now(), sinceMainStart: Date.now() - T0, bffPid: sup?.bff?.pid, pgPid: sup?.pg.pidFromFile(), enginePid: sup?.engine.pid, metrics: m }, null, 2));
    } catch (e) {
      log.warn('metrics: write failed', { error: String(e) });
    }
  };
  write();
  setInterval(write, 5000).unref();
}

// ---------------------------------------------------------------- --smoke
async function runSmoke() {
  const res = /** @type {any} */ ({ mode: 'smoke', version: app.getVersion(), platform: process.platform, arch: process.arch, user: osUser(), root, checks: {}, ok: false });
  const c = res.checks;
  const secret = newSecret();
  try {
    const flag = str(args['library-dir']);
    const lib = stateFile.read(L.state).libraryDir || (flag ? path.resolve(flag) : path.join(os.tmpdir(), `uchiyomi-smoke-library-${process.pid}`));
    if (!stateFile.read(L.state).libraryDir) {
      const chk = firstrun.checkLibraryDir(lib, { dataRoot: root });
      if (!chk.ok) throw new Error(`library folder: ${chk.error}`);
      const p = firstrun.prepareLibraryDir(chk.dir);
      if (!p.ok) throw new Error(`library folder: ${p.error}`);
      saveLibraryDir(chk.dir);
    }
    res.libraryDir = stateFile.read(L.state).libraryDir;
    sup = makeSupervisor({ libraryDir: res.libraryDir, secret });
    sup.timeline.mainStart = T0;
    await sup.start();
    res.fallback = sup.fallback;
    res.staleRecovery = sup.staleRecovery;
    res.pgdata = sup.pg.pgdata;
    res.pgBinDir = sup.pg.binDir;
    res.uiPort = sup.uiPort;
    const base = `http://127.0.0.1:${sup.uiPort}`;

    const hz = await fetch(`${base}/healthz`);
    c.healthz = { status: hz.status, body: await hz.text(), pass: hz.status === 200 };
    const cfg = await fetch(`${base}/auth/config`);
    const cfgBody = await cfg.json().catch(() => null);
    c.desktopMode = { status: cfg.status, desktop: cfgBody?.desktop, pass: cfg.status === 200 && cfgBody?.desktop === true };
    const web = await fetch(`${base}/`);
    const html = await web.text();
    c.webRoot = { status: web.status, bytes: html.length, pass: web.status === 200 && /<html/i.test(html) };
    c.listen = await listenScope(sup.uiPort);
    c.listen.pass = !c.listen.exposedBeyondLoopback;

    // The handshake, exactly as the window makes it (the header the session hook adds), and its refusals.
    const ex = (headers) => fetch(`${base}/auth/desktop`, { method: 'POST', headers });
    const noHeader = await ex({});
    const wrong = await ex({ [HEADER]: newSecret() });
    const foreign = await ex({ [HEADER]: secret, origin: 'http://evil.test' });
    const good = await ex({ [HEADER]: secret });
    const goodBody = /** @type {any} */ (await good.json().catch(() => ({})));
    const cookies = good.headers.getSetCookie?.() || [];
    const token = goodBody.accessToken || '';
    const me = token ? await fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${token}` } }) : null;
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'x', password: 'y' }) });
    c.signIn = {
      noHeader: noHeader.status, wrongSecret: wrong.status, foreignOrigin: foreign.status, ok: good.status,
      cookies: cookies.map((x) => x.split('=')[0]), me: me?.status, passwordLogin: login.status, user: goodBody.user?.username,
      pass: noHeader.status === 401 && wrong.status === 401 && foreign.status === 403 && good.status === 200 && !!token
        && cookies.some((x) => x.startsWith('yomi_rt=')) && cookies.some((x) => x.startsWith('yomi_img=')) && me?.status === 200 && login.status === 404,
    };

    // The tray's "Check for new chapters", through the same code path.
    const sweep = await runSweepNow(new ShellSession(() => sup?.uiPort || 0, secret)).catch((e) => ({ status: 0, answer: { error: String(e) } }));
    c.trayCheck = { ...sweep, pass: sweep.status === 200 && (sweep.answer.ok === true || sweep.answer.error === 'busy') };

    // The solver answers where the bff and the engine are told it is.
    const sp = await fetch(`${sup.solverUrl}/`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
    c.solver = { msg: sp.msg, version: sp.version, pass: /ready/i.test(String(sp.msg || '')) };

    if (token) c.bffBackup = await bffBackup(base, token);
    else c.bffBackup = { pass: false, error: 'no token' };

    // "Restore a backup", the shell's flow, on the backup the bff just wrote: safety copy -> stop the bff ->
    // psql in one transaction -> config.zip swapped in -> the bff back up -> the window's handshake still works.
    if (c.bffBackup?.pass) {
      const s = /** @type {Supervisor} */ (sup);
      const t0 = Date.now();
      try {
        const b = inspectBackup(path.join(L.backups, c.bffBackup.dir, 'db.sql.gz'));
        const r = await restore({ dump: b.dump, config: b.config, configDir: L.config, backupsDir: L.backups, pg: s.pg, stopBff: () => s.stopBff(), startBff: () => s.startBff(), log });
        const again = await ex({ [HEADER]: secret });
        const tok2 = (/** @type {any} */ (await again.json().catch(() => ({})))).accessToken;
        const me2 = tok2 ? await fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${tok2}` } }) : null;
        c.restore = { ms: Date.now() - t0, configRestored: r.configRestored, safety: path.basename(r.safety), safetyFiles: fs.readdirSync(r.safety), exchangeAfter: again.status, meAfter: me2?.status };
        c.restore.pass = r.configRestored && again.status === 200 && me2?.status === 200 && c.restore.safetyFiles.includes('db.sql.gz');
      } catch (e) {
        c.restore = { pass: false, error: String(/** @type {any} */ (e)?.message || e), ms: Date.now() - t0 };
      }
    }

    // And the shell's own dump with the same binary, straight from Postgres.
    const f = path.join(L.backups, `smoke-${Date.now()}.sql`);
    const d = await sup.pg.dump(f);
    const sql = fs.readFileSync(f, 'utf8');
    c.shellDump = { ...d, file: f, hasUsersTable: /CREATE TABLE public\.users /.test(sql), tables: (sql.match(/CREATE TABLE /g) || []).length };
    c.shellDump.pass = d.bytes > 0 && c.shellDump.hasUsersTable;
    fs.rmSync(f, { force: true });

    // The extension engine, when CI hands us a pack: download + verify + unpack + start + the bff restart.
    if (args['engine-pack-url']) c.engine = await smokeEngine(base, token);
    else c.engine = { status: sup.engine.status(), pass: sup.engine.status().state === 'absent' || sup.engine.status().state === 'starting' || sup.engine.status().state === 'running' };
  } catch (e) {
    res.error = String(/** @type {any} */ (e)?.stack || e);
  } finally {
    res.stop = sup ? await sup.stop('smoke') : { bff: 'never-started', postgres: 'never-started' };
    res.stop.pass = /^exited:0$/.test(res.stop.bff) && /^(fast|not-running)$/.test(res.stop.postgres) && !/STILL/.test(String(res.stop.postgres)) && !/^error/.test(String(res.stop.engine));
    res.timeline = sup?.relTimeline();
    res.sinceMainStart = Date.now() - T0;
  }
  res.ok = !res.error && Object.values(c).every((x) => x.pass !== false) && res.stop.pass;
  const out = typeof args.result === 'string' ? args.result : path.join(L.logs, 'smoke-result.json');
  fs.writeFileSync(out, JSON.stringify(res, null, 2));
  log.info(`SMOKE ${res.ok ? 'PASS' : 'FAIL'}`, res);
  app.exit(res.ok ? 0 : 1);
}

/** Install the engine the way the Extensions card does, then check the bff sees it. */
async function smokeEngine(base, token) {
  const s = /** @type {Supervisor} */ (sup);
  const seen = [];
  s.on('engine-status', (x) => { if (seen[seen.length - 1] !== x.state) seen.push(x.state); });
  const t0 = Date.now();
  const restarted = new Promise((r) => s.once('bff-restarted', r));
  try {
    await s.engine.install();
  } catch (e) {
    return { pass: false, error: String(e), states: seen, status: s.engine.status() };
  }
  const installMs = Date.now() - t0;
  await Promise.race([restarted, new Promise((r) => setTimeout(r, 90_000))]);
  const creds = s.secrets;
  const about = await fetch(`http://127.0.0.1:${s.state.enginePort}/api/v1/settings/about`, { headers: { authorization: `Basic ${Buffer.from(`${creds.engineUser}:${creds.enginePass}`).toString('base64')}` } }).then((r) => r.status).catch(() => 0);
  const anon = await fetch(`http://127.0.0.1:${s.state.enginePort}/api/v1/settings/about`).then((r) => r.status).catch(() => 0);
  // A fresh token: the bff restarted since the first one was issued (same JWT secret, so it may still work).
  const tok = await fetch(`${base}/auth/desktop`, { method: 'POST', headers: { [HEADER]: s.o.secret } }).then((r) => r.json()).then((j) => j.accessToken).catch(() => token);
  // What the Extensions panel asks first: is the engine configured and reachable, with the bff's credentials?
  let ext = /** @type {any} */ (null);
  for (let i = 0; i < 60 && !ext?.reachable; i++) {
    ext = await fetch(`${base}/api/admin/extensions/status`, { headers: { authorization: `Bearer ${tok}` } }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
    if (!ext?.reachable) await new Promise((r) => setTimeout(r, 2000));
  }
  return { states: seen, installMs, engineAuthed: about, engineAnonymous: anon, extensionsStatus: ext, pass: s.engine.status().state === 'running' && about === 200 && anon === 401 && ext?.reachable === true };
}

/** Is the bff reachable on a non-loopback address? It must not be (bff/src/server.ts binds 127.0.0.1 on desktop). */
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
  return { lanAddresses: reach, exposedBeyondLoopback: reach.some((x) => x.reachable) };
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
    const tk = await fetch(`${base}/api/admin/tasks`, { headers: h }).then((x) => x.json()).catch(() => null);
    const list = Array.isArray(tk) ? tk : tk?.tasks || tk?.content || [];
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
