// Every place that names the extension engine's version names the same one.
//
// Suwayomi migrates its own database forward when a newer version starts on it, and an older one does not read
// what a newer one wrote. The engine's data is the same data wherever it runs: a Compose volume moved to the
// Unraid template, a CasaOS add-on, the desktop app's download. So "switching setups never downgrades the engine"
// (#72) holds only while every pin moves together -- and before this test nothing made them. The pin is written
// in the four compose files, the CasaOS add-on, the Unraid engine template, the desktop app's pack builder and
// the pin file it downloads by, and the desktop workflow's cache key; the fake engine's schema is captured from it.
//
// The desktop pin file is the reference: it is what a desktop install downloads, and a pack is published under
// the tag it names. Everything else is held equal to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');

const PIN_FILE = JSON.parse(read('desktop/src/engine-pin.json'));
const PIN: string = PIN_FILE.version;

/** Every file that runs the engine from its container image, or tells someone to. */
const IMAGE_FILES = [
  'deploy/docker-compose.yml',
  'deploy/docker-compose.external-db.yml',
  'deploy/docker-compose.split.yml',
  'docker-compose.yml',
  'deploy/casaos/uchiyomi-suwayomi.yml',
  'templates/uchiyomi-suwayomi.xml',
  // The "somewhere else" step of Admin → Extensions' setup screen: the docker run it offers to copy (#72).
  'web/lib/engineSetup.ts',
];

test('the desktop pin is a Suwayomi release tag', () => {
  assert.match(PIN, /^v\d+\.\d+\.\d+$/, `desktop/src/engine-pin.json names "${PIN}", which is not a Suwayomi-Server release tag`);
});

/**
 * Reintroduce by bumping one compose file's tag to v2.3.9999: the assertion names the file whose engine would
 * migrate the shared data ahead of the others.
 */
test('every engine image is the pinned version', () => {
  for (const file of IMAGE_FILES) {
    const tags = [...read(file).matchAll(/ghcr\.io\/suwayomi\/suwayomi-server:([^\s"'<]+)/g)].map((m) => m[1]);
    assert.ok(tags.length > 0, `${file} no longer names the engine image; if it moved, update this list`);
    for (const tag of tags) {
      assert.equal(tag, PIN, `${file} runs suwayomi-server:${tag}, but the pin is ${PIN}: that engine would migrate the shared data ahead of (or behind) every other setup`);
    }
  }
});

test("the desktop app's engine pack is built from the pinned release", () => {
  const pack = read('desktop/engine/pack.mjs');
  const block = pack.slice(pack.indexOf('export const SUWAYOMI = {'));
  const version = block.match(/^\s+version: '([^']+)'/m)?.[1];
  assert.equal(version, PIN, `desktop/engine/pack.mjs builds ${version} while the app downloads ${PIN}`);
  // The asset names carry the version too, and the download URL is built from both: a bump of one without the
  // other builds a 404, or quietly packs the old engine under the new name.
  const assets = [...block.slice(0, block.indexOf('\n};')).matchAll(/name: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(assets.length >= 3, 'the pack builder lists no release assets');
  for (const a of assets) assert.ok(a.includes(`-${PIN}-`), `desktop/engine/pack.mjs downloads ${a}, which is not the ${PIN} release`);
  // The pack is published under a prerelease tag named for the engine (engine-v…, or engine-v…-2 for a rebuilt
  // pack of the same engine), and the app downloads from that tag's release.
  assert.match(PIN_FILE.tag, new RegExp(`^engine-${PIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-\\d+)?$`), `engine-pin.json's tag ${PIN_FILE.tag} is not a pack of ${PIN}`);
  assert.ok(String(PIN_FILE.baseUrl).endsWith(`/releases/download/${PIN_FILE.tag}`), "engine-pin.json downloads from a release other than its own tag's");
});

test("the desktop workflow's engine cache is keyed by the pin", () => {
  // A stale key restores the previous engine's pack into a build of the new one.
  const wf = read('.github/workflows/desktop.yml');
  assert.equal(wf.match(/^\s+SUWAYOMI: (\S+)$/m)?.[1], PIN, '.github/workflows/desktop.yml caches the engine under another version');
});

test("the fake engine's schema is the pinned engine's", () => {
  // The strict fake (test/fixtures/fakeSuwayomiEngine.mjs) refuses whatever this schema lacks. Captured from an
  // older or newer engine, it would pass queries the pinned one refuses. Re-capture with captureSuwayomiSchema.mjs.
  const file = read('bff/test/fixtures/fakeSuwayomiEngine.mjs').match(/new URL\('\.\/(suwayomi-[^']+-schema\.json)'/)?.[1];
  assert.ok(file, 'the fake engine no longer names its schema file');
  const schema = JSON.parse(read(`bff/test/fixtures/${file}`));
  assert.equal(schema.engine.version, PIN, `the fake engine validates against ${schema.engine.version}'s schema, but the pin is ${PIN}`);
});
