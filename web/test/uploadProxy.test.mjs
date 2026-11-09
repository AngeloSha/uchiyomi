// The published split layout must pass real chapter bodies and stream them before EOF.
// CI supplies the image built by Build Web; locally the test builds only its nginx runtime/config.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
async function docker(args, timeout = 30_000) {
  return (await exec('docker', args, { timeout, maxBuffer: 1024 * 1024 })).stdout.trim();
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bearer = 'Bearer synthetic-upload-proxy-test';
const mock = `
const http = require('node:http');
const crypto = require('node:crypto');
const records = new Map();
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  if (url.pathname === '/ready') { res.end('ready'); return; }
  if (url.pathname === '/state') { res.setHeader('content-type','application/json'); res.end(JSON.stringify(records.get(url.searchParams.get('id')) ?? null)); return; }
  const id = req.headers['x-upload-test'];
  const record = { bytes: 0, method: req.method, url: req.url, authorization: req.headers.authorization,
    host: req.headers.host, proto: req.headers['x-forwarded-proto'], ip: req.headers['x-real-ip'], forwarded: req.headers['x-forwarded-for'] };
  const hash = crypto.createHash('sha256');
  records.set(id, record);
  req.on('data', chunk => { record.bytes += chunk.length; hash.update(chunk); });
  req.on('end', () => { record.sha256 = hash.digest('hex'); res.setHeader('content-type','application/json'); res.end(JSON.stringify(record)); });
}).listen(3000, '0.0.0.0');
`;

async function until(fn, message) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { if (await fn()) return; } catch { /* the disposable server may still be starting */ }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(message);
}

function post(origin, path, id, length) {
  let resolve, reject;
  const response = new Promise((yes, no) => { resolve = yes; reject = no; });
  const req = http.request(origin + path, {
    method: 'POST',
    headers: { authorization: bearer, host: 'upload-test.local', 'content-type': 'application/octet-stream',
      'x-forwarded-proto': 'https', 'x-upload-test': id,
      ...(length === undefined ? { 'transfer-encoding': 'chunked' } : { 'content-length': length }) },
  }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    res.on('error', reject);
  });
  req.setTimeout(15_000, () => req.destroy(new Error('Upload proxy request timed out')));
  req.on('error', reject);
  void response.catch(() => {});
  return { req, response };
}

async function originOf(id, port) {
  const value = JSON.parse(await docker(['inspect', id]))[0];
  const binding = value.NetworkSettings.Ports[port + '/tcp'];
  assert.equal(binding.length, 1);
  assert.equal(binding[0].HostIp, '127.0.0.1');
  return `http://127.0.0.1:${binding[0].HostPort}`;
}

