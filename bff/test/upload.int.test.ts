// Manual uploads (routes/upload.ts): a chapter file an admin already has, put into a series by hand.
//
//   - a file uploaded to a series lands in that series' folder under the download root and is indexed as its chapter;
//   - a file uploaded under a new title starts a series of its own (Uploads/<title>);
//   - nothing is overwritten, nothing but an archive the scanner reads is taken, and a file whose bytes are not the
//     archive its name says is refused and leaves nothing behind;
//   - a name cannot climb out of the series' folder.
//
// Against the real route and real rows, mounted without admin.ts's auth hooks. Skipped unless TEST_DATABASE_URL is set.
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

const SERIES = 's_upload_test';
const FOLDER = 'upload-test/Has No Source';

let q: any, app: any;

/** The smallest archive the scanner can read: a zip holding one page. */
async function cbz(): Promise<Buffer> {
  const AdmZip = (await import('adm-zip')).default;
  const z = new AdmZip();
  z.addFile('001.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  return z.toBuffer();
}

const post = (url: string, payload: Buffer) =>
  app.inject({ method: 'POST', url, payload, headers: { 'content-type': 'application/octet-stream' } });

before(async () => {
  if (!DSN) return;
  ROOT = await mkdtemp(join(tmpdir(), 'uchiyomi-upload-'));
  process.env.DL_ROOT = join(ROOT, 'dl');
  process.env.LIBRARY_ROOT = join(ROOT, 'lib');
  const { migrate } = await import('../src/lib/migrate');
  await migrate();
  ({ q } = (await import('../src/lib/db')) as any);
  await q(`DELETE FROM lib_series WHERE id = $1 OR folder LIKE 'Uploads/Upload Test%'`, [SERIES]);
  await q(`INSERT INTO lib_series (id, source, title, folder) VALUES ($1, 'local', 'Has No Source', $2)`, [SERIES, FOLDER]);
  const Fastify = (await import('fastify')).default;
  app = Fastify();
  // What admin.ts's authenticate hook leaves on the request, for the audit entry.
  app.addHook('onRequest', async (req: any) => { req.user = { sub: null }; });
  await app.register((await import('../src/routes/upload')).default);
  await app.ready();
});

after(async () => {
  if (!DSN) return;
  await q(`DELETE FROM lib_series WHERE id = $1 OR folder LIKE 'Uploads/Upload Test%'`, [SERIES]).catch(() => {});
  await app?.close();
  await rm(ROOT, { recursive: true, force: true });
});

test('a file uploaded to a series lands in its folder and is its chapter', { skip }, async () => {
  const r = await post(`/api/admin/series/${SERIES}/upload?name=${encodeURIComponent('Chapter 7.cbz')}`, await cbz());
  assert.equal(r.statusCode, 200, r.body);
  const j = r.json();
  assert.equal(j.file, `${FOLDER}/Chapter 7.cbz`);
  assert.equal(j.number, 7);
  await stat(join(ROOT, 'dl', FOLDER, 'Chapter 7.cbz'));
  const [b] = await q(`SELECT series_id FROM lib_books WHERE id = $1`, [j.bookId]);
  assert.equal(b.series_id, SERIES);
});

test('nothing is overwritten', { skip }, async () => {
  const r = await post(`/api/admin/series/${SERIES}/upload?name=${encodeURIComponent('Chapter 7.cbz')}`, await cbz());
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, 'exists');
});

test('only an archive the scanner reads is taken, and bytes that are not one leave nothing behind', { skip }, async () => {
  const bad = await post(`/api/admin/series/${SERIES}/upload?name=notes.txt`, Buffer.from('hello'));
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'bad_type');
  const fake = await post(`/api/admin/series/${SERIES}/upload?name=${encodeURIComponent('Chapter 8.cbz')}`, Buffer.from('not a zip at all'));
  assert.equal(fake.statusCode, 400);
  assert.equal(fake.json().error, 'bad_file');
  assert.deepEqual((await readdir(join(ROOT, 'dl', FOLDER))).sort(), ['Chapter 7.cbz']);
});

test('a name cannot climb out of the series folder', { skip }, async () => {
  const r = await post(`/api/admin/series/${SERIES}/upload?name=${encodeURIComponent('../../escape.cbz')}`, await cbz());
  // sanitize() turns the separators into underscores: the file stays in the folder, under a harmless name.
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().file.startsWith(`${FOLDER}/`), true);
  await assert.rejects(stat(join(ROOT, 'escape.cbz')));
});

test('an upload under a new title starts a series of its own', { skip }, async () => {
  const r = await post(`/api/admin/library/upload?title=${encodeURIComponent('Upload Test New')}&name=${encodeURIComponent('Vol 1.cbz')}`, await cbz());
  assert.equal(r.statusCode, 200, r.body);
  const j = r.json();
  const [s] = await q(`SELECT folder FROM lib_series WHERE id = $1`, [j.seriesId]);
  assert.equal(s.folder, 'Uploads/Upload Test New');
});

test('an unknown series is not found', { skip }, async () => {
  const r = await post(`/api/admin/series/s_nope/upload?name=a.cbz`, await cbz());
  assert.equal(r.statusCode, 404);
});
