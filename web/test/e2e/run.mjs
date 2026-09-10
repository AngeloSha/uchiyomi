// The web app, driven in a real browser, against a real server.
//
// This is the test that was missing. `web/test/` held one file of pure-function checks, and CI proved only
// that the app compiles -- so on 2026-08-23 an end-to-end pass found four user-facing bugs that were all
// invisible from the source and from a green suite of 326 server-side tests:
//
//   * the library, search and browse pages listed nothing
//   * downloading a chapter for offline reading had never worked
//   * two of the three OPDS feeds were a 500 for everyone
//   * every deep link on the documented default port redirected to a dead URL
//
// Each was a route wired to the wrong thing, which a test that imports the function and calls it cannot see.
// So this asserts the things a person would notice: pages render, the library lists what is in it, the
// reader decodes actual pixels, and the console is clean.
//
// It needs a running instance. `npm run test:e2e` brings one up from the all-in-one image; BASE=... points
// it at an existing one instead.
import puppeteer from 'puppeteer';
import { mkdirSync, writeFileSync } from 'fs';

const BASE = process.env.BASE || 'http://127.0.0.1:18140';
const USER = process.env.E2E_USER || 'e2e';
const PASS = process.env.E2E_PASS || 'e2e-passw0rd-123';
const OUT = process.env.OUT || 'test/e2e/shots';
const SEEDED = (process.env.E2E_SERIES || 'Mixed Formats').split(',').map((s) => s.trim()).filter(Boolean);

mkdirSync(OUT, { recursive: true });
const fails = [];
const consoleErrors = [];
const serverErrors = [];
// A cover proxied from a third-party CDN that answered the proxy with an error is not this app failing.
// /img/sources/cover fetches whatever URL a source or AniList gave it; when that upstream refuses or falls
// over -- which a GitHub runner's IP invites -- the route answers 5xx on purpose, so the browser's <img> can
// fall back to the direct URL. That is the documented design, and it turned a passing run (40/40) into a red
// badge on 2026-09-04 over one AniList cover. Noted, not counted; every other 5xx and console error still is.
const thirdPartyCover = (url) => /\/img\/sources\/cover\?[^ ]*\bu=https?%3A/i.test(url || '');
const thirdPartyNotes = [];
// True only while the browser is being held offline on purpose. Inside that window a request FAILING is the
// condition under test, not a defect -- see the note where it is set.
let networkCut = false;
const offlineNotes = [];
// Every request the browser could not complete, with its RESOURCE TYPE. Printed only when the run is
// already failing on console errors, so it costs nothing on a green run -- and on a red one it answers the
// question a bare `Failed to load resource` cannot: what KIND of request this was. A document, a route
// prefetch and an image miss read identically in the console and want completely different fixes.
const failedRequests = [];
let step = 0;

