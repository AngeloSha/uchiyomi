#!/usr/bin/env node
// serveStatic.mjs <dir> <port>: the weekly canary's extension store (.github/workflows/engine-canary.yml).
//
// The engine under test adds this store and lists its one extension, so the canary exercises extension stores without
// the internet and without anybody's repository: the files are scripts/engine/fixture-store. Dependency-free; every
// request is logged (method, path, status), so the canary's artifacts show what the engine fetched.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';

const root = resolve(process.argv[2] || '.');
const port = Number(process.argv[3] || 8099);
http.createServer(async (req, res) => {
  let status = 200;
  try {
    const rel = normalize(decodeURIComponent(new URL(req.url, 'http://store').pathname)).replace(/^([/\\]+|\.\.[/\\])+/, '');
    const file = join(root, rel);
    if (!file.startsWith(root + sep)) throw new Error('outside the store');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': file.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
    res.end(body);
  } catch {
    status = 404;
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
  console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${status}`);
}).listen(port, '0.0.0.0', () => console.log(`serving ${root} on ${port}`));
