// The series page's four keys and its More (v0.60.0): lib/seriesActions.ts decides who sees what, per role, and
// components/SeriesKeys.tsx draws it -- a menu from lg up, a sheet below.
//
// Under the cover there were eight to twelve stacked buttons, and on a 768-px-tall screen an admin's last ones ran past
// the bottom of the sticky column. Each item keeps the rule it had as a button; those rules are run here per role, the
// sheet is rendered statically (as actionList.test.ts renders its rows), and the page's wiring is read from source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { notesLabel, offlineKeyShown, seriesActionGroups, type SeriesActionsInput } from '../lib/seriesActions';
import { SeriesMoreSheet, moreMenuItems } from '../components/SeriesKeys';
import { setActiveLocale } from '../lib/format';
import { setActiveDict } from '../lib/i18n';

// Under tsx the components compile to the classic `React.createElement`, which they look up as a global.
(globalThis as { React?: unknown }).React = React;
setActiveLocale('en');
setActiveDict({});

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (src: string): string => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const MEMBER: SeriesActionsInput = { isAdmin: false, mayDownload: false, booksCount: 40, mayArchive: false, autoHero: false, hasFolder: false };
const DOWNLOADER: SeriesActionsInput = { ...MEMBER, mayDownload: true, mayArchive: true };
const ADMIN: SeriesActionsInput = { isAdmin: true, mayDownload: true, booksCount: 40, mayArchive: true, autoHero: true, hasFolder: true };
/** The groups as `group: item item …`, the shape a person sees. */
const shape = (x: SeriesActionsInput) => seriesActionGroups(x).map((g) => `${g.id}: ${g.items.map((i) => i.id).join(' ')}`);

test('a member: their reading, and the link -- nothing that fetches or changes the series', () => {
  // Reintroduce Find missing chapters for everyone (drop `x.mayDownload &&`): "a member is offered" fails.
  assert.deepEqual(shape(MEMBER), ['reading: notes markAllRead markAllUnread', 'share: copyLink openTab'], 'a member is offered more than their own');
  const headings = seriesActionGroups(MEMBER).map((g) => g.heading);
  assert.deepEqual(headings, ['Reading', 'Share']);
});

test('one who may download: Find missing chapters from three chapters, and the slow archive while there is something to archive', () => {
  assert.deepEqual(shape(DOWNLOADER), ['reading: notes markAllRead markAllUnread', 'chapters: findMissing archive', 'share: copyLink openTab']);
  // The route refuses Find missing below three chapters, so it is not offered there.
  assert.deepEqual(shape({ ...DOWNLOADER, booksCount: 2 }).find((g) => g.startsWith('chapters')), 'chapters: archive');
  // No archive to start (the page's mayArchive): no Archive slowly.
  assert.deepEqual(shape({ ...DOWNLOADER, mayArchive: false }).find((g) => g.startsWith('chapters')), 'chapters: findMissing');
  // A "Nothing yet" series: nothing to mark.
  assert.deepEqual(shape({ ...DOWNLOADER, booksCount: 0 })[0], 'reading: notes');
});

test('an admin: Check for new chapters, and the admin group with Remove from library last, in red', () => {
  assert.deepEqual(shape(ADMIN), [
    'reading: notes markAllRead markAllUnread',
    'chapters: findMissing archive checkNew',
    'share: copyLink openTab',
    'admin: edit cover newBanner rename remove',
  ]);
  const admin = seriesActionGroups(ADMIN).find((g) => g.id === 'admin')!;
  assert.equal(admin.heading, 'Admin');
  assert.deepEqual(admin.items.map((i) => [i.label, !!i.danger]), [
    ['Edit details', false], ['Change cover', false], ['New banner', false], ['Rename folder', false], ['Remove from library', true],
  ]);
  // New banner only while the hero is the automatic one; Rename folder only with a folder (sent to admins only).
  assert.deepEqual(shape({ ...ADMIN, autoHero: false, hasFolder: false }).at(-1), 'admin: edit cover remove');
  // Never an admin's for anyone else, whatever else is true.
  for (const x of [{ ...ADMIN, isAdmin: false }, { ...DOWNLOADER, autoHero: true, hasFolder: true }]) {
    const ids = seriesActionGroups(x).flatMap((g) => g.items.map((i) => i.id));
    for (const own of ['checkNew', 'edit', 'cover', 'newBanner', 'rename', 'remove'] as const) assert.ok(!ids.includes(own), `${own} is offered to a non-admin`);
  }
});

