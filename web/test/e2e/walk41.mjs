// Browser acceptance walk for v0.41.0 — the Health page that fixes itself, and the nightly Repair task.
//
// Run against a kept web/test/e2e/up.sh instance at WIDTH=1280 and WIDTH=390, on an instance of its own:
// like walk40.mjs it adds series and leaves them there, and the two walks want the SAME title in different
// states, so they cannot share one database. One browser login and one API login, every verdict printed as
// [ ok ]/[FAIL], screenshots under OUT, exit 1 if any contract, source-load bound or console check fails.
//
// The order of the steps is not the order of the plan, and this is the one thing to know before editing it.
// Step 5 (a chapter the source refuses across two sweeps is hunted on the third) needs fake-b NOT to be a
// follower of Walk Tale: a followed source is tried as an ordinary alternate long before any hunt, so the
// ledger would never reach two refusals. It also has to run before any "Fix" chip, because a chip's hunt is
// FORCED and still stamps `lib_series.source_hunt_at`, and the sweep's own hunt is not forced — it would
// find the stamp and stand down for a day. So: 1 (short chapters are found) → 5 (the persistent refusal) →
// 2 and 3 (Fix and It's fine) → 4 (the gap) → 6 and 7 (the task, its line and its switch).
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:18140';
const USER = process.env.E2E_USER || 'e2e';
const PASS = process.env.E2E_PASS || 'e2e-passw0rd-123';
const appPort = Number(new URL(BASE).port || 80);
const fakePort = 20_000 + (appPort % 1000) * 2;
const STUB_A = process.env.FAKE_A_URL || `http://127.0.0.1:${fakePort}`;
const STUB_B = process.env.FAKE_B_URL || `http://127.0.0.1:${fakePort + 1}`;
const WIDTH = Number(process.env.WIDTH || 1280);
const PHONE = WIDTH < 600;
const OUT = process.env.OUT || 'shots41';
mkdirSync(OUT, { recursive: true });

const failures = [];
const ok = (message) => console.log(`    [ ok ] ${message}`);
const bad = (message) => { failures.push(message); console.log(`    [FAIL] ${message}`); };
const check = (yes, pass, fail = pass) => yes ? ok(pass) : bad(fail);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (fn, ms = 10_000, step = 150) => {
  const started = Date.now(); let value;
  while (Date.now() - started < ms) { value = await fn(); if (value) return value; await sleep(step); }
  return value;
};

let apiToken = '';
async function api(path, init = {}) {
  const hasBody = init.json !== undefined || init.body !== undefined;
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiToken}`,
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
    body: init.json === undefined ? init.body : JSON.stringify(init.json),
  });
  const raw = await r.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
  if (!r.ok) throw Object.assign(new Error(`${path}: ${r.status} ${raw.slice(0, 200)}`), { status: r.status, body });
  return body;
}
async function control(base, path, body) {
  const r = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${base}${path}: ${r.status}`);
  return r.json();
}
const script = (base, chapter, page, behaviour) => control(base, '/__script', { chapter, page, behaviour });
const sourceLog = async (base) => (await control(base, '/__log')).content || [];
/** The rows of one route, for one chapter or series, that this stub served after `from`. */
const rowsSince = (rows, route, key, from) => rows.filter((r) => r.route === route && r.at >= from
  && (key === undefined || r.chapter === key || r.series === key));

