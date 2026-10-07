'use client';
// Edit details (v0.53.0): one series' own settings, in tabs, saved as they change.
//
// Until v0.53.0 this was SeriesEditModal in app/series/page.tsx, and the owner called it what it was: one narrow
// column of fifteen fields in no order; three ways of saving side by side -- Library, Language and Auto-update at
// once, Title to Always show only on a "Save details" key in the middle of the scroll, so an edit was easy to
// lose, and the art per action; native checkboxes and selects; a text "✕"; and the cover and the background at
// the very bottom with no picture of either. It speaks the settings kit now (components/settings.tsx), as Profile
// and Admin → Settings do: every field saves when it is changed or left, through `useAutosave`, and ONE SaveState
// in the header says how the latest save went (a SaveScope: a tick beside each of twenty fields is the noise the
// kit was made to remove).
//
// The art is a column at the start of every tab from md up -- what the series looks like is what an admin checks
// while editing it -- and a tab of its own on a phone, where a column has no room. Every tab stays mounted, the
// inactive ones `hidden`: a save in flight when its tab is left still reports to the header, and a half-typed
// genre or link is still there on the way back.
import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, img } from '@/lib/api';
import type { Series } from '@/lib/types';
import { languageName } from '@/lib/format';
import { languageChoices } from '@/lib/editions';
import { numLabel } from '@/lib/numbering';
import { useLayer } from '@/lib/layers';
import { useReduceEffects } from '@/lib/effects';
import { keys, t as tr } from '@/lib/i18n';
import { metaSaver, seedMeta, type SeriesMeta } from '@/lib/seriesMeta';
import { SERIES_TYPES, seriesTypeKey } from '@/lib/seriesTypes';
import { useToast } from './Toast';
import { msgOf } from './ConfirmDialog';
import { Backdrop, useRtl } from './ui';
import { ProgressRing } from './ProgressRing';
import { useContextMenu } from './ContextMenu';
import { useCheckNow } from './SourcesSheet';
import { IcX } from './icons';
import { LinkRow, Row, SaveScope, SaveState, Segmented, SwitchRow, TextRow, useAutosave, useSaveScope } from './settings';

/**
 * Put a path on the clipboard, and say so with the path in the notice (#136): copying is one tap, and the notice is
 * where the path can be read too. Isolated (FSI…PDI) so a path reads left to right inside an Arabic sentence. Where
 * the browser has no clipboard (plain http on a LAN) or refuses, the notice says where the file is instead. The
 * series page's chapter menu copies a chapter's file with it too.
 */
export async function copyPath(path: string, toast: ReturnType<typeof useToast>): Promise<void> {
  const shown = `\u2068${path}\u2069`;
  try {
    await navigator.clipboard.writeText(path);
    toast(tr('Copied: {path}', { path: shown }), 'success');
  } catch {
    toast(tr('Could not copy it. The path is {path}', { path: shown }), 'info');
  }
}

export type EditTab = 'details' | 'art' | 'reading' | 'updates' | 'files';
/** The tabs in order. Art is a tab below md only: from md up it is the column at the start of every tab. */
const TABS: readonly EditTab[] = ['details', 'art', 'reading', 'updates', 'files'];
const TAB_LABELS = keys('Details', 'Art', 'Reading', 'New chapters', 'Files');
/** Where the dialog becomes a centred panel with the art in a column (Tailwind's md). */
const WIDE = '(min-width: 768px)';

/** Komga's four directions, as the dialog offers them: what the server stores, and the label for each. */
const DIRECTION_LABELS = keys('Right to left', 'Left to right', 'Webtoon', 'Vertical');
const DIRECTIONS = (['RIGHT_TO_LEFT', 'LEFT_TO_RIGHT', 'WEBTOON', 'VERTICAL'] as const).map((v, i) => [v, DIRECTION_LABELS[i]] as const);

/**
 * What automatic currently means and what said so -- so an admin can see whether the files, the source or AniList
 * placed the series before deciding to overrule it.
 */
function autoDirectionLabel(d: Series['detectedDirection']): string {
  const label = DIRECTIONS.find(([v]) => v === d?.direction)?.[1];
  if (!d || !label) return tr('Automatic — not known, reads as a webtoon');
  const direction = tr(label);
  if (d.from === 'comicinfo') return tr('Automatic — {direction}, from the chapter files', { direction });
  if (d.from === 'anilist') return tr('Automatic — {direction}, from AniList', { direction });
  return tr('Automatic — {direction}, from the source', { direction });
}

/**
 * What "Automatic" means for the type now, and what said so (bff lib/seriesType.ts): a genre, the source, AniList,
 * or a Webtoon genre with nothing better.
 */
function autoTypeLabel(d: Series['detectedType']): string {
  if (!d) return tr('Automatic — not known');
  const type = tr(seriesTypeKey(d.type));
  if (d.from === 'genre' || d.from === 'webtoon') return tr('Automatic — {type}, from the genres', { type });
  if (d.from === 'anilist') return tr('Automatic — {type}, from AniList', { type });
  return tr('Automatic — {type}, from the source', { type });
}

/** The Automatic choice itself, short enough for a segment: what it reads as now, a webtoon when nothing has said. */
function autoDirectionChoice(d: Series['detectedDirection']): string {
  const label = DIRECTIONS.find(([v]) => v === d?.direction)?.[1] ?? DIRECTION_LABELS[2];
  return tr('Automatic · {direction}', { direction: tr(label) });
}

// The four the scanner itself writes from ComicInfo's PublishingStatus. A suggestion list rather than a hard enum:
// a file can carry anything, and rejecting it would reject Uchiyomi's own data -- "Something else…" keeps it.
const STATUSES = ['ONGOING', 'COMPLETED', 'HIATUS', 'CANCELLED'] as const;
const STATUS_LABELS = keys('Ongoing', 'Completed', 'Hiatus', 'Cancelled');
const OTHER_STATUS = '__other';
const AGES = [6, 10, 13, 15, 17, 18];
/** The ages offered, with a rating a file gave that is none of them (a ComicInfo 12+) in its place, so it shows. */
const ages = (current: string): number[] => {
  const n = Number(current);
  return current !== '' && Number.isInteger(n) && !AGES.includes(n) ? [...AGES, n].sort((a, b) => a - b) : AGES;
};

