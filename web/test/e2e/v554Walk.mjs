// walk49's v0.55.4 phases, through the browser on the real routes: find (#150, #158), rescan (#150), multisource and
// adultsearch (#158). Each needs a stack of its own:
//
//   find -- an EMPTY instance (up.sh with E2E_EMPTY_LIBRARY=1: nothing seeded, no series at all). At 1280, 390 and 390
//     in Arabic: the version where admins look (the foot of the admin menu on a desktop, the admin header's facts on a
//     phone); the empty Library's "Import your library", which opens the import page, and Home's welcome with the same
//     key; then the search palette (Ctrl+K, desktop) and the phone's search page: "notice" lists Notice chapters under
//     Pages and settings and lands on its card in Admin → Settings, and "rescan" lands on Rescan everything's row in
//     Admin → Tasks (the integration's own destination).
//
//   rescan -- a plain up.sh stack, LIB naming its library folder and E2E_NET its network. A folder collected by hand per
//     pass: two of its files deleted, one renamed, two chapters read first; and two series of hand-named files read the
//     way a library scanned before v0.55.2 holds them. Admin → Tasks → Rescan everything → Start: the preview names the
//     two gone files, the renamed one as moved (kept) -- and, since v0.55.7, says its chapter follows it -- and offers the
//     two series for the new file-name rules; one is ticked; Apply marks the two "File no longer on disk" on the series
//     page, their read marks kept, points the renamed chapter's own row at its new file (one chapter, not two), and
//     renumbers the ticked series alone. Then, once, every file of the library moved out of the folder: the preview says
//     the folder looks unmounted and Apply has nothing to do.
//
//   multisource -- a plain up.sh stack, E2E_NET. Walk Tale added from fake-a with nothing yet, following fake-b: one
//     release (no group named, English, twelve pages) on two sites, each serving its pages from its own host -- two image
//     servers. Three chapters picked from fake-b come from fake-b alone; then the series page's "Fetch all 9" takes the
//     rest from both (the fakes' own logs say which served what), each chapter once, and the job finishes.
//
//   adultsearch -- up.sh with E2E_ADULT=1 (fake-b declares itself 18+). At 1280, 390 and 390 in Arabic, Discover's
//     search for "Walk" with Show 18+ on: the chips All · Hide 18+ · 18+ only, the 18+ mark on each adult result (since
//     v0.55.5 a title only 18+ sources carry: one fake-a carries too is not), Hide 18+ and 18+ only each showing their
//     half; then with Show 18+ off: no chips, and no adult result.
//
// Every view: no sideways scroll. walk49 counts the console errors and 5xx of the whole walk. Screenshots:
// <phase>-<pass>-<n>-<what>.png in walk49's OUT. LOOK at them.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { kit, writeShelf } from './filenamesWalk.mjs';

const PASSES = [[1280, 'en'], [390, 'en'], [390, 'ar']];
const tag = (w, l) => `${w}${l === 'ar' ? 'ar' : ''}`;
/** The text of the first element `sel` matches, its white space folded; null when there is none or it is hidden. */
const textOf = (page, sel) => page.evaluate((s) => {
  const e = document.querySelector(s);
  return e && e.getClientRects().length ? e.textContent.replace(/\s+/g, ' ').trim() : null;
}, sel);
/** Where element `id` is on screen once the page has landed: its top, the window's height, and the address. */
const landedAt = (page, id) => page.evaluate((i) => {
  const e = document.getElementById(i);
  const b = e?.getBoundingClientRect();
  return { path: location.pathname, search: location.search, top: b ? Math.round(b.top) : null, vh: innerHeight };
}, id);
/**
 * A DOM click on the first element `sel` matches: on a phone a row near the bottom sits under the fixed bottom nav, and a
 * mouse click at its centre lands on the nav instead.
 */
const tap = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); e?.click(); return !!e; }, sel);
/** On screen and near the top (a card at the very end of a short page cannot scroll higher than the page allows). */
const inView = (at) => !!at && at.top != null && at.top >= 0 && at.top < at.vh - 120;

