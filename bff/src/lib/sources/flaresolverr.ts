// Thin client for FlareSolverr (headless-Chrome Cloudflare solver) and the solvers that speak its /v1 (trawl, Byparr).
// Returns solved page HTML, and keeps the latest cf_clearance cookies + user-agent per origin so the downloader can
// fetch images directly afterwards.
//
// v0.55.4: an optional BACKUP solver (FLARESOLVERR_FALLBACK_URL). A request the main solver does not answer with a
// page -- it cannot be reached, it ran out of time, it answered with an error, an empty page or something that is not
// its JSON -- is sent once, unchanged, to the backup. Every error keeps the `flaresolverr:` prefix whichever solver said
// it: to Health (solverBlaming) and the diagnosis it means "the solver", never FlareSolverr in particular.
//
// Both addresses are read when asked rather than once at load: production sets them before the server starts, and a
// test can point them at fakes of its own.
const mainUrl = (): string => (process.env.FLARESOLVERR_URL || 'http://yomi-flaresolverr:8191').replace(/\/$/, '');

/** The backup solver's address, or '' when there is none. The main's own address again is no backup. */
export function backupSolverUrl(): string {
  const b = (process.env.FLARESOLVERR_FALLBACK_URL ?? '').trim().replace(/\/$/, '');
  return b && b !== mainUrl() ? b : '';
}

/** The solvers a request is asked of, in order: the main, then the backup if there is one. */
const solvers = (): string[] => [mainUrl(), backupSolverUrl()].filter(Boolean);

interface Solution { url: string; status: number; response: string; cookies: Array<{ name: string; value: string }>; userAgent: string }
const sessions = new Map<string, { cookie: string; userAgent: string }>();

/**
 * How many solves may be in flight at once.
 *
 * FlareSolverr drives real Chrome instances. The fill scan searches every source at the same time, which put
 * a dozen challenges on it simultaneously and produced "Task queue depth is 4" followed by
 * "Error starting Chrome: Service /app/chromedriver unexpectedly exited" -- the solver falling over under
 * our own fan-out. A crashed solve is reported as the SITE refusing us, so this was manufacturing source
 * failures out of nothing.
 */
export const SOLVER_CONCURRENCY = Math.max(1, Number(process.env.SOLVER_CONCURRENCY || 4));
let inFlight = 0;
const waiting: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (inFlight < SOLVER_CONCURRENCY) { inFlight++; return; }
  await new Promise<void>((resolve) => waiting.push(resolve));
  inFlight++;
}
function release(): void {
  inFlight--;
  waiting.shift()?.();
}

async function solve(cmd: 'request.get' | 'request.post', url: string, postData?: string): Promise<Solution> {
  await acquire();
  try {
    return await solveNow(cmd, url, postData);
  } finally {
    release();
  }
}

/**
 * The request, asked of each solver in turn until one answers it with a page (v0.55.4: the main, then the backup).
 *
 * When every one failed, the caller is told what a solver SAID: an error in its own words, or a page that came back
 * empty, is what it found at the site, and a backup that could not be reached at all says nothing about the site -- its
 * "fetch failed" must not hide the main's "Cloudflare has blocked this request". With nothing said, the first failure,
 * which is the main's. Reintroduce the last failure: "when both fail, the caller hears what a solver said" in
 * solverBackup.test.ts reads the backup's connection error.
 */
async function solveNow(cmd: 'request.get' | 'request.post', url: string, postData?: string): Promise<Solution> {
  const failed: Array<{ error: Error; said: boolean; busy?: boolean }> = [];
  for (const solver of solvers()) {
    const a = await ask(solver, cmd, url, postData);
    if ('solution' in a) return a.solution;
    failed.push(a);
  }
  // A busy solver before a connection error (SOLVER_BUSY, below): it is the one that names no site.
  throw (failed.find((f) => f.said) ?? failed.find((f) => f.busy) ?? failed[0]).error;
}

