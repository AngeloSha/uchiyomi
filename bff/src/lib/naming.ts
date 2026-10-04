// Filename and chapter-name helpers for the library scanner and the numbering logic. Kept dependency-free (no
// db/sharp imports) so they can be unit-tested without booting the app's environment, and so lib/postingOrder.ts
// can use them without reaching the database.

/**
 * The first number in a filename — "Chapter 12.cbz" -> 12, "Tome 01.cbr" -> 1, "Ch. 4.5" -> 4.5. 0 if none.
 *
 * Name rule 1: how every chapter was numbered until v0.55.2, and how every chapter scanned before it still is
 * (`numberByRule`). Also the page order inside an archive (naturalCmp), which is not a chapter number at all.
 */
export function numFromName(name: string): number {
  const m = name.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

/** A chapter number read from a file name: one chapter, or a file holding every chapter from `number` to `end`. */
export interface NameNumber {
  number: number;
  /** The last chapter of a range (`Batman 01-07` -> 7), always above `number`; null for one chapter. */
  end: number | null;
}

/**
 * lib_books.name_rule: which rule read a row's number out of its file name. 1 is numFromName, the first number;
 * 2 is chapterFromName (v0.55.2, discussion #150). A row is read by the rule it was first scanned with for as long
 * as it lives (lib/library.ts persistScan), so a better parser never renumbers a chapter already in a library: a
 * completed chapter's number is what the trackers were told (the book_overrides note in lib/migrate.ts).
 */
export type NameRule = 1 | 2;
/** The rule a file the scanner has never seen is read by. */
export const NAME_RULE: NameRule = 2;

/** A file name read by the rule its row carries. A rule this release does not know is read by the newest it does. */
export function numberByRule(name: string, rule: number): NameNumber {
  return rule === 1 ? { number: numFromName(name), end: null } : chapterFromName(name);
}

const NUM = String.raw`\d+(?:\.\d+)?`;
const ARCHIVE_EXT = /\.(?:cbz|cbr|zip|rar|pdf|epub)$/i;
// The words that name a volume: "Vol 3", "Volume 3", "Tome 3", "Band 3", "Том 3". VOLUME, below, takes the same ones
// off the front of a chapter's name.
const VOLUME_WORD = String.raw`(?:vol(?:ume)?|tome|band|том)`;
// Rule 1: a chapter word, then at most a dot and some spacing, then the number. Never the inside of a word: "Batch 5"
// and "Escape 5" name no chapter.
const MARKED = new RegExp(String.raw`(?<!\p{L})(?:ch(?:apter|apt|ap)?|cap(?:itolo|ítulo|itulo)?|chapitre|kapitel)\.?[\s_-]*(${NUM})`, 'iu');
// ...and its short form, a bare c: "c012", "v03 c012", "v03c012". Only standing alone, never the inside of a word or
// a tag -- "(c2c)", the cover-to-cover tag on Western scans, is not chapter 2 -- and only when the name has one.
const SHORT_C = new RegExp(String.raw`(?:^|(?<=[\s_.\-(\[])|(?<=\bv\d+))c(${NUM})(?![\p{L}\d])`, 'giu');
// Rule 2: an issue number, "Batman #12".
const ISSUE = new RegExp(String.raw`#\s*(${NUM})`);
// The number a volume marker names. "v03" is a volume too, standing alone.
const AFTER_VOLUME = new RegExp(String.raw`(?:(?<!\p{L})${VOLUME_WORD}\.?[\s_-]*|(?<![\p{L}\d])v)$`, 'iu');
// A date: 1987-05, 1987-05-12, 12.05.1987. Inside brackets every part of one is the year's.
const DATE = /(?<![\d.])(?:(?:19|20)\d{2}[-./](?:0?[1-9]|1[0-2])(?:[-./](?:0?[1-9]|[12]\d|3[01]))?|\d{1,2}[-./]\d{1,2}[-./](?:19|20)\d{2})(?![\d.])/g;
const DASH = /^[-–—]$/;
/**
 * The most chapters one file may claim. A comic collected as `01-07` is a handful; a name that reads as a thousand
 * chapters in one file is not saying that -- a catalogue number, a code -- and taking it at its word would mark that
 * many chapters held, hiding every gap among them.
 */
export const MAX_RANGE = 1000;

const yearLike = (digits: string): boolean => /^\d{4}$/.test(digits) && +digits >= 1900 && +digits <= 2099;

/** Is position i inside ( ) or [ ]? One depth for both kinds; a stray closer never goes below zero. */
function bracketed(s: string): (i: number) => boolean {
  const depth: number[] = [];
  let d = 0;
  for (const c of s) {
    if (c === ')' || c === ']') d = Math.max(0, d - 1);
    // `for...of` walks code points, positions count UTF-16 units: a code point outside the BMP takes two slots.
    for (let k = 0; k < c.length; k++) depth.push(d);
    if (c === '(' || c === '[') d++;
  }
  return (i) => (depth[i] ?? 0) > 0;
}

/**
 * Rule 4, after whichever rule chose the number at `at`: a dash and a LARGER number right behind it make the file a
 * range, `01-07` and `Ch. 1–7`. With no space around the dash, since `Ch.12 - 100 Days` is chapter 12 with a name.
 * Never when the second number is a year (`Batman 12-1987`), nor when the two are parts of a date (`05-12-2023`, or
 * the 05-12 inside `(2023-05-12)`), nor wider than MAX_RANGE.
 */
function withRange(stem: string, at: number, digits: string): NameNumber {
  const number = parseFloat(digits);
  const after = stem.slice(at + digits.length);
  const m = new RegExp(String.raw`^[-–—](${NUM})`).exec(after);
  if (!m) return { number, end: null };
  const end = parseFloat(m[1]);
  const dated = /^[-–—./]\d/.test(after.slice(m[0].length)) || /\d[-–—./]$/.test(stem.slice(0, at));
  if (!(end > number) || end - number > MAX_RANGE || yearLike(m[1]) || dated) return { number, end: null };
  return { number, end };
}

/**
 * The chapter a file name says it is, name rule 2 (v0.55.2, discussion #150). Rule 1, the first number in the name,
 * made `Vol 3 Chapter 12.cbz` chapter 3 and `Watchmen (1986).cbz` chapter 1986. In order:
 *
 *   1. a chapter word and its number win: `Ch`, `Ch.`, `Chap`, `Chapt`, `Chapter`, `Cap`, `Cap.`, `Capitolo`,
 *      `Capítulo`, `Chapitre`, `Kapitel`, any case, with or without a dot or a space -- `Vol 3 Chapter 12` is 12 --
 *      and the short `c012` when it stands alone and the name has only one;
 *   2. else `#` and its number: `Batman #12 (1987)` is 12;
 *   3. else the first number that is neither a year nor a volume's. A year is four digits from 1900 to 2099 inside
 *      ( ) or [ ] (with the rest of a date it is part of); a volume's number is the one right after `Vol`, `Volume`,
 *      `Tome`, `Band`, `Том` or a lone `v`, when another number follows it (`Tome 01` alone is still 1);
 *   4. a range: see withRange;
 *   5. a name with nothing else (`Watchmen (1986)`, `Oneshot`) is 0, as a name with no number always was, and sorts
 *      by its name among the other 0s.
 *
 * ⚠️ The downloader names every file `Chapter <n>.cbz` (lib/downloader.ts chapterFileRel) and a renumber `Chapter <n>
 * (<k>).cbz` (lib/postingOrder.ts renumberedFile): every such name reads exactly as numFromName reads it, `Chapter -1`
 * included (1, the minus is not part of the number). naming.test.ts walks them.
 */
export function chapterFromName(name: string): NameNumber {
  const stem = name.replace(ARCHIVE_EXT, '');
  // The chosen number's digits end every match below, so where they start is the match's end less their length.
  const marked = MARKED.exec(stem);
  if (marked) return withRange(stem, marked.index + marked[0].length - marked[1].length, marked[1]);
  const shorts = [...stem.matchAll(SHORT_C)];
  if (shorts.length === 1) return withRange(stem, shorts[0].index! + shorts[0][0].length - shorts[0][1].length, shorts[0][1]);
  const issue = ISSUE.exec(stem);
  if (issue) return withRange(stem, issue.index + issue[0].length - issue[1].length, issue[1]);

  const nums = [...stem.matchAll(/\d+(?:\.\d+)?/g)].map((m) => ({ digits: m[0], at: m.index!, stop: m.index! + m[0].length }));
  const inside = bracketed(stem);
  const dates = [...stem.matchAll(DATE)].filter((d) => inside(d.index!)).map((d) => [d.index!, d.index! + d[0].length]);
  const skip = new Set<number>();
  nums.forEach((n, i) => {
    if (inside(n.at) && (yearLike(n.digits) || dates.some(([a, b]) => n.at >= a && n.stop <= b))) skip.add(i);
  });
  // The number joined to the one at i by a dash alone: its range's end, which says nothing about "another number".
  const rangeEnd = (i: number): number => (i + 1 < nums.length && DASH.test(stem.slice(nums[i].stop, nums[i + 1].at)) ? i + 1 : -1);
  for (let i = 0; i < nums.length; i++) {
    if (skip.has(i)) continue;
    if (AFTER_VOLUME.test(stem.slice(0, nums[i].at))) {
      const own = rangeEnd(i);
      if (nums.some((_, j) => j > i && j !== own && !skip.has(j))) {
        skip.add(i);
        if (own >= 0) skip.add(own);
        continue;
      }
    }
    return withRange(stem, nums[i].at, nums[i].digits);
  }
  return { number: 0, end: null };
}

/**
 * lib_books.chapter_name_source of a chapter name the LISTING healed onto a book that had none (lib/seriesListing.ts):
 * the name of whichever copy the listing chose for the number when the heal ran, not the file's own (#116). Every
 * other non-null value is the id of the source a name was BORROWED from (lib/borrowNames.ts), which is why this one
 * cannot be an adapter id: a custom site's id is [a-z0-9]+, an extension's is `sw:<digits>`. Its borrowed names are
 * taken back without it, and a renumber reads it as the listing's guess, like a date (lib/postingOrder.ts).
 */
export const HEALED_NAME = ':listing';

/** Sort by leading number first, falling back to locale compare — so "Chapter 9" precedes "Chapter 10". */
export function naturalCmp(a: string, b: string): number {
  return numFromName(a) - numFromName(b) || a.localeCompare(b);
}

// A volume marker in front of the chapter: "Vol.3", "Volume 3 -", "Tome 3,".
const VOLUME = String.raw`(?:${VOLUME_WORD}\.?\s*\d+(?:\.\d+)?\s*[,:.\-–—]?\s*)?`;
// The word a source puts before the number, in the languages sources are written in.
const CHAPTER_WORD = String.raw`(?:(?:ch(?:apter|ap)?|episode|ep|capítulo|capitulo|cap|chapitre|kapitel|глава|розділ|chương|bölüm|bab|rozdział)\.?\s*)?`;
// After the number, the separators between it and a real name.
const SEPARATOR = String.raw`\s*(?:[:.\-–—|~]+\s*)?`;

/**
 * The chapter's own name, when the source gave one: what is left once the volume, the chapter word and the
 * number are taken off the front. Null when nothing is left -- the title only said the number again.
 *
 * A downloaded file is named from its number alone (lib/downloader.ts explains why), so the scanner's title
 * is the number twice. Sources usually know better, and the downloader writes it into the CBZ's ComicInfo,
 * but nothing read it back. Most sources also just say "Chapter 12", in several languages and often behind a
 * volume ("Vol.3 Chapter 12", "Capítulo 12", "第12話"): each of those is the number again, and "Vol.3 Chapter
 * 12: The Return" is named "The Return".
 */
export function chapterName(title: string | undefined | null, number: number): string | null {
  const t = (title ?? '').trim();
  if (!t) return null;
  const n = String(number).replace('.', '\\.');
  // `(?!\.?\d)`: 12 must not match the front of 120 or 12.5.
  const re = new RegExp(`^${VOLUME}${CHAPTER_WORD}(?:第\\s*)?0*${n}(?!\\.?\\d)(?:\\s*(?:話|话|章|回|화|편))?${SEPARATOR}`, 'iu');
  const m = re.exec(t);
  if (!m) return t;
  const rest = t.slice(m[0].length).trim();
  return rest || null;
}
