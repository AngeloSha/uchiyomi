// Adding an extension repository (v0.45.0): what a paste becomes, and what the route keeps.
//
// The route is driven over HTTP against a FAKE engine -- a real HTTP server on loopback speaking the GraphQL
// operations the routes use, shaped the way Suwayomi-Server v2.3.2243 answers them -- so the real transport,
// the real retry loop, the real audit rows and the real scheduled check run, and no repository on the internet
// (or the live engine) is ever touched. The fake reproduces the engine behaviours that shaped the route, each
// one measured on a real v2.3.2243:
//
//   * a settings change is applied asynchronously, so the first refresh after an add sees nothing new;
//   * the RUNNING engine lists an address exactly as it was given; only after a restart does it list its own
//     spelling of it (the repo.json beside a pasted index.min.json) -- `restart()` below. Each extension's
//     `repo` names that own spelling;
//   * a list-shaped index is read only at an address ending in /index.min.json; anything else (an index.json)
//     is refused in the engine's log and yields nothing -- `accepts()` below;
//   * an installed extension that no configured repository offers stays listed, installed and OBSOLETE under
//     its old address, and turns non-obsolete when a repository offering it is added again.
//
// ⚠️ The first version of this fake swapped the stored spelling in on the next refresh, served an index.json as
// a working repository and never marked anything obsolete. All its tests passed while the candidate had three
// real bugs, each hidden by one of those differences: a duplicate "restored" repository after every engine
// restart, the re-add of a removed repository refused, and an index.json alternative the engine never accepts.
//
// Each refusal is checked for what it says AND for what it wrote to the engine: a refused paste must reach
// the engine not at all, and a repository that yields nothing must not be left in the engine's list.
//
// Skipped automatically unless TEST_DATABASE_URL is set (sign-in and the audit log need Postgres).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
const USER = 'xr-admin';

// ---- the fake engine -------------------------------------------------------------------------------------

/** What "the internet" serves at each address, and the spelling the engine lists it under after a restart. */
const NET: Record<string, { stored: string; exts: string[] }> = {
  'https://example.org/a/index.min.json': { stored: 'https://example.org/a/repo.json', exts: ['a.one', 'a.two'] },
  'https://example.org/b/index.min.json': { stored: 'https://example.org/b/repo.json', exts: ['b.one'] },
  // c's folder also serves the full index.json, listing the same extension -- which the engine refuses
  'https://example.org/c/index.min.json': { stored: 'https://example.org/c/repo.json', exts: ['c.one'] },
  'https://example.org/c/index.json': { stored: 'https://example.org/c/index.json', exts: ['c.one'] },
  // a folder pasted bare: the alternative is the index.min.json inside it
  'https://example.org/d/index.min.json': { stored: 'https://example.org/d/repo.json', exts: ['d.one', 'd.two', 'd.three'] },
};
/**
 * v2.3.2243's rule, from its log ("IllegalArgumentException: Provided legacy store url is not valid"): a
 * list-shaped index is read only at an address ending in /index.min.json. The repo.json it respells that to
 * after a restart is its own format and is read too.
 */
const accepts = (u: string) => /\/index\.min\.json$/i.test(u) || /\/repo\.json$/i.test(u);
const repoAt = (u: string) => (accepts(u) ? NET[u] ?? Object.values(NET).find((n) => n.stored === u) : undefined);
/** An extension installed from a repository removed long ago: the engine keeps its row and its old address. */
const ORPHAN = { pkgName: 'gone.one', repo: 'https://example.org/gone/repo.json' };

