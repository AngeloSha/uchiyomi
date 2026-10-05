// walk49's "solver" phase (v0.55.3): the backup Cloudflare solver (FLARESOLVERR_FALLBACK_URL), and a source downloading
// at a raised pace, through the browser on the real routes, at 1280, 390 and 390 in Arabic.
//
// Needs the stack with two fake solvers and fake-b behind a fake Cloudflare (up.sh E2E_SOLVERS=1):
//   KEEP=1 E2E_SOLVERS=1 E2E_MIN_FREE_GB=0 E2E_NO_WALK=1 E2E_NET=uchi-e2e-sv E2E_PORT=18163 E2E_SUBNET=10.222.63.0/24 \
//     bash web/test/e2e/up.sh
//   cd web && BASE=http://127.0.0.1:18163 PHASES=solver npm run test:e2e:v049
// The main solver greets as trawl 1.7.0, the backup as FlareSolverr 3.5.2 (fakeSolver.mjs); their control ports are
// 26000 + 2 x the app port's last three digits, and one more, as up.sh derives them. fake-b's stub answers only a request
// carrying a solver's cf_clearance, and says whose each one carried (fakeSource.mjs --cloudflare).
//
//   1. Both answer: Health's Cloudflare solver card lists the main and the backup, each by its kind and version -- the
//      main "trawl v1.7.0", never held against FlareSolverr's 3.x releases -- and is green.
//   2. The main stops answering: the card is amber, "The main solver is not answering; the backup is solving", its
//      mark Worth a look -- never the red Needs attention, never the solver-down card -- and the Cloudflare site still
//      lists and downloads: Walk Gap added from fake-b, every request the site answered carrying the backup's
//      clearance and the backup's user agent, the images included. Fix everything's end then says the backup is
//      solving among what clears by itself, and never puts the solver under Needs you (the owner's plan: only when
//      neither answers).
//   3. A source downloading at a raised pace: fake-a's image server refuses one page of a chapter with 429, the chapter
//      lands after the wait, and Source health lists fake-a with nothing else wrong under "Nothing to fix right now":
//      "Downloading slowly -- the site asked for fewer requests" (state `slowed`).
//   4. The main answers again: the card is green, both rows ready.
// Every view: no sideways scroll. walk49 counts the console errors and 5xx of the whole walk. Screenshots:
// solver-<pass>-<n>-<what>.png in walk49's OUT. LOOK at them.
import { kit } from './filenamesWalk.mjs';

const PASSES = [[1280, 'en'], [390, 'en'], [390, 'ar']];
const tag = (w, l) => `${w}${l === 'ar' ? 'ar' : ''}`;

