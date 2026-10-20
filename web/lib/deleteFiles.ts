/**
 * Admin → Libraries → Delete files, the React-free half: what the toast says about the server's answer, so a test can
 * hold each sentence without a browser.
 *
 * The server (bff lib/libraryAdmin.ts deleteSeriesFiles) counts only a file that is not there as gone. One it may not
 * look at (EACCES from a folder's permissions, an I/O error) is left on disk with its chapter unmarked, and `unchecked`
 * counts it. A result with any is not a success: it names what was left and what to look at.
 */
import { t as tr } from './i18n';
import { uncheckedLine } from './rescan';

/** POST /api/admin/series/:id/delete-files. `unchecked` is absent from an older server's answer. */
export interface DeleteFilesResult { files: number; bytes: number; unchecked?: number }

/** The toast for a Delete files answer. A partial delete says what remains, an all-unchecked one with nothing deleted too. */
export function deleteFilesNotice(res: DeleteFilesResult): { message: string; type: 'success' | 'info' } {
  // Counted in pairs and translated (v0.52.0): "Deleted 1 file(s)" was the one English toast left on this panel.
  const size = `${(res.bytes / 1048576).toFixed(1)} MB`;
  const deleted = res.files === 1 ? tr('Deleted 1 file, {size}', { size }) : tr('Deleted {n} files, {size}', { n: res.files, size });
  return res.unchecked && res.unchecked > 0
    ? { message: `${deleted} · ${uncheckedLine(res.unchecked)}. ${tr("Check the folder's permissions.")}`, type: 'info' }
    : { message: deleted, type: 'success' };
}
