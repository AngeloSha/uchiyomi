// Adding an extension repository (v0.45.0): what a paste becomes, and what the route keeps.
//
// The route is driven over HTTP against a FAKE engine -- a real HTTP server on loopback speaking the GraphQL
// operations the routes use, shaped the way Suwayomi-Server answers them -- so the real transport, the real audit
// rows and the real scheduled check run, and no repository on the internet (or the live engine) is ever touched.
//
// Since the engine upgrade a repository is one of the engine's extension STORES, added and removed one at a time
// (addExtensionStore / removeExtensionStore / extensionStores), and this fake models what was measured on throwaway
// v2.3.2243 and v2.4.2366 engines with a fixture store on a network of their own (2026-10-14), identical on both:
//
//   * an add reads the index there and then, and answers the store or the engine's error: a list-shaped index is read
//     only at an address ending in /index.min.json ("Provided legacy store url is not valid" anywhere else, an
//     index.json say), a missing one is "HTTP error 404" -- each as the add's own error, `{data: {addExtensionStore:
//     null}}` with "Exception while fetching data (/addExtensionStore) : …";
//   * it stores and answers its OWN spelling of the address (the repo.json beside a pasted index.min.json), from the
//     start -- not only after a restart, as the deprecated `extensionRepos` setting did -- and the next
//     fetchExtensions lists its extensions at once: nothing is applied later;
//   * adding a store it holds changes nothing; a remove matches the address exactly, and one it does not hold answers
//     `extensionStore: null`, with no error;
//   * an installed extension that no store offers stays listed, installed and OBSOLETE under its old address, and turns
//     non-obsolete when a store offering it is added again.
//
// ⚠️ The first version of this fake (for the setting) swapped the stored spelling in on the next refresh, served an
// index.json as a working repository and never marked anything obsolete. All its tests passed while the candidate had
// three real bugs, each hidden by one of those differences. Keep it measured.
//
// Each refusal is checked for what it says AND for what it did to the engine: a refused paste must reach the engine
// not at all, and a repository that yields nothing must not be left in the engine.
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

/** What "the internet" serves at each address: the store the engine makes of it, and the extensions it lists. */
const NET: Record<string, { stored: string; exts: string[] }> = {
  'https://example.org/a/index.min.json': { stored: 'https://example.org/a/repo.json', exts: ['a.one', 'a.two'] },
  'https://example.org/b/index.min.json': { stored: 'https://example.org/b/repo.json', exts: ['b.one'] },
  // c's folder also serves the full index.json, listing the same extension -- which the engine refuses
  'https://example.org/c/index.min.json': { stored: 'https://example.org/c/repo.json', exts: ['c.one'] },
  // a folder pasted bare: the alternative is the index.min.json inside it
  'https://example.org/d/index.min.json': { stored: 'https://example.org/d/repo.json', exts: ['d.one', 'd.two', 'd.three'] },
  // a store that lists nothing
  'https://example.org/empty/index.min.json': { stored: 'https://example.org/empty/repo.json', exts: [] },
  // an index whose store is a's under another address (an index that names another, as repo.json's index_v2 does)
  'https://mirror.example/a/index.min.json': { stored: 'https://example.org/a/repo.json', exts: ['a.one', 'a.two'] },
};
const LIST_SHAPED = new Set(['https://example.org/c/index.json']);
/** The engine's add, as measured: the store it makes of an address, or the error it answers. */
function fetchStore(u: string): { stored: string; exts: string[] } | { error: string } {
  if (LIST_SHAPED.has(u)) return { error: 'Provided legacy store url is not valid' };
  const hit = NET[u] ?? Object.values(NET).find((n) => n.stored === u);
  return hit ?? { error: 'HTTP error 404' };
}
const offeredBy = (stored: string) => Object.values(NET).find((n) => n.stored === stored)?.exts ?? [];
/** An extension installed from a repository removed long ago: the engine keeps its row and its old address. */
const ORPHAN = { pkgName: 'gone.one', repo: 'https://example.org/gone/repo.json' };

