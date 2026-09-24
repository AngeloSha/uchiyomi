// @ts-check
'use strict';
/**
 * Uchiyomi Desktop, main process.
 *
 * One instance per data directory, in one of two modes the first launch asks for (welcome.html):
 *   standalone  "On this computer": a window onto http://127.0.0.1:<port>/ served by the bff itself, signed in
 *               without a sign-in screen (signin.js); a tray / menu-bar icon that keeps the app -- and its
 *               scheduled sweeps -- alive when the window closes; Quit stops everything in order.
 *   server      "Connect to my server": a plain window onto the person's own Uchiyomi server (servermode.js).
 *               Nothing runs here -- no supervisor, no secret, no bridge -- so closing the window quits.
 * A v0.44.0 profile (a library folder, no mode) is standalone without being asked.
 *
 * Process modes (argv):
 *   (none)                 the app
 *   --smoke                headless: boot postgres + solver + bff, sign in the way the window does, check the
 *                          handshake's refusals, run the bff's own backup and a pg_dump, optionally install the
 *                          engine (--engine-pack-url), stop in order, write logs/smoke-result.json, exit 0/1
 *   --quit-for-update      ask the running instance to stop everything (what an installer must do first) and
 *                          wait until it has exited
 *   --data-dir=<path>      use another data root (tests; see paths.js)
 *   --library-dir=<path>   first run without the folder page (CI; an already chosen library is kept)
 *   --server-url=<url>     first run straight into server mode after checking the address (CI; a mode chosen
 *                          before is kept)
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
const {
  probeServer, hopFetch, certSummary, certDecision, pinsOf, pinUpdate, pickStartup, appOriginFor, navDecision,
  forgetServerState, relaunchArgs, pinHost, originHost, serverPins, loadFailedStep, afterServerCheck,
  localStart, loadWasReplaced, promptableCert,
} = require('./servermode');

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
/**
 * Where the folder page's Back goes when a choice opened it: the first-launch question, or server mode's
 * "Use on this computer instead" (back to the server). null: no Back (the page is not offered one).
 * @type {(() => void) | null}
 */
let folderBack = null;

/**
 * The library-folder page as the next step of a choice, with a way back. Nothing is saved until "Use this
 * folder" (then `done`); Back runs `back`; quitting here leaves the saved state exactly as it was.
 * @param {(dir: string) => void} done @param {() => void} back
 */
function showFolderStep(done, back) {
  firstRunDone = (dir) => { firstRunDone = () => {}; folderBack = null; done(dir); };
  folderBack = back;
  showWindow();
  void win?.loadFile(path.join(__dirname, 'firstrun.html'), { query: { back: '1' } });
}

function saveLibraryDir(dir) {
  // Choosing the folder is choosing to run on this computer.
  stateFile.update(L.state, (s) => { s.libraryDir = dir; s.mode = 'standalone'; });
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
  // "Back" (only offered when a choice opened the folder page, showFolderStep): where that choice was made.
  back: () => {
    const b = folderBack;
    if (!b) return { ok: false };
    folderBack = null;
    firstRunDone = () => {};
    b();
    return { ok: true };
  },
};

// ---------------------------------------------------------------- the app
/**
 * 'standalone' | 'server' | 'choose' (the first launch, before a choice). The window is started in it and keeps
 * it -- the preload decides from it whether a page gets the desktop bridge -- so a choice made in the 'choose'
 * window continues in a NEW window (replaceWindow), and a later switch relaunches.
 */
