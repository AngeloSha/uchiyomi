// The single container must not quietly lose what nginx was doing for it.
//
// When the web tier was a separate nginx, that nginx was silently responsible for three things nobody
// thought of as application concerns. Moving to one container transfers them to this process, and each one
// fails invisibly rather than loudly:
//
//   * COMPRESSION. nginx gzipped CSS, JS, JSON, SVG and the manifest (web/nginx.conf:30-32). Measured on a
//     live install, dropping it took a cold load from 261 KB of JS and CSS to 736 KB, and stopped
//     compressing every API response too. Nothing breaks. It just gets slower, and only off-LAN.
//   * LIVENESS vs READINESS. nginx answered /healthz itself with a static "ok" and stayed healthy through a
//     database outage, still serving the shell so the app could render an error. /healthz here runs
//     SELECT 1, so pointing a container healthcheck at it makes one Postgres blip mark the whole app
//     unhealthy.
//   * BUILD CONTEXT. Dockerfile.aio builds from the repo ROOT, where web/.dockerignore and bff/.dockerignore
//     do not apply, so `COPY web/ ./` copies the host's node_modules over the ones npm ci just installed --
//     native modules included. CI never sees it because a fresh checkout has none.
//
// The behaviour of compression is tested for real in webRoot.int.test.ts. This file is the cheap static
// guard against someone deleting the registration, or repointing the healthcheck back, and nothing noticing
// until a user on mobile says the app feels slow.
//
// Pure static check. No database, no network, no container.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '..', '..');
const server = readFileSync(join(__dirname, '..', 'src', 'server.ts'), 'utf8');

test('compression is registered, and before the web root', () => {
  assert.match(server, /from '@fastify\/compress'/, 'the compression plugin is not imported');
  const at = server.indexOf('register(compress');
  assert.ok(at > 0, 'compression is imported but never registered');

  // Order matters: the compress hook has to be in place before the static routes are added, or the static
  // export is served straight past it.
  const web = server.indexOf('registerWebRoot(app)');
  assert.ok(web > 0, 'registerWebRoot moved or was renamed');
  assert.ok(at < web, 'compression is registered AFTER the web root, so static files bypass it');
});

test('the container healthcheck probes liveness, not the database', () => {
  assert.match(server, /app\.get\('\/livez'/, 'no /livez route');
  // /healthz stays a readiness probe -- it should still touch the database.
  const healthz = server.slice(server.indexOf("app.get('/healthz'"), server.indexOf("app.get('/healthz'") + 400);
  assert.match(healthz, /SELECT 1/, '/healthz stopped checking the database, so readiness means nothing');

  const dockerfile = readFileSync(join(REPO, 'Dockerfile.aio'), 'utf8');
  const hc = dockerfile.slice(dockerfile.indexOf('HEALTHCHECK'));
  assert.match(hc, /\/livez/, 'the healthcheck probes the database; a Postgres blip marks the app unhealthy');
  assert.ok(!/\/healthz/.test(hc.split('\n').slice(0, 3).join('\n')), 'the healthcheck still points at /healthz');
});

test('the runtime carries pg_dump, so the backup task can actually dump', () => {
  // This is the regression this whole file is named for, and it still got through: bff/Dockerfile installs
  // postgresql*-client explicitly for the backup task, Dockerfile.aio did not, and v0.9.0 and v0.9.1 both
  // shipped writing 20-byte empty archives. Nothing failed loudly -- no log line, and the admin Tasks panel
  // kept showing the last SUCCESSFUL run, which on a migrated install was written by the old split stack.
  const aio = readFileSync(join(REPO, 'Dockerfile.aio'), 'utf8');
  const split = readFileSync(join(REPO, 'bff', 'Dockerfile'), 'utf8');

  // Strip comments first. Both Dockerfiles EXPLAIN why the client is there, so a naive search matches the
  // prose that survives deleting the instruction -- this guard passed a deliberate reintroduction of the bug
  // until it read only what docker actually executes.
  const instructions = (s: string) => s.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  const clientIn = (s: string) => /postgresql\d*-client/.test(instructions(s));
  assert.ok(clientIn(split), 'bff/Dockerfile stopped installing the postgres client — check this test still means anything');
  assert.ok(clientIn(aio),
    'Dockerfile.aio does not install postgresql*-client, so pg_dump is absent and every backup writes an\n' +
    'empty archive while reporting nothing wrong. bff/Dockerfile installs it; the single container must too.');

  // tar and gzip archive CONFIG_DIR (jwt.secret, sites.json, series-art). node:alpine has busybox versions,
  // so this is a presence check on the source rather than the package name.
  assert.match(readFileSync(join(REPO, 'bff', 'src', 'lib', 'backup.ts'), 'utf8'), /spawn\('pg_dump'/,
    'the backup task no longer shells out to pg_dump — this guard is checking for the wrong thing');
});

test('a failed dump is recorded, not silently left as the last success', () => {
  // The other half of the same bug: even once pg_dump is back, a future failure must not leave the panel
  // reporting an older healthy run. Both the writer and the caller have to say so.
  const backup = readFileSync(join(REPO, 'bff', 'src', 'lib', 'backup.ts'), 'utf8');
  assert.match(backup, /recordFailure/, 'runBackup no longer records failures — a broken backup will read as healthy');
  assert.match(backup, /fs\.rm\(dir/, 'a failed run leaves its directory behind, which rotation then counts as a backup');

  const admin = readFileSync(join(REPO, 'bff', 'src', 'routes', 'admin.ts'), 'utf8');
  const run = admin.slice(admin.indexOf("if (id === 'backup')"), admin.indexOf("if (id === 'backup')") + 600);
  assert.ok(!/\.catch\(\(\) => \{\}\)/.test(run), 'the manual backup route swallows its error again');
});

test('the root build context is pruned', () => {
  const p = join(REPO, '.dockerignore');
  assert.ok(existsSync(p),
    'Dockerfile.aio builds from the repo root and there is no .dockerignore there, so the build copies the\n' +
    "host's node_modules over what npm ci installed");
  const ignore = readFileSync(p, 'utf8');
  for (const needed of ['node_modules', 'web/out', '.env']) {
    assert.match(ignore, new RegExp(needed.replace('.', '\\.')), `.dockerignore does not exclude ${needed}`);
  }
});
