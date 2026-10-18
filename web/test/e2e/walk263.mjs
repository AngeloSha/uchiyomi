// Browser acceptance walk for the reader group of the 2026-10-15 pull requests (@Squeaks72): #263, #236, #233, #234.
//
//   1. #263 -- continuous reading moves the address with the chapter on screen, over three chapters (the first cut moved
//      it once: chapters[0] stayed the first chapter, so the second crossing was never written), and a refresh reopens
//      the chapter and page being read.
//   1b. -- crossing into the next chapter never reloads the page, even when the route comes back from another build
//      (a deploy since the page was loaded), so the chapter before stays on the track.
//   2. #263 -- a paged track whose width changes stays on its page.
//   3. #263 -- Wide pages: Split, the phone turned on a page after a split spread and on a spread itself: the split and
//      the width change in one turn, and the resize guard must not put back the slide read before the halves moved.
//      This is the step to run in WebKit (ENGINE=webkit): Safari keeps a snapped track's place as an index (#180).
//   4. #236 -- the next chapter's missing numbers are said, by the server's rule: 2 -> 5 says 3-4, a file holding 6 to 8
//      and the 9 after it say nothing, and `]` says it before it leaves.
//   5. #233 -- Column width · This device narrows the webtoon column.
//   6. #234 -- Fit pages to my screen is off until chosen; on, each page comes at the width it is drawn at -- more when
//      zoomed -- and a page already narrower comes as stored.
//
// Needs an instance of its OWN and its library folder, and Playwright (not a dependency of this package):
//
//   KEEP=1 E2E_NET=uchiyomi-e2e-263 E2E_PORT=18263 E2E_SUBNET=10.222.163.0/24 E2E_NO_WALK=1 bash web/test/e2e/up.sh
//   cd web && npm i --no-save playwright && npx playwright install webkit chromium
//   LIB=<the library folder up.sh printed> BASE=http://127.0.0.1:18263 ENGINE=webkit node test/e2e/walk263.mjs
//   ... and again with ENGINE=chromium (the instance can be reused: the walk resets what it changes).
//
// ⚠️ The reader adopts the account's copy of the reader settings on load and the server copy wins, so the settings are
// written BOTH to /api/settings and to localStorage (walk48.mjs says why). This device's settings are localStorage only.
// ⚠️ Service workers are blocked: the walk counts the reader's own requests.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let pw;
try {
  pw = await import('playwright');
} catch {
  console.error('walk263 drives Playwright: in web/, `npm i --no-save playwright && npx playwright install webkit chromium` first');
  process.exit(2);
}

const BASE = process.env.BASE || 'http://127.0.0.1:18263';
const USER = process.env.E2E_USER || 'e2e';
const PASS = process.env.E2E_PASS || 'e2e-passw0rd-123';
const LIB = process.env.LIB;
const ENGINE = process.env.ENGINE || 'webkit';
const OUT = process.env.OUT || `shots263-${ENGINE}`;
if (!LIB) { console.error('LIB must name the instance\'s library folder (up.sh prints it with KEEP=1)'); process.exit(2); }
if (!pw[ENGINE]) { console.error(`ENGINE must be webkit or chromium, not ${ENGINE}`); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`  [${ok ? ' ok ' : 'FAIL'}] ${name}${!ok && detail ? `\n         ${detail}` : ''}`);
};

// ---- the fixture, and an API session for the settings writes ----
execFileSync('python3', [join(dirname(fileURLToPath(import.meta.url)), 'seed.py'), LIB, '--reader'], { stdio: 'inherit' });
const login = await (await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) })).json();
const TOKEN = login.accessToken;
const api = async (path, opts = {}) => {
  const r = await fetch(BASE + path, { ...opts, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } });
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};
// A scan runs at most once a minute, and up.sh asks for one as it starts the instance: ask until one runs (walk48.mjs).
const seriesOf = async (name) => (await api('/api/series/search', { method: 'POST', body: JSON.stringify({ query: '', size: 100 }) })).content
  .find((s) => s.name === name)?.id ?? null;
