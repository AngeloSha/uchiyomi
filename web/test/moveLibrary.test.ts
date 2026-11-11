// Filing is one privacy-aware operation across the card, series, editor and bulk picker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError, setCurrentUser } from '../lib/api';
import { currentSelectionLibrary, moveLibraryRefusal, moveLibrarySummary, moveSeriesToLibrary, moveVisibilityConfirmation } from '../lib/moveLibrary';
import { MoveToLibrary } from '../components/MoveToLibrary';
import { seriesActionGroups, type SeriesActionsInput } from '../lib/seriesActions';
const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
(globalThis as { React?: unknown }).React = React;
const BASE = { isAdmin: false, mayDownload: false, booksCount: 10, mayArchive: false, autoHero: false, hasFolder: false, offline: false,
  notes: { notes: 0, bookmarks: 0 }, hiddenChapters: 0 } as unknown as SeriesActionsInput;
const ids = (x: SeriesActionsInput) => seriesActionGroups(x).flatMap((g) => g.items.map((i) => i.id));

test('Move library is an admin item in More, greyed while offline, and nobody else sees it', () => {
  assert.ok(!ids(BASE).includes('move'));
  assert.ok(ids({ ...BASE, isAdmin: true }).includes('move'));
  const item = seriesActionGroups({ ...BASE, isAdmin: true, offline: true }).flatMap((g) => g.items).find((i) => i.id === 'move')!;
  assert.equal(item.disabled, true); assert.equal(item.label, 'Move library');
});

