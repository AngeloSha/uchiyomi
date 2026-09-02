// Thin client for FlareSolverr (headless-Chrome Cloudflare solver). Returns solved page HTML, and keeps the
// latest cf_clearance cookies + user-agent per origin so the downloader can fetch images directly afterwards.
const FS = (process.env.FLARESOLVERR_URL || 'http://yomi-flaresolverr:8191').replace(/\/$/, '');

interface Solution { url: string; status: number; response: string; cookies: Array<{ name: string; value: string }>; userAgent: string }
const sessions = new Map<string, { cookie: string; userAgent: string }>();

async function solve(cmd: 'request.get' | 'request.post', url: string, postData?: string): Promise<Solution> {
  const r = await fetch(`${FS}/v1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd, url, postData, maxTimeout: 60000 }),
    signal: AbortSignal.timeout(95000),
  });
  const j: any = await r.json();
  if (j.status !== 'ok' || !j.solution) throw new Error(`flaresolverr: ${j.message || j.status}`);
  const s: Solution = j.solution;
  try {
    const origin = new URL(s.url || url).origin;
    sessions.set(origin, { cookie: (s.cookies || []).map((c) => `${c.name}=${c.value}`).join('; '), userAgent: s.userAgent });
  } catch {}
  return s;
}

/**
 * The solved page, or a throw.
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
 * manhuafast.net return on every request was arriving on this line and being thrown away.
 */
function body(s: Solution, url: string): string {
  if (s.response) return s.response;
  let host = url;
  try { host = new URL(s.url || url).host; } catch { /* the id is for humans; a bad URL must not mask the failure */ }
  throw Object.assign(
    new Error(`flaresolverr: empty body (HTTP ${s.status ?? '?'}) from ${host}`),
    { status: s.status },
  );
}

export async function cfGet(url: string): Promise<string> {
  return body(await solve('request.get', url), url);
}
export async function cfPost(url: string, postData: string): Promise<string> {
  return body(await solve('request.post', url, postData), url);
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

/** Where the solver is expected to be. Exported so the health page can name it without re-deriving it. */
export const solverUrl = (): string => FS;

/**
 * Is the Cloudflare solver alive?
 *
 * Worth asking directly, because when it is not, every source behind it fails and each one records the
 * failure against ITSELF. The operator sees four broken sites and no hint that one container explains all
 * four. This turns that into a single line on the health page.
 */
export async function solverPing(timeoutMs = 5000): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const r = await fetch(`${FS}/`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const j: any = await r.json().catch(() => ({}));
    // The root endpoint answers with a readiness sentence rather than a status field.
    return { ok: /ready/i.test(String(j?.msg || '')), version: j?.version, error: j?.msg ? undefined : 'unexpected response' };
  } catch (e: any) {
    return { ok: false, error: String(e?.cause?.code || e?.name || e?.message || 'unreachable') };
  }
}
