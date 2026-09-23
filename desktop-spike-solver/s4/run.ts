// S4: do Cloudflare challenges solve in HIDDEN windows, and how fast?
//
// For each URL (a page that served a challenge in S3) and each solver, N cold solves: every one in a brand-new
// named session (a fresh, empty cookie jar = a cold challenge), then a SECOND request in the same session to
// see whether the cf_clearance from the first skips the challenge (the design's claimed improvement over
// FlareSolverr's session-less calls), then the session is destroyed.
//
//   SOLVERS='{"A":"<url>","B":"<url>"}' URLS='["https://…"]' N=5 GAP=10000 OUT=<json> node --import tsx s4/run.ts
import { writeFileSync } from 'node:fs';

const solvers: Record<string, string> = JSON.parse(process.env.SOLVERS!);
const urls: string[] = JSON.parse(process.env.URLS!);
const N = Number(process.env.N || 5);
const GAP = Number(process.env.GAP || 10000);
const OUT = process.env.OUT!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lastHit = new Map<string, number>();

async function call(base: string, body: Record<string, unknown>) {
  const t = Date.now();
  const r = await fetch(`${base}/v1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  const j: any = await r.json();
  return { http: r.status, origin: r.headers.get('x-origin-status'), ms: Date.now() - t, message: j.message, bytes: (j.solution?.response || '').length, cookies: (j.solution?.cookies || []).map((c: any) => c.name) };
}

(async () => {
  const rows: any[] = [];
  for (let i = 0; i < N; i++) {
    for (const url of urls) {
      for (const [name, base] of Object.entries(solvers)) {
        const host = new URL(url).host;
        const wait = (lastHit.get(host) ?? 0) + GAP - Date.now();
        if (wait > 0) await sleep(wait);
        const session = `s4-${name}-${i}-${Date.now()}`;
        const first = await call(base, { cmd: 'request.get', url, session, maxTimeout: 60000 }).catch((e) => ({ error: String(e) }));
        const d1 = await (await fetch(`${base}/_debug/last`)).json().catch(() => null);
        await sleep(1500);
        const second = await call(base, { cmd: 'request.get', url, session, maxTimeout: 60000 }).catch((e) => ({ error: String(e) }));
        const d2 = await (await fetch(`${base}/_debug/last`)).json().catch(() => null);
        await call(base, { cmd: 'sessions.destroy', session }).catch(() => null);
        lastHit.set(host, Date.now());
        const row = {
          i, url, solver: name, at: new Date().toISOString(), first, second,
          firstDetail: d1 && { challenged: d1.challenged, reason: d1.challengeReason, solveMs: d1.solveMs, totalMs: d1.totalMs, firstLoadMs: d1.firstLoadMs, clicked: d1.clicked, wouldShow: d1.wouldShow, statuses: d1.statuses, peakRssKB: d1.peakRssKB, spawned: d1.spawned, peakProcs: d1.peakProcs },
          secondDetail: d2 && { challenged: d2.challenged, solveMs: d2.solveMs, totalMs: d2.totalMs, statuses: d2.statuses, reusedWindow: d2.reusedWindow },
        };
        rows.push(row);
        console.log(`${row.at} ${name} ${host} #${i} first: ${(first as any).message ?? (first as any).error} ${(first as any).ms}ms solve=${d1?.solveMs} statuses=${JSON.stringify(d1?.statuses)} clicked=${d1?.clicked} rss=${d1?.peakRssKB} | second: ${(second as any).message ?? (second as any).error} ${(second as any).ms}ms statuses=${JSON.stringify(d2?.statuses)}`);
        writeFileSync(OUT, JSON.stringify(rows, null, 1));
      }
    }
  }
  console.log('done');
})();
