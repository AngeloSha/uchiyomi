// Source bundles, mobile diagnostics and upload/import controls in up.sh's disposable instance.
import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { multiSiteExtensionWalk } from './multiSiteExtensionWalk.mjs';
import { errorDetailsWalk } from './errorDetailsWalk.mjs';
import { uploadImportEnhancementsWalk } from './uploadImportEnhancementsWalk.mjs';
import { waitForLoginCooldown } from './loginCooldown.mjs';

const base = process.env.BASE || 'http://127.0.0.1:18140';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname)) throw new Error('Use a disposable loopback preview');
const out = process.env.OUT || 'test/e2e/shots-maintenance';
mkdirSync(out, { recursive: true });
const failures = [];
const consoleErrors = [];
const serverErrors = [];
let expectedRepositoryError = false;
let expectedImageRefusal = false;
let loginAttempt = -1;
let step = 0;
let page;
const ok = (label) => console.log(`[ ok ] ${label}`);
const bad = (label) => { failures.push(label); console.error(`[FAIL] ${label}`); };
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
try {
  page = await browser.newPage();
  // API fixtures belong to this page; a service worker's own fetches bypass page-level interception.
  await page.setBypassServiceWorker(true);
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const url = message.location()?.url || '';
    if (/401|auth\/me/.test(message.text())) return;
    if (loginAttempt === 0 && /429/.test(message.text()) && url === `${base}/auth/login`) return;
    // Only this fixture's deliberate refusal is expected; unrelated HTTP or script errors remain failures.
    if (expectedRepositoryError && /400/.test(message.text()) && url === `${base}/api/admin/extensions/repos`) return;
    // The upload fixture refuses its FIRST request to prove that retry keeps the selected pages.
    if (expectedImageRefusal && /400/.test(message.text()) && new URL(url, base).pathname === '/api/library/upload') {
      expectedImageRefusal = false;
      return;
    }
    consoleErrors.push(`${message.text()} ${url}`);
  });
  page.on('response', (response) => { if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`); });
  const shot = (name) => page.screenshot({ path: `${out}/${String(++step).padStart(2, '0')}-${name}.png` });
  await page.goto(base, { waitUntil: 'networkidle2' });
  await page.waitForSelector('input[type=password]');
  // The preceding walks share the normal ten-sign-ins/five-minute policy. Respect one advertised
  // cooldown, and observe the real authenticated shell before measuring either feature.
  for (let attempt = 0; attempt < 2; attempt++) {
    loginAttempt = attempt;
    await page.locator('form input[type="text"]').fill(process.env.E2E_USER || 'e2e');
    await page.locator('form input[type="password"]').fill(process.env.E2E_PASS || 'e2e-passw0rd-123');
    const response = page.waitForResponse((result) => new URL(result.url()).pathname === '/auth/login' && result.request().method() === 'POST');
    await page.locator('form button[type="submit"]').click();
    const result = await response;
    if (result.status() === 429 && attempt === 0) {
      await waitForLoginCooldown(result.headers()['retry-after']);
      continue;
    }
    assert.equal(result.status(), 200, 'the maintenance walk must sign in successfully');
    await page.waitForSelector('[data-topbar]', { visible: true });
    await page.waitForSelector('input[type=password]', { hidden: true });
    break;
  }
  loginAttempt = -1;
  await multiSiteExtensionWalk({ page, base, shot, check: (label, condition, detail = '') => condition ? ok(label) : bad(`${label} ${detail}`) });
  expectedRepositoryError = true;
  await errorDetailsWalk({ page, base, ok, bad, shot });
  expectedRepositoryError = false;
  expectedImageRefusal = true;
  await uploadImportEnhancementsWalk({ page, base, shot, check: (label, condition) => condition ? ok(label) : bad(label) });
  expectedImageRefusal = false;
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: `${out}/failure.png` }).catch(() => {});
    writeFileSync(`${out}/failure-page.txt`, `${page.url()}\n${await page.$eval('body', (element) => element.innerText).catch(() => '')}`);
  }
  bad(error.stack || error.message);
} finally {
  await browser.close();
}
// Private/offline acceptance must use a fresh real browser, after every mocked page is closed.
// Inherit the fixture credentials and TMPDIR, while keeping all response interception and SW bypass above isolated.
await new Promise((resolve) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./privateLibraryEnhancementsWalk.mjs', import.meta.url))], {
    env: { ...process.env, BASE: base, OUT: `${out}/private-library` }, stdio: 'inherit',
  });
  child.once('error', (error) => { bad(`Private library browser could not start: ${error.message}`); resolve(); });
  child.once('close', (code, signal) => {
    if (code === 0) ok('Private library acceptance with the real service worker');
    else bad(`Private library browser failed (${signal || code})`);
    resolve();
  });
});
// Account/locale and interrupted-download races each need a clean document, worker and IndexedDB.
// They forward real responses; targeted worker bypass is confined to their delayed asset/response step.
for (const [script, directory, label] of [
  ['localeSessionWalk.mjs', 'locale-session', 'Account-owned locale and real delayed dictionary acceptance'],
  ['offlineAccountRaceWalk.mjs', 'offline-race', 'Interrupted private download across an actual account switch'],
]) {
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(`./${script}`, import.meta.url))], {
      env: { ...process.env, BASE: base, OUT: `${out}/${directory}` }, stdio: 'inherit',
    });
    child.once('error', (error) => { bad(`${label} could not start: ${error.message}`); resolve(); });
    child.once('close', (code, signal) => {
      if (code === 0) ok(label);
      else bad(`${label} failed (${signal || code})`);
      resolve();
    });
  });
}
const result = { failures, consoleErrors, serverErrors };
writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
process.exitCode = failures.length || consoleErrors.length || serverErrors.length ? 1 : 0;
