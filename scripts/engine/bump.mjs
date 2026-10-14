#!/usr/bin/env node
// bump.mjs <tag>: move every pin of the extension engine (Suwayomi-Server) to <tag>, in one go.
//
//   node scripts/engine/bump.mjs v2.4.2366 --schema <its captured schema.json>
//
// The places are scripts/engine/pins.json's, the list bff/test/enginePins.test.ts holds equal:
//   * the image tag in every compose file, CasaOS, the Unraid template and web/lib/engineSetup.ts;
//   * desktop/engine/pack.mjs: the version, the four asset names, and their SHA-256 from the release's Checksums.sha256;
//   * desktop/src/engine-pin.json: the version, the pack's tag (engine-<tag>) and base URL, and the packs' hashes and
//     sizes set to null -- no pack exists for <tag> until engine-pack.yml publishes one, and a null hash is how the app
//     knows not to download (desktop/src/engine.js);
//   * SUWAYOMI in .github/workflows/desktop.yml, and TESTED_ENGINE in bff/src/lib/sources/suwayomi/enginePin.ts;
//   * the schema the fake engine validates against: bff/test/fixtures/suwayomi-<tag>-schema.json, from --schema (the
//     weekly canary captures it from the running engine), and SCHEMA_FILE in fakeSuwayomiEngine.mjs;
//   * the FlareSolverr request/response DTOs the solver contract is checked against, extracted verbatim from
//     CloudflareInterceptor.kt at <tag>, and the contract test's reference to them.
// Every rewrite must find what it rewrites, or nothing is written: a pin left behind is the bug this exists to stop.
// Then it prints what is left to do by hand.
//
// Network: the release's Checksums.sha256 and CloudflareInterceptor.kt from GitHub, unless --checksums <file> and
// --interceptor <file> give them. --repo <dir> works on another checkout (the tests' temporary copy).
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const TAG = /^v\d+\.\d+\.\d+$/;
const PACK_ASSETS = ['windows-x64.zip', 'macOS-arm64.tar.gz', 'macOS-x64.tar.gz', 'linux-x64.tar.gz'];
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replace every match of `re` in `text`, insisting there is at least one. */
function must(text, re, to, what) {
  const n = (text.match(re) ?? []).length;
  if (!n) throw new Error(`bump: ${what}: nothing to rewrite (${re})`);
  return text.replace(re, to);
}

/** `<sha256>  <file>` lines → Map(file → sha256). */
export function parseChecksums(text) {
  const out = new Map();
  for (const line of String(text).split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(\S.*)$/i.exec(line.trim());
    if (m) out.set(m[2].trim(), m[1].toLowerCase());
  }
  return out;
}

/** The FlareSolverr DTOs of CloudflareInterceptor.kt, verbatim, with the lines they came from. */
export function extractDtos(kt) {
  const lines = String(kt).split('\n');
  const cookie = lines.findIndex((l) => /^\s*data class FlareSolverCookie\(/.test(l));
  if (cookie < 1 || !/^\s*@Serializable\s*$/.test(lines[cookie - 1])) throw new Error('bump: CloudflareInterceptor.kt: no @Serializable data class FlareSolverCookie(');
  const response = lines.findIndex((l, i) => i > cookie && /^\s*data class FlareSolverResponse\(/.test(l));
  if (response < 0) throw new Error('bump: CloudflareInterceptor.kt: no data class FlareSolverResponse(');
  const end = lines.findIndex((l, i) => i > response && /^\s*\)\s*$/.test(l));
  if (end < 0) throw new Error('bump: CloudflareInterceptor.kt: FlareSolverResponse never closes');
  return { first: cookie, last: end + 1, body: lines.slice(cookie - 1, end + 1).join('\n') };
}

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'uchiyomi-engine-bump' }, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

