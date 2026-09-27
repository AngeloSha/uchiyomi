// The browser rig's fake source (test/e2e/fakeSource.mjs): #116's Istrevelia-shaped series is there only when
// `--extra v49` asks for it, and without the flag the stub serves exactly what the earlier walks were written
// against.
//
// Run as the rig runs it: a separate node process, plain `node`, no tsx and no node_modules, so a stray import
// of a dependency or of TypeScript fails here before it fails inside a container.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { createServer } from 'net';
import { join } from 'path';

const SCRIPT = join(__dirname, 'e2e', 'fakeSource.mjs');

/** A port nobody holds right now: the stub takes a fixed --port and refuses 0. */
const freePort = () => new Promise<number>((resolve, reject) => {
  const srv = createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address() as { port: number };
    srv.close(() => resolve(port));
  });
});

async function withStub(extra: string, fn: (base: string) => Promise<void>) {
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, '--name', 'fake-a', '--port', String(port), '--extra', extra], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise<void>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`the fake source did not start: ${out}`)), 10_000);
      child.stdout!.on('data', (c) => {
        out += c;
        if (/listening on/.test(out)) { clearTimeout(timer); resolve(); }
      });
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`the fake source exited (${code}): ${out}`)); });
    });
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    child.kill('SIGTERM');
  }
}
const get = async (url: string) => { const r = await fetch(url); return { status: r.status, body: await r.json() }; };

test('--extra v49 serves an Istrevelia-shaped series: 226 posts on 13 numbers, each with its posting order', async () => {
  // Reintroduce by dropping the `s?.posts` branch in the /chapters route: the series lists 226 NUMBERS
  // (1..226, one post each) and the 13-numbers assertion fails.
  await withStub('v42,v49', async (base) => {
    const found = (await get(`${base}/search?q=walk`)).body.map((s: { sourceId: string }) => s.sourceId);
    assert.ok(found.includes('walk-istrevelia'), found.join());
    assert.ok(found.includes('walk-quote'), 'extras combine: v42 is still there');
    const { status, body } = await get(`${base}/chapters/walk-istrevelia`);
    assert.equal(status, 200);
    assert.equal(body.length, 226);
    assert.equal(new Set(body.map((c: { number: number }) => c.number)).size, 13);
    assert.deepEqual(body.map((c: { order: number }) => c.order), Array.from({ length: 226 }, (_, i) => i + 1));
    assert.deepEqual(body[0], {
      sourceId: 'walk-istrevelia-1', number: 1, title: 'Episode 1 - Page1  (ch. 1)', order: 1,
      publishedAt: body[0].publishedAt, pages: 12, lang: 'en',
    });
    assert.ok(Date.parse(body[0].publishedAt) < Date.parse(body[225].publishedAt), 'dated oldest first');
    // A post id reaches its pages and images like any chapter id.
    const pages = await get(`${base}/pages/walk-istrevelia-200`);
    assert.equal(pages.body.length, 12);
    assert.equal((await fetch(pages.body[0])).status, 200);
    assert.equal((await fetch(`${base}/pages/walk-istrevelia-227`)).status, 404);
  });
});

test('without the flag the stub is what the earlier walks know: no new series, no order on chapters', async () => {
  // Reintroduce by gating the series on something always true: it shows up in search and this fails.
  await withStub('none', async (base) => {
    const found = (await get(`${base}/search?q=walk`)).body.map((s: { sourceId: string }) => s.sourceId);
    assert.deepEqual(found, ['walk-tale', 'walk-gap']);
    assert.equal((await fetch(`${base}/chapters/walk-istrevelia`)).status, 404);
    const tale = (await get(`${base}/chapters/walk-tale`)).body;
    assert.equal(tale.length, 12);
    assert.deepEqual(tale[0], { sourceId: 'walk-tale-1', number: 1, title: 'Chapter 1', pages: 12, lang: 'en' });
  });
});
