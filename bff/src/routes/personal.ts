import type { FastifyInstance, FastifyRequest } from 'fastify';
import { hash } from '@node-rs/argon2';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { q, one, tx } from '../lib/db';
// backend-agnostic content client: the owned library in owned mode, Komga otherwise. The old direct
// `lib/komga` import silently nulled every series lookup here after the owned-library cutover.
import { content as komga } from '../lib/backend';
import { viewCtxFor, visible, browsable, browsableIds, Params, type ViewCtx, hideAdult, sourceAllowedFor } from '../lib/visibility';
import { getSource } from '../lib/sources';
import { startBulkNewest, bulkNewestState } from '../lib/bulkNewest';
// The download strip's "is a job running for this folder" lives with the strip, in routes/sources.ts, and
// routes/admin.ts imports it from there too.
import { jobBusy } from './sources';
import { BlockedAddress } from '../lib/ssrfGuard';
import { authenticate, requireCredentialSession, passwordError, revokeAllSessions, userIdOf, roleOf, actsAsAdmin, issueOpdsToken, issueApiToken, listApiTokens, revokeApiToken, API_SCOPES, revokeOpdsToken, opdsTokenStatus, setOpdsShowAdult, OPDS_TOKEN_DAYS } from '../lib/auth';
import { enrichSeries, seenCounts } from '../lib/enrich';
import { env } from '../env';
import { pushEnabled, vapidPublicKey, saveSubscription, removeSubscription } from '../lib/push';
import { statusFor, saveConnection, disconnect, whoAmI, pushSeriesProgress, pushSeriesProgressAsync, clearTrackerFloor, testConnection } from '../lib/trackers';
import { ADAPTERS, isProvider, verdictOf, type Provider } from '../lib/trackerProviders';
import { logAudit } from '../lib/audit';
import { ssoOnly } from '../lib/authMode';
import { MAX_MANAGED_PROFILES, freeUsername, inheritRestrictions, placeholderPasswordHash, profileKind, profileRefusal } from '../lib/profiles';
import { noticeBook } from '../lib/noticeChapters';
import { devicesOf, hourIn, lastDays, loadTimeline, summarize, validTz, yearRange } from '../lib/readingTime';
import { listFor, ownListFor, listsFor, listItems, kindOf, ownerOf, type ListRow } from '../lib/lists';
import { smartQuery, parseQuery } from '../lib/smartLists';
import { insightsFor } from '../lib/readingInsights';
import { FRAMES, badgeOfFrame, computeStreaks, earnedFrames, finishedDays } from '../lib/badges';
import { favoriteOrder, orderFavorites } from '../lib/favorites';

/** A colour a member stores that other members' browsers paint (avatar, list accent): hex only (v0.69.1). */
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** The most days `/api/stats?days=all` answers: about ten years, the "All time" heatmap's longest strip (#265). */
const ALL_TIME_MAX_DAYS = 3660;

/**
 * What a list's sort orders need that a series DTO does not carry (#164), for the series of one list: when this reader
 * last read in each, and when each one's newest chapter arrived. One query each for the whole list, over ids the route
 * has already let through.
 *
 * `read` is the reader's OWN latest progress in the series -- another member's reading is not theirs -- with hidden
 * notice chapters left out, as enrich's counts leave them out; a series they never opened has none. `latest` is the
 * newest chapter file's time (lib_series.latest_mtime), what the Library's Updated sort orders by: the source's own
 * chapter date is missing for most chapters. None for a series without a chapter, and none on a Komga backend, which
 * keeps no lib_series rows.
 */
async function listDates(userId: string, ids: string[]): Promise<{ read: Map<string, string>; latest: Map<string, string> }> {
  if (!ids.length) return { read: new Map(), latest: new Map() };
  const read = await q<{ series_id: string; at: Date }>(
    `SELECT series_id, max(updated_at) AS at FROM read_progress
      WHERE user_id = $1 AND series_id = ANY($2) AND NOT ${noticeBook('read_progress.book_id')}
      GROUP BY series_id`,
    [userId, ids],
  );
  const latest = await q<{ id: string; mt: string }>('SELECT id, latest_mtime AS mt FROM lib_series WHERE id = ANY($1) AND latest_mtime > 0', [ids]);
  return {
    read: new Map(read.map((r) => [r.series_id, new Date(r.at).toISOString()])),
    latest: new Map(latest.map((r) => [r.id, new Date(Number(r.mt)).toISOString()])),
  };
}

/**
 * A list as the Lists routes describe it (v0.61.0): its kind and sharing, whether it is the caller's own, and -- for its
 * owner alone -- a smart list's search, which Edit filters opens. Someone else never receives the search: it may name a
 * library or a source they do not have.
 */
function listOut(l: ListRow, uid: string) {
  const mine = l.user_id === uid;
  const query = mine && kindOf(l) === 'smart' ? parseQuery(l.query) : null;
  return {
    id: l.id, name: l.name, accent: l.accent, sort_order: l.sort_order,
    kind: kindOf(l), shared: l.shared === true, mine,
    ...(query ? { query } : {}),
  };
}

