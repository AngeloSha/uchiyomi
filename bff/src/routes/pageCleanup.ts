import type { FastifyInstance, FastifyRequest } from 'fastify';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { env } from '../env';
import { one, q, tx } from '../lib/db';
import { userIdOf, roleOf } from '../lib/auth';
import { viewCtxFor, visibleBookFile, hideAdult } from '../lib/visibility';
import { cbzPages, LIBRARY_ROOT, withScansHeld } from '../lib/library';
import { claimWriterFolders } from '../lib/bulkNewest';
import { folderBusy } from '../lib/numbering';
import { runsInside } from '../lib/updater';
import { applyPageCleanup, previewPageCleanup, PageCleanupError, type CleanupTarget } from '../lib/pageCleanupFiles';
import { getSource } from '../lib/sources';
import { OWNED } from '../lib/backend';

interface Book { id: string; file: string; root: string; series_id: string; folder: string; source_id: string | null }
const bookSql = `SELECT b.id, b.file, b.root, b.series_id, s.folder, b.source_id
  FROM lib_books b JOIN lib_series s ON s.id = b.series_id WHERE b.id = $1 AND b.pruned_at IS NULL`;
const target = (b: Book): CleanupTarget => {
  const root = path.resolve(b.root || LIBRARY_ROOT), file = path.resolve(root, b.file);
  if (path.relative(root, file).startsWith('..') || path.isAbsolute(path.relative(root, file)))
    throw new PageCleanupError('unsupported_path', 'The chapter is outside its configured library root.');
  return { bookId: b.id, file, store: path.join(env.CONFIG_DIR, 'page-trash') };
};
async function visibleBook(req: FastifyRequest, id: string): Promise<Book> {
  if (!OWNED) throw new PageCleanupError('unsupported_backend', 'Page cleanup and source rules require a local Uchiyomi library. Use Skip for remote chapters.');
  const ctx = await viewCtxFor(userIdOf(req), roleOf(req), { hideAdult: hideAdult(req) });
  if (!await visibleBookFile(id, ctx)) throw Object.assign(new Error('Chapter not found.'), { statusCode: 404 });
  const b = await one<Book>(bookSql, [id]);
  if (!b) throw Object.assign(new Error('Chapter not found.'), { statusCode: 404 });
  return b;
}

// Registered inside adminRoutes: authentication/requireAdmin are inherited, including admin token scope.
export default async function pageCleanupRoutes(app: FastifyInstance) {
  app.get('/api/admin/books/:id/page-cleanup', async (req) => {
    const { id } = req.params as { id: string };
    return previewPageCleanup(target(await visibleBook(req, id)));
  });
  app.post('/api/admin/books/:id/page-cleanup', async (req, reply) => {
    const parsed = z.object({ action: z.enum(['remove', 'restore', 'purge', 'purge-unused']), pages: z.array(z.number().int().positive()).max(500),
      revision: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true) })
      .refine((b) => b.action === 'purge-unused' ? b.pages.length === 0 : b.pages.length > 0).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_cleanup', message: 'Preview the selected pages and confirm the operation.' });
    const { id } = req.params as { id: string };
    const before = await visibleBook(req, id);
    const claim = claimWriterFolders([before.folder], folderBusy, () => runsInside(before.series_id) > 0);
    if (!claim) return reply.code(409).send({ error: 'busy', message: 'Another task is changing this series. Try again after it finishes.' });
    try {
      return await withScansHeld(() => tx(async (qq) => {
        const [lock] = await qq<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 354)) AS ok', [`page-cleanup:${id}`]);
        if (!lock?.ok) throw new PageCleanupError('busy', 'Another page editor is changing this chapter.');
        const [b] = await qq<Book>(`${bookSql} FOR UPDATE OF b, s`, [id]);
        if (!b || b.file !== before.file || b.root !== before.root || b.folder !== before.folder)
          throw new PageCleanupError('preview_stale', 'This chapter moved. Open its page preview again.');
        await visibleBook(req, id);
        const t = target(b);
        const result = await applyPageCleanup(t, parsed.data.action, parsed.data.pages, parsed.data.revision);
        const st = await stat(t.file);
        await qq(`UPDATE lib_books SET page_dims = NULL, spreads = NULL, fp_at = NULL, size = $2, mtime = $3, updated_at = now() WHERE id = $1`, [id, st.size, Math.floor(st.mtimeMs)]);
        // Derived data for changed slots goes; every override, progress row, bookmark and spread mark stays.
        await qq('UPDATE page_hashes SET hash = NULL WHERE book_id = $1 AND page = ANY($2::int[])', [id, parsed.data.pages]);
        await qq('DELETE FROM page_hashes WHERE book_id = $1 AND page = 0', [id]);
        await qq('DELETE FROM page_translations WHERE book_id = $1 AND page = ANY($2::int[])', [id, parsed.data.pages]);
        return result;
      }));
    } finally { claim.release(); }
  });
  app.get('/api/admin/books/:id/page-rules', async (req) => {
    const { id } = req.params as { id: string };
    const b = await visibleBook(req, id);
    if (!b.source_id) return { sourceId: null, pages: [], sourceRule: null, seriesRule: null, chapters: 0, seriesChapters: 0 };
    const [rules, counts, names, rescued] = await Promise.all([
      q<{ series_scope: string; skip_gif: boolean }>(`SELECT series_scope, skip_gif FROM source_page_rules WHERE source_id = $1 AND series_scope IN ('', $2)`, [b.source_id, b.series_id]),
      one<{ total: number; series: number }>(`SELECT count(*)::int AS total, count(*) FILTER (WHERE series_id = $2)::int AS series FROM lib_books WHERE source_id = $1 AND pruned_at IS NULL`, [b.source_id, b.series_id]),
      cbzPages(target(b).file),
      q<{ page: number }>('SELECT page FROM page_hashes WHERE book_id = $1 AND override = false', [id]),
    ]);
    return { sourceId: b.source_id, sourceName: getSource(b.source_id)?.name ?? b.source_id, seriesId: b.series_id,
      pages: names.flatMap((name, i) => /\.gif$/i.test(name) ? [{ number: i + 1, name, rescued: rescued.some((r) => r.page === i + 1) }] : []),
      sourceRule: rules.find((r) => r.series_scope === '')?.skip_gif ?? null,
      seriesRule: rules.find((r) => r.series_scope === b.series_id)?.skip_gif ?? null,
      chapters: counts?.total ?? 0, seriesChapters: counts?.series ?? 0 };
  });
  app.put('/api/admin/books/:id/page-rules', async (req, reply) => {
    const parsed = z.object({ scope: z.enum(['series', 'source']), skipGif: z.boolean().nullable(), confirm: z.literal(true) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_rule' });
    const { id } = req.params as { id: string };
    const b = await visibleBook(req, id);
    if (!b.source_id) return reply.code(409).send({ error: 'source_unknown', message: 'This downloaded copy has no recorded source. A source rule cannot be guessed from its title.' });
    const scope = parsed.data.scope === 'series' ? b.series_id : '';
    if (parsed.data.skipGif === null) await q('DELETE FROM source_page_rules WHERE source_id = $1 AND series_scope = $2', [b.source_id, scope]);
    else await q(`INSERT INTO source_page_rules (source_id, series_scope, skip_gif) VALUES ($1, $2, $3)
      ON CONFLICT (source_id, series_scope) DO UPDATE SET skip_gif = EXCLUDED.skip_gif, updated_at = now()`, [b.source_id, scope, parsed.data.skipGif]);
    return { ok: true };
  });
}
