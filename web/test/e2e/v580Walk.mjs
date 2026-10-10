// Browser acceptance walk for v0.58.0 — outside ratings beside your own, the new Library sorts, Home's Most popular
// rail, and Discover asking every source.
//
// Three series get a checked AniList link and a score row (the background refresh's table, written directly so the
// walk does not wait for it): Mixed Formats 500K people / 70 %, Walk Tale 80K / 80 %, Repeated Pages 1.2K / 90 %.
//   1. Library sorted by Most popular: Mixed Formats, Walk Tale, Repeated Pages, each card saying its number; by Top
//      rated: Repeated Pages, Walk Tale, Mixed Formats;
//   2. Home's "Most popular in your library" rail, in the same order, each card with AniList's score;
//   3. the series page shows "AniList 70% · 500K" beside the reader's own stars, which stay;
//   4. Discover's wall fills from every source and its Still loading tile is gone once they have all answered;
//   5. no console errors along the way.
//
//   KEEP=1 E2E_NET=uchiyomi-e2e-580 E2E_PORT=18580 E2E_SUBNET=10.222.58.0/24 E2E_ANILIST=1 E2E_NO_WALK=1 bash web/test/e2e/up.sh
//   cd web && E2E_NET=uchiyomi-e2e-580 BASE=http://127.0.0.1:18580 node test/e2e/v580Walk.mjs
import puppeteer from 'puppeteer';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:18580';
const NET = process.env.E2E_NET || 'uchiyomi-e2e-580';
const USER = process.env.E2E_USER || 'e2e';
const PASS = process.env.E2E_PASS || 'e2e-passw0rd-123';
const OUT = process.env.OUT || 'shots580';
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
const sql = (text) => execFileSync('docker', ['exec', `${NET}-db`, 'psql', '-U', 'postgres', '-d', 'yomi', '-tAqc', text], { encoding: 'utf8' }).trim();
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

