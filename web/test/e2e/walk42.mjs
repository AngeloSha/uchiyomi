// Browser acceptance walk for v0.42.0 — the four reported bugs, and the opt-in ghost chapters.
//
// Needs an instance of its OWN, started with E2E_ADULT=1: that is what makes fake-b declare itself adult
// (FAKE_SOURCE_NSFW) and gives fake-a the series whose title cannot be typed. An explicit BASE, like the
// v0.41 walk, because the default port belongs to whichever instance came up first:
//
//   KEEP=1 E2E_ADULT=1 E2E_NET=uchiyomi-e2e-42 E2E_PORT=18142 E2E_SUBNET=10.222.2.0/24 bash web/test/e2e/up.sh
//   cd web && WIDTH=1280 BASE=http://127.0.0.1:18142 npm run test:e2e:v042
//   … then again with WIDTH=390, on another fresh instance.
//
// It adds series and leaves them there, and step 5 wants a series REMOVED and put back, so it cannot share
// a database with walk40 or walk41 any more than those two can share one with each other.
//
// The order is not the order of the release notes, and this is what to know before editing it:
//   * Step 1 reads the stubs' own request logs to prove an adult source is not merely absent from a list
//     but never ASKED, so it runs before anything else touches fake-b. A source that is asked and answers
//     nothing would pass a body-only check for the wrong reason.
//   * ⚠️ Discover refuses to open the add dialog for a card it knows is in the library, so every step that
//     opens one runs while its title is NOT in the library: the browsing checks and the duplicate prompt
//     come first, the library is built after them, and the re-add steps remove the series first.
//   * The reveal is turned ON in the browser during step 3 and left on: the duplicate has to be added
//     FROM the adult provider, and that card cannot be reached while the reveal hides it.
//   * The duplicate prompt is reached the way anyone reaches it: the dialog is opened BEFORE the title is
//     in the library and the library gains it while the dialog sits there.
//   * Walk Tale is added as the oldest nine of twelve: those three unfetched numbers are the ghosts step 9
//     counts, and nine is the run it reads to the end.
//   * Step 9 marks Walk Tale read to the end. Nothing after it may fetch a Walk Tale chapter, or the
//     series stops being "read to the end" and the COMPLETED assertion goes quietly vacuous.
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
const OUT = process.env.OUT || 'shots42';
mkdirSync(OUT, { recursive: true });

// The title the whole of step 8 is about: a curly apostrophe and an en dash, exactly the two characters
// 38 of the owner's 241 series carry and no keyboard produces. TYPED is what a person can actually type.
const CURLY = 'Ren’s Walk – Notes';
const TYPED = "Ren's Walk - Notes";

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
/** One HTTP call as the admin. `raw: true` hands back the status instead of throwing, for the refusals. */
async function api(path, init = {}) {
  return call(apiToken, path, init);
}
async function call(token, path, init = {}) {
  const hasBody = init.json !== undefined || init.body !== undefined;
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
    body: init.json === undefined ? init.body : JSON.stringify(init.json),
  });
  const raw = await r.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
  if (init.raw) return { status: r.status, body };
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
const sourceLog = async (base) => (await control(base, '/__log')).content || [];
/** The rows of one route this stub served after `from` — the evidence that it was, or was not, asked. */
const rowsSince = (rows, route, from, key) => rows.filter((r) => r.route === route && r.at >= from
  && (key === undefined || r.chapter === key || r.series === key));
const countSince = async (base, route, from) => rowsSince(await sourceLog(base), route, from).length;

