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

const BASE = process.env.SHOT_BASE || 'http://yomi-web';
const OUT = process.env.SHOT_OUT || '/out';
const USER = process.env.SHOT_USER;
const PASS = process.env.SHOT_PASS;
const ONLY = (process.env.SHOT_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const SERIES_ID = process.env.SHOT_SERIES_ID || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  await login(page);
  console.log('  · signed in');

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
    await go('/discover/', 600);
    const box = await page.$('input[placeholder*="Search"]');
    if (box) { await box.type('solo leveling'); await page.keyboard.press('Enter'); await sleep(9000); await settle(page); }
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
  if (want('admin-extensions') || want('crop-extensions') || want('ext-strip-1')) {
    await adminTab('Providers');
    const f = await page.$('input[placeholder*="Search extensions"]');
    if (f) { await f.type('manga'); await sleep(2500); await settle(page); }
    if (want('admin-extensions')) await adminShot('admin-extensions', 'Extensions');
  }
  if (want('admin-providers')) { await adminTab('Providers'); await adminShot('admin-providers', 'Add a site'); }
  if (want('admin-members')) { await adminTab('Members'); await adminShot('admin-members'); }
  if (want('admin-settings')) { await adminTab('Settings'); await adminShot('admin-settings'); }

  if (want('profile-stats')) { await go('/profile/', 900); await shot(page, 'profile-stats'); }
  if (want('profile-security')) {
    await go('/profile/', 600);
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('h2,h3')].find((e) => /security/i.test(e.textContent || ''));
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
    await go('/profile/', 900);
    await cropCard('crop-anilist', 'Sync your reading to AniList');
    await cropCard('crop-tokens', 'API tokens');
  }
  if (want('crop-health')) { await adminTab('Health'); await cropCard('crop-health', 'Suspiciously short chapters'); }
  if (want('crop-addsite') || want('crop-extensions') || want('ext-strip-1')) {
    await adminTab('Providers');
    await cropCard('crop-addsite', 'Add a site');
    const f = await page.$('input[placeholder*="Search extensions"]');
    if (f) { await f.type('scans'); await sleep(2500); await settle(page); }
    await cropCard('crop-extensions', 'Extensions');
    // Icon-only strips for the marketing site's extension wall.
    //
    // Deliberately NOT screenshots of the list: those are perfectly legible walls of third-party site names,
    // and Uchiyomi's whole stated position is that it ships no site names and hosts nothing. The icons carry
    // the visual just as well, so the wall is built from those alone. Adult extensions stay filtered out
    // (the panel hides them by default), and the icons come from our own proxy, not from anyone's CDN.
    if (want('ext-strip-1')) {
      const icons = await page.evaluate(async () => {
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
      if (icons.length >= 12) {
        // Pull each icon through the ALREADY-authenticated page as a data URL. The icon route is
        // cookie-authorised, and a second page cannot borrow that easily: about:blank has the wrong origin,
        // injecting into the app gets overwritten when React hydrates, and request interception makes Chrome
        // fail the image loads outright. Data URLs need neither auth nor network, so they just work.
        const dataUrls = await page.evaluate(async (srcs) => {
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
  }

  // ---- phone ----
  const ph = await ctx.newPage();
  await ph.setViewport(PROFILES.phone);
  await ph.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  if (want('phone-home')) {
    await ph.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60000 });
    await settle(ph, 900); await shot(ph, 'phone-home');
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
