// Browser acceptance walk for v0.49.1: Find other sources (with its review), a series' Other names, and "the site says it
// is offline".
//
// Why this release: aqua, the owner's main source, has answered every request since 2026-09-23 with one small HTML
// page, "Aqua Manga is temporarily offline" -- HTTP 200 -- and Health blamed its markup. 189 of its series had no
// second source. v0.49.1 reads the notice for what it is and offers a calm background search for other sources for
// every series of a source, a selection, or one series, whose review is where the admin chooses what to follow. The
// idea and the review are @TIGamingTV's (PR #119).
//
// Here fake-a plays aqua: its stub's `offline` behaviour (fakeSource.mjs, scripted on "site") answers every route
// with such a page, and the adapter (bff lib/sources/fake.ts) hands it to the product's own offlineNotice, so every
// word Health says about it comes from the same path an engine takes. fake-b carries the same series and is what a
// run finds. Run on an instance of its own, once per width, each on a fresh instance:
//
//   KEEP=1 E2E_NO_WALK=1 E2E_MIN_FREE_GB=0 E2E_IMAGE=uchiyomi:e2e-v491w E2E_NET=uchi-w491 E2E_PORT=18191 \
//     E2E_SUBNET=10.222.91.0/24 bash web/test/e2e/up.sh
//   cd web && WIDTH=1280 BASE=http://127.0.0.1:18191 node test/e2e/walk491.mjs
//   (again with WIDTH=390 on a fresh instance; the Arabic pass once, with PHASES=offline,arabic)
//
// Phases, run in this order whatever PHASES lists (the default is every phase but arabic):
//
//   offline -- fake-a says it is offline. Walk Tale (12 chapters) and Walk Gap (fake-a lists only 2 of its numbers)
//     are added from fake-a, fake-b is checked NOT to be followed (followed anyway, it is unfollowed through the
//     Sources sheet), and fake-a goes offline. Providers -> Test fake-a says "The site says it is offline (its own
//     page)", and "the site says it is offline" at the search step; Health -> Source health's fake-a row says the same
//     with the fix sentence, and offers "Find other sources (2 series)". The API row carries the same code and count.
//   run -- that key, pressed. It opens the search's review, which fills in while it goes; Library -> Downloads' Server
//     tasks shows its card with "1 of 2 series", the series it is on, Stop and Review. It ends waiting for a review,
//     having followed NOTHING: Walk Tale shows fake-b as a green match (the same series), Walk Gap says it was not
//     searched and why. Select exact matches and Follow 1 selected source follow fake-b; Walk Tale's Sources sheet
//     then lists it, and its "12 chapters listed" appears within a bounded wait: the follow's paced listing refresh.
//   stop -- a search over four series, stopped from its card at once. It ends `stopped` (never `interrupted`), every
//     series it never reached reads "Not searched yet" -- never nothing found -- and the review offers to search on.
//   names -- Walk Tale's Other names: a Latin name of 5+ letters is listed; a short one, a non-Latin one and the same
//     one again are each refused in their own words; removing it clears it, and the refusal that no longer holds;
//     typed again by hand, the removed name comes back. With fake-b unfollowed through the sheet, Find more sources
//     opens a search of that one series whose review offers fake-b again, and following it lists it again.
//   select -- Library: two series selected, More -> Find other sources opens the review of a search of 2. Move to
//     library, Remove from library and Find other sources are rows of More at every width, never keys of the bar.
//   arabic -- the one pass in Arabic (needs offline before it): the Health row -- its detail too, worded by its codes
//     -- the running card and the review read right to left, what is still the server's or the source's English
//     (the source's own error line, the series title, the source name) keeps its own direction, and the numbers are
//     intact. Its words come from web/public/locales/ar.json, never a copy.
//
// At every width: no sideways scroll on any page or sheet the walk opens; at 390 the card's series line and the
// review's long title wraps inside the page. Timing is read off the API (GET /api/admin/sources/find, /api/sources/jobs), not
// slept: a run that must be seen running is held by fake-b's own `slow:` search, never by a sleep here.
//
// ⚠️ One API login and one browser login per run: the route allows ten per five minutes.
// ⚠️ No isMobile at 390: a mobile-emulated reload can sign the page out, and the layout is the width's.
// ⚠️ The failure hunt is switched off for the walk and put back after: a sweep meeting offline fake-a could follow
// fake-b on its own and leave the run nothing to find. MangaDex is off too (a real site has no place here).
// ⚠️ The instance's first sweep and daily check come ten minutes after its boot. A run waits for either; every wait
// here is long enough to ride one out, and a wait that gives up prints the state it last read (a run's `waiting`).
//
// Screenshots go to $OUT (default shots491). LOOK at them: a walk that passes on a sign-in page or an error page is a
// failure, and geometry checks pass on a card that is clipped or unreadable.
import puppeteer from 'puppeteer';
import { mkdirSync, readFileSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:18191';
const USER = process.env.E2E_USER || 'e2e';
const PASS = process.env.E2E_PASS || 'e2e-passw0rd-123';
const OUT = process.env.OUT || 'shots491';
const WIDTH = Number(process.env.WIDTH || 1280);
const PHONE = WIDTH < 600;
const PHASES = (process.env.PHASES || 'offline,run,stop,names,select').split(',').map((s) => s.trim()).filter(Boolean);
// The fake sources' control ports, as up.sh derives them from the app's port.
const FAKE_A_PORT = 20_000 + (Number(new URL(BASE).port || 80) % 1000) * 2;
const FAKE_A = process.env.FAKE_A_URL || `http://127.0.0.1:${FAKE_A_PORT}`;
const FAKE_B = process.env.FAKE_B_URL || `http://127.0.0.1:${FAKE_A_PORT + 1}`;
/** Walk Tale's title in this library: long enough that a phone must cut it (Edit details writes it). */
const LONG = 'Walk Tale — the long way round, told one chapter at a time until the line runs out of screen';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`  [${ok ? ' ok ' : 'FAIL'}] ${name}${!ok && detail ? `\n         ${String(detail).slice(0, 900)}` : ''}`);
};
const waitFor = async (fn, ms = 10_000, step = 250) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(step);
  }
};
const tag = `${WIDTH}`;

const KNOWN_PHASES = ['offline', 'run', 'stop', 'names', 'select', 'arabic'];
const unknown = PHASES.filter((p) => !KNOWN_PHASES.includes(p));
check(`PHASES names only phases this walk has (${KNOWN_PHASES.join(', ')})`, !unknown.length, `not a phase here: ${unknown.join(', ')}`);

