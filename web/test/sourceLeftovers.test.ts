// The warnings around chapters no other source has (lib/sourceLeftovers.ts): removing a source deletes the downloaded
// chapters only it lists, and deleting a chapter no followed source lists cannot be undone by Fetch again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { leftoversText, unlistedWarning } from '../lib/sourceLeftovers';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SourceRow } from '../components/SourcesSheet';

(globalThis as { React?: unknown }).React = React;

test('removing a source says how many chapters go with it, and nothing when none do', () => {
  assert.equal(leftoversText(0), null);
  assert.match(leftoversText(1)!, /^1 downloaded chapter no other source lists/);
  assert.match(leftoversText(3)!, /^3 downloaded chapters no other source lists/);
});

test('the Delete from server warning names the chapters nothing can fetch again', () => {
  assert.equal(unlistedWarning(2, 0), null, 'every chosen chapter is listed: no warning');
  assert.match(unlistedWarning(1, 1)!, /lists this chapter/);
  assert.match(unlistedWarning(3, 3)!, /lists these chapters/);
  assert.match(unlistedWarning(3, 1)!, /lists one of these chapters/);
  assert.match(unlistedWarning(5, 2)!, /lists 2 of these chapters/);
});

test('the Sources sheet asks before a removal that deletes, and the delete dialog shows the warning', () => {
  const sheet = readFileSync(join(__dirname, '../components/SourcesSheet.tsx'), 'utf8');
  assert.match(sheet, /\/leftovers`/, 'the × no longer asks what would go');
  assert.match(sheet, /data-remove-source-confirm/);
  const page = readFileSync(join(__dirname, '../app/series/page.tsx'), 'utf8');
  assert.match(page, /chapters\/unlisted`/);
  assert.match(page, /data-unlisted-warning/);
});


test('the removal question focuses keeping downloads and only offers deletion with a usable preview', () => {
  const render = (canDelete: boolean) => renderToStaticMarkup(createElement(SourceRow, {
    s: { sourceId: 'wrong', name: 'Wrong source', primary: false, registered: true } as any,
    removeAsk: { text: 'Optional cleanup: 3 chapters.', busy: false, canDelete, onConfirm() {}, onKeep() {}, onCancel() {} },
  }));
  const html = render(true);
  const keep = html.match(/<button[^>]*data-remove-source-keep[^>]*>[^<]*<\/button>/)?.[0];
  assert.ok(keep, 'keeping downloads remains an explicit action');
  assert.match(keep, /autofocus/);
  assert.match(keep, /Remove source and keep downloads/);
  assert.ok(html.indexOf('data-remove-source-keep') < html.indexOf('data-remove-source-yes'));
  const unavailable = render(false);
  assert.match(unavailable, /data-remove-source-keep/);
  assert.doesNotMatch(unavailable, /data-remove-source-yes/, 'a failed preview cannot expose the destructive choice');
});
