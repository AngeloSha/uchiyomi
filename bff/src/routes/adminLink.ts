// Connect sources (lib/linkBatch.ts) and a series' other names (lib/altTitles.ts): the admin routes.
//
// Registered from INSIDE adminRoutes (routes/admin.ts), not as a plugin of its own, so every route here sits
// behind that plugin's authenticate + requireAdmin hooks and in the route table the OpenAPI coverage test
// reads. admin.ts is already the largest file in the server; the batch lifecycle lives here instead.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { q, one } from '../lib/db';
import { userIdOf } from '../lib/auth';
import { logAudit } from '../lib/audit';
import { getSource } from '../lib/sources';
import { getSeriesRow } from '../lib/libraryAdmin';
import { updateSeries } from '../lib/updater';
import { MAX_FOLLOWERS } from '../lib/autoFollow';
import { normTitle } from '../lib/titleMatch';
import { altTitleRows, altTitleMatchingOn, recordAltTitles, MIN_ALT_KEY } from '../lib/altTitles';
import {
  createLinkBatch, searchBatch, claimSearch, releaseSearch, isSearching, isLinking, abortBatch,
  judgeManualPick, saveCandidate, runLinks, settleBatch,
  type LinkBatchRow, type LinkItemRow, type LinkCandidateRow,
} from '../lib/linkBatch';

const uuid = z.string().uuid();
const sourceName = (id: string) => getSource(id)?.name ?? id;

