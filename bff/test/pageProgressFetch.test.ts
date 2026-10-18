import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.DOWNLOAD_RESUME_WAIT_MS = '10,10,10';
let server: Server, base: string, attempts = 0;
const image = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/flaky.png' && attempts++ === 0) { res.writeHead(503); res.end('try later'); return; }
    res.writeHead(200, { 'content-type': 'image/png' }); res.end(image);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.SUWAYOMI_URL = base;
});
after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

async function fetchWithProgress(retry: boolean) {
  const { fetchPages } = await import('../src/lib/downloader');
  const { makeSuwayomiAdapter } = await import('../src/lib/sources/suwayomi/sources');
  const source = makeSuwayomiAdapter({ id: 'progress-test', name: 'Progress fixture', lang: 'en' });
  const urls = ['/one.png', '/flaky.png', '/three.png'].map((p) => base + p);
  const progress: number[] = [];
  attempts = 0;
  const result = await fetchPages(source, urls, [0, 1, 2], {
    chapterSourceId: 'fixture', gap: 0, workers: 3, retry, onPage: (got) => progress.push(got),
  });
  return { result, progress };
}

test('page progress counts concurrent successes only, leaving failed pages uncounted', async () => {
  const { result, progress } = await fetchWithProgress(false);
  assert.deepEqual(progress, [1, 2]);
  assert.ok(result.page[0]?.equals(image));
  assert.equal(result.page[1], null);
  assert.ok(result.page[2]?.equals(image));
});

test('page progress advances when a failed page resumes without recounting pages already in hand', async () => {
  const { result, progress } = await fetchWithProgress(true);
  assert.deepEqual(progress, [1, 2, 3]);
  assert.equal(result.failed.size, 0);
  assert.ok(result.page.every((page) => page?.equals(image)));
});
