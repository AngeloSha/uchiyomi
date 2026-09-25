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
import { readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
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
  // The digest the merge job trusts is checked before it is written. `build-push-action` sets that output
  // only `if (digest)`, so a build that produced no image metadata leaves it empty -- and an empty digest
  // reaches `imagetools create` as a bare `image@`, which is how a tag ends up over one architecture or
  // none. Reintroduce by dropping the `sha256:` case: the guard is the only thing between an empty output
  // and a half-published tag, and `merge` runs `fail-fast: false`, so nothing else would stop it.
  const record = wf.jobs.build.steps.find((st: any) => st.name === 'Record the digest');
  assert.ok(record, 'no step records the per-arch digest');
  assert.match(record.run, /sha256:\*\)/, 'the recorded digest is not validated before it is written');
  assert.match(record.run, /exit 1/, 'a malformed digest does not fail the build');
  // Every image, both architectures.
  assert.deepEqual(wf.jobs.build.strategy.matrix.service, ['bff', 'web', 'aio']);
  assert.deepEqual(wf.jobs.build.strategy.matrix.arch, ['amd64', 'arm64']);
});

test('a tag publishes a GitHub Release, not just images', () => {
  const y = read('.github/workflows/release.yml');
  const wf = parseYaml(y);
  // ⚠️ This was manual for the whole life of the project, and three releases in a row were missed --
  // v0.22.0, v0.23.0 and v0.24.0 all shipped, published and deployed while the Releases page still said
  // v0.21.0. Not cosmetic: the README's "latest release" badge reads Releases rather than tags, so the
  // front page advertised a version three behind, and docs/INSTALL.md tells people to watch Releases to
  // know when there is something to pull.
  assert.ok(wf.jobs.release, 'nothing publishes a GitHub Release, so tags will silently stop announcing');
  // After the images exist. A release announcing a publish that failed is worse than no release.
  assert.equal(wf.jobs.release.needs, 'merge');
  // NOT gated on `latest`: a prerelease tag should still get an entry, marked as one.
  assert.ok(!wf.jobs.release.if, 'the release job must run for prerelease tags too');
  assert.match(code(y), /--prerelease/, 'an rc tag would be published as a normal release');
  // The notes come from the changelog, so a release cannot describe something other than the file
  // everyone reads. Reintroduce by switching to --generate-notes unconditionally.
  assert.match(code(y), /CHANGELOG\.md/, 'the release notes do not come from the changelog');
  // Write access is scoped to this one job rather than widened at the top of the file.
  assert.equal(wf.jobs.release.permissions?.contents, 'write');
  assert.equal(wf.permissions.contents, 'read', 'the workflow as a whole must not gain write access');
});

test('dependencies and actions are watched weekly, grouped so CI is not run thirty times', () => {
  const d = parseYaml(read('.github/dependabot.yml'));
  const npm = d.updates.filter((u: any) => u['package-ecosystem'] === 'npm').map((u: any) => u.directory).sort();
  // /desktop since v0.44.0: Electron is a browser engine the app ships, and only its three newest majors get
  // security fixes. Reintroduce by deleting the /desktop entry: this names the list.
  assert.deepEqual(npm, ['/bff', '/desktop', '/web']);
  for (const u of d.updates.filter((u: any) => u['package-ecosystem'] === 'npm')) {
    assert.ok(u.groups && Object.keys(u.groups).length, `${u.directory}: npm updates are not grouped`);
    assert.equal(u.schedule.interval, 'weekly');
  }
  assert.ok(d.updates.some((u: any) => u['package-ecosystem'] === 'github-actions'), 'actions are not watched');
  const docker = d.updates.filter((u: any) => u['package-ecosystem'] === 'docker').map((u: any) => u.directory).sort();
  assert.deepEqual(docker, ['/', '/bff', '/web'], 'not every Dockerfile has its base image watched');
  // A Node major is taken deliberately, onto an even LTS line: never a weekly PR for an odd, short-lived release
  // (#73-#75 proposed node:25 after its end of life), and never @types/node ahead of the runtime (#62, #77).
  // Reintroduce by deleting either ignore rule from any one entry: the assertion names the directory.
  const ignores = (u: any, dep: string) =>
    (u.ignore ?? []).some((i: any) => i['dependency-name'] === dep && (i['update-types'] ?? []).includes('version-update:semver-major'));
  for (const u of d.updates.filter((u: any) => u['package-ecosystem'] === 'docker'))
    assert.ok(ignores(u, 'node'), `docker ${u.directory}: Node majors arrive as weekly PRs`);
  for (const u of d.updates.filter((u: any) => u['package-ecosystem'] === 'npm'))
    assert.ok(ignores(u, '@types/node'), `npm ${u.directory}: @types/node can run ahead of the Node runtime`);
  const cq = parseYaml(read('.github/workflows/codeql.yml'));
  assert.match(JSON.stringify(cq), /javascript-typescript/);
  assert.equal(cq.permissions['security-events'], 'write');
});

