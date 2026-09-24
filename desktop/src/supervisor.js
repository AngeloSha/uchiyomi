// @ts-check
'use strict';
/**
 * Start everything in order, stop it in reverse, and keep it alive in between.
 *
 *   start: postgres (initdb on first run) -> solver -> engine (if installed; nobody waits for it)
 *          -> bff (utilityProcess) -> /livez -> /healthz
 *   stop:  bff ({type:'shutdown'} -> its own SIGTERM path, 25 s cap) -> engine (stdin lifeline, 15 s cap)
 *          -> solver -> postgres (pg_ctl fast, then immediate)
 *
 * The same stop() runs on Quit, before an update is installed, on `--quit-for-update`, and in smoke mode. On
 * Windows that ordering is not politeness: a postgres.exe or java.exe still running from the install folder
 * holds files the installer must replace, and the NSIS installer kills only Uchiyomi.exe (spike S5).
 */
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { Postgres, isAlive, nonAscii, newFallbackName, isFallbackName, claimFallback } = require('./postgres');
const { ensurePort, canBind } = require('./ports');
const { bffEnv } = require('./env');
const { Engine } = require('./engine');
const state = require('./state');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Supervisor extends EventEmitter {
  /**
   * @param {{
   *   L: ReturnType<typeof import('./paths').layout>,
   *   resources: string,
   *   log: typeof import('./log'),
   *   version: string,
   *   utilityProcess: { fork: Function },
   *   libraryDir: string,
   *   readLibrary?: string | null,
   *   secret: string,
   *   osUser: string,
   *   startSolver: () => Promise<{ url: string, port: number, close: () => Promise<void> }>,
   *   enginePack: ReturnType<typeof import('./engine').resolvePack>,
   *   engineFetch?: typeof fetch,
   *   asciiFallback?: boolean,
   *   makePostgres?: (o: any) => any,
   *   makeEngine?: (o: any) => any,
   *   healthTimeoutMs?: number,
   *   platform?: string,              // tests: the Windows fallback decisions on another OS
   *   claimFallback?: typeof claimFallback,
   * }} o
   */
  constructor(o) {
    super();
    this.o = o;
    this.L = o.L;
    this.log = o.log;
    this.bff = null;
    this.stopping = null;
    this.cycling = false;
    this.crashes = [];
    this.timeline = /** @type {Record<string, number>} */ ({});
    const pgOpts = {
      distDir: path.join(o.resources, 'pg'),
      pgdata: o.L.pgdata,
      logFile: path.join(o.L.logs, 'postgres.log'),
      tmpDir: o.L.tmp,
      log: o.log,
      asciiFallback: o.asciiFallback,
    };
    this.pg = o.makePostgres ? o.makePostgres(pgOpts) : new Postgres(pgOpts);
    this.state = state.read(o.L.state);
    this.uiPort = 0;
    /** The port our OWN bff child said it bound (bff-entry.cjs), 0 until it does and again once it exits. */
    this.bffPort = 0;
    this.solver = null;
    // Windows, non-ASCII paths: ONE private folder in %ProgramData% for the cluster (PostgreSQL BUG #16926) and
    // the engine's runtime and temp folder (java.exe will not start from, and JNA will not load a DLL from, a
    // path outside the ANSI code page). Its name is random and kept in state.json; start() claims it -- makes,
    // locks and verifies it, or re-verifies the recorded one -- before anything is copied into or run from it
    // (postgres.js claimFallback says why it may never adopt a folder it did not make).
    const onWin = (o.platform || process.platform) === 'win32' && o.asciiFallback !== false;
    const engineAscii = onWin && nonAscii(o.L.root);
    const pgAscii = onWin && typeof this.pg.fallbackReasons === 'function' && this.pg.fallbackReasons().length > 0;
    this.asciiBase = engineAscii || pgAscii ? (isFallbackName(this.state.asciiBase) ? this.state.asciiBase : newFallbackName()) : null;
    this.engineBase = engineAscii ? this.asciiBase : null;
    const engineOpts = {
      L: o.L,
      log: o.log,
      pack: o.enginePack,
      port: () => Number(this.state.enginePort) || 0,
      creds: () => ({ user: this.secrets.engineUser, pass: this.secrets.enginePass }),
      solverUrl: () => this.solverUrl,
      asciiBase: this.engineBase,
      fetch: o.engineFetch,
    };
    this.engine = o.makeEngine ? o.makeEngine(engineOpts) : new Engine(engineOpts);
    this.engine.on('status', (s) => this.emit('engine-status', s));
    // Contract 5: a freshly installed engine is up -- restart the bff once so it registers the engine now
    // rather than after its own retry window (a 2-3 s blip the web survives behind its reconnect splash).
    this.engine.on('installed', () => {
      if (this.stopping) return;
      this.log.info('supervisor: the engine is installed; restarting the bff once to pick it up');
      this.restartBff('engine installed').catch((e) => this.log.error('supervisor: bff restart after the engine install failed', { error: String(e) }));
    });
    this.secrets = /** @type {Record<string, string>} */ ({});
    this.solverUrl = '';
  }

  mark(name) {
    this.timeline[name] = Date.now();
  }

  get url() {
    return `http://127.0.0.1:${this.uiPort}/`;
  }

  async start() {
    const { L, log } = this;
    for (const d of [L.config, L.db, L.backups, L.logs, L.tmp, L.engine]) fs.mkdirSync(d, { recursive: true });
    this.mark('supervisorStart');

    if (this.asciiBase) {
      // Throws (and the app shows why) rather than use a folder that is not this user's alone.
      const recorded = this.state.asciiBase === this.asciiBase;
      this.fallbackClaim = await (this.o.claimFallback || claimFallback)(this.asciiBase, { recorded, log });
      if (!recorded) {
        this.state.asciiBase = this.asciiBase;
        state.update(L.state, (s) => { s.asciiBase = this.asciiBase; });
      }
    }
    const prep = await this.pg.prepare({ base: this.asciiBase });
    this.fallback = prep.fallback;
    const stale = await this.pg.recoverStale();
    this.staleRecovery = stale;
    if (stale !== 'clean') log.warn(`postgres: recovery on boot: ${stale}`);

    // Ports are chosen once and kept (ports.js). The engine's is baked into every cover URL it hands out, so
    // give an engine left over from a crashed shell its ~250 ms to notice the closed pipe and let go first.
    if (this.state.enginePort && !(await canBind(Number(this.state.enginePort)))) {
      for (let i = 0; i < 20 && !(await canBind(Number(this.state.enginePort))); i++) await sleep(250);
    }
    const ui = await ensurePort(this.state, 'uiPort');
    const pgp = await ensurePort(this.state, 'pgPort');
    const eng = await ensurePort(this.state, 'enginePort');
    if (ui.changedFrom) log.warn(`ui port ${ui.changedFrom} is taken; moved to ${ui.port}. The web origin changed, so the window will need to sign in again and its offline data is gone.`);
    if (pgp.changedFrom) log.warn(`postgres port ${pgp.changedFrom} is taken; moved to ${pgp.port}`);
    if (eng.changedFrom) log.warn(`engine port ${eng.changedFrom} is taken; moved to ${eng.port}. Covers the engine served before will not load until it is refreshed.`);
    this.uiPort = ui.port;

    const secrets = state.read(L.secrets);
    let changed = false;
    if (!secrets.pgPassword) { secrets.pgPassword = crypto.randomBytes(24).toString('hex'); changed = true; }
    // The engine's basic-auth pair: made once, before the engine exists, because the bff gets SUWAYOMI_* from
    // the very first boot (contract 1).
    if (!secrets.engineUser) { secrets.engineUser = `uchiyomi-${crypto.randomBytes(6).toString('hex')}`; changed = true; }
    if (!secrets.enginePass) { secrets.enginePass = crypto.randomBytes(24).toString('hex'); changed = true; }
    if (changed) state.write(L.secrets, secrets, 0o600);
    this.secrets = secrets;
    this.pg.password = secrets.pgPassword;

    if (!this.pg.initialized()) {
      this.mark('initdbStart');
      await this.pg.initdb(secrets.pgPassword);
      this.mark('initdbDone');
    }
    await this.pg.start(pgp.port);
    await this.pg.ensureDatabase('yomi');
    this.mark('postgresReady');

    this.solver = await this.o.startSolver();
    this.solverUrl = this.solver.url;
    this.mark('solverReady');

    this.state.mainPid = process.pid;
    this.state.version = this.o.version;
    this.state.pgBinDir = this.pg.binDir;
    this.state.pgdata = this.pg.pgdata;
    const mine = ['uiPort', 'pgPort', 'enginePort', 'mainPid', 'version', 'pgBinDir', 'pgdata'];
    state.update(L.state, (s) => { for (const k of mine) s[k] = this.state[k]; });

    // Installed: start it alongside, never wait for it -- the bff retries the engine for minutes on its own.
    if (this.engine.installed()) {
      this.engine.start().catch((e) => log.warn('engine: did not start', { error: String(e) }));
    }

    this.watchPostgres();
    this.forkBff();
    await this.waitHealthy(this.o.healthTimeoutMs);
    this.mark('bffHealthy');
    log.info('supervisor: up', { url: this.url, timeline: this.relTimeline() });
  }

  relTimeline() {
    const t0 = this.timeline.supervisorStart || 0;
    return Object.fromEntries(Object.entries(this.timeline).map(([k, v]) => [k, v - t0]));
  }

  env() {
    return bffEnv({
      L: this.L,
      resources: this.o.resources,
      uiPort: this.uiPort,
      pgPort: this.pg.port,
      pgPassword: this.pg.password,
      pgBinDir: this.pg.binDir,
      libraryDir: this.o.libraryDir,
      readLibrary: this.o.readLibrary,
      secret: this.o.secret,
      solverUrl: this.solverUrl,
      enginePort: Number(this.state.enginePort),
      engineUser: this.secrets.engineUser,
      enginePass: this.secrets.enginePass,
      osUser: this.o.osUser,
    });
  }

  forkBff() {
    const bffDir = path.join(this.o.resources, 'bff');
    const main = path.join(bffDir, 'dist', 'server.js');
    const out = fs.createWriteStream(path.join(this.L.logs, 'bff.log'), { flags: 'a' });
    this.mark('bffFork');
    const child = this.o.utilityProcess.fork(path.join(__dirname, 'bff-entry.cjs'), [main], {
      env: this.env(),
      cwd: bffDir,
      stdio: 'pipe',
      serviceName: 'Uchiyomi server',
    });
    child.stdout?.on('data', (b) => out.write(b));
    child.stderr?.on('data', (b) => out.write(b));
    child.once('spawn', () => this.log.info('bff: spawned', { pid: child.pid }));
    this.bffPort = 0;
    child.on('message', (m) => {
      if (this.bff === child && m && m.type === 'listening' && m.address === '127.0.0.1' && Number.isInteger(m.port)) {
        this.bffPort = m.port;
        if (m.port !== this.uiPort) this.log.warn('bff: listening on an unexpected port', { port: m.port, uiPort: this.uiPort });
      }
    });
    child.once('exit', (code) => {
      out.end();
      const expected = this.stopping || this.cycling;
      this.log[expected ? 'info' : 'warn'](`bff: exited with ${code}`);
      this.emit('bff-exit', code);
      if (this.bff === child) { this.bff = null; this.bffPort = 0; }
      if (!expected) this.respawnAfterCrash();
    });
    this.bff = child;
  }

  /** Backoff 1 s .. 30 s; five crashes inside two minutes is a bug, not a blip -- stop and say so. */
  respawnAfterCrash() {
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < 120_000);
    this.crashes.push(now);
    if (this.crashes.length >= 5) {
      this.log.error('bff: 5 crashes in 2 minutes; giving up');
      this.emit('fatal', new Error('The Uchiyomi server keeps stopping. See logs/bff.log.'));
      return;
    }
    const delay = Math.min(30_000, 1000 * 2 ** (this.crashes.length - 1));
    this.log.warn(`bff: restarting in ${delay} ms`);
    setTimeout(() => { if (!this.stopping && !this.cycling && !this.bff) this.forkBff(); }, delay);
  }

  /**
   * The bff's graceful stop: contract 4's `{type:'shutdown'}` over the parentPort, which bff-entry.cjs turns into
   * the bff's own SIGTERM handler (finish the chapter in flight, 20 s cap). Windows has no SIGTERM for a child,
   * so kill() there would cut a download in half. 25 s, then a kill.
   * @returns {Promise<string>}
   */
  async stopBffChild() {
    const child = this.bff;
    if (!child) return 'not-running';
    const exited = new Promise((r) => child.once('exit', (code) => r(code)));
    child.postMessage({ type: 'shutdown' });
    const code = await Promise.race([exited, sleep(25_000).then(() => 'timeout')]);
    if (code === 'timeout') {
      this.log.warn('bff: did not stop within 25 s; killing it');
      child.kill();
      await Promise.race([exited, sleep(5000)]);
      return 'killed';
    }
    return `exited:${code}`;
  }

  /** Stop the bff on purpose (a restore): no crash-restart, until startBff(). */
  async stopBff() {
    this.cycling = true;
    return this.stopBffChild();
  }

  /** Start it again after stopBff(), and wait until it is healthy. */
  async startBff() {
    try {
      if (!this.bff && !this.stopping) this.forkBff();
      await this.waitHealthy(this.o.healthTimeoutMs);
    } finally {
      this.cycling = false;
    }
  }

  /** @param {string} why */
  async restartBff(why) {
    this.log.info(`supervisor: restarting the bff (${why})`);
    await this.stopBff();
    await this.startBff();
    this.emit('bff-restarted', why);
  }

  /** Postgres dying under us: stop the bff, restart postgres, restart the bff. */
  watchPostgres() {
    this.pgWatch = setInterval(async () => {
      if (this.stopping || this.pgRecovering || this.cycling) return;
      if (this.pg.running()) return;
      this.pgRecovering = true;
      this.log.error('postgres: the server is gone; restarting it');
      try {
        this.cycling = true;
        if (this.bff) { this.bff.kill(); await sleep(500); }
        await this.pg.recoverStale();
        await this.pg.start(this.pg.port);
        if (!this.bff && !this.stopping) this.forkBff();
      } catch (e) {
        this.log.error('postgres: restart failed', { error: String(e) });
        this.emit('fatal', e);
      } finally {
        this.cycling = false;
        this.pgRecovering = false;
      }
    }, 10_000);
  }

  /**
   * The UI port, but only while our own bff child has confirmed it is the one listening there (bff-entry.cjs),
   * else 0. ⚠️ Everything that trusts the UI origin reads THIS, never `uiPort`: the sign-in header, the window's
   * requests, the preload bridge's sender check. A process squatting the port -- at start-up or in the gap while
   * the bff restarts -- is then never sent the secret and never gets the bridge.
   */
  trustedPort() {
    return this.bff && this.bffPort > 0 && this.bffPort === this.uiPort ? this.uiPort : 0;
  }

  /** @returns {Promise<void>} */
  async waitHealthy(timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    let live = false;
    let last = '';
    while (Date.now() < deadline) {
      if (!this.bff && this.crashes.length) throw new Error('the Uchiyomi server exited during startup; see logs/bff.log');
      // Not before our own child has said it holds the port: /livez answers from whoever holds it.
      if (!this.trustedPort()) { last = 'waiting for the server to bind its port'; await sleep(250); continue; }
      try {
        if (!live) {
          const r = await fetch(`http://127.0.0.1:${this.uiPort}/livez`, { signal: AbortSignal.timeout(3000) });
          if (r.ok) { live = true; this.mark('bffLive'); }
        }
        if (live) {
          const r = await fetch(`http://127.0.0.1:${this.uiPort}/healthz`, { signal: AbortSignal.timeout(3000) });
          if (r.ok) return;
          last = `healthz ${r.status}`;
        }
      } catch (e) {
        last = String(/** @type {any} */ (e).cause?.code || e);
      }
      await sleep(250);
    }
    throw new Error(`the Uchiyomi server did not become healthy within ${timeoutMs / 1000} s (${last})`);
  }

  /**
   * Ordered shutdown. Safe to call more than once; every caller awaits the same run.
   * @param {string} reason
   */
  stop(reason = 'quit') {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      const t0 = Date.now();
      this.log.info(`supervisor: stopping (${reason})`);
      if (this.pgWatch) clearInterval(this.pgWatch);
      const res = { reason, bff: 'not-running', engine: 'not-running', solver: 'not-running', postgres: 'not-running', ms: 0 };
      res.bff = await this.stopBffChild().catch((e) => `error:${String(e)}`);
      res.engine = await this.engine.stop().catch((e) => `error:${String(e)}`);
      if (this.solver) {
        try { await this.solver.close(); res.solver = 'closed'; } catch (e) { res.solver = `error:${String(e)}`; }
      }
      try {
        res.postgres = await this.pg.stop({ reason });
      } catch (e) {
        res.postgres = `error:${String(e)}`;
      }
      const pid = this.pg.pidFromFile();
      if (pid && isAlive(pid)) res.postgres += ':STILL-RUNNING';
      if (this.state.mainPid === process.pid) {
        delete this.state.mainPid;
        state.update(this.L.state, (s) => { if (s.mainPid === process.pid) delete s.mainPid; });
      }
      res.ms = Date.now() - t0;
      this.log.info('supervisor: stopped', res);
      return res;
    })();
    return this.stopping;
  }

  /**
   * Windows is ending the session before stop() finished (sessionend.js): fast-stop postgres now, synchronously.
   * The bff and the engine go down with the session; a cleanly stopped cluster is what spares the next boot a
   * crash recovery.
   * @returns {string}
   */
  stopPostgresNow() {
    if (this.pgWatch) clearInterval(this.pgWatch);
    return typeof this.pg.stopSync === 'function' ? this.pg.stopSync() : 'unsupported';
  }
}

module.exports = { Supervisor };
