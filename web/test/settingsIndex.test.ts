// The settings registry (v0.86.0, lib/settingsIndex*.ts) and the pieces the two settings pages are made of.
//
// The owner, 2026-10-19: "a million toggle in setting … easier to find, understand what it does". Profile → Settings and
// Admin → Settings became a few categories with a search over every row. The registry is what that search reads, what a
// `?section=` link resolves through and what the search palette's settings come from -- so it has to name exactly the
// rows the pages draw, no more and no fewer, or a search lands nowhere and a row cannot be found. These read the source
// for that, and call the registry, the search and the new controls for the rest. Every guard names the edit that makes
// it fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PROFILE_SETTINGS } from '../lib/settingsIndex.profile';
import { ADMIN_SETTINGS, SETTINGS_NAME_ALIASES } from '../lib/settingsIndex.admin';
import { rankMatch, readPage, resolveSection, searchPages, searchSettings, withPage, type SettingsCondition, type SettingsIndex } from '../lib/settingsIndex';
import { ChoiceCards, SelectRow, SummaryRow, radioKey } from '../components/settings';
import { INTERVAL_HOURS, clockText, hoursText, intervalChoices } from '../lib/settingsChoices';

// The components are compiled with the classic JSX transform under tsx: React has to be in scope (autofix.test.ts does
// the same).
(globalThis as { React?: unknown }).React = React;
const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file with its comments removed -- comments quote the code they describe. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const PAGES: Array<[SettingsIndex, string[]]> = [
  [PROFILE_SETTINGS, ['components/ProfileSettings.tsx']],
  [ADMIN_SETTINGS, ['components/AdminSettings.tsx', 'components/ArchiveSettings.tsx', 'components/AdminNotifications.tsx', 'components/TranslateSettings.tsx',
    'components/NetworkSettings.tsx']],
];
const ALL: Record<SettingsCondition, boolean> = { web: true, 'local-accounts': true, extensions: true, pointer: true, talk: true };
const en = (k: string) => k;
const ids = (files: string[]) => new Set(files.flatMap((f) => [...code(read(f)).matchAll(/\bid="([a-z0-9-]+)"/g)].map((m) => m[1])));
/** An id on these pages that is no row: an input's own id, which its label points at. */
const NOT_ROWS = new Set(['scanlator-patience']);

test('every row the registry names is drawn, and every row drawn is named', () => {
  // Reintroduce a row without its id (drop `id="smart-checks"`): "a setting the search offers is drawn nowhere" fails; a
  // row with an id the registry lacks (`id="secret-row"` on a SwitchRow): "a row search cannot find" fails.
  for (const [index, files] of PAGES) {
    const drawn = ids(files);
    const folds = new Set(index.entries.flatMap((e) => (e.more ? [e.more] : [])));
    const cats = new Set(index.categories.map((c) => c.id));
    for (const e of index.entries) assert.ok(drawn.has(e.id), `${index.page}: a setting the search offers is drawn nowhere: ${e.id}`);
    const named = new Set(index.entries.map((e) => e.id));
    for (const id of drawn) {
      assert.ok(named.has(id) || folds.has(id) || cats.has(id) || NOT_ROWS.has(id), `${index.page}: a row search cannot find: ${id}`);
    }
    // Ids are unique across the page: a row is found by `getElementById`.
    assert.equal(named.size, index.entries.length, `${index.page}: two settings share an id`);
    for (const e of index.entries) assert.ok(cats.has(e.cat), `${index.page}: ${e.id} is in a category the page does not have: ${e.cat}`);
  }
});

test('a category shows at most eight rows; the rest fold under More options or open from a summary row', () => {
  // The owner's "a million toggle": a category is short enough to read at a glance. Reintroduce by moving Smart update
  // checks out of More options (drop its `more`): Downloads shows nine rows and this fails.
  for (const [index] of PAGES) {
    for (const c of index.categories) {
      const top = index.entries.filter((e) => e.cat === c.id && !e.more && !e.editor);
      assert.ok(top.length <= 8, `${index.page} → ${c.id} shows ${top.length} rows: ${top.map((e) => e.id).join(', ')}`);
    }
  }
});

