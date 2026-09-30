/**
 * The admin routes of the other names a series goes by (lib/altTitles.ts) and of Find other sources
 * (lib/findSources.ts): a search that proposes, a review, and the follows an admin confirms. The idea, the review,
 * the name list and the name parsing are @TIGamingTV's (PR #119).
 *
 * Registered from inside routes/admin.ts, after its `authenticate` + `requireAdmin` hooks, so every route here is
 * admin-only structurally -- an API token needs the admin scope too -- and none of them can forget it.
 *
 * Server text stays English; the web words the codes (`too_short`, `non_latin`, `exists`, `busy`, `empty_scope`,
 * `too_many`, and every refusal of a follow or a pick in REFUSAL).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { q, one } from '../lib/db';
import { userIdOf, roleOf } from '../lib/auth';
import { logAudit } from '../lib/audit';
import { getSource } from '../lib/sources';
import { browsableIds, hideAdult, seriesVisible, viewCtxFor } from '../lib/visibility';
import { altTitleRows, recordAltTitles, refuseName, removeAltTitle, MAX_NAME_LEN } from '../lib/altTitles';
import { normTitle } from '../lib/titleMatch';
import { MAX_FOLLOWERS } from '../lib/autoFollow';
import { chooseReleases } from '../lib/releases';
import { effectivePrefsFor, readSeriesPrefs } from '../lib/scanlatorPrefs';
import { seriesAndChapters } from './sources';
import {
  claimFollow, closeStale, discardFind, findRun, findRunning, findState, followCandidates, followOne, isLinking,
  judgeManualPick, mayFollow, ourNumbers, resumeFind, saveCandidate, settleRun, startFind, stopFind,
  type CandidateRow, type FindScope,
} from '../lib/findSources';

const REFUSED: Record<string, string> = {
  too_short: 'A name needs at least five letters or digits to be matched.',
  non_latin: 'Only names written in Latin letters can be matched.',
};

/** Series one search may hold. */
const MAX_SERIES = 500;
/** Chapters the chapter list sends; the counts cover all of them. */
const MAX_CHAPTERS = 3000;
const uuid = z.string().uuid();
const sourceName = (id: string) => getSource(id)?.name ?? id;

/** What a refused follow or pick says, per code. English for API clients; the web words the code. */
const REFUSAL: Record<string, string> = {
  gone: 'That series is no longer in the library.',
  posting_order: 'This series is numbered by posting order, so no other source is followed for it.',
  full: 'This series already follows as many other sources as a series may.',
  cap: 'This series already follows as many other sources as a series may.',
  too_few: 'This series lists too few chapters to compare with another source.',
  already_followed: 'This series already reads from that source.',
  primary: 'That is already the series’ own source.',
  unknown_source: 'That source is not installed.',
  unavailable: 'That source is switched off or cooling down right now.',
  unreachable: 'That source did not answer. Try again in a moment.',
  title_differs: 'None of its names is one of this series’ names.',
  not_this_series: 'Its title only contains this series’ title, and its chapters do not line up: most likely a sequel or a spin-off.',
  changed: 'That source no longer lists it under a name of this series.',
  busy: 'This search is busy right now.',
  closed: 'That candidate was already dealt with.',
  not_found: 'That candidate is gone.',
};
const STATUS_CODE: Record<string, number> = { gone: 404, not_found: 404, unreachable: 502 };

/** The IP and user agent of a request, kept for an audit line written after the answer. */
const fromOf = (req: FastifyRequest) => {
  const h = req.headers;
  return { ip: req.ip, headers: { 'x-forwarded-for': h['x-forwarded-for'], 'user-agent': h['user-agent'] } } as unknown as FastifyRequest;
};

/** A candidate as the API sends it. */
const candidateOut = (c: CandidateRow) => ({
  id: c.id, itemId: c.item_id, source: c.source, name: sourceName(c.source), sourceSeriesId: c.source_series_id,
  theirTitle: c.their_title, cover: c.cover, ourName: c.our_name, theirName: c.their_name,
  coverageFwd: c.coverage_fwd == null ? null : Number(c.coverage_fwd),
  coverageBack: c.coverage_back == null ? null : Number(c.coverage_back),
  verdict: c.verdict, manual: c.manual, status: c.status,
});

