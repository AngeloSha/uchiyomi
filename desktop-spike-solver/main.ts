// Spike rig: run the desktop solver on its own in Electron, for S3/S4 measurements.
//
//   SOLVER_UA_MODE=A|B  SOLVER_TOKEN=<hex>  SOLVER_PORT=0  SOLVER_WINDOW_MODE=hidden|offscreen
//   electron dist/desktop-spike-solver/main.js
//
// Prints `SOLVER_READY <url>` once listening. Spike-only debug routes (never in the product):
//   GET <url>/_debug/last     the last solve's detail + its peak RSS and the renderer processes it spawned
//   GET <url>/_debug/metrics  app.getAppMetrics() now, summed
import { app } from 'electron';
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { startSolverServer } from '../desktop/src/solver/server';
import { ElectronSolverBackend, type SolveDetail } from '../desktop/src/solver/browser';
import { parseUaMode, userAgentFor } from '../desktop/src/solver/userAgent';

const mode = parseUaMode(process.env.SOLVER_UA_MODE, 'native');
// Before any session exists (design-shell.md §3.4).
const nativeUa = app.userAgentFallback;
app.userAgentFallback = userAgentFor(mode, nativeUa);

const logFile = process.env.SOLVER_LOG;
const log = (event: string, data: Record<string, unknown> = {}) => {
  const line = JSON.stringify({ t: new Date().toISOString(), event, ...data });
  process.stdout.write(line + '\n');
  if (logFile) { try { appendFileSync(logFile, line + '\n'); } catch { /* best effort */ } }
};

interface Sample { pid: number; type: string; kb: number }
const metricsNow = (): { total: number; procs: Sample[] } => {
  const procs = app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, kb: m.memory.workingSetSize }));
  return { total: procs.reduce((a, p) => a + p.kb, 0), procs };
};

let sampling: NodeJS.Timeout | undefined;
let active = 0;
let peak = { total: 0, procs: [] as Sample[] };
let before = new Set<number>();
let seenDuring = new Map<number, string>();
type Detail = SolveDetail & { peakRssKB?: number; peakProcs?: Sample[]; spawned?: Array<{ pid: number; type: string }> };
let last: Detail | null = null;
const all: Detail[] = [];

function startSampling(): void {
  if (active++ > 0) return;
  before = new Set(app.getAppMetrics().map((m) => m.pid));
  seenDuring = new Map();
  peak = metricsNow();
  sampling = setInterval(() => {
    const m = metricsNow();
    for (const p of m.procs) if (!before.has(p.pid)) seenDuring.set(p.pid, p.type);
    if (m.total > peak.total) peak = m;
  }, 200);
}
function stopSampling(): void {
  if (--active > 0) return;
  if (sampling) clearInterval(sampling);
  sampling = undefined;
}

app.on('window-all-closed', () => { /* stay alive: the solver has no visible UI */ });
app.dock?.hide();

app.whenReady().then(async () => {
  const backend = new ElectronSolverBackend({
    humanCheck: 'log',
    windowMode: process.env.SOLVER_WINDOW_MODE === 'offscreen' ? 'offscreen' : 'hidden',
    log,
    onSolveDetail: (d) => {
      const m = metricsNow();
      if (m.total > peak.total) peak = m;
      last = { ...d, peakRssKB: peak.total, peakProcs: peak.procs, spawned: [...seenDuring].map(([pid, type]) => ({ pid, type })) };
      all.push(last);
      log('solve-detail', last as unknown as Record<string, unknown>);
    },
  });
  const token = process.env.SOLVER_TOKEN || randomBytes(16).toString('hex');
  const srv = await startSolverServer({
    backend,
    token,
    appVersion: 'spike',
    port: Number(process.env.SOLVER_PORT || 0),
    onEvent: (e) => {
      if (e.type === 'solve-start') startSampling();
      if (e.type === 'solve-end') stopSampling();
      log(`server-${e.type}`, e as unknown as Record<string, unknown>);
    },
    debugRoutes: {
      last: () => last,
      details: () => all,
      metrics: () => metricsNow(),
      stats: () => backend.stats(),
    },
  });
  log('ready', { mode, userAgent: app.userAgentFallback, nativeUa, electron: process.versions.electron, chrome: process.versions.chrome });
  process.stdout.write(`SOLVER_READY ${srv.url}\n`);
  const quit = async () => { await srv.close(); await backend.shutdown(); app.exit(0); };
  process.on('SIGTERM', () => { void quit(); });
  process.on('SIGINT', () => { void quit(); });
});
