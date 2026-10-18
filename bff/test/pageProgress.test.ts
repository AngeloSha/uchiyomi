// a chapter in flight carries its pages (lib/downloadActivity.ts pagesProgress), and loses them on landing.
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
import test, { before } from 'node:test';
import assert from 'node:assert/strict';

let A: typeof import('../src/lib/downloadActivity');
before(async () => { A = await import('../src/lib/downloadActivity'); A.clearActivity(); });

test('pages in hand of how many while it downloads; a finished entry keeps only its page count', () => {
  const id = A.beginDownload({ folder: 'Example Source/Example Series', title: 'Example Series', number: 132, source: 'sw:1' });
  A.startedDownload(id);
  A.pagesProgress(id, 0, 15);
  let x = A.listActivity().active.find((e) => e.id === id)!;
  assert.deepEqual([x.pagesDone, x.pagesTotal, typeof x.pagesSince], [0, 15, 'number']);
  A.pagesProgress(id, 9, 15);
  A.pagesProgress(id, 99, 15);
  x = A.listActivity().active.find((e) => e.id === id)!;
  assert.equal(x.pagesDone, 15);
  A.pagesProgress(id, 3, 0); // a nonsense total changes nothing
  assert.equal(A.listActivity().active.find((e) => e.id === id)!.pagesTotal, 15);
  A.endDownload(id, { status: 'done', pages: 15 });
  const done = A.listActivity().recent.find((e) => e.id === id)!;
  assert.equal(done.pages, 15);
  assert.equal('pagesDone' in done || 'pagesTotal' in done || 'pagesSince' in done, false);
});
