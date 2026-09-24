#!/usr/bin/env node
// Merge the latest-mac.yml files the two macOS build legs write -- one per architecture, each listing only its
// own zip and dmg -- into the single latest-mac.yml the GitHub Release carries.
//
//   node desktop/scripts/release/merge-latest-mac.mjs --out <file> [--version X.Y.Z] <latest-mac.yml> <latest-mac.yml>
//
// Why it exists: electron-builder writes the update feed per build, and the two Macs are built on two runners
// (macos-15 for arm64, macos-15-intel for x64: no cross-building, the same rule as the Docker images). Uploading
// both under the one name the updater asks for would keep whichever landed last, and an Intel Mac would be
// offered the arm64 zip (or the reverse). electron-updater's MacUpdater picks the file for its own architecture
// out of `files` by the `arm64` in the name, so the merged feed simply carries both architectures' entries.
//
// The top-level `path` / `sha512` (read only by electron-updater < 2.15) come from the x64 leg: an Apple-silicon
// Mac can run the x64 app under Rosetta, an Intel Mac cannot run the arm64 one.
//
// ⚠️ The desktop app does NOT read this file today: an unsigned Mac cannot auto-update (Squirrel.Mac refuses an
// unsigned bundle), so updates.js asks GitHub's API for the newest release and offers the dmg. It is published
// anyway so the day there is a Developer ID the feed is already right -- and a wrong feed would be worse than
// none, hence the checks below.
//
// No dependencies (the release job runs it on a bare runner): the input is electron-builder's own js-yaml output
// for one fixed shape, so this reads that shape line by line and refuses anything it does not recognise rather
// than guessing.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const unquote = (s) => {
  const t = s.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1);
  return t;
};

/**
 * `{ top: [{ key, lines }], files: [{ url, lines }] }` -- raw lines kept, so what is written back is exactly what
 * electron-builder wrote, only regrouped.
 * @param {string} text
 * @param {string} [name]
 */
export function parseUpdateInfo(text, name = 'latest-mac.yml') {
  const top = [];
  const files = [];
  let inFiles = false;
  let item = null;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (const [i, line] of lines.entries()) {
    if (line.trim() === '') continue;
    if (!/^\s/.test(line)) {
      const m = /^([A-Za-z0-9_]+):(.*)$/.exec(line);
      if (!m) throw new Error(`${name}:${i + 1}: not a "key: value" line: ${line}`);
      inFiles = m[1] === 'files';
      if (inFiles && m[2].trim() !== '') throw new Error(`${name}:${i + 1}: files is not a list`);
      item = null;
      top.push({ key: m[1], lines: [line] });
      continue;
    }
    if (inFiles) {
      if (/^ {2}- /.test(line)) {
        item = { url: null, lines: [line] };
        files.push(item);
      } else if (/^ {4}\S/.test(line) && item) {
        item.lines.push(line);
      } else {
        throw new Error(`${name}:${i + 1}: unexpected indentation inside files: ${line}`);
      }
      const u = /^ {2}(?:- | {2})url:(.*)$/.exec(line);
      if (u && item) item.url = unquote(u[1]);
      continue;
    }
    // A continuation of the previous top-level value (a folded releaseNotes, say): it travels with its key.
    if (!top.length) throw new Error(`${name}:${i + 1}: indented line before any key`);
    top[top.length - 1].lines.push(line);
  }
  for (const f of files) if (!f.url) throw new Error(`${name}: a files entry has no url`);
  return { top, files };
}

const value = (info, key) => {
  const t = info.top.find((x) => x.key === key);
  return t ? unquote(t.lines[0].slice(key.length + 1)) : undefined;
};

/**
 * @param {Array<{ name: string, text: string }>} inputs
 * @param {{ version?: string }} [o]
 * @returns {string}
 */
export function mergeUpdateInfo(inputs, o = {}) {
  if (inputs.length < 2) throw new Error(`expected one latest-mac.yml per architecture, got ${inputs.length}`);
  const infos = inputs.map(({ name, text }) => ({ name, ...parseUpdateInfo(text, name) }));
  for (const inf of infos) {
    for (const k of ['version', 'files', 'path', 'sha512']) {
      if (!inf.top.some((t) => t.key === k)) throw new Error(`${inf.name}: no ${k}`);
    }
    if (!inf.files.length) throw new Error(`${inf.name}: files is empty`);
    for (const f of inf.files) {
      if (!/\.(zip|dmg)$/.test(f.url)) throw new Error(`${inf.name}: ${f.url} is neither a zip nor a dmg`);
    }
    if (!inf.files.some((f) => f.url.endsWith('.zip'))) throw new Error(`${inf.name}: no zip (Squirrel.Mac updates from the zip, never the dmg)`);
  }
  // One version, and the one being released: a leg built from a stale desktop/package.json would otherwise
  // publish a feed that announces the wrong version.
  const versions = new Set(infos.map((inf) => value(inf, 'version')));
  if (versions.size !== 1) throw new Error(`the legs disagree on the version: ${[...versions].join(', ')}`);
  const version = [...versions][0];
  if (o.version && version !== o.version) throw new Error(`latest-mac.yml says ${version}, the release is ${o.version}`);
  // Each leg one architecture: two arm64 feeds (a matrix typo) would merge into a feed with no Intel build.
  const arch = (inf) => {
    const a = new Set(inf.files.map((f) => (/-arm64\.(zip|dmg)$/.test(f.url) ? 'arm64' : 'x64')));
    if (a.size !== 1) throw new Error(`${inf.name}: mixes architectures (${[...a].join(', ')})`);
    return [...a][0];
  };
  const archs = infos.map(arch);
  if (new Set(archs).size !== archs.length) throw new Error(`two feeds for the same architecture: ${archs.join(', ')}`);

  const primary = infos[Math.max(0, archs.indexOf('x64'))];
  const seen = new Map();
  const files = [];
  for (const inf of [primary, ...infos.filter((x) => x !== primary)]) {
    for (const f of inf.files) {
      const prev = seen.get(f.url);
      if (prev !== undefined) {
        if (prev !== f.lines.join('\n')) throw new Error(`${f.url} appears twice with different contents`);
        continue;
      }
      seen.set(f.url, f.lines.join('\n'));
      files.push(...f.lines);
    }
  }
  const out = [];
  for (const t of primary.top) {
    if (t.key === 'files') out.push('files:', ...files);
    else out.push(...t.lines);
  }
  return `${out.join('\n')}\n`;
}

// realpath on both sides: run through a symlinked checkout, argv[1] is the link and import.meta.url the target.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const take = (k) => {
    const i = argv.indexOf(k);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    argv.splice(i, 2);
    return v;
  };
  const out = take('--out');
  const version = take('--version');
  if (!out || argv.length < 2) {
    console.error('usage: merge-latest-mac.mjs --out <file> [--version X.Y.Z] <latest-mac.yml> <latest-mac.yml>');
    process.exit(2);
  }
  try {
    const merged = mergeUpdateInfo(argv.map((f) => ({ name: f, text: fs.readFileSync(f, 'utf8') })), { version });
    fs.writeFileSync(out, merged);
    console.log(merged);
  } catch (e) {
    console.error(`merge-latest-mac: ${e.message}`);
    process.exit(1);
  }
}