type Row = { pkgName: string; repo: string; installed: boolean; obsolete: boolean };
const eng = {
  stores: [] as string[],
  catalogue: [] as Row[],
  /** Installed extensions, each with the address it was last offered under. */
  installed: new Map<string, string>(),
  /** Every change made to the stores, in order: ['add', what was asked] or ['remove', the address given]. */
  writes: [] as string[][],
  failRead: false,
  /** An engine with no stores at all (older than v2.3.2243): the add is refused by its schema. */
  noStores: false,
};
function resetEngine() {
  eng.stores = [];
  eng.installed = new Map([[ORPHAN.pkgName, ORPHAN.repo]]);
  eng.writes = [];
  eng.failRead = false;
  eng.noStores = false;
  refresh();
}
function refresh() {
  const offered: Row[] = [];
  for (const u of eng.stores) {
    for (const p of offeredBy(u)) {
      if (offered.some((e) => e.pkgName === p)) continue;
      if (eng.installed.has(p)) eng.installed.set(p, u);
      offered.push({ pkgName: p, repo: u, installed: eng.installed.has(p), obsolete: false });
    }
  }
  const orphans = [...eng.installed].filter(([p]) => !offered.some((e) => e.pkgName === p))
    .map(([pkgName, repo]) => ({ pkgName, repo, installed: true, obsolete: true }));
  eng.catalogue = [...offered, ...orphans];
}

