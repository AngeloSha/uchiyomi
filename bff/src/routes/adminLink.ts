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
import { chooseReleases } from '../lib/releases';
import { effectivePrefsFor, readSeriesPrefs } from '../lib/scanlatorPrefs';
import { seriesAndChapters } from './sources';
import { altTitleRows, altTitleMatchingOn, recordAltTitles, MIN_ALT_KEY } from '../lib/altTitles';
import {
  createLinkBatch, searchBatch, claimSearch, releaseSearch, isSearching, isLinking, abortBatch, searchWaitingOn,
  judgeManualPick, saveCandidate, runLinks, followSingle, settleBatch, closeStale, mayFollow, ourNumbers,
  type LinkBatchRow, type LinkItemRow, type LinkCandidateRow, type PickError,
} from '../lib/linkBatch';
import { POSTING_ORDER_REFUSAL } from '../lib/numbering';

const uuid = z.string().uuid();
const sourceName = (id: string) => getSource(id)?.name ?? id;
/** The listing refresh after a follow, as the manual follow route does it -- but queued and paced (lib/linkBatch.ts). */
const refresh = (seriesId: string) => updateSeries(seriesId, 0);

/** What a refused manual pick or single follow says, per reason. */
const PICK_MESSAGES: Record<PickError | 'changed' | 'busy' | 'closed' | 'cap' | 'primary', string> = {
  gone: 'That series is no longer in the library.',
  posting_order: POSTING_ORDER_REFUSAL,
  full: 'This series already follows two other sources. Stop following one from the series page first.',
  too_few: 'This series lists too few chapters to compare with another source.',
  already_followed: 'This series already reads from that source.',
  unknown_source: 'That source is not installed.',
  unavailable: 'That source is switched off or paused right now.',
  unreachable: 'That source did not answer. Try again in a moment.',
  title_differs: 'None of its names is one of this series’ names.',
  not_this_series: 'Its name only contains this series’ name, and its chapters do not line up: most likely a sequel or a spin-off.',
  changed: 'That source no longer lists it under a name of this series. Search again.',
  busy: 'Wait for this batch to finish what it is doing.',
  closed: 'That candidate was already dealt with.',
  cap: 'This series already follows two other sources.',
  primary: 'That is already the series’ own source.',
};
const STATUS_CODE: Record<string, number> = { gone: 404, not_found: 404, unreachable: 502 };

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

  /**
   * Start a batch. Series that cannot take a follower are left out and said so in `skipped` (gone, numbered
   * by posting order, or already following two); when that is all of them, 400 `nothing_to_link`.
   */
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
      if (!made.id) {
        const why = made.skipped.every((s) => s.why === made.skipped[0]?.why) ? made.skipped[0]?.why : null;
        const message = why === 'posting_order' ? POSTING_ORDER_REFUSAL
          : why === 'full' ? 'Every series you picked already follows two other sources.'
          : why === 'gone' ? 'None of those series is in the library any more.'
          : 'None of those series can take another source.';
        return reply.code(400).send({ error: 'nothing_to_link', message, skipped: made.skipped });
      }
      releaseSearch('pending');
      claimSearch(made.id);
      await logAudit('link.batch.start', { userId, req, detail: { batchId: made.id, count: made.total, skipped: made.skipped.length, altTitles: await altTitleMatchingOn() } });
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
    // What each series follows NOW, not when it was searched: a candidate whose source was followed since --
    // here, from the Sources sheet, by the hunt -- is closed rather than left to be run again.
    if (batch.state !== 'linking') await closeStale(id).catch(() => {});
    const items = await q<LinkItemRow>('SELECT * FROM link_items WHERE batch_id = $1 ORDER BY ord', [id]);
    const cands = await q<LinkCandidateRow>(
      `SELECT c.* FROM link_candidates c JOIN link_items i ON i.id = c.item_id WHERE i.batch_id = $1 ORDER BY c.source`, [id]);
    const seriesIds = items.map((i) => i.series_id);
    const primaries = await q<{ id: string; source_id: string | null }>(
      'SELECT id, source_id FROM lib_series WHERE id = ANY($1::text[])', [seriesIds]);
    const follows = await q<{ series_id: string; source_id: string }>(
      'SELECT series_id, source_id FROM series_sources WHERE series_id = ANY($1::text[]) ORDER BY created_at', [seriesIds]);
    const primaryOf = new Map(primaries.map((p) => [p.id, p.source_id]));
    return {
      batch: { ...batch, stale: batch.state === 'searching' && !isSearching(id), waiting: searchWaitingOn(id), maxFollowers: MAX_FOLLOWERS },
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
   * Follow the chosen candidates. Only `ok` ones are run -- what autoFollow's judgeCandidate would follow
   * itself; there is no bulk override. Anything else sent is left open and counted in `held` (a
   * `numbering_differs` candidate is followed one at a time, from its chapter list: POST
   * /api/admin/link/candidates/:id/follow). The cap of MAX_FOLLOWERS per series holds whatever is sent.
   */
  app.post('/api/admin/link/batches/:id/run', async (req, reply) => {
    const id = idOf((req.params as { id?: string }).id, reply);
    if (!id) return;
    const b = z.object({ candidateIds: z.array(z.string().uuid()).min(1).max(1500) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const batch = await one<{ state: string }>('SELECT state FROM link_batches WHERE id = $1', [id]);
    if (!batch) return reply.code(404).send({ error: 'not_found' });
    if (batch.state === 'searching') return reply.code(409).send({ error: 'still_searching', message: 'Wait for the search to finish first.' });
    await closeStale(id).catch(() => {});
    const rows = await q<LinkCandidateRow & { series_id: string; series_title: string }>(
      `SELECT c.*, i.series_id, i.title AS series_title FROM link_candidates c JOIN link_items i ON i.id = c.item_id
        WHERE i.batch_id = $1 AND c.status IS NULL AND c.id = ANY($2::uuid[]) ORDER BY i.ord, c.source`,
      [id, b.data.candidateIds]);
    const runnable = rows.filter((r) => mayFollow(r));
    const held = rows.length - runnable.length;
    if (!runnable.length) {
      return reply.code(rows.length ? 409 : 400).send(rows.length
        ? { error: 'not_followable', message: 'The chapters of what you selected do not line up. Open its chapters to connect one on its own.' }
        : { error: 'nothing_to_link', message: 'Nothing selected is waiting to be connected.' });
    }
    // The atomic claim is the guard, as /run's on the import: a double tap finds `linking` and gets no row.
    const claimed = await one<{ id: string }>(
      `UPDATE link_batches SET state = 'linking', updated_at = now() WHERE id = $1 AND state NOT IN ('linking','searching') RETURNING id`, [id]);
    if (!claimed) return reply.code(409).send({ error: 'busy', message: 'This batch is already connecting.' });
    const userId = userIdOf(req);
    await logAudit('link.batch.run', { userId, req, detail: { batchId: id, count: runnable.length, held } });
    void runLinks(id, runnable, { userId, refresh }).catch(() => {});
    return { ok: true, total: runnable.length, held, ids: runnable.map((r) => r.id) };
  });

  /**
   * Follow ONE candidate, from its chapter list: the only way a candidate whose name matches but whose
   * chapter numbers do not line up is ever followed, and only with `confirm: true`. Judged again first; the
   * audit row says it was confirmed by hand.
   */
  app.post('/api/admin/link/candidates/:id/follow', async (req, reply) => {
    const cid = idOf((req.params as { id?: string }).id, reply);
    if (!cid) return;
    const b = z.object({ confirm: z.literal(true) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'Confirm to connect this source.' });
    const r = await followSingle(cid, userIdOf(req), { refresh });
    if (r.ok) return { ok: true, status: r.status };
    const message = PICK_MESSAGES[r.error as keyof typeof PICK_MESSAGES] ?? 'Could not connect that source.';
    return reply.code(STATUS_CODE[r.error] ?? 409).send({ error: r.error, message });
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
   * the search's own finds (judgeCandidate) -- a client never names a pair that is saved on trust. Refused
   * with the reason, before any lookup, whenever a follow would be: posting order (409 `posting_order`), no
   * free slot, the primary or a source already followed.
   */
  app.post('/api/admin/link/items/:id/candidates', async (req, reply) => {
    const itemId = idOf((req.params as { id?: string }).id, reply);
    if (!itemId) return;
    const b = z.object({
      source: z.string().min(1).max(128),
      sourceSeriesId: z.string().min(1).max(512),
      cover: z.string().max(2048).nullish(),
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const item = await one<{ id: string; batch_id: string; series_id: string }>('SELECT id, batch_id, series_id FROM link_items WHERE id = $1', [itemId]);
    if (!item) return reply.code(404).send({ error: 'not_found' });
    const j = await judgeManualPick(item.series_id, b.data);
    if ('error' in j) {
      return reply.code(STATUS_CODE[j.error] ?? 409).send({ error: j.error, message: PICK_MESSAGES[j.error], theirTitle: j.theirTitle ?? null });
    }
    const row = await saveCandidate(item.id, j, true);
    await q('UPDATE link_batches SET updated_at = now() WHERE id = $1', [item.batch_id]).catch(() => {});
    return { ok: true, candidate: row ? { ...row, name: sourceName(row.source) } : null };
  });

  /**
   * The chapters a source lists for a candidate, beside the series' own: what an admin looks at before
   * confirming a link by hand. One copy per number under the series' release preferences -- the copy the
   * sweep would take -- each marked `ours` when the series already has that number, plus the numbers the
   * series has and this source does not. Read through the add dialog's detail cache (ten minutes), so
   * opening it twice asks the source once.
   */
  app.get('/api/admin/link/items/:id/chapters', async (req, reply) => {
    const itemId = idOf((req.params as { id?: string }).id, reply);
    if (!itemId) return;
    const b = z.object({ source: z.string().min(1).max(128), sourceSeriesId: z.string().min(1).max(512) }).safeParse(req.query);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const item = await one<{ series_id: string }>('SELECT series_id FROM link_items WHERE id = $1', [itemId]);
    if (!item) return reply.code(404).send({ error: 'not_found' });
    const src = getSource(b.data.source);
    if (!src) return reply.code(409).send({ error: 'unknown_source', message: 'That source is not installed.' });
    const { series, chapters } = await seriesAndChapters(src, b.data.sourceSeriesId);
    if (!series && !chapters.length) return reply.code(502).send({ error: 'unreachable', message: 'That source did not answer. Try again in a moment.' });
    const prefs = await effectivePrefsFor(await readSeriesPrefs(item.series_id), 0);
    const releases = chooseReleases(chapters, prefs).releases.sort((a, c) => a.number - c.number);
    const ours = await ourNumbers(item.series_id);
    // Compared at three decimals: a real column round-trips 12.1 as 12.100000381469727 on one side only.
    const key = (n: number) => Math.round(n * 1000);
    const mine = new Set(ours.map(key));
    const theirs = new Set(releases.map((c) => key(c.number)));
    return {
      source: src.id, name: src.name, title: series?.title ?? null,
      count: releases.length, ourCount: ours.length,
      shared: releases.filter((c) => mine.has(key(c.number))).length,
      missing: ours.filter((n) => !theirs.has(key(n))).sort((a, c) => a - c),
      chapters: releases.slice(0, 3000).map((c) => ({
        number: c.number, title: c.title ?? null, scanlator: c.scanlator ?? null, publishedAt: c.publishedAt ?? null, ours: mine.has(key(c.number)),
      })),
    };
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
