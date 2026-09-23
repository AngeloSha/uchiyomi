// S1(a): the bff's own test suite, under plain Node and under Electron's Node (ELECTRON_RUN_AS_NODE=1), with the
// exact command bff/package.json's `npm test` runs -- only the binary differs:
//   node --import tsx --test --test-concurrency=1 "test/*.test.ts"
// Adds a TAP file reporter (for the counts and the failing names) and, optionally, --test-shard.
//
//   node s1-suite.mjs --runtime node|electron [--shard 1/3] [--files a.test.ts,b.test.ts] [--label x]
//
// Writes ci-out/suite-<label>.json. s1-compare.mjs puts the runtimes side by side.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT, REPO, devElectron, OS_TAG } from './lib.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const runtime = opt('runtime', 'node');
const shard = opt('shard', null);
const files = opt('files', null);
const label = opt('label', `${runtime}${shard ? `-${shard.replace('/', 'of')}` : ''}`);
const tap = join(OUT, `suite-${label}.tap`);
const bin = runtime === 'electron' ? devElectron() : process.execPath;
const env = { ...process.env, ...(runtime === 'electron' ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };

const args = ['--import', 'tsx', '--test', '--test-concurrency=1'];
if (shard) args.push(`--test-shard=${shard}`);
args.push('--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=tap', `--test-reporter-destination=${tap}`);
args.push(...(files ? files.split(',').map((f) => `test/${f.trim()}`) : ['test/*.test.ts']));

console.log(`$ ${runtime === 'electron' ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}${bin} ${args.join(' ')}`);
const t0 = Date.now();
let glib = 0;
let sharpElectronWarn = 0;
const code = await new Promise((resolve) => {
  const child = spawn(bin, args, { cwd: join(REPO, 'bff'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const filter = (stream) => (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (/GLib-GObject-CRITICAL|G_IS_OBJECT/.test(line)) { glib++; continue; }
      if (/SharpElectronLinux/.test(line)) sharpElectronWarn++;
      if (line) stream.write(line + '\n');
    }
  };
  child.stdout.on('data', filter(process.stdout));
  child.stderr.on('data', filter(process.stderr));
  child.on('exit', (c) => resolve(c));
});

const text = readFileSync(tap, 'utf8');
const count = (k) => Number((new RegExp(`^# ${k} (\\d+)`, 'm').exec(text) || [])[1] ?? NaN);
// Every failing test with its nesting, e.g. "test/foo.test.ts > a suite > a case".
const failing = [];
const stack = [];
for (const line of text.split('\n')) {
  const m = /^(\s*)(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO).*)?$/.exec(line);
  const sub = /^(\s*)# Subtest: (.*)$/.exec(line);
  if (sub) { const d = sub[1].length / 4; stack.length = d; stack[d] = sub[2]; continue; }
  if (m && m[2] === 'not ok') { const d = m[1].length / 4; failing.push([...stack.slice(0, d), m[3]].join(' > ')); }
}
const summary = {
  label, runtime, shard, os: OS_TAG, exit: code, ms: Date.now() - t0,
  node: runtime === 'electron' ? null : process.versions.node,
  tests: count('tests'), suites: count('suites'), pass: count('pass'), fail: count('fail'), cancelled: count('cancelled'), skipped: count('skipped'), todo: count('todo'),
  glibCriticalLines: glib, sharpElectronLinuxWarnings: sharpElectronWarn,
  failing,
};
writeFileSync(join(OUT, `suite-${label}.json`), JSON.stringify(summary, null, 2));
console.log(`SUITE ${label}: tests ${summary.tests} pass ${summary.pass} fail ${summary.fail} cancelled ${summary.cancelled} skipped ${summary.skipped} (${Math.round(summary.ms / 1000)} s, exit ${code}, glib criticals ${glib})`);
for (const f of failing) console.log(`  not ok: ${f}`);
