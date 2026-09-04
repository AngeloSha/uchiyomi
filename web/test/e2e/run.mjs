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
      if (thirdPartyCover(m.location()?.url)) thirdPartyNotes.push(`console @ ${page.url()}: ${m.location().url}`);
      else consoleErrors.push(`${page.url()} :: ${m.text()}`);
    }
  });
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

  // ---------------------------------------------------------------- every screen
  for (const [name, path] of [['home', '/'], ['library', '/library'], ['search', '/search'],
                              ['browse', '/browse'], ['downloads', '/downloads'],
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
  const href = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a')].find((x) => /\/series\//.test(x.getAttribute('href') || ''));
    return a ? a.getAttribute('href') : null;
  });
  if (!href) bad('no series to open from the library grid');
  else {
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
  for (const [name, path] of [['home', '/'], ['library', '/library']]) {
    await page.goto(BASE + path, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    await sleep(2000);
    await shot(`phone-${name}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    overflow > 4 ? bad(`phone ${path}: ${overflow}px of horizontal overflow`) : ok(`phone ${path}: no overflow`);
  }

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

  /** Sign in over plain HTTP and return an access token. Used by the two setup-heavy cases below. */
  const login = async (u, p) => {
    const r = await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: u, password: p }),
    });
    return r.ok ? (await r.json()).accessToken : null;
  };

  // ---------------------------------------------------------------- clicking, not typing URLs
  //
  // Every check above navigates with page.goto, which is a fresh load with an empty react-query cache. A
  // person clicks the nav instead, and that carries the cache from one page to the next -- which is how
  // /discover/ shipped broken while every URL-driven test passed: it shared the query key `['trending']`
  // with the home page, was handed the home page's differently-shaped data, and threw on first render.
  console.log('\n  moving around by clicking');
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(3000);
  for (const href of ['/library', '/browse', '/discover', '/collections', '/updates', '/', '/discover']) {
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
        await shot('library-18-hidden');
        const hiddenText = await page.evaluate(() => document.body.innerText || '');
        SEEDED.some((n) => hiddenText.includes(n))
          ? bad('an 18+ library is still listed on the library page by default')
          : ok('the 18+ library is off the grid');

        const chip = await page.evaluate(() => {
          const b = [...document.querySelectorAll('button')].find((x) => /18\+/.test(x.textContent || ''));
          if (!b) return false;
          b.click();
          return true;
        });
        if (!chip) bad('no "Show 18+" control appeared for an account that has an 18+ library');
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
} finally {
  await browser.close();
}

console.log('\n' + '='.repeat(70));
console.log(`${fails.length} failure(s), ${consoleErrors.length} console error(s), ${serverErrors.length} server error(s)`);
for (const f of fails) console.log(`  ${f}`);
for (const c of [...new Set(consoleErrors)].slice(0, 10)) console.log(`  console: ${c.slice(0, 160)}`);
for (const s of [...new Set(serverErrors)].slice(0, 10)) console.log(`  server:  ${s.slice(0, 160)}`);
if (thirdPartyNotes.length) {
  console.log(`  ${thirdPartyNotes.length} third-party cover(s) failed upstream (noted, not counted):`);
  for (const n of [...new Set(thirdPartyNotes)].slice(0, 5)) console.log(`    ${n.slice(0, 160)}`);
}
writeFileSync(`${OUT}/result.json`, JSON.stringify({ fails, consoleErrors, serverErrors }, null, 2));
process.exit(fails.length || consoleErrors.length || serverErrors.length ? 1 : 0);
