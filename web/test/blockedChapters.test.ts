// A blocked group's chapters still downloaded (#396, components/BlockedChapters.tsx): counted where a group is blocked,
// named by number, asked at once under a group just blocked, and removed completely only when the admin says so; and
// Block & remove from the chapters themselves (components/BlockGroupsDialog.tsx).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blockedChaptersText, blockedNumbersText, chapterGroups } from '../components/BlockedChapters';
import { blockRemoveText } from '../components/BlockGroupsDialog';

const read = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8');

test('the question says how many chapters, series and readers it is about', () => {
  const one = blockedChaptersText({ chapters: 1, series: 1, readers: 0 }, false);
  assert.match(one, /^1 downloaded chapter is only from blocked groups\. Remove them completely/);
  assert.doesNotMatch(one, /history/, 'nobody read it: no history to lose');
  assert.match(blockedChaptersText({ chapters: 3, series: 1, readers: 1 }, false), /^3 downloaded chapters .* for 1 reader\.$/);
  assert.match(blockedChaptersText({ chapters: 3, series: 2, readers: 4 }, true), /They are in 2 different series\..* for 4 readers\.$/);
  assert.doesNotMatch(blockedChaptersText({ chapters: 3, series: 2, readers: 0 }, false), /different series/, 'one series\' sheet names no series count');
});

test('and names the chapter numbers it removes, short: by series for every series, capped', () => {
  const b = (seriesId: string, number: number) => ({ seriesId, seriesTitle: seriesId.toUpperCase(), number });
  assert.equal(blockedNumbersText([b('a', 341), b('a', 340), b('a', 340)], false), 'Ch. 340, 341', 'sorted, one number once');
  assert.equal(blockedNumbersText([b('a', 340), b('b', 12)], true), '\u2068A\u2069: Ch. 340 · \u2068B\u2069: Ch. 12');
  const many = Array.from({ length: 15 }, (_, i) => b('a', i + 1));
  assert.equal(blockedNumbersText(many, false), 'Ch. 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 +3 more');
  assert.equal(blockedNumbersText([b('a', 1), b('a', 2), b('b', 3)], true, 2), '\u2068A\u2069: Ch. 1, 2 +1 more', 'a series past the cap is counted, not named');
  const ask = read('components/BlockedChapters.tsx');
  assert.match(ask, /data-blocked-chapters-numbers>\{blockedNumbersText\(data\.books, everySeries\)\}/);
});

test('the groups behind picked chapters: the file\'s stamp, then every group that lists the number', () => {
  const copies: Record<number, Array<{ groups?: string[]; scanlator?: string | null }>> = {
    340: [{ groups: ['Troll'] }, { groups: ['Copycat'], scanlator: 'Copycat' }, { groups: [], scanlator: 'troll' }],
    341: [{ groups: ['Other', 'Copycat'] }],
  };
  assert.deepEqual(chapterGroups([{ number: 340, scanlator: 'Troll & Friend' }], (n) => copies[n] ?? []), ['Troll', 'Friend', 'Copycat']);
  assert.deepEqual(chapterGroups([{ number: 340, scanlator: null }, { number: 341, scanlator: 'Other' }], (n) => copies[n] ?? []),
    ['Other', 'Troll', 'Copycat'], 'deduped by the server\'s equality');
  assert.deepEqual(chapterGroups([{ number: 9, scanlator: null }], () => []), []);
});

test('Block & remove says what goes before it goes', () => {
  assert.equal(blockRemoveText({ chapters: 1, readers: 0 }), '1 downloaded chapter is then only from blocked groups: removed completely.');
  assert.match(blockRemoveText({ chapters: 2, readers: 3 }), /^2 downloaded chapters .* for 3 readers\.$/);
  const dialog = read('components/BlockGroupsDialog.tsx');
  assert.match(dialog, /block-groups\/preview`, \{ json: \{ groups: ticked, selected \} \}/, 'the preview is the server\'s, for the ticked groups');
  assert.match(dialog, /json: \{ groups: ticked, selected, bookIds: preview\.books\.map\(\(b\) => b\.id\) \}/, 'the confirm removes exactly what was shown');
  assert.match(dialog, /blockedNumbersText\(preview\.books, false\)/);
});

test('asked under the Sources sheet\'s group rows and in the Scanlation groups editor, and a block re-counts', () => {
  const sheet = read('components/SourcesSheet.tsx');
  assert.match(sheet, /\{isAdmin && !blockedNow && <BlockedChaptersAsk seriesId=\{id\} \/>\}\s*<\/section>/);
  assert.match(sheet, /void qc\.invalidateQueries\(\{ queryKey: blockedChaptersKey\(id\) \}\);\s*onSaved\(\);/);
  const settings = read('components/AdminSettings.tsx');
  assert.match(settings, /<div id="blocked-groups">[\s\S]*?<BlockedChaptersAsk \/>\s*<\/div>/);
  assert.match(settings, /void qc\.invalidateQueries\(\{ queryKey: \['blocked-chapters'\] \}\);/);
});

test('a Block under "Translated by" asks at once, under that row, when it left chapters to blocked groups alone', () => {
  const sheet = read('components/SourcesSheet.tsx');
  assert.match(sheet, /block-groups`, \{ json: \{ groups: \[name\] \} \}\);/);
  assert.match(sheet, /if \(r\.found\?\.chapters\) setBlockedNow\(\{ group: normGroup\(name\), data: r\.found \}\);/);
  assert.match(sheet, /blockedNow\?\.group === normGroup\(g\.name\) && \(\s*<BlockedChaptersPrompt hook="now" focus/);
});

test('removing is a confirmed step with the ids that were shown, asked inline (a dialog under a Sheet cannot be tapped)', () => {
  const ask = read('components/BlockedChapters.tsx');
  assert.match(ask, /'\/api\/admin\/blocked-chapters\/purge', \{\s*method: 'POST', json: \{ bookIds: data\.books\.map\(\(b\) => b\.id\) \}/);
  assert.match(ask, /role="alertdialog"/);
  assert.doesNotMatch(ask, /<ConfirmDialog|<Modal/);
  assert.match(ask, /setKept\(asked\)/, 'Keep answers for the chapters asked about only');
});

test('Block & remove is offered from a chapter\'s menu and the select bar, to admins, on files Uchiyomi downloaded', () => {
  const page = read('app/series/page.tsx');
  assert.match(page, /onBlock=\{isAdmin && b\.owned && b\.numberEnd == null \? \(\) => setBlocking\(\[b\]\) : undefined\}/);
  assert.match(page, /const blockable = pickedBookList\.filter\(\(b\) => b\.owned && b\.numberEnd == null\);/);
  assert.match(page, /\{isAdmin && \(\s*<button disabled=\{acting \|\| !blockable\.length\} onClick=\{\(\) => setBlocking\(blockable\)\}/);
  assert.match(page, /<BlockGroupsDialog seriesId=\{id\} books=\{blocking\}/);
});