export default async function personalRoutes(app: FastifyInstance) {
  // server.ts registers the limiter at the root; a test or a tool that mounts this plugin bare gets it here instead,
  // so Test connection is never unlimited by accident (v0.61.0, the notify.ts and komgaCompat.ts precedent).
  if (!app.hasDecorator('createRateLimit')) await app.register(rateLimit, { global: false });
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', async (req) => {
    (req as any).viewCtx = await viewCtxFor(userIdOf(req), roleOf(req), { hideAdult: hideAdult(req) });
  });
  /** The viewer attached above. */
  const vc = (req: any): ViewCtx => req.viewCtx as ViewCtx;

  // issue/rotate the caller's OPDS token (shown once); used as the HTTP Basic password in an external reader
  // Not from a session entered without a password: the token would open the library from anywhere.
  app.post('/api/opds/token', { preHandler: requireCredentialSession }, async (req) => {
    const token = await issueOpdsToken(userIdOf(req));
    return { token, url: `${env.PUBLIC_ORIGIN.replace(/\/$/, '')}/opds`, expiresInDays: OPDS_TOKEN_DAYS };
  });

  // Whether a token exists, when it expires, and when a reader last used it. The last-used date is the
  // useful one: it is how someone notices a token they forgot about is still being used by something.
  app.get('/api/opds/token', async (req) => opdsTokenStatus(userIdOf(req)));

  app.delete('/api/opds/token', async (req) => {
    await revokeOpdsToken(userIdOf(req));
    return { ok: true };
  });

  // Whether the reader behind this token may list 18+ libraries. Lives on the token because an OPDS client
  // cannot press the web app's reveal button, and because the phone and the e-reader are different
  // audiences for the same account. The age cap is a permission and is not touched by this.
  app.patch('/api/opds/token', async (req, reply) => {
    const b = z.object({ showAdult: z.boolean() }).parse(req.body);
    if (!(await setOpdsShowAdult(userIdOf(req), b.showAdult))) return reply.code(404).send({ error: 'no_token' });
    return opdsTokenStatus(userIdOf(req));
  });

  // ---- personal API tokens ----
  // Deliberately mirrors the sessions panel: list, create once, revoke. The raw token is returned by the
  // create call and never again, because only its hash is stored.
  app.get('/api/tokens', async (req) => ({ content: await listApiTokens(userIdOf(req)) }));

  app.post('/api/tokens', { preHandler: requireCredentialSession }, async (req, reply) => {
    const b = z
      .object({
        name: z.string().trim().min(1).max(60),
        scopes: z.array(z.enum(API_SCOPES)).min(1),
        expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
        // Whether the Komga-compatible API lists 18+ libraries to this token (Mihon has no reveal button).
        // A surfacing preference on the credential, like the OPDS token's; the age cap still applies.
        showAdult: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'Give the token a name and at least one scope.' });

    // Only admin authority may mint an admin-scoped token: an admin session, or a token that already carries the
    // admin scope. Otherwise any user could self-promote their automation, and an admin's read+write sync token
    // (which requireAdmin refuses) could mint its way onto the admin API in one request.
    const scopes = b.data.scopes;
    if (scopes.includes('admin') && !actsAsAdmin(req)) {
      return reply.code(403).send({ error: 'forbidden', message: 'Only an admin can create an admin token.' });
    }
    // 'write' and 'admin' both imply being able to read
    if (!scopes.includes('read')) scopes.push('read');

    const expires = b.data.expiresInDays ? new Date(Date.now() + b.data.expiresInDays * 86400000) : null;
    const showAdult = b.data.showAdult === true;
    const { id, token } = await issueApiToken(userIdOf(req), b.data.name, scopes, expires, showAdult);
    await logAudit('token.create', { userId: userIdOf(req), detail: { id, name: b.data.name, scopes, showAdult }, req });
    return { id, token };
  });

  app.delete('/api/tokens/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await revokeApiToken(userIdOf(req), id))) return reply.code(404).send({ error: 'not_found' });
    await logAudit('token.revoke', { userId: userIdOf(req), detail: { id }, req });
    return { ok: true };
  });

  // ---- profiles this account manages ----
  // A member the admin allows (perms.canManageProfiles), or an admin, makes profiles that open at home without a
  // password -- the children's, say -- and switches to them from its own session. Its own only: Admin -> Members manages
  // everyone's. Each starts with the member's own restrictions (lib/profiles.ts inheritRestrictions), and none of this
  // is open to a session that was itself entered without a password.
  const mayManageProfiles = async (req: FastifyRequest): Promise<boolean> => {
    if (actsAsAdmin(req)) return true;
    const u = await one<{ perms: { canManageProfiles?: boolean } | null }>('SELECT perms FROM users WHERE id = $1', [userIdOf(req)]);
    return u?.perms?.canManageProfiles === true;
  };
  const NOT_ALLOWED = { error: 'forbidden', message: 'This account cannot manage profiles. Ask whoever runs the server.' };
  const PROFILE_COLS = `id, username, display_name, avatar, disabled, created_at,
                        password_login, local_open, oidc_sub IS NOT NULL AS sso, auth_kind`;
  const asProfile = ({ password_login, local_open, sso, auth_kind, display_name, ...p }: any) =>
    ({ ...p, displayName: display_name, kind: profileKind({ password_login, local_open, sso, auth_kind }) });
  const profileId = (req: FastifyRequest) => z.string().uuid().safeParse((req.params as { id: string }).id);

  app.get('/api/profiles', async (req) => ({
    content: (await q(`SELECT ${PROFILE_COLS} FROM users WHERE managed_by = $1 ORDER BY created_at`, [userIdOf(req)])).map(asProfile),
  }));

  app.post('/api/profiles', { preHandler: requireCredentialSession }, async (req, reply) => {
    const b = z.object({
      displayName: z.string().trim().min(1).max(64),
      // With a password it is a hybrid: no password at home, this one from anywhere else.
      password: z.string().min(1).max(200).optional(),
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await mayManageProfiles(req))) return reply.code(403).send(NOT_ALLOWED);
    const { displayName, password } = b.data;
    if (password && ssoOnly()) return reply.code(403).send({ error: 'sso_only' });
    if (password) {
      const pwErr = passwordError(password);
      if (pwErr) return reply.code(400).send({ error: 'weak_password', message: pwErr });
    }
    const me = userIdOf(req);
    const ph = password ? await hash(password) : await placeholderPasswordHash();
    let made: { id: string } | null;
    try {
      made = await tx(async (qq) => {
        // Counted and made under one lock per manager, so two requests at once cannot both pass the count.
        await qq('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 6400))', [me]);
        const [{ n }] = await qq<{ n: number }>('SELECT count(*)::int AS n FROM users WHERE managed_by = $1', [me]);
        if (n >= MAX_MANAGED_PROFILES) return null;
        const [row] = await qq<{ id: string }>(
          `INSERT INTO users (display_name, username, role, password_hash, auth_kind, password_login, local_open, managed_by)
           VALUES ($1, $2, 'user', $3, $4, $5, true, $6) RETURNING id`,
          [displayName, await freeUsername(qq, displayName), ph, password ? 'password' : 'none', !!password, me]);
        await qq(`INSERT INTO app_settings (user_id, data) VALUES ($1, '{}'::jsonb) ON CONFLICT (user_id) DO NOTHING`, [row.id]);
        await inheritRestrictions(qq, me, row.id);
        return row;
      });
    } catch (e) {
      // Another writer took the generated name between the check and the insert (uq_users_username).
      if ((e as { code?: string })?.code === '23505') return reply.code(409).send({ error: 'username_taken' });
      throw e;
    }
    if (!made) return reply.code(409).send({ error: 'too_many_profiles', message: `At most ${MAX_MANAGED_PROFILES} profiles.` });
    await logAudit('profile.create', { userId: me, detail: { profile: made.id, hybrid: !!password }, req });
    return asProfile(await one(`SELECT ${PROFILE_COLS} FROM users WHERE id = $1`, [made.id]));
  });

  app.patch('/api/profiles/:id', { preHandler: requireCredentialSession }, async (req, reply) => {
    const id = profileId(req);
    const b = z.object({
      displayName: z.string().trim().min(1).max(64).optional(),
      password: z.string().min(1).max(200).optional(),
      localOpen: z.boolean().optional(),
    }).safeParse(req.body);
    if (!id.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await mayManageProfiles(req))) return reply.code(403).send(NOT_ALLOWED);
    const me = userIdOf(req);
    const p = await one<{ password_login: boolean; local_open: boolean; sso: boolean }>(
      'SELECT password_login, local_open, oidc_sub IS NOT NULL AS sso FROM users WHERE id = $1 AND managed_by = $2', [id.data, me]);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const { displayName, password, localOpen } = b.data;
    if (password && ssoOnly()) return reply.code(403).send({ error: 'sso_only' });
    const refused = profileRefusal({ role: 'user', localOpen: localOpen ?? p.local_open, credential: p.sso || p.password_login || !!password });
    if (refused) return reply.code(400).send(refused);
    if (password) {
      const pwErr = passwordError(password);
      if (pwErr) return reply.code(400).send({ error: 'weak_password', message: pwErr });
      await q(`UPDATE users SET password_hash = $2, password_login = true, password_changed_at = now(), failed_logins = 0, locked_until = NULL
                WHERE id = $1`, [id.data, await hash(password)]);
    }
    if (displayName) await q('UPDATE users SET display_name = $2 WHERE id = $1', [id.data, displayName]);
    if (localOpen !== undefined) await q('UPDATE users SET local_open = $2 WHERE id = $1', [id.data, localOpen]);
    // A new way in, or one taken away: the profile's sessions end, as an admin's password reset ends them.
    if (password || localOpen !== undefined) await revokeAllSessions(id.data);
    await logAudit('profile.update', { userId: me, detail: { profile: id.data, displayName, password: password ? '***' : undefined, localOpen }, req });
    return asProfile(await one(`SELECT ${PROFILE_COLS} FROM users WHERE id = $1`, [id.data]));
  });

  app.delete('/api/profiles/:id', { preHandler: requireCredentialSession }, async (req, reply) => {
    const id = profileId(req);
    if (!id.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await mayManageProfiles(req))) return reply.code(403).send(NOT_ALLOWED);
    const me = userIdOf(req);
    const p = await one<{ username: string | null }>('SELECT username FROM users WHERE id = $1 AND managed_by = $2', [id.data, me]);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    // As DELETE /api/admin/users/:id does: what the profile's reading was, counted before there is nothing to count.
    const lost = await one<{ progress: number; events: number; favorites: number }>(
      `SELECT (SELECT count(*)::int FROM read_progress  WHERE user_id = $1) AS progress,
              (SELECT count(*)::int FROM reading_events WHERE user_id = $1) AS events,
              (SELECT count(*)::int FROM favorites      WHERE user_id = $1) AS favorites`, [id.data]).catch(() => null);
    await logAudit('profile.delete', { userId: me, detail: { target: id.data, username: p.username, destroyed: lost ?? 'uncounted' }, req });
    await q('DELETE FROM users WHERE id = $1', [id.data]);
    return { ok: true };
  });

  // ---- web push: new-chapter notifications ----
  app.get('/api/push/key', async () => ({ enabled: pushEnabled(), key: vapidPublicKey() }));
  app.post('/api/push/subscribe', async (req, reply) => {
    const b = z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }), deviceId: z.string().optional() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    try {
      await saveSubscription(userIdOf(req), { endpoint: b.data.endpoint, keys: b.data.keys }, b.data.deviceId);
    } catch (e) {
      // not https, or not a public host (lib/push.ts assertPushEndpoint): a refusal, answered as a 400 rather than a 500
      if (e instanceof BlockedAddress) return reply.code(400).send({ error: 'bad_request', message: 'A push endpoint must be a public https URL.' });
      throw e;
    }
    return { ok: true };
  });
  app.post('/api/push/unsubscribe', async (req, reply) => {
    const b = z.object({ endpoint: z.string() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    await removeSubscription(userIdOf(req), b.data.endpoint);
    return { ok: true };
  });

  // ---- favorites ----
  app.get('/api/favorites', async (req) => {
    const uid = userIdOf(req);
    const ids = (
      await q<{ series_id: string }>(
        `SELECT series_id FROM favorites WHERE user_id = $1 ORDER BY ${favoriteOrder()}`,
        [uid],
      )
    ).map((r) => r.series_id);
    // Favourite ids come from another table, so they inherit no predicate: filter before resolving.
    const shown = await browsableIds(ids, vc(req));
    const series = (await Promise.all(ids.filter((id) => shown.has(id)).map((id) => komga.series(vc(req), id).catch(() => null)))).filter(Boolean);
    // Enriched like every other series listing. Without this the favourites rail was the one place in the app
    // that got raw DTOs: no rating, no new-chapter count, no cover colour, and an unread badge showing the
    // total chapter count.
    return { content: await enrichSeries(req, series) };
  });

  app.post('/api/favorites', async (req, reply) => {
    const uid = userIdOf(req);
    const { seriesId } = z.object({ seriesId: z.string().min(1) }).parse(req.body);
    await q('INSERT INTO favorites (user_id, series_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [uid, seriesId]);
    // baseline the updates feed at the current chapter count so old chapters don't show as "new" -- every chapter
    // row, hidden notices included (lib/enrich.ts seenCounts)
    const s = await komga.series(vc(req), seriesId).catch(() => null);
    if (s) {
      await q(
        `INSERT INTO series_seen (user_id, series_id, seen_books_count) VALUES ($1, $2, $3) ON CONFLICT (user_id, series_id) DO NOTHING`,
        [uid, seriesId, (await seenCounts([s as any])).get(seriesId) ?? 0],
      );
    }
    return reply.send({ ok: true, favorite: true });
  });

  // Home's Favourites sheet (v0.97.0): the order the person put them in, every one at once (lib/favorites.ts).
  app.put('/api/favorites/order', async (req, reply) => {
    const b = z.object({ seriesIds: z.array(z.string().min(1).max(200)).max(5000) }).strict().safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    return { ok: true, placed: await orderFavorites(userIdOf(req), b.data.seriesIds) };
  });

  app.delete('/api/favorites/:seriesId', async (req) => {
    const uid = userIdOf(req);
    const { seriesId } = req.params as { seriesId: string };
    await q('DELETE FROM favorites WHERE user_id = $1 AND series_id = $2', [uid, seriesId]);
    return { ok: true, favorite: false };
  });

  // ---- collections (the app's Lists) ----
  //
  // v0.61.0: smart and shared lists (lib/lists.ts, lib/smartLists.ts). Reading a list -- GET of one, or the ?scope=all
  // listing -- answers for any list the caller may read: their own, or one shared with the household. Changing one --
  // PATCH, DELETE and the item routes -- only for its owner: a shared list is read-only for everyone else (the owner's
  // ruling), and someone else's list answers 404, never 403, so an id says nothing about whether it exists. Reintroduce
  // by reading through listFor in a write: "a shared list is read-only for everyone but its owner" in lists.int.test.ts
  // sees 200.
  const listName = z.string().min(1).max(120);

  /** The caller's own hand-picked list for the item routes, or the answer that refuses it (already sent). */
  const pickedList = async (req: any, reply: any): Promise<ListRow | null> => {
    const list = await ownListFor(userIdOf(req), (req.params as { id: string }).id);
    if (!list) { reply.code(404).send({ error: 'not_found' }); return null; }
    // A smart list holds what its search finds; there is nothing to add by hand, remove or reorder.
    if (kindOf(list) === 'smart') {
      reply.code(409).send({ error: 'smart_list', message: 'A smart list holds what its filters find. Change its filters instead.' });
      return null;
    }
    return list;
  };

  // No `scope`: the caller's own hand-picked lists with the stored count, as before v0.61.0 -- the series page's "Add to
  // collection" sheet offers these, and an older client reads them. `scope=all`: theirs of both kinds and the
  // household's shared ones, counted for this viewer (lib/lists.ts listsFor).
  app.get('/api/collections', async (req) => {
    const { scope } = req.query as { scope?: string };
    return { content: await listsFor(userIdOf(req), vc(req), scope === 'all' ? 'all' : 'manual') };
  });

  app.post('/api/collections', async (req, reply) => {
    const uid = userIdOf(req);
    const b = z.object({
      name: listName,
      accent: z.string().regex(HEX_COLOR).optional(),
      // v0.61.0: a smart list's saved Library search, and whether the household may read the list.
      query: smartQuery.optional(),
      shared: z.boolean().optional(),
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'Give the list a name; a smart list needs a valid search.' });
    const row = await one<ListRow>(
      `INSERT INTO collections (user_id, name, accent, query, shared) VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING id, user_id, name, accent, sort_order, query, shared`,
      [uid, b.data.name, b.data.accent ?? null, b.data.query ? JSON.stringify(b.data.query) : null, b.data.shared === true],
    );
    return listOut(row!, uid);
  });

  app.patch('/api/collections/:id', async (req, reply) => {
    const uid = userIdOf(req);
    const b = z.object({
      name: listName.optional(),
      accent: z.string().regex(HEX_COLOR).nullable().optional(),
      sortOrder: z.number().int().optional(),
      query: smartQuery.optional(),
      shared: z.boolean().optional(),
    }).safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const list = await ownListFor(uid, (req.params as { id: string }).id);
    if (!list) return reply.code(404).send({ error: 'not_found' });
    // A list's kind is fixed when it is made: a hand-picked list has no search to change, and a smart one cannot be
    // turned into a hand-picked list by sending no search.
    if (b.data.query && kindOf(list) !== 'smart') return reply.code(400).send({ error: 'not_smart', message: 'Only a smart list has filters to change.' });
    const row = await one<ListRow>(
      `UPDATE collections SET
         name = COALESCE($3, name),
         accent = COALESCE($4, accent),
         sort_order = COALESCE($5, sort_order),
         query = COALESCE($6::jsonb, query),
         shared = COALESCE($7, shared)
       WHERE id = $1 AND user_id = $2 RETURNING id, user_id, name, accent, sort_order, query, shared`,
      [list.id, uid, b.data.name ?? null, b.data.accent ?? null, b.data.sortOrder ?? null,
        b.data.query ? JSON.stringify(b.data.query) : null, b.data.shared ?? null],
    );
    return listOut(row!, uid);
  });

  app.delete('/api/collections/:id', async (req, reply) => {
    const uid = userIdOf(req);
    const list = await ownListFor(uid, (req.params as { id: string }).id);
    if (!list) return reply.code(404).send({ error: 'not_found' });
    await q('DELETE FROM collections WHERE id = $1 AND user_id = $2', [list.id, uid]);
    return { ok: true };
  });

  // One list and its series, for its owner or -- shared -- for anyone in the household. `limit` (1-200) caps the items, a
  // Home rail asking for twelve; a smart list is capped at 200 without it, a hand-picked one is whole as it always was.
  // `total` is how many there are in all for this viewer, so a capped smart list can say so.
  app.get('/api/collections/:id', async (req, reply) => {
    const uid = userIdOf(req);
    const { id } = req.params as { id: string };
    const raw = (req.query as { limit?: string }).limit;
    const limit = raw === undefined ? undefined : Math.max(1, Math.min(200, Math.floor(Number(raw)) || 200));
    const list = await listFor(uid, id);
    if (!list) return reply.code(404).send({ error: 'not_found' });
    const kind = kindOf(list);
    const { items: found, total } = await listItems(list, vc(req), 0, kind === 'smart' ? (limit ?? 200) : limit);
    // Someone else's shared list exists for a member only while it shows them something, as the listing has it.
    if (list.user_id !== uid && total === 0) return reply.code(404).send({ error: 'not_found' });
    const items = await enrichSeries(req, found);
    // The list's sorts (#164) order by two dates no series payload carries; they ride on these items alone. The items
    // stay in the list's own order: the web sorts them, a list being one request and never paged.
    const dates = await listDates(uid, items.map((s: any) => s.id));
    return {
      ...listOut(list, uid),
      ...(list.user_id === uid ? {} : { owner: await ownerOf(list) }),
      total,
      items: items.map((s: any) => ({ ...s, lastReadAt: dates.read.get(s.id) ?? null, latestChapterAt: dates.latest.get(s.id) ?? null })),
    };
  });

  app.post('/api/collections/:id/items', async (req, reply) => {
    const { seriesId } = z.object({ seriesId: z.string().min(1) }).parse(req.body);
    const list = await pickedList(req, reply);
    if (!list) return reply;
    // At the end of the list's own order, where the bulk add puts them. The column's default, 0, tied a series added
    // to a list someone had ordered by hand with its first entry -- and the list's own order is its default sort.
    await q(
      `INSERT INTO collection_items (collection_id, series_id, position)
       VALUES ($1, $2, COALESCE((SELECT max(position) + 1 FROM collection_items WHERE collection_id = $1), 0))
       ON CONFLICT DO NOTHING`,
      [list.id, seriesId],
    );
    return { ok: true };
  });

  app.delete('/api/collections/:id/items/:seriesId', async (req, reply) => {
    const { seriesId } = req.params as { id: string; seriesId: string };
    const list = await pickedList(req, reply);
    if (!list) return reply;
    await q('DELETE FROM collection_items WHERE collection_id = $1 AND series_id = $2', [list.id, seriesId]);
    return { ok: true };
  });

  // Reorder a collection: the full series-id list in its new order rewrites the positions.
  app.put('/api/collections/:id/items', async (req, reply) => {
    const { seriesIds } = z.object({ seriesIds: z.array(z.string().min(1)).max(500) }).parse(req.body);
    const list = await pickedList(req, reply);
    if (!list) return reply;
    for (let i = 0; i < seriesIds.length; i++)
      await q('UPDATE collection_items SET position = $3 WHERE collection_id = $1 AND series_id = $2', [list.id, seriesIds[i], i]);
    return { ok: true };
  });

  // ---- ratings ----
  app.put('/api/ratings/:seriesId', async (req) => {
    const uid = userIdOf(req);
    const { seriesId } = req.params as { seriesId: string };
    const { stars } = z.object({ stars: z.number().int().min(1).max(5) }).parse(req.body);
    await q(
      `INSERT INTO ratings (user_id, series_id, stars) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, series_id) DO UPDATE SET stars = EXCLUDED.stars, updated_at = now()`,
      [uid, seriesId, stars],
    );
    return { ok: true, stars };
  });

  app.delete('/api/ratings/:seriesId', async (req) => {
    const uid = userIdOf(req);
    const { seriesId } = req.params as { seriesId: string };
    await q('DELETE FROM ratings WHERE user_id = $1 AND series_id = $2', [uid, seriesId]);
    return { ok: true };
  });

  // ---- notes ----
  // ---- page bookmarks ----
  //
  // Kept behind the visibility rule like every other read: a bookmark names a book id, and listing them has
  // to go through the same predicate or it becomes a way to learn that a series you cannot see exists.
  app.get('/api/bookmarks', async (req) => {
    const { seriesId } = req.query as { seriesId?: string };
    const p = new Params();
    const ctx = vc(req);
    const uid = p.add(userIdOf(req));
    const extra = seriesId ? ` AND bm.series_id = ${p.add(seriesId)}` : '';
    // The join to lib_series is what carries every series-level rule -- soft delete, merge, library access
    // and the age cap -- through to a bookmark. Listing them without it would let someone learn that a
    // series they cannot see exists, and what they once read of it.
    return {
      content: await q(
        `SELECT bm.book_id, bm.series_id, bm.page, bm.note, bm.created_at,
                b.title AS book_title, b.number, COALESCE(so.title, s.title) AS series_title
           FROM bookmarks bm
           JOIN lib_books b   ON b.id = bm.book_id
           JOIN lib_series s  ON s.id = b.series_id AND ${browsable('s', ctx, p)}
           LEFT JOIN series_overrides so ON so.series_id = s.id
          WHERE bm.user_id = ${uid}${extra} AND NOT ${noticeBook('b.id')}
          ORDER BY bm.created_at DESC LIMIT 500`,
        p.values as any[],
      ),
    };
  });

  app.put('/api/bookmarks/:bookId/:page', async (req, reply) => {
    const { bookId, page } = req.params as { bookId: string; page: string };
    const n = Number(page);
    if (!Number.isInteger(n) || n < 1) return reply.code(400).send({ error: 'bad_page' });
    const b = z.object({ note: z.string().max(500).nullish() }).safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    // Resolve the book through the backend so a bookmark cannot be created against a series the viewer
    // cannot see -- which would otherwise be a write that confirms the id exists.
    const book = await komga.book(vc(req), bookId).catch(() => null);
    if (!book) return reply.code(404).send({ error: 'not_found' });
    // An ABSENT `note` leaves the stored one alone; an explicit `null` clears it.
    //
    // These are different requests and the schema already tells them apart -- `nullish()` gives `undefined`
    // for absent and `null` for explicit -- but `?? null` used to flatten both and the upsert then wrote it
    // unconditionally. That was harmless while nothing could write a note; /moments now can. The reader's
    // star PUTs this route with an empty body, so re-starring a page you had annotated erased the note --
    // and the star re-arms itself whenever its `marks` fetch fails, which is exactly the offline case.
    const touchesNote = b.data.note !== undefined;
    await q(
      `INSERT INTO bookmarks (user_id, book_id, series_id, page, note)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, book_id, page) DO UPDATE
         SET created_at = now()${touchesNote ? ', note = EXCLUDED.note' : ''}`,
      [userIdOf(req), bookId, book.seriesId, n, b.data.note ?? null],
    );
    return { ok: true };
  });

  app.delete('/api/bookmarks/:bookId/:page', async (req) => {
    const { bookId, page } = req.params as { bookId: string; page: string };
    await q('DELETE FROM bookmarks WHERE user_id = $1 AND book_id = $2 AND page = $3',
      [userIdOf(req), bookId, Number(page)]);
    return { ok: true };
  });

  /**
   * Every note, newest first, optionally narrowed to one series.
   *
   * The by-id route below answers one series; this answers "show me everything I have written", which is what
   * a notes surface needs and what nothing could ask for before.
   *
   * Joined through `browsable()` for the same reason the bookmark listing above is: a note names a series id,
   * so listing them without the predicate is a way to learn a series you cannot see exists, and what you once
   * wrote about it.
   */
  app.get('/api/notes', async (req) => {
    const { seriesId } = req.query as { seriesId?: string };
    const p = new Params();
    const ctx = vc(req);
    const uid = p.add(userIdOf(req));
    const extra = seriesId ? ` AND n.series_id = ${p.add(seriesId)}` : '';
    return {
      content: await q(
        `SELECT n.id, n.series_id, n.book_id, n.body, n.updated_at,
                COALESCE(so.title, s.title) AS series_title, b.title AS book_title, b.number
           FROM notes n
           JOIN lib_series s ON s.id = n.series_id AND ${browsable('s', ctx, p)}
           LEFT JOIN series_overrides so ON so.series_id = s.id
           -- The series-id term below is the load-bearing half. The gate above covers the note's SERIES;
           -- without it this join hands back book_title and number for ANY book id stored in the row,
           -- including one belonging to a series this account cannot see. The bookmark listing above does
           -- not need the same term because it derives the series FROM the book, so one gate covers both.
           -- (No backticks in here: this is inside a JS template literal.)
           LEFT JOIN lib_books b ON b.id = n.book_id AND b.series_id = n.series_id
          WHERE n.user_id = ${uid}${extra}
          ORDER BY n.updated_at DESC LIMIT 500`,
        p.values as any[],
      ),
    };
  });

  app.get('/api/notes/:seriesId', async (req) => {
    const { seriesId } = req.params as { seriesId: string };
    const p = new Params();
    const ctx = vc(req);
    const uid = p.add(userIdOf(req));
    // Same join as the listing above. Without it this answered for any series id at all, including one in a
    // library the viewer has no grant for and one above their age cap.
    return {
      content: await q(
        `SELECT n.id, n.series_id, n.book_id, n.body, n.updated_at
           FROM notes n
           JOIN lib_series s ON s.id = n.series_id AND ${browsable('s', ctx, p)}
          WHERE n.user_id = ${uid} AND n.series_id = ${p.add(seriesId)}
          ORDER BY n.updated_at DESC`,
        p.values as any[],
      ),
    };
  });

  app.post('/api/notes', async (req, reply) => {
    const uid = userIdOf(req);
    const { seriesId, bookId, body } = z.object({ seriesId: z.string().min(1), bookId: z.string().optional(), body: z.string().min(1).max(4000) }).parse(req.body);
    // Resolve the series through the backend first, exactly as the bookmark write above does: creating a note
    // against a series the viewer cannot see would otherwise be a write that confirms the id exists.
    const series = await komga.series(vc(req), seriesId).catch(() => null);
    if (!series) return reply.code(404).send({ error: 'not_found' });
    // And if a chapter was named, it has to be a chapter OF that series. `bookId` arrives from the client
    // and nothing else checks it: stored unvalidated, it is an id of the caller's choosing sitting in a row
    // that later reads join against.
    if (bookId) {
      const book = await komga.book(vc(req), bookId).catch(() => null);
      if (!book || book.seriesId !== seriesId) return reply.code(404).send({ error: 'not_found' });
    }
    return one('INSERT INTO notes (user_id, series_id, book_id, body) VALUES ($1, $2, $3, $4) RETURNING id, series_id, book_id, body, updated_at', [uid, seriesId, bookId ?? null, body]);
  });

  app.patch('/api/notes/:id', async (req) => {
    const uid = userIdOf(req);
    const { id } = req.params as { id: string };
    // Same cap as the create above. Without it the 4000-char limit is bypassed by posting a short note and
    // then editing it to any length at all.
    const { body } = z.object({ body: z.string().min(1).max(4000) }).parse(req.body);
    return one('UPDATE notes SET body = $3, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING id, body, updated_at', [id, uid, body]);
  });

  app.delete('/api/notes/:id', async (req) => {
    const uid = userIdOf(req);
    const { id } = req.params as { id: string };
    await q('DELETE FROM notes WHERE id = $1 AND user_id = $2', [id, uid]);
    return { ok: true };
  });

  // ---- history & stats ----
  app.get('/api/history', async (req) => {
    const limit = Math.min(Number((req.query as Record<string, string>).limit) || 50, 200);
    const hp = new Params();
    const hctx = vc(req);
    const uid = hp.add(userIdOf(req));
    // most-recent event per book, newest first, with display titles for the history timeline
    return {
      content: await q(
        `SELECT e.book_id, e.series_id, e.page, e.completed, e.created_at,
                COALESCE(b.title, '') AS book_title, COALESCE(s.title, '') AS series_title
         FROM (
           SELECT DISTINCT ON (book_id) book_id, series_id, page, completed, created_at
           FROM reading_events WHERE user_id = ${uid}
           ORDER BY book_id, created_at DESC
         ) e
         -- These were LEFT JOINs with no predicate at all, so history listed the titles of series that had
         -- been deleted, merged away, or moved into a library the reader no longer holds. Inner joins
         -- through browsable() make history obey the same rule as every other listing, 18+ included.
         JOIN lib_books b ON b.id = e.book_id
         JOIN lib_series s ON s.id = e.series_id AND ${browsable('s', hctx, hp)}
         -- not a notice chapter the admin hides (lib/noticeChapters.ts)
         WHERE NOT ${noticeBook('b.id')}
         ORDER BY e.created_at DESC
         LIMIT ${hp.add(limit)}`,
        hp.values as any[],
      ),
    };
  });

  app.get('/api/stats', async (req) => {
    const uid = userIdOf(req);
    // When reading started, so a year picker can offer the years that exist rather than guessing a range.
    // Null for an account that has never read anything, which is different from "started this year". `span` is the
    // UTC days from that first day to today, both counted: what "All time" draws.
    const first = await one<{ at: string | null; span: number | null }>(
      `SELECT min(created_at) AS at,
              ((now() AT TIME ZONE 'UTC')::date - (min(created_at) AT TIME ZONE 'UTC')::date + 1)::int AS span
         FROM reading_events WHERE user_id = $1`,
      [uid],
    );
    const firstRead = first?.at ?? null;
    // Clamped, not trusted: `days` sizes a generate_series, so an unbounded value is a way to ask the
    // database to materialise a few million rows. 400 covers "a year, plus the run-up" -- the widest thing
    // the heatmap draws -- and 7 is the narrowest window in which a week's shape is visible at all.
    // `days=all` (#265, CheetahDoesStuff: the Reading studio's "All time") is every day from the first read to today,
    // dense like the others, within ALL_TIME_MAX_DAYS: ten years is still a bounded series, and the heatmap is all
    // the Studio draws for it. Reintroduce the plain clamp ("all" reads as NaN, so 90): "All time" in
    // statsShape.int.test.ts gets 90 days back.
    const asked = (req.query as Record<string, string>).days;
    const windowDays = asked === 'all'
      ? Math.max(7, Math.min(ALL_TIME_MAX_DAYS, first?.span ?? 7))
      : Math.max(7, Math.min(400, Math.floor(Number(asked) || 90)));
    const summary = (await one('SELECT chapters_completed, series_touched, total_events, last_read_at FROM reading_stats WHERE user_id = $1', [uid])) ?? {
      chapters_completed: 0,
      series_touched: 0,
      total_events: 0,
      last_read_at: null,
    };
    // DENSE, and one definition of "a day".
    //
    // This used to `GROUP BY date_trunc(...)` and return only the days that had events, which the chart then
    // rendered as one bar per row: someone who read on five days saw five fat evenly-spaced bars under a
    // label saying "Last 90 days". The gaps -- the actual information in a reading chart -- were silently
    // deleted, and the fewer days you read the more wrong it looked.
    //
    // The two queries also disagreed with each other: this one bucketed in the server's local zone and the
    // streak query on the next line bucketed in UTC, so on a container with a non-UTC TZ the chart and the
    // streak were off by one. Both now use UTC, which is at least ONE definition; a reader's own zone would
    // need the client to say what it is, and a streak that changes when you fly is a worse bug than a
    // boundary that is a few hours off.
    const byDay = await q<{ day: string; chapters: number }>(
      `SELECT to_char(d::date, 'YYYY-MM-DD') AS day,
              coalesce(e.chapters, 0)::int   AS chapters
         FROM generate_series(
                (now() AT TIME ZONE 'UTC')::date - make_interval(days => $2 - 1),
                (now() AT TIME ZONE 'UTC')::date,
                interval '1 day') AS d
         LEFT JOIN (
           -- A chapter finished twice in a day is one chapter that day (#264): one read-through writes two completed
           -- events (the page before the last already counts as the end, lib/progressRules.ts reachedEnd, and the last
           -- page sends its own). A chapter read again on ANOTHER day lights that day too, as it does the streak below.
           SELECT date_trunc('day', created_at AT TIME ZONE 'UTC')::date AS day,
                  count(DISTINCT book_id) FILTER (WHERE completed) AS chapters
             FROM reading_events
            WHERE user_id = $1 AND created_at > now() - make_interval(days => $2)
            GROUP BY 1
         ) e ON e.day = d::date
        ORDER BY 1`,
      [uid, windowDays],
    );
    // The badges' measure too (lib/badges.ts): what the server checks a frame against is what the profile shows.
    const streaks = computeStreaks(await finishedDays(uid));
    // The week's chapters (the weekly goal) and the window's (the Studio's count over its heatmap): each finished chapter
    // once, as the household board counts its week (#264). The window's is not the sum of byDay, where a chapter read
    // again on another day counts on both days. Reintroduce count(*): "a read-through counts once" in
    // finishedOnce.int.test.ts finds five.
    const counts = await one<{ week: number; in_window: number }>(
      `SELECT count(DISTINCT book_id) FILTER (WHERE created_at > now() - interval '7 days')::int AS week,
              count(DISTINCT book_id)::int AS in_window
         FROM reading_events
        WHERE user_id = $1 AND completed = true AND created_at > now() - make_interval(days => $2)`,
      [uid, windowDays],
    );
    const weekChapters = counts?.week ?? 0;
    const settings = ((await one<{ data: any }>('SELECT data FROM app_settings WHERE user_id = $1', [uid]))?.data) ?? {};
    return { ...summary, days: windowDays, byDay, windowChapters: counts?.in_window ?? 0, first_read_at: firstRead, currentStreak: streaks.current, longestStreak: streaks.longest, weekChapters, weeklyGoal: settings.weeklyGoal ?? 0 };
  });

  /**
   * v0.61.0, Reading time (lib/readingTime.ts): how long the signed-in reader has read, from their own page turns -- the
   * last 7 and 30 days, this UTC year (the one /api/wrapped counts), and over the Reading Studio's window (`days`,
   * 7-400, as /api/stats) the median time per finished chapter, the hours of the day in `tz` (an IANA name; UTC when it
   * is not one) and the devices, by the names their own sessions gave. No user parameter: nobody reads another
   * member's time, and the household leaderboard and the admin's member stats stay counts of chapters.
   * Reintroduce another member's events: "the Studio's time: the reader's own, by window, hour and device" in
   * readingTime.int.test.ts adds the other member's forty turns.
   */
  app.get('/api/stats/time', async (req) => {
    const uid = userIdOf(req);
    const qs = req.query as Record<string, string>;
    const days = Math.max(7, Math.min(400, Math.floor(Number(qs.days) || 90)));
    const tz = validTz(qs.tz);
    const now = Date.now();
    const year = new Date(now).getUTCFullYear();
    const [ys, ye] = yearRange(year);
    const win = lastDays(days, now);
    const week = lastDays(7, now);
    const month = lastDays(30, now);
    const tl = await loadTimeline(uid, Math.min(win[0], month[0], ys), now + 1);
    const hourOf = hourIn(tz);
    const w = summarize(tl, win[0], win[1], hourOf);
    const wk = summarize(tl, week[0], week[1], hourOf);
    const mo = summarize(tl, month[0], month[1], hourOf);
    const yr = summarize(tl, ys, ye, hourOf);
    return {
      tz, days,
      week: { ms: wk.ms, chapters: wk.chapters },
      month: { ms: mo.ms, chapters: mo.chapters },
      year: { year, ms: yr.ms, chapters: yr.chapters },
      window: { ms: w.ms, chapters: w.chapters, perChapterMs: w.perChapterMs, byHour: w.byHour, byDevice: await devicesOf(uid, w.byDevice) },
    };
  });

  /**
   * Profile → Insights (lib/readingInsights.ts, from @Squeaks72's #249): the best day and week, and one row per browsable
   * series the reader has a recorded read in -- its chapters, how many they have finished, when they last read it and
   * what they finished of it lately. Own reading only, each chapter once; 18+ series follow the request's Show 18+ switch;
   * incognito reads are not in reading_events, so they are in none of it. Reintroduce `WHERE true` for browsable():
   * "a hidden 18+ series never appears" in readingInsights.int.test.ts lists it.
   */
  app.get('/api/stats/insights', async (req) => insightsFor(userIdOf(req), vc(req)));

  /**
   * v0.61.0: this reader's pace through a series, for its page's "Catch up in ~2 hr" -- the median time of the chapters
   * of it they finished in the last year when there are three or more (`from: 'series'`), else their median over every
   * series in the last 90 days (`'all'`), else none. A series they may not open is not found, as its page is not.
   * Reintroduce the lookup by id alone: "the reading pace of a series: its own, else the reader's overall, else none;
   * 404 where it may not be seen" in readingTime.int.test.ts answers 200 for a library this account was not given.
   */
  app.get('/api/series/:id/reading-pace', async (req, reply) => {
    const { id } = req.params as { id: string };
    const seen = await komga.series(vc(req), id).catch(() => null);
    if (!seen) return reply.code(404).send({ error: 'not_found' });
    const now = Date.now();
    const year = lastDays(365, now);
    const quarter = lastDays(90, now);
    const tl = await loadTimeline(userIdOf(req), year[0], now + 1);
    const noHours = () => 0;
    const own = summarize(tl, year[0], year[1], noHours, id).perChapterMs;
    if (own != null) return { perChapterMs: own, from: 'series' as const };
    const all = summarize(tl, quarter[0], quarter[1], noHours).perChapterMs;
    return all != null ? { perChapterMs: all, from: 'all' as const } : { perChapterMs: null, from: null };
  });

  app.get('/api/wrapped', async (req) => {
    const uid = userIdOf(req);
    const year = Math.max(1970, Math.min(9999, Math.floor(Number((req.query as Record<string, string>).year) || new Date().getUTCFullYear())));

    // UTC, on both sides of the wire.
    //
    // This was `extract(year from created_at) = $2`, which evaluates a timestamptz in the SERVER's zone, and
    // then bucketed months and weekdays with `new Date().getMonth()/.getDay()`, which use the server's zone
    // too. /api/stats next door buckets in UTC. So on any container not running UTC the two endpoints
    // disagreed, and a chapter finished on New Year's Eve counted in the wrong year -- the exact split-brain
    // statsShape.int.test.ts was written about, sitting in the endpoint beside it.
    //
    // A half-open range rather than a function on the column, so the index on (user_id, created_at) is
    // usable; `extract(...)` was not sargable and scanned every event the account ever had.
    //
    // Each chapter once, on the day it was first finished that year (#264): one read-through writes two completed
    // events (the page before the last already counts as the end, lib/progressRules.ts reachedEnd), and a re-read or
    // an outbox replay writes more, so "69 chapters" was 40. The months, weekdays, days and top series below are
    // built from these rows, so they add up to `chapters`. Reintroduce the plain SELECT: "a read-through counts once"
    // in finishedOnce.int.test.ts finds five.
    const rows = await q<{ series_id: string; created_at: string }>(
      `SELECT DISTINCT ON (book_id) series_id, created_at
         FROM reading_events
        WHERE user_id = $1 AND completed = true
          AND created_at >= make_timestamptz($2, 1, 1, 0, 0, 0, 'UTC')
          AND created_at <  make_timestamptz($3, 1, 1, 0, 0, 0, 'UTC')
        ORDER BY book_id, created_at, id`,
      [uid, year, year + 1],
    );
    const seriesCounts: Record<string, number> = {};
    const byMonth = Array(12).fill(0);
    const dow = Array(7).fill(0);
    // Dense, one slot per day of the calendar year -- 366 in a leap year, and index 0 is 1 January UTC. A
    // sparse map would make the client invent the gaps, which is what the stats chart used to do wrong.
    const yearStart = Date.UTC(year, 0, 1);
    const dayCount = Math.round((Date.UTC(year + 1, 0, 1) - yearStart) / 86_400_000);
    const byDay: number[] = Array(dayCount).fill(0);
    for (const r of rows) {
      seriesCounts[r.series_id] = (seriesCounts[r.series_id] ?? 0) + 1;
      const d = new Date(r.created_at);
      byMonth[d.getUTCMonth()]++;
      dow[d.getUTCDay()]++;
      const i = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - yearStart) / 86_400_000);
      if (i >= 0 && i < dayCount) byDay[i]++;
    }
    // Over-take, then filter, then take five: the top series are resolved by id, so an 18+ title would
    // otherwise both appear here and, once hidden, leave the rail with four entries instead of five.
    const ranked = Object.entries(seriesCounts).sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    const shownTop = await browsableIds(ranked.slice(0, 40), vc(req));
    const topIds = ranked.filter((id) => shownTop.has(id)).slice(0, 5);
    const topSeries = (
      await Promise.all(
        topIds.map(async (id) => {
          const s = await komga.series(vc(req), id).catch(() => null);
          return s ? { id, title: (s as any).metadata?.title || (s as any).name, count: seriesCounts[id], genres: (s as any).metadata?.genres ?? [] } : null;
        }),
      )
    ).filter(Boolean) as { id: string; title: string; count: number; genres: string[] }[];
    // Genres come from a pool of twenty series and are weighted by how much of each you actually read.
    //
    // They used to come from the five series above, counted one apiece: "your top genres" meant "the genres
    // of your top five series", each weighted the same whether you read three chapters of it or three
    // hundred. That is a much smaller claim than the label makes, and with five series a single long-running
    // title decided the whole answer.
    const poolIds = ranked.filter((id) => shownTop.has(id)).slice(0, 20);
    const pool = (
      await Promise.all(poolIds.map(async (id) => {
        const s = await komga.series(vc(req), id).catch(() => null);
        return s ? { id, genres: ((s as any).metadata?.genres ?? []) as string[] } : null;
      }))
    ).filter(Boolean) as { id: string; genres: string[] }[];
    const genreCounts: Record<string, number> = {};
    for (const s of pool) for (const g of s.genres) genreCounts[g] = (genreCounts[g] ?? 0) + (seriesCounts[s.id] ?? 0);
    const rankedGenres = Object.entries(genreCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    // v0.61.0: the year's reading time from page turns (lib/readingTime.ts), its pace per chapter and its hours of the
    // day in the reader's `tz` -- the same timeline and the same year the Reading Studio's year tile reads, so the two
    // never disagree. Reintroduce a different year (say the last 365 days): "the Studio's year is Wrapped's, to the
    // millisecond" in readingTime.int.test.ts finds two figures.
    const tz = validTz((req.query as Record<string, string>).tz);
    const [ys, ye] = yearRange(year);
    const time = summarize(await loadTimeline(uid, ys, ye), ys, ye, hourIn(tz));
    return {
      year,
      tz,
      ms: time.ms,
      perChapterMs: time.perChapterMs,
      byHour: time.byHour,
      chapters: rows.length,
      series: Object.keys(seriesCounts).length,
      topSeries: topSeries.map((s) => ({ id: s.id, title: s.title, count: s.count })),
      topGenres: rankedGenres.map((e) => e[0]),
      topGenreCounts: rankedGenres.map(([name, count]) => ({ name, count })),
      byMonth,
      byDay,
      byDow: dow,
      busiestDow: dow.indexOf(Math.max(...dow)),
    };
  });

  // ---- settings ----
  // ---- bulk actions on many series at once ----
  //
  // One request per logical operation rather than a client-side loop: 200 requests is slow, trips the rate
  // limiter, and on partial failure leaves the user with no idea which half applied.
  //
  // An id that no longer exists does NOT fail the batch. A stale client list is the normal case (a series was
  // deleted in another tab), and refusing 50 valid ids because one is stale is hostile. The response itemises
  // what was skipped so the UI can say so.
  const bulkBody = z.object({ seriesIds: z.array(z.string()).min(1).max(500) });

  /** The subset of the requested ids that are real, visible series. */
  const liveSeries = async (ids: string[], ctx: ViewCtx): Promise<string[]> => {
    // Takes the requester's viewer, not a blanket one: this is what gates every bulk action, so a series
    // the caller cannot see must not be actionable by id either.
    const p = new Params();
    const arr = p.add(ids);
    return (await q<{ id: string }>(
      `SELECT s.id FROM lib_series s WHERE s.id = ANY(${arr}) AND ${visible('s', ctx, p)}`,
      p.values as any[],
    )).map((r) => r.id);
  };

  const skippedOf = (asked: string[], live: string[]) =>
    asked.filter((id) => !live.includes(id)).map((id) => ({ id, reason: 'not_found' }));

  app.post('/api/library/bulk/read', async (req, reply) => {
    const b = bulkBody.extend({ completed: z.boolean() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const uid = userIdOf(req);
    const live = await liveSeries(b.data.seriesIds, vc(req));

    if (b.data.completed) {
      // GREATEST on page so marking a series read never rewinds a chapter someone is part-way through.
      // Deliberately no reading_events insert: that table records chapters actually read in the app, and
      // bulk-marking a backlog must not inflate streaks, the leaderboard or Wrapped. Same rule as the
      // `silent` flag in lib/progress.ts.
      await q(
        `INSERT INTO read_progress (user_id, book_id, series_id, page, completed)
         SELECT $1, b.id, b.series_id, COALESCE(b.pages, 0), true
           FROM lib_books b WHERE b.series_id = ANY($2)
            -- What the reader sees: a notice chapter the admin hides (lib/noticeChapters.ts) is left as it was.
            AND NOT ${noticeBook('b.id')}
         ON CONFLICT (user_id, book_id) DO UPDATE
           SET completed = true, page = GREATEST(read_progress.page, EXCLUDED.page), updated_at = now()`,
        [uid, live],
      );
      // One tracker push per series, not per chapter, after the write and fire-and-forget. The existing
      // per-user gate trickles them at one every 1.2s, so a big batch is a background drip, not a burst.
      for (const id of live) pushSeriesProgressAsync(uid, id);
    } else {
      // DELETE rather than completed=false: leaving a page pointer behind makes an unread series show as
      // in-progress. reading_events is untouched on purpose, for the same reason it is never cascaded.
      // Nothing is pushed: this leaves the tracker ahead of the app, which is the safe direction, and the
      // monotonic floor makes that explicit rather than accidental.
      await q(`DELETE FROM read_progress WHERE user_id = $1 AND series_id = ANY($2)`, [uid, live]);
      // And the read marks on chapters the server never held (#69, lib/listingProgress): "mark unread" on a
      // follow-only series would otherwise leave every grey row ticked and the Komga run where it was. The
      // bulk READ above stays real-only on purpose -- ticking every listed chapter is a select-mode choice on
      // the series page, never a side effect of a shelf action. Reintroduce by dropping this: "bulk mark-unread
      // clears the read marks too" in listingProgress.int.test.ts finds the marks still there.
      await q(`DELETE FROM listing_progress WHERE user_id = $1 AND series_id = ANY($2)`, [uid, live]);
    }
    return { ok: true, applied: live.length, skipped: skippedOf(b.data.seriesIds, live) };
  });

  app.post('/api/favorites/bulk', async (req, reply) => {
    const b = bulkBody.extend({ favorite: z.boolean() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const uid = userIdOf(req);
    const live = await liveSeries(b.data.seriesIds, vc(req));
    if (b.data.favorite) {
      await q(
        `INSERT INTO favorites (user_id, series_id) SELECT $1, unnest($2::text[])
         ON CONFLICT (user_id, series_id) DO NOTHING`,
        [uid, live],
      );
    } else {
      await q(`DELETE FROM favorites WHERE user_id = $1 AND series_id = ANY($2)`, [uid, live]);
    }
    return { ok: true, applied: live.length, skipped: skippedOf(b.data.seriesIds, live) };
  });

  app.post('/api/collections/:id/items/bulk', async (req, reply) => {
    const b = bulkBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    // The owner's hand-picked list only (v0.61.0): 404 for anyone else's, 409 for a smart list.
    const list = await pickedList(req, reply);
    if (!list) return reply;
    const id = list.id;
    const live = await liveSeries(b.data.seriesIds, vc(req));
    await q(
      `INSERT INTO collection_items (collection_id, series_id, position)
       SELECT $1, s, COALESCE((SELECT max(position) + 1 FROM collection_items WHERE collection_id = $1), 0)
         FROM unnest($2::text[]) s
       ON CONFLICT (collection_id, series_id) DO NOTHING`,
      [id, live],
    );
    return { ok: true, applied: live.length, skipped: skippedOf(b.data.seriesIds, live) };
  });

  // ---- "Fetch newest": the newest listed release of each selected series, as one detached job ----
  //
  // The one bulk action here that fetches bytes from sources, so it carries the gate the whole of
  // routes/sources.ts sits behind: `canDownload: false` denies, an absent permission allows, admins are
  // exempt, and an unreadable user row denies (a database blip must not open the one bulk route that
  // writes to disk). Without it the button's permission is cosmetic: a denied account could still drive
  // downloads by id. Same shape as that file's hook, not a call to it: the hook is plugin-wide there.
  // Reintroduce by dropping this check: "a member without canDownload is refused" in
  // bulkNewest.int.test.ts reads 202.
  //
  // Detached: POST starts the job and answers 202 with the total; GET reports progress and per-series
  // outcomes. A second POST while one runs is 409 `busy` (lib/bulkNewest.ts says why it is not queued).
  const newestBody = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(500) });
  const canDownload = async (req: any): Promise<boolean> => {
    const me = await one<{ role: string; perms: { canDownload?: boolean } | null }>(
      'SELECT role, perms FROM users WHERE id = $1', [userIdOf(req)]).catch(() => null);
    if (!me) return false;
    return actsAsAdmin(req) || me.perms?.canDownload !== false;
  };

  app.post('/api/library/bulk/newest', async (req, reply) => {
    const b = newestBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'ids: one to five hundred series ids.' });
    if (!(await canDownload(req))) {
      return reply.code(403).send({ error: 'forbidden', message: "You don't have permission to download chapters." });
    }
    // Every id goes into the job so the person sees each one settled; only the live ones are ever asked
    // about. An id the viewer cannot see is "not in your library" whether it exists or not -- the same
    // fail-closed answer liveSeries gives every other bulk action.
    const ids = [...new Set(b.data.ids)];
    const live = new Set(await liveSeries(ids, vc(req)));
    const maxAge = vc(req).maxAgeRating;
    const started = startBulkNewest({
      ids, live, busy: jobBusy, userId: userIdOf(req),
      sourceAllowed: (sourceId) => sourceAllowedFor(getSource(sourceId), maxAge),
    });
    if (!started) return reply.code(409).send({ error: 'busy', message: 'A Fetch newest run is already going. Wait for it to finish.' });
    await logAudit('download.bulk_newest', { userId: userIdOf(req), detail: { count: live.size, asked: ids.length }, req });
    return reply.code(202).send({ ok: true, total: started.total });
  });

  // Counts for everyone, results for the starter and admins (lib/bulkNewest.ts says why).
  app.get('/api/library/bulk/newest', async (req) => bulkNewestState({ userId: userIdOf(req), admin: actsAsAdmin(req) }));

  // ---- external progress trackers (AniList) ----
  app.get('/api/trackers', async (req) => ({ content: await statusFor(userIdOf(req)) }));

  // Connect by pasting a token, for any provider. This is the honest, dependency-free path: a full OAuth
  // dance would make every self-hoster register an application with each service and keep its secret in
  // their compose file, which is a worse trade for a household app than copying a token once. Since v0.61.0
  // AniList's token comes from the project's own public client, whose page shows it to copy -- still a paste,
  // with no secret anywhere (trackerProviders.ts ANILIST_CLIENT_ID).
  //
  // The token is verified against the service before it is stored, so a typo fails here with the service's
  // own answer rather than silently at 3am when the first chapter tries to sync.
  //
  // Only the service's verdict on the token is a 400 `rejected` (v0.61.0, #190). Every failure used to be, so a DNS
  // failure, Cloudflare's 403 in front of AniList or an outage all read "AniList did not accept that token" and sent
  // the person back for a new one. No answer at all is a 502 `tracker_unreachable`; an answer that refused the request
  // for another reason is a 502 `tracker_refused` with the service's `status` (lib/trackerProviders.ts verdictOf).
  // Reintroduce by answering 400 `rejected` in the catch again: "connect: a network throw is 502 tracker_unreachable"
  // in trackerVerdicts.int.test.ts fails.
  const connectTracker = async (provider: Provider, req: any, reply: any) => {
    const b = z.object({ token: z.string().min(10).max(4000) }).safeParse(req.body);
    const adapter = ADAPTERS[provider];
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: `Paste your ${adapter.label} token.` });
    let who;
    try {
      who = await whoAmI(b.data.token.trim(), provider);
    } catch (e) {
      const v = verdictOf(e);
      if (v.verdict !== 'rejected') req.log.warn({ provider, verdict: v.verdict, status: v.status, err: (e as Error)?.message }, 'tracker connect: the token could not be checked');
      if (v.verdict === 'unreachable') {
        return reply.code(502).send({ error: 'tracker_unreachable', message: `Could not reach ${adapter.label}. Try again in a moment.` });
      }
      if (v.verdict === 'refused') {
        return reply.code(502).send({
          error: 'tracker_refused', ...(v.status ? { status: v.status } : {}),
          message: `${adapter.label} refused the request${v.status ? ` (HTTP ${v.status})` : ''}. That is not about the token; try again later.`,
        });
      }
      return reply.code(400).send({ error: 'rejected', message: `${adapter.label} did not accept that token.` });
    }
    if (!who) return reply.code(400).send({ error: 'rejected', message: `${adapter.label} did not accept that token.` });
    // Record the expiry so the UI can warn before it lapses; none of these services can refresh silently.
    const expires = adapter.tokenDays ? new Date(Date.now() + adapter.tokenDays * 86400000) : null;
    await saveConnection(userIdOf(req), provider, b.data.token.trim(), who.name, expires);
    await logAudit('tracker.connect', { userId: userIdOf(req), detail: { provider, account: who.name }, req });
    return { ok: true, account: who.name };
  };

  // Kept as its own path for the clients and docs that already reference it.
  app.post('/api/trackers/anilist', async (req, reply) => connectTracker('anilist', req, reply));

  app.post('/api/trackers/:provider/connect', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    if (!isProvider(provider)) return reply.code(404).send({ error: 'unknown_provider' });
    return connectTracker(provider, req, reply);
  });

  // Test connection (v0.61.0, #190): does the saved token still work? One call to the service (lib/trackers.ts
  // testConnection), always a 200 that says which -- `connected` with the account, or `rejected`, `unreachable`,
  // `refused` (+ `status`), `expired`, `not_connected` -- and nothing is written. Six a minute per account: each one is
  // a request to someone else's service. `hook: 'preHandler'` puts the limiter after authenticate, so the key is the
  // account (the notify-target Test's pattern). Reintroduce by dropping the rateLimit config: "the seventh test in a
  // minute is a 429" in trackerVerdicts.int.test.ts sees a 200.
  app.post('/api/trackers/:provider/test', {
    config: {
      rateLimit: {
        max: 6,
        timeWindow: '1 minute',
        hook: 'preHandler',
        keyGenerator: (req) => `tracker-test:${userIdOf(req)}`,
      },
    },
  }, async (req, reply) => {
    const { provider } = req.params as { provider: string };
    if (!isProvider(provider)) return reply.code(404).send({ error: 'unknown_provider' });
    return testConnection(userIdOf(req), provider);
  });

  app.delete('/api/trackers/:provider', async (req) => {
    const { provider } = req.params as { provider: string };
    if (!isProvider(provider)) return { ok: true };   // nothing to disconnect from a name we do not have
    await disconnect(userIdOf(req), provider);
    await logAudit('tracker.disconnect', { userId: userIdOf(req), detail: { provider }, req });
    return { ok: true };
  });

  // Push everything already finished, for a freshly-connected account.
  app.post('/api/trackers/anilist/backfill', async (req) => {
    const uid = userIdOf(req);
    const rows = await q<{ series_id: string }>(
      `SELECT DISTINCT rp.series_id FROM read_progress rp
         JOIN series_trackers st ON st.series_id = rp.series_id AND st.provider = 'anilist'
        WHERE rp.user_id = $1 AND rp.completed = true`,
      [uid],
    );
    void (async () => { for (const r of rows) await pushSeriesProgress(uid, r.series_id).catch(() => {}); })();
    return { ok: true, series: rows.length };
  });

  // Allow the next push for one series to go DOWN.
  //
  // Progress is otherwise monotonic, because a tracker accepts a lower number and rewrites the entry with no
  // undo. That is the right default, but it is wrong in one case: the tracker is ahead because the old
  // chapter number was wrong and the correction is the smaller one. Lowering a number on someone's real
  // account should be a deliberate act, so it is this route and not a side effect of anything else.
  // Every provider, not only AniList: the floor is kept per provider, and answering 400 for MAL and Kitsu
  // left their floors permanent -- a stamped floor on those two had no way down at all. An unknown name is
  // a 404 like the other :provider routes. ⚠️ Reintroduce by clearing without the provider: the default
  // argument is 'anilist', so a MAL resync would wipe the AniList floor and leave the MAL one standing.
  app.post('/api/trackers/:provider/resync/:seriesId', async (req, reply) => {
    const { provider, seriesId } = req.params as { provider: string; seriesId: string };
    if (!isProvider(provider)) return reply.code(404).send({ error: 'unknown_provider' });
    const uid = userIdOf(req);
    await clearTrackerFloor(uid, seriesId, provider);
    // `lower`: since v0.61.2 a push sends nothing to a service already at or past this chapter (pushStatus), and this
    // route is the one place a lower number is the point. Only for the provider asked about.
    await pushSeriesProgress(uid, seriesId, { lower: provider }).catch(() => {});
    return { ok: true };
  });

  app.get('/api/settings', async (req) => {
    const uid = userIdOf(req);
    const row = await one<{ data: unknown }>('SELECT data FROM app_settings WHERE user_id = $1', [uid]);
    return row?.data ?? {};
  });

  app.put('/api/settings', async (req, reply) => {
    const uid = userIdOf(req);
    // zod 4 requires a key schema as well as a value schema; z.record(valueOnly) was a v3 signature.
    const body = z.record(z.string(), z.any()).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'bad_settings', message: 'Settings must be an object.' });
    const data = body.data;
    // Most of this object intentionally remains forwards-compatible: old servers must retain settings written
    // by a newer web client.  The settings that alter navigation or name database rows are stricter, though.
    // Without this boundary an arbitrary sort leaks into the catalogue query, and a forged collection id can
    // make Home disclose whether another account owns it.
    if ('librarySort' in data) {
      // v0.58.0: Most popular, Top rated, My rating, Most chapters and Recently read (web/components/LibraryFilters.tsx).
      // v0.61.0: Releasing soon (`soon`, the release radar's estimate; web/lib/librarySort.ts).
      const sort = z.enum(['updated', 'new', 'az', 'unread', 'popular', 'score', 'rating', 'chapters', 'read', 'soon']).safeParse(data.librarySort);
      if (!sort.success) return reply.code(400).send({ error: 'bad_settings', message: 'Choose a valid Library sort.' });
      data.librarySort = sort.data;
    }
    // v0.60.0: the Library's sort order, High to low or Low to high (web/components/LibraryToolbar.tsx); null goes back to
    // the sort's own direction. It reaches the catalogue query as `field,asc|desc`, so only these. Reintroduce by
    // accepting anything: "a sort order other than asc or desc" in settingsV558.int.test.ts saves it.
    if ('librarySortDir' in data && data.librarySortDir !== null) {
      const dir = z.enum(['asc', 'desc']).safeParse(data.librarySortDir);
      if (!dir.success) return reply.code(400).send({ error: 'bad_settings', message: 'Choose High to low or Low to high.' });
      data.librarySortDir = dir.data;
    }
    // v0.69.1: the avatar is painted for other members (web/components/Avatar.tsx), its colour into an inline background,
    // where a stored `url(https://…)` made every viewer's browser fetch a URL the member chose. A hex colour and a short
    // emoji, or nothing. Reintroduce by accepting any object: "an avatar colour must be a hex colour" in
    // settingsV558.int.test.ts saves a url().
    // v0.89.0 (#267 part 3, CheetahDoesStuff): a frame round the avatar, a badge's reward (lib/badges.ts), and only one this
    // account has earned -- everyone in the household sees it. The frame already worn is kept on any other change, so an
    // emoji can be changed under it without its badge being measured again. Leaving `frame` out takes it off. Reintroduce
    // by accepting any frame: "only an earned frame can be worn" in avatarFrames.int.test.ts saves Legend's on day one.
    if ('avatar' in data && data.avatar !== null) {
      const av = z.object({ emoji: z.string().max(16).optional(), color: z.string().regex(HEX_COLOR).optional(), frame: z.enum(FRAMES).optional() }).safeParse(data.avatar); // unknown keys are dropped
      if (!av.success) return reply.code(400).send({ error: 'bad_settings', message: 'An avatar is an emoji and a colour.' });
      const frame = av.data.frame;
      if (frame) {
        const worn = (await one<{ f: string | null }>(`SELECT avatar->>'frame' AS f FROM users WHERE id = $1`, [uid]))?.f;
        if (frame !== worn && !(await earnedFrames(uid)).has(frame)) {
          return reply.code(403).send({ error: 'frame_locked', message: `Earn the ${badgeOfFrame(frame).name} badge first.` });
        }
      }
      data.avatar = av.data;
    }
    if ('accent' in data && data.accent !== null && !(typeof data.accent === 'string' && HEX_COLOR.test(data.accent))) {
      return reply.code(400).send({ error: 'bad_settings', message: 'Choose a colour.' });
    }
    if ('showAllChapters' in data && typeof data.showAllChapters !== 'boolean') {
      return reply.code(400).send({ error: 'bad_settings', message: 'Show all chapters must be on or off.' });
    }
    // v0.61.0, Incognito reading (lib/incognito.ts): the whole account's, read by the server on every progress write and
    // tracker push, so only a real boolean. Reintroduce by accepting anything: "Incognito must be on or off" in
    // incognito.int.test.ts saves "yes".
    if ('incognito' in data && typeof data.incognito !== 'boolean') {
      return reply.code(400).send({ error: 'bad_settings', message: 'Incognito reading must be on or off.' });
    }
    // v0.68.0, #223: whether a series this account adds goes on its trackers as Plan to Read (lib/trackers.ts
    // planSeriesOnAdd), read by the server at every add, so only a real boolean. Reintroduce by accepting anything:
    // "Plan to read on add must be on or off" in planOnAdd.int.test.ts saves "yes".
    if ('trackerPlanOnAdd' in data && typeof data.trackerPlanOnAdd !== 'boolean') {
      return reply.code(400).send({ error: 'bad_settings', message: 'Plan to read on add must be on or off.' });
    }
    // v0.90.0: Comments and reactions (lib/comments.ts talkWanted), read by the server on every answer about talk and every
    // comment's alerts, so only a real boolean. Reintroduce by accepting anything: `{ comments: 'no' }` in
    // settingsV558.int.test.ts saves with 200.
    if ('comments' in data && typeof data.comments !== 'boolean') {
      return reply.code(400).send({ error: 'bad_settings', message: 'Comments and reactions must be on or off.' });
    }
    if ('homeCollections' in data) {
      const parsed = z.array(z.string().min(1).max(64)).max(30).safeParse(data.homeCollections);
      if (!parsed.success) return reply.code(400).send({ error: 'bad_settings', message: 'Choose up to three lists for Home.' });
      const ids = [...new Set(parsed.data)];
      if (ids.length > 3) return reply.code(400).send({ error: 'bad_settings', message: 'Choose up to three lists for Home.' });
      if (ids.length) {
        // The caller's own lists, or one shared with the household (v0.61.0) -- never another member's private list,
        // which would let Home say whether an id exists. A malformed id is no list, not a uuid cast error. Reintroduce by
        // dropping `user_id = $1 OR`: "Home's lists take a shared list and refuse another member's private one" in
        // lists.int.test.ts saves the private id.
        const uuids = ids.filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
        const readable = uuids.length === ids.length
          ? await q<{ id: string }>('SELECT id FROM collections WHERE (user_id = $1 OR shared) AND id = ANY($2::uuid[])', [uid, ids])
          : [];
        if (readable.length !== ids.length) {
          return reply.code(400).send({ error: 'bad_settings', message: 'One of those lists is no longer available.' });
        }
      }
      data.homeCollections = ids;
    }
    await q(
      `INSERT INTO app_settings (user_id, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (user_id) DO UPDATE SET data = app_settings.data || EXCLUDED.data`,
      [uid, JSON.stringify(data)],
    );
    // avatar is identity shown to other household members -> mirror onto the users row
    if (data.avatar && typeof data.avatar === 'object') {
      await q('UPDATE users SET avatar = $2 WHERE id = $1', [uid, JSON.stringify(data.avatar)]);
    }
    // ...and so is the name. Only an admin could set one, and only when creating the account, so anyone
    // whose display_name was left at the default saw a generic fallback where their name should be, forever,
    // with nothing on screen suggesting a cause or a fix. Stored on the users row rather than in the
    // free-form settings blob because other members read it (the leaderboard, member activity, sessions).
    if (typeof data.displayName === 'string') {
      const name = data.displayName.trim().slice(0, 40);
      if (name) await q('UPDATE users SET display_name = $2 WHERE id = $1', [uid, name]);
    }
    const row = await one<{ data: unknown }>('SELECT data FROM app_settings WHERE user_id = $1', [uid]);
    return row?.data ?? {};
  });
}
