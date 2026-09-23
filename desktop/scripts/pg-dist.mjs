#!/usr/bin/env node
// Fetch EDB's PostgreSQL 16 binaries for this OS and prune them to what the app runs:
//   bin/  postgres pg_ctl initdb pg_dump pg_restore psql pg_isready pg_controldata  + exactly the libraries they load
//   lib/  plpgsql, dict_snowball, the encoding conversions (initdb loads these), walreceiver/pgoutput
//   share/ everything the server reads at runtime, minus translations and docs
//
// EDB publishes these zips "for users who wish to include Postgres as part of another application installer"
// (postgresql.org/download/windows). The same major as Dockerfile.aio (postgresql16), so a backup moves between
// the server and the desktop in both directions.
//
// Windows: the DLL set is computed from the PE import tables (scripts/lib/pe-imports.mjs), and anything the
//   binaries expect the SYSTEM to provide is listed. The VC++ runtime (vcruntime140/msvcp140) is NOT part of a
//   fresh Windows, and EDB's zip does not carry it, so it is copied in app-locally.
// macOS: the zip is universal (x86_64 + arm64). Each Mach-O is thinned to this runner's arch with `lipo`; code
//   signatures are per-slice, so EDB's Developer ID signature survives the thinning. Load paths are
//   @rpath/@loader_path/../lib (checked with otool), i.e. the tree is relocatable as-is.
//
//   node scripts/pg-dist.mjs [--version 16.15-4] [--cache DIR] [--out resources/pg]
//   node scripts/pg-dist.mjs --from-dir /path/to/pgsql   (Linux dev: a local source build, copied as-is)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { peImports } from './lib/pe-imports.mjs';

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const VERSION = opt('version', '16.15-4');
const CACHE = resolve(opt('cache', join(DESKTOP, '.cache')));
const OUT = resolve(opt('out', join(DESKTOP, 'resources', 'pg')));
const FROM = opt('from-dir', null);
const ARCH = opt('arch', process.arch);
const PLAT = process.platform;

const KEEP_BIN = ['postgres', 'pg_ctl', 'initdb', 'pg_dump', 'pg_restore', 'psql', 'pg_isready', 'pg_controldata'];
// Server modules initdb or a plain server loads. The bff creates no extensions (bff/src/lib/migrate.ts:5-6).
const KEEP_LIB = (name) => /^(plpgsql|dict_snowball|libpqwalreceiver|pgoutput)\b/.test(name) || /_and_|^euc2004_sjis2004|^utf8_and/.test(name);
const DROP_SHARE = new Set(['locale', 'contrib', 'doc', 'man']);

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout;
}
function du(p) {
  const st = lstatSync(p);
  if (!st.isDirectory()) return st.size;
  return readdirSync(p).reduce((n, e) => n + du(join(p, e)), 0);
}
const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;

