// walk49's "replace" phase (v0.54.0): the owner's two asks, through the browser on the real routes -- "one Sources tab",
// and Replace moving a broken source's series to working sources in one press.
//
// Needs the stack with the fake engine and the walk's own series on both fake sources (fakeSource.mjs `v54`):
//   KEEP=1 E2E_ENGINE=fake E2E_FAKE_EXTRA=v54 E2E_MIN_FREE_GB=0 E2E_NO_WALK=1 E2E_NET=uchi-e2e-54 E2E_PORT=18154 \
//     E2E_SUBNET=10.222.54.0/24 bash web/test/e2e/up.sh
//   cd web && E2E_NET=uchi-e2e-54 BASE=http://127.0.0.1:18154 PHASES=replace npm run test:e2e:v049
// E2E_NET names the instance (up.sh's network): two things the API has no way to make are written into the instance's
// own database (`docker exec <net>-db psql`) -- a series numbered by posting order that still follows a source, as one
// renumbered after it followed one is, and a site added by address that is some series' main source.
//
// Three passes -- 390, 1280, and 390 in Arabic -- each with four series of its own, added from fake-a: Swap Follow and
// Swap Main follow fake-b, Swap Posting follows fake-b and is numbered by posting order, Swap Search follows nothing.
// fake-a then serves only its offline page (its Test records it) and is switched off: the owner's aqua. Then:
//   1. Admin → Sources: Needs attention has fake-a with Replace, the filled key, and "N already have a working backup",
//      the overview's numbers; the failing source nothing uses (the engine's Manga Ball, its search failing) has its row.
//   2. Health → Source health: fake-a's one key is Replace.
//   3. fake-a's sheet: Replace, Test and Turn on. Turn on switches it back on -- still failing, offline -- so that
//      "Turn it off when done" has something to do.
//   4. Swap Main's Sources sheet: Make main on fake-b asks first, in one line, then moves it.
//   5. Replace: the dialog says the preview's numbers (GET …/replace-preview), with Turn it off when done on; Start. Swap
//      Follow moves at once -- the API reads its new main while the run still searches for Swap Search, fake-b's search
//      held 16 s -- and the counts and the rows "from → to" show. Run in background, then Replace again from the row,
//      and again after a reload: the run, never the ask view. It ends: 1 moved, 1 new source found, 1 with no
//      replacement (Swap Posting), so one series is left and fake-a stays on.
//   6. Swap Posting's Sources sheet: Make main is refused, in words.
//   7. Swap Posting numbered by its source again: Replace again moves it, nothing is left, and fake-a is turned off.
//   8. Turn off all asks first, inside its row, then switches each failing source nothing uses off.
//   9. A site added by address that is some series' main source: its Remove is refused, in words.
//  10. The old tabs' addresses: ?tab=Providers and ?tab=Extensions open Sources; card=mangadex opens Add sources on
//      MangaDex's languages; settings=<id> opens that source's sheet on its settings.
// Every page and sheet it opens: no sideways scroll. walk49 counts the console errors and 5xx of the whole walk.
//
// Kept in its own module, as engineWalk.mjs is: walk49.mjs changes by a few lines, and hands over its page and helpers.
// Screenshots: replace-<pass>-<n>-<what>.png in walk49's OUT. LOOK at them.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { SOURCE_IDS } from '../../../bff/test/fixtures/fakeSuwayomiEngine.mjs';

const AR = JSON.parse(readFileSync(new URL('../../public/locales/ar.json', import.meta.url), 'utf8'));
const ROLES = ['follow', 'main', 'posting', 'search'];
const cap = (w) => w[0].toUpperCase() + w.slice(1);
const SITE_NAME = 'Walk Site';

