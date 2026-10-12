// The webtoon column under a steady scroll (v0.61.0): frame times, long tasks, how many full-size page images are
// decoded at once and how many pixels they hold, and the JS heap -- over a chapter of long strips and one of slices.
//
//   cd web && npm i --no-save playwright && npx playwright install chromium
//   KEEP=1 E2E_NO_WALK=1 bash test/e2e/up.sh   # then seed the comfort library: python3 test/e2e/seed.py <lib> --comfort
//   BASE=http://127.0.0.1:18140 node test/perf/reader.mjs
//
// Chromium only (the heap comes from the DevTools protocol). Like the rest of this folder, not part of CI: a shared
// runner's frame timings are noise. Compare two builds on the same machine, one after the other.
import { createRequire } from 'node:module';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  try { ({ chromium } = createRequire(process.env.PLAYWRIGHT_FROM || `${process.cwd()}/`)('playwright')); } catch { /* below */ }
}
if (!chromium) { console.error('reader.mjs drives Chromium through Playwright: `npm i --no-save playwright && npx playwright install chromium` first'); process.exit(2); }

const BASE = (process.env.BASE || 'http://127.0.0.1:18140').replace(/\/$/, '');
const USER = process.env.E2E_USER || 'e2e';
const PASS = process.env.E2E_PASS || 'e2e-passw0rd-123';
const SECONDS = Number(process.env.SECONDS || 12);
const SPEED = Number(process.env.SPEED || 60); // px per frame: a brisk fling, held
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const login = await (await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) })).json();
const api = async (path, opts = {}) => (await fetch(BASE + path, { ...opts, headers: { authorization: `Bearer ${login.accessToken}`, 'content-type': 'application/json' } })).json();
const strip = (await api('/api/series/search', { method: 'POST', body: JSON.stringify({ query: '', size: 200 }) })).content.find((s) => s.name === 'Strip Long');
if (!strip) { console.error('no Strip Long: seed the comfort library first (seed.py <lib> --comfort)'); process.exit(1); }
const chapters = (await api(`/api/series/${strip.id}/books?size=10`)).content.sort((a, b) => a.number - b.number).map((b) => b.id);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block' });
const page = await context.newPage();
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('input[type=password]');
await sleep(2500);
await page.locator('input').first().fill(USER);
await page.locator('input[type=password]').fill(PASS);
await page.keyboard.press('Enter');
await sleep(3500);
const reader = { junkPages: 'collapse', skipJunk: true, gap: 0, brightness: 1, mode: 'vertical', autoScroll: 0, fitWidth: true, theme: 'amoled', spread: false, pagedDirection: 'series' };
await api('/api/settings', { method: 'PUT', body: JSON.stringify({ reader, readerSeries: {}, readerSource: {} }) });
await page.evaluate((r) => { localStorage.setItem('yomi_reader_prefs', JSON.stringify(r)); localStorage.removeItem('yomi_reader_device'); }, reader);
const cdp = await context.newCDPSession(page);
await cdp.send('Performance.enable');
const heap = async () => {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return Math.round((metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0) / 1e6);
};

async function run(label, bookId) {
  await page.goto(`${BASE}/reader/?book=${bookId}&page=1`, { waitUntil: 'networkidle' });
  await page.waitForSelector('div.touch-pan-y');
  await sleep(2500);
  const r = await page.evaluate(([seconds, speed]) => new Promise((done) => {
    const el = document.querySelector('div.touch-pan-y');
    const frames = [];
    let long = 0;
    let longMs = 0;
    const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) { long++; longMs += e.duration; } });
    try { po.observe({ type: 'longtask', buffered: false }); } catch { /* no long tasks here */ }
    let maxImgs = 0;
    let maxMpx = 0;
    const end = performance.now() + seconds * 1000;
    let last = performance.now();
    const tick = (now) => {
      frames.push(now - last);
      last = now;
      el.scrollTop += speed;
      const full = [...el.querySelectorAll('img')].filter((i) => /\/page\/\d+$/.test(new URL(i.src, location.href).pathname)
        && !new URL(i.src, location.href).search && i.complete && i.naturalWidth > 0);
      maxImgs = Math.max(maxImgs, full.length);
      maxMpx = Math.max(maxMpx, full.reduce((s, i) => s + i.naturalWidth * i.naturalHeight, 0) / 1e6);
      if (now < end) requestAnimationFrame(tick);
      else {
        po.disconnect();
        const sorted = frames.slice(1).sort((a, b) => a - b);
        const avg = sorted.reduce((s, x) => s + x, 0) / sorted.length;
        done({
          fps: Math.round(1000 / avg), p95: Math.round(sorted[Math.floor(sorted.length * 0.95)]), max: Math.round(sorted.at(-1)),
          over33: Math.round((sorted.filter((x) => x > 33.4).length / sorted.length) * 100), long, longMs: Math.round(longMs),
          maxImgs, maxMpx: Math.round(maxMpx), scrolled: Math.round(el.scrollTop),
        });
      }
    };
    requestAnimationFrame(tick);
  }), [SECONDS, SPEED]);
  r.heapMB = await heap();
  console.log(`${label.padEnd(18)} fps ${String(r.fps).padStart(3)}  p95 ${String(r.p95).padStart(4)}ms  max ${String(r.max).padStart(5)}ms  >33ms ${String(r.over33).padStart(3)}%  long ${r.long}/${r.longMs}ms  `
    + `decoded ≤${r.maxImgs} imgs / ${r.maxMpx} Mpx  heap ${r.heapMB} MB  (${r.scrolled} px)`);
}

console.log(`${BASE}: ${SECONDS} s at ${SPEED} px/frame, 390 x 844 @2x`);
await run('long strips', chapters[0]);
await run('slices', chapters[1]);
await browser.close();
