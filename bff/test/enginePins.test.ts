// Every place that names the extension engine's version names the same one.
//
// Suwayomi migrates its own database forward when a newer version starts on it, and an older one does not read
// what a newer one wrote. The engine's data is the same data wherever it runs: a Compose volume moved to the
// Unraid template, a CasaOS add-on, the desktop app's download. So "switching setups never downgrades the engine"
// (#72) holds only while every pin moves together -- and before this test nothing made them. The pin is written
// in the four compose files, the CasaOS add-on, the Unraid engine template, the desktop app's pack builder and
// the pin file it downloads by, and the desktop workflow's cache key; the fake engine's schema is captured from it,
// the desktop solver's contract decodes with its FlareSolverr DTOs, and the server's own TESTED_ENGINE (enginePin.ts,
// what Health compares a running engine with) names it.
//
// The list is scripts/engine/pins.json, shared with scripts/engine/bump.mjs, which moves every one of them for a new
// engine (the weekly canary runs it on a branch). The desktop pin file is the reference: it is what a desktop install
// downloads, and a pack is published under the tag it names. Everything else is held equal to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// ENGINE_PINS_REPO: another checkout to hold to the same rules -- engineCanaryScripts.test.ts runs this file on a
// temporary copy that scripts/engine/bump.mjs has just moved to a new engine.
const REPO = process.env.ENGINE_PINS_REPO || join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');

const PINS = JSON.parse(read('scripts/engine/pins.json'));
const PIN_FILE = JSON.parse(read(PINS.pin));
const PIN: string = PIN_FILE.version;

/**
 * Every file that runs the engine from its container image, or tells someone to -- web/lib/engineSetup.ts too, the
 * "somewhere else" step of Admin → Extensions' setup screen, which offers a docker run to copy (#72).
 */
const IMAGE_FILES: string[] = PINS.images;

test('the shared pin list names files that exist, and every compose file that runs the engine', () => {
  // Reintroduce by dropping a compose file from scripts/engine/pins.json: this test stops checking it and bump.mjs stops
  // moving it, so that setup alone would run the old engine on data a newer one already migrated.
  for (const f of [PINS.pin, PINS.pack, PINS.workflow, PINS.tested, PINS.fake, PINS.solverDtos.dir, PINS.solverDtos.test, ...IMAGE_FILES]) assert.ok(existsSync(join(REPO, f)), `${f} is gone`);
  for (const f of ['deploy/docker-compose.yml', 'deploy/docker-compose.external-db.yml', 'deploy/docker-compose.split.yml', 'docker-compose.yml']) {
    assert.ok(IMAGE_FILES.includes(f), `${f} runs the engine and is not in scripts/engine/pins.json`);
  }
});

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

test("the server's TESTED_ENGINE is the pin", () => {
  // Health compares a running engine's version with it (enginePin.ts engineStanding). Left behind at a bump, every
  // install would be told its newly pinned engine is "newer than the version this Uchiyomi was tested with".
  // Reintroduce by bumping the pin without enginePin.ts: this names both.
  const tested = read(PINS.tested).match(/export const TESTED_ENGINE = '([^']+)'/)?.[1];
  assert.equal(tested, PIN, `${PINS.tested} says TESTED_ENGINE = ${tested}, but the pin is ${PIN}`);
  const oldest = read(PINS.tested).match(/export const OLDEST_ENGINE = '([^']+)'/)?.[1];
  assert.ok(oldest, 'OLDEST_ENGINE went missing');
});

test("the solver contract reads the pinned engine's FlareSolverr DTOs, and no other engine's", () => {
  // The desktop solver answers Suwayomi in its FlareSolverr shapes, and desktop/test/solver.contract.test.ts decodes those
  // answers as Suwayomi does: strictly, by the request/response classes copied verbatim from CloudflareInterceptor.kt
  // at the pinned tag. Left at another engine's classes, the contract passes while the pinned engine refuses the
  // answers. bump.mjs moves the copy with the pin; this holds it there. Reintroduce by pointing the contract test back
  // at suwayomi-v2.3.2243-FlareSolverDtos.kt (and restoring that file): the first assertion names it.
  const { dir, test: contract } = PINS.solverDtos;
  const want = `suwayomi-${PIN}-FlareSolverDtos.kt`;
  const named = [...new Set([...read(contract).matchAll(/'(suwayomi-[^']*-FlareSolverDtos\.kt)'/g)].map((m) => m[1]))];
  assert.deepEqual(named, [want], `${contract} decodes with ${named.join(', ') || 'no DTO fixture'}, but the pin is ${PIN}`);
  const kept = readdirSync(join(REPO, dir)).filter((f) => /^suwayomi-.*-FlareSolverDtos\.kt$/.test(f));
  assert.deepEqual(kept, [want], `${dir} holds ${kept.join(', ')}: the pinned engine's DTOs, and no other engine's`);
  const head = read(`${dir}/${want}`).split('\n', 1)[0];
  assert.match(head, new RegExp(`^// Verbatim: Suwayomi-Server ${PIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} CloudflareInterceptor\\.kt lines \\d+-\\d+ `),
    `${want} does not say it is ${PIN}'s CloudflareInterceptor.kt, verbatim`);
});