test('every editor opens from its summary row, and every fold is a More options on the page', () => {
  // Reintroduce a row inside an editor whose summary row is gone: "an editor nothing opens" fails; a fold the page does
  // not draw (`more: 'x'`): "a fold the page does not draw" fails.
  for (const [index, files] of PAGES) {
    const src = files.map((f) => code(read(f))).join('\n');
    for (const e of index.entries) {
      if (e.editor) {
        const head = index.entries.find((x) => x.id === e.editor);
        assert.ok(head && !head.editor && head.cat === e.cat, `${index.page}: an editor nothing opens: ${e.editor}`);
        assert.ok(src.includes(`useEditor('${e.editor}')`), `${index.page}: the editor ${e.editor} is not opened by search`);
        assert.match(src, new RegExp(`<SummaryRow id="${e.editor}" ref=\\{\\w+\\.row\\}`), `${index.page}: ${e.editor} has no summary row that focus returns to`);
      }
      if (e.more) assert.ok(src.includes(`<MoreOptions id="${e.more}">`), `${index.page}: a fold the page does not draw: ${e.more}`);
    }
  }
});

test('an address from before the redesign lands where its card\'s rows are now', () => {
  // Saved links, other pages' links and older docs say `?section=schedules` and the like. Reintroduce by dropping the
  // legacy map: "schedules lands nowhere" fails.
  assert.deepEqual(resolveSection(ADMIN_SETTINGS, 'schedules'), { cat: 'downloads' }, 'schedules lands nowhere');
  assert.deepEqual(resolveSection(ADMIN_SETTINGS, 'housekeeping'), { cat: 'maintenance' });
  assert.deepEqual(resolveSection(ADMIN_SETTINGS, 'backup-time'), { cat: 'maintenance', row: 'nightly-backup', more: undefined, editor: undefined });
  // Card ids that are rows now, or categories: the old slow archive card's `downloads` is the Downloads category.
  // A summary row is landed on, not opened: its editor opens for a row inside it (archive-free-space below).
  assert.deepEqual(resolveSection(ADMIN_SETTINGS, 'scanlators'), { cat: 'downloads', row: 'scanlators', more: undefined, editor: undefined });
  assert.deepEqual(resolveSection(ADMIN_SETTINGS, 'downloads'), { cat: 'downloads' });
  assert.deepEqual(resolveSection(ADMIN_SETTINGS, 'smart-checks'), { cat: 'downloads', row: 'smart-checks', more: 'downloads-more', editor: undefined });
  assert.deepEqual(resolveSection(ADMIN_SETTINGS, 'archive-free-space'), { cat: 'downloads', row: 'archive-free-space', more: undefined, editor: 'slow-archive' });
  assert.deepEqual(resolveSection(PROFILE_SETTINGS, 'appearance'), { cat: 'appearance' });
  assert.deepEqual(resolveSection(PROFILE_SETTINGS, 'downloads'), { cat: 'device', row: 'downloads', more: undefined, editor: undefined });
  assert.deepEqual(resolveSection(PROFILE_SETTINGS, 'device'), { cat: 'device' });
  // Another card of the same page (Account's two-factor) is not this registry's: lib/useSectionArrival.ts answers it.
  assert.equal(resolveSection(PROFILE_SETTINGS, 'two-factor'), null);
  assert.equal(resolveSection(PROFILE_SETTINGS, null), null);
  assert.equal(resolveSection(ADMIN_SETTINGS, 'constructor'), null, 'a prototype key resolves');
});

