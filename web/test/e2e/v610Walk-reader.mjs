// Browser acceptance walk for v0.61.0's reader comfort pack -- Chrome (Playwright's Chromium) and Playwright's WebKit.
//
// What it checks, against a library of its own (`seed.py <lib> --comfort`: Strip Long, Margins Manga) and Walk Tale from
// fake-a (a series that follows a source, for the per-source default):
//
//   Chrome, 1280 x 900
//    1. the webtoon column decodes at most three full-size images mid-strip (a window of pages held nine);
//    2. a double-click zoom in the middle of a 25,000 px strip keeps the point being read (it jumped to the strip's top);
//    3. the next chapter's divider is in the column before the reader is within two screens of the end;
//    4. Crop page borders: about 0.067 trimmed off a page with 80 px of paper all round, nothing off a strip;
//    5. Wide pages → Split does nothing on a screen held sideways;
//    6. Tap zones → L shape: the bottom row turns on, the top row back;
//    7. 'j' bound to Next page turns the page; Escape still closes the sheet;
//    8. a controller (navigator.getGamepads stubbed) turns the page;
//    9. Colour filter → Invert is on the page images and not on the Up Next card;
//   10. Pick the mode for each series: a strip opens in Webtoon, a bordered right-to-left manga in Paged, and a series'
//       own mode beats the pick;
//   11. F1: global Webtoon + a source default of Paged + a resume at page 9 opens on page 9, and the next page is 10;
//   12. F2: a /api/settings answer held back three seconds does not change the open title's mode;
//   Chrome, 390 x 844 (held upright)
//   13. Wide pages → Split: a spread's two halves are two slides on ONE page (counter and progress say 10 for both);
//   14. Wide pages → Rotate keeps the slide count and turns the spread;
//   WebKit, 390 x 844
//   15. split halves at the end of a right-to-left chapter, across the append of the next: every press moves one slide
//       (#180's cascade, with halves).
//
// Needs an instance of its own with fake-a (up.sh's default stack) and its library folder, and Playwright's Chromium and
// WebKit (not dependencies of this package):
//
//   KEEP=1 E2E_NET=uchiyomi-e2e-610 E2E_PORT=18610 E2E_SUBNET=10.222.61.0/24 E2E_NO_WALK=1 bash web/test/e2e/up.sh
//   cd web && npm i --no-save playwright && npx playwright install chromium webkit
//   LIB=<the library folder up.sh printed> BASE=http://127.0.0.1:18610 node test/e2e/v610Walk-reader.mjs
//
// It runs alongside walk48.mjs (Chrome, right-to-left "every press moves one page") and walk180.mjs (WebKit, #180's
// append), which must pass unchanged.
//
// ⚠️ The reader adopts the account's copy of the reader settings on load and the server copy wins, so the settings are
// written BOTH to /api/settings and to localStorage (walk48.mjs says why). This device's settings (lib/readerDevice.ts)
// are localStorage only. ⚠️ Service workers are blocked: the walk counts the reader's requests.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let chromium, webkit;
try {
  ({ chromium, webkit } = await import('playwright'));
} catch {
  console.error('v610Walk-reader drives Chromium and WebKit through Playwright: in web/, `npm i --no-save playwright && npx playwright install chromium webkit` first');
  process.exit(2);
}

const BASE = process.env.BASE || 'http://127.0.0.1:18610';
const USER = process.env.E2E_USER || 'e2e';
const PASS = process.env.E2E_PASS || 'e2e-passw0rd-123';
const LIB = process.env.LIB;
const OUT = process.env.OUT || 'shots610';
if (!LIB) { console.error('LIB must name the instance\'s library folder (up.sh prints it with KEEP=1)'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`  [${ok ? ' ok ' : 'FAIL'}] ${name}${!ok && detail ? `\n         ${detail}` : ''}`);
};

