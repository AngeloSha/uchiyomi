// Browser walk for translated pages (v0.85.0), with the REAL engine: an admin turns Translate pages on, a reader turns it
// on for a raw series, and the pages switch to their translations as the server finishes them. Not run in CI (the
// engine is a multi-gigabyte download); run it before a release that touches lib/translate/ or the reader's part.
//
// Needs an instance of its own whose TRANSLATE_DIR holds an installed engine (Admin -> Settings -> Download, or a copy
// of one: pack/, models/<size>/ and installed.json), its library folder, and a folder of raw pages to read:
//
//   KEEP=1 E2E_NET=uchiyomi-e2e-tr E2E_PORT=18270 E2E_SUBNET=10.222.170.0/24 E2E_NO_WALK=1 \
//     E2E_TRANSLATE_DIR=<the engine folder> bash web/test/e2e/up.sh
//   cd web && npm i --no-save playwright && npx playwright install chromium webkit
//   LIB=<library folder> PAGES=<folder of .jpg/.png pages> SRC_LANG=ja BASE=http://127.0.0.1:18270 ENGINE=chromium \
//     node test/e2e/walkTranslate.mjs
//
// ⚠️ Service workers are blocked: the walk reads the reader's own image requests.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let pw;
try {
  pw = await import('playwright');
} catch {
  console.error('walkTranslate drives Playwright: in web/, `npm i --no-save playwright && npx playwright install chromium webkit` first');
  process.exit(2);
}

const BASE = process.env.BASE || 'http://127.0.0.1:18270';
const USER = process.env.E2E_USER || 'e2e';
const PASS = process.env.E2E_PASS || 'e2e-passw0rd-123';
const { LIB, PAGES } = process.env;
const SRC_LANG = process.env.SRC_LANG || 'ja';
const ENGINE = process.env.ENGINE || 'chromium';
const OUT = process.env.OUT || `shots-translate-${ENGINE}`;
/** How long the first translated page may take: the model loads from disk first (90 s for 18 GB from a hard disk). */
const FIRST_MS = Number(process.env.FIRST_MS || 6 * 60_000);
if (!LIB || !PAGES) { console.error('LIB (the instance\'s library folder) and PAGES (raw pages) are both needed'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`  [${ok ? ' ok ' : 'FAIL'}] ${name}${!ok && detail ? `\n         ${detail}` : ''}`);
};

// ---- the fixture: one raw chapter of the given pages ----
const TITLE = `Walk Translate ${SRC_LANG}`;
const folder = join(LIB, TITLE);
mkdirSync(folder, { recursive: true });
const pages = readdirSync(PAGES).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
execFileSync('python3', ['-c', `
import sys, zipfile, os
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_STORED) as z:
    for i, f in enumerate(sys.argv[3:]):
        z.write(os.path.join(src, f), '%03d%s' % (i + 1, os.path.splitext(f)[1].lower()))
`, PAGES, join(folder, 'Chapter 1.cbz'), ...pages]);

const login = await (await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) })).json();
const TOKEN = login.accessToken;
const api = async (path, opts = {}) => {
  const r = await fetch(BASE + path, { ...opts, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } });
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};
let sid = null;
for (let i = 0; i < 24 && !sid; i++) {
  await api('/api/refresh', { method: 'POST', body: '{}' }).catch(() => {});
  sid = (await api('/api/series/search', { method: 'POST', body: JSON.stringify({ query: '', size: 100 }) })).content.find((s) => s.name === TITLE)?.id ?? null;
  if (!sid) await sleep(5000);
}
if (!sid) { console.error('the scan did not list the walk\'s series'); process.exit(1); }
await api(`/api/admin/series/${sid}`, { method: 'PATCH', body: JSON.stringify({ lang: SRC_LANG }) });
const book = (await api(`/api/series/${sid}/books?size=5`)).content[0];
// Fresh: nothing translated, the switch off.
await api('/api/admin/translate', { method: 'PUT', body: JSON.stringify({ enabled: false }) });

// The reader as walk263 sets it: the account's copy and this browser's, the webtoon column, nothing automatic.
const PREFS = { junkPages: 'show', skipJunk: false, gap: 0, brightness: 1, mode: 'vertical', autoScroll: 0, fitWidth: true, theme: 'amoled', spread: false, pagedDirection: 'ltr', widePages: 'whole', cropBorders: false, autoMode: false };
await api('/api/settings', { method: 'PUT', body: JSON.stringify({ reader: PREFS, readerSeries: {}, readerSource: {} }) });

