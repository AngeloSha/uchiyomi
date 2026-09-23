#!/usr/bin/env node
// Uchiyomi Desktop Phase 0, spike S7: prove the extension engine pack on a real OS.
//
//   node spike.mjs --pack build/engine-pack-<platform>.zip --work <dir> [--bff <bff dir with dist/>]
//                  [--cycles 20] [--idle-s 180] [--kcef-wait-s 240] [--only a,b] [--results results.json]
//
// Prints one `PASS|FAIL|INFO [id] ...` line per finding and writes every number to --results. The checks are
// the nine in the S7 brief (see desktop-engine/README.md for the list).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirSize } from './lib/archive.mjs';
import { buildLaunch, describeLaunch, freePort, gql, probe, startEngine, stopEngine, unpackPack, waitReady } from './lib/engine.mjs';
import { alive, children, consoleProbe, footprint, isLoopback, listeners, rss } from './lib/probes.mjs';
import { startFakeCloudflareSite, startSolverStub } from './lib/stubs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const PACK = path.resolve(arg('--pack'));
const WORK = path.resolve(arg('--work', path.join(os.tmpdir(), 'uchiyomi-engine-spike')));
const BFF = arg('--bff') ? path.resolve(arg('--bff')) : null;
const CYCLES = Number(arg('--cycles', 20));
const IDLE_S = Number(arg('--idle-s', 180));
const KCEF_WAIT_S = Number(arg('--kcef-wait-s', 240));
const ONLY = arg('--only') ? new Set(arg('--only').split(',')) : null;
const RESULTS = path.resolve(arg('--results', path.join(WORK, 'results.json')));
const want = (id) => !ONLY || ONLY.has(id);
const win = process.platform === 'win32';

// The neutral test repository: the Suwayomi project's own extension repo, documented in the README of
// github.com/Suwayomi/tachiyomi-extension ("manually adding this to the extension repos"). It holds exactly one
// extension -- "Tachiyomi: Suwayomi", a client for a Suwayomi server -- and no third-party content.
const TEST_REPO = 'https://raw.githubusercontent.com/suwayomi/tachiyomi-extension/repo/index.min.json';
const TEST_PKG = 'eu.kanade.tachiyomi.extension.all.tachidesk';
const NON_ASCII = 'Jösé 名前';
const repoBase = (u) => String(u).replace(/[^/]+$/, '');

const results = { platform: `${process.platform}-${process.arch}`, os: `${os.type()} ${os.release()}`, node: process.version, cpus: os.cpus().length, memGiB: +(os.totalmem() / 2 ** 30).toFixed(1), startedAt: new Date().toISOString(), pack: null, checks: {}, lines: [] };
const line = (verdict, id, msg, data) => {
  const s = `${verdict} [${id}] ${msg}`;
  console.log(s);
  results.lines.push(s);
  if (data !== undefined) results.checks[id] = { verdict, msg, ...data };
  else results.checks[id] ??= { verdict, msg };
};
const save = () => fs.writeFileSync(RESULTS, `${JSON.stringify(results, null, 2)}\n`);
const mib = (b) => `${(b / 1048576).toFixed(0)} MiB`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const escapeLikeShim = (s) => [...s].map((ch) => { const cp = ch.codePointAt(0); return cp >= 0x20 && cp < 0x7f ? ch : cp <= 0xffff ? `\\u${cp.toString(16).toUpperCase().padStart(4, '0')}` : `\\U${cp.toString(16).toUpperCase().padStart(8, '0')}`; }).join('');
const shimRoot = (tail) => /\[uchiyomi-shim\] rootDir=(\S+(?: \S+)*?) tmpdir=/.exec(tail)?.[1] ?? /\[uchiyomi-shim\] rootDir=(.*)/.exec(tail)?.[1];

