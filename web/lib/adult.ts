'use client';
/**
 * Whether 18+ libraries are showing, for this browser session.
 *
 * A library rated 18+ is kept off every browsing surface by default: the home rails, the library grid,
 * search, browse, collections, updates, history, bookmarks and the OPDS feeds. A button reveals them, and
 * the reveal lasts until the browser session ends.
 *
 * WHY A SESSION COOKIE, and not localStorage or sessionStorage:
 *   - "until you close the browser" is precisely what a cookie with no Max-Age already means, so the
 *     lifetime is the browser's own rather than something this file has to reimplement and get wrong;
 *   - sessionStorage is per-TAB, so two tabs of the same app would disagree with each other, which is
 *     bewildering when one of them is a series page opened from the other;
 *   - localStorage would outlive the session, which is the one thing the setting must not do.
 * It is deliberately not httpOnly: this is a display preference the page itself has to read, not a
 * credential. The server never trusts it for access — see `browsable()` in the API.
 *
 * The server is told by a query parameter rather than by the cookie, and that is not redundancy. The
 * service worker caches `/api/` responses with `networkFirst`, and the Cache API keys by URL with no
 * `Vary`: a cookie leaves a revealed `/api/home` sitting under the same URL as an unrevealed one, ready to
 * be replayed the first time the network hiccups. A different URL is a different cache entry, for free.
 */
const COOKIE = 'yomi_adult';

/** Read straight from document.cookie every time: another tab may have changed it since this one loaded. */
export function adultShown(): boolean {
  if (typeof document === 'undefined') return false;
  return document.cookie.split('; ').some((c) => c === `${COOKIE}=1`);
}

/**
 * Anything rendering off this state has to hear about a change made elsewhere on the page: the toggle sits
 * in the library header while the library tab row two lines below it also has to react. A cookie fires no
 * event of its own, so it gets one.
 */
const listeners = new Set<() => void>();
export function onAdultChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function setAdultShown(on: boolean): void {
  if (typeof document === 'undefined') return;
  // No Max-Age and no Expires: that is what makes it a session cookie. Secure only over https, because the
  // app is commonly reached over plain http on a LAN and a Secure cookie would simply never be stored.
  const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; secure' : '';
  document.cookie = on
    ? `${COOKIE}=1; path=/; samesite=lax${secure}`
    : `${COOKIE}=; path=/; max-age=0; samesite=lax${secure}`;
  listeners.forEach((f) => f());
}

/**
 * Add the reveal to a request URL, when it is on.
 *
 * Only when ON, so the common case is byte-for-byte the URLs the app has always used and nothing already
 * cached is invalidated by shipping this.
 */
export function withAdult(path: string): string {
  if (!adultShown()) return path;
  return `${path}${path.includes('?') ? '&' : '?'}adult=1`;
}
