// Real authenticated correction replay on the disposable E2E_TITLE_EXTRACTION fixture. No arbitrary image uploads.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer';
import { fixtureLogin } from './loginCooldown.mjs';
import { pressSeriesMoreItem } from './seriesMore.mjs';
const BASE = process.env.BASE || 'http://127.0.0.1:18140', target = new URL(BASE);
assert.ok(target.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(target.hostname));
const OUT = process.env.OUT || 'test/e2e/shots-title-mask'; mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = async (fn, label) => { for (let n = 0; n < 150; n++) { const value = await fn(); if (value) return value; await sleep(100); } throw Error('Timed out: ' + label); };
const login = await fixtureLogin(BASE, { username: process.env.E2E_USER || 'e2e', password: process.env.E2E_PASS || 'e2e-passw0rd-123' });
assert.equal(login.status, 200); const { accessToken } = await login.json();
const api = async (path, options = {}) => { const response = await fetch(BASE + path, { ...options, headers: { authorization: 'Bearer ' + accessToken, ...(options.body ? { 'content-type': 'application/json' } : {}) } }); assert.ok(response.ok, path + ':' + response.status); return response.json(); };
const capabilities = await api('/api/admin/title-extraction/capabilities'); assert.equal(capabilities.maskCorrection, true);
const id = (await api('/api/featured')).content[0].id, root = `/api/admin/series/${encodeURIComponent(id)}/title-extraction`;
const detail = () => api('/api/series/' + encodeURIComponent(id)); const before = await detail();
assert.equal(before.titleArt.mode, 'automatic', 'use a fresh fixture or run titleExtractionWalk first');
const originalVersion = before.titleArt.version;
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
let jobId = null;
const errors = [], proof = { checks: [], applied: false, sourceRgbPreserved: false };
try {
  for (const cookie of login.headers.getSetCookie()) { const pair = cookie.split(';')[0], n = pair.indexOf('='); await browser.defaultBrowserContext().setCookie({ name: pair.slice(0, n), value: pair.slice(n + 1), url: BASE }); }
  const page = await browser.newPage(); await page.setViewport({ width: 1440, height: 1000, hasTouch: true }); await page.setBypassServiceWorker(true);
  page.on('pageerror', (error) => errors.push(error.message));
  const click = async (selector) => { await page.waitForSelector(selector, { visible: true }); await page.waitForFunction((s) => { const node = document.querySelector(s); return node && !node.disabled; }, {}, selector); await page.$eval(selector, (node) => node.scrollIntoView({ block: 'center' })); await page.click(selector); };
  await page.goto(BASE + '/series/?id=' + encodeURIComponent(id), { waitUntil: 'networkidle2' }); assert.ok(await pressSeriesMoreItem(page, 'edit-details'));
  if (!(await page.$eval('[data-art-extract-cover]', (node) => node.getClientRects().length > 0))) await click('[data-edit-tab="art"]');
  await click('[data-art-extract-cover]'); await click('[data-extract-create]');
  await page.waitForFunction(() => { const button = document.querySelector('[data-extract-apply]'); return button && !button.disabled; });
  let job = (await api(root)).job; jobId = job.id; assert.ok(job.mask, 'fixture must provide a valid raw candidateRegion'); assert.equal(job.mask.revision, 0);
  await click('[data-extract-fine-tune]'); await page.waitForSelector('[data-title-mask-editor][data-mask-ready="true"]');
  const width = job.mask.canvas.width, height = job.mask.canvas.height;
  const empty = { x: Math.floor(width * .8), y: Math.floor(height * .8) };
  const alphaAt = (point) => page.$eval('[data-mask-canvas]', (canvas, p) => canvas.getContext('2d').getImageData(p.x, p.y, 1, 1).data[3], point);
  const alphaCount = () => page.$eval('[data-mask-canvas]', (canvas) => { const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; let n = 0; for (let i = 3; i < data.length; i += 4) if (data[i]) n++; return n; });
  const opaque = await page.$eval('[data-mask-canvas]', (canvas) => { const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; for (let i = 3; i < data.length; i += 4) if (data[i] === 255) return { x: ((i - 3) / 4) % canvas.width, y: Math.floor(((i - 3) / 4) / canvas.width) }; return null; });
  assert.ok(opaque); assert.equal(await alphaAt(empty), 0); const count = await alphaCount();
  const sourceRgb = await page.$eval('[data-mask-surface] img', (image, p) => { const scratch = document.createElement('canvas'); scratch.width = image.naturalWidth; scratch.height = image.naturalHeight; scratch.getContext('2d').drawImage(image, 0, 0); return [...scratch.getContext('2d').getImageData(p.x, p.y, 1, 1).data.slice(0, 3)]; }, empty);
  const paintAt = async (point, touch = false) => {
    await page.$eval('[data-mask-viewport]', (node) => node.scrollIntoView({ block: 'center' }));
    await page.$eval('[data-mask-viewport]', (node, p) => { const canvas = node.querySelector('canvas'), a = canvas.getBoundingClientRect(), b = node.getBoundingClientRect(); node.scrollLeft += a.left + (p.x + .1) / canvas.width * a.width - b.left - b.width / 2; node.scrollTop += a.top + (p.y + .1) / canvas.height * a.height - b.top - b.height / 2; }, point);
    const p = await page.$eval('[data-mask-canvas]', (canvas, pixel) => { const rect = canvas.getBoundingClientRect(); return { x: rect.left + (pixel.x + .1) / canvas.width * rect.width, y: rect.top + (pixel.y + .1) / canvas.height * rect.height }; }, point);
    assert.ok(await page.$eval('[data-mask-viewport]', (node, p) => { const b=node.getBoundingClientRect(); return p.x>b.left&&p.x<b.right&&p.y>b.top&&p.y<b.bottom; }, p), 'source target is physically inside the scrolled viewport');
    if (touch) {
      await page.evaluate(() => { window.__touchPoint=null; const surface=document.querySelector('[data-mask-surface]'); surface.addEventListener('pointerdown', (event) => { const c=surface.querySelector('canvas'), r=c.getBoundingClientRect(); window.__touchPoint={x:Math.floor((event.clientX-r.left)/r.width*c.width),y:Math.floor((event.clientY-r.top)/r.height*c.height)}; }, {capture:true,once:true}); });
      const handle=await page.touchscreen.touchStart(p.x,p.y); await handle.end(); const actual=await page.evaluate(()=>window.__touchPoint); assert.ok(actual,'touch reached the correction canvas'); return actual;
    } else await page.mouse.click(p.x,p.y);
    return point;
  };
  await page.focus('[data-mask-radius]'); await page.keyboard.press('Home'); assert.equal(Number(await page.$eval('[data-mask-radius]', (node) => node.value)), .0005);
  await paintAt(empty); await wait(async () => await alphaAt(empty) === 255, 'one pixel restore');
  assert.equal(await alphaCount(), count + 1, 'minimum pointer brush restores exactly one real source pixel');
  assert.equal(await page.$('[data-extract-apply]'), null, 'unsaved edits never expose Apply');
  const save = async () => {
    const response = page.waitForResponse((r) => new URL(r.url()).pathname === `${root}/${jobId}/mask` && r.request().method() === 'PATCH');
    await click('[data-mask-save]'); const result = await response; assert.equal(result.status(), 200); const body = JSON.parse(result.request().postData()); assert.deepEqual(Object.keys(body).sort(), ['expectedRevision', 'strokes']);
    await page.waitForFunction(() => { const button = document.querySelector('[data-extract-apply]'); return button && !button.disabled; });
    job = (await api(`${root}/${jobId}`)).job; return { job, body };
  };
  let saved = await save(); assert.equal(saved.job.mask.revision, 1); assert.equal(saved.body.expectedRevision, 0);
  assert.equal(saved.body.strokes[0].points[0].x, (empty.x + .5) / width);
  assert.equal((await detail()).titleArt.version, originalVersion);
  const serverPixel = await page.$eval('[data-extract-hero-preview] img.hero-title-logo', (image, args) => {
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; canvas.getContext('2d').drawImage(image, 0, 0);
    const x = Math.floor(((args.point.x + .5) / args.width - args.region.left) / args.region.width * canvas.width), y = Math.floor(((args.point.y + .5) / args.height - args.region.top) / args.region.height * canvas.height);
    return [...canvas.getContext('2d').getImageData(x, y, 1, 1).data];
  }, { point: empty, width, height, region: job.mask.previewRegion });
  assert.deepEqual(serverPixel.slice(0, 3), sourceRgb); assert.equal(serverPixel[3], 255); proof.sourceRgbPreserved = true;
  await click('[data-mask-tool="erase"]'); await paintAt(empty); await wait(async () => await alphaAt(empty) === 0, 'erase restored pixel');
  await click('[data-mask-undo]'); await wait(async () => await alphaAt(empty) === 255, 'undo replays baseline plus saved stroke');
  await page.waitForSelector('[data-extract-apply]');
  await click('[data-mask-zoom-in]'); await click('[data-mask-zoom-in]'); assert.equal(Number(await page.$eval('[data-mask-zoom]', (node) => node.value)), 2);
  const another = { x: Math.floor(width * .65), y: Math.floor(height * .7) };
  await click('[data-mask-tool="restore"]'); const touched=await paintAt(another, true); await wait(async () => await alphaAt(touched) === 255, 'touch restore at zoom');
  saved = await save(); assert.equal(saved.job.mask.revision, 2); assert.equal(saved.body.strokes.at(-1).points[0].x, (touched.x + .5) / width); assert.equal(saved.body.strokes.at(-1).points[0].y, (touched.y + .5) / height);
  await page.$eval('[data-extract-scroll]', n=>n.scrollTop=0); await page.screenshot({ path: `${OUT}/corrections-desktop.png` });
  const resetting = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/mask') && r.request().method() === 'PATCH');
  await click('[data-mask-reset]'); assert.deepEqual(JSON.parse((await resetting).request().postData()).strokes, []);
  await wait(async () => { job = (await api(`${root}/${jobId}`)).job; return job.mask.revision === 3 && job.mask.strokes.length === 0; }, 'server reset baseline');
  await wait(async () => await alphaAt(empty) === 0, 'reset local baseline');
  await click('[data-mask-fit]'); await click('[data-mask-tool="erase"]'); await paintAt(opaque); await wait(async () => await alphaAt(opaque) === 0, 'erase baseline pixel');
  saved = await save(); assert.equal(saved.job.mask.revision, 4);
  await page.setViewport({ width: 390, height: 844, hasTouch: true });
  await page.$eval('[data-extract-scroll]', n=>n.scrollTop=0); await page.screenshot({ path: `${OUT}/corrections-phone-editor.png` });
  await page.$eval('[data-extract-hero-preview]', (node) => node.scrollIntoView({ block: 'center' })); await page.screenshot({ path: `${OUT}/corrections-phone.png` });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  const applying = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/apply') && r.request().method() === 'POST');
  await click('[data-extract-apply]'); const applied = await applying; assert.equal(applied.status(), 200); assert.deepEqual(JSON.parse(applied.request().postData()), { expectedMaskRevision: 4 });
  assert.equal((await detail()).titleArt.mode, 'custom'); proof.applied = true;
  assert.deepEqual((await detail()).metadata, before.metadata); assert.deepEqual(errors, []);
  proof.checks = ['minimum pixel brush', 'source RGB preserved', 'erase', 'undo', 'touch at zoom', 'saved reset', 'revision-bound Apply']; proof.allVerified = true;
  writeFileSync(`${OUT}/mask-proof.json`, JSON.stringify(proof, null, 2) + '\n'); console.log('PASS restore/erase/undo/zoom/touch/reset, canonical source RGB, revision-bound preview and explicit Apply');
} finally {
  try { if (jobId) await fetch(BASE + `${root}/${jobId}`, { method: 'DELETE', headers: { authorization: 'Bearer ' + accessToken } }); await api(`/api/admin/series/${id}/art`, { method: 'PUT', body: JSON.stringify({ kind: 'logo', mode: 'reset' }) }); }
  finally { await browser.close(); }
}