export async function bump(tag, o = {}) {
  const root = resolve(o.repo ?? ROOT);
  if (!TAG.test(tag)) throw new Error(`bump: ${tag} is not a release tag (vX.Y.Z)`);
  const at = (p) => join(root, p);
  const pins = JSON.parse(readFileSync(at('scripts/engine/pins.json'), 'utf8'));
  const old = JSON.parse(readFileSync(at(pins.pin), 'utf8')).version;
  if (!TAG.test(old)) throw new Error(`bump: the current pin ${old} is not a release tag`);
  if (old === tag) throw new Error(`bump: ${tag} is already the pin`);
  if (!o.schema) throw new Error('bump: --schema <file> is required: the schema of a running engine of that tag (captureSuwayomiSchema.mjs; the canary captures it)');
  const schemaText = readFileSync(o.schema, 'utf8');
  const schema = JSON.parse(schemaText);
  if (schema.engine?.version !== tag) throw new Error(`bump: ${o.schema} is the schema of ${schema.engine?.version}, not ${tag}`);
  const checksums = parseChecksums(o.checksums ? readFileSync(o.checksums, 'utf8')
    : await fetchText(`https://github.com/Suwayomi/Suwayomi-Server/releases/download/${tag}/Checksums.sha256`));
  const interceptorPath = 'server/src/main/kotlin/eu/kanade/tachiyomi/network/interceptor/CloudflareInterceptor.kt';
  const interceptor = o.interceptor ? readFileSync(o.interceptor, 'utf8')
    : await fetchText(`https://raw.githubusercontent.com/Suwayomi/Suwayomi-Server/${tag}/${interceptorPath}`);
  const dtos = extractDtos(interceptor);

  /** Everything to write, gathered first: nothing is written unless every rewrite found its place. */
  const writes = new Map();
  const edit = (file, fn) => writes.set(file, fn(writes.get(file) ?? readFileSync(at(file), 'utf8')));
  const oldImage = new RegExp(`(ghcr\\.io/suwayomi/suwayomi-server:)${escape(old)}(?![\\w.-])`, 'g');
  for (const f of pins.images) edit(f, (t) => must(t, oldImage, `$1${tag}`, f));

  edit(pins.pack, (t) => {
    const start = t.indexOf('export const SUWAYOMI = {');
    const stop = t.indexOf('\n};', start);
    if (start < 0 || stop < 0) throw new Error(`bump: ${pins.pack}: no SUWAYOMI block`);
    let block = t.slice(start, stop);
    block = must(block, new RegExp(`(\\n\\s+version: ')${escape(old)}(')`), `$1${tag}$2`, `${pins.pack} version`);
    for (const suffix of PACK_ASSETS) {
      const name = `Suwayomi-Server-${tag}-${suffix}`;
      const sha = checksums.get(name);
      if (!sha) throw new Error(`bump: the release's Checksums.sha256 has no ${name}`);
      block = must(block, new RegExp(`name: 'Suwayomi-Server-${escape(old)}-${escape(suffix)}', sha256: '[0-9a-f]{64}'`),
        `name: '${name}', sha256: '${sha}'`, `${pins.pack} ${suffix}`);
    }
    return t.slice(0, start) + block + t.slice(stop);
  });

  edit(pins.pin, (t) => {
    let s = must(t, new RegExp(`("version": ")${escape(old)}(")`), `$1${tag}$2`, `${pins.pin} version`);
    s = must(s, /("tag": ")engine-v[^"]+(")/, `$1engine-${tag}$2`, `${pins.pin} tag`);
    s = must(s, /("baseUrl": "[^"]*\/releases\/download\/)engine-v[^"]+(")/, `$1engine-${tag}$2`, `${pins.pin} baseUrl`);
    s = s.replace(/("sha256": )"[0-9a-f]{64}"/g, '$1null').replace(/("bytes": )\d+/g, '$1null');
    JSON.parse(s);
    return s;
  });

  edit(pins.workflow, (t) => must(t, new RegExp(`(^\\s+SUWAYOMI: )${escape(old)}$`, 'm'), `$1${tag}`, pins.workflow));
  edit(pins.tested, (t) => must(t, new RegExp(`(export const TESTED_ENGINE = ')${escape(old)}(')`), `$1${tag}$2`, pins.tested));
  edit(pins.fake, (t) => must(t, new RegExp(`(new URL\\('\\./suwayomi-)${escape(old)}(-schema\\.json')`), `$1${tag}$2`, `${pins.fake} SCHEMA_FILE`));
  writes.set(`${pins.schemas}/suwayomi-${tag}-schema.json`, schemaText);

  const dtoOld = `suwayomi-${old}-FlareSolverDtos.kt`;
  const dtoNew = `suwayomi-${tag}-FlareSolverDtos.kt`;
  writes.set(`${pins.solverDtos.dir}/${dtoNew}`, [
    `// Verbatim: Suwayomi-Server ${tag} CloudflareInterceptor.kt lines ${dtos.first}-${dtos.last} (the request/response DTOs)`,
    `// https://raw.githubusercontent.com/Suwayomi/Suwayomi-Server/${tag}/${interceptorPath}`,
    '// Parsed with Json { ignoreUnknownKeys = true; explicitNulls = false } (AppModule.kt at the same tag; check it did not change).',
    dtos.body,
    '',
  ].join('\n'));
  edit(pins.solverDtos.test, (t) => must(t, new RegExp(escape(dtoOld), 'g'), dtoNew, pins.solverDtos.test));

  for (const [file, text] of writes) writeFileSync(at(file), text);
  const stale = at(`${pins.solverDtos.dir}/${dtoOld}`);
  if (existsSync(stale)) unlinkSync(stale);
  return { old, tag, files: [...writes.keys()], removed: [`${pins.solverDtos.dir}/${dtoOld}`] };
}

export const STEPS_LEFT = (old, tag) => [
  `Read the schema diff: node scripts/engine/schemaDiff.mjs bff/test/fixtures/suwayomi-${old}-schema.json bff/test/fixtures/suwayomi-${tag}-schema.json`,
  'Run the conform battery against a throwaway engine of the new image, and record the result in its header (bff/test/fixtures/conformFakeSuwayomi.mjs).',
  'Read the new FlareSolverr DTOs against the solver contract (desktop/test/solver.contract.test.ts), and AppModule.kt\'s Json settings at the tag.',
  'Check the image still maps every deploy variable: node scripts/engine/envCheck.mjs --image ghcr.io/suwayomi/suwayomi-server:' + tag,
  'Decide whether OLDEST_ENGINE moves (bff/src/lib/sources/suwayomi/enginePin.ts): only if Uchiyomi now needs something the old engine lacks.',
  'Open a PR from this branch (a branch the canary pushed runs no CI until a person opens the PR), and let the 12 checks run.',
  'A live soak on one server first: back up the engine\'s volume, change only its image line, watch Health → Extension engine for 24-48 h.',
  `After the merge: push the tag engine-${tag} (engine-pack.yml builds the desktop packs as a prerelease), then run node desktop/scripts/release/pin-engine.mjs and commit the hashes before the app release.`,
  'CHANGELOG: an upgrade note (the engine migrates its database forward; back up its volume first), and docs/extensions.md "Updating the engine".',
];

async function main(argv) {
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const tag = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
  if (!tag) { console.error('usage: bump.mjs <tag> --schema <file> [--checksums <file>] [--interceptor <file>] [--repo <dir>]'); return 2; }
  const r = await bump(tag, { repo: opt('--repo'), schema: opt('--schema'), checksums: opt('--checksums'), interceptor: opt('--interceptor') });
  console.log(`Moved the engine pin ${r.old} -> ${r.tag} in:\n${r.files.map((f) => `  ${f}`).join('\n')}\nRemoved:\n${r.removed.map((f) => `  ${f}`).join('\n')}`);
  console.log(`\nLeft to do by hand:\n${STEPS_LEFT(r.old, r.tag).map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e?.message ?? e); process.exit(1); });
}
