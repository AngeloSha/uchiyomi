// Chapter comments and reactions (v0.87.0): what the household says about a chapter, and how it took it.
//
// The owner's ask: "a comment section for each chapter so u can discuss the chapter or see the reactions of people in
// household". The reader runs chapters on into each other, so the talk is not under a chapter: it sits where a chapter
// ENDS -- the strip between two chapters in the webtoon column, a key on a chapter's last page when paged -- and behind
// a key in the reader's top bar (web/components/ChapterTalk.tsx). Plain words, read by people who share a server.
//
// The rules, each enforced by routes/comments.ts:
// - Seen only by those who may open the series: every route resolves the chapter through the content backend under the
//   viewer's own ViewCtx (library access, the age cap), and a hidden chapter answers 404 like a missing one.
// - A face is someone who said something -- a comment or a reaction -- and never someone who merely READ: what a member
//   reads stays theirs (components/HouseBoard.tsx's rule). Looking at a chapter's talk records nothing.
// - Incognito reading is read-only here: posting or reacting would tell the household what was read.
// - One reaction a member a chapter, from REACTIONS. A comment is plain text; its author edits or deletes it, an admin
//   may remove it.
// - Off where there is nobody to talk to: Uchiyomi Desktop, a server with one enabled member, and the Komga backend,
//   whose chapters are not rows of this database (talkOn).
import { q, one } from './db';
import { isDesktop } from './desktop';
import { viewCtxFor, seriesVisible } from './visibility';

/** The six reactions, in the order every surface shows them. Stored as these exact strings (emoji presentation). */
export const REACTIONS = ['❤️', '😂', '😭', '😱', '🔥', '🤯'] as const;
export type Reaction = (typeof REACTIONS)[number];
export const isReaction = (v: unknown): v is Reaction => typeof v === 'string' && (REACTIONS as readonly string[]).includes(v);

/** The longest comment, in characters, after trimming. */
export const COMMENT_MAX = 2000;
/** The most comments one chapter answers with: a household's talk, with room to spare. */
const COMMENTS_LIMIT = 500;

/** Who said it, as /api/leaderboard already shows every member: the name and the avatar, nothing else. */
export interface TalkPerson { id: string; name: string; avatar: { emoji?: string; color?: string } }
export interface CommentOut {
  id: string;
  user: TalkPerson;
  body: string;
  /** The page it was written on, in the reader; null for one written elsewhere. */
  page: number | null;
  createdAt: string;
  editedAt: string | null;
  mine: boolean;
}
export interface ReactionOut { user: TalkPerson; emoji: Reaction; mine: boolean }
/** One chapter of a series that has talk, for the series page's rows. `top`: its most used reactions, at most two. */
export interface ChapterTalkCount { bookId: string; comments: number; reactions: number; top: Reaction[] }

const person = (r: { uid: string; display_name: string | null; username?: string | null; avatar: unknown }): TalkPerson => {
  const a = (r.avatar && typeof r.avatar === 'object' ? r.avatar : {}) as { emoji?: unknown; color?: unknown };
  return {
    id: r.uid,
    name: r.display_name || r.username || '',
    avatar: { ...(typeof a.emoji === 'string' ? { emoji: a.emoji } : {}), ...(typeof a.color === 'string' ? { color: a.color } : {}) },
  };
};

const OWNED = () => process.env.LIBRARY_BACKEND !== 'komga';
const ON_TTL_MS = 60_000;
let onCache: { at: number; on: boolean } | null = null;
/** Forget the cached answer: a test that adds or disables a member, and nothing else. */
export function resetTalkOn(): void { onCache = null; }

/**
 * Whether this server has a household to talk to: the owned library, not Uchiyomi Desktop, and two or more enabled
 * members. Asked on every answer the web reads it from, so cached for a minute. Reintroduce by answering true on a
 * one-member server: "a server with one member has nobody to talk to" in chapterComments.int.test.ts reads `on`.
 */
export async function talkOn(now = Date.now()): Promise<boolean> {
  if (!OWNED() || isDesktop()) return false;
  if (onCache && now - onCache.at < ON_TTL_MS) return onCache.on;
  const r = await one<{ n: number }>('SELECT count(*)::int AS n FROM users WHERE NOT disabled');
  const on = Number(r?.n ?? 0) >= 2;
  onCache = { at: now, on };
  return on;
}

