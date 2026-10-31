// Manual uploads (routes/upload.ts): chapter files an account already has, started as a series of its own by hand.
//
//   - a file uploaded under a new title starts a series of its own (Uploads/<title>) and is indexed as its chapter;
//   - the run's later files join the series its first one made;
//   - nothing is overwritten, nothing but an archive the scanner reads is taken, and a file whose bytes are not the
//     archive its name says is refused and leaves nothing behind;
//   - a name cannot climb out of the series' folder;
//   - `fresh=1` refuses a title already here.
//
// Against the real route and real rows. Skipped unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '';
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.UCHIYOMI_PING_URL = '';
  process.env.MIN_FREE_GB = '0';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const USER = 'upload_test_admin';
const TITLE = 'Upload Test Series';
const FOLDER = `Uploads/${TITLE}`;

let q: any, app: any, headers: Record<string, string>;

/** The smallest archive the scanner can read: a zip holding one page. */
async function cbz(): Promise<Buffer> {
  const AdmZip = (await import('adm-zip')).default;
  const z = new AdmZip();
  z.addFile('001.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  return z.toBuffer();
}

const post = (title: string, name: string, payload: Buffer, fresh = false) =>
  app.inject({
    method: 'POST',
    url: `/api/library/upload?title=${encodeURIComponent(title)}&name=${encodeURIComponent(name)}${fresh ? '&fresh=1' : ''}`,
    payload, headers: { ...headers, 'content-type': 'application/octet-stream' },
  });

before(async () => {
  if (!DSN) return;
  ROOT = await mkdtemp(join(tmpdir(), 'uchiyomi-upload-'));
  process.env.DL_ROOT = join(ROOT, 'dl');
  process.env.LIBRARY_ROOT = join(ROOT, 'lib');
  const { migrate } = await import('../src/lib/migrate');
  await migrate();
  ({ q } = (await import('../src/lib/db')) as any);
  await q(`DELETE FROM lib_series WHERE folder LIKE 'Uploads/Upload Test%'`);
  await q('DELETE FROM users WHERE username = $1', [USER]);
  const uid = (await q(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms, max_age_rating)
     VALUES ($1,$1,'x','admin','password','{}',NULL) RETURNING id`, [USER]))[0].id;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/upload')).uploadSeriesRoutes);
  await app.ready();
  headers = { authorization: `Bearer ${app.jwt.sign({ sub: uid, role: 'admin' })}` };
});

after(async () => {
  if (!DSN) return;
  await q(`DELETE FROM lib_series WHERE folder LIKE 'Uploads/Upload Test%'`).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  await app?.close();
  await rm(ROOT, { recursive: true, force: true });
});

test('an upload under a new title starts a series of its own, and the file is its chapter', { skip }, async () => {
  const r = await post(TITLE, 'Chapter 7.cbz', await cbz(), true);
  assert.equal(r.statusCode, 200, r.body);
  const j = r.json();
  assert.equal(j.file, `${FOLDER}/Chapter 7.cbz`);
  assert.equal(j.number, 7);
  await stat(join(ROOT, 'dl', FOLDER, 'Chapter 7.cbz'));
  const [s] = await q(`SELECT folder FROM lib_series WHERE id = $1`, [j.seriesId]);
  assert.equal(s.folder, FOLDER);
});

test('the run\'s later files join the series its first one made', { skip }, async () => {
  const first = await q(`SELECT id FROM lib_series WHERE folder = $1`, [FOLDER]);
  const r = await post(TITLE, 'Chapter 8.cbz', await cbz());
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().seriesId, first[0].id);
});

test('a title already here is refused when the run starts', { skip }, async () => {
  const r = await post(TITLE, 'Chapter 9.cbz', await cbz(), true);
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, 'taken');
});

test('nothing is overwritten', { skip }, async () => {
  const r = await post(TITLE, 'Chapter 7.cbz', await cbz());
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, 'exists');
});

test('only an archive the scanner reads is taken, and bytes that are not one leave nothing behind', { skip }, async () => {
  const bad = await post(TITLE, 'notes.txt', Buffer.from('hello'));
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'bad_type');
  const fake = await post(TITLE, 'Chapter 10.cbz', Buffer.from('not a zip at all'));
  assert.equal(fake.statusCode, 400);
  assert.equal(fake.json().error, 'bad_file');
  assert.deepEqual((await readdir(join(ROOT, 'dl', FOLDER))).sort(), ['Chapter 7.cbz', 'Chapter 8.cbz']);
});

test('a name cannot climb out of the series folder', { skip }, async () => {
  const r = await post(TITLE, '../../escape.cbz', await cbz());
  // sanitize() turns the separators into underscores: the file stays in the folder, under a harmless name.
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().file.startsWith(`${FOLDER}/`), true);
  await assert.rejects(stat(join(ROOT, 'escape.cbz')));
});
