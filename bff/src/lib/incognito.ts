// Incognito reading (v0.61.0): an account switch, Profile → Settings → Reading (and the reader's own sheet).
//
// While it is on, reading still keeps your place -- read_progress is written, so Keep reading and every resume work as
// before -- but it leaves no trace anywhere else: no reading_events row (history, streaks, Wrapped, the leaderboard,
// the household's Top 10, an admin's member activity and Keep reading's "last device" all read that table), and nothing
// is sent to a tracker. The owner's ruling: it covers the WHOLE account, enforced here on the server, so a phone that
// never heard of the switch -- Mihon, an old tab, the offline outbox -- cannot leave a trace either.
//
// What it does not do is rewrite a tracker afterwards: the next push for a series, once it is off, sends the real
// highest chapter read (lib/trackers.ts seriesProgressFor), so the tracker catches up then.
import { one } from './db';

/**
 * Whether the account's Incognito reading is on: one primary-key read of app_settings. ⚠️ FAILS CLOSED -- a read that
 * errors answers ON. Reading recorded while the switch was on cannot be taken back (a tracker keeps what it is told),
 * while a chapter left out of history during a database hiccup costs a streak day at most. Reintroduce by answering
 * false on an error: "a failed read of the switch is treated as on" in incognito.int.test.ts finds an event written.
 */
export async function incognitoOn(uid: string): Promise<boolean> {
  try {
    const row = await one<{ on: boolean | null }>(`SELECT (data -> 'incognito') = 'true'::jsonb AS on FROM app_settings WHERE user_id = $1`, [uid]);
    return row?.on === true;
  } catch {
    return true;
  }
}
