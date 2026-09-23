// The solver with a REAL browser: Electron, hidden windows, against a local fixture site that behaves like the
// pages the bff meets (a Cloudflare-style interstitial that clears after a JS timer, a Turnstile-style box that
// needs a trusted click, an access-denied page, a JSON API, an empty-body POST).
//
// Runs under Electron itself (it needs BrowserWindow), with its own tiny runner:
//   cd desktop-spike-solver && npm run build && xvfb-run -a electron dist/desktop/test/solver.electron.test.js
// Prints one ✔/✖ line per check plus MEASURE lines, and exits non-zero on any failure.
import { app } from 'electron';
import http from 'node:http';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { startSolverServer, type SolverServer } from '../src/solver/server';
import { ElectronSolverBackend, type SolveDetail } from '../src/solver/browser';
import { MSG } from '../src/solver/protocol';

app.on('window-all-closed', () => { /* keep running */ });
app.dock?.hide();

const TOKEN = 'e1ec7e0e1ec7e0e1ec7e0e1ec7e0e1ec';
const hits: Array<{ method: string; path: string; ct?: string; len: number; cookie?: string }> = [];
let clickLog: Array<{ trusted: boolean; x: number; y: number }> = [];
let oopifHit = false;

// ---- the fixture site ----------------------------------------------------------------------------------
function fixture(): Promise<http.Server> {
  const s = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const path = (req.url || '/').split('?')[0];
      hits.push({ method: req.method!, path, ct: req.headers['content-type'], len: body.length, cookie: req.headers.cookie });
      const cookies = String(req.headers.cookie || '');
      const html = (status: number, title: string, bodyHtml: string, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
        res.end(`<!doctype html><html><head><title>${title}</title></head><body>${bodyHtml}</body></html>`);
      };
      switch (path) {
        case '/plain': return html(200, 'Plain', '<p id="x">hello</p>');
        case '/json':
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ success: true, data: { chapters: [{ chapter_name: 'A & <b> "q"', chapter_slug: 'chapter-1', chapter_num: 1 }], pagination: { has_more: false } } }));
        case '/echo': return html(200, 'Echo', `<pre id="m">${req.method} ${req.headers['content-type'] || '-'} ${body.length} [${body.toString()}]</pre>`);
        case '/echo-cookies': return html(200, 'Cookies', `<pre id="c">${cookies}</pre>`);
        case '/challenge':
          if (/cf_clearance=ok/.test(cookies)) return html(200, 'Solved page', '<p>real content</p>');
          // A Cloudflare-shaped interstitial: 403, "Just a moment...", clears itself after 2.5 s of JS timers.
          return html(403, 'Just a moment...', `<div id="challenge-spinner"></div><script>
            setTimeout(() => { document.cookie = 'cf_clearance=ok; path=/; max-age=3600'; location.reload(); }, 2500);
          </script>`);
        case '/turnstile':
          if (/ts_ok=1/.test(cookies)) return html(200, 'Through', '<p>through</p>');
          // Only a TRUSTED click on the box clears it, like the managed challenge's checkbox.
          return html(403, 'Just a moment...', `<div style="margin:120px 0 0 200px;width:300px;height:65px;background:#eee" id="box">
              <input type="hidden" name="cf-turnstile-response" value=""></div><script>
            document.getElementById('box').addEventListener('click', (e) => {
              fetch('/click-log?trusted=' + e.isTrusted + '&x=' + e.clientX + '&y=' + e.clientY).then(() => {
                if (e.isTrusted) { document.cookie = 'ts_ok=1; path=/'; location.reload(); }
              });
            });</script>`);
        case '/oopif':
          if (/oopif_ok=1/.test(cookies)) return html(200, 'Through the iframe', '<p>through the iframe</p>');
          // Cloudflare's shape: the checkbox lives in a CROSS-SITE iframe (challenges.cloudflare.com there;
          // localhost vs 127.0.0.1 here), which site isolation puts in another renderer process.
          return html(403, 'Just a moment...', `<div style="margin:120px 0 0 200px;width:300px;height:65px"><iframe src="${String(req.headers.host).startsWith('127.0.0.1') ? 'http://localhost' : 'http://127.0.0.1'}:${String(req.headers.host).split(':')[1]}/oopif-box" style="width:300px;height:65px;border:0"></iframe>
              <input type="hidden" name="cf-turnstile-response" value=""></div><script>
            setInterval(() => fetch('/oopif-state').then((r) => r.text()).then((t) => { if (t === 'ok') { document.cookie = 'oopif_ok=1; path=/'; location.reload(); } }), 300);
          </script>`);
        case '/oopif-box':
          return html(200, 'box', `<label style="display:block;padding:20px"><input type="checkbox" id="cb"> Verify you are human</label><script>
            document.getElementById('cb').addEventListener('change', (e) => { if (e.isTrusted) fetch('/oopif-hit'); });
          </script>`);
        case '/oopif-hit': oopifHit = true; res.writeHead(204); return res.end();
        case '/oopif-state': res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(oopifHit ? 'ok' : 'no');
        case '/click-log': {
          const q = new URL(req.url!, 'http://x').searchParams;
          clickLog.push({ trusted: q.get('trusted') === 'true', x: Number(q.get('x')), y: Number(q.get('y')) });
          res.writeHead(204); return res.end();
        }
        case '/forever': return html(403, 'Just a moment...', '<div id="challenge-spinner"></div>');
        case '/denied': return html(403, 'Access denied | fixture used Cloudflare to restrict access', '<div class="cf-error-title"></div>');
        case '/notfound': return html(404, 'Not here', '<p>404 page</p>');
        case '/popup': return html(200, 'Popup', `<script>window.__opened = !!window.open('/plain');</script>`);
        case '/throttle':
          // How a hidden window schedules work: timer drift and animation frames over one second.
          return html(200, 'Throttle', `<pre id="r">pending</pre><script>
            const t0 = performance.now(); let n = 0, raf = 0;
            (function tick() { n++; if (performance.now() - t0 < 1000) setTimeout(tick, 10); else done(); })();
            (function frame() { raf++; if (performance.now() - t0 < 1000) requestAnimationFrame(frame); })();
            function done() { document.getElementById('r').textContent = JSON.stringify({ timers: n, rafs: raf, visibility: document.visibilityState, hidden: document.hidden }); document.title = 'Throttle done'; }
          </script>`);
        default: res.writeHead(404); res.end('nope');
      }
    });
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}