// ---- an API session (one login) and the stubs -----------------------------------------------------------------
const login = await (await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) })).json();
const TOKEN = login.accessToken;
if (!TOKEN) { console.error('could not sign in to the API'); process.exit(2); }
const api = async (path, opts = {}) => {
  const r = await fetch(BASE + path, { ...opts, headers: { authorization: `Bearer ${TOKEN}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) } });
  const raw = await r.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
  if (!r.ok) throw Object.assign(new Error(`${opts.method || 'GET'} ${path} -> ${r.status} ${raw.slice(0, 200)}`), { status: r.status, body });
  return body;
};
const post = (path, json = {}) => api(path, { method: 'POST', body: JSON.stringify(json) });
const control = async (base, path, body) => {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${base}${path} ${JSON.stringify(body)} -> ${r.status}`);
  return r.json();
};
const script = (base, chapter, behaviour) => control(base, '/__script', { chapter, page: 0, behaviour });

/** GET /api/admin/sources/find: whether a run goes, the running or newest run, the kept ones. */
const findState = () => api('/api/admin/sources/find');
/** The find_sources card on the jobs route (Server tasks), or null. */
const jobCard = async () => ((await api('/api/sources/jobs')).runs ?? []).find((r) => r.kind === 'find_sources') ?? null;
/** One series' sources, as the series page reads them. */
const sourcesOf = async (id) => (await api(`/api/series/${encodeURIComponent(id)}`)).sources ?? [];
/** fake-a's row on Health's Source health check, from the API. */
const healthRow = async (sourceId) => ((await api('/api/admin/health')).checks ?? [])
  .find((c) => c.id === 'sources')?.items?.find((i) => i.sourceId === sourceId) ?? null;
/**
 * Wait for the run `id` to end, and hand back its state. Long enough to ride out a sweep or a daily check the run
 * waits for (the instance's first of each comes ten minutes after its boot).
 */
const runEnded = (id, ms = 150_000) => waitFor(async () => {
  const s = await findState();
  const run = (s.recent ?? []).find((r) => r.id === id);
  return run && run.status !== 'running' ? run : null;
}, ms, 1000);
/** A run's review, from the API. */
const reviewOf = (id) => api(`/api/admin/sources/find/${encodeURIComponent(id)}?adult=1`);

// ---- the browser, signed in once ------------------------------------------------------------------------------
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], defaultViewport: { width: WIDTH, height: PHONE ? 844 : 900 } });
const serverErrors = [];
const consoleErrors = [];
const page = await browser.newPage();
/**
 * Whether the first letter of `el`'s text is drawn inside `box`: a title cut short must show how it BEGINS. An English
 * title cut inside a right-to-left line spills off its start instead, and shows only its tail ("…runs out of screen").
 * Installed in every document the walk opens, for the measurements below.
 */
await page.evaluateOnNewDocument(() => {
  window.__firstShown = (el, box) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() ? 1 : 3) });
    const t = walker.nextNode();
    if (!t) return null;
    const at = t.textContent.search(/\S/);
    const range = document.createRange();
    range.setStart(t, at);
    range.setEnd(t, at + 1);
    const c = range.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    return c.width > 0 && c.left >= b.left - 0.5 && c.right <= b.right + 0.5;
  };
});
page.on('response', (r) => { if (r.status() >= 500) serverErrors.push(`${r.status()} ${r.url()}`); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/401|409|auth\/me|Failed to load resource/.test(m.text())) consoleErrors.push(m.text()); });
await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForSelector('input[type=password]', { timeout: 30000 });
await sleep(2500); // the form renders again once /auth/config answers; typing before that is lost
await page.type('input:not([type=password])', USER);
await page.type('input[type=password]', PASS);
await page.keyboard.press('Enter');
check('signed in', !!(await waitFor(async () => !(await page.$('input[type=password]')), 20_000)));