test('split nginx passes large uploads without buffering chunked requests or changing auth', { timeout: 180_000 }, async t => {
  const prefix = `uchiyomi-upload-proxy-${process.pid}-${randomBytes(4).toString('hex')}`;
  const root = await mkdtemp(join(tmpdir(), 'uchiyomi-upload-proxy-'));
  const containers = [];
  const requests = [];
  let image = process.env.TEST_UPLOAD_PROXY_IMAGE;
  let madeImage = false, madeNetwork = false;
  t.after(async () => {
    for (const req of requests) req.destroy();
    for (const id of containers.reverse()) await docker(['rm', '-f', id]).catch(() => {});
    if (madeNetwork) await docker(['network', 'rm', prefix]).catch(() => {});
    if (madeImage) await docker(['image', 'rm', image]).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  if (!image) {
    const runtime = /FROM (nginx:[^\s]+) AS runtime/.exec(await readFile(new URL('../Dockerfile', import.meta.url), 'utf8'))?.[1];
    assert.ok(runtime, 'Use the same nginx runtime as the published split image');
    await writeFile(join(root, 'nginx.conf'), await readFile(new URL('../nginx.conf', import.meta.url)));
    await writeFile(join(root, 'Dockerfile'), `FROM ${runtime}\nRUN rm /etc/nginx/conf.d/default.conf\nCOPY nginx.conf /etc/nginx/conf.d/yomi.conf\n`);
    image = prefix;
    await docker(['build', '-t', image, root], 120_000); madeImage = true;
  }
  await writeFile(join(root, 'mock.cjs'), mock);
  // One worker makes the fixture independent of the runner's CPU count. The actual shipped route config is used.
  await writeFile(join(root, 'main.conf'), 'worker_processes 1; error_log /dev/stderr notice; pid /tmp/nginx.pid; events { worker_connections 64; } http { include /etc/nginx/mime.types; default_type application/octet-stream; access_log off; include /etc/nginx/conf.d/*.conf; }\n');
  await docker(['network', 'create', prefix]); madeNetwork = true;
  const upstream = await docker(['run', '-d', '--name', prefix + '-mock', '--network', prefix,
    '--network-alias', 'yomi-bff', '--publish', '127.0.0.1::3000', '--memory', '128m', '--cpus', '1',
    '--mount', `type=bind,src=${join(root, 'mock.cjs')},dst=/mock.cjs,readonly`,
    'node:24-alpine', 'node', '/mock.cjs'], 60_000);
  containers.push(upstream);
  const upstreamOrigin = await originOf(upstream, 3000);
  await until(async () => (await fetch(upstreamOrigin + '/ready')).ok, 'The synthetic upstream did not start');
  const proxy = await docker(['run', '-d', '--name', prefix + '-nginx', '--network', prefix,
    '--publish', '127.0.0.1::80', '--memory', '128m', '--cpus', '1',
    '--mount', `type=bind,src=${join(root, 'main.conf')},dst=/test-main.conf,readonly`,
    '--entrypoint', 'nginx', image, '-c', '/test-main.conf', '-g', 'daemon off;']);
  containers.push(proxy);
  const origin = await originOf(proxy, 80);
  await until(async () => (await fetch(origin + '/healthz')).ok, 'The real nginx route config did not start');

  const bytes = randomBytes(2 * 1024 * 1024 + 123);
  const path = '/api/library/upload?fresh=1&title=Proxy%20fixture&name=1.cbz';
  const known = post(origin, path, 'known-length', bytes.length); requests.push(known.req);
  known.req.end(bytes);
  const first = await known.response;
  assert.equal(first.status, 200, first.body);
  const got = JSON.parse(first.body);
  assert.equal(got.bytes, bytes.length);
  assert.equal(got.sha256, hash(bytes));
  assert.equal(got.authorization, bearer);
  assert.equal(got.host, 'upload-test.local');
  assert.equal(got.proto, 'https');
  assert.equal(got.method, 'POST');
  assert.equal(got.url, path);
  assert.ok(got.ip && got.forwarded, 'Forward client IP headers alongside authorization');

  const streamed = post(origin, path, 'chunked'); requests.push(streamed.req);
  streamed.req.write(bytes.subarray(0, 65536));
  await until(async () => {
    const progress = await (await fetch(upstreamOrigin + '/state?id=chunked')).json();
    return progress?.bytes > 0;
  }, 'nginx buffered the chunked upload: upstream saw no bytes before the client finished');
  streamed.req.end(bytes.subarray(65536));
  const second = await streamed.response;
  assert.equal(second.status, 200, second.body);
  const complete = JSON.parse(second.body);
  assert.equal(complete.bytes, bytes.length);
  assert.equal(complete.sha256, hash(bytes));
  assert.equal(complete.authorization, bearer);

  // A control catches weakening nginx's limit globally instead of making the exact upload-route exception.
  const ordinary = post(origin, '/api/proxy-control', 'ordinary', bytes.length); requests.push(ordinary.req);
  ordinary.req.end(bytes);
  const denied = await ordinary.response;
  assert.equal(denied.status, 413, denied.body);
  assert.equal(await (await fetch(upstreamOrigin + '/state?id=ordinary')).json(), null);
});
