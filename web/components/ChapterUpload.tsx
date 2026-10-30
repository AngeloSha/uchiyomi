'use client';
// Uploading chapter files by hand (lib/chapterUpload.ts): Edit details → Files for a series already here, and the
// admin Library panel for a series that is not here yet.
import { useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
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

/** Admin → Library: a series that is not here yet, started from its files. */
export function UploadSeriesSection() {
  const uid = useId();
  const input = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [made, setMade] = useState<{ id: string; title: string } | null>(null);
  const { at, start } = useUpload((run) => {
    if (run.done && run.seriesId) { setMade({ id: run.seriesId, title: title.trim() }); setTitle(''); }
  });
  const ready = !!title.trim() && !at;
  return (
    <section className="full" data-upload-series>
      <h3 className="mb-1 font-display text-base font-semibold">{tr('Upload a series')}</h3>
      <p className="mb-3 max-w-prose text-xs leading-relaxed text-fog-500">
        {tr('For a series no source has, when you already have its chapters. The files go into the download folder, under Uploads, and the chapter number is read from each file name.')}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={uid} className="sr-only">{tr('Title')}</label>
        <input id={uid} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} dir="auto"
          placeholder={tr('Series title')} className="field min-w-0 flex-1 sm:max-w-sm" />
        <input ref={input} type="file" multiple accept={CHAPTER_ACCEPT} hidden
          onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ''; void start({ title: title.trim() }, files); }} />
        <button type="button" onClick={() => input.current?.click()} disabled={!ready} className="chip shrink-0 text-xs">
          {at && <ProgressRing progress="spin" size={12} />}
          {at ? progressText(at) : tr('Choose files…')}
        </button>
      </div>
      {made && (
        <p className="mt-2 text-xs text-fog-400">
          <Link href={`/series/?id=${encodeURIComponent(made.id)}`} className="text-accent underline-offset-2 hover:underline">
            {tr('Open “{title}”', { title: made.title })}
          </Link>
        </p>
      )}
    </section>
  );
}
