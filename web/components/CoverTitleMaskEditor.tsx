'use client';
import { useEffect, useRef, useState, type PointerEvent, type KeyboardEvent } from 'react';
import { apiResponse } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { appendMaskPoint, cropTitleMask, maskCanvasPoint, maskKeyboardPoint, maskRgba, sameMaskStrokes } from '@/lib/coverTitleMask';
import { applyTitleMaskStrokes, TITLE_MASK_MAX_PIXELS, TITLE_MASK_MAX_POINTS, TITLE_MASK_MAX_STROKES, type TitleMaskPoint, type TitleMaskStroke } from '@/lib/titleMaskRaster';
import type { TitleExtractionMask } from '@/lib/titleExtraction';

export interface TitleMaskDraft {
  jobId: string; revision: number; strokes: TitleMaskStroke[]; dirty: boolean; drawing: boolean; valid: boolean; previewUrl: string | null;
}
const copyStrokes = (strokes: readonly TitleMaskStroke[]): TitleMaskStroke[] => strokes.map((stroke) => ({ ...stroke, points: stroke.points.map((point) => ({ ...point })) }));

/** Exact source pixels with editable alpha. The same binary raster runs again on the server before Apply. */
export function CoverTitleMaskEditor({ jobId, mask, sourceUrl, baselinePath, disabled, onDraft, onReset, onDone }: {
  jobId: string; mask: TitleExtractionMask; sourceUrl: string; baselinePath: string; disabled?: boolean;
  onDraft: (draft: TitleMaskDraft | null) => void; onReset: () => Promise<void>; onDone: () => void;
}) {
  const [tool, setTool] = useState<'restore' | 'erase' | 'move'>('restore');
  const [radius, setRadius] = useState(.006);
  const [zoom, setZoom] = useState(1);
  const [frame, setFrame] = useState({ width: 320, height: 360 });
  const [ready, setReady] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [strokes, setStrokes] = useState<TitleMaskStroke[]>(() => copyStrokes(mask.strokes));
  const [cursor, setCursor] = useState<TitleMaskPoint | null>(() => maskKeyboardPoint({ x: .5, y: .5 }, 0, 0, mask.canvas.width, mask.canvas.height));
  const [drawing, setDrawing] = useState(false);
  const [panning, setPanning] = useState(false);
  const [reload, setReload] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null), viewport = useRef<HTMLDivElement>(null);
  const source = useRef<Uint8ClampedArray | null>(null), baseline = useRef<Uint8Array | null>(null);
  const saved = useRef(mask), committed = useRef(strokes), pending = useRef<TitleMaskStroke | null>(null);
  const preview = useRef<string | null>(null), generation = useRef(0), animation = useRef<number | null>(null);
  const alive = useRef(true), callbacks = useRef({ onDraft, onReset, onDone });
  const queued = useRef<{ strokes: TitleMaskStroke[]; drawing: boolean } | null>(null);
  const pointerId = useRef<number | null>(null);
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  saved.current = mask; callbacks.current = { onDraft, onReset, onDone };
  const { width, height } = mask.canvas;
  const dirty = !sameMaskStrokes(strokes, mask.strokes) || drawing;
  const fit = Math.min(frame.width / width, frame.height / height, 1);
  const scale = fit * zoom;

  const notify = (next: TitleMaskStroke[], painting: boolean, valid: boolean, url = preview.current) => callbacks.current.onDraft({
    jobId, revision: saved.current.revision, strokes: next, dirty: !sameMaskStrokes(next, saved.current.strokes), drawing: painting, valid, previewUrl: url,
  });
  const paint = (next: TitleMaskStroke[], painting: boolean) => {
    if (!source.current || !baseline.current || !canvas.current) return;
    try {
      const alpha = applyTitleMaskStrokes(baseline.current, width, height, next);
      const context = canvas.current.getContext('2d');
      if (!context) throw new Error('canvas unavailable');
      context.putImageData(new ImageData(new Uint8ClampedArray(maskRgba(source.current, alpha)), width, height), 0, 0);
      const crop = cropTitleMask(source.current, alpha, width, height);
      const mine = ++generation.current;
      if (!crop) { if (preview.current) URL.revokeObjectURL(preview.current); preview.current = null; notify(next, painting, false, null); setProblem(tr('All lettering is hidden. Restore part of the title before saving.')); return; }
      setProblem(null);
      notify(next, painting, true);
      // The editing canvas updates each frame. Encode its title preview once the gesture ends, rather than
      // queueing large PNG encoders while the pointer is moving.
      if (painting) return;
      const full = document.createElement('canvas'); full.width = crop.width; full.height = crop.height;
      full.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(crop.pixels), crop.width, crop.height), 0, 0);
      const factor = Math.min(1, 1600 / crop.width, 800 / crop.height);
      const output = factor === 1 ? full : document.createElement('canvas');
      if (factor !== 1) { output.width = Math.max(1, Math.round(crop.width * factor)); output.height = Math.max(1, Math.round(crop.height * factor)); output.getContext('2d')?.drawImage(full, 0, 0, output.width, output.height); }
      output.toBlob((blob) => {
        if (!alive.current || generation.current !== mine || !blob) return;
        const url = URL.createObjectURL(blob);
        if (preview.current) URL.revokeObjectURL(preview.current);
        preview.current = url; notify(next, painting, true, url);
      }, 'image/png');
    } catch {
      setProblem(tr('This correction is too detailed. Use fewer strokes or a smaller brush.'));
      notify(next, painting, false);
    }
  };
  const painter = useRef(paint); painter.current = paint;
  const schedule = (next: TitleMaskStroke[], painting: boolean) => {
    generation.current++;
    queued.current = { strokes: next, drawing: painting };
    if (animation.current !== null) return;
    animation.current = requestAnimationFrame(() => { animation.current = null; const task = queued.current; if (task) painter.current(task.strokes, task.drawing); });
  };
  useEffect(() => {
    const node = viewport.current; if (!node) return;
    const resize = () => setFrame({ width: Math.max(1, node.clientWidth - 2), height: Math.max(1, node.clientHeight - 2) });
    resize(); const observer = new ResizeObserver(resize); observer.observe(node); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const next = copyStrokes(mask.strokes); committed.current = next; pending.current = null; setStrokes(next); setDrawing(false);
    if (baseline.current) schedule(next, false);
  }, [mask.revision]);
  useEffect(() => {
    alive.current = true; setReady(false); setProblem(null);
    const controller = new AbortController();
    void (async () => {
      try {
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > TITLE_MASK_MAX_PIXELS) throw new Error('invalid canvas');
        const image = new Image(); image.src = sourceUrl;
        const response = await apiResponse(baselinePath, { signal: controller.signal });
        const bitmap = await createImageBitmap(await response.blob()); await image.decode();
        if (controller.signal.aborted) { bitmap.close(); return; }
        if (bitmap.width !== width || bitmap.height !== height || image.naturalWidth !== width || image.naturalHeight !== height) { bitmap.close(); throw new Error('wrong canvas'); }
        const scratch = document.createElement('canvas'); scratch.width = width; scratch.height = height;
        const context = scratch.getContext('2d', { willReadFrequently: true }); if (!context) throw new Error('canvas unavailable');
        context.drawImage(image, 0, 0); source.current = context.getImageData(0, 0, width, height).data;
        context.clearRect(0, 0, width, height); context.drawImage(bitmap, 0, 0); bitmap.close();
        const pixels = context.getImageData(0, 0, width, height).data;
        baseline.current = Uint8Array.from({ length: width * height }, (_, i) => pixels[i * 4 + 3]);
        const next = copyStrokes(saved.current.strokes); committed.current = next; setStrokes(next); setReady(true); painter.current(next, false);
      } catch { if (!controller.signal.aborted) { setProblem(tr('Could not load the correction editor. Try again.')); notify(committed.current, false, false); } }
    })();
    return () => { controller.abort(); source.current = null; baseline.current = null; };
  }, [sourceUrl, baselinePath, width, height, reload]);
  useEffect(() => () => {
    alive.current = false; generation.current++; if (animation.current !== null) cancelAnimationFrame(animation.current);
    if (preview.current) URL.revokeObjectURL(preview.current); callbacks.current.onDraft(null);
  }, []);

  const totalPoints = (list: readonly TitleMaskStroke[]) => list.reduce((n, stroke) => n + stroke.points.length, 0);
  const point = (event: PointerEvent) => {
    const p = canvas.current ? maskCanvasPoint(event.clientX, event.clientY, canvas.current.getBoundingClientRect()) : null;
    return p ? maskKeyboardPoint(p, 0, 0, width, height) : null;
  };
  const begin = (p: TitleMaskPoint) => {
    if (!ready || disabled || tool === 'move') return;
    if (committed.current.length >= TITLE_MASK_MAX_STROKES || totalPoints(committed.current) >= TITLE_MASK_MAX_POINTS) { setProblem(tr('Too many brush strokes. Undo a stroke or reset corrections.')); return; }
    pending.current = { mode: tool, radius, points: [p] }; setDrawing(true); setCursor(p);
    const next = [...committed.current, pending.current]; notify(next, true, false); schedule(next, true);
  };
  const move = (p: TitleMaskPoint, final = false) => {
    setCursor(p); const stroke = pending.current; if (!stroke) return;
    const points = appendMaskPoint(stroke.points, p, width, height, stroke.radius, final);
    if (totalPoints(committed.current) + points.length > TITLE_MASK_MAX_POINTS) { setProblem(tr('Too many brush strokes. Undo a stroke or reset corrections.')); return; }
    pending.current = { ...stroke, points }; schedule([...committed.current, pending.current], true);
  };
  const finish = (p: TitleMaskPoint | null) => {
    if (!pending.current) return;
    if (p) move(p, true);
    const next = [...committed.current, pending.current!];
    try { applyTitleMaskStrokes(baseline.current!, width, height, next); committed.current = next; setStrokes(next); }
    catch { setProblem(tr('This correction is too detailed. Use fewer strokes or a smaller brush.')); }
    pending.current = null; setDrawing(false); schedule(committed.current, false);
  };
  const undo = () => { const next = committed.current.slice(0, -1); committed.current = next; setStrokes(next); schedule(next, false); };
  const reset = () => {
    committed.current = []; setStrokes([]); schedule([], false);
    if (saved.current.strokes.length) void callbacks.current.onReset();
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || !ready || tool === 'move') return;
    if (event.key.startsWith('Arrow')) {
      event.preventDefault(); const old = cursor ?? { x: .5, y: .5 }, step = event.shiftKey ? 10 : 1;
      setCursor(maskKeyboardPoint(old, event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0,
        event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0, width, height));
    } else if (event.key === ' ' && !event.repeat) { event.preventDefault(); const p = maskKeyboardPoint(cursor ?? { x: .5, y: .5 }, 0, 0, width, height); begin(p); finish(p); }
  };
  return <div className="min-w-0 space-y-3" data-title-mask-editor data-mask-revision={mask.revision} data-mask-ready={ready}>
    <p className="text-xs leading-relaxed text-fog-400">{tr('Paint over missing lettering to restore it, or erase unwanted parts. Zoom in for precise edges.')}</p>
    <div className="flex flex-wrap gap-2" role="group" aria-label={tr('Fine-tune title')}>
      {(['restore', 'erase', 'move'] as const).map((mode) => <button key={mode} type="button" className="btn-key" aria-pressed={tool === mode}
        data-mask-tool={mode} disabled={disabled || drawing} onClick={() => setTool(mode)}>{mode === 'restore' ? tr('Restore') : mode === 'erase' ? tr('Erase') : tr('Move')}</button>)}
      <button type="button" className="btn-key" data-mask-undo disabled={disabled || drawing || !strokes.length} onClick={undo}>{tr('Undo')}</button>
      <button type="button" className="btn-key" data-mask-reset disabled={disabled || drawing || (!strokes.length && !mask.strokes.length)} onClick={reset}>{tr('Reset corrections')}</button>
      <button type="button" className="btn-key" data-mask-done disabled={disabled || dirty} onClick={onDone}>{tr('Done')}</button>
    </div>
    <div className="grid grid-cols-2 gap-3">
      <label className="min-w-0 text-xs text-fog-300">{tr('Brush size')}
        <input type="range" min={.0005} max={.05} step={.0005} value={radius} data-mask-radius disabled={disabled || drawing}
          onChange={(event) => setRadius(Number(event.target.value))} className="mt-2 block w-full accent-violet-400" />
      </label>
      <label className="min-w-0 text-xs text-fog-300">{tr('Zoom')} · {Math.round(zoom * 100)}%
        <input type="range" min={1} max={8} step={.25} value={zoom} data-mask-zoom disabled={drawing}
          onChange={(event) => setZoom(Number(event.target.value))} className="mt-2 block w-full accent-violet-400" />
      </label>
    </div>
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn-key" disabled={drawing || zoom <= 1} data-mask-zoom-out onClick={() => setZoom((n) => Math.max(1, n - .5))}>{tr('Zoom out')}</button>
      <button type="button" className="btn-key" disabled={drawing || zoom >= 8} data-mask-zoom-in onClick={() => setZoom((n) => Math.min(8, n + .5))}>{tr('Zoom in')}</button>
      <button type="button" className="btn-key" disabled={drawing} data-mask-fit onClick={() => { setZoom(1); viewport.current?.scrollTo({ left: 0, top: 0 }); }}>{tr('Fit to view')}</button>
    </div>
    {!ready && !problem && <p className="text-xs text-fog-400">{tr('Preparing the editor…')}</p>}
    {problem && <div className="space-y-2"><p role="alert" className="text-xs text-amber-200" data-mask-error>{problem}</p>
      {!ready && <button type="button" className="btn-key" onClick={() => setReload((n) => n + 1)}>{tr('Try again')}</button>}</div>}
    <div ref={viewport} data-mask-viewport data-lenis-prevent className="h-[min(52dvh,32rem)] min-h-56 w-full overflow-auto rounded-xl border border-ink-700 bg-ink-900">
      <div role="group" tabIndex={0} aria-label={tr('Title correction canvas')} data-mask-surface onKeyDown={onKey}
        className={`relative mx-auto touch-none outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-400 ${tool === 'move' ? panning ? 'cursor-grabbing' : 'cursor-grab' : 'cursor-none'}`}
        style={{ width: width * scale, height: height * scale }}
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          if (event.button !== 0 || disabled || pointerId.current !== null) return;
          event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); pointerId.current = event.pointerId;
          if (tool === 'move' && viewport.current) { pan.current = { x: event.clientX, y: event.clientY, left: viewport.current.scrollLeft, top: viewport.current.scrollTop }; setPanning(true); }
          else { const p = point(event); if (p) begin(p); }
          if (pending.current || pan.current) event.currentTarget.setPointerCapture(event.pointerId);
          else pointerId.current = null;
        }}
        onPointerMove={(event) => {
          if (pointerId.current !== null && pointerId.current !== event.pointerId) return;
          if (pan.current) viewport.current?.scrollTo({ left: pan.current.left - event.clientX + pan.current.x, top: pan.current.top - event.clientY + pan.current.y });
          else { const p = point(event); if (p) move(p); }
        }}
        onPointerUp={(event) => {
          if (event.pointerId !== pointerId.current) return;
          finish(point(event)); pan.current = null; pointerId.current = null; setPanning(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => { pending.current = null; pan.current = null; pointerId.current = null; setPanning(false); setDrawing(false); schedule(committed.current, false); }}
        onPointerLeave={() => { if (!pending.current) setCursor(null); }}>
        <img src={sourceUrl} alt="" aria-hidden="true" draggable={false} className="pointer-events-none absolute inset-0 h-full w-full opacity-25" />
        <canvas ref={canvas} width={width} height={height} aria-hidden="true" data-mask-canvas className="relative block h-full w-full" />
        {cursor && tool !== 'move' && <span aria-hidden="true" className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-white shadow-[0_0_0_1px_black]"
          style={{ left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%`, width: radius * Math.min(width, height) * scale * 2, height: radius * Math.min(width, height) * scale * 2 }} />}
      </div>
    </div>
    <p className="text-[11px] leading-relaxed text-fog-500">{tr('The faint cover is a guide. The previews show the actual cutout.')}</p>
    <p className="text-[11px] leading-relaxed text-fog-500">{tr('The arrow keys move the brush; Space paints. Hold Shift for larger steps.')}</p>
  </div>;
}
