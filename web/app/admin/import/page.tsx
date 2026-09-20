'use client';
// The reviewable import wizard (issue #48): backup / MangaDex list / paste / a tracker's reading list →
// match each title against a source → show the pick → let the admin change it or skip it → "Import
// selected" adds only what was accepted. Since v0.35.0 this is the ONLY import path in the UI: the one-shot
// textarea on Admin → Providers, which added the first cross-source hit with no review, is gone
// (POST /api/admin/import stays for scripts). Since v0.36.0 the fourth way in is the AniList / MyAnimeList /
// Kitsu list of an account connected under Profile → Connections → Progress tracking (#48 point 1): the same
// review, and every title that lands is linked to its tracker entry so progress sync works from day one.
//
// A dedicated route rather than a Sheet off the admin Providers card: this is a multi-step flow that can run
// for minutes and needs room for hundreds of rows on a phone, and admin/page.tsx is already one very large
// client component. `/admin/import/` — trailing slash is load-bearing, see next.config.mjs
// (`trailingSlash: true`, static export).
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/components/Toast';
import { ConfirmDialog, msgOf } from '@/components/ConfirmDialog';
import { Img, ProgressBar } from '@/components/ui';
import { SourceIcon } from '@/components/SourcePicker';
import { sourceCover } from '@/components/cards';
import { ImportMatchSheet } from '@/components/ImportMatchSheet';
import { IcChevronLeft } from '@/components/icons';
import { relativeTime } from '@/lib/format';
import { t as tr, keys } from '@/lib/i18n';
import type { Src } from '@/lib/sourceGroups';
import type { TrackerStatus } from '@/lib/types';
import {
  needsAttention, confidenceLabel, confidenceColor, matchTitleDiffers, matchedViaAlt, openBatches, batchStateLabel, batchOriginLabel,
  runStatusLabel, runStatusColor, linkedCount, linkedLine,
  type ImportBatch, type ImportBatchSummary, type ImportCandidate,
} from '@/lib/importBatch';

type Filter = 'all' | 'attention' | 'skipped';

/**
 * The tracker's list buckets, in the order the checkboxes show them, each with its read-state word.
 * `Reading` and `Finished` are the library filter's own read-state keys (LibraryFilters.tsx `READ_LABELS`),
 * so the same idea reads the same everywhere. ⚠️ Never `Completed` for the third one: that key is the
 * SERIES' publication status ("serialisation ended", ja 完結), and English being the key, one string can
 * only carry one sense -- a box labelled 完結 next to 読書 would read as "series that ended", not "I finished
 * reading it". `keys()` puts the labels in front of the translation extractor; they render as `tr(label)`.
 */
const LIST_STATUS_LABELS = keys('Reading', 'Plan to read', 'Finished', 'On hold', 'Dropped');
const LIST_STATUSES = [
  { id: 'reading', label: LIST_STATUS_LABELS[0], on: true },
  { id: 'plan_to_read', label: LIST_STATUS_LABELS[1], on: true },
  { id: 'completed', label: LIST_STATUS_LABELS[2], on: false },
  { id: 'on_hold', label: LIST_STATUS_LABELS[3], on: false },
  { id: 'dropped', label: LIST_STATUS_LABELS[4], on: false },
] as const;
type ListStatus = (typeof LIST_STATUSES)[number]['id'];

/**
 * What the intake dropped or cut: how many light novels the tracker list held (they are skipped -- a novel
 * would resolve to its manga adaptation and be linked to the wrong entry), and whether the list was cut at
 * the batch's 500. The batch row carries both (`skippedNovels` / `truncated` on GET /batches/:id), so a
 * reload or an Open-imports tap keeps the line; the intake's own answer only seeds the first render, before
 * the batch has been read. The toast says the cut once.
 */
interface IntakeNote { skippedNovels: number; truncated: boolean }

/** The dim sentence of the not-connected state; also what a `not_connected` refusal falls back to. */
const NOT_CONNECTED = () =>
  tr('Have an AniList, MyAnimeList or Kitsu account? Connect it under Profile → Connections → Progress tracking to bring your list over.');

/**
 * The tracker intake: the reading list of an account connected under Profile, brought in as a batch.
 *
 * A nested box in the style of Open imports, between that list and the card's eyebrow -- NOT a fourth full
 * block with its own accent button. The intake card's shape is "entrances, one accent button": backup and
 * MangaDex start on their own small control and the paste box uses the accent button; a second full-width
 * accent button ~150 px under the first made two primary CTAs on one phone card. So this starts on a ghost
 * control like the MangaDex "Load", and the card still ends on its one accent button.
 *
 * With nothing connected it is one dim line -- the state nearly every admin sees -- linking straight to the
 * Progress tracking section of Profile (`?tab=Connections&card=tracking`: the profile page opens the tab and
 * scrolls the section into view once the trackers have loaded). "Open Profile" used to land on the You tab,
 * a tab away from it; the tab alone opened the right tab with the card ~430 px below the fold on a phone.
 * (It was `?tab=Reading` until v0.39.0 folded that tab's trackers into Connections.)
 */
