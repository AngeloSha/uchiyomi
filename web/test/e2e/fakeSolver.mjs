#!/usr/bin/env node
// Dependency-free fake Cloudflare solver for the browser walks (v0.55.3, the backup solver): FlareSolverr's /v1, as
// FlareSolverr, trawl and Byparr all speak it, with a switch to stop answering.
//
//   node web/test/e2e/fakeSolver.mjs --name main --port 8191 [--greeting trawl|flaresolverr] [--version 1.7.0]
//
// In the rig it runs like the fake sources, with the repository mounted, on the instance's network (up.sh
// E2E_SOLVERS=1 starts two: the main greeting as trawl, the backup as FlareSolverr), and the app gets
// FLARESOLVERR_URL / FLARESOLVERR_FALLBACK_URL=http://<container>:8191.
//
//   GET  /         its greeting, as each solver words it: {"msg":"TRAWL is ready!","version":"1.7.0"} or
//                  {"msg":"FlareSolverr is ready!","version":"3.5.2"} -- what Health names the solver by.
//   GET  /health   {"status":"ok"}, trawl's (and Byparr's) own.
//   POST /v1       {cmd: request.get | request.post, url, postData?}: the solver fetches `url` itself, with the
//                  cf_clearance it "earned" (its --name) and its browser's user agent ("<name>-browser/1.0"), and answers
//                  the page as it came -- raw, as trawl does -- with that cookie and user agent in the solution, for the
//                  app's own image fetches to send (downloader.ts cfSession). A fetch that fails is FlareSolverr's
//                  error envelope, HTTP 500.
// Control (never part of a solver's API):
//   POST /__mode {"mode":"down"}   every request but these four is dropped unanswered: a container that has stopped
//                                  answering ("fetch failed" to the app, "Not answering" on Health)
//   POST /__mode {"mode":"up"}     answer again
//   GET  /__mode, GET /__log (every /v1 request: cmd, url, outcome), POST /__reset (the log cleared, mode up)
import http from 'node:http';

const argv = new Map();
for (let i = 2; i < process.argv.length; i += 2) argv.set(process.argv[i], process.argv[i + 1]);
const NAME = argv.get('--name') || 'main';
const PORT = Number(argv.get('--port') || 8191);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error(`bad --port ${PORT}`);
const GREETING = argv.get('--greeting') || 'flaresolverr';
if (!['trawl', 'flaresolverr'].includes(GREETING)) throw new Error(`bad --greeting ${GREETING}; trawl or flaresolverr`);
const VERSION = argv.get('--version') || (GREETING === 'trawl' ? '1.7.0' : '3.5.2');
const UA = `${NAME}-browser/1.0`;

let mode = 'up';
const log = [];

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}
async function bodyOf(req) {
  const parts = [];
  for await (const part of req) parts.push(part);
  return parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {};
}
/** FlareSolverr's envelope, for a page or for its failure. */
const envelope = (status, message, solution) => ({
  status, message, solution, startTimestamp: Date.now(), endTimestamp: Date.now(), version: VERSION,
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://solver');
    if (url.pathname === '/__mode') {
      if (req.method === 'POST') {
        const m = String((await bodyOf(req)).mode ?? '');
        if (!['up', 'down'].includes(m)) return sendJson(res, 400, { error: 'mode is up or down' });
        mode = m;
      }
      return sendJson(res, 200, { name: NAME, mode });
    }
    if (url.pathname === '/__log') return sendJson(res, 200, { name: NAME, content: log });
    if (url.pathname === '/__reset' && req.method === 'POST') { log.length = 0; mode = 'up'; return sendJson(res, 200, { ok: true, name: NAME }); }

    if (req.method === 'POST' && url.pathname === '/v1') {
      const body = await bodyOf(req);
      const row = { at: Date.now(), cmd: body.cmd, url: body.url, outcome: mode === 'down' ? 'dropped' : null };
      log.push(row);
      // Down: no answer at all, as a stopped container gives none.
      if (mode === 'down') { req.socket.destroy(); return; }
      if (body.cmd !== 'request.get' && body.cmd !== 'request.post') {
        row.outcome = 'bad_cmd';
        return sendJson(res, 500, envelope('error', `Error: Request parameter 'cmd' = '${body.cmd}' is invalid.`, null));
      }
      try {
        const r = await fetch(String(body.url), {
          method: body.cmd === 'request.post' ? 'POST' : 'GET',
          headers: { cookie: `cf_clearance=${NAME}`, 'user-agent': UA, ...(body.cmd === 'request.post' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
          body: body.cmd === 'request.post' ? String(body.postData ?? '') : undefined,
          signal: AbortSignal.timeout(20_000),
        });
        const text = await r.text();
        row.outcome = r.status;
        return sendJson(res, 200, envelope('ok', 'Challenge solved!', {
          url: String(body.url), status: r.status, headers: {}, response: text,
          cookies: [{ name: 'cf_clearance', value: NAME, domain: new URL(String(body.url)).hostname, path: '/' }],
          userAgent: UA,
        }));
      } catch (e) {
        row.outcome = 'failed';
        return sendJson(res, 500, envelope('error', `Error: Error solving the challenge. ${e?.message || e}`, null));
      }
    }

    if (mode === 'down') { req.socket.destroy(); return; }
    if (req.method === 'GET' && url.pathname === '/') {
      return sendJson(res, 200, { msg: GREETING === 'trawl' ? 'TRAWL is ready!' : 'FlareSolverr is ready!', version: VERSION, userAgent: UA });
    }
    if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { status: 'ok', uptime: 1 });
    return sendJson(res, 404, { error: 'not_found' });
  } catch (error) {
    console.error('[fake-solver] request failed', error);
    sendJson(res, 500, { error: 'solver_error' });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`[fake-solver] ${NAME} (${GREETING} ${VERSION}) listening on ${PORT}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
