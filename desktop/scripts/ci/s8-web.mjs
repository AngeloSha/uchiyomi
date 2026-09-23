// S8: the web app inside the packaged Electron window, driven over remote debugging with puppeteer-core
// (connect, never download a browser). On the loopback origin http://127.0.0.1:<port>/:
//   the setup screen renders -> the first admin is created THROUGH THE FORM -> cookies yomi_rt + yomi_img exist
//   -> after a reload navigator.serviceWorker.controller is set -> an IndexedDB key survives a reload
//   -> with the network emulated offline (page AND service worker) a reload still shows the app shell.
// Also measured here, because this is the only check with a real window: cold start (spawn -> first paint of the
// app, and -> the library page showing the seeded series), idle RSS per process, and that Quit leaves nothing
// running.
import puppeteer from 'puppeteer-core';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { WIN, REPO, OUT, OS_TAG, appExe, record, tmpRoot, launch, waitFor, waitHealthy, freePort, snapshot, runAsync, rssTable, runSync, sleep, readJson, hardKill, isAlive, APP_EXTRA } from './lib.mjs';

const exe = appExe();
const root = tmpRoot('s8');
const USER = 's8admin';
const PASS = 's8-passw0rd-123';
const results = {};
const fails = [];
const check = (name, ok, detail) => { results[name] = { ok, detail }; if (!ok) fails.push(name); console.log(`  [${ok ? ' ok ' : 'FAIL'}] ${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); };

// A tiny library (the e2e seed: "Mixed Formats" + "Repeated Pages") so the library page has something to show.
const py = WIN ? 'python' : 'python3';
const seeded = runSync(py, [join(REPO, 'web', 'test', 'e2e', 'seed.py'), join(root, 'library')]);
console.log(seeded.out.trim());

async function start(tag) {
  const dbg = await freePort();
  const t0 = Date.now();
  const child = launch(exe, [...APP_EXTRA, `--data-dir=${root}`, `--remote-debugging-port=${dbg}`, `--metrics-file=${join(root, 'metrics.json')}`], { log: join(OUT, `s8-${tag}-app.log`) });
  const browserURL = `http://127.0.0.1:${dbg}`;
  await waitFor(async () => (await fetch(`${browserURL}/json/version`, { signal: AbortSignal.timeout(2000) })).ok, { timeoutMs: 120_000, what: 'remote debugging port' });
  const browser = await puppeteer.connect({ browserURL, defaultViewport: null, protocolTimeout: 90_000 });
  const uiPort = await waitHealthy(root, 240_000);
  const origin = `http://127.0.0.1:${uiPort}`;
  const page = await waitFor(async () => (await browser.pages()).find((p) => p.url().startsWith(origin)), { timeoutMs: 120_000, what: 'the app page in the window' });
  return { child, browser, page, origin, t0, uiPort };
}

/** Screenshots are evidence, not the check: bounded, and a failure is noted rather than fatal. */
async function shot(page, name) {
  if (process.env.S8_NO_SHOTS) return null;
  const file = join(OUT, `${name}-${OS_TAG}.png`);
  try {
    await Promise.race([page.screenshot({ path: file }), sleep(30_000).then(() => { throw new Error('timed out after 30 s'); })]);
    return file;
  } catch (e) {
    console.log(`  (screenshot ${name} failed: ${e.message})`);
    results.screenshotErrors = [...(results.screenshotErrors || []), `${name}: ${e.message}`];
    return null;
  }
}

async function paintTimes(page, t0) {
  return page.evaluate((t0) => {
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    const fp = performance.getEntriesByName('first-paint')[0];
    return {
      navigationStartSinceSpawn: Math.round(performance.timeOrigin - t0),
      firstPaintSinceSpawn: fp ? Math.round(performance.timeOrigin + fp.startTime - t0) : null,
      firstContentfulPaintSinceSpawn: fcp ? Math.round(performance.timeOrigin + fcp.startTime - t0) : null,
    };
  }, t0);
}

async function quitApp() {
  const before = snapshot(root).list;
  const t0 = Date.now();
  const q = await runAsync(exe, [...APP_EXTRA, '--quit-for-update', `--data-dir=${root}`], { timeoutMs: 120_000 });
  await sleep(2000);
  const left = before.filter((p) => isAlive(p.pid));
  return { exit: q.code, ms: Date.now() - t0, before: before.length, left: left.map((p) => ({ pid: p.pid, role: p.role, name: p.name })) };
}

let run1;
try {
  // ------------------------------------------------------------ first launch: setup through the UI
  run1 = await start('first');
  const { page, origin, t0 } = run1;
  const firstPaint = await paintTimes(page, t0);
  const setupForm = () => page.waitForFunction(() => /create your admin account/i.test(document.body.innerText) && document.querySelectorAll('input[type=password]').length >= 2, { timeout: 90_000 }).then(() => true).catch(() => false);
  const form = await setupForm();
  check('setup screen renders', form, `${page.url()} (${Date.now() - t0} ms after spawn)`);
  // The PWA's first visit: the service worker installs, claims the page, and web/app/providers.tsx reloads once
  // on 'controllerchange'. Touching the form before that reload races it (the handles die with the document).
  const claimed = await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 45_000 }).then(() => true).catch(() => false);
  await sleep(2500);
  await setupForm();
  results.firstVisitServiceWorkerClaim = claimed;
  await shot(page, 's8-setup');
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const inputs = await page.$$('input');
      await inputs[0].click({ clickCount: 3 });
      await inputs[0].type(USER);
      const pws = await page.$$('input[type=password]');
      await pws[0].type(PASS);
      await pws[1].type(PASS);
      await page.keyboard.press('Enter');
      break;
    } catch (e) {
      console.log(`  (setup form attempt ${attempt}: ${e.message})`);
      await sleep(2000);
      await setupForm();
    }
  }
  const signedIn = await page.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 60_000 }).then(() => true).catch(() => false);
  check('setup completed through the form, signed in', signedIn, page.url());

  const cdp = await page.createCDPSession();
  const { cookies } = await cdp.send('Network.getAllCookies');
  const names = cookies.filter((c) => /127\.0\.0\.1/.test(c.domain)).map((c) => c.name);
  check('cookies yomi_rt + yomi_img', names.includes('yomi_rt') && names.includes('yomi_img'), names.join(','));

  // Scan the seeded library (the e2e does the same: POST /api/refresh with a token from its own login).
  const tok = (await (await fetch(`${origin}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) })).json()).accessToken;
  const scan = await fetch(`${origin}/api/refresh`, { method: 'POST', headers: { authorization: `Bearer ${tok}` } });
  check('library scan started', scan.ok, `POST /api/refresh ${scan.status}`);

  // Service worker: registered by web/app/providers.tsx; controls the page after a reload.
  const swReady = await page.evaluate(() => Promise.race([navigator.serviceWorker.ready.then((r) => r.active?.scriptURL || 'ready'), new Promise((r) => setTimeout(() => r(null), 30_000))]));
  await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 }).catch(() => {});
  const controller = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL || null);
  check('service worker controls the page after a reload', !!controller, { ready: swReady, controller });

  // IndexedDB: a key written before a reload is there after it.
  const token = `spike-${Date.now()}`;
  await page.evaluate((token) => new Promise((res, rej) => {
    const r = indexedDB.open('uchiyomi-spike', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => { const tx = r.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put(token, 'probe'); tx.oncomplete = () => { r.result.close(); res(true); }; tx.onerror = () => rej(tx.error); };
    r.onerror = () => rej(r.error);
  }), token);
  await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 }).catch(() => {});
  const back = await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('uchiyomi-spike', 1);
    r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('probe'); g.onsuccess = () => { r.result.close(); res(g.result ?? null); }; g.onerror = () => res(null); };
    r.onerror = () => res(null);
  }));
  const dbs = await page.evaluate(() => indexedDB.databases().then((d) => d.map((x) => x.name)));
  check('IndexedDB key persists across a reload', back === token, { wrote: token, read: back, databases: dbs });

  // The library page, with the seeded series on it.
  await page.goto(`${origin}/library/`, { waitUntil: 'networkidle2', timeout: 60_000 }).catch(() => {});
  const lib = await page.waitForFunction(() => /Mixed Formats/.test(document.body.innerText), { timeout: 60_000 }).then(() => true).catch(() => false);
  await sleep(1500);
  await shot(page, 's8-library');
  check('library page lists the seeded series', lib, page.url());

  // Offline: the page AND its service worker cut off, then a reload. The SW's shell must answer.
  await page.goto(`${origin}/`, { waitUntil: 'networkidle2', timeout: 60_000 }).catch(() => {});
  let navFromSW = null;
  cdp.on('Network.responseReceived', (e) => { if (e.type === 'Document') navFromSW = { url: e.response.url, fromServiceWorker: e.response.fromServiceWorker, status: e.response.status }; });
  await cdp.send('Network.enable');
  await page.setOfflineMode(true);
  const swTargets = run1.browser.targets().filter((t) => t.type() === 'service_worker');
  for (const t of swTargets) {
    try { const s = await t.createCDPSession(); await s.send('Network.enable'); await s.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); } catch (e) { console.log(`  sw offline: ${e}`); }
  }
  const probe = await page.evaluate(() => fetch('/healthz', { cache: 'no-store' }).then((r) => `online ${r.status}`, (e) => `offline (${e.message})`));
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch((e) => console.log(`  offline reload: ${e.message}`));
  await sleep(4000);
  const shell = await page.evaluate(() => ({ href: location.href, title: document.title, textLen: document.body?.innerText.length || 0, hasNext: !!document.querySelector('#__next, body > div'), chromeError: location.href.startsWith('chrome-error:') }));
  await shot(page, 's8-offline');
  check('offline reload shows the app shell', !shell.chromeError && shell.textLen > 0 && /Uchiyomi/i.test(shell.title) && (!navFromSW || navFromSW.fromServiceWorker), { probe, swTargets: swTargets.length, shell, navFromSW });
  await page.setOfflineMode(false);
  for (const t of swTargets) { try { const s = await t.createCDPSession(); await s.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); } catch { /* gone */ } }

  // Idle RSS: 30 s with nothing happening, then every process of the app, by role.
  await page.goto(`${origin}/library/`, { waitUntil: 'networkidle2', timeout: 60_000 }).catch(() => {});
  await sleep(30_000);
  const snap = snapshot(root);
  const rss = rssTable(snap.list);
  const metrics = readJson(join(root, 'metrics.json'));
  results.idleRss = { ...rss, electronMetrics: metrics?.metrics };
  console.log(`  idle RSS: ${JSON.stringify(rss)}`);
  results.firstLaunch = { firstPaint };

  await run1.browser.disconnect();
  const q = await quitApp();
  check('Quit stops every process (ordered shutdown)', q.exit === 0 && q.left.length === 0, q);

  // ------------------------------------------------------------ second launch: signed in, straight to the library
  const run2 = await start('warm');
  const t2 = run2.t0;
  const visible = await waitFor(async () => (await run2.page.evaluate(() => /Mixed Formats/.test(document.body.innerText)).catch(() => false)) && Date.now(), { timeoutMs: 120_000, intervalMs: 100, what: 'library content' }).catch(() => null);
  const paint2 = await paintTimes(run2.page, t2);
  const cold = { ...paint2, seededSeriesVisibleSinceSpawn: visible ? visible - t2 : null, url: run2.page.url() };
  results.coldStart = cold;
  const still = await run2.page.evaluate(() => !document.querySelector('input[type=password]'));
  check('relaunch opens signed in (cookies survived a restart)', still, cold);
  await shot(run2.page, 's8-relaunch');
  const appLog = readFileSync(join(root, 'logs', 'desktop.log'), 'utf8');
  const bootLine = appLog.split('\n').filter((l) => /window: app loaded/.test(l)).pop();
  results.appTimeline = bootLine ? JSON.parse(bootLine.slice(bootLine.indexOf('{'))) : null;
  await run2.browser.disconnect();
  const q2 = await quitApp();
  results.quit2 = q2;
} catch (e) {
  fails.push(`error: ${e.message}`);
  results.error = String(e.stack || e);
  console.log(results.error);
  // Stop whatever is still up the orderly way first, then hard-kill anything that survived.
  try {
    const left = snapshot(root).list;
    await runAsync(exe, [...APP_EXTRA, '--quit-for-update', `--data-dir=${root}`], { timeoutMs: 120_000 });
    await sleep(2000);
    hardKill(left.map((p) => p.pid).filter(isAlive));
  } catch { /* best effort */ }
}

record('S8-web-in-electron', fails.length ? 'FAIL' : 'PASS',
  fails.length ? `failed: ${fails.join('; ')}` : `setup form, cookies yomi_rt+yomi_img, SW controller after reload, IndexedDB across reload, offline shell from the SW: all ok; library screenshot ci-out/s8-library-${OS_TAG}.png`,
  results);
if (results.idleRss) record('M-idle-rss', 'INFO', `idle RSS after boot + 30 s: total ${results.idleRss.totalMB} MB; ${Object.entries(results.idleRss.byRole).map(([k, v]) => `${k} ${v.rssMB} MB (${v.count})`).join(', ')}`, results.idleRss);
if (results.coldStart) record('M-cold-start', 'INFO', `warm relaunch (signed in): first contentful paint of the app ${results.coldStart.firstContentfulPaintSinceSpawn} ms after spawn, seeded series visible at ${results.coldStart.seededSeriesVisibleSinceSpawn} ms; first launch (initdb) app FCP ${results.firstLaunch?.firstPaint?.firstContentfulPaintSinceSpawn} ms`, { coldStart: results.coldStart, firstLaunch: results.firstLaunch, appTimeline: results.appTimeline });
