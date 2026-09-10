// Every language renders, and Arabic mirrors.
//
// Machine-assisted translation has two failure modes a unit test cannot see: a string that is longer than
// its container and breaks the layout, and a right-to-left language rendered inside a left-to-right frame,
// which technically "works" and looks broken to anyone who reads it.
import puppeteer from 'puppeteer';
import { readdirSync, readFileSync, mkdirSync } from 'fs';

const BASE = process.env.BASE || 'http://127.0.0.1:18140';
const OUT = process.env.OUT || 'test/e2e/shots-i18n';
mkdirSync(OUT, { recursive: true });

const LOCALES = ['en', 'es', 'fr', 'de', 'pt-BR', 'ru', 'ja', 'zh', 'ar'];
const fails = [];
const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 900 });

// Sign in once.
await p.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
// networkidle2 fires before React has hydrated the login form under puppeteer 24 + Next 15, so grabbing
// inputs immediately found none. Wait for the form itself, not the network.
/**
 * Sign in, resolving each field at the moment it is typed into.
 *
 * ⚠️ NOT VIA `$$('input')` HANDLES. The form is grabbed after `waitForSelector`, but React re-renders it
 * once the session check settles, and a handle taken before that render points at a node that is no longer
 * in the document -- puppeteer then throws `DOM.resolveNode: Node with given id does not belong to the
 * document` and the whole run dies before a single language is checked. Passing a selector makes puppeteer
 * re-query at type time, which is the same race the comment above the original wait already describes.
 */
async function signIn() {
  await p.waitForSelector('input[type=password]', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 800));
  await p.type('input:not([type=password])', process.env.E2E_USER || 'e2e');
  await p.type('input[type=password]', process.env.E2E_PASS || 'e2e-passw0rd-123');
  await p.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 4500));
}
await signIn();

/**
 * Sign in again if the session went, and wait for the library to have actually rendered.
 *
 * ⚠️ TWO RACES, BOTH OF WHICH MAKE THIS FILE MEASURE THE WRONG PAGE. This harness runs against the instance
 * the browser suite leaves behind, which ends by signing out and drives several tabs that share one cookie
 * jar; and `networkidle2` fires before React has painted, which is the same race the comment above the
 * login already records. Either way the text sampled below is a login form or an empty shell, and a
 * translation check against a page with no words on it passes every language.
 */
async function readyLibrary() {
  if (await p.$('input[type=password]')) {
    await signIn();
    await p.goto(`${BASE}/library`, { waitUntil: 'networkidle2', timeout: 60000 });
  }
  // The filter sidebar is the last thing on this page to exist, so it is the honest "rendered" signal.
  await p.waitForSelector('aside', { timeout: 20000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));
}

