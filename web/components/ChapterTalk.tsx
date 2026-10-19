'use client';
// Chapter comments and reactions (v0.87.0): what the household says about a chapter, and how it took it.
//
// The reader runs chapters on into each other, so the talk is not under a chapter: it is where a chapter ENDS. In the
// webtoon column the line between two chapters becomes ChapterSeam -- who reacted, how many comments, and the six
// reactions a tap away -- and on a paged track TalkKey sits on a chapter's last page. The reader's top bar opens the
// sheet for the chapter on screen, and the series page's rows say which chapters have talk. All of them open one sheet,
// ChapterTalkSheet. The rules are the server's (bff lib/comments.ts); lib/comments.ts has the words and counts.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { relativeTime } from '@/lib/format';
import { t as tr } from '@/lib/i18n';
import {
  COMMENT_MAX, commentsLine, myReaction, pageRef, reactedLine, reactionCounts, seriesTalkKey, talkKey, useChapterTalk,
  SEAM_H, type ChapterTalk, type Reaction, type TalkComment, type TalkReaction,
} from '@/lib/comments';
import { Avatar } from '@/components/Avatar';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useContextMenu } from '@/components/ContextMenu';
import { useIncognito } from '@/components/IncognitoBanner';
import { useToast } from '@/components/Toast';
import { Sheet } from '@/components/ui';
import { IcChevronRight, IcComment, IcEyeOff } from '@/components/icons';

/**
 * Over the reader's pages, a control must not also be a tap on the page: the scroll container seeds its tap (the bars)
 * on pointerdown and reads it on pointerup, and zooms on a double click. Stopping all three keeps a press on a key a press
 * on the key, as the repeated-page strip does (components/ReaderPage.tsx).
 */
const stopTap = {
  onPointerDown: (e: { stopPropagation: () => void }) => e.stopPropagation(),
  onPointerUp: (e: { stopPropagation: () => void }) => e.stopPropagation(),
  onDoubleClick: (e: { stopPropagation: () => void }) => e.stopPropagation(),
};

/** What a refused post or reaction says: Incognito's reason when it is that, else the app's usual words. */
function refusal(e: unknown): string {
  if (e instanceof ApiError && e.status === 403 && /incognito/.test(e.body)) {
    return tr('Incognito reading is on, so you can read comments but not post or react.');
  }
  return tr('Could not save');
}

/** The chapter's talk as the cache holds it, changed in place: what a reaction or a comment does before the server answers. */
function useTalkCache(bookId: string, seriesId?: string | null) {
  const qc = useQueryClient();
  const key = talkKey(bookId);
  return {
    get: () => qc.getQueryData<ChapterTalk>(key),
    set: (f: (t: ChapterTalk) => ChapterTalk) => qc.setQueryData<ChapterTalk>(key, (t) => (t ? f(t) : t)),
    put: (t: ChapterTalk | undefined) => qc.setQueryData<ChapterTalk>(key, t),
    /** The series page's counts are read again after any change. */
    settle: () => {
      void qc.invalidateQueries({ queryKey: key });
      if (seriesId) void qc.invalidateQueries({ queryKey: seriesTalkKey(seriesId) });
    },
  };
}

/** Me, as a reaction or a comment shows a person, from what the shell knows of the account. */
function useMe() {
  const { user } = useAuth();
  return { id: user?.id ?? '', name: user?.displayName || user?.username || '', avatar: user?.avatar ?? {}, admin: user?.role === 'admin' };
}

/**
 * The six reactions as squared keys, each with its count, yours in the accent. A tap reacts, a tap on yours takes it
 * back, a tap on another changes it -- at once on screen, put back if the server refuses. Read-only under Incognito.
 */
