// Who wrote a series, name by name (v0.100.0, #338).
//
// A series keeps one author line, free text from its files, its source or an admin: "Chugong (추공), Gi So-Ryeong
// (기소령), h-goon (현군)", "흙수저/ Wooden spoon", "Elf Toon". The series page shows each name on that line as a link,
// and the Library's `authorName` condition lists every series whose line holds the same person -- matched as a WHOLE
// name, never a fragment: "Oh (성불예정)" is not the "Oh" inside "John Oh" or "Hojun", and "K (케이)" is not every line
// with a k in it (the free-text `author` condition, a fragment match, stays as Komga clients know it).
//
// The same person is written several ways, so a name stands for every spelling it gives: the name itself and each
// one in brackets ("Chugong (추공)" is also "추공", which another series writes on its own), each folded to its letters
// and digits in lower case ("Gi So-Ryeong" is "Gi So Ryeong", "SAN.G" is "San G").
//
// web/lib/authorNames.ts splits the line for the series page by the same rule; both are held to the same fixtures
// (web/test/fixtures/authorNames.json).

/** Between two names, outside brackets: a comma, semicolon or slash (Latin, CJK or full-width), or an ampersand. */
const SEPARATOR = /[,;/&、，；／＆]/;
const OPEN = /[(（]/;
const CLOSE = /[)）]/;

/** The longest name kept; a line longer than any real list of names is cut there rather than read whole. */
const MAX_LINE = 1000;

/** The names on an author line, in its order, each once. Brackets stay with their name. */
export function authorNames(line: string | null | undefined): string[] {
  const text = String(line ?? '').slice(0, MAX_LINE);
  const out: string[] = [];
  const seen = new Set<string>();
  let depth = 0;
  let current = '';
  const push = () => {
    const name = current.replace(/\s+/g, ' ').trim();
    current = '';
    const key = fold(name);
    // A run of punctuation ("-", "?") is no name; neither is a second writing of one already listed.
    if (!key || seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());
    out.push(name);
  };
  for (const ch of text) {
    if (OPEN.test(ch)) depth++;
    else if (CLOSE.test(ch)) depth = Math.max(0, depth - 1);
    if (depth === 0 && SEPARATOR.test(ch)) { push(); continue; }
    current += ch;
  }
  push();
  return out;
}

/** A spelling reduced to what identifies it: its letters and digits, in lower case, compatibility-normalised. */
export function fold(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Every spelling one name gives: itself less its brackets, and each name inside them. */
export function nameKeys(name: string): string[] {
  const keys = new Set<string>();
  const bracketed: string[] = [];
  let depth = 0;
  let outside = '';
  let inside = '';
  for (const ch of name) {
    if (OPEN.test(ch)) { if (depth > 0) inside += ch; depth++; continue; }
    if (CLOSE.test(ch) && depth > 0) {
      depth--;
      if (depth === 0) { bracketed.push(inside); inside = ''; } else inside += ch;
      continue;
    }
    if (depth > 0) inside += ch; else outside += ch;
  }
  if (inside) bracketed.push(inside);
  for (const s of [outside, ...bracketed.flatMap((b) => authorNames(b))]) {
    const k = fold(s);
    if (k) keys.add(k);
  }
  return [...keys];
}

/** The spellings of everyone on an author line. */
export function lineKeys(line: string | null | undefined): Set<string> {
  return new Set(authorNames(line).flatMap(nameKeys));
}

/** Whether an author line names the person `wanted` stands for (the keys of one name, nameKeys). */
export function lineHas(line: string | null | undefined, wanted: readonly string[]): boolean {
  if (!wanted.length) return false;
  const keys = lineKeys(line);
  return wanted.some((k) => keys.has(k));
}
