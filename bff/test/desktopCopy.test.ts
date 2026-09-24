// The desktop app never tells someone on a laptop to edit a compose file (switch ON).
//
// Every message the server writes for a Docker operator -- mount the volume, set PUID, chown, `shm_size`,
// check the container, raise SUWAYOMI_MAX_SOURCES -- goes through `forDesktop(server, desktop)`, so the server
// strings stay byte-identical and the desktop gets a sentence about Uchiyomi on this computer instead. The
// server arms are pinned word for word by 'the server arm of every forDesktop call…' below (SERVER_ARMS).
// ⚠️ Not by fsGuard.test.ts, sourceDiagnosis.test.ts or aioParity.test.ts: those match keywords only (PUID,
// 'owned by uid', FLARESOLVERR_ENABLED), so a reworded server sentence passes them.
//
// Two halves. The static one reads EVERY `forDesktop(` call under bff/src and checks both arguments, so a new
// message written later is covered the day it is added. The runtime one calls the real functions with the
// switch on, which is what catches a desktop arm that is a constant defined somewhere else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, chmodSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'uchi-deskcopy-'));
const SOLVER_TOKEN = 'solver-token-that-must-not-show';
process.env.UCHIYOMI_DESKTOP = '1';
process.env.UCHIYOMI_DATA_DIR = DATA;
process.env.PORT = '43126';
process.env.DL_ROOT = join(DATA, 'Uchiyomi Library');
process.env.UCHIYOMI_DESKTOP_SECRET = 'c3'.repeat(32);
process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET = 'test-secret-at-least-16-chars';
// Nothing listens on port 1: the helper is "not answering", which is the message under test.
process.env.FLARESOLVERR_URL = `http://127.0.0.1:1/${SOLVER_TOKEN}`;
delete process.env.CONFIG_DIR;
delete process.env.LIBRARY_ROOT;

/** What a PC user has no use for: Docker, its users and permissions, and env vars they cannot set. */
const DOCKERISH = /PUID|PGID|chown|docker|compose|(?<!process)\.env\b|container|\buid\b|shm_size|FLARESOLVERR_|SUWAYOMI_|10002/i;

const SRC = join(__dirname, '..', 'src');
function sources(dir = SRC): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...sources(abs));
    else if (name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

/**
 * The top-level arguments of the call whose `(` is at `open`, as source text. Walks quotes, template literals
 * (with `${}` inside), comments and brackets, which is all the forDesktop calls in this tree use.
 */
function callArgs(src: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  const skipString = (i: number): number => {
    const q = src[i];
    for (i++; i < src.length; i++) {
      if (src[i] === '\\') { i++; continue; }
      if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
        let d = 1;
        for (i += 2; i < src.length && d; i++) {
          if (src[i] === "'" || src[i] === '"' || src[i] === '`') i = skipString(i);
          else if (src[i] === '{') d++;
          else if (src[i] === '}') d--;
        }
        i--;
        continue;
      }
      if (src[i] === q) return i;
    }
    return i;
  };
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') { i = skipString(i); continue; }
    // Comments inside a call (an apostrophe in one would otherwise open a string).
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) { args.push(src.slice(start, i)); return args; }
    } else if (c === ',' && depth === 1) { args.push(src.slice(start, i)); start = i + 1; }
  }
  throw new Error('unbalanced call');
}

