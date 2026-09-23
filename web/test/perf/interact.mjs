// Everything that is not a scroll: composited layers, the page transition, the phone nav pill, card tilt.
//
//   BASE=http://127.0.0.1:18140 node test/perf/interact.mjs
//
// Chrome only (layers need the DevTools protocol, and the timed parts need CPU throttling to show anything
// on a fast machine). Run once as the account is, then again with Reduce effects on through the real row.
import { makeBrowser, signIn, installFixture, cpu, sleep, save, setCss, setReduceEffects,
  requireReduceEffects, pageState, fmtState, layerSnapshot, RECORDER, COLLECT, BASE, BROWSER } from './lib.mjs';

if (BROWSER !== 'chrome') { console.log('interact.mjs is Chrome only'); process.exit(0); }

const b = await makeBrowser();
const page = await signIn(b);
await installFixture(page);
const out = {};
const fmtM = (m) => `fps ${String(m.fps).padStart(5)}  p95 ${String(m.p95).padStart(5)}  max ${String(m.max).padStart(6)}  >33ms ${String(m.over33).padStart(3)}%  long ${m.longTasks}/${m.longMs}ms`;
const fmtL = (s) => (s ? `${s.total} layers (${s.drawing} drawing, ${s.mpx} Mpx); biggest ${s.biggest.join(', ')}` : 'n/a (no layer tree arrived)');

// The state the last `load` left the page in, printed on every result line below. See pageState in lib.mjs:
// a row measured with the switch in the wrong state reads as a perfectly good number.
let st = '[no page loaded]';

async function load(url, vp) {
  await cpu(page, 1);
  await page.setViewport(vp);
  await page.goto(BASE + url, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2500);
  st = fmtState(await pageState(page));
}

async function runAll(state) {
  console.log(`\n==== ${state}`);

  // 1. Composited layers. The cinematic layers' share is read by hiding them on the same page.
  for (const [name, url] of [['home', '/'], ['library', '/library']]) {
    await load(url, { width: 1440, height: 900 });
    const as = await layerSnapshot(page);
    await setCss(page, '.fx-mesh,.fx-grain,.fx-vignette{display:none!important}');
    await sleep(800);
    const noFx = await layerSnapshot(page);
    await setCss(page, '');
    out[`${state} :: layers ${name}`] = { asRendered: as, withoutFx: noFx };
    console.log(`layers ${name.padEnd(8)} ${fmtL(as)}  ${st}`);
    console.log(`  (cinematic layers hidden: ${fmtL(noFx)})`);
  }

  // 2. The page transition: home -> library through the top nav, throttled.
  for (const rate of [4, 6]) {
    await load('/', { width: 1440, height: 900 });
    await cpu(page, rate);
    await sleep(400);
    await page.evaluate(RECORDER);
    await page.evaluate(() => {
      const a = [...document.querySelectorAll('header a')].find((x) => x.getAttribute('href')?.startsWith('/library'));
      a?.click();
    });
    await sleep(1600);
    const m = await page.evaluate(COLLECT);
    out[`${state} :: nav home->library cpu${rate}x`] = m;
    console.log(`nav / -> /library 1440 cpu${rate}x   ${fmtM(m)}  ${st}`);
  }

  // 3. The phone nav's layoutId pill, throttled.
  await load('/', { width: 390, height: 844 });
  await cpu(page, 4);
  await sleep(400);
  await page.evaluate(RECORDER);
  await page.evaluate(() => {
    const a = [...document.querySelectorAll('nav a')].find((x) => x.getAttribute('href') === '/library');
    a?.click();
  });
  await sleep(1600);
  const pill = await page.evaluate(COLLECT);
  out[`${state} :: bottom nav 390 cpu4x`] = pill;
  console.log(`bottom nav pill 390 cpu4x   ${fmtM(pill)}  ${st}`);

  // 4. Card tilt. ⚠️ On the HOME rails: the tilt lives in SeriesCard, which the home rails render; the
  // library grid renders SeriesTile, which has none. The first version of this swept the library and timed
  // a surface with no tilt on it at all.
  for (const rate of [4, 6]) {
    await load('/', { width: 1440, height: 900 });
    const box = await page.evaluate(() => {
      const card = [...document.querySelectorAll('a[href^="/series/"] > div.grad-border')]
        .find((d) => { const r = d.getBoundingClientRect(); return r.width > 60 && r.width < 400; });
      if (!card) return null;
      card.scrollIntoView({ block: 'center' });
      const r = card.getBoundingClientRect();
      return { y: r.top + r.height / 2, x0: r.left + 4 };
    });
    if (!box) { console.log('tilt: no SeriesCard on the home page'); break; }
    await sleep(600);
    // ⚠️ Headless Chrome reports no hover-capable fine pointer, so useTilt's own gate -- `(hover: hover) and
    // (pointer: fine)` -- switched the tilt off and every earlier sweep timed a page with no tilt at all.
    // Answer that one query as a desktop mouse would; the component reads it on the first move.
    await page.evaluate(() => {
      const mm = window.matchMedia.bind(window);
      window.matchMedia = (q) => (/hover: *hover/.test(q) && /pointer: *fine/.test(q)
        ? { matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }
        : mm(q));
    });
    // Count every non-zero tilt the sweep causes, as it happens. Reading the cards once at the end found
    // none whenever the pointer finished in the gap between two cards, which proved nothing either way.
    await page.evaluate(() => {
      window.__tilts = 0;
      const nonZero = /rotate[XY]\((?!0deg\))-?[\d.]+deg\)/;
      new MutationObserver((ms) => { for (const m of ms) if (nonZero.test(m.target.style?.transform || '')) window.__tilts++; })
        .observe(document.body, { subtree: true, attributes: true, attributeFilter: ['style'] });
    });
    await cpu(page, rate);
    await sleep(300);
    await page.evaluate(RECORDER);
    for (let i = 0; i < 48; i++) {
      await page.mouse.move(box.x0 + i * 22, box.y + ((i % 7) - 3) * 10);
      await sleep(16);
    }
    await sleep(400);
    const m = await page.evaluate(COLLECT);
    // A tilt is a NON-ZERO rotation: leaving a card writes `rotateX(0deg) rotateY(0deg)` back, and matching
    // the word "rotate" counted every card the pointer had merely crossed -- with the tilt switched off too.
    const tilts = await page.evaluate(() => window.__tilts);
    out[`${state} :: tilt sweep home rail cpu${rate}x`] = { ...m, tilts };
    console.log(`tilt sweep home rail cpu${rate}x ${fmtM(m)}  (tilt updates during the sweep: ${tilts})  ${st}`);
  }
  await cpu(page, 1);
}

// ⚠️ Set the baseline, never inherit it: the switch follows the account, so a run that starts on an account
// holding Reduce effects measures the ON state twice and labels half of it "switch off". Skipped on a build
// with no row (before v0.43.0), where the default IS the baseline.
const hasSwitch = await requireReduceEffects(page, false);
await runAll('switch off');
if (hasSwitch) {
  await setReduceEffects(page, true);
  await runAll('Reduce effects ON');
  await setReduceEffects(page, false);
}
save('interact', out);
await b.close();
