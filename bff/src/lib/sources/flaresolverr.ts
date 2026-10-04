// Thin client for FlareSolverr (headless-Chrome Cloudflare solver) and the solvers that speak its /v1 (trawl, Byparr).
// Returns solved page HTML, and keeps the latest cf_clearance cookies + user-agent per solver and origin so the
// downloader can fetch images directly afterwards.
//
// v0.55.3: an optional BACKUP solver (FLARESOLVERR_FALLBACK_URL). A request the main solver does not answer with a
// page -- it cannot be reached, it ran out of time, it answered with an error, an empty page or something that is not
// its JSON, or it stayed busy -- is sent once, unchanged, to the backup, and each site is asked first of the solver that
// answered it last (lastWon). Every error keeps the `flaresolverr:` prefix whichever solver said it: to Health
// (solverBlaming) and the diagnosis it means "the solver", never FlareSolverr in particular.
//
// Both addresses are read when asked rather than once at load: production sets them before the server starts, and a
// test can point them at fakes of its own.
const mainUrl = (): string => (process.env.FLARESOLVERR_URL || 'http://yomi-flaresolverr:8191').replace(/\/$/, '');

/** The backup solver's address, or '' when there is none. The main's own address again is no backup. */
export function backupSolverUrl(): string {
  const b = (process.env.FLARESOLVERR_FALLBACK_URL ?? '').trim().replace(/\/$/, '');
  return b && b !== mainUrl() ? b : '';
}

/** The solvers configured, the main first. */
const solvers = (): string[] => [mainUrl(), backupSolverUrl()].filter(Boolean);

interface Solution { url: string; status: number; response: string; cookies: Array<{ name: string; value: string }>; userAgent: string }

/**
 * Each solver's cookie jar and user agent, per origin it solved (v0.55.3: keyed by solver AND origin, `jarKey`), and
 * whose pair an origin's plain fetches send: the solver that solved it last (`solvedBy`).
 *
 * A cf_clearance belongs to the browser that earned it -- its user agent, its address -- so an image fetch must send one
 * solver's cookie with that same solver's user agent, never one's cookie with the other's agent: Cloudflare refuses the
 * mix. Reintroduce one jar per origin (drop the solver from `jarKey`): "the reset clears both solvers' jars" in
 * solverBackup.test.ts counts one pair where two solvers each solved the site.
 */
const sessions = new Map<string, { cookie: string; userAgent: string }>();
const solvedBy = new Map<string, string>();
const jarKey = (solver: string, origin: string): string => `${solver} ${origin}`;
const sessionOf = (origin: string) => {
  const solver = solvedBy.get(origin);
  return solver === undefined ? undefined : sessions.get(jarKey(solver, origin));
};

/**
 * Per site (the origin a request names), the solver that answered it last with a page, and when (v0.55.3).
 *
 * That solver is asked first for rememberMs: without it every request for a site the main cannot solve would wait for
 * the main to fail -- up to its whole attempt -- before the backup answered as it did a moment ago. After that the main
 * is asked first again, so a main that has recovered gets its sites back. In memory only, like the jars: a restart, or
 * a solver reset, starts from the main. Reintroduce the fixed order (`solvers()` in solveNow): "the solver that answered
 * a site last is asked first" in solverBackup.test.ts finds the main asked again.
 */
const lastWon = new Map<string, { solver: string; at: number }>();

/** The solvers a request for `site` is asked of, in order: the one that answered it last, then the rest, main first. */
function askingOrder(site: string | null): string[] {
  const all = solvers();
  const won = site === null ? undefined : lastWon.get(site);
  if (!won) return all;
  if (Date.now() - won.at > rememberMs || !all.includes(won.solver)) {
    lastWon.delete(site!);
    return all;
  }
  return [won.solver, ...all.filter((x) => x !== won.solver)];
}

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
 * The request, asked of each solver in turn until one answers it with a page (v0.55.3: the main, then the backup, or
 * first the one that answered this site last -- askingOrder).
 *
 * When every one failed, the caller is told what a solver SAID: an error in its own words, or a page that came back
 * empty, is what it found at the site, and a backup that could not be reached at all says nothing about the site -- its
 * "fetch failed" must not hide the main's "Cloudflare has blocked this request". With nothing said, the first failure,
 * which is the main's. Reintroduce the last failure: "when both fail, the caller hears what a solver said" in
 * solverBackup.test.ts reads the backup's connection error.
 */
