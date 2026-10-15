// Where the main thread's time goes (2026-10-15, "the app feels clanky"): a Chrome trace of each scenario, summed by what
// the renderer was doing -- script, style, layout, pre-paint, re-layering (`Layerize`), hit testing -- with long tasks.
// scroll.mjs says how smooth a page is; this says what to look at when it is not. It found the 158 off-screen shimmers
// (README.md, "Idle work").
//
//   BASE=http://127.0.0.1:18140 node test/perf/profile.mjs                       # every scenario, CPU throttled 4x
//   SCEN=lib1440,home390 RATE=6 BASE=… node test/perf/profile.mjs                 # some, at 6x
//   CSS='.skeleton::after{animation:none!important}' SCEN=lib1440 BASE=… node …   # an A/B of your own
//
// ⚠️ `V8.InvokeApiInterruptCallbacks` is the sampling profiler's own cost, not the app's: subtract it before comparing.
import fs from 'node:fs';
import path from 'node:path';
import { makeBrowser, signIn, installFixture, cpu, sleep, scrollRun, setCss, BASE } from './lib.mjs';

const RATE = Number(process.env.RATE || 4);
const OUT = process.env.OUT || fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'perf-prof-'));
fs.mkdirSync(OUT, { recursive: true });
const SCEN = (process.env.SCEN || 'lib1440,home1440,series1440,home390,series390,nav1440,tilt1440').split(',');

const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 }; // no isMobile: puppeteer reloads on that change, and a reload signs a test browser out

const browser = await makeBrowser();
const page = await signIn(browser);
await installFixture(page);
// One real series: the first in the library grid (the fixture suffixes ids with __gN, so strip it).
const seriesIdFromDom = async () => {
  await page.goto(BASE + '/library', { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  await page.waitForSelector('main a[href*="/series/"]', { timeout: 20000 }).catch(() => {});
  return page.evaluate(() => {
    const a = document.querySelector('main a[href*="/series/"]');
    if (!a) return null;
    const id = new URL(a.href).searchParams.get('id');
    return id ? id.replace(/__.*$/, '') : null;
  });
};
const seriesId = await seriesIdFromDom();
console.log('series for the series scenarios:', seriesId);

const pressHover = async () => {
  const c = await page.target().createCDPSession();
  await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'hover', value: 'hover' }, { name: 'pointer', value: 'fine' }, { name: 'any-hover', value: 'hover' }, { name: 'any-pointer', value: 'fine' }] });
  return c;
};

