// The browser rig's fake extension engine (test/e2e/fakeEngine.mjs) starts on its own, with nothing installed,
// and its /__mode switch does what the walks will lean on: an engine that is gone, one that is slow, and one
// that answers with the extension's own failure (issue #115) -- and back to normal without a restart.
//
// Run as the rig runs it: a separate node process, plain `node`, no tsx and no node_modules, so a stray import
// of a dependency or of TypeScript fails here before it fails inside a container.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'child_process';
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
