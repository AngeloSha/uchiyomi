// The PRODUCT smoke: the packaged app as a person meets it, driven over remote debugging with puppeteer-core
// (connect, never download a browser), on a fresh profile.
//
//   first run with a library folder (--library-dir: the non-interactive first run)
//   -> the window lands SIGNED IN on an EMPTY library, and no sign-in form ever appears
//   -> add a MangaDex series through the API with the window's own session, one chapter
//   -> the chapter downloads, and it opens in the reader (a page image actually decodes)
//   -> the extension engine installs from a locally served pack (the Extensions card's own call:
//      window.uchiyomiDesktop.engine.install()), the bff restarts once, and the Extensions panel is reachable
//   -> Quit leaves no process behind (the app, postgres, the engine's java)
//   -> a relaunch opens signed in, and starts the installed engine by itself
//
//   node scripts/ci/product-smoke.mjs            (after engine-fixture.mjs; DESKTOP_DEV=1 runs from source)
// ⚠️ MangaDex is a real site: its steps are recorded with what MangaDex answered, so a MangaDex outage reads
// as one, not as an app bug.
import puppeteer from 'puppeteer-core';
import { join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { OUT, OS_TAG, appExe, record, tmpRoot, launch, waitFor, waitHealthy, freePort, snapshot, runAsync, sleep, readJson, hardKill, isAlive, APP_EXTRA, serveFile } from './lib.mjs';

const exe = appExe();
const root = tmpRoot('product');
const libraryDir = join(`${root}-library`, 'Uchiyomi Library');
mkdirSync(`${root}-library`, { recursive: true });
// s6-keychain.mjs relaunches a REBUILT app on this same profile.
writeFileSync(join(OUT, 'product-root.txt'), root);
const results = {};
const fails = [];
const check = (name, ok, detail) => {
  results[name] = { ok, detail };
  if (!ok) fails.push(name);
  console.log(`  [${ok ? ' ok ' : 'FAIL'}] ${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 1500)}`);
};

const fixture = readJson(join(OUT, 'engine-fixture.json'));
const served = fixture ? await serveFile(fixture.file) : null;

async function start(tag, extra = []) {
  const dbg = await freePort();
  const t0 = Date.now();
  const child = launch(exe, [...APP_EXTRA, `--data-dir=${root}`, `--remote-debugging-port=${dbg}`, ...extra], { log: join(OUT, `product-${tag}-app.log`) });
  const browserURL = `http://127.0.0.1:${dbg}`;
  await waitFor(async () => (await fetch(`${browserURL}/json/version`, { signal: AbortSignal.timeout(2000) })).ok, { timeoutMs: 120_000, what: 'remote debugging port' });
  const browser = await puppeteer.connect({ browserURL, defaultViewport: null, protocolTimeout: 120_000 });
  const uiPort = await waitHealthy(root, 300_000);
  const origin = `http://127.0.0.1:${uiPort}`;
  const page = await waitFor(async () => (await browser.pages()).find((p) => p.url().startsWith(origin)), { timeoutMs: 120_000, what: 'the app page in the window' });
  return { child, browser, page, origin, t0 };
}

async function shot(page, name) {
  const file = join(OUT, `${name}-${OS_TAG}.png`);
  try {
    await Promise.race([page.screenshot({ path: file }), sleep(30_000).then(() => { throw new Error('timed out after 30 s'); })]);
  } catch (e) {
    console.log(`  (screenshot ${name} failed: ${e.message})`);
  }
}

/** Signed in, no sign-in form, not the reconnect screen -- watched for `watchMs`, not sampled once. */
async function landsSignedIn(page, watchMs = 15_000) {
  await waitFor(async () => page.evaluate(() => (document.body?.innerText || '').trim().length > 20).catch(() => false), { timeoutMs: 120_000, what: 'the app to render' });
  const seen = { passwordForm: false, reconnect: false, url: page.url() };
  const until = Date.now() + watchMs;
  while (Date.now() < until) {
    const s = await page.evaluate(() => ({
      pw: !!document.querySelector('input[type=password]'),
      // DesktopReconnect's wording (web/components/DesktopReconnect.tsx) -- the only fallback screen on desktop.
      reconnect: /couldn.t open your library/i.test(document.body?.innerText || ''),
    })).catch(() => ({ pw: false, reconnect: false }));
    seen.passwordForm ||= s.pw;
    seen.reconnect ||= s.reconnect;
    await sleep(500);
  }
  const cdp = await page.createCDPSession();
  const { cookies } = await cdp.send('Network.getAllCookies');
  await cdp.detach().catch(() => {});
  seen.cookies = cookies.filter((c) => /127\.0\.0\.1/.test(c.domain)).map((c) => c.name).sort();
  seen.bridge = await page.evaluate(() => typeof window.uchiyomiDesktop === 'object' && !!window.uchiyomiDesktop.engine);
  seen.ok = !seen.passwordForm && !seen.reconnect && seen.cookies.includes('yomi_rt') && seen.cookies.includes('yomi_img') && seen.bridge;
  return seen;
}

/** The window's own session: the same exchange the web app makes (the shell adds the secret below the page). */
async function tokenFrom(page) {
  return page.evaluate(async () => {
    const r = await fetch('/auth/desktop', { method: 'POST', credentials: 'include' });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, token: j.accessToken || '', user: j.user?.username, role: j.user?.role };
  });
}