async function download(url, file) {
  if (existsSync(file)) { console.log(`cached: ${file}`); return; }
  mkdirSync(dirname(file), { recursive: true });
  const t0 = Date.now();
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`GET ${url}: ${r.status}`);
  await pipeline(Readable.fromWeb(/** @type {any} */ (r.body)), createWriteStream(`${file}.part`));
  cpSync(`${file}.part`, file);
  rmSync(`${file}.part`);
  console.log(`downloaded ${url} (${mb(statSync(file).size)}) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const bundle = { version: VERSION.split('-')[0], edbBuild: VERSION, major: '16', platform: PLAT, arch: ARCH, source: null, sha256: null, systemDeps: [], appLocalRuntime: [], files: 0, bytes: 0 };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

if (FROM) {
  // Linux dev only.
  for (const d of ['bin', 'lib', 'share']) cpSync(join(FROM, d), join(OUT, d), { recursive: true, verbatimSymlinks: false });
  bundle.source = `local:${FROM}`;
} else {
  const zipName = `postgresql-${VERSION}-${PLAT === 'win32' ? 'windows-x64' : PLAT === 'darwin' ? 'osx' : 'unsupported'}-binaries.zip`;
  if (zipName.includes('unsupported')) throw new Error(`no EDB binaries for ${PLAT}; use --from-dir`);
  const url = `https://get.enterprisedb.com/postgresql/${zipName}`;
  const zip = join(CACHE, zipName);
  await download(url, zip);
  bundle.source = url;
  bundle.sha256 = sha256(zip);
  const x = join(CACHE, `x-${VERSION}-${PLAT}`);
  if (!existsSync(join(x, 'pgsql', 'bin'))) {
    rmSync(x, { recursive: true, force: true });
    mkdirSync(x, { recursive: true });
    const t0 = Date.now();
    // bsdtar reads zip on both OSes. On Windows name System32's tar explicitly: Git's GNU tar can be first on PATH and cannot.
    const tar = PLAT === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    sh(tar, ['-xf', zip, '-C', x, 'pgsql/bin', 'pgsql/lib', 'pgsql/share']);
    console.log(`extracted in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  const src = join(x, 'pgsql');
  if (PLAT === 'win32') buildWindows(src);
  else buildMac(src);
}

function copyShare(src) {
  mkdirSync(join(OUT, 'share'), { recursive: true });
  for (const e of readdirSync(join(src, 'share'))) {
    if (DROP_SHARE.has(e)) continue;
    // macOS nests the server's files one level down (share/postgresql); keep the layout the binaries expect.
    cpSync(join(src, 'share', e), join(OUT, 'share', e), { recursive: true });
  }
}

function buildWindows(src) {
  const bin = join(src, 'bin');
  mkdirSync(join(OUT, 'bin'), { recursive: true });
  mkdirSync(join(OUT, 'lib'), { recursive: true });
  const have = new Map(readdirSync(bin).map((f) => [f.toLowerCase(), f]));
  const queue = KEEP_BIN.map((b) => join(bin, `${b}.exe`));
  for (const f of readdirSync(join(src, 'lib'))) {
    if (f.endsWith('.dll') && KEEP_LIB(f)) {
      copyFileSync(join(src, 'lib', f), join(OUT, 'lib', f));
      queue.push(join(src, 'lib', f));
    }
  }
  const kept = new Set();
  const system = new Set();
  while (queue.length) {
    const f = queue.shift();
    if (!f || kept.has(f)) continue;
    kept.add(f);
    if (dirname(f) === bin) copyFileSync(f, join(OUT, 'bin', basename(f)));
    for (const dep of peImports(f)) {
      const local = have.get(dep.toLowerCase());
      if (local) queue.push(join(bin, local));
      else if (!/^postgres\.exe$/i.test(dep)) system.add(dep.toLowerCase());
    }
  }
  copyShare(src);
  bundle.systemDeps = [...system].sort();
  // The VC++ runtime: present on CI runners and most PCs, absent on a fresh Windows. App-local copies are
  // Microsoft's supported alternative to running the redistributable installer.
  const want = bundle.systemDeps.filter((d) => /^(vcruntime|msvcp|concrt)/i.test(d));
  const redist = findVcRedist();
  for (const d of want) {
    const from = redist.map((dir) => join(dir, d)).find((p) => existsSync(p));
    if (!from) { console.warn(`WARN no app-local copy found for ${d}`); continue; }
    copyFileSync(from, join(OUT, 'bin', d));
    bundle.appLocalRuntime.push({ dll: d, from });
  }
}

function findVcRedist() {
  const dirs = [];
  try {
    const vswhere = join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    const inst = sh(vswhere, ['-latest', '-products', '*', '-property', 'installationPath']).trim();
    const base = join(inst, 'VC', 'Redist', 'MSVC');
    for (const v of readdirSync(base).sort().reverse()) {
      const x64 = join(base, v, 'x64');
      if (!existsSync(x64)) continue;
      for (const d of readdirSync(x64)) if (/^Microsoft\.VC\d+\.CRT$/.test(d)) dirs.push(join(x64, d));
    }
  } catch (e) {
    console.warn(`vswhere: ${String(e).slice(0, 200)}`);
  }
  dirs.push(join(process.env.SystemRoot || 'C:\\Windows', 'System32'));
  return dirs;
}

function machoArchs(f) {
  const out = spawnSync('lipo', ['-archs', f], { encoding: 'utf8' });
  return out.status === 0 ? out.stdout.trim().split(/\s+/) : null;
}

function buildMac(src) {
  const arch = ARCH === 'x64' ? 'x86_64' : 'arm64';
  mkdirSync(join(OUT, 'bin'), { recursive: true });
  mkdirSync(join(OUT, 'lib', 'postgresql'), { recursive: true });
  const thin = (from, to) => {
    const archs = machoArchs(from);
    if (archs && archs.length > 1) sh('lipo', [from, '-thin', arch, '-output', to]);
    else copyFileSync(from, to);
  };
  const queue = [];
  for (const b of KEEP_BIN) { thin(join(src, 'bin', b), join(OUT, 'bin', b)); queue.push(join(OUT, 'bin', b)); }
  for (const f of readdirSync(join(src, 'lib', 'postgresql'))) {
    if (f.endsWith('.dylib') && KEEP_LIB(f)) { thin(join(src, 'lib', 'postgresql', f), join(OUT, 'lib', 'postgresql', f)); queue.push(join(OUT, 'lib', 'postgresql', f)); }
  }
  const system = new Set();
  const done = new Set();
  while (queue.length) {
    const f = queue.shift();
    if (!f || done.has(f)) continue;
    done.add(f);
    const lines = sh('otool', ['-L', f]).split('\n').slice(1).map((l) => l.trim().split(' (')[0]).filter(Boolean);
    for (const dep of lines) {
      const m = /^@(?:rpath|loader_path\/\.\.\/lib|loader_path)\/(.+)$/.exec(dep);
      if (!m) { system.add(dep); continue; }
      const name = basename(m[1]);
      const to = join(OUT, 'lib', name);
      if (!existsSync(to)) {
        const from = join(src, 'lib', name);
        if (!existsSync(from)) throw new Error(`${basename(f)} needs ${dep}, not in the zip`);
        thin(realpathSync(from), to);
        queue.push(to);
      }
    }
  }
  copyShare(src);
  bundle.systemDeps = [...system].sort();
  // Signature state after thinning, per file. Kept honest: electron-builder may re-sign these later.
  const sig = {};
  for (const f of [...done]) {
    const r = spawnSync('codesign', ['--verify', '--strict', f], { encoding: 'utf8' });
    sig[f.replace(OUT + '/', '')] = r.status === 0 ? 'valid' : `invalid: ${(r.stderr || '').trim().split('\n')[0]}`;
  }
  bundle.signatures = sig;
}

// Prove the pruned tree runs from where it is (a relocation away from the zip's own layout).
const exe = (n) => join(OUT, 'bin', PLAT === 'win32' ? `${n}.exe` : n);
const env = { ...process.env, ...(PLAT === 'linux' ? { LD_LIBRARY_PATH: join(OUT, 'lib') } : {}) };
bundle.selfTest = {};
for (const n of ['postgres', 'initdb', 'pg_ctl', 'pg_dump', 'psql']) {
  const r = spawnSync(exe(n), ['--version'], { encoding: 'utf8', env });
  bundle.selfTest[n] = r.status === 0 ? r.stdout.trim() : `FAILED (${r.status}): ${(r.stderr || String(r.error)).trim().slice(0, 300)}`;
}
const count = (p) => (lstatSync(p).isDirectory() ? readdirSync(p).reduce((n, e) => n + count(join(p, e)), 0) : 1);
bundle.files = count(OUT);
bundle.bytes = du(OUT);
bundle.parts = { bin: mb(du(join(OUT, 'bin'))), lib: mb(du(join(OUT, 'lib'))), share: mb(du(join(OUT, 'share'))) };
writeFileSync(join(OUT, 'PG_BUNDLE.json'), JSON.stringify(bundle, null, 2));
console.log(JSON.stringify({ ...bundle, signatures: undefined }, null, 2));
console.log(`pg-dist: ${bundle.files} files, ${mb(bundle.bytes)} -> ${OUT}`);
const bad = Object.entries(bundle.selfTest).filter(([, v]) => v.startsWith('FAILED'));
if (bad.length) { console.error(`pg-dist: self-test FAILED for ${bad.map(([k]) => k).join(', ')}`); process.exit(1); }
