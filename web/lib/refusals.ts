import { ApiError } from './api';
import { t as tr } from './i18n';

export function refusalBody(error: unknown): { error?: string; page?: string } | null {
  if (!(error instanceof ApiError)) return null;
  try {
    return JSON.parse(error.body);
  } catch {
    return null;
  }
}

export function requestFailure(error: unknown): string | undefined {
  if (error instanceof TypeError) return tr('The connection to the server failed. Check your connection and try again.');
  if (!(error instanceof ApiError)) return;
  if (error.status === 401) return tr('Your session has expired. Sign in again and retry.');
  if (error.status === 502 || error.status === 503 || error.status === 504) {
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