export function ReactionKeys({ bookId, seriesId, talk, size = 'md' }: {
  bookId: string;
  seriesId?: string | null;
  talk: ChapterTalk | undefined;
  size?: 'sm' | 'md';
}) {
  const cache = useTalkCache(bookId, seriesId);
  const toast = useToast();
  const me = useMe();
  const { on: incognito } = useIncognito();
  const counts = reactionCounts(talk?.reactions ?? []);
  const mine = myReaction(talk?.reactions ?? []);
  const tap = async (emoji: Reaction) => {
    if (!talk) return;
    const before = cache.get();
    const taking = mine === emoji;
    cache.set((t) => ({
      ...t,
      reactions: [
        ...t.reactions.filter((r) => !r.mine),
        ...(taking ? [] : [{ user: { id: me.id, name: me.name, avatar: me.avatar }, emoji, mine: true } satisfies TalkReaction]),
      ],
    }));
    try {
      if (taking) await api(`/api/books/${bookId}/reaction`, { method: 'DELETE' });
      else await api(`/api/books/${bookId}/reaction`, { method: 'PUT', json: { emoji } });
    } catch (e) {
      cache.put(before);
      toast(refusal(e), 'error');
    }
    cache.settle();
  };
  const h = size === 'sm' ? 'h-8' : 'h-9';
  return (
    <div role="group" aria-label={tr('Reactions')} className="flex flex-wrap items-center justify-center gap-1.5" data-reactions>
      {counts.map(({ emoji, n, mine: own }) => (
        <button key={emoji} type="button" {...stopTap} onClick={() => void tap(emoji)} disabled={!talk || incognito}
          aria-pressed={own}
          title={incognito ? tr('Incognito reading is on, so you can read comments but not post or react.') : undefined}
          aria-label={n ? `${emoji} ${n}` : emoji}
          data-reaction={emoji}
          className={`btn-key ${h} min-w-10 gap-1 px-2 ${own ? 'btn-key-accent' : ''}`}>
          <span aria-hidden className="text-[15px] leading-none">{emoji}</span>
          {n > 0 && <span aria-hidden className="text-[11px] tabular-nums">{n}</span>}
        </button>
      ))}
    </div>
  );
}

/** The faces of who reacted, each with their emoji at its foot -- at most `max`, then "+n". 22 px each, a circle. */
export function TalkFaces({ reactions, max = 4 }: { reactions: readonly TalkReaction[]; max?: number }) {
  if (!reactions.length) return null;
  const shown = [...reactions].sort((a, b) => Number(b.mine) - Number(a.mine)).slice(0, max);
  const more = reactions.length - shown.length;
  return (
    <span aria-hidden className="flex shrink-0 items-center" data-faces>
      {shown.map((r, i) => (
        <span key={r.user.id} className={`relative size-[22px] rounded-full ${i ? 'ms-1.5' : ''}`}>
          <Avatar avatar={r.user.avatar} size={22} />
          <span className="absolute -bottom-1 -end-1.5 text-[10px] leading-none drop-shadow-[0_0_1px_rgba(0,0,0,0.9)]">{r.emoji}</span>
        </span>
      ))}
      {more > 0 && <span className="ms-2 text-[11px] tabular-nums text-fog-500">+{more}</span>}
    </span>
  );
}

/** "Mostafa and Noura reacted · 3 comments", or the invitation when there is no talk yet. */
function talkSummary(talk: ChapterTalk | undefined): string {
  const parts = [reactedLine(talk?.reactions ?? []), commentsLine(talk?.comments.length ?? 0)].filter(Boolean);
  return parts.length ? parts.join(' · ') : tr('Comment');
}

/**
 * A chapter's talk at its end: who reacted and how much was said (opens the sheet), then the six reactions. Two rows of
 * a known height (h-7 and h-8), whatever they hold, so the strip around them can be fixed. `active`: worth asking for.
 */
export function TalkStrip({ bookId, seriesId, active = true, onOpen }: {
  bookId: string;
  seriesId?: string | null;
  active?: boolean;
  onOpen: (bookId: string) => void;
}) {
  const { data: talk } = useChapterTalk(bookId, active);
  return (
    <>
      <button type="button" {...stopTap} onClick={() => onOpen(bookId)} data-seam-open
        className="flex h-7 max-w-full items-center gap-2 rounded-md px-1.5 text-xs text-fog-300 transition hover:text-fog-50">
        {talk?.reactions.length ? <TalkFaces reactions={talk.reactions} /> : <IcComment width={15} height={15} className="shrink-0" />}
        <span className="truncate">{talkSummary(talk)}</span>
        <IcChevronRight width={14} height={14} className="shrink-0 text-fog-500 rtl:-scale-x-100" />
      </button>
      {talk ? <ReactionKeys bookId={bookId} seriesId={seriesId} talk={talk} size="sm" /> : <div className="h-8" />}
    </>
  );
}

