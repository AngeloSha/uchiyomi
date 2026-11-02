'use client';
import { publicServerURL } from '@/lib/native';
import { ScrollRail, CARD_RAIL } from '@/components/ScrollRail';
import { Children, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { motion, useReducedMotion, useScroll, useTransform } from 'framer-motion';
import { HeroArt } from '@/components/MosaicArt';
import { useArtUnderChrome } from '@/lib/overArt';
import { useReduceEffects } from '@/lib/effects';
import { useSearchParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, img } from '@/lib/api';
import { Book, EditionRow, Ghost, Listing, Page, Series, VersionCopy, Versions } from '@/lib/types';
import { bookCountText, chapterLabel, chapterName, isVolumeName, languageName, relativeTime, relativeTimeShort } from '@/lib/format';
import { listDownloads, downloadChapter, deleteDownload } from '@/lib/downloads';
import { applyCover, clearCover } from '@/lib/theme';
import { Img, Backdrop, SectionTitle, useWideViewport } from '@/components/ui';
import { SeriesCard } from '@/components/cards';
import { useToast } from '@/components/Toast';
import { ConfirmDialog, Modal, msgOf } from '@/components/ConfirmDialog';
import { MoveToLibrary } from '@/components/MoveToLibrary';
import { useAuth, canDownload } from '@/lib/auth';
import { IcChevronLeft, IcDownload, IcCloudDownload, IcCheck, IcTrash, IcHourglass, IcGrid, IcRows, IcComment } from '@/components/icons';
import { commentsLine, seriesTalkKey, talkWantedOf, type ChapterTalkCount } from '@/lib/comments';
import { ChapterTalkSheet } from '@/components/ChapterTalk';
import { AuthorLinks } from '@/components/AuthorLinks';
import { t as tr } from '@/lib/i18n';
import { statusText } from '@/lib/activity';
import { deletedText, selectedText, skippedBookmarkedText, skippedNotOursText } from '@/lib/counted';
import { unlistedWarning } from '@/lib/sourceLeftovers';
import { reasonText, type Said } from '@/lib/said';
import { offlineOutcome } from '@/lib/notices';
import { FindMissingDialog } from '@/components/FindMissingDialog';
import { normGroup } from '@/lib/scanlators';
import { GHOST_CAP, mergeRows, whyLabel, runLabel, chunkNumbers, countsAsBehind, MARK_CHUNK, heldBy, lastOf, wholesHeld, prunedWords, deliberatelyDeleted, ghostOfDeleted, type Row } from '@/lib/chapterRows';
import { chParam, landingNumber } from '@/lib/healthLinks';
import { effectsReduced } from '@/lib/effects';
import { clampPage, numberingSpan, pageCount, pageLabel, pageOf, pageSizeFor, pageSlice } from '@/lib/chapterPages';
import { openRuns, showAllChaptersOn } from '@/lib/showAllChapters';
import { buttonsClass, compactChaptersOn, dotHide, rowClass, thumbHide } from '@/lib/compactChapters';
import { chapterRowsClass, chapterViewOn, setChapterView, type ChapterView } from '@/lib/chapterView';
import { OtherTitles } from '@/components/OtherTitles';
import { PhoneHeroCover } from '@/components/PhoneHeroCover';
import { HeroTitle } from '@/components/HeroTitle';
import { useTitleArtPolling } from '@/lib/useTitleArtPolling';
import { Segmented } from '@/components/settings';
import { seriesBooksQuery, seriesQuery } from '@/lib/seriesPrefetch';
import { fetchingToast } from '@/lib/jobs';
import { ALL_GROUPS, copySourceId, groupsOfRow, matchesGroup } from '@/lib/groupFilter';
import { SourcesSheet, useCheckNow, useSeriesGroups } from '@/components/SourcesSheet';
import { SourcesExplainer } from '@/components/SourcesExplainer';
import { SupplyLine } from '@/components/SupplyLine';
import { ChapterFilterSheet } from '@/components/ChapterFilterSheet';
import { ChapterVersionsSheet } from '@/components/ChapterVersionsSheet';
import { HiddenChaptersDialog } from '@/components/HiddenChapters';
import { CoverPickerSheet } from '@/components/CoverPickerSheet';
import { CompareCopiesDialog } from '@/components/CompareCopiesDialog';
import { GroupAvatar } from '@/components/GroupAvatar';
import { supplyLine } from '@/lib/supplyLine';
import { isDesktop } from '@/lib/desktop';
import { useContextMenu } from '@/components/ContextMenu';
import { useLayer, useLayers } from '@/lib/layers';
import { kickDownloads, useServerDownloads } from '@/lib/useServerDownloads';
import { SeriesServerDownloads } from '@/components/SeriesServerDownloads';
import { useArchiveEnqueue } from '@/components/ArchiveQueue';
import { listingArchiveLine } from '@/lib/archive';
import { NumberingNotice } from '@/components/NumberingNotice';
import { LanguageNotice } from '@/components/LanguageNotice';
import { NumberingSheet } from '@/components/NumberingSheet';
import type { PlanMode } from '@/lib/numbering';
import { AddSeriesDialog } from '@/components/AddSeriesDialog';
import { editionChipLabels } from '@/lib/editions';
import { continueChoice, continueText, readCountText } from '@/lib/continueLabel';
import { radarText } from '@/lib/radar';
import { catchUpText } from '@/lib/readingTime';
import { offlineKeyShown, seriesActionGroups, type SeriesActionId } from '@/lib/seriesActions';
import { RatingsPanel, useSeriesRating } from '@/components/RatingsPanel';
import { ContinueBar, ContinueButton, ReadProgress, useOutOfView } from '@/components/ContinueBar';
import { FavouriteKey, IcListAdd, MoreKey, SeriesKey, SeriesMoreSheet, moreMenuItems } from '@/components/SeriesKeys';
import { ProgressRing } from '@/components/ProgressRing';
import { SeriesEditor, copyPath, type EditTab } from '@/components/SeriesEditor';
import { RelatedRail } from '@/components/RelatedRail';
import { safeColor } from '@/lib/safeColor';

/** "Marking 3 chapters read…", counted: the busy half of Mark read's one card. */
const markingText = (n: number) => (n === 1 ? tr('Marking 1 chapter read…') : tr('Marking {n} chapters read…', { n }));

// The one field style the page's own small dialogs share (Add to collection, Edit chapter).
const fld = 'w-full rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2 text-sm text-fog-100 outline-hidden transition focus:border-accent/60';

interface CollectionRow { id: string; name: string; accent: string | null; item_count: number }

/**
 * "Add to list": pick an existing list or create one inline. The shared Modal since the UI refresh (it was a hand-rolled
 * overlay): Escape closes it, focus starts in it and goes back to the List key, and it clears a phone's nav bar.
 */
function CollectionSheet({ seriesId, onClose }: { seriesId: string; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const { data, isLoading } = useQuery({ queryKey: ['collections'], queryFn: () => api<{ content: CollectionRow[] }>('/api/collections') });
  const add = async (c: CollectionRow) => {
    try {
      await api(`/api/collections/${c.id}/items`, { json: { seriesId } });
      toast(tr('Added to “{name}”', { name: `\u2068${c.name}\u2069` }), 'success');
      qc.invalidateQueries({ queryKey: ['collections'] });
      qc.invalidateQueries({ queryKey: ['collection', c.id] });
      onClose();
    } catch { toast(tr('Failed'), 'error'); }
  };
  const createAndAdd = async () => {
    const n = name.trim();
    if (!n) return;
    try {
      const c = await api<CollectionRow>('/api/collections', { json: { name: n } });
      await add(c);
    } catch { toast(tr('Could not create the list'), 'error'); }
  };
  return (
    <Modal title={tr('Add to list')} onClose={onClose} fieldFocus={false}>
      {isLoading ? (
        <div className="skeleton h-24 rounded-xl" />
      ) : (
        <div data-lenis-prevent className="max-h-64 space-y-1.5 overflow-y-auto">
          {(data?.content ?? []).map((c) => (
            <button key={c.id} onClick={() => add(c)}
              className="flex w-full items-center gap-2.5 rounded-xl border border-ink-700 px-3 py-2.5 text-start transition hover:border-accent/50">
              <span aria-hidden className="h-4 w-1.5 shrink-0 rounded-full" style={{ background: safeColor(c.accent, 'rgb(var(--accent))') }} />
              <span className="min-w-0 truncate text-sm text-fog-100">{c.name}</span>
              <span className="ms-auto shrink-0 text-[11px] text-fog-500">{c.item_count}</span>
            </button>
          ))}
          {!(data?.content ?? []).length && <p className="py-2 text-center text-xs text-fog-500">{tr('No lists yet — create one below.')}</p>}
        </div>
      )}
      <div className="mt-3 flex gap-2 border-t border-ink-800 pt-3">
        <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && createAndAdd()}
          placeholder={tr('New list…')} className={`${fld} flex-1`} />
        <button onClick={createAndAdd} disabled={!name.trim()} className="btn-accent px-3 text-xs disabled:opacity-50">{tr('Create')}</button>
      </div>
    </Modal>
  );
}

/**
 * Correct one chapter's number or title.
 *
 * Numbers come from the filename via the first number found in it, so "Vol 2 Ch 5.cbz" reads as chapter 2:
 * it sorts between 1 and 3, and 2 is what gets reported to a connected tracker. This is the escape hatch.
 * The affected-users warning matters because renumbering a chapter someone has finished changes the number
 * their AniList account gets told.
 */
/**
 * Rename the folder a series lives in, on disk.
 *
 * The backend refuses unless EVERY root the series occupies is writable, because a series routinely spans
 * the read library and the downloads folder, and renaming only the writable half leaves the old name live
 * under the other one -- which the next scan re-reads as a second series, with half of everyone's progress
 * stranded on it. The refusal carries both a reason and the exact fix (usually a PUID), so this shows what
 * the server said rather than a generic failure: "could not rename" would hide the one useful sentence.
 */
function RenameFolderModal({ id, folder, title, onClose, onSaved }: {
  id: string; folder: string; title: string; onClose: () => void; onSaved: () => void;
}) {
  const [next, setNext] = useState(folder);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{ message?: string; fix?: string } | null>(null);
  const toast = useToast();

  const save = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      await api(`/api/admin/series/${id}/rename-folder`, { method: 'POST', json: { folder: next.trim() } });
      toast(tr('Folder renamed'), 'success');
      onSaved();
      onClose();
    } catch (e: any) {
      let shown = false;
      try {
        const b = JSON.parse(e?.body || '{}');
        if (b.message || b.fix) { setRefusal({ message: b.message, fix: b.fix }); shown = true; }
      } catch {}
      if (!shown) toast(msgOf(e, tr('Could not rename the folder')), 'error');
    }
    setBusy(false);
  };

  const changed = next.trim() !== folder.trim() && next.trim().length > 0;
  const [currentlyBefore, currentlyAfter] = tr('Currently: {folder}').split('{folder}');

  return (
    <Modal title={tr('Rename the folder for “{title}”', { title: `\u2068${title}\u2069` })} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-xs text-fog-500">
          {tr('This moves the folder on disk. Chapter ids and everyone’s reading progress stay exactly as they are, so nothing is marked unread and nothing is re-downloaded.')}
        </p>
        <label className="block">
          <span className="mb-1 block text-xs text-fog-500">{tr('Folder, relative to your library root')}</span>
          <input
            value={next}
            onChange={(e) => setNext(e.target.value)}
            spellCheck={false}
            className="w-full rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2 font-mono text-sm text-fog-100 outline-hidden focus:border-accent/60"
          />
        </label>
        {/* One sentence split around the folder, which is set in mono: `tr('Currently')` glued to it read
            "Currentlymanga/Solo Leveling" in every language. */}
        <p className="text-[11px] text-fog-600">{currentlyBefore}<span dir="ltr" className="font-mono">{folder}</span>{currentlyAfter}</p>

        {refusal && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
            <p>{refusal.message}</p>
            {refusal.fix && <p className="mt-1 text-amber-300/90">{refusal.fix}</p>}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="chip text-xs">{tr('Cancel')}</button>
          <button onClick={save} disabled={busy || !changed} className="btn-accent px-4 py-2 text-sm disabled:opacity-50">
            {busy ? tr('Renaming…') : tr('Rename folder')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ChapterEditModal({ book, onClose, onSaved }: { book: Book; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [number, setNumber] = useState(String(book.number ?? ''));
  const [title, setTitle] = useState(book.metadata?.title || book.name || '');
  const [busy, setBusy] = useState(false);
  const completed = !!book.readProgress?.completed;

  const save = async (reset = false) => {
    const n = reset ? null : Number(number);
    if (!reset && !Number.isFinite(n)) { toast(tr('Chapter number must be a number'), 'error'); return; }
    setBusy(true);
    try {
      const r = await api<{ affectedUsers: number }>(`/api/admin/books/${book.id}/meta`, {
        method: 'PUT',
        json: reset ? { number: null, title: null } : { number: n, title },
      });
      toast(r.affectedUsers > 1 ? tr('Saved. {n} readers had finished this chapter.', { n: r.affectedUsers })
        : r.affectedUsers === 1 ? tr('Saved. 1 reader had finished this chapter.') : tr('Saved'), 'success');
      onSaved();
      onClose();
    } catch (e) { toast(msgOf(e, tr('Could not save')), 'error'); }
    setBusy(false);
  };

  return (
    // The shared Modal (UI refresh), as Add to list: Escape, focus in and back, and clear of a phone's nav bar.
    <Modal title={tr('Edit chapter')} onClose={onClose}>
      <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Chapter number')}</label>
      <input value={number} onChange={(e) => setNumber(e.target.value)} inputMode="decimal" className={fld} />
      <label className="mb-1 mt-3 block text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Title')}</label>
      <input value={title} onChange={(e) => setTitle(e.target.value)} className={fld} />
      {completed && (
        <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-[11px] leading-relaxed text-amber-200">
          {tr('You have finished this chapter. Changing its number changes what gets reported to a connected tracker. Progress never moves backwards on its own: if the new number is lower, the tracker keeps the higher one until an admin imports your list again under Admin → Import (From your tracker).')}
        </p>
      )}
      <div className="mt-4 flex gap-2">
        <button onClick={() => save(true)} disabled={busy} className="btn-ghost flex-1 py-2 text-sm disabled:opacity-50">{tr('Reset to file')}</button>
        <button onClick={() => save()} disabled={busy} className="btn-accent flex-1 py-2 text-sm disabled:opacity-50">{tr('Save')}</button>
      </div>
    </Modal>
  );
}

/**
 * The muted caption under a chapter's label: who translated it, `via {source}` when the copy came from a
 * source other than the series' own, and `{n} versions` when the number has more than one copy on offer.
 * Plain text, one line, truncating -- the bordered pills this replaces put three boxes of text on every row,
 * which at 390 px was more chrome than chapter. `Deleted from the server` stays a small tag before it: a
 * tombstone is a state, not a caption (and since v0.55.7 its words wrap rather than being cut; see below).
 *
 * ⚠️ `{n} versions` is TEXT, never a button. This caption sits inside the row's opener, which is itself a
 * <button>, and a button inside a button is invalid DOM that browsers un-nest unpredictably (the v0.33 strip
 * sat OUTSIDE the opener for exactly this reason). The copies open from ⋯ → Versions on a chapter row, and
 * from the row tap on a ghost row.
 */
function RowCaption({ group, via, versions, tone = 'text-fog-500', pruned, lead, missing, talk }: {
  group?: string | null;
  /**
   * v0.87.0: the chapter's talk, while the household has any (lib/comments.ts): its two most used reactions with how many
   * reacted ("😂🔥 3"), and how many comments ("💬 2"). Absent, or a chapter nobody talked about, draws nothing.
   */
  talk?: ChapterTalkCount | null;
  via?: string | null;
  versions?: number;
  tone?: string;
  /** A tombstone's tag, in its words, whole and short (lib/chapterRows.ts prunedWords); null for a chapter with its file. */
  pruned?: { full: string; short: string } | null;
  /**
   * A first part before the group: a ghost's reason ("not here yet", "waiting for Asura Scans · 2 days left"). `full`
   * is the sentence a short reason stands for ("another split" for "another split of a chapter you have"): the title
   * and what a screen reader says, where the short form is what fits beside the group and the source.
   */
  lead?: { text: string; amber?: boolean; full?: string } | null;
  /**
   * How many pages the saved file holds a placeholder for (`Book.missingPages`, v0.40.0). A chip like the
   * tombstone's, amber because it is news that clears itself: the sweep refills the holes and the server
   * drops the column when the last one lands. Zero or absent draws nothing.
   */
  missing?: number;
}) {
  const parts: ReactNode[] = [];
  const short = missing && missing > 0 ? (missing === 1 ? tr('1 page missing') : tr('{n} pages missing', { n: missing })) : null;
  // The same caption as plain text, for `title`: at the owner's desktop width a cell is 287 px and the
  // caption beside the thumb, the date and the two buttons gets ≈90, so "Reaper Scans · 2 versions" is an
  // ellipsis there and a hover is how the rest is read.
  const plain: string[] = [];
  if (lead) {
    parts.push(
      <span key="lead" className={lead.amber ? 'text-amber-300' : ''}>
        {lead.full ? <><span aria-hidden="true">{lead.text}</span><span className="sr-only">{lead.full}</span></> : lead.text}
      </span>,
    );
    plain.push(lead.full ?? lead.text);
  }
  // The avatar is an atomic inline BESIDE the name, not a flex box AROUND it: Chrome does not put an
  // ellipsis inside an inline-flex it has to cut, so a name wrapped with its avatar was clipped mid-letter
  // in the 250 px desktop grid cells ("Asura Sc") while a plain-text part ended in "…".
  if (group) { parts.push(<span key="g"><GroupAvatar name={group} size={14} className="me-1 align-text-bottom" />{group}</span>); plain.push(group); }
  if (via) { const t = tr('via {source}', { source: via }); parts.push(<span key="via">{t}</span>); plain.push(t); }
  if (versions && versions >= 2) { const t = tr('{n} versions', { n: versions }); parts.push(<span key="v">{t}</span>); plain.push(t); }
  if (talk && talk.reactions > 0) {
    const t = talk.reactions === 1 ? tr('1 reaction') : tr('{n} reactions', { n: talk.reactions });
    parts.push(<span key="r" data-row-reactions><span aria-hidden>{talk.top.join('')} {talk.reactions}</span><span className="sr-only">{t}</span></span>);
    plain.push(t);
  }
  if (talk && talk.comments > 0) {
    const t = commentsLine(talk.comments);
    parts.push(<span key="c" data-row-comments><span aria-hidden><IcComment width={11} height={11} className="me-0.5 inline align-[-1px]" />{talk.comments}</span><span className="sr-only">{t}</span></span>);
    plain.push(t);
  }
  if (!parts.length && !pruned && !short) return null;
  const title = [...(pruned ? [pruned.full] : []), ...(short ? [short] : []), ...plain].join(' · ');
  if (pruned) {
    const caption = parts.map((n, i) => (
      <span key={i}>
        {i > 0 && <span aria-hidden className="text-ink-600"> · </span>}
        {n}
      </span>
    ));
    return (
      // A tombstone's words are read whole, wherever the row is (v0.55.7). As a chip in the one truncating line below,
      // "File no longer on disk" came out "File no lo…" in the three-column grid at 1280, where a row with a full
      // date leaves this caption 51-68 px. So the words are a tag of their own: the sentence below lg, a word or two
      // in the grid (prunedWords says why) with the sentence as the title and for a screen reader, and it takes the
      // line's width and wraps inside it when even that does not fit -- squared, as the chapter sheet's tags are, so
      // a second line reads as one box. The group's caption follows, on the same line when both fit, and ends in an
      // ellipsis as before (one shrinking part, never a row of shrink-0 ones that would run under the date).
      <div className={`mt-0.5 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[11px] ${tone}`} title={title}>
        {/* Shown even when a copy is saved on this device -- it is still gone from the server, and "yours is the
            last one" is exactly what somebody wants to know before clearing downloads. One wording for every
            tombstone the server deleted: the same mark is left by an admin's Delete from server as by the scheduled
            cleanup, and the row cannot tell which, so "to free space" blamed a job that is off on most installs. A
            file Rescan everything found gone from a library built by hand has words of its own (prunedLabel,
            v0.55.4): nothing deleted it. */}
        <span data-tombstone className="max-w-full break-words rounded-[4px] border border-ink-700 px-1 text-[10px] leading-4 text-fog-600">
          <span aria-hidden="true" className="lg:hidden">{pruned.full}</span>
          <span aria-hidden="true" className="hidden lg:inline">{pruned.short}</span>
          <span className="sr-only">{pruned.full}</span>
        </span>
        {short && <span className="max-w-full truncate rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 text-[10px] leading-4 text-amber-300">{short}</span>}
        {parts.length > 0 && <span className="min-w-12 flex-1 basis-0 truncate">{caption}</span>}
      </div>
    );
  }
  return (
    // One block that truncates as a whole (inline children, no flex): a flex row of shrink-0 parts would
    // run under the date at the end of the row instead of ending in an ellipsis.
    <p className={`mt-0.5 truncate text-[11px] ${tone}`} title={title}>
      {/* Before the group, as a chip and not a caption part: "3 pages missing · Asura Scans" would read as
          the group's fault. The count is the file's -- the reader shows the caption on exactly those pages. */}
      {short && <span className="me-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 text-[10px] leading-4 text-amber-300">{short}</span>}
      {parts.map((n, i) => (
        <span key={i}>
          {i > 0 && <span aria-hidden className="text-ink-600"> · </span>}
          {n}
        </span>
      ))}
    </p>
  );
}

/**
 * The date at the end of a row: "3d ago" on the phone, "3d" on the desktop grid. A 287-px cell (three
 * columns at 1280) leaves the caption 71 px beside "3d ago", and a group name with its avatar is ≈90: the
 * word is what the column can spare there, and the number still reads as a date beside the others. Older
 * chapters show the locale date in both forms, as the column always has. `lg` is where the list becomes
 * the grid. Two spans rather than a media query in JS: the first paint of a static export knows no width.
 *
 * ⚠️ The short form is lib/format.ts `relativeTimeShort`, not this sentence with " ago" cut off: every
 * language but English says the sentence through Intl ("vor 3 Tagen"), where the cut matched nothing and
 * the grid showed the whole of it.
 */
function RowDate({ iso, className = '' }: { iso: string; className?: string }) {
  return (
    <span className={`shrink-0 text-[11px] text-fog-500 ${className}`}>
      <span className="lg:hidden">{relativeTime(iso)}</span>
      <span className="hidden lg:inline">{relativeTimeShort(iso)}</span>
    </span>
  );
}

/**
 * The row's buttons. In the compact list (lib/compactChapters.ts) they sit in a wrapper that appears on hover or
 * focus; otherwise there is no wrapper at all, so the default row is exactly what it was. An empty wrapper -- a
 * row showing none of its buttons -- renders nothing, or it would still take a flex gap.
 */
function ButtonsWrap({ compact, menuOpen, children }: { compact: boolean; menuOpen: boolean; children: ReactNode }) {
  if (!compact) return <>{children}</>;
  if (!Children.toArray(children).length) return null;
  return <div className={buttonsClass(menuOpen)}>{children}</div>;
}

function ChapterRow({ book, downloaded, sourceNames, primarySource, versions, onReader, onToggleDownload, onMark, onEdit, onVersions, onReplaceFrom, onCopyPath, onHide, onRefetch, onDelete, selectable, selected, onToggle, compact, lit, talk, onTalk }: {
  book: Book;
  /** v0.87.0: the chapter's talk for the caption, and the menu's Comments, while the household has any. */
  talk?: ChapterTalkCount | null;
  onTalk?: () => void;
  /** Admins only (#136): copy the chapter file's full path. Absent for everyone else and for a row with no path. */
  onCopyPath?: () => void;
  /**
   * Admins only (#240): hide this chapter's number from the series, for everyone -- it asks first. Nothing is deleted.
   * Absent for everyone else, and for a file holding a range of chapters, which no number hides.
   */
  onHide?: () => void;
  /**
   * Admins only, on a file Uchiyomi downloaded (v0.62.0): the select bar's Fetch again and Delete from server, for this
   * one chapter -- each asks first, as the bar's do. Absent for everyone else, and Delete for a file already deleted.
   */
  onRefetch?: () => void;
  onDelete?: () => void;
  /** Lit for a moment: the chapter a `?ch=` link (Health's Open) came to see. */
  lit?: boolean;
  /** The opt-in compact chapter list (lib/compactChapters.ts). Off: the row is exactly as it always was. */
  compact?: boolean;
  downloaded: boolean;
  /** Select mode: the row toggles instead of opening, shows the ✓ bubble, and hides its own two controls. */
  selectable?: boolean; selected?: boolean; onToggle?: () => void;
  /** Source id -> display name, from the series' followed sources; names the caption on a chapter another source supplied. */
  sourceNames?: Record<string, string>;
  /** The series' own source. A chapter from it gets no `via`: that is the normal case, not news. */
  primarySource?: string;
  /** How many copies the sources offer for this number; the caption says so from two up. */
  versions?: number;
  onReader: () => void;
  onToggleDownload: () => Promise<void>;
  onMark: (mode: 'read' | 'unread' | 'previous') => void;
  /** admin only: opens the number/title editor. Absent for everyone else. */
  onEdit?: () => void;
  /** Opens the chapter sheet with every copy of this number; absent when the sources know none. */
  onVersions?: () => void;
  /** Admins only: compare this file with another source's copy of the same number and swap it. Absent when no other source has one. */
  onReplaceFrom?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const rp = book.readProgress;
  // Page 0 is unread: it is what Mark unread writes (setRead), and Continue reading reads it so too (lib/continueLabel.ts).
  // Counted as "reading", a chapter marked unread showed "page 0/19" in the accent.
  const state = rp?.completed ? 'read' : rp && rp.page >= 1 ? 'reading' : 'unread';
  // The ⋯ button's menu, which right-click, a press-and-hold and Shift+F10 on the row now open as well (#100,
  // components/ContextMenu.tsx). It was a hand-rolled popover that clipped at the screen's edge.
  const menu = useContextMenu(() => [
    // A part-read chapter offers both (#215, klave7): finish it, or put it back to unread, its page with it.
    ...(state !== 'read' ? [{ label: tr('Mark read'), onSelect: () => onMark('read') }] : []),
    ...(state !== 'unread' ? [{ label: tr('Mark unread'), onSelect: () => onMark('unread') }] : []),
    { label: tr('Mark previous as read'), onSelect: () => onMark('previous') },
    ...(onTalk ? [{ label: talk?.comments ? `${tr('Comments')} · ${talk.comments}` : tr('Comments'), divider: true, hook: 'comments', onSelect: onTalk }] : []),
    ...(onVersions ? [{ label: tr('Versions'), divider: true, onSelect: onVersions }] : []),
    ...(onReplaceFrom ? [{ label: tr('Replace from another source…'), onSelect: onReplaceFrom }] : []),
    ...(onEdit ? [{ label: tr('Edit number & title'), divider: true, onSelect: onEdit }] : []),
    ...(onCopyPath ? [{ label: tr('Copy file path'), divider: !onEdit, onSelect: onCopyPath }] : []),
    ...(onHide ? [{ label: tr('Hide chapter {n}', { n: book.number }), divider: !onEdit && !onCopyPath, hook: 'hide-chapter', onSelect: onHide }] : []),
    ...(onRefetch ? [{ label: tr('Fetch again'), divider: true, onSelect: onRefetch }] : []),
    ...(onDelete ? [{ label: tr('Delete from server'), divider: !onRefetch, danger: true, onSelect: onDelete }] : []),
  ], { label: tr('Chapter actions') });
  // Only a name is shown; an id that resolves to nothing (a source since removed) shows no caption at all.
  const altSource = book.sourceId && book.sourceId !== primarySource ? (sourceNames?.[book.sourceId] ?? null) : null;
  /**
   * The server's read-chapter cleanup deleted the file. The row STAYS -- this is a real chapter of the
   * series, it is read, and the counts and progress all refer to it -- but the two buttons that promise
   * pages must stop promising them. Opening it would lay out zero pages and downloading it would save an
   * empty chapter, and both would look like a bug in the reader rather than a decision the admin made.
   *
   * ⚠️ UNLESS IT IS ALREADY ON THIS DEVICE. The reader consults the offline copy before the server, so a
   * chapter saved before the cleanup took it still opens and still reads perfectly. Greying that out would
   * take away the one copy of it left in the world.
   */
  const pruned = book.pruned === true && !downloaded;

  return (
    // `id="ch-N"` is what the chapter chips in the Sources & translations sheet scroll to. `lg:gap-2.5`: on
    // the desktop grid a 287-px cell (three columns at 1280) leaves the caption ≈90 px beside the thumb,
    // the dot, the date and two 36-px buttons -- exactly a group name with its avatar -- and a two-digit
    // day ("29d") took 4 of them back. Five gaps at 10 rather than 12 return ten. GhostRow matches.
    // UI refresh: a pointer lights the row under it, a surface just past the row's own edges (the grid's gaps have room).
    <div id={`ch-${book.number}`} className={`border-b border-ink-800/70 transition-colors lg:-mx-2 lg:px-2 lg:pointer-fine:hover:bg-white/[0.035]${lit ? ' rounded-lg bg-accent/10 ring-1 ring-inset ring-accent/50' : ' lg:rounded-lg'}`}>
    <div className={rowClass(!!compact)} {...(selectable ? {} : menu.bind)}>
      {/* In select mode a pruned chapter is still selectable -- Mark read and Fetch again are exactly the
          things one wants for it -- so the disable only applies to opening. */}
      <button onClick={selectable ? onToggle : onReader} disabled={pruned && !selectable} aria-pressed={selectable ? !!selected : undefined}
        className="flex min-w-0 flex-1 items-center gap-3 text-start disabled:cursor-default">
        <div className={`relative h-14 w-10 shrink-0${thumbHide(!!compact, !!selectable)} overflow-hidden rounded-lg border ${state === 'read' ? 'border-ink-800 opacity-45' : 'border-ink-700'} ${book.pruned && !downloaded ? 'border-dashed border-ink-600' : ''}`}>
          {/* A tombstone has no file to draw a thumbnail from; asking would be a 404 per row on every visit.
              The dashed empty box is the ghost row's, so "no pages here" reads the same in both places. */}
          {!(book.pruned && !downloaded) && <Img src={img.bookThumb(book.id)} alt="" className="h-full w-full" />}
          {state === 'reading' && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-accent" />}
          {selectable && <SelectBubble selected={!!selected} />}
        </div>
        <span className={`h-2 w-2 shrink-0 rounded-full${dotHide(!!compact)} ${state === 'read' ? 'bg-ink-600' : state === 'reading' ? 'bg-accent' : 'bg-accent/40'}`} />
        <div className="min-w-0">
          <p className={`truncate text-sm ${state === 'read' ? 'text-fog-500' : 'text-fog-100'}`}>
            {chapterLabel(book)}
            {/* The chapter's own name, when the source gave one that is not just the number again. */}
            {chapterName(book) && <span className="text-fog-500"> · {chapterName(book)}</span>}
          </p>
          <RowCaption group={book.scanlator} via={altSource} versions={versions} pruned={prunedWords(book)} missing={book.missingPages?.length} talk={talk} />
          {state === 'reading' && rp && (
            <p className="text-[11px] text-accent">{tr('page {page}/{pages}', { page: rp.page, pages: book.media.pagesCount })}</p>
          )}
        </div>
      </button>
      {book.metadata?.releaseDate && <RowDate iso={book.metadata.releaseDate} />}
      {!selectable && <ButtonsWrap compact={!!compact} menuOpen={menu.open}>
      {/* Not on Uchiyomi Desktop (lib/desktop.ts): the chapter is already a file on this computer. */}
      {!isDesktop() && <button
        onClick={async () => {
          if (busy) return;
          setBusy(true);
          try { await onToggleDownload(); } catch {}
          setBusy(false);
        }}
        // `pruned` already excludes a chapter saved on this device, so removing that copy still works --
        // which matters, because it is the only copy left.
        disabled={pruned}
        className={`grid h-9 w-9 place-items-center rounded-lg border disabled:opacity-30 ${downloaded ? 'border-accent/40 text-accent' : 'border-ink-700 text-fog-500'}`}
        // "Save offline", not "Download": the ☁ on a ghost row brings a chapter onto the server, this arrow
        // copies one to this device, and one word for both promised the wrong thing on one of them.
        aria-label={downloaded ? tr('Remove from this device') : tr('Save offline')}
      >
        {busy ? <span className="text-[10px] font-semibold text-accent">…</span> : downloaded ? <IcCheck width={16} height={16} /> : <IcDownload width={16} height={16} />}
      </button>}
      <div className="relative shrink-0">
        <button onClick={(e) => menu.openFrom(e.currentTarget)} aria-label={tr('Chapter actions')} aria-haspopup="menu" aria-expanded={menu.open}
          className="grid h-9 w-9 place-items-center rounded-lg border border-ink-700 text-fog-500">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
        </button>
      </div>
      </ButtonsWrap>}
      {menu.element}
    </div>
    </div>
  );
}

/** The ✓ bubble on a thumb in select mode -- the library tile's, so the two select modes look like one. */
function SelectBubble({ selected }: { selected: boolean }) {
  return (
    <>
      {selected && <span className="absolute inset-0 z-10 rounded-lg border-2 border-accent bg-accent/20" />}
      <span className={`absolute start-1.5 top-1.5 z-20 grid h-6 w-6 place-items-center rounded-full border text-[11px] font-bold ${
        selected ? 'border-accent bg-accent text-black' : 'border-white/50 bg-black/50 text-transparent'}`}>✓</span>
    </>
  );
}

/**
 * A chapter the sources list that this server does not hold.
 *
 * Same grid and height as ChapterRow so the list reads as one list, dimmed so it reads as absent. Tapping it
 * opens the chapter sheet -- every copy on offer, with Fetch on each -- so a row that looks like a chapter
 * does something when tapped (it used to be inert, and a row that does nothing is worse than one that says
 * so). The caption is the point of the row: "not here yet" and "only a blocked group has it" want different
 * things done about them, and only `failed` is amber, because it is the only one that is news rather than
 * a state. The downloader's error text is in the sheet for admins (the server sends `reason` to nobody
 * else).
 *
 * A reader can mark it read without ever fetching it (#69): the row then takes the chapter row's read
 * treatment -- the filled grey dot, the dimmed title -- plus a ✓ in the empty thumb, and it STAYS dashed and
 * dimmed, because "this server does not have it" is still true. The mark lives in its own table and becomes
 * ordinary progress when the chapter lands (bff lib/listingProgress).
 */
function GhostRow({ ghost, sourceNames, primarySource, selectable, selected, onToggle, onFetch, onOpen, onMark, onHide, compact, wholeHere }: {
  ghost: Ghost;
  /** The series holds a chapter at this ghost's whole number: what a covered row's caption says (lib/chapterRows.ts whyLabel). */
  wholeHere?: boolean;
  /** ChapterRow's compact list, so the two kinds of row still line up where they interleave. */
  compact?: boolean;
  sourceNames?: Record<string, string>;
  primarySource?: string;
  selectable?: boolean; selected?: boolean; onToggle?: () => void;
  /**
   * Fetch this one chapter now, for a viewer who may download; absent for everyone else and for a row only
   * blocked groups released (the caller decides both, the row only draws the button). Select mode stays the
   * bulk path and hides it. Asked for on #40 with a Tachimanga screenshot: a fetch icon per row, no Select.
   */
  onFetch?: () => Promise<void>;
  /** Open the chapter sheet for this number. */
  onOpen: () => void;
  /**
   * Mark this number read (true) or unread (false) -- the ⋯ menu, the chapter row's. For every viewer who
   * can see the page, download permission or not: a mark costs no bytes. Select mode hides it like the ☁.
   */
  onMark?: (completed: boolean) => void;
  /** Admins only (#240): hide this number from the series, for everyone -- a source's stray. It asks first. */
  onHide?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const read = ghost.read === true;
  // The actions that apply to a chapter that is not here, on the same menu as a chapter row's (#100).
  const menu = useContextMenu(() => [
    ...(onMark ? [{ label: read ? tr('Mark unread') : tr('Mark read'), onSelect: () => onMark(!read) }] : []),
    ...(onHide ? [{ label: tr('Hide chapter {n}', { n: ghost.number }), divider: !!onMark, hook: 'hide-chapter', onSelect: onHide }] : []),
  ], { label: tr('Chapter actions') });
  const hasMenu = !!onMark || !!onHide;
  const menuBind = hasMenu && !selectable ? menu.bind : {};
  const label = whyLabel(ghost, { wholeHere });
  // The same rule as the chapter row's caption: the series' own source is the normal case, not news. The
  // listing carries the source's name, so an id the followed list no longer resolves still gets one --
  // ⚠️ unless that "name" IS the id: the server falls back to `getSource(id)?.name ?? id`, so a source that
  // is no longer loaded (an extension removed since the check) arrives as `ext:fake` or a nineteen-digit
  // number, and the ChapterRow rule is that a caption is a name or nothing. Reintroduce by dropping the
  // `!== ghost.sourceId` test: seed a ghost from an unloaded source and its caption reads the raw id.
  const altSource = ghost.sourceId !== primarySource
    ? (sourceNames?.[ghost.sourceId] ?? (ghost.sourceName !== ghost.sourceId ? ghost.sourceName : null))
    : null;
  // Most sources title a chapter "Chapter 12", which beside "Ch. 12" says nothing twice.
  const title = ghost.title?.trim() || '';
  const showTitle = !!title && !/^(ch(apter)?\.?\s*)?[\d.]+$/i.test(title);
  return (
    <div id={`ch-${ghost.bookId ?? ghost.number}`} className="border-b border-ink-800/70">
    {/* The dimming is the opener's and the date's, not the row's: the fetch button at the end of the line
        is a live control, and a child cannot undo its parent's opacity. */}
    <div className={rowClass(!!compact)} {...menuBind}>
      <button type="button" onClick={selectable ? onToggle : onOpen} aria-pressed={selectable ? !!selected : undefined} aria-haspopup={selectable ? undefined : 'dialog'}
        className={`flex min-w-0 flex-1 items-center gap-3 text-start ${selected ? '' : 'opacity-60'}`}>
        <div className={`relative grid h-14 w-10 shrink-0${thumbHide(!!compact, !!selectable)} place-items-center rounded-lg border border-dashed border-ink-600`}>
          {read && !selectable && (
            <span role="img" aria-label={tr('Read · not on the server')} className="text-fog-500"><IcCheck width={14} height={14} /></span>
          )}
          {selectable && <SelectBubble selected={!!selected} />}
        </div>
        <span className={`h-2 w-2 shrink-0 rounded-full${dotHide(!!compact)} ${read ? 'bg-ink-600' : 'border border-ink-600'}`} />
        <div className="min-w-0">
          <p className={`truncate text-sm ${read ? 'text-fog-500' : 'text-fog-300'}`}>
            {/* Compact hides the box, and its tick's label with it: say it once for screen readers. */}
            {compact && read && !selectable && <span className="sr-only hidden lg:pointer-fine:inline">{tr('Read · not on the server')} </span>}
            {chapterLabel({ number: ghost.number, numberEnd: ghost.numberEnd })}
            {showTitle && <span className="text-fog-500"> · {title}</span>}
          </p>
          {/* "waiting for Asura Scans · 2 days left" already names the group; the group part is for the
              other reasons, where the caption would otherwise not say who has it. */}
          <RowCaption lead={label ? { text: tr(label.key, label.args), amber: ghost.why === 'failed', ...(label.full ? { full: tr(label.full.key, label.full.args) } : {}) } : null}
            group={ghost.why === 'held' && label?.args.g ? null : ghost.scanlator} via={altSource} />
        </div>
      </button>
      {ghost.publishedAt && <RowDate iso={ghost.publishedAt} className={selected ? '' : 'opacity-60'} />}
      <ButtonsWrap compact={!!compact} menuOpen={menu.open}>
      {/* The cloud, not the ⬇ of the row above: that arrow saves a chapter to THIS DEVICE, this one brings
          it onto the server, and the same glyph for both would promise the wrong thing on one of them. */}
      {onFetch && !selectable && (
        <button type="button" aria-label={tr('Fetch')} disabled={busy}
          onClick={async () => {
            if (busy) return;
            setBusy(true);
            try { await onFetch(); } finally { setBusy(false); }
          }}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-ink-700 text-fog-500 disabled:opacity-60">
          {busy ? <span className="text-[10px] font-semibold text-accent">…</span> : <IcCloudDownload width={16} height={16} />}
        </button>
      )}
      {/* The chapter row's ⋯, with the actions that apply to a chapter that is not here. */}
      {hasMenu && !selectable && (
        <div className="relative shrink-0">
          <button type="button" onClick={(e) => menu.openFrom(e.currentTarget)} aria-label={tr('Chapter actions')} aria-haspopup="menu" aria-expanded={menu.open}
            className="grid h-9 w-9 place-items-center rounded-lg border border-ink-700 text-fog-500">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
          </button>
        </div>
      )}
      </ButtonsWrap>
      {menu.element}
    </div>
    </div>
  );
}

/** The one job the page started, and when: `dataUpdatedAt` is compared against `at`, see below. */
interface StartedJob { folder: string; at: number }
interface SourceJob { folder: string; status: string; reason?: string; reasonSaid?: Said[] }

/** The localStorage key for the per-device "Show chapters not on the server yet" switch in the Filter sheet. */
const SHOW_GHOSTS_KEY = 'uchiyomi.showGhosts';
function readShowGhosts(): boolean {
  try { return localStorage.getItem(SHOW_GHOSTS_KEY) !== 'off'; } catch { return true; }
}

/**
 * Prev / a range picker / Next for the chapter list. The picker names each page by the first and last chapter
 * numbers it shows ("901–1000", or "1193–1094" newest first), which is what a reader hunting for a chapter
 * number actually scans for.
 *
 * ⚠️ No count beside it: "86–129 of 149" counted FILES (149, half chapters included) next to chapter numbers, and read as
 * chapters 130–149 missing (the owner, 10-19). The header says how many chapters there are, and their numbers when those
 * differ (numberingSpan). Reintroduce by putting `of {n}` back: chapterPages.test.ts finds it.
 */
function ChapterPager({ page, pages, rows, asc, onPage }: { page: number; pages: number; rows: readonly Row[]; asc: boolean; onPage: (p: number) => void }) {
  const range = (p: number) => pageLabel(rows, p, asc);
  return (
    <nav aria-label={tr('Chapter pages')} data-chapter-pager className="my-2 flex items-center justify-center gap-2 text-xs">
      <button type="button" onClick={() => onPage(0)} disabled={page === 0} className="btn-key px-2.5" aria-label={tr('First page')}>«</button>
      <button type="button" onClick={() => onPage(page - 1)} disabled={page === 0} className="btn-key">{tr('Previous')}</button>
      <select value={page} onChange={(e) => onPage(Number(e.target.value))} aria-label={tr('Chapter pages')}
        className="h-8 rounded-lg border border-ink-700 bg-ink-850 px-2.5 text-fog-100">
        {Array.from({ length: pages }, (_, p) => <option key={p} value={p}>{range(p)}</option>)}
      </select>
      <button type="button" onClick={() => onPage(page + 1)} disabled={page >= pages - 1} className="btn-key">{tr('Next')}</button>
      <button type="button" onClick={() => onPage(pages - 1)} disabled={page >= pages - 1} className="btn-key px-2.5" aria-label={tr('Last page')}>»</button>
    </nav>
  );
}

/**
 * The work's language editions, under the title (v0.52.0, #72): one chip per edition this viewer may open -- the one
 * on screen active, the others saying how far the viewer has read there -- and a tap opens that edition. A person who
 * may add series gets "+ Language" after them, the add dialog's "Add a language". Only with two editions or more: a
 * series on its own has nothing to switch to, and its second language starts from Sources & translations.
 */
function EditionChips({ editions, onAdd, className = '' }: { editions: EditionRow[]; onAdd?: () => void; className?: string }) {
  const labels = editionChipLabels(editions, { name: languageName, chapter: (n) => chapterLabel({ number: n }) });
  return (
    <div role="group" aria-label={tr('Editions')} data-editions className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      {editions.map((e, i) => (e.current
        ? <span key={e.seriesId} aria-current="page" className="chip chip-active text-xs">{labels[i]}</span>
        : <Link key={e.seriesId} href={`/series/?id=${encodeURIComponent(e.seriesId)}`} className="chip text-xs">{labels[i]}</Link>))}
      {onAdd && (
        <button type="button" onClick={onAdd} aria-label={tr('Add a language')} className="btn-key h-7 text-[11px]">{tr('+ Language')}</button>
      )}
    </div>
  );
}

function SeriesInner() {
  const id = useSearchParams().get('id') || '';
  const wantCh = chParam(useSearchParams().get('ch'));
  // Health's Open on a numbering finding (#116, lib/healthLinks.ts numberingHref): the plan, open on arrival.
  const wantPlan = useSearchParams().get('numbering') === 'review';
  // A new comment's push (v0.87.0, bff lib/comments.ts conversationPush): that chapter's talk, open on arrival.
  const wantTalk = useSearchParams().get('comments');
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { isAdmin, user, status: authStatus } = useAuth();
  const [editChapter, setEditChapter] = useState<Book | null>(null);
  // Edit details, open on a tab: Details from its key, Reading from the Sources sheet's language Change.
  const [editing, setEditing] = useState<EditTab | null>(null);
  const [collecting, setCollecting] = useState(false);
  const [findingMissing, setFindingMissing] = useState(false);
  const [asc, setAsc] = useState(true);
  const [downloaded, setDownloaded] = useState<Set<string>>(new Set());
  const [showSummary, setShowSummary] = useState(false);
  const [downloadingAll, setDownloadingAll] = useState(false);
  // Ghost rows: the chapters the sources list that this server lacks. Per device, default on, because
  // "there are 12 more of these" is the news this page exists to carry; off is for a phone that only ever
  // reads what is already here.
  const [showGhosts, setShowGhosts] = useState(true);
  // Whether this device's choice has been read yet: a `?ch=` jump waits for it, or the switch arriving one render
  // later resets the chapter page under a jump that already happened (a series still cached from a minute ago).
  const [ghostsRead, setGhostsRead] = useState(false);
  useEffect(() => { setShowGhosts(readShowGhosts()); setGhostsRead(true); }, []);
  const [showAll, setShowAll] = useState(false);
  // Select mode, the library's pattern. Two sets because a chapter is picked by id and a ghost has none --
  // it is picked by number, which is what the fetch route takes. Cleared whenever the list under it
  // changes shape, so a selection can never outlive the rows it was made from.
  const [selecting, setSelecting] = useState(false);
  const [pickedBooks, setPickedBooks] = useState<Set<string>>(new Set());
  const [pickedGhosts, setPickedGhosts] = useState<Set<string>>(new Set());
  const [acting, setActing] = useState(false);
  // What a confirm acts on: the select bar's subset, or the one chapter a row's ⋯ names (v0.62.0).
  const [confirming, setConfirming] = useState<null | { what: 'delete' | 'refetch'; books: Book[] }>(null);
  // The chosen chapters no source this series follows lists (bff lib/sourceLeftovers.ts): the Delete confirmation warns
  // that nothing can fetch them again. Asked when it opens; a failure warns of nothing rather than block the delete.
  const deletingIds = confirming?.what === 'delete' ? confirming.books.map((b) => b.id) : [];
  const { data: unlisted } = useQuery({
    queryKey: ['chapters-unlisted', id, deletingIds.join(',')],
    queryFn: async () => {
      const unlisted: string[] = [];
      for (const bookIds of chunkNumbers(deletingIds, 500)) {
        const result = await api<{ unlisted: string[] }>(`/api/admin/series/${encodeURIComponent(id)}/chapters/unlisted`, { json: { bookIds } });
        unlisted.push(...result.unlisted);
      }
      return { unlisted };
    },
    enabled: !!id && deletingIds.length > 0,
    retry: false,
  });
  // #240: the chapter numbers a Hide asks about -- a row's ⋯, or the select bar's -- and More's Show hidden chapters.
  const [hiding, setHiding] = useState<number[] | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [started, setStarted] = useState<StartedJob | null>(null);
  const clearPicks = () => { setPickedBooks(new Set()); setPickedGhosts(new Set()); };
  const leaveSelect = () => { setSelecting(false); clearPicks(); };
  // The four sheets and the explainer. ⚠️ At most one is open at a time, and a sheet is closed BEFORE any
  // Modal opens: `Modal`/`ConfirmDialog` are z-50 and `Sheet` z-60 inside main's stacking context, so a
  // dialog opened while a sheet is up paints under its backdrop and cannot be tapped. The explainer is a
  // Sheet too, so the (i) SWAPS it for the sources sheet (and back on close) rather than stacking: two
  // stacked sheets both listen for Escape, and one press closed both.
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [chapterSheet, setChapterSheet] = useState<{ number: number; book?: Book; ghost?: Ghost } | null>(null);
  // The renumbering plan (#116), opened from the numbering notice or, for an admin, from the versions sheet.
  const [numberingSheet, setNumberingSheet] = useState<PlanMode | null>(null);
  useEffect(() => { setNumberingSheet(null); }, [id]);
  // ...or from Health, whose link names no mode: the plan of whatever waits, as the route picks it. Once per series,
  // for an admin (the routes are theirs), and `numbering` then leaves the address, as `ch` does below, so a reload
  // or Back does not open it again. After the reset above, which runs first.
  const openedPlan = useRef<string | null>(null);
  useEffect(() => {
    if (!wantPlan || !isAdmin || openedPlan.current === id) return;
    openedPlan.current = id;
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete('numbering');
      window.history.replaceState(window.history.state, '', `${u.pathname}${u.search}${u.hash}`);
    } catch { /* the plan opens regardless */ }
    setNumberingSheet('next');
  }, [wantPlan, isAdmin, id]);
  // The older-chapters runs the reader unfolded, by the run's lowest number (chapterRows.ts). Hiding one
  // drops its ghosts from the picks: they leave the screen, and the same rule as `toggleGhosts` applies --
  // a row nobody can see cannot stay picked, or the bar keeps counting and Fetch acts on it.
  const [expandedRuns, setExpandedRuns] = useState<Set<number>>(new Set());
  // "Show all chapters at once" (the account's, lib/showAllChapters.ts): one page, every ghost, every run open.
  // A run the reader folds while it is on is remembered in `foldedRuns` instead -- the runs start open, so what
  // the page has to hold is the exceptions.
  const everything = showAllChaptersOn(user?.settings);
  const [foldedRuns, setFoldedRuns] = useState<Set<number>>(new Set());
  const runsOpen = useMemo(() => openRuns(everything, expandedRuns, foldedRuns), [everything, expandedRuns, foldedRuns]);
  const toggleRun = (from: number, keys: string[]) => {
    const hiding = runsOpen.has(from);
    const flip = (o: Set<number>) => { const next = new Set(o); next.has(from) ? next.delete(from) : next.add(from); return next; };
    if (everything) setFoldedRuns(flip); else setExpandedRuns(flip);
    if (hiding) setPickedGhosts((p) => { const n = new Set(p); for (const key of keys) n.delete(key); return n; });
  };
  useEffect(() => { setSelecting(false); setPickedBooks(new Set()); setPickedGhosts(new Set()); setShowAll(false); setExpandedRuns(new Set()); setFoldedRuns(new Set()); setChapterSheet(null); }, [id, asc]);

  // The same two queries lib/seriesPrefetch.ts asks for at the click that opens this page, so the page usually mounts on
  // them rather than on its placeholders.
  const { data: series, refetch: refetchTitleArt } = useQuery({ ...seriesQuery(id), enabled: !!id });
  // A computer's layout (lg and up): the banner hero with the title logo, the More menu. Under it the cover is the hero
  // and no logo is shown (v0.102.2), so a phone does not poll for one either.
  const wide = useWideViewport();
  useTitleArtPolling(id, series ? [series] : [], refetchTitleArt, authStatus !== 'offline' && wide);
  const { data: books } = useQuery({ ...seriesBooksQuery(id), enabled: !!id });
  // v0.87.0: which chapters have talk, and how much (GET /api/series/:id/comments); nothing while `on` is false, and never
  // asked on Uchiyomi Desktop, where the route does not exist. v0.90.0: nor by an account that switched Comments and
  // reactions off (lib/comments.ts talkWantedOf).
  const talkWanted = talkWantedOf(user?.settings);
  const { data: talkData } = useQuery({
    queryKey: seriesTalkKey(id),
    queryFn: () => api<{ on: boolean; content: ChapterTalkCount[] }>(`/api/series/${id}/comments`),
    enabled: !!id && !isDesktop() && talkWanted,
    staleTime: 60_000,
  });
  const talkOn = !!talkData?.on && talkWanted;
  const talkOf = useMemo(() => new Map((talkData?.content ?? []).map((x) => [x.bookId, x])), [talkData]);
  const [talkFor, setTalkFor] = useState<string | null>(null);
  const talkedOf = useRef<string | null>(null);
  useEffect(() => {
    if (!wantTalk || !talkOn || !books || talkedOf.current === wantTalk) return;
    talkedOf.current = wantTalk;
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete('comments');
      window.history.replaceState(window.history.state, '', `${u.pathname}${u.search}${u.hash}`);
    } catch { /* the sheet opens regardless */ }
    if (books.content.some((b) => b.id === wantTalk)) setTalkFor(wantTalk);
  }, [wantTalk, talkOn, books]);
  // What the sources list that the library lacks, as of the updater's last visit. A courtesy, never a
  // blocker: no retry, and an error renders no ghost rows rather than a message, because the chapters on
  // disk are the page and this is the margin note.
  const { data: listing, isFetched: listingSettled } = useQuery({
    queryKey: ['series-listing', id],
    queryFn: () => api<Listing>(`/api/series/${id}/listing`),
    enabled: !!id,
    retry: false,
  });
  const ghosts = useMemo(() => listing?.content ?? [], [listing]);
  // Whether the slow archive on this series is paused -- its own, or everyone's. Its numbers are not being fetched
  // then, and their run row says so (v0.49.1). Everyone's from the archive view the downloads poll reads (no request of
  // its own; it follows a Pause all within seconds), else from the listing: the poll is refused to a viewer who may
  // not download, and their row went on saying "being archived slowly" under the pause.
  const { data: serverJobs } = useServerDownloads();
  const archivePaused = !!listing?.archive && (listing.archive.state === 'paused'
    || (serverJobs?.archive ? serverJobs.archive.paused : listing.archive.pausedForAll === true));
  // The groups behind the supply line, the Sources & translations sheet and the group filter: one hook,
  // the route for the viewer's role (SourcesSheet.tsx says which), fetched once for all three.
  const { groups, admin: adminGroups, error: groupsError, isLoading: groupsLoading, checkedAt: groupsCheckedAt } = useSeriesGroups(id, isAdmin);
  // Every copy of every listed number, for the `{n} versions` captions and the chapter sheet. Fetched once
  // per page as soon as there is a row to caption -- the caption needs the count before anyone opens
  // anything -- and cached for a minute, because it is one request for the whole list and the sweep that
  // changes its answer runs on the hour, not the second.
  const { data: versionsData } = useQuery({
    queryKey: ['series-versions', id],
    queryFn: () => api<Versions>(`/api/series/${id}/versions`),
    enabled: !!id && ((books?.content.length ?? 0) > 0 || ghosts.length > 0),
    staleTime: 60_000,
    retry: false,
  });
  // Every number with at least one copy: the chapter sheet lists a single copy too (it is where Fetch on a
  // ghost lives); the caption says "{n} versions" only from two up, since one copy is not a version, it is
  // the chapter.
  const versionsOf = useMemo(() => {
    const m = new Map<number, VersionCopy[]>();
    for (const v of versionsData?.content ?? []) if (v.copies.length >= 1) m.set(v.number, v.copies);
    return m;
  }, [versionsData]);
  // The group filter in the Filter sheet. `ALL_GROUPS` is the sentinel for "every group" (groupFilter.ts
  // says why a real name could not be); it resets with the series, since a group name is meaningless on
  // the next one.
  const [group, setGroup] = useState<string>(ALL_GROUPS);
  useEffect(() => { setGroup(ALL_GROUPS); }, [id]);
  const { data: similar } = useQuery({ queryKey: ['similar', id], queryFn: () => api<{ content: Series[] }>(`/api/series/${id}/similar`), enabled: !!id });
  // Saved pages and notes for this series. Both, because this door is the ONLY route to
  // `/moments/?series=<id>`, and that filtered view is the only place the note composer mounts -- the
  // nav, the profile verb and the palette all go to the bare `/moments`. Counting bookmarks alone left a
  // series with notes and no saved pages with no door at all, and a series with neither unable to write
  // its first note: the same trap the composer's own comment says it avoids one level down.
  // v0.60.0: the door is More's (lib/seriesActions.ts notesLabel), and the two counts are asked for once More has been
  // opened on this series -- two requests on every visit bought a line most visits never looked at. A count already
  // cached from an earlier look is shown at once.
  const [askedNotes, setAskedNotes] = useState(false);
  useEffect(() => { setAskedNotes(false); }, [id]);
  const { data: moments } = useQuery({
    queryKey: ['bookmarks', id],
    queryFn: () => api<{ content: unknown[] }>(`/api/bookmarks?seriesId=${encodeURIComponent(id)}`),
    enabled: !!id && askedNotes,
  });
  const { data: seriesNotes } = useQuery({
    queryKey: ['notes', id],
    queryFn: () => api<{ content: unknown[] }>(`/api/notes?seriesId=${encodeURIComponent(id)}`),
    enabled: !!id && askedNotes,
  });
  const notesCounts = moments && seriesNotes ? { moments: moments.content?.length ?? 0, notes: seriesNotes.content?.length ?? 0 } : null;

  const [fav, setFav] = useState(false);
  // How many times Favourite was turned on in this visit: each one pops the heart once (components/SeriesKeys.tsx).
  const [favPops, setFavPops] = useState(0);
  useEffect(() => {
    if (series?.yomi) setFav(series.yomi.favorite);
  }, [series]);
  useEffect(() => { setFavPops(0); }, [id]);
  // The reader's own stars are read from the series' cached payload, which a rating changes optimistically
  // (components/RatingsPanel.tsx useSeriesRating): one copy, so the panel and a refetch never disagree. AniList's word
  // beside them is the panel's as well -- said once (v0.60.0), where v0.58.0 said both up to three times on the page.
  const rating = series?.yomi?.rating ?? null;
  const rate = useSeriesRating(id);

  useEffect(() => {
    listDownloads().then((d) => setDownloaded(new Set(d.filter((c) => c.seriesId === id).map((c) => c.bookId))));
  }, [id]);

  // ambient cover-art theming
  useEffect(() => {
    applyCover(series?.color);
    return () => clearCover();
  }, [series?.color]);

  // Numbers with a chapter row here: the sheet's chapter chips are solid for these, and a ghost on one of
  // them is a stale listing's, never a row (mergeRows applies the same rule; this keeps the filter's count
  // honest too). A file holding a range holds every number in it (heldBy, v0.55.2).
  const allBooks = useMemo(() => books?.content ?? [], [books]);
  const haveNumbers = useMemo(() => heldBy(allBooks), [allBooks]);
  // The whole numbers the series holds something at, for a covered row's caption (GhostRow `wholeHere`): each of a
  // range's too (wholesHeld).
  const haveWholes = useMemo(() => wholesHeld(allBooks), [allBooks]);
  // The sheet's solid chips are the LIVE rows only: a tombstone keeps its row (the ghost dedupe above is
  // right to count it -- the number is not "missing", it was deleted on purpose) but has no pages, and a
  // solid chip promises pages. Reintroduce by passing `haveNumbers` to the sheet: the chip for a pruned
  // number is solid, and tapping it lands on "Deleted from the server".
  const liveNumbers = useMemo(() => heldBy(allBooks.filter((b) => !b.pruned)), [allBooks]);
  // The admin's "Show deleted chapters as ghosts" (Listing.deletedAsGhosts): a chapter deleted on purpose leaves the
  // chapter rows and joins the ghosts (chapterRows.ts ghostOfDeleted) -- unless this device saved a copy, which keeps
  // it a chapter you can open. The dedupe above still counts it, so a listed ghost on its number is not drawn twice.
  const asGhost = useCallback((b: Book) => listing?.deletedAsGhosts === true && deliberatelyDeleted(b) && !downloaded.has(b.id), [listing?.deletedAsGhosts, downloaded]);
  const rowBooks = useMemo(() => allBooks.filter((b) => !asGhost(b)), [allBooks, asGhost]);
  const deletedGhosts = useMemo(() => allBooks.filter(asGhost).map(ghostOfDeleted), [allBooks, asGhost]);
  const visibleGhosts = useMemo(() => (showGhosts ? [...ghosts.filter((g) => !haveNumbers.has(g.number)), ...deletedGhosts] : []), [showGhosts, ghosts, haveNumbers, deletedGhosts]);
  // The names the filter offers: the groups route's, or -- when it answered with nothing (a series scanned
  // from disk, a route that is not there) -- whatever the chapters on disk name, so a hand-built library
  // with tagged files still gets the filter.
  const groupNames = useMemo(() => {
    if (groups.length) return groups.map((g) => g.name);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const b of allBooks) for (const g of groupsOfRow(b)) { const k = normGroup(g); if (!seen.has(k)) { seen.add(k); out.push(g); } }
    return out;
  }, [groups, allBooks]);
  // The filter is applied BEFORE mergeRows, so the run rows and the "Show all" fold are computed over what
  // is shown: a filter that hid 40 of 50 capped ghosts and still said "Show all 120" would be lying.
  const filteredBooks = useMemo(() => (group === ALL_GROUPS ? rowBooks : rowBooks.filter((b) => matchesGroup(b, group))), [rowBooks, group]);
  const filteredGhosts = useMemo(() => (group === ALL_GROUPS ? visibleGhosts : visibleGhosts.filter((g) => matchesGroup(g, group))), [visibleGhosts, group]);
  // The list, in the list's direction: chapters on disk and, between them, the ghosts (see chapterRows.ts).
  const rows = useMemo(() => mergeRows(filteredBooks, filteredGhosts, asc, showAll || everything, runsOpen), [filteredBooks, filteredGhosts, asc, showAll, everything, runsOpen]);
  // A series with no chapters at all (a "Nothing yet" add) has one thing to show: the run of older chapters
  // under its floor, which is every number the source lists. It opens unfolded, once per series AND
  // direction -- a ref, not an effect on `rows`, or Hide would be undone by the next listing refetch.
  // ⚠️ Keyed by `asc` too: the effect above folds every run on Newest/Oldest, and a key of `id` alone let
  // it re-open nothing, so one tap on the sort left the page with a single folded run row and no other
  // content until the reader found Show.
  const defaultedRun = useRef<string | null>(null);
  useEffect(() => {
    const key = `${id}:${asc}`;
    if (!series || series.booksCount !== 0 || !ghosts.length || defaultedRun.current === key) return;
    defaultedRun.current = key;
    setExpandedRuns(new Set(mergeRows([], ghosts, true, true).filter((r) => r.kind === 'run').map((r) => (r as Extract<typeof r, { kind: 'run' }>).from)));
  }, [series, ghosts, id, asc]);
  // For the per-chapter `via {source}` caption: which source each id is, and which one is the series' own.
  // A chapter fetched through "Find missing chapters" carries the adapter it came from without that source
  // being followed, so the names come from the full source list too -- never the raw id, which for an
  // extension is a nineteen-digit number nobody can read. ⚠️ Only for a viewer who may download: the route
  // answers 403 to everyone else, which was one failed request per visit for a member without download
  // rights; their names come from `series.sources` and the listing's `sourceName`.
  const { data: allSources } = useQuery({
    queryKey: ['sources'],
    queryFn: () => api<{ content: { id: string; name: string }[] }>('/api/sources'),
    staleTime: 60_000,
    enabled: canDownload(user) && (books?.content ?? []).some((b) => !!b.sourceId),
  });
  const sourceNames = useMemo(() => ({
    ...Object.fromEntries((allSources?.content ?? []).map((s) => [s.id, s.name])),
    ...Object.fromEntries((series?.sources ?? []).map((s) => [s.sourceId, s.name])),
  }), [series, allSources]);
  const primarySource = series?.sources?.find((s) => s.primary)?.sourceId;
  // The supply line's facts. `checkedAt`: the groups route's, or the listing's when the route did not send
  // one, or the source row's -- all the same `series_listing` check. `notHere` counts what the sweep would
  // take (the old "behind" semantics); the older run under the floor is the run row's to say, and a covered
  // number is another split of a chapter that is here (v0.50.0). Settled =
  // the three queries behind it have answered or failed, so the line does not rewrite itself as they land.
  const supplyChecked = groupsCheckedAt ?? listing?.checkedAt ?? series?.sources?.find((s) => s.primary)?.checkedAt ?? null;
  const supplyLoaded = !!series && !!listingSettled && !groupsLoading;
  const supplyInput = useMemo(() => ({
    sources: series?.sources ?? [],
    groups: groups.map((g) => g.name),
    notHere: ghosts.filter((g) => countsAsBehind(g) && !haveNumbers.has(g.number)).length,
    listedTotal: ghosts.length,
    booksCount: series?.booksCount ?? 0,
    checkedAt: supplyChecked,
    autoUpdate: series?.autoUpdate !== false,
    groupsError: !!groupsError,
    isAdmin,
  }), [series, groups, ghosts, haveNumbers, supplyChecked, groupsError, isAdmin]);
  const supplyPhone = useMemo(() => supplyLine(supplyInput, false), [supplyInput]);
  const supplyWide = useMemo(() => supplyLine(supplyInput, true), [supplyInput]);

  // The reading button's one choice (lib/continueLabel.ts, v0.60.0): the chapter part-read, the next one after the
  // highest finished, the first -- or nothing to read. It opened the lowest unfinished chapter under "Start reading"
  // even after chapters 1 to 10 were read. A chapter the server deleted has no pages to open -- unless this device
  // saved a copy, in which case that copy is the last one and opening it is right. Without this, "Continue" on a
  // series whose next unread chapter was pruned opened straight onto "Chapter deleted".
  const reading = useMemo(() => {
    const openable = (b: Book) => !b.pruned || downloaded.has(b.id);
    return continueChoice(books?.content ?? [], openable);
  }, [books, downloaded]);
  const resumeBook = reading.book;

  // The list a page at a time (lib/chapterPages.ts). It opens on the page holding `resumeBook`, so a reader
  // on chapter 956 lands among the 900s, and then STAYS there: the page is decided once per series, sort and
  // filter, when the chapters and the sources' listing have both arrived (its ghost rows land between
  // chapters and would shift a page picked before them). Following Continue live made the list jump away
  // from what the reader was doing -- expanding an older-chapters run or "Show all" inserts rows ahead of
  // it, and "Mark all read" sends Continue back to chapter 1.
  // This device's choice of the compact chapter list (lib/compactChapters.ts), read after mount: the static
  // export renders without localStorage, and the default row is the one to render until we know.
  const [compact, setCompact] = useState(false);
  useEffect(() => { setCompact(compactChaptersOn()); }, []);
  // This device's chapter layout (#214, lib/chapterView.ts), read after mount for the same reason.
  const [view, setView] = useState<ChapterView>('columns');
  useEffect(() => { setView(chapterViewOn()); }, []);
  const [chapterPage, setChapterPage] = useState<number | null>(null);
  useEffect(() => { setChapterPage(null); }, [id, asc, group, showGhosts]);
  // Every row on one page when the account asked for the whole list (pageSizeFor): the pager then has one page and
  // is not drawn, and every turn-to-a-page below lands on page 0.
  const pageSize = pageSizeFor(everything, rows.length);
  const autoPage = useMemo(() => (resumeBook ? pageOf(rows, (r) => r.kind === 'book' && r.book.id === resumeBook.id, pageSize) : 0), [rows, resumeBook, pageSize]);
  useEffect(() => { if (chapterPage === null && books && listingSettled) setChapterPage(autoPage); }, [chapterPage, books, listingSettled, autoPage]);
  // A link to ONE chapter -- Health's Open (lib/healthLinks.ts) -- turns the list to that chapter's page, brings
  // the row into view and lights it for a moment. A number the library does not hold (a gap) lands on the chapter
  // just before it, where the gap begins. Once, when the chapters and the sources' listing have both arrived --
  // declared after the effect above, so its page wins over Continue's -- and `ch` then leaves the URL (the
  // router's own history state kept), so a reload or Back does not jump again.
  const [litCh, setLitCh] = useState<number | null>(null);
  const jumpedTo = useRef<string | null>(null);
  useEffect(() => {
    if (wantCh === null || !ghostsRead || !books || !listingSettled) return;
    const key = `${id}:${wantCh}`;
    if (jumpedTo.current === key) return;
    jumpedTo.current = key;
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete('ch');
      window.history.replaceState(window.history.state, '', `${u.pathname}${u.search}${u.hash}`);
    } catch { /* the jump happens regardless */ }
    const held = rows.flatMap((r) => (r.kind === 'book' ? [r.book.number] : []));
    const n = landingNumber(held, wantCh);
    const i = n === null ? -1 : rows.findIndex((r) => r.kind === 'book' && r.book.number === n);
    if (n === null || i < 0) return;
    setChapterPage(Math.floor(i / pageSize));
    setLitCh(n);
    const still = effectsReduced() || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    // Two frames: the page switch renders first, then the row exists to scroll to. getElementById, not a
    // selector: `ch-12.5` is not a valid one.
    requestAnimationFrame(() => requestAnimationFrame(() =>
      document.getElementById(`ch-${n}`)?.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' })));
  }, [wantCh, ghostsRead, id, books, listingSettled, rows, pageSize]);
  useEffect(() => {
    if (litCh === null) return;
    const t = setTimeout(() => setLitCh(null), 2600);
    return () => clearTimeout(t);
  }, [litCh]);
  const shownPage = clampPage(chapterPage ?? autoPage, rows.length, pageSize);
  const pages = pageCount(rows.length, pageSize);
  const pageRows = useMemo(() => pageSlice(rows, shownPage, pageSize), [rows, shownPage, pageSize]);
  // A chip in Sources & translations jumps to a chapter's row, which may be on another page: turn to it
  // first. A number with no row (folded into a run, or filtered out) leaves the page as it is.
  const showChapter = (n: number) => {
    const i = rows.findIndex((r) => (r.kind === 'book' && r.book.number === n) || (r.kind === 'ghost' && r.ghost.number === n));
    if (i >= 0) setChapterPage(Math.floor(i / pageSize));
  };
  const chaptersTop = useRef<HTMLDivElement>(null);
  const goPage = (p: number, scroll: boolean) => {
    setChapterPage(clampPage(p, rows.length, pageSize));
    if (scroll) chaptersTop.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  const back = () => (typeof window !== 'undefined' && window.history.length > 1 ? router.back() : router.push('/'));

  const toggleFav = async () => {
    const next = !fav;
    setFav(next);
    if (next) setFavPops((n) => n + 1);
    try {
      if (next) await api('/api/favorites', { json: { seriesId: id } });
      else await api(`/api/favorites/${id}`, { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: ['home'] });
      qc.invalidateQueries({ queryKey: ['library'] });
    } catch {
      // Put back, and say so: the heart that stayed lit over a refusal was the one feedback, and it lied.
      setFav(!next);
      toast(tr('Could not do that'), 'error');
    }
  };

  const toggleDownload = async (bookId: string) => {
    if (downloaded.has(bookId)) {
      await deleteDownload(bookId);
      setDownloaded((s) => { const n = new Set(s); n.delete(bookId); return n; });
    } else {
      await downloadChapter(bookId);
      setDownloaded((s) => new Set(s).add(bookId));
    }
  };

  // manual read-state changes go through the same progress endpoint the reader uses, but `silent`
  // so bulk-marking a backlog doesn't count as chapters "read this week" on the leaderboard
  const setRead = async (targets: Book[], completed: boolean) => {
    for (const b of targets) {
      try {
        await api(`/api/books/${b.id}/progress`, {
          method: 'PUT',
          json: { page: completed ? b.media.pagesCount || 1 : 0, completed, seriesId: id, silent: true },
        });
      } catch {}
    }
    qc.invalidateQueries({ queryKey: ['series-books', id] });
    qc.invalidateQueries({ queryKey: ['series', id] });
    qc.invalidateQueries({ queryKey: ['home'] });
  };
  /**
   * The same for chapters the server does not hold (#69): they have no book id for the progress endpoint,
   * so they go by number to their own route, in chunks of its cap (MARK_CHUNK). Neither writes a reading
   * event. ⚠️ No offline outbox: the outbox replays `/api/books/:id/progress` and a ghost has no book, so a
   * failure says so instead of pretending it will sync later. The caches are invalidated either way -- a
   * chunk that landed before a failure is still a change -- the books' too, because a number that landed
   * since the page loaded is marked on its chapter row by the server. Resolves to whether every chunk was
   * accepted.
   */
  const markGhosts = async (numbers: number[], completed: boolean): Promise<boolean> => {
    let ok = true;
    try {
      for (const chunk of chunkNumbers(numbers, MARK_CHUNK)) {
        await api(`/api/series/${id}/listing-progress`, { method: completed ? 'POST' : 'DELETE', json: { numbers: chunk } });
      }
    } catch {
      ok = false;
      toast(tr('Could not mark — try again when online'), 'error');
    }
    qc.invalidateQueries({ queryKey: ['series-listing', id] });
    qc.invalidateQueries({ queryKey: ['series-books', id] });
    qc.invalidateQueries({ queryKey: ['series', id] });
    qc.invalidateQueries({ queryKey: ['home'] });
    return ok;
  };
  const markGhost = async (ghost: Ghost, completed: boolean) => {
    // A deliberate tombstone still has its original book row and progress. Keep duplicate chapter numbers
    // distinct by writing through that stable id; source-only ghosts have no book and keep the number route.
    if (ghost.bookId) {
      const book = allBooks.find((b) => b.id === ghost.bookId);
      if (!book) return;
      await setRead([book], completed);
      toast(completed ? tr('Marked read') : tr('Marked unread'), 'success');
      return;
    }
    if (await markGhosts([ghost.number], completed)) toast(completed ? tr('Marked read') : tr('Marked unread'), 'success');
  };
  const markChapter = async (b: Book, mode: 'read' | 'unread' | 'previous') => {
    if (mode === 'previous') {
      // Every chapter before this one, a file holding a range only when ALL of it is (its end, v0.55.2): marking
      // before chapter 5 must not mark a `03-07` file's 5 to 7 read.
      const prev = (books?.content ?? []).filter((x) => lastOf(x) < b.number && !x.readProgress?.completed);
      if (!prev.length) { toast(tr('Nothing before this chapter is unread')); return; }
      // One card, in one language: the result takes the busy card's place (the same key), so both are translated.
      toast(markingText(prev.length), 'info', { busy: true, key: 'mark-read' });
      await setRead(prev, true);
      toast(tr('Marked {n} read', { n: prev.length }), 'success', { key: 'mark-read' });
    } else {
      await setRead([b], mode === 'read');
      toast(mode === 'read' ? tr('Marked read') : tr('Marked unread'), 'success');
    }
  };
  // Deliberately the WHOLE list, not the group filter's subset: "Mark all read" is a statement about the
  // series, and a reader who filtered to one group to look at it did not thereby decide the other groups'
  // chapters are unread. Select mode is the way to mark a subset.
  // ⚠️ And the chapters on this server ONLY, never the grey rows (#69): a series listing 800 chapters would
  // otherwise tick all 800 with one tap -- and a contiguous run of ticks is exactly what the trackers are
  // told. Marking chapters the server does not hold is a choice made row by row or in select mode.
  // Reintroduce by adding the ghosts to `todo`: "Mark all read never touches the grey rows" in
  // seriesPage.test.ts fails.
  const markAllRead = async () => {
    const todo = (books?.content ?? []).filter((b) => !b.readProgress?.completed);
    if (!todo.length) { toast(tr('Everything is already read'), 'success'); return; }
    toast(markingText(todo.length), 'info', { busy: true, key: 'mark-read' });
    await setRead(todo, true);
    toast(todo.length === 1 ? tr('Marked 1 chapter read') : tr('Marked {n} chapters read', { n: todo.length }), 'success', { key: 'mark-read' });
  };
  // "Mark all unread" (More, v0.60.0): the request a series card's menu makes (components/SeriesMenu.tsx), so the two say
  // the same. The route deletes this reader's progress on every chapter of the series, and the marks on its grey rows
  // with it -- unread means those too -- and tells no tracker: a tracker left ahead is the safe direction.
  const markAllUnread = async () => {
    try {
      await api('/api/library/bulk/read', { json: { seriesIds: [id], completed: false } });
      toast(tr('Marked unread'), 'success');
    } catch { toast(tr('Could not do that'), 'error'); }
    for (const k of [['series-books', id], ['series-listing', id], ['series', id], ['home'], ['library'], ['collection']]) qc.invalidateQueries({ queryKey: k });
  };

  // The one download loop, for Save all offline and for Save offline in select mode: stops at the first
  // failure, because the usual cause is a full device and every further attempt would fail the same way.
  // ONE outcome, in the busy card's place (the same key), after the loop: stopped part-way, the error says what
  // was saved as well. The error used to be pushed inside the loop and the success after it under the same
  // key, which replaced the error in the same tick -- the reader saw "Saved 3 chapters offline" and never
  // learned it had stopped. offlineOutcome (lib/notices.ts) is the decision; notices.test.ts holds it and
  // fails on any flow that keys a success after its error.
  const saveOffline = async (todo: Book[]) => {
    toast(todo.length === 1 ? tr('Saving 1 chapter offline…') : tr('Saving {n} chapters offline…', { n: todo.length }), 'info', { busy: true, key: 'save-offline' });
    let done = 0;
    let stopped = false;
    for (const b of todo) {
      try {
        await downloadChapter(b.id);
        setDownloaded((s) => new Set(s).add(b.id));
        done++;
      } catch {
        stopped = true;
        break;
      }
    }
    const out = offlineOutcome(done, todo.length, stopped);
    if (out) toast(out.msg, out.type, { key: 'save-offline' });
  };
  const downloadAll = async () => {
    if (downloadingAll || !books) return;
    // A pruned chapter has no pages left on the server, so including it would "save" an empty chapter to
    // this device and then report it as downloaded. Skipped silently: it is not an error and there is
    // nothing the reader can do about it.
    const todo = books.content.filter((b) => !downloaded.has(b.id) && !b.pruned);
    if (!todo.length) { toast(tr('Everything is already saved offline'), 'success'); return; }
    setDownloadingAll(true);
    await saveOffline(todo);
    setDownloadingAll(false);
  };

  // ---- select mode -------------------------------------------------------------------------------
  const togglePickBook = (bookId: string) =>
    setPickedBooks((p) => { const n = new Set(p); n.has(bookId) ? n.delete(bookId) : n.add(bookId); return n; });
  const ghostKey = (g: Ghost) => g.bookId ? `book:${g.bookId}` : `number:${g.number}`;
  const togglePickGhost = (ghost: Ghost) =>
    setPickedGhosts((p) => { const n = new Set(p); const k = ghostKey(ghost); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const toggleGhosts = () => {
    const next = !showGhosts;
    setShowGhosts(next);
    try { localStorage.setItem(SHOW_GHOSTS_KEY, next ? 'on' : 'off'); } catch { /* private mode: the session still has it */ }
    // Rows that are no longer on screen cannot stay picked, or Fetch would act on what nobody can see.
    if (!next) setPickedGhosts(new Set());
  };
  // From the FILTERED lists: a pick the group filter has hidden is neither counted nor acted on, so the
  // toolbar's "{n} selected" is the number of rows the person can see ticked. The pick itself survives in
  // its set, and comes back when the filter is widened again.
  const pickedBookList = useMemo(() => filteredBooks.filter((b) => pickedBooks.has(b.id)), [filteredBooks, pickedBooks]);
  const pickedGhostList = useMemo(() => filteredGhosts.filter((g) => pickedGhosts.has(ghostKey(g))), [filteredGhosts, pickedGhosts]);
  // Each action's eligible subset. A button acts on its subset, never on the whole selection, and is
  // disabled when the subset is empty -- so picking three chapters and a ghost never makes Fetch try the
  // chapters. Mark read / Mark unread are the two that take BOTH kinds since #69 (bulkMark).
  const saveable = pickedBookList.filter((b) => !b.pruned && !downloaded.has(b.id));
  const fetchable = pickedGhostList.filter((g) => g.why !== 'blocked');
  const refetchable = pickedBookList.filter((b) => b.owned);
  // ⚠️ NOT filtered by `owned`. The server classifies each id and answers with a reason per skip, and the
  // toast below repeats it -- "3 skipped: not downloaded by Uchiyomi" is the one line that explains why a
  // hand-assembled library (86 % of the chapters on a real install) cannot be deleted from here. Filtering
  // here made that toast dead code: the ids never reached the server, and picking only such chapters
  // greyed the button out with no hint at all. Only tombstones are dropped, since there is no file to
  // delete and the server would say `already_pruned` for every one of them. Reintroduce by adding
  // `b.owned &&` back: pick a /library chapter and the delete says "0 deleted" -- or nothing.
  const deletable = pickedBookList.filter((b) => !b.pruned);
  // #240: the picked chapters' and grey rows' numbers, each once -- a hide is by number -- never a file holding a range.
  const hideable = useMemo(() => [...new Set([
    ...pickedBookList.filter((b) => b.numberEnd == null).map((b) => b.number),
    ...pickedGhostList.filter((g) => g.numberEnd == null).map((g) => g.number),
  ])].sort((a, b) => a - b), [pickedBookList, pickedGhostList]);
  const pickedCount = pickedBookList.length + pickedGhostList.length;
  const allPicked = pickedCount > 0 && pickedCount === filteredBooks.length + filteredGhosts.length;
  const selectAllChapters = () => {
    if (allPicked) { clearPicks(); return; }
    // The active group filter and the Show chapters not on the server switch define the selection,
    // across every chapter page. Collapsed missing-chapter runs represent selectable chapters too.
    setPickedBooks(new Set(filteredBooks.map((b) => b.id)));
    setPickedGhosts(new Set(filteredGhosts.map(ghostKey)));
  };
  // The select bar on the notices' layer stack (lib/layers.ts), measured: it wraps to three rows at 390 px,
  // and a notice has to rise above whichever height it has.
  const toolbarRef = useRef<HTMLDivElement>(null);
  useLayer('toolbar', selecting, { ref: toolbarRef });

  const invalidateChapters = () => {
    for (const k of [['series-books', id], ['series-listing', id], ['series-versions', id], ['series-groups', id], ['series-scanlators', id], ['series', id], ['home'], ['source-jobs']]) qc.invalidateQueries({ queryKey: k });
  };
  // The picked chapters AND the picked grey rows (#69): select mode is how a reader who reads elsewhere ticks
  // a stretch of chapters this server never fetched. Two requests, one per kind, and one toast that counts
  // what was asked. A ghost failure has already said so (markGhosts), so only a clean run toasts success.
  // Reintroduce by marking `pickedBookList` alone: "select mode marks the grey rows too" in
  // seriesPage.test.ts fails.
  const bulkMark = async (completed: boolean) => {
    setActing(true);
    const n = pickedBookList.length + pickedGhostList.length;
    const tombstones = pickedGhostList.flatMap((g) => g.bookId ? allBooks.filter((b) => b.id === g.bookId) : []);
    if (pickedBookList.length || tombstones.length) await setRead([...pickedBookList, ...tombstones], completed);
    const listed = pickedGhostList.filter((g) => !g.bookId);
    const ok = listed.length ? await markGhosts(listed.map((g) => g.number), completed) : true;
    if (ok) toast(completed ? tr('Marked {n} read', { n }) : tr('Marked {n} unread', { n }), 'success');
    setActing(false);
    leaveSelect();
  };
  const bulkSave = async () => {
    setActing(true);
    await saveOffline(saveable);
    setActing(false);
    leaveSelect();
  };
  // Fetch and Fetch again start a server job and return at once; the rows appear as the job lands them,
  // which is what the polling below is for.
  const startJob = async (path: string, body: Record<string, unknown>) => {
    setActing(true);
    try {
      const res = await api<{ folder: string; total: number }>(path, { method: 'POST', json: body });
      setStarted({ folder: res.folder, at: Date.now() });
      // Ask for the jobs now: the answer carries this job, and with it the poll's 2.5 s pace (AppShell's
      // poller reads its interval off each answer) -- otherwise the band and the ring wait out a 30 s idle poll.
      void kickDownloads(qc);
      toast(fetchingToast(res.total), 'info', { busy: true });
      invalidateChapters();
      leaveSelect();
    } catch (e) {
      toast(msgOf(e, tr('Could not start.')), 'error');
    }
    setActing(false);
    setConfirming(null);
  };
  const bulkFetch = async () => {
    const listed = fetchable.filter((g) => !g.bookId).map((g) => g.number);
    const deleted = fetchable.flatMap((g) => g.bookId ? [g.bookId] : []);
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [
      ...chunkNumbers(listed).map((numbers) => ({ path: '/api/sources/fetch', body: { seriesId: id, numbers } })),
      ...deleted.map((bookId) => ({ path: `/api/books/${bookId}/refetch`, body: {} })),
    ];
    if (!requests.length) return;
    setActing(true);
    try {
      for (const [i, request] of requests.entries()) {
        const res = await api<{ folder: string; total: number }>(request.path, { method: 'POST', json: request.body });
        setStarted({ folder: res.folder, at: Date.now() });
        void kickDownloads(qc);
        if (i === 0) {
          toast(fetchingToast(fetchable.length), 'info', { busy: true });
          invalidateChapters();
          leaveSelect();
        }
        if (i < requests.length - 1) {
          const ended = await awaitJob(res.folder);
          if (ended?.status === 'error') throw new Error(reasonText(ended) || tr('Fetch stopped. Try another source or wait.'));
        }
      }
    } catch (e) { toast(msgOf(e, tr('Could not start.')), 'error'); }
    setActing(false);
  };
  // The fetch icon on one ghost row: the bar's Fetch for a list of one, same request, same toast, same
  // polling -- so a chapter arrives the same way whether it was picked alone or with twenty others.
  const fetchOne = (number: number) => startJob('/api/sources/fetch', { seriesId: id, numbers: [number] });
  const fetchDeleted = (bookId: string) => startJob(`/api/books/${bookId}/refetch`, {});
  /**
   * Poll the shared jobs key until the job for `folder` is no longer downloading; the job as last seen, or
   * null when the list no longer has it (over and aged out -- or, past the same five seconds `jobDone`
   * allows, never listed) or the server could not be asked three times running. Through `fetchQuery` so
   * the Library ring, the band and this wait read the same answer and the requests are deduped.
   */
  const awaitJob = async (folder: string): Promise<SourceJob | null> => {
    const at = Date.now();
    let misses = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const list = await qc.fetchQuery({ queryKey: ['source-jobs'], queryFn: () => api<{ content: SourceJob[] }>('/api/sources/jobs'), staleTime: 0 }).catch(() => null);
      if (!list) { if (++misses >= 3) return null; continue; }
      misses = 0;
      const job = list.content?.find((j) => j.folder === folder);
      if (job ? job.status !== 'downloading' : Date.now() - at > 5000) return job ?? null;
    }
  };
  // One run of requests for this series, in chunks of at most FETCH_CHUNK (the routes' FILL_MAX_CHAPTERS), each
  // posted only after the previous chunk's job has ENDED. ⚠️ `startJob` returns when a job has started, not when it
  // is done, and the routes answer 409 `busy` while the series' job runs: the first cut posted the chunks back to
  // back, so on a run past 300 the reader saw "Fetching 300 chapters…" and then one error toast per further chunk,
  // and the rest was never fetched. One toast for the whole run; the run stops at the first chunk that fails to start
  // or whose job ends in error, with that message. `acting` holds for the whole run, so the chip cannot be tapped
  // into a 409 of its own meanwhile.
  const postInChunks = async <T,>(items: T[], post: (chunk: T[]) => Promise<{ folder: string; total: number }>) => {
    const chunks = chunkNumbers(items);
    setActing(true);
    try {
      for (const [i, chunk] of chunks.entries()) {
        const res = await post(chunk);
        setStarted({ folder: res.folder, at: Date.now() });
        void kickDownloads(qc);
        if (i === 0) {
          toast(fetchingToast(items.length), 'info', { busy: true });
          invalidateChapters();
          leaveSelect();
        }
        if (i === chunks.length - 1) break;
        const ended = await awaitJob(res.folder);
        if (ended?.status === 'error') { toast(reasonText(ended) || tr('Fetch stopped. Try another source or wait.'), 'error'); break; }
      }
    } catch (e) {
      toast(msgOf(e, tr('Could not start.')), 'error');
    }
    setActing(false);
  };
  // "Fetch all {n}" on an older-chapters run: the same request for the run's numbers.
  const fetchMany = (numbers: number[]) => postInChunks(numbers, (chunk) =>
    api<{ folder: string; total: number }>('/api/sources/fetch', { method: 'POST', json: { seriesId: id, numbers: chunk } }));
  // The wrong-language notice's Fetch them again (v0.62.0, components/LanguageNotice.tsx): Fetch again for its chapters,
  // each file replaced in place by the copy in the series' language.
  const refetchMany = (bookIds: string[]) => postInChunks(bookIds, (chunk) =>
    api<{ folder: string; total: number }>(`/api/admin/series/${id}/chapters/refetch`, { method: 'POST', json: { bookIds: chunk } }));
  const refetchBooks = (picked: Book[]) => refetchMany(picked.map((b) => b.id));
  // "Fetch" on one copy in the chapter sheet. A pick names the copy by source and the source's own id (`copySourceId`, never
  // a split on ':'), and the server takes it as an explicit choice: the group rules, blocklist included, do
  // not apply to it. On a ghost row the copy lands as the chapter; on an on-disk row the file is replaced,
  // which is asked about first below.
  const pickGhost = (number: number, copy: VersionCopy) =>
    startJob('/api/sources/fetch', { seriesId: id, picks: [{ number, source: copy.source, sourceId: copySourceId(copy) }] });
  const [coverPicker, setCoverPicker] = useState(false);
  const [replacing, setReplacing] = useState<{ book: Book; copy: VersionCopy } | null>(null);
  const [comparing, setComparing] = useState<Book | null>(null);
  const replaceWith = async () => {
    if (!replacing) return;
    await startJob(`/api/admin/series/${id}/chapters/refetch`, { picks: [{ bookId: replacing.book.id, source: replacing.copy.source, sourceId: copySourceId(replacing.copy) }] });
    setReplacing(null);
  };
  // Hide (#240, bff lib/hiddenChapters.ts): the numbers leave every surface for everyone, and nothing is deleted. In the
  // route's chunks of 500, as Delete from server is.
  const hideChapters = async (numbers: number[]) => {
    setActing(true);
    try {
      for (let i = 0; i < numbers.length; i += 500) {
        await api(`/api/admin/series/${id}/chapters/hide`, { method: 'POST', json: { numbers: numbers.slice(i, i + 500) } });
      }
      // What is true now: every number asked about is hidden, whether this press hid it or an earlier one did.
      toast(numbers.length === 1 ? tr('1 chapter is hidden.') : tr('{n} chapters are hidden.', { n: numbers.length }), 'success');
      qc.invalidateQueries({ queryKey: ['series-hidden', id] });
      invalidateChapters();
      leaveSelect();
    } catch (e) {
      toast(msgOf(e, tr('Could not hide that')), 'error');
    }
    setActing(false);
    setHiding(null);
  };
  const deleteBooks = async (picked: Book[]) => {
    setActing(true);
    const res = { applied: 0, skipped: [] as { id: string; reason: string }[] };
    try {
      for (const chunk of chunkNumbers(picked, 500)) {
        const result = await api<typeof res>(`/api/admin/series/${id}/chapters/delete`, {
          method: 'POST', json: { bookIds: chunk.map((b) => b.id) },
        });
        res.applied += result.applied;
        res.skipped.push(...result.skipped);
      }
      // Say what was skipped rather than silently deleting fewer than were selected, one line per reason
      // present: `not_owned` (the file is in a library the admin built, not one Uchiyomi fetched) and
      // `bookmarked` (a reader's bookmark names a page inside it) are the two a person can act on; the
      // rest -- `unlink_failed`, `outside_root`, `already_pruned` after a race -- are one line, because
      // the fix for all of them is the server log, not this page.
      const count = (reason: string) => res.skipped.filter((x) => x.reason === reason).length;
      const notOwned = count('not_owned');
      const bookmarked = count('bookmarked');
      const other = res.skipped.length - notOwned - bookmarked;
      const lines = [
        { n: notOwned, text: skippedNotOursText(notOwned) },
        { n: bookmarked, text: skippedBookmarkedText(bookmarked) },
        { n: other, text: other === 1 ? tr('1 chapter could not be deleted') : tr('{n} chapters could not be deleted', { n: other }) },
      ].filter((l) => l.n > 0);
      if (res.applied === 0 && lines.length) {
        // ⚠️ A delete that deleted nothing is not a success. A green "0 deleted" over unchanged rows was
        // what an unlink failure looked like; the dominant reason, in red, is what it looks like now.
        // Reintroduce by toasting "{n} deleted" unconditionally: pick a bookmarked chapter and delete it.
        // The other reasons still get their line (the docs promise one per reason), just not in red.
        const [head, ...rest] = lines.sort((a, b) => b.n - a.n);
        toast(head.text, 'error');
        for (const l of rest) toast(l.text, 'info');
      } else {
        toast(deletedText(res.applied), 'success');
        for (const l of lines) toast(l.text, 'info');
      }
      invalidateChapters();
      leaveSelect();
    } catch (e) {
      toast([res.applied ? deletedText(res.applied) : '', msgOf(e, tr('Could not delete those'))].filter(Boolean).join(' · '), 'error');
      invalidateChapters();
    }
    setActing(false);
    setConfirming(null);
  };

  // While the job this page started is downloading, read the shared jobs key and refresh the chapter queries
  // when it stops, so ghosts turn into rows without a reload. No poll of its own (v0.49.0): AppShell's one
  // poller asks every 2.5 s while a job downloads, and startJob kicks it the moment the job exists. A second
  // observer with its own interval would double the requests. ⚠️ `dataUpdatedAt` is compared against the
  // moment the job started: the key is shared with the Library ring, so the first render after the POST sees
  // its CACHED list -- from before the job existed -- and "the job is not in the list" would otherwise read as
  // "the job has finished".
  const jobs = useQuery({
    queryKey: ['source-jobs'],
    queryFn: () => api<{ content: SourceJob[] }>('/api/sources/jobs'),
    enabled: !!started,
  });
  const job = started ? jobs.data?.content?.find((j) => j.folder === started.folder) : undefined;
  const jobFresh = !!started && jobs.dataUpdatedAt >= started.at;
  // A fresh list without the job means it is over and has aged out -- or a poll that was already in flight
  // when the POST landed answered without it. Five seconds tells those apart: a job that has not appeared
  // by then is not going to. (`Date.now()` here is re-evaluated on every poll, which is what makes it a
  // clock rather than a constant.)
  const jobDone = jobFresh && (job ? job.status !== 'downloading' : Date.now() - started.at > 5000);
  useEffect(() => {
    if (!jobDone) return;
    setStarted(null);
    qc.invalidateQueries({ queryKey: ['series-books', id] });
    qc.invalidateQueries({ queryKey: ['series-listing', id] });
    // The versions' `onDisk` marker and the groups' `{n} on this server` both count the files that just landed.
    qc.invalidateQueries({ queryKey: ['series-versions', id] });
    qc.invalidateQueries({ queryKey: ['series-groups', id] });
    qc.invalidateQueries({ queryKey: ['series-scanlators', id] });
    qc.invalidateQueries({ queryKey: ['series', id] });
    qc.invalidateQueries({ queryKey: ['home'] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobDone]);

  const meta = series?.metadata;
  const summary = meta?.summary || series?.booksMetadata?.summary;
  const title = meta?.title || series?.name || '…';
  const author = meta?.author || meta?.publisher || '';
  // "Updated {X ago}" from the newest chapter's date (always available; a real publish date exists for only some series)
  const updatedAt = useMemo(() => {
    const ts = (books?.content ?? [])
      .map((b) => b.metadata?.releaseDate)
      .filter(Boolean)
      .map((d) => new Date(d as string).getTime())
      .filter((n) => !Number.isNaN(n));
    return ts.length ? new Date(Math.max(...ts)).toISOString() : null;
  }, [books]);
  // volume-based series (old manga stored as tomes) get "volumes" wording instead of "chapters"
  const mostlyVolumes = useMemo(() => {
    const c = books?.content ?? [];
    return c.length > 0 && c.filter((b) => isVolumeName(b.name || b.metadata?.title)).length > c.length / 2;
  }, [books]);

  // shared blocks (rendered once)
  const [deleting, setDeleting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [moving, setMoving] = useState(false);
  const [moveBusy, setMoveBusy] = useState(false);
  const [busyAdmin, setBusyAdmin] = useState(false);
  // A language edition (v0.52.0): the add dialog's "Add a language", and the unlink an admin confirms. `lang` and
  // `source` when a follow was refused for its language ("Add it as an edition"): the dialog opens on that language.
  const [addingLang, setAddingLang] = useState<{ lang?: string; source?: string } | null>(null);
  const [unlinking, setUnlinking] = useState<EditionRow | null>(null);
  const editions = (series?.edition?.editions?.length ?? 0) > 1 ? series!.edition!.editions! : null;
  const addLanguage = canDownload(user) ? () => setAddingLang({}) : undefined;
  // The work's own edition when it may follow the refused source already ("Open the Spanish edition"): its page, not a
  // second edition. The sheet or dialog the key sits in has closed itself (the wrappers below).
  const addEdition = canDownload(user) ? (o: { lang: string; source: string; existing?: { id: string } }) => (o.existing
    ? router.push(`/series/?id=${encodeURIComponent(o.existing.id)}`)
    : setAddingLang({ lang: o.lang, source: o.source })) : undefined;
  const unlink = async () => {
    if (!unlinking) return;
    setBusyAdmin(true);
    try {
      await api(`/api/admin/series/${encodeURIComponent(unlinking.seriesId)}/edition`, { method: 'DELETE' });
      toast(tr('Unlinked: it is a series of its own now'), 'success');
      for (const k of [['series', id], ['series', unlinking.seriesId], ['library'], ['home']]) qc.invalidateQueries({ queryKey: k });
      setUnlinking(null);
    } catch (e) { toast(msgOf(e, tr('Could not change that')), 'error'); }
    setBusyAdmin(false);
  };

  // A new automatic banner (v0.51.0): other chapters, other pages. The server makes it before switching, so a failure
  // leaves the banner as it was; the payload's new seed is what changes the hero's URL.
  const newBanner = async () => {
    setBusyAdmin(true);
    try {
      const r = await api<{ ok: boolean; same?: boolean }>(`/api/admin/series/${encodeURIComponent(id)}/hero/shuffle`, { method: 'POST', json: {} });
      // v0.52.0: the series' pages give no other banner (a short series whose few good crops are all on it). Said, rather
      // than "Banner changed" over the same picture.
      if (r.ok && r.same) toast(tr('This is the only banner this series’ pages give.'), 'info');
      else if (r.ok) { await qc.invalidateQueries({ queryKey: ['series', id] }); toast(tr('Banner changed'), 'success'); }
      else toast(tr('Could not make a new banner'), 'error');
    } catch {
      toast(tr('Could not make a new banner'), 'error');
    }
    setBusyAdmin(false);
  };

  const doDelete = async () => {
    setBusyAdmin(true);
    try {
      await api(`/api/admin/series/${id}`, { method: 'DELETE' });
      toast(tr('Series removed from the library'), 'success');
      router.push('/library');
    } catch (e) {
      toast(msgOf(e, tr('Could not remove it')), 'error');
    }
    setBusyAdmin(false);
  };

  // A "Nothing yet" series: added with no chapters, the older run under its floor is the page's only
  // content and the ☁ on those rows the call to action. Nothing to read, nothing to save offline.
  const nothingYet = !!series && series.booksCount === 0;
  // "Archive slowly" (#117): the rest of the series fetched a chapter at a time, over nights or days. Offered
  // while the listing has something the archive could take and no archive is on it; this page only starts
  // one -- its progress, Pause and Stop are the band's, above the chapter list.
  const archiveEnqueue = useArchiveEnqueue();
  const mayArchive = canDownload(user) && !!listing && !listing.archive
    && ghosts.some((g) => (g.why === 'floor' || g.why === 'missing') && !haveNumbers.has(g.number));
  const archiveSlowly = async () => {
    setActing(true);
    await archiveEnqueue([id], title);
    setActing(false);
  };
  // ---- the reading button, the four keys and More (v0.60.0) ----------------------------------------------------
  // Under the cover there were up to twelve stacked buttons, and on a 768-px-tall screen an admin's last ones ran past
  // the bottom of the sticky column. Now: one button that says what it opens, how far the reader is, and four keys --
  // Favourite, Offline, List, More. More holds the rest, grouped (lib/seriesActions.ts decides who sees what): a menu
  // from lg up, a sheet below, where a thumb is (`wide`, above).
  const seriesHref = `/series/?id=${encodeURIComponent(id)}`;
  const notesHref = `/moments/?series=${encodeURIComponent(id)}`;
  const openReader = () => { if (resumeBook) router.push(`/reader/?book=${resumeBook.id}`); };
  // While the chapters load the button waits with no words rather than guessing them; a series with none says so at once.
  const ctaText = books || nothingYet ? continueText(reading) : { label: '', caption: '' };
  // How far through the series: the chapters on the list once they are here (the list the button chose from), the
  // series' own counts until then. Nothing on a series with no chapters.
  const readCount = useMemo(() => (books
    ? { read: books.content.filter((b) => b.readProgress?.completed).length, total: books.content.length }
    : { read: series?.booksReadCount ?? 0, total: series?.booksCount ?? 0 }), [books, series]);
  const readLine = readCountText(readCount.read, readCount.total);
  // v0.61.0: what comes next -- the release radar's estimate, as an estimate (lib/radar.ts): "Next chapter ~Friday ·
  // usually Fridays", "Next chapter due any day", "Running late · last release 12d ago"; nothing for a series that is
  // quiet, ended, on hiatus, undated or not monitored. Before it, how long the chapters left take at this reader's own
  // pace (lib/readingTime.ts, "Catch up in ~2 hr"), asked only when it can be said: some read, some left.
  const unreadCount = Math.max(0, readCount.total - readCount.read);
  const { data: pace } = useQuery({
    queryKey: ['reading-pace', id],
    queryFn: () => api<{ perChapterMs: number | null; from: 'series' | 'all' | null }>(`/api/series/${id}/reading-pace`),
    enabled: !!id && readCount.read > 0 && unreadCount > 0,
    staleTime: 300_000,
  });
  const outlook = [
    catchUpText({ read: readCount.read, unread: unreadCount, perChapterMs: pace?.perChapterMs }),
    radarText(series?.yomi?.radar, { autoUpdate: series?.autoUpdate !== false }),
  ].filter(Boolean).join(' · ');
  // Check for new chapters, the Sources sheet's and Edit details' own: the same notices, the same polling.
  const { checking, checkNow } = useCheckNow(id, () => {
    for (const k of [['series', id], ['series-books', id], ['series-listing', id], ['series-versions', id], ['home']]) qc.invalidateQueries({ queryKey: k });
  });
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(publicServerURL(seriesHref, window.location.href));
      toast(tr('Link copied'), 'success');
    } catch { toast(tr('Could not copy the link'), 'error'); }
  };
  const moreGroups = seriesActionGroups({
    isAdmin, mayDownload: canDownload(user), booksCount: series?.booksCount ?? 0, mayArchive,
    autoHero: !!series?.autoHero, hasFolder: !!series?.folder, offline: authStatus === 'offline', notes: notesCounts,
    hiddenChapters: series?.hiddenChapters ?? 0,
    busy: { checkNew: checking, archive: acting, newBanner: busyAdmin },
  });
  const runAction = (a: SeriesActionId) => {
    switch (a) {
      case 'notes': router.push(notesHref); break;
      case 'markAllRead': void markAllRead(); break;
      case 'markAllUnread': void markAllUnread(); break;
      case 'findMissing': setFindingMissing(true); break;
      case 'hidden': setShowHidden(true); break;
      case 'archive': void archiveSlowly(); break;
      case 'checkNew': void checkNow(); break;
      case 'copyLink': void copyLink(); break;
      case 'openTab': window.open(seriesHref, '_blank', 'noopener'); break;
      case 'edit': setEditing('details'); break;
      // Change cover (#242): an admin's, from More -- never a key under the art, where a phone reads Continue first.
      case 'cover': setCoverPicker(true); break;
      case 'newBanner': void newBanner(); break;
      case 'move': setMoving(true); break;
      case 'rename': setRenaming(true); break;
      case 'remove': setDeleting(true); break;
    }
  };
  // ⚠️ The sheet closes BEFORE its row's action runs (SeriesMoreSheet's onPick): Edit details, Rename folder, Remove's
  // typed-title confirmation and Find missing chapters are dialogs, and a dialog opened under a Sheet cannot be tapped.
  const [moreSheet, setMoreSheet] = useState(false);
  useEffect(() => { setMoreSheet(false); }, [id]);
  const more = useContextMenu(() => moreMenuItems(moreGroups, runAction), { label: title });
  const openMore = (el: HTMLElement) => {
    setAskedNotes(true);
    if (wide) more.openFrom(el);
    else setMoreSheet(true);
  };
  const moreOpen = wide ? more.open : moreSheet;
  // The phone's bar (components/ContinueBar.tsx): once the button is out of view -- under the top bar, or below the
  // band the bottom nav and the bar itself take -- a compact copy of it, the heart and More. Never in Select mode, whose
  // bar takes the same place, and never from lg up.
  const ctaRef = useRef<HTMLDivElement>(null);
  // A phone's title, on the cover (UI refresh, phone): once it has scrolled under the bar, the bar turns glass and says it.
  const heroTitleRef = useRef<HTMLHeadingElement>(null);
  const titleOut = useOutOfView(heroTitleRef, '-72px 0px 0px 0px');
  const ctaOut = useOutOfView(ctaRef, '-64px 0px -160px 0px');
  const barShown = !wide && ctaOut && !selecting && !!series;

  const Actions = (
    <div className="mt-4 flex flex-col gap-2.5">
      {/* The one reading button. It names the chapter it opens -- "Continue · Ch. 12", "Next · Ch. 11" -- and the line
          under it says what the label does not: the chapter's own name and how far into it the reader is, or which
          chapter "Start reading" and "Read again" open. */}
      <div ref={ctaRef}>
        <ContinueButton label={ctaText.label} disabled={!resumeBook} onOpen={openReader} />
      </div>
      {ctaText.caption && <p data-continue-caption className="-mt-1 truncate text-center text-xs text-fog-500">{ctaText.caption}</p>}
      {readLine && <ReadProgress read={readCount.read} total={readCount.total} text={readLine} />}
      {outlook && <p data-series-outlook className="-mt-1 text-start text-[11px] leading-snug text-fog-500">{outlook}</p>}
      {/* Four keys, or three where there is nothing to save offline. Equal widths, whatever their number. */}
      <div data-series-keys className="mt-0.5 grid auto-cols-fr grid-flow-col gap-1.5">
        <FavouriteKey on={fav} pops={favPops} onToggle={toggleFav} />
        {/* "Save all offline", not "Download all": this copies to THIS DEVICE; the server side is Fetch (☁). Never on
            Uchiyomi Desktop, where this device IS the server (lib/desktop.ts). The key's word is "Offline", its name the
            whole action. */}
        {offlineKeyShown({ nothingYet, desktop: isDesktop() }) && (
          <SeriesKey icon={downloadingAll ? <ProgressRing progress="spin" size={20} /> : <IcDownload width={20} height={20} aria-hidden />}
            label={tr('Offline')} name={downloadingAll ? tr('Saving…') : tr('Save all offline')} onClick={downloadAll} disabled={downloadingAll} />
        )}
        <SeriesKey icon={<IcListAdd />} label={tr('List')} title={tr('Add to list')} onClick={() => setCollecting(true)}
          attrs={{ 'aria-haspopup': 'dialog' }} />
        <MoreKey onOpen={openMore} open={moreOpen} menu={wide} />
      </div>
    </div>
  );

  const span = series && books && !mostlyVolumes ? numberingSpan(books.content, series.booksCount) : null;
  const metaBits: ReactNode[] = [
    // v0.100.0 (#338): each name on the author line opens the Library showing that person's series. Only the author's: the
    // publisher shown in its place when there is none names no one the Library could list.
    meta?.author ? <AuthorLinks line={meta.author} />
      : author ? <span className="text-fog-300">{tr('by {author}', { author: `\u2068${author}\u2069` })}</span> : null,
    meta?.status ? <span className="capitalize">{statusText(meta.status)}</span> : null,
    series ? <>{bookCountText(series.booksCount, mostlyVolumes)}</> : null,
    // Their numbers, when they do not run 1 to the count (half chapters, a chapter 0, gaps): "149 chapters · Ch. 0–129".
    span ? <>{tr('Ch. {a}–{b}', span)}</> : null,
    (series?.yomi?.unread ?? series?.booksUnreadCount ?? 0) > 0 ? <span className="text-accent">{tr('{n} unread', { n: series!.yomi?.unread ?? series!.booksUnreadCount })}</span> : null,
    // "{n} behind" used to sit here; the supply line under the title carries that count now ("4 not here
    // yet"), with the source and the groups beside it, and one line saying it is enough.
    updatedAt ? <>{tr('Updated {ago}', { ago: relativeTime(updatedAt) })}</> : null,
    // The reader's stars and AniList's score were here as well, and over the banner, and under the stars (v0.58.0):
    // the ratings panel says them once now (components/RatingsPanel.tsx, v0.60.0).
  ].filter(Boolean);
  const Meta = (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fog-400 lg:text-sm">
      {metaBits.map((n, i) => (
        <span key={i} className="inline-flex items-center gap-2">
          {i > 0 && <span aria-hidden className="text-ink-600">·</span>}
          {n}
        </span>
      ))}
    </div>
  );

  const Genres = !!meta?.genres?.length && (
    // One row a phone swipes (UI refresh, phone): wrapped, eight genres took three lines before the summary.
    <div data-lenis-prevent-horizontal className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0 [&::-webkit-scrollbar]:hidden">
      {/* Each genre opens the Library filtered by it (UI refresh): a filter, so it keeps the filter chip's shape. */}
      {meta.genres.slice(0, 8).map((g) => (
        <Link key={g} href={`/library/?genres=${encodeURIComponent(g)}`} data-series-genre className="chip shrink-0 text-xs transition hover:border-accent/50 hover:text-fog-100">{g}</Link>
      ))}
    </div>
  );

  const Summary = summary && (
    <p className={`max-w-3xl text-sm leading-relaxed text-fog-300 ${showSummary ? '' : 'line-clamp-3 lg:line-clamp-4'}`} onClick={() => setShowSummary((s) => !s)}>
      {summary}
    </p>
  );

  // How many of the Filter sheet's two choices are off their default; the chip wears the number.
  const activeFilters = (group !== ALL_GROUPS ? 1 : 0) + (showGhosts ? 0 : 1);
  const Chapters = (
    <div ref={chaptersTop} className="scroll-mt-20">
      {/* How the chapters are numbered, when that needs saying (#116): above the band, which it can hold. */}
      <NumberingNotice seriesId={id} numbering={listing?.numbering} isAdmin={isAdmin} onReview={setNumberingSheet} />
      {/* Chapters here in another language than the series' (v0.62.0): the admin's, who can fetch them again. */}
      {isAdmin && <LanguageNotice notice={versionsData?.otherLanguage} busy={acting || !!started} onFetch={(ids) => void refetchMany(ids)} />}
      {/* What the server is fetching for this series, whoever started it (v0.49.0): above the list it fills. */}
      <SeriesServerDownloads seriesId={id} folder={series?.folder} />
      {/* The heading on its own line and ONE row of four short, text-only chips under it. Measured at
          390 px: with icons and the two long chips this was five chips on two rows plus two sentences;
          the four fit one row in English, and `flex-wrap` (never nowrap) is the safety valve for German
          -- a nowrap row past the viewport is the 1-pixel horizontal scroll the layout check flags. */}
      <div className="mb-2 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <h2 className="font-display text-lg font-semibold">{tr('Chapters')}</h2>
        {/* Keys, not chips (UI refresh, noPills.test.ts): these act on the list rather than filter it -- even Filter
            opens a sheet -- and they sat in a row of capsules right under the squared four keys. */}
        <div data-chapter-toolbar className="flex flex-wrap items-center gap-1.5">
          <button onClick={markAllRead} className="btn-key">{tr('Mark all read')}</button>
          <button onClick={() => setAsc((a) => !a)} className="btn-key">{asc ? tr('Oldest') : tr('Newest')}</button>
          {/* The group filter and the ghost switch live in a sheet; the count of active choices is a tiny
              badge on the chip, not ` · {n}` text, which is what pushed the row past 358 px. Rendered only
              when there is something to filter by. */}
          {(groupNames.length > 0 || ghosts.length > 0 || deletedGhosts.length > 0) && (
            <button onClick={() => setFilterOpen(true)} aria-haspopup="dialog" className={`btn-key relative ${activeFilters > 0 ? 'btn-key-accent' : ''}`}>
              {tr('Filter')}
              {activeFilters > 0 && (
                <span data-testid="filter-count" className="absolute -end-1.5 -top-1.5 grid h-4 min-w-4 place-items-center rounded-[4px] bg-accent px-[3px] text-[10px] font-bold leading-none text-black">{activeFilters}</span>
              )}
            </button>
          )}
          {/* A mode, not a filter: the library's chip, so the two select modes are one habit. */}
          <button onClick={() => { setSelecting((v) => !v); clearPicks(); }} className={`btn-key whitespace-nowrap ${selecting ? 'btn-key-accent' : ''}`}>
            {selecting ? tr('Done') : tr('Select')}
          </button>
          {/* #214: the rows in columns, or one list the page's width so a long title is read whole. From lg up, where the
              columns are; the Library's own Layout control, so the two read as one habit (lib/chapterView.ts). */}
          <div className="ms-auto hidden lg:block" data-chapter-view={view}>
            <Segmented square label={tr('Layout')} value={view} onChange={(v) => { setView(v); setChapterView(v); }}
              options={[
                { value: 'columns', label: tr('Columns'), icon: <IcGrid aria-hidden width={15} height={15} /> },
                { value: 'list', label: tr('List'), icon: <IcRows aria-hidden width={15} height={15} /> },
              ]} />
          </div>
        </div>
      </div>
      {group !== ALL_GROUPS && (
        <p className="mb-2 text-xs text-fog-500">
          {tr('{n} of {m} chapters match', { n: filteredBooks.length + filteredGhosts.length, m: rowBooks.length + visibleGhosts.length })}
        </p>
      )}
      {pages > 1 && <ChapterPager page={shownPage} pages={pages} rows={rows} asc={asc} onPage={(p) => goPage(p, false)} />}
      <div className={chapterRowsClass(view)} data-chapter-rows={view}>
        {pageRows.map((r) => {
          if (r.kind === 'book') {
            const b = r.book;
            return (
              <ChapterRow key={b.id} book={b} compact={compact} lit={litCh === b.number} downloaded={downloaded.has(b.id)} sourceNames={sourceNames} primarySource={primarySource}
                onReader={() => router.push(`/reader/?book=${b.id}`)} onToggleDownload={() => toggleDownload(b.id)}
                onMark={(mode) => markChapter(b, mode)}
                onEdit={isAdmin ? () => setEditChapter(b) : undefined}
                onCopyPath={isAdmin && b.path ? () => void copyPath(b.path!, toast) : undefined}
                onHide={isAdmin && b.numberEnd == null ? () => setHiding([b.number]) : undefined}
                onRefetch={isAdmin && b.owned ? () => setConfirming({ what: 'refetch', books: [b] }) : undefined}
                onDelete={isAdmin && b.owned && !b.pruned ? () => setConfirming({ what: 'delete', books: [b] }) : undefined}
                selectable={selecting} selected={pickedBooks.has(b.id)} onToggle={() => togglePickBook(b.id)}
                versions={versionsOf.get(b.number)?.length}
                onVersions={versionsOf.has(b.number) ? () => setChapterSheet({ number: b.number, book: b }) : undefined}
                onReplaceFrom={isAdmin && b.owned !== false && versionsOf.get(b.number)?.some((c) => !c.onDisk) ? () => setComparing(b) : undefined}
                talk={talkOn ? talkOf.get(b.id) : null} onTalk={talkOn ? () => setTalkFor(b.id) : undefined} />
            );
          }
          if (r.kind === 'ghost') {
            return (
              <GhostRow key={`g:${r.ghost.bookId ?? r.ghost.number}`} ghost={r.ghost} compact={compact} sourceNames={sourceNames} primarySource={primarySource}
                wholeHere={haveWholes.has(Math.floor(r.ghost.number))}
                selectable={selecting} selected={pickedGhosts.has(ghostKey(r.ghost))} onToggle={() => togglePickGhost(r.ghost)}
                onOpen={() => setChapterSheet({ number: r.ghost.number, ghost: r.ghost })}
                // Same audience and same exclusion as the bar's Fetch (`fetchable`): a row only blocked
                // groups released cannot be fetched while the block stands, so it gets no button.
                onFetch={canDownload(user) && r.ghost.why !== 'blocked'
                  ? () => r.ghost.bookId ? fetchDeleted(r.ghost.bookId) : fetchOne(r.ghost.number)
                  : undefined}
                onMark={(completed) => markGhost(r.ghost, completed)}
                onHide={isAdmin && r.ghost.numberEnd == null ? () => setHiding([r.ghost.number]) : undefined} />
            );
          }
          if (r.kind === 'run') {
            // One line for the whole stretch below the Latest-N floor, with Show/Hide to unfold it into
            // ordinary ghost rows (each with its ☁ and its sheet) and, for a viewer who may download,
            // "Fetch all {n}" for the whole stretch at once -- Find missing chapters is refused below three
            // chapters, so a "Nothing yet" series had no bulk way to its older chapters. The sentence
            // itself (range or single number, plural or singular) is `runLabel`'s, where a test can reach
            // it. `lg:col-span-full` because on a desktop the list is an auto-fill grid and a sentence in
            // one 250 px cell wrapped to two lines while the "Show all" row below it already spanned the row.
            const { key, args } = runLabel(r, { paused: archivePaused });
            // The run's own numbers, from the same filtered list the row was built from, so "Fetch all 5"
            // fetches the five the sentence counts and not a sixth the group filter hid.
            const runGhosts = filteredGhosts.filter((g) => g.why === r.why && g.number >= r.from && g.number <= r.to && !haveNumbers.has(g.number));
            const numbers = runGhosts.map((g) => g.number);
            const keys = runGhosts.map(ghostKey);
            // A run the slow archive is fetching (#117) says how far it has got and offers nothing but Show:
            // its Pause and Stop are the band's. An older-chapters run may start one instead.
            const archiving = r.why === 'archive';
            return (
              <div key={`run${r.from}`} data-run={r.why} className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-ink-800/70 py-2.5 text-xs text-fog-500 lg:col-span-full">
                <span className="me-auto">{archiving ? [tr(key, args), listingArchiveLine(listing?.archive)].filter(Boolean).join(' · ') : tr(key, args)}</span>
                {/* The two chips travel together: when the sentence leaves no room they wrap as one pair to
                    the end of the next line, not one chip after the sentence and one orphaned below. */}
                <span className="ms-auto flex shrink-0 gap-1.5">
                  <button type="button" onClick={() => toggleRun(r.from, keys)} aria-expanded={r.open} className={`chip shrink-0 px-2.5 py-1 text-[11px] ${r.open ? 'chip-active' : ''}`}>
                    {r.open ? tr('Hide') : tr('Show')}
                  </button>
                  {!archiving && canDownload(user) && numbers.length > 0 && (
                    <button type="button" onClick={() => fetchMany(numbers)} disabled={acting} className="chip shrink-0 px-2.5 py-1 text-[11px] disabled:opacity-50">
                      <IcCloudDownload width={14} height={14} />{tr('Fetch all {n}', { n: numbers.length })}
                    </button>
                  )}
                  {!archiving && mayArchive && numbers.length > 0 && (
                    <button type="button" onClick={archiveSlowly} disabled={acting} data-archive-slowly className="btn-key h-7 shrink-0 px-2.5 text-[11px]">
                      <IcHourglass width={14} height={14} />{tr('Archive slowly')}
                    </button>
                  )}
                </span>
              </div>
            );
          }
          return (
            <div key="more" className="flex items-center justify-center py-2.5 lg:col-span-full">
              <button type="button" onClick={() => setShowAll(true)} className="chip text-xs">{tr('Show all {n}', { n: r.hidden + GHOST_CAP })}</button>
            </div>
          );
        })}
        {!books && Array.from({ length: 8 }).map((_, i) => <div key={i} className="skeleton my-3 h-6 rounded" />)}
      </div>
      {pages > 1 && <ChapterPager page={shownPage} pages={pages} rows={rows} asc={asc} onPage={(p) => goPage(p, true)} />}
    </div>
  );

  // The library's toolbar, verbatim in shape: fixed ABOVE the bottom nav, safe-area padded, one row that
  // wraps. Every button is disabled when its subset is empty rather than hidden, so the row does not
  // reflow as the selection changes; the two admin buttons and Fetch are hidden outside their audience.
  //
  // ⚠️ `bottom-0` here puts the bar UNDER the phone nav, not over it. This renders inside AppShell's
  // `<main class="relative z-[1]">`, which is its own stacking context, while <BottomNav> is main's sibling
  // at z-40 in the root context -- so whatever z-index this div carries, the nav paints on top of it. With
  // seven chips wrapping to three rows at 390 px, Fetch, Fetch again, Delete from server and Cancel all sat
  // behind the nav and elementFromPoint returned the nav for every one of them. On phones the bar therefore
  // sits at the nav's top edge: 5.75rem plus the safe-area inset (the nav measures 92 px at 390 px; the
  // Sheet's 5.5rem `overBottomNav` value tucks under the bar's own bottom padding and would overlap by 4 px
  // here). From lg up the nav is hidden and the bar goes back to the bottom. Reintroduce by changing the
  // bottom class back to `bottom-0` and picking every row on a phone: only the first row of chips is
  // tappable.
  //
  // v0.52.0 (discussion #72): the bar is up from the moment Select is, saying what it acts on -- chapters. Its Remove
  // was a greyed "Delete from server" until something was ticked, and was read as the way to remove the SERIES (p3t3t3):
  // it reads "Remove 3 chapters" now, and with nothing ticked says how to use it and where the series' own Remove is.
  // UI refresh: keys, as the Library's select bar has been since v0.60.0 -- they act on the picked chapters.
  const Toolbar = selecting && (
    <div ref={toolbarRef} className="fixed inset-x-0 bottom-[calc(5.75rem+env(safe-area-inset-bottom))] z-40 border-t border-ink-700 bg-ink-950/95 px-4 pb-3 pt-3 backdrop-blur-xl lg:bottom-0 lg:start-[var(--rail-w)] lg:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-2">
        <span className="me-auto text-sm font-medium text-fog-100">{acting ? '…' : selectedText(pickedCount)}</span>
        <button disabled={acting || filteredBooks.length + filteredGhosts.length === 0} onClick={selectAllChapters}
          data-select-all-chapters className="btn-key">{allPicked ? tr('Clear selection') : tr('Select all')}</button>
        <button disabled={acting || !pickedCount} onClick={() => bulkMark(true)} className="btn-key">{tr('Mark read')}</button>
        <button disabled={acting || !pickedCount} onClick={() => bulkMark(false)} className="btn-key">{tr('Mark unread')}</button>
        {/* The two icons say which side each acts on: ⬇ this device, ☁ the server. */}
        {!isDesktop() && <button disabled={acting || !saveable.length} onClick={bulkSave} className="btn-key"><IcDownload width={14} height={14} />{tr('Save offline')}</button>}
        {canDownload(user) && <button disabled={acting || !fetchable.length} onClick={bulkFetch} className="btn-key"><IcCloudDownload width={14} height={14} />{tr('Fetch')}</button>}
        {isAdmin && <button disabled={acting || !refetchable.length} onClick={() => setConfirming({ what: 'refetch', books: refetchable })} className="btn-key"><IcCloudDownload width={14} height={14} />{tr('Fetch again')}</button>}
        {/* #240: hidden for everyone, nothing deleted -- beside the server keys, and never the red one, which deletes. */}
        {isAdmin && (
          <button disabled={acting || !hideable.length} onClick={() => setHiding(hideable)} data-hide-chapters className="btn-key">
            {hideable.length === 1 ? tr('Hide 1 chapter') : hideable.length ? tr('Hide {n} chapters', { n: hideable.length }) : tr('Hide chapters')}
          </button>
        )}
        {isAdmin && (
          <button disabled={acting || !deletable.length} onClick={() => setConfirming({ what: 'delete', books: deletable })} data-remove-chapters className="btn-key btn-key-danger text-rose-300">
            {deletable.length === 1 ? tr('Remove 1 chapter') : deletable.length ? tr('Remove {n} chapters', { n: deletable.length }) : tr('Remove chapters')}
          </button>
        )}
        <button disabled={acting} onClick={leaveSelect} className="btn-key text-fog-400">{tr('Cancel')}</button>
      </div>
      {/* Nothing to remove ticked: how to, and the whole series' Remove, which this bar is not. Reintroduce by dropping
          this line: "the bar says how to remove chapters, and where the series' own Remove is" in seriesPage.test.ts. */}
      {isAdmin && !deletable.length && (
        <p className="mx-auto mt-2 flex max-w-3xl flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fog-500" data-remove-hint>
          <span>{tr('Tick chapters to remove them')}</span>
          <button type="button" onClick={() => { leaveSelect(); setDeleting(true); }} className="text-rose-300 underline underline-offset-2">
            {tr('Remove the whole series')}
          </button>
        </p>
      )}
    </div>
  );

  // The banner dims as the page scrolls away from it (UI refresh), and stays still under Reduce effects or reduced
  // motion. Both switches read on every render, in this order (effects.test.ts).
  const plain = useReduceEffects();
  const still = useReducedMotion();
  const reduced = plain || !!still;
  const { scrollY } = useScroll();
  const artDim = useTransform(scrollY, [0, 420], [1, 0.35]);
  // Its art starts at the top of the window: the desktop top bar is see-through over it (lib/overArt.ts).
  useArtUnderChrome();

  // Room under the last rows while the bar is up: on a phone that is the bar (three rows of chips at
  // 390 px) plus the nav it now sits on, so pb-24 left the last two chapters unreachable. SelectBarRoom, at the end.
  return (
    <div className="relative min-h-screen-d">
      {/* sticky back bar on a phone; on a desktop the back key floats over the art, under the top bar (UI refresh) */}
      {/* `top` clears the top bar: the hero's `under-topbar` margin collapses through this page's root, which therefore
          starts under the bar too. */}
      {/* A phone's bar is clear over the cover, and glass with the title once the cover's own title has scrolled under it
          (UI refresh, phone). It was a fade to transparent the whole way down, and the reading button scrolling under it
          showed through, as if the two had collided. */}
      <div data-series-bar={!wide && titleOut ? 'glass' : 'clear'}
        className={`safe-top sticky top-0 z-30 flex items-center gap-2 px-4 pb-3 transition-[background-color,box-shadow] duration-200 lg:absolute lg:start-0 lg:top-[calc(var(--topbar-h)+1rem)] lg:z-20 lg:p-0 ${!wide && titleOut ? 'glass-strong shadow-[0_1px_0_rgb(255_255_255/0.06)]' : ''}`}>
        <button onClick={back} aria-label={tr('Back')} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-ink-800/70 text-fog-100 backdrop-blur lg:border lg:border-white/15 lg:bg-black/40">
          <IcChevronLeft width={22} height={22} className="rtl:-scale-x-100" />
        </button>
        <span aria-hidden={!titleOut} className={`truncate text-sm font-medium text-fog-100 transition-opacity duration-200 lg:hidden ${titleOut ? 'opacity-100' : 'opacity-0'}`}>{title}</span>
      </div>

      {/* banner — real art pulled from the internet (AniList), else the one the server made from the series' own pages
          (v0.51.0), genre-banner fallback. A real banner is shown sharp (v0.53.0: it was blurred like the stand-in
          cover); a series without one keeps the blurred wash of its cover. The gradients below keep the title readable. */}
      {/* UI refresh: the window's whole width from its top edge, under the see-through top bar (lib/overArt.ts), the
          automatic banner as whole strips (components/MosaicArt.tsx), dimming as the page scrolls away from it. */}
      {/* A phone's hero is the cover itself (UI refresh, phone): a 2:3 cover the screen's width is the shape of a phone held
          upright, so it fills the hero edge to edge with real art. The banner is 4.75:1, and a phone showed a slice of its
          middle in a 288-px strip, with the cover and a four-line title squeezed beside it. */}
      <div data-series-hero className="bleed-lg under-topbar relative h-[min(150vw,82svh)] overflow-hidden max-lg:-mt-[58px] lg:h-[min(56vh,34rem)]">
        {series && <motion.div className="absolute inset-0" style={{ opacity: reduced ? 1 : artDim }}>{wide ? <HeroArt series={series} version={series.artVersion} banner className="absolute inset-0" /> : <PhoneHeroCover id={id} version={series.artVersion} still={reduced} />}</motion.div>}
        {/* A phone's art is shown, so a short scrim under the bar and a fade at the foot for the title: the desktop's wash
            darkened all of it. */}
        <div className="absolute inset-x-0 top-0 h-32 bg-linear-to-b from-black/55 to-transparent lg:hidden" />
        <div className="absolute inset-x-0 bottom-0 h-[62%] bg-linear-to-t from-ink-950 via-ink-950/55 to-transparent lg:hidden" />
        <div className="absolute inset-0 hidden bg-linear-to-t from-ink-950 via-ink-950/65 to-ink-950/30 lg:block" />
        <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(85% 95% at 22% 0%, rgb(var(--cover, 124 92 255) / 0.32), transparent 62%)' }} />
        {/* a phone's title, on the cover's foot (UI refresh, phone) */}
        <motion.div initial={reduced ? false : { opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.08, ease: [0.22, 0.61, 0.36, 1] }}
          className="absolute inset-x-0 bottom-0 px-4 pb-3 lg:hidden">
          {meta?.status && (
            <span className="mb-2 inline-block rounded-md bg-white/15 px-2 py-0.5 text-2xs font-semibold uppercase tracking-wide text-white backdrop-blur rtl:tracking-normal">{statusText(meta.status)}</span>
          )}
          {/* The cover above is the hero and carries its own lettering: the styled title, never the logo (HeroTitle). */}
          <HeroTitle series={series ?? { id, name: title, metadata: {} }} title={title} headingRef={heroTitleRef} logo={false} />
          <div className="mt-2">{Meta}</div>
        </motion.div>
        {/* desktop title-over-art (Jellyfin style) — offset to the right of the floating poster */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, delay: 0.08, ease: [0.22, 0.61, 0.36, 1] }}
          className="pointer-events-none absolute inset-x-0 bottom-0 hidden flex-col justify-end p-8 lg:flex lg:ps-[calc(var(--rail-w)+2rem+288px)]">
          {meta?.status && (
            <div className="mb-2 flex items-center gap-2">
              {/* A status, so a squared tag (noPills.test.ts), not the filter chip's capsule. */}
              <span data-series-status className="rounded-md bg-white/10 px-2 py-0.5 text-2xs font-semibold uppercase tracking-wide text-fog-100 backdrop-blur rtl:tracking-normal">{statusText(meta.status)}</span>
            </div>
          )}
          {/* Hidden under 1024 px by CSS, and `logo={wide}` so a phone does not download the logo it never shows. */}
          <HeroTitle series={series ?? { id, name: title, metadata: {} }} title={title} logo={wide} />
          <div className="mt-2">{Meta}</div>
          {/* The block is pointer-events-none over the banner; the chips take their taps back. */}
          {editions && <EditionChips editions={editions} onAdd={addLanguage} className="pointer-events-auto mt-3" />}
        </motion.div>
      </div>

      {/* content */}
      <div className="px-4 lg:grid lg:grid-cols-[260px_1fr] lg:gap-8 lg:px-0">
        {/* cover + actions */}
        <div className="relative z-10 lg:-mt-48 lg:sticky lg:top-[calc(var(--topbar-h)+1rem)] lg:self-start">
          {/* The poster, a desktop's: a phone's hero is the cover itself (UI refresh, phone). */}
          <motion.div initial={{ opacity: 0, y: 18, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.5, ease: [0.22, 0.61, 0.36, 1] }}
            className="hidden overflow-hidden rounded-2xl border border-ink-600 shadow-lift lg:block lg:w-full">
            {series && wide && (isAdmin ? (
              <button type="button" onClick={() => setCoverPicker(true)} aria-label={tr('Change cover')} title={tr('Change cover')} data-cover-button
                className="group relative block h-full w-full focus-visible:outline-2 focus-visible:outline-accent">
                <Img src={img.seriesThumb(id, series.artVersion, 800)} alt="" className="aspect-[2/3] h-full w-full" />
                <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-2 pb-2 pt-6 text-center text-xs font-medium text-white opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">{tr('Change cover')}</span>
              </button>
            ) : <Img src={img.seriesThumb(id, series.artVersion, 800)} alt={series.name} className="aspect-[2/3] h-full w-full" />)}
          </motion.div>
          {/* On a phone the reading button and the four keys come first, right under the art (UI refresh, phone); the
              ratings, the languages and the supply line follow. A desktop's left column is the poster and these. */}
          {Actions}
          {/* The ratings, phone form. The desktop form is the first row of the right column. */}
          {series && <div className="mt-4 lg:hidden"><RatingsPanel anilist={series.yomi?.anilist} rating={rating} onRate={rate} /></div>}
          {/* Full width: beside a cover a 390-px screen left the chips ~210 px. */}
          {editions && <EditionChips editions={editions} onAdd={addLanguage} className="mt-3 lg:hidden" />}
          {/* The supply line, phone form. The desktop form is the first row of the right column (the title block over the
              banner is `pointer-events-none`, so a button cannot live there). */}
          <div className="mt-3 lg:hidden"><SupplyLine parts={supplyPhone} loaded={supplyLoaded} wide={false} onOpen={() => setSourcesOpen(true)} /></div>
        </div>

        {/* info + chapters */}
        <div className="mt-7 flex flex-col gap-4 lg:mt-4">
          {/* The ratings, desktop form: the top of this column, where the sticky one beside it has no room left -- and
              no wider than its two tiles need. */}
          {series && <div className="hidden lg:block"><RatingsPanel anilist={series.yomi?.anilist} rating={rating} onRate={rate} className="max-w-[440px]" /></div>}
          <div className="hidden lg:block"><SupplyLine parts={supplyWide} loaded={supplyLoaded} wide onOpen={() => setSourcesOpen(true)} /></div>
          {Genres}
          {series && <OtherTitles seriesId={id} shown={title} />}
          {Summary}
          {Chapters}
        </div>
      </div>

      {/* The sheets. One at a time (see the state above); each closes itself before anything else opens. */}
      {sourcesOpen && (
        <SourcesSheet id={id} title={title} series={series} groups={groups} admin={adminGroups} error={groupsError} isLoading={groupsLoading} haveNumbers={liveNumbers}
          checkedAt={supplyChecked}
          onSaved={() => { for (const k of [['series', id], ['series-books', id], ['home'], ['library']]) qc.invalidateQueries({ queryKey: k }); }}
          onClose={() => setSourcesOpen(false)}
          onExplain={() => { setSourcesOpen(false); setExplaining(true); }}
          onFindMissing={() => { setSourcesOpen(false); setFindingMissing(true); }}
          // v0.52.0, the Languages section. Each closes the sheet first: a dialog opened under a Sheet cannot be tapped.
          onAddLanguage={addLanguage ? () => { setSourcesOpen(false); setAddingLang({}); } : undefined}
          onAddEdition={addEdition ? (o) => { setSourcesOpen(false); addEdition(o); } : undefined}
          onChangeLanguage={isAdmin ? () => { setSourcesOpen(false); setEditing('reading'); } : undefined}
          onUnlink={isAdmin ? (e) => { setSourcesOpen(false); setUnlinking(e); } : undefined}
          onShowChapter={showChapter} />
      )}
      {explaining && <SourcesExplainer onClose={() => { setExplaining(false); setSourcesOpen(true); }} />}
      {filterOpen && (
        <ChapterFilterSheet groupNames={groupNames} group={group} onGroup={setGroup} hasGhosts={ghosts.length > 0 || deletedGhosts.length > 0}
          showGhosts={showGhosts} onToggleGhosts={toggleGhosts} onClose={() => setFilterOpen(false)} />
      )}
      {chapterSheet && (
        <ChapterVersionsSheet number={chapterSheet.number} ghost={chapterSheet.ghost} book={chapterSheet.book}
          copies={versionsOf.get(chapterSheet.number) ?? []} sourceNames={sourceNames} isAdmin={isAdmin}
          mayFetch={!!chapterSheet.ghost && canDownload(user)}
          // Replacing a file on the server is an admin's call: it changes what everyone reads -- and only a
          // file Uchiyomi downloaded can be replaced (`refetchable` above draws the same line): the server
          // answers `not_owned` for a /library file, so offering the button on one meant a danger dialog
          // followed by "none of those chapters can be fetched again". `!== false`, not `=== true`: `owned`
          // is absent on a server older than the field, and absent is not "no".
          mayReplace={!!chapterSheet.book && isAdmin && chapterSheet.book.owned !== false}
          onFetch={(copy) => {
            const { number: n, ghost } = chapterSheet;
            setChapterSheet(null);
            // A deliberate tombstone may only use the canonical owned copy stored on the book. Ignore
            // alternate copies shown by the versions sheet; the member restore endpoint enforces it too.
            void (ghost?.bookId ? fetchDeleted(ghost.bookId) : copy ? pickGhost(n, copy) : fetchOne(n));
          }}
          // ⚠️ The sheet closes FIRST, then the confirm opens: a Modal under a Sheet cannot be tapped.
          onReplace={(copy) => { const b = chapterSheet.book!; setChapterSheet(null); setReplacing({ book: b, copy }); }}
          // Sheet for sheet, never stacked: the versions sheet closes and the plan opens.
          // Not while a change waits for review (a remap, an undo): the notice above the list offers that plan, and
          // confirming posting order here would overwrite it with a plan built on the wrong numbers. Nor on a series
          // numbered by its chapter titles (#379): its versions are other sources' copies of one chapter.
          onNumbering={isAdmin && listing?.numbering?.mode !== 'posting_order' && listing?.numbering?.mode !== 'titles' && !listing?.numbering?.pending
            ? () => { setChapterSheet(null); setNumberingSheet('posting_order'); } : undefined}
          onClose={() => setChapterSheet(null)} />
      )}
      {numberingSheet && isAdmin && <NumberingSheet seriesId={id} mode={numberingSheet} onClose={() => setNumberingSheet(null)} />}

      {deleting && series && (
        <ConfirmDialog
          title={tr('Remove from library?')}
          danger
          busy={busyAdmin}
          confirmLabel={tr('Remove')}
          confirmText={series.name}
          body={
            <>
              {/* An edition goes on its own: the work's other languages stay, and the Library's card shows them. */}
              {editions && series.lang && (
                <p className="mb-2">{tr('This removes the {language} edition. The other editions stay.', { language: languageName(series.lang) })}</p>
              )}
              <p><strong className="text-fog-100">{tr('No files are deleted.')}</strong>{' '}{tr('The chapters stay exactly where they are on disk, and nothing in your library folder is touched.')}</p>
              <p className="mt-2">{tr('Everyone’s reading progress, history, favourites and ratings are kept, so you can put it back at any time from Admin → Library, or just add it again.')}</p>
            </>
          }
          onConfirm={doDelete}
          onClose={() => setDeleting(false)}
        />
      )}
      {moving && (
        <MoveToLibrary n={1} busy={moveBusy} onClose={() => setMoving(false)} onPick={async (libraryId) => {
          setMoveBusy(true);
          try {
            await api(`/api/admin/series/${encodeURIComponent(id)}/library`, { json: { libraryId } });
            toast(tr('1 series updated'), 'success');
            for (const k of [['series', id], ['series-books', id], ['library'], ['home'], ['collection']]) qc.invalidateQueries({ queryKey: k });
          } catch (e) { toast(msgOf(e, tr('Could not do that')), 'error'); }
          setMoveBusy(false);
          setMoving(false);
        }} />
      )}
      {renaming && series?.folder && (
        <RenameFolderModal
          id={id}
          folder={series.folder}
          title={series.metadata?.title || series.name}
          onClose={() => setRenaming(false)}
          onSaved={() => { for (const k of [['series', id], ['series-books', id], ['library'], ['home']]) qc.invalidateQueries({ queryKey: k }); }}
        />
      )}
      {editing && series && (
        // Keyed by the series: its fields are seeded once, from the series it opened on.
        <SeriesEditor key={id} id={id} series={series} tab={editing} onClose={() => setEditing(null)}
          onSaved={() => { for (const k of [['series', id], ['series-books', id], ['home'], ['library']]) qc.invalidateQueries({ queryKey: k }); }}
          // Its Sources & translations link closes it first: one at a time, as the sheets above.
          onOpenSources={() => { setEditing(null); setSourcesOpen(true); }}
          onNewBanner={newBanner} />
      )}
      {editChapter && (
        <ChapterEditModal book={editChapter} onClose={() => setEditChapter(null)}
          onSaved={() => { for (const k of [['series-books', id], ['series', id], ['home']]) qc.invalidateQueries({ queryKey: k }); }} />
      )}
      {collecting && <CollectionSheet seriesId={id} onClose={() => setCollecting(false)} />}
      {addingLang && series && (
        <AddSeriesDialog seed={{ kind: 'edition', of: id, title, ...addingLang }} sources={[]} mayFollow={isAdmin}
          onClose={() => setAddingLang(null)}
          // The new edition is in the work at once on a "Nothing yet" add, and once its first chapter lands otherwise.
          onAdded={() => { for (const k of [['series', id], ['library'], ['home'], ['source-jobs']]) qc.invalidateQueries({ queryKey: k }); }} />
      )}
      {unlinking && (
        <ConfirmDialog
          title={tr('Unlink the {language} edition?', { language: languageName(unlinking.lang) })}
          busy={busyAdmin}
          confirmLabel={tr('Unlink')}
          body={<p>{tr('It stays in your library as a series of its own, with its chapters and reading progress.')}</p>}
          onConfirm={unlink}
          onClose={() => setUnlinking(null)}
        />
      )}
      {findingMissing && (
        <FindMissingDialog seriesId={id} onClose={() => setFindingMissing(false)}
          onAddEdition={addEdition ? (o) => { setFindingMissing(false); addEdition(o); } : undefined} />
      )}
      {Toolbar}
      {/* After the select bar, which takes the same place and hides this one. */}
      <ContinueBar shown={barShown}>
        <ContinueButton compact label={ctaText.label} disabled={!resumeBook} onOpen={openReader} />
        <FavouriteKey compact on={fav} pops={favPops} onToggle={toggleFav} />
        <MoreKey compact onOpen={openMore} open={moreSheet} menu={false} />
      </ContinueBar>
      {more.element}
      {moreSheet && (
        <SeriesMoreSheet title={title} groups={moreGroups} notesHref={notesHref}
          onPick={(a) => { setMoreSheet(false); runAction(a); }} onClose={() => setMoreSheet(false)} />
      )}
      {confirming?.what === 'delete' && (
        <ConfirmDialog
          title={confirming.books.length === 1 ? tr('Delete 1 chapter from the server?') : tr('Delete {n} chapters from the server?', { n: confirming.books.length })}
          danger
          busy={acting}
          confirmLabel={tr('Delete from server')}
          body={
            <>
              <p>{confirming.books.length === 1
                ? tr('The file is deleted from the server. The chapter stays listed and everyone keeps their reading history, but anyone partway through it loses their place.')
                : tr('The files are deleted from the server. The chapters stay listed and everyone keeps their reading history, but anyone partway through one loses their place.')}</p>
              {/* The two skips the server applies for the same reasons the scheduled cleanup does, said
                  before the click rather than only in the toast after it. */}
              <p className="mt-2">{tr('A chapter somebody has bookmarked, and a chapter in a library you assembled yourself, is skipped.')}</p>
              <p className="mt-2">{tr('Fetch again brings a chapter back.')}</p>
              {(() => {
                const warn = unlistedWarning(confirming.books.length, unlisted?.unlisted.length ?? 0);
                return warn && <p role="alert" className="mt-2 text-amber-300" data-unlisted-warning>{warn}</p>;
              })()}
            </>
          }
          onConfirm={() => deleteBooks(confirming.books)}
          onClose={() => setConfirming(null)}
        />
      )}
      {confirming?.what === 'refetch' && (
        <ConfirmDialog
          title={confirming.books.length === 1 ? tr('Fetch 1 chapter again?') : tr('Fetch {n} chapters again?', { n: confirming.books.length })}
          danger
          busy={acting}
          confirmLabel={tr('Fetch again')}
          body={<p>{tr('Each file is replaced with the copy the translation rules choose now. A different group’s copy may have a different page count, so reading positions inside the chapter may shift.')}</p>}
          onConfirm={() => refetchBooks(confirming.books)}
          onClose={() => setConfirming(null)}
        />
      )}
      {/* #240: a hide asks first -- it changes the series for everyone -- but it is no delete: the plain key, not the red. */}
      {hiding && (
        <ConfirmDialog
          title={hiding.length === 1 ? tr('Hide chapter {n}?', { n: hiding[0] }) : tr('Hide {n} chapters?', { n: hiding.length })}
          busy={acting}
          confirmLabel={hiding.length === 1 ? tr('Hide chapter {n}', { n: hiding[0] }) : tr('Hide {n} chapters', { n: hiding.length })}
          body={
            <>
              <p>{hiding.length === 1
                ? tr('Hidden for everyone: it leaves the chapter list, Continue, the unread counts, Updates and Health, and it is never downloaded again. For a chapter a source lists that is not part of this series.')
                : tr('Hidden for everyone: they leave the chapter list, Continue, the unread counts, Updates and Health, and they are never downloaded again. For chapters a source lists that are not part of this series.')}</p>
              <p className="mt-2">{hiding.length === 1
                ? tr('Nothing is deleted: Show hidden chapters, under More, brings it back as it was.')
                : tr('Nothing is deleted: Show hidden chapters, under More, brings them back as they were.')}</p>
            </>
          }
          onConfirm={() => void hideChapters(hiding)}
          onClose={() => setHiding(null)}
        />
      )}
      {showHidden && <HiddenChaptersDialog seriesId={id} onClose={() => setShowHidden(false)} onChanged={invalidateChapters} />}
      {coverPicker && <CoverPickerSheet seriesId={id} artVersion={series?.artVersion} onClose={() => setCoverPicker(false)} />}
      {talkFor && (() => {
        const b = books?.content.find((x) => x.id === talkFor);
        // A comment's "p. 12" opens the reader at that page.
        return (
          <ChapterTalkSheet bookId={talkFor} seriesId={id} title={b ? (b.metadata?.title || b.name || chapterLabel(b)) : tr('Comments')} subtitle={title}
            onPage={(n) => router.push(`/reader/?book=${talkFor}&page=${n}`)} onClose={() => setTalkFor(null)} overBottomNav />
        );
      })()}
      {comparing && (
        <CompareCopiesDialog seriesId={id} book={comparing} copies={versionsOf.get(comparing.number) ?? []} sourceNames={sourceNames}
          // The compare closes FIRST, then the confirm opens: the same Modal-over-Modal rule as the versions sheet.
          onReplace={(copy) => { const b = comparing; setComparing(null); setReplacing({ book: b, copy }); }}
          onClose={() => setComparing(null)} />
      )}
      {replacing && (
        <ConfirmDialog
          title={tr('Replace with this version?')}
          danger
          busy={acting}
          confirmLabel={tr('Replace')}
          // A tombstone has no file to set aside -- the cleanup already deleted it -- and a sentence that
          // says one is set aside on a row that reads "Deleted from the server" contradicts the row.
          body={<p>{replacing.book.pruned
            ? tr('The chapter was deleted from the server; this copy is downloaded onto the same row and everyone’s progress stays.')
            : tr('The current file is set aside and this copy is downloaded onto the same row. Everyone’s progress stays; the page count may differ.')}</p>}
          onConfirm={replaceWith}
          onClose={() => setReplacing(null)}
        />
      )}

      {/* v0.61.0: what AniList relates this series to -- sequels, prequels, side stories -- just above More like this. */}
      <RelatedRail seriesId={id} />
      {(similar?.content?.length ?? 0) > 0 && (
        <section className="mt-10">
          <SectionTitle>{tr('More like this')}</SectionTitle>
          <ScrollRail label={tr('More like this')} className={CARD_RAIL}>{similar!.content.map((s) => <SeriesCard key={s.id} series={s} />)}</ScrollRail>
        </section>
      )}
      {/* Room under the last rows for the phone's bar (ContinueBar), which can be up whenever the button has scrolled
          away; the select bar's own room takes over while Select is on. */}
      {!Toolbar && <div aria-hidden className="h-16 lg:hidden" />}
      {Toolbar && <SelectBarRoom />}
    </div>
  );
}

/**
 * Room under the last rows while the select bar is up, as tall as the bar is now: lib/layers.ts measures it for the
 * notices, and the room follows the same number. A fixed pb-40 fitted three rows of chips; v0.52.0's hint under the
 * bar adds a line with nothing ticked -- two in German, whose chips already wrap to four rows at 390 px -- and left
 * the last chapter half under the bar just as it is reached for. The fixed room stays until the bar is measured.
 * Its own component, so a bar that re-wraps re-renders this and not the page.
 */
function SelectBarRoom() {
  const { toolbarHeight } = useLayers();
  return toolbarHeight
    ? <div aria-hidden style={{ height: `calc(${toolbarHeight}px + env(safe-area-inset-bottom) + 1rem)` }} />
    : <div aria-hidden className="h-40 lg:h-24" />;
}

export default function SeriesPage() {
  return (
    <Suspense fallback={<div className="min-h-screen-d" />}>
      <SeriesInner />
    </Suspense>
  );
}
