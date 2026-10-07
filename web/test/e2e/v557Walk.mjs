// walk49's v0.55.7 phases, through the browser on the real routes: matches (#168), rescanmerge (#150), readeredges
// (#170) and lists (#164). Each needs a stack of its own:
//
//   matches -- up.sh with E2E_ANILIST=1 (a fake AniList, fakeAniList.mjs, as ANILIST_API_URL: nothing here asks the real
//     one), LIB naming its library folder and E2E_NET its network. Two folders collected by hand, neither on any source:
//     "Walk Morgan Lost", whose title the fake AniList answers with ANOTHER work (Kedryn's comic given a manga's cover),
//     and "Walk Nightfall", which AniList knows by that very name. Their pages opened: Morgan Lost stores a miss -- no
//     cover, banner or link, so it shows its own first page -- and Nightfall the entry's cover, banner and an automatic,
//     checked link. Then, at 1280, 390 and 390 in Arabic, Edit details -> Cover: the ⋯ offers Use the first page (and
//     Reset to automatic once there is a choice to take back), the line under the cover says what automatic is, and
//     Use the first page sticks across a reload -- and, once, a library scan -- with no new AniList lookup for it. Admin
//     -> Art's picker has its own Use the first page; Admin -> Tasks -> Check online matches runs and says what it did.
//
//   rescanmerge -- a plain up.sh stack, LIB and E2E_NET. Per pass, Zagor unpacked by hand into two folders of two chapters,
//     each a series, one chapter read and the first in a list; then every file moved into one folder "Zagor", and in
//     another folder a file renamed within its series after it was read. Admin -> Tasks -> Rescan everything: the
//     preview offers "Merge “Zagor … 1-2” into “Zagor …”" for both, says the renamed chapter follows its file; both
//     ticked, Apply: one series of four chapters, each once, the read mark carried, the old ones gone from the Library,
//     the list holding the survivor; the renamed chapter shows once with its read mark. In the 390 pass the old rows were
//     never fingerprinted (as @Kedryn's most likely were), so the files are recognised by name and time.
//
//   readeredges -- a plain up.sh stack. At 1280, 390 and 390 in Arabic: the reader on Mixed Formats (a red cover) with
//     Cover colour at the edges on, the default -- both washes there; switched off in Profile -> Settings -> Reading, the
//     reader has neither; back on from the reader's own sheet. Then the bars: with the page made white under them and
//     framer's clock slowed ten times, the bars shown and caught mid-spring -- the strip between the screen edge and a bar
//     that has overshot is dark (the bar's pane), and with the panes taken away the same strip is white: the check sees
//     a gap when there is one.
//
//   lists -- a plain up.sh stack, LIB. Five series of hand-made chapters (one with 120, for "99+"), some read, at file
//     times of their own, in a list in an order of its own. At 1280, 390 and 390 in Arabic: each item's unread badge is
//     the Library's number ("99+" left to right in Arabic too), and every sort order puts them as it says -- the list's
//     own order, A–Z, Z–A, Last read, Most unread, Latest chapter -- from the chips (a row from lg, the "Sort by" sheet on
//     a phone); the chosen order survives a reload; Edit's keys; and the Lists page's words in each language.
//
// Every view: no sideways scroll. walk49 counts the console errors and 5xx of the whole walk. Screenshots:
// <phase>-<pass>-<n>-<what>.png in walk49's OUT. LOOK at them.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { kit, writeShelf } from './filenamesWalk.mjs';

const PASSES = [[1280, 'en'], [390, 'en'], [390, 'ar']];
const tag = (w, l) => `${w}${l === 'ar' ? 'ar' : ''}`;
/** The text of the first element `sel` matches, its white space folded; null when there is none or it is hidden. */
const textOf = (page, sel) => page.evaluate((s) => {
  const e = document.querySelector(s);
  return e && e.getClientRects().length ? e.textContent.replace(/\s+/g, ' ').trim() : null;
}, sel);
/** A DOM click on the first element `sel` matches (a phone's bottom nav sits over rows near the bottom). */
const tap = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); e?.click(); return !!e; }, sel);
/** The instance's database, as the walk's own `docker exec` reads it. */
const sqlOf = (NET) => (text) => execFileSync('docker', ['exec', `${NET}-db`, 'psql', '-U', 'postgres', '-d', 'yomi', '-tAqc', text], { encoding: 'utf8' }).trim();
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
/** Bidi isolates around a name inside a sentence, as the app puts them (lib/rescan.ts iso). */
const iso = (s) => `⁨${s}⁩`;

// ── matches ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const MORGAN = 'Walk Morgan Lost';
const NIGHT = 'Walk Nightfall';

