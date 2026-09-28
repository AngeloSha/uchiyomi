// The browser rig's fake extension engine (test/e2e/fakeEngine.mjs) starts on its own, with nothing installed,
// and its /__mode switch does what the walks will lean on: an engine that is gone, one that is slow, and one
// that answers with the extension's own failure (issue #115) -- and back to normal without a restart.
//
// Run as the rig runs it: a separate node process, plain `node`, no tsx and no node_modules, so a stray import
// of a dependency or of TypeScript fails here before it fails inside a container.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const SCRIPT = join(__dirname, 'e2e', 'fakeEngine.mjs');
let child: ChildProcess;
let base = '';

before(async () => {
  child = spawn(process.execPath, [SCRIPT, '--port', '0', '--host', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'inherit'] });
  base = await new Promise<string>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`the fake engine did not start: ${out}`)), 10_000);
    child.stdout!.on('data', (c) => {
      out += c;
      const m = /listening on (\d+)/.exec(out);
      if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`the fake engine exited (${code}): ${out}`)); });
  });
});
after(() => { child.kill('SIGTERM'); });

const gql = (query: string, variables: Record<string, unknown> = {}) =>
  fetch(`${base}/api/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
const mode = (body: unknown) => fetch(`${base}/__mode`, { method: 'POST', body: JSON.stringify(body) });
const ABOUT = '{ aboutServer { name version } }';
const SEARCH = 'mutation($s:LongString!){ fetchSourceManga(input:{source:$s,type:SEARCH,query:"ball",page:1}){ mangas { title } } }';

test('the rig\'s engine answers as v2.3.2243, and refuses a field the real one does not have', async () => {
  const ok = await (await gql(ABOUT)).json();
  assert.deepEqual(ok, { data: { aboutServer: { name: 'Suwayomi-Server', version: 'v2.3.2243' } } });
  const bad = await (await gql('{ aboutServer { name codename } }')).json();
  assert.equal(bad.data, undefined);
  assert.match(bad.errors[0].message, /^Validation error \(FieldUndefined@\[aboutServer\/codename\]\)/);
});

test('/__mode switches down, slow and extension_error, and up brings it back', async () => {
  // down: the request is dropped, the way a caller sees an engine that is not there. Reintroduce by answering
  // POST /__mode without switching (fakeSuwayomiEngine.mjs, `json(res, 200, mode)` instead of setMode(body)):
  // "Missing expected rejection" here, and a bad mode is no longer a 400.
  assert.equal((await mode({ mode: 'down' })).status, 200);
  await assert.rejects(gql(ABOUT), /fetch failed/);
  assert.equal((await mode({ mode: 'up' })).status, 200);
  assert.equal((await gql(ABOUT)).status, 200);

  // slow: answered, late.
  await mode({ mode: 'slow', ms: 300 });
  const t0 = Date.now();
  assert.equal((await gql(ABOUT)).status, 200);
  assert.ok(Date.now() - t0 >= 250, `answered after ${Date.now() - t0} ms`);

  // extension_error, narrowed to one source and stage: the engine answers with the extension's exception.
  const log = await (await fetch(`${base}/__log`)).json();
  const sources = await (await gql('{ sources { nodes { id displayName } } }')).json();
  const ball = sources.data.sources.nodes.find((s: { displayName: string }) => s.displayName === 'Manga Ball (EN)');
  assert.ok(ball, 'the seed carries #115\'s source');
  await mode({ mode: 'extension_error', source: ball.id, stage: 'search' });
  const failed = await (await gql(SEARCH, { s: ball.id })).json();
  assert.deepEqual(failed.data, { fetchSourceManga: null });
  assert.match(failed.errors[0].message, /^Exception while fetching data \(\/fetchSourceManga\) : java\.lang\.Exception\r\n/);
  await mode({ mode: 'up' });
  const fine = await (await gql(SEARCH, { s: ball.id })).json();
  assert.deepEqual(fine.data.fetchSourceManga.mangas, [{ title: 'Ball Runner' }]);
  assert.ok(log.content.some((r: { status?: string }) => r.status === 'dropped'), 'the log records the dropped request');
});

test('a bad /__mode is refused with the choices, and /__reset restores the seed', async () => {
  const r = await mode({ mode: 'sideways' });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.deepEqual(j.modes, ['up', 'down', 'slow', 'extension_error']);
  assert.deepEqual(j.stages, ['search', 'manga', 'chapters', 'pages', 'images']);
  assert.equal((await mode({ mode: 'extension_error', stage: 'everything' })).status, 400);
  await mode({ mode: 'down' });
  assert.equal((await fetch(`${base}/__reset`, { method: 'POST' })).status, 200);
  assert.deepEqual(await (await fetch(`${base}/__mode`)).json(), { mode: 'up' });
  assert.equal((await gql(ABOUT)).status, 200);
});

test('up.sh starts the engine on a port no other instance of the rig uses, and walk49 looks for it there', () => {
  // Parallel lanes run instances side by side, one E2E_PORT each. The engine's port used to be FAKE_B_PORT + 1, which
  // is the NEXT app port's fake-a port: an instance with the engine kept the one on PORT+1 from binding its first
  // fake source. Reintroduce by deriving ENGINE_PORT from FAKE_B_PORT again: "... collides with ..." names both.
  const e2e = (f: string) => readFileSync(join(__dirname, 'e2e', f), 'utf8');
  const sh = e2e('up.sh');
  const lines = ['PORT', 'FAKE_A_PORT', 'FAKE_B_PORT', 'ENGINE_PORT'].map((v) => {
    const m = new RegExp(`^${v}=.*$`, 'm').exec(sh);
    assert.ok(m, `up.sh no longer sets ${v} on a line of its own`);
    return m[0];
  });
  // up.sh's own lines, run by bash for every app port (the rig keys every port on PORT % 1000), with the E2E_*_PORT
  // overrides emptied: `${X:-default}` then takes the default, as it does when they are unset.
  const unset = { E2E_FAKE_A_PORT: '', E2E_FAKE_B_PORT: '', E2E_ENGINE_PORT: '' };
  const rows = execFileSync('bash', ['-c', `for E2E_PORT in $(seq 18000 18999); do ${lines.join('; ')}; echo "$PORT $FAKE_A_PORT $FAKE_B_PORT $ENGINE_PORT"; done`],
    { encoding: 'utf8', env: { ...process.env, ...unset } }).trim().split('\n').map((l) => l.split(' ').map(Number));
  assert.equal(rows.length, 1000);
  // walk43's webhook listener takes a port per instance too.
  const hook = /const HOOK_PORT = Number\(process\.env\.HOOK_PORT \|\| ([\d_]+) \+ \(appPort % 1000\)\);/.exec(e2e('walk43.mjs'));
  assert.ok(hook, 'walk43.mjs derives its webhook port some other way now: read it here');
  const hookBase = Number(hook[1].replace(/_/g, ''));
  const held = new Map<number, string>();
  for (const [p, a, b] of rows) {
    held.set(a, `${p}'s fake-a`);
    held.set(b, `${p}'s fake-b`);
    held.set(hookBase + (p % 1000), `${p}'s walk43 webhook listener`);
  }
  const engines = new Set<number>();
  for (const [p, , , e] of rows) {
    assert.ok(!held.has(e), `${p}'s engine port ${e} collides with ${held.get(e)}`);
    assert.ok(!engines.has(e), `two instances put their engine on ${e}`);
    engines.add(e);
  }
  // walk49's numbering phase works the engine's port out from the app's by itself: it must land where up.sh put it.
  const w49 =/const ENGINE = process\.env\.ENGINE \|\| `http:\/\/127\.0\.0\.1:\$\{([\d_]+) \+ \(APP_PORT % 1000\)\}`;/.exec(e2e('walk49.mjs'));
  assert.ok(w49, 'walk49.mjs derives the engine port some other way now: read it here');
  const w49Base = Number(w49[1].replace(/_/g, ''));
  for (const [p, , , e] of rows) assert.equal(w49Base + (p % 1000), e, `walk49 looks for ${p}'s engine on ${w49Base + (p % 1000)}, up.sh starts it on ${e}`);
});
