'use client';
// One installed extension's part of a source's sheet (v0.53.0; since v0.54.0 inside Admin → Sources' one sheet for every
// source, components/SourceSheet.tsx): its languages with a switch each, its settings, Update, and Remove extension.
//
// THE LANGUAGES ARE SWITCHES. An extension carries one source per language, and which of them are on is the choice
// people make most here after installing (#121: a language select in the old settings sheet looked like that choice
// and was not). Each switch is that one source, by id, through the bulk route: one reload and no smoke test, which
// on the per-source route would hold the switch for most of a minute. A switch by id never changes the languages
// hidden in every extension (the Languages sheet's standing choice), so it says when its language is one of those.
//
// A language's row has a line under its name only for a problem -- its status with #115's confirmed failures over it,
// "over the source limit" for a source switched on that search cannot reach (SUWAYOMI_MAX_SOURCES), hidden in every
// extension, or (v0.54.0) switched off by an admin's switch while its extension's is on, which the old sheet showed
// as on with no word about it. With none on, the Languages header offers Turn on its sources; the limit across all
// extensions is said from 80 % of it; Settings is a disclosure, closed unless a deep link asks for it.
//
// Remove asks first, inside the sheet: a ConfirmDialog is z-50 and a Sheet z-60 in one stacking context, so a dialog
// opened over the sheet would paint underneath it and could not be tapped (ExtensionSettings.tsx asks the same way).
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { sentenceGap } from '@/lib/jobs';
import { adultShown } from '@/lib/adult';
import {
  extLanguageName, langTag, languageProblem, languagesOnText, nearSourceLimit, needsTurningOn, overLimitText,
  sourceHealth, type ExtSource, type ExtStatus, type InstalledExt,
} from '@/lib/extensions';
import type { AdminSourceRow, SrcStatus } from '@/lib/providerGroups';
import { Switch } from '@/components/Switch';
import { useToast } from '@/components/Toast';
import { msgOf } from '@/components/ConfirmDialog';
import { ProgressRing } from '@/components/ProgressRing';
import { StatusMark } from '@/components/StatusMark';
import { IcChevronRight } from '@/components/icons';
import { ExtensionSettingsBody } from '@/components/ExtensionSettings';
import { Busy, busyKey } from '@/components/ExtensionBits';
import type { ExtActions } from '@/components/ExtensionsPanel';

/** The amber key, for an update waiting: the one amber action of the sheet. */
const AMBER_KEY = 'border-amber-500/35 bg-amber-500/10 text-amber-300 hover:border-amber-400/70 hover:text-amber-200';

/** Update, when one waits: in the sheet's head, where it is seen first. */
export function ExtensionUpdateKey({ ext, actions }: { ext: InstalledExt; actions: ExtActions }) {
  const busy = actions.busy[ext.pkgName];
  if (!ext.hasUpdate) return null;
  return (
    <button type="button" onClick={() => void actions.act(ext, 'update')} disabled={!!busy} data-ext-update
      className={`btn-key ${AMBER_KEY} ${busyKey(busy === 'update')}`}>
      {busy === 'update' ? <Busy tone="amber">{tr('Updating…')}</Busy> : tr('Update')}
    </button>
  );
}

/**
 * The extension's languages and settings, for the sheet of one of its sources.
 * `offByAdmin`: the sources an admin's switch turned off (the sources overview's `offBy: 'admin'`), by raw id.
 */