// ---- runner ----------------------------------------------------------------------------------------------
const results: Array<{ name: string; ok: boolean; err?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); console.log(`✔ ${name}`); } catch (e) {
    results.push({ name, ok: false, err: String((e as Error)?.stack || e) });
    console.log(`✖ ${name}\n  ${String((e as Error)?.message || e).split('\n').join('\n  ')}`);
  }
}
const measure = (k: string, v: unknown) => console.log(`MEASURE ${k} ${JSON.stringify(v)}`);

app.whenReady().then(async () => {
  const site = await fixture();
  const S = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const protectedPorts: number[] = [];
  const details: SolveDetail[] = [];
  const logs: Array<{ event: string; data?: Record<string, unknown> }> = [];
  const backend = new ElectronSolverBackend({
    blockAllLoopback: false, protectedPorts, humanCheck: 'log', clickAfterMs: 1000, clickEveryMs: 1500, showAfterMs: 2000,
    windowMode: process.env.SOLVER_WINDOW_MODE === 'offscreen' ? 'offscreen' : 'hidden',
    onSolveDetail: (d) => details.push(d), log: (event, data) => logs.push({ event, data }),
  });
  const srv: SolverServer = await startSolverServer({ backend, token: TOKEN, appVersion: 'test' });
  protectedPorts.push(srv.port);
  const solve = async (body: Record<string, unknown>) => {
    const r = await fetch(`${srv.url}/v1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxTimeout: 20000, ...body }) });
    return { status: r.status, origin: r.headers.get('x-origin-status'), j: (await r.json()) as any };
  };
  const lastDetail = () => details[details.length - 1];
  const legacy = new ElectronSolverBackend({ blockAllLoopback: false, protectedPorts, humanCheck: 'log', clickAfterMs: 1000, clickEveryMs: 1500, inputVia: 'sendInputEvent' });
  const legacySrv = await startSolverServer({ backend: legacy, token: TOKEN, appVersion: 'test' });
  protectedPorts.push(legacySrv.port);
  const backend2 = () => legacySrv;
  measure('platform', { platform: process.platform, arch: process.arch, electron: process.versions.electron, chrome: process.versions.chrome, mode: process.env.SOLVER_WINDOW_MODE || 'hidden' });

  await check('GET a plain page: "Challenge not detected!", outerHTML, status 200', async () => {
    const r = await solve({ cmd: 'request.get', url: `${S}/plain` });
    assert.equal(r.status, 200);
    assert.equal(r.j.message, MSG.notDetected);
    assert.equal(r.origin, '200');
    assert.match(r.j.solution.response, /^<html><head><title>Plain<\/title><\/head><body><p id="x">hello<\/p><\/body><\/html>$/);
    assert.equal(r.j.solution.url, `${S}/plain`);
  });

  await check('JSON comes back inside the browser\'s <pre>, and manganato.ts:105-106 parses it', async () => {
    const r = await solve({ cmd: 'request.get', url: `${S}/json` });
    const raw: string = r.j.solution.response;
    measure('json-wrapper', raw.replace(/<pre>[\s\S]*<\/pre>/, '<pre>…</pre>'));
    // manganato.ts:13-15 + :105-106, verbatim logic
    const unescapeHtml = (s: string) => s.replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const body = (raw.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i) || [, raw])[1] || '';
    const data = JSON.parse(unescapeHtml(body).trim())?.data;
    assert.equal(data.chapters[0].chapter_name, 'A & <b> "q"');
  });

  await check('POST with postData "" is a real POST with an empty form body (madara.ts:181)', async () => {
    hits.length = 0;
    const r = await solve({ cmd: 'request.post', url: `${S}/echo`, postData: '' });
    assert.equal(r.status, 200);
    const h = hits.find((x) => x.path === '/echo')!;
    assert.equal(h.method, 'POST');
    assert.equal(h.len, 0);
    assert.equal(h.ct, 'application/x-www-form-urlencoded');
    assert.match(r.j.solution.response, /POST application\/x-www-form-urlencoded 0 \[\]/);
  });

  await check('POST with a form body arrives byte-for-byte', async () => {
    hits.length = 0;
    await solve({ cmd: 'request.post', url: `${S}/echo`, postData: 'action=manga_get_chapters&manga=123' });
    const h = hits.find((x) => x.path === '/echo')!;
    assert.equal(h.len, 'action=manga_get_chapters&manga=123'.length);
  });

  await check('a challenge that clears by JS timers solves in a HIDDEN window; cf_clearance returned', async () => {
    const r = await solve({ cmd: 'request.get', url: `${S}/challenge` });
    const d = lastDetail();
    measure('fixture-challenge', { solveMs: d.solveMs, totalMs: d.totalMs, statuses: d.statuses });
    assert.equal(r.j.message, MSG.solved);
    assert.equal(r.origin, '200');
    assert.deepEqual(d.statuses, [403, 200]);
    assert.ok(r.j.solution.cookies.some((c: any) => c.name === 'cf_clearance' && c.value === 'ok'));
    assert.match(r.j.solution.response, /real content/);
    // 2.5 s timer + two 500 ms looks. A throttled hidden window would be ~1 minute.
    assert.ok(d.solveMs < 6000, `solve took ${d.solveMs} ms`);
  });

  await check('the SAME origin again reuses cf_clearance: no challenge the second time', async () => {
    const r = await solve({ cmd: 'request.get', url: `${S}/challenge` });
    assert.equal(r.j.message, MSG.notDetected);
    assert.deepEqual(lastDetail().statuses, [200]);
  });

  await check('a same-origin Turnstile-style box: a TRUSTED click in a hidden window gets through', async () => {
    clickLog = [];
    const r = await solve({ cmd: 'request.get', url: `${S}/turnstile` });
    measure('fixture-turnstile', { clicks: clickLog, solveMs: lastDetail().solveMs, clicked: lastDetail().clicked });
    assert.equal(r.j.message, MSG.solved);
    assert.equal(clickLog.length, 1);
    assert.equal(clickLog[0].trusted, true);
    assert.match(r.j.solution.response, /through/);
  });

  await check('a checkbox in a CROSS-SITE iframe (Turnstile\'s real shape) gets the trusted input (DevTools Input, not sendInputEvent)', async () => {
    oopifHit = false;
    const r = await solve({ cmd: 'request.get', url: `${S}/oopif` });
    const d = lastDetail();
    measure('fixture-oopif', { solveMs: d.solveMs, attempts: d.verifyAttempts, via: 'cdp' });
    assert.equal(r.j.message, MSG.solved);
    assert.equal(oopifHit, true);
  });

  await check('control: webContents.sendInputEvent never reaches that cross-site iframe (why the design had to change)', async () => {
    oopifHit = false;
    const old = backend2();
    const r = await fetch(`${old.url}/v1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: 'request.get', url: `${S.replace('127.0.0.1', 'localhost')}/oopif`, maxTimeout: 6000 }) });
    const j: any = await r.json();
    measure('fixture-oopif-sendInputEvent', { status: r.status, message: j.message, hit: oopifHit });
    assert.equal(r.status, 500);
    assert.equal(oopifHit, false);
  });

  await check('a challenge that never clears: FlareSolverr\'s timeout wording, click tried, window WOULD be shown', async () => {
    logs.length = 0;
    // Another host name for the same fixture: the turnstile check above already used 127.0.0.1's one prompt
    // per 30 minutes (humanCheck's throttle), which is exactly what the throttle is for.
    const r = await solve({ cmd: 'request.get', url: `${S.replace('127.0.0.1', 'localhost')}/forever`, maxTimeout: 3500 });
    assert.equal(r.status, 500);
    assert.equal(r.j.message, 'Error: Error solving the challenge. Timeout after 3.5 seconds.');
    const d = lastDetail();
    assert.equal(d.clicked, true);
    assert.equal(d.wouldShow, true);
    assert.ok(logs.some((l) => l.event === 'would-show-window'));
  });

  await check('an access-denied page is FlareSolverr\'s "blocked" error at once', async () => {
    const t = Date.now();
    const r = await solve({ cmd: 'request.get', url: `${S}/denied` });
    assert.equal(r.status, 500);
    assert.equal(r.j.message, `Error: Error solving the challenge. ${MSG.blocked}`);
    assert.ok(Date.now() - t < 5000);
  });

  await check('an origin 404 is solution.status 200 with X-Origin-Status 404 (FlareSolverr parity)', async () => {
    const r = await solve({ cmd: 'request.get', url: `${S}/notfound` });
    assert.equal(r.j.solution.status, 200);
    assert.equal(r.origin, '404');
  });

  await check('request cookies are sent on the FIRST load', async () => {
    const r = await solve({ cmd: 'request.get', url: `${S}/echo-cookies`, cookies: [{ name: 'PHPSESSID', value: 'abc' }, { name: 'theme', value: 'dark' }] });
    assert.match(r.j.solution.response, /PHPSESSID=abc/);
    assert.match(r.j.solution.response, /theme=dark/);
  });

  await check('returnOnlyCookies omits the body; cookies keep FlareSolverr\'s shape', async () => {
    const r = await solve({ cmd: 'request.get', url: `${S}/challenge`, returnOnlyCookies: true, session: 'suwayomi', session_ttl_minutes: 15 });
    assert.equal(r.j.solution.response, undefined);
    assert.equal(r.j.solution.headers, undefined);
    const c = r.j.solution.cookies.find((x: any) => x.name === 'cf_clearance');
    assert.ok(c, 'cf_clearance');
    assert.deepEqual(Object.keys(c), ['name', 'value', 'domain', 'path', 'expires', 'size', 'httpOnly', 'secure', 'session', 'sameSite']);
    assert.equal(c.domain, '127.0.0.1');
    assert.ok(c.expires > Date.now() / 1000);
    assert.equal(c.session, false);
  });

  await check('a named session is its own jar (fs-s:*), listed and destroyable', async () => {
    let r = await solve({ cmd: 'sessions.list' });
    assert.ok(r.j.sessions.includes('suwayomi'));
    assert.equal(lastDetail().partition, 'fs-s:suwayomi');
    r = await solve({ cmd: 'sessions.destroy', session: 'suwayomi' });
    assert.equal(r.j.message, MSG.sessionRemoved);
    r = await solve({ cmd: 'sessions.list' });
    assert.ok(!r.j.sessions.includes('suwayomi'));
  });

  await check('popups are denied', async () => {
    const r = await solve({ cmd: 'request.get', url: `${S}/popup` });
    assert.equal(r.status, 200);
    assert.equal(backend.stats().windows <= 5, true);
  });

  await check("the hidden browser cannot reach the solver's own port", async () => {
    const r = await solve({ cmd: 'request.get', url: `${srv.url}/` });
    assert.equal(r.status, 500);
    assert.match(r.j.message, /net::ERR_BLOCKED_BY_CLIENT/);
  });

  await check('hidden-window scheduling (S4 evidence): timers unthrottled', async () => {
    const r = await solve({ cmd: 'request.get', url: `${S}/throttle`, waitInSeconds: 2 });
    const m = JSON.parse((r.j.solution.response.match(/<pre id="r">([^<]*)<\/pre>/) || [])[1]);
    measure('hidden-window-scheduling', m);
    // setTimeout(10) chained for 1 s: ~100 unthrottled, 1 under Chromium's background throttle (one wake-up a
    // second), fewer still under intensive throttling. macOS CI measured 50 (timer coalescing), Linux 101.
    assert.ok(m.timers > 10, `only ${m.timers} timer ticks in 1 s: the hidden window is being throttled`);
  });

  await check('concurrency: 4 solves at once each get their own window', async () => {
    const t = Date.now();
    const rs = await Promise.all([1, 2, 3, 4].map((i) => solve({ cmd: 'request.get', url: `${S}/plain?i=${i}` })));
    assert.ok(rs.every((r) => r.status === 200));
    measure('four-parallel-ms', Date.now() - t);
    assert.ok(backend.stats().windows <= 5);
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  await srv.close();
  await legacySrv.close();
  await backend.shutdown();
  await legacy.shutdown();
  site.close();
  app.exit(failed.length ? 1 : 0);
});
