// Real browser/API/job/image checks against up.sh E2E_TITLE_EXTRACTION=1; never a production library.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer';
import { fixtureLogin } from './loginCooldown.mjs';
import { pressSeriesMoreItem } from './seriesMore.mjs';
const BASE = process.env.BASE || 'http://127.0.0.1:18140';
const origin = new URL(BASE);
assert.ok(origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname), 'a disposable loopback fixture is required');
const WORKER = process.env.E2E_TITLE_EXTRACT_URL || `http://127.0.0.1:${process.env.E2E_TITLE_EXTRACT_PORT || 29000 + Number(origin.port) % 1000}`;
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(WORKER).hostname));
const OUT = process.env.OUT || 'test/e2e/shots-title-extraction';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = async (fn, label) => {
  for (let i = 0; i < 150; i++) { const result = await fn(); if (result) return result; await sleep(150); }
  throw new Error(`Timed out: ${label}`);
};
const login = await fixtureLogin(BASE, { username: process.env.E2E_USER || 'e2e', password: process.env.E2E_PASS || 'e2e-passw0rd-123' });
assert.equal(login.status, 200);
const { accessToken } = await login.json();
const api = async (path, options = {}) => {
  const response = await fetch(BASE + path, { ...options, headers: { authorization: `Bearer ${accessToken}`,
    ...(options.body ? { 'content-type': 'application/json' } : {}) } });
  assert.ok(response.ok, `${path}: ${response.status}`);
  return response.json();
};
const mode = async (value) => { const r = await fetch(WORKER + '/__mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: value }) }); assert.equal(r.status, 200); };
const capabilities = await api('/api/admin/title-extraction/capabilities');
assert.equal(capabilities.available, true, 'run up.sh with E2E_TITLE_EXTRACTION=1');
assert.ok(Number.isFinite(capabilities.timeoutSeconds) && capabilities.timeoutSeconds > 0 && capabilities.timeoutSeconds <= 90, 'the extraction API exposes a finite bounded work budget');
assert.equal(capabilities.automaticApplyAvailable, false, 'a fixture without OCR cannot claim safe automatic Apply');
const settings = await api('/api/admin/settings');
assert.equal(settings.automatic_cover_titles, false, 'automatic extraction is opt-in');
assert.equal(settings.automatic_title_logos, false, 'the fixture must not make provider requests');
const selected = (await api('/api/featured')).content[0];
assert.ok(selected);
const id = selected.id, root = `/api/admin/series/${encodeURIComponent(id)}/title-extraction`;
const detail = () => api(`/api/series/${encodeURIComponent(id)}`);
const initial = await detail();
assert.equal(initial.titleArt.mode, 'automatic', 'titleArtWalk/reset or a fresh fixture should run first');
const setLogo = (body) => api(`/api/admin/series/${encodeURIComponent(id)}/art`, { method: 'PUT', body: JSON.stringify({ kind: 'logo', ...body }) });
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [], servedPreviews = new Set();
let page, expectedJobId;
try {
  await mode('ok');
  await setLogo({ mode: 'upload', dataUrl: 'data:image/png;base64,' + readFileSync(new URL('../fixtures/title-logo.png', import.meta.url)).toString('base64') });
  const original = (await detail()).titleArt;
  for (const cookie of login.headers.getSetCookie()) {
    const pair = cookie.split(';')[0], i = pair.indexOf('=');
    await browser.defaultBrowserContext().setCookie({ name: pair.slice(0, i), value: pair.slice(i + 1), url: BASE });
  }
  page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (response.status() >= 500) errors.push(`${response.status()} ${path}`);
    if (response.status() === 200 && path.startsWith(root + '/') && path.endsWith('/preview')) servedPreviews.add(path);
  });
  await page.setBypassServiceWorker(true);
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(BASE + '/series/?id=' + encodeURIComponent(id), { waitUntil: 'networkidle2' });
  assert.ok(await pressSeriesMoreItem(page, 'edit-details'));
  await page.waitForSelector('[data-title-art-editor]', { visible: true });
  const click = async (selector) => { await page.waitForSelector(selector, { visible: true }); await page.waitForFunction((value) => { const node = document.querySelector(value); return node && !node.disabled; }, {}, selector); await page.$eval(selector, (node) => node.scrollIntoView({ block: 'center' })); await page.click(selector); };
  const open = async () => {
    if (!(await page.$eval('[data-art-extract-cover]', (node) => node.getClientRects().length > 0))) await click('[data-edit-tab="art"]');
    await click('[data-art-extract-cover]');
    await page.waitForSelector('[data-title-extraction-dialog]', { visible: true });
    await page.waitForSelector('[data-extract-cover-surface] img', { visible: true });
    await page.waitForFunction(() => { const button = document.querySelector('[data-extract-create]'); return button && !button.disabled; });
  };
  const createPreview = async () => {
    const response = page.waitForResponse((r) => new URL(r.url()).pathname === root && r.request().method() === 'POST');
    await click('[data-extract-create]');
    const created = await response;
    assert.equal(created.status(), 202);
    const { job } = await created.json();
    assert.ok(job.id); expectedJobId = job.id;
    return { response: created, job };
  };
  const ready = async () => {
    // The API allows 90 seconds of work, plus a final status poll/image decode. A fixed 30-second
    // browser default can abandon a healthy running job; terminal failures should instead fail at once.
    const deadline = Date.now() + (capabilities.timeoutSeconds + 10) * 1000;
    assert.ok(expectedJobId, 'readiness belongs to the accepted preview request');
    // A retried preview can briefly still show the previous result during DELETE/POST/state adoption.
    // Require the accepted server job and its actual private preview response before checking decoded UI.
    for (;;) {
      const { job } = await api(`${root}/${encodeURIComponent(expectedJobId)}`, { signal: AbortSignal.timeout(5000) });
      assert.equal(job.id, expectedJobId);
      assert.ok(!['error', 'rejected', 'expired', 'applied'].includes(job.status), `preview ${job.id} failed: ${job.error || job.status}`);
      if (job.status === 'ready' && servedPreviews.has(`${root}/${encodeURIComponent(expectedJobId)}/preview`)) break;
      assert.ok(Date.now() < deadline, 'accepted extraction finishes within its advertised work budget');
      await sleep(500);
    }
    await page.waitForFunction(() => {
      const status = document.querySelector('[data-extract-result]')?.getAttribute('data-extract-result');
      const apply = document.querySelector('[data-extract-apply]');
      return status === 'ready' && apply && !apply.disabled;
    }, { timeout: Math.max(1, deadline - Date.now()) });
    const result = await page.$eval('[data-extract-result]', (node) => ({ status: node.getAttribute('data-extract-result'), error: node.querySelector('[data-extract-error]')?.textContent }));
    assert.equal(result.status, 'ready', `extraction must produce a ready preview: ${result.error || result.status}`);
    assert.equal(await page.$eval('[data-extract-apply]', (node) => node.disabled), false, 'the reviewed image is decoded and Apply exists and is enabled');
  };
  await open();
  assert.equal(await page.$eval('[data-extract-apply]', (node) => node.disabled), true);
  await click('[data-extract-region-draw]');
  const bounds = await (await page.$('[data-extract-cover-surface]')).boundingBox();
  await page.mouse.move(bounds.x + bounds.width * .15, bounds.y + bounds.height * .1);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * .85, bounds.y + bounds.height * .4, { steps: 8 });
  await page.mouse.up();
  await click('[data-extract-exclusion-add]');
  await click('[data-extract-exclusion-keyboard]');
  const leftField = '[data-extract-exclusion="0"] [data-extract-coordinate="left"]';
  await page.click(leftField);
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.type('65');
  const { response: createdResponse, job: firstJob } = await createPreview();
  const request = createdResponse.request();
  const selection = JSON.parse(request.postData());
  assert.equal(typeof selection.coverFingerprint, 'string');
  assert.ok(Math.abs(selection.region.left - .15) < .03 && Math.abs(selection.region.width - .7) < .03);
  assert.equal(selection.exclusions.length, 1);
  assert.equal(selection.exclusions[0].left, .65, 'keyboard percentage editing reaches the selected value');
  assert.ok(!('x' in selection.region), 'API coordinates use left/top consistently');
  assert.deepEqual(firstJob.region, selection.region, 'the saved job keeps exactly the requested title area');
  await ready();
  assert.equal((await detail()).titleArt.version, original.version, 'making and viewing a preview does not change current artwork');
  assert.equal(await page.$$eval('[data-extract-hero-preview] .hero-title-caption', (nodes) => nodes.length), 2, 'both backgrounds retain the readable name');
  await page.$eval('[data-extract-hero-preview]', (node) => node.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: `${OUT}/extract-desktop.png` });
  const titleLeft = '[data-cover-title-regions] > div:last-child > fieldset [data-extract-coordinate="left"]';
  await click(titleLeft);
  await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control');
  await page.keyboard.type('20');
  await page.waitForFunction(() => !document.querySelector('[data-extract-hero-preview]'));
  await page.waitForSelector('[data-extract-selection-changed]', { visible: true });
  assert.equal(await page.$eval('[data-extract-apply]', (node) => node.disabled), true);
  const { response: recomputedResponse, job: nextJob } = await createPreview();
  const updatedSelection = JSON.parse(recomputedResponse.request().postData());
  assert.equal(updatedSelection.region.left, .2);
  assert.equal(updatedSelection.exclusions[0].left, .65);
  assert.notEqual(nextJob.id, firstJob.id, 'changing the rectangle creates a fresh extraction');
  assert.deepEqual(nextJob.region, updatedSelection.region);
  await ready();
  const workerRequests = await (await fetch(WORKER + '/__log')).json();
  assert.deepEqual(workerRequests.at(-1).region, updatedSelection.region, 'the new title area reaches the extraction worker');
  assert.equal(await page.$$eval('[data-extract-selection-changed]', (nodes) => nodes.length), 0);
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Tab');
  assert.ok(await page.evaluate(() => document.querySelector('[data-title-extraction-dialog]')?.contains(document.activeElement)), 'Tab returns body focus to the active preview');
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-title-extraction-dialog]'));
  assert.ok(await page.$('[data-title-art-editor]'), 'Escape closes the preview, keeping Edit details open');
  assert.equal((await detail()).titleArt.version, original.version, 'Discard keeps existing artwork');
  console.log('PASS pointer and keyboard regions/exclusions use the displayed cover; previews and Discard preserve current artwork');

  await mode('unavailable');
  await open();
  await createPreview();
  await page.waitForFunction(() => document.querySelector('[data-extract-result]')?.getAttribute('data-extract-result') === 'error');
  assert.match(await page.$eval('[data-extract-error]', (node) => node.textContent), /not available/i);
  assert.equal((await detail()).titleArt.version, original.version);
  await mode('ok');
  await createPreview();
  await ready();
  console.log('PASS temporary worker failure has a readable error and can be retried without changing current artwork');
  await setLogo({ mode: 'style', style: 'noir' });
  const newer = (await detail()).titleArt;
  const stale = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/apply') && response.request().method() === 'POST');
  await click('[data-extract-apply]');
  assert.equal((await stale).status(), 409);
  await page.waitForSelector('[data-extract-error]');
  assert.match(await page.$eval('[data-extract-error]', (node) => node.textContent), /changed/i);
  assert.equal((await detail()).titleArt.version, newer.version, 'a stale Apply does not overwrite the newer edit');
  assert.equal(await page.$eval('[data-extract-apply]', (node) => node.disabled), true);
  console.log('PASS the real API rejects a stale preview and the editor requires a fresh one');

  await page.setViewport({ width: 390, height: 844 });
  await page.waitForFunction(() => { const button = document.querySelector('[data-extract-create]'); return button && !button.disabled; });
  await createPreview();
  await ready();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '390px editor has no sideways overflow');
  await page.$eval('[data-extract-hero-preview]', (node) => node.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: `${OUT}/extract-phone.png` });
  assert.ok(await page.$eval('[data-extract-apply]', (node) => {
    const box = node.getBoundingClientRect(), top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return !node.disabled && box.top >= 0 && box.bottom <= innerHeight && (node === top || node.contains(top));
  }), 'Apply is visible and uncovered on a phone');
  await click('[data-extract-apply]');
  await page.waitForFunction(() => !document.querySelector('[data-title-extraction-dialog]'));
  const applied = await wait(async () => { const art = (await detail()).titleArt; return art.attribution?.source === 'Cover lettering' ? art : null; }, 'applied cover-derived title art');
  assert.equal(applied.mode, 'custom');
  assert.equal(applied.attribution.sourceUrl, null);
  assert.equal(applied.showReadableTitle, true);
  console.log('PASS dark/light previews and explicit mobile Apply publish the reviewed cutout with a readable title');

  await mode('slow');
  await open();
  await createPreview();
  await page.waitForSelector('[data-extract-cancel]', { visible: true });
  await wait(async () => (await (await fetch(WORKER + '/__log')).json()).at(-1)?.mode === 'slow', 'worker started cancellable request');
  await click('[data-extract-cancel]');
  await page.waitForFunction(() => document.querySelector('[data-extract-result]')?.getAttribute('data-extract-result') === 'idle');
  assert.equal((await detail()).titleArt.version, applied.version, 'cancelled work cannot replace artwork');
  await click('[data-extract-discard]');
  const after = await detail();
  assert.deepEqual(after.metadata, initial.metadata);
  assert.equal(after.booksCount, initial.booksCount);
  assert.deepEqual(errors, [], 'no browser runtime errors or API 5xx responses');
  console.log('PASS cancelling active work preserves applied artwork; series metadata and chapter count stay unchanged');
} catch (error) {
  // Preserve evidence before cleanup changes the title version or closes the dialog. Never log cookies,
  // access tokens, request headers, source image bytes or the worker's imageBase64 input.
  const diagnostic = { failure: error.message, timeoutSeconds: capabilities.timeoutSeconds, seriesId: id, pageErrors: errors, expectedJobId, previewServed: !!expectedJobId && servedPreviews.has(`${root}/${encodeURIComponent(expectedJobId)}/preview`) };
  try {
    const { job } = await api(expectedJobId ? `${root}/${encodeURIComponent(expectedJobId)}` : root, { signal: AbortSignal.timeout(5000) });
    diagnostic.job = job ? { id: job.id, status: job.status, error: job.error, reasons: job.reasons, selectionMode: job.selectionMode, region: job.region, exclusions: job.exclusions } : null;
  } catch { diagnostic.jobReadFailed = true; }
  try { diagnostic.workerRequests = (await (await fetch(WORKER + '/__log', { signal: AbortSignal.timeout(5000) })).json()).slice(-3).map(({ mode, region, exclusions, expectedTitles, sourceWidth, sourceHeight, candidateWidth, candidateHeight, candidateRegion, responseStatus }) => ({ mode, region, exclusions, expectedTitles, sourceWidth, sourceHeight, candidateWidth, candidateHeight, candidateRegion, responseStatus })); }
  catch { diagnostic.workerReadFailed = true; }
  if (page) {
    try {
      diagnostic.ui = await page.evaluate(() => ({ status: document.querySelector('[data-extract-result]')?.getAttribute('data-extract-result'),
        error: document.querySelector('[data-extract-error]')?.textContent, selectionChanged: !!document.querySelector('[data-extract-selection-changed]'),
        applyExists: !!document.querySelector('[data-extract-apply]'), applyDisabled: document.querySelector('[data-extract-apply]')?.disabled }));
      await page.screenshot({ path: `${OUT}/extract-failure.png` });
    } catch { diagnostic.pageReadFailed = true; }
  }
  writeFileSync(`${OUT}/extract-failure.json`, JSON.stringify(diagnostic, null, 2) + '\n');
  console.error('Extraction failure evidence:', JSON.stringify(diagnostic));
  throw error;
} finally {
  try { await mode('ok'); await setLogo({ mode: 'reset' }); if (initial.titleArt.style !== 'auto') await setLogo({ mode: 'style', style: initial.titleArt.style }); }
  finally { await browser.close(); }
}