const ok = (what) => console.log(`    [ ok ] ${what}`);
const bad = (what) => { fails.push(what); console.log(`    [FAIL] ${what}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('console', (m) => {
    // A 401 on /auth/me before signing in is expected noise, not a fault.
    if (m.type() === 'error' && !/401|auth\/me/.test(m.text())) {
      const res = m.location()?.url;
      if (thirdPartyCover(res)) thirdPartyNotes.push(`console @ ${page.url()}: ${res}`);
      // A resource that could not load WHILE THE NETWORK IS DELIBERATELY CUT is what this suite asked for.
      // Next prefetches the routes it can see links to, and with no network those prefetches fail; a
      // prefetch is an optimisation, so nothing the reader does depends on one. What the offline tests
      // actually assert -- that the chapter opens, that its pages decode out of IndexedDB, that neither the
      // sign-in page nor a raw RSC payload appears -- is checked directly a few lines below and is not
      // weakened by this. Narrow on purpose: only `Failed to load resource`, only inside the window, and
      // every one of them is still printed at the end.
      else if (networkCut && /Failed to load resource/.test(m.text())) offlineNotes.push(`${res || m.text()}`);
      else consoleErrors.push(`${page.url()} :: ${m.text()}${res ? ` :: ${res}` : ''}`);
    }
  });
  page.on('requestfailed', (r) => failedRequests.push(`${r.resourceType()} ${r.url()}`));
  page.on('response', (r) => {
    if (r.status() < 500) return;
    if (thirdPartyCover(r.url())) thirdPartyNotes.push(`${r.status()} ${r.url()}`);
    else serverErrors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });

  const shot = async (name) => page.screenshot({ path: `${OUT}/${String(++step).padStart(2, '0')}-${name}.png` });

  // ---------------------------------------------------------------- sign in
  console.log('\n  sign in');
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  // The form appears at hydration, after networkidle2. This only ever passed because shot() added enough
  // latency to lose the race; i18n.mjs, without a screenshot first, lost it deterministically.
  await page.waitForSelector('input[type=password]', { timeout: 30000 }).catch(() => {});
  await shot('login');
  const inputs = await page.$$('input');
  if (!inputs.length) bad('the login page has no form');
  else {
    await inputs[0].type(USER);
    await page.type('input[type=password]', PASS);
    await page.keyboard.press('Enter');
    await sleep(4000);
    (await page.$('input[type=password]')) ? bad('still on the login form after valid credentials') : ok('signed in');
  }

  /**
   * Put `p` back on a signed-in page if the session has gone, and say so.
   *
   * ⚠️ NOT PAPERING OVER A BUG -- MAKING ONE VISIBLE. This run drives several tabs that share one cookie
   * jar, and `/auth/refresh` rotates the refresh cookie, so two tabs refreshing at once can race. The app
   * handles the common case (see the "lost a rotation race" branch in bff/src/routes/auth.ts) and the run
   * has a whole block devoted to session behaviour; everywhere else, a dropped session is noise that lands
   * on whatever assertion happens to be next.
   *
   * And it lands SILENTLY, which is the real problem. A signed-out /library contains none of the seeded
   * series names either, so "the 18+ library is off the grid" passed on a page showing a login form. Every
   * caller below therefore checks this FIRST, so the assertion that follows is about what it claims to be.
   */
  const ensureSignedIn = async (p, where) => {
    if (!(await p.$('input[type=password]'))) return true;
    console.log(`    [ -- ] ${where}: the session was dropped (tabs racing on refresh) — signing back in`);
    const ins = await p.$$('input');
    if (!ins.length) { bad(`${where}: signed out and no login form to recover with`); return false; }
    await ins[0].type(USER);
    await p.type('input[type=password]', PASS);
    await p.keyboard.press('Enter');
    await sleep(4000);
    if (await p.$('input[type=password]')) { bad(`${where}: could not sign back in`); return false; }
    return true;
  };

  // ---------------------------------------------------------------- every screen
  for (const [name, path] of [['home', '/'], ['library', '/library'], ['search', '/search'],
                              ['collections', '/collections'], ['downloads', '/downloads'],
                              ['profile', '/profile'], ['admin', '/admin']]) {
    console.log(`\n  ${path}`);
    const before = consoleErrors.length;
    await page.goto(BASE + path, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    await sleep(2200);
    await shot(name);

    // The port check is here because losing it is exactly what the nginx redirect did, and it looks like
    // nothing until every bookmark in the house is dead.
    if (!page.url().startsWith(BASE)) bad(`${path} navigated away from ${BASE} (now ${page.url()}) -- a redirect dropped the port`);

    const text = await page.evaluate(() => document.body.innerText || '');
    if (/something went wrong|application error|unhandled/i.test(text)) bad(`${path} rendered an error state`);
    else if (text.trim().length < 40) bad(`${path} is effectively blank (${text.trim().length} chars)`);
    else ok(`${path} rendered`);

    if (consoleErrors.length > before) bad(`${path}: ${consoleErrors.length - before} console error(s)`);
  }

  // ---------------------------------------------------------------- the library actually lists things
  /** Sign in over plain HTTP and return an access token. Used by the setup-heavy cases below. */
  /**
   * An access token for these credentials, minted at most once every ten minutes.
   *
   * ⚠️ MEMOISED BECAUSE `/auth/login` IS RATE LIMITED TO TEN PER FIVE MINUTES PER IP (routes/auth.ts), AND
   * THIS SUITE WAS MAKING EXACTLY TEN. Measured on a clean run: the busiest five-minute window held 10
   * logins against a limit of 10, so the suite sat precisely on the boundary and any eleventh -- a retry, a
   * re-signin after a dropped session -- came back 429. That does not fail cleanly: sign-in stops working,
   * every later block reads as a broken feature, and which blocks fail depends on timing. Four of the five
   * calls here ask for the SAME admin account, so caching removes the problem rather than budgeting around
   * it, and leaves headroom for the member accounts and for recovery.
   *
   * Ten minutes, against a fifteen-minute ACCESS_TTL_SECONDS: comfortably fresh, and a whole run is about
   * eight minutes, so in practice the admin token is minted once.
   */
  const tokenCache = new Map();
  const login = async (u, p) => {
    const hit = tokenCache.get(`${u}\u0000${p}`);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.token;
    const r = await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: u, password: p }),
    });
    if (r.status === 429) {
      bad('/auth/login answered 429 — the run has exhausted its own login budget (10 per 5 minutes)');
      return null;
    }
    const token = r.ok ? (await r.json()).accessToken : null;
    if (token) tokenCache.set(`${u}\u0000${p}`, { at: Date.now(), token });
    return token;
  };

  console.log('\n  library contents');
  await page.goto(`${BASE}/library`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(3000);
  const shown = await page.evaluate((names) => {
    const t = document.body.innerText || '';
    return names.filter((n) => t.includes(n));
  }, SEEDED);
  shown.length === SEEDED.length
    ? ok(`lists all ${SEEDED.length} seeded series`)
    : bad(`only ${shown.length}/${SEEDED.length} seeded series listed — this is the regression that shipped in v0.8.0`);
  await shot('library-content');

  // ---------------------------------------------------------------- read something
  console.log('\n  series and reader');
  let seriesHref = null;
  const href = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a')].find((x) => /\/series\//.test(x.getAttribute('href') || ''));
    return a ? a.getAttribute('href') : null;
  });
  if (!href) bad('no series to open from the library grid');
  else {
    seriesHref = href;
    await page.goto(BASE + href, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(3000);
    await shot('series');
    ((await page.evaluate(() => (document.body.innerText || '').length)) > 60) ? ok('series page opened') : bad('series page is blank');

    await page.evaluate(() => {
      [...document.querySelectorAll('button,a')].find((b) => /start reading|continue/i.test(b.innerText || ''))?.click();
    });
    await sleep(6000);
    await shot('reader');
    const imgs = await page.evaluate(() =>
      [...document.querySelectorAll('img')].filter((i) => /\/img\//.test(i.src)).map((i) => i.naturalWidth));
    const decoded = imgs.filter((w) => w > 0);
    decoded.length
      ? ok(`reader decoded ${decoded.length}/${imgs.length} page(s)`)
      : bad(`no page image decoded (${imgs.length} candidates) — the reader shows nothing`);
  }

  // ------------------------------------------------- moments: save a page, find it again, jump back to it
  //
  // One check covering three things that only work together: the reader accepts `&page=N` as a deep link,
  // the bookmark write lands, and the panel thumbnail on /moments actually decodes. Before this the app
  // could save a page and then had nowhere to show it, so none of the three had ever been exercised.
  // The reader hides its own chrome 3.8s after it appears, so the header and footer -- the counter, the
  // bookmark, the chapter jump -- are simply absent from the DOM by the time a test gets there. A tap in the
  // middle of the page toggles them back, after the 260ms double-tap window has passed.
  const revealChrome = async () => {
    const vp = page.viewport();
    await page.mouse.click(Math.round(vp.width / 2), Math.round(vp.height / 2));
    await sleep(700);
  };

  console.log('\n  moments');
  let readerBook = null;
  {
    const bookId = new URL(page.url()).searchParams.get('book');
    readerBook = bookId;
    const counterAt = () => page.evaluate(() => {
      const m = (document.body.innerText || '').match(/\b(\d+)\s*\/\s*(\d+)\b/);
      return m ? Number(m[1]) : 0;
    });
    if (!bookId) bad('the reader did not put a book id in the URL, so the deep link cannot be tested');
    else {
      const WANT = 2;   // every seeded chapter has three pages, so this is neither the first nor the last
      await page.goto(`${BASE}/reader/?book=${encodeURIComponent(bookId)}&page=${WANT}`, { waitUntil: 'networkidle2', timeout: 60000 });
      await sleep(5000);
      await revealChrome();
      const landed = await counterAt();
      landed === WANT
        ? ok(`the reader honoured &page=${WANT}`)
        : bad(`&page=${WANT} landed on page ${landed} — a deep link to a saved page does not work`);

      const marked = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => /bookmark this page/i.test(x.getAttribute('aria-label') || ''));
        if (!b) return 'no bookmark button';
        b.click();
        return 'clicked';
      });
      if (marked !== 'clicked') bad(`could not bookmark the page: ${marked}`);
      await sleep(2500);

      await page.goto(`${BASE}/moments`, { waitUntil: 'networkidle2', timeout: 60000 });
      await sleep(5000);
      await shot('moments');
      const tiles = await page.evaluate(() =>
        [...document.querySelectorAll('a[href*="/reader"] img')].map((i) => ({ w: i.naturalWidth, href: i.closest('a').getAttribute('href') })));
      const live = tiles.filter((t) => t.w > 0);
      if (!tiles.length) bad('the page just bookmarked does not appear on /moments at all');
      else if (!live.length) bad(`/moments has ${tiles.length} tile(s) but none decoded — the panel thumbnails are broken`);
      else {
        ok(`/moments shows ${live.length}/${tiles.length} decoded panel(s)`);
        if (!/[?&]page=/.test(live[0].href)) bad(`a moment links to ${live[0].href} — with no page, it opens at the start of the chapter`);
        else {
          await page.goto(BASE + live[0].href, { waitUntil: 'networkidle2', timeout: 60000 });
          await sleep(5000);
          await revealChrome();
          const back = await counterAt();
          back === WANT
            ? ok(`tapping a moment reopens page ${WANT}`)
            : bad(`tapping a moment opened page ${back}, not the page ${WANT} that was saved`);
        }
      }
    }
  }

  // ------------------------------------------------------------------ hash the pages, before downloading
  //
  // ⚠️ ORDER MATTERS, AND THIS IS THE REALISTIC ORDER. Page hashing is a background job on the server; by
  // the time a reader downloads a chapter it has long since run. The suite used to download first, and a
  // downloaded chapter is read out of IndexedDB with whatever flags it carried AT DOWNLOAD TIME -- so the
  // "repeated pages" check below opened a stale record and saw nothing skipped, no matter what the server
  // knew. Hashing here is what makes that check about the feature instead of about ordering.
  //
  // The genuine limitation this exposes is worth stating: a chapter downloaded BEFORE its pages were hashed
  // keeps the flags it was saved with until it is downloaded again. Nothing backfills it.
  //
  // Over HTTP with its own token: /api/admin/* wants the bearer access token, which lives only in the app's
  // memory, and minting one from inside the page would rotate the refresh cookie out from under the session
  // every other block depends on.
  console.log('\n  page hashes');
  const hashTok = await login(USER, PASS);
  let hashed = false;
  if (!hashTok || !(await fetch(`${BASE}/api/admin/tasks/pagehash/run`, {
    method: 'POST', headers: { authorization: `Bearer ${hashTok}` },
  }).then((r) => r.ok).catch(() => false))) {
    bad('could not start the page-hash job');
  } else {
    // Poll rather than sleep a fixed time: on a slow runner the job takes longer than any guess.
    for (let i = 0; i < 40 && !hashed; i++) {
      await sleep(1500);
      const j = await fetch(`${BASE}/api/admin/tasks`, { headers: { authorization: `Bearer ${hashTok}` } })
        .then((r) => r.json()).catch(() => null);
      const c = (j?.content || []).find((x) => x.id === 'pagehash');
      hashed = !!c && !c.running && !!c.lastRun;
    }
    hashed ? ok('the page-hash job ran') : bad('the page-hash job did not finish');
  }

  // ------------------------------------------------- offline reading, with the server actually unreachable
  //
  // Two bugs shipped together here and both are invisible while the API answers. `chapterRefs` comes from
  // `/api/series/:id/books`; with the server unreachable that call fails, the list came back empty, and an
  // empty list was read as "you have reached the end" -- so EVERY downloaded chapter ended with "you
  // finished the series" and both chapter arrows were dead. The offline reader now takes its chapter list
  // from what is downloaded, and an unknown list is no longer a conclusion.
  //
  // ⚠️ THE API IS CUT, NOT THE NETWORK. `setOfflineMode(true)` also stops the browser fetching the page
  // DOCUMENT, and that fails for a reason that has nothing to do with this code: the service worker has no
  // handler for Next's `/reader/index.txt` RSC payload, so the client router's fetch dies, it falls back to
  // a browser navigation, and the tab ends up showing the raw payload as text. That is a real gap and it is
  // written up separately; simulating it here would only ever measure the service worker. Aborting `/api/*`
  // is exactly the condition the reader's offline path was written for.
  //
  // The chapter opened is the middle one, so prev AND next must both be live -- which is precisely what an
  // empty chapter list cannot produce.
  console.log('\n  offline reading');
  if (!seriesHref) console.log('    [ .. ] no series, skipping');
  else {
    await page.goto(BASE + seriesHref, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(2500);
    const started = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /download all/i.test(x.innerText || ''));
      if (!b) return false;
      b.click();
      return true;
    });
    if (!started) bad('the series page has no "Download all" button');
    else {
      await sleep(20000);   // three tiny seeded chapters; the button reads "Saving…" while it works
      await page.goto(`${BASE}/downloads`, { waitUntil: 'networkidle2', timeout: 60000 });
      await sleep(2500);
      const saved = await page.evaluate(() =>
        [...document.querySelectorAll('a[href*="/reader"]')].map((a) => a.getAttribute('href')));
      if (saved.length < 2) bad(`only ${saved.length} chapter(s) downloaded — cannot test the offline chapter list`);
      else {
        ok(`downloaded ${saved.length} chapters`);
        let cutApi = true;
        await page.setRequestInterception(true);
        const cut = (r) => {
          if (cutApi && new URL(r.url()).pathname.startsWith('/api/')) r.abort('internetdisconnected').catch(() => {});
          else r.continue().catch(() => {});
        };
        page.on('request', cut);
        try {
          await page.goto(BASE + saved[Math.floor(saved.length / 2)], { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
          await sleep(9000);
          await revealChrome();
          await shot('offline-reader');

          const seen = await page.evaluate(() => ({
            signedOut: !!document.querySelector('input[type=password]'),
            body: (document.body.innerText || '').slice(0, 400),
            // A downloaded page is decoded from a blob: URL held in memory. Counting ANY decoded <img>
            // would also count the sign-in logo -- and did, on an earlier version of this check that
            // passed while the screenshot showed a login form.
            blobs: [...document.querySelectorAll('img')].filter((i) => i.src.startsWith('blob:') && i.naturalWidth > 0).length,
            // Exactly the two chapter arrows: they are the only buttons in the reader that can be disabled,
            // which `disabled:opacity-30` identifies. Matching every round icon button would sweep in four
            // that are never disabled, and "not all disabled" would then be true whatever the arrows did.
            disabled: [...document.querySelectorAll('button')]
              .filter((b) => (b.className || '').includes('disabled:opacity-30'))
              .map((b) => b.disabled),
          }));

          if (seen.signedOut) bad('the app showed its sign-in page with the API down — a downloaded chapter was unreachable');
          else {
            seen.blobs > 0
              ? ok(`offline reader decoded ${seen.blobs} downloaded page(s) out of IndexedDB`)
              : bad('offline reader decoded no downloaded page — nothing came out of IndexedDB');

            // Reintroduce by deleting BOTH the listSeriesDownloads fallback AND the `chapterRefs.length`
            // guard. Neither alone turns this red, and it is worth being exact about why: with the
            // fallback in place chapterRefs holds three chapters, so the guard never runs; with the
            // fallback gone but the guard present, appending stops without claiming an ending. Only
            // together do they produce the trophy on a middle chapter. The fallback on its own is
            // covered by the arrows assertion below, which an empty chapter list cannot satisfy.
            /you finished|finished the series/i.test(seen.body)
              ? bad('offline reader claims the series is finished on a chapter that is not the last')
              : ok('offline reader does not claim the series is over');

            const arrows = seen.disabled;
            if (arrows.length < 2) bad(`found ${arrows.length} chapter arrow(s) in the offline reader, expected 2`);
            else if (arrows.every((d) => d === true)) bad('both chapter arrows are dead offline — the chapter list came back empty');
            else ok(`offline chapter navigation is live (${arrows.filter((d) => !d).length}/2 arrows enabled)`);
          }
        } finally {
          cutApi = false;
          page.off('request', cut);
          await page.setRequestInterception(false).catch(() => {});
        }
      }
    }
  }

  // ------------------------------------------------- and again with the whole network cut, not just the API
  //
  // The block above aborts /api/* so it measures the READER. This one cuts everything, which measures the
  // SERVICE WORKER as well, and it is the case a person actually hits: the app is open, the train goes into
  // a tunnel, they tap a chapter they downloaded.
  //
  // It used to fail outright. Next's client router fetches the route's RSC payload (`/reader/index.txt`, a
  // real static file in this export); sw.js had no rule for it, so the fetch died, Next fell back to a hard
  // navigation, and the tab showed the raw payload as text. Reintroduce by deleting the `.txt` branch from
  // sw.js and this goes back to that.
  //
  // A COLD BOOT offline is covered separately, in the block below this one.
  if (seriesHref) {
    console.log('\n  offline reading, whole network cut');
    await page.goto(`${BASE}/downloads`, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(2500);
    const saved = await page.evaluate(() =>
      [...document.querySelectorAll('a[href*="/reader"]')].map((a) => a.getAttribute('href')));
    if (saved.length < 2) console.log('    [ .. ] nothing downloaded, skipping');
    else {
      await page.setOfflineMode(true);
      networkCut = true;
      try {
        const tapped = await page.evaluate((h) => {
          const a = [...document.querySelectorAll('a')].find((x) => x.getAttribute('href') === h);
          if (!a) return false;
          a.click();
          return true;
        }, saved[Math.floor(saved.length / 2)]);
        if (!tapped) bad('could not tap a downloaded chapter');
        else {
          await sleep(9000);
          await revealChrome();
          await shot('offline-hard');
          const seen = await page.evaluate(() => ({
            path: location.pathname,
            signedOut: !!document.querySelector('input[type=password]'),
            raw: (document.body.innerText || '').startsWith('1:'),
            blobs: [...document.querySelectorAll('img')].filter((i) => i.src.startsWith('blob:') && i.naturalWidth > 0).length,
          }));
          if (seen.raw) bad('the tab is showing Next\'s raw RSC payload as text — sw.js has no rule for it');
          else if (seen.signedOut) bad('tapping a downloaded chapter with no network landed on the sign-in page');
          else if (!/\/reader/.test(seen.path)) bad(`tapping a downloaded chapter with no network landed on ${seen.path}`);
          else if (!seen.blobs) bad('the offline reader opened but decoded no downloaded page');
          else ok(`with the whole network cut, a downloaded chapter opens and decodes ${seen.blobs} page(s)`);
        }
      } finally {
        await page.setOfflineMode(false);
        networkCut = false;
      }
    }
  }

  // ------------------------------------------------------- a COLD BOOT with no network: the plane case
  //
  // Not "the app is open and the train enters a tunnel" (that is the block above) but "the app was closed,
  // the phone is in airplane mode, and you tap the icon". Everything here is a full `page.goto`, which is
  // what launching an installed PWA actually does.
  //
  // This used to be documented as impossible, and it was: `refreshSession` collapsed a 401 and a dead
  // network into the same `false`, so the app could not tell "signed out" from "on a plane"; and the user
  // id lived only in memory, so even past the sign-in screen every IndexedDB key would have been `anon:` and
  // missed.
  //
  // Reintroduce by removing BOTH identity restores -- the module-load seed in lib/api.ts AND the
  // `setCurrentUser(saved.id)` calls in lib/auth.tsx. ⚠️ They are redundant, so either ALONE still passes
  // here; that was measured, not assumed. With both gone this block fails on "the offline downloads screen
  // listed no chapters", which is the assertion that separates "the sign-in screen is gone" from "the app
  // actually found your downloads".
  //
  // The other two ways to break the feature are pinned in web/test/offlineIdentity.test.ts, which is cheaper
  // than a browser run: collapsing `rejected` and `unreachable` back into one value in refreshSession, and
  // moving the `anon` branch in AppShell.tsx back below the reader hatch.
  //
  // ⚠️ THESE ASSERTIONS GO VACUOUS EASILY, and one of them already did once. A blank page satisfies "no
  // password field", and the sign-in screen satisfies "an <img> decoded" -- its own logo. So each check
  // asserts in BOTH directions: something that only exists when it worked (a downloaded page decoded from a
  // blob: URL, a reader link in the list) AND the absence of the failure (input[type=password]).
  if (seriesHref) {
    console.log('\n  cold boot, no network');
    await page.setOfflineMode(true);
    networkCut = true;
    try {
      // 1. Launch the way the installed app does: the manifest's start_url.
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(6000);
      const home = await page.evaluate(() => ({
        signedOut: !!document.querySelector('input[type=password]'),
        path: location.pathname,
        readerLinks: document.querySelectorAll('a[href*="/reader"]').length,
      }));
      await shot('26-coldboot-downloads');
      if (home.signedOut) bad('a cold boot with no network showed the sign-in page');
      else if (!/\/downloads/.test(home.path)) bad(`a cold boot with no network landed on ${home.path}, not the downloads`);
      // The one that catches "past the login screen but the identity was never restored": the screen
      // renders, and lists nothing, because every offline key missed.
      else if (!home.readerLinks) bad('the offline downloads screen listed no chapters — the identity was not restored');
      else ok(`a cold boot with no network opens the downloads (${home.readerLinks} chapter(s) listed)`);

      // 2. Cold boot straight into the reader, which is what a shared link or a resumed tab does.
      const href = await page.evaluate(() =>
        (document.querySelector('a[href*="/reader"]') || {}).getAttribute?.('href') || null);
      if (href) {
        await page.goto(`${BASE}${href.replace(/^\//, '/')}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(9000);
        await revealChrome();
        await shot('27-coldboot-reader');
        const seen = await page.evaluate(() => ({
          signedOut: !!document.querySelector('input[type=password]'),
          raw: (document.body.innerText || '').startsWith('1:'),
          path: location.pathname,
          blobs: [...document.querySelectorAll('img')].filter((i) => i.src.startsWith('blob:') && i.naturalWidth > 0).length,
        }));
        if (seen.raw) bad('a cold boot into the reader showed Next\'s raw RSC payload as text');
        else if (seen.signedOut) bad('a cold boot into the reader with no network showed the sign-in page');
        else if (!/\/reader/.test(seen.path)) bad(`a cold boot into the reader landed on ${seen.path}`);
        else if (!seen.blobs) bad('the cold-booted reader opened but decoded no downloaded page');
        else ok(`a cold boot into the reader decodes ${seen.blobs} downloaded page(s)`);
      }

      // 3. Reconnecting revalidates: the offline chrome goes away without a reload.
      await page.setOfflineMode(false);
      networkCut = false;
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await sleep(5000);
      const back = await page.evaluate(() => document.body.innerText.includes('Offline —'));
      if (back) bad('the offline banner was still showing after the network came back');
      else ok('reconnecting clears the offline state');
    } finally {
      await page.setOfflineMode(false);
      networkCut = false;
    }
  }

  // ---------------------------------------------------------------- make a library, for real
  //
  // The reason this is here: creating a library was impossible from the UI for the whole life of the
  // feature. The API accepted any folder path; the panel only ever offered a list of suggestions computed
  // from the top level of the library root, which on a real install holds source names. Every server test
  // passed, because they all called the route directly. So this types a path in like a person would.
  console.log('\n  libraries');
  // `scope` restricts the search to the open dialog. Without it this reached for the first two text inputs
  // on the PAGE, which are the global search box in the top bar -- typing into that opens the command
  // palette over the dialog, and every assertion after it fails for a reason that has nothing to do with
  // what is being tested.
  const clickText = (text, scope = null) => page.evaluate((t, sel) => {
    const root = sel ? document.querySelector(sel) : document;
    if (!root) return false;
    const el = [...root.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === t);
    if (el) el.click();
    return !!el;
  }, text, scope);
  const DIALOG = '[role="dialog"]';

  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1500);
  (await clickText('Library')) ? ok('opened the Library tab') : bad('no Library tab in the admin panel');
  await sleep(1500);

  if (!(await clickText('New library'))) bad('no way to create a library');
  else {
    await sleep(600);
    const boxes = await page.$$(`${DIALOG} input[type=text], ${DIALOG} input:not([type])`);
    if (boxes.length < 2) bad(`the new-library dialog has ${boxes.length} text field(s) — the folder box is the point of it`);
    else {
      await boxes[0].type('E2E Shelf');
      await boxes[1].type('Test Source');
      await sleep(1200);   // debounced preview
      const dlg = await page.evaluate(() => document.body.innerText || '');
      /series would move/.test(dlg)
        ? ok('a typed path is previewed before committing')
        : bad('typing a folder produced no preview — the count is the only thing shown before committing');
      await shot('admin-new-library');

      (await clickText('Create', DIALOG)) || bad('no Create button');
      await sleep(2500);
      const after = await page.evaluate(() => document.body.innerText || '');
      /E2E Shelf/.test(after) && /Test Source/.test(after)
        ? ok('created a library from a typed path')
        : bad('the library was not created from a typed path — this is the bug the whole rework is about');
      await shot('admin-libraries');

      // Access, from the library's own row.
      (await clickText('Access')) || bad('no Access control on a library row');
      await sleep(900);
      /Who can open/.test(await page.evaluate(() => document.body.innerText || ''))
        ? ok('access opens from the library side')
        : bad('the Access dialog did not open');
      (await clickText('Cancel', DIALOG)) || (await page.keyboard.press('Escape'));
      await sleep(600);

      // And undo it, so the run leaves nothing behind.
      (await clickText('Remove')) || bad('no Remove on a library row');
      await sleep(700);
      (await clickText('Remove library', DIALOG)) || bad('the remove confirmation did not appear');
      await sleep(2500);
      /E2E Shelf/.test(await page.evaluate(() => document.body.innerText || ''))
        ? bad('the library survived being removed')
        : ok('removed it again');
    }
  }

  // ---------------------------------------------------------------- phone
  console.log('\n  phone 390x844');
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  // The reader is measured here and nowhere else: layout.mjs cannot reach it, because its PAGES are static
  // paths and the reader needs a book id. Its header gained a chapter button that used to be desktop-only,
  // which is exactly the kind of change that pushes a 390px header sideways.
  const phonePages = [['home', '/'], ['library', '/library'], ['moments', '/moments']];
  if (readerBook) phonePages.push(['reader', `/reader/?book=${encodeURIComponent(readerBook)}`]);
  for (const [name, path] of phonePages) {
    await page.goto(BASE + path, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    await sleep(name === 'reader' ? 5000 : 2000);
    await shot(`phone-${name}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    overflow > 4 ? bad(`phone ${path}: ${overflow}px of horizontal overflow`) : ok(`phone ${path}: no overflow`);
  }

  // The chapter list used to be a `<select className="hidden lg:block">`, so on a phone there was no way to
  // move through a series except one chapter at a time. Reintroduce that class and this fails.
  if (readerBook) {
    await revealChrome();
    const jump = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /chapters/i.test(x.getAttribute('aria-label') || ''));
      if (!b) return 'missing';
      if (!b.getBoundingClientRect().width) return 'hidden';
      b.click();
      return 'opened';
    });
    if (jump !== 'opened') bad(`phone reader: the chapter jump is ${jump} — a phone can only move one chapter at a time`);
    else {
      await sleep(800);
      const rows = await page.evaluate(() => document.querySelectorAll('[role=dialog] button').length);
      rows > 1 ? ok(`phone reader: the chapter sheet opened with ${rows} rows`) : bad('phone reader: the chapter sheet opened empty');
      await page.keyboard.press('Escape');
    }
  }

  // ------------------------------------------------- the library's filters, on a phone and on a laptop
  //
  // The library used to carry three horizontally-scrolling chip rails in its header -- one of them seven
  // chips wide, mixing sorts with filters with a select mode -- and a hand-rolled copy of the Sheet
  // component that had no `role="dialog"` and no Escape handler. Both presentations of the one panel are
  // driven here, because the source scan in test/library.test.ts can only see that the right component is
  // imported, not that it opens.
  await page.goto(`${BASE}/library`, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  await sleep(2000);
  {
    const chip = await page.evaluateHandle(() =>
      [...document.querySelectorAll('button')].find((b) => /^Filters/.test(b.textContent || '')) || null);
    const el = chip.asElement();
    if (!el) bad('phone library: no Filters button');
    else {
      await el.click();
      await sleep(700);
      const opened = await page.evaluate(() => {
        const d = document.querySelector('[role=dialog]');
        if (!d) return null;
        return { modal: d.getAttribute('aria-modal'), text: (d.textContent || '').slice(0, 400) };
      });
      if (!opened) bad('phone library: the Filters button opened no dialog');
      else {
        opened.modal === 'true' ? ok('phone library: the filter sheet is a real dialog') : bad('phone library: the filter sheet is not aria-modal');
        // The sections are the whole point of the redesign: one labelled group each, not a chip pile.
        const missing = ['Sort by', 'Read state', 'Status', 'Genres'].filter((h) => !opened.text.includes(h));
        missing.length ? bad(`phone library: the filter sheet is missing ${missing.join(', ')}`)
                       : ok('phone library: the filter sheet is grouped into labelled sections');
        await shot('phone-library-filters');
        // ⚠️ The copy this replaced could not do this. Reintroduce the hand-rolled overlay and it fails.
        await page.keyboard.press('Escape');
        await sleep(500);
        const still = await page.evaluate(() => !!document.querySelector('[role=dialog]'));
        still ? bad('phone library: Escape did not close the filter sheet') : ok('phone library: Escape closes the filter sheet');
      }
    }
  }

  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${BASE}/library`, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  await sleep(2200);
  {
    // On a wide screen the panel is not behind a button at all.
    const side = await page.evaluate(() => {
      const a = document.querySelector('aside');
      if (!a) return null;
      const r = a.getBoundingClientRect();
      const grid = document.querySelector('[data-library-grid]');
      const g = grid && grid.getBoundingClientRect();
      return {
        w: Math.round(r.width), text: (a.textContent || '').slice(0, 300),
        gridLeft: g ? Math.round(g.left) : null, asideRight: Math.round(r.right),
        filtersChipVisible: [...document.querySelectorAll('button')]
          .some((b) => /^Filters/.test(b.textContent || '') && b.getBoundingClientRect().width > 0),
      };
    });
    if (!side || side.w < 100) bad('library @1440: no filter sidebar beside the grid');
    else {
      ok(`library @1440: a ${side.w}px filter sidebar`);
      side.gridLeft !== null && side.gridLeft >= side.asideRight
        ? ok('library @1440: the grid starts after the sidebar')
        : bad('library @1440: the grid overlaps the sidebar');
      // Two copies of the same panel on one screen would be the obvious way to get this wrong.
      side.filtersChipVisible ? bad('library @1440: the Filters button is still shown beside an open sidebar')
                              : ok('library @1440: no redundant Filters button');
      const missing = ['Sort by', 'Read state'].filter((h) => !side.text.includes(h));
      missing.length ? bad(`library @1440: the sidebar is missing ${missing.join(', ')}`)
                     : ok('library @1440: the sidebar carries its labelled sections');
    }

    // Picking a genre must actually filter, and say so in the url -- the panel is a pure component over the
    // url, so a click that does not navigate is a panel that has quietly stopped being wired to anything.
    const before = await page.evaluate(() => document.querySelectorAll('[data-library-grid] > *').length);
    const clicked = await page.evaluate(() => {
      const row = document.querySelector('aside [aria-pressed="false"]');
      if (!row) return false;
      row.click();
      return true;
    });
    if (!clicked) bad('library @1440: nothing selectable in the filter sidebar');
    else {
      await sleep(2500);
      const url = page.url();
      /genres=|read=|status=|lib=|sort=/.test(url)
        ? ok(`library @1440: picking a filter wrote it to the url (${url.split('?')[1] || ''})`)
        : bad(`library @1440: picking a filter changed nothing in the url (${url})`);
      const after = await page.evaluate(() => document.querySelectorAll('[data-library-grid] > *').length);
      console.log(`    [ -- ] grid went from ${before} to ${after} tiles`);
    }
  }
  await shot('library-filters-desktop');
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

  // ------------------------------------------------- what the install count shows before you consent
  //
  // The unit tests pin what the payload CONTAINS. This checks the part that makes it consent rather than a
  // policy document: that an admin is shown the literal object, in the page, without having to turn
  // anything on first. A privacy promise nobody is shown is not one.
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${BASE}/admin/`, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  await sleep(2500);
  if (await ensureSignedIn(page, 'the settings tab')) {
    await page.goto(`${BASE}/admin/`, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    await sleep(2500);
  }
  {
    const opened = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'Settings');
      if (!b) return false;
      b.click();
      return true;
    });
    if (!opened) bad('admin: no Settings tab');
    else {
      await sleep(2500);
      const seen = await page.evaluate(() => {
        const pre = document.querySelector('pre');
        const text = document.body.innerText || '';
        const sw = [...document.querySelectorAll('[role=switch]')].length;
        return { pre: pre ? (pre.textContent || '') : null, text: text.slice(0, 4000), switches: sw };
      });
      if (!seen.pre) bad('admin settings: the install count shows no payload — an admin is asked to consent to a description');
      else {
        // Exactly the documented fields, visible, before anything is switched on.
        const want = ['id', 'month', 'version', 'arch', 'layout', 'db'];
        const missing = want.filter((k) => !seen.pre.includes(`"${k}"`));
        missing.length
          ? bad(`admin settings: the shown payload is missing ${missing.join(', ')}`)
          : ok('admin settings: the exact payload is shown before consenting');
        // ⚠️ And nothing beyond them. A field added to the payload would appear here first.
        const extra = (seen.pre.match(/"([a-zA-Z]+)":/g) || []).map((m) => m.slice(1, -2)).filter((k) => !want.includes(k));
        extra.length
          ? bad(`admin settings: the payload shows fields nobody agreed to: ${extra.join(', ')}`)
          : ok('admin settings: and nothing beyond the documented fields');
        seen.pre.includes('POST http')
          ? ok('admin settings: it says where it would go')
          : bad('admin settings: the payload is shown without saying where it goes');
      }
      const promises = ['changes every month', 'No library', 'deletes the secret'];
      const said = promises.filter((t) => seen.text.includes(t));
      said.length === promises.length
        ? ok('admin settings: the three promises are on the page, not only in the docs')
        : bad(`admin settings: missing promise text (${promises.filter((t) => !said.includes(t)).join(' | ')})`);
      await shot('admin-install-count');
    }
  }
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

  // ---------------------------------------------------------------- the rails move
  //
  // Discover's rails were `hide-scrollbar … overflow-x-auto`: the bar was deleted, Lenis's smooth wheel
  // swallows a vertical wheel over a horizontal-only scroller, and there were no arrows — so on a desktop
  // mouse there was no way to move them at all. This needs trending to have loaded, which needs AniList, so
  // it reports rather than fails when the rail is not there.
  console.log('\n  discover rails');
  await page.goto(`${BASE}/discover/`, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  await sleep(3500);
  await shot('discover');
  const rail = await page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find(
      (d) => d.scrollWidth - d.clientWidth > 40 && getComputedStyle(d).overflowX === 'auto',
    );
    if (!el) return null;
    el.dataset.e2eRail = '1';
    return { hidden: getComputedStyle(el).scrollbarWidth === 'none', at: el.scrollLeft };
  });
  if (!rail) console.log('    [ -- ] no horizontal rail on Discover (nothing to browse on this instance)');
  else {
    rail.hidden ? bad('a Discover rail still hides its own scrollbar') : ok('the rail shows a scrollbar');
    const moved = await page.evaluate(async () => {
      const el = document.querySelector('[data-e2e-rail]');
      const before = Math.abs(el.scrollLeft);
      const next = [...document.querySelectorAll('button[aria-label]')]
        .filter((b) => !b.disabled && b.closest('div')?.querySelector('[data-e2e-rail]'));
      if (!next.length) return { arrows: 0, before, after: before };
      next[next.length - 1].click();
      await new Promise((r) => setTimeout(r, 900));
      return { arrows: next.length, before, after: Math.abs(el.scrollLeft) };
    });
    if (!moved.arrows) bad('the rail has no enabled arrow to click');
    else if (moved.after <= moved.before) bad(`clicking the rail arrow moved nothing (${moved.before} -> ${moved.after})`);
    else ok(`the arrow scrolls the rail (${moved.before} -> ${moved.after})`);
  }

  // ---------------------------------------------------------------- the unread badge counts unread
  //
  // `seriesDto` hardcoded `booksUnreadCount` to the TOTAL chapter count and the cards read it, so every
  // badge in the app showed the size of the series and never moved however much you had read. `enrichSeries`
  // had been computing the right number into `yomi.unread` the whole time.
  //
  // One chapter of three marked read must leave a badge of two -- in the API and on the tile.
  console.log('\n  unread badge');
  {
    const sid = seriesHref ? new URLSearchParams(seriesHref.split('?')[1] || '').get('id') : null;
    const tok = await login(USER, PASS);
    if (!sid || !tok) bad('cannot check the badge without a series and a session');
    else {
      const auth = { authorization: `Bearer ${tok}` };
      const books = await (await fetch(`${BASE}/api/series/${encodeURIComponent(sid)}/books?size=100`, { headers: auth })).json();
      const list = books.content ?? [];
      if (list.length < 2) bad(`the seeded series has ${list.length} chapter(s) — need at least two to tell a badge from a count`);
      else {
        await fetch(`${BASE}/api/books/${encodeURIComponent(list[0].id)}/progress`, {
          method: 'PUT', headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({ page: 1, completed: true, silent: true }),
        });
        const after = await (await fetch(`${BASE}/api/series/${encodeURIComponent(sid)}`, { headers: auth })).json();
        const want = list.length - 1;
        after.booksUnreadCount === want
          ? ok(`booksUnreadCount is ${want} of ${list.length}`)
          : bad(`booksUnreadCount is ${after.booksUnreadCount}, expected ${want} — the API is still reporting the total`);
        after.booksReadCount === 1
          ? ok('booksReadCount is 1')
          : bad(`booksReadCount is ${after.booksReadCount}, expected 1`);

        await page.goto(`${BASE}/library`, { waitUntil: 'networkidle2', timeout: 60000 });
        await sleep(3000);
        const badge = await page.evaluate((id) => {
          const tile = document.querySelector(`a[href*="id=${id}"]`);
          if (!tile) return 'no tile';
          const n = [...tile.querySelectorAll('span')].map((e) => (e.textContent || '').trim())
            .find((t) => /^\d+$/.test(t));
          return n ?? 'no badge';
        }, sid);
        String(badge) === String(want)
          ? ok(`the library tile shows ${badge}`)
          : bad(`the library tile badge reads ${JSON.stringify(badge)}, expected ${want}`);
      }
    }
  }

  // ---------------------------------------------------------------- clicking, not typing URLs
  //
  // Every check above navigates with page.goto, which is a fresh load with an empty react-query cache. A
  // person clicks the nav instead, and that carries the cache from one page to the next -- which is how
  // /discover/ shipped broken while every URL-driven test passed: it shared the query key `['trending']`
  // with the home page, was handed the home page's differently-shaped data, and threw on first render.
  console.log('\n  moving around by clicking');
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(3000);
  for (const href of ['/library', '/discover', '/collections', '/updates', '/', '/discover']) {
    const clicked = await page.evaluate((h) => {
      const links = [...document.querySelectorAll('a')];
      const a = links.find((x) => (x.getAttribute('href') || '').replace(/\/$/, '') === h.replace(/\/$/, ''));
      if (!a) return false;
      a.click();
      return true;
    }, href);
    if (!clicked) { console.log(`    [ -- ] no link to ${href} in this account's nav`); continue; }
    await sleep(4000);
    const t = await page.evaluate(() => document.body.innerText || '').catch(() => 'EVAL FAILED');
    /client-side exception|Application error/i.test(t)
      ? bad(`clicking through to ${href} crashed the app`)
      : ok(`${href} survives being clicked into`);
  }

  // ---------------------------------------------------------------- 18+ libraries stay off the shelf
  //
  // The whole chain, end to end: a session cookie set by the button, a query parameter added to every API
  // call, a predicate on the server, and a grid that actually changes. Marking the seeded library 18+ is
  // the cheapest way to get a real one, and it is put back afterwards.
  // ------------------------------------------------- skipping the pages that are not the story
  //
  // The seeder plants a series whose three chapters all open with the SAME credit page. Nothing else in the
  // library repeats, so exactly one page per chapter should be skipped.
  //
  // ⚠️ The hash job normally starts five minutes after boot, so this triggers it and waits. Without that
  // the assertions below would pass for the wrong reason -- nothing hashed means nothing flagged, which
  // looks identical to "the feature is off".
  //
  // Reintroduce by ANY of: dropping MIN_CHAPTERS to 2 (a story page that happens to repeat once gets
  // skipped), removing the blank-page guard in pageHash.ts, or pointing the page grid at the reading flow
  // instead of the full list (a skipped page vanishes from the chapter instead of being dimmed).
  {
    console.log('\n  repeated pages');
    // The job that produces the evidence ran further up, BEFORE anything was downloaded -- see the
    // "hash the pages" step. Without that ordering this check reads a stale IndexedDB record and proves
    // nothing, which is exactly how it failed while it was being written.
    // A fresh token: the hash step ran minutes ago and this block only needs read access.
    const tok = await login(USER, PASS);
    if (!hashed || !tok) console.log('    [ .. ] no page hashes, skipping');
    else {
      // Found through the library grid, the way the rest of this file does it -- the app's own DOM is the
      // only listing contract that is actually stable here.
      await page.goto(`${BASE}/library`, { waitUntil: 'networkidle2', timeout: 60000 });
      await sleep(3000);
      const sHref = await page.evaluate(() => {
        const a = [...document.querySelectorAll('a')]
          .find((x) => /\/series\//.test(x.getAttribute('href') || '') && /Repeated Pages/i.test(x.textContent || ''));
        return a ? a.getAttribute('href') : null;
      });
      if (!sHref) bad('could not find the seeded Repeated Pages series in the library');
      else {
        const sid = (sHref.match(/id=([^&]+)/) || [])[1];
        // Straight to a chapter URL resolved over HTTP. "Start reading" opens whatever the app considers
        // next, which is not necessarily a chapter of THIS series once the rest of the suite has read
        // things; this check needs a specific chapter it can reason about.
        const bj = await fetch(`${BASE}/api/series/${sid}/books?size=10&sort=metadata.numberSort,asc`, {
          headers: { authorization: `Bearer ${tok}` },
        }).then((r) => r.json()).catch(() => null);
        const book = bj?.content?.[0];
        if (!book) bad('the Repeated Pages series listed no chapters');
        else {
          // ⚠️ The API contract first, in its own right. The browser below can only see the flag through
          // whichever copy of the chapter it happens to read; this asserts what the server actually says,
          // and it asserts BOTH directions -- the credit page flagged, every story page not. A rule that
          // flagged everything would satisfy "something is junk" and hide the whole chapter.
          const pj = await fetch(`${BASE}/api/books/${book.id}/pages`, {
            headers: { authorization: `Bearer ${tok}` },
          }).then((r) => r.json()).catch(() => null);
          const junk = (pj || []).filter((x) => x.junk).map((x) => x.number);
          if (!Array.isArray(pj) || !pj.length) bad('the pages endpoint returned nothing for a seeded chapter');
          else if (junk.length !== 1 || junk[0] !== 1) {
            bad(`the API flagged pages [${junk}] — the credit page is page 1 and the other ${pj.length - 1} are story`);
          } else {
            ok(`the API flags only the repeated credit page (1 of ${pj.length})`);

            // ⚠️ Its own tab. The shared `page` has been driven through a dozen blocks by now and carries
            // the reader state they left behind -- per-series prefs, a resume position, a warm service
            // worker. This is about what a reader sees when they OPEN a chapter, so it gets a clean one.
            // Cookies are per browser context, so the new tab is already signed in.
            const tab = await browser.newPage();
            await tab.setViewport({ width: 1440, height: 900 });
            try {
              await tab.goto(`${BASE}/reader/?book=${book.id}`, { waitUntil: 'networkidle2', timeout: 60000 });
              await sleep(8000);
              const vp = tab.viewport();
              await tab.mouse.click(Math.round(vp.width / 2), Math.round(vp.height / 2));
              await sleep(900);
              // The notice is POSITIONAL now: the repeated page is still in the chapter, folded down to a
              // band of itself where it always was. So the assertions are about that element existing, being
              // thin, and the rest of the chapter still rendering -- three things a floating chip could
              // never prove, since it sat at a fixed place on the screen whatever the flow did.
              const seen = await tab.evaluate(() => {
                const el = [...document.querySelectorAll('[aria-label]')]
                  .find((x) => /show repeated page/i.test(x.getAttribute('aria-label') || ''));
                return {
                  strip: el ? el.getAttribute('aria-label') : null,
                  stripH: el ? Math.round(el.getBoundingClientRect().height) : null,
                  imgs: [...document.querySelectorAll('img')].filter((i) => i.naturalWidth > 0).length,
                };
              });
              if (!seen.strip) bad('a chapter with a repeated credit page collapsed nothing');
              else if (!(seen.stripH > 0 && seen.stripH < 120)) {
                // The literal product claim: it is a LINE you scroll past, not a page. This fails the moment
                // the collapsed height stops reaching the layout model.
                bad(`the collapsed page is ${seen.stripH}px tall — that is not a strip`);
              } else if (!seen.imgs) bad('the chapter collapsed a page and then rendered none of the rest');
              else {
                ok(`a repeated page is folded down in place (${seen.stripH}px, "${seen.strip}")`);

                // ⚠️ Tapping it must open the page WITHOUT also toggling the reader chrome: the scroll
                // container owns a tap gesture, and the strip has to stop that event or one tap does two
                // things. Untestable anywhere but a browser.
                await tab.evaluate(() => {
                  const el = [...document.querySelectorAll('[aria-label]')]
                    .find((x) => /show repeated page/i.test(x.getAttribute('aria-label') || ''));
                  el?.click();
                });
                await sleep(2500);
                const opened = await tab.evaluate(() => {
                  const img = [...document.querySelectorAll('img')].find((i) => /page 1$/i.test(i.alt || ''));
                  return { h: img ? Math.round(img.getBoundingClientRect().height) : 0, w: img?.naturalWidth ?? 0 };
                });
                opened.w > 0 && opened.h > 200
                  ? ok(`tapping it opens the real page in place (${opened.h}px)`)
                  : bad(`tapping the strip did not open the page (${opened.h}px, natural ${opened.w})`);

                // ⚠️ The correction, from the page grid. The automatic rule is arithmetic over repeated
                // images and it WILL be wrong sometimes, in both directions; this control is the entire
                // reason skipping is safe to leave on by default. A route test cannot see whether anything
                // in the app actually calls it -- and the first version of this feature shipped the route
                // with no caller at all, while the docs claimed the button existed.
                await tab.evaluate(() => {
                  const b = [...document.querySelectorAll('button')]
                    .find((x) => /jump to a page/i.test(x.getAttribute('aria-label') || ''));
                  b?.click();
                });
                await sleep(1500);
                const rescued = await tab.evaluate(() => {
                  const el = [...document.querySelectorAll('[role="button"]')]
                    .find((x) => /stop skipping page/i.test(x.getAttribute('aria-label') || ''));
                  if (!el) return null;
                  el.click();
                  return el.getAttribute('aria-label');
                });
                // ⚠️ THE DRIFT. A deep link names a page NUMBER; the reader needs an index into the flow.
                // Subtracting one is only right while the flow holds every page, so for as long as repeated
                // pages were removed, every saved Moment and every resume landed one page late for each page
                // removed before it -- silently, because landing a page on is indistinguishable from having
                // read that far. This fails against the version that filtered the flow.
                const deep = await browser.newPage();
                await deep.setViewport({ width: 1440, height: 900 });
                try {
                  await deep.goto(`${BASE}/reader/?book=${book.id}&page=3`, { waitUntil: 'networkidle2', timeout: 60000 });
                  await sleep(6000);
                  // A third tab on the same cookie jar; if the session lost a refresh race the reader is a
                  // login form, and the page counter below comes back null -- reported as "the page number
                  // drifted", which is a confident answer to the wrong question.
                  if (await ensureSignedIn(deep, 'the deep link')) {
                    await deep.goto(`${BASE}/reader/?book=${book.id}&page=3`, { waitUntil: 'networkidle2', timeout: 60000 });
                    await sleep(6000);
                  }
                  const dv = deep.viewport();
                  await deep.mouse.click(Math.round(dv.width / 2), Math.round(dv.height / 2));
                  await sleep(900);
                  const counter = await deep.evaluate(() => {
                    const b = [...document.querySelectorAll('button')]
                      .find((x) => /jump to a page/i.test(x.getAttribute('aria-label') || ''));
                    return b ? (b.textContent || '').trim() : null;
                  });
                  counter === '3/4'
                    ? ok('a deep link to page 3 opens page 3')
                    : bad(`a deep link to page 3 opened "${counter}" — the page number drifted`);
                } finally {
                  await deep.close().catch(() => {});
                }

                if (!rescued) bad('the page grid offers no way to un-skip a page the rule got wrong');
                else {
                  await sleep(3000);
                  // ⚠️ Asked of the GRID, which shows only the chapter being read. "Is there still a folded
                  // page anywhere" is the wrong question: the reader appends the next chapter as you near the
                  // end, and that one opens on the same credit page, so a strip is legitimately still on
                  // screen. Scoping to this chapter's tile is what makes the assertion about the rescue.
                  const still = await tab.evaluate(() => [...document.querySelectorAll('[aria-label]')]
                    .some((x) => /open skipped page 1$/i.test(x.getAttribute('aria-label') || '')));
                  if (still) bad('un-skipping a page left it marked as skipped');
                  else ok(`a page can be rescued by hand from the grid ("${rescued}")`);
                }
              }
            } finally {
              await tab.close().catch(() => {});
            }
          }
        }
      }
    }
  }

  console.log('\n  an 18+ library');
  await page.setViewport({ width: 1440, height: 900 });
  const adminTok0 = await login(USER, PASS);
  const libList = adminTok0
    ? await (await fetch(`${BASE}/api/admin/libraries`, { headers: { authorization: `Bearer ${adminTok0}` } })).json().catch(() => null)
    : null;
  const lib0 = (libList?.content ?? libList ?? [])[0];
  if (!adminTok0 || !lib0?.id) {
    bad('could not read the library list to mark one 18+');
  } else {
    const setRating = (v) => fetch(`${BASE}/api/admin/libraries/${encodeURIComponent(lib0.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminTok0}` },
      body: JSON.stringify({ ageRating: v }),
    });
    const marked = await setRating(18);
    if (!marked.ok) bad(`could not mark a library 18+ (${marked.status} ${(await marked.text()).slice(0, 100)})`);
    else {
      try {
        await page.goto(`${BASE}/library/`, { waitUntil: 'networkidle2', timeout: 60000 });
        await sleep(3000);
        // ⚠️ THE VACUITY GUARD FOR THE ASSERTION BELOW. "None of the seeded names are on the page" is also
        // true of a login form, so without this the next check passed whenever the session had dropped --
        // and it did, intermittently, reporting a missing 18+ button instead of a missing session.
        if (await ensureSignedIn(page, 'the 18+ check')) {
          await page.goto(`${BASE}/library/`, { waitUntil: 'networkidle2', timeout: 60000 });
          await sleep(2500);
        }
        await shot('library-18-hidden');
        const hiddenText = await page.evaluate(() => document.body.innerText || '');
        const signedOut = await page.evaluate(() => !!document.querySelector('input[type=password]'));
        if (signedOut) bad('the 18+ check ran against a signed-out page — it would have passed for the wrong reason');
        else SEEDED.some((n) => hiddenText.includes(n))
          ? bad('an 18+ library is still listed on the library page by default')
          : ok('the 18+ library is off the grid');

        const chip = await page.evaluate(() => {
          const b = [...document.querySelectorAll('button')].find((x) => /18\+/.test(x.textContent || ''));
          if (!b) return false;
          b.click();
          return true;
        });
        if (!chip) {
          // ⚠️ Say WHY. The control renders only when /api/libraries reports an adult library, so a missing
          // chip means either the page is not signed in or it is looking at a stale list -- and the check
          // above ("off the grid") passes VACUOUSLY in the signed-out case, because a page showing nothing
          // contains none of the seeded names either. Without this, a session problem reads as a UI bug.
          const why = await page.evaluate(async () => {
            const signedOut = !!document.querySelector('input[type=password]');
            let seen = 'not asked';
            try {
              const r = await fetch('/api/libraries');
              seen = `${r.status} ${(await r.text()).slice(0, 120)}`;
            } catch (e) { seen = `threw ${e.message}`; }
            return { signedOut, seen, buttons: [...document.querySelectorAll('button')].length };
          });
          bad(`no "Show 18+" control appeared for an account that has an 18+ library `
            + `(signed out: ${why.signedOut}, ${why.buttons} buttons, /api/libraries: ${why.seen})`);
        }
        else {
          await sleep(3500);
          await shot('library-18-shown');
          const shownText = await page.evaluate(() => document.body.innerText || '');
          SEEDED.every((n) => shownText.includes(n))
            ? ok('the button brings it back')
            : bad('clicking "Show 18+" did not reveal the library');

          // The reveal is a session cookie, so the home screen agrees without another click.
          await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
          await sleep(2500);
          const cookieOn = await page.evaluate(() => document.cookie.includes('yomi_adult=1'));
          cookieOn ? ok('the reveal is a session cookie, shared across the app') : bad('the reveal did not persist off the library page');
        }
      } finally {
        await setRating(null).catch(() => {});
        await page.evaluate(() => { document.cookie = 'yomi_adult=; path=/; max-age=0'; });
      }
    }
  }

  // ---------------------------------------------------------------- who may add series
  //
  // `canDownload: false` used to be enforced on exactly one route -- the final POST. A denied account still
  // saw the Discover tab, could browse every source and read full series detail, and only met a wall on the
  // last button. The tab is now hidden, the page says so, and every route behind it refuses.
  //
  // The setup runs over plain HTTP from here rather than inside the page: `/auth/refresh` ROTATES the
  // refresh cookie, so minting a token from the browser fights the app's own session for it.
  console.log('\n  a member who may not add series');
  await page.setViewport({ width: 1440, height: 900 });
  const NODL = { username: 'e2e-nodl', password: 'e2e-nodl-passw0rd-1' };

  /** A real sign-out: the refresh cookie is HttpOnly, so only /auth/logout can drop it. */
  const signOut = async () => {
    await page.evaluate(() => fetch('/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {}));
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.deleteCookie(...(await page.cookies()));
  };

  const adminTok = await login(USER, PASS);
  if (!adminTok) bad('could not sign in over HTTP to set up the permission test');
  else {
    const made = await fetch(`${BASE}/api/admin/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminTok}` },
      body: JSON.stringify({ ...NODL, role: 'user', perms: { canDownload: false } }),
    });
    if (![200, 201, 409].includes(made.status)) {
      bad(`could not create the no-download member (${made.status} ${(await made.text()).slice(0, 120)})`);
    } else {
      ok('created a member with canDownload off');

      // The wall, not the door: the web app is a static export, so the server has to be the one refusing.
      const nodlTok = await login(NODL.username, NODL.password);
      if (!nodlTok) bad('could not sign in as the no-download member');
      else {
        const codes = {};
        for (const u of ['/api/sources', '/api/sources/latest?source=mangadex', '/api/sources/search-all?q=x',
                         '/api/sources/jobs', '/api/discover/trending']) {
          codes[u] = (await fetch(BASE + u, { headers: { authorization: `Bearer ${nodlTok}` } })).status;
        }
        const open = Object.entries(codes).filter(([, c]) => c !== 403);
        open.length
          ? bad(`the server still answers source routes for a denied account: ${JSON.stringify(Object.fromEntries(open))}`)
          : ok('every source route refuses it server-side');

        // …and the app does not offer a door it knows is locked.
        //
        // Clearing storage is NOT signing out: the refresh token is an HttpOnly cookie, so the app refreshes
        // straight back into the same session and every assertion below then runs as the admin and passes
        // for the wrong reason. That is exactly what happened the first time this was written.
        await signOut();
        await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
        await sleep(1500);
        const fields = await page.$$('input');
        if (!fields.length) bad('no login form after signing out -- the session survived');
        else {
          await fields[0].type(NODL.username);
          await page.type('input[type=password]', NODL.password);
          await page.keyboard.press('Enter');
          await sleep(4000);
        }

        if (await page.$('input[type=password]')) bad('could not sign in as the no-download member in the browser');
        else {
          ok('signed in as the no-download member');
          const navHasDiscover = await page.evaluate(() =>
            [...document.querySelectorAll('nav a')].some((a) => (a.getAttribute('href') || '').startsWith('/discover')));
          navHasDiscover ? bad('the Discover tab is still offered to an account that may not add series') : ok('no Discover tab');

          await page.goto(`${BASE}/discover/`, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
          await sleep(2500);
          await shot('nodl-discover');
          const t = await page.evaluate(() => document.body.innerText || '');
          /turned off for your account/i.test(t)
            ? ok('typing the URL says so plainly')
            : bad(`/discover/ did not explain itself to a denied account: ${t.slice(0, 120).replace(/\s+/g, ' ')}`);
        }

        // Back to the admin account so anything after this behaves.
        await signOut();
        await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
        await sleep(1500);
        const back = await page.$$('input');
        if (back.length) {
          await back[0].type(USER);
          await page.type('input[type=password]', PASS);
          await page.keyboard.press('Enter');
          await sleep(3500);
        }
      }
    }
  }

  // --------------------------------------------------------- the reader, when it cannot open a chapter
  //
  // There was no failure state at all. A book that will not load set `ready` with nothing behind it, which
  // dismissed the loading overlay and left a full-screen black rectangle: no message, no retry, no way back.
  // That is indistinguishable from the app hanging, and it is what a reader saw for a corrupt file, an
  // unmounted library, or a chapter someone else had deleted.
  console.log('\n  reader failure state');
  {
    const before = consoleErrors.length;
    await page.goto(`${BASE}/reader?book=b_e2e_definitely_not_a_real_book`, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    const seen = await page.evaluate(() => document.body.innerText || '');
    await page.screenshot({ path: `${OUT}/${String(++step).padStart(2, '0')}-reader-missing.png` });
    if (/Loading chapter/i.test(seen)) bad('the reader is still showing its spinner for a book that will never load');
    else if (!/unavailable|unreadable|Try again/i.test(seen)) {
      bad(`the reader shows nothing at all for a missing chapter (body was ${JSON.stringify(seen.slice(0, 80))}) — this is the black screen`);
    } else if (/You finished/i.test(seen)) bad('a chapter that failed to load is being reported as finishing the series');
    else ok('a missing chapter says so, and offers a way out');
    // This block asks for a book that deliberately does not exist, so the 404 it provokes is the thing under
    // test rather than a defect. The harness exits non-zero on ANY console error, so those entries are taken
    // back out -- but only after checking there were no MORE than the one request should produce, which is
    // what would catch the reader retrying in a loop or spraying failed image requests.
    const provoked = consoleErrors.length - before;
    if (provoked > 2) bad(`opening a missing chapter produced ${provoked} console errors`);
    consoleErrors.length = before;
  }

  // ---------------------------------------------------------------- installable
  console.log('\n  pwa');
  const mf = await page.evaluate(async () => {
    const l = document.querySelector('link[rel=manifest]');
    if (!l) return null;
    try { const r = await fetch(l.href); return { status: r.status, body: await r.json() }; } catch { return { status: 0 }; }
  });
  if (!mf) bad('no <link rel=manifest> — the app is not installable');
  else if (mf.status !== 200) bad(`manifest returned ${mf.status}`);
  else ok(`manifest ok (${mf.body.name || mf.body.short_name})`);

  // ------------------------------------------------------- signing out ends the offline grace
  //
  // ⚠️ LAST ON PURPOSE. It destroys the session every block above depends on, so it cannot move earlier.
  //
  // This is the multi-user safety property, and the one a later refactor is most likely to break, because
  // nothing about it is visible while the network is up: the device keeps a record of who was last signed
  // in so it can address their downloads offline, and if signing out fails to drop that record, the next
  // person to pick up the tablet inherits it -- and with it, the key to somebody else's library.
  //
  // Reintroduce by removing `clearOfflineIdentity()` from `clearLocalSession` in lib/auth.tsx.
  //
  // ⚠️ SIGN OUT THROUGH THE UI, not with `fetch('/auth/logout')`. The endpoint drops the server's cookie;
  // it is the app's own `logout()` that clears the saved identity, and that is the half being tested. An
  // earlier version of this block called the endpoint directly and passed locally -- but only because a
  // helper further up had already emptied localStorage, so it was asserting nothing. CI, with different
  // state, failed it correctly. A test that signs out by a route no user can take proves nothing about
  // what happens when a user signs out.
  console.log('\n  signing out ends the offline grace');
  await page.goto(`${BASE}/profile`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2000);
  const signedOutViaUi = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /sign out/i.test(x.textContent || ''));
    if (!b) return false;
    b.click();
    return true;
  });
  if (!signedOutViaUi) bad('could not find the Sign out control on /profile');
  await sleep(3000);
  await page.setOfflineMode(true);
  networkCut = true;
  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(6000);
    const after = await page.evaluate(() => ({
      signedOut: !!document.querySelector('input[type=password]'),
      readerLinks: document.querySelectorAll('a[href*="/reader"]').length,
    }));
    await shot('28-signed-out-offline');
    // Both directions: the sign-in screen is PRESENT, and no downloads are reachable behind it.
    if (!after.signedOut) bad('after signing out, an offline launch did not ask for a password');
    else if (after.readerLinks) bad(`after signing out, an offline launch still listed ${after.readerLinks} downloaded chapter(s)`);
    else ok('after signing out, an offline launch asks to sign in and lists nothing');
  } finally {
    await page.setOfflineMode(false);
    networkCut = false;
  }
} finally {
  await browser.close();
}