// ── find ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function findWalk(ctx) {
  const { page, check, waitFor, sleep } = ctx;
  const shot = async (name) => { await sleep(700); await ctx.shot(name); };
  const { call, say, setLang, visit, noSideScroll, lang } = kit(ctx);
  try {
    const held = (await call('/api/series/search', { json: { query: '', size: 5 } })).content ?? [];
    check('find: the instance holds no series (up.sh with E2E_EMPTY_LIBRARY=1)', held.length === 0, `${held.length} series`);
    const version = (await call('/api/admin/stats'))?.version;
    check('find: /api/admin/stats says which version runs', /^\d+\.\d+\.\d+/.test(String(version ?? '')), JSON.stringify(version));
    const running = `Uchiyomi v${version}`;

    for (const [w, l] of PASSES) {
      const t = tag(w, l);
      console.log(`\n  find @${w}${l === 'ar' ? ' ar' : ''}`);
      if (l !== lang()) await setLang(l);
      await page.setViewport({ width: w, height: w < 1024 ? 844 : 900 });

      // 1. The version where admins look: the foot of the admin menu on a desktop, the header's facts on a phone.
      await visit('/admin/?tab=Settings', 3500);
      if (w >= 1024) {
        const line = await waitFor(() => textOf(page, '[data-admin-version]'), 15_000, 300);
        check(`find @${t}: the foot of the admin menu says ${running}`, !!line && line.startsWith(running), JSON.stringify(line));
        await page.evaluate(() => document.querySelector('[data-admin-version]')?.scrollIntoView({ block: 'center' }));
      } else {
        const hero = await waitFor(() => textOf(page, '[data-hero-version]'), 15_000, 300);
        check(`find @${t}: the phone's admin header says ${running}`, !!hero && hero.includes(running), JSON.stringify(hero));
      }
      check(`find @${t}: Admin → Settings has no sideways scroll`, await noSideScroll());
      await shot(`find-${t}-1-version`);

      // 2. The empty Library: "Import your library" first, with its line, and it opens the import page.
      await visit('/library/', 3500);
      const key = await waitFor(() => textOf(page, '[data-library-start] [data-start-key="import"]'), 15_000, 300);
      check(`find @${t}: the empty Library offers "${say('Import your library')}"`, key === say('Import your library'), JSON.stringify(key));
      const keys = await page.evaluate(() => [...document.querySelectorAll('[data-library-start] [data-start-key]')].map((e) => e.getAttribute('data-start-key')));
      check(`find @${t}: the import first, then Discover`, JSON.stringify(keys) === '["import","discover"]', JSON.stringify(keys));
      const line = await textOf(page, '[data-library-start] p');
      check(`find @${t}: and the line that says what it takes`,
        line === say('From a Mihon or Tachiyomi backup, a MangaDex list, your AniList, MyAnimeList or Kitsu list, or pasted titles'), JSON.stringify(line));
      check(`find @${t}: the empty Library has no sideways scroll`, await noSideScroll());
      await shot(`find-${t}-2-library-empty`);
      await page.click('[data-library-start] [data-start-key="import"]');
      const heading = await waitFor(() => page.evaluate(() => (location.pathname === '/admin/import/' ? document.querySelector('h1')?.textContent?.trim() || null : null)), 15_000, 300);
      check(`find @${t}: "Import your library" opens the import page`, heading === say('Import & review matches'),
        JSON.stringify({ heading, at: await page.evaluate(() => location.pathname) }));
      await shot(`find-${t}-3-import`);

      // Home's welcome: the same keys, in the same order.
      await visit('/', 3500);
      const homeKeys = await waitFor(async () => {
        const k = await page.evaluate(() => [...document.querySelectorAll('[data-library-start] [data-start-key]')].map((e) => e.getAttribute('data-start-key')));
        return k.length ? k : null;
      }, 15_000, 300);
      check(`find @${t}: Home's welcome offers the import, then Discover`, JSON.stringify(homeKeys) === '["import","discover"]', JSON.stringify(homeKeys));
      check(`find @${t}: Home has no sideways scroll`, await noSideScroll());
      await shot(`find-${t}-4-home`);

      // 3. Search finds the settings: the palette on a desktop, the Search page on a phone.
      if (w >= 1024) {
        const palette = async (from, query) => {
          await visit(from, 3000);
          await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control');
          await page.waitForSelector('[role="dialog"] input', { timeout: 10_000 });
          await page.keyboard.type(query, { delay: 40 });
          return waitFor(() => page.evaluate(() => [...document.querySelectorAll('[role="dialog"] [data-palette-place]')]
            .map((e) => e.getAttribute('data-palette-place'))).then((k) => (k.length ? k : null)), 10_000, 200);
        };
        const notice = await palette('/library/', 'notice');
        check(`find @${t}: Ctrl+K "notice" lists Notice chapters first, under Pages and settings`,
          notice?.[0] === 'settings-notice' && await page.evaluate((h) => [...document.querySelectorAll('[role="dialog"] p')].some((p) => p.textContent.trim() === h), say('Pages and settings')),
          JSON.stringify(notice));
        await shot(`find-${t}-5-palette-notice`);
        await page.keyboard.press('Enter');
        const atNotice = await waitFor(async () => { const a = await landedAt(page, 'notice-chapters'); return inView(a) && !a.search.includes('section=') ? a : null; }, 20_000, 300);
        check(`find @${t}: it opens Admin → Settings on the Notice chapters card`, !!atNotice && atNotice.path === '/admin/' && /tab=Settings/.test(atNotice.search),
          JSON.stringify(atNotice ?? await landedAt(page, 'notice-chapters')));
        await shot(`find-${t}-6-arrived-notice`);
        // From Admin → Settings to another tab of the same page: a whole page load, then the row.
        const rescan = await palette('/admin/?tab=Settings', 'rescan');
        check(`find @${t}: Ctrl+K "rescan" lists Rescan everything`, rescan?.[0] === 'rescan', JSON.stringify(rescan));
        await page.keyboard.press('Enter');
        const atRescan = await waitFor(async () => { const a = await landedAt(page, 'task-rescan'); return inView(a) && !a.search.includes('section=') ? a : null; }, 20_000, 300);
        check(`find @${t}: it opens Admin → Tasks on Rescan everything's row`, !!atRescan && atRescan.path === '/admin/' && /tab=Tasks/.test(atRescan.search),
          JSON.stringify(atRescan ?? await landedAt(page, 'task-rescan')));
        await shot(`find-${t}-7-arrived-rescan`);
      } else {
        await visit('/search/?q=notice', 3000);
        const place = await waitFor(() => textOf(page, '[data-search-places] [data-palette-place="settings-notice"]'), 15_000, 300);
        check(`find @${t}: the phone's search lists ${say('Notice chapters')} under Pages and settings`,
          !!place && place.includes(say('Notice chapters')) && (await textOf(page, '[data-search-places]'))?.includes(say('Pages and settings')), JSON.stringify(place));
        check(`find @${t}: the search page has no sideways scroll`, await noSideScroll());
        await shot(`find-${t}-5-search-notice`);
        await page.click('[data-search-places] [data-palette-place="settings-notice"]');
        const atNotice = await waitFor(async () => { const a = await landedAt(page, 'notice-chapters'); return inView(a) && !a.search.includes('section=') ? a : null; }, 20_000, 300);
        check(`find @${t}: a tap opens Admin → Settings on the Notice chapters card`, !!atNotice && atNotice.path === '/admin/' && /tab=Settings/.test(atNotice.search),
          JSON.stringify(atNotice ?? await landedAt(page, 'notice-chapters')));
        await shot(`find-${t}-6-arrived-notice`);
      }
    }
  } catch (e) {
    check('find: the phase ran to the end', false, String(e?.stack || e));
  } finally {
    if (lang() !== 'en') await setLang('en').catch(() => {});
  }
}

