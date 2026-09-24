// Every trap the Phase 0 spike paid a CI cycle for stays closed. Static on purpose: each of these only bites on
// a real Windows or macOS machine (or only after an update), which no unit test here can be.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8');

test('packaging: extraResources rooted at resources/ (electron-builder drops a root node_modules), fuses as decided', () => {
  // Reintroduce by rooting an entry at resources/bff: the "from: resources" line is gone.
  const y = read('electron-builder.yml');
  assert.match(y, /extraResources:\n(?:\s*#.*\n)*\s*- from: resources\n\s*to: \.\n\s*filter:\n\s*- bff\/\*\*\/\*\n\s*- web\/\*\*\/\*\n\s*- pg\/\*\*\/\*/);
  assert.doesNotMatch(y, /from: resources\/bff/);
  assert.match(y, /runAsNode: false/);
  // OFF until the builds are signed: an ad-hoc signature changes every build and the Keychain then blocks.
  assert.match(y, /enableCookieEncryption: false/);
  assert.match(y, /oneClick: true\n\s*perMachine: false/);
  assert.match(y, /identity: "-"/);
  assert.match(y, /- out\/src\/\*\*\/\*\.js/, 'the compiled solver ships');
  assert.match(y, /provider: github\n\s*owner: AngeloSha\n\s*repo: uchiyomi/);
});

test('main process: mock keychain on macOS, cookie flush before app.exit, ordered stop BEFORE the installer', () => {
  // Reintroduce by deleting the use-mock-keychain line (or installing the update before the stop).
  const m = read('src/main.js');
  assert.match(m, /if \(process\.platform === 'darwin'\) app\.commandLine\.appendSwitch\('use-mock-keychain'\);/);
  const q = m.slice(m.indexOf('async function quit('));
  const flush = q.indexOf('cookies.flushStore()');
  const stop = q.indexOf('sup?.stop(reason)');
  const install = q.indexOf('installDownloaded(');
  const exit = q.indexOf('app.exit(0)');
  assert.ok(flush > 0 && stop > flush && install > stop && exit > install, 'quit(): flush cookies -> stop children -> install update -> exit');
  // The login item starts in the tray, and "Start when I log in" is off unless the user ticks it.
  assert.match(m, /setLoginItemSettings\(\{ openAtLogin: mi\.checked, args: \['--hidden'\] \}\)/);
  assert.doesNotMatch(m, /openAtLogin: true/);
});

test('the bff shim turns contract 4\'s {type:"shutdown"} into its SIGTERM path', () => {
  // Reintroduce by posting the bare string 'shutdown' from the supervisor: contract 4 is the object.
  const s = read('src/bff-entry.cjs');
  assert.match(s, /m && m\.type === 'shutdown'/);
  assert.match(s, /process\.emit\('SIGTERM'\)/);
  assert.match(read('src/supervisor.js'), /child\.postMessage\(\{ type: 'shutdown' \}\)/);
});

test('Windows tools by absolute System32 path (Git for Windows puts a Unix whoami/tar first on PATH)', () => {
  // Reintroduce by running `whoami` by name: Git for Windows' Unix whoami answers and the ACL step is skipped.
  const p = read('src/postgres.js');
  for (const tool of ['whoami', 'icacls', 'tasklist']) assert.match(p, new RegExp(`sys32\\('${tool}'\\)`), tool);
  assert.doesNotMatch(p, /run\('(whoami|icacls|tasklist)'/);
});

test('children never flash a console on Windows: hidden, and every stdio handle piped', () => {
  // Reintroduce by inheriting the engine's stdin: CREATE_NO_WINDOW is dropped and a console flashes.
  // libuv sets CREATE_NO_WINDOW only when no stdio handle is inherited (spike S7-9).
  const e = read('src/engine.js');
  assert.match(e, /spawn\(l\.cmd, l\.args, \{ cwd: l\.cwd, env: l\.env, windowsHide: true, stdio: \['pipe', 'pipe', 'pipe'\] \}\)/);
  const p = read('src/postgres.js');
  assert.match(p, /windowsHide: true, stdio: \['ignore', 'pipe', 'pipe'\]/);
});

test('the NSIS installer asks a running Uchiyomi for its ordered shutdown before its own app check', () => {
  // Reintroduce by deleting the --quit-for-update line from build/installer.nsh.
  const n = read('build/installer.nsh');
  assert.match(n, /!macro customCheckAppRunning[\s\S]*--quit-for-update[\s\S]*!insertmacro _CHECK_APP_RUNNING[\s\S]*!macroend/);
  // The stock macro's own helpers, which the templates skip once customCheckAppRunning exists.
  assert.match(n, /!include "getProcessInfo\.nsh"\nVar pid/);
});
