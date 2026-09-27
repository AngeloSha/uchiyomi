// Filename and chapter-name helpers for the library scanner and the numbering logic. Kept dependency-free (no
// db/sharp imports) so they can be unit-tested without booting the app's environment, and so lib/postingOrder.ts
// can use them without reaching the database.

/** The first number in a filename — "Chapter 12.cbz" -> 12, "Tome 01.cbr" -> 1, "Ch. 4.5" -> 4.5. 0 if none. */
export function numFromName(name: string): number {
  const m = name.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

/** Sort by leading number first, falling back to locale compare — so "Chapter 9" precedes "Chapter 10". */
export function naturalCmp(a: string, b: string): number {
  return numFromName(a) - numFromName(b) || a.localeCompare(b);
}

// A volume marker in front of the chapter: "Vol.3", "Volume 3 -", "Tome 3,".
const VOLUME = String.raw`(?:(?:vol(?:ume)?|tome|band|том)\.?\s*\d+(?:\.\d+)?\s*[,:.\-–—]?\s*)?`;
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
