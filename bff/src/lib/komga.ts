import { request as undiciRequest, Agent, Dispatcher } from 'undici';
import { env } from '../env';

const agent = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connections: 64,
  pipelining: 1,
});

const BASE = env.KOMGA_BASE_URL.replace(/\/$/, '');

export class KomgaError extends Error {
  constructor(public status: number, public body: string) {
    super(`Komga ${status}: ${body.slice(0, 200)}`);
  }
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'X-API-Key': env.KOMGA_API_KEY, ...extra };
}

/** JSON request against the Komga REST API. `path` starts with `/api/...`. */
export async function komgaJson<T = any>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = opts.method ?? 'GET';
  const hasBody = opts.body !== undefined;
  const res = await undiciRequest(`${BASE}${path}`, {
    method: method as Dispatcher.HttpMethod,
    dispatcher: agent,
    headers: authHeaders(hasBody ? { 'content-type': 'application/json' } : {}),
    body: hasBody ? JSON.stringify(opts.body) : undefined,
  });
  if (res.statusCode >= 400) {
    const text = await res.body.text();
    throw new KomgaError(res.statusCode, text);
  }
  // Some endpoints return no body (204 No Content, 202 Accepted for scans).
  if (res.statusCode === 204 || res.statusCode === 202) return undefined as unknown as T;
  return (await res.body.json()) as T;
}

/** Streaming image request — returns the raw upstream response for the proxy to relay. */
export async function komgaImage(
  path: string,
  opts: { range?: string } = {},
): Promise<Dispatcher.ResponseData> {
  return undiciRequest(`${BASE}${path}`, {
    method: 'GET',
    dispatcher: agent,
    headers: authHeaders(opts.range ? { range: opts.range } : {}),
  });
}

// ---- Spring-style page envelope ---------------------------------------------
export interface Page<T> {
  content: T[];
  totalElements: number;
  totalPages: number;
  number: number; // 0-based
  size: number;
  first: boolean;
  last: boolean;
}

// ---- Typed helpers for the endpoints the BFF uses ---------------------------
const enc = encodeURIComponent;

export const komga = {
  libraries: () => komgaJson<any[]>('/api/v1/libraries'),

  genres: () => komgaJson<string[]>('/api/v1/genres'),

  seriesNew: (page = 0, size = 20, libraryId?: string) =>
    komgaJson<Page<any>>(
      `/api/v1/series/new?page=${page}&size=${size}&deleted=false${libraryId ? `&library_id=${enc(libraryId)}` : ''}`,
    ),

  seriesUpdated: (page = 0, size = 20, libraryId?: string) =>
    komgaJson<Page<any>>(
      `/api/v1/series/updated?page=${page}&size=${size}&deleted=false${libraryId ? `&library_id=${enc(libraryId)}` : ''}`,
    ),

  booksOnDeck: (page = 0, size = 20, libraryId?: string) =>
    komgaJson<Page<any>>(
      `/api/v1/books/ondeck?page=${page}&size=${size}${libraryId ? `&library_id=${enc(libraryId)}` : ''}`,
    ),

  /** Structured series search (Komga v1.24.x POST condition tree). */
  searchSeries: (body: { condition?: unknown; fullTextSearch?: string }, page = 0, size = 40, sort?: string) =>
    komgaJson<Page<any>>(
      `/api/v1/series/list?page=${page}&size=${size}${sort ? `&sort=${enc(sort)}` : ''}`,
      { method: 'POST', body },
    ),

  series: (id: string) => komgaJson<any>(`/api/v1/series/${enc(id)}`),

  seriesBooks: (id: string, page = 0, size = 100, sort = 'metadata.numberSort,asc') =>
    komgaJson<Page<any>>(
      `/api/v1/series/${enc(id)}/books?page=${page}&size=${size}&sort=${enc(sort)}&deleted=false`,
    ),

  book: (id: string) => komgaJson<any>(`/api/v1/books/${enc(id)}`),

  bookPages: (id: string) => komgaJson<any[]>(`/api/v1/books/${enc(id)}/pages`),

  /** Next book in the series reading order (for auto-advance). */
  bookNext: (id: string) => komgaJson<any>(`/api/v1/books/${enc(id)}/next`),
  bookPrevious: (id: string) => komgaJson<any>(`/api/v1/books/${enc(id)}/previous`),

  setReadProgress: (id: string, page: number, completed: boolean) =>
    komgaJson<void>(`/api/v1/books/${enc(id)}/read-progress`, {
      method: 'PATCH',
      body: { page, completed },
    }),

  /** Trigger an on-demand library scan (picks up new Suwayomi downloads). */
  scanLibrary: (libraryId: string) =>
    komgaJson<void>(`/api/v1/libraries/${enc(libraryId)}/scan`, { method: 'POST' }),

  // image paths (used by the image proxy)
  seriesThumbPath: (id: string) => `/api/v1/series/${enc(id)}/thumbnail`,
  bookThumbPath: (id: string) => `/api/v1/books/${enc(id)}/thumbnail`,
  bookPagePath: (id: string, n: number) => `/api/v1/books/${enc(id)}/pages/${n}`,
};
