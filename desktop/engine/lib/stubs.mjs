// Test doubles for the spike. Both bind 127.0.0.1 only and record every request.
//
// startSolverStub: speaks the FlareSolverr v1 API (design-shell.md §3.2) under a secret path segment, the
//   way the desktop shell's real solver will: GET /<token>/ -> "FlareSolverr is ready!", POST /<token>/v1 ->
//   a solved challenge carrying a cf_clearance cookie and a fixed User-Agent.
// startFakeCloudflareSite: answers 403 + `Server: cloudflare` (exactly what Suwayomi's CloudflareInterceptor
//   checks: code in [403, 503] and Server in [cloudflare-nginx, cloudflare]) until a request carries the
//   cf_clearance cookie the stub handed out, then serves a minimal legacy extension repo.
import http from 'node:http';
import crypto from 'node:crypto';

const listen = (server) => new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
const readBody = (req) => new Promise((res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => res(Buffer.concat(c).toString('utf8'))); });

export async function startSolverStub({ clearance = crypto.randomBytes(8).toString('hex'), userAgent = 'UchiyomiSpike/1.0 (solver stub)' } = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    let json = null;
    try { json = body ? JSON.parse(body) : null; } catch { /* keep raw */ }
    requests.push({ at: Date.now(), method: req.method, url: req.url, headers: { host: req.headers.host, 'content-type': req.headers['content-type'], origin: req.headers.origin }, body: json ?? body });
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET' && (req.url === `/${token}` || req.url === `/${token}/`)) {
      return send(200, { msg: 'FlareSolverr is ready!', version: 'uchiyomi-spike-stub', userAgent });
    }
    if (req.method === 'POST' && req.url === `/${token}/v1`) {
      const now = Date.now();
      if (!json || typeof json.url !== 'string') return send(500, { status: 'error', message: 'Error: Request parameter \'url\' is mandatory in \'request.get\' command.', startTimestamp: now, endTimestamp: now, version: '3.5.2' });
      const host = new URL(json.url).hostname;
      return send(200, {
        status: 'ok', message: 'Challenge solved!',
        solution: {
          url: json.url, status: 200, headers: {},
          response: json.returnOnlyCookies ? undefined : '<html><head></head><body>stub</body></html>',
          cookies: [{ name: 'cf_clearance', value: clearance, domain: host, path: '/', expires: Math.floor(now / 1000) + 3600, size: 12 + clearance.length, httpOnly: true, secure: false, session: false, sameSite: 'Lax' }],
          userAgent,
        },
        startTimestamp: now, endTimestamp: Date.now(), version: '3.5.2',
      });
    }
    send(404, { status: 'error', message: 'not found' });
  });
  const port = await listen(server);
  return { port, token, url: `http://127.0.0.1:${port}/${token}`, requests, clearance, userAgent, close: () => new Promise((r) => server.close(r)) };
}

export async function startFakeCloudflareSite({ clearance }) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const cookie = req.headers.cookie || '';
    const cleared = cookie.split(/;\s*/).includes(`cf_clearance=${clearance}`);
    requests.push({ at: Date.now(), method: req.method, url: req.url, cookie, userAgent: req.headers['user-agent'], cleared });
    if (!cleared) {
      res.writeHead(403, { server: 'cloudflare', 'content-type': 'text/html', 'cf-ray': '0000000000000000-SPK' });
      return res.end('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div id="challenge-spinner"></div></body></html>');
    }
    res.writeHead(200, { server: 'cloudflare', 'content-type': 'application/json' });
    if (req.url.endsWith('/repo.json')) {
      return res.end(JSON.stringify({ meta: { name: 'Spike CF Repo', shortName: 'SpikeCF', website: 'https://example.invalid', signingKeyFingerprint: '00' } }));
    }
    if (req.url.endsWith('/index.min.json')) return res.end('[]');
    res.end('{}');
  });
  const port = await listen(server);
  return { port, base: `http://127.0.0.1:${port}/cf`, requests, close: () => new Promise((r) => server.close(r)) };
}