test('every forDesktop call in bff/src gives the desktop a sentence with no Docker in it', () => {
  // Reintroduce by writing a desktop arm that says "check the container": this names the file and the text.
  let calls = 0;
  const offenders: string[] = [];
  for (const file of sources()) {
    const src = readFileSync(file, 'utf8');
    if (file.endsWith(join('lib', 'desktop.ts'))) continue; // the definition, not a call
    for (const m of src.matchAll(/\bforDesktop(?:<[^>]*>)?\(/g)) {
      const args = callArgs(src, m.index! + m[0].length - 1);
      calls++;
      assert.equal(args.length >= 2, true, `${relative(SRC, file)}: a forDesktop call without a desktop argument`);
      const desktopArm = args[1].trim().replace(/,$/, '');
      if (DOCKERISH.test(desktopArm)) offenders.push(`${relative(SRC, file)}: ${desktopArm.slice(0, 160)}`);
    }
  }
  assert.ok(calls >= 15, `found only ${calls} forDesktop calls -- the scan no longer reads this tree`);
  assert.deepEqual(offenders, []);
});

/**
 * The server half of every `forDesktop(server, desktop)` call, frozen: `file: first argument`, whole-line comments
 * dropped and whitespace collapsed, files in path order and calls in source order. Each prints exactly what
 * v0.43.0 printed in that spot before the desktop work wrapped it (every entry was checked against that tree's
 * source). A server message you MEAN to change: change its entry here in the same commit, so review sees it.
 */
const SERVER_ARMS = [
  "lib/backup.ts: 'pg_dump not found in the image — the backup task needs the postgresql client installed'",
  "lib/backup.ts: `cannot write to ${env.BACKUP_DIR} — the backup directory must be writable by uid 10002. ` + `If it is a host folder, run: docker run --rm -v <that folder>:/b alpine chown 10002:10002 /b`",
  "lib/fsGuard.ts: `Check that the volume is mounted. In docker-compose.yml the library is mounted at ${dir}.`",
  "lib/fsGuard.ts: { ok: false, reason: `${dir} is not writable: it is owned by uid ${ownerUid} and this container runs as uid ${me}`, fix: ownerUid >= 0 ? `Set PUID=${ownerUid} (and PGID to its group) in your .env and restart. ` + `Alternatively, and only if you are sure nothing else uses these files, give them to the app: ` + `chown -R ${me}:${me} <your library path>` : `Set PUID and PGID to the owner of your library, then restart.`, }",
  "lib/health.ts: 'over the source limit (SUWAYOMI_MAX_SOURCES)'",
  "lib/health.ts: `Not answering at ${url}`",
  "lib/health.ts: 'Sources on Cloudflare-protected sites cannot work without it. Check the container is running ' + 'and that FLARESOLVERR_URL points at it.'",
  "lib/health.ts: url",
  "lib/health.ts: 'It responds, but it has been failing mid-request. Chrome needs far more than Docker\\'s default ' + '64 MB of shared memory (set shm_size: 1gb), and the solver leaks memory, so it wants a restart.'",
  "lib/health.ts: 'Every registered source is searched at once, which is why there is a limit. Hiding the languages you do not read ' + 'is the cheap way under it; SUWAYOMI_MAX_SOURCES raises it.'",
  "lib/health.ts: { title: 'SUWAYOMI_MAX_SOURCES', detail: `${skipped} enabled sources not registered; the limit is ${cap}. Hide languages you do not read, or raise the limit.` }",
  "lib/sourceDiagnosis.ts: \"The Cloudflare solver's browser crashed. Chrome in Docker needs far more than the default 64 MB of shared memory: set shm_size: 1gb on the flaresolverr service and recreate it.\"",
  "lib/sourceDiagnosis.ts: 'The Cloudflare solver is not answering. Check the container is up and FLARESOLVERR_URL is right. It also leaks memory, so it wants a periodic restart.'",
  "lib/sourceDiagnosis.ts: \"The extension engine's own Cloudflare bypass is switched off. On the Suwayomi engine's container (uchiyomi-suwayomi in the shipped compose files) set FLARESOLVERR_ENABLED=true and FLARESOLVERR_URL to the same solver address Uchiyomi uses (http://uchiyomi-flaresolverr:8191 in the shipped files), then recreate it. The v0.37.0 compose files already set both, so an upgrade that recreates the engine is the fix there.\"",
  "lib/sourceDiagnosis.ts: 'This is the Suwayomi extension server, not the site. Check that container.'",
  "lib/sourceDiagnosis.ts: 'The site answers fine from this server, so the Cloudflare solver is the broken part. Check that container.'",
  "lib/sources/customSites.ts: '/config/sites.json'",
];

test('the server arm of every forDesktop call is still the words a Docker admin reads', () => {
  // Reintroduce by editing any server arm (fsGuard's 'Check that the volume is mounted.' -> 'Check the volume is
  // mounted.'): the diff names the file and both texts. Nothing else notices -- the scan above reads only the
  // desktop argument, and the switch-off tests elsewhere match keywords.
  const found: string[] = [];
  for (const file of sources().sort()) {
    if (file.endsWith(join('lib', 'desktop.ts'))) continue; // the definition, not a call
    const src = readFileSync(file, 'utf8');
    const rel = relative(SRC, file).split(sep).join('/');
    for (const m of src.matchAll(/\bforDesktop(?:<[^>]*>)?\(/g)) {
      const server = callArgs(src, m.index! + m[0].length - 1)[0];
      found.push(`${rel}: ${server.replace(/^[ \t]*\/\/.*$/gm, '').replace(/\s+/g, ' ').trim()}`);
    }
  }
  assert.deepEqual(found, SERVER_ARMS);
});

test('the parser really splits arguments (so the check above means something)', () => {
  const src = "forDesktop(`a ${f('x, y')} b`, // it's a comment, (with a paren\n 'c, d')";
  assert.deepEqual(callArgs(src, src.indexOf('(')).map((s) => s.trim()), ["`a ${f('x, y')} b`", "// it's a comment, (with a paren\n 'c, d'"]);
});

test('a library folder that is missing or not writable: the desktop fix names the account, not PUID', async () => {
  // Reintroduce by dropping either forDesktop in fsGuard.ts: the missing-folder fix says docker-compose.yml,
  // the unwritable one says PUID and chown.
  const { writePreflight } = await import('../src/lib/fsGuard');
  const missing = await writePreflight(join(DATA, 'not-there'));
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.doesNotMatch(`${missing.reason} ${missing.fix}`, DOCKERISH);
    assert.match(missing.fix, /your account can write to it/);
  }
  if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root writes anywhere
  const locked = join(DATA, 'locked');
  mkdirSync(locked);
  chmodSync(locked, 0o555);
  try {
    const r = await writePreflight(locked);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, `Uchiyomi can't write to ${locked}.`);
      assert.doesNotMatch(`${r.reason} ${r.fix}`, DOCKERISH);
      assert.match(r.fix, /Windows: Properties, Security; macOS: Get Info, Sharing & Permissions/);
    }
  } finally {
    chmodSync(locked, 0o755);
  }
});

