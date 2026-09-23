// S3: the desktop solver (UA mode A and B) against the live FlareSolverr, on the owner's real sites, same IP,
// same hour, through the bff's own client and engines (see worker.ts).
//
//   SITES=<sites.json> FS=http://192.168.208.2:8191 A=<solver A url> B=<solver B url> OUT=<results.json>
//   node --import tsx s3/run.ts
//
// Politeness, as briefed: one request in flight at all (so FlareSolverr never sees two), >= 5 s between two
// requests to the same host from any variant, at most 3 page requests per site per variant, and a variant
// stops on a site at its first refusal (403/429/"blocked"); the site stops when every variant has been refused.
import { Worker } from 'node:worker_threads';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rebase } from '../../bff/src/lib/sources/slug';

// Round 1: FS, A, B. A later round can compare new solver builds without touching FlareSolverr again:
//   VARIANTS='{"A2":"<url>","B2":"<url>"}'  INPUT=<round-1 results.json> (reuse its URLs)  SKIP='{"site":["step"]}'
type Variant = string;
const target: Record<Variant, string> = process.env.VARIANTS ? JSON.parse(process.env.VARIANTS) : { FS: process.env.FS!, A: process.env.A!, B: process.env.B! };
const VARIANTS: Variant[] = Object.keys(target);
const SKIP: Record<string, string[]> = JSON.parse(process.env.SKIP || '{}');
const PRIOR: Record<string, Record<string, string | null>> = process.env.INPUT ? JSON.parse(readFileSync(process.env.INPUT, 'utf8')).input ?? {} : {};
const sites: Array<{ engine: string; id: string; name: string; base: string }> = JSON.parse(readFileSync(process.env.SITES!, 'utf8'));
const known: Record<string, string> = JSON.parse(process.env.KNOWN_SERIES || '{}');
const OUT = process.env.OUT!;
const GAP = 5000;

interface OpResult { id: number; ms: number; result?: any; error?: string; requests: any[] }
class Runner {
  w: Worker;
  private n = 0;
  private waiting = new Map<number, (r: OpResult) => void>();
  ready: Promise<void>;
  constructor(public v: Variant) {
    this.w = new Worker(join(__dirname, 'worker.ts'), { execArgv: ['--import', 'tsx'], workerData: { target: target[v], sites } });
    this.ready = new Promise((res) => this.w.on('message', (m) => { if (m.ready) res(); else this.waiting.get(m.id)?.(m); }));
  }
  op(op: string, site: string, arg?: string): Promise<OpResult> {
    const id = ++this.n;
    return new Promise((res) => { this.waiting.set(id, res); this.w.postMessage({ id, op, site, arg }); });
  }
}

const lastHit = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function polite(hosts: string[]) {
  for (const h of hosts) {
    const wait = (lastHit.get(h) ?? 0) + GAP - Date.now();
    if (wait > 0) await sleep(wait);
  }
}
const hostOf = (u?: string | null) => { try { return new URL(String(u)).host; } catch { return ''; } };

/** A refusal: FlareSolverr's "blocked", or our solver reporting the origin's final 403/429. */
function refused(reqs: any[]): string | null {
  for (const r of reqs) {
    if (/Cloudflare has blocked/i.test(r.message)) return 'blocked';
    if (r.ok && (r.originStatus === '403' || r.originStatus === '429')) return `origin ${r.originStatus}`;
  }
  return null;
}
const success = (op: string, r: OpResult): boolean => {
  if (r.error || !r.result) return false;
  if (op === 'series') return !!r.result.title;
  if (op === 'latest' || op === 'chapters' || op === 'pages') return r.result.count > 0;
  if (op === 'image') return r.result.status === 200 && r.result.isImage;
  return false;
};

