// Browser acceptance walk for v0.57.0 — merging duplicate series keeps each chapter once, and the merge dialog says
// which copy to keep.
//
// Two fakes carry one series under two names, their chapters overlapping (fakeSource.mjs `--extra v57`): Merge Walk
// 1-6 on fake-a, Merge Walk Again 3-8 on fake-b. The walk adds both, reads chapter 4 of Merge Walk, links both to one
// AniList entry (so Health's Duplicate series pairs them) and switches fake-a off. Then:
//   1. Health → Duplicate series → Merge: the dialog shows each copy's chapters and its source with how it stands
//      (Turned off / Healthy), and Recommended -- pre-selected -- on Merge Walk Again, whose source works;
//   2. Merge: the done line names the 4 duplicate copies removed;
//   3. the survivor lists 1 to 8 once each, chapter 4 read (it was read in the copy that went); the absorbed series'
//      files for 3-6 are gone from disk, 1 and 2 still there (they moved);
//   4. no console errors along the way.
//
//   KEEP=1 E2E_NET=uchiyomi-e2e-570 E2E_PORT=18570 E2E_SUBNET=10.222.57.0/24 E2E_FAKE_EXTRA=v57 E2E_NO_WALK=1 bash web/test/e2e/up.sh
//   cd web && E2E_NET=uchiyomi-e2e-570 BASE=http://127.0.0.1:18570 node test/e2e/v570Walk.mjs
import puppeteer from 'puppeteer';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:18570';
const NET = process.env.E2E_NET || 'uchiyomi-e2e-570';
const USER = process.env.E2E_USER || 'e2e';
const PASS = process.env.E2E_PASS || 'e2e-passw0rd-123';
const WIDTH = Number(process.env.WIDTH || 1280);
const OUT = process.env.OUT || 'shots570';
mkdirSync(OUT, { recursive: true });

const failures = [];
const ok = (message) => console.log(`    [ ok ] ${message}`);
const bad = (message) => { failures.push(message); console.log(`    [FAIL] ${message}`); };
const check = (yes, pass, fail = pass) => (yes ? ok(pass) : bad(fail));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (fn, ms = 10_000, step = 250) => {
  const started = Date.now();
  let value;
  while (Date.now() - started < ms) { value = await fn(); if (value) return value; await sleep(step); }
  return value;
};
/** The stack's own database, as autofixWalk.mjs reads it. */
const sql = (text) => execFileSync('docker', ['exec', `${NET}-db`, 'psql', '-U', 'postgres', '-d', 'yomi', '-tAqc', text], { encoding: 'utf8' }).trim();
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
/** Is this path there inside the app container? */
const onDisk = (abs) => { try { execFileSync('docker', ['exec', NET, 'test', '-e', abs]); return true; } catch { return false; } };

