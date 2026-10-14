// The new-member defaults' browser walk (#208, item 6): Admin → Members → When someone signs up, on the all-in-one
// image with a fake provider (fakeIdp.mjs). It brings up a network, a database, the provider and the app of its own,
// switches the app between sign-in modes by starting it again, and takes everything down at the end.
//
//   docker build -f Dockerfile.aio -t uchiyomi:e2e-defaults .             (from the repo)
//   IMAGE=uchiyomi:e2e-defaults node test/e2e/memberDefaultsWalk.mjs      (from web/)
//
// 1. Local mode, Open registration off and the provider making no accounts: the card offers a member card's three chips,
//    each saying a new member gets everything, and says nobody can sign up.
// 2. The provider making accounts and Open registration on: the card says so, and its chips set no downloads, the Kids
//    library and 10+. Someone who signs up on the sign-in screen, and someone who signs in through the provider for the
//    first time, start with them, and their cards say so. Someone the provider makes an admin carries them unseen, and
//    has them once a sign-in outside the admin group makes them a member.
// 3. Arabic, on a phone and a laptop: the card reads right to left and fits, with a panel open.
// 4. SSO-only mode: the chips are on the New accounts card, and a first sign-in starts with them.
import puppeteer from 'puppeteer';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const IMAGE = process.env.IMAGE || 'uchiyomi:e2e-defaults';
const NET = process.env.E2E_NET || 'uchi-e2e-defaults';
const SUBNET = process.env.E2E_SUBNET || '10.222.64.0/24';
const PORT = Number(process.env.E2E_PORT || 18164);
const IDP_PORT = Number(process.env.E2E_IDP_PORT || 28640);
const BASE = `http://127.0.0.1:${PORT}`;
const IDP = `http://127.0.0.1:${IDP_PORT}`;
const OUT = process.env.OUT || 'shots-defaults';
const PASS = 'owner-passw0rd-1';
const KIDS = 'lib_0e2e0e2e0e2e0e01';
const TEENS = 'lib_0e2e0e2e0e2e0e02';
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
const sql = (text) => docker('exec', `${NET}-db`, 'psql', '-U', 'postgres', '-d', 'yomi', '-tAqc', text);
const plain = (t) => String(t ?? '').replace(/[⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
/** What an account starts with, as the database holds it: its grant rows, its age limit and its permissions. */
const startsWith = (username) => sql(`SELECT coalesce(string_agg(ul.library_id, ',' ORDER BY ul.library_id), '-') || ' ' || coalesce(u.max_age_rating::text, '-') || ' ' || u.perms::text
  FROM users u LEFT JOIN user_libraries ul ON ul.user_id = u.id WHERE u.username = '${username}' GROUP BY u.id`);
const DEFAULTS = `${KIDS} 10 {"canDownload": false}`;

const LIB = mkdtempSync(join(tmpdir(), 'uchi-e2e-defaults-lib-'));

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

/** The app, started again with this environment. */
async function app(env) {
  quiet('rm', '-f', NET);
  const base = {
    DATABASE_URL: `postgres://postgres:e2e@${NET}-db:5432/yomi`, JWT_SECRET: 'e2e-secret-at-least-16-chars', LIBRARY_BACKEND: 'owned',
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
const shot = (p, name) => p.screenshot({ path: `${OUT}/${String(++shotNo).padStart(2, '0')}-${name}.png`, fullPage: true });

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
  p.on('response', (r) => { if (r.status() === 403 || r.status() >= 500) consoleErrors.push(`[${phase}] ${r.status()} ${r.request().method()} ${r.url()}`); });
  await p.setViewport({ width, height: width > 500 ? 900 : 844, deviceScaleFactor: width > 500 ? 1 : 2 });
  await p.setBypassServiceWorker(true);
  return p;
}
const text = (p, sel = 'body') => p.$eval(sel, (e) => e.innerText).then(plain).catch(() => '');
/** Press the provider's button and land wherever the round trip ends. */
async function viaProvider(p) {
  await p.waitForSelector('a[href="/auth/oidc/start"]', { timeout: 20_000 });
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30_000 }).catch(() => {}), p.click('a[href="/auth/oidc/start"]')]);
  await sleep(1500);
}
/** Sign in on the password form. */
async function signIn(p, username) {
  await p.goto(BASE, { waitUntil: 'networkidle2', timeout: 60_000 });
  await p.waitForSelector('form input[type=password]', { timeout: 20_000 });
  const fields = await p.$$('form input');
  await fields[0].type(username);
  await fields[1].type(PASS);
  await p.keyboard.press('Enter');
  await waitFor(async () => !(await p.$('form input[type=password]')), 20_000);
}
/** A button inside `root` whose text is `label`, scrolled to the middle first (the phone's bottom bar covers the foot). */
async function press(p, root, label) {
  const ok = await p.evaluate((root, label) => {
    const b = [...document.querySelectorAll(`${root} button`)].find((x) => x.textContent?.replace(/[⁦-⁩]/g, '').trim() === label);
    if (!b) return false;
    b.scrollIntoView({ block: 'center' });
    b.click();
    return true;
  }, root, label);
  if (!ok) throw new Error(`no "${label}" button in ${root}`);
  await sleep(400);
}
/** The checkbox in `root` whose label starts with `label`: the one panel that is open says All libraries or No age limit. */
async function tick(p, root, label) {
  const ok = await p.evaluate((root, label) => {
    const l = [...document.querySelectorAll(`${root} label`)].find((x) => x.textContent?.trim().startsWith(label));
    const c = l?.querySelector('input[type=checkbox]');
    if (!c) return false;
    c.scrollIntoView({ block: 'center' });
    c.click();
    return true;
  }, root, label);
  if (!ok) throw new Error(`no "${label}" checkbox in ${root}`);
  await sleep(400);
}
const chips = (p, root) => p.$$eval(`${root} > button`, (bs) => bs.map((b) => b.textContent?.replace(/[⁦-⁩]/g, '').trim()));
const stored = () => sql(`SELECT coalesce(array_to_string(new_member_libraries, ','), '-') || ' ' || coalesce(new_member_max_age_rating::text, '-') || ' ' || new_member_perms::text FROM server_settings WHERE id = 1`);
const overflows = (p) => p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
const CARD = '[data-member-defaults]';

