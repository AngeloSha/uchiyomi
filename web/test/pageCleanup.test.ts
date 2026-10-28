import test from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { img } from '../lib/api';
import { cleanupSelection, savePageCleanup, savePageRule, type PageCleanupPreview } from '../lib/pageCleanup';
import { buildFlow, startIndex } from '../lib/readerFlow';
import { PageGrid } from '../components/PageGrid';
import { OfflinePageCleanupNotice } from '../components/PageCleanupPanel';
(globalThis as { React?: unknown }).React = React;
const preview: PageCleanupPreview = {
  revision: 'a'.repeat(64), contentVersion: 'b'.repeat(64), retainedBytes: 100, unusedRetainedBytes: 30, unusedRetainedImages: 1,
  pages: [
    { number: 1, name: '1.jpg', bytes: 20, gif: false, removed: false, restorable: false },
    { number: 2, name: '2.gif', bytes: 30, gif: true, removed: true, restorable: true },
    { number: 3, name: '3.jpg', bytes: 40, gif: false, removed: false, restorable: false },
  ],
};
test('cleanup selection preserves readable pages and distinguishes restore from permanent deletion', () => {
  assert.deepEqual(cleanupSelection(preview, 'remove', new Set([1])), [1]);
  assert.throws(() => cleanupSelection(preview, 'remove', new Set([1, 3])), /all_pages/);
  assert.throws(() => cleanupSelection(preview, 'remove', new Set([2])), /invalid_selection/);
  assert.deepEqual(cleanupSelection(preview, 'restore', new Set([2])), [2]);
  assert.deepEqual(cleanupSelection(preview, 'purge', new Set([2])), [2]);
  const purged = { ...preview, pages: preview.pages.map((p) => ({ ...p, restorable: false })) };
  assert.throws(() => cleanupSelection(purged, 'restore', new Set([2])), /invalid_selection/);
  assert.throws(() => cleanupSelection(purged, 'purge', new Set([2])), /invalid_selection/);
  assert.deepEqual(cleanupSelection(preview, 'purge-unused', new Set()), []);
  assert.throws(() => cleanupSelection({ ...preview, unusedRetainedImages: 0 }, 'purge-unused', new Set()), /invalid_selection/);
  assert.throws(() => cleanupSelection(preview, 'purge-unused', new Set([2])), /invalid_selection/);
});
test('page mutations send the exact revision, explicit confirmation and correctly encoded chapter identity', async (t) => {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  t.mock.method(globalThis, 'fetch', async (url: any, init: any) => {
    calls.push({ url: String(url), method: init.method, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(preview), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  await savePageCleanup('book/a b', preview, 'remove', new Set([1]));
  assert.equal(calls[0].url, '/api/admin/books/book%2Fa%20b/page-cleanup');
  assert.deepEqual(calls[0].body, { action: 'remove', pages: [1], revision: preview.revision, confirm: true });
  await savePageCleanup('book/a b', preview, 'purge-unused', new Set());
  assert.deepEqual(calls[1].body.pages, []);
  assert.equal(calls[1].body.action, 'purge-unused');
  assert.throws(() => savePageCleanup('book', preview, 'remove', new Set([1, 3])), /all_pages/);
  assert.equal(calls.length, 2, 'an invalid selection never reaches the server');
  await savePageRule('book/a b', 'series', false);
  await savePageRule('book/a b', 'source', null);
  assert.equal(calls[2].method, 'PUT');
  assert.deepEqual(calls[2].body, { scope: 'series', skipGif: false, confirm: true });
  assert.deepEqual(calls[3].body, { scope: 'source', skipGif: null, confirm: true });
});
test('archive revisions reach normal pages, fit pages and thumbnails without changing old URLs', () => {
  assert.equal(img.page('book', 3), '/img/books/book/page/3');
  assert.equal(img.page('book', 3, 200, 'new&revision'), '/img/books/book/page/3?w=200&cv=new%26revision');
  assert.equal(img.page('book', 3, undefined, 'new'), '/img/books/book/page/3?cv=new');
  assert.equal(img.pageFit('book', 3, 900, 'new'), '/img/books/book/page/3?fit=900&cv=new');
  assert.equal(img.pageFit('book', 3, 0, 'new'), '/img/books/book/page/3?cv=new');
  assert.equal(img.bookThumb('book', 'new'), '/img/books/book/thumb?cv=new');
});
test('removed slots never return through junk expansion or the all-junk fallback; resume uses original page numbers', () => {
  const chapters = [{ id: 'b', pages: [
    { number: 1, width: 100, height: 200, removed: true, junk: true },
    { number: 2, width: 100, height: 200, junk: true, contentVersion: 'revision' },
    { number: 3, width: 100, height: 200, removed: true, junk: false },
  ] }];
  for (const mode of ['show', 'collapse', 'hide'] as const) {
    const flow = buildFlow(chapters, mode, new Set(['b:1', 'b:3']));
    assert.deepEqual(flow.map((p) => p.number), [2]);
    assert.equal(flow[0].firstOfChapter, true);
    assert.equal(flow[0].contentVersion, 'revision');
    assert.equal(startIndex(flow, 0, 3), 0);
  }
  assert.deepEqual(buildFlow([{ id: 'b', pages: chapters[0].pages.filter((p) => p.removed) }], 'show'), []);
});
test('removed tiles stay visible for restoration and cannot expose a Skip or open-page action', () => {
  const html = renderToStaticMarkup(createElement(PageGrid, { title: 'Pages', pages: [
    { idx: 0, number: 1, src: null }, { idx: 0, number: 2, src: null, removed: true, restorable: true, junk: true },
    { idx: 0, number: 3, src: null, removed: true, restorable: false },
  ], current: 0, onPick() {}, onClose() {}, onToggleJunk() {}, onRestore() {}, onManage() {} }));
  assert.match(html, /data-removed-page="2"/);
  assert.match(html, /Restore page 2/);
  assert.doesNotMatch(html, /Restore page 3/);
  assert.match(html, /Original permanently deleted/);
  assert.doesNotMatch(html, /Skip page 2|Open (?:skipped )?page 2/);
  assert.match(html, /Skip page 1/);
  assert.match(html, /data-manage-pages/);
  const offline = renderToStaticMarkup(createElement(OfflinePageCleanupNotice));
  assert.match(offline, /href="\/downloads\/"/);
  assert.match(offline, /saved offline copy/);
  assert.doesNotMatch(offline, /data-cleanup-confirm/);
});
