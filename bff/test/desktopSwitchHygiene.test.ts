// The desktop switch cannot leak into the server build (static checks).
//
// Uchiyomi Desktop runs this same server with `UCHIYOMI_DESKTOP=1`, and the one rule that makes that safe is
// that the Docker build stays byte-for-byte what it was when the switch is off. Most of that is proven at
// runtime (desktopOff.test.ts, openapiCoverage.test.ts), but some of it is a property of the SOURCE: where the
// flag is read, what is imported first, which literals the server arm keeps. Those are pinned here, because on
// Linux several of them cannot be told apart at runtime (`path.join` IS `path.posix.join` there).
//
// Builders append their own sections below; the allowlist of files that may branch on the switch is the one
// list to extend when a new file needs a desktop difference.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

const BFF = join(__dirname, '..');
const SRC = join(BFF, 'src');
const REPO = join(BFF, '..');

/** Every .ts file under bff/src, as a path relative to it with `/` separators. */
function sources(dir = SRC): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...sources(abs));
    else if (name.endsWith('.ts')) out.push(relative(SRC, abs).split(sep).join('/'));
  }
  return out;
}
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

/**
 * The code without its comments, so a comment that EXPLAINS the switch is not mistaken for code that READS it.
 * Crude on purpose -- block comments that open after whitespace, and line comments that start a line --
 * because `//` and `/*` inside strings (a URL, `'image/*'`) must survive, and nothing in this tree puts a
 * trailing `// isDesktop(` after code.
 */
