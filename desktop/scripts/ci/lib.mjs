// Shared helpers for the spike's CI checks. Every check ends in record(): one line `RESULT <id> <VERDICT> ...`
// on stdout and one JSON line in ci-out/results.jsonl, which summary.mjs turns into the job summary.
//   PASS / FAIL  the check's pass condition, with the number that decided it
//   EXPECTED     a failure the check set out to reproduce (e.g. initdb under a non-ASCII path, fallback off)
//   INFO         a measurement or observation with no pass condition of its own
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, openSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import os from 'node:os';

export const WIN = process.platform === 'win32';
export const MAC = process.platform === 'darwin';
export const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO = resolve(DESKTOP, '..');
export const OUT = join(DESKTOP, 'ci-out');
mkdirSync(OUT, { recursive: true });
export const OS_TAG = `${process.platform}-${process.arch}`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Linux is only a local dev target (no setuid chrome-sandbox in a scratch checkout).
export const APP_EXTRA = [...(process.platform === 'linux' ? ['--no-sandbox'] : []), ...(process.env.APP_EXTRA_ARGS ? process.env.APP_EXTRA_ARGS.split(' ') : [])];

export function record(id, verdict, summary, evidence = {}) {
  const row = { id, verdict, summary, os: OS_TAG, t: new Date().toISOString(), evidence };
  appendFileSync(join(OUT, 'results.jsonl'), JSON.stringify(row) + '\n');
  console.log(`RESULT ${id} ${verdict} [${OS_TAG}] ${summary}`);
  return row;
}

/** The unpacked app's executable (electron-builder --dir output). */
export function appExe(dist = join(DESKTOP, 'dist')) {
  if (WIN) return join(dist, 'win-unpacked', 'Uchiyomi.exe');
  if (MAC) {
    const d = readdirSync(dist).find((x) => /^mac/.test(x) && existsSync(join(dist, x, 'Uchiyomi.app')));
    if (!d) throw new Error(`no mac*/Uchiyomi.app under ${dist}`);
    return join(dist, d, 'Uchiyomi.app', 'Contents', 'MacOS', 'Uchiyomi');
  }
  return join(dist, 'linux-unpacked', 'uchiyomi-desktop');
}

/** Electron from node_modules, for ELECTRON_RUN_AS_NODE (the packaged app has the runAsNode fuse off). */
export function devElectron() {
  // require('electron') downloads the binary on first use and says so on STDOUT ("Downloading Electron
  // binary..."), so the path is the last line, not the whole output.
  const out = execFileSync(process.execPath, ['-e', "process.stdout.write('\\n' + require('electron'))"], { cwd: DESKTOP, encoding: 'utf8' });
  return out.trim().split(/\r?\n/).pop().trim();
}

/** Run to completion. @returns {{code:number|null, out:string, ms:number}} */
export function runSync(cmd, args, opts = {}) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15 * 60_000, maxBuffer: 256 << 20, ...opts });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}${r.error ? String(r.error) : ''}`, ms: Date.now() - t0 };
}

/**
 * Run to completion WITHOUT blocking the event loop. Use this whenever a process we launched earlier may exit
 * meanwhile: spawnSync blocks libuv, so an exited child of ours stays an unreaped zombie, and kill(pid, 0) --
 * which is how --quit-for-update decides the old instance is gone -- keeps answering "alive" until we return.
 */
export function runAsync(cmd, args, { timeoutMs = 15 * 60_000, env, cwd } = {}) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let out = '';
    const c = spawn(cmd, args, { env: env || process.env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    c.stdout.on('data', (b) => { if (out.length < 1e6) out += b; });
    c.stderr.on('data', (b) => { if (out.length < 1e6) out += b; });
    const t = setTimeout(() => c.kill(), timeoutMs);
    c.on('error', (e) => { clearTimeout(t); resolve({ code: null, out: out + String(e), ms: Date.now() - t0 }); });
    c.on('exit', (code) => { clearTimeout(t); resolve({ code, out, ms: Date.now() - t0 }); });
  });
}

/** Start a long-running process with its output in a log file. */
export function launch(cmd, args, { env, log, cwd } = {}) {
  const fd = openSync(log || join(OUT, 'launch.log'), 'a');
  const child = spawn(cmd, args, { env: env || process.env, cwd, stdio: ['ignore', fd, fd], detached: !WIN, windowsHide: false });
  child.on('error', (e) => console.error(`launch ${cmd}: ${e}`));
  return child;
}

export async function waitFor(fn, { timeoutMs = 120_000, intervalMs = 250, what = 'condition' } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what} (last: ${String(last).slice(0, 300)})`);
}

export function readJson(file, def = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return def; }
}

/** Wait until the app under `root` answers /healthz; returns the ui port. */
export async function waitHealthy(root, timeoutMs = 180_000) {
  return waitFor(async () => {
    const s = readJson(join(root, 'state.json'));
    if (!s?.uiPort || !s?.mainPid) return null;
    const r = await fetch(`http://127.0.0.1:${s.uiPort}/healthz`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? s.uiPort : null;
  }, { timeoutMs, what: `healthz under ${root}` });
}

export async function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

/**
 * Every process with its resident memory and command line.
 * @returns {Promise<Array<{pid:number, ppid:number, name:string, rssKB:number, cmd:string}>>}
 */
export function processes() {
  if (WIN) {
    const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,CommandLine | ConvertTo-Json -Compress';
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', maxBuffer: 64 << 20 });
    return JSON.parse(out).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name || '', rssKB: Math.round((p.WorkingSetSize || 0) / 1024), cmd: p.CommandLine || '' }));
  }
  const out = execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,rss=,args='], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return out.split('\n').filter(Boolean).map((l) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    if (!m) return null;
    const exe = /^(.*?)(?:\s--|$)/.exec(m[4])?.[1] || m[4];
    return { pid: +m[1], ppid: +m[2], rssKB: +m[3], name: exe.split('/').pop(), cmd: m[4] };
  }).filter(Boolean);
}

