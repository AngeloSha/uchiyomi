import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setCurrentUser } from '../lib/api';
import { downloadChapter, getOfflineChapter, setOfflinePageJunk, deleteDownload } from '../lib/downloads';
import { buildFlow } from '../lib/readerFlow';
test('a saved chapter preserves removed slots and archive revisions through download and local skip changes', async (t) => {
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: any) => {
    const u = String(url); urls.push(u);
    if (u.includes('download-manifest')) return new Response(JSON.stringify({
      bookId: 'cleanup-offline', seriesId: 'series', seriesTitle: 'Series', title: 'Chapter', number: '1', pageCount: 3, totalBytes: 3,
      pages: [1, 2, 3].map((n) => ({ number: n, width: 100, height: 200, url: `/p/${n}?cv=archive-revision`,
        contentVersion: 'archive-revision', ...(n === 2 ? { removed: true, restorable: false, junk: true } : {}) })),
    }), { headers: { 'content-type': 'application/json' } });
    return new Response(u.startsWith('/p/') ? 'x' : '{}', { headers: { 'content-type': 'application/json' } });
  });
  setCurrentUser('cleanup-reader');
  try {
    await downloadChapter('cleanup-offline');
    const chapter = await getOfflineChapter('cleanup-offline');
    assert.ok(chapter);
    assert.equal(chapter.pages[1].removed, true);
    assert.equal(chapter.pages[1].restorable, false);
    assert.ok(chapter.pages.every((p) => p.contentVersion === 'archive-revision'));
    assert.deepEqual(urls.filter((u) => u.startsWith('/p/')), ['/p/1?cv=archive-revision', '/p/2?cv=archive-revision', '/p/3?cv=archive-revision']);
    await setOfflinePageJunk('cleanup-offline', 2, false);
    const updated = await getOfflineChapter('cleanup-offline');
    assert.equal(updated?.pages[1].removed, true);
    assert.deepEqual(buildFlow([{ id: 'chapter', pages: updated!.pages }], 'show').map((p) => p.number), [1, 3]);
  } finally { await deleteDownload('cleanup-offline'); }
});