async function withTimeout(p, ms, what) {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: timed out after ${ms} ms`)), ms); });
  try { return await Promise.race([p, timer]); } finally { clearTimeout(t); }
}

async function main() {
  await fsp.mkdir(WORK, { recursive: true });
  const packJson = PACK.replace(/\.zip$/, '.json');
  if (fs.existsSync(packJson)) results.pack = JSON.parse(fs.readFileSync(packJson, 'utf8'));
  results.pack = { ...(results.pack || {}), zipBytes: fs.statSync(PACK).size };

  // ------------------------------------------------------------------ unpack
  const rtAscii = path.join(WORK, 'ascii', 'runtime');
  const u = await unpackPack(PACK, rtAscii);
  const onDisk = await dirSize(rtAscii);
  results.unpack = { ms: u.ms, files: onDisk.files, bytes: onDisk.bytes, mainClass: u.meta.mainClass };
  line('INFO', 'unpack', `pack ${mib(results.pack.zipBytes)} -> ${onDisk.files} files, ${mib(onDisk.bytes)} on disk in ${u.ms} ms; Main-Class ${u.meta.mainClass}; java ${u.meta.javaVersion}`);
  if (process.platform === 'darwin') {
    const { execFileSync } = await import('node:child_process');
    const cs = (() => { try { return execFileSync('codesign', ['-dv', path.join(rtAscii, 'jre', 'bin', 'java')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return `${e.stdout || ''}${e.stderr || ''}`; } })();
    const authority = (cs.match(/Authority=([^\n]+)/g) || []).join('; ');
    const teamId = /TeamIdentifier=(\S+)/.exec(cs)?.[1];
    results.macCodesign = { authority, teamId, raw: cs.slice(0, 1500) };
    line('INFO', 'mac-codesign', `jre/bin/java: ${authority || 'no Authority'} TeamIdentifier=${teamId || '?'}`);
  }

  const stub = await startSolverStub();
  const fakeCf = await startFakeCloudflareSite({ clearance: stub.clearance });
  const creds = { user: crypto.randomBytes(12).toString('hex'), pass: crypto.randomBytes(24).toString('hex') };
  const mainPort = await freePort(); // chosen once and reused across every restart, like the shell's persisted port
  const rootAscii = path.join(WORK, 'ascii', 'data');
  const tmpAscii = path.join(WORK, 'ascii', 'tmp');
  await fsp.mkdir(rootAscii, { recursive: true });
  const mainLaunch = () => buildLaunch({ runtimeDir: rtAscii, rootDir: rootAscii, tmpDir: tmpAscii, port: mainPort, fsUrl: stub.url, ...creds });
  results.launchCommand = describeLaunch(mainLaunch(), [creds.pass, stub.token]);
  line('INFO', 'launch', results.launchCommand);

  // The bff's own Suwayomi client, compiled (bff/dist), pointed at this engine.
  let bff = null;
  if (BFF && fs.existsSync(path.join(BFF, 'dist', 'lib', 'sources', 'suwayomi', 'extensions.js'))) {
    Object.assign(process.env, {
      SUWAYOMI_URL: `http://127.0.0.1:${mainPort}`, SUWAYOMI_USERNAME: creds.user, SUWAYOMI_PASSWORD: creds.pass,
      DATABASE_URL: 'postgres://unused@127.0.0.1:1/unused', CONFIG_DIR: path.join(WORK, 'bff-config'),
    });
    const req = createRequire(path.join(BFF, 'package.json'));
    bff = { ext: req('./dist/lib/sources/suwayomi/extensions.js'), client: req('./dist/lib/sources/suwayomi/client.js') };
  }
  results.bffClient = !!bff;

  const fpBefore = await footprint();

  // ------------------------------------------------------------------ 1. boot from an ASCII rootDir
  let h = startEngine(mainLaunch(), { logFile: path.join(WORK, 'engine-ascii.log') });
  let r = await waitReady(h, mainPort, { timeoutMs: 180000 });
  results.bootAscii = r;
  if (!r.ready) {
    line('FAIL', 'boot-ascii', `not ready: ${r.reason} after ${r.ms} ms; tail: ${h.tail.slice(-1500)}`);
    save();
    await stopEngine(h, { mode: 'kill' });
    return;
  }
  line(r.ms < 180000 ? 'PASS' : 'FAIL', 'boot-ascii', `ready in ${(r.ms / 1000).toFixed(1)} s (HTTP ${r.status} on /api/v1/settings/about), pid ${h.pid}`, { ms: r.ms });

  // ------------------------------------------------------------------ 2. loopback only
  if (want('loopback')) {
    const ls = await listeners(h.pid);
    const bad = ls.filter((l) => !isLoopback(l.addr));
    const onPort = ls.some((l) => l.port === mainPort && isLoopback(l.addr));
    line(!bad.length && onPort ? 'PASS' : 'FAIL', 'loopback', `listeners of pid ${h.pid}: ${ls.map((l) => `${l.addr}:${l.port}`).join(', ') || 'none'}${bad.length ? ` -- NON-LOOPBACK: ${bad.map((b) => b.raw).join(' | ')}` : ''}`, { listeners: ls });
  }

  // ------------------------------------------------------------------ 3. basic auth
  if (want('auth')) {
    const q = '{ aboutServer { name version revision } }';
    const none = await gql(mainPort, null, q);
    const wrong = await gql(mainPort, { user: creds.user, pass: 'wrong' }, q);
    const right = await gql(mainPort, creds, q);
    const restNone = await probe(mainPort);
    const restRight = await probe(mainPort, { auth: creds });
    const about = right.json?.data?.aboutServer;
    let bffAbout = null, bffErr = null;
    if (bff) { try { bffAbout = await bff.client.aboutServer(); } catch (e) { bffErr = e.message; } }
    const ok = none.status === 401 && wrong.status === 401 && right.status === 200 && about?.name && restNone.status === 401 && restRight.status === 200 && (!bff || bffAbout?.version);
    line(ok ? 'PASS' : 'FAIL', 'auth', `GraphQL aboutServer: no creds ${none.status}, wrong password ${wrong.status}, right ${right.status} -> ${JSON.stringify(about)}; REST about: none ${restNone.status}, right ${restRight.status}${bff ? `; bff client.aboutServer() -> ${bffAbout ? JSON.stringify(bffAbout) : `ERROR ${bffErr}`}` : '; (bff dist not given)'}`,
      { none: none.status, wrong: wrong.status, right: right.status, about, bffAbout, bffErr });
  }

  // ------------------------------------------------------------------ 4. no browser, no web UI, no tray, no KCEF
  const settingsQ = '{ settings { ip port authMode flareSolverrEnabled flareSolverrUrl kcefEnabled systemTrayEnabled initialOpenInBrowserEnabled downloadAsCbz autoDownloadNewChapters extensionRepos } }';
  if (want('headless')) {
    const s = (await gql(mainPort, creds, settingsQ)).json?.data?.settings;
    const rootEntries = fs.readdirSync(rootAscii);
    const webUi = rootEntries.filter((n) => /webui/i.test(n));
    const tmpEntries = fs.existsSync(path.join(tmpAscii, 'Tachidesk')) ? fs.readdirSync(path.join(tmpAscii, 'Tachidesk')) : [];
    const kids = await children(h.pid);
    const kcefDir = fs.existsSync(path.join(rootAscii, 'bin', 'kcef'));
    const log = fs.readFileSync(path.join(WORK, 'engine-ascii.log'), 'utf8');
    const browserLog = /openInBrowser|browseURL|Desktop\.browse/i.test(log);
    const trayLog = /SystemTray\.create|Failed to create\/remove SystemTray/i.test(log);
    const ok = !webUi.length && !tmpEntries.some((n) => /webui/i.test(n)) && !kids.length && !kcefDir && !browserLog
      && s?.systemTrayEnabled === false && s?.initialOpenInBrowserEnabled === false && s?.kcefEnabled === false;
    line(ok ? 'PASS' : 'FAIL', 'headless', `rootDir entries [${rootEntries.join(', ')}]; webUI dirs: ${webUi.length ? webUi.join(',') : 'none'}; tmp/Tachidesk [${tmpEntries.join(', ')}]; java child processes: ${kids.length ? kids.join('; ') : 'none'}; bin/kcef: ${kcefDir ? 'PRESENT' : 'absent'}; browser/tray log lines: ${browserLog || trayLog ? 'FOUND' : 'none'}; engine reports systemTray=${s?.systemTrayEnabled} openInBrowser=${s?.initialOpenInBrowserEnabled} kcef=${s?.kcefEnabled} downloadAsCbz=${s?.downloadAsCbz} autoDownload=${s?.autoDownloadNewChapters} ip=${s?.ip}`,
      { rootEntries, tmpEntries, children: kids, kcefDir, settings: s });
  }

  // ------------------------------------------------------------------ 9. Windows: no console window
  if (win && want('console')) {
    const scratch = path.join(WORK, 'probe');
    await fsp.mkdir(scratch, { recursive: true });
    const eng = await consoleProbe(h.pid, scratch);
    const idleLaunch = (hide) => ({ ...buildLaunch({ runtimeDir: rtAscii, rootDir: path.join(WORK, 'idle'), port: 1, fsUrl: stub.url, ...creds, extraJvm: ['-Duchiyomi.shim.idle=true'] }), hide });
    const ctl = {};
    for (const hide of [true, false]) {
      const l = idleLaunch(hide);
      const hh = startEngine(l, { windowsHide: hide });
      await sleep(2500);
      ctl[hide ? 'hidden' : 'notHidden'] = await consoleProbe(hh.pid, scratch);
      await stopEngine(hh, { mode: 'graceful', timeoutMs: 5000 });
    }
    const ok = eng.attached === false && ctl.hidden?.attached === false && ctl.notHidden?.attached === true;
    line(ok ? 'PASS' : 'FAIL', 'console', `engine (windowsHide:true): ${JSON.stringify(eng)}; control shim windowsHide:true ${JSON.stringify(ctl.hidden)}; control windowsHide:false ${JSON.stringify(ctl.notHidden)} -- attached=false/error 6 means the process owns no console, so no window can flash; the windowsHide:false control proves the probe sees a console when there is one`,
      { engine: eng, control: ctl });
  }

  // ------------------------------------------------------------------ 7a. idle RSS
  if (want('rss')) {
    const waitMs = h.t0 + r.ms + IDLE_S * 1000 - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    const m = await rss(h.pid);
    results.rssIdle = m;
    line(m.rss < 900 * 1048576 ? 'PASS' : 'FAIL', 'rss-idle', `RSS ${mib(m.rss)}${m.privateBytes ? ` (private ${mib(m.privateBytes)})` : ''} ${IDLE_S} s after ready, -Xmx768m -XX:+UseSerialGC, no activity`, m);
  }

  // ------------------------------------------------------------------ 5. extension flow (neutral repo)
  if (want('extensions')) {
    try {
      const t0 = Date.now();
      const E = bff?.ext;
      const run = async (q, v, t) => { const x = await gql(mainPort, creds, q, v, t); if (x.status !== 200 || x.json?.errors) throw new Error(`${x.status} ${x.text}`); return x.json.data; };
      const setRepos = (urls) => (E ? E.setRepos(urls) : run('mutation($r:[String!]){ setSettings(input:{settings:{extensionRepos:$r}}){ settings { extensionRepos } } }', { r: urls }).then((d) => d.setSettings.settings.extensionRepos));
      const getRepos = () => (E ? E.getRepos() : run('{ settings { extensionRepos } }').then((d) => d.settings.extensionRepos));
      const refresh = () => (E ? E.refreshExtensions() : run('mutation{ fetchExtensions(input:{}){ extensions { pkgName } } }', {}, 120000).then((d) => d.fetchExtensions.extensions.length));
      const list = () => (E ? E.listExtensions() : run('{ extensions { nodes { pkgName name isInstalled repo } } }').then((d) => d.extensions.nodes.map((n) => ({ ...n, installed: n.isInstalled }))));
      const install = () => (E ? E.setExtensionState(TEST_PKG, 'install') : run(`mutation($id:String!){ updateExtension(input:{id:$id,patch:{install:true}}){ extension { pkgName isInstalled } } }`, { id: TEST_PKG }, 180000).then((d) => !!d.updateExtension.extension));
      const sources = () => (E ? E.sourcesOfExtension(TEST_PKG) : run('{ extensions { nodes { pkgName source { nodes { id name lang } } } } }').then((d) => (d.extensions.nodes.find((n) => n.pkgName === TEST_PKG)?.source?.nodes || [])));
      // Exactly the bff's add-a-repo route (routes/admin.ts:2439-2448): read the current list, then write it back
      // with the new URL. The read matters -- see the repo-write-race finding in the design-literal boot.
      const current = await getRepos();
      const set = await setRepos([...current, TEST_REPO]);
      // Suwayomi applies a settings change asynchronously (routes/admin.ts retries for the same reason).
      let n = 0, exts = [];
      for (let i = 0; i < 10 && !exts.some((e) => e.pkgName === TEST_PKG); i++) {
        if (i) await sleep(1500);
        n = await refresh();
        exts = await list();
      }
      const found = exts.find((e) => e.pkgName === TEST_PKG);
      const tInstall = Date.now();
      const installed = found ? await install() : false;
      const installMs = Date.now() - tInstall;
      const after = (await list()).find((e) => e.pkgName === TEST_PKG);
      const srcs = found ? await sources() : [];
      // Suwayomi rewrites a legacy index URL to its repo.json once the store syncs (ExtensionStoreService.fetch):
      // wait for that so the persisted value is known.
      let repos = await getRepos();
      for (let i = 0; i < 20 && !repos.some((x) => x.endsWith('/repo.json')); i++) { await sleep(500); repos = await getRepos(); }
      results.reposAfterSync = repos;
      const ok = set.includes(TEST_REPO) && repos.length === 1 && repos[0].startsWith(TEST_REPO.replace(/index\.min\.json$/, '')) && !!found && installed && after?.installed && srcs.length > 0;
      line(ok ? 'PASS' : 'FAIL', 'extensions', `${E ? 'bff client (dist/lib/sources/suwayomi/extensions.js)' : 'bff-shaped GraphQL'}: setRepos([${TEST_REPO}]) -> ${JSON.stringify(set)}, after the store sync getRepos() -> ${JSON.stringify(repos)}; fetchExtensions -> ${n}; list -> ${exts.length} (${found ? `${found.pkgName} "${found.name}" ${found.versionName || ''}` : 'test extension NOT listed'}); install -> ${installed} in ${installMs} ms, now installed=${after?.installed}; sources: ${JSON.stringify(srcs)}; total ${Date.now() - t0} ms`,
        { repos, fetched: n, listed: exts.length, installed: after?.installed, installMs, sources: srcs });
      results.rssAfterExtensions = await rss(h.pid);
      line('INFO', 'rss-after-extensions', `RSS ${mib(results.rssAfterExtensions.rss)} right after the repo fetch + install`);
    } catch (e) {
      line('FAIL', 'extensions', `error: ${e.stack || e.message}`);
    }
  }

  // ------------------------------------------------------------------ 6. FlareSolverr wiring
  if (want('flaresolverr')) {
    try {
      const s = (await gql(mainPort, creds, settingsQ)).json?.data?.settings;
      const before = stub.requests.length;
      const cfRepo = `${fakeCf.base}/repo.json`;
      const current = (await gql(mainPort, creds, '{ settings { extensionRepos } }')).json.data.settings.extensionRepos;
      await gql(mainPort, creds, 'mutation($r:[String!]){ setSettings(input:{settings:{extensionRepos:$r}}){ settings { extensionRepos } } }', { r: [...current, cfRepo] });
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline && !fakeCf.requests.some((q) => q.cleared)) await sleep(500);
      await sleep(1500);
      const solverCalls = stub.requests.slice(before).filter((q) => q.method === 'POST');
      const call = solverCalls[0];
      const siteReqs = fakeCf.requests;
      const cleared = siteReqs.find((q) => q.cleared);
      const repos = (await gql(mainPort, creds, '{ settings { extensionRepos } }')).json.data.settings.extensionRepos;
      const shapeOk = call && call.url === `/${stub.token}/v1` && call.body?.cmd === 'request.get' && call.body?.url === cfRepo && typeof call.body?.maxTimeout === 'number' && call.headers.origin === undefined;
      const ok = s?.flareSolverrEnabled === true && s?.flareSolverrUrl === stub.url && shapeOk;
      line(ok ? 'PASS' : 'FAIL', 'flaresolverr', `engine reports flareSolverrEnabled=${s?.flareSolverrEnabled} flareSolverrUrl ${s?.flareSolverrUrl === stub.url ? '== the override (token path intact)' : `MISMATCH: ${s?.flareSolverrUrl}`}; fake Cloudflare site (403 + Server: cloudflare) hit ${siteReqs.length}x; solver stub got ${solverCalls.length} POST(s)${call ? `: ${call.url.replace(stub.token, '<token>')} ${JSON.stringify({ ...call.body })}` : ''}; retry carried cf_clearance+stub UA: ${cleared ? `yes (UA "${cleared.userAgent}")` : 'NO'}; repo added after the solve: ${repos.includes(cfRepo)}`,
        { settings: s, solverCalls: solverCalls.map((c) => c.body), siteRequests: siteReqs.map(({ url, cookie, userAgent, cleared: c }) => ({ url, cookie: cookie ? 'present' : '', userAgent, cleared: c })) });
      // Put the repo list back so the kill test measures only the neutral repo.
      await gql(mainPort, creds, 'mutation($r:[String!]){ setSettings(input:{settings:{extensionRepos:$r}}){ settings { extensionRepos } } }', { r: current });
    } catch (e) {
      line('FAIL', 'flaresolverr', `error: ${e.stack || e.message}`);
    }
  }
  // The repo setting as it will be persisted: read until two reads 2 s apart agree (the store sync is async).
  {
    let prev = null;
    for (let i = 0; i < 10; i++) {
      const cur = JSON.stringify((await gql(mainPort, creds, '{ settings { extensionRepos } }')).json?.data?.settings?.extensionRepos ?? null);
      if (cur === prev) break;
      prev = cur;
      await sleep(2000);
    }
    results.reposPersisted = JSON.parse(prev);
    line('INFO', 'repos-before-stop', `extensionRepos the kill test must find after every restart: ${prev}`);
  }

  // ------------------------------------------------------------------ footprint outside rootDir
  const fpAfter = await footprint();
  const created = Object.keys(fpAfter).filter((k) => fpAfter[k] && !fpBefore[k]);
  results.footprint = { before: fpBefore, after: fpAfter, created };
  line(created.length ? 'FAIL' : 'PASS', 'footprint', `outside rootDir, created by the engine: ${created.length ? created.join(', ') : 'nothing'} (checked: ${Object.keys(fpAfter).join(', ')})`);

  // graceful stop of the main boot
  let st = await stopEngine(h, { mode: 'graceful' });
  results.stopMain = st;
  line(!st.forced && st.code === 0 ? 'PASS' : 'FAIL', 'graceful-stop', `stdin closed -> exit code ${st.code} in ${st.ms} ms (forced kill: ${st.forced})`);
  save();

  // ------------------------------------------------------------------ 1b. non-ASCII rootDir (and runtime)
  const na = path.join(WORK, NON_ASCII);
  const variants = [
    { id: 'nonascii-root-env', verdictCounts: true, rt: rtAscii, root: path.join(na, 'engine'), mode: 'env', note: 'rootDir via env through the shim, runtime on an ASCII path' },
    { id: 'nonascii-root-cmdline', verdictCounts: false, rt: rtAscii, root: path.join(na, 'engine-cmdline'), mode: 'cmdline', note: 'design-shell.md §5 as written: rootDir as a -D flag on the command line' },
    { id: 'nonascii-runtime', verdictCounts: false, rt: path.join(na, 'runtime'), root: path.join(na, 'engine-rt'), mode: 'env', note: 'the pack itself unpacked under the non-ASCII folder (cwd-relative classpath)' },
  ];
  if (want('nonascii')) {
    for (const v of variants) {
      try {
        if (v.rt !== rtAscii) await unpackPack(PACK, v.rt);
        await fsp.mkdir(v.root, { recursive: true });
        const port = await freePort();
        const l = buildLaunch({ runtimeDir: v.rt, rootDir: v.root, tmpDir: v.mode === 'env' ? path.join(v.root, '..', 'tmp-' + path.basename(v.root)) : undefined, port, fsUrl: stub.url, ...creds, pathMode: v.mode });
        const hh = startEngine(l, { logFile: path.join(WORK, `engine-${v.id}.log`) });
        const rr = await waitReady(hh, port, { timeoutMs: 180000 });
        const conf = fs.existsSync(path.join(v.root, 'server.conf'));
        const db = fs.existsSync(path.join(v.root, 'database.mv.db'));
        const seen = shimRoot(hh.tail);
        const expect = escapeLikeShim(v.root);
        const auth = rr.ready ? (await probe(port)).status : null;
        await stopEngine(hh, { mode: 'graceful' });
        const strays = fs.readdirSync(WORK).filter((n) => n !== NON_ASCII && /^Jös|\?/.test(n));
        const ok = rr.ready && rr.ms < 180000 && conf && db && seen === expect && auth === 401;
        line(ok ? 'PASS' : v.verdictCounts ? 'FAIL' : 'INFO', v.id, `${v.note}: ${rr.ready ? `ready in ${(rr.ms / 1000).toFixed(1)} s` : `NOT READY (${rr.reason}${rr.exit ? `, exit ${rr.exit.code}` : ''})`}; server.conf+database in "${NON_ASCII}": ${conf && db}; JVM saw rootDir ${seen === expect ? 'exactly' : `MANGLED as ${seen}`}; unauthenticated about -> ${auth}${strays.length ? `; stray dirs: ${strays.join(',')}` : ''}${rr.ready ? '' : `; tail: ${hh.tail.slice(-600).replace(/\s+/g, ' ')}`}`,
          { ready: rr.ready, ms: rr.ms, conf, db, seen, expect, auth });
      } catch (e) {
        line(v.verdictCounts ? 'FAIL' : 'INFO', v.id, `error: ${e.message}`);
      }
      save();
    }
  }

  // ------------------------------------------------------------------ design-literal launch + KCEF
  if (want('design-literal')) {
    const root = path.join(WORK, 'design-literal');
    await fsp.mkdir(root, { recursive: true });
    const port = await freePort();
    // Exactly design-shell.md §5: lowercase basic_auth from the wiki, credentials and solver URL as unquoted -D
    // flags, absolute classpath, no kcefEnabled flag (so Suwayomi's default, true, applies), platform prefs.
    const l = buildLaunch({ runtimeDir: rtAscii, rootDir: root, port, fsUrl: stub.url, ...creds, pathMode: 'cmdline', fsQuote: false, authModeValue: 'basic_auth', kcef: true, isolatePrefs: false });
    const logFile = path.join(WORK, 'engine-design-literal.log');
    const hh = startEngine(l, { logFile });
    const rr = await waitReady(hh, port, { timeoutMs: 180000 });
    if (!rr.ready) {
      line('FAIL', 'design-literal', `not ready: ${rr.reason}; tail ${hh.tail.slice(-800)}`);
    } else {
      // Suwayomi race: extensionRepos is a MigratedConfigValue whose forwarding collector is launched lazily
      // on first access and drops the first value it sees; when setSettings is the FIRST access the new list
      // is shown back but never reaches extensionStores/server.conf. Probe it on this fresh engine.
      await gql(port, creds, 'mutation($r:[String!]){ setSettings(input:{settings:{extensionRepos:$r}}){ settings { extensionRepos } } }', { r: [TEST_REPO] });
      await sleep(4000);
      const confText = fs.existsSync(path.join(root, 'server.conf')) ? fs.readFileSync(path.join(root, 'server.conf'), 'utf8') : '';
      const persisted = /extensionStores = (\[[^\]]*\])/.exec(confText)?.[1]?.replace(/\s+/g, '') ?? '?';
      results.repoWriteRace = { writeFirstPersisted: persisted };
      line('INFO', 'repo-write-race', `setSettings(extensionRepos) as the very first settings access on a fresh engine: server.conf extensionStores after 4 s = ${persisted} (${persisted === '[]' ? 'LOST: the bff must read settings first, or use addExtensionStore' : 'kept'})`);
      await gql(port, creds, 'mutation($r:[String!]){ setSettings(input:{settings:{extensionRepos:$r}}){ settings { extensionRepos } } }', { r: [] });
      const none = await probe(port);
      const s = (await gql(port, creds, settingsQ)).json?.data?.settings;
      line(none.status === 401 && s?.flareSolverrUrl === stub.url ? 'PASS' : 'FAIL', 'design-literal', `design §5 flags verbatim: ready in ${(rr.ms / 1000).toFixed(1)} s; authMode=basic_auth (lowercase) -> unauthenticated ${none.status}, engine reports authMode=${s?.authMode}; unquoted flareSolverrUrl reported ${s?.flareSolverrUrl === stub.url ? 'intact' : `as ${s?.flareSolverrUrl}`}`, { ms: rr.ms, settings: s });
      // KCEF: Suwayomi's default is kcefEnabled=true; watch what it does on its own.
      const t0 = Date.now();
      let state = 'no CEF activity logged';
      let text = '';
      let doneAt = null;
      while (Date.now() - t0 < KCEF_WAIT_S * 1000) {
        text = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
        if (/Failed to set up CEF/.test(text)) { state = 'failed'; break; }
        if (/Downloaded CEF successfully/.test(text)) { state = 'downloaded'; doneAt ??= Date.now(); }
        if (/Downloading CEF from Github/.test(text) && state === 'no CEF activity logged') state = 'downloading';
        if (doneAt && Date.now() - doneAt > 15000) break; // give CEF 15 s to start (or fail) after the download
        await sleep(2000);
      }
      await sleep(2000);
      text = fs.readFileSync(logFile, 'utf8');
      const release = /Downloading CEF from Github \(([^)]+)\)/.exec(text)?.[1];
      const pct = [...text.matchAll(/Downloading (\d+)% of ([^\n]+)/g)];
      const failure = /Failed to set up CEF\s*\n([^\n]+)/.exec(text)?.[1];
      const kcefDir = path.join(root, 'bin', 'kcef');
      const kcefSize = fs.existsSync(kcefDir) ? await dirSize(kcefDir) : null;
      const cacheSize = fs.existsSync(path.join(root, 'cache', 'kcef')) ? await dirSize(path.join(root, 'cache', 'kcef')) : null;
      const kids = await children(hh.pid);
      const m = await rss(hh.pid);
      results.kcef = { state, release, lastProgress: pct.at(-1)?.[0], failure, kcefBytes: kcefSize?.bytes, kcefFiles: kcefSize?.files, cacheBytes: cacheSize?.bytes, children: kids, rss: m.rss, watchedMs: Date.now() - t0 };
      line('INFO', 'kcef', `with Suwayomi's default kcefEnabled=true: ${release ? `downloads ${release}` : 'no download started'}${pct.length ? ` (${pct.at(-1)[0]})` : ''}; outcome ${state}${failure ? ` -- ${failure}` : ''}; bin/kcef ${kcefSize ? `${mib(kcefSize.bytes)} in ${kcefSize.files} files` : 'absent'}; cache/kcef ${cacheSize ? mib(cacheSize.bytes) : 'absent'}; java children now: ${kids.length ? kids.join('; ') : 'none'}; RSS ${mib(m.rss)}; watched ${((Date.now() - t0) / 1000).toFixed(0)} s. With -D...kcefEnabled=false (every other boot here) bin/kcef stays absent.`);
    }
    await stopEngine(hh, { mode: 'graceful' });
    const fpd = await footprint();
    const createdD = Object.keys(fpd).filter((k) => fpd[k] && !fpBefore[k]);
    line('INFO', 'footprint-design-literal', `without the shim's isolated prefs: created outside rootDir: ${createdD.length ? createdD.join(', ') : 'nothing'}`);
    save();
  }

  // ------------------------------------------------------------------ 8b. orphan: the shell dies, java follows
  if (want('orphan')) {
    const port = await freePort();
    const root = path.join(WORK, 'orphan');
    await fsp.mkdir(root, { recursive: true });
    const lf = path.join(WORK, 'orphan-launch.json');
    fs.writeFileSync(lf, JSON.stringify(buildLaunch({ runtimeDir: rtAscii, rootDir: root, port, fsUrl: stub.url, ...creds })));
    const parent = spawn(process.execPath, [path.join(here, 'lib', 'orphan-child.mjs'), lf, path.join(WORK, 'engine-orphan.log')], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    const javaPid = await withTimeout(new Promise((res) => parent.stdout.once('data', (d) => res(JSON.parse(d.toString()).javaPid))), 20000, 'orphan child');
    const pseudo = { t0: Date.now(), done: false, get tail() { return ''; } };
    const rr = await waitReady(pseudo, port, { timeoutMs: 180000 });
    parent.kill('SIGKILL');
    const t0 = Date.now();
    while (Date.now() - t0 < 30000 && (await alive(javaPid))) await sleep(250);
    const gone = !(await alive(javaPid));
    if (!gone) try { process.kill(javaPid, 'SIGKILL'); } catch { /* already gone */ }
    fs.rmSync(lf, { force: true });
    line(rr.ready && gone ? 'PASS' : 'FAIL', 'orphan', `engine ready=${rr.ready}; hard-killed its parent node process; java pid ${javaPid} ${gone ? `exited by itself ${Date.now() - t0} ms later (stdin EOF -> shim -> System.exit)` : 'STILL RUNNING after 30 s (killed by the harness)'}`);
    save();
  }

  // ------------------------------------------------------------------ 8. kill survival
  if (want('kill')) {
    const cycles = [];
    let expected = []; // markers written before a graceful stop must survive
    for (let i = 0; i < CYCLES; i++) {
      const hard = i % 5 === 4;
      const c = { i, hard };
      try {
        h = startEngine(mainLaunch(), { logFile: path.join(WORK, 'engine-kill.log') });
        r = await waitReady(h, mainPort, { timeoutMs: 180000 });
        c.readyMs = r.ms;
        c.ready = r.ready;
        if (!r.ready) { c.error = `${r.reason} ${h.tail.slice(-500)}`; cycles.push(c); await stopEngine(h, { mode: 'kill' }); continue; }
        const d = (await gql(mainPort, creds, `{ settings { extensionRepos } extensions(condition:{pkgName:"${TEST_PKG}"}) { nodes { pkgName isInstalled } } categories { nodes { name } } }`)).json?.data;
        c.repos = d?.settings?.extensionRepos;
        // Same repository, compared by its directory: Suwayomi stores a legacy index URL as .../repo.json
        // once its store sync has run (the running engine keeps reporting the URL as typed until a restart).
        c.repo = Array.isArray(c.repos) && c.repos.length === 1 && repoBase(c.repos[0]) === repoBase(TEST_REPO);
        c.dbOpen = Array.isArray(d?.categories?.nodes);
        c.extensionInstalled = !!d?.extensions?.nodes?.[0]?.isInstalled;
        const names = new Set((d?.categories?.nodes || []).map((x) => x.name));
        c.missingMarkers = expected.filter((m) => !names.has(m));
        // Write something, then stop immediately: graceful through the shim, or (every 5th) a hard kill.
        const marker = `spike-cycle-${i}`;
        const w = await gql(mainPort, creds, 'mutation($n:String!){ createCategory(input:{name:$n}){ category { id } } }', { n: marker });
        c.wrote = w.status === 200 && !w.json?.errors;
        const s = await stopEngine(h, { mode: hard ? 'kill' : 'graceful' });
        c.stopMs = s.ms; c.stopCode = s.code; c.forced = s.forced;
        if (!hard && c.wrote) expected.push(marker);
        if (hard && c.wrote) c.hardKillMarker = marker;
      } catch (e) {
        c.error = e.message;
        try { await stopEngine(h, { mode: 'kill' }); } catch { /* */ }
      }
      cycles.push(c);
      console.log(`  cycle ${i + 1}/${CYCLES} ${hard ? 'HARD KILL' : 'graceful '} ready ${((c.readyMs || 0) / 1000).toFixed(1)} s repo=${c.repo} db=${c.dbOpen} ext=${c.extensionInstalled} stop ${c.stopMs} ms code ${c.stopCode}${c.missingMarkers?.length ? ` missing ${c.missingMarkers}` : ''}${c.error ? ` ERROR ${c.error}` : ''}`);
    }
    // One more start to read back what the last stop left.
    h = startEngine(mainLaunch(), { logFile: path.join(WORK, 'engine-kill.log') });
    r = await waitReady(h, mainPort, { timeoutMs: 180000 });
    const d = r.ready ? (await gql(mainPort, creds, '{ settings { extensionRepos } categories { nodes { name } } }')).json?.data : null;
    const names = new Set((d?.categories?.nodes || []).map((x) => x.name));
    const hardMarkers = cycles.filter((c) => c.hardKillMarker).map((c) => c.hardKillMarker);
    const survivedHard = hardMarkers.filter((m) => names.has(m));
    await stopEngine(h, { mode: 'graceful' });
    const good = cycles.filter((c) => c.ready && c.repo && c.dbOpen && c.extensionInstalled && !c.missingMarkers?.length && !c.error).length;
    const gracefulStops = cycles.filter((c) => !c.hard && c.stopMs != null);
    const readyTimes = cycles.filter((c) => c.ready).map((c) => c.readyMs).sort((a, b) => a - b);
    results.kill = { cycles, good, hardMarkers, survivedHard, finalReady: r.ready };
    const finalRepos = d?.settings?.extensionRepos;
    const finalRepoOk = Array.isArray(finalRepos) && finalRepos.length === 1 && repoBase(finalRepos[0]) === repoBase(TEST_REPO);
    const repoValues = [...new Set(cycles.map((c) => JSON.stringify(c.repos)))];
    line(good === CYCLES && r.ready && finalRepoOk ? 'PASS' : 'FAIL', 'kill', `${good}/${CYCLES} restarts came up with the database open, the repo setting and the installed extension intact, and every marker written before a graceful stop present; ${hardMarkers.length} hard kills right after a write: ${survivedHard.length}/${hardMarkers.length} of those last writes survived; repo value(s) seen after restarts: ${repoValues.join(' | ')}; graceful stop median ${gracefulStops.map((c) => c.stopMs).sort((a, b) => a - b)[Math.floor(gracefulStops.length / 2)]} ms, max ${Math.max(...gracefulStops.map((c) => c.stopMs))} ms, all exit 0: ${gracefulStops.every((c) => c.stopCode === 0 && !c.forced)}; warm ready median ${(readyTimes[Math.floor(readyTimes.length / 2)] / 1000).toFixed(1)} s, max ${(readyTimes.at(-1) / 1000).toFixed(1)} s`);
    save();
  }

  await stub.close();
  await fakeCf.close();
}

main().then(() => {
  results.finishedAt = new Date().toISOString();
  const fails = Object.entries(results.checks).filter(([, v]) => v.verdict === 'FAIL').map(([k]) => k);
  results.summary = { fail: fails };
  save();
  console.log(`\nSUMMARY ${results.platform}: ${fails.length ? `FAIL (${fails.join(', ')})` : 'all PASS'}; results in ${RESULTS}`);
  process.exit(fails.length ? 1 : 0);
}, (e) => {
  console.error(e);
  results.crash = String(e.stack || e);
  save();
  process.exit(2);
});
