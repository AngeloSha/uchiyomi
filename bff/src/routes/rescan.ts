/**
 * Rescan everything's routes (v0.55.4, discussion #150; lib/rescan.ts): where the Tasks panel reads a preview as it
 * runs and the plan it ends with, and where it applies that plan. The preview itself starts like every task, from
 * POST /api/admin/tasks/rescan/run (routes/admin.ts), and answers `started`.
 *
 * Registered from inside routes/admin.ts, after its `authenticate` + `requireAdmin` hooks, so every route here is
 * admin-only structurally -- an API token needs the admin scope too -- and none of them can forget it.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { q } from '../lib/db';
import { userIdOf, roleOf } from '../lib/auth';
import { browsableIds, viewCtxFor, hideAdult } from '../lib/visibility';
import { lastApplied, planView, rescanState, startApply } from '../lib/rescan';

/** Entries each of the plan's lists carries at most; its counts are always whole. */
const LIST_MAX = 200;

/**
 * Which of these series this admin may see named: the plan's lists are a listing, so they follow the repair status'
 * rule (routes/admin.ts `listable`) -- the count stays, a series the viewer may not list (the 18+ hide, above all)
 * is not named. One query, and none when there is nothing to ask.
 */
async function listable(req: FastifyRequest, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  return browsableIds(ids, await viewCtxFor(userIdOf(req), roleOf(req), { hideAdult: hideAdult(req) }));
}

/** Each series' title as the library shows it, the admin's own title first. */
async function titles(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await q<{ id: string; title: string }>(
    `SELECT s.id, COALESCE(o.title, s.title) AS title FROM lib_series s LEFT JOIN series_overrides o ON o.series_id = s.id
      WHERE s.id = ANY($1)`, [ids]);
  return new Map(rows.map((r) => [r.id, r.title]));
}

export default async function rescanRoutes(app: FastifyInstance) {
  /**
   * The rescan, live and planned: `running` ('preview' | 'apply' | null), the `phase` it is in ('scan', 'look' and
   * 'pair' for a preview, 'mark' for an Apply) with `done` of `of`, the newest `plan` -- its counts, and its lists by
   * series with titles -- and the `last` Apply with `lastRun`. Polled by the Tasks panel every two seconds while a run
   * is going; the plan is memory, so it costs a title lookup and nothing that grows with the library.
   */
  app.get('/api/admin/tasks/rescan/status', async (req) => {
    const s = rescanState;
    let plan = null;
    if (s.plan) {
      const v = planView(s.plan);
      const ids = [...new Set([...v.emptiedList.map((e) => e.seriesId), ...v.movedList.flatMap((m) => [m.seriesId, m.to.seriesId])])];
      const [ok, named] = await Promise.all([listable(req, ids), titles(ids)]);
      plan = {
        ...v,
        emptiedList: v.emptiedList.filter((e) => ok.has(e.seriesId)).slice(0, LIST_MAX)
          .map((e) => ({ ...e, title: named.get(e.seriesId) ?? '' })),
        // A pair is named when both of its series may be: the moved file's new series is a title too.
        movedList: v.movedList.filter((m) => ok.has(m.seriesId) && ok.has(m.to.seriesId)).slice(0, LIST_MAX)
          .map((m) => ({ ...m, title: named.get(m.seriesId) ?? '', to: { ...m.to, title: named.get(m.to.seriesId) ?? '' } })),
      };
    }
    const last = await lastApplied();
    return {
      running: s.running,
      phase: s.phase,
      done: s.done,
      of: s.of,
      startedAt: s.running ? s.startedAt : null,
      error: s.error,
      plan,
      last: last.result,
      lastRun: last.at,
    };
  });

  /**
   * Apply the plan the admin saw (`plan`, its id). Detached like the preview -- it stats every planned file again --
   * so it answers {ok: true, started: true}, or {ok: false, error} when it may not start: `busy` (a preview or an
   * Apply is running), `no_plan`, `stale` (a newer preview replaced it, or it is older than 30 minutes), `applied`,
   * or the job it would run beside: `sweep_running`, `autofix_running`, `repair_running`, `verify_running`,
   * `cleanup_running`, `scan_running`. Its result lands on the status route's `last` and the Tasks row.
   */
  app.post('/api/admin/tasks/rescan/apply', async (req, reply) => {
    const b = z.object({ plan: z.string().uuid() }).safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: b.error.issues[0]?.message ?? 'Bad body' });
    const r = startApply(b.data, { userId: userIdOf(req) ?? null, req, log: app.log });
    if (!r.ok) return { ok: false, error: r.error };
    r.run.catch(() => {}); // startApply logs it and records the failure; this only stops an unhandled rejection
    return { ok: true, started: true };
  });
}
