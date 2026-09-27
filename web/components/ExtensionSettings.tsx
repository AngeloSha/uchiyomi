'use client';
// An extension's own settings (#116): the preference screen Mihon shows for a source, opened from Admin →
// Extensions (an installed extension's Settings key) or by deep link (`?tab=Extensions&settings=<source id>`,
// which the add dialog, the series page and Health use).
//
// Issue #116 is why it exists: the Webtoons extension numbers posts by the episode in their titles, so Istrevelia's
// 226 posts land on 13 numbers, and its own "Use sequential chapter numbering" switch -- the fix the reporter
// needed -- had no way in from Uchiyomi.
//
// ⚠️ A NUMBERING SETTING RENAMES A LIBRARY. Changing it moves the source's numbers under every series that uses
// them, so each of those series is queued for a renumbering an admin reviews on its series page. The sheet says so
// in the setting's own row, and asks again before sending when there is a series to renumber. The second word is
// asked INSIDE the sheet, not with ConfirmDialog: a Modal is z-50 and a Sheet z-60 in the same stacking context,
// so a confirm opened over this sheet would paint underneath its backdrop and could not be tapped.
//
// Every write names the setting's key, never a position (lib/sourcePrefs.ts): the server finds the position again
// at the moment of writing, because an extension update can move it.
//
// ⚠️ PORTALLED TO <body>. The Extensions panel is a `.card`, and `.card` blurs its backdrop: a `backdrop-filter`
// makes an element the containing block of its `fixed` descendants, so a Sheet rendered inside it covered the card
// instead of the screen -- the admin header and tabs showed through above it, undimmed, at 390 px.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { Sheet } from '@/components/ui';
import { Switch } from '@/components/Switch';
import { useToast } from '@/components/Toast';
import { msgOf } from '@/components/ConfirmDialog';
import {
  needsRenumberConfirm, prefControl, prefSummary, toggleChoice,
  type PrefValue, type PrefWriteAnswer, type SourcePref, type SourcePrefsAnswer,
} from '@/lib/sourcePrefs';

/** What the sheet opens on: one source (the deep link), or one extension, whose first source it picks. */
export type SettingsTarget = { sourceId: string; name?: string } | { pkgName: string; name?: string };

/**
 * The Extensions tab's sheet state, seeded once from `?settings=` (lib/useTabParam.ts's rule: read in a lazy
 * initialiser, never an effect) and taken off the address when the sheet closes, so a reload does not reopen it.
 */
export function useExtensionSettingsParam(): [SettingsTarget | null, (t: SettingsTarget | null) => void] {
  const params = useSearchParams();
  const [target, setTarget] = useState<SettingsTarget | null>(() => {
    const id = params.get('settings');
    return id && /^-?\d{1,20}$/.test(id) ? { sourceId: id } : null;
  });
  const set = (t: SettingsTarget | null) => {
    setTarget(t);
    if (!t && typeof window !== 'undefined') {
      const u = new URL(window.location.href);
      if (u.searchParams.has('settings')) {
        u.searchParams.delete('settings');
        window.history.replaceState(null, '', u.toString());
      }
    }
  };
  return [target, set];
}

/** A change waiting for its second word: the numbering setting, the value, and how many series it renumbers. */
interface Pending { pref: SourcePref; value: PrefValue }