// ── rescan ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Where every pass's folders go, under the instance's library folder. */
const DIR = 'Hand Made';
const SHELF = (t) => `Rescan Shelf ${t}`;
const COMICS = (t) => `Rescan Comics ${t}`;
const OTHER = (t) => `Rescan Other ${t}`;
/** Each hand-named file: the number the first number in its name gave before v0.55.2, and the newer rules' number. */
const HAND = { 'Vol 2 Ch 5.cbz': [2, 5], 'Batman (1987) #12.cbz': [1987, 12] };

export async function rescanWalk(ctx) {
  const { page, check, waitFor, sleep, lib } = ctx;
  const NET = process.env.E2E_NET;
  if (!lib || !NET) { check('rescan: LIB names the library folder and E2E_NET the instance (up.sh prints both with KEEP=1)', false); return; }
  const sql = (text) => execFileSync('docker', ['exec', `${NET}-db`, 'psql', '-U', 'postgres', '-d', 'yomi', '-tAqc', text], { encoding: 'utf8' }).trim();
  const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const shot = async (name) => { await sleep(700); await ctx.shot(name); };
  const { call, say, setLang, visit, noSideScroll, seriesNamed, scan, lang } = kit(ctx);
  const byName = async (id) => Object.fromEntries(((await call(`/api/series/${id}/books?size=100`)).content ?? []).map((b) => [b.name, b]));
  const rowText = () => textOf(page, '#task-rescan');
  try {
    console.log('\n  rescan: the folders');
    for (const [w, l] of PASSES) {
      const t = tag(w, l);
      writeShelf(lib, `${DIR}/${SHELF(t)}`, Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`Chapter ${n}.cbz`, 3])));
      for (const s of [COMICS(t), OTHER(t)]) writeShelf(lib, `${DIR}/${s}`, Object.fromEntries(Object.keys(HAND).map((f) => [f, 3])));
    }
    await scan();
    // The hand-named rows as a library scanned before v0.55.2 holds them: rule 1, by the first number in the name
    // (bff nameRule.int.test.ts asBefore). A scan since leaves a row on the rule it was born with.
    for (const [f, [before]] of Object.entries(HAND)) {
      sql(`UPDATE lib_books SET name_rule = 1, number = ${before}, number_end = NULL WHERE file LIKE ${lit(`${DIR}/Rescan %/${f}`)}`);
    }
    // Every file fingerprinted, as the background backfill does in time: a renamed file is known by it.
    await call('/api/admin/tasks/fingerprint/run', { json: {} });
    const unprinted = await waitFor(() => Promise.resolve(sql(`SELECT count(*) FROM lib_books WHERE file LIKE ${lit(`${DIR}/%`)} AND fp_at IS NULL`)).then((n) => (n === '0' ? n : null)), 60_000, 1000);
    check('rescan: every hand-made file is fingerprinted', unprinted === '0');

    for (const [i, [w, l]] of PASSES.entries()) {
      const t = tag(w, l);
      console.log(`\n  rescan @${w}${l === 'ar' ? ' ar' : ''}`);
      if (l !== lang()) await setLang(l);
      await page.setViewport({ width: w, height: w < 1024 ? 844 : 900 });
      const [shelf, comics, other] = [await seriesNamed(SHELF(t)), await seriesNamed(COMICS(t)), await seriesNamed(OTHER(t))];
      check(`rescan @${t}: the three folders are series`, !!(shelf && comics && other));
      if (!shelf || !comics || !other) continue;
      // Two chapters read, then two files deleted by hand and one renamed.
      const before = await byName(shelf.id);
      for (const n of [1, 2]) await call(`/api/books/${before[`Chapter ${n}`].id}/progress`, { method: 'PUT', json: { page: 3, completed: true } });
      const folder = join(lib, DIR, SHELF(t));
      rmSync(join(folder, 'Chapter 2.cbz'));
      rmSync(join(folder, 'Chapter 3.cbz'));
      renameSync(join(folder, 'Chapter 4.cbz'), join(folder, 'Chapter 04.cbz'));

      // Start: the preview, changing nothing.
      await visit('/admin/?tab=Tasks', 3500);
      await page.waitForSelector('#task-rescan > button', { timeout: 15_000 });
      await tap(page, '#task-rescan > button');
      const shown = await waitFor(() => page.$('[data-rescan-panel="preview"]'), 90_000, 500);
      check(`rescan @${t}: Start ends in the preview`, !!shown, await rowText() ?? '');
      if (!shown) continue;
      const headline = await textOf(page, '[data-rescan-headline]');
      // Since v0.55.7 an earlier pass's renamed file is no pair any more: its chapter followed it at that Apply.
      const moved = say('1 was probably moved or renamed (kept)');
      check(`rescan @${t}: the preview names the two gone files, and the renamed one as moved`,
        headline === `${say('{n} chapter files are gone from your folders', { n: 2 })} · ${moved}`, JSON.stringify(headline));
      const follow = await textOf(page, '[data-rescan-follow]');
      check(`rescan @${t}: and says its chapter follows it on Apply`,
        follow === say('1 file was moved or renamed within its series: on Apply its chapter follows it, reading history kept'), JSON.stringify(follow));
      await page.evaluate(() => { const d = document.querySelector('[data-rescan-moved]'); if (d) d.open = true; });
      const movedList = await textOf(page, '[data-rescan-moved]');
      check(`rescan @${t}: Chapter 4.cbz is listed as moved to Chapter 04.cbz`,
        !!movedList && movedList.includes(`${SHELF(t)} · Chapter 4.cbz`) && movedList.includes(`${SHELF(t)} · Chapter 04.cbz`), JSON.stringify(movedList));
      const offered = await page.evaluate(() => [...document.querySelectorAll('[data-rescan-tick]')].map((e) => e.getAttribute('data-rescan-tick')));
      check(`rescan @${t}: the opt-in offers both hand-named series`, offered.includes(comics.id) && offered.includes(other.id), JSON.stringify(offered));
      check(`rescan @${t}: the preview changed nothing`, Object.values(await byName(shelf.id)).every((b) => !b.pruned));
      await tap(page, `[data-rescan-tick="${comics.id}"]`);
      check(`rescan @${t}: no sideways scroll`, await noSideScroll());
      // Its top under the desktop's top bar, not behind it.
      await page.evaluate(() => { document.querySelector('[data-rescan-panel="preview"]')?.scrollIntoView({ block: 'start' }); window.scrollBy(0, -96); });
      await shot(`rescan-${t}-1-preview`);

      // Apply, and what it did: the Tasks line -- this pass's, told from the last pass's by the count of moved files.
      await tap(page, '[data-rescan-apply]');
      const applied = [say('{n} chapters marked as no longer on disk', { n: 2 }), moved, say('1 chapter now follows its moved or renamed file'),
        say('1 series renumbered by the new rules')].join(' · ');
      const result = await waitFor(async () => {
        const r = await rowText();
        return r?.includes(applied) && !(await page.$('[data-rescan-panel="running"]')) ? r : null;
      }, 60_000, 500);
      check(`rescan @${t}: Apply says two chapters were marked, the renamed one followed, and the ticked series renumbered`,
        !!result, JSON.stringify(await rowText()));
      await page.evaluate(() => document.getElementById('task-rescan')?.scrollIntoView({ block: 'center' }));
      await shot(`rescan-${t}-2-result`);

      const after = await byName(shelf.id);
      check(`rescan @${t}: chapters 2 and 3 are marked "deleted", every other chapter left live`,
        ['Chapter 2', 'Chapter 3'].every((n) => after[n]?.pruned && after[n]?.prunedReason === 'deleted')
          && ['Chapter 1', 'Chapter 04', 'Chapter 5'].every((n) => after[n] && !after[n].pruned),
        JSON.stringify(Object.fromEntries(Object.entries(after).map(([n, b]) => [n, [b.pruned, b.prunedReason]]))));
      // v0.55.7: the renamed chapter is ONE row -- its own, on the new file -- not the old row beside a new one.
      check(`rescan @${t}: Chapter 4 followed its file: one chapter, its own row, now Chapter 04`,
        !after['Chapter 4'] && after['Chapter 04']?.id === before['Chapter 4']?.id,
        JSON.stringify({ old: before['Chapter 4']?.id, now: after['Chapter 04']?.id, stillOld: !!after['Chapter 4'] }));
      check(`rescan @${t}: the read marks are kept, the gone chapter's too`,
        after['Chapter 1']?.readProgress?.completed === true && after['Chapter 2']?.readProgress?.completed === true,
        JSON.stringify([after['Chapter 1']?.readProgress, after['Chapter 2']?.readProgress]));
      const c = await byName(comics.id);
      const o = await byName(other.id);
      const numbers = (x) => Object.fromEntries(Object.keys(HAND).map((f) => [f, x[f.replace(/\.cbz$/, '')]?.number]));
      check(`rescan @${t}: the ticked series reads its hand-named files by the new rules`,
        JSON.stringify(numbers(c)) === JSON.stringify(Object.fromEntries(Object.entries(HAND).map(([f, [, n]]) => [f, n]))), JSON.stringify(numbers(c)));
      check(`rescan @${t}: the series not ticked keeps its numbers`,
        JSON.stringify(numbers(o)) === JSON.stringify(Object.fromEntries(Object.entries(HAND).map(([f, [n]]) => [f, n]))), JSON.stringify(numbers(o)));

      // The series page says so, in its words.
      await visit(`/series/?id=${shelf.id}`, 3500);
      const gone = await waitFor(async () => {
        const n = await page.evaluate((w) => [...document.querySelectorAll('[id^="ch-"]')].filter((r) => r.textContent.includes(w)).length, say('File no longer on disk'));
        return n >= 2 ? n : null;
      }, 15_000, 400);
      check(`rescan @${t}: the series page reads "${say('File no longer on disk')}" on both`, gone === 2, String(gone));
      check(`rescan @${t}: and never "${say('Deleted from the server')}"`,
        !(await page.evaluate((w) => document.body.innerText.includes(w), say('Deleted from the server'))));
      check(`rescan @${t}: the series page has no sideways scroll`, await noSideScroll());
      await page.evaluate(() => (document.getElementById('ch-2') ?? document.querySelector('[id^="ch-"]'))?.scrollIntoView({ block: 'center' }));
      await shot(`rescan-${t}-3-series`);
    }

    // A library folder with no file behind any of its chapters looks unmounted: the share not there. Every entry of the
    // folder is moved out beside it, the preview run, and everything put back.
    console.log('\n  rescan: a folder that looks unmounted');
    if (lang() !== 'en') await setLang('en');
    await page.setViewport({ width: 1280, height: 900 });
    const aside = `${lib}.aside`;
    mkdirSync(aside, { recursive: true });
    const entries = readdirSync(lib);
    for (const e of entries) renameSync(join(lib, e), join(aside, e));
    try {
      await visit('/admin/?tab=Tasks', 3500);
      await page.waitForSelector('#task-rescan > button', { timeout: 15_000 });
      await tap(page, '#task-rescan > button');
      const shown = await waitFor(() => page.$('[data-rescan-panel="preview"]'), 90_000, 500);
      const unmounted = shown ? await textOf(page, '[data-rescan-unmounted]') : null;
      check('rescan: a library folder with no file behind its chapters looks unmounted, and nothing under it is touched',
        unmounted === say('{root} looks unmounted. Nothing under it is touched.', { root: '⁨/library⁩' }), JSON.stringify(unmounted));
      check('rescan: and nothing in it is called gone', (await textOf(page, '[data-rescan-headline]')) === say('No chapter file is gone from your folders'));
      check('rescan: Apply has nothing to do', await page.$eval('[data-rescan-apply]', (b) => b.disabled).catch(() => false));
      await page.evaluate(() => { document.querySelector('[data-rescan-panel="preview"]')?.scrollIntoView({ block: 'start' }); window.scrollBy(0, -96); });
      await shot('rescan-1280-4-unmounted');
    } finally {
      for (const e of entries) if (existsSync(join(aside, e))) renameSync(join(aside, e), join(lib, e));
      rmSync(aside, { recursive: true, force: true });
    }
  } catch (e) {
    check('rescan: the phase ran to the end', false, String(e?.stack || e));
  } finally {
    if (lang() !== 'en') await setLang('en').catch(() => {});
  }
}

