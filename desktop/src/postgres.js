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
const { spawn, spawnSync } = require('node:child_process');
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

/*
 * The private ASCII folder Windows falls back to when the data root has characters outside the ANSI code page,
 * shared by the database (PostgreSQL BUG #16926) and the extension engine's runtime + temp folder (java.exe
 * cannot start from such a path, and JNA cannot load its DLL from one -- spike S7).
 *
 * ⚠️ It lives in %ProgramData%, which every local account can WRITE to (Users may create folders there), and
 * it holds binaries this user runs and a database with tracker tokens in it. So it FAILS CLOSED and NEVER ADOPTS
 * A FOLDER IT DID NOT MAKE. Until v0.44.0's review it was `%ProgramData%\Uchiyomi\<sha256 of the pgdata path>`:
 * a predictable name, created with mkdir -p (which quietly accepts a folder someone else made first), and a
 * failed icacls only logged "continuing". A second account on a shared PC could create that folder first, keep
 * an ACE for itself (icacls /grant:r replaces only the SIDs it names), and plant pg/bin/*.exe or a JRE for this
 * user to run. Now:
 *   - the name is random (`Uchiyomi-<16 hex>`, directly under %ProgramData%, so no shared parent can be owned
 *     by someone else) and recorded in state.json, which lives in the user's own profile;
 *   - it is created with a NON-recursive mkdir: EEXIST is a refusal, not a welcome;
 *   - it is locked to this user, SYSTEM and Administrators, the ACL is READ BACK (owner included), and it must
 *     still be empty afterwards -- or the app refuses to start and says why;
 *   - on every later start the recorded folder's ACL is read back again before anything in it is run.
 * With only this user, SYSTEM and Administrators able to write there (and each of those can already run code
 * as this user), nothing can be planted; the binary copy is also swapped in whole and compared file by file
 * against the bundle on every start (Postgres.prepare), so a half-finished or altered copy is replaced.
 */

const FALLBACK_NAME = /^Uchiyomi-[0-9a-f]{16}$/;

function programDataDir() {
  return process.env.ProgramData || process.env.PROGRAMDATA || 'C:\\ProgramData';
}

/** A fresh, unguessable fallback folder name (not created). @param {string} [programData] */
function newFallbackName(programData = programDataDir()) {
  return path.join(programData, `Uchiyomi-${crypto.randomBytes(8).toString('hex')}`);
}

/**
 * Is `dir` a name this app would have made (what state.json may hold)? Anything else is ignored and a new one is
 * made: a hand-edited state.json must not be able to point the database at a folder someone else controls.
 * @param {unknown} dir @param {string} [programData]
 * @returns {dir is string}
 */
function isFallbackName(dir, programData = programDataDir()) {
  return typeof dir === 'string' && FALLBACK_NAME.test(path.basename(dir))
    && path.dirname(dir).toLowerCase() === programData.toLowerCase();
}

/** @param {string} message @param {string} code */
function coded(message, code) {
  const e = new Error(message);
  /** @type {any} */ (e).code = code;
  return e;
}

/** This process's user SID (Windows' own whoami, by absolute path -- see sys32). */
async function userSid() {
  const who = await run(sys32('whoami'), ['/user', '/fo', 'csv', '/nh'], { timeoutMs: 15_000 });
  const sid = (who.out.match(/"(S-1-[0-9-]+)"/) || [])[1];
  if (!sid) throw new Error(`no SID in: ${who.out}`);
  return sid;
}

/**
 * Does this security descriptor (SDDL, as Get-Acl's .Sddl prints it) keep a folder to `sid`, SYSTEM and
 * Administrators? Owner one of them, the DACL protected from inheritance, and no ALLOW entry for anybody else
 * (deny entries take nothing away from us). Anything it cannot read -- a null DACL, a conditional entry, an
 * unknown shape -- is a no: this decides whether binaries in the folder get run.
 * @param {string} sddl @param {string} sid
 * @returns {{ ok: boolean, why?: string }}
 */
