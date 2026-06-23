// Same-origin API client. Access token lives in memory; the httpOnly refresh
// cookie silently re-mints it (and the image cookie) on 401 or app launch.

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;

export function setAccessToken(t: string | null) {
  accessToken = t;
}
export function getAccessToken() {
  return accessToken;
}

export class ApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`API ${status}`);
  }
}

export async function refreshSession(): Promise<boolean> {
  if (!refreshing) {
    refreshing = fetch('/auth/refresh', { method: 'POST', credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) return false;
        const j = await r.json();
        accessToken = j.accessToken;
        return true;
      })
      .catch(() => false)
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

async function raw(path: string, opts: Opts, retry: boolean): Promise<Response> {
  const headers = new Headers(opts.headers || {});
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  const body = opts.json !== undefined ? JSON.stringify(opts.json) : undefined;
  if (body) headers.set('content-type', 'application/json');

  const res = await fetch(path, {
    method: opts.method || (body ? 'POST' : 'GET'),
    headers,
    body,
    credentials: 'include',
    signal: opts.signal,
  });

  if (res.status === 401 && retry) {
    const ok = await refreshSession();
    if (ok) return raw(path, opts, false);
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
  seriesThumb: (id: string, av?: number) => `/img/series/${encodeURIComponent(id)}/thumb?v=2${av ? `&av=${av}` : ''}`,
  bookThumb: (id: string) => `/img/books/${encodeURIComponent(id)}/thumb`,
  page: (bookId: string, n: number, w?: number) =>
    `/img/books/${encodeURIComponent(bookId)}/page/${n}${w ? `?w=${w}` : ''}`,
};
