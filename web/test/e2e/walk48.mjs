// Browser acceptance walk for v0.48.0 — which way a series reads (#102).
//
// "Series default" could never read right to left: every series answered WEBTOON. And a title whose look had
// been changed in the reader had the profile's direction pinned to it, so Profile → Settings → Reading
// direction never reached it again. This walk drives both in a real Chrome, plus what fell out of the first:
//
//   1. a series whose ComicInfo says YesAndRightToLeft opens paged right to left under Series default, and a
//      series that says nothing still reads left to right;
//   2. double spreads: the first page on the right of a right-to-left track, and a right-to-left series forced
//      left to right still puts the halves of a spread back together;
//   3. a page turn across a chapter boundary moves ONE page on a right-to-left track (it jumped fourteen:
//      reader/page.tsx untilStill);
//   4. a title carrying a pinned "Series default" from v0.46/v0.47 follows the profile's Right to left;
//   5. the same made through the UI: a theme change in the reader's sheet pins the look but not the
//      direction, Profile → Settings → Right to left then reaches the title, and a direction chosen in the
//      sheet for one title is kept;
//   6. the admin's direction in Edit details is what Series default follows, and Automatic hands it back.
//
// Needs an instance of its OWN and its library folder, into which it writes its two series
// (`seed.py --rtl`) before asking the server to scan:
//
//   KEEP=1 E2E_NET=uchiyomi-e2e-48 E2E_PORT=18148 E2E_SUBNET=10.222.8.0/24 bash web/test/e2e/up.sh
//   cd web && LIB=<the library folder up.sh printed> BASE=http://127.0.0.1:18148 npm run test:e2e:v048
//
// ⚠️ The reader adopts the account's copy of the reader settings on load and the server copy wins, so every
// step writes them BOTH to /api/settings and to localStorage; localStorage alone is overwritten by whatever an
// earlier step saved.
// ⚠️ "Next page" is pressed as Page Down, which means the next page whichever way the pages run; the arrows
// are physical. The sign of the track's scrollLeft afterwards is which way the next page lay.
import puppeteer from 'puppeteer';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://127.0.0.1:18148';
const USER = process.env.E2E_USER || 'e2e';
const PASS = process.env.E2E_PASS || 'e2e-passw0rd-123';
const LIB = process.env.LIB;
const OUT = process.env.OUT || 'shots48';
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
execFileSync('python3', [join(dirname(fileURLToPath(import.meta.url)), 'seed.py'), LIB, '--rtl'], { stdio: 'inherit' });
const login = await (await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) })).json();
const TOKEN = login.accessToken;
const api = async (path, opts = {}) => {
  const r = await fetch(BASE + path, { ...opts, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } });
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};
await api('/api/refresh', { method: 'POST', body: '{}' });
let found = [];
for (let i = 0; i < 30 && found.length < 2; i++) {
  await sleep(1000);
  found = (await api('/api/series/search', { method: 'POST', body: JSON.stringify({ query: '', size: 100 }) })).content
    .filter((s) => s.name === 'Right To Left' || s.name === 'Walk Forty Eight Plain');
}
const MANGA = found.find((s) => s.name === 'Right To Left')?.id;
const PLAIN = found.find((s) => s.name === 'Walk Forty Eight Plain')?.id;
if (!MANGA || !PLAIN) { console.error('the scan did not list the walk\'s two series'); process.exit(1); }
const books = async (sid) => (await api(`/api/series/${sid}/books?size=10`)).content.sort((a, b) => a.number - b.number).map((b) => b.id);
const [MANGA_1] = await books(MANGA);
const [PLAIN_1] = await books(PLAIN);

// ---- the browser, signed in once (the login limit is 10 per five minutes) ----
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'], defaultViewport: { width: WIDTH, height: 900 } });
const page = await browser.newPage();
const serverErrors = [];
page.on('response', (r) => { if (r.status() >= 500) serverErrors.push(`${r.status()} ${r.url()}`); });
await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForSelector('input[type=password]', { timeout: 30000 });
await sleep(2500); // the form renders again once /auth/config answers; typing before that is lost
await (await page.$$('input'))[0].type(USER);
await page.type('input[type=password]', PASS);
await page.keyboard.press('Enter');
await sleep(4000);
check('signed in', !(await page.$('input[type=password]')));