// ── multisource ─────────────────────────────────────────────────────────────────────────────────────────────────────

export async function multisourceWalk(ctx) {
  const { page, check, waitFor, sleep, base } = ctx;
  const NET = process.env.E2E_NET;
  if (!NET) { check('multisource: E2E_NET names the instance', false); return; }
  const sql = (text) => execFileSync('docker', ['exec', `${NET}-db`, 'psql', '-U', 'postgres', '-d', 'yomi', '-tAqc', text], { encoding: 'utf8' }).trim();
  const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const shot = async (name) => { await sleep(700); await ctx.shot(name); };
  const { call, visit, seriesNamed } = kit(ctx);
  // The fakes' control ports, as up.sh derives them from the app's.
  const port = Number(new URL(base).port);
  const FAKE = { 'fake-a': `http://127.0.0.1:${20_000 + (port % 1000) * 2}`, 'fake-b': `http://127.0.0.1:${20_000 + (port % 1000) * 2 + 1}` };
  const reset = () => Promise.all(Object.values(FAKE).map((f) => fetch(`${f}/__reset`, { method: 'POST' })));
  /** What each fake served since its last reset: the chapter numbers whose pages it listed, and its image requests. */
  const served = async () => Object.fromEntries(await Promise.all(Object.entries(FAKE).map(async ([name, f]) => {
    const log = (await (await fetch(`${f}/__log`)).json()).content ?? [];
    const numbers = [...new Set(log.filter((r) => r.route === 'pages' && r.status === 200).map((r) => Number(String(r.chapter).split('-').pop())))].sort((a, b) => a - b);
    return [name, { numbers, images: log.filter((r) => r.route === 'image') }];
  })));
  const card = async (folder) => ((await call('/api/sources/jobs')).content ?? []).find((x) => x.folder === folder) ?? null;
  /** The series' job card once the job started after `since` (a card per folder: a new job replaces the last) is over. */
  const jobDone = (folder, since) => waitFor(async () => {
    const j = await card(folder);
    return j && j.startedAt > since && j.status !== 'downloading' ? j : null;
  }, 120_000, 500);
  try {
    console.log('\n  multisource @1280');
    await page.setViewport({ width: 1280, height: 900 });
    // Walk Tale from fake-a with nothing yet, following fake-b: the same twelve chapters, no group named, English, twelve
    // pages each -- one release (lib/seriesListing.ts sameRelease) -- on two sites that serve their pages from two hosts.
    await call('/api/sources/add', { json: { source: 'fake-a', sourceId: 'walk-tale', chapterFrom: 'none', autoUpdate: false, alsoFollow: [{ source: 'fake-b', sourceId: 'walk-tale' }] } });
    const s = await waitFor(() => seriesNamed('Walk Tale'), 20_000, 500);
    check('multisource: Walk Tale is in the library', !!s);
    if (!s) return;
    const follows = await waitFor(() => Promise.resolve(sql(`SELECT source_id FROM series_sources WHERE series_id = ${lit(s.id)}`)).then((r) => (r.includes('fake-b') ? r : null)), 20_000, 500);
    check('multisource: it follows fake-b too', !!follows, JSON.stringify(follows));
    const folder = sql(`SELECT folder FROM lib_series WHERE id = ${lit(s.id)}`);

    // Three chapters a person picked from fake-b: each comes from fake-b, and nowhere else.
    await reset();
    const before = (await card(folder))?.startedAt ?? 0;
    await call('/api/sources/fetch', { json: { seriesId: s.id, picks: [1, 2, 3].map((n) => ({ number: n, source: 'fake-b', sourceId: `walk-tale-${n}` })) } });
    const picked = await jobDone(folder, before);
    check('multisource: the picked chapters were fetched', picked?.status === 'done' && picked?.done === 3, JSON.stringify(picked));
    const p = await served();
    check('multisource: a chapter picked from fake-b came from fake-b, every one, and nothing from fake-a',
      JSON.stringify(p['fake-b'].numbers) === '[1,2,3]' && p['fake-a'].numbers.length === 0, JSON.stringify({ a: p['fake-a'].numbers, b: p['fake-b'].numbers }));

    // The series page's "Fetch all" for the other nine: taken from both sites, each chapter once.
    await reset();
    await visit(`/series/?id=${s.id}`, 3500);
    const fetchAll = await waitFor(() => page.evaluateHandle(() => [...document.querySelectorAll('button')]
      .find((b) => /^Fetch all \d+$/.test(b.textContent.trim())) || null).then((h) => h.asElement()), 15_000, 400);
    const label = fetchAll ? await fetchAll.evaluate((b) => b.textContent.trim()) : null;
    check('multisource: the series page offers "Fetch all 9"', label === 'Fetch all 9', JSON.stringify(label));
    if (!fetchAll) return;
    await shot('multisource-1280-1-series');
    const pickedAt = (await card(folder))?.startedAt ?? 0;
    await fetchAll.click();
    const job = await jobDone(folder, pickedAt);
    check('multisource: the Fetch all finished, all nine', job?.status === 'done' && job?.done === 9 && job?.total === 9, JSON.stringify(job));
    const f = await served();
    const a = f['fake-a'].numbers;
    const b = f['fake-b'].numbers;
    check('multisource: both sites served chapters of it (the fakes\' logs)', a.length > 0 && b.length > 0, JSON.stringify({ a, b }));
    check('multisource: each chapter came from one of them, once, and every one came',
      !a.some((n) => b.includes(n)) && JSON.stringify([...a, ...b].sort((x, y) => x - y)) === '[4,5,6,7,8,9,10,11,12]', JSON.stringify({ a, b }));
    // Two image servers at once, a lane each: a chapter on one site still coming in when one on the other began
    // (informational -- the timing is the host's). Each chapter's span runs from its first image asked to its last answered.
    const spans = (images) => Object.values(images.reduce((m, r) => {
      const c = (m[r.chapter] ??= { from: r.at, to: r.doneAt ?? r.at });
      c.from = Math.min(c.from, r.at); c.to = Math.max(c.to, r.doneAt ?? r.at);
      return m;
    }, {}));
    const overlap = spans(f['fake-a'].images).some((x) => spans(f['fake-b'].images).some((y) => x.from < y.to && y.from < x.to));
    console.log(`         fake-a served ${a.join(', ')}; fake-b served ${b.join(', ')}; a chapter on each at the same time: ${overlap ? 'yes' : 'no'}`);
    const books = await call(`/api/series/${s.id}/books?size=100`);
    check('multisource: all twelve chapters are in the library', (books.content ?? []).filter((x) => !x.pruned).length === 12, String(books.content?.length));
    await visit(`/series/?id=${s.id}`, 3500);
    await shot('multisource-1280-2-fetched');
  } catch (e) {
    check('multisource: the phase ran to the end', false, String(e?.stack || e));
  }
}

