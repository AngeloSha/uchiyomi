// v0.62.0's browser walk: chapters in the series' language, and one chapter's Fetch again / Delete from server.
//
//   KEEP=1 E2E_NO_WALK=1 E2E_NET=uchi-e2e-620 E2E_SUBNET=10.222.62.0/24 E2E_PORT=18162 bash web/test/e2e/up.sh
//   BASE=http://127.0.0.1:18162 E2E_NET=uchi-e2e-620 node test/e2e/v620Walk.mjs     (from web/)
//
// A series added from fake-a with four chapters, two of which the database then says are in Latin American Spanish
// (lib_books.lang, as v0.62.0's migration keeps it for a chapter English MangaDex fetched in another language), and a
// Spanish copy of chapter 3 in its stored listing. Then, at 1280 and 390 px:
//   - the notice above the chapter list counts the two and names the languages, and its key fetches them again: once
//     they have landed, the notice is gone and both rows are English (lib_books.lang cleared);
//   - the versions sheet marks the Spanish copy in amber;
//   - a downloaded chapter's ⋯ has Fetch again and Delete from server, and each asks first, about one chapter;
//   - a site added by address shows its language in its sheet, and the default when it says none.
import puppeteer from 'puppeteer';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:18162';
const NET = process.env.E2E_NET || 'uchi-e2e-620';
const USER = process.env.E2E_USER || 'e2e';
const PASS = process.env.E2E_PASS || 'e2e-passw0rd-123';
const OUT = process.env.OUT || 'shots620';
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
const plain = (t) => String(t ?? '').replace(/[⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();

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

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
let phase = 'start';
const consoleErrors = [];
const watch = (p) => {
  p.on('console', (m) => { if (m.type() === 'error' && !/401|404|409|429/.test(m.text())) consoleErrors.push(`[${phase}] ${m.text().slice(0, 180)}`); });
  p.on('pageerror', (e) => consoleErrors.push(`[${phase}] ${String(e).slice(0, 180)}`));
  return p;
};
const signIn = async (p) => {
  await p.goto(BASE, { waitUntil: 'networkidle2', timeout: 60_000 });
  // A second page shares the first one's session: nothing to type.
  if (!(await waitFor(() => p.$('input[type=password]'), 8_000))) return true;
  await sleep(2500); // the form renders again once /auth/config answers; typing before that is lost
  await (await p.$$('input'))[0].type(USER);
  await p.type('input[type=password]', PASS);
  await p.keyboard.press('Enter');
  await waitFor(async () => !(await p.$('input[type=password]')), 20_000);
  return !(await p.$('input[type=password]'));
};
let shotNo = 0;
const shot = (p, name) => p.screenshot({ path: `${OUT}/${String(++shotNo).padStart(2, '0')}-${name}.png` });
/** Open the ⋯ of the downloaded chapter `n` (its row is `#ch-<n>`); the menu's item labels, or null. */
const openMenu = async (p, n) => {
  const key = await p.$(`#ch-${n} button[aria-label="Chapter actions"]`);
  if (!key) return null;
  await key.evaluate((b) => b.scrollIntoView({ block: 'center' }));
  await sleep(600); // a menu closes on any scroll, and the scroll of scrollIntoView lands late
  await key.click();
  return waitFor(async () => {
    const t = await p.$$eval('[role="menu"] [role="menuitem"]', (els) => els.map((e) => (e.textContent || '').trim()));
    return t.length ? t : null;
  }, 5_000);
};
const pressItem = (p, label) => p.evaluate((label) => {
  const el = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((e) => (e.textContent || '').trim() === label);
  el?.click();
  return !!el;
}, label);

try {
  const login = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) });
  if (!login.ok) throw new Error(`API login ${login.status}`);
  token = (await login.json()).accessToken;
  for (const id of ['fake-a', 'fake-b']) {
    await api(`/api/admin/sources/${id}/enable`, { method: 'POST' });
    await api(`/api/admin/sources/${id}/unblock`, { method: 'POST' });
  }

  // ---- setup ----
  phase = 'setup';
  const add = await api('/api/sources/add', { json: { source: 'fake-a', sourceId: 'walk-tale', chapterFrom: 'oldest', chapterCount: 4, autoUpdate: false } });
  check(add.status < 300, 'added Walk Tale from fake-a, four chapters', `add answered ${add.status} ${JSON.stringify(add.body).slice(0, 200)}`);
  const id = await waitFor(() => sql(`SELECT id FROM lib_series WHERE source_id = 'fake-a' AND source_series_id = 'walk-tale' AND deleted_at IS NULL LIMIT 1`), 30_000, 500);
  const landed = await waitFor(() => Number(sql(`SELECT count(*) FROM lib_books WHERE series_id = ${lit(id)} AND pruned_at IS NULL`)) >= 4 || null, 60_000, 500);
  check(!!landed, 'its four chapters landed');
  // Chapters 1 and 2 in Latin American Spanish, as the migration keeps a chapter English MangaDex fetched in another.
  sql(`UPDATE lib_books SET lang = 'es-419' WHERE series_id = ${lit(id)} AND number IN (1, 2)`);
  // A Spanish copy of chapter 3 beside the English one: the versions sheet's amber tag.
  sql(`UPDATE series_listing SET copies = copies || ${lit(JSON.stringify([{ source: 'fake-a', sourceId: 'walk-tale-3-es', groups: ['Esp Scans'], scanlator: 'Esp Scans', lang: 'es', pages: 12, publishedAt: null, title: 'Capítulo 3' }]))}::jsonb
       WHERE series_id = ${lit(id)} AND number = 3`);
  const v = await api(`/api/series/${encodeURIComponent(id)}/versions`);
  check(v.body?.otherLanguage?.bookIds?.length === 2, 'the versions route lists the two Spanish chapters', JSON.stringify(v.body?.otherLanguage));
  // A site added by address, written as the add writes one (the walk has no site to fetch), and one in Spanish.
  execFileSync('docker', ['exec', NET, 'sh', '-c', `cat > /config/sites.json <<'EOF'
[{"engine":"madara","id":"walksite","name":"Walk Site","base":"https://walk-site.invalid","order":100},
 {"engine":"madara","id":"walksitees","name":"Walk Sitio","base":"https://walk-sitio.invalid","order":100,"lang":"es"}]
EOF`]);
  const reload = await api('/api/admin/sources/reload', { method: 'POST' });
  check(reload.status < 300, 'the sources reloaded with the two sites', `reload ${reload.status}`);

  for (const width of [1280, 390]) {
    const page = watch(await browser.newPage());
    await page.setViewport({ width, height: width > 500 ? 900 : 844, deviceScaleFactor: width > 500 ? 1 : 2 });
    await page.setBypassServiceWorker(true);
    phase = `login ${width}`;
    check(await signIn(page), `signed in at ${width}`);

    // ---- 1. the notice ----
    phase = `notice ${width}`;
    await page.goto(`${BASE}/series/?id=${encodeURIComponent(id)}`, { waitUntil: 'networkidle2', timeout: 60_000 });
    const notice = await waitFor(() => page.$('[data-language-notice]'), 15_000);
    check(!!notice, `the notice is on the series page (${width})`);
    const words = notice ? plain(await page.$eval('[data-language-notice]', (el) => el.textContent)) : '';
    check(/2 chapters here are in Latin American Spanish/.test(words) && /Fetch them again in English/.test(words),
      `it says what and offers the key: "${words}"`);
    if (notice) {
      await page.evaluate(() => document.querySelector('[data-language-notice]')?.scrollIntoView({ block: 'center' }));
      await sleep(400);
      await shot(page, `notice-${width}`);
    }

    if (width === 1280) {
      // ---- 2. the versions sheet's amber tag ----
      phase = 'versions';
      const opened = (await openMenu(page, 3)) && (await pressItem(page, 'Versions'));
      if (opened) {
        const tag = await waitFor(() => page.$('[data-copy-other-language]'), 8_000);
        check(!!tag, 'the versions sheet marks the Spanish copy');
        if (tag) check(plain(await page.$eval('[data-copy-other-language]', (el) => el.textContent)) === 'Spanish', 'its tag names the language');
        await sleep(300);
        await shot(page, 'versions-tag');
        await page.keyboard.press('Escape');
        await sleep(500);
      } else bad('no row of chapter 3 opens its versions');

      // ---- 3. one chapter's ⋯ ----
      phase = 'menu';
      const items = await openMenu(page, 1);
      if (items) {
        check(items.includes('Fetch again') && items.includes('Delete from server'), `the menu offers both: ${JSON.stringify(items)}`);
        await shot(page, 'chapter-menu');
        if (await pressItem(page, 'Delete from server')) {
          const dlg = await waitFor(() => page.$('[role="dialog"], [role="alertdialog"]'), 5_000);
          const title = dlg ? plain(await page.evaluate((el) => el.textContent, dlg)) : '';
          check(/Delete 1 chapter from the server\?/.test(title), 'Delete asks first, about one chapter', title.slice(0, 120));
          await shot(page, 'delete-confirm');
          await page.keyboard.press('Escape');
          await sleep(400);
        }
      } else bad('no chapter row has a ⋯');
    }
    await page.close();
  }

  // ---- 4. Fetch them again ----
  phase = 'refetch';
  const page = watch(await browser.newPage());
  await page.setViewport({ width: 1280, height: 900 });
  await page.setBypassServiceWorker(true);
  await signIn(page);
  await page.goto(`${BASE}/series/?id=${encodeURIComponent(id)}`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await waitFor(() => page.$('[data-language-notice-fetch]'), 15_000);
  await page.click('[data-language-notice-fetch]');
  // ⚠️ The notice goes at once, while each old file is set aside (its row a tombstone until the new one lands): wait for
  // the rows to be live again, and only then believe it gone.
  const back = await waitFor(() => sql(`SELECT count(*) FROM lib_books WHERE series_id = ${lit(id)} AND number IN (1, 2)
                                         AND pruned_at IS NULL AND lang IS NULL AND source_id = 'fake-a'`) === '2' || null, 60_000, 1000);
  check(!!back, 'both chapters landed again on their own rows, in their source\'s language');
  await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 });
  await sleep(1500);
  check(!(await page.$('[data-language-notice]')), 'and the notice is gone for good');
  await shot(page, 'after-refetch');
  await page.close();

  // ---- 5. a site's language ----
  phase = 'site';
  for (const width of [390, 1280]) {
    const p = watch(await browser.newPage());
    await p.setViewport({ width, height: width > 500 ? 900 : 844, deviceScaleFactor: width > 500 ? 1 : 2 });
    await p.setBypassServiceWorker(true);
    await signIn(p);
    for (const [site, lang, def] of [['walksitees', 'es', false], ['walksite', 'en', true]]) {
      await p.goto(`${BASE}/admin/?tab=Sources&source=${site}`, { waitUntil: 'networkidle2', timeout: 60_000 });
      const row = await waitFor(() => p.$('[data-source-language]'), 15_000);
      check(!!row, `${site}'s sheet has its language (${width})`);
      if (!row) continue;
      const value = await p.$eval('[data-source-language-pick]', (s) => s.value);
      check(value === lang, `${site} reads ${lang}`, `${site} reads ${value}`);
      check(!!(await p.$('[data-source-language-default]')) === def, def ? 'and says it is the default' : 'and not that it is the default');
      await p.evaluate(() => document.querySelector('[data-source-language]')?.scrollIntoView({ block: 'center' }));
      await sleep(400);
      await shot(p, `site-${site}-${width}`);
    }
    await p.close();
  }
} catch (e) {
  bad(`${phase}: ${e?.stack || e}`);
} finally {
  await browser.close();
}
if (consoleErrors.length) { console.log('console errors:'); for (const e of consoleErrors) console.log(`  ${e}`); }
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
process.exit(failures.length ? 1 : 0);
