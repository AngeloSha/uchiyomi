// Chapter files uploaded by hand (bff routes/upload.ts): for a series no source carries, whose chapters are
// already on the admin's own disk. One file per request, the file itself as the body, one after another.
import { api, ApiError } from './api';
import { t as tr } from './i18n';

/** What the scanner reads as a chapter, for the file picker. The server checks it again, and the bytes too. */
export const CHAPTER_ACCEPT = '.cbz,.cbr,.zip,.rar,.pdf,.epub';

export interface Uploaded { file: string; seriesId?: string | null; bookId: string | null; number: number | null; indexed?: boolean }

/** Into a new series by its title (Uploads/<title> on the server). */
export type UploadTarget = { title: string; fresh: true; visibility?: 'shared' | 'private'; libraryId?: string } | { seriesId: string };

const urlFor = (to: UploadTarget, name: string): string =>
  `/api/library/upload?name=${encodeURIComponent(name)}&${'seriesId' in to
    ? `seriesId=${encodeURIComponent(to.seriesId)}`
    : `title=${encodeURIComponent(to.title)}&fresh=1${to.visibility ? `&visibility=${to.visibility}` : ''}${to.libraryId ? `&libraryId=${encodeURIComponent(to.libraryId)}` : ''}`}`;

export const uploadChapter = (to: UploadTarget, f: File): Promise<Uploaded> =>
  api<Uploaded>(urlFor(to, f.name), { method: 'POST', body: f, headers: { 'content-type': 'application/octet-stream' } });

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
export async function uploadImageChapter(to: UploadTarget, name: string, pages: File[]): Promise<Uploaded> {
  const body = new FormData();
  for (const page of pages) body.append('pages', page, page.name);
  return api<Uploaded>(urlFor(to, name.replace(/\.cbz$/i, '') + '.cbz') + '&images=1', { method: 'POST', body });
}

/** A refusal in the reader's words: the route answers with a code and an English message. */
export function uploadRefusal(e: unknown, name: string): string {
  let code: string | null = null;
  let message: string | null = null;
  let page: string | null = null;
  try {
    const b = e instanceof ApiError ? JSON.parse(e.body) : null;
    code = b?.error ?? null;
    message = b?.message ?? null;
    page = typeof b?.page === 'string' ? b.page : null;
  } catch { /* not JSON: the plain failure */ }
  if (code === 'taken') return tr('A series by that title is already here. Pick another title.');
  if (code === 'exists') return tr('{name} is already in this series.', { name });
  if (code === 'bad_type') return tr('{name} is not a .cbz, .cbr, .zip, .rar, .pdf or .epub file.', { name });
  if (code === 'bad_file') return tr('{name} is not the kind of file its name says.', { name });
  if (code === 'empty') return tr('{name} is empty.', { name });
  if (code === 'image_type') return tr('Choose JPG, PNG, WebP, GIF or AVIF pages.');
  if (code === 'invalid_page') return page ? tr('Could not read image “{page}”. No chapter was stored.', {page}) : tr('One of the images could not be read. No chapter was stored.');
  if (code === 'too_many_pages') return tr('A chapter can contain up to 2,000 images.');
  if (code === 'too_large' || (e instanceof ApiError && e.status === 413)) return tr('{name} is too large to upload.', { name });
  if (code === 'disk_full') return tr('The download folder is out of space.');
  // The route's other refusals carry English sentences (#375): said here in the reader's words instead.
  // 409 busy: a merge or a repair holds the series; 429: two uploads are going already.
  if (code === 'busy' && e instanceof ApiError && e.status === 409) return tr('Another task is changing this series. Try again in a moment.');
  if (code === 'busy' || (e instanceof ApiError && e.status === 429)) return tr('Two uploads are already running. Try again when one finishes.');
  if (code === 'forbidden' || (e instanceof ApiError && e.status === 403)) return tr('Your account is not allowed to upload series.');
  if (code) return tr('Could not upload {name}', { name });
  if (message) return message;
  return tr('Could not upload {name}', { name });
}

/** `failed` says why, in the reader's words; `failedFiles` names them, so the list keeps exactly those for another try. */
export interface UploadRun { done: number; failed: string[]; failedFiles: string[]; seriesId: string | null; taken?: boolean }

/**
 * Every file, one after another, in name order (Chapter 2 before Chapter 10 is the scanner's business: it reads the
 * number from the name). A refusal is kept and the run goes on, so one bad file does not cost the rest.
 */
export async function uploadAll(to: UploadTarget, files: File[], onFile?: (i: number, f: File) => void): Promise<UploadRun> {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const run: UploadRun = { done: 0, failed: [], failedFiles: [], seriesId: null };
  for (const [i, f] of sorted.entries()) {
    onFile?.(i, f);
    // A new series' title is checked on its first file only; the rest join what that one made.
    const here: UploadTarget = run.seriesId ? { seriesId: run.seriesId } : to;
    try {
      const r = await uploadChapter(here, f);
      run.done++;
      if (r.seriesId) run.seriesId = r.seriesId;
      if (r.indexed === false) {
        run.failed.push(tr('{name} was stored, but indexing is pending. Run a library scan before retrying.', { name: f.name }));
        if (!run.seriesId) break;
      }
    } catch (e) {
      // A title already here stops the run: nothing of it was written, and the rest would only be refused too.
      if ('title' in here && here.fresh && e instanceof ApiError && e.status === 409 && e.body.includes('"taken"')) { run.taken = true; break; }
      run.failed.push(uploadRefusal(e, f.name));
      run.failedFiles.push(f.name);
    }
  }
  return run;
}
