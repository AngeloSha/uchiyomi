// Every language renders, and Arabic mirrors.
//
// Machine-assisted translation has two failure modes a unit test cannot see: a string that is longer than
// its container and breaks the layout, and a right-to-left language rendered inside a left-to-right frame,
// which technically "works" and looks broken to anyone who reads it.
import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdirSync } from 'fs';

const BASE = process.env.BASE || 'http://127.0.0.1:18140';
const OUT = process.env.OUT || 'test/e2e/shots-i18n';
mkdirSync(OUT, { recursive: true });

const LOCALES = ['en', 'es', 'fr', 'de', 'pt-BR', 'ru', 'ja', 'zh', 'ar'];
const fails = [];
const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 900 });

// A successful POST is only the start of sign-in: AuthProvider still purges the old account's local
// cache before it adopts the new user. A fixed sleep followed by goto can destroy that work on a busy
// CI runner. Wait for the authenticated shell before navigating, and never measure the login screen.
async function signIn() {
  await p.locator('form input[type="text"]').fill(process.env.E2E_USER || 'e2e');
  await p.locator('form input[type="password"]').fill(process.env.E2E_PASS || 'e2e-passw0rd-123');
  const response = p.waitForResponse((r) => new URL(r.url()).pathname === '/auth/login' && r.request().method() === 'POST', { timeout: 30000 });
  await p.locator('form button[type="submit"]').click();
  assert.equal((await response).status(), 200, 'the locale walk must sign in successfully');
  await p.waitForSelector('[data-topbar]', { visible: true, timeout: 30000 });
  await p.waitForSelector('input[type="password"]', { hidden: true, timeout: 30000 });
}

async function readyAuthenticated() {
  // Refresh/hydration can reveal the password form after networkidle2. Observe both possible outcomes,
  // rather than probing once and swallowing the later missing-page timeout.
  await p.waitForFunction(() => document.querySelector('[data-topbar]') || document.querySelector('form input[type="password"]'), { timeout: 30000 });
  if (await p.$('form input[type="password"]')) await signIn();
  await p.waitForSelector('[data-topbar]', { visible: true, timeout: 30000 });
  assert.equal(await p.$('form input[type="password"]'), null, 'translation checks require an authenticated page');
}

async function readyLibrary() {
  await readyAuthenticated();
  await p.waitForSelector('[data-library-toolbar]', { visible: true, timeout: 30000 });
  await p.waitForSelector('aside', { visible: true, timeout: 30000 });
}

await p.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
await readyAuthenticated();

// `?sort=updated`: since v0.60.0 the order is one key in the toolbar saying the order in force, and this check reads its
// label -- so the order is named in the URL rather than inherited from whatever an earlier walk saved as the default.
const LIBRARY_URL = `${BASE}/library/?sort=updated`;
for (const code of LOCALES) {
  await p.evaluate((c) => localStorage.setItem('uchiyomi.lang', c), code);
  await p.goto(LIBRARY_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2200));
  await readyLibrary();

  const info = await p.evaluate(() => ({
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
    // 400 was enough when this only had to see the nav. The library now renders its filter panel
    // beside the grid on a 1280px viewport, and the words this check depends on run past that -- and since v0.60.0 the
    // toolbar's Sort key comes after the whole panel, its sources and genres included.
    text: (document.body.innerText || '').slice(0, 4000),
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
  // v0.60.0: "Sort by", "Updated" and "Newest" were three of the nine sort chips in the panel; the orders are a menu now,
  // and what stays on screen is the toolbar's Sort key, saying the order in force ("Updated", from the URL above), and
  // its Select key.
  const LIBRARY_EN = ['Home', 'Library', 'Lists', 'Discover', 'Updated', 'Select', 'Read state', 'Status'];
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
  //
  // The import page is its own route off Admin → Sources (Providers until v0.54.0), so neither console's tab row
  // covers it; PR #52 shipped it with 62 of its strings in no locale file and the check here saw nothing, because
  // it never went there. The words are from the intake card's sentences, not its eyebrow (uppercase in CSS, and
  // innerText reports text as rendered), and not "Mihon" (a name, the same in every language). "bring your
  // list over" is the tracker box's not-connected line (v0.36.0) -- the state an e2e instance is in --
  // and NOT its eyebrow "From your tracker", which `\bFrom your tracker\b` could never match in uppercase.
  //
  // v0.39.0 gave both consoles `?tab=` addresses and rebuilt the admin Settings tab and the profile's
  // Settings tab out of new sections, so those two are visited directly -- the tab rows above only ever
  // saw each console's FIRST tab. Every word in the new lists is one whose es/de/fr translation differs
  // from the English: a word that is the same in French ("Badges", "Moments") reads as a leak on a
  // correctly translated page, and three of those would fail a page that is fine. ("Server" in the older
  // /admin list is German too; it sits alone under the >= 3 threshold.)
  // v0.88.0: each console is one list (its pages by name, in groups), and every page has its own `?tab=`.
  const CONSOLES = [
    ['/admin', ['Overview', 'Members', 'Settings', 'People', 'Libraries', 'Activity']],
    // v0.54.0: Providers and Extensions are one Sources page, whose views and Test all are visited by its address.
    ['/admin/?tab=sources', ['Your sources', 'Add sources', 'Test all', 'Built-in']],
    // A settings page each, so a phone sees the rows and not only the list.
    ['/admin/?tab=server', ['Open registration', 'Check for updates', 'Updates and privacy', 'When someone signs up', 'Server name']],
    ['/admin/import', ['review matches', 'matches each title', 'Start matching', 'backup stays on your server', 'nothing lands in your library', 'bring your list over']],
    ['/profile', ['Connections', 'Account', 'Settings', 'Appearance', 'Insights', 'Sign out']],
    ['/profile/?tab=reading', ['Repeated pages', 'Wide pages', 'Pick the mode for each series', 'More options', 'Reading']],
    // Library -> Downloads (v0.49.0): its empty state on a quiet instance, its section names on a busy one.
    ['/library/?view=downloads', ['Library', 'Nothing is being fetched', 'as they come in', 'Came in today', 'Needs attention', 'Server tasks', 'Queued']],
  ];
  if (code !== 'en') {
    for (const [path, words] of CONSOLES) {
      await p.goto(`${BASE}${path}`, { waitUntil: 'networkidle2', timeout: 60000 });
      await readyAuthenticated();
      await new Promise((r) => setTimeout(r, 2400));
      const text = await p.evaluate(() => document.body.innerText || '');
      const english = words.filter((w) => new RegExp(`\\b${w}\\b`).test(text));
      if (english.length >= 3) problems.push(`${path} still in English: ${english.join(', ')}`);
      const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (over > 4) problems.push(`${path}: ${over}px of horizontal overflow`);
      // `?tab=Settings` is part of the path now: the query characters are folded into the file name too.
      await p.screenshot({ path: `${OUT}/${code}-${path.slice(1).replace(/[/?=&]/g, '-')}.png` });
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
