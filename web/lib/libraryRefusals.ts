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

export function libraryMoveRefusal(error: unknown, selected: number): string {
  switch (refusalBody(error)?.error) {
    case 'use_privacy_action':
      return tr('This move involves a private series or library. Use Change visibility on the series page.');
    case 'no_such_library':
      return tr('The destination library no longer exists. Refresh the library list and choose another.');
    case 'not_found':
      return tr('This series is no longer in the library. Refresh the page and try again.');
    case 'bad_request':
      return selected > 500
        ? tr('Select up to 500 series at a time.')
        : tr('The selection or destination is invalid. Refresh the page and choose again.');
    case 'account_changed':
      return tr('The active account changed. Try again from the current account.');
  }
  if (error instanceof ApiError && error.status === 403) return tr('Only an admin can move series between libraries.');
  return requestFailure(error) ?? tr('The library assignment could not be updated. Try again.');
}
