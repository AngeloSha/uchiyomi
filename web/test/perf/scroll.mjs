// Scrolling frame rate, with the effects as shipped and with Reduce effects on.
//
//   BASE=http://127.0.0.1:18140 node test/perf/scroll.mjs                 # Chrome, CPU throttled 4x/6x
//   BROWSER=firefox BASE=… node test/perf/scroll.mjs                      # Firefox, unthrottled
//   VARIANTS=ab BASE=… node test/perf/scroll.mjs                          # + one row per effect removed
//   EXTRA='{"label":"css"}' BASE=… node test/perf/scroll.mjs              # + your own A/B rows
//   AB_WHEN=on VARIANTS=ab BASE=… node test/perf/scroll.mjs               # the A/B rows only with the switch on
//
// Each row is a fresh page load, so nothing one variant injects leaks into the next. See README.md.
import { makeBrowser, signIn, installFixture, cpu, sleep, save, setCss, requireReduceEffects,
  setReduceEffects, pageState, fmtState, RECORDER, COLLECT, scrollRun, BASE, BROWSER } from './lib.mjs';

const REPEAT = Number(process.env.REPEAT || 3);

// The diagnostic rows: each takes ONE effect away from the default, to find what a frame is paying for.
// These are injected stylesheets, not settings -- the app never ships any of them.
const AB = {
  '− fx-mesh (blur(90px) drift)': { css: '.fx-mesh{display:none!important}' },
  '− mesh animation only': { css: '.fx-mesh{animation:none!important}' },
  '− fx-grain (overlay blend)': { css: '.fx-grain{display:none!important}' },
  '− fx-vignette': { css: '.fx-vignette{display:none!important}' },
  '− all three CinematicFX': { css: '.fx-mesh,.fx-grain,.fx-vignette{display:none!important}' },
  '− backdrop-filter everywhere': { css: '*,*::before,*::after{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}' },
  '− .grad-border mask ring': { css: '.grad-border::before{display:none!important}' },
  '− box-shadow everywhere': { css: '*,*::before,*::after{box-shadow:none!important}' },
  '− Img blur fade-in': { css: 'img{filter:none!important;transition:none!important}' },
  '− .skeleton shimmer': { css: '.skeleton::after{animation:none!important;display:none!important}' },
  '− Lenis (native wheel)': { js: 'lenis' },
};

const V = { 'as rendered': {} };
if (process.env.VARIANTS === 'ab') Object.assign(V, AB);
if (process.env.EXTRA) for (const [k, css] of Object.entries(JSON.parse(process.env.EXTRA))) V[k] = { css };

const MATRIX = BROWSER === 'chrome'
  ? [
      ['library', '/library', { width: 1440, height: 900 }, 4],
      ['home', '/', { width: 1440, height: 900 }, 4],
      ['library', '/library', { width: 1440, height: 900 }, 6],
      ['library', '/library', { width: 390, height: 844 }, 4],
      ['home', '/', { width: 390, height: 844 }, 4],
    ]
  : [
      ['library', '/library', { width: 1440, height: 900 }, 1],
      ['home', '/', { width: 1440, height: 900 }, 1],
      ['library', '/library', { width: 390, height: 844 }, 1],
    ];

async function prep(page, url, vp, rate) {
  await cpu(page, 1);
  await page.setViewport(vp);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2500); // covers land, rails settle
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(400);
  await cpu(page, rate);
}

async function apply(page, v) {
  await setCss(page, v.css || '');
  if (v.js === 'lenis') {
    // What "no Lenis" means: the wheel reaches the browser's own scrolling instead of Lenis's handler.
    await page.evaluate(() => {
      window.addEventListener('wheel', (e) => e.stopImmediatePropagation(), { capture: true });
      document.documentElement.classList.remove('lenis', 'lenis-smooth');
    });
  }
  await sleep(300);
}

async function measure(page, { idleMs = 2000, steps = 55 } = {}) {
  await page.evaluate(RECORDER); // (1) idle: what the page costs while nothing happens
  await sleep(idleMs);
  const idle = await page.evaluate(COLLECT);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);
  await page.evaluate(RECORDER); // (2) a wheel scroll down the page
  await scrollRun(page, { steps });
  await sleep(300);
  const scroll = await page.evaluate(COLLECT);
  return { idle, scroll };
}

const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const fmt = (runs) => {
  const fps = runs.map((r) => r.scroll.fps);
  const m = runs.find((r) => r.scroll.fps === median(fps));
  // The state goes on the line with the number it produced: see pageState in lib.mjs for why.
  return `${String(median(fps)).padStart(5)} fps  (runs ${fps.join(' / ')})  p95 ${String(m.scroll.p95).padStart(5)}  >33ms ${String(m.scroll.over33).padStart(3)}%  idle ${m.idle.fps}  ${fmtState(m.state)}`;
};

const b = await makeBrowser();
const page = await signIn(b);
await installFixture(page);
const results = {};

async function runAll(state) {
  for (const [pname, url, vp, rate] of MATRIX) {
    const key = `${pname} ${vp.width}x${vp.height} ${BROWSER} ${BROWSER === 'chrome' ? `cpu${rate}x` : 'unthrottled'}`;
    console.log(`\n==== ${key} :: ${state}`);
    // AB_WHEN=on|off limits the diagnostic rows to one state: with the switch on they show what is still
    // costing frames once it has done its job.
    const abHere = !process.env.AB_WHEN || (process.env.AB_WHEN === 'on') === (state !== 'switch off');
    for (const [name, v] of Object.entries(abHere ? V : { 'as rendered': {} })) {
      const runs = [];
      for (let i = 0; i < REPEAT; i++) {
        await prep(page, BASE + url, vp, rate);
        await apply(page, v);
        const m = await measure(page);
        runs.push({ ...m, state: await pageState(page) });
      }
      (results[key] ??= {})[`${state} :: ${name}`] = runs;
      console.log(`${name.padEnd(34)} ${fmt(runs)}`);
    }
    await cpu(page, 1);
  }
}

// ⚠️ The baseline is a state this rig SETS, never one it inherits. The switch follows the ACCOUNT, so an
// account left with it on -- by a crashed run, by an earlier script, by a real reader who uses it -- turned
// this phase into "Reduce effects ON" under the label "switch off": 60 fps on every row, i.e. a table
// reporting that nothing is wrong. Skipped on a build that has no row (anything before v0.43.0), where the
// default IS the baseline.
const hasSwitch = await requireReduceEffects(page, false);
await runAll('switch off');
if (hasSwitch) {
  await setReduceEffects(page, true); // the switch, through the real row
  await runAll('Reduce effects ON');
  await setReduceEffects(page, false); // leave the account as it was found
}
save('scroll', results);
await b.close();
