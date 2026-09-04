// The entrypoint runs a database when it is not given one, and only then.
//
// docker-entrypoint.sh is the whole one-container story: with DATABASE_URL unset it initialises Postgres in
// /data/pg, starts it on a socket, points the app at it, forwards SIGTERM, and stops it after the app is gone.
// With DATABASE_URL set it must do NONE of that -- every install before v0.18.0 has one set, and an
// entrypoint that started a second Postgres beside their real one would be a very quiet disaster.
//
// Driven for real, as a shell script, with fake Postgres binaries on PATH that record their arguments. Not
// as root, so the script takes its non-root branch; the root-only parts (chown, su-exec) are three lines
// that the image build and the e2e run exercise. Everything else -- the trigger, the argument shapes, the
// version guard, the ordering, the signal handling, the watchdog -- is here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '..', 'docker-entrypoint.sh');

/** A sandbox: fake binaries that log to FAKELOG, an empty PGDATA, a socket dir, and an "app" to run. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'uchiyomi-entrypoint-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const log = join(root, 'calls.log');
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "$FAKELOG"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  fake('pg_ctl', `case " $* " in
  *" --version "*) echo "pg_ctl (PostgreSQL) 16.15"; exit 0;;
  *" start "*)  [ -f "$FAKE_PG_REFUSE_START" ] && exit 1; touch "$PGDATA/postmaster.pid"; exit 0;;
  *" status "*) [ -f "$PGDATA/postmaster.pid" ] && exit 0 || exit 3;;
  *" stop "*)   rm -f "$PGDATA/postmaster.pid"; exit 0;;
esac; exit 0`);
  // initdb records what it saw of the user lookup: the real one refuses a uid with no passwd entry.
  fake('initdb', `env | grep -E '^(LD_PRELOAD|NSS_WRAPPER_PASSWD)=' > "$FAKELOG.initdb.env"; mkdir -p "$PGDATA" && echo 16 > "$PGDATA/PG_VERSION"`);
  fake('psql', `[ -f "$PGDATA/.dbcreated" ] && echo 1 || echo ""`);
  fake('createdb', `touch "$PGDATA/.dbcreated"`);
  fake('pg_isready', 'exit 0');
  // The passwd lookup is the test's to decide. On a GitHub runner the process uid HAS an entry, so without
  // this the "no passwd entry" tests never reached the nss_wrapper path they assert on -- green locally
  // (a container uid with no entry), red in CI. Found by CI; the fake answers "not found" unless told.
  fake('getent', `[ -f "$FAKE_GETENT_FOUND" ] && { echo "app:x:$2:$2::/tmp:/bin/sh"; exit 0; }; exit 2`);
  // The "app": records its environment, optionally waits, optionally reports a signal, exits as told.
  fake('app', `env | grep -E '^(DATABASE_URL|EMBEDDED_DB|LD_PRELOAD)=' > "$FAKELOG.env"
trap 'echo "app got TERM" >> "$FAKELOG"; exit 0' TERM
if [ -n "\${FAKE_SLEEP:-}" ]; then sleep "$FAKE_SLEEP" & wait $!; fi
exit "\${FAKE_EXIT:-0}"`);
  const pgdata = join(root, 'pg'); const sock = join(root, 'sock');
  // A stand-in for libnss_wrapper.so. The test uid has no passwd entry in the runner's container either,
  // so without this the non-root path has no remedy and refuses -- which is its own test below.
  const nss = join(root, 'libnss_wrapper.so'); writeFileSync(nss, '');
  return { root, bin, log, pgdata, sock, nss, app: join(bin, 'app') };
}

interface Run { code: number | null; signal: string | null; out: string; err: string; calls: string[]; env: Record<string, string>; initdbEnv: string; ms: number }

function run(sb: ReturnType<typeof sandbox>, env: Record<string, string | undefined>, opts: { termAfterMs?: number; killPgAfterMs?: number } = {}): Promise<Run> {
  const t0 = Date.now();
  // The fakes append; a second run in the same sandbox must not read the first run's calls.
  rmSync(sb.log, { force: true }); rmSync(`${sb.log}.env`, { force: true }); rmSync(`${sb.log}.initdb.env`, { force: true });
  const child = spawn('sh', [SCRIPT, sb.app], {
    env: {
      PATH: `${sb.bin}:${process.env.PATH}`, HOME: sb.root, FAKELOG: sb.log, PGDATA: sb.pgdata, PGSOCK: sb.sock, NSS_WRAPPER_LIB: sb.nss,
      FAKE_PG_REFUSE_START: join(sb.root, 'refuse-start'), FAKE_GETENT_FOUND: join(sb.root, 'getent-found'),
      ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined) as [string, string][]),
    },
  });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  if (opts.termAfterMs) setTimeout(() => child.kill('SIGTERM'), opts.termAfterMs);
  if (opts.killPgAfterMs) setTimeout(() => rmSync(join(sb.pgdata, 'postmaster.pid'), { force: true }), opts.killPgAfterMs);
  return new Promise((resolve) => child.on('exit', (code, signal) => {
    const calls = existsSync(sb.log) ? readFileSync(sb.log, 'utf8').trim().split('\n').filter(Boolean) : [];
    const initdbEnv = existsSync(`${sb.log}.initdb.env`) ? readFileSync(`${sb.log}.initdb.env`, 'utf8') : '';
    const envText = existsSync(`${sb.log}.env`) ? readFileSync(`${sb.log}.env`, 'utf8') : '';
    const e: Record<string, string> = {};
    for (const l of envText.split('\n')) { const i = l.indexOf('='); if (i > 0) e[l.slice(0, i)] = l.slice(i + 1); }
    resolve({ code, signal, out, err, calls, env: e, initdbEnv, ms: Date.now() - t0 });
  }));
}
const pgCalls = (r: Run) => r.calls.filter((c) => /^(pg_ctl|initdb|psql|createdb)/.test(c));

test('with DATABASE_URL set, nothing about Postgres happens and the app gets that URL', async () => {
  const sb = sandbox();
  const r = await run(sb, { DATABASE_URL: 'postgres://u:p@db:5432/yomi' });
  // Reintroduce by removing the `[ -z DATABASE_URL ]` switch: every existing install starts a second
  // Postgres beside its real one, in a /data that does not exist, and the container fails to boot.
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(pgCalls(r), [], 'a Postgres binary was called with an external database configured');
  assert.equal(r.env.DATABASE_URL, 'postgres://u:p@db:5432/yomi');
  assert.equal(r.env.EMBEDDED_DB, undefined, 'EMBEDDED_DB must not be set on the external path');
  assert.ok(!existsSync(sb.pgdata), 'a data directory was created for a database that is not ours');
});

test('THE EMBEDDED PATH: initdb once, socket-only start, the app pointed at it, stop after the app exits', async () => {
  const sb = sandbox();
  const r = await run(sb, { DATABASE_URL: undefined, FAKE_EXIT: '3' });
  assert.equal(r.code, 3, `the container must exit with the APP's code so docker ps tells the truth; got ${r.code}\n${r.err}`);
  const init = r.calls.filter((c) => c.startsWith('initdb'));
  assert.equal(init.length, 1, 'initdb must run exactly once on first start');
  assert.match(init[0], new RegExp(`-D ${sb.pgdata}\\b`)); assert.match(init[0], /-U yomi\b/); assert.match(init[0], /--auth=trust/);
  const start = r.calls.find((c) => /^pg_ctl .* start/.test(c))!;
  assert.ok(start, 'pg_ctl start was never called');
  // Reintroduce by dropping listen_addresses='': the database listens on TCP inside the container's network
  // namespace with trust auth -- reachable by anything else on that network.
  assert.match(start, /listen_addresses=''/, 'the embedded database must not listen on TCP');
  assert.match(start, new RegExp(`-k ${sb.sock}\\b`), 'the socket directory must be the one the app is told about');
  assert.match(start, /\s-w\b/, 'start must wait for the server, or the app races recovery');
  assert.ok(r.calls.some((c) => c.startsWith('createdb')), 'the yomi database was never created');
  assert.equal(r.env.DATABASE_URL, `postgres://yomi@/yomi?host=${sb.sock}`, 'the app was pointed somewhere else');
  assert.equal(r.env.EMBEDDED_DB, '1');
  const order = r.calls.map((c) => c.split(' ')[0]);
  assert.ok(order.indexOf('app') > order.lastIndexOf('createdb'), 'the app started before the database was ready');
  const stop = r.calls.findIndex((c) => /^pg_ctl .* stop/.test(c));
  assert.ok(stop > order.indexOf('app'), 'Postgres was stopped before, or never after, the app');
  assert.match(r.calls[stop], /-m fast/);
  assert.ok(!existsSync(join(sb.sock, '.embedded')), 'the healthcheck marker outlived the database');
});

test('a uid with no passwd entry is given one for Postgres, and the app is not preloaded', async () => {
  // The first thing the real boot found, after every fake had passed: initdb refuses "could not look up
  // effective user ID 1003: user does not exist", and PUID is usually exactly such a uid. Not root here, so
  // the remedy under test is nss_wrapper; the root path (adduser) is exercised by the image boot.
  const sb = sandbox();
  const r = await run(sb, { DATABASE_URL: undefined });
  assert.equal(r.code, 0, r.err);
  // Reintroduce by deleting ensure_passwd_entry: initdb runs bare and, on a real image, refuses.
  assert.match(r.initdbEnv, new RegExp(`LD_PRELOAD=${sb.nss}`), 'initdb did not get the nss_wrapper preload');
  assert.match(r.initdbEnv, /NSS_WRAPPER_PASSWD=/, 'no passwd file was handed to nss_wrapper');
  assert.match(r.out, /no passwd entry; Postgres will run as it through nss_wrapper/);
  assert.equal(r.env.LD_PRELOAD, undefined, 'the preload leaked into the app');
});

test('a uid that already has a passwd entry needs no remedy', async () => {
  const sb = sandbox();
  writeFileSync(join(sb.root, 'getent-found'), '');
  const r = await run(sb, { DATABASE_URL: undefined });
  assert.equal(r.code, 0, r.err);
  assert.ok(!/LD_PRELOAD/.test(r.initdbEnv), 'nss_wrapper was preloaded for a uid that has an entry');
  assert.ok(!/passwd entry/.test(r.out + r.err), 'a remedy was announced for a uid that needs none');
});

test('with neither remedy available it refuses, and says what to do instead', async () => {
  const sb = sandbox();
  rmSync(sb.nss);
  const r = await run(sb, { DATABASE_URL: undefined });
  assert.notEqual(r.code, 0, 'started Postgres as a uid it cannot run as');
  assert.match(r.err, /no passwd entry and nss_wrapper is not available/);
  assert.match(r.err, /PUID\/PGID/);
  assert.ok(!r.calls.some((c) => c.startsWith('initdb')), 'initdb was attempted anyway');
});

test('a second start finds the data directory and does not initdb again', async () => {
  const sb = sandbox();
  await run(sb, { DATABASE_URL: undefined });
  const r = await run(sb, { DATABASE_URL: undefined });
  assert.equal(r.code, 0, r.err);
  // Reintroduce by testing for the directory instead of PG_VERSION: mkdir -p runs first, so the directory
  // always exists and initdb never runs -- or runs every time, destroying the data, depending on the guard.
  assert.equal(r.calls.filter((c) => c.startsWith('initdb')).length, 0, 'initdb ran on an existing data directory');
  assert.ok(r.calls.some((c) => /^pg_ctl .* start/.test(c)));
});

test('a data directory from another major is refused, with the upgrade path named', async () => {
  const sb = sandbox();
  mkdirSync(sb.pgdata, { recursive: true }); writeFileSync(join(sb.pgdata, 'PG_VERSION'), '15\n');
  const r = await run(sb, { DATABASE_URL: undefined });
  // Reintroduce by deleting the guard: Postgres 16 crash-loops on a 15 directory with an error nobody
  // should have to decode from `docker logs`, and nothing says where the upgrade path is written down.
  assert.notEqual(r.code, 0, 'a 15 data directory was opened by a 16 server');
  assert.match(r.err, /Postgres 15/); assert.match(r.err, /Postgres 16/);
  assert.match(r.err, /MIGRATING\.md#postgres-upgrade/, 'the refusal must say where the upgrade is documented');
  assert.ok(!r.calls.some((c) => /^pg_ctl .* start/.test(c)), 'the server was started anyway');
  assert.ok(!r.calls.some((c) => c.startsWith('app')), 'the app was started against a database that cannot open');
});

test('SIGTERM reaches the app first, and Postgres stops after it', async () => {
  const sb = sandbox();
  const r = await run(sb, { DATABASE_URL: undefined, FAKE_SLEEP: '30' }, { termAfterMs: 1500 });
  // Reintroduce by exec'ing the app instead of supervising it: the shell is replaced, the trap is gone,
  // and nothing stops Postgres -- docker kills it mid-checkpoint at the grace period.
  assert.ok(r.calls.includes('app got TERM'), `the app never received SIGTERM:\n${r.calls.join('\n')}`);
  const termAt = r.calls.indexOf('app got TERM');
  const stopAt = r.calls.findIndex((c) => /^pg_ctl .* stop/.test(c));
  assert.ok(stopAt > termAt, 'Postgres was stopped before the app had gone');
  assert.equal(r.code, 0);
  assert.ok(r.ms < 15000, `took ${r.ms} ms; the app was left to its 30 s sleep`);
});

test('if Postgres dies underneath the app, the app is stopped so the container restarts whole', async () => {
  const sb = sandbox();
  const r = await run(sb, { DATABASE_URL: undefined, FAKE_SLEEP: '60' }, { killPgAfterMs: 1500 });
  // Reintroduce by deleting the watcher: the app keeps running against a dead socket, every request fails,
  // and `restart: unless-stopped` never fires because the container never exits.
  assert.match(r.err, /Postgres has stopped; stopping the app/);
  assert.ok(r.calls.includes('app got TERM'), 'the app was not told');
  assert.ok(r.ms < 20000, `took ${r.ms} ms; the watcher did not act`);
});