async function solveNow(cmd: 'request.get' | 'request.post', url: string, postData?: string): Promise<Solution> {
  let site: string | null = null;
  try { site = new URL(url).origin; } catch { /* asked as it is, and remembered under nothing */ }
  const failed: Array<{ error: Error; said: boolean; busy?: boolean }> = [];
  for (const solver of askingOrder(site)) {
    const a = await ask(solver, cmd, url, postData);
    if ('solution' in a) {
      // A site moves to the solver that answered it only when the one asked before it failed AT it. One that was only
      // busy keeps its sites: a moment's queue at the main (trawl's one browser) would otherwise hand them all to the
      // backup for hours. Reintroduce the move on any failure: "a solver that was only busy keeps its sites" in
      // solverBackup.test.ts finds the backup asked first.
      if (site !== null && !(failed.length && failed.every((f) => f.busy))) lastWon.set(site, { solver, at: Date.now() });
      return a.solution;
    }
    failed.push(a);
  }
  // A busy solver before a connection error (SOLVER_BUSY, below): it is the one that names no site.
  throw (failed.find((f) => f.said) ?? failed.find((f) => f.busy) ?? failed[0]).error;
}

/** What asking one solver came to: a page, or why not -- `said` when the solver itself answered (above). */
type Asked = { solution: Solution } | { error: Error; said: boolean; busy?: boolean };

/**
 * A solver's own HTTP 429 is the solver being BUSY, never the site refusing (v0.55.3).
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
 * Test seam: how long one solver may take with one request before it counts as not answering (the backup is next), the
 * pause before a busy solver is asked again (doubled the second time), and how long the solver that answered a site
 * last is asked first (lastWon).
 */
