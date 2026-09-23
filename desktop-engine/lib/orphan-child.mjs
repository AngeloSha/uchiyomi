// Stand-in for a desktop shell that crashes: starts the engine from a launch description, reports the java pid,
// then idles until it is killed. Used by spike.mjs to prove the shim's lifeline takes java down with it.
import fs from 'node:fs';
import { startEngine } from './engine.mjs';

const l = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const h = startEngine(l, { logFile: process.argv[3] });
process.stdout.write(`${JSON.stringify({ javaPid: h.pid })}\n`);
setInterval(() => {}, 1 << 30);