// ---- the fixture, and an API session ----
execFileSync('python3', [join(dirname(fileURLToPath(import.meta.url)), 'seed.py'), LIB, '--comfort'], { stdio: 'inherit' });
const login = await (await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) })).json();
const TOKEN = login.accessToken;
const api = async (path, opts = {}) => {
  const r = await fetch(BASE + path, { ...opts, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } });
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${path} -> ${r.status} ${await r.text()}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
};
const waitFor = async (fn, ms = 60000, every = 1000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(every);
  }
  return null;
};
// A scan runs at most once a minute, and up.sh asks for one as it starts the instance: ask until one runs (walk48.mjs).
const scan = await waitFor(async () => { const s = await api('/api/refresh', { method: 'POST', body: '{}' }); return s?.scanned ? s : null; }, 120000, 5000);
if (!scan) { console.error('the library scan never ran'); process.exit(1); }
// 100: the search route refuses a bigger page (400 bad_request, `size`); the mock backend this walk was first run
// against took anything, and the real one answered every lookup with an error the waitFor below swallowed.
const seriesNamed = async (name) => (await api('/api/series/search', { method: 'POST', body: JSON.stringify({ query: '', size: 100 }) })).content.find((s) => s.name === name)?.id ?? null;
const SL = await waitFor(() => seriesNamed('Strip Long'), 60000);
const MM = await waitFor(() => seriesNamed('Margins Manga'), 60000);
if (!SL || !MM) { console.error(`the scan did not list the walk's series: ${SL} ${MM}`); process.exit(1); }
const chaptersOf = async (id) => (await api(`/api/series/${id}/books?size=50`)).content.sort((a, b) => a.number - b.number).map((b) => b.id);
const SLC = await chaptersOf(SL);
const MMC = await chaptersOf(MM);
if (SLC.length !== 3 || MMC.length !== 2) { console.error(`expected 3 + 2 chapters, found ${SLC.length} + ${MMC.length}`); process.exit(1); }

// Walk Tale, from fake-a: the per-source default needs a series that follows a source. One chapter is enough.
let WT = await seriesNamed('Walk Tale');
if (!WT) {
  await api('/api/admin/sources/fake-a/enable', { method: 'POST', body: '{}' }).catch(() => {});
  await api('/api/sources/add', { method: 'POST', body: JSON.stringify({ source: 'fake-a', sourceId: 'walk-tale', chapterCount: 1, chapterFrom: 'oldest', autoUpdate: false }) });
  WT = await waitFor(() => seriesNamed('Walk Tale'), 120000);
}
const WT1 = WT && await waitFor(async () => {
  const b = (await api(`/api/series/${WT}/books?size=50`)).content.find((x) => Number(x.number) === 1);
  return b && (await api(`/api/books/${b.id}/pages`)).length >= 12 ? b.id : null;
}, 180000, 2000);
const WT_SOURCE = WT && (await api(`/api/series/${WT}`)).sources?.find((s) => s.primary)?.sourceId;

// ---- the browsers ----
const DEFAULTS = { junkPages: 'collapse', skipJunk: true, gap: 0, brightness: 1, mode: 'vertical', autoScroll: 0, fitWidth: true, theme: 'amoled', spread: false, pagedDirection: 'series', coverEdges: true, widePages: 'whole', cropBorders: false, autoMode: false };

async function session(type, viewport) {
  const browser = await type.launch();
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  // A controller that is not there: navigator.getGamepads answers this object, and the walk presses its buttons.
  await context.addInitScript(() => {
    const blank = () => ({ pressed: false, touched: false, value: 0 });
    window.__pad = { id: 'walk pad', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, blank) };
    window.__press = (i, on) => { window.__pad.buttons[i] = { pressed: on, touched: on, value: on ? 1 : 0 }; window.__pad.timestamp++; };
    window.__padOn = false;
    Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: () => (window.__padOn ? [window.__pad] : []) });
  });
  const page = await context.newPage();
  const errors = [];
  const progress = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
  page.on('request', (r) => {
    const m = new URL(r.url()).pathname.match(/^\/api\/books\/([^/]+)\/progress$/);
    if (!m || r.method() !== 'PUT') return;
    let body = {};
    try { body = JSON.parse(r.postData() || '{}'); } catch { /* recorded as nothing */ }
    progress.push({ book: decodeURIComponent(m[1]), page: body.page, completed: !!body.completed });
  });
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('input[type=password]', { timeout: 30000 });
  await sleep(2500); // the form renders again once /auth/config answers; typing before that is lost
  await page.locator('input').first().fill(USER);
  await page.locator('input[type=password]').fill(PASS);
  await page.keyboard.press('Enter');
  await sleep(4000);
  return { browser, context, page, errors, progress };
}

