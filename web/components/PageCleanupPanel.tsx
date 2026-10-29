'use client';
import { useEffect, useRef, useState } from 'react';
import { getOfflineChapter } from '@/lib/downloads';
import { Sheet } from '@/components/ui';
import { msgOf } from '@/components/ConfirmDialog';
import { img } from '@/lib/api';
import { bytes } from '@/lib/format';
import { t as tr } from '@/lib/i18n';
import {
  cleanupSelection, previewCleanup, previewPageRules, savePageCleanup, savePageRule,
  type CleanupAction, type PageCleanupPreview, type PageRulePreview, type RuleScope,
} from '@/lib/pageCleanup';

/** An offline file is a separate saved copy: editing it must never silently discard someone's download. */
export function OfflinePageCleanupNotice() {
  return <div className="space-y-3 text-sm" data-cleanup-offline>
    <p>{tr('This chapter is being read from a saved offline copy. Page editing is available on the server copy.')}</p>
    <p>{tr('Remove this chapter from Downloads, then reopen it while connected to the server. Other devices must download it again to see page changes.')}</p>
    <a href="/downloads/" className="btn-key inline-flex">{tr('Downloads')}</a>
  </div>;
}

export function PageCleanupPanel({ bookId, offline, initialRestore, contentVersion, onChanged, onClose }: {
  bookId: string; offline: boolean; initialRestore?: number; contentVersion?: string; onChanged: () => Promise<void>; onClose: () => void;
}) {
  const [localCopy, setLocalCopy] = useState(offline);
  const [preview, setPreview] = useState<PageCleanupPreview | null>(null);
  const [rules, setRules] = useState<PageRulePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false); busyRef.current = busy;
  const [action, setAction] = useState<CleanupAction>(initialRestore ? 'restore' : 'remove');
  const [selected, setSelected] = useState<Set<number>>(new Set(initialRestore ? [initialRestore] : []));
  const [confirm, setConfirm] = useState(false);
  const [ruleAsk, setRuleAsk] = useState<{ scope: RuleScope; value: boolean | null } | null>(null);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    if (offline) { setLoading(false); return; }
    let live = true;
    setLoading(true); setPreview(null); setRules(null); setError(null); setRuleError(null);
    void getOfflineChapter(bookId).then((saved) => {
      if (saved) { if (live) { setLocalCopy(true); setLoading(false); } return null; }
      return Promise.allSettled([previewCleanup(bookId), previewPageRules(bookId)]);
    }).then((results) => {
      if (!results) return;
      const [pages, gif] = results;
      if (!live) return;
      if (pages.status === 'fulfilled') setPreview(pages.value); else setError(msgOf(pages.reason, tr('Page cleanup is unavailable for this chapter.')));
      if (gif.status === 'fulfilled') setRules(gif.value); else setRuleError(msgOf(gif.reason, tr('Could not load GIF rules.')));
      setLoading(false);
    });
    return () => { live = false; };
  }, [bookId, offline, epoch]);
  let chosen: number[] = [];
  if (preview) { try { chosen = cleanupSelection(preview, action, selected); } catch { /* the destructive key remains disabled */ } }
  const canApply = !!preview && (chosen.length > 0 || (action === 'purge-unused' && preview.unusedRetainedImages > 0));
  const changeAction = (next: CleanupAction) => { setAction(next); setSelected(new Set()); setConfirm(false); };
  const apply = async () => {
    if (!preview || !canApply) return;
    setBusy(true); setError(null);
    try {
      if (await getOfflineChapter(bookId)) { setLocalCopy(true); return; }
      setPreview(await savePageCleanup(bookId, preview, action, selected));
      setSelected(new Set()); setConfirm(false);
      await onChanged();
      setRules(await previewPageRules(bookId));
    } catch (e) { setError(msgOf(e, tr('Could not update pages. Reload the preview before trying again.'))); }
    finally { setBusy(false); }
  };
  const applyRule = async () => {
    if (!ruleAsk) return;
    setBusy(true); setRuleError(null);
    try {
      if (await getOfflineChapter(bookId)) { setLocalCopy(true); return; }
      await savePageRule(bookId, ruleAsk.scope, ruleAsk.value);
      setRuleAsk(null); setRules(await previewPageRules(bookId));
      await onChanged();
    } catch (e) { setRuleError(msgOf(e, tr('Could not save'))); }
    finally { setBusy(false); }
  };
  return <Sheet title={tr('Manage chapter pages')} onClose={() => { if (!busyRef.current) onClose(); }} overBottomNav>
    {localCopy ? <OfflinePageCleanupNotice /> : <div className="space-y-5" data-page-cleanup>
      <p className="text-xs leading-relaxed text-fog-400">{tr('Removed pages can be restored while their originals stay in server trash. Retained originals still use storage until you explicitly delete them.')}</p>
      <p className="text-xs leading-relaxed text-fog-400">{tr('Page numbers and reading progress stay in place. Existing offline copies on other devices need to be downloaded again.')}</p>
      {loading && <p role="status">{tr('Loading…')}</p>}
      {error && <p role="alert" className="text-sm text-amber-300">{error}</p>}
      <button type="button" className="btn-key" disabled={busy || loading} onClick={() => { setConfirm(false); setSelected(new Set()); setEpoch((n) => n + 1); }}>{tr('Reload preview')}</button>
      {preview && <section>
        <div className="mb-3 flex flex-wrap gap-2">
          <button type="button" className="btn-key" data-cleanup-mode="remove" aria-pressed={action === 'remove'} disabled={busy} onClick={() => changeAction('remove')}>{tr('Remove pages')}</button>
          <button type="button" className="btn-key" data-cleanup-mode="restore" aria-pressed={action === 'restore'} disabled={busy} onClick={() => changeAction('restore')}>{tr('Restore pages')}</button>
          <button type="button" className="btn-key" data-cleanup-mode="purge" aria-pressed={action === 'purge'} disabled={busy} onClick={() => changeAction('purge')}>{tr('Delete retained originals')}</button>
          {action === 'remove' && <button type="button" className="btn-key" disabled={busy} onClick={() => { setSelected(new Set(preview.pages.filter((p) => p.gif && !p.removed).slice(0, 500).map((p) => p.number))); setConfirm(false); }}>{tr('Select GIF pages')}</button>}
          <button type="button" className="btn-key" disabled={busy} onClick={() => { setSelected(new Set()); setConfirm(false); }}>{tr('Clear selection')}</button>
        </div>
        <p className="mb-2 text-xs text-fog-400">{tr('Select up to 500 pages. At least one page must remain in the chapter.')}</p>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5" data-cleanup-pages>
          {preview.pages.map((p) => {
            const eligible = action === 'remove' ? !p.removed : action !== 'purge-unused' && p.removed && p.restorable;
            return <label key={p.number} className={`relative overflow-hidden rounded border border-ink-700 bg-ink-900 ${eligible ? '' : 'opacity-45'}`}>
              {p.removed ? <div className="grid aspect-[2/3] place-items-center text-xs text-fog-400">{p.restorable ? tr('Removed') : tr('Original permanently deleted')}</div> :
                // eslint-disable-next-line @next/next/no-img-element
                <img src={img.page(bookId, p.number, 200, preview.contentVersion)} alt="" loading="lazy" className="aspect-[2/3] w-full object-cover object-top" />}
              <span className="absolute start-1 top-1 rounded bg-black/75 p-1">
                <input type="checkbox" data-cleanup-page={p.number} aria-label={tr('Select page {n}', { n: p.number })} checked={selected.has(p.number)} disabled={busy || !eligible || (!selected.has(p.number) && selected.size >= 500)}
                  onChange={(e) => { const checked = e.target.checked; setConfirm(false); setSelected((old) => { const next = new Set(old); if (checked) next.add(p.number); else next.delete(p.number); return next; }); }} />
              </span>
              <span className="block truncate px-1 text-xs" title={p.name}>{p.number} · {p.name}</span>
              <span className="block px-1 pb-1 text-[10px] text-fog-500">{bytes(p.bytes)}{p.gif ? ` · ${tr('GIF pages')}` : ''}</span>
            </label>;
          })}
        </div>
        <p className="mt-2 text-xs text-fog-400">{tr('Selected: {n}', { n: selected.size })} · {tr('Retained originals: {size}', { size: bytes(preview.retainedBytes) })}</p>
        {preview.unusedRetainedImages > 0 && <button type="button" className="btn-key mt-3" disabled={busy} data-cleanup-unused onClick={() => { setAction('purge-unused'); setSelected(new Set()); setConfirm(true); }}>{tr('Clear unused retained images')} · {preview.unusedRetainedImages} · {bytes(preview.unusedRetainedBytes)}</button>}
        {confirm ? <div role="alertdialog" aria-label={tr('Confirm page changes')} className="mt-3 border-s-2 border-amber-400 p-3" data-cleanup-confirm>
          <p className="text-sm">{action === 'remove' ? tr('Remove the selected pages from this server chapter? The saved originals will remain available to restore.') : action === 'restore' ? tr('Restore the selected pages to this server chapter?') : action === 'purge' ? tr('Permanently delete the selected retained originals? These pages cannot be restored from server trash afterward.') : tr('Permanently delete all unused retained images? These originals are no longer needed by removed pages.')}</p>
          {action === 'purge-unused' ? <p className="my-2 text-xs">{preview.unusedRetainedImages} · {bytes(preview.unusedRetainedBytes)}</p> : <p className="my-2 break-words text-xs">{tr('Pages')}: {chosen.join(', ')}</p>}
          {(action === 'purge' || action === 'purge-unused') && <p className="mb-2 text-xs text-amber-300">{tr('Backups and separately saved offline copies will not be deleted.')}</p>}
          <button type="button" className="btn-key btn-key-danger" disabled={busy || !canApply} onClick={() => void apply()} data-cleanup-confirm-yes>{tr('Confirm page changes')}</button>
          <button type="button" className="btn-key ms-2" disabled={busy} onClick={() => setConfirm(false)} data-cleanup-cancel>{tr('Cancel')}</button>
        </div> : <button type="button" className="btn-key mt-3" disabled={busy || !canApply} onClick={() => setConfirm(true)} data-cleanup-review>{tr('Review selected pages')}</button>}
      </section>}
      <section className="border-t border-ink-700 pt-4" data-page-rules>
        <h3 className="mb-2 text-sm font-semibold">{tr('GIF skip rules')}</h3>
        <p className="mb-3 text-xs text-fog-400">{tr('Rules only skip GIF pages while reading. They keep the downloaded files. Stop skipping a page in the page grid to make an exception.')}</p>
        {ruleError && <p role="alert" className="text-xs text-amber-300">{ruleError}</p>}
        {rules?.sourceId ? <>
          <p className="mb-2 text-xs">{rules.sourceName || rules.sourceId} · {tr('GIF pages')}: {rules.pages.map((p) => p.number).join(', ') || '—'}</p>
          <div className="mb-3 grid grid-cols-4 gap-2">{rules.pages.map((p) => <div key={p.number} className="min-w-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img.page(bookId, p.number, 200, preview?.contentVersion ?? contentVersion)} alt="" loading="lazy" className="aspect-[2/3] w-full object-cover object-top" />
            <p className="truncate text-[10px] text-fog-400" title={p.name}>{p.number} · {p.name}</p>
            {p.rescued && <p className="text-[10px] text-fog-300">{tr('Keep GIF pages visible')}</p>}
          </div>)}</div>
          {(['series', 'source'] as const).map((scope) => <div key={scope} className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-xs">{scope === 'series' ? tr('This series') : tr('Every series from this source')} · {tr('Chapters in scope: {n}', { n: scope === 'series' ? rules.seriesChapters : rules.chapters })}</span>
            <select className="field text-xs" data-page-rule={scope} aria-label={scope === 'series' ? tr('Series GIF rule') : tr('Source GIF rule')} disabled={busy}
              value={String(scope === 'series' ? rules.seriesRule : rules.sourceRule)}
              onChange={(e) => setRuleAsk({ scope, value: e.target.value === 'null' ? null : e.target.value === 'true' })}>
              <option value="null">{tr('Inherit')}</option><option value="false">{tr('Keep GIF pages visible')}</option><option value="true">{tr('Skip GIF pages')}</option>
            </select>
          </div>)}
          {ruleAsk && <div role="alertdialog" aria-label={tr('Confirm GIF rule')} className="border-s-2 border-amber-400 p-3" data-rule-confirm>
            <p className="text-sm">{ruleAsk.scope === 'series' ? tr('Apply this GIF rule to this series?') : tr('Apply this GIF rule to every chapter downloaded from this source?')}</p>
            <p className="my-2 text-xs">{tr('Chapters in scope: {n}', { n: ruleAsk.scope === 'series' ? rules.seriesChapters : rules.chapters })} · {ruleAsk.value === null ? tr('Inherit') : ruleAsk.value ? tr('Skip GIF pages') : tr('Keep GIF pages visible')}</p>
            <p className="mb-2 text-xs text-fog-400">{tr('This changes existing and future chapters. A series rule overrides the source rule. No files are deleted.')}</p>
            <button type="button" className="btn-key" disabled={busy} onClick={() => void applyRule()} data-rule-save>{tr('Confirm GIF rule')}</button>
            <button type="button" className="btn-key ms-2" disabled={busy} onClick={() => setRuleAsk(null)} data-rule-cancel>{tr('Cancel')}</button>
          </div>}
        </> : !loading && <p className="text-xs text-fog-400">{tr('No recorded source is available for GIF rules.')}</p>}
      </section>
    </div>}
  </Sheet>;
}
