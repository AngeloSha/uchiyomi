#!/usr/bin/env node
// Compile EngineShim.java with `javac --release 21` into uchiyomi-shim.jar (Phase 2: desktop/scripts).
// Needs a JDK 21+ on PATH or in JAVA_HOME. Usage: node build-shim.mjs [--out <dir>]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const exe = (n) => (process.platform === 'win32' ? `${n}.exe` : n);

export function jdkTool(name) {
  const home = process.env.JAVA_HOME;
  if (home) {
    const p = path.join(home, 'bin', exe(name));
    if (fs.existsSync(p)) return p;
  }
  return exe(name);
}

export function buildShim(outDir = path.join(here, 'build')) {
  const classes = path.join(outDir, 'shim-classes');
  fs.rmSync(classes, { recursive: true, force: true });
  fs.mkdirSync(classes, { recursive: true });
  execFileSync(jdkTool('javac'), ['--release', '21', '-encoding', 'UTF-8', '-Xlint:all', '-Werror',
    '-d', classes, path.join(here, 'EngineShim.java'), path.join(here, 'IsolatedPreferences.java')], { stdio: 'inherit' });
  const jar = path.join(outDir, 'uchiyomi-shim.jar');
  fs.rmSync(jar, { force: true });
  // --date makes the jar byte-for-byte reproducible.
  execFileSync(jdkTool('jar'), ['--create', '--file', jar, '--date=2026-01-01T00:00:00Z', '-C', classes, '.'], { stdio: 'inherit' });
  fs.rmSync(classes, { recursive: true, force: true });
  return jar;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out');
  const jar = buildShim(i > 0 ? path.resolve(process.argv[i + 1]) : undefined);
  console.log(`${jar} ${fs.statSync(jar).size} bytes`);
}
