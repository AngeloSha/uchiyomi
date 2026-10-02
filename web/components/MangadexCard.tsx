'use client';
// Admin → Providers: MangaDex in other languages (v0.52.0, #123), and the language of sites that do not say theirs.
//
// On the server MangaDex is one source per language (bff lib/sources/mangadex.ts): `mangadex` is English and always
// on, and every language turned on here becomes a source of its own, "MangaDex (ES-419)", with its own Newest and
// Popular. They fold into this one card (lib/providerGroups.ts MANGADEX_GROUP) whatever is on -- with English alone
// too, because this card is where the other languages are offered.
//
// The rows are Providers' own (its Test / Clear block / Disable row, handed in as `row`), so a language is tested and
// switched off exactly as an extension's languages are, and the header wears the unhappiest language's status. The
// languages themselves fold behind a "Languages · …  Manage" strip, the Extensions tab's pattern: 26 of them are a
// wall of chips on a phone for a setting most servers change once. Each tap is one PATCH of the whole list, saved as
// it is tapped -- no draft, no Save -- and "Saving… / ✓ Saved" says so beside the chips.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { useReducedMotion } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { activeLocale, languageName } from '@/lib/format';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { OnBody } from '@/components/ui';
import { Row, SaveState, useAutosave } from '@/components/settings';
import { mangadexSourceId, type ProviderGroup, type ProviderSrc } from '@/lib/providerGroups';
import { offCost, opensMangadexLanguages, serial, toggleLang } from '@/lib/mangadexLangs';
import { useReduceEffects } from '@/lib/effects';
import type { ProviderStatus } from '@/lib/status';
import type { LanguageSettings } from '@/lib/types';

/** The Settings tab's own key: both read one answer, and a save here is what the Settings tab shows next. */
const SETTINGS_KEY = ['admin-settings'] as const;
const PATCH_URL = '/api/admin/settings';

/** The settings row, read where it is shown; the console's tabs already share this key and this URL. */
function useLanguageSettings() {
  return useQuery({ queryKey: SETTINGS_KEY, queryFn: () => api<LanguageSettings>(PATCH_URL) });
}

/** Names in the reader's list style ("English, Latin American Spanish"); a plain comma where Intl cannot. */
function nameList(codes: string[]): string {
  const names = codes.map(languageName);
  try { return new Intl.ListFormat(activeLocale(), { type: 'unit', style: 'short' }).format(names); } catch { return names.join(', '); }
}

