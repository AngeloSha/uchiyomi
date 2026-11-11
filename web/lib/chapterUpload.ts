// Chapter files uploaded by hand (bff routes/upload.ts): for a series no source carries, whose chapters are
// already on the admin's own disk. One file per request, the file itself as the body, one after another.
import { api, ApiError, getCurrentUser } from './api';
import { t as tr } from './i18n';
import { refusalBody, requestFailure } from './libraryRefusals';

/** What the scanner reads as a chapter, for the file picker. The server checks it again, and the bytes too. */
export const CHAPTER_ACCEPT = '.cbz,.cbr,.zip,.rar,.pdf,.epub';

export interface Uploaded { file: string; seriesId?: string | null; bookId: string | null; number: number | null; indexed?: boolean }

/** Into a new series by its title (Uploads/<title> on the server). */
export type UploadTarget = { title: string; fresh: true; visibility?: 'shared' | 'private'; libraryId?: string } | { seriesId: string };

const urlFor = (to: UploadTarget, name: string): string =>
  `/api/library/upload?name=${encodeURIComponent(name)}&${'seriesId' in to
    ? `seriesId=${encodeURIComponent(to.seriesId)}`
    : `title=${encodeURIComponent(to.title)}&fresh=1${to.visibility ? `&visibility=${to.visibility}` : ''}${to.libraryId ? `&libraryId=${encodeURIComponent(to.libraryId)}` : ''}`}`;

export const uploadChapter = (to: UploadTarget, f: File, expectedOwnerId = getCurrentUser()): Promise<Uploaded> =>
  api<Uploaded>(urlFor(to, f.name), { method: 'POST', body: f, headers: { 'content-type': 'application/octet-stream' }, expectedOwnerId });

export const IMAGE_ACCEPT = '.jpg,.jpeg,.png,.webp,.gif,.avif';
export const IMAGE_MAX_PAGES = 2000;
/** Raster bytes only: a renamed SVG/HTML document never reaches the thumbnail decoder. Server validation is authoritative. */
export function isRasterPageHeader(bytes: Uint8Array): boolean {
  const at=(offset:number,text:string)=>bytes.length>=offset+text.length && [...text].every((c,i)=>bytes[offset+i]===c.charCodeAt(0));
  return bytes.length>=8 && (bytes[0]===0x89 && at(1,'PNG\r\n\x1a\n')
    || bytes[0]===0xff && bytes[1]===0xd8 && bytes[2]===0xff
    || at(0,'GIF87a') || at(0,'GIF89a') || at(0,'RIFF') && at(8,'WEBP')
    || at(4,'ftyp') && (at(8,'avif') || at(8,'avis') || [16,20,24,28,32,36,40,44,48,52,56,60].some(i=>at(i,'avif') || at(i,'avis'))));
}
const previewQueue: Array<{file:File;signal?:AbortSignal;done:(image:ImageBitmap|null)=>void}>=[];
let previewDecodes=0;
function drainPreviews() {
  while(previewDecodes<2 && previewQueue.length) {
    const request=previewQueue.shift()!;
    if(request.signal?.aborted){request.done(null);continue;}
    previewDecodes++;
    void (async()=>{
      try {
        if(request.file.size>64*1024*1024 || !isRasterPageHeader(new Uint8Array(await request.file.slice(0,64).arrayBuffer())) || request.signal?.aborted)return null;
        // Native resizing bounds each returned bitmap; at most two decoders run, even during a fast scroll.
        const image=await createImageBitmap(request.file,{resizeWidth:72,resizeHeight:96,resizeQuality:'high'});
        if(request.signal?.aborted){image.close();return null;}
        return image;
      } catch {return null;}
    })().then(request.done).finally(()=>{previewDecodes--;drainPreviews();});
  }
}
export function imagePreviewBitmap(file:File,signal?:AbortSignal):Promise<ImageBitmap|null> {
  if(typeof createImageBitmap!=='function' || signal?.aborted)return Promise.resolve(null);
  return new Promise(done=>{previewQueue.push({file,signal,done});drainPreviews();});
}

/** A folder denotes ONE chapter; flattening several nested chapter folders silently would lose chapter boundaries. */
export function orderedImagePages(files: File[]): { pages: File[]; ignored: number; multipleFolders: boolean; duplicateNames: boolean } {
  const pages = files.filter(f => /\.(jpe?g|png|webp|gif|avif)$/i.test(f.name)
    && !(f.webkitRelativePath || f.name).split('/').some(p => p.startsWith('.')));
  const parents = new Set(pages.map(f => (f.webkitRelativePath || '').split('/').slice(0, -1).join('/')).filter(Boolean));
  return { pages: pages.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true })), ignored: files.length - pages.length,
    multipleFolders: parents.size > 1, duplicateNames: new Set(pages.map(f => f.name.toLowerCase())).size !== pages.length };
}
export async function uploadImageChapter(to: UploadTarget, name: string, pages: File[], expectedOwnerId = getCurrentUser()): Promise<Uploaded> {
  const body = new FormData();
  for (const page of pages) body.append('pages', page, page.name);
  return api<Uploaded>(urlFor(to, name.replace(/\.cbz$/i, '') + '.cbz') + '&images=1', { method: 'POST', body, expectedOwnerId });
}