/** A series' names as the admin reads them: who added one by name, never by account id. */
async function titlesOf(seriesId: string) {
  const rows = await altTitleRows(seriesId);
  const ids = [...new Set(rows.map((r) => r.added_by).filter((x): x is string => !!x))];
  const names = new Map((ids.length
    ? await q<{ id: string; username: string | null }>('SELECT id::text AS id, username FROM users WHERE id::text = ANY($1)', [ids])
    : []).map((u) => [u.id, u.username]));
  return rows.map((r) => ({
    title: r.title,
    // The key DELETE takes. The web can derive it (web/lib/normTitle.ts is the same rule), but naming it here means
    // it never has to.
    norm: r.norm,
    origin: r.origin,
    addedBy: r.added_by ? names.get(r.added_by) ?? null : null,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

/**
 * Which of these series this admin may see NAMED: a run's results are a listing, so they follow the rule of
 * /api/sources/jobs' "now on …" and the repair's answers -- the entry stays, the title of a series the viewer may
 * not list (the 18+ hide, above all) goes.
 */
async function listable(req: FastifyRequest, ids: Array<string | undefined>): Promise<Set<string>> {
  const list = ids.filter((x): x is string => !!x);
  if (!list.length) return new Set();
  return browsableIds(list, await viewCtxFor(userIdOf(req), roleOf(req), { hideAdult: hideAdult(req) }));
}

export default async function findSourcesRoutes(app: FastifyInstance) {
  // ---- other names ----

  app.get('/api/admin/series/:id/alt-titles', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await seriesVisible(id, await viewCtxFor(userIdOf(req), roleOf(req))))) return reply.code(404).send({ error: 'not_found' });
    return { titles: await titlesOf(id) };
  });

  /**
   * Add a name by hand. Refused before anything is written: `non_latin` (a name in another script normalises to
   * nothing and can never be compared), `too_short` (a key under five characters is a word, not an identity), and
   * `exists` (the series already goes by it -- stored, or its own title). A name removed earlier is the admin's to
   * bring back: typed again, it returns as their own.
   */
  app.post('/api/admin/series/:id/alt-titles', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ title: z.string().trim().min(1).max(MAX_NAME_LEN) }).safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: `A name of 1 to ${MAX_NAME_LEN} characters.` });
    if (!(await seriesVisible(id, await viewCtxFor(userIdOf(req), roleOf(req))))) return reply.code(404).send({ error: 'not_found' });
    const title = b.data.title;
    const refusal = refuseName(title);
    if (refusal) return reply.code(400).send({ error: refusal, message: REFUSED[refusal] });
    // recordAltTitles writes nothing for a key the series already has (unless it was removed), or for its own title:
    // both are `exists`.
    const written = await recordAltTitles(id, [title], 'admin', { userId: userIdOf(req) });
    if (!written.length) return reply.code(409).send({ error: 'exists', message: 'The series already goes by that name.' });
    await logAudit('series.alt_title.add', { userId: userIdOf(req), detail: { id, title, norm: normTitle(title) }, req });
    return { titles: await titlesOf(id) };
  });

  /**
   * Forget one name, by its key. It stays removed when the source's details are read again, whatever its origin (kept
   * as a tombstone, lib/altTitles.ts removeAltTitle); typed again by hand, it returns as the admin's own. Idempotent:
   * a key the series does not have answers the list as it is.
   */
  app.delete('/api/admin/series/:id/alt-titles/:norm', async (req, reply) => {
    const { id, norm } = req.params as { id: string; norm: string };
    if (!(await seriesVisible(id, await viewCtxFor(userIdOf(req), roleOf(req))))) return reply.code(404).send({ error: 'not_found' });
    await removeAltTitle(id, norm);
    await logAudit('series.alt_title.remove', { userId: userIdOf(req), detail: { id, norm }, req });
    return { titles: await titlesOf(id) };
  });

  // ---- Find other sources ----

  /** A path id that is not a uuid is a run that does not exist: 404, never a 500 from Postgres (22P02). */
  const idOf = (raw: unknown, reply: FastifyReply): string | null => {
    const p = uuid.safeParse(raw);
    if (!p.success) { reply.code(404).send({ error: 'not_found' }); return null; }
    return p.data;
  };

  /**
   * Start a run over the series named, or over every series whose MAIN source is `sourceId` (the "this source is
   * down" case Health's button sends). It searches and proposes; nothing is followed until an admin confirms it on
   * the run's review. One search at a time: 409 `busy` with the searching run's id. 400 `empty_scope` when nothing
   * named is a series this admin may see, `too_many` over 500 series. 202 with the run's id, how many series it
   * holds and how many of them it skips unsearched (posting order, or no free follower slot).
   */
  app.post('/api/admin/sources/find', async (req, reply) => {
    const b = z.object({
      seriesIds: z.array(z.string().min(1).max(64)).optional(),
      sourceId: z.string().min(1).max(200).optional(),
    }).strict().safeParse(req.body ?? {});
    if (!b.success || (b.data.seriesIds && b.data.sourceId)) {
      return reply.code(400).send({ error: 'bad_request', message: 'Name the series ({seriesIds}) or one source ({sourceId}).' });
    }
    if (b.data.seriesIds && b.data.seriesIds.length > MAX_SERIES) {
      return reply.code(400).send({ error: 'too_many', message: `At most ${MAX_SERIES} series in one search.` });
    }
    const scope: FindScope = b.data.sourceId ? { sourceId: b.data.sourceId } : { seriesIds: b.data.seriesIds ?? [] };
    if ('seriesIds' in scope && !scope.seriesIds.length) return reply.code(400).send({ error: 'empty_scope', message: 'No series were named.' });
    // The audit line is written when the search ends, long after this answer; the two things logAudit reads of a
    // request, its IP and user agent, are taken now (POST /api/admin/sources/check does the same).
    const r = await startFind(scope, userIdOf(req)!, await viewCtxFor(userIdOf(req), roleOf(req)), fromOf(req));
    if ('busy' in r) return reply.code(409).send({ error: 'busy', runId: r.busy, message: 'Another search for other sources is running.' });
    if ('empty' in r) return reply.code(400).send({ error: 'empty_scope', message: 'None of those series can be searched for.' });
    return reply.code(202).send(r);
  });

  /**
   * Whether a run is searching, the searching run (or else the newest), and the kept runs, newest first. The series
   * the searching run is on is left out for a series this admin may not list.
   */
  app.get('/api/admin/sources/find', async (req) => {
    const st = await findState();
    const cur = st.run?.current;
    if (!st.run || !cur) return st;
    const ok = await listable(req, [cur.seriesId]);
    if (ok.has(cur.seriesId)) return st;
    const { current: _drop, ...run } = st.run;
    return { ...st, run };
  });

  /** Stop the searching run at once. What it found stays; the run can be resumed. `stopped` is false when none was searching. */
  app.post('/api/admin/sources/find/stop', async (req) => {
    const stopped = stopFind();
    if (stopped) await logAudit('source.find.stop', { userId: userIdOf(req), req });
    return { stopped };
  });

  /**
   * One run's review: every series it holds, what each follows now, and what the search found for it. Open
   * candidates whose source was followed meanwhile (here, from the Sources sheet, by the hunt) are closed first. A
   * series this admin may not list (the 18+ hide) is left out and counted in `hidden`.
   */
  app.get('/api/admin/sources/find/:id', async (req, reply) => {
    const id = idOf((req.params as { id?: string }).id, reply);
    if (!id) return;
    const r = await findRun(id);
    if (!r) return reply.code(404).send({ error: 'not_found' });
    const ids = r.items.map((i) => i.series_id);
    const ok = await listable(req, ids);
    const items = r.items.filter((i) => ok.has(i.series_id));
    const primaries = await q<{ id: string; source_id: string | null }>('SELECT id, source_id FROM lib_series WHERE id = ANY($1::text[])', [ids]);
    const follows = await q<{ series_id: string; source_id: string }>(
      'SELECT series_id, source_id FROM series_sources WHERE series_id = ANY($1::text[]) ORDER BY created_at', [ids]);
    const primaryOf = new Map(primaries.map((p) => [p.id, p.source_id]));
    const { current, ...run } = r.run;
    return {
      run: { ...run, ...(current && ok.has(current.seriesId) ? { current } : {}), maxFollowers: MAX_FOLLOWERS },
      hidden: r.items.length - items.length,
      items: items.map((it) => {
        const primary = primaryOf.get(it.series_id) ?? null;
        const following = follows.filter((f) => f.series_id === it.series_id && f.source_id !== primary)
          .map((f) => ({ source: f.source_id, name: sourceName(f.source_id) }));
        return {
          id: it.id, seriesId: it.series_id, title: it.title, names: it.names, state: it.state, note: it.note,
          asked: it.asked, unreachable: it.unreachable,
          primary: primary ? { source: primary, name: sourceName(primary) } : null,
          following,
          freeSlots: Math.max(0, MAX_FOLLOWERS - following.length),
          candidates: r.candidates.filter((c) => c.item_id === it.id).map(candidateOut),
        };
      }),
    };
  });

  /** Search on from where a stopped or interrupted run left off. 409 `busy` while another run searches or this one follows. */
  app.post('/api/admin/sources/find/:id/resume', async (req, reply) => {
    const id = idOf((req.params as { id?: string }).id, reply);
    if (!id) return;
    const r = await resumeFind(id, userIdOf(req)!, fromOf(req));
    if (r === 'not_found') return reply.code(404).send({ error: 'not_found' });
    if (r === 'busy') return reply.code(409).send({ error: 'busy', message: 'Another search for other sources is running.' });
    if (r === 'not_resumable') return reply.code(409).send({ error: 'not_resumable', message: 'Every series of this search has been searched.' });
    return reply.code(202).send({ ok: true });
  });

  /**
   * Follow the chosen candidates. Only `ok` ones are followed -- what autoFollow's judgeCandidate would follow
   * itself; there is no bulk override. Anything else sent is left open and counted in `held`: a `numbering_differs`
   * candidate is followed one at a time, from its chapter list (POST /api/admin/sources/find/candidates/:id/follow).
   * Every follow is insert-only under the follower cap.
   */
  app.post('/api/admin/sources/find/:id/follow', async (req, reply) => {
    const id = idOf((req.params as { id?: string }).id, reply);
    if (!id) return;
    const b = z.object({ candidateIds: z.array(z.string().uuid()).min(1).max(1500) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const run = await one<{ status: string }>('SELECT status FROM source_find_runs WHERE id = $1', [id]);
    if (!run) return reply.code(404).send({ error: 'not_found' });
    if (run.status === 'running' || findRunning() === id) {
      return reply.code(409).send({ error: 'still_searching', message: 'Stop the search, or wait for it to finish, first.' });
    }
    await closeStale(id).catch(() => {});
    const rows = await q<CandidateRow & { series_id: string; series_title: string }>(
      `SELECT c.*, i.series_id, i.title AS series_title FROM source_find_candidates c JOIN source_find_items i ON i.id = c.item_id
        WHERE i.run_id = $1 AND c.status IS NULL AND c.id = ANY($2::uuid[]) ORDER BY i.ord, c.source`,
      [id, b.data.candidateIds]);
    const runnable = rows.filter((r) => mayFollow(r));
    const held = rows.length - runnable.length;
    if (!runnable.length) {
      return reply.code(rows.length ? 409 : 400).send(rows.length
        ? { error: 'not_followable', message: 'The chapters of what you selected do not line up. Open its chapters to follow one on its own.' }
        : { error: 'nothing_to_follow', message: 'Nothing selected is waiting to be followed.' });
    }
    if (!(await claimFollow(id))) return reply.code(409).send({ error: 'busy', message: 'This search is already following sources.' });
    const userId = userIdOf(req)!;
    await logAudit('source.find.follow', { userId, req, detail: { runId: id, count: runnable.length, held } });
    void followCandidates(id, runnable, userId).catch(() => {});
    return { ok: true, total: runnable.length, held, ids: runnable.map((r) => r.id) };
  });

  /**
   * Follow ONE candidate, from its chapter list: the only way a candidate whose name matches but whose chapter numbers
   * do not line up is ever followed, and only with `confirm: true`. Judged again first; the audit line says it was an
   * override when it is not `ok`.
   */
  app.post('/api/admin/sources/find/candidates/:id/follow', async (req, reply) => {
    const cid = idOf((req.params as { id?: string }).id, reply);
    if (!cid) return;
    const b = z.object({ confirm: z.literal(true) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'Confirm to follow this source.' });
    const r = await followOne(cid, userIdOf(req)!);
    if (r.ok) return { ok: true };
    return reply.code(STATUS_CODE[r.error] ?? 409).send({ error: r.error, message: REFUSAL[r.error] ?? 'Could not follow that source.' });
  });

  /** Forget a run (its search stops first). 409 `busy` while it follows. */
  app.delete('/api/admin/sources/find/:id', async (req, reply) => {
    const id = idOf((req.params as { id?: string }).id, reply);
    if (!id) return;
    if (isLinking(id)) return reply.code(409).send({ error: 'busy', message: 'This search is following sources right now.' });
    if (await discardFind(id)) await logAudit('source.find.discard', { userId: userIdOf(req), detail: { runId: id }, req });
    return { ok: true };
  });

  /**
   * A candidate the admin found themselves, in the search sheet. Judged on the server by the same rule as the search's
   * own finds (judgeCandidate) -- a client never names a pair that is saved on trust -- and refused with its code
   * before any lookup whenever a follow would be: `posting_order`, `full`, `already_followed` (its main source or one
   * it follows), `too_few`.
   */
  app.post('/api/admin/sources/find/items/:id/candidates', async (req, reply) => {
    const itemId = idOf((req.params as { id?: string }).id, reply);
    if (!itemId) return;
    const b = z.object({
      source: z.string().min(1).max(200),
      sourceSeriesId: z.string().min(1).max(512),
      cover: z.string().max(2048).nullish(),
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const item = await one<{ id: string; run_id: string; series_id: string }>('SELECT id, run_id, series_id FROM source_find_items WHERE id = $1', [itemId]);
    if (!item) return reply.code(404).send({ error: 'not_found' });
    const j = await judgeManualPick(item.series_id, b.data);
    if ('error' in j) {
      return reply.code(STATUS_CODE[j.error] ?? 409).send({ error: j.error, message: REFUSAL[j.error], theirTitle: j.theirTitle ?? null });
    }
    const row = await saveCandidate(item.id, j, true);
    await settleRun(item.run_id).catch(() => {});
    return { candidate: row ? candidateOut(row) : null };
  });

  /**
   * The chapters a source lists for a candidate, beside the series' own: what an admin looks at before following one.
   * One copy per number under the series' release preferences -- the copy the sweep would take -- each marked `ours`
   * when the series already has that number, plus the numbers the series has and this source does not. Read through
   * the add dialog's detail cache, so opening it twice asks the source once.
   */
  app.get('/api/admin/sources/find/items/:id/chapters', async (req, reply) => {
    const itemId = idOf((req.params as { id?: string }).id, reply);
    if (!itemId) return;
    const b = z.object({ source: z.string().min(1).max(200), sourceSeriesId: z.string().min(1).max(512) }).safeParse(req.query);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const item = await one<{ series_id: string }>('SELECT series_id FROM source_find_items WHERE id = $1', [itemId]);
    if (!item) return reply.code(404).send({ error: 'not_found' });
    const src = getSource(b.data.source);
    if (!src) return reply.code(409).send({ error: 'unknown_source', message: REFUSAL.unknown_source });
    const { series, chapters } = await seriesAndChapters(src, b.data.sourceSeriesId);
    if (!series && !chapters.length) return reply.code(502).send({ error: 'unreachable', message: REFUSAL.unreachable });
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
      chapters: releases.slice(0, MAX_CHAPTERS).map((c) => ({
        number: c.number, title: c.title ?? null, scanlator: c.scanlator ?? null, publishedAt: c.publishedAt ?? null, ours: mine.has(key(c.number)),
      })),
    };
  });
}