export function ExtensionSection({ ext, status, hiddenLangs, actions, onLanguages, offByAdmin, settingsFor, settingsOpen: openFirst }: {
  ext: InstalledExt;
  status: ExtStatus;
  hiddenLangs: string[];
  actions: ExtActions;
  /** The Languages sheet: the languages hidden in every extension. The source's sheet closes first (one sheet at a time). */
  onLanguages: () => void;
  offByAdmin?: ReadonlySet<string>;
  /** Whose settings show first: the source the sheet is about. */
  settingsFor?: string | null;
  /** Settings open from the start: the `settings=<id>` deep link (Health, the series page, the add dialog). */
  settingsOpen?: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  // Every source the registry holds (18+ ones included, with the reveal's own parameter rule -- `?adult=1` only while
  // it is off, lib/api.ts adds its own when it is on) and the admin rows with #115's evidence.
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
  // Whose settings show: the one picked, else the sheet's own source, else the first language on, else the first.
  // Read on every render: a sheet that opens the moment an install answers may draw before its sources are listed.
  const [picked, setSettingsOf] = useState<string | null>(null);
  const settingsOf = picked ?? (settingsFor && ext.sources.some((s) => s.id === settingsFor) ? settingsFor : null)
    ?? (ext.sources.find((s) => s.enabled) ?? ext.sources[0])?.id ?? null;
  // Closed until asked for: an extension's settings are the rarest thing done here.
  const [settingsOpen, setSettingsOpen] = useState(!!openFirst);
  const busy = actions.busy[ext.pkgName];
  const off = needsTurningOn(ext);
  const over = overLimitText(status.skipped, status.cap);
  const across = tr('Across all extensions: {n} of {max} sources on.', { n: status.enabled ?? 0, max: status.cap ?? 0 });
  const settingsLang = ext.sources.length > 1 ? ext.sources.find((s) => s.id === settingsOf)?.lang : undefined;

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

  return (
    <div className="space-y-4" data-ext-sheet={ext.pkgName}>
      <section aria-labelledby="ext-sheet-langs">
        <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <h3 id="ext-sheet-langs" className="text-[11px] font-semibold uppercase tracking-wider text-fog-500 rtl:tracking-normal">{tr('Languages')}</h3>
          <span className="flex items-center gap-2.5">
            {ext.sources.length > 0 && <span className="text-[12px] tabular-nums text-fog-500">{languagesOnText(ext.on, ext.sources.length)}</span>}
            {/* None on -- installed in the engine's own page, or every language switched off: one press, here. */}
            {off && (
              <button type="button" onClick={() => void actions.act(ext, 'enable')} disabled={!!busy} className={`btn-key btn-key-accent ${busyKey(busy === 'enable')}`} data-ext-turn-on>
                {busy === 'enable' ? <Busy tone="muted">{tr('Turning on…')}</Busy> : tr('Turn on its sources')}
              </button>
            )}
          </span>
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-fog-400">{tr('Each language is its own source; turn on the ones you read.')}</p>
        {!ext.sources.length ? (
          <p className="py-3 text-sm text-fog-500">{tr('This extension provides no source.')}</p>
        ) : (
          <ul className="mt-3 divide-y divide-ink-800/70 overflow-hidden rounded-2xl border border-ink-700/60 bg-ink-900/40" data-ext-langs>
            {ext.sources.map((s) => {
              // An admin's switch off over an extension's switch on: said, rather than a switch that reads "on".
              const adminOff = s.enabled && !!offByAdmin?.has(s.id);
              const problem = adminOff ? { tone: 'off' as const, label: tr('Turned off') } : languageProblem(sourceHealth(s, reg, rows));
              const hidden = !!s.lang && hiddenLangs.includes(s.lang);
              return (
                <li key={s.id} data-ext-lang={s.id} data-on={s.enabled || undefined} className="flex min-w-0 items-center gap-3 px-3.5 py-2.5">
                  <span aria-hidden className={`w-12 shrink-0 whitespace-nowrap rounded-[4px] px-1 text-center text-[10px] font-semibold leading-[18px] tracking-wide ${s.enabled ? 'bg-accent-soft text-accent' : 'bg-ink-800 text-fog-500'}`}>
                    {langTag(s.lang)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-fog-100">{extLanguageName(s.lang)}</p>
                    {(problem || hidden) && (
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-fog-500" data-ext-lang-problem>
                        {problem && <StatusMark tone={problem.tone} label={problem.label} size="xs" />}
                        {/* Hidden in every extension is the Languages sheet's standing choice: a link to it. */}
                        {hidden && <button type="button" onClick={onLanguages} className="text-fog-400 underline decoration-ink-600 underline-offset-2 hover:text-accent" data-ext-lang-hidden>{tr('Hidden in every extension')}</button>}
                      </p>
                    )}
                  </div>
                  {switching === s.id && <ProgressRing progress="spin" size={14} tone="muted" />}
                  <Switch on={s.enabled} disabled={switching === s.id || !!busy} label={extLanguageName(s.lang)} onChange={(v) => void toggle(s, v)} />
                </li>
              );
            })}
          </ul>
        )}
        {/* The limit where it bites: a switch turned on past it is a source search cannot reach. Said from 80 % of it. */}
        {nearSourceLimit(status) && (
          <p className="mt-2 text-[12px] leading-relaxed text-fog-500" data-ext-sheet-cap>
            {across}
            {over && <>{sentenceGap(across)}<span className="text-amber-300">{over}</span></>}
          </p>
        )}
      </section>

      {settingsOf && (
        <section aria-labelledby="ext-sheet-settings" className="border-t border-ink-800/70">
          <button type="button" id="ext-sheet-settings" aria-expanded={settingsOpen} aria-controls="ext-sheet-settings-body"
            onClick={() => setSettingsOpen((o) => !o)} data-ext-settings-toggle
            className="group flex w-full items-center justify-between gap-3 py-3.5 text-start">
            <span className="min-w-0 truncate text-sm text-fog-200 group-hover:text-fog-50">
              {tr('Settings')}
              {settingsLang !== undefined && <span className="ms-2 text-[12px] text-fog-500">{tr('for {language}', { language: extLanguageName(settingsLang) })}</span>}
            </span>
            {/* It turns with the section, at once: no motion. */}
            <IcChevronRight aria-hidden width={16} height={16} className={`shrink-0 text-fog-500 ${settingsOpen ? 'rotate-90' : 'rtl:-scale-x-100'}`} />
          </button>
          {settingsOpen && (
            <div id="ext-sheet-settings-body" className="pb-2">
              <ExtensionSettingsBody sourceId={settingsOf} onSourceId={setSettingsOf} note />
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/** Remove extension, in the sheet's footer: it asks first, inside the sheet, with how many series came from it. */
export function ExtensionRemove({ ext, actions, onRemoved }: { ext: InstalledExt; actions: ExtActions; onRemoved: () => void }) {
  const [removing, setRemoving] = useState(false);
  const busy = actions.busy[ext.pkgName];
  const name = `⁨${ext.name}⁩`;
  const remove = async () => {
    const r = await actions.act(ext, 'uninstall');
    if (r) onRemoved();
  };
  if (!removing) {
    return (
      <button type="button" onClick={() => setRemoving(true)} disabled={!!busy} className="btn-key btn-key-danger text-rose-300" data-ext-remove>
        {tr('Remove extension')}
      </button>
    );
  }
  return (
    <div role="alertdialog" aria-label={tr('Remove {name}?', { name })} className="w-full border-s-2 border-red-400 bg-ink-850/80 py-2.5 pe-2 ps-3" data-ext-remove-confirm>
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
  );
}
