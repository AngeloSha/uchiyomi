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
// Static text checks on purpose: the failure mode here is "a line is missing from a file", which text can see
// perfectly well. The one test that needs structure (which network an add-on joins, #72) parses with the `yaml`
// dev dependency releasePipeline.test.ts already uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { parse as parseYaml } from 'yaml';

const REPO = join(__dirname, '..', '..');

/** The body of the suwayomi service in a compose file: from its key to the next key at the same indent. */
function suwayomiBlock(file: string): string {
  const src = readFileSync(join(REPO, file), 'utf8');
  const start = src.search(/^ {2}[a-z-]*suwayomi:$/m);
  // (The CasaOS add-on's one service is `uchiyomi-suwayomi` too, so the same reader serves it.)
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

const FILES = ['deploy/docker-compose.yml', 'deploy/docker-compose.external-db.yml', 'deploy/docker-compose.split.yml', 'docker-compose.yml'];
/**
 * Every file that runs the engine: the four above, and the CasaOS listing's add-on (#72), which is the same
 * service for a platform whose listing ships without it. The engine's own protections are held for all five.
 */
const ENGINE_FILES = [...FILES, 'deploy/casaos/uchiyomi-suwayomi.yml'];

test('the extension engine is told never to download into its own volume', () => {
  for (const file of ENGINE_FILES) {
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
  for (const file of ENGINE_FILES) {
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

/** The body of the Cloudflare solver's service, read the same way as the engine's. */
function solverBlock(file: string): string {
  const src = readFileSync(join(REPO, file), 'utf8');
  const start = src.search(/^ {2}[a-z-]*flaresolverr:$/m);
  assert.ok(start >= 0, `${file} has no flaresolverr service`);
  const rest = src.slice(src.indexOf('\n', start) + 1);
  const end = rest.search(/^ {0,2}[a-z][a-z-]*:$/m);
  return rest.slice(0, end < 0 ? undefined : end);
}

/**
 * Discussion #72: the engine is a JVM, and a JVM with no limit sizes its heap from the HOST -- 15.7 GiB on a
 * 62 GB machine, measured 2026-09-25 against v2.3.2243 -- and it ran uncapped in every layout while the solver
 * beside it had a reasoned 2 GB cap. The desktop app starts the same engine with -Xmx768m.
 *
 * Both halves are needed. The heap flag keeps the JVM from growing into the ceiling; the ceiling turns what the
 * heap flag does not cover (metaspace, threads, native buffers) into a restart instead of a host that swaps.
 * Reintroduce by deleting either line from any one file: the assertion names the file.
 */
test("the extension engine's memory is bounded in every layout", () => {
  for (const file of ENGINE_FILES) {
    const block = instructions(suwayomiBlock(file));
    assert.match(block, /^\s+mem_limit:\s*\S+/m, `${file}: the engine has no memory ceiling, so the JVM sizes itself from the host`);
    assert.match(block, /JAVA_TOOL_OPTIONS:.*-Xmx\d+[mMgG]/, `${file}: the engine's heap is not capped (-Xmx in JAVA_TOOL_OPTIONS)`);
  }
});

/**
 * The split layout's solver had none of these while the others did: no /dev/shm headroom (chromedriver dies
 * mid-challenge at Docker's 64 MB default, which reads from the app's side as the SITE blocking us), no memory
 * cap on a known leak, no healthcheck. Reintroduce by deleting any one from any one file.
 */
test('the Cloudflare solver has the same protections in every layout', () => {
  for (const file of FILES.filter((f) => f.startsWith('deploy/'))) {
    const block = instructions(solverBlock(file));
    assert.match(block, /^\s+shm_size:\s*1gb/m, `${file}: the solver keeps Docker's 64 MB /dev/shm, so chromedriver dies mid-challenge`);
    assert.match(block, /^\s+mem_limit:\s*\S+/m, `${file}: the solver's leak is not capped`);
    assert.match(block, /^\s+healthcheck:/m, `${file}: a crashing solver reads as running`);
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

test('the install file is one container, and the external-database file still is not', () => {
  // deploy/docker-compose.yml is what the README tells people to curl. Since v0.18.0 it runs the database
  // inside the container: no db service, no DATABASE_URL (that is the switch), a /data volume, and a grace
  // period long enough for the app to finish a chapter and Postgres to checkpoint.
  const one = instructions(readFileSync(join(REPO, 'deploy/docker-compose.yml'), 'utf8'));
  // Reintroduce by pasting a DATABASE_URL back in: the embedded database silently never starts and the app
  // waits forever for a host that is not there.
  assert.ok(!/DATABASE_URL/.test(one), 'deploy/docker-compose.yml sets DATABASE_URL, which turns embedded mode off');
  assert.ok(!/^\s{2}[a-z-]*-db:$/m.test(one), 'deploy/docker-compose.yml still runs a database container');
  assert.match(one, /uchiyomi_data:\/data/, 'the embedded database has no volume, so it is lost on every recreate');
  assert.match(one, /stop_grace_period:\s*[2-9]\d+s/, 'no stop_grace_period: docker kills Postgres mid-checkpoint at 10 s');
  assert.ok(!/uchiyomi_pgdata/.test(one), 'a pgdata volume is declared for a database container that is not there');

  // The external layout is still shipped, unchanged in substance, for people who run Postgres themselves.
  const ext = instructions(readFileSync(join(REPO, 'deploy/docker-compose.external-db.yml'), 'utf8'));
  assert.match(ext, /^\s{2}uchiyomi-db:$/m, 'the external-database file lost its database container');
  assert.match(ext, /DATABASE_URL:\s*postgres:\/\//, 'the external-database file no longer points the app at its database');
  assert.match(ext, /depends_on:[\s\S]{0,80}uchiyomi-db/, 'the app no longer waits for its database in the external layout');
});

/**
 * Every SUWAYOMI_* knob docs/extensions.md tells a self-hoster to set must actually reach the app.
 *
 * The deploy files enumerate the app's environment explicitly (no env_file), so a variable that is documented
 * but not listed there is a setting that does nothing: SUWAYOMI_PAGE_CONCURRENCY shipped in the docs, the
 * env parser and the settings table before anybody noticed the compose files never passed it through.
 * The table in docs/extensions.md is the contract; this reads it and checks each deploy file.
 *
 * Reintroduce by deleting the `SUWAYOMI_PAGE_CONCURRENCY:` line from deploy/docker-compose.yml: the
 * `passes SUWAYOMI_PAGE_CONCURRENCY` assertion names the file.
 */
test('every documented extension knob is passed through by every deploy file', () => {
  const docs = readFileSync(join(REPO, 'docs/extensions.md'), 'utf8');
  const knobs = [...new Set([...docs.matchAll(/^\| `(SUWAYOMI_[A-Z_]+)`/gm)].map((m) => m[1]))]
    // SUWAYOMI_USERNAME / _PASSWORD share one table row; the regex takes the first of a pair
    .concat(/`SUWAYOMI_USERNAME` \/ `SUWAYOMI_PASSWORD`/.test(docs) ? ['SUWAYOMI_PASSWORD'] : []);
  assert.ok(knobs.includes('SUWAYOMI_PAGE_CONCURRENCY'), `the settings table lost its rows: ${knobs.join(', ')}`);
  for (const file of ['deploy/docker-compose.yml', 'deploy/docker-compose.external-db.yml', 'deploy/docker-compose.split.yml']) {
    const src = instructions(readFileSync(join(REPO, file), 'utf8'));
    for (const k of knobs) {
      assert.ok(new RegExp(`^\\s+${k}:`, 'm').test(src), `${file} passes ${k}`);
    }
  }
});

/**
 * Issue #54: Mangaball via a keiyoushi extension failed every search with `java.io.IOException: Cloudflare
 * bypass currently disabled`, while a manual curl through the bundled FlareSolverr worked. Suwayomi-Server
 * has no browser of its own; its CloudflareInterceptor needs a FlareSolverr and ships with that integration
 * OFF. Every compose file ran the engine next to a perfectly good solver and never introduced the two. The
 * image's startup script maps exactly FLARESOLVERR_ENABLED and FLARESOLVERR_URL into server.conf (verified
 * against the running v2.3.2243 image, lines 124-125), so these two lines are the whole fix.
 *
 * The URL must name the solver service of THAT file (yomi-flaresolverr in the dev file, uchiyomi-flaresolverr
 * in deploy/), and the engine must share a network with it -- the split file had the engine on the database
 * network only, where the solver's name does not resolve and the setting would have been theatre.
 *
 * Reintroduce by removing FLARESOLVERR_ENABLED from the engine service: the assertion names the file.
 */
test('the bundled engine is pointed at the bundled solver', () => {
  for (const file of FILES) {
    const src = readFileSync(join(REPO, file), 'utf8');
    const block = instructions(suwayomiBlock(file));
    assert.match(block, /FLARESOLVERR_ENABLED:\s*"true"/,
      `${file}: the engine's Cloudflare bypass is off, so every Cloudflare-protected extension source fails its search`);
    const solver = src.match(/^ {2}([a-z-]*flaresolverr):$/m)?.[1];
    assert.ok(solver, `${file} has no flaresolverr service for the engine to use`);
    assert.match(block, new RegExp(`FLARESOLVERR_URL:\\s*http://${solver}:8191`),
      `${file}: FLARESOLVERR_URL must name this file's own solver service (${solver}) on its port`);
    // Same network, or the name above does not resolve. The solver's block is read the same way.
    const solverStart = src.search(new RegExp(`^ {2}${solver}:$`, 'm'));
    const solverRest = src.slice(src.indexOf('\n', solverStart) + 1);
    const solverEnd = solverRest.search(/^ {0,2}[a-z][a-z-]*:$/m);
    const solverBlock = instructions(solverRest.slice(0, solverEnd < 0 ? undefined : solverEnd));
    const nets = (b: string) => (b.match(/networks:\s*(\[[^\]]*\]|(?:\n\s+-\s*\S+)+)/)?.[1] || '').match(/[a-z_]+/g) || [];
    const shared = nets(block).filter((n) => nets(solverBlock).includes(n));
    assert.ok(shared.length, `${file}: the engine (${nets(block)}) and the solver (${nets(solverBlock)}) share no network, so FLARESOLVERR_URL cannot resolve`);
  }
});

/** Every service of a compose file, by name: from its key to the next key at the same indent. */
function services(file: string): Map<string, string> {
  const src = readFileSync(join(REPO, file), 'utf8');
  let body = src.slice(src.search(/^services:$/m) + 'services:'.length);
  const end = body.search(/^[a-z]/m); // the next top-level key (networks:, volumes:, x-casaos:) ends `services:`
  if (end >= 0) body = body.slice(0, end);
  const out = new Map<string, string>();
  const keys = [...body.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)];
  keys.forEach((k, i) => out.set(k[1], body.slice(k.index! + k[0].length, i + 1 < keys.length ? keys[i + 1].index! : undefined)));
  return out;
}

/** The engine's service name in a compose file: `uchiyomi-suwayomi`, or `yomi-suwayomi` in the development file. */
const engineName = (file: string): string => {
  const name = [...services(file).keys()].find((n) => n.endsWith('suwayomi'));
  assert.ok(name, `${file} has no engine service`);
  return name;
};

/**
 * #72: one switch, EXTENSION_ENGINE, turns the bundled engine off everywhere it matters. Compose reads it as the
 * engine's replica count, so `EXTENSION_ENGINE=0` + `docker compose up -d` removes the container and keeps its
 * volume; the app reads the same variable, so it knows extensions are off rather than reporting an engine it was
 * told to drop as unreachable. Replicas, not a profile: a profile is off unless something switches it on, and a
 * fresh curl install has no .env to do that, so every new install would lose the engine.
 *
 * Reintroduce by deleting the `replicas:` line from deploy/docker-compose.split.yml (the assertion names the
 * file), or the app's `EXTENSION_ENGINE:` line from any service that talks to the engine.
 */
test('EXTENSION_ENGINE=0 stops the bundled engine and tells the app', () => {
  for (const file of FILES) {
    const engine = instructions(suwayomiBlock(file));
    assert.match(engine, /^ {4}deploy:\n {6}replicas: \$\{EXTENSION_ENGINE:-1\}$/m,
      `${file}: the engine has no \`deploy: replicas: \${EXTENSION_ENGINE:-1}\`, so EXTENSION_ENGINE=0 does not stop it`);
    let apps = 0;
    for (const [name, block] of services(file)) {
      const code = instructions(block);
      if (!/^\s+SUWAYOMI_URL:/m.test(code)) continue;
      apps++;
      assert.match(code, /^\s+EXTENSION_ENGINE: \$\{EXTENSION_ENGINE:-1\}$/m,
        `${file}: ${name} talks to the engine but is not told EXTENSION_ENGINE, so it reports a switched-off engine as unreachable`);
    }
    assert.ok(apps > 0, `${file}: no service passes SUWAYOMI_URL`);
  }
});

/**
 * The documented off switch that never worked. docs/extensions.md, the compose headers and the Admin copy all said
 * `SUWAYOMI_URL=` (empty) in .env turns extensions off, but every file wrote `${SUWAYOMI_URL:-...}`, and `:-`
 * treats an empty value as unset: `docker compose config` put the default right back. The single dash keeps an
 * explicit empty value empty.
 *
 * Reintroduce by putting the colon back in any one file: the assertion names it.
 */
test('an empty SUWAYOMI_URL in .env turns extensions off', () => {
  for (const file of [...FILES, 'deploy/casaos/docker-compose.yml']) {
    const code = instructions(readFileSync(join(REPO, file), 'utf8'));
    assert.ok(!code.includes('${SUWAYOMI_URL:-'),
      `${file}: \${SUWAYOMI_URL:-...} puts the default back when .env says SUWAYOMI_URL= (empty), so the documented off switch does nothing`);
  }
  for (const file of FILES) {
    const want = `\${SUWAYOMI_URL-http://${engineName(file)}:4567}`;
    for (const [name, block] of services(file)) {
      const line = instructions(block).match(/^\s+SUWAYOMI_URL: (.*)$/m)?.[1];
      if (line !== undefined) assert.equal(line, want, `${file}: ${name} does not default SUWAYOMI_URL to this file's own engine`);
    }
  }
});

/**
 * The CasaOS listing ships no engine; its add-on (deploy/casaos/uchiyomi-suwayomi.yml) joins the listing's
 * network, where the listing's solver and app are. Its engine protections are held above with the other files;
 * this is what is particular to an add-on. An add-on that CREATED its own network would sit alone on it: the
 * app could not reach the engine and the engine could not reach the solver. And the listing lists
 * SUWAYOMI_URL, empty, so the field is there in CasaOS's settings editor to fill in once the add-on is in.
 *
 * Reintroduce by dropping `external: true`, or renaming the network: the assertion says which.
 */
test("the CasaOS add-on engine joins the listing and uses the listing's solver", () => {
  const listing = parseYaml(readFileSync(join(REPO, 'deploy/casaos/docker-compose.yml'), 'utf8'));
  const addon = parseYaml(readFileSync(join(REPO, 'deploy/casaos/uchiyomi-suwayomi.yml'), 'utf8'));
  const engine = addon.services['uchiyomi-suwayomi'];
  assert.ok(engine, "the add-on has no uchiyomi-suwayomi service, the name the listing's SUWAYOMI_URL help gives");
  const listingNet = listing.networks?.uchiyomi?.name;
  assert.ok(listingNet, 'the listing no longer names its network');
  const [net] = engine.networks ?? [];
  assert.equal(addon.networks?.[net]?.external, true, `the add-on creates its own "${net}" network instead of joining the listing's`);
  assert.equal(addon.networks[net].name, listingNet, "the add-on joins a network the listing does not create");
  const solver = Object.keys(listing.services).find((n) => n.endsWith('flaresolverr'));
  assert.equal(engine.environment.FLARESOLVERR_ENABLED, 'true', "the add-on's Cloudflare bypass is off");
  assert.equal(engine.environment.FLARESOLVERR_URL, `http://${solver}:8191`, "the add-on is not pointed at the listing's solver");
  assert.equal(engine.environment.WEB_UI_ENABLED, 'false', "the add-on serves the engine's own web page");
  assert.ok(Object.hasOwn(listing.services.uchiyomi.environment, 'SUWAYOMI_URL'), 'the listing has no SUWAYOMI_URL field to fill in');
  assert.equal(listing.services.uchiyomi.environment.SUWAYOMI_URL, '', 'the listing points at an engine it does not ship');
});

/**
 * The two tests above read the files as text; this asks Compose itself, where it is installed (skipped in the
 * test container, which has no docker). The four files are copied to a scratch directory with an empty .env,
 * which the development file's `env_file` needs, and rendered twice: with nothing set, and with
 * EXTENSION_ENGINE=0 and SUWAYOMI_URL= empty.
 *
 * Reintroduce by putting `:-` back (SUWAYOMI_URL comes back as the default) or dropping `deploy:` (replicas are
 * undefined, not 0).
 */
const composeAvailable = (() => {
  try { execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
test('Compose itself reads the switch', { skip: composeAvailable ? false : 'docker compose is not available here' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'uchiyomi-compose-'));
  try {
    writeFileSync(join(dir, '.env'), '');
    for (const file of FILES) {
      const copy = join(dir, file.replace(/\//g, '_'));
      copyFileSync(join(REPO, file), copy);
      const render = (extra: Record<string, string>) => {
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(SUWAYOMI_|EXTENSION_ENGINE$|COMPOSE_)/.test(k)) env[k] = v;
        const out = execFileSync('docker', ['compose', '-p', 'uchiyomi-switch-test', '-f', copy, '--profile', 'split', 'config', '--format', 'json'],
          { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return JSON.parse(out).services as Record<string, any>;
      };
      const engine = engineName(file);
      const on = render({});
      assert.equal(on[engine].deploy?.replicas, 1, `${file}: the engine does not run by default`);
      const off = render({ EXTENSION_ENGINE: '0', SUWAYOMI_URL: '' });
      assert.equal(off[engine].deploy?.replicas, 0, `${file}: EXTENSION_ENGINE=0 does not scale the engine to zero`);
      for (const [name, svc] of Object.entries(off)) {
        if (!svc.environment || !('SUWAYOMI_URL' in svc.environment)) continue;
        assert.equal(svc.environment.SUWAYOMI_URL, '', `${file}: ${name} gets the default SUWAYOMI_URL although .env empties it`);
        assert.equal(svc.environment.EXTENSION_ENGINE, '0', `${file}: ${name} is not told the engine is off`);
        assert.equal(on[name].environment.SUWAYOMI_URL, `http://${engine}:4567`, `${file}: ${name} lost the default engine address`);
        assert.equal(on[name].environment.EXTENSION_ENGINE, '1');
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