let appMode = 'standalone';
/** Server mode: the person's own server (state.json serverOrigin / serverName). @type {{ origin: string, name: string } | null} */
let server = null;
/** Standalone has finished starting (the tray may then take the window to the server address page and back). */
let standaloneUp = false;

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
    // ⚠️ Standalone only, never the person's server (servermode.js appOriginFor): that page must not reach
    // restore, the engine or the update install.
    appOrigin: () => appOriginFor({ mode: appMode, uiPort: sup?.uiPort || 0 }),
    log,
    engine: () => /** @type {any} */ (sup).engine,
    updates,
    installUpdate: () => void installUpdate(),
    revealLibrary: () => { const d = stateFile.read(L.state).libraryDir; if (d) void shell.openPath(d); },
    revealBackups: () => { fs.mkdirSync(L.backups, { recursive: true }); void shell.openPath(L.backups); },
    // From Admin -> Tasks, whose own danger dialog has already asked (and whose toast reports a refusal).
    restoreBackup: () => restoreBackupFlow({ fromWeb: true }),
    strings: () => ({ ...pageStrings(lang, 'loading.'), ...pageStrings(lang, 'first.'), ...pageStrings(lang, 'welcome.'), ...pageStrings(lang, 'cert.'), ...pageStrings(lang, 'server.') }),
    relaunch: () => { app.relaunch(); void quit('relaunch'); },
    openLogs: () => void shell.openPath(L.logs),
    firstRun: firstRunApi,
    welcome: welcomeApi,
  });
  // ⚠️ The running app's pid from its first moment, in every mode: --quit-for-update waits for exactly this pid
  // (quitForUpdateClient). The supervisor was its only writer, so in server mode -- no supervisor -- the client
  // read nothing, returned at once, and an installer would have replaced files under the running app.
  stateFile.update(L.state, (s) => { s.mainPid = process.pid; });
  const start = pickStartup({ state: stateFile.read(L.state), serverUrl: str(args['server-url']), libraryDir: str(args['library-dir']) });
  appMode = start.mode;
  log.info(`mode: ${start.mode}${'probe' in start ? ' (--server-url)' : ''}`);
  createTray();
  createWindow(!hidden);
  try {
    if (start.mode === 'standalone') return await runStandalone();
    installCertCheck(session.defaultSession);
    /** @type {{ origin: string, name: string } | null} */
    let sv = 'origin' in start ? { origin: start.origin, name: start.name } : null;
    /** @type {Record<string, any>} */
    let pre = {};
    if ('probe' in start) {
      const r = /** @type {any} */ (await probe(start.probe));
      // Sent on to another HOST: the page shows where and waits for Continue, as it does for a typed address.
      if (r.ok && !r.newHost) sv = saveServer({ origin: r.origin, name: r.name });
      else pre = { step: 'address', address: start.probe, result: r };
    }
    if (!sv) {
      const choice = await firstLaunch(pre);
      appMode = choice.mode;
      replaceWindow();
      if (choice.mode === 'standalone') return await runStandalone();
      sv = choice.server;
    }
    return await runServer(sv);
  } catch (e) {
    log.error('startup failed', { error: e });
    showError(String(/** @type {any} */ (e)?.message || e));
  }
}

/** Standalone: postgres, the solver, the bff (and the engine once installed) on this computer. */
async function runStandalone() {
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
  standaloneUp = true;
  sup.mark('windowLoadApp');
  await win?.loadURL(sup.url);
  log.info('window: app loaded', { url: sup.url, timeline: sup.relTimeline(), sinceMainStart: Date.now() - T0 });
  buildTrayMenu();
  updates?.start();
  if (typeof args['metrics-file'] === 'string') startMetrics(args['metrics-file']);
}

// ---------------------------------------------------------------- server mode
/**
 * Server mode: the window shows the person's own server, and NOTHING else starts -- no supervisor (postgres,
 * bff, solver, engine), no sign-in secret, no header hook, no port gate: each of those exists only for the
 * local bff, and the server has its own sign-in page. (shell.servermode.test.mjs pins that this function
 * reaches none of them.)
 * @param {{ origin: string, name: string }} sv
 */
async function runServer(sv) {
  server = sv;
  log.info('server mode', { origin: sv.origin, name: sv.name, sinceMainStart: Date.now() - T0 });
  win?.setTitle(sv.name);
  buildTrayMenu();
  updates?.start();
  if (typeof args['metrics-file'] === 'string') startMetrics(args['metrics-file']);
  await loadServer();
}

function loadServer() {
  const w = win;
  if (!w || w.isDestroyed() || !server) return Promise.resolve();
  const origin = server.origin;
  return w.loadURL(origin).then(
    () => log.info('window: server loaded', { origin, sinceMainStart: Date.now() - T0 }),
    // did-fail-load has put the shell's page up (error or certificate) by now.
    (e) => log.warn('window: the server did not load', { origin, error: String(e?.message || e) }),
  );
}

