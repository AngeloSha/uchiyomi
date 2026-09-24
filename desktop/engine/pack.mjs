#!/usr/bin/env node
// Build the slim extension-engine pack for one platform. The app downloads it on first use (Admin ->
// Extensions), verifies it against the SHA-256 pinned in src/engine-pin.json, and runs it with src/engine.js.
//
//   node engine/pack.mjs --platform win-x64|mac-arm64|mac-x64|linux-x64 [--cache <dir>] [--out <dir>]
//
// Needs a JDK 21+ (javac + jar) for the shim: JAVA_HOME or PATH.
//
// Downloads the pinned Suwayomi-Server release asset (verified against the SHA-256 pinned below, which are
// the values in that release's Checksums.sha256), keeps ONLY `jre/` and `bin/Suwayomi-Server.jar` (drops
// Suwayomi's own Electron launcher, Suwayomi-Launcher.jar and the start scripts), adds uchiyomi-shim.jar and
// an engine.json, and writes engine-pack-<platform>.zip + .sha256 + a .json with the measured sizes.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
// The same archive code the app unpacks the pack with (CommonJS; imported as its module.exports).
import archive from '../src/archive.js';
import { buildShim } from './build-shim.mjs';

const { extractTarGz, extractZip, writeZip, sha256File, dirSize, readZipEntry } = archive;

const here = path.dirname(fileURLToPath(import.meta.url));

export const SUWAYOMI = {
  version: 'v2.3.2243',
  mainClass: 'suwayomi.tachidesk.MainKt', // read from the jar manifest at build time and asserted below
  assets: {
    'win-x64': { name: 'Suwayomi-Server-v2.3.2243-windows-x64.zip', sha256: '895843f48d5735e01bdc43d79ab66e600d6f507076a9b792ffa418a9bbcc32c2' },
    'mac-arm64': { name: 'Suwayomi-Server-v2.3.2243-macOS-arm64.tar.gz', sha256: '884df50945c9c052ec55bea8bb6fd232f9258a5a0bb8a95d2e07850337b2481b' },
    'mac-x64': { name: 'Suwayomi-Server-v2.3.2243-macOS-x64.tar.gz', sha256: '3021ce25ed0366bd91899621ff5e4f0ac0e11be292daa37a9c3dfac9bd7c9591' },
    'linux-x64': { name: 'Suwayomi-Server-v2.3.2243-linux-x64.tar.gz', sha256: '7ed20b7890a6720c4d5dd51fe9c3247f537ffcab01a1cba5c2a75626743236c3' },
  },
};

export function hostPlatform() {
  if (process.platform === 'win32') return 'win-x64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  return 'linux-x64';
}

async function download(url, dest) {
  const t0 = Date.now();
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`download ${url}: HTTP ${r.status}`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(tmp));
  await fsp.rename(tmp, dest);
  return Date.now() - t0;
}

/**
 * `top/jre/x` -> `jre/x`, `top/bin/Suwayomi-Server.jar` -> `bin/Suwayomi-Server.jar`, everything else dropped.
 *
 * ⚠️ The jar must NOT sit directly next to `jre/`. Suwayomi builds its GraphQL schema with ClassGraph, and
 * ClassGraph treats the parent of java.home (an old JDK 8 `jdk/jre` layout) as part of the JRE and skips every
 * classpath jar under it: `<rt>/Suwayomi-Server.jar` beside `<rt>/jre` is logged as "Ignoring duplicate
 * classpath element", the scan finds 0 classes in suwayomi.tachidesk.graphql, and the server dies at boot with
 * InvalidPackagesException. Suwayomi's own layout (`bin/`) scans 748 classes. Reintroduce by mapping the jar
 * to the pack root: every boot fails.
 */
