// The perf rig's shared harness: one browser, ONE sign-in, the real app, a synthetic library size.
//
// Not part of CI, on purpose: every number here is a frame timing, and a shared runner's timings are noise.
// It exists so the next "it stutters" report is measured rather than guessed -- see README.md for how to
// run it and for the numbers it produced when #71 was fixed.
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

export const BASE = (process.env.BASE || 'http://127.0.0.1:18140').replace(/\/$/, '');
const USER = process.env.E2E_USER || 'e2e';
const PASS = process.env.E2E_PASS || 'e2e-passw0rd-123';
/** `chrome` (default) or `firefox`. See README.md for what each can and cannot measure. */
export const BROWSER = process.env.BROWSER === 'firefox' ? 'firefox' : 'chrome';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How many series the fabricated library and rails pretend to hold. The reporter's real instance is unknown;
// the author's own live instance holds 224 series, so 200 is a fair model of a real library.
export const N_GRID = Number(process.env.N_GRID || 200);
export const N_RAIL = Number(process.env.N_RAIL || 20);


export async function makeBrowser() {
  if (BROWSER === 'firefox') {
    // Headless Firefox composites in software, so the blend, filter and backdrop costs WebRender would put
    // on a weak GPU land on the CPU here, where requestAnimationFrame can see them. There is no CPU
    // throttling in Firefox (no CDP), so its runs are unthrottled and say so.
    return puppeteer.launch({ browser: 'firefox', headless: true });
  }
  return puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
  });
}

/** Sign in ONCE (sign-in is rate limited to 10 per 5 minutes per address) and return the page. */
export async function signIn(browser) {
  const page = await browser.newPage();
  page.on('response', (r) => { if (/auth\/login/.test(r.url())) console.log('   [login]', r.status()); });
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector('input[type=password]', { timeout: 30000 });
  const inputs = await page.$$('input');
  await inputs[0].type(USER);
  await page.type('input[type=password]', PASS);
  await page.keyboard.press('Enter');
  await sleep(500);
  if (await page.$('input[type=password]')) {
    const btn = await page.$('button[type=submit], form button');
    if (btn) await btn.click().catch(() => {});
  }
  await page.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 30000 })
    .catch(() => {});
  await sleep(2500);
  if (await page.$('input[type=password]')) {
    const why = await page.evaluate(() => document.body.innerText.slice(0, 200));
    throw new Error('still on the sign-in form :: ' + why.replace(/\n/g, ' | '));
  }
  return page;
}

/**
 * Fabricate a library of N_GRID series and rails of N_RAIL out of the few the test instance seeds.
 *
 * Everything happens inside the page, before any of the app's own code runs, so it works the same in
 * Chrome and Firefox: `fetch` is wrapped to multiply the JSON, and every cover URL of a fabricated id is
 * pointed back at the real series it was cloned from, with a `perf=` query so each tile is still its own
 * request and its own decode, as two hundred different covers would be. (The first version answered the
 * covers through request interception, which Firefox's WebDriver BiDi refuses: every cover came back broken.)
 *
 * Every fourth series is a favourite, because the heart badge on a tile carries its own backdrop blur and a
 * library with no favourites hides that cost entirely -- the first version of this rig did exactly that.
 */
