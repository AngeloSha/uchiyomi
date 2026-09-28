// Browser acceptance walk for v0.49.0, one phase per workstream, run in order on a fresh instance of its own:
//
//   KEEP=1 E2E_ENGINE=fake E2E_ARCHIVE_FAST=1 E2E_NO_WALK=1 E2E_NET=uchiyomi-e2e-49 E2E_PORT=18149 \
//     E2E_SUBNET=10.222.9.0/24 bash web/test/e2e/up.sh
//   cd web && BASE=http://127.0.0.1:18149 PHASES=notices,archive,numbering,sources,engine \
//     ENGINE=http://127.0.0.1:20300 npm run test:e2e:v049                  # every phase
//   cd web && BASE=http://127.0.0.1:18149 PHASES=notices npm run test:e2e:v049
//
// The default PHASES are the ones a plain up.sh stack can serve: notices, archive, sources. numbering and engine
// need the fake extension engine (E2E_ENGINE=fake); its control port is the second fake source's plus one
// (20300 above), which numbering derives by itself and engine takes as ENGINE.
//
// Phases:
//
//   notices -- the capsule toasts became cards at the bottom edge (components/Toast.tsx, lib/notices.ts). The
//   owner's rule: a notice never covers a dialog's title. At 390 x 844 and at 1024 x 768 it drives a notice
//   into each place and measures it against what is on screen:
//     1. a series page: above the bottom nav (the bottom-end corner from lg up);
//     2. select mode: above the series select bar, which wraps to three rows on a phone (measured, not a
//        constant), and above the library's, which wraps to two;
//     3. a Modal over that bar (Delete from server): one card docked in the nav band, clear of the title --
//        and from lg up clear of the whole panel;
//     4. a hand-rolled centred dialog (Edit details, Check now) and a Sheet (Sources & translations, Check
//        now), the same;
//     5. the reader: above the chapter sheet and the settings sheet, which run to the bottom edge;
//     6. under the system's reduced motion: no turning ring (a still one), no draining hairline -- and the
//        turn and the hairline are there without it.
//   To hold a notice on screen while the walk opens a dialog under it, the mouse rests on the card: a notice
//   pauses while hovered, which is behaviour the walk relies on and so also checks.
//
//   archive -- the slow archive (#117): where it is turned on and where it is watched. At 390: Discover -> the
//   add dialog's "Archive the rest slowly" (offered for Nothing yet, never for All), the done step's line, the
//   still amber cover in Library -> Downloads' Queued with the Library tab's calm mark, its sheet with Pause,
//   Resume and a confirmed Stop. At 1280: the series page's "Archive slowly" and its band, whose Details and Stop
//   cover the whole screen, the admin's Pause all and Resume all, the sheet, Admin -> Settings -> Downloads with
//   its window rows, and the add dialog for a Latest-N pick; then a member who did not queue it sees the cover,
//   its sheet and the band with no key to press. No ring in any of it turns. With E2E_ARCHIVE_FAST=1 (a stack
//   started with the archive's test knobs -- ARCHIVE_FIRST_RUN_MS, ARCHIVE_MIN_BREAK_MS, ARCHIVE_PAGE_GAP_MS,
//   ARCHIVE_TICK_MS) it also holds the archive on a disk floor no host meets, to find it under Needs attention
//   with a Details and a Stop that cover the screen, then waits for the first chapter to land and be counted,
//   and for Came in today to sum it up. The free-space floor it lowers is put back at the end.
//
//   numbering -- posting-order numbering (#116), on the fake engine's Webtoons.com and its Istrevelia: 226 posts
//   the extension numbers 1 to 8 by the episode in their titles, 13 numbers in all. At 390: the add dialog reads
//   226 chapters with its notice and the switch to the source's 13 numbers, and the add keeps those; the versions
//   sheet tells the posts on one number apart by title; then the series is handed to the detector the way a
//   v0.48.4 library holds it, which holds it for review -- the notice, the plan that says which file becomes
//   which chapter, Rename the files, and a read mark that moved with its chapter. At 1280: a clean webtoon adds
//   with no notice; the series goes back to the source's numbers from its own notice, through the plan; then
//   Admin -> Extensions -> Webtoons.com's Settings: its sequential-numbering switch warns that it renumbers the
//   series and asks again, and the series waits on its page for the review of the remap it queued.
//
//   sources -- #115, a failing source shows its failing stage on Providers and on Health. fake-a's search is
//   scripted to fail (fakeSource `error`, HTTP 500), then at 390 x 844 and 1280 x 800:
//     1. Providers -> Test fake-a: the running key shows its clock, the card lists ✗ Search, never "Working
//        normally." beside a ✗, and its mark reads "Failing" (the public status is still 'ok');
//     2. a reload keeps the verdict: the card's stored evidence still says ✗ Search;
//     3. Health -> Source health lists fake-a by name with the ✗ Search line;
//     4. with search scripted back to `ok`, Test from the Health row clears the finding.
//
//   engine -- Admin → Extensions with the extension engine not answering, then answering (engineWalk.mjs). Needs
//   up.sh with E2E_ENGINE=fake, and ENGINE=http://127.0.0.1:<the engine's port>; it takes the engine down itself.
//
//   Run order, whatever PHASES lists, is the release plan's (design critic): notices, archive, numbering, sources,
//   engine. The engine phase resets the fake engine and takes it down, so nothing that needs it can follow; a
//   sources run that stops half-way leaves fake-a's search failing, which only the engine phase then meets, and it
//   never searches.
//
// Screenshots go to $OUT (default shots49). LOOK at them: every check here is geometry, and geometry passes on
// a card that is transparent, clipped or unreadable.
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';
// The fake extension engine's own seed, so the numbering phase expects what the engine serves rather than a copy
// of it (the same file up.sh starts the engine from).
import { SOURCE_IDS, SEQUENTIAL_KEY, defaultSeed, istreveliaPosts, webtoonsNumbers } from '../../../bff/test/fixtures/fakeSuwayomiEngine.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:18149';
const USER = process.env.E2E_USER || 'e2e';
const PASS = process.env.E2E_PASS || 'e2e-passw0rd-123';
const OUT = process.env.OUT || 'shots49';
const PHASES = (process.env.PHASES || 'notices,archive,sources').split(',').map((s) => s.trim()).filter(Boolean);
// The fake sources' and the fake engine's control ports, as up.sh derives them from the app's port.
const FAKE_A_PORT = 20_000 + (Number(new URL(BASE).port || 80) % 1000) * 2;
const FAKE_A = process.env.FAKE_A_URL || `http://127.0.0.1:${FAKE_A_PORT}`;
const ENGINE = process.env.ENGINE || `http://127.0.0.1:${FAKE_A_PORT + 2}`;
const script = async (base, chapter, page, behaviour) => {
  const r = await fetch(`${base}/__script`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chapter, page, behaviour }) });
  if (!r.ok) throw new Error(`script ${chapter}/${page} ${behaviour} -> ${r.status}`);
};
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`  [${ok ? ' ok ' : 'FAIL'}] ${name}${!ok && detail ? `\n         ${detail}` : ''}`);
};
const waitFor = async (fn, ms = 10_000, step = 150) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(step);
  }
};

// ---- an API session (one login: the route allows 10 per five minutes) ----
const login = await (await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) })).json();
const TOKEN = login.accessToken;
if (!TOKEN) { console.error('could not sign in to the API'); process.exit(2); }
const api = async (path, opts = {}) => {
  const r = await fetch(BASE + path, { ...opts, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } });
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};
const seriesNamed = async (name) => (await api('/api/series/search', { method: 'POST', body: JSON.stringify({ query: '', size: 100 }) })).content.find((s) => s.name === name);