test('every CI job has a timeout, and installs from the lockfile', () => {
  const y = read('.github/workflows/ci.yml');
  const ci = parseYaml(y);
  // release.yml had a timeout on every job since v0.19.0 and ci.yml had one only on e2e, so a hung
  // integration test sat for GitHub's 360-minute default with the whole queue behind it. Reintroduce by
  // removing timeout-minutes from the test job: this names it.
  for (const j of Object.keys(ci.jobs)) assert.ok(ci.jobs[j]['timeout-minutes'], `ci.yml job "${j}" has no timeout`);
  // And not a timeout the job cannot meet: Tests takes 38-39 minutes on every green run.
  assert.ok(ci.jobs.test['timeout-minutes'] >= 45, 'the test job timeout is below what a green run needs');
  // `npm install` may resolve differently from package-lock.json and rewrites it on the runner, so a
  // Dependabot lockfile bump was never what CI tested; `npm ci` refuses a lockfile that disagrees.
  // Reintroduce by changing one `npm ci` back to `npm install`: this names the step.
  const steps = Object.values(ci.jobs).flatMap((j: any) => (j.steps ?? []).map((st: any) => ({ job: j.name, name: st.name, run: String(st.run ?? '') })));
  const installs = steps.filter((st) => /\bnpm (install|ci)\b/.test(st.run));
  assert.ok(installs.length >= 3, 'the install steps went missing');
  for (const st of installs) assert.ok(!/\bnpm install\b/.test(st.run), `${st.job} / ${st.name} uses npm install instead of npm ci`);
});

