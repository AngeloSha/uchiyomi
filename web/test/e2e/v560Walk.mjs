// Browser acceptance walk for v0.56.0 — Discover shows one card per work, with every source's icon, and nothing the
// library holds while browsing.
//
// Two fake sources name one series differently ("Disc Solo Leveling" on fake-a, "Disc Only I Level Up" on fake-b; the
// fake AniList knows both names as one entry), and both carry "Disc Held Tale", which the walk adds to the library first
// (fakeSource.mjs `--extra v56`, fakeAniList.mjs's 970003):
//   1. Newest: the two names become ONE card carrying both sources' icons once the server's name lookup answers -- the
//      page asks again by itself (GET /api/discover/works), no reload -- and Disc Held Tale is not on the wall;
//   2. search "Disc": Disc Held Tale is there, marked In library; the renamed series is one card with two icons;
//   3. Admin → Settings offers "Match Discover titles online";
//   4. no console errors along the way.
//
//   KEEP=1 E2E_NET=uchiyomi-e2e-560 E2E_PORT=18560 E2E_SUBNET=10.222.56.0/24 E2E_ANILIST=1 E2E_FAKE_EXTRA=v56 E2E_NO_WALK=1 bash web/test/e2e/up.sh
//   cd web && BASE=http://127.0.0.1:18560 node test/e2e/v560Walk.mjs
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:18560';
const USER = process.env.E2E_USER || 'e2e';
const PASS = process.env.E2E_PASS || 'e2e-passw0rd-123';
const WIDTH = Number(process.env.WIDTH || 1280);
const OUT = process.env.OUT || 'shots560';
mkdirSync(OUT, { recursive: true });

const failures = [];
const ok = (message) => console.log(`    [ ok ] ${message}`);
const bad = (message) => { failures.push(message); console.log(`    [FAIL] ${message}`); };
const check = (yes, pass, fail = pass) => (yes ? ok(pass) : bad(fail));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (fn, ms = 10_000, step = 250) => {
  const started = Date.now();
  let value;
  while (Date.now() - started < ms) { value = await fn(); if (value) return value; await sleep(step); }
  return value;
};

let token = '';
async function api(path, init = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const raw = await r.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
  return { status: r.status, body };
}