/**
 * A page the server-mode window was loading failed: the shell's own page says why, never a blank window.
 * servermode.js loadFailedStep: a certificate error on the SERVER's name asks the server itself which
 * certificate it presents (the prompt, or the loud changed-certificate warning, shows only that one); anything
 * else -- another host included -- is the error page naming the host that failed, never a prompt to pin it.
 * @param {number} code @param {string} desc @param {string} url
 */
function onServerLoadFailed(code, desc, url) {
  const host = originHost(url);
  // ERR_ABORTED: a newer navigation (the address page the person just asked for) replaced this one -- not a
  // failure of the server (servermode.js loadWasReplaced).
  if (loadWasReplaced(code)) { log.info('window: a load was replaced by a newer one', { host }); return; }
  const error = { code: desc || String(code), host };
  const step = loadFailedStep({ code, host, serverHost: serverHostname() });
  log.warn('window: a page did not load', { code, desc, host, next: step });
  if (step === 'check') void checkServerCert(error);
  else showWelcome({ from: 'server', step: 'error', error });
}

/**
 * The untrusted certificates a PROBE was presented (Connect, or checkServerCert asking the server's own origin),
 * per host -- what the prompt shows, and the only fingerprints "Trust" can pin (servermode.js pinUpdate).
 * ⚠️ Never what the WINDOW's session refused: the verify proc sees no port and no requester, so that is whatever
 * the page asked that name for -- another service's certificate, pinnable in two clicks (V1 review S5).
 * @typedef {{ host: string, fingerprint: string, subject: string, issuer: string, validTo: string, changed: boolean, pinned: string, error: string, at: number }} Presented
 * @type {Map<string, Presented>}
 */
const presented = new Map();
/** Each probe session's own sightings, per host: a probe reads ITS refusal, never another session's. @type {WeakMap<Electron.Session, Map<string, Presented>>} */
const sightings = new WeakMap();
/** Hosts the window's session refused this run: Chromium keeps that refusal, so "Try again" relaunches. @type {Set<string>} */
const windowRefused = new Set();

/**
 * Self-signed certificates (owner: ask once, pin, warn loudly if it changes). Chromium decides as always, except
 * that a certificate EQUAL to the one pinned for that host is accepted (servermode.js certDecision); anything
 * else keeps Chromium's own refusal (-3) -- remembered for the prompt when a probe session saw it, and a reason
 * to ask the server when the window's did. There is no 'certificate-error' handler on purpose: Electron's
 * default, refuse, stays the answer to everything this proc refuses.
 * ⚠️ Chromium caches a refusal per session, and setting the proc again does NOT clear that cache (Electron 44: a
 * certificate the person had just trusted kept failing, with the proc never asked again). Hence probeSes() and
 * the relaunch in welcome:retry.
 * @param {Electron.Session} ses
 */
function installCertCheck(ses) {
  const isWindow = ses === session.defaultSession;
  ses.setCertificateVerifyProc((req, cb) => {
    if (req.errorCode === 0) { cb(-3); return; }
    const host = pinHost(req.hostname);
    const info = certSummary(host, req.certificate);
    const pins = pinsOf(stateFile.read(L.state));
    const d = certDecision({ host, fingerprint: info.fingerprint, chromiumOk: false, pins });
    if (d === 'accept') { cb(0); return; }
    log.warn('certificate: not trusted', { host, decision: d, error: req.verificationResult, fingerprint: info.fingerprint, window: isWindow });
    cb(-3);
    if (!isWindow) {
      let seen = sightings.get(ses);
      if (!seen) sightings.set(ses, (seen = new Map()));
      seen.set(host, { ...info, changed: d === 'changed', pinned: d === 'changed' ? pins[host] : '', error: req.verificationResult, at: Date.now() });
      return;
    }
    windowRefused.add(host);
    // ⚠️ The window's session refused a certificate for the server's name: find out NOW whether it is the
    // server's. Waiting for the page load to fail is not enough -- the server's service worker answers the
    // navigation from its cache, the load "succeeds", and only the page's requests fail: the changed-certificate
    // warning never showed (found under Xvfb with a re-keyed front).
    setImmediate(() => onServerCertRefused(host));
  });
}