test('search finds a row by its words, in the reader\'s language, by its old name and its help, and never one not drawn', () => {
  // Reintroduce matching the English label alone: "the label in the reader's language" fails; drop the aliases: "an old
  // name finds nothing" fails; drop the conditions from the filter: "Desktop is offered" fails.
  const find = (index: SettingsIndex, q: string, o: Partial<{ conds: Record<SettingsCondition, boolean>; label: (k: string) => string }> = {}) =>
    searchSettings(index, q, o.conds ?? ALL, o.label ?? en, 20).map((e) => e.id);
  assert.deepEqual(find(ADMIN_SETTINGS, 'backup').slice(0, 2).sort(), ['backups-keep', 'nightly-backup']);
  assert.ok(find(ADMIN_SETTINGS, 'discord').includes('notify-targets'), 'a word someone types does not find it');
  assert.equal(find(PROFILE_SETTINGS, 'rtl')[0], 'reading-direction');
  assert.equal(find(PROFILE_SETTINGS, 'dire')[0], 'reading-direction');
  const fr = (k: string) => ({ 'Nightly backup': 'Sauvegarde nocturne' } as Record<string, string>)[k] ?? k;
  assert.equal(find(ADMIN_SETTINGS, 'sauvegarde', { label: fr })[0], 'nightly-backup', 'the label in the reader\'s language');
  assert.equal(find(ADMIN_SETTINGS, 'nightly backup', { label: fr })[0], 'nightly-backup', 'English stops finding it in another language');
  assert.ok(find(ADMIN_SETTINGS, 'scanlators').includes('scanlators'), 'an old name finds nothing: Scanlators');
  assert.ok(find(ADMIN_SETTINGS, 'housekeeping').includes('nightly-repair'), 'an old name finds nothing: Library housekeeping');
  assert.deepEqual(Object.keys(SETTINGS_NAME_ALIASES).sort(), ['Library housekeeping', 'Scanlators', 'Updates & schedules']);
  // A row's help is searched too, below its name and words, and only by whole words.
  assert.ok(find(ADMIN_SETTINGS, 'followed series').includes('update-interval'), 'the help is not searched');
  assert.equal(rankMatch('ollowe', ['Library update interval'], [], ['How often every followed series is asked']), -1, 'the help matched inside a word');
  // Chinese and Japanese are written without spaces: two characters inside a label find it.
  const ja = (k: string) => (k === 'Reading direction' ? '読む方向' : k);
  assert.equal(find(PROFILE_SETTINGS, '方向', { label: ja })[0], 'reading-direction');
  // Never a row the page does not draw here.
  const desktop = { ...ALL, web: false };
  for (const id of ['translate', 'registration', 'install-count', 'member-defaults-link', 'mihon-missing']) {
    assert.ok(!find(ADMIN_SETTINGS, ADMIN_SETTINGS.entries.find((e) => e.id === id)!.label, { conds: desktop }).includes(id), `Desktop is offered ${id}`);
  }
  assert.deepEqual(find(PROFILE_SETTINGS, 'install', { conds: desktop }), [], 'Desktop is offered This device');
  assert.ok(!find(ADMIN_SETTINGS, 'registration', { conds: { ...ALL, 'local-accounts': false } }).includes('registration'), 'SSO-only is offered sign-ups');
  assert.ok(!find(ADMIN_SETTINGS, 'extension', { conds: { ...ALL, extensions: false } }).some((id) => id.startsWith('extension-')), 'no engine, and the extension rows are offered');
  assert.ok(!find(PROFILE_SETTINGS, 'compact', { conds: { ...ALL, pointer: false } }).includes('compact-chapters'), 'a phone is offered a computer-only row');
  assert.deepEqual(find(ADMIN_SETTINGS, 'b'), [], 'one character searches');
});

