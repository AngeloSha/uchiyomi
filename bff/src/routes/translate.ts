import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate, requireAdmin, roleOf, userIdOf } from '../lib/auth';
import { one, q } from '../lib/db';
import { viewCtxFor, hideAdult, visibleBookFile, type ViewCtx } from '../lib/visibility';
import { engineStatus, pickSize, removeEngine, startDownload, stopEngine } from '../lib/translate/engine';
import type { EngineSize } from '../lib/translate/pin';
import { readerLang } from '../lib/translate/pages';
import { RENDER_VERSION } from '../lib/translate/render';
import { clearQueue, engineKey, pagesWanted, queueProblem, requestPages, translateOn } from '../lib/translate/queue';

/**
 * Translated pages (v0.85.0, opt-in): a member's reader asks for a chapter's pages in their language and reads which
 * are ready; the admin downloads, removes and switches the engine. Until the engine is downloaded and the switch is on,
 * every answer here is "off" and nothing runs.
 */

const vc = (req: FastifyRequest): ViewCtx => (req as any).viewCtx as ViewCtx;

/** The installed engine's key when members can translate (the switch is on and the engine downloaded), else null. */
async function available(): Promise<string | null> {
  if (!(await translateOn())) return null;
  return engineKey();
}

async function bookStatus(bookId: string, lang: string) {
  const key = await available();
  if (!key) return { available: false, problem: null, pages: {}, failed: [], pending: 0 };
  const rows = await q<{ page: number; status: string; at: string }>(
    `SELECT page, status, (extract(epoch FROM created_at) * 1000)::bigint::text AS at FROM page_translations
      WHERE book_id = $1 AND lang = $2 AND engine = $3`, [bookId, lang, key]);
  const pages: Record<number, string> = {};
  const failed: number[] = [];
  // The stamp is the translation's time and the drawing's version: either changing gives the page a new address, so a
  // reader never keeps an old picture from its cache (the image is cached for a year).
  for (const r of rows) { if (r.status === 'done') pages[r.page] = `${r.at}.${RENDER_VERSION}`; else failed.push(r.page); }
  return { available: true, problem: queueProblem(), pages, failed, pending: pagesWanted(bookId, lang) };
}

const adminStatus = async () => ({ enabled: await translateOn(), ...(await engineStatus()), problem: queueProblem() });

export default async function translateRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', async (req) => {
    (req as any).viewCtx = await viewCtxFor(userIdOf(req), roleOf(req), { hideAdult: hideAdult(req) });
  });

  /** Whether the reader offers "Translate pages" at all. */
  app.get('/api/translate', async () => ({ available: !!(await available()) }));

  /** Which pages of a chapter are translated into `lang` (a stamp each, for the image URL), which failed, how many wait. */
  app.get('/api/books/:id/translations', async (req, reply) => {
    const { id } = req.params as { id: string };
    const lang = readerLang((req.query as Record<string, string>).lang);
    if (!lang) return reply.code(400).send({ error: 'bad_lang' });
    // The same gate as the chapter's pages: nothing about a chapter the viewer cannot open.
    if (!(await visibleBookFile(id, vc(req)))) return reply.code(404).send({ error: 'no_book' });
    return bookStatus(id, lang);
  });

  /** Translate this chapter into `lang` from page `from` on, ahead of anything asked before. */
  app.post('/api/books/:id/translations', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { lang?: unknown; from?: unknown };
    const lang = readerLang(body.lang);
    const from = Number(body.from ?? 1);
    if (!lang || !Number.isInteger(from) || from < 1) return reply.code(400).send({ error: 'bad_request' });
    if (!(await visibleBookFile(id, vc(req)))) return reply.code(404).send({ error: 'no_book' });
    const key = await available();
    if (!key) return reply.code(409).send({ error: 'translate_off' });
    const b = await one<{ pages: number }>('SELECT pages FROM lib_books WHERE id = $1', [id]);
    // Only the pages not translated yet: a chapter read again is not queued, and its reader is not told "Translating…".
    // A page that failed is tried again.
    const done = new Set((await q<{ page: number }>(
      `SELECT page FROM page_translations WHERE book_id = $1 AND lang = $2 AND engine = $3 AND status = 'done'`, [id, lang, key])).map((r) => r.page));
    const pages: number[] = [];
    for (let p = Math.min(from, b?.pages ?? 0); p >= 1 && p <= (b?.pages ?? 0); p++) if (!done.has(p)) pages.push(p);
    requestPages(id, lang, pages);
    return reply.code(202).send(await bookStatus(id, lang));
  });

  // ---- Admin -> Settings -> Translate pages ----

  app.get('/api/admin/translate', { preHandler: requireAdmin }, adminStatus);

  /** Download the engine in the background (GET shows the progress). `size` overrides the one this machine picks. */
  app.post('/api/admin/translate/download', { preHandler: requireAdmin }, async (req, reply) => {
    const size = (req.body as { size?: unknown } | undefined)?.size;
    if (size !== undefined && size !== 'large' && size !== 'small') return reply.code(400).send({ error: 'bad_size' });
    if ((await engineStatus()).state === 'unsupported') return reply.code(409).send({ error: 'unsupported' });
    startDownload((size as EngineSize | undefined) ?? pickSize());
    return reply.code(202).send(await adminStatus());
  });

  /** Remove the engine's files (and stop it). Translations already made stay, ready if the same engine comes back. */
  app.delete('/api/admin/translate', { preHandler: requireAdmin }, async () => {
    clearQueue();
    await removeEngine();
    return adminStatus();
  });

  /** The one switch. Off stops the engine and forgets what was waiting. */
  app.put('/api/admin/translate', { preHandler: requireAdmin }, async (req, reply) => {
    const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
    if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'bad_request' });
    await q('UPDATE server_settings SET translate_pages = $1, updated_at = now() WHERE id = 1', [enabled]);
    if (!enabled) { clearQueue(); stopEngine(); }
    return adminStatus();
  });
}
