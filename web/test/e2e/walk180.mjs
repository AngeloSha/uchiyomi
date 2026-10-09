// Browser acceptance walk for #180 — near the end of a volume, Safari ran on through the rest of the series.
//
// WebKit keeps a snapped track's place as the index of its snap point counted from the LEFT edge, and the reader's
// right-to-left paged track grows leftwards. Four pages before the end of a chapter the reader appends the next one,
// and WebKit then stood the same distance from the NEW end, which appended the one after, and so on to the last
// chapter, each one crossed marked read: elydan, in Safari on iOS and macOS, near the end of volume 5 of a Japanese
// series, came out at volume 8. Chrome keeps its place, so walk48's Chrome run never saw it. This walk drives WebKit
// (Playwright's), on a series of four twelve-page chapters that read right to left (`seed.py --cascade`):
//
//   1. paged under Series default, the series opens on a right-to-left track;
//   2. two presses to page 9 of chapter 1 append chapter 2, and the reader stays on page 9;
//   3. left alone for six seconds, it is still there: nothing more is fetched and no chapter is marked read;
//   4. every further press moves exactly one page, into chapter 2 too, and only chapter 1 is marked read.
//
// Needs an instance of its OWN and its library folder, and Playwright's WebKit (not a dependency of this package):
//
//   KEEP=1 E2E_NET=uchiyomi-e2e-180 E2E_PORT=18180 E2E_SUBNET=10.222.18.0/24 E2E_NO_WALK=1 bash web/test/e2e/up.sh
//   cd web && npm i --no-save playwright && npx playwright install webkit
//   LIB=<the library folder up.sh printed> BASE=http://127.0.0.1:18180 node test/e2e/walk180.mjs
//
// ⚠️ The reader adopts the account's copy of the reader settings on load and the server copy wins, so the settings are
// written BOTH to /api/settings and to localStorage (walk48.mjs says why).
// ⚠️ Service workers are blocked: the reader's requests are what this walk counts, and a worker answering from its cache
// would hide them.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let webkit;
try {
  ({ webkit } = await import('playwright'));
} catch {
  console.error('walk180 drives WebKit through Playwright: in web/, `npm i --no-save playwright && npx playwright install webkit` first');
  process.exit(2);
}

const BASE = process.env.BASE || 'http://127.0.0.1:18180';
const USER = process.env.E2E_USER || 'e2e';
const PASS = process.env.E2E_PASS || 'e2e-passw0rd-123';
const LIB = process.env.LIB;
const OUT = process.env.OUT || 'shots180';
const WIDTH = 1280;
if (!LIB) { console.error('LIB must name the instance\'s library folder (up.sh prints it with KEEP=1)'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`  [${ok ? ' ok ' : 'FAIL'}] ${name}${!ok && detail ? `\n         ${detail}` : ''}`);
};

// ---- the fixture, and an API session for the settings writes ----
execFileSync('python3', [join(dirname(fileURLToPath(import.meta.url)), 'seed.py'), LIB, '--cascade'], { stdio: 'inherit' });
const login = await (await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) })).json();
const TOKEN = login.accessToken;
const api = async (path, opts = {}) => {
  const r = await fetch(BASE + path, { ...opts, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } });
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};
// A scan runs at most once a minute, and up.sh asks for one as it starts the instance: ask until one runs (walk48.mjs).
let scan = null;
for (let i = 0; i < 20; i++) {
  scan = await api('/api/refresh', { method: 'POST', body: '{}' });
  if (scan?.scanned) break;
  await sleep(5000);
}
if (!scan?.scanned) { console.error(`the library scan never ran: ${JSON.stringify(scan)}`); process.exit(1); }
let SERIES = null;
for (let i = 0; i < 30 && !SERIES; i++) {
  await sleep(1000);
  SERIES = (await api('/api/series/search', { method: 'POST', body: JSON.stringify({ query: '', size: 100 }) })).content
    .find((s) => s.name === 'Cascade Right To Left')?.id ?? null;
}
if (!SERIES) { console.error('the scan did not list the walk\'s series'); process.exit(1); }
const CH = (await api(`/api/series/${SERIES}/books?size=10`)).content.sort((a, b) => a.number - b.number).map((b) => b.id);
if (CH.length !== 4) { console.error(`expected four chapters, found ${CH.length}`); process.exit(1); }
const chapterOf = (id) => CH.indexOf(id) + 1;

