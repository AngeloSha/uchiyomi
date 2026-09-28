/**
 * #116's admin routes: an extension's own settings, and the per-series numbering plan an admin confirms.
 *
 * Registered from inside routes/admin.ts, after its `authenticate` + `requireAdmin` hooks, so every route here
 * is admin-only structurally -- an API token needs the admin scope too -- and none of them can forget it.
 *
 * Extension settings (Admin → Extensions → Settings): the preference screen Mihon shows for a source, read and
 * written through the engine (lib/sources/suwayomi/prefs.ts). ⚠️ A write names the preference by KEY; the engine
 * addresses it by position, and prefs.ts resolves the position on a fresh read at the moment of writing. A
 * change to a preference that renumbers the source's chapters queues a remap on every series of that source that
 * uses the source's numbers (`numbering_pending = 'remap'`): their files are about to name other posts, and the
 * owner's rule for v0.49.0 holds -- nothing in a library is renamed until an admin has seen the plan.
 *
 * Numbering (the series page's notice and sheet, and Health): the plan a numbering change would carry out, from
 * a fresh listing and changing nothing, and the change itself, which is only ever carried out with `confirm`.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { q, one } from '../lib/db';
import { userIdOf } from '../lib/auth';
import { logAudit } from '../lib/audit';
import { visibleToAll } from '../lib/visibility';
import { suwayomiConfigured, swAdapterId } from '../lib/sources';
import { readSourcePrefs, writeSourcePref, PrefError, type SourcePref } from '../lib/sources/suwayomi/prefs';
import { folderBusy, numberingSummary, planFor, requestNumbering } from '../lib/numbering';
import { runsInside } from '../lib/updater';
import type { RenumberMode } from '../lib/postingOrder';
import { say, saidOf, type Part } from '../lib/said';
import { clearDetailCacheFor } from './sources';

/** Mihon source ids are 64-bit integers (the engine's LongString); anything else is not a source id. */
const SOURCE_ID = /^-?\d{1,20}$/;

/** How long a confirmed renumber may run inside the request before it is answered `pending` and left to finish. */
const APPLY_BUDGET_MS = 60_000;

/**
 * A refusal's body: its code, its sentence, and the sentence's code with what fills it (v0.49.1, lib/said.ts), so
 * the page says it in the reader's language where it used to print the English.
 */
const refusal = (error: string, said: Part) => ({ error, message: said.text, messageSaid: saidOf(said) });

const notConfigured = (reply: FastifyReply) => reply.code(400).send(refusal('not_configured', say('pref.notConfigured')));

/**
 * The engine's answer to `source(id)` for an id it does not have is graphql-java's "declared as a non null type"
 * error with no data (measured, v2.3.2243): that is a 404, not the engine being down.
 *
 * An engine that ANSWERED, with the extension's own exception (gql's `suwayomi: <message>`, lib/sources/suwayomi/
 * client.ts), is `extension_error` with the first line of it: the misattribution #115 exists to fix -- "the
 * extension server did not answer" over an engine that did, sending an admin to restart a healthy container.
 * `unreachable` is kept for the engine not answering at all. Reintroduce the one 502: "an extension's own
 * exception is not the engine being down" in extensionPrefs.int.test.ts reads unreachable.
 */
const engineFailure = (reply: FastifyReply, e: unknown) => {
  const msg = (e as Error)?.message || '';
  if (/non null type|NullPointerException/i.test(msg)) return reply.code(404).send(refusal('unknown_source', say('pref.unknownSource')));
  if (msg.startsWith('suwayomi: ')) {
    // The first line, without graphql-java's "Exception while fetching data (/source/preferences) : " in front.
    const said = msg.slice('suwayomi: '.length).split('\n')[0].replace(/^Exception while fetching data \([^)]*\) : /, '').trim().slice(0, 300);
    return reply.code(502).send(refusal('extension_error', say('pref.extensionFailed', { error: said })));
  }
  return reply.code(502).send(refusal('unreachable', say('pref.unreachable')));
};

/** A preference as the settings sheet gets it: no position -- nothing a client sends is ever addressed by one. */
const wire = ({ position: _position, ...p }: SourcePref) => p;

/** How many visible series come from one source, and how many of them a numbering change would renumber. */
async function usage(adapterId: string): Promise<{ usedBy: number; renumbers: number }> {
  const r = await one<{ used: number; renumbers: number }>(
    `SELECT count(*)::int AS used,
            count(*) FILTER (WHERE s.numbering IS DISTINCT FROM 'posting_order')::int AS renumbers
       FROM lib_series s WHERE s.source_id = $1 AND ${visibleToAll('s')}`, [adapterId]);
  return { usedBy: r?.used ?? 0, renumbers: r?.renumbers ?? 0 };
}

