// The desktop app's Cloudflare solver endpoint: a FlareSolverr-v1-compatible HTTP API on loopback
// (design-shell.md §3.2, §3.5 "Security").
//
//   GET  /<token>/        {"msg":"FlareSolverr is ready!","version":"uchiyomi-desktop-<ver>","userAgent":…}
//   GET  /<token>/health  {"status":"ok"}
//   POST /<token>/v1      request.get | request.post | sessions.create | sessions.list | sessions.destroy
//
// Neither client changes: the bff strips a trailing "/" and appends "/v1" (bff/src/lib/sources/flaresolverr.ts:3,41)
// and Suwayomi does `removeSuffix("/") + "/v1"` (CloudflareInterceptor.kt:198). Only FLARESOLVERR_URL moves.
//
// Plain node:http, no Electron import, so the whole contract runs under plain Node in the tests with a fake
// backend. browser.ts is the real backend.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  MSG, BadRequest, SolveError, parseCommand, parseSolveRequest, pySeconds, solutionOf,
  type Envelope, type SolverBackend, type SolveRequest, type SolveResult,
} from './protocol';

export interface SolverServerOptions {
  backend: SolverBackend;
  /** 32 hex chars (128 bits) is plenty; it only has to be unguessable by a web page. */
  token: string;
  /** Printed as `uchiyomi-desktop-<appVersion>`. Deliberately not semver-shaped, see design-shell.md §3.2. */
  appVersion: string;
  /** 0 = pick a free port. The shell persists the one it got. */
  port?: number;
  /** Session-less requests (the bff) in flight at once. The bff never sends more than 4 (flaresolverr.ts:17). */
  concurrency?: number;
  /** Extra slots for named-session requests (Suwayomi holds a mutex, so it sends one at a time). */
  sessionConcurrency?: number;
  /** Request body cap in bytes. */
  maxBodyBytes?: number;
  /** Observability hook for the shell's log and the spike harness. Never on the response path. */
  onEvent?: (e: SolverEvent) => void;
  /** Spike/diagnostic routes under /<token>/_debug/…; off in the product. */
  debugRoutes?: Record<string, () => unknown>;
}

export type SolverEvent =
  | { type: 'solve-start'; id: number; method: string; url: string; session?: string; queuedMs: number }
  | { type: 'solve-end'; id: number; ok: true; ms: number; originStatus: number; challenged: boolean; bytes: number; cookies: string[] }
  | { type: 'solve-end'; id: number; ok: false; ms: number; error: string }
  | { type: 'rejected'; status: number; reason: string };

/** A counting semaphore with a FIFO queue. */
class Gate {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly size: number) {}
  async take(signal: AbortSignal): Promise<void> {
    if (this.active < this.size) { this.active++; return; }
    await new Promise<void>((resolve, reject) => {
      const go = () => { signal.removeEventListener('abort', gone); resolve(); };
      const gone = () => { this.queue = this.queue.filter((f) => f !== go); reject(new SolveError('timeout', 'queued')); };
      this.queue.push(go);
      signal.addEventListener('abort', gone, { once: true });
    });
    this.active++;
  }
  give(): void {
    this.active--;
    this.queue.shift()?.();
  }
  get inFlight(): number { return this.active; }
}

export interface SolverServer {
  /** http://127.0.0.1:<port>/<token> -- the value for FLARESOLVERR_URL and Suwayomi's flareSolverrUrl. */
  url: string;
  port: number;
  close(): Promise<void>;
}

const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(s),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(s);
};

