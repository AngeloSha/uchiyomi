// Windows console test: a parent WITHOUT a console, like Electron's GUI-subsystem main process. spike.mjs starts
// this script with `detached: true` (DETACHED_PROCESS), and it spawns java exactly as the shell would, with
// windowsHide on or off. A console child of a console-less parent gets a brand-new console WINDOW unless
// CREATE_NO_WINDOW is set -- that window is the flash the check looks for.
import fs from 'node:fs';
import { startEngine } from './engine.mjs';

const l = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const hide = process.argv[3] === '1';
const h = startEngine(l, { windowsHide: hide, logFile: process.argv[4] });
process.stdout.write(`${JSON.stringify({ javaPid: h.pid })}\n`);
setInterval(() => {}, 1 << 30);
