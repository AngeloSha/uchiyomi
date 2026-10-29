// Real title-art controls against up.sh's disposable instance; never a production library.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer';
import { pressSeriesMoreItem } from './seriesMore.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:18140';
const target = new URL(BASE);
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname) && target.protocol === 'http:', 'use a disposable localhost fixture');
const OUT = process.env.OUT || 'test/e2e/shots-title-art';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn, label) => {
  for (let i = 0; i < 100; i++) { const value = await fn(); if (value) return value; await sleep(150); }
  throw new Error(`Timed out: ${label}`);
};
const login = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: process.env.E2E_USER || 'e2e', password: process.env.E2E_PASS || 'e2e-passw0rd-123' }) });
assert.equal(login.status, 200);
const { accessToken } = await login.json();
const api = async (path, options = {}) => {
  const r = await fetch(BASE + path, { ...options, headers: { authorization: `Bearer ${accessToken}`, ...(options.body ? { 'content-type': 'application/json' } : {}) } });
  assert.ok(r.ok, `${path}: ${r.status} ${await r.clone().text()}`);
  return r.json();
};
const settings = await api('/api/admin/settings');
assert.equal(settings.automatic_title_logos, false, 'fixture default makes no automatic provider requests');
const featured = await api('/api/featured');
const selected = featured.content[0];
assert.ok(selected, 'seeded featured manga');
const id = selected.id;
const detail = () => api(`/api/series/${encodeURIComponent(id)}`);
const before = await detail();
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
try {
  for (const cookie of login.headers.getSetCookie()) {
    const pair = cookie.split(';')[0], i = pair.indexOf('=');
    await browser.defaultBrowserContext().setCookie({ name: pair.slice(0, i), value: pair.slice(i + 1), url: BASE });
  }
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.stack || e.message));
  await page.setViewport({ width: 1440, height: 1000 });
  await page.setBypassServiceWorker(true);
  const visibleTitle = () => page.evaluate(() => {
    const h = [...document.querySelectorAll('h1[data-hero-title]')].find((e) => e.getClientRects().length);
    return h && { text: h.textContent, style: h.dataset.titleStyle, logo: !!h.querySelector('img.hero-title-logo:not(.hero-title-loading)'),
      caption: h.querySelector('.hero-title-caption')?.textContent, fallback: !!h.querySelector('.hero-title-text') };
  });
  const click = async (selector) => {
    await page.waitForSelector(selector, { visible: true });
    await page.$eval(selector, (e) => e.scrollIntoView({ block: 'center' }));
    await page.click(selector);
  };
  const openEditor = async () => {
    assert.ok(await pressSeriesMoreItem(page, 'edit-details'), 'actual More → Edit details action');
    await page.waitForSelector('[role="dialog"]');
    await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].find((e) => e.textContent.trim() === 'Art' && e.getClientRects().length)?.click());
    await page.waitForSelector('[data-title-art-editor]', { visible: true });
  };
  const closeEditor = async () => {
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-title-art-editor]'));
  };
  await page.goto(`${BASE}/series/?id=${encodeURIComponent(id)}`, { waitUntil: 'networkidle2' });
  assert.ok((await visibleTitle())?.fallback, 'unavailable logo immediately has a readable fallback');
  await openEditor();
  await page.select('[data-title-art-style]', 'fantasy');
  await wait(async () => (await detail()).titleArt?.style === 'fantasy', 'saved style');
  const chooserPromise = page.waitForFileChooser();
  await click('[data-art-upload="logo"]');
  const chooser = await chooserPromise;
  await chooser.accept([new URL('../fixtures/title-logo.png', import.meta.url).pathname]);
  const custom = await wait(async () => { const s = await detail(); return s.titleArt?.mode === 'custom' && s.titleArt.logoUrl ? s : null; }, 'saved custom logo');
  assert.equal(custom.titleArt.showReadableTitle, true, 'an unclassified uploaded logo retains a readable caption');
  await page.waitForFunction(() => document.querySelector('[data-art-preview="logo"]')?.getAttribute('data-busy') === 'false');
  await closeEditor();
  await wait(async () => (await visibleTitle())?.logo, 'decoded series hero logo');
  assert.ok((await visibleTitle()).caption?.includes(custom.metadata?.title || custom.name));
  await page.screenshot({ path: `${OUT}/series-desktop.png`, fullPage: false });
  const fromFeatured = (await api('/api/featured')).content.find((s) => s.id === id);
  assert.equal(fromFeatured.titleArt.version, custom.titleArt.version, 'batch-enriched home payload receives the new logo version');
  await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
  await page.waitForSelector('[data-home-hero]');
  await page.evaluate(() => document.querySelector('[data-home-hero] button[aria-label="Pause"]')?.click());
  await wait(async () => (await visibleTitle())?.logo, 'home hero logo');
  await page.screenshot({ path: `${OUT}/home-desktop.png`, fullPage: false });
  console.log('PASS real upload preserves transparency/caption and updates both series and batch-enriched home heroes');

  await page.setViewport({ width: 390, height: 844 });
  await page.goto(`${BASE}/series/?id=${encodeURIComponent(id)}`, { waitUntil: 'networkidle2' });
  await wait(async () => (await visibleTitle())?.logo, 'phone hero logo');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'phone has no sideways overflow');
  await page.screenshot({ path: `${OUT}/series-phone.png`, fullPage: false });
  await page.setCacheEnabled(false);
  await page.setRequestInterception(true);
  const rejectLogo = (request) => request.url().includes(`/img/series/${encodeURIComponent(id)}/logo`) ? request.abort('failed') : request.continue();
  page.on('request', rejectLogo);
  await page.reload({ waitUntil: 'networkidle2' });
  await wait(async () => (await visibleTitle())?.fallback, 'failed image restores fallback');
  assert.equal((await visibleTitle()).logo, false);
  page.off('request', rejectLogo);
  await page.setRequestInterception(false);
  console.log('PASS phone logo fits and a failed image keeps the readable title');

  await page.reload({ waitUntil: 'networkidle2' });
  await openEditor();
  assert.equal(await page.$eval('[data-art-find-logo]', (e) => e.disabled), true, 'a custom choice blocks automatic replacement');
  await click('[data-art-logo-text]');
  await wait(async () => (await detail()).titleArt?.mode === 'text', 'explicit styled title');
  await page.select('[data-title-art-style]', 'fantasy');
  await wait(async () => (await detail()).titleArt?.style === 'fantasy', 'chosen text style');
  await closeEditor();
  await wait(async () => (await visibleTitle())?.fallback && (await visibleTitle()).style === 'fantasy', 'fantasy text displayed');
  await page.screenshot({ path: `${OUT}/styled-phone.png`, fullPage: false });
  await openEditor();
  await click('[data-art-logo-reset]');
  await wait(async () => { const a = (await detail()).titleArt; return a?.mode === 'automatic' && a.style === 'auto'; }, 'reset mode/style');
  await closeEditor();
  const after = await detail();
  assert.equal(after.booksCount, before.booksCount);
  assert.deepEqual(after.metadata, before.metadata, 'title art does not rewrite series metadata');
  console.log('PASS custom choices, explicit text style and reset preserve manga metadata and chapter count');
  assert.deepEqual(errors, [], 'no browser runtime exceptions');
} finally { await browser.close(); }