/** @param {string} host */
function onServerCertRefused(host) {
  if (appMode !== 'server' || !server || quitting || host !== serverHostname()) return;
  // Not the prompt yet: which request it was is unknown (the page's <img> from another port counts), so the
  // server's own origin is asked first (checkServerCert).
  void checkServerCert();
}

/** @type {Promise<void> | null} */
let certCheck = null;
let certAgain = false;
/** @type {{ code: string, host: string } | null} */
let certFailed = null;

/**
 * Ask the server's OWN origin which certificate it presents (a probe in a session of its own, fresh
 * connections), and show the prompt only when THAT one is not trusted -- with that certificate; a failed page
 * load (`failed`) gets the error page otherwise; a refusal that was not the server's shows nothing
 * (servermode.js afterServerCheck). One check at a time: refusals arriving meanwhile run it once more after.
 * @param {{ code: string, host: string } | null} [failed]
 */
function checkServerCert(failed = null) {
  if (failed) certFailed = failed;
  if (certCheck) { certAgain = true; return certCheck; }
  certCheck = (async () => {
    do {
      certAgain = false;
      await checkServerCertOnce();
    } while (certAgain && !quitting);
  })().catch((e) => log.warn('certificate: could not ask the server', { error: String(e) })).finally(() => { certCheck = null; });
  return certCheck;
}

async function checkServerCertOnce() {
  const sv = server;
  if (!sv) return;
  const ses = checkSes();
  // A pooled connection from an earlier check would skip the handshake -- and with it the certificate now presented.
  await ses.closeAllConnections().catch(() => {});
  const r = /** @type {any} */ (await probe(sv.origin, ses));
  const failed = certFailed;
  certFailed = null;
  if (quitting || server !== sv || !win || win.isDestroyed()) return;
  const next = afterServerCheck({ probe: r, failed });
  if (!next) {
    log.info('certificate: refused for the server\'s name, but the server itself answers: a request of the page, nothing shown', { origin: sv.origin, probe: r.ok ? 'ok' : r.error });
    return;
  }
  if (isShellPage(win.webContents.getURL(), 'welcome.html')) return; // already saying something (this, or an error the person is reading)
  showWelcome({ from: 'server', ...next });
}

function serverHostname() {
  return server ? originHost(server.origin) : '';
}

/** @type {Electron.Session | null} */
let probeSession = null;
/** checkServerCert's own session (never shared with Connect: its connections are closed before each check). @type {Electron.Session | null} */
let checkSession = null;
let probeSessions = 0;
/** A pin changed since this process's window session verified anything: only a relaunch forgets its cache. */
let pinChanged = false;

/**
 * The session Connect probes with: Chromium's network stack (the OS certificate store and proxy settings, so the
 * certificate decision is the one the window will make) with the same verify proc -- but an in-memory session of
 * its own, and a NEW one after every pin change, so a refusal it cached is never reused for a certificate the
 * person has since trusted, and the window's session meets a certificate only after the person decided on it.
 */
function probeSes() {
  if (!probeSession) {
    probeSession = session.fromPartition(`uchiyomi-probe-${++probeSessions}`);
    installCertCheck(probeSession);
  }
  return probeSession;
}

/** The same, for checkServerCert. */
function checkSes() {
  if (!checkSession) {
    checkSession = session.fromPartition(`uchiyomi-check-${++probeSessions}`);
    installCertCheck(checkSession);
  }
  return checkSession;
}

/**
 * Is there an Uchiyomi server at this address? A refused certificate comes back with what was presented, for
 * the prompt -- from this session's own sightings, and only when the host ASKED about presented it
 * (servermode.js promptableCert): one refused further along a redirect is a secure-connection error naming
 * that host, never a prompt to pin it.
 * ⚠️ hopFetch over net.request, not session.fetch: Electron 44's fetch reports no final address after a redirect
 * (servermode.js hopFetch), so sign-in portals and http -> https upgrades were invisible.
 * @param {string} address
 * @param {Electron.Session} [ses]
 */
