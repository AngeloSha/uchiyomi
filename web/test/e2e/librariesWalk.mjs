// walk49's "libraries" and "nosource" phases (v0.55.1): #148, a library is one or more folders; and #149, "No source"
// in the Library's Main source filter. Through the browser on the real routes, at 1280, 390 and 390 in Arabic.
//
// Needs a plain up.sh stack -- its seeded read library under "Test Source", and fake-a and fake-b:
//   KEEP=1 E2E_MIN_FREE_GB=0 E2E_NO_WALK=1 E2E_NET=uchi-e2e-lib E2E_PORT=18157 E2E_SUBNET=10.222.57.0/24 \
//     bash web/test/e2e/up.sh
//   cd web && BASE=http://127.0.0.1:18157 PHASES=libraries,nosource npm run test:e2e:v049
//
// libraries -- Admin → Content → Library. Walk Tale (fake-a), Walk Gap and Walk Tale: Next (fake-b) are added, and Walk
// Tale: Next is filed into the default library by hand. Each pass makes a library of three folders -- fake-a and fake-b
// ticked at the folder browser's root, Test Source/Mixed Formats ticked inside Test Source -- whose preview says how many
// series would move, and exactly that many move in: Walk Tale, Walk Gap and Mixed Formats, while Walk Tale: Next, under
// fake-b but filed by hand, stays where it was filed. Its card says the first folder and "+2 more". Then its Settings,
// Mixed Formats' folder taken out of the list: the preview says one, and Mixed Formats moves back out to the default
// library while the rest stay. The library is removed for the next pass, which puts everything back.
//
// nosource -- the Library page's Main source section ends on "No source", with how many series have no main source
// (the read library's, never matched to a site); picking it shows exactly those -- checked against each series' own
// sources, never against the filter itself -- with `src=-` in the address, which a reload keeps; picking it again
// clears it.
//
// Every view: no sideways scroll. walk49 counts the console errors and 5xx of the whole walk. Screenshots:
// libraries-<pass>-<n>-<what>.png and nosource-<pass>-<n>-<what>.png in walk49's OUT. LOOK at them.
import { readFileSync } from 'node:fs';

const AR = JSON.parse(readFileSync(new URL('../../public/locales/ar.json', import.meta.url), 'utf8'));
const PASSES = [[1280, 'en'], [390, 'en'], [390, 'ar']];
const tag = (w, l) => `${w}${l === 'ar' ? 'ar' : ''}`;

/** The walk's API session, the page's language and the little each phase shares. */
function kit({ page, go, check, base, token }) {
  const call = async (path, o = {}) => {
    const r = await fetch(base + path, {
      method: o.method ?? (o.json ? 'POST' : 'GET'),
      headers: { authorization: `Bearer ${token}`, ...(o.json ? { 'content-type': 'application/json' } : {}) },
      body: o.json ? JSON.stringify(o.json) : undefined,
    });
    const raw = await r.text();
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    if (r.status >= 400) throw new Error(`${o.method ?? (o.json ? 'POST' : 'GET')} ${path} -> ${r.status} ${raw.slice(0, 200)}`);
    return body;
  };
  const allSeries = async () => (await call('/api/series/search', { json: { query: '', size: 100 } })).content ?? [];
  let lang = 'en';
  const say = (key, vars = {}) => {
    const s = lang === 'ar' ? AR[key] : key;
    if (typeof s !== 'string') { check(`ar.json has "${key}"`, false); return '\u0000'; }
    return Object.entries(vars).reduce((out, [k, v]) => out.split(`{${k}}`).join(String(v)), s);
  };
  const setLang = async (l) => {
    lang = l;
    await call('/api/settings', { method: 'PUT', json: { lang: l } });
    await page.evaluate((x) => localStorage.setItem('uchiyomi.lang', x), l);
  };
  const visit = async (path, wait = 3000) => {
    await go(path, wait);
    await page.evaluate(() => document.querySelector('[data-health-banner] button')?.click());
    if (await page.$('input[type=password]')) throw new Error(`${path} opened on the sign-in page`);
  };
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
  return { call, allSeries, say, setLang, visit, noSideScroll, lang: () => lang };
}