export async function matchesWalk(ctx) {
  const { page, check, waitFor, sleep, lib, base } = ctx;
  const NET = process.env.E2E_NET;
  if (!lib || !NET) { check('matches: LIB names the library folder and E2E_NET the instance (up.sh prints both with KEEP=1)', false); return; }
  const sql = sqlOf(NET);
  const shot = async (name) => { await sleep(700); await ctx.shot(name); };
  const { call, say, setLang, visit, noSideScroll, seriesNamed, scan, lang } = kit(ctx);
  // The fake AniList's control port, as up.sh derives it from the app's (E2E_ANILIST=1).
  const ANILIST = `http://127.0.0.1:${28_000 + (Number(new URL(base).port) % 1000)}`;
  const asked = async () => (await (await fetch(`${ANILIST}/__log`)).json());
  const searchesFor = async (t) => (await asked()).filter((r) => r.kind === 'search' && String(r.s).toLowerCase() === t.toLowerCase()).length;
  const art = (id) => sql(`SELECT coalesce(banner, '-') || '|' || coalesce(cover, '-') FROM series_art WHERE series_id = ${lit(id)}`);
  const link = (id) => sql(`SELECT external_id || '|' || (linked_by IS NULL) || '|' || (checked_at IS NOT NULL) FROM series_trackers WHERE series_id = ${lit(id)} AND provider = 'anilist'`);
  const override = (id) => sql(`SELECT coalesce(cover, '-') FROM series_overrides WHERE series_id = ${lit(id)}`);
  const openEditor = async () => {
    await page.evaluate((label) => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(label))?.click(), say('Edit details'));
    const opened = await waitFor(() => page.$('[data-series-editor]'), 10_000, 200);
    // The cover's keys are on the Art tab where the editor has one (a phone), beside the details where it has not.
    await page.evaluate(() => { const t = document.querySelector('[data-edit-tab="art"]'); if (t && t.getClientRects().length) t.click(); });
    await waitFor(() => page.$('[data-art-more="cover"]'), 10_000, 200);
    return !!opened;
  };
  const coverMenu = async () => {
    // Scrolled first, and given a moment: a menu closes on any scroll (components/ContextMenu.tsx), and the scroll event
    // of a scrollIntoView lands after the click that opened it.
    await page.evaluate(() => document.querySelector('[data-art-more="cover"]')?.scrollIntoView({ block: 'center' }));
    await sleep(500);
    await tap(page, '[data-art-more="cover"]');
    return waitFor(() => page.evaluate(() => {
      const items = [...document.querySelectorAll('[role="menu"] [data-menu-item]')];
      return items.length ? Object.fromEntries(items.map((i) => [i.getAttribute('data-menu-item'), !i.disabled])) : null;
    }), 5000, 150);
  };
  try {
    check('matches: the fake AniList answers (up.sh with E2E_ANILIST=1)', Array.isArray(await asked().catch(() => null)));
    console.log('\n  matches: two folders with no online source');
    writeShelf(lib, `Hand Made/${MORGAN}`, { 'Morgan Lost 001.cbz': 3, 'Morgan Lost 002.cbz': 3 });
    writeShelf(lib, `Hand Made/${NIGHT}`, { 'Nightfall 001.cbz': 3, 'Nightfall 002.cbz': 3 });
    await scan();
    const morgan = await seriesNamed(MORGAN);
    const night = await seriesNamed(NIGHT);
    check('matches: both folders are series', !!(morgan && night));
    if (!morgan || !night) return;
    // Their pages ask for their art: the first look AniList's search (the fake), stored either way.
    await page.setViewport({ width: 1280, height: 900 });
    for (const s of [morgan, night]) {
      await visit(`/series/?id=${s.id}`, 3500);
      await waitFor(async () => art(s.id) || null, 30_000, 500);
    }
    check(`matches: AniList was asked about "${MORGAN}" and "${NIGHT}" (the fake, by title)`,
      (await searchesFor(MORGAN)) >= 1 && (await searchesFor(NIGHT)) >= 1, JSON.stringify(await asked()));
    // Another work's answer is a miss: nothing of it stored -- no cover, no banner, no link.
    check(`matches: "${MORGAN}", answered with another work, stores no cover, banner or link`,
      art(morgan.id) === '-|-' && link(morgan.id) === '', JSON.stringify({ art: art(morgan.id), link: link(morgan.id) }));
    // Its cover is its own first page: what the thumbnail route serves with nothing stored (and a request for it is no error).
    // Asked as the page asks it, with the session's own cookie.
    const thumb = await page.evaluate(async (u) => { const r = await fetch(u); return { status: r.status, type: r.headers.get('content-type') }; },
      `/img/series/${encodeURIComponent(morgan.id)}/thumb?v=2`);
    check(`matches: "${MORGAN}"'s thumbnail is its first page`, thumb.status === 200 && /^image\//.test(thumb.type ?? ''), JSON.stringify(thumb));
    // The entry named as the series is: its cover and banner stored, and the link -- automatic and checked.
    const nightArt = art(night.id);
    check(`matches: "${NIGHT}", AniList's own entry for it, stores its cover and banner`,
      /\/media\/manga\/banner\/970002-walk\.png\|.*\/media\/manga\/cover\/large\/bx970002-walk\.png$/.test(nightArt), nightArt);
    check(`matches: and its AniList link, automatic and checked`, link(night.id) === '970002|true|true', link(night.id));

    for (const [w, l] of PASSES) {
      const t = tag(w, l);
      console.log(`\n  matches @${w}${l === 'ar' ? ' ar' : ''}`);
      if (l !== lang()) await setLang(l);
      await page.setViewport({ width: w, height: w < 1024 ? 844 : 900 });
      // Morgan Lost as a reader meets it: its own first page for a cover, its pages for a backdrop.
      await visit(`/series/?id=${morgan.id}`, 3000);
      check(`matches @${t}: the series page has no sideways scroll`, await noSideScroll());
      await shot(`matches-${t}-1-first-page`);
      await visit(`/series/?id=${night.id}`, 3500);
      check(`matches @${t}: Edit details opens`, await openEditor());
      // An earlier pass left the first page chosen: Reset to automatic takes it back first.
      let menu = await coverMenu();
      if (menu?.['cover-reset'] && override(night.id) === 'first_page') {
        await tap(page, '[data-menu-item="cover-reset"]');
        await waitFor(async () => (override(night.id) === '-' || override(night.id) === '' ? true : null), 10_000, 300);
        await sleep(800);
        menu = await coverMenu();
      }
      const auto = await textOf(page, '[data-art-cover-note]');
      check(`matches @${t}: the line under the cover says what automatic is`,
        auto === say('Automatic: the source’s cover, or AniList’s when its entry has the same name, else the first page.'), JSON.stringify(auto));
      check(`matches @${t}: the cover's ⋯ offers Use the first page`, menu?.['cover-first-page'] === true, JSON.stringify(menu));
      check(`matches @${t}: Edit details has no sideways scroll`, await noSideScroll());
      await shot(`matches-${t}-2-cover-menu`);
      await tap(page, '[data-menu-item="cover-first-page"]');
      const chosen = await waitFor(async () => (override(night.id) === 'first_page' ? true : null), 10_000, 300);
      check(`matches @${t}: Use the first page is stored`, !!chosen, override(night.id));
      const note = await waitFor(async () => {
        const n = await textOf(page, '[data-art-cover-note]');
        return n === say('The first page, by your choice: nothing found online replaces it.') ? n : null;
      }, 10_000, 300);
      check(`matches @${t}: and the line says it stays whatever is found online`, !!note, JSON.stringify(await textOf(page, '[data-art-cover-note]')));
      const after = await coverMenu();
      check(`matches @${t}: the ⋯ now offers Reset to automatic, and not the first page again`,
        after?.['cover-reset'] === true && after?.['cover-first-page'] === false, JSON.stringify(after));
      await page.keyboard.press('Escape');
      await sleep(400);
      await shot(`matches-${t}-3-first-page-chosen`);
      // A reload keeps it, and asks AniList nothing more about the series.
      const before = await searchesFor(NIGHT);
      await visit(`/series/?id=${night.id}`, 3500);
      await openEditor();
      const kept = await textOf(page, '[data-art-cover-note]');
      check(`matches @${t}: after a reload the cover is still the first page`,
        override(night.id) === 'first_page' && kept === say('The first page, by your choice: nothing found online replaces it.'), JSON.stringify(kept));
      check(`matches @${t}: and AniList was not asked about it again`, (await searchesFor(NIGHT)) === before, `${before} -> ${await searchesFor(NIGHT)}`);
      await page.keyboard.press('Escape');
      await sleep(300);
    }
    if (lang() !== 'en') await setLang('en');

    // A library scan changes nothing of it.
    const before = await searchesFor(NIGHT);
    await scan();
    check('matches: a library scan leaves the first page chosen', override(night.id) === 'first_page', override(night.id));
    await page.setViewport({ width: 1280, height: 900 });
    await visit(`/series/?id=${night.id}`, 3500);
    check('matches: and the series page after it asks AniList nothing', (await searchesFor(NIGHT)) === before, `${before} -> ${await searchesFor(NIGHT)}`);
    await shot('matches-1280-4-after-scan');

    // Admin -> Art's picker: its own Use the first page. Its candidates are asked of AniList, Kitsu and MangaDex, so the
    // request is stopped here -- no walk asks a real service -- and the picker says it found none. Past the service worker,
    // which would otherwise make the request itself, out of the page's reach.
    console.log('\n  matches: Admin → Art');
    const stop = (r) => (r.url().includes('/api/admin/art/candidates/') ? r.abort() : r.continue());
    await page.setBypassServiceWorker(true);
    await page.setRequestInterception(true);
    page.on('request', stop);
    try {
      await visit('/admin/?tab=Art', 3500);
      await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'All')?.click());
      await sleep(600);
      const opened = await page.evaluate((title) => {
        const b = [...document.querySelectorAll('button')].find((x) => x.querySelector('p')?.textContent?.trim() === title);
        b?.click();
        return !!b;
      }, MORGAN);
      check(`matches: Admin → Art lists "${MORGAN}"`, opened);
      const key = await waitFor(() => page.$('[data-art-first-page]'), 10_000, 200);
      check('matches: the picker offers Use the first page', !!key);
      // And its candidates were never asked for: the request was stopped before it left the browser.
      const none = await waitFor(() => page.evaluate(() => /No candidates found/.test(document.querySelector('[role="dialog"]')?.textContent ?? '') || null), 10_000, 200);
      check('matches: the picker asked no service (its candidates request stopped in the browser)', !!none);
      await shot('matches-1280-5-art-picker');
      await tap(page, '[data-art-first-page]');
      const done = await waitFor(async () => (override(morgan.id) === 'first_page' ? true : null), 10_000, 300);
      check(`matches: the picker's Use the first page is stored for "${MORGAN}"`, !!done, override(morgan.id));
      await page.keyboard.press('Escape');
    } finally {
      page.off('request', stop);
      await page.setRequestInterception(false);
      await page.setBypassServiceWorker(false);
    }

    // Admin -> Tasks -> Check online matches: Run now checks every automatic match again -- Nightfall's link, by id.
    console.log('\n  matches: Admin → Tasks');
    for (const [w, l] of PASSES) {
      const t = tag(w, l);
      if (l !== lang()) await setLang(l);
      await page.setViewport({ width: w, height: w < 1024 ? 844 : 900 });
      await visit('/admin/?tab=Tasks', 3500);
      const name = await waitFor(() => textOf(page, '#task-matches p'), 15_000, 300);
      check(`matches @${t}: Admin → Tasks lists ${say('Check online matches')}`, name === say('Check online matches'), JSON.stringify(name));
      if (w === 1280) {
        await tap(page, '#task-matches > button');
        const line = await waitFor(async () => {
          const s = await textOf(page, '#task-matches');
          return s?.includes(say('1 match checked')) ? s : null;
        }, 60_000, 1000);
        check('matches: Run now checks the one automatic link and says so', !!line, JSON.stringify(await textOf(page, '#task-matches')));
        check('matches: by id, of the fake AniList', (await asked()).some((r) => r.kind === 'ids' && (r.ids ?? []).includes(970002)), JSON.stringify(await asked()));
        check('matches: and the link it checked stays', link(night.id) === '970002|true|true', link(night.id));
      }
      await page.evaluate(() => document.getElementById('task-matches')?.scrollIntoView({ block: 'center' }));
      check(`matches @${t}: Admin → Tasks has no sideways scroll`, await noSideScroll());
      await shot(`matches-${t}-6-tasks`);
    }
  } catch (e) {
    check('matches: the phase ran to the end', false, String(e?.stack || e));
  } finally {
    if (lang() !== 'en') await setLang('en').catch(() => {});
  }
}

