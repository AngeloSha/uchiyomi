// walk49's "engine" phase (#72): Admin → Extensions when the extension engine is not answering, and the way back.
//
// Needs an instance started with the fake engine, down, and a solver address to share:
//   KEEP=1 E2E_ENGINE=fake E2E_ENGINE_MODE=down E2E_NET=… E2E_PORT=… bash web/test/e2e/up.sh
//   cd web && BASE=http://127.0.0.1:<port> ENGINE=http://127.0.0.1:<engine port> PHASES=engine npm run test:e2e:v049
// (up.sh prints the engine's port: 23000 plus the app port's last three digits.)
//
// At 390 and 1280: the setup screen names the state, shows the retry line, the platform chips and a command to
// copy, with no sideways page scroll; Check again leaves "Still no answer"; under reduced motion its ring is
// still. Then the fake engine comes up and Check again turns the card into the catalogue WITHOUT a reload (the
// status route registers the engine's sources itself); the ready panel offers Connect for the engine's own
// Cloudflare helper, which is off on a fresh engine, and pressing it writes the setting on the engine.
//
// Kept in its own module so walk49.mjs changes by one line; it is handed walk49's page and helpers.
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
      await page.evaluate(() => { const d = document.querySelector('details'); if (d) d.open = true; d?.scrollIntoView({ block: 'start' }); });
      await sleep(400);
      await shot(`${tag}-5-turning-it-off`);
    }
  }
}
