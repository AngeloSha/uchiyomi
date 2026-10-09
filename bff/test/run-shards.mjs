// CI's way of running the bff suite: every test file once, a few at a time, each in a process of its own and on a
// database of its own that is created fresh for it.
//
// Why not `npm test`: that runs the files one after another on one database, and CI's Tests job grew with the suite
// (38 minutes mid-September, 54-58 by the 26th, past the old 60-minute limit once). The files cannot simply run in
// parallel on one database -- they truncate and seed the same tables -- so each worker gets its own database, and it
// is recreated before every file, which also means no file can lean on what an earlier one left behind (in the
// one-database run a few did, without anyone meaning them to).
//
//   TEST_DATABASE_URL=postgres://test:test@127.0.0.1:5432/uchiyomi_test node test/run-shards.mjs
//   TEST_SHARDS=3 (default) sets how many files run at once. Extra arguments narrow the files: a substring each.
//   TEST_TIMEOUT_MS (5 min) fails one test that runs longer; TEST_FILE_TIMEOUT_MS (10 min) stops a whole file.
//
// The output of a file is printed in one piece when it ends, so parallel files never interleave. The exit code is 1
// when any file failed (or could not run), and the summary at the end names them.
import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const here = new URL('.', import.meta.url).pathname;
const bff = join(here, '..');
const base = process.env.TEST_DATABASE_URL;
if (!base) {
  console.error('run-shards: TEST_DATABASE_URL is not set');
  process.exit(2);
}
const workers = Math.max(1, Number(process.env.TEST_SHARDS) || 3);
const only = process.argv.slice(2);

// Biggest first: the long integration files start early, so the workers finish close together.
const files = readdirSync(here)
  .filter((f) => f.endsWith('.test.ts'))
  .filter((f) => !only.length || only.some((o) => f.includes(o)))
  .map((f) => ({ f, size: statSync(join(here, f)).size }))
  .sort((a, b) => b.size - a.size || a.f.localeCompare(b.f))
  .map((x) => x.f);

const admin = new URL(base);
admin.pathname = '/postgres';
// Worker k's database: the configured one's name with _w<k> after it (uchiyomi_test_w1, ...).
const dbUrl = (k) => {
  const u = new URL(base);
  u.pathname = `/${u.pathname.slice(1) || 'uchiyomi_test'}_w${k}`;
  return u.toString();
};

// A database that has just started can refuse connections for a few seconds (the image's entrypoint restarts it
// once after initialising), so the first connect is retried briefly rather than failing every file at once.
async function connectAdmin() {
  for (let tries = 0; ; tries++) {
    const c = new pg.Client({ connectionString: admin.toString() });
    try {
      await c.connect();
      return c;
    } catch (e) {
      await c.end().catch(() => {});
      if (tries >= 30 || e?.code !== 'ECONNREFUSED') throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function freshDb(k) {
  const name = new URL(dbUrl(k)).pathname.slice(1);
  const c = await connectAdmin();
  try {
    await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await c.query(`CREATE DATABASE "${name}"`);
  } finally {
    await c.end();
  }
}

// A file that never ends used to hold its worker until the job's own limit (90 minutes) and print nothing at all: its
// output is kept until it ends. v0.56.0's PR lost two CI runs that way to chapterFallback.int, which takes about a
// minute. Now one test is failed after TEST_TIMEOUT_MS (node's --test-timeout, so the file goes on and says which), and
// a file still running after TEST_FILE_TIMEOUT_MS is stopped with everything under it and printed as it stood.
const testLimitMs = Number(process.env.TEST_TIMEOUT_MS) || 5 * 60_000;
const fileLimitMs = Number(process.env.TEST_FILE_TIMEOUT_MS) || 10 * 60_000;

function runFile(f, k) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', `--test-timeout=${testLimitMs}`, join('test', f)], {
      cwd: bff,
      env: { ...process.env, TEST_DATABASE_URL: dbUrl(k) },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so a stop reaches the test process `node --test` starts under it too.
      detached: true,
    });
    const out = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => out.push(d));
    let timedOut = false;
    const limit = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, fileLimitMs);
    child.on('close', (code, signal) => {
      clearTimeout(limit);
      const note = timedOut ? `\nrun-shards: ${f} was still running after ${fileLimitMs / 60_000} min and was stopped; its output so far is above\n` : '';
      resolve({ f, code: timedOut ? 1 : code ?? 1, signal, ms: Date.now() - started, text: Buffer.concat(out).toString() + note });
    });
  });
}

const count = (text, label) => {
  const m = text.match(new RegExp(`^ℹ ${label} (\\d+)`, 'm'));
  return m ? Number(m[1]) : 0;
};

const queue = [...files];
const results = [];
const t0 = Date.now();
async function worker(k) {
  for (let f = queue.shift(); f; f = queue.shift()) {
    let r;
    try {
      await freshDb(k);
      r = await runFile(f, k);
    } catch (e) {
      r = { f, code: 1, signal: null, ms: 0, text: `run-shards: could not prepare a database for ${f}: ${e?.message || e}\n` };
    }
    results.push(r);
    const mark = r.code === 0 ? '✔' : '✖';
    process.stdout.write(`\n${mark} ${f} (${(r.ms / 1000).toFixed(1)} s, worker ${k})\n${r.text}`);
  }
}

console.log(`run-shards: ${files.length} files on ${workers} workers`);
await Promise.all(Array.from({ length: workers }, (_, i) => worker(i + 1)));

const failed = results.filter((r) => r.code !== 0);
const total = { tests: 0, pass: 0, fail: 0, skipped: 0 };
for (const r of results) for (const k of Object.keys(total)) total[k] += count(r.text, k);
const mins = ((Date.now() - t0) / 60000).toFixed(1);
console.log(`\nrun-shards: ${results.length} files in ${mins} min -- tests ${total.tests}, pass ${total.pass}, fail ${total.fail}, skipped ${total.skipped}`);
if (failed.length) {
  console.log(`run-shards: ${failed.length} file(s) failed:`);
  for (const r of failed) console.log(`  ${r.f} (exit ${r.code}${r.signal ? `, ${r.signal}` : ''})`);
  process.exit(1);
}
