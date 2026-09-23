// The FlareSolverr v1 wire protocol, as the two real clients use it (design-shell.md §3.1-§3.2).
//
// Pure: no Electron, no sockets. server.ts speaks HTTP with it and browser.ts fills in SolveResult, so the
// contract tests can hold every byte of this file against the bff's own client and Suwayomi's parser without
// starting a browser.
//
// Everything here is copied from FlareSolverr 3.5.2 (src/flaresolverr_service.py, src/dtos.py,
// src/sessions.py) rather than paraphrased, because two consumers read the WORDS:
//   - bff/src/lib/sourceDiagnosis.ts classifies a stored error by regex ("timeout after N seconds",
//     "error solving the challenge", "cloudflare"), and
//   - Suwayomi's CloudflareInterceptor.kt:67 branches on `message.contains("not detected")`.

/** FlareSolverr's own strings. Any drift here changes what the Health page tells an admin. */
export const MSG = {
  ready: 'FlareSolverr is ready!',
  solved: 'Challenge solved!',
  notDetected: 'Challenge not detected!',
  sessionCreated: 'Session created successfully.',
  sessionExists: 'Session already exists.',
  sessionRemoved: 'The session has been removed.',
  sessionMissing: "The session doesn't exist.",
  /** flaresolverr_service.py:405-406 and :411-412, verbatim. */
  blocked: 'Cloudflare has blocked this request. Probably your IP is banned for this site, check in your web browser.',
  /** Ours (design-shell.md §3.2). Still starts "Error solving the challenge." so sourceDiagnosis files it as solver_timeout. */
  humanCheck: 'Cloudflare wants a human check: a verification window is open in Uchiyomi.',
} as const;

/** `Error solving the challenge. Timeout after 60.0 seconds.` -- Python's str() of `int(maxTimeout) / 1000`. */
export function pySeconds(ms: number): string {
  const s = ms / 1000;
  return Number.isInteger(s) ? s.toFixed(1) : String(s);
}

export type Cmd = 'request.get' | 'request.post' | 'sessions.create' | 'sessions.list' | 'sessions.destroy';

export interface RequestCookie { name: string; value: string }

/** A validated `request.get` / `request.post`, as the backend receives it. */
export interface SolveRequest {
  id: number;
  method: 'GET' | 'POST';
  url: string;
  /** Form-encoded body for POST (madara sends ""); undefined on GET. */
  postData?: string;
  cookies: RequestCookie[];
  /** Named session (Suwayomi sends its fixed "suwayomi"); undefined for the bff's session-less calls. */
  session?: string;
  sessionTtlMinutes?: number;
  returnOnlyCookies: boolean;
  waitInSeconds: number;
  disableMedia: boolean;
  returnScreenshot: boolean;
  maxTimeoutMs: number;
  /** Aborted when maxTimeout runs out (or the server shuts down). The backend must stop and reject. */
  signal: AbortSignal;
}

/** FlareSolverr's cookie, in the CDP shape the design names; Suwayomi requires `domain` and parses the rest optionally. */
export interface SolverCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Seconds since the epoch, or -1 for a session cookie (CDP's convention). */
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite: 'None' | 'Lax' | 'Strict';
}

export interface SolveResult {
  url: string;
  /** The main frame's real HTTP status; reported in X-Origin-Status only (solution.status stays 200). */
  originStatus: number;
  response?: string;
  cookies: SolverCookie[];
  userAgent: string;
  challenged: boolean;
  screenshot?: string;
}

export type SolveErrorKind = 'timeout' | 'blocked' | 'human' | 'navigation' | 'crashed' | 'aborted';

/** A failure the backend explains. `reason` is appended after "Error solving the challenge. ". */
export class SolveError extends Error {
  constructor(public kind: SolveErrorKind, public reason: string) {
    super(reason);
  }
}

export interface SolverBackend {
  solve(req: SolveRequest): Promise<SolveResult>;
  /** true = created now, false = it already existed (FlareSolverr's two messages). */
  sessionsCreate(name: string): Promise<boolean>;
  sessionsList(): string[];
  /** false = no such session. */
  sessionsDestroy(name: string): Promise<boolean>;
  userAgent(): string;
}

/** A request the protocol layer refuses before any browser work. The message is FlareSolverr's where it has one. */
export class BadRequest extends Error {}

export const MAX_TIMEOUT_DEFAULT = 60_000;
export const MAX_TIMEOUT_MIN = 1_000;
export const MAX_TIMEOUT_MAX = 180_000;

const str = (v: unknown): v is string => typeof v === 'string';

/**
 * Validate one POST /v1 body into a command. Throws BadRequest with FlareSolverr's wording.
 *
 * Accepted-and-ignored, like FlareSolverr: `proxy` (Suwayomi omits it; we are never a proxy), `tabs_till_verify`,
 * the removed v1 fields `headers`/`userAgent`/`download`/`returnRawHtml`.
 */
