// Screenshot rig. Drives a real browser against a running Uchiyomi and writes every image the README, the
// user guide, the CasaOS listing and the marketing site use.
//
// Screenshots used to be taken by hand, which is why they rotted: the whole set was captured 25 minutes
// before five features shipped and then described a product that no longer existed. Generating them means a
// stale screenshot is a command away from being fixed rather than an afternoon.
//
// Run it through run.sh -- it handles the throwaway login account and the WebP encode.
import { mkdir, writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';

const BASE = process.env.SHOT_BASE || 'http://uchiyomi:3000';
const OUT = process.env.SHOT_OUT || '/out';
const USER = process.env.SHOT_USER;
const PASS = process.env.SHOT_PASS;
const ONLY = (process.env.SHOT_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const SERIES_ID = process.env.SHOT_SERIES_ID || '';
// crop-related's series (run.sh: the one with the most related works); the shot series when none was picked.
const RELATED_ID = process.env.SHOT_RELATED_ID || SERIES_ID;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fixtures: made-up extensions and sources, and neutral names on a real library -------------------------------
// ⚠️ No screenshot may show a real extension, site, group or repository name (owner, v0.45.0): fixtures.mjs says
// how each kind of shot is kept neutral.
import {
  FIXTURE_REPO, FIXTURE_REPO_STORED, extensionFixture, sourcesFixture, fixturePage, neutralNames, meetNames,
  apiLogin, peopleFixture, librariesFixture, seedReading,
} from './fixtures.mjs';

// Viewports. `desk` matches the existing good assets and the app's own lg: breakpoint; phone is iPhone-14
// metrics. Everything renders at 2x/3x so the images stay sharp on a retina README.
const PROFILES = {
  desk: { width: 1366, height: 860, deviceScaleFactor: 2 },
  phone: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};

/**
 * Wait until the page has actually finished drawing.
 *
 * This is the difference between a good screenshot and the old series.jpg, which shipped for two months with
 * a blurred placeholder banner, an empty grey cover box and blank chapter thumbnails because it was captured
 * before the art arrived. Network idle alone is not enough -- images decode after they load.
 */
async function settle(page, extra = 0) {
  await page.waitForNetworkIdle({ idleTime: 700, timeout: 25000 }).catch(() => {});
  await page
    .waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0), { timeout: 20000 })
    .catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await sleep(500 + extra);
}

/**
 * Hold Home's hero still. It crossfades to its next slide every 6.5 s, over 0.9 s (web/components/HeroCarousel.tsx),
 * and a shot that lands inside the fade shows the last slide ghosting through the next -- phone-home did, on the
 * v0.60.1 re-shoot. The carousel pauses while the pointer is over it, so the pointer rests on an empty corner of it
 * (top end: the arrows sit at mid-height, the title and keys lower down), and a fade already under way gets to finish.
 */
async function heroAtRest(page) {
  const corner = await page.evaluate(() => {
    // `data-home-hero` (UI refresh) first; the Slide 1 dot's grandparent is how a server older than that is found.
    const hero = document.querySelector('[data-home-hero]')
      ?? document.querySelector('button[aria-label="Slide 1"]')?.parentElement?.parentElement;
    const r = hero?.getBoundingClientRect();
    return r && r.height > 0 ? { x: r.right - 24, y: r.top + 24 } : null;
  });
  if (!corner) return;
  await page.mouse.move(corner.x, corner.y);
  await sleep(1300);
}

/** Click a control by its visible text — the app has few stable test ids and this survives restyling. */
async function clickText(page, selector, text, { exact = true } = {}) {
  const handle = await page.evaluateHandle(
    (sel, t, ex) => [...document.querySelectorAll(sel)].find((el) => {
      const s = (el.textContent || '').trim();
      return ex ? s === t : s.includes(t);
    }),
    selector, text, exact,
  );
  const el = handle.asElement();
  if (!el) throw new Error(`no ${selector} with text ${JSON.stringify(text)}`);
  await el.click();
  return el;
}

async function shot(page, name, { clip = null, full = false } = {}) {
  const path = `${OUT}/${name}.png`;
  if (clip) await clip.screenshot({ path });
  else await page.screenshot({ path, fullPage: full });
  console.log(`  ✓ ${name}`);
}

/** Element handle for a card/panel, found by a heading it contains. Admin content is capped at ~768px wide,
 *  so full-viewport admin shots are mostly empty black — these are clipped to the panel instead. */
async function panel(page, headingText) {
  const h = await page.evaluateHandle((t) => {
    const el = [...document.querySelectorAll('h1,h2,h3,p,span')].find((e) => (e.textContent || '').trim() === t);
    return el ? el.closest('.card, section, div[class*="card"]') || el.parentElement : null;
  }, headingText);
  const el = h.asElement();
  if (!el) throw new Error(`no panel containing heading ${JSON.stringify(headingText)}`);
  return el;
}

