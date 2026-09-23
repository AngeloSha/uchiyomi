// Launching the extension engine (Phase 2: desktop/src/engine.ts). Everything the shell needs: unpack a pack,
// build the command line, spawn hidden, wait for readiness, stop gracefully through the shim or kill.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { extractZip } from './archive.mjs';

const P = '-Dsuwayomi.tachidesk.config.server.';

/** Unpack an engine pack into runtimeDir (idempotent: re-extracts if engine.json is missing). */
export async function unpackPack(zip, runtimeDir) {
  const t0 = Date.now();
  await fsp.rm(runtimeDir, { recursive: true, force: true });
  await fsp.mkdir(runtimeDir, { recursive: true });
  const r = await extractZip(zip, runtimeDir);
  const meta = JSON.parse(await fsp.readFile(path.join(runtimeDir, 'engine.json'), 'utf8'));
  if (process.platform !== 'win32') {
    // Belt and braces: the pack records modes, but a pack re-zipped by another tool would not.
    await fsp.chmod(path.join(runtimeDir, 'jre', 'bin', 'java'), 0o755);
    const helper = path.join(runtimeDir, 'jre', 'lib', 'jspawnhelper');
    if (fs.existsSync(helper)) await fsp.chmod(helper, 0o755);
  }
  return { ...r, ms: Date.now() - t0, meta };
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/**
 * The launch. `pathMode`:
 *   'env'     (default, recommended) -- rootDir, tmpdir, credentials and the solver URL go through environment
 *             variables the shim maps to system properties; the classpath is relative to cwd=runtimeDir.
 *             Nothing non-ASCII or secret is on the command line.
 *   'cmdline' -- design-shell.md §5 literally: everything as -D flags, absolute classpath. Kept to measure.
 * `fsQuote`: in cmdline mode, whether flareSolverrUrl is passed as a quoted HOCON string (see EngineShim.java).
 */
export function buildLaunch({
  runtimeDir, rootDir, port, fsUrl, user, pass, tmpDir, xmx = '768m', kcef = false,
  pathMode = 'env', fsQuote = true, authModeValue = 'BASIC_AUTH', isolatePrefs = true, extraJvm = [], extraProps = {},
}) {
  const win = process.platform === 'win32';
  const java = path.join(runtimeDir, 'jre', 'bin', win ? 'java.exe' : 'java');
  // bin/, never the pack root: see pack.mjs keep() for the ClassGraph trap.
  const jars = [path.join('bin', 'Suwayomi-Server.jar'), path.join('bin', 'uchiyomi-shim.jar')];
  const cp = (pathMode === 'env' ? jars : jars.map((j) => path.join(runtimeDir, j))).join(path.delimiter);
  const props = {
    ip: '127.0.0.1',
    port: String(port),
    webUIEnabled: 'false',
    initialOpenInBrowserEnabled: 'false',
    systemTrayEnabled: 'false',
    downloadAsCbz: 'true',
    autoDownloadNewChapters: 'false',
    flareSolverrEnabled: 'true',
    authMode: authModeValue,
    ...(kcef === false ? { kcefEnabled: 'false' } : {}),
    ...extraProps,
  };
  const env = { ...process.env };
  // A user-level JAVA_TOOL_OPTIONS / _JAVA_OPTIONS / JDK_JAVA_OPTIONS would silently change our JVM.
  for (const k of ['JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'CLASSPATH', 'JAVA_HOME']) delete env[k];
  if (pathMode === 'env') {
    env.UCHIYOMI_ENGINE_ROOT_DIR = rootDir;
    if (tmpDir) env.UCHIYOMI_ENGINE_TMP_DIR = tmpDir;
    env.UCHIYOMI_ENGINE_AUTH_USERNAME = user;
    env.UCHIYOMI_ENGINE_AUTH_PASSWORD = pass;
    env.UCHIYOMI_ENGINE_FLARESOLVERR_URL = fsUrl;
  } else {
    props.rootDir = rootDir;
    props.authUsername = user;
    props.authPassword = pass;
    props.flareSolverrUrl = fsQuote ? `"${fsUrl}"` : fsUrl;
    if (tmpDir) extraJvm = [...extraJvm, `-Djava.io.tmpdir=${tmpDir}`];
  }
  const args = [
    `-Xmx${xmx}`, '-XX:+UseSerialGC', '-Djava.awt.headless=true',
    ...(isolatePrefs ? ['-Djava.util.prefs.PreferencesFactory=dev.uchiyomi.IsolatedPreferences$Factory'] : []), ...extraJvm,
    '-cp', cp,
    ...Object.entries(props).map(([k, v]) => `${P}${k}=${v}`),
    'dev.uchiyomi.EngineShim',
  ];
  return { cmd: java, args, env, cwd: runtimeDir };
}

/** A copy-pasteable rendering of the launch with secrets masked. */
export function describeLaunch(l, secrets = []) {
  const mask = (s) => secrets.reduce((acc, x) => (x ? acc.split(x).join('<redacted>') : acc), s);
  const q = (s) => (/[\s"]/.test(s) ? JSON.stringify(s) : s);
  const envKeys = Object.keys(l.env).filter((k) => k.startsWith('UCHIYOMI_ENGINE_'));
  return mask(`cd ${q(l.cwd)} && ${envKeys.map((k) => `${k}=${q(l.env[k])}`).join(' ')} ${[l.cmd, ...l.args].map(q).join(' ')}`);
}

export function startEngine(l, { logFile, windowsHide = true } = {}) {
  const t0 = Date.now();
  const child = spawn(l.cmd, l.args, { cwd: l.cwd, env: l.env, windowsHide, stdio: ['pipe', 'pipe', 'pipe'] });
  const log = logFile ? fs.createWriteStream(logFile, { flags: 'a' }) : null;
  // Always drain stdout/stderr: an unread pipe fills and blocks the JVM's logging threads.
  let tail = '';
  const onData = (d) => { if (log) log.write(d); tail = (tail + d.toString('utf8')).slice(-20000); };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.stdin.on('error', () => {}); // EPIPE after the JVM exits is expected
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => { resolve({ code, signal, at: Date.now() }); }));
  const h = { child, pid: child.pid, t0, exited, get tail() { return tail; }, log, done: false };
  exited.then(() => { h.done = true; if (log) log.end(); });
  child.once('error', (e) => { tail += `\n[spawn error] ${e.message}`; });
  return h;
}

export async function probe(port, { auth, path: p = '/api/v1/settings/about', timeoutMs = 3000 } = {}) {
  const headers = auth ? { authorization: `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString('base64')}` } : {};
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const body = await r.text();
  return { status: r.status, body };
}

/** Poll /api/v1/settings/about until 200 or 401 (design-shell.md §5), the process exits, or timeout. */
export async function waitReady(h, port, { timeoutMs = 180000, intervalMs = 250 } = {}) {
  const deadline = h.t0 + timeoutMs;
  while (Date.now() < deadline) {
    if (h.done) return { ready: false, ms: Date.now() - h.t0, reason: 'exited', exit: await h.exited };
    try {
      const r = await probe(port, { timeoutMs: 2000 });
      if (r.status === 200 || r.status === 401) return { ready: true, ms: Date.now() - h.t0, status: r.status };
    } catch { /* not listening yet */ }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return { ready: false, ms: Date.now() - h.t0, reason: 'timeout' };
}

/** graceful: close stdin (the shim's lifeline), wait up to timeoutMs, then kill. kill: hard kill now. */
export async function stopEngine(h, { mode = 'graceful', timeoutMs = 15000 } = {}) {
  const t0 = Date.now();
  if (h.done) return { ms: 0, forced: false, ...(await h.exited) };
  if (mode === 'kill') {
    h.child.kill('SIGKILL');
    const e = await h.exited;
    return { ms: Date.now() - t0, forced: true, ...e };
  }
  h.child.stdin.end();
  const timer = new Promise((res) => setTimeout(() => res(null), timeoutMs));
  const e = await Promise.race([h.exited, timer]);
  if (e) return { ms: e.at - t0, forced: false, ...e };
  h.child.kill('SIGKILL');
  return { ms: Date.now() - t0, forced: true, ...(await h.exited) };
}

export async function gql(port, auth, query, variables = {}, timeoutMs = 30000) {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (auth) headers.authorization = `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString('base64')}`;
  const r = await fetch(`http://127.0.0.1:${port}/api/graphql`, {
    method: 'POST', headers, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text: text.slice(0, 2000) };
}
