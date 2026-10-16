// Browser acceptance walk for spread joining and one page of a pair in frame (v0.77.0, @Squeaks72's #229, #232, #261).
//
//   1. Join split double pages is off until chosen: the page list never asks for spreads, and nothing is joined.
//   2. On, a chapter opened before its measure ran is answered at once (`x-spreads: pending`), and its spread joins a
//      moment later WITHOUT moving the page being read (two slides become one before it: the joins effect).
//   3. The joined slide is one picture as drawn: page 5 on the left of page 4 (the server found 'rtl'), touching.
//   4. Double spread: the joined pair beside an ordinary pair, which keeps its gutter.
//   5. A chapter opening on a spread: page 1 is half of it.
//   6. A phone held upright: Wide pages decides -- Whole the spread across, Split its two pages apart, Rotate it turned.
//   7. Z brings the pair's first page into frame (a squared label says which), ← steps to the other, Z gives both back.
//   8. Taps: with Tap a page of a pair off (the default) the middle shows the controls as ever; on, a tap on a page
//      brings it into frame, and the label gives both back.
//   9. The key list names the action.
//
// Run it in WebKit (ENGINE=webkit) as well as Chromium: the paged track is a snap container and Safari keeps its place
// by index (#180), which is what the late join's re-anchoring is about. Needs an instance of its own and its library:
//
//   KEEP=1 E2E_NET=uchiyomi-e2e-229 E2E_PORT=18291 E2E_SUBNET=10.222.229.0/24 E2E_NO_WALK=1 bash web/test/e2e/up.sh
//   cd web && npm i --no-save playwright && npx playwright install webkit chromium
//   LIB=<the library folder up.sh printed> BASE=http://127.0.0.1:18291 ENGINE=webkit node test/e2e/walk229.mjs
//
// ⚠️ The first two steps need chapters the server has not measured yet: on an instance it already ran on, they are
// measured, and step 2 fails as `done`. Run it on a fresh instance (up.sh), or reset `lib_books.spreads` first.
// ⚠️ The reader adopts the account's copy of the reader settings on load and the server copy wins, so the settings are
// written BOTH to /api/settings and to localStorage (walk48.mjs says why). This device's settings are localStorage only.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let pw;
try {
  pw = await import('playwright');
} catch {
  console.error('walk229 drives Playwright: in web/, `npm i --no-save playwright && npx playwright install webkit chromium` first');
  process.exit(2);
}

const BASE = process.env.BASE || 'http://127.0.0.1:18291';
const USER = process.env.E2E_USER || 'e2e';
const PASS = process.env.E2E_PASS || 'e2e-passw0rd-123';
const LIB = process.env.LIB;
const ENGINE = process.env.ENGINE || 'webkit';
const OUT = process.env.OUT || `shots229-${ENGINE}`;
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
execFileSync('python3', [join(dirname(fileURLToPath(import.meta.url)), 'seed.py'), LIB, '--spreads'], { stdio: 'inherit' });
const login = await (await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) })).json();
const TOKEN = login.accessToken;
const api = async (path, opts = {}) => {
  const r = await fetch(BASE + path, { ...opts, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } });
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};
// A scan runs at most once a minute, and up.sh asks for one as it starts the instance: ask until one runs (walk48.mjs).
let sid = null;
for (let i = 0; i < 24 && !sid; i++) {
  const scan = await api('/api/refresh', { method: 'POST', body: '{}' });
  if (scan?.scanned || i > 0) {
    sid = (await api('/api/series/search', { method: 'POST', body: JSON.stringify({ query: '', size: 100 }) })).content
      .find((s) => s.name === 'Walk Two Two Nine Spreads')?.id ?? null;
  }
  if (!sid) await sleep(5000);
}
if (!sid) { console.error('the scan did not list Walk Two Two Nine Spreads'); process.exit(1); }
const [C1, C2] = (await api(`/api/series/${sid}/books?size=50`)).content.sort((a, b) => a.number - b.number).map((b) => b.id);
const series = await api(`/api/series/${sid}`);
check('the fixture: two chapters of a right-to-left series', !!C1 && !!C2 && series?.metadata?.readingDirection === 'RIGHT_TO_LEFT',
  JSON.stringify({ C1, C2, dir: series?.metadata?.readingDirection }));

