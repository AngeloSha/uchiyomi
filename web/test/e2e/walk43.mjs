// Browser acceptance walk for v0.43.0 — Reduce effects (#71), marks on chapters the server never fetched
// (#69), and notification targets beyond web push (#70).
//
// Needs an instance of its OWN and an explicit BASE, like the v0.41 and v0.42 walks, and it also needs the
// instance's docker network name: the webhook listener for step 4 is a throwaway container on that network,
// because a process on the host is not reachable from the app container on every host (this one's firewall
// drops it). The walk starts the listener and removes it again.
//
//   KEEP=1 E2E_NET=uchiyomi-e2e-43 E2E_PORT=18143 E2E_SUBNET=10.222.3.0/24 bash web/test/e2e/up.sh
//   cd web && WIDTH=1440 E2E_NET=uchiyomi-e2e-43 BASE=http://127.0.0.1:18143 npm run test:e2e:v043
//   … then again with WIDTH=390, on another fresh instance.
//
// It adds Walk Tale and runs a sweep that fetches the rest of it, so it cannot share a database with walk40,
// walk41 or walk42 any more than those can share one with each other.
//
// What to know before editing it:
//   * ⚠️ The owner's rule for #71 is that the DEFAULT look does not change, so step 1 asserts the three
//     cinematic layers with v0.42.0's computed styles while the switch is off, and step 2 asserts a frame
//     rate floor ONLY with the switch on. The default scrolls at about 40 fps at a 4x throttle by design;
//     a floor there would be a test that asks for the look to be taken away. Its figure is printed, never
//     judged.
//   * The one change to the default that the owner approved is the glass: `.glass` and `.glass-strong` never
//     blurred outside Safari, because the minifier kept only `-webkit-backdrop-filter`. Step 1 reads the
//     BUILT stylesheet's answer in a real Chrome, which is what a source-level test cannot see.
//   * ⚠️ Sign-in and sign-out are detected by the library link, never by a password field: the Account tab
//     and the notification dialog both have one of their own.
//   * Step 3 leaves every mark cleared, then marks chapter 10 again over the API just before step 4, whose
//     sweep fetches 10-12: that is how the walk sees a mark become ordinary progress when its chapter lands.
//   * Step 4's sweep is the only thing that may fetch a Walk Tale chapter. Steps 3's Komga numbers assume
//     nine chapters on disk and three listed.
import puppeteer from 'puppeteer';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { installFixture, cpu, scrollRun, RECORDER, COLLECT } from '../perf/lib.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:18140';
const USER = process.env.E2E_USER || 'e2e';
const PASS = process.env.E2E_PASS || 'e2e-passw0rd-123';
const NET = process.env.E2E_NET || 'uchiyomi-e2e';
const appPort = Number(new URL(BASE).port || 80);
const fakePort = 20_000 + (appPort % 1000) * 2;
const STUB_A = process.env.FAKE_A_URL || `http://127.0.0.1:${fakePort}`;
const STUB_B = process.env.FAKE_B_URL || `http://127.0.0.1:${fakePort + 1}`;
const HOOK_PORT = Number(process.env.HOOK_PORT || 22_000 + (appPort % 1000));
const HOOK_NAME = `${NET}-hook`;
const HOOK = `http://127.0.0.1:${HOOK_PORT}`;
const WIDTH = Number(process.env.WIDTH || 1440);
const PHONE = WIDTH < 600;
const OUT = process.env.OUT || 'shots43';
// The Reduce effects floor: the rig measured 60 in headless Chrome at 4x; 50 leaves room for a busy host
// without letting a regression that puts a blend or a blur back under the switch through.
const FPS_FLOOR = Number(process.env.FPS_FLOOR || 50);
mkdirSync(OUT, { recursive: true });

// The two things step 4 proves never leave the server: a bearer token, and a path segment standing in for the
// part of an address that is a credential (a Discord webhook URL is one). Fresh per run, so a hit can only
// have come from this run.
const TOKEN = `walk43-token-${randomBytes(9).toString('hex')}`;
const SECRET_PATH = `walk43-path-${randomBytes(9).toString('hex')}`;

const failures = [];
const ok = (message) => console.log(`    [ ok ] ${message}`);
const bad = (message) => { failures.push(message); console.log(`    [FAIL] ${message}`); };
const check = (yes, pass, fail = pass) => yes ? ok(pass) : bad(fail);
const note = (message) => console.log(`    [info] ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (fn, ms = 10_000, step = 150) => {
  const started = Date.now(); let value;
  while (Date.now() - started < ms) { value = await fn(); if (value) return value; await sleep(step); }
  return value;
};
const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

let apiToken = '';
/** One HTTP call as the admin. `raw: true` hands back the status instead of throwing. */
async function api(path, init = {}) {
  const hasBody = init.json !== undefined || init.body !== undefined;
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {}),
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
    body: init.json === undefined ? init.body : JSON.stringify(init.json),
  });
  const raw = await r.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
  if (init.raw) return { status: r.status, body, raw };
  if (!r.ok) throw Object.assign(new Error(`${path}: ${r.status} ${raw.slice(0, 200)}`), { status: r.status, body });
  return body;
}
async function control(base, path, body) {
  const r = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${base}${path}: ${r.status}`);
  return r.json();
}

