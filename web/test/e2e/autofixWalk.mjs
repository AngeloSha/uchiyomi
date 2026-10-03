// walk49's "autofix" phase (v0.55.0): Health's Fix everything, the owner's "auto pick and fix stuff will try its best to
// fix everything and keeping everything green ... even if it had to add an extension itself to find a chapter ... and
// for auto it just shows at the end what happened and what it did in short", through the browser on the real routes.
//
// Needs the stack with the fake engine, the walk's own series on both fake sources and Gap Scans in the engine's
// repository (fakeSource.mjs and fakeEngine.mjs `v55`), under a source limit of one (Free a slot's case):
//   KEEP=1 E2E_ENGINE=fake E2E_FAKE_EXTRA=v55 E2E_MAX_SOURCES=1 E2E_MIN_FREE_GB=0 E2E_NO_WALK=1 E2E_NET=uchi-e2e-55 \
//     E2E_PORT=18155 E2E_SUBNET=10.222.55.0/24 bash web/test/e2e/up.sh
//   cd web && E2E_NET=uchi-e2e-55 BASE=http://127.0.0.1:18155 PHASES=autofix npm run test:e2e:v049
// E2E_NET names the instance (up.sh's network). What the API cannot make is written into the instance itself: a later
// split's copy of a chapter and an impossible chapter number are files copied inside the app's container
// (`docker exec <net> cp`, as the app's own user) and read by a library scan, then given the source that "sent" them;
// the AniList entry two copies share, a series' translation group and a failed chapter are rows of its database
// (`docker exec <net>-db psql`). up.sh points FLARESOLVERR_URL at a solver that does not exist: the solver is down.
//
// The library, every card of it something the run is to fix or to leave for a person:
//   1. a broken main source, fake-a (offline, its Test recording it), with Fix Backup on it following fake-b, and Fix
//      Search following nothing but listed by fake-b;
//   2. Twin Walk and Twin Walk Again, one series twice (one AniList entry, one language, the same twelve chapters), and
//      Edition Walk / Edición Walk, one series in English and Spanish;
//   3. chapter 5 of Twice Walk saved again later as fake-a's 5.1 and 5.2, shorter together than the 5 kept; and chapter 7
//      of Twice Short saved again as 7.1 and 7.2, LONGER together than the 7 kept (5 pages) -- that one is never deleted;
//   4. Odd Walk's chapter 9001, and Odd Mark's 7777, which somebody bookmarked -- never deleted;
//   5. Number Clean and Number Held, both waiting for a renumbering review by posting order; Number Held is linked to a
//      tracker, so its plan is not a clean one;
//   6. Gap Only's chapters 6 and 7, which no source in reach lists -- only Gap Scans, an extension not installed;
//   7. Fail Walk's chapter 4, failed three times;
//   8. and the solver down.
// Then, at 1280 in English, 390, and 390 in Arabic:
//   - Health before; Fix everything -> Fix it for me (the default) -> Start: the phases advance, Run in background and
//     the key reopen the run, and it ends;
//   - the end: "4 need you" (the solver, the bookmarked impossible number, the renumbering that is not clean, the copy
//     longer than the one kept) over "Everything else is green"; at most six lines of what it did, the rest under
//     Details; each Needs-you item with its key; no Run again; and Health with every other card green;
//   - on the server: Fix Backup and Fix Search moved to fake-b and fake-a turned off, the twins merged, the editions
//     linked, Twice Walk's later copy deleted and Twice Short's kept, Odd Walk's 9001 deleted and Odd Mark's kept, Number
//     Clean renumbered and Number Held waiting, Gap Scans installed, kept and switched on in English only, Gap Only
//     whole, Fail Walk's chapter 4 downloaded;
//   - Recent repairs lists the run with its headline; a second run at 390 stops at a safe point on Stop ("Stopping…");
//     a third, in Arabic, runs to its end; Let me choose runs the safe repair over a chapter that failed since; the
//     nightly's choice survives a reload; and Free a slot, on a series left over the source limit, opens that source's
//     sheet.
// Every view: no sideways scroll. walk49 counts the console errors and 5xx of the whole walk.
//
// Kept in its own module, as replaceWalk.mjs is. Screenshots: autofix-<pass>-<n>-<what>.png in walk49's OUT. LOOK at them.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { GAP_SCANS, SOURCE_IDS } from '../../../bff/test/fixtures/fakeSuwayomiEngine.mjs';

const AR = JSON.parse(readFileSync(new URL('../../public/locales/ar.json', import.meta.url), 'utf8'));
/** What the run leaves for a person, by Health card: everything else must end green. */
const NEEDS = ['solver', 'outliers', 'numbering', 'saved-twice'];
/** The series the walk adds, by fake source series id: [source, title, add options]. */
const ADDS = [
  ['fake-a', 'fix-backup', 'Fix Backup', { alsoFollow: [{ source: 'fake-b', sourceId: 'fix-backup' }] }],
  ['fake-a', 'fix-search', 'Fix Search', {}],
  ['fake-b', 'twin-walk', 'Twin Walk', {}],
  ['fake-b', 'twin-again', 'Twin Walk Again', {}],
  ['fake-b', 'edition-en', 'Edition Walk', {}],
  ['fake-b', 'edition-es', 'Edición Walk', {}],
  ['fake-b', 'twice-walk', 'Twice Walk', {}],
  ['fake-b', 'twice-short', 'Twice Short', {}],
  ['fake-b', 'odd-walk', 'Odd Walk', {}],
  ['fake-b', 'odd-mark', 'Odd Mark', {}],
  ['fake-b', 'num-clean', 'Number Clean', { numbering: 'source' }],
  ['fake-b', 'num-held', 'Number Held', { numbering: 'source' }],
  ['fake-b', 'gap-only', 'Gap Only', {}],
  ['fake-b', 'fail-walk', 'Fail Walk', { chapterCount: 3 }],
];

