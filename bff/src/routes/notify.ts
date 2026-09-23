/**
 * Admin → Settings → Notifications (v0.43.0, #70): the notification targets beyond web push.
 *
 * Admin-only, structurally: the plugin-level `authenticate` + `requireAdmin` hooks, like routes/admin.ts, so
 * an API token needs the admin scope as well. A household reader must not be able to create an outbound POST
 * carrying an arbitrary bearer token -- that is the primitive ssrfGuard.ts exists to deny them -- which is
 * why a target can be AIMED at one person (`userId`: their favourites only) without that person being able to
 * make one.
 *
 * ⚠️ THE ADDRESS AND THE TOKEN GO IN AND NEVER COME OUT. Every answer carries the masked display form
 * (lib/notify/kinds.ts `maskUrl`); there is no reveal; changing one means typing it again. The audit rows are
 * built field by field from an allowlist -- never `detail: b`, which is how the settings PATCH in admin.ts
 * would have written a Home Assistant token into audit_log in plain text. Every refusal is a fixed sentence:
 * the global error handler returns a 4xx `err.message` verbatim and logs a 5xx error with its enumerable
 * properties, so nothing here throws with, or parses unguarded, a string that could carry a credential.
 *
 * ⚠️ TEST TAKES AN ID, NEVER A URL. A "test this address" endpoint that accepts one in the body is a port
 * scanner with an admin login and an open proxy for one POST. It is also limited to five a minute PER ADMIN
 * -- keyed on the user id, not the address: server.ts runs with `trustProxy: true`, so `req.ip` is whatever
 * the leftmost X-Forwarded-For says and a limit keyed on it is one header away from no limit at all.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { q, one } from '../lib/db';
import { authenticate, requireAdmin, userIdOf } from '../lib/auth';
import { logAudit } from '../lib/audit';
import { EVENTS, KINDS, validateTarget, type Kind, type TargetInput } from '../lib/notify/kinds';
import { safeUrl } from '../lib/notify/guard';
import { deliver, getTarget, listTargets, openSecret, sealSecret, toDto } from '../lib/notify';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Strings are length-capped here and parsed nowhere: an address is judged by kinds.ts through `safeUrl`,
// which cannot throw. A zod `.url()` would be fine too, but one rule in one place is easier to trust.
const credentials = {
  url: z.string().max(2048).optional(),
  token: z.string().max(4096).nullable().optional(),
  topic: z.string().max(64).optional(),
  service: z.string().max(255).optional(),
};
const common = {
  name: z.string().trim().min(1).max(80),
  events: z.array(z.enum(EVENTS)).min(1).max(EVENTS.length),
  template: z.string().max(500).nullable(),
  userId: z.string().regex(UUID).nullable(),
  enabled: z.boolean(),
  // Name 18+ series in the digest. Off by default, like the OPDS link's and API tokens' show_adult: the
  // web app's Show 18+ is a per-browser session cookie the server never sees, so a target carries its own.
  includeAdult: z.boolean(),
};
const createBody = z.object({
  kind: z.enum(KINDS),
  ...credentials,
  name: common.name,
  events: common.events.optional(),
  template: common.template.optional(),
  userId: common.userId.optional(),
  enabled: common.enabled.optional(),
  includeAdult: common.includeAdult.optional(),
});
// `kind` is not editable: a target that becomes another kind is a different target, with other fields.
const patchBody = z.object({
  ...credentials,
  name: common.name.optional(),
  events: common.events.optional(),
  template: common.template.optional(),
  userId: common.userId.optional(),
  enabled: common.enabled.optional(),
  includeAdult: common.includeAdult.optional(),
}).strict();

/** Field names only -- a zod issue's `input`/`received` never leaves the server. */
const badRequest = (reply: FastifyReply, err: z.ZodError) =>
  reply.code(400).send({ error: 'bad_request', message: 'Check the highlighted fields', fields: err.issues.map((i) => i.path.join('.')).filter(Boolean) });

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found', message: 'No such notification target' });

async function userExists(id: string): Promise<boolean> {
  return !!(await one('SELECT 1 FROM users WHERE id = $1', [id]));
}