// ---- library helpers ------------------------------------------------------------------------------
const seriesByTitle = async (title) => {
  const page = await api('/api/series/search', { method: 'POST', json: { query: title, size: 20 } });
  return page?.content?.find((row) => (row.metadata?.title || row.name) === title) || null;
};
const booksOf = async (id) => (await api(`/api/series/${id}/books?size=1000`).catch(() => null))?.content || [];
const bookNo = (books, n) => books.find((b) => Number(b.number ?? b.metadata?.numberSort) === n) || null;
/** Add from fake-a with no `alsoFollow`, so nothing is followed until this walk makes it happen. */
async function addFromA(sourceId, title, body = {}) {
  await api('/api/sources/add', { method: 'POST', json: { source: 'fake-a', sourceId, ...body } });
  const job = await waitFor(async () => {
    const jobs = await api('/api/sources/jobs').catch(() => null);
    return jobs?.content?.find((j) => j.title === title && j.status !== 'downloading') || null;
  }, 180_000, 500);
  return job;
}
const taskRow = async (id) => ((await api('/api/admin/tasks')).content || []).find((t) => t.id === id) || null;
const repairStamp = async () => (await taskRow('repair'))?.lastRun ?? 0;
/** Wait for a repair that finished after `since` and hand back its stored result. */
async function repairAfter(since, label, ms = 180_000) {
  const row = await waitFor(async () => {
    const t = await taskRow('repair');
    return t && !t.running && (t.lastRun ?? 0) > since ? t : null;
  }, ms, 400);
  if (!row) { bad(`${label}: no repair finished within ${Math.round(ms / 1000)}s`); return null; }
  return row.lastResult;
}
async function runRepair(json, label) {
  const since = await repairStamp();
  const started = await api('/api/admin/tasks/repair/run', { method: 'POST', json });
  check(started?.ok === true && started?.started === true, `${label}: the run started`, `${label}: the run answered ${JSON.stringify(started)}`);
  return repairAfter(since, label);
}
/** One sweep, run to completion, with fake-a's 429 cooldown cleared first so it is asked again. */
async function sweep(label) {
  await api('/api/admin/sources/fake-a/unblock', { method: 'POST' }).catch(() => {});
  const before = (await taskRow('update'))?.lastRun ?? 0;
  const started = await api('/api/admin/tasks/update/run', { method: 'POST', json: {} });
  if (started?.ok !== true) { bad(`${label}: the sweep answered ${JSON.stringify(started)}`); return; }
  const done = await waitFor(async () => {
    const t = await taskRow('update');
    return t && !t.running && (t.lastRun ?? 0) > before ? t : null;
  }, 180_000, 400);
  if (!done) bad(`${label}: the sweep did not finish`);
}
/** The ledger, as the series page reads it: the attempt count for one number nobody holds. */
async function ghostAttempts(seriesId, number) {
  const listing = await api(`/api/series/${seriesId}/listing`).catch(() => null);
  return listing?.content?.find((g) => Number(g.number) === number)?.attempts ?? 0;
}

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
let phase = 'start';
let shotNo = 0;
let restoreMangaDex = false;
try {
  const login = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (!login.ok) throw new Error(`API login ${login.status}`);
  apiToken = (await login.json()).accessToken;
  ok('one API login');

  await Promise.all([control(STUB_A, '/__reset', {}), control(STUB_B, '/__reset', {})]);
  await Promise.all(['fake-a', 'fake-b'].flatMap((id) => [
    api(`/api/admin/sources/${id}/enable`, { method: 'POST' }),
    api(`/api/admin/sources/${id}/unblock`, { method: 'POST' }),
  ]));
  // MangaDex is a real public source and has no place in a deterministic fake-source run; a hunt would
  // otherwise search it. Restored in finally, like walk40.
  await api('/api/admin/sources/mangadex/disable', { method: 'POST' });
  restoreMangaDex = true;
  // The nightly switch and the failure hunt are both on by default; assert it rather than assume, because
  // a kept instance somebody poked at would fail steps 5 and 7 for reasons that look like app bugs.
  await api('/api/admin/settings', { method: 'PATCH', json: { repairEnabled: true, autoFollowOnFailure: true } });

  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: PHONE ? 844 : 900, isMobile: PHONE, hasTouch: PHONE, deviceScaleFactor: 1 });
  await page.setBypassServiceWorker(true);
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !/401|404|409|429/.test(message.text())) consoleErrors.push(`[${phase}] ${message.text().slice(0, 180)}`);
  });
  page.on('pageerror', (error) => consoleErrors.push(`[${phase}] ${String(error).slice(0, 180)}`));
  const shot = (name) => page.screenshot({ path: `${OUT}/${String(++shotNo).padStart(2, '0')}-${PHONE ? 'phone' : 'desk'}-${name}.png` });
  const bodyText = () => page.evaluate(() => document.body.innerText || '');

  // ---- Health page helpers ------------------------------------------------------------------------
  const openHealth = async () => {
    await page.goto(`${BASE}/admin/?tab=Health`, { waitUntil: 'networkidle2', timeout: 60_000 });
    await waitFor(() => page.$('[data-health-check]'), 20_000);
  };
  /** Re-run the checks and wait for the button to come back, so the next read is of fresh items. */
  const recheck = async () => {
    const button = await page.evaluateHandle(() => [...document.querySelectorAll('button')]
      .find((b) => /^Re-check$/.test((b.textContent || '').trim())) || null);
    if (!button.asElement()) { bad('Health has no Re-check button'); return; }
    await button.asElement().click();
    await sleep(400);
    await waitFor(async () => !(await page.$eval('body', (el) => /Checking…/.test(el.innerText || ''))), 20_000);
  };
  /** Open one check's card (its disclosure is the FIRST button inside the card, as walk40 relies on too). */
  const openCheck = async (id) => {
    const first = await page.$(`[data-health-check="${id}"] button`);
    if (!first) { bad(`Health has no ${id} card`); return false; }
    if (!(await page.$(`#health-${id}-details`))) { await first.click(); await sleep(300); }
    return !!(await page.$(`#health-${id}-details`));
  };
  /**
   * The chip for ONE item: HealthActions renders a fragment straight into the item's row, so a chip's
   * parentElement IS its row and carries that row's title and detail. Matching on the row text is what
   * tells "Chapter 3 has 2 pages" from "Chapter 4 has 2 pages" inside one card.
   */
  const itemChip = async (checkId, action, re) => {
    const handle = await page.evaluateHandle((checkId, action, source) => {
      const rx = new RegExp(source, 'i');
      const card = document.querySelector(`[data-health-check="${checkId}"]`);
      if (!card) return null;
      return [...card.querySelectorAll(`button[data-health-action="${action}"]`)]
        .find((b) => rx.test(b.parentElement?.textContent || '')) || null;
    }, checkId, action, re.source);
    return handle.asElement();
  };
  const clickChip = async (checkId, action, re, label) => {
    const el = await itemChip(checkId, action, re);
    if (!el) { bad(`${label}: no ${action} chip on a row matching ${re}`); return false; }
    await el.evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await el.click();
    return true;
  };
  /** One item of one check, straight from the API — the shape the chips are built from. */
  const healthItem = async (checkId, re) => {
    const report = await api('/api/admin/health');
    const c = (report.checks || []).find((x) => x.id === checkId);
    return (c?.items || []).find((i) => re.test(`${i.title} ${i.detail}`)) || null;
  };

  // ---- browser login, once ------------------------------------------------------------------------
  phase = 'login';
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60_000 });
  await page.waitForSelector('input[type=password]', { timeout: 30_000 });
  const fields = await page.$$('input');
  await fields[0].type(USER); await page.type('input[type=password]', PASS); await page.keyboard.press('Enter');
  await waitFor(async () => !(await page.$('input[type=password]')), 20_000);
  check(!(await page.$('input[type=password]')), 'one browser login', 'browser login did not leave the form');

  // ---- the library this walk repairs --------------------------------------------------------------
  phase = 'add';
  // Walk Gap: fake-a does not list 6-8 at all, which is the hole the gap step goes looking for. Added
  // first, while fake-a is healthy — the 429 below puts it in a cooldown that would fail this add.
  await script(STUB_A, 'walk-gap', 0, 'omit:6-8');
  // Walk Tale chapters 3 and 4 arrive two pages long. Chapter 4 is short on BOTH stubs, so no source can
  // better it and the repair may prove it; chapter 3 is short only on fake-a, so a longer copy exists.
  await Promise.all([
    script(STUB_A, 3, 0, 'short:2'),
    script(STUB_A, 4, 0, 'short:2'),
    script(STUB_B, 4, 0, 'short:2'),
  ]);
  const gapJob = await addFromA('walk-gap', 'Walk Gap');
  check(gapJob?.done === 11, 'Walk Gap added with the eleven chapters fake-a lists', `Walk Gap job landed ${gapJob?.done ?? 'no'} of 11`);
  // Only the oldest nine, so 10-12 are still the sources' to serve and the sweep has something to fetch.
  const taleJob = await addFromA('walk-tale', 'Walk Tale', { chapterCount: 9, chapterFrom: 'oldest' });
  check(taleJob?.done === 9, 'Walk Tale added with its oldest nine chapters', `Walk Tale job landed ${taleJob?.done ?? 'no'} of 9`);

  const tale = await seriesByTitle('Walk Tale');
  const gap = await seriesByTitle('Walk Gap');
  check(!!tale && !!gap, 'both titles are in the library', `library search found tale=${!!tale} gap=${!!gap}`);
  const taleId = tale?.id, gapId = gap?.id;
  const taleBooks0 = taleId ? await booksOf(taleId) : [];
  const book3 = bookNo(taleBooks0, 3);
  const book4 = bookNo(taleBooks0, 4);
  check(!!book3 && !!book4, 'chapters 3 and 4 have rows', `rows: 3=${!!book3} 4=${!!book4}`);
  check(!(await api(`/api/series/${taleId}`)).sources?.some((s) => s.sourceId === 'fake-b'),
    'nothing is followed yet: the add did not ask for a second source', 'fake-b was followed by the add');

  // ---- 1. the count step, and the short chapters it makes visible ---------------------------------
  phase = 'count';
  check(Number(book3?.media?.pagesCount ?? 0) === 0 && Number(book4?.media?.pagesCount ?? 0) === 0,
    'a freshly downloaded chapter has no page count yet',
    `page counts straight after the add: 3=${book3?.media?.pagesCount} 4=${book4?.media?.pagesCount}`);
  const countRun = await runRepair({ only: ['count'] }, 'count');
  check(Array.isArray(countRun?.only) && countRun.only.length === 1 && countRun.only[0] === 'count',
    'the run reports the one step it was asked for', `only: ${JSON.stringify(countRun?.only)}`);
  check((countRun?.counted ?? 0) >= 20 && countRun?.uncounted === 0,
    `${countRun?.counted} page counts stamped, ${countRun?.uncounted} left to count`,
    `count step: counted=${countRun?.counted} uncounted=${countRun?.uncounted}`);
  const taleBooks1 = taleId ? await booksOf(taleId) : [];
  check(Number(bookNo(taleBooks1, 3)?.media?.pagesCount) === 2 && Number(bookNo(taleBooks1, 4)?.media?.pagesCount) === 2,
    'the count step stamped both two-page chapters',
    `after the count: 3=${bookNo(taleBooks1, 3)?.media?.pagesCount} 4=${bookNo(taleBooks1, 4)?.media?.pagesCount}`);

  await openHealth();
  check(await openCheck('short-chapters'), 'Health has a short-chapter card', 'Health did not expose the short-chapter card');
  const fix3 = await itemChip('short-chapters', 'fix_short', /Chapter 3 has 2 pages/);
  const fine3 = await itemChip('short-chapters', 'confirm_short', /Chapter 3 has 2 pages/);
  check(!!fix3 && !!fine3, 'chapter 3 is listed with Fix and It’s fine', `chapter 3 chips: fix=${!!fix3} confirm=${!!fine3}`);
  check(/It’s fine/.test(await fine3?.evaluate((n) => n.textContent) || ''), 'the confirm chip reads It’s fine before anything is confirmed',
    `confirm chip reads ${JSON.stringify(await fine3?.evaluate((n) => n.textContent))}`);
  await shot('health-short');

  // ---- 5. a chapter the source refuses twice is hunted on the third sweep --------------------------
  phase = 'failures';
  // Bare 429, so fake-a refuses chapter 10 however often it is asked — including after the resume waits.
  await script(STUB_A, 10, 0, '429');
  const searchesBefore = (await sourceLog(STUB_B)).filter((r) => r.route === 'search').length;
  await sweep('sweep 1');
  const after1 = taleId ? await ghostAttempts(taleId, 10) : 0;
  await sweep('sweep 2');
  const after2 = taleId ? await ghostAttempts(taleId, 10) : 0;
  check(after2 >= 2, `the ledger records ${after2} refusals of chapter 10`, `chapter 10 attempts after two sweeps: ${after1} then ${after2}`);
  const searchesMid = (await sourceLog(STUB_B)).filter((r) => r.route === 'search').length;
  check(searchesMid === searchesBefore, 'no hunt while one refusal could still be a busy site',
    `fake-b was searched ${searchesMid - searchesBefore} time(s) before the second refusal`);
  await sweep('sweep 3');
  const landed10 = await waitFor(async () => (taleId ? bookNo(await booksOf(taleId), 10) : null), 60_000, 500);
  check(!!landed10, 'the third sweep landed chapter 10', 'chapter 10 never landed');
  const taleSources = taleId ? (await api(`/api/series/${taleId}`)).sources || [] : [];
  const followedB = taleSources.find((s) => s.sourceId === 'fake-b');
  check(!!followedB && followedB.auto === true, 'the hunt followed fake-b for Walk Tale', `Walk Tale sources: ${JSON.stringify(taleSources)}`);
  check(followedB?.sourceSeriesId === 'walk-tale', 'it followed Walk Tale, not "Walk Tale: Next"',
    `followed series id: ${JSON.stringify(followedB?.sourceSeriesId)}`);
  const images10 = rowsSince(await sourceLog(STUB_B), 'image', 'walk-tale-10', 0);
  check(images10.length === 12, 'chapter 10 came from fake-b, whole', `fake-b served ${images10.length} images of chapter 10`);

  // ---- 2. Fix replaces a short chapter with a longer copy -----------------------------------------
  phase = 'fix';
  // ⚠️ Clear the cooldown the bare 429 left on fake-a first. A source in a cooldown is not asked by the
  // short step AND drops out of the listing refresh that step begins with, so its copy of chapter 3 would
  // not even be offered: the Fix would quietly measure one source instead of two, and chapter 4 would be
  // confirmed on fake-b's word alone. The walk is measuring the repair, not the cooldown step 5 left behind.
  await Promise.all(['fake-a', 'fake-b'].map((id) => api(`/api/admin/sources/${id}/unblock`, { method: 'POST' })));
  // A reader finished the two-page notice. USAGE promises the replacement leaves that mark alone.
  if (book3) await api(`/api/books/${book3.id}/progress`, { method: 'PUT', json: { page: 2, completed: true, seriesId: taleId } });
  const mark = Date.now();
  await openHealth();
  await openCheck('short-chapters');
  const since2 = await repairStamp();
  const pressed = await clickChip('short-chapters', 'fix_short', /Chapter 3 has 2 pages/, 'Fix');
  if (pressed) {
    // Only the success sentence passes. The two refusals ("A chapter sweep is running", "already running")
    // are matched as well so that a refused press is REPORTED as the refusal it was, rather than as a
    // missing toast — but they are not an acceptable answer here: nothing else is running at this point.
    const toast = await waitFor(async () => {
      const t = await bodyText();
      const m = /the Tasks line shows what it did|A chapter sweep is running|already running|Could not start the repair/i.exec(t);
      return m ? m[0] : '';
    }, 15_000);
    check(/the Tasks line shows what it did/i.test(toast || ''), 'Fix said where to look for the result',
      `Fix's toast was ${toast ? JSON.stringify(toast) : 'never shown'}`);
  }
  const fixRun = await repairAfter(since2, 'Fix');
  check(fixRun?.short?.replaced === 1 && fixRun?.short?.confirmed === 0,
    'the Fix replaced exactly one chapter and confirmed none', `short: ${JSON.stringify(fixRun?.short)}`);
  const pages3 = book3 ? await api(`/api/books/${book3.id}/pages`) : [];
  check(pages3?.length === 12, 'chapter 3 now has twelve pages', `chapter 3 page route returned ${pages3?.length ?? 'no'} pages`);
  const progress3 = book3 ? bookNo(await booksOf(taleId), 3)?.readProgress : null;
  check(progress3?.completed === true, 'the reader who finished the two-page notice is still finished',
    `reading progress after the replacement: ${JSON.stringify(progress3)}`);
  const [logA2, logB2] = await Promise.all([sourceLog(STUB_A), sourceLog(STUB_B)]);
  const pagesA3 = rowsSince(logA2, 'pages', 'walk-tale-3', mark);
  const pagesB3 = rowsSince(logB2, 'pages', 'walk-tale-3', mark);
  const imagesB3 = rowsSince(logB2, 'image', 'walk-tale-3', mark);
  // The bound of the short step, per book: each followed copy is asked for its page list ONCE, and only
  // the winner is downloaded (one more page list, then its images). Anything more is a repair that costs
  // the sites more than the plan says it may.
  check(pagesA3.length === 1 && pagesB3.length === 2 && imagesB3.length === 12,
    'one page list from each source, one download, twelve images — all from fake-b',
    `fake-a pages=${pagesA3.length} fake-b pages=${pagesB3.length} fake-b images=${imagesB3.length}`);
  check(rowsSince(logA2, 'image', 'walk-tale-3', mark).length === 0, 'the source that could not better it was never downloaded from',
    `fake-a served ${rowsSince(logA2, 'image', 'walk-tale-3', mark).length} images of chapter 3`);

  // ---- 3. It’s fine, proven by every source, and taken back when the file changes ------------------
  phase = 'confirm';
  await openHealth();
  await openCheck('short-chapters');
  const since3 = await repairStamp();
  const pressed4 = await clickChip('short-chapters', 'fix_short', /Chapter 4 has 2 pages/, 'Fix chapter 4');
  const confirmRun = pressed4 ? await repairAfter(since3, 'Fix chapter 4') : null;
  check(confirmRun?.short?.confirmed === 1 && confirmRun?.short?.replaced === 0,
    'no source has more than two pages of chapter 4, so it is marked confirmed short',
    `short: ${JSON.stringify(confirmRun?.short)}`);
  const item4 = await healthItem('short-chapters', /Chapter 4 has 2 pages/);
  check(item4?.info === true && /confirmed short at the source/i.test(item4?.fixed?.what || ''),
    'the chapter is greyed and says it is confirmed short at the source', `item: ${JSON.stringify(item4)}`);
  await recheck();
  await openCheck('short-chapters');
  const notFine = await itemChip('short-chapters', 'confirm_short', /Chapter 4 has 2 pages/);
  check(/Not fine/.test(await notFine?.evaluate((n) => n.textContent) || ''),
    'a confirmed chapter offers Not fine', `the confirmed row's chip reads ${JSON.stringify(await notFine?.evaluate((n) => n.textContent))}`);
  check(!(await itemChip('short-chapters', 'fix_short', /Chapter 4 has 2 pages/)),
    'a confirmed chapter is not offered a Fix that would do nothing', 'a confirmed chapter still offers Fix');
  await shot('health-confirmed');

  // The file changes: the proof was about bytes that are no longer on disk, so it is withdrawn.
  // ⚠️ BOTH stubs. Walk Tale follows fake-b by now, so the refetch picks whichever copy the release rules
  // rank first; re-scripting only fake-a leaves a two-page copy on the other source for it to take, and
  // the chapter comes back exactly as short as it was.
  await Promise.all([script(STUB_A, 4, 0, 'ok'), script(STUB_B, 4, 0, 'ok')]);
  if (taleId && book4) {
    await api(`/api/admin/series/${taleId}/chapters/refetch`, { method: 'POST', json: { bookIds: [book4.id] } });
    await waitFor(async () => {
      const jobs = await api('/api/sources/jobs').catch(() => null);
      return jobs?.content?.find((j) => j.title === 'Walk Tale' && j.status !== 'downloading') || null;
    }, 60_000, 500);
  }
  const item4b = await waitFor(async () => {
    const i = await healthItem('short-chapters', /Chapter 4 has 2 pages/);
    return i && !i.info ? i : null;
  }, 30_000, 500);
  check(!!item4b, 'replacing the file took the confirmation back', `chapter 4 after the refetch: ${JSON.stringify(await healthItem('short-chapters', /Chapter 4/))}`);
  const pages4 = book4 ? await api(`/api/books/${book4.id}/pages`) : [];
  check(pages4?.length === 12, 'and the chapter really is whole again', `chapter 4 page route returned ${pages4?.length ?? 'no'} pages`);

  // ---- 4. a gap nobody we follow lists is searched for and filled ----------------------------------
  phase = 'gaps';
  await openHealth();
  check(await openCheck('chapter-gaps'), 'Health has a chapter-gap card', 'Health did not expose the chapter-gap card');
  const gapItem = await healthItem('chapter-gaps', /Walk Gap/);
  check(!!gapItem && Array.isArray(gapItem.numbers) && gapItem.numbers.join(',') === '6,7,8',
    'the gap names the three chapters nobody holds', `gap item: ${JSON.stringify(gapItem)}`);
  const gapMark = Date.now();
  const since4 = await repairStamp();
  const filled = await clickChip('chapter-gaps', 'fill', /Walk Gap/, 'Fill now');
  const gapRun = filled ? await repairAfter(since4, 'Fill now') : null;
  check(gapRun?.gaps?.series === 1 && gapRun?.gaps?.followed === 1 && gapRun?.gaps?.fetched === 3,
    'one series searched, one source followed, three chapters fetched', `gaps: ${JSON.stringify(gapRun?.gaps)}`);
  const gapBooks = gapId ? await booksOf(gapId) : [];
  check([6, 7, 8].every((n) => bookNo(gapBooks, n)), 'chapters 6, 7 and 8 are on disk',
    `held: ${gapBooks.map((b) => Number(b.number ?? b.metadata?.numberSort)).sort((a, b) => a - b).join(',')}`);
  const gapSources = gapId ? (await api(`/api/series/${gapId}`)).sources || [] : [];
  const gapFollower = gapSources.find((s) => s.sourceId === 'fake-b');
  check(!!gapFollower && gapFollower.auto === true && gapFollower.sourceSeriesId === 'walk-gap',
    'fake-b is followed for Walk Gap', `Walk Gap sources: ${JSON.stringify(gapSources)}`);
  const audit = await api('/api/admin/audit?limit=200');
  const followRow = (audit.content || []).find((r) => r.event === 'series.follow_source' && r.detail?.id === gapId);
  check(followRow?.detail?.reason === 'gap' && followRow?.detail?.auto === true && (followRow?.detail?.coverage ?? 0) >= 0.9,
    'the audit records an automatic follow made for a gap, at or above the 90% rule', `follow audit: ${JSON.stringify(followRow?.detail)}`);
  check(String(followRow?.detail?.numbers ?? '') === '6,7,8', 'and it names the numbers it was for', `numbers: ${JSON.stringify(followRow?.detail?.numbers)}`);
  const gapImages = rowsSince(await sourceLog(STUB_B), 'image', undefined, gapMark).filter((r) => /^walk-gap-/.test(r.chapter || ''));
  check(gapImages.length === 36, 'exactly the three missing chapters were downloaded', `fake-b served ${gapImages.length} Walk Gap images (3 x 12 expected)`);
  await shot('health-gap-filled');

  // ---- 6. a solver-only run, and the line it writes -------------------------------------------------
  phase = 'solver';
  const solverRun = await runRepair({ only: ['solver'] }, 'solver');
  check(solverRun?.solver?.reset === false && solverRun?.only?.join(',') === 'solver',
    'a solver-only run reports the solver and nothing else', `solver run: ${JSON.stringify(solverRun)}`);
  check(solverRun?.counted === 0 && solverRun?.short?.looked === 0, 'and it did no other work', `solver run counted=${solverRun?.counted} looked=${solverRun?.short?.looked}`);

  // ---- 7. the task, its schedule and its switch ----------------------------------------------------
  phase = 'tasks';
  await page.goto(`${BASE}/admin/?tab=Tasks`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await waitFor(async () => /Repair library/.test(await bodyText()), 20_000);
  const rowText = async () => page.evaluate(() => {
    const row = [...document.querySelectorAll('div')].find((el) => [...el.children].some((c) =>
      c.tagName === 'P' && (c.textContent || '').trim() === 'Repair library'));
    return row ? row.innerText || '' : '';
  });
  const onText = await rowText();
  check(/never during a chapter sweep/.test(onText), 'the Tasks row says it never runs beside a sweep', `Repair library row: ${JSON.stringify(onText)}`);
  check(/solver: nothing to reset/i.test(onText), 'the result line reports the solver even when nothing was reset', `result line: ${JSON.stringify(onText)}`);
  check(!/page counts stamped/i.test(onText), 'and says nothing about the steps that never ran', `result line: ${JSON.stringify(onText)}`);
  await shot('tasks-repair');

  await page.goto(`${BASE}/admin/?tab=Settings`, { waitUntil: 'networkidle2', timeout: 60_000 });
  const switchOff = await waitFor(() => page.$('[role=switch][aria-label="Repair the library nightly"]'), 20_000);
  check(!!switchOff, 'Library housekeeping has the nightly switch', 'the nightly repair switch is not on the Settings tab');
  if (switchOff) {
    check(await switchOff.evaluate((el) => el.getAttribute('aria-checked') === 'true'), 'the nightly repair is on by default', 'the nightly repair was not on');
    await switchOff.evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await switchOff.click();
    await waitFor(async () => (await api('/api/admin/settings')).repair_enabled === false, 15_000);
  }
  await shot('settings-switch');
  await page.goto(`${BASE}/admin/?tab=Tasks`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await waitFor(async () => /Repair library/.test(await bodyText()), 20_000);
  const offText = await waitFor(async () => { const t = await rowText(); return /switched off/.test(t) ? t : ''; }, 15_000);
  check(/switched off · on demand/.test(offText || ''), 'switched off, the schedule says so and offers Run now',
    `Repair library row with the switch off: ${JSON.stringify(offText || await rowText())}`);
  // Off is the schedule only: a run somebody asks for still starts, because nothing it does is destructive.
  const offRun = await api('/api/admin/tasks/repair/run', { method: 'POST', json: { only: ['solver'] } });
  check(offRun?.ok === true && offRun?.started === true, 'Run now still works with the nightly switched off', `answer: ${JSON.stringify(offRun)}`);
  await api('/api/admin/settings', { method: 'PATCH', json: { repairEnabled: true } });

  // ---- the page itself ------------------------------------------------------------------------------
  phase = 'contracts';
  await api('/api/admin/tasks/repair/run', { method: 'POST', json: { only: ['gaps'], bookId: 'nope' } })
    .then(() => bad('a body mixing one step\'s target with another was accepted'))
    .catch((e) => check(e.status === 400 && e.body?.error === 'bad_request',
      'a target that belongs to another step is refused with the step named',
      `mixed body answered ${e.status} ${JSON.stringify(e.body)}`));
  await openHealth();
  check(consoleErrors.length === 0, 'zero browser-console errors', `browser console: ${consoleErrors.slice(0, 8).join(' | ')}`);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    `${WIDTH}px walk has no horizontal scroll`, `${WIDTH}px walk overflowed horizontally`);
  await shot('health-final');
} catch (error) {
  bad(`${phase}: ${error instanceof Error ? error.stack || error.message : String(error)}`);
} finally {
  if (apiToken) {
    await api('/api/admin/settings', { method: 'PATCH', json: { repairEnabled: true } }).catch(() => {});
    if (restoreMangaDex) await api('/api/admin/sources/mangadex/enable', { method: 'POST' }).catch(() => {});
  }
  await browser.close();
}

console.log(failures.length ? `\n  ${failures.length} FAILED\n  - ${failures.join('\n  - ')}` : '\n  all checks passed');
process.exit(failures.length ? 1 : 0);
