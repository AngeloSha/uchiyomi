// walk49's "engine" phase (#72, v0.53.0): Admin → Sources (Admin → Extensions until v0.54.0) when the extension
// engine is not answering, the way back, and the extensions in the tab once it answers.
//
// Needs an instance started with the fake engine, down, and a solver address to share:
//   KEEP=1 E2E_ENGINE=fake E2E_ENGINE_MODE=down E2E_NET=… E2E_PORT=… bash web/test/e2e/up.sh
//   cd web && BASE=http://127.0.0.1:<port> ENGINE=http://127.0.0.1:<engine port> PHASES=engine npm run test:e2e:v049
// (up.sh prints the engine's port: 23000 plus the app port's last three digits.)
//
// At 390 and 1280: the setup screen names the state, shows the retry line, the platform chips and a command to
// copy, with no sideways page scroll -- and since v0.54.0 the sources that need no engine are listed under it; Check
// again leaves "Still no answer"; under reduced motion its ring is still. Then the fake engine comes up and Check
// again turns the card into the engine's strip WITHOUT a reload (the status route registers the engine's sources
// itself); the strip offers Connect for the engine's own Cloudflare helper, which is off on a fresh engine, and
// pressing it writes the setting on the engine.
//
// Then the extensions (v0.53.0, discussion #121), on a repository of 1,300 made-up extensions (the fake engine's
// /__catalogue): the sources of extensions installed in the engine's own page are listed, switched off, and their
// sheet's Turn on switches one on without asking the engine to install anything; an update waiting is one row of
// Needs attention and its Update applies it; Browse (Add sources since v0.54.0) reaches the last extension of the
// catalogue a page at a time (it stopped at 400 and said "narrow the search"); the 18+ switch shows what it hid, and
// "nothing found" offers it; installing a multi-language extension opens its sheet on its languages, whose switches
// are one source each; Remove asks first.
//
// Round 2 (decluttered): the strip says Ready, the version and the sources on, with no installed count and no edge;
// Turning it off is behind the engine's ⋯, by keyboard too; the tools sit in the views' row, as named icons on a
// phone; no bars; a row offers one key at most; Browse has no filter chips and its repositories are a link in its
// count line; an extension's Settings are closed until asked for, and its languages say a problem only.
//
// Kept in its own module so walk49.mjs changes by one line; it is handed walk49's page and helpers.
import { catalogueExtensions } from '../../../bff/test/fixtures/fakeSuwayomiEngine.mjs';