test('the items a browser walk finds by their hook, whatever the language', () => {
  const all = seriesActionGroups(ADMIN).flatMap((g) => g.items);
  const hook = (id: string) => all.find((i) => i.id === id)?.hook;
  assert.equal(hook('archive'), 'archive-slowly');
  assert.equal(hook('newBanner'), 'new-banner');
  assert.equal(hook('edit'), 'edit-details');
  assert.equal(hook('cover'), 'change-cover');
  assert.equal(hook('remove'), 'remove-series');
});

test('offline the items that need the server are greyed, not hidden; a running job greys its own', () => {
  const off = seriesActionGroups({ ...ADMIN, offline: true }).flatMap((g) => g.items);
  assert.deepEqual(off.filter((i) => !i.disabled).map((i) => i.id), ['notes', 'copyLink', 'openTab']);
  const busy = seriesActionGroups({ ...ADMIN, busy: { checkNew: true, archive: true } }).flatMap((g) => g.items);
  assert.deepEqual(busy.filter((i) => i.disabled).map((i) => i.id), ['archive', 'checkNew']);
});

test('the notes door: saved pages, else notes, else "Add a note" -- and neutral until the counts are asked for', () => {
  // The counts cost two requests and are asked for only when More opens (the page's `askedNotes`).
  assert.equal(notesLabel(null), 'Notes and saved pages');
  assert.equal(notesLabel({ moments: 1, notes: 4 }), '1 saved page');
  assert.equal(notesLabel({ moments: 3, notes: 0 }), '3 saved pages');
  assert.equal(notesLabel({ moments: 0, notes: 1 }), '1 note');
  assert.equal(notesLabel({ moments: 0, notes: 5 }), '5 notes');
  assert.equal(notesLabel({ moments: 0, notes: 0 }), 'Add a note');
  assert.equal(seriesActionGroups({ ...MEMBER, notes: { moments: 2, notes: 0 } })[0].items[0].label, '2 saved pages');
});

test('the Offline key: never in Uchiyomi Desktop, never on a series with nothing to save', () => {
  // Reintroduce the key on desktop (drop `!x.desktop`): the chapters are files on that computer already, and a copy
  // in the window's storage stores every one twice -- "the desktop app shows Offline" fails.
  assert.equal(offlineKeyShown({ nothingYet: false, desktop: false }), true);
  assert.equal(offlineKeyShown({ nothingYet: false, desktop: true }), false, 'the desktop app shows Offline');
  assert.equal(offlineKeyShown({ nothingYet: true, desktop: false }), false, 'a series with nothing to save shows Offline');
});

test('More as a menu: each group named above its first item, icons before the words, Remove apart', () => {
  const picked: string[] = [];
  const items = moreMenuItems(seriesActionGroups(ADMIN), (id) => { picked.push(id); });
  assert.deepEqual(items.map((i) => i.heading ?? null), ['Reading', null, null, 'Chapters', null, null, 'Share', null, 'Admin', null, null, null, null]);
  assert.ok(items.every((i) => i.icon), 'an item has no icon');
  const remove = items.at(-1)!;
  assert.equal(remove.label, 'Remove from library');
  assert.ok(remove.danger && remove.divider, 'Remove from library is not set apart in red');
  assert.equal(items.find((i) => i.label === 'Archive slowly')?.hook, 'archive-slowly');
  void items[3].onSelect();
  assert.deepEqual(picked, ['findMissing']);
});

test('More as a sheet: headed groups of rows, the notes door a link, every row with its hook', () => {
  const html = renderToStaticMarkup(createElement(SeriesMoreSheet, {
    title: 'Walk Tale', groups: seriesActionGroups({ ...ADMIN, notes: { moments: 0, notes: 2 } }), notesHref: '/moments/?series=s1',
    onPick: () => {}, onClose: () => {},
  }));
  assert.match(html, /role="dialog" aria-modal="true" aria-label="Walk Tale"/, 'the sheet is not a named dialog');
  assert.match(html, /data-series-more-sheet/);
  for (const h of ['Reading', 'Chapters', 'Share', 'Admin']) assert.match(html, new RegExp(`<h3[^>]*>${h}</h3>`), `no ${h} heading`);
  // (next/link drops the slash before `?` outside the app, whose export keeps trailing slashes.)
  assert.match(html, /<a [^>]*data-menu-item="notes"[^>]*href="\/moments\/?\?series=s1"[^>]*>.*?2 notes<\/span><\/a>/, 'the notes door is not a link with its count');
  // The two keys that had attributes of their own under the cover keep them on their rows (walk49, heroArt).
  assert.match(html, /<button type="button"[^>]*data-menu-item="archive-slowly" data-archive-slowly=""[^>]*>/);
  assert.match(html, /<button type="button"[^>]*data-menu-item="new-banner" data-new-banner=""[^>]*>/);
  assert.match(html, /data-remove-series=""[^>]*>.*?Remove from library<\/span>/);
  assert.match(html, /class="[^"]*text-rose-300[^"]*"[^>]*data-menu-item="remove-series"/, 'Remove from library is not in red');
  // Over the bottom nav: its last row is not under the bar on a phone.
  assert.match(html, /pb-\[calc\(5\.5rem\+env\(safe-area-inset-bottom\)\)\]/, 'the sheet does not clear the bottom nav');
});