test('the Unraid template names every volume, the ports, and the ids, and stops gracefully', () => {
  const x = read('templates/uchiyomi.xml');
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
  // ⚠️ `--` inside an XML comment is illegal (XML 1.0 §2.5), and Unraid's dockerMan parses the template with
  // a real parser. The v0.21.0 rewrite of the header comment -- the one that fixed the install steps after
  // hawwwwwk's first report -- wrote "never read -- so", and from then until v0.34.0 the file could not be
  // installed by anyone: the parse fails at the comment, before the first <Config>. Every check above passed
  // the whole time, because none of them parsed. hawwwwwk found that too (PR #50). There is no XML parser
  // among the dependencies, so the comment bodies are checked by hand, the way a parser would refuse them.
  // Reintroduce by writing `--` back into the header comment: this names the offending comment.
  //
  // Walked with indexOf rather than a `<!--([\s\S]*?)-->` regex: this is XML, where `--!>` is not a
  // terminator and `--` in the body is the actual fault, but CodeQL's js/bad-tag-filter (#28) reads any
  // comment regex as an HTML sanitiser and re-fires on every edit of the line. A plain scan says the same
  // thing without giving the rule a regex to misjudge, and a comment that never closes fails here by name
  // instead of as a mismatch of two counts.
  for (let at = 0; ; ) {
    const s = x.indexOf('<!--', at);
    if (s < 0) break;
    const e = x.indexOf('-->', s + 4);
    assert.ok(e >= 0, `an XML comment that never closes: ${x.slice(s, s + 60).trim()}…`);
    const body = x.slice(s + 4, e);
    assert.ok(!body.includes('--'), `"--" inside an XML comment, which no parser accepts: ${body.trim().slice(0, 60)}…`);
    at = e + 3;
  }
  // The same parser would also refuse a `-` glued to the closing `-->`.
  assert.ok(!/--->/.test(x), 'a comment ending in "--->" is malformed');
  // Both files CA moderators read must start with the XML declaration and carry one root element each.
  assert.match(x, /^<\?xml version="1\.0"\?>\n/, 'the template lacks the XML declaration');
  const ca = read('ca_profile.xml');
  assert.match(ca, /^<\?xml version="1\.0"\?>\n<CommunityApplications>[\s\S]*<\/CommunityApplications>\s*$/, 'ca_profile.xml is not a CommunityApplications document');
  // The icon must be the app's own icon, the same file the template shows; the CA listing reads ca_profile.
  assert.match(ca, /<Icon>https:\/\/raw\.githubusercontent\.com\/AngeloSha\/uchiyomi\/main\/web\/public\/icons\/icon-512\.png<\/Icon>/, 'the CA profile icon is not the app icon');
  assert.ok(existsSync(join(REPO, 'web/public/icons/icon-512.png')), 'the icon both files point at is not in the repo');
  // The main repo is the CA template repository now; a TemplateURL at the old unraid-templates repo would
  // have Unraid refresh the template from a file that is only kept for old links.
  assert.match(x, /<TemplateURL>https:\/\/raw\.githubusercontent\.com\/AngeloSha\/uchiyomi\/main\/templates\/uchiyomi\.xml<\/TemplateURL>/, 'TemplateURL does not point at this repo');
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

test('an Unraid or Umbrel user can still get from the README to their manifest', () => {
  // The property is that the path exists, not that it is one hop. The per-platform install moved out of the
  // README in v0.24.0 -- it was longer on its own than five comparable projects' entire READMEs -- so this
  // follows it, and additionally pins the link that makes it reachable. Reintroduce by dropping either the
  // README's pointer to the install guide or one of the manifest links inside it: a NAS user lands on a
  // quick start that assumes Docker Compose and never learns their platform has a one-click template.
  const r = read('README.md');
  assert.match(r, /docs\/INSTALL\.md/, 'the README no longer points anywhere for platform installs');
  const i = read('docs/INSTALL.md');
  // `templates/uchiyomi.xml` since PR #50: the layout Community Applications reads from the main repo.
  assert.match(i, /templates\/uchiyomi\.xml/, 'the install guide does not point Unraid users at the template');
  assert.ok(!/deploy\/unraid\//.test(i), 'the install guide still names the pre-#50 template path, which no longer exists');
  assert.ok(existsSync(join(REPO, 'templates/uchiyomi.xml')), 'the Unraid template moved');
  assert.match(i, /deploy\/umbrel\/uchiyomi/, 'the install guide does not point Umbrel users at the manifest');
  assert.ok(existsSync(join(REPO, 'deploy/casaos/docker-compose.yml')), 'the CasaOS manifest moved');
});

// ---------------------------------------------------------------------------------------------------------------
// Uchiyomi Desktop (beta), since v0.44.0: the same tag also builds Windows and macOS installers and attaches them
// to the Release. What must not happen: the desktop build (30-60 minutes on three OSes, and a live MangaDex in its
// product smoke) holding up the images every existing install pulls; an update feed going up before the file it
// names; the extension-engine release becoming "latest" and being offered to every desktop app as an update; and
// a pinned engine pack being replaced under the hash every install checks it against.

/** node on a script, asynchronously: the pin test's HTTP server lives in THIS process, so spawnSync would starve it. */
function runNode(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd: REPO, timeout: 60_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

test('the desktop app is built beside the images, never in front of them, and published only when every leg is green', () => {
  const y = read('.github/workflows/release.yml');
  const wf = parseYaml(y);
  const desk = wf.jobs.desktop;
  assert.ok(desk, 'release.yml no longer builds the desktop app');
  assert.equal(desk.uses, './.github/workflows/desktop.yml');
  // Reintroduce by adding `needs: build` to the desktop job: a macOS queue then decides when the images publish.
  assert.equal(desk.needs, undefined, 'the desktop build waits on the image build');
  // ...and nothing on the images' path may wait for it either.
  for (const j of ['build', 'merge', 'latest', 'release']) {
    const needs = [wf.jobs[j].needs ?? []].flat();
    assert.ok(!needs.includes('desktop') && !needs.includes('desktop-publish'), `${j} waits on the desktop build`);
  }
  assert.equal(desk.permissions?.contents, 'read', 'the desktop build must not be able to write to the repo');

  const pub = wf.jobs['desktop-publish'];
  assert.ok(pub, 'nothing attaches the installers to the Release');
  // The Release must exist (the release job makes it), and EVERY desktop leg must be green. Reintroduce by
  // dropping `release` from its needs: the upload can then start before the Release it uploads to exists.
  assert.deepEqual([pub.needs].flat().sort(), ['desktop', 'release']);
  assert.ok(!pub.if, 'desktop-publish must not run when a desktop leg failed (no `if: always()`)');
  assert.deepEqual(pub.permissions, { contents: 'write' }, 'write access is scoped to the job that uploads, and only contents');
  assert.equal(wf.permissions.contents, 'read');
  assert.ok(pub['timeout-minutes'], 'desktop-publish has no timeout');

  const run: string = pub.steps.map((s: any) => String(s.run ?? '')).join('\n');
  // Every feed is checked against the installers it names (sizes and SHA-512) before anything is uploaded.
  for (const f of ['desktop-dist-win-x64/latest.yml', 'desktop-dist-mac-arm64/latest-mac.yml', 'desktop-dist-mac-x64/latest-mac.yml']) {
    assert.match(run, new RegExp(`check-feed\\.mjs dist/${f.replace(/[.]/g, '\\.')}`), `${f} is not checked before upload`);
  }
  assert.match(run, /merge-latest-mac\.mjs --out feeds\/latest-mac\.yml/, 'the two macOS feeds are not merged');
  assert.match(run, /--version "\$dv"/);
  assert.match(run, /\$\{ver%%-\*\}/, 'the desktop version is not held to the tag');

  // ⚠️ ORDER: binaries first, the feeds last and in a call of their own. Reintroduce by moving
  // feeds/latest.yml into the first upload: gh uploads one call's files in parallel, so a Windows install
  // could read a feed whose installer is not there yet.
  const uploads = run.split('\n').filter((l) => /gh release upload/.test(l));
  assert.equal(uploads.length, 2, `expected two upload calls (installers, then feeds), found ${uploads.length}`);
  assert.ok(!/latest/.test(uploads[0]), 'the feeds go up in the same call as the installers');
  assert.match(uploads[1], /feeds\/latest\.yml/);
  assert.match(uploads[1], /feeds\/latest-mac\.yml/);
  assert.ok(run.indexOf(uploads[0]) < run.indexOf(uploads[1]), 'the feeds are uploaded before the installers');
  // The notes section is idempotent: a re-run replaces it rather than stacking a second one.
  assert.match(run, /desktop-beta:start/);
  assert.match(run, /skip=1/, 'a re-run of the notes step would add the downloads section twice');

  // desktop.yml is callable, and publishes nothing itself.
  const d = parseYaml(read('.github/workflows/desktop.yml'));
  assert.ok('workflow_call' in d.on, 'desktop.yml cannot be called from the release');
  assert.equal(d.permissions.contents, 'read');
  assert.ok(!/gh release/.test(code(read('.github/workflows/desktop.yml'))), 'desktop.yml publishes on its own');
  // What desktop-publish downloads is what desktop.yml uploads.
  assert.match(read('.github/workflows/desktop.yml'), /name: desktop-dist-\$\{\{ matrix\.platform \}\}/);
  assert.deepEqual(d.jobs.build.strategy.matrix.include.map((m: any) => m.platform).sort(), ['mac-arm64', 'mac-x64', 'win-x64']);
});

test('the permanent download links the docs give are files every release uploads, never a feed', () => {
  // Since v0.45.0 the README, docs/DESKTOP.md and uchiyomi.com/download link to
  // https://github.com/AngeloSha/uchiyomi/releases/latest/download/<name>, which only works for a file name that
  // is the same in every release -- and electron-builder names every installer after its version. So the publish
  // job uploads copies under fixed names beside the versioned files. What must not happen: a link in the docs to
  // a name nothing uploads (a 404 on the one button a beginner presses), a copy of the wrong file (a Mac user
  // handed the Windows installer), or a copy riding in the feeds' call, whose ORDER exists for the updater.
  // Reintroduce by renaming `permanent/Uchiyomi-Setup.exe` in release.yml, by linking a versioned name through
  // /releases/latest/download/ in README.md, or by dropping the copies from the installers' upload.
  const wf = parseYaml(read('.github/workflows/release.yml'));
  const steps: any[] = wf.jobs['desktop-publish'].steps;
  const run: string = steps.map((st) => String(st.run ?? '')).join('\n');
  const uploads = run.split('\n').filter((l) => /gh release upload/.test(l) && !l.trim().startsWith('#'));
  // Each fixed name is a byte copy of the versioned file the feed-check step verified for that platform.
  const PERMANENT: Record<string, string> = {
    'Uchiyomi-Setup.exe': 'dist/desktop-dist-win-x64/Uchiyomi-Setup-$dv.exe',
    'Uchiyomi-mac-arm64.dmg': 'dist/desktop-dist-mac-arm64/Uchiyomi-$dv-arm64.dmg',
    'Uchiyomi-mac-x64.dmg': 'dist/desktop-dist-mac-x64/Uchiyomi-$dv-x64.dmg',
  };
  const copyStep = steps.findIndex((st) => /permanent\//.test(String(st.run ?? '')) && /\bcp\b/.test(String(st.run ?? '')));
  const uploadStep = steps.findIndex((st) => /gh release upload/.test(String(st.run ?? '')));
  assert.ok(copyStep >= 0 && copyStep < uploadStep, 'the permanent copies are not made before the upload step');
  for (const [name, from] of Object.entries(PERMANENT)) {
    assert.ok(run.includes(`cp "${from}" permanent/${name}`), `permanent/${name} is not a copy of ${from}`);
    assert.ok(uploads[0]?.includes(`permanent/${name}`), `${name} is not uploaded with the installers`);
    assert.ok(!uploads.slice(1).some((u) => u.includes(name)), `${name} goes up in the feeds' call`);
  }

  // Every /releases/latest/download/ link in the docs names one of them.
  const docs = ['README.md', 'CHANGELOG.md', ...readdirSync(join(REPO, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];
  const seen: Record<string, Set<string>> = {};
  const bad: string[] = [];
  for (const f of docs) {
    for (const m of read(f).matchAll(/releases\/latest\/download\/([^)\s"'<>\]`]+)/g)) {
      (seen[f] ??= new Set()).add(m[1]);
      if (!(m[1] in PERMANENT)) bad.push(`${f}: releases/latest/download/${m[1]} -- no release uploads a file by that name`);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
  // ...and the two places a beginner starts from offer all three.
  for (const f of ['README.md', 'docs/DESKTOP.md']) {
    assert.deepEqual([...(seen[f] ?? [])].sort(), Object.keys(PERMANENT).sort(), `${f} does not link all three permanent downloads`);
  }
});

test('a release never attaches a desktop app whose extension engine is not pinned to a published pack', async () => {
  // ⚠️ With a null sha256 the app says "the extension engine download is not available" and never fetches
  // anything -- and every desktop check still passes, because the smokes build their own pack when the pin is
  // empty (engine-fixture.mjs). So a v* tag pushed before the engine-v* prerelease is published and pinned shipped
  // a desktop app whose Admin -> Extensions is broken for every user, from a fully green run. The gate is a
  // script, run before anything is downloaded or uploaded.
  const wf = parseYaml(read('.github/workflows/release.yml'));
  const steps: any[] = wf.jobs['desktop-publish'].steps;
  const at = (re: RegExp) => steps.findIndex((s) => re.test(String(s.run ?? '')) || re.test(String(s.uses ?? '')));
  const gate = at(/check-pin\.mjs/);
  // Reintroduce by deleting the "pinned to a published pack" step: this names it.
  assert.ok(gate >= 0, 'desktop-publish does not check the engine pin');
  assert.ok(gate < at(/download-artifact/), 'the engine pin is checked after the installers are downloaded');
  assert.ok(gate < at(/gh release upload/), 'the engine pin is checked after something is uploaded');
  assert.ok(!steps[gate].if && !steps[gate]['continue-on-error'], 'the pin check can be skipped or ignored');
  // desktop.yml fails a TAG in seconds instead of after the 30-60 minute build; branches build unpinned on purpose.
  const pre: any[] = parseYaml(read('.github/workflows/desktop.yml')).jobs.prebuild.steps;
  const early = pre.find((s) => /check-pin\.mjs/.test(String(s.run ?? '')));
  assert.ok(early, 'a desktop build on a release tag does not check the engine pin');
  assert.equal(early.if, "startsWith(github.ref, 'refs/tags/v')");

  // The script itself, on pins it must refuse and one it must pass.
  const dir = mkdtempSync(join(tmpdir(), 'uchi-checkpin-'));
  try {
    const real = JSON.parse(read('desktop/src/engine-pin.json'));
    const withPacks = (packs: Record<string, any>) => {
      const f = join(dir, `pin-${Object.keys(packs).length}-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(f, JSON.stringify({ ...real, packs }));
      return f;
    };
    const filled = Object.fromEntries(Object.entries<any>(real.packs).map(([k, v], i) => [k, { ...v, sha256: String(i).repeat(64), bytes: 1000 + i }]));
    const ok = await runNode(['desktop/scripts/release/check-pin.mjs', '--pin', withPacks(filled)]);
    assert.equal(ok.code, 0, `a fully pinned engine was refused: ${ok.stdout}${ok.stderr}`);
    // Every pack unpublished (the tree as the engine build left it): refused, naming all three.
    const none = Object.fromEntries(Object.entries<any>(real.packs).map(([k, v]) => [k, { ...v, sha256: null, bytes: null }]));
    const r = await runNode(['desktop/scripts/release/check-pin.mjs', '--pin', withPacks(none)]);
    assert.equal(r.code, 1, 'an unpinned engine passed the release gate');
    assert.match(r.stdout, /^::error::/m);
    for (const k of Object.keys(real.packs)) assert.match(r.stdout, new RegExp(`${k} \\(no sha256, no size\\)`));
    assert.match(r.stdout, /pin-engine\.mjs/, 'the refusal does not say how to fix it');
    // One platform missing is still a broken Extensions tab on that platform; a hash that is not one is no pin.
    const one = { ...filled, 'mac-x64': { ...filled['mac-x64'], sha256: null } };
    const r1 = await runNode(['desktop/scripts/release/check-pin.mjs', '--pin', withPacks(one)]);
    assert.equal(r1.code, 1);
    assert.match(r1.stdout, /mac-x64 \(no sha256\)/);
    assert.doesNotMatch(r1.stdout, /win-x64|mac-arm64/);
    const junk = { ...filled, 'win-x64': { ...filled['win-x64'], sha256: 'not-a-sha256', bytes: 0 } };
    const r2 = await runNode(['desktop/scripts/release/check-pin.mjs', '--pin', withPacks(junk)]);
    assert.equal(r2.code, 1);
    assert.match(r2.stdout, /win-x64 \(no sha256, no size\)/);
    assert.equal((await runNode(['desktop/scripts/release/check-pin.mjs', '--pin', withPacks({})])).code, 1, 'a pin with no packs passed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the desktop app is built and tested before a release tag, on every change that reaches it', () => {
  // Until v0.44.0 desktop.yml ran only on the desktop branch, so after the merge nothing built the shell, the
  // installers or the smokes until the tag -- and a leg that first goes red at the tag ships a Release with no
  // latest.yml, so every Windows install's updater gets a 404 from the newest release. Reintroduce by dropping
  // pull_request from desktop.yml's `on:`: this names it.
  const d = parseYaml(read('.github/workflows/desktop.yml'));
  assert.ok(d.on.pull_request, 'desktop.yml does not run on pull requests');
  assert.ok(d.on.push?.branches?.includes('main'), 'desktop.yml does not run on pushes to main');
  for (const trig of ['push', 'pull_request']) {
    const paths: string[] = d.on[trig].paths ?? [];
    // What the app ships: the shell, the bff it runs (the desktop switch, routes, backups) and the web it shows.
    for (const p of ['desktop/**', 'bff/src/**', 'web/**', '.github/workflows/desktop.yml']) {
      assert.ok(paths.includes(p), `desktop.yml ${trig} does not run for ${p}`);
    }
  }
  assert.ok('workflow_call' in d.on && 'workflow_dispatch' in d.on);
  // main is never cancelled (ci.yml's reason: a cancelled run is a red run); a superseded PR push is.
  const cancel = String(d.concurrency['cancel-in-progress']);
  assert.match(cancel, /github\.event_name == 'pull_request'/);
  assert.doesNotMatch(cancel, /refs\/heads\/main|event_name == 'push'/, 'a push to main can cancel the desktop run before it');
});

test('the Phase 0 spike workflows are gone, and nothing points at the spike folders', () => {
  // They only ran on their spike branches, but they referenced desktop-engine/ and desktop-spike-solver/, which
  // the product build moved into desktop/. A workflow file that cannot work is a trap for the next person who
  // pushes one of those branches. Reintroduce by restoring either file: this names it.
  const wfs = readdirSync(join(REPO, '.github/workflows'));
  assert.deepEqual(wfs.filter((f) => /spike/.test(f)), [], 'a spike workflow is still in .github/workflows');
  for (const f of wfs) {
    const y = code(read(`.github/workflows/${f}`));
    assert.ok(!/desktop-engine\/|desktop-spike-solver/.test(y), `${f} still uses a spike folder`);
  }
  // The image builds never see the desktop app (its staged resources run to hundreds of MB).
  const ignore = read('.dockerignore').split('\n').map((l) => l.trim());
  assert.ok(ignore.includes('desktop/'), '.dockerignore does not exclude desktop/');
});

test('the extension engine is published on a prerelease the app pins, and a pinned pack is never replaced', () => {
  const y = read('.github/workflows/engine-pack.yml');
  const wf = parseYaml(y);
  const pin = JSON.parse(read('desktop/src/engine-pin.json'));
  // Its own tag family: release.yml fires on `v*`, and GitHub's "latest release" is what both updaters follow.
  assert.deepEqual(wf.on.push.tags, ['engine-v*']);
  assert.ok('workflow_dispatch' in wf.on);
  assert.match(pin.tag, /^engine-v/, 'the pin names a v* tag: release.yml would build images for it');
  assert.match(pin.tag, new RegExp(`^engine-${pin.version.replace(/\./g, '\\.')}(-\\d+)?$`), 'the engine tag does not name the Suwayomi version');
  const packMjs = read('desktop/engine/pack.mjs');
  assert.match(packMjs, new RegExp(`version: '${pin.version.replace(/\./g, '\\.')}'`), 'pack.mjs builds a different Suwayomi than the pin names');
  // One pack per platform the app ships, each built on its own OS.
  const legs = wf.jobs.pack.strategy.matrix.include.map((m: any) => m.platform).sort();
  assert.deepEqual(legs, Object.keys(pin.packs).sort());
  for (const [p, v] of Object.entries<any>(pin.packs)) assert.equal(v.file, `engine-pack-${p}.zip`);
  // Built AND booted before anything is published.
  assert.match(code(y), /desktop\/engine\/run\.mjs --pack/, 'the packs are published without being started once');
  assert.equal(wf.jobs.publish.needs, 'pack');
  assert.ok(!wf.jobs.publish.if, 'publish must not run when a pack failed');
  assert.deepEqual(wf.jobs.publish.permissions, { contents: 'write' });
  assert.equal(wf.permissions.contents, 'read');
  for (const j of Object.keys(wf.jobs)) assert.ok(wf.jobs[j]['timeout-minutes'], `engine-pack.yml job ${j} has no timeout`);
  const pub = wf.jobs.publish.steps.map((s: any) => String(s.run ?? '')).join('\n');
  // Reintroduce by dropping --prerelease from the create: the engine release can become "latest", and every
  // desktop install is offered it as an app update.
  assert.match(pub, /gh release create "\$tag"[^\n]*--prerelease/, 'the engine release is not created as a prerelease');
  assert.match(pub, /gh release edit "\$tag" --prerelease/, 'an existing engine release is not forced back to prerelease');
  assert.match(pub, /isPrerelease/, 'nothing checks it is still a prerelease after the upload');
  // Reintroduce by deleting the refusal loop: a re-run after the pin landed clobbers the file every installed app
  // version checks its download against.
  assert.match(pub, /\.packs\[\$p\]\.sha256/, 'the publish job does not refuse to replace a pinned pack');
  assert.match(pub, /sha256sum -c/, 'the packs are not checked against their .sha256 before upload');
});

// Fixture feeds shaped exactly like electron-builder's (js-yaml, lineWidth 8000).
function feedFixture(dir: string, version: string, files: Array<[string, string]>, extra = '') {
  const entries = files.map(([name, body]) => {
    writeFileSync(join(dir, name), body);
    const sha512 = createHash('sha512').update(body).digest('base64');
    return `  - url: ${name}\n    sha512: ${sha512}\n    size: ${Buffer.byteLength(body)}`;
  });
  const first = files[0][0];
  return `version: ${version}\nfiles:\n${entries.join('\n')}\npath: ${first}\nsha512: ${createHash('sha512').update(files[0][1]).digest('base64')}\n${extra}releaseDate: '2026-09-24T01:02:03.000Z'\n`;
}

test('the macOS feeds merge into one that serves each Mac its own build, and a bad feed stops the release', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feeds-'));
  try {
    const arm = feedFixture(dir, '0.44.0', [['Uchiyomi-0.44.0-arm64.zip', 'arm zip'], ['Uchiyomi-0.44.0-arm64.dmg', 'arm dmg']]);
    const x64 = feedFixture(dir, '0.44.0', [['Uchiyomi-0.44.0-x64.zip', 'intel zip'], ['Uchiyomi-0.44.0-x64.dmg', 'intel dmg']]);
    writeFileSync(join(dir, 'arm.yml'), arm);
    writeFileSync(join(dir, 'x64.yml'), x64);
    const merge = 'desktop/scripts/release/merge-latest-mac.mjs';
    const out = join(dir, 'latest-mac.yml');
    const ok = await runNode([merge, '--out', out, '--version', '0.44.0', join(dir, 'arm.yml'), join(dir, 'x64.yml')]);
    assert.equal(ok.code, 0, ok.stderr);
    const m = parseYaml(readFileSync(out, 'utf8'));
    assert.equal(m.version, '0.44.0');
    assert.deepEqual(m.files.map((f: any) => f.url).sort(), ['Uchiyomi-0.44.0-arm64.dmg', 'Uchiyomi-0.44.0-arm64.zip', 'Uchiyomi-0.44.0-x64.dmg', 'Uchiyomi-0.44.0-x64.zip']);
    // The legacy fields point at the build every Mac can run (Rosetta runs x64; nothing runs arm64 on Intel).
    assert.equal(m.path, 'Uchiyomi-0.44.0-x64.zip');
    assert.equal(m.sha512, parseYaml(x64).sha512);
    for (const f of m.files) assert.ok(f.sha512 && f.size, `${f.url} lost its sha512/size in the merge`);

    // Two feeds for ONE architecture (a matrix typo) would publish a feed with no build for the other Macs.
    // Reintroduce by dropping the "two feeds for the same architecture" check: this merge then succeeds.
    const twice = await runNode([merge, '--out', join(dir, 'bad.yml'), join(dir, 'arm.yml'), join(dir, 'arm.yml')]);
    assert.equal(twice.code, 1, 'two arm64 feeds merged into one');
    assert.match(twice.stderr, /same architecture/);
    // A leg built from a stale desktop/package.json announces the wrong version.
    const stale = await runNode([merge, '--out', join(dir, 'bad.yml'), '--version', '0.45.0', join(dir, 'arm.yml'), join(dir, 'x64.yml')]);
    assert.equal(stale.code, 1, 'a feed for the wrong version was merged');

    // check-feed: every file the feed names is there with that size and SHA-512 -- or the release stops.
    const check = 'desktop/scripts/release/check-feed.mjs';
    const good = await runNode([check, join(dir, 'x64.yml'), dir, '--version', '0.44.0']);
    assert.equal(good.code, 0, good.stderr);
    assert.equal(good.stdout.trim(), '0.44.0');
    // Reintroduce by skipping the SHA-512 comparison in check-feed.mjs: a feed that disagrees with its installer
    // then goes out, and every Windows update fails with "sha512 checksum mismatch".
    writeFileSync(join(dir, 'Uchiyomi-0.44.0-x64.dmg'), 'intel dmg, rebuilt');
    const bad = await runNode([check, join(dir, 'x64.yml'), dir]);
    assert.equal(bad.code, 1, 'a feed whose installer changed was accepted');
    assert.match(bad.stderr, /Uchiyomi-0\.44\.0-x64\.dmg: sha512/);
    rmSync(join(dir, 'Uchiyomi-0.44.0-arm64.zip'));
    const missing = await runNode([check, join(dir, 'arm.yml'), dir]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /arm64\.zip: not among the built files/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pin-engine pins what the release actually serves, and only from a prerelease', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pin-'));
  const packs: Record<string, Buffer> = {
    'engine-pack-win-x64.zip': Buffer.from('win pack'),
    'engine-pack-mac-arm64.zip': Buffer.from('arm pack!'),
    'engine-pack-mac-x64.zip': Buffer.from('intel pack'),
  };
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  let prerelease = true;
  let lie = '';
  const srv = createServer((req, res) => {
    const u = req.url || '';
    if (u === '/api') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ tag_name: 'engine-v2.3.2243', prerelease })); return; }
    const name = u.replace(/^\/dl\//, '');
    if (name.endsWith('.sha256') && packs[name.slice(0, -7)]) {
      const f = name.slice(0, -7);
      res.end(`${f === lie ? '0'.repeat(64) : sha(packs[f])}  ${f}\n`);
      return;
    }
    if (packs[name]) { res.end(packs[name]); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const pinFile = join(dir, 'engine-pin.json');
    const original = read('desktop/src/engine-pin.json');
    writeFileSync(pinFile, JSON.stringify({ ...JSON.parse(original), packs: Object.fromEntries(Object.entries(JSON.parse(original).packs).map(([k, v]: [string, any]) => [k, { ...v, sha256: null, bytes: null }])) }, null, 2));
    const args = ['desktop/scripts/release/pin-engine.mjs', '--pin', pinFile, '--base-url', `${base}/dl`, '--api', `${base}/api`, '--cache', join(dir, 'cache')];

    // Reintroduce by dropping the prerelease check: this pins from a release that could become "latest".
    prerelease = false;
    const notPre = await runNode(args);
    assert.equal(notPre.code, 1, 'pinned from a release that is not a prerelease');
    assert.match(notPre.stderr, /not marked as a prerelease/);
    prerelease = true;

    // The published .sha256 and the bytes served must agree.
    lie = 'engine-pack-mac-arm64.zip';
    const liar = await runNode(args);
    assert.equal(liar.code, 1, 'pinned a pack whose download does not match its .sha256');
    lie = '';

    const ok = await runNode(args);
    assert.equal(ok.code, 0, ok.stderr);
    const pin = JSON.parse(readFileSync(pinFile, 'utf8'));
    for (const [k, v] of Object.entries<any>(pin.packs)) {
      assert.equal(v.sha256, sha(packs[v.file]), `${k}: pinned the wrong hash`);
      assert.equal(v.bytes, packs[v.file].length, `${k}: pinned the wrong size`);
      assert.equal(statSync(join(dir, 'cache', v.file)).size, packs[v.file].length);
    }
    // The layout the file is kept in: one line per pack.
    assert.match(readFileSync(pinFile, 'utf8'), /\n {4}"win-x64": \{ "file": "engine-pack-win-x64\.zip", "sha256": "[0-9a-f]{64}", "bytes": 8 \},\n/);
    assert.equal((await runNode([...args, '--check'])).code, 0, '--check disagrees with what was just written');

    // Reintroduce by dropping the "already pinned" comparison: a pack replaced on the release after it was pinned
    // is then silently re-pinned, and every install of the older app version refuses its download.
    packs['engine-pack-win-x64.zip'] = Buffer.from('replaced pack');
    const replaced = await runNode(args);
    assert.equal(replaced.code, 1, 'a pinned pack that changed on the release was re-pinned');
    assert.match(replaced.stderr, /already pinned/);
  } finally {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
