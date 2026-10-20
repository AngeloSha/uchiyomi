// Chapter comments and reactions (v0.87.0), the web's half: the shapes the server answers (bff routes/comments.ts), the
// query keys, and the words and counts every surface shows alike -- the strip where two chapters meet in the reader, the
// key on a paged chapter's last page, the reader's top bar, the sheet and the series page's rows
// (components/ChapterTalk.tsx draws them).
//
// The rules are the server's (bff lib/comments.ts): only members who may open the series see its talk; a face is
// someone who reacted or commented, never someone who read; Incognito reading reads the talk but cannot add to it; and
// there is none on Uchiyomi Desktop or on a server with one member (`on`), nor, since v0.90.0, for an account that
// switched Comments and reactions off.
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useAuth } from './auth';
import { isDesktop } from './desktop';
import { keys, t as tr } from './i18n';

/** The six reactions, in the order every surface shows them. The server takes exactly these strings. */
export const REACTIONS = ['❤️', '😂', '😭', '😱', '🔥', '🤯'] as const;
export type Reaction = (typeof REACTIONS)[number];

/** The longest comment, in characters (an emoji is one): the server's COMMENT_MAX. */
export const COMMENT_MAX = 2000;

export interface TalkPerson { id: string; name: string; avatar: { emoji?: string; color?: string } }
export interface TalkComment {
  id: string;
  user: TalkPerson;
  body: string;
  /** The page it was written on, in the reader; null for one written elsewhere. */
  page: number | null;
  createdAt: string;
  editedAt: string | null;
  mine: boolean;
}
export interface TalkReaction { user: TalkPerson; emoji: Reaction; mine: boolean }
/** GET /api/books/:id/comments. `on`: whether the household has talk to show at all. */
export interface ChapterTalk { on: boolean; comments: TalkComment[]; reactions: TalkReaction[] }
/** One row of GET /api/series/:id/comments: a chapter with talk. */
export interface ChapterTalkCount { bookId: string; comments: number; reactions: number; top: Reaction[] }

export const talkKey = (bookId: string) => ['comments', bookId] as const;
export const seriesTalkKey = (seriesId: string) => ['series-comments', seriesId] as const;

/**
 * How tall the strip where two chapters meet is while talk is on, in px: the reader's height model reserves exactly
 * this (app/reader/page.tsx `tops`) where components/ReaderPage.tsx draws it. FIXED whatever the strip holds -- the
 * model is never measured back from the page, so a strip that grew when its faces arrived would put every page below it
 * off by the difference. Without talk the divider is DIVIDER_H, as it always was.
 */
export const SEAM_H = 156;

/** A chapter's talk, while `enabled`. Never asked on Uchiyomi Desktop, where the routes do not exist. */
export function useChapterTalk(bookId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: talkKey(bookId || ''),
    queryFn: () => api<ChapterTalk>(`/api/books/${bookId}/comments`),
    enabled: !!bookId && enabled && !isDesktop(),
    staleTime: 30_000,
  });
}

/**
 * The switch (v0.90.0, the owner's "a toggle in settings if someone wants to disable it"): its name and what it does, on
 * Profile → Settings → Reading, offered where the household has talk (`talk` on /auth/me). The account's, app_settings
 * `comments`, read by the server too (bff lib/comments.ts talkOnFor): off answers this account `on: false` everywhere
 * and sends it no alert about a conversation. Nobody else's talk changes, and what it wrote stays.
 */
export const COMMENTS_TEXT = keys(
  'Comments and reactions',
  'Your household’s comments and reactions, at the end of each chapter and on the series page. Off hides them, and their alerts, on all your devices. It changes nothing for anyone else.',
);

/** Whether the account wants the household's talk, as its settings say: on unless it is exactly `false`. */
export const talkWantedOf = (settings: Record<string, unknown> | null | undefined): boolean => settings?.comments !== false;

const ON_KEY = 'uchiyomi.talkOn';
/**
 * Whether this server has talk to show, as this browser last heard: the reader lays out its strips from the first
 * render with it, and the first answer (`probe`, the chapter on screen) confirms or corrects it. Read after mount -- the
 * static export renders without storage. Off on Uchiyomi Desktop whatever was heard, and from the first render for an
 * account that switched Comments and reactions off, which asks nothing at all. Reintroduce by dropping `wanted`: the
 * "a switched-off account" pin in comments.test.ts fails.
 */
export function useTalkOn(probe: string | null | undefined): boolean {
  const { user } = useAuth();
  const wanted = talkWantedOf(user?.settings);
  const [on, setOn] = useState(false);
  useEffect(() => {
    try { setOn(localStorage.getItem(ON_KEY) === '1'); } catch { /* private mode: wait for the answer */ }
  }, []);
  const { data } = useChapterTalk(probe, wanted);
  useEffect(() => {
    if (!data) return;
    setOn(data.on);
    try { localStorage.setItem(ON_KEY, data.on ? '1' : '0'); } catch { /* nothing to remember it in */ }
  }, [data]);
  return on && wanted && !isDesktop();
}

/** Each of the six with how many chose it and whether you did, in the six's order. */
export function reactionCounts(reactions: readonly TalkReaction[]): Array<{ emoji: Reaction; n: number; mine: boolean }> {
  return REACTIONS.map((emoji) => {
    const of = reactions.filter((r) => r.emoji === emoji);
    return { emoji, n: of.length, mine: of.some((r) => r.mine) };
  });
}

/** Your own reaction, or null. */
export const myReaction = (reactions: readonly TalkReaction[]): Reaction | null => reactions.find((r) => r.mine)?.emoji ?? null;

/**
 * Who reacted, in words: "You reacted", "Mostafa reacted", "You and Mostafa reacted", "Mostafa and Noura reacted",
 * "Mostafa, Noura and 2 others reacted" -- two names at most, you first and as "You". '' for nobody. One sentence a
 * shape, so each language words its own list ("و" in Arabic joins the name after it). Each name is isolated
 * (U+2068/U+2069), so an Arabic name in an English sentence keeps its own direction and the sentence its own.
 * ⚠️ Not tr('You'): that key is the Profile tab's name ("حسابي", "マイページ" -- my page), not the pronoun.
 */
export function reactedLine(reactions: readonly TalkReaction[]): string {
  if (!reactions.length) return '';
  const you = reactions.some((r) => r.mine);
  const n = reactions.filter((r) => !r.mine).map((r) => `\u2068${r.user.name}\u2069`);
  if (you) {
    if (!n.length) return tr('You reacted');
    if (n.length === 1) return tr('You and {name} reacted', { name: n[0] });
    return n.length === 2
      ? tr('You, {a} and 1 other reacted', { a: n[0] })
      : tr('You, {a} and {n} others reacted', { a: n[0], n: n.length - 1 });
  }
  if (n.length === 1) return tr('{name} reacted', { name: n[0] });
  if (n.length === 2) return tr('{a} and {b} reacted', { a: n[0], b: n[1] });
  return n.length === 3
    ? tr('{a}, {b} and 1 other reacted', { a: n[0], b: n[1] })
    : tr('{a}, {b} and {n} others reacted', { a: n[0], b: n[1], n: n.length - 2 });
}

/** "1 comment", "3 comments"; '' for none. */
export function commentsLine(n: number): string {
  if (n <= 0) return '';
  return n === 1 ? tr('1 comment') : tr('{n} comments', { n });
}

/** The page reference on a comment written in the reader: the page grid's own chip words (components/PageTile.tsx). */
export const pageRef = (n: number): string => tr('p.{n}', { n });
