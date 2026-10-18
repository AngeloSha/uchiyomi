// Per-title double-page pairing offset, against a disposable instance seeded with seed.py --spreads.
// BASE=http://127.0.0.1:18140 node test/e2e/spreadOffset.mjs
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer';

const BASE = process.env.BASE;
if (!BASE) throw new Error('BASE must name the disposable test instance');
const USER = process.env.E2E_USER || 'e2e';
const PASS = process.env.E2E_PASS || 'e2e-passw0rd-123';
const OUT = process.env.OUT || 'test/e2e/shots/spread-offset';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const login = await (await fetch(`${BASE}/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }),
})).json();
console.log('API login returned');
assert.ok(login.accessToken, 'the disposable account signs in');
const api = async (path, method = 'GET', body) => {
  const r = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${login.accessToken}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(r.ok, `${method} ${path}: ${r.status}`);
  return r.json();
};
await api('/api/refresh', 'POST', {});
const series = (await api('/api/series/search', 'POST', { query: '', size: 100 })).content
  .find((s) => s.name === 'Walk Two Two Nine Spreads');
assert.ok(series, 'the generated spread fixture is scanned');
console.log('Fixture series found');
const books = (await api(`/api/series/${series.id}/books?size=50`)).content.sort((a, b) => a.number - b.number);
assert.ok(books.length >= 2);
const prefs = { junkPages: 'show', skipJunk: false, gap: 0, brightness: 1, mode: 'paged', autoScroll: 0, fitWidth: true, theme: 'amoled', spread: true, pagedDirection: 'series', widePages: 'whole', cropBorders: false, autoMode: false, joinSplit: false };
await api('/api/settings', 'PUT', { reader: prefs, readerSeries: {}, readerSource: {} });
console.log('Reader preferences saved');
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', (e) => { errors.push(e.message); console.log('PAGE ERROR', e.stack); });
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.waitForSelector('input[type=password]');
  await sleep(2500);
  await page.locator('input').fill(USER);
  await page.locator('input[type=password]').fill(PASS);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('input[type=password]'));
  await page.evaluate((p) => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('yomi_rs_')) localStorage.removeItem(k);
    localStorage.setItem('yomi_reader_prefs', JSON.stringify(p));
  }, prefs);
  console.log('Browser signed in');
  const open = async (book, n = 1) => {
    await page.goto(`${BASE}/reader/?book=${book}&page=${n}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-chapter]');
    await page.waitForFunction(() => !document.body.innerText.includes('Loading chapter'), { timeout: 60_000 });
    console.log('Reader opened', book, n);
    await sleep(1500);
  };
  const visible = () => page.evaluate(() => {
    const track = document.querySelector('div.snap-x[dir]');
    if (!track) return [];
    const slide = [...track.children].find((s) => { const r = s.getBoundingClientRect(); return r.left > -track.clientWidth / 2 && r.left < track.clientWidth / 2; });
    return [...(slide?.querySelectorAll('img') || [])].map((im) => Number(im.src.match(/\/page\/(\d+)/)?.[1])).sort((a, b) => a - b);
  });
  const toggle = async () => {
    if (!(await page.$('[data-reader-settings]'))) await page.mouse.click(640, 450);
    await page.waitForSelector('[data-reader-settings]', { visible: true });
    await page.locator('[data-reader-settings]').click();
    console.log('Settings opened');
    await page.waitForSelector('[data-spread-shift] input', { visible: true });
    await page.locator('[data-spread-shift] input').click();
    await page.keyboard.press('Escape');
    await sleep(900);
  };
  await open(books[0].id);
  assert.deepEqual(await visible(), [1], 'default pairing leaves the first page solo');
  await toggle();
  assert.deepEqual(await visible(), [1, 2], 'toggling immediately pairs pages 1 and 2');
  assert.equal(await page.evaluate((id) => JSON.parse(localStorage.getItem(`yomi_rs_${id}`)).spreadShift, series.id), true);
  await sleep(2000); // allow account preference sync to settle before the reload
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(1500);
  assert.deepEqual(await visible(), [1, 2], 'the title retains the offset after reload');
  await open(books[1].id);
  assert.deepEqual(await visible(), [1, 2], 'the next chapter of the same title retains the offset');
  await open(books[0].id, 6);
  assert.ok((await visible()).includes(6), 'page 6 is visible before changing the pairing');
  await toggle();
  assert.ok((await visible()).includes(6), 'changing the pairing keeps the page being read in view');
  assert.deepEqual(errors, [], 'no browser runtime errors');
  await page.screenshot({ path: join(OUT, 'reader-offset.png') });
  console.log('PASS: default, live toggle, per-title persistence, chapter continuation, position preservation and browser errors');
} finally {
  await browser.close();
}
