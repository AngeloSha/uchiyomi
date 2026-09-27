// GraphQL client for a Suwayomi server acting as Uchiyomi's extension engine.
//
// Suwayomi is the only project that runs Mihon/Tachiyomi's Kotlin extensions outside Android: it converts the
// extension APKs to JVM bytecode and supplies a fake Android runtime for them. We use it for exactly one job --
// turning an installed extension into search/chapters/pages over an API -- and keep owning everything else.
//
// The endpoint is `/api/graphql`, NOT `/graphql`; the published docs say otherwise and the server 404s on it.
// Verified against Suwayomi-Server v2.2.2100.
import { env } from '../../../env';

export interface GqlError extends Error {
  status?: number;
}

/**
 * The operator's engine base, normalised ONCE for everything that builds a URL on it: scheme + host + port +
 * path, trailing slashes collapsed, no query, no fragment (userinfo dropped too -- fetch refuses a URL that
 * carries credentials, and the engine's are SUWAYOMI_USERNAME / SUWAYOMI_PASSWORD).
 *
 * Two readers build URLs on `SUWAYOMI_URL`: `suwayomiUrl` here, which turns the engine's server-relative
 * thumbnail and page paths into the absolute URLs that get STORED, and routes/images.ts `engineCoverUrl`,
 * which rebuilds the one thumbnail URL the cover proxy may fetch un-guarded and accepts a stored cover only if
 * it round-trips to exactly that. ⚠️ Both used to strip one trailing slash from the raw env string and call
 * it a base, so any value that was not already clean made them disagree: `http://engine:4567//` stored
 * `//api/v1/manga/1/thumbnail` (an empty path segment the shape check cannot match), and `...:4567/?q` or
 * `...:4567#f` put the query or fragment in front of the path. Every extension cover then fell through to the
 * SSRF guard, resolved private, and came back as the grey placeholder with nothing logged (R1's v0.37.0
 * review). Reading the same normalised base from one place is what keeps the two in agreement.
 *
 * A value `new URL` cannot parse, or that is not http(s), is handed back with only its trailing slashes
 * removed: normalising it would invent something (a scheme-less `engine:4567` parses with origin "null"), and
 * `suwayomiConfigured` / `isEngineOrigin` already treat such a value as no engine. `raw` is a parameter, not
 * read from `env` inside, because env is parsed once at module load and a test could not vary it otherwise.
 */
export function suwayomiBase(raw: string | undefined = env.SUWAYOMI_URL): string {
  const s = (raw || '').trim();
  if (!s) return '';
  let u: URL;
  try { u = new URL(s); } catch { return s.replace(/\/+$/, ''); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return s.replace(/\/+$/, '');
  return u.origin + u.pathname.replace(/\/+$/, '');
}

/** Absolute URL for a path Suwayomi returned (thumbnails and pages come back server-relative). */
export function suwayomiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${suwayomiBase()}/${path.replace(/^\//, '')}`;
}

/** Headers for fetching an image back off Suwayomi (it proxies covers and pages through itself). */
export function suwayomiImageHeaders(): Record<string, string> {
  return env.SUWAYOMI_USERNAME
    ? { authorization: 'Basic ' + Buffer.from(`${env.SUWAYOMI_USERNAME}:${env.SUWAYOMI_PASSWORD}`).toString('base64') }
    : {};
}

export function suwayomiConfigured(): boolean {
  return !!env.SUWAYOMI_URL;
}

/**
 * Who failed, in words `diagnose` can tell apart (#115). A transport failure used to surface as undici's bare
 * "fetch failed" and an abort as "The operation was aborted due to timeout": neither said it was the ENGINE that
 * did not answer, and the one rule that did mention the engine matched every `suwayomi: ` message -- which is the
 * opposite case, the engine answering with the extension's own exception. So "Manga Ball (EN)", whose extension
 * threw on the site, was reported as "The extension server did not answer. Check that container."
 *
 * The four shapes, and only these:
 *   `suwayomi unreachable: fetch failed (<code>)`  no answer at all (refused, reset, DNS)
 *   `suwayomi timeout after <n>ms`                 no answer in time
 *   `suwayomi <status>`                            the engine's HTTP layer refused (auth, 5xx)
 *   `suwayomi: <message>`                          the engine ran the query and the extension failed
 * classify() still reads the first two as 'down' ("fetch failed", "timeout"), so cooldowns do not change.
 * `cause` is kept, so a caller that reads `e.cause.code` (the fake engine's own test does) still can.
 */
function transportError(e: any, timeoutMs: number): Error {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return new Error(`suwayomi timeout after ${timeoutMs}ms`, { cause: e });
  }
  const code = e?.cause?.code || e?.code || e?.cause?.name || e?.name || 'error';
  return new Error(`suwayomi unreachable: fetch failed (${code})`, { cause: e?.cause ?? e });
}

/**
 * Run one GraphQL operation. Errors carry the HTTP status in their message on purpose: lib/sourceHealth.ts
 * `classify()` reads the message to decide blocked vs rate-limited vs down, so a failing extension server
 * lands in the existing source-health machinery with no special casing. Every error starts with "suwayomi"
 * (see transportError for the four shapes).
 */
export async function gql<T = unknown>(query: string, variables: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
  if (!suwayomiConfigured()) throw new Error('suwayomi is not configured');
  let r: Response;
  try {
    r = await fetch(suwayomiUrl('/api/graphql'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...suwayomiImageHeaders() },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw transportError(e, timeoutMs);
  }
  if (!r.ok) {
    const e: GqlError = new Error(`suwayomi ${r.status}`);
    e.status = r.status;
    throw e;
  }
  let j: { data?: T; errors?: Array<{ message?: string }> };
  try {
    j = (await r.json()) as typeof j;
  } catch (e: any) {
    // The body is read under the same signal, so a slow or dropped body is still the engine not answering; a
    // body that is not JSON at all (a proxy's HTML page) is an answer with nothing in it.
    if (e?.name === 'SyntaxError') throw new Error('suwayomi returned no data', { cause: e });
    throw transportError(e, timeoutMs);
  }
  if (j?.errors?.length) throw new Error(`suwayomi: ${j.errors[0]?.message || 'graphql error'}`);
  if (j?.data === undefined || j?.data === null) throw new Error('suwayomi returned no data');
  return j.data;
}

/** The dependency the adapters take, so tests can drive them from fixtures without a server. */
export type Gql = typeof gql;

export interface ServerInfo {
  name: string;
  version: string;
  revision: string;
}

export async function aboutServer(run: Gql = gql): Promise<ServerInfo> {
  const d = await run<{ aboutServer: ServerInfo }>('{ aboutServer { name version revision } }', {}, 8000);
  return d.aboutServer;
}
