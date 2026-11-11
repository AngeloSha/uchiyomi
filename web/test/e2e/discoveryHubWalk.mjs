// Real Discover acceptance against a disposable local app, PostgreSQL and fake sources/AniList.
// APIs are never intercepted. Seeds represent cached public catalog metadata, not mocked HTTP responses.
// KEEP=1 E2E_NET=uchiyomi-private-app-discover-20261110 E2E_PORT=18410 E2E_ANILIST=1 E2E_NO_WALK=1 ...
// cd web && BASE=http://127.0.0.1:18410 E2E_NET=uchiyomi-private-app-discover-20261110 node test/e2e/discoveryHubWalk.mjs
import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { fixtureLogin, waitForLoginCooldown } from './loginCooldown.mjs';

const base = process.env.BASE || 'http://127.0.0.1:18410';
const target = new URL(base);
assert.ok(target.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(target.hostname), 'disposable loopback preview required');
const net = process.env.E2E_NET || 'uchiyomi-private-app-discover-20261110';
assert.ok(/^[a-z0-9][a-z0-9_-]*$/i.test(net) && net !== 'yomi' && net !== 'uchiyomi', 'use an explicitly named disposable stack');
const anilist = process.env.ANILIST || `http://127.0.0.1:${28000 + Number(target.port) % 1000}`;
const out = process.env.OUT || '/tmp/uchiyomi-discovery-hub-walk';
mkdirSync(out, { recursive: true });
const nonce = randomUUID().replaceAll('-', ''), password = `Discover-${randomBytes(24).toString('base64url')}-A9`;
const checks = [], failures = [], consoleErrors = [], serverErrors = [], apiRequests = [], expectedNetwork = [];
const accounts = []; let browser, page, otherPage, adminToken, ownerToken, otherToken, oldAdult, oldTrending, shotNumber = 0, loginAttempt = -1;
const sql = (text) => execFileSync('docker', ['exec', `${net}-db`, 'psql', '-U', 'postgres', '-d', 'yomi', '-tAqc', text], { encoding: 'utf8' }).trim();
const lit = (s) => `'${String(s).replaceAll("'", "''")}'`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (name, pass, detail = '') => { checks.push({ name, pass: !!pass, ...(!pass ? { detail } : {}) }); console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${!pass ? ` ${detail}` : ''}`); if (!pass) failures.push(name); };
const shot = (name, p = page) => p.screenshot({ path: `${out}/${String(++shotNumber).padStart(2, '0')}-${name}.png`, fullPage: true, waitForFonts: false });
const heroFirst = () => page.evaluate(() => {
  const hero = document.querySelector('[data-discover-hero]'), controls = document.querySelector('[data-discovery-controls]');
  return !!hero && !!controls && document.querySelectorAll('[data-discovery-controls]').length === 1
    && !!(hero.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING)
    && hero.getBoundingClientRect().bottom <= controls.getBoundingClientRect().top + 1;
});
const sourcePath = (path) => /^\/api\/sources\/(latest|popular|search-all|find)(?:$|\/)/.test(path);
async function api(path, { token = adminToken, method = 'GET', body } = {}) {
  const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const raw = await response.text(); let data; try { data = JSON.parse(raw); } catch { data = raw; }
  return { status: response.status, data, headers: Object.fromEntries(response.headers) };
}
async function clickText(text, scope = 'button', p = page) {
  await p.waitForFunction((text, scope) => [...document.querySelectorAll(scope)].some((el) => el.getClientRects().length && !el.disabled && el.textContent?.trim() === text), { timeout: 30000 }, text, scope);
  for (const el of await p.$$(scope)) if (await el.isVisible() && await el.evaluate((node, text) => node.textContent?.trim() === text, text)) {
    await el.evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'center' })); await el.asLocator().click(); return;
  }
  throw new Error(`Missing visible action: ${text}`);
}
async function openTitle(title, p = page) {
  const scope = '[data-discovery-collection] button, [data-discovery-saved] button';
  await p.waitForFunction((title, scope) => [...document.querySelectorAll(scope)].some((el) => el.querySelector('p')?.textContent?.trim() === title), {}, title, scope);
  for (const el of await p.$$(scope)) if (await el.evaluate((node, title) => node.querySelector('p')?.textContent?.trim() === title, title)) {
    await el.evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'center' })); await el.asLocator().click(); break;
  }
  await p.waitForFunction((title) => document.querySelector('[role=dialog]')?.getAttribute('aria-label') === title, {}, title);
}
async function closePreview(p = page) {
  await p.keyboard.press('Escape'); await p.waitForSelector('[data-discovery-preview]', { hidden: true });
}
async function tab(name, p = page) {
  await p.locator(`#discover-tab-${name}`).click();
  await p.waitForFunction((name) => document.querySelector(`#discover-tab-${name}`)?.getAttribute('aria-selected') === 'true', {}, name);
  await p.waitForSelector(`#discover-panel-${name}`, { visible: true });
}
async function mutateClick(text, field, value) {
  const pending = page.waitForResponse((r) => new URL(r.url()).pathname.startsWith('/api/discover/items/') && r.request().method() === 'PUT'
    && JSON.parse(r.request().postData() || '{}')[field] === value);
  await clickText(text, '[data-discovery-preview] button');
  const response = await pending; assert.equal(response.status(), 200, `real ${field} action`); return response.json();
}
async function login(p, account) {
  await p.goto(base, { waitUntil: 'networkidle2' }); await p.waitForSelector('form input[type=password]', { visible: true });
  let token;
  for (let attempt = 0; attempt < 2; attempt++) {
    loginAttempt = attempt;
    await p.locator('form input[type=text]').fill(account.username); await p.locator('form input[type=password]').fill(password);
    const pending = p.waitForResponse((r) => new URL(r.url()).pathname === '/auth/login' && r.request().method() === 'POST');
    await p.locator('form button[type=submit]').click(); const response = await pending;
    if (response.status() === 429 && attempt === 0) { await waitForLoginCooldown(response.headers()['retry-after']); continue; }
    assert.equal(response.status(), 200); const body = await response.json(); assert.equal(body.user.id, account.id); token = body.accessToken; break;
  }
  loginAttempt = -1; await p.waitForSelector('[data-topbar]'); await p.waitForSelector('form input[type=password]', { hidden: true }); return token;
}
function watch(p) {
  p.on('pageerror', (error) => consoleErrors.push(error.message));
  p.on('console', (message) => {
    if (message.type() !== 'error') return;
    const url = message.location()?.url || '', text = message.text(), path = (() => { try { return new URL(url).pathname; } catch { return ''; } })();
    if (/401/.test(text) && ['/auth/me', '/auth/refresh'].includes(path)) { expectedNetwork.push(`anonymous ${path} refusal`); return; }
    if (/429/.test(text) && path === '/auth/login' && loginAttempt === 0) { expectedNetwork.push('advertised fixture login cooldown'); return; }
    consoleErrors.push(`${text} ${url}`);
  });
  p.on('response', (response) => { if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`); });
  p.on('request', (request) => { const u = new URL(request.url()); if (u.origin === new URL(base).origin && u.pathname.startsWith('/api/')) apiRequests.push({ path: u.pathname, method: request.method(), page: p === page ? 'owner' : 'other' }); });
}
const art = (genre) => new URL(`/art/bg/${genre}.webp`, base).href;
const title = (kind) => `Discover Walk ${kind} ${nonce.slice(0, 6)}`;
const make = (id, kind, country, genre, status = 'RELEASING', cover = art(genre.toLowerCase())) => ({ id, title: title(kind), cover, coverXL: cover, banner: cover,
  description: `The ${kind} story has a verified catalog synopsis.`, genres: [genre], score: 83, chapters: status === 'FINISHED' ? 24 : null, status, country });
const groups = {
  KR: [make(987101, 'Fantasy', 'KR', 'Fantasy', 'FINISHED'), make(987102, 'Action', 'KR', 'Action'), make(987103, 'Comedy', 'KR', 'Comedy', 'FINISHED')],
  JP: [make(987104, 'Mystery', 'JP', 'Mystery', 'FINISHED'), make(987105, 'Romance', 'JP', 'Romance'), make(987106, 'No Art', 'JP', 'Sports', 'RELEASING', null)],
  CN: [make(987107, 'Adventure', 'CN', 'Fantasy'), make(987108, 'Suspense', 'CN', 'Mystery'), make(987109, 'Restricted', 'CN', 'WalkRestricted', 'RELEASING', art('mystery'))],
};
const fantasy = groups.KR[0], mystery = groups.JP[0], rejected = groups.KR[1], restricted = groups.CN[2];
try {
  // All mutations are gated to the explicitly selected disposable stack and never to the user's live app.
  assert.equal(execFileSync('docker', ['inspect', '--format', '{{.Name}}', net], { encoding: 'utf8' }).trim(), `/${net}`);
  adminToken = (await (await fixtureLogin(base, { username: process.env.E2E_USER || 'e2e', password: process.env.E2E_PASS || 'e2e-passw0rd-123' })).json()).accessToken;
  oldTrending = JSON.parse(sql("SELECT coalesce(json_agg(row_to_json(c)), '[]'::json) FROM anilist_trending c"));
  oldAdult = (await api('/api/admin/settings')).data;
  assert.equal((await api('/api/admin/settings', { method: 'PATCH', body: { adultGenres: ['WalkRestricted'], adultHiding: true } })).status, 200);
  assert.equal((await fetch(anilist + '/__trending', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(groups) })).status, 200);
  for (const [country, items] of Object.entries(groups)) sql(`INSERT INTO anilist_trending(country,items,fetched_at) VALUES(${lit(country)},${lit(JSON.stringify(items))}::jsonb,now()) ON CONFLICT(country) DO UPDATE SET items=EXCLUDED.items,fetched_at=EXCLUDED.fetched_at`);
  for (const who of ['owner', 'other']) {
    const response = await api('/api/admin/users', { method: 'POST', body: { username: `discover_${who}_${nonce}`, password, role: 'user', perms: { canDownload: true } } });
    assert.equal(response.status, 200); accounts.push(response.data);
  }
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  page = await browser.newPage(); watch(page); await page.setViewport({ width: 1440, height: 1000 });
  ownerToken = await login(page, accounts[0]);
  const beforeBrowse = apiRequests.length;
  await page.goto(base + '/discover/', { waitUntil: 'networkidle2' }); await page.waitForSelector('[data-discovery-hub]');
  await page.waitForFunction(() => document.querySelectorAll('[data-discovery-collection=trending] button').length >= 8, { timeout: 45000 });
  check('fresh accounts open For you by default', await page.$eval('#discover-tab-for-you', (el) => el.getAttribute('aria-selected')) === 'true');
  check('personal browsing never starts source listing, search or find requests', !apiRequests.slice(beforeBrowse).some((r) => sourcePath(r.path)));
  const catalog = await api('/api/discover/trending?country=CN', { token: ownerToken });
  check('unrevealed catalog and hero exclude configured adult genres', !catalog.data.content.some((it) => it.id === restricted.id) && !await page.evaluate((title) => document.querySelector('[data-discovery-hub]')?.textContent.includes(title), restricted.title));
  const countries = await page.$$eval('[data-discover-hero] [data-hero-slides] button', (buttons) => buttons.map((b) => b.getAttribute('aria-label')));
  check('hero includes manga, manhwa and manhua titles', [fantasy.title, mystery.title, groups.CN[0].title].every((t) => countries.includes(t)));
  check('For you opens with the hero before one shared controls panel in DOM and layout', await heroFirst());
  check('desktop Search stays beside its field without an empty stretch of controls', await page.evaluate(() => {
    const form = document.querySelector('[data-discovery-controls] form'), field = form?.querySelector('input')?.closest('.field'), search = form?.querySelector('button.btn-accent');
    if (!form || !field || !search) return false;
    const a = field.getBoundingClientRect(), b = search.getBoundingClientRect();
    const gap = getComputedStyle(form).direction === 'rtl' ? a.left - b.right : b.left - a.right;
    return gap >= 0 && gap <= 16 && Math.abs(a.top - b.top) <= 1;
  }));
  await shot('desktop-personal-hub');
  await openTitle(fantasy.title);
  check('rich preview shows trusted synopsis and completion metadata', (await page.$eval('[data-discovery-preview]', (el) => el.innerText)).includes(fantasy.description) && (await page.$eval('[data-discovery-preview]', (el) => el.innerText)).includes('Completed'));
  const countBeforeSave = Number(sql('SELECT count(*) FROM lib_series'));
  const saved = await mutateClick('Save for later', 'saved', true);
  check('Save for later writes the real canonical catalog identity', saved.key === `al:${fantasy.id}`);
  check('saving does not create a library series or download chapters', Number(sql('SELECT count(*) FROM lib_series')) === countBeforeSave);
  await closePreview(); await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction((title) => document.querySelector('[data-discovery-saved]')?.textContent.includes(title), {}, fantasy.title);
  check('saved title persists across a cold page reload', (await api('/api/discover/state', { token: ownerToken })).data.saved.some((it) => it.id === fantasy.id));
  await openTitle(rejected.title); await mutateClick('Not interested', 'hidden', true);
  await page.waitForSelector('[data-discovery-preview]', { hidden: true });
  await page.waitForFunction((title) => !document.querySelector('[data-discovery-hub]')?.textContent.includes(title), {}, rejected.title);
  check('Not interested removes the title from hero and collections', (await api('/api/discover/state', { token: ownerToken })).data.hidden.includes(`al:${rejected.id}`));
  const restored = page.waitForResponse((r) => new URL(r.url()).pathname.startsWith('/api/discover/items/') && r.request().method() === 'PUT' && JSON.parse(r.request().postData() || '{}').hidden === false);
  await clickText('Undo'); assert.equal((await restored).status(), 200);
  await page.waitForFunction((title) => document.querySelector('[data-discovery-hub]')?.textContent.includes(title), {}, rejected.title);
  check('Undo restores the same title without losing saves', (await api('/api/discover/state', { token: ownerToken })).data.saved.some((it) => it.id === fantasy.id));
  await openTitle(rejected.title); await mutateClick('Not interested', 'hidden', true); await page.waitForSelector('[data-discovery-preview]', { hidden: true });
  const reset = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/discover/hidden' && r.request().method() === 'DELETE');
  await clickText('Reset hidden picks'); assert.equal((await reset).status(), 200);
  const afterReset = (await api('/api/discover/state', { token: ownerToken })).data;
  check('Reset hidden picks preserves saved titles', afterReset.hidden.length === 0 && afterReset.saved.some((it) => it.id === fantasy.id));

  await clickText('Manga', '[aria-label="Series type"] button'); await clickText('Mystery', '[aria-label=Genre] button');
  await page.locator('[data-discovery-hub] input[type=checkbox]').click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get('completed') === '1');
  const filterUrl = page.url();
  check('interest choices are represented in the URL', new URL(filterUrl).searchParams.get('country') === 'JP' && new URL(filterUrl).searchParams.get('genre') === 'Mystery');
  const filteredTitles = await page.$$eval('[data-discovery-collection=trending] button p', (els) => els.map((el) => el.textContent.trim()));
  check('combined metadata filters show only matching completed manga', filteredTitles.length === 1 && filteredTitles[0] === mystery.title);
  await page.reload({ waitUntil: 'networkidle2' }); await page.waitForSelector('[data-discovery-collection=trending] button');
  check('filter choices restore after reload', await page.$eval('[data-discovery-hub] input[type=checkbox]', (el) => el.checked) && (await page.$$eval('[data-discovery-collection=trending] button p', (els) => els.map((el) => el.textContent.trim()))).every((t) => t === mystery.title));
  await clickText('Surprise me'); await page.waitForSelector('[data-discovery-preview]');
  check('Surprise me respects the current filtered permitted pool', await page.$eval('[role=dialog]', (el) => el.getAttribute('aria-label')) === mystery.title); await closePreview();
  await page.goto(base + '/discover/?tab=for-you', { waitUntil: 'networkidle2' }); await page.waitForSelector('[data-discovery-collection=trending] button');

  const savedTab = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/discover/state' && r.request().method() === 'PATCH' && JSON.parse(r.request().postData() || '{}').tab === 'sources');
  await page.focus('#discover-tab-for-you'); await page.keyboard.press('ArrowRight');
  await page.waitForSelector('#discover-panel-sources', { visible: true }); assert.equal((await savedTab).status(), 200);
  check('keyboard tab selection retains focus on the selected Sources control', await page.evaluate(() => document.activeElement?.id === 'discover-tab-sources' && document.activeElement.getAttribute('aria-selected') === 'true'));
  await page.waitForFunction(() => document.querySelector('[data-wall-part]')?.textContent.includes('Walk'), { timeout: 30000 });
  check('source listing requests begin only after Sources is chosen', apiRequests.some((r) => r.page === 'owner' && r.path === '/api/sources/latest'));
  check('Sources keeps its shared controls above results without a hero placeholder', await page.evaluate(() => {
    const controls = document.querySelector('[data-discovery-controls]'), panel = document.querySelector('#discover-panel-sources');
    return !!controls && !!panel && document.querySelectorAll('[data-discovery-controls]').length === 1
      && !document.querySelector('[data-discovery-hero-slot]') && controls.getBoundingClientRect().bottom <= panel.getBoundingClientRect().top + 1;
  }));
  const catalogBeforeRemember = apiRequests.length;
  await page.goto(base + '/discover/', { waitUntil: 'networkidle2' }); await page.waitForSelector('#discover-panel-sources');
  check('remembered Sources opens without rendering the personal hub', await page.$('[data-discovery-hub]') === null && await page.$eval('#discover-tab-sources', (el) => el.getAttribute('aria-selected')) === 'true');
  check('remembered Sources does not launch catalog requests', apiRequests.slice(catalogBeforeRemember).filter((r) => r.page === 'owner' && ['/api/discover/trending', '/api/discover/because', '/api/discover/recommendations'].includes(r.path)).length === 0);
  const searchBefore = apiRequests.length;
  await page.goto(base + '/discover/?q=Walk%20Tale', { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.querySelector('input[aria-label="Search all sources…"]')?.value === 'Walk Tale');
  check('direct search URL opens Sources with its submitted title', await page.$eval('#discover-tab-sources', (el) => el.getAttribute('aria-selected')) === 'true' && apiRequests.slice(searchBefore).some((r) => r.path === '/api/sources/search-all'));
  await shot('desktop-sources-search');

  const context = await browser.createBrowserContext(); otherPage = await context.newPage(); watch(otherPage); await otherPage.setViewport({ width: 1280, height: 900 });
  otherToken = await login(otherPage, accounts[1]); await otherPage.goto(base + '/discover/', { waitUntil: 'networkidle2' }); await otherPage.waitForSelector('[data-discovery-hub]');
  const otherState = (await api('/api/discover/state', { token: otherToken })).data;
  check('another account has independent saved/hidden/tab state', otherState.saved.length === 0 && otherState.hidden.length === 0 && otherState.tab === 'for-you');
  check('another account cannot see the owner saved title', !(await otherPage.$eval('[data-discovery-saved]', (el) => el.innerText)).includes(fantasy.title));
  await context.close(); otherPage = null;

  await page.setViewport({ width: 360, height: 780, isMobile: true, hasTouch: true });
  await page.goto(base + '/discover/?tab=for-you', { waitUntil: 'networkidle2' }); await page.waitForSelector('[data-discovery-collection=trending] button');
  check('personal hub fits a 360px phone without document overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  check('the phone keeps the full controls panel below the hero', await heroFirst());
  await openTitle(mystery.title);
  check('rich preview remains readable on a small phone', await page.$eval('[role=dialog]', (el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().width <= innerWidth));
  await shot('phone-rich-preview'); await closePreview(); await shot('phone-personal-hub');
  assert.equal((await api('/api/settings', { token: ownerToken, method: 'PUT', body: { lang: 'ar' } })).status, 200);
  await page.reload({ waitUntil: 'networkidle2' }); await page.waitForFunction(() => document.documentElement.lang === 'ar' && document.documentElement.dir === 'rtl');
  await page.waitForSelector('[data-discovery-hub]');
  check('Arabic renders translated interests in RTL without horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && /[\u0600-\u06ff]/.test(document.querySelector('[data-discovery-hub]')?.textContent || '')));
  await shot('phone-arabic-hub');
  assert.equal((await api('/api/settings', { token: ownerToken, method: 'PUT', body: { lang: 'en' } })).status, 200);
  await page.reload({ waitUntil: 'networkidle2' }); await page.waitForFunction(() => document.documentElement.lang === 'en');
  await page.setViewport({ width: 1440, height: 1000 });
  await page.setCookie({ name: 'yomi_adult', value: '1', url: base });
  await page.goto(base + '/discover/?tab=for-you', { waitUntil: 'networkidle2' });
  await page.waitForFunction((title) => document.querySelector('[data-discovery-hub]')?.textContent.includes(title), {}, restricted.title);
  await openTitle(restricted.title); await page.waitForSelector('[data-discovery-preview]');
  // The real reveal chip/banner closes the permission-dependent preview before the narrowed response lands.
  // Another browser tab may change this session preference while a modal is open. Focus must retire its old details immediately.
  await page.deleteCookie({ name: 'yomi_adult', url: base });
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); });
  await page.waitForSelector('[data-discovery-preview]', { hidden: true });
  await page.waitForFunction((title) => !document.querySelector('[data-discovery-hub]')?.textContent.includes(title), {}, restricted.title);
  check('turning the 18+ reveal off removes restricted titles from every hub surface', await page.$('[data-discovery-preview]') === null && !(await api('/api/discover/state', { token: ownerToken })).data.saved.some((it) => it.id === restricted.id));
  check('personal state is private and cannot enter the Cache API', /no-store/.test((await api('/api/discover/state', { token: ownerToken })).headers['cache-control']) && (await api('/api/discover/state', { token: ownerToken })).headers.vary === '*');
} catch (error) { failures.push(error.stack || error.message); console.error(error.stack || error.message); }
finally {
  if (page && !page.isClosed()) { try { await shot('final-state'); } catch {} }
  if (browser) await browser.close();
  for (const account of accounts) try { assert.equal((await api(`/api/admin/users/${account.id}`, { method: 'DELETE' })).status, 200); } catch (error) { failures.push(`fixture account cleanup: ${error.message}`); }
  if (oldAdult) try { assert.equal((await api('/api/admin/settings', { method: 'PATCH', body: { adultGenres: oldAdult.adult_genres || [], adultHiding: oldAdult.adult_hiding !== false } })).status, 200); } catch (error) { failures.push(`adult settings cleanup: ${error.message}`); }
  if (oldTrending) try { sql('DELETE FROM anilist_trending'); for (const row of oldTrending) sql(`INSERT INTO anilist_trending(country,items,fetched_at) VALUES(${lit(row.country)},${lit(JSON.stringify(row.items))}::jsonb,${lit(row.fetched_at)}::timestamptz)`); } catch (error) { failures.push(`catalog fixture cleanup: ${error.message}`); }
  const result = { base, image: process.env.E2E_IMAGE || null, checks, failures, consoleErrors, serverErrors, expectedNetwork, apiRequests,
    fixtureAccountsRemoved: accounts.length, networkInterception: false };
  writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ checks: checks.length, passed: checks.filter((c) => c.pass).length, failures, consoleErrors, serverErrors }));
  process.exitCode = failures.length || consoleErrors.length || serverErrors.length ? 1 : 0;
}