(async () => {
  const runners = Object.fromEntries(VARIANTS.map((v) => [v, new Runner(v)])) as Record<Variant, Runner>;
  if (!VARIANTS.every((v) => target[v])) throw new Error('every variant needs a target url');
  await Promise.all(VARIANTS.map((v) => runners[v].ready));
  const rows: any[] = [];
  const stopped: Record<string, Set<Variant>> = {};
  const siteStopped = new Set<string>();
  const input: Record<string, Record<string, string | null>> = {};
  for (const s of sites) {
    stopped[s.id] = new Set();
    input[s.id] = {};
    if (known[s.id]) input[s.id].series = rebase(known[s.id], s.base.replace(/\/$/, ''));
    Object.assign(input[s.id], PRIOR[s.id] ?? {});
  }
  // Each site's 3 page requests, then the image follow-up.
  const steps = (id: string) => known[id] ? ['series', 'chapters', 'pages', 'image'] : ['latest', 'series', 'chapters'];
  const started = new Date().toISOString();

  for (let stepIdx = 0; stepIdx < 4; stepIdx++) {
    for (let slot = 0; slot < Math.max(3, VARIANTS.length); slot++) {
      for (const s of sites) {
        const op = steps(s.id)[stepIdx];
        if (!op || siteStopped.has(s.id)) continue;
        // Rotate who goes first per step, so no variant is always the one meeting a cold challenge.
        if (slot >= VARIANTS.length) continue;
        const v = VARIANTS[(slot + stepIdx) % VARIANTS.length];
        if (SKIP[s.id]?.includes(op)) { rows.push({ site: s.id, step: op, variant: v, skipped: 'skipped in this round (SKIP)' }); continue; }
        if (stopped[s.id].has(v)) { rows.push({ site: s.id, step: op, variant: v, skipped: 'stopped after a refusal' }); continue; }
        const arg = op === 'latest' ? undefined : op === 'series' ? input[s.id].series : op === 'chapters' ? input[s.id].series : op === 'pages' ? input[s.id].chapter : input[s.id].image;
        if (op !== 'latest' && !arg) { rows.push({ site: s.id, step: op, variant: v, skipped: 'no input (earlier step failed for every variant)' }); continue; }
        const hosts = [hostOf(s.base), hostOf(arg)].filter(Boolean);
        await polite(hosts);
        const t = new Date().toISOString();
        const r = await runners[v].op(op, s.id, arg ?? undefined);
        for (const q of r.requests) if (!q.cached) lastHit.set(hostOf(q.url), Date.now());
        for (const h of hosts) lastHit.set(h, Date.now());
        const ok = success(op, r);
        const why = refused(r.requests.filter((q: any) => !q.cached && hostOf(q.url) === hostOf(s.base)));
        rows.push({ site: s.id, step: op, variant: v, at: t, ok, ms: r.ms, arg, result: r.result, error: r.error, refused: why, requests: r.requests });
        console.log(`${t} ${s.id.padEnd(12)} ${op.padEnd(8)} ${v.padEnd(2)} ${ok ? 'OK  ' : 'FAIL'} ${String(r.ms).padStart(6)}ms ${r.requests.map((q: any) => `[${q.cached ? 'cache' : q.ms + 'ms'} ${q.httpStatus}/${q.originStatus ?? '-'} ${q.message.slice(0, 40)} ${q.bytes}B ${q.cookies.join(',')}]`).join(' ')} ${r.error ? 'ERR ' + r.error.slice(0, 120) : JSON.stringify(r.result).slice(0, 160)}`);
        // The next step's input, from the first variant that got it.
        if (ok && op === 'latest' && !input[s.id].series) input[s.id].series = rebase(r.result.first, s.base.replace(/\/$/, ''));
        if (ok && op === 'chapters' && !input[s.id].chapter) input[s.id].chapter = r.result.newest;
        if (ok && op === 'pages' && !input[s.id].image) input[s.id].image = r.result.first;
        if (why && op !== 'image') {
          stopped[s.id].add(v);
          if (stopped[s.id].size === VARIANTS.length) siteStopped.add(s.id);
        }
        writeFileSync(OUT, JSON.stringify({ started, rows }, null, 1));
      }
    }
  }
  writeFileSync(OUT, JSON.stringify({ started, finished: new Date().toISOString(), rows, input }, null, 1));
  for (const v of VARIANTS) await runners[v].w.terminate();
  console.log('done');
})();