async function probe(address, ses = probeSes()) {
  const request = (/** @type {any} */ o) => require('electron').net.request({ ...o, session: ses });
  const r = /** @type {any} */ (await probeServer(address, { fetch: (u, init) => hopFetch(request, u, init) }));
  if (r.error === 'cert') {
    const p = promptableCert(r, (h) => sightings.get(ses)?.get(h));
    if (p.cert) { r.cert = p.cert; presented.set(p.cert.host, p.cert); }
    else { r.error = 'tls'; if (p.host) r.host = p.host; }
  }
  log.info('connect: probed', { ok: r.ok, error: r.error, origin: r.origin, from: r.redirectedFrom, newHost: r.newHost, status: r.status, detail: r.detail, portal: r.portal });
  return r;
}

/** What welcome:use may save after this probe: the server it proved, or -- behind a sign-in portal -- the server's origin the window will follow the portal from. @param {any} r */
function verifiedFrom(r) {
  return r?.ok ? { origin: r.origin, name: r.name } : r?.error === 'portal' ? { origin: r.origin, name: r.host } : null;
}

/**
 * The first-launch choice pending in welcome.html: resolves once, with the choice already saved in state.json.
 * @type {{ resolve: (r: { mode: 'standalone' } | { mode: 'server', server: { origin: string, name: string } }) => void } | null}
 */
let chooser = null;

/** @param {Record<string, any>} [pre] where the page starts (--server-url that did not work: its address + why) */
function firstLaunch(pre = {}) {
  /** @type {Promise<{ mode: 'standalone' } | { mode: 'server', server: { origin: string, name: string } }>} */
  const p = new Promise((resolve) => {
    chooser = { resolve: (r) => { if (!chooser) return; chooser = null; firstRunDone = () => {}; folderBack = null; resolve(r); } };
  });
  showWelcome({ from: 'first', step: 'choose', ...pre });
  // --server-url's own probe (a sign-in portal, or a server that sent it to another host): the page's Continue
  // saves what THAT probe proved -- showWelcome has just cleared `verified`, and Continue did nothing.
  if (pre.result) verified = verifiedFrom(pre.result);
  return p;
}

/**
 * What welcome.html shows (welcome:info). `from`: 'first' (the first launch), 'standalone' (the tray's
 * "Connect to my server instead", the app still running behind it) or 'server' (server mode's error page,
 * certificate prompt or "Switch server").
 * @type {Record<string, any>}
 */
let welcomeView = { from: 'first', step: 'choose' };
/** The server the last Connect proved: the only one welcome:use may save. @type {{ origin: string, name: string } | null} */
let verified = null;
let connecting = false;

/** @param {Record<string, any>} v */
function showWelcome(v) {
  welcomeView = v;
  verified = null;
  showWindow();
  void win?.loadFile(path.join(__dirname, 'welcome.html')).catch(() => { /* replaced by the next load */ });
}

/** @param {{ origin: string, name: string }} v */
function saveServer(v) {
  // Only server mode's own keys: the standalone library (libraryDir, ports, pgdata, backups) is never touched.
  stateFile.update(L.state, (s) => {
    s.mode = 'server'; s.serverOrigin = v.origin; s.serverName = v.name;
    // ⚠️ An https server this computer trusted when it was proven (no pin needed) is pinned as trusted-by-the-OS
    // (servermode.js OS_PIN): without it, someone in the middle with a self-signed certificate later got the
    // friendly one-click "Trust this server's certificate?" instead of the loud warning (V1 review S4).
    const pins = serverPins(pinsOf(s), v.origin);
    if (pins) s.certPins = pins;
  });
  log.info('server chosen', v);
  return { origin: v.origin, name: v.name };
}

/** A mode switch: the new mode is already saved; start again in it, after the ordered stop. */
function switchRelaunch() {
  app.relaunch({ args: relaunchArgs(process.argv) });
  void quit('relaunch');
}