export function parseCommand(body: unknown): { cmd: Cmd; raw: Record<string, unknown> } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest("Request parameter 'cmd' is mandatory.");
  const raw = body as Record<string, unknown>;
  const cmd = raw.cmd;
  if (cmd === undefined || cmd === null) throw new BadRequest("Request parameter 'cmd' is mandatory.");
  if (!['request.get', 'request.post', 'sessions.create', 'sessions.list', 'sessions.destroy'].includes(cmd as string)) {
    throw new BadRequest(`Request parameter 'cmd' = '${String(cmd)}' is invalid.`);
  }
  return { cmd: cmd as Cmd, raw };
}

export function clampTimeout(v: unknown): number {
  const n = Number(v);
  // FlareSolverr: `if req.maxTimeout is None or int(req.maxTimeout) < 1: req.maxTimeout = 60000`.
  if (v === undefined || v === null || !Number.isFinite(n) || n < 1) return MAX_TIMEOUT_DEFAULT;
  return Math.min(MAX_TIMEOUT_MAX, Math.max(MAX_TIMEOUT_MIN, Math.trunc(n)));
}

/** Only http(s) to a real host. The browser must never be pointed at file:, data:, chrome:, javascript:... */
export function checkTargetUrl(u: unknown, cmd: string): URL {
  if (!str(u) || !u) throw new BadRequest(`Request parameter 'url' is mandatory in '${cmd}' command.`);
  let url: URL;
  try { url = new URL(u); } catch { throw new BadRequest(`Request parameter 'url' is not a valid URL.`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BadRequest(`Request parameter 'url' must be an http or https URL.`);
  return url;
}

export function parseSolveRequest(cmd: 'request.get' | 'request.post', raw: Record<string, unknown>, id: number, signal: AbortSignal): SolveRequest {
  const url = checkTargetUrl(raw.url, cmd);
  const method = cmd === 'request.post' ? 'POST' : 'GET';
  let postData: string | undefined;
  if (method === 'POST') {
    // flaresolverr_service.py:170-171. The empty string is VALID: madara's chapter list is `postData: ""`.
    if (raw.postData === undefined || raw.postData === null) throw new BadRequest("Request parameter 'postData' is mandatory in 'request.post' command.");
    if (!str(raw.postData)) throw new BadRequest("Request parameter 'postData' must be a string.");
    postData = raw.postData;
  }
  // On GET, postData is ignored (design-shell.md §3.2). Neither client sends it; FlareSolverr would refuse it.
  const cookies: RequestCookie[] = [];
  if (raw.cookies !== undefined && raw.cookies !== null) {
    if (!Array.isArray(raw.cookies)) throw new BadRequest("Request parameter 'cookies' must be a list.");
    for (const c of raw.cookies) {
      if (!c || typeof c !== 'object' || !str((c as any).name) || !str((c as any).value)) throw new BadRequest("Each cookie needs a 'name' and a 'value'.");
      cookies.push({ name: (c as any).name, value: (c as any).value });
    }
  }
  let session: string | undefined;
  if (raw.session !== undefined && raw.session !== null) {
    if (!str(raw.session) || !raw.session || raw.session.length > 200) throw new BadRequest("Request parameter 'session' must be a non-empty string.");
    session = raw.session;
  }
  const ttl = Number(raw.session_ttl_minutes);
  return {
    id,
    method,
    url: url.toString(),
    postData,
    cookies,
    session,
    sessionTtlMinutes: Number.isFinite(ttl) && ttl > 0 ? ttl : undefined,
    returnOnlyCookies: raw.returnOnlyCookies === true,
    waitInSeconds: Math.max(0, Math.min(30, Number(raw.waitInSeconds) || 0)),
    disableMedia: raw.disableMedia === true,
    returnScreenshot: raw.returnScreenshot === true,
    maxTimeoutMs: clampTimeout(raw.maxTimeout),
    signal,
  };
}

export interface Envelope {
  status: 'ok' | 'error';
  message: string;
  startTimestamp: number;
  endTimestamp: number;
  version: string;
  [k: string]: unknown;
}

/**
 * The solution object, in FlareSolverr's field order. `status` is hard-coded 200 as FlareSolverr does
 * (flaresolverr_service.py:474): a real 404 here would make Suwayomi throw (CloudflareInterceptor.kt:246)
 * where it succeeds today. The truth goes in the X-Origin-Status header instead.
 */
export function solutionOf(r: SolveResult, returnOnlyCookies: boolean): Record<string, unknown> {
  const s: Record<string, unknown> = { url: r.url, status: 200 };
  if (!returnOnlyCookies) {
    s.headers = {};
    s.response = r.response ?? '';
  }
  s.cookies = r.cookies;
  s.userAgent = r.userAgent;
  if (r.screenshot) s.screenshot = r.screenshot;
  return s;
}
