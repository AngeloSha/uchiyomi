#!/usr/bin/env node
// Fill desktop/src/engine-pin.json from the engine packs AS PUBLISHED: download each one from the release, hash
// what actually arrived, check it against the .sha256 the engine-pack workflow uploaded beside it, and write the
// hash and the size into the pin. Run it once, after .github/workflows/engine-pack.yml has published a new
// `engine-v*` prerelease, and commit the result before tagging the app release that should download it.
//
//   node desktop/scripts/release/pin-engine.mjs            download, verify, write the pin
//   node desktop/scripts/release/pin-engine.mjs --check    download and verify only; exit 1 if the pin differs
//
// Why download instead of copying the hash out of the workflow log: the pin is what every desktop install will
// hold the download to, forever, for this app version. It should be the hash of the bytes GitHub serves, not
// of a file on a runner that no longer exists -- and a pack replaced after the fact (a re-run that clobbered
// it) must be caught HERE, before a release ships a pin nobody can satisfy.
//
// Also refuses to pin from a release that is not a PRERELEASE: electron-updater and the app's own macOS update
// check both follow GitHub's "latest release", and an engine release marked latest would be offered to every
// desktop install as an app update.
//
// Test hooks (bff/test/releasePipeline.test.ts): --pin <file>, --base-url <url>, --api <url>, --cache <dir>.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const pinFile = path.resolve(opt('--pin') || path.join(here, '..', '..', 'src', 'engine-pin.json'));
const cacheDir = path.resolve(opt('--cache') || path.join(here, '..', '..', '.cache', 'engine-pin'));
const checkOnly = argv.includes('--check');

const pin = JSON.parse(await fsp.readFile(pinFile, 'utf8'));
const baseUrl = (opt('--base-url') || pin.baseUrl).replace(/\/+$/, '');
const repo = /github\.com\/([^/]+\/[^/]+)\/releases\/download\//.exec(pin.baseUrl)?.[1];
const api = opt('--api') || (repo && `https://api.github.com/repos/${repo}/releases/tags/${pin.tag}`);
if (!/^engine-v/.test(pin.tag)) throw new Error(`the pin's tag ${pin.tag} is not an engine-v* tag`);

const headers = process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {};
const rel = await fetch(api, { headers: { accept: 'application/vnd.github+json', ...headers } });
if (!rel.ok) throw new Error(`${api}: HTTP ${rel.status} -- is ${pin.tag} published yet? (run .github/workflows/engine-pack.yml)`);
const release = await rel.json();
if (release.prerelease !== true) {
  throw new Error(`${pin.tag} is not marked as a prerelease. Mark it one first (gh release edit ${pin.tag} --prerelease): as a normal release it can become "latest", and every desktop app would be offered the engine as an update.`);
}

await fsp.mkdir(cacheDir, { recursive: true });
const found = {};
for (const [key, p] of Object.entries(pin.packs)) {
  const url = `${baseUrl}/${p.file}`;
  const sumRes = await fetch(`${url}.sha256`, { redirect: 'follow' });
  if (!sumRes.ok) throw new Error(`${url}.sha256: HTTP ${sumRes.status}`);
  const published = (await sumRes.text()).trim().split(/\s+/)[0].toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(published)) throw new Error(`${url}.sha256 does not hold a SHA-256: ${published}`);

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const dest = path.join(cacheDir, p.file);
  const h = crypto.createHash('sha256');
  let bytes = 0;
  const out = fs.createWriteStream(`${dest}.part`);
  for await (const chunk of Readable.fromWeb(res.body)) {
    h.update(chunk);
    bytes += chunk.length;
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  await fsp.rename(`${dest}.part`, dest);
  const sha256 = h.digest('hex');
  if (sha256 !== published) throw new Error(`${p.file}: the download hashes to ${sha256}, but ${p.file}.sha256 says ${published}`);
  // A pack already pinned must never change under its pin: every install of that app version would refuse it.
  if (p.sha256 && p.sha256.toLowerCase() !== sha256) {
    throw new Error(`${p.file}: already pinned to ${p.sha256}, but the release now serves ${sha256}. A published pack was replaced; a new pack needs a new engine-v* tag.`);
  }
  found[key] = { sha256, bytes };
  console.log(`${key}: ${p.file} ${bytes} bytes sha256 ${sha256}`);
}

const changed = Object.entries(found).some(([k, v]) => pin.packs[k].sha256 !== v.sha256 || pin.packs[k].bytes !== v.bytes);
if (checkOnly) {
  if (changed) { console.error(`${pinFile} does not match the published packs`); process.exit(1); }
  console.log(`${pinFile} matches the published packs`);
  process.exit(0);
}
for (const [k, v] of Object.entries(found)) Object.assign(pin.packs[k], v);
// The file's own layout: one line per pack, so a diff of a new pin is three readable lines.
const { packs, ...rest } = pin;
const head = JSON.stringify(rest, null, 2).replace(/\n}$/, '');
const body = Object.entries(packs).map(([k, v]) => `    ${JSON.stringify(k)}: { ${Object.entries(v).map(([a, b]) => `${JSON.stringify(a)}: ${JSON.stringify(b)}`).join(', ')} }`).join(',\n');
await fsp.writeFile(pinFile, `${head},\n  "packs": {\n${body}\n  }\n}\n`);
console.log(changed ? `wrote ${pinFile}` : `${pinFile} already matched`);