console.log('\n' + '='.repeat(70));
console.log(`${fails.length} failure(s), ${consoleErrors.length} console error(s), ${serverErrors.length} server error(s)`);
for (const f of fails) console.log(`  ${f}`);
for (const c of [...new Set(consoleErrors)].slice(0, 10)) console.log(`  console: ${c.slice(0, 160)}`);
for (const s of [...new Set(serverErrors)].slice(0, 10)) console.log(`  server:  ${s.slice(0, 160)}`);
if (offlineNotes.length) {
  console.log(`  ${offlineNotes.length} request(s) failed while the network was cut on purpose (noted, not counted):`);
  for (const n of [...new Set(offlineNotes)].slice(0, 5)) console.log(`    ${n.slice(0, 160)}`);
}
if (consoleErrors.length) {
  for (const r of [...new Set(failedRequests)].slice(0, 10)) console.log(`  failed:  ${r.slice(0, 160)}`);
}
if (thirdPartyNotes.length) {
  console.log(`  ${thirdPartyNotes.length} third-party cover(s) failed upstream (noted, not counted):`);
  for (const n of [...new Set(thirdPartyNotes)].slice(0, 5)) console.log(`    ${n.slice(0, 160)}`);
}
writeFileSync(`${OUT}/result.json`, JSON.stringify({ fails, consoleErrors, serverErrors }, null, 2));
process.exit(fails.length || consoleErrors.length || serverErrors.length ? 1 : 0);