/** What asking one solver came to: a page, or why not -- `said` when the solver itself answered (above). */
type Asked = { solution: Solution } | { error: Error; said: boolean; busy?: boolean };

/**
 * A solver's own HTTP 429 is the solver being BUSY, never the site refusing (v0.55.4).
 *
 * trawl answers it when none of its browsers (BROWSER_POOL_SIZE, one by default) frees up within its
 * BROWSER_ACQUIRE_TIMEOUT_MS (15 s): "Browser pool exhausted: all browsers are busy". A site's own 429 comes inside an
 * answer -- `solution.status`, or trawl's "Tier 3 failed (http-429)" -- where classify() reads it as the rate limit it
 * is. So the same solver is asked again, BUSY_RETRIES times a few seconds apart, then the backup; a solver still busy
 * after that fails in words of our own, which classify() files as nothing: no cooldown and no rate limit for a site that
 * never said a word. Reintroduce the solver's 429 as an ordinary failure (drop the 429 branch in `ask`): "a solver's
 * own 429 is busy" in solverBackup.test.ts finds the main asked once and its pool's words as the error.
 */
export const SOLVER_BUSY = 'flaresolverr: solver busy (every one of its browsers stayed in use)';
const BUSY_RETRIES = 2;

/**
 * Test seam: how long one solver may take with one request before it counts as not answering (the backup is next), and
 * the pause before a busy solver is asked again (doubled the second time).
 */
let attemptMs = 95_000;
let busyWaitMs = 3_000;
export function setSolverTiming(t: { attemptMs?: number; busyWaitMs?: number }): void {
  if (t.attemptMs !== undefined) attemptMs = t.attemptMs;
  if (t.busyWaitMs !== undefined) busyWaitMs = t.busyWaitMs;
}