export function ExtensionSettings({ target, onClose }: { target: SettingsTarget; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [sourceId, setSourceId] = useState<string | null>('sourceId' in target ? target.sourceId : null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});

  // From a catalogue row the sheet knows the package, not a source: its sources, one per language.
  const pkg = 'pkgName' in target ? target.pkgName : null;
  const { data: pkgSources, isError: pkgFailed } = useQuery({
    queryKey: ['ext-pkg-sources', pkg],
    queryFn: () => api<{ content: Array<{ id: string; name: string; lang: string | null; enabled: boolean }> }>(
      `/api/admin/extensions/sources?pkg=${encodeURIComponent(pkg!)}`),
    enabled: !!pkg && !sourceId,
  });
  useEffect(() => {
    // The first source switched on, else the first listed: the one a person most likely reads.
    if (!sourceId && pkgSources?.content.length) setSourceId((pkgSources.content.find((s) => s.enabled) ?? pkgSources.content[0]).id);
  }, [pkgSources, sourceId]);

  const key = ['ext-prefs', sourceId] as const;
  const { data, isError, error, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => api<SourcePrefsAnswer>(`/api/admin/extensions/sources/${encodeURIComponent(sourceId!)}/preferences`),
    enabled: !!sourceId,
    retry: false,
  });

  const send = async (pref: SourcePref, value: PrefValue) => {
    setPending(null);
    setSaving(pref.key);
    try {
      const r = await api<PrefWriteAnswer>(`/api/admin/extensions/sources/${encodeURIComponent(sourceId!)}/preferences`, { json: { key: pref.key, value } });
      qc.setQueryData(key, (old: SourcePrefsAnswer | undefined) => (old ? { ...old, preferences: r.preferences, usedBy: r.usedBy, renumbers: r.renumbers } : old));
      // A renamed library shows up on the series pages and in the add dialog's counts.
      if (r.remap) qc.invalidateQueries({ queryKey: ['series-listing'] });
      qc.removeQueries({ queryKey: ['src-detail'] });
      if (!r.applied) toast(tr('The extension did not take the change.'), 'error');
      else if (r.remap) toast(r.remap === 1 ? tr('Saved. 1 series is waiting for you to review the renumbering.') : tr('Saved. {n} series are waiting for you to review the renumbering.', { n: r.remap }), 'success');
      else if (r.changed) toast(tr('Saved'), 'success');
      if (pref.type === 'text') setTexts((t) => { const { [pref.key]: _gone, ...rest } = t; return rest; });
    } catch (e) {
      toast(msgOf(e, tr('Could not change that setting')), 'error');
    }
    setSaving(null);
  };
  /** A change from a control: straight through, or held for its second word when it renumbers a library. */
  const change = (pref: SourcePref, value: PrefValue) => {
    if (needsRenumberConfirm(pref, data?.renumbers ?? 0)) setPending({ pref, value });
    else void send(pref, value);
  };

  const name = data?.source.extensionName || target.name || data?.source.name || tr('Extension');
  const sourceName = data?.source.name ?? target.name ?? '';
  const prefs = (data?.preferences ?? []).filter((p) => prefControl(p) !== 'hidden');
  const siblings = data?.siblings ?? [];

  if (typeof document === 'undefined') return null;
  return createPortal(
    <Sheet title={tr('{name} settings', { name })} onClose={onClose} overBottomNav
      footer={
        <p className="pb-1 text-[10px] leading-relaxed text-fog-500" data-ext-settings-footer>
          {tr('These are the extension’s own settings, the same ones Mihon shows; they apply to every series from this source.')}
        </p>
      }>
      {/* One extension, several sources: the language is chosen first, since each keeps its own settings. */}
      {siblings.length > 1 && (
        <label className="mb-3 block">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-fog-500">{tr('Source')}</span>
          <select value={sourceId ?? ''} onChange={(e) => { setPending(null); setSourceId(e.target.value); }} className="field">
            {siblings.map((s) => <option key={s.id} value={s.id}>{s.lang ? `${s.name} · ${s.lang}` : s.name}</option>)}
          </select>
        </label>
      )}

      {(isLoading || (!sourceId && !pkgFailed)) && <p className="py-4 text-sm text-fog-500">{tr('Loading…')}</p>}
      {(isError || pkgFailed) && (
        <p role="alert" className="py-4 text-sm text-amber-300">{msgOf(error, tr('The extension server did not answer. Try again in a moment.'))}</p>
      )}
      {pkgSources && !pkgSources.content.length && (
        <p className="py-4 text-sm text-fog-500">{tr('This extension provides no source.')}</p>
      )}
      {data && !prefs.length && <p className="py-4 text-sm text-fog-500">{tr('This extension has no settings.')}</p>}

      <div className="divide-y divide-ink-800/70" data-ext-settings>
        {prefs.map((p) => {
          const control = prefControl(p);
          const summary = prefSummary(p);
          const busy = saving === p.key;
          const off = !p.enabled || busy || !!pending;
          return (
            <div key={p.key} className="py-3" data-pref={p.key}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-fog-100">{p.title || p.key}</p>
                  {summary && <p className="mt-0.5 text-[11px] leading-relaxed text-fog-500">{summary}</p>}
                  {!p.enabled && <p className="mt-0.5 text-[11px] text-fog-600">{tr('Not available in this version of the extension.')}</p>}
                </div>
                {control === 'switch' && (
                  <Switch on={p.value === true} disabled={off} label={p.title || p.key} onChange={(v) => change(p, v)} />
                )}
              </div>
              {control === 'select' && (
                <select value={typeof p.value === 'string' ? p.value : ''} disabled={off} aria-label={p.title || p.key}
                  onChange={(e) => change(p, e.target.value)} className="field mt-2">
                  {typeof p.value !== 'string' && <option value="" disabled>{tr('Not set')}</option>}
                  {(p.entryValues ?? []).map((v, i) => <option key={v} value={v}>{p.entries?.[i] ?? v}</option>)}
                </select>
              )}
              {control === 'checks' && (
                <fieldset className="mt-2 space-y-1.5" disabled={off}>
                  <legend className="sr-only">{p.dialogTitle || p.title || p.key}</legend>
                  {(p.entryValues ?? []).map((v, i) => (
                    <label key={v} className="flex items-center gap-2 text-xs text-fog-200">
                      <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--accent))]"
                        checked={Array.isArray(p.value) && p.value.includes(v)}
                        onChange={(e) => change(p, toggleChoice(p, v, e.target.checked))} />
                      {p.entries?.[i] ?? v}
                    </label>
                  ))}
                </fieldset>
              )}
              {control === 'text' && (() => {
                const draft = texts[p.key] ?? (typeof p.value === 'string' ? p.value : '');
                const dirty = draft !== (typeof p.value === 'string' ? p.value : '');
                return (
                  <div className="mt-2">
                    {p.dialogMessage && <p className="mb-1 text-[11px] text-fog-500">{p.dialogMessage}</p>}
                    <div className="flex gap-2">
                      <input value={draft} disabled={off} aria-label={p.dialogTitle || p.title || p.key} maxLength={2000}
                        onChange={(e) => setTexts((t) => ({ ...t, [p.key]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter' && dirty && !off) change(p, draft); }}
                        autoCapitalize="none" autoCorrect="off" spellCheck={false}
                        className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-xs text-fog-100 outline-hidden focus:border-accent" />
                      <button type="button" onClick={() => change(p, draft)} disabled={off || !dirty} className="btn-key btn-key-primary">
                        {busy ? tr('Saving…') : tr('Save')}
                      </button>
                    </div>
                  </div>
                );
              })()}

              {/* The warning sits in the row it is about, before anyone touches the control: a text block with an
                  amber start-edge rule, not a badge. */}
              {p.numbering && (
                <div className="mt-2 border-s-2 border-amber-400/70 bg-amber-500/10 py-1.5 pe-2 ps-2.5 text-[11px] leading-relaxed text-amber-100" data-renumber-warning>
                  {data!.renumbers > 0 ? (
                    <>
                      {tr('Changing this renumbers every series from {source} that uses its numbers ({count}).', {
                        source: sourceName,
                        count: data!.renumbers === 1 ? tr('1 series in your library') : tr('{n} series in your library', { n: data!.renumbers }),
                      })}{' '}
                      {tr('Each waits on its series page until you review its renumbering: files are renamed, reading progress stays.')}{' '}
                    </>
                  ) : (
                    <>{tr('Changing this changes the chapter numbers {source} gives. No series in your library use them yet.', { source: sourceName })}{' '}</>
                  )}
                  <span className="text-amber-200/70">{tr('Series numbered by posting order are not affected.')}</span>
                </div>
              )}

              {/* The second word, asked here rather than in a dialog the sheet would cover (see the top). */}
              {pending?.pref.key === p.key && (
                <div role="alertdialog" aria-label={tr('Renumber these series?')} className="mt-2 border-s-2 border-amber-400 bg-ink-850/80 py-2 pe-2 ps-2.5" data-renumber-confirm>
                  <p className="text-xs text-fog-100">
                    {data!.renumbers === 1 ? tr('Renumber 1 series?') : tr('Renumber {n} series?', { n: data!.renumbers })}
                  </p>
                  <p className="mt-0.5 text-[11px] text-fog-400">{tr('Nothing is renamed until you confirm each one on its series page.')}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" onClick={() => void send(p, pending.value)} className="btn-key btn-key-primary">{tr('Change it')}</button>
                    <button type="button" onClick={() => setPending(null)} className="btn-key">{tr('Cancel')}</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Sheet>,
    document.body,
  );
}
