// --smoke's own handlers for the main process's uncaught exceptions and unhandled rejections (src/uncaught.js).
// Without them an uncaught exception got Electron's MODAL error box, which froze the smoke until lib.mjs smoke()
// killed it at 10 minutes with no result (the S2-ii hang of the v0.55.9 and v0.55.10 release runs). That Electron
// skips its box once another listener exists is Electron's code (lib/browser/init.ts, listenerCount > 1), not
// testable without Electron; what is tested here is ours: a real process that survives each kind, every one kept with
// its stack and on disk at once, and main.js wiring it into --smoke only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => path.join(here, '..', 'src', p);

test('an uncaught exception or unhandled rejection is kept with its stack and logged, and the process lives on', () => {
  // Reintroduce by dropping either process.on line from uncaught.js: without the uncaughtException one the process
  // dies at the first throw (status 1); without the unhandledRejection one Node raises each rejection as an uncaught
  // exception and the kinds below are wrong.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uchi-uncaught-'));
  const script = path.join(tmp, 'main.cjs');
  const out = path.join(tmp, 'seen.json');
  fs.writeFileSync(script, `
    const fs = require('node:fs');
    const path = require('node:path');
    const log = require(${JSON.stringify(src('log.js'))});
    log.open(${JSON.stringify(path.join(tmp, 'logs'))});
    const seen = require(${JSON.stringify(src('uncaught.js'))}).catchUncaught(log);
    // The S2-ii class itself: a line written to a log stream after its end(), with no 'error' listener.
    const w = fs.createWriteStream(path.join(${JSON.stringify(tmp)}, 'bff.log'));
    w.end('last line\\n');
    w.write('a late line\\n');
    setTimeout(() => { throw new Error('thrown in a timer'); }, 0);
    Promise.reject(new Error('rejected and never handled'));
    Promise.reject(undefined);
    setTimeout(() => fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(seen)), 300);
  `);
  try {
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, `the process did not live on: ${r.stderr}`);
    const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
    const kinds = (k) => seen.filter((x) => x.kind === k).map((x) => x.stack);
    const thrown = kinds('uncaughtException');
    const rejected = kinds('unhandledRejection');
    assert.equal(seen.length, 4, JSON.stringify(seen, null, 1));
    assert.ok(thrown.some((s) => /ERR_STREAM_WRITE_AFTER_END|write after end/.test(s) && /\n\s+at /.test(s)), 'the late write, with its stack');
    assert.ok(thrown.some((s) => /^Error: thrown in a timer\n\s+at /.test(s)), 'the throw, with its stack');
    assert.ok(rejected.some((s) => /^Error: rejected and never handled\n\s+at /.test(s)), 'the rejection, with its stack');
    assert.ok(rejected.includes('undefined'), 'a rejection with no Error at all');
    // In desktop.log at once (log.js appends synchronously): what is left to read even if the process then hangs.
    const lines = fs.readFileSync(path.join(tmp, 'logs', 'desktop.log'), 'utf8').split('\n').filter((l) => / ERROR smoke: /.test(l));
    assert.equal(lines.length, 4, lines.join('\n'));
    assert.ok(lines.some((l) => /uncaughtException in the main process -- the smoke fails .*thrown in a timer\\n\s+at /.test(l)), lines.join('\n'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- main.js wiring (static: it needs Electron to run)
test('main.js: the handlers are --smoke only, in place before anything runs, and any one of them fails the smoke', () => {
  // Reintroduce by computing res.ok without `!uncaught.length` (or before the stop in `finally`): the smoke passes
  // over an uncaught exception again, and this names it.
  const m = fs.readFileSync(src('main.js'), 'utf8');
  assert.equal(m.split('catchUncaught(').length - 1, 1, 'catchUncaught is called once');
  const wire = m.indexOf("const uncaught = MODE === 'smoke' ? catchUncaught(log) : [];");
  assert.ok(wire > m.indexOf("const MODE = args.smoke ? 'smoke'"), 'registered once the mode is known, for --smoke only');
  assert.ok(wire < m.indexOf('app.whenReady()'), 'registered before the smoke starts');
  const smoke = m.slice(m.indexOf('async function runSmoke('), m.indexOf('async function smokeEngine('));
  const stop = smoke.indexOf("res.stop = sup ? await sup.stop('smoke')");
  const kept = smoke.indexOf('res.uncaught = uncaught;');
  const ok = smoke.indexOf('res.ok = !res.error && !uncaught.length && ');
  const written = smoke.indexOf('fs.writeFileSync(out, JSON.stringify(res, null, 2));');
  assert.ok(stop > 0 && kept > stop && ok > kept && written > ok, 'the stop -> res.uncaught -> res.ok -> the result file');
});
