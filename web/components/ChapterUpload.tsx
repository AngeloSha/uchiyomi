'use client';
// Uploading chapter files by hand (lib/chapterUpload.ts): the Upload a series page, for a series that is not here yet.
import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { IcX } from './icons';
import { t as tr } from '@/lib/i18n';
import { CHAPTER_ACCEPT, IMAGE_ACCEPT, IMAGE_MAX_PAGES, orderedImagePages, imagePreviewBitmap, uploadImageChapter, uploadRefusal, uploadAll, type UploadRun, type UploadTarget } from '@/lib/chapterUpload';
import { useToast } from './Toast';
import { ProgressRing } from './ProgressRing';
import { ContentScopePicker, useContentScope } from './ContentScopePicker';
import { useAuth } from '@/lib/auth';
import { getCurrentUser } from '@/lib/api';

/** Run the files, saying how far along it is, and say how it went. */
function useUpload(onDone: (run: UploadRun) => void) {
  const ownerId = useAuth().user?.id ?? null;
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const toast = useToast();
  const qc = useQueryClient();
  const [at, setAt] = useState<{ i: number; n: number } | null>(null);
  const start = async (to: UploadTarget, files: File[], imageChapter?: string) => {
    if (!files.length || !mounted.current || !ownerId || getCurrentUser() !== ownerId) return;
    setAt({ i: 0, n: imageChapter ? 1 : files.length });
    let run: UploadRun;
    if (imageChapter) {
      try {
        const r = await uploadImageChapter(to, imageChapter, files, ownerId);
        run = { done: 1, failed: r.indexed === false ? [tr('{name} was stored, but indexing is pending. Run a library scan before retrying.', { name: imageChapter })] : [], failedFiles: [], seriesId: r.seriesId ?? null };
      } catch (error) { run = { done: 0, failed: [uploadRefusal(error, imageChapter)], failedFiles: files.map(f => f.name), seriesId: null }; }
    } else run = await uploadAll(to, files, (i) => setAt({ i, n: files.length }), ownerId);
    if (!mounted.current || getCurrentUser() !== ownerId || run.cancelled) return;
    setAt(null);
    // Everything that lists what was just stored: the series' own rows (its chapter list is `series-books`, not only its
    // listing), and the Library and Home a new series joins (#375). Without the chapter rows a fast upload left the
    // series page as it was until its cache aged out.
    if (run.seriesId) for (const k of [['series-listing', run.seriesId], ['series', run.seriesId], ['series-books', run.seriesId]]) qc.invalidateQueries({ queryKey: k });
    if (run.done) for (const k of [['library'], ['home']]) qc.invalidateQueries({ queryKey: k });
    if (run.done) toast(run.done === 1 ? tr('Uploaded 1 file') : tr('Uploaded {n} files', { n: run.done }), 'success');
    for (const m of run.failed) toast(m, 'error');
    onDone(run);
  };
  return { at, start };
}

function ImagePreview({ file }: { file: File }) {
  const canvas=useRef<HTMLCanvasElement>(null);
  useEffect(()=>{
    const target=canvas.current;if(!target)return;
    const cancelled=new AbortController();let started=false;
    const paint=()=>{
      if(started || cancelled.signal.aborted)return;started=true;
      void imagePreviewBitmap(file,cancelled.signal).then(image=>{
        if(!image)return;
        try {if(!cancelled.signal.aborted)target.getContext('2d')?.drawImage(image,0,0,72,96);}
        finally {image.close();}
      });
    };
    // A chapter can have 2,000 pages; decode only thumbnails near the visible scroll area.
    const observer=typeof IntersectionObserver==='undefined' ? null : new IntersectionObserver(entries=>{
      if(entries.some(entry=>entry.isIntersecting)){observer?.disconnect();paint();}
    },{rootMargin:'120px'});
    if(observer)observer.observe(target);else paint();
    return()=>{cancelled.abort();observer?.disconnect();};
  },[file]);
  return <canvas ref={canvas} width={72} height={96} aria-hidden="true" className="h-12 w-9 shrink-0 rounded bg-ink-800" />;
}

const progressText = (at: { i: number; n: number }) =>
  at.n === 1 ? tr('Uploading…') : tr('Uploading {i} of {n}…', { i: at.i + 1, n: at.n });

/** The Upload a series page (app/upload/page.tsx): a series that is not here yet, started from its files. Title and
 *  files in either order; Upload waits for both, and the server refuses a title already here. */