export async function startSolverServer(opts: SolverServerOptions): Promise<SolverServer> {
  if (!/^[A-Za-z0-9_-]{16,}$/.test(opts.token)) throw new Error('solver token must be 16+ url-safe characters');
  const version = `uchiyomi-desktop-${opts.appVersion}`;
  const general = new Gate(Math.max(1, opts.concurrency ?? 4));
  const sessions = new Gate(Math.max(1, opts.sessionConcurrency ?? 1));
  const maxBody = opts.maxBodyBytes ?? 1024 * 1024;
  const tokenBuf = Buffer.from(opts.token);
  const inflight = new Set<AbortController>();
  let nextId = 1;
  let port = 0;

  const emit = (e: SolverEvent) => { try { opts.onEvent?.(e); } catch { /* observers never break a solve */ } };
  const reject = (res: http.ServerResponse, status: number, reason: string) => {
    emit({ type: 'rejected', status, reason });
    // Bottle's JSON 404 shape (FlareSolverr's JSONErrorBottle), without echoing anything back.
    json(res, status, { error: reason, status_code: status });
  };

  /** Constant-time check of the secret path segment. */
  const tokenOk = (seg: string): boolean => {
    const b = Buffer.from(seg);
    return b.length === tokenBuf.length && timingSafeEqual(b, tokenBuf);
  };

  const readBody = (req: http.IncomingMessage): Promise<Buffer | null> =>
    new Promise((resolve, rejectP) => {
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBody) { resolve(null); return; }
      const chunks: Buffer[] = [];
      let n = 0;
      req.on('data', (c: Buffer) => {
        n += c.length;
        if (n > maxBody) { resolve(null); req.pause(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', rejectP);
    });

  const envelope = (start: number, status: 'ok' | 'error', message: string, extra: Record<string, unknown> = {}): Envelope => ({
    status, message, ...extra, startTimestamp: start, endTimestamp: Date.now(), version,
  });

  /**
   * Queue for a slot, then solve. `hardStop` rejects 2 s after the deadline: it ends the wait AND gives the slot
   * back even if the backend never settles, so one wedged window cannot shrink the pool for good.
   */
  async function runSolve(req: SolveRequest, hardStop: Promise<never>): Promise<SolveResult> {
    const gate = req.session ? sessions : general;
    const queued = Date.now();
    await gate.take(req.signal);
    emit({ type: 'solve-start', id: req.id, method: req.method, url: req.url, session: req.session, queuedMs: Date.now() - queued });
    try {
      return await Promise.race([opts.backend.solve(req), hardStop]);
    } finally {
      gate.give();
    }
  }

  async function v1(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const start = Date.now();
    const body = await readBody(req);
    if (body === null) { reject(res, 413, 'Request body too large'); req.destroy(); return; }
    let parsed: unknown;
    try { parsed = body.length ? JSON.parse(body.toString('utf8')) : {}; } catch {
      json(res, 500, envelope(start, 'error', 'Error: Request body is not valid JSON.'));
      return;
    }
    let cmd: string;
    let raw: Record<string, unknown>;
    try { ({ cmd, raw } = parseCommand(parsed)); } catch (e) {
      json(res, 500, envelope(start, 'error', `Error: ${(e as Error).message}`));
      return;
    }

    if (cmd === 'sessions.list') { json(res, 200, envelope(start, 'ok', '', { sessions: opts.backend.sessionsList() })); return; }
    if (cmd === 'sessions.create') {
      const name = typeof raw.session === 'string' && raw.session ? raw.session : cryptoRandomName();
      const fresh = await opts.backend.sessionsCreate(name);
      json(res, 200, envelope(start, 'ok', fresh ? MSG.sessionCreated : MSG.sessionExists, { session: name }));
      return;
    }
    if (cmd === 'sessions.destroy') {
      const existed = typeof raw.session === 'string' && raw.session ? await opts.backend.sessionsDestroy(raw.session) : false;
      if (!existed) { json(res, 500, envelope(start, 'error', `Error: ${MSG.sessionMissing}`)); return; }
      json(res, 200, envelope(start, 'ok', MSG.sessionRemoved));
      return;
    }

    // request.get / request.post
    const ctl = new AbortController();
    inflight.add(ctl);
    let solveReq: SolveRequest;
    try {
      solveReq = parseSolveRequest(cmd as 'request.get' | 'request.post', raw, nextId++, ctl.signal);
    } catch (e) {
      inflight.delete(ctl);
      json(res, 500, envelope(start, 'error', `Error: ${(e as Error).message}`));
      return;
    }
    const timeoutMsg = `Timeout after ${pySeconds(solveReq.maxTimeoutMs)} seconds.`;
    // The deadline covers queueing too: a request never outlives its own maxTimeout, whatever else is running.
    const timer = setTimeout(() => ctl.abort(), solveReq.maxTimeoutMs);
    // A backend that ignores the abort still cannot hold the client past the deadline (+2 s grace to let it
    // pick the more specific "human check" wording).
    let hardStop: NodeJS.Timeout | undefined;
    const hard = new Promise<never>((_, rej) => {
      ctl.signal.addEventListener('abort', () => { hardStop = setTimeout(() => rej(new SolveError('timeout', timeoutMsg)), 2000); }, { once: true });
    });
    try {
      const r = await runSolve(solveReq, hard);
      const out = envelope(start, 'ok', r.challenged ? MSG.solved : MSG.notDetected, { solution: solutionOf(r, solveReq.returnOnlyCookies) });
      emit({ type: 'solve-end', id: solveReq.id, ok: true, ms: Date.now() - start, originStatus: r.originStatus, challenged: r.challenged, bytes: (r.response ?? '').length, cookies: r.cookies.map((c) => c.name) });
      json(res, 200, out, { 'x-origin-status': String(r.originStatus || 0) });
    } catch (e) {
      const err = e as SolveError;
      let reason: string;
      if (err instanceof SolveError) {
        reason = err.kind === 'timeout' || err.kind === 'aborted' ? timeoutMsg
          : err.kind === 'blocked' ? MSG.blocked
            : err.kind === 'human' ? MSG.humanCheck
              : err.reason;
      } else {
        reason = String((e as Error)?.message || e).replace(/\n/g, '\\n');
      }
      // flaresolverr_service.py:249-251: every failure is "Error solving the challenge. <reason>", then the
      // controller prefixes "Error: " (:107).
      const message = `Error: Error solving the challenge. ${reason}`;
      emit({ type: 'solve-end', id: solveReq.id, ok: false, ms: Date.now() - start, error: message });
      json(res, 500, envelope(start, 'error', message));
    } finally {
      clearTimeout(timer);
      if (hardStop) clearTimeout(hardStop);
      inflight.delete(ctl);
    }
  }

  const server = http.createServer((req, res) => {
    // DNS rebinding and anything that is not exactly us: the Host must be our loopback address.
    if (req.headers.host !== `127.0.0.1:${port}`) { reject(res, 421, 'Misdirected request'); return; }
    // Neither client sends Origin; every browser does on a cross-origin POST. That blocks CSRF from web pages
    // (and from the solver's own hidden windows, which are also blocked from loopback in browser.ts).
    if (req.headers.origin !== undefined) { reject(res, 403, 'Forbidden'); return; }
    const path = (req.url || '/').split('?')[0];
    const segs = path.split('/');
    // ['', token, rest...]
    if (segs.length < 2 || !tokenOk(segs[1] || '')) { reject(res, 404, 'Not found'); return; }
    const rest = '/' + segs.slice(2).join('/');
    if (rest === '/' || rest === '') {
      if (req.method !== 'GET') { reject(res, 405, 'Method not allowed'); return; }
      json(res, 200, { msg: MSG.ready, version, userAgent: opts.backend.userAgent() });
      return;
    }
    if (rest === '/health') {
      if (req.method !== 'GET') { reject(res, 405, 'Method not allowed'); return; }
      json(res, 200, { status: 'ok' });
      return;
    }
    if (rest === '/v1') {
      if (req.method !== 'POST') { reject(res, 405, 'Method not allowed'); return; }
      v1(req, res).catch((e) => {
        if (!res.headersSent) json(res, 500, { status: 'error', message: `Error: ${String((e as Error)?.message || e)}`, startTimestamp: Date.now(), endTimestamp: Date.now(), version });
      });
      return;
    }
    const dbg = rest.startsWith('/_debug/') ? opts.debugRoutes?.[rest.slice('/_debug/'.length)] : undefined;
    if (dbg && req.method === 'GET') {
      Promise.resolve(dbg()).then((v) => json(res, 200, v), (e) => json(res, 500, { error: String(e) }));
      return;
    }
    reject(res, 404, 'Not found');
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 0; // a solve legitimately takes up to maxTimeout (180 s)
  server.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, rej) => {
    server.once('error', rej);
    server.listen(opts.port ?? 0, '127.0.0.1', () => { server.off('error', rej); resolve(); });
  });
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/${opts.token}`,
    port,
    async close() {
      for (const c of inflight) c.abort();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}

/** FlareSolverr names an unnamed session with uuid1(); any unique string does. */
function cryptoRandomName(): string {
  return globalThis.crypto.randomUUID();
}
