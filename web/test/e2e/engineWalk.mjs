// walk49's "engine" phase (#72, v0.53.0): Admin → Extensions when the extension engine is not answering, the way back,
// and the redesigned tab once it answers.
//
// Needs an instance started with the fake engine, down, and a solver address to share:
//   KEEP=1 E2E_ENGINE=fake E2E_ENGINE_MODE=down E2E_NET=… E2E_PORT=… bash web/test/e2e/up.sh
//   cd web && BASE=http://127.0.0.1:<port> ENGINE=http://127.0.0.1:<engine port> PHASES=engine npm run test:e2e:v049
// (up.sh prints the engine's port: 23000 plus the app port's last three digits.)
//
// At 390 and 1280: the setup screen names the state, shows the retry line, the platform chips and a command to
// copy, with no sideways page scroll; Check again leaves "Still no answer"; under reduced motion its ring is
// still. Then the fake engine comes up and Check again turns the card into the extensions WITHOUT a reload (the
// status route registers the engine's sources itself); the header offers Connect for the engine's own Cloudflare
// helper, which is off on a fresh engine, and pressing it writes the setting on the engine.
//
// Then the tab itself (v0.53.0, discussion #121), on a repository of 1,300 made-up extensions (the fake engine's
// /__catalogue): extensions installed in the engine's own page show as installed with no source on, and Turn on
// switches them on without asking the engine to install anything; an update waiting is said and Update applies it;
// Browse reaches the last extension of the catalogue a page at a time (it stopped at 400 and said "narrow the
// search"); the 18+ switch shows what it hid, and "nothing found" offers it; installing a multi-language extension
// opens its sheet on its languages, whose switches are one source each; Remove asks first.
//
// Round 2 (decluttered): the strip says Ready, the version and the sources on, with no installed count and no edge;
// Turning it off is behind the engine's ⋯, by keyboard too; Installed's tools sit in the views' row, as named icons
// on a phone; Installed is grouped only while something needs attention, with Update all and Turn on all in the
// group's header and no bars; a row offers one key and says one state word; Browse has no filter chips and its
// repositories are a link in its count line; an extension's Settings are closed until asked for, and its languages
// say a problem only.
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
  const url = '/admin/?tab=Extensions';

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

    // Back up: Check again turns the card into the catalogue, no reload.
    await mode('up');
    await press('Check again');
    const gone = await waitFor(async () => (await setup()) === null || null, 20_000);
    check(`${tag}: once the engine answers, Check again turns the card into the catalogue`, !!gone);
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