export function UploadSeriesSection({ seriesId, seriesTitle }: { seriesId?: string; seriesTitle?: string } = {}) {
  const uid = useId();
  const input = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null), folderInput = useRef<HTMLInputElement>(null);
  const scope = useContentScope();
  const toast = useToast();
  const [mode, setMode] = useState<'archives' | 'images'>('archives');
  const [images, setImages] = useState<File[]>([]);
  const [chapter, setChapter] = useState('');
  const [title, setTitle] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [made, setMade] = useState<{ id: string; title: string } | null>(null);
  const [takenTitle, setTakenTitle] = useState<string | null>(null);
  const { at, start } = useUpload((run) => {
    if (run.taken) setTakenTitle(title.trim());
    if (run.done && run.seriesId) {
      if (!made || made.id !== run.seriesId) setMade({ id: run.seriesId, title: seriesTitle || title.trim() || made?.title || '' });
      setTitle('');
    }
    // The files that were not stored stay listed, so a second try needs no picking again; the rest leave (#375).
    if (mode === 'archives' && (run.done || run.failedFiles.length)) setFiles((had) => had.filter((f) => run.failedFiles.includes(f.name)));
    if (mode === 'images' && run.done) { setImages([]); setChapter(''); }
  });
  const taken = !!takenTitle && takenTitle === title.trim();
  // A new series made by this page takes the next files, unless a new title was typed: a retry of the files that
  // failed goes into it rather than asking for its title again and being refused as taken.
  const into = seriesId || (!title.trim() && made ? made.id : '');
  const intoTitle = seriesId ? seriesTitle : made?.title;
  const ready = (!!into || (!!title.trim() && scope.ready)) && !taken && (mode === 'images' ? images.length > 0 && !!chapter.trim() : files.length > 0) && !at;
  const add = (more: File[]) => setFiles((had) => [...had, ...more.filter((f) => !had.some((h) => h.name === f.name))]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })));
  const addImages = (more: File[]) => {
    const picked = orderedImagePages(more);
    if (picked.multipleFolders) { toast(tr('Choose images from one chapter folder.'), 'error'); return; }
    const combined = orderedImagePages([...images, ...picked.pages]);
    if (combined.duplicateNames) { toast(tr('Some pages have the same name. Choose each page once.'), 'error'); return; }
    if (combined.pages.length > IMAGE_MAX_PAGES) { toast(tr('A chapter can contain up to 2,000 images.'), 'error'); return; }
    setImages(combined.pages);
    if (picked.ignored) toast(picked.ignored===1 ? tr('1 file left out (unsupported or hidden).') : tr('{n} files left out (unsupported or hidden).', { n: picked.ignored }), 'info');
  };
  const move = (at: number, by: number) => setImages(had => {
    const next = [...had], target = at + by;
    if (target >= 0 && target < next.length) [next[at], next[target]] = [next[target], next[at]];
    return next;
  });
  return (
    <section data-upload-series>
      <p className="mb-3 max-w-prose text-xs leading-relaxed text-fog-500">
        {into
          // Named, so the page says which series the files go into (#375): this series, or the one this page just made.
          ? (intoTitle ? tr('Add chapter files to “{title}”. Existing files are never overwritten. The chapter number is read from each file name.', { title: intoTitle })
            : tr('Add chapter files to this series. Existing files are never overwritten. The chapter number is read from each file name.'))
          : tr('For a series no source has, when you already have its chapters. The files go into the download folder, under Uploads, and the chapter number is read from each file name.')}
      </p>
      {!seriesId && <><label htmlFor={uid} className="mb-1 block text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Title')}</label>
      <input data-upload-title id={uid} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} dir="auto" disabled={!!at}
        placeholder={tr('Series title')} aria-invalid={taken || undefined} className="field w-full sm:max-w-md" />
      {taken && <p className="mt-1 text-xs text-red-400" role="alert">{tr('A series by that title is already here. Pick another title.')}</p>}</>}

      {!into && <div className="mt-3"><ContentScopePicker scope={scope} disabled={!!at} /></div>}
      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label={tr('Upload format')}>
        <button type="button" onClick={() => setMode('archives')} disabled={!!at} aria-pressed={mode === 'archives'} className={`chip text-xs ${mode === 'archives' ? 'chip-active' : ''}`}>{tr('Chapter files')}</button>
        <button type="button" onClick={() => setMode('images')} disabled={!!at} aria-pressed={mode === 'images'} className={`chip text-xs ${mode === 'images' ? 'chip-active' : ''}`}>{tr('Images as one chapter')}</button>
      </div>

      {mode === 'images' ? <div data-upload-images>
        <p className="mt-3 text-xs text-fog-400">{tr('Choose the pages of one chapter. Check their order before uploading; the images keep their original quality.')}</p>
        <label className="mt-3 block text-xs text-fog-400">{tr('Chapter name')}
          <input data-image-chapter-name value={chapter} onChange={e => setChapter(e.target.value)} disabled={!!at} maxLength={240} placeholder={tr('Chapter 7')} className="field mt-1 w-full" /></label>
        <input data-image-pick ref={imageInput} type="file" multiple accept={IMAGE_ACCEPT} hidden onChange={e => { addImages([...e.target.files ?? []]); e.target.value = ''; }} />
        <input ref={el => { folderInput.current = el; el?.setAttribute('webkitdirectory', ''); }} type="file" multiple accept={IMAGE_ACCEPT} hidden onChange={e => { addImages([...e.target.files ?? []]); e.target.value = ''; }} />
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={() => imageInput.current?.click()} disabled={!!at} className="btn-key">{tr('Choose images…')}</button>
          <button type="button" onClick={() => folderInput.current?.click()} disabled={!!at} className="chip text-xs">{tr('Choose chapter folder…')}</button>
          {!!images.length && <button type="button" onClick={() => setImages([])} disabled={!!at} className="chip text-xs">{tr('Clear all')}</button>}
        </div>
        {!!images.length && <ol className="mt-3 max-h-96 divide-y divide-ink-700 overflow-auto rounded-xl border border-ink-700" data-lenis-prevent data-image-pages>
          {images.map((file, i) => <li key={file.name} className="flex items-center gap-2 p-2 text-xs">
            <span className="w-6 shrink-0 text-fog-500">{i + 1}</span><ImagePreview file={file} /><bdi className="min-w-0 flex-1 truncate">{file.name}</bdi>
            <button type="button" data-image-up onClick={() => move(i, -1)} disabled={!!at || i === 0} aria-label={tr('Move page up')} className="chip">↑</button>
            <button type="button" data-image-down onClick={() => move(i, 1)} disabled={!!at || i === images.length - 1} aria-label={tr('Move page down')} className="chip">↓</button>
            <button type="button" onClick={() => setImages(had => had.filter(f => f !== file))} disabled={!!at} aria-label={tr('Remove')} className="chip">×</button>
          </li>)}
        </ol>}
      </div> : <>

      <input ref={input} type="file" multiple accept={CHAPTER_ACCEPT} hidden
        onChange={(e) => { const more = [...(e.target.files ?? [])]; e.target.value = ''; add(more); }} />
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => input.current?.click()} disabled={!!at} className="btn-key">{tr('Choose files…')}</button>
        {files.length > 0 && !at && <button type="button" onClick={() => setFiles([])} className="chip text-xs">{tr('Clear all')}</button>}
      </div>
      {files.length > 0 && (
        <ul className="mt-3 divide-y divide-ink-700 rounded-xl border border-ink-700" data-upload-files>
          {files.map((f) => (
            <li key={f.name} className="flex items-center gap-2 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-fog-200" dir="auto">{f.name}</span>
              {!at && (
                <button type="button" onClick={() => setFiles((had) => had.filter((h) => h !== f))} aria-label={tr('Remove')}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-fog-500 hover:text-fog-100"><IcX width={14} height={14} /></button>
              )}
            </li>
          ))}
        </ul>
      )}
      </>}

      <button type="button" onClick={() => void start(into ? { seriesId: into } : { title: title.trim(), fresh: true, visibility: scope.visibility }, mode === 'images' ? images : files, mode === 'images' ? chapter.trim() : undefined)} disabled={!ready} className="btn-accent mt-4 w-full sm:w-auto disabled:opacity-50" data-upload-start>
        {at && <ProgressRing progress="spin" size={14} />}
        {at ? progressText(at) : tr('Upload')}
      </button>
      {made && (
        <p className="mt-3 text-xs text-fog-400">
          <Link href={`/series/?id=${encodeURIComponent(made.id)}`} className="text-accent underline-offset-2 hover:underline">
            {tr('Open “{title}”', { title: made.title })}
          </Link>
        </p>
      )}
    </section>
  );
}
