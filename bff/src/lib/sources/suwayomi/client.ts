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

/** Absolute URL for a path Suwayomi returned (thumbnails and pages come back server-relative). */
export function suwayomiUrl(path: string): string {
  const base = env.SUWAYOMI_URL.replace(/\/$/, '');
  if (/^https?:\/\//i.test(path)) return path;
  return `${base}/${path.replace(/^\//, '')}`;
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
 * Run one GraphQL operation. Errors carry the HTTP status in their message on purpose: lib/sourceHealth.ts
 * `classify()` reads the message to decide blocked vs rate-limited vs down, so a failing extension server
 * lands in the existing source-health machinery with no special casing.
 */
export async function gql<T = unknown>(query: string, variables: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
  if (!suwayomiConfigured()) throw new Error('suwayomi is not configured');
  const r = await fetch(suwayomiUrl('/api/graphql'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...suwayomiImageHeaders() },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) {
    const e: GqlError = new Error(`suwayomi ${r.status}`);
    e.status = r.status;
    throw e;
  }
  const j = (await r.json()) as { data?: T; errors?: Array<{ message?: string }> };
  if (j.errors?.length) throw new Error(`suwayomi: ${j.errors[0]?.message || 'graphql error'}`);
  if (j.data === undefined || j.data === null) throw new Error('suwayomi returned no data');
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
