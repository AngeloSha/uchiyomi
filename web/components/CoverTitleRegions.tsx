'use client';
import { useId, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { t as tr } from '@/lib/i18n';
import { coverPoint, coverRect, editCoverRect, type CoverTitlePoint, type CoverTitleRect } from '@/lib/coverTitleRegions';

export interface CoverTitleSelection { region: CoverTitleRect | null; exclusions: CoverTitleRect[] }
const boxStyle = (rect: CoverTitleRect): CSSProperties => ({ left: `${rect.left * 100}%`, top: `${rect.top * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` });
const DEFAULT_REGION = { left: 0.05, top: 0.05, width: 0.9, height: 0.35 };

/** Pointer drawing and percentage fields are equivalent ways to choose an area. Nothing edits the cover itself. */
export function CoverTitleRegions({ src, selection, disabled, maxExclusions = 8, onChange }: {
  src: string; selection: CoverTitleSelection; disabled?: boolean; maxExclusions?: number;
  onChange: (selection: CoverTitleSelection) => void;
}) {
  const hint = useId();
  const [drawing, setDrawing] = useState<'title' | 'exclude' | null>(null);
  const [draft, setDraft] = useState<CoverTitleRect | null>(null);
  const [imageReady, setImageReady] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const start = useRef<CoverTitlePoint | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const point = (event: PointerEvent) => surface.current ? coverPoint(event.clientX, event.clientY, surface.current.getBoundingClientRect()) : null;
  const finish = (event: PointerEvent) => {
    if (!start.current || !drawing || disabled) return;
    const end = point(event);
    if (end) {
      const rect = coverRect(start.current, end);
      onChange(drawing === 'title' ? { ...selection, region: rect } : { ...selection, exclusions: [...selection.exclusions, rect].slice(0, maxExclusions) });
    }
    start.current = null;
    setDraft(null);
    setDrawing(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const changeRect = (index: number | null, rect: CoverTitleRect) => onChange(index === null ? { ...selection, region: rect }
    : { ...selection, exclusions: selection.exclusions.map((old, i) => i === index ? rect : old) });
  return <div className="min-w-0" data-cover-title-regions>
    <div className="mb-3 flex flex-wrap gap-2">
      <button type="button" className="btn-key" data-extract-region-auto aria-pressed={selection.region === null} disabled={disabled}
        onClick={() => { setDrawing(null); onChange({ ...selection, region: null }); }}>{tr('Find the title automatically')}</button>
      <button type="button" className="btn-key" data-extract-region-draw aria-pressed={drawing === 'title'} disabled={disabled || !imageReady}
        onClick={() => { onChange({ ...selection, region: selection.region ?? DEFAULT_REGION }); setDrawing(drawing === 'title' ? null : 'title'); }}>{tr('Choose title area')}</button>
      <button type="button" className="btn-key" data-extract-exclusion-add aria-pressed={drawing === 'exclude'}
        disabled={disabled || !imageReady || selection.exclusions.length >= maxExclusions}
        onClick={() => setDrawing(drawing === 'exclude' ? null : 'exclude')}>{tr('Exclude an area')}</button>
    </div>
    <p id={hint} className="mb-3 text-xs leading-relaxed text-fog-400">
      {drawing ? tr('Drag across the cover to mark an area, or adjust the percentages below.')
        : tr('Keep the complete title. Exclude small author names, publisher marks or volume numbers if needed.')}
    </p>
    <div className="mx-auto w-fit max-w-full overflow-hidden rounded-lg border border-ink-700 bg-ink-950">
      <div ref={surface} className={`relative w-fit max-w-full ${drawing && !disabled ? 'touch-none cursor-crosshair' : 'touch-pan-y'}`}
        data-extract-cover-surface aria-describedby={hint}
        onPointerDown={(event) => {
          if (disabled || !drawing || !imageReady || event.button !== 0) return;
          const p = point(event); if (!p) return;
          event.preventDefault(); start.current = p; setDraft(coverRect(p, p));
          event.currentTarget.setPointerCapture(event.pointerId);
        }} onPointerMove={(event) => {
          if (!start.current || disabled) return;
          const p = point(event); if (p) setDraft(coverRect(start.current, p));
        }} onPointerUp={finish} onPointerCancel={() => { start.current = null; setDraft(null); setDrawing(null); }}>
        <img src={src} alt={tr('Cover used to extract the title')} draggable={false}
          className="block max-h-[58dvh] max-w-full select-none object-contain"
          onLoad={() => { setImageReady(true); setImageFailed(false); }} onError={() => { setImageReady(false); setImageFailed(true); }} />
        {selection.region && <div aria-hidden="true" className="pointer-events-none absolute border-2 border-violet-300 bg-violet-400/15" style={boxStyle(selection.region)} />}
        {selection.exclusions.map((rect, i) => <div key={i} aria-hidden="true" className="pointer-events-none absolute border-2 border-rose-300 bg-rose-500/30" style={boxStyle(rect)} />)}
        {draft && <div aria-hidden="true" className={`pointer-events-none absolute border-2 ${drawing === 'exclude' ? 'border-rose-200 bg-rose-500/30' : 'border-white bg-violet-400/20'}`} style={boxStyle(draft)} />}
      </div>
    </div>
    {imageFailed && <p role="alert" className="mt-2 text-xs text-rose-300">{tr('The cover could not be loaded. Close this preview and try again.')}</p>}
    <div className="mt-4 space-y-3">
      {selection.region && <RectFields label={tr('Title area')} rect={selection.region} disabled={disabled} onChange={(rect) => changeRect(null, rect)} />}
      {selection.exclusions.map((rect, index) => <div key={index} className="rounded-lg border border-ink-700 p-3" data-extract-exclusion={index}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-fog-300">{tr('Excluded area {number}', { number: index + 1 })}</span>
          <button type="button" className="btn-key" disabled={disabled} aria-label={tr('Remove excluded area {number}', { number: index + 1 })}
            onClick={() => onChange({ ...selection, exclusions: selection.exclusions.filter((_, i) => i !== index) })}>{tr('Remove')}</button>
        </div>
        <RectFields label={tr('Excluded area {number}', { number: index + 1 })} rect={rect} disabled={disabled} onChange={(next) => changeRect(index, next)} />
      </div>)}
      {drawing === 'exclude' && <button type="button" className="btn-key" disabled={disabled || selection.exclusions.length >= maxExclusions}
        data-extract-exclusion-keyboard onClick={() => { onChange({ ...selection, exclusions: [...selection.exclusions, { left: 0.7, top: 0.8, width: 0.25, height: 0.15 }] }); setDrawing(null); }}>{tr('Add an area using percentages')}</button>}
    </div>
  </div>;
}

function RectFields({ label, rect, disabled, onChange }: { label: string; rect: CoverTitleRect; disabled?: boolean; onChange: (rect: CoverTitleRect) => void }) {
  const fields = [{ key: 'left' as const, label: tr('From left (%)') }, { key: 'top' as const, label: tr('From top (%)') },
    { key: 'width' as const, label: tr('Width (%)') }, { key: 'height' as const, label: tr('Height (%)') }];
  return <fieldset disabled={disabled} className="min-w-0">
    <legend className="mb-2 text-xs font-medium text-fog-200">{label}</legend>
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {fields.map((field) => <label key={field.key} className="min-w-0 text-[11px] text-fog-400">
        {field.label}<input type="number" min={field.key === 'left' || field.key === 'top' ? 0 : 1} max={100} step={1} inputMode="decimal" dir="ltr"
          data-extract-coordinate={field.key} value={Math.round(rect[field.key] * 100)} className="field mt-1 w-full min-w-0 text-sm"
          onChange={(event) => { if (event.target.value !== '') onChange(editCoverRect(rect, field.key, Number(event.target.value) / 100)); }} />
      </label>)}
    </div>
  </fieldset>;
}
