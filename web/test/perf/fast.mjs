// Fast scrolling on a computer (v0.67.3, "Home or Library on desktop, scrolling down or up fast lags a bit": choppy, Chrome).
// Flicks a wheel down and back up fast (or a trackpad fling) and reports the frame rate, the frames over 33 ms, the main
// thread's tasks over a frame's budget, and the longest tasks broken down by what they were doing.
//
//   BASE=http://127.0.0.1:18140 node test/perf/fast.mjs                         # Home and the Library, CPU unthrottled
//   PAGES=/library RATES=1,4 KIND=trackpad BASE=… node test/perf/fast.mjs       # a fling, also at 4x
//   CSS='.fx-grain{display:none!important}' BASE=… node test/perf/fast.mjs      # price one effect
//   JS=1 BASE=… node test/perf/fast.mjs                                         # + the script that ran, by function
//
// ⚠️ Read the frame rate as the compositor's cost: headless Chrome composites in software, so an effect that costs a GPU
// pass shows here as frames. Read BUDGET (main-thread tasks over 16.7 ms) as what a machine with a GPU waits on.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeBrowser, signIn, installFixture, cpu, sleep, setCss, BASE } from './lib.mjs';

const RATES = (process.env.RATES || '1,4').split(',').map(Number);
const PAGES = (process.env.PAGES || '/,/library').split(',');
const KIND = process.env.KIND || 'wheel';
const OUT = process.env.OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'perf-fast-'));

const browser = await makeBrowser();
const page = await signIn(browser);
await installFixture(page);
await page.setViewport({ width: 1440, height: 900 });