test('all filing entrypoints share the helper and picker, including Edit details', () => {
  for (const f of ['app/series/page.tsx', 'components/SeriesMenu.tsx', 'components/SeriesEditor.tsx']) {
    assert.match(read(f), /moveSeriesToLibrary\(\[(id|series\.id)\], libraryId, options\)/, `${f} bypasses shared filing`);
    assert.match(read(f), /<MoveToLibrary n=\{1\}/, `${f} does not open the picker`);
    assert.match(read(f), /current=\{(?:series \? \{ libraryId: series\.libraryId \} : undefined|\{ libraryId: series\.libraryId \})\}/, `${f} hides the current library`);
  }
  assert.match(read('app/library/page.tsx'), /currentSelectionLibrary\(picked, items\)/);
  assert.match(read('app/library/page.tsx'), /moveSeriesToLibrary\(\[\.\.\.picked\], libraryId, options\)/);
  assert.match(read('components/SeriesMenu.tsx'), /isAdmin \? \[\{ label: tr\('Move library'\)/);
  assert.match(read('app/series/page.tsx'), /case 'move': setMoving\(true\); break;/);
});

test('Automatic uses the shared picker and preserves a deliberate confirmation for visibility changes', () => {
  const picker = read('components/MoveToLibrary.tsx');
  assert.match(picker, /pick\(null\)/);
  assert.match(picker, /Filing between shared libraries keeps files in place\. Changing visibility needs your confirmation\./);
  assert.doesNotMatch(read('app/library/page.tsx'), /function MoveToLibrary\(/);
  assert.match(picker, /moveVisibilityConfirmation\(e\)/);
});

test('current library is shown only for a complete homogeneous selection', () => {
  const rows = [{ id: 'a', libraryId: 'one' }, { id: 'b', libraryId: 'one' }, { id: 'c', libraryId: 'two' }];
  assert.equal(currentSelectionLibrary(new Set(['a']), rows), 'one');
  assert.equal(currentSelectionLibrary(new Set(['a', 'b']), rows), 'one');
  assert.equal(currentSelectionLibrary(new Set(['a', 'c']), rows), undefined);
  assert.equal(currentSelectionLibrary(new Set(['a', 'not-loaded']), rows), undefined);
  assert.equal(currentSelectionLibrary(new Set(), rows), undefined);
});

test('the current-library mark is accessible and does not disable a same-library action', () => {
  setCurrentUser('filing-user');
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(['admin-libraries', 'filing-user'], { content: [
    { id: 'one', name: 'Current library', path: 'manga', age_rating: null },
    { id: 'private', name: 'Private library', path: 'private/owner', managed_private: true, age_rating: null },
  ] });
  const render = (current?: { libraryId: string }, busy = false) => renderToStaticMarkup(createElement(QueryClientProvider, { client },
    createElement(MoveToLibrary, { n: 1, busy, current, onClose() {}, onPick: async () => ({ applied: 1, skipped: [] }) })));
  const current = render({ libraryId: 'one' });
  assert.match(current, /data-library-destination="one"[^>]*aria-current="true"/);
  assert.match(current, />Current</); assert.doesNotMatch(current, /disabled=""/);
  assert.doesNotMatch(current, /private\/owner/, 'private destinations must not expose an internal storage folder');
  assert.doesNotMatch(render(), /aria-current=/);
  const busy = render({ libraryId: 'one' }, true);
  assert.match(busy, /disabled=""[^>]*aria-current="true"/);
  assert.doesNotMatch(busy, /disabled:opacity-50\}/, 'the malformed class suffix returned');
  client.clear(); setCurrentUser(null);
});

test('only a structured visibility 409 can offer an explicit confirmed retry', () => {
  const confirmation = { error: 'visibility_confirmation_required', visibility: 'shared', count: 2 };
  assert.deepEqual(moveVisibilityConfirmation(new ApiError(409, JSON.stringify(confirmation))), { visibility: 'shared', count: 2 });
  for (const value of [new ApiError(403, JSON.stringify(confirmation)), new ApiError(409, '{'),
    new ApiError(409, JSON.stringify({ ...confirmation, count: 0 })), new ApiError(409, JSON.stringify({ ...confirmation, visibility: 'public' })),
    new ApiError(409, JSON.stringify({ error: 'busy' }))]) assert.equal(moveVisibilityConfirmation(value), null);
});

test('the first attempt cannot silently confirm; a retry remains pinned to the original account', async () => {
  const originalFetch = globalThis.fetch;
  const requests: { path: string; json: Record<string, unknown> }[] = [];
  setCurrentUser('filing-user');
  try {
    globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const json = JSON.parse(String(init.body)); requests.push({ path: String(input), json });
      if (!json.confirmVisibilityChange) return new Response(JSON.stringify({ error: 'visibility_confirmation_required', visibility: 'shared', count: 1 }), { status: 409 });
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    await assert.rejects(moveSeriesToLibrary(['a/b'], 'shared'), (e) => !!moveVisibilityConfirmation(e));
    assert.equal(requests.length, 1, 'the refusal must not trigger a silent retry');
    assert.deepEqual(requests[0], { path: '/api/admin/series/a%2Fb/library', json: { libraryId: 'shared' } });
    assert.deepEqual(await moveSeriesToLibrary(['a/b'], 'shared', { confirmVisibilityChange: true, expectedOwnerId: 'filing-user' }), { applied: 1, skipped: [] });
    assert.equal(requests[1].json.confirmVisibilityChange, true);
    setCurrentUser('other-user');
    await assert.rejects(moveSeriesToLibrary(['a/b'], 'shared', { confirmVisibilityChange: true, expectedOwnerId: 'filing-user' }), /API 409/);
    assert.equal(requests.length, 2, 'switching accounts must block the stale retry before the network');
  } finally { globalThis.fetch = originalFetch; setCurrentUser(null); }
});

test('bulk filing deduplicates IDs, retains skipped reasons and says partial success honestly', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      assert.equal(input, '/api/admin/series/library');
      assert.deepEqual(JSON.parse(String(init.body)), { libraryId: null, seriesIds: ['a', 'b'] });
      return new Response(JSON.stringify({ applied: 1, skipped: [{ id: 'b', reason: 'busy' }] }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const result = await moveSeriesToLibrary(['a', 'a', 'b'], null);
    assert.equal(moveLibrarySummary(result), '1 series updated · 1 skipped');
    assert.equal(moveLibraryRefusal(result.skipped[0]), 'This series is busy. Try again after its current task finishes.');
    assert.equal(moveLibraryRefusal(new ApiError(409, JSON.stringify({ error: 'unsafe_files' }))), 'These files cannot be moved safely.');
    assert.equal(moveLibraryRefusal({ reason: 'file_operation_failed', message: 'Folder move failed; originals restored.' }), 'Folder move failed; originals restored.');
  } finally { globalThis.fetch = originalFetch; }
});