/**
 * "Use on this computer instead" (server mode's tray and error page). With a library on this computer: switch
 * to it. Without one: its folder first, in this window, and the switch only once a folder is chosen -- Back
 * returns to the server, and quitting on the folder page leaves server mode as it was (servermode.js
 * localStart: saving the mode first stranded the person on a folder page with no way back).
 */
function useLocal() {
  if (localStart(stateFile.read(L.state)) === 'folder') {
    log.info('switching to standalone: choosing the library folder first');
    showFolderStep((dir) => { saveLibraryDir(dir); switchRelaunch(); }, () => void loadServer());
    return;
  }
  stateFile.update(L.state, (s) => { s.mode = 'standalone'; });
  log.info('switching to standalone');
  switchRelaunch();
}

/**
 * "Forget this server": sign out and drop what this app kept for it -- the origin's cookies, storage, service
 * worker and offline chapters, and its certificate pin -- then ask again how to use Uchiyomi. The standalone
 * library is not touched.
 */
async function forgetServer() {
  const sv = server;
  if (!sv) return;
  showWindow();
  const r = await dialog.showMessageBox(/** @type {any} */ (win), {
    type: 'warning',
    title: sv.name,
    message: t('forget.ask', { name: sv.name }),
    detail: t('forget.detail'),
    buttons: [t('forget.ok'), t('restore.cancel')],
    defaultId: 1,
    cancelId: 1,
  });
  if (r.response !== 0) return;
  try {
    await session.defaultSession.clearStorageData({ origin: sv.origin });
  } catch (e) {
    log.warn('forget: could not clear the server\'s storage', { error: String(e) });
  }
  const host = originHost(sv.origin);
  stateFile.update(L.state, (s) => { forgetServerState(s, host); });
  log.info('server forgotten', { origin: sv.origin });
  switchRelaunch();
}

/** welcome.html's calls (bridge.js gates every one to that page). */
const welcomeApi = {
  info: () => ({ ...welcomeView, server: server ? { origin: server.origin, name: server.name } : null }),
  /** @param {string} address */
  connect: async (address) => {
    if (connecting) return { ok: false, error: 'busy' };
    connecting = true;
    try {
      const r = /** @type {any} */ (await probe(address));
      // A sign-in portal in front (forward auth): the window can follow it, the probe cannot; the page offers
      // to continue with the server's address.
      verified = verifiedFrom(r);
      return r;
    } finally {
      connecting = false;
    }
  },
  /** @param {string} host @param {string} fingerprint @param {boolean} replace */
  trust: (host, fingerprint, replace) => {
    const h = pinHost(host);
    const check = pinUpdate({ pins: pinsOf(stateFile.read(L.state)), host: h, fingerprint, presented: presented.get(h), replace });
    if (!check.ok) {
      log.warn('certificate: not pinned', { host: h, error: /** @type {{ error: string }} */ (check).error });
      return check;
    }
    stateFile.update(L.state, (s) => {
      const u = pinUpdate({ pins: pinsOf(s), host: h, fingerprint, presented: presented.get(h), replace });
      if (u.ok) s.certPins = u.pins;
    });
    presented.delete(h);
    probeSession = null;
    checkSession = null;
    pinChanged = true;
    log.warn('certificate: pinned by the person', { host: h, fingerprint, replaced: /** @type {{ replaced?: string }} */ (check).replaced || undefined });
    return { ok: true };
  },
  use: () => {
    const v = verified;
    if (!v) return { ok: false, error: 'not-verified' };
    verified = null;
    const sv = saveServer(v);
    if (welcomeView.from === 'first' && chooser) chooser.resolve({ mode: 'server', server: sv });
    else switchRelaunch();
    return { ok: true };
  },
  local: () => {
    const c = chooser;
    if (welcomeView.from === 'first' && c) {
      if (localStart(stateFile.read(L.state)) === 'resume') {
        // "Forget this server" asks the first question again but leaves the library on this computer where it
        // was (servermode.js localStart): straight back into it, never the folder page's default folder.
        stateFile.update(L.state, (s) => { s.mode = 'standalone'; });
        log.info('on this computer: the library already chosen');
        c.resolve({ mode: 'standalone' });
        return { ok: true };
      }
      // The folder page next, with a way back; confirming it is the choice.
      showFolderStep((dir) => { saveLibraryDir(dir); c.resolve({ mode: 'standalone' }); }, () => showWelcome({ from: 'first', step: 'choose' }));
      return { ok: true };
    }
    if (appMode === 'server') { useLocal(); return { ok: true }; }
    return { ok: false };
  },
  cancel: () => {
    if (welcomeView.from === 'standalone' && standaloneUp && sup) void win?.loadURL(sup.url).catch(() => {});
    else if (welcomeView.from === 'server' && appMode === 'server') void loadServer();
    return { ok: true };
  },
  retry: () => {
    // After a certificate refusal for the server -- trusted since, or not -- the window's session holds
    // Chromium's cached answer (see installCertCheck): only a relaunch verifies again.
    if (appMode === 'server' && (pinChanged || windowRefused.has(serverHostname()))) switchRelaunch();
    else if (appMode === 'server') void loadServer();
    return { ok: true };
  },
};

