import test from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { fitBox } from '../lib/readerCrop';
import { drawnWidth } from '../lib/readerFit';
import { DEFAULT_PREFS, migratePrefs } from '../lib/readerPrefs';
import { menuScrollMoved } from '../lib/contextMenus';
import { setSmoothScroll, haltSmoothScroll } from '../lib/smoothScroll';
import { withoutBlockedDeleted } from '../lib/chapterRows';
import { seriesActionGroups } from '../lib/seriesActions';

(globalThis as any).React = React;
const read = (name: string) => readFileSync(join(__dirname, '..', name), 'utf8');

test('confirmation preserves the actual title casing within the uppercase label', () => {
  const html = renderToStaticMarkup(React.createElement(ConfirmDialog, { title: 'Remove', body: '', confirmText: 'The Long Hero', onConfirm() {}, onClose() {} }));
  assert.match(html, /<span class="[^"]*normal-case[^"]*">The Long Hero<\/span>/);
});

test('opening a menu stops an active glide at its actual position and reduced effects needs no instance', () => {
  const calls: unknown[] = [];
  setSmoothScroll({ actualScroll: 123, scrollTo: (...args: unknown[]) => calls.push(args) } as any);
  haltSmoothScroll();
  assert.deepEqual(calls, [[123, { immediate: true, force: true }]]);
  setSmoothScroll(null); haltSmoothScroll(); assert.equal(calls.length, 1);
  const from = { x: 0, y: 123 };
  assert.equal(menuScrollMoved(true, from, { ...from }), false, 'a late unchanged page-scroll event keeps the menu');
  assert.equal(menuScrollMoved(true, from, { x: 0, y: 124 }), true, 'a real page scroll closes it');
  assert.equal(menuScrollMoved(false, from, { ...from }), true, 'an inner panel scroll still closes it');
});

test('paged width fitting is independently opt-in and does not migrate existing webtoon choices', () => {
  assert.equal(DEFAULT_PREFS.pagedFitWidth, false);
  for (const fitWidth of [false, true]) assert.equal(migratePrefs({ fitWidth }).pagedFitWidth, false);
  assert.equal(migratePrefs({ pagedFitWidth: true }).pagedFitWidth, true);
  assert.equal(migratePrefs({ pagedFitWidth: 'true' }).pagedFitWidth, false);
  assert.deepEqual(fitBox(800, 2000, 1200, 800), { width: 320, height: 800 });
  assert.deepEqual(fitBox(800, 2000, 1200, 800, true), { width: 1200, height: 3000 });
  assert.deepEqual(fitBox(0, 2000, 1200, 800, true), { width: 0, height: 0 });
  const layout = { mode: 'slide' as const, w: 1200, h: 800, zoom: 1, pair: false, half: false, rotate: false, crop: false, widthOnly: true };
  assert.equal(drawnWidth({ width: 800, height: 2000 }, layout), 1200, 'fit-image requests cover the actual drawn width');
  assert.equal(drawnWidth({ width: 800, height: 2000 }, { ...layout, pair: true, zoom: 2 }), 1200, 'a zoomed half-spread asks for its scaled width');
  assert.equal(drawnWidth({ width: 1600, height: 1000 }, { ...layout, half: true }), 2400, 'a split page asks for both halves of its original');
});

test('blocked deleted rows leave the shelf without losing live or offline chapters and without mutating history', () => {
  const rows = [{ id: 'gone', pruned: true }, { id: 'offline', pruned: true }, { id: 'live', pruned: false }, { id: 'unknown', pruned: true }];
  assert.deepEqual(withoutBlockedDeleted(rows, ['gone', 'offline', 'live'], new Set(['offline'])).map(x => x.id), ['offline', 'live', 'unknown']);
  assert.equal(rows.length, 4);
  assert.equal(withoutBlockedDeleted(rows, [], new Set()).length, 4, 'an older server preserves every row');
});

test('the upload action is offered only with upload permission and disabled offline', () => {
  const base = { isAdmin: false, mayDownload: false, booksCount: 0, mayArchive: false, autoHero: false, hasFolder: false };
  assert.ok(!seriesActionGroups(base).flatMap(x => x.items).some(x => x.id === 'upload'));
  const allowed = seriesActionGroups({ ...base, mayUpload: true, offline: true }).flatMap(x => x.items).find(x => x.id === 'upload');
  assert.equal(allowed?.disabled, true);
});

test('membership toggles await the server before changing the checkbox, retain the sheet, and disable double writes', () => {
  const src = read('app/series/page.tsx');
  const body = src.slice(src.indexOf('function CollectionSheet('), src.indexOf(' * Correct one chapter'));
  assert.match(body, /queryKey = \['collections', 'membership', seriesId\]/);
  assert.match(body, /role="checkbox" aria-checked=\{c.contains === true\}/);
  assert.match(body, /if \(inFlight.current \|\| typeof c.contains !== 'boolean'\) return/);
  assert.match(body, /await api\([\s\S]*?method: 'DELETE'[\s\S]*?changed\(c, contains\)/);
  const toggle = body.slice(body.indexOf('const toggle ='), body.indexOf('const createAndAdd'));
  assert.doesNotMatch(toggle, /onClose\(/, 'each successful toggle keeps the other lists available');
});
