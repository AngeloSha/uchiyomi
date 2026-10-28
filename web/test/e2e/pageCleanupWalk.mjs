// Real archive editing through the reader UI. Run only against up.sh's disposable localhost instance.
// BASE=http://127.0.0.1:18329 node test/e2e/pageCleanupWalk.mjs (from web/)
// Downloads one fake-source chapter, removes/restores a page, cancels irreversible deletion and a source-wide rule.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer';

const BASE = process.env.BASE || 'http://127.0.0.1:18140';
const target = new URL(BASE);
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname), 'page cleanup walk must use a disposable localhost instance');
assert.equal(target.protocol, 'http:', 'up.sh exposes its disposable instance over localhost HTTP');
const OUT = process.env.OUT || 'test/e2e/shots-page-cleanup';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (check, timeout = 120000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = await check().catch(() => null); if (value) return value; await sleep(300); }
  throw new Error('fixture did not become ready');
};
const login = await fetch(`${BASE}/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: process.env.E2E_USER || 'e2e', password: process.env.E2E_PASS || 'e2e-passw0rd-123' }),
});
assert.equal(login.status, 200, 'local fixture admin sign-in');
const { accessToken } = await login.json();
const api = async (path, { method, json } = {}) => {
  const response = await fetch(BASE + path, {
    method: method || (json === undefined ? 'GET' : 'POST'),
    headers: { authorization: `Bearer ${accessToken}`, ...(json === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  });
  assert.ok(response.ok, `${path}: HTTP ${response.status} ${await response.clone().text()}`);
  return response.json();
};
await api('/api/admin/sources/fake-a/enable', { method: 'POST' });
await api('/api/admin/sources/fake-a/unblock', { method: 'POST' });
const added = await api('/api/sources/add', { json: { source: 'fake-a', sourceId: 'walk-tale', chapterCount: 1, chapterFrom: 'latest', autoUpdate: false } });
const seriesId = added.seriesId || await waitFor(async () => (await api('/api/series/search?size=100', { json: {} })).content.find((s) => s.name === 'Walk Tale')?.id);
const book = await waitFor(async () => {
  const { content } = await api(`/api/series/${seriesId}/books?size=100`);
  const candidate = content.filter((b) => !b.pruned && b.sourceId === 'fake-a').sort((a, b) => b.number - a.number)[0];
  return candidate && (await api(`/api/books/${candidate.id}/pages`)).length >= 4 ? candidate : null;
});
const BOOK = encodeURIComponent(book.id);
const original = await api(`/api/admin/books/${BOOK}/page-cleanup`);
assert.ok(original.pages.length >= 4 && original.pages.every((p) => !p.removed), 'fresh writable complete CBZ fixture');
const chosenPage = original.pages[2].number;
await api(`/api/books/${BOOK}/progress`, { method: 'PUT', json: { page: 1, completed: false, seriesId, deviceId: 'page-cleanup-walk', at: Date.now() } });
await api(`/api/bookmarks/${BOOK}/${chosenPage}`, { method: 'PUT', json: { note: 'Page cleanup fixture bookmark' } });
const snapshot = async () => {
  const b = await api(`/api/books/${BOOK}`);
  const bookmarks = (await api(`/api/bookmarks?seriesId=${encodeURIComponent(seriesId)}`)).content
    .filter((m) => m.book_id === book.id).map((m) => ({ page: m.page, note: m.note })).sort((a, b) => a.page - b.page);
  return { numbers: (await api(`/api/books/${BOOK}/pages`)).map((p) => p.number), page: b.readProgress?.page, completed: b.readProgress?.completed, bookmarks };
};
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const context = browser.defaultBrowserContext();
  for (const cookie of login.headers.getSetCookie()) {
    const pair = cookie.split(';')[0], split = pair.indexOf('=');
    await context.setCookie({ name: pair.slice(0, split), value: pair.slice(split + 1), url: BASE });
  }
  const page = await browser.newPage();
  await page.setViewport({ width: Number(process.env.WIDTH || 390), height: 900 });
  await page.setBypassServiceWorker(true);
  const errors = [], pageMutations = [], ruleMutations = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/page-cleanup')) pageMutations.push(JSON.parse(r.postData()));
    if (r.method() === 'PUT' && r.url().includes('/page-rules')) ruleMutations.push(r.postData());
  });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('yomi_reader_prefs', JSON.stringify({ mode: 'vertical', autoMode: false, junkPages: 'show', gap: 0 }));
  });
  await page.goto(`${BASE}/reader/?book=${BOOK}&page=1`, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector('[data-reader-pages]', { timeout: 30000 });
  await sleep(900); // settle the reader's normal first-page progress ping before comparing values
  const before = await snapshot();
  assert.equal(before.page, 1);
  const click = async (selector) => {
    await page.waitForSelector(selector, { visible: true, timeout: 20000 });
    const element = await page.$(selector);
    await element.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await element.click();
  };
  const closeManager = async () => {
    await page.$eval('[data-page-cleanup]', (el) => el.closest('[role="dialog"]').querySelector('button').click());
    await page.waitForSelector('[data-manage-pages]');
  };
  // The chrome may have faded while images decoded; the Pages key is the real React action used by a tap.
  await page.$eval('[data-reader-pages]', (button) => button.click());
  await click('[data-manage-pages]');
  await page.waitForSelector(`[data-cleanup-page="${chosenPage}"]`);
  await click(`[data-cleanup-page="${chosenPage}"]`);
  await click('[data-cleanup-review]');
  assert.match(await page.$eval('[data-cleanup-confirm]', (el) => el.textContent), new RegExp(`\\b${chosenPage}\\b`), 'confirmation names the selected original page number');
  await click('[data-cleanup-confirm-yes]');
  const removed = await waitFor(async () => { const p = await api(`/api/admin/books/${BOOK}/page-cleanup`); return p.pages.find((p) => p.number === chosenPage)?.removed ? p : null; });
  assert.equal(removed.pages.find((p) => p.number === chosenPage).restorable, true);
  await page.waitForFunction(() => !document.querySelector('[data-cleanup-confirm]'));
  await closeManager();
  await page.waitForSelector(`[data-removed-page="${chosenPage}"] button`);
  assert.deepEqual(await snapshot(), before, 'removing a page preserves original numbers, progress and bookmarks');
  await page.screenshot({ path: `${OUT}/removed-page.png`, fullPage: true });
  console.log('PASS confirmed page removal keeps a removed grid slot with Restore and preserves progress/bookmarks');

  await click(`[data-removed-page="${chosenPage}"] button`);
  await page.waitForSelector(`[data-cleanup-page="${chosenPage}"]`);
  await click('[data-cleanup-mode="purge"]');
  await click(`[data-cleanup-page="${chosenPage}"]`);
  await click('[data-cleanup-review]');
  const irreversible = await page.$eval('[data-cleanup-confirm]', (el) => el.textContent);
  assert.match(irreversible, /cannot be restored|permanently|Permanently/, 'irreversible deletion is clearly identified');
  await click('[data-cleanup-cancel]');
  assert.equal(pageMutations.filter((r) => r.action === 'purge' || r.action === 'purge-unused').length, 0, 'cancel sends no irreversible mutation');
  const afterCancel = await api(`/api/admin/books/${BOOK}/page-cleanup`);
  assert.equal(afterCancel.revision, removed.revision);
  assert.equal(afterCancel.pages.find((p) => p.number === chosenPage).restorable, true);
  console.log('PASS permanent deletion cancellation leaves the original restorable');

  const rulesBefore = await api(`/api/admin/books/${BOOK}/page-rules`);
  assert.equal(rulesBefore.sourceId, 'fake-a', 'rules use the downloaded copy’s stable provenance');
  await page.select('[data-page-rule="source"]', rulesBefore.sourceRule === true ? 'false' : 'true');
  await page.waitForSelector('[data-rule-confirm]');
  assert.ok((await page.$eval('[data-rule-confirm]', (el) => el.textContent)).includes(String(rulesBefore.chapters)), 'confirmation previews the source scope count');
  await click('[data-rule-cancel]');
  assert.equal(ruleMutations.length, 0, 'cancel sends no source-wide rule change');
  assert.equal((await api(`/api/admin/books/${BOOK}/page-rules`)).sourceRule, rulesBefore.sourceRule);
  console.log('PASS GIF rule changes preview their source scope and can be cancelled');

  await click('[data-cleanup-mode="restore"]');
  await click(`[data-cleanup-page="${chosenPage}"]`);
  await click('[data-cleanup-review]');
  await click('[data-cleanup-confirm-yes]');
  await waitFor(async () => !(await api(`/api/admin/books/${BOOK}/page-cleanup`)).pages.find((p) => p.number === chosenPage)?.removed);
  await page.waitForFunction(() => !document.querySelector('[data-cleanup-confirm]'));
  await closeManager();
  assert.equal(await page.$(`[data-removed-page="${chosenPage}"]`), null, 'restored page is an ordinary grid tile again');
  assert.deepEqual(await snapshot(), before, 'restoring preserves original page numbers, progress and bookmark values');
  assert.deepEqual(pageMutations.map((p) => p.action), ['remove', 'restore']);
  assert.ok(pageMutations.every((p) => p.confirm === true && p.revision.length === 64));
  assert.deepEqual(errors, [], 'no browser exceptions');
  await page.screenshot({ path: `${OUT}/restored-page.png`, fullPage: true });
  console.log('PASS restore returns the page without moving reading history; no browser exceptions');
} finally {
  await browser.close();
}
