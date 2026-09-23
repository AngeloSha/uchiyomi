// S1(a) on the TARGET OSes: the bff test files that load a native or WASM module (sharp, @node-rs/argon2, mupdf,
// unrar) or drive routes that do, under plain Node and under ELECTRON_RUN_AS_NODE=1, against the bundled
// PostgreSQL 16 started by the shell's own postgres.js. The full suite runs on ubuntu (s1-suite, sharded); this
// is the part of it where Windows/macOS could differ from Linux, and where Electron's Linux-only GLib clash
// (sharp warns about it) cannot hide or fake a result.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DESKTOP, OUT, freePort, record, tmpRoot } from './lib.mjs';

const require = createRequire(import.meta.url);
const { Postgres } = require(join(DESKTOP, 'src', 'postgres.js'));

export const NATIVE_FILES = [
  'pageHash.test.ts', 'tinyPage.test.ts', 'naming.test.ts', 'archiveFormats.test.ts', 'pdfEpub.test.ts', 'coverProxy.test.ts',
  'engineRedirect.test.ts', 'backfillSchedule.test.ts', 'predicateHygiene.test.ts',
  'pageHashJob.int.test.ts', 'junkPages.int.test.ts', 'imageBearer.int.test.ts', 'coverUrlGuard.int.test.ts', 'prunedBooks.int.test.ts',
  'apitokens.int.test.ts', 'totpSetup.int.test.ts', 'refreshRace.int.test.ts', 'routeWiring.int.test.ts', 'adultLibrary.int.test.ts',
  'visibilityFailsClosed.int.test.ts', 'opdsPse.int.test.ts', 'opdsToken.int.test.ts', 'komgaCompat.int.test.ts', 'komgaGhosts.int.test.ts',
];

const log = { info: (...a) => console.log(...a), warn: (...a) => console.log(...a), error: (...a) => console.error(...a) };
const root = tmpRoot('s1pg');
const pg = new Postgres({ distDir: join(DESKTOP, 'resources', 'pg'), pgdata: join(root, 'pg16'), logFile: join(root, 'postgres.log'), tmpDir: join(root, 'tmp'), log });
await pg.prepare();
await pg.initdb('test');
const port = await freePort();
await pg.start(port);
await pg.ensureDatabase('uchiyomi_test');
const env = { ...process.env, TEST_DATABASE_URL: `postgres://yomi:test@127.0.0.1:${port}/uchiyomi_test`, TZ: 'UTC' };

const files = NATIVE_FILES.join(',');
for (const runtime of ['node', 'electron']) {
  const r = spawnSync(process.execPath, [join(DESKTOP, 'scripts', 'ci', 's1-suite.mjs'), '--runtime', runtime, '--files', files, '--label', `native-${runtime}`], { env, stdio: 'inherit', timeout: 20 * 60_000 });
  console.log(`s1-suite ${runtime}: exit ${r.status}`);
}
await pg.stop();
const cmp = spawnSync(process.execPath, [join(DESKTOP, 'scripts', 'ci', 's1-compare.mjs'), OUT, '--id', 'S1a-native-subset'], { stdio: 'inherit' });
if (cmp.status !== 0) record('S1a-native-subset', 'FAIL', `compare exited ${cmp.status}`);
