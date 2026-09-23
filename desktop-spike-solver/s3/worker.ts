// S3 worker: ONE solver variant (live FlareSolverr, our solver in UA mode A, or B), driven through the bff's
// REAL code -- bff/src/lib/sources/flaresolverr.ts and the real madara/manganato engines -- in its own
// worker thread, so each variant has its own copy of the bff's per-origin cookie store (`sessions`).
//
// Between the bff client and the solver sits a logging proxy: it records what each solve really answered
// (message, origin status, body size, cookie names, UA, wall time) and replays an identical request from its
// cache instead of sending it twice. That keeps the engines' own fallbacks (madara re-reading the series page
// when the ajax list parses empty) from costing the site a second request.
import { parentPort, workerData } from 'node:worker_threads';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

interface Entry {
  cmd: string; url: string; postData?: string; cached: boolean; ms: number; httpStatus: number;
  originStatus: string | null; ok: boolean; message: string; bytes: number; cookies: string[]; ua: string; finalUrl: string;
}

const TARGET: string = workerData.target.replace(/\/$/, '');
const log: Entry[] = [];
const cache = new Map<string, { status: number; headers: Record<string, string>; body: string }>();

function startProxy(): Promise<string> {
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (req.method === 'GET') {
        const r = await fetch(`${TARGET}/`).catch(() => null);
        res.writeHead(r?.status ?? 502, { 'content-type': 'application/json' });
        res.end(r ? await r.text() : '{}');
        return;
      }
      const body = JSON.parse(raw || '{}');
      const key = `${body.cmd} ${body.url} ${body.postData ?? ''}`;
      const hit = cache.get(key);
      const t0 = Date.now();
      let status = 0, headers: Record<string, string> = {}, text = '';
      if (hit) ({ status, headers, body: text } = hit);
      else {
        try {
          const r = await fetch(`${TARGET}/v1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw, signal: AbortSignal.timeout(120_000) });
          status = r.status;
          text = await r.text();
          headers = { 'x-origin-status': r.headers.get('x-origin-status') ?? '' };
          cache.set(key, { status, headers, body: text });
        } catch (e) {
          status = 599;
          text = JSON.stringify({ status: 'error', message: `proxy: ${String((e as Error)?.message || e)}` });
        }
      }
      let j: any = {};
      try { j = JSON.parse(text); } catch { /* recorded below */ }
      log.push({
        cmd: body.cmd, url: body.url, postData: body.postData, cached: !!hit, ms: hit ? 0 : Date.now() - t0, httpStatus: status,
        originStatus: headers['x-origin-status'] || null, ok: j.status === 'ok', message: String(j.message ?? ''),
        bytes: String(j.solution?.response ?? '').length, cookies: (j.solution?.cookies ?? []).map((c: any) => c.name),
        ua: String(j.solution?.userAgent ?? ''), finalUrl: String(j.solution?.url ?? ''),
      });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(text);
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`)));
}

(async () => {
  process.env.FLARESOLVERR_URL = await startProxy();
  // Only now: the bff client reads FLARESOLVERR_URL at import time.
  const fs = await import('../../bff/src/lib/sources/flaresolverr');
  const { makeMadara } = await import('../../bff/src/lib/sources/engines/madara');
  const { makeManganato } = await import('../../bff/src/lib/sources/engines/manganato');
  const engines = new Map<string, any>();
  for (const s of workerData.sites as Array<{ engine: string; id: string; name: string; base: string }>) {
    engines.set(s.id, s.engine === 'manganato' ? makeManganato(s) : makeMadara(s));
  }

  /** The downloader's page fetch (bff/src/lib/downloader.ts:280-318), headers verbatim. */
  async function image(site: string, url: string) {
    const src = engines.get(site);
    const cf = await fs.cfSession(url).catch(() => null);
    const referer = typeof src.imageReferer === 'function' ? src.imageReferer(url) : src.imageReferer;
    const headers: Record<string, string> = {
      referer,
      accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': cf?.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    };
    if (cf?.cookie) headers.cookie = cf.cookie;
    const t0 = Date.now();
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(45000) });
    const buf = Buffer.from(await r.arrayBuffer());
    const magic = buf.subarray(0, 12).toString('hex');
    const isImage = /^(ffd8ff|89504e47|47494638|52494646)/.test(magic) || buf.subarray(4, 12).toString('latin1').includes('ftyp');
    return {
      status: r.status, ct: r.headers.get('content-type'), bytes: buf.length, isImage, ms: Date.now() - t0,
      sentCookie: (cf?.cookie || '').split('; ').filter(Boolean).map((c) => c.split('=')[0]), sentUa: headers['user-agent'],
      server: r.headers.get('server'), cfRay: r.headers.get('cf-ray'),
    };
  }

  parentPort!.on('message', async (m: { id: number; op: string; site: string; arg?: string }) => {
    const from = log.length;
    const t0 = Date.now();
    let result: unknown, error: string | undefined;
    try {
      const e = engines.get(m.site);
      if (m.op === 'latest') { const r = await e.latest(1); result = { count: r.length, first: r[0]?.sourceId ?? null }; }
      else if (m.op === 'series') { const r = await e.getSeries(m.arg); result = { title: r.title, cover: r.coverUrl ?? null, summary: (r.summary || '').length }; }
      else if (m.op === 'chapters') { const r = await e.listChapters(m.arg); result = { count: r.length, newest: r[r.length - 1]?.sourceId ?? null, oldest: r[0]?.sourceId ?? null }; }
      else if (m.op === 'pages') { const r: string[] = await e.getPageUrls(m.arg); result = { count: r.length, first: r[0] ?? null, second: r[1] ?? null }; }
      else if (m.op === 'image') result = await image(m.site, m.arg!);
      else if (m.op === 'reset') { result = fs.resetSolverSessions(); cache.clear(); }
      else throw new Error(`unknown op ${m.op}`);
    } catch (e) {
      error = String((e as Error)?.message || e).slice(0, 400);
    }
    parentPort!.postMessage({ id: m.id, ms: Date.now() - t0, result, error, requests: log.slice(from) });
  });
  parentPort!.postMessage({ ready: true, proxy: process.env.FLARESOLVERR_URL });
})();
