// The other names a series goes by (lib/altTitles.ts, v0.49.1; the list and the parsing are @TIGamingTV's, PR
// #119): what a description is read for, when an admin's name is refused, and when two names are the same name.
// Pure; no database.
//
// The descriptions are shaped like the ones real extensions write: Madara and MangaThemesia extensions append
// "Alternative Name(s): …" after a blank line, NovelUpdates-style sites write "Associated Names" with one name per
// line, MangaDex-shaped text uses Markdown bold. Each case names the edit that breaks it.
import test from 'node:test';
import assert from 'node:assert/strict';

// lib/altTitles.ts imports the database module, which validates the environment on load; nothing here touches it.
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseAltTitles, isLatinName, refuseName, exactHit, MIN_ALT_KEY } = require('../src/lib/altTitles') as typeof import('../src/lib/altTitles');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { titleMatch } = require('../src/lib/autoFollow') as typeof import('../src/lib/autoFollow');

test('a Madara-style trailer is read, and only its Latin-script names are kept', () => {
  // Reintroduce by dropping the isLatinName filter: the Korean name is kept (and normalises to '').
  const d = 'The weakest hunter of all mankind...\n\nAlternative Name: 나 혼자만 레벨업 ; Only I Level Up ; Na Honjaman Level Up ; Solo Leveling';
  assert.deepEqual(parseAltTitles(d), ['Only I Level Up', 'Na Honjaman Level Up', 'Solo Leveling']);
});

test('a label with the names on the following lines is read until the blank line or the next field', () => {
  const d = 'Summary here.\n\nAssociated Names:\n• Omniscient Reader\n• Jeonjijeok Dokja Sijeom\n• 전지적 독자 시점\n\nStatus: Ongoing';
  assert.deepEqual(parseAltTitles(d), ['Omniscient Reader', 'Jeonjijeok Dokja Sijeom']);
  const e = 'Associated Names:\nThe Beginning After the End\nTBATE Novel\nAuthor: TurtleMe';
  assert.deepEqual(parseAltTitles(e), ['The Beginning After the End', 'TBATE Novel']);
});

test('Markdown bold around the label is read like plain text', () => {
  const d = 'Blurb.\n\n**Alternative Titles:** The Beginning After the End; TBATE';
  // "TBATE" is exactly MIN_ALT_KEY long once normalised, so it is kept.
  assert.deepEqual(parseAltTitles(d), ['The Beginning After the End', 'TBATE']);
  assert.equal(MIN_ALT_KEY, 5);
});

test('a comma list is split on commas only when nothing stronger separates it', () => {
  // "Yes, My Lord" must survive a ;-separated list; a plain comma list is split.
  assert.deepEqual(parseAltTitles('Other names: Yes, My Lord; Lord of Yes'), ['Yes, My Lord', 'Lord of Yes']);
  assert.deepEqual(parseAltTitles('Other names: Return of the Mount Hua Sect, Hwasan Gwihwan'), ['Return of the Mount Hua Sect', 'Hwasan Gwihwan']);
  assert.deepEqual(parseAltTitles('Alt Names: Mercenary Enrollment / Teenage Mercenary'), ['Mercenary Enrollment', 'Teenage Mercenary']);
});

test('prose is never read as names: a label must start a line and be followed by a colon', () => {
  // Reintroduce by making the colon optional in LABEL_LINE: the rest of the sentence becomes a "name".
  assert.deepEqual(parseAltTitles('He was also known as the Demon of the Mount Hua Sect, feared by all.'), []);
  // A description flattened to one line (the site engines' plainText) keeps its label mid-line: not read.
  assert.deepEqual(parseAltTitles('The weakest hunter rises. Alternative Titles: Only I Level Up; Solo Leveling'), []);
  assert.deepEqual(parseAltTitles('A story about swords.'), []);
  assert.deepEqual(parseAltTitles(null), []);
});

test('a field label inside a name drops that name whole, never cuts it at the colon', () => {
  // A list run into the next field on one line. Cutting at the colon would turn "Solo Leveling: Ragnarok" into
  // the parent's name; dropping loses one name instead. Reintroduce by removing the FIELD_INSIDE check: the
  // second entry is kept as a "name".
  assert.deepEqual(parseAltTitles('Alternative Titles: Only I Level Up; Solo Leveling Status: Ongoing Genres: Action'), ['Only I Level Up']);
  assert.deepEqual(parseAltTitles('Other Names: Solo Leveling: Ragnarok; Na Honjaman Level Up Ragnarok'),
    ['Solo Leveling: Ragnarok', 'Na Honjaman Level Up Ragnarok'], 'a colon that is not a field label stays in the name');
});

test('language tags are stripped, short names and duplicates dropped, at most twenty kept', () => {
  const d = 'Alternative Titles: Solo Leveling (English); SOLO LEVELING; Hero; Only I Level Up [Official]';
  assert.deepEqual(parseAltTitles(d), ['Solo Leveling', 'Only I Level Up']);
  const many = `Other names: ${Array.from({ length: 30 }, (_, i) => `Series Name Number ${i}`).join('; ')}`;
  assert.equal(parseAltTitles(many).length, 20);
});

test('Latin script means Latin letters, accents included', () => {
  assert.equal(isLatinName('Pokémon Adventures'), true);
  assert.equal(isLatinName('Na Honjaman Level Up'), true);
  assert.equal(isLatinName('나 혼자만 레벨업'), false);
  assert.equal(isLatinName('進撃の巨人'), false);
  assert.equal(isLatinName('1234'), false);
});

test('a typed name is refused for its script before its length, and a numeric name by its key alone', () => {
  // A Korean name normalises to nothing; "too short" would send the admin looking for a longer spelling of it.
  assert.equal(refuseName('나 혼자만 레벨업'), 'non_latin');
  assert.equal(refuseName('Hero'), 'too_short');
  assert.equal(refuseName('H.E.R.O'), 'too_short', 'the key is what is compared: "hero"');
  assert.equal(refuseName('Solo Leveling'), null);
  assert.equal(refuseName('20240'), null, 'a numeric title with a long enough key is a name');
});

test('an other name picks its search hit exactly, never by containment', () => {
  const hits = [{ title: 'Solo Leveling: Ragnarok', sourceId: 'r' }, { title: 'Only I Level-Up!', sourceId: 'o' }];
  assert.equal(exactHit(hits, 'Only I Level Up')?.sourceId, 'o');
  // Reintroduce pickBest's tiers here: "Solo Leveling" is contained in the sequel's title and would be picked.
  assert.equal(exactHit(hits, 'Solo Leveling'), null);
  assert.equal(exactHit([{ title: 'Hero', sourceId: 'h' }], 'Hero'), null, 'a key under MIN_ALT_KEY never matches');
});

test('the judgement matches an other name exactly or not at all; containment is the main title\'s alone', () => {
  // The sequel shares its parent's name, and other-name lists are where the parent is listed beside the sequel.
  // Reintroduce by testing containment over every name (autoFollow.ts titleMatch): the first line reads contains.
  assert.equal(titleMatch('Solo Leveling: Ragnarok', { title: 'Only I Level Up', altTitles: ['Solo Leveling'] }), null);
  assert.equal(titleMatch('Solo Leveling', { title: 'Only I Level Up', altTitles: ['Solo Leveling'] }), 'exact');
  assert.equal(titleMatch('Only I Level Up (Official)', { title: 'Only I Level Up', altTitles: [] }), 'contains', 'the main title keeps its tiers');
  assert.equal(titleMatch('Hero', { title: 'Something Else', altTitles: ['Hero'] }), null, 'an other name under MIN_ALT_KEY never matches');
});
