// Browser acceptance walk for v0.40.0. Run against a kept web/test/e2e/up.sh instance at WIDTH=1280 and
// WIDTH=390. It uses one browser login and one API login, prints every verdict as [ ok ]/[FAIL], writes
// screenshots under OUT, and exits 1 if any contract, source-load cap or browser-console check fails.
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
const OUT = process.env.OUT || 'shots40';
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
const median = (values) => {
  const a = [...values].sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : 0;
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
const imageRows = (rows, chapter) => rows.filter((r) => r.route === 'image' && r.chapter === chapter);
const gaps = (rows) => rows.slice(1).map((r, i) => r.at - rows[i].at);

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
let phase = 'start';
let shotNo = 0;
let restoreHunt = true;
let restoreMangaDex = false;
let repairStartedAt = 0;
try {
  // The one API login. The browser signs in separately below, exactly once.
  const login = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (!login.ok) throw new Error(`API login ${login.status}`);
  apiToken = (await login.json()).accessToken;
  ok('one API login');

  await Promise.all([control(STUB_A, '/__reset', {}), control(STUB_B, '/__reset', {})]);
  // A kept E2E database may remember a failed harness startup as a normal source cooldown. The walk owns
  // these environment-gated adapters, so reset only their disposable health state before measuring search.
  await Promise.all(['fake-a', 'fake-b'].flatMap((id) => [
    api(`/api/admin/sources/${id}/enable`, { method: 'POST' }),
    api(`/api/admin/sources/${id}/unblock`, { method: 'POST' }),
  ]));
  // MangaDex is a real public source and has no place in a deterministic fake-source run. Its admin state
  // belongs only to this disposable database and is restored in finally for a kept instance.
  await api('/api/admin/sources/mangadex/disable', { method: 'POST' });
  restoreMangaDex = true;
  await script(STUB_B, 'search', 0, 'slow:4000');

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
  const clickText = async (re, selector = 'button') => {
    const handle = await page.evaluateHandle((selector, source) => {
      const rx = new RegExp(source, 'i');
      return [...document.querySelectorAll(selector)].find((el) => el.offsetParent !== null && rx.test((el.textContent || '').trim())) || null;
    }, selector, re.source);
    const el = handle.asElement();
    if (!el) throw new Error(`no visible ${selector} matching ${re}`);
    await el.evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await el.click();
    return el;
  };
  // Fake results deliberately have no cover URL, so Img renders its accessible broken-image fallback and
  // there is no inner <img alt>. The card's visible title is the contract, whether artwork exists or not.
  const cardTitles = () => page.evaluate(() => [...document.querySelectorAll('button[aria-label="Add to library"]')]
    .map((button) => button.querySelector('p')?.textContent?.trim()).filter(Boolean));

  // Browser login, once.
  phase = 'login';
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60_000 });
  await page.waitForSelector('input[type=password]', { timeout: 30_000 });
  const fields = await page.$$('input');
  await fields[0].type(USER); await page.type('input[type=password]', PASS); await page.keyboard.press('Enter');
  await waitFor(async () => !(await page.$('input[type=password]')), 20_000);
  check(!(await page.$('input[type=password]')), 'one browser login', 'browser login did not leave the form');

  // ---------------------------------------------------------------- 1. Progressive + cached search
  phase = 'search';
  await page.goto(`${BASE}/discover/`, { waitUntil: 'networkidle2', timeout: 60_000 });
  const input = await page.waitForSelector('input[aria-label="Search all sources…"]', { timeout: 20_000 });
  await input.type('Walk Tale');
  const firstAt = Date.now();
  await clickText(/^Search$/);
  const painted = await waitFor(async () => (await cardTitles()).includes('Walk Tale'), 8_000);
  const firstMs = Date.now() - firstAt;
  check(!!painted && firstMs < 2500, `first result painted in ${firstMs} ms`, `first result took ${firstMs} ms (limit 2500)`);
  const progress = await page.$eval('[data-search-progress]', (el) => el.textContent || '').catch(() => '');
  check(/fake-b/.test(progress), 'progress names fake-b while it is pending', `progress line while fake-b was slow: ${JSON.stringify(progress)}`);
  const orderBefore = await cardTitles();
  const folded = await waitFor(async () => {
    const text = await bodyText();
    return /2 sources/.test(text) && !(await page.$('[data-search-progress]'));
  }, 10_000);
  check(!!folded, 'fake-b folded into the existing card', 'late fake-b result did not fold in');
  const orderAfter = await cardTitles();
  check(orderBefore.every((title, i) => orderAfter[i] === title), 'late results did not reorder the wall', `order moved: ${orderBefore.join(' | ')} -> ${orderAfter.join(' | ')}`);

  await clickText(/^Newest$/); await sleep(300);
  const againInput = await page.$('input[aria-label="Search all sources…"]');
  await againInput.type('Walk Tale');
  const cachedAt = Date.now(); await clickText(/^Search$/);
  await waitFor(async () => (await cardTitles()).includes('Walk Tale'), 2000);
  const cachedMs = Date.now() - cachedAt;
  check(cachedMs < 750, `repeat search painted from cache in ${cachedMs} ms`, `repeat search took ${cachedMs} ms`);
  const [searchA, searchB] = await Promise.all([sourceLog(STUB_A), sourceLog(STUB_B)]);
  check(searchA.filter((r) => r.route === 'search').length === 1 && searchB.filter((r) => r.route === 'search').length === 1,
    'repeat search made no second source request', `search calls: a=${searchA.filter((r) => r.route === 'search').length} b=${searchB.filter((r) => r.route === 'search').length}`);
  await shot('search-progressive');

  // ---------------------------------------------------------------- 2. Dialog pre-warm
  phase = 'prewarm';
  const walkCard = await page.evaluateHandle(() => [...document.querySelectorAll('button[aria-label="Add to library"]')]
    .find((button) => button.querySelector('p')?.textContent?.trim() === 'Walk Tale') || null);
  if (!walkCard.asElement()) throw new Error('Walk Tale card disappeared');
  await walkCard.asElement().click();
  await waitFor(async () => /Available on/.test(await bodyText()), 5000);
  const warmed = await waitFor(async () => {
    const [a, b] = await Promise.all([sourceLog(STUB_A), sourceLog(STUB_B)]);
    return [a, b].every((rows) => rows.some((r) => r.route === 'series') && rows.some((r) => r.route === 'chapters'));
  }, 5000);
  check(!!warmed, 'dialog pre-warmed the first two providers', 'both provider details were not pre-warmed');
  const pickAt = Date.now(); await clickText(/^fake-a/);
  const immediate = await waitFor(async () => /From\s+fake-a/.test(await bodyText()), 1000);
  check(!!immediate, `fake-a body painted in ${Date.now() - pickAt} ms`, 'picked source body stayed behind a loading screen');
  const counted = await waitFor(async () => /12 chapters/.test(await bodyText()), 5000);
  check(!!counted, 'pre-warmed chapter count arrived', 'fake-a chapter count never arrived');
  const followSwitch = await page.$('[role=switch][aria-label="Also check the other sources that carry this title"]');
  if (followSwitch && await followSwitch.evaluate((el) => el.getAttribute('aria-checked') !== 'true')) await followSwitch.click();
  check(!!followSwitch, 'add dialog offered the other-source follow', 'add dialog did not offer the other-source follow');
  await shot('dialog-prewarmed');

  // ---------------------------------------------------------------- 3. Tiny image, 429 persistence, auto-follow, then refetch fallback
  phase = 'download';
  await Promise.all([
    script(STUB_A, 5, 12, 'tiny-webp'),
    script(STUB_A, 7, 11, '429:after=10,retryAfter=1'),
  ]);
  await clickText(/^Add to library$/);
  const added = await waitFor(async () => /Added to your library/.test(await bodyText()), 20_000);
  check(!!added, 'All (12) add started', 'add dialog did not reach its done step');
  const finishedJob = await waitFor(async () => {
    const jobs = await api('/api/sources/jobs').catch(() => null);
    return jobs?.content?.find((job) => job.title === 'Walk Tale' && job.status !== 'downloading' && job.autoFollow?.done) || null;
  }, 120_000, 500);
  check(!!finishedJob, 'twelve-chapter job and other-source check finished', 'Walk Tale job/other-source check did not finish within two minutes');
  check(finishedJob?.done === 12, 'all 12 chapters landed', `job landed ${finishedJob?.done ?? 'no'} of 12`);
  check(finishedJob?.partial === undefined || finishedJob.partial === 0, 'initial add needed no partial chapter', `initial job partial=${finishedJob?.partial}`);

  const seriesPage = await api('/api/series/search', { method: 'POST', json: { query: 'Walk Tale', size: 10 } });
  const series = seriesPage?.content?.find((row) => (row.metadata?.title || row.name) === 'Walk Tale');
  check(!!series, 'Walk Tale is in the library', 'library search did not find Walk Tale');
  const seriesId = series?.id;
  const seriesDto = seriesId ? await api(`/api/series/${seriesId}`) : null;
  check(seriesDto?.sources?.some((source) => source.sourceId === 'fake-b' && source.auto === true),
    'fake-b was followed automatically', `series sources: ${JSON.stringify(seriesDto?.sources || [])}`);

  // Add is intentionally not allowed to hunt or switch copies: the person is watching that one source.
  // Once fake-b has been judged and followed, an admin refetch goes through the shared download job and
  // may use it as the ordinary-failure fallback.
  // The detached job finishes its writes before the scan/stamps that populate the book DTO. Page enumeration
  // is deliberately lazy, so retain the rows as soon as both test chapters exist and enumerate chapter 5
  // through its public page route before checking the cached count on the book.
  const addedBooks = seriesId ? await waitFor(async () => {
    const books = await api(`/api/series/${seriesId}/books?size=1000`).catch(() => null);
    const five = books?.content?.find((book) => Number(book.number ?? book.metadata?.numberSort) === 5);
    const six = books?.content?.find((book) => Number(book.number ?? book.metadata?.numberSort) === 6);
    return five && six ? books : null;
  }, 20_000, 250) : null;
  const book5 = addedBooks?.content?.find((book) => Number(book.number ?? book.metadata?.numberSort) === 5);
  const book6 = addedBooks?.content?.find((book) => Number(book.number ?? book.metadata?.numberSort) === 6);
  const pages5 = book5 ? await api(`/api/books/${book5.id}/pages`) : [];
  check(pages5?.length === 12, 'valid tiny WebP stayed in the 12-page archive', `chapter 5 page route returned ${pages5?.length ?? 'no'} pages`);
  if (!book6) bad('chapter 6 book row was not found for the fallback refetch');
  await script(STUB_A, 6, 12, '404');
  let fallbackFolder = finishedJob?.folder || null;
  if (seriesId && book6) {
    const refetch = await api(`/api/admin/series/${seriesId}/chapters/refetch`, { method: 'POST', json: { bookIds: [book6.id] } });
    fallbackFolder = refetch?.folder || fallbackFolder;
  }
  const fallbackJob = await waitFor(async () => {
    const jobs = await api('/api/sources/jobs').catch(() => null);
    return jobs?.content?.find((job) => job.folder === fallbackFolder && job.status !== 'downloading' && job.switched?.some((row) => row.number === 6)) || null;
  }, 60_000, 500);
  const switched6 = fallbackJob?.switched?.find((row) => row.number === 6 && row.from === 'fake-a' && row.to === 'fake-b');
  check(!!switched6, 'refetch switched chapter 6 from fake-a to followed fake-b', `refetch switches: ${JSON.stringify(fallbackJob?.switched || [])}`);
  const counted5 = book5 ? await waitFor(async () => {
    const books = await api(`/api/series/${seriesId}/books?size=1000`).catch(() => null);
    return books?.content?.find((book) => book.id === book5.id && book.media?.pagesCount === 12) || null;
  }, 20_000, 250) : null;
  check(!!counted5, 'tiny WebP chapter has all 12 pages', `chapter 5 page count: ${counted5?.media?.pagesCount ?? book5?.media?.pagesCount ?? 'missing'}`);

  const logA = await sourceLog(STUB_A);
  const ch5 = imageRows(logA, 'walk-tale-5');
  const ch7 = imageRows(logA, 'walk-tale-7');
  const ch8 = imageRows(logA, 'walk-tale-8');
  check(ch5.some((row) => row.page === 12 && row.status === 200), 'valid 108-byte WebP landed as page 12', 'chapter 5 page 12 did not return 200');
  check(ch7.some((row) => row.status === 429) && ch7.filter((row) => row.page === 11).some((row) => row.status === 200),
    'chapter 7 resumed page 11 after 429', `chapter 7 statuses: ${ch7.map((r) => `${r.page}:${r.status}`).join(', ')}`);
  const g5 = median(gaps(ch5.filter((r) => r.status === 200)));
  const g8 = median(gaps(ch8.filter((r) => r.status === 200)));
  check(g5 > 0 && g8 >= g5 * 1.8, `chapter 8 median page gap ${g8} ms (chapter 5: ${g5} ms)`, `pace did not persist: ch5=${g5} ms ch8=${g8} ms`);
  check(Math.max(0, ...ch5.map((r) => r.chapterRequest || 0)) <= 12 && Math.max(0, ...ch7.map((r) => r.chapterRequest || 0)) <= 13,
    'per-chapter image requests stayed bounded', `request counts ch5=${ch5.length} ch7=${ch7.length}`);

  if (seriesId) {
    await page.goto(`${BASE}/series/?id=${encodeURIComponent(seriesId)}`, { waitUntil: 'networkidle2', timeout: 60_000 });
    await waitFor(async () => /Walk Tale/.test(await bodyText()), 10_000);
    const supply = await page.evaluateHandle(() => [...document.querySelectorAll('button')]
      .find((button) => button.offsetParent !== null && /fake-a|source/i.test(button.textContent || '')) || null);
    if (supply.asElement()) { await supply.asElement().click(); await sleep(500); }
    check(/followed for you/.test(await bodyText()), 'Sources & translations shows followed for you', 'automatic follower chip is missing');
    await shot('fallback-followed');
    await page.keyboard.press('Escape').catch(() => {});
  }

  // ---------------------------------------------------------------- 4. Partial chapter + reader/offline contract, hunt OFF
  phase = 'partial';
  const settingsBefore = await api('/api/admin/settings');
  restoreHunt = settingsBefore.auto_follow_on_failure !== false;
  await api('/api/admin/settings', { method: 'PATCH', json: { autoFollowOnFailure: false } });
  await Promise.all([script(STUB_A, 9, 3, '404'), script(STUB_B, 9, 3, '404')]);
  const booksBefore = seriesId ? await api(`/api/series/${seriesId}/books?size=1000`) : null;
  const book9 = booksBefore?.content?.find((book) => Number(book.number ?? book.metadata?.numberSort) === 9);
  if (!book9) bad('chapter 9 book row was not found');
  const huntsBefore = (await sourceLog(STUB_B)).filter((row) => row.route === 'search').length;
  if (seriesId && book9) {
    await api(`/api/admin/series/${seriesId}/chapters/refetch`, { method: 'POST', json: { bookIds: [book9.id] } });
    await waitFor(async () => {
      const jobs = await api('/api/sources/jobs').catch(() => null);
      return jobs?.content?.find((job) => job.title === 'Walk Tale' && job.status !== 'downloading') || null;
    }, 60_000, 500);
  }
  const partial9 = await waitFor(async () => {
    const books = seriesId ? await api(`/api/series/${seriesId}/books?size=1000`).catch(() => null) : null;
    return books?.content?.find((book) => book.id === book9?.id && Array.isArray(book.missingPages) && book.missingPages.includes(3)) || null;
  }, 20_000, 300);
  check(!!partial9, 'chapter 9 saved with page 3 missing', `chapter 9 DTO: ${JSON.stringify(partial9 || book9 || null)}`);
  const pages9 = book9 ? await api(`/api/books/${book9.id}/pages`) : [];
  check(pages9?.length === 12 && pages9[2]?.missing === true, 'page DTO keeps 12 pages and marks page 3 missing', `pages=${pages9?.length} page3=${JSON.stringify(pages9?.[2])}`);
  const manifest9 = book9 ? await api(`/api/books/${book9.id}/download-manifest`) : null;
  check(manifest9?.pages?.[2]?.missing === true || manifest9?.content?.[2]?.missing === true,
    'offline manifest carries missing: true', `offline manifest page 3: ${JSON.stringify(manifest9?.pages?.[2] || manifest9?.content?.[2])}`);
  const huntsAfter = (await sourceLog(STUB_B)).filter((row) => row.route === 'search').length;
  check(huntsAfter === huntsBefore, 'admin switch prevented a new source hunt', `fake-b search count changed ${huntsBefore} -> ${huntsAfter}`);

  if (seriesId && book9) {
    await page.goto(`${BASE}/series/?id=${encodeURIComponent(seriesId)}`, { waitUntil: 'networkidle2', timeout: 60_000 });
    const badge = await waitFor(async () => /1 page missing/.test(await bodyText()), 12_000);
    check(!!badge, 'series row shows 1 page missing', 'series row did not show its partial badge');
    await page.goto(`${BASE}/reader/?book=${encodeURIComponent(book9.id)}&page=3`, { waitUntil: 'networkidle2', timeout: 60_000 });
    const caption = await waitFor(async () => /Page 3 could not be fetched/.test(await bodyText()) && /retried automatically/.test(await bodyText()), 15_000);
    check(!!caption, 'reader captions the page 3 placeholder', 'reader did not caption the missing page');
    await shot('partial-reader');
  }

  // A readable partial is not an active chapter-failure row: Health points to its series badge and explains
  // the nightly retry policy, while the archive manifest retains the exact missing indices.
  await page.goto(`${BASE}/admin/?tab=Health`, { waitUntil: 'networkidle2', timeout: 60_000 });
  const failureHealth = await waitFor(() => page.$('[data-health-check="chapter-failures"] button'), 10_000);
  if (failureHealth) await failureHealth.click();
  else bad('Health did not expose the chapter-failure card');
  const healthBeforeRepair = await waitFor(async () => page.$eval(
    '[data-health-check="chapter-failures"] [data-health-note]',
    (el) => /saved with pages missing/i.test(el.textContent || '') && /re-tried by the sweep/i.test(el.textContent || ''),
  ).catch(() => false), 10_000);
  check(!!healthBeforeRepair, 'Health explains where partials appear and how they retry', 'Health did not explain partial chapter recovery');
  await shot('health-partial-note');

  // ---------------------------------------------------------------- 5. Nightly repair asks only the hole
  phase = 'repair';
  repairStartedAt = Date.now();
  await Promise.all([script(STUB_A, 9, 3, 'ok'), script(STUB_B, 9, 3, 'ok')]);
  // The deliberate 404s above put both fake sources into a normal cooldown. Advancing a day would make the
  // browser walk slow and non-deterministic, so this disposable admin clears only those two cooldowns.
  await Promise.all(['fake-a', 'fake-b'].map((id) => api(`/api/admin/sources/${id}/unblock`, { method: 'POST' })));
  await page.goto(`${BASE}/admin/?tab=Tasks`, { waitUntil: 'networkidle2', timeout: 60_000 });
  const updateRun = await page.evaluateHandle(() => {
    const row = [...document.querySelectorAll('div')].find((el) => [...el.children].some((child) =>
      child.tagName === 'P' && (child.textContent || '').trim() === 'Check for new chapters') && el.querySelector('button'));
    return row ? [...row.querySelectorAll('button')].find((button) => /Run now/.test(button.textContent || '')) || null : null;
  });
  if (updateRun.asElement()) await updateRun.asElement().click();
  else bad('Tasks did not expose Run now for Check for new chapters');
  const healed = await waitFor(async () => {
    const books = seriesId ? await api(`/api/series/${seriesId}/books?size=1000`).catch(() => null) : null;
    const row = books?.content?.find((book) => book.id === book9?.id);
    return row && row.missingPages == null ? row : null;
  }, 150_000, 1000);
  check(!!healed, 'nightly completion pass healed chapter 9', 'chapter 9 stayed partial after Run now');
  if (seriesId && book9) {
    const repairedPages = await api(`/api/books/${book9.id}/pages`);
    check(repairedPages.length === 12 && !repairedPages[2]?.missing, 'page 3 is real and the count stayed 12', `repaired page 3: ${JSON.stringify(repairedPages[2])}`);
    await page.goto(`${BASE}/series/?id=${encodeURIComponent(seriesId)}`, { waitUntil: 'networkidle2', timeout: 60_000 });
    await sleep(1500);
    check(!/1 page missing/.test(await bodyText()), 'partial badge disappeared after repair', 'partial badge remained after repair');
    await shot('partial-repaired');
  }

  // ---------------------------------------------------------------- 6. Public/authorization shape and console
  phase = 'contracts';
  const anonymous = await fetch(`${BASE}/api/sources/search-all?q=Walk%20Tale&wait=0`);
  check(anonymous.status === 401, 'search-all still requires authentication', `anonymous search-all returned ${anonymous.status}`);
  const sourceList = await api('/api/sources');
  check((sourceList.content || []).every((source) => !Object.hasOwn(source, 'pace')),
    '/api/sources exposes no optional pacing telemetry', '/api/sources leaked pace telemetry');
  const [finalA, finalB] = await Promise.all([sourceLog(STUB_A), sourceLog(STUB_B)]);
  const repairRequests = [...imageRows(finalA, 'walk-tale-9'), ...imageRows(finalB, 'walk-tale-9')]
    .filter((row) => row.at >= repairStartedAt);
  check(repairRequests.length === 1 && repairRequests[0].status === 200 && repairRequests[0].page === 3,
    'completion requested only the missing index', `repair image requests: ${repairRequests.map((r) => `${r.page}:${r.status}`).join(', ') || 'none'}`);
  check(consoleErrors.length === 0, 'zero browser-console errors', `browser console: ${consoleErrors.slice(0, 8).join(' | ')}`);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    `${WIDTH}px walk has no horizontal scroll`, `${WIDTH}px walk overflowed horizontally`);
} catch (error) {
  bad(`${phase}: ${error instanceof Error ? error.stack || error.message : String(error)}`);
} finally {
  if (apiToken) {
    if (restoreHunt) await api('/api/admin/settings', { method: 'PATCH', json: { autoFollowOnFailure: true } }).catch(() => {});
    if (restoreMangaDex) await api('/api/admin/sources/mangadex/enable', { method: 'POST' }).catch(() => {});
  }
  await browser.close();
}

console.log(failures.length ? `\n  ${failures.length} FAILED\n  - ${failures.join('\n  - ')}` : '\n  all checks passed');
process.exit(failures.length ? 1 : 0);
