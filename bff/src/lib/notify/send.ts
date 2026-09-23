/**
 * One POST to a notification target, and what came of it (v0.43.0, #70). No database here: the caller
 * records the outcome (index.ts), which is what lets notifySend.test.ts drive the real thing against a real
 * listener on loopback -- a mock that "returns a 302" would only prove the mock was consulted.
 *
 * ⚠️ `redirect: 'error'` IS THE LOAD-BEARING LINE IN THIS FEATURE. Every address rule in guard.ts judges the
 * URL that was saved; a redirect is a second URL that nobody judged, and fetch follows by default -- a public
 * host that answers 302 to 169.254.169.254 would receive the Home Assistant token and forward the request
 * there. The cover proxy shipped exactly that for two releases while its comment said redirects were not
 * followed (images.ts, engineRedirect.test.ts). Node's fetch does drop Authorization on a CROSS-origin hop by
 * itself, which is why the test also redirects to the same origin: a 307 there re-POSTs the whole digest,
 * token and all, to a path nobody configured.
 *
 * The answer is a closed set of reasons, never the upstream body, headers or resolved address. The body is
 * cancelled unread.
 */
import { Agent, fetch } from 'undici';
import { guardedLookup, effectivePort, refusal, safeUrl, systemResolver, type Resolver } from './guard';
import type { OutboundRequest } from './kinds';

export const REASONS = [
  'ok', 'timeout', 'refused', 'dns', 'tls', 'unreachable', 'unauthorized', 'not_found', 'rate_limited',
  'server_error', 'bad_response', 'redirect', 'blocked', 'secret_unreadable',
] as const;
export type Reason = (typeof REASONS)[number];
export interface SendResult { ok: boolean; status: number | null; reason: Reason }

/** The sentence an admin reads for each reason. English here; the admin panel translates by the code. */
export const REASON_TEXT: Record<Reason, string> = {
  ok: 'Delivered',
  timeout: 'No answer within 10 seconds',
  refused: 'The connection was refused — is the service running on that port?',
  dns: 'That host name could not be resolved',
  tls: 'The HTTPS certificate was not accepted',
  unreachable: 'The address could not be reached',
  unauthorized: 'The target refused the token (401/403)',
  not_found: 'Nothing answers at that address (404)',
  rate_limited: 'The target asked us to slow down (429)',
  server_error: 'The target failed with a server error (5xx)',
  bad_response: 'The target refused the request',
  redirect: 'The target answered with a redirect, which is never followed',
  blocked: 'That address is refused (cloud metadata, or this server itself)',
  secret_unreadable: 'The stored address and token could not be read — enter them again under Admin → Settings → Notifications',
};

/** Worth one more try: the far end may be restarting. A 4xx is an answer, and asking twice teaches nothing. */
const RETRYABLE = new Set<Reason>(['timeout', 'refused', 'dns', 'unreachable', 'server_error', 'rate_limited']);

export interface SendOptions {
  /** DNS for the connection; a test hands back [public, metadata]. */
  resolve?: Resolver;
  timeoutMs?: number;
  /** One more attempt after `retryDelayMs` on a network error, a 429 or a 5xx. Off for the admin's Test. */
  retry?: boolean;
  retryDelayMs?: number;
}

function fromStatus(status: number): SendResult {
  if (status >= 200 && status < 300) return { ok: true, status, reason: 'ok' };
  if (status >= 300 && status < 400) return { ok: false, status, reason: 'redirect' };
  if (status === 401 || status === 403) return { ok: false, status, reason: 'unauthorized' };
  if (status === 404 || status === 410) return { ok: false, status, reason: 'not_found' };
  if (status === 429) return { ok: false, status, reason: 'rate_limited' };
  if (status >= 500) return { ok: false, status, reason: 'server_error' };
  return { ok: false, status, reason: 'bad_response' };
}

/** A thrown fetch, read down to a reason. Only codes and fixed messages are looked at; nothing is kept. */
function fromError(e: unknown): SendResult {
  const err = e as { name?: string; cause?: { code?: string; name?: string; message?: string } };
  const cause = err?.cause ?? {};
  const code = String(cause.code ?? '');
  const msg = String(cause.message ?? '');
  const reason: Reason =
    err?.name === 'TimeoutError' || err?.name === 'AbortError' || cause.name === 'TimeoutError' || /timeout/i.test(code) ? 'timeout'
    : code === 'EMETADATA' || code === 'ESELF' || msg === 'bad port' ? 'blocked'
    : msg === 'unexpected redirect' ? 'redirect'
    : code === 'ECONNREFUSED' ? 'refused'
    : code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME' || code === 'EAI_FAIL' ? 'dns'
    : /CERT|TLS|SSL|EPROTO/.test(code) ? 'tls'
    : 'unreachable';
  return { ok: false, status: null, reason };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function attempt(u: URL, req: OutboundRequest, resolve: Resolver, timeoutMs: number): Promise<SendResult> {
  // One agent per attempt, so the lookup knows the port (loopback is refused only on OUR port) and no
  // pooled connection outlives the check that allowed it. Notifications are rare; the handshake is cheap.
  const agent = new Agent({ connect: { lookup: guardedLookup(resolve, effectivePort(u)) } });
  try {
    const res = await fetch(u, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher: agent,
    });
    await res.body?.cancel().catch(() => {});
    return fromStatus(res.status);
  } catch (e) {
    return fromError(e);
  } finally {
    agent.destroy().catch(() => {});
  }
}

/** POST this request, at most twice, and say what happened in a word. Never throws. */
export async function sendRequest(req: OutboundRequest, opts: SendOptions = {}): Promise<SendResult> {
  const u = safeUrl(req.url);
  if (!u || refusal(u)) return { ok: false, status: null, reason: 'blocked' };
  const resolve = opts.resolve ?? systemResolver;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const first = await attempt(u, req, resolve, timeoutMs);
  if (first.ok || !opts.retry || !RETRYABLE.has(first.reason)) return first;
  await sleep(opts.retryDelayMs ?? 30_000);
  return attempt(u, req, resolve, timeoutMs);
}
