// Disposable transport fixture, not a substitute for the Uchiyomi + iPhone acceptance run.
import http from 'node:http';
import { createHash } from 'node:crypto';

const routes = ['/index.html', '/downloads/index.html', '/reader/index.html', '/index.txt', '/downloads/index.txt', '/reader/index.txt', '/_next/static/reader.js'];
const assets = new Map(routes.map(path => [path, Buffer.from(`fixture ${path}`)]));
const manifest = {
  schemaVersion: 1, protocolVersion: 1, offlineSchemaVersion: 2,
  buildId: 'a'.repeat(64), files: [...assets].map(([path, data]) => ({
    path, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), contentType: 'text/plain',
  })),
};
let mode = 'good';
const stats = { streaming: 0, completed: 0, redirectHits: 0, slowLogin: false };
const server = http.createServer(async (req, res) => {
  const parts = [];
  for await (const part of req) parts.push(part);
  if (req.url === '/__stats') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(stats)); return; }
  if (req.url === '/api/stream') {
    res.setHeader('Content-Type', 'application/octet-stream');
    stats.streaming++;
    let count = 0;
    const interval = setInterval(() => {
      res.write(Buffer.alloc(65536, count++ % 256));
      if (count === 32) { stats.completed++; clearInterval(interval); res.end(); }
    }, 20);
    res.on('close', () => { stats.streaming--; clearInterval(interval); });
    return;
  }
  if (req.url === '/auth/slow-login') {
    stats.slowLogin = true;
    setTimeout(() => { res.setHeader('Set-Cookie', 'late_refresh=must-not-survive; Path=/'); res.end('{}'); }, 300);
    return;
  }
  if (req.url === '/api/truncated') { res.writeHead(200, {'Content-Length': 100000}); res.write(Buffer.alloc(100)); setTimeout(() => res.destroy(), 30); return; }
  if (req.url === '/caught') stats.redirectHits++;
  if (req.url === '/__server-down') { mode = 'server-down'; res.end('ok'); return; }
  if (req.url === '/__incompatible') { mode = 'incompatible'; res.end('ok'); return; }
  if (req.url === '/auth/config') {
    if (req.headers.cookie || req.headers.authorization) { res.writeHead(400); res.end('Unexpected credentials'); return; }
    if (mode === 'server-down') { res.writeHead(502, {'Content-Type': 'text/html'}); res.end('This App is Down'); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({mode: mode === 'incompatible' ? 'oidc-only' : 'local'})); return;
  }
  if (req.url === '/__bad-hash') { mode = 'bad-hash'; res.end('ok'); return; }
  if (req.url === '/mobile-assets.json') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(manifest)); return;
  }
  if (assets.has(req.url)) { res.end(mode === 'bad-hash' ? 'tampered' : assets.get(req.url)); return; }
  if (req.url === '/redirect') { res.writeHead(302, { Location: `http://localhost:${server.address().port}/caught` }); res.end(); return; }
  if (req.url === '/auth/login') res.setHeader('Set-Cookie', ['fixture_refresh=session-secret; HttpOnly; Path=/', 'fixture_image=image-secret; HttpOnly; Path=/img']);
  if (req.url === '/auth/rejected') { res.writeHead(401); res.end('{}'); return; }
  if (req.url === '/img/chapter') { res.setHeader('Content-Type', 'application/octet-stream'); res.end(Buffer.from([0, 255, 1, 128])); return; }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ headers: req.headers, body: Buffer.concat(parts).toString('utf8') }));
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`${server.address().port}\n`));