test('the page: four keys under the button, More by width, the sheet closed before its action, the counts asked on opening', () => {
  const page = code(read('app/series/page.tsx'));
  const keys = page.slice(page.indexOf('<div data-series-keys'), page.indexOf('const metaBits'));
  assert.ok(keys.length > 100, 'the key row is not where this test looks');
  const order = ['<FavouriteKey ', 'label={tr(\'Offline\')}', 'label={tr(\'List\')}', '<MoreKey '].map((k) => keys.indexOf(k));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), `the keys are not Favourite, Offline, List, More: ${order}`);
  assert.match(keys, /\{offlineKeyShown\(\{ nothingYet, desktop: isDesktop\(\) \}\) && \(/, 'the Offline key is not offlineKeyShown\'s');
  assert.match(keys, /name=\{downloadingAll \? tr\('Saving…'\) : tr\('Save all offline'\)\} onClick=\{downloadAll\}/, 'the Offline key is not Save all offline');
  assert.match(keys, /label=\{tr\('List'\)\} title=\{tr\('Add to list'\)\} onClick=\{\(\) => setCollecting\(true\)\}/, 'List does not open Add to list');
  // The old stack is gone from under the cover.
  for (const old of ["tr('Find missing chapters')", "tr('Edit details')", "tr('Remove from library')", "tr('Rename folder')", "tr('New banner')", 'data-archive-slowly'])
    assert.ok(!keys.includes(old), `${old} is back under the cover`);
  assert.match(page, /if \(wide\) more\.openFrom\(el\);\s*else setMoreSheet\(true\);/, 'More is not a menu from lg up and a sheet below');
  assert.match(page, /onPick=\{\(a\) => \{ setMoreSheet\(false\); runAction\(a\); \}\}/, 'a row\'s dialog opens under the sheet');
  assert.match(page, /const more = useContextMenu\(\(\) => moreMenuItems\(moreGroups, runAction\), \{ label: title \}\);/);
  // The two count requests wait for More (they ran on every visit).
  assert.equal((page.match(/enabled: !!id && askedNotes,/g) ?? []).length, 2, 'the notes counts are asked for on every visit again');
  assert.match(page, /const openMore = \(el: HTMLElement\) => \{\s*setAskedNotes\(true\);/);
  // The browser walks find the supply line as the visible `button[aria-haspopup="dialog"].w-full` (walk49, walk491,
  // replaceWalk); from lg up the keys come first on the page, and List and a phone's More open dialogs. Reintroduce
  // `w-full` on a key: those walks open Add to collection instead of Sources & translations.
  const keysSrc = code(read('components/SeriesKeys.tsx'));
  for (const name of ['KEY', 'SMALL']) {
    const cls = new RegExp(`const ${name} = '([^']*)'`).exec(keysSrc)?.[1];
    assert.ok(cls !== undefined, `${name} is not where this test looks`);
    assert.doesNotMatch(cls!, /\bw-full\b/, `a key looks like the supply line to the walks (${name})`);
  }
  // Each item runs the page's own action.
  for (const [id, call] of [['remove', 'setDeleting(true)'], ['edit', "setEditing('details')"], ['rename', 'setRenaming(true)'], ['findMissing', 'setFindingMissing(true)'],
    ['archive', 'void archiveSlowly()'], ['newBanner', 'void newBanner()'], ['checkNew', 'void checkNow()'], ['markAllRead', 'void markAllRead()'],
    ['cover', 'setCoverPicker(true)']] as const) {
    assert.ok(page.includes(`case '${id}': ${call}; break;`), `${id} does not run ${call}`);
  }
});
