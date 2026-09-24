#!/usr/bin/env node
// Check an electron-builder update feed (latest.yml / latest-mac.yml) against the files it names, before the
// release uploads it: every file is present, and its size and SHA-512 are the ones the feed announces.
//
//   node desktop/scripts/release/check-feed.mjs <feed.yml> <dir-with-the-files> [--version X.Y.Z]
//
// Prints the feed's version. Exits 1 on any mismatch.
//
// Why: electron-updater downloads the file a feed names and refuses it unless its SHA-512 matches the feed, so a
// feed that disagrees with the installer next to it does not fail at upload -- it fails on every Windows PC that
// tries to update, as "sha512 checksum mismatch", from then until the next release. The feed and the installer
// come from the same electron-builder run, so this should never fire; it is here so that a re-run that rebuilt
// one leg, a clobbered upload or a hand-edited feed is caught by the release job and not by users.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUpdateInfo } from './merge-latest-mac.mjs';

const field = (lines, key) => {
  for (const l of lines) {
    const m = new RegExp(`^ {2}(?:- | {2})${key}:(.*)$`).exec(l);
    if (m) return m[1].trim().replace(/^'(.*)'$/, '$1');
  }
  return undefined;
};

/**
 * @param {string} feedText
 * @param {string} dir
 * @param {{ name?: string, version?: string }} [o]
 * @returns {{ version: string, files: string[] }}
 */
export function checkFeed(feedText, dir, o = {}) {
  const name = o.name || 'feed';
  const info = parseUpdateInfo(feedText, name);
  const top = (k) => {
    const t = info.top.find((x) => x.key === k);
    return t ? t.lines[0].slice(k.length + 1).trim().replace(/^'(.*)'$/, '$1') : undefined;
  };
  const version = top('version');
  if (!version) throw new Error(`${name}: no version`);
  if (o.version && version !== o.version) throw new Error(`${name} says ${version}, the release is ${o.version}`);
  if (!info.files.length) throw new Error(`${name}: files is empty`);
  const problems = [];
  for (const f of info.files) {
    if (!f.url.includes(version)) problems.push(`${f.url}: its name does not carry the version ${version}`);
    const p = path.join(dir, f.url);
    if (!fs.existsSync(p)) { problems.push(`${f.url}: not among the built files`); continue; }
    const sha512 = field(f.lines, 'sha512');
    const size = field(f.lines, 'size');
    const got = crypto.createHash('sha512').update(fs.readFileSync(p)).digest('base64');
    if (sha512 !== got) problems.push(`${f.url}: sha512 ${got} but the feed says ${sha512}`);
    if (size !== undefined && Number(size) !== fs.statSync(p).size) problems.push(`${f.url}: ${fs.statSync(p).size} bytes but the feed says ${size}`);
  }
  // The legacy top-level path must be one of the files, or an electron-updater < 2.15 downloads nothing.
  const legacy = top('path');
  if (legacy && !info.files.some((f) => f.url === legacy)) problems.push(`path: ${legacy} is not in files`);
  if (problems.length) throw new Error(`${name}:\n  ${problems.join('\n  ')}`);
  return { version, files: info.files.map((f) => f.url) };
}

// realpath on both sides: run through a symlinked checkout, argv[1] is the link and import.meta.url the target.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const vi = argv.indexOf('--version');
  const version = vi >= 0 ? argv.splice(vi, 2)[1] : undefined;
  const [feed, dir] = argv;
  if (!feed || !dir) {
    console.error('usage: check-feed.mjs <feed.yml> <dir> [--version X.Y.Z]');
    process.exit(2);
  }
  try {
    const r = checkFeed(fs.readFileSync(feed, 'utf8'), dir, { name: feed, version });
    console.error(`${feed}: ${r.version}, ${r.files.join(', ')} -- sizes and SHA-512 match`);
    console.log(r.version);
  } catch (e) {
    console.error(`check-feed: ${e.message}`);
    process.exit(1);
  }
}