export async function replaceWalk({ page, go, shot: snap, check, waitFor, sleep, base, token }) {
  // A beat before each picture: the run's bar and the sheets ease into place, and a shot taken at once caught them
  // half-way (a finished run's bar read a third full).
  const shot = async (name) => { await sleep(700); await snap(name); };
  const ENGINE = process.env.ENGINE;
  const NET = process.env.E2E_NET;
  if (!ENGINE || !NET) {
    check('replace: ENGINE and E2E_NET are set', false, 'up.sh with E2E_ENGINE=fake E2E_FAKE_EXTRA=v54, and E2E_NET=<its network> on the walk');
    return;
  }
  const appPort = Number(new URL(base).port || 80);
  const FAKE_A = `http://127.0.0.1:${20_000 + (appPort % 1000) * 2}`;
  const FAKE_B = `http://127.0.0.1:${20_000 + (appPort % 1000) * 2 + 1}`;
  const MB = `sw:${SOURCE_IDS.mangaBall}`;

  // ---- the API, the fakes and the instance's database ----------------------------------------------------------
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
  const post = async (path, json = {}) => {
    const r = await call(path, { method: 'POST', json });
    if (r.status >= 400) throw new Error(`POST ${path} -> ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    return r.body;
  };
  const control = async (url, path, body) => {
    const r = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${url}${path} ${JSON.stringify(body)} -> ${r.status}`);
    return r.json();
  };
  const script = (url, chapter, behaviour) => control(url, '/__script', { chapter, page: 0, behaviour });
  const engineMode = (m) => control(ENGINE, '/__mode', m);
  const sql = (text) => execFileSync('docker', ['exec', `${NET}-db`, 'psql', '-U', 'postgres', '-d', 'yomi', '-tAqc', text], { encoding: 'utf8' }).trim();
  const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

  const overview = () => get('/api/admin/sources/overview');
  const sourceRow = async (id) => (await overview()).sources.find((s) => s.id === id) ?? null;
  const findState = () => get('/api/admin/sources/find');
  const allSeries = async () => (await post('/api/series/search', { query: '', size: 100 })).content ?? [];
  const seriesNamed = async (title) => (await allSeries()).find((s) => s.name === title || s.metadata?.title === title) ?? null;
  const sourcesOf = async (id) => (await get(`/api/series/${encodeURIComponent(id)}`)).sources ?? [];
  const mainOf = async (id) => (await sourcesOf(id)).find((s) => s.primary)?.sourceId ?? null;

  // ---- words: the page's language, from its locale file (never a copy) ------------------------------------------
  let lang = 'en';
  const say = (key, vars = {}) => {
    const s = lang === 'ar' ? AR[key] : key;
    if (typeof s !== 'string') { check(`ar.json has "${key}"`, false); return '\u0000'; }
    return Object.entries(vars).reduce((out, [k, v]) => out.split(`{${k}}`).join(String(v)), s);
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
  const closeDialogs = async () => {
    for (let i = 0; i < 3 && (await page.$('[role="dialog"]')); i++) {
      await page.keyboard.press('Escape');
      await sleep(400);
    }
  };
  /** The open sheet's panel: a phone's comes up from the bottom edge, a wide screen's stays inside it. */
  const sheetBox = () => page.evaluate(() => {
    const d = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].pop();
    const p = d?.firstElementChild;
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth, vh: innerHeight };
  });
  /** The Replace dialog as it reads: its phase, the numbers it says, its keys, and what the run shows. */
  const dialog = () => page.evaluate(() => {
    const d = document.querySelector('[data-replace-dialog]');
    if (!d) return null;
    const num = (t) => Number(String(t ?? '').replace(/[^\d]/g, '') || NaN);
    return {
      source: d.getAttribute('data-replace-dialog'), phase: d.getAttribute('data-replace-phase'), run: d.getAttribute('data-replace-run'),
      main: document.querySelector('[data-replace-main]')?.getAttribute('data-replace-main') ?? null,
      subtitle: document.querySelector('[data-replace-main]')?.textContent ?? '',
      lines: [...d.querySelectorAll('[data-replace-plan] li[data-replace-line]')].map((li) => ({
        kind: li.getAttribute('data-replace-line'), n: li.hasAttribute('data-n') ? Number(li.getAttribute('data-n')) : null,
        text: li.querySelector('span.min-w-0')?.textContent ?? '',
      })),
      turnOff: d.querySelector('[data-replace-turnoff]')?.checked ?? null,
      review: d.querySelector('[data-replace-review]')?.checked ?? null,
      start: (() => { const b = document.querySelector('[data-replace-start]'); return b ? !b.disabled : null; })(),
      counts: Object.fromEntries([...d.querySelectorAll('[data-replace-count]')].map((c) => [c.getAttribute('data-replace-count'), num(c.querySelector('dd')?.textContent)])),
      rows: [...d.querySelectorAll('li[data-replace-row]')].map((li) => ({
        id: li.getAttribute('data-replace-row'), state: li.getAttribute('data-replace-row-state'),
        names: [...li.querySelectorAll('span[aria-hidden] bdi')].map((b) => b.textContent), text: li.innerText.replace(/\s+/g, ' ').trim(),
      })),
      outcome: d.querySelector('[data-replace-outcome]')?.textContent ?? null,
      progress: d.querySelector('[data-replace-progress]')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      keys: ['start', 'cancel', 'stop', 'background', 'results', 'again', 'close'].filter((k) => !!document.querySelector(`[data-replace-${k}]`)),
    };
  });
  const attentionRow = (id) => page.evaluate((id) => {
    const r = document.querySelector(`[data-sources-attention-row="replace"][data-source-id="${id}"]`);
    if (!r) return null;
    const key = r.querySelector(`[data-sources-replace="${id}"]`);
    return { main: Number(r.getAttribute('data-main')), backup: Number(r.getAttribute('data-with-backup')), text: r.innerText.replace(/\s+/g, ' ').trim(), filled: !!key?.classList.contains('btn-key-primary') };
  }, id);
  /** Open the Replace dialog from fake-a's Needs attention row; resolves to the dialog once its phase shows. */
  const openReplace = async () => {
    if (!(await waitFor(() => click('[data-sources-replace="fake-a"]'), 20_000, 300))) return null;
    return waitFor(async () => { const d = await dialog(); return d?.phase === 'run' || (d?.phase === 'ask' && (d.main !== null || d.lines.length)) ? d : null; }, 15_000, 200);
  };
  /** A series' Sources & translations sheet, from the supply line under its title. */
  const openSourcesSheet = async (id) => {
    await visit(`/series/?id=${encodeURIComponent(id)}`, 2500);
    await page.evaluate(() => [...document.querySelectorAll('button[aria-haspopup="dialog"]')].find((b) => b.offsetParent && b.classList.contains('w-full'))?.click());
    return !!(await waitFor(() => page.$('[role="dialog"] [data-alt-titles]'), 15_000));
  };
  const healthRowKey = async (id) => {
    await visit('/admin/?tab=Health', 3000);
    const card = await page.waitForSelector('[data-health-check="sources"]', { timeout: 45_000 }).catch(() => null);
    if (!card) return { key: null, why: 'no Source health card' };
    if (!(await page.$('#health-sources-details'))) await click('[data-health-check="sources"] button');
    const row = `[data-health-check="sources"] [data-source-row="${id}"]`;
    // A switched-off source is in the "Switched off by you" fold, closed until opened.
    if (!(await waitFor(() => page.$(row), 10_000, 300))) {
      await page.evaluate(() => document.querySelectorAll('[data-health-check="sources"] [data-source-fold] > button[aria-expanded="false"]').forEach((b) => b.click()));
    }
    const key = await waitFor(() => page.$eval(`${row} button[data-health-primary]`, (b) => b.getAttribute('data-health-action')), 15_000, 300);
    await page.$eval(row, (el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
    return { key, why: key ? '' : await page.$eval('[data-health-check="sources"]', (el) => el.innerText.slice(0, 400)).catch(() => '') };
  };

  // ---- one pass ------------------------------------------------------------------------------------------------------
  async function pass({ key, width, arabic }) {
    const tag = `replace-${key}`;
    console.log(`\n  replace @${width}${arabic ? ' in Arabic' : ''}`);
    await page.setViewport({ width, height: width < 1024 ? 844 : 900 });
    const phone = width < 1024;
    const title = (role) => `Swap ${cap(role)} ${cap(key)}`;
    const sid = (role) => `swap-${role}-${key}`;

    // -- the library: four series from fake-a, while it answers
    await script(FAKE_A, 'site', 'ok');
    await script(FAKE_B, 'search', 'ok');
    await post('/api/admin/sources/fake-a/enable');
    await post('/api/admin/sources/fake-a/unblock');
    await call('/api/admin/sources/fake-a/test', { method: 'POST', json: {} });
    const ids = {};
    for (const role of ROLES) {
      let s = await seriesNamed(title(role));
      if (!s) {
        await post('/api/sources/add', {
          source: 'fake-a', sourceId: sid(role), chapterCount: 1, chapterFrom: 'oldest', autoUpdate: true,
          ...(role === 'search' ? {} : { alsoFollow: [{ source: 'fake-b', sourceId: sid(role) }] }),
        });
        s = await waitFor(() => seriesNamed(title(role)), 120_000, 1000);
      }
      ids[role] = s?.id ?? null;
    }
    check(`${tag}: its four series were added from fake-a`, ROLES.every((r) => ids[r]), JSON.stringify(ids));
    if (!ROLES.every((r) => ids[r])) throw new Error('no series to replace');
    const follows = await waitFor(async () => {
      for (const r of ['follow', 'main', 'posting']) if (!(await sourcesOf(ids[r])).some((s) => s.sourceId === 'fake-b')) return null;
      return true;
    }, 120_000, 1000);
    check(`${tag}: Swap Follow, Swap Main and Swap Posting follow fake-b; Swap Search follows nothing`,
      !!follows && !(await sourcesOf(ids.search)).some((s) => s.sourceId !== 'fake-a'), JSON.stringify(await sourcesOf(ids.search)));
    await waitFor(async () => !((await get('/api/sources/jobs')).content ?? []).some((j) => /downloading|queued|waiting/.test(j.status)), 120_000, 1000);
    // Numbered by posting order after it followed fake-b, as a series renumbered on review is: the API refuses a follow
    // to such a series, so the state is written where the renumber would have written it.
    sql(`UPDATE lib_series SET numbering = 'posting_order' WHERE id = ${lit(ids.posting)}`);

    // -- fake-a goes the way aqua went: its own offline page, its Test recording it, then switched off
    await script(FAKE_A, 'site', 'offline');
    const tested = await call('/api/admin/sources/fake-a/test', { method: 'POST', json: {} });
    check(`${tag}: fake-a's Test says the site is offline`, tested.body?.diagnosis?.code === 'site_offline', JSON.stringify(tested.body?.diagnosis ?? tested.body).slice(0, 300));
    await post('/api/admin/sources/fake-a/disable');

    // -- a failing source nothing uses: the engine's Manga Ball, its search failing
    await get('/api/admin/extensions/status');
    const mbWas = await sourceRow(MB);
    if (mbWas?.offBy === 'admin') await post(`/api/admin/sources/${encodeURIComponent(MB)}/enable`);
    else if (mbWas && mbWas.standing !== 'usable') await post('/api/admin/extensions/sources/bulk', { ids: [SOURCE_IDS.mangaBall], enabled: true });
    await engineMode({ mode: 'extension_error', source: SOURCE_IDS.mangaBall, stage: 'search' });
    await call(`/api/admin/sources/${encodeURIComponent(MB)}/test`, { method: 'POST', json: {} });
    await engineMode({ mode: 'up' });
    const ready = await waitFor(async () => {
      const o = await overview();
      return o.attention.replace.includes('fake-a') && o.attention.failingUnused.includes(MB) ? o : null;
    }, 30_000, 1000);
    check(`${tag}: the overview needs a look at fake-a (Replace) and at Manga Ball (failing, used by nothing)`, !!ready,
      JSON.stringify((await overview()).attention));

    if (arabic) {
      lang = 'ar';
      await call('/api/settings', { method: 'PUT', json: { lang: 'ar' } });
      await page.evaluate(() => localStorage.setItem('uchiyomi.lang', 'ar'));
    }
    try {
      // ---- 1. Admin → Sources: Needs attention
      await visit('/admin/?tab=Sources', 3000);
      if (arabic) {
        const doc = await page.evaluate(() => ({ dir: document.documentElement.dir, lang: document.documentElement.lang }));
        check(`${tag}: the page is Arabic, right to left`, doc.dir === 'rtl' && doc.lang === 'ar', JSON.stringify(doc));
      }
      const fa = await sourceRow('fake-a');
      const row = await waitFor(() => attentionRow('fake-a'), 30_000, 300);
      check(`${tag}: Needs attention has fake-a, with Replace as its filled key`, !!row?.filled, JSON.stringify(row));
      check(`${tag}: ...main source of 4 series, 2 with a working backup: the overview's numbers`,
        row?.main === fa?.main && row?.backup === fa?.withBackup && fa?.main === 4 && fa?.withBackup === 2, JSON.stringify({ row, main: fa?.main, withBackup: fa?.withBackup }));
      check(`${tag}: ...said in words: "${say('{n} already have a working backup', { n: 2 })}"`,
        !!row?.text.includes(say('{n} already have a working backup', { n: 2 })) && !!row?.text.includes(say('main source of {n} series', { n: 4 })), row?.text);
      const unused = await page.$eval('[data-sources-attention-row="failing-unused"]', (r) => r.innerText.replace(/\s+/g, ' ')).catch(() => null);
      check(`${tag}: ...and the failing sources nothing uses, Manga Ball among them, with Turn off all`,
        !!unused?.includes('Manga Ball') && !!(await page.$('[data-sources-attention-row="failing-unused"] [data-source-bulk-off]')), String(unused));
      check(`${tag}: Admin → Sources has no sideways scroll`, await noSideScroll());
      await shot(`${tag}-1-sources`);

      // ---- 2. Health: Replace is the key on the broken main source
      const health = await healthRowKey('fake-a');
      check(`${tag}: Health -> Source health: fake-a's one key is Replace`, health.key === 'replace_source', JSON.stringify(health));
      check(`${tag}: Health has no sideways scroll`, await noSideScroll());
      await shot(`${tag}-2-health`);

      // ---- 3. fake-a's sheet, and Turn on
      await visit('/admin/?tab=Sources', 3000);
      await waitFor(() => click('[data-sources-attention-row="replace"][data-source-id="fake-a"] [data-sources-open]'), 15_000, 300);
      const sheet = await waitFor(() => page.evaluate(() => {
        const s = document.querySelector('[data-source-sheet="fake-a"]');
        return s ? { keys: [...s.querySelectorAll('[data-source-keys] [data-source-key]')].map((k) => k.getAttribute('data-source-key')),
          filled: !!s.querySelector('[data-source-key="replace"].btn-key-primary'), status: s.querySelector('[data-source-status]')?.textContent ?? '' } : null;
      }), 15_000, 300);
      check(`${tag}: fake-a's sheet offers Replace (filled), Test and Turn on`, JSON.stringify(sheet?.keys) === JSON.stringify(['replace', 'test', 'turn-on']) && !!sheet?.filled, JSON.stringify(sheet));
      if (phone) { const b = await sheetBox(); check(`${tag}: ...as a sheet up from the bottom edge`, !!b && b.bottom >= b.vh - 1 && b.top > 0, JSON.stringify(b)); }
      check(`${tag}: the sheet has no sideways scroll`, await noSideScroll());
      await shot(`${tag}-3-sheet`);
      await click('[data-source-sheet="fake-a"] [data-source-key="turn-on"]');
      const on = await waitFor(async () => { const s = await sourceRow('fake-a'); return s && s.standing !== 'off' ? s : null; }, 15_000, 500);
      const still = (await overview()).attention.replace.includes('fake-a');
      check(`${tag}: Turn on switches fake-a back on, still failing (offline), still to replace`, on?.standing === 'failing' && still, JSON.stringify({ standing: on?.standing, still }));
      await closeDialogs();

      // ---- 4. Make main on Swap Main's follower
      check(`${tag}: Swap Main's Sources sheet opens`, await openSourcesSheet(ids.main));
      await waitFor(() => click('[role="dialog"] [data-make-main="fake-b"]'), 15_000, 300);
      const q = await waitFor(() => page.$eval('[data-make-main-confirm="fake-b"] p', (p) => p.textContent), 5000, 200);
      check(`${tag}: Make main asks first, in one line: fake-b the main source, fake-a dropped (it is failing)`,
        q === say('Make {name} this series’ main source? {old} is dropped.', { name: '⁨fake-b⁩', old: '⁨fake-a⁩' }), String(q));
      check(`${tag}: the Sources sheet has no sideways scroll`, await noSideScroll());
      await shot(`${tag}-4-make-main-ask`);
      await click('[data-make-main-confirm="fake-b"] [data-make-main-yes]');
      const madeMain = await waitFor(async () => ((await mainOf(ids.main)) === 'fake-b' ? true : null), 15_000, 500);
      const left = await sourcesOf(ids.main);
      check(`${tag}: ...and Make main moved Swap Main to fake-b, fake-a dropped`, !!madeMain && !left.some((s) => s.sourceId === 'fake-a'), JSON.stringify(left.map((s) => [s.sourceId, s.primary])));
      const shown = await waitFor(() => page.evaluate(() => !document.querySelector('[role="dialog"] [data-make-main="fake-b"]') || null), 10_000, 300);
      check(`${tag}: ...and the sheet shows fake-b as the main source, with no Make main on it`, !!shown);
      await closeDialogs();

      // ---- 5. Replace: the preview's numbers, Start, the run, Run in background and back
      await visit('/admin/?tab=Sources', 3000);
      const preview = await get('/api/admin/sources/fake-a/replace-preview');
      check(`${tag}: the preview: 3 series, 1 with a working backup, 1 to search, 1 numbered by posting order`,
        preview.main === 3 && preview.withBackup === 1 && preview.toSearch === 1 && preview.postingOrder === 1 && preview.busy === false, JSON.stringify(preview));
      const ask = await openReplace();
      check(`${tag}: Replace opens the dialog on its plan`, ask?.phase === 'ask' && ask?.source === 'fake-a', JSON.stringify(ask));
      check(`${tag}: ...its numbers are the preview's`, Number(ask?.main) === preview.main
        && JSON.stringify(ask?.lines.map((l) => [l.kind, l.n])) === JSON.stringify([['backup', preview.withBackup], ['search', preview.toSearch], ['posting', preview.postingOrder], ['off', null]]),
        JSON.stringify(ask?.lines));
      check(`${tag}: ...in words: "${say('{n} series use it as their main source', { n: 3 })}"`, ask?.subtitle === say('{n} series use it as their main source', { n: 3 })
        && ask?.lines[0]?.text === say('1 already follows a working source: it becomes its main source.')
        && ask?.lines[2]?.text === say('1 numbered by posting order stays as it is.'), JSON.stringify(ask && { subtitle: ask.subtitle, lines: ask.lines }));
      check(`${tag}: ...Turn it off when done on, review first off, Start ready`, ask?.turnOff === true && ask?.review === false && ask?.start === true, JSON.stringify(ask));
      if (phone) { const b = await sheetBox(); check(`${tag}: ...a sheet up from the bottom edge`, !!b && b.bottom >= b.vh - 1 && b.top > 0, JSON.stringify(b)); }
      check(`${tag}: the dialog has no sideways scroll`, await noSideScroll());
      await shot(`${tag}-5-ask`);

      // Swap Search is searched for: fake-b's search is held, so the run is seen going.
      await script(FAKE_B, 'search', 'slow:16000');
      const before = (await findState()).run?.id ?? null;
      await click('[data-replace-start]');
      const started = await waitFor(async () => { const s = await findState(); return s.running && s.run && s.run.id !== before ? s.run : null; }, 15_000, 250);
      check(`${tag}: Start starts a Replace run over fake-a's 3 series`, started?.mode === 'replace' && started?.total === 3 && started?.sourceId === 'fake-a', JSON.stringify(started && { mode: started.mode, total: started.total, sourceId: started.sourceId }));
      const movedAtOnce = await waitFor(async () => ((await mainOf(ids.follow)) === 'fake-b' ? true : null), 15_000, 250);
      const searching = (await findState()).running;
      check(`${tag}: Swap Follow moves at once: the API reads fake-b as its main while the run still searches`, !!movedAtOnce && searching, JSON.stringify({ moved: movedAtOnce, running: searching }));
      const going = await waitFor(async () => {
        const d = await dialog();
        return d?.phase === 'run' && d.run === 'running' && d.counts.moved >= 1 && d.rows.some((r) => r.id === ids.follow) ? d : null;
      }, 15_000, 250);
      const followRow = going?.rows.find((r) => r.id === ids.follow);
      check(`${tag}: the dialog becomes the run: how far, the counts, and Swap Follow "fake-a → fake-b"`,
        !!going && followRow?.state === 'follower' && JSON.stringify(followRow?.names) === JSON.stringify(['fake-a', 'fake-b'])
        && JSON.stringify(going.keys) === JSON.stringify(['stop', 'background']), JSON.stringify(going ?? await dialog()));
      check(`${tag}: ...with no sideways scroll`, await noSideScroll());
      await shot(`${tag}-6-running`);

      // Run in background, then Replace again: the run, not the ask view -- from the row, and after a reload (the run
      // found by its source).
      await click('[data-replace-background]');
      const closed = await waitFor(async () => (!(await dialog()) ? true : null), 5000, 200);
      const back = closed ? await openReplace() : null;
      check(`${tag}: Run in background, then Replace again: the run, not the ask view`, back?.phase === 'run' && back?.run === 'running', JSON.stringify(back));
      await click('[data-replace-background]');
      await visit('/admin/?tab=Sources', 2000);
      const reloaded = await openReplace();
      check(`${tag}: ...and after a reload too`, reloaded?.phase === 'run' && reloaded?.run === 'running', JSON.stringify(reloaded));
      await shot(`${tag}-7-reopened`);

      // The run ends, and the dialog opened after the reload says how.
      const done = started ? await waitFor(async () => { const s = await findState(); return !s.running && s.run?.id === started.id ? s.run : null; }, 180_000, 1000) : null;
      await script(FAKE_B, 'search', 'ok');
      const by = Object.fromEntries((done?.results ?? []).map((r) => [r.seriesId, r]));
      check(`${tag}: the run ends: Swap Follow moved, Swap Search found on fake-b, Swap Posting left (posting order)`,
        done?.status === 'done' && by[ids.follow]?.promoted?.via === 'follower' && by[ids.search]?.promoted?.via === 'search'
        && by[ids.search]?.promoted?.to === 'fake-b' && by[ids.posting]?.why === 'posting_order', JSON.stringify(done && { status: done.status, results: done.results }));
      check(`${tag}: "Turn it off when done" leaves fake-a on: a series is still on it`, done?.left === 1 && done?.turnedOff === false
        && (await sourceRow('fake-a'))?.standing !== 'off', JSON.stringify(done && { left: done.left, turnedOff: done.turnedOff }));
      check(`${tag}: Swap Search's main source is fake-b now`, (await mainOf(ids.search)) === 'fake-b');
      const ended = await waitFor(async () => { const d = await dialog(); return d?.phase === 'run' && d.run === 'done' && d.outcome ? d : null; }, 15_000, 300);
      check(`${tag}: the dialog says how it ended: 1 moved, 1 new source found, 1 no replacement`,
        JSON.stringify(ended?.counts) === JSON.stringify({ moved: 1, found: 1, none: 1 }), JSON.stringify(ended ?? await dialog()));
      const rowOf = (id) => ended?.rows.find((r) => r.id === id);
      check(`${tag}: ...each series "from → to", or why`, rowOf(ids.search)?.state === 'search' && JSON.stringify(rowOf(ids.search)?.names) === JSON.stringify(['fake-a', 'fake-b'])
        && rowOf(ids.posting)?.state === 'posting_order' && !!rowOf(ids.posting)?.text.includes(say('Numbered by posting order: no other source’s numbers line up with it')),
        JSON.stringify(ended?.rows));
      check(`${tag}: ...with Replace again and Close`, !!ended?.keys.includes('again') && !!ended?.keys.includes('close'), JSON.stringify(ended?.keys));
      await shot(`${tag}-8-done`);
      await click('[data-replace-close]');

      // ---- 6. Make main refused on the series numbered by posting order
      check(`${tag}: Swap Posting's Sources sheet opens`, await openSourcesSheet(ids.posting));
      await waitFor(() => click('[role="dialog"] [data-make-main="fake-b"]'), 15_000, 300);
      await waitFor(() => click('[data-make-main-confirm="fake-b"] [data-make-main-yes]'), 5000, 200);
      const refused = await waitFor(() => page.$eval('[data-make-main-refusal]', (p) => p.textContent), 15_000, 300);
      check(`${tag}: Make main on a series numbered by posting order is refused, in words`,
        refused === say('This series is numbered by posting order, so another source’s chapter numbers do not line up with it.'), String(refused));
      check(`${tag}: ...and it stays on fake-a`, (await mainOf(ids.posting)) === 'fake-a');
      await shot(`${tag}-9-make-main-refused`);
      await closeDialogs();

      // ---- 7. Numbered by its source again: Replace again moves it, and fake-a is turned off
      sql(`UPDATE lib_series SET numbering = NULL WHERE id = ${lit(ids.posting)}`);
      await visit('/admin/?tab=Sources', 3000);
      const again = await openReplace();
      const p2 = await get('/api/admin/sources/fake-a/replace-preview');
      check(`${tag}: Replace again asks afresh: 1 series, with a working backup`, again?.phase === 'ask' && Number(again?.main) === 1 && p2.main === 1 && p2.withBackup === 1
        && again?.turnOff === true, JSON.stringify({ again, p2 }));
      const before2 = (await findState()).run?.id ?? null;
      await click('[data-replace-start]');
      const done2 = await waitFor(async () => { const s = await findState(); return !s.running && s.run && s.run.id !== before2 && s.run.status !== 'running' ? s.run : null; }, 120_000, 500);
      const fa2 = await sourceRow('fake-a');
      check(`${tag}: nothing is left on fake-a: Turn it off when done turned it off`, done2?.left === 0 && done2?.turnedOff === true && fa2?.standing === 'off' && fa2?.main === 0,
        JSON.stringify({ left: done2?.left, turnedOff: done2?.turnedOff, standing: fa2?.standing, main: fa2?.main }));
      check(`${tag}: Swap Posting's main source is fake-b`, (await mainOf(ids.posting)) === 'fake-b');
      const ended2 = await waitFor(async () => { const d = await dialog(); return d?.run === 'done' && d.outcome ? d : null; }, 15_000, 300);
      check(`${tag}: the dialog says it is done: 1 moved, fake-a turned off`, ended2?.counts?.moved === 1 && !!ended2?.outcome, JSON.stringify(ended2));
      await shot(`${tag}-10-done-off`);
      await click('[data-replace-close]');
      const gone = await waitFor(async () => (!(await attentionRow('fake-a')) ? true : null), 30_000, 500);
      check(`${tag}: fake-a has left Needs attention`, !!gone);

      // ---- 8. Turn off all: asks first, then switches each off
      await visit('/admin/?tab=Sources', 3000);
      const unusedNow = (await overview()).attention.failingUnused;
      await waitFor(() => click('[data-sources-attention-row="failing-unused"] [data-source-bulk-off]'), 15_000, 300);
      const asked = await waitFor(() => page.$eval('[data-source-bulk-confirm]', (e) => e.innerText.replace(/\s+/g, ' ')), 5000, 200);
      const stillOn = (await sourceRow(MB))?.standing !== 'off';
      check(`${tag}: Turn off all asks first, inside its row, and switches nothing off yet`, !!asked && stillOn, JSON.stringify({ asked, stillOn }));
      await shot(`${tag}-11-turn-off-all`);
      await click('[data-source-bulk-confirm] [data-source-bulk-go]');
      const allOff = await waitFor(async () => {
        const o = await overview();
        return unusedNow.every((id) => o.sources.find((s) => s.id === id)?.standing === 'off') && !o.attention.failingUnused.length ? true : null;
      }, 30_000, 1000);
      check(`${tag}: ...then switches off each failing source nothing uses (${unusedNow.length})`, !!allOff, JSON.stringify((await overview()).attention));
      const retired = await waitFor(async () => (!(await page.$('[data-sources-attention-row="failing-unused"]')) ? true : null), 30_000, 500);
      check(`${tag}: ...and its row goes`, !!retired);

      // ---- 9. Remove of a site still in use: refused, in words
      // A site added by address, its id the server's (a slug of its name), pointed at by a series of the seed for the
      // check and let go after it.
      let site = (await overview()).sources.find((s) => s.kind === 'site' && s.name === SITE_NAME)?.id ?? null;
      if (!site) {
        const add = await call('/api/admin/sources/custom', { method: 'POST', json: { engine: 'madara', name: SITE_NAME, base: 'http://127.0.0.1:9' } });
        check(`${tag}: a site added by address (${SITE_NAME})`, add.status === 200 && !!add.body?.id, JSON.stringify(add.body).slice(0, 200));
        site = add.body?.id ?? null;
      }
      if (!site) throw new Error('no site to remove');
      await post(`/api/admin/sources/${encodeURIComponent(site)}/enable`);
      const mixed = await seriesNamed('Mixed Formats');
      const was = sql(`SELECT coalesce(source_id, '') || '|' || coalesce(source_series_id, '') FROM lib_series WHERE id = ${lit(mixed?.id)}`);
      sql(`UPDATE lib_series SET source_id = ${lit(site)}, source_series_id = 'walk-site-mixed' WHERE id = ${lit(mixed?.id)}`);
      try {
        await visit('/admin/?tab=Sources', 3000);
        const kind = (await sourceRow(site))?.kind;
        check(`${tag}: the site is listed as a site, the main source of 1 series`, kind === 'site' && (await sourceRow(site))?.main === 1, String(kind));
        const opened = await waitFor(() => click(`[data-sources-row="${site}"] [data-sources-open]`)
          .then((ok) => ok || click(`[data-sources-attention-row="replace"][data-source-id="${site}"] [data-sources-open]`)), 15_000, 300);
        await waitFor(() => page.$(`[data-source-sheet="${site}"]`), 10_000, 200);
        await waitFor(() => click('[role="dialog"] [data-source-key="remove"]'), 10_000, 200);
        await waitFor(() => click('[data-source-remove-confirm] [data-source-remove-yes]'), 5000, 200);
        const said = await waitFor(() => page.$eval('[role="dialog"] [data-source-refusal]', (p) => p.textContent), 15_000, 300);
        check(`${tag}: Remove of a site still in use is refused, in words`, !!opened && said === say('It is the main source of 1 series. Replace it first.'), String(said));
        check(`${tag}: ...and the site is still there`, (await sourceRow(site))?.kind === 'site');
        await shot(`${tag}-12-remove-refused`);
        await closeDialogs();
      } finally {
        const [src, ref] = was.split('|');
        sql(`UPDATE lib_series SET source_id = ${src ? lit(src) : 'NULL'}, source_series_id = ${ref ? lit(ref) : 'NULL'} WHERE id = ${lit(mixed?.id)}`);
      }

      // ---- 10. The old tabs' addresses
      const landed = async (path) => {
        await visit(path, 3000);
        return page.evaluate(() => ({
          panel: !!document.querySelector('[data-sources-panel]'),
          view: document.querySelector('[data-sources-view][aria-selected="true"]')?.getAttribute('data-sources-view') ?? null,
          mangadex: !!document.querySelector('[data-mangadex-langs]') && document.querySelector('[data-mangadex-fold]')?.getAttribute('aria-expanded') === 'true',
          sheet: document.querySelector('[data-source-sheet]')?.getAttribute('data-source-sheet') ?? null,
          settings: document.querySelector('[data-ext-settings-toggle]')?.getAttribute('aria-expanded') ?? null,
        }));
      };
      const prov = await landed('/admin/?tab=Providers');
      check(`${tag}: ?tab=Providers lands on Sources`, prov.panel && prov.view === 'yours', JSON.stringify(prov));
      const ext = await landed('/admin/?tab=Extensions');
      check(`${tag}: ?tab=Extensions lands on Sources`, ext.panel && ext.view === 'yours', JSON.stringify(ext));
      const md = await landed('/admin/?tab=Providers&card=mangadex');
      check(`${tag}: ?tab=Providers&card=mangadex opens Add sources on MangaDex's languages`, md.panel && md.view === 'add' && md.mangadex, JSON.stringify(md));
      const st = await landed(`/admin/?tab=Extensions&settings=${SOURCE_IDS.webtoons}`);
      const settingsOpen = await waitFor(() => page.evaluate(() => document.querySelector('[data-ext-settings-toggle]')?.getAttribute('aria-expanded') === 'true' || null), 10_000, 300);
      check(`${tag}: ?tab=Extensions&settings=<id> opens that source's sheet on its settings`,
        st.panel && st.sheet === `sw:${SOURCE_IDS.webtoons}` && !!settingsOpen, JSON.stringify(st));
      check(`${tag}: ...with no sideways scroll`, await noSideScroll());
      await shot(`${tag}-13-settings-link`);
      await closeDialogs();
    } finally {
      await script(FAKE_B, 'search', 'ok').catch(() => {});
      if (arabic) {
        lang = 'en';
        await call('/api/settings', { method: 'PUT', json: { lang: 'en' } }).catch(() => {});
        await page.evaluate(() => localStorage.setItem('uchiyomi.lang', 'en')).catch(() => {});
      }
    }
  }

  // ---- the phase -------------------------------------------------------------------------------------------------
  // MangaDex is a real site, with no place in a run over fake series, and the failure hunt would follow fake-b on its
  // own once a sweep meets offline fake-a: both off for the phase and put back after, as walk491 does.
  let hunt = null;
  let mangadexOff = false;
  try {
    await Promise.all([control(FAKE_A, '/__reset', {}), control(FAKE_B, '/__reset', {})]);
    await post('/api/admin/sources/mangadex/disable');
    mangadexOff = true;
    hunt = (await get('/api/admin/settings')).auto_follow_on_failure;
    await call('/api/admin/settings', { method: 'PATCH', json: { autoFollowOnFailure: false } });
    for (const p of [{ key: 'phone', width: 390 }, { key: 'wide', width: 1280 }, { key: 'arabic', width: 390, arabic: true }]) {
      try {
        await pass(p);
      } catch (e) {
        check(`replace-${p.key}: the pass ran to the end`, false, String(e?.stack || e));
        await shot(`replace-${p.key}-zz-where-it-stopped`).catch(() => {});
        await closeDialogs().catch(() => {});
      }
    }
  } finally {
    if (hunt !== null) await call('/api/admin/settings', { method: 'PATCH', json: { autoFollowOnFailure: hunt } }).catch(() => {});
    if (mangadexOff) await call('/api/admin/sources/mangadex/enable', { method: 'POST', json: {} }).catch(() => {});
    await engineMode({ mode: 'up' }).catch(() => {});
  }
}
