// Same-origin API client. Access token lives in memory; the httpOnly refresh
// cookie silently re-mints it (and the image cookie) on 401 or app launch.

import { withAdult } from './adult';
import { readOfflineIdentity } from './offlineIdentity';

/**
 * What a refresh attempt actually learned.
 *
 * ⚠️ These three used to be two: `refreshSession` returned a boolean, and `if (!r.ok) return false` (the
 * server rejecting us) and `.catch(() => false)` (there being no server to ask) collapsed into the same
 * answer. That is why the installed app showed its sign-in screen in airplane mode -- it could not tell
 * "you are signed out" from "you are on a plane". Keep them apart.
 */
export type SessionResult =
  | { kind: 'authed'; user: any; refreshExpiresAt?: number }
  | { kind: 'rejected' }      // the server answered, and the answer was no
  | { kind: 'unreachable' };  // no usable answer at all: offline, DNS, a 502 mid-deploy, a captive portal

let accessToken: string | null = null;
let refreshing: Promise<SessionResult> | null = null;

/**
 * Who the offline store belongs to.
 *
 * Held beside the token rather than in React state because the IndexedDB layer is a plain module with no
 * access to context, and because it has to be answerable synchronously: `loadChapter` consults the offline
 * store BEFORE any server call, so there is no request in flight to carry the identity.
 *
 * Seeded at module load from the device's saved identity, so a cold boot with no network can find anything
 * at all: `downloads.ts` keys every record `${owner()}:${bookId}`, and without an identity that prefix is
 * `'anon'` and every lookup misses -- an empty reader rather than a sign-in screen, which is the worse
 * failure because it reads as "the downloads are gone".
 *
 * ⚠️ REDUNDANT WITH `AuthProvider`, deliberately, and measured: `adoptOffline` sets the same value from the
 * same record, so deleting EITHER one alone leaves the browser suite's cold-boot block passing. Removing
 * both fails it. Keep both -- this one covers anything that reads the store before React has mounted, which
 * is a load order this module cannot see and should not depend on.
 *
 * The value is still only ever WRITTEN after the server has confirmed who you are; see `offlineIdentity.ts`.
 */
let currentUserId: string | null = readOfflineIdentity()?.id ?? null;

export function setAccessToken(t: string | null) {
  accessToken = t;
}
export function getAccessToken() {
  return accessToken;
}
export function setCurrentUser(id: string | null) {
  currentUserId = id;
}
export function getCurrentUser() {
  return currentUserId;
}

export class ApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`API ${status}`);
  }
}

/**
 * Exchange the refresh cookie for a new access token, and say WHICH of the three things happened.
 *
 * ⚠️ Only an explicit auth refusal is `rejected`. A 502 while the backend restarts, a 504 from a proxy, a
 * 429, or a captive portal answering 200 with a login page are all `unreachable` -- because `rejected` signs
 * the device out, and treating a restart as a rejection would sign out every installed app in the house at
 * once. Reintroduce by folding the non-ok branch into one `false` and the sign-in screen comes back on a
 * plane, which is the bug this shape exists to prevent.
 *
 * The singleton is kept: `online`, `visibilitychange` and the 12-minute interval can all fire together, and
 * they must share one request rather than race to rotate the token three times.
 */
export async function refreshSession(): Promise<SessionResult> {
  if (!refreshing) {
    refreshing = fetch('/auth/refresh', { method: 'POST', credentials: 'include' })
      .then(async (r): Promise<SessionResult> => {
        if (r.status === 401 || r.status === 403) return { kind: 'rejected' };
        if (!r.ok) return { kind: 'unreachable' };
        const j = await r.json();
        accessToken = j.accessToken;
        if (j.user?.id) currentUserId = j.user.id;
        return { kind: 'authed', user: j.user, refreshExpiresAt: j.refreshExpiresAt };
      })
      .catch((): SessionResult => ({ kind: 'unreachable' }))
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

interface Opts {
  method?: string;
  json?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/**
 * The 401s that are an answer, not an expired session.
 *
 * ⚠️ `/auth/password` and `/auth/totp/disable` say 401 `{ error: 'wrong_password' }` when the CURRENT
 * password is wrong, and the login route says 401 `totp_invalid` for a bad code. Treating every 401 as "the
 * access token died" rotated the refresh cookie and re-POSTed the same wrong password a second time --
 * two attempts against the lockout counter for one press of Enter. A refusal the server spelled out is
 * final; only a bare 401 earns the refresh-and-retry. The body is read from a clone so the caller still
 * gets to read it.
 */
const REFUSAL = /"error"\s*:\s*"(?:wrong_password|totp_invalid)"/;
const isRefusal = async (res: Response): Promise<boolean> => REFUSAL.test(await res.clone().text().catch(() => ''));

async function raw(path: string, opts: Opts, retry: boolean): Promise<Response> {
  const headers = new Headers(opts.headers || {});
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  const body = opts.json !== undefined ? JSON.stringify(opts.json) : undefined;
  if (body) headers.set('content-type', 'application/json');

  // The one place the 18+ reveal is attached, so no caller has to remember it and no listing can quietly
  // forget. It rides in the URL rather than a header on purpose -- see lib/adult.ts.
  const res = await fetch(withAdult(path), {
    method: opts.method || (body ? 'POST' : 'GET'),
    headers,
    body,
    credentials: 'include',
    signal: opts.signal,
  });

  if (res.status === 401 && retry && !(await isRefusal(res))) {
    const r = await refreshSession();
    if (r.kind === 'authed') return raw(path, opts, false);
  }
  return res;
}

export async function api<T = any>(path: string, opts: Opts = {}): Promise<T> {
  const res = await raw(path, opts, true);
  if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => ''));
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') || '';
  return (ct.includes('application/json') ? await res.json() : await res.text()) as T;
}

// ---- image URLs (authorized by the httpOnly yomi_img cookie) ----
export const img = {
  // ?v bump = one-time cache-bust so clients pinned to the old immutable panel thumbnails refetch the real covers
  // w: hi-res poster variant (800|1600) for the detail poster / hero; cards use the 400px default
  // A falsy id means the caller rendered a tile before its data arrived. Returning '' makes <img> skip the
  // request entirely; Img shows its placeholder. Requesting /img/series/undefined/thumb only ever produced a
  // server error and a broken tile.
  seriesThumb: (id: string, av?: number, w?: number) =>
    id ? `/img/series/${encodeURIComponent(id)}/thumb?v=2${av ? `&av=${av}` : ''}${w ? `&w=${w}` : ''}` : '',
  bookThumb: (id: string) => (id ? `/img/books/${encodeURIComponent(id)}/thumb` : ''),
  page: (bookId: string, n: number, w?: number) =>
    `/img/books/${encodeURIComponent(bookId)}/page/${n}${w ? `?w=${w}` : ''}`,
};