const go = async (path, wait = 2000) => {
  await page.goto(BASE + path, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  await sleep(wait);
  // The Health banner is another step's; on a phone it takes a third of the screen. Its one button is its Not now, in
  // the page's language: matched by the English words, the Arabic pass's banner stayed on top of every page.
  await page.evaluate(() => document.querySelector('[data-health-banner] button')?.click());
  // Never measure a sign-in page: every check after this would pass on it or fail for the wrong reason.
  if (await page.$('input[type=password]')) throw new Error(`${path} opened on the sign-in page`);
};
const shot = async (name) => {
  await sleep(400); // a beat: blurred cards scrolled into view are painted a frame late
  await page.screenshot({ path: `${OUT}/${tag}-${name}.png` });
  console.log(`         shot ${tag}-${name}`);
};
/** The page is no wider than the screen: a sideways scroll is the one layout fault a phone always shows. */
const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
/** A DOM click on the first button (or link) inside `root` whose trimmed text is `text`. */
const press = (text, root = 'body') => page.evaluate((t, root) => {
  const b = [...(document.querySelector(root)?.querySelectorAll('button, a') ?? [])].find((x) => x.textContent?.trim() === t);
  b?.click();
  return !!b;
}, text, root);
const bodyText = () => page.evaluate(() => document.body.innerText || '');

// ---- the library the walk works on ----------------------------------------------------------------------------
const allSeries = async () => (await post('/api/series/search', { query: '', size: 100 })).content ?? [];
const seriesNamed = async (...names) => (await allSeries()).find((s) => names.includes(s.name) || names.includes(s.metadata?.title)) ?? null;
const S = {};

/** Walk Tale and Walk Gap from fake-a, fake-b followed by neither, and the two series seed.py wrote to disk. */
async function library() {
  // up.sh asked for the scan of the seeded folders; wait for it rather than ask again (one scan a minute).
  const mixed = await waitFor(() => seriesNamed('Mixed Formats'), 60_000, 1000);
  const repeated = await waitFor(() => seriesNamed('Repeated Pages'), 60_000, 1000);
  check('the seeded series are in the library', !!mixed && !!repeated);
  // fake-a lists Walk Gap's 1 and 2 only: under judgeCandidate's three numbers, so a run skips it unsearched.
  let gap = await seriesNamed('Walk Gap');
  if (!gap) {
    await script(FAKE_A, 'walk-gap', 'omit:3-14');
    await post('/api/sources/add', { source: 'fake-a', sourceId: 'walk-gap', chapterCount: 2, chapterFrom: 'oldest', autoUpdate: true });
    gap = await waitFor(() => seriesNamed('Walk Gap'), 120_000, 1000);
  }
  // No `alsoFollow`: nothing is followed on the way in. All twelve chapters, as a library that kept up holds them.
  // ⚠️ Not fewer: with fake-a offline, unfollowing fake-b (names) deletes the only listing rows the series has left,
  // and a candidate is then measured against the chapters on disk alone -- four of twelve read as another book.
  let tale = await seriesNamed('Walk Tale', LONG);
  if (!tale) {
    await post('/api/sources/add', { source: 'fake-a', sourceId: 'walk-tale', chapterCount: 12, chapterFrom: 'oldest', autoUpdate: true });
    tale = await waitFor(() => seriesNamed('Walk Tale'), 120_000, 1000);
  }
  check('Walk Tale and Walk Gap were added from fake-a', !!tale && !!gap);
  if (!tale || !gap || !mixed || !repeated) throw new Error('the walk has no library to work on');
  const settled = await waitFor(async () => !((await api('/api/sources/jobs')).content ?? []).some((j) => j.status === 'downloading'), 180_000, 1000);
  check('their downloads finished', !!settled);
  // Edit details' title: shown everywhere a run names the series, while the run searches under the source's own.
  if (tale.name !== LONG) await api(`/api/admin/series/${tale.id}/meta`, { method: 'PUT', body: JSON.stringify({ title: LONG }) });
  Object.assign(S, { tale: tale.id, gap: gap.id, mixed: mixed.id, repeated: repeated.id });
}

/** Open a series' Sources & translations sheet, from the supply line under its title. */
async function openSourcesSheet(id) {
  await go(`/series/?id=${encodeURIComponent(id)}`, 2500);
  await page.evaluate(() => [...document.querySelectorAll('button[aria-haspopup="dialog"]')].find((b) => b.offsetParent && b.classList.contains('w-full'))?.click());
  return !!(await waitFor(() => page.$('[role="dialog"] [data-alt-titles]'), 15_000));
}
/** A source's row in the open Sources sheet: its text, and whether it can be unfollowed. */
const sheetSource = (name) => page.evaluate((name) => {
  const dlg = document.querySelector('[role="dialog"]');
  const span = [...(dlg?.querySelectorAll('span.truncate') ?? [])].find((s) => s.textContent?.trim() === name);
  const row = span?.closest('div.py-2');
  return row ? { text: row.innerText.replace(/\s+/g, ' ').trim(), unfollow: !!row.querySelector(`button[aria-label="Stop following ${name}"]`) } : null;
}, name);

/** Health -> Source health, open, and fake-a's row as the page shows it. */
async function openSourceHealth() {
  await go('/admin/?tab=Health', 2500);
  const card = await page.waitForSelector('[data-health-check="sources"]', { timeout: 45_000 }).catch(() => null);
  if (!card) return false;
  if (!(await page.$('#health-sources-details'))) {
    await page.$eval('[data-health-check="sources"] button', (b) => { b.scrollIntoView({ block: 'center' }); b.click(); });
  }
  return !!(await waitFor(() => page.$('#health-sources-details'), 10_000));
}
const healthRowOnPage = (sourceId) => page.evaluate((id) => {
  const row = [...document.querySelectorAll('[data-health-check="sources"] [data-health-item]')]
    .find((r) => r.querySelector('p[dir="auto"]')?.textContent?.trim() === id);
  if (!row) return null;
  const ps = [...row.querySelectorAll(':scope p[dir="auto"]')];
  const key = row.querySelector('button[data-health-action="find_sources"]');
  const stage = row.querySelector('[data-evidence-stage="search"]');
  // The search step's error: the source's own words as the server kept them, English in every language.
  const err = stage?.querySelector('p[dir="auto"]');
  const ev = row.querySelector('[data-source-evidence]');
  const fix = ev ? [...ev.querySelectorAll(':scope > p[dir="auto"]')].pop() : null;
  return {
    text: row.innerText.replace(/\s+/g, ' ').trim(),
    detail: ps[1]?.textContent ?? '', detailDir: ps[1] ? getComputedStyle(ps[1]).direction : null, detailAuto: ps[1]?.getAttribute('dir') === 'auto',
    fix: fix?.textContent ?? '', fixDir: fix ? getComputedStyle(fix).direction : null,
    stage: stage?.getAttribute('data-evidence-state') ?? null, stageText: stage?.querySelector('bdi')?.textContent ?? '',
    error: err?.textContent ?? '', errorDir: err ? getComputedStyle(err).direction : null, errorAuto: err?.getAttribute('dir') === 'auto',
    key: key?.textContent?.trim() ?? null, keyDisabled: key ? key.disabled : null,
    status: [...row.querySelectorAll('[data-action-status]')].map((s) => `${s.getAttribute('data-action-status')}: ${s.textContent}`),
  };
}, sourceId);

/** The find_sources card under Library -> Downloads -> Server tasks, measured. */
const cardOnPage = () => page.evaluate(() => {
  const li = document.querySelector('[data-downloads-section="tasks"] li[data-task="find_sources"]');
  if (!li) return null;
  const now = [...li.querySelectorAll('p')].find((p) => p.querySelector('bdi'));
  const bdi = now?.querySelector('bdi');
  // What cuts the title: its own box when it truncates itself -- which it must, to be cut at its own end inside a
  // right-to-left line -- else the line.
  const cut = bdi && getComputedStyle(bdi).textOverflow === 'ellipsis' ? bdi : now;
  const r = li.getBoundingClientRect();
  return {
    state: li.getAttribute('data-state'), text: li.innerText.replace(/\s+/g, ' ').trim(), name: li.querySelector('[data-task-name]')?.textContent ?? '',
    now: now ? {
      text: now.textContent, title: bdi.textContent, dir: getComputedStyle(bdi).direction, truncated: cut.scrollWidth > cut.clientWidth + 1,
      ellipsis: getComputedStyle(cut).textOverflow, startShown: window.__firstShown(bdi, now),
    } : null,
    stop: [...li.querySelectorAll('button')].map((b) => b.textContent.trim()).filter((t) => !/›$/.test(t)),
    review: !!li.querySelector('[data-find-review]'),
    inside: r.left >= -0.5 && r.right <= innerWidth + 0.5, overflow: li.scrollWidth > li.clientWidth + 1,
  };
});
/** The review page (app/admin/find/page.tsx), its series and their matches, measured. */
const reviewOnPage = () => page.evaluate(() => {
  const row = document.querySelector('[data-action-row="find-run"]');
  if (!row) return null;
  const items = [...document.querySelectorAll('[data-find-item]')].map((el) => {
    const a = el.querySelector('a');
    return {
      state: el.getAttribute('data-find-item'), title: a?.textContent ?? '',
      titleDir: a ? getComputedStyle(a).direction : null, titleAuto: a?.getAttribute('dir') === 'auto',
      note: el.querySelector('[data-find-note]')?.textContent ?? '', text: el.innerText.replace(/\s+/g, ' ').trim(),
      candidates: [...el.querySelectorAll('[data-find-candidate]')].map((c) => {
        const b = c.querySelector('bdi');
        return { verdict: c.getAttribute('data-find-candidate'), source: b?.textContent ?? '', sourceDir: b ? getComputedStyle(b).direction : null, text: c.innerText.replace(/\s+/g, ' ').trim() };
      }),
    };
  });
  return {
    items, head: row.querySelector('p')?.textContent ?? '', line: row.querySelector('[data-action-status]')?.textContent ?? '',
    stop: !!document.querySelector('[data-find-stop]'), preselect: !!document.querySelector('[data-find-preselect]'),
    follow: document.querySelector('[data-find-follow]')?.textContent?.trim() ?? null,
    resume: document.querySelector('[data-find-resume]')?.textContent?.trim() ?? null,
  };
});
/** The review's series whose link names `title`. */
const itemOf = (view, title) => view?.items?.find((i) => i.title === title) ?? null;
/** The card in the middle of the screen: scrolled to the top, a phone's sticky Library header covers it. */
const cardIntoView = () => page.$eval('[data-downloads-section="tasks"] li[data-task="find_sources"]', (el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
/** The review opened from the Server tasks card's Review. */
const openReviewFromCard = async () => {
  await page.$eval('[data-downloads-section="tasks"] li[data-task="find_sources"] [data-find-review]', (b) => { b.scrollIntoView({ block: 'center' }); b.click(); });
  return waitFor(async () => (/\/admin\/find\/\?run=/.test(page.url()) ? reviewOnPage() : null), 15_000);
};
/** The page a start navigated to: the review of run `id`. */
const onReviewOf = (id) => waitFor(async () => (page.url().includes(`/admin/find/?run=${id}`) ? reviewOnPage() : null), 15_000);
/** Select exact matches, then Follow selected; answers once the footer has said it. */
const followExact = async () => {
  await page.$eval('[data-find-preselect]', (b) => { b.scrollIntoView({ block: 'center' }); b.click(); });
  const ready = await waitFor(() => page.$eval('[data-find-follow]', (b) => (!b.disabled ? b.textContent.trim() : null)).catch(() => null), 5000);
  if (ready) await page.$eval('[data-find-follow]', (b) => b.click());
  return ready;
};
const closeSheet = async () => { await page.keyboard.press('Escape'); await waitFor(async () => !(await page.$('[role="dialog"]')), 5000); };

/** fake-a offline, and Health knowing it: a PHASES without `offline` still needs both. */
async function ensureOffline() {
  await script(FAKE_A, 'site', 'offline');
  if ((await healthRow('fake-a'))?.diagnosis?.code !== 'site_offline') await post('/api/admin/sources/fake-a/test');
}

// ---- 1. offline ------------------------------------------------------------------------------------------------
async function offline() {
  // Nothing followed on the way in (no `alsoFollow`); if something was, the brief's way back: the Sources sheet.
  for (const id of [S.tale, S.gap]) {
    if (!(await sourcesOf(id)).some((s) => s.sourceId === 'fake-b')) continue;
    check(`fake-b was followed on ${id} on the way in: unfollowing it through the Sources sheet`, true);
    await openSourcesSheet(id);
    await page.$eval('[role="dialog"] button[aria-label="Stop following fake-b"]', (b) => b.click()).catch(() => {});
    await waitFor(async () => !(await sourcesOf(id)).some((s) => s.sourceId === 'fake-b'), 15_000);
    await closeSheet();
  }
  check('fake-b is followed by neither of fake-a\'s series', !(await sourcesOf(S.tale)).some((s) => s.sourceId === 'fake-b')
    && !(await sourcesOf(S.gap)).some((s) => s.sourceId === 'fake-b'));

  await script(FAKE_A, 'site', 'offline');
  // Providers -> Test: the check an admin runs by hand.
  const card = '[data-source-card="fake-a"]';
  await go('/admin/?tab=Providers', 2500);
  await page.waitForSelector(`${card} [data-source-test="fake-a"]`, { timeout: 30_000 });
  await page.$eval(card, (el) => el.scrollIntoView({ block: 'center' }));
  await page.click(`${card} [data-source-test="fake-a"]`);
  const failed = await waitFor(() => page.$(`${card} [data-source-evidence="test"] [data-evidence-stage="search"][data-evidence-state="fail"]`), 60_000, 300);
  check(`${tag}: Providers -> Test fake-a fails at the search step`, !!failed);
  const test = await page.$eval(`${card} [data-source-evidence="test"]`, (el) => ({
    head: el.querySelector('[data-evidence-head]')?.textContent?.trim() ?? '',
    stage: el.querySelector('[data-evidence-stage="search"] bdi')?.textContent ?? '',
    text: el.innerText,
  })).catch(() => null);
  // The head is the diagnosis's reason as the web words its code (lib/said.ts REASON_WORDS), which Health's row ends
  // with a full stop: matched inside, not whole.
  check(`${tag}: ...and says "The site says it is offline (its own page)", and at the search step "the site says it is offline"`,
    (test?.head ?? '').includes('The site says it is offline (its own page)') && test?.stage === 'the site says it is offline', JSON.stringify(test));
  check(`${tag}: ...never "markup may not match this engine"`, !/markup may not match/.test(test?.text ?? ''), test?.text);
  check(`${tag}: ...with the fix sentence`, /Wait for the site to come back, or find other sources for its series\./.test(test?.text ?? ''), test?.text);
  await page.$eval(card, (el) => el.scrollIntoView({ block: 'center' }));
  await shot('offline-1-providers-test');

  // Health -> Source health: the row, its evidence, its fix and its key.
  check(`${tag}: Health -> Source health opens`, await openSourceHealth());
  const row = await waitFor(async () => { const r = await healthRowOnPage('fake-a'); return r?.key ? r : null; }, 30_000);
  check(`${tag}: Health lists fake-a with "The site says it is offline (its own page)"`,
    /The site says it is offline \(its own page\)/.test(row?.detail ?? ''), JSON.stringify(row));
  check(`${tag}: ...with the fix sentence under it`, row?.fix === 'Wait for the site to come back, or find other sources for its series.', JSON.stringify(row));
  check(`${tag}: ...its search step marked failing, as the site's own page`, row?.stage === 'fail' && row?.stageText === 'the site says it is offline', JSON.stringify(row));
  check(`${tag}: ...and it offers "Find other sources (2 series)"`, row?.key === 'Find other sources (2 series)' && row?.keyDisabled === false, JSON.stringify(row));
  const item = await healthRow('fake-a');
  check(`${tag}: the API row is the same finding: site_offline, find_sources, 2 series`,
    item?.diagnosis?.code === 'site_offline' && item?.diagnosis?.reason === 'The site says it is offline (its own page)'
    && item?.actions?.includes('find_sources') && item?.findSeries === 2 && !item?.info,
    JSON.stringify(item && { diagnosis: item.diagnosis, actions: item.actions, findSeries: item.findSeries, info: item.info }));
  check(`${tag}: Health has no sideways scroll`, await noSideScroll());
  await page.evaluate(() => [...document.querySelectorAll('[data-health-check="sources"] [data-health-item]')]
    .find((r) => r.querySelector('p[dir="auto"]')?.textContent?.trim() === 'fake-a')?.scrollIntoView({ block: 'center' }));
  await shot('offline-2-health-row');
}

// ---- 2. run ----------------------------------------------------------------------------------------------------
async function run() {
  await ensureOffline();
  // Held on Walk Tale: fake-b answers its search after 15 s, so the card is seen running -- under the adapter's own
  // 20 s limit, past which the search would count as unanswered. (Walk Gap goes first -- the series that follow
  // nothing first, then by title -- and is decided from the database at once.)
  await script(FAKE_B, 'search', 'slow:15000');
  const before = (await findState()).run?.id ?? null;
  if (!(await openSourceHealth())) throw new Error('Health -> Source health did not open');
  const pressed = await waitFor(() => page.evaluate(() => {
    const row = [...document.querySelectorAll('[data-health-check="sources"] [data-health-item]')]
      .find((r) => r.querySelector('p[dir="auto"]')?.textContent?.trim() === 'fake-a');
    const b = row?.querySelector('button[data-health-action="find_sources"]');
    if (!b || b.disabled) return false;
    b.scrollIntoView({ block: 'center' });
    b.click();
    return true;
  }), 30_000);
  check(`${tag}: Health's Find other sources is pressed`, !!pressed);
  const started = await waitFor(async () => { const s = await findState(); return s.running && s.run && s.run.id !== before ? s.run : null; }, 15_000);
  check(`${tag}: a search starts, over fake-a's 2 series`, started?.total === 2, JSON.stringify(started));
  const opened = started ? await onReviewOf(started.id) : null;
  check(`${tag}: the key opens the search's review, searching, with Stop`, !!opened?.stop, JSON.stringify(opened));
  check(`${tag}: the review has no sideways scroll`, await noSideScroll());
  await shot('run-1-review-searching');

  await go('/library/?view=downloads', 1500);
  const running = await waitFor(async () => { const c = await cardOnPage(); return c?.state === 'running' && /1 of 2 series/.test(c.text) && c.now ? c : null; }, 20_000, 300);
  check(`${tag}: Library -> Downloads -> Server tasks shows the search: Other-source search, 1 of 2 series`,
    running?.name === 'Other-source search' && /1 of 2 series/.test(running?.text ?? ''), JSON.stringify(running ?? await cardOnPage()));
  check(`${tag}: ...the series it is on`, running?.now?.title === LONG && /^Now: /.test(running?.now?.text ?? ''), JSON.stringify(running?.now));
  check(`${tag}: ...Stop, and the way to its review`, !!running?.stop?.includes('Stop') && !!running?.review, JSON.stringify(running));
  check(`${tag}: the card has no sideways overflow`, !!running?.inside && !running?.overflow && (await noSideScroll()), JSON.stringify(running));
  if (PHONE) check(`${tag}: ...and the long title is cut, not wrapped or spilled`, !!running?.now?.truncated && running?.now?.ellipsis === 'ellipsis', JSON.stringify(running?.now));
  check(`${tag}: ...at its end: the title's beginning shows`, running?.now?.startShown === true, JSON.stringify(running?.now));
  const apiCard = await jobCard();
  check(`${tag}: the jobs route carries the card: find_sources, its run, done/total, the current series`,
    apiCard?.status === 'running' && apiCard?.total === 2 && apiCard?.runId === started?.id && apiCard?.current?.title === LONG, JSON.stringify(apiCard));
  await cardIntoView();
  await shot('run-2-card-running');

  const done = started ? await runEnded(started.id) : null;
  check(`${tag}: the search ends waiting for a review, one match open`, done?.status === 'review' && done?.found === 1 && done?.open === 1, JSON.stringify(done ?? (await findState()).run));
  await script(FAKE_B, 'search', 'ok');
  check(`${tag}: ...and it followed nothing by itself`, !(await sourcesOf(S.tale)).some((x) => x.sourceId === 'fake-b'), JSON.stringify(await sourcesOf(S.tale)));
  const rv = done ? await reviewOf(done.id) : null;
  const tale = rv?.items?.find((i) => i.seriesId === S.tale);
  const gap = rv?.items?.find((i) => i.seriesId === S.gap);
  check(`${tag}: Walk Tale has fake-b as a green match`, tale?.candidates?.length === 1 && tale.candidates[0].source === 'fake-b' && tale.candidates[0].verdict === 'ok', JSON.stringify(tale));
  check(`${tag}: Walk Gap was not searched: too few numbers to compare`, gap?.state === 'skipped' && gap?.note === 'too_few', JSON.stringify(gap));
  const finished = await waitFor(async () => { const c = await cardOnPage(); return c?.state === 'done' ? c : null; }, 20_000, 500);
  check(`${tag}: the card says it is done: 2 of 2 series, sources found for 1 series`, /2 of 2 series/.test(finished?.text ?? '') && /Sources found for 1 series/.test(finished?.text ?? ''), JSON.stringify(finished));
  await cardIntoView();
  await shot('run-3-card-done');

  const view = await openReviewFromCard();
  const t = itemOf(view, LONG);
  const g = view?.items?.find((i) => i.state === 'skipped');
  check(`${tag}: the review shows Walk Tale with fake-b, the same series`, t?.candidates?.[0]?.source === 'fake-b' && /Same series/.test(t?.candidates?.[0]?.text ?? ''), JSON.stringify(t));
  check(`${tag}: ...and Walk Gap with its reason in words`, /Too few chapters to compare \(fewer than 3\)/.test(g?.note ?? ''), JSON.stringify(g));
  check(`${tag}: ...Select exact matches, and nothing selected yet`, !!view?.preselect && view?.follow === 'Follow 0 selected sources', JSON.stringify(view && { preselect: view.preselect, follow: view.follow }));
  check(`${tag}: the review has no sideways overflow`, await noSideScroll());
  await shot('run-4-review');
  const pressedFollow = await followExact();
  check(`${tag}: Select exact matches ticks fake-b: Follow 1 selected source`, pressedFollow === 'Follow 1 selected source', pressedFollow);
  const followed = await waitFor(async () => (await sourcesOf(S.tale)).some((x) => x.sourceId === 'fake-b'), 20_000, 500);
  check(`${tag}: ...and following it follows fake-b`, !!followed, JSON.stringify(await sourcesOf(S.tale)));
  const after = await waitFor(async () => { const v = await reviewOnPage(); return /Followed/.test(itemOf(v, LONG)?.candidates?.[0]?.text ?? '') ? v : null; }, 15_000);
  check(`${tag}: the review says Followed`, !!after, JSON.stringify(await reviewOnPage()));
  await shot('run-5-followed');

  // Walk Tale's Sources sheet: fake-b followed, and its chapters listed once the follow's paced refresh has asked it.
  const refreshed = await waitFor(async () => (await sourcesOf(S.tale)).find((x) => x.sourceId === 'fake-b' && x.chapters === 12), 60_000, 1000);
  check(`${tag}: the paced listing refresh read fake-b's 12 chapters for Walk Tale`, !!refreshed, JSON.stringify(await sourcesOf(S.tale)));
  check(`${tag}: Walk Tale's Sources sheet opens`, await openSourcesSheet(S.tale));
  const b = await waitFor(async () => { const r = await sheetSource('fake-b'); return r && /12 chapters listed/.test(r.text) ? r : null; }, 15_000);
  check(`${tag}: ...and lists fake-b as followed, with 12 chapters listed`, !!b && /also checked/.test(b.text) && b.unfollow, JSON.stringify(b ?? await sheetSource('fake-b')));
  check(`${tag}: the Sources sheet has no sideways scroll`, await noSideScroll());
  await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] span.truncate')].find((x) => x.textContent?.trim() === 'fake-b')?.scrollIntoView({ block: 'center' }));
  await shot('run-6-sources-sheet');
  await closeSheet();
}

// ---- 3. stop ---------------------------------------------------------------------------------------------------
async function stop() {
  await ensureOffline();
  // Four series, the first of them held on fake-b's search for 15 s: Stop lands while it is in flight.
  await script(FAKE_B, 'search', 'slow:15000');
  const ids = [S.mixed, S.repeated, S.gap, S.tale];
  const started = await post('/api/admin/sources/find', { seriesIds: ids });
  check(`${tag}: a search over 4 series starts`, started?.total === 4, JSON.stringify(started));
  await go('/library/?view=downloads', 1000);
  const running = await waitFor(async () => { const c = await cardOnPage(); return c?.state === 'running' && c.stop.includes('Stop') ? c : null; }, 15_000, 250);
  check(`${tag}: its card is running, with Stop`, !!running, JSON.stringify(await cardOnPage()));
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('[data-downloads-section="tasks"] li[data-task="find_sources"] button')].find((x) => x.textContent?.trim() === 'Stop');
    b?.click();
    return !!b;
  });
  check(`${tag}: Stop is pressed at once`, clicked);
  const ended = started?.runId ? await runEnded(started.runId, 30_000) : null;
  await script(FAKE_B, 'search', 'ok');
  check(`${tag}: the search ends stopped, not interrupted`, ended?.status === 'stopped', JSON.stringify(ended && { status: ended.status, done: ended.done, total: ended.total }));
  const rv = started?.runId ? await reviewOf(started.runId) : null;
  check(`${tag}: every series it never reached is still to search, and nothing was followed`,
    rv?.items?.length === 4 && rv.items.every((i) => i.state === 'pending' && !i.candidates.length) && rv?.run?.followed === 0, JSON.stringify(rv?.items));
  const card = await waitFor(async () => { const c = await cardOnPage(); return c && c.state !== 'running' ? c : null; }, 20_000, 500);
  check(`${tag}: the card says it stopped before it finished`, card?.state === 'cancelled' && /Stopped before it finished/.test(card?.text ?? ''), JSON.stringify(card));
  check(`${tag}: the card has no sideways overflow`, !!card?.inside && !card?.overflow && (await noSideScroll()), JSON.stringify(card));
  await shot('stop-1-card-stopped');

  const view = await openReviewFromCard();
  check(`${tag}: the review head says Stopped before it finished`, view?.head === 'Stopped before it finished', JSON.stringify(view && { head: view.head, line: view.line }));
  check(`${tag}: all 4 read Not searched yet -- never nothing found`,
    view?.items?.length === 4 && view.items.every((i) => i.note === 'Not searched yet') && !/nothing found|not found/i.test(view.items.map((i) => i.text).join(' ')),
    JSON.stringify(view?.items));
  check(`${tag}: ...and it offers to search them now`, view?.resume === 'Search the 4 series not searched yet', JSON.stringify(view?.resume));
  check(`${tag}: the review has no sideways overflow`, await noSideScroll());
  await shot('stop-2-review');
}

