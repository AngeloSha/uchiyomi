import { ApiError } from './api';
import { errorPayload } from './errorDetails';
import { t as tr } from './i18n';

/** A refused request's JSON body (lib/errorDetails.ts errorPayload), for an ApiError only. */
export function refusalBody(error: unknown): { error?: string; page?: string; message?: string } | null {
  return error instanceof ApiError ? errorPayload(error) as { error?: string; page?: string; message?: string } | null : null;
}

/**
 * A request that failed on its way, said the same way everywhere (#435): no answer, an expired session, or a gateway's
 * outage page. Undefined when the server gave a reason of its own, which the caller says instead.
 */
export function requestFailure(error: unknown): string | undefined {
  // fetch's own network error and only that one: any other TypeError is a bug in the caller's code, and "check your
  // connection" would send someone to their router for it.
  if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) return tr('The connection to the server failed. Check your connection and try again.');
  if (!(error instanceof ApiError)) return;
  if (error.status === 401) return tr('Your session has expired. Sign in again and retry.');
  // A proxy's 502/503/504 page carries no reason. The server's own 502/503 does (an extension engine, a tracker, a
  // sign-in provider), and that reason is the one to show.
  const body = refusalBody(error);
  if ((error.status === 502 || error.status === 503 || error.status === 504) && !body?.error && !body?.message) {
    return tr('The server is temporarily unavailable. Try again in a moment.');
  }
}

export function downloadCancelRefusal(error: unknown): string {
  switch (refusalBody(error)?.error) {
    case 'not_found': return tr('This download is no longer in the queue.');
    case 'not_running': return tr('This download is no longer running.');
    case 'forbidden': return tr('Only the person who started this download or an admin can cancel it.');
  }
  return requestFailure(error) ?? tr('Could not cancel this download. Try again.');
}
