// The CI checks' runAsync (scripts/ci/lib.mjs): once the app has exited, its pipes must not keep the check alive.
// An app frozen by an uncaught exception (childlog.js) is killed at smoke()'s timeout before its ordered stop, and
// the postgres.exe it started through pg_ctl -- holding inherited copies of the app's stdout and stderr -- runs on.
// smoke.mjs then recorded its FAIL at 10:00 and sat 25 minutes until the step was cancelled (release run
// 37964433491, attempt 2). Here a real grandchild plays postgres: started by the "app", holding its pipes, outliving it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const lib = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ci', 'lib.mjs')).href;

test("runAsync: a grandchild still holding the app's pipes does not keep the check alive", () => {
  // Reintroduce by dropping the unref() in runAsync's 'exit': the check lives until the grandchild exits (60 s),
  // and "the check was kept alive by its app's grandchild" fails at the 15 s limit below.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uchi-runasync-'));
  const pidFile = path.join(tmp, 'grandchild.pid');
  const app = path.join(tmp, 'app.mjs');
  const check = path.join(tmp, 'check.mjs');
  fs.writeFileSync(app, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });",
    `writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
    'g.unref();',
    "console.log('app: started the grandchild, exiting');",
  ].join('\n'));
  fs.writeFileSync(check, [
    `import { runAsync } from ${JSON.stringify(lib)};`,
    `const r = await runAsync(process.execPath, [${JSON.stringify(app)}], { timeoutMs: 30_000 });`,
    "console.log(`resolved ${r.code}`);",
  ].join('\n'));
  try {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [check], { encoding: 'utf8', timeout: 15_000 });
    const ms = Date.now() - t0;
    assert.ok(fs.existsSync(pidFile), `the app never started its grandchild: ${r.stdout}${r.stderr}`);
    assert.equal(r.signal, null, `the check was kept alive by its app's grandchild (killed after ${ms} ms)`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^resolved 0$/m);
  } finally {
    try { process.kill(Number(fs.readFileSync(pidFile, 'utf8'))); } catch { /* gone */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