let token = '';
async function api(path, init = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
    headers: { authorization: `Bearer ${token}`, ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const raw = await r.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
  return { status: r.status, body };
}

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
let phase = 'start';
let restoreFakeA = false;
try {
  const login = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) });
  if (!login.ok) throw new Error(`API login ${login.status}`);
  token = (await login.json()).accessToken;
  for (const id of ['fake-a', 'fake-b']) {
    await api(`/api/admin/sources/${id}/enable`, { method: 'POST' });
    await api(`/api/admin/sources/${id}/unblock`, { method: 'POST' });
  }

  // ---- the two copies, on disk ----
  phase = 'setup';
  for (const [source, sourceId] of [['fake-a', 'merge-walk'], ['fake-b', 'merge-again']]) {
    const add = await api('/api/sources/add', { json: { source, sourceId } });
    check(add.status === 200, `${sourceId} added`, `adding ${sourceId} answered ${add.status}: ${JSON.stringify(add.body).slice(0, 200)}`);
  }
  const idOf = (title) => sql(`SELECT id FROM lib_series WHERE title = ${lit(title)} AND deleted_at IS NULL LIMIT 1`);
  const A = await waitFor(() => idOf('Merge Walk'), 30_000, 500);
  const B = await waitFor(() => idOf('Merge Walk Again'), 30_000, 500);
  const live = (id) => Number(sql(`SELECT count(*) FROM lib_books WHERE series_id = ${lit(id)} AND pruned_at IS NULL`));
  const landed = await waitFor(() => live(A) === 6 && live(B) === 6, 180_000, 1000);
  check(!!landed, 'both copies downloaded: 1-6 and 3-8', `Merge Walk ${live(A)}, Merge Walk Again ${live(B)} chapters`);
  // The absorbed copies' files, as the rows name them: 3-6 must go, 1 and 2 move and stay.
  const pathsOf = (numbers) => sql(`SELECT root || '/' || file FROM lib_books WHERE series_id = ${lit(A)} AND number IN (${numbers.join(',')}) ORDER BY number`).split('\n').filter(Boolean);
  const twice = pathsOf([3, 4, 5, 6]);
  const only = pathsOf([1, 2]);
  check(twice.length === 4 && twice.every(onDisk), 'the copies both have are on disk', `twice: ${JSON.stringify(twice)}`);
  // Chapter 4, read in the copy that will go.
  const four = sql(`SELECT id FROM lib_books WHERE series_id = ${lit(A)} AND number = 4`);
  const read = await api(`/api/books/${encodeURIComponent(four)}/progress`, { method: 'PUT', json: { page: 0, completed: true } });
  check(read.status === 200 || read.status === 204, 'chapter 4 of Merge Walk read', `progress answered ${read.status}`);
  // One AniList entry for both, checked: what Health's Duplicate series pairs by.
  sql(`INSERT INTO series_trackers (series_id, provider, external_id, checked_at) VALUES (${lit(A)}, 'anilist', 'walk-merge', now()), (${lit(B)}, 'anilist', 'walk-merge', now())
       ON CONFLICT (series_id, provider) DO UPDATE SET external_id = EXCLUDED.external_id, checked_at = now()`);
  const off = await api('/api/admin/sources/fake-a/disable', { method: 'POST' });
  restoreFakeA = true;
  check(off.status === 200, "Merge Walk's source switched off", `disable answered ${off.status}`);

  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: 900, deviceScaleFactor: 1 });
  await page.setBypassServiceWorker(true);
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/401|404|409|429/.test(m.text())) consoleErrors.push(`[${phase}] ${m.text().slice(0, 180)}`); });
  page.on('pageerror', (e) => consoleErrors.push(`[${phase}] ${String(e).slice(0, 180)}`));
  let shotNo = 0;
  const shot = (name) => page.screenshot({ path: `${OUT}/${String(++shotNo).padStart(2, '0')}-${name}.png` });

  phase = 'login';
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60_000 });
  await page.waitForSelector('input[type=password]', { timeout: 30_000 });
  await sleep(2500);
  const fields = await page.$$('input');
  await fields[0].type(USER);
  await page.type('input[type=password]', PASS);
  await page.keyboard.press('Enter');
  await waitFor(async () => !(await page.$('input[type=password]')), 20_000);
  check(!(await page.$('input[type=password]')), 'signed in');

  // ---- 1. the dialog ----
  phase = 'health';
  await page.goto(`${BASE}/admin/?tab=Health`, { waitUntil: 'networkidle2', timeout: 60_000 });
  /** The Merge key on the duplicates row that names Merge Walk. */
  const mergeKey = () => page.evaluateHandle(() => [...document.querySelectorAll('[data-health-action="merge"]')].find((b) => {
    for (let el = b, i = 0; el && i < 8; el = el.parentElement, i++) if ((el.textContent || '').includes('Merge Walk')) return true;
    return false;
  }) || null);
  const key = await waitFor(async () => (await mergeKey()).asElement(), 60_000, 1000);
  check(!!key, 'Health pairs the two copies, with a Merge key');
  if (!key) throw new Error('no Merge key for Merge Walk');
  await key.click();
  const dialogText = () => page.evaluate(() => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].map((d) => d.textContent || '').join(' | '));
  const shown = await waitFor(async () => { const t = await dialogText(); return t.includes('Merge these two?') ? t : null; }, 10_000);
  check(!!shown, 'the dialog opens');
  check(/6 chapters[\s\S]*6 chapters/.test(shown || ''), 'it shows each copy\'s chapters', `dialog: ${(shown || '').slice(0, 400)}`);
  check(/Turned off/.test(shown || '') && /Healthy/.test(shown || ''), 'and how each copy\'s source is doing', `dialog: ${(shown || '').slice(0, 400)}`);
  check(/Recommended/.test(shown || ''), 'one copy is Recommended');
  check(/kept once/.test(shown || ''), 'it says a chapter both have is kept once');
  // The copy recommended -- and pre-selected -- is the one whose source works.
  const picked = await page.evaluate(() => {
    const dlg = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].find((d) => (d.textContent || '').includes('Merge these two?'));
    const label = [...(dlg?.querySelectorAll('label') || [])].find((l) => l.querySelector('input[type=radio]')?.checked);
    return label ? { text: (label.textContent || '').trim(), recommended: /Recommended/.test(label.textContent || '') } : null;
  });
  check(!!picked && /Merge Walk Again/.test(picked.text) && picked.recommended, 'Merge Walk Again is recommended and picked', `picked: ${JSON.stringify(picked)}`);
  await shot('merge-dialog');

  // ---- 2. merge ----
  phase = 'merge';
  const confirm = await page.evaluateHandle(() => {
    const dlg = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].find((d) => (d.textContent || '').includes('Merge these two?'));
    return [...(dlg?.querySelectorAll('button') || [])].find((b) => (b.textContent || '').trim() === 'Merge') || null;
  });
  if (!confirm.asElement()) throw new Error('no Merge button in the dialog');
  await confirm.asElement().click();
  const said = await waitFor(async () => {
    const t = await page.evaluate(() => document.body.innerText || '');
    return /4 duplicate copies removed/.test(t) ? t : null;
  }, 30_000, 500);
  check(!!said, 'the done line names the 4 duplicate copies removed');
  await shot('merged');

  // ---- 3. one copy each ----
  phase = 'after';
  const merged = sql(`SELECT merged_into FROM lib_series WHERE id = ${lit(A)}`);
  check(merged === B, 'Merge Walk went into Merge Walk Again', `merged_into: ${merged}`);
  const counts = sql(`SELECT number::int || ':' || count(*) FROM lib_books WHERE series_id = ${lit(B)} AND pruned_at IS NULL GROUP BY number ORDER BY number`).split('\n').filter(Boolean);
  check(JSON.stringify(counts) === JSON.stringify(['1:1', '2:1', '3:1', '4:1', '5:1', '6:1', '7:1', '8:1']), 'the survivor lists 1 to 8 once each', `counts: ${JSON.stringify(counts)}`);
  const fourRead = sql(`SELECT bool_or(rp.completed) FROM read_progress rp JOIN lib_books b ON b.id = rp.book_id WHERE b.series_id = ${lit(B)} AND b.number = 4`);
  check(fourRead === 't', 'chapter 4 reads as read: what was read of the copy that went moved onto the one that stayed', `read: ${fourRead}`);
  check(twice.every((p) => !onDisk(p)), "the absorbed copies' files for 3-6 are gone", `left: ${JSON.stringify(twice.filter(onDisk))}`);
  check(only.every(onDisk), 'chapters 1 and 2 moved and are still on disk');
  // The series page, as a reader sees it: one row per chapter.
  await page.goto(`${BASE}/series/?id=${encodeURIComponent(B)}`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await sleep(1500);
  await shot('series');

  check(consoleErrors.length === 0, 'no console errors along the way', `console: ${consoleErrors.join(' | ')}`);
} catch (e) {
  bad(`[${phase}] ${e?.stack || e}`);
} finally {
  if (restoreFakeA) await api('/api/admin/sources/fake-a/enable', { method: 'POST' }).catch(() => {});
  await browser.close();
}
console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall ok');
process.exit(failures.length ? 1 : 0);