export async function linkRoutes(app: FastifyInstance) {
  /** A path id that is not a uuid is a batch that does not exist: 404, never a 500 from Postgres (22P02). */
  const idOf = (raw: unknown, reply: FastifyReply): string | null => {
    const p = uuid.safeParse(raw);
    if (!p.success) { reply.code(404).send({ error: 'not_found' }); return null; }
    return p.data;
  };

  // ---- batches ----------------------------------------------------------------------------------------

  app.get('/api/admin/link/batches', async () => {
    const rows = await q<LinkBatchRow>(
      'SELECT id, state, total, searched, linked, failed, created_at, updated_at FROM link_batches ORDER BY created_at DESC LIMIT 50');
    return { content: rows.map((r) => ({ ...r, stale: r.state === 'searching' && !isSearching(r.id) })) };
  });

  app.post('/api/admin/link/batches', async (req, reply) => {
    const b = z.object({ seriesIds: z.array(z.string().min(1).max(128)).min(1).max(500) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    // Claimed synchronously before the first await, the import's rule: two POSTs inside the INSERTs' window
    // would both pass a check made after it and both search.
    if (!claimSearch('pending')) {
      return reply.code(409).send({ error: 'busy', message: 'Another Connect sources search is running. Wait for it to finish, or discard it.' });
    }
    let started = false;
    try {
      const userId = userIdOf(req);
      const made = await createLinkBatch(userId, b.data.seriesIds);
      if (!made) return reply.code(400).send({ error: 'nothing_to_link', message: 'None of those series is in the library any more.' });
      releaseSearch('pending');
      claimSearch(made.id);
      await logAudit('link.batch.start', { userId, req, detail: { batchId: made.id, count: made.total, altTitles: await altTitleMatchingOn() } });
      void searchBatch(made.id).catch(() => {});
      started = true;
      return { batchId: made.id, total: made.total, skipped: made.skipped };
    } finally {
      if (!started) releaseSearch('pending');
    }
  });

  app.get('/api/admin/link/batches/:id', async (req, reply) => {
    const id = idOf((req.params as { id?: string }).id, reply);
    if (!id) return;
    let batch = await one<LinkBatchRow>('SELECT * FROM link_batches WHERE id = $1', [id]);
    if (!batch) return reply.code(404).send({ error: 'not_found' });
    // A `linking` batch nobody here is running was stranded by a restart: back to review (or done).
    if (batch.state === 'linking' && !isLinking(id)) batch = (await settleBatch(id)) ?? batch;
    const items = await q<LinkItemRow>('SELECT * FROM link_items WHERE batch_id = $1 ORDER BY ord', [id]);
    const cands = await q<LinkCandidateRow>(
      `SELECT c.* FROM link_candidates c JOIN link_items i ON i.id = c.item_id WHERE i.batch_id = $1 ORDER BY c.source`, [id]);
    const seriesIds = items.map((i) => i.series_id);
    // What each series follows NOW, not when it was searched: a follow made from another tab, or by this
    // batch's own run, changes how many slots are left, and the page picks against that.
    const primaries = await q<{ id: string; source_id: string | null }>(
      'SELECT id, source_id FROM lib_series WHERE id = ANY($1::text[])', [seriesIds]);
    const follows = await q<{ series_id: string; source_id: string }>(
      'SELECT series_id, source_id FROM series_sources WHERE series_id = ANY($1::text[]) ORDER BY created_at', [seriesIds]);
    const primaryOf = new Map(primaries.map((p) => [p.id, p.source_id]));
    return {
      batch: { ...batch, stale: batch.state === 'searching' && !isSearching(id), maxFollowers: MAX_FOLLOWERS },
      items: items.map((it) => {
        const primary = primaryOf.get(it.series_id) ?? null;
        const following = follows.filter((f) => f.series_id === it.series_id && f.source_id !== primary).map((f) => ({ source: f.source_id, name: sourceName(f.source_id) }));
        return {
          ...it,
          primary: primary ? { source: primary, name: sourceName(primary) } : null,
          following,
          freeSlots: Math.max(0, MAX_FOLLOWERS - following.length),
          candidates: cands.filter((c) => c.item_id === it.id).map((c) => ({ ...c, name: sourceName(c.source) })),
        };
      }),
    };
  });

  app.post('/api/admin/link/batches/:id/resume', async (req, reply) => {
    const id = idOf((req.params as { id?: string }).id, reply);
    if (!id) return;
    if (isSearching(id)) return { ok: true };
    if (!claimSearch(id)) return reply.code(409).send({ error: 'busy', message: 'Another Connect sources search is running.' });
    let started = false;
    try {
      const batch = await one<{ state: string }>('SELECT state FROM link_batches WHERE id = $1', [id]);
      if (!batch) return reply.code(404).send({ error: 'not_found' });
      if (batch.state !== 'searching') return reply.code(409).send({ error: 'not_searching', message: 'This batch is not waiting to search.' });
      void searchBatch(id).catch(() => {});
      started = true;
      return { ok: true };
    } finally {
      if (!started) releaseSearch(id);
    }
  });

  /**
   * Follow the chosen candidates. `override` is the admin's answer to "these do not line up -- follow them
   * anyway?": without it only `ok` candidates are followed and the rest read `not_confirmed`. The cap of
   * MAX_FOLLOWERS per series holds whatever is sent -- the third pick for one series reads `cap`.
   */
  app.post('/api/admin/link/batches/:id/run', async (req, reply) => {
    const id = idOf((req.params as { id?: string }).id, reply);
    if (!id) return;
    const b = z.object({
      candidateIds: z.array(z.string().uuid()).min(1).max(1500),
      override: z.boolean().optional(),
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const batch = await one<{ state: string }>('SELECT state FROM link_batches WHERE id = $1', [id]);
    if (!batch) return reply.code(404).send({ error: 'not_found' });
    if (batch.state === 'searching') return reply.code(409).send({ error: 'still_searching', message: 'Wait for the search to finish first.' });
    const rows = await q<LinkCandidateRow & { series_id: string; series_title: string }>(
      `SELECT c.*, i.series_id, i.title AS series_title FROM link_candidates c JOIN link_items i ON i.id = c.item_id
        WHERE i.batch_id = $1 AND c.status IS NULL AND c.id = ANY($2::uuid[]) ORDER BY i.ord, c.source`,
      [id, b.data.candidateIds]);
    if (!rows.length) return reply.code(400).send({ error: 'nothing_to_link', message: 'Nothing selected is waiting to be connected.' });
    // The atomic claim is the guard, as /run's on the import: a double tap finds `linking` and gets no row.
    const claimed = await one<{ id: string }>(
      `UPDATE link_batches SET state = 'linking', updated_at = now() WHERE id = $1 AND state NOT IN ('linking','searching') RETURNING id`, [id]);
    if (!claimed) return reply.code(409).send({ error: 'busy', message: 'This batch is already connecting.' });
    const userId = userIdOf(req);
    const override = b.data.override === true;
    await logAudit('link.batch.run', { userId, req, detail: { batchId: id, count: rows.length, override } });
    void runLinks(id, rows, { userId, override, refresh: (sid) => { void updateSeries(sid, 0).catch(() => {}); } }).catch(() => {});
    return { ok: true, total: rows.length };
  });

  app.delete('/api/admin/link/batches/:id', async (req, reply) => {
    const id = idOf((req.params as { id?: string }).id, reply);
    if (!id) return;
    abortBatch(id);
    const gone = await q<{ id: string }>('DELETE FROM link_batches WHERE id = $1 RETURNING id', [id]);
    if (gone.length) await logAudit('link.batch.discard', { userId: userIdOf(req), detail: { batchId: id }, req });
    return { ok: true };
  });

  /**
   * A candidate the admin found themselves, in the search sheet. Judged on the server by the same rule as
   * the search's own finds -- a client never names a pair that is saved on trust -- and saved as `manual`
   * whatever the verdict, so the review can show why it is amber.
   */
  app.post('/api/admin/link/items/:id/candidates', async (req, reply) => {
    const itemId = idOf((req.params as { id?: string }).id, reply);
    if (!itemId) return;
    const b = z.object({ source: z.string().min(1).max(128), sourceSeriesId: z.string().min(1).max(512) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const item = await one<{ id: string; batch_id: string; series_id: string }>('SELECT id, batch_id, series_id FROM link_items WHERE id = $1', [itemId]);
    if (!item) return reply.code(404).send({ error: 'not_found' });
    const j = await judgeManualPick(item.series_id, b.data);
    if ('error' in j) {
      const message = j.error === 'already_followed' ? 'This series already reads from that source.'
        : j.error === 'unknown_source' ? 'That source is not installed.'
        : 'That series is no longer in the library.';
      return reply.code(409).send({ error: j.error, message });
    }
    if (j.verdict === 'unreachable') return reply.code(502).send({ error: 'unreachable', message: 'That source did not answer. Try again in a moment.' });
    const row = await saveCandidate(item.id, j, true);
    await q('UPDATE link_batches SET updated_at = now() WHERE id = $1', [item.batch_id]).catch(() => {});
    return { ok: true, candidate: row ? { ...row, name: sourceName(row.source) } : null };
  });

  // ---- a series' other names ------------------------------------------------------------------------

  app.get('/api/admin/series/:id/alt-titles', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await getSeriesRow(id))) return reply.code(404).send({ error: 'not_found' });
    const rows = await altTitleRows(id);
    return {
      matching: await altTitleMatchingOn(),
      content: rows.map((r) => ({ ...r, sourceName: r.source_id ? sourceName(r.source_id) : null })),
    };
  });

  app.post('/api/admin/series/:id/alt-titles', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ title: z.string().trim().min(1).max(200) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const row = await getSeriesRow(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const k = normTitle(b.data.title);
    if (k.length < MIN_ALT_KEY) {
      return reply.code(400).send({ error: 'too_short', message: `A name needs at least ${MIN_ALT_KEY} letters or digits (A–Z, 0–9) to be matched safely.` });
    }
    if (k === normTitle(row.title)) return reply.code(400).send({ error: 'same_as_title', message: 'That is already the series’ own title.' });
    const n = await recordAltTitles(id, [b.data.title], 'admin', { userId: userIdOf(req) });
    // Already there under another origin: the typed name is now the person's word for it.
    if (!n) await q(`UPDATE series_alt_titles SET origin = 'admin', added_by = $3 WHERE series_id = $1 AND norm = $2`, [id, k, userIdOf(req)]);
    await logAudit('series.alt_title.add', { userId: userIdOf(req), req, detail: { id, title: row.title, name: b.data.title } });
    return { ok: true };
  });

  app.delete('/api/admin/series/:id/alt-titles/:norm', async (req, reply) => {
    const { id, norm } = req.params as { id: string; norm: string };
    const gone = await q<{ title: string }>('DELETE FROM series_alt_titles WHERE series_id = $1 AND norm = $2 RETURNING title', [id, norm]);
    if (!gone.length) return reply.code(404).send({ error: 'not_found' });
    await logAudit('series.alt_title.remove', { userId: userIdOf(req), req, detail: { id, name: gone[0].title } });
    return { ok: true };
  });
}