export async function installFixture(page) {
  await page.evaluateOnNewDocument((N_GRID, N_RAIL) => {
    // The service worker answers from its own context, where none of this reaches.
    try {
      if (navigator.serviceWorker) {
        navigator.serviceWorker.register = () => Promise.reject(new Error('perf rig: no service worker'));
      }
    } catch {}

    const real = (v) => (typeof v !== 'string' ? v : v.replace(
      /(\/img\/(?:series|books)\/)([^/?]+?)__([a-z]+\d+)(\/[^?#]*)(\?[^#]*)?/,
      (_m, pre, id, tag, rest, q) => `${pre}${id}${rest}${q ? q + '&' : '?'}perf=${tag}`));
    const d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    Object.defineProperty(HTMLImageElement.prototype, 'src', { ...d, set(v) { d.set.call(this, real(v)); } });
    const setAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (n, v) {
      return setAttr.call(this, n, n === 'src' || n === 'srcset' ? real(String(v)) : v);
    };

    const grow = (list, n, tag) => {
      if (!Array.isArray(list) || !list.length) return list;
      const out = [];
      for (let i = 0; i < n; i++) {
        const s = list[i % list.length];
        out.push({ ...s, id: `${s.id}__${tag}${i}`, name: `${s.name || 'Series'} ${i + 1}`,
          yomi: { ...(s.yomi || {}), favorite: i % 4 === 0 } });
      }
      return out;
    };
    const of = window.fetch;
    window.fetch = async (input, init) => {
      const res = await of(input, init);
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      try {
        if (/\/api\/series\/search/.test(url)) {
          const j = await res.clone().json();
          j.content = grow(j.content, N_GRID, 'g');
          j.last = true; j.totalElements = j.content.length; j.numberOfElements = j.content.length;
          return new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (/\/api\/home$/.test(url)) {
          const j = await res.clone().json();
          for (const k of ['updated', 'new', 'favorites', 'random']) if (j[k]) j[k] = grow(j[k], N_RAIL, k);
          return new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (/\/api\/(foryou|trending|featured)/.test(url)) {
          const j = await res.clone().json();
          const tag = url.includes('featured') ? 'f' : url.includes('trending') ? 't' : 'y';
          j.content = grow(j.content, url.includes('featured') ? 5 : N_RAIL, tag);
          return new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });
        }
      } catch {}
      return res;
    };
  }, N_GRID, N_RAIL);
}

/** How many covers on screen actually decoded -- a fixture that serves broken covers measures nothing. */
export const coversLoaded = (page) => page.evaluate(() => {
  const imgs = [...document.querySelectorAll('img')].filter((i) => /\/img\/series\//.test(i.currentSrc || i.src));
  return { total: imgs.length, decoded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length };
});

/**
 * Turn the Reduce effects switch on or off the way a person does: Profile -> Settings -> Appearance.
 *
 * Through the real row rather than by setting the class, because the class is re-applied from the ACCOUNT
 * on every load (web/lib/auth.tsx), and a rig that only faked the class would be measuring a state the app
 * immediately undoes.
 */
export async function setReduceEffects(page, on) {
  await page.goto(BASE + '/profile/?tab=Settings', { waitUntil: 'networkidle2', timeout: 60000 });
  const sel = 'button[role=switch][aria-label="Reduce effects"]';
  await page.waitForSelector(sel, { timeout: 20000 });
  const now = await page.$eval(sel, (b) => b.getAttribute('aria-checked') === 'true');
  if (now !== on) {
    await page.click(sel);
    await page.waitForFunction((s, want) => document.querySelector(s)?.getAttribute('aria-checked') === String(want),
      { timeout: 10000 }, sel, on);
    await sleep(1500); // the PUT, and the Saved tick
  }
  const cls = await page.evaluate(() => document.documentElement.classList.contains('reduce-effects'));
  if (cls !== on) throw new Error(`Reduce effects is ${on ? 'on' : 'off'} but html.reduce-effects is ${cls}`);
}

/**
 * What state the page was REALLY in when a row was timed.
 *
 * ⚠️ Printed beside every row, and not decoration. The baseline phase is called "switch off", but until a run
 * sets it off the account decides: an account left with Reduce effects on (a crashed run, an earlier script, a
 * real reader who uses it) made the baseline print ~60 fps on every row -- a table saying "nothing is wrong"
 * about a page that has no fx layers, no Lenis and no blur on it. A row taken in the wrong state now says so
 * in the log instead of being read as a number.
 */
export const pageState = (page) => page.evaluate(() => ({
  reduce: document.documentElement.classList.contains('reduce-effects'),
  lenis: document.documentElement.classList.contains('lenis'),
  fx: document.querySelectorAll('.fx-mesh, .fx-grain, .fx-vignette').length,
  tiles: document.querySelectorAll('a[href^="/series/"]').length,
}));

/** One short `[reduce … lenis … fx … tiles …]` tag for the end of a result line. */
export const fmtState = (s) => `[reduce ${s.reduce} lenis ${s.lenis} fx ${s.fx} tiles ${s.tiles}]`;

/**
 * Put the switch in the state this phase claims to measure, and say whether this build even has one.
 *
 * Returns false (and leaves the page where it is) on anything before v0.43.0, which has no row to click --
 * there the default IS the baseline. Any other failure is a real one and is thrown.
 */
export async function requireReduceEffects(page, on) {
  try {
    await setReduceEffects(page, on);
    return true;
  } catch (e) {
    // Only "the row is not there": a click that never took, or a class that disagrees with the row, is a real
    // failure and must stop the run rather than quietly become a baseline nobody set.
    if (/waiting for selector/i.test(e.message)) {
      console.log(`\n(no Reduce effects switch on this build: ${e.message.slice(0, 80)})`);
      return false;
    }
    throw e;
  }
}

/* ------------------------------------------------------------------ metrics */

export const RECORDER = () => {
  const w = window;
  w.__perf = { frames: [], long: [], t0: performance.now() };
  let last = performance.now();
  const tick = (t) => { w.__perf.frames.push(t - last); last = t; w.__perf.raf = requestAnimationFrame(tick); };
  w.__perf.raf = requestAnimationFrame(tick);
  try {
    w.__perf.po = new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__perf.long.push(e.duration); });
    w.__perf.po.observe({ entryTypes: ['longtask'] });
  } catch {}
};

export const COLLECT = () => {
  const p = window.__perf;
  cancelAnimationFrame(p.raf);
  try { p.po.disconnect(); } catch {}
  const f = p.frames.slice(2).sort((a, b) => a - b);
  const q = (x) => (f.length ? f[Math.min(f.length - 1, Math.floor(x * f.length))] : 0);
  const sum = f.reduce((a, b) => a + b, 0);
  return {
    frames: f.length,
    wall: Math.round(performance.now() - p.t0),
    fps: f.length ? +(1000 / (sum / f.length)).toFixed(1) : 0,
    p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +(f[f.length - 1] || 0).toFixed(1),
    over17: +((f.filter((x) => x > 17).length / (f.length || 1)) * 100).toFixed(0),
    over33: +((f.filter((x) => x > 33).length / (f.length || 1)) * 100).toFixed(0),
    longTasks: p.long.length,
    longMs: Math.round(p.long.reduce((a, b) => a + b, 0)),
  };
};

/** CPU throttling (Chrome only). Returns false in Firefox, which has no way to throttle. */
export async function cpu(page, rate) {
  if (BROWSER !== 'chrome') return false;
  const c = await page.target().createCDPSession();
  await c.send('Emulation.setCPUThrottlingRate', { rate });
  await c.detach();
  return true;
}

/**
 * Count the composited layers, Chrome only.
 *
 * ⚠️ The first version of this waited for a `layerTreeDidChange` AFTER changing the page and fell back to an
 * empty list when none came -- and on a page that had finished changing none ever comes, so it printed "0
 * layers without the cinematic layers", which is impossible (a composited page has at least its root) and
 * went into the plan as a measurement. Enabling the domain always sends the CURRENT tree, so this enables it
 * fresh for every reading, keeps the last tree that arrives, and returns null -- printed "n/a" -- when none
 * does. Never 0.
 */
export async function layerSnapshot(page) {
  if (BROWSER !== 'chrome') return null;
  const c = await page.target().createCDPSession();
  let last = null;
  const on = (e) => { if (Array.isArray(e.layers)) last = e.layers; };
  c.on('LayerTree.layerTreeDidChange', on);
  await c.send('LayerTree.enable');
  // ⚠️ The tree only arrives with a committed frame, and a page with nothing animating (Reduce effects on,
  // no drifting mesh) commits none: the library read "n/a" there until this nudge -- one pixel down and
  // back, which changes nothing on screen but makes the compositor commit.
  await page.evaluate(() => { window.scrollBy(0, 1); requestAnimationFrame(() => window.scrollBy(0, -1)); });
  const t0 = Date.now();
  while (!last && Date.now() - t0 < 6000) await sleep(100);
  await sleep(700); // one more commit, if a change was still landing
  c.off('LayerTree.layerTreeDidChange', on);
  await c.send('LayerTree.disable').catch(() => {});
  await c.detach().catch(() => {});
  if (!last) return null;
  const big = last.filter((l) => l.width * l.height > 200000)
    .sort((a, x) => x.width * x.height - a.width * a.height).slice(0, 6).map((l) => `${l.width}x${l.height}`);
  // Area as well as count: two 1440x10211 layers cost more raster and memory than a hundred tile-sized ones.
  const mpx = +(last.reduce((a, l) => a + l.width * l.height, 0) / 1e6).toFixed(1);
  return { total: last.length, drawing: last.filter((l) => l.drawsContent).length, mpx, biggest: big };
}

export async function scrollRun(page, { steps = 60, delta = 120, gap = 16 } = {}) {
  // The middle of whatever viewport this is. Firefox refuses a pointer outside the viewport outright (a
  // fixed 700,450 killed every 390-wide run there), where Chrome silently accepted it.
  const vp = page.viewport() || { width: 1440, height: 900 };
  await page.mouse.move(Math.round(vp.width / 2), Math.round(vp.height / 2));
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel({ deltaY: delta });
    await sleep(gap);
  }
}

/** Inject (or clear, with '') one stylesheet of A/B overrides. */
export const setCss = (page, css) => page.evaluate((c) => {
  document.getElementById('perf-ab')?.remove();
  if (c) { const s = document.createElement('style'); s.id = 'perf-ab'; s.textContent = c; document.head.appendChild(s); }
}, css);

/** Where the raw JSON goes: `PERF_OUT` (a directory) when set, nowhere otherwise. */
export function save(name, obj) {
  const dir = process.env.PERF_OUT;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}-${BROWSER}.json`), JSON.stringify(obj, null, 2));
}
