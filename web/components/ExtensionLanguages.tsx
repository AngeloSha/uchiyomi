'use client';
// The languages hidden in every extension (issue #38, as a sheet since v0.53.0): a standing instruction, applied now
// and on every later install. Turning a language off switches off its sources in every extension and keeps them off
// when the next one is installed; turning it on switches them back on and forgets the instruction.
//
// It was a "Languages · 0 hidden · Manage" strip in the one Extensions card, and a "Choose languages" key on the line
// after a first repository opened it -- empty, because no extension was installed yet to have languages, which is how
// it "wasn't working, then disappeared after a reload" (#121). Choosing an extension's own languages is its sheet's
// job now; this is for the languages you read nowhere.
//
// A hide that would stop series updating asks first, inside the sheet (a dialog opened over a Sheet paints under it).
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { languageName } from '@/lib/format';
import { joinSentences } from '@/lib/jobs';
import { onText } from '@/lib/counted';
import { LOCAL_SOURCE_LANG, type ExtLang, type ExtSourcesAnswer } from '@/lib/extensions';
import { Sheet } from '@/components/ui';
import { Switch } from '@/components/Switch';
import { useToast } from '@/components/Toast';
import { msgOf } from '@/components/ConfirmDialog';
import { Busy } from '@/components/ExtensionBits';

export function LanguagesSheet({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['ext-sources'], queryFn: () => api<ExtSourcesAnswer>('/api/admin/extensions/sources') });
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const langs = (data?.langs ?? []).filter((l) => l.lang !== LOCAL_SOURCE_LANG);

  /** Every source of one language in one call, and the choice remembered for the next install. */
  const toggleLang = async (l: ExtLang, enabled: boolean) => {
    // Only a language with a code has a switch (a source with none is reached by id), so this names a language.
    const lang = languageName(l.lang ?? '');
    setBusy(l.lang);
    try {
      const r = await api<{ changed: number; skipped: number }>('/api/admin/extensions/sources/bulk', { json: { langs: [l.lang], enabled } });
      for (const queryKey of [['ext-sources'], ['ext-status'], ['ext-installed'], ['ext-catalog'], ['sources']]) void qc.invalidateQueries({ queryKey });
      const said = enabled
        ? (r.changed === 1 ? tr('Showing {lang} — 1 source on', { lang }) : tr('Showing {lang} — {n} sources on', { lang, n: r.changed }))
        : (r.changed === 1 ? tr('Hidden {lang} — 1 source off', { lang }) : tr('Hidden {lang} — {n} sources off', { lang, n: r.changed }));
      const over = r.skipped === 1 ? tr('1 not switched on: over the source limit') : tr('{n} not switched on: over the source limit', { n: r.skipped });
      toast(enabled && r.skipped ? `${said} · ${over}` : said, 'success');
    } catch (e) {
      toast(msgOf(e, enabled ? tr('Could not show {lang}', { lang }) : tr('Could not hide {lang}', { lang })), 'error');
    }
    setBusy(null);
    setAsking(null);
  };

  return (
    <Sheet title={tr('Languages')} onClose={onClose} overBottomNav>
      <div className="pb-3" data-ext-languages-sheet>
        <p className="text-[12px] leading-relaxed text-fog-400">
          {tr('Hiding a language switches its sources off and keeps them off when you add the next extension. Series from a hidden language stay readable but stop updating until you show it again.')}
        </p>
        {!data && <p className="py-4 text-sm text-fog-500">{tr('Loading…')}</p>}
        {data && !langs.length && <p className="py-4 text-sm text-fog-500">{tr('No extension sources yet — add an extension and its languages appear here.')}</p>}
        {langs.length > 0 && (
          <ul className="mt-3 divide-y divide-ink-800/70 overflow-hidden rounded-2xl border border-ink-700/60 bg-ink-900/40">
            {langs.map((l) => {
              const code = l.lang;
              const name = code ? languageName(code) : tr('No language');
              const on = l.enabled > 0;
              const facts = [
                l.sources === 1 ? tr('1 source') : tr('{n} sources', { n: l.sources }),
                onText(l.enabled),
                l.used === 1 ? tr('1 series') : tr('{n} series', { n: l.used }),
              ].join(' · ');
              return (
                <li key={code ?? 'none'} data-lang-row={code ?? ''} className="px-3 py-2.5">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-fog-100" title={code ?? undefined}>{name}</p>
                      <p className="mt-0.5 text-[11px] text-fog-500">{facts}</p>
                      {l.hidden && <p className="mt-0.5 text-[11px] text-amber-300/90">{tr('Hidden: new extensions leave it off')}</p>}
                    </div>
                    {/* A source that declares no language cannot be chosen by one -- the server reaches it by id only. */}
                    {code === null ? (
                      <span className="shrink-0 text-[11px] text-fog-600">{tr('no language declared')}</span>
                    ) : busy === code ? (
                      <Busy tone="muted"><span className="sr-only">{tr('Loading…')}</span></Busy>
                    ) : (
                      <Switch on={on} disabled={!!busy} label={name}
                        onChange={(v) => (v ? void toggleLang(l, true) : l.used > 0 ? setAsking(code) : void toggleLang(l, false))} />
                    )}
                  </div>
                  {asking === code && code !== null && (
                    <div role="alertdialog" aria-label={tr('Hide {lang}?', { lang: name })} className="mt-2 border-s-2 border-amber-400 bg-ink-850/80 py-2 pe-2 ps-2.5" data-lang-confirm>
                      <p className="text-sm text-fog-100">{tr('Hide {lang}?', { lang: name })}</p>
                      <p className="mt-0.5 text-[12px] leading-relaxed text-fog-400">
                        {joinSentences(l.enabled === 1
                          ? tr('Hiding {lang} turns off 1 source.', { lang: name })
                          : tr('Hiding {lang} turns off {n} sources.', { lang: name, n: l.enabled }), l.used === 1
                          ? tr('1 series from {lang} will stop updating until you show the language again, but stay readable.', { lang: name })
                          : tr('{n} series from {lang} will stop updating until you show the language again, but stay readable.', { lang: name, n: l.used }))}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button type="button" onClick={() => void toggleLang(l, false)} className="btn-key btn-key-primary">{tr('Hide {lang}', { lang: name })}</button>
                        <button type="button" onClick={() => setAsking(null)} className="btn-key">{tr('Cancel')}</button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Sheet>
  );
}