export default async function numberingRoutes(app: FastifyInstance) {
  // ---- an extension's own settings ----

  app.get('/api/admin/extensions/sources/:id/preferences', async (req, reply) => {
    if (!suwayomiConfigured()) return notConfigured(reply);
    const { id } = req.params as { id: string };
    if (!SOURCE_ID.test(id)) return reply.code(400).send({ error: 'bad_request' });
    let prefs;
    try {
      prefs = await readSourcePrefs(id);
    } catch (e) {
      return engineFailure(reply, e);
    }
    return { ...prefs, preferences: prefs.preferences.map(wire), ...(await usage(swAdapterId(id))) };
  });

  const prefBody = z.object({
    key: z.string().min(1).max(256),
    value: z.union([z.boolean(), z.string().max(4096), z.array(z.string().max(512)).max(200)]),
  });
  app.post('/api/admin/extensions/sources/:id/preferences', async (req, reply) => {
    if (!suwayomiConfigured()) return notConfigured(reply);
    const { id } = req.params as { id: string };
    const b = prefBody.safeParse(req.body);
    if (!SOURCE_ID.test(id) || !b.success) return reply.code(400).send({ error: 'bad_request' });
    let w;
    try {
      w = await writeSourcePref(id, b.data.key, b.data.value);
    } catch (e) {
      if (e instanceof PrefError) return reply.code(400).send(refusal(e.code, e.said));
      return engineFailure(reply, e);
    }
    const adapterId = swAdapterId(id);
    let remap = 0;
    if (w.changed) {
      // Every cached chapter list of this source was counted under the old setting: the add dialog would go on
      // showing the old numbers for ten minutes.
      clearDetailCacheFor(adapterId);
      // Only a setting the engine really took moves the numbers: a write it answered but did not apply (the value
      // read back is the old one) queued a remap on every series of the source for nothing, each held until an
      // admin confirmed it (#116 review). Reintroduce by dropping `w.applied`: "a numbering setting the engine did
      // not take queues nothing" in extensionPrefs.int.test.ts finds the series marked ("asked, and not taken").
      if (w.before.numbering && w.applied) {
        // The source's numbers move under every series that uses them. Posting-order series keep theirs: their
        // numbers are the posts' own, and a post keeps its id whatever the extension calls it. Reintroduce by
        // dropping this UPDATE: "a numbering setting queues a remap" in extensionPrefs.int.test.ts finds the
        // series unmarked.
        const marked = await q<{ id: string }>(
          `UPDATE lib_series s SET numbering_pending = 'remap'
            WHERE s.source_id = $1 AND s.numbering IS DISTINCT FROM 'posting_order' AND ${visibleToAll('s')}
            RETURNING s.id`, [adapterId]);
        remap = marked.length;
      }
      // ⚠️ Never the text of an EditText in the log: extensions keep logins, API keys and private base URLs
      // there. Its length says a change happened; the other kinds are choices the extension itself offers.
      const shown = (v: unknown) => (w.before.type === 'text' ? { length: typeof v === 'string' ? v.length : 0 } : v);
      await logAudit('source.extension_pref', {
        userId: userIdOf(req), req,
        detail: { source: id, key: w.before.key, title: w.before.title, from: shown(w.before.value), to: shown(b.data.value), numbering: w.before.numbering, remap },
      });
    }
    return { ok: true, changed: w.changed, applied: w.applied, remap, preferences: w.preferences.map(wire), ...(await usage(adapterId)) };
  });

  // ---- one series' numbering ----

  const modes = ['posting_order', 'source', 'remap'] as const;
  app.get('/api/admin/series/:id/numbering', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { mode: asked } = req.query as { mode?: string };
    if (asked !== undefined && !(modes as readonly string[]).includes(asked)) return reply.code(400).send({ error: 'bad_request' });
    const s = await one<{ numbering: string | null; numbering_pending: RenumberMode | null }>(
      `SELECT s.numbering, s.numbering_pending FROM lib_series s WHERE s.id = $1 AND ${visibleToAll('s')}`, [id]);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    // What the page would ask about: the change waiting for review, else the other numbering.
    const mode: RenumberMode = (asked as RenumberMode | undefined) ?? s.numbering_pending ?? (s.numbering === 'posting_order' ? 'source' : 'posting_order');
    const p = await planFor(id, mode).catch(() => null);
    if (!p) return reply.code(502).send(refusal('unreachable', say('renumber.unreachable')));
    return { mode, plan: p.plan, tracker: p.tracker, numbering: await numberingSummary(id) };
  });

  const numberingBody = z.object({
    mode: z.enum(['auto', 'source', 'posting_order', 'remap']),
    confirm: z.boolean().optional(),
  });
  app.post('/api/admin/series/:id/numbering', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = numberingBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const s = await one<{ folder: string }>(`SELECT s.folder FROM lib_series s WHERE s.id = $1 AND ${visibleToAll('s')}`, [id]);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    // A rename under a download writing into the folder would race the file it is writing; say so now rather
    // than answer `pending` for a reason the page cannot show.
    if (b.data.confirm && folderBusy(s.folder)) return reply.code(409).send(refusal('busy', say('renumber.downloading')));
    // The same for a run inside the series that is not downloading yet -- the sweep or a check reading its listing:
    // it would fetch into the old numbers after the renames (#116 review). Reintroduce by dropping it: "a renumber
    // waits for a check inside the series" in numberingRoutes.int.test.ts is answered 200 `pending`, not 409.
    if (b.data.confirm && runsInside(id) > 0) return reply.code(409).send(refusal('busy', say('renumber.checking')));
    const work = requestNumbering(id, b.data.mode, { confirm: b.data.confirm, userId: userIdOf(req) });
    // A confirmed apply lists the source and renames every file; a slow source must not turn into a proxy
    // timeout that reads as a failure while the rename carries on. Past the budget it is `pending`, and the page
    // reads the outcome off the series.
    // (Not lib/sources withTimeout: its timer outlives the race, and this one would hold a test run open a minute.)
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<{ state: 'pending'; running: true }>((res) => { timer = setTimeout(() => res({ state: 'pending', running: true }), APPLY_BUDGET_MS); });
    const r = await Promise.race([work, late]).finally(() => clearTimeout(timer));
    // What happens to it after the answer is logged, not thrown into nothing.
    work.catch((e) => console.warn(`[numbering] ${id}: ${(e as Error)?.message || e}`));
    if (!r) return reply.code(404).send({ error: 'not_found' });
    return { ...r, numbering: await numberingSummary(id) };
  });
}
