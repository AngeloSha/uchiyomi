// S6 follow-up (macOS): what an UNSIGNED update does to the cookie jar.
//
// The package has the enableCookieEncryption fuse on, so Chromium keeps its cookie key in the login Keychain as
// "Uchiyomi Safe Storage", with an access list naming the app that created it. An ad-hoc signature identifies the
// app by its code-directory hash, and a new version has a new hash -- so the updated app may be a stranger to
// its own keychain item: a "wants to use your confidential information" prompt, or cookies it cannot decrypt.
//
// Relaunch a REBUILT app (dist-next, version bumped, ad-hoc signed again) on the profile the product smoke left
// signed in, and record: does it reach the app page, is it still signed in, how long did it take, and is the item
// there. (The cookie-encryption fuse is OFF since the spike, so the item must never exist; this stays as the
// regression check for the day someone turns it back on without signing.)
import puppeteer from 'puppeteer-core';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DESKTOP, OUT, record, launch, waitFor, freePort, runAsync, runSync, sleep, readJson, snapshot, hardKill, isAlive } from './lib.mjs';

const root = readFileSync(join(OUT, 'product-root.txt'), 'utf8').trim();
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

/** Launch `exeToRun` on the product smoke's profile; did the window reach the app, and is it signed in? */
async function attempt(exeToRun, tag, pageTimeoutMs) {
  const r = { tag, reached: false, signedIn: null };
  const dbg = await freePort();
  const t0 = Date.now();
  launch(exeToRun, [`--data-dir=${root}`, `--remote-debugging-port=${dbg}`], { log: join(OUT, `s6-keychain-${tag}-app.log`) });
  // If the window is stuck, a picture of the screen says why (a Keychain prompt is a system dialog).
  const cap = setTimeout(() => { void runAsync('screencapture', ['-x', join(OUT, `s6-keychain-${tag}-screen.png`)]); }, 30_000);
  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${dbg}/json/version`, { signal: AbortSignal.timeout(2000) })).ok, { timeoutMs: 60_000, what: 'debug port' });
    const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${dbg}`, defaultViewport: null, protocolTimeout: 60_000 });
    const st = await waitFor(() => readJson(join(root, 'state.json'))?.uiPort, { timeoutMs: 60_000, what: 'state' });
    try {
      const page = await waitFor(async () => (await browser.pages()).find((p) => p.url().startsWith(`http://127.0.0.1:${st}`)), { timeoutMs: pageTimeoutMs, what: 'app page' });
      r.reached = true;
      await waitFor(async () => (await page.evaluate(() => document.body.innerText.length > 50).catch(() => false)), { timeoutMs: 60_000, what: 'rendered app' });
      await sleep(3000);
      r.signedIn = await page.evaluate(() => !document.querySelector('input[type=password]'));
      r.appPageMs = Date.now() - t0;
    } finally {
      await browser.disconnect();
    }
  } catch (e) {
    r.error = String(e.message || e);
  }
  clearTimeout(cap);
  r.logTail = readFileSync(join(root, 'logs', 'desktop.log'), 'utf8').split('\n').filter((l) => /starting|supervisor: up|app loaded|startup failed/.test(l)).slice(-3).map((l) => l.slice(0, 220));
  const before = snapshot(root).list;
  await runAsync(exeToRun, ['--quit-for-update', `--data-dir=${root}`], { timeoutMs: 120_000 });
  await sleep(2000);
  hardKill(before.map((p) => p.pid).filter(isAlive));
  return r;
}

// vN+1 (new code-directory hash) first, then the ORIGINAL vN again as the control: if only the rebuilt app
// stalls, the stall belongs to the changed signature, not to this profile or this runner.
const next = await attempt(exe, 'vN+1', 120_000);
const control = await attempt(join(oldApp, 'Contents', 'MacOS', 'Uchiyomi'), 'vN-control', 90_000);
Object.assign(ev, { next, control });
const signedIn = next.signedIn;
const reached = next.reached;
ev.appPageMs = next.appPageMs;
ev.error = next.error;
// An update must open straight into the app, still signed in, with no Keychain item involved at all.
record('S6-unsigned-update-keychain', reached && signedIn === true && control.signedIn === true && !ev.keychainItem ? 'PASS' : 'FAIL',
  `rebuilt app (CDHash ${ev.cdhashOld?.slice(0, 10)} -> ${ev.cdhashNew?.slice(0, 10)}) on the product smoke's profile: app page ${reached ? `reached in ${ev.appPageMs} ms` : 'NOT reached'}, still signed in: ${signedIn}${ev.error ? ` (${ev.error.slice(0, 120)})` : ''}; control (the original build, same profile, right after): ${control.reached ? `reached in ${control.appPageMs} ms, signed in: ${control.signedIn}` : `NOT reached (${String(control.error).slice(0, 100)})`}; keychain item "Uchiyomi Safe Storage": ${ev.keychainItem ? 'present' : 'absent'}; screen: ci-out/s6-keychain-vN+1-screen.png`,
  ev);