type Row = { pkgName: string; repo: string; installed: boolean; obsolete: boolean };
const eng = {
  repos: [] as string[],
  catalogue: [] as Row[],
  /** Installed extensions, each with the address it was last offered under. */
  installed: new Map<string, string>(),
  seen: new Set<string>(),
  writes: [] as string[][],
  failRead: false,
  failWrite: '',
};
function resetEngine() {
  eng.repos = [];
  eng.installed = new Map([[ORPHAN.pkgName, ORPHAN.repo]]);
  eng.seen = new Set();
  eng.writes = [];
  eng.failRead = false;
  eng.failWrite = '';
  refresh();
}
function refresh() {
  const offered: Row[] = [];
  for (const u of eng.repos) {
    const hit = repoAt(u);
    if (!hit) continue; // unreachable, not a repository, or refused: logged, kept in the list, adds nothing
    if (!eng.seen.has(hit.stored)) { eng.seen.add(hit.stored); continue; } // applied asynchronously: nothing yet
    for (const p of hit.exts) {
      if (offered.some((e) => e.pkgName === p)) continue;
      if (eng.installed.has(p)) eng.installed.set(p, hit.stored);
      offered.push({ pkgName: p, repo: hit.stored, installed: eng.installed.has(p), obsolete: false });
    }
  }
  const orphans = [...eng.installed].filter(([p]) => !offered.some((e) => e.pkgName === p))
    .map(([pkgName, repo]) => ({ pkgName, repo, installed: true, obsolete: true }));
  eng.catalogue = [...offered, ...orphans];
}
/** The engine restarting: from now on it lists its own spelling of every address it can read. */
function restart() {
  eng.repos = [...new Set(eng.repos.map((u) => repoAt(u)?.stored ?? u))];
}

let engine: Server;
before(async () => {
  engine = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { query, variables } = JSON.parse(body || '{}') as { query: string; variables: Record<string, unknown> };
      const send = (status: number, j: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (/setSettings/.test(query)) {
        eng.writes.push([...(variables.r as string[])]);
        if (eng.failWrite) return send(200, { errors: [{ message: eng.failWrite }] });
        eng.repos = [...new Set(variables.r as string[])];
        return send(200, { data: { setSettings: { settings: { extensionRepos: eng.repos } } } });
      }
      if (/fetchExtensions/.test(query)) {
        refresh();
        return send(200, { data: { fetchExtensions: { extensions: eng.catalogue.map((e) => ({ pkgName: e.pkgName })) } } });
      }
      if (/settings\s*\{\s*extensionRepos/.test(query)) {
        if (eng.failRead) return send(500, { errors: [{ message: 'down' }] });
        return send(200, { data: { settings: { extensionRepos: eng.repos } } });
      }
      if (/extensions\s*\{\s*nodes/.test(query)) {
        return send(200, { data: { extensions: { nodes: eng.catalogue.map((e) => ({
          pkgName: e.pkgName, name: e.pkgName, lang: 'en', versionName: '1.0', iconUrl: null,
          isInstalled: e.installed, hasUpdate: false, isObsolete: e.obsolete, isNsfw: false, repo: e.repo,
        })) } } });
      }
      return send(400, { errors: [{ message: `the fake engine does not know ${query}` }] });
    });
  });
  await new Promise<void>((r) => engine.listen(0, '127.0.0.1', r));
  // ⚠️ Set BEFORE the route modules load: env.ts parses process.env once at import.
  process.env.SUWAYOMI_URL = `http://127.0.0.1:${(engine.address() as { port: number }).port}`;
});
after(async () => { await new Promise<void>((r) => engine.close(() => r())); });

// ---- the app -----------------------------------------------------------------------------------------------

