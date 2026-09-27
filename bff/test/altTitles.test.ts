// The other names a series goes by (lib/altTitles.ts): what a description is read for, and when two names
// are the same name. Pure; no database.
//
// The descriptions below are shaped like the ones real extensions write: Madara and MangaThemesia append
// "Alternative Name(s): …" after a blank line, NovelUpdates-style sites write "Associated Names" with one
// name per line, MangaDex-shaped text uses Markdown bold. Each case names the edit that breaks it.
import test from 'node:test';
import assert from 'node:assert/strict';

// lib/altTitles.ts imports the database module, which validates the environment on load; nothing here
// touches the database.
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseAltTitles, exactNameMatch, isLatinName, MIN_ALT_KEY } = require('../src/lib/altTitles') as typeof import('../src/lib/altTitles');

test('a Madara-style trailer is read, and only its Latin-script names are kept', () => {
  // Reintroduce by dropping the isLatinName filter: the Korean name is kept, and normalises to ''.
  const d = 'The weakest hunter of all mankind...\n\nAlternative Name: 나 혼자만 레벨업 ; Only I Level Up ; Na Honjaman Level Up ; Solo Leveling';
  assert.deepEqual(parseAltTitles(d), ['Only I Level Up', 'Na Honjaman Level Up', 'Solo Leveling']);
});

test('a label with the names on the following lines is read until the blank line', () => {
  const d = 'Summary here.\n\nAssociated Names\n• Omniscient Reader\n• Jeonjijeok Dokja Sijeom\n• 전지적 독자 시점\n\nStatus: Ongoing';
  assert.deepEqual(parseAltTitles(d.replace('Associated Names', 'Associated Names:')), ['Omniscient Reader', 'Jeonjijeok Dokja Sijeom']);
});

test('Markdown bold around the label is read like plain text', () => {
  const d = 'Blurb.\n\n**Alternative Titles:** The Beginning After the End; TBATE';
  // "TBATE" is under MIN_ALT_KEY once normalised (5 chars is the floor, so it is kept at exactly 5).
  assert.deepEqual(parseAltTitles(d), ['The Beginning After the End', 'TBATE']);
  assert.equal(MIN_ALT_KEY, 5);
});

test('a comma list is split on commas only when nothing stronger separates it', () => {
  // "Yes, My Lord" must survive a ;-separated list; a plain comma list is split.
  assert.deepEqual(parseAltTitles('Other names: Yes, My Lord; Lord of Yes'), ['Yes, My Lord', 'Lord of Yes']);
  assert.deepEqual(parseAltTitles('Other names: Return of the Mount Hua Sect, Hwasan Gwihwan'), ['Return of the Mount Hua Sect', 'Hwasan Gwihwan']);
  assert.deepEqual(parseAltTitles('Alt Names: Mercenary Enrollment / Teenage Mercenary'), ['Mercenary Enrollment', 'Teenage Mercenary']);
});

test('prose is never read as names: a label must be followed by a colon', () => {
  // Reintroduce by making the colon optional in LABEL_LINE: the rest of the sentence becomes a "name".
  assert.deepEqual(parseAltTitles('He was also known as the Demon of the Mount Hua Sect, feared by all.'), []);
  assert.deepEqual(parseAltTitles('A story about swords.'), []);
  assert.deepEqual(parseAltTitles(null), []);
});

test('language tags are stripped, short names and duplicates dropped', () => {
  const d = 'Alternative Titles: Solo Leveling (English); SOLO LEVELING; Hero; Only I Level Up [Official]';
  assert.deepEqual(parseAltTitles(d), ['Solo Leveling', 'Only I Level Up']);
});

test('Latin script means Latin letters, accents included', () => {
  assert.equal(isLatinName('Pokémon Adventures'), true);
  assert.equal(isLatinName('Na Honjaman Level Up'), true);
  assert.equal(isLatinName('나 혼자만 레벨업'), false);
  assert.equal(isLatinName('進撃の巨人'), false);
  assert.equal(isLatinName('1234'), false);
});

test('two names match only when their keys are equal: never by containment', () => {
  // The sequel guard of lib/autoFollow.ts, applied to names. Reintroduce by accepting `includes`: the
  // sequel pair matches.
  assert.equal(exactNameMatch(['Tokyo Ghoul'], ['Tokyo Ghoul:re']), null);
  assert.equal(exactNameMatch(['Solo Leveling'], ['Solo Leveling: Ragnarok', 'Solo Leveling Ragnarok']), null);
  assert.deepEqual(exactNameMatch(['Solo Leveling'], ['SOLO LEVELING!']), { ours: 'Solo Leveling', theirs: 'SOLO LEVELING!', main: true });
});

test('a match through an other name is found both ways, and says it is not the main titles', () => {
  // Their description lists our title.
  assert.deepEqual(
    exactNameMatch(['Solo Leveling'], ['Only I Level Up', 'Solo Leveling', 'Na Honjaman Level Up']),
    { ours: 'Solo Leveling', theirs: 'Solo Leveling', main: false },
  );
  // One of our other names is their title.
  assert.deepEqual(
    exactNameMatch(['Solo Leveling', 'Only I Level Up'], ['Only I Level-Up']),
    { ours: 'Only I Level Up', theirs: 'Only I Level-Up', main: false },
  );
  // Main to main wins over an other-name pair when both exist.
  assert.equal(exactNameMatch(['Gosu', 'The Master'], ['Gosu', 'The Master'])?.main, true);
});

test('an other name under MIN_ALT_KEY never matches, and an empty key never equals another', () => {
  // Reintroduce by dropping the MIN_ALT_KEY check: "Hero" in both lists would tie two unrelated works.
  assert.equal(exactNameMatch(['A Long Title', 'Hero'], ['Unrelated Work', 'Hero']), null);
  assert.equal(exactNameMatch(['나 혼자만 레벨업'], ['전지적 독자 시점']), null, 'two non-Latin titles both normalise to "" and must not match');
  // Short MAIN titles still match each other: the numbering check decides those.
  assert.equal(exactNameMatch(['Gosu'], ['GOSU'])?.main, true);
});
