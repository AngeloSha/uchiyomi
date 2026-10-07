// walk49's v0.55.8 acceptance phases, through the real browser UI. Run every phase on a fresh stack of its own:
//
//   librarysort -- a plain stack. At 1280, 390 and 390 in Arabic, an account default controls a Library URL with no
//     sort; a valid sort in a shared URL wins without changing that default; clicking a sort changes the URL at once,
//     saves the new account default, and a URL with no sort uses it after a reload.
//
//   homelists -- a plain stack with E2E_NET. Five lists around the two seeded series prove the legacy first-three-
//     nonempty fallback, an explicit zero, an empty selected slot, the three-list ceiling, accessible earlier/later
//     controls, selected order on Home, an empty list appearing in its retained slot once populated, and a deleted
//     stale id being dropped by the next edit. The settled controls and rails are also checked at 390 and 390 in Arabic.
//
//   anilistprivacy -- up.sh with E2E_ANILIST=1, LIB and E2E_NET. A known-to-the-fake series first receives art, a
//     link, type and direction. The default library's UI turns automatic AniList lookup off and explains that manual
//     actions can still connect: the metadata stays, and Admin -> Tasks -> Check online matches contacts the fake by
//     id while the opt-out remains. Two fresh copies opened in that library make zero requests and no negative cache;
//     moving one to an enabled library permits its deferred lookup, while the other waits for the default library to
//     be re-enabled. The same policy control is inspected at 390 and 390 in Arabic.
//
//   bulkdelete -- a plain stack. At 1280, 390 and 390 in Arabic, Library selection reaches the warning without
//     deleting anything. At 1280 the browser intercepts only the durable-run endpoints: a synthetic persisted job
//     proves progress, close/reopen, reload recovery and cancellation while the real chapter files stay untouched.
//
// Issue #174's Reduce-effects navigation regression remains in walk43: it follows real in-app links with reduced
// motion enabled. It is intentionally not duplicated here. Every view below also checks horizontal overflow;
// walk49 owns the shared console-error and unexpected-5xx assertions. Screenshots are v558-<phase>-*.png in OUT.
import { execFileSync } from 'node:child_process';
import { kit, writeShelf } from './filenamesWalk.mjs';

const PASSES = [[1280, 'en'], [390, 'en'], [390, 'ar']];
const tag = (width, lang) => `${width}${lang === 'ar' ? 'ar' : ''}`;
const lit = (value) => `'${String(value).replace(/'/g, "''")}'`;
const sqlOf = (net) => (text) => execFileSync(
  'docker', ['exec', `${net}-db`, 'psql', '-U', 'postgres', '-d', 'yomi', '-tAqc', text], { encoding: 'utf8' },
).trim();

const tapText = (page, text, root = null) => page.evaluate((wanted, selector) => {
  const scope = selector ? document.querySelector(selector) : document;
  const el = [...(scope?.querySelectorAll('button, a, [role="menuitem"]') ?? [])]
    .find((node) => node.getClientRects().length && node.textContent?.replace(/\s+/g, ' ').trim() === wanted);
  el?.click();
  return !!el;
}, text, root);
const cardButton = (page, name, which = 'toggle') => page.evaluate((title, action) => {
  const card = [...document.querySelectorAll('div.card')].find((node) =>
    [...node.querySelectorAll('p')].some((p) => p.textContent?.trim() === title));
  if (!card) return false;
  const button = action === 'toggle'
    ? card.querySelector('button[aria-pressed]')
    : [...card.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === action);
  button?.click();
  return !!button;
}, name, which);

// ── saved Library sort ─────────────────────────────────────────────────────────────────────────────────────────────