async function ask(solver: string, cmd: 'request.get' | 'request.post', url: string, postData?: string): Promise<Asked> {
  let r: Response;
  for (let busy = 0; ; busy++) {
    try {
      r = await fetch(`${solver}/v1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cmd, url, postData, maxTimeout: 60000 }),
        signal: AbortSignal.timeout(attemptMs),
      });
    } catch (e) {
      // Not reachable, or no answer in time: nothing about the site.
      return { error: e as Error, said: false };
    }
    if (r.status !== 429) break;
    await r.text().catch(() => '');
    if (busy >= BUSY_RETRIES) return { error: new Error(SOLVER_BUSY), said: false, busy: true };
    await new Promise((go) => setTimeout(go, busyWaitMs * (busy + 1)));
  }
  // A solver's errors are JSON too (FlareSolverr's HTTP 500 carries {status: 'error', message}). Anything else -- a
  // proxy's error page, a web server at the wrong address -- is the solver's address failing, never the site.
  const j: any = await r.json().catch(() => null);
  if (!j || typeof j !== 'object') return { error: new Error('flaresolverr: the solver did not answer with its JSON'), said: false };
  if (j.status !== 'ok' || !j.solution) return { error: new Error(`flaresolverr: ${j.message || j.status}`), said: true };
  const s: Solution = j.solution;
  try {
    const origin = new URL(s.url || url).origin;
    sessions.set(origin, { cookie: (s.cookies || []).map((c) => `${c.name}=${c.value}`).join('; '), userAgent: s.userAgent });
  } catch {}
  return s.response ? { solution: s } : { error: emptyBody(s, url), said: true };
}

/**
 * An answer with no page in it, as a failure.
 *
 * This used to be `s.response || ''`. An empty body is never a legitimate page -- every caller parses it
 * straight into `[]` -- so a solver that answered with nothing was indistinguishable from a site with
 * nothing on it, and `latestPage` recorded neither success nor failure. Whole classes of failure went into
 * the void: on this install FlareSolverr's own browser was crashing and the affected sources simply looked
 * quiet.
 *
 * Throwing routes it through the caller's existing catch, where `classify` finally has an HTTP status to
 * read. That status was always here: `Solution.status` carries what the ORIGIN answered, and discarding it
 * is why every caller had to call `classify(e)` with no second argument. The 403 that manhuaus.com and
 * manhuafast.net return on every request was arriving on this line and being thrown away. Since v0.55.4 it is
 * one solver's failure like any other, and the backup is asked; its cookies are kept all the same (cfSession).
 */
function emptyBody(s: Solution, url: string): Error {
  let host = url;
  try { host = new URL(s.url || url).host; } catch { /* the id is for humans; a bad URL must not mask the failure */ }
  return Object.assign(
    new Error(`flaresolverr: empty body (HTTP ${s.status ?? '?'}) from ${host}`),
    { status: s.status },
  );
}

export async function cfGet(url: string): Promise<string> {
  return (await solve('request.get', url)).response;
}
export async function cfPost(url: string, postData: string): Promise<string> {
  return (await solve('request.post', url, postData)).response;
}

/** Cookie header + UA to fetch binaries (images) directly — FlareSolverr can't return binary bodies. */
/** Origins whose last solve failed, and when, so a dead root is not re-solved for every chapter. */
const unsolvable = new Map<string, number>();
const RESOLVE_AFTER_MS = 5 * 60_000;

export async function cfSession(url: string): Promise<{ cookie: string; userAgent: string }> {
  const origin = new URL(url).origin;
  // Only the side effect matters here: `solve` stores the cookie jar before it returns, so an empty body
  // (which now throws) has still given us what we came for. Before `cfGet` could throw this was a bare
  // await, and letting it throw now would fail image downloads that used to succeed.
  if (!sessions.has(origin) && Date.now() - (unsolvable.get(origin) || 0) > RESOLVE_AFTER_MS) {
    // The origin ROOT is the cheap way in and works for a normal site. An image CDN is not a normal site:
    // `imgs-2.2xstorage.com/` and `storage.waitst.com/` both answer 403 with an access-denied page, which
    // FlareSolverr reports as a block, so `solve` threw BEFORE caching anything. The session was therefore
    // never stored, the root was re-solved for every single chapter, and every image was then fetched with
    // no clearance cookie at all -- on the sites where the 429s were coming from.
    //
    // So fall back to the URL we are actually about to fetch. That one exists, so it can be solved.
    await cfGet(`${origin}/`).catch(() => cfGet(url)).catch(() => {});
    if (sessions.has(origin)) unsolvable.delete(origin);
    else unsolvable.set(origin, Date.now());
  }
  return sessions.get(origin) || { cookie: '', userAgent: 'Mozilla/5.0' };
}

/**
 * Forget every solved session and every origin marked unsolvable, and say how many of each there were.
 *
 * What the nightly repair (lib/repair.ts) and the Health page's "Reset solver sessions" do when the solver
 * itself answers its ping but sources behind it keep failing inside it: a `cf_clearance` cookie that
 * Cloudflare has since rotated is re-sent with every image request until this process restarts, and an
 * origin stamped `unsolvable` is not re-solved for RESOLVE_AFTER_MS however healthy it has become. Clearing
 * both makes the next request solve afresh, which is what "restart the solver" achieved by accident.
 *
 * ⚠️ In-process state only. The app has no access to the solver container (or any container) and must
 * never get any: that is a security boundary, not a missing feature. A solver that is genuinely wedged is
 * for the operator's `docker restart`; this resets only what THIS process remembers about it.
 */
export function resetSolverSessions(): { sessions: number; unsolvable: number } {
  const out = { sessions: sessions.size, unsolvable: unsolvable.size };
  sessions.clear();
  unsolvable.clear();
  return out;
}

/** Where the main solver is expected to be. Exported so the health page can name it without re-deriving it. */
export const solverUrl = (): string => mainUrl();

/**
 * Is the Cloudflare solver alive?
 *
 * Worth asking directly, because when it is not, every source behind it fails and each one records the
 * failure against ITSELF. The operator sees four broken sites and no hint that one container explains all
 * four. This turns that into a single line on the health page.
 */
export async function solverPing(timeoutMs = 5000): Promise<SolverPing> {
  try {
    // FlareSolverr greets at its root with a readiness sentence rather than a status field ("FlareSolverr is ready!").
    // `redirect: 'manual'`: a solver that redirects its root (Byparr, #144: to its API docs) is not followed onto HTML.
    const r = await fetch(`${mainUrl()}/`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    const j: any = r.ok ? await r.json().catch(() => null) : null;
    if (j && /ready/i.test(String(j.msg || ''))) return { ok: true, version: j.version, kind: kindOf(String(j.msg)) };
    // Byparr (#144), a FlareSolverr-compatible solver: the same /v1 for solving, but it says it is up at /health. Its
    // version is Byparr's, never compared with FlareSolverr's releases (`kind`, read by solverHealth). Reintroduce the
    // root alone: "Byparr answering at /health is a working solver" in health.int.test.ts reads it as down.
    const h = await fetch(`${mainUrl()}/health`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' }).catch(() => null);
    if (h?.ok) {
      const hj: any = await h.json().catch(() => null);
      return { ok: true, version: typeof hj?.version === 'string' ? hj.version : undefined, kind: 'other' };
    }
    return { ok: false, error: !r.ok ? `HTTP ${r.status}` : j?.msg ? String(j.msg) : 'unexpected response' };
  } catch (e: any) {
    return { ok: false, error: String(e?.cause?.code || e?.name || e?.message || 'unreachable') };
  }
}

/**
 * Which solver answered, by the sentence it greets with (v0.55.4). trawl (#144, germondai/trawl) greets "TRAWL is
 * ready!", which the old `/ready/i` test took for FlareSolverr: Health then held trawl's 1.7.0 against FlareSolverr's
 * 3.x releases and said an update was out. Only these two are named; any other solver that answers (Byparr at
 * /health, another one's greeting) is `other`, and is held against nobody's releases. Reintroduce `flaresolverr` for
 * every greeting: "trawl answering at its root is trawl" in health.int.test.ts fails.
 */
export type SolverKind = 'flaresolverr' | 'trawl' | 'other';
function kindOf(greeting: string): SolverKind {
  if (/\bflaresolverr is ready\b/i.test(greeting)) return 'flaresolverr';
  if (/\btrawl is ready\b/i.test(greeting)) return 'trawl';
  return 'other';
}

/** What a ping found: FlareSolverr itself, trawl, or another solver speaking its /v1 (Byparr, #144). */
export interface SolverPing { ok: boolean; version?: string; error?: string; kind?: SolverKind }

/** How long one ping answers for everyone who asks. */
export const PING_SHARED_MS = 10_000;
let shared: { at: number; p: Promise<SolverPing> } | null = null;

/**
 * `solverPing`, asked once for everyone who asks within PING_SHARED_MS (concurrent callers share the one in flight).
 *
 * Health reads the solver twice: its Cloudflare solver row, and the extension engine row, whose engine gets past
 * Cloudflare only through this same solver once Connect pointed it here. Two pings a moment apart could disagree, and
 * the page said "can get past Cloudflare" in one row beside "not answering" in the other (v0.49.1). The repair's
 * solver step still pings for itself: it decides whether to clear anything, and that wants the answer of now.
 */
export function solverPingShared(now: number = Date.now()): Promise<SolverPing> {
  if (shared && now - shared.at < PING_SHARED_MS) return shared.p;
  const p = solverPing();
  shared = { at: now, p };
  return p;
}

/** Tests: the next shared ping asks the solver again. */
export function forgetSolverPing(): void {
  shared = null;
}