// ---- WebKit, signed in once (the login limit is 10 per five minutes) ----
const browser = await webkit.launch();
const context = await browser.newContext({ viewport: { width: WIDTH, height: 900 }, serviceWorkers: 'block' });
const page = await context.newPage();
const serverErrors = [];
const pageErrors = [];
/** Every chapter whose page list the reader fetched, in order: an append is one of these. */
const fetched = [];
/** Every progress write: which chapter, which page, and whether it marked the chapter read. */
const progress = [];
page.on('response', (r) => { if (r.status() >= 500) serverErrors.push(`${r.status()} ${r.url()}`); });
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('request', (r) => {
  const m = new URL(r.url()).pathname.match(/^\/api\/books\/([^/]+)\/(pages|progress)$/);
  if (!m) return;
  if (m[2] === 'pages' && r.method() === 'GET') fetched.push(chapterOf(decodeURIComponent(m[1])));
  if (m[2] === 'progress' && r.method() === 'PUT') {
    let body = {};
    try { body = JSON.parse(r.postData() || '{}'); } catch { /* recorded as nothing */ }
    progress.push({ chapter: chapterOf(decodeURIComponent(m[1])), page: body.page, completed: !!body.completed });
  }
});
await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForSelector('input[type=password]', { timeout: 30000 });
await sleep(2500); // the form renders again once /auth/config answers; typing before that is lost
await page.locator('input').first().fill(USER);
await page.locator('input[type=password]').fill(PASS);
await page.keyboard.press('Enter');
await sleep(4000);
check('signed in', !(await page.$('input[type=password]')));

const PREFS = { junkPages: 'collapse', skipJunk: true, gap: 0, brightness: 1, mode: 'paged', autoScroll: 0, fitWidth: true, theme: 'amoled', spread: false, pagedDirection: 'series' };
await api('/api/settings', { method: 'PUT', body: JSON.stringify({ reader: PREFS, readerSeries: {}, readerSource: {} }) });
await page.evaluate((prefs) => {
  for (const k of Object.keys(localStorage)) if (k.startsWith('yomi_rs_') || k.startsWith('yomi_rp_')) localStorage.removeItem(k);
  localStorage.setItem('yomi_reader_prefs', JSON.stringify(prefs));
}, PREFS);

const TRACK = 'div.snap-x[dir]';
/** The track's direction, and the chapter and page of the slide on screen (from its image's address). */
const measure = () => page.$eval(TRACK, (el) => {
  const w = el.clientWidth;
  const slide = [...el.children].find((s) => { const r = s.getBoundingClientRect(); return r.left > -w / 2 && r.left < w / 2; });
  const src = slide?.querySelector('img')?.getAttribute('src') || '';
  const m = src.match(/\/img\/books\/([^/]+)\/page\/(\d+)/);
  return { dir: el.getAttribute('dir'), book: m ? decodeURIComponent(m[1]) : null, page: m ? Number(m[2]) : null, text: slide ? slide.textContent.trim().slice(0, 40) : null };
});
const where = async () => { const m = await measure(); return { ...m, chapter: m.book ? chapterOf(m.book) : null }; };

// ---- 1-2: open near the end of chapter 1, then two presses to page 9 ----
await page.goto(`${BASE}/reader/?book=${CH[0]}&page=7`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForSelector(TRACK, { timeout: 20000 });
await sleep(2500);
let m = await where();
check('paged under Series default, the series opens on a right-to-left track, on page 7 of chapter 1',
  m.dir === 'rtl' && m.chapter === 1 && m.page === 7, JSON.stringify(m));
for (let i = 0; i < 2; i++) { await page.keyboard.press('PageDown'); await sleep(1200); }
m = await where();
check('two presses later it is on page 9 of chapter 1', m.chapter === 1 && m.page === 9, JSON.stringify(m));

// ---- 3: left alone ----
await sleep(6000);
m = await where();
await page.screenshot({ path: join(OUT, '180-idle.png') });
check('left alone for six seconds, it is still on page 9 of chapter 1 (it ran on to the last chapter: #180)',
  m.chapter === 1 && m.page === 9, JSON.stringify(m));
check('chapter 2 was appended, and nothing after it', fetched.includes(2) && !fetched.includes(3) && !fetched.includes(4), JSON.stringify(fetched));
check('no chapter was marked read', !progress.some((p) => p.completed), JSON.stringify(progress.filter((p) => p.completed)));

// ---- 4: every further press moves one page ----
const seen = [];
for (let i = 0; i < 5; i++) {
  await page.keyboard.press('PageDown');
  await sleep(1200);
  const x = await where();
  seen.push(`${x.chapter}:${x.page}`);
}
check('every press moves exactly one page, into chapter 2 too', JSON.stringify(seen) === JSON.stringify(['1:10', '1:11', '1:12', '2:1', '2:2']), JSON.stringify(seen));
const read = [...new Set(progress.filter((p) => p.completed).map((p) => p.chapter))];
check('only chapter 1 is marked read on the way', JSON.stringify(read) === '[1]', JSON.stringify(read));

check('no server errors', serverErrors.length === 0, serverErrors.join(' | '));
check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