/**
 * The strip where two chapters meet in the webtoon column, while talk is on: the chapter that ended, who reacted and how
 * much was said (opens the sheet), the six reactions, then the next chapter's line as it always read. Exactly SEAM_H
 * tall whatever it holds -- the reader reserves that much (lib/comments.ts SEAM_H). `active`: near the screen, so worth
 * asking for; until then, and offline, it holds its labels and its place.
 */
export function ChapterSeam({ bookId, seriesId, label, next, active, onOpen }: {
  bookId: string;
  seriesId?: string | null;
  /** The ended chapter's name. */
  label: string;
  /** The next chapter's name, the line the divider always had. */
  next: string;
  active: boolean;
  onOpen: (bookId: string) => void;
}) {
  return (
    <div style={{ height: SEAM_H }} data-seam={bookId} className="flex flex-col items-center justify-center gap-2.5 px-3">
      <div className="flex max-w-full items-center gap-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-fog-600">
        <span className="h-px w-8 shrink-0 bg-ink-700" />
        <span className="truncate">{label}</span>
        <span className="h-px w-8 shrink-0 bg-ink-700" />
      </div>
      <TalkStrip bookId={bookId} seriesId={seriesId} active={active} onOpen={onOpen} />
      <div className="flex max-w-full items-center justify-center gap-3 text-xs text-fog-500">
        <span className="h-px w-8 shrink-0 bg-ink-700" />
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.16em] text-fog-600">{tr('Up Next')}</span>
        <span className="truncate text-fog-400">{next}</span>
        <span className="h-px w-8 shrink-0 bg-ink-700" />
      </div>
    </div>
  );
}

/**
 * On a paged track, the chapter's talk on its last page: a squared key at the foot of the page, the #232 focus label's
 * place, saying what is there ("😂 2 · 💬 3") or inviting it. Opens the sheet.
 */
export function TalkKey({ bookId, onOpen }: { bookId: string; onOpen: (bookId: string) => void }) {
  const { data: talk } = useChapterTalk(bookId);
  const counts = reactionCounts(talk?.reactions ?? []).filter((c) => c.n > 0).sort((a, b) => b.n - a.n).slice(0, 2);
  const comments = talk?.comments.length ?? 0;
  return (
    <button type="button" {...stopTap} onClick={() => onOpen(bookId)} data-talk-key
      className="pointer-events-auto flex items-center gap-2 rounded-md border border-white/15 bg-black/70 px-3 py-1.5 text-xs text-white backdrop-blur">
      {counts.map((c) => <span key={c.emoji} className="tabular-nums">{c.emoji} {c.n}</span>)}
      {comments > 0 && <span className="flex items-center gap-1 tabular-nums"><IcComment width={14} height={14} aria-hidden />{comments}</span>}
      {!counts.length && !comments && <><IcComment width={14} height={14} aria-hidden /><span>{tr('React or comment')}</span></>}
      <span className="sr-only">{talkSummary(talk)}</span>
    </button>
  );
}

/** The scrolling box a node sits in: where the sheet's newest comment is brought into view. */
function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if (o === 'auto' || o === 'scroll') return n;
  }
  return null;
}