export async function autofixWalk({ page, go, shot: snap, check, waitFor, sleep, base, token }) {
  // A beat before each picture: the sheet and the bar ease into place.
  const shot = async (name) => { await sleep(700); await snap(name); };
  const ENGINE = process.env.ENGINE;
  const NET = process.env.E2E_NET;
  if (!ENGINE || !NET) {
    check('autofix: ENGINE and E2E_NET are set', false, 'up.sh with E2E_ENGINE=fake E2E_FAKE_EXTRA=v55 E2E_MAX_SOURCES=1, and E2E_NET=<its network> on the walk');
    return;
  }
  const appPort = Number(new URL(base).port || 80);
  const FAKE_A = `http://127.0.0.1:${20_000 + (appPort % 1000) * 2}`;
  const FAKE_B = `http://127.0.0.1:${20_000 + (appPort % 1000) * 2 + 1}`;
  const WT = SOURCE_IDS.webtoons;

  // ---- the API, the fakes and the instance ---------------------------------------------------------------------
  const call = async (path, o = {}) => {
    const r = await fetch(base + path, {
      method: o.method ?? (o.json ? 'POST' : 'GET'),
      headers: { authorization: `Bearer ${token}`, ...(o.json ? { 'content-type': 'application/json' } : {}) },
      body: o.json ? JSON.stringify(o.json) : undefined,
    });
    const raw = await r.text();
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    return { status: r.status, body };
  };
  const get = async (path) => {
    const r = await call(path);
    if (r.status >= 400) throw new Error(`GET ${path} -> ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    return r.body;
  };
  const send = async (method, path, json = {}) => {
    const r = await call(path, { method, json });
    if (r.status >= 400) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    return r.body;
  };
  const post = (path, json) => send('POST', path, json);
  const control = async (url, path, body) => {
    const r = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${url}${path} ${JSON.stringify(body)} -> ${r.status}`);
    return r.json();
  };
  const script = (url, chapter, behaviour) => control(url, '/__script', { chapter, page: 0, behaviour });
  const sql = (text) => execFileSync('docker', ['exec', `${NET}-db`, 'psql', '-U', 'postgres', '-d', 'yomi', '-tAqc', text], { encoding: 'utf8' }).trim();
  const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
  // The app's own user (up.sh starts it with PUID/PGID = ours), so the copy is the app's to delete.
  const uid = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  const copyIn = (from, to) => execFileSync('docker', ['exec', '-u', uid, NET, 'cp', from, to]);

  const allSeries = async () => (await post('/api/series/search', { query: '', size: 100 })).content ?? [];
  const idOf = async (title) => (await allSeries()).find((s) => s.name === title || s.metadata?.title === title)?.id ?? null;
  const health = () => get('/api/admin/health');
  /** The cards with a finding (an item that is not `info`), each with what it finds. */
  const findings = async () => Object.fromEntries((await health()).checks
    .filter((c) => c.status !== 'ok' && c.items.some((i) => !i.info))
    .map((c) => [c.id, c.items.filter((i) => !i.info).map((i) => i.title)]));
  const autofixState = () => get('/api/admin/health/autofix');

  // ---- words: the page's language, from its locale file (never a copy) ------------------------------------------
  let lang = 'en';
  const say = (key, vars = {}) => {
    const s = lang === 'ar' ? AR[key] : key;
    if (typeof s !== 'string') { check(`ar.json has "${key}"`, false); return '\u0000'; }
    return Object.entries(vars).reduce((out, [k, v]) => out.split(`{${k}}`).join(String(v)), s);
  };
  const setLang = async (l) => {
    lang = l;
    await send('PUT', '/api/settings', { lang: l });
    await page.evaluate((l) => localStorage.setItem('uchiyomi.lang', l), l);
  };

  // ---- the page ----------------------------------------------------------------------------------------------------
  const visit = async (path, wait = 2500) => {
    await go(path, wait);
    // The Health banner's one button, whatever the page's language (walk49's go() matches it in English).
    await page.evaluate(() => document.querySelector('[data-health-banner] button')?.click());
    if (await page.$('input[type=password]')) throw new Error(`${path} opened on the sign-in page`);
  };
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
  const click = (sel) => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  }, sel);
  /** The open sheet's panel: a phone's comes up from the bottom edge, a wide screen's stays inside it. */
  const sheetBox = () => page.evaluate(() => {
    const d = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].pop();
    const p = d?.firstElementChild;
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth, vh: innerHeight };
  });
  /** Fix everything's dialog as it reads: its view, and what that view shows. */
  const fix = () => page.evaluate(() => {
    const v = document.querySelector('[data-fix-view]');
    if (!v) return null;
    const attr = (sel, a) => document.querySelector(sel)?.getAttribute(a) ?? null;
    const text = (sel) => document.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
    return {
      view: v.getAttribute('data-fix-view'), run: v.getAttribute('data-fix-run'),
      mode: [...document.querySelectorAll('input[data-fix-mode]')].find((i) => i.checked)?.getAttribute('data-fix-mode') ?? null,
      cards: attr('[data-fix-cards]', 'data-fix-cards'),
      phase: attr('[data-fix-phase]', 'data-fix-phase'), phaseText: text('[data-fix-phase]'),
      bar: Number(attr('[role="progressbar"]', 'aria-valuenow') ?? NaN),
      step: text('[data-fix-step]'), now: text('[data-fix-now]') ?? text('[data-fix-waiting]'),
      stop: text('[data-fix-stop]'), stopDisabled: !!document.querySelector('[data-fix-stop]')?.disabled,
      headline: attr('[data-fix-headline]', 'data-fix-headline'), headlineText: text('[data-fix-headline]'), sub: text('[data-fix-headline-sub]'),
      done: [...document.querySelectorAll('[data-fix-done-list] [data-fix-done]')].map((d) => ({ kind: d.getAttribute('data-fix-done'), text: d.textContent.replace(/\s+/g, ' ').trim() })),
      needs: [...document.querySelectorAll('[data-fix-needs]')].map((n) => ({
        check: n.getAttribute('data-fix-needs'), key: n.querySelector('[data-fix-key]')?.getAttribute('data-fix-key') ?? null,
        text: n.querySelector('p')?.textContent?.trim() ?? '',
      })),
      clears: [...document.querySelectorAll('[data-fix-clears]')].map((c) => c.textContent.replace(/\s+/g, ' ').trim()),
      details: !!document.querySelector('[data-fix-details]'),
      keys: ['start', 'cancel', 'stop', 'background', 'again', 'close'].filter((k) => !!document.querySelector(`[data-fix-${k}]`)),
    };
  });
  const keyState = () => page.$eval('[data-fix-everything]', (b) => b.getAttribute('data-fix-everything')).catch(() => null);
  /** Health, and its Fix everything key pressed: resolves to the dialog once a view shows. */
  const openFix = async () => {
    await waitFor(() => page.$('[data-fix-everything]'), 30_000, 300);
    await click('[data-fix-everything]');
    return waitFor(fix, 15_000, 200);
  };
  const runDone = async (runId, ms = 600_000) => waitFor(async () => {
    const st = await autofixState();
    return !st.run && st.last?.id === runId ? st.last : null;
  }, ms, 1000);

  // ---- 0. the library ------------------------------------------------------------------------------------------------
  let mangadexOff = false;
  try {
    console.log('\n  autofix: the library');
    await Promise.all([control(FAKE_A, '/__reset', {}), control(FAKE_B, '/__reset', {})]);
    await control(ENGINE, '/__mode', { mode: 'up' });
    await Promise.all(['fake-a', 'fake-b'].flatMap((id) => [post(`/api/admin/sources/${id}/enable`), post(`/api/admin/sources/${id}/unblock`)]));
    // A real public site has no place in a run over fake series; put back at the end, as walk491 does.
    await post('/api/admin/sources/mangadex/disable');
    mangadexOff = true;
    // The rig's own read library: two series of local files, no source, updating by default -- "no source recorded" on
    // the frozen card of a fresh instance. Not this walk's; paused, as a person keeping such a series would.
    for (const s of await allSeries()) {
      if (s.name === 'Mixed Formats' || s.name === 'Repeated Pages') await send('PATCH', `/api/admin/series/${s.id}`, { autoUpdate: false });
    }
    // fake-b leaves Gap Only's 6 and 7 out; Twice Short's 7 has five pages; Twice Walk's 6 has four, which the walk copies
    // as the later split's 5.1 and 5.2 -- eight pages, under the twelve of the 5 kept.
    await script(FAKE_B, 'gap-only', 'omit:6-7');
    await script(FAKE_B, 'twice-short-7', 'short:5');
    await script(FAKE_B, 'twice-walk-6', 'short:4');
    for (const [source, sourceId, title, extra] of ADDS) {
      if (await idOf(title)) continue;
      await post('/api/sources/add', { source, sourceId, chapterFrom: 'oldest', autoUpdate: true, ...extra });
    }
    const added = await waitFor(async () => {
      const jobs = (await get('/api/sources/jobs')).content ?? [];
      if (jobs.some((j) => /downloading|queued|waiting/.test(j.status))) return null;
      const ids = {};
      for (const [, , title] of ADDS) ids[title] = await idOf(title);
      return Object.values(ids).every(Boolean) ? ids : null;
    }, 300_000, 2000);
    check('autofix: the walk\'s fourteen series were added', !!added, JSON.stringify((await get('/api/sources/jobs')).content?.map((j) => [j.title, j.status])));
    if (!added) throw new Error('no library to fix');
    const ID = added;
    const dir = (title) => `/library-dl/${title.startsWith('Fix ') ? 'fake-a' : 'fake-b'}/${title}`;

    // The later split's copies and the impossible numbers: files the scan reads, then the source that "sent" them.
    copyIn(`${dir('Twice Walk')}/Chapter 6.cbz`, `${dir('Twice Walk')}/Chapter 5.1.cbz`);
    copyIn(`${dir('Twice Walk')}/Chapter 6.cbz`, `${dir('Twice Walk')}/Chapter 5.2.cbz`);
    copyIn(`${dir('Twice Short')}/Chapter 8.cbz`, `${dir('Twice Short')}/Chapter 7.1.cbz`);
    copyIn(`${dir('Twice Short')}/Chapter 8.cbz`, `${dir('Twice Short')}/Chapter 7.2.cbz`);
    copyIn(`${dir('Odd Walk')}/Chapter 4.cbz`, `${dir('Odd Walk')}/Chapter 9001.cbz`);
    copyIn(`${dir('Odd Mark')}/Chapter 4.cbz`, `${dir('Odd Mark')}/Chapter 7777.cbz`);
    await post('/api/admin/library/scan', {});
    sql(`UPDATE lib_books SET source_id = 'fake-a' WHERE series_id IN (${lit(ID['Twice Walk'])}, ${lit(ID['Twice Short'])}) AND number IN (5.1, 5.2, 7.1, 7.2)`);
    const bookOf = (title, n) => sql(`SELECT id FROM lib_books WHERE series_id = ${lit(ID[title])} AND number = ${n} AND pruned_at IS NULL`);
    // The bookmark on 7777, through the reader's own route.
    await send('PUT', `/api/bookmarks/${encodeURIComponent(bookOf('Odd Mark', 7777))}/1`, {});
    // One AniList entry for each pair; a tracker on Number Held, which the renumbering would push numbers to.
    sql(`INSERT INTO series_trackers (series_id, provider, external_id) VALUES
           (${lit(ID['Twin Walk'])}, 'anilist', 'walk-twin'), (${lit(ID['Twin Walk Again'])}, 'anilist', 'walk-twin'),
           (${lit(ID['Edition Walk'])}, 'anilist', 'walk-edition'), (${lit(ID['Edición Walk'])}, 'anilist', 'walk-edition'),
           (${lit(ID['Number Held'])}, 'mal', 'walk-held') ON CONFLICT DO NOTHING`);
    await send('PATCH', `/api/admin/series/${ID['Edición Walk']}`, { lang: 'es' });
    // Gap Only's own translation group: what ranks Gap Scans first among the extensions to try (no site is named in code).
    sql(`UPDATE lib_books SET scanlator = 'Gap Scans' WHERE series_id = ${lit(ID['Gap Only'])}`);
    sql(`INSERT INTO chapter_failures (series_id, number, source_id, status, attempts, at)
           VALUES (${lit(ID['Fail Walk'])}, 4, 'fake-b', 'error', 3, now() - interval '1 hour') ON CONFLICT DO NOTHING`);
    // Both numbered-by-posting series handed to the detector, as walk49's numbering phase does: held for a review.
    for (const t of ['Number Clean', 'Number Held']) {
      await post(`/api/admin/series/${ID[t]}/numbering`, { mode: 'auto' });
      await post(`/api/admin/series/${ID[t]}/check`, {});
      await waitFor(async () => (await get(`/api/admin/series/${ID[t]}/check`)).running === false, 30_000, 1000);
    }
    const held = sql(`SELECT count(*) FROM lib_series WHERE id IN (${lit(ID['Number Clean'])}, ${lit(ID['Number Held'])}) AND numbering_pending = 'posting_order'`);
    check('autofix: Number Clean and Number Held wait for a renumbering review', held === '2', held);

    // fake-a goes the way aqua went: its own offline page, its Test recording it.
    await script(FAKE_A, 'site', 'offline');
    const tested = await call('/api/admin/sources/fake-a/test', { method: 'POST', json: {} });
    check('autofix: fake-a\'s Test says the site is offline', tested.body?.diagnosis?.code === 'site_offline', JSON.stringify(tested.body?.diagnosis ?? tested.body).slice(0, 200));

    const before = await findings();
    const expect = {
      sources: ['fake-a'], 'frozen-series': ['Fix Search'], duplicates: null, 'saved-twice': ['Twice Short', 'Twice Walk'],
      outliers: ['Odd Mark', 'Odd Walk'], numbering: ['Number Clean', 'Number Held'], 'chapter-gaps': ['Gap Only'], 'chapter-failures': null, solver: null,
    };
    for (const [c, titles] of Object.entries(expect)) {
      const got = before[c];
      check(`autofix: before the run, Health's ${c} card has its finding${titles ? `: ${titles.join(', ')}` : ''}`,
        !!got?.length && (!titles || titles.every((t) => got.some((x) => x.includes(t)))), JSON.stringify(got));
    }
    // v0.55.0 integration: an impossible number is the outliers card's, never a gap of thousands.
    check('autofix: ...and the impossible numbers are not gaps of thousands', !(before['chapter-gaps'] ?? []).some((t) => /Odd/.test(t)), JSON.stringify(before['chapter-gaps']));
    check('autofix: ...and nothing else has a finding', Object.keys(before).every((c) => c in expect), JSON.stringify(before));

    // ---- Health before, at the three widths
    for (const [w, l] of [[1280, 'en'], [390, 'en'], [390, 'ar']]) {
      await page.setViewport({ width: w, height: w < 1024 ? 844 : 900 });
      if (l !== lang) await setLang(l);
      await visit('/admin/?tab=Health', 4000);
      await waitFor(() => page.$('[data-fix-everything]'), 30_000, 300);
      check(`autofix @${w}${l === 'ar' ? ' ar' : ''}: Health has no sideways scroll`, await noSideScroll());
      await shot(`autofix-${w}${l === 'ar' ? 'ar' : ''}-0-health-before`);
    }
    await setLang('en');

    // ---- 1. Fix everything at 1280: Fix it for me, Start, the run, Run in background, the end ---------------------------
    console.log('\n  autofix @1280');
    await page.setViewport({ width: 1280, height: 900 });
    await visit('/admin/?tab=Health', 4000);
    const filled = await waitFor(() => page.$eval('[data-fix-everything]', (b) => (b.classList.contains('btn-key-primary') ? true : null)), 30_000, 300);
    check('autofix @1280: Fix everything is the filled key beside Re-check', !!filled);
    const ask = await openFix();
    check('autofix @1280: the dialog opens on the question, Fix it for me chosen', ask?.view === 'ask' && ask.mode === 'auto', JSON.stringify(ask));
    check(`autofix @1280: ...saying how many cards need a look (${Object.keys(before).length})`, Number(ask?.cards) === Object.keys(before).length, String(ask?.cards));
    await shot('autofix-1280-1-ask');
    await click('[data-fix-start]');
    const live = await waitFor(async () => { const f = await fix(); return f?.view === 'run' && f.run === 'running' && f.phase ? f : null; }, 30_000, 200);
    check('autofix @1280: Start shows the run: its phase, the bar and Stop', !!live && Number.isFinite(live.bar) && live.keys.includes('stop') && live.keys.includes('background'), JSON.stringify(live));
    await shot('autofix-1280-2-run');
    const runId = (await autofixState()).run?.id ?? null;
    check('autofix @1280: ...and the server has the run', !!runId);
    // The phases advance: what the dialog says over the next seconds.
    const phases = new Set(live?.phase ? [live.phase] : []);
    const bars = [live?.bar ?? 0];
    for (let i = 0; i < 24; i++) {
      await sleep(250);
      const f = await fix();
      if (f?.view !== 'run') break;
      if (f.phase) phases.add(f.phase);
      if (Number.isFinite(f.bar)) bars.push(f.bar);
    }
    // Run in background: the dialog goes, the key says it is running; pressed again, it is the run, never the question.
    await click('[data-fix-background]');
    const away = await waitFor(async () => (!(await page.$('[data-fix-view]')) ? true : null), 5000, 200);
    const keyRunning = await waitFor(async () => ((await keyState()) === 'running' ? true : null), 10_000, 300);
    check('autofix @1280: Run in background closes the dialog, and the key says it is running', !!away && !!keyRunning, String(await keyState()));
    const again = await openFix();
    const reopened = again?.view === 'run' || (again?.view === 'end' && !(await autofixState()).run);
    check('autofix @1280: ...and reopened, it is the run (or, finished meanwhile, its end), never the question', !!reopened, JSON.stringify(again));
    for (let i = 0; i < 400; i++) {
      const f = await fix();
      if (!f || f.view !== 'run') break;
      if (f.phase) phases.add(f.phase);
      if (Number.isFinite(f.bar)) bars.push(f.bar);
      await sleep(400);
    }
    check(`autofix @1280: the phases advanced (${[...phases].join(' → ')})`, phases.size >= 3, JSON.stringify([...phases]));
    check('autofix @1280: ...and the bar with them', bars.length > 1 && Math.max(...bars) > Math.min(...bars), JSON.stringify(bars.slice(0, 20)));
    const ended = runId ? await runDone(runId) : null;
    check('autofix @1280: the run ended, done', ended?.status === 'done', JSON.stringify(ended && { status: ended.status, summary: ended.summary }).slice(0, 600));
    const s = ended?.summary;

    // ---- the end, as the server says it and as the dialog shows it
    const needChecks = (s?.needsYou ?? []).map((n) => n.check).sort();
    check(`autofix @1280: Needs you is exactly ${NEEDS.join(', ')}`, JSON.stringify(needChecks) === JSON.stringify([...NEEDS].sort()), JSON.stringify(s?.needsYou));
    check('autofix @1280: ...the server calls everything else green, with nothing clearing by itself and nothing to run again',
      s?.green === true && (s?.clears ?? []).length === 0 && s?.again === false, JSON.stringify({ green: s?.green, again: s?.again, clears: s?.clears }));
    const end = await waitFor(async () => { const f = await fix(); return f?.view === 'end' ? f : null; }, 20_000, 300);
    check('autofix @1280: the dialog turns to the end', end?.view === 'end', JSON.stringify(end));
    check(`autofix @1280: the headline: "${say('{n} need you', { n: 4 })}" over "${say('Everything else is green')}"`,
      end?.headline === 'needs' && end.headlineText === say('{n} need you', { n: 4 }) && end.sub === say('Everything else is green'),
      JSON.stringify({ headline: end?.headline, text: end?.headlineText, sub: end?.sub }));
    check('autofix @1280: Needs you lists the four, each with its key', JSON.stringify((end?.needs ?? []).map((n) => n.check).sort()) === JSON.stringify([...NEEDS].sort())
      && (end?.needs ?? []).every((n) => !!n.key), JSON.stringify(end?.needs));
    check(`autofix @1280: at most six lines of what it did (${end?.done.length}), in the server's order`,
      !!end && end.done.length > 0 && end.done.length <= 6 && end.done.every((d, i) => d.kind === s?.done[i]?.kind), JSON.stringify(end?.done));
    const closed = await page.$eval('[data-fix-details] button[aria-expanded]', (b) => b.getAttribute('aria-expanded') === 'false').catch(() => false);
    check(`autofix @1280: ...the rest (${Math.max(0, (s?.done.length ?? 0) - 6)}) and the log under Details, closed`, !!end?.details && closed,
      JSON.stringify({ details: end?.details, closed, kinds: s?.done.map((d) => d.kind) }));
    check('autofix @1280: no Run again when nothing a run could change is left', !!end && !end.keys.includes('again') && end.keys.includes('close'), JSON.stringify(end?.keys));
    const doneKinds = (s?.done ?? []).map((d) => d.kind);
    for (const k of ['replaced', 'installed', 'merged', 'linked', 'renumbered', 'deletedTwice', 'deletedOdd', 'fetched', 'refetched']) {
      check(`autofix @1280: what it did says "${k}"`, doneKinds.includes(k), JSON.stringify(doneKinds));
    }
    check('autofix @1280: the end has no sideways scroll', await noSideScroll());
    await shot('autofix-1280-3-end');
    await click('[data-fix-details] button[aria-expanded]');
    await sleep(500);
    const log = await page.$$eval('[data-fix-log] li', (lis) => lis.map((l) => l.textContent.trim())).catch(() => []);
    check('autofix @1280: Details opens on the run\'s own lines', log.length > 0, JSON.stringify(log.slice(0, 5)));
    await shot('autofix-1280-3b-details');

    // ---- what it did, on the server
    const mainOf = async (id) => ((await get(`/api/series/${encodeURIComponent(id)}`)).sources ?? []).find((x) => x.primary)?.sourceId ?? null;
    check('autofix: Fix Backup and Fix Search moved off fake-a to fake-b', (await mainOf(ID['Fix Backup'])) === 'fake-b' && (await mainOf(ID['Fix Search'])) === 'fake-b',
      JSON.stringify([await mainOf(ID['Fix Backup']), await mainOf(ID['Fix Search'])]));
    const fa = (await get('/api/admin/sources/overview')).sources.find((x) => x.id === 'fake-a');
    check('autofix: ...and fake-a, with nothing left on it, is turned off', fa?.standing === 'off', JSON.stringify(fa && { standing: fa.standing, offBy: fa.offBy }));
    const merged = sql(`SELECT count(*) FROM lib_series WHERE id IN (${lit(ID['Twin Walk'])}, ${lit(ID['Twin Walk Again'])}) AND merged_into IS NOT NULL`);
    check('autofix: the twins are one series now', merged === '1', merged);
    const works = sql(`SELECT count(DISTINCT work_id) || ':' || count(work_id) FROM lib_series WHERE id IN (${lit(ID['Edition Walk'])}, ${lit(ID['Edición Walk'])})`);
    check('autofix: Edition Walk and Edición Walk are one work\'s two editions', works === '1:2', works);
    // `number` is a real: 5.1 is matched to within a hundredth, never by =.
    const pruned = (title, n) => sql(`SELECT pruned_at IS NOT NULL FROM lib_books WHERE series_id = ${lit(ID[title])} AND abs(number - ${n}) < 0.01`);
    check('autofix: Twice Walk\'s later copy (5.1, 5.2) is deleted, the 5 kept', pruned('Twice Walk', 5.1) === 't' && pruned('Twice Walk', 5.2) === 't' && pruned('Twice Walk', 5) === 'f');
    check('autofix: Twice Short\'s later copy, longer than the 7 kept, is not', pruned('Twice Short', 7.1) === 'f' && pruned('Twice Short', 7.2) === 'f');
    check('autofix: Odd Walk\'s 9001 is deleted; Odd Mark\'s bookmarked 7777 is not', pruned('Odd Walk', 9001) === 't' && pruned('Odd Mark', 7777) === 'f');
    const num = sql(`SELECT string_agg(title || '=' || COALESCE(numbering, '-') || '/' || COALESCE(numbering_pending, '-'), ' ' ORDER BY title) FROM lib_series WHERE id IN (${lit(ID['Number Clean'])}, ${lit(ID['Number Held'])})`);
    check('autofix: Number Clean is renumbered by posting order; Number Held still waits', num === 'Number Clean=posting_order/- Number Held=-/posting_order', num);
    const engine = await (await fetch(`${ENGINE}/__state`)).json();
    check('autofix: Gap Scans was installed, and kept', engine.extensions.find((e) => e.pkgName === GAP_SCANS.pkg)?.installed === true,
      JSON.stringify(engine.extensions.map((e) => [e.name, e.installed])));
    const langs = sql(`SELECT string_agg(source_id || '=' || enabled, ' ' ORDER BY source_id) FROM suwayomi_sources WHERE source_id IN (${lit(GAP_SCANS.en)}, ${lit(GAP_SCANS.es)})`);
    check('autofix: ...switched on in English only, the series\' language', langs === `${GAP_SCANS.en}=true ${GAP_SCANS.es}=false`, langs);
    const gapNums = sql(`SELECT string_agg(number::text, ',' ORDER BY number) FROM lib_books WHERE series_id = ${lit(ID['Gap Only'])} AND pruned_at IS NULL`);
    check('autofix: Gap Only is whole: chapters 6 and 7 came from Gap Scans', gapNums === '1,2,3,4,5,6,7,8,9,10,11,12', gapNums);
    const follows = ((await get(`/api/series/${encodeURIComponent(ID['Gap Only'])}`)).sources ?? []).map((x) => x.sourceId);
    check('autofix: ...which Gap Only now follows', follows.includes(`sw:${GAP_SCANS.en}`), JSON.stringify(follows));
    const failed = sql(`SELECT count(*) FROM chapter_failures WHERE series_id = ${lit(ID['Fail Walk'])}`) + '/' + sql(`SELECT count(*) FROM lib_books WHERE series_id = ${lit(ID['Fail Walk'])} AND number = 4 AND pruned_at IS NULL`);
    check('autofix: Fail Walk\'s chapter 4 downloaded, its failure gone', failed === '0/1', failed);
    const after = await findings();
    check(`autofix: Health after the run: only ${NEEDS.join(', ')} have a finding; every other card is green`,
      JSON.stringify(Object.keys(after).sort()) === JSON.stringify([...NEEDS].sort()), JSON.stringify(after));
    check('autofix: ...and Twice Short and Odd Mark are what is left on theirs', JSON.stringify(after['saved-twice']) === JSON.stringify(['Twice Short'])
      && JSON.stringify(after.outliers) === JSON.stringify(['Odd Mark']) && JSON.stringify(after.numbering) === JSON.stringify(['Number Held']), JSON.stringify(after));
    const ignored = sql('SELECT count(*) FROM health_ignored');
    check('autofix: nothing was ignored', ignored === '0', ignored);

    // ---- Close; Health after; Recent repairs lists the run
    await click('[data-fix-close]');
    await sleep(800);
    // Recent repairs, opened from its address (#repairs), as Server tasks' link opens it.
    await visit('/admin/?tab=Health#repairs', 4000);
    const history = await waitFor(() => page.$eval(`[data-repair-run="${runId}"] [data-fix-history-headline]`, (p) => ({ kind: p.getAttribute('data-fix-history-headline'), text: p.textContent.trim() })), 20_000, 500);
    if (history) await page.$eval(`[data-repair-run="${runId}"]`, (r) => r.scrollIntoView({ block: 'center' })).catch(() => {});
    await shot('autofix-1280-4b-recent-repairs');
    await page.evaluate(() => window.scrollTo(0, 0));
    check(`autofix @1280: Recent repairs lists the run with its headline ("${say('{n} need you', { n: 4 })}")`, history?.kind === 'needs' && history.text === say('{n} need you', { n: 4 }), JSON.stringify(history));
    check('autofix @1280: Health after has no sideways scroll', await noSideScroll());
    await shot('autofix-1280-4-health-after');

    // ---- 2. at 390: Health after, then a second run, stopped at a safe point -------------------------------------------
    console.log('\n  autofix @390');
    await page.setViewport({ width: 390, height: 844 });
    await visit('/admin/?tab=Health', 4000);
    check('autofix @390: Health has no sideways scroll', await noSideScroll());
    await shot('autofix-390-4-health-after');
    const ask390 = await openFix();
    check('autofix @390: the key opens the question again once the end was closed', ask390?.view === 'ask' && ask390.mode === 'auto', JSON.stringify(ask390));
    const sb = await sheetBox();
    check('autofix @390: ...as a sheet up from the bottom edge', !!sb && sb.bottom >= sb.vh - 1 && sb.top > 0, JSON.stringify(sb));
    check('autofix @390: the question has no sideways scroll', await noSideScroll());
    await shot('autofix-390-1-ask');
    await click('[data-fix-start]');
    const live390 = await waitFor(async () => { const f = await fix(); return f?.view === 'run' && f.run === 'running' && f.phase ? f : null; }, 30_000, 150);
    check('autofix @390: Start shows the run', !!live390, JSON.stringify(live390));
    check('autofix @390: the run has no sideways scroll', await noSideScroll());
    await shot('autofix-390-2-run');
    const second = (await autofixState()).run?.id ?? null;
    await click('[data-fix-stop]');
    const stopping = await waitFor(async () => { const f = await fix(); return f?.view === 'run' && f.stopDisabled && f.stop === say('Stopping…') ? f : (f?.view === 'end' ? f : null); }, 10_000, 100);
    check('autofix @390: Stop says Stopping… until the safe point', !!stopping, JSON.stringify(stopping));
    const stopped = second ? await runDone(second, 120_000) : null;
    check('autofix @390: the run stopped at a safe point, and says so in its log', stopped?.status === 'stopped'
      && (stopped.log ?? []).some((l) => l.code === 'autofix.item.skipped' && l.params?.why === 'stopped'), JSON.stringify(stopped && { status: stopped.status, log: stopped.log?.slice(-3) }));
    check('autofix @390: ...with nothing half done: Twice Short\'s copies and Odd Mark\'s 7777 are as they were',
      pruned('Twice Short', 7.1) === 'f' && pruned('Odd Mark', 7777) === 'f');
    const end390 = await waitFor(async () => { const f = await fix(); return f?.view === 'end' ? f : null; }, 20_000, 300);
    const stoppedNote = await page.evaluate((t) => [...document.querySelectorAll('[data-fix-view="end"] p')].some((p) => p.textContent?.trim() === t), say('Stopped before it finished'));
    // What it had not reached is the next run's, never a person's: Run again is offered, and Needs you holds nothing a
    // run could still fix (the solver is down whatever a run does).
    check('autofix @390: the end of a stopped run says it stopped, and offers Run again for what it left',
      !!end390 && stoppedNote && end390.keys.includes('again') && stopped?.summary?.again === true, JSON.stringify(end390 && { h: end390.headlineText, keys: end390.keys, again: stopped?.summary?.again }));
    check('autofix @390: ...its Needs you only what a run cannot fix', (stopped?.summary?.needsYou ?? []).every((n) => NEEDS.includes(n.check))
      && (stopped?.summary?.clears ?? []).some((c) => c.said.code === 'autofix.clears.nextRun'), JSON.stringify(stopped?.summary && { needs: stopped.summary.needsYou.map((n) => n.check), clears: stopped.summary.clears }));
    check('autofix @390: the end has no sideways scroll', await noSideScroll());
    await shot('autofix-390-3-end');
    await click('[data-fix-close]');
    await sleep(600);

    // ---- 3. in Arabic at 390: the question, a third run to its end, and the end ----------------------------------------
    console.log('\n  autofix @390 in Arabic');
    await setLang('ar');
    await visit('/admin/?tab=Health', 4000);
    const doc = await page.evaluate(() => ({ dir: document.documentElement.dir, lang: document.documentElement.lang }));
    check('autofix @390 ar: the page is Arabic, right to left', doc.dir === 'rtl' && doc.lang === 'ar', JSON.stringify(doc));
    await shot('autofix-390ar-4-health-after');
    const askAr = await openFix();
    check('autofix @390 ar: the question, Fix it for me chosen', askAr?.view === 'ask' && askAr.mode === 'auto', JSON.stringify(askAr));
    check('autofix @390 ar: no sideways scroll', await noSideScroll());
    await shot('autofix-390ar-1-ask');
    await click('[data-fix-start]');
    const liveAr = await waitFor(async () => { const f = await fix(); return f?.view === 'run' && f.run === 'running' && f.phase ? f : null; }, 30_000, 150);
    check('autofix @390 ar: Start shows the run', !!liveAr, JSON.stringify(liveAr));
    await shot('autofix-390ar-2-run');
    const third = (await autofixState()).run?.id ?? null;
    const done3 = third ? await runDone(third) : null;
    check('autofix @390 ar: the third run ended, done, leaving the same four', done3?.status === 'done'
      && JSON.stringify((done3.summary?.needsYou ?? []).map((n) => n.check).sort()) === JSON.stringify([...NEEDS].sort()), JSON.stringify(done3?.summary?.needsYou));
    const endAr = await waitFor(async () => { const f = await fix(); return f?.view === 'end' ? f : null; }, 20_000, 300);
    check(`autofix @390 ar: the end, in Arabic: "${say('{n} need you', { n: 4 })}" over "${say('Everything else is green')}"`,
      endAr?.headlineText === say('{n} need you', { n: 4 }) && endAr?.sub === say('Everything else is green'), JSON.stringify(endAr && { h: endAr.headlineText, sub: endAr.sub }));
    check('autofix @390 ar: no sideways scroll', await noSideScroll());
    await shot('autofix-390ar-3-end');
    await click('[data-fix-close]');
    await sleep(600);

    // ---- 4. Settings: the nightly's choice, at each width, and that it survives a reload --------------------------------
    for (const [w, l] of [[390, 'ar'], [390, 'en'], [1280, 'en']]) {
      if (l !== lang) await setLang(l);
      await page.setViewport({ width: w, height: w < 1024 ? 844 : 900 });
      await visit('/admin/?tab=Settings', 3500);
      const row = await waitFor(() => page.$('[data-nightly-mode]'), 20_000, 300);
      if (row) await page.$eval('[data-nightly-mode]', (e) => e.scrollIntoView({ block: 'center' }));
      check(`autofix @${w}${l === 'ar' ? ' ar' : ''}: Settings has the nightly's choice, Safe repair by default`,
        (await page.$eval('[data-nightly-mode]', (e) => e.getAttribute('data-nightly-mode')).catch(() => null)) === 'repair');
      check(`autofix @${w}${l === 'ar' ? ' ar' : ''}: Settings has no sideways scroll`, await noSideScroll());
      await shot(`autofix-${w}${l === 'ar' ? 'ar' : ''}-5-settings`);
    }
    const pick = (i) => page.evaluate((i) => { const r = document.querySelectorAll('[data-nightly-mode] [role="radio"]')[i]; r?.click(); return !!r; }, i);
    await pick(1);
    const saved = await waitFor(async () => ((await get('/api/admin/settings')).nightlyMode === 'autofix' ? true : null), 10_000, 300);
    check('autofix @1280: picking Fix everything saves it', !!saved);
    await page.reload({ waitUntil: 'networkidle2' }).catch(() => {});
    await sleep(2500);
    const kept = await waitFor(() => page.$eval('[data-nightly-mode]', (e) => (e.getAttribute('data-nightly-mode') === 'autofix'
      && e.querySelectorAll('[role="radio"]')[1]?.getAttribute('aria-checked') === 'true' ? true : null)).catch(() => null), 15_000, 300);
    check('autofix @1280: ...and it survives a reload', !!kept);
    await page.$eval('[data-nightly-mode]', (e) => e.scrollIntoView({ block: 'center' })).catch(() => {});
    await shot('autofix-1280-5b-settings-fix-everything');
    await pick(0);
    const back = await waitFor(async () => ((await get('/api/admin/settings')).nightlyMode === 'repair' ? true : null), 10_000, 300);
    check('autofix @1280: ...and Safe repair puts it back', !!back);

    // ---- 5. Let me choose runs the safe repair, over a chapter that failed since -----------------------------------------
    // A real failure: Fail Late added after the runs, its chapter 4 refused by fake-b (404) until the download gives up,
    // then served again -- Health's failures card has it, and Let me choose's safe repair (the repair, never Fix
    // everything) retries it.
    await script(FAKE_B, 'fail-late-4', '404');
    await post('/api/sources/add', { source: 'fake-b', sourceId: 'fail-late', chapterFrom: 'oldest', autoUpdate: true });
    const lateId = await waitFor(async () => {
      const id = await idOf('Fail Late');
      const jobs = (await get('/api/sources/jobs')).content ?? [];
      if (!id || jobs.some((j) => /downloading|queued|waiting/.test(j.status))) return null;
      return sql(`SELECT count(*) FROM chapter_failures WHERE series_id = ${lit(id)}`) !== '0' ? id : null;
    }, 120_000, 1000);
    check('autofix: Fail Late\'s chapter 4 failed', !!lateId);
    await script(FAKE_B, 'fail-late-4', 'ok');
    // Its refusals put fake-b in a cooldown, which the repair rightly waits out (`source_cooling_down`): its Test passes
    // again, and the admin's Clear block (the Test's canClear) lets the retry go now.
    await call('/api/admin/sources/fake-b/test', { method: 'POST', json: {} });
    await post('/api/admin/sources/fake-b/unblock', {});
    await visit('/admin/?tab=Health', 4000);
    const choose = await openFix();
    check('autofix: the question again, for Let me choose', choose?.view === 'ask', JSON.stringify(choose));
    await click('input[data-fix-mode="manual"]');
    await sleep(300);
    check('autofix: Let me choose can start the safe repair', await page.$eval('[data-fix-start]', (b) => !b.disabled).catch(() => false));
    await shot('autofix-1280-6-let-me-choose');
    const runsBefore = new Set(((await get('/api/admin/tasks/repair/runs?limit=10')).content ?? []).map((r) => r.id));
    await click('[data-fix-start]');
    const repairRun = await waitFor(async () => {
      const r = ((await get('/api/admin/tasks/repair/runs?limit=10')).content ?? []).find((x) => !runsBefore.has(x.id));
      return r && r.status !== 'running' ? r : null;
    }, 120_000, 1000);
    check('autofix: Let me choose ran the safe repair, not Fix everything', !!repairRun && repairRun.kind !== 'autofix'
      && (await autofixState()).last?.id === third, JSON.stringify(repairRun && { kind: repairRun.kind, only: repairRun.only, status: repairRun.status }));
    check('autofix: ...and closed the dialog', !(await page.$('[data-fix-view]')));
    const lateNow = lateId ? sql(`SELECT count(*) FROM chapter_failures WHERE series_id = ${lit(lateId)}`) + '/'
      + sql(`SELECT count(*) FROM lib_books WHERE series_id = ${lit(lateId)} AND number = 4 AND pruned_at IS NULL`) : null;
    check('autofix: ...which fetched Fail Late\'s chapter 4', lateNow === '0/1', String(lateNow));

    // ---- 6. Free a slot: a series left over the source limit opens its source's sheet ----------------------------------
    // Under a limit of one, Gap Scans' English source holds the slot. Webtoons.com switched on and some series reading
    // through it: the registration puts the used sources first, in the engine's order, and Webtoons.com is the one over.
    await call(`/api/admin/extensions/sources/${WT}`, { method: 'POST', json: { enabled: true } });
    const lib = sql(`SELECT library_id FROM lib_series WHERE id = ${lit(ID['Gap Only'])}`);
    sql(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
           VALUES ('s_walk_slot', 'Webtoons.com', 'Slot Walk', 'Webtoons.com/Slot Walk', 0, ${lit(lib)}, ${lit(`sw:${WT}`)},
                   '/en/drama/walk-webtoon/list?title_no=5501', true) ON CONFLICT (id) DO NOTHING`);
    await post('/api/admin/sources/reload', {});
    await visit('/admin/?tab=Health', 4000);
    await waitFor(() => page.$('[data-health-check="frozen-series"]'), 30_000, 300);
    await page.evaluate(() => document.querySelector('[data-health-check="frozen-series"] button')?.click());
    const slot = await waitFor(() => page.evaluate(() => {
      const row = [...document.querySelectorAll('[data-health-check="frozen-series"] [data-health-item]')].find((r) => r.textContent?.includes('Slot Walk'));
      const key = row?.querySelector('[data-health-action="free_slot"]');
      if (!key) return null;
      key.scrollIntoView({ block: 'center' });
      return { label: key.textContent.trim() };
    }), 20_000, 400);
    check('autofix: Slot Walk, over the source limit, offers Free a slot', slot?.label === say('Free a slot'), JSON.stringify(slot));
    await shot('autofix-1280-7-free-slot');
    await page.evaluate(() => [...document.querySelectorAll('[data-health-check="frozen-series"] [data-health-item]')]
      .find((r) => r.textContent?.includes('Slot Walk'))?.querySelector('[data-health-action="free_slot"]')?.click());
    const landed = await waitFor(() => page.evaluate((id) => (new URL(location.href).searchParams.get('tab') === 'Sources'
      && !!document.querySelector(`[data-source-sheet="${id}"]`) ? location.href : null), `sw:${WT}`), 30_000, 400);
    check('autofix: Free a slot opens Admin → Sources on Webtoons.com\'s sheet', !!landed, String(await page.evaluate(() => location.href)));
    await shot('autofix-1280-8-free-slot-sheet');
  } finally {
    if (lang !== 'en') await setLang('en').catch(() => {});
    if (mangadexOff) await call('/api/admin/sources/mangadex/enable', { method: 'POST', json: {} }).catch(() => {});
  }
}