export async function engineWalk({ page, api, go, press, shot, check, waitFor, sleep }) {
  const ENGINE = process.env.ENGINE;
  if (!ENGINE) { check('engine: ENGINE (the fake engine\'s control address) is set', false, 'start up.sh with E2E_ENGINE=fake'); return; }
  const mode = (m) => fetch(`${ENGINE}/__mode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: m }) });
  const state = async () => (await fetch(`${ENGINE}/__state`)).json();
  const setup = () => page.evaluate(() => {
    const el = document.querySelector('[data-engine-setup]');
    if (!el) return null;
    return {
      state: el.getAttribute('data-engine-setup'),
      text: el.textContent || '',
      chips: el.querySelectorAll('[role="radiogroup"] [role="radio"]').length,
      commands: [...el.querySelectorAll('pre code')].map((c) => c.textContent),
      ring: el.querySelector('[data-ring]')?.getAttribute('data-ring') ?? null,
      overflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
  const url = '/admin/?tab=Sources';

  for (const width of [390, 1280]) {
    const tag = `engine-${width}`;
    console.log(`\n  engine @${width}`);
    await page.setViewport({ width, height: width < 1024 ? 844 : 900 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
    await (await fetch(`${ENGINE}/__reset`, { method: 'POST' })).json();
    await mode('down');
    await go(url, 3000);
    let s = await waitFor(async () => { const v = await setup(); return v?.state === 'unreachable' ? v : null; }, 20_000);
    check(`${tag}: the setup screen says the engine isn't answering`, !!s && /isn’t answering/.test(s.text), JSON.stringify(s)?.slice(0, 300));
    check(`${tag}: with when it was last asked`, !!s && /Tried \d+ times since|Tried once, at|Last tried/.test(s.text), s?.text.slice(0, 300));
    check(`${tag}: the platform chips and a command to copy`, !!s && s.chips === 5 && s.commands.some((c) => /docker compose/.test(c)), JSON.stringify(s?.commands));
    check(`${tag}: its ring turns while it waits`, s?.ring === 'spin', s?.ring);
    check(`${tag}: no sideways scroll`, !!s && s.overflow <= 0, String(s?.overflow));
    // v0.54.0: the setup card no longer hides the sources that work without the engine -- built-ins, MangaDex, sites.
    const below = await waitFor(() => page.evaluate(() => document.querySelectorAll('[data-sources-list] [data-sources-row]').length || null), 15_000);
    check(`${tag}: the sources that need no engine are listed under the card`, (below ?? 0) > 0, String(below));
    await shot(`${tag}-1-not-answering`);

    await press('Check again');
    const still = await waitFor(async () => /Still no answer/.test((await setup())?.text ?? '') || null, 15_000);
    check(`${tag}: Check again says it is still not answering`, !!still);
    await shot(`${tag}-2-still-no-answer`);

    // Another platform: Unraid's steps for an engine that is set up and not answering -- its container, and the
    // address Uchiyomi should have.
    await press('Unraid');
    await sleep(300);
    s = await setup();
    check(`${tag}: Unraid's steps name the engine's container and the address to check`, !!s && /uchiyomi-suwayomi/.test(s.text) && s.commands.includes('http://YOUR-SERVER-IP:4567'), JSON.stringify(s?.commands));
    await shot(`${tag}-3-unraid`);

    // The ring is still under the system's reduced motion (and under Reduce effects: ProgressRing's own rule). The
    // setting is read when the ring mounts, so the page is loaded again under it.
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await go(url, 3000);
    const stillRing = await waitFor(async () => { const v = await setup(); return v?.state === 'unreachable' ? v.ring : null; }, 15_000);
    check(`${tag}: under reduced motion the ring is still`, stillRing === 'still', String(stillRing));
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);

    // Back up: Check again turns the card into the engine's strip, no reload.
    await mode('up');
    await press('Check again');
    const gone = await waitFor(async () => (await setup()) === null || null, 20_000);
    check(`${tag}: once the engine answers, Check again turns the card into the engine's strip`, !!gone);
    const st = await api('/api/admin/extensions/status');
    check(`${tag}: and its sources were registered by that call`, st.reachable === true && st.registered >= 0 && st.retry === null, JSON.stringify(st).slice(0, 300));
    await sleep(1200);
    const foot = await page.evaluate(() => {
      const el = document.querySelector('[data-engine-solver]');
      return { solver: el?.getAttribute('data-engine-solver') ?? null, connect: !!document.querySelector('[data-engine-connect]'), off: !!document.querySelector('details summary') };
    });
    check(`${tag}: a fresh engine's Cloudflare helper is off, with Connect`, foot.solver === 'off' && foot.connect, JSON.stringify(foot));
    await page.evaluate(() => document.querySelector('[data-engine-solver]')?.scrollIntoView({ block: 'center' }));
    await shot(`${tag}-4-ready-connect`);
    if (width === 1280) {
      await page.evaluate(() => document.querySelector('[data-engine-connect]')?.click());
      const done = await waitFor(async () => (await page.evaluate(() => /Connected: the extension engine now uses/.test(document.querySelector('[data-engine-solver]')?.textContent ?? ''))) || null, 15_000);
      const eng = await state();
      check(`${tag}: Connect switched the engine's helper on, pointed at Uchiyomi's`, !!done && eng.settings?.flareSolverrEnabled === true && /^http/.test(eng.settings?.flareSolverrUrl ?? ''), JSON.stringify(eng.settings ?? {}).slice(0, 200));
      // Turning it off: a sheet behind the engine's ⋯ since v0.53.0 round 2, with the platform's steps -- reached here by
      // keyboard alone: Enter on the ⋯ opens its menu on its first item, and Enter takes it.
      const more = await page.$('[data-engine-more]');
      let item = null;
      if (more) {
        await more.focus();
        await page.keyboard.press('Enter');
        item = await waitFor(() => page.evaluate(() => {
          const a = document.activeElement;
          return a?.getAttribute('role') === 'menuitem' ? (a.textContent || '').trim() : null;
        }), 5000);
      }
      check(`${tag}: the engine's ⋯ opens its menu by keyboard, on Turning it off`, item === 'Turning it off', more ? String(item) : 'no ⋯ in the strip');
      if (item) await page.keyboard.press('Enter');
      const off = await waitFor(() => page.$eval('[data-engine-off-sheet]', (e) => ({
        chips: e.querySelectorAll('[role="radiogroup"] [role="radio"]').length,
        commands: [...e.querySelectorAll('pre code')].map((c) => c.textContent),
      })), 10_000);
      check(`${tag}: Turning it off opens its steps, with the line to add and the command to apply it`, !!off && off.chips === 5
        && off.commands.includes('EXTENSION_ENGINE=0') && off.commands.includes('docker compose up -d'), JSON.stringify(off));
      await shot(`${tag}-5-turning-it-off`);
      await page.keyboard.press('Escape');
      await sleep(400);
    }
  }
  await extensionsWalk({ page, api, go, shot, check, waitFor, sleep, ENGINE });
}

