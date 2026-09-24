// The extension-engine pack the smokes install, without pulling ~200 MB from anywhere on every run:
//   - once engine-pin.json holds a SHA-256 for this platform (the engine-v* prerelease is published), the
//     PINNED pack itself, downloaded once into the actions cache and checked against the pin -- the exact file
//     users get;
//   - until then, one built here by engine/pack.mjs from the cached Suwayomi release (needs a JDK 21 for the shim).
// Writes ci-out/engine-fixture.json { file, sha256, source } for the smokes, which serve it on loopback and
// hand the app --engine-pack-url/--engine-pack-sha256.
//   node scripts/ci/engine-fixture.mjs [--cache .cache]
import { createRequire } from 'node:module';
import { createWriteStream, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DESKTOP, OUT, runSync } from './lib.mjs';

const require = createRequire(import.meta.url);
const { platformKey, resolvePack, PIN } = require('../../src/engine.js');
const archive = require('../../src/archive.js');
const argv = process.argv.slice(2);
const cache = resolve(argv.includes('--cache') ? argv[argv.indexOf('--cache') + 1] : join(DESKTOP, '.cache'));
const key = platformKey();
const pinned = resolvePack(PIN, {}, key);
let out;
if (pinned.url && pinned.sha256) {
  const dir = join(cache, 'engine-pack');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${pinned.sha256}.zip`);
  if (!existsSync(file) || (await archive.sha256File(file)) !== pinned.sha256) {
    console.log(`downloading the pinned pack ${pinned.url}`);
    const r = await fetch(pinned.url, { redirect: 'follow' });
    if (!r.ok || !r.body) throw new Error(`GET ${pinned.url}: ${r.status}`);
    await pipeline(Readable.fromWeb(r.body), createWriteStream(`${file}.part`));
    renameSync(`${file}.part`, file);
  }
  const got = await archive.sha256File(file);
  if (got !== pinned.sha256) throw new Error(`the published pack ${pinned.url} does not match the pin: ${got} != ${pinned.sha256}`);
  out = { file, sha256: got, source: 'pinned', url: pinned.url };
} else {
  const build = join(cache, 'engine-build');
  const r = runSync(process.execPath, [join(DESKTOP, 'engine', 'pack.mjs'), '--platform', key, '--cache', join(cache, 'suwayomi'), '--out', build], { stdio: 'inherit' });
  if (r.code !== 0) throw new Error(`engine/pack.mjs failed (${r.code})`);
  const file = join(build, `engine-pack-${key}.zip`);
  out = { file, sha256: await archive.sha256File(file), source: 'built-here (engine-pin.json has no sha256 for this platform yet)' };
}
writeFileSync(join(OUT, 'engine-fixture.json'), JSON.stringify(out, null, 2));
console.log(`engine fixture: ${JSON.stringify(out)}`);
