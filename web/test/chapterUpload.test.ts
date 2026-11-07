// Uploading chapter files by hand (lib/chapterUpload.ts, components/ChapterUpload.tsx): the rough edges #375 left after
// v0.104.0 -- a list that forgot the files that failed, pages that stayed stale, refusals in English.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { setActiveDict } from '../lib/i18n';
import { ApiError } from '../lib/api';
import { uploadAll, uploadRefusal } from '../lib/chapterUpload';

setActiveDict({});
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const refusal = (status: number, body: unknown) => new ApiError(status, JSON.stringify(body));

test("every refusal the route answers is said in the reader's words, never its English sentence", () => {
  // Reintroduce `if (message) return message` ahead of the codes: busy and forbidden come back in English in every language.
  assert.match(uploadRefusal(refusal(429, { error: 'busy', message: 'Two uploads are already running. Try again when one finishes.' }), 'a.cbz'), /Two uploads are already running/);
  assert.equal(uploadRefusal(refusal(403, { error: 'forbidden', message: 'Uploading needs an admin to allow it.' }), 'a.cbz'), 'Your account is not allowed to upload series.');
  assert.equal(uploadRefusal(refusal(409, { error: 'busy', message: 'Another task is changing this series.' }), 'a.cbz'), 'Another task is changing this series. Try again in a moment.');
  assert.equal(uploadRefusal(refusal(400, { error: 'bad_path' }), 'a.cbz'), 'Could not upload a.cbz', 'a code with no words of its own');
  assert.equal(uploadRefusal(refusal(409, { error: 'exists' }), 'a.cbz'), 'a.cbz is already in this series.');
});

test('a run names the files that failed, and the next file of a new series joins the one the first made', async () => {
  // Reintroduce dropping `failedFiles`: the page has nothing to keep, and clears the list of the very files to retry.
  const asked: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    asked.push(String(url));
    if (String(url).includes('name=Chapter%202.cbz')) return new Response(JSON.stringify({ error: 'bad_file' }), { status: 415, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ file: 'x', seriesId: 's_new', bookId: 'b', number: 1, indexed: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const files = ['Chapter 1.cbz', 'Chapter 2.cbz', 'Chapter 3.cbz'].map((n) => new File([new Uint8Array([1])], n));
    const run = await uploadAll({ title: 'New One', fresh: true }, files);
    assert.deepEqual([run.done, run.failedFiles, run.seriesId], [2, ['Chapter 2.cbz'], 's_new']);
    assert.match(asked[0], /title=New%20One&fresh=1/, 'the first file makes the series');
    assert.match(asked[1], /seriesId=s_new/, 'the next ones join it');
  } finally { globalThis.fetch = orig; }
});

test('the page keeps the files that failed, refreshes what lists the series, and names where files go', () => {
  // Reintroduce `setFiles([])` after a run: a partial failure loses the files to retry. Reintroduce the two-key
  // invalidation: the chapter list (`series-books`) stays stale after an upload.
  const src = read('components/ChapterUpload.tsx');
  assert.match(src, /setFiles\(\(had\) => had\.filter\(\(f\) => run\.failedFiles\.includes\(f\.name\)\)\)/, 'the failed files leave the list');
  assert.match(src, /\['series-books', run\.seriesId\]/, 'the chapter rows are not refreshed');
  assert.match(src, /if \(run\.done\) for \(const k of \[\['library'\], \['home'\]\]\) qc\.invalidateQueries/, 'Library and Home are not refreshed');
  assert.match(src, /const into = seriesId \|\| \(!title\.trim\(\) && made \? made\.id : ''\);/, 'a retry of a new series asks for its title again');
  assert.match(src, /tr\('Add chapter files to “\{title\}”\./, 'the page does not say which series');
});