export async function librarySortWalk(ctx) {
  const { page, check, waitFor, sleep } = ctx;
  const { call, say, setLang, visit, noSideScroll, lang } = kit(ctx);
  const settings = () => call('/api/settings');
  const openSorts = async (width) => {
    if (width >= 1024) return true;
    if (await page.$('[role="dialog"]')) return true;
    const opened = await tapText(page, say('Filters'));
    await waitFor(() => page.$('[role="dialog"]'), 5000, 100);
    return opened;
  };
  const sortPressed = (label) => page.evaluate((wanted) => {
    const button = [...document.querySelectorAll('button[aria-pressed]')]
      .find((b) => b.getClientRects().length && b.textContent?.trim() === wanted);
    return button?.getAttribute('aria-pressed') === 'true';
  }, label);

  for (const [width, language] of PASSES) {
    const t = tag(width, language);
    console.log(`\n  librarysort @${width}${language === 'ar' ? ' ar' : ''}`);
    if (language !== lang()) await setLang(language);
    await call('/api/settings', { method: 'PUT', json: { librarySort: 'az' } });
    await page.setViewport({ width, height: width < 1024 ? 844 : 900 });

    await visit('/library', 3000);
    check(`librarysort @${t}: the saved A–Z default controls a URL with no sort`,
      !new URL(page.url()).searchParams.has('sort') && await openSorts(width) && await sortPressed(say('A–Z')), page.url());
    check(`librarysort @${t}: the default view has no sideways scroll`, await noSideScroll());
    await ctx.shot(`v558-librarysort-${t}-1-default`);
    if (width < 1024) await page.keyboard.press('Escape');

    await visit('/library?sort=unread', 3000);
    await openSorts(width);
    check(`librarysort @${t}: a valid shared URL wins for this visit`, await sortPressed(say('Most unread')), page.url());
    check(`librarysort @${t}: following that URL did not rewrite the account default`,
      (await settings()).librarySort === 'az', JSON.stringify(await settings()));
    await ctx.shot(`v558-librarysort-${t}-2-shared-url`);

    const clicked = await tapText(page, say('Newest'), width < 1024 ? '[role="dialog"]' : null);
    const saved = await waitFor(async () => {
      const now = await settings();
      return now.librarySort === 'new' && new URL(page.url()).searchParams.get('sort') === 'new' ? now : null;
    }, 10_000, 200);
    check(`librarysort @${t}: a direct sort click updates the URL and saves the default`, clicked && !!saved,
      `${page.url()} ${JSON.stringify(await settings())}`);
    check(`librarysort @${t}: the clicked sort remains the visible view`, await sortPressed(say('Newest')));
    await ctx.shot(`v558-librarysort-${t}-3-clicked`);

    if (width < 1024) await page.keyboard.press('Escape');
    await visit('/library', 3000);
    await openSorts(width);
    check(`librarysort @${t}: after a reload, a URL with no sort uses the newly saved default`,
      !new URL(page.url()).searchParams.has('sort') && await sortPressed(say('Newest')), page.url());
    check(`librarysort @${t}: the reloaded layout has no sideways scroll`, await noSideScroll());
    await ctx.shot(`v558-librarysort-${t}-4-reloaded`);
    if (width < 1024) await page.keyboard.press('Escape');
    await sleep(150);
  }
  if (lang() !== 'en') await setLang('en');
}

// ── ordered Home lists ─────────────────────────────────────────────────────────────────────────────────────────────