const browser = await pw[ENGINE].launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForSelector('input[type=password]', { timeout: 30000 });
await sleep(2500); // the form renders again once /auth/config answers; typing before that is lost
await page.locator('input').first().fill(USER);
await page.locator('input[type=password]').fill(PASS);
await page.keyboard.press('Enter');
await sleep(4000);
check('signed in', !(await page.$('input[type=password]')));
await page.evaluate((p) => {
  for (const k of Object.keys(localStorage)) if (k.startsWith('yomi_rs_') || k.startsWith('yomi_rp_')) localStorage.removeItem(k);
  localStorage.setItem('yomi_reader_prefs', JSON.stringify(p));
}, PREFS);

console.log('1. Admin -> Settings: the engine is ready, and one switch turns it on');
await page.goto(`${BASE}/admin/?tab=Settings`);
const row = page.locator('[data-translate-engine="ready"]');
await row.waitFor({ timeout: 30_000 });
await row.scrollIntoViewIfNeeded();
await page.screenshot({ path: join(OUT, '1-settings-off.png') });
await row.getByRole('switch', { name: 'Translate pages' }).click();
let offered = false;
for (let i = 0; i < 20 && !offered; i++) { offered = (await api('/api/translate')).available; if (!offered) await sleep(300); }
check('the switch turns it on for the server', offered);
await page.screenshot({ path: join(OUT, '1-settings-on.png') });

console.log('2. The reader: Translate pages, for this series');
const asked = [];
page.on('request', (r) => { if (/\/img\/books\/[^/]+\/page\/\d+/.test(r.url())) asked.push(r.url()); });
await page.goto(`${BASE}/reader/?book=${book.id}`);
await page.waitForSelector('[data-page]', { timeout: 30_000 });
await page.mouse.click(640, 450);
await page.locator('[data-reader-settings]').click();
const sw = page.locator('[data-reader-translate]').getByRole('switch');
check('the switch is offered', await sw.count() === 1);
await page.screenshot({ path: join(OUT, '2-reader-settings.png') });
const t0 = Date.now();
await sw.click();
await page.keyboard.press('Escape');
await page.mouse.click(10, 450).catch(() => {});

console.log('3. Pages switch to their translations as they are done');
let first = 0;
while (Date.now() - t0 < FIRST_MS) {
  // The translated picture itself, loaded: the address changes first, and the old picture stays until the new one is in.
  const src = await page.evaluate(() => [...document.images].find((i) => /[?&]tl=/.test(i.currentSrc || i.src) && /\/page\/1\b/.test(i.currentSrc || i.src) && i.complete && i.naturalWidth > 0)?.src ?? null);
  if (src) { first = Date.now() - t0; break; }
  await sleep(2000);
}
check(`page 1 shows translated (${Math.round(first / 1000)} s after the switch)`, first > 0);
const st = await api(`/api/books/${book.id}/translations?lang=en`);
console.log(`     done: ${Object.keys(st.pages).length}/${pages.length}, pending ${st.pending}, failed ${JSON.stringify(st.failed)}`);
await sleep(1500);
await page.screenshot({ path: join(OUT, '3-reader-translated.png') });
// The page itself, both ways, for the comparison.
for (const [name, q] of [['original', ''], ['translated', `?tl=en&tv=${st.pages['1']}`]]) {
  const r = await page.request.get(`${BASE}/img/books/${book.id}/page/1${q}`);
  writeFileSync(join(OUT, `page1-${name}.${(r.headers()['content-type'] || 'image/jpeg').split('/')[1]}`), await r.body());
}
check('a page not done yet was asked for as it is, never at a translated address', !asked.some((u) => /[?&]tl=/.test(u) && /tv=(undefined|)(&|$)/.test(u)));

console.log('4. The rest of the chapter, then the timings');
const tAll = Date.now();
let last = st;
while (last.pending > 0 && Date.now() - tAll < pages.length * 90_000) { await sleep(5000); last = await api(`/api/books/${book.id}/translations?lang=en`); }
const done = Object.keys(last.pages).length;
check(`every page translated (${done}/${pages.length}, failed ${JSON.stringify(last.failed)})`, done + last.failed.length === pages.length && last.failed.length === 0);
console.log(`     ${Math.round((Date.now() - t0) / 1000)} s for ${pages.length} pages, first page ${Math.round(first / 1000)} s`);
await page.reload();
await page.waitForSelector('[data-page]', { timeout: 30_000 });
await sleep(3000);
await page.screenshot({ path: join(OUT, '4-reader-all.png'), fullPage: false });

await api('/api/admin/translate', { method: 'PUT', body: JSON.stringify({ enabled: false }) });
await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} check(s) failed` : `all ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