/** The host alone, for the audit row: who pointed notifications where, without the path that holds a secret. */
const hostOf = (display: string): string => display.replace(/^https?:\/\//, '').replace(/\/….*$/, '');

export default async function notifyRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireAdmin);
  // server.ts registers the limiter at the root; a test or a tool that mounts this plugin bare gets it here
  // instead, so the Test route is never unlimited by accident (the komgaCompat precedent).
  if (!app.hasDecorator('createRateLimit')) await app.register(rateLimit, { global: false });

  app.get('/api/admin/notify-targets', async () => ({ targets: (await listTargets()).map(toDto) }));

  app.post('/api/admin/notify-targets', async (req, reply) => {
    const p = createBody.safeParse(req.body);
    if (!p.success) return badRequest(reply, p.error);
    const b = p.data;
    const v = validateTarget(b.kind as Kind, b as TargetInput);
    if (!v.ok) return reply.code(400).send({ error: v.error, message: v.message });
    if (b.userId && !(await userExists(b.userId))) return reply.code(400).send({ error: 'unknown_user', message: 'That person does not exist' });
    const row = await one<{ id: string }>(
      `INSERT INTO notify_targets (kind, name, config, secret, user_id, events, template, enabled, include_adult)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6::text[], $7, $8, $9) RETURNING id`,
      [b.kind, b.name, JSON.stringify(v.config), sealSecret(v.secret), b.userId ?? null,
        b.events ?? ['new_chapters', 'health'], b.template?.trim() || null, b.enabled ?? true, b.includeAdult ?? false],
    );
    const saved = await getTarget(row!.id);
    await logAudit('notify.target.create', {
      userId: userIdOf(req), req,
      detail: { id: row!.id, kind: b.kind, name: b.name, host: hostOf(v.config.display), userId: b.userId ?? null },
    });
    return reply.code(201).send(toDto(saved!));
  });

  app.patch('/api/admin/notify-targets/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return notFound(reply);
    const cur = await getTarget(id);
    if (!cur) return notFound(reply);
    const p = patchBody.safeParse(req.body);
    if (!p.success) return badRequest(reply, p.error);
    const b = p.data;
    const sets: string[] = [];
    const vals: unknown[] = [];
    const set = (col: string, val: unknown, cast = '') => { vals.push(val); sets.push(`${col} = $${vals.length + 1}${cast}`); };
    let fresh = false;
    let host: string | undefined;

    // Re-entering any credential re-validates the whole target: the new value merged over the stored ones.
    // What was stored has to be readable for that, unless the admin re-entered everything the kind needs.
    const touched = (['url', 'token', 'topic', 'service'] as const).filter((k) => b[k] !== undefined);
    if (touched.length) {
      const old = openSecret(cur.secret);
      // A blank ntfy server is ntfy.sh, as on create; a blank address of any other kind is a bad_url below.
      const url = b.url !== undefined ? (b.url.trim() || (cur.kind === 'ntfy' ? 'https://ntfy.sh' : '')) : old?.url;
      if (url === undefined) {
        return reply.code(400).send({ error: 'reenter_all', message: 'The stored address could not be read. Enter the address and token again.' });
      }
      // ⚠️ A STORED CREDENTIAL NEVER FOLLOWS THE ADDRESS TO ANOTHER HOST. Merging it under a new address would
      // hand the new host the Home Assistant token, the webhook bearer or the ntfy topic at the next Test or
      // digest -- a reveal of a secret this route promises never to show, by pointing it at a listener, and
      // one the audit row (field names only) would not even notice. The GitLab-integration class of bug. The
      // same origin is the same party, so a webhook moved to another path keeps its token; any other origin
      // (another host, port or scheme) needs the token -- and an ntfy topic, which is a password on a public
      // server -- typed again, or removed on purpose with `token: null`. An address that does not parse is not
      // a move: validateTarget answers it with bad_url, never with a hint about what is stored.
      // Reintroduce by merging old.token when the origin changed: "A STORED TOKEN NEVER FOLLOWS THE ADDRESS TO
      // ANOTHER HOST" in notifyTargets.int.test.ts sees a 200, and B receives 'Bearer SEKRIT-ha-llat-91c2'.
      const newOrigin = b.url !== undefined ? safeUrl(url)?.origin ?? null : null;
      const moved = newOrigin !== null && newOrigin !== (old ? safeUrl(old.url)?.origin ?? null : null);
      if (moved && old?.token && b.token === undefined) {
        return reply.code(400).send({ error: 'reenter_token', message: 'A new address needs its token typed again' });
      }
      if (moved && cur.kind === 'ntfy' && old?.topic && b.topic === undefined) {
        return reply.code(400).send({ error: 'reenter_topic', message: 'A new server needs its topic typed again' });
      }
      const merged: TargetInput = {
        url,
        token: b.token !== undefined ? b.token : old?.token,
        topic: b.topic ?? old?.topic,
        service: b.service ?? cur.config?.service,
      };
      const v = validateTarget(cur.kind, merged);
      if (!v.ok) return reply.code(400).send({ error: v.error, message: v.message });
      // Where the target points now, for the audit row -- the host alone, as on create.
      if (b.url !== undefined) host = hostOf(v.config.display);
      set('config', JSON.stringify(v.config), '::jsonb');
      set('secret', sealSecret(v.secret));
      // A new address or token is a fresh start: the old streak and the old error describe something else.
      fresh = true;
      sets.push('last_error = NULL', 'last_error_at = NULL');
    }
    if (b.name !== undefined) set('name', b.name);
    if (b.events !== undefined) set('events', b.events, '::text[]');
    if (b.template !== undefined) set('template', b.template?.trim() || null);
    if (b.userId !== undefined) {
      if (b.userId && !(await userExists(b.userId))) return reply.code(400).send({ error: 'unknown_user', message: 'That person does not exist' });
      set('user_id', b.userId);
    }
    if (b.includeAdult !== undefined) set('include_adult', b.includeAdult);
    if (b.enabled !== undefined) {
      set('enabled', b.enabled);
      // Switching a target back on gives it ten more tries; otherwise the next failure would switch it
      // straight off again, with a second notice about a fix the admin has only just made.
      if (b.enabled && !cur.enabled) fresh = true;
    }
    if (fresh) sets.push('consecutive_failures = 0');
    if (sets.length) {
      sets.push('updated_at = now()');
      await q(`UPDATE notify_targets SET ${sets.join(', ')} WHERE id = $1`, [id, ...vals]);
    }
    // Names of what changed, never values: a token re-entered is logged as the word "token". A new address
    // adds its host, so the trail says who pointed notifications where (the path can hold a secret).
    await logAudit('notify.target.update', {
      userId: userIdOf(req), req,
      detail: { id, fields: Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined).sort(), ...(host ? { host } : {}) },
    });
    return toDto((await getTarget(id))!);
  });

  app.delete('/api/admin/notify-targets/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return notFound(reply);
    const gone = await one<{ kind: string; name: string }>('DELETE FROM notify_targets WHERE id = $1 RETURNING kind, name', [id]);
    if (!gone) return notFound(reply);
    await logAudit('notify.target.delete', { userId: userIdOf(req), req, detail: { id, kind: gone.kind, name: gone.name } });
    return { ok: true };
  });

  /**
   * Send one test message to a SAVED target and say how it went: `{ ok, status, reason }`, the reason from a
   * closed set. Never the body the target answered, its headers, or the address it resolved to.
   *
   * `hook: 'preHandler'` puts the limiter after the plugin's authenticate/requireAdmin hooks, so `req.user` is
   * there to key on. Reintroduce by dropping `keyGenerator`: "six Tests in a minute from one admin, each from
   * a new X-Forwarded-For, the sixth is refused" in notifyTargets.int.test.ts sees a sixth 200.
   */
  app.post('/api/admin/notify-targets/:id/test', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
        hook: 'preHandler',
        keyGenerator: (req) => `notify-test:${userIdOf(req)}`,
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return notFound(reply);
    const row = await getTarget(id);
    if (!row) return notFound(reply);
    const s = await one<{ server_name: string | null }>('SELECT server_name FROM server_settings WHERE id = 1').catch(() => null);
    const r = await deliver(row, {
      event: 'test',
      title: s?.server_name?.trim() || 'Uchiyomi',
      message: 'This is a test notification from Uchiyomi. If you can read it, this target works.',
      count: 0,
      series: [],
    }, { mode: 'test', retry: false });
    await logAudit('notify.target.test', { userId: userIdOf(req), req, detail: { id, ok: r.ok, reason: r.reason } });
    return { ok: r.ok, status: r.status, reason: r.reason };
  });
}