let attemptMs = 95_000;
let busyWaitMs = 3_000;
let rememberMs = 6 * 60 * 60_000;
export function setSolverTiming(t: { attemptMs?: number; busyWaitMs?: number; rememberMs?: number }): void {
  if (t.attemptMs !== undefined) attemptMs = t.attemptMs;
  if (t.busyWaitMs !== undefined) busyWaitMs = t.busyWaitMs;
  if (t.rememberMs !== undefined) rememberMs = t.rememberMs;
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
    sessions.set(jarKey(solver, origin), { cookie: (s.cookies || []).map((c) => `${c.name}=${c.value}`).join('; '), userAgent: s.userAgent });
    solvedBy.set(origin, solver);
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
 * manhuafast.net return on every request was arriving on this line and being thrown away. Since v0.55.3 it is
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
  if (!sessionOf(origin) && Date.now() - (unsolvable.get(origin) || 0) > RESOLVE_AFTER_MS) {
    // The origin ROOT is the cheap way in and works for a normal site. An image CDN is not a normal site:
    // `imgs-2.2xstorage.com/` and `storage.waitst.com/` both answer 403 with an access-denied page, which
    // FlareSolverr reports as a block, so `solve` threw BEFORE caching anything. The session was therefore
    // never stored, the root was re-solved for every single chapter, and every image was then fetched with
    // no clearance cookie at all -- on the sites where the 429s were coming from.
    //
    // So fall back to the URL we are actually about to fetch. That one exists, so it can be solved.
    await cfGet(`${origin}/`).catch(() => cfGet(url)).catch(() => {});
    if (sessionOf(origin)) unsolvable.delete(origin);
    else unsolvable.set(origin, Date.now());
  }
  // One solver's pair, whole: the one that solved this origin last (`solvedBy`).
  return sessionOf(origin) || { cookie: '', userAgent: 'Mozilla/5.0' };
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
 *
 * v0.55.3: both solvers' -- every (solver, origin) pair is counted and cleared -- and which solver answered each site
 * last, so the next request starts from the main again (an operator who restarted the main has it back at once).
 */
export function resetSolverSessions(): { sessions: number; unsolvable: number } {
  const out = { sessions: sessions.size, unsolvable: unsolvable.size };
  sessions.clear();
  solvedBy.clear();
  lastWon.clear();
  unsolvable.clear();
  return out;
}

/** Where the main solver is expected to be. Exported so the health page can name it without re-deriving it. */
export const solverUrl = (): string => mainUrl();

/**
 * Are the Cloudflare solvers alive?
 *
 * Worth asking directly, because when it is not, every source behind it fails and each one records the
 * failure against ITSELF. The operator sees four broken sites and no hint that one container explains all
 * four. This turns that into a single line on the health page.
 *
 * v0.55.3: the main and the backup, side by side, each in `main` / `backup`. The top level is the solver that would
 * solve now -- the main when it answers, else the backup when it does, else the main's failure -- so `ok` means at least
 * one answers, which is what the repair's solver step and Fix everything take "the solver is up" to mean. The extension
 * engine's helper is pointed at the main alone, and reads `main` (engineHealth.ts). Reintroduce the main's answer as
 * the whole of it: "with the main down and the backup answering, the reset still runs" in repair.int.test.ts fails.
 */
export async function solverPing(timeoutMs = 5000): Promise<SolversPing> {
  const at = backupSolverUrl();
  const [m, b] = await Promise.all([pingOne(mainUrl(), timeoutMs), at ? pingOne(at, timeoutMs) : null]);
  const main = { ...m, url: mainUrl() };
  const backup = b && { ...b, url: at };
  const now: SolverAt = !main.ok && backup?.ok ? backup : main;
  return { ok: now.ok, version: now.version, error: now.error, kind: now.kind, main, backup };
}

async function pingOne(base: string, timeoutMs: number): Promise<SolverPing> {
  try {
    // FlareSolverr greets at its root with a readiness sentence rather than a status field ("FlareSolverr is ready!").
    // `redirect: 'manual'`: a solver that redirects its root (Byparr, #144: to its API docs) is not followed onto HTML.
    const r = await fetch(`${base}/`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    const j: any = r.ok ? await r.json().catch(() => null) : null;
    if (j && /ready/i.test(String(j.msg || ''))) return { ok: true, version: j.version, kind: kindOf(String(j.msg)) };
    // Byparr (#144), a FlareSolverr-compatible solver: the same /v1 for solving, but it says it is up at /health. Its
    // version is Byparr's, never compared with FlareSolverr's releases (`kind`, read by solverHealth). Reintroduce the
    // root alone: "Byparr answering at /health is a working solver" in health.int.test.ts reads it as down.
    const h = await fetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' }).catch(() => null);
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
 * Which solver answered, by the sentence it greets with (v0.55.3). trawl (#144, germondai/trawl) greets "TRAWL is
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
/** One solver's ping, and the address it answered (or did not) at. */
export interface SolverAt extends SolverPing { url: string }
/** Both solvers' pings (solverPing): the top level is the one that would solve now. `backup` null: none configured. */
export interface SolversPing extends SolverPing { main: SolverAt; backup: SolverAt | null }

/** How long one ping answers for everyone who asks. */
export const PING_SHARED_MS = 10_000;
let shared: { at: number; p: Promise<SolversPing> } | null = null;

/**
 * `solverPing`, asked once for everyone who asks within PING_SHARED_MS (concurrent callers share the one in flight).
 *
 * Health reads the solver twice: its Cloudflare solver row, and the extension engine row, whose engine gets past
 * Cloudflare only through this same solver once Connect pointed it here. Two pings a moment apart could disagree, and
 * the page said "can get past Cloudflare" in one row beside "not answering" in the other (v0.49.1). The repair's
 * solver step still pings for itself: it decides whether to clear anything, and that wants the answer of now.
 */
export function solverPingShared(now: number = Date.now()): Promise<SolversPing> {
  if (shared && now - shared.at < PING_SHARED_MS) return shared.p;
  const p = solverPing();
  shared = { at: now, p };
  return p;
}

/** Tests: the next shared ping asks the solver again. */
export function forgetSolverPing(): void {
  shared = null;
}