// ── rescanmerge ─────────────────────────────────────────────────────────────────────────────────────────────────────

const ZDIR = 'Hand Made';
const ZAGOR = (t) => `Zagor ${t}`;
const PART = (t, p) => `Zagor ${t} ${p}`;
const RENAMED = (t) => `Renamed ${t}`;

export async function rescanMergeWalk(ctx) {
  const { page, check, waitFor, sleep, lib } = ctx;
  const NET = process.env.E2E_NET;
  if (!lib || !NET) { check('rescanmerge: LIB names the library folder and E2E_NET the instance (up.sh prints both with KEEP=1)', false); return; }
  const sql = sqlOf(NET);
  const shot = async (name) => { await sleep(700); await ctx.shot(name); };
  const { call, say, setLang, visit, noSideScroll, seriesNamed, scan, lang } = kit(ctx);
  const byName = async (id) => Object.fromEntries(((await call(`/api/series/${id}/books?size=100`)).content ?? []).map((b) => [b.name, b]));
  const at = (...p) => join(lib, ZDIR, ...p);
  try {
    console.log('\n  rescanmerge: the folders');
    for (const [w, l] of PASSES) {
      const t = tag(w, l);
      writeShelf(lib, `${ZDIR}/${PART(t, '1-2')}`, { 'Zagor 001.cbz': 3, 'Zagor 002.cbz': 3 });
      writeShelf(lib, `${ZDIR}/${PART(t, '3-4')}`, { 'Zagor 003.cbz': 3, 'Zagor 004.cbz': 3 });
      writeShelf(lib, `${ZDIR}/${RENAMED(t)}`, { 'Chapter 1.cbz': 3, 'Chapter 2.cbz': 3 });
    }
    // The 390 pass's Zagor files get whole-second times of their own: its rows are paired by name and time below, and a
    // file of another pass with the same name must not share one.
    const T0 = Math.floor(Date.now() / 1000) - 5000;
    ['Zagor 001.cbz', 'Zagor 002.cbz', 'Zagor 003.cbz', 'Zagor 004.cbz'].forEach((f, i) => {
      const dir = i < 2 ? PART('390', '1-2') : PART('390', '3-4');
      utimesSync(at(dir, f), T0 + i, T0 + i);
    });
    await scan();
    // Every file fingerprinted, as the background pass does in time.
    await call('/api/admin/tasks/fingerprint/run', { json: {} });
    const unprinted = await waitFor(() => Promise.resolve(sql(`SELECT count(*) FROM lib_books WHERE file LIKE ${lit(`${ZDIR}/%`)} AND fp_at IS NULL`)).then((n) => (n === '0' ? n : null)), 60_000, 1000);
    check('rescanmerge: every hand-made file is fingerprinted', unprinted === '0');
    // The 390 pass: Zagor as @Kedryn's most likely was -- never fingerprinted before the move. fp_at stays, as a failed
    // read leaves it, so no pass reads the rows again (their files are gone by then anyway).
    sql(`UPDATE lib_books SET fingerprint = NULL, fp_kind = 'error', size = NULL WHERE file LIKE ${lit(`${ZDIR}/Zagor 390 %`)}`);
    const { id: listId } = await call('/api/collections', { json: { name: 'Zagor shelf' } });

    for (const [w, l] of PASSES) {
      const t = tag(w, l);
      console.log(`\n  rescanmerge @${w}${l === 'ar' ? ' ar' : ''}`);
      if (l !== lang()) await setLang(l);
      await page.setViewport({ width: w, height: w < 1024 ? 844 : 900 });
      const [p1, p2, ren] = [await seriesNamed(PART(t, '1-2')), await seriesNamed(PART(t, '3-4')), await seriesNamed(RENAMED(t))];
      check(`rescanmerge @${t}: the two Zagor folders and the other are series`, !!(p1 && p2 && ren));
      if (!p1 || !p2 || !ren) continue;
      // Read: Zagor 001, and the chapter about to be renamed. Zagor 1-2 in the list.
      const z = await byName(p1.id);
      await call(`/api/books/${z['Zagor 001'].id}/progress`, { method: 'PUT', json: { page: 3, completed: true } });
      const r = await byName(ren.id);
      await call(`/api/books/${r['Chapter 2'].id}/progress`, { method: 'PUT', json: { page: 3, completed: true } });
      await call(`/api/collections/${listId}/items`, { json: { seriesId: p1.id } });
      check(`rescanmerge @${t}: ${t === '390' ? 'the Zagor rows were never fingerprinted' : 'the Zagor rows are fingerprinted'}`,
        sql(`SELECT count(*) FROM lib_books WHERE file LIKE ${lit(`${ZDIR}/Zagor ${t} %`)} AND fingerprint IS NULL`) === (t === '390' ? '4' : '0'));
      // By hand: every Zagor file into one folder, the old folders gone; a read chapter renamed in place.
      mkdirSync(at(ZAGOR(t)), { recursive: true });
      for (const [part, files] of [['1-2', ['Zagor 001.cbz', 'Zagor 002.cbz']], ['3-4', ['Zagor 003.cbz', 'Zagor 004.cbz']]]) {
        for (const f of files) renameSync(at(PART(t, part), f), at(ZAGOR(t), f));
        rmSync(at(PART(t, part)), { recursive: true, force: true });
      }
      renameSync(at(RENAMED(t), 'Chapter 2.cbz'), at(RENAMED(t), 'Chapter 02.cbz'));

      // Start: the preview.
      await visit('/admin/?tab=Tasks', 3500);
      await page.waitForSelector('#task-rescan > button', { timeout: 15_000 });
      await tap(page, '#task-rescan > button');
      const shown = await waitFor(() => page.$('[data-rescan-panel="preview"]'), 90_000, 500);
      check(`rescanmerge @${t}: Start ends in the preview`, !!shown);
      if (!shown) continue;
      const zagor = await seriesNamed(ZAGOR(t));
      check(`rescanmerge @${t}: the scan made "${ZAGOR(t)}"`, !!zagor);
      const offers = await page.evaluate(() => [...document.querySelectorAll('[data-rescan-merge]')].map((e) => ({
        id: e.getAttribute('data-rescan-merge'), label: e.closest('label')?.textContent?.replace(/\s+/g, ' ').trim() ?? '' })));
      const label = (from) => say('Merge “{from}” into “{into}”', { from: iso(from), into: iso(ZAGOR(t)) });
      check(`rescanmerge @${t}: the preview offers both merges into "${ZAGOR(t)}"`,
        [p1, p2].every((p) => offers.some((o) => o.id === p.id && o.label.includes(label(p.name)))), JSON.stringify(offers));
      const follow = await textOf(page, '[data-rescan-follow]');
      check(`rescanmerge @${t}: and says the renamed chapter follows its file`,
        follow === say('1 file was moved or renamed within its series: on Apply its chapter follows it, reading history kept'), JSON.stringify(follow));
      const headline = await textOf(page, '[data-rescan-headline]');
      check(`rescanmerge @${t}: nothing is called gone`, !!headline && headline.startsWith(say('No chapter file is gone from your folders')), JSON.stringify(headline));
      for (const p of [p1, p2]) await tap(page, `[data-rescan-merge="${p.id}"]`);
      check(`rescanmerge @${t}: no sideways scroll`, await noSideScroll());
      await page.evaluate(() => { document.querySelector('[data-rescan-merges]')?.scrollIntoView({ block: 'center' }); });
      await shot(`rescanmerge-${t}-1-preview`);

      // Apply.
      await tap(page, '[data-rescan-apply]');
      const merged = say('{n} series merged into the series their files went to', { n: 2 });
      const result = await waitFor(async () => {
        const s = await textOf(page, '#task-rescan');
        return s?.includes(merged) && !(await page.$('[data-rescan-panel="running"]')) ? s : null;
      }, 60_000, 500);
      check(`rescanmerge @${t}: Apply says both series were merged`, !!result, JSON.stringify(await textOf(page, '#task-rescan')));
      await page.evaluate(() => document.getElementById('task-rescan')?.scrollIntoView({ block: 'center' }));
      await shot(`rescanmerge-${t}-2-result`);

      // One series, each chapter once, the read mark on the row that holds it; the old series gone from the Library.
      const books = await byName(zagor.id);
      check(`rescanmerge @${t}: "${ZAGOR(t)}" holds the four chapters, each once`,
        JSON.stringify(Object.keys(books).sort()) === JSON.stringify(['Zagor 001', 'Zagor 002', 'Zagor 003', 'Zagor 004']), JSON.stringify(Object.keys(books)));
      check(`rescanmerge @${t}: Zagor 001 is the row that was read, its read mark kept`,
        books['Zagor 001']?.id === z['Zagor 001'].id && books['Zagor 001']?.readProgress?.completed === true, JSON.stringify(books['Zagor 001']?.readProgress));
      check(`rescanmerge @${t}: the old series are gone from the Library`, !(await seriesNamed(PART(t, '1-2'))) && !(await seriesNamed(PART(t, '3-4'))));
      const list = await call(`/api/collections/${listId}`);
      check(`rescanmerge @${t}: the list that held "${PART(t, '1-2')}" holds "${ZAGOR(t)}", once`,
        list.items.filter((s) => s.id === zagor.id).length === 1 && !list.items.some((s) => s.id === p1.id), JSON.stringify(list.items.map((s) => s.name)));
      const renamed = await byName(ren.id);
      check(`rescanmerge @${t}: the renamed chapter shows once, as its own row, its read mark kept`,
        !renamed['Chapter 2'] && renamed['Chapter 02']?.id === r['Chapter 2'].id && renamed['Chapter 02']?.readProgress?.completed === true,
        JSON.stringify(Object.fromEntries(Object.entries(renamed).map(([n, b]) => [n, [b.id === r['Chapter 2'].id, b.readProgress?.completed ?? null]]))));

      await visit(`/series/?id=${zagor.id}`, 3500);
      const rows = await page.evaluate(() => document.querySelectorAll('[id^="ch-"]').length);
      check(`rescanmerge @${t}: the series page lists four chapters`, rows === 4, String(rows));
      check(`rescanmerge @${t}: the series page has no sideways scroll`, await noSideScroll());
      await shot(`rescanmerge-${t}-3-series`);
      await visit(`/collection/?id=${listId}`, 3500);
      await shot(`rescanmerge-${t}-4-list`);
    }
  } catch (e) {
    check('rescanmerge: the phase ran to the end', false, String(e?.stack || e));
  } finally {
    if (lang() !== 'en') await setLang('en').catch(() => {});
  }
}