export async function solverWalk(ctx) {
  const { page, check, waitFor, sleep, base } = ctx;
  const shot = async (name) => { await sleep(700); await ctx.shot(name); };
  const { call, say, setLang, visit, noSideScroll, seriesNamed, lang } = kit(ctx);
  const appPort = Number(new URL(base).port || 80);
  const MAIN = `http://127.0.0.1:${26_000 + (appPort % 1000) * 2}`;
  const BACKUP = `http://127.0.0.1:${26_000 + (appPort % 1000) * 2 + 1}`;
  const FAKE_A = `http://127.0.0.1:${20_000 + (appPort % 1000) * 2}`;
  const FAKE_B = `http://127.0.0.1:${20_000 + (appPort % 1000) * 2 + 1}`;
  const control = async (url, path, body) => {
    const r = await fetch(`${url}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${url}${path} -> ${r.status}`);
    return r.json();
  };
  const logOf = async (url) => (await control(url, '/__log')).content ?? [];
  const ready = await control(MAIN, '/__mode').catch(() => null);
  if (!ready || !(await control(BACKUP, '/__mode').catch(() => null))) {
    check('solver: up.sh started the main and the backup solver (E2E_SOLVERS=1)', false, `${MAIN} / ${BACKUP}`);
    return;
  }

  // ---- what the server says --------------------------------------------------------------------------------------
  const healthNow = () => call('/api/admin/health');
  const card = async (id) => (await healthNow()).checks.find((c) => c.id === id) ?? null;
  /** The solver card once `want` holds of it: the ping answers for ten seconds (PING_SHARED_MS), so it is asked again. */
  const solverWhen = (want, ms = 45_000) => waitFor(async () => { const c = await card('solver'); return c && want(c) ? c : null; }, ms, 2000);
  const rowSaid = (it) => it?.detailSaid?.[0] ?? null;
  const brief = (c) => JSON.stringify(c && { status: c.status, summary: c.summarySaid, items: c.items?.map((i) => ({ t: i.titleSaid?.code ?? i.title, d: i.detailSaid, info: !!i.info })) });

  // ---- the page --------------------------------------------------------------------------------------------------
  /** Admin -> Health, the card opened: its mark's words, and its rows' text. */
  const openCard = async (id) => {
    await visit('/admin/?tab=Health', 4000);
    const there = await waitFor(() => page.$(`[data-health-check="${id}"]`), 30_000, 300);
    if (!there) return null;
    await page.evaluate((id) => {
      const c = document.querySelector(`[data-health-check="${id}"]`);
      const b = c?.querySelector('button');
      if (b && b.getAttribute('aria-expanded') !== 'true') b.click();
      c?.scrollIntoView({ block: 'start' });
    }, id);
    await sleep(800);
    return page.evaluate((id) => {
      const c = document.querySelector(`[data-health-check="${id}"]`);
      return c ? { text: c.textContent.replace(/\s+/g, ' ').trim(), open: c.querySelector('button')?.getAttribute('aria-expanded') === 'true' } : null;
    }, id);
  };

  try {
    await Promise.all([control(MAIN, '/__reset', {}), control(BACKUP, '/__reset', {}), control(FAKE_A, '/__reset', {}), control(FAKE_B, '/__reset', {})]);

    // ---- 1. both answer -------------------------------------------------------------------------------------------
    console.log('\n  solver: both answer');
    const both = await solverWhen((c) => c.status === 'ok' && (c.items ?? []).length >= 2);
    check('solver: with a backup, the Cloudflare solver card lists two solvers and is green while both answer', !!both, brief(both ?? await card('solver')));
    const [main, backup] = both?.items ?? [];
    check('solver: ...the main first, then the backup', main?.titleSaid?.code === 'solver.main' && backup?.titleSaid?.code === 'solver.backup', brief(both));
    const m = rowSaid(main)?.params ?? {}, b = rowSaid(backup)?.params ?? {};
    check('solver: the main greets "TRAWL is ready!" and is named trawl v1.7.0', rowSaid(main)?.code === 'solver.ready' && m.kind === 'trawl' && m.version === '1.7.0', JSON.stringify(rowSaid(main)));
    // trawl held against FlareSolverr's 3.x releases read as years behind (v0.55.2 and before): its own, or none.
    check('solver: ...never held against FlareSolverr\'s releases: no "v3.x is out" beside trawl, no version row for it',
      (m.latest == null || !/^3\./.test(String(m.latest))) && !(both?.items ?? []).some((i) => /^v1\.7\.0 → v3/.test(i.title ?? '')), JSON.stringify({ m, titles: both?.items?.map((i) => i.title) }));
    console.log(`         trawl's newest release as the server read it: ${m.latest ?? 'none newer (or GitHub not asked)'}`);
    check('solver: the backup greets as FlareSolverr 3.5.2', b.kind === 'flaresolverr' && b.version === '3.5.2', JSON.stringify(rowSaid(backup)));
    await page.setViewport({ width: 1280, height: 900 });
    const shownBoth = await openCard('solver');
    check('solver @1280: Health shows both rows, the main named trawl', !!shownBoth?.open && shownBoth.text.includes(say('Main solver'))
      && shownBoth.text.includes(say('Backup solver')) && /trawl v1\.7\.0/.test(shownBoth.text), shownBoth?.text);
    await shot('solver-1280-0-both-ready');

    // ---- 2. the main stops answering --------------------------------------------------------------------------------
    console.log('\n  solver: the main stops answering');
    await control(MAIN, '/__mode', { mode: 'down' });
    const down = await solverWhen((c) => c.summarySaid?.[0]?.code === 'solver.backupSolving');
    check('solver: the main down and the backup answering: the card says "the backup is solving"', !!down, brief(down ?? await card('solver')));
    check('solver: ...amber, never the red of a solver that is down', down?.status === 'warn', String(down?.status));
    check('solver: ...the main\'s row not answering, the backup\'s ready', !!down && !down.items[0]?.info && rowSaid(down.items[0])?.code === 'solver.notAnswering'
      && down.items[1]?.info === true && rowSaid(down.items[1])?.code === 'solver.ready', brief(down));

    // The Cloudflare site, through the backup: listed, added, downloaded.
    await control(FAKE_B, '/__reset', {});
    const mainAskedBefore = (await logOf(MAIN)).length;
    await call('/api/sources/add', { json: { source: 'fake-b', sourceId: 'walk-gap', chapterFrom: 'oldest', chapterCount: 2, autoUpdate: false } });
    const gap = await waitFor(async () => { const s = await seriesNamed('Walk Gap'); return s && s.booksCount >= 2 ? s : null; }, 120_000, 1500);
    check('solver: the Cloudflare site still lists and downloads with the main down: Walk Gap added from fake-b, two chapters',
      !!gap, JSON.stringify(await seriesNamed('Walk Gap')));
    const siteLog = await logOf(FAKE_B);
    const answered = siteLog.filter((r) => r.route !== 'challenge');
    const images = answered.filter((r) => r.route === 'image');
    check(`solver: every request fake-b answered carried the backup's clearance and user agent (${answered.length}, ${images.length} of them images)`,
      answered.length > 0 && images.length >= 24 && answered.every((r) => r.clearance === 'backup' && r.ua === 'backup-browser/1.0'),
      JSON.stringify(answered.filter((r) => r.clearance !== 'backup' || r.ua !== 'backup-browser/1.0').slice(0, 5)));
    check('solver: ...and no request reached it without one', !siteLog.some((r) => r.route === 'challenge'), JSON.stringify(siteLog.filter((r) => r.route === 'challenge').slice(0, 3)));
    const mainAsked = (await logOf(MAIN)).slice(mainAskedBefore);
    check('solver: the main was asked first and answered nothing; the backup solved', mainAsked.length > 0 && mainAsked.every((r) => r.outcome === 'dropped')
      && (await logOf(BACKUP)).some((r) => r.outcome === 200), JSON.stringify({ main: mainAsked.slice(0, 3), backup: (await logOf(BACKUP)).length }));

    for (const [w, l] of PASSES) {
      const t = tag(w, l);
      if (l !== lang()) await setLang(l);
      await page.setViewport({ width: w, height: w < 1024 ? 844 : 900 });
      const shown = await openCard('solver');
      check(`solver @${t}: the card reads "${say('Worth a look')}" with "${say('Main solver')}" and "${say('Backup solver')}"`,
        !!shown?.open && shown.text.includes(say('Worth a look')) && !shown.text.includes(say('Needs attention'))
        && shown.text.includes(say('Main solver')) && shown.text.includes(say('Backup solver')), shown?.text);
      check(`solver @${t}: no sideways scroll`, await noSideScroll());
      await shot(`solver-${t}-1-main-down`);
    }
    if (lang() !== 'en') await setLang('en');

    // Fix everything with the main down: nothing for a person, and the end says it.
    console.log('\n  solver: Fix everything with the main down');
    const started = await call('/api/admin/health/autofix', { json: {}, status: true, allow: [409] });
    check('solver: Fix everything starts', started.status === 202, JSON.stringify(started));
    const runId = started.body?.runId;
    const run = runId ? await waitFor(async () => {
      const st = await call('/api/admin/health/autofix');
      return !st.run && st.last?.id === runId ? st.last : null;
    }, 600_000, 2000) : null;
    check('solver: ...and ends', run?.status === 'done', JSON.stringify(run && { status: run.status }));
    const s = run?.summary;
    check('solver: the solver is never under Needs you while the backup solves', !!s && !(s.needsYou ?? []).some((n) => n.check === 'solver'), JSON.stringify(s?.needsYou));
    check('solver: ...and the end says the main is not answering, among what clears by itself',
      (s?.clears ?? []).some((c) => c.said?.code === 'autofix.clears.mainSolverDown'), JSON.stringify(s?.clears));

    // ---- 3. a source downloading at a raised pace ----------------------------------------------------------------
    console.log('\n  solver: a source downloading slowly');
    // One page, once: `429:after=` fires once per page it is scripted on (fakeSource.mjs), so on page 0 -- every page --
    // each page past the third was refused, and the chapter with them.
    await control(FAKE_A, '/__script', { chapter: 'walk-tale-1', page: 5, behaviour: '429:after=0,retryAfter=1' });
    await call('/api/sources/add', { json: { source: 'fake-a', sourceId: 'walk-tale', chapterFrom: 'oldest', chapterCount: 1, autoUpdate: false } });
    const tale = await waitFor(async () => { const t = await seriesNamed('Walk Tale'); return t && t.booksCount >= 1 ? t : null; }, 90_000, 1500);
    const refused = (await logOf(FAKE_A)).filter((r) => r.route === 'image' && r.status === 429).length;
    check('solver: fake-a refused one page with 429, and the chapter landed after the wait', !!tale && refused === 1, JSON.stringify({ tale: !!tale, refused }));
    const sources = await card('sources');
    const slowed = (sources?.items ?? []).find((i) => i.sourceId === 'fake-a');
    check('solver: Source health lists fake-a downloading slowly, with nothing else wrong', slowed?.state === 'slowed' && slowed.slowed === true
      && slowed.info === true && slowed.group === 'quiet' && rowSaid(slowed)?.code === 'sources.paced', JSON.stringify(slowed));
    for (const [w, l] of PASSES) {
      const t = tag(w, l);
      if (l !== lang()) await setLang(l);
      await page.setViewport({ width: w, height: w < 1024 ? 844 : 900 });
      await openCard('sources');
      await page.evaluate(() => {
        const b = document.querySelector('[data-source-fold="quiet"] button');
        if (b && b.getAttribute('aria-expanded') !== 'true') b.click();
      });
      await sleep(600);
      const row = await page.evaluate(() => {
        const r = document.querySelector('[data-source-row="fake-a"]');
        r?.scrollIntoView({ block: 'center' });
        return r ? { state: r.getAttribute('data-source-state'), text: r.textContent.replace(/\s+/g, ' ').trim() } : null;
      });
      check(`solver @${t}: fake-a's row says "${say('Downloading slowly')}" under "${say('Nothing to fix right now')}"`,
        row?.state === 'slowed' && row.text.includes(say('Downloading slowly')) && row.text.includes(say('the site asked for fewer requests')), JSON.stringify(row));
      check(`solver @${t}: no sideways scroll`, await noSideScroll());
      await shot(`solver-${t}-2-slowed-row`);
    }
    if (lang() !== 'en') await setLang('en');

    // ---- 4. the main answers again ------------------------------------------------------------------------------
    console.log('\n  solver: the main answers again');
    await control(MAIN, '/__mode', { mode: 'up' });
    const back = await solverWhen((c) => c.status === 'ok' && (c.items ?? []).length >= 2 && c.items.every((i) => i.info));
    check('solver: the main back, the card is green again, both rows ready', !!back, brief(back ?? await card('solver')));
    check('solver: ...the main solving, named trawl', back?.summarySaid?.[0]?.code === 'solver.ready' && back.summarySaid[0].params?.kind === 'trawl', JSON.stringify(back?.summarySaid));
    for (const [w, l] of PASSES) {
      const t = tag(w, l);
      if (l !== lang()) await setLang(l);
      await page.setViewport({ width: w, height: w < 1024 ? 844 : 900 });
      const shown = await openCard('solver');
      check(`solver @${t}: the card reads "${say('All good')}" again`, !!shown?.open && shown.text.includes(say('All good')), shown?.text);
      check(`solver @${t}: no sideways scroll`, await noSideScroll());
      await shot(`solver-${t}-3-both-back`);
    }
  } finally {
    await control(MAIN, '/__mode', { mode: 'up' }).catch(() => {});
    await control(FAKE_A, '/__reset', {}).catch(() => {});
    if (lang() !== 'en') await setLang('en').catch(() => {});
  }
}