export function MangadexCard({ group, row, mark, onSaved }: {
  /** The family as GET /api/sources lists it: English, then each language that is on. */
  group: ProviderGroup;
  /** Providers' row for one language: its code, status, series count, Test / Clear block / Disable and evidence. */
  row: (s: ProviderSrc) => ReactNode;
  /** Providers' status mark. */
  mark: (st: ProviderStatus) => ReactNode;
  /** After the last save of a run of taps: the source lists and Health are refetched. */
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const { data } = useLanguageSettings();
  const available = data?.mangadex_available ?? [];
  // Arrived by the add dialog's "Turn on more MangaDex languages" (`?card=mangadex`, v0.52.0): the languages unfolded
  // and the card on screen, once -- read in a lazy initialiser, as every address the console reads is
  // (lib/useTabParam.ts), so a refetch or a later tap never pulls the page back. Reintroduce by starting folded:
  // "the card does not unfold" in mangadexLangs.test.ts.
  const params = useSearchParams();
  const [arrived] = useState(() => opensMangadexLanguages(params));
  const [open, setOpen] = useState(arrived);
  const cardRef = useRef<HTMLDivElement>(null);
  const plain = useReduceEffects();
  const still = useReducedMotion();
  useEffect(() => {
    if (arrived) cardRef.current?.scrollIntoView({ block: 'start', behavior: plain || still ? 'auto' : 'smooth' });
    // Once, on arrival: the motion settings changing afterwards must not scroll the page again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrived]);
  const [confirm, setConfirm] = useState<{ code: string; name: string; used: number } | null>(null);
  const { status, run } = useAutosave();
  // While taps are being saved, the list they make; null otherwise, and the server's list shows. Each tap toggles
  // THIS list: read straight from `data`, two quick taps both toggled the list as it was before either save landed,
  // and the second quietly undid the first (Admin → Settings' 18+ filter says the same).
  const [mine, setMine] = useState<string[] | null>(null);
  const on = mine ?? data?.mangadex_langs ?? [];
  const pending = useRef(0);
  // One PATCH at a time, in tap order (lib/mangadexLangs.ts serial): the list is replaced whole.
  const [queue] = useState(serial);

  const commit = (next: string[]) => {
    setMine(next);
    pending.current++;
    const send = queue(() => api<LanguageSettings>(PATCH_URL, { method: 'PATCH', json: { mangadexLangs: next } }));
    void run(async () => { qc.setQueryData(SETTINGS_KEY, await send); }).finally(() => {
      if (--pending.current) return;
      // The run of taps is over: the server's list shows again (a refused save puts its chip back), and the lists are
      // refetched, so a language switched on has its row and Discover has its source.
      setMine(null);
      onSaved();
    });
  };

  const toggle = (code: string) => {
    // Series would stop updating: asked first, with how many. A language nothing came from goes at once.
    const cost = on.includes(code) ? offCost(group, code) : null;
    if (cost) setConfirm({ code, ...cost });
    else commit(toggleLang(available, on, code));
  };

  // English first, then the languages in the picker's order, however the registry happened to list them.
  const rank = (s: ProviderSrc) => {
    const i = available.findIndex((c) => mangadexSourceId(c) === s.id);
    return i < 0 ? available.length : i;
  };
  const rows = [...group.sources].sort((a, b) => rank(a) - rank(b));
  const disabled = group.sources.length - group.on;
  const shown = ['en', ...on];
  const panel = useId();

  return (
    <div ref={cardRef} data-source-card="mangadex" className="card grad-border wide scroll-mt-4 p-4 lg:scroll-mt-20">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-sm text-fog-100">
          MangaDex
          <span className="ms-2 text-[11px] text-fog-500">
            {rows.length === 1 ? tr('1 language') : tr('{n} languages', { n: rows.length })}
            {disabled > 0 && <> · {tr('{n} on', { n: group.on })}</>}
          </span>
        </span>
        {mark(group.worst)}
      </div>
      <ul className="mt-2 divide-y divide-ink-800">{rows.map(row)}</ul>

      <div className="mt-2 rounded-lg border border-ink-700/60 bg-ink-850/40 p-2">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={panel}
          className="flex w-full items-center justify-between gap-2 text-start">
          <span className="min-w-0 truncate text-[11px] text-fog-300">
            {tr('Languages')}<span className="text-fog-500"> · {nameList(shown)}</span>
          </span>
          <span className="shrink-0 text-[11px] text-fog-500">{open ? tr('Hide') : tr('Manage')}</span>
        </button>
        {open && (
          <div id={panel} className="mt-2">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 max-w-prose text-[11px] leading-relaxed text-fog-400">
                {tr('English is always on. Each language you add becomes its own source, such as MangaDex (ES-419), with its own Newest and Popular. Series you add from it are in that language.')}
              </p>
              <SaveState status={status} />
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={tr('Languages')}>
              {available.map((code) => {
                const always = code === 'en';
                const lit = always || on.includes(code);
                return (
                  <button key={code} type="button" onClick={() => toggle(code)} disabled={always} aria-pressed={lit}
                    title={always ? 'MangaDex' : `MangaDex (${code.toUpperCase()})`}
                    className={`chip whitespace-nowrap text-xs disabled:cursor-default ${lit ? 'chip-active' : ''}`}>
                    {lit && <span aria-hidden>✓</span>}
                    {languageName(code)}
                    {always && <span className="text-[10px] opacity-75">· {tr('always on')}</span>}
                  </button>
                );
              })}
              {!data && <span className="text-[11px] text-fog-500">{tr('Loading…')}</span>}
            </div>
            <p className="mt-2 max-w-prose text-[10px] leading-relaxed text-fog-500">
              {tr('All MangaDex sources share one rate limit: when MangaDex asks Uchiyomi to slow down, every language waits.')}
            </p>
          </div>
        )}
      </div>

      {/* ⚠️ On <body>: a `.card` blurs its backdrop, which makes it the containing block of a `fixed` dialog. */}
      {confirm && (
        <OnBody>
          <ConfirmDialog
            // Isolated (FSI … PDI): a title is a plain string, and without it an Arabic sentence's direction takes the
            // closing bracket of "MangaDex (ES-419)".
            title={tr('Turn off {name}?', { name: `\u2068${confirm.name}\u2069` })}
            body={confirm.used === 1
              ? tr('1 series from it will stop updating until you turn it back on, but stays readable.')
              : tr('{n} series from it will stop updating until you turn it back on, but stay readable.', { n: confirm.used })}
            confirmLabel={tr('Turn off')}
            onConfirm={() => { const code = confirm.code; setConfirm(null); commit(toggleLang(available, on, code)); }}
            onClose={() => setConfirm(null)}
          />
        </OnBody>
      )}
    </div>
  );
}

/**
 * Which language the sources that do not say are in (server_settings.unstated_lang): most added sites, and the
 * source packs. English unless this server's sites are in another. The same-language guard on automatic follows
 * reads it, so a server of Spanish sites set to English would follow none of them for its Spanish series.
 */
export function UnstatedLanguageCard() {
  const qc = useQueryClient();
  const { data } = useLanguageSettings();
  const { status, run } = useAutosave();
  const id = useId();
  // The language being saved; null otherwise, and the server's shows -- so a refusal puts the old one back by itself,
  // and the row says why where "✓ Saved" would be.
  const [picked, setPicked] = useState<string | null>(null);
  const pending = useRef(0);
  const [queue] = useState(serial);
  if (!data) return null;
  const value = picked ?? data.unstated_lang;
  // The languages MangaDex is offered in cover the sites people add; one set some other way stays offered.
  const codes = data.mangadex_available.includes(value) ? data.mangadex_available : [value, ...data.mangadex_available];
  const pick = (next: string) => {
    setPicked(next);
    pending.current++;
    const send = queue(() => api<LanguageSettings>(PATCH_URL, { method: 'PATCH', json: { unstatedLang: next } }));
    void run(async () => { qc.setQueryData(SETTINGS_KEY, await send); }).finally(() => { if (!--pending.current) setPicked(null); });
  };
  return (
    <div className="card grad-border wide p-4">
      <Row htmlFor={id} status={status}
        label={tr('Sites that do not say their language')}
        help={tr('Uchiyomi takes them to be in this language, and follows a source for a series automatically only when both are in the same language.')}>
        <select id={id} value={value} onChange={(e) => pick(e.target.value)} className="field w-auto">
          {codes.map((c) => <option key={c} value={c}>{languageName(c)}</option>)}
        </select>
      </Row>
    </div>
  );
}
