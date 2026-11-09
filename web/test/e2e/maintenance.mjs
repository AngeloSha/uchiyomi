// Source bundles and mobile diagnostics through the built application. Uses up.sh's disposable instance.
import puppeteer from 'puppeteer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { multiSiteExtensionWalk } from './multiSiteExtensionWalk.mjs';
import { errorDetailsWalk } from './errorDetailsWalk.mjs';

const base = process.env.BASE || 'http://127.0.0.1:18140';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname)) throw new Error('Use a disposable loopback preview');
const out = process.env.OUT || 'test/e2e/shots-maintenance';
mkdirSync(out, { recursive: true });
const failures = [];
const consoleErrors = [];
const serverErrors = [];
let expectedRepositoryError = false;
let step = 0;
let page;
const ok = (label) => console.log(`[ ok ] ${label}`);
const bad = (label) => { failures.push(label); console.error(`[FAIL] ${label}`); };
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
try {
  page = await browser.newPage();
  // API fixtures belong to this page; a service worker's own fetches bypass page-level interception.
  await page.setBypassServiceWorker(true);
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const url = message.location()?.url || '';
    if (/401|auth\/me/.test(message.text())) return;
    // Only this fixture's deliberate refusal is expected; unrelated HTTP or script errors remain failures.
    if (expectedRepositoryError && /400/.test(message.text()) && url === `${base}/api/admin/extensions/repos`) return;
    consoleErrors.push(`${message.text()} ${url}`);
  });
  page.on('response', (response) => { if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`); });
  const shot = (name) => page.screenshot({ path: `${out}/${String(++step).padStart(2, '0')}-${name}.png` });
  await page.goto(base, { waitUntil: 'networkidle2' });
  await page.waitForSelector('input[type=password]');
  const inputs = await page.$$('input');
  await inputs[0].type(process.env.E2E_USER || 'e2e');
  await page.type('input[type=password]', process.env.E2E_PASS || 'e2e-passw0rd-123');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('input[type=password]'));
  await multiSiteExtensionWalk({ page, base, shot, check: (label, condition, detail = '') => condition ? ok(label) : bad(`${label} ${detail}`) });
  expectedRepositoryError = true;
  await errorDetailsWalk({ page, base, ok, bad, shot });
  expectedRepositoryError = false;
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: `${out}/failure.png` }).catch(() => {});
    writeFileSync(`${out}/failure-page.txt`, `${page.url()}\n${await page.$eval('body', (element) => element.innerText).catch(() => '')}`);
  }
  bad(error.stack || error.message);
} finally {
  await browser.close();
}
const result = { failures, consoleErrors, serverErrors };
writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
process.exitCode = failures.length || consoleErrors.length || serverErrors.length ? 1 : 0;
