/**
 * Notification targets beyond web push (v0.43.0, #70): the stored targets, the one delivery path, the
 * per-sweep digest and the health fan-out.
 *
 * Two ways in, and only two:
 *
 *   * `sendDigest` -- ONCE per sweep, from the end of `runSweep` (updater.ts), summarising every chapter the
 *     sweep landed: "5 new chapters in 3 series". Not per series: web push survives twenty events a night
 *     because its per-series tag collapses them; a webhook or a phone does not. A manual "check now" sends
 *     nothing, because its result is already on the screen of the person who asked.
 *   * `notifyTargetsOfHealth` -- the existing `notifyAdmins` cases (a source refusing this server, the
 *     solver, the extension monitor), for targets that asked for `health`. Called as the FIRST line of
 *     `notifyAdmins`, before push's `if (!enabled) return` -- an install whose VAPID keys could not be written
 *     is exactly the install that needs another channel, and inside that early return every target would be
 *     silently dead.
 *
 * Neither ever throws into its caller, and a failing target cannot delay a sweep: each target has its own
 * gate lane, and the sweep does not wait for any of them.
 */
import { q, one } from '../db';
import { open, seal } from '../secretbox';
import { withGate } from '../gate';
import { notifyAdmins } from '../push';
import { browsableIds, SYSTEM_CTX, viewCtxFor, type ViewCtx } from '../visibility';
import { buildRequest, discordText, type Kind, type Message, type TargetConfig, type TargetSecret } from './kinds';
import { REASON_TEXT, sendRequest, type SendOptions, type SendResult } from './send';
import { renderDigest } from './template';

/** Consecutive failed deliveries after which a target is switched off, with one notice to the admins. */
export const AUTO_DISABLE_AFTER = 10;

export interface TargetRow {
  id: string;
  kind: Kind;
  name: string;
  config: TargetConfig;
  secret: string | null;
  user_id: string | null;
  events: string[];
  template: string | null;
  enabled: boolean;
  include_adult: boolean;
  consecutive_failures: number;
  last_ok_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  created_at: string;
  updated_at: string;
}

export const sealSecret = (s: TargetSecret): string => seal(JSON.stringify(s), 'notify');

/** The stored address and token, or null when they cannot be read (a rotated JWT_SECRET, a damaged row). */
export function openSecret(sealed: string | null): TargetSecret | null {
  if (!sealed) return null;
  const plain = open(sealed, 'notify');
  if (plain === null) return null;
  try {
    const s = JSON.parse(plain) as TargetSecret;
    return s && typeof s.url === 'string' ? s : null;
  } catch {
    return null;
  }
}

/**
 * What the admin panel and the API see of a target. The display form is scheme and host only; the address,
 * the token and the ntfy topic are NEVER returned, and there is no endpoint that reveals them -- changing
 * one means typing it again. A screenshot of this panel pasted into a GitHub issue must not leak a webhook.
 */