test('the page is in the address, beside everything else, and the search finds pages by name and by what they hold', () => {
  // v0.88.0. Reintroduce `withPage` dropping the other parameters: "the card is lost" fails; readPage taking a page this
  // console does not draw: "a hidden page opens" fails; searchPages without the keywords: "Tasks does not find
  // Maintenance" fails.
  const ids = ADMIN_SETTINGS.categories.map((c) => c.id);
  assert.equal(readPage(ADMIN_SETTINGS, 'downloads', null, ids), 'downloads');
  assert.equal(readPage(ADMIN_SETTINGS, 'Downloads', null, ids), 'downloads', 'a capitalised name is not read');
  assert.equal(readPage(ADMIN_SETTINGS, null, 'downloads', ids), null, 'a cat= alone opens a page');
  assert.equal(readPage(ADMIN_SETTINGS, 'sessions', null, ids.filter((id) => id !== 'sessions')), null, 'a hidden page opens');
  assert.equal(withPage('/profile/?tab=connections&card=tracking', 'account'), '/profile/?card=tracking&tab=account', 'the card is lost');
  assert.equal(withPage('/admin/?tab=Settings&cat=server#x', null), '/admin/#x');
  const pages = (q: string, conds = ALL) => searchPages(ADMIN_SETTINGS, q, conds, (k) => k, () => true).map((c) => c.id);
  assert.equal(pages('Tasks')[0], 'maintenance', 'Tasks does not find Maintenance');
  assert.equal(pages('heal')[0], 'health');
  assert.ok(!pages('sessions', { ...ALL, web: false }).includes('sessions'), 'Desktop is offered Sessions');
  assert.deepEqual(searchPages(PROFILE_SETTINGS, 'anilist', ALL, (k) => k, () => true).map((c) => c.id), ['connections'], 'a tracker does not find Connections');
});

test('picture cards are one radio group: one tab stop, the stored value checked, the card\'s own attributes on it', () => {
  // Reintroduce `tabIndex={0}` on every card: "every card is a tab stop" fails; drop `optionProps`: the walks' tone
  // cards lose `data-tone-choice` and "a card lost its attributes" fails.
  const html = renderToStaticMarkup(createElement(ChoiceCards<'a' | 'b' | 'c'>, {
    label: 'Mode', value: 'b', onChange: () => {},
    options: [{ value: 'a', label: 'A', art: null }, { value: 'b', label: 'B', art: null }, { value: 'c', label: 'C', art: null }],
    optionProps: (v) => ({ 'data-card': v }),
  }));
  assert.match(html, /role="radiogroup" aria-label="Mode"/);
  assert.equal((html.match(/role="radio"/g) ?? []).length, 3);
  assert.equal((html.match(/tabindex="0"/g) ?? []).length, 1, 'every card is a tab stop');
  assert.match(html, /role="radio" aria-checked="true" tabindex="0"[^>]*data-card="b"/, 'the stored value is not the checked tab stop');
  for (const v of ['a', 'b', 'c']) assert.ok(html.includes(`data-card="${v}"`), 'a card lost its attributes');
  // Nothing stored that is an option: the first card is the tab stop, or the group could not be reached by keyboard.
  const none = renderToStaticMarkup(createElement(ChoiceCards<'a' | 'b'>, {
    label: 'X', value: null, onChange: () => {}, options: [{ value: 'a', label: 'A', art: null }, { value: 'b', label: 'B', art: null }],
  }));
  assert.match(none, /aria-checked="false" tabindex="0"/);
  // The arrows go to the next card in the reading direction, and wrap.
  assert.equal(radioKey('ArrowRight', 0, 3, false), 1);
  assert.equal(radioKey('ArrowRight', 0, 3, true), 2, 'ArrowRight is "next" in Arabic too');
  assert.equal(radioKey('ArrowLeft', 2, 3, true), 0);
  assert.equal(radioKey('ArrowDown', 2, 3, false), 0);
  assert.equal(radioKey('Home', 2, 3, false), 0);
  assert.equal(radioKey('End', 0, 3, false), 2);
  assert.equal(radioKey('a', 0, 3, false), null);
});

