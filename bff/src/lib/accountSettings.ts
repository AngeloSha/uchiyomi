// What `PUT /api/settings` checks before it merges a body into the account's settings row.
//
// The row is a free-form jsonb blob (reader prefs, accent, avatar, weeklyGoal, ...) and most keys are still
// taken as sent. The few that are plain switches the web app mirrors into localStorage are held to a boolean,
// because the client trusts what the server hands back: a string "false" in `showGhosts` would read as truthy
// there. Everything else passes through untouched.
import { z } from 'zod';

/**
 * The device-level switches that became account settings. Each is mirrored to localStorage by the web app so the
 * first paint and an offline launch do not wait for the server (web/lib/accountPrefs.ts):
 *   - `showGhosts`: show chapters the sources list that this server lacks (default on);
 *   - `alsoFollow`: the Add dialog's "also check the other sources" switch (default off);
 */
export const ACCOUNT_BOOL_SETTINGS = ['showGhosts', 'alsoFollow'] as const;

const shape = Object.fromEntries(ACCOUNT_BOOL_SETTINGS.map((k) => [k, z.boolean().optional()]));

/** The settings body: any object, with the keys above required to be booleans when present. */
export const settingsBody = z.record(z.string(), z.any()).superRefine((body, ctx) => {
  const r = z.object(shape).safeParse(Object.fromEntries(ACCOUNT_BOOL_SETTINGS.filter((k) => k in body).map((k) => [k, body[k]])));
  if (!r.success) for (const i of r.error.issues) ctx.addIssue({ code: 'custom', path: i.path, message: i.message });
});
