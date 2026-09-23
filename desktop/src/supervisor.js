// @ts-check
'use strict';
/**
 * Start everything in order, stop it in reverse, and keep it alive in between.
 *
 *   start: postgres (initdb on first run) -> bff (utilityProcess) -> /livez -> /healthz
 *   stop:  bff ('shutdown' -> its own SIGTERM path, 25 s cap) -> postgres (pg_ctl fast, then immediate)
 *
 * The same stop() runs on Quit, on `--quit-for-update` (what the updater will call before installing), and
 * in smoke mode. On Windows that ordering is not politeness: a postgres.exe still running from the install
 * directory holds files the installer must replace.
 */
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { Postgres, isAlive } = require('./postgres');
const { ensurePort } = require('./ports');
const { bffEnv } = require('./env');
const state = require('./state');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Supervisor extends EventEmitter {
  /**
   * @param {{
   *   L: ReturnType<typeof import('./paths').layout>,
   *   resources: string,
   *   log: typeof import('./log'),
   *   version: string,
   *   asciiFallback?: boolean,
   *   utilityProcess: typeof import('electron').utilityProcess,
   * }} o
   */
  constructor(o) {
    super();
    this.o = o;
    this.L = o.L;
    this.log = o.log;
    this.bff = null;
    this.stopping = null;
    this.crashes = [];
    this.timeline = /** @type {Record<string, number>} */ ({});
    this.pg = new Postgres({
      distDir: path.join(o.resources, 'pg'),
      pgdata: o.L.pgdata,
      logFile: path.join(o.L.logs, 'postgres.log'),
      tmpDir: o.L.tmp,
      log: o.log,
      asciiFallback: o.asciiFallback,
    });
    this.state = state.read(o.L.state);
    this.uiPort = 0;
  }

  mark(name) {
    this.timeline[name] = Date.now();
  }

  get url() {
    return `http://127.0.0.1:${this.uiPort}/`;
  }

  async start() {
    const { L, log } = this;
    for (const d of [L.config, L.db, L.library, L.downloads, L.sources, L.cache, L.backups, L.logs, L.tmp]) fs.mkdirSync(d, { recursive: true });
    this.mark('supervisorStart');

    const prep = await this.pg.prepare();
    this.fallback = prep.fallback;
    const stale = await this.pg.recoverStale();
    this.staleRecovery = stale;
    if (stale !== 'clean') log.warn(`postgres: recovery on boot: ${stale}`);

    const ui = await ensurePort(this.state, 'uiPort');
    const pgp = await ensurePort(this.state, 'pgPort');
    if (ui.changedFrom) log.warn(`ui port ${ui.changedFrom} is taken; moved to ${ui.port}. The web origin changed, so the window will need to sign in again.`);
    if (pgp.changedFrom) log.warn(`postgres port ${pgp.changedFrom} is taken; moved to ${pgp.port}`);
    this.uiPort = ui.port;

    const secrets = state.read(L.secrets);
    if (!secrets.pgPassword) {
      secrets.pgPassword = crypto.randomBytes(24).toString('hex');
      state.write(L.secrets, secrets, 0o600);
    }
    this.pg.password = secrets.pgPassword;

    if (!this.pg.initialized()) {
      this.mark('initdbStart');
      await this.pg.initdb(secrets.pgPassword);
      this.mark('initdbDone');
    }
    await this.pg.start(pgp.port);
    await this.pg.ensureDatabase('yomi');
    this.mark('postgresReady');

    this.state.mainPid = process.pid;
    this.state.version = this.o.version;
    this.state.pgBinDir = this.pg.binDir;
    this.state.pgdata = this.pg.pgdata;
    state.write(L.state, this.state);

    this.watchPostgres();
    this.forkBff();
    await this.waitHealthy();
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
      version: this.o.version,
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
    child.once('exit', (code) => {
      out.end();
      this.log[this.stopping ? 'info' : 'warn'](`bff: exited with ${code}`);
      this.emit('bff-exit', code);
      if (this.bff === child) this.bff = null;
      if (!this.stopping) this.restartBff();
    });
    this.bff = child;
  }

  /** Backoff 1 s .. 30 s; five crashes inside two minutes is a bug, not a blip -- stop and say so. */
  restartBff() {
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
    setTimeout(() => { if (!this.stopping) this.forkBff(); }, delay);
  }

  /** Postgres dying under us: stop the bff, restart postgres, restart the bff. */
  watchPostgres() {
    this.pgWatch = setInterval(async () => {
      if (this.stopping || this.pgRecovering) return;
      if (this.pg.running()) return;
      this.pgRecovering = true;
      this.log.error('postgres: the server is gone; restarting it');
      try {
        if (this.bff) { this.bff.kill(); await sleep(500); }
        await this.pg.recoverStale();
        await this.pg.start(this.pg.port);
        if (!this.bff && !this.stopping) this.forkBff();
      } catch (e) {
        this.log.error('postgres: restart failed', { error: String(e) });
        this.emit('fatal', e);
      } finally {
        this.pgRecovering = false;
      }
    }, 10_000);
  }

  /** @returns {Promise<void>} */
  async waitHealthy(timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    let live = false;
    let last = '';
    while (Date.now() < deadline) {
      if (!this.bff && this.crashes.length) throw new Error('the bff exited during startup; see logs/bff.log');
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
    throw new Error(`the bff did not become healthy within ${timeoutMs} ms (${last})`);
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
      const res = { reason, bff: 'not-running', postgres: 'not-running', ms: 0 };
      const child = this.bff;
      if (child) {
        const exited = new Promise((r) => child.once('exit', (code) => r(code)));
        child.postMessage('shutdown');
        const code = await Promise.race([exited, sleep(25_000).then(() => 'timeout')]);
        if (code === 'timeout') {
          this.log.warn('bff: did not stop within 25 s; killing it');
          child.kill();
          await Promise.race([exited, sleep(5000)]);
          res.bff = 'killed';
        } else {
          res.bff = `exited:${code}`;
        }
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
        state.write(this.L.state, this.state);
      }
      res.ms = Date.now() - t0;
      this.log.info('supervisor: stopped', res);
      return res;
    })();
    return this.stopping;
  }
}

module.exports = { Supervisor };