// ---- 4. names --------------------------------------------------------------------------------------------------
async function names() {
  await ensureOffline();
  check(`${tag}: Walk Tale's Sources sheet opens`, await openSourcesSheet(S.tale));
  await page.$eval('[role="dialog"] [data-alt-titles]', (el) => el.scrollIntoView({ block: 'center' }));
  const section = () => page.$eval('[role="dialog"] [data-alt-titles]', (el) => ({
    text: el.innerText.replace(/\s+/g, ' ').trim(),
    names: [...el.querySelectorAll('[data-alt-title]')].map((li) => ({ key: li.getAttribute('data-alt-title'), text: li.innerText.replace(/\s+/g, ' ').trim() })),
    refusal: el.querySelector('[data-alt-refusal]')?.textContent ?? null,
  })).catch(() => null);
  check(`${tag}: Other names starts empty`, /No other names yet\./.test((await section())?.text ?? ''), JSON.stringify(await section()));
  const input = '[role="dialog"] [data-alt-titles] input';
  /** Replace what the field holds (a refused name stays in it) with `name`, and submit. */
  const type = async (name) => {
    await page.$eval(input, (el) => { el.scrollIntoView({ block: 'center' }); el.focus(); el.select(); });
    await page.keyboard.press('Backspace');
    if (!(await waitFor(() => page.$eval(input, (el) => el.value === ''), 3000))) throw new Error('the Other names field did not clear');
    await page.type(input, name);
    await page.keyboard.press('Enter');
  };

  await type('Walking Tale Chronicle');
  const added = await waitFor(async () => { const s = await section(); return s?.names.some((n) => n.key === 'walkingtalechronicle') ? s : null; }, 10_000);
  check(`${tag}: a Latin name of 5+ letters is listed, as the admin's`,
    !!added && added.names.some((n) => n.key === 'walkingtalechronicle' && /Walking Tale Chronicle/.test(n.text) && /added by an admin/.test(n.text)), JSON.stringify(await section()));
  const stored = (await api(`/api/admin/series/${S.tale}/alt-titles`)).titles ?? [];
  check(`${tag}: ...and stored`, stored.some((t) => t.title === 'Walking Tale Chronicle' && t.origin === 'admin'), JSON.stringify(stored));
  await shot('names-1-added');

  const refused = async (name, words, what, file) => {
    await type(name);
    const s = await waitFor(async () => { const x = await section(); return x?.refusal ? x : null; }, 10_000);
    check(`${tag}: ${what} is refused in its own words`, s?.refusal === words, JSON.stringify(s));
    check(`${tag}: ...and nothing more is listed`, s?.names?.length === 1, JSON.stringify(s?.names));
    if (file) await shot(file);
  };
  await refused('Tale', 'Too short: a name needs at least 5 letters or digits.', 'a name under 5 letters', 'names-2-too-short');
  await refused('散歩の物語', 'Only names in Latin letters can be matched: English or romanised.', 'a name in another script', 'names-3-non-latin');
  await refused('Walking Tale Chronicle', 'This series already has that name.', 'the same name again', 'names-4-duplicate');

  await page.$eval('[role="dialog"] button[aria-label="Remove Walking Tale Chronicle"]', (b) => { b.scrollIntoView({ block: 'center' }); b.click(); });
  const cleared = await waitFor(async () => { const s = await section(); return s && !s.names.length ? s : null; }, 10_000);
  check(`${tag}: removing the name clears it from the list`, !!cleared && /No other names yet\./.test(cleared.text), JSON.stringify(await section()));
  // The field still holds the refused name: "This series already has that name." stops being true the moment the name
  // is removed, and a refusal left standing over "No other names yet." contradicts the list above it.
  check(`${tag}: ...and the refusal it answered goes with it`, cleared?.refusal == null, JSON.stringify(cleared));
  const after = (await api(`/api/admin/series/${S.tale}/alt-titles`)).titles ?? [];
  check(`${tag}: ...and from the server's`, !after.some((t) => t.title === 'Walking Tale Chronicle'), JSON.stringify(after));
  await shot('names-5-removed');
  // A removed name stays removed (kept as a tombstone), but typed again by hand it comes back, as the admin's own.
  await type('Walking Tale Chronicle');
  const back = await waitFor(async () => { const s = await section(); return s?.names.some((n) => n.key === 'walkingtalechronicle') ? s : null; }, 10_000);
  check(`${tag}: typed again by hand, a removed name comes back`, !!back && !back.refusal, JSON.stringify(await section()));
  await page.$eval('[role="dialog"] button[aria-label="Remove Walking Tale Chronicle"]', (b) => b.click());
  await waitFor(async () => { const s = await section(); return s && !s.names.length; }, 10_000);

  // Find more sources, over this one series: fake-b unfollowed first, through the sheet, so there is one to find.
  await page.$eval('[role="dialog"] button[aria-label="Stop following fake-b"]', (b) => { b.scrollIntoView({ block: 'center' }); b.click(); }).catch(() => {});
  const gone = await waitFor(async () => !(await sourcesOf(S.tale)).some((s) => s.sourceId === 'fake-b') && !(await sheetSource('fake-b')), 15_000);
  check(`${tag}: fake-b is unfollowed through the Sources sheet`, !!gone, JSON.stringify(await sourcesOf(S.tale)));
  await page.$eval('[role="dialog"] [data-find-more-block]', (el) => el.scrollIntoView({ block: 'center' }));
  await shot('names-6-find-more');
  const before = (await findState()).run?.id ?? null;
  await page.$eval(`[role="dialog"] button[data-find-more="${S.tale}"]`, (b) => { b.scrollIntoView({ block: 'center' }); b.click(); });
  const started = await waitFor(async () => { const s = await findState(); return s.run && s.run.id !== before ? s.run : null; }, 15_000);
  check(`${tag}: Find more sources starts a search of this one series`, started?.total === 1, JSON.stringify(started));
  const opened = started ? await onReviewOf(started.id) : null;
  check(`${tag}: ...and opens its review`, !!opened, page.url());
  const done = started ? await runEnded(started.id, 90_000) : null;
  const rv = done ? await reviewOf(done.id) : null;
  check(`${tag}: ...which offers fake-b again, green`, rv?.items?.[0]?.seriesId === S.tale && rv.items[0].candidates?.[0]?.source === 'fake-b' && rv.items[0].candidates[0].verdict === 'ok', JSON.stringify(rv?.items));
  const ready = await waitFor(async () => { const v = await reviewOnPage(); return v?.preselect ? v : null; }, 15_000);
  check(`${tag}: the review offers Select exact matches`, !!ready, JSON.stringify(await reviewOnPage()));
  check(`${tag}: ...and following it follows fake-b`, (await followExact()) === 'Follow 1 selected source' && !!(await waitFor(async () => (await sourcesOf(S.tale)).some((x) => x.sourceId === 'fake-b'), 20_000, 500)));
  check(`${tag}: Walk Tale's Sources sheet opens again`, await openSourcesSheet(S.tale));
  const listed = await waitFor(() => sheetSource('fake-b'), 15_000);
  check(`${tag}: ...and lists fake-b again`, !!listed, JSON.stringify(listed));
  check(`${tag}: the Sources sheet has no sideways scroll`, await noSideScroll());
  await closeSheet();
}