async function prep(url, vp) {
  await cpu(page, 1);
  await page.setViewport(vp);
  await page.goto(BASE + url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  if (process.env.CSS) await setCss(page, process.env.CSS);
  await sleep(3000);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(500);
  await cpu(page, RATE);
}

async function traced(name, fn) {
  const file = path.join(OUT, `${name}-${process.pid}.json`);
  await page.tracing.start({ path: file, screenshots: false });
  const t0 = Date.now();
  await fn();
  const wall = Date.now() - t0;
  await page.tracing.stop();
  await cpu(page, 1);
  return summarize(name, file, wall);
}

const BUCKET = (n) => {
  if (/^(MinorGC|MajorGC|V8\.GC|BlinkGC|GCEvent|V8\.ScavengerTask|CppGC)/.test(n)) return 'gc';
  if (/^(UpdateLayoutTree|RecalculateStyles|ParseAuthorStyleSheet|InvalidateLayout|StyleRecalcInvalidationTracking)/.test(n)) return 'style';
  if (/^(Layout|UpdateLayout|LayoutShift|IntersectionObserverController::computeIntersections|ResizeObserver)/.test(n)) return 'layout';
  if (/^(Paint|PaintImage|PrePaint|Layerize|UpdateLayer|Commit|CompositeLayers|UpdateLayerTree|PaintSetup|Rasterize|ScrollLayer|Decode|ImageDecode|Draw)/.test(n)) return 'paint+composite';
  if (/^(FunctionCall|EvaluateScript|v8\.|V8\.|TimerFire|FireAnimationFrame|EventDispatch|RunMicrotasks|FireIdleCallback|XHRReadyStateChange|XHRLoad|ParseHTML|HandlePostMessage|ProfileCall|RequestAnimationFrame|CancelAnimationFrame|SchedulePostMessage|MessageEvent|RunTask|ThreadControllerImpl)/.test(n)) return n === 'RunTask' || n.startsWith('ThreadController') ? 'task-overhead' : 'script';
  return 'other';
};

function summarize(name, file, wall) {
  const tr = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ev = tr.traceEvents || tr;
  const names = new Map();
  for (const e of ev) if (e.ph === 'M' && e.name === 'thread_name') names.set(`${e.pid}:${e.tid}`, e.args.name);
  // The renderer main thread that did the most work.
  const tot = new Map();
  for (const e of ev) if (e.ph === 'X' && names.get(`${e.pid}:${e.tid}`) === 'CrRendererMain') tot.set(`${e.pid}:${e.tid}`, (tot.get(`${e.pid}:${e.tid}`) || 0) + (e.dur || 0));
  const main = [...tot.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const mine = ev.filter((e) => `${e.pid}:${e.tid}` === main && (e.ph === 'X' || e.ph === 'B' || e.ph === 'E')).filter((e) => e.ph === 'X').sort((a, b) => a.ts - b.ts || (b.dur || 0) - (a.dur || 0));
  // Self time per event name (nested complete events).
  const self = new Map(); const stack = [];
  let busy = 0; let long = 0; let longest = 0;
  for (const e of mine) {
    while (stack.length && stack[stack.length - 1].end <= e.ts) stack.pop();
    const d = e.dur || 0;
    if (!stack.length) { busy += d; if (/RunTask|ThreadControllerImpl/.test(e.name) && d > 50000) long++; if (d > longest) longest = d; }
    if (stack.length) stack[stack.length - 1].child += d;
    const fr = { e, end: e.ts + d, child: 0 };
    stack.push(fr);
    e._fr = fr;
  }
  for (const e of mine) { const s = (e.dur || 0) - e._fr.child; self.set(e.name, (self.get(e.name) || 0) + Math.max(0, s)); }
  const buckets = {};
  for (const [n, s] of self) buckets[BUCKET(n)] = (buckets[BUCKET(n)] || 0) + s;
  const ms = (us) => (us / 1000).toFixed(1);
  const top = (m, k) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
  const lines = [];
  lines.push(`\n==== ${name}  (wall ${wall} ms, main busy ${ms(busy)} ms = ${Math.round(busy / 10 / wall)}%, long tasks ${long}, longest ${ms(longest)} ms, cpu ${RATE}x)`);
  lines.push('  buckets: ' + Object.entries(buckets).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${ms(v)}`).join(' | '));
  lines.push('  top events (self ms): ' + top(self, 14).map(([k, v]) => `${k} ${ms(v)}`).join(' | '));
  const text = lines.join('\n');
  console.log(text);
  fs.unlinkSync(file); // traces are hundreds of MB
  return text;
}

for (const s of SCEN) {
  try {
    if (s === 'lib1440' || s === 'home1440' || s === 'home390' || s === 'lib390') {
      const url = s.startsWith('lib') ? '/library' : '/';
      await prep(url, s.endsWith('390') ? PHONE : DESK);
      await traced(`${s}-idle`, () => sleep(2500));
      await page.evaluate(() => window.scrollTo(0, 0)); await sleep(300);
      await traced(`${s}-scroll`, () => scrollRun(page, { steps: 55 }));
    } else if (s === 'series1440' || s === 'series390') {
      if (!seriesId) { console.log('no series id'); continue; }
      await prep(`/series/?id=${encodeURIComponent(seriesId)}`, s.endsWith('390') ? PHONE : DESK);
      await traced(`${s}-idle`, () => sleep(2500));
      await page.evaluate(() => window.scrollTo(0, 0)); await sleep(300);
      await traced(`${s}-scroll`, () => scrollRun(page, { steps: 55 }));
    } else if (s === 'nav1440' || s === 'nav390') {
      await prep('/', s.endsWith('390') ? PHONE : DESK);
      await traced(`${s}-home-to-library`, async () => {
        await page.evaluate(() => { const a = [...document.querySelectorAll('a[href]')].find((x) => /^\/library\/?$/.test(new URL(x.href).pathname)); a && a.click(); });
        await sleep(2500);
      });
      await traced(`${s}-library-to-series`, async () => {
        await page.evaluate(() => { const a = [...document.querySelectorAll('main a[href*="/series/"]')][0]; a && a.click(); });
        await sleep(2500);
      });
      await traced(`${s}-series-back`, async () => { await page.goBack().catch(() => {}); await sleep(2500); });
    } else if (s === 'tilt1440') {
      const c = await pressHover();
      await prep('/library', DESK);
      await traced('tilt1440-sweep', async () => {
        for (let y = 260; y < 820; y += 40) for (let x = 120; x < 1400; x += 24) { await page.mouse.move(x, y); }
      });
      await c.detach();
    }
  } catch (e) { console.log(`!! ${s}: ${e.message}`); }
}
await browser.close();
