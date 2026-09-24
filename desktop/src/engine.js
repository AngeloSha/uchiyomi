// @ts-check
'use strict';
/**
 * The extension engine (Suwayomi-Server), downloaded on first use.
 *
 * Nothing about it ships in the installer: Admin -> Extensions offers "Download the extension engine", the web
 * calls `window.uchiyomiDesktop.engine.install()`, and this module downloads the pinned pack (engine-pin.json),
 * checks its SHA-256 while it streams, unpacks it, starts it and reports every step to the window. The
 * supervisor restarts the bff once when a fresh install is up (contract 5), because the bff's own Suwayomi
 * registration gives up after ~3.8 minutes and a first download can take longer than that. On later launches
 * an installed engine is started with everything else, and nobody waits for it.
 *
 * The launch is spike S7's WORKING recipe (engine/README.md), not design-shell.md §5's literal one:
 *   - rootDir, the credentials and the solver URL travel in the ENVIRONMENT and the shim jar maps them to
 *     system properties. On Windows the java launcher reads its command line through the ANSI code page, so a
 *     data folder under `C:\Users\Jösé 名前` arrived as `Jösé ??`; and secrets on a command line are readable
 *     by every account on the machine (`ps`).
 *   - the runtime (java.exe itself) and java.io.tmpdir must be ASCII paths on Windows ("could not find
 *     java.dll"; JNA's UnsatisfiedLinkError). When the data root is not ASCII they go to the same private
 *     %ProgramData% fallback folder Postgres uses. The child's TEMP/TMP point there as well, so even the JVM's
 *     startup temp dir is ASCII -- the review of S7 noted the shim only moves java.io.tmpdir after startup.
 *   - `kcefEnabled=false`, always. Left at Suwayomi's default the engine downloads a ~230 MB JetBrains runtime
 *     with CEF on first boot, and on macOS it then dies in cef_initialize on every start (S7). Extensions that
 *     need an in-app WebView therefore do not work in the desktop app; the docs say so.
 *   - the jar stays in `bin/`. Beside `jre/`, ClassGraph skips it, and the engine never answers (it does not
 *     exit: the readiness timeout is what catches that).
 *   - spawned hidden with every stdio handle PIPED: libuv sets CREATE_NO_WINDOW only when no handle is
 *     inherited (S7-9, no console window flashing up on Windows).
 *   - stdin is the lifeline. Closing it makes the shim call System.exit(0), which runs the shutdown hooks that
 *     close the engine's H2 database; a hard kill loses the last write (S7-8). If the shell itself dies, the OS
 *     closes the pipe and the engine exits ~250 ms later, so a crashed shell leaves no orphan java.
 */
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const archive = require('./archive');

