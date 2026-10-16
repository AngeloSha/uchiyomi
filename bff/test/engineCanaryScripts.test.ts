// The weekly engine canary's scripts (scripts/engine/*.mjs), held to what they promise without a network or an engine.
//
// .github/workflows/engine-canary.yml runs them against real engines every week; here each one meets a case it exists
// for: bump.mjs moving every pin of a temporary copy of the repository so that enginePins.test.ts passes on it (and
// refusing, writing nothing, when a pin cannot be found); envCheck.mjs naming a deploy variable an image stopped
// reading; schemaDiff.mjs on two small schemas; latest.mjs refusing to call a preview build the stable one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const REPO = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');
const run = (args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => new Promise<{ code: number; out: string }>((done) => {
  // Without NODE_TEST_CONTEXT: node:test reads it as "called from inside a test file" and runs nothing.
  const { NODE_TEST_CONTEXT: _, ...env } = { ...process.env, ...o.env };
  execFile(process.execPath, args, { cwd: o.cwd ?? REPO, env, timeout: 120_000 }, (e, stdout, stderr) => {
    done({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: `${stdout}${stderr}` });
  });
});
const PINS = JSON.parse(read('scripts/engine/pins.json'));
const PIN: string = JSON.parse(read(PINS.pin)).version;

/** The files bump.mjs reads or writes, and what the pin test reads, copied into a fresh directory. */
function copyRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'engine-bump-'));
  const files = [
    'scripts/engine/pins.json', 'scripts/engine/bump.mjs', PINS.pin, PINS.pack, PINS.workflow, PINS.tested, PINS.fake,
    ...PINS.images, `${PINS.schemas}/suwayomi-${PIN}-schema.json`, PINS.solverDtos.test, `${PINS.solverDtos.dir}/suwayomi-${PIN}-FlareSolverDtos.kt`,
  ];
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    cpSync(join(REPO, f), join(dir, f));
  }
  return dir;
}

const NEXT = 'v9.9.9';
/** A release's Checksums.sha256, as Suwayomi publishes it, for NEXT. */
const CHECKSUMS = ['windows-x64.zip', 'macOS-arm64.tar.gz', 'macOS-x64.tar.gz', 'linux-x64.tar.gz', 'windows-x64.msi', 'debian-all.deb']
  .map((s, i) => `${String(i + 1).repeat(64)}  Suwayomi-Server-${NEXT}-${s}`).join('\n') + `\n${'f'.repeat(64)}  Suwayomi-Server-${NEXT}.jar\n`;