export async function homeListsWalk(ctx) {
  const { page, check, waitFor, sleep } = ctx;
  const { call, say, setLang, visit, noSideScroll, lang } = kit(ctx);
  const net = process.env.E2E_NET;
  if (!net) { check('homelists: E2E_NET names the disposable instance (up.sh prints it with KEEP=1)', false); return; }
  const sql = sqlOf(net);
  const prefix = 'v558 Home ';
  const collections = () => call('/api/collections');
  const settings = () => call('/api/settings');
  const homeIds = async () => (await settings()).homeCollections;
  const waitIds = (ids) => waitFor(async () => {
    const got = await homeIds();
    return JSON.stringify(got) === JSON.stringify(ids) ? got : null;
  }, 10_000, 200);
  const railNames = () => page.evaluate((start) => [...document.querySelectorAll('section h2')]
    .map((h) => h.textContent?.trim() ?? '').filter((name) => name.startsWith(start)), prefix);
  const waitRails = (names) => waitFor(async () => {
    const got = await railNames();
    return JSON.stringify(got) === JSON.stringify(names) ? got : null;
  }, 15_000, 300);
  const waitCardLabel = (name, label) => waitFor(() => page.evaluate((title, wanted) => {
    const card = [...document.querySelectorAll('div.card')].find((node) =>
      [...node.querySelectorAll('p')].some((p) => p.textContent?.trim() === title));
    return !![...(card?.querySelectorAll('button') ?? [])].find((b) => b.getClientRects().length && b.textContent?.trim() === wanted);
  }, name, label), 8000, 150);

  // A rerun on the same disposable stack starts from the same named fixture, without touching any series or files.
  for (const c of (await collections()).content.filter((row) => row.name.startsWith(prefix))) {
    await call(`/api/collections/${c.id}`, { method: 'DELETE' });
  }
  const make = (name, accent) => call('/api/collections', { json: { name: prefix + name, accent } });
  const [alpha, empty, beta, gamma, delta] = await Promise.all([
    make('Alpha', '#7c5cff'), make('Empty', '#ff4dd2'), make('Beta', '#22d3ee'),
    make('Gamma', '#34d399'), make('Delta', '#fbbf24'),
  ]);
  // PostgreSQL ties same-millisecond creations by created_at, so give the fixture an explicit deterministic order.
  for (const [i, c] of [alpha, empty, beta, gamma, delta].entries()) {
    await call(`/api/collections/${c.id}`, { method: 'PATCH', json: { sortOrder: i } });
  }
  const series = (await call('/api/series/search', { json: { query: '', size: 20 } })).content ?? [];
  check('homelists: the clean stack has series to place in list rails', series.length >= 2, String(series.length));
  if (series.length < 2) return;
  for (const c of [alpha, beta, gamma, delta]) {
    await call(`/api/collections/${c.id}/items`, { json: { seriesId: series[0].id } });
  }
  // Missing means legacy fallback; JSON null would be an explicit value and is deliberately not used.
  sql(`UPDATE app_settings SET data = data - 'homeCollections' WHERE user_id = (SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1)`);

  await setLang('en');
  await page.setViewport({ width: 1280, height: 900 });
  await visit('/', 4500);
  const legacy = await waitRails([alpha.name, beta.name, gamma.name]);
  check('homelists: with no setting, Home keeps the legacy first three nonempty lists', !!legacy, JSON.stringify(await railNames()));
  await ctx.shot('v558-homelists-1280-1-legacy');

  await visit('/collections', 3000);
  check('homelists: the empty list does not consume a legacy slot',
    await waitCardLabel(alpha.name, say('Home {n}', { n: 1 }))
      && await waitCardLabel(beta.name, say('Home {n}', { n: 2 }))
      && await waitCardLabel(gamma.name, say('Home {n}', { n: 3 }))
      && await waitCardLabel(empty.name, say('Show on Home')));

  // Turning the three legacy picks off writes []: explicit zero, not a return to legacy fallback.
  await cardButton(page, alpha.name); await waitIds([beta.id, gamma.id]);
  await cardButton(page, beta.name); await waitIds([gamma.id]);
  await cardButton(page, gamma.name); await waitIds([]);
  check('homelists: removing every selected list stores an explicit empty array', JSON.stringify(await homeIds()) === '[]');
  await visit('/', 3500);
  check('homelists: explicit zero renders no list rail', (await railNames()).length === 0, JSON.stringify(await railNames()));

  // Empty takes a real slot. Three is the ceiling and the fourth press says why without changing the setting.
  await visit('/collections', 2500);
  await cardButton(page, beta.name); await waitIds([beta.id]);
  await cardButton(page, empty.name); await waitIds([beta.id, empty.id]);
  await cardButton(page, alpha.name); await waitIds([beta.id, empty.id, alpha.id]);
  const fourth = await cardButton(page, delta.name);
  await sleep(500);
  const ceiling = await page.evaluate((text) => [...document.querySelectorAll('[data-notices] *')]
    .some((el) => el.textContent?.trim() === text), say('Choose up to 3 lists for Home'));
  check('homelists: a fourth list is refused with an explanatory message',
    fourth && ceiling && JSON.stringify(await homeIds()) === JSON.stringify([beta.id, empty.id, alpha.id]),
    JSON.stringify(await homeIds()));

  const earlier = await cardButton(page, empty.name, say('Move earlier'));
  check('homelists: accessible earlier control changes the persisted order', earlier && !!(await waitIds([empty.id, beta.id, alpha.id])));
  check('homelists: positions are visible on the cards',
    await waitCardLabel(empty.name, say('Home {n}', { n: 1 }))
      && await waitCardLabel(beta.name, say('Home {n}', { n: 2 }))
      && await waitCardLabel(alpha.name, say('Home {n}', { n: 3 })));
  await ctx.shot('v558-homelists-1280-2-ordered-controls');

  await visit('/', 3500);
  check('homelists: an explicitly selected empty list keeps its slot but has no empty rail',
    !!(await waitRails([beta.name, alpha.name])), JSON.stringify(await railNames()));
  await call(`/api/collections/${empty.id}/items`, { json: { seriesId: series[1].id } });
  await visit('/', 3500);
  check('homelists: once populated, the empty list appears in its retained first slot',
    !!(await waitRails([empty.name, beta.name, alpha.name])), JSON.stringify(await railNames()));

  // Make a selected id stale, then make one ordinary edit. The edit writes only the still-owned order.
  await visit('/collections', 2500);
  await cardButton(page, alpha.name); await waitIds([empty.id, beta.id]);
  await cardButton(page, delta.name); await waitIds([empty.id, beta.id, delta.id]);
  await call(`/api/collections/${delta.id}`, { method: 'DELETE' });
  await visit('/collections', 2500);
  const staleHidden = !(await page.evaluate((name) => [...document.querySelectorAll('div.card p')].some((p) => p.textContent?.trim() === name), delta.name));
  const later = await cardButton(page, empty.name, say('Move later'));
  check('homelists: a deleted selected id is ignored, then removed by the next edit',
    staleHidden && later && !!(await waitIds([beta.id, empty.id])), JSON.stringify(await homeIds()));

  // The settled two-list state at phone width and RTL: controls remain accessible, physical start mirrors, Home keeps order.
  for (const [width, language] of [[390, 'en'], [390, 'ar']]) {
    const t = tag(width, language);
    if (language !== lang()) await setLang(language);
    await page.setViewport({ width, height: 844 });
    await visit('/collections', 3000);
    const controls = await page.evaluate((names, labels) => names.every((name, i) => {
      const card = [...document.querySelectorAll('div.card')].find((node) =>
        [...node.querySelectorAll('p')].some((p) => p.textContent?.trim() === name));
      return !!card && [...card.querySelectorAll('button')].some((b) => b.textContent?.trim() === labels[i]);
    }), [beta.name, empty.name], [say('Home {n}', { n: 1 }), say('Home {n}', { n: 2 })]);
    check(`homelists @${t}: the ordered positions fit on the phone`, controls && await noSideScroll());
    const arrowLabels = await page.evaluate((labels) => labels.every((label) =>
      [...document.querySelectorAll('button')].some((b) => b.getClientRects().length && b.getAttribute('aria-label') === label)),
    [say('Move earlier'), say('Move later')]);
    check(`homelists @${t}: earlier and later controls have accessible names`, arrowLabels);
    if (language === 'ar') {
      const rtlStart = await page.evaluate((name) => {
        const card = [...document.querySelectorAll('div.card')].find((node) =>
          [...node.querySelectorAll('p')].some((p) => p.textContent?.trim() === name));
        const bar = card?.querySelector('span.absolute.inset-y-0');
        if (!card || !bar || document.documentElement.dir !== 'rtl') return false;
        const c = card.getBoundingClientRect(); const b = bar.getBoundingClientRect();
        return Math.abs(c.right - b.right) <= 2 && b.left > c.left + c.width / 2;
      }, beta.name);
      check('homelists @390ar: the card accent is on the RTL start edge', rtlStart);
    }
    await ctx.shot(`v558-homelists-${t}-3-controls`);
    await visit('/', 3500);
    check(`homelists @${t}: Home follows the saved order`, !!(await waitRails([beta.name, empty.name])), JSON.stringify(await railNames()));
    check(`homelists @${t}: Home has no sideways scroll`, await noSideScroll());
    await ctx.shot(`v558-homelists-${t}-4-home`);
  }
  if (lang() !== 'en') await setLang('en');
}