try {
  await upBase();

  // ---- 1. local mode, nobody joins on their own ----
  phase = 'local, closed';
  await app({ OIDC_ALLOW_SIGNUP: 'false' });
  const p1 = await fresh();
  await p1.goto(BASE, { waitUntil: 'networkidle2', timeout: 60_000 });
  await p1.waitForSelector('form input[autocomplete="username"]', { timeout: 20_000 }).catch(() => {});
  const inputs = await p1.$$('form input');
  await inputs[0].type('owner');
  await inputs[1].type(PASS);
  await inputs[2].type(PASS);
  await Promise.all([p1.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30_000 }).catch(() => {}), p1.keyboard.press('Enter')]);
  await waitFor(async () => !(await p1.$('form input[type=password]')), 20_000);
  for (const [id, name] of [[KIDS, 'Kids'], [TEENS, 'Teens']]) sql(`INSERT INTO libraries (id, name, path) VALUES ('${id}', '${name}', '${name.toLowerCase()}')`);
  // Linked to the provider now, for SSO-only mode in part 4.
  await p1.goto(`${BASE}/profile/?tab=Account`, { waitUntil: 'networkidle2' });
  await waitFor(() => p1.$('[data-sso-link]'), 15_000);
  await as({ sub: 'owner-sub', preferred_username: 'owner-at-idp', groups: ['uchi-admins'] });
  await Promise.all([p1.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30_000 }).catch(() => {}), p1.click('[data-sso-link]')]);
  check(sql(`SELECT oidc_sub FROM users WHERE username = 'owner'`) === 'owner-sub', 'the admin is linked to the provider');
  await p1.goto(`${BASE}/admin/?tab=Members`, { waitUntil: 'networkidle2' });
  check(!!(await waitFor(() => p1.$(CARD), 15_000)), 'Members has the new-member card');
  const closed = await text(p1);
  check(/When someone signs up/.test(closed) && /A member who signs up starts with these\./.test(closed), 'it says what it is for');
  check(/Nobody can sign up right now: Open registration is off in Settings\./.test(closed), 'and that nobody can sign up');
  check(/Existing accounts, and accounts you make here, are not affected\./.test(closed), 'and what it leaves alone');
  const first = await chips(p1, CARD);
  check(first.join(' | ') === 'Can download | All libraries | Any age rating', 'its chips say a new member gets everything', first.join(' | '));
  check(!(await p1.$(`form ${CARD}`)), 'it is not part of the New account form');
  await shot(p1, 'local-closed');

  // ---- 2. people join: set the defaults through the chips, then join two ways ----
  phase = 'local, open';
  await closeAll();
  sql('UPDATE server_settings SET allow_registration = true WHERE id = 1');
  await app({});
  const p2 = await fresh();
  await signIn(p2, 'owner');
  await p2.goto(`${BASE}/admin/?tab=Members`, { waitUntil: 'networkidle2' });
  await waitFor(() => p2.$(CARD), 15_000);
  const open = await text(p2);
  check(/A member who signs up, or signs in with Authentik for the first time, starts with these\./.test(open), 'it names the provider that makes accounts');
  check(!/Nobody can sign up right now/.test(open), 'and no longer says nobody can sign up');
  await press(p2, CARD, 'Can download');
  check(!!(await waitFor(async () => (await chips(p2, CARD)).includes('No downloads'))), 'Can download turns to No downloads');
  await press(p2, CARD, 'All libraries');
  // Enabled once the list of libraries has loaded: unticked over an empty list, it would save none.
  await waitFor(() => p2.$(`${CARD} input[type=checkbox]:not([disabled])`), 10_000);
  await tick(p2, CARD, 'All libraries');
  await waitFor(async () => (await chips(p2, CARD)).includes('Teens'), 10_000);
  await press(p2, CARD, 'Teens');
  await waitFor(() => /,/.test(stored().split(' ')[0]) && !stored().includes(TEENS), 10_000);
  await press(p2, CARD, 'Library');
  check(!!(await waitFor(() => stored().startsWith(`${KIDS} `), 10_000)), 'the Kids library alone is a default', stored());
  await press(p2, CARD, '1 library');
  check((await p2.$$(`${CARD} input[type=checkbox]`)).length === 0, 'the libraries panel closes again');
  await press(p2, CARD, 'Any age rating');
  await waitFor(() => p2.$(`${CARD} input[type=checkbox]`), 10_000);
  await tick(p2, CARD, 'No age limit');
  await waitFor(async () => (await chips(p2, CARD)).includes('10+'), 10_000);
  await press(p2, CARD, '10+');
  check(!!(await waitFor(() => stored() === DEFAULTS, 10_000)), 'and so are 10+ and no downloads', stored());
  await shot(p2, 'local-set');
  const lit = await p2.$$eval(`${CARD} > button.chip-active`, (bs) => bs.length);
  check(lit === 3, 'all three chips are lit, each less than everything', `${lit} lit`);

  // Someone signs up on the sign-in screen.
  const p3 = await fresh();
  await p3.goto(BASE, { waitUntil: 'networkidle2' });
  await p3.waitForSelector('form input[type=password]', { timeout: 20_000 });
  await press(p3, 'form', 'Create an account');
  await waitFor(async () => (await p3.$$('form input')).length >= 3, 10_000);
  const signup = await p3.$$('form input');
  await signup[0].type('kid');
  await signup[1].type(PASS);
  await signup[2].type(PASS);
  await p3.keyboard.press('Enter');
  await waitFor(async () => !(await p3.$('form input[type=password]')), 20_000);
  check(startsWith('kid') === DEFAULTS, 'someone who signs up starts with the defaults', startsWith('kid'));
  // From their very first page: the libraries they are offered are the Kids library alone.
  const libs = await p3.evaluate(async () => {
    const { accessToken } = await (await fetch('/auth/refresh', { method: 'POST' })).json();
    const r = await fetch('/api/libraries', { headers: { authorization: `Bearer ${accessToken}` } });
    const body = await r.json();
    return (body.content ?? body).map((l) => l.name).join(',');
  });
  check(libs === 'Kids', 'and sees the Kids library alone', libs);
  // Someone signs in through the provider for the first time, and someone the provider makes an admin.
  for (const who of [{ sub: 'reader-sub', preferred_username: 'reader', groups: [] }, { sub: 'boss-sub', preferred_username: 'boss', groups: ['uchi-admins'] }]) {
    const p = await fresh();
    await p.goto(BASE, { waitUntil: 'networkidle2' });
    await as(who);
    await viaProvider(p);
  }
  check(startsWith('reader') === DEFAULTS, 'a first sign-in through the provider starts with them too', startsWith('reader'));
  check(sql(`SELECT role FROM users WHERE username = 'boss'`) === 'admin' && startsWith('boss') === DEFAULTS,
    'one the provider makes an admin carries them, for the day it is a member', startsWith('boss'));
  await p2.reload({ waitUntil: 'networkidle2' });
  await waitFor(async () => /@kid/.test(await text(p2)), 15_000);
  const kidCard = await p2.evaluate(() => {
    const card = [...document.querySelectorAll('.card')].find((c) => c.textContent?.includes('@kid'));
    return [...(card?.querySelectorAll('button') ?? [])].map((b) => b.textContent?.trim()).join(' | ');
  });
  check(/Allow downloads/.test(kidCard) && /1 library/.test(kidCard) && /10\+ and below/.test(kidCard), 'the new member\'s card says what they started with', kidCard);
  const bossCard = await p2.evaluate(() => {
    const card = [...document.querySelectorAll('.card')].find((c) => c.textContent?.includes('@boss'));
    return [...(card?.querySelectorAll('button') ?? [])].map((b) => b.textContent?.trim()).join(' | ');
  });
  check(!/downloads/i.test(bossCard), 'an admin\'s card offers no downloads chip: an admin downloads whatever it says', bossCard);
  await shot(p2, 'members-after');
  // Outside the admin group at the next sign-in: a member, with the defaults rather than everything.
  {
    const p = await fresh();
    await p.goto(BASE, { waitUntil: 'networkidle2' });
    await as({ sub: 'boss-sub', preferred_username: 'boss', groups: [] });
    await viaProvider(p);
  }
  check(sql(`SELECT role FROM users WHERE username = 'boss'`) === 'user' && startsWith('boss') === DEFAULTS,
    'made a member by the provider, it has the defaults', startsWith('boss'));

  // ---- 3. Arabic, on a phone and a laptop ----
  phase = 'arabic';
  sql(`UPDATE app_settings SET data = data || '{"lang":"ar"}' WHERE user_id = (SELECT id FROM users WHERE username = 'owner')`);
  for (const width of [390, 1280]) {
    const p = await fresh(width);
    await signIn(p, 'owner');
    await p.goto(`${BASE}/admin/?tab=Members`, { waitUntil: 'networkidle2' });
    await waitFor(() => p.$(CARD), 15_000);
    await waitFor(async () => /عندما يُنشئ أحدهم حسابه/.test(await text(p)), 10_000);
    check(await p.evaluate(() => document.documentElement.dir === 'rtl'), `the page is right to left (${width})`);
    check(/العضو الذي يُنشئ حسابه بنفسه، أو يسجّل الدخول عبر Authentik لأول مرة، يبدأ بهذه الإعدادات\./.test(await text(p)), `the card is in Arabic (${width})`);
    await p.evaluate((card) => { const b = document.querySelector(`${card} > button:nth-of-type(2)`); b.scrollIntoView({ block: 'center' }); b.click(); }, CARD);
    await sleep(800);
    check(!(await overflows(p)), `nothing runs off the side with the libraries open (${width})`);
    await p.evaluate((card) => document.querySelector(card).scrollIntoView({ block: 'start' }), CARD);
    await shot(p, `arabic-${width}`);
  }
  sql(`UPDATE app_settings SET data = data - 'lang' WHERE user_id = (SELECT id FROM users WHERE username = 'owner')`);
  const phone = await fresh(390);
  await signIn(phone, 'owner');
  await phone.goto(`${BASE}/admin/?tab=Members`, { waitUntil: 'networkidle2' });
  await waitFor(() => phone.$(CARD), 15_000);
  await press(phone, CARD, '10+ and below');
  check(!(await overflows(phone)), 'nothing runs off the side of a phone with the age limit open');
  await phone.evaluate((card) => document.querySelector(card).scrollIntoView({ block: 'start' }), CARD);
  await shot(phone, 'phone-390');

  // ---- 4. SSO-only mode ----
  phase = 'sso-only';
  await closeAll();
  await app({ AUTH_MODE: 'oidc-only' });
  const p4 = await fresh();
  await p4.goto(BASE, { waitUntil: 'networkidle2' });
  await as({ sub: 'owner-sub', preferred_username: 'owner-at-idp', groups: ['uchi-admins'] });
  await viaProvider(p4);
  await p4.goto(`${BASE}/admin/?tab=Members`, { waitUntil: 'networkidle2' });
  check(!!(await waitFor(() => p4.$(`[data-sso-accounts] ${CARD}`), 15_000)), 'the chips are on the New accounts card');
  check(/Each new member starts with these\. Existing accounts are not affected\./.test(await text(p4, '[data-sso-accounts]')), 'which says what they are');
  const ssoChips = await chips(p4, CARD);
  check(ssoChips.join(' | ') === 'No downloads | 1 library | 10+ and below', 'showing the same defaults', ssoChips.join(' | '));
  check(!/When someone signs up/.test(await text(p4)), 'and there is no sign-up card where nobody signs up with a form');
  await shot(p4, 'sso-only');
  const p5 = await fresh();
  await p5.goto(BASE, { waitUntil: 'networkidle2' });
  await as({ sub: 'sso-kid-sub', preferred_username: 'sso-kid', groups: [] });
  await viaProvider(p5);
  check(startsWith('sso-kid') === DEFAULTS, 'a first sign-in in SSO-only mode starts with them', startsWith('sso-kid'));
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