/** One comment: who, when, edited, the page it was written on, the words, and its ⋯ for its author or an admin. */
function CommentRow({ c, admin, onPage, onEdit, onDelete }: {
  c: TalkComment;
  admin: boolean;
  onPage?: (n: number) => void;
  onEdit: (c: TalkComment, body: string) => Promise<boolean>;
  onDelete: (c: TalkComment) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const menu = useContextMenu(() => [
    ...(c.mine ? [{ label: tr('Edit'), onSelect: () => setEditing(c.body) }] : []),
    ...(c.mine ? [{ label: tr('Delete'), danger: true, onSelect: () => onDelete(c) }] : []),
    ...(!c.mine && admin ? [{ label: tr('Remove'), danger: true, onSelect: () => onDelete(c) }] : []),
  ], { label: tr('Comment actions') });
  const save = async () => {
    if (editing == null || busy) return;
    setBusy(true);
    if (await onEdit(c, editing)) setEditing(null);
    setBusy(false);
  };
  return (
    <li className="flex gap-3 py-3" data-comment={c.id}>
      <Avatar avatar={c.user.avatar} size={30} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
          <bdi className="font-medium text-fog-100">{c.user.name}</bdi>
          <span className="text-fog-500">{relativeTime(c.createdAt)}</span>
          {c.editedAt && <span className="text-fog-600">{tr('edited')}</span>}
          {c.page != null && (onPage
            ? <button type="button" onClick={() => onPage(c.page!)} className="rounded-[4px] border border-ink-700 px-1 text-[10px] leading-4 text-fog-400 hover:border-accent/60 hover:text-accent" data-comment-page>{pageRef(c.page)}</button>
            : <span className="rounded-[4px] border border-ink-700 px-1 text-[10px] leading-4 text-fog-500">{pageRef(c.page)}</span>)}
        </p>
        {editing == null ? (
          <p dir="auto" className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-fog-200">{c.body}</p>
        ) : (
          <div className="mt-1.5">
            <textarea value={editing} onChange={(e) => setEditing(e.target.value)} dir="auto" rows={3} aria-label={tr('Edit')}
              className="w-full resize-none rounded-lg border border-ink-600 bg-ink-900/80 px-3 py-2 text-sm text-fog-100 outline-none focus:border-accent/60" />
            <div className="mt-1.5 flex justify-end gap-2">
              <button type="button" onClick={() => setEditing(null)} className="btn-key">{tr('Cancel')}</button>
              <button type="button" onClick={() => void save()} disabled={busy || !editing.trim() || [...editing.trim()].length > COMMENT_MAX}
                className="btn-key btn-key-primary">{tr('Save')}</button>
            </div>
          </div>
        )}
      </div>
      {(c.mine || admin) && editing == null && (
        <button type="button" onClick={(e) => menu.openFrom(e.currentTarget)} aria-label={tr('Comment actions')} aria-haspopup="menu" aria-expanded={menu.open}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-fog-500 hover:text-fog-200">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
        </button>
      )}
      {menu.element}
    </li>
  );
}

/**
 * A chapter's talk in a sheet: its reactions, its comments oldest first (the newest brought into view), and a box to
 * add one. The same sheet from the reader -- where a comment carries the page it was written on, and its "p. 12" jumps
 * there -- and from the series page, where it opens the reader at that page.
 */
export function ChapterTalkSheet({ bookId, seriesId, title, subtitle, page, onPage, onClose, overBottomNav }: {
  bookId: string;
  /** Opened from a page with the bottom nav (the series page): the box to write in sits clear of it. */
  overBottomNav?: boolean;
  seriesId?: string | null;
  title: string;
  subtitle?: ReactNode;
  /** In the reader: the page being read, kept with a new comment. */
  page?: number | null;
  /** Go to a comment's page: in the reader, there; elsewhere, the reader at it. */
  onPage?: (n: number) => void;
  onClose: () => void;
}) {
  const { data: talk, isError, refetch } = useChapterTalk(bookId);
  const cache = useTalkCache(bookId, seriesId);
  const toast = useToast();
  const me = useMe();
  const { on: incognito } = useIncognito();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [doomed, setDoomed] = useState<TalkComment | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const seen = useRef(0);
  const box = useRef<HTMLTextAreaElement>(null);

  // The newest comment in view: when the talk first arrives, and after each one added.
  const count = talk?.comments.length ?? 0;
  useEffect(() => {
    if (!talk || count <= seen.current && seen.current > 0) { seen.current = count; return; }
    seen.current = count;
    const s = scrollerOf(end.current);
    if (s) s.scrollTop = s.scrollHeight;
  }, [talk, count]);

  // The box grows with what is typed, to about four lines.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 112)}px`;
  }, [text]);

  const left = COMMENT_MAX - [...text.trim()].length;
  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body || left < 0 || sending) return;
    setSending(true);
    try {
      const made = await api<TalkComment>(`/api/books/${bookId}/comments`, { method: 'POST', json: { body, ...(page ? { page } : {}) } });
      cache.set((t) => ({ ...t, comments: [...t.comments, made] }));
      setText('');
    } catch (err) {
      toast(refusal(err), 'error');
    }
    setSending(false);
    cache.settle();
  };
  const edit = async (c: TalkComment, body: string): Promise<boolean> => {
    try {
      const r = await api<{ body: string; editedAt: string }>(`/api/comments/${c.id}`, { method: 'PATCH', json: { body: body.trim() } });
      cache.set((t) => ({ ...t, comments: t.comments.map((x) => (x.id === c.id ? { ...x, body: r.body, editedAt: r.editedAt } : x)) }));
      return true;
    } catch (err) {
      toast(refusal(err), 'error');
      return false;
    }
  };
  const remove = async (c: TalkComment) => {
    setDoomed(null);
    const before = cache.get();
    cache.set((t) => ({ ...t, comments: t.comments.filter((x) => x.id !== c.id) }));
    try { await api(`/api/comments/${c.id}`, { method: 'DELETE' }); } catch { cache.put(before); toast(tr('Could not save'), 'error'); }
    cache.settle();
  };

  // ⚠️ The redesigned bottom nav floats a little higher than the sheet's own `overBottomNav` room (components/ui.tsx), so
  // over it the box to write in keeps a little more, below `sm` where the nav is.
  const footerRoom = overBottomNav ? 'mb-3 sm:mb-0' : '';
  const footer = incognito ? (
    <p className={`flex items-center gap-2 pb-1 text-[12px] text-fog-400 ${footerRoom}`} data-talk-incognito>
      <IcEyeOff width={14} height={14} aria-hidden className="shrink-0" />
      {tr('Incognito reading is on, so you can read comments but not post or react.')}
    </p>
  ) : (
    <form onSubmit={(e) => void send(e)} className={`flex items-end gap-2 ${footerRoom}`} data-talk-form>
      <div className="min-w-0 flex-1">
        <textarea ref={box} value={text} onChange={(e) => setText(e.target.value)} rows={1} dir="auto"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send(); }}
          placeholder={tr('Say something about this chapter…')} aria-label={tr('Your comment')} disabled={!talk}
          className="block w-full resize-none rounded-lg border border-ink-600 bg-ink-900/80 px-3 py-2 text-sm text-fog-100 outline-none placeholder:text-fog-600 focus:border-accent/60" />
        {left < 200 && <p className={`mt-1 text-[11px] tabular-nums ${left < 0 ? 'text-rose-300' : 'text-fog-500'}`}>{tr('{n} left', { n: left })}</p>}
      </div>
      <button type="submit" disabled={!talk || sending || !text.trim() || left < 0} className="btn-key btn-key-primary h-9">{tr('Post')}</button>
    </form>
  );

  return (
    <>
      <Sheet title={title} subtitle={subtitle} onClose={onClose} footer={footer} overBottomNav={overBottomNav}>
        {isError && !talk ? (
          <div className="py-8 text-center text-sm text-fog-400">
            <p>{tr('Comments need a connection.')}</p>
            <button type="button" onClick={() => void refetch()} className="btn-key mt-3">{tr('Try again')}</button>
          </div>
        ) : (
          <div data-talk-sheet={bookId}>
            <div className="flex flex-col items-center gap-2 border-b border-ink-800/70 pb-3">
              <ReactionKeys bookId={bookId} seriesId={seriesId} talk={talk} />
              {!!talk?.reactions.length && (
                <p className="flex max-w-full items-center gap-2 text-[12px] text-fog-400">
                  <TalkFaces reactions={talk.reactions} max={6} />
                  <span className="truncate">{reactedLine(talk.reactions)}</span>
                </p>
              )}
            </div>
            {talk && !talk.comments.length && (
              <p className="py-8 text-center text-sm text-fog-500">{tr('No comments yet. Say what you thought of this chapter.')}</p>
            )}
            {!!talk?.comments.length && (
              <ul className="divide-y divide-ink-800/70" data-comments>
                {talk.comments.map((c) => (
                  <CommentRow key={c.id} c={c} admin={me.admin} onPage={onPage} onEdit={edit} onDelete={setDoomed} />
                ))}
              </ul>
            )}
            {!talk && !isError && <div className="h-24 animate-pulse-soft" />}
            <div ref={end} />
          </div>
        )}
      </Sheet>
      {doomed && (
        <ConfirmDialog
          title={doomed.mine ? tr('Delete your comment?') : tr("Remove {name}'s comment?", { name: `⁨${doomed.user.name}⁩` })}
          body={tr('It is gone for everyone.')}
          confirmLabel={doomed.mine ? tr('Delete') : tr('Remove')}
          danger
          onConfirm={() => void remove(doomed)}
          onClose={() => setDoomed(null)}
        />
      )}
    </>
  );
}
