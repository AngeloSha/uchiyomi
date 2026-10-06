// The library scan followed to its end (v0.55.6, #150).
//
// Kedryn's library, on Unraid, scanned for longer than the proxy in front of his server would hold the request: the
// proxy cut it off, and the button said "Scan failed" every time while the scan went on. The server now answers within
// seconds (`running` when the scan takes longer) and lib/refresh.ts follows the scan through GET /api/refresh. Driven
// against the real api client with a stubbed fetch: each case scripts the POST's answer and the status reads after it.
import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.NEXT_PUBLIC_API_BASE = '';

// `api.ts` seeds itself from localStorage at load, so the stub goes in before the import.
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
};

/** One answer: a JSON body, or a status a proxy would give (a 504's HTML page). */
type Answer = { body: unknown } | { status: number };
let post: Answer = { body: {} };
let gets: Answer[] = [];
const calls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? 'GET';
  calls.push(`${method} ${url.replace(/\?.*$/, '')}`);
  const a = method === 'POST' ? post : (gets.length > 1 ? gets.shift()! : gets[0]);
  if ('status' in a) return new Response('<html><body><h1>504 Gateway Time-out</h1></body></html>', { status: a.status });
  return new Response(JSON.stringify(a.body), { status: 200, headers: { 'content-type': 'application/json' } });
}) as any;

let mod: typeof import('../lib/refresh');
before(async () => {
  mod = await import('../lib/refresh');
  mod.followTiming.everyMs = 5;
});
beforeEach(() => { calls.length = 0; });

const SINCE = '2026-10-06T10:00:00.000Z';
const at = (s: string) => `2026-10-06T${s}.000Z`;

test('a scan the server answered at once is that answer, and nothing is followed', async () => {
  post = { body: { scanned: true, libraries: 1, series: 3, books: 10, ms: 900, skipped: 0 } };
  assert.deepEqual(await mod.triggerRefresh(), { scanned: true, libraries: 1, series: 3, books: 10, ms: 900, skipped: 0 });
  assert.deepEqual(calls, ['POST /api/refresh']);
});

test('a scan answered running is followed to its counts, its progress heard on the way', async () => {
  post = { body: { scanned: true, running: true, since: SINCE, libraries: 1 } };
  gets = [
    { body: { running: true, now: at('10:00:20'), progress: { startedAt: SINCE, phase: 'indexing', done: 1, total: 4 } } },
    { body: { running: true, now: at('10:00:40'), progress: { startedAt: SINCE, phase: 'indexing', done: 3, total: 4 } } },
    { body: { running: false, now: at('10:01:00'), last: { at: at('10:00:55'), series: 2, books: 9, ms: 55000, skipped: 0 } } },
  ];
  const heard: number[] = [];
  const r = await mod.triggerRefresh((p) => heard.push(p.done));
  assert.deepEqual(r, { scanned: true, series: 2, books: 9, ms: 55000, skipped: 0 });
  assert.deepEqual(heard, [1, 3]);
});

test('a request cut off on the way follows the scan it started', async () => {
  // Reintroduce "Scan failed" for a cut-off request (triggerRefresh returning the error when the POST throws): this
  // reads { scanned: false, reason: 'error' }.
  post = { status: 504 };
  gets = [
    { body: { running: true, now: at('10:01:40'), progress: { startedAt: at('10:00:00'), phase: 'indexing', done: 900, total: 3400 } } },
    { body: { running: false, now: at('10:04:10'), last: { at: at('10:04:05'), series: 512, books: 21000, ms: 245000, skipped: 1 } } },
  ];
  assert.deepEqual(await mod.triggerRefresh(), { scanned: true, series: 512, books: 21000, ms: 245000, skipped: 1 });
});

test('a request cut off with no scan running since is a failure, never an older scan', async () => {
  post = { status: 504 };
  gets = [{ body: { running: false, now: at('10:05:00'), last: { at: at('09:00:00'), series: 2, books: 9, ms: 1, skipped: 0 } } }];
  assert.deepEqual(await mod.triggerRefresh(), { scanned: false, reason: 'error' });
});

test("a scan that failed says why, in the server's words", async () => {
  post = { body: { scanned: true, running: true, since: SINCE, libraries: 1 } };
  gets = [{ body: { running: false, now: at('10:00:31'), last: { at: at('09:00:00'), series: 2, books: 9, ms: 1, skipped: 0 },
    failed: { at: at('10:00:30'), message: 'connect ECONNREFUSED 127.0.0.1:5432' } } }];
  assert.deepEqual(await mod.triggerRefresh(), { scanned: false, reason: 'error', message: 'connect ECONNREFUSED 127.0.0.1:5432' });
});

test("a member's scan: only whether one runs, and once it has ended it scanned", async () => {
  post = { body: { scanned: true, running: true, since: SINCE, libraries: 1 } };
  gets = [{ body: { running: true } }, { body: { running: false } }];
  assert.deepEqual(await mod.triggerRefresh(), { scanned: true });
});

test('status reads that keep failing give up, as a failure', async () => {
  post = { body: { scanned: true, running: true, since: SINCE, libraries: 1 } };
  gets = [{ status: 502 }];
  assert.deepEqual(await mod.triggerRefresh(), { scanned: false, reason: 'error' });
  assert.equal(calls.filter((c) => c === 'GET /api/refresh').length, mod.followTiming.misses);
});
