#!/usr/bin/env node
// Launch an engine pack the way the app does (src/engine.js buildLaunch: S7's working recipe), for manual runs.
//
//   node engine/run.mjs --pack build/engine-pack-<platform>.zip --runtime <dir> --root <dir> [--port N] [--fs-url URL]
//
// Unpacks the pack into --runtime (unless it already holds one), starts a FlareSolverr stub unless --fs-url is
// given, generates random basic-auth credentials, spawns java hidden, polls GET /api/v1/settings/about for
// 200/401, prints the timing, then runs until Ctrl-C or until this process's stdin closes, and stops the engine
// through the shim's stdin lifeline.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { startSolverStub } from './lib/stubs.mjs';

const require = createRequire(import.meta.url);
const { buildLaunch, probeReady } = require('../src/engine.js');
const archive = require('../src/archive.js');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const pack = arg('--pack');
const runtimeDir = path.resolve(arg('--runtime', 'engine-runtime'));
const rootDir = path.resolve(arg('--root', 'engine-data'));
const port = Number(arg('--port', 0)) || await freePort();
if (!fs.existsSync(path.join(runtimeDir, 'engine.json'))) {
  if (!pack) throw new Error('--pack is required for a fresh --runtime');
  const t0 = Date.now();
  const u = await archive.extractZip(path.resolve(pack), runtimeDir);
  if (process.platform !== 'win32') fs.chmodSync(path.join(runtimeDir, 'jre', 'bin', 'java'), 0o755);
  console.log(`unpacked ${u.files} files (${(u.bytes / 1048576).toFixed(1)} MiB) in ${Date.now() - t0} ms`);
}
fs.mkdirSync(rootDir, { recursive: true });
const stub = arg('--fs-url') ? null : await startSolverStub();
const fsUrl = arg('--fs-url', stub?.url);
const user = crypto.randomBytes(12).toString('hex');
const pass = crypto.randomBytes(24).toString('hex');
const l = buildLaunch({ runtimeDir, rootDir, tmpDir: path.join(rootDir, 'tmp'), port, fsUrl, user, pass });
console.log(`launch: cd ${runtimeDir} && ${l.cmd} ${l.args.join(' ')}`);
const t0 = Date.now();
const child = spawn(l.cmd, l.args, { cwd: l.cwd, env: l.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const log = fs.createWriteStream(path.join(rootDir, 'engine-stdout.log'), { flags: 'a' });
child.stdout.pipe(log);
child.stderr.pipe(log);
let exited = false;
child.once('exit', (code) => { exited = true; console.log(`engine exited ${code}`); });
while (!exited && Date.now() - t0 < Number(arg('--timeout-s', 180)) * 1000 && !(await probeReady(port))) await new Promise((r) => setTimeout(r, 250));
if (exited || !(await probeReady(port))) {
  console.error(`NOT READY after ${Date.now() - t0} ms; see ${path.join(rootDir, 'engine-stdout.log')}`);
  child.kill('SIGKILL');
  process.exit(1);
}
console.log(`READY in ${Date.now() - t0} ms: http://127.0.0.1:${port} pid ${child.pid}`);
console.log(`credentials: user=${user} pass=${pass}`);
const stop = () => { const s = Date.now(); child.stdin.end(); child.once('exit', (code) => { console.log(`stopped in ${Date.now() - s} ms (code ${code})`); void stub?.close(); process.exit(0); }); };
process.on('SIGINT', stop);
process.stdin.on('end', stop);
process.stdin.resume();
