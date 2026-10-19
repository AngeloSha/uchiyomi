// Browser walk for chapter comments and reactions (v0.87.0, components/ChapterTalk.tsx). Not run in CI; run it, in both
// engines, before a release that touches the reader's strip between chapters, the talk sheet or the series page's counts.
//
// Against an instance of its own with the e2e library (seed.py's Repeated Pages, three chapters):
//
//   KEEP=1 E2E_NET=uchiyomi-e2e-cmt E2E_PORT=18187 E2E_SUBNET=10.222.187.0/24 E2E_NO_WALK=1 bash web/test/e2e/up.sh
//   cd web && npm i --no-save playwright && npx playwright install chromium webkit
//   BASE=http://127.0.0.1:18187 ENGINE=chromium node test/e2e/walkComments.mjs
//   BASE=http://127.0.0.1:18187 ENGINE=webkit node test/e2e/walkComments.mjs
//
// It makes two members of its own: walk-friend, who talks first, and walk-outside, who has no library at all. Sign-ins are
// kept for ten minutes in OUT (the login limit is ten in five minutes: up.sh's, and one run per engine, fit under it).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let pw;
try {
  pw = await import('playwright');
} catch {
  console.error('walkComments drives Playwright: in web/, `npm i --no-save playwright && npx playwright install chromium webkit` first');
  process.exit(2);
}

const BASE = process.env.BASE || 'http://127.0.0.1:18187';
const USER = process.env.E2E_USER || 'e2e';
const PASS = process.env.E2E_PASS || 'e2e-passw0rd-123';
const ENGINE = process.env.ENGINE || 'chromium';
const OUT = process.env.OUT || `shots-comments-${ENGINE}`;
const SERIES = process.env.SERIES || 'Repeated Pages';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`  [${ok ? ' ok ' : 'FAIL'}] ${name}${!ok && detail ? `\n         ${detail}` : ''}`);
};

// ---- sign-ins, kept for ten minutes ----
const CACHE = join(OUT, '..', 'walk-comments-tokens.json');
const cached = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
async function login(username, password) {
  const hit = cached[`${BASE}|${username}`];
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.token;
  const r = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  if (!r.ok) throw new Error(`login ${username}: ${r.status} ${await r.text()}`);
  const token = (await r.json()).accessToken;
  cached[`${BASE}|${username}`] = { token, at: Date.now() };
  writeFileSync(CACHE, JSON.stringify(cached));
  return token;
}
const call = async (token, method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const ok = async (p) => { const r = await p; if (r.status >= 400) throw new Error(`${r.status} ${JSON.stringify(r.body)}`); return r.body; };

const ADMIN = await login(USER, PASS);
const member = async (username, extra = {}) => {
  const list = (await ok(call(ADMIN, 'GET', '/api/admin/users'))).content ?? (await ok(call(ADMIN, 'GET', '/api/admin/users')));
  let u = (Array.isArray(list) ? list : []).find((x) => x.username === username);
  if (!u) u = await ok(call(ADMIN, 'POST', '/api/admin/users', { username, password: 'walk-passw0rd-123', displayName: username === 'walk-friend' ? 'Walk Friend' : 'Walk Outside', role: 'user' }));
  if (Object.keys(extra).length) await ok(call(ADMIN, 'PATCH', `/api/admin/users/${u.id}`, extra));
  return u;
};
await member('walk-friend');
await member('walk-outside', { libraries: [] });
const FRIEND = await login('walk-friend', 'walk-passw0rd-123');
const OUTSIDE = await login('walk-outside', 'walk-passw0rd-123');

const sid = (await ok(call(ADMIN, 'POST', '/api/series/search?size=100', {}))).content.find((s) => s.name === SERIES)?.id;
if (!sid) { console.error(`no series named ${SERIES} on ${BASE}`); process.exit(1); }
const books = (await ok(call(ADMIN, 'GET', `/api/series/${sid}/books?size=20`))).content.sort((a, b) => a.number - b.number);
const [one, two] = books;
// A clean start: nothing said about the walk's chapters, nobody in Incognito.
for (const b of books) {
  const t = await ok(call(ADMIN, 'GET', `/api/books/${b.id}/comments`));
  for (const c of t.comments) await call(ADMIN, 'DELETE', `/api/comments/${c.id}`);
  await call(ADMIN, 'DELETE', `/api/books/${b.id}/reaction`);
  await call(FRIEND, 'DELETE', `/api/books/${b.id}/reaction`);
}
await ok(call(ADMIN, 'PUT', '/api/settings', { incognito: false }));
// The friend says something about chapter 1 first.
await ok(call(FRIEND, 'POST', `/api/books/${one.id}/comments`, { body: 'Walk: the friend was here first', page: 2 }));
await ok(call(FRIEND, 'PUT', `/api/books/${one.id}/reaction`, { emoji: '😂' }));

console.log('0. Talk is the household\'s: a member with no library gets nothing');
check('a member without the library: 404 on the chapter\'s talk', (await call(OUTSIDE, 'GET', `/api/books/${one.id}/comments`)).status === 404);
check('and on the series\' counts', (await call(OUTSIDE, 'GET', `/api/series/${sid}/comments`)).status === 404);

// The reader as walk263 sets it: the webtoon column, nothing automatic.
const PREFS = { junkPages: 'show', skipJunk: false, gap: 0, brightness: 1, mode: 'vertical', autoScroll: 0, fitWidth: true, theme: 'amoled', spread: false, pagedDirection: 'ltr', widePages: 'whole', cropBorders: false, autoMode: false };
await ok(call(ADMIN, 'PUT', '/api/settings', { reader: PREFS, readerSeries: {}, readerSource: {}, lang: 'en' }));

const browser = await pw[ENGINE].launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
// ⚠️ Headless WebKit on a Linux host can report `navigator.onLine === false`, and the app then sends every page but the
// reader to Offline (lib/auth.tsx, AppShell).
await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'onLine', { get: () => true, configurable: true }));
const page = await ctx.newPage();
const errors = [];
let signedIn = false;
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (signedIn && m.type() === 'error') errors.push(m.text()); });
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
  localStorage.setItem('uchiyomi.lang', 'en');
}, PREFS);
signedIn = true;

