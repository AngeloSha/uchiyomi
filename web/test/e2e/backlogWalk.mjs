// Run after up.sh against its disposable instance. Search responses are scripted to exercise slow sources,
// long result lists and pagination without depending on third-party sites. Never run against a live library.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer';

const BASE = process.env.BASE || 'http://127.0.0.1:18140';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(BASE).hostname), 'use a disposable local test instance');
const OUT = process.env.OUT || 'test/e2e/shots-backlog';
mkdirSync(OUT, { recursive: true });
const response = await fetch(`${BASE}/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: process.env.E2E_USER || 'e2e', password: process.env.E2E_PASS || 'e2e-passw0rd-123' }),
});
assert.equal(response.status, 200, 'fixture sign-in');
const { accessToken } = await response.json();
const api = async (path, body) => {
  const r = await fetch(BASE + path, {
    headers: { authorization: `Bearer ${accessToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
  });
  assert.ok(r.ok, `${path}: ${r.status}`);
  return r.json();
};
const { content } = await api('/api/series/search?size=100', {});
const series = content.find((s) => /Mixed Formats/.test(s.name));
assert.ok(series, 'seeded Mixed Formats series');
const batch = await api('/api/admin/import/batches', { titles: ['Backlog Preview Fixture With No Match'] });
let candidateId;
for (let n = 0; n < 120; n++) {
  const b = await api(`/api/admin/import/batches/${batch.batchId}`);
  if (b.batch.state === 'review') { candidateId = b.items[0].id; break; }
  assert.ok(n < 119, 'import fixture reached review');
  await new Promise((r) => setTimeout(r, 500));
}
const picked = await fetch(`${BASE}/api/admin/import/candidates/${candidateId}`, {
  method: 'PATCH', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ decision: 'manual', source: 'fake-0', sourceId: 'current', title: 'The current matched work with a long comparison title' }),
});
assert.ok(picked.ok, 'the import fixture has a current pick to compare');

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
try {
  const context = browser.defaultBrowserContext();
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    await context.setCookie({ name: pair.slice(0, i), value: pair.slice(i + 1), url: BASE });
  }
  const page = await browser.newPage();
  // This walk scripts API responses; the offline service-worker behavior is covered by run.mjs.
  await page.setBypassServiceWorker(true);
  page.on('pageerror', (e) => errors.push(e.stack || e.message));
  await page.setViewport({ width: 1440, height: 1000 });
  const clickText = async (text) => {
    await page.waitForFunction((t) => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === t && b.getBoundingClientRect().height), { timeout: 15000 }, text);
    for (const button of await page.$$('button')) {
      if (await button.evaluate((b, t) => b.textContent.trim() === t && b.getBoundingClientRect().height > 0, text)) {
        await button.click(); return;
      }
    }
    throw new Error(`Missing button: ${text}`);
  };
  await page.goto(`${BASE}/series/?id=${series.id}`, { waitUntil: 'networkidle2' });
  await clickText('Select');
  await page.click('[data-select-all-chapters]');
  await page.waitForFunction(() => document.querySelector('[data-select-all-chapters]')?.textContent === 'Clear selection');
  assert.match(await page.$eval('[data-select-all-chapters]', (b) => b.parentElement.textContent), /\d+ selected/);
  await page.click('[data-select-all-chapters]');
  await page.waitForFunction(() => document.querySelector('[data-select-all-chapters]')?.textContent === 'Select all');
  console.log('PASS Select all and Clear selection through the real series UI');
  await clickText('Done');

  let polls = 0;
  let laterPages = 0;
  const creatorQueries = [];
  const creatorPages = [];
  const sources = Array.from({ length: 6 }, (_, i) => ({ id: `fake-${i}`, name: `Fixture source ${i}`, lang: 'en', searchPages: true, creatorSearch: i === 0 }));
  const groups = sources.map((s) => ({ source: s.id, name: s.name, lang: 'en', results: Array.from({ length: 18 }, (_, i) => ({
    source: s.id, sourceId: `${s.id}-${i}`, title: `Candidate ${i + 1}`, coverUrl: `${BASE}/img/fixture`,
  })) }));
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const u = new URL(request.url());
    const json = (body) => request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (u.pathname === '/api/sources') return void json({ content: sources });
    if (u.pathname === '/api/sources/search-all') {
      const creator = u.searchParams.get('creator');
      if (creator) {
        creatorQueries.push(creator);
        const provider = { source: 'fake-0', name: sources[0].name, sourceId: `creator-${creator}`, title: `Work by ${creator}`, coverUrl: `${BASE}/img/fixture` };
        return void json({ content: [{ ...provider, providers: [provider] }], pending: 0, asked: 1, sources: [{ id: 'fake-0', name: sources[0].name, state: 'ok' }] });
      }
      polls++;
      return void json({ content: polls % 2 === 1 ? groups.slice(0, 5) : groups, pending: polls % 2,
        asked: 6, sources: sources.map((s, i) => ({ ...s, state: polls % 2 && i === 5 ? 'pending' : 'ok' })) });
    }
    if (u.pathname === '/api/sources/search' && u.searchParams.get('creator')) {
      const creator = u.searchParams.get('creator');
      const page = Number(u.searchParams.get('page'));
      creatorPages.push({ creator, page, source: u.searchParams.get('source') });
      // Single-source responses omit `source`; Discover must bind the requested provider before rendering.
      return void json({ content: page === 2 ? [{ sourceId: `${creator}-page-two`, title: `Later work by ${creator}`, coverUrl: `${BASE}/img/fixture` }] : [] });
    }
    if (u.pathname === '/api/sources/search' && u.searchParams.get('page') === '2') {
      laterPages++;
      return void json({ content: [{ sourceId: 'page-two', title: 'Correct match on page two', coverUrl: `${BASE}/img/fixture` }] });
    }
    if (u.pathname === '/api/sources/detail') return void json({ title: 'Full preview title', coverUrl: null, count: 18,
      author: 'Fixture Author', status: 'COMPLETED', genres: ['Action', 'Drama'],
      summary: 'A detailed description that distinguishes two otherwise identical titles. '.repeat(12) });
    if (u.pathname.startsWith('/img/fixture') || u.pathname.startsWith('/img/sources/cover')) return void request.respond({
      status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="150"><rect width="100" height="150" fill="#64748b"/></svg>',
    });
    void request.continue();
  });

  await page.goto(`${BASE}/admin/import/?batch=${batch.batchId}`, { waitUntil: 'networkidle2' });
  await clickText('Change');
  await page.waitForSelector('[data-source-search-more="fake-5"]', { timeout: 15000 });
  assert.ok(polls >= 2, 'the pending sixth source is polled');
  await page.waitForSelector('img[alt="Candidate 18"]');
  await page.click('[data-source-search-more="fake-0"]');
  await page.waitForSelector('img[alt="Correct match on page two"]');
  assert.equal(laterPages, 1, 'More requests page two');
  await page.click('img[alt="Correct match on page two"]');
  await page.waitForFunction(() => document.body.textContent.includes('Fixture Author'));
  assert.ok((await page.$eval('body', (b) => b.textContent)).includes('Completed · Action · Drama'));
  console.log('PASS import preview, eighteenth result, slow sixth source and per-source page two');
  await page.setViewport({ width: 390, height: 844 });
  const resultsRoom = () => page.evaluate(() => {
    const comparison = document.querySelector('[data-match-comparison]')?.getBoundingClientRect();
    const search = document.querySelector('input[placeholder="Search sources…"]')?.getBoundingClientRect();
    return comparison && search ? comparison.top - search.bottom : 0;
  });
  assert.ok(await resultsRoom() >= 180, 'two previews still leave space for a complete result card on a phone');
  await page.screenshot({ path: `${OUT}/import-phone.png`, fullPage: true });
  const confirmVisible = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Use this pick');
    const r = b?.getBoundingClientRect();
    return !!r && r.top >= 0 && r.bottom <= innerHeight;
  });
  assert.ok(confirmVisible, 'comparison controls stay reachable on a phone');
  await page.click('[data-match-comparison] button');
  assert.ok(await resultsRoom() >= 180, 'expanding a description does not swallow the search results');

  // The second sheet uses the same paging control, independently of the import sheet's query/cache.
  polls = 0;
  await page.goto(`${BASE}/series/?id=${series.id}`, { waitUntil: 'networkidle2' });
  const supply = await page.$$('button[aria-haspopup="dialog"]');
  let opened = false;
  for (const b of supply) {
    if (await b.evaluate((el) => el.className.includes('whitespace-nowrap') && el.className.includes('text-fog-400') && el.getBoundingClientRect().height > 0)) {
      await b.click(); opened = true; break;
    }
  }
  assert.ok(opened, 'source supply line opens');
  await page.waitForSelector('[data-add-more-sources]');
  await page.click('[data-add-more-sources]');
  await page.waitForSelector('[data-source-search-more="fake-5"]', { timeout: 15000 });
  await page.click('[data-source-search-more="fake-0"]');
  await clickText('Correct match on page two');
  await page.waitForFunction(() => document.body.textContent.includes('Fixture Author'));
  await page.screenshot({ path: `${OUT}/sources-phone.png`, fullPage: true });
  console.log('PASS Add more sources preview and independent paging on a phone');
  await page.goto(`${BASE}/discover/?q=Fixture%20Creator&creator=author`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('img[alt="Work by author"]');
  await page.waitForSelector('img[alt="Later work by author"]');
  assert.equal(await page.$eval('select[aria-label="Search by"]', (el) => el.value), 'author');
  await page.select('select[aria-label="Search by"]', 'artist');
  await page.waitForSelector('img[alt="Work by artist"]');
  await page.waitForSelector('img[alt="Later work by artist"]');
  assert.ok(creatorQueries.includes('author') && creatorQueries.includes('artist'), 'both creator fields reach the API');
  assert.ok(['author', 'artist'].every((creator) => creatorPages.some((p) => p.creator === creator && p.page === 2 && p.source === 'fake-0')), 'each creator field pages on its supporting source');
  assert.equal(await page.$('img[alt="Later work by author"]'), null, 'changing the creator field discards the old later page');
  assert.equal(new URL(page.url()).searchParams.get('creator'), 'artist', 'reload retains the chosen field');
  await page.screenshot({ path: `${OUT}/creator-phone.png`, fullPage: true });
  console.log('PASS creator search field, result isolation and reload address on a phone');
  assert.deepEqual(errors, [], 'no browser runtime errors');
} catch (error) {
  if (errors.length) console.error('Browser runtime errors:', ...errors);
  const pages = await browser.pages();
  const page = pages.at(-1);
  await page?.screenshot({ path: `${OUT}/failure.png`, fullPage: true });
  console.log((await page?.$eval('body', (b) => b.innerText))?.slice(-3500));
  throw error;
} finally {
  await browser.close();
  await fetch(`${BASE}/api/admin/import/batches/${batch.batchId}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${accessToken}` },
  });
}
