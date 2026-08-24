// The reading chart, and the fact that it was lying.
//
// `/api/stats.byDay` fed a 90-day bar chart on the profile page, and it returned ONLY the days that had
// events. The client rendered one `flex-1` bar per row, so someone who read on five days in three months
// saw five fat, evenly spaced bars under a label saying "Last 90 days". Every gap -- which is the entire
// information content of a reading chart -- was silently deleted, and the less you read the more confident
// and more wrong the picture became. Nothing errored; the shape was simply a different chart to the one the
// label promised.
//
// The second bug was quieter. This query bucketed days in the server's local timezone while the streak
// query directly below it bucketed in UTC, so on any container with a non-UTC TZ the chart and the streak
// counted different days and could disagree about whether you read yesterday.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const USER = 'stats-shape';
const SERIES = 's_ss_a';

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const personalRoutes = (await import('../src/routes/personal')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await migrate();

  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [SERIES]).catch(() => {});
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!ss',$1,$1,1)`, [SERIES]);
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title)
           VALUES ($1,$2,'T!ss',$3,1,'Chapter 1') ON CONFLICT DO NOTHING`, [`b_${SERIES}`, SERIES, 'x/ch1.cbz']);
  const uid = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind)
     VALUES ($1,'me','x','user','password') RETURNING id`, [USER]))[0].id;

  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(personalRoutes);
  await app.ready();
  const auth = { authorization: `Bearer ${app.jwt.sign({ sub: uid, role: 'user' })}` };
  return { q, uid, app, auth };
}

test('reading stats shape', { skip }, async (t) => {
  const { q, uid, app, auth } = await setup();
  const stats = async () => (await app.inject({ method: 'GET', url: '/api/stats', headers: auth })).json();

  try {
    await t.test('THE CHART: 90 days means 90 buckets, gaps included', async () => {
      // Read on exactly three days, spread out. The old query returned three rows and the chart drew three
      // evenly spaced bars, which is a picture of a completely different reading habit.
      for (const ago of [1, 30, 80]) {
        await q(
          `INSERT INTO reading_events (user_id, series_id, book_id, page, completed, created_at)
           VALUES ($1,$2,$3,5,true, (now() AT TIME ZONE 'UTC')::date - ($4 || ' days')::interval + interval '9 hours')`,
          [uid, SERIES, `b_${SERIES}`, ago],
        );
      }
      const s = await stats();
      assert.equal(s.byDay.length, 90, `a "last 90 days" chart returned ${s.byDay.length} buckets`);
      assert.equal(s.byDay.filter((d: any) => d.chapters > 0).length, 3, 'exactly the three days read');
      assert.equal(s.byDay.filter((d: any) => d.chapters === 0).length, 87, 'and 87 honest zeroes');

      // Contiguous and ascending, or the x axis is still not time.
      const days = s.byDay.map((d: any) => d.day);
      assert.deepEqual([...days].sort(), days, 'buckets must be in date order');
      for (let i = 1; i < days.length; i++) {
        const gap = (Date.parse(days[i]) - Date.parse(days[i - 1])) / 86400000;
        assert.equal(gap, 1, `a gap of ${gap} days between ${days[i - 1]} and ${days[i]}`);
      }
      assert.equal(days[89], new Date().toISOString().slice(0, 10), 'the last bucket is today');
    });

    await t.test('the chart and the streak agree about what a day is', async () => {
      // Same reader, same events: the day the streak counts must be a day the chart also shows as non-zero.
      // These were two different date expressions, one local and one UTC, one line apart.
      const s = await stats();
      const today = new Date().toISOString().slice(0, 10);
      const chartToday = s.byDay.find((d: any) => d.day === today);
      assert.ok(chartToday, 'today must be in the chart');

      await q(
        `INSERT INTO reading_events (user_id, series_id, book_id, page, completed, created_at)
         VALUES ($1,$2,$3,5,true, (now() AT TIME ZONE 'UTC')::date + interval '2 hours')`,
        [uid, SERIES, `b_${SERIES}`],
      );
      const after = await stats();
      assert.ok(after.byDay.find((d: any) => d.day === today).chapters > 0,
        'an event stamped early on the UTC day must land in the UTC day the chart draws');
      assert.ok(after.currentStreak >= 1,
        'and in the streak, which is computed from the same definition of a day');
    });

    await t.test('a reader with no history gets a chart, not an empty array', async () => {
      await q('DELETE FROM reading_events WHERE user_id = $1', [uid]);
      const s = await stats();
      assert.equal(s.byDay.length, 90, 'a first-run account must still get an axis to draw');
      assert.ok(s.byDay.every((d: any) => d.chapters === 0));
      assert.equal(s.currentStreak, 0);
    });

    await t.test('you can set your own display name', async () => {
      // Only an admin could, and only at account creation, so anyone left on the default saw a generic
      // fallback where their name belongs with nothing on screen suggesting a cause or a fix.
      const r = await app.inject({ method: 'PUT', url: '/api/settings', headers: auth, payload: { displayName: '  Renata  ' } });
      assert.equal(r.statusCode, 200);
      assert.equal((await q<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [uid]))[0].display_name,
        'Renata', 'it has to reach the users row: the leaderboard and member activity read it from there');

      // Blank must not wipe it -- an accidental clear should leave the old name, not an anonymous account.
      await app.inject({ method: 'PUT', url: '/api/settings', headers: auth, payload: { displayName: '   ' } });
      assert.equal((await q<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [uid]))[0].display_name,
        'Renata');
    });
  } finally {
    await app.close();
    await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
    await q('DELETE FROM lib_books WHERE series_id = $1', [SERIES]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = $1', [SERIES]).catch(() => {});
  }
});