function keep(name) {
  const parts = name.replace(/^\.\//, '').split('/');
  if (parts.length < 2) return null;
  const rest = parts.slice(1);
  if (rest[0] === 'jre') return rest.join('/');
  if (rest.length === 2 && rest[0] === 'bin' && rest[1] === 'Suwayomi-Server.jar') return 'bin/Suwayomi-Server.jar';
  return null;
}

export async function pack({ platform = hostPlatform(), cacheDir, outDir } = {}) {
  const asset = SUWAYOMI.assets[platform];
  if (!asset) throw new Error(`unknown platform ${platform}`);
  cacheDir = path.resolve(cacheDir || path.join(here, '.cache'));
  outDir = path.resolve(outDir || path.join(here, 'build'));
  await fsp.mkdir(cacheDir, { recursive: true });
  await fsp.mkdir(outDir, { recursive: true });

  const archive = path.join(cacheDir, asset.name);
  let downloadMs = null, cached = true;
  if (!fs.existsSync(archive) || (await sha256File(archive)) !== asset.sha256) {
    cached = false;
    const url = `https://github.com/Suwayomi/Suwayomi-Server/releases/download/${SUWAYOMI.version}/${asset.name}`;
    console.log(`downloading ${url}`);
    downloadMs = await download(url, archive);
  }
  const got = await sha256File(archive);
  if (got !== asset.sha256) throw new Error(`${asset.name}: sha256 ${got} != pinned ${asset.sha256}`);
  const downloadBytes = (await fsp.stat(archive)).size;

  const stage = path.join(outDir, `stage-${platform}`);
  await fsp.rm(stage, { recursive: true, force: true });
  await fsp.mkdir(stage, { recursive: true });
  const t0 = Date.now();
  if (asset.name.endsWith('.zip')) {
    await extractZip(archive, stage, (n) => (n.endsWith('/') ? null : keep(n)));
  } else {
    const symlinks = [];
    await extractTarGz(archive, ({ name, type, linkname }) => {
      const rel = keep(name);
      if (!rel) return null;
      if (type === 'symlink') { symlinks.push(`${rel} -> ${linkname}`); return null; }
      return type === 'file' || type === 'dir' ? path.join(stage, ...rel.split('/')) : null;
    });
    if (symlinks.length) throw new Error(`symlinks inside the kept tree (writeZip would drop them): ${symlinks.join(', ')}`);
  }
  const extractMs = Date.now() - t0;

  const shim = buildShim(path.join(outDir, 'shim'));
  await fsp.copyFile(shim, path.join(stage, 'bin', 'uchiyomi-shim.jar'));

  const jar = path.join(stage, 'bin', 'Suwayomi-Server.jar');
  const manifest = (await readZipEntry(jar, 'META-INF/MANIFEST.MF'))?.toString('utf8') || '';
  const mainClass = /^Main-Class:\s*(\S+)/m.exec(manifest)?.[1];
  const implVersion = /^Specification-Version:\s*(\S+)/m.exec(manifest)?.[1];
  if (mainClass !== SUWAYOMI.mainClass) throw new Error(`Main-Class is ${mainClass}, expected ${SUWAYOMI.mainClass}`);
  const release = await fsp.readFile(path.join(stage, 'jre', 'release'), 'utf8');
  const javaVersion = /JAVA_VERSION="([^"]+)"/.exec(release)?.[1];
  const javaExe = path.join(stage, 'jre', 'bin', platform === 'win-x64' ? 'java.exe' : 'java');
  if (!fs.existsSync(javaExe)) throw new Error(`no java launcher at ${javaExe}`);

  const engineJson = {
    engine: 'suwayomi-server', version: SUWAYOMI.version, specVersion: implVersion, mainClass, platform,
    javaVersion, java: platform === 'win-x64' ? 'jre/bin/java.exe' : 'jre/bin/java',
    classpath: ['bin/Suwayomi-Server.jar', 'bin/uchiyomi-shim.jar'], shimClass: 'dev.uchiyomi.EngineShim',
    source: { asset: asset.name, sha256: asset.sha256 },
  };
  await fsp.writeFile(path.join(stage, 'engine.json'), `${JSON.stringify(engineJson, null, 2)}\n`);
  const unpacked = await dirSize(stage);

  const zipFile = path.join(outDir, `engine-pack-${platform}.zip`);
  const t1 = Date.now();
  const z = await writeZip(stage, zipFile);
  const zipMs = Date.now() - t1;
  const sha = await sha256File(zipFile);
  await fsp.writeFile(`${zipFile}.sha256`, `${sha}  ${path.basename(zipFile)}\n`);
  const jreSize = await dirSize(path.join(stage, 'jre'));
  const summary = {
    platform, pack: zipFile, sha256: sha, mainClass, javaVersion,
    downloadBytes, downloadMs, downloadCached: cached,
    packBytes: z.bytes, packEntries: z.entries,
    unpackedBytes: unpacked.bytes, unpackedFiles: unpacked.files,
    jreBytes: jreSize.bytes, jarBytes: (await fsp.stat(jar)).size, shimBytes: (await fsp.stat(shim)).size,
    extractMs, zipMs,
  };
  await fsp.writeFile(path.join(outDir, `engine-pack-${platform}.json`), `${JSON.stringify(summary, null, 2)}\n`);
  await fsp.rm(stage, { recursive: true, force: true });
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const s = await pack({ platform: arg('--platform'), cacheDir: arg('--cache'), outDir: arg('--out') });
  const mb = (b) => `${(b / 1048576).toFixed(1)} MiB`;
  console.log(JSON.stringify(s, null, 2));
  console.log(`PACK ${s.platform}: download ${mb(s.downloadBytes)} -> pack ${mb(s.packBytes)} (zip) -> unpacked ${mb(s.unpackedBytes)} in ${s.unpackedFiles} files; jre ${mb(s.jreBytes)}, jar ${mb(s.jarBytes)}; Main-Class ${s.mainClass}; java ${s.javaVersion}; sha256 ${s.sha256}`);
}