const REC = () => {
  window.__f = []; let last = performance.now();
  const tick = (t) => { window.__f.push(t - last); last = t; if (window.__f.length < 5000) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
};
const COL = () => {
  const f = window.__f.slice(1); const n = f.length || 1;
  const over = (ms) => f.filter((x) => x > ms).length;
  const sorted = [...f].sort((a, b) => b - a);
  return { frames: f.length, fps: +(1000 / (f.reduce((a, b) => a + b, 0) / n)).toFixed(1), over20: over(20), over33: over(33), over50: over(50), worst: sorted.slice(0, 6).map((x) => Math.round(x)) };
};

async function fling(down) {
  const s = down ? 1 : -1;
  await page.mouse.move(720, 450);
  if (KIND === 'wheel') {
    // three quick flicks of a notched wheel: 14 notches of 120 px, ~12 ms apart, a beat between flicks
    for (let k = 0; k < 3; k++) { for (let i = 0; i < 14; i++) { await page.mouse.wheel({ deltaY: s * 120 }); await sleep(12); } await sleep(260); }
  } else {
    // a trackpad fling: many small deltas, fast then easing off
    for (let i = 0; i < 90; i++) { await page.mouse.wheel({ deltaY: s * Math.max(6, 90 - i) }); await sleep(8); }
  }
  await sleep(1300); // let Lenis land
}

function summarize(file) {
  const tr = JSON.parse(fs.readFileSync(file, 'utf8')); const ev = tr.traceEvents || tr;
  const names = new Map(); for (const e of ev) if (e.ph === 'M' && e.name === 'thread_name') names.set(`${e.pid}:${e.tid}`, e.args.name);
  const tot = new Map(); for (const e of ev) if (e.ph === 'X' && names.get(`${e.pid}:${e.tid}`) === 'CrRendererMain') tot.set(`${e.pid}:${e.tid}`, (tot.get(`${e.pid}:${e.tid}`) || 0) + (e.dur || 0));
  const main = [...tot.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const mine = ev.filter((e) => `${e.pid}:${e.tid}` === main && e.ph === 'X').sort((a, b) => a.ts - b.ts || (b.dur || 0) - (a.dur || 0));
  // top-level tasks
  const tasks = []; let end = 0;
  for (const e of mine) { if (e.ts >= end && /RunTask|ThreadControllerImpl::RunTask/.test(e.name)) { tasks.push(e); end = e.ts + (e.dur || 0); } }
  tasks.sort((a, b) => (b.dur || 0) - (a.dur || 0));
  const out = [];
  for (const t of tasks.slice(0, 6)) {
    const inner = mine.filter((e) => e !== t && e.ts >= t.ts && e.ts + (e.dur || 0) <= t.ts + t.dur);
    // self time per name inside this task
    const self = new Map(); const stack = [];
    for (const e of inner) {
      while (stack.length && stack[stack.length - 1].end <= e.ts) stack.pop();
      if (stack.length) stack[stack.length - 1].child += e.dur || 0;
      const fr = { e, end: e.ts + (e.dur || 0), child: 0 }; stack.push(fr); e._fr = fr;
    }
    for (const e of inner) { const s = (e.dur || 0) - e._fr.child; if (s > 0) self.set(e.name, (self.get(e.name) || 0) + s); }
    const fns = inner.filter((e) => e.name === 'FunctionCall' || e.name === 'EventDispatch' || e.name === 'TimerFire' || e.name === 'FireAnimationFrame')
      .map((e) => `${e.name === 'EventDispatch' ? 'event:' + (e.args?.data?.type || '?') : e.name === 'TimerFire' ? 'timer' : e.name === 'FireAnimationFrame' ? 'rAF' : (e.args?.data?.functionName || 'fn') + '@' + String(e.args?.data?.url || '').split('/').pop() + ':' + e.args?.data?.lineNumber} ${((e.dur || 0) / 1000).toFixed(1)}`)
      .slice(0, 5);
    out.push(`    task ${(t.dur / 1000).toFixed(1)} ms: ` + [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}`).join(' | ') + (fns.length ? `\n        calls: ${fns.join(', ')}` : ''));
  }
  // whole-window buckets
  const sum = new Map(); for (const e of mine) if (['Layerize', 'UpdateLayoutTree', 'Layout', 'Paint', 'PrePaint', 'HitTest', 'FunctionCall', 'IntersectionObserverController::computeIntersections', 'Commit', 'PaintImage', 'Decode Image'].includes(e.name)) sum.set(e.name, (sum.get(e.name) || 0) + (e.dur || 0));
  // Main-thread tasks over a frame's budget, the profiler's own start-up spike excluded: on a machine whose GPU keeps up,
  // each of these is a frame Lenis did not move the page on.
  const budget = tasks.filter((t) => { const prof = mine.filter((e) => e.name === 'V8.InvokeApiInterruptCallbacks' && e.ts >= t.ts && e.ts < t.ts + t.dur).reduce((a, e) => a + (e.dur || 0), 0); return prof < t.dur / 2; });
  const over = (ms) => budget.filter((t) => t.dur > ms * 1000).length;
  const long = { over16: over(16.7), over25: over(25), over33: over(33), mainBusyMs: Math.round(budget.reduce((a, t) => a + t.dur, 0) / 1000) };
  // Which JavaScript runs: every FunctionCall / event dispatch, by function and position, total ms.
  const js = new Map();
  for (const e of mine) {
    if (e.name !== 'FunctionCall' && e.name !== 'EventDispatch') continue;
    const d = e.args?.data || {};
    const k = e.name === 'EventDispatch' ? `event:${d.type}` : `${d.functionName || '(anon)'} @ ${String(d.url || '').split('/').pop()}:${d.lineNumber}:${d.columnNumber}`;
    const v = js.get(k) || { ms: 0, n: 0 }; v.ms += (e.dur || 0) / 1000; v.n++; js.set(k, v);
  }
  const jsTop = [...js.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 14).map(([k, v]) => `${v.ms.toFixed(0).padStart(5)} ms ${String(v.n).padStart(5)}x  ${k}`);
  fs.unlinkSync(file);
  return { long, jsTop, tasks: out, sum: [...sum.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.replace('IntersectionObserverController::computeIntersections', 'IO')} ${(v / 1000).toFixed(0)}`).join(' | ') };
}

for (const rate of RATES) for (const p of PAGES) {
  await cpu(page, 1);
  await page.goto(BASE + p, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  if (process.env.CSS) await setCss(page, process.env.CSS);
  await sleep(3000);
  await page.evaluate(() => window.scrollTo(0, 0)); await sleep(500);
  await cpu(page, rate);
  const file = path.join(OUT, `fast-${process.pid}.json`);
  await page.tracing.start({ path: file, screenshots: false });
  await page.evaluate(REC);
  await fling(true);
  const down = await page.evaluate(COL);
  await page.evaluate(REC);
  await fling(false);
  const up = await page.evaluate(COL);
  await page.tracing.stop();
  await cpu(page, 1);
  const s = summarize(file);
  console.log(`\n==== ${p} 1440 cpu${rate}x ${KIND}`);
  console.log(`  down: ${JSON.stringify(down)}`);
  console.log(`  up:   ${JSON.stringify(up)}`);
  console.log(`  main thread (ms): ${s.sum}`);
  console.log(`  BUDGET: ${JSON.stringify(s.long)}`);
  if (process.env.JS) { console.log('  JS (total, calls):'); for (const l of s.jsTop) console.log('    ' + l); }
  console.log('  longest tasks:'); for (const l of s.tasks) console.log(l);
}
await browser.close();