let engine: Server;
before(async () => {
  engine = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { query, variables } = JSON.parse(body || '{}') as { query: string; variables: Record<string, unknown> };
      const send = (status: number, j: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      const fetcherError = (field: string, msg: string) => send(200, {
        data: { [field]: null },
        errors: [{ message: `Exception while fetching data (/${field}) : ${msg}\r\n\r\njava.lang.Exception: ${msg}\n\tat suwayomi.tachidesk.X(X.kt:1)`, path: [field] }],
      });
      if (/addExtensionStore/.test(query)) {
        const u = String(variables.indexUrl);
        eng.writes.push(['add', u]);
        if (eng.noStores) {
          return send(200, { errors: [{ message: "Validation error (FieldUndefined@[addExtensionStore]) : Field 'addExtensionStore' in type 'Mutation' is undefined", extensions: {} }] });
        }
        const got = fetchStore(u);
        if ('error' in got) return fetcherError('addExtensionStore', got.error);
        if (!eng.stores.includes(got.stored)) eng.stores.push(got.stored);
        return send(200, { data: { addExtensionStore: { extensionStore: { indexUrl: got.stored, name: new URL(got.stored).host } } } });
      }
      if (/removeExtensionStore/.test(query)) {
        const u = String(variables.indexUrl);
        eng.writes.push(['remove', u]);
        const held = eng.stores.includes(u);
        eng.stores = eng.stores.filter((x) => x !== u);
        return send(200, { data: { removeExtensionStore: { extensionStore: held ? { indexUrl: u } : null } } });
      }
      if (/fetchExtensions/.test(query)) {
        refresh();
        return send(200, { data: { fetchExtensions: { extensions: eng.catalogue.map((e) => ({ pkgName: e.pkgName })) } } });
      }
      if (/extensionStores/.test(query)) {
        if (eng.failRead) return send(500, { errors: [{ message: 'down' }] });
        return send(200, { data: { extensionStores: { nodes: eng.stores.map((indexUrl) => ({ indexUrl, name: new URL(indexUrl).host })) } } });
      }
      if (/extensions\s*\{\s*nodes/.test(query)) {
        return send(200, { data: { extensions: { nodes: eng.catalogue.map((e) => ({
          pkgName: e.pkgName, name: e.pkgName, lang: 'en', versionName: '1.0', iconUrl: null,
          isInstalled: e.installed, hasUpdate: false, isObsolete: e.obsolete, contentWarning: 'SAFE', storeIndexUrl: e.repo,
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
      // sent `mihon://add-repo?…`, cannot read it, and the 200 below becomes a 422.
      resetEngine();
      const r = await add(`mihon://add-repo?url=${encodeURIComponent(A)}`);
      assert.equal(r.statusCode, 200, r.body);
      const j = r.json();
      assert.equal(j.url, A);
      assert.equal(j.added, 2, 'the two extensions of repository a');
      assert.equal(j.corrected, false);
      assert.deepEqual(eng.stores, [A_STORED], 'the engine holds its own spelling of the address from the start');
      assert.deepEqual(eng.writes, [['add', A]], 'one add, nothing taken back out');
      // Reintroduce by deleting the syncMonitorRepos call from the add: "the monitor's copy" fails, and the
      // repository is not among the ones the scheduled check restores after a wiped engine volume.
      assert.deepEqual(await monitorCopy(), [A_STORED], 'the monitor\'s copy, as the engine spells it');
    });

    await t.test('a missing https:// is added', async () => {
      const r = await add('example.org/b/index.min.json');
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().url, B);
      assert.equal(r.json().added, 1);
      assert.deepEqual(await monitorCopy(), [A_STORED, B_STORED]);
    });

    await t.test('the scheduled check leaves the engine\'s spelling alone, and puts a wiped list back once each', async () => {
      // Reintroduce by comparing `live.includes(u)` in runExtensionCheck again: with our copy holding what was typed,
      // the check adds A and B back as duplicates, reposRestored names them, and the admins are told the engine "had
      // lost 2 repository setting(s)" -- after every restart, which on the desktop app is every launch.
      await q(`UPDATE server_settings SET extension_repos = $1::jsonb WHERE id = 1`, [JSON.stringify([A, B])]);
      eng.writes = [];
      const r = await check();
      assert.equal(r.statusCode, 200, r.body);
      assert.deepEqual(r.json().reposRestored, [], 'a respelled repository was reported as lost');
      assert.deepEqual(eng.writes, [], 'the check wrote a repository back');
      assert.deepEqual(eng.stores, [A_STORED, B_STORED], 'a duplicate was added');
      assert.equal(await restoredAudits(), 0);
      // A wiped engine is put back from our copy, once each, as the engine spells them.
      eng.stores = [];
      const w = await check();
      assert.deepEqual(w.json().reposRestored, [A, B]);
      assert.deepEqual(eng.stores, [A_STORED, B_STORED]);
      assert.equal(await restoredAudits(), 1);
      await q(`UPDATE server_settings SET extension_repos = $1::jsonb WHERE id = 1`, [JSON.stringify([A_STORED, B_STORED])]);
    });

    await t.test('the same repository again is a 409, however it is spelled, and nothing is written', async () => {
      // Reintroduce by comparing `current.includes(wanted)` again: the engine holds a/repo.json, so the pasted
      // index.min.json is "new", gets added, yields nothing new, and this answers 422 not 409.
      eng.writes = [];
      for (const again of [A, 'HTTPS://EXAMPLE.ORG/a/', 'https://example.org/a']) {
        const r = await add(again);
        assert.equal(r.statusCode, 409, `${again}: ${r.body}`);
        assert.equal(r.json().error, 'exists');
        assert.equal(r.json().url, A_STORED, 'names the entry it matched');
      }
      assert.deepEqual(eng.writes, [], 'a duplicate reached the engine');
    });

    await t.test('an address that turns out to be a store already added is a 409, and that store stays', async () => {
      // The engine can only tell once it has read the index: this one names a's store under another address. Taking
      // "it" back out for adding nothing new would remove a. Reintroduce by dropping the `held` check in the route's
      // attempt(): the answer is a 422 and a/repo.json is removed.
      eng.writes = [];
      const r = await add('https://mirror.example/a/index.min.json');
      assert.equal(r.statusCode, 409, r.body);
      assert.equal(r.json().url, A_STORED);
      assert.ok(eng.stores.includes(A_STORED), 'the store it already had was removed');
      assert.deepEqual(eng.writes, [['add', 'https://mirror.example/a/index.min.json']], 'nothing was taken back out');
    });

    await t.test('a GitHub page and a non-address are refused with advice before the engine hears of them', async () => {
      // Reintroduce by removing the parseRepoInput refusal in the route: the page is sent to the engine
      // (eng.writes is not empty) and the answer is a 422 instead of a 400 now.
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

    await t.test('a broken SECOND repository is a 422 that says why in the engine\'s words -- never "Added — N extensions"', async () => {
      // Reintroduce by answering `total` (the catalogue's size) as the success count: the status is 200. Reintroduce
      // engineReason's prefix strip alone: "a refused add says why in the engine's words" -- the reason is a Java stack
      // trace. The catalogue also carries ORPHAN, an installed extension whose repository is gone, listed obsolete as
      // the real engine lists it.
      assert.ok(eng.catalogue.some((e) => e.pkgName === ORPHAN.pkgName && e.obsolete), 'the orphan is in the catalogue, obsolete');
      const before = [...eng.stores];
      eng.writes = [];
      const r = await add('https://example.org/broken/index.min.json');
      assert.equal(r.statusCode, 422, r.body);
      const j = r.json();
      assert.equal(j.error, 'empty');
      assert.equal(j.removed, true);
      assert.equal(j.reason, 'HTTP error 404', "a refused add says why in the engine's words");
      assert.match(j.message, /not kept\. .* The engine said: HTTP error 404$/);
      assert.deepEqual(eng.stores, before, 'the broken address was left in the engine');
      // It tried what was typed and nothing else -- an index.min.json has no alternative (see altRepoUrl).
      assert.deepEqual(eng.writes, [['add', 'https://example.org/broken/index.min.json']]);
      const audit = await q<{ detail: any }>(`SELECT detail FROM audit_log WHERE event = 'extension.repo_add_refused' ORDER BY at DESC LIMIT 1`);
      assert.equal(audit[0]?.detail?.url, 'https://example.org/broken/index.min.json');
      assert.deepEqual(await monitorCopy(), [A_STORED, B_STORED], 'the monitor copied a refused address');
    });

    await t.test('a store that lists nothing new is taken back out, by the address the engine answered', async () => {
      // Reintroduce by removing by what was typed (`removeRepo(url)`): the engine matches exactly, holds empty/repo.json
      // and not empty/index.min.json, removes nothing, and the empty store stays.
      const before = [...eng.stores];
      eng.writes = [];
      const r = await add('https://example.org/empty/index.min.json');
      assert.equal(r.statusCode, 422, r.body);
      assert.equal(r.json().removed, true);
      assert.deepEqual(eng.stores, before, 'the empty store was left in the engine');
      assert.deepEqual(eng.writes, [['add', 'https://example.org/empty/index.min.json'], ['remove', 'https://example.org/empty/repo.json']]);
    });

    await t.test('an address the engine cannot read is tried the other way: a pasted index.json as its index.min.json', async () => {
      // The engine refuses a list-shaped index anywhere but at …/index.min.json, as the add's own error. Reintroduce by
      // letting that refusal throw out of attempt(): the answer is a 502 and the index.min.json is never tried.
      eng.writes = [];
      const r = await add('https://example.org/c/index.json');
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().url, 'https://example.org/c/index.min.json');
      assert.equal(r.json().corrected, true);
      assert.equal(r.json().added, 1);
      assert.deepEqual(eng.writes, [['add', 'https://example.org/c/index.json'], ['add', 'https://example.org/c/index.min.json']]);
      assert.ok(eng.stores.includes('https://example.org/c/repo.json'));
    });

    await t.test('a bare folder gets the index.min.json inside it', async () => {
      const r = await add('https://example.org/d/');
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().url, 'https://example.org/d/index.min.json');
      assert.equal(r.json().added, 3);
    });

    await t.test('an engine with no stores refuses the add itself: a 502 with its reason, and nothing changed', async () => {
      // An engine older than v2.3.2243 has no addExtensionStore; its refusal is the query's, not the address's
      // (client.ts EngineRefusedError). Reintroduce by counting every `suwayomi: ` error as the address's: the answer is
      // a 422 "that address gave no extensions" for an engine that cannot add any address at all.
      const before = [...eng.stores];
      eng.noStores = true;
      const r = await add('https://example.org/e/index.min.json');
      eng.noStores = false;
      assert.equal(r.statusCode, 502, r.body);
      assert.equal(r.json().error, 'engine_refused');
      assert.match(r.json().reason, /^Validation error \(FieldUndefined@\[addExtensionStore\]\)/);
      assert.match(r.json().message, /refused that address: Validation error/);
      assert.deepEqual(eng.stores, before);
    });

    await t.test('an engine that cannot be read is a 502, and NOTHING is written', async () => {
      // Reintroduce by `getRepos().catch(() => [])` in the add: the failed read becomes "no repositories", and the
      // add goes ahead as if nothing were there.
      eng.writes = [];
      eng.failRead = true;
      const r = await add('https://example.org/f/index.min.json');
      eng.failRead = false;
      assert.deepEqual(eng.writes, [], 'an add went ahead on a failed read');
      assert.equal(r.statusCode, 502, r.body);
      assert.equal(r.json().error, 'unreachable');
    });

    await t.test('removing one repository removes that one, and the scheduled check will not put it back', async () => {
      // Both of a's extensions are installed: the next subtest adds it back.
      eng.installed.set('a.one', A_STORED);
      eng.installed.set('a.two', A_STORED);
      const others = eng.stores.filter((u) => u !== A_STORED);
      // Removed by what was typed while the engine holds its own spelling: by key, every spelling of it goes.
      const r = await del(A);
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().removed, 1);
      assert.deepEqual(eng.stores, others);
      // Reintroduce by deleting the syncMonitorRepos call from the DELETE route: the monitor's copy still
      // holds a, and the scheduled check below restores it into the engine.
      assert.ok(!(await monitorCopy()).includes(A_STORED), 'the removed repository would be restored');
      assert.ok((await monitorCopy()).includes(B_STORED), 'the others stay protected');
      const c = await check();
      assert.deepEqual(c.json().reposRestored, []);
      assert.deepEqual(eng.stores, others);
    });

    await t.test('a repository added back is kept, even when every extension it offers is installed', async () => {
      // Reintroduce by letting obsolete rows into contributedBy's `seen` again: both extensions were "already
      // there" under a/repo.json, so the re-add counts 0, is taken back out with a 422, and they stay obsolete
      // -- installed, and never updated again.
      assert.ok(['a.one', 'a.two'].every((p) => eng.catalogue.find((e) => e.pkgName === p)?.obsolete), 'removed: its installed extensions are obsolete');
      const r = await add(A);
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().added, 2);
      assert.ok(eng.stores.includes(A_STORED));
      assert.ok(['a.one', 'a.two'].every((p) => eng.catalogue.find((e) => e.pkgName === p)?.obsolete === false), 'they get updates again');
      assert.ok((await monitorCopy()).includes(A_STORED));
    });

    await t.test('a remove against an engine that cannot be read writes nothing', async () => {
      // Reintroduce by `getRepos().catch(() => [])` in the DELETE: nothing matches an empty list, the answer is a 200
      // with removed 0, and the admin is told it went.
      eng.writes = [];
      eng.failRead = true;
      const r = await del(B_STORED);
      eng.failRead = false;
      assert.deepEqual(eng.writes, [], 'a remove went ahead on a failed read');
      assert.equal(r.statusCode, 502, r.body);
      assert.ok(eng.stores.includes(B_STORED));
    });
  } finally {
    await app.close();
    await q(`UPDATE server_settings SET extension_repos = '[]' WHERE id = 1`).catch(() => {});
    await q(`DELETE FROM users WHERE username = $1`, [USER]).catch(() => {});
  }
});
