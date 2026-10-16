#!/usr/bin/env node
// envCheck.mjs: does an engine image still read every variable Uchiyomi's deploy files set on it?
//
//   node scripts/engine/envCheck.mjs --image ghcr.io/suwayomi/suwayomi-server:v2.4.2366   (reads its startup script)
//   node scripts/engine/envCheck.mjs --startup <startup_script.sh>                        (a script already on disk)
//   node scripts/engine/envCheck.mjs --docker-args     the `-e NAME=value` arguments deploy/docker-compose.yml gives it
//
// The engine's image turns environment variables into its server.conf in /home/suwayomi/startup_script.sh, one sed
// per variable. A variable an image stops mapping is silently ignored: AUTO_DOWNLOAD_CHAPTERS=false, which keeps the
// engine from writing into the library Uchiyomi owns, would simply stop applying (the image's Docker repository
// dropped that one after v2.4.2366). So the weekly canary (.github/workflows/engine-canary.yml) holds every new image
// to the list every deploy file sets (scripts/engine/pins.json deployEnv: the compose files, CasaOS and the Unraid
// template), and fails naming each one it no longer reads.
//
// JAVA_TOOL_OPTIONS is read by the JVM, MALLOC_ARENA_MAX by the C library and TZ by the system, never by the script.
// Exit 1 when one is missing, 2 for bad arguments. Reads YAML with bff's own `yaml` package (npm ci in bff first).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
/** Read by something other than the startup script. */
export const NOT_THE_SCRIPTS = new Set(['JAVA_TOOL_OPTIONS', 'MALLOC_ARENA_MAX', 'TZ']);
const ENGINE_IMAGE = /ghcr\.io\/suwayomi\/suwayomi-server:/;

/** The engine service of a compose file (the one running the engine image), or null. */
function engineService(doc) {
  for (const svc of Object.values(doc?.services ?? {})) if (ENGINE_IMAGE.test(String(svc?.image ?? ''))) return svc;
  return null;
}

/** `environment:` as a map, whichever form the file writes it in. */
function envOf(svc) {
  const e = svc?.environment ?? {};
  if (Array.isArray(e)) return Object.fromEntries(e.map((x) => { const i = String(x).indexOf('='); return i < 0 ? [x, ''] : [x.slice(0, i), x.slice(i + 1)]; }));
  return Object.fromEntries(Object.entries(e).map(([k, v]) => [k, v == null ? '' : String(v)]));
}

/** Every variable a deploy file sets on the engine, by file. */
export function deployVariables(root = ROOT) {
  const pins = JSON.parse(readFileSync(join(root, 'scripts', 'engine', 'pins.json'), 'utf8'));
  const { parse } = createRequire(join(root, 'bff', 'package.json'))('yaml');
  const out = new Map();
  for (const file of pins.deployEnv) {
    const text = readFileSync(join(root, file), 'utf8');
    let names = [];
    if (file.endsWith('.xml')) {
      names = [...text.matchAll(/<Config [^>]*Target="([A-Z][A-Z0-9_]*)"[^>]*Type="Variable"/g)].map((m) => m[1]);
    } else {
      const svc = engineService(parse(text));
      if (!svc) throw new Error(`${file} runs no engine (no service with the suwayomi-server image)`);
      names = Object.keys(envOf(svc));
    }
    if (!names.length) throw new Error(`${file}: no variables found on the engine`);
    out.set(file, names);
  }
  return out;
}

/** The names a startup script does not read: neither `$NAME` nor `${NAME…}` appears in it. */
export function unmapped(script, names) {
  return [...new Set(names)].filter((n) => !NOT_THE_SCRIPTS.has(n) && !new RegExp(`\\$\\{?${n}\\b`).test(script));
}

/** `${VAR:-default}` and `${VAR-default}` as their default; `${VAR}` as nothing. */
const withDefaults = (v) => String(v).replace(/\$\{[A-Z0-9_]+(?::?-([^}]*))?\}/g, (_, d) => d ?? '');

/** The `-e NAME=value` arguments the shipped compose file gives the engine, defaults filled in. */
export function dockerArgs(root = ROOT) {
  const { parse } = createRequire(join(root, 'bff', 'package.json'))('yaml');
  const svc = engineService(parse(readFileSync(join(root, 'deploy', 'docker-compose.yml'), 'utf8')));
  return Object.entries(envOf(svc)).map(([k, v]) => [k, withDefaults(v)]).filter(([, v]) => v !== '');
}

function main(argv) {
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const root = resolve(opt('--repo') ?? ROOT);
  if (argv.includes('--docker-args')) {
    // One argument per line, for `mapfile`/`$(…)`: values never carry a newline.
    for (const [k, v] of dockerArgs(root)) console.log(`-e\n${k}=${v}`);
    return 0;
  }
  let script;
  if (opt('--startup')) script = readFileSync(opt('--startup'), 'utf8');
  else if (opt('--image')) script = execFileSync('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'cat', opt('--image'), '/home/suwayomi/startup_script.sh'], { encoding: 'utf8' });
  else { console.error('usage: envCheck.mjs --image <image> | --startup <file> | --docker-args [--repo <dir>]'); return 2; }
  let missing = 0;
  for (const [file, names] of deployVariables(root)) {
    const gone = unmapped(script, names);
    missing += gone.length;
    console.log(`${gone.length ? 'MISSING' : 'ok     '} ${file}: ${gone.length ? gone.join(', ') : `${names.length} variables, all read`}`);
  }
  if (missing) console.log(`\nThe image no longer reads ${missing} variable(s) Uchiyomi's deploy files set: each is silently ignored on that engine.`);
  return missing ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exit(main(process.argv.slice(2)));