async function boot() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  await migrate();
  await q(`UPDATE server_settings SET extension_repos = '[]' WHERE id = 1`);
  await q(`DELETE FROM users WHERE username = $1`, [USER]).catch(() => {});
  const admin = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind)
     VALUES ($1, $1, 'x', 'admin', 'password') RETURNING id`, [USER]))[0].id;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  const auth = { authorization: `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}` };
  const add = (url: unknown) => app.inject({ method: 'POST', url: '/api/admin/extensions/repos', headers: auth, payload: { url } });
  const del = (url: string) => app.inject({ method: 'DELETE', url: '/api/admin/extensions/repos', headers: auth, payload: { url } });
  // "Update all" runs the very runExtensionCheck the schedule runs, with its live store and transport.
  const check = () => app.inject({ method: 'POST', url: '/api/admin/extensions/update-all', headers: auth });
  const monitorCopy = async () => (await q<{ r: string[] }>(`SELECT extension_repos AS r FROM server_settings WHERE id = 1`))[0].r;
  const restoredAudits = async () =>
    Number((await q<{ n: string }>(`SELECT count(*) AS n FROM audit_log WHERE event = 'extension.repo_restored'`))[0].n);
  return { app, q, add, del, check, monitorCopy, restoredAudits };
}

const A = 'https://example.org/a/index.min.json';
const B = 'https://example.org/b/index.min.json';
const A_STORED = 'https://example.org/a/repo.json';
const B_STORED = 'https://example.org/b/repo.json';

test('adding an extension repository', { skip }, async (t) => {
  const { app, q, add, del, check, monitorCopy, restoredAudits } = await boot();
  try {
    await t.test('an Add-to-Mihon link is unwrapped, and the count is what THIS repository brought', async () => {
      // Reintroduce by handing `b.data.url` to the engine instead of parseRepoInput's url: the engine is
      // sent `mihon://add-repo?…`, yields nothing, and the 200 below becomes a 422.
      resetEngine();
      const r = await add(`mihon://add-repo?url=${encodeURIComponent(A)}`);
      assert.equal(r.statusCode, 200, r.body);
      const j = r.json();
      assert.equal(j.url, A);
      assert.equal(j.added, 2, 'the two extensions of repository a');
      assert.equal(j.corrected, false);
      assert.deepEqual(eng.repos, [A], 'the running engine lists the address as it was given');
      // Reintroduce by deleting the syncMonitorRepos call from the add: "the monitor's copy" fails, and the
      // repository is not among the ones the scheduled check restores after a wiped engine volume.
      assert.deepEqual(await monitorCopy(), [A], 'the monitor\'s copy');
    });

    await t.test('a missing https:// is added', async () => {
      const r = await add('example.org/b/index.min.json');
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().url, B);
      assert.equal(r.json().added, 1);
      assert.deepEqual(await monitorCopy(), [A, B]);
    });

    await t.test('after the engine restarts and respells them, the scheduled check leaves them alone', async () => {
      // Reintroduce by comparing `live.includes(u)` in runExtensionCheck again: the check writes
      // [a/repo.json, b/repo.json, A, B] to the engine, reposRestored names A and B, and the admins are told the
      // engine "had lost 2 repository setting(s)" -- after every restart, which on the desktop app is every launch.
      restart();
      assert.deepEqual(eng.repos, [A_STORED, B_STORED], 'the restarted engine lists its own spelling');
      eng.writes = [];
      const r = await check();
      assert.equal(r.statusCode, 200, r.body);
      assert.deepEqual(r.json().reposRestored, [], 'a respelled repository was reported as lost');
      assert.deepEqual(eng.writes, [], 'the check wrote a repository back');
      assert.deepEqual(eng.repos, [A_STORED, B_STORED], 'a duplicate was added');
      assert.equal(await restoredAudits(), 0);
      // A wiped list is still put back from our copy, once each.
      eng.repos = [];
      const w = await check();
      assert.deepEqual(w.json().reposRestored, [A, B]);
      assert.deepEqual(eng.repos, [A, B]);
      assert.equal(await restoredAudits(), 1);
      restart();
    });

    await t.test('the same repository again is a 409, however it is spelled, and nothing is written', async () => {
      // Reintroduce by comparing `current.includes(wanted)` again: the restarted engine holds a/repo.json, so
      // the pasted index.min.json is "new", gets written, yields nothing new, and this answers 422 not 409.
      eng.writes = [];
      for (const again of [A, 'HTTPS://EXAMPLE.ORG/a/', 'https://example.org/a']) {
        const r = await add(again);
        assert.equal(r.statusCode, 409, `${again}: ${r.body}`);
        assert.equal(r.json().error, 'exists');
        assert.equal(r.json().url, A_STORED, 'names the entry it matched');
      }
      assert.deepEqual(eng.writes, [], 'a duplicate reached the engine');
    });

    await t.test('a GitHub page and a non-address are refused with advice before the engine hears of them', async () => {
      // Reintroduce by removing the parseRepoInput refusal in the route: the page is written to the engine
      // (eng.writes is not empty) and the answer is a 422 after seconds of retries instead of a 400 now.
      eng.writes = [];
      const page = await add('https://github.com/owner/name');
      assert.equal(page.statusCode, 400);
      assert.equal(page.json().error, 'github_page');
      assert.match(page.json().message, /index\.min\.json link/);
      for (const bad of ['', 'myrepo', 'ftp://example.org/index.min.json', 42]) {
        const r = await add(bad);
        assert.equal(r.statusCode, 400, `${JSON.stringify(bad)}: ${r.body}`);
        assert.equal(r.json().error, 'bad_url');
        assert.match(r.json().message, /index\.min\.json/);
      }
      assert.deepEqual(eng.writes, [], 'a refused paste reached the engine');
    });

    await t.test('a broken SECOND repository is a 422 and is taken back out -- never "Added — N extensions"', async () => {
      // Reintroduce by answering `total` (the catalogue's size) as the success count, or by keeping the URL
      // when nothing arrived (drop the `setRepos(current)` in the empty branch): the status is 200, or the
      // engine's list still holds the broken address, and this fails. The catalogue also carries ORPHAN, an
      // installed extension whose repository is gone, listed obsolete as the real engine lists it; dropping
      // the `e.obsolete` skip from contributedBy's count credits it to this address and makes the status 200.
      assert.ok(eng.catalogue.some((e) => e.pkgName === ORPHAN.pkgName && e.obsolete), 'the orphan is in the catalogue, obsolete');
      const beforeRepos = [...eng.repos];
      eng.writes = [];
      const r = await add('https://example.org/broken/index.min.json');
      assert.equal(r.statusCode, 422, r.body);
      const j = r.json();
      assert.equal(j.error, 'empty');
      assert.equal(j.removed, true);
      assert.match(j.message, /not kept/);
      assert.deepEqual(eng.repos, beforeRepos, 'the broken address was left in the engine');
      // It tried what was typed and nothing else -- an index.min.json has no alternative the engine could read
      // (see altRepoUrl) -- then put the list back.
      assert.deepEqual(eng.writes, [[...beforeRepos, 'https://example.org/broken/index.min.json'], beforeRepos]);
      const audit = await q<{ detail: any }>(`SELECT detail FROM audit_log WHERE event = 'extension.repo_add_refused' ORDER BY at DESC LIMIT 1`);
      assert.equal(audit[0]?.detail?.url, 'https://example.org/broken/index.min.json');
      assert.deepEqual(await monitorCopy(), [A, B], 'the monitor copied a refused address');
    });

    await t.test('a pasted index.json is tried as the index.min.json beside it, the one index the engine reads', async () => {
      // Reintroduce by altRepoUrl mapping index.min.json → index.json (and index.json to nothing) again: the
      // engine refuses the pasted index.json in its log, there is no alternative to try, and this is a 422.
      eng.writes = [];
      const r = await add('https://example.org/c/index.json');
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().url, 'https://example.org/c/index.min.json');
      assert.equal(r.json().corrected, true);
      assert.equal(r.json().added, 1);
      assert.deepEqual(eng.writes.map((w) => w[w.length - 1]), ['https://example.org/c/index.json', 'https://example.org/c/index.min.json']);
      assert.ok(eng.repos.includes('https://example.org/c/index.min.json'));
      assert.ok(!eng.repos.includes('https://example.org/c/index.json'), 'the address that failed is not left behind');
    });

    await t.test('a bare folder gets the index.min.json inside it', async () => {
      const r = await add('https://example.org/d/');
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().url, 'https://example.org/d/index.min.json');
      assert.equal(r.json().added, 3);
    });

    await t.test('the engine refusing the write is a 502 with its reason, and the list is put back', async () => {
      // Reintroduce by taking `attempt()` out of the try: the engine's refusal escapes as a 500 `internal`
      // and the reason is lost.
      const beforeRepos = [...eng.repos];
      eng.failWrite = 'Validation errors: Invalid store URL format';
      const r = await add('https://example.org/e/index.min.json');
      eng.failWrite = '';
      assert.equal(r.statusCode, 502, r.body);
      assert.equal(r.json().error, 'engine_refused');
      assert.equal(r.json().reason, 'Validation errors: Invalid store URL format');
      assert.match(r.json().message, /refused that address: Validation errors/);
      assert.deepEqual(eng.repos, beforeRepos);
    });

    await t.test('an engine that cannot be read is a 502, and NOTHING is written', async () => {
      // Reintroduce by `getRepos().catch(() => [])` in the add: the failed read becomes "no repositories",
      // the write that follows replaces all four with the one pasted, and eng.writes is not empty.
      eng.writes = [];
      eng.failRead = true;
      const r = await add('https://example.org/f/index.min.json');
      eng.failRead = false;
      assert.deepEqual(eng.writes, [], 'a list built from a failed read was written');
      assert.equal(r.statusCode, 502, r.body);
      assert.equal(r.json().error, 'unreachable');
    });

    await t.test('removing one repository removes that one, and the scheduled check will not put it back', async () => {
      // Both of a's extensions are installed: the next subtest adds it back.
      eng.installed.set('a.one', A_STORED);
      eng.installed.set('a.two', A_STORED);
      const others = eng.repos.filter((u) => u !== A_STORED);
      // Removed by the engine's spelling while our copy holds the typed one: syncMonitorRepos drops by key.
      const r = await del(A_STORED);
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().removed, 1);
      assert.deepEqual(eng.repos, others);
      // Reintroduce by deleting the syncMonitorRepos call from the DELETE route: the monitor's copy still
      // holds A, and the scheduled check below restores it into the engine.
      assert.ok(!(await monitorCopy()).includes(A), 'the removed repository would be restored');
      assert.ok((await monitorCopy()).includes(B), 'the others stay protected');
      const c = await check();
      assert.deepEqual(c.json().reposRestored, []);
      assert.deepEqual(eng.repos, others);
    });

    await t.test('a repository added back is kept, even when every extension it offers is installed', async () => {
      // Reintroduce by letting obsolete rows into contributedBy's `seen` again: both extensions were "already
      // there" under a/repo.json, so the re-add counts 0, is taken back out with a 422, and they stay obsolete
      // -- installed, and never updated again.
      assert.ok(['a.one', 'a.two'].every((p) => eng.catalogue.find((e) => e.pkgName === p)?.obsolete), 'removed: its installed extensions are obsolete');
      const r = await add(A);
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().added, 2);
      assert.ok(eng.repos.includes(A));
      assert.ok(['a.one', 'a.two'].every((p) => eng.catalogue.find((e) => e.pkgName === p)?.obsolete === false), 'they get updates again');
      assert.ok((await monitorCopy()).includes(A));
    });

    await t.test('a remove against an engine that cannot be read writes nothing', async () => {
      // Reintroduce by `getRepos().catch(() => [])` in the DELETE: the filtered empty list is written and
      // every repository goes, not one.
      eng.writes = [];
      eng.failRead = true;
      const r = await del(B_STORED);
      eng.failRead = false;
      assert.deepEqual(eng.writes, [], 'a remove wrote a list built from a failed read');
      assert.equal(r.statusCode, 502, r.body);
      assert.ok(eng.repos.includes(B_STORED));
    });
  } finally {
    await app.close();
    await q(`UPDATE server_settings SET extension_repos = '[]' WHERE id = 1`).catch(() => {});
    await q(`DELETE FROM users WHERE username = $1`, [USER]).catch(() => {});
  }
});
