// The extension engine's own Cloudflare helper setting, read and set through its GraphQL (#72, #54).
//
// Extension sources never go through Uchiyomi's solver: the ENGINE talks to the site, and hands a challenged
// request to the FlareSolverr it has been told about -- which is off by default (ServerConfig flareSolverrEnabled
// false, flareSolverrUrl http://localhost:8191, as a fresh v2.3.2243 reports them). The shipped compose files set
// both on the engine's container, but an engine from the Unraid template with the field left empty, a CasaOS
// add-on edited by hand or a Suwayomi someone already ran does not have them, and every Cloudflare-protected
// extension then fails its search with "Cloudflare bypass currently disabled" (#54).
//
// The engine keeps a value set here: its image writes FLARESOLVERR_* into server.conf only when the variable is
// non-empty, so a setting made over GraphQL survives restarts unless the container itself names a solver.
//
// ⚠️ NEVER set without an admin asking. This is someone else's server's configuration; Uchiyomi offers the
// change (Health's "Connect the Cloudflare helper", Admin → Extensions' Connect) and makes it when pressed.
import { gql as defaultGql, type Gql } from './client';

/** What the engine reports. `supported: false`: its settings type has no such fields (an older or odd engine). */
export type EngineSolver =
  | { supported: true; enabled: boolean; url: string }
  | { supported: false };

/**
 * - `ok`: on, and pointed at the solver Uchiyomi uses;
 * - `off`: switched off, or on with no address;
 * - `localhost`: on, pointed at localhost -- the engine's own container on a server, where no solver runs (the
 *   engine's default address);
 * - `other`: on, pointed at some other solver (someone's own; it may be fine);
 * - `unsupported`: the engine does not report the setting.
 */
export type SolverWiring = 'ok' | 'off' | 'localhost' | 'other' | 'unsupported';

const READ_Q = '{ settings { flareSolverrEnabled flareSolverrUrl } }';
const SET_M = 'mutation($u:String!){ setSettings(input:{settings:{flareSolverrEnabled:true, flareSolverrUrl:$u}}){ settings { flareSolverrEnabled flareSolverrUrl } } }';

/**
 * Read the engine's setting. A "Cannot query field" refusal means an engine without these settings, which is an
 * answer (`supported: false`); anything else -- unreachable, a timeout -- is thrown for the caller to report.
 */
export async function getEngineSolver(run: Gql = defaultGql, timeoutMs = 15000): Promise<EngineSolver> {
  try {
    const d = await run<{ settings: { flareSolverrEnabled: boolean | null; flareSolverrUrl: string | null } }>(READ_Q, {}, timeoutMs);
    return { supported: true, enabled: !!d?.settings?.flareSolverrEnabled, url: String(d?.settings?.flareSolverrUrl ?? '') };
  } catch (e) {
    if (/Cannot query field/i.test((e as Error)?.message ?? '')) return { supported: false };
    throw e;
  }
}

/**
 * Point the engine at `url` and switch its helper on, and say what it held before and holds now.
 *
 * Read first: desktop/engine/README.md records a setSettings that was the first settings access after the
 * engine booted as echoed back and then lost (measured for extensionRepos, a migrated value; the same order costs
 * nothing here). A read is one round trip; a write that silently did not stick is a Health row that never clears.
 */
export async function setEngineSolver(url: string, run: Gql = defaultGql): Promise<{ before: EngineSolver; after: EngineSolver }> {
  const before = await getEngineSolver(run);
  if (!before.supported) return { before, after: before };
  const d = await run<{ setSettings: { settings: { flareSolverrEnabled: boolean | null; flareSolverrUrl: string | null } } }>(SET_M, { u: url }, 20000);
  const s = d?.setSettings?.settings;
  return { before, after: { supported: true, enabled: !!s?.flareSolverrEnabled, url: String(s?.flareSolverrUrl ?? '') } };
}

/**
 * The solver Uchiyomi itself was given, for the engine to share: FLARESOLVERR_URL as set, or '' when it was not.
 *
 * Not flaresolverr.ts `solverUrl()`: that falls back to the development stack's `http://yomi-flaresolverr:8191`
 * so the built-in engines always have somewhere to ask, and offering to point someone's engine at a host that
 * exists on one development machine would be a fix that breaks it. Read on each call rather than once, so a
 * test can vary it; on desktop the shell sets it before the server starts (lib/desktop).
 */
export function ourSolverUrl(e: NodeJS.ProcessEnv = process.env): string {
  return (e.FLARESOLVERR_URL ?? '').trim();
}

/** A solver address in the one form two spellings of it can be compared in: no trailing slash, no `/v1`. */
function norm(u: string): string {
  let s = u.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
  try {
    const p = new URL(s);
    s = `${p.protocol}//${p.host.toLowerCase()}${p.pathname.replace(/\/+$/, '')}`;
  } catch { /* not a URL: compared as written */ }
  return s;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * How the engine's helper is wired, against `ours` (Uchiyomi's own FLARESOLVERR_URL, '' when unset).
 *
 * `desktop`: the desktop shell points the engine at the in-app helper on 127.0.0.1 on purpose, so localhost
 * there is the right answer and never `localhost` (it is `ok` when it is our own helper, `other` otherwise).
 */
export function solverWiring(s: EngineSolver, ours: string, desktop: boolean): SolverWiring {
  if (!s.supported) return 'unsupported';
  if (!s.enabled || !s.url.trim()) return 'off';
  if (ours && norm(s.url) === norm(ours)) return 'ok';
  if (!desktop) {
    let host = '';
    try { host = new URL(s.url.trim()).hostname.toLowerCase(); } catch { /* not a URL: not localhost either */ }
    if (LOCAL_HOSTS.has(host)) return 'localhost';
  }
  return 'other';
}

/** The host a solver address names, for the audit log: never the path, which on desktop carries a token. */
export function solverHost(u: string): string {
  try { return new URL(u).host; } catch { return ''; }
}
