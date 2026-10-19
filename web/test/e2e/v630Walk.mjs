// v0.63.0's browser walk: single sign-on as the only way in (#208), on the all-in-one image with a fake provider
// (fakeIdp.mjs). It brings up a network, a database, the provider and the app of its own, switches the app between
// sign-in modes by starting it again, and takes everything down at the end.
//
//   docker build -f Dockerfile.aio -t uchiyomi:e2e-630 .          (from the repo)
//   IMAGE=uchiyomi:e2e-630 node test/e2e/v630Walk.mjs             (from web/)
//
// 1. Local mode, a new server: setup makes a password admin, who links the account to the provider from Profile → Account.
// 2. SSO-only mode on that database: the sign-in screen is the provider's button alone; the linked admin signs in through
//    it; Members makes no account and resets no password; the profile has no password and no 2FA; Admin → Settings has
//    no Open registration; someone new gets an account at their first sign-in (OIDC_ALLOW_SIGNUP).
// 3. The rescue: the password form is back, saying why, and the admin signs in with the password.
// 4. SSO-only mode on a new database: anyone but the named subject is told the server is not set up, and logged with
//    their subject; the named subject's first sign-in makes the admin.
import puppeteer from 'puppeteer';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const IMAGE = process.env.IMAGE || 'uchiyomi:e2e-630';
const NET = process.env.E2E_NET || 'uchi-e2e-630';
const SUBNET = process.env.E2E_SUBNET || '10.222.63.0/24';
const PORT = Number(process.env.E2E_PORT || 18163);
const IDP_PORT = Number(process.env.E2E_IDP_PORT || 28630);
const BASE = `http://127.0.0.1:${PORT}`;
const IDP = `http://127.0.0.1:${IDP_PORT}`;
const OUT = process.env.OUT || 'shots630';
const PASS = 'owner-passw0rd-1';
const HERE = dirname(fileURLToPath(import.meta.url));
mkdirSync(OUT, { recursive: true });