function sddlPrivate(sddl, sid) {
  const s = String(sddl || '').trim();
  /** @type {Record<string, string>} */
  const alias = { SY: 'S-1-5-18', BA: 'S-1-5-32-544' };
  // The built-in Administrator account prints as LA rather than its SID.
  if (/-500$/.test(sid)) alias.LA = sid;
  const trusted = new Set([sid, 'S-1-5-18', 'S-1-5-32-544']);
  const who = (x) => alias[x] || x;
  // Split into O: G: D: S: at the top level (ACEs are in parentheses and hold no colons of their own).
  /** @type {Record<string, string>} */
  const part = {};
  let key = '';
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (depth === 0 && 'OGDS'.includes(c) && s[i + 1] === ':') { key = c; part[key] = ''; i++; continue; }
    if (depth < 0 || depth > 1) return { ok: false, why: `unreadable descriptor: ${s}` };
    if (key) part[key] += c;
  }
  if (!part.O || !trusted.has(who(part.O))) return { ok: false, why: `owned by ${part.O || 'nobody we can read'}` };
  if (part.D === undefined) return { ok: false, why: 'no DACL' };
  const flags = part.D.split('(')[0];
  if (/NO_ACCESS_CONTROL/.test(flags)) return { ok: false, why: 'a null DACL: everyone has full access' };
  if (!flags.includes('P')) return { ok: false, why: 'the folder still inherits permissions from %ProgramData%' };
  const aces = part.D.slice(flags.length).match(/\(([^()]*)\)/g) || [];
  if (part.D.slice(flags.length).replace(/\(([^()]*)\)/g, '') !== '') return { ok: false, why: `unreadable DACL: ${part.D}` };
  for (const a of aces) {
    const f = a.slice(1, -1).split(';');
    if (f.length < 6) return { ok: false, why: `unreadable entry ${a}` };
    if (f[0] === 'D' || f[0] === 'OD') continue;
    if (!trusted.has(who(f[5]))) return { ok: false, why: `${f[5]} has access (${a})` };
  }
  return { ok: true };
}

/**
 * Read `dir`'s ACL back and throw unless it is this user's alone (sddlPrivate). PowerShell's Get-Acl, because
 * icacls prints account NAMES, in the machine's language; the path travels in the environment, not the command.
 * @param {string} dir
 * @param {{ info: Function, warn: Function }} log
 */
async function verifyPrivate(dir, log) {
  const sid = await userSid();
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const r = await run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '(Get-Acl -LiteralPath $env:UCHIYOMI_ACL_DIR).Sddl'], { env: { ...process.env, UCHIYOMI_ACL_DIR: dir }, timeoutMs: 60_000 });
  const sddl = r.out.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^O:/.test(l)).pop() || '';
  const v = r.code === 0 && sddl ? sddlPrivate(sddl, sid) : { ok: false, why: `could not read its permissions (exit ${r.code}): ${r.out.slice(0, 500)}` };
  if (!v.ok) {
    throw coded(`Uchiyomi's private folder ${dir} is not private to you (${v.why}), so Uchiyomi will not run anything from it. `
      + 'Only you, SYSTEM and Administrators may have access to it.', 'FALLBACK_NOT_PRIVATE');
  }
  log.info('fallback dir is private to this user', { dir, sid, sddl });
}

/**
 * %ProgramData% children inherit "Users: read & execute" (and "create folders"). Replace the inherited ACL:
 * this user, SYSTEM and Administrators only. pg_ctl's restricted token keeps the user SID enabled, so postgres
 * still gets in. ⚠️ Throws: a folder that could not be locked is never used.
 * @param {string} dir
 * @param {{ info: Function, warn: Function }} log
 */
async function lockDown(dir, log) {
  if (!WIN) return;
  const sid = await userSid();
  const r = await run(sys32('icacls'), [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], { timeoutMs: 30_000 });
  if (r.code !== 0) throw coded(`could not restrict ${dir} to this user (icacls exit ${r.code}): ${r.out.slice(0, 500)}`, 'FALLBACK_LOCK_FAILED');
  log.info('fallback dir restricted to this user', { dir, sid });
}

/**
 * Make (or, when state.json recorded it, re-check) the private fallback folder. Throws rather than use a folder
 * that is not private, or one this app did not create.
 * @param {string} dir a name from newFallbackName() or state.json (isFallbackName)
 * @param {{
 *   recorded: boolean,
 *   log: { info: Function, warn: Function },
 *   lock?: (dir: string, log: any) => Promise<void>,
 *   verify?: (dir: string, log: any) => Promise<void>,
 * }} o lock/verify: tests only (the real ones need Windows)
 * @returns {Promise<{ dir: string, created: boolean }>}
 */
