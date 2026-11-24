/**
 * A source pack's settings, over HTTP: the screen Admin → Sources draws for `SourceAdapter.preferences`.
 *
 * Registered from routes/admin.ts, after its `authenticate` + `requireAdmin` hooks, so every route here is
 * admin-only structurally. A pack has no engine, so unlike `/api/admin/extensions/sources/:id/preferences` nothing
 * is read from or written to one: the declarations come from the loaded adapter and the values live in
 * `source_settings` (lib/sourceSettings.ts). A write is addressed by key, and the pack reads the stored layer
 * through `SourceHost.settings` on its next request -- no reload.
 *
 * A secret is stored sealed and answered as `set: true` with no value. A numbering setting queues the same review
 * as an extension's, for the day a pack declares one.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, one } from '../lib/db';
import { userIdOf } from '../lib/auth';
import { logAudit } from '../lib/audit';
import { visibleToAll } from '../lib/visibility';
import { getSource, isSwAdapterId } from '../lib/sources';
import { clearSourceSetting, readSourceSettings, writeSourceSetting } from '../lib/sourceSettings';
import { SettingError, wireSetting } from '../lib/sources/preferences';
import { say, saidOf, type Part } from '../lib/said';
import { clearDetailCacheFor } from './sources';

/** A pack id is a name (`hentaiyi-en`), never an extension's `sw:<id>`: those keep their own route. */
const SOURCE_ID = /^[^\s<>"/]{1,200}$/;

const refusal = (error: string, said: Part) => ({ error, message: said.text, messageSaid: saidOf(said) });

/** How many visible series come from one source, and how many a numbering change would renumber. */
async function usage(adapterId: string): Promise<{ usedBy: number; renumbers: number }> {
  const r = await one<{ used: number; renumbers: number }>(
    `SELECT count(*)::int AS used,
            count(*) FILTER (WHERE s.numbering IS DISTINCT FROM 'posting_order')::int AS renumbers
       FROM lib_series s WHERE s.source_id = $1 AND ${visibleToAll('s')}`, [adapterId]);
  return { usedBy: r?.used ?? 0, renumbers: r?.renumbers ?? 0 };
}

/** A numbering change moves the source's numbers under every series that uses them; posting order keeps its own. */
async function remapFor(adapterId: string): Promise<number> {
  const marked = await q<{ id: string }>(
    `UPDATE lib_series s SET numbering_pending = 'remap'
      WHERE s.source_id = $1 AND s.numbering IS DISTINCT FROM 'posting_order' AND ${visibleToAll('s')}
      RETURNING s.id`, [adapterId]);
  return marked.length;
}

export default async function sourceSettingsRoutes(app: FastifyInstance) {
  const sourceOf = (id: string) => (!isSwAdapterId(id) && SOURCE_ID.test(id) ? getSource(id) : null);

  app.get('/api/admin/sources/:id/preferences', async (req, reply) => {
    const { id } = req.params as { id: string };
    const src = sourceOf(id);
    if (!src) return reply.code(404).send({ error: 'unknown_source' });
    const prefs = src.preferences ?? [];
    const stored = await readSourceSettings(id, prefs);
    return {
      source: { id, name: src.name, lang: src.lang ?? null, pkgName: null, extensionName: null },
      siblings: [],
      preferences: prefs.map((p) => wireSetting(p, stored)),
      ...(await usage(id)),
    };
  });

  const body = z.object({
    key: z.string().min(1).max(128),
    value: z.union([z.boolean(), z.string().max(4096), z.array(z.string().max(512)).max(200)]),
  });

  app.post('/api/admin/sources/:id/preferences', async (req, reply) => {
    const { id } = req.params as { id: string };
    const src = sourceOf(id);
    if (!src) return reply.code(404).send({ error: 'unknown_source' });
    const b = body.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const pref = (src.preferences ?? []).find((p) => p.key === b.data.key);
    if (!pref) return reply.code(400).send(refusal('unknown_pref', say('setting.unknown')));

    const before = (await readSourceSettings(id, [pref])).values.get(pref.key) ?? null;
    let w;
    try {
      w = await writeSourceSetting(id, pref, b.data.value);
    } catch (e) {
      if (e instanceof SettingError) return reply.code(400).send(refusal(e.code, e.said));
      throw e;
    }

    let remap = 0;
    if (w.changed) {
      // Every cached chapter list of this source was counted under the old setting.
      clearDetailCacheFor(id);
      if (pref.numbering) remap = await remapFor(id);
      // Never a text value in the log: packs keep cookies, tokens and private base URLs there. Its length says a
      // change happened; the other kinds are choices the pack itself offered.
      const shown = (v: unknown) => (pref.secret || pref.type === 'text' ? { length: typeof v === 'string' ? v.length : 0 } : v);
      await logAudit('source.pack_pref', {
        userId: userIdOf(req), req,
        detail: { source: id, key: pref.key, title: pref.title, from: shown(before), to: shown(w.value), numbering: !!pref.numbering, remap },
      });
    }

    const stored = await readSourceSettings(id, src.preferences ?? []);
    return {
      ok: true, changed: w.changed, applied: true, remap,
      preferences: (src.preferences ?? []).map((p) => wireSetting(p, stored)),
      ...(await usage(id)),
    };
  });

  app.delete('/api/admin/sources/:id/preferences/:key', async (req, reply) => {
    const { id, key } = req.params as { id: string; key: string };
    const src = sourceOf(id);
    if (!src) return reply.code(404).send({ error: 'unknown_source' });
    const pref = src.preferences?.find((p) => p.key === key);
    if (!pref) return reply.code(400).send(refusal('unknown_pref', say('setting.unknown')));

    const before = await readSourceSettings(id, [pref]);
    const had = before.values.has(key) || before.unreadable.has(key);
    let remap = 0;
    if (had) {
      await clearSourceSetting(id, key);
      clearDetailCacheFor(id);
      if (pref.numbering) remap = await remapFor(id);
      await logAudit('source.pack_pref_reset', { userId: userIdOf(req), req, detail: { source: id, key, title: pref.title } });
    }
    const stored = await readSourceSettings(id, src.preferences ?? []);
    return {
      ok: true, changed: had, applied: true, remap,
      preferences: (src.preferences ?? []).map((p) => wireSetting(p, stored)),
      ...(await usage(id)),
    };
  });
}