const failures = [];
const ok = (m) => console.log(`    [ ok ] ${m}`);
const bad = (m) => { failures.push(m); console.log(`    [FAIL] ${m}`); };
const check = (yes, pass, fail = pass) => (yes ? ok(pass) : bad(fail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15_000, step = 250) => {
  const started = Date.now();
  let v;
  while (Date.now() - started < ms) { v = await fn(); if (v) return v; await sleep(step); }
  return v;
};
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const quiet = (...args) => { try { docker(...args); } catch { /* not there */ } };
/** The app's log, both streams: its own lines go to stdout as JSON (quotes escaped), console.warn's to stderr. */
const logs = () => { const r = spawnSync('docker', ['logs', NET], { encoding: 'utf8' }); return `${r.stdout}\n${r.stderr}`; };
const sql = (db, text) => docker('exec', `${NET}-db`, 'psql', '-U', 'postgres', '-d', db, '-tAqc', text);
const plain = (t) => String(t ?? '').replace(/[⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();

const LIB = mkdtempSync(join(tmpdir(), 'uchi-e2e-630-lib-'));

function down() {
  for (const c of [NET, `${NET}-db`, `${NET}-idp`]) quiet('rm', '-f', c);
  quiet('network', 'rm', NET);
}

async function upBase() {
  down();
  docker('network', 'create', '--subnet', SUBNET, NET);
  docker('run', '-d', '--name', `${NET}-db`, '--network', NET, '-e', 'POSTGRES_PASSWORD=e2e', '-e', 'POSTGRES_DB=yomi', 'postgres:16-alpine');
  docker('run', '-d', '--name', `${NET}-idp`, '--network', NET, '-p', `127.0.0.1:${IDP_PORT}:${IDP_PORT}`, '-v', `${HERE}:/e2e:ro`,
    'node:24-alpine', 'node', '/e2e/fakeIdp.mjs', '--port', String(IDP_PORT), '--internal', `http://${NET}-idp:${IDP_PORT}`, '--browser', IDP);
  await waitFor(async () => { try { docker('exec', `${NET}-db`, 'pg_isready', '-q', '-h', '127.0.0.1'); return true; } catch { return false; } }, 60_000, 1000);
  await waitFor(async () => (await fetch(`${IDP}/.well-known/openid-configuration`).catch(() => null))?.ok, 30_000);
}

/** The app, started again with this environment on this database. */
async function app(env, db = 'yomi') {
  quiet('rm', '-f', NET);
  const base = {
    DATABASE_URL: `postgres://postgres:e2e@${NET}-db:5432/${db}`, JWT_SECRET: 'e2e-secret-at-least-16-chars', LIBRARY_BACKEND: 'owned',
    PUBLIC_ORIGIN: BASE, OIDC_ISSUER: `http://${NET}-idp:${IDP_PORT}`, OIDC_CLIENT_ID: 'uchiyomi-e2e', OIDC_NAME: 'Authentik',
    OIDC_ADMIN_GROUP: 'uchi-admins', OIDC_ALLOW_SIGNUP: 'true', PUID: String(process.getuid()), PGID: String(process.getgid()),
  };
  const flags = Object.entries({ ...base, ...env }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  docker('run', '-d', '--name', NET, '--network', NET, '-p', `127.0.0.1:${PORT}:3000`, ...flags, '-v', `${LIB}:/library`, IMAGE);
  const up = await waitFor(async () => (await fetch(`${BASE}/healthz`).catch(() => null))?.ok, 120_000, 1000);
  if (!up) throw new Error(`the app did not come up: ${docker('logs', '--tail', '30', NET)}`);
}

const as = (who) => fetch(`${IDP}/__as`, { method: 'POST', body: JSON.stringify(who) });
let shotNo = 0;
const shot = (p, name) => p.screenshot({ path: `${OUT}/${String(++shotNo).padStart(2, '0')}-${name}.png` });

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
const consoleErrors = [];
let phase = 'start';
const contexts = [];
/** Close every page before the app starts again: one left open would keep asking the next server as the last one's account. */
const closeAll = async () => { for (const c of contexts.splice(0)) await c.close().catch(() => {}); };
/** A page in a context of its own: a browser nobody has signed in on. */
async function fresh(width = 1280) {
  const ctx = await browser.createBrowserContext();
  contexts.push(ctx);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => consoleErrors.push(`[${phase}] ${String(e).slice(0, 180)}`));
  p.on('console', (m) => { if (m.type() === 'error' && !/401|404|409|429/.test(m.text())) consoleErrors.push(`[${phase}] ${m.text().slice(0, 180)}`); });
  p.on('response', (r) => { if (r.status() === 403) consoleErrors.push(`[${phase}] 403 ${r.request().method()} ${r.url()}`); });
  await p.setViewport({ width, height: width > 500 ? 900 : 844, deviceScaleFactor: width > 500 ? 1 : 2 });
  await p.setBypassServiceWorker(true);
  return p;
}
const text = (p) => p.evaluate(() => document.body.innerText).then(plain);
/** Press the provider's button and land wherever the round trip ends. */
async function viaProvider(p) {
  await p.waitForSelector('a[href="/auth/oidc/start"]', { timeout: 20_000 });
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30_000 }).catch(() => {}), p.click('a[href="/auth/oidc/start"]')]);
  await sleep(1500);
}