/** Electron marks each child with --type=; the bff's utility process carries its service name. */
export function roleOf(p) {
  const t = /--type=([a-z-]+)/.exec(p.cmd)?.[1];
  if (!t) return 'main';
  if (t === 'renderer') return 'renderer';
  if (t === 'gpu-process') return 'gpu';
  if (t === 'utility') {
    if (/network\.mojom\.NetworkService/i.test(p.cmd)) return 'utility-network';
    if (/node\.mojom\.NodeService/i.test(p.cmd)) return 'utility-node(bff)';
    if (/storage\.mojom|audio\.mojom|video_capture|data_decoder/i.test(p.cmd)) return 'utility-other';
    return 'utility-other';
  }
  if (t === 'crashpad-handler') return 'crashpad';
  return t;
}

/**
 * The app under `root`, as the OS sees it right now: its main process and every descendant, plus the postmaster
 * named in postmaster.pid and every descendant of that (postgres is NOT our descendant: pg_ctl exits and leaves
 * it reparented).
 */
export function snapshot(root) {
  const st = readJson(join(root, 'state.json')) || {};
  const all = processes();
  const desc = (pid) => {
    const s = new Set([pid]);
    for (let grew = true; grew;) { grew = false; for (const p of all) if (s.has(p.ppid) && !s.has(p.pid) && p.pid !== p.ppid) { s.add(p.pid); grew = true; } }
    return s;
  };
  const app = st.mainPid ? desc(st.mainPid) : new Set();
  let pgPid = 0;
  try { pgPid = Number(readFileSync(join(st.pgdata, 'postmaster.pid'), 'utf8').split(/\r?\n/)[0]) || 0; } catch { /* not running */ }
  const pg = pgPid ? desc(pgPid) : new Set();
  const list = all.filter((p) => app.has(p.pid) || pg.has(p.pid)).map((p) => ({ ...p, role: pg.has(p.pid) ? 'postgres' : roleOf(p) }));
  return { mainPid: st.mainPid || 0, pgPid, pgdata: st.pgdata, list, appPids: [...app].filter((x) => all.some((p) => p.pid === x)), pgPids: [...pg].filter((x) => all.some((p) => p.pid === x)) };
}

export function rssTable(roles) {
  const by = {};
  for (const r of roles) {
    by[r.role] = by[r.role] || { count: 0, rssMB: 0 };
    by[r.role].count++;
    by[r.role].rssMB += r.rssKB / 1024;
  }
  for (const k of Object.keys(by)) by[k].rssMB = Math.round(by[k].rssMB);
  const total = Math.round(roles.reduce((a, r) => a + r.rssKB, 0) / 1024);
  return { byRole: by, totalMB: total };
}

/** Hard-kill processes (the "power cord" test): taskkill /F on Windows, SIGKILL elsewhere. */
export function hardKill(pids) {
  for (const pid of pids) {
    try {
      if (WIN) execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
      else process.kill(pid, 'SIGKILL');
    } catch { /* already gone */ }
  }
}

export function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** A fresh data dir for one check. */
export function tmpRoot(name) {
  const base = process.env.RUNNER_TEMP || os.tmpdir();
  return join(base, `uchi-${name}-${Date.now().toString(36)}`);
}

/** Run the packaged app in --smoke mode against a data dir; returns its result JSON (or an error row). */
export function smoke(exe, root, extra = [], { timeoutMs = 6 * 60_000 } = {}) {
  const result = join(root + '-smoke.json');
  const r = runSync(exe, [...APP_EXTRA, '--smoke', `--data-dir=${root}`, `--result=${result}`, ...extra], { timeout: timeoutMs, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' } });
  const j = readJson(result);
  return { exit: r.code, ms: r.ms, result: j, out: r.out.slice(-4000) };
}

/** A compact, JSON-safe digest of a smoke result. */
export function smokeDigest(s) {
  const c = s.result?.checks || {};
  return {
    exit: s.exit, ok: !!s.result?.ok, ms: s.ms,
    healthz: c.healthz?.status, setup: c.setupStatus?.body, account: c.account?.how,
    bffBackup: c.bffBackup ? { pass: c.bffBackup.pass, files: c.bffBackup.files, tables: c.bffBackup.tables, error: c.bffBackup.error || c.bffBackup.task?.lastResult?.error } : null,
    shellDump: c.shellDump ? { bytes: c.shellDump.bytes, usersTable: c.shellDump.hasUsersTable, tables: c.shellDump.tables } : null,
    listen: c.listen ? { exposedBeyondLoopback: c.listen.exposedBeyondLoopback } : null,
    stop: s.result?.stop, fallback: s.result?.fallback, staleRecovery: s.result?.staleRecovery,
    timeline: s.result?.timeline, error: s.result?.error?.slice(0, 1500) || (s.result ? undefined : s.out.slice(-1500)),
  };
}
