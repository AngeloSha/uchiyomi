'use client';
// A blocked group's chapters still on the shelf (#396, bff lib/blockedPurge.ts), and the question whether to remove
// them completely. Blocking a group is saved at once and only hides; this is the confirmed second step, asked wherever
// a block is made -- under "Translated by" in a series' Sources & translations sheet (`seriesId`), and in the
// Scanlation groups editor for every series (none). Asked inline, never in a dialog: both live in a Sheet, and a Modal
// opened under a Sheet cannot be tapped. The sheet also asks at once, under the group's row, when a Block there is
// what leaves chapters to blocked groups alone (SourcesSheet.tsx); the standing question under the rows stays, for
// an admin who decides later. Every question names the chapter numbers it would remove.
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { normGroup } from '@/lib/scanlators';
import { groupsOfRow } from '@/lib/groupFilter';
import { useToast } from '@/components/Toast';
import { msgOf } from '@/components/ConfirmDialog';

export interface BlockedBook { id: string; seriesId: string; seriesTitle: string; number: number; scanlator: string | null; pruned: boolean }

export interface BlockedChapters {
  chapters: number;
  series: number;
  readers: number;
  books: BlockedBook[];
}

/** The query key: one series, or '*' for every series. A block saved anywhere invalidates ['blocked-chapters']. */
export const blockedChaptersKey = (seriesId?: string) => ['blocked-chapters', seriesId ?? '*'];

/** The question's sentence, by how many chapters, series and readers it is about. */
export function blockedChaptersText(d: Pick<BlockedChapters, 'chapters' | 'series' | 'readers'>, everySeries: boolean): string {
  const parts = [
    d.chapters === 1 ? tr('1 downloaded chapter is only from blocked groups.') : tr('{n} downloaded chapters are only from blocked groups.', { n: d.chapters }),
    ...(everySeries && d.series > 1 ? [tr('They are in {n} different series.', { n: d.series })] : []),
    tr('Remove them completely, as if they had never been downloaded?'),
    ...(d.readers === 1 ? [tr('Reading history on them goes too, for 1 reader.')]
      : d.readers > 1 ? [tr('Reading history on them goes too, for {n} readers.', { n: d.readers })] : []),
  ];
  return parts.join(' ');
}

/**
 * The numbers a removal takes, short: "Ch. 340, 341", by series when it is about every series ("Title: Ch. 12 · Other:
 * Ch. 3"), at most `cap` numbers and "+{n} more" for the rest. Two files of one number are one number.
 */
export function blockedNumbersText(books: ReadonlyArray<Pick<BlockedBook, 'seriesId' | 'seriesTitle' | 'number'>>, everySeries: boolean, cap = 12): string {
  const bySeries = new Map<string, { title: string; numbers: number[] }>();
  for (const b of books) {
    const s = bySeries.get(b.seriesId) ?? { title: b.seriesTitle, numbers: [] };
    if (!s.numbers.includes(b.number)) s.numbers.push(b.number);
    bySeries.set(b.seriesId, s);
  }
  let room = cap;
  let rest = 0;
  const parts: string[] = [];
  for (const s of bySeries.values()) {
    const numbers = [...s.numbers].sort((a, b) => a - b);
    const shown = numbers.slice(0, Math.max(0, room));
    rest += numbers.length - shown.length;
    room -= shown.length;
    if (!shown.length) continue;
    const list = tr('Ch. {n}', { n: shown.join(', ') });
    parts.push(everySeries ? `\u2068${s.title}\u2069: ${list}` : list);
  }
  const text = parts.join(' · ');
  return rest > 0 ? `${text} ${tr('+{n} more', { n: rest })}` : text;
}

/**
 * The groups behind picked chapters, for Block & remove: each file's own stamp first, then every group that lists the
 * same number on a followed source -- a wrong number copied across groups goes only once each is blocked. Deduped by
 * the server's group equality, in that order.
 */
