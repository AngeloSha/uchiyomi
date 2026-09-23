// @ts-check
'use strict';
/**
 * The bundled PostgreSQL 16: initdb, start, stop, and the recoveries a desktop needs that a container never did.
 *
 * Ported from bff/docker-entrypoint.sh (initdb/pg_ctl/version check), with three differences forced by the
 * desktop:
 *   - TCP on 127.0.0.1 with a scram password, not a unix socket: Windows has no socket dir to hide behind,
 *     and the password travels in PGPASSWORD (env), never on a command line.
 *   - `pg_ctl`/`initdb` always, never `postgres` directly: on Windows they drop an administrator's rights to a
 *     restricted token themselves, and postgres.exe refuses to run as an administrator.
 *   - Windows cannot run initdb from a path with characters outside the ANSI code page (PostgreSQL BUG #16926;
 *     not expected to be fixed). A per-user install lives under the user profile, so a user called "Jösé 名前"
 *     hits it on first launch. The fallback copies pg/ and puts the cluster under an ASCII directory in
 *     %ProgramData%, locked down to this user.
 *
 * Every server setting lives in `uchiyomi.conf` (included from postgresql.conf and rewritten before each start),
 * not in `pg_ctl -o`: pg_ctl hands -o to `/bin/sh -c` on POSIX and to `cmd /C` on Windows, and the two quote
 * `unix_socket_directories=''` differently. A file has one syntax.
 */
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAJOR = '16';
const WIN = process.platform === 'win32';

const exe = (name) => (WIN ? `${name}.exe` : name);
// Windows' own tools by absolute path: a PATH that puts Git's usr/bin first (any shell-launched start) resolves
// `whoami` to the Unix one, which ignores /user and silently skipped the ACL lock-down in CI run 2.
const sys32 = (name) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', `${name}.exe`);
const nonAscii = (s) => /[^\x20-\x7e]/.test(s);

/**
 * Run a PostgreSQL tool and collect its output.
 *
 * ⚠️ Resolves on 'exit', not 'close'. `pg_ctl start` on Windows leaves postgres.exe holding inherited copies of
 * our pipe handles, so 'close' would wait for the SERVER to exit. windowsHide so no console window flashes up
 * for every call from a GUI process.
 * @returns {Promise<{ code: number | null, signal: string | null, out: string, ms: number }>}
 */
function run(cmd, args, { env, timeoutMs = 60_000, cwd } = /** @type {any} */ ({})) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    let out = '';
    const child = spawn(cmd, args, { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const add = (b) => { if (out.length < 64_000) out += b.toString(); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => { out += `\n[timeout after ${timeoutMs} ms]`; child.kill(); }, timeoutMs);
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      // let the last buffered chunk land
      setImmediate(() => resolve({ code, signal, out: out.trim(), ms: Date.now() - t0 }));
    });
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {any} */ (e).code === 'EPERM';
  }
}

/**
 * Is `pid` a postgres process? true / false / null (could not tell -- treat as "maybe", never delete a lock on it).
 * @returns {Promise<boolean | null>}
 */