let token = '';
async function api(path, init = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
    headers: { authorization: `Bearer ${token}`, ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const raw = await r.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
  return { status: r.status, body };
}

const TITLES = { pop: ['Mixed Formats', 'Walk Tale', 'Repeated Pages'], top: ['Repeated Pages', 'Walk Tale', 'Mixed Formats'] };
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
let phase = 'start';
try {
  const login = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) });
  if (!login.ok) throw new Error(`API login ${login.status}`);
  token = (await login.json()).accessToken;
  for (const id of ['fake-a', 'fake-b']) {
    await api(`/api/admin/sources/${id}/enable`, { method: 'POST' });
    await api(`/api/admin/sources/${id}/unblock`, { method: 'POST' });
  }

  // ---- the outside numbers ----
  phase = 'setup';
  const add = await api('/api/sources/add', { json: { source: 'fake-a', sourceId: 'walk-tale', chapterFrom: 'none' } });
  check(add.status === 200 || add.status === 409, 'Walk Tale in the library', `add answered ${add.status}`);
  const idOf = (title) => sql(`SELECT id FROM lib_series WHERE title = ${lit(title)} AND deleted_at IS NULL AND merged_into IS NULL LIMIT 1`);
  const ids = Object.fromEntries(await Promise.all(TITLES.pop.map(async (t) => [t, await waitFor(() => idOf(t), 30_000, 500)])));
  check(TITLES.pop.every((t) => ids[t]), 'the three series are there', JSON.stringify(ids));
  const nums = { 'Mixed Formats': ['990001', 70, 500000], 'Walk Tale': ['990002', 80, 80000], 'Repeated Pages': ['990003', 90, 1200] };
  for (const [title, [al, score, pop]] of Object.entries(nums)) {
    sql(`INSERT INTO series_trackers (series_id, provider, external_id, checked_at) VALUES (${lit(ids[title])}, 'anilist', ${lit(al)}, now())
         ON CONFLICT (series_id, provider) DO UPDATE SET external_id = EXCLUDED.external_id, checked_at = now()`);
    sql(`INSERT INTO anilist_scores (anilist_id, score, popularity, fetched_at) VALUES (${lit(al)}, ${score}, ${pop}, now())
         ON CONFLICT (anilist_id) DO UPDATE SET score = EXCLUDED.score, popularity = EXCLUDED.popularity, fetched_at = now()`);
  }
  const rate = await api(`/api/ratings/${encodeURIComponent(ids['Mixed Formats'])}`, { method: 'PUT', json: { stars: 4 } });
  check(rate.status === 200 || rate.status === 204, 'my own stars on Mixed Formats', `rating answered ${rate.status}`);

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.setBypassServiceWorker(true);
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/401|404|409|429/.test(m.text())) consoleErrors.push(`[${phase}] ${m.text().slice(0, 180)}`); });
  page.on('pageerror', (e) => consoleErrors.push(`[${phase}] ${String(e).slice(0, 180)}`));
  let shotNo = 0;
  const shot = (name) => page.screenshot({ path: `${OUT}/${String(++shotNo).padStart(2, '0')}-${name}.png` });

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

  /**
   * Cards carrying a value line, in page order (within `root` when given): [title, value]. The Library's tiles mark it
   * data-sort-value and Home's cards data-card-note; numbers come wrapped in bidi isolates (U+2066-2069, so "312K"
   * keeps its place in Arabic), which a reader never sees and the comparison drops.
   */
  const valued = (root) => page.evaluate((sel) => {
    const plain = (t) => (t || '').replace(/[\u2066-\u2069]/g, '').trim();
    const scope = sel ? [...document.querySelectorAll('section')].find((s) => (s.querySelector('h2, h3')?.textContent || '').includes(sel)) : document;
    return [...(scope?.querySelectorAll('[data-sort-value], [data-card-note]') || [])]
      .map((v) => [plain(v.previousElementSibling?.textContent), plain(v.textContent)]);
  }, root ?? null);
  const pageText = () => page.evaluate(() => (document.body.innerText || '').replace(/[\u2066-\u2069]/g, ''));
  const ours = (rows) => rows.filter(([t]) => TITLES.pop.includes(t));

  // ---- 1. the Library's new sorts ----
  phase = 'library';
  await page.goto(`${BASE}/library/?sort=popular`, { waitUntil: 'networkidle2', timeout: 60_000 });
  const pop = await waitFor(async () => { const r = ours(await valued()); return r.length === 3 ? r : null; }, 20_000, 500);
  check(JSON.stringify(pop?.map(([t]) => t)) === JSON.stringify(TITLES.pop), 'Most popular: the most listed first', `order: ${JSON.stringify(pop)}`);
  check(pop?.[0]?.[1] === '500K on AniList', 'each card says its number', `values: ${JSON.stringify(pop)}`);
  await shot('library-popular');
  await page.goto(`${BASE}/library/?sort=score`, { waitUntil: 'networkidle2', timeout: 60_000 });
  const top = await waitFor(async () => { const r = ours(await valued()); return r.length === 3 ? r : null; }, 20_000, 500);
  check(JSON.stringify(top?.map(([t]) => t)) === JSON.stringify(TITLES.top), 'Top rated: the best scored first', `order: ${JSON.stringify(top)}`);
  check(top?.[0]?.[1] === '90% on AniList', 'and says the score', `values: ${JSON.stringify(top)}`);

  // ---- 2. Home ----
  phase = 'home';
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60_000 });
  const rail = await waitFor(async () => { const r = ours(await valued('Most popular in your library')); return r.length === 3 ? r : null; }, 20_000, 500);
  check(JSON.stringify(rail?.map(([t]) => t)) === JSON.stringify(TITLES.pop), "Home's Most popular rail, most listed first", `rail: ${JSON.stringify(rail)}`);
  check(rail?.[0]?.[1] === '70% on AniList', "with AniList's score on each card", `rail: ${JSON.stringify(rail)}`);
  const seeAll = await page.evaluate(() => [...document.querySelectorAll('section')].find((s) => (s.textContent || '').includes('Most popular in your library'))
    ?.querySelector('a[href*="sort=popular"]')?.getAttribute('href') || null);
  check(!!seeAll, 'See all opens the Library sorted by popularity', `href: ${seeAll}`);
  await shot('home');

  // ---- 3. the series page ----
  phase = 'series';
  await page.goto(`${BASE}/series/?id=${encodeURIComponent(ids['Mixed Formats'])}`, { waitUntil: 'networkidle2', timeout: 60_000 });
  const line = await waitFor(async () => { const t = await pageText(); return /AniList 70% · 500K/.test(t) ? t : null; }, 20_000, 500);
  check(!!line, 'the series page shows AniList 70% · 500K');
  check(/4\/5/.test(line || ''), 'beside the reader\'s own stars, which stay');
  await shot('series');

  // ---- 4. Discover ----
  phase = 'discover';
  await page.goto(`${BASE}/discover/`, { waitUntil: 'networkidle2', timeout: 60_000 });
  const settled = await waitFor(async () => {
    const t = await pageText();
    // Walk Gap: Walk Tale is in the library now, and the wall leaves out what the library holds (v0.56.0).
    return t.includes('Walk Gap') && !t.includes('Still loading') ? t : null;
  }, 90_000, 1000);
  check(!!settled, 'the wall fills and its Still loading tile goes once every source has answered');
  await shot('discover');

  check(consoleErrors.length === 0, 'no console errors along the way', `console: ${consoleErrors.join(' | ')}`);
} catch (e) {
  bad(`[${phase}] ${e?.stack || e}`);
} finally {
  await browser.close();
}
console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall ok');
process.exit(failures.length ? 1 : 0);
