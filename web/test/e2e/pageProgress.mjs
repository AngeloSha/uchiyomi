// Browser rendering of live page progress; only GET /api/sources/jobs is stubbed. Never starts a download.
// Run against a disposable seeded instance: BASE=http://127.0.0.1:18140 node test/e2e/pageProgress.mjs
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer';

const BASE = process.env.BASE;
if (!BASE) throw new Error('BASE must name a disposable seeded instance');
const USER = process.env.E2E_USER || 'e2e';
const PASS = process.env.E2E_PASS || 'e2e-passw0rd-123';
const OUT = process.env.OUT || 'test/e2e/shots/page-progress';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const login = await (await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) })).json();
assert.ok(login.accessToken);
await fetch(`${BASE}/api/refresh`, { method: 'POST', headers: { authorization: `Bearer ${login.accessToken}`, 'content-type': 'application/json' }, body: '{}' });
const r = await fetch(`${BASE}/api/series/search`, { method: 'POST', headers: { authorization: `Bearer ${login.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ query: '', size: 100 }) });
const series = (await r.json()).content[0];
assert.ok(series, 'the disposable library has a series');
const folder = 'Fixture Source/Progress Test';
let done = 10;
const jobs = () => ({
  content: [{ folder, seriesId: series.id, title: series.name, status: 'downloading', origin: 'fetch', mine: true, total: 1, done: 0, startedAt: Date.now() - 10_000 }],
  runs: [],
  activity: { active: [{ id: 1, folder, seriesId: series.id, title: series.name, number: 3, source: 'Fixture Source', status: 'downloading', origin: 'fetch', pagesDone: done, pagesTotal: 40, pagesSince: Date.now() - 10_000, startedAt: Date.now() - 10_000 }], recent: [] },
});
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/sources/jobs' && request.method() === 'GET') {
      void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(jobs()) });
    } else { void request.continue(); }
  });
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.waitForSelector('input[type=password]');
  await sleep(2500);
  await page.locator('input').fill(USER);
  await page.locator('input[type=password]').fill(PASS);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('input[type=password]'));
  for (const width of [1280, 390]) {
    done = 10;
    await page.setViewport({ width, height: 900 });
    await page.goto(`${BASE}/library/?view=downloads`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-page-progress="10/40"]');
    const read = () => page.$eval('[data-page-progress] [role=progressbar]', (el) => ({ now: el.getAttribute('aria-valuenow'), max: el.getAttribute('aria-valuemax'), label: el.getAttribute('aria-label') }));
    let bar = await read();
    assert.equal(bar.now, '10'); assert.equal(bar.max, '40'); assert.match(bar.label, /10\/40 pages/); assert.match(bar.label, /left/);
    done = 20;
    await page.waitForSelector('[data-page-progress="20/40"]', { timeout: 10_000 });
    bar = await read(); assert.equal(bar.now, '20');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(OUT, `downloads-${width}.png`) });
  }
  await page.goto(`${BASE}/series/?id=${series.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-page-progress="20/40"]');
  assert.deepEqual(errors, [], 'no browser runtime errors');
  console.log('PASS: desktop/mobile rendering, accessibility values, ETA, live polling and series band; no download started');
} finally { await browser.close(); }