// ---- the webhook listener ---------------------------------------------------------------------------
// A dozen lines of node in a container on the instance's network. It records every request it is sent and
// answers 200, except under /bounce/, which answers 302 to /landed/… on itself: a same-origin redirect is the
// dangerous one, because fetch keeps the Authorization header on it. `GET /__log` is how the walk reads it,
// and is not itself recorded.
const HOOK_SRC = `
const http = require('node:http');
const log = [];
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/__log') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(log));
    }
    log.push({ at: Date.now(), method: req.method, path: req.url, auth: req.headers.authorization || null, body });
    if (req.url.startsWith('/bounce/')) { res.writeHead(302, { location: '/landed/' + req.url.slice(8) }); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
}).listen(Number(process.argv[1]), '0.0.0.0');
`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hookLog = async () => (await fetch(`${HOOK}/__log`).then((r) => r.json()).catch(() => null)) || [];
const hookUrl = `http://${HOOK_NAME}:${HOOK_PORT}/hook/${SECRET_PATH}`;
const bounceUrl = `http://${HOOK_NAME}:${HOOK_PORT}/bounce/${SECRET_PATH}`;

// ---- library helpers ------------------------------------------------------------------------------
const seriesByTitle = async (title) => {
  const page = await api('/api/series/search', { method: 'POST', json: { query: title, size: 30 } });
  return page?.content?.find((row) => (row.metadata?.title || row.name) === title) || null;
};
const booksOf = async (id) => (await api(`/api/series/${id}/books?size=1000`).catch(() => null))?.content || [];
const listingOf = async (id) => (await api(`/api/series/${id}/listing`).catch(() => null))?.content || [];
async function addFromA(sourceId, title, body = {}) {
  const answer = await api('/api/sources/add', { method: 'POST', json: { source: 'fake-a', sourceId, ...body } });
  const job = await waitFor(async () => {
    const jobs = await api('/api/sources/jobs').catch(() => null);
    return jobs?.content?.find((j) => j.title === title && j.status !== 'downloading') || null;
  }, 180_000, 500);
  return { answer, job };
}

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'] });
let phase = 'start';
let shotNo = 0;
let restoreMangaDex = false;
let hookStarted = false;
const targetIds = [];
try {
  const login = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (!login.ok) throw new Error(`API login ${login.status}`);
  apiToken = (await login.json()).accessToken;
  ok('one API login');

  await Promise.all([control(STUB_A, '/__reset', {}), control(STUB_B, '/__reset', {})]);
  await Promise.all(['fake-a', 'fake-b'].flatMap((id) => [
    api(`/api/admin/sources/${id}/enable`, { method: 'POST' }),
    api(`/api/admin/sources/${id}/unblock`, { method: 'POST' }),
  ]));
  // A real public source has no place in a deterministic fake-source run, and here its sweep would reach
  // the internet. Restored in finally, like the earlier walks.
  await api('/api/admin/sources/mangadex/disable', { method: 'POST' });
  restoreMangaDex = true;
  // Both switches this walk flips, asserted to their defaults first: a kept instance somebody poked at
  // would otherwise make "the default" mean whatever was left behind.
  await api('/api/admin/settings', { method: 'PATCH', json: { komgaGhostChapters: false } });
  await api('/api/settings', { method: 'PUT', json: { reduceEffects: false } });

  // ---- the rig itself, before anything reads it as a verdict --------------------------------------
  phase = 'rig';
  try { docker('rm', '-f', HOOK_NAME); } catch { /* nothing left over from an earlier run */ }
  docker('run', '-d', '--rm', '--name', HOOK_NAME, '--network', NET, '-p', `127.0.0.1:${HOOK_PORT}:${HOOK_PORT}`,
    'node:24-alpine', 'node', '-e', HOOK_SRC, String(HOOK_PORT));
  hookStarted = true;
  const hookUp = await waitFor(async () => Array.isArray(await fetch(`${HOOK}/__log`).then((r) => r.json()).catch(() => null)), 20_000, 250);
  if (!hookUp) throw new Error(`the webhook listener did not come up on ${HOOK} (is E2E_NET=${NET} the instance's network?)`);
  const taleHit = await api(`/api/sources/search?source=fake-a&q=${encodeURIComponent('Walk Tale')}`);
  if (!(taleHit.content || []).some((r) => r.title === 'Walk Tale')) throw new Error('fake-a does not carry Walk Tale');
  ok('the rig has its webhook listener on the instance network and a source carrying Walk Tale');

  // ---- the browser ---------------------------------------------------------------------------------
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: PHONE ? 844 : 900, isMobile: PHONE, hasTouch: PHONE, deviceScaleFactor: 1 });
  await page.setBypassServiceWorker(true);
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !/401|404|409|429/.test(message.text())) consoleErrors.push(`[${phase}] ${message.text().slice(0, 180)}`);
  });
  page.on('pageerror', (error) => consoleErrors.push(`[${phase}] ${String(error).slice(0, 180)}`));
  const shot = (name) => page.screenshot({ path: `${OUT}/${String(++shotNo).padStart(2, '0')}-${PHONE ? 'phone' : 'desk'}-${name}.png` });
  const bodyText = () => page.evaluate(() => document.body.innerText || '');
  /** The page must never scroll sideways, and neither may an open dialog. */
  const noSideways = async (what) => {
    const m = await page.evaluate(() => {
      const doc = document.documentElement;
      const dialog = document.querySelector('[role=dialog]');
      return {
        page: doc.scrollWidth - doc.clientWidth,
        dialog: dialog ? dialog.scrollWidth - dialog.clientWidth : 0,
      };
    });
    check(m.page <= 0 && m.dialog <= 0, `${what}: no horizontal scroll at ${WIDTH}`,
      `${what} scrolls sideways at ${WIDTH}: page +${m.page}px, dialog +${m.dialog}px`);
  };
  const findText = (re, selector = 'button', ms = 15_000) => waitFor(async () => {
    const handle = await page.evaluateHandle((selector, source) => {
      const rx = new RegExp(source, 'i');
      return [...document.querySelectorAll(selector)].find((el) => el.offsetParent !== null && rx.test((el.textContent || '').trim())) || null;
    }, selector, re.source);
    return handle.asElement();
  }, ms, 250);
  const clickText = async (re, selector = 'button') => {
    const el = await findText(re, selector);
    if (!el) throw new Error(`no visible ${selector} matching ${re}`);
    await el.evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await el.click();
    return el;
  };
  const signedIn = () => page.$('a[href^="/library"]');
  /**
   * Go to a page of the app, signed in. ⚠️ The session can be dropped under a walk: every page load sends two
   * /auth/refresh calls at once (the auth provider's, and the one the language provider's 401 on
   * /api/settings triggers), and now and then the second is refused and the session goes with it -- the
   * race run.mjs already signs back in from ("tabs racing on refresh"), and it cost a whole 1440 run here at
   * the Notifications step. A dropped session is said out loud and recovered once; it is not a verdict on
   * the page, and a check that then reads a sign-in screen would be.
   */
  let dropped = 0;
  const visit = async (path) => {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle2', timeout: 60_000 });
    const state = await waitFor(async () => ((await signedIn()) ? 'in' : (await page.$('form input[type=password]')) ? 'out' : null), 15_000, 250);
    if (state !== 'out') return;
    dropped += 1;
    console.log(`    [ -- ] ${path}: the session was dropped (the refresh race run.mjs also meets) — signing back in`);
    const fields = await page.$$('form input');
    await fields[0].type(USER); await page.type('form input[type=password]', PASS); await page.keyboard.press('Enter');
    if (!(await waitFor(signedIn, 20_000))) throw new Error(`${path}: signed out, and could not sign back in`);
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle2', timeout: 60_000 });
  };

  phase = 'login';
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60_000 });
  // ⚠️ On a fresh browser the service worker installs on this first load, claims the page, and
  // providers.tsx reloads on that `controllerchange` -- about a second after the form appears. Typing into
  // the form before it happened lost the whole walk to "Cannot find context with specified id" once the host
  // was busy (and the same race, in run.mjs, signed nobody in on two busy instances). Wait for the worker to
  // be in control, which is after that reload, and only then look for the form.
  await page.waitForFunction(() => !('serviceWorker' in navigator) || !!navigator.serviceWorker.controller, { timeout: 15_000 })
    .catch(() => {});
  await sleep(1_000);
  await page.waitForSelector('input[type=password]', { timeout: 30_000 });
  const fields = await page.$$('input');
  await fields[0].type(USER); await page.type('input[type=password]', PASS); await page.keyboard.press('Enter');
  check(!!(await waitFor(signedIn, 20_000)), 'one browser login', 'the browser login never reached the app');

  // ---- 1. Reduce effects (#71): the default is v0.42.0's look; the switch takes the costs away -----------
  phase = 'effects';
  /** What the three cinematic layers, `main` and a glass panel compute to, in THIS browser, from the built CSS. */
  const looks = () => page.evaluate(() => {
    const cs = (el) => (el ? getComputedStyle(el) : null);
    const pick = (sel) => {
      const el = document.querySelector(sel);
      const s = cs(el);
      return s && { display: s.display, position: s.position, zIndex: s.zIndex, blend: s.mixBlendMode, filter: s.filter,
        opacity: s.opacity, animation: s.animationName };
    };
    // A probe of each glass class, because the pages this walk visits need not have one on screen. What
    // matters is what the shipped stylesheet makes of the class, which is exactly what the minifier broke.
    const probe = (cls) => {
      const el = document.createElement('div');
      el.className = cls;
      document.body.appendChild(el);
      const s = getComputedStyle(el);
      const out = { backdrop: s.backdropFilter, background: s.backgroundColor };
      el.remove();
      return out;
    };
    let mirror = null;
    try { mirror = localStorage.getItem('uchiyomi.reduceEffects'); } catch {}
    return {
      reduced: document.documentElement.classList.contains('reduce-effects'),
      lenis: document.documentElement.classList.contains('lenis'),
      mirror,
      mesh: pick('.fx-mesh'), grain: pick('.fx-grain'), vignette: pick('.fx-vignette'),
      main: pick('main'),
      glass: probe('glass'), glassStrong: probe('glass-strong'),
    };
  });
  await visit('/library');
  await sleep(800);
  const off = await looks();
  check(!off.reduced && off.mirror === null, 'Reduce effects is off by default, with no device copy',
    `default: class=${off.reduced} mirror=${JSON.stringify(off.mirror)}`);
  check(off.grain?.position === 'fixed' && off.grain?.zIndex === '2' && off.grain?.blend === 'overlay' && off.grain?.opacity === '0.05',
    'the film grain is v0.42.0\'s: fixed, above the content, overlay-blended at 5 %',
    `grain computed: ${JSON.stringify(off.grain)}`);
  check(off.mesh?.position === 'fixed' && off.mesh?.zIndex === '0' && off.mesh?.filter === 'blur(90px) saturate(1.25)'
    && off.mesh?.opacity === '0.55' && off.mesh?.animation === 'mesh-drift',
    'the accent mesh is v0.42.0\'s: blur(90px) saturate(1.25), 55 %, drifting',
    `mesh computed: ${JSON.stringify(off.mesh)}`);
  check(off.vignette?.position === 'fixed' && off.vignette?.zIndex === '2' && off.main?.zIndex === '1',
    'the vignette is v0.42.0\'s: fixed at z-index 2, above main at 1',
    `vignette ${JSON.stringify(off.vignette)} main ${JSON.stringify(off.main)}`);
  check(off.lenis, 'momentum scrolling (Lenis) runs by default', 'html.lenis is missing on the default');
  // The owner-approved change: the built CSS now blurs in Chrome. Before the fix this read `none`.
  check(off.glass.backdrop === 'blur(20px) saturate(1.3)' && off.glassStrong.backdrop === 'blur(24px) saturate(1.3)',
    'the glass panels really blur in Chrome after the build minifies them',
    `glass backdrop-filter: ${JSON.stringify(off.glass)} / ${JSON.stringify(off.glassStrong)}`);
  await shot('library-default');

  // Switched on the way a person does it: Profile → Settings → Appearance.
  const SWITCH = 'button[role=switch][aria-label="Reduce effects"]';
  // ⚠️ bringToFront first: once the perf page below exists, this page is a background tab, where no frame is
  // rendered -- and puppeteer's click waits on an IntersectionObserver, which only reports on a frame, so the
  // click hung until the protocol timed out (three minutes, then "Runtime.callFunctionOn timed out").
  const flipReduce = async (on) => {
    await page.bringToFront();
    await visit('/profile/?tab=Settings');
    await page.waitForSelector(SWITCH, { timeout: 20_000 });
    const now = await page.$eval(SWITCH, (b) => b.getAttribute('aria-checked') === 'true');
    if (now !== on) {
      await page.$eval(SWITCH, (b) => b.scrollIntoView({ block: 'center' }));
      await page.click(SWITCH);
    }
    return waitFor(async () => (await api('/api/settings')).reduceEffects === on, 10_000, 250);
  };
  check(await flipReduce(true), 'the Appearance switch saves reduceEffects to the account',
    'GET /api/settings never read reduceEffects: true after the switch');
  check(await page.evaluate(() => document.documentElement.classList.contains('reduce-effects')
    && !document.querySelector('.fx-mesh,.fx-grain,.fx-vignette')),
  'it applies at once, on the page the switch is on', 'the class or the layers waited for a reload');
  await shot('profile-reduce-effects-on');
  await visit('/library');
  await sleep(800);
  const on = await looks();
  check(on.reduced && on.mirror === '1', 'the switch sets html.reduce-effects and the device copy',
    `on: class=${on.reduced} mirror=${JSON.stringify(on.mirror)}`);
  check(!on.mesh && !on.grain && !on.vignette, 'the three cinematic layers are not rendered at all',
    `still in the DOM: ${JSON.stringify({ mesh: on.mesh, grain: on.grain, vignette: on.vignette })}`);
  check(!on.lenis, 'Lenis is off: the browser scrolls natively', 'html.lenis is still there under Reduce effects');
  check(on.glass.backdrop === 'none' && on.glassStrong.backdrop === 'none' && /^rgb\(/.test(on.glass.background),
    'glass turns solid: no backdrop blur, an opaque background',
    `glass under the switch: ${JSON.stringify(on.glass)} / ${JSON.stringify(on.glassStrong)}`);
  const blurred = await page.evaluate(() => [...document.querySelectorAll('*')]
    .filter((el) => { const b = getComputedStyle(el).backdropFilter; return b && b !== 'none'; }).length);
  check(blurred === 0, 'no element on the library computes a backdrop blur', `${blurred} element(s) still blur under the switch`);
  await shot('library-reduce-effects');

  // A reload with the device copy GONE: the class has to come back from the account, and not one frame of
  // a cinematic layer may be displayed on the way (the class is applied before the authed render).
  const watcher = await page.evaluateOnNewDocument(() => {
    window.__fxSeen = [];
    const look = () => {
      for (const el of document.querySelectorAll('.fx-mesh,.fx-grain,.fx-vignette')) {
        if (getComputedStyle(el).display !== 'none') window.__fxSeen.push(el.className);
      }
    };
    new MutationObserver(look).observe(document, { childList: true, subtree: true });
  });
  await page.evaluate(() => { try { localStorage.removeItem('uchiyomi.reduceEffects'); } catch {} });
  await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 });
  await waitFor(signedIn, 15_000);
  await sleep(800);
  const back = await looks();
  const seen = await page.evaluate(() => window.__fxSeen || null);
  await page.removeScriptToEvaluateOnNewDocument(watcher.identifier);
  check(back.reduced && back.mirror === '1', 'with the device copy cleared, a reload comes back ON from the account',
    `after reload: class=${back.reduced} mirror=${JSON.stringify(back.mirror)}`);
  check(Array.isArray(seen) && seen.length === 0, 'and no cinematic layer was displayed in any frame of that reload',
    `displayed during the reload: ${JSON.stringify(seen)}`);

  // ---- 2. the frame rate with the switch ON, the rig's own method -----------------------------------
  //
  // web/test/perf's fixture (200 series, every fourth a favourite) on a page of its own, the library at
  // 1440x900 whatever WIDTH this walk runs at, 4x CPU throttle, a 55-notch wheel scroll, three fresh loads.
  phase = 'perf';
  const perf = await browser.newPage();
  await perf.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await installFixture(perf);
  const scrollFps = async () => {
    // In front, or requestAnimationFrame -- which IS the measurement -- is not called at all.
    await perf.bringToFront();
    const runs = [];
    for (let i = 0; i < 3; i++) {
      await cpu(perf, 1);
      await perf.goto(`${BASE}/library`, { waitUntil: 'networkidle2', timeout: 60_000 });
      await waitFor(() => perf.$('a[href^="/library"]'), 15_000);
      await sleep(2500);
      await perf.evaluate(() => window.scrollTo(0, 0));
      await sleep(400);
      await cpu(perf, 4);
      await perf.evaluate(RECORDER);
      await scrollRun(perf, { steps: 55 });
      await sleep(300);
      runs.push(await perf.evaluate(COLLECT));
      await cpu(perf, 1);
    }
    return runs;
  };
  const onRuns = await scrollFps();
  const perfState = await perf.evaluate(() => ({
    reduced: document.documentElement.classList.contains('reduce-effects'),
    tiles: document.querySelectorAll('a[href*="/series/"]').length,
  }));
  check(perfState.reduced && perfState.tiles >= 150, `the measured page is the switched-on library with the 200-series fixture (${perfState.tiles} tiles)`,
    `the perf page is not what it claims: ${JSON.stringify(perfState)} -- a floor on a small or unswitched page proves nothing`);
  const onFps = median(onRuns.map((r) => r.fps));
  check(onFps >= FPS_FLOOR, `with Reduce effects on the library scrolls at ${onFps} fps at 4x (floor ${FPS_FLOOR}; runs ${onRuns.map((r) => r.fps).join(' / ')})`,
    `Reduce effects on: the library scrolled at ${onFps} fps at 4x, under the ${FPS_FLOOR} floor (runs ${onRuns.map((r) => `${r.fps} fps, ${r.over33}% >33ms`).join(' / ')}) -- something costly is back under the switch`);

  phase = 'effects-off';
  check(await flipReduce(false), 'the same switch turns it back off on the account', 'reduceEffects never read false again');
  const defaultRuns = await scrollFps();
  note(`the default, for the record and deliberately not judged: ${median(defaultRuns.map((r) => r.fps))} fps at 4x (runs ${defaultRuns.map((r) => r.fps).join(' / ')})`);
  await perf.close();
  await page.bringToFront();
  await visit('/library');
  await sleep(800);
  const again = await looks();
  check(!again.reduced && again.mirror === null && JSON.stringify([again.mesh, again.grain, again.vignette, again.glass]) === JSON.stringify([off.mesh, off.grain, off.vignette, off.glass]),
    'switched off, every layer is back exactly as it computed before',
    `off again: ${JSON.stringify(again)}`);

  // ---- 3. marking chapters the server never fetched (#69) ------------------------------------------
  phase = 'ghost-marks';
  // Nine of twelve: 10, 11 and 12 are listed by the source and not on disk -- the grey rows.
  const tale = await addFromA('walk-tale', 'Walk Tale', { chapterCount: 9, chapterFrom: 'oldest' });
  check(tale.job?.done === 9, 'Walk Tale added with its oldest nine chapters', `Walk Tale landed ${tale.job?.done ?? 'no'} of 9`);
  const taleId = tale.answer?.seriesId ?? tale.job?.seriesId ?? (await seriesByTitle('Walk Tale'))?.id;
  const listed = (await listingOf(taleId)).map((g) => g.number).sort((a, b) => a - b);
  check(JSON.stringify(listed) === '[10,11,12]', 'the source lists 10, 11 and 12 that the server does not hold',
    `listing: ${JSON.stringify(listed)}`);

  const { token: apiKey } = await api('/api/tokens', { method: 'POST', json: { name: 'walk43', scopes: ['read', 'write'] } });
  const komga = async (path, init = {}) => {
    const r = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'X-API-Key': apiKey, ...(init.json ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) },
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  const trackerNumbers = async () => (await komga(`/api/v2/series/${taleId}/read-progress/tachiyomi`)).body;
  const ghostSwitch = (on) => api('/api/admin/settings', { method: 'PATCH', json: { komgaGhostChapters: on } });
  const statusOf = (p) => p.booksCount === p.booksUnreadCount ? 'UNREAD' : p.booksCount === p.booksReadCount ? 'COMPLETED' : 'READING';

  // The nine on disk read, through Mihon's own PUT while the switch is off -- so no mark is made by it.
  const put = await komga(`/api/v2/series/${taleId}/read-progress/tachiyomi`, { method: 'PUT', json: { lastBookNumberSortRead: 9 } });
  check(put.status === 204, 'the nine chapters on disk are read', `the tracker PUT answered ${put.status}`);
  const baseOff = await trackerNumbers();
  await ghostSwitch(true);
  const baseOn = await trackerNumbers();
  await ghostSwitch(false);
  check(baseOn.lastReadContinuousNumberSort === 9 && baseOn.booksCount === 9,
    'before any mark, the ghost switch shows the listed total but reads to 9 and counts 9',
    `before marks, switch on: ${JSON.stringify(baseOn)}`);

  const ghostRow = (n) => page.evaluateHandle((n) => {
    const rx = new RegExp(`^Ch\\. ${n}(?![\\d.])`);
    for (const thumb of document.querySelectorAll('div.border-dashed.h-14')) {
      const row = thumb.closest('button')?.parentElement;
      const label = row?.querySelector('p')?.textContent?.trim() || '';
      if (row && row.offsetParent !== null && rx.test(label)) return row;
    }
    return null;
  }, n).then((h) => h.asElement());
  const tickOn = (n) => page.evaluate((n) => {
    const rx = new RegExp(`^Ch\\. ${n}(?![\\d.])`);
    for (const thumb of document.querySelectorAll('div.border-dashed.h-14')) {
      const row = thumb.closest('button')?.parentElement;
      if (row && rx.test(row.querySelector('p')?.textContent?.trim() || '')) {
        return !!row.querySelector('[role=img][aria-label="Read · not on the server"]');
      }
    }
    return null;
  }, n);
  const openSeries = async () => {
    await visit(`/series/?id=${taleId}`);
    return waitFor(() => ghostRow(10), 20_000);
  };
  const row10 = await openSeries();
  check(!!row10, 'the series page shows chapter 10 as a grey row', 'no grey row for chapter 10 on the series page');
  check(await tickOn(10) === false, 'an unmarked grey row carries no tick', 'chapter 10 showed a tick before it was marked');
  const menuOf = async (n) => {
    const row = await ghostRow(n);
    const dots = await row?.$('button[aria-label="Chapter actions"]');
    if (!dots) throw new Error(`grey row ${n} has no ⋯ menu`);
    await dots.evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await dots.click();
    await sleep(300);
    return row;
  };
  const menuRow = await menuOf(10);
  const menuItem = await menuRow.$$eval('button', (bs) => bs.map((b) => (b.textContent || '').trim()).filter(Boolean));
  check(menuItem.includes('Mark read'), 'its ⋯ menu offers Mark read', `the grey row's menu held ${JSON.stringify(menuItem)}`);
  await shot('ghost-menu-open');
  await noSideways('the series page with a grey row\'s menu open');
  await clickText(/^Mark read$/);
  check(!!(await waitFor(async () => (await tickOn(10)) === true, 10_000)), 'the tick shows on the grey row once marked',
    'no tick appeared on chapter 10 after Mark read');
  await (await ghostRow(10))?.evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await sleep(400);
  await shot('ghost-read-tick');
  const marked = (await listingOf(taleId)).filter((g) => g.read === true).map((g) => g.number);
  check(JSON.stringify(marked) === '[10]', 'the server holds the mark on 10 and nothing else', `listing read flags: ${JSON.stringify(marked)}`);
  check((await booksOf(taleId)).length === 9, 'and no chapter row was invented for it', `Walk Tale has ${(await booksOf(taleId)).length} chapter rows`);

  const markOff = await trackerNumbers();
  check(JSON.stringify(markOff) === JSON.stringify(baseOff), 'with the ghost switch off, Mihon sees exactly what it saw before the mark',
    `off before ${JSON.stringify(baseOff)} vs after ${JSON.stringify(markOff)}`);
  await ghostSwitch(true);
  const markOn = await trackerNumbers();
  await ghostSwitch(false);
  check(markOn.lastReadContinuousNumberSort === 10 && markOn.booksCount === 12 && markOn.booksReadCount === 10 && statusOf(markOn) === 'READING',
    'with it on, the run reaches 10 and the counts take in the listed chapters (10 of 12, Reading)',
    `switch on, 10 marked: ${JSON.stringify(markOn)}`);

  // Select mode with only grey rows picked: Mark read has to be live, and marking the rest finishes it.
  // ⚠️ Each row is scrolled to the middle before it is tapped: at 390 the select bar appears with the first
  // pick and wraps to three rows above the nav, and the last rows of the list sit under it -- a tap there
  // lands on the bar, which is exactly how the first 390 run picked 11 without 12.
  const pickGhosts = async (numbers) => {
    for (const n of numbers) {
      const row = await waitFor(() => ghostRow(n), 8_000);
      const pick = await row?.$('button');
      await pick?.evaluate((node) => node.scrollIntoView({ block: 'center' }));
      await sleep(250);
      await pick?.click();
      await sleep(200);
    }
  };
  await clickText(/^Select$/);
  await pickGhosts([11, 12]);
  check(!!(await waitFor(async () => /2 selected/.test(await bodyText()), 5_000)), 'two grey rows picked in select mode',
    'the select bar never said 2 selected');
  const markChip = await findText(/^Mark read$/);
  check(await markChip?.evaluate((b) => !b.disabled) === true, 'Mark read is live with only grey rows picked',
    'Mark read stayed disabled with only grey rows picked');
  await shot('ghost-select-mode');
  await noSideways('select mode with grey rows picked');
  await markChip.click();
  const allMarked = await waitFor(async () => (await listingOf(taleId)).filter((g) => g.read === true).length === 3, 10_000);
  check(!!allMarked, 'select mode marked 11 and 12 too', `read flags after the bar: ${JSON.stringify((await listingOf(taleId)).map((g) => [g.number, !!g.read]))}`);
  await ghostSwitch(true);
  const allOn = await trackerNumbers();
  await ghostSwitch(false);
  check(allOn.lastReadContinuousNumberSort === 12 && statusOf(allOn) === 'COMPLETED',
    'every listed chapter marked: the phone reads to 12 and the series is Completed',
    `all marked, switch on: ${JSON.stringify(allOn)}`);

  // And cleared again: 10 from its menu, 11 and 12 from select mode.
  await openSeries();
  await menuOf(10);
  await clickText(/^Mark unread$/);
  await waitFor(async () => (await tickOn(10)) === false, 10_000);
  await clickText(/^Select$/);
  await pickGhosts([11, 12]);
  check(!!(await waitFor(async () => /2 selected/.test(await bodyText()), 5_000)), 'the same two grey rows picked again',
    'the select bar never said 2 selected on the way back');
  await clickText(/^Mark unread$/);
  const cleared = await waitFor(async () => (await listingOf(taleId)).every((g) => g.read !== true), 10_000);
  check(!!cleared, 'Mark unread clears the marks, from the menu and from select mode',
    `read flags after clearing: ${JSON.stringify((await listingOf(taleId)).map((g) => [g.number, !!g.read]))}`);
  await ghostSwitch(true);
  const clearedOn = await trackerNumbers();
  await ghostSwitch(false);
  check(JSON.stringify(clearedOn) === JSON.stringify(baseOn) && JSON.stringify(await trackerNumbers()) === JSON.stringify(baseOff),
    'and both answers are back to what they were before the first mark',
    `cleared: on ${JSON.stringify(clearedOn)} (was ${JSON.stringify(baseOn)})`);

  // ---- 4. notification targets (#70) -----------------------------------------------------------------
  phase = 'notify';
  const notifySection = async () => {
    await visit('/admin/?tab=Settings');
    const section = await waitFor(async () => (await page.evaluateHandle(() => [...document.querySelectorAll('section')]
      .find((s) => s.querySelector('h2')?.textContent?.trim() === 'Notifications') || null)).asElement(), 20_000);
    if (!section) throw new Error('no Notifications section under Admin → Settings');
    await section.evaluate((node) => node.scrollIntoView({ block: 'start' }));
    await sleep(500);
    return section;
  };
  let section = await notifySection();
  const addButton = await section.$$('button').then(async (bs) => {
    for (const b of bs) if (/^Add$/.test((await b.evaluate((n) => n.textContent || '')).trim())) return b;
    return null;
  });
  await addButton.click();
  await waitFor(() => page.$('[role=dialog]'), 10_000);
  await sleep(500);
  const kindPill = async (label) => {
    const pill = await waitFor(async () => (await page.evaluateHandle((want) => [...document.querySelectorAll('[role=dialog] [role=radio]')]
      .find((b) => (b.textContent || '').trim() === want) || null, label)).asElement(), 5_000);
    if (!pill) throw new Error(`no ${label} kind in the Add dialog`);
    await pill.click();
    await sleep(350);
  };
  const dialogFields = () => page.$$eval('[role=dialog] label > span:first-child', (s) => s.map((x) => (x.textContent || '').trim()));
  const KINDS = [
    ['Webhook', ['Address', 'Token (optional)']],
    ['Home Assistant', ['Home Assistant address', 'Long-lived access token', 'Service']],
    ['ntfy', ['Server', 'Topic', 'Token (optional)']],
    ['Discord', ['Discord webhook address']],
  ];
  for (const [kind, want] of KINDS) {
    await kindPill(kind);
    const have = (await dialogFields()).map((f) => f.toLowerCase());
    check(want.every((w) => have.includes(w.toLowerCase())), `the Add dialog for ${kind} asks for ${want.join(', ')}`,
      `the ${kind} dialog showed ${JSON.stringify(have)}`);
    await shot(`notify-add-${kind.toLowerCase().replace(/\s+/g, '-')}`);
    await noSideways(`the Add dialog for ${kind}`);
  }
  // The real one, through the dialog: a webhook with a token, at the listener.
  await kindPill('Webhook');
  await page.type('[role=dialog] input[placeholder="e.g. Kitchen tablet"]', 'Walk hook');
  await page.type('[role=dialog] input[type=url]', hookUrl);
  await page.type('[role=dialog] input[autocomplete="new-password"]', TOKEN);
  const addIt = await waitFor(async () => (await page.evaluateHandle(() => [...document.querySelectorAll('[role=dialog] button')]
    .find((b) => (b.textContent || '').trim() === 'Add' && !b.disabled) || null)).asElement(), 5_000);
  check(!!addIt, 'the dialog arms Add once a name and an address are in', 'Add stayed disabled on a complete webhook');
  await addIt?.click();
  await waitFor(async () => !(await page.$('[role=dialog]')), 10_000);
  const list1 = await api('/api/admin/notify-targets');
  const hookTarget = (list1.targets || []).find((t) => t.name === 'Walk hook');
  if (hookTarget) targetIds.push(hookTarget.id);
  check(hookTarget?.kind === 'webhook' && hookTarget?.hasToken === true && hookTarget?.target?.startsWith(`http://${HOOK_NAME}`)
    && hookTarget?.target?.endsWith('/…'),
    'the target is saved, and the panel is told only scheme, host and that a token exists',
    `saved as ${JSON.stringify(hookTarget)}`);
  section = await notifySection();
  check(!!(await findText(/^Walk hook$/, 'p, span, div', 8_000)) || (await bodyText()).includes('Walk hook'), 'its row is listed', 'the new target is not in the list');
  await shot('notify-one-target');
  await noSideways('Admin → Settings → Notifications with one target');

  // Edit: the credential boxes start empty and say what is stored, never what it is. Looked up inside the
  // section: Admin → Settings has other Edit buttons.
  const inSection = async (label) => {
    const s = await notifySection();
    for (const b of await s.$$('button')) if ((await b.evaluate((n) => (n.textContent || '').trim())) === label) return b;
    throw new Error(`no ${label} button in the Notifications section`);
  };
  await (await inSection('Edit')).click();
  await waitFor(() => page.$('[role=dialog]'), 10_000);
  await sleep(500);
  const editState = await page.evaluate(() => ({
    title: document.querySelector('[role=dialog]')?.textContent || '',
    values: [...document.querySelectorAll('[role=dialog] input')].filter((i) => i.type === 'url' || i.type === 'password').map((i) => i.value),
  }));
  check(/Edit Walk hook/.test(editState.title) && editState.values.every((v) => v === '') && /A token is stored/.test(editState.title),
    'Edit opens with the address and token boxes empty, saying a token is stored',
    `edit dialog: values ${JSON.stringify(editState.values)}`);
  await shot('notify-edit');
  await noSideways('the Edit dialog');
  await page.keyboard.press('Escape');
  await sleep(400);

  // Send a test from the row: the listener gets it, with the token -- the token IS delivered, so every
  // "it appears nowhere" below is about the server keeping it, not about it having been lost.
  await (await inSection('Send a test')).click();
  const tested = await waitFor(async () => (await hookLog()).find((r) => r.path === `/hook/${SECRET_PATH}` && /"event":"test"/.test(r.body)), 15_000);
  check(tested?.auth === `Bearer ${TOKEN}`, 'Send a test reaches the listener, carrying the token as a bearer',
    `the listener's test request: ${JSON.stringify(tested ? { path: tested.path, auth: tested.auth ? 'present' : null } : null)}`);

  // The second target, over the API: an address that answers 302.
  const bounce = await api('/api/admin/notify-targets', { method: 'POST', json: { kind: 'webhook', name: 'Walk bounce', url: bounceUrl, token: TOKEN, events: ['new_chapters'] } });
  if (bounce?.id) targetIds.push(bounce.id);

  // The mark step 3 left for this one: chapter 10 marked read while it is still a grey row, so the sweep
  // below lands it as a chapter the reader has read.
  const remark = await api(`/api/series/${taleId}/listing-progress`, { method: 'POST', json: { numbers: [10] } });
  check(remark?.marked === 1, 'chapter 10 is marked read again, while it is still a grey row', `the mark answered ${JSON.stringify(remark)}`);

  // Run now on the chapter sweep: the one thing that lands 10, 11 and 12, and the one digest.
  const before = Date.now();
  const run = await api('/api/admin/tasks/update/run', { method: 'POST' });
  check(run?.started === true, 'Run now started the chapter sweep', `the sweep answered ${JSON.stringify(run)}`);
  const finished = await waitFor(async () => {
    const tasks = await api('/api/admin/tasks');
    const t = (tasks.content || tasks).find((x) => x.id === 'update');
    return t && !t.running && t.lastRun >= before ? t : null;
  }, 180_000, 1000);
  check(!!finished, 'the sweep finished', 'the sweep was still running after three minutes');
  const landed = (await booksOf(taleId)).map((b) => b.number).sort((a, b) => a - b);
  check(landed.length === 12, 'it fetched the three listed chapters', `Walk Tale now has ${JSON.stringify(landed)}`);
  const digests = await waitFor(async () => {
    const rows = (await hookLog()).filter((r) => r.at >= before && r.path === `/hook/${SECRET_PATH}` && /"event":"new_chapters"/.test(r.body));
    return rows.length ? rows : null;
  }, 30_000, 500) || [];
  await sleep(5_000); // a second digest, if one were coming, has had every chance to arrive
  const allAfter = (await hookLog()).filter((r) => r.at >= before);
  const digestRows = allAfter.filter((r) => r.path === `/hook/${SECRET_PATH}` && /"event":"new_chapters"/.test(r.body));
  let digest = null;
  try { digest = JSON.parse(digestRows[0]?.body || 'null'); } catch {}
  check(digests.length >= 1 && digestRows.length === 1, 'the webhook received exactly one digest for the whole sweep',
    `digests received: ${digestRows.length}`);
  check(digest?.count === 3 && digest?.message === '3 new chapters in Walk Tale' && digest?.series?.length === 1
    && digest.series[0].title === 'Walk Tale' && digest.series[0].added === 3,
    'it reads "3 new chapters in Walk Tale", with the series and its count',
    `the digest body: ${JSON.stringify(digest)}`);
  check(digestRows[0]?.auth === `Bearer ${TOKEN}`, 'and it carries the stored token', 'the digest arrived without the token');
  const bounced = allAfter.filter((r) => r.path.startsWith('/bounce/'));
  const followed = (await hookLog()).filter((r) => r.path.startsWith('/landed/'));
  check(bounced.length === 1 && followed.length === 0, 'the target that answers 302 was asked once and the redirect was never followed',
    `bounce requests ${bounced.length}, requests to the redirect's destination ${followed.length}`);
  const list2 = await api('/api/admin/notify-targets');
  const b2 = (list2.targets || []).find((t) => t.name === 'Walk bounce');
  const h2 = (list2.targets || []).find((t) => t.name === 'Walk hook');
  check(b2?.lastError === 'redirect' && b2?.lastResult === 'error' && h2?.lastResult === 'ok',
    'the panel records the redirect as the reason, and the good target as delivered',
    `bounce ${JSON.stringify({ lastError: b2?.lastError, lastResult: b2?.lastResult })}, hook ${JSON.stringify({ lastResult: h2?.lastResult })}`);
  const ch10 = (await booksOf(taleId)).find((b) => Number(b.number ?? b.metadata?.numberSort) === 10);
  check(ch10?.readProgress?.completed === true && (await listingOf(taleId)).length === 0,
    'the mark on 10 became ordinary read progress when the chapter landed',
    `chapter 10 after the sweep: ${JSON.stringify(ch10?.readProgress ?? null)}`);

  section = await notifySection();
  await shot('notify-after-sweep');
  await noSideways('the Notifications section after the sweep');

  // Nowhere: not in the page, not in what the API answers, not in the audit feed, not in the app's log.
  const pageHtml = await page.content();
  const pageText = await bodyText();
  const apiText = JSON.stringify(list2);
  const audit = await api('/api/admin/audit?limit=150');
  const auditText = JSON.stringify(audit);
  // Both streams: the app logs to stdout and stderr alike.
  const logs = spawnSync('docker', ['logs', NET], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const appLog = `${logs.stdout || ''}${logs.stderr || ''}`;
  check(appLog.length > 1000, `the app log was read (${appLog.length} bytes)`, 'the app log came back empty, so the leak check on it would prove nothing');
  const leaks = [];
  for (const [where, text] of [['page HTML', pageHtml], ['page text', pageText], ['API answer', apiText], ['audit feed', auditText], ['app log', appLog]]) {
    if (text.includes(TOKEN)) leaks.push(`${where}: token`);
    if (text.includes(SECRET_PATH)) leaks.push(`${where}: address path`);
  }
  check(/notify\.target\.create/.test(auditText) && /notify\.target\.test/.test(auditText),
    'the audit feed does record the targets being made and tested', 'no notify.target rows in the audit feed, so the check below would prove nothing');
  check(leaks.length === 0, 'the token and the address path appear nowhere: page, API, audit feed or app log',
    `leaked: ${leaks.join(', ')}`);

  // ---- the page itself -----------------------------------------------------------------------------
  phase = 'console';
  if (dropped) note(`the session was dropped and recovered ${dropped} time(s) during this walk`);
  check(consoleErrors.length === 0, 'zero browser-console errors', `browser console: ${consoleErrors.slice(0, 8).join(' | ')}`);
} catch (error) {
  bad(`[${phase}] threw: ${String(error).slice(0, 300)}`);
} finally {
  for (const id of targetIds) await api(`/api/admin/notify-targets/${id}`, { method: 'DELETE' }).catch(() => {});
  if (restoreMangaDex) await api('/api/admin/sources/mangadex/enable', { method: 'POST' }).catch(() => {});
  await api('/api/admin/settings', { method: 'PATCH', json: { komgaGhostChapters: false } }).catch(() => {});
  await api('/api/settings', { method: 'PUT', json: { reduceEffects: false } }).catch(() => {});
  if (hookStarted) { try { docker('rm', '-f', HOOK_NAME); } catch {} }
  await browser.close();
}

console.log(`\n${failures.length ? `${failures.length} failed` : 'all checks passed'} (${WIDTH}px)`);
if (failures.length) process.exit(1);
