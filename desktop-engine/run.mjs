#!/usr/bin/env node
// Launch an engine pack the way the desktop shell will (design-shell.md §5), for manual runs.
//
//   node run.mjs --pack build/engine-pack-<platform>.zip --runtime <dir> --root <dir>
//                [--port N] [--kcef] [--path-mode env|cmdline] [--fs-url URL] [--timeout-s 180]
//
// Unpacks the pack into --runtime (unless it already holds this pack), starts a FlareSolverr stub unless
// --fs-url is given, generates random basic-auth credentials, spawns java hidden, polls
// GET /api/v1/settings/about for 200/401, prints the timing and the launch command (secrets masked), then
// runs until Ctrl-C or until this process's stdin closes, and stops the engine through the shim.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildLaunch, describeLaunch, freePort, startEngine, stopEngine, unpackPack, waitReady } from './lib/engine.mjs';
import { startSolverStub } from './lib/stubs.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes(k);

const pack = arg('--pack');
const runtimeDir = path.resolve(arg('--runtime', 'engine-runtime'));
const rootDir = path.resolve(arg('--root', 'engine-data'));
const port = Number(arg('--port', 0)) || await freePort();
if (!fs.existsSync(path.join(runtimeDir, 'engine.json'))) {
  if (!pack) throw new Error('--pack is required for a fresh --runtime');
  const u = await unpackPack(path.resolve(pack), runtimeDir);
  console.log(`unpacked ${u.files} files (${(u.bytes / 1048576).toFixed(1)} MiB) in ${u.ms} ms`);
}
fs.mkdirSync(rootDir, { recursive: true });
const stub = arg('--fs-url') ? null : await startSolverStub();
const fsUrl = arg('--fs-url', stub?.url);
const user = crypto.randomBytes(12).toString('hex');
const pass = crypto.randomBytes(24).toString('hex');
const l = buildLaunch({ runtimeDir, rootDir, port, fsUrl, user, pass, kcef: flag('--kcef') ? true : false,
  pathMode: arg('--path-mode', 'env'), tmpDir: path.join(rootDir, 'tmp') });
console.log(`launch: ${describeLaunch(l, [pass, stub?.token])}`);
const h = startEngine(l, { logFile: path.join(rootDir, 'engine-stdout.log') });
const r = await waitReady(h, port, { timeoutMs: Number(arg('--timeout-s', 180)) * 1000 });
if (!r.ready) {
  console.error(`NOT READY (${r.reason}) after ${r.ms} ms\n${h.tail.slice(-4000)}`);
  await stopEngine(h, { mode: 'kill' });
  process.exit(1);
}
console.log(`READY in ${r.ms} ms: http://127.0.0.1:${port} (HTTP ${r.status} unauthenticated) pid ${h.pid}`);
console.log(`credentials: user=${user} pass=${pass}`);
const stop = async () => { const s = await stopEngine(h, { mode: 'graceful' }); console.log(`stopped in ${s.ms} ms (code ${s.code}, forced ${s.forced})`); await stub?.close(); process.exit(0); };
process.on('SIGINT', stop);
process.stdin.on('end', stop);
process.stdin.resume();
