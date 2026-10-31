// Chapter files an admin uploads by hand (bff routes/upload.ts): for a series no source carries, whose chapters are
// already on the admin's own disk. One file per request, the file itself as the body, one after another.
import { api, ApiError } from './api';
import { t as tr } from './i18n';

/** What the scanner reads as a chapter, for the file picker. The server checks it again, and the bytes too. */
export const CHAPTER_ACCEPT = '.cbz,.cbr,.zip,.rar,.pdf,.epub';

export interface Uploaded { file: string; seriesId?: string | null; bookId: string | null; number: number | null }

/** Into an existing series, or into a new one by its title (Uploads/<title> on the server). */
export type UploadTarget = { seriesId: string } | { title: string; fresh?: boolean };

const urlFor = (to: UploadTarget, name: string): string =>
  'seriesId' in to
    ? `/api/admin/series/${encodeURIComponent(to.seriesId)}/upload?name=${encodeURIComponent(name)}`
    : `/api/library/upload?title=${encodeURIComponent(to.title)}&name=${encodeURIComponent(name)}${to.fresh ? '&fresh=1' : ''}`;

export const uploadChapter = (to: UploadTarget, f: File): Promise<Uploaded> =>
  api<Uploaded>(urlFor(to, f.name), { method: 'POST', body: f, headers: { 'content-type': 'application/octet-stream' } });

/** A refusal in the reader's words: the route answers with a code and an English message. */
export function uploadRefusal(e: unknown, name: string): string {
  let code: string | null = null;
  let message: string | null = null;
  try {
    const b = e instanceof ApiError ? JSON.parse(e.body) : null;
    code = b?.error ?? null;
    message = b?.message ?? null;
  } catch { /* not JSON: the plain failure */ }
  if (code === 'taken') return tr('A series by that title is already here. Pick another title.');
  if (code === 'exists') return tr('{name} is already in this series.', { name });
  if (code === 'bad_type') return tr('{name} is not a .cbz, .cbr, .zip, .rar, .pdf or .epub file.', { name });
  if (code === 'bad_file') return tr('{name} is not the kind of file its name says.', { name });
  if (code === 'empty') return tr('{name} is empty.', { name });
  if (code === 'too_large' || (e instanceof ApiError && e.status === 413)) return tr('{name} is too large to upload.', { name });
  if (code === 'disk_full') return tr('The download folder is out of space.');
  if (message) return message;
  return tr('Could not upload {name}', { name });
}

export interface UploadRun { done: number; failed: string[]; seriesId: string | null; taken?: boolean }

/**
 * Every file, one after another, in name order (Chapter 2 before Chapter 10 is the scanner's business: it reads the
 * number from the name). A refusal is kept and the run goes on, so one bad file does not cost the rest.
 */
export async function uploadAll(to: UploadTarget, files: File[], onFile?: (i: number, f: File) => void): Promise<UploadRun> {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const run: UploadRun = { done: 0, failed: [], seriesId: 'seriesId' in to ? to.seriesId : null };
  for (const [i, f] of sorted.entries()) {
    onFile?.(i, f);
    // A new series' title is checked on its first file only; the rest join what that one made.
    const here = 'title' in to && i > 0 ? { title: to.title } : to;
    try {
      const r = await uploadChapter(here, f);
      run.done++;
      if (r.seriesId) run.seriesId = r.seriesId;
    } catch (e) {
      // A title already here stops the run: nothing of it was written, and the rest would only be refused too.
      if (i === 0 && 'title' in to && to.fresh && e instanceof ApiError && e.status === 409 && e.body.includes('"taken"')) { run.taken = true; break; }
      run.failed.push(uploadRefusal(e, f.name));
    }
  }
  return run;
}
