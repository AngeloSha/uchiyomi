import { api, ApiError, getCurrentUser } from './api';
import { errorPayload, redactDiagnostic } from './errorDetails';
import { t as tr } from './i18n';
import { requestFailure } from './refusals';

export interface MoveLibraryOptions { confirmVisibilityChange?: true; expectedOwnerId?: string | null }
export interface MoveLibraryResult { applied: number; skipped: { id: string; reason?: string; message?: string }[] }
export interface VisibilityConfirmation { visibility: 'private' | 'shared'; count: number }
export interface LibraryDestination { id: string; name: string; path: string; paths?: string[]; age_rating: number | null; managed_private?: boolean }

/** Only a real 409 with this exact shape may offer the explicit visibility retry. */
export function moveVisibilityConfirmation(error: unknown): VisibilityConfirmation | null {
  const body = errorPayload(error);
  return error instanceof ApiError && error.status === 409 && body?.error === 'visibility_confirmation_required'
    && (body.visibility === 'private' || body.visibility === 'shared') && Number.isSafeInteger(body.count) && Number(body.count) > 0
    ? { visibility: body.visibility, count: Number(body.count) } : null;
}

/** Single and bulk filing use the same body; confirmation is never added to the first attempt. */
export async function moveSeriesToLibrary(seriesIds: readonly string[], libraryId: string | null, options: MoveLibraryOptions = {}): Promise<MoveLibraryResult> {
  const ids = [...new Set(seriesIds)];
  if (!ids.length) return { applied: 0, skipped: [] };
  const json = { libraryId, ...(options.confirmVisibilityChange === true ? { confirmVisibilityChange: true } : {}) };
  const response = await api<MoveLibraryResult>(ids.length === 1 ? `/api/admin/series/${encodeURIComponent(ids[0])}/library` : '/api/admin/series/library', {
    method: 'POST', json: ids.length === 1 ? json : { ...json, seriesIds: ids },
    expectedOwnerId: options.expectedOwnerId === undefined ? getCurrentUser() : options.expectedOwnerId,
  });
  return { applied: Number.isInteger(response.applied) ? response.applied : ids.length === 1 ? 1 : 0, skipped: response.skipped ?? [] };
}

/** Never mark a mixed or partly unloaded bulk selection as belonging to one library. */
export function currentSelectionLibrary(ids: ReadonlySet<string>, items: readonly { id: string; libraryId: string }[]): string | undefined {
  if (!ids.size) return undefined;
  const selected = items.filter((item) => ids.has(item.id));
  if (selected.length !== ids.size) return undefined;
  const first = selected[0].libraryId;
  return selected.every((item) => item.libraryId === first) ? first : undefined;
}

export function moveLibrarySummary(result: MoveLibraryResult): string {
  const updated = result.applied === 1 ? tr('1 series updated') : tr('{n} series updated', { n: result.applied });
  return result.skipped.length ? `${updated} · ${result.skipped.length === 1 ? tr('1 skipped') : tr('{n} skipped', { n: result.skipped.length })}` : updated;
}

export function moveLibraryRefusal(error: unknown): string {
  const failure = requestFailure(error);
  if (failure) return failure;
  const body = errorPayload(error) ?? (error && typeof error === 'object' ? error as Record<string, unknown> : null);
  const code = typeof error === 'string' ? error : body?.error ?? body?.reason;
  if (code === 'busy') return tr('This series is busy. Try again after its current task finishes.');
  if (code === 'privacy_copy_required' || code === 'unsafe_files') return tr('These files cannot be moved safely.');
  if (code === 'admin_cleanup_required') return tr('Restore this series before filing it.');
  if (code === 'privacy_destination_conflict') return tr('That library already contains a copy of this series.');
  if (code === 'edition_privacy_conflict') return tr('Unlink editions before changing visibility.');
  if (code === 'forbidden') return tr('Only the owner can change this series’ visibility.');
  if (code === 'not_found') return tr('That series is no longer available to this account.');
  if (code === 'catalogue_changed') return tr('The series changed. Please try again.');
  return typeof body?.message === 'string' && body.message.length <= 1000 ? redactDiagnostic(body.message) : tr('Could not apply that');
}
