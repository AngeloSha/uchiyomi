#!/usr/bin/env node
// Refuse to ship a desktop app whose extension-engine pin names no published pack.
//
//   node desktop/scripts/release/check-pin.mjs [--pin <engine-pin.json>]
//
// Prints one line per pack and exits 0 when every pack in the pin has a SHA-256 and a size; otherwise prints a
// GitHub ::error:: naming the packs that have none and exits 1.
//
// Why this exists: while a pack's sha256 is null the app says "The extension engine download is not available
// for this version of Uchiyomi yet" and never fetches anything (engine.js resolvePack) -- by design, so a build
// from an unpinned tree is safe to run. But NOTHING else in a release run notices: desktop.yml's smokes build
// their own pack when the pin is empty (scripts/ci/engine-fixture.mjs) and pass, so a v* tag pushed before the
// engine-v* prerelease is published and pinned ships a desktop app whose Admin -> Extensions is broken for every
// user, from a fully green run. The order is: push the engine-v* tag (engine-pack.yml publishes the packs), run
// desktop/scripts/release/pin-engine.mjs, commit engine-pin.json, THEN tag the app release.
//
// Static on purpose: pin-engine.mjs already downloaded every pack and hashed what GitHub serves when it wrote the
// pin, and engine-pack.yml refuses to replace a pinned pack. This only has to catch "never pinned" -- and it runs
// in seconds, before 30-60 minutes of desktop builds (desktop.yml, on a tag) and before any upload
// (release.yml desktop-publish).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const i = argv.indexOf('--pin');
const pinFile = path.resolve(i >= 0 ? argv[i + 1] : path.join(here, '..', '..', 'src', 'engine-pin.json'));

/**
 * The packs a pin cannot deliver, with why. Empty = every pack is pinned.
 * @param {any} pin
 * @returns {string[]}
 */
export function unpinned(pin) {
  const packs = Object.entries(pin?.packs ?? {});
  if (!packs.length) return ['(the pin lists no packs at all)'];
  const bad = [];
  for (const [key, v] of packs) {
    const why = [];
    if (!/^[0-9a-f]{64}$/.test(String(v?.sha256 ?? ''))) why.push('no sha256');
    if (!(Number.isInteger(v?.bytes) && v.bytes > 0)) why.push('no size');
    if (why.length) bad.push(`${key} (${why.join(', ')})`);
  }
  return bad;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pin = JSON.parse(fs.readFileSync(pinFile, 'utf8'));
  const bad = unpinned(pin);
  if (bad.length) {
    console.log(`::error::engine-pin.json has no published extension-engine pack for ${bad.join('; ')}. `
      + `Push the ${pin.tag || 'engine-v*'} tag, run desktop/scripts/release/pin-engine.mjs and commit the pin before tagging the app release: `
      + 'an unpinned desktop build tells every user the engine download is not available.');
    process.exit(1);
  }
  for (const [key, v] of Object.entries(pin.packs)) console.log(`${key}: ${v.file} ${v.bytes} B sha256 ${v.sha256}`);
  console.log(`engine pin ok: ${pin.tag}`);
}