// ---- libraries ---------------------------------------------------------------------------------------------------

export async function librariesWalk(ctx) {
  const { page, check, waitFor, sleep } = ctx;
  // A beat before each picture: a dialog and a sheet ease into place.
  const shot = async (name) => { await sleep(700); await ctx.shot(name); };
  const { call, allSeries, say, setLang, visit, noSideScroll, lang } = kit(ctx);
  const ADDS = [['fake-a', 'walk-tale', 'Walk Tale'], ['fake-b', 'walk-gap', 'Walk Gap'], ['fake-b', 'walk-tale-next', 'Walk Tale: Next']];
  const THREE = ['fake-a', 'fake-b', 'Test Source/Mixed Formats'];
  /** A library's folders as GET answers them: the first as it was chosen, then the rest by name (api.md). */
  const asStored = (paths) => [paths[0], ...paths.slice(1).sort()];
  try {
    console.log('\n  libraries: the series');
    for (const [source, sourceId, title] of ADDS) {
      if ((await allSeries()).some((s) => s.name === title)) continue;
      await call('/api/sources/add', { json: { source, sourceId, chapterFrom: 'oldest', chapterCount: 2, autoUpdate: false } });
    }
    const ids = await waitFor(async () => {
      const jobs = (await call('/api/sources/jobs')).content ?? [];
      if (jobs.some((j) => /downloading|queued|waiting/.test(j.status))) return null;
      const all = await allSeries();
      const out = {};
      for (const t of [...ADDS.map((a) => a[2]), 'Mixed Formats']) out[t] = all.find((s) => s.name === t)?.id;
      return Object.values(out).every(Boolean) ? out : null;
    }, 180_000, 1500);
    check('libraries: Walk Tale, Walk Gap and Walk Tale: Next were added beside the read library', !!ids);
    if (!ids) return;
    // Filed by hand into the default library: a folder added to a library must leave it there.
    await call(`/api/admin/series/${ids['Walk Tale: Next']}/library`, { json: { libraryId: 'lib' } });
    /** Each walk series' library, by title. */
    const placed = async () => {
      const all = await allSeries();
      return Object.fromEntries(Object.keys(ids).map((t) => [t, all.find((s) => s.id === ids[t])?.libraryId ?? null]));
    };
    const start = await placed();
    check('libraries: every walk series starts in the default library', Object.values(start).every((l) => l === 'lib'), JSON.stringify(start));

    const dialog = () => page.$('[data-library-dialog]');
    const chosen = () => page.$$eval('[data-library-folders-chosen] [data-library-folder]', (li) => li.map((x) => x.getAttribute('data-library-folder'))).catch(() => []);
    const preview = () => page.$eval('[data-library-preview]', (p) => Number(p.getAttribute('data-library-preview'))).catch(() => null);
    const tick = async (path) => {
      const ok = await page.evaluate((p) => {
        const box = document.querySelector(`[data-folder-row="${CSS.escape(p)}"] input[type=checkbox]`);
        if (!box) return false;
        box.scrollIntoView({ block: 'center' });
        box.click();
        return true;
      }, path);
      if (ok) await waitFor(async () => ((await chosen()).includes(path) ? true : null), 5000, 150);
      return ok;
    };
    const into = async (path) => {
      await page.evaluate((p) => document.querySelector(`[data-folder-row="${CSS.escape(p)}"] button`)?.click(), path);
      return waitFor(() => page.$(`[data-folder-row^="${path}/"]`), 10_000, 200);
    };

    for (const [w, l] of PASSES) {
      const t = tag(w, l);
      console.log(`\n  libraries @${w}${l === 'ar' ? ' ar' : ''}`);
      if (l !== lang()) await setLang(l);
      await page.setViewport({ width: w, height: w < 1024 ? 844 : 900 });
      await visit('/admin/?tab=Library', 3500);
      // ---- a library of three folders
      const opened = await page.evaluate((label) => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === label);
        b?.click();
        return !!b;
      }, say('New library'));
      check(`libraries @${t}: New library opens the dialog`, opened && !!(await waitFor(dialog, 8000, 200)));
      const name = `Walk Shelf ${t}`;
      const field = await page.$('[data-library-dialog] input.field');
      await field?.click({ clickCount: 3 });
      await field?.type(name);
      await waitFor(() => page.$('[data-folder-row="fake-a"]'), 15_000, 300);
      const ticked = [await tick('fake-a'), await tick('fake-b')];
      const inside = await into('Test Source');
      ticked.push(!!inside && await tick('Test Source/Mixed Formats'));
      check(`libraries @${t}: the browser ticks three folders into the list, Mixed Formats from inside Test Source`,
        ticked.every(Boolean) && JSON.stringify(await chosen()) === JSON.stringify(THREE), JSON.stringify({ ticked, chosen: await chosen() }));
      const promised = await waitFor(preview, 10_000, 250);
      check(`libraries @${t}: the preview says 3 series would move`, promised === 3, String(promised));
      check(`libraries @${t}: the dialog has no sideways scroll`, await noSideScroll());
      await page.$eval('[data-library-preview]', (p) => p.scrollIntoView({ block: 'center' })).catch(() => {});
      await shot(`libraries-${t}-1-three-folders`);
      const before = await placed();
      await page.click('[data-library-save]');
      await waitFor(async () => (!(await dialog()) ? true : null), 10_000, 200);
      const lib = await waitFor(async () => (await call('/api/admin/libraries')).content.find((x) => x.name === name), 10_000, 300);
      check(`libraries @${t}: Create made it, holding the three folders, the first first`, JSON.stringify(lib?.paths) === JSON.stringify(asStored(THREE)), JSON.stringify(lib));
      if (!lib) continue;
      const after = await waitFor(async () => { const p = await placed(); return p['Walk Tale'] === lib.id ? p : null; }, 10_000, 300) ?? await placed();
      const moved = Object.keys(after).filter((k) => after[k] !== before[k]).sort();
      check(`libraries @${t}: the preview's number is what moved (${promised})`, moved.length === promised, JSON.stringify(moved));
      check(`libraries @${t}: Walk Tale, Walk Gap and Mixed Formats moved in; Walk Tale: Next, filed by hand, stayed`,
        JSON.stringify(moved) === JSON.stringify(['Mixed Formats', 'Walk Gap', 'Walk Tale']) && after['Walk Tale: Next'] === 'lib', JSON.stringify(after));
      // ---- its card
      const card = await waitFor(() => page.$eval(`[data-library-card="${lib.id}"]`, (c) => {
        c.scrollIntoView({ block: 'center' });
        return {
          folders: c.querySelector('[data-library-folders]')?.getAttribute('data-library-folders') ?? null,
          first: c.querySelector('[data-library-folders] bdi')?.textContent ?? null,
          more: c.querySelector('[data-library-more]')?.textContent?.trim() ?? null,
        };
      }).then((x) => (x.folders === '3' ? x : null)), 10_000, 300);
      check(`libraries @${t}: its card says the first folder and "${say('+{n} more', { n: 2 })}"`,
        card?.folders === '3' && card.first === 'fake-a' && card.more === say('+{n} more', { n: 2 }), JSON.stringify(card));
      check(`libraries @${t}: the cards have no sideways scroll`, await noSideScroll());
      await shot(`libraries-${t}-2-card`);
      // ---- Settings: Mixed Formats' folder out
      await page.evaluate((id, label) => {
        [...document.querySelectorAll(`[data-library-card="${id}"] button`)].find((b) => b.textContent?.trim() === label)?.click();
      }, lib.id, say('Settings'));
      const editing = await waitFor(() => page.$(`[data-library-dialog="${lib.id}"]`), 8000, 200);
      check(`libraries @${t}: Settings opens the library with its three folders listed`, !!editing && JSON.stringify(await chosen()) === JSON.stringify(asStored(THREE)),
        JSON.stringify(await chosen()));
      await page.evaluate(() => document.querySelector('[data-library-folder="Test Source/Mixed Formats"] [data-library-folder-remove]')?.click());
      await waitFor(async () => ((await chosen()).length === 2 ? true : null), 5000, 150);
      const promised2 = await waitFor(async () => { const n = await preview(); return n === 1 ? n : null; }, 10_000, 250) ?? await preview();
      check(`libraries @${t}: taken out, the preview says 1 series would move`, promised2 === 1, String(promised2));
      await page.$eval('[data-library-preview]', (p) => p.scrollIntoView({ block: 'center' })).catch(() => {});
      await shot(`libraries-${t}-3-one-out`);
      const before2 = await placed();
      await page.click('[data-library-save]');
      await waitFor(async () => (!(await dialog()) ? true : null), 10_000, 200);
      const after2 = await waitFor(async () => { const p = await placed(); return p['Mixed Formats'] === 'lib' ? p : null; }, 10_000, 300) ?? await placed();
      const moved2 = Object.keys(after2).filter((k) => after2[k] !== before2[k]);
      check(`libraries @${t}: Mixed Formats moved back out to the default library, and only it`,
        JSON.stringify(moved2) === JSON.stringify(['Mixed Formats']) && after2['Mixed Formats'] === 'lib', JSON.stringify(after2));
      check(`libraries @${t}: Walk Tale and Walk Gap stay; Walk Tale: Next is still where it was filed`,
        after2['Walk Tale'] === lib.id && after2['Walk Gap'] === lib.id && after2['Walk Tale: Next'] === 'lib', JSON.stringify(after2));
      const kept = (await call('/api/admin/libraries')).content.find((x) => x.id === lib.id);
      check(`libraries @${t}: the library holds the two folders left`, JSON.stringify(kept?.paths) === JSON.stringify(asStored(['fake-a', 'fake-b'])), JSON.stringify(kept?.paths));
      // Once the page has read the libraries again (the save asks it to).
      const more2 = await waitFor(() => page.$eval(`[data-library-card="${lib.id}"] [data-library-more]`, (m) => {
        const t = m.textContent?.trim();
        return t;
      }).then((x) => (x === say('+1 more') ? x : null)), 10_000, 250) ?? await page.$eval(`[data-library-card="${lib.id}"] [data-library-more]`, (m) => m.textContent?.trim()).catch(() => null);
      check(`libraries @${t}: the card says "${say('+1 more')}" now`, more2 === say('+1 more'), String(more2));
      await shot(`libraries-${t}-4-card-after`);
      // The next pass starts where this one did.
      await call(`/api/admin/libraries/${lib.id}`, { method: 'DELETE' });
      const back = await placed();
      check(`libraries @${t}: removed again, its series are back in the default library`, Object.values(back).every((x) => x === 'lib'), JSON.stringify(back));
    }
  } finally {
    if (lang() !== 'en') await setLang('en').catch(() => {});
  }
}