/** A chapter's comments, oldest first, and its reactions, for the viewer `uid`. The caller has checked the chapter is theirs to see. */
export async function chapterTalk(bookId: string, uid: string): Promise<{ comments: CommentOut[]; reactions: ReactionOut[] }> {
  const [comments, reactions] = await Promise.all([
    q<{ id: string; body: string; page: number | null; created_at: Date; edited_at: Date | null; uid: string; display_name: string | null; username: string | null; avatar: unknown }>(
      `SELECT c.id, c.body, c.page, c.created_at, c.edited_at, u.id AS uid, u.display_name, u.username, u.avatar
         FROM chapter_comments c JOIN users u ON u.id = c.user_id
        WHERE c.book_id = $1
        ORDER BY c.created_at, c.id
        LIMIT ${COMMENTS_LIMIT}`,
      [bookId],
    ),
    q<{ emoji: string; uid: string; display_name: string | null; username: string | null; avatar: unknown }>(
      `SELECT r.emoji, u.id AS uid, u.display_name, u.username, u.avatar
         FROM chapter_reactions r JOIN users u ON u.id = r.user_id
        WHERE r.book_id = $1
        ORDER BY r.created_at, u.id`,
      [bookId],
    ),
  ]);
  return {
    comments: comments.map((c) => ({
      id: c.id,
      user: person(c),
      body: c.body,
      page: c.page == null ? null : Number(c.page),
      createdAt: new Date(c.created_at).toISOString(),
      editedAt: c.edited_at ? new Date(c.edited_at).toISOString() : null,
      mine: c.uid === uid,
    })),
    // A reaction no longer in the six (none today) is left out rather than shown as a stranger's emoji.
    reactions: reactions.filter((r) => isReaction(r.emoji)).map((r) => ({ user: person(r), emoji: r.emoji as Reaction, mine: r.uid === uid })),
  };
}

/** Its two most used reactions, the six's own order breaking a tie. */
export function topReactions(counts: ReadonlyMap<string, number>): Reaction[] {
  return REACTIONS.filter((e) => (counts.get(e) ?? 0) > 0)
    .map((e, i) => ({ e, n: counts.get(e) ?? 0, i }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .slice(0, 2)
    .map((x) => x.e);
}

/**
 * The chapters of a series that have talk, with their counts: the series page's rows. Keyed on the chapters the series
 * holds NOW, so a merged series counts what moved into it. The caller has checked the series is the viewer's to see.
 */
export async function seriesTalk(seriesId: string): Promise<ChapterTalkCount[]> {
  const [comments, reactions] = await Promise.all([
    q<{ book_id: string; n: number }>(
      `SELECT c.book_id, count(*)::int AS n FROM chapter_comments c JOIN lib_books b ON b.id = c.book_id
        WHERE b.series_id = $1 GROUP BY c.book_id`,
      [seriesId],
    ),
    q<{ book_id: string; emoji: string; n: number }>(
      `SELECT r.book_id, r.emoji, count(*)::int AS n FROM chapter_reactions r JOIN lib_books b ON b.id = r.book_id
        WHERE b.series_id = $1 GROUP BY r.book_id, r.emoji`,
      [seriesId],
    ),
  ]);
  const byBook = new Map<string, { comments: number; emoji: Map<string, number> }>();
  const at = (id: string) => {
    let v = byBook.get(id);
    if (!v) { v = { comments: 0, emoji: new Map() }; byBook.set(id, v); }
    return v;
  };
  for (const c of comments) at(c.book_id).comments = Number(c.n);
  for (const r of reactions) if (isReaction(r.emoji)) at(r.book_id).emoji.set(r.emoji, Number(r.n));
  return [...byBook].map(([bookId, v]) => ({
    bookId,
    comments: v.comments,
    reactions: [...v.emoji.values()].reduce((a, b) => a + b, 0),
    top: topReactions(v.emoji),
  })).filter((x) => x.comments > 0 || x.reactions > 0);
}

/**
 * Who hears of a new comment (the owner's ruling: only that chapter's conversation): the members who commented on the
 * chapter before, never its author, never a disabled account, and each one only while they may still open the series
 * -- judged under their own view at send time, as notifyNewChapter judges a favourite. A failed lookup counts them out.
 * Reintroduce by dropping the visibility check: "a new comment reaches only the conversation" in
 * chapterComments.int.test.ts finds the member who lost the library among the recipients.
 */
export async function conversationRecipients(bookId: string, authorId: string): Promise<string[]> {
  const book = await one<{ series_id: string }>('SELECT series_id FROM lib_books WHERE id = $1', [bookId]);
  if (!book) return [];
  const people = await q<{ user_id: string; role: string }>(
    `SELECT DISTINCT c.user_id, u.role FROM chapter_comments c JOIN users u ON u.id = c.user_id
      WHERE c.book_id = $1 AND c.user_id <> $2 AND NOT u.disabled`,
    [bookId, authorId],
  );
  const out: string[] = [];
  for (const p of people) {
    const ok = await viewCtxFor(p.user_id, p.role).then((ctx) => seriesVisible(book.series_id, ctx)).catch(() => false);
    if (ok) out.push(p.user_id);
  }
  return out.sort();
}

/** What a push about a new comment says: the series and the chapter, then who said what, cut to fit a notification. */
export function conversationPush(o: { seriesId: string; seriesTitle: string; chapter: string; bookId: string; author: string; body: string }) {
  const flat = o.body.replace(/\s+/g, ' ').trim();
  const text = flat.length > 140 ? `${flat.slice(0, 139).trimEnd()}…` : flat;
  return {
    title: `${o.seriesTitle} · Chapter ${o.chapter}`,
    body: `${o.author}: ${text}`,
    url: `/series/?id=${encodeURIComponent(o.seriesId)}&comments=${encodeURIComponent(o.bookId)}`,
    tag: `comments-${o.bookId}`,
  };
}