async function claimFallback(dir, o) {
  const lock = o.lock || lockDown;
  const verify = o.verify || verifyPrivate;
  if (o.recorded && fs.existsSync(dir)) {
    await verify(dir, o.log);
    return { dir, created: false };
  }
  if (o.recorded) o.log.warn('the private fallback folder in state.json is gone; making it again (a new, empty database)', { dir });
  try {
    // ⚠️ NEVER recursive: mkdir -p succeeds on a folder someone else made first, which is the attack.
    fs.mkdirSync(dir);
  } catch (e) {
    if (/** @type {any} */ (e).code === 'EEXIST') {
      throw coded(`${dir} already exists and Uchiyomi did not create it, so Uchiyomi will not use it. Open Uchiyomi again to use a new folder.`, 'FALLBACK_TAKEN');
    }
    throw e;
  }
  try {
    await lock(dir, o.log);
    await verify(dir, o.log);
    // Created empty a moment ago; anything in it now got in before the lock (%ProgramData%'s "Users: create
    // folders" is inherited until then).
    const found = fs.readdirSync(dir);
    if (found.length) throw coded(`something was put in ${dir} before Uchiyomi could lock it (${found.slice(0, 5).join(', ')}), so Uchiyomi will not use it.`, 'FALLBACK_TAMPERED');
  } catch (e) {
    // Empty: remove it so the next start makes a clean one. Not empty: never delete what someone else put there.
    try { fs.rmdirSync(dir); } catch { /* not empty, or already gone */ }
    throw e;
  }
  return { dir, created: true };
}

/**
 * Is the copy at `dst` the bundle at `src`, file for file (names and sizes)? A copy that differs -- a file
 * missing, an extra one (a DLL beside postgres.exe would be loaded first), or one of another size -- is
 * replaced, not trusted because its PG_BUNDLE.json stamp matches.
 * @param {string} src @param {string} dst
 */