test('source diagnoses: every solver and engine fix says to restart Uchiyomi', async () => {
  // Reintroduce by dropping any one forDesktop in sourceDiagnosis.ts: that fix names shm_size, a container or
  // FLARESOLVERR_URL again.
  const { diagnose } = await import('../src/lib/sourceDiagnosis');
  const facts = (lastError: string) => ({
    status: 'down' as const, lastError, consecutive: 1, lastOkAt: null, emptyStreak: 0, blockedUntil: null, disabled: false,
  });
  const cases: Array<[string, Parameters<typeof diagnose>[1]?]> = [
    ['flaresolverr: Error: Error solving the challenge. Message: Service /app/chromedriver unexpectedly exited. Status code was: 1\n'],
    ["flaresolverr: Error solving the challenge. HTTPConnectionPool(host='localhost', port=58885): Max retries exceeded with url: /session"],
    ['suwayomi: java.io.IOException: Cloudflare bypass currently disabled'],
    ['suwayomi 500'],
    ['flaresolverr: something odd', { httpStatus: 200, adapterOk: false }],
  ];
  for (const [err, probe] of cases) {
    const d = diagnose(facts(err), probe, 'https://site.example');
    assert.doesNotMatch(d.fix, DOCKERISH, `${d.code}: ${d.fix}`);
    assert.match(d.fix, /Quit and reopen Uchiyomi/, `${d.code}: ${d.fix}`);
  }
});

test("Health's Cloudflare solver check: no Docker, and the helper's token is never printed", async () => {
  // Reintroduce by dropping the forDesktop around the note: "Check the container is running". Or by printing
  // `url`: the helper's access token lands on the Health page (and in every screenshot of it).
  const { solverHealth } = await import('../src/lib/health');
  const h = await solverHealth();
  const text = JSON.stringify(h);
  assert.equal(h.status === 'warn' || h.status === 'problem', true, 'nothing listens on port 1, so it is not answering');
  assert.doesNotMatch(text, DOCKERISH);
  assert.ok(!text.includes(SOLVER_TOKEN), 'the solver token is shown on the Health page');
  assert.match(h.note ?? '', /quit and reopen Uchiyomi/);
});

test("Health's solver row names the desktop helper's version as it is, and FlareSolverr's as before", async () => {
  // The helper answers `uchiyomi-desktop-0.44.0` on purpose (not semver-shaped), and the row read
  // "Ready (vuchiyomi-desktop-0.44.0)". Reintroduce by putting the bare `v${version}` back: the first line fails.
  const { solverVersionLabel } = await import('../src/lib/health');
  assert.equal(solverVersionLabel('uchiyomi-desktop-0.44.0'), ' (uchiyomi-desktop-0.44.0)');
  // The server build's text, unchanged: FlareSolverr's versions start with a digit.
  assert.equal(solverVersionLabel('3.4.6'), ' (v3.4.6)');
  assert.equal(solverVersionLabel(undefined), '');
  assert.equal(solverVersionLabel(''), '');
});