// ---- the browser, signed in once (the login limit is 10 per five minutes) ----
const browser = await pw[ENGINE].launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
const page = await context.newPage();
const serverErrors = [];
const pageErrors = [];
/** Every page list the reader asked for: which chapter, with ?spreads=1 or not, and what x-spreads said. */
const lists = [];
page.on('response', (r) => {
  if (r.status() >= 500) serverErrors.push(`${r.status()} ${r.url()}`);
  const u = new URL(r.url());
  const m = u.pathname.match(/^\/api\/books\/([^/]+)\/pages$/);
  if (m) lists.push({ book: decodeURIComponent(m[1]), spreads: u.searchParams.get('spreads'), said: r.headers()['x-spreads'] ?? null });
});
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForSelector('input[type=password]', { timeout: 30000 });
await sleep(2500); // the form renders again once /auth/config answers; typing before that is lost
await page.locator('input').first().fill(USER);
await page.locator('input[type=password]').fill(PASS);
await page.keyboard.press('Enter');
await sleep(4000);
check('signed in', !(await page.$('input[type=password]')));

const BASE_PREFS = { junkPages: 'show', skipJunk: false, gap: 0, brightness: 1, mode: 'paged', autoScroll: 0, fitWidth: true, theme: 'amoled', spread: false, pagedDirection: 'series', widePages: 'whole', cropBorders: false, autoMode: false };
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
/** The slide in view: whether it is a joined spread (turned or not), its images left to right, the page the reader says,
 *  the focus label, and whether the controls show. */