const DEFAULTS = { junkPages: 'collapse', skipJunk: true, gap: 0, brightness: 1, mode: 'vertical', autoScroll: 0, fitWidth: true, theme: 'amoled', spread: false, pagedDirection: 'series' };
/** The account's reader settings AND this browser's copy of them. */
async function setPrefs(reader, readerSeries = {}) {
  const full = { ...DEFAULTS, ...reader };
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ reader: full, readerSeries, readerSource: {} }) });
  await page.evaluate((full, readerSeries) => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('yomi_rs_') || k.startsWith('yomi_rp_')) localStorage.removeItem(k);
    localStorage.setItem('yomi_reader_prefs', JSON.stringify(full));
    for (const [id, v] of Object.entries(readerSeries)) localStorage.setItem(`yomi_rs_${id}`, JSON.stringify(v));
  }, full, readerSeries);
}
const TRACK = 'div.snap-x[dir]';
/** Where the track is and what is on screen: the pages of the slide in view, left to right as drawn. */
const measure = () => page.$eval(TRACK, (el) => {
  const w = el.clientWidth;
  const slide = [...el.children].find((s) => { const r = s.getBoundingClientRect(); return r.left > -w / 2 && r.left < w / 2; });
  const pages = slide ? [...slide.querySelectorAll('img')]
    .map((i) => ({ n: Number((i.getAttribute('src') || '').match(/\/page\/(\d+)/)?.[1]), x: i.getBoundingClientRect().left }))
    .sort((a, b) => a.x - b.x).map((p) => p.n) : [];
  return { dir: el.getAttribute('dir'), filter: el.style.filter, left: Math.round(el.scrollLeft), width: w, pages };
});
/** Open on page 1: an explicit `?page=` beats resuming from progress, which every earlier step moved. */
async function open(bookId) {
  await page.goto(`${BASE}/reader/?book=${bookId}&page=1`, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector(TRACK, { timeout: 20000 });
  await sleep(2000);
}
/** Open, turn to the next page, and measure. */
async function openAndTurn(bookId, shot) {
  await open(bookId);
  await page.keyboard.press('PageDown');
  await sleep(1200);
  const m = await measure();
  if (shot) await page.screenshot({ path: `${OUT}/${shot}.png` });
  return m;
}
const clickText = (text) => page.evaluate((t) => {
  const b = [...document.querySelectorAll('button')].filter((x) => x.textContent?.trim() === t);
  if (b.length === 1) b[0].click();
  return b.length;
}, text);
const SLIDERS = 'button:has(path[d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h7M15 18h5"])';
/** The reader's settings sheet. Its button lives in the auto-hiding top bar, so the bar is brought back first. */
async function openSheet() {
  if (!(await page.$(SLIDERS))) { await page.mouse.click(WIDTH / 2, 450); await sleep(700); }
  // A DOM click: the bar animates in, and a mouse click mid-animation is refused as "not clickable".
  await page.$eval(SLIDERS, (b) => b.click());
  await sleep(600);
}

try {
  console.log('\n  1. Series default');
  await setPrefs({ mode: 'paged' });
  let m = await openAndTurn(MANGA_1, '01-manga-series-default');
  check('a right-to-left series opens with a right-to-left track', m.dir === 'rtl', JSON.stringify(m));
  check('...and its next page is to the left', m.left === -m.width, JSON.stringify(m));
  m = await openAndTurn(PLAIN_1, '02-plain-series-default');
  check('a series that says nothing still reads left to right', m.dir === 'ltr' && m.left === m.width, JSON.stringify(m));

  console.log('\n  2. double spreads');
  await setPrefs({ mode: 'paged', spread: true });
  m = await openAndTurn(MANGA_1, '03-manga-spread');
  check('right to left: page 2 is drawn to the right of page 3', JSON.stringify(m.pages) === '[3,2]', JSON.stringify(m));
  await setPrefs({ mode: 'paged', spread: true, pagedDirection: 'ltr' });
  m = await openAndTurn(MANGA_1, '04-manga-spread-forced-ltr');
  check('a right-to-left series read left to right still reassembles its spread', m.dir === 'ltr' && JSON.stringify(m.pages) === '[3,2]', JSON.stringify(m));
  m = await openAndTurn(PLAIN_1, '05-plain-spread-ltr');
  check('a left-to-right series keeps page 2 on the left', JSON.stringify(m.pages) === '[2,3]', JSON.stringify(m));

  console.log('\n  3. a page turn across a chapter boundary');
  await setPrefs({ mode: 'paged' });
  await open(MANGA_1);
  const steps = [];
  for (let i = 0; i < 14; i++) {
    const before = (await measure()).left;
    await page.keyboard.press('PageDown');
    await sleep(1100);
    steps.push(((await measure()).left - before) / WIDTH);
  }
  await page.screenshot({ path: `${OUT}/06-across-the-boundary.png` });
  check('every press moves exactly one page, into the next chapter too', steps.every((s) => s === -1), JSON.stringify(steps));

  console.log('\n  4. a title pinned by v0.46/v0.47');
  await setPrefs({ mode: 'paged', pagedDirection: 'rtl' }, { [PLAIN]: { mode: 'paged', theme: 'sepia', spread: false, pagedDirection: 'series' } });
  m = await openAndTurn(PLAIN_1, '07-old-pin-profile-rtl');
  check("the profile's Right to left reaches it", m.dir === 'rtl' && m.left === -m.width, JSON.stringify(m));
  check('...and it keeps its own theme', /sepia/.test(m.filter), m.filter);

  console.log('\n  5. through the UI');
  await setPrefs({ mode: 'paged' });
  await open(PLAIN_1);
  await openSheet();
  await page.screenshot({ path: `${OUT}/08-reader-sheet.png` });
  check('the sheet offers Sepia once', (await clickText('Sepia')) === 1);
  await sleep(2600); // the 1.5 s debounce, then the PUT
  let s = await api('/api/settings');
  check('a theme change pins the look to the title, not the direction',
    s.readerSeries?.[PLAIN]?.theme === 'sepia' && !('pagedDirection' in (s.readerSeries?.[PLAIN] ?? {})), JSON.stringify(s.readerSeries?.[PLAIN]));
  await page.goto(`${BASE}/profile/?tab=Settings`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2500);
  check('Profile → Settings offers Right to left once', (await clickText('Right to left')) === 1);
  await sleep(2600);
  await page.screenshot({ path: `${OUT}/09-profile-rtl.png` });
  s = await api('/api/settings');
  check('the profile saved it', s.reader?.pagedDirection === 'rtl', s.reader?.pagedDirection);
  m = await openAndTurn(PLAIN_1, '10-sheet-pin-then-profile-rtl');
  check("the profile's Right to left reaches the title changed in the sheet", m.dir === 'rtl' && m.left === -m.width, JSON.stringify(m));
  check('...which keeps the sheet\'s theme', /sepia/.test(m.filter), m.filter);
  await openSheet();
  check('the sheet offers Left to right once', (await clickText('Left to right')) === 1);
  await sleep(2600);
  s = await api('/api/settings');
  check('a direction chosen in the sheet is pinned, and marked as chosen',
    s.readerSeries?.[PLAIN]?.pagedDirection === 'ltr' && s.readerSeries?.[PLAIN]?.directionChosen === true, JSON.stringify(s.readerSeries?.[PLAIN]));
  m = await openAndTurn(PLAIN_1);
  check('...and it holds while the profile says Right to left', m.dir === 'ltr', JSON.stringify(m));

  console.log('\n  6. the admin\'s direction');
  await setPrefs({ mode: 'paged' });
  await page.goto(`${BASE}/series/?id=${MANGA}`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2500);
  await page.evaluate(() => { [...document.querySelectorAll('button')].find((x) => x.textContent?.includes('Edit details'))?.click(); });
  await sleep(1000);
  const DIR_SELECT = 'select:has(option[value="RIGHT_TO_LEFT"])';
  const sel = await page.$eval(DIR_SELECT, (el) => { el.scrollIntoView({ block: 'center' }); return { value: el.value, auto: el.options[0].textContent }; }).catch(() => null);
  await page.screenshot({ path: `${OUT}/11-edit-details.png` });
  check('Edit details says what Automatic is and what said so',
    sel?.value === '' && sel?.auto === 'Automatic — Right to left, from the chapter files', JSON.stringify(sel));
  await page.select(DIR_SELECT, 'LEFT_TO_RIGHT');
  check('Save details is there', (await clickText('Save details')) === 1);
  await sleep(1500);
  m = await openAndTurn(MANGA_1, '12-admin-ltr');
  check("Series default follows the admin's Left to right", m.dir === 'ltr' && m.left === m.width, JSON.stringify(m));
  await api(`/api/admin/series/${MANGA}/meta`, { method: 'PUT', body: JSON.stringify({ title: 'Right To Left', readingDirection: null }) });
  m = await openAndTurn(MANGA_1);
  check('Automatic hands it back to the ComicInfo', m.dir === 'rtl', JSON.stringify(m));
} catch (e) {
  check('the walk ran to the end', false, String(e?.stack || e));
}
check('no 5xx along the way', serverErrors.length === 0, serverErrors.slice(0, 5).join(' | '));
await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ok, ${failed} failure(s)`);
process.exit(failed ? 1 : 0);