async function login(page) {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector('input[type=password]', { timeout: 30000 });
  const inputs = await page.$$('input');
  await inputs[0].type(USER);
  await page.type('input[type=password]', PASS);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {}),
    page.click('button[type=submit]'),
  ]);
  await sleep(2500);
  const stillLogin = await page.$('input[type=password]');
  if (stillLogin) throw new Error('login failed — still on the login screen');
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const want = (n) => !ONLY.length || ONLY.includes(n);

  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb', '--hide-scrollbars'],
  });

  // ---- logged-out shots, in their own context so no session leaks in ----
  if (want('login') || want('login-sso') || want('crop-sso')) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport(PROFILES.desk);
    // Freeze the app's own entrance animations so nothing is caught mid-fade.
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);

    if (want('login')) {
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60000 });
      await settle(page, 600);
      await shot(page, 'login');
    }

    // SSO is not configured on this server, so the button cannot render on its own. The component and the
    // response shape are real (oidcEnabled() is a pure env check); only the two values are supplied.
    // Declared as a fixture in docs/SCREENSHOTS.md so nobody mistakes it for a mockup.
    if (want('login-sso') || want('crop-sso')) {
      const p2 = await ctx.newPage();
      await p2.setViewport(PROFILES.desk);
      await p2.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      await p2.setRequestInterception(true);
      p2.on('request', (req) => {
        if (req.url().includes('/auth/config')) {
          return req.respond({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ serverName: 'Uchiyomi', allowRegistration: false, oidc: { enabled: true, name: 'Authentik' } }),
          });
        }
        req.continue();
      });
      await p2.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60000 });
      await settle(p2, 600);
      if (want('login-sso')) await shot(p2, 'login-sso');
      if (want('crop-sso')) {
        const el = await p2.evaluateHandle(() => document.querySelector('a[href*="oidc"]')?.closest('form') || null);
        if (el.asElement()) await shot(p2, 'crop-sso', { clip: el.asElement() });
      }
      await p2.close();
    }
    await ctx.close();
  }

  // ---- everything else, one login reused for every shot ----
  // The account's id first (sample names for everyone else, fixtures.mjs peopleFixture), and its reading life when
  // run.sh asks for one (seedReading), before the first screen is drawn.
  const me = await apiLogin(BASE, USER, PASS);
  if (process.env.SHOT_SEED === '1') await seedReading(BASE, me.accessToken, SERIES_ID);
  const people = peopleFixture(me.user.id);
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport(PROFILES.desk);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  // A real library: its sources' and groups' names are shown as made-up ones (fixtures.mjs neutralNames) --
  // series.webp's supply line named a real site and its groups until v0.45.0 -- and its people as sample ones.
  await neutralNames(page, { fixtures: [people, librariesFixture()] });
  await login(page);
  console.log('  · signed in');
  await meetNames(page, BASE);
  // The admin's Health banner ("…checks found something · Take a look · Not now") is the live server's state, not a
  // feature of the screen being shot: answer it "Not now", as a person would. It is remembered in this browser context,
  // so the phone page below never shows it either (components/HealthAlert.tsx, lib/healthAlert.ts writeSeen).
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60000 });
  await settle(page, 300);
  const notNow = await page.$('[data-health-banner] button');
  if (notNow) { await notNow.click(); await sleep(400); console.log('  · Health banner: Not now'); }

  // ⚠️ The tab in front first. The phone shots open a second tab, and the one behind it paints no frames: a screenshot
  // still works there (it asks for a frame of its own), but puppeteer's element click and hover wait for an
  // IntersectionObserver, which never fires without frames -- series-more hung on its More key for the full 180 s
  // protocol timeout ("Runtime.callFunctionOn timed out") once phone-home had opened the phone's tab.
  const go = async (path, extra = 0) => {
    await page.bringToFront();
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await settle(page, extra);
  };
  /**
   * A crop for the marketing site's "What's new" cards, which show a 3:1 band (its styles.css .road-shot): the element
   * (from `selector`, or its `closest` container, down to `to`) whole, and the page around it filling the band out to
   * 3:1, downwards, rather than a sliver the band would blow up. Document coordinates, for page.screenshot's clip.
   */
  const bandAround = (selector, { to = null, closest = null, ratio = 3, pad = 16, padBottom = pad, grow = 'down' } = {}) => page.evaluate((selector, to, closest, ratio, pad, padBottom, grow) => {
    const pick = (sel) => [...document.querySelectorAll(sel)].find((e) => e.getBoundingClientRect().height > 0) || null;
    let a = pick(selector);
    if (a && closest) a = a.closest(closest) || a;
    const b = to ? pick(to) : a;
    if (!a || !b) return null;
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const left = Math.min(ra.left, rb.left) - pad, right = Math.max(ra.right, rb.right) + pad;
    const minH = (right - left) / ratio;
    let top = Math.min(ra.top, rb.top) - pad;
    let bottom = Math.max(ra.bottom, rb.bottom) + padBottom;
    // Out to the band's shape: downwards, or upwards when what lies below would be cut through.
    if (grow === 'up') top = Math.min(top, bottom - minH); else bottom = Math.max(bottom, top + minH);
    return { x: left + window.scrollX, y: Math.max(0, top + window.scrollY), width: right - left, height: bottom - top };
  }, selector, to, closest, ratio, pad, padBottom, grow);
  const bandShot = async (name, box) => {
    if (!box) { console.log(`  · skipped ${name} (nothing to crop)`); return; }
    await page.screenshot({ path: `${OUT}/${name}.png`, clip: box });
    console.log(`  ✓ ${name}`);
  };
  const adminTab = async (name) => {
    await go('/admin/', 300);
    await clickText(page, 'button', name);
    await settle(page, 700);
  };

  // The phone page, made on first use. phone-home is taken here, beside home and before the desktop reader below: the
  // reader shot opens a chapter, which moves its series to the front of Keep reading, and in the v0.60.1 re-shoot the
  // phone rail then led with the shot series' part-read chapter, whose thumbnail is the top of a strip that opens on a
  // white title card -- a blank card on the marketing site's phone. Taken first, both Home shots show the same rail.
  let phonePage = null;
  const phone = async () => {
    // In front whenever it is used: see `go` above.
    if (phonePage) { await phonePage.bringToFront(); return phonePage; }
    phonePage = await ctx.newPage();
    await neutralNames(phonePage, { fixtures: [people, librariesFixture()] });
    await phonePage.setViewport(PROFILES.phone);
    await phonePage.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await meetNames(phonePage, BASE);
    return phonePage;
  };

  if (want('home')) { await go('/', 900); await heroAtRest(page); await shot(page, 'home'); }
  if (want('phone-home')) {
    const ph = await phone();
    await ph.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60000 });
    await settle(ph, 900); await heroAtRest(ph); await shot(ph, 'phone-home');
    await ph.goto('about:blank');
  }
  /**
   * The Library's toolbar and its first row of covers, as a band for the site's "What's new" cards. The row is measured
   * from the tiles themselves: the grid's first child is a wrapper around all of them, and a first run cropped the whole
   * shelf.
   */
  const firstRowBand = ({ captions = false, toolbar = true } = {}) => page.evaluate((captions, toolbar) => {
    const bar = [...document.querySelectorAll('[data-library-toolbar]')].find((e) => e.getBoundingClientRect().height > 0);
    const tiles = [...document.querySelectorAll('[data-library-grid] a[href*="/series/"]')]
      .map((a) => a.getBoundingClientRect()).filter((r) => r.height > 0);
    if (!bar || !tiles.length) return null;
    const top0 = Math.min(...tiles.map((r) => r.top));
    const row = tiles.filter((r) => r.top < top0 + 8);
    const a = bar.getBoundingClientRect();
    const left = (toolbar ? Math.min(a.left, ...row.map((r) => r.left)) : Math.min(...row.map((r) => r.left))) - 16;
    let right = (toolbar ? Math.max(a.right, ...row.map((r) => r.right)) : Math.max(...row.map((r) => r.right))) + 16;
    const top = (toolbar ? a.top : Math.min(...row.map((r) => r.top))) - 16;
    // `captions`: the lines under the covers too -- since v0.61.0 the Releasing soon order says *~Fri*, *Due* or
    // *Running late* there, the band's whole point. That band is cut at the first cover edge past 3:1, so the site's
    // 3:1 card trims a sliver off its sides rather than the captions off its bottom.
    // ...and never into the next row: its covers start about two lines under the captions.
    const below = tiles.filter((r) => r.top >= top0 + 8).map((r) => r.top);
    const bottom = Math.min(Math.max(...row.map((r) => r.bottom)) + (captions ? 52 : 16), below.length ? Math.min(...below) - 8 : Infinity);
    if (captions) {
      const edge = row.map((r) => r.right + 16).sort((x, y) => x - y).find((x) => x - left >= (bottom - top) * 3);
      if (edge) right = Math.min(right, edge);
    }
    return { x: left + window.scrollX, y: Math.max(0, top + window.scrollY), width: right - left, height: bottom - top };
  }, captions, toolbar);
  if (want('library') || want('crop-library')) {
    await go('/library/', 600);
    if (want('library')) await shot(page, 'library');
    // The toolbar and the first row of covers, with their progress bars (v0.60.0).
    if (want('crop-library')) await bandShot('crop-library', await firstRowBand());
  }
  // v0.61.0, the release radar: the Library in its Releasing soon order, each of the first covers saying when its next
  // chapter is likely. The URL's sort wins for this visit only; the account's saved order is left alone.
  // Narrowed to the series the capture account is part-way through: the soonest of ALL series are the ones running late,
  // and a first row of six *Running late* says the opposite of what the feature is for. The covers and their captions
  // only: the toolbar and the filter row above them made the band too tall for the site's 3:1 card.
  if (want('crop-radar')) {
    await go('/library/?sort=soon&read=IN_PROGRESS', 900);
    await bandShot('crop-radar', await firstRowBand({ captions: true, toolbar: false }));
  }
  // The series page since v0.60.0: Continue, the four keys and the ratings sit under the cover, and at 860 px tall the
  // keys fell just below the frame. The window is scrolled just far enough to show them, so the shot keeps the 16:10
  // the marketing site frames it in. Then More, opened: USAGE.md sends readers to "More → …" for a dozen things.
  if ((want('series') || want('series-more') || want('crop-ratings')) && SERIES_ID) {
    await go(`/series/?id=${SERIES_ID}`, 1200);
    const more = await page.evaluateHandle(() =>
      [...document.querySelectorAll('button[data-series-more]')].find((b) => b.getBoundingClientRect().height > 0) || null);
    const key = more.asElement();
    if (!key) throw new Error('series: no visible More key (button[data-series-more])');
    await page.evaluate((el) => {
      const r = el.getBoundingClientRect();
      if (r.bottom > window.innerHeight - 24) window.scrollBy({ top: r.bottom - window.innerHeight + 48, behavior: 'instant' });
    }, key);
    await settle(page, 400);
    if (want('series')) await shot(page, 'series');
    // The ratings panel (v0.60.0): AniList's score and readers beside the account's own stars.
    // Grown upwards: the supply line sits 12 px under the panel, and a band grown downwards cut it in half.
    if (want('crop-ratings')) await bandShot('crop-ratings', await bandAround('[data-ratings-panel]', { grow: 'up', padBottom: 6 }));
    if (want('series-more')) {
      await key.click();
      await page.waitForSelector('[role="menu"]', { timeout: 5000 });
      await sleep(700);
      await shot(page, 'series-more');
      await page.keyboard.press('Escape');
    }
  }
  // v0.61.0: a series page's Related row -- AniList's sequels, side stories and spin-offs -- on the series with the most
  // of them (RELATED_ID), its covers loaded (they come through the cover proxy, after the rest of the page), cut at the
  // first cover edge past 3:1 for the site's card.
  if (want('crop-related') && RELATED_ID) {
    await go(`/series/?id=${RELATED_ID}`, 1200);
    await page.evaluate(() => [...document.querySelectorAll('[data-related]')].find((e) => e.getBoundingClientRect().height > 0)
      ?.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await page.waitForFunction(() => {
      const root = [...document.querySelectorAll('[data-related]')].find((e) => e.getBoundingClientRect().height > 0);
      const imgs = root ? [...root.querySelectorAll('img')].filter((i) => i.getBoundingClientRect().left < innerWidth) : [];
      return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0);
    }, { timeout: 20000 }).catch(() => {});
    await sleep(900);
    await bandShot('crop-related', await page.evaluate(() => {
      const root = [...document.querySelectorAll('[data-related]')].find((e) => e.getBoundingClientRect().height > 0);
      if (!root) return null;
      const head = root.querySelector('h2, h3');
      const cards = [...root.querySelectorAll('img')].map((i) => i.closest('a, article, li, div[class*="w-"]') || i)
        .map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0 && r.right <= innerWidth);
      if (!cards.length) return null;
      // The titles and the relation (Sequel, Side story) sit under the covers, outside the link round each cover.
      const words = [...root.querySelectorAll('p, span')].map((e) => e.getBoundingClientRect())
        .filter((r) => r.height > 0 && r.right <= innerWidth && r.top >= Math.min(...cards.map((c) => c.bottom)) - 4);
      const rs = head ? [head.getBoundingClientRect(), ...cards] : cards;
      const top = Math.min(...rs.map((r) => r.top)) - 16;
      const bottom = Math.max(...cards.map((r) => r.bottom), ...words.map((r) => r.bottom)) + 16;
      const left = Math.max(0, Math.min(...rs.map((r) => r.left)) - 16);
      let right = Math.max(...cards.map((r) => r.right)) + 16;
      const edge = cards.map((r) => r.right + 16).sort((x, y) => x - y).find((x) => x - left >= (bottom - top) * 3);
      if (edge) right = Math.min(right, edge);
      return { x: left + window.scrollX, y: Math.max(0, top + window.scrollY), width: right - left, height: bottom - top };
    }));
  }
  if (want('wrapped')) { await go('/wrapped/', 1500); await shot(page, 'wrapped'); }

  // A desktop capture of the reader as well as the phone one: the marketing tour shows screens in a browser
  // frame, and a portrait phone shot letterboxed into that frame looks like a mistake.
  if ((want('reader') || want('crop-reader-comfort')) && process.env.SHOT_BOOK_ID) {
    await go(`/reader/?book=${process.env.SHOT_BOOK_ID}`, 1200);
    await page.evaluate((frac) => {
      const el = document.querySelector('[data-lenis-prevent]');
      if (el) el.scrollTop = Math.floor(el.scrollHeight * frac);
    }, Number(process.env.SHOT_READER_AT || 0.45));
    await sleep(1600);
    await page.mouse.click(683, 430);
    await sleep(900);
    if (want('reader')) await shot(page, 'reader');
    // v0.61.0, the reader comfort pack: its settings sheet from Wide pages down, the rows a phone reader looks for.
    // The rows are marked here and the band is cut round them (bandAround), widened to the sheet.
    if (want('crop-reader-comfort')) {
      if (!(await page.$('[data-reader-settings]'))) { await page.mouse.click(683, 430); await sleep(900); }
      await page.$eval('[data-reader-settings]', (b) => b.click()).catch(() => {});
      await page.waitForSelector('[role="dialog"][aria-label="Reader"]', { timeout: 5000 }).catch(() => {});
      await sleep(800);
      const marked = await page.evaluate(() => {
        const d = document.querySelector('[role="dialog"][aria-label="Reader"]');
        if (!d) return false;
        const width = d.getBoundingClientRect().width;
        const row = (t) => {
          let el = [...d.querySelectorAll('*')].find((x) => x.children.length === 0 && (x.textContent || '').trim() === t);
          while (el && el.parentElement && el.getBoundingClientRect().width < width * 0.8) el = el.parentElement;
          return el;
        };
        const a = row('Wide pages'), b = row('Crop page borders');
        if (!a || !b) return false;
        a.scrollIntoView({ block: 'start', behavior: 'instant' });
        a.setAttribute('data-shot-from', ''); b.setAttribute('data-shot-to', '');
        return true;
      });
      await sleep(500);
      await bandShot('crop-reader-comfort', marked ? await bandAround('[data-shot-from]', { to: '[data-shot-to]' }) : null);
      await page.keyboard.press('Escape');
    }
  }

  if (want('discover')) {
    // The WALL, not a search. Discover was rebuilt around what your sources just published -- the hero and the grid
    // (one card per work since v0.56.0) are the page now, and search is a field in the corner. This used to type
    // "solo leveling" and photograph the results, so every screenshot in the docs and on the marketing site
    // illustrated the one thing the page had stopped leading with.
    await go('/discover/', 600);
    // Sources are fetched independently and land as they answer, so wait for the wall rather than a timer.
    await page.waitForFunction(
      () => document.querySelectorAll('a[href*="/series/"], button img').length > 12,
      { timeout: 30000 },
    ).catch(() => {});
    await sleep(2500);
    await settle(page);
    await shot(page, 'discover');
  }

  // Admin tabs. The content column is capped around 768px inside a 1366px viewport, so a plain full-viewport
  // shot is mostly empty black (which is exactly what the old admin screenshots look like) while a full-column
  // clip comes out absurdly tall. Scrolling the panel of interest into view and taking a normal viewport frame
  // gives a consistent 16:10 image that still shows the app around it.
  const focus = async (headingText) => {
    if (!headingText) return;
    await page.evaluate((t) => {
      const el = [...document.querySelectorAll('h1,h2,h3,p,span')]
        .find((e) => (e.textContent || '').trim().toLowerCase() === t.toLowerCase());
      (el?.closest('.card') || el)?.scrollIntoView({ block: 'center', behavior: 'instant' });
    }, headingText);
    await sleep(500);
  };
  const adminShot = async (name, headingText) => { await focus(headingText); await sleep(700); await shot(page, name); };

  if (want('admin-health')) {
    await adminTab('Health');
    // Leave the checks collapsed: the summary rows with their status pills ARE the feature, and expanding one
    // pushes them off-centre behind a long list of individual chapters.
    await page.evaluate(() => document.querySelector('main')?.scrollTo({ top: 0, behavior: 'instant' }));
    await settle(page, 1400);
    await shot(page, 'admin-health');
  }
  // Health's header row, with Fix everything (v0.55.0), and the first cards under it.
  if (want('crop-fix-everything')) {
    await adminTab('Health');
    await settle(page, 1000);
    await bandShot('crop-fix-everything', await bandAround('[data-fix-everything]', { closest: '.full' }));
  }
  // admin-extensions, admin-providers and the extension crops are taken on a fixture page: see "fixture shots".
  // Libraries sit at the top of the Library tab, above the removed-series list. v0.8.0 added the section
  // and nothing pictured it.
  if (want('admin-libraries')) { await adminTab('Library'); await adminShot('admin-libraries', 'Libraries'); }
  if (want('admin-members')) { await adminTab('Members'); await adminShot('admin-members'); }
  // By address rather than by tab button: `?tab=` is the tab's URL since v0.39.0, and the shot doubles as a
  // check that the deep link opens the rebuilt Settings tab (Server first, then the other three sections).
  if (want('admin-settings')) { await go('/admin/?tab=Settings', 1000); await adminShot('admin-settings'); }
  // The reviewable import (v0.35.0) is its own route, reached from Admin → Sources' Add sources. Its intake card is
  // the shot: what the docs describe first, and the one state a capture-only account can always reach (a
  // batch in review needs titles this instance's sources answer for).
  if (want('admin-import')) { await go('/admin/import/', 600); await shot(page, 'admin-import'); }

  if (want('profile-stats')) { await go('/profile/', 900); await shot(page, 'profile-stats'); }
  if (want('profile-security')) {
    // The Account tab of v0.39.0: Signed in as, Two-factor authentication, Active sessions, Sign out. There
    // is no "Security" heading any more; the 2FA section is the one that reads as security in a picture.
    await go('/profile/?tab=Account', 600);
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('h2,h3')].find((e) => /two-factor/i.test(e.textContent || ''));
      el?.scrollIntoView({ block: 'start', behavior: 'instant' });
    });
    await settle(page, 700);
    await shot(page, 'profile-security');
  }

  // ---- close-up crops ----
  // Used as section artwork on the marketing site in place of hand-drawn line icons. Clipped to the card so
  // they stay legible when they're only ~300px wide on the page.
  const cropCard = async (name, headingText) => {
    if (!want(name)) return;
    const h = await page.evaluateHandle((t) => {
      const el = [...document.querySelectorAll('h1,h2,h3,p,span')]
        .find((e) => (e.textContent || '').trim().toLowerCase().startsWith(t.toLowerCase()));
      const card = el?.closest('.card');
      card?.scrollIntoView({ block: 'center', behavior: 'instant' });
      return card || null;
    }, headingText);
    const el = h.asElement();
    if (!el) { console.log(`  · skipped ${name} (no card for ${JSON.stringify(headingText)})`); return; }
    await sleep(700);
    await shot(page, name, { clip: el });
  };

  if (want('crop-anilist') || want('crop-tokens')) {
    // Both live on the Connections tab since v0.39.0 (trackers, OPDS readers, API tokens); `.card` is kept
    // by the Section primitive, so `cropCard` still finds the section around the heading.
    await go('/profile/?tab=Connections', 900);
    await cropCard('crop-anilist', 'Sync your reading to AniList');
    await cropCard('crop-tokens', 'API tokens');
  }
  if (want('crop-health')) { await adminTab('Health'); await cropCard('crop-health', 'Suspiciously short chapters'); }
  // ---- fixture shots (see "fixtures" at the top: invented extensions and sources, never the real ones) ----
  const cropOn = async (p, name, headingText) => {
    if (!want(name)) return;
    const h = await p.evaluateHandle((t) => {
      const el = [...document.querySelectorAll('h1,h2,h3,p,span')]
        .find((e) => (e.textContent || '').trim().toLowerCase().startsWith(t.toLowerCase()));
      const card = el?.closest('.card');
      card?.scrollIntoView({ block: 'center', behavior: 'instant' });
      return card || null;
    }, headingText);
    const el = h.asElement();
    if (!el) throw new Error(`${name}: no card for ${JSON.stringify(headingText)}`);
    await sleep(700);
    await shot(p, name, { clip: el });
  };
  const tabOn = async (p, tab) => {
    await p.goto(`${BASE}/admin/?tab=${tab}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await settle(p, 700);
  };
  /** From the top of `from` to the bottom of `to` (the same element by default), in document coordinates. */
  const clipOf = (p, from, to = from, pad = 12) => p.evaluate((from, to, pad) => {
    const a = document.querySelector(from), b = document.querySelector(to);
    if (!a || !b) return null;
    a.scrollIntoView({ block: 'start', behavior: 'instant' });
    window.scrollBy(0, -100);
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const left = Math.min(ra.left, rb.left), right = Math.max(ra.right, rb.right);
    return { x: left - pad + window.scrollX, y: ra.top - pad + window.scrollY, width: right - left + 2 * pad, height: rb.bottom - ra.top + 2 * pad };
  }, from, to, pad);
  // Admin → Sources (v0.54.0) reads every source from one answer, the overview: always the fixture's here, with the
  // extensions' state, so no real source name reaches a shot of the tab.
  const sourcesPage = (profile, state) => fixturePage(ctx, profile, [sourcesFixture(state), extensionFixture(state)]);
  const focusOn = async (p, headingText) => {
    await p.evaluate((t) => {
      const el = [...document.querySelectorAll('h1,h2,h3,p,span')]
        .find((e) => (e.textContent || '').trim().toLowerCase() === t.toLowerCase());
      (el?.closest('.card') || el)?.scrollIntoView({ block: 'center', behavior: 'instant' });
    }, headingText);
    await sleep(900);
  };

  // A first visit: no repository yet, so Browse is the first-run card with its address field (v0.53.0), typed in;
  // then the add, and Browse lists the repository's catalogue. Unlike the old shots, these fail loudly: a missing
  // field or list is a thrown error, not a silently absent file.
  /** From Browse's search row to the end of its `rows`-th extension, in document coordinates. */
  const browseTop = (p, rows) => p.evaluate((rows) => {
    const search = document.querySelector('[data-ext-search]')?.closest('div.flex');
    const items = [...document.querySelectorAll('[data-ext-list] > li')];
    if (!search || items.length < rows) return null;
    search.scrollIntoView({ block: 'start', behavior: 'instant' });
    window.scrollBy(0, -100);
    const a = search.getBoundingClientRect(), b = items[rows - 1].getBoundingClientRect();
    return { x: a.left - 10 + window.scrollX, y: a.top - 10 + window.scrollY, width: a.width + 20, height: b.bottom - a.top + 20 };
  }, rows);
  if (want('crop-repo-empty') || want('crop-repo-added')) {
    const state = { repos: [] };
    const xp = await sourcesPage(PROFILES.desk, state);
    await tabOn(xp, 'Sources&view=add');
    const input = await xp.waitForSelector('[data-ext-first-run] input[placeholder="https://…/index.min.json"]', { timeout: 15000 });
    await input.type(FIXTURE_REPO);
    await sleep(400);
    await cropOn(xp, 'crop-repo-empty', 'Add an extension repository');
    // The first-run card's Add: Add sources' "Add a site by address" has an Add of its own above it (v0.54.0).
    await clickText(xp, '[data-ext-first-run] button', 'Add');
    await xp.waitForFunction(() => document.body.innerText.includes('Checking the repository'), { timeout: 5000 });
    await xp.waitForFunction(() => document.body.innerText.includes('extensions from this repository'), { timeout: 15000 });
    await settle(xp, 200);
    if (want('crop-repo-added')) {
      // Browse after the add: the search, the filters, the count and the first extensions with their Install keys.
      await xp.waitForSelector('[data-ext-list] > li', { timeout: 15000 });
      await settle(xp, 300);
      const box = await browseTop(xp, 5);
      if (!box) throw new Error('crop-repo-added: no catalogue after the add');
      await sleep(500);
      await xp.screenshot({ path: `${OUT}/crop-repo-added.png`, clip: box });
      console.log('  ✓ crop-repo-added');
    }
    await xp.close();
  }

  // The success notice the docs name as step 4 ("Added — {n} extensions from this repository"). Since v0.49.0 it
  // is a card at the bottom of the window -- bottom-right on a laptop -- for as long as it takes to read (about
  // 6 s here, lib/notices.ts noticeDuration), away from the row, so the crops above never show it: it is
  // photographed on its own, the moment the add answers.
  if (want('crop-repo-toast')) {
    const xp = await sourcesPage(PROFILES.desk, { repos: [] });
    await tabOn(xp, 'Sources&view=add');
    const input = await xp.waitForSelector('[data-ext-first-run] input[placeholder="https://…/index.min.json"]', { timeout: 15000 });
    await input.type(FIXTURE_REPO);
    await clickText(xp, '[data-ext-first-run] button', 'Add');
    // The card itself (components/Toast.tsx `data-notice`), not the capsule at the top it replaced: a selector
    // for that timed out, and every capture after it in the run was skipped.
    const toast = await xp.waitForFunction(
      () => [...document.querySelectorAll('[data-notices] [data-notice="success"]')].find((e) => /^Added — \d+ extensions? from this repository/.test((e.textContent || '').trim())),
      { timeout: 15000 },
    );
    await sleep(300);
    // Document coordinates, as a clip is measured: the notice is fixed to the window, and the page has scrolled to the
    // first-run card under Add sources' other ways in (v0.54.0) -- in window coordinates the crop took the page there.
    const box = await xp.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.max(0, r.left - 28) + window.scrollX, y: Math.max(0, r.top - 16) + window.scrollY, width: r.width + 56, height: r.height + 32 };
    }, toast);
    await xp.screenshot({ path: `${OUT}/crop-repo-toast.png`, clip: box });
    console.log('  ✓ crop-repo-toast');
    await xp.close();
  }

  // The same two moments at phone width, for the site's phone plates: the first-run card alone (and, after the
  // add, the top of Browse), at native scale -- a desktop crop in a 390px column is unreadable.
  if (want('phone-repo-empty') || want('phone-repo-added')) {
    const xp = await sourcesPage(PROFILES.phone, { repos: [] });
    await tabOn(xp, 'Sources&view=add');
    const input = await xp.waitForSelector('[data-ext-first-run] input[placeholder="https://…/index.min.json"]', { timeout: 15000 });
    await input.type(FIXTURE_REPO);
    // Out of the field, so it shows the address from its start: at 390 px the caret's end of it began "xample.org/…".
    await xp.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
    const box = await xp.evaluate(() => {
      const card = document.querySelector('[data-ext-first-run]');
      if (!card) return null;
      card.scrollIntoView({ block: 'start', behavior: 'instant' });
      window.scrollBy(0, -90);
      const r = card.getBoundingClientRect();
      return { x: r.left - 10 + window.scrollX, y: r.top - 10 + window.scrollY, width: r.width + 20, height: r.height + 20 };
    });
    if (!box) throw new Error('phone-repo-empty: no first-run card');
    await sleep(600);
    if (want('phone-repo-empty')) { await xp.screenshot({ path: `${OUT}/phone-repo-empty.png`, clip: box }); console.log('  ✓ phone-repo-empty'); }
    await clickText(xp, '[data-ext-first-run] button', 'Add');
    await xp.waitForFunction(() => document.body.innerText.includes('extensions from this repository'), { timeout: 15000 });
    // Let the notice go: on a phone it sits above the bottom nav, and a crop that reaches down would take it in.
    await xp.waitForFunction(() => !document.querySelector('[data-notices] [data-notice]'), { timeout: 15000 }).catch(() => {});
    await xp.waitForSelector('[data-ext-list] > li', { timeout: 15000 });
    await settle(xp, 300);
    const added = await browseTop(xp, 4);
    if (!added) throw new Error('phone-repo-added: no catalogue after the add');
    await sleep(600);
    if (want('phone-repo-added')) { await xp.screenshot({ path: `${OUT}/phone-repo-added.png`, clip: added }); console.log('  ✓ phone-repo-added'); }
    await xp.close();
  }

  // A later visit: one repository, three extensions installed and one out of date -- the engine's strip, Needs
  // attention with the update, and Your sources (v0.54.0; Installed in v0.53.0). The crop is Your sources alone,
  // from its row of views to its last row.
  const strips = want('ext-strip-1') || want('ext-strip-2') || want('ext-strip-3');
  if (want('admin-extensions') || want('crop-extensions') || strips) {
    const xp = await sourcesPage(PROFILES.desk, { repos: [FIXTURE_REPO_STORED] });
    await tabOn(xp, 'Sources');
    await xp.waitForFunction(() => document.body.innerText.includes('Example Manga (EN)'), { timeout: 15000 });
    await settle(xp, 300);
    if (want('admin-extensions')) { await focusOn(xp, 'Extension engine'); await shot(xp, 'admin-extensions'); }
    if (want('crop-extensions')) {
      const box = await clipOf(xp, '[role=tablist]:has([data-sources-view="yours"])', '[data-sources-yours]');
      if (!box) throw new Error('crop-extensions: no Your sources list');
      await sleep(500);
      await xp.screenshot({ path: `${OUT}/crop-extensions.png`, clip: box });
      console.log('  ✓ crop-extensions');
    }
    // Icon-only strips for the marketing site's extension wall.
    //
    // Deliberately NOT screenshots of the list, and since v0.45.0 not the real icons either: a site's icon is
    // its logo, and a third of the old strips spelled the site's name. They are the fixture's generated tiles.
    if (strips) {
      // Browse, every page of it (v0.53.0: the list is the page's, a page at a time, with Show more under it).
      await xp.goto(`${BASE}/admin/?tab=Sources&view=add`, { waitUntil: 'networkidle2', timeout: 60000 });
      await xp.waitForSelector('[data-ext-list] img', { timeout: 15000 });
      const icons = await xp.evaluate(async () => {
        for (let i = 0; i < 10 && document.querySelector('[data-ext-more]'); i++) {
          document.querySelector('[data-ext-more]').click();
          await new Promise((r) => setTimeout(r, 900));
        }
        const seen = new Set();
        document.querySelectorAll('[data-ext-list] img[src*="/img/extensions/icon/"]').forEach((im) => seen.add(im.getAttribute('src')));
        return [...seen].slice(0, 90);
      });
      console.log(`  · collected ${icons.length} extension icons`);
      if (icons.length < 12) throw new Error(`ext-strip: only ${icons.length} icons in the fixture list`);
      {
        // Pull each icon through the page that shows them as a data URL (the fixture answers the fetch): the
        // strip page is about:blank, and data URLs need neither the app's origin nor the network.
        const dataUrls = await xp.evaluate(async (srcs) => {
          const out = [];
          for (const src of srcs) {
            try {
              const r = await fetch(src, { credentials: 'include' });
              if (!r.ok) continue;
              const b = await r.blob();
              out.push(await new Promise((res) => { const f = new FileReader(); f.onload = () => res(f.result); f.readAsDataURL(b); }));
            } catch {}
          }
          return out;
        }, icons);
        console.log(`  · inlined ${dataUrls.length} icons`);

        const strip = await ctx.newPage();
        await strip.setViewport({ width: 2400, height: 128, deviceScaleFactor: 2 });
        const per = Math.ceil(dataUrls.length / 3);
        for (let i = 0; i < 3; i++) {
          const slice = dataUrls.slice(i * per, (i + 1) * per);
          if (!slice.length) break;
          await strip.setContent(`<html><body style="margin:0;background:#000;overflow:hidden">
            <div style="display:flex;gap:28px;align-items:center;height:128px;padding:0 20px">
              ${slice.map((d) => `<img src="${d}" width="72" height="72" style="border-radius:16px;flex:0 0 auto;object-fit:cover">`).join('')}
            </div></body></html>`, { waitUntil: 'load', timeout: 60000 });
          await settle(strip, 500);
          await shot(strip, `ext-strip-${i + 1}`);
        }
        await strip.close();
      }
    }
    await xp.close();
  }

  // The list at phone width for the site: the search row and the first extensions, at native scale.
  if (want('phone-extensions')) {
    const xp = await sourcesPage(PROFILES.phone, { repos: [FIXTURE_REPO_STORED] });
    await tabOn(xp, 'Sources&view=add');
    await xp.waitForSelector('[data-ext-list] > li', { timeout: 15000 });
    await settle(xp, 300);
    // Browse's search, filters and its first extensions: the installed three lead, then the catalogue by name.
    const box = await browseTop(xp, 5);
    if (!box) throw new Error('phone-extensions: no search row or extension rows');
    await sleep(600);
    await xp.screenshot({ path: `${OUT}/phone-extensions.png`, clip: box });
    console.log('  ✓ phone-extensions');
    await xp.close();
  }

  // Add sources (v0.54.0; Providers' "Add a site" until then): the ways in -- a site by address, MangaDex's languages,
  // the language of sites that do not say, Import a list, source packs -- over the extension catalogue.
  if (want('admin-providers') || want('crop-addsite')) {
    const pp = await sourcesPage(PROFILES.desk, { repos: [FIXTURE_REPO_STORED] });
    await tabOn(pp, 'Sources&view=add');
    await pp.waitForSelector('[data-sources-add-site]', { timeout: 15000 });
    await settle(pp, 300);
    if (want('admin-providers')) { await focusOn(pp, 'Add a site by address'); await shot(pp, 'admin-providers'); }
    if (want('crop-addsite')) {
      const box = await clipOf(pp, '[data-sources-add-site]');
      if (!box) throw new Error('crop-addsite: no Add a site by address');
      await sleep(500);
      await pp.screenshot({ path: `${OUT}/crop-addsite.png`, clip: box });
      console.log('  ✓ crop-addsite');
    }
    await pp.close();
  }
  if (want('phone-sources')) {
    // The site's small-screen stand-in for admin-providers: the first rows of Your sources at phone width -- a site
    // added by URL and the built-in MangaDex, each one line under its name.
    const ph2 = await sourcesPage(PROFILES.phone, { repos: [FIXTURE_REPO_STORED] });
    await tabOn(ph2, 'Sources');
    await ph2.waitForFunction(() => document.body.innerText.includes('Example Manga'), { timeout: 15000 });
    await settle(ph2, 300);
    const box = await clipOf(ph2, '[data-sources-list] > li:nth-child(1)', '[data-sources-list] > li:nth-child(3)', 8);
    if (!box) throw new Error('phone-sources: no rows in Your sources');
    await sleep(600);
    await ph2.screenshot({ path: `${OUT}/phone-sources.png`, clip: box });
    console.log('  ✓ phone-sources');
    await ph2.close();
  }
  // The small-screen stand-in for crop-addsite (/manga-server): the same card at phone width, its text the app's own
  // size. Hand-cut from the desktop shot until v0.60.1, a cut that stopped fitting the moment the layout moved.
  if (want('phone-providers')) {
    const ph3 = await sourcesPage(PROFILES.phone, { repos: [FIXTURE_REPO_STORED] });
    await tabOn(ph3, 'Sources&view=add');
    await ph3.waitForSelector('[data-sources-add-site]', { timeout: 15000 });
    await settle(ph3, 300);
    const box = await clipOf(ph3, '[data-sources-add-site]', '[data-sources-add-site]', 8);
    if (!box) throw new Error('phone-providers: no Add a site by address');
    await sleep(600);
    await ph3.screenshot({ path: `${OUT}/phone-providers.png`, clip: box });
    console.log('  ✓ phone-providers');
    await ph3.close();
  }

  // ---- phone ---- (phone-home is taken earlier, beside home)
  const ph = await phone();
  if (want('phone-library')) {
    await ph.goto(`${BASE}/library/`, { waitUntil: 'networkidle2', timeout: 60000 });
    await settle(ph, 900); await shot(ph, 'phone-library');
  }
  if (want('phone-downloads')) {
    await ph.goto(`${BASE}/downloads/`, { waitUntil: 'networkidle2', timeout: 60000 });
    await settle(ph, 600); await shot(ph, 'phone-downloads');
  }
  if (want('phone-reader') && process.env.SHOT_BOOK_ID) {
    await ph.goto(`${BASE}/reader/?book=${process.env.SHOT_BOOK_ID}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await settle(ph, 1200);
    // Scroll into the middle of the chapter. Two reasons: it should read as a chapter in progress rather
    // than a cover, and page one of a scanlated chapter is usually a credits page covered in another site's
    // branding -- not something to put on a marketing page. The reader scrolls an inner element, not the
    // window, so scrolling the window (as this first did) silently does nothing.
    await ph.evaluate((frac) => {
      const el = document.querySelector('[data-lenis-prevent]');
      if (el) el.scrollTop = Math.floor(el.scrollHeight * frac);
    }, Number(process.env.SHOT_READER_AT || 0.45));
    await sleep(1600);
    // ...then tap once to bring the chrome back: it auto-hides after 3.8s, and a reader screenshot with no
    // reader UI is exactly the mistake the previous one made for two months.
    await ph.mouse.click(PROFILES.phone.width / 2, PROFILES.phone.height / 2);
    await sleep(900);
    await shot(ph, 'phone-reader');
  }

  // The marketing site's phone plates for its admin figures (/faq's Settings, /vs's Libraries): the cards themselves at
  // phone width, so their text is the app's own size rather than a desktop shot shrunk to a fifth. Hand-cut from the
  // desktop shots until v0.60.1, cuts that stopped fitting the moment the layout moved.
  const phoneCard = async (name, path, mark) => {
    await ph.goto(`${BASE}${path}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await settle(ph, 700);
    const marked = await ph.evaluate(mark);
    const box = marked ? await clipOf(ph, '[data-shot-from]', '[data-shot-to]', 8) : null;
    if (!box) { console.log(`  · skipped ${name} (nothing to clip)`); return; }
    await sleep(600);
    await ph.screenshot({ path: `${OUT}/${name}.png`, clip: box });
    console.log(`  ✓ ${name}`);
  };
  if (want('phone-settings')) {
    await phoneCard('phone-settings', '/admin/?tab=Settings', () => {
      // By the section's id (components/settings.tsx Section): the admin menu's own "Server" group label comes first by
      // text, and it is in no card -- the first run of this capture found nothing to clip.
      const card = document.querySelector('section#server');
      card?.setAttribute('data-shot-from', ''); card?.setAttribute('data-shot-to', '');
      return !!card;
    });
  }
  if (want('phone-libraries')) {
    // The first two libraries (fixtures.mjs librariesFixture names them), one under the other at this width.
    await phoneCard('phone-libraries', '/admin/?tab=Library', () => {
      const cards = document.querySelectorAll('[data-library-card]');
      cards[0]?.setAttribute('data-shot-from', ''); cards[Math.min(1, cards.length - 1)]?.setAttribute('data-shot-to', '');
      return cards.length > 0;
    });
  }

  // ---- views for a before/after comparison (docs/SCREENSHOTS.md, "Before and after") ----
  // Taken only when named in --only, never in a full run, and never published: a wide screen, the narrowest desktop,
  // the sidebar opened under the pointer, and Arabic. Each puts the page back as it found it.
  const named = (n) => ONLY.includes(n);
  const view = async (pg, vp, path, extra = 900) => {
    await pg.bringToFront();
    await pg.setViewport(vp);
    await pg.goto(`${BASE}${path}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await settle(pg, extra);
  };
  const WIDE = { width: 1920, height: 1080, deviceScaleFactor: 1 };
  const NARROW = { width: 1024, height: 768, deviceScaleFactor: 2 };
  if (named('home-1920')) { await view(page, WIDE, '/'); await heroAtRest(page); await shot(page, 'home-1920'); }
  if (named('library-1920')) { await view(page, WIDE, '/library/', 600); await shot(page, 'library-1920'); }
  if (named('series-1920') && SERIES_ID) { await view(page, WIDE, `/series/?id=${SERIES_ID}`, 1200); await shot(page, 'series-1920'); }
  if (named('home-1024')) { await view(page, NARROW, '/'); await heroAtRest(page); await shot(page, 'home-1024'); }
  if (named('library-1024')) { await view(page, NARROW, '/library/', 600); await shot(page, 'library-1024'); }
  if (named('sidebar-open')) {
    // The pointer resting on the sidebar's Library item (components/Sidebar.tsx); on a build without the sidebar the
    // same spot is the page's own edge, and the picture is the page as it was.
    await view(page, PROFILES.desk, '/library/', 600);
    // The pointer to the item's centre, not ElementHandle.hover(): no scroll, no wait on an observer.
    const at = await page.evaluate(() => {
      const r = document.querySelector('[data-sidebar] a[data-nav="library"]')?.getBoundingClientRect();
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    });
    await page.mouse.move(at?.x ?? 30, at?.y ?? 150);
    await sleep(1000);
    await shot(page, 'sidebar-open');
    await page.mouse.move(700, 500);
  }
  if (named('home-ar') || named('phone-home-ar')) {
    for (const pg of [page, ph]) await pg.evaluate(() => localStorage.setItem('uchiyomi.lang', 'ar'));
    if (named('home-ar')) { await view(page, PROFILES.desk, '/'); await heroAtRest(page); await shot(page, 'home-ar'); }
    if (named('phone-home-ar')) {
      await ph.bringToFront();
      await ph.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60000 });
      await settle(ph, 900); await heroAtRest(ph); await shot(ph, 'phone-home-ar');
    }
    for (const pg of [page, ph]) await pg.evaluate(() => localStorage.removeItem('uchiyomi.lang'));
  }
  if (named('phone-series') && SERIES_ID) {
    await ph.bringToFront();
    await ph.goto(`${BASE}/series/?id=${SERIES_ID}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await settle(ph, 1200); await shot(ph, 'phone-series');
  }
  await page.setViewport(PROFILES.desk);

  await browser.close();
  await writeFile(`${OUT}/.captured`, new Date().toISOString());
  console.log('done.');
}

main().catch((e) => { console.error('CAPTURE FAILED:', e.message); process.exit(1); });