// ---- 5. select -------------------------------------------------------------------------------------------------
async function select() {
  await go('/library/', 2500);
  check(`${tag}: Library -> Select`, await press('Select'));
  await sleep(300);
  const picked = await page.evaluate(() => {
    const out = [];
    for (const t of ['Mixed Formats', 'Repeated Pages']) {
      const b = [...document.querySelectorAll('[data-library-grid] button.group')].find((x) => x.textContent?.includes(t));
      if (b) { b.click(); out.push(t); }
    }
    return out;
  });
  check(`${tag}: two series are selected`, picked.length === 2 && !!(await waitFor(async () => /2 selected/.test(await bodyText()), 5000)), JSON.stringify(picked));
  const bar = await page.evaluate(() => {
    const el = [...document.querySelectorAll('div.fixed.inset-x-0')].find((d) => /selected/.test(d.textContent || ''));
    return el ? [...el.querySelectorAll('button')].filter((b) => b.offsetParent).map((b) => b.textContent.trim()) : null;
  });
  check(`${tag}: the bar has no key of its own for Move, Remove or Find other sources`,
    !!bar && bar.includes('More') && !bar.some((t) => ['Move to library', 'Remove from library', 'Find other sources'].includes(t)), JSON.stringify(bar));
  check(`${tag}: the Library has no sideways scroll`, await noSideScroll());
  await shot('select-1-bar');
  await press('More');
  const more = await waitFor(() => page.evaluate(() => {
    const d = document.querySelector('[role="dialog"][aria-label="2 selected"]');
    return d ? [...d.querySelectorAll('button')].filter((b) => b.offsetParent).map((b) => b.textContent.trim()) : null;
  }), 5000);
  check(`${tag}: More holds Move to library, Find other sources and Remove from library`,
    !!more && ['Move to library', 'Find other sources', 'Remove from library'].every((t) => more.includes(t)), JSON.stringify(more));
  await shot('select-2-more');
  const before = (await findState()).run?.id ?? null;
  check(`${tag}: More -> Find other sources`, await press('Find other sources', '[role="dialog"][aria-label="2 selected"]'));
  const started = await waitFor(async () => { const s = await findState(); return s.run && s.run.id !== before ? s.run : null; }, 15_000);
  check(`${tag}: it is a search of 2`, started?.total === 2, JSON.stringify(started));
  const opened = started ? await onReviewOf(started.id) : null;
  check(`${tag}: ...whose review opens`, !!opened, page.url());
  await shot('select-3-review');
  const done = started ? await runEnded(started.id, 90_000) : null;
  const rv = done ? await reviewOf(done.id) : null;
  const ids = (rv?.items ?? []).map((i) => i.seriesId).sort();
  check(`${tag}: ...over exactly the two selected`, JSON.stringify(ids) === JSON.stringify([S.mixed, S.repeated].sort()), JSON.stringify(rv?.items));
  check(`${tag}: ...neither of which any other source lists`, done?.status === 'done' && (rv?.items ?? []).every((i) => i.state === 'done' && !i.candidates.length), JSON.stringify(rv?.items));
  const view = await waitFor(async () => { const v = await reviewOnPage(); return v?.items?.length === 2 && v.items.every((i) => i.note) ? v : null; }, 15_000);
  check(`${tag}: ...and the review says so for each`, !!view && view.items.every((i) => /No other source lists it under its title or other names|No other source answered/.test(i.note)), JSON.stringify(view?.items));
}