console.log('1. The series page: the chapter with talk says so, and its menu opens it');
await page.goto(`${BASE}/series/?id=${sid}`, { waitUntil: 'networkidle' });
const row = page.locator(`#ch-${one.number}`);
await row.waitFor({ timeout: 20000 });
await page.waitForSelector(`#ch-${one.number} [data-row-comments]`, { timeout: 15000 }).catch(() => {});
check('chapter 1\'s row counts its comment', (await row.locator('[data-row-comments]').innerText().catch(() => '')).includes('1'));
check('and its reaction', (await row.locator('[data-row-reactions]').innerText().catch(() => '')).includes('😂'));
check('chapter 2\'s row says nothing', (await page.locator(`#ch-${two.number} [data-row-comments]`).count()) === 0);
// Mid-screen first: a menu opens below its key, and on a phone a row near the foot has the bars over it.
await page.evaluate((n) => document.getElementById(`ch-${n}`).scrollIntoView({ block: 'center' }), one.number);
await sleep(1200);
await row.locator('button[aria-haspopup="menu"]').click();
await page.locator('[data-menu-item="comments"]').click();
await page.waitForSelector('[data-talk-sheet]', { timeout: 10000 });
check('the menu\'s Comments opens the chapter\'s talk', (await page.locator('[data-comment]').allInnerTexts()).some((t) => t.includes('the friend was here first')));
await page.screenshot({ path: join(OUT, '1-series-sheet.png') });
await page.keyboard.press('Escape');
await sleep(500);

console.log('2. The reader: the strip where chapter 1 ends');
await page.goto(`${BASE}/reader/?book=${one.id}&page=last`, { waitUntil: 'networkidle' });
const seam = page.locator(`[data-seam="${one.id}"]`);
await seam.waitFor({ timeout: 30000 });
await page.evaluate((id) => document.querySelector(`[data-seam="${id}"]`).scrollIntoView({ block: 'center' }), one.id);
await page.waitForSelector(`[data-seam="${one.id}"] [data-faces]`, { timeout: 15000 }).catch(() => {});
// Each name sits in its own direction isolate (U+2068 ... U+2069, lib/comments.ts reactedLine).
check('the strip shows who reacted', (await seam.locator('[data-seam-open]').innerText()).replace(/[\u2068\u2069]/g, '').includes('Walk Friend reacted'));
check('and how many comments', (await seam.locator('[data-seam-open]').innerText()).includes('1 comment'));
const box = await seam.boundingBox();
check('the strip is the height the reader keeps for it', !!box && Math.abs(box.height - 156) < 1, `height ${box?.height}`);
await sleep(4500); // the bars hide
await page.screenshot({ path: join(OUT, '2-seam.png') });
const before = page.url();
await seam.locator('[data-reaction="🔥"]').click();
await sleep(1200);
check('one tap reacts: the key is pressed', (await seam.locator('[data-reaction="🔥"]').getAttribute('aria-pressed')) === 'true');
check('a tap on a reaction is not a tap on the page: the bars stayed away', (await page.locator('[data-talk-open]').count()) === 0);
check('and nothing navigated', page.url() === before);
const mine = (await ok(call(ADMIN, 'GET', `/api/books/${one.id}/comments`))).reactions.find((r) => r.mine);
check('the server has the reaction', mine?.emoji === '🔥', JSON.stringify(mine));

