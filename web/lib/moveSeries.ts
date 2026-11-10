import { api, ApiError } from './api';

/** A managed private library's id is `private_<owner uuid>` (bff/src/lib/contentScope.ts ensurePrivateLibrary). */
const PRIVATE_LIB = /^private_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export const privateOwnerOf = (libraryId: string | null): string | null => (libraryId && PRIVATE_LIB.exec(libraryId)?.[1]) || null;

/**
 * Admin: file one series into a library. A private library is not a plain re-file (the server answers
 * use_privacy_action there): its files move into the owner's private folder, which make-private does.
 */
export async function moveSeriesToLibrary(seriesId: string, libraryId: string | null): Promise<void> {
  const owner = privateOwnerOf(libraryId);
  const id = encodeURIComponent(seriesId);
  if (owner) { await api(`/api/admin/series/${id}/make-private`, { method: 'POST', json: { userId: owner } }); return; }
  try { await api(`/api/admin/series/${id}/library`, { method: 'POST', json: { libraryId } }); }
  catch (e) {
    // The series itself is private: going to a shared library publishes it, which moves its folder out too.
    if (!libraryId || !usePrivacyAction(e)) throw e;
    await api(`/api/admin/series/${id}/make-shared`, { method: 'POST', json: { libraryId } });
  }
}

const usePrivacyAction = (e: unknown): boolean =>
  e instanceof ApiError && e.status === 409 && /"use_privacy_action"/.test(e.body);

/** The bulk form. Private targets go one by one, since each is a folder move on disk. */
export async function moveManyToLibrary(seriesIds: string[], libraryId: string | null): Promise<{ applied: number; skipped: { id: string }[] }> {
  if (!privateOwnerOf(libraryId)) {
    try { return await api('/api/admin/series/library', { method: 'POST', json: { seriesIds, libraryId } }); }
    catch (e) { if (!libraryId || !usePrivacyAction(e)) throw e; } // a private series in the selection: one by one below
  }
  let applied = 0;
  const skipped: { id: string }[] = [];
  for (const id of seriesIds) {
    try { await moveSeriesToLibrary(id, libraryId); applied++; } catch { skipped.push({ id }); }
  }
  if (!applied) throw new Error('move_failed');
  return { applied, skipped };
}
