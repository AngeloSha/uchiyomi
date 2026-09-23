#!/usr/bin/env node
// Stage the web app and the bff into desktop/resources, exactly as Dockerfile.aio lays them out:
//
//   web/out                                          -> resources/web        (Dockerfile.aio: COPY --from=web /w/out ./web)
//   bff/dist + package.json + package-lock.json
//     + openapi.yaml + production node_modules       -> resources/bff        (Dockerfile.aio:64-71)
//
// The layout is load-bearing, not tidy: bff/src/lib/appVersion.ts reads ../../package.json relative to
// dist/lib, and lib/apiDocs.ts finds openapi.yaml beside dist/. `npm ci --omit=dev` runs HERE, on the target
// OS and CPU, so sharp and @node-rs/argon2 install their prebuilt binaries for this platform.
//
//   node scripts/stage.mjs                 build web + bff from the repo, then stage
//   node scripts/stage.mjs --prebuilt DIR  take DIR/web-out and DIR/bff-dist (a CI artifact built once)
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(DESKTOP, '..');
const RES = join(DESKTOP, 'resources');
const args = process.argv.slice(2);
const prebuilt = args.includes('--prebuilt') ? resolve(args[args.indexOf('--prebuilt') + 1]) : null;
const WIN = process.platform === 'win32';

function sh(cmd, cmdArgs, cwd) {
  const t0 = Date.now();
  console.log(`$ (${cwd.replace(REPO, '.')}) ${cmd} ${cmdArgs.join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit', shell: WIN });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(' ')} failed (${r.status})`);
  console.log(`  ... ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

function du(p) {
  let n = 0;
  const st = statSync(p);
  if (!st.isDirectory()) return st.size;
  for (const e of readdirSync(p)) n += du(join(p, e));
  return n;
}
const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;

let webOut;
let bffDist;
if (prebuilt) {
  webOut = join(prebuilt, 'web-out');
  bffDist = join(prebuilt, 'bff-dist');
} else {
  sh('npm', ['ci', '--no-audit', '--no-fund'], join(REPO, 'web'));
  sh('npm', ['run', 'build'], join(REPO, 'web'));
  sh('npm', ['ci', '--no-audit', '--no-fund'], join(REPO, 'bff'));
  sh('npm', ['run', 'build'], join(REPO, 'bff'));
  webOut = join(REPO, 'web', 'out');
  bffDist = join(REPO, 'bff', 'dist');
}
for (const p of [join(webOut, 'index.html'), join(bffDist, 'server.js')]) {
  if (!existsSync(p)) throw new Error(`missing build output: ${p}`);
}

rmSync(join(RES, 'web'), { recursive: true, force: true });
rmSync(join(RES, 'bff'), { recursive: true, force: true });
mkdirSync(join(RES, 'bff'), { recursive: true });

cpSync(webOut, join(RES, 'web'), { recursive: true });
cpSync(bffDist, join(RES, 'bff', 'dist'), { recursive: true });
for (const f of ['package.json', 'package-lock.json', 'openapi.yaml']) copyFileSync(join(REPO, 'bff', f), join(RES, 'bff', f));
sh('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], join(RES, 'bff'));

// The icon electron-builder turns into .ico/.icns, from the same file the PWA installs with.
mkdirSync(join(DESKTOP, 'build'), { recursive: true });
copyFileSync(join(REPO, 'web', 'public', 'icons', 'icon-512.png'), join(DESKTOP, 'build', 'icon.png'));

const nm = join(RES, 'bff', 'node_modules');
const top = readdirSync(nm).flatMap((d) => (d.startsWith('@') ? readdirSync(join(nm, d)).map((x) => `${d}/${x}`) : [d]))
  .map((d) => [d, du(join(nm, d))]).sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log(`staged: web ${mb(du(join(RES, 'web')))}, bff ${mb(du(join(RES, 'bff')))} (node_modules ${mb(du(nm))})`);
console.log(`largest bff deps: ${top.map(([d, n]) => `${d} ${mb(n)}`).join(', ')}`);