let ids = {};
for (let i = 0; i < 24; i++) {
  const scan = await api('/api/refresh', { method: 'POST', body: '{}' });
  if (scan?.scanned || i > 0) {
    ids = { resume: await seriesOf('Walk Two Six Three Resume'), gaps: await seriesOf('Walk Two Six Three Gaps'), wide: await seriesOf('Walk Two Six Three Wide') };
    if (ids.resume && ids.gaps && ids.wide) break;
  }
  await sleep(5000);
}
if (!ids.resume || !ids.gaps || !ids.wide) { console.error(`the scan did not list the walk's series: ${JSON.stringify(ids)}`); process.exit(1); }
const chaptersOf = async (sid) => (await api(`/api/series/${sid}/books?size=50`)).content.sort((a, b) => a.number - b.number);
const R = (await chaptersOf(ids.resume)).map((b) => b.id);
const G = await chaptersOf(ids.gaps);
const W = (await chaptersOf(ids.wide)).map((b) => b.id);
const gapBook = (n) => G.find((b) => b.number === n)?.id;
check('the fixture: four Resume chapters, Gaps holding 1, 2, 5, 6-8 and 9, one Wide chapter',
  R.length === 4 && W.length === 1 && JSON.stringify(G.map((b) => [b.number, b.numberEnd ?? null])) === '[[1,null],[2,null],[5,null],[6,8],[9,null]]',
  JSON.stringify({ R: R.length, W: W.length, G: G.map((b) => [b.number, b.numberEnd]) }));
// The server's own answer, which the reader names runs from: 3-4 only (6-8 is one file's).
const gapRuns = await api(`/api/series/${ids.gaps}/gaps`);
check('GET /api/series/:id/gaps answers 3-4 and nothing for the range file', JSON.stringify(gapRuns.gaps) === '[{"lo":3,"hi":4}]', JSON.stringify(gapRuns));

// ---- the browser, signed in once (the login limit is 10 per five minutes) ----
const browser = await pw[ENGINE].launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
const page = await context.newPage();
const serverErrors = [];
const pageErrors = [];
/** Every page image the reader asked for: book, page and the query (?fit=). */
const images = [];
page.on('response', (r) => { if (r.status() >= 500) serverErrors.push(`${r.status()} ${r.url()}`); });
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('request', (r) => {
  const u = new URL(r.url());
  const m = u.pathname.match(/^\/img\/books\/([^/]+)\/page\/(\d+)$/);
  if (m) images.push({ book: decodeURIComponent(m[1]), page: Number(m[2]), fit: u.searchParams.get('fit'), w: u.searchParams.get('w') });
});
await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForSelector('input[type=password]', { timeout: 30000 });
await sleep(2500); // the form renders again once /auth/config answers; typing before that is lost
await page.locator('input').first().fill(USER);
await page.locator('input[type=password]').fill(PASS);
await page.keyboard.press('Enter');
await sleep(4000);
check('signed in', !(await page.$('input[type=password]')));

const BASE_PREFS = { junkPages: 'show', skipJunk: false, gap: 0, brightness: 1, mode: 'paged', autoScroll: 0, fitWidth: true, theme: 'amoled', spread: false, pagedDirection: 'ltr', widePages: 'whole', cropBorders: false, autoMode: false };
/** The account's reader settings and this device's, before the next page load. */
const settings = async (prefs, device = {}) => {
  const all = { ...BASE_PREFS, ...prefs };
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ reader: all, readerSeries: {}, readerSource: {} }) });
  await page.evaluate(([p, d]) => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('yomi_rs_') || k.startsWith('yomi_rp_')) localStorage.removeItem(k);
    localStorage.setItem('yomi_reader_prefs', JSON.stringify(p));
    localStorage.setItem('yomi_reader_device', JSON.stringify(d));
  }, [all, device]);
};

