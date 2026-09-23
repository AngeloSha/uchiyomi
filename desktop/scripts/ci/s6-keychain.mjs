// S6 follow-up (macOS): what an UNSIGNED update does to the cookie jar.
//
// The package has the enableCookieEncryption fuse on, so Chromium keeps its cookie key in the login Keychain as
// "Uchiyomi Safe Storage", with an access list naming the app that created it. An ad-hoc signature identifies the
// app by its code-directory hash, and a new version has a new hash -- so the updated app may be a stranger to
// its own keychain item: a "wants to use your confidential information" prompt, or cookies it cannot decrypt.
//
// Relaunch a REBUILT app (dist-next, version bumped, ad-hoc signed again) on the profile S8 left signed in, and
// record: does it reach the app page, is it still signed in, how long did it take, and is the item there.
import puppeteer from 'puppeteer-core';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DESKTOP, OUT, record, launch, waitFor, freePort, runAsync, runSync, sleep, readJson, snapshot, hardKill, isAlive } from './lib.mjs';

const root = readFileSync(join(OUT, 's8-root.txt'), 'utf8').trim();
const dist = join(DESKTOP, 'dist-next');
const d = readdirSync(dist).find((x) => /^mac/.test(x));
const exe = join(dist, d, 'Uchiyomi.app', 'Contents', 'MacOS', 'Uchiyomi');
const cdhash = (app) => (/CDHash=(\w+)/.exec(runSync('codesign', ['-dv', '--verbose=4', app]).out) || [])[1];
const oldApp = join(DESKTOP, 'dist', readdirSync(join(DESKTOP, 'dist')).find((x) => /^mac/.test(x)), 'Uchiyomi.app');
const ev = {
  root,
  cdhashOld: cdhash(oldApp),
  cdhashNew: cdhash(join(dist, d, 'Uchiyomi.app')),
  keychainItem: runSync('security', ['find-generic-password', '-s', 'Uchiyomi Safe Storage']).out.split('\n').filter((l) => /svce|acct|keychain:/.test(l)).join(' | '),
};

const dbg = await freePort();
const t0 = Date.now();
launch(exe, [`--data-dir=${root}`, `--remote-debugging-port=${dbg}`], { log: join(OUT, 's6-keychain-app.log') });
let signedIn = null;
let reached = false;
try {
  await waitFor(async () => (await fetch(`http://127.0.0.1:${dbg}/json/version`, { signal: AbortSignal.timeout(2000) })).ok, { timeoutMs: 60_000, what: 'debug port' });
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${dbg}`, defaultViewport: null, protocolTimeout: 60_000 });
  const st = await waitFor(() => readJson(join(root, 'state.json'))?.uiPort, { timeoutMs: 60_000, what: 'state' });
  const page = await waitFor(async () => (await browser.pages()).find((p) => p.url().startsWith(`http://127.0.0.1:${st}`)), { timeoutMs: 120_000, what: 'app page' });
  reached = true;
  await waitFor(async () => (await page.evaluate(() => document.body.innerText.length > 50).catch(() => false)), { timeoutMs: 90_000, what: 'rendered app' });
  await sleep(3000);
  signedIn = await page.evaluate(() => !document.querySelector('input[type=password]'));
  ev.appPageMs = Date.now() - t0;
  await browser.disconnect();
} catch (e) {
  ev.error = String(e.message || e);
}
ev.signedIn = signedIn;
ev.reached = reached;
ev.appLogTail = readFileSync(join(root, 'logs', 'desktop.log'), 'utf8').split('\n').slice(-6).join('\n');
const before = snapshot(root).list;
await runAsync(exe, ['--quit-for-update', `--data-dir=${root}`], { timeoutMs: 120_000 });
await sleep(2000);
hardKill(before.map((p) => p.pid).filter(isAlive));
record('S6-unsigned-update-keychain', 'INFO',
  `rebuilt app (CDHash ${ev.cdhashOld?.slice(0, 10)} -> ${ev.cdhashNew?.slice(0, 10)}) on the S8 profile: app page ${reached ? `reached in ${ev.appPageMs} ms` : 'NOT reached'}, still signed in: ${signedIn}${ev.error ? `; ${ev.error.slice(0, 200)}` : ''}; keychain item: ${ev.keychainItem ? 'present' : 'absent'}`,
  ev);