function TrackerIntake({ starting, onStart }: {
  starting: boolean;
  onStart: (tracker: string, statuses: ListStatus[]) => void;
}) {
  const { data, isPending } = useQuery({
    queryKey: ['trackers'],
    queryFn: () => api<{ content: TrackerStatus[] }>('/api/trackers'),
    staleTime: 30_000,
  });
  const connected = (data?.content ?? []).filter((t) => t.connected);
  const [tracker, setTracker] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Set<ListStatus>>(() => new Set(LIST_STATUSES.filter((s) => s.on).map((s) => s.id)));
  // The first connected provider is the pick until a chip is tapped; a provider disconnected meanwhile
  // (from another tab) falls back to whatever is still connected rather than a chip that is no longer there.
  const sel = connected.find((t) => t.provider === tracker) ?? connected[0] ?? null;
  const toggle = (id: ListStatus) => setStatuses((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const chosen = LIST_STATUSES.map((s) => s.id).filter((id) => statuses.has(id));

  // Nothing until the server has answered: the box would otherwise flash "connect one under Profile" at a
  // person whose AniList chip is about to appear. A failed read shows the not-connected line, which is
  // still the truthful next step. (Open imports pops in the same way, after its own fetch.)
  if (isPending) return null;

  return (
    <div className="mb-4 rounded-xl border border-ink-700 bg-ink-900/50 p-2.5" data-tracker-intake>
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-fog-500">{tr('From your tracker')}</p>
      {!connected.length ? (
        <Link href="/profile/?tab=Connections&card=tracking" className="block text-[11px] text-fog-500 underline decoration-ink-600 underline-offset-2 hover:text-fog-300">
          {NOT_CONNECTED()}
        </Link>
      ) : (
        <>
          {/* One chip per connected provider, single-select. Shown even when it is the only one: the chip
              names the account the list is read from, which is the thing a person with two accounts checks. */}
          <div className="mb-2 flex flex-wrap gap-1.5">
            {connected.map((t) => (
              <button key={t.provider} type="button" onClick={() => setTracker(t.provider)}
                className={`chip text-xs ${sel?.provider === t.provider ? 'chip-active' : ''}`} aria-pressed={sel?.provider === t.provider}>
                {t.label || t.provider}
                {t.accountName && <span className="ms-1 text-fog-500">{t.accountName}</span>}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {/* `min-h-7 py-1`: the box is 14 px and the text 16 px, so the label was a 16 px tap target on
                the one new phone control while every chip around it is ≥ 26 px. The padding widens what a
                thumb can hit without changing how the row looks. */}
            {LIST_STATUSES.map((s) => (
              <label key={s.id} className="inline-flex min-h-7 items-center gap-1.5 py-1 text-xs text-fog-300">
                <input type="checkbox" checked={statuses.has(s.id)} onChange={() => toggle(s.id)}
                  className="size-3.5 rounded border-ink-600 bg-ink-800 accent-accent" />
                {tr(s.label)}
              </label>
            ))}
            <button type="button" onClick={() => sel && onStart(sel.provider, chosen)} disabled={starting || !sel || !chosen.length}
              className="btn-ghost ms-auto px-3 py-1 text-xs disabled:opacity-50">
              {starting ? tr('Starting…') : tr('Load list')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Batches that were started and not finished, each a tap away.
 *
 * A review batch used to be reachable only through `?batch=<id>` in the address bar: close the tab during a
 * two-hundred-row review and the rows were still in the database with no way back to them short of the
 * sweep deleting them a month later. Listed on the intake card, where the next visit lands.
 */
function OpenImports({ batches, onOpen }: { batches: ImportBatchSummary[]; onOpen: (id: string) => void }) {
  if (!batches.length) return null;
  return (
    <div className="mb-4 rounded-xl border border-ink-700 bg-ink-900/50 p-2.5">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-fog-500">{tr('Open imports')}</p>
      <ul className="space-y-1">
        {batches.map((b) => {
          const counts = b.state === 'resolving'
            ? tr('{done}/{total} matched', { done: b.resolved, total: b.total })
            : b.state === 'importing'
              ? tr('{done}/{total} added', { done: b.added + b.failed, total: b.total })
              : b.total === 1 ? tr('1 title') : tr('{n} titles', { n: b.total });
          return (
            <li key={b.id}>
              <button onClick={() => onOpen(b.id)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start hover:bg-ink-800/60">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-fog-100">{batchOriginLabel(b.origin, b.tracker)} · {counts}</span>
                  {/* `stale` is the list route's word for "resolving, and nobody is": after a restart the raw
                      state read "Matching… 12/40" on the intake card while nothing was matching. */}
                  <span className="block truncate text-[11px] text-fog-500">{b.stale ? tr('Interrupted — resume') : batchStateLabel(b.state)} · {relativeTime(b.created_at)}</span>
                </span>
                <span className="chip shrink-0 text-xs">{tr('Open')}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function IntakeCard({ backupRef, mdUrl, setMdUrl, pasted, setPasted, starting, open, onOpen, onFile, onMangadex, onPaste, onTracker }: {
  backupRef: React.RefObject<HTMLInputElement | null>;
  mdUrl: string; setMdUrl: (v: string) => void;
  pasted: string; setPasted: (v: string) => void;
  starting: boolean;
  open: ImportBatchSummary[];
  onOpen: (id: string) => void;
  onFile: (f: File) => void;
  onMangadex: () => void;
  onPaste: () => void;
  onTracker: (tracker: string, statuses: ListStatus[]) => void;
}) {
  return (
    <div className="card grad-border wide p-4">
      <OpenImports batches={open} onOpen={onOpen} />
      <TrackerIntake starting={starting} onStart={onTracker} />

      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Bring your library over')}</p>
      {/* Names the button that commits, not a "Continue" this page never shows -- the wording was written
          before the button was, and a promise about a control that does not exist is not a promise. */}
      <p className="mb-3 text-[11px] text-fog-500">
        {tr('Uchiyomi matches each title against your sources and shows you the pick before anything is added — nothing lands in your library until you press Import selected.')}
      </p>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input ref={backupRef} type="file" accept=".tachibk,.proto.gz,.gz" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.currentTarget.value = ''; }} />
        <button onClick={() => backupRef.current?.click()} disabled={starting} className="btn-ghost px-3 py-1.5 text-xs disabled:opacity-50">
          {tr('Mihon / Tachiyomi backup')}
        </button>
        <span className="text-[11px] text-fog-600">{tr('or')}</span>
        {/* A floor on the link field so it wraps to its own row on a phone: `min-w-0 flex-1` let it shrink to
            55 px beside the backup button at 390 px, showing "publi" of its placeholder. */}
        <input value={mdUrl} onChange={(e) => setMdUrl(e.target.value)} placeholder={tr('public MangaDex list link')}
          autoCapitalize="none" className="field min-w-44 flex-1" />
        <button onClick={onMangadex} disabled={starting || !mdUrl.trim()} className="chip text-xs disabled:opacity-50">{tr('Load')}</button>
      </div>
      <p className="mb-2 text-[10px] text-fog-600">
        {tr('A .tachibk backup stays on your server — only each entry\'s title, its source and its address on that source are read.')}
      </p>

      <textarea value={pasted} onChange={(e) => setPasted(e.target.value)} rows={4}
        placeholder={tr('…or paste titles, one per line')} className="field resize-y" />
      <button onClick={onPaste} disabled={starting || !pasted.trim()} className="btn-accent mt-2 w-full py-2 text-sm disabled:opacity-50">
        {starting ? tr('Starting…') : tr('Start matching')}
      </button>
    </div>
  );
}

/**
 * The intake note as one dim phrase: "3 novels skipped (first 500 kept)". Singular by hand -- the i18n
 * layer has no plural rules, so every count in the app carries its own one-form key.
 */
function noteText(n: IntakeNote | null): string | null {
  if (!n) return null;
  const parts: string[] = [];
  if (n.skippedNovels > 0) parts.push(n.skippedNovels === 1 ? tr('1 novel skipped') : tr('{n} novels skipped', { n: n.skippedNovels }));
  if (n.truncated) parts.push(tr('(first 500 kept)'));
  return parts.length ? parts.join(' ') : null;
}

/** The note, appended to a card's headline in the headline's own size but dim, so it reads as an aside. */
const Note = ({ note }: { note: string | null }) => note ? <span className="font-normal text-fog-500"> · {note}</span> : null;

function ResolvingCard({ batch, note, onResume }: { batch: ImportBatch; note: string | null; onResume: () => void }) {
  const pct = batch.total ? Math.round((batch.resolved / batch.total) * 100) : 0;
  return (
    <div className="card grad-border wide p-4">
      <p className="mb-1 text-sm font-semibold text-fog-100">
        {batch.stale ? tr('Matching was interrupted') : tr('Matching your titles…')}<Note note={note} />
      </p>
      <p className="mb-3 text-[11px] text-fog-500">
        {batch.stale
          ? tr('The server restarted before this finished. Resume to pick up where it left off.')
          : tr('Checking each title against your sources — this can take a few minutes for a long list. You can leave this page; your progress is saved.')}
      </p>
      <ProgressBar value={batch.total ? batch.resolved / batch.total : 0} />
      <p className="mt-1.5 text-[11px] tabular-nums text-fog-500">{tr('{done}/{total} · {pct}%', { done: batch.resolved, total: batch.total, pct })}</p>
      {batch.stale && <button onClick={onResume} className="btn-accent mt-3 w-full py-2 text-sm">{tr('Resume matching')}</button>}
    </div>
  );
}

/** A row can be selected for bulk import only while it has a match and has not already been run. */
const isReady = (c: ImportCandidate): boolean => (c.decision === 'auto' || c.decision === 'manual') && !!c.match_source_id && !c.status;

function ReviewRow({ c, sourceName, selected, onToggle, onEdit }: {
  c: ImportCandidate;
  sourceName: (id: string | null) => string;
  selected: boolean;
  onToggle: (id: string) => void;
  onEdit: (c: ImportCandidate) => void;
}) {
  const matched = (c.decision === 'auto' || c.decision === 'manual') && !!c.match_title;
  const ready = isReady(c);
  const attention = needsAttention(c);
  return (
    <div className="flex items-center gap-3 rounded-xl border border-ink-800 bg-ink-900/40 p-2.5">
      {ready ? (
        <input type="checkbox" checked={selected} onChange={() => onToggle(c.id)}
          className="size-4 shrink-0 rounded border-ink-600 bg-ink-800 accent-accent" aria-label={tr('Select for import')} />
      ) : (
        <span className="size-4 shrink-0" aria-hidden />
      )}
      <Img src={c.match_cover ? sourceCover(c.match_source || undefined, c.match_cover) : ''} alt=""
        fallbackSrc={c.match_cover || undefined} className="h-14 w-10 shrink-0 rounded" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-fog-100">{c.backup_title}</p>
        {/* What the title was matched TO, on every matched row. Without it "Solo Leveling · MangaDex · close
            match" read the same whether the pick was Solo Leveling or Solo Leveling: Ragnarok, and the only
            hint was a 40-px cover -- a wrong pick was invisible without opening the row. Dim when it is the
            backup title under another spelling, so the line only stands out where it says something new.
            Two lines, not `truncate`: the column is 140 px on a phone, and a one-line ellipsis cut every
            real pair exactly where it differed ("→ The Beginning After…" for the (Novel) pick), so the line
            said nothing on the rows it exists for. Equal titles are dim and short, so the extra 14 px lands
            only where the title is worth reading. */}
        {matched && (
          <p className={`line-clamp-2 break-words text-[12px] ${matchTitleDiffers(c) ? 'text-fog-200' : 'text-fog-600'}`} data-match-title>
            <span aria-hidden className="inline-block rtl:rotate-180">→</span> {c.match_title}
          </p>
        )}
        {/* A tracker row found under its romaji or a synonym: "Attack on Titan → Shingeki no Kyojin" is the
            same title under the name the source uses, and without this line a reviewer reads it as a wrong
            pick. Dim, because it explains the line above rather than adding to it. */}
        {matched && matchedViaAlt(c) && (
          <p className="text-[11px] text-fog-600" data-matched-via>{tr('matched under its other name')}</p>
        )}
        {c.status ? (
          <p className={`text-[11px] ${runStatusColor(c.status)}`}>{runStatusLabel(c.status, !!c.linked)}</p>
        ) : c.decision === 'skip' ? (
          // A title the library already holds is skipped at intake; a tracker intake links it to the tracker
          // entry on the spot, so progress sync covers the titles a person actually reads -- and the row
          // says so, or "0 added · N already had" would look like nothing happened for exactly those.
          <p className="text-[11px] text-fog-500">
            {c.in_library && c.linked ? tr('Already in your library — linked for progress sync') : c.in_library ? tr('Already in your library') : tr('Skipped')}
          </p>
        ) : matched ? (
          <p className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-fog-400">
            <SourceIcon id={c.match_source!} name={sourceName(c.match_source)} size={16} />
            <span className="truncate text-fog-300">{sourceName(c.match_source)}</span>
            {/* A manual pick has no confidence tier (the server clears it), and a person just chose it: say so,
                rather than "unmatched" in amber, which is what the null tier read as. Otherwise amber whenever
                the row is under Needs attention, whatever tier the server gave it: a `contains` hit that
                diverges from the backup title is listed there and must look like it. */}
            {c.decision === 'manual'
              ? <span className="text-fog-300">· {tr('picked by hand')}</span>
              : <span className={attention ? 'text-amber-400' : confidenceColor(c.confidence)}>· {confidenceLabel(c.confidence)}</span>}
          </p>
        ) : (
          <p className="text-[11px] text-amber-400">{tr('No match found')}</p>
        )}
      </div>
      {!c.status && <button onClick={() => onEdit(c)} className="chip shrink-0 text-xs">{tr('Change')}</button>}
    </div>
  );
}

function ReviewCard({
  items, allCount, attentionCount, skippedCount, readyCount, selectedIds, note,
  filter, setFilter, q, setQ, onEdit, onToggle, onSelectAll, onSelectReady, onClearSelection, onRun, running, sourceName,
}: {
  items: ImportCandidate[];
  allCount: number; attentionCount: number; skippedCount: number; readyCount: number;
  note: string | null;
  selectedIds: Set<string>;
  filter: Filter; setFilter: (f: Filter) => void;
  q: string; setQ: (v: string) => void;
  onEdit: (c: ImportCandidate) => void;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onSelectReady: () => void;
  onClearSelection: () => void;
  onRun: () => void;
  running: boolean;
  sourceName: (id: string | null) => string;
}) {
  return (
    <div className="card grad-border wide p-4">
      <p className="mb-1 text-sm font-semibold text-fog-100">{tr('{n} titles matched', { n: allCount })}<Note note={note} /></p>
      {/* "A few minutes", not "seconds": adding a title with nothing downloaded still asks its source for the
          series and its chapter list, one title at a time, so two hundred rows is minutes, not a database
          write. */}
      <p className="mb-3 text-[11px] text-fog-500">
        {tr('Selected titles are added to your library only — no chapters are downloaded, but each title is looked up on its source, so a long list takes a few minutes. New releases arrive through auto-update, or fetch older ones from the series page.')}
      </p>

      <div className="mb-2 flex flex-wrap gap-2">
        <button onClick={() => setFilter('all')} className={`chip text-xs ${filter === 'all' ? 'chip-active' : ''}`}>{tr('All')} · {allCount}</button>
        <button onClick={() => setFilter('attention')} className={`chip text-xs ${filter === 'attention' ? 'chip-active' : ''}`}>{tr('Needs attention')} · {attentionCount}</button>
        <button onClick={() => setFilter('skipped')} className={`chip text-xs ${filter === 'skipped' ? 'chip-active' : ''}`}>{tr('Skipped')} · {skippedCount}</button>
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Filter by title…')} className="field mb-3" />

      {/* Bulk actions. "Select all" marks every row, including a skipped or still-unmatched one — Import
          selected then quietly imports only what is actually ready, so it is never a mistake to press. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button onClick={onSelectAll} className="chip text-xs">{tr('Select all')}</button>
        <button onClick={onSelectReady} className="chip text-xs">{tr('Select ready to import')} · {readyCount}</button>
        {selectedIds.size > 0 && (
          <button onClick={onClearSelection} className="chip text-xs">{tr('Clear selection')}</button>
        )}
        <span className="ms-auto text-[11px] text-fog-500">{tr('{n} selected', { n: selectedIds.size })}</span>
      </div>

      <div className="space-y-1.5">
        {items.length === 0 ? (
          <p className="py-8 text-center text-sm text-fog-500">{tr('Nothing here.')}</p>
        ) : items.map((c) => (
          <ReviewRow key={c.id} c={c} sourceName={sourceName} selected={selectedIds.has(c.id)} onToggle={onToggle} onEdit={onEdit} />
        ))}
      </div>

      <div className="sticky bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-10 mt-4 lg:bottom-4">
        <button onClick={onRun} disabled={running || selectedIds.size === 0} className="btn-accent w-full py-2.5 text-sm shadow-lift disabled:opacity-50">
          {running ? tr('Starting…') : tr('Import selected — {n}', { n: selectedIds.size })}
        </button>
      </div>
    </div>
  );
}

function RunCard({ batch, items, runIds, runTotal, note, onStartOver }: {
  batch: ImportBatch; items: ImportCandidate[];
  /** The candidate ids this tab sent to /run, or null when the run was started elsewhere (a reload, another tab). */
  runIds: Set<string> | null;
  /** `total` from the /run answer: how many of those ids the server accepted as ready. */
  runTotal: number | null;
  note: string | null;
  onStartOver: () => void;
}) {
  // Only the rows this run is over. The card used to list every auto/manual row and count the batch's
  // cumulative added/already/failed against that: select 2 of 8 and it read "Importing… 2/8" with six
  // pending "…" rows that were never sent, then flipped back to review. Without the sent ids (the run was
  // started from another tab, or this page reloaded mid-run) the settled rows plus the still-ready ones are
  // the best reading -- a row left unselected on purpose shows as pending there, which is the old picture,
  // but only on a page that did not start the run.
  const targeted = runIds
    ? items.filter((c) => runIds.has(c.id))
    : items.filter((c) => !!c.status || isReady(c));
  const done = targeted.filter((c) => !!c.status).length;
  const total = runTotal ?? targeted.length;
  // The rows the intake linked to their tracker entry (in the library already, nothing to add). Counted
  // over the whole batch like the headline's other numbers, and said on the done card, because a batch of
  // nothing but those never reaches the review: the server closes it to `done` on its first read, and
  // "0 added · 5 already had · 0 failed" was all an established library saw of the thing it came for.
  const linked = batch.state === 'done' ? linkedLine(linkedCount(items)) : null;
  return (
    <div className="card grad-border wide p-4">
      <p className="mb-1.5 text-sm font-semibold text-fog-100">
        {batch.state === 'importing'
          ? tr('Importing… {done}/{total}', { done, total })
          : tr('Done — {added} added · {already} already had · {failed} failed', { added: batch.added, already: batch.already, failed: batch.failed })}
        <Note note={linked} />
        <Note note={note} />
      </p>
      {batch.state === 'importing' && (
        <p className="mb-3 text-[11px] text-fog-500">
          {tr('Each title is looked up on its source, so a long list takes a few minutes. You can leave this page; your progress is saved.')}
        </p>
      )}
      <ProgressBar value={total ? done / total : 0} />
      <ul className="mt-3 max-h-96 space-y-1 overflow-y-auto">
        {targeted.map((c) => (
          <li key={c.id} className="flex items-center gap-2 text-xs">
            <span className={c.status === 'added' ? 'text-emerald-400' : c.status === 'already' ? 'text-fog-500' : c.status ? 'text-red-400' : 'text-fog-600'}>
              {c.status === 'added' ? '✓' : c.status === 'already' ? '·' : c.status ? '✗' : '…'}
            </span>
            {c.status === 'already' && c.linked ? (
              // Two lines rather than `truncate`: the suffix is long in German and Russian, and a one-line
              // ellipsis would cut the title to make room for the words that explain it.
              <span className="min-w-0 flex-1 line-clamp-2 break-words text-fog-200" data-linked-row>
                {c.backup_title} <span className="text-fog-500">— {tr('linked for progress sync')}</span>
              </span>
            ) : (
              <span className="min-w-0 flex-1 truncate text-fog-200">{c.backup_title}</span>
            )}
          </li>
        ))}
      </ul>
      {batch.state === 'done' && <button onClick={onStartOver} className="btn-ghost mt-4 w-full py-2 text-sm">{tr('Import another list')}</button>}
    </div>
  );
}

function ImportWizardInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { isAdmin } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();

  const [batchId, setBatchId] = useState<string | null>(params.get('batch'));
  useEffect(() => { setBatchId(params.get('batch')); }, [params]);

  const backupRef = useRef<HTMLInputElement>(null);
  const [mdUrl, setMdUrl] = useState('');
  const [pasted, setPasted] = useState('');
  const [starting, setStarting] = useState(false);
  const [intakeNote, setIntakeNote] = useState<IntakeNote | null>(null);

  const start = async (body: Record<string, unknown>) => {
    setStarting(true);
    try {
      const r = await api<{ batchId: string; total: number; truncated: boolean; skippedNovels?: number }>('/api/admin/import/batches', { json: body });
      if (r.truncated) toast(tr('Only the first 500 titles were kept.'), 'info');
      setIntakeNote({ skippedNovels: r.skippedNovels ?? 0, truncated: !!r.truncated });
      setBatchId(r.batchId);
      router.replace(`/admin/import/?batch=${r.batchId}`);
    } catch (e: any) {
      // The tracker intake's own refusals, each in the person's words rather than the server's. A rejected
      // token is the one that needs a trip to Profile; a service that did not answer is a retry; a
      // connection dropped since the card loaded (another tab disconnected it) is the not-connected line
      // again, and the box re-reads the trackers so its chips agree with what the server just said.
      let body: any = {};
      try { body = JSON.parse(e?.body || '{}'); } catch { /* not JSON */ }
      if (body.error === 'tracker_rejected') toast(tr('The tracker rejected the saved token — reconnect it under Profile'), 'error');
      else if (body.error === 'tracker_unavailable') toast(tr('Could not read your list right now'), 'error');
      else if (body.error === 'not_connected') { qc.invalidateQueries({ queryKey: ['trackers'] }); toast(NOT_CONNECTED(), 'info'); }
      else toast(msgOf(e, tr('Could not start the import')), 'error');
    }
    setStarting(false);
  };
  const startFromTracker = (tracker: string, statuses: ListStatus[]) => start({ origin: 'tracker', tracker, statuses });
  const startFromFile = async (f: File) => {
    if (f.size > 10 * 1024 * 1024) { toast(tr('That file is unusually large (max ~10 MB)'), 'error'); return; }
    try {
      const dataUrl = await new Promise<string>((res, rej) => {
        const rd = new FileReader();
        rd.onload = () => res(String(rd.result));
        rd.onerror = () => rej(new Error('read'));
        rd.readAsDataURL(f);
      });
      await start({ dataUrl });
    } catch { toast(tr('Could not read that file'), 'error'); }
  };
  const startFromMangadex = () => start({ mangadexList: mdUrl.trim() });
  const startFromPaste = () => {
    const titles = pasted.split('\n').map((t) => t.trim()).filter(Boolean);
    if (titles.length) start({ titles });
  };

  const { data: sourcesData } = useQuery({
    queryKey: ['sources'],
    queryFn: () => api<{ content: Src[] }>('/api/sources'),
    staleTime: 30_000,
  });
  const sourceName = (id: string | null): string => (id && sourcesData?.content.find((s) => s.id === id)?.name) || id || '';

  // Only on the intake card: once a batch is open the page is about that batch.
  const { data: batchList } = useQuery({
    queryKey: ['import-batches'],
    queryFn: () => api<{ content: ImportBatchSummary[] }>('/api/admin/import/batches'),
    enabled: !batchId,
    staleTime: 10_000,
  });
  const open = openBatches(batchList?.content ?? []);

  const { data, refetch, error: batchError } = useQuery({
    queryKey: ['import-batch', batchId],
    queryFn: () => api<{ batch: ImportBatch; items: ImportCandidate[] }>(`/api/admin/import/batches/${batchId}`),
    enabled: !!batchId,
    // A 404 is an answer, not a hiccup -- the batch was discarded from another tab or swept -- and the
    // default retry only held the intake card back by a couple of seconds. Everything else keeps it.
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 1,
    // Polls only while the server is working. An `importing` batch nobody is running (the server restarted
    // mid-run) comes back from GET already flipped to `review`, and the review card below renders in its
    // place with the imported rows marked -- so this never sits on a progress bar that will not move.
    refetchInterval: (q) => {
      const st = q.state.data?.batch.state;
      return st === 'resolving' || st === 'importing' ? 1500 : false;
    },
  });
  const batch = data?.batch;
  // ⚠️ Referentially stable, or the page loops. `data?.items ?? []` minted a NEW empty array on every render
  // while no batch was loaded -- the intake card -- and the selection-prune effect below keys on `items`:
  // each keystroke in the paste box re-rendered the page, the effect saw a "changed" dependency, called
  // setSelected, React rendered again, and after fifty rounds threw "Maximum update depth exceeded" (React
  // error #185) out of the textarea's onChange. Only sometimes: React's eager same-state bail-out hides it
  // when the fiber is idle, which is why one walk passed and the next did not with the same page. One
  // memoised value per query result, and the effect fires once per fetch, as intended. Reintroduce by
  // writing `data?.items ?? []` again: typing three lines into the paste box throws in the console.
  const items = useMemo(() => data?.items ?? [], [data]);

  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<ImportCandidate | null>(null);
  const [running, setRunning] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [discardBusy, setDiscardBusy] = useState(false);
  // Bulk-import selection: candidate ids about to be sent to /run. Empty by default -- picking what to
  // import is a deliberate act via "Select all" / "Select ready to import" / a row's own checkbox, not a
  // default the admin has to opt out of.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // What THIS tab last sent to /run and how many of it the server accepted, for the importing card's
  // count and list. Null until a run is started here; a reload mid-run lands on the card without them.
  const [runIds, setRunIds] = useState<Set<string> | null>(null);
  const [runTotal, setRunTotal] = useState<number | null>(null);

  // The selection follows the rows: a row skipped from the sheet, or added by a run, is no longer ready
  // and drops out of the state on the next refetch ("6 selected" used to keep a row that Change → Skip had
  // just removed, and Import selected sent six ids of which the server took five). `selectedReady` below
  // is the render-time half of the same rule; this keeps the state from carrying dead ids between
  // refetches. Same Set back when nothing changed, so the effect settles instead of re-rendering per poll.
  useEffect(() => {
    setSelected((s) => {
      if (!s.size) return s;
      const ready = new Set(items.filter(isReady).map((c) => c.id));
      const kept = new Set([...s].filter((id) => ready.has(id)));
      return kept.size === s.size ? s : kept;
    });
  }, [items]);

  const filtered = items.filter((c) => {
    if (filter === 'attention' && !needsAttention(c)) return false;
    if (filter === 'skipped' && c.decision !== 'skip') return false;
    // Backup title OR matched title: a row that reads "Naruto → Boruto: Naruto Next Generations" is the
    // one a person types "Boruto" to find, and the filter found nothing.
    const needle = q.trim().toLowerCase();
    if (needle && !c.backup_title.toLowerCase().includes(needle) && !(c.match_title || '').toLowerCase().includes(needle)) return false;
    return true;
  });
  const attentionCount = items.filter(needsAttention).length;
  const skippedCount = items.filter((c) => c.decision === 'skip').length;
  const readyCount = items.filter(isReady).length;
  // The selection as it will be sent: only ready rows have a checkbox, so an id "Select all" put in for a
  // skipped or unmatched row is invisible on the list and must not be counted -- "8 selected" over five
  // checkboxes, then "Importing… 0/5", was the mismatch. One Set for the checkboxes, the count and /run.
  const readyIds = new Set(items.filter(isReady).map((c) => c.id));
  const selectedReady = new Set([...selected].filter((id) => readyIds.has(id)));

  const resume = async () => {
    if (!batchId) return;
    try { await api(`/api/admin/import/batches/${batchId}/resume`, { method: 'POST' }); refetch(); }
    catch (e: any) { toast(msgOf(e, tr('Could not resume')), 'error'); }
  };
  const toggleSelected = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selectAll = () => setSelected(new Set(items.map((c) => c.id)));
  const selectReady = () => setSelected(new Set(items.filter(isReady).map((c) => c.id)));
  const clearSelection = () => setSelected(new Set());
  const runImport = async () => {
    if (!batchId || selectedReady.size === 0) return;
    // Only the ready rows among the selection go: "Select all" marks every row, and the server would drop
    // the rest anyway -- sending exactly what it will take makes its `total` the card's denominator.
    const ids = items.filter((c) => selectedReady.has(c.id)).map((c) => c.id);
    setRunning(true);
    try {
      const r = await api<{ ok: boolean; total: number }>(`/api/admin/import/batches/${batchId}/run`, { method: 'POST', json: { candidateIds: ids } });
      setRunIds(new Set(ids));
      setRunTotal(typeof r?.total === 'number' ? r.total : ids.length);
      setSelected(new Set());
      refetch();
    } catch (e: any) { toast(msgOf(e, tr('Could not start the import')), 'error'); }
    setRunning(false);
  };
  const startOver = () => {
    setBatchId(null); setMdUrl(''); setPasted(''); setSelected(new Set()); setFilter('all'); setQ('');
    setRunIds(null); setRunTotal(null); setIntakeNote(null);
    qc.invalidateQueries({ queryKey: ['import-batches'] });
    router.replace('/admin/import/');
  };
  // A ?batch= link to a batch that no longer exists (swept after 30 days, discarded from another tab): the
  // page used to render the intake card with the dead id still in the address bar and, because the list
  // query is `enabled: !batchId`, no Open imports list -- the one situation that list is for. Back to the
  // intake proper, with a word about why.
  useEffect(() => {
    if (batchError instanceof ApiError && batchError.status === 404) {
      toast(tr('That import is gone'), 'info');
      startOver();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per error, not per render of startOver
  }, [batchError]);
  // DELETE, then back to the intake card. The server stops the resolve or run loop this batch had going and
  // drops its rows; a title already added by this batch stays in the library -- discarding the review is
  // not removing series, and the dialog says so.
  const discard = async () => {
    if (!batchId) return;
    setDiscardBusy(true);
    try {
      await api(`/api/admin/import/batches/${batchId}`, { method: 'DELETE' });
      qc.removeQueries({ queryKey: ['import-batch', batchId] });
      toast(tr('Import discarded'), 'success');
      setDiscarding(false);
      startOver();
    } catch (e: any) { toast(msgOf(e, tr('Could not discard this import')), 'error'); }
    setDiscardBusy(false);
  };
  const openBatch = (id: string) => { setIntakeNote(null); setBatchId(id); router.replace(`/admin/import/?batch=${id}`); };
  const closeEditor = () => { setEditing(null); qc.invalidateQueries({ queryKey: ['import-batch', batchId] }); };

  if (!isAdmin) return <div className="flex min-h-screen-d items-center justify-center text-fog-400">{tr('Admins only.')}</div>;

  const canDiscard = !!batch && batch.state !== 'done' && batch.state !== 'cancelled';
  // From the batch row, so a reload or an Open imports tap keeps the line; the intake's answer stands in only
  // until the first GET has landed (and for an older server that does not send the fields). `intakeNote` is
  // cleared on every batch switch, so a note from a previous batch never follows the person to the next one.
  const note = noteText(batch
    ? { skippedNovels: batch.skippedNovels ?? intakeNote?.skippedNovels ?? 0, truncated: batch.truncated ?? intakeNote?.truncated ?? false }
    : null);

  return (
    <div className="min-h-screen-d px-4 pb-10 pt-4 lg:px-0">
      <div className="mb-4 flex items-center gap-2">
        <button onClick={() => router.push('/admin/')} className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-fog-400 hover:text-fog-100" aria-label={tr('Back')}>
          <IcChevronLeft width={18} height={18} className="rtl:rotate-180" />
        </button>
        <h1 className="min-w-0 truncate font-display text-lg font-semibold text-fog-50">{tr('Import & review matches')}</h1>
        {/* One Discard for all three live states (matching, review, importing): the same batch, the same
            DELETE, one place to look for it. Absent once the batch is done -- there is nothing to stop. */}
        {canDiscard && (
          <button onClick={() => setDiscarding(true)} className="chip ms-auto shrink-0 text-xs">{tr('Discard')}</button>
        )}
      </div>

      {!batch ? (
        <IntakeCard backupRef={backupRef} mdUrl={mdUrl} setMdUrl={setMdUrl} pasted={pasted} setPasted={setPasted}
          starting={starting} open={open} onOpen={openBatch} onFile={startFromFile} onMangadex={startFromMangadex} onPaste={startFromPaste}
          onTracker={startFromTracker} />
      ) : batch.state === 'resolving' ? (
        <ResolvingCard batch={batch} note={note} onResume={resume} />
      ) : batch.state === 'review' ? (
        <ReviewCard items={filtered} allCount={items.length} attentionCount={attentionCount} skippedCount={skippedCount}
          readyCount={readyCount} selectedIds={selectedReady} note={note} filter={filter} setFilter={setFilter} q={q} setQ={setQ}
          onEdit={setEditing} onToggle={toggleSelected} onSelectAll={selectAll} onSelectReady={selectReady}
          onClearSelection={clearSelection} onRun={runImport} running={running} sourceName={sourceName} />
      ) : (
        <RunCard batch={batch} items={items} runIds={runIds} runTotal={runTotal} note={note} onStartOver={startOver} />
      )}

      {editing && batchId && <ImportMatchSheet batchId={batchId} candidate={editing} onClose={closeEditor} />}

      {/* Never open while the match sheet is: ConfirmDialog is a z-50 Modal and the Sheet is z-60, so the
          dialog would paint under it. The Discard button lives in the page header, behind the sheet's
          backdrop, so the two cannot be open at once. */}
      {discarding && batch && (
        <ConfirmDialog
          title={tr('Discard this import?')}
          body={batch.added > 0
            ? tr('The list and every match you reviewed are thrown away. Anything this import already added ({n} so far) stays in your library.', { n: batch.added })
            : tr('The list and every match you reviewed are thrown away. Nothing has been added to your library yet, so nothing else changes.')}
          confirmLabel={tr('Discard')}
          danger
          busy={discardBusy}
          onConfirm={discard}
          onClose={() => setDiscarding(false)}
        />
      )}
    </div>
  );
}

export default function ImportWizardPage() {
  return (
    <Suspense fallback={<div className="min-h-screen-d" />}>
      <ImportWizardInner />
    </Suspense>
  );
}
