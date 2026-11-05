// Special chapters: posts a source numbers as a whole chapter that are short on purpose.
//
// Health's "Suspiciously short chapters" (lib/health.ts) and the repair's short step (lib/repair.ts stepShort) treat a
// whole-numbered chapter of one or two pages as a failed download. Half-chapters were always left out, since author
// notices numbered N.5 really are one page, but plenty of sources give a special a whole number of its own: a "Q&A
// Announcement!", a "Giveaway!", an author's note, a bonus illustration, a hiatus notice. Those were findings until
// somebody pressed "It's fine" on each, and the nightly hunted other sources for longer copies that do not exist.
//
// A chapter whose own name says it is one of those is left out. The name is the one a source gave (lib_books.
// chapter_name, the file's title, the listing's title for its number), with the chapter word and the number taken off
// the front by chapterName(), so "Chapter 25: Q&A" is judged by "Q&A" and a plain "Chapter 25" says nothing.
//
// Pure: no database (specialChapters.test.ts imports it).
import { chapterName } from './naming';

// ⚠️ THE WHOLE NAME MUST SAY SO, not one word of it. A story title may carry the same words: "82. The Announcement",
// "The Giveaway", "Bonus Round", "Special Forces" are episodes, and one that downloaded as one page is a failed download
// like any other. So a name is a special only when, once its special words are taken out, nothing is left but the small
// words a notice is written with (FILLER: "for", "results", "1M", "views") -- and it does not open with "the", which is
// how a story is titled and a notice is not ("Notice about the schedule" is one). Reintroduce matching any word: "a
// story title that uses a special's word is not a special" in specialChapters.test.ts fails.
const WORDS = [
  'q\\s*&\\s*a', 'q\\s+and\\s+a', 'qna', 'faq',
  'give\\s*-?\\s*aways?', 'announcements?', 'announcing', 'notices?', 'updates?', 'psa',
  "author(?:['’]?s)?\\s+notes?", "notes?\\s+from\\s+the\\s+authors?", "creator(?:['’]?s)?\\s+notes?", 'afterwords?', 'postscripts?',
  'bonus(?:es)?', 'omake', 'extras?', 'specials?', 'illustrations?', 'fan\\s*-?\\s*arts?', 'art\\s*works?', 'sketch(?:es)?',
  'polls?', 'contests?', 'hiatus', 'delay(?:ed)?', 'thank\\s+you', 'thanks', 'anniversary',
  'celebrations?', 'recruit(?:ment|ing)', 'previews?', 'teasers?', 'character\\s+profiles?',
  // Other languages sources are written in.
  'aviso', 'anuncio', 'annonce', 'ankündigung', 'hinweis', 'объявление', 'анонс', 'thông báo',
];
// Localized notice labels must stand on their own too; a story can mention a notice.
const ANYWHERE = ['お知らせ', 'あとがき', '告知', '公告', '通知', '番外', '特別編', '特别篇', '休刊', '休載のお知らせ', '重要なお知らせ', '番外篇', '番外編', '공지', '공지사항', '휴재', '휴재공지', '휴재 공지', '후기', '특별편'];

// The small words a notice is written with, beside its special words: "Giveaway results", "Thank you for 1M views!",
// "Season 2 Preview", "Hiatus until next week", "Notice about the schedule". No word a story is told with.
const FILLER = [
  'a', 'an', 'and', 'or', 'of', 'for', 'from', 'to', 'on', 'in', 'at', 'with', 'about', 'regarding', 'the',
  'our', 'my', 'your', 'you', 'us', 'me', 'everyone', 'all', 'is', 'are', 'will', 'be', 'please',
  'readers?', 'fans?', 'followers?', 'subscribers?', 'views?', 'likes?', 'results?', 'winners?', 'time', 'info',
  'season', 'vol', 'volume', 'part', 'episode', 'ep', 'chapter', 'ch', 'new', 'mini', 'short', 'small', 'little', 'big',
  'important', 'official', 'quick', 'final', 'end', 'until', 'next', 'week', 'weeks', 'month', 'months', 'soon', 'back',
  'schedule', 'release', 'x',
];

const whole = (words: string[]) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
const SPECIAL_WORDS = whole(WORDS);
const FILLER_WORDS = whole(FILLER);
const ANYWHERE_RE = new RegExp(`^[\\p{P}\\p{Z}\\s]*(?:${ANYWHERE.join('|')})[\\p{P}\\p{Z}\\s\\p{N}]*$`, 'u');
// A count or an ordinal: "1st", "100th", "1M", "10k", "2".
const COUNTS = /(?<![\p{L}\p{N}])\d+(?:[.,]\d+)?(?:st|nd|rd|th|k|m)?(?![\p{L}\p{N}])/giu;
// A story's opening word. A notice does not open with "the"; "The Announcement" is an episode.
const STORY_OPENING = /^[^\p{L}\p{N}]*the(?![\p{L}\p{N}])/iu;

/** Does this chapter name (already without its chapter word and number) name a special, all of it? */
export function namesSpecial(name: string | null | undefined): boolean {
  if (!name) return false;
  if (ANYWHERE_RE.test(name)) return true;
  if (STORY_OPENING.test(name)) return false;
  const rest = name.replace(SPECIAL_WORDS, ' ');
  if (rest === name) return false;
  // Anything left that is a letter is a word the story is told with.
  return !/\p{L}/u.test(rest.replace(FILLER_WORDS, ' ').replace(COUNTS, ' '));
}

// A number its creator wrote in front of the title, with no chapter word: "82. Announcement", "82 - Q&A", "#82: Notice".
// A source writes "Chapter 82: ..." in front of every post, specials included; a creator numbers only the episodes. A
// count is no such number: "1st Anniversary" and "100 Subscribers!" have no separator after theirs.
const CREATOR_NUMBERED = /^[^\p{L}\p{N}#]*#?\s*\d+(?:\.\d+)?\s*[.:\-–—)|~]/u;

/** Did the creator number this title as an episode ("82. Announcement")? */
export const creatorNumbered = (title: string | null | undefined): boolean => !!title && CREATOR_NUMBERED.test(title);

/**
 * The first of a chapter's titles that names a special, as its own name (without the chapter word and number), or null
 * when none does. Each title is read as chapterName() reads it, so a title that only says the number says nothing. And
 * none is, when ANY of them carries its creator's own number: "82. Announcement" is episode 82 whatever it is called,
 * even where the stored name has the number taken off ("Announcement"). Reintroduce reading each title alone: "a title
 * its creator numbered is an episode" in specialChapters.test.ts fails.
 */
export function specialName(number: number, ...titles: Array<string | null | undefined>): string | null {
  if (titles.some(creatorNumbered)) return null;
  // A saved release name or an informative file title describes the bytes on disk. A later
  // listing can choose a different group's notice at the same number; it must not hide a
  // suspiciously short story chapter we actually downloaded. Fall through only for generic titles.
  for (const t of titles) {
    const name = chapterName(t, number);
    if (name) return namesSpecial(name) ? name : null;
  }
  return null;
}
