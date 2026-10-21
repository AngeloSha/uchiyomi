/**
 * Admin → Libraries → Delete files, the React-free half: what the toast says about the server's answer, so a test can
 * hold each sentence without a browser.
 *
 * The server (bff lib/libraryAdmin.ts deleteSeriesFiles) counts only a file that is not there as gone. One it may not
 * look at (EACCES from a folder's permissions, an I/O error) is left on disk with its chapter unmarked, and `unchecked`
 * counts it. A result with any is not a success: it names what was left and what to look at.
 *
 * A file already gone is marked only on a library the server can prove is there (#328); the rest come back as
 * `unproven`, and the panel asks the admin whether they deleted or moved them (notOnDiskTitle).
 */
import { t as tr } from './i18n';
import { uncheckedLine } from './rescan';

/**
 * POST /api/admin/series/:id/delete-files. `unchecked` is absent from an older server's answer, and so are `gone` (rows
 * whose file was already absent, marked deleted now) and `unproven` (rows whose file is absent on a root the server
 * cannot prove is there, left as they were), both v0.95.0 (#328).
 */
export interface DeleteFilesResult { files: number; bytes: number; unchecked?: number; gone?: number; unproven?: number }

/** The toast for a Delete files answer. A partial delete says what remains, an all-unchecked one with nothing deleted too. */
export function deleteFilesNotice(res: DeleteFilesResult): { message: string; type: 'success' | 'info' } {
  // Counted in pairs and translated (v0.52.0): "Deleted 1 file(s)" was the one English toast left on this panel.
  const size = `${(res.bytes / 1048576).toFixed(1)} MB`;
  const deleted = res.files === 1 ? tr('Deleted 1 file, {size}', { size }) : tr('Deleted {n} files, {size}', { n: res.files, size });
  if (res.unchecked && res.unchecked > 0) {
    return { message: `${deleted} · ${uncheckedLine(res.unchecked)}. ${tr("Check the folder's permissions.")}`, type: 'info' };
  }
  // A folder deleted by hand (#328): "Deleted 0 files" in green read as nothing having happened, while its chapters were
  // just marked and Forget is offered next.
  if (!res.files && res.gone) return { message: tr('Its files were already gone. Its chapters are marked deleted.'), type: 'success' };
  return { message: deleted, type: 'success' };
}

/**
 * The question after a Delete files answer with `unproven` rows (#328): their files are not on disk, and the server cannot
 * tell a folder deleted by hand from a drive that is not connected. Its title, counted in a pair.
 */
export function notOnDiskTitle(n: number): string {
  return n === 1 ? tr('1 chapter file is not on disk') : tr('{n} chapter files are not on disk', { n });
}
