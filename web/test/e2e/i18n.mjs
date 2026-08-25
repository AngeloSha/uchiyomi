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
await p.waitForSelector('input[type=password]', { timeout: 30000 });
const i = await p.$$('input');
await i[0].type(process.env.E2E_USER || 'e2e');
await p.type('input[type=password]', process.env.E2E_PASS || 'e2e-passw0rd-123');
await p.keyboard.press('Enter');
await new Promise((r) => setTimeout(r, 4500));

for (const code of LOCALES) {
  await p.evaluate((c) => localStorage.setItem('uchiyomi.lang', c), code);
  await p.goto(`${BASE}/library`, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2200));

  const info = await p.evaluate(() => ({
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
    text: (document.body.innerText || '').slice(0, 400),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    len: (document.body.innerText || '').trim().length,
  }));

  const expectDir = code === 'ar' ? 'rtl' : 'ltr';
  const problems = [];
  if (info.lang !== code) problems.push(`html lang is "${info.lang}", not "${code}"`);
  if (info.dir !== expectDir) problems.push(`html dir is "${info.dir}", expected "${expectDir}"`);
  if (info.len < 40) problems.push('the page is blank');
  if (info.overflow > 4) problems.push(`${info.overflow}px of horizontal overflow`);

  // A translated page must not still be showing the English nav.
  if (code !== 'en' && /\bLibrary\b/.test(info.text) && /\bBrowse\b/.test(info.text)) {
    problems.push('the navigation is still in English — nothing was translated');
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