test('a menu row is the platform\'s own menu, named by its label, showing what is stored', () => {
  // Reintroduce the label without `htmlFor`: "the menu has no name" fails.
  const html = renderToStaticMarkup(createElement(SelectRow<string>, {
    id: 'update-interval', label: 'Library update interval', value: '6', onChange: () => {},
    options: intervalChoices(6).map((h) => ({ value: String(h), label: hoursText(h) })),
  }));
  assert.match(html, /<div id="update-interval"/);
  const forId = /<label for="([^"]+)"/.exec(html)?.[1];
  assert.ok(forId && html.includes(`<select id="${forId}"`), 'the menu has no name');
  assert.match(html, /<option value="6" selected="">6 hours<\/option>/, 'the stored value is not the one shown');
});

test('a summary row is one target: a button that opens its editor, or a real link', () => {
  // Reintroduce a small chevron button inside the row: "the row is not one target" fails.
  const button = renderToStaticMarkup(createElement(SummaryRow, { id: 'scanlators', label: 'Scanlation groups', value: 'Asura Scans', onClick: () => {} }));
  assert.match(button, /^<button id="scanlators" type="button" aria-haspopup="dialog"/, 'the row is not one target');
  assert.equal((button.match(/<button/g) ?? []).length, 1, 'the row is not one target');
  assert.ok(button.includes('Asura Scans'), 'the row does not say what is set');
  const src = code(read('components/settings.tsx'));
  // A link is a link -- a middle click opens a tab -- and its plain click arrives the way the palette's destinations do.
  assert.match(src, /return <Link id=\{id\} ref=\{ref as Ref<HTMLAnchorElement>\} href=\{href\} onClick=\{go\} className=\{cls\}>\{inner\}<\/Link>;/);
  assert.match(src, /const how = arrival\(href, window\.location, \(s\) => !!document\.getElementById\(s\)\);/);
});

test('menus name hours and times in the reader\'s language, and keep a stored value that is not one of their steps', () => {
  // Reintroduce `INTERVAL_HOURS` alone as the choices: a server set to 5 hours before v0.86.0 shows 6 and "the stored
  // value is not offered" fails.
  assert.equal(hoursText(6), '6 hours');
  assert.equal(hoursText(1), '1 hour');
  assert.equal(hoursText(24), '1 day');
  assert.equal(hoursText(72), '3 days');
  assert.equal(hoursText(168), '1 week');
  assert.deepEqual(intervalChoices(6), [...INTERVAL_HOURS]);
  const five = intervalChoices(5);
  assert.ok(five.includes(5), 'the stored value is not offered');
  assert.deepEqual(five, [...five].sort((a, b) => a - b), 'the menu is not in order');
  assert.ok(!intervalChoices(999).includes(999), 'a value the server refuses is offered');
  assert.match(clockText(3), /^(?:3:00\s?AM|03:00)$/);
});

test('the console never caps the page, keeps its queries to its own container, and lands on a row once', () => {
  // ⚠️ The console's container is NAMED: the pane is a container too, and an unnamed query inside it measured the pane
  // (v0.86.0's phone Back key showed beside a 736 px pane at 1440). Reintroduce `@min-[52.5rem]:hidden` on the Back key:
  // "a query is not the console's own" fails.
  const src = code(read('components/ConsoleLayout.tsx'));
  assert.match(src, /className="@container\/console" data-console data-settings-layout/);
  assert.doesNotMatch(src, /@(?:min|max)-\[[\d.]+rem\]:/, 'a query is not the console\'s own');
  assert.match(src, /className="btn-key mb-4 gap-1 [^"]*@min-\[52\.5rem\]\/console:hidden" data-console-back/);
  assert.match(src, /@container\/pane/, 'the pane is not a container of its own');
  // The page's own arrival leaves the console's rows to it, or two scrolls would fight (lib/useSectionArrival.ts).
  assert.match(code(read('lib/useSectionArrival.ts')), /if \(el\.closest\('\[data-settings-layout\]'\)\) return;/);
  // A row is landed on once per arrival: the target's sequence, not the page, starts the effect.
  assert.match(src, /\}, \[target\]\); \/\/ eslint-disable-line react-hooks\/exhaustive-deps -- once per arrival/);
});
