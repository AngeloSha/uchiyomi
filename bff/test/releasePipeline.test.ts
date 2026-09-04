// The release pipeline and the one-click manifests, held to the shape that stops them breaking.
//
// The pipeline broke four of five releases before v0.19.0, every time the same way: arm64 built under QEMU
// on an amd64 runner, and the native-module builds either hung until the timeout or died with SIGILL. The
// fix is structural -- each architecture on a runner of that architecture, merged into one index -- and
// structural fixes are exactly the kind that get undone by a helpful edit ("let's simplify this back to one
// job"). So the structure is pinned here, as text, the way aioParity.test.ts pins the Dockerfiles.
//
// The manifests are pinned for the same reason: an Unraid template with a missing path or an Umbrel compose
// without the proxy block installs fine and then does not work, and nobody here runs Unraid or umbrelOS to
// notice. What can be checked without them is checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

const REPO = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');
const code = (s: string) => s.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

test('arm64 is built on an arm64 runner, never emulated, and merged into one index', () => {
  const y = read('.github/workflows/release.yml');
  const wf = parseYaml(y);
  // Reintroduce by adding setup-qemu-action back: the next release hangs at exactly the timeout again.
  assert.ok(!/setup-qemu/.test(code(y)), 'release.yml uses QEMU emulation again');
  assert.match(code(y), /ubuntu-24\.04-arm/, 'no native arm64 runner');
  assert.match(code(y), /push-by-digest=true/, 'architectures are not pushed by digest, so the tag can point at one of them');
  assert.ok(wf.jobs.merge, 'no merge job: nothing writes the tag over both architectures');
  assert.match(code(y), /imagetools create -t "\$\{\{ matrix\.image \}\}:\$\{\{ github\.ref_name \}\}"/, 'the merge job does not write the version tag');
  assert.match(code(y), /grep -q "linux\/\$arch"/, 'the merge job does not check both architectures are in the index');
  // Reintroduce by piping `imagetools inspect` into grep -q or an early-exiting awk: buildx dies of SIGPIPE,
  // pipefail makes that the step's status, and every merge fails after every build succeeded -- the first
  // run of this pipeline, exactly.
  assert.ok(!/imagetools inspect[^\n]*\|\s*(grep|awk|head)/.test(code(y)), 'release.yml pipes an imagetools inspect into a reader that can close the pipe early');
  // The gate: latest moves only after every image is merged. Reintroduce by pointing `needs` at build.
  assert.equal(wf.jobs.latest.needs, 'merge', 'latest is not gated on the merged indexes');
  assert.equal(wf.jobs.merge.needs, 'build');
  for (const j of ['build', 'merge', 'latest']) assert.ok(wf.jobs[j]['timeout-minutes'], `${j} has no timeout`);
  assert.match(y, /attest-build-provenance/, 'no provenance attestation');
  assert.equal(wf.permissions['id-token'], 'write', 'attestations need id-token: write');
  assert.equal(wf.permissions.attestations, 'write');
  // Every image, both architectures.
  assert.deepEqual(wf.jobs.build.strategy.matrix.service, ['bff', 'web', 'aio']);
  assert.deepEqual(wf.jobs.build.strategy.matrix.arch, ['amd64', 'arm64']);
});

test('dependencies and actions are watched weekly, grouped so CI is not run thirty times', () => {
  const d = parseYaml(read('.github/dependabot.yml'));
  const npm = d.updates.filter((u: any) => u['package-ecosystem'] === 'npm').map((u: any) => u.directory).sort();
  assert.deepEqual(npm, ['/bff', '/web']);
  for (const u of d.updates.filter((u: any) => u['package-ecosystem'] === 'npm')) {
    assert.ok(u.groups && Object.keys(u.groups).length, `${u.directory}: npm updates are not grouped`);
    assert.equal(u.schedule.interval, 'weekly');
  }
  assert.ok(d.updates.some((u: any) => u['package-ecosystem'] === 'github-actions'), 'actions are not watched');
  const docker = d.updates.filter((u: any) => u['package-ecosystem'] === 'docker').map((u: any) => u.directory).sort();
  assert.deepEqual(docker, ['/', '/bff', '/web'], 'not every Dockerfile has its base image watched');
  const cq = parseYaml(read('.github/workflows/codeql.yml'));
  assert.match(JSON.stringify(cq), /javascript-typescript/);
  assert.equal(cq.permissions['security-events'], 'write');
});

test('the Unraid template names every volume, the ports, and the ids, and stops gracefully', () => {
  const x = read('deploy/unraid/uchiyomi.xml');
  assert.match(x, /<Repository>ghcr\.io\/angelosha\/uchiyomi<\/Repository>/);
  assert.match(x, /<WebUI>http:\/\/\[IP\]:\[PORT:3000\]\/<\/WebUI>/, 'the WebUI link does not map the container port');
  for (const target of ['/library', '/data', '/config', '/library-dl', '/cache', '/backups']) {
    assert.match(x, new RegExp(`Target="${target}"[^>]*Type="Path"`), `no Path config for ${target}`);
  }
  for (const v of ['PUID', 'PGID', 'PUBLIC_ORIGIN']) assert.match(x, new RegExp(`Target="${v}"[^>]*Type="Variable"`), `no ${v} variable`);
  assert.match(x, /Target="3000"[^>]*Type="Port"/, 'no port mapping for 3000');
  // Reintroduce by deleting ExtraParams: Unraid stops the container with Docker's 10 s default and Postgres
  // is killed mid-checkpoint on every "Update" and every array stop.
  assert.match(x, /--stop-timeout 40/, 'no stop timeout for the embedded database');
  // A Config element, not a mention: the template's own comment explains that DATABASE_URL is unset.
  assert.ok(!/Target="DATABASE_URL"/.test(x), 'the template sets DATABASE_URL, which turns the embedded database off');
  // Well-formed enough: every <Config ...> is closed on its own line.
  const opens = (x.match(/<Config /g) || []).length, closes = (x.match(/<\/Config>/g) || []).length;
  assert.equal(opens, closes, 'an unclosed <Config> element');
});