const TRACK = 'div.snap-x[dir]';
/** The address, what the reader says it reads (data-chapter, data-page), and the page on the slide in view. */
const where = () => page.evaluate((track) => {
  const root = document.querySelector('[data-chapter]');
  const el = document.querySelector(track);
  let shown = null;
  if (el) {
    const w = el.clientWidth;
    const slide = [...el.children].find((s) => { const r = s.getBoundingClientRect(); return r.left > -w / 2 && r.left < w / 2; });
    const src = slide?.querySelector('img')?.getAttribute('src') || '';
    const m = src.match(/\/img\/books\/([^/?]+)\/page\/(\d+)/);
    shown = m ? { book: decodeURIComponent(m[1]), page: Number(m[2]), half: slide.querySelector('[data-half]')?.getAttribute('data-half') ?? null } : null;
  }
  return { book: new URLSearchParams(location.search).get('book'), chapter: root?.getAttribute('data-chapter') ?? null, page: Number(root?.getAttribute('data-page') ?? 0), shown };
}, TRACK);
const open = async (book, pageNo) => {
  await page.goto(`${BASE}/reader/?book=${book}${pageNo ? `&page=${pageNo}` : ''}`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('[data-chapter]', { timeout: 20000 });
  await sleep(1800);
};
const press = async (key, n = 1, wait = 900) => { for (let i = 0; i < n; i++) { await page.keyboard.press(key); await sleep(wait); } };
const ch = (book) => (R.includes(book) ? `R${R.indexOf(book) + 1}` : book === W[0] ? 'W1' : `G${G.find((b) => b.id === book)?.number}`);

// ---- 1. #263: the address follows the chapter on screen, over three chapters; a refresh reopens it ----
await settings({});
await open(R[0], 9);
let m = await where();
check('opened on page 9 of Resume chapter 1', m.chapter === R[0] && m.page === 9 && m.shown?.page === 9, JSON.stringify(m));
await press('PageDown', 4);
m = await where();
check('four presses later: page 1 of chapter 2, and the address names chapter 2', m.chapter === R[1] && m.page === 1 && m.book === R[1], `${ch(m.book)} ${JSON.stringify(m)}`);
await press('PageDown', 12);
m = await where();
// Reintroduce the first cut's `chapters[0]?.id !== bookId`: the address stays on chapter 2 from here on.
check('twelve more: page 1 of chapter 3, and the address follows into the third chapter', m.chapter === R[2] && m.page === 1 && m.book === R[2], `address ${ch(m.book)} ${JSON.stringify(m)}`);
await press('PageDown', 2);
await sleep(1500); // the page's progress is written 600 ms after it settles
await page.screenshot({ path: join(OUT, '1-before-refresh.png') });
await page.reload({ waitUntil: 'networkidle', timeout: 60000 });
await page.waitForSelector('[data-chapter]', { timeout: 20000 });
await sleep(2000);
m = await where();
check('a refresh reopens chapter 3 on page 3, where the reader was', m.chapter === R[2] && m.page === 3 && m.shown?.page === 3 && m.shown?.book === R[2], `${ch(m.chapter)} ${JSON.stringify(m)}`);

// ---- 2. #263: a change of the track's width keeps the page ----
for (const width of [900, 1600, 1280]) {
  await page.setViewportSize({ width, height: 900 });
  await sleep(1200);
  m = await where();
  check(`the window made ${width} px wide: still page 3 of chapter 3`, m.chapter === R[2] && m.page === 3 && m.shown?.page === 3 && m.shown?.book === R[2], JSON.stringify(m));
}

// ---- 1b. crossing into the next chapter never reloads the page (after 2, which reads on from 1) ----
// The address moved through the router, which asks for the route again (/reader/index.txt?_rsc=...) and loads the whole
// page when it cannot use the answer: on the live server, every reader open across a deploy reloaded at its next
// chapter. Here every such answer comes from another build.
const askedAgain = [];
const routeAgain = (u) => u.pathname.startsWith('/reader/') && u.pathname.endsWith('.txt');
await page.route(routeAgain, async (route) => {
  askedAgain.push(route.request().url());
  const res = await route.fetch();
  await route.fulfill({ response: res, body: (await res.text()).replace(/"b":"[^"]*"/, '"b":"another-build"') });
});
await settings({});
await open(R[0], 9);
await page.evaluate(() => { window.walk263 = 'this page'; });
await press('PageDown', 4);
m = await where();
let samePage = await page.evaluate(() => window.walk263 === 'this page');
// Reintroduce `router.replace` for the address: the reader reloads on chapter 2, and chapter 1 is gone from the track.
check('crossing into the next chapter never reloads the page, though the route comes back from another build',
  samePage && m.chapter === R[1] && m.book === R[1], `same page ${samePage}, route asked ${askedAgain.length}x ${JSON.stringify(m)}`);
await press('PageUp');
m = await where();
samePage = await page.evaluate(() => window.walk263 === 'this page');
check('and one press back is chapter 1 again, on the same track, the address with it',
  samePage && m.chapter === R[0] && m.shown?.book === R[0] && m.book === R[0], `same page ${samePage} ${JSON.stringify(m)}`);
await page.unroute(routeAgain);

// ---- 3. #263: Wide pages: Split, the phone turned (WebKit is the one that matters) ----
const PORTRAIT = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };
await page.setViewportSize(PORTRAIT);
await settings({ widePages: 'split' });
await open(W[0], 6);
m = await where();
check('upright, Split: opened on page 6, after the spread at 5 split in two', m.page === 6 && m.shown?.page === 6, JSON.stringify(m));
for (const [name, size] of [['turned sideways', LANDSCAPE], ['turned back upright', PORTRAIT], ['sideways again', LANDSCAPE], ['upright again', PORTRAIT]]) {
  await page.setViewportSize(size);
  await sleep(1500);
  m = await where();
  check(`${name}: still page 6`, m.page === 6 && m.shown?.page === 6, JSON.stringify(m));
}
await page.screenshot({ path: join(OUT, '3-split-upright.png') });
// On the spread itself, its right half (the second slide of page 5), turned and back: page 5 throughout.
await open(W[0], 5);
await press('PageDown', 1, 1200);
m = await where();
check('upright, Split: page 5\'s right half', m.page === 5 && m.shown?.page === 5 && m.shown?.half === 'right', JSON.stringify(m));
await page.setViewportSize(LANDSCAPE);
await sleep(1500);
m = await where();
check('turned sideways on the spread\'s half: the spread whole, page 5', m.page === 5 && m.shown?.page === 5 && !m.shown?.half, JSON.stringify(m));
await page.setViewportSize(PORTRAIT);
await sleep(1500);
m = await where();
check('turned back upright: page 5 again, in halves', m.page === 5 && m.shown?.page === 5 && !!m.shown?.half, JSON.stringify(m));
await press('PageDown', 2, 1200);
m = await where();
check('and the next presses read on from there: page 6', m.page === 6 && m.shown?.page === 6, JSON.stringify(m));
await page.setViewportSize({ width: 1280, height: 900 });

// ---- 4. #236: the missing numbers, said as the next chapter is reached, and on ] ----
const notices = () => page.evaluate(() => [...document.querySelectorAll('[data-notice]')].map((n) => n.textContent.trim()));
const said = () => page.evaluate(() => document.querySelector('[role=status][aria-live=polite]')?.textContent ?? '');
await settings({});
await open(gapBook(2), 3);
await press('PageDown', 1, 1200); // page 4: the last of chapter 2, and chapter 5 is appended now
let n = await notices();
check('on the last page of chapter 2, chapter 5 appended: nothing said yet', !n.some((t) => /missing/i.test(t)), JSON.stringify(n));
await press('PageDown', 1, 1200);
m = await where();
n = await notices();
check('reaching chapter 5: "Chapters 3–4 are missing here. This continues at chapter 5."',
  m.chapter === gapBook(5) && n.some((t) => t.includes('Chapters 3–4 are missing here. This continues at chapter 5.')), `${JSON.stringify(n)} ${JSON.stringify(m)}`);
await page.screenshot({ path: join(OUT, '4-gap-said.png') });
await sleep(9000); // the notice goes
await press('PageDown', 4, 1200); // into the file holding 6 to 8
m = await where();
n = await notices();
check('reaching the file holding 6 to 8: nothing said', m.chapter === gapBook(6) && !n.some((t) => /missing/i.test(t)), `${JSON.stringify(n)} ${JSON.stringify(m)}`);
await press('PageDown', 4, 1200); // into 9
m = await where();
n = await notices();
check('reaching 9 after the range file: nothing said', m.chapter === gapBook(9) && !n.some((t) => /missing/i.test(t)), `${JSON.stringify(n)} ${JSON.stringify(m)}`);
await open(gapBook(2), 4);
await press(']', 1, 2500);
m = await where();
const heard = await said();
check('] from chapter 2 says the gap and goes to chapter 5', m.chapter === gapBook(5) && heard.includes('Chapters 3–4 are missing here'), `${heard} ${JSON.stringify(m)}`);

// ---- 5. #233: Column width · This device ----
const column = () => page.evaluate(() => {
  const el = document.querySelector('div[data-lenis-prevent].overflow-y-auto > div.mx-auto');
  return el ? Math.round(el.getBoundingClientRect().width) : 0;
});
await settings({ mode: 'vertical' });
await open(R[0]);
const full = await column();
check('webtoon, Fit width, 1280 px: the column is 860 px', full === 860, String(full));
await settings({ mode: 'vertical' }, { columnWidth: 50 });
await open(R[0]);
const half = await column();
check('Column width 50 % on this device: the column is 430 px', half === 430, String(half));
await page.click('[data-reader-settings]');
await sleep(800);
const row = await page.evaluate(() => document.querySelector('[data-reader-width]')?.closest('div')?.parentElement?.textContent ?? '');
check('the sheet says "Column width · This device · 50%"', row.includes('Column width · This device · 50%'), row.slice(0, 120));
await page.screenshot({ path: join(OUT, '5-column-sheet.png') });
await page.keyboard.press('Escape');
await sleep(500);

// ---- 6. #234: Fit pages to my screen ----
await settings({});
images.length = 0;
await open(W[0], 2);
check('Fit pages to my screen off (the default): no page is asked for at a width', images.length > 0 && images.every((i) => !i.fit),
  JSON.stringify(images.slice(0, 4)));
await settings({}, { fitPages: true });
images.length = 0;
await open(W[0], 2);
// 1280 x 900 at 1x: a 1,200 x 1,700 page fitted into the slide is drawn 635 px wide, so 720.
const at2 = images.filter((i) => i.book === W[0] && i.page === 2);
check('on: page 2 (1,200 px, drawn 635 px wide) is asked for at 720', at2.length > 0 && at2.every((i) => i.fit === '720'), JSON.stringify(at2));
const fitted = await page.evaluate(async (u) => { const r = await fetch(u); const b = await r.blob(); const bm = await createImageBitmap(b); return { type: r.headers.get('content-type'), width: bm.width }; },
  `/img/books/${encodeURIComponent(W[0])}/page/2?fit=720`);
check('and it comes 720 px wide, as WebP (page 2 is noise: a narrower copy is smaller)', fitted.type === 'image/webp' && fitted.width === 720, JSON.stringify(fitted));
images.length = 0;
await page.dblclick(TRACK, { position: { x: 640, y: 450 } });
await sleep(1500);
const zoomed = images.filter((i) => i.book === W[0] && i.page === 2);
check('zoomed in twice: page 2 is asked for again, sharper (1,440)', zoomed.some((i) => i.fit === '1440'), JSON.stringify(zoomed));
images.length = 0;
await page.dblclick(TRACK, { position: { x: 640, y: 450 } });
await sleep(1500);
check('zoomed back out: the sharper copy is kept, nothing softer is fetched', !images.some((i) => i.book === W[0] && i.page === 2 && i.fit === '720'), JSON.stringify(images));
const small = await page.evaluate(async (u) => { const r = await fetch(u); return r.headers.get('content-type'); }, `/img/books/${encodeURIComponent(R[0])}/page/1?fit=720`);
check('a page already narrower than asked (300 px) comes as stored', small === 'image/png', String(small));

await settings({}, {});
check('no server errors', serverErrors.length === 0, serverErrors.join(' | '));
check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${ENGINE}: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