/**
 * The largest picture an upload takes. ⚠️ The route's body limit is sized from it (bff routes/admin.ts ART_BODY_LIMIT):
 * the picture travels base64 in JSON, a third larger, and the 12 MB limit it had refused everything between 9 and
 * 11 MB that this dialog had just said it would take.
 */
const ART_MAX_MB = 11;
const ART_MAX_BYTES = ART_MAX_MB * 1024 * 1024;
type ArtKind = 'cover' | 'banner';

/** Tab through the dialog and round again, never out of it: the page under a modal is not there to the keyboard. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]';
function keepFocusIn(panel: HTMLElement, e: KeyboardEvent): void {
  // Shown and in the tab order: a hidden tab's fields, the file input and a radio group's unchecked radios are not.
  const all = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0);
  if (!all.length) return;
  const first = all[0];
  const last = all[all.length - 1];
  const at = document.activeElement;
  if (!at || at === panel || !panel.contains(at)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
  else if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
}

export function SeriesEditor({ id, series, tab: opening = 'details', onClose, onSaved, onOpenSources, onNewBanner }: {
  id: string;
  series: Series;
  /** The tab it opens on: Details from its key, Reading from the Sources sheet's language Change. */
  tab?: EditTab;
  onClose: () => void;
  /** After any save, so the page refetches what it shows. */
  onSaved: () => void;
  /** Close this and open Sources & translations, where the page has that sheet. */
  onOpenSources?: () => void;
  /** The series page's New banner, the automatic banner's shuffle: one action, with its own notices. */
  onNewBanner?: () => Promise<void>;
}) {
  // On the notices' layer stack (lib/layers.ts), keeping the phone's nav band free as Modal does: below md the
  // sheet's last rows scroll clear of the bar, from md to lg the panel ends above it, and from lg up it ends 7 rem
  // above the bottom edge, clear of the notices' corner (web/test/notices.test.ts holds that) -- and starts below
  // the top bar, which paints over everything in <main> as the bottom nav does.
  useLayer('dialog', true, { navBandFree: true });
  const uid = useId();
  const rtl = useRtl();
  const plain = useReduceEffects();
  const still = useReducedMotion();
  const scope = useSaveScope();
  const [tab, setTab] = useState<EditTab>(opening);
  const [meta, setMeta] = useState<SeriesMeta>(() => seedMeta(series));
  const [saver] = useState(() => metaSaver(seedMeta(series), (body) => api(`/api/admin/series/${id}/meta`, { method: 'PUT', json: body }), setMeta));
  const saveMeta = (patch: Partial<SeriesMeta>) => saver.save(patch).then(() => { onSaved(); });

  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Read through a ref so the effect below runs once: callers pass a new `onClose` on every render.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Focus starts on the panel itself -- not a field, which would raise a phone's keyboard over half the sheet, and not a
  // tab, which would wear a focus ring nobody asked for -- so the first Tab lands on the close key and the next on the
  // open tab. It goes back to the key that opened the dialog when it closes. Escape closes it unless something inside
  // already used that Escape (a menu closing, a field putting an edit back, a link field folding away).
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === 'Escape') closeRef.current();
      else if (e.key === 'Tab' && panelRef.current) keepFocusIn(panelRef.current, e);
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); opener?.focus?.(); };
  }, []);
  // Art is no tab from md up (it is the column there): a phone turned sideways onto it lands on Details.
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const fit = () => { if (mq.matches) setTab((t) => (t === 'art' ? 'details' : t)); };
    fit();
    mq.addEventListener('change', fit);
    return () => mq.removeEventListener('change', fit);
  }, []);

  const open = (t: EditTab) => {
    if (t === tab) return;
    setTab(t);
    bodyRef.current?.scrollTo({ top: 0 });
  };
  // The tabs are one stop: the arrows move between the ones shown (Art is not, from md up), in reading order.
  const onTabKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const shown = [...(e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])].filter((b) => b.getClientRects().length > 0);
    const i = shown.indexOf(e.currentTarget);
    const n = shown.length;
    let next = -1;
    if (e.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) next = (i + 1) % n;
    else if (e.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) next = (i - 1 + n) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    if (next < 0 || !shown[next]) return;
    e.preventDefault();
    shown[next].focus();
    shown[next].click();
  };

  // A click that STARTED on the backdrop closes the dialog. Not one that only ended there: selecting a word in the
  // description and letting go past the panel's edge would otherwise throw the dialog away. A click with no pointer
  // (detail 0: the keyboard, a script) is taken as it comes.
  const downOnBackdrop = useRef(false);
  const fields: EditTab = tab === 'art' ? 'details' : tab;
  const shownTitle = meta.title || series.name;
  const paneId = (t: EditTab) => `${uid}-pane-${t}`;
  const tabId = (t: EditTab) => `${uid}-tab-${t}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink-950/70 backdrop-blur-xs md:items-center md:p-6 md:pb-[calc(5.5rem+env(safe-area-inset-bottom))] lg:pb-28 lg:pt-[5.5rem]"
      onPointerDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && (downOnBackdrop.current || e.detail === 0)) onClose(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        data-series-editor
        tabIndex={-1}
        className="glass-strong flex h-[calc(100dvh-max(1.5rem,env(safe-area-inset-top)))] w-full min-w-0 flex-col overflow-hidden rounded-t-3xl border border-ink-700 shadow-lift md:h-full md:max-h-[86vh] outline-hidden md:max-w-[880px] md:rounded-3xl"
      >
        <SaveScope report={scope.report}>
          <div className="flex items-start gap-3 px-4 pt-4 md:px-6 md:pt-5">
            <div className="min-w-0 flex-1">
              <h2 id={`${uid}-title`} className="font-display text-lg font-semibold leading-tight text-fog-50 md:text-xl">{tr('Edit details')}</h2>
              <p className="mt-0.5 line-clamp-2 break-words text-xs text-fog-500">
                <bdi dir="auto" className="text-fog-400">{shownTitle}</bdi> · {tr('Changes apply for everyone')}
              </p>
            </div>
            {/* The latest save's state, for the whole dialog. A long refusal is cut here (the kit's SaveState carries
                the whole sentence in its title and its live region) rather than pushing the title out at 390 px. */}
            <div data-edit-save={scope.status.kind} className="flex min-w-0 max-w-[45%] shrink justify-end self-center sm:max-w-none">
              <SaveState status={scope.status} />
            </div>
            <button type="button" onClick={onClose} aria-label={tr('Close')}
              className="-me-1 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ink-800/80 text-fog-300 transition-colors hover:text-fog-50">
              <IcX width={16} height={16} />
            </button>
          </div>

          {/* Text tabs with an accent underline, the Library's Series | Downloads. A row too long for a phone scrolls
              inside itself, never the page; the underline sits on the row's own inset line, which a scroller would
              clip if it hung over a border below it. */}
          <div role="tablist" aria-label={tr('Edit details')} data-lenis-prevent
            className="hide-scrollbar mt-3 flex shrink-0 items-end gap-5 overflow-x-auto px-4 shadow-[inset_0_-1px_0_var(--color-ink-800)] md:gap-6 md:px-6">
            {TABS.map((t, i) => {
              const on = t === tab;
              return (
                <button key={t} type="button" role="tab" id={tabId(t)} aria-selected={on} aria-controls={t === 'art' ? `${uid}-art` : paneId(t)}
                  tabIndex={on ? 0 : -1} data-edit-tab={t} onClick={() => open(t)} onKeyDown={onTabKey}
                  className={`relative shrink-0 whitespace-nowrap pb-2.5 pt-1 text-sm font-semibold transition-colors ${on ? 'text-fog-50' : 'text-fog-500 hover:text-fog-200'} ${t === 'art' ? 'md:hidden' : ''}`}>
                  {tr(TAB_LABELS[i])}
                  {on && (
                    <motion.span layoutId={`${uid}-underline`} aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 rounded-sm bg-accent"
                      transition={plain || still ? { duration: 0 } : { type: 'spring', stiffness: 520, damping: 40 }} />
                  )}
                </button>
              );
            })}
          </div>

          <div ref={bodyRef} data-lenis-prevent
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[calc(6rem+env(safe-area-inset-bottom))] pt-4 md:px-6 md:pb-6 md:pt-5">
            <div className="md:grid md:grid-cols-[15rem_minmax(0,1fr)] md:items-start md:gap-7">
              {/* The art: the start column from md up, the Art tab below it. */}
              <section id={`${uid}-art`} role={tab === 'art' ? 'tabpanel' : 'region'} aria-labelledby={tab === 'art' ? tabId('art') : undefined}
                aria-label={tab === 'art' ? undefined : tr('Art')} data-edit-pane="art" className={`${tab === 'art' ? '' : 'hidden'} min-w-0 md:block`}>
                <ArtPanel id={id} series={series} onSaved={onSaved} onNewBanner={onNewBanner} />
              </section>
              <div className={`min-w-0 [&_.field]:max-w-none ${tab === 'art' ? 'hidden md:block' : ''}`}>
                <Pane id={paneId('details')} tab={tabId('details')} shown={fields === 'details'} name="details">
                  <DetailsPane meta={meta} save={saveMeta} />
                </Pane>
                <Pane id={paneId('reading')} tab={tabId('reading')} shown={fields === 'reading'} name="reading">
                  <ReadingPane id={id} series={series} meta={meta} save={saveMeta} onSaved={onSaved} />
                </Pane>
                <Pane id={paneId('updates')} tab={tabId('updates')} shown={fields === 'updates'} name="updates">
                  <UpdatesPane id={id} series={series} onSaved={onSaved} onOpenSources={onOpenSources} />
                </Pane>
                <Pane id={paneId('files')} tab={tabId('files')} shown={fields === 'files'} name="files">
                  <FilesPane id={id} series={series} onSaved={onSaved} />
                </Pane>
              </div>
            </div>
          </div>
        </SaveScope>
      </div>
    </div>
  );
}

function Pane({ id, tab, shown, name, children }: { id: string; tab: string; shown: boolean; name: EditTab; children: ReactNode }) {
  return <div id={id} role="tabpanel" aria-labelledby={tab} hidden={!shown} data-edit-pane={name}>{children}</div>;
}

/* =============================== Details =============================== */

function DetailsPane({ meta, save }: { meta: SeriesMeta; save: (p: Partial<SeriesMeta>) => Promise<void> }) {
  // The route's own caps (bff routes/admin.ts), so a field cannot hold what the save would refuse.
  return (
    <>
      <TextRow id="edit-title" label={tr('Title')} value={meta.title} dir="auto" maxLength={300} placeholder={tr('From the files')}
        onSave={(title) => save({ title })} />
      <TextAreaRow id="edit-summary" label={tr('Description')} value={meta.summary} maxLength={8000} onSave={(summary) => save({ summary })} />
      <TextRow id="edit-author" label={tr('Author')} value={meta.author} dir="auto" maxLength={300} placeholder={tr('From the files')}
        onSave={(author) => save({ author })} />
      <StatusRow value={meta.status} onSave={(status) => save({ status })} />
      <GenresRow genres={meta.genres} onSave={(genres) => save({ genres })} />
    </>
  );
}

/**
 * The description: TextRow's rules for a paragraph. It saves when it is left -- Enter is a new line here, never a
 * save -- and Escape puts the saved text back, as a handled Escape that leaves the dialog open.
 */
function TextAreaRow({ id, label, value, maxLength, onSave }: { id: string; label: string; value: string; maxLength: number; onSave: (v: string) => Promise<void> }) {
  const { run } = useAutosave();
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const last = useRef(value);
  // Keyed on `value` alone, for the reason given on TextRow.
  useEffect(() => {
    last.current = value;
    if (!focused.current) setDraft(value);
  }, [value]);
  const commit = () => {
    const next = draft.trim();
    if (next === last.current) return;
    last.current = next;
    void run(async () => {
      try { await onSave(next); } catch (e) { last.current = value; throw e; }
    });
  };
  return (
    <Row label={label} htmlFor={id} stacked>
      <textarea id={id} dir="auto" rows={5} maxLength={maxLength} value={draft}
        className="field resize-y leading-relaxed"
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => { focused.current = true; }}
        onBlur={() => { focused.current = false; commit(); }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && draft !== last.current) { e.preventDefault(); setDraft(last.current); }
        }} />
    </Row>
  );
}

/**
 * Status: "From the files", the four common ones, and Something else… for anything a file or a source page said.
 * The whole width of the pane, since six choices wrapped beside the author at 880 px. Picking Something else… only
 * opens its field; the save is the field's, on leaving it or Enter, and a field left empty folds away again onto
 * what is saved.
 */
function StatusRow({ value, onSave }: { value: string; onSave: (v: string) => Promise<void> }) {
  const { run } = useAutosave();
  const known = (STATUSES as readonly string[]).includes(value.toUpperCase()) ? value.toUpperCase() : null;
  const [other, setOther] = useState(!!value && !known);
  const [draft, setDraft] = useState(known ? '' : value);
  const field = useRef<HTMLInputElement>(null);
  const opened = useRef(false);
  useEffect(() => {
    if (other && opened.current) field.current?.focus();
    opened.current = false;
  }, [other]);
  const picked = other || (value && !known) ? OTHER_STATUS : known ?? '';
  const choose = (v: string) => {
    if (v === OTHER_STATUS) { opened.current = true; setDraft(known ? '' : value); setOther(true); return; }
    setOther(false);
    void run(() => onSave(v));
  };
  const commit = () => {
    const next = draft.trim();
    if (!next) { setDraft(known ? '' : value); if (known || !value) setOther(false); return; }
    if (next === value) return;
    void run(() => onSave(next));
  };
  const options = [
    { value: '', label: tr('From the files') },
    ...STATUSES.map((v, i) => ({ value: v as string, label: tr(STATUS_LABELS[i]) })),
    { value: OTHER_STATUS, label: tr('Something else…') },
  ];
  return (
    <Row label={tr('Status')} stacked>
      <Segmented square label={tr('Status')} value={picked} options={options} onChange={choose} />
      {picked === OTHER_STATUS && (
        <input ref={field} aria-label={tr('Status')} dir="auto" maxLength={60} value={draft} placeholder={tr('Status')}
          className="field mt-2"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); return; }
            if (e.key !== 'Escape') return;
            // Puts the saved words back, or folds a field just opened onto a status that is one of the choices.
            const saved = known ? '' : value;
            if (draft !== saved) setDraft(saved);
            else if (known || !value) setOther(false);
            else return;
            e.preventDefault();
          }} />
      )}
    </Row>
  );
}

/**
 * Genres as chips: Enter or a comma adds one, Backspace in an empty field takes the last off, and each change saves.
 * A genre is a set member -- "action" beside "Action" is one -- as the route stores them.
 */
function GenresRow({ genres, onSave }: { genres: string[]; onSave: (g: string[]) => Promise<void> }) {
  const { run } = useAutosave();
  const fid = useId();
  const [draft, setDraft] = useState('');
  const save = (next: string[]) => { void run(() => onSave(next)); };
  const add = (raw: string) => {
    const t = raw.trim().replace(/,$/, '').trim();
    setDraft('');
    if (!t || genres.some((g) => g.toLowerCase() === t.toLowerCase())) return;
    save([...genres, t]);
  };
  return (
    <Row label={tr('Genres')} htmlFor={fid} stacked
      help={tr('Genres drive the Library’s genre filters and the recommendation rails. Clearing them all means this series genuinely has none.')}>
      <div className="flex w-full flex-wrap gap-1.5 rounded-xl border border-ink-700 bg-ink-850 p-1.5 transition-colors focus-within:border-accent">
        {genres.map((g) => (
          <span key={g} className="inline-flex min-w-0 items-center gap-0.5 rounded-md bg-ink-700/80 py-0.5 pe-0.5 ps-2 text-xs text-fog-100">
            <bdi dir="auto" className="truncate">{g}</bdi>
            <button type="button" onClick={() => save(genres.filter((x) => x !== g))} aria-label={tr('Remove {name}', { name: g })}
              className="grid h-6 w-6 shrink-0 place-items-center rounded text-fog-500 transition-colors hover:text-rose-300">
              <IcX width={12} height={12} />
            </button>
          </span>
        ))}
        <input id={fid} value={draft} dir="auto" maxLength={60} placeholder={tr('Add a genre…')}
          className="min-w-[8rem] flex-1 bg-transparent px-1.5 py-1 text-sm text-fog-50 outline-hidden placeholder:text-fog-500"
          onChange={(e) => (e.target.value.endsWith(',') ? add(e.target.value) : setDraft(e.target.value))}
          onBlur={() => add(draft)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); add(draft); }
            else if (e.key === 'Backspace' && !draft && genres.length) save(genres.slice(0, -1));
            else if (e.key === 'Escape' && draft) { e.preventDefault(); setDraft(''); }
          }} />
      </div>
    </Row>
  );
}

/* =============================== Reading =============================== */

function ReadingPane({ id, series, meta, save, onSaved }: {
  id: string; series: Series; meta: SeriesMeta; save: (p: Partial<SeriesMeta>) => Promise<void>; onSaved: () => void;
}) {
  return (
    <>
      <ChoiceRow narrow label={tr('Reading direction')} value={meta.readingDirection}
        help={<>
          {tr('What “Series default” in the reader follows. Automatic takes it from the chapter files, then the source, then AniList.')}
          <span data-auto-direction className="mt-0.5 block text-fog-400">{autoDirectionLabel(series.detectedDirection)}</span>
        </>}
        options={[{ value: '', label: autoDirectionChoice(series.detectedDirection) }, ...DIRECTIONS.map(([v, label]) => ({ value: v as string, label: tr(label) }))]}
        onPick={(readingDirection) => save({ readingDirection })} />
      {/* What kind of comic it is: the notice-chapter switches in Admin → Settings go by it (bff lib/noticeChapters.ts). */}
      <ChoiceRow narrow label={tr('Series type')} value={meta.seriesType}
        help={<>
          {tr('What the notice-chapter switches in Settings go by. Automatic takes it from the genres, then the source, then AniList.')}
          <span data-auto-type className="mt-0.5 block text-fog-400">{autoTypeLabel(series.detectedType)}</span>
        </>}
        options={[{ value: '', label: tr('Automatic') }, ...SERIES_TYPES.filter((v) => v !== 'unknown').map((v) => ({ value: v as string, label: tr(seriesTypeKey(v)) }))]}
        onPick={(seriesType) => save({ seriesType })} />
      <LanguageRow id={id} series={series} onSaved={onSaved} />
      <ChoiceRow narrow label={tr('Age rating')} value={meta.ageRating}
        help={tr('Members with an age limit below this will not see the series anywhere: not in the library, search, the reader, or an external OPDS app.')}
        options={[{ value: '', label: tr('Not rated') }, ...ages(meta.ageRating).map((a) => ({ value: String(a), label: `${a}+` }))]}
        onPick={(ageRating) => save({ ageRating })} />
      {/* "Always show": kept on the shelf while "Show 18+" is off, whatever makes it 18+ (its genres, its rating, its
          library). Surfacing only: who may open the series is still the age rating above. */}
      <SwitchRow label={tr('Always show')} on={meta.adultExempt}
        help={tr('Keep this series on the shelf while “Show 18+” is off, even if it or one of its genres is 18+.')}
        onChange={(adultExempt) => save({ adultExempt })} />
    </>
  );
}

/**
 * A few named values, saved as one is picked: the kit's Segmented, squared (no capsules on this surface). `narrow`:
 * below sm the group would wrap into rows of segments, so a phone gets the same choice as a select.
 */
function ChoiceRow({ label, help, value, options, narrow, onPick }: {
  label: string; help?: ReactNode; value: string; options: ReadonlyArray<{ value: string; label: string }>; narrow?: boolean;
  onPick: (v: string) => Promise<unknown>;
}) {
  const { run } = useAutosave();
  const sid = useId();
  const pick = (v: string) => { void run(() => onPick(v)); };
  return (
    <Row label={label} help={help} htmlFor={narrow ? sid : undefined} stacked>
      <div className={narrow ? 'hidden sm:block' : undefined}>
        <Segmented square label={label} value={value} options={options} onChange={pick} />
      </div>
      {narrow && (
        <select id={sid} value={value} onChange={(e) => pick(e.target.value)} className="field sm:hidden">
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
    </Row>
  );
}

/**
 * The language the series is in (v0.52.0): what decides which sources may be followed for it automatically, and
 * which edition of a work it is. '' is automatic -- what its source declares, else the server's unstated language --
 * which an edition does not have: every edition of a work states its language.
 */
function LanguageRow({ id, series, onSaved }: { id: string; series: Series; onSaved: () => void }) {
  const { run } = useAutosave();
  const sid = useId();
  const edition = (series.edition?.editions?.length ?? 0) > 1;
  const [lang, setLang] = useState<string>(series.langStated ? series.lang ?? '' : '');
  const langs = useMemo(() => languageChoices([series.lang, series.langAuto], languageName), [series.lang, series.langAuto]);
  const pick = async (next: string) => {
    const prev = lang;
    setLang(next);
    if (await run(() => api(`/api/admin/series/${id}`, { method: 'PATCH', json: { lang: next || null } }))) onSaved();
    else setLang(prev);
  };
  return (
    <Row label={tr('Language')} htmlFor={sid} stacked
      help={tr('The language this series is in. Sources in another language are never followed for it automatically.')}>
      <select id={sid} value={lang} onChange={(e) => void pick(e.target.value)} className="field">
        {!edition && (
          <option value="">{series.langAuto ? tr('Automatic ({language})', { language: languageName(series.langAuto) }) : tr('Automatic')}</option>
        )}
        {langs.map((l) => <option key={l} value={l}>{languageName(l)}</option>)}
      </select>
    </Row>
  );
}

/* =============================== Updates =============================== */

function UpdatesPane({ id, series, onSaved, onOpenSources }: { id: string; series: Series; onSaved: () => void; onOpenSources?: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [autoUpdate, setAutoUpdate] = useState(series.autoUpdate !== false);
  // The same Check now as the Sources & translations sheet's chip, so the two report alike.
  const { checking, checkNow } = useCheckNow(id, onSaved);

  // "Mark caught up" (discussion #72): the floor of a "Nothing yet" add, set on a series already here -- what is out
  // now is never fetched, what comes out next is. Asked first, in place, with what it does; then said, with Undo,
  // which puts the floor the answer reported back.
  const [caught, setCaught] = useState<null | 'asking' | { floor: number | null; previous: number | null }>(null);
  const [caughtBusy, setCaughtBusy] = useState(false);
  const floorTo = async (chapterFloor: 'caught_up' | number | null) => {
    setCaughtBusy(true);
    try {
      const r = await api<{ chapterFloor: { floor: number | null; previous: number | null } }>(`/api/admin/series/${id}`, { method: 'PATCH', json: { chapterFloor } });
      // The ghost rows read the floor ("older chapters"), so the list under the dialog follows at once.
      for (const k of [['series-listing', id], ['series', id]]) qc.invalidateQueries({ queryKey: k });
      setCaught(chapterFloor === 'caught_up' ? r.chapterFloor : null);
      toast(chapterFloor === 'caught_up' ? tr('Marked caught up') : tr('Undone'), 'success');
    } catch (e) {
      toast(msgOf(e, tr('Could not change that')), 'error');
      if (chapterFloor === 'caught_up') setCaught(null);
    }
    setCaughtBusy(false);
  };
  // The floor sits a hair above the newest chapter (bff: max + 0.001); the sentence names that chapter.
  const caughtNewest = caught && typeof caught === 'object' && caught.floor != null ? numLabel(caught.floor - 0.001) : null;

  return (
    <>
      <SwitchRow label={tr('Auto-update new chapters')} on={autoUpdate}
        help={tr('The scheduled check fetches new chapters for this series.')}
        onChange={async (next) => {
          await api(`/api/admin/series/${id}`, { method: 'PATCH', json: { autoUpdate: next } });
          setAutoUpdate(next);
          onSaved();
        }} />
      <div className="flex flex-wrap items-start gap-2 py-3">
        <button type="button" onClick={checkNow} disabled={checking} data-check-now className="btn-key">
          {checking && <ProgressRing progress="spin" size={14} />}
          {checking ? tr('Checking…') : tr('Check for new chapters now')}
        </button>
        {/* Mark caught up (v0.52.0): only for a series with a source to fetch from. Its key sits beside Check now;
            the question and the answer take the row under them. */}
        {!!series.sources?.length && (
          <div data-caught-up={caught === null ? 'idle' : caught === 'asking' ? 'asking' : 'done'} className={caught === null ? 'contents' : 'basis-full'}>
            {caught === null && (
              <button type="button" onClick={() => setCaught('asking')} className="btn-key">{tr('Mark caught up')}</button>
            )}
            {caught === 'asking' && (
              <div className="rounded-xl border border-ink-700 bg-ink-900/40 p-3">
                <p className="max-w-prose text-[11px] leading-relaxed text-fog-300">
                  {tr('Chapters already out are not fetched; only new ones are, from the next check. Chapters already here stay, and older ones can still be fetched from the chapter list.')}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" onClick={() => void floorTo('caught_up')} disabled={caughtBusy} className="btn-key btn-key-primary">{tr('Mark caught up')}</button>
                  <button type="button" onClick={() => setCaught(null)} disabled={caughtBusy} className="btn-key">{tr('Cancel')}</button>
                </div>
              </div>
            )}
            {caught !== null && caught !== 'asking' && (
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-relaxed text-fog-300">
                <span>{caughtNewest ? tr('Caught up: only chapters after {number} are fetched.', { number: caughtNewest }) : tr('Marked caught up')}</span>
                <button type="button" onClick={() => void floorTo(caught.previous)} disabled={caughtBusy} className="btn-key">{tr('Undo')}</button>
              </p>
            )}
          </div>
        )}
      </div>
      {/* The sources (with their × to stop following one) and the Prefer / Block / patience controls live in the
          Sources & translations sheet, beside the statistics they are decided from. A way there where the page can
          open it, else one line saying where they went, so an admin who learned them here is not left to conclude
          they are gone. */}
      {onOpenSources
        ? <LinkRow label={tr('Sources & translations')} help={tr('Where its chapters come from, and which translation groups come first.')} onClick={onOpenSources} />
        : <p className="py-3 text-[11px] text-fog-500">{tr('Translation groups are ranked in Sources & translations')}</p>}
    </>
  );
}

/* =============================== Files =============================== */

function FilesPane({ id, series, onSaved }: { id: string; series: Series; onSaved: () => void }) {
  const toast = useToast();
  return (
    <>
      <LibraryRow id={id} series={series} onSaved={onSaved} />
      {/* Where it is on disk (#136): the folder as full paths, one per root its chapters are under, each copied with
          one tap. LTR whatever the page's direction: a path is not a sentence. */}
      {!!series.paths?.length && (
        <Row label={tr('Folder on the server')} stacked>
          <div data-series-paths className="space-y-1.5">
            {series.paths.map((path) => (
              <div key={path} className="flex min-w-0 items-start gap-2">
                <code dir="ltr" className="min-w-0 flex-1 select-all break-all rounded-lg bg-ink-900/60 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-fog-200">{path}</code>
                <button type="button" onClick={() => void copyPath(path, toast)} className="btn-key shrink-0">{tr('Copy')}</button>
              </div>
            ))}
          </div>
        </Row>
      )}
    </>
  );
}

/**
 * Which library this series is filed under. `''` means the folder rule decides, which is the default and what almost
 * every series should stay on -- picking one explicitly is a decision that then survives rescans, new libraries, and
 * re-pathing an existing one, which is the whole point and also the reason not to do it by accident.
 */
function LibraryRow({ id, series, onSaved }: { id: string; series: Series; onSaved: () => void }) {
  const { run } = useAutosave();
  const sid = useId();
  const [lib, setLib] = useState<string>(series.libraryPinned ? series.libraryId : '');
  const { data: libs } = useQuery({
    queryKey: ['admin-libraries'],
    queryFn: () => api<{ content: { id: string; name: string; age_rating: number | null }[] }>('/api/admin/libraries'),
  });
  const pick = async (next: string) => {
    const prev = lib;
    setLib(next);
    if (await run(() => api(`/api/admin/series/${id}/library`, { method: 'POST', json: { libraryId: next || null } }))) onSaved();
    else setLib(prev);
  };
  return (
    <Row label={tr('Library')} htmlFor={sid} stacked
      help={lib ? tr('Filed here by hand. Rescans and new libraries will leave it alone.') : tr('Whichever library covers this folder, most specific first.')}>
      <select id={sid} value={lib} onChange={(e) => void pick(e.target.value)} className="field">
        <option value="">{tr('Automatic — follow the folder')}</option>
        {(libs?.content ?? []).map((l) => (
          <option key={l.id} value={l.id}>{l.name}{l.age_rating != null ? ` (${l.age_rating}+)` : ''}</option>
        ))}
      </select>
    </Row>
  );
}

/* =============================== Art =============================== */

/** Whether a dropped thing carries files (a dragged link or text does not, and is left to the browser). */
const carriesFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
const dataUrlOf = (f: File) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result));
  r.onerror = () => rej(new Error('read'));
  r.readAsDataURL(f);
});
const webLink = (s: string): boolean => {
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
};

/**
 * A refusal in the reader's words. The art route answers in English with a code (bff routes/admin.ts): a file that
 * is no image, and a link that is no link, each get their own sentence; anything else is the plain failure.
 */
function artRefusal(e: unknown, kind: ArtKind): string {
  let code: string | null = null;
  try { code = e instanceof ApiError ? (JSON.parse(e.body)?.error ?? null) : null; } catch { /* not JSON: the plain failure */ }
  if (code === 'bad_image') return tr('That file is not an image this server can read.');
  if (code === 'no_url' || code === 'bad_request') return tr('Paste a full link to an image, starting with https://');
  if (e instanceof ApiError && e.status === 413) return tr('That image is over {n} MB. Pick a smaller one.', { n: ART_MAX_MB });
  return kind === 'cover' ? tr('Could not change the cover') : tr('Could not change the banner');
}

const IcUpload = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 16V4M6 10l6-6 6 6M5 20h14" />
  </svg>
);
const IcMore = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
  </svg>
);

/**
 * series.overrides.cover when an admin chose Use the first page (v0.55.7, #168; bff lib/seriesArt.ts FIRST_PAGE): the
 * cover is the series' own first page for good, and its art is its own pages -- nothing found online replaces them.
 */
export const FIRST_PAGE_COVER = 'first_page';

/**
 * What the cover's ⋯ offers (v0.55.7): Use the first page, unless it already is; Reset to automatic, only over an
 * admin's choice. Every state leaves one of the two to press, so the ⋯ is always there: a menu of nothing but greyed
 * items takes no focus, and the Escape meant to close it closed the dialog under it. Reintroduce Use the first page as
 * always on: "a cover that is the first page offers it again" in seriesEditor.test.ts fails.
 */
export function coverChoices(cover: string | null | undefined): { firstPage: boolean; reset: boolean } {
  return { firstPage: cover !== FIRST_PAGE_COVER, reset: !!cover };
}

/**
 * The cover and the background, each as the series page shows it, with its keys under it.
 *
 * - The cover at 2:3, the poster's own picture; the background as the page's banner draws it -- a real banner
 *   sharp (v0.53.0's style=banner), else the automatic one -- through the page's own <Backdrop>, so what is judged
 *   here is what readers see. Both carry the series' art version, which every change bumps.
 * - Upload is a file input, and an image dropped on a preview is the same upload. From a link sets the address the
 *   server fetches the art from (an inline field, Enter or Set). Reset to automatic hands it back to the source,
 *   AniList or the first page -- AniList's only from an entry with the series' name since v0.55.7 (#168), and a line
 *   under the cover says so while it is automatic. Use the first page (v0.55.7) makes the series' own first page its
 *   cover for good. New banner shuffles the automatic banner, only while there is one.
 * - One thing at a time: while one works its preview is covered and every art key waits (a ring that stands still
 *   under Reduce effects and reduced motion, ProgressRing's rule). The notices say how it went, in words.
 */
function ArtPanel({ id, series, onSaved, onNewBanner }: { id: string; series: Series; onSaved: () => void; onNewBanner?: () => Promise<void> }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<ArtKind | null>(null);
  const [linkFor, setLinkFor] = useState<ArtKind | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const fileFor = useRef<ArtKind>('cover');
  const ov = series.overrides;
  const word = (kind: ArtKind, cover: string, banner: string) => (kind === 'cover' ? cover : banner);

  const change = async (kind: ArtKind, body: Record<string, unknown>, done: string): Promise<boolean> => {
    setBusy(kind);
    try {
      await api(`/api/admin/series/${id}/art`, { method: 'PUT', json: { kind, ...body } });
      // The pictures follow the series' art version, which the refetch brings: the preview stays covered until it
      // has, rather than showing the old art as if the change had not taken.
      onSaved();
      await qc.refetchQueries({ queryKey: ['series', id] }, { cancelRefetch: false }).catch(() => {});
      toast(done, 'success');
      return true;
    } catch (e) {
      toast(artRefusal(e, kind), 'error');
      return false;
    } finally {
      setBusy(null);
    }
  };
  const upload = async (kind: ArtKind, f: File) => {
    if (busy) return;
    if (!f.type.startsWith('image/')) { toast(tr('That file is not an image this server can read.'), 'error'); return; }
    if (f.size > ART_MAX_BYTES) { toast(tr('That image is over {n} MB. Pick a smaller one.', { n: ART_MAX_MB }), 'error'); return; }
    setBusy(kind);
    let dataUrl: string;
    try { dataUrl = await dataUrlOf(f); } catch { setBusy(null); toast(tr('That file is not an image this server can read.'), 'error'); return; }
    await change(kind, { mode: 'upload', dataUrl }, word(kind, tr('Cover updated'), tr('Banner updated')));
  };
  const fromLink = async (kind: ArtKind, raw: string) => {
    const url = raw.trim();
    if (!webLink(url)) { toast(tr('Paste a full link to an image, starting with https://'), 'error'); return; }
    if (await change(kind, { mode: 'url', url }, word(kind, tr('Cover updated'), tr('Banner updated')))) setLinkFor(null);
  };
  const reset = (kind: ArtKind) => change(kind, { mode: 'reset' }, word(kind, tr('Cover reset to automatic'), tr('Banner reset to automatic')));
  const firstPage = () => change('cover', { mode: 'first_page' }, tr('Cover updated'));
  const shuffle = async () => {
    if (!onNewBanner || busy) return;
    setBusy('banner');
    try { await onNewBanner(); } finally { setBusy(null); }
  };
  const choose = (kind: ArtKind) => { fileFor.current = kind; file.current?.click(); };

  // Reset is offered only where there is something of the admin's to take back, and Use the first page only where the
  // cover is not that already (coverChoices): one of them always, so the ⋯ is always there.
  const can = coverChoices(ov?.cover);
  const coverMenu = useContextMenu(() => [
    { label: tr('Use the first page'), onSelect: () => void firstPage(), disabled: !can.firstPage, hook: 'cover-first-page' },
    { label: tr('Reset to automatic'), onSelect: () => void reset('cover'), disabled: !can.reset, hook: 'cover-reset' },
  ], { label: tr('More cover options') });
  const bannerMenu = useContextMenu(() => [
    { label: tr('From a link'), onSelect: () => setLinkFor('banner') },
    { label: tr('Reset to automatic'), onSelect: () => void reset('banner'), disabled: !ov?.banner },
  ], { label: tr('More banner options') });

  return (
    <div className="space-y-5">
      <div>
        <h3 className="mb-2 text-sm text-fog-100">{tr('Cover')}</h3>
        <ArtPreview kind="cover" busy={busy === 'cover'} onFile={(f) => void upload('cover', f)}
          className="aspect-[2/3] w-40 rounded-2xl md:w-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={img.seriesThumb(id, series.artVersion, 800)} alt={tr('Cover')} className="absolute inset-0 h-full w-full object-cover" />
        </ArtPreview>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button type="button" data-art-upload="cover" disabled={!!busy} onClick={() => choose('cover')} className="btn-key"><IcUpload />{tr('Upload')}</button>
          <button type="button" data-art-link="cover" aria-expanded={linkFor === 'cover'} disabled={!!busy}
            onClick={() => setLinkFor(linkFor === 'cover' ? null : 'cover')} className="btn-key">{tr('From a link')}</button>
          <button type="button" data-art-more="cover" aria-label={tr('More cover options')} aria-haspopup="menu" aria-expanded={coverMenu.open}
            disabled={!!busy} onClick={(e) => coverMenu.openFrom(e.currentTarget)} className="btn-key w-8 px-0"><IcMore /></button>
        </div>
        {linkFor === 'cover' && <LinkField kind="cover" busy={busy === 'cover'} onSet={(u) => void fromLink('cover', u)} onCancel={() => setLinkFor(null)} />}
        {/* What the cover is when nobody chose one -- what Reset to automatic gives back -- and the one choice that stays
            put whatever is found online. An upload or a link needs no words: it is the picture above. */}
        {(ov?.cover === FIRST_PAGE_COVER || !ov?.cover) && (
          <p data-art-cover-note className="mt-2 text-[11px] leading-relaxed text-fog-500">
            {ov?.cover === FIRST_PAGE_COVER
              ? tr('The first page, by your choice: nothing found online replaces it.')
              : tr('Automatic: the source’s cover, or AniList’s when its entry has the same name, else the first page.')}
          </p>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-sm text-fog-100">{tr('Banner')}</h3>
        <ArtPreview kind="banner" busy={busy === 'banner'} onFile={(f) => void upload('banner', f)} className="aspect-[8/3] w-full rounded-xl">
          <Backdrop seriesId={id} genres={series.metadata?.genres} version={series.artVersion} autoHero={series.autoHero} banner className="absolute inset-0" />
        </ArtPreview>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button type="button" data-art-upload="banner" disabled={!!busy} onClick={() => choose('banner')} className="btn-key"><IcUpload />{tr('Upload')}</button>
          {/* Only while the background is an automatic one: a real banner is replaced or reset, not shuffled. */}
          {series.autoHero && onNewBanner && (
            <button type="button" data-art-new-banner disabled={!!busy} onClick={() => void shuffle()} className="btn-key">{tr('New banner')}</button>
          )}
          <button type="button" data-art-more="banner" aria-label={tr('More banner options')} aria-haspopup="menu" aria-expanded={bannerMenu.open}
            disabled={!!busy} onClick={(e) => bannerMenu.openFrom(e.currentTarget)} className="btn-key w-8 px-0"><IcMore /></button>
        </div>
        {linkFor === 'banner' && <LinkField kind="banner" busy={busy === 'banner'} onSet={(u) => void fromLink('banner', u)} onCancel={() => setLinkFor(null)} />}
      </div>

      <div className="space-y-1 text-[11px] leading-relaxed text-fog-500">
        <p>{tr('Images up to {n} MB. You can also drop one onto a preview.', { n: ART_MAX_MB })}</p>
        <p>{tr('Manual AniList actions can contact AniList even when automatic lookups are off.')}</p>
      </div>
      <FilePicker inputRef={file} onPick={(f) => void upload(fileFor.current, f)} />
      {coverMenu.element}
      {bannerMenu.element}
    </div>
  );
}

/** One preview: a drop target for an image, covered by a still-or-turning ring while its change works. */
function ArtPreview({ kind, busy, onFile, className, children }: { kind: ArtKind; busy: boolean; onFile: (f: File) => void; className: string; children: ReactNode }) {
  const [over, setOver] = useState(false);
  return (
    <div data-art-preview={kind} data-busy={busy ? 'true' : 'false'} aria-busy={busy}
      onDragOver={(e) => { if (!carriesFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(true); }}
      // Leaving for the picture inside is not leaving the preview.
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }}
      onDrop={(e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f && !busy) onFile(f);
      }}
      className={`relative overflow-hidden border bg-ink-900 shadow-lift transition-colors ${over ? 'border-accent' : 'border-ink-700'} ${className}`}>
      {children}
      {busy && (
        <div className="absolute inset-0 grid place-items-center bg-ink-950/65">
          <ProgressRing progress="spin" size="cover" onCover label={tr('Working…')} />
        </div>
      )}
    </div>
  );
}

/** From a link: the address, then Enter or Set. Escape folds it away -- a handled Escape, so the dialog stays. */
function LinkField({ kind, busy, onSet, onCancel }: { kind: ArtKind; busy: boolean; onSet: (url: string) => void; onCancel: () => void }) {
  const [url, setUrl] = useState('');
  const fid = useId();
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { field.current?.focus(); }, []);
  return (
    <div data-art-url={kind} className="mt-2 flex items-center gap-1.5">
      <label htmlFor={fid} className="sr-only">{tr('Image link')}</label>
      <input ref={field} id={fid} type="url" inputMode="url" dir="ltr" autoCapitalize="none" autoComplete="off" spellCheck={false}
        value={url} placeholder="https://…" className="field min-w-0 flex-1 py-1.5 text-xs"
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); if (url.trim() && !busy) onSet(url); }
          else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }} />
      <button type="button" data-art-set={kind} disabled={busy || !url.trim()} onClick={() => onSet(url)} className="btn-key btn-key-primary">{tr('Set')}</button>
    </div>
  );
}

/**
 * The hidden file input both Upload keys open, for whichever asked last.
 *
 * ⚠️ LAST IN THE FILE, and kept last: several of web/test's source scans strip block comments with a regex, and the
 * slash-star inside the accept value below opens one for them that runs to the end of the next block comment --
 * everything between would vanish from the capsule and Lenis scans. With nothing after it, nothing vanishes.
 */
function FilePicker({ inputRef, onPick }: { inputRef: RefObject<HTMLInputElement | null>; onPick: (f: File) => void }) {
  return (
    <input ref={inputRef} type="file" accept="image/*" hidden
      onChange={(e) => { const f = e.target.files?.[0]; e.currentTarget.value = ''; if (f) onPick(f); }} />
  );
}