try {
  await upBase();

  // ---- 1. local mode: setup, then a link to the provider ----
  phase = 'local';
  await app({});
  const p1 = await fresh();
  await p1.goto(BASE, { waitUntil: 'networkidle2', timeout: 60_000 });
  await p1.waitForSelector('form input[autocomplete="username"]', { timeout: 20_000 }).catch(() => {});
  const inputs = await p1.$$('form input');
  check(inputs.length >= 3, 'a new local server shows its setup form', `${inputs.length} inputs`);
  await inputs[0].type('owner');
  await inputs[1].type(PASS);
  await inputs[2].type(PASS);
  await Promise.all([p1.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30_000 }).catch(() => {}), p1.keyboard.press('Enter')]);
  await waitFor(async () => !(await p1.$('form input[type=password]')), 20_000);
  await p1.goto(`${BASE}/profile/?tab=Account`, { waitUntil: 'networkidle2' });
  const link = await waitFor(() => p1.$('[data-sso-link]'), 15_000);
  check(!!link, 'Profile → Account offers Link to Authentik');
  await as({ sub: 'owner-sub', preferred_username: 'owner-at-idp', groups: ['uchi-admins'] });
  await Promise.all([p1.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30_000 }).catch(() => {}), p1.click('[data-sso-link]')]);
  const toast = await waitFor(async () => /Linked to Authentik\. You can sign in with it now\./.test(await text(p1)), 10_000);
  check(!!toast, 'back on the profile, it says the link worked');
  check(!new URL(p1.url()).searchParams.has('sso_link'), 'the result left the address once said');
  await shot(p1, 'linked-toast');
  check(sql('yomi', `SELECT oidc_sub FROM users WHERE username = 'owner'`) === 'owner-sub', 'the account is linked to its identity at the provider');
  await p1.reload({ waitUntil: 'networkidle2' });
  check(/You can sign in with Authentik\./.test(await text(p1)) && !(await p1.$('[data-sso-link]')), 'a linked account says so, with no link to press');

  // ---- 2. SSO-only mode on the same server ----
  phase = 'sso-only';
  await closeAll();
  await app({ AUTH_MODE: 'oidc-only' });
  for (const width of [1280, 390]) {
    const p = await fresh(width);
    await p.goto(BASE, { waitUntil: 'networkidle2', timeout: 60_000 });
    const card = await waitFor(() => p.$('[data-sso-only]'), 20_000);
    check(!!card, `the sign-in screen is the provider's card (${width})`);
    check(!(await p.$('input[type=password]')), `and asks for no password (${width})`);
    check(/This server signs in through Authentik only\./.test(await text(p)), `and says why (${width})`);
    await shot(p, `sso-only-${width}`);
  }
  const p2 = await fresh();
  await p2.goto(BASE, { waitUntil: 'networkidle2' });
  await as({ sub: 'owner-sub', preferred_username: 'owner-at-idp', groups: ['uchi-admins'] });
  await viaProvider(p2);
  check(!(await p2.$('[data-sso-only]')) && new URL(p2.url()).pathname === '/', 'the linked admin signs in through the provider', p2.url());
  await p2.goto(`${BASE}/admin/?tab=Members`, { waitUntil: 'networkidle2' });
  const accounts = await waitFor(() => p2.$('[data-sso-accounts]'), 15_000);
  check(!!accounts, 'Members says where accounts come from');
  const members = await text(p2);
  check(/Anyone Authentik lets in gets an account/.test(members), 'and that sign-up is on');
  check(!(await p2.evaluate(() => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reset'))), 'Members offers no password reset');
  check(!(await p2.evaluate(() => [...document.querySelectorAll('h2')].some((h) => h.textContent?.trim() === 'New account'))), 'Members offers no New account');
  const own = await p2.evaluate(() => [...document.querySelectorAll('p')].map((e) => e.textContent ?? '').find((t) => / · you/.test(t)) ?? '');
  check(/· Authentik$/.test(plain(own)), 'the admin\'s row is marked as linked to Authentik', own);
  await shot(p2, 'members');
  await p2.goto(`${BASE}/profile/?tab=Account`, { waitUntil: 'networkidle2' });
  await waitFor(async () => /Signed in as/.test(await text(p2)), 10_000);
  const account = await text(p2);
  check(!/Change password/.test(account) && !(await p2.$('#two-factor')), 'the profile has no password and no two-factor to manage');
  check(/You can sign in with Authentik\./.test(account), 'and says the account signs in with Authentik');
  await shot(p2, 'profile');
  await p2.goto(`${BASE}/admin/?tab=Settings&cat=server`, { waitUntil: 'networkidle2' });
  await waitFor(async () => /Server name/.test(await text(p2)), 15_000);
  check(!/Open registration/.test(await text(p2)), 'Admin → Settings offers no Open registration');
  // Someone new: an account at their first sign-in.
  const p3 = await fresh();
  await p3.goto(BASE, { waitUntil: 'networkidle2' });
  await as({ sub: 'reader-sub', preferred_username: 'reader', groups: [] });
  await viaProvider(p3);
  check(sql('yomi', `SELECT role FROM users WHERE oidc_sub = 'reader-sub'`) === 'user', 'someone new gets a member\'s account at their first sign-in');
  check(sql('yomi', `SELECT role FROM users WHERE username = 'owner'`) === 'admin', 'the admin is still one');
  // Nothing here takes a password: the routes are not there.
  const status = (await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: PASS }) })).status;
  check(status === 404, 'password sign-in is not there', `POST /auth/login answered ${status}`);

  // ---- 3. the rescue ----
  phase = 'rescue';
  await closeAll();
  await app({ AUTH_MODE: 'oidc-only', AUTH_RESCUE_ADMIN: 'owner' });
  check(/password sign-in is OPEN for the admin "owner"/.test(logs()), 'the start says the rescue is open');
  const p4 = await fresh();
  await p4.goto(BASE, { waitUntil: 'networkidle2' });
  const note = await waitFor(() => p4.$('[data-sso-rescue]'), 15_000);
  check(!!note, 'the password form is back, saying why');
  await shot(p4, 'rescue');
  const fields = await p4.$$('form input');
  await fields[0].type('owner');
  await fields[1].type(PASS);
  await p4.keyboard.press('Enter');
  check(!!(await waitFor(async () => !(await p4.$('form input[type=password]')), 20_000)), 'the admin signs in with the password');
  check(!!(await waitFor(() => /rescue sign-in by the admin \\?"owner/.test(logs()), 10_000, 500)), 'the rescue sign-in is in the log');

  // ---- 4. a new server's first admin ----
  phase = 'bootstrap';
  await closeAll();
  sql('yomi', 'CREATE DATABASE yomi2');
  await app({ AUTH_MODE: 'oidc-only', OIDC_BOOTSTRAP_ADMIN_SUB: 'first-sub' }, 'yomi2');
  const p5 = await fresh();
  await p5.goto(BASE, { waitUntil: 'networkidle2' });
  await waitFor(() => p5.$('[data-sso-only]'), 20_000);
  await as({ sub: 'early-sub', preferred_username: 'early', groups: ['uchi-admins'] });
  await viaProvider(p5);
  check(/This server isn’t set up yet: its admin signs in first\./.test(await text(p5)), 'anyone else first is told the server is not set up');
  check(/by the subject \\?"early-sub\\?", is not this server's first admin/.test(logs()), 'and the log names their subject');
  check(sql('yomi2', 'SELECT count(*) FROM users') === '0', 'and gets no account');
  await shot(p5, 'not-set-up');
  await as({ sub: 'first-sub', preferred_username: 'first', groups: [] });
  await viaProvider(p5);
  check(sql('yomi2', `SELECT role FROM users WHERE oidc_sub = 'first-sub'`) === 'admin', 'the named subject\'s first sign-in makes the admin');
} catch (e) {
  bad(`${phase}: ${e?.stack || e}`);
} finally {
  await browser.close();
  down();
  rmSync(LIB, { recursive: true, force: true });
}
if (consoleErrors.length) { console.log('console errors:'); for (const e of consoleErrors) console.log(`  ${e}`); }
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
process.exit(failures.length ? 1 : 0);