/** The account's reader settings and this browser's copy of them; series and source memories too. */
async function setPrefs(page, reader, readerSeries = {}, readerSource = {}) {
  const full = { ...DEFAULTS, ...reader };
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ reader: full, readerSeries, readerSource }) });
  await page.evaluate(([full, readerSeries, readerSource]) => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('yomi_rs_') || k.startsWith('yomi_rp_')) localStorage.removeItem(k);
    localStorage.setItem('yomi_reader_prefs', JSON.stringify(full));
    for (const [id, v] of Object.entries(readerSeries)) localStorage.setItem(`yomi_rs_${id}`, JSON.stringify(v));
    for (const [id, v] of Object.entries(readerSource)) localStorage.setItem(`yomi_rp_${id}`, JSON.stringify(v));
  }, [full, readerSeries, readerSource]);
}
/** This device's own reader settings (lib/readerDevice.ts). */
const setDevice = (page, device) => page.evaluate((d) => localStorage.setItem('yomi_reader_device', JSON.stringify(d)), device);

const TRACK = 'div.snap-x[dir]';
const COLUMN = 'div.touch-pan-y';
async function open(page, bookId, pageNo) {
  await page.goto(`${BASE}/reader/?book=${bookId}${pageNo ? `&page=${pageNo}` : ''}`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('[data-chapter]', { timeout: 20000 });
  await sleep(2000);
}
const modeOf = (page) => page.evaluate(([t, c]) => (document.querySelector(t) ? 'paged' : document.querySelector(c) ? 'vertical' : null), [TRACK, COLUMN]);
/**
 * The page being read (the reader root's data hooks), and on the paged track the slide in view -- with the page its image
 * shows, which is what the reader SEES: v0.60's F1 kept the counter on 9 while slide 0 was on screen.
 */
const where = (page) => page.evaluate((t) => {
  const root = document.querySelector('[data-chapter]');
  const el = document.querySelector(t);
  let slide = null;
  if (el) {
    const w = el.clientWidth;
    slide = [...el.children].find((s) => { const r = s.getBoundingClientRect(); return r.left > -w / 2 && r.left < w / 2; }) ?? null;
  }
  return {
    page: Number(root?.getAttribute('data-page')) || null,
    chapter: root?.getAttribute('data-chapter') ?? null,
    dir: el?.getAttribute('dir') ?? null,
    slides: el ? [...el.children].filter((s) => s.querySelector('img, span')).length : null,
    shown: Number((slide?.querySelector('img')?.getAttribute('src') || '').match(/\/page\/(\d+)/)?.[1]) || null,
    half: slide?.querySelector('[data-half]')?.getAttribute('data-half') ?? null,
    crop: slide?.querySelector('[data-crop]')?.getAttribute('data-crop') ?? null,
    rotated: !!slide?.querySelector('[data-rotated]'),
  };
}, TRACK);
/** The webtoon column: where it is scrolled, and the row under the probe line with how far down it. */
const column = (page) => page.evaluate((c) => {
  const el = document.querySelector(c);
  const probe = el.scrollTop + el.clientHeight * 0.4;
  const rows = [...el.querySelectorAll('[data-page]')];
  const at = rows.map((r) => ({ r, top: r.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop }))
    .filter((x) => x.top <= probe).pop();
  const decoded = [...el.querySelectorAll('img')].filter((i) => /\/page\/\d+$/.test(new URL(i.src, location.href).pathname)
    && !new URL(i.src, location.href).search && i.complete && i.naturalWidth > 0).length;
  return {
    top: el.scrollTop, height: el.clientHeight, rows: rows.length, decoded,
    page: at ? Number(at.r.getAttribute('data-page')) : null,
    frac: at ? (probe - at.top) / at.r.getBoundingClientRect().height : null,
    crops: rows.map((r) => r.getAttribute('data-crop')).filter((v) => v != null),
  };
}, COLUMN);
/**
 * What the slide in view actually DRAWS of its page: the image's rect against the box that clips it, as the share of the
 * image cut off each side -- the region the reader meant to show, measured, not the numbers it was given. And where a
 * turned page sits against its slide. (The first cut was seen drawing the wrong half on a right-to-left track: an image
 * too wide for its box overflows to the left there.)
 */
const drawn = (page) => page.evaluate((t) => {
  const el = document.querySelector(t);
  const w = el.clientWidth;
  const slide = [...el.children].find((s) => { const r = s.getBoundingClientRect(); return r.left > -w / 2 && r.left < w / 2; });
  const out = {};
  const box = slide?.querySelector('[data-half], [data-crop]');
  const img = box?.querySelector('img');
  if (box && img) {
    const b = box.getBoundingClientRect();
    const i = img.getBoundingClientRect();
    Object.assign(out, { l: (b.left - i.left) / i.width, r: (i.right - b.right) / i.width, t: (b.top - i.top) / i.height, b: (i.bottom - b.bottom) / i.height });
  }
  const turned = slide?.querySelector('[data-rotated]');
  if (turned) {
    const r = turned.getBoundingClientRect();
    const sr = slide.getBoundingClientRect();
    Object.assign(out, { dx: (r.left + r.right) / 2 - (sr.left + sr.right) / 2, dy: (r.top + r.bottom) / 2 - (sr.top + sr.bottom) / 2, fits: r.width <= sr.width + 1 && r.height <= sr.height + 1 });
  }
  return out;
}, TRACK);
const near = (a, b, eps = 0.012) => typeof a === 'number' && Math.abs(a - b) <= eps;
const scrollColumn = (page, top) => page.evaluate(([c, top]) => { document.querySelector(c).scrollTop = top; }, [COLUMN, top]);
const rowBox = (page, n) => page.evaluate(([c, n]) => {
  const el = document.querySelector(c);
  const r = el.querySelector(`[data-page="${n}"]`);
  if (!r) return null;
  return { top: r.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop, height: r.getBoundingClientRect().height };
}, [COLUMN, n]);

try {
  // ======================================================== Chrome, 1280 x 900
  const c = await session(chromium, { width: 1280, height: 900 });
  const { page } = c;
  check('signed in (Chrome)', !(await page.$('input[type=password]')));

  console.log('\n  1-2. the webtoon column: a window by screens, and a zoom that keeps its place');
  await setPrefs(page, { mode: 'vertical' });
  await setDevice(page, {});
  await open(page, SLC[0], 1);
  const strip1 = await rowBox(page, 1);
  check('a strip is reserved its own height (25,000 px at 860 wide)', strip1 && strip1.height > 20000, JSON.stringify(strip1));
  await scrollColumn(page, strip1.top + strip1.height / 2 - 900 * 0.4);
  await sleep(2500);
  let col = await column(page);
  await page.screenshot({ path: join(OUT, '610-01-mid-strip.png') });
  check('mid-strip, at most three full-size images are decoded', col.decoded <= 3 && col.decoded >= 1, JSON.stringify(col));
  const before = col;
  await page.mouse.dblclick(640, 450);
  await sleep(1500);
  col = await column(page);
  check('a double-click zoom in the middle of a strip stays where it was (F5)',
    col.page === before.page && Math.abs(col.frac - before.frac) < 0.02, `before ${JSON.stringify({ page: before.page, frac: before.frac })} after ${JSON.stringify({ page: col.page, frac: col.frac })}`);
  await page.mouse.dblclick(640, 450);
  await sleep(1000);

  console.log('\n  3. the next chapter arrives before the end does');
  await open(page, SLC[1], 1);
  // Straight to eight screens from the end of the chapter's 120 slices, then a quarter of a screen at a time.
  const lastSlice = await rowBox(page, 120);
  await scrollColumn(page, lastSlice.top + lastSlice.height - 9 * 900);
  await sleep(500);
  let seenDivider = null;
  for (let i = 0; i < 80 && seenDivider === null; i++) {
    const last = await rowBox(page, 120);
    col = await column(page);
    if (last && last.top + last.height - (col.top + col.height) <= 2 * col.height) seenDivider = col.rows > 120;
    else await scrollColumn(page, col.top + col.height * 0.25);
    await sleep(150);
  }
  check('within two screens of the end of a chapter, the next one is already in the column', seenDivider === true, String(seenDivider));

  console.log('\n  4. Crop page borders');
  await setPrefs(page, { mode: 'vertical', cropBorders: true });
  await open(page, SLC[0], 1);
  const s1 = await rowBox(page, 1);
  await scrollColumn(page, s1.top + s1.height - 900);
  await sleep(3000);
  col = await column(page);
  check('nothing is trimmed off a strip', col.crops.length > 0 && col.crops.every((v) => v === '0.000'), JSON.stringify(col.crops.slice(0, 6)));
  await setPrefs(page, { mode: 'paged', cropBorders: true });
  await open(page, MMC[0], 1);
  await sleep(1500);
  let w = await where(page);
  await page.screenshot({ path: join(OUT, '610-04-cropped.png') });
  check('about 0.067 is trimmed off a page with 80 px of paper all round', w.crop != null && Number(w.crop) >= 0.05 && Number(w.crop) <= 0.075, JSON.stringify(w));
  const cropDrawn = await drawn(page);
  check('...and that is what is drawn, on a right-to-left track too: the paper is gone from all four sides',
    near(cropDrawn.l, Number(w.crop)) && near(cropDrawn.r, Number(w.crop)) && cropDrawn.t > 0.03 && near(cropDrawn.t, cropDrawn.b), JSON.stringify(cropDrawn));
  // The webtoon column under a right-to-left interface (the Arabic one sets <html dir="rtl">): sides trimmed, the same way.
  await setPrefs(page, { mode: 'vertical', cropBorders: true });
  await open(page, MMC[0], 1);
  await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
  await scrollColumn(page, (await rowBox(page, 3)).top);
  await sleep(3000);
  const sides = await page.evaluate((c) => {
    const row = document.querySelector(`${c} [data-page="4"]`);
    const img = row?.querySelector('img');
    if (!row || !img) return null;
    const b = row.getBoundingClientRect();
    const i = img.getBoundingClientRect();
    return { crop: row.getAttribute('data-crop'), l: (b.left - i.left) / i.width, r: (i.right - b.right) / i.width };
  }, COLUMN);
  await page.evaluate(() => { document.documentElement.dir = 'ltr'; });
  check('the column trims a bordered chapter\'s sides alike, under a right-to-left interface too',
    !!sides && Number(sides.crop) > 0.05 && near(sides.l, Number(sides.crop)) && near(sides.r, Number(sides.crop)), JSON.stringify(sides));

  console.log('\n  5. Wide pages on a screen held sideways');
  await setPrefs(page, { mode: 'paged', widePages: 'split' });
  await open(page, MMC[0], 1);
  w = await where(page);
  check('held sideways, Split splits nothing: twelve slides for twelve pages', w.slides === 12 && !(await page.$('[data-half]')), JSON.stringify(w));

  console.log('\n  6-8. tap zones, keys, a controller');
  await setPrefs(page, { mode: 'paged' });
  await setDevice(page, { tapLayout: 'lshape' });
  await open(page, SLC[1], 5);
  await sleep(4500); // the controls hide on their own; a tap at the bottom must land on the page, not the bar
  await page.mouse.click(640, 860);
  await sleep(1200);
  let at = (await where(page)).page;
  await page.mouse.click(640, 60);
  await sleep(1200);
  const back = (await where(page)).page;
  check('L shape: the bottom row turns on, the top row back', at === 6 && back === 5, `${at} then ${back}`);
  await setDevice(page, { keys: { next: ['Space', 'ArrowDown', 'PageDown', 'j'] } });
  await open(page, SLC[1], 5);
  await page.keyboard.press('j');
  await sleep(1200);
  check("'j' bound to Next page turns it", (await where(page)).page === 6, JSON.stringify(await where(page)));
  // The controls, to reach the sheet: shown on opening and hidden a few seconds later, so a tap only when they are gone.
  if (!(await page.$('[data-reader-settings]'))) { await page.mouse.click(640, 450); await sleep(800); }
  await page.$eval('[data-reader-settings]', (b) => b.click()).catch(() => {});
  await sleep(700);
  const sheetOpen = !!(await page.$('[role="dialog"][aria-label="Reader"]'));
  await page.keyboard.press('Escape');
  await sleep(700);
  check('Escape still closes the sheet, and stays in the reader', sheetOpen && !(await page.$('[role="dialog"][aria-label="Reader"]')) && page.url().includes('/reader'), `open=${sheetOpen} url=${page.url()}`);
  await setDevice(page, {});
  await open(page, SLC[1], 5);
  await page.evaluate(() => { window.__padOn = true; window.dispatchEvent(new Event('gamepadconnected')); });
  await sleep(300);
  await page.evaluate(() => window.__press(15, true));
  await sleep(150);
  await page.evaluate(() => window.__press(15, false));
  await sleep(1200);
  check('a controller\'s D-pad right turns the page', (await where(page)).page === 6, JSON.stringify(await where(page)));

  console.log('\n  9. Colour filter');
  await setPrefs(page, { mode: 'paged' });
  await setDevice(page, { colorFilter: 'invert' });
  await open(page, MMC[1], 12);
  const finished = await waitFor(() => page.evaluate(() => [...document.querySelectorAll('p')].some((p) => /You finished/i.test(p.textContent || ''))), 20000, 500);
  const filters = await page.evaluate((t) => {
    // The PAGE images: the Up Next card's rail of similar series carries covers of its own, and must not be inverted.
    const imgs = [...document.querySelector(t).querySelectorAll('img')].filter((i) => /\/page\/\d+/.test(i.getAttribute('src') || ''))
      .map((i) => getComputedStyle(i).filter);
    const card = [...document.querySelectorAll('p')].find((p) => /You finished/i.test(p.textContent || ''));
    const chain = [];
    for (let e = card; e; e = e.parentElement) chain.push(getComputedStyle(e).filter);
    return { imgs, chain };
  }, TRACK);
  check('Invert is on the page images', filters.imgs.length > 0 && filters.imgs.every((f) => /invert/.test(f)), JSON.stringify(filters.imgs.slice(0, 3)));
  check('...and not on the Up Next card', !!finished && !filters.chain.some((f) => /invert/.test(f)), JSON.stringify(filters.chain));
  await setDevice(page, {});

  console.log('\n  10. Pick the mode for each series');
  await setPrefs(page, { mode: 'paged', autoMode: true });
  await open(page, SLC[0], 1);
  check('long strips open in Webtoon, whatever the default', (await modeOf(page)) === 'vertical', await modeOf(page));
  await setPrefs(page, { mode: 'vertical', autoMode: true });
  await open(page, MMC[0], 1);
  check('a bordered right-to-left manga opens Paged, right to left', (await modeOf(page)) === 'paged' && (await where(page)).dir === 'rtl', JSON.stringify(await where(page)));
  await setPrefs(page, { mode: 'vertical', autoMode: true }, { [SL]: { mode: 'paged' } });
  await open(page, SLC[0], 1);
  check("a series' own mode beats the pick", (await modeOf(page)) === 'paged', await modeOf(page));

  console.log('\n  11. F1: a source default and a resume');
  if (WT1 && WT_SOURCE) {
    await setPrefs(page, { mode: 'vertical' }, {}, { [WT_SOURCE]: { mode: 'paged' } });
    await api(`/api/books/${WT1}/progress`, { method: 'PUT', body: JSON.stringify({ page: 9, completed: false }) });
    c.progress.length = 0;
    await open(page, WT1);
    const opened = await where(page);
    check('global Webtoon + a source default of Paged + a resume at 9 opens Paged with page 9 on screen',
      (await modeOf(page)) === 'paged' && opened.page === 9 && opened.shown === 9, JSON.stringify(opened));
    await page.keyboard.press('PageDown');
    await sleep(1500);
    const turned = await where(page);
    check('...and the next page is 10, with no progress sent backwards',
      turned.page === 10 && turned.shown === 10 && !c.progress.some((p) => p.book === WT1 && p.page < 9), `${JSON.stringify(turned)} ${JSON.stringify(c.progress)}`);
  } else {
    check('Walk Tale was added from fake-a, for the source default', false, `series ${WT} chapter ${WT1} source ${WT_SOURCE}`);
  }

  console.log('\n  12. F2: a late answer from the account');
  await setPrefs(page, { mode: 'vertical' }, { [SL]: { mode: 'paged' } });
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'GET') await sleep(3000);
    await route.continue();
  });
  await open(page, SLC[1], 1);
  const early = await modeOf(page);
  await sleep(3500);
  check('a settings answer three seconds late leaves the open title Paged', early === 'paged' && (await modeOf(page)) === 'paged', `${early} then ${await modeOf(page)}`);
  await page.unroute('**/api/settings');

  // ======================================================== Chrome, 390 x 844
  console.log('\n  13-14. Wide pages on a screen held upright');
  await page.setViewportSize({ width: 390, height: 844 });
  await setPrefs(page, { mode: 'paged', widePages: 'split' });
  c.progress.length = 0;
  await open(page, MMC[0], 9);
  const halves = [];
  const regions = [];
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('PageDown');
    await sleep(1200);
    const x = await where(page);
    halves.push([x.page, x.shown, x.half]);
    regions.push(await drawn(page));
  }
  await page.screenshot({ path: join(OUT, '610-13-split.png') });
  check('a spread is its right half, then its left, both on page 10, then page 11',
    JSON.stringify(halves) === JSON.stringify([[10, 10, 'right'], [10, 10, 'left'], [11, 11, null]]), JSON.stringify(halves));
  check('each half draws its own half of the spread, on a right-to-left track',
    near(regions[0].l, 0.5) && near(regions[0].r, 0) && near(regions[1].l, 0) && near(regions[1].r, 0.5), JSON.stringify(regions.slice(0, 2)));
  const sent = c.progress.filter((p) => p.book === MMC[0]).map((p) => p.page);
  check('progress names pages, never halves: 10 once, then 11', sent.includes(10) && sent.includes(11) && sent.every((n) => Number.isInteger(n) && n >= 9 && n <= 12), JSON.stringify(sent));
  await setPrefs(page, { mode: 'paged', widePages: 'whole' });
  await open(page, MMC[0], 1);
  const whole = (await where(page)).slides;
  await setPrefs(page, { mode: 'paged', widePages: 'rotate' });
  await open(page, MMC[0], 1);
  const rotatedCount = (await where(page)).slides;
  await open(page, MMC[0], 10);
  const turnedSpread = await where(page);
  await page.screenshot({ path: join(OUT, '610-14-rotate.png') });
  check('Rotate keeps the slide count and turns the spread', whole === 12 && rotatedCount === 12 && turnedSpread.rotated, `${whole} / ${rotatedCount} / ${JSON.stringify(turnedSpread)}`);
  const turnedAt = await drawn(page);
  check('...centred on its slide, and inside it', Math.abs(turnedAt.dx) < 2 && Math.abs(turnedAt.dy) < 2 && turnedAt.fits, JSON.stringify(turnedAt));

  check('no page errors or 5xx in Chrome', c.errors.length === 0, c.errors.slice(0, 5).join(' | '));
  await c.browser.close();

  // ======================================================== WebKit, 390 x 844
  console.log('\n  15. WebKit: split halves across a right-to-left append');
  const k = await session(webkit, { width: 390, height: 844 });
  check('signed in (WebKit)', !(await k.page.$('input[type=password]')));
  await setPrefs(k.page, { mode: 'paged', widePages: 'split' });
  await setDevice(k.page, {});
  await open(k.page, MMC[0], 7);
  const seen = [];
  for (let i = 0; i < 8; i++) {
    await k.page.keyboard.press('PageDown');
    await sleep(1300);
    const x = await where(k.page);
    seen.push(`${x.chapter === MMC[0] ? 1 : x.chapter === MMC[1] ? 2 : '?'}:${x.shown}${x.half ? x.half[0] : ''}`);
  }
  await k.page.screenshot({ path: join(OUT, '610-15-webkit-append.png') });
  check('every press moves one slide, halves included, into chapter 2 (no #180 cascade)',
    JSON.stringify(seen) === JSON.stringify(['1:8', '1:9', '1:10r', '1:10l', '1:11', '1:12r', '1:12l', '2:1']), JSON.stringify(seen));
  check('no page errors or 5xx in WebKit', k.errors.length === 0, k.errors.slice(0, 5).join(' | '));
  await k.browser.close();
} catch (e) {
  check('the walk ran to the end', false, String(e?.stack || e));
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ok, ${failed} failure(s)`);
process.exit(failed ? 1 : 0);
