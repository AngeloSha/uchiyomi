// The desktop app runs THIS bff, unchanged, with an environment the Electron shell builds. Two things drift apart
// silently between them, and this pins both, the way aioParity.test.ts pins the single container:
//
//   * PATH DEFAULTS. The bff's defaults are the Docker image's mount points -- `/config`, `/cache`, `/backups`,
//     `/library`, `/library-dl`, `/sources`, `/config/sites.json`. On Windows `/config` is `C:\config`: a folder
//     the app would create at the root of the system drive (or fail to), and a restore would look for the
//     settings somewhere else entirely. Nothing crashes; the data just goes to the wrong place. So every bff
//     variable whose server default is a POSIX path must be either set by the shell (contract 1) or derived by
//     bff/src/lib/desktop.ts -- and the scan below finds those variables in the SOURCE, so a new one added next
//     month is caught without anyone remembering this file exists.
//   * VERSIONS. The installers are named, and electron-updater compares versions, from desktop/package.json. A
//     release that bumps bff/web/openapi and forgets desktop/ ships a "new" desktop build that calls itself the
//     old version: Windows never offers the update, and the Release's files carry the wrong number.
//
// Pure static + pure functions: desktopPlan() is imported with the switch OFF (a no-op at load), and the shell's
// env builder is plain CommonJS with no Electron in it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'fs';
import path, { join } from 'path';
import { desktopPlan } from '../src/lib/desktop';