// ── readeredges ─────────────────────────────────────────────────────────────────────────────────────────────────────

export async function readerEdgesWalk(ctx) {
  const { page, check, waitFor, sleep } = ctx;
  const shot = async (name, p = page) => { await sleep(700); await ctx.shot(name, p); };
  const { call, say, setLang, visit, noSideScroll, seriesNamed, lang } = kit(ctx);
  const edges = (p = page) => p.evaluate(() => [...document.querySelectorAll('[data-cover-edge]')].map((e) => e.getAttribute('data-cover-edge')).sort().join(','));
  /** The switch named `label` (under `scope`): 'true' / 'false', or null when there is none; `press` clicks it. */
  const switchOf = (label, scope = 'body', press = false) => page.evaluate((l, sc, pr) => {
    const e = [...(document.querySelector(sc)?.querySelectorAll('[role="switch"]') ?? [])].find((x) => x.getAttribute('aria-label') === l);
    if (!e) return null;
    e.scrollIntoView({ block: 'center' });
    if (pr) e.click();
    return e.getAttribute('aria-checked');
  }, label, scope, press);
  try {
    const mixed = await seriesNamed('Mixed Formats');
    check('readeredges: the seeded Mixed Formats is there', !!mixed);
    if (!mixed) return;
    const first = ((await call(`/api/series/${mixed.id}/books?size=10`)).content ?? []).find((b) => /001/.test(b.name));
    check('readeredges: and its first chapter', !!first);
    if (!first) return;
    const color = await call(`/api/series/${mixed.id}/color`).catch(() => null);
    console.log(`         cover colour ${JSON.stringify(color)}`);
    const reader = async () => {
      await visit(`/reader/?book=${encodeURIComponent(first.id)}`, 4000);
      await waitFor(() => page.$('img[alt^="Page"]'), 20_000, 300);
    };
    for (const [w, l] of PASSES) {
      const t = tag(w, l);
      console.log(`\n  readeredges @${w}${l === 'ar' ? ' ar' : ''}`);
      if (l !== lang()) await setLang(l);
      await page.setViewport({ width: w, height: w < 1024 ? 844 : 900 });
      const name = say('Cover colour at the edges');
      // On, by default (an earlier pass leaves it on).
      await reader();
      check(`readeredges @${t}: the reader has both cover-colour edges, by default`, (await edges()) === 'bottom,top', await edges());
      await shot(`readeredges-${t}-1-edges-on`);
      // Off from Profile -> Settings -> Reading.
      await visit('/profile/?tab=Settings', 3500);
      const there = await waitFor(() => switchOf(name), 15_000, 300);
      check(`readeredges @${t}: Profile → Settings → Reading has "${name}", on`, there === 'true', String(there));
      await switchOf(name, 'body', true);
      const off = await waitFor(async () => ((await switchOf(name)) === 'false' ? true : null), 10_000, 200);
      check(`readeredges @${t}: switched off`, !!off);
      // Reader settings reach the account 1.5 s after the last change (lib/readerPrefs.ts queueSync), and a page loaded
      // before then adopts the account's older value: a person who reloads at once loses the change -- as every reader
      // setting does, not this one only. The walk waits it out.
      await sleep(2500);
      check(`readeredges @${t}: Settings has no sideways scroll`, await noSideScroll());
      await shot(`readeredges-${t}-2-setting-off`);
      await reader();
      check(`readeredges @${t}: off, the reader has neither edge`, (await edges()) === '', await edges());
      await shot(`readeredges-${t}-3-edges-off`);
      // Back on from the reader's own sheet: the same setting.
      await page.mouse.click(Math.round(w / 2), Math.round((w < 1024 ? 844 : 900) / 2));
      await sleep(900);
      if (!(await page.$('[data-reader-settings]'))) { await page.mouse.click(Math.round(w / 2), Math.round((w < 1024 ? 844 : 900) / 2)); await sleep(900); }
      await tap(page, '[data-reader-settings]');
      const sheet = await waitFor(() => switchOf(name, '[role="dialog"]'), 10_000, 200);
      check(`readeredges @${t}: the reader's sheet has "${name}", off`, sheet === 'false', String(sheet));
      await shot(`readeredges-${t}-4-sheet`);
      await switchOf(name, '[role="dialog"]', true);
      const back = await waitFor(async () => ((await edges()) === 'bottom,top' ? true : null), 10_000, 200);
      check(`readeredges @${t}: switched on there, both edges are back`, !!back, await edges());
      await page.keyboard.press('Escape');
      await sleep(2500); // the account's copy (above)
    }
    if (lang() !== 'en') await setLang('en');

    // The bars' edge, caught mid-spring. A page of its own: framer-motion times every animation by performance.now(),
    // slowed here ten times so frames land inside the overshoot (about 8 px, around 170 ms at speed). Under the bars
    // the page is made white, whatever it holds, so a gap at the screen edge reads white and the bar's pane dark --
    // and the strip between the edge and a bar that overshot is compared with the bar's own edge beside it: no hard line.
    console.log('\n  readeredges: the bars at the screen edge');
    const H = 844;
    for (const variant of ['panes', 'no panes']) {
      const p = await page.browser().newPage();
      try {
        await p.evaluateOnNewDocument(() => {
          const real = performance.now.bind(performance);
          const t0 = real();
          performance.now = () => t0 + (real() - t0) / 10;
        });
        await p.setViewport({ width: 390, height: H, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
        await p.goto(`${ctx.base}/reader/?book=${encodeURIComponent(first.id)}`, { waitUntil: 'networkidle2', timeout: 60_000 });
        await waitFor(() => p.$('img[alt^="Page"]'), 20_000, 300);
        await p.addStyleTag({ content: 'div.fixed.inset-0 { background: #fff !important; }'
          + ' div.fixed.inset-0 *:not(header):not(footer):not(header *):not(footer *) { background: transparent !important; }'
          + ' div.fixed.inset-0 img { opacity: 0 !important; }'
          + (variant === 'no panes' ? ' header::before, footer::after { display: none !important; }' : '') });
        // The bars hide by themselves a few seconds after the reader opens; wait until they have, exit and all.
        const hid = await p.waitForFunction(() => !document.querySelector('div.fixed.inset-0 > header'), { timeout: 90_000, polling: 100 }).then(() => true, () => false);
        check(`readeredges (${variant}): the bars hid by themselves`, hid);
        await sleep(500);
        await p.mouse.click(195, 422);
        const t0 = Date.now();
        let best = null;
        while (Date.now() - t0 < 4000) {
          const m = await p.evaluate(() => {
            const h = document.querySelector('div.fixed.inset-0 > header');
            const f = document.querySelector('div.fixed.inset-0 > footer');
            return h && f ? { top: h.getBoundingClientRect().top, bottom: innerHeight - f.getBoundingClientRect().bottom } : null;
          });
          // Below the edge by at least 4 px, the furthest frame kept: the strip above the bar is what a gap would show.
          if (m && m.top >= 4 && (!best || m.top > best.top)) best = { ...m, png: await p.screenshot() };
          await sleep(15);
        }
        check(`readeredges (${variant}): a frame inside the spring's overshoot was caught`, !!best);
        if (!best) continue;
        const { data, info } = await sharp(best.png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const rows = (y0, y1) => {
          let sum = 0, n = 0;
          for (let y = Math.max(0, y0); y < Math.min(info.height, y1); y++) {
            for (let x = 0; x < info.width; x++) {
              const i = (y * info.width + x) * info.channels;
              sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
              n++;
            }
          }
          return Math.round(sum / Math.max(1, n));
        };
        // Above the top bar, and its own first rows; below the bottom bar, and its own last rows.
        const top = Math.floor(best.top), bottom = Math.floor(best.bottom);
        const m = {
          top: best.top.toFixed(1), stripAbove: rows(0, Math.min(3, top)), barTop: rows(top + 1, top + 4),
          bottom: best.bottom.toFixed(1), stripBelow: rows(H - Math.min(3, Math.max(1, bottom)), H), barBottom: rows(H - bottom - 4, H - bottom - 1),
        };
        console.log(`         ${variant}: ${JSON.stringify(m)}`);
        if (variant === 'panes') {
          check('readeredges: no gap at the top edge while the bars bounce: the strip above the bar is as dark as the bar\'s own edge',
            Math.abs(m.stripAbove - m.barTop) < 40 && m.stripAbove < 150, JSON.stringify(m));
          if (bottom >= 2) {
            check('readeredges: nor at the bottom edge',
              Math.abs(m.stripBelow - m.barBottom) < 40 && m.stripBelow < 150, JSON.stringify(m));
          }
          writeFileSync(`${ctx.out}/readeredges-390-5-bars-mid-spring.png`, best.png);
          console.log('         shot readeredges-390-5-bars-mid-spring');
        } else {
          check('readeredges: with the panes taken away the strip is white beside the bar: the check sees a gap when there is one',
            m.stripAbove - m.barTop > 60, JSON.stringify(m));
          writeFileSync(`${ctx.out}/readeredges-390-6-no-panes-mid-spring.png`, best.png);
        }
      } finally {
        await p.close().catch(() => {});
      }
    }
  } catch (e) {
    check('readeredges: the phase ran to the end', false, String(e?.stack || e));
  } finally {
    if (lang() !== 'en') await setLang('en').catch(() => {});
  }
}

// ── lists ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Each series: its chapters, how many are read, when its files were written (days ago), and when it was read. */
const LIST = {
  'List Amber': { chapters: 5, read: 1, days: 30 },
  'List Birch': { chapters: 2, read: 0, days: 1 },
  'List Cedar': { chapters: 8, read: 7, days: 5 },
  'List Dune': { chapters: 3, read: 0, days: 12 },
  'List Many': { chapters: 120, read: 0, days: 90 },
};
/** The list's own order, and every order the chips give (lib/listSort.ts), titles in order. */
const ORDERS = {
  manual: ['List Dune', 'List Birch', 'List Many', 'List Amber', 'List Cedar'],
  az: ['List Amber', 'List Birch', 'List Cedar', 'List Dune', 'List Many'],
  za: ['List Many', 'List Dune', 'List Cedar', 'List Birch', 'List Amber'],
  // Read last: Cedar, then Amber; the never-read ones after, in the list's own order.
  read: ['List Cedar', 'List Amber', 'List Dune', 'List Birch', 'List Many'],
  unread: ['List Many', 'List Amber', 'List Dune', 'List Birch', 'List Cedar'],
  latest: ['List Birch', 'List Cedar', 'List Dune', 'List Amber', 'List Many'],
};

export async function listsWalk(ctx) {
  const { page, check, waitFor, sleep, lib } = ctx;
  if (!lib) { check('lists: LIB names the library folder (up.sh prints it with KEEP=1)', false); return; }
  const shot = async (name) => { await sleep(700); await ctx.shot(name); };
  const { call, say, setLang, visit, noSideScroll, seriesNamed, scan, lang } = kit(ctx);
  /** The tiles as the list shows them: title and badge, in order. */
  const tiles = () => page.evaluate(() => [...document.querySelectorAll('main a[href^="/series/?id="], a[href^="/series/?id="]')]
    .filter((a, i, all) => all.indexOf(a) === i && a.getClientRects().length)
    .map((a) => {
      const b = a.querySelector('[data-unread]');
      return { title: a.querySelector('p')?.textContent?.trim() ?? '', unread: b ? b.textContent.trim() : null,
        dir: b ? getComputedStyle(b).direction : null };
    }));
  try {
    console.log('\n  lists: five series, some read, in a list');
    const now = Date.now() / 1000;
    for (const [title, s] of Object.entries(LIST)) {
      const folder = `Hand Made/${title}`;
      writeShelf(lib, folder, Object.fromEntries(Array.from({ length: s.chapters }, (_, i) => [`Chapter ${String(i + 1).padStart(3, '0')}.cbz`, 1])));
      for (const f of readdirSync(join(lib, folder))) utimesSync(join(lib, folder, f), now - s.days * 86400, now - s.days * 86400);
    }
    await scan();
    const ids = {};
    for (const title of Object.keys(LIST)) ids[title] = (await seriesNamed(title))?.id;
    check('lists: the five folders are series', Object.values(ids).every(Boolean), JSON.stringify(ids));
    // Read: Amber's first chapter, then Cedar's seven -- Cedar last.
    for (const title of ['List Amber', 'List Cedar']) {
      const books = ((await call(`/api/series/${ids[title]}/books?size=200`)).content ?? []).sort((a, b) => a.number - b.number);
      for (const b of books.slice(0, LIST[title].read)) {
        await call(`/api/books/${b.id}/progress`, { method: 'PUT', json: { page: 1, completed: true } });
        await sleep(30);
      }
    }
    const { id: listId } = await call('/api/collections', { json: { name: 'Walk shelf' } });
    for (const title of ORDERS.manual) await call(`/api/collections/${listId}/items`, { json: { seriesId: ids[title] } });
    const unread = { 'List Amber': '4', 'List Birch': '2', 'List Cedar': '1', 'List Dune': '3', 'List Many': '99+' };

    for (const [w, l] of PASSES) {
      const t = tag(w, l);
      console.log(`\n  lists @${w}${l === 'ar' ? ' ar' : ''}`);
      if (l !== lang()) await setLang(l);
      await page.setViewport({ width: w, height: w < 1024 ? 844 : 900 });
      // The Lists page: its words in the reader's language.
      await visit('/collections/', 3000);
      const count = await page.evaluate(() => [...document.querySelectorAll('a[href^="/collection/?id="] p')].map((p) => p.textContent.trim()));
      check(`lists @${t}: the Lists page counts the list's series in words`, count.includes(say('{n} series', { n: 5 })), JSON.stringify(count));
      const newKey = await page.evaluate(() => document.querySelector('header .btn-accent')?.textContent?.trim() ?? null);
      check(`lists @${t}: and its key says ${say('New collection')}`, newKey === say('New collection'), JSON.stringify(newKey));
      check(`lists @${t}: the Lists page has no sideways scroll`, await noSideScroll());
      await shot(`lists-${t}-1-lists`);

      await visit(`/collection/?id=${listId}`, 3500);
      await waitFor(async () => ((await tiles()).length === 5 ? true : null), 15_000, 300);
      // The list's own order first (an earlier pass leaves it there).
      const pick = async (key) => {
        if (w >= 1024) await tap(page, `[data-list-sort="${key}"]`);
        else {
          await tap(page, '[data-list-sort-open]');
          await waitFor(() => page.$(`[role="dialog"] [data-list-sort="${key}"]`), 5000, 150);
          await tap(page, `[role="dialog"] [data-list-sort="${key}"]`);
        }
        await sleep(900);
      };
      await pick('manual');
      const first = await tiles();
      check(`lists @${t}: each item shows the Library's unread badge`,
        first.every((x) => x.unread === unread[x.title]), JSON.stringify(first));
      const many = first.find((x) => x.title === 'List Many');
      check(`lists @${t}: "99+" reads left to right${l === 'ar' ? ', in Arabic too' : ''}`, many?.unread === '99+' && many?.dir === 'ltr', JSON.stringify(many));
      for (const [key, order] of Object.entries(ORDERS)) {
        await pick(key);
        const got = (await tiles()).map((x) => x.title);
        check(`lists @${t}: ${key} puts them ${order.map((x) => x.replace('List ', '')).join(', ')}`, JSON.stringify(got) === JSON.stringify(order), JSON.stringify(got));
        if (key === 'unread') await shot(`lists-${t}-2-most-unread`);
      }
      // The chosen order is kept, on the account: a reload opens the list as it was left.
      await pick('az');
      await visit(`/collection/?id=${listId}`, 3500);
      await waitFor(async () => ((await tiles()).length === 5 ? true : null), 15_000, 300);
      const kept = (await tiles()).map((x) => x.title);
      check(`lists @${t}: a reload keeps A–Z`, JSON.stringify(kept) === JSON.stringify(ORDERS.az), JSON.stringify(kept));
      if (w < 1024) {
        await tap(page, '[data-list-sort-open]');
        await waitFor(() => page.$('[role="dialog"] [data-list-sort]'), 5000, 150);
        await shot(`lists-${t}-3-sort-sheet`);
        await page.keyboard.press('Escape');
        await sleep(500);
      } else {
        await shot(`lists-${t}-3-sort-chips`);
      }
      // Edit: the remove key and the move keys over each cover.
      await tap(page, '[data-list-edit]');
      const keys = await waitFor(() => page.evaluate((r, e, lt) => {
        const n = (lab) => document.querySelectorAll(`button[aria-label="${lab}"]`).length;
        const c = { remove: n(r), earlier: n(e), later: n(lt) };
        return c.remove ? c : null;
      }, say('Remove from collection'), say('Move earlier'), say('Move later')), 5000, 150);
      check(`lists @${t}: Edit puts a remove key and move keys over each cover`, keys?.remove === 5 && keys?.earlier === 5 && keys?.later === 5, JSON.stringify(keys));
      check(`lists @${t}: the list has no sideways scroll`, await noSideScroll());
      await shot(`lists-${t}-4-edit`);
      await tap(page, '[data-list-edit]');
      await sleep(400);
      await pick('manual');
    }
  } catch (e) {
    check('lists: the phase ran to the end', false, String(e?.stack || e));
  } finally {
    if (lang() !== 'en') await setLang('en').catch(() => {});
  }
}
