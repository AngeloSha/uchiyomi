// What we report to an external tracker is computed in SQL, so it needs a real Postgres to verify.
//
// The rule under test is the one that's easy to get wrong and impossible to notice: progress is the highest
// COMPLETED chapter, not the last one touched. Get it backwards and re-reading an early chapter silently
// rewinds someone's AniList list by a few hundred chapters, which is the kind of damage people don't forgive.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}

const SERIES = 's_test_tracker';

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { seriesProgressFor } = await import('../src/lib/trackers');
  await migrate();
  await q(`DELETE FROM users WHERE username = $1`, ['tracker-test']);
  await q(`DELETE FROM lib_series WHERE id = $1`, [SERIES]); // cascades to lib_books
  await q(
    `INSERT INTO lib_series (id, source, title, folder) VALUES ($1,'test','Tracker Test Series',$1)`,
    [SERIES],
  );
  const rows = await q(
    `INSERT INTO users (username, display_name, password_hash, role) VALUES ($1,$2,$3,'user') RETURNING id`,
    ['tracker-test', 'Tracker Test', 'x'],
  );
  return { q, seriesProgressFor, userId: rows[0].id as string };
}

test('tracker progress reflects the highest completed chapter', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async (t) => {
  const { q, seriesProgressFor, userId } = await setup();

  // five chapters, numbered 1..5
  for (let n = 1; n <= 5; n++) {
    await q(
      `INSERT INTO lib_books (id, series_id, source, file, title, number) VALUES ($1,$2,'test',$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET number = EXCLUDED.number`,
      [`b_tracker_${n}`, SERIES, `/test/tracker/${n}.cbz`, `Chapter ${n}`, n],
    );
  }
  const mark = (n: number, completed: boolean) =>
    q(
      `INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,$2,$3,1,$4)
       ON CONFLICT (user_id, book_id) DO UPDATE SET completed = EXCLUDED.completed`,
      [userId, `b_tracker_${n}`, SERIES, completed],
    );

  await t.test('nothing read yet reports zero and is not finished', async () => {
    const p = await seriesProgressFor(userId, SERIES);
    assert.deepEqual(p, { chapters: 0, finished: false });
  });

  await t.test('reading in order advances progress', async () => {
    await mark(1, true);
    await mark(2, true);
    assert.deepEqual(await seriesProgressFor(userId, SERIES), { chapters: 2, finished: false });
  });

  await t.test('finishing a later chapter out of order jumps ahead', async () => {
    await mark(4, true);
    const p = await seriesProgressFor(userId, SERIES);
    assert.equal(p.chapters, 4, 'should report the highest completed chapter, not the count of them');
    assert.equal(p.finished, false, 'chapters 3 and 5 are still unread');
  });

  await t.test('re-reading an early chapter does not rewind the tracker', async () => {
    // the regression that matters: an organic ping on chapter 1 while 4 is already done
    await mark(1, true);
    assert.equal((await seriesProgressFor(userId, SERIES)).chapters, 4);
  });

  await t.test('finished only when every chapter is complete', async () => {
    await mark(3, true);
    assert.equal((await seriesProgressFor(userId, SERIES)).finished, false, '5 still unread');
    await mark(5, true);
    assert.deepEqual(await seriesProgressFor(userId, SERIES), { chapters: 5, finished: true });
  });

  await t.test('explicitly un-reading the top chapter walks progress back down', async () => {
    // mark-unread is deliberate user intent, so it should be honoured
    await mark(5, false);
    assert.deepEqual(await seriesProgressFor(userId, SERIES), { chapters: 4, finished: false });
  });

  await t.test('another user sees their own progress, not this one', async () => {
    const other = await q(
      `INSERT INTO users (username, display_name, password_hash, role) VALUES ($1,$2,$3,'user') RETURNING id`,
      ['tracker-test-2', 'Other', 'x'],
    );
    assert.deepEqual(await seriesProgressFor(other[0].id, SERIES), { chapters: 0, finished: false });
    await q(`DELETE FROM users WHERE username = $1`, ['tracker-test-2']);
  });

  await q(`DELETE FROM users WHERE username = $1`, ['tracker-test']);
  await q(`DELETE FROM lib_series WHERE id = $1`, [SERIES]);
});