async function api(origin, token, path, init = {}) {
  const r = await fetch(`${origin}${path}`, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}`, ...(init.headers || {}) }, signal: AbortSignal.timeout(120_000) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text: text.slice(0, 500) };
}

/**
 * How many times the shell's secret has been exchanged for a session (login.desktop audit rows) -- counted with
 * an exchange of our own, which is one of them. See the relaunch check for why.
 */
async function desktopLogins(page, origin) {
  const tok = (await tokenFrom(page).catch(() => ({}))).token;
  if (!tok) return null;
  const a = await api(origin, tok, '/api/admin/audit?limit=500').catch(() => null);
  return Array.isArray(a?.json?.content) ? a.json.content.filter((r) => r.event === 'login.desktop').length : null;
}

async function quitApp() {
  const before = snapshot(root).list;
  const t0 = Date.now();
  const q = await runAsync(exe, [...APP_EXTRA, '--quit-for-update', `--data-dir=${root}`], { timeoutMs: 150_000 });
  await sleep(3000);
  const left = before.filter((p) => isAlive(p.pid));
  return { exit: q.code, ms: Date.now() - t0, before: before.map((p) => `${p.role}:${p.name}`), left: left.map((p) => ({ pid: p.pid, role: p.role, name: p.name })) };
}

let run1;
try {
  // ---------------------------------------------------------------- first run
  const packArgs = served ? [`--engine-pack-url=${served.url}`, `--engine-pack-sha256=${fixture.sha256}`] : [];
  run1 = await start('first', [`--library-dir=${libraryDir}`, ...packArgs]);
  const { page, origin } = run1;
  // The PWA's first visit: the service worker installs, claims the page, and web/app/providers.tsx reloads once.
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 60_000 }).catch(() => {});
  await sleep(2500);
  // Reintroduce by not installing the sign-in header hook (main.js installSignIn): the window lands on
  // "Uchiyomi couldn't open your library" with no cookies, and this check says so.
  const landed = await landsSignedIn(page);
  await shot(page, 'product-first');
  check('first run lands signed in, no sign-in form', landed.ok, landed);
  check('the library folder is the one chosen', readJson(join(root, 'state.json'))?.libraryDir === libraryDir && existsSync(libraryDir), { state: readJson(join(root, 'state.json'))?.libraryDir, libraryDir });

  const session = await tokenFrom(page);
  const me = session.token ? await api(origin, session.token, '/auth/me') : { status: 0 };
  check('the window session is the local admin', session.status === 200 && me.status === 200 && me.json?.role === 'admin', { exchange: session.status, me: me.status, user: session.user, role: me.json?.role });
  const lib = await api(origin, session.token, '/api/series/search', { method: 'POST', body: '{}' });
  check('the library starts empty', lib.status === 200 && (lib.json?.totalElements ?? lib.json?.content?.length) === 0, { status: lib.status, total: lib.json?.totalElements });

  // ---------------------------------------------------------------- a MangaDex series, one chapter
  // Candidates from MangaDex's own "latest updates" (a chapter just uploaded is hosted there; the OLDEST
  // chapter of a popular title is often a licensed external link the bff rightly refuses), then a search.
  // Each is added with one chapter; a job that ends in an error is dismissed and the next one tried.
  const candidates = [];
  const lat = await api(origin, session.token, '/api/sources/latest?source=mangadex&page=1');
  for (const r of (lat.json?.content || []).slice(0, 6)) candidates.push(r);
  for (const q of ['Solo Leveling', 'Dandadan']) {
    const sr = await api(origin, session.token, `/api/sources/search?source=mangadex&q=${encodeURIComponent(q)}`);
    for (const r of (sr.json?.content || []).slice(0, 2)) candidates.push(r);
  }
  const tried = [{ latest: lat.status, candidates: candidates.length }];
  let job = null;
  let added = null;
  const budget = Date.now() + 8 * 60_000;
  for (const c of candidates) {
    if (Date.now() > budget) break;
    const a = await api(origin, session.token, '/api/sources/add', { method: 'POST', body: JSON.stringify({ source: 'mangadex', sourceId: c.sourceId, chapterCount: 1, chapterFrom: 'newest', autoUpdate: false }) });
    const t = { title: c.title, add: a.status, answer: a.json };
    tried.push(t);
    if (!(a.status === 200 && a.json?.ok && a.json.started)) continue;
    const t0 = Date.now();
    job = null;
    while (Date.now() - t0 < 4 * 60_000) {
      const j = await api(origin, session.token, '/api/sources/jobs');
      job = (j.json?.content || []).find((x) => x.folder === a.json.folder) || null;
      if (job && ((job.status === 'done' && job.seriesId) || job.status === 'error')) break;
      await sleep(3000);
    }
    t.job = job && { status: job.status, done: job.done, total: job.total, reason: job.reason, seriesId: job.seriesId, secs: Math.round((Date.now() - t0) / 1000) };
    if (job?.status === 'done' && job.done >= 1 && job.seriesId) { added = { title: a.json.title, folder: a.json.folder }; break; }
    await api(origin, session.token, `/api/sources/jobs/${encodeURIComponent(a.json.folder)}`, { method: 'DELETE' }).catch(() => {});
  }
  check('a MangaDex series is added and its chapter downloads (the window session, the chosen folder)', !!added, { added, tried });
  let book = null;
  if (added) {
    const books = await api(origin, session.token, `/api/series/${job.seriesId}/books?size=10`);
    book = books.json?.content?.[0] || null;
    const files = (() => { try { return readdirSync(join(libraryDir, ...added.folder.split('/'))); } catch { return []; } })();
    check('the chapter file is in the library folder chosen on first run', files.length > 0, { dir: join(libraryDir, ...added.folder.split('/')), files });
  }
  if (book) {
    await page.goto(`${origin}/reader/?book=${encodeURIComponent(book.id)}`, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
    // web/lib/api.ts img.page(): /img/books/<id>/page/<n>
    const img = await page.waitForFunction(() => [...document.images].find((i) => /\/img\/books\/[^/]+\/page\/\d+/.test(i.currentSrc || i.src) && i.complete && i.naturalWidth > 0)?.naturalWidth || 0, { timeout: 90_000 }).then((h) => h.jsonValue()).catch(() => 0);
    await sleep(1500);
    await shot(page, 'product-reader');
    check('the chapter opens in the reader (a page image decodes)', img > 0, { book: book.id, naturalWidth: img, url: page.url() });
  } else if (added) {
    check('the chapter opens in the reader (a page image decodes)', false, 'no book to open');
  }

  // ---------------------------------------------------------------- the extension engine, on first use
  if (served) {
    await page.goto(`${origin}/admin/?tab=Extensions`, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
    await sleep(3000);
    await shot(page, 'product-extensions-before');
    const t0 = Date.now();
    // Exactly the call the Extensions card makes, with its progress feed.
    const outcome = await page.evaluate(() => new Promise((resolve) => {
      const states = [];
      const off = window.uchiyomiDesktop.engine.onStatus((s) => { if (states[states.length - 1] !== s.state) states.push(s.state); });
      window.uchiyomiDesktop.engine.install().then(() => { off(); resolve({ ok: true, states }); }, (e) => { off(); resolve({ ok: false, error: String(e?.message || e), states }); });
    }));
    const status = await page.evaluate(() => window.uchiyomiDesktop.engine.status());
    check('the engine downloads, verifies, installs and starts from the bridge', outcome.ok && status.state === 'running', { outcome, status, ms: Date.now() - t0, pack: fixture.source });
    // The bff restarts once; then the panel's own first question must be answered "reachable".
    let ext = null;
    const until = Date.now() + 120_000;
    while (Date.now() < until) {
      const tok = (await tokenFrom(page).catch(() => ({}))).token;
      ext = tok ? await api(origin, tok, '/api/admin/extensions/status').catch((e) => ({ error: String(e) })) : null;
      if (ext?.json?.reachable) break;
      await sleep(3000);
    }
    await page.goto(`${origin}/admin/?tab=Extensions`, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
    await sleep(5000);
    await shot(page, 'product-extensions-after');
    const offer = await page.evaluate(() => /Download the extension engine/i.test(document.body?.innerText || '')).catch(() => null);
    check('the Extensions panel is reachable (the engine answers the bff)', !!ext?.json?.reachable && offer === false, { status: ext?.json, downloadOfferStillShown: offer });
  } else {
    check('the engine downloads, verifies, installs and starts from the bridge', false, 'no engine fixture (run scripts/ci/engine-fixture.mjs first)');
  }

  // ---------------------------------------------------------------- quit, relaunch
  // Our own exchange here also ROTATES the window's refresh cookie seconds before Quit -- exactly the spike's S8
  // trap (a rotation the cookie store had not written yet), so the count below tests quit()'s flush.
  const loginsBefore = await desktopLogins(page, origin).catch(() => null);
  await run1.browser.disconnect();
  const q = await quitApp();
  check('Quit stops every process (app, postgres, engine)', q.exit === 0 && q.left.length === 0 && q.before.some((x) => /postgres/.test(x)), q);

  const run2 = await start('relaunch');
  const again = await landsSignedIn(run2.page, 10_000);
  await shot(run2.page, 'product-relaunch');
  check('the relaunch opens signed in', again.ok, again);
  // ⚠️ "Opens signed in" passes whether or not the cookies survived: the window signs itself in with the shell's
  // secret either way. What tells them apart is whether it had to -- a login.desktop row (and a 60-day refresh
  // row) per launch. The spike's S8 found the cookies lost on windows-latest and macos-15-intel and Linux keeps
  // them; INFO until Windows and macOS have been seen passing it, so it records rather than gates.
  const loginsAfter = await desktopLogins(run2.page, run2.origin).catch(() => null);
  const reExchanged = loginsBefore === null || loginsAfter === null ? null : loginsAfter - loginsBefore - 1;
  record('P-relaunch-cookies', 'INFO',
    reExchanged === null ? `could not count login.desktop rows (before ${loginsBefore}, after ${loginsAfter})`
      : reExchanged === 0 ? 'the relaunch reused the session cookie: no new sign-in exchange (quit() flushed the rotated cookie)'
        : `the relaunch signed in AGAIN with the shell's secret (${reExchanged} extra login.desktop row${reExchanged === 1 ? '' : 's'}): the cookies did not survive the restart, so every launch adds a 60-day refresh row`,
    { loginsBefore, loginsAfter, reExchanged, cookiesAfterRelaunch: again.cookies });
  if (served) {
    const st = await waitFor(async () => {
      const s = await run2.page.evaluate(() => window.uchiyomiDesktop.engine.status()).catch(() => null);
      return s?.state === 'running' || s?.state === 'failed' ? s : null;
    }, { timeoutMs: 180_000, what: 'the installed engine to start' }).catch((e) => ({ error: String(e) }));
    check('the installed engine starts by itself on the next launch', st?.state === 'running', st);
  }
  await run2.browser.disconnect();
  const q2 = await quitApp();
  check('Quit again leaves nothing running', q2.exit === 0 && q2.left.length === 0, q2);
} catch (e) {
  fails.push(`error: ${e.message}`);
  results.error = String(e.stack || e);
  console.log(results.error);
  try {
    const left = snapshot(root).list;
    await runAsync(exe, [...APP_EXTRA, '--quit-for-update', `--data-dir=${root}`], { timeoutMs: 150_000 });
    await sleep(2000);
    hardKill(left.map((p) => p.pid).filter(isAlive));
  } catch { /* best effort */ }
} finally {
  served?.close();
}

for (const f of ['desktop.log', 'bff.log', 'engine.log', 'postgres.log']) {
  try { writeFileSync(join(OUT, `product-${f}`), readFileSync(join(root, 'logs', f))); } catch { /* not there */ }
}
record('P-product-smoke', fails.length ? 'FAIL' : 'PASS',
  fails.length ? `failed: ${fails.join('; ')}` : 'first run -> signed in on an empty library, no sign-in form -> MangaDex chapter downloaded and read -> engine installed from the bridge, Extensions reachable -> Quit left nothing -> relaunch signed in, engine up',
  results);
