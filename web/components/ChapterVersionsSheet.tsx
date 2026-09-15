'use client';
// One chapter number, every copy of it: the sheet a ghost row opens on tap and a chapter row opens from
// ⋯ → Versions. It replaces the `{n} versions` pill and the list that unfolded under the row (VersionStrip),
// which put three bordered lines of source names and state chips inside the chapter list itself.
//
// One row per copy, the markers that tell them apart, and one action: Fetch on a copy the server lacks (for
// anyone who may download -- a blocked copy included, since a pick names the copy and the server takes it
// as an explicit choice), or Replace… on a copy of a chapter already here (admins, and only a file Uchiyomi
// downloaded). ⚠️ Replace… CLOSES THIS SHEET before the confirm opens: the confirm is a Modal at z-50 and
// this is a Sheet at z-60 in the same stacking context, so a confirm opened over it paints underneath the
// backdrop and cannot be tapped. The page's `onReplace` does the closing; the sheet only asks.
import type { Book, Ghost, VersionCopy } from '@/lib/types';
import { Sheet } from '@/components/ui';
import { GroupAvatar } from '@/components/GroupAvatar';
import { SourceIcon } from '@/components/SourcePicker';
import { IcCloudDownload } from '@/components/icons';
import { chapterLabel, relativeTime } from '@/lib/format';
import { t as tr } from '@/lib/i18n';

/**
 * A pre-v0.33 listing row carries no `copies`; the sheet still has the ghost's or the book's own fields to
 * show as the one copy it knows. `key: ''` marks it: there is no per-source chapter id to pick, so Fetch on
 * it goes by number (`onFetch(undefined)`), and a book's own row is the on-disk copy, which Replace… skips.
 */
function ownCopy(ghost?: Ghost, book?: Book, sourceName?: string): VersionCopy {
  if (ghost) {
    return { key: '', source: ghost.sourceId, sourceName: ghost.sourceName, groups: ghost.groups, scanlator: ghost.scanlator, lang: null,
             pages: null, publishedAt: ghost.publishedAt, chosen: false, blocked: ghost.why === 'blocked', onDisk: false };
  }
  return { key: '', source: book?.sourceId ?? '', sourceName: sourceName ?? '', groups: [], scanlator: book?.scanlator ?? null, lang: null,
           pages: book?.media.pagesCount ?? null, publishedAt: book?.metadata?.releaseDate ?? null, chosen: false, blocked: false, onDisk: true };
}

export function ChapterVersionsSheet({ number, ghost, book, copies, sourceNames, isAdmin, mayFetch, mayReplace, onFetch, onReplace, onClose }: {
  number: number;
  ghost?: Ghost;
  book?: Book;
  /** Every copy the versions route knows for this number; empty on an older listing. */
  copies: VersionCopy[];
  /** Source id -> display name, for a book's own row (a book carries only the id). */
  sourceNames: Record<string, string>;
  isAdmin: boolean;
  /** A ghost row for a viewer who may download: every copy gets Fetch. */
  mayFetch: boolean;
  /** A chapter row for an admin, on a file Uchiyomi downloaded: every other copy gets Replace…. */
  mayReplace: boolean;
  /** `copy` names the pick; undefined is "this number, whatever the rules choose" (the synthesized row). */
  onFetch: (copy?: VersionCopy) => void;
  onReplace: (copy: VersionCopy) => void;
  onClose: () => void;
}) {
  const label = chapterLabel(book ?? { number });
  // Most sources title a chapter "Chapter 12", which under "Ch. 12" says nothing twice.
  const title = (book ? book.metadata?.title || book.name : ghost?.title)?.trim() || '';
  const showTitle = !!title && !/^(ch(apter)?\.?\s*)?[\d.]+$/i.test(title);
  const rows = copies.length ? copies : [ownCopy(ghost, book, book?.sourceId ? sourceNames[book.sourceId] : undefined)];
  return (
    <Sheet title={label} onClose={onClose} overBottomNav>
      {showTitle && <p className="-mt-2 mb-3 text-sm text-fog-400">{title}</p>}
      {/* The downloader's last error, for admins: it used to ride on the pill's hover title, which no phone
          can reach. The server sends `reason` to nobody else. */}
      {isAdmin && ghost?.why === 'failed' && ghost.reason && (
        <p className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-[11px] leading-relaxed text-amber-200">
          {tr('Last error: {reason}', { reason: ghost.reason })}
        </p>
      )}
      <div className="divide-y divide-ink-800/70">
        {rows.map((c, i) => {
          const who = c.groups.join(' & ') || c.scanlator || '';
          const own = c.key === '';
          return (
            // One copy per line; at 390 px the facts wrap under the name rather than compete with it.
            <div key={c.key || `own${i}`} className="flex items-center gap-2.5 py-2.5 text-xs">
              <GroupAvatar name={who || '?'} size={18} />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  <span className="truncate text-sm text-fog-100">{who || '—'}</span>
                  {c.lang && <span className="rounded border border-ink-700 px-1 text-[10px] uppercase leading-4 text-fog-500">{c.lang}</span>}
                  {c.onDisk && <span className="rounded-full border border-ink-700 px-1.5 text-[10px] leading-4 text-fog-300">{tr('on server')}</span>}
                  {c.chosen && <span className="rounded-full border border-accent/40 px-1.5 text-[10px] leading-4 text-accent">{tr("server's pick")}</span>}
                  {c.blocked && <span className="rounded-full border border-rose-500/40 px-1.5 text-[10px] leading-4 text-rose-300">{tr('blocked group')}</span>}
                </span>
                <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-fog-500">
                  {c.pages != null && <span>{tr('{n} pages', { n: c.pages })}</span>}
                  {c.publishedAt && <span>{relativeTime(c.publishedAt)}</span>}
                  {c.source && (
                    <span className="inline-flex min-w-0 items-center gap-1">
                      <SourceIcon id={c.source} name={c.sourceName || c.source} size={16} />
                      <span className="truncate">{c.sourceName || c.source}</span>
                    </span>
                  )}
                </span>
              </span>
              {mayFetch && !c.onDisk && (
                <button type="button" onClick={() => onFetch(own ? undefined : c)}
                  className="chip shrink-0 px-2.5 py-1 text-[11px]">
                  <IcCloudDownload width={14} height={14} />{tr('Fetch')}
                </button>
              )}
              {mayReplace && !own && (
                <button type="button" onClick={() => onReplace(c)} disabled={c.onDisk}
                  className="chip shrink-0 px-2.5 py-1 text-[11px] disabled:opacity-40">{tr('Replace…')}</button>
              )}
            </div>
          );
        })}
      </div>
    </Sheet>
  );
}