// ── per-library AniList privacy ────────────────────────────────────────────────────────────────────────────────────

export async function anilistPrivacyWalk(ctx) {
  const { page, check, waitFor, sleep, lib, base } = ctx;
  const { call, say, setLang, visit, noSideScroll, scan, lang } = kit(ctx);
  const net = process.env.E2E_NET;
  if (!lib || !net) {
    check('anilistprivacy: LIB and E2E_NET name the disposable E2E_ANILIST=1 instance', false);
    return;
  }
  const sql = sqlOf(net);
  const anilist = `http://127.0.0.1:${28_000 + (Number(new URL(base).port) % 1000)}`;
  const log = async () => (await (await fetch(`${anilist}/__log`)).json());
  const resetLog = async () => { const r = await fetch(`${anilist}/__reset`, { method: 'POST' }); return r.ok; };
  const libraries = async () => (await call('/api/admin/libraries')).content;
  const policy = async () => (await libraries()).find((row) => row.id === 'lib')?.anilist_lookup;
  const idInFolder = (folder) => sql(`SELECT id FROM lib_series WHERE folder = ${lit(folder)}`);
  const cached = (id) => sql(`SELECT (SELECT count(*) FROM series_art WHERE series_id = ${lit(id)}) || '|' ||
                                    (SELECT count(*) FROM series_trackers WHERE series_id = ${lit(id)} AND provider = 'anilist')`);
  const metadata = (id) => {
    const raw = sql(`SELECT json_build_object(
      'art', (SELECT json_build_object('banner', banner, 'cover', cover) FROM series_art WHERE series_id = s.id),
      'link', (SELECT json_build_object('externalId', external_id, 'linkedBy', linked_by)
                 FROM series_trackers WHERE series_id = s.id AND provider = 'anilist'),
      'direction', s.reading_direction, 'directionFrom', s.reading_direction_from,
      'type', s.series_type, 'typeFrom', s.series_type_from, 'libraryId', s.library_id)::text
      FROM lib_series s WHERE s.id = ${lit(id)}`);
    try { return raw ? JSON.parse(raw) : null; } catch { return null; }
  };
  const enriched = (id) => {
    const m = metadata(id);
    return m?.art?.banner && m?.art?.cover && m?.link?.externalId === '970002'
      && m.direction === 'WEBTOON' && m.directionFrom === 'anilist'
      && m.type === 'manhwa' && m.typeFrom === 'anilist' ? m : null;
  };
  const backdrop = (id, name) => page.evaluate(async (seriesId, walk) => {
    const r = await fetch(`/img/series/${encodeURIComponent(seriesId)}/backdrop?style=banner&walk=${encodeURIComponent(walk)}`, { cache: 'no-store' });
    return r.status;
  }, id, name);
  const matchTask = async () => (await call('/api/admin/tasks')).content.find((row) => row.id === 'matches');
  const openDefault = async (width, language) => {
    if (language !== lang()) await setLang(language);
    await page.setViewport({ width, height: width < 1024 ? 844 : 900 });
    await visit('/admin/?tab=Library', 3500);
    const opened = await page.evaluate((label) => {
      const card = document.querySelector('[data-library-card="lib"]');
      const button = [...(card?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === label);
      button?.click(); return !!button;
    }, say('Settings'));
    await waitFor(() => page.$('[data-library-dialog="lib"]'), 8000, 150);
    return opened;
  };
  const privacyCopy = "When off, automatic lookups do not send this library's titles to AniList. Existing art and matches stay, and manual AniList actions can still connect.";
  const existingFolder = 'v558 Existing/Walk Nightfall';
  const privateFolder = 'v558 Privacy/Walk Nightfall';
  const movingFolder = 'v558 Move Probe/Walk Nightfall';
  const enabledRoot = 'v558 Enabled Area';

  check('anilistprivacy: the fake AniList answers (up.sh with E2E_ANILIST=1)', Array.isArray(await log().catch(() => null)));
  await setLang('en');

  // Establish all four AniList-derived fields before opting out. The rest of the phase compares this exact payload,
  // excluding only check timestamps, so "preserve" means more than keeping a picture visible in the browser.
  check('anilistprivacy: fake request history was reset before the enabled-library baseline', await resetLog());
  writeShelf(lib, existingFolder, { 'Nightfall 001.cbz': 3, 'Nightfall 002.cbz': 3 });
  const baselineScan = await scan();
  check('anilistprivacy: the enabled-library baseline was scanned', typeof baselineScan?.books === 'number', JSON.stringify(baselineScan));
  const existingId = await waitFor(() => idInFolder(existingFolder) || null, 15_000, 300);
  check('anilistprivacy: the baseline series exists in the default library', !!existingId);
  if (!existingId) return;
  await page.setViewport({ width: 1280, height: 900 });
  await visit(`/series/?id=${existingId}`, 5000);
  const baselineBackdrop = await backdrop(existingId, 'v558-baseline');
  const beforeOptOut = await waitFor(() => enriched(existingId), 20_000, 400);
  check('anilistprivacy: while enabled, automatic lookup stores art, link, type and direction',
    baselineBackdrop === 200 && !!beforeOptOut, `${baselineBackdrop} ${JSON.stringify(metadata(existingId))} ${JSON.stringify(await log())}`);

  check('anilistprivacy: the default library editor opens', await openDefault(1280, 'en'));
  const initial = await page.$eval('[data-library-anilist-lookup]', (e) => e.checked);
  const wording = await page.$eval('[data-library-dialog="lib"]', (e) => e.textContent.replace(/\s+/g, ' ').trim());
  check('anilistprivacy: automatic lookup defaults on and the editor explains the manual exception',
    initial && wording.includes(say('Look up art and metadata on AniList automatically')) && wording.includes(say(privacyCopy)), wording);
  await page.click('[data-library-anilist-lookup]');
  await page.click('[data-library-save]');
  check('anilistprivacy: saving the default library turns automatic lookup off',
    !!(await waitFor(async () => (await policy()) === false ? true : null, 10_000, 250)));

  // Existing derived data is retained. Visiting it again is implicit work and must neither erase it nor call AniList.
  check('anilistprivacy: fake request history was reset after opting out', await resetLog());
  await visit(`/series/?id=${existingId}`, 4000);
  const keptBackdrop = await backdrop(existingId, 'v558-preserved');
  await sleep(500);
  check('anilistprivacy: existing art, link, type and direction survive opt-out',
    keptBackdrop === 200 && JSON.stringify(metadata(existingId)) === JSON.stringify(beforeOptOut) && (await log()).length === 0,
    `${keptBackdrop} ${JSON.stringify(metadata(existingId))} ${JSON.stringify(await log())}`);

  // The exception in the editor is real, not only copy: this explicit Admin action includes opted-out libraries.
  await visit('/admin/?tab=Tasks', 3500);
  await waitFor(() => page.$('#task-matches > button'), 10_000, 200);
  await waitFor(async () => (await matchTask())?.running ? null : true, 30_000, 500);
  await resetLog();
  const ranManually = await page.evaluate(() => {
    const button = document.querySelector('#task-matches > button');
    const ready = !!button && !button.disabled;
    if (ready) button.click();
    return ready;
  });
  const manualRequest = await waitFor(async () => {
    const rows = await log();
    return rows.some((row) => row.kind === 'ids' && (row.ids ?? []).includes(970002)) ? rows : null;
  }, 30_000, 500);
  const manualDone = await waitFor(async () => (await matchTask())?.running ? null : true, 60_000, 600);
  check('anilistprivacy: explicit Check online matches contacts AniList while opt-out remains',
    ranManually && !!manualRequest && !!manualDone && (await policy()) === false,
    JSON.stringify({ ranManually, manualRequest, task: await matchTask(), policy: await policy() }));
  check('anilistprivacy: the manual check leaves the preserved metadata intact',
    JSON.stringify(metadata(existingId)) === JSON.stringify(beforeOptOut), JSON.stringify(metadata(existingId)));
  await ctx.shot('v558-anilistprivacy-1280-1-manual-exception');

  check('anilistprivacy: fake request history was reset before the private-library exercise', await resetLog());
  writeShelf(lib, privateFolder, { 'Nightfall 011.cbz': 3, 'Nightfall 012.cbz': 3 });
  writeShelf(lib, movingFolder, { 'Nightfall 021.cbz': 3, 'Nightfall 022.cbz': 3 });
  // A real, otherwise-empty folder for the enabled destination library. It is deliberately unknown to the fake.
  writeShelf(lib, `${enabledRoot}/Policy Holder`, { 'Policy Holder 001.cbz': 3 });
  const scanned = await scan();
  check('anilistprivacy: the private library was scanned', typeof scanned?.books === 'number', JSON.stringify(scanned));
  const privateId = await waitFor(() => idInFolder(privateFolder) || null, 15_000, 300);
  const movingId = await waitFor(() => idInFolder(movingFolder) || null, 15_000, 300);
  check('anilistprivacy: both known-to-AniList private folders became separate series', !!privateId && !!movingId,
    JSON.stringify({ privateId, movingId }));
  if (!privateId || !movingId) return;
  check('anilistprivacy: the move probe starts in the opted-out default library', metadata(movingId)?.libraryId === 'lib',
    JSON.stringify(metadata(movingId)));
  await visit(`/series/?id=${privateId}`, 5000);
  const offBackdrop = await backdrop(privateId, 'v558-off-private');
  await visit(`/series/?id=${movingId}`, 5000);
  const movingOffBackdrop = await backdrop(movingId, 'v558-off-moving');
  await sleep(2500);
  const whileOff = await log();
  check('anilistprivacy: scan and automatic art for both series make zero AniList requests in the opted-out destination',
    offBackdrop === 200 && movingOffBackdrop === 200 && whileOff.length === 0,
    `${offBackdrop}|${movingOffBackdrop} ${JSON.stringify(whileOff)}`);
  check('anilistprivacy: skipped lookups create neither art misses nor automatic match rows',
    cached(privateId) === '0|0' && cached(movingId) === '0|0',
    JSON.stringify({ private: cached(privateId), moving: cached(movingId) }));
  await ctx.shot('v558-anilistprivacy-1280-1-no-automatic-lookup');

  for (const [width, language] of [[390, 'en'], [390, 'ar']]) {
    const t = tag(width, language);
    check(`anilistprivacy @${t}: the default library editor opens`, await openDefault(width, language));
    const state = await page.$eval('[data-library-anilist-lookup]', (e) => e.checked);
    const copy = await page.$eval('[data-library-dialog="lib"]', (e) => e.textContent.replace(/\s+/g, ' ').trim());
    check(`anilistprivacy @${t}: opt-out and the manual-contact explanation are visible`,
      !state && copy.includes(say('Look up art and metadata on AniList automatically')) && copy.includes(say(privacyCopy)), copy);
    check(`anilistprivacy @${t}: the editor has no sideways scroll`, await noSideScroll());
    await ctx.shot(`v558-anilistprivacy-${t}-2-library-policy`);
    await page.keyboard.press('Escape');
  }

  // Move one of the untouched rows into an enabled destination. The series move, rather than its folder, decides the
  // privacy boundary; the same lazy request that was silent above is now allowed without toggling the default library.
  if (lang() !== 'en') await setLang('en');
  const enabled = await call('/api/admin/libraries', {
    json: { name: 'v558 AniList enabled', paths: [enabledRoot], anilistLookup: true },
  });
  check('anilistprivacy: an enabled destination library was created', !!enabled?.id, JSON.stringify(enabled));
  if (!enabled?.id) return;
  await call(`/api/admin/series/${movingId}/library`, { json: { libraryId: enabled.id } });
  check('anilistprivacy: the probe moved into the enabled destination', metadata(movingId)?.libraryId === enabled.id,
    JSON.stringify(metadata(movingId)));
  await resetLog();
  await visit(`/series/?id=${movingId}`, 5000);
  const movedBackdrop = await backdrop(movingId, 'v558-after-move');
  const movedRequest = await waitFor(async () => {
    const rows = await log();
    return rows.some((row) => row.kind === 'search' && String(row.s).toLowerCase() === 'walk nightfall') ? rows : null;
  }, 20_000, 400);
  const movedMetadata = await waitFor(() => enriched(movingId), 15_000, 400);
  check('anilistprivacy: after the move, the enabled destination permits automatic AniList enrichment',
    movedBackdrop === 200 && !!movedRequest && movedMetadata?.libraryId === enabled.id,
    `${movedBackdrop} ${JSON.stringify(movedRequest)} ${JSON.stringify(metadata(movingId))}`);
  check('anilistprivacy: the default library stayed opted out while the destination allowed that request',
    (await policy()) === false, String(await policy()));
  await ctx.shot('v558-anilistprivacy-1280-3-destination-policy');

  // No negative cache row was written for the series left behind, so re-enabling can perform its ordinary lazy lookup.
  check('anilistprivacy: the editor opens to re-enable the policy', await openDefault(1280, 'en'));
  await page.click('[data-library-anilist-lookup]');
  await page.click('[data-library-save]');
  check('anilistprivacy: the default library policy is on again',
    !!(await waitFor(async () => (await policy()) === true ? true : null, 10_000, 250)));
  await resetLog();
  await visit(`/series/?id=${privateId}`, 5000);
  const onBackdrop = await backdrop(privateId, 'v558-on');
  const asked = await waitFor(async () => {
    const rows = await log();
    return rows.some((row) => row.kind === 'search' && String(row.s).toLowerCase() === 'walk nightfall') ? rows : null;
  }, 20_000, 400);
  check('anilistprivacy: re-enabling performs the deferred automatic title lookup',
    onBackdrop === 200 && !!asked, `${onBackdrop} ${JSON.stringify(await log())}`);
  const stored = await waitFor(() => enriched(privateId), 15_000, 400);
  check('anilistprivacy: the re-enabled lookup stores art, link, type and direction', !!stored, JSON.stringify(metadata(privateId)));
  await ctx.shot('v558-anilistprivacy-1280-4-re-enabled');
  if (lang() !== 'en') await setLang('en');
}

// ── durable bulk deletion UI, with only its endpoints simulated ────────────────────────────────────────────────────

export async function bulkDeleteWalk(ctx) {
  const { page, check, waitFor, sleep } = ctx;
  const { say, setLang, visit, noSideScroll, lang } = kit(ctx);
  const openWarning = async (width, language) => {
    if (language !== lang()) await setLang(language);
    await page.setViewport({ width, height: width < 1024 ? 844 : 900 });
    await visit('/library', 3000);
    await tapText(page, say('Select'));
    const picked = await page.evaluate(() => {
      const tile = document.querySelector('[data-library-grid] > button');
      tile?.click(); return !!tile;
    });
    await waitFor(() => page.evaluate((label) => [...document.querySelectorAll('button')]
      .some((b) => b.getClientRects().length && b.textContent?.trim() === label), say('More')), 5000, 100);
    await tapText(page, say('More'));
    await waitFor(() => page.$('[role="dialog"] [data-delete-chapters-selected]'), 5000, 100);
    await page.click('[role="dialog"] [data-delete-chapters-selected]');
    await waitFor(() => page.$('[role="dialog"] [data-also-pause]'), 5000, 100);
    return picked;
  };
  const warning = async () => page.$eval('[role="dialog"]', (e) => e.textContent.replace(/\s+/g, ' ').trim());

  // Phone and Arabic stop at the confirmation. Nothing has reached the deletion endpoint.
  for (const [width, language] of [[390, 'en'], [390, 'ar']]) {
    const t = tag(width, language);
    console.log(`\n  bulkdelete @${width}${language === 'ar' ? ' ar' : ''}`);
    const picked = await openWarning(width, language);
    const text = await warning();
    const paused = await page.$eval('[data-also-pause]', (e) => e.checked);
    check(`bulkdelete @${t}: Library selection reaches the chapter cleanup warning`, picked && !!text);
    check(`bulkdelete @${t}: the warning names reading-position loss and starts with updates stopped`,
      text.includes(say('Deleting a chapter being read can lose its reading position.')) && paused, text);
    check(`bulkdelete @${t}: the warning has no sideways scroll`, await noSideScroll());
    await ctx.shot(`v558-bulkdelete-${t}-1-warning`);
    await tapText(page, say('Cancel'), '[role="dialog"]');
    await sleep(300);
  }

  if (lang() !== 'en') await setLang('en');
  let cancelRequested = false;
  let started = false;
  const requests = [];
  const run = () => ({
    id: 'v558-browser-run', status: 'running', startedAt: new Date().toISOString(), finishedAt: null,
    cancelRequested, pause: true, total: 1, done: 0,
    summary: { applied: 0, chapters: 0, bytes: 0, kept: 0, paused: 0, skipped: 0, failed: 0, chapterSkips: {} },
    results: [], error: null,
  });
  const intercept = async (request) => {
    const url = new URL(request.url());
    if (url.origin !== new URL(ctx.base).origin || !url.pathname.startsWith('/api/admin/series/bulk/chapters/delete')) {
      await request.continue(); return;
    }
    requests.push({ method: request.method(), path: url.pathname, body: request.postData() || '' });
    if (url.pathname.endsWith('/cancel')) {
      cancelRequested = true;
      await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    } else if (request.method() === 'POST') {
      started = true;
      await request.respond({ status: 202, contentType: 'application/json', body: JSON.stringify({ ok: true, runId: run().id, total: 1 }) });
    } else {
      await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ run: started ? run() : null }) });
    }
  };

  await page.setBypassServiceWorker(true);
  await page.setRequestInterception(true);
  page.on('request', intercept);
  try {
    console.log('\n  bulkdelete @1280, durable UI with non-destructive endpoint simulation');
    check('bulkdelete @1280: Library selection reaches the warning', await openWarning(1280, 'en'));
    await ctx.shot('v558-bulkdelete-1280-1-warning');
    const confirmed = await tapText(page, say('Delete chapters'), '[role="dialog"]');
    const progress = await waitFor(() => page.$('[data-bulk-delete-run="running"]'), 10_000, 150);
    check('bulkdelete @1280: 202 opens persisted-run progress rather than holding the request open', confirmed && !!progress);
    const start = requests.find((r) => r.method === 'POST' && !r.path.endsWith('/cancel'));
    let startBody = null; try { startBody = JSON.parse(start?.body || ''); } catch {}
    check('bulkdelete @1280: the run keeps the selected id and pause choice',
      startBody?.seriesIds?.length === 1 && startBody.pause === true, JSON.stringify(startBody));
    const progressText = await page.$eval('[data-bulk-delete-run]', (e) => e.textContent.replace(/\s+/g, ' ').trim());
    check('bulkdelete @1280: progress explains that closing or reloading does not stop cleanup',
      progressText.includes(say('This cleanup keeps running if you close this window or reload the page.')), progressText);
    await ctx.shot('v558-bulkdelete-1280-2-progress');

    await tapText(page, say('Close'), '[role="dialog"]');
    const reopen = await waitFor(() => page.$('[data-open-bulk-delete-run]'), 5000, 100);
    check('bulkdelete @1280: closing progress leaves a visible way back to the same run', !!reopen);
    await page.click('[data-open-bulk-delete-run]');
    check('bulkdelete @1280: the persistent row reopens progress',
      !!(await waitFor(() => page.$('[data-bulk-delete-run="running"]'), 5000, 100)));

    await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 });
    const recovered = await waitFor(() => page.$('[data-bulk-delete-run="running"]'), 10_000, 150);
    check('bulkdelete @1280: a full reload rejoins the remembered server run', !!recovered,
      await page.evaluate(() => localStorage.getItem('uchiyomi.bulkChapterDeleteRun')));
    await ctx.shot('v558-bulkdelete-1280-3-recovered');
    await page.click('[data-cancel-bulk-delete]');
    const stopping = await waitFor(() => page.$eval('[data-bulk-delete-run]', (e, text) => e.textContent.includes(text), say('Stopping…')), 5000, 100);
    check('bulkdelete @1280: Stop requests cancellation between series and the UI becomes Stopping',
      !!stopping && requests.some((r) => r.path.endsWith('/cancel')));
    await ctx.shot('v558-bulkdelete-1280-4-stopping');
    check('bulkdelete: no real deletion endpoint was reached; every run request was intercepted',
      requests.length >= 3 && requests.every((r) => r.path.startsWith('/api/admin/series/bulk/chapters/delete')),
      JSON.stringify(requests));
  } finally {
    await page.evaluate(() => localStorage.removeItem('uchiyomi.bulkChapterDeleteRun')).catch(() => {});
    await page.goto('about:blank').catch(() => {});
    page.off('request', intercept);
    await page.setRequestInterception(false).catch(() => {});
    await page.setBypassServiceWorker(false).catch(() => {});
  }
}