// ── adultsearch ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * "Walk" on the E2E_ADULT=1 stack: fake-b declares itself 18+. A title only fake-b carries is 18+ by that alone (Walk
 * Tale: Next); one fake-a carries too is not (v0.55.5: a site's own flag never outweighs another site carrying the title
 * unflagged, AllManga's case), so Walk Gap and Walk Tale wear no mark and stay under Hide 18+; Ren's Walk is fake-a's
 * alone. The real MangaDex answers the same search with titles of its own, rated by what MangaDex says -- so the fakes'
 * four are checked by name, and every other card only by the rule of its chip.
 */
const ADULT = ['Walk Tale: Next'];
const CLEAN = ['Ren’s Walk – Notes', 'Walk Gap', 'Walk Tale'];

export async function adultSearchWalk(ctx) {
  const { page, check, waitFor, sleep } = ctx;
  const shot = async (name) => { await sleep(700); await ctx.shot(name); };
  const { say, setLang, visit, noSideScroll, lang } = kit(ctx);
  /** The search wall's cards: each title, and whether it wears the 18+ mark. */
  const cards = () => page.evaluate((label) => [...document.querySelectorAll(`button[aria-label="${label}"]`)]
    .map((b) => ({ title: b.querySelector('p')?.textContent?.trim() ?? '', adult: !!b.querySelector('[data-rating-mark]') }))
    .sort((x, y) => x.title.localeCompare(y.title)), say('Add to library'));
  const chips = () => page.evaluate(() => [...document.querySelectorAll('[data-rating-chips] button')]
    .map((b) => ({ text: b.textContent.trim(), on: b.getAttribute('aria-pressed') === 'true' })));
  const reveal = () => page.evaluateHandle((t) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === t) || null, say('Show 18+')).then((h) => h.asElement());
  /** Show 18+ on or off, by its chip on Discover. */
  const showAdult = async (on) => {
    const chip = await waitFor(reveal, 15_000, 300);
    if (!chip) return false;
    if ((await chip.evaluate((b) => b.getAttribute('aria-pressed'))) !== String(on)) await chip.click();
    return waitFor(async () => (await (await reveal())?.evaluate((b) => b.getAttribute('aria-pressed'))) === String(on), 10_000, 300);
  };
  const search = async (term) => {
    const input = await page.waitForSelector(`input[aria-label="${say('Search all sources…')}"]`, { timeout: 20_000 });
    // Typed until it sticks: a keystroke before the page has hydrated is dropped (walk42's lesson).
    await waitFor(async () => {
      await input.click({ clickCount: 3 });
      await input.type(term);
      await sleep(250);
      return (await input.evaluate((e) => e.value)) === term;
    }, 15_000, 500);
    await page.keyboard.press('Enter');
  };
  /**
   * The wall once it holds every title of `has` and none of `not` (a late source's answer arrives with a poll), and
   * every card on it passes `each`.
   */
  const wall = (has, not, each = () => true) => waitFor(async () => {
    const c = await cards();
    const t = c.map((x) => x.title);
    return has.every((x) => t.includes(x)) && !not.some((x) => t.includes(x)) && c.every(each) ? c : null;
  }, 30_000, 400);
  const fakes = (c) => JSON.stringify((c ?? []).filter((x) => [...ADULT, ...CLEAN].includes(x.title)));
  try {
    for (const [w, l] of PASSES) {
      const t = tag(w, l);
      console.log(`\n  adultsearch @${w}${l === 'ar' ? ' ar' : ''}`);
      if (l !== lang()) await setLang(l);
      await page.setViewport({ width: w, height: w < 1024 ? 844 : 900 });
      await visit('/discover/', 3500);
      check(`adultsearch @${t}: Show 18+ switched on`, !!(await showAdult(true)));
      await search('Walk');
      const all = await wall([...ADULT, ...CLEAN], [], (c) => (ADULT.includes(c.title) ? c.adult : CLEAN.includes(c.title) ? !c.adult : true));
      check(`adultsearch @${t}: All shows every result, the 18+ mark on each 18+ one`, !!all, fakes(all ?? await cards()));
      const row = await chips();
      check(`adultsearch @${t}: the chips read ${say('All')} · ${say('Hide 18+')} · ${say('18+ only')}, All pressed`,
        JSON.stringify(row) === JSON.stringify([{ text: say('All'), on: true }, { text: say('Hide 18+'), on: false }, { text: say('18+ only'), on: false }]), JSON.stringify(row));
      check(`adultsearch @${t}: no sideways scroll`, await noSideScroll());
      await page.evaluate(() => document.querySelector('[data-rating-chips]')?.scrollIntoView({ block: 'center' }));
      await shot(`adultsearch-${t}-1-all`);

      await page.evaluate((x) => [...document.querySelectorAll('[data-rating-chips] button')].find((b) => b.textContent.trim() === x)?.click(), say('Hide 18+'));
      const safe = await wall(CLEAN, ADULT, (c) => !c.adult);
      check(`adultsearch @${t}: Hide 18+ keeps every title a site with no 18+ flag carries too, and nothing marked`, !!safe, fakes(safe ?? await cards()));
      await shot(`adultsearch-${t}-2-hide`);

      await page.evaluate((x) => [...document.querySelectorAll('[data-rating-chips] button')].find((b) => b.textContent.trim() === x)?.click(), say('18+ only'));
      const adult = await wall(ADULT, CLEAN, (c) => c.adult);
      check(`adultsearch @${t}: 18+ only shows the 18+ results, each marked`, !!adult, fakes(adult ?? await cards()));
      await shot(`adultsearch-${t}-3-only`);

      // Show 18+ off: no chips, and the search holds no 18+ result (fake-b is not asked; Walk Tale and Walk Gap come
      // from fake-a, where nothing says they are 18+).
      await page.evaluate((x) => [...document.querySelectorAll('[data-rating-chips] button')].find((b) => b.textContent.trim() === x)?.click(), say('All'));
      check(`adultsearch @${t}: Show 18+ switched off`, !!(await showAdult(false)));
      const off = await wall(['Ren’s Walk – Notes', 'Walk Gap', 'Walk Tale'], ['Walk Tale: Next'], (c) => !c.adult);
      check(`adultsearch @${t}: with Show 18+ off the search shows no 18+ result and no mark`, !!off, fakes(off ?? await cards()));
      check(`adultsearch @${t}: and no chips`, (await chips()).length === 0, JSON.stringify(await chips()));
      await shot(`adultsearch-${t}-4-off`);
    }
  } catch (e) {
    check('adultsearch: the phase ran to the end', false, String(e?.stack || e));
  } finally {
    if (lang() !== 'en') await setLang('en').catch(() => {});
  }
}