// ---- the browser, signed in once ----
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], defaultViewport: { width: 390, height: 844 } });
const serverErrors = [];
const consoleErrors = [];
/** Every page the walk drives, the member's included, reports its 5xx answers and console errors. */
const watch = (p, who = '') => {
  p.on('response', (r) => { if (r.status() >= 500) serverErrors.push(`${who}${r.status()} ${r.url()}`); });
  p.on('pageerror', (e) => consoleErrors.push(`${who}pageerror ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error' && !/401|auth\/me|Failed to load resource/.test(m.text())) consoleErrors.push(`${who}${m.text()}`); });
  return p;
};
/** The login form, typed into. One sign-in per account: the route allows ten per five minutes. */
const signIn = async (p, user, pass) => {
  await p.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  await p.waitForSelector('input[type=password]', { timeout: 30000 });
  await sleep(2500); // the form renders again once /auth/config answers; typing before that is lost
  await (await p.$$('input'))[0].type(user);
  await p.type('input[type=password]', pass);
  await p.keyboard.press('Enter');
  await sleep(4000);
  return !(await p.$('input[type=password]'));
};
const page = watch(await browser.newPage());
check('signed in', await signIn(page, USER, PASS));

const go = async (path, wait = 2500) => {
  await page.goto(BASE + path, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  await sleep(wait);
  // The Health banner is another step's; it takes a third of a phone screen.
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /^Not now$/.test(b.innerText.trim()))?.click());
};
/** A DOM click on the first button whose text or name is `text`: the mouse stays where it is (on a notice). */
const press = (text, root = 'document') => page.evaluate((t, root) => {
  const scope = root === 'document' ? document : document.querySelector(root);
  const b = [...(scope?.querySelectorAll('button, a, [role="menuitem"]') ?? [])]
    .find((x) => x.textContent?.trim() === t || x.getAttribute('aria-label') === t);
  b?.click();
  return !!b;
}, text, root);
const shot = async (name, p = page) => { await p.screenshot({ path: `${OUT}/${name}.png` }); console.log(`         shot ${name}`); };
/** The page is no wider than the screen: a sideways scroll is the one layout fault a phone always shows. */
const noSideScroll = (p = page) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

/**
 * The layer `sel` sits in -- the nearest `position: fixed` element at or above it, a Modal's backdrop or a
 * Sheet's -- measured against the screen. A fixed overlay inside anything with a backdrop-filter (every `.card`
 * has one) is placed against that element instead: it dims the card, the page around it stays live, and the
 * panel floats over the row or off the top (the s14 review's major, components/ArchiveQueue.tsx).
 */
const overlayBox = (sel, p = page) => p.evaluate((sel) => {
  let e = document.querySelector(sel);
  while (e && getComputedStyle(e).position !== 'fixed') e = e.parentElement;
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), vw: innerWidth, vh: innerHeight };
}, sel);
const coversScreen = (b) => !!b && b.left <= 0 && b.top <= 0 && b.right >= b.vw && b.bottom >= b.vh;

/**
 * Discover -> search `title` -> its card -> the add dialog on `provider` (the picker is skipped when one source
 * has it). Resolves once the options are drawn -- the chapter select -- or to null.
 */
const openDialogFor = async (title, provider = 'fake-a') => {
  await go('/discover/');
  const input = await page.waitForSelector('input[aria-label="Search all sources…"]', { timeout: 20_000 });
  await input.click({ clickCount: 3 });
  await input.type(title);
  await press('Search');
  const card = await waitFor(() => page.evaluateHandle((t) => [...document.querySelectorAll('button[aria-label="Add to library"]')]
    .find((b) => b.querySelector('p')?.textContent?.trim() === t) || null, title).then((h) => h.asElement()), 15_000);
  if (!card) throw new Error(`no ${title} card on Discover`);
  await card.click();
  await sleep(800);
  await page.evaluate((p) => [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.trim().startsWith(p))?.click(), provider);
  return waitFor(async () => !!(await page.$('[role="dialog"] select')), 20_000);
};
/** The add dialog's count line, "226 chapters · 1–226", with its spacing folded. */
const detailCount = () => page.$eval('[data-detail-count]', (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');

/**
 * What is on screen, measured: the notices (the viewport's place and each card), every open dialog (its
 * panel -- a Sheet's role="dialog" is its full-screen backdrop, so the panel is its first child -- and its
 * title), the select bar, the bottom nav.
 */
const scene = () => page.evaluate(() => {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
  const vp = document.querySelector('[data-notices]');
  const cards = [...(vp?.children ?? [])].map((c) => ({ ...box(c), text: c.textContent, type: c.getAttribute('data-notice'), busy: c.hasAttribute('data-busy') }));
  const full = (r) => r.width >= innerWidth - 1 && r.height >= innerHeight - 1;
  const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].map((d) => {
    const panel = full(d.getBoundingClientRect()) && d.firstElementChild ? d.firstElementChild : d;
    return { label: d.getAttribute('aria-label'), panel: box(panel), title: box(d.querySelector('h2, h3')) };
  });
  const nav = document.querySelector('nav.fixed.bottom-0 .glass');
  const bar = [...document.querySelectorAll('div.fixed.inset-x-0')].find((d) => d.querySelector('button') && /selected|…/.test(d.textContent || '') && getComputedStyle(d).bottom !== 'auto');
  const barRows = bar ? new Set([...bar.querySelectorAll('button')].filter((b) => b.offsetParent).map((b) => Math.round(b.getBoundingClientRect().top))).size : 0;
  return {
    place: vp?.getAttribute('data-place') ?? null, cards, dialogs,
    nav: nav && nav.getBoundingClientRect().height ? box(nav) : null,
    bar: box(bar), barRows,
    rings: vp ? { turning: vp.querySelectorAll('.animate-ring').length, still: vp.querySelectorAll('[data-ring="still"]').length, spin: vp.querySelectorAll('[data-ring="spin"]').length } : null,
    hairlines: vp ? vp.querySelectorAll('.animate-notice-countdown').length : 0,
    vw: innerWidth, vh: innerHeight,
  };
});
const overlap = (a, b) => !!a && !!b && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
const fmt = (s) => JSON.stringify({ place: s.place, cards: s.cards.map((c) => [Math.round(c.top), Math.round(c.bottom), Math.round(c.left), Math.round(c.right), c.text?.slice(0, 30)]), dialogs: s.dialogs.map((d) => ({ l: d.label, p: d.panel && [Math.round(d.panel.top), Math.round(d.panel.bottom), Math.round(d.panel.left), Math.round(d.panel.right)], t: d.title && [Math.round(d.title.top), Math.round(d.title.bottom)] })), bar: s.bar && [Math.round(s.bar.top), Math.round(s.bar.bottom)], barRows: s.barRows, nav: s.nav && [Math.round(s.nav.top), Math.round(s.nav.bottom), Math.round(s.nav.left), Math.round(s.nav.right)] });

/** Rest the mouse on the newest notice: it pauses while hovered, so it outlives what the walk opens next. */
const holdNotice = async () => {
  const s = await scene();
  const c = s.cards.at(-1);
  if (!c) return false;
  await page.mouse.move(c.left + c.width / 2, c.top + c.height / 2);
  return true;
};
const releaseMouse = () => page.mouse.move(2, 2);

/**
 * The checks for one dialog with a notice over it. Phone: one card, clear of the title, docked in the nav
 * band and covering the nav bar exactly (half-covered, the bar's icons showed above the card). From lg up:
 * clear of the whole panel.
 */
const checkOverDialog = (s, what, wide) => {
  const d = s.dialogs.at(-1);
  check(`${what}: a dialog is open`, !!d?.panel, fmt(s));
  check(`${what}: exactly one notice shows`, s.cards.length === 1, fmt(s));
  const c = s.cards[0];
  check(`${what}: the notice does not cover the dialog's title`, !!c && !!d?.title && !overlap(c, d.title), fmt(s));
  if (wide) {
    check(`${what}: from lg up the notice is clear of the whole dialog`, !!c && !overlap(c, d?.panel), fmt(s));
  } else {
    const near = (a, b) => Math.abs(a - b) <= 2;
    check(`${what}: docked in the nav band, over the nav bar exactly`, s.place === 'nav-band' && !!c && !!s.nav
      && near(c.top, s.nav.top) && near(c.bottom, s.nav.bottom) && near(c.left, s.nav.left) && near(c.right, s.nav.right), fmt(s));
  }
};

async function notices(width) {
  const wide = width >= 1024;
  await page.setViewport({ width, height: wide ? 768 : 844 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  const tag = `${wide ? '1024' : '390'}`;
  const plain = await seriesNamed('Repeated Pages');
  const tale = await seriesNamed('Walk Tale');
  check(`${tag}: the seeded series and Walk Tale are in the library`, !!plain && !!tale);
  if (!plain || !tale) return;

  /** A notice from a chapter's ⋯ menu: Mark read / Mark unread, a success notice of about 4 s. */
  const markFromMenu = async () => {
    await page.evaluate(() => document.querySelector('[id^="ch-"] button[aria-label="Chapter actions"]')?.click());
    await sleep(300);
    const ok = await page.evaluate(() => {
      const item = [...document.querySelectorAll('[role="menuitem"]')].find((x) => /^Mark (read|unread)$/.test(x.textContent?.trim() || ''));
      item?.click();
      return !!item;
    });
    return ok && waitFor(async () => (await scene()).cards.length > 0, 5000);
  };

  // 1. a page with the nav
  await go(`/series/?id=${plain.id}`);
  check(`${tag}: a chapter's menu says what it did`, !!(await markFromMenu()));
  await sleep(400);
  let s = await scene();
  if (wide) {
    const c = s.cards.at(-1);
    check(`${tag}: from lg up the notice is in the bottom-end corner`, !!c && c.right <= s.vw - 24 + 1 && c.bottom <= s.vh - 24 + 1 && c.left > s.vw / 2, fmt(s));
  } else {
    check(`${tag}: the notice is above the bottom nav`, s.place === 'above-nav' && !!s.nav && s.cards.every((c) => c.bottom <= s.nav.top + 0.5), fmt(s));
  }
  check(`${tag}: nothing anchors a notice to the top half`, s.cards.every((c) => c.top > s.vh / 2), fmt(s));
  await shot(`${tag}-1-series-page`);

  // 2. select mode: the series select bar, three rows on a phone, and the notice above it
  await sleep(4500); // let the first notice go
  check(`${tag}: another notice`, !!(await markFromMenu()));
  await holdNotice();
  await press('Select');
  await sleep(300);
  await page.evaluate(() => { for (const b of [...document.querySelectorAll('[id^="ch-"] button[aria-pressed]')].slice(0, 2)) b.click(); });
  await sleep(800);
  s = await scene();
  check(`${tag}: the select bar is up`, !!s.bar, fmt(s));
  if (!wide) check(`${tag}: the series select bar wraps to three rows at 390 px`, s.barRows === 3, fmt(s));
  check(`${tag}: the notice sits above the select bar, measured`, s.place === 'above-toolbar' && s.cards.length > 0 && s.cards.every((c) => c.bottom <= s.bar.top + 0.5), fmt(s));
  check(`${tag}: a hovered notice stays`, s.cards.length > 0);
  await shot(`${tag}-2-above-select-bar`);

  // 3. a Modal over the select bar
  await press('Delete from server');
  await sleep(700);
  s = await scene();
  checkOverDialog(s, `${tag}: Delete from server (a Modal)`, wide);
  await shot(`${tag}-3-modal-over-select-bar`);
  await page.keyboard.press('Escape');
  await sleep(400);
  await press('Cancel', 'div.fixed.inset-x-0');
  await releaseMouse();
  await sleep(300);
  // A fresh notice, so there is a card to measure: the held one may have gone by now, and "no card" proved
  // nothing about where the next one goes.
  check(`${tag}: a notice after the dialog and the bar`, !!(await markFromMenu()));
  await sleep(400);
  s = await scene();
  check(`${tag}: with the dialog and the bar gone the notice is back above the nav`, s.cards.length > 0 && (wide
    ? s.cards.every((c) => c.right <= s.vw - 24 + 1 && c.bottom <= s.vh - 24 + 1)
    : s.place === 'above-nav' && !!s.nav && s.cards.every((c) => c.bottom <= s.nav.top + 0.5)), fmt(s));
  await sleep(4500);

  // 3b. the library's select bar: two rows at 390 px, measured like the series one. Its own action makes the
  // notice (Favourite, which also leaves select mode), and the mouse rests on it while select mode comes back.
  await go('/library');
  await press('Select');
  await sleep(300);
  const pickTwo = () => page.evaluate(() => { for (const b of [...document.querySelectorAll('[data-library-grid] button.group')].slice(0, 2)) b.click(); });
  await pickTwo();
  await sleep(600);
  await press('Favourite');
  await waitFor(async () => (await scene()).cards.length > 0, 5000);
  await holdNotice();
  await press('Select');
  await sleep(300);
  await pickTwo();
  await sleep(700);
  s = await scene();
  check(`${tag}: the library select bar is up`, !!s.bar, fmt(s));
  if (!wide) check(`${tag}: the library select bar wraps to two rows at 390 px`, s.barRows === 2, fmt(s));
  check(`${tag}: the notice sits above the library select bar, measured`, s.place === 'above-toolbar' && s.cards.length > 0 && s.cards.every((c) => c.bottom <= s.bar.top + 0.5), fmt(s));
  await shot(`${tag}-2b-above-library-bar`);
  await press('Cancel', 'div.fixed.inset-x-0');
  await releaseMouse();
  await sleep(300);

  // 4. Edit details (a hand-rolled centred dialog) and Sources & translations (a Sheet), each with Check now
  await go(`/series/?id=${tale.id}`);
  await press('Edit details');
  await sleep(700);
  await press('Check for new chapters now', '[role="dialog"]');
  await waitFor(async () => (await scene()).cards.length > 0, 5000);
  await sleep(500);
  s = await scene();
  check(`${tag}: Check now in Edit details says it is checking, with a ring`, s.cards.some((c) => c.busy && /Checking for new chapters/.test(c.text || '')), fmt(s));
  checkOverDialog(s, `${tag}: Edit details (a centred dialog)`, wide);
  await shot(`${tag}-4-edit-details`);
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.querySelector('[role="dialog"]')?.parentElement?.click());
  await sleep(4000);

  // The supply line under the title ("fake-a · …") opens it; the other dialog opener there is the Filter chip.
  await page.evaluate(() => [...document.querySelectorAll('button[aria-haspopup="dialog"]')].find((b) => b.offsetParent && b.classList.contains('w-full'))?.click());
  await sleep(1200);
  const sheetOpen = (await scene()).dialogs.length > 0;
  check(`${tag}: Sources & translations opened`, sheetOpen);
  await press('Check now', '[role="dialog"]');
  await waitFor(async () => (await scene()).cards.length > 0, 5000);
  await sleep(500);
  s = await scene();
  checkOverDialog(s, `${tag}: Sources & translations (a Sheet)`, wide);
  await shot(`${tag}-5-sources-sheet`);
  await page.keyboard.press('Escape');
  await sleep(5500);

  // 5. the reader: its sheets run to the bottom edge, and there is no nav
  await go(`/series/?id=${plain.id}`);
  check(`${tag}: a notice to carry into the reader`, !!(await markFromMenu()));
  await holdNotice();
  // Into the reader by the app's own router, so the notice survives the page change.
  await page.evaluate(() => document.querySelector('[id^="ch-"] button[aria-pressed], [id^="ch-"] > div > button')?.click());
  await waitFor(() => page.evaluate(() => location.pathname.startsWith('/reader')), 8000);
  await sleep(1500);
  // Everything in the reader by DOM clicks: the mouse stays on the notice, and Escape there leaves the reader.
  // The reader's own settings sheet springs up from below: measured by its layout box, not its painted one.
  const SLIDERS = 'button:has(path[d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h7M15 18h5"])';
  await page.evaluate((sel) => document.querySelector(sel)?.click(), SLIDERS);
  await sleep(900);
  s = await scene();
  const settings = s.dialogs.at(-1);
  check(`${tag}: the reader's settings sheet is open`, settings?.label === 'Reader', fmt(s));
  check(`${tag}: the notice rises above the reader's settings sheet`, s.place === 'above-sheet' && s.cards.length === 1 && s.cards[0].bottom <= (settings?.panel?.top ?? 0) + 0.5, fmt(s));
  await shot(`${tag}-6-reader-settings`);
  await page.evaluate(() => document.querySelector('[role="dialog"][aria-label="Reader"] h3 + button')?.click());
  await sleep(700);
  await page.evaluate(() => document.querySelector('button[aria-label="Chapters"]')?.click());
  await sleep(800);
  s = await scene();
  const chapters = s.dialogs.at(-1);
  check(`${tag}: the reader's chapter sheet is open`, chapters?.label === 'Chapters', fmt(s));
  check(`${tag}: the notice rises above the chapter sheet`, s.place === 'above-sheet' && s.cards.length === 1 && s.cards[0].bottom <= (chapters?.panel?.top ?? 0) + 0.5, fmt(s));
  check(`${tag}: ...clear of its title`, s.cards.length === 1 && !overlap(s.cards[0], chapters?.title), fmt(s));
  await shot(`${tag}-7-reader-chapter-sheet`);
  await page.evaluate(() => document.querySelector('[role="dialog"][aria-label="Chapters"] button[aria-label="Close"]')?.click());
  await sleep(300);
  await releaseMouse();

  if (wide) return;
  // 6. motion: a busy notice turns and drains; under reduced motion it does neither
  await go(`/series/?id=${tale.id}`);
  await press('Edit details');
  await sleep(700);
  await press('Check for new chapters now', '[role="dialog"]');
  await waitFor(async () => (await scene()).cards.some((c) => c.busy), 5000);
  s = await scene();
  check(`${tag}: a busy notice turns, and its hairline drains`, (s.rings?.turning ?? 0) > 0 && s.hairlines > 0, JSON.stringify({ rings: s.rings, hairlines: s.hairlines }));
  await page.keyboard.press('Escape');
  await sleep(6000);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await go(`/series/?id=${tale.id}`);
  await press('Edit details');
  await sleep(700);
  await press('Check for new chapters now', '[role="dialog"]');
  await waitFor(async () => (await scene()).cards.some((c) => c.busy), 5000);
  s = await scene();
  check(`${tag}: under reduced motion the busy ring is still and nothing drains`,
    s.cards.some((c) => c.busy) && s.rings?.turning === 0 && s.rings?.still > 0 && s.hairlines === 0, JSON.stringify({ rings: s.rings, hairlines: s.hairlines }));
  await shot(`${tag}-8-reduced-motion`);
  await page.keyboard.press('Escape');
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
}

/** #115: a Test of a failing source shows the failing stage by name, on Providers and on Health. */
async function sources(width) {
  const wide = width >= 1024;
  await page.setViewport({ width, height: wide ? 800 : 844 });
  const tag = `${width}`;
  const card = '[data-source-card="fake-a"]';
  await script(FAKE_A, 'search', 0, 'error');
  await go('/admin/?tab=Providers', 3000);
  await page.waitForSelector(`${card} [data-source-test="fake-a"]`, { timeout: 20_000 });
  await page.$eval(card, (el) => el.scrollIntoView({ block: 'center' }));
  await page.click(`${card} [data-source-test="fake-a"]`);
  const clock = await waitFor(() => page.$eval(`${card} [data-source-test="fake-a"]`, (b) => /Testing… \d+:\d\d of up to \d+:\d\d/.test(b.textContent || '') && b.textContent), 5000, 100);
  check(`${tag}: the running Test shows its clock against the limit`, !!clock, String(clock));
  const failed = await waitFor(() => page.$(`${card} [data-source-evidence="test"] [data-evidence-stage="search"][data-evidence-state="fail"]`), 60_000, 300);
  check(`${tag}: Providers -> Test lists ✗ Search`, !!failed);
  const cardText = await page.$eval(card, (el) => el.textContent || '');
  check(`${tag}: never "Working normally." beside a failed step`, !/Working normally\./.test(cardText), cardText.slice(0, 200));
  const mark = await waitFor(() => page.$eval(`${card} [data-status]`, (m) => (m.textContent?.trim() === 'Failing' ? m.getAttribute('data-status') : null)), 15_000, 300);
  check(`${tag}: the card's mark reads Failing, in amber`, mark === 'warn', String(mark));
  await page.$eval(card, (el) => el.scrollIntoView({ block: 'center' }));
  await shot(`${tag}-sources-1-providers-test`);

  await go('/admin/?tab=Providers', 3000);
  const stored = await waitFor(() => page.$(`${card} [data-source-evidence="stored"] [data-evidence-stage="search"][data-evidence-state="fail"]`), 15_000, 300);
  check(`${tag}: after a reload the card still says ✗ Search`, !!stored);
  await page.$eval(card, (el) => el.scrollIntoView({ block: 'center' }));
  await shot(`${tag}-sources-2-providers-reload`);

  await go('/admin/?tab=Health', 4000);
  const hc = '[data-health-check="sources"]';
  await page.waitForSelector(hc, { timeout: 30_000 });
  await page.$eval(`${hc} button`, (b) => b.click());
  const row = await waitFor(() => page.evaluate((hc) => {
    const r = [...document.querySelectorAll(`${hc} [data-source-evidence]`)].map((e) => e.closest('.flex'))
      .find((x) => x?.querySelector('p')?.textContent?.trim() === 'fake-a');
    return r ? !!r.querySelector('[data-evidence-stage="search"][data-evidence-state="fail"]') : null;
  }, hc), 20_000, 300);
  check(`${tag}: Health -> Source health names fake-a with ✗ Search`, row === true, String(row));
  await page.$eval(hc, (el) => el.scrollIntoView({ block: 'start' }));
  await shot(`${tag}-sources-3-health`);

  // Search works again: a Test from the Health row records the pass, and the finding goes.
  await script(FAKE_A, 'search', 0, 'ok');
  const pressed = await page.evaluate((hc) => {
    // The row's keys sit beside its name and evidence, not inside them: the Health item holds both.
    const r = [...document.querySelectorAll(`${hc} [data-source-evidence]`)]
      .find((e) => e.closest('.flex')?.querySelector('p')?.textContent?.trim() === 'fake-a');
    const b = r?.closest('[data-health-item]')?.querySelector('[data-health-action="test"]');
    b?.click();
    return !!b;
  }, hc);
  check(`${tag}: the Health row offers Test`, pressed);
  const gone = await waitFor(() => page.evaluate((hc) => ![...document.querySelectorAll(`${hc} [data-evidence-state="fail"]`)].length, hc), 60_000, 500);
  check(`${tag}: a passing Test from Health clears the ✗`, !!gone);
  await shot(`${tag}-sources-4-health-cleared`);
}

/**
 * The slow archive (#117) at one width. Walk Gap is added through the dialog at 390 and archived from its page at
 * 1280, so each width drives one of the two ways in on a fresh instance. The caller puts the free-space floor back.
 */
async function archive(width) {
  const wide = width >= 1024;
  await page.setViewport({ width, height: wide ? 900 : 844 });
  const tag = `archive-${width}`;
  const FAST = process.env.E2E_ARCHIVE_FAST === '1';
  const text = () => page.evaluate(() => document.body.innerText || '');
  const turning = () => page.evaluate(() => document.querySelectorAll('.animate-ring').length);
  const tileState = () => page.evaluate(() => document.querySelector('[data-downloads-section="queued"] [data-archive]')?.getAttribute('data-archive') ?? null);
  const archived = async (title) => (await api('/api/sources/jobs')).archive?.series?.find((x) => x.title === title) ?? null;
  const floor = (gb) => api('/api/admin/settings', { method: 'PATCH', body: JSON.stringify({ archiveMinFreeGb: gb }) });
  const STOP = '[role="dialog"][aria-label="Stop archiving Walk Gap?"]';
  /**
   * The archive's Details and Stop opened from `where` (a card: the series band, a Needs attention row), each
   * measured as a layer over the whole screen and closed again with Escape.
   */
  const dialogsCoverScreen = async (where, what, n) => {
    await press('Details', where);
    const details = await waitFor(() => overlayBox('[data-archive-sheet]'), 5000);
    check(`${tag}: ${what}'s Details cover the whole screen, not its card`, coversScreen(details), JSON.stringify(details));
    await shot(`${tag}-${n}a-${what.replace(/\W+/g, '-')}-details`);
    await page.keyboard.press('Escape');
    await sleep(400);
    await press('Stop archiving', where);
    const stop = await waitFor(() => overlayBox(STOP), 5000);
    check(`${tag}: ${what}'s Stop asks over the whole screen, not its card`, coversScreen(stop), JSON.stringify(stop));
    await shot(`${tag}-${n}b-${what.replace(/\W+/g, '-')}-stop`);
    await page.keyboard.press('Escape');
    await sleep(400);
    check(`${tag}: ...and Escape leaves it queued`, (await archived('Walk Gap'))?.state === 'queued', JSON.stringify(await archived('Walk Gap')));
  };
  // The archive leaves 20 GB free by default, which one test host has and another does not: it would wait under
  // Needs attention ("Waiting for free disk space") on one and not on the other. With the test knobs the floor goes
  // where no host is first (2000 GB, the setting's most), that row is checked, and then it comes down to 1 GB for
  // the rest of the walk. Without them the scheduler's first look is ten minutes after the boot, no wait is worked
  // out during the walk, and the floor is simply lowered.
  if (!wide) await floor(FAST ? 2000 : 1);

  if (!wide) {
    // 1. The add dialog: the switch exists for "Nothing yet" and not for All, and says how many, which way, how long.
    check(`${tag}: the add dialog opened on Walk Gap`, !!(await openDialogFor('Walk Gap')));
    await page.select('[role="dialog"] select', 'all');
    await sleep(300);
    check(`${tag}: no "Archive the rest slowly" for All`, !(await page.$('[data-archive-rest]')));
    await page.select('[role="dialog"] select', 'none');
    const offered = await waitFor(() => page.$('[data-archive-rest]'), 3000);
    check(`${tag}: "Archive the rest slowly" is offered for Nothing yet`, !!offered);
    const help = await page.$eval('[data-archive-rest] p', (el) => el.textContent).catch(() => '');
    check(`${tag}: its line counts the rest, says the order and the time`, /^14 chapters come in slowly in the background\. Oldest first\. .+ at the current pace\.$/.test(help ?? ''), help);
    await page.click('[role="switch"][aria-label="Archive the rest slowly"]');
    await sleep(300);
    await shot(`${tag}-1-add-dialog`);
    await press('Add to library', '[role="dialog"]');
    const outcome = await waitFor(() => page.$eval('[data-archive-outcome]', (el) => el.getAttribute('data-archive-outcome')).catch(() => null), 20_000);
    check(`${tag}: the done step says the rest was queued`, outcome === 'queued', String(outcome));
    check(`${tag}: and says where to watch it`, /Its chapters come in slowly in the background\. Library → Downloads shows how far it has got\./.test(await text()));
    await shot(`${tag}-2-added`);
    await press('Done', '[role="dialog"]');
    await sleep(500);
  }
  if (FAST && !wide) {
    // 1'. Under Needs attention while the floor is out of reach, with the admin's way to Settings -- and its Details
    // and Stop are layers over the whole screen. The row is a `.card`, whose backdrop-filter would otherwise hold them.
    await go('/library/?view=downloads', 3000);
    const row = await waitFor(() => page.$('[data-downloads-section="attention"] [data-attention="archive"]'), 20_000);
    const said = row ? await row.evaluate((el) => el.textContent ?? '') : '';
    check(`${tag}: out of disk space, the archive waits under Needs attention and says why`, /Waiting for free disk space/.test(said), said);
    check(`${tag}: ...with the admin's way to the setting`, !!(row && (await row.$('a[href="/admin/?tab=Settings"]'))));
    await shot(`${tag}-2b-needs-attention`);
    if (row) await dialogsCoverScreen('[data-attention="archive"]', 'the Needs attention row', '2c');
    await floor(1);
  }
  const gap = await waitFor(() => seriesNamed('Walk Gap'), 20_000, 500);
  if (wide) {
    // 1'. The series page's "Archive slowly", then its band -- the one place on the page to watch it.
    await go(`/series/?id=${gap.id}`, 3000);
    const key = await page.$('button[data-archive-slowly]');
    check(`${tag}: the series page offers Archive slowly`, !!key);
    await key?.click();
    const band = await waitFor(() => page.$('[data-band-state="archive"]'), 15_000);
    check(`${tag}: the band above the chapters shows the archive`, !!band);
    check(`${tag}: once queued, the page no longer offers to start it`, !(await page.$('[data-archive-slowly]')));
    const run = await page.$('[data-run="archive"]');
    check(`${tag}: the older chapters read as a run the archive is fetching, with no Fetch all`, !!run
      && !/Fetch all/.test(await run.evaluate((el) => el.textContent ?? '')));
    await shot(`${tag}-1-series-band`);
    // The band is a `.card` too: its Details and Stop must not open inside it.
    if (band) await dialogsCoverScreen('[data-band-state="archive"]', 'the series band', '1');
  }
  // Once: at 1280 the same source is inside the break its first chapter reserved, which is the point.
  if (FAST && !wide) {
    const landed = await waitFor(async () => ((await archived('Walk Gap'))?.done ?? 0) >= 1, 90_000, 1000);
    check(`${tag}: the archive fetched its first chapter`, !!landed);
  }

  // 2. Library -> Downloads: one still amber cover in Queued, and the Library ring's calm mark.
  await go('/library/?view=downloads', 3500);
  const tile = await waitFor(() => page.$('[data-downloads-section="queued"] [data-archive="queued"]'), 15_000);
  check(`${tag}: the archive is a cover in Queued`, !!tile);
  check(`${tag}: no Running cover for the archive`, !(await page.$('[data-downloads-section="running"] [data-archive]')));
  check(`${tag}: no ring turns for the archive`, (await turning()) === 0, `${await turning()} turning`);
  const mark = await page.evaluate((w) => document.querySelector(w ? 'a[data-downloads-ring]' : 'nav [data-downloads-ring]')?.getAttribute('data-downloads-ring') ?? null, wide);
  check(`${tag}: the Library ring wears the calm slow mark`, mark === 'slow', String(mark));
  check(`${tag}: the Queued line gives the pace`, /Slow archive: 4 chapters an hour per source/.test(await text()));
  if (FAST && !wide) check(`${tag}: the cover counts what came in`, /\b[1-9]\d* of \d+\b/.test(await text()));
  await shot(`${tag}-3-queued`);
  if (wide) {
    // The admin's Pause all is the server-wide switch: every archive says so, and Resume all puts it back.
    await press('Pause all');
    check(`${tag}: Pause all pauses every archive`, !!(await waitFor(async () => /Paused for everyone by an admin/.test(await text()), 10_000)));
    await shot(`${tag}-4-paused-for-everyone`);
    await press('Resume all');
    check(`${tag}: Resume all resumes`, !!(await waitFor(async () => !/Paused for everyone/.test(await text()), 10_000)));
  }

  // 3. Its sheet: Pause, Resume, then a confirmed Stop.
  await page.click('[data-downloads-section="queued"] [data-archive] button');
  const sheet = await waitFor(() => page.$('[data-archive-sheet]'), 5000);
  check(`${tag}: the cover opens its sheet`, !!sheet);
  await sleep(400);
  await shot(`${tag}-5-sheet`);
  await press('Pause', '[data-archive-sheet]');
  check(`${tag}: Pause pauses it`, (await waitFor(async () => (await tileState()) === 'paused', 10_000)) === true);
  await press('Resume', '[data-archive-sheet]');
  check(`${tag}: Resume resumes it`, (await waitFor(async () => (await tileState()) === 'queued', 10_000)) === true);
  await press('Stop archiving', '[data-archive-sheet]');
  const asked = await waitFor(async () => /Stop archiving Walk Gap\?/.test(await text()), 5000);
  check(`${tag}: Stop asks first`, !!asked);
  await shot(`${tag}-6-stop-confirm`);
  await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].filter((b) => b.textContent?.trim() === 'Stop archiving').at(-1)?.click());
  check(`${tag}: Stop removes it`, !!(await waitFor(async () => !(await archived('Walk Gap')) && !(await page.$('[data-archive]')), 15_000)));
  if (FAST && !wide) {
    check(`${tag}: Came in today sums up the archive's chapters`, /Slow archive: \d+ chapters? today/.test(await text()));
    await shot(`${tag}-7-came-in`);
  }
  if (!wide) {
    // The Library selection's way in: on a phone a row of More, for whoever may download.
    await go('/library/', 3000);
    await press('Select');
    await sleep(500);
    await page.evaluate(() => [...document.querySelectorAll('button.group')].find((b) => /Walk Gap/.test(b.textContent ?? ''))?.click());
    await sleep(400);
    check(`${tag}: the phone bar has no Archive slowly key of its own`, !(await page.evaluate(() => [...document.querySelectorAll('button')]
      .some((b) => b.offsetParent && b.textContent?.trim() === 'Archive slowly'))));
    await press('More');
    const row = await waitFor(() => page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].some((b) => b.textContent?.trim() === 'Archive slowly')), 5000);
    check(`${tag}: More offers Archive slowly`, !!row);
    await shot(`${tag}-7b-library-more`);
    await press('Archive slowly', '[role="dialog"]');
    check(`${tag}: the selection is queued, and the notice says so`, !!(await waitFor(async () => /Archiving Walk Gap slowly/.test(await text()), 10_000)));
    const again = await archived('Walk Gap');
    check(`${tag}: the Library selection queued the archive`, again?.state === 'queued', JSON.stringify(again));
    await api(`/api/sources/archive/${encodeURIComponent(gap.id)}`, { method: 'DELETE', body: '{}' });
  }

  // 4. Admin -> Settings -> Downloads, with the window's rows open.
  await go('/admin/?tab=Settings', 3000);
  const section = await waitFor(() => page.$('section#downloads'), 10_000);
  check(`${tag}: Settings has the Downloads section`, !!section);
  await section?.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.click('section#downloads [role="switch"][aria-label="Only during set hours"]').catch(() => {});
  const rows = await waitFor(async () => /From \(hour, 0–23\)/.test(await text()), 10_000);
  check(`${tag}: "Only during set hours" opens From and Until`, !!rows);
  await (await page.$('section#downloads'))?.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await sleep(500);
  await shot(`${tag}-8-settings`);
  await page.click('section#downloads [role="switch"][aria-label="Only during set hours"]').catch(() => {});
  await sleep(800);

  if (wide) {
    // 5. The add dialog at a desktop width, for a Latest-N pick: newest first, and nothing added. On Walk Tale: Next,
    // fake-b's alone and added by no phase: a title already in the library opens no dialog, and Walk Tale -- this
    // step's series while the phase ran before notices -- is in it once notices has run.
    const opened = await openDialogFor('Walk Tale: Next', 'fake-b');
    if (opened) {
      await page.select('[role="dialog"] select', 'latest:10');
      await page.click('[role="switch"][aria-label="Archive the rest slowly"]').catch(() => {});
      await sleep(400);
      const help = await page.$eval('[data-archive-rest] p', (el) => el.textContent).catch(() => '');
      check(`${tag}: a Latest-N pick archives the older ones newest first`, /^18 older chapters come in slowly in the background\. Newest first\./.test(help ?? ''), help);
      await shot(`${tag}-9-add-dialog-latest`);
      await page.keyboard.press('Escape');
    } else check(`${tag}: the add dialog opened on Walk Tale: Next`, false);

    // 6. A member who did not queue it: the cover, its sheet and the series band say how far it has got, and offer
    // no key. Pause, Resume and Stop are for the one who queued it and for admins (the server refuses anyone else,
    // and ArchiveItem.may mirrors that); the server-wide Pause all is an admin's.
    const queued = await api('/api/sources/archive', { method: 'POST', body: JSON.stringify({ seriesIds: [gap.id] }) });
    check(`${tag}: the admin queues Walk Gap again, for the member to see`, queued.results?.[0]?.outcome === 'queued', JSON.stringify(queued));
    await memberSeesNoKeys(tag, gap);
    await api(`/api/sources/archive/${encodeURIComponent(gap.id)}`, { method: 'DELETE', body: '{}' });
  }
}