// ---- 6. arabic -------------------------------------------------------------------------------------------------
// The words are ar.json's own. A key missing there is a failed check of its own, and every check reading it fails.
const AR = JSON.parse(readFileSync(new URL('../../public/locales/ar.json', import.meta.url), 'utf8'));
const ar = (key, vars = {}) => {
  const s = AR[key];
  if (typeof s !== 'string') { check(`ar.json has "${key}"`, false); return '\u0000'; }
  return Object.entries(vars).reduce((out, [k, v]) => out.split(`{${k}}`).join(String(v)), s);
};

async function arabic() {
  await ensureOffline();
  // Something for the run to find: Walk Tale without fake-b, and its search held so the card is seen running.
  if ((await sourcesOf(S.tale)).some((s) => s.sourceId === 'fake-b')) await api(`/api/admin/series/${S.tale}/sources/fake-b`, { method: 'DELETE' });
  await script(FAKE_B, 'search', 'slow:15000');
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ lang: 'ar' }) });
  await page.evaluate(() => localStorage.setItem('uchiyomi.lang', 'ar'));
  try {
    if (!(await openSourceHealth())) throw new Error('Health -> Source health did not open');
    const doc = await page.evaluate(() => ({ dir: document.documentElement.dir, lang: document.documentElement.lang }));
    check('ar: the page is Arabic, right to left', doc.dir === 'rtl' && doc.lang === 'ar', JSON.stringify(doc));
    const row = await waitFor(async () => { const r = await healthRowOnPage('fake-a'); return r?.key ? r : null; }, 30_000);
    check('ar: the Health row\'s key is Arabic, and its count intact', row?.key === ar('Find other sources ({n} series)', { n: 2 }) && /(^|\D)2(\D|$)/.test(row?.key ?? ''), JSON.stringify(row));
    // The detail is worded by its codes in the reader's language (lib/said.ts itemDetail), the count among its words.
    check('ar: ...its detail is Arabic, right to left, its count intact',
      !!row?.detailAuto && row?.detailDir === 'rtl' && (row?.detail ?? '').includes(ar('The site says it is offline (its own page)'))
      && (row?.detail ?? '').includes(ar('{n} series use it', { n: 2 })), JSON.stringify(row));
    check('ar: ...and the source\'s own error, still the server\'s English, keeps its own direction',
      !!row?.errorAuto && row?.errorDir === 'ltr' && /^site_offline: /.test(row?.error ?? ''), JSON.stringify(row));
    check('ar: ...its fix is worded in Arabic, right to left', row?.fix === ar('Wait for the site to come back, or find other sources for its series.') && row?.fixDir === 'rtl', JSON.stringify(row));
    check('ar: ...and its search step says it too', row?.stageText === ar('the site says it is offline'), JSON.stringify(row));
    check('ar: Health has no sideways scroll', await noSideScroll());
    await page.evaluate(() => [...document.querySelectorAll('[data-health-check="sources"] [data-health-item]')]
      .find((r) => r.querySelector('p[dir="auto"]')?.textContent?.trim() === 'fake-a')?.scrollIntoView({ block: 'center' }));
    await shot('ar-1-health-row');

    const before = (await findState()).run?.id ?? null;
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('[data-health-check="sources"] [data-health-item]')]
        .find((r) => r.querySelector('p[dir="auto"]')?.textContent?.trim() === 'fake-a');
      row?.querySelector('button[data-health-action="find_sources"]')?.click();
    });
    const started = await waitFor(async () => { const s = await findState(); return s.running && s.run && s.run.id !== before ? s.run : null; }, 15_000);
    check('ar: the key starts a run over the 2 series', started?.total === 2, JSON.stringify(started));
    await go('/library/?view=downloads', 1500);
    const progress = ar('{done} of {total} series', { done: 1, total: 2 });
    const card = await waitFor(async () => { const c = await cardOnPage(); return c?.state === 'running' && c.text.includes(progress) && c.now ? c : null; }, 20_000, 300);
    check('ar: the card is Arabic: its name, its count intact, and Stop', card?.name === ar('Other-source search') && card?.text.includes(progress)
      && card?.stop?.includes(ar('Stop')), JSON.stringify(card ?? await cardOnPage()));
    check('ar: ...the series it is on keeps its own direction inside the Arabic line',
      card?.now?.title === LONG && card?.now?.dir === 'ltr' && (card?.now?.text ?? '').startsWith(ar('Now: {title}').split('{title}')[0]), JSON.stringify(card?.now));
    // An English title inside the right-to-left line must still be cut at ITS end: its beginning is what names it.
    check('ar: ...cut at its own end, so the title\'s beginning shows', card?.now?.startShown === true, JSON.stringify(card?.now));
    check('ar: the card has no sideways overflow', !!card?.inside && !card?.overflow && (await noSideScroll()), JSON.stringify(card));
    await cardIntoView();
    await shot('ar-2-card');

    const done = started ? await runEnded(started.id) : null;
    check('ar: the search ends waiting for a review', done?.status === 'review', JSON.stringify(done));
    await waitFor(async () => (await cardOnPage())?.state === 'done', 20_000, 500);
    const view = await openReviewFromCard();
    const t = itemOf(view, LONG);
    const g = view?.items?.find((i) => i.state === 'skipped');
    check('ar: the review\'s head is Arabic', view?.head === ar('Ready to review'), JSON.stringify(view && { head: view.head, line: view.line }));
    check('ar: ...the series title and the source name keep their own direction',
      !!t?.titleAuto && t?.titleDir === 'ltr' && t?.candidates?.[0]?.source === 'fake-b' && t?.candidates?.[0]?.sourceDir === 'ltr', JSON.stringify(t));
    check('ar: ...the match is worded in Arabic', (t?.candidates?.[0]?.text ?? '').includes(ar('Same series')), JSON.stringify(t));
    check('ar: ...and the skipped series\' reason is Arabic, its number intact',
      (g?.note ?? '').includes(ar('Too few chapters to compare (fewer than 3)')) && /(^|\D)3(\D|$)/.test(g?.note ?? ''), JSON.stringify(g));
    check('ar: the review has no sideways overflow', await noSideScroll());
    await shot('ar-3-review');
  } finally {
    await script(FAKE_B, 'search', 'ok').catch(() => {});
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ lang: 'en' }) }).catch(() => {});
    await page.evaluate(() => localStorage.setItem('uchiyomi.lang', 'en')).catch(() => {});
  }
}