const REPO = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const shell = require(join(REPO, 'desktop', 'src', 'env.js')) as {
  bffEnv: (o: Record<string, unknown>) => Record<string, string>;
  CONTRACT: readonly string[]; EXTRA: readonly string[]; DERIVED_BY_BFF: readonly string[]; POSIX_DEFAULTS: readonly string[];
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/**
 * Every env var whose server default is an absolute POSIX path, read out of bff/src:
 *   process.env.X || '/…'                    (library.ts, loader.ts, env.ts's secret files)
 *   process.env.X || forDesktop('/…', …)     (customSites.ts, possibly across lines)
 *   X: z.string().default('/…')              (env.ts's schema)
 * lib/desktop.ts itself is skipped: it is where the desktop values come from.
 */
function posixDefaults(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (k: string, where: string) => found.set(k, [...(found.get(k) ?? []), where]);
  for (const f of walk(join(REPO, 'bff', 'src'))) {
    if (f.endsWith(join('lib', 'desktop.ts'))) continue;
    const src = readFileSync(f, 'utf8');
    const rel = path.relative(REPO, f);
    for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)\s*(?:\|\||\?\?)\s*(?:forDesktop\(\s*)?['"`]\//g)) add(m[1], rel);
    for (const m of src.matchAll(/\b([A-Z][A-Z0-9_]*):\s*z\.string\(\)\.default\(\s*['"`]\//g)) add(m[1], rel);
  }
  return found;
}

// The shell's inputs as they look on a Windows PC whose account name is not ASCII (the case spike S2 found).
const WIN_DATA = 'C:\\Users\\Jösé 名前\\AppData\\Local\\Uchiyomi';
const WIN_LIBRARY = 'C:\\Users\\Jösé 名前\\Uchiyomi Library';
const shellInput = (over: Record<string, unknown> = {}) => ({
  L: { root: WIN_DATA }, resources: 'C:\\Program Files\\Uchiyomi\\resources', uiPort: 41234, pgPort: 41235, pgPassword: 'pw',
  pgBinDir: 'C:\\Program Files\\Uchiyomi\\resources\\pg\\bin', libraryDir: WIN_LIBRARY, secret: 's'.repeat(43),
  solverUrl: 'http://127.0.0.1:41236/0123456789abcdef0123456789abcdef', enginePort: 41237, engineUser: 'u', enginePass: 'p',
  osUser: 'Jösé', platform: 'win32', baseEnv: { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows' },
  ...over,
});

test('the scan finds the path defaults it is meant to find', () => {
  // A guard that reads nothing passes everything. These seven are the ones known today (design-shell §2); the
  // scan must see at least them, or the regexes above went blind. Reintroduce by dropping the `forDesktop(`
  // alternative from the first regex: CUSTOM_SITES_FILE's default (customSites.ts) is no longer seen, and this
  // names it.
  const found = posixDefaults();
  for (const k of ['CONFIG_DIR', 'CACHE_DIR', 'BACKUP_DIR', 'LIBRARY_ROOT', 'DL_ROOT', 'SOURCES_DIR', 'CUSTOM_SITES_FILE']) {
    assert.ok(found.has(k), `the source scan no longer sees ${k}'s POSIX default`);
  }
  // The shell keeps its own list for its own tests; it must not fall behind the source.
  assert.deepEqual([...shell.POSIX_DEFAULTS].sort(), [...found.keys()].sort(), 'desktop/src/env.js POSIX_DEFAULTS disagrees with bff/src');
});

test('every bff variable that defaults to a POSIX path is set by the shell or derived by lib/desktop.ts', () => {
  // Reintroduce by adding `process.env.THUMBS_DIR || '/thumbs'` anywhere under bff/src: the desktop app would
  // write to C:\thumbs, and this names THUMBS_DIR and the file.
  const e = shell.bffEnv(shellInput());
  const plan = desktopPlan(e, path.win32);
  const merged: Record<string, string | undefined> = { ...e, ...plan.set };
  const bad: string[] = [];
  for (const [k, where] of posixDefaults()) {
    const v = merged[k];
    const owner = shell.CONTRACT.includes(k) ? 'the shell' : k in plan.set ? 'lib/desktop.ts' : null;
    if (!owner || !v) { bad.push(`${k} (default in ${where.join(', ')}): neither the shell nor lib/desktop.ts sets it`); continue; }
    // A Windows path, under the data folder or the chosen library -- never a POSIX default resolved onto C:\.
    if (!/^[A-Z]:\\/.test(v)) bad.push(`${k} = ${v}: not a Windows path`);
    else if (!v.startsWith(WIN_DATA) && !v.startsWith(WIN_LIBRARY)) bad.push(`${k} = ${v}: outside the data folder and the library`);
  }
  assert.deepEqual(bad, [], bad.join('\n'));
  // The read library the user can add later (contract 1: LIBRARY_ROOT optional) goes through as given.
  const withRead = desktopPlan(shell.bffEnv(shellInput({ readLibrary: 'D:\\Manga' })), path.win32);
  assert.equal(withRead.set.LIBRARY_ROOT, 'D:\\Manga');
});

test('one owner per value: the shell never sets what lib/desktop.ts derives', () => {
  // Reintroduce by setting CONFIG_DIR in desktop/src/env.js: the shell's restore and the bff could then disagree
  // about where the settings live the day one of them changes.
  const e = shell.bffEnv(shellInput());
  const plan = desktopPlan(e, path.win32);
  for (const k of shell.DERIVED_BY_BFF) {
    assert.equal(e[k], undefined, `the shell sets ${k}, which lib/desktop.ts derives`);
    assert.ok(k in plan.set, `DERIVED_BY_BFF lists ${k}, but lib/desktop.ts does not derive it`);
  }
  // Contract 1 is exactly what build-common.md settled.
  assert.deepEqual([...shell.CONTRACT].sort(), [
    'DATABASE_URL', 'DL_ROOT', 'FLARESOLVERR_URL', 'LIBRARY_ROOT', 'PGPASSWORD', 'PG_DUMP_PATH', 'PORT', 'SUWAYOMI_PASSWORD',
    'SUWAYOMI_URL', 'SUWAYOMI_USERNAME', 'UCHIYOMI_DATA_DIR', 'UCHIYOMI_DESKTOP', 'UCHIYOMI_DESKTOP_SECRET', 'UCHIYOMI_DESKTOP_USER', 'WEB_ROOT',
  ]);
});

test('the desktop app carries the same version as the server, everywhere a release reads one', () => {
  // Reintroduce by leaving desktop/package.json one version behind: electron-updater would never offer the update,
  // and the installers attached to vX.Y.Z would be named for the version before.
  const bff = JSON.parse(read('bff/package.json')).version;
  const desk = JSON.parse(read('desktop/package.json'));
  const lock = JSON.parse(read('desktop/package-lock.json'));
  assert.equal(desk.version, bff, 'desktop/package.json version != bff/package.json version');
  assert.equal(lock.version, bff, 'desktop/package-lock.json version != bff/package.json version');
  assert.equal(lock.packages[''].version, bff, "desktop/package-lock.json's root package version != bff/package.json version");
  assert.equal(JSON.parse(read('web/package.json')).version, bff, 'web/package.json version != bff/package.json version');
  // openapiCoverage.test.ts holds openapi.yaml's info.version to bff/package.json.
});
