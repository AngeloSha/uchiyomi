'use client';
// Uploading chapter files by hand (lib/chapterUpload.ts): Edit details → Files for a series already here, and the
// Upload a series page for a series that is not here yet.
import { useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { IcX } from './icons';
import { t as tr } from '@/lib/i18n';
import { CHAPTER_ACCEPT, uploadAll, type UploadRun, type UploadTarget } from '@/lib/chapterUpload';
import { useToast } from './Toast';
import { ProgressRing } from './ProgressRing';
import { Row } from './settings';

/** Run the files, saying how far along it is, and say how it went. */
function useUpload(onDone: (run: UploadRun) => void) {
  const toast = useToast();
  const qc = useQueryClient();
  const [at, setAt] = useState<{ i: number; n: number } | null>(null);
  const start = async (to: UploadTarget, files: File[]) => {
    if (!files.length) return;
    setAt({ i: 0, n: files.length });
    const run = await uploadAll(to, files, (i) => setAt({ i, n: files.length }));
    setAt(null);
    if (run.seriesId) for (const k of [['series-listing', run.seriesId], ['series', run.seriesId]]) qc.invalidateQueries({ queryKey: k });
    if (run.done) toast(run.done === 1 ? tr('Uploaded 1 file') : tr('Uploaded {n} files', { n: run.done }), 'success');
    for (const m of run.failed) toast(m, 'error');
    onDone(run);
  };
  return { at, start };
}

const progressText = (at: { i: number; n: number }) =>
  at.n === 1 ? tr('Uploading…') : tr('Uploading {i} of {n}…', { i: at.i + 1, n: at.n });

/** Edit details → Files: chapter files from the admin's own disk, into this series' folder. */
export function UploadChaptersRow({ seriesId, onSaved }: { seriesId: string; onSaved: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const { at, start } = useUpload((run) => { if (run.done) onSaved(); });
  return (
    <Row label={tr('Upload chapters')} stacked
      help={tr('Chapter files you already have: .cbz, .cbr, .zip, .rar, .pdf or .epub. The chapter number is read from each file name, as in “Chapter 12.cbz”.')}>
      <input ref={input} type="file" multiple accept={CHAPTER_ACCEPT} hidden data-upload-chapters
        onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ''; void start({ seriesId }, files); }} />
      <button type="button" onClick={() => input.current?.click()} disabled={!!at} className="btn-key">
        {at && <ProgressRing progress="spin" size={14} />}
        {at ? progressText(at) : tr('Choose files…')}
      </button>
    </Row>
  );
}

/** The Upload a series page (app/upload/page.tsx): a series that is not here yet, started from its files. Title and
 *  files in either order; Upload waits for both, and the server refuses a title already here. */
export function UploadSeriesSection() {
  const uid = useId();
  const input = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [made, setMade] = useState<{ id: string; title: string } | null>(null);
  const [takenTitle, setTakenTitle] = useState<string | null>(null);
  const { at, start } = useUpload((run) => {
    if (run.taken) setTakenTitle(title.trim());
    if (run.done && run.seriesId) { setMade({ id: run.seriesId, title: title.trim() }); setTitle(''); setFiles([]); }
  });
  const taken = !!takenTitle && takenTitle === title.trim();
  const ready = !!title.trim() && !taken && files.length > 0 && !at;
  const add = (more: File[]) => setFiles((had) => [...had, ...more.filter((f) => !had.some((h) => h.name === f.name))]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })));
  return (
    <section data-upload-series>
      <p className="mb-3 max-w-prose text-xs leading-relaxed text-fog-500">
        {tr('For a series no source has, when you already have its chapters. The files go into the download folder, under Uploads, and the chapter number is read from each file name.')}
      </p>
      <label htmlFor={uid} className="mb-1 block text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Title')}</label>
      <input id={uid} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} dir="auto" disabled={!!at}
        placeholder={tr('Series title')} aria-invalid={taken || undefined} className="field w-full sm:max-w-md" />
      {taken && <p className="mt-1 text-xs text-red-400" role="alert">{tr('A series by that title is already here. Pick another title.')}</p>}

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

      <button type="button" onClick={() => void start({ title: title.trim(), fresh: true }, files)} disabled={!ready} className="btn-accent mt-4 w-full sm:w-auto disabled:opacity-50" data-upload-start>
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