function sameTree(src, dst) {
  try {
    const a = fs.readdirSync(src, { withFileTypes: true }).map((d) => d.name).sort();
    const b = fs.readdirSync(dst, { withFileTypes: true }).map((d) => d.name).sort();
    if (a.length !== b.length || a.some((n, i) => n !== b[i])) return false;
    for (const n of a) {
      const s = fs.lstatSync(path.join(src, n));
      const d = fs.lstatSync(path.join(dst, n));
      if (s.isDirectory() !== d.isDirectory() || d.isSymbolicLink()) return false;
      if (s.isDirectory() ? !sameTree(path.join(src, n), path.join(dst, n)) : s.size !== d.size) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The fallback's copy of the bundled binaries: replaced when the bundle changes (an app update ships new ones) or
 * when it is not the bundle file for file (sameTree). ⚠️ Built beside and swapped in whole: fs.cpSync copies
 * PG_BUNDLE.json FIRST (it sorts before bin/), so a copy cut short by a crash used to carry a matching stamp and
 * no postgres.exe -- and was trusted on every start after.
 * @param {string} src the bundled pg/ @param {string} copy <fallback>/pg
 * @param {{ info: Function }} log
 * @returns {{ copied: boolean }}
 */
function syncCopy(src, copy, log) {
  const stamp = fs.readFileSync(path.join(src, 'PG_BUNDLE.json'), 'utf8');
  let current = '';
  try { current = fs.readFileSync(path.join(copy, 'PG_BUNDLE.json'), 'utf8'); } catch { /* none yet */ }
  if (current === stamp && sameTree(src, copy)) return { copied: false };
  const t0 = Date.now();
  const part = `${copy}.partial-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.cpSync(src, part, { recursive: true });
    fs.rmSync(copy, { recursive: true, force: true });
    fs.renameSync(part, copy);
  } finally {
    fs.rmSync(part, { recursive: true, force: true });
  }
  log.info(`postgres: copied binaries to the ASCII fallback in ${Date.now() - t0} ms`, { copy, stampChanged: current !== stamp });
  return { copied: true };
}

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

  /** Which of our paths Windows' initdb cannot use (empty = no fallback needed). */
  fallbackReasons() {
    const reasons = [];
    if (nonAscii(this.distDir)) reasons.push(`binaries: ${this.distDir}`);
    if (nonAscii(this.pgdata)) reasons.push(`data: ${this.pgdata}`);
    if (nonAscii(this.tmpDir)) reasons.push(`temp: ${this.tmpDir}`);
    if (nonAscii(this.logFile)) reasons.push(`log: ${this.logFile}`);
    return reasons;
  }

  /**
   * Decide where the binaries and the cluster actually live. Idempotent; call once before anything else.
   * @param {{ base?: string | null }} [o] base: the private fallback folder the supervisor has already claimed
   *   (claimFallback) -- made, locked and verified, or re-verified. Never created or chosen here.
   */
  async prepare({ base = null } = {}) {
    const reasons = this.fallbackReasons();
    if (!WIN || !reasons.length) return { fallback: null };
    if (this.o.asciiFallback === false) {
      this.log.warn('postgres: non-ASCII paths and the ASCII fallback is DISABLED (test mode)', { reasons });
      return { fallback: null, disabled: true, reasons };
    }
    // Fail closed: without a claimed private folder there is nowhere safe to put the cluster.
    if (!base) throw coded('postgres needs its private ASCII folder, and none was claimed', 'FALLBACK_MISSING');
    if (nonAscii(base)) throw new Error(`the ASCII fallback directory is itself non-ASCII: ${base}`);

    const copy = path.join(base, 'pg');
    const { copied } = syncCopy(this.distDir, copy, this.log);
    this.distDir = copy;
    this.pgdata = path.join(base, 'pg16');
    this.tmpDir = path.join(base, 'tmp');
    this.logFile = path.join(base, 'postgres.log');
    fs.mkdirSync(this.tmpDir, { recursive: true });
    this.fallback = { base, reasons, copied };
    this.log.warn('postgres: using the ASCII fallback (PostgreSQL BUG #16926)', this.fallback);
    return { fallback: this.fallback };
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
   * The last resort when Windows is ending the session under us (sessionend.js): a fast stop, SYNCHRONOUSLY,
   * because the event loop may never get another turn. 10 s cap -- Windows will not wait much longer.
   * @returns {string}
   */
  stopSync() {
    if (!this.running()) return 'not-running';
    const r = spawnSync(this.bin('pg_ctl'), ['-D', this.pgdata, '-m', 'fast', '-w', '-t', '10', 'stop'], { env: this.env(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 12_000 });
    return r.status === 0 ? 'fast' : `failed:${r.status ?? r.signal ?? r.error}`;
  }

  /**
   * Replay a plain-SQL dump (`db.sql.gz`, as the bff's backup task writes it: pg_dump --clean --if-exists
   * --no-owner --no-acl) into the yomi database with the bundled psql, gunzipped on the way in.
   *
   * ⚠️ One transaction (`-1`) with ON_ERROR_STOP: a dump that fails half-way (a dump from a newer major, a
   * truncated file) rolls back to the database as it was, instead of leaving it half-dropped. The file is
   * opened by Node and fed on stdin, never passed to psql as a path: on Windows psql opens files through the
   * ANSI code page, and the backups folder lives under the user's profile.
   * @param {string} gzFile
   * @returns {Promise<{ ms: number }>}
   */
  restoreSqlGz(gzFile) {
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin('psql'), ['-h', '127.0.0.1', '-p', String(this.port), '-U', 'yomi', '-d', 'yomi', '-X', '-q', '-1', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { env: this.clientEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let err = '';
      const add = (d) => { if (err.length < 64_000) err += String(d); };
      child.stdout.on('data', add);
      child.stderr.on('data', add);
      child.stdin.on('error', () => { /* psql stopped reading (ON_ERROR_STOP); its exit code says why */ });
      child.once('error', reject);
      const src = fs.createReadStream(gzFile);
      const gunzip = require('node:zlib').createGunzip();
      const fail = (e) => { try { child.kill(); } catch { /* gone */ } reject(e); };
      src.once('error', fail);
      gunzip.once('error', (e) => fail(new Error(`${path.basename(gzFile)} is not a readable gzip file: ${e.message}`)));
      src.pipe(gunzip).pipe(child.stdin);
      child.once('exit', (code) => {
        if (code === 0) resolve({ ms: Date.now() - t0 });
        else reject(new Error(`psql failed (exit ${code}); the database was left as it was. ${err.trim().slice(-1500)}`));
      });
    });
  }

  /**
   * A plain-SQL dump with the bundled pg_dump, piped to a file the way bff/src/lib/backup.ts does it (stdout,
   * never `-f`): the output path is then opened by Node, which handles any Unicode path, instead of by
   * pg_dump, which on Windows opens files through the ANSI code page.
   * `clean` adds `--clean --if-exists`, as the bff's own backups have, so the file can be restored over a
   * database that already has the tables (the restore's safety copy).
   * @param {string} file
   * @param {{ clean?: boolean }} [o]
   * @returns {Promise<{ ms: number, bytes: number }>}
   */
  dump(file, { clean = false } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(file);
      const child = spawn(this.bin('pg_dump'), ['-h', '127.0.0.1', '-p', String(this.port), '-U', 'yomi', '-d', 'yomi', '--no-owner', '--no-acl', ...(clean ? ['--clean', '--if-exists'] : [])], { env: this.clientEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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

module.exports = {
  Postgres, run, isAlive, isPostgresPid, nonAscii, lockDown, MAJOR, exe,
  newFallbackName, isFallbackName, sddlPrivate, verifyPrivate, claimFallback, sameTree, syncCopy,
};