/** A member who may add series and so reaches Library -> Downloads (run.mjs's no-download member cannot). */
const MEMBER = { username: 'e2e-member49', password: 'e2e-member-passw0rd-49' };
const KEYS = ['Pause', 'Resume', 'Stop archiving', 'Dismiss', 'Pause all', 'Resume all'];

/**
 * The member's own browser context, so its session never replaces the admin's refresh cookie, at the admin page's
 * size. Library -> Downloads: the archive's cover in Queued with no Pause all over it, and its sheet with no key but
 * the way to the series; the series page: the band with no key but Details.
 */
async function memberSeesNoKeys(tag, gap) {
  const made = await fetch(`${BASE}/api/admin/users`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ ...MEMBER, role: 'user', perms: { canDownload: true } }),
  });
  check(`${tag}: a member who may add series`, [200, 201, 409].includes(made.status), `${made.status} ${(await made.text()).slice(0, 120)}`);
  const ctx = await browser.createBrowserContext();
  try {
    const m = watch(await ctx.newPage(), 'member: ');
    await m.setViewport(page.viewport());
    const signed = await signIn(m, MEMBER.username, MEMBER.password);
    check(`${tag}: signed in as the member`, signed);
    if (!signed) return;
    const keysIn = (sel) => m.evaluate((sel, keys) => [...document.querySelectorAll(sel)].flatMap((el) => [...el.querySelectorAll('button')])
      .map((b) => b.textContent?.trim()).filter((t) => keys.includes(t)), sel, KEYS);
    await m.goto(`${BASE}/library/?view=downloads`, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    const tile = await waitFor(() => m.$('[data-downloads-section="queued"] [data-archive="queued"]'), 15_000);
    check(`${tag}: the member sees the archive's cover in Queued`, !!tile);
    const over = await keysIn('[data-downloads-view], [data-downloads-section]');
    check(`${tag}: ...with no Pause all, Resume all or any other archive key on the view`, over.length === 0, JSON.stringify(over));
    await shot(`${tag}-10-member-queued`, m);
    await m.click('[data-downloads-section="queued"] [data-archive] button').catch(() => {});
    const sheet = await waitFor(() => m.$('[data-archive-sheet]'), 5000);
    const inSheet = sheet ? await keysIn('[data-archive-sheet]') : ['(no sheet)'];
    check(`${tag}: the member's sheet has no Pause, Resume or Stop`, inSheet.length === 0, JSON.stringify(inSheet));
    check(`${tag}: ...and still the way to the series`, !!(await m.$('[data-archive-sheet] a[href*="/series/"]')));
    await sleep(300);
    await shot(`${tag}-11-member-sheet`, m);
    await m.keyboard.press('Escape');
    await m.goto(`${BASE}/series/?id=${gap.id}`, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    const band = await waitFor(() => m.$('[data-band-state="archive"]'), 15_000);
    const inBand = band ? await keysIn('[data-band-state="archive"]') : ['(no band)'];
    check(`${tag}: the member's series band shows the archive with no key to press`, inBand.length === 0, JSON.stringify(inBand));
    check(`${tag}: ...its Details still there`, !!band && (await band.evaluate((el) => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Details'))));
    check(`${tag}: ...and no Archive slowly while it runs`, !(await m.$('[data-archive-slowly]')));
    await band?.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await sleep(300);
    await shot(`${tag}-12-member-band`, m);
  } finally {
    await ctx.close();
  }
}

/**
 * What the fake engine serves for Webtoons.com's Istrevelia, worked out from the engine's own seed: how many posts,
 * the numbers the extension gives them and how many posts share each, the number most of them share, and the posts
 * whose titles carry no number. Each of those is alone on its number (the one before it plus 0.01) and sits at a
 * fixed place in posting order, so the plan's line for it -- which file becomes which chapter -- is known in advance.
 */
const IST = (() => {
  const posts = istreveliaPosts();
  const numbers = webtoonsNumbers(posts, false).map((x) => x.chapterNumber);
  const shared = new Map();
  for (const n of numbers) shared.set(n, (shared.get(n) ?? 0) + 1);
  const [bigNumber, bigPosts] = [...shared].sort((a, b) => b[1] - a[1])[0];
  return {
    posts: posts.length, numbers: shared.size, first: Math.min(...numbers), last: Math.max(...numbers), onFirst: shared.get(Math.min(...numbers)),
    big: { number: bigNumber, posts: bigPosts },
    lone: posts.map((p, i) => ({ place: i + 1, number: numbers[i], title: p.name.trim() })).filter((x) => !Number.isInteger(x.number)),
  };
})();
/** Walk Webtoon, the engine's clean series next to Istrevelia: one post per number. */
const CLEAN = defaultSeed().sources.find((s) => s.id === SOURCE_IDS.webtoons).mangas.find((m) => m.title === 'Walk Webtoon').chapters.length;
/** What the 390 half hands the 1280 half: the series, and the one book followed through every renaming. */
const numbered = { seriesId: null, bookId: null };

/** #116 at one width (see the header): the add and the detector's review at 390, the way back and the remap at 1280. */
async function numbering(width) {
  const wide = width >= 1024;
  await page.setViewport({ width, height: wide ? 900 : 844 });
  const tag = `numbering-${width}`;
  const WT = SOURCE_IDS.webtoons;
  const text = () => page.evaluate(() => document.body.innerText || '');
  const notice = () => page.$eval('[data-numbering-notice]', (e) => ({ kind: e.getAttribute('data-numbering-notice'), text: e.textContent || '' })).catch(() => null);
  const noticeIs = (kind) => waitFor(() => notice().then((n) => (n?.kind === kind ? n : null)), 15_000);
  /** The plan sheet's lines, each [from, arrow, to, title]: ["Ch. 1.01", "→", "Ch. 20", "· Q&A"]. */
  const planLines = () => page.$$eval('[data-plan-move]', (els) => els.map((li) => [...li.querySelectorAll('span')].map((s) => s.textContent.trim())));
  /**
   * Every post alone on its number moves from that number to its place in posting order (or, `back`, the other way).
   * A remap's lines carry the extension's own name for the post, " (ch. 20)" and all; the posting-order plans do not.
   */
  const lonesMove = (lines, back = false) => IST.lone.every((x) => lines.some(([from, , to, title]) =>
    from === `Ch. ${back ? x.place : x.number}` && to === `Ch. ${back ? x.number : x.place}`
    && title?.replace(/\s*\(ch\.\s*[\d.]+\)$/, '') === `· ${x.title}`));
  const moves = (back = false) => IST.lone.map((x) => (back ? `${x.place} → ${x.number}` : `${x.number} → ${x.place}`)).join(', ');
  /** Open the plan from a notice key, and read it: the count line and its lines. */
  const openPlan = async (key) => {
    await press(key, '[data-numbering-notice]');
    const plan = await waitFor(() => page.$('[data-numbering-plan]'), 20_000);
    await sleep(300);
    return {
      open: !!plan,
      title: await page.$eval('[data-numbering-plan]', (e) => e.closest('[role="dialog"]')?.getAttribute('aria-label') ?? null).catch(() => null),
      says: await page.$eval('[data-numbering-plan] > p', (e) => e.textContent.trim()).catch(() => ''),
      lines: plan ? await planLines() : [],
    };
  };
  /** Rename the files, and wait for the sheet to close on its answer. No plan on screen is no rename. */
  const confirmPlan = async () => {
    const key = await page.$('[data-plan-confirm]');
    if (!key) return false;
    await key.click();
    return waitFor(async () => !(await page.$('[data-numbering-plan]')), 60_000, 500);
  };
  const books = async (id) => (await api(`/api/series/${encodeURIComponent(id)}/books?size=500`)).content ?? [];
  const followed = async () => (await books(numbered.seriesId)).find((b) => b.id === numbered.bookId) ?? null;
  const q = IST.lone[0];

  if (!wide) {
    // The engine answering, and its Webtoons.com switched on: a fresh engine's sources start off (Admin -> Extensions),
    // so an add from one begins with an admin's yes -- given over the API here, as the notices phase adds Walk Tale.
    const up = await fetch(`${ENGINE}/__mode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'up' }) }).catch(() => null);
    check(`${tag}: the fake extension engine answers at ${ENGINE}`, !!up?.ok, 'start up.sh with E2E_ENGINE=fake, or set ENGINE');
    if (!up?.ok) return;
    const on = await api(`/api/admin/extensions/sources/${WT}`, { method: 'POST', body: JSON.stringify({ enabled: true }) });
    check(`${tag}: Webtoons.com is switched on, and its smoke test passes`, on.smoke?.ok === true, JSON.stringify(on.smoke).slice(0, 300));

    // 1. Discover -> Istrevelia: every post a chapter of its own, and the dialog says why they are not the source's numbers.
    check(`${tag}: the add dialog opened on Istrevelia`, !!(await openDialogFor('Istrevelia', 'Webtoons')));
    const count = await waitFor(async () => { const t = await detailCount(); return /\d/.test(t) ? t : null; }, 20_000);
    check(`${tag}: the add reads ${IST.posts} chapters, 1–${IST.posts}, not ${IST.numbers} numbers with versions`, count === `${IST.posts} chapters · 1–${IST.posts}`, String(count));
    const n = await page.$eval('[data-add-numbering]', (e) => ({ kind: e.getAttribute('data-add-numbering'), text: e.textContent || '', href: e.querySelector('a')?.getAttribute('href') ?? null })).catch(() => null);
    check(`${tag}: its notice says numbered by posting order, and why`, n?.kind === 'strong' && n.text.includes('Numbered by posting order')
      && n.text.includes(`(${IST.big.posts} posts are all numbered ${IST.big.number})`), n?.text);
    check(`${tag}: ...with both readings side by side`, !!n?.text.includes(`Posting order: ${IST.posts} · the source’s own numbers: ${IST.numbers}`), n?.text);
    check(`${tag}: ...and an admin's way to the source's own settings`, n?.href === `/admin/?tab=Extensions&settings=${WT}`, String(n?.href));
    const all = () => page.$eval('[role="dialog"] select option[value="all"]', (o) => o.textContent).catch(() => null);
    check(`${tag}: All fetches every post`, (await all()) === `All (${IST.posts})`, String(await all()));
    check(`${tag}: no sideways scroll`, await noSideScroll());
    await page.$eval('[data-add-numbering]', (e) => e.scrollIntoView({ block: 'center' })).catch(() => {});
    await shot(`${tag}-1-add-dialog`);

    // 2. The switch: the source's own numbers, and the add keeps them -- the state every Webtoons series of a v0.48.4
    // library is in, which is what the rest of the phase needs.
    await page.click('[role="dialog"] [role="switch"][aria-label="Keep the source’s numbers"]');
    const kept = await waitFor(async () => { const t = await detailCount(); return t.startsWith(`${IST.numbers} `) ? t : null; }, 5000);
    check(`${tag}: Keep the source’s numbers reads its ${IST.numbers} numbers`, kept === `${IST.numbers} chapters · ${IST.first}–${IST.last}`, String(kept ?? await detailCount()));
    check(`${tag}: ...and All is those ${IST.numbers}`, (await all()) === `All (${IST.numbers})`, String(await all()));
    await sleep(400); // the switch's knob slides; a picture taken at once shows it half-way
    await shot(`${tag}-2-keep-source-numbers`);
    // Every number fetched now, and no scheduled check: the first sweep comes ten minutes after the boot, and one
    // that came round mid-walk would fetch posts the walk's plans do not know about.
    await page.select('[role="dialog"] select', 'all');
    await page.click('[role="dialog"] [role="switch"][aria-label="Auto-update new chapters"]');
    await press('Add to library', '[role="dialog"]');
    const job = await waitFor(async () => {
      const j = (await api('/api/sources/jobs')).content?.find((x) => x.title === 'Istrevelia');
      return j?.status === 'done' ? j : null;
    }, 90_000, 1000);
    check(`${tag}: the add fetched all ${IST.numbers}`, job?.done === IST.numbers, JSON.stringify(job));
    await press('Done', '[role="dialog"]');
    await sleep(500);
  }
  const s = numbered.seriesId ? { id: numbered.seriesId } : await waitFor(() => seriesNamed('Istrevelia'), 20_000, 500);
  if (!s) { check(`${tag}: Istrevelia is in the library`, false); return; }
  numbered.seriesId = s.id;

  if (!wide) {
    const got = await books(s.id);
    const listed = await api(`/api/series/${s.id}/listing`);
    check(`${tag}: the series has the source's ${IST.numbers} numbers, as asked`, got.length === IST.numbers && listed.numbering?.mode === 'source'
      && listed.numbering?.by === 'manual', JSON.stringify({ books: got.length, numbering: listed.numbering && { mode: listed.numbering.mode, by: listed.numbering.by } }));
    numbered.bookId = got.find((b) => b.number === q.number)?.id ?? null;

    // 3. The versions sheet: the posts the extension numbered 1, each under its own title, and what they really are.
    await go(`/series/?id=${s.id}`, 3000);
    await page.evaluate(() => document.getElementById('ch-1')?.querySelector('button[aria-label="Chapter actions"]')?.click());
    await sleep(400);
    await press('Versions');
    const titles = await waitFor(() => page.$$eval('[data-copy-title]', (els) => els.map((e) => e.textContent.trim())).then((t) => (t.length ? t : null)), 8000);
    check(`${tag}: the versions sheet lists the ${IST.onFirst} posts on Ch. 1, each under its own title`,
      titles?.length === IST.onFirst && new Set(titles).size === titles.length, JSON.stringify(titles?.slice(0, 3)));
    const share = await page.$eval('[data-posts-share-number]', (e) => e.textContent || '').catch(() => '');
    check(`${tag}: ...and says they are different posts, not versions of one chapter`, share.includes('These look like different posts that share a number, not versions of one chapter.'), share);
    await sleep(300);
    await shot(`${tag}-3-versions`);
    // An admin's own way to the plan from there; it is only looked at here.
    await press('Number by posting order', '[data-posts-share-number]');
    const fromVersions = await waitFor(async () => (await page.$('[data-numbering-plan]')) && planLines(), 20_000);
    check(`${tag}: ...whose Number by posting order opens the plan: ${moves()}`, !!fromVersions && lonesMove(fromVersions), JSON.stringify(fromVersions).slice(0, 300));
    await press('Cancel', '[role="dialog"]');
    await sleep(500);

    // 4. A read mark on the one post the extension numbered 1.01, to follow through every renaming.
    await page.evaluate((id) => document.getElementById(id)?.querySelector('button[aria-label="Chapter actions"]')?.click(), `ch-${q.number}`);
    await sleep(400);
    await press('Mark read');
    const read = await waitFor(async () => (await followed())?.readProgress?.completed === true, 10_000, 500);
    check(`${tag}: Ch. ${q.number} (${q.title}) is marked read`, !!read);

    // 5. Handed back to the detector -- a v0.48.4 library's state: numbered by the source, and by nobody's choice (no
    // screen offers that; an upgrade leaves it) -- its next check holds the series for review instead of renaming it.
    await api(`/api/admin/series/${s.id}/numbering`, { method: 'POST', body: JSON.stringify({ mode: 'auto' }) });
    await api(`/api/admin/series/${s.id}/check`, { method: 'POST', body: '{}' });
    await waitFor(async () => (await api(`/api/admin/series/${s.id}/check`)).running === false, 30_000, 1000);
    await go(`/series/?id=${s.id}`, 3000);
    const held = await noticeIs('review');
    check(`${tag}: the series waits for a review, and says why`, !!held && held.text.includes('Chapter numbers need a review')
      && held.text.includes(`(${IST.big.posts} posts are all numbered ${IST.big.number})`) && held.text.includes('new ones wait until the renumbering is reviewed'), held?.text);
    const keys = await page.$$eval('[data-numbering-notice] button', (bs) => bs.map((b) => b.textContent.trim())).catch(() => []);
    check(`${tag}: ...offering Review renumbering and Keep the source’s numbers`, keys.includes('Review renumbering') && keys.includes('Keep the source’s numbers'), JSON.stringify(keys));
    check(`${tag}: no sideways scroll on the series page`, await noSideScroll());
    await page.$eval('[data-numbering-notice]', (e) => e.scrollIntoView({ block: 'center' })).catch(() => {});
    await shot(`${tag}-4-review`);

    // 6. The plan says which file becomes which chapter before anything moves; Rename the files moves them, and the
    // read mark moves with its chapter (the book is renamed in place: same id, same progress).
    const plan = await openPlan('Review renumbering');
    check(`${tag}: Review renumbering opens the plan, counted`, plan.open && plan.says.startsWith(`${plan.lines.length} chapters renamed`), plan.says);
    check(`${tag}: ...naming each file's new chapter: ${moves()}`, lonesMove(plan.lines), JSON.stringify(plan.lines).slice(0, 400));
    check(`${tag}: ...and saying reading progress stays with its chapter`, (await text()).includes('Reading progress, bookmarks and notes stay with their chapters.'));
    await shot(`${tag}-5-plan`);
    check(`${tag}: Rename the files renames them, and the sheet closes`, !!(await confirmPlan()));
    const applied = await noticeIs('applied');
    check(`${tag}: the series now says it is numbered by posting order, 1–${IST.posts}`, !!applied && applied.text.includes('Numbered by posting order since')
      && applied.text.includes(`1–${IST.posts}`), applied?.text);
    const moved = await followed();
    check(`${tag}: the read mark moved with its chapter: Ch. ${q.number} is Ch. ${q.place} now, and still read`,
      moved?.number === q.place && moved?.readProgress?.completed === true, JSON.stringify(moved && { number: moved.number, read: moved.readProgress?.completed }));
    const after = await api(`/api/series/${s.id}/listing`);
    check(`${tag}: the list runs 1–${IST.posts}: ${IST.posts - IST.numbers} chapters not on the server`, after.content?.length === IST.posts - IST.numbers, String(after.content?.length));
    await page.$eval('[data-numbering-notice]', (e) => e.scrollIntoView({ block: 'center' })).catch(() => {});
    await shot(`${tag}-6-renumbered`);

    // 7. The notice's Source settings: the extension's own settings, where a numbering switch no longer touches a series
    // numbered by posting order.
    await press('Source settings', '[data-numbering-notice]');
    const sheet = await waitFor(() => page.$eval('[data-ext-settings]', (e) => e.textContent || ''), 15_000);
    check(`${tag}: Source settings opens the extension's own settings`, !!sheet && sheet.includes('Use sequential chapter numbering'), sheet?.slice(0, 200));
    const warn = await page.$eval(`[data-pref="${SEQUENTIAL_KEY}"] [data-renumber-warning]`, (e) => e.textContent || '').catch(() => '');
    check(`${tag}: ...its numbering switch warns, and leaves a series numbered by posting order alone`,
      warn.includes('No series in your library use them yet.') && warn.includes('Series numbered by posting order are not affected.'), warn);
    await page.$eval(`[data-pref="${SEQUENTIAL_KEY}"]`, (e) => e.scrollIntoView({ block: 'center' })).catch(() => {});
    await shot(`${tag}-7-source-settings`);
    await page.keyboard.press('Escape');
    await sleep(600);
    check(`${tag}: closing it takes ?settings= off the address`, !/settings=/.test(page.url()), page.url());
    return;
  }

  // 8. A webtoon that numbers cleanly: its own chapters, and the dialog has nothing to say about numbering.
  check(`${tag}: the add dialog opened on Walk Webtoon`, !!(await openDialogFor('Walk Webtoon', 'Webtoons')));
  const clean = await waitFor(async () => { const t = await detailCount(); return /\d/.test(t) ? t : null; }, 20_000);
  check(`${tag}: a clean webtoon reads its ${CLEAN} chapters, and no numbering notice`, clean === `${CLEAN} chapters · 1–${CLEAN}` && !(await page.$('[data-add-numbering]')), String(clean));
  await shot(`${tag}-1-clean-add-dialog`);
  await page.keyboard.press('Escape');
  await sleep(500);

  // 9. The way back: the series' own notice offers the source's numbers, through the same plan.
  await go(`/series/?id=${s.id}`, 3000);
  check(`${tag}: the series says it is numbered by posting order`, !!(await noticeIs('applied')));
  const back = await openPlan('Use the source’s numbers');
  check(`${tag}: Use the source’s numbers opens its plan, under its own title`, back.open && back.title === 'Use the source’s numbers', String(back.title));
  check(`${tag}: ...naming each file's chapter back: ${moves(true)}`, lonesMove(back.lines, true), JSON.stringify(back.lines).slice(0, 400));
  await shot(`${tag}-2-plan-back`);
  check(`${tag}: Rename the files puts them back, and the sheet closes`, !!(await confirmPlan()));
  const home = await followed();
  check(`${tag}: Ch. ${q.place} is Ch. ${q.number} again, and still read`, home?.number === q.number && home?.readProgress?.completed === true,
    JSON.stringify(home && { number: home.number, read: home.readProgress?.completed }));
  check(`${tag}: a series an admin put on the source's numbers carries no notice`, !!(await waitFor(async () => !(await page.$('[data-numbering-notice]')), 10_000)));

  // 10. Admin -> Extensions -> Webtoons.com -> Settings. Its sequential-numbering switch moves the source's numbers
  // under every series that uses them -- Istrevelia again -- so it says so before it is touched, and asks again.
  await go('/admin/?tab=Extensions', 3500);
  const opened = await waitFor(() => page.evaluate(() => {
    const b = [...document.querySelectorAll('button.btn-key')].find((x) => x.textContent?.trim() === 'Settings' && /Webtoons\.com/.test(x.parentElement?.textContent || ''));
    b?.scrollIntoView({ block: 'center' });
    b?.click();
    return !!b;
  }), 15_000);
  check(`${tag}: Webtoons.com's row in Admin -> Extensions has a Settings key`, !!opened);
  const row = `[data-pref="${SEQUENTIAL_KEY}"]`;
  const warn = await waitFor(() => page.$eval(`${row} [data-renumber-warning]`, (e) => e.textContent || ''), 15_000);
  check(`${tag}: its numbering switch warns that it renumbers the series using the source's numbers`,
    /Changing this renumbers every series from .+ that uses its numbers \(1 series in your library\)\./.test(warn ?? '')
    && !!warn?.includes('Each waits on its series page until you review its renumbering: files are renamed, reading progress stays.'), String(warn));
  await page.$eval(row, (e) => e.scrollIntoView({ block: 'center' })).catch(() => {});
  await shot(`${tag}-3-extension-settings`);
  const writes = async () => (await (await fetch(`${ENGINE}/__state`)).json()).prefWrites ?? [];
  const before = (await writes()).length;
  await page.click(`${row} [role="switch"]`);
  const ask = await waitFor(() => page.$eval('[data-renumber-confirm]', (e) => e.textContent || ''), 5000);
  check(`${tag}: switching it asks again first, inside the sheet`, !!ask?.includes('Renumber 1 series?')
    && ask.includes('Nothing is renamed until you confirm each one on its series page.'), String(ask));
  check(`${tag}: ...and nothing reaches the extension until then`, (await writes()).length === before, String((await writes()).length - before));
  await page.$eval('[data-renumber-confirm]', (e) => e.scrollIntoView({ block: 'center' })).catch(() => {});
  await shot(`${tag}-4-renumber-confirm`);
  await press('Change it', '[data-renumber-confirm]');
  check(`${tag}: Change it saves, and says one series waits for its review`,
    !!(await waitFor(async () => (await text()).includes('Saved. 1 series is waiting for you to review the renumbering.'), 15_000)));
  const wrote = (await writes()).slice(before);
  check(`${tag}: ...and the extension took the change`, wrote.length === 1 && JSON.stringify(wrote[0]).includes('true'), JSON.stringify(wrote).slice(0, 300));
  await page.keyboard.press('Escape');
  await sleep(500);

  // 11. The series waits on its page for the remap the setting queued; its plan moves each file to the source's new
  // number, which for the sequential switch is the post's place -- and the read mark goes with it once more.
  await go(`/series/?id=${s.id}`, 3000);
  const remap = await noticeIs('remap');
  check(`${tag}: the series says the source's numbers changed, and waits`, !!remap && remap.text.includes('The source’s numbers changed'), remap?.text);
  await page.$eval('[data-numbering-notice]', (e) => e.scrollIntoView({ block: 'center' })).catch(() => {});
  await shot(`${tag}-5-remap-notice`);
  const again = await openPlan('Review renumbering');
  check(`${tag}: its plan moves each file to the source's new number: ${moves()}`, again.open && lonesMove(again.lines), JSON.stringify(again.lines).slice(0, 400));
  await shot(`${tag}-6-remap-plan`);
  check(`${tag}: Rename the files renames them, and the sheet closes`, !!(await confirmPlan()));
  const last = await followed();
  check(`${tag}: Ch. ${q.number} is Ch. ${q.place} in the source's new numbers, and still read`, last?.number === q.place && last?.readProgress?.completed === true,
    JSON.stringify(last && { number: last.number, read: last.readProgress?.completed }));
  check(`${tag}: nothing waits any more`, !!(await waitFor(async () => !(await page.$('[data-numbering-notice]')), 10_000)));
  await shot(`${tag}-7-remapped`);
}

try {
  if (PHASES.includes('notices')) {
    // A series with sources, for the two Check now buttons: Walk Tale from fake-a, four chapters in.
    if (!(await seriesNamed('Walk Tale'))) {
      await api('/api/sources/add', { method: 'POST', body: JSON.stringify({ source: 'fake-a', sourceId: 'walk-tale', chapterCount: 4, chapterFrom: 'oldest', autoUpdate: true }) });
      await waitFor(async () => !!(await seriesNamed('Walk Tale')), 60_000, 1000);
    }
    for (const w of [390, 1024]) {
      console.log(`\n  notices @${w}`);
      await notices(w);
    }
  }
  if (PHASES.includes('archive')) {
    // The archive's free-space floor, which the phase raises and lowers: put back as it was, pass or fail, so no
    // later phase or walk on this instance inherits a test value.
    const floorWas = (await api('/api/admin/settings')).archive_min_free_gb;
    try {
      for (const w of [390, 1280]) {
        console.log(`\n  archive @${w}`);
        await archive(w);
      }
    } finally {
      const back = await api('/api/admin/settings', { method: 'PATCH', body: JSON.stringify({ archiveMinFreeGb: floorWas }) })
        .then(() => api('/api/admin/settings')).catch(() => null);
      check('archive: the free-space floor is back where it was', back?.archive_min_free_gb === floorWas, `${back?.archive_min_free_gb} vs ${floorWas}`);
    }
  }
  // #116 on the fake extension engine: before the engine phase, which resets that engine and takes it down.
  if (PHASES.includes('numbering')) {
    for (const w of [390, 1280]) {
      console.log(`\n  numbering @${w}`);
      await numbering(w);
    }
  }
  if (PHASES.includes('sources')) {
    for (const w of [390, 1280]) {
      console.log(`\n  sources @${w}`);
      await sources(w);
    }
  }
  // #72: the extension engine's setup screen and the way back (engineWalk.mjs; up.sh with E2E_ENGINE=fake). Last: it
  // resets the fake engine and takes it down.
  if (PHASES.includes('engine')) {
    const { engineWalk } = await import('./engineWalk.mjs');
    await engineWalk({ page, api, go, press, shot, check, waitFor, sleep });
  }
} catch (e) {
  check('the walk ran to the end', false, String(e?.stack || e));
}
check('no 5xx along the way', serverErrors.length === 0, serverErrors.slice(0, 5).join(' | '));
check('no console errors along the way', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));
await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ok, ${failed} failure(s)`);
process.exit(failed ? 1 : 0);
