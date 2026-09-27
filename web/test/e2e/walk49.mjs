// Browser acceptance walk for v0.49.0, one phase per workstream, run in order on a fresh instance of its own:
//
//   KEEP=1 E2E_NET=uchiyomi-e2e-49 E2E_PORT=18149 E2E_SUBNET=10.222.9.0/24 bash web/test/e2e/up.sh
//   cd web && BASE=http://127.0.0.1:18149 npm run test:e2e:v049            # every phase
//   cd web && BASE=http://127.0.0.1:18149 PHASES=notices npm run test:e2e:v049
//
// Phases (later steps of the release add theirs here):
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
//   Resume and a confirmed Stop. At 1280: the series page's "Archive slowly" and its band, the admin's Pause all
//   and Resume all, the sheet, Admin -> Settings -> Downloads with its window rows, and the add dialog for a
//   Latest-N pick. No ring in any of it turns. With E2E_ARCHIVE_FAST=1 (a stack started with the archive's test
//   knobs -- ARCHIVE_FIRST_RUN_MS, ARCHIVE_MIN_BREAK_MS, ARCHIVE_PAGE_GAP_MS, ARCHIVE_TICK_MS) it also waits for
//   the first chapter to land and be counted, and for Came in today to sum it up.
//
// Screenshots go to $OUT (default shots49). LOOK at them: every check here is geometry, and geometry passes on
// a card that is transparent, clipped or unreadable.
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:18149';
const USER = process.env.E2E_USER || 'e2e';
const PASS = process.env.E2E_PASS || 'e2e-passw0rd-123';
const OUT = process.env.OUT || 'shots49';
const PHASES = (process.env.PHASES || 'notices').split(',').map((s) => s.trim()).filter(Boolean);
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
const page = await browser.newPage();
const serverErrors = [];
const consoleErrors = [];
page.on('response', (r) => { if (r.status() >= 500) serverErrors.push(`${r.status()} ${r.url()}`); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/401|auth\/me|Failed to load resource/.test(m.text())) consoleErrors.push(m.text()); });
await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForSelector('input[type=password]', { timeout: 30000 });
await sleep(2500); // the form renders again once /auth/config answers; typing before that is lost
await (await page.$$('input'))[0].type(USER);
await page.type('input[type=password]', PASS);
await page.keyboard.press('Enter');
await sleep(4000);
check('signed in', !(await page.$('input[type=password]')));

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
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log(`         shot ${name}`); };

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

/**
 * The slow archive (#117) at one width. `series` is added through the dialog at 390 and archived from its page
 * at 1280, so each width drives one of the two ways in on a fresh instance.
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
  // The archive leaves 20 GB free by default, which a test host may not have: it would wait under Needs
  // attention ("Waiting for free disk space") for the whole walk. That row is checked, then the floor lowered.
  if (!wide) await api('/api/admin/settings', { method: 'PATCH', body: JSON.stringify({ archiveMinFreeGb: 1 }) });
  const openDialogFor = async (title) => {
    await go('/discover/');
    const input = await page.waitForSelector('input[aria-label="Search all sources…"]', { timeout: 20_000 });
    await input.type(title);
    await press('Search');
    const card = await waitFor(() => page.evaluateHandle((t) => [...document.querySelectorAll('button[aria-label="Add to library"]')]
      .find((b) => b.querySelector('p')?.textContent?.trim() === t) || null, title).then((h) => h.asElement()), 15_000);
    if (!card) throw new Error(`no ${title} card on Discover`);
    await card.click();
    await sleep(800);
    await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find((b) => /^fake-a/.test(b.textContent?.trim() ?? ''))?.click());
    return waitFor(async () => !!(await page.$('[role="dialog"] select')), 10_000);
  };

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
    // 5. The add dialog at a desktop width, for a Latest-N pick: newest first, and nothing added.
    const opened = await openDialogFor('Walk Tale');
    if (opened) {
      await page.select('[role="dialog"] select', 'latest:10');
      await page.click('[role="switch"][aria-label="Archive the rest slowly"]').catch(() => {});
      await sleep(400);
      const help = await page.$eval('[data-archive-rest] p', (el) => el.textContent).catch(() => '');
      check(`${tag}: a Latest-N pick archives the older ones newest first`, /^2 older chapters come in slowly in the background\. Newest first\./.test(help ?? ''), help);
      await shot(`${tag}-9-add-dialog-latest`);
      await page.keyboard.press('Escape');
    } else check(`${tag}: the add dialog opened on Walk Tale`, false);
  }
}

try {
  if (PHASES.includes('archive')) {
    for (const w of [390, 1280]) {
      console.log(`\n  archive @${w}`);
      await archive(w);
    }
  }
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
} catch (e) {
  check('the walk ran to the end', false, String(e?.stack || e));
}
check('no 5xx along the way', serverErrors.length === 0, serverErrors.slice(0, 5).join(' | '));
check('no console errors along the way', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));
await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ok, ${failed} failure(s)`);
process.exit(failed ? 1 : 0);