export function toDto(r: TargetRow & { user_name?: string | null }) {
  const okAt = r.last_ok_at ? new Date(r.last_ok_at).getTime() : 0;
  const errAt = r.last_error_at ? new Date(r.last_error_at).getTime() : 0;
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    target: r.config?.display ?? '',
    service: r.config?.service ?? null,
    hasToken: !!r.config?.hasToken,
    userId: r.user_id,
    userName: r.user_name ?? null,
    events: r.events,
    template: r.template,
    enabled: r.enabled,
    includeAdult: !!r.include_adult,
    consecutiveFailures: r.consecutive_failures,
    lastOkAt: r.last_ok_at,
    lastError: r.last_error,
    lastErrorMessage: r.last_error ? (REASON_TEXT as Record<string, string>)[r.last_error] ?? null : null,
    lastErrorAt: r.last_error_at,
    lastResult: !okAt && !errAt ? null : okAt >= errAt ? 'ok' : 'error',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLS = `t.id, t.kind, t.name, t.config, t.secret, t.user_id, t.events, t.template, t.enabled, t.include_adult,
  t.consecutive_failures, t.last_ok_at, t.last_error, t.last_error_at, t.created_at, t.updated_at`;

export const listTargets = () =>
  q<TargetRow & { user_name: string | null }>(
    `SELECT ${COLS}, u.username AS user_name FROM notify_targets t LEFT JOIN users u ON u.id = t.user_id ORDER BY t.created_at`);

export const getTarget = (id: string) =>
  one<TargetRow & { user_name: string | null }>(
    `SELECT ${COLS}, u.username AS user_name FROM notify_targets t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [id]);

/**
 * Record a failed delivery, and switch the target off on the one failure that makes it the tenth in a row.
 *
 * EDGE-TRIGGERED, like the solver watch in server.ts: the notice goes out when the target goes from on to
 * off, never again while it stays off. `was_enabled` is read under the row lock in the same statement, so two
 * failures landing together cannot both see the transition.
 * Reintroduce by notifying whenever `consecutive_failures >= 10`: "the tenth failure switches a target off and
 * tells the admins once" in notifyTargets.int.test.ts counts two notices.
 */
async function recordFailure(row: TargetRow, reason: string): Promise<void> {
  const r = await one<{ was_enabled: boolean; enabled: boolean; consecutive_failures: number }>(
    `WITH old AS (SELECT id, enabled FROM notify_targets WHERE id = $1 FOR UPDATE)
     UPDATE notify_targets t
        SET consecutive_failures = t.consecutive_failures + 1,
            last_error = $2, last_error_at = now(),
            enabled = CASE WHEN t.consecutive_failures + 1 >= $3 THEN false ELSE t.enabled END
       FROM old WHERE t.id = old.id
     RETURNING old.enabled AS was_enabled, t.enabled, t.consecutive_failures`,
    [row.id, reason, AUTO_DISABLE_AFTER],
  );
  if (r?.was_enabled && !r.enabled) {
    // Through notifyAdmins, so it reaches web push AND every other target that asked for health -- this one
    // is off now, so it is not among them and there is no loop.
    await notifyAdmins(
      'A notification target was switched off',
      `"${row.name}" failed ${r.consecutive_failures} times in a row (${(REASON_TEXT as Record<string, string>)[reason] ?? reason}). Fix it and switch it back on under Admin → Settings → Notifications.`,
      '/admin/?tab=settings',
      'notify',
    ).catch(() => {});
  }
}

export interface DeliverOptions extends SendOptions {
  /**
   * `count`: a real notification -- a failure counts towards the switch-off. `test`: the admin's Test button
   * -- the result is recorded so the panel shows it, and a success clears the streak, but a failure does
   * NOT count: five Tests a minute while someone is fixing a token must not switch the target off under them.
   */
  mode?: 'count' | 'test';
}

/**
 * Deliver one message to one target and record the outcome on its row.
 *
 * A secret that cannot be decrypted STOPS here, with a sentence that says so. Sending without it would be an
 * unauthenticated request whose 401 reads as "your token is wrong" -- and for Discord or ntfy there would be
 * no address to send to at all.
 * Reintroduce by building the request from what is left when `openSecret` returns null: "an undecryptable
 * secret sends nothing and says why" in notifySend.test.ts sees a request arrive, and "an undecryptable secret
 * stops the send" in notifyTargets.int.test.ts gets an answer other than secret_unreadable.
 */
export async function deliver(row: TargetRow, msg: Message, opts: DeliverOptions = {}): Promise<SendResult> {
  const mode = opts.mode ?? 'count';
  const secret = openSecret(row.secret);
  const req = secret ? buildRequest(row.kind, secret, row.config ?? { display: '' }, msg) : null;
  const res: SendResult = req
    ? await withGate(`notify:${row.id}`, () => sendRequest(req, opts), { concurrency: 1, minGapMs: 1000 })
    : { ok: false, status: null, reason: 'secret_unreadable' };
  try {
    if (res.ok) {
      await q('UPDATE notify_targets SET consecutive_failures = 0, last_ok_at = now() WHERE id = $1', [row.id]);
    } else if (mode === 'test') {
      await q('UPDATE notify_targets SET last_error = $2, last_error_at = now() WHERE id = $1', [row.id, res.reason]);
    } else {
      await recordFailure(row, res.reason);
    }
  } catch { /* the delivery happened or did not; a bookkeeping failure must not turn into a throw */ }
  return res;
}

async function serverName(): Promise<string> {
  const s = await one<{ server_name: string | null }>('SELECT server_name FROM server_settings WHERE id = 1').catch(() => null);
  return s?.server_name?.trim() || 'Uchiyomi';
}

export interface Landed { id: string; title: string; added: number }

/**
 * The digest's text for one target. Discord renders markdown, and a title is scraped from a third-party site,
 * so for Discord each title is escaped before it is placed: "[Chapter 99 is FREE here](https://…)" must arrive
 * as text, not as a masked link in the admin's channel (mentions are already off in kinds.ts). The admin's own
 * template is left alone -- its markdown is theirs -- and every other kind gets the titles as spelled, since
 * JSON and ntfy's plain text render nothing.
 * Reintroduce by rendering the Discord digest from the raw titles: "A SCRAPED TITLE CANNOT PLANT A LINK IN
 * DISCORD" in notifyTargets.int.test.ts sees the masked link arrive intact.
 */
function digestText(t: Pick<TargetRow, 'kind' | 'template'>, series: ReadonlyArray<Landed>): string {
  return renderDigest(t.template, t.kind === 'discord' ? series.map((s) => ({ ...s, title: discordText(s.title) })) : series);
}

/**
 * ONE message per target for everything a sweep landed.
 *
 * A target aimed at a person (`user_id`) hears only about that person's favourites -- the web-push rule,
 * `favorites` by series id -- and nothing at all when none of theirs moved. A sweep that landed nothing sends
 * nothing to anyone.
 *
 * ⚠️ A FAVOURITE IS NOT ACCESS. It can predate an age cap or a revoked library grant, and the plain
 * POST /api/favorites stores any id. So what a target may name goes through `browsableIds` as well: a person's
 * target under that person's own libraries and age cap -- permissions no switch overrides -- and every target
 * under the 18+ hide unless it opted in with `include_adult` (the web app's Show 18+ is a session cookie the
 * server never sees, so the target carries its own choice, as an OPDS link and an API token do). Both fail
 * CLOSED: a lookup that throws sends nothing to that target rather than everything.
 * Reintroduce by delivering once per series: "one sweep, three series, one message per target" counts three.
 * Reintroduce by dropping the browsableIds filter: "THE DIGEST LEAVES 18+ LIBRARIES OUT UNLESS A TARGET OPTS
 * IN" in notifyTargets.int.test.ts sees the server-wide target name "Adult Title".
 */
export async function sendDigest(landed: ReadonlyArray<Landed>, opts: SendOptions = {}): Promise<void> {
  const moved = landed.filter((s) => s.added > 0);
  if (!moved.length) return;
  const targets = await q<TargetRow & { user_role: string | null }>(
    `SELECT ${COLS}, u.role AS user_role FROM notify_targets t LEFT JOIN users u ON u.id = t.user_id
      WHERE t.enabled AND 'new_chapters' = ANY(t.events)`).catch(() => [] as Array<TargetRow & { user_role: string | null }>);
  if (!targets.length) return;
  const title = await serverName();
  await Promise.all(targets.map(async (t) => {
    let series = moved;
    if (t.user_id) {
      const fav = await q<{ series_id: string }>(
        'SELECT series_id FROM favorites WHERE user_id = $1 AND series_id = ANY($2)', [t.user_id, moved.map((s) => s.id)]).catch(() => []);
      const mine = new Set(fav.map((f) => f.series_id));
      series = moved.filter((s) => mine.has(s.id));
    }
    if (!series.length) return;
    let ctx: ViewCtx;
    try {
      const who = t.user_id ? await viewCtxFor(t.user_id, t.user_role ?? 'user') : SYSTEM_CTX;
      ctx = { ...who, hideAdultLibraries: !t.include_adult };
    } catch { return; }
    const allowed = await browsableIds(series.map((s) => s.id), ctx); // empty on a failed query: sends nothing
    series = series.filter((s) => allowed.has(s.id));
    if (!series.length) return;
    const count = series.reduce((n, s) => n + s.added, 0);
    await deliver(t, {
      event: 'new_chapters', title, message: digestText(t, series), count,
      series: series.map((s) => ({ id: s.id, title: s.title, added: s.added })),
    }, { retry: true, ...opts }).catch(() => {});
  }));
}

/**
 * The admins' notices, to every target that asked for `health`.
 *
 * Admin-only, as push's `notifyAdmins` is: a target aimed at a person who is NOT an admin never hears that a
 * source is refusing this server -- they cannot act on it.
 */
export async function notifyTargetsOfHealth(title: string, body: string, opts: SendOptions = {}): Promise<void> {
  const targets = await q<TargetRow>(
    `SELECT ${COLS} FROM notify_targets t
      WHERE t.enabled AND 'health' = ANY(t.events)
        AND (t.user_id IS NULL OR EXISTS (SELECT 1 FROM users u WHERE u.id = t.user_id AND u.role = 'admin'))`).catch(() => [] as TargetRow[]);
  await Promise.all(targets.map((t) =>
    deliver(t, { event: 'health', title, message: body, count: 0, series: [] }, { retry: true, ...opts }).catch(() => {})));
}
