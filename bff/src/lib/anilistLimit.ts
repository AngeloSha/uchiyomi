// One AniList quota for the whole server (v0.73.0). AniList limits each IP address -- 90 requests a minute normally, 30 while
// it is degraded, as its own `X-RateLimit-Limit` header says -- and every request this server makes to it counts against
// the same number: a person's tracker pushes, the scores, the art, Discover's lookups, the reading directions and the
// filled-in details. Each of those used to pace itself (2.4 s per push lane, 2.2 s between batch pages) and none knew of
// the others, so a tracker's connect backfill met a 429 after fourteen series, dropped the push, and left
// "anilist 429" on the connection.
//
// Every AniList GraphQL request goes through anilistFetch:
//   - it spaces the requests by the LIVE limit: once AniList has answered with `X-RateLimit-Limit`, calls start at
//     least 60 s / (limit - 2) apart, a little under the limit so another program behind the same address has room.
//     An answer without the header (a fake AniList in a test, an edge error page) leaves the spacing as it was;
//   - a 429 holds every caller until `Retry-After` has passed (else `X-RateLimit-Reset`, else a minute), and so does a
//     spent quota (`X-RateLimit-Remaining` 0 before its reset). The request is then made again, `retries` times;
//   - a caller that cannot wait that long -- an image request, a person pressing Connect -- says how long it may
//     (`maxWaitMs`) and is answered at once with AniListBusy, which every caller treats as "try again later", never as
//     an answer to remember.
// The timeout of each attempt starts when that attempt does, never during the wait for a turn.
//
// No imports: lib/anilist.ts and lib/trackerProviders.ts both use it, and neither may pull the other in.

/** What the clock is: the tests put a virtual one here, so a minute of spacing costs them nothing. */
export const anilistClock = {
  now: (): number => Date.now(),
  sleep: (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms)),
};

/** How long a background caller (a push, a batch) may be held: past this, AniList is answered as busy. */
export const WAIT_BACKGROUND_MS = 10 * 60_000;
/** How long a person or an image may be held. */
export const WAIT_INTERACTIVE_MS = 15_000;
/** A 429 with no Retry-After and no reset time holds the quota this long. */
const RATE_LIMIT_DEFAULT_MS = 60_000;

/** AniList's quota as its last answer stated it. */
let limit: number | null = null;
let remaining: number | null = null;
let resetAt = 0;
/** No request starts before these: the spacing's next slot, and a 429's (or a spent quota's) hold. */
let nextAt = 0;
let heldUntil = 0;

/** A request that would have had to wait longer than its caller allows. `waitMs` is how long. */
export class AniListBusy extends Error {
  readonly rateLimited = true;
  /** Read as AniList's own 429 by every caller that looks at the status (lib/trackerProviders.ts verdictOf). */
  readonly status = 429;
  constructor(readonly waitMs: number) {
    super(`anilist is rate limited for ${Math.ceil(waitMs / 1000)} s`);
  }
}

/** The pause between two requests at the live limit; none until AniList has said what its limit is. */
function gap(): number {
  return limit ? Math.ceil(60_000 / Math.max(1, limit - 2)) : 0;
}

/** Read what AniList said about its quota. */
function observe(r: Response, now: number): void {
  const num = (k: string): number | null => {
    const v = r.headers.get(k);
    const n = v == null || v.trim() === '' ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const lim = num('x-ratelimit-limit');
  if (lim !== null && lim > 0) limit = Math.min(1000, Math.floor(lim));
  const rem = num('x-ratelimit-remaining');
  if (rem !== null) remaining = rem;
  const reset = num('x-ratelimit-reset');
  if (reset !== null && reset > 0) resetAt = reset * 1000;
  // A spent quota: nothing more until it resets.
  if (remaining !== null && remaining <= 0 && resetAt > now) heldUntil = Math.max(heldUntil, resetAt);
  if (r.status === 429) {
    const after = num('retry-after');
    const hold = after !== null && after > 0 ? after * 1000 : resetAt > now ? resetAt - now : RATE_LIMIT_DEFAULT_MS;
    heldUntil = Math.max(heldUntil, now + hold);
  }
}

export interface AniListFetchOptions {
  /** The longest this caller may wait for its turn, a 429's hold included. Past it: AniListBusy. */
  maxWaitMs?: number;
  /** How many times a 429 is waited out and the request made again; the last 429 is answered as it came. */
  retries?: number;
  /** Each attempt's own timeout, from the moment it starts. */
  timeoutMs?: number;
}

/**
 * fetch() for AniList, under the one quota. `init` carries no signal (each attempt gets its own timeout). Answers the
 * response as AniList gave it -- a 429 only once `retries` are spent -- or throws AniListBusy when the wait for a turn
 * would pass `maxWaitMs`, and whatever fetch itself throws.
 */
export async function anilistFetch(url: string, init: RequestInit, opts: AniListFetchOptions = {}): Promise<Response> {
  const maxWait = opts.maxWaitMs ?? WAIT_BACKGROUND_MS;
  const retries = opts.retries ?? 5;
  for (let attempt = 0; ; attempt++) {
    const now = anilistClock.now();
    const at = Math.max(now, nextAt, heldUntil);
    if (at - now > maxWait) throw new AniListBusy(at - now);
    // The slot is taken before the wait, so callers arriving meanwhile queue behind it rather than beside it.
    nextAt = at + gap();
    if (at > now) await anilistClock.sleep(at - now);
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
    observe(r, anilistClock.now());
    if (r.status !== 429 || attempt >= retries) return r;
    await r.body?.cancel().catch(() => {});
  }
}

/** A thrown value that means "AniList asked us to wait": AniListBusy, or a 429 a caller turned into an error. */
export const isRateLimit = (e: unknown): boolean =>
  !!(e as { rateLimited?: boolean } | null)?.rateLimited || (e as { status?: number } | null)?.status === 429;

/** Tests only: forget everything AniList said. */
export function resetAniListQuota(): void {
  limit = null; remaining = null; resetAt = 0; nextAt = 0; heldUntil = 0;
}