const WIN = process.platform === 'win32';
const nonAscii = (s) => /[^\x20-\x7e]/.test(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The pack name for this machine. Windows is x64 only: Windows on ARM runs the x64 app under emulation. */
function platformKey(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return 'win-x64';
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (platform === 'linux') return 'linux-x64';
  return null;
}

/**
 * Which pack to download: the pinned one, or (tests and the CI smoke only) an explicit URL + SHA-256 pair.
 * `null` sha256 = not published yet: install() then refuses without touching the network.
 * @param {any} pin engine-pin.json
 * @param {{ url?: string, sha256?: string }} [override]
 * @param {string | null} [key]
 * @returns {{ version: string, key: string | null, url: string | null, sha256: string | null, bytes: number | null, file: string }}
 */
function resolvePack(pin, override = {}, key = platformKey()) {
  const version = String(pin.version);
  if (override.url || override.sha256) {
    if (!override.url || !/^[0-9a-f]{64}$/i.test(String(override.sha256 || ''))) {
      throw new Error('--engine-pack-url needs --engine-pack-sha256 (64 hex characters), and the other way round');
    }
    return { version, key, url: override.url, sha256: String(override.sha256).toLowerCase(), bytes: null, file: path.basename(new URL(override.url).pathname) || 'engine-pack.zip' };
  }
  const p = key ? pin.packs?.[key] : null;
  if (!p) return { version, key, url: null, sha256: null, bytes: null, file: '' };
  const sha = typeof p.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(p.sha256) ? p.sha256.toLowerCase() : null;
  return { version, key, url: sha ? `${pin.baseUrl}/${p.file}` : null, sha256: sha, bytes: Number(p.bytes) || null, file: p.file };
}

/**
 * The engine's command line and environment (S7's working recipe). Pure: tests hold it against the traps.
 * @param {{ runtimeDir: string, rootDir: string, tmpDir: string, port: number, fsUrl: string, user: string, pass: string, xmx?: string, baseEnv?: NodeJS.ProcessEnv, platform?: string }} o
 */
function buildLaunch(o) {
  const platform = o.platform || process.platform;
  const win = platform === 'win32';
  const sep = win ? ';' : ':';
  const java = path.join(o.runtimeDir, 'jre', 'bin', win ? 'java.exe' : 'java');
  const P = '-Dsuwayomi.tachidesk.config.server.';
  const props = {
    ip: '127.0.0.1',
    port: String(o.port),
    webUIEnabled: 'false',
    initialOpenInBrowserEnabled: 'false',
    systemTrayEnabled: 'false',
    downloadAsCbz: 'true',
    autoDownloadNewChapters: 'false',
    flareSolverrEnabled: 'true',
    authMode: 'BASIC_AUTH',
    kcefEnabled: 'false',
  };
  /** @type {Record<string, string>} */
  const env = {};
  for (const [k, v] of Object.entries(o.baseEnv || process.env)) {
    if (v === undefined) continue;
    // A user-level JAVA_TOOL_OPTIONS / _JAVA_OPTIONS / JDK_JAVA_OPTIONS / CLASSPATH would silently change our
    // JVM; our own UCHIYOMI_* names are set below and nothing else of that family belongs to the engine.
    if (/^(JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|CLASSPATH|JAVA_HOME|UCHIYOMI_.*|PG.*)$/i.test(k)) continue;
    env[k] = v;
  }
  // ⚠️ The JVM's own temp dir at startup comes from TEMP/TMP (Windows) or TMPDIR, before the shim can move
  // java.io.tmpdir; under a non-ASCII profile that is where JNA would extract its DLL. Same ASCII folder.
  env.TEMP = o.tmpDir;
  env.TMP = o.tmpDir;
  env.TMPDIR = o.tmpDir;
  env.UCHIYOMI_ENGINE_ROOT_DIR = o.rootDir;
  env.UCHIYOMI_ENGINE_TMP_DIR = o.tmpDir;
  env.UCHIYOMI_ENGINE_AUTH_USERNAME = o.user;
  env.UCHIYOMI_ENGINE_AUTH_PASSWORD = o.pass;
  env.UCHIYOMI_ENGINE_FLARESOLVERR_URL = o.fsUrl;
  const args = [
    `-Xmx${o.xmx || '768m'}`, '-XX:+UseSerialGC', '-Djava.awt.headless=true',
    '-Djava.util.prefs.PreferencesFactory=dev.uchiyomi.IsolatedPreferences$Factory',
    // Relative to cwd = the runtime, so no path at all is on the command line. bin/, never the pack root.
    '-cp', ['bin/Suwayomi-Server.jar', 'bin/uchiyomi-shim.jar'].join(sep),
    ...Object.entries(props).map(([k, v]) => `${P}${k}=${v}`),
    'dev.uchiyomi.EngineShim',
  ];
  return { cmd: java, args, env, cwd: o.runtimeDir };
}

/** Is `/api/v1/settings/about` answering (200 with credentials, 401 without)? That is Suwayomi being up. */
async function probeReady(port, timeoutMs = 2000) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/settings/about`, { signal: AbortSignal.timeout(timeoutMs) });
    await r.arrayBuffer().catch(() => null);
    return r.status === 200 || r.status === 401;
  } catch {
    return false;
  }
}

/**
 * @typedef {'absent'|'downloading'|'installing'|'starting'|'running'|'failed'} EngineState
 * @typedef {{ state: EngineState, progress?: number, bytes?: number, total?: number, error?: string }} EngineStatus
 */

class Engine extends EventEmitter {
  /**
   * @param {{
   *   L: ReturnType<typeof import('./paths').layout>,
   *   log: { info: Function, warn: Function, error: Function },
   *   pack: ReturnType<typeof resolvePack>,
   *   port: () => number,
   *   creds: () => { user: string, pass: string },
   *   solverUrl: () => string,
   *   asciiBase?: string | null,        // Windows non-ASCII data root: the private %ProgramData% fallback
   *   fetch?: typeof fetch,             // the download; the app passes Electron's net.fetch (system proxy)
   *   readyTimeoutMs?: number,
   *   stallMs?: number,
   *   crashLimit?: number,
   * }} o
   */
  constructor(o) {
    super();
    this.o = o;
    this.log = o.log;
    this.pack = o.pack;
    const base = o.asciiBase || o.L.root;
    this.runtimeRoot = path.join(base, 'engine-runtime');
    this.runtimeDir = path.join(this.runtimeRoot, o.pack.version);
    this.tmpDir = path.join(base, 'engine-tmp');
    // The engine's own data (its H2 database, extensions): series are routed by its ids, so this is kept
    // forever and may be any path -- it reaches Java through the environment, never the command line.
    this.rootDir = o.L.engine;
    this.downloadDir = path.join(o.L.root, 'engine-download');
    this.logFile = path.join(o.L.logs, 'engine.log');
    /** @type {EngineStatus} */
    this.s = { state: this.installed() ? 'starting' : 'absent' };
    this.child = null;
    this.stopping = false;
    this.crashes = /** @type {number[]} */ ([]);
    this.installing = /** @type {Promise<void> | null} */ (null);
    this.starting = /** @type {Promise<void> | null} */ (null);
    this.lastEmit = 0;
  }

  /** @returns {EngineStatus} */
  status() {
    return { ...this.s };
  }

  /** @param {EngineStatus} s */
  set(s, { throttle = false } = {}) {
    this.s = s;
    const now = Date.now();
    if (throttle && now - this.lastEmit < 250) return;
    this.lastEmit = now;
    this.emit('status', this.status());
  }

  installed() {
    return fs.existsSync(path.join(this.runtimeDir, 'engine.json')) && fs.existsSync(this.javaPath());
  }

  javaPath() {
    return path.join(this.runtimeDir, 'jre', 'bin', WIN ? 'java.exe' : 'java');
  }

  /**
   * Download, verify, unpack, start. One run at a time: a second call (a double click, two windows) joins the
   * first. Resolves once the engine answers; rejects with a sentence the Extensions card can show.
   */
  install() {
    if (this.installing) return this.installing;
    this.installing = this.doInstall().finally(() => { this.installing = null; });
    return this.installing;
  }

  async doInstall() {
    if (this.s.state === 'running') return;
    if (this.installed()) {
      // Installed but not running (it failed to start, or crashed too often): try starting it before
      // throwing away 200 MB. Only a runtime that still will not start is downloaded again.
      try {
        this.crashes = [];
        await this.start();
        return;
      } catch (e) {
        this.log.warn('engine: the installed runtime does not start; downloading it again', { error: String(e) });
        await fsp.rm(this.runtimeDir, { recursive: true, force: true });
      }
    }
    const pack = this.pack;
    if (!pack.url || !pack.sha256) {
      return this.fail(new Error('The extension engine download is not available for this version of Uchiyomi yet.'));
    }
    let zip = '';
    try {
      this.set({ state: 'downloading', progress: 0, bytes: 0, total: pack.bytes || 0 });
      zip = await this.download(pack);
      this.set({ state: 'installing' });
      await this.unpack(zip);
    } catch (e) {
      return this.fail(e);
    } finally {
      if (zip) await fsp.rm(zip, { force: true }).catch(() => {});
    }
    this.crashes = [];
    await this.start();
    this.log.info('engine: installed and running', { version: pack.version, runtime: this.runtimeDir });
    // The supervisor restarts the bff once on this (contract 5).
    this.emit('installed');
  }

  /** @param {unknown} e */
  fail(e) {
    const msg = String(/** @type {any} */ (e)?.message || e);
    this.log.error('engine: install failed', { error: msg });
    this.set({ state: 'failed', error: msg });
    throw new Error(msg);
  }

  /**
   * Stream the pack to disk, hashing as it arrives, so a corrupted or swapped file is refused before a single
   * byte of it is unpacked. A download that stalls for a minute is abandoned rather than hanging forever.
   * @param {ReturnType<typeof resolvePack>} pack
   * @returns {Promise<string>} the verified file
   */
  async download(pack) {
    const fetchImpl = this.o.fetch || fetch;
    await fsp.mkdir(this.downloadDir, { recursive: true });
    const dest = path.join(this.downloadDir, pack.file || 'engine-pack.zip');
    const part = `${dest}.part`;
    const stallMs = this.o.stallMs ?? 60_000;
    const ctl = new AbortController();
    let stall = setTimeout(() => ctl.abort(), stallMs);
    const poke = () => { clearTimeout(stall); stall = setTimeout(() => ctl.abort(), stallMs); };
    const t0 = Date.now();
    this.log.info('engine: downloading', { url: pack.url });
    let res;
    try {
      res = await fetchImpl(/** @type {string} */ (pack.url), { redirect: 'follow', signal: ctl.signal });
    } catch (e) {
      clearTimeout(stall);
      throw new Error(`Could not download the extension engine (${ctl.signal.aborted ? 'no answer for a minute' : String(/** @type {any} */ (e)?.message || e)}). Check the internet connection and try again.`);
    }
    if (!res.ok || !res.body) {
      clearTimeout(stall);
      throw new Error(`Could not download the extension engine (HTTP ${res.status}). Try again later.`);
    }
    const total = Number(res.headers.get('content-length')) || pack.bytes || 0;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(part);
    const outDone = new Promise((resolve, reject) => { out.once('finish', () => resolve(undefined)); out.once('error', reject); });
    let bytes = 0;
    try {
      const reader = /** @type {ReadableStream<Uint8Array>} */ (res.body).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        poke();
        hash.update(value);
        bytes += value.length;
        if (!out.write(value)) await new Promise((r) => out.once('drain', () => r(undefined)));
        this.set({ state: 'downloading', bytes, total, progress: total ? Math.min(1, bytes / total) : 0 }, { throttle: true });
      }
      out.end();
      await outDone;
    } catch (e) {
      out.destroy();
      await fsp.rm(part, { force: true }).catch(() => {});
      throw new Error(`The extension engine download was interrupted (${ctl.signal.aborted ? 'no data for a minute' : String(/** @type {any} */ (e)?.message || e)}). Try again.`);
    } finally {
      clearTimeout(stall);
    }
    this.set({ state: 'downloading', bytes, total: total || bytes, progress: 1 });
    const got = hash.digest('hex');
    if (got !== pack.sha256) {
      await fsp.rm(part, { force: true }).catch(() => {});
      this.log.error('engine: checksum mismatch', { got, want: pack.sha256, bytes });
      throw new Error('The downloaded extension engine did not match its checksum, so it was not installed. Try again.');
    }
    await fsp.rm(dest, { force: true });
    await fsp.rename(part, dest);
    this.log.info(`engine: downloaded ${(bytes / 1048576).toFixed(1)} MiB in ${((Date.now() - t0) / 1000).toFixed(1)} s`, { sha256: got });
    return dest;
  }

  /** Unpack beside the final folder, check it, then swap it in, so a half-unpacked runtime is never "installed". */
  async unpack(zip) {
    const t0 = Date.now();
    await fsp.mkdir(this.runtimeRoot, { recursive: true });
    const tmp = path.join(this.runtimeRoot, `${this.pack.version}.partial-${crypto.randomBytes(4).toString('hex')}`);
    try {
      const r = await archive.extractZip(zip, tmp);
      const meta = JSON.parse(await fsp.readFile(path.join(tmp, 'engine.json'), 'utf8'));
      const java = path.join(tmp, 'jre', 'bin', WIN ? 'java.exe' : 'java');
      if (!fs.existsSync(java)) throw new Error('the pack has no Java runtime for this computer');
      for (const jar of ['Suwayomi-Server.jar', 'uchiyomi-shim.jar']) {
        if (!fs.existsSync(path.join(tmp, 'bin', jar))) throw new Error(`the pack has no bin/${jar}`);
      }
      if (!WIN) {
        // Belt and braces: the pack records unix modes, but a pack re-zipped by another tool would not.
        await fsp.chmod(java, 0o755);
        const helper = path.join(tmp, 'jre', 'lib', 'jspawnhelper');
        if (fs.existsSync(helper)) await fsp.chmod(helper, 0o755);
      }
      await fsp.rm(this.runtimeDir, { recursive: true, force: true });
      await fsp.rename(tmp, this.runtimeDir);
      this.log.info(`engine: unpacked ${r.files} files (${(r.bytes / 1048576).toFixed(1)} MiB) in ${Date.now() - t0} ms`, { meta });
    } catch (e) {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw new Error(`The extension engine could not be unpacked: ${String(/** @type {any} */ (e)?.message || e)}`);
    }
  }

  /**
   * Start the installed engine and wait until it answers. Joins a start already in flight.
   * @returns {Promise<void>}
   */
  start() {
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => { this.starting = null; });
    return this.starting;
  }

  async doStart() {
    if (!this.installed()) { this.set({ state: 'absent' }); throw new Error('the extension engine is not installed'); }
    if (this.child) return;
    this.stopping = false;
    await fsp.mkdir(this.rootDir, { recursive: true });
    await fsp.mkdir(this.tmpDir, { recursive: true });
    const { user, pass } = this.o.creds();
    const port = this.o.port();
    const l = buildLaunch({ runtimeDir: this.runtimeDir, rootDir: this.rootDir, tmpDir: this.tmpDir, port, fsUrl: this.o.solverUrl(), user, pass });
    this.set({ state: 'starting' });
    const t0 = Date.now();
    const out = fs.createWriteStream(this.logFile, { flags: 'a' });
    const child = spawn(l.cmd, l.args, { cwd: l.cwd, env: l.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    // Always drain both pipes: an unread pipe fills and blocks the JVM's logging threads.
    child.stdout?.on('data', (b) => out.write(b));
    child.stderr?.on('data', (b) => out.write(b));
    child.stdin?.on('error', () => { /* EPIPE once the JVM has gone: expected */ });
    let exited = false;
    let ready = false;
    const exit = new Promise((resolve) => child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); }));
    child.once('error', (e) => { out.write(`\n[spawn error] ${e.message}\n`); });
    child.once('exit', (code, signal) => {
      out.end();
      if (this.child === child) this.child = null;
      // Before it was ever ready, the waiter below owns the failure (and says so to whoever called start()).
      if (this.stopping || !ready) return;
      this.log.warn(`engine: exited (${code ?? signal}) while it should be running`);
      this.emit('exit', code);
      this.restartAfterCrash();
    });
    this.log.info('engine: started', { pid: child.pid, port, runtime: this.runtimeDir });
    const deadline = t0 + (this.o.readyTimeoutMs ?? 180_000);
    while (Date.now() < deadline) {
      if (exited) {
        const e = /** @type {any} */ (await exit);
        const msg = `The extension engine stopped while starting (exit ${e.code ?? e.signal}). See logs/engine.log.`;
        if (this.s.state !== 'failed') this.set({ state: 'failed', error: msg });
        throw new Error(msg);
      }
      if (await probeReady(port)) {
        ready = true;
        this.log.info(`engine: ready in ${Date.now() - t0} ms`, { port });
        this.set({ state: 'running' });
        return;
      }
      await sleep(250);
    }
    // ⚠️ The engine can hang WITHOUT exiting (the ClassGraph trap: a jar next to jre/ boots a JVM that never
    // answers), so the deadline, not an exit, is what ends a bad start.
    const msg = 'The extension engine did not start within 3 minutes. See logs/engine.log.';
    this.set({ state: 'failed', error: msg });
    await this.stop();
    throw new Error(msg);
  }

  /** Backoff 2 s .. 60 s; five crashes in ten minutes is a broken runtime, not a blip -- stop and say so. */
  restartAfterCrash() {
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < 10 * 60_000);
    this.crashes.push(now);
    if (this.crashes.length >= (this.o.crashLimit ?? 5)) {
      this.set({ state: 'failed', error: 'The extension engine keeps stopping. See logs/engine.log.' });
      this.log.error('engine: too many crashes; not restarting it');
      return;
    }
    const delay = Math.min(60_000, 2000 * 2 ** (this.crashes.length - 1));
    this.set({ state: 'starting' });
    setTimeout(() => {
      if (this.stopping) return;
      this.start().catch((e) => {
        this.log.warn('engine: restart failed', { error: String(e) });
        // A restart that dies before it is ready counts as another crash, so the limit above still ends it.
        if (!this.stopping) this.restartAfterCrash();
      });
    }, delay).unref?.();
  }

  /**
   * Graceful stop through the shim's lifeline (stdin EOF -> System.exit(0) -> H2 closes), then a kill.
   * @returns {Promise<string>}
   */
  async stop(timeoutMs = 15_000) {
    this.stopping = true;
    const child = this.child;
    if (!child) return 'not-running';
    const exited = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
      else child.once('exit', (code) => resolve(code));
    });
    try { child.stdin?.end(); } catch { /* already closed */ }
    const code = await Promise.race([exited, sleep(timeoutMs).then(() => 'timeout')]);
    if (code === 'timeout') {
      this.log.warn(`engine: did not stop within ${timeoutMs / 1000} s; killing it`);
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      await Promise.race([exited, sleep(5000)]);
      if (this.child === child) this.child = null;
      return 'killed';
    }
    if (this.child === child) this.child = null;
    return `exited:${code}`;
  }

  get pid() {
    return this.child?.pid || 0;
  }
}

module.exports = { Engine, buildLaunch, resolvePack, platformKey, probeReady, PIN: require('./engine-pin.json') };