test('bump.mjs moves every pin to the new engine, and the pin test passes on the result', async () => {
  // Reintroduce by dropping a file from bump.mjs's rewrites (say the workflow's SUWAYOMI): enginePins.test.ts, run on the
  // bumped copy, names it -- the desktop cache would restore the old engine's pack into the new one's build.
  const dir = copyRepo();
  try {
    const schema = JSON.parse(read(`${PINS.schemas}/suwayomi-${PIN}-schema.json`));
    schema.engine = { ...schema.engine, version: NEXT };
    writeFileSync(join(dir, 'schema.json'), JSON.stringify(schema));
    writeFileSync(join(dir, 'Checksums.sha256'), CHECKSUMS);
    // CloudflareInterceptor.kt at NEXT: the DTOs as the current fixture has them, among other lines.
    const dtos = read(`${PINS.solverDtos.dir}/suwayomi-${PIN}-FlareSolverDtos.kt`).split('\n').slice(3).join('\n').trimEnd();
    writeFileSync(join(dir, 'CloudflareInterceptor.kt'), ['package x', '', 'class CloudflareInterceptor {', '    private val mutex = Mutex()', '', dtos, '', '    suspend fun resolve() {}', '}'].join('\n'));
    const r = await run([join(dir, 'scripts/engine/bump.mjs'), NEXT, '--repo', dir, '--schema', join(dir, 'schema.json'),
      '--checksums', join(dir, 'Checksums.sha256'), '--interceptor', join(dir, 'CloudflareInterceptor.kt')]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Left to do by hand:/);

    const pins = await run(['--import', 'tsx', '--test', 'test/enginePins.test.ts'], { cwd: join(REPO, 'bff'), env: { ENGINE_PINS_REPO: dir } });
    assert.equal(pins.code, 0, `the pin test fails on the bumped copy:\n${pins.out}`);
    assert.match(pins.out, /ℹ pass 8/, 'PREMISE: every pin test ran on the copy');

    const at = (p: string) => readFileSync(join(dir, p), 'utf8');
    assert.match(at(PINS.pack), new RegExp(`name: 'Suwayomi-Server-${NEXT}-windows-x64\\.zip', sha256: '${'1'.repeat(64)}'`), "the pack's hashes are the release's own");
    assert.match(at(PINS.pack), new RegExp(`name: 'Suwayomi-Server-${NEXT}-linux-x64\\.tar\\.gz', sha256: '${'4'.repeat(64)}'`));
    const pin = JSON.parse(at(PINS.pin));
    assert.deepEqual([pin.version, pin.tag], [NEXT, `engine-${NEXT}`]);
    assert.ok(pin.baseUrl.endsWith(`/releases/download/engine-${NEXT}`));
    assert.ok(Object.values<any>(pin.packs).every((p) => p.sha256 === null && p.bytes === null), 'a pack of the old engine is still pinned for the new one');
    const fixture = at(`${PINS.solverDtos.dir}/suwayomi-${NEXT}-FlareSolverDtos.kt`);
    assert.match(fixture, new RegExp(`^// Verbatim: Suwayomi-Server ${NEXT} CloudflareInterceptor\\.kt lines 6-58 \\(the request/response DTOs\\)\\n`));
    assert.ok(fixture.includes(dtos), 'the DTOs are not verbatim');
    assert.ok(!existsSync(join(dir, `${PINS.solverDtos.dir}/suwayomi-${PIN}-FlareSolverDtos.kt`)), 'the old DTOs are left behind');
    assert.ok(at(PINS.solverDtos.test).includes(`suwayomi-${NEXT}-FlareSolverDtos.kt`), 'the solver contract still reads the old DTOs');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bump.mjs writes nothing when one pin cannot be found', async () => {
  // Reintroduce by writing each file as it is rewritten: the compose files before the broken one move, and the
  // checkout is left half on each engine.
  const dir = copyRepo();
  try {
    const casa = join(dir, 'deploy/casaos/uchiyomi-suwayomi.yml');
    writeFileSync(casa, readFileSync(casa, 'utf8').replaceAll(`suwayomi-server:${PIN}`, 'suwayomi-server:latest'));
    const schema = JSON.parse(read(`${PINS.schemas}/suwayomi-${PIN}-schema.json`));
    writeFileSync(join(dir, 'schema.json'), JSON.stringify({ ...schema, engine: { ...schema.engine, version: NEXT } }));
    writeFileSync(join(dir, 'Checksums.sha256'), CHECKSUMS);
    writeFileSync(join(dir, 'CloudflareInterceptor.kt'), read(`${PINS.solverDtos.dir}/suwayomi-${PIN}-FlareSolverDtos.kt`));
    const before = readFileSync(join(dir, 'deploy/docker-compose.yml'), 'utf8');
    const r = await run([join(dir, 'scripts/engine/bump.mjs'), NEXT, '--repo', dir, '--schema', join(dir, 'schema.json'),
      '--checksums', join(dir, 'Checksums.sha256'), '--interceptor', join(dir, 'CloudflareInterceptor.kt')]);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /deploy\/casaos\/uchiyomi-suwayomi\.yml: nothing to rewrite/);
    assert.equal(readFileSync(join(dir, 'deploy/docker-compose.yml'), 'utf8'), before, 'a file was written before the refusal');
    // And a schema of another engine is refused before anything is read.
    const wrong = await run([join(dir, 'scripts/engine/bump.mjs'), 'v9.9.8', '--repo', dir, '--schema', join(dir, 'schema.json')]);
    assert.match(wrong.out, /is the schema of v9\.9\.9, not v9\.9\.8/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('envCheck.mjs names a variable the deploy files set that an image no longer reads', async () => {
  // AUTO_DOWNLOAD_CHAPTERS=false keeps the engine from writing into the library Uchiyomi owns; the image's Docker
  // repository dropped it after v2.4.2366. Reintroduce by checking only `${NAME}` (not `$NAME`), or by skipping the
  // Unraid template: the complete script below is reported missing something, or the template's own variables go
  // unchecked.
  const dir = mkdtempSync(join(tmpdir(), 'engine-env-'));
  try {
    const names = ['AUTO_DOWNLOAD_CHAPTERS', 'DOWNLOAD_AS_CBZ', 'FLARESOLVERR_ENABLED', 'FLARESOLVERR_URL', 'WEB_UI_ENABLED', 'AUTH_MODE', 'AUTH_USERNAME'];
    const line = (n: string) => `sed -i -r "s/x = ([a-z]+)/x = \${${n}:-\\1}/" server.conf`;
    // AUTH_PASSWORD read as a plain $NAME, the way the real script reads it in places.
    writeFileSync(join(dir, 'all.sh'), [...names.map(line), 'if [ -n "$AUTH_PASSWORD" ]; then :; fi'].join('\n'));
    writeFileSync(join(dir, 'missing.sh'), [...names.filter((n) => n !== 'AUTO_DOWNLOAD_CHAPTERS').map(line), 'echo "$AUTH_PASSWORD"'].join('\n'));
    const ok = await run(['scripts/engine/envCheck.mjs', '--startup', join(dir, 'all.sh')]);
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /templates\/uchiyomi-suwayomi\.xml: \d+ variables, all read/, 'the Unraid template is not checked');
    const gone = await run(['scripts/engine/envCheck.mjs', '--startup', join(dir, 'missing.sh')]);
    assert.equal(gone.code, 1);
    assert.match(gone.out, /^MISSING deploy\/docker-compose\.yml: AUTO_DOWNLOAD_CHAPTERS$/m);
    // What the canary starts the engine with: the shipped compose file's variables, defaults filled in.
    const args = await run(['scripts/engine/envCheck.mjs', '--docker-args']);
    assert.match(args.out, /^AUTO_DOWNLOAD_CHAPTERS=false$/m);
    assert.match(args.out, /^JAVA_TOOL_OPTIONS=-Xmx768m -XX:\+UseSerialGC$/m);
    assert.match(args.out, /^MALLOC_ARENA_MAX=2$/m, 'the canary engine runs without the arena cap the deploy files give it (#275)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('schemaDiff.mjs says what was added, removed, retyped and newly deprecated', async () => {
  // Reintroduce by comparing field names only: the retyped `size` is missed. Drop the deprecation pass: `old` is not
  // listed, and the canary's early warning says nothing.
  const { diff, text } = await import('../../scripts/engine/schemaDiff.mjs');
  const a = { engine: { version: 'v1.0.0' }, types: {
    Query: { kind: 'OBJECT', fields: { a: 'Int', old: 'String', gone: 'Int', size: 'Int' } },
    Kind: { kind: 'ENUM', values: ['ONE', 'TWO'] },
    Dropped: { kind: 'OBJECT', fields: { x: 'Int' } },
  } };
  const b = { engine: { version: 'v1.1.0' }, types: {
    Query: { kind: 'OBJECT', fields: { a: { type: 'Int', args: { first: 'Int' } }, old: { type: 'String', deprecated: 'use a' }, size: 'LongString', fresh: 'Int' } },
    Kind: { kind: 'ENUM', values: ['ONE', 'TWO', 'THREE'], deprecatedValues: { ONE: '' } },
    Added: { kind: 'OBJECT', fields: { y: 'Int' } },
  } };
  const d = diff(a, b);
  assert.deepEqual(d.addedTypes, ['Added']);
  assert.deepEqual(d.removedTypes, ['Dropped']);
  assert.deepEqual(d.added, ['Kind.THREE', 'Query.a(first)', 'Query.fresh']);
  assert.deepEqual(d.removed, ['Query.gone']);
  assert.deepEqual(d.changed, [{ member: 'Query.size', from: 'Int', to: 'LongString' }]);
  assert.deepEqual(d.deprecated, [{ member: 'Kind.ONE', reason: '' }, { member: 'Query.old', reason: 'use a' }]);
  assert.match(text(d), /^Schema: v1\.0\.0 -> v1\.1\.0\n/);
  assert.equal(text(diff(a, a)), 'Schema: v1.0.0 -> v1.0.0\nNo change.');
  // The real pair, as the canary runs it.
  const r = await run(['scripts/engine/schemaDiff.mjs', 'bff/test/fixtures/suwayomi-v2.3.2243-schema.json', 'bff/test/fixtures/suwayomi-v2.4.2366-schema.json', '--json']);
  assert.equal(r.code, 0, r.out);
  assert.ok(JSON.parse(r.out).added.includes('Mutation.clearCookiesAndCache'));
});

/** GitHub's API and GHCR, as latest.mjs asks them: releases, an anonymous token, and digests by tag. */
async function fakeRegistry(digests: Record<string, string>, stable = 'v9.9.9') {
  const srv = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    const json = (j: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (u.pathname === '/repos/Suwayomi/Suwayomi-Server/releases/latest') return json({ tag_name: stable, published_at: '2026-10-10T00:00:00Z' });
    if (u.pathname === '/repos/Suwayomi/Suwayomi-Server-preview/releases') return json([{ tag_name: 'v9.9.10', published_at: '2026-10-12T00:00:00Z' }]);
    if (u.pathname === '/token') return json({ token: 't' });
    const m = /^\/v2\/suwayomi\/suwayomi-server\/manifests\/(.+)$/.exec(u.pathname);
    if (m && digests[m[1]]) { res.writeHead(200, { 'docker-content-digest': digests[m[1]] }); return res.end(); }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

test('latest.mjs tests a stable release only when its tag is the stable build, and keeps the pin as the control', async () => {
  // GHCR's plain vX.Y.Z can be a preview: the stable one has vX.Y.Z-stable's digest. Reintroduce by trusting the plain
  // tag: the preview build is tested and reported as the stable release to bump to.
  const { resolveEngines } = await import('../../scripts/engine/latest.mjs');
  const preview = await fakeRegistry({ 'v9.9.9': 'sha256:aaa', 'v9.9.9-stable': 'sha256:bbb' });
  try {
    const r = await resolveEngines({ api: preview.url, registry: preview.url, now: '2026-10-14T00:00:00Z' });
    assert.equal(r.stable, null, 'a preview build was taken for the stable release');
    assert.deepEqual(r.matrix.map((m: any) => m.kind), ['pin', 'preview']);
    assert.equal(r.matrix[0].tag, PIN, 'the pin is the control');
    assert.match(r.notes.join(' '), /v9\.9\.9 is not the stable build/);
  } finally {
    await preview.close();
  }
  const stable = await fakeRegistry({ 'v9.9.9': 'sha256:ccc', 'v9.9.9-stable': 'sha256:ccc' });
  try {
    const r = await resolveEngines({ api: stable.url, registry: stable.url, now: '2026-10-14T00:00:00Z', preview: false });
    assert.deepEqual(r.matrix.map((m: any) => [m.kind, m.tag]), [['pin', PIN], ['stable', 'v9.9.9']]);
    assert.equal(r.stable.fresh, true, 'four days old is fresh');
    const later = await resolveEngines({ api: stable.url, registry: stable.url, now: '2026-11-14T00:00:00Z', preview: false });
    assert.equal(later.stable.fresh, false);
  } finally {
    await stable.close();
  }
});
