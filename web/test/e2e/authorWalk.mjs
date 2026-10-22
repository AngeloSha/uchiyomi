// Browser acceptance walk for v0.100.0 (#338): find more by an author.
//
// Three series get author lines an admin could have typed (series_overrides, the layer Edit details writes):
// Repeated Pages "Chugong (추공), Gi So-Ryeong (기소령)", Mixed Formats "추공" (the same person, his other spelling), and a
// third series "John Oh" (a name with "Oh" inside, nobody else's).
//   1. the series page shows each name of the line as its own link, under the title, in the reader's words;
//   2. tapping "Chugong (추공)" opens the Library on `?author=`: an Author chip, "2 series match", Repeated Pages and
//      Mixed Formats and not the third; the chip's × brings the whole shelf back;
//   3. the Library's search finds a series by a name on its author line ("기소령");
//   4. on a phone the links wrap with the line and open the same shelf; in Arabic the names keep their order inside;
//   5. no console errors along the way.
//
//   KEEP=1 E2E_NET=uchiyomi-e2e-0100 E2E_PORT=18400 E2E_SUBNET=10.222.100.0/24 E2E_NO_WALK=1 bash web/test/e2e/up.sh
//   cd web && E2E_NET=uchiyomi-e2e-0100 BASE=http://127.0.0.1:18400 node test/e2e/authorWalk.mjs
import puppeteer from 'puppeteer';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:18400';
const NET = process.env.E2E_NET || 'uchiyomi-e2e-0100';
const USER = process.env.E2E_USER || 'e2e';
const PASS = process.env.E2E_PASS || 'e2e-passw0rd-123';
const OUT = process.env.OUT || 'shots0100';
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
/** Text as a reader sees it: the bidi isolates around a name (U+2066-2069) dropped, spaces folded. */
const plain = (t) => String(t ?? '').replace(/[⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();

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
  await p.waitForSelector('input[type=password]', { timeout: 30_000 });
  await sleep(2500); // the form renders again once /auth/config answers; typing before that is lost
  await (await p.$$('input'))[0].type(USER);
  await p.type('input[type=password]', PASS);
  await p.keyboard.press('Enter');
  await waitFor(async () => !(await p.$('input[type=password]')), 20_000);
  return !(await p.$('input[type=password]'));
};
/** The author links on a series page: [name, href]. */
const authorLinks = (p) => p.evaluate(() => [...document.querySelectorAll('[data-series-authors] a[data-series-author]')]
  .map((a) => [a.textContent, a.getAttribute('href')]));
/** The series ids the Library grid shows, in order. */
const gridIds = (p) => p.evaluate(() => [...document.querySelectorAll('main [data-library-grid] a[href*="/series/"]')]
  .map((a) => new URL(a.getAttribute('href'), location.href).searchParams.get('id')));
const countLine = (p) => p.evaluate(() => document.querySelector('[data-library-count]')?.textContent ?? '');

try {
  // ---- setup ----
  phase = 'setup';
  const idOf = (title) => sql(`SELECT id FROM lib_series WHERE title = ${lit(title)} AND deleted_at IS NULL AND merged_into IS NULL LIMIT 1`);
  const rp = await waitFor(() => idOf('Repeated Pages'), 30_000, 500);
  const mf = await waitFor(() => idOf('Mixed Formats'), 30_000, 500);
  const other = sql(`SELECT id FROM lib_series WHERE title NOT IN ('Repeated Pages', 'Mixed Formats') AND deleted_at IS NULL
                     AND merged_into IS NULL ORDER BY title LIMIT 1`);
  check(!!rp && !!mf && !!other, 'three series to name authors on', JSON.stringify({ rp, mf, other }));
  for (const [id, line] of [[rp, 'Chugong (추공), Gi So-Ryeong (기소령)'], [mf, '추공'], [other, 'John Oh']]) {
    sql(`INSERT INTO series_overrides (series_id, author) VALUES (${lit(id)}, ${lit(line)})
         ON CONFLICT (series_id) DO UPDATE SET author = EXCLUDED.author`);
  }

  const page = watch(await browser.newPage());
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.setBypassServiceWorker(true);
  let shotNo = 0;
  const shot = (name, p = page) => p.screenshot({ path: `${OUT}/${String(++shotNo).padStart(2, '0')}-${name}.png` });
  phase = 'login';
  check(await signIn(page), 'signed in');

  // ---- 1. the series page ----
  phase = 'series';
  await page.goto(`${BASE}/series/?id=${encodeURIComponent(rp)}`, { waitUntil: 'networkidle2', timeout: 60_000 });
  const links = await waitFor(async () => { const l = await authorLinks(page); return l.length ? l : null; }, 20_000, 300);
  check(JSON.stringify(links?.map(([n]) => n)) === JSON.stringify(['Chugong (추공)', 'Gi So-Ryeong (기소령)']),
    'each name on the author line is its own link', `links ${JSON.stringify(links)}`);
  const line = plain(await page.evaluate(() => document.querySelector('[data-series-authors]')?.textContent));
  check(line === 'by Chugong (추공) and Gi So-Ryeong (기소령)', `the line reads "${line}"`, `the line reads "${line}"`);
  await shot('series-authors');

  // ---- 2. the Library on one author ----
  phase = 'library';
  await page.click('[data-series-authors] a[data-series-author]');
  await waitFor(() => page.url().includes('author='), 15_000);
  const chip = await waitFor(async () => plain(await page.evaluate(() => document.querySelector('[data-chip-author]')?.textContent)), 15_000);
  check(chip === 'Author: Chugong (추공) ×', `the Library holds the author as a chip: "${chip}"`, `chip "${chip}" at ${page.url()}`);
  const ids = await waitFor(async () => { const g = await gridIds(page); return g.length === 2 ? g : null; }, 20_000, 300);
  check(!!ids && ids.includes(rp) && ids.includes(mf) && !ids.includes(other),
    'the shelf is Repeated Pages and Mixed Formats (the other spelling), not "John Oh"', `grid ${JSON.stringify(await gridIds(page))}`);
  check(/2 series match/.test(await countLine(page)), 'the count says "2 series match"', `count "${await countLine(page)}"`);
  await shot('library-author');
  await page.click('[data-chip-author]');
  await waitFor(() => !page.url().includes('author='), 10_000);
  const all = await waitFor(async () => { const g = await gridIds(page); return g.length > 2 ? g : null; }, 20_000, 300);
  check(!!all && all.includes(other), 'the chip\'s × brings the whole shelf back', `grid ${JSON.stringify(await gridIds(page))}`);

  // ---- 3. search by author ----
  phase = 'search';
  await page.click('[data-library-search]');
  await page.type('[data-library-search]', '기소령');
  const found = await waitFor(async () => { const g = await gridIds(page); return g.length === 1 ? g : null; }, 15_000, 300);
  check(JSON.stringify(found) === JSON.stringify([rp]), 'searching a name on the author line finds the series', `grid ${JSON.stringify(await gridIds(page))}`);
  await shot('library-search-author');

  // ---- 4. a phone, and Arabic ----
  phase = 'phone';
  const phone = watch(await browser.newPage());
  await phone.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await phone.setBypassServiceWorker(true);
  await phone.goto(`${BASE}/series/?id=${encodeURIComponent(rp)}`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await waitFor(async () => (await authorLinks(phone)).length === 2, 20_000, 300);
  const fits = await phone.evaluate(() => {
    const el = document.querySelector('[data-series-authors]');
    const r = el?.getBoundingClientRect();
    return !!r && r.left >= 0 && r.right <= window.innerWidth + 0.5 && document.documentElement.scrollWidth <= window.innerWidth;
  });
  check(fits, 'on a phone the author line stays inside the screen, with no sideways scroll');
  await shot('phone-series', phone);
  await phone.tap('[data-series-authors] a[data-series-author]');
  const phoneChip = await waitFor(async () => phone.$('[data-chip-author]'), 15_000);
  check(!!phoneChip, 'tapping a name on a phone opens the same shelf');
  await waitFor(async () => (await gridIds(phone)).length === 2, 15_000, 300);
  await shot('phone-library-author', phone);
  phase = 'arabic';
  await phone.evaluate(() => localStorage.setItem('uchiyomi.lang', 'ar'));
  await phone.goto(`${BASE}/series/?id=${encodeURIComponent(rp)}`, { waitUntil: 'networkidle2', timeout: 60_000 });
  const ar = await waitFor(async () => {
    const l = await authorLinks(phone);
    const text = plain(await phone.evaluate(() => document.querySelector('[data-series-authors]')?.textContent));
    return l.length === 2 && text.startsWith('تأليف') ? { l, text } : null;
  }, 20_000, 300);
  check(!!ar && ar.l[0][0] === 'Chugong (추공)', `in Arabic the line reads "${ar?.text}", each name whole`, `Arabic ${JSON.stringify(ar)}`);
  await shot('phone-series-ar', phone);
  await phone.evaluate(() => localStorage.removeItem('uchiyomi.lang'));
} catch (e) {
  bad(`walk stopped in ${phase}: ${String(e?.stack || e).slice(0, 400)}`);
} finally {
  await browser.close();
}
check(consoleErrors.length === 0, 'no console errors', `console errors: ${JSON.stringify(consoleErrors.slice(0, 5))}`);
console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
