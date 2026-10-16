// Health's "Tracker sync" against a real Postgres (lib/healthTrackers.ts, v0.72.0, @Squeaks72's card from #253): every
// member's tracker connection with something wrong, by tracker and username, and what an ignore of one covers.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
const DAY = 24 * 3600_000;
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';

let q: (sql: string, p?: unknown[]) => Promise<any[]>;
const connect = (user: string, provider: string, o: { enabled?: boolean; inDays?: number | null; error?: string | null } = {}) =>
  q(`INSERT INTO user_trackers (user_id, provider, access_token, enabled, expires_at, last_error) VALUES ($1, $2, 'sealed', $3, $4, $5)
     ON CONFLICT (user_id, provider) DO UPDATE SET enabled = EXCLUDED.enabled, expires_at = EXCLUDED.expires_at, last_error = EXCLUDED.last_error`,
  [user, provider, o.enabled ?? true, o.inDays == null ? null : new Date(Date.now() + o.inDays * DAY), o.error ?? null]);

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  await migrate();
  ({ q } = await import('../src/lib/db'));
  await q(`INSERT INTO users (id, username, display_name, password_hash) VALUES ($1, 'ht_ana', 'Ana', 'x'), ($2, 'ht_ben', 'Ben', 'x')
           ON CONFLICT (id) DO NOTHING`, [A, B]);
});

test('each connection with something wrong, by tracker and member; a fine one is not listed', { skip }, async () => {
  const { trackerSync } = await import('../src/lib/healthTrackers');
  const { englishOf } = await import('../src/lib/said');
  await connect(A, 'anilist', { enabled: false, error: 'the tracker rejected the saved token -- reconnect to resume syncing' });
  await connect(A, 'myanimelist', { inDays: 10 });
  await connect(A, 'kitsu', { inDays: 200 });
  await connect(B, 'anilist', { inDays: 20 });
  await connect(B, 'kitsu', { error: 'Kitsu answered 503' });
  await connect(B, 'myanimelist', { inDays: -3 });

  const card = await trackerSync();
  const rows = new Map(card.items.map((i) => [i.key, i]));
  assert.equal(card.status, 'warn');
  // Named by the tracker's own adapter, never a list of this card's.
  assert.equal(rows.get(`anilist:${A}`)?.title, 'AniList · ht_ana');
  // Refused: the refusal says it, not our own "reconnect" error beside it.
  assert.deepEqual(rows.get(`anilist:${A}`)?.detailSaid, [{ code: 'trackers.refused' }]);
  assert.equal(rows.get(`myanimelist:${A}`)?.detailSaid?.[0]?.code, 'trackers.ending', 'ten days left is a finding');
  assert.ok(!rows.get(`myanimelist:${A}`)?.info);
  assert.ok(!rows.has(`kitsu:${A}`), 'two hundred days left: fine, not listed');
  assert.ok(rows.get(`anilist:${B}`)?.info, 'twenty days left: listed for reference');
  assert.deepEqual(rows.get(`kitsu:${B}`)?.detailSaid, [{ code: 'trackers.failed', params: { error: 'Kitsu answered 503' } }]);
  assert.equal(rows.get(`myanimelist:${B}`)?.detailSaid?.[0]?.code, 'trackers.ended');
  assert.deepEqual(card.summarySaid, [{ code: 'trackers.live', params: { n: 4 } }]);
  assert.equal(englishOf(card.summarySaid), card.summary);
  for (const it of card.items) assert.equal(englishOf(it.detailSaid), it.detail, `${it.key}: its codes say something else`);
  // Two things wrong at once read side by side.
  await connect(B, 'kitsu', { error: 'Kitsu answered 503', inDays: 5 });
  const both = (await trackerSync()).items.find((i) => i.key === `kitsu:${B}`);
  assert.equal(both?.detail.split(' · ').length, 2);
  assert.equal(both?.detailSaid?.[1]?.join, 'dot');
});

test('an ignored "ends soon" does not silence a refusal later', { skip }, async () => {
  // #253's rows ignored with no members, which every later finding is covered by. Reintroduce `members: []` in
  // lib/healthTrackers.ts: the refusal below reads ignored.
  const { trackerSync } = await import('../src/lib/healthTrackers');
  const { findingOf } = await import('../src/lib/health');
  const { ignoreFinding, loadIgnores } = await import('../src/lib/healthIgnore');
  await connect(A, 'myanimelist', { inDays: 10 });
  const f = await findingOf('trackers', `myanimelist:${A}`);
  assert.deepEqual(f?.members, ['trackers.ending']);
  await ignoreFinding('trackers', `myanimelist:${A}`, f!, null);
  let row = (await trackerSync(await loadIgnores())).items.find((i) => i.key === `myanimelist:${A}`);
  assert.ok(row?.ignored, 'ignored while it only ends soon');
  await connect(A, 'myanimelist', { enabled: false, inDays: 10 });
  row = (await trackerSync(await loadIgnores())).items.find((i) => i.key === `myanimelist:${A}`);
  assert.ok(!row?.ignored && !row?.info, 'refused is news');
});

test('no connection at all, and every connection fine', { skip }, async () => {
  const { trackerSync } = await import('../src/lib/healthTrackers');
  await q('DELETE FROM user_trackers');
  assert.deepEqual((await trackerSync()).summarySaid, [{ code: 'trackers.none' }]);
  await connect(A, 'kitsu', { inDays: 300 });
  const card = await trackerSync();
  assert.equal(card.status, 'ok');
  assert.deepEqual(card.items, []);
  assert.deepEqual(card.summarySaid, [{ code: 'trackers.fine', params: { n: 1 } }]);
});