/** The redesigned tab on an engine that answers, at 390 then 1280 (v0.53.0). */
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

  const row = (pkg) => page.evaluate((pkg) => {
    const el = document.querySelector(`[data-ext-row="${pkg}"]`);
    return el && {
      off: el.hasAttribute('data-ext-off'), text: el.textContent || '', on: el.querySelectorAll('[data-ext-tag="on"]').length,
      turnOn: !!el.querySelector('[data-ext-turn-on]'), update: !!el.querySelector('[data-ext-update]'),
      word: el.querySelector('[data-ext-word]')?.getAttribute('data-ext-word') ?? null,
      group: el.closest('[data-ext-group]')?.getAttribute('data-ext-group') ?? null,
    };
  }, pkg);
  // Installed as it is drawn: its groups, each with its header's words and keys, and every row's keys.
  const installedNow = () => page.evaluate(() => ({
    groups: [...document.querySelectorAll('[data-ext-group]')].map((g) => ({
      key: g.getAttribute('data-ext-group'),
      head: g.querySelector('[data-ext-group-head]')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      updateAll: !!g.querySelector('[data-ext-group-head] [data-ext-update-all]'),
      turnOnAll: !!g.querySelector('[data-ext-group-head] [data-ext-turn-on-all]'),
      rows: g.querySelectorAll('[data-ext-row]').length,
    })),
    bars: document.querySelectorAll('[data-ext-update-bar], [data-ext-off-bar]').length,
    keysPerRow: [...document.querySelectorAll('[data-ext-row]')].map((r) => r.querySelectorAll('[data-ext-turn-on], [data-ext-update]').length),
    hint: /Open an extension for its languages and settings/.test(document.body.innerText),
  }));
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
    await go('/admin/?tab=Extensions&view=installed', 3500);

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
        filled: document.querySelectorAll('[data-extensions] .btn-key-primary').length,
      };
    }), 15_000);
    check(`${tag}: the strip says the engine is ready, its version and the sources on -- not the extensions installed`, !!head
      && /Extension engine\s*Ready/.test(head.engine) && /^v2\.3\.2243 · \d+ of 25 sources on$/.test(head.counts) && !/installed/.test(head.engine), JSON.stringify(head));
    check(`${tag}: ...and that its Cloudflare helper is not connected, in one line, with Connect`, head?.solver === 'off' && head.connect
      && /Not connected/.test(head.helper) && /Needed for sites behind Cloudflare\./.test(head.helper), JSON.stringify(head));
    check(`${tag}: ...with no amber edge, and Connect the one filled key on the screen`, !!head && !head.edge && head.filled === 1, JSON.stringify(head));
    // The tools sit in the views' row: on a phone their icons alone, named.
    const tools = await page.evaluate(() => ['data-ext-languages', 'data-ext-refresh'].map((h) => {
      const b = document.querySelector(`[${h}]`);
      const words = b?.querySelector('span.hidden');
      return b && { name: b.getAttribute('aria-label'), inRow: !!b.closest('div')?.parentElement?.querySelector('[role="tablist"]'),
        words: words ? getComputedStyle(words).display !== 'none' : null };
    }));
    check(`${tag}: Languages and Check for extension updates sit in the views' row${width < 640 ? ', as named icons' : ', with their words'}`,
      tools.every((t) => t && t.name && t.inRow && t.words === (width >= 640)), JSON.stringify(tools));

    // 2. Installed: three extensions installed in the engine's own page, none of their sources on, one update waiting.
    if (width === 390) {
      for (const pkg of [MANGABALL, WEBTOONS, NIGHTSHELF]) {
        const r = await row(pkg);
        // Manga Ball also has an update: its one word says that, and its one key is still Turn on.
        const word = pkg === MANGABALL ? ['update', /Update available/] : ['off', /No source on/];
        check(`${tag}: ${pkg.split('.').pop()} shows as installed with no source on, says ${pkg === MANGABALL ? 'its update' : 'so'} in one word, and offers Turn on alone`,
          !!r && r.off && r.word === word[0] && word[1].test(r.text) && r.turnOn && !r.update && r.group === 'attention', JSON.stringify(r));
      }
      const inst = await installedNow();
      const att = inst.groups.find((g) => g.key === 'attention');
      check(`${tag}: no bars and no hint line; one group, "Needs attention · 3", with Update all and Turn on all in its header`,
        inst.bars === 0 && !inst.hint && inst.groups.length === 1 && !!att && /^Needs attention · 3/.test(att.head ?? '')
        && att.updateAll && att.turnOnAll && att.rows === 3, JSON.stringify(inst));
      check(`${tag}: every row offers one key at most`, inst.keysPerRow.every((n) => n <= 1), JSON.stringify(inst.keysPerRow));
      check(`${tag}: no sideways scroll on Installed`, (await sideways()) <= 0, String(await sideways()));
      // The first extension no longer starts below a whole screen of chrome.
      await page.evaluate(() => window.scrollTo(0, 0));
      const firstTop = await page.evaluate(() => document.querySelector('[data-ext-row]')?.getBoundingClientRect().top ?? null);
      check(`${tag}: the first extension starts on the first screen`, firstTop !== null && firstTop < 844, String(firstTop));
      await scrollTo('[data-ext-installed]');
      await shot(`${tag}-1-installed`);
      // Turn on: Manga Ball's one source, and the engine asked to install nothing.
      await page.evaluate((pkg) => document.querySelector(`[data-ext-row="${pkg}"] [data-ext-turn-on]`)?.click(), MANGABALL);
      const on = await waitFor(async () => { const r = await row(MANGABALL); return r && !r.off && r.update ? r : null; }, 15_000);
      check(`${tag}: Turn on switches Manga Ball's source on, and its one key is now its Update`, !!on && !on.turnOn && on.word === 'update', JSON.stringify(await row(MANGABALL)));
      const src = (await api(`/api/admin/extensions/sources?pkg=${MANGABALL}`)).content ?? [];
      check(`${tag}: ...as the server has it`, src.length === 1 && src[0].enabled === true, JSON.stringify(src));
      const asked = (await engineLog()).slice(sinceReset).filter((c) => c.fields?.includes('updateExtension'));
      check(`${tag}: ...without asking the engine to install anything`, asked.length === 0, JSON.stringify(asked).slice(0, 300));
    } else {
      // Two groups now: Lotus Scans (installed at 390, one language switched off) needs nothing.
      const before = await installedNow();
      check(`${tag}: "Needs attention · 3" over "Ready · 1", and every row offers one key at most`,
        before.groups.map((g) => `${g.key}:${g.rows}`).join(',') === 'attention:3,ready:1' && /^Ready · 1$/.test(before.groups[1]?.head ?? '')
        && before.keysPerRow.every((n) => n <= 1), JSON.stringify(before));
      const lotus = await row(made.extensions.find((e) => e.name === 'Lotus Scans').pkgName);
      check(`${tag}: a row with nothing waiting is its languages, how many are on and a chevron`, !!lotus && !lotus.turnOn && !lotus.update && !lotus.word
        && lotus.on === 4 && /5 of 6 on/.test(lotus.text), JSON.stringify(lotus));
      await scrollTo('[data-ext-installed]');
      await shot(`${tag}-1-installed`);
      // Update: the waiting version, applied on the engine; Update all goes, and Manga Ball moves to Ready.
      await page.evaluate((pkg) => document.querySelector(`[data-ext-row="${pkg}"] [data-ext-update]`)?.click(), MANGABALL);
      const updated = await waitFor(async () => {
        const e = (await state()).extensions.find((x) => x.pkgName === MANGABALL);
        return e && e.hasUpdate === false && !(await page.$('[data-ext-update-all]')) ? e : null;
      }, 20_000);
      check(`${tag}: Update applies Manga Ball's update on the engine, and Update all goes`, !!updated, JSON.stringify((await state()).extensions.find((x) => x.pkgName === MANGABALL)));
      const mb = await waitFor(async () => { const r = await row(MANGABALL); return r?.group === 'ready' ? r : null; }, 10_000);
      check(`${tag}: ...and Manga Ball is Ready, its language lit`, !!mb && mb.on === 1 && /1 of 1 on/.test(mb.text), JSON.stringify(await row(MANGABALL)));
    }

    // 3. Browse: the catalogue a page at a time, to its last extension.
    await go('/admin/?tab=Extensions&view=browse', 3500);
    const count = await waitFor(() => page.$eval('[data-ext-count]', (e) => e.textContent), 15_000);
    check(`${tag}: Browse counts every match: ${MATCHED.toLocaleString('en')}`, (count || '').startsWith(`${MATCHED.toLocaleString('en')} extensions match`), String(count));
    // The tab said "Browse 1,304" over this list of 1,118: it counted the 18+ extensions the list leaves out.
    const tabSays = await page.$eval('[data-ext-view="browse"]', (e) => e.textContent || '').catch(() => '');
    check(`${tag}: the Browse tab says the same number`, tabSays.replace(/\s+/g, ' ').trim().endsWith(MATCHED.toLocaleString('en')), tabSays);
    check(`${tag}: no sideways scroll on Browse`, (await sideways()) <= 0, String(await sideways()));
    const line = await page.evaluate(() => ({
      chips: document.querySelectorAll('[data-ext-browse] [data-ext-filter], [data-ext-browse] .chip').length,
      repos: document.querySelector('[data-ext-count-line] [data-ext-repos]')?.textContent?.trim() ?? null,
      adult: !!document.querySelector('[data-ext-count-line] [data-ext-adult] [role="switch"]'),
    }));
    check(`${tag}: Browse has no filter chips; its count line holds the repositories link and the 18+ switch`,
      line.chips === 0 && line.repos === '1 repository' && line.adult, JSON.stringify(line));
    await scrollTo('[data-ext-search]');
    await shot(`${tag}-2-browse`);
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
    await shot(`${tag}-3-browse-end`);

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

    // 5. Lotus Scans, six languages: installed in one press (390), and its sheet opens on its languages.
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
      };
    }, LOTUS.pkgName), 30_000);
    check(`${tag}: ${width === 390 ? 'installing' : 'its row in Browse opens'} ${LOTUS.name}${width === 390 ? ' opens' : ''} its sheet on its ${lotusLangs.length} languages`, !!sheet && sheet.langs === lotusLangs.length, JSON.stringify(sheet)?.slice(0, 300));
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
      await shot(`${tag}-4-sheet-languages`);
      // One language off: that source alone.
      const second = lotusLangs[1];
      await page.evaluate((id) => document.querySelector(`[data-ext-lang="${id}"] [role="switch"]`)?.click(), second.id);
      const offNow = await waitFor(async () => {
        const rows = (await api(`/api/admin/extensions/sources?pkg=${LOTUS.pkgName}`)).content ?? [];
        return rows.find((r) => r.id === second.id)?.enabled === false && rows.filter((r) => r.enabled).length === lotusLangs.length - 1 ? rows : null;
      }, 15_000);
      check(`${tag}: switching one language off switches that one source off`, !!offNow);
      check(`${tag}: no sideways scroll with the sheet open`, (await sideways()) <= 0, String(await sideways()));
    } else {
      // Remove asks first, inside the sheet, then takes it off the engine.
      await page.evaluate(() => document.querySelector('[data-ext-remove]')?.click());
      const ask = await waitFor(() => page.$eval('[data-ext-remove-confirm]', (e) => e.textContent), 5000);
      check(`${tag}: Remove asks first, inside the sheet`, /Remove .*Lotus Scans.*\?/.test(ask || ''), String(ask));
      await page.$eval('[data-ext-remove-confirm]', (e) => e.scrollIntoView({ block: 'center' })).catch(() => {});
      await sleep(300);
      await shot(`${tag}-4-remove-confirm`);
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
    await go('/admin/?tab=Extensions&view=installed', 3000);
    await page.evaluate(() => document.querySelector('[data-ext-languages]')?.click());
    const langs = await waitFor(() => page.$$eval('[data-ext-languages-sheet] [data-lang-row]', (rows) => rows.map((r) => r.getAttribute('data-lang-row'))), 10_000);
    check(`${tag}: Languages lists the languages of what is installed, each with a switch`, !!langs?.length && langs.includes('en')
      && !langs.includes('localsourcelang'), JSON.stringify(langs));
    await shot(`${tag}-5-languages`);
    await page.keyboard.press('Escape');
    await sleep(400);
  }
}