/** Windows replaceWindow() is closing on purpose (their 'closed' is not Quit). @type {WeakSet<BrowserWindow>} */
const retired = new WeakSet();

/**
 * The first-launch choice was made in the 'choose' window: continue in a NEW window started in the chosen
 * mode (the preload's surface is per window), where the old one was, and close the old one once it shows.
 */
function replaceWindow() {
  const old = win;
  const bounds = old && !old.isDestroyed() ? old.getBounds() : null;
  createWindow(true, bounds);
  if (!old || old.isDestroyed()) return;
  retired.add(old);
  const gone = () => { if (!old.isDestroyed()) old.destroy(); };
  win?.once('ready-to-show', gone);
  setTimeout(gone, 5000).unref?.();
}

/** @param {boolean} show @param {Electron.Rectangle | null} [bounds] */
function createWindow(show, bounds = null) {
  // Fixed for this window's life: the preload reads it once per page (preload.js), and this window's own
  // navigation, close and failure handling below follow it.
  const mode = appMode;
  const w = new BrowserWindow({
    ...(bounds || { width: 1280, height: 860 }),
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
      additionalArguments: [`--uchiyomi-version=${app.getVersion()}`, `--uchiyomi-lang=${lang}`, `--uchiyomi-mode=${mode}`],
    },
  });
  win = w;
  w.once('ready-to-show', () => { sup?.mark('readyToShow'); if (show) w.show(); });
  w.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    // Server mode (and the first-launch choice) run nothing on this computer, so closing the window is Quit.
    if (mode !== 'standalone') {
      w.hide();
      void quit('window-closed');
      return;
    }
    // Standalone: closing the window keeps the app (and its scheduled sweeps) running in the tray; Quit stops it.
    w.hide();
    trayNoticeOnce();
  });
  // ⚠️ A page's own window.close() destroys the window WITHOUT the 'close' event above (Electron closes it
  // immediately): server mode was then left running with no window and nothing to show in one (found by the
  // server-mode product smoke). Only the first-launch window that replaceWindow() retires is expected to go.
  w.on('closed', () => {
    if (mode !== 'standalone' && !quitting && !retired.has(w)) void quit('window-closed');
  });
  // Windows shutting down, restarting or signing out never reaches before-quit: the ordered stop runs from here.
  installSessionEnd(/** @type {any} */ (win), {
    log,
    quit: (reason) => quit(reason),
    stopped: () => stopped,
    stopPostgresNow: () => sup?.stopPostgresNow() ?? 'not-started',
  });
  const wc = w.webContents;
  wc.on('did-finish-load', () => log.info('window: did-finish-load', { url: wc.getURL().replace(/\?.*$/, ''), sinceMainStart: Date.now() - T0 }));
  wc.on('render-process-gone', (_e, d) => {
    log.error('window: renderer gone', d);
    if (quitting) return;
    // Bring the app back rather than leaving a dead window: the bff -- or the person's server -- is still up.
    if (mode === 'server' && server) setTimeout(() => void loadServer(), 1000);
    else if (sup?.uiPort) setTimeout(() => void win?.loadURL(sup?.url || ''), 1000);
  });
  // Links out of the app open in the user's browser. Standalone keeps its own origin out of it (a browser has no
  // session on the local bff); in server mode every popup goes there -- the server works in a browser too.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && (mode === 'server' || !isOwnOrigin(url))) void shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    // servermode.js navDecision: our origin (the local bff's, or the person's server's), the shell's own pages
    // -- never another local file -- and in server mode any https origin (sign-in round trips).
    const d = navDecision({ mode, url, own: ownOrigin(), current: wc.getURL(), isShell: (u) => isShellPage(u) });
    if (d === 'allow') return;
    e.preventDefault();
    if (d === 'external') void shell.openExternal(url);
  });
  if (mode === 'server') {
    // An unreachable server, or a certificate this computer does not trust: the shell's own page says so, with
    // Retry / Change server / Use on this computer -- never a blank window.
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (isMainFrame && !quitting && /^https?:/i.test(url)) onServerLoadFailed(code, desc, url);
    });
    // Named after the server whatever page it shows (runServer sets it).
    w.on('page-title-updated', (e) => e.preventDefault());
  }
  // The window asks for nothing a manga reader needs (camera, location, notifications through the web API...).
  // Fullscreen for the reader is the one permission it uses.
  wc.session.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'fullscreen' || perm === 'clipboard-sanitized-write'));
  void w.loadFile(path.join(__dirname, 'loading.html'));
}