// ---- library helpers ------------------------------------------------------------------------------
const seriesByTitle = async (title) => {
  const page = await api('/api/series/search', { method: 'POST', json: { query: title, size: 30 } });
  return page?.content?.find((row) => (row.metadata?.title || row.name) === title) || null;
};
const booksOf = async (id) => (await api(`/api/series/${id}/books?size=1000`).catch(() => null))?.content || [];
const listingOf = async (id) => (await api(`/api/series/${id}/listing`).catch(() => null))?.content || [];
/** Add over the API and wait for the job card to stop moving. */
async function addFromA(sourceId, title, body = {}) {
  const answer = await api('/api/sources/add', { method: 'POST', json: { source: 'fake-a', sourceId, ...body } });
  const job = await waitFor(async () => {
    const jobs = await api('/api/sources/jobs').catch(() => null);
    return jobs?.content?.find((j) => j.title === title && j.status !== 'downloading') || null;
  }, 180_000, 500);
  return { answer, job };
}
const removeSeries = (id) => api(`/api/admin/series/${id}`, { method: 'DELETE' });

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
  // A real public source has no place in a deterministic fake-source run, and here it would also be one
  // more row in every source list this walk counts. Restored in finally, like walk40 and walk41.
  await api('/api/admin/sources/mangadex/disable', { method: 'POST' });
  restoreMangaDex = true;
  // The switch step 9 turns on and off; asserted off first, because a kept instance somebody poked at
  // would otherwise make "with it off the responses are unchanged" compare two identical revealed runs.
  await api('/api/admin/settings', { method: 'PATCH', json: { komgaGhostChapters: false } });

  // ---- the rig itself, before anything reads it as a verdict --------------------------------------
  // ⚠️ Vacuity guard. Every check in step 1 passes on an instance with no adult source at all, and every
  // check in step 8 passes on one whose titles are all typeable. Both are properties of how up.sh was
  // started, so they are proved here rather than assumed, and a missing one stops the walk.
  phase = 'rig';
  const revealed = await api('/api/sources?adult=1');
  const adultSrc = (revealed.content || []).find((s) => s.id === 'fake-b');
  if (!adultSrc) throw new Error('fake-b is not registered: start the instance with E2E_ADULT=1');
  const quoteHit = await api(`/api/sources/search?source=fake-a&q=${encodeURIComponent('Ren')}`);
  if (!(quoteHit.content || []).some((r) => r.title === CURLY)) {
    throw new Error(`fake-a does not carry ${CURLY}: start the instance with E2E_ADULT=1 (it passes --extra v42)`);
  }
  ok('the rig has an adult provider and a title that cannot be typed');

  // ---- 1. the "Show 18+" reveal covers Discover's sources (#64) ------------------------------------
  phase = 'adult';
  const hidden = await api('/api/sources');
  check(!(hidden.content || []).some((s) => s.id === 'fake-b'),
    'the source list leaves the adult provider out while the reveal is off',
    `GET /api/sources listed ${(hidden.content || []).map((s) => s.id).join(', ')}`);
  check(hidden.hiddenAdult === 1, 'it reports one source hidden, so Discover can offer the chip',
    `hiddenAdult with the reveal off: ${JSON.stringify(hidden.hiddenAdult)}`);
  check(revealed.hiddenAdult === 0 && (revealed.content || []).some((s) => s.id === 'fake-b'),
    'with ?adult=1 the provider is back and nothing is hidden',
    `revealed: hiddenAdult=${revealed.hiddenAdult} fake-b=${(revealed.content || []).some((s) => s.id === 'fake-b')}`);

  // Asked, not merely listed: the stub's own log is the only thing that can tell "hidden" from "hidden
  // after we queried an adult site on behalf of someone who asked not to see one".
  let at = Date.now();
  const searchHidden = await api('/api/sources/search?source=fake-b&q=Walk');
  await sleep(200);
  check((searchHidden.content || []).length === 0 && (await countSince(STUB_B, 'search', at)) === 0,
    'a hidden source answers an empty page for a search and is never asked',
    `hidden per-source search: ${(searchHidden.content || []).length} results, ${await countSince(STUB_B, 'search', at)} outbound`);
  at = Date.now();
  const searchShown = await api('/api/sources/search?source=fake-b&q=Walk&adult=1');
  check((searchShown.content || []).length > 0 && (await countSince(STUB_B, 'search', at)) === 1,
    'with the reveal on the same search reaches it',
    `revealed per-source search: ${(searchShown.content || []).length} results, ${await countSince(STUB_B, 'search', at)} outbound`);

  // Two different terms, because search-all caches a normalised term for five minutes and a cached entry
  // would answer the second call without asking anybody.
  at = Date.now();
  const allHidden = await api('/api/sources/search-all?q=Walk%20Tale&wait=4000');
  check(!(allHidden.sources || []).some((s) => s.id === 'fake-b') && (await countSince(STUB_B, 'search', at)) === 0,
    'the cross-source search neither lists nor asks an adult source',
    `search-all hidden: sources=${JSON.stringify((allHidden.sources || []).map((s) => s.id))}, ${await countSince(STUB_B, 'search', at)} outbound`);
  at = Date.now();
  const allShown = await api('/api/sources/search-all?q=Walk%20Gap&wait=4000&adult=1');
  check((allShown.sources || []).some((s) => s.id === 'fake-b') && (await countSince(STUB_B, 'search', at)) === 1,
    'with the reveal on it is asked exactly once',
    `search-all revealed: sources=${JSON.stringify((allShown.sources || []).map((s) => s.id))}, ${await countSince(STUB_B, 'search', at)} outbound`);

  const findHidden = await api('/api/sources/find?q=Walk%20Tale');
  const findShown = await api('/api/sources/find?q=Walk%20Tale&adult=1');
  check(!(findHidden.content || []).some((r) => r.source === 'fake-b') && (findShown.content || []).some((r) => r.source === 'fake-b'),
    'the provider fan-out skips it while hidden and includes it revealed',
    `find: hidden=${JSON.stringify((findHidden.content || []).map((r) => r.source))} revealed=${JSON.stringify((findShown.content || []).map((r) => r.source))}`);

  // Hidden is not refused: the same account, one query parameter apart, gets 200 both times. The 403 that
  // a permission produces is step 2, against the same route and the same source id.
  const hiddenStatus = await api('/api/sources/search?source=fake-b&q=Walk', { raw: true });
  check(hiddenStatus.status === 200, 'a hidden source is hidden, not refused: 200 with an empty page',
    `hidden per-source search answered ${hiddenStatus.status}`);

  // ---- 2. the age cap is still a permission, by id -------------------------------------------------
  phase = 'capped';
  const CAPPED = { username: 'e2e-capped', password: 'e2e-capped-passw0rd-1' };
  const made = await call(apiToken, '/api/admin/users', { method: 'POST', raw: true, json: { ...CAPPED, role: 'user' } });
  check([200, 201, 409].includes(made.status), 'a member account for the age-cap check',
    `creating the capped member answered ${made.status}`);
  const members = await api('/api/admin/users');
  const capped = (members.content || members || []).find((u) => u.username === CAPPED.username);
  if (capped) await api(`/api/admin/users/${capped.id}`, { method: 'PATCH', json: { maxAgeRating: 16 } });
  const cappedLogin = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: CAPPED.username, password: CAPPED.password }),
  });
  const cappedToken = cappedLogin.ok ? (await cappedLogin.json()).accessToken : '';
  check(!!cappedToken, 'signed in as the capped member', `capped member login ${cappedLogin.status}`);
  const byId = await call(cappedToken, '/api/sources/search?source=fake-b&q=Walk', { raw: true });
  const byIdRevealed = await call(cappedToken, '/api/sources/search?source=fake-b&q=Walk&adult=1', { raw: true });
  check(byId.status === 403 && byIdRevealed.status === 403,
    'a capped account is refused the adult source by id, with or without the reveal',
    `capped by id: ${byId.status} hidden, ${byIdRevealed.status} revealed`);
  // …and the refusal is about the SOURCE, not about the account: the same call to fake-a is served.
  const cappedOther = await call(cappedToken, '/api/sources/search?source=fake-a&q=Walk', { raw: true });
  check(cappedOther.status === 200, 'the same member reaches an ordinary source',
    `capped member on fake-a: ${cappedOther.status}`);
  const cappedList = await call(cappedToken, '/api/sources');
  check(!(cappedList.content || []).some((s) => s.id === 'fake-b') && cappedList.hiddenAdult === 0,
    'a capped account is told nothing about what it cannot reach, not even the count',
    `capped list: hiddenAdult=${cappedList.hiddenAdult} fake-b=${(cappedList.content || []).some((s) => s.id === 'fake-b')}`);

  // ---- the browser ---------------------------------------------------------------------------------
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: PHONE ? 844 : 900, isMobile: PHONE, hasTouch: PHONE, deviceScaleFactor: 1 });
  await page.setBypassServiceWorker(true);
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !/401|404|409|429/.test(message.text())) consoleErrors.push(`[${phase}] ${message.text().slice(0, 180)}`);
  });
  page.on('pageerror', (error) => consoleErrors.push(`[${phase}] ${String(error).slice(0, 180)}`));
  // What the SERVER answered the add dialog, so "Open in library" can be checked against the id it was
  // given rather than against whatever the page ended up on.
  const adds = [];
  page.on('response', async (res) => {
    if (!/\/api\/sources\/add$/.test(new URL(res.url()).pathname)) return;
    const status = res.status();
    const body = await res.json().catch(() => null);
    adds.push({ status, body });
  });
  const shot = (name) => page.screenshot({ path: `${OUT}/${String(++shotNo).padStart(2, '0')}-${PHONE ? 'phone' : 'desk'}-${name}.png` });
  const bodyText = () => page.evaluate(() => document.body.innerText || '');
  // ⚠️ Every one of these WAITS for its target rather than looking once. This page paints in stages — the
  // trending rail, then the provider list, then the wall — and a control that is simply not there yet is
  // not a failure. A bounded wait still fails, loudly, on a control that never appears.
  const findText = (re, selector = 'button', ms = 15_000) => waitFor(async () => {
    const handle = await page.evaluateHandle((selector, source) => {
      const rx = new RegExp(source, 'i');
      return [...document.querySelectorAll(selector)].find((el) => el.offsetParent !== null && rx.test((el.textContent || '').trim())) || null;
    }, selector, re.source);
    return handle.asElement();
  }, ms, 250);
  const clickText = async (re, selector = 'button') => {
    const el = await findText(re, selector);
    if (!el) throw new Error(`no visible ${selector} matching ${re}`);
    await el.evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await el.click();
    return el;
  };
  const cardTitles = () => page.evaluate(() => [...document.querySelectorAll('button[aria-label="Add to library"]')]
    .map((button) => button.querySelector('p')?.textContent?.trim()).filter(Boolean));
  const openCard = async (title) => {
    const el = await waitFor(async () => {
      const handle = await page.evaluateHandle((want) => [...document.querySelectorAll('button[aria-label="Add to library"]')]
        .find((button) => button.querySelector('p')?.textContent?.trim() === want) || null, title);
      return handle.asElement();
    }, 20_000, 250);
    if (!el) throw new Error(`no result card for ${title}; the wall held ${JSON.stringify(await cardTitles())}`);
    await el.click();
    // The dialog itself, not its "Available on" list: a card only one source carries picks that source
    // immediately and never shows the list, which is exactly the state step 3 asserts.
    await waitFor(() => page.$('[role=dialog]'), 10_000);
    await sleep(600);
  };
  const closeDialog = async () => { await page.keyboard.press('Escape'); await sleep(400); };
  // ⚠️ Everything inside a confirmation is looked up under `[role=dialog]`, never over the whole page:
  // the row that opened the dialog is still in the DOM behind it and still visible, and "Delete files" is
  // the label of both. Scoped by the modal's own role, the two cannot be confused.
  const dialogButton = async (label, ms = 10_000) => waitFor(async () => {
    const handle = await page.evaluateHandle((want) => [...document.querySelectorAll('[role=dialog] button')]
      .find((b) => (b.textContent || '').trim() === want) || null, label);
    return handle.asElement();
  }, ms, 200);
  const dialogInput = () => page.$('[role=dialog] input');
  /**
   * Replace what is in the confirmation box with `text`, and prove that is what it now holds.
   *
   * ⚠️ Select-all and type, never a "triple click": `clickCount` is no longer one of puppeteer's click
   * options, so three-clicking is one click, the new text lands APPENDED to the old, and the assertion
   * that the button arms then fails for a reason that looks like the fold being broken. The read-back is
   * what stops the other half — "a wrong title still refuses" — from passing on an empty box.
   */
  const typeConfirmation = async (text) => {
    const box = await dialogInput();
    if (!box) throw new Error('the confirmation dialog has no input');
    await box.click();
    await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
    await box.type(text);
    await sleep(250);
    const held = await page.evaluate(() => document.querySelector('[role=dialog] input')?.value ?? '');
    if (held !== text) bad(`the confirmation box holds ${JSON.stringify(held)}, not ${JSON.stringify(text)}`);
  };
  const searchSources = async (term) => {
    await page.goto(`${BASE}/discover/`, { waitUntil: 'networkidle2', timeout: 60_000 });
    const input = await page.waitForSelector('input[aria-label="Search all sources…"]', { timeout: 20_000 });
    // ⚠️ Type, then read it back, and type again if it did not stick. A keystroke that lands before this
    // page has hydrated is simply dropped; the form then submits an empty term and paints no cards, which
    // reads exactly like a search that found nothing. It cost a whole 390 px leg to find.
    const typed = await waitFor(async () => {
      await input.click();
      await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
      await input.type(term);
      await sleep(250);
      return (await page.evaluate(() => document.querySelector('input[aria-label="Search all sources…"]')?.value)) === term;
    }, 15_000, 500);
    if (!typed) bad(`the search box would not take ${JSON.stringify(term)}`);
    await clickText(/^Search$/);
    await waitFor(async () => (await cardTitles()).length > 0, 20_000);
  };
  /** The 18+ chip in the Discover header, by its pressed state. */
  const adultChip = (ms = 15_000) => findText(/^Show 18\+$/, 'button', ms);

  phase = 'login';
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60_000 });
  await page.waitForSelector('input[type=password]', { timeout: 30_000 });
  const fields = await page.$$('input');
  await fields[0].type(USER); await page.type('input[type=password]', PASS); await page.keyboard.press('Enter');
  await waitFor(async () => !(await page.$('input[type=password]')), 20_000);
  check(!(await page.$('input[type=password]')), 'one browser login', 'browser login did not leave the form');

  // ---- 3. Discover offers the reveal, and honours it -----------------------------------------------
  //
  // On the SEARCH, deliberately, and not on the "All sources" chip beside the wall: that chip counts the
  // sources that have a newest/popular listing, which a test stub does not have, so it is not rendered at
  // all on this instance. The cross-source search is the surface a person actually uses, it is one of the
  // six the hide now covers, and the card it paints names its providers.
  phase = 'discover';
  await page.goto(`${BASE}/discover/`, { waitUntil: 'networkidle2', timeout: 60_000 });
  const chipOff = await adultChip();
  check(!!chipOff, 'Discover renders the Show 18+ chip although no 18+ library exists',
    'Discover had no Show 18+ chip, so the hidden providers could never be asked for back');
  check(await chipOff?.evaluate((n) => n.getAttribute('aria-pressed')) === 'false',
    'the chip starts unpressed', 'the chip was already pressed on first paint');
  let askedB = Date.now();
  await searchSources('Walk Tale');
  await openCard('Walk Tale');
  const offeredOff = await bodyText();
  check(!/fake-b/.test(offeredOff), 'a title both providers carry is offered from the ordinary one only',
    'the add dialog offered the adult provider with the reveal off');
  check(/fake-a/.test(offeredOff), 'the ordinary provider is offered',
    'the add dialog named neither provider, so the check above proved nothing');
  check((await countSince(STUB_B, 'search', askedB)) === 0, 'and the adult provider was not asked for it',
    `the adult provider was searched ${await countSince(STUB_B, 'search', askedB)} time(s) with the reveal off`);
  await shot('discover-hidden');
  await closeDialog();
  await (await adultChip())?.click();
  // ⚠️ With the reveal on, nothing is hidden any more and `hiddenAdult` is 0 — a chip that decided on that
  // alone would vanish under the finger that pressed it, which is why the page also renders it while the
  // reveal is on. Pressed and still there is the assertion.
  const stillThere = await waitFor(async () => await (await adultChip(5_000))?.evaluate((n) => n.getAttribute('aria-pressed')) === 'true', 15_000);
  check(!!stillThere, 'the chip stays on screen once pressed, and reads as on',
    'the chip vanished, or never read as pressed, the moment it was pressed');
  // A term neither half of step 1 has asked for: the server caches a search for five minutes, and a term
  // it has already answered would prove nothing about who gets asked now.
  askedB = Date.now();
  await searchSources('Tale');
  await openCard('Walk Tale');
  const offeredOn = await bodyText();
  check(/fake-b/.test(offeredOn), 'pressing Show 18+ brings the provider back',
    'the adult provider was still missing from the add dialog after the reveal');
  check((await countSince(STUB_B, 'search', askedB)) >= 1, 'and the search now reaches it',
    'the revealed search still did not ask the adult provider');
  await shot('discover-revealed');
  // The dialog stays OPEN on the adult provider, for the duplicate step below.
  await clickText(/^fake-b/);
  await waitFor(async () => /From\s+fake-b/.test(await bodyText()), 8_000);

  // ---- the library the rest of this walk works on --------------------------------------------------
  // ⚠️ After step 3, never before it: Discover refuses to open the add dialog for a card that is already
  // in the library (discover/page.tsx `open` returns on `inLibrary`), so a walk that adds these two first
  // can only click cards that do nothing, and the provider assertions above would read an empty page.
  phase = 'add';
  // Nine of twelve: the other three are the ghosts step 9 counts, and nine is what step 9 reads to the end.
  const tale = await addFromA('walk-tale', 'Walk Tale', { chapterCount: 9, chapterFrom: 'oldest' });
  check(tale.job?.done === 9, 'Walk Tale added with its oldest nine chapters', `Walk Tale landed ${tale.job?.done ?? 'no'} of 9`);
  const taleId = tale.answer?.seriesId ?? tale.job?.seriesId ?? (await seriesByTitle('Walk Tale'))?.id;
  check(!!taleId, 'the add named the series it landed on', 'no series id came back from the Walk Tale add');

  // ---- 4. the duplicate prompt names the copy you already have (#67) -------------------------------
  //
  // The dialog opened in step 3 is still on screen, still offering this title from the OTHER provider,
  // and the library gained it while it sat there — the ordinary way anyone meets this prompt, since a card
  // the wall already knows is in the library cannot be opened at all.
  phase = 'duplicate';
  adds.length = 0;
  await clickText(/^Add to library$/);
  const dup = await waitFor(() => adds.find((a) => a.status === 409) || null, 20_000);
  check(!!dup, 'adding the same title from the other provider is refused as a duplicate',
    `the second add answered ${JSON.stringify(adds.map((a) => a.status))}`);
  check(!!dup?.body?.existing?.id, 'the duplicate answer names the copy it found',
    `the 409 body was ${JSON.stringify(dup?.body)}`);
  await shot('duplicate-prompt');
  await clickText(/^Open it$/);
  await waitFor(async () => /\/series\//.test(page.url()), 15_000);
  const dupOpened = new URL(page.url()).searchParams.get('id');
  check(dupOpened === dup?.body?.existing?.id && dupOpened === taleId,
    'Open it goes to the copy the server named',
    `Open it went to ${dupOpened}; the 409 said ${dup?.body?.existing?.id}; Walk Tale is ${taleId}`);

  phase = 'add';
  const gap = await addFromA('walk-gap', 'Walk Gap');
  check(gap.job?.done === 14, 'Walk Gap added with all fourteen chapters', `Walk Gap landed ${gap.job?.done ?? 'no'} of 14`);
  const gapId = gap.answer?.seriesId ?? gap.job?.seriesId ?? (await seriesByTitle('Walk Gap'))?.id;

  // ---- 5. a re-add fetches nothing the library already holds (#65) ---------------------------------
  phase = 'readd';
  // ⚠️ Auto-update is turned OFF first, on purpose. Removing a series leaves `source_id` and everything
  // else on the row exactly as it was, so "the source is still there afterwards" would pass even if the
  // re-add wrote nothing at all — the vacuous version of this check. The add's routing UPDATE writes
  // auto_update, source, source id and the floor in one statement, so a field this walk has just flipped
  // the other way is the one thing that can only be back because that statement ran.
  await api(`/api/admin/series/${gapId}`, { method: 'PATCH', json: { autoUpdate: false } });
  check((await api(`/api/series/${gapId}`)).autoUpdate === false, 'auto-update is off before the re-add',
    'could not turn auto-update off, so the stamping check below would prove nothing');
  await removeSeries(gapId);
  const beforeReadd = Date.now();
  await searchSources('Walk Gap');
  await openCard('Walk Gap');
  await clickText(/^fake-a/);
  await waitFor(async () => /14 chapters/.test(await bodyText()), 8_000);
  await clickText(/^Add to library$/);
  const readdDone = await waitFor(async () => /Added to your library/.test(await bodyText()), 20_000);
  check(!!readdDone, 're-adding a removed series reached the done step', 'the re-add dialog never finished');
  const readdText = await bodyText();
  check(/All 14 chapters are already in your library/.test(readdText),
    'the dialog says all fourteen chapters were already here',
    `the done step read: ${JSON.stringify(readdText.split('\n').filter(Boolean).slice(0, 8))}`);
  await shot('readd-nothing-to-fetch');
  await sleep(1500);
  const [pagesA, imagesA, pagesB, imagesB] = await Promise.all([
    countSince(STUB_A, 'pages', beforeReadd), countSince(STUB_A, 'image', beforeReadd),
    countSince(STUB_B, 'pages', beforeReadd), countSince(STUB_B, 'image', beforeReadd),
  ]);
  check(pagesA + imagesA + pagesB + imagesB === 0, 'not one page was fetched for it',
    `the re-add fetched: fake-a ${pagesA} page lists / ${imagesA} images, fake-b ${pagesB} / ${imagesB}`);
  const gapAgain = await api(`/api/series/${gapId}`);
  check(gapAgain.autoUpdate === true && (gapAgain.sources || []).some((s) => s.primary && s.sourceId === 'fake-a' && s.sourceSeriesId === 'walk-gap'),
    'the add still wrote the routing it owes the series, with nothing to fetch',
    `after the re-add: autoUpdate=${gapAgain.autoUpdate}, sources=${JSON.stringify(gapAgain.sources)}`);
  check((await booksOf(gapId)).length === 14, 'and every chapter is still on disk, not fetched again',
    `Walk Gap has ${(await booksOf(gapId)).length} chapters`);
  // Nothing is missing, so the "chapters the sources have that you don't" list is empty — which is what
  // makes "nothing was fetched" mean "nothing was missing" rather than "nothing was looked at". The
  // listing rows the same branch writes are counted for real in step 9, where three of them are missing.
  check((await listingOf(gapId)).length === 0, 'and nothing is left listed as missing',
    `Walk Gap still lists ${(await listingOf(gapId)).length} missing chapter(s)`);

  // ---- 6. a Delete-files tombstone IS fetched again (#65) -------------------------------------------
  phase = 'tombstone';
  const gapBooks = await booksOf(gapId);
  const chapterOne = gapBooks.find((b) => Number(b.number ?? b.metadata?.numberSort) === 1);
  check(!!chapterOne, 'Walk Gap chapter 1 has a row to delete', 'could not find Walk Gap chapter 1');
  await api(`/api/admin/series/${gapId}/chapters/delete`, { method: 'POST', json: { bookIds: [chapterOne.id] } });
  await removeSeries(gapId);
  const beforeTomb = Date.now();
  const backAgain = await addFromA('walk-gap', 'Walk Gap');
  check(backAgain.answer?.chapters === 1 && backAgain.answer?.alreadyHere === undefined,
    'the re-add counts exactly the deleted chapter', `the answer was ${JSON.stringify(backAgain.answer)}`);
  const fetched = new Set(rowsSince(await sourceLog(STUB_A), 'pages', beforeTomb).map((r) => r.chapter));
  check(fetched.size === 1 && fetched.has('walk-gap-1'),
    'only the chapter whose file was deleted was fetched again',
    `chapters fetched after the tombstone: ${JSON.stringify([...fetched])}`);

  // ---- 7. Open in library lands on the id the server gave (#67) ------------------------------------
  phase = 'openit';
  adds.length = 0;
  await searchSources('Ren');
  // No provider to pick: only fake-a carries this one, and a card with a single provider picks it itself
  // rather than offering a list of one.
  await openCard(CURLY);
  check(!!(await waitFor(async () => /3 chapters/.test(await bodyText()), 10_000)),
    'the add dialog counted the three chapters of the curly title',
    `the dialog did not reach a chapter count: ${JSON.stringify((await bodyText()).slice(0, 200))}`);
  await clickText(/^Add to library$/);
  check(!!(await waitFor(async () => /Added to your library/.test(await bodyText()), 20_000)),
    'the curly-titled series was added', 'the add dialog never finished for the curly title');
  // A fresh download is answered before persistScan has minted the row, so the id arrives on the card the
  // dialog is already polling. Waiting for it here is the point of the step, not a workaround.
  const card = await waitFor(async () => {
    const jobs = await api('/api/sources/jobs').catch(() => null);
    return jobs?.content?.find((j) => j.title === CURLY && j.seriesId) || null;
  }, 60_000, 400);
  check(!!card?.seriesId, 'the job card carries the series id once chapter one is scanned in',
    'the job card never carried a series id');
  // The dialog polls the same card every two seconds; give its own copy one cycle to arrive.
  await sleep(2_500);
  await clickText(/^Open in library$/);
  await waitFor(async () => /\/series\//.test(page.url()), 15_000);
  const openedId = new URL(page.url()).searchParams.get('id');
  check(openedId === card?.seriesId, 'Open in library went to that id, not to a title guess',
    `opened ${openedId}, the server said ${card?.seriesId}`);
  const openedRow = openedId ? await api(`/api/series/${openedId}`) : null;
  check(openedRow?.name === CURLY, 'and that id really is the series just added',
    `/api/series/${openedId} is ${JSON.stringify(openedRow?.name)}`);
  const curlyId = openedId;
  await shot('opened-by-id');

  // ---- 8. a title you cannot type still confirms (#66) ---------------------------------------------
  phase = 'confirm';
  await page.goto(`${BASE}/series/?id=${curlyId}`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await waitFor(async () => (await bodyText()).includes(CURLY), 20_000);
  await clickText(/^Remove from library$/);
  await waitFor(async () => /to confirm/.test(await bodyText()), 8_000);
  check(!!(await dialogButton('Copy title')), 'the dialog offers Copy title',
    'the dialog had no Copy title button (the clipboard probe found nothing, or the control is gone)');
  await typeConfirmation('Ren Walk Notes');
  check(await (await dialogButton('Remove'))?.evaluate((n) => n.disabled) === true,
    'a wrong title still refuses', 'the button armed on a title that was not the series');
  await typeConfirmation(TYPED);
  check(await (await dialogButton('Remove'))?.evaluate((n) => n.disabled) === false,
    'a straight apostrophe and a hyphen confirm the curly title',
    'the typed straight-quoted title did not arm the button');
  await shot('confirm-folded');
  await (await dialogButton('Remove'))?.click();
  const removed = await waitFor(async () => (await api(`/api/admin/series/deleted`)).content?.some((r) => r.id === curlyId), 20_000);
  check(!!removed, 'and the route accepted it: the series is removed', 'the confirmed Remove did not reach the server');

  // Delete files, from Admin → Library, where the removed series now is. Same fold, second route.
  await page.goto(`${BASE}/admin/?tab=Library`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await waitFor(async () => (await bodyText()).includes(CURLY), 20_000);
  await clickText(/^Delete files$/);
  await waitFor(async () => /to confirm/.test(await bodyText()), 8_000);
  await typeConfirmation(TYPED);
  check(await (await dialogButton('Delete files'))?.evaluate((n) => n.disabled) === false,
    'the same typed title arms Delete files', 'Delete files stayed disabled on the typed title');
  await (await dialogButton('Delete files'))?.click();
  const purged = await waitFor(async () => {
    const rows = (await api('/api/admin/series/deleted')).content || [];
    const row = rows.find((r) => r.id === curlyId);
    return row && Number(row.live_books) === 0 ? row : null;
  }, 20_000);
  check(!!purged, 'Delete files took the same typed title through the route',
    'the Delete files confirmation never reached the server');
  await shot('delete-files-folded');

  // Forget, over the route itself in both directions: it is the third dialog on the same fold, and the
  // refusal is the half that matters — loosening the client alone would have traded a dead button for a 400.
  const wrongForget = await api(`/api/admin/series/${curlyId}/forget`, { method: 'POST', raw: true, json: { confirm: 'Ren Walk Notes' } });
  check(wrongForget.status === 400 && wrongForget.body?.error === 'confirm_mismatch',
    'Forget still refuses a title that is not the series', `a wrong Forget answered ${wrongForget.status} ${JSON.stringify(wrongForget.body)}`);
  const rightForget = await api(`/api/admin/series/${curlyId}/forget`, { method: 'POST', raw: true, json: { confirm: TYPED } });
  check(rightForget.status !== 400 && rightForget.body?.error !== 'confirm_mismatch',
    'and accepts the typed one', `Forget with the typed title answered ${rightForget.status} ${JSON.stringify(rightForget.body)}`);

  // ---- 9. ghost chapters, and the status the tracker derives (PR #58) ------------------------------
  phase = 'ghosts';
  const { token: apiKey } = await api('/api/tokens', { method: 'POST', json: { name: 'walk42', scopes: ['read', 'write'] } });
  const komga = async (path, init = {}) => {
    const r = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'X-API-Key': apiKey, ...(init.json ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) },
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  const chapterList = (id) => komga(`/api/v1/series/${id}/books?unpaged=true&media_status=READY&deleted=false`);
  const trackerNumbers = (id) => komga(`/api/v2/series/${id}/read-progress/tachiyomi`);
  // Mihon's own arithmetic, KomgaApi.kt:70-74 — the reason ghosts may not be counted.
  const statusOf = (p) => p.booksCount === p.booksUnreadCount ? 'UNREAD'
    : p.booksCount === p.booksReadCount ? 'COMPLETED' : 'READING';

  const marked = await komga(`/api/v2/series/${taleId}/read-progress/tachiyomi`, { method: 'PUT', json: { lastBookNumberSortRead: 9 } });
  check(marked.status === 204, 'every chapter this server holds of Walk Tale is marked read', `the tracker PUT answered ${marked.status}`);
  const offList = await chapterList(taleId);
  const offProgress = await trackerNumbers(taleId);
  check(offList.body?.content?.length === 9, 'with the switch off the phone sees the nine chapters on disk',
    `the chapter list carried ${offList.body?.content?.length} rows`);
  check(statusOf(offProgress.body) === 'COMPLETED', 'and the tracker reads COMPLETED',
    `off: ${JSON.stringify(offProgress.body)} -> ${statusOf(offProgress.body)}`);

  await api('/api/admin/settings', { method: 'PATCH', json: { komgaGhostChapters: true } });
  const onList = await chapterList(taleId);
  const onProgress = await trackerNumbers(taleId);
  const ghostRows = (onList.body?.content || []).filter((b) => String(b.id).startsWith('g_'));
  check(onList.body?.content?.length === 12 && ghostRows.length === 3,
    'with it on the three chapters this server never fetched are listed too',
    `the list carried ${onList.body?.content?.length} rows, ${ghostRows.length} of them ghosts`);
  check(ghostRows.every((b) => b.media?.pagesCount === 0 && b.media?.status === 'READY'),
    'a ghost reports no pages, so tapping one opens nothing rather than a broken page',
    `ghost rows: ${JSON.stringify(ghostRows.map((b) => ({ id: b.id, pages: b.media?.pagesCount, status: b.media?.status })))}`);
  check(Number(onProgress.body?.maxNumberSort) === 12 && Number(offProgress.body?.maxNumberSort) === 9,
    'the chapter total the tracker reports rises from 9 to 12 — which is what the switch is for',
    `maxNumberSort: ${offProgress.body?.maxNumberSort} -> ${onProgress.body?.maxNumberSort}`);
  check(onProgress.body?.booksCount === offProgress.body?.booksCount
    && onProgress.body?.booksReadCount === offProgress.body?.booksReadCount
    && onProgress.body?.booksUnreadCount === offProgress.body?.booksUnreadCount,
    'and the counts do not move: a ghost is listed, never counted',
    `counts off ${JSON.stringify(offProgress.body)} vs on ${JSON.stringify(onProgress.body)}`);
  check(statusOf(onProgress.body) === 'COMPLETED',
    'so a series read to the end is still COMPLETED once ghosts appear',
    `on: ${JSON.stringify(onProgress.body)} -> ${statusOf(onProgress.body)}`);

  await api('/api/admin/settings', { method: 'PATCH', json: { komgaGhostChapters: false } });
  const backOffList = await chapterList(taleId);
  const backOffProgress = await trackerNumbers(taleId);
  check(backOffList.body?.content?.length === 9
    && JSON.stringify(backOffProgress.body) === JSON.stringify(offProgress.body),
    'turning it off puts both answers back exactly as they were',
    `off again: ${backOffList.body?.content?.length} rows, ${JSON.stringify(backOffProgress.body)}`);

  // ---- the page itself -----------------------------------------------------------------------------
  phase = 'console';
  check(consoleErrors.length === 0, 'zero browser-console errors', `browser console: ${consoleErrors.slice(0, 8).join(' | ')}`);
} catch (error) {
  bad(`[${phase}] threw: ${String(error).slice(0, 300)}`);
} finally {
  if (restoreMangaDex) await api('/api/admin/sources/mangadex/enable', { method: 'POST' }).catch(() => {});
  await api('/api/admin/settings', { method: 'PATCH', json: { komgaGhostChapters: false } }).catch(() => {});
  await browser.close();
}

console.log(`\n${failures.length ? `${failures.length} failed` : 'all checks passed'} (${WIDTH}px)`);
if (failures.length) process.exit(1);