const RENAMED = /^Disc (Solo Leveling|Only I Level Up)$/;
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
let phase = 'start';
let restoreMangaDex = false;
try {
  const login = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) });
  if (!login.ok) throw new Error(`API login ${login.status}`);
  token = (await login.json()).accessToken;
  for (const id of ['fake-a', 'fake-b']) {
    await api(`/api/admin/sources/${id}/enable`, { method: 'POST' });
    await api(`/api/admin/sources/${id}/unblock`, { method: 'POST' });
  }
  // The wall is the two fakes': MangaDex points at the fake AniList's empty stand-in here anyway (up.sh).
  await api('/api/admin/sources/mangadex/disable', { method: 'POST' });
  restoreMangaDex = true;
  const setting = await api('/api/admin/settings', { method: 'PATCH', json: { discoverLookups: true } });
  check(setting.status === 200, 'the online lookups are on', `PATCH discoverLookups answered ${setting.status}`);
  const add = await api('/api/sources/add', { method: 'POST', json: { source: 'fake-a', sourceId: 'disc-held', chapterFrom: 'none' } });
  check(add.status === 200, 'Disc Held Tale added to the library', `the add answered ${add.status}: ${JSON.stringify(add.body).slice(0, 200)}`);

  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: 900, deviceScaleFactor: 1 });
  await page.setBypassServiceWorker(true);
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/401|404|409|429/.test(m.text())) consoleErrors.push(`[${phase}] ${m.text().slice(0, 180)}`); });
  page.on('pageerror', (e) => consoleErrors.push(`[${phase}] ${String(e).slice(0, 180)}`));
  let shotNo = 0;
  const shot = (name) => page.screenshot({ path: `${OUT}/${String(++shotNo).padStart(2, '0')}-${name}.png` });
  /** Every card on the page: its title, its icon count (data-source-stack) and whether it says In library. */
  const cards = () => page.evaluate(() => [...document.querySelectorAll('[data-source-stack]')].map((stack) => {
    const card = stack.closest('a, button');
    return {
      title: card?.querySelector('p')?.textContent?.trim() || '',
      icons: Number(stack.getAttribute('data-source-stack')),
      held: /In library/.test(card?.textContent || ''),
    };
  }));
  const clickText = async (re, selector = 'button') => {
    const handle = await page.evaluateHandle((sel, source) => {
      const rx = new RegExp(source, 'i');
      return [...document.querySelectorAll(sel)].find((el) => el.offsetParent !== null && rx.test((el.textContent || '').trim())) || null;
    }, selector, re.source);
    const el = handle.asElement();
    if (!el) throw new Error(`no visible ${selector} matching ${re}`);
    await el.click();
  };

  phase = 'login';
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60_000 });
  await page.waitForSelector('input[type=password]', { timeout: 30_000 });
  await sleep(2500);
  const fields = await page.$$('input');
  await fields[0].type(USER);
  await page.type('input[type=password]', PASS);
  await page.keyboard.press('Enter');
  await waitFor(async () => !(await page.$('input[type=password]')), 20_000);
  check(!(await page.$('input[type=password]')), 'signed in');

  // ---- 1. Newest ----
  phase = 'newest';
  await page.goto(`${BASE}/discover/`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await waitFor(async () => (await cards()).some((c) => RENAMED.test(c.title)), 30_000);
  const first = (await cards()).filter((c) => RENAMED.test(c.title));
  console.log(`    first paint: ${first.length} card(s) for the renamed series (${first.map((c) => `${c.title} x${c.icons}`).join(', ')})`);
  await shot('newest-first-paint');
  // The server asks the fake AniList in the background (a few seconds a name); the page asks again every 20 s.
  const folded = await waitFor(async () => {
    const mine = (await cards()).filter((c) => RENAMED.test(c.title));
    return mine.length === 1 && mine[0].icons === 2 ? mine : null;
  }, 150_000, 1000);
  check(!!folded, `the two names are one card with both sources' icons (${folded?.[0]?.title})`,
    `still ${JSON.stringify((await cards()).filter((c) => RENAMED.test(c.title)))}`);
  const wall = await cards();
  check(!wall.some((c) => c.title === 'Disc Held Tale'), 'what the library holds is not on the wall', 'Disc Held Tale is on the wall');
  check(wall.some((c) => c.title === 'Walk Tale'), 'the wall still shows the rest');
  await shot('newest-folded');

  // ---- 2. Search ----
  phase = 'search';
  const input = await page.waitForSelector('input[aria-label="Search all sources…"]', { timeout: 20_000 });
  await input.type('Disc');
  await clickText(/^Search$/);
  // Search folds by the same keys, and asks again for its own unplaced names every 20 s while the server is looking.
  const found = await waitFor(async () => {
    const all = await cards();
    const renamed = all.filter((c) => RENAMED.test(c.title));
    return all.some((c) => c.title === 'Disc Held Tale') && renamed.length === 1 && renamed[0].icons === 2 ? all : null;
  }, 90_000, 1000);
  const held = found?.find((c) => c.title === 'Disc Held Tale');
  check(!!held?.held, 'search still finds what you hold, marked In library', `search: ${JSON.stringify(found ?? await cards())}`);
  const renamed = (found ?? []).filter((c) => RENAMED.test(c.title));
  check(renamed.length === 1 && renamed[0].icons === 2, 'search shows the renamed series as one card with two icons', `search cards: ${JSON.stringify(renamed)}`);
  await shot('search');

  // ---- 3. The switch ----
  phase = 'settings';
  await page.goto(`${BASE}/admin/?tab=Settings`, { waitUntil: 'networkidle2', timeout: 60_000 });
  const hasSwitch = await waitFor(async () => (await page.evaluate(() => document.body.innerText || '')).includes('Match Discover titles online'), 15_000);
  check(!!hasSwitch, 'Admin → Settings offers "Match Discover titles online"');

  check(consoleErrors.length === 0, 'no console errors along the way', `console: ${consoleErrors.join(' | ')}`);
} catch (e) {
  bad(`[${phase}] ${e?.stack || e}`);
} finally {
  if (restoreMangaDex) await api('/api/admin/sources/mangadex/enable', { method: 'POST' }).catch(() => {});
  await browser.close();
}
console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall ok');
process.exit(failures.length ? 1 : 0);