// ---- nosource ----------------------------------------------------------------------------------------------------

export async function noSourceWalk(ctx) {
  const { page, check, waitFor, sleep } = ctx;
  const shot = async (name) => { await sleep(700); await ctx.shot(name); };
  const { call, allSeries, say, setLang, visit, noSideScroll, lang } = kit(ctx);
  try {
    // What the filter must show, from each series' own sources -- never from the filter's own query.
    const all = await allSeries();
    const none = [];
    for (const s of all) {
      const d = await call(`/api/series/${encodeURIComponent(s.id)}`);
      if (!(d.sources ?? []).some((x) => x.primary)) none.push(s.id);
    }
    none.sort();
    check(`nosource: the library has series with no main source (${none.length}) and series with one`, none.length > 0 && none.length < all.length,
      JSON.stringify({ none: none.length, all: all.length }));
    const counted = (await call('/api/library/sources')).none;
    check(`nosource: GET /api/library/sources counts ${none.length} with none`, counted === none.length, String(counted));

    /** The series the grid shows, by id. */
    const grid = () => page.evaluate(() => [...new Set([...document.querySelectorAll('main a[href*="/series/?id="]')]
      .map((a) => new URL(a.getAttribute('href'), location.href).searchParams.get('id')).filter(Boolean))].sort());
    const chip = () => page.$eval('[data-source-none]', (b) => ({ text: b.textContent?.replace(/\s+/g, ' ').trim(), pressed: b.getAttribute('aria-pressed') })).catch(() => null);
    const src = () => page.evaluate(() => new URL(location.href).searchParams.get('src'));
    /** On a phone the filters are a sheet behind the Filters key; from lg up they are beside the grid. */
    const panel = async (w) => {
      if (w >= 1024) return true;
      await page.evaluate(() => document.querySelector('button.lg\\:hidden[aria-haspopup="dialog"]')?.click());
      return !!(await waitFor(() => page.$('[role="dialog"] [data-source-none]'), 8000, 200));
    };
    const closePanel = async (w) => { if (w < 1024) { await page.keyboard.press('Escape'); await sleep(600); } };

    for (const [w, l] of PASSES) {
      const t = tag(w, l);
      console.log(`\n  nosource @${w}${l === 'ar' ? ' ar' : ''}`);
      if (l !== lang()) await setLang(l);
      await page.setViewport({ width: w, height: w < 1024 ? 844 : 900 });
      await visit('/library', 3500);
      check(`nosource @${t}: the filters open`, await panel(w));
      const c = await waitFor(chip, 10_000, 250);
      check(`nosource @${t}: Main source shows "${say('No source')} ${none.length}"`, c?.text === `${say('No source')}${none.length}` || c?.text === `${say('No source')} ${none.length}`,
        JSON.stringify(c));
      await page.$eval('[data-source-none]', (b) => b.scrollIntoView({ block: 'center' })).catch(() => {});
      await page.evaluate(() => document.querySelector('[data-source-none]')?.click());
      const picked = await waitFor(async () => ((await src()) === '-' ? true : null), 8000, 200);
      check(`nosource @${t}: picking it puts src=- in the address`, !!picked, String(await src()));
      check(`nosource @${t}: ...and the chip is pressed`, (await waitFor(async () => ((await chip())?.pressed === 'true' ? true : null), 5000, 200)) === true);
      await shot(`nosource-${t}-1-picked`);
      await closePanel(w);
      const shown = await waitFor(async () => { const g = await grid(); return JSON.stringify(g) === JSON.stringify(none) ? g : null; }, 15_000, 400) ?? await grid();
      check(`nosource @${t}: the grid shows exactly the series with no main source`, JSON.stringify(shown) === JSON.stringify(none), JSON.stringify({ shown, none }));
      check(`nosource @${t}: no sideways scroll`, await noSideScroll());
      await shot(`nosource-${t}-2-grid`);
      // A reload keeps it, from the address alone.
      await page.reload({ waitUntil: 'networkidle2' }).catch(() => {});
      await sleep(2500);
      const kept = await waitFor(async () => { const g = await grid(); return (await src()) === '-' && JSON.stringify(g) === JSON.stringify(none) ? g : null; }, 15_000, 400);
      check(`nosource @${t}: a reload keeps src=- and the same series`, !!kept, JSON.stringify({ src: await src(), grid: await grid() }));
      await shot(`nosource-${t}-3-reloaded`);
      // Picking it again clears it.
      await panel(w);
      await page.evaluate(() => document.querySelector('[data-source-none]')?.click());
      const cleared = await waitFor(async () => ((await src()) === null ? true : null), 8000, 200);
      check(`nosource @${t}: picking it again clears it`, !!cleared, String(await src()));
      await closePanel(w);
    }
  } finally {
    if (lang() !== 'en') await setLang('en').catch(() => {});
  }
}
