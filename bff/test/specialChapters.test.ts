// Special chapters (lib/specialChapters.ts): a whole-numbered post that is short on purpose -- a Q&A, a giveaway, an
// author's note -- is read from its title, so Health stops calling it a failed download. Pure; no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { namesSpecial, specialName } from '../src/lib/specialChapters';

test('the specials sources post as whole chapters are read from their titles', () => {
  for (const name of [
    'Q&A Announcement!', 'Q & A', 'QnA time', 'Giveaway!', 'Give-away results', 'Announcement', 'Hiatus Notice',
    "Author's Note", 'Author Note', 'A note from the author', 'Afterword', 'Bonus Illustration', 'Omake', 'Extra',
    'Special Episode', 'Fan Art Contest', 'Season 2 Preview', 'Thank you for 1M views!', '1st Anniversary', 'Poll results',
    'Character Profiles', 'Update', 'Aviso', 'お知らせ', '休載のお知らせ', '공지', '番外篇',
  ]) assert.ok(namesSpecial(name), name);
});

test('a story title is not a special, and a word is matched whole', () => {
  for (const name of [
    'The Other Side', 'Breaking Point', 'Specialist', 'Extraordinary', 'Noticed', 'Bonusless', 'Sketchy Business',
    'Updated Plans', 'Contested Ground', null, undefined, '',
  ]) assert.equal(namesSpecial(name as string), false, String(name));
});

test('a story title that uses a special\'s word is not a special', () => {
  for (const name of [
    'The Announcement', 'The annoucement', 'The Giveaway', 'Bonus Round', 'Special Forces', 'An Unexpected Notice',
    'Extra Lesson', 'Preview of Doom', 'Thank You, Brother', 'Announcement of War', 'The Special One',
  ]) assert.equal(namesSpecial(name), false, name);
  assert.equal(specialName(82, '82. The annoucement'), null);
  assert.equal(specialName(82, '82. The Announcement'), null);
  assert.equal(specialName(82, 'Chapter 82: The Giveaway'), null);
  assert.ok(namesSpecial('Notice about the schedule'), 'a "the" inside a notice is still a notice');
  assert.ok(namesSpecial('Hiatus until next week'));
  assert.ok(namesSpecial('Giveaway results'));
});

test('a title its creator numbered is an episode, whatever it is called', () => {
  for (const t of ['82. Announcement', '82 - Q&A', '#82: Notice', '82) Giveaway!', '  82.5 — Bonus Illustration'])
    assert.equal(specialName(82, t), null, t);
  assert.equal(specialName(82, 'Announcement', '82. Announcement'), null, "the stored name has the number taken off; the file's title does not");
  assert.equal(specialName(82, 'Chapter 82: Q&A'), 'Q&A', 'a source writes "Chapter 82" in front of every post, specials included');
  assert.equal(specialName(82, '1st Anniversary'), '1st Anniversary', 'a count is no chapter number');
  assert.equal(specialName(82, '100 Subscribers Q&A!'), '100 Subscribers Q&A!');
});

test('a title is judged by its own name, after the chapter word and number', () => {
  assert.equal(specialName(25, 'Chapter 25: Q&A'), 'Q&A');
  assert.equal(specialName(25, 'Chapter 25'), null, 'a title that only says the number says nothing');
  assert.equal(specialName(25, null, 'Chapter 25', 'Giveaway!'), 'Giveaway!', 'the first title that names one');
  assert.equal(specialName(25, 'Ch. 25 - The Return'), null);
});


test('an informative saved title wins over a different notice in the current listing', () => {
  assert.equal(specialName(25, 'The Return', 'Chapter 25', 'Q&A'), null);
  assert.equal(specialName(25, null, 'Chapter 25: The Return', 'Q&A'), null);
  assert.equal(specialName(25, 'Q&A', 'Chapter 25', 'The Return'), 'Q&A');
});


test('a localized story mentioning a notice is not classified from a substring', () => {
  assert.equal(namesSpecial('공지: 전쟁의 시작'), false);
  assert.equal(namesSpecial('番外を倒せ'), false);
  assert.ok(namesSpecial('휴재 공지'));
  assert.ok(namesSpecial('番外篇 (2)'));
});
