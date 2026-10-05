/**
 * Rescan everything's routes (v0.55.4, discussion #150; lib/rescan.ts): where the Tasks panel reads a preview as it
 * runs and the plan it ends with. The preview itself starts like every task, from POST /api/admin/tasks/rescan/run
 * (routes/admin.ts), and answers `started`.
 *
 * Registered from inside routes/admin.ts, after its `authenticate` + `requireAdmin` hooks, so every route here is
 * admin-only structurally -- an API token needs the admin scope too -- and none of them can forget it.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { q } from '../lib/db';
import { userIdOf, roleOf } from '../lib/auth';
import { browsableIds, viewCtxFor, hideAdult } from '../lib/visibility';
import { planView, rescanState } from '../lib/rescan';

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
   * The rescan, live and planned: `running` ('preview' | null), the `phase` it is in ('scan', then 'look' and 'pair')
   * with `done` of `of`, and the newest `plan` -- its counts, and its lists by series with titles. Polled by the Tasks
   * panel every two seconds while a run is going; the plan is memory, so it costs a title lookup and nothing that
   * grows with the library.
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
    return {
      running: s.running,
      phase: s.phase,
      done: s.done,
      of: s.of,
      startedAt: s.running ? s.startedAt : null,
      error: s.error,
      plan,
    };
  });
}