test('the Umbrel package is the one under review: proxy block, PUID, digest pin, data under app-data', () => {
  // Mirrors what was submitted to getumbrel/umbrel-apps and linted there with `lint:apps --check-images`.
  const m = parseYaml(read('deploy/umbrel/uchiyomi/umbrel-app.yml'));
  assert.equal(m.manifestVersion, 1); assert.equal(m.id, 'uchiyomi');
  // 8110: unique across the store's manifest ports and raw compose ports at submission time (8080 was not).
  assert.equal(m.port, 8110);
  for (const k of ['name', 'tagline', 'description', 'developer', 'repo', 'support', 'category', 'version', 'submitter']) assert.ok(m[k], `manifest lacks ${k}`);
  assert.deepEqual(m.gallery, [], 'the store adds gallery images; the package ships none');
  assert.deepEqual(m.permissions, ['STORAGE_DOWNLOADS'], 'the library is read from Umbrel Downloads, which needs this permission');
  assert.match(m.submission, /getumbrel\/umbrel-apps\/pull\/\d+$/, 'submission must be the store PR');
  const c = parseYaml(read('deploy/umbrel/uchiyomi/docker-compose.yml'));
  assert.ok(c.services.app_proxy, 'no app_proxy service: Umbrel cannot route to the app');
  assert.equal(c.services.app_proxy.environment.APP_HOST, 'uchiyomi_server_1');
  assert.equal(c.services.app_proxy.environment.APP_PORT, 3000);
  // OPDS readers and API-token scripts cannot carry the Umbrel cookie; first-run setup must stay behind it.
  assert.match(String(c.services.app_proxy.environment.PROXY_AUTH_WHITELIST), /\/opds\/\*.*\/img\/\*.*\/api\/\*/);
  assert.match(String(c.services.app_proxy.environment.PROXY_AUTH_BLACKLIST), /\/api\/setup/, 'first-run setup is reachable without Umbrel login');
  const s = c.services.server;
  // PUID/PGID, not user:: the image has a permission-fixing root entrypoint (the store guide's own rule).
  assert.equal(s.user, undefined, 'user: forces a uid on an image whose entrypoint must start as root');
  assert.equal(String(s.environment.PUID), '1000'); assert.equal(String(s.environment.PGID), '1000');
  assert.match(s.image, /^ghcr\.io\/angelosha\/uchiyomi:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/, 'Umbrel requires the image pinned by digest');
  assert.ok(!/0{64}/.test(s.image), 'the digest is still the placeholder');
  assert.ok(!('DATABASE_URL' in (s.environment ?? {})), 'DATABASE_URL set: the embedded database is off and there is no other');
  assert.ok(s.volumes.some((v: string) => v.startsWith('${APP_DATA_DIR}/data/db:') && v.endsWith(':/data')), 'the database must live under app-data');
  assert.ok(s.volumes.some((v: string) => v.includes('/data/storage/downloads/') && v.endsWith(':/library')), 'the library must come from Umbrel Downloads');
  assert.match(String(s.stop_grace_period), /40s/);
  assert.ok(s.image.includes(`:v${m.version}@`), `manifest version ${m.version} does not match the pinned image ${s.image}`);
  assert.match(String(s.environment.JWT_SECRET), /APP_UCHIYOMI_JWT_SECRET/, 'the session secret should come from exports.sh');
  assert.match(read('deploy/umbrel/uchiyomi/exports.sh'), /derive_entropy/, 'exports.sh does not derive the secret');
  for (const d of ['db', 'config', 'cache', 'downloads', 'backups']) assert.ok(existsSync(join(REPO, `deploy/umbrel/uchiyomi/data/${d}/.gitkeep`)), `data/${d} is not committed; Umbrel would mount an empty root-owned path`);
  const f = c.services.flaresolverr;
  assert.ok(f && /@sha256:[0-9a-f]{64}$/.test(f.image), 'the solver sidecar is not pinned by digest');
});

test('the README tells Unraid and Umbrel users where their manifest is', () => {
  const r = read('README.md');
  // Written after the rebase onto stage 4, alongside the CasaOS line. Reintroduce by dropping either link.
  assert.match(r, /deploy\/unraid\/uchiyomi\.xml/, 'README does not point Unraid users at the template');
  assert.match(r, /deploy\/umbrel\/uchiyomi/, 'README does not point Umbrel users at the manifest');
  assert.ok(existsSync(join(REPO, 'deploy/casaos/docker-compose.yml')), 'the CasaOS manifest moved');
});