/** The origin the window may show: the local bff's (standalone) or the person's server's (server mode). */
function ownOrigin() {
  if (appMode === 'server') return server?.origin || '';
  // The plain origin (see appOrigin in the bridge): during the bff's restart gap a click on our own link must not
  // open in the system browser; the request gate holds the load until the port is ours again.
  return sup !== null && sup.uiPort > 0 ? `http://127.0.0.1:${sup.uiPort}` : '';
}

/** @param {string} url */
function isOwnOrigin(url) {
  try { const o = ownOrigin(); return !!o && new URL(url).origin === o; } catch { return false; }
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
  if (appMode === 'server') {
    // Nothing runs here to check, restore or verify: the server does all of that itself.
    items.push({ label: t('tray.switchServer'), click: () => showWelcome({ from: 'server', step: 'address' }) });
    items.push({ label: t('tray.useLocal'), click: () => useLocal() });
    items.push({ label: t('tray.forget'), enabled: !!server, click: () => void forgetServer() });
  } else if (appMode === 'standalone') {
    if (needsHuman) items.push({ label: t('tray.verify', { host: needsHuman }), click: () => showWindow() });
    items.push({ label: t('tray.check'), enabled: !!sup?.uiPort, click: () => void checkNow() });
    // The shell's own way in to "Restore a backup" (the web can call the same flow through the bridge).
    items.push({ label: `${t('restore.title')}…`, enabled: !!sup?.uiPort, click: () => { showWindow(); restoreBackupFlow().catch(() => { /* shown in a dialog */ }); } });
    // The server address page over the running app; Connect saves the server and relaunches into it, Cancel
    // comes back. The library on this computer is kept either way.
    items.push({ label: t('tray.toServer'), enabled: standaloneUp, click: () => showWelcome({ from: 'standalone', step: 'address' }) });
  }
  if (u.available && u.version) {
    items.push({ type: 'separator' });
    if (process.platform === 'win32' && u.ready) items.push({ label: t('tray.restartUpdate', { v: u.version }), click: () => void installUpdate() });
    else items.push({ label: t('tray.downloadUpdate', { v: u.version }), click: () => updates?.openDownload() });
  }
  items.push({ type: 'separator' });
  const loginItems = process.platform === 'win32' || process.platform === 'darwin';
  const on = loginItems && app.getLoginItemSettings().openAtLogin;
  // Not offered in server mode (nothing here to keep running) -- unless it is on, so it can still be turned off.
  if (loginItems && (appMode === 'standalone' || on)) {
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
  tray.setToolTip(needsHuman ? t('tray.verify', { host: needsHuman }) : appMode === 'server' && server ? server.name : 'Uchiyomi');
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
