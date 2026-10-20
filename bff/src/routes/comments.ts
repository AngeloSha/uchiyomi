// Chapter comments and reactions (v0.87.0). The rules are lib/comments.ts's; these routes are where each is enforced.
//
// Every route resolves the chapter -- or, for the series page's counts, the series -- through the content backend under
// the caller's own ViewCtx, so a member without the library, or under an age cap the series is over, gets the same 404
// as for a chapter that does not exist: talk about a series is never a way to learn that it exists. Registered on
// Uchiyomi Desktop too, where lib/desktop.ts DESKTOP_HIDDEN_ROUTES answers 404 for all of them: one person has nobody to
// talk to.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { q, one } from '../lib/db';
import { content as komga } from '../lib/backend';
import { viewCtxFor, type ViewCtx } from '../lib/visibility';
import { authenticate, userIdOf, roleOf, actsAsAdmin } from '../lib/auth';
import { incognitoOn } from '../lib/incognito';
import { logAudit } from '../lib/audit';
import { COMMENT_MAX, chapterTalk, isReaction, publicAvatar, seriesTalk, talkOnFor, type CommentOut } from '../lib/comments';
import { notifyConversation } from '../lib/push';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = { error: 'not_found' } as const;
/**
 * What Incognito reading answers a post or a reaction: they would tell the household what was read. Read-only, not
 * silent -- the web says why in the composer. Taking a reaction back, editing or deleting your own comment reveal
 * nothing new, and stay open.
 */
const INCOGNITO = { error: 'incognito' } as const;

/** A comment's text: trimmed, not empty, at most COMMENT_MAX characters (code points: an emoji is one). */
function cleanBody(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const body = raw.trim();
  if (!body || [...body].length > COMMENT_MAX) return null;
  return body;
}

