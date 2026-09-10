/**
 * The opt-in install count.
 *
 * Self-hosted software cannot see its own users, which is the point of it -- so nobody, including whoever
 * wrote it, knows whether a release reached twenty people or two hundred. This is the smallest honest way
 * to find out, and every decision in this file is about keeping it small and honest rather than useful.
 *
 * ⚠️ OFF UNLESS AN ADMIN TURNS IT ON. Not off-by-default-in-the-docs: `install_ping` defaults to false in
 * the schema, this returns early when it is false, and the secret the id derives from is not even generated
 * until somebody opts in. A server that never opts in has nothing to send and nothing to send it with.
 *
 * ⚠️ IT IS A SEPARATE SWITCH FROM THE UPDATE CHECK, AND MUST STAY ONE. The update check reads a public
 * GitHub URL (see githubRelease.ts) and tells us nothing. If the update check pointed at a server we run,
 * we could count installs from its access log whether or not anyone consented, and "the count is off" would
 * be a lie told by the settings page. Two switches, two destinations, is what makes the off position real.
 *
 * WHAT IS SENT is exactly `buildPayload()` below and nothing else -- the settings page renders the output of
 * that same function, so what an admin is shown before consenting is the literal object that will be sent,
 * not a description of it that could drift. `payloadKeys.test.ts` fails if a field is ever added.
 */
import { createHash, randomBytes } from 'node:crypto';

/**
 * Where the count is collected, as shipped.
 *
 * Separate from `PING_URL` so it can be asserted on regardless of the environment a test runs in -- CI sets
 * `UCHIYOMI_PING_URL` empty so no suite can ping the real collector, which would otherwise make the
 * "this is not the update-check host" check pass for the wrong reason.
 */
export const DEFAULT_PING_URL = 'https://uchiyomi.com/api/hello';

/** Where this install would send it. Overridable so a fork can point elsewhere; empty disables sending. */
export const PING_URL = process.env.UCHIYOMI_PING_URL ?? DEFAULT_PING_URL;

/** Short, because a hanging endpoint must not hold a background job open. */
const TIMEOUT_MS = 5000;

export interface InstallFacts {
  version: string | null;
  arch: string;
  /** `aio` = the single all-in-one image, `split` = separate web/bff containers. */
  layout: 'aio' | 'split';
  /** `embedded` = the Postgres the image runs itself, `external` = one the operator supplied. */
  db: 'embedded' | 'external';
}

export interface PingPayload extends InstallFacts {
  /** The rotating monthly id. See `monthlyId`. */
  id: string;
  month: string;
}

/**
 * The id this install reports under, which changes every month and cannot be linked across months.
 *
 * `sha256(secret + month)`, where the secret never leaves the server. Two pings in the same month share an
 * id, so installs can be counted rather than merely pings; two pings in different months do not, so an
 * install cannot be followed over time. The collector could not undo this even if it wanted to: without the
 * secret there is nothing to correlate, and the secret is not in the payload.
 *
 * ⚠️ The month MUST go through the hash rather than be concatenated onto a stable id. Reintroduce by
 * sending the raw secret (or a hash of the secret alone) and the id becomes permanent -- the thing this
 * design exists to avoid, invisible from the outside because the payload looks identical.
 */
export function monthlyId(secret: string, now = new Date()): string {
  const month = now.toISOString().slice(0, 7); // YYYY-MM, UTC
  return createHash('sha256').update(`${secret}:${month}`).digest('hex').slice(0, 32);
}

/** The month a `monthlyId` was minted for, sent alongside so the collector need not guess at a boundary. */
export function currentMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** A fresh per-install secret. Generated on opt-in, never sent, thrown away on opt-out. */
export function newSecret(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Which shape of install this is.
 *
 * Both are heuristics over how the image starts itself, and deliberately coarse. `WEB_ROOT` is set only by
 * Dockerfile.aio; the entrypoint points `DATABASE_URL` at a unix socket when it runs its own Postgres, and
 * a socket url has no hostname. Neither can identify anybody: there are two possible answers to each.
 */
export function installFacts(version: string | null, env: NodeJS.ProcessEnv = process.env, arch = process.arch): InstallFacts {
  // ⚠️ NOT `new URL()`. The entrypoint writes `postgres://yomi@/yomi?host=/run/postgresql` for the embedded
  // case, and WHATWG URL REJECTS that outright -- a non-special scheme with an empty host is invalid, so it
  // throws rather than reporting an empty hostname, and every install would have been labelled `external`.
  // Match the authority directly instead: no host between the `//` (past any user info) and the path.
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/?#]*)/i.exec((env.DATABASE_URL ?? '').trim());
  const db: 'embedded' | 'external' = m && m[1] === '' ? 'embedded' : 'external';
  return { version, arch, layout: env.WEB_ROOT ? 'aio' : 'split', db };
}

/**
 * Everything that will be sent, and the only thing that will be sent.
 *
 * ⚠️ THIS IS THE CONSENT SURFACE. `GET /api/admin/install-ping/preview` returns exactly this so the
 * settings page can show it verbatim before anyone agrees to it. A field added here is a field an admin
 * consented to without being shown, which is why payloadKeys.test.ts pins the key list.
 */
export function buildPayload(secret: string, facts: InstallFacts, now = new Date()): PingPayload {
  return { id: monthlyId(secret, now), month: currentMonth(now), ...facts };
}

/** Send one ping. Never throws; the caller has nothing to do about a failure and neither do we. */
export async function sendPing(payload: PingPayload, url = PING_URL): Promise<boolean> {
  if (!url) return false;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'uchiyomi' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Ask the collector to forget this month's id, on opt-out.
 *
 * ⚠️ Best effort, and the settings page must not pretend otherwise: if the request fails the row expires on
 * its own when the month rolls over, because the id cannot be regenerated without the secret we are about
 * to discard. Turning it off always stops the sending, which is the part we actually control.
 */
export async function sendForget(id: string, url = PING_URL): Promise<boolean> {
  if (!url) return false;
  try {
    const r = await fetch(url, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', 'user-agent': 'uchiyomi' },
      body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return r.ok;
  } catch {
    return false;
  }
}