const view = () => page.evaluate((track) => {
  const root = document.querySelector('[data-chapter]');
  const el = document.querySelector(track);
  const out = { page: Number(root?.getAttribute('data-page') ?? 0), chapter: root?.getAttribute('data-chapter') ?? null,
    label: document.querySelector('[data-focus-label]')?.textContent?.trim() ?? null, chrome: !!document.querySelector('[data-reader-settings]'),
    joined: false, turned: false, imgs: [] };
  if (!el) return out;
  const w = el.clientWidth;
  const slide = [...el.children].find((s) => { const r = s.getBoundingClientRect(); return r.left > -w / 2 && r.left < w / 2; });
  if (!slide) return out;
  out.joined = slide.hasAttribute('data-joined');
  const turned = slide.querySelector('[data-joined-turned]');
  out.turned = !!turned && /rotate\(90deg\)/.test(turned.getAttribute('style') || '');
  out.imgs = [...slide.querySelectorAll('img')].map((im) => {
    const r = im.getBoundingClientRect();
    const m = (im.getAttribute('src') || '').match(/\/page\/(\d+)/);
    return { page: m ? Number(m[1]) : null, left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), width: Math.round(r.width) };
  }).sort((a, b) => a.left - b.left);
  return out;
}, TRACK);
const open = async (book, pageNo) => {
  await page.goto(`${BASE}/reader/?book=${book}${pageNo ? `&page=${pageNo}` : ''}`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('[data-chapter]', { timeout: 20000 });
  await sleep(1800);
};
const press = async (key, n = 1, wait = 900) => { for (let i = 0; i < n; i++) { await page.keyboard.press(key); await sleep(wait); } };
/** Until the slide in view is (or stops being) a joined spread, for at most `ms`. */
const untilJoined = async (want = true, ms = 9000) => {
  const t0 = Date.now();
  let v = await view();
  while (v.joined !== want && Date.now() - t0 < ms) { await sleep(300); v = await view(); }
  return v;
};
const pagesOf = (v) => v.imgs.map((i) => i.page);
/** The controls hide 3.8 s after they last showed. */
const chromeAway = async () => { for (let i = 0; i < 30 && (await view()).chrome; i++) await sleep(300); };

// ---- 1. off until chosen: the page list never asks for spreads ----
await settings({});
lists.length = 0;
await open(C1, 4);
let v = await view();
check('joining off (the default): page 4 alone on its slide, nothing joined', !v.joined && JSON.stringify(pagesOf(v)) === '[4]', JSON.stringify(v));
check('and the page list was asked for without ?spreads=1', lists.length > 0 && lists.every((l) => l.spreads === null && l.said === null), JSON.stringify(lists));

// ---- 2. on: answered at once, joined a moment later, and the page being read stays ----
await settings({ joinSplit: true });
lists.length = 0;
await open(C1, 7);
v = await view();
check('joining on, chapter 1 not measured yet: the page list says pending, and page 7 is shown',
  lists.some((l) => l.book === C1 && l.spreads === '1' && l.said === 'pending') && JSON.stringify(pagesOf(v)) === '[7]', `${JSON.stringify(lists)} ${JSON.stringify(v)}`);
// Two slides (4 and 5) become one BEFORE page 7: without the joins effect the track would stand on page 8.
for (let i = 0; i < 30 && !lists.some((l) => l.book === C1 && l.said === 'done'); i++) await sleep(300);
await sleep(1200);
v = await view();
check('the reader asked again and got the join: done', lists.some((l) => l.book === C1 && l.said === 'done'), JSON.stringify(lists));
check('and page 7 is still the one shown after two slides before it became one', JSON.stringify(pagesOf(v)) === '[7]' && v.page === 7, JSON.stringify(v));
await press('PageUp', 2, 1200); // back two in reading order: 6, then the joined spread
v = await view();
check('back two: the joined spread, pages 4 and 5 on one slide', v.joined && JSON.stringify(pagesOf(v).slice().sort()) === '[4,5]', JSON.stringify(v));
await page.screenshot({ path: join(OUT, '2-joined.png') });

// ---- 3. one picture as drawn: page 5 on the left of page 4, touching ----
await open(C1, 4);
v = await view();
const [L, R] = v.imgs;
check('opened on the spread: one slide of two pages', v.joined && v.imgs.length === 2, JSON.stringify(v));
check('page 5 sits on the left of page 4: the side the server found (rtl)', L?.page === 5 && R?.page === 4, JSON.stringify(v.imgs));
check('the two halves touch: no gap down the middle', !!L && !!R && Math.abs(R.left - L.right) <= 1, JSON.stringify(v.imgs));

// ---- 4. Double spread: the joined pair beside an ordinary pair, which keeps its gutter ----
await settings({ joinSplit: true, spread: true });
await open(C1, 2);
v = await view();
const gap = v.imgs.length === 2 ? v.imgs[1].left - v.imgs[0].right : null;
check('Double spread: pages 2 and 3 an ordinary pair, 4 px apart as ever', !v.joined && JSON.stringify(pagesOf(v).slice().sort()) === '[2,3]' && gap >= 3 && gap <= 5, `${gap} ${JSON.stringify(v)}`);
await press('PageDown', 1, 1200);
v = await view();
check('the next slide: the joined spread, touching', v.joined && JSON.stringify(pagesOf(v).slice().sort()) === '[4,5]' && Math.abs(v.imgs[1].left - v.imgs[0].right) <= 1, JSON.stringify(v));
await page.screenshot({ path: join(OUT, '4-double-spread.png') });

// ---- 5. a chapter that opens on a spread ----
await settings({ joinSplit: true });
await open(C2, 1);
v = await untilJoined(true);
check('chapter 2 opens on a spread: page 1 is half of it', v.joined && JSON.stringify(pagesOf(v).slice().sort()) === '[1,2]', JSON.stringify(v));

// ---- 6. a phone held upright: Wide pages decides ----
await page.setViewportSize({ width: 390, height: 844 });
await settings({ joinSplit: true, widePages: 'whole' });
await open(C1, 4);
v = await view();
check('upright, Whole: the spread across the screen, two halves side by side', v.joined && v.imgs.length === 2 && v.imgs.every((i) => i.width <= 200), JSON.stringify(v));
await settings({ joinSplit: true, widePages: 'split' });
await open(C1, 4);
v = await view();
check('upright, Split: page 4 alone (a joined spread\'s halves are its pages)', !v.joined && JSON.stringify(pagesOf(v)) === '[4]', JSON.stringify(v));
await press('PageDown', 1, 1200);
v = await view();
check('and the next turn shows page 5 alone', !v.joined && JSON.stringify(pagesOf(v)) === '[5]', JSON.stringify(v));
await settings({ joinSplit: true, widePages: 'rotate' });
await open(C1, 4);
v = await view();
check('upright, Rotate: the spread turned on its side, both pages in it', v.joined && v.turned && v.imgs.length === 2, JSON.stringify(v));
await page.screenshot({ path: join(OUT, '6-rotate.png') });
await page.setViewportSize({ width: 1280, height: 900 });

// ---- 7. Z: one page of a pair in frame, ← to the other, Z for both ----
await settings({ joinSplit: true, spread: true });
await open(C1, 2);
await chromeAway();
await press('z', 1, 800);
v = await view();
// A right-to-left read: page 2 is first, on the right of the pair.
check('Z: page 2 alone, and a label names it', JSON.stringify(pagesOf(v)) === '[2]' && !!v.label && v.label.includes('2'), JSON.stringify(v));
await page.screenshot({ path: join(OUT, '7-focus.png') });
await press('ArrowLeft', 1, 800);
v = await view();
check('← steps to the pair\'s other page, on its left: page 3', JSON.stringify(pagesOf(v)) === '[3]' && v.label?.includes('3'), JSON.stringify(v));
await press('z', 1, 800);
v = await view();
check('Z again: both pages back, no label', JSON.stringify(pagesOf(v).slice().sort()) === '[2,3]' && v.label === null, JSON.stringify(v));

// ---- 8. taps: off, the middle shows the controls; on, a tap on a page brings it into frame ----
await settings({ joinSplit: true, spread: true }, {});
await open(C1, 2);
await chromeAway();
await page.mouse.click(640, 450);
await sleep(900);
v = await view();
check('Tap a page of a pair off (the default): a tap in the middle shows the controls, the pair stays', v.chrome && v.imgs.length === 2, JSON.stringify(v));
await settings({ joinSplit: true, spread: true }, { tapFocus: true });
await open(C1, 2);
await chromeAway();
v = await view();
const right = v.imgs[1];
await page.mouse.click(Math.round((right.left + right.right) / 2), 450);
await sleep(900);
v = await view();
check('on: a tap on the right page brings page 2 into frame, the controls stay hidden', JSON.stringify(pagesOf(v)) === '[2]' && !v.chrome && !!v.label, JSON.stringify(v));
await page.click('[data-focus-label] button');
await sleep(800);
v = await view();
check('the label gives both pages back', v.imgs.length === 2 && v.label === null, JSON.stringify(v));

// ---- 9. the key list names the action ----
await press('?', 1, 800);
const line = await page.evaluate(() => {
  const li = [...document.querySelectorAll('[role=dialog][aria-modal=true] li')].find((l) => l.textContent.includes('One page of a pair, or both'));
  return li ? [...li.querySelectorAll('kbd')].map((k) => k.textContent.trim()) : null;
});
check('the key list has a line "One page of a pair, or both" with its key, z', JSON.stringify(line) === '["z"]', JSON.stringify(line));
await page.keyboard.press('Escape');
await sleep(500);

await settings({}, {});
check('no server errors', serverErrors.length === 0, serverErrors.join(' | '));
check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${ENGINE}: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
