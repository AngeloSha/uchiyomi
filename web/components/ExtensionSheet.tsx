'use client';
// One installed extension (v0.53.0): what it is, its languages with a switch each and how each is doing, its
// settings, and Remove -- everything about one extension in one place, opened from its row in Admin → Extensions.
//
// THE LANGUAGES ARE SWITCHES. An extension carries one source per language, and which of them are on is the choice
// people make most here after installing (#121: a language select in the old settings sheet looked like that choice
// and was not). Each switch is that one source, by id, through the bulk route: one reload and no smoke test, which
// on the per-source route would hold the switch for most of a minute. A switch by id never changes the languages
// hidden in every extension (the Languages sheet's standing choice), so it says when its language is one of those.
//
// The health beside each language is Providers' own reading -- the registry's status with #115's confirmed failures
// over it -- and "over the source limit" for a source switched on that search cannot reach (SUWAYOMI_MAX_SOURCES).
//
// Remove asks first, inside the sheet: a ConfirmDialog is z-50 and a Sheet z-60 in one stacking context, so a dialog
// opened over this sheet would paint underneath it and could not be tapped (ExtensionSettings.tsx asks the same way).
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { sentenceGap } from '@/lib/jobs';
import { adultShown } from '@/lib/adult';
import {
  extLanguageName, langTag, languagesOnText, needsTurningOn, overLimitText, sourceHealth, sourcesOnText,
  type ExtSource, type ExtStatus, type InstalledExt,
} from '@/lib/extensions';
import type { AdminSourceRow, SrcStatus } from '@/lib/providerGroups';
import { Sheet } from '@/components/ui';
import { Switch } from '@/components/Switch';
import { useToast } from '@/components/Toast';
import { msgOf } from '@/components/ConfirmDialog';
import { ProgressRing } from '@/components/ProgressRing';
import { StatusGlyph, StatusMark } from '@/components/StatusMark';
import { ExtensionSettingsBody } from '@/components/ExtensionSettings';
import { Busy, ExtIcon, ExtTags, busyKey } from '@/components/ExtensionBits';
import type { ExtActions } from '@/components/ExtensionsPanel';

const seriesText = (n: number) => (n === 1 ? tr('1 series') : tr('{n} series', { n }));

