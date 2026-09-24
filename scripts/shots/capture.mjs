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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fixtures: made-up extensions and sources, and neutral names on a real library -------------------------------
// ⚠️ No screenshot may show a real extension, site, group or repository name (owner, v0.45.0): fixtures.mjs says
// how each kind of shot is kept neutral.
import {
  FIXTURE_REPO, FIXTURE_REPO_STORED, extensionFixture, sourcesFixture, fixturePage, neutralNames, meetNames,
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
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport(PROFILES.desk);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  // A real library: its sources' and groups' names are shown as made-up ones (fixtures.mjs neutralNames) --
  // series.webp's supply line named a real site and its groups until v0.45.0.
  await neutralNames(page);
  await login(page);
  console.log('  · signed in');
  await meetNames(page, BASE);

  const go = async (path, extra = 0) => {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await settle(page, extra);
  };
  const adminTab = async (name) => {
    await go('/admin/', 300);
    await clickText(page, 'button', name);
    await settle(page, 700);
  };

  if (want('home')) { await go('/', 900); await shot(page, 'home'); }
  if (want('library')) { await go('/library/', 600); await shot(page, 'library'); }
  if (want('series') && SERIES_ID) { await go(`/series/?id=${SERIES_ID}`, 1200); await shot(page, 'series'); }
  if (want('wrapped')) { await go('/wrapped/', 1500); await shot(page, 'wrapped'); }

  // A desktop capture of the reader as well as the phone one: the marketing tour shows screens in a browser
  // frame, and a portrait phone shot letterboxed into that frame looks like a mistake.
  if (want('reader') && process.env.SHOT_BOOK_ID) {
    await go(`/reader/?book=${process.env.SHOT_BOOK_ID}`, 1200);
    await page.evaluate((frac) => {
      const el = document.querySelector('[data-lenis-prevent]');
      if (el) el.scrollTop = Math.floor(el.scrollHeight * frac);
    }, Number(process.env.SHOT_READER_AT || 0.45));
    await sleep(1600);
    await page.mouse.click(683, 430);
    await sleep(900);
    await shot(page, 'reader');
  }

  if (want('discover')) {
    // The WALL, not a search. Discover was rebuilt around what your sources just published -- the hero, the
    // language chips and the grid are the page now, and search is a field in the corner. This used to type
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
  // admin-extensions, admin-providers and the extension crops are taken on a fixture page: see "fixture shots".
  // Libraries sit at the top of the Library tab, above the removed-series list. v0.8.0 added the section
  // and nothing pictured it.
  if (want('admin-libraries')) { await adminTab('Library'); await adminShot('admin-libraries', 'Libraries'); }
  if (want('admin-members')) { await adminTab('Members'); await adminShot('admin-members'); }
  // By address rather than by tab button: `?tab=` is the tab's URL since v0.39.0, and the shot doubles as a
  // check that the deep link opens the rebuilt Settings tab (Server first, then the other three sections).
  if (want('admin-settings')) { await go('/admin/?tab=Settings', 1000); await adminShot('admin-settings'); }
  // The reviewable import (v0.35.0) is its own route, reached from the Providers card. Its intake card is
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
  if (want('crop-addsite')) { await adminTab('Providers'); await cropCard('crop-addsite', 'Add a site'); }
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
  const focusOn = async (p, headingText) => {
    await p.evaluate((t) => {
      const el = [...document.querySelectorAll('h1,h2,h3,p,span')]
        .find((e) => (e.textContent || '').trim().toLowerCase() === t.toLowerCase());
      (el?.closest('.card') || el)?.scrollIntoView({ block: 'center', behavior: 'instant' });
    }, headingText);
    await sleep(900);
  };

  // A first visit: no repository yet, so the row is open by itself with the address typed; then the add, with
  // the next-step line under the row. Unlike the old shots, these fail loudly: a missing input or line is a
  // thrown error, not a silently absent file.
  if (want('crop-repo-empty') || want('crop-repo-added')) {
    const state = { repos: [] };
    const xp = await fixturePage(ctx, PROFILES.desk, [extensionFixture(state)]);
    await tabOn(xp, 'Extensions');
    const input = await xp.waitForSelector('input[placeholder="https://…/index.min.json"]', { timeout: 15000 });
    await input.type(FIXTURE_REPO);
    await sleep(400);
    await cropOn(xp, 'crop-repo-empty', 'Extensions');
    await clickText(xp, 'button', 'Add');
    await xp.waitForFunction(() => document.body.innerText.includes('Checking the repository'), { timeout: 5000 });
    await xp.waitForFunction(() => document.body.innerText.includes('extensions from this repository'), { timeout: 15000 });
    await settle(xp, 200);
    if (want('crop-repo-added')) {
      // The repository row and the next-step line under it, not the whole card: the card is taller than the
      // viewport by now, and an element clip that runs under the fixed top bar photographs the bar.
      await xp.setViewport({ ...PROFILES.desk, height: 1400 });
      await sleep(500);
      const box = await xp.evaluate(() => {
        const next = [...document.querySelectorAll('p')].find((e) => (e.textContent || '').startsWith('Next: choose extensions'));
        const card = next?.closest('.card');
        if (!card) return null;
        card.scrollIntoView({ block: 'center', behavior: 'instant' });
        const c = card.getBoundingClientRect(), n = next.closest('[role=status]').getBoundingClientRect();
        return { x: c.left + window.scrollX, y: c.top + window.scrollY, width: c.width, height: n.bottom - c.top + 14 };
      });
      if (!box) throw new Error('crop-repo-added: no next-step line after the add');
      await sleep(500);
      await xp.screenshot({ path: `${OUT}/crop-repo-added.png`, clip: box });
      console.log('  ✓ crop-repo-added');
    }
    await xp.close();
  }

  // The success toast the docs name as step 4 ("Added — {n} extensions from this repository"). It lasts 3.2 s
  // and sits at the top of the window, away from the row, so the crops above never show it (they wait for it
  // to go): it is photographed on its own, the moment the add answers.
  if (want('crop-repo-toast')) {
    const xp = await fixturePage(ctx, PROFILES.desk, [extensionFixture({ repos: [] })]);
    await tabOn(xp, 'Extensions');
    const input = await xp.waitForSelector('input[placeholder="https://…/index.min.json"]', { timeout: 15000 });
    await input.type(FIXTURE_REPO);
    await clickText(xp, 'button', 'Add');
    const toast = await xp.waitForFunction(
      () => [...document.querySelectorAll('.fixed.inset-x-0.top-0 *')].find((e) => /^Added — \d+ extensions? from this repository/.test((e.textContent || '').trim()) && e.className && String(e.className).includes('rounded-full')),
      { timeout: 15000 },
    );
    await sleep(300);
    const box = await xp.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.max(0, r.left - 28), y: Math.max(0, r.top - 16), width: r.width + 56, height: r.height + 32 };
    }, toast);
    await xp.screenshot({ path: `${OUT}/crop-repo-toast.png`, clip: box });
    console.log('  ✓ crop-repo-toast');
    await xp.close();
  }

  // The same two moments at phone width, for the site's phone plates: the repository row alone (and, after the
  // add, the next-step line under it), at native scale -- a desktop crop in a 390px column is unreadable.
  if (want('phone-repo-empty') || want('phone-repo-added')) {
    const xp = await fixturePage(ctx, PROFILES.phone, [extensionFixture({ repos: [] })]);
    await tabOn(xp, 'Extensions');
    const input = await xp.waitForSelector('input[placeholder="https://…/index.min.json"]', { timeout: 15000 });
    await input.type(FIXTURE_REPO);
    // The repository row is the bordered box around the field; after the add, down to the next-step line.
    const rowBox = (withNext) => xp.evaluate((withNext) => {
      const row = document.querySelector('input[placeholder="https://…/index.min.json"]')?.closest('div.rounded-lg');
      if (!row) return null;
      row.scrollIntoView({ block: 'start', behavior: 'instant' });
      window.scrollBy(0, -90);
      const next = withNext ? [...document.querySelectorAll('[role=status]')].find((e) => (e.textContent || '').startsWith('Next: choose extensions')) : null;
      if (withNext && !next) return null;
      const r = row.getBoundingClientRect(), b = (next || row).getBoundingClientRect();
      return { x: r.left - 10 + window.scrollX, y: r.top - 10 + window.scrollY, width: r.width + 20, height: b.bottom - r.top + 20 };
    }, withNext);
    let box = await rowBox(false);
    if (!box) throw new Error('phone-repo-empty: no repository row');
    await sleep(600);
    if (want('phone-repo-empty')) { await xp.screenshot({ path: `${OUT}/phone-repo-empty.png`, clip: box }); console.log('  ✓ phone-repo-empty'); }
    await clickText(xp, 'button', 'Add');
    await xp.waitForFunction(() => document.body.innerText.includes('extensions from this repository'), { timeout: 15000 });
    // Let the toast go (3.2 s): it is fixed to the top of the viewport and would sit across the crop.
    await sleep(4200);
    box = await rowBox(true);
    if (!box) throw new Error('phone-repo-added: no next-step line after the add');
    await sleep(600);
    if (want('phone-repo-added')) { await xp.screenshot({ path: `${OUT}/phone-repo-added.png`, clip: box }); console.log('  ✓ phone-repo-added'); }
    await xp.close();
  }

  // The catalogue on a later visit: one repository (the row folded again), three extensions added, one out of date.
  if (want('admin-extensions') || want('crop-extensions') || want('ext-strip-1')) {
    const xp = await fixturePage(ctx, PROFILES.desk, [extensionFixture({ repos: [FIXTURE_REPO_STORED] })]);
    await tabOn(xp, 'Extensions');
    await xp.waitForFunction(() => document.body.innerText.includes('Example Manga (EN)'), { timeout: 15000 });
    await settle(xp, 300);
    if (want('admin-extensions')) { await focusOn(xp, 'Extensions'); await shot(xp, 'admin-extensions'); }
    await cropOn(xp, 'crop-extensions', 'Extensions');
    // Icon-only strips for the marketing site's extension wall.
    //
    // Deliberately NOT screenshots of the list, and since v0.45.0 not the real icons either: a site's icon is
    // its logo, and a third of the old strips spelled the site's name. They are the fixture's generated tiles.
    if (want('ext-strip-1')) {
      const icons = await xp.evaluate(async () => {
        const list = [...document.querySelectorAll('div')]
          .find((d) => d.className && String(d.className).includes('overflow-y-auto') && d.querySelector('img'));
        if (!list) return [];
        const seen = new Set();
        for (let i = 0; i < 40 && seen.size < 90; i++) {
          list.querySelectorAll('img[src*="/img/extensions/icon/"]').forEach((im) => seen.add(im.getAttribute('src')));
          list.scrollTop += list.clientHeight;
          await new Promise((r) => setTimeout(r, 220));
        }
        return [...seen];
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
    const xp = await fixturePage(ctx, PROFILES.phone, [extensionFixture({ repos: [FIXTURE_REPO_STORED] })]);
    await tabOn(xp, 'Extensions');
    await xp.waitForFunction(() => document.body.innerText.includes('Sample Webtoons'), { timeout: 15000 });
    await sleep(500);
    const box = await xp.evaluate(() => {
      const search = document.querySelector('input[placeholder^="Search extensions"]');
      const rows = [...document.querySelectorAll('p')].filter((e) => /^(Example Manga \(EN\)|Example Manga \(FR\))/.test((e.textContent || '').trim()));
      if (!search || rows.length < 2) return null;
      const top = search.closest('div').getBoundingClientRect();
      search.scrollIntoView({ block: 'start', behavior: 'instant' });
      window.scrollBy(0, -100);
      const a = search.closest('div').getBoundingClientRect(), b = rows[rows.length - 1].closest('div.rounded-lg').getBoundingClientRect();
      return top && { x: a.left - 10 + window.scrollX, y: a.top - 10 + window.scrollY, width: a.width + 20, height: b.bottom - a.top + 20 };
    });
    if (!box) throw new Error('phone-extensions: no search row or extension rows');
    await sleep(600);
    await xp.screenshot({ path: `${OUT}/phone-extensions.png`, clip: box });
    console.log('  ✓ phone-extensions');
    await xp.close();
  }

  if (want('admin-providers') || want('phone-sources')) {
    const pp = await fixturePage(ctx, PROFILES.desk, [sourcesFixture(), extensionFixture({ repos: [FIXTURE_REPO_STORED] })]);
    await tabOn(pp, 'Providers');
    await pp.waitForFunction(() => document.body.innerText.includes('Sample Comics'), { timeout: 15000 });
    await settle(pp, 300);
    if (want('admin-providers')) { await focusOn(pp, 'Add a site'); await shot(pp, 'admin-providers'); }
    await pp.close();
    if (want('phone-sources')) {
      // The site's small-screen stand-in for admin-providers: the first source cards at phone width.
      const ph2 = await fixturePage(ctx, PROFILES.phone, [sourcesFixture(), extensionFixture({ repos: [FIXTURE_REPO_STORED] })]);
      await tabOn(ph2, 'Providers');
      await ph2.waitForFunction(() => document.body.innerText.includes('Sample Comics'), { timeout: 15000 });
      await settle(ph2, 300);
      // Two cards, the built-in source and a site added by URL, as one clip.
      const box = await ph2.evaluate((names) => {
        const cards = names.map((n) => [...document.querySelectorAll('span')].find((e) => (e.textContent || '').trim().startsWith(n))?.closest('.card'));
        if (cards.some((c) => !c)) return null;
        cards[0].scrollIntoView({ block: 'start', behavior: 'instant' });
        window.scrollBy(0, -16);
        // Document coordinates: a screenshot clip is measured from the top of the page, not of the viewport.
        const r = cards.map((c) => c.getBoundingClientRect());
        const x = Math.min(...r.map((b) => b.left)) - 8 + window.scrollX, y = Math.min(...r.map((b) => b.top)) - 8 + window.scrollY;
        return { x, y, width: Math.max(...r.map((b) => b.right)) + window.scrollX - x + 8, height: Math.max(...r.map((b) => b.bottom)) + window.scrollY - y + 8 };
      }, ['MangaDex', 'Example Manga']);
      if (!box) throw new Error('phone-sources: the MangaDex and Example Manga cards were not found');
      await sleep(600);
      await ph2.screenshot({ path: `${OUT}/phone-sources.png`, clip: box });
      console.log('  ✓ phone-sources');
      await ph2.close();
    }
  }

  // ---- phone ----
  const ph = await ctx.newPage();
  await neutralNames(ph);
  await ph.setViewport(PROFILES.phone);
  await ph.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await meetNames(ph, BASE);
  if (want('phone-home')) {
    await ph.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60000 });
    await settle(ph, 900); await shot(ph, 'phone-home');
  }
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

  await browser.close();
  await writeFile(`${OUT}/.captured`, new Date().toISOString());
  console.log('done.');
}

main().catch((e) => { console.error('CAPTURE FAILED:', e.message); process.exit(1); });