/** A refusal in the reader's words: the route answers with a code and an English message. */
export function uploadRefusal(e: unknown, name: string): string {
  const body = refusalBody(e);
  const code = body?.error;
  const page = typeof body?.page === 'string' ? body.page : null;
  if (code === 'taken') return tr('A series by that title is already here. Pick another title.');
  if (code === 'exists') return tr('{name} is already in this series.', { name });
  if (code === 'bad_type') return tr('{name} is not a .cbz, .cbr, .zip, .rar, .pdf or .epub file.', { name });
  if (code === 'bad_file') return tr('{name} is not the kind of file its name says.', { name });
  if (code === 'empty') return tr('{name} is empty.', { name });
  if (code === 'image_type') return tr('Choose JPG, PNG, WebP, GIF or AVIF pages.');
  if (code === 'invalid_page') return page ? tr('Could not read image “{page}”. No chapter was stored.', {page}) : tr('One of the images could not be read. No chapter was stored.');
  if (code === 'too_many_pages') return tr('A chapter can contain up to 2,000 images.');
  if (code === 'too_large' && page) return tr('Image “{page}” exceeds the upload size limit.', { page });
  if (code === 'too_large' || (e instanceof ApiError && e.status === 413)) return tr('{name} is too large to upload.', { name });
  if (code === 'disk_full') return tr('The download folder is out of space.');
  // The route's other refusals carry English sentences (#375): said here in the reader's words instead.
  // 409 busy: a merge or a repair holds the series; 429: two uploads are going already.
  if (code === 'busy' && e instanceof ApiError && e.status === 409) return tr('Another task is changing this series. Try again in a moment.');
  if (code === 'busy' || (e instanceof ApiError && e.status === 429)) return tr('Two uploads are already running. Try again when one finishes.');
  if (code === 'bad_path') return tr('{name} could not be stored at this destination. Check the file name and library folder.', { name });
  if (code === 'not_found') return tr('The series is no longer available. Refresh the page and choose a destination again.');
  if (code === 'private_backend_unsupported') return tr('This server does not support private uploads. Choose a shared library to upload a shared copy.');
  if (code === 'privacy_destination_conflict') return tr('A series with different visibility already uses this folder. Choose another title or destination.');
  if (code === 'bad_request') return tr('The upload request is invalid. Check the destination and files you selected.');
  if (code === 'unsupported_media_type' || (e instanceof ApiError && e.status === 415)) return tr('The server did not accept the upload format for {name}.', { name });
  if (code === 'forbidden' || (e instanceof ApiError && e.status === 403)) return tr('Your account does not have permission to upload to this destination.');
  const reason = requestFailure(e);
  if (reason) return tr('Could not upload {name}. {reason}', { name, reason });
  if (e instanceof ApiError && e.status >= 500) return tr('The server could not complete the upload of {name}. Check the series before retrying.', { name });
  return tr('Could not upload {name}. Check the destination and try again.', { name });
}

/** `failed` says why, in the reader's words; `failedFiles` names them, so the list keeps exactly those for another try. */
export interface UploadRun { done: number; failed: string[]; failedFiles: string[]; seriesId: string | null; taken?: boolean; cancelled?: boolean }

/**
 * Every file, one after another, in name order (Chapter 2 before Chapter 10 is the scanner's business: it reads the
 * number from the name). A refusal is kept and the run goes on, so one bad file does not cost the rest.
 */
export async function uploadAll(to: UploadTarget, files: File[], onFile?: (i: number, f: File) => void, expectedOwnerId = getCurrentUser()): Promise<UploadRun> {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const run: UploadRun = { done: 0, failed: [], failedFiles: [], seriesId: null };
  for (const [i, f] of sorted.entries()) {
    // Capture once for the whole queue: a later file must never inherit a newly active account.
    if (getCurrentUser() !== expectedOwnerId) { run.cancelled = true; break; }
    onFile?.(i, f);
    // A new series' title is checked on its first file only; the rest join what that one made.
    const here: UploadTarget = run.seriesId ? { seriesId: run.seriesId } : to;
    try {
      const r = await uploadChapter(here, f, expectedOwnerId);
      run.done++;
      if (r.seriesId) run.seriesId = r.seriesId;
      if (r.indexed === false) {
        run.failed.push(tr('{name} was stored, but indexing is pending. Run a library scan before retrying.', { name: f.name }));
        if (!run.seriesId) break;
      }
    } catch (e) {
      if (getCurrentUser() !== expectedOwnerId || e instanceof ApiError && e.status === 409 && /"account_changed"/.test(e.body)) { run.cancelled = true; break; }
      // A title already here stops the run: nothing of it was written, and the rest would only be refused too.
      if ('title' in here && here.fresh && e instanceof ApiError && e.status === 409 && e.body.includes('"taken"')) { run.taken = true; break; }
      run.failed.push(uploadRefusal(e, f.name));
      run.failedFiles.push(f.name);
    }
  }
  return run;
}
