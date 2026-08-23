// The web app, driven in a real browser, against a real server.
//
// This is the test that was missing. `web/test/` held one file of pure-function checks, and CI proved only
// that the app compiles -- so on 2026-08-23 an end-to-end pass found four user-facing bugs that were all
// invisible from the source and from a green suite of 326 server-side tests:
//
//   * the library, search and browse pages listed nothing
//   * downloading a chapter for offline reading had never worked
//   * two of the three OPDS feeds were a 500 for everyone
//   * every deep link on the documented default port redirected to a dead URL
//
// Each was a route wired to the wrong thing, which a test that imports the function and calls it cannot see.
// So this asserts the things a person would notice: pages render, the library lists what is in it, the
// reader decodes actual pixels, and the console is clean.
//
// It needs a running instance. `npm run test:e2e` brings one up from the all-in-one image; BASE=... points
// it at an existing one instead.
import puppeteer from 'puppeteer';
import { mkdirSync, writeFileSync } from 'fs';

const BASE = process.env.BASE || 'http://127.0.0.1:18140';
const USER = process.env.E2E_USER || 'e2e';
const PASS = process.env.E2E_PASS || 'e2e-passw0rd-123';
const OUT = process.env.OUT || 'test/e2e/shots';
const SEEDED = (process.env.E2E_SERIES || 'Mixed Formats').split(',').map((s) => s.trim()).filter(Boolean);

mkdirSync(OUT, { recursive: true });
const fails = [];
const consoleErrors = [];
const serverErrors = [];
let step = 0;

const ok = (what) => console.log(`    [ ok ] ${what}`);
const bad = (what) => { fails.push(what); console.log(`    [FAIL] ${what}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('console', (m) => {
    // A 401 on /auth/me before signing in is expected noise, not a fault.
    if (m.type() === 'error' && !/401|auth\/me/.test(m.text())) consoleErrors.push(`${page.url()} :: ${m.text()}`);
  });
  page.on('response', (r) => { if (r.status() >= 500) serverErrors.push(`${r.status()} ${r.request().method()} ${r.url()}`); });

  const shot = async (name) => page.screenshot({ path: `${OUT}/${String(++step).padStart(2, '0')}-${name}.png` });

  // ---------------------------------------------------------------- sign in
  console.log('\n  sign in');
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  await shot('login');
  const inputs = await page.$$('input');
  if (!inputs.length) bad('the login page has no form');
  else {
    await inputs[0].type(USER);
    await page.type('input[type=password]', PASS);
    await page.keyboard.press('Enter');
    await sleep(4000);
    (await page.$('input[type=password]')) ? bad('still on the login form after valid credentials') : ok('signed in');
  }

  // ---------------------------------------------------------------- every screen
  for (const [name, path] of [['home', '/'], ['library', '/library'], ['search', '/search'],
                              ['browse', '/browse'], ['downloads', '/downloads'],
                              ['profile', '/profile'], ['admin', '/admin']]) {
    console.log(`\n  ${path}`);
    const before = consoleErrors.length;
    await page.goto(BASE + path, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    await sleep(2200);
    await shot(name);

    // The port check is here because losing it is exactly what the nginx redirect did, and it looks like
    // nothing until every bookmark in the house is dead.
    if (!page.url().startsWith(BASE)) bad(`${path} navigated away from ${BASE} (now ${page.url()}) -- a redirect dropped the port`);

    const text = await page.evaluate(() => document.body.innerText || '');
    if (/something went wrong|application error|unhandled/i.test(text)) bad(`${path} rendered an error state`);
    else if (text.trim().length < 40) bad(`${path} is effectively blank (${text.trim().length} chars)`);
    else ok(`${path} rendered`);

    if (consoleErrors.length > before) bad(`${path}: ${consoleErrors.length - before} console error(s)`);
  }

  // ---------------------------------------------------------------- the library actually lists things
  console.log('\n  library contents');
  await page.goto(`${BASE}/library`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(3000);
  const shown = await page.evaluate((names) => {
    const t = document.body.innerText || '';
    return names.filter((n) => t.includes(n));
  }, SEEDED);
  shown.length === SEEDED.length
    ? ok(`lists all ${SEEDED.length} seeded series`)
    : bad(`only ${shown.length}/${SEEDED.length} seeded series listed — this is the regression that shipped in v0.8.0`);
  await shot('library-content');

  // ---------------------------------------------------------------- read something
  console.log('\n  series and reader');
  const href = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a')].find((x) => /\/series\//.test(x.getAttribute('href') || ''));
    return a ? a.getAttribute('href') : null;
  });
  if (!href) bad('no series to open from the library grid');
  else {
    await page.goto(BASE + href, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(3000);
    await shot('series');
    ((await page.evaluate(() => (document.body.innerText || '').length)) > 60) ? ok('series page opened') : bad('series page is blank');

    await page.evaluate(() => {
      [...document.querySelectorAll('button,a')].find((b) => /start reading|continue/i.test(b.innerText || ''))?.click();
    });
    await sleep(6000);
    await shot('reader');
    const imgs = await page.evaluate(() =>
      [...document.querySelectorAll('img')].filter((i) => /\/img\//.test(i.src)).map((i) => i.naturalWidth));
    const decoded = imgs.filter((w) => w > 0);
    decoded.length
      ? ok(`reader decoded ${decoded.length}/${imgs.length} page(s)`)
      : bad(`no page image decoded (${imgs.length} candidates) — the reader shows nothing`);
  }

  // ---------------------------------------------------------------- phone
  console.log('\n  phone 390x844');
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  for (const [name, path] of [['home', '/'], ['library', '/library']]) {
    await page.goto(BASE + path, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    await sleep(2000);
    await shot(`phone-${name}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    overflow > 4 ? bad(`phone ${path}: ${overflow}px of horizontal overflow`) : ok(`phone ${path}: no overflow`);
  }

  // ---------------------------------------------------------------- installable
  console.log('\n  pwa');
  const mf = await page.evaluate(async () => {
    const l = document.querySelector('link[rel=manifest]');
    if (!l) return null;
    try { const r = await fetch(l.href); return { status: r.status, body: await r.json() }; } catch { return { status: 0 }; }
  });
  if (!mf) bad('no <link rel=manifest> — the app is not installable');
  else if (mf.status !== 200) bad(`manifest returned ${mf.status}`);
  else ok(`manifest ok (${mf.body.name || mf.body.short_name})`);
} finally {
  await browser.close();
}

console.log('\n' + '='.repeat(70));
console.log(`${fails.length} failure(s), ${consoleErrors.length} console error(s), ${serverErrors.length} server error(s)`);
for (const f of fails) console.log(`  ${f}`);
for (const c of [...new Set(consoleErrors)].slice(0, 10)) console.log(`  console: ${c.slice(0, 160)}`);
for (const s of [...new Set(serverErrors)].slice(0, 10)) console.log(`  server:  ${s.slice(0, 160)}`);
writeFileSync(`${OUT}/result.json`, JSON.stringify({ fails, consoleErrors, serverErrors }, null, 2));
process.exit(fails.length || consoleErrors.length || serverErrors.length ? 1 : 0);