const MANGABALL = 'eu.kanade.tachiyomi.extension.en.mangaball';
const WEBTOONS = 'eu.kanade.tachiyomi.extension.all.webtoons';
const NIGHTSHELF = 'eu.kanade.tachiyomi.extension.en.nightshelf';

/** The extensions in Admin → Sources on an engine that answers, at 390 then 1280 (v0.53.0; one tab since v0.54.0). */
async function extensionsWalk({ page, api, go, shot, check, waitFor, sleep, ENGINE }) {
  const control = async (path, body) => (await fetch(`${ENGINE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })).json();
  const state = async () => (await fetch(`${ENGINE}/__state`)).json();
  const engineLog = async () => (await (await fetch(`${ENGINE}/__log`)).json()).content ?? [];
  const made = catalogueExtensions(1300);
  const LOTUS = made.extensions.find((e) => e.name === 'Lotus Scans');
  const lotusLangs = made.sources.filter((s) => s.pkgName === LOTUS.pkgName);
  const shown = made.extensions.filter((e) => !e.isNsfw);
  const LAST = [...shown].sort((a, b) => a.name.localeCompare(b.name)).at(-1);
  const ADULT = made.extensions.find((e) => e.isNsfw && e.name === 'Cedar Scans');
  const MATCHED = shown.length + 4; // the seed's four: three installed (one 18+, shown because installed) and Shelf Two

  await control('/__reset');
  await control('/__mode', { mode: 'up' });
  await control('/__catalogue', { extensions: 1300, set: { [MANGABALL]: { hasUpdate: true } } });
  // ...listed by one repository, as a real catalogue is: Browse's count line names how many.
  await control('/api/graphql', {
    query: 'mutation($r:[String!]){ setSettings(input:{settings:{extensionRepos:$r}}){ settings { extensionRepos } } }',
    variables: { r: ['https://repo.example/index.min.json'] },
  });
  // As installed in the engine's own page: Uchiyomi has their sources, every one switched off (an earlier phase may
  // have switched Webtoons.com on over the API).
  const theirs = ((await api('/api/admin/extensions/sources')).content ?? []).filter((s) => [MANGABALL, WEBTOONS, NIGHTSHELF].includes(s.pkgName)).map((s) => s.id);
  if (theirs.length) await api('/api/admin/extensions/sources/bulk', { method: 'POST', body: JSON.stringify({ ids: theirs, enabled: false }) });
  const sinceReset = (await engineLog()).length;
  /** An extension's sources as Uchiyomi lists them, and the id Admin → Sources names the first by (`sw:<id>`). */
  const sourcesOf = async (pkg) => (await api(`/api/admin/extensions/sources?pkg=${pkg}`)).content ?? [];
  const ballId = `sw:${(await sourcesOf(MANGABALL))[0]?.id}`;

  /** A row of Your sources, as drawn: its state, its line, its key, and whether it sits in the Switched off fold. */
  const row = (id) => page.evaluate((id) => {
    const el = document.querySelector(`[data-sources-row="${CSS.escape(id)}"]`);
    return el && {
      state: el.getAttribute('data-source-state'), standing: el.getAttribute('data-standing'),
      line: el.querySelector('[data-source-line]')?.textContent ?? '', kind: el.querySelector('[data-source-kind]')?.getAttribute('data-source-kind') ?? null,
      turnOn: !!el.querySelector('[data-sources-turn-on]'), folded: !!el.closest('[data-sources-fold="off"]'),
      keys: el.querySelectorAll('button').length - 1,
    };
  }, id);
  /** The tab as drawn: Needs attention's rows, any bar, and every row's keys besides its opener. */
  const panelNow = () => page.evaluate(() => ({
    attention: [...document.querySelectorAll('[data-sources-attention-row]')].map((r) => ({
      kind: r.getAttribute('data-sources-attention-row'), text: (r.textContent || '').replace(/\s+/g, ' ').trim(),
      update: !!r.querySelector('[data-ext-update]'), updateAll: !!r.querySelector('[data-ext-update-all]'),
    })),
    bars: document.querySelectorAll('[data-ext-update-bar], [data-ext-off-bar]').length,
    keysPerRow: [...document.querySelectorAll('[data-sources-row]')].map((r) => r.querySelectorAll('button').length - 1),
    hint: /Open an extension for its languages and settings/.test(document.body.innerText),
  }));
  const openFold = () => page.evaluate(() => {
    const b = document.querySelector('[data-sources-fold="off"] > button');
    if (b && b.getAttribute('aria-expanded') !== 'true') b.click();
    return !!b;
  });
  const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  const scrollTo = (sel) => page.evaluate((sel) => { const el = document.querySelector(sel); el?.scrollIntoView({ block: 'start' }); window.scrollBy(0, -80); return !!el; }, sel);
  const search = async (q) => {
    await page.click('[data-ext-search]', { clickCount: 3 });
    await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    if (q) await page.type('[data-ext-search]', q);
    await sleep(1500);
  };

  for (const width of [390, 1280]) {
    const tag = `extensions-${width}`;
    console.log(`\n  extensions @${width}`);
    await page.setViewport({ width, height: width < 1024 ? 844 : 900 });
    await go('/admin/?tab=Sources', 3500);

    // 1. The strip: the engine and its Cloudflare helper at a glance, with the one action the helper needs.
    const head = await waitFor(() => page.evaluate(() => {
      const card = document.querySelector('[data-engine-state="ready"]');
      return card && {
        engine: card.querySelector('[data-engine-tile="engine"]')?.textContent || '',
        solver: card.querySelector('[data-engine-solver]')?.getAttribute('data-engine-solver'),
        helper: card.querySelector('[data-engine-tile="helper"]')?.textContent || '',
        connect: !!card.querySelector('[data-engine-connect]'),
        counts: card.querySelector('[data-engine-counts]')?.textContent || '',
        edge: !!card.querySelector('[data-status-edge]'),
        filled: card.querySelectorAll('.btn-key-primary').length,
      };
    }), 15_000);
    check(`${tag}: the strip says the engine is ready, its version and the sources on -- not the extensions installed`, !!head
      && /Extension engine\s*Ready/.test(head.engine) && /^v2\.3\.2243 · \d+ of 25 sources on$/.test(head.counts) && !/installed/.test(head.engine), JSON.stringify(head));
    check(`${tag}: ...and that its Cloudflare helper is not connected, in one line, with Connect`, head?.solver === 'off' && head.connect
      && /Not connected/.test(head.helper) && /Needed for sites behind Cloudflare\./.test(head.helper), JSON.stringify(head));
    check(`${tag}: ...with no amber edge, and Connect the strip's one filled key`, !!head && !head.edge && head.filled === 1, JSON.stringify(head));
    // The tools sit in the views' row: on a phone their icons alone, named.
    const tools = await page.evaluate(() => ['data-source-check-all', 'data-ext-languages', 'data-ext-refresh'].map((h) => {
      const b = document.querySelector(`[${h}]`);
      const words = b?.querySelector('span.hidden');
      return b && { name: b.getAttribute('aria-label'), inRow: !!b.closest('div')?.parentElement?.querySelector('[role="tablist"]'),
        words: words ? getComputedStyle(words).display !== 'none' : null };
    }));
    check(`${tag}: Test all, Languages and Check for extension updates sit in the views' row${width < 640 ? ', as named icons' : ', with their words'}`,
      tools.every((t) => t && t.name && t.inRow && t.words === (width >= 640)), JSON.stringify(tools));

    // 2. Your sources: three extensions installed in the engine's own page, none of their sources on, one update waiting.
    if (width === 390) {
      const now = await waitFor(async () => { const p = await panelNow(); return p.attention.some((a) => a.kind === 'updates') ? p : null; }, 15_000);
      const upd = now?.attention.find((a) => a.kind === 'updates');
      check(`${tag}: no bars and no hint line; the update waiting is one row of Needs attention, "1 extension has an update", with Update`,
        !!now && now.bars === 0 && !now.hint && !!upd && /1 extension has an update/.test(upd.text) && /Manga Ball/.test(upd.text) && upd.update && !upd.updateAll,
        JSON.stringify(now?.attention));
      check(`${tag}: every row offers one key at most`, !!now && now.keysPerRow.every((n) => n <= 1), JSON.stringify(now?.keysPerRow));
      // Their sources are listed, switched off by their extension, folded under Switched off.
      check(`${tag}: the Switched off fold is closed`, !(await row(ballId)), JSON.stringify(await row(ballId)));
      await openFold();
      const r = await waitFor(() => row(ballId), 5000);
      check(`${tag}: Manga Ball's source is listed, switched off, an extension's, in the fold`, !!r && r.standing === 'off' && r.kind === 'extension' && r.folded
        && /Turned off/.test(r.line), JSON.stringify(r));
      check(`${tag}: no sideways scroll on Your sources`, (await sideways()) <= 0, String(await sideways()));
      await scrollTo('[data-sources-fold="off"]');
      await shot(`${tag}-1-your-sources`);
      // Its sheet: Turn on, and the extension's part (its languages, Update), with no Test for a source not loaded.
      await page.evaluate((id) => document.querySelector(`[data-sources-row="${CSS.escape(id)}"] [data-sources-open]`)?.click(), ballId);
      const sheet = await waitFor(() => page.evaluate((id) => {
        const el = document.querySelector(`[data-source-sheet="${CSS.escape(id)}"]`);
        // Update is in the sheet's head, beside its title: the dialog's, not the body's.
        return el && { keys: [...el.querySelectorAll('[data-source-key]')].map((k) => k.getAttribute('data-source-key')), ext: !!el.querySelector('[data-ext-sheet]'),
          update: !!el.closest('[role="dialog"]')?.querySelector('[data-ext-update]') };
      }, ballId), 10_000);
      check(`${tag}: its sheet offers Turn on, and the extension's languages and Update`, !!sheet && sheet.keys.includes('turn-on') && !sheet.keys.includes('test')
        && sheet.ext && sheet.update, JSON.stringify(sheet));
      await shot(`${tag}-2-source-sheet`);
      await page.evaluate((id) => document.querySelector(`[data-source-sheet="${CSS.escape(id)}"] [data-source-key="turn-on"]`)?.click(), ballId);
      const src = await waitFor(async () => { const s = await sourcesOf(MANGABALL); return s.length === 1 && s[0].enabled === true ? s : null; }, 15_000);
      check(`${tag}: Turn on switches Manga Ball's source on, as the server has it`, !!src, JSON.stringify(await sourcesOf(MANGABALL)));
      const asked = (await engineLog()).slice(sinceReset).filter((c) => c.fields?.includes('updateExtension'));
      check(`${tag}: ...without asking the engine to install anything`, asked.length === 0, JSON.stringify(asked).slice(0, 300));
      await page.keyboard.press('Escape');
      await sleep(500);
      const back = await waitFor(async () => { const x = await row(ballId); return x && !x.folded ? x : null; }, 15_000);
      check(`${tag}: ...and its row leaves the fold for the list`, !!back, JSON.stringify(await row(ballId)));
    } else {
      // Lotus Scans (installed at 390, one language switched off) is listed: its languages on in the list, one folded.
      const lotus = await sourcesOf(LOTUS.pkgName);
      const listed = await waitFor(async () => {
        const rows = await Promise.all(lotus.map((s) => row(`sw:${s.id}`)));
        return rows.filter(Boolean).length === lotus.filter((s) => s.enabled).length ? rows : null;
      }, 15_000);
      check(`${tag}: an extension's sources are rows of Your sources, each its own language`, !!listed && listed.filter(Boolean).every((x) => x.kind === 'extension'),
        JSON.stringify(listed));
      await scrollTo('[data-sources-list]');
      await shot(`${tag}-1-your-sources`);
      // Update: the waiting version, applied on the engine; the updates row goes.
      await page.evaluate(() => document.querySelector('[data-sources-attention-row="updates"] [data-ext-update]')?.click());
      const updated = await waitFor(async () => {
        const e = (await state()).extensions.find((x) => x.pkgName === MANGABALL);
        return e && e.hasUpdate === false && !(await page.$('[data-sources-attention-row="updates"]')) ? e : null;
      }, 20_000);
      check(`${tag}: Update applies Manga Ball's update on the engine, and its row of Needs attention goes`, !!updated,
        JSON.stringify((await state()).extensions.find((x) => x.pkgName === MANGABALL)));
    }

    // 3. Browse, in Add sources: the catalogue a page at a time, to its last extension. Extensions' old address lands here.
    await go('/admin/?tab=Extensions&view=browse', 3500);
    const count = await waitFor(() => page.$eval('[data-ext-count]', (e) => e.textContent), 15_000);
    check(`${tag}: ?tab=Extensions&view=browse lands on Add sources' catalogue`, !!(await page.$('[data-sources-view="add"][aria-selected="true"]')));
    check(`${tag}: Browse counts every match: ${MATCHED.toLocaleString('en')}`, (count || '').startsWith(`${MATCHED.toLocaleString('en')} extensions match`), String(count));
    // The Browse tab said "Browse 1,304" over this list of 1,118: Add sources counts nothing.
    const tabSays = await page.$eval('[data-sources-view="add"]', (e) => e.textContent || '').catch(() => '');
    check(`${tag}: the Add sources tab carries no count`, !/\d/.test(tabSays), tabSays);
    check(`${tag}: no sideways scroll on Add sources`, (await sideways()) <= 0, String(await sideways()));
    const line = await page.evaluate(() => ({
      chips: document.querySelectorAll('[data-ext-browse] [data-ext-filter], [data-ext-browse] .chip').length,
      repos: document.querySelector('[data-ext-count-line] [data-ext-repos]')?.textContent?.trim() ?? null,
      adult: !!document.querySelector('[data-ext-count-line] [data-ext-adult] [role="switch"]'),
    }));
    check(`${tag}: Browse has no filter chips; its count line holds the repositories link and the 18+ switch`,
      line.chips === 0 && line.repos === '1 repository' && line.adult, JSON.stringify(line));
    await scrollTo('[data-ext-search]');
    await shot(`${tag}-3-browse`);
    let presses = 0;
    for (; presses < 40; presses++) {
      if (await page.$(`[data-ext-item="${LAST.pkgName}"]`)) break;
      const more = await page.$('[data-ext-more]');
      if (!more) break;
      await page.evaluate(() => { const b = document.querySelector('[data-ext-more]'); b?.scrollIntoView({ block: 'center' }); b?.click(); });
      await sleep(900);
    }
    const showing = await page.$eval('[data-ext-showing]', (e) => e.textContent).catch(() => '');
    check(`${tag}: the last extension of the catalogue, ${LAST.name}, is reached a page at a time (${presses} pages on)`,
      !!(await page.$(`[data-ext-item="${LAST.pkgName}"]`)), String(showing));
    check(`${tag}: ...and the count says all are shown, with no "narrow the search"`, showing === `Showing ${MATCHED.toLocaleString('en')} of ${MATCHED.toLocaleString('en')}`
      && !/narrow the search/.test(await page.evaluate(() => document.body.innerText)), String(showing));
    await page.evaluate(() => document.querySelector('[data-ext-showing]')?.scrollIntoView({ block: 'center' }));
    await shot(`${tag}-4-browse-end`);

    // 4. An 18+ extension the search would have found: said, and shown by the switch.
    await page.evaluate(() => window.scrollTo(0, 0));
    await search(ADULT.name);
    const hint = await waitFor(() => page.$eval('[data-ext-hidden-adult]', (e) => e.textContent), 10_000);
    check(`${tag}: nothing found says an 18+ extension matches, hidden while the switch is off`,
      /^An 18\+ extension matches\. It is hidden while Show 18\+ extensions is off\.$/.test((hint || '').trim()), String(hint));
    await page.evaluate(() => [...document.querySelectorAll('[data-ext-nothing] button')].find((b) => /Show 18\+ extensions/.test(b.textContent || ''))?.click());
    const adult = await waitFor(() => page.$eval(`[data-ext-item="${ADULT.pkgName}"]`, (e) => e.textContent), 10_000);
    check(`${tag}: ...and Show 18+ extensions shows it, marked 18+`, /18\+/.test(adult || ''), String(adult));
    check(`${tag}: ...with the switch now on`, await page.$eval('[data-ext-adult] [role="switch"]', (e) => e.getAttribute('aria-checked')) === 'true');
    await page.evaluate(() => document.querySelector('[data-ext-adult] [role="switch"]')?.click());
    await sleep(800);

    // 5. Lotus Scans, six languages: installed in one press (390), and the sheet it opens is on its languages.
    await search(LOTUS.name);
    if (width === 390) {
      await page.evaluate((pkg) => document.querySelector(`[data-ext-item="${pkg}"] [data-ext-install]`)?.click(), LOTUS.pkgName);
    } else {
      // An installed extension's row in Browse is its opener: "Already installed" and a chevron.
      await page.evaluate((pkg) => document.querySelector(`[data-ext-item="${pkg}"] [data-ext-open]`)?.click(), LOTUS.pkgName);
    }
    const sheet = await waitFor(() => page.evaluate((pkg) => {
      const el = document.querySelector(`[data-ext-sheet="${pkg}"]`);
      return el && {
        langs: el.querySelectorAll('[data-ext-lang]').length, on: el.querySelectorAll('[data-ext-lang][data-on]').length, text: el.textContent || '',
        problems: el.querySelectorAll('[data-ext-lang-problem]').length,
        settings: !!el.querySelector('[data-ext-settings]'),
        toggle: el.querySelector('[data-ext-settings-toggle]')?.getAttribute('aria-expanded') ?? null,
        // The source sheet it is part of: one of its sources, with that source's keys.
        source: el.closest('[data-source-sheet]')?.getAttribute('data-source-sheet') ?? null,
      };
    }, LOTUS.pkgName), 30_000);
    check(`${tag}: ${width === 390 ? 'installing' : 'its row in Browse opens'} ${LOTUS.name}${width === 390 ? ' opens' : ''} its sheet on its ${lotusLangs.length} languages`,
      !!sheet && sheet.langs === lotusLangs.length && !!sheet.source, JSON.stringify(sheet)?.slice(0, 300));
    check(`${tag}: ...saying what a language switch is`, !!sheet && sheet.text.includes('Each language is its own source; turn on the ones you read.'));
    check(`${tag}: ...with no line under a language that is fine, on or off`, !!sheet && sheet.problems === 0 && !/Healthy|Turned off/.test(sheet.text), JSON.stringify(sheet)?.slice(0, 300));
    check(`${tag}: ...and its Settings closed until asked for`, !!sheet && !sheet.settings && sheet.toggle === 'false', JSON.stringify(sheet)?.slice(0, 300));
    await page.evaluate(() => document.querySelector('[data-ext-settings-toggle]')?.click());
    const opened = await waitFor(() => page.evaluate(() => document.querySelector('[data-ext-settings-toggle]')?.getAttribute('aria-expanded') === 'true'
      && !!document.querySelector('[data-ext-sheet] [data-ext-settings]')), 10_000);
    check(`${tag}: ...which open on a press`, !!opened);
    if (width === 390) {
      check(`${tag}: ...every one of them on, as the install switched them`, sheet?.on === lotusLangs.length, JSON.stringify(sheet));
      const eng = (await state()).extensions.find((x) => x.pkgName === LOTUS.pkgName);
      check(`${tag}: ...installed on the engine`, eng?.installed === true, JSON.stringify(eng));
      await shot(`${tag}-5-sheet-languages`);
      // One language off: that source alone.
      const second = lotusLangs[1];
      await page.evaluate((id) => document.querySelector(`[data-ext-lang="${id}"] [role="switch"]`)?.click(), second.id);
      const offNow = await waitFor(async () => {
        const rows = await sourcesOf(LOTUS.pkgName);
        return rows.find((r) => r.id === second.id)?.enabled === false && rows.filter((r) => r.enabled).length === lotusLangs.length - 1 ? rows : null;
      }, 15_000);
      check(`${tag}: switching one language off switches that one source off`, !!offNow);
      check(`${tag}: no sideways scroll with the sheet open`, (await sideways()) <= 0, String(await sideways()));
    } else {
      // Remove extension asks first, inside the sheet, then takes it off the engine.
      await page.evaluate(() => document.querySelector('[data-ext-remove]')?.click());
      const ask = await waitFor(() => page.$eval('[data-ext-remove-confirm]', (e) => e.textContent), 5000);
      check(`${tag}: Remove asks first, inside the sheet`, /Remove .*Lotus Scans.*\?/.test(ask || ''), String(ask));
      await page.$eval('[data-ext-remove-confirm]', (e) => e.scrollIntoView({ block: 'center' })).catch(() => {});
      await sleep(300);
      await shot(`${tag}-5-remove-confirm`);
      await page.evaluate(() => document.querySelector('[data-ext-remove-yes]')?.click());
      const gone = await waitFor(async () => (await state()).extensions.find((x) => x.pkgName === LOTUS.pkgName)?.installed === false && !(await page.$('[data-ext-sheet]')), 30_000);
      check(`${tag}: ...and Remove takes it off the engine, and the sheet closes`, !!gone);
    }
    await page.keyboard.press('Escape');
    await sleep(500);

    // 6. The repositories and the languages hidden everywhere, each a sheet of its own.
    await page.evaluate(() => document.querySelector('[data-ext-repos]')?.click());
    check(`${tag}: Repositories opens its sheet, with the address field`, !!(await waitFor(() => page.$('[data-repos-sheet] [data-repo-form] input[placeholder="https://…/index.min.json"]'), 5000)));
    await page.keyboard.press('Escape');
    await sleep(400);
    await go('/admin/?tab=Sources', 3000);
    await page.evaluate(() => document.querySelector('[data-ext-languages]')?.click());
    const langs = await waitFor(() => page.$$eval('[data-ext-languages-sheet] [data-lang-row]', (rows) => rows.map((r) => r.getAttribute('data-lang-row'))), 10_000);
    check(`${tag}: Languages lists the languages of what is installed, each with a switch`, !!langs?.length && langs.includes('en')
      && !langs.includes('localsourcelang'), JSON.stringify(langs));
    await shot(`${tag}-6-languages`);
    await page.keyboard.press('Escape');
    await sleep(400);
  }
}