console.log('3. The top bar\'s key opens the chapter on screen, and a reply goes in with its page');
await page.mouse.click(195, 120);
await sleep(900);
await page.locator('[data-talk-open]').click();
await page.waitForSelector('[data-talk-sheet]', { timeout: 10000 });
const sheetFor = await page.locator('[data-talk-sheet]').getAttribute('data-talk-sheet');
check('the sheet is a loaded chapter\'s', books.some((b) => b.id === sheetFor), sheetFor);
await page.locator('[data-talk-form] textarea').fill('Walk: a reply from the reader');
await page.locator('[data-talk-form] button[type=submit]').click();
await page.waitForFunction(() => [...document.querySelectorAll('[data-comment]')].some((n) => n.textContent.includes('a reply from the reader')), null, { timeout: 10000 }).catch(() => {});
const replied = (await ok(call(ADMIN, 'GET', `/api/books/${sheetFor}/comments`))).comments.find((c) => c.mine);
check('the reply is on the server', !!replied && replied.body === 'Walk: a reply from the reader', JSON.stringify(replied));
check('with the page it was written on', !!replied && Number.isInteger(replied.page) && replied.page >= 1, JSON.stringify(replied?.page));
await page.screenshot({ path: join(OUT, '3-sheet.png') });

console.log('4. Escape closes the comments, not the reader');
const at = page.url();
await page.keyboard.press('Escape');
await sleep(1500);
check('the sheet closed', (await page.locator('[data-talk-sheet]').count()) === 0);
// Reintroduce by dropping `&& !escFoundDialog.current` in app/reader/page.tsx: the reader goes back to the series page.
check('Escape closes the comments, not the reader', page.url() === at && page.url().includes('/reader/'), page.url());

console.log('5. A paged track: the chapter\'s key on its last page');
await page.evaluate((s) => localStorage.setItem(`yomi_rs_${s}`, JSON.stringify({ mode: 'paged' })), sid);
await page.goto(`${BASE}/reader/?book=${one.id}&page=last`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-talk-key]', { timeout: 15000 }).catch(() => {});
const key = await page.locator('[data-talk-key]').innerText().catch(() => '');
check('the key on the last page says what is there', key.includes('🔥') && key.includes('😂'), key);
await page.screenshot({ path: join(OUT, '4-paged.png') });
await page.locator('[data-talk-key]').click();
await page.waitForSelector('[data-talk-sheet]', { timeout: 10000 }).catch(() => {});
check('and opens the chapter\'s talk', (await page.locator('[data-talk-sheet]').getAttribute('data-talk-sheet').catch(() => null)) === one.id);
await page.keyboard.press('Escape');
await page.evaluate((s) => localStorage.removeItem(`yomi_rs_${s}`), sid);

console.log('6. Incognito reading: the talk is read-only');
await ok(call(ADMIN, 'PUT', '/api/settings', { incognito: true }));
try {
  await page.goto(`${BASE}/reader/?book=${one.id}&page=last`, { waitUntil: 'networkidle' });
  await page.mouse.click(195, 120);
  await sleep(900);
  if (!(await page.locator('[data-talk-open]').count())) { await page.mouse.click(195, 120); await sleep(900); }
  await page.locator('[data-talk-open]').click();
  await page.waitForSelector('[data-talk-sheet]', { timeout: 10000 });
  check('the box to write in says why it is not there', (await page.locator('[data-talk-incognito]').count()) === 1 && (await page.locator('[data-talk-form]').count()) === 0);
  check('the reactions are keys that do nothing', await page.locator('[data-talk-sheet] [data-reaction="❤️"]').isDisabled());
  await page.screenshot({ path: join(OUT, '5-incognito.png') });
  await page.keyboard.press('Escape');
} finally {
  await ok(call(ADMIN, 'PUT', '/api/settings', { incognito: false }));
}

// A 401 is the boot's first ask before its session is refreshed (GET /api/settings, every page load, before v0.87.0 too).
const real = errors.filter((e) => !/status of 401/.test(e));
check('no errors in the console', real.length === 0, real.slice(0, 5).join(' | '));
await browser.close();
const bad = results.filter((r) => !r).length;
console.log(`\n${results.length - bad}/${results.length} checks passed (${ENGINE})`);
process.exit(bad ? 1 : 0);