export function ExtensionSheet({ ext, status, hiddenLangs, actions, onClose, onLanguages, onProviders }: {
  ext: InstalledExt;
  status: ExtStatus;
  hiddenLangs: string[];
  actions: ExtActions;
  onClose: () => void;
  /** The Languages sheet: the languages hidden in every extension. This sheet closes first (one sheet at a time). */
  onLanguages: () => void;
  /** Admin → Providers, where a source is tested. */
  onProviders?: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  // The two answers Providers reads, under its keys: every source the registry holds (18+ ones included, with the
  // reveal's own parameter rule -- `?adult=1` only while it is off, lib/api.ts adds its own when it is on) and the
  // admin rows with #115's evidence.
  const { data: registry } = useQuery({
    queryKey: ['sources', 'all'],
    queryFn: () => api<{ content: Array<{ id: string; status?: SrcStatus }> }>(adultShown() ? '/api/sources' : '/api/sources?adult=1'),
    staleTime: 60_000,
  });
  const { data: adminRows } = useQuery({
    queryKey: ['admin-sources'],
    queryFn: () => api<{ content: Array<AdminSourceRow & { source_id: string }> }>('/api/admin/sources'),
  });
  const reg = useMemo(() => (registry ? new Map(registry.content.map((s) => [s.id, s])) : null), [registry]);
  const rows = useMemo(() => (adminRows ? new Map(adminRows.content.map((r) => [r.source_id, r])) : null), [adminRows]);

  const [switching, setSwitching] = useState<string | null>(null);
  // Whose settings show: the one picked, else the first language on, else the first. Read on every render: a sheet that
  // opens the moment an install answers may draw before the extension's sources are listed.
  const [picked, setSettingsOf] = useState<string | null>(null);
  const settingsOf = picked ?? (ext.sources.find((s) => s.enabled) ?? ext.sources[0])?.id ?? null;
  const [removing, setRemoving] = useState(false);
  const busy = actions.busy[ext.pkgName];
  const off = needsTurningOn(ext);
  const over = overLimitText(status.skipped, status.cap);
  const across = tr('Across all extensions: {n} of {max} sources on.', { n: status.enabled ?? 0, max: status.cap ?? 0 });
  const name = `⁨${ext.name}⁩`;

  /** One language on or off: that source alone, by id. The switch is the list's, so it waits for the list. */
  const toggle = async (s: ExtSource, on: boolean) => {
    setSwitching(s.id);
    const lang = extLanguageName(s.lang);
    try {
      await api('/api/admin/extensions/sources/bulk', { json: { ids: [s.id], enabled: on } });
      void qc.invalidateQueries({ queryKey: ['admin-sources'] });
      await actions.refreshAll();
    } catch (e) {
      toast(msgOf(e, on ? tr('Could not show {lang}', { lang }) : tr('Could not hide {lang}', { lang })), 'error');
    }
    setSwitching(null);
  };

  const remove = async () => {
    const r = await actions.act(ext, 'uninstall');
    if (r) onClose();
  };

  return (
    <Sheet title={name} onClose={onClose} overBottomNav>
      <div className="space-y-5 pb-3" data-ext-sheet={ext.pkgName}>
        <div className="flex items-center gap-3">
          <ExtIcon url={ext.iconUrl} name={ext.name} size={48} />
          <div className="min-w-0 flex-1">
            <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-fog-400">
              <span>{[ext.versionName ? `v${ext.versionName}` : null, extLanguageName(ext.lang)].filter(Boolean).join(' · ')}</span>
              <ExtTags e={ext} />
            </p>
            {ext.used > 0 && <p className="mt-0.5 text-[12px] text-fog-500">{seriesText(ext.used)}</p>}
          </div>
          {ext.hasUpdate && (
            <button type="button" onClick={() => void actions.act(ext, 'update')} disabled={!!busy} data-ext-update
              className={`btn-key border-amber-500/40 bg-amber-500/15 text-amber-200 hover:border-amber-400/70 hover:text-amber-100 ${busyKey(busy === 'update')}`}>
              {busy === 'update' ? <Busy tone="amber">{tr('Updating…')}</Busy> : tr('Update')}
            </button>
          )}
        </div>

        {off && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5" data-ext-sheet-off>
            <StatusGlyph tone="warn" />
            <p className="min-w-0 flex-1 basis-40 text-[12px] leading-snug text-amber-200">{tr('None of its sources are on')}</p>
            <button type="button" onClick={() => void actions.act(ext, 'enable')} disabled={!!busy} className={`btn-key btn-key-primary ${busyKey(busy === 'enable')}`} data-ext-turn-on>
              {busy === 'enable' ? <Busy tone="muted">{tr('Turning on…')}</Busy> : tr('Turn on its sources')}
            </button>
          </div>
        )}

        <section aria-labelledby="ext-sheet-langs">
          <div className="flex items-baseline justify-between gap-3">
            <h3 id="ext-sheet-langs" className="text-[11px] font-semibold uppercase tracking-wider text-fog-500">{tr('Languages')}</h3>
            {ext.sources.length > 0 && <span className="text-[12px] tabular-nums text-fog-500">{languagesOnText(ext.on, ext.sources.length)}</span>}
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-fog-400">{tr('Each language is its own source; turn on the ones you read.')}</p>
          {!ext.sources.length ? (
            <p className="py-3 text-sm text-fog-500">{tr('This extension provides no source.')}</p>
          ) : (
            <ul className="mt-2 divide-y divide-ink-800/70 overflow-hidden rounded-2xl border border-ink-700/60 bg-ink-900/40" data-ext-langs>
              {ext.sources.map((s) => {
                const h = sourceHealth(s, reg, rows);
                const hidden = !!s.lang && hiddenLangs.includes(s.lang);
                return (
                  <li key={s.id} data-ext-lang={s.id} data-on={s.enabled || undefined} className="flex min-w-0 items-center gap-3 px-3 py-2.5">
                    <span aria-hidden className={`w-11 shrink-0 rounded-[4px] px-1 text-center text-[10px] font-semibold leading-[18px] tracking-wide ${s.enabled ? 'bg-accent-soft text-accent' : 'bg-ink-800 text-fog-500'}`}>
                      {langTag(s.lang)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-fog-100">{extLanguageName(s.lang)}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-fog-500">
                        <StatusMark tone={h.tone} label={h.label} size="xs" />
                        {!!s.used && <span>{seriesText(s.used)}</span>}
                        {hidden && <span data-ext-lang-hidden>{tr('Hidden in every extension')}</span>}
                      </p>
                    </div>
                    {switching === s.id && <ProgressRing progress="spin" size={14} tone="muted" />}
                    <Switch on={s.enabled} disabled={switching === s.id || !!busy} label={extLanguageName(s.lang)} onChange={(v) => void toggle(s, v)} />
                  </li>
                );
              })}
            </ul>
          )}
          {/* The limit where it bites: a switch turned on past it is a source search cannot reach. */}
          <p className="mt-2 text-[12px] leading-relaxed text-fog-500" data-ext-sheet-cap>
            {across}
            {over && <>{sentenceGap(across)}<span className="text-amber-300">{over}</span></>}
          </p>
          <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
            <button type="button" onClick={onLanguages} className="text-accent hover:underline">{tr('Languages hidden in every extension')}&nbsp;›</button>
            {onProviders && <button type="button" onClick={onProviders} className="text-accent hover:underline">{tr('Test its sources under Providers')}&nbsp;›</button>}
          </p>
        </section>

        {settingsOf && (
          <section aria-labelledby="ext-sheet-settings">
            <h3 id="ext-sheet-settings" className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fog-500">{tr('Settings')}</h3>
            <ExtensionSettingsBody sourceId={settingsOf} onSourceId={setSettingsOf} note />
          </section>
        )}

        <section className="border-t border-ink-800/70 pt-4" aria-label={tr('Remove extension')}>
          {!removing ? (
            <button type="button" onClick={() => setRemoving(true)} disabled={!!busy} className="btn-key btn-key-danger" data-ext-remove>
              {tr('Remove extension')}
            </button>
          ) : (
            <div role="alertdialog" aria-label={tr('Remove {name}?', { name })} className="border-s-2 border-red-400 bg-ink-850/80 py-2.5 pe-2 ps-3" data-ext-remove-confirm>
              <p className="text-sm text-fog-100">{tr('Remove {name}?', { name })}</p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-fog-400">
                {ext.used === 1 ? tr('1 series from it will stop updating but stay readable.')
                  : ext.used ? tr('{n} series from it will stop updating but stay readable.', { n: ext.used })
                  : tr('No series in your library came from it.')}
              </p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                <button type="button" onClick={() => void remove()} disabled={!!busy} data-ext-remove-yes
                  className={`btn-key border-red-500/50 bg-red-500/20 text-red-100 hover:border-red-400 hover:text-red-50 ${busyKey(busy === 'uninstall')}`}>
                  {busy === 'uninstall' ? <Busy tone="red">{tr('Removing…')}</Busy> : tr('Remove')}
                </button>
                <button type="button" onClick={() => setRemoving(false)} disabled={!!busy} className="btn-key">{tr('Cancel')}</button>
              </div>
            </div>
          )}
        </section>
      </div>
    </Sheet>
  );
}