export function chapterGroups(
  books: ReadonlyArray<{ number: number; scanlator?: string | null }>,
  copiesOf: (n: number) => ReadonlyArray<{ groups?: string[]; scanlator?: string | null }>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (names: string[]) => {
    for (const name of names) {
      const k = normGroup(name);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(name);
    }
  };
  for (const b of books) push(groupsOfRow({ scanlator: b.scanlator }));
  for (const b of books) for (const c of copiesOf(b.number)) push(groupsOfRow(c));
  return out;
}

/** After a removal or a block: everything that lists, counts or shows those chapters. */
export function refreshAfterRemoval(qc: QueryClient) {
  for (const k of ['blocked-chapters', 'series-books', 'series-listing', 'series-versions', 'series-groups', 'series-scanlators', 'series', 'library', 'home']) {
    void qc.invalidateQueries({ queryKey: [k] });
  }
}

/** The toast a removal answers with; true when it all went. */
export function sayRemoved(toast: ReturnType<typeof useToast>, r: { removed: number; left: unknown[]; busy: string[] }): boolean {
  toast(r.removed === 1 ? tr('Removed 1 chapter') : tr('Removed {n} chapters', { n: r.removed }), 'success');
  const all = !r.left.length && !r.busy.length;
  if (!all) toast(tr('Some chapters could not be removed now. Try again in a moment.'), 'error');
  return all;
}

/**
 * The question itself, for `data` as it was counted: what goes (the sentence and the numbers), Remove completely and
 * Keep. Remove sends exactly the ids shown; the server removes only those still a blocked group's alone.
 */
export function BlockedChaptersPrompt({ data, everySeries, onKeep, onRemoved, hook, focus }: {
  data: BlockedChapters;
  everySeries: boolean;
  onKeep: () => void;
  onRemoved?: () => void;
  /** A data- attribute of its own, so the at-once question and the standing one can be told apart. */
  hook?: string;
  /** Brought into view and focused when it appears: the question a tap just raised, wherever its row has moved to. */
  focus?: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focus) return;
    ref.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [focus]);
  const remove = async () => {
    setBusy(true);
    try {
      const r = await api<{ removed: number; left: unknown[]; busy: string[] }>('/api/admin/blocked-chapters/purge', {
        method: 'POST', json: { bookIds: data.books.map((b) => b.id) },
      });
      sayRemoved(toast, r);
      refreshAfterRemoval(qc);
      onRemoved?.();
    } catch (e) { toast(msgOf(e, tr('Could not remove the chapters')), 'error'); }
    finally { setBusy(false); }
  };
  return (
    <div ref={ref} role="alertdialog" aria-label={tr('Remove blocked chapters')} data-blocked-chapters-ask={hook ?? ''}
      className="mt-2 border-s-2 border-rose-400/70 bg-ink-850/80 py-2 pe-2 ps-2.5">
      <p className="text-[12px] leading-relaxed text-fog-100">{blockedChaptersText(data, everySeries)}</p>
      <p className="mt-1 text-[12px] leading-relaxed text-rose-200" data-blocked-chapters-numbers>{blockedNumbersText(data.books, everySeries)}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={() => void remove()} disabled={busy} className="btn-key btn-key-danger" data-blocked-chapters-remove>
          {busy ? tr('Working…') : tr('Remove completely')}
        </button>
        <button type="button" onClick={onKeep} disabled={busy} className="btn-key" data-blocked-chapters-keep>{tr('Keep')}</button>
      </div>
    </div>
  );
}

/** The standing question: every chapter blocked groups alone hold, in one series or (no `seriesId`) all of them. */
export function BlockedChaptersAsk({ seriesId }: { seriesId?: string }) {
  const { data } = useQuery({
    queryKey: blockedChaptersKey(seriesId),
    queryFn: () => api<BlockedChapters>(`/api/admin/blocked-chapters${seriesId ? `?seriesId=${encodeURIComponent(seriesId)}` : ''}`),
    retry: false,
  });
  // Keep answers for exactly the chapters asked about: a chapter blocked later asks again.
  const [kept, setKept] = useState<string | null>(null);
  if (!data?.chapters) return null;
  const asked = data.books.map((b) => b.id).join(',');
  if (kept === asked) return null;
  return <BlockedChaptersPrompt data={data} everySeries={!seriesId} onKeep={() => setKept(asked)} />;
}