// ---- the walk --------------------------------------------------------------------------------------------------
let hunt = null;
let mangadexOff = false;
try {
  await Promise.all([control(FAKE_A, '/__reset', {}), control(FAKE_B, '/__reset', {})]);
  await Promise.all(['fake-a', 'fake-b'].flatMap((id) => [post(`/api/admin/sources/${id}/enable`), post(`/api/admin/sources/${id}/unblock`)]));
  // A real public site has no place in a run over fake series; restored in finally, as walk41 does.
  await post('/api/admin/sources/mangadex/disable');
  mangadexOff = true;
  hunt = (await api('/api/admin/settings')).auto_follow_on_failure;
  await api('/api/admin/settings', { method: 'PATCH', body: JSON.stringify({ autoFollowOnFailure: false }) });
  await library();
  for (const [name, fn] of [['offline', offline], ['run', run], ['stop', stop], ['names', names], ['select', select], ['arabic', arabic]]) {
    if (!PHASES.includes(name)) continue;
    console.log(`\n  ${name} @${WIDTH}`);
    await fn();
  }
} catch (e) {
  check('the walk ran to the end', false, String(e?.stack || e));
  await page.screenshot({ path: `${OUT}/${tag}-zz-where-it-stopped.png` }).catch(() => {});
} finally {
  if (hunt !== null) await api('/api/admin/settings', { method: 'PATCH', body: JSON.stringify({ autoFollowOnFailure: hunt }) }).catch(() => {});
  if (mangadexOff) await post('/api/admin/sources/mangadex/enable').catch(() => {});
}
check('no 5xx along the way', serverErrors.length === 0, serverErrors.slice(0, 5).join(' | '));
check('no console errors along the way', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));
await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ok, ${failed} failure(s)`);
process.exit(failed ? 1 : 0);
