'use client';
// Admin → Sources: MangaDex in other languages (v0.52.0, #123), and the language of sites that do not say theirs.
//
// On the server MangaDex is one source per language (bff lib/sources/mangadex.ts): `mangadex` is English and always
// on, and every language turned on here becomes a source of its own, "MangaDex (ES-419)", with its own Newest and
// Popular. Since v0.54.0 each of them is a row of Your sources like any other source, tested and switched off in its
// own sheet; this is where the languages are chosen: Add sources' "MangaDex languages", folded until opened, and the
// same chips in a MangaDex source's sheet. Each tap is one PATCH of the whole list, saved as it is tapped -- no draft,
// no Save -- and "Saving… / ✓ Saved" says so beside the chips.
import { useEffect, useId, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useReducedMotion } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { activeLocale, languageName } from '@/lib/format';
import { Row, SaveState, useAutosave } from '@/components/settings';
import { offCost, opensMangadexLanguages, serial, toggleLang, type LanguageSource } from '@/lib/mangadexLangs';
import { useReduceEffects } from '@/lib/effects';
import { IcChevronRight } from '@/components/icons';
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

/**
 * The MangaDex languages: a fold that names the ones on ("Languages · English, Latin American Spanish") and opens on the
 * chips, or the chips alone, open, in a MangaDex source's sheet (`open`). Turning off a language series came from asks
 * first, inside this block -- it may sit in a sheet, and a dialog opened over a Sheet paints under it.
 */
export function MangadexLanguages({ sources, onSaved, open: always = false }: {
  /** MangaDex's sources as the sources overview lists them: how many series use each, for the question. */
  sources: readonly LanguageSource[];
  /** After the last save of a run of taps: the source lists and Health are asked again. */
  onSaved: () => void;
  /** Open, with no fold of its own: a MangaDex source's sheet, which is about nothing else. */
  open?: boolean;
}) {
  const qc = useQueryClient();
  const { data } = useLanguageSettings();
  const available = data?.mangadex_available ?? [];
  // Arrived by the add dialog's "Turn on more MangaDex languages" (`?card=mangadex`, v0.52.0): the languages unfolded
  // and on screen, once -- read in a lazy initialiser, as every address the console reads is (lib/useTabParam.ts), so a
  // refetch or a later tap never pulls the page back. Reintroduce by starting folded: "the languages do not unfold" in
  // mangadexLangs.test.ts.
  const params = useSearchParams();
  const [arrived] = useState(() => !always && opensMangadexLanguages(params));
  const [unfolded, setUnfolded] = useState(arrived);
  const open = always || unfolded;
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
    const cost = on.includes(code) ? offCost(sources, code) : null;
    if (cost) setConfirm({ code, ...cost });
    else commit(toggleLang(available, on, code));
  };

  const shown = ['en', ...on];
  const panel = useId();
  const chips = (
    <div id={panel} data-mangadex-langs>
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
            // Filter chips: a set of choices, the one chip shape the owner kept.
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
      {/* The question, here rather than in a dialog: this block may be inside a sheet, which a dialog would paint under. */}
      {confirm && (
        <div role="alertdialog" aria-label={tr('Turn off {name}?', { name: `⁨${confirm.name}⁩` })}
          className="mt-3 border-s-2 border-amber-400 bg-ink-850/80 py-2 pe-2 ps-2.5" data-mangadex-confirm>
          {/* Isolated (FSI … PDI): without it an Arabic sentence's direction takes the closing bracket of "MangaDex (ES-419)". */}
          <p className="text-sm text-fog-100">{tr('Turn off {name}?', { name: `⁨${confirm.name}⁩` })}</p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-fog-400">
            {confirm.used === 1
              ? tr('1 series from it will stop updating until you turn it back on, but stays readable.')
              : tr('{n} series from it will stop updating until you turn it back on, but stay readable.', { n: confirm.used })}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="btn-key btn-key-danger" data-mangadex-confirm-yes
              onClick={() => { const code = confirm.code; setConfirm(null); commit(toggleLang(available, on, code)); }}>{tr('Turn off')}</button>
            <button type="button" className="btn-key" onClick={() => setConfirm(null)}>{tr('Cancel')}</button>
          </div>
        </div>
      )}
    </div>
  );

  if (always) return <section aria-label={tr('MangaDex languages')} data-source-card="mangadex-languages">{chips}</section>;
  return (
    <section ref={cardRef} aria-label={tr('MangaDex languages')} data-source-card="mangadex" className="scroll-mt-4 lg:scroll-mt-20">
      <button type="button" onClick={() => setUnfolded(!unfolded)} aria-expanded={open} aria-controls={panel} data-mangadex-fold
        className="group flex w-full min-w-0 items-center gap-3 py-3 text-start">
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-fog-100">{tr('MangaDex languages')}</span>
          <span className="block truncate text-[11px] text-fog-500">{nameList(shown)}</span>
        </span>
        {/* Mirrored on the outer span and turned on the inner one: both on one pointed it up in Arabic. */}
        <span aria-hidden className="inline-grid shrink-0 text-fog-500 group-hover:text-fog-200 rtl:-scale-x-100">
          <IcChevronRight width={16} height={16} className={open ? 'rotate-90' : ''} />
        </span>
      </button>
      {open && <div className="pb-3">{chips}</div>}
    </section>
  );
}

/**
 * Which language the sources that do not say are in (server_settings.unstated_lang): most added sites, and the
 * source packs. English unless this server's sites are in another. The same-language guard on automatic follows
 * reads it, so a server of Spanish sites set to English would follow none of them for its Spanish series. A row of
 * Add sources since v0.54.0, where it was a card of its own.
 */
export function UnstatedLanguageRow() {
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
    <Row htmlFor={id} status={status} id="sources-unstated-language"
      label={tr('Sites that do not say their language')}
      help={tr('Uchiyomi takes them to be in this language, and follows a source for a series automatically only when both are in the same language.')}>
      <select id={id} value={value} onChange={(e) => pick(e.target.value)} className="field w-auto">
        {codes.map((c) => <option key={c} value={c}>{languageName(c)}</option>)}
      </select>
    </Row>
  );
}
