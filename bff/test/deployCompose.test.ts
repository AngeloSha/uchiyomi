// The compose files people actually install from must carry the safety settings the dev one documents.
//
// Three compose files describe the same optional extension engine, and they had drifted apart. The
// development file said, in a comment, that the engine "must never write into" the library and set
// AUTO_DOWNLOAD_CHAPTERS=false to enforce it. deploy/docker-compose.yml -- the file the README tells people
// to `curl -O` -- set only TZ. So every install done the documented way ran an engine that would happily
// download chapters into its own volume the first time an extension-backed series was followed: a second,
// invisible copy of the library that nothing manages, prunes, or backs up.
//
// The split file had the env line but not DOWNLOAD_AS_CBZ, and none of the three had a healthcheck, so a
// wedged JVM looked identical to a healthy one in `docker ps` and the app's only clue was a timeout.
//
// Static text checks on purpose: there is no YAML parser in the dependency list, adding one to assert on
// four lines would be the wrong trade, and the failure mode here is "a line is missing from a file", which
// text can see perfectly well.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '..', '..');

/** The body of the suwayomi service in a compose file: from its key to the next key at the same indent. */
function suwayomiBlock(file: string): string {
  const src = readFileSync(join(REPO, file), 'utf8');
  const start = src.search(/^ {2}[a-z-]*suwayomi:$/m);
  assert.ok(start >= 0, `${file} has no suwayomi service — if it was removed on purpose, drop it from this test`);
  // Start AFTER the service's own key line, or the "next key at this indent" search matches that very line
  // and every block comes back empty -- which reads as "the setting is missing" for all three files at once.
  const rest = src.slice(src.indexOf('\n', start) + 1);
  const end = rest.search(/^ {0,2}[a-z][a-z-]*:$/m);
  return rest.slice(0, end < 0 ? undefined : end);
}

/**
 * The block with its comments removed.
 *
 * aioParity.test.ts already learned this the hard way: a guard that greps the raw text matches the prose
 * EXPLAINING the setting, so it keeps passing after the setting itself is deleted. Here the trap bites from
 * the other side -- the healthcheck's own comment says "no curl, wget or nc", which a naive search for those
 * tools reads as the healthcheck using one.
 */
const instructions = (block: string): string =>
  block.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

const FILES = ['deploy/docker-compose.yml', 'deploy/docker-compose.split.yml', 'docker-compose.yml'];

test('the extension engine is told never to download into its own volume', () => {
  for (const file of FILES) {
    const block = instructions(suwayomiBlock(file));
    // Reintroduce by deleting either line from any one file: that install grows a second, unmanaged copy
    // of the library inside a Docker volume, and nothing reports it.
    assert.match(block, /AUTO_DOWNLOAD_CHAPTERS:\s*"false"/,
      `${file}: the engine may download chapters into its own volume — Uchiyomi owns the library`);
    assert.match(block, /DOWNLOAD_AS_CBZ:\s*"true"/,
      `${file}: the engine would write loose images rather than CBZ if it ever did download`);
  }
});

test('a wedged extension engine is visible to docker, not just to the app', () => {
  for (const file of FILES) {
    const block = suwayomiBlock(file);
    assert.match(block, /healthcheck:/, `${file}: no healthcheck, so a hung JVM reads as running`);
    // The image is Ubuntu with a JRE and has no curl, wget or nc -- verified live. A healthcheck written
    // against curl passes this test's shape and then fails on every real install with "executable file not
    // found", which docker reports as simply unhealthy.
    assert.ok(!/\b(curl|wget|nc)\b/.test(instructions(block)),
      `${file}: the healthcheck uses a tool the suwayomi image does not ship (curl/wget/nc) — use bash /dev/tcp`);
    // 401 is alive: the engine answers, it just has authentication on. Treating only 200 as healthy would
    // restart-loop every install that set a username and password.
    assert.match(block, /401/, `${file}: the healthcheck does not accept 401, so an authenticated engine reads as dead`);
    assert.match(block, /start_period:/, `${file}: no start_period — a JVM takes ~90s and would flap on boot`);
  }
});

test('the optional engine is not made mandatory by a depends_on', () => {
  // The file says "Remove this service ... to drop it". A depends_on pointing at a removed service makes
  // `docker compose up` fail outright with "depends on undefined service", turning an optional feature into
  // a required one. The app already tolerates a slow or absent engine (scheduleSuwayomiRetry).
  for (const file of FILES) {
    const src = readFileSync(join(REPO, file), 'utf8');
    for (const m of src.matchAll(/depends_on:[\s\S]{0,200}/g)) {
      assert.ok(!/suwayomi/.test(m[0]), `${file}: something depends_on the optional extension engine`);
    }
  }
});