const code = (src: string) => src.replace(/(^|\s)\/\*[\s\S]*?\*\//g, '$1').replace(/^\s*\/\/.*$/gm, '');

/** The module specifiers a file imports, in order (static imports only, which is all this tree uses at the top). */
const importsOf = (src: string) => [...code(src).matchAll(/^\s*import\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1]);

/**
 * The files allowed to branch on `isDesktop()`. Every desktop difference in the server lives in one of these,
 * so a reviewer can find all of them, and a new one has to be added here on purpose.
 */
const IS_DESKTOP_ALLOWED = new Set([
  // Builder K: the switch, sign-in, networking, the hidden routes.
  'lib/desktop.ts',
  'lib/desktopGuard.ts',
  'lib/desktopUser.ts',
  'env.ts',
  'server.ts',
  'routes/auth.ts',
  'lib/auth.ts',
  // Builder L: paths, schedulers, backups, copy (append here).
  'lib/backup.ts', // the bundled pg_dump with the password in its env, and config.zip instead of tar
  'lib/libraryAdmin.ts', // realpath containment, case-only renames, on-disk spelling of typed paths
  'routes/sources.ts', // the add reuses the folder's stored/on-disk spelling on case-insensitive disks
]);

test('UCHIYOMI_DESKTOP is read in lib/desktop.ts and nowhere else', () => {
  // Reintroduce by reading `process.env.UCHIYOMI_DESKTOP` in any other file: a second reader is a second place
  // the flag can be parsed differently ("false" meaning on), and the off-mode proof in desktopOff.test.ts only
  // covers desktop.ts.
  const offenders = sources().filter((f) => f !== 'lib/desktop.ts' && /UCHIYOMI_DESKTOP/.test(code(read(f))));
  assert.deepEqual(offenders, [], 'files other than lib/desktop.ts that read UCHIYOMI_DESKTOP*');
});

test('lib/desktop.ts imports only fs, path and crypto -- never env or db', () => {
  // ⚠️ env.ts imports desktop.ts FIRST so its defaults exist before anything reads process.env; an import of
  // env or db from desktop.ts would be a cycle that loads them before the defaults exist.
  // Reintroduce by adding `import { env } from '../env'` to desktop.ts.
  const imports = importsOf(read('lib/desktop.ts')).map((s) => s.replace(/^node:/, ''));
  assert.ok(imports.length > 0, 'the import scan found nothing -- the regex no longer matches this file');
  assert.deepEqual(imports.filter((s) => !['fs', 'path', 'crypto'].includes(s)), [], 'desktop.ts imports something else');
});

test('isDesktop() is only called from the allowlisted files', () => {
  // Reintroduce by calling isDesktop() from a file not in IS_DESKTOP_ALLOWED.
  const offenders = sources().filter((f) => !IS_DESKTOP_ALLOWED.has(f) && /\bisDesktop\(/.test(code(read(f))));
  assert.deepEqual(offenders, [], 'isDesktop() called outside the allowlist (add the file on purpose, or use forDesktop/firstRunFloor)');
});

test('the first import of server.ts and of env.ts is ./lib/desktop', () => {
  // library.ts, customSites.ts and the source loader capture their paths from process.env when they LOAD, so
  // the desktop defaults must be written before any of them is imported.
  // Reintroduce by moving `import './lib/desktop'` below `import { env } from './env'` in server.ts.
  assert.equal(importsOf(read('server.ts'))[0], './lib/desktop', 'server.ts: the first import is not ./lib/desktop');
  assert.equal(importsOf(read('env.ts'))[0], './lib/desktop', 'env.ts: the first import is not ./lib/desktop');
});

test('server.ts keeps the server arm of every networking difference', () => {
  const s = code(read('server.ts'));
  // Reintroduce by writing `host: '127.0.0.1'` without the ternary: the Docker image stops answering on its port.
  assert.match(s, /host: isDesktop\(\) \? '127\.0\.0\.1' : '0\.0\.0\.0'/, 'the listen host lost its server arm');
  // Reintroduce by writing `trustProxy: false`: every server behind a reverse proxy logs the proxy's address.
  assert.match(s, /trustProxy: !isDesktop\(\),/, 'trustProxy lost its server arm');
  // The guard hook only on desktop, and only once.
  // Reintroduce by calling installDesktopGuards(app) unconditionally: every server request with a Host other
  // than 127.0.0.1 would answer 421.
  assert.match(s, /\n\s*if \(isDesktop\(\)\) installDesktopGuards\(app\);/, 'the desktop guard is not behind if (isDesktop())');
  assert.equal(s.match(/installDesktopGuards\(/g)?.length, 1, 'installDesktopGuards is called more than once');
  // OPDS and the Komga-compatible API: registered on the server, not on desktop.
  // Reintroduce by dropping the `if (!isDesktop())` before either registration.
  for (const plugin of ['opdsRoutes', 'komgaCompatRoutes']) {
    const calls = [...s.matchAll(new RegExp(`^(.*)app\\.register\\(${plugin}\\)`, 'gm'))].map((m) => m[1].trim());
    assert.deepEqual(calls, ['if (!isDesktop()) await'], `${plugin} is not registered exactly once, behind if (!isDesktop())`);
  }
  // The local account only on desktop.
  assert.match(s, /if \(isDesktop\(\)\) await ensureDesktopUser\(\);/, 'ensureDesktopUser is not behind if (isDesktop())');
  // The install count never runs on desktop.
  // Reintroduce by turning `if (!isDesktop()) {` back into a bare block: a desktop install with a restored
  // consent row would start pinging the collector.
  assert.match(s, /if \(!isDesktop\(\)\) \{\s*const DAY = 24 \* 60 \* 60 \* 1000;\s*const tick = async \(\) => \{\s*try \{\s*const row = await one<\{ on: boolean; secret: string \| null; last: Date \| null \}>\(\s*'SELECT install_ping AS on/,
    'the install-count tick is not behind if (!isDesktop())');
});

test('POST /auth/desktop exists only behind the switch, and is not documented', () => {
  const auth = code(read('routes/auth.ts'));
  // Reintroduce by registering the route outside `if (isDesktop())`: openapiCoverage.test.ts would then see an
  // undocumented route on the server, and the server would carry a sign-in path it can never use.
  assert.match(auth, /if \(isDesktop\(\)\) \{\s*app\.post\('\/auth\/desktop'/, "/auth/desktop is not registered inside if (isDesktop())");
  const everywhere = sources().filter((f) => code(read(f)).includes("'/auth/desktop'"));
  assert.deepEqual(everywhere, ['routes/auth.ts'], '/auth/desktop is registered somewhere else too');
  // A private handshake with the shell, not an API: it stays out of the spec and the docs.
  assert.doesNotMatch(readFileSync(join(BFF, 'openapi.yaml'), 'utf8'), /\/auth\/desktop/);
  assert.doesNotMatch(readFileSync(join(REPO, 'docs', 'api.md'), 'utf8'), /\/auth\/desktop/);
});

test('every desktop difference in responses is spread in, never a changed literal', () => {
  const auth = code(read('routes/auth.ts'));
  // signAccess and /auth/config gain `desktop: true` only when on; off, the object is the server's exactly.
  // Reintroduce by writing `desktop: isDesktop()`: every server response grows `"desktop":false`.
  assert.equal(auth.match(/\.\.\.\(isDesktop\(\) \? \{ desktop: true as const \} : \{\}\)/g)?.length, 2,
    'signAccess and /auth/config should each spread `desktop: true` in only when on');
  assert.doesNotMatch(auth, /desktop: isDesktop\(\)/);
});

// ── Builder L: paths, schedulers, backups ────────────────────────────────────────────────────────────────
// On Linux `path.join` IS `path.posix.join` and `path.relative` never answers with `\`, so every Windows path
// fix below is invisible to a runtime test on the CI machine; relPath.test.ts proves the helpers with
// `path.win32`, and these prove the helpers are what the call sites actually use.

test('chapterFileRel joins with posix.join, so Windows stores `/` like everyone else', () => {
  // Reintroduce by writing `join(seriesFolder, …)` again: identical on Linux, `Src\T\Chapter 1.cbz` on Windows,
  // and the repair, the Health "Fix" chip and "Fetch again" never match that chapter.
  const dl = code(read('lib/downloader.ts'));
  assert.match(dl, /export const chapterFileRel = \(seriesFolder: string, number: number\): string => posix\.join\(seriesFolder, `Chapter \$\{number\}\.cbz`\);/,
    'chapterFileRel does not use posix.join');
});

test('the other stored-path sites go through lib/relPath.ts', () => {
  // Reintroduce by restoring `path.relative(root, …)` in reapStaleTemp: a refetch put back after a crash on
  // Windows is reported as `Src\T\Chapter 1.cbz`, unpruneRestored matches no row, and the chapter reads deleted.
  const atomic = code(read('lib/fsAtomic.ts'));
  assert.match(atomic, /restored\.push\(relFromAbs\(root, path\.join\(dir, original\)\)\);/, 'reapStaleTemp does not store relFromAbs');
  assert.doesNotMatch(atomic, /path\.relative\(/, 'fsAtomic.ts computes a stored path with path.relative');
  // writeAtomic retries its rename on Windows (antivirus).
  assert.match(atomic, /await renameRetry\(tmp, file\);/, 'writeAtomic renames without the Windows retry');
  // Reintroduce by matching the raw `filePath` in webRoot: Windows loses `immutable` on _next/static and
  // `no-store` on sw.js.
  assert.match(code(read('lib/webRoot.ts')), /const rel = '\/' \+ toStoredRel\(filePath\.slice\(root\.length\)\)/, 'webRoot matches Cache-Control rules against a raw Windows path');
  // The completion pass hands the folder back to the downloader, whose chapterFileRel must land on the same row.
  const partial = code(read('lib/partial.ts'));
  assert.match(partial, /const seriesFolder = dirnameRel\(book\.file\);/);
  assert.doesNotMatch(partial, /\bdirname\(book\.file\)/);
  // The loop guard keeps dev:ino on POSIX.
  assert.match(code(read('lib/library.ts')), /platform === 'win32' \? \(await real\(abs\)\.catch\(\(\) => abs\)\)\.toLowerCase\(\) : `\$\{st\.dev\}:\$\{st\.ino\}`/);
});

test('every scheduler first run keeps its server literal inside firstRunFloor', () => {
  // Reintroduce by writing a desktop number in place of the server's (`Math.max(2 * 60 * 1000, due)`): the
  // Docker build's sweep would start two minutes after every deploy instead of ten.
  const s = code(read('server.ts'));
  const sites: Array<[string, RegExp]> = [
    ['sweep', /const delay = Math\.max\(firstRunFloor\(10 \* 60 \* 1000, 'sweep'\), due\);/],
    ['solver health', /setTimeout\(tick, firstRunFloor\(10 \* 60 \* 1000, 'solverHealth'\)\)\.unref\(\);/],
    ['repair', /Math\.max\(firstRunFloor\(30 \* 60 \* 1000, 'repair'\), last \+ REPAIR_HOURS \* 60 \* 60 \* 1000 - Date\.now\(\)\)/],
    ['import sweep', /setTimeout\(tick, firstRunFloor\(15 \* 60 \* 1000, 'importSweep'\)\)\.unref\(\);/],
    ['extension check', /Math\.max\(firstRunFloor\(10 \* 60 \* 1000, 'extensionCheck'\), last \+ hours \* 60 \* 60 \* 1000 - Date\.now\(\)\)/],
    ['cleanup', /setTimeout\(tick, firstRunFloor\(15 \* 60 \* 1000, 'cleanup'\)\)\.unref\(\);/],
  ];
  for (const [what, re] of sites) assert.match(s, re, `${what}: the first run lost its server literal or its firstRunFloor`);
  assert.equal(s.match(/firstRunFloor\(/g)?.length, sites.length, 'a first-run site was added or removed; list it here');
  // The watchdog: from its stamp on desktop, the fixed ten minutes on the server.
  // Reintroduce by dropping the else arm: the server's daily source check never starts.
  assert.match(s, /if \(isDesktop\(\)\) \{\s*void \(async \(\) => \{\s*const row = await one<\{ last: Date \| null \}>\('SELECT max\(checked_at\) AS last FROM source_health'\)[\s\S]{0,300}?stampDelay\(\{ last, interval: DAY, floor: DESKTOP_FLOORS\.watchdog, now: Date\.now\(\) \}\)[\s\S]{0,60}?\} else setTimeout\(tick, 10 \* 60 \* 1000\)\.unref\(\);/,
    'the watchdog first run is not desktop-stamp / server-ten-minutes');
});

test('the backup catch-up is wired, and a desktop wake re-arms the backup', () => {
  const s = code(read('server.ts'));
  const tickAt = s.indexOf('const backupTick = async ()');
  const tick = s.slice(tickAt, s.indexOf('const nextBackupDelay', tickAt));
  // Reintroduce by moving the stamp after `await runBackup()`: a run that hangs or throws is never counted as
  // an attempt, and with the database down every re-arm tries again in five minutes.
  assert.match(tick, /runtime\.lastBackupAttempt = Date\.now\(\);\s*const r = await runBackup\(\);/, 'the attempt is not stamped before the run');
  const next = s.slice(s.indexOf('const nextBackupDelay'), s.indexOf('const arm = async ()'));
  assert.match(next, /SELECT backup_hour, backup_last_run FROM server_settings/);
  // Reintroduce by passing `desktop: true`: the server would back up five minutes after any boot a day late.
  assert.match(next, /return backupDelay\(\{ hour, lastRun, lastAttempt: runtime\.lastBackupAttempt, now: Date\.now\(\), desktop: isDesktop\(\) \}\);/);
  // Reintroduce by deleting the wake block: a laptop asleep through 03:00 backs up hours late, or not that day.
  assert.match(s, /if \(isDesktop\(\)\) \{\s*const EVERY = 60 \* 1000;\s*const SLEPT = 5 \* 60 \* 1000;[\s\S]{0,400}?if \(now - wall > EVERY \+ SLEPT\) \{[\s\S]{0,200}?runtime\.rearmBackup\?\.\(\);/,
    'no desktop wake-from-sleep re-arm of the backup');
});

test('backup.ts keeps the server dump and the tar archive exactly, behind isDesktop()', () => {
  // aioParity.test.ts pins `spawn('pg_dump'`; this pins the rest of the server arm and that the desktop arm is
  // only reached on desktop. Reintroduce by calling desktopDump unconditionally: the server would honour a
  // stray PG_DUMP_PATH and zip its config instead of the tar its restore docs describe.
  const b = code(read('lib/backup.ts'));
  assert.match(b, /const pg = isDesktop\(\)\s*\? desktopDump\(\[[^\]]*\]\)\s*: spawn\('pg_dump', \['--no-owner', '--no-acl', '--clean', '--if-exists', env\.DATABASE_URL\]\);/);
  assert.match(b, /if \(isDesktop\(\)\) await zipConfig\(env\.CONFIG_DIR, path\.join\(dir, 'config\.zip'\)\);\s*else await run\('tar', \['-czf', path\.join\(dir, 'config\.tar\.gz'\), '-C', env\.CONFIG_DIR, '\.'\], \{ timeout: 5 \* 60 \* 1000 \}\);/);
  // The custom sites file keeps its literal on the server even when CONFIG_DIR moved (the sites would vanish).
  assert.match(code(read('lib/sources/customSites.ts')), /process\.env\.CUSTOM_SITES_FILE\s*\|\| forDesktop\('\/config\/sites\.json', /);
});

test('the desktop-only filesystem rules sit behind isDesktop(), with the server arm intact', () => {
  const la = code(read('lib/libraryAdmin.ts'));
  // Reintroduce by removing the exemption line: on NTFS/APFS a case-only rename (`Title` -> `title`) is refused
  // as "Something already exists", because the folder found is itself.
  assert.match(la, /if \(isDesktop\(\) && await sameDir\(from, to\)\) continue;\s*return \{ ok: false, reason: `Something already exists at "\$\{dest\}"\.` \};/,
    'the case-only rename exemption is missing or not desktop-only');
  // The server keeps its realpath slice; the desktop compares against the root's own realpath.
  assert.match(la, /isDesktop\(\) \? await insideRealRoot\(root, real\) : containedPath\(root, real\.slice\(root\.length \+ 1\) \|\| '\.'\)/);
  // The add reuses the stored or on-disk spelling only on desktop; the server keeps the exact folder.
  // Reintroduce by running the lower(folder) lookup on the server: two series whose titles differ only in case
  // (on a case-sensitive disk, two real folders) would be merged into one on add.
  const add = code(read('routes/sources.ts'));
  assert.match(add, /let folder = `\$\{srcDir\}\/\$\{sanitize\(title\)\}`;\s*if \(isDesktop\(\)\) \{\s*const stored = await one<\{ folder: string \}>\(\s*'SELECT folder FROM lib_series WHERE lower\(folder\) = lower\(\$1\)/);
  // The source's folder is made Windows-safe on Windows only; a server keeps the name as it always stored it.
  // Reintroduce by using `src.name` raw: a custom site called `Site: EN` cannot be created as a folder on
  // Windows at all. Or by sanitizing everywhere: a Linux server's `A.B.` source moves to a new folder.
  assert.match(add, /const srcDir = process\.platform === 'win32' \? sanitize\(src\.name\) : src\.name;/);
});

test('typed library paths are stored with `/`, and on desktop in the spelling the disk has', () => {
  // The folder browser, the preview, creating a library and re-pathing one (routes/admin.ts), and the rename
  // destination (lib/libraryAdmin.ts). Reintroduce by dropping toStoredRel from any one: `Manga\Seinen` typed
  // on Windows is stored with a backslash and `folder LIKE path || '/%'` matches no series under it.
  const admin = code(read('routes/admin.ts'));
  assert.equal(admin.match(/toStoredRel\(/g)?.length, 4, 'a typed library path in routes/admin.ts skips toStoredRel');
  assert.equal(admin.match(/await diskSpelling\(\[LIBRARY_ROOT, DL_ROOT\],\s/g)?.length, 4, 'a typed library path skips diskSpelling');
  assert.match(code(read('lib/libraryAdmin.ts')), /const typed = toStoredRel\(newFolder\)\.replace\(/, 'the rename destination skips toStoredRel');
});