async function isPostgresPid(pid) {
  try {
    if (WIN) {
      const r = await run(sys32('tasklist'), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeoutMs: 15_000 });
      if (r.code !== 0) return null;
      if (/No tasks|INFO:/i.test(r.out) || !r.out.trim()) return false;
      return /^"postgres\.exe"/im.test(r.out);
    }
    const r = await run('ps', ['-p', String(pid), '-o', 'comm='], { timeoutMs: 15_000 });
    if (r.code !== 0) return r.out.trim() === '' ? false : null;
    return path.basename(r.out.trim()) === 'postgres';
  } catch {
    return null;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

class Postgres {
  /**
   * @param {{
   *   distDir: string,          // the bundled pg/ (bin, lib, share)
   *   pgdata: string,           // where the cluster lives when no fallback is needed
   *   logFile: string,
   *   tmpDir: string,
   *   log: { info: Function, warn: Function, error: Function },
   *   asciiFallback?: boolean,  // default true; CI turns it off once to prove the bug is real
   * }} o
   */
  constructor(o) {
    this.o = o;
    this.log = o.log;
    this.distDir = o.distDir;
    this.pgdata = o.pgdata;
    this.logFile = o.logFile;
    this.tmpDir = o.tmpDir;
    this.fallback = null; // { base, reason } when the Windows ASCII fallback is in use
    this.port = 0;
    this.password = '';
  }

  get binDir() { return path.join(this.distDir, 'bin'); }
  bin(name) { return path.join(this.binDir, exe(name)); }

  /** The bundled major version, stamped by scripts/pg-dist.mjs. */
  bundledMajor() {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(this.distDir, 'PG_BUNDLE.json'), 'utf8'));
      return String(j.major || MAJOR);
    } catch {
      return MAJOR;
    }
  }

  /**
   * Decide where the binaries and the cluster actually live. Idempotent; call once before anything else.
   * @param {{ pgdataHint?: string }} [_]
   */
  async prepare() {
    const reasons = [];
    if (nonAscii(this.distDir)) reasons.push(`binaries: ${this.distDir}`);
    if (nonAscii(this.pgdata)) reasons.push(`data: ${this.pgdata}`);
    if (nonAscii(this.tmpDir)) reasons.push(`temp: ${this.tmpDir}`);
    if (nonAscii(this.logFile)) reasons.push(`log: ${this.logFile}`);
    if (!WIN || !reasons.length) return { fallback: null };
    if (this.o.asciiFallback === false) {
      this.log.warn('postgres: non-ASCII paths and the ASCII fallback is DISABLED (test mode)', { reasons });
      return { fallback: null, disabled: true, reasons };
    }
    const programData = process.env.ProgramData || process.env.PROGRAMDATA || 'C:\\ProgramData';
    const key = crypto.createHash('sha256').update(this.pgdata.toLowerCase()).digest('hex').slice(0, 12);
    const base = path.join(programData, 'Uchiyomi', key);
    if (nonAscii(base)) throw new Error(`the ASCII fallback directory is itself non-ASCII: ${base}`);
    fs.mkdirSync(base, { recursive: true });
    await this.lockDown(base);

    // Binaries: a copy, refreshed when the bundle changes (an app update ships new ones).
    const stamp = fs.readFileSync(path.join(this.distDir, 'PG_BUNDLE.json'), 'utf8');
    const copy = path.join(base, 'pg');
    let copied = false;
    let current = '';
    try { current = fs.readFileSync(path.join(copy, 'PG_BUNDLE.json'), 'utf8'); } catch { /* none yet */ }
    if (current !== stamp) {
      const t0 = Date.now();
      fs.rmSync(copy, { recursive: true, force: true });
      fs.cpSync(this.distDir, copy, { recursive: true });
      copied = true;
      this.log.info(`postgres: copied binaries to the ASCII fallback in ${Date.now() - t0} ms`, { copy });
    }
    this.distDir = copy;
    this.pgdata = path.join(base, 'pg16');
    this.tmpDir = path.join(base, 'tmp');
    this.logFile = path.join(base, 'postgres.log');
    fs.mkdirSync(this.tmpDir, { recursive: true });
    this.fallback = { base, reasons, copied };
    this.log.warn('postgres: using the ASCII fallback (PostgreSQL BUG #16926)', this.fallback);
    return { fallback: this.fallback };
  }

  /**
   * %ProgramData% children inherit "Users: read & execute". The cluster is this user's alone, so replace the
   * inherited ACL: this user, SYSTEM and Administrators only. pg_ctl's restricted token keeps the user SID
   * enabled, so postgres still gets in.
   */
  async lockDown(dir) {
    if (!WIN) return;
    try {
      const who = await run(sys32('whoami'), ['/user', '/fo', 'csv', '/nh'], { timeoutMs: 15_000 });
      const sid = (who.out.match(/"(S-1-[0-9-]+)"/) || [])[1];
      if (!sid) throw new Error(`no SID in: ${who.out}`);
      const r = await run(sys32('icacls'), [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], { timeoutMs: 30_000 });
      if (r.code !== 0) throw new Error(r.out);
      this.log.info('postgres: fallback dir restricted to this user', { dir, sid });
    } catch (e) {
      this.log.warn('postgres: could not restrict the fallback dir (continuing)', { error: String(e) });
    }
  }

  env(extra = {}) {
    /** @type {Record<string,string>} */
    const e = {};
    for (const [k, v] of Object.entries(process.env)) {
      // Never let the user's own libpq settings (PGHOST, PGPORT, PGPASSFILE, PGDATA...) steer our tools.
      if (/^PG/i.test(k) || v === undefined) continue;
      e[k] = v;
    }
    if (this.fallback) { e.TEMP = this.tmpDir; e.TMP = this.tmpDir; }
    // Linux is dev-only: a source build without rpath.
    if (process.platform === 'linux') e.LD_LIBRARY_PATH = path.join(this.distDir, 'lib');
    e.LC_MESSAGES = 'C';
    return { ...e, ...extra };
  }

  clientEnv() {
    return this.env({ PGPASSWORD: this.password, PGCONNECT_TIMEOUT: '5' });
  }

  initialized() {
    return fs.existsSync(path.join(this.pgdata, 'PG_VERSION'));
  }

  checkVersion() {
    const f = path.join(this.pgdata, 'PG_VERSION');
    if (!fs.existsSync(f)) return;
    const have = fs.readFileSync(f, 'utf8').trim();
    const want = this.bundledMajor();
    if (have !== want) {
      const err = new Error(`This library's database is PostgreSQL ${have}; this version of Uchiyomi ships PostgreSQL ${want}.`);
      /** @type {any} */ (err).code = 'PG_MAJOR_MISMATCH';
      throw err;
    }
  }

  /** @param {string} password */
  async initdb(password) {
    this.password = password;
    // A half-made cluster (a crash during a previous initdb) is set aside, never deleted.
    if (fs.existsSync(this.pgdata) && !this.initialized() && fs.readdirSync(this.pgdata).length) {
      const aside = `${this.pgdata}.broken-${Date.now()}`;
      fs.renameSync(this.pgdata, aside);
      this.log.warn('postgres: set aside a partial cluster', { aside });
    }
    fs.mkdirSync(path.dirname(this.pgdata), { recursive: true });
    fs.mkdirSync(this.tmpDir, { recursive: true });
    const pwfile = path.join(this.tmpDir, `pw-${crypto.randomBytes(6).toString('hex')}.txt`);
    fs.writeFileSync(pwfile, password + '\n', { mode: 0o600 });
    let r;
    try {
      r = await run(this.bin('initdb'), [
        '-D', this.pgdata, '-U', 'yomi', '-E', 'UTF8', '--locale=C',
        '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', `--pwfile=${pwfile}`, '--no-instructions',
      ], { env: this.env(), timeoutMs: 180_000 });
    } finally {
      fs.rmSync(pwfile, { force: true });
    }
    if (r.code !== 0) {
      const err = new Error(`initdb failed (exit ${r.code}): ${r.out.slice(-2000)}`);
      /** @type {any} */ (err).code = 'PG_INITDB_FAILED';
      throw err;
    }
    this.log.info(`postgres: initdb ok in ${r.ms} ms`, { pgdata: this.pgdata });
    // Loopback only, password always. Nothing else may connect, and nothing connects without the secret.
    fs.writeFileSync(path.join(this.pgdata, 'pg_hba.conf'), [
      '# Written by Uchiyomi Desktop. Loopback only, scram password always.',
      'host all all 127.0.0.1/32 scram-sha-256',
      'host all all ::1/128 scram-sha-256',
      '',
    ].join('\n'));
    fs.appendFileSync(path.join(this.pgdata, 'postgresql.conf'), "\n# Uchiyomi Desktop\ninclude_if_exists = 'uchiyomi.conf'\n");
    return { ms: r.ms };
  }

  writeConf(port) {
    fs.writeFileSync(path.join(this.pgdata, 'uchiyomi.conf'), [
      '# Rewritten by Uchiyomi Desktop before every start; edits here are lost.',
      "listen_addresses = '127.0.0.1'",
      `port = ${port}`,
      "unix_socket_directories = ''",
      'max_connections = 30',
      'shared_buffers = 128MB',
      'wal_level = minimal',
      'max_wal_senders = 0',
      'log_min_messages = warning',
      "lc_messages = 'C'",
      '',
    ].join('\n'));
  }

  pidFromFile() {
    try {
      const pid = parseInt(fs.readFileSync(path.join(this.pgdata, 'postmaster.pid'), 'utf8').split(/\r?\n/)[0], 10);
      return Number.isFinite(pid) && pid > 0 ? pid : 0;
    } catch {
      return 0;
    }
  }

  running() {
    const pid = this.pidFromFile();
    return pid > 0 && isAlive(pid);
  }

  /**
   * A postmaster.pid left behind by a previous life.
   *   - its postgres is still alive: an orphan from a crashed shell (on Windows pg_ctl's children outlive us).
   *     Stop it through pg_ctl -- the clean way, WAL flushed -- rather than killing it.
   *   - its pid is dead, or now belongs to something that is not postgres: a stale lock. Remove it.
   *   - cannot tell: leave it; postgres will refuse with a clear message rather than risk two postmasters on
   *     one data directory, which is the one outcome worse than not starting.
   * @returns {Promise<string>}
   */
  async recoverStale() {
    const pidFile = path.join(this.pgdata, 'postmaster.pid');
    if (!fs.existsSync(pidFile)) return 'clean';
    const pid = this.pidFromFile();
    const alive = pid > 0 && isAlive(pid);
    const isPg = alive ? await isPostgresPid(pid) : false;
    if (alive && isPg) {
      this.log.warn('postgres: an orphaned server from a previous run is still up; stopping it', { pid });
      const r = await this.stop({ reason: 'orphan' });
      return `orphan-stopped:${r}`;
    }
    if (alive && isPg === null) {
      this.log.warn('postgres: postmaster.pid names a live process we cannot identify; leaving the lock', { pid });
      return 'unknown-left';
    }
    fs.rmSync(pidFile, { force: true });
    this.log.warn('postgres: removed a stale postmaster.pid', { pid, alive, isPg });
    return `stale-removed:${pid}:${alive ? 'reused' : 'dead'}`;
  }

  /** @param {number} port */
  async start(port) {
    this.checkVersion();
    this.port = port;
    this.writeConf(port);
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    const r = await run(this.bin('pg_ctl'), ['-D', this.pgdata, '-w', '-t', '60', '-l', this.logFile, 'start'], { env: this.env(), timeoutMs: 90_000 });
    if (r.code !== 0) {
      let tail = '';
      try { tail = fs.readFileSync(this.logFile, 'utf8').slice(-2000); } catch { /* no log */ }
      const err = new Error(`pg_ctl start failed (exit ${r.code}): ${r.out}\n--- postgres.log ---\n${tail}`);
      /** @type {any} */ (err).code = 'PG_START_FAILED';
      throw err;
    }
    await this.query('SELECT 1', 'postgres');
    this.log.info(`postgres: started on 127.0.0.1:${port} in ${r.ms} ms`, { pid: this.pidFromFile() });
    return { ms: r.ms, pid: this.pidFromFile() };
  }

  /**
   * @param {string} sql
   * @param {string} [db]
   */
  async query(sql, db = 'yomi') {
    const r = await run(this.bin('psql'), ['-h', '127.0.0.1', '-p', String(this.port), '-U', 'yomi', '-d', db, '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql], { env: this.clientEnv(), timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(`psql failed (exit ${r.code}): ${r.out}`);
    return r.out;
  }

  async ensureDatabase(name = 'yomi') {
    const have = await this.query(`SELECT 1 FROM pg_database WHERE datname = '${name}'`, 'postgres');
    if (have.trim() === '1') return false;
    await this.query(`CREATE DATABASE ${name}`, 'postgres');
    this.log.info(`postgres: created database ${name}`);
    return true;
  }

  /**
   * Fast shutdown (rolls back open transactions, flushes WAL), then immediate, then a kill.
   * @returns {Promise<string>}
   */
  async stop({ reason = 'stop' } = {}) {
    if (!this.running()) return 'not-running';
    const pid = this.pidFromFile();
    const fast = await run(this.bin('pg_ctl'), ['-D', this.pgdata, '-m', 'fast', '-w', '-t', '30', 'stop'], { env: this.env(), timeoutMs: 45_000 });
    if (fast.code === 0) {
      this.log.info(`postgres: stopped (fast, ${reason}) in ${fast.ms} ms`, { pid });
      return 'fast';
    }
    this.log.warn('postgres: fast stop failed, trying immediate', { out: fast.out });
    const imm = await run(this.bin('pg_ctl'), ['-D', this.pgdata, '-m', 'immediate', '-w', '-t', '15', 'stop'], { env: this.env(), timeoutMs: 30_000 });
    if (imm.code === 0) return 'immediate';
    if (pid && isAlive(pid)) {
      try { process.kill(pid); } catch { /* gone */ }
      await sleep(1000);
    }
    return 'killed';
  }

  /**
   * A plain-SQL dump with the bundled pg_dump, piped to a file the way bff/src/lib/backup.ts does it (stdout,
   * never `-f`): the output path is then opened by Node, which handles any Unicode path, instead of by
   * pg_dump, which on Windows opens files through the ANSI code page.
   * @param {string} file
   * @returns {Promise<{ ms: number, bytes: number }>}
   */
  dump(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(file);
      const child = spawn(this.bin('pg_dump'), ['-h', '127.0.0.1', '-p', String(this.port), '-U', 'yomi', '-d', 'yomi', '--no-owner', '--no-acl'], { env: this.clientEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      let code = /** @type {number | null} */ (null);
      let closed = false;
      const settle = () => {
        if (code === null || !closed) return;
        if (code !== 0) reject(new Error(`pg_dump failed (exit ${code}): ${err.slice(0, 1000)}`));
        else resolve({ ms: Date.now() - t0, bytes: fs.statSync(file).size });
      };
      child.stderr.on('data', (d) => { err += String(d); });
      child.once('error', reject);
      out.once('error', reject);
      child.once('exit', (c) => { code = c ?? -1; settle(); });
      out.once('close', () => { closed = true; settle(); });
      child.stdout.pipe(out);
    });
  }
}

module.exports = { Postgres, run, isAlive, isPostgresPid, nonAscii, MAJOR, exe };
