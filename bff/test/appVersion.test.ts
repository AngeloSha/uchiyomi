// Knowing what version is running, which nothing did until the update check needed it.
//
// The failure mode here is quiet: `appVersion()` returns null, the health row says "could not read the
// running version" instead of comparing anything, and the install count reports `"version": null` — so the
// one number the whole feature exists to produce would be missing, in the built image only, while every
// test on a developer's checkout passed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appVersion, packageJsonPath, resetAppVersion } from '../src/lib/appVersion';

const REPO = join(new URL('../..', import.meta.url).pathname);

test('it reads the real version out of the real package.json', () => {
  resetAppVersion();
  const pkg = JSON.parse(readFileSync(join(REPO, 'bff', 'package.json'), 'utf8'));
  assert.equal(appVersion(), pkg.version);
  assert.match(appVersion() ?? '', /^\d+\.\d+\.\d+/);
});

test('it is memoised, because it cannot change while the process lives', () => {
  resetAppVersion();
  const a = appVersion();
  assert.equal(appVersion(), a);
});

test('THE IMAGES SHIP IT NEXT TO dist/, or the version is null in production only', () => {
  // ⚠️ `packageJsonPath()` walks two directories up from the running file: `src/lib/` under tsx and
  // `dist/lib/` in an image, so both resolve to the package root. That only holds while each Dockerfile
  // copies package.json into the same WORKDIR it copies dist into.
  // Reintroduce by deleting either COPY line: nothing fails to build, nothing errors at runtime, and every
  // install silently reports an unknown version.
  for (const [file, pkg] of [['bff/Dockerfile', 'package.json'], ['Dockerfile.aio', 'bff/package.json']] as const) {
    const src = readFileSync(join(REPO, file), 'utf8');
    assert.match(src, new RegExp(`COPY ${pkg.replace('.', '\\.')} `), `${file} no longer ships ${pkg}`);
    assert.match(src, /COPY --from=\w+ \/app\/dist \.\/dist/, `${file} no longer puts dist where the walk expects it`);
  }
  assert.equal(packageJsonPath().endsWith('/package.json'), true);
});

test('an unreadable package.json is null rather than a crash', (t) => {
  // The server must not fail to start over a version string. Reintroduce by letting the JSON.parse throw.
  resetAppVersion();
  t.mock.method(JSON, 'parse', () => { throw new Error('nope'); });
  assert.equal(appVersion(), null);
  resetAppVersion();
});
