// The names on a series' author line (v0.100.0, #338), for the series page's links.
//
// The twin of bff lib/authorNames.ts authorNames, which the Library's "by this author" reads the line with: both are
// held to the same fixtures (test/fixtures/authorNames.json), so the name a link carries is a name the server finds.
// The server matches it whole, in any of its spellings ("Chugong (추공)" is also "추공"); this file only splits.

/** Between two names, outside brackets: a comma, semicolon or slash (Latin, CJK or full-width), or an ampersand. */
const SEPARATOR = /[,;/&、，；／＆]/;
const OPEN = /[(（]/;
const CLOSE = /[)）]/;
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
    // A run of punctuation ("-", "?") is no name; neither is a second writing of one already listed.
    if (!name.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '') || seen.has(name.toLowerCase())) return;
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

/** The Library showing every series by one author (the series page's link). */
export const authorHref = (name: string): string => `/library/?author=${encodeURIComponent(name)}`;
