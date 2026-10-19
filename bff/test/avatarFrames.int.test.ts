// Avatar frames (v0.89.0, #267 part 3 by @CheetahDoesStuff; lib/badges.ts): a badge's reward, worn where the whole
// household sees it, so the server lets an account wear only a frame it has earned -- measured as the profile measures
// its badges -- keeps the one already worn through other changes, and shows it to others with the avatar.
//
// Driven through the real settings route and the leaderboard, on reading events written straight into the table.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const NAME = 'af-reader';
let q: any, app: any, uid: string, auth: { authorization: string };

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await migrate();
  await q('DELETE FROM users WHERE username = $1', [NAME]);
  uid = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','user','password') RETURNING id`, [NAME]))[0].id;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/personal')).default);
  await app.register((await import('../src/routes/catalog')).default);
  await app.ready();
  auth = { authorization: `Bearer ${app.jwt.sign({ sub: uid, role: 'user' })}` };
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  await q('DELETE FROM users WHERE username = $1', [NAME]).catch(() => {});
});

const wear = (avatar: Record<string, unknown>) => app.inject({ method: 'PUT', url: '/api/settings', headers: auth, payload: { avatar } });
const stored = async () => (await q('SELECT avatar FROM users WHERE id = $1', [uid]))[0].avatar;
/** `n` chapters finished, each once, on the day `daysAgo` days back. */
const finish = (n: number, daysAgo = 0, tag = 'a') => q(
  `INSERT INTO reading_events (user_id, series_id, book_id, page, completed, created_at)
   SELECT $1, 's_af', 'b_af_' || $3 || '_' || g, 1, true, now() - make_interval(days => $2) FROM generate_series(1, $4) g`,
  [uid, daysAgo, tag, n]);

test('only an earned frame can be worn, measured as the profile measures the badges', { skip }, async () => {
  const face = { emoji: '🦊', color: '#7c5cff' };
  // Reintroduce by accepting any frame (dropping the earned check): Reader's bronze is worn on day one.
  const early = await wear({ ...face, frame: 'bronze' });
  assert.equal(early.statusCode, 403, early.body);
  assert.equal(early.json().error, 'frame_locked');
  assert.match(early.json().message, /Reader/, 'it says which badge');
  assert.deepEqual(await stored(), {}, 'nothing refused is saved');

  await finish(10);
  assert.equal((await wear({ ...face, frame: 'bronze' })).statusCode, 200, 'ten chapters: Reader');
  assert.equal((await stored()).frame, 'bronze');
  assert.equal((await wear({ ...face, frame: 'silver' })).statusCode, 403, 'Bookworm wants fifty');

  // A week in a row, ending today: On a roll's ember, a streak badge.
  assert.equal((await wear({ ...face, frame: 'ember' })).statusCode, 403);
  for (let d = 1; d <= 6; d++) await finish(1, d, `day${d}`);
  assert.equal((await wear({ ...face, frame: 'ember' })).statusCode, 200, 'seven days in a row');
});

test('the frame worn is kept through other changes, taken off when left out, and never a made-up one', { skip }, async () => {
  // The badge is gone (its reading removed): the frame on already stays while the emoji changes under it.
  await q('DELETE FROM reading_events WHERE user_id = $1', [uid]);
  const kept = await wear({ emoji: '🐲', color: '#22d3ee', frame: 'ember' });
  assert.equal(kept.statusCode, 200, kept.body);
  assert.deepEqual(await stored(), { emoji: '🐲', color: '#22d3ee', frame: 'ember' });
  assert.equal((await wear({ emoji: '🐲', frame: 'bronze' })).statusCode, 403, 'another frame is measured afresh');
  for (const frame of ['diamond', 7, '']) {
    assert.equal((await wear({ emoji: '🐲', frame })).statusCode, 400, `refused: ${JSON.stringify(frame)}`);
  }
  assert.equal((await wear({ emoji: '🐲', color: '#22d3ee' })).statusCode, 200);
  assert.deepEqual(await stored(), { emoji: '🐲', color: '#22d3ee' }, 'left out, it is taken off');
});

test('others see the frame: on the household board, and on a comment\'s author', { skip }, async () => {
  await finish(10, 0, 'board');
  assert.equal((await wear({ emoji: '🦉', frame: 'bronze' })).statusCode, 200);
  const board = (await app.inject({ method: 'GET', url: '/api/leaderboard', headers: auth })).json().content;
  assert.deepEqual(board.find((r: any) => r.id === uid)?.avatar, { emoji: '🦉', frame: 'bronze' });
  // A comment names its author by publicAvatar: the frame rides along, and only a frame the app knows.
  const { publicAvatar } = await import('../src/lib/comments');
  assert.deepEqual(publicAvatar({ emoji: '🦉', frame: 'bronze' }), { emoji: '🦉', frame: 'bronze' });
  assert.deepEqual(publicAvatar({ emoji: '🦉', frame: 'diamond', url: 'https://x.invalid/a.png' }), { emoji: '🦉' });
  assert.deepEqual(publicAvatar(null), {});
});
