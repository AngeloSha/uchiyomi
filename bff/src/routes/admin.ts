import { hash } from '@node-rs/argon2';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, one } from '../lib/db';
import { content as komga } from '../lib/backend';
import { cacheBytes } from '../lib/imageCache';
import { runtime } from '../lib/runtime';
import { persistScan } from '../lib/library';
import { runUpdateAll, updateSeries } from '../lib/updater';
import { authenticate, requireAdmin, userIdOf, revokeAllSessions, revokeRefreshTokenById, passwordError } from '../lib/auth';
import { logAudit, recentAudit } from '../lib/audit';
import { healthAll, setDisabled, clearBlock } from '../lib/sourceHealth';
import { reloadAll, listSources, getSource, detectEngine } from '../lib/sources';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';

export default async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireAdmin);

  // Owned-library scan (Phase 1): walk the CBZ folder and upsert lib_series/lib_books.
  app.post('/api/admin/library/scan', async () => persistScan());

  // Owned downloader/updater (Phase 2): pull new chapters from the source for one series or the whole library.
  app.post('/api/admin/update/:id', async (req) => updateSeries((req.params as { id: string }).id, Number((req.body as any)?.maxNew) || 10));
  app.post('/api/admin/update', async (req) => runUpdateAll({ onlyFavorites: !!(req.body as any)?.favorites, maxNew: Number((req.body as any)?.maxNew) || 10 }));

  app.get('/api/admin/users', async () => ({
    content: await q(`SELECT u.id, u.username, u.display_name, u.role, u.avatar, u.created_at, u.disabled, u.perms, u.totp_enabled,
        (SELECT max(created_at) FROM reading_events e WHERE e.user_id = u.id) AS last_active
      FROM users u ORDER BY u.created_at`),
  }));

  // ---- server settings ----
  app.get('/api/admin/settings', async () => one('SELECT server_name, allow_registration, updater_hours FROM server_settings WHERE id = 1'));
  app.patch('/api/admin/settings', async (req) => {
    const b = z.object({ serverName: z.string().min(1).max(64).optional(), allowRegistration: z.boolean().optional(), updaterHours: z.number().int().min(1).max(168).optional() }).parse(req.body);
    if (b.serverName !== undefined) await q('UPDATE server_settings SET server_name = $1, updated_at = now() WHERE id = 1', [b.serverName]);
    if (b.allowRegistration !== undefined) await q('UPDATE server_settings SET allow_registration = $1, updated_at = now() WHERE id = 1', [b.allowRegistration]);
    if (b.updaterHours !== undefined) await q('UPDATE server_settings SET updater_hours = $1, updated_at = now() WHERE id = 1', [b.updaterHours]);
    await logAudit('settings.update', { userId: userIdOf(req), detail: b, req });
    return one('SELECT server_name, allow_registration, updater_hours FROM server_settings WHERE id = 1');
  });

  // ---- scheduled tasks ----
  app.get('/api/admin/tasks', async () => {
    const s = await one<{ updater_hours: number }>('SELECT updater_hours FROM server_settings WHERE id = 1');
    return { content: [
      { id: 'scan', name: 'Library scan', schedule: 'on demand', lastRun: runtime.lastScan || null, running: false },
      { id: 'update', name: 'Check for new chapters', schedule: `every ${s?.updater_hours ?? 6}h`, lastRun: runtime.lastUpdate || null, lastResult: runtime.lastUpdateResult, running: runtime.updating },
    ] };
  });
  app.post('/api/admin/tasks/:id/run', async (req) => {
    const { id } = req.params as { id: string };
    await logAudit('task.run', { userId: userIdOf(req), detail: { task: id }, req });
    if (id === 'scan') return { ok: true, ...(await persistScan()) };
    if (id === 'update') { runUpdateAll({ maxNew: 10 }).then((r) => { runtime.lastUpdate = Date.now(); runtime.lastUpdateResult = { series: r.series, added: r.added }; }).catch(() => {}); return { ok: true, started: true }; }
    return { ok: false };
  });

  // ---- audit / activity feed ----
  app.get('/api/admin/audit', async (req) => ({ content: await recentAudit(Number((req.query as any)?.limit) || 150) }));

  // reload source plugins from SOURCES_DIR (after dropping in / updating a source pack) — no restart needed
  app.post('/api/admin/sources/reload', async (req) => {
    const r = reloadAll(); // rescan pack + re-add built-ins + config sites
    await logAudit('source.reload', { userId: userIdOf(req), detail: r, req });
    return { ok: true, ...r, available: listSources().length };
  });

  // ---- custom "template" sites (Madara/Manganato added by name+URL, no code). The core only reads/writes
  // a JSON file; the source pack's custom plugin instantiates the adapters from it on reload. ----
  const SITES_FILE = process.env.CUSTOM_SITES_FILE || '/config/sites.json';
  type Site = { engine: string; id: string; name: string; base: string; order?: number };
  const readSites = async (): Promise<Site[]> => { try { const j = JSON.parse(await readFile(SITES_FILE, 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; } };
  const writeSites = async (list: Site[]) => { await mkdir(dirname(SITES_FILE), { recursive: true }).catch(() => {}); await writeFile(SITES_FILE, JSON.stringify(list, null, 2)); };
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40);

  app.get('/api/admin/sources/custom', async () => ({ content: await readSites() }));
  app.post('/api/admin/sources/custom', async (req, reply) => {
    const b = z.object({ engine: z.enum(['auto', 'madara', 'manganato', 'mangathemesia']), name: z.string().min(1).max(60), base: z.string().url() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'Pick an engine, a name, and a valid https URL.' });
    // auto-detect the engine from the site's homepage so the user can just paste a URL
    let engine = b.data.engine as string;
    if (engine === 'auto') {
      const detected = await detectEngine(b.data.base);
      if (!detected) return reply.code(422).send({ error: 'undetected', message: "Couldn't detect the site's engine — pick Madara, MangaThemesia, or Manganato manually." });
      engine = detected;
    }
    const id = slug(b.data.name) || slug(new URL(b.data.base).hostname.replace(/^www\./, ''));
    if (!id) return reply.code(400).send({ error: 'bad_name' });
    const list = await readSites();
    if (getSource(id) || list.some((s) => s.id === id)) return reply.code(409).send({ error: 'exists', message: `A source named "${b.data.name}" already exists — pick another name.` });
    list.push({ engine, id, name: b.data.name, base: b.data.base.replace(/\/+$/, ''), order: 100 });
    await writeSites(list);
    reloadAll();
    await logAudit('source.custom_add', { userId: userIdOf(req), detail: { id, engine, base: b.data.base }, req });
    return reply.send({ ok: true, id, engine, available: listSources().length });
  });
  app.delete('/api/admin/sources/custom/:id', async (req) => {
    const { id } = req.params as { id: string };
    await writeSites((await readSites()).filter((s) => s.id !== id));
    reloadAll();
    await logAudit('source.custom_remove', { userId: userIdOf(req), detail: { id }, req });
    return { ok: true, available: listSources().length };
  });

  // ---- provider/source health control ----
  app.get('/api/admin/sources', async () => ({ content: await healthAll() }));
  app.post('/api/admin/sources/:id/:action', async (req, reply) => {
    const { id, action } = req.params as { id: string; action: string };
    if (action === 'disable') await setDisabled(id, true);
    else if (action === 'enable') await setDisabled(id, false);
    else if (action === 'unblock') await clearBlock(id);
    else return reply.code(400).send({ error: 'bad_action' });
    await logAudit(`source.${action}`, { userId: userIdOf(req), detail: { source: id }, req });
    return reply.send({ ok: true });
  });

  // ---- sessions across all users ----
  app.get('/api/admin/sessions', async () => ({
    content: await q(`SELECT r.id, r.user_id, u.username, u.display_name, r.device_name, r.ip, r.user_agent, r.created_at, r.last_seen
      FROM refresh_tokens r JOIN users u ON u.id = r.user_id
      WHERE r.revoked_at IS NULL AND r.expires_at > now() ORDER BY r.last_seen DESC LIMIT 300`),
  }));
  app.delete('/api/admin/sessions/:id', async (req) => {
    await revokeRefreshTokenById((req.params as { id: string }).id);
    await logAudit('admin.session_revoke', { userId: userIdOf(req), req });
    return { ok: true };
  });

  app.get('/api/admin/stats', async () => {
    const [libs, seriesPage, cb, members, activity] = await Promise.all([
      komga.libraries().catch(() => [] as any[]),
      komga.searchSeries({}, 0, 1).catch(() => ({ totalElements: 0 } as any)),
      cacheBytes().catch(() => 0),
      one<{ c: number }>('SELECT count(*)::int AS c FROM users'),
      q(
        `SELECT u.id, u.display_name, u.username, u.avatar,
                count(e.*) FILTER (WHERE e.completed)::int AS total,
                count(e.*) FILTER (WHERE e.completed AND e.created_at > now() - interval '7 days')::int AS week,
                max(e.created_at) AS last_active
         FROM users u LEFT JOIN reading_events e ON e.user_id = u.id
         GROUP BY u.id ORDER BY total DESC`,
      ),
    ]);
    return {
      libraries: (libs as any[]).map((l) => ({ name: l.name })),
      seriesTotal: (seriesPage as any).totalElements ?? 0,
      cacheBytes: cb,
      lastScan: runtime.lastScan || null,
      members: members?.c ?? 0,
      activity,
    };
  });

  const permsShape = z.object({ canDownload: z.boolean().optional(), canManage: z.boolean().optional() });

  app.post('/api/admin/users', async (req, reply) => {
    const b = z
      .object({
        username: z.string().min(2).max(64).regex(/^[a-zA-Z0-9._-]+$/, 'letters, numbers, . _ - only'),
        password: z.string().min(1).max(200),
        displayName: z.string().max(64).optional(),
        role: z.enum(['admin', 'user']).default('user'),
        perms: permsShape.optional(),
      })
      .safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', detail: b.error.flatten().fieldErrors });
    const { username, password, displayName, role, perms } = b.data;
    const pwErr = passwordError(password);
    if (pwErr) return reply.code(400).send({ error: 'weak_password', message: pwErr });

    const exists = await one('SELECT id FROM users WHERE username = $1', [username]);
    if (exists) return reply.code(409).send({ error: 'username_taken' });

    const ph = await hash(password);
    const row = await one<{ id: string }>(
      `INSERT INTO users (display_name, username, role, password_hash, auth_kind, perms)
       VALUES ($1, $2, $3, $4, 'password', $5)
       RETURNING id, username, display_name, role, created_at`,
      [displayName || username, username, role, ph, JSON.stringify(perms || {})],
    );
    if (row) await q(`INSERT INTO app_settings (user_id, data) VALUES ($1, '{}'::jsonb) ON CONFLICT (user_id) DO NOTHING`, [row.id]);
    await logAudit('user.create', { userId: userIdOf(req), detail: { username, role }, req });
    return reply.send(row);
  });

  app.patch('/api/admin/users/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z
      .object({
        password: z.string().min(1).max(200).optional(),
        displayName: z.string().max(64).optional(),
        role: z.enum(['admin', 'user']).optional(),
        disabled: z.boolean().optional(),
        perms: permsShape.optional(),
      })
      .parse(req.body);
    // safety: never lock yourself out, never remove the last active admin
    if (id === userIdOf(req) && (b.disabled || b.role === 'user')) return reply.code(400).send({ error: 'cannot_demote_self' });
    if (b.disabled || b.role === 'user') {
      const t = await one<{ role: string }>('SELECT role FROM users WHERE id = $1', [id]);
      if (t?.role === 'admin') {
        const admins = await one<{ c: number }>(`SELECT count(*)::int AS c FROM users WHERE role = 'admin' AND NOT disabled`);
        if ((admins?.c ?? 0) <= 1) return reply.code(400).send({ error: 'last_admin' });
      }
    }
    if (b.password) {
      const pwErr = passwordError(b.password);
      if (pwErr) return reply.code(400).send({ error: 'weak_password', message: pwErr });
      await q('UPDATE users SET password_hash = $2, password_changed_at = now(), failed_logins = 0, locked_until = NULL WHERE id = $1', [id, await hash(b.password)]);
      await revokeAllSessions(id); // force re-login after an admin password reset
    }
    if (b.displayName) await q('UPDATE users SET display_name = $2 WHERE id = $1', [id, b.displayName]);
    if (b.role) await q('UPDATE users SET role = $2 WHERE id = $1', [id, b.role]);
    if (b.perms) await q('UPDATE users SET perms = $2 WHERE id = $1', [id, JSON.stringify(b.perms)]);
    if (b.disabled !== undefined) {
      await q('UPDATE users SET disabled = $2 WHERE id = $1', [id, b.disabled]);
      if (b.disabled) await revokeAllSessions(id); // kick out a suspended account
    }
    await logAudit('user.update', { userId: userIdOf(req), detail: { target: id, role: b.role, disabled: b.disabled, perms: b.perms, password: b.password ? '***' : undefined }, req });
    return one('SELECT id, username, display_name, role, disabled, perms, totp_enabled FROM users WHERE id = $1', [id]);
  });

  app.delete('/api/admin/users/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === userIdOf(req)) return reply.code(400).send({ error: 'cannot_delete_self' });
    const target = await one<{ role: string }>('SELECT role FROM users WHERE id = $1', [id]);
    if (!target) return reply.code(404).send({ error: 'not_found' });
    if (target.role === 'admin') {
      const admins = await one<{ c: number }>(`SELECT count(*)::int AS c FROM users WHERE role = 'admin'`);
      if ((admins?.c ?? 0) <= 1) return reply.code(400).send({ error: 'last_admin' });
    }
    await q('DELETE FROM users WHERE id = $1', [id]);
    return reply.send({ ok: true });
  });
}