// ---- the floor a tracker import seeds ---------------------------------------------------------------------
//
// pushOne's only protection against walking someone's real tracker entry backwards is the high-water mark in
// tracker_progress, and before v0.36.0 that row only existed once THIS app had pushed. A series imported from
// a list at chapter 150 had no floor at all, so the first chapter finished here would have sent "1" -- the
// one failure the module calls unrepairable, made routine by the feature whose point is syncing from day one.
// The import now seeds the floor from the tracker's own count with `pushed_at` NULL, and pushOne tells the
// two floors apart: at or below a seeded one it passes quietly (nothing was ever sent; the tracker is simply
// ahead, or already holds that number), below a pushed one it still refuses with the message, because that
// is a number this app sent. A fresh read of the list REPLACES the floor whatever stood there, so pressing
// Load list again is how a person takes a downward correction they made on the tracker.
//
// MyAnimeList is the provider here because its push is a PATCH the stub can see; the rule is provider-blind.
const FLOOR_SERIES = 's_trk_floor';
const pushes: Array<{ method: string; url: string; body: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: any, init?: any) => {
  const url = String(u);
  if (!/api\.myanimelist\.net/.test(url)) return realFetch(u, init);
  pushes.push({ method: String(init?.method ?? 'GET'), url, body: String(init?.body ?? '') });
  return new Response(JSON.stringify({ status: 'reading' }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

test('the push floor a tracker import seeds', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async (t) => {
  const { migrate } = await import('../src/lib/migrate');
  const { q, one } = await import('../src/lib/db');
  const trackers = await import('../src/lib/trackers');
  await migrate();
  await q(`DELETE FROM users WHERE username = $1`, ['tracker-floor']);
  await q(`DELETE FROM lib_series WHERE id = $1`, [FLOOR_SERIES]);
  await q(`INSERT INTO lib_series (id, source, title, folder) VALUES ($1,'test','Floor Test Series',$1)`, [FLOOR_SERIES]);
  const u = await q(
    `INSERT INTO users (username, display_name, password_hash, role) VALUES ($1,$2,$3,'user') RETURNING id`,
    ['tracker-floor', 'Floor', 'x'],
  );
  const userId = u[0].id as string;
  const book = async (n: number, completed: boolean) => {
    await q(
      `INSERT INTO lib_books (id, series_id, source, file, title, number) VALUES ($1,$2,'test',$3,$4,$5)
       ON CONFLICT (id) DO NOTHING`,
      [`b_floor_${n}`, FLOOR_SERIES, `/test/floor/${n}.cbz`, `Chapter ${n}`, n],
    );
    await q(
      `INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,$2,$3,1,$4)
       ON CONFLICT (user_id, book_id) DO UPDATE SET completed = EXCLUDED.completed`,
      [userId, `b_floor_${n}`, FLOOR_SERIES, completed],
    );
  };
  const conn = () => one<{ last_error: string | null; enabled: boolean }>(
    `SELECT last_error, enabled FROM user_trackers WHERE user_id = $1 AND provider = 'myanimelist'`, [userId]);
  const floor = () => one<{ chapters: number; pushed_at: string | null }>(
    `SELECT chapters, pushed_at FROM tracker_progress WHERE user_id = $1 AND series_id = $2 AND provider = 'myanimelist'`,
    [userId, FLOOR_SERIES]);

  try {
    await trackers.saveConnection(userId, 'myanimelist', 'tok-mal', 'me-on-mal', new Date(Date.now() + 86_400_000));
    await trackers.linkSeries(FLOOR_SERIES, '777', 'Floor Test Series', userId, 'myanimelist');

    await t.test('a floor seeded from the tracker skips quietly below it and pushes above it', async () => {
      // the list said chapter 150; nothing has been sent
      await trackers.seedTrackerFloor(userId, FLOOR_SERIES, 'myanimelist', 150);
      assert.deepEqual(await floor(), { chapters: 150, pushed_at: null }, 'a seeded floor carries no timestamp');

      pushes.length = 0;
      await book(1, true);
      await trackers.pushSeriesProgress(userId, FLOOR_SERIES);
      assert.equal(pushes.length, 0, 'chapter 1 is below the floor: nothing is sent');
      // Reintroduce by dropping the `pushed_at == null` return in pushOne: this reads the refusal message.
      assert.equal((await conn())?.last_error, null, 'and nothing is recorded as an error -- the tracker is simply ahead');
      assert.deepEqual(await floor(), { chapters: 150, pushed_at: null }, 'the floor is untouched');

      await book(151, true);
      await trackers.pushSeriesProgress(userId, FLOOR_SERIES);
      assert.equal(pushes.length, 1, 'chapter 151 passes the floor and is pushed');
      assert.equal(pushes[0].method, 'PATCH');
      assert.match(pushes[0].url, /\/manga\/777\/my_list_status$/);
      assert.match(pushes[0].body, /num_chapters_read=151/);
      const f = await floor();
      assert.equal(f?.chapters, 151, 'the floor is raised to what was sent');
      assert.ok(f?.pushed_at, 'and stamped: from now on it is a number this app sent');
      assert.equal((await conn())?.last_error, null);
    });

    await t.test('a floor a real push raised still refuses with a message', async () => {
      // the person un-reads 151: the local count drops to 1, below the 151 that was actually sent
      await book(151, false);
      pushes.length = 0;
      await trackers.pushSeriesProgress(userId, FLOOR_SERIES);
      assert.equal(pushes.length, 0, 'never walk a tracker backwards on its own');
      // Reintroduce by returning quietly for every floor regardless of pushed_at: this stays null.
      const msg = (await conn())?.last_error ?? '';
      assert.match(msg, /below the 151 already sent/,
        'a number this app sent is refused loudly, so the person knows how to take the lower one if it is right');
      // The way down is a re-import (seedTrackerFloor takes the tracker's word); the message must send the
      // person there and not to a control that does not exist. Reintroduce by restoring "Resync from the
      // series page": there is no such button anywhere in the web app.
      assert.match(msg, /Import your list again under Admin → Import/, 'the message names the repair that exists');
      assert.doesNotMatch(msg, /series page/, 'and not the resync button the series page never had');
      assert.equal((await conn())?.enabled, true, 'a refusal is not a rejected token');
    });

    await t.test('a fresh read of the tracker replaces the floor, stamped or not, and unstamps it', async () => {
      // The person fixed a mis-click on the site: the tracker now says 20, below the 151 this app once sent.
      // The number came from the tracker seconds ago, so it IS the entry -- a floor that could only rise
      // would keep 151 forever, skip every chapter up to it quietly, and "Load list again" would change
      // nothing. Reintroduce by GREATEST(tracker_progress.chapters, EXCLUDED.chapters) in seedTrackerFloor:
      // the floor stays 151.
      await trackers.seedTrackerFloor(userId, FLOOR_SERIES, 'myanimelist', 20);
      let f = await floor();
      assert.equal(f?.chapters, 20, 'the tracker\'s current number replaces the higher one this app sent');
      // Reintroduce by leaving pushed_at alone in the DO UPDATE: the stamp survives and the next chapter
      // below 20 writes a refusal about "the 20 already sent", a number this app never sent.
      assert.equal(f?.pushed_at, null, 'and the floor is unstamped: after a re-import it is the tracker\'s number, not ours');

      // the refusal from the subtest above is still on the card (a quiet skip never touches last_error; the
      // next accepted push clears it), so it is cleared here to see that nothing new is written
      await q(`UPDATE user_trackers SET last_error = NULL WHERE user_id = $1 AND provider = 'myanimelist'`, [userId]);
      pushes.length = 0;
      await trackers.pushSeriesProgress(userId, FLOOR_SERIES);   // local count is 1
      assert.equal(pushes.length, 0, 'chapter 1 is still below the new floor: nothing is sent');
      assert.equal((await conn())?.last_error, null, 'and quietly, because nothing was ever sent at 20');

      await book(21, true);
      await trackers.pushSeriesProgress(userId, FLOOR_SERIES);
      assert.equal(pushes.length, 1, 'Load list again is the repair: chapter 21 passes the replaced floor');
      assert.match(pushes[0].body, /num_chapters_read=21/);
      f = await floor();
      assert.equal(f?.chapters, 21);
      assert.ok(f?.pushed_at, 'the push stamped it again');

      await trackers.seedTrackerFloor(userId, FLOOR_SERIES, 'myanimelist', 0);
      assert.deepEqual(await floor(), f, 'a zero from a plan-to-read entry writes nothing');
    });

    await t.test('a local count equal to an unstamped floor does not push', async () => {
      // The list says 25 and the person re-reads chapter 25 here: the tracker already holds that number, and
      // a push would carry `status: reading` (151 is still unread locally), flipping a COMPLETED entry to
      // reading for nothing new. Reintroduce by `chapters < floor.chapters` in pushOne's unstamped skip:
      // the equal count is pushed.
      await trackers.seedTrackerFloor(userId, FLOOR_SERIES, 'myanimelist', 25);
      await book(25, true);
      pushes.length = 0;
      await trackers.pushSeriesProgress(userId, FLOOR_SERIES);
      assert.equal(pushes.length, 0, 'equal to an unstamped floor: nothing new to say');
      assert.equal((await conn())?.last_error, null, 'and no error');
      assert.deepEqual(await floor(), { chapters: 25, pushed_at: null }, 'the floor is untouched');

      await book(26, true);
      await trackers.pushSeriesProgress(userId, FLOOR_SERIES);
      assert.equal(pushes.length, 1, 'one above it pushes');
      assert.ok((await floor())?.pushed_at, 'and stamps the floor');

      // A STAMPED floor keeps the strict rule: equal to a number this app sent is a harmless re-send (the
      // status may have changed), not a skip. Reintroduce by `chapters <= floor.chapters` regardless of the
      // stamp: this second push never goes out.
      pushes.length = 0;
      await trackers.pushSeriesProgress(userId, FLOOR_SERIES);
      assert.equal(pushes.length, 1, 'equal to a stamped floor still pushes');
      assert.match(pushes[0].body, /num_chapters_read=26/);
    });
  } finally {
    await q(`DELETE FROM users WHERE username = $1`, ['tracker-floor']);
    await q(`DELETE FROM lib_series WHERE id = $1`, [FLOOR_SERIES]);
  }
});

// ---- the resync route is the other way down, and it has to work for every provider --------------------------
//
// The floor is kept per (user, series, provider), and the route that clears it answered 400 for anything but
// AniList, so a stamped MAL or Kitsu floor -- a number this app sent -- had no way down at all. Re-importing
// the list is one repair (above); this is the deliberate one for a series the person corrected by hand.
const RESYNC_SERIES = 's_trk_resync';

test('resync clears the floor for MAL and Kitsu too', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async (t) => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const trackers = await import('../src/lib/trackers');
  const personalRoutes = (await import('../src/routes/personal')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await migrate();
  await q(`DELETE FROM users WHERE username = $1`, ['tracker-resync']);
  await q(`DELETE FROM lib_series WHERE id = $1`, [RESYNC_SERIES]);
  await q(`INSERT INTO lib_series (id, source, title, folder) VALUES ($1,'test','Resync Test Series',$1)`, [RESYNC_SERIES]);
  const u = await q(
    `INSERT INTO users (username, display_name, password_hash, role) VALUES ($1,$2,$3,'user') RETURNING id`,
    ['tracker-resync', 'Resync', 'x'],
  );
  const userId = u[0].id as string;
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(personalRoutes);
  await app.ready();
  const auth = { authorization: `Bearer ${app.jwt.sign({ sub: userId, role: 'user' })}` };
  const resync = (provider: string) =>
    app.inject({ method: 'POST', url: `/api/trackers/${provider}/resync/${RESYNC_SERIES}`, headers: auth });
  const floors = async () => {
    const rows = await q<{ provider: string; chapters: number }>(
      `SELECT provider, chapters FROM tracker_progress WHERE user_id = $1 AND series_id = $2 ORDER BY provider`,
      [userId, RESYNC_SERIES]);
    return Object.fromEntries(rows.map((r) => [r.provider, r.chapters]));
  };

  try {
    // one stamped floor per provider, all above what has been read here (chapter 2)
    for (const p of ['anilist', 'myanimelist', 'kitsu'] as const) {
      await q(`INSERT INTO tracker_progress (user_id, series_id, provider, chapters, pushed_at) VALUES ($1,$2,$3,50,now())`,
        [userId, RESYNC_SERIES, p]);
    }
    await trackers.saveConnection(userId, 'myanimelist', 'tok-mal', 'me-on-mal', new Date(Date.now() + 86_400_000));
    await trackers.linkSeries(RESYNC_SERIES, '888', 'Resync Test Series', userId, 'myanimelist');
    await q(`INSERT INTO lib_books (id, series_id, source, file, title, number) VALUES ($1,$2,'test',$3,$4,2)`,
      [`b_resync_2`, RESYNC_SERIES, '/test/resync/2.cbz', 'Chapter 2']);
    await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,$2,$3,1,true)`,
      [userId, 'b_resync_2', RESYNC_SERIES]);

    await t.test('an unknown provider is a 404, like the other :provider routes', async () => {
      const r = await resync('goodreads');
      assert.equal(r.statusCode, 404);
      assert.equal(r.json().error, 'unknown_provider');
      assert.deepEqual(await floors(), { anilist: 50, kitsu: 50, myanimelist: 50 }, 'nothing was cleared');
    });

    await t.test('a MAL resync clears the MAL floor only, and the lower number goes out', async () => {
      // Reintroduce by `provider !== 'anilist' → 400` in the route: this is a 400 and the floor stands.
      pushes.length = 0;
      const r = await resync('myanimelist');
      assert.equal(r.statusCode, 200, r.body);
      // Reintroduce by `clearTrackerFloor(uid, seriesId)` without the provider: the default is anilist, so
      // the AniList floor goes and the MAL one stays.
      assert.deepEqual(await floors(), { anilist: 50, kitsu: 50, myanimelist: 2 },
        'the MAL floor was cleared and re-raised by the push; AniList and Kitsu keep theirs');
      assert.equal(pushes.length, 1, 'the corrected, lower number is pushed at once');
      assert.match(pushes[0].url, /\/manga\/888\/my_list_status$/);
      assert.match(pushes[0].body, /num_chapters_read=2/);
    });

    await t.test('a Kitsu resync clears the Kitsu floor only', async () => {
      const r = await resync('kitsu');
      assert.equal(r.statusCode, 200, r.body);
      assert.deepEqual(await floors(), { anilist: 50, myanimelist: 2 }, 'Kitsu is not connected, so nothing re-raises it');
    });

    await t.test('AniList still works as before', async () => {
      const r = await resync('anilist');
      assert.equal(r.statusCode, 200, r.body);
      assert.deepEqual(await floors(), { myanimelist: 2 });
    });
  } finally {
    await app.close();
    await q(`DELETE FROM users WHERE username = $1`, ['tracker-resync']);
    await q(`DELETE FROM lib_series WHERE id = $1`, [RESYNC_SERIES]);
  }
});