for (const code of LOCALES) {
  await p.evaluate((c) => localStorage.setItem('uchiyomi.lang', c), code);
  await p.goto(`${BASE}/library`, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2200));
  await readyLibrary();

  const info = await p.evaluate(() => ({
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
    // 400 was enough when this only had to see the nav. The library now renders its filter panel
    // beside the grid on a 1280px viewport, and the words this check depends on run past that.
    text: (document.body.innerText || '').slice(0, 1500),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    len: (document.body.innerText || '').trim().length,
  }));

  const expectDir = code === 'ar' ? 'rtl' : 'ltr';
  const problems = [];
  if (info.lang !== code) problems.push(`html lang is "${info.lang}", not "${code}"`);
  if (info.dir !== expectDir) problems.push(`html dir is "${info.dir}", expected "${expectDir}"`);
  if (info.len < 40) problems.push('the page is blank');
  if (info.overflow > 4) problems.push(`${info.overflow}px of horizontal overflow`);

  // A translated page must not still be showing English chrome.
  //
  // ⚠️ THIS USED TO READ `/\bLibrary\b/ && /\bBrowse\b/`, AND DELETING THE BROWSE TAB WOULD HAVE MADE IT
  // UNFALSIFIABLE -- always false, therefore always passing, therefore no longer detecting an untranslated
  // nav in any of the eight languages. Nothing would have failed. So the check is now counted, and it
  // audits its own premise in English below.
  const LIBRARY_EN = ['Home', 'Library', 'Lists', 'Discover', 'Sort by', 'Updated', 'Newest', 'Read state'];
  // ⚠️ Case-INSENSITIVE. The filter panel's section labels are `uppercase` in CSS, and Chrome's
  // `innerText` reports text as rendered -- so "Sort by" reads back as "SORT BY". A case-sensitive
  // match found 6 of these 8 words and the clause below said so, which is exactly what it is for.
  const english = LIBRARY_EN.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(info.text));

  if (code !== 'en' && english.length >= 3) {
    problems.push(`the page is still in English: ${english.join(', ')}`);
  }
  // ⚠️ THE ANTI-VACUITY CLAUSE, and the whole point of the rewrite. In English every one of these words is
  // on /library at 1280px. If a redesign renames or removes them, this fails LOUDLY here instead of quietly
  // emptying the assertion above -- which is exactly what deleting the Browse tab would have done.
  if (code === 'en' && english.length < LIBRARY_EN.length) {
    problems.push(`only ${english.length}/${LIBRARY_EN.length} of the words this check relies on are still on `
      + `/library (missing: ${LIBRARY_EN.filter((w) => !english.includes(w)).join(', ')}) — update LIBRARY_EN, `
      + `or work out why the page says: ${JSON.stringify(info.text.slice(0, 160))}`);
  }

  // Nav labels reach `tr()` through a VARIABLE, which a literal scan of the source cannot see. That blind
  // spot has now shipped untranslated labels three times: the main nav, the admin sidebar, and the profile
  // tabs. `keys()` in lib/i18n.ts makes them discoverable at the definition site; this is the second net,
  // checked in a browser where a variable and a literal look the same.
  //
  // Both consoles are visited. Checking only /admin is exactly how /profile shipped an English tab row.
  const CONSOLES = [
    ['/admin', ['Overview', 'Members', 'Settings', 'Providers', 'Server', 'People', 'Content', 'Sources']],
    ['/profile', ['Reading', 'Account', 'Settings', 'Badges', 'Language', 'Accent']],
  ];
  if (code !== 'en') {
    for (const [path, words] of CONSOLES) {
      await p.goto(`${BASE}${path}`, { waitUntil: 'networkidle2', timeout: 60000 });
      await new Promise((r) => setTimeout(r, 2400));
      const text = await p.evaluate(() => document.body.innerText || '');
      const english = words.filter((w) => new RegExp(`\\b${w}\\b`).test(text));
      if (english.length >= 3) problems.push(`${path} still in English: ${english.join(', ')}`);
      const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (over > 4) problems.push(`${path}: ${over}px of horizontal overflow`);
      await p.screenshot({ path: `${OUT}/${code}-${path.slice(1)}.png` });
    }
  }

  await p.screenshot({ path: `${OUT}/${code}.png` });
  if (problems.length) { fails.push(`${code}: ${problems.join('; ')}`); console.log(`  [FAIL] ${code}: ${problems.join('; ')}`); }
  else console.log(`  [ ok ] ${code}  dir=${info.dir}`);
}

// Every locale file must cover every key the app asks for.
const keys = new Set();
for (const f of ['es'].map((c) => `public/locales/${c}.json`)) {
  const d = JSON.parse(readFileSync(f, 'utf8'));
  Object.keys(d).filter((k) => k !== '_meta').forEach((k) => keys.add(k));
}
for (const f of readdirSync('public/locales')) {
  const d = JSON.parse(readFileSync(`public/locales/${f}`, 'utf8'));
  const missing = [...keys].filter((k) => !(k in d));
  const empty = [...keys].filter((k) => d[k] === '');
  if (missing.length) { fails.push(`${f}: ${missing.length} missing keys`); console.log(`  [FAIL] ${f}: ${missing.length} missing`); }
  else if (empty.length) { fails.push(`${f}: ${empty.length} empty`); console.log(`  [FAIL] ${f}: ${empty.length} empty`); }
  else console.log(`  [ ok ] ${f}  complete`);
}

await b.close();
console.log(`\n${fails.length} failure(s)`);
process.exit(fails.length ? 1 : 0);