export default async function commentRoutes(app: FastifyInstance) {
  // server.ts registers the limiter at the root; a test that mounts this plugin bare gets it here (personal.ts's way).
  if (!app.hasDecorator('createRateLimit')) await app.register(rateLimit, { global: false });
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', async (req) => {
    (req as any).viewCtx = await viewCtxFor(userIdOf(req), roleOf(req));
  });
  const vc = (req: FastifyRequest): ViewCtx => (req as any).viewCtx as ViewCtx;
  /** The chapter, when this caller may open it; null for a hidden one and for one that does not exist alike. */
  const chapterOf = (req: FastifyRequest, id: string) => komga.book(vc(req), id).catch(() => null);
  /** Per account, after authenticate (`hook: 'preHandler'`), so one household behind one address is not one budget. */
  const perAccount = (name: string, max: number) => ({
    config: { rateLimit: { max, timeWindow: '1 minute', hook: 'preHandler' as const, keyGenerator: (req: FastifyRequest) => `${name}:${userIdOf(req)}` } },
  });

  /** A chapter's talk: its comments, oldest first, and its reactions; `on` says whether the household has any to show. */
  app.get('/api/books/:id/comments', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await chapterOf(req, id))) return reply.code(404).send(NOT_FOUND);
    // v0.90.0: `on` is this member's (talkOnFor): off when the household has none, or when they switched it off.
    const [on, talk] = await Promise.all([talkOnFor(userIdOf(req)), chapterTalk(id, userIdOf(req))]);
    return { on, ...talk };
  });

  // Twenty a minute: a person typing, not a script.
  app.post('/api/books/:id/comments', perAccount('comment', 20), async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ body: z.unknown(), page: z.number().int().min(1).max(100_000).nullish() }).safeParse(req.body ?? {});
    const body = b.success ? cleanBody(b.data.body) : null;
    if (!b.success || body == null) return reply.code(400).send({ error: 'bad_request' });
    const book = await chapterOf(req, id);
    if (!book) return reply.code(404).send(NOT_FOUND);
    const uid = userIdOf(req);
    // Reintroduce by dropping this line: "Incognito reading reads the talk but cannot add to it" in
    // chapterComments.int.test.ts finds a comment written.
    if (await incognitoOn(uid)) return reply.code(403).send(INCOGNITO);
    const row = await one<{ id: string; created_at: Date; display_name: string | null; username: string | null; avatar: unknown }>(
      `WITH c AS (INSERT INTO chapter_comments (book_id, user_id, body, page) VALUES ($1, $2, $3, $4) RETURNING id, created_at)
       SELECT c.id, c.created_at, u.display_name, u.username, u.avatar FROM c, users u WHERE u.id = $2`,
      [id, uid, body, b.data.page ?? null],
    );
    if (!row) return reply.code(404).send(NOT_FOUND);
    const author = row.display_name || row.username || '';
    // The people already in this chapter's conversation hear of it; nobody else (lib/comments.ts conversationRecipients).
    void notifyConversation({
      bookId: id, authorId: uid, author, seriesId: book.seriesId, seriesTitle: book.seriesTitle || '',
      chapter: String(book.metadata?.number ?? book.number ?? ''), body,
    }).catch(() => {});
    const out: CommentOut = {
      id: row.id,
      user: { id: uid, name: author, avatar: publicAvatar(row.avatar) },
      body,
      page: b.data.page ?? null,
      createdAt: new Date(row.created_at).toISOString(),
      editedAt: null,
      mine: true,
    };
    return reply.code(201).send(out);
  });

  /** A comment, when it is this caller's to see: its chapter must still be theirs to open. */
  const commentOf = async (req: FastifyRequest, id: string) => {
    if (!UUID.test(id)) return null;
    const row = await one<{ id: string; user_id: string; book_id: string }>('SELECT id, user_id, book_id FROM chapter_comments WHERE id = $1', [id]);
    if (!row || !(await chapterOf(req, row.book_id))) return null;
    return row;
  };

  // Its author only. An admin removes a comment, never rewrites one: words under someone's name stay theirs.
  app.patch('/api/comments/:id', perAccount('comment-edit', 30), async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = cleanBody((req.body as { body?: unknown } | null)?.body);
    if (body == null) return reply.code(400).send({ error: 'bad_request' });
    const row = await commentOf(req, id);
    // Someone else's comment reads as no comment at all. Reintroduce by dropping the author test: "only its author edits
    // a comment" in chapterComments.int.test.ts sees another member's words changed.
    if (!row || row.user_id !== userIdOf(req)) return reply.code(404).send(NOT_FOUND);
    const r = await one<{ edited_at: Date }>(
      'UPDATE chapter_comments SET body = $2, edited_at = now() WHERE id = $1 RETURNING edited_at', [id, body]);
    return { id, body, editedAt: r ? new Date(r.edited_at).toISOString() : null };
  });

  // Its author, or an admin -- who is then recorded in the audit log as having removed someone's words.
  app.delete('/api/comments/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await commentOf(req, id);
    const uid = userIdOf(req);
    const own = row?.user_id === uid;
    // Reintroduce by letting anyone delete: "a member cannot delete someone else's comment" in chapterComments.int.test.ts
    // finds the comment gone.
    if (!row || (!own && !actsAsAdmin(req))) return reply.code(404).send(NOT_FOUND);
    await q('DELETE FROM chapter_comments WHERE id = $1', [id]);
    if (!own) await logAudit('comment.remove', { userId: uid, detail: { comment: id, book: row.book_id, author: row.user_id }, req });
    return { ok: true };
  });

  // One reaction a member a chapter: a second one replaces the first. Sixty a minute.
  app.put('/api/books/:id/reaction', perAccount('reaction', 60), async (req, reply) => {
    const { id } = req.params as { id: string };
    const emoji = (req.body as { emoji?: unknown } | null)?.emoji;
    if (!isReaction(emoji)) return reply.code(400).send({ error: 'bad_request' });
    if (!(await chapterOf(req, id))) return reply.code(404).send(NOT_FOUND);
    const uid = userIdOf(req);
    if (await incognitoOn(uid)) return reply.code(403).send(INCOGNITO);
    await q(
      `INSERT INTO chapter_reactions (book_id, user_id, emoji) VALUES ($1, $2, $3)
       ON CONFLICT (book_id, user_id) DO UPDATE SET emoji = EXCLUDED.emoji, created_at = now()`,
      [id, uid, emoji],
    );
    return { emoji };
  });

  app.delete('/api/books/:id/reaction', perAccount('reaction', 60), async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await chapterOf(req, id))) return reply.code(404).send(NOT_FOUND);
    await q('DELETE FROM chapter_reactions WHERE book_id = $1 AND user_id = $2', [id, userIdOf(req)]);
    return { ok: true };
  });

  /** The series page's counts: the chapters with talk, and how much. Behind the series' own gate. */
  app.get('/api/series/:id/comments', async (req, reply) => {
    const { id } = req.params as { id: string };
    try { await komga.series(vc(req), id); } catch { return reply.code(404).send(NOT_FOUND); }
    const [on, content] = await Promise.all([talkOnFor(userIdOf(req)), seriesTalk(id)]);
    return { on, content };
  });
}
