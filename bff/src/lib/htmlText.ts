/**
 * Turning scraped HTML into plain text, correctly.
 *
 * Every source engine had its own one-line `strip`, and they shared two bugs.
 *
 * ⚠️ WHERE THIS OUTPUT GOES, AND WHY THAT CAPS THE DAMAGE. These strings become series titles, authors and
 * summaries from sites we do not control. They are rendered by React, which escapes, and serialised into
 * the OPDS feed through `esc()` in routes/opds.ts. Nothing in web/ uses `dangerouslySetInnerHTML`. So a tag
 * that survives stripping is cosmetic garbage in a title, NOT stored XSS -- and the day someone adds a
 * `dangerouslySetInnerHTML`, or an OPDS interpolation that skips `esc()`, that stops being true. That is
 * the reason this file is careful rather than clever.
 */

/**
 * Remove HTML tags, repeatedly, until removing them changes nothing.
 *
 * A single pass is not enough. `<scr<b>ipt>` contains no complete tag until the inner `<b>` is taken out,
 * and one pass leaves `<script>` behind -- the tag it was asked to remove, reassembled from its own
 * wreckage. Looping to a fixed point is the whole fix.
 */
export function stripTags(input: string): string {
  let t = input;
  // eslint-disable-next-line no-cond-assign
  for (let guard = 0; guard < 20 && t !== (t = t.replace(/<[^>]*>/g, '')); guard++);
  return t;
}

/**
 * Decode the handful of entities these sites actually emit.
 *
 * ⚠️ `&amp;` LAST. Decoding it first turns `&amp;quot;` into `&quot;`, which the next rule then turns into
 * `"` -- so a source that wanted to show the literal text `&quot;` gets a quote character instead, and one
 * layer of escaping is silently peeled off content we did not author.
 */
export function decodeEntities(input: string): string {
  return input
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Tags out, entities decoded, whitespace collapsed. What a title or summary should look like. */
export function plainText(input: string): string {
  return decodeEntities(stripTags(input)).replace(/\s+/g, ' ').trim();
}

/**
 * Entities decoded, Markdown out, then tags out and whitespace collapsed: what a description from a source
 * that writes Markdown should look like.
 *
 * MangaDex descriptions are Markdown -- `**Year:** 1997`, a `---` rule, a bulleted list of `[links](url)`
 * -- and the series page rendered them verbatim, asterisks and all, because nothing between the adapter
 * and the page knew the syntax. This takes the syntax out and keeps the words: link and image text stay,
 * the address goes (it is not prose, and React would not have made it a link anyway); emphasis, headings,
 * blockquotes, bullets and numbering are markers around text that reads fine without them; a rule is
 * nothing but a marker. What it is NOT is a Markdown parser: it removes the handful of constructs these
 * sites emit and leaves anything else alone, so a plain sentence comes out as it went in.
 *
 * Looped to a fixed point, like stripTags, because the constructs nest -- `**[link](u)**` is the usual
 * MangaDex shape and `[**bold**](u)` the other way round -- and a single ordered pass would leave one
 * layer's markers behind whichever order the rules ran in. Images before links, since `![a](u)` contains
 * `[a](u)`; the double markers before the single ones, since `**` contains `*`. Backslash escapes are
 * lifted LAST, after the loop, so `\*` is never read as an emphasis marker on the way through.
 *
 * Emphasis is only unwrapped where CommonMark would read it: the marker touches the text on the inside
 * and is not glued to a word on the outside, so `snake_case_names` and `2*3*4` are left as they are --
 * and `__init__.py` too, since a `.` glued to the closing marker with a word behind it is a file name or
 * an attribute, not the end of a bold span (`__bold__.` at the end of a sentence still unwraps). A rule is
 * only taken at the END of a line: alone on its line as CommonMark has it, or trailing a sentence as the
 * stored MangaDex rows have it (`**Year:** 1997 ---`, the scanner's `.trim()` having pulled it up), and
 * never in the middle of one, where ` --- ` is a writer's em dash and taking it read `wait --- what` as
 * `wait what`. Whitespace is collapsed at the end so a stripped heading or rule does not leave a blank
 * paragraph behind.
 *
 * Entities are decoded FIRST, before any of this, and exactly one layer (decodeEntities, `&amp;` last).
 * Decoding after the tags were stripped, as plainText does, left `&lt;b&gt;` standing as a literal `<b>`
 * that the NEXT pass then stripped -- so what the add stored was not what the page showed. Decoded first,
 * an entity-encoded tag is a tag to this pass and goes here, and the stored text is the fixed point.
 * (It also means `x &lt; y and z &gt; w` loses its middle here rather than at read time: a `<`…`>` span
 * of plain prose was never going to survive two passes of stripTags, and one visible outcome beats two.)
 *
 * Idempotent over everything above -- a summary cleaned on add is cleaned again on every read (seriesDto)
 * and must not change -- with two knowing exceptions. A lifted escape (`\*` -> `*`) is plain text to
 * this pass and a marker to the next, so `\*not bold\*` reads `*not bold*` once and `not bold` twice; a
 * source that escapes its asterisks is rare, and either reading beats the backslashes. And a
 * double-encoded entity sheds one layer per pass (`&amp;lt;` -> `&lt;` -> `<`), by the `&amp;`-last rule
 * decodeEntities explains: peeling every layer at once would turn a literal `&quot;` into a quote.
 */
export function stripMarkdown(input: string): string {
  const rules: Array<[RegExp, string]> = [
    // A rule first, and the emphasis rules below refuse a marker glued to another (`(?=[^\s*])`): either
    // alone keeps `***` on its own line from being read as the opening of a bold span that closes at the
    // next `**` in the text and eats everything between; both are kept because the second is one
    // character in a regex and the first is the one a reader of this list expects. Anchored to the end
    // of a line (`$` under the m flag), not to any whitespace: ` --- ` inside a sentence stays.
    [/(^|\s)([-*_])\2{2,}[ \t]*$/gm, '$1'],              // --- *** ___ alone on, or ending, a line
    [/!\[([^\]]*)\]\([^)]*\)/g, '$1'],                  // ![alt](url) -> alt
    [/\[([^\]]*)\]\([^)]*\)/g, '$1'],                   // [text](url) -> text
    [/\[([^\]]+)\]\[[^\]]*\]/g, '$1'],                  // [text][ref] -> text
    [/^[ \t]*\[[^\]]+\]:[ \t]+\S.*$/gm, ''],            // [ref]: url   (the definition line)
    [/\*\*(?=[^\s*])([\s\S]*?[^\s*])\*\*/g, '$1'],      // **bold**
    // `__bold__` may not touch a `.` on the way in, nor a `.` with a word behind it on the way out, and
    // its span may not cross another `__`: `__init__.py` is a file name, and without the last rule the
    // lazy span would reach past it to the NEXT `__` in the sentence and unwrap the wrong pair.
    [/(?<![\w\\.])__(?=[^\s_])((?:(?!__)[\s\S])*?[^\s_])__(?!\w|\.\w)/g, '$1'], // __bold__
    [/~~(?=[^\s~])([\s\S]*?[^\s~])~~/g, '$1'],          // ~~struck~~
    [/(?<![*\w\\])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, '$1'], // *italic*
    [/(?<![_\w\\])_(?=[^\s_])([^_\n]*?[^\s_])_(?![_\w])/g, '$1'],   // _italic_
    [/```[^\n`]*\n?/g, ''],                              // a fence line; the code between stays as text
    [/(?<!\\)`([^`\n]+)`/g, '$1'],                       // `code`
    [/^[ \t]{0,3}#{1,6}(?:[ \t]+|$)/gm, ''],             // # Heading
    [/^[ \t]*>[ \t]?/gm, ''],                            // > quote
    [/^[ \t]*[-*+][ \t]+/gm, ''],                        // - bullet
    [/^[ \t]*\d{1,3}[.)][ \t]+/gm, ''],                  // 1. numbered
  ];
  // A line break tag is a line break here, not nothing: stripTags drops a tag outright (right for `<b>`,
  // whose text runs on), but a description that separates its paragraphs with `<br>` or `<p>` would
  // otherwise run "…the end.Next paragraph" together, and MangaDex mixes both into its Markdown. After
  // the entities, so an encoded `&lt;br&gt;` is the same break.
  let t = decodeEntities(input).replace(/<br\s*\/?>|<\/?p\b[^>]*>/gi, '\n');
  for (let guard = 0; guard < 20; guard++) {
    const before = t;
    for (const [re, to] of rules) t = t.replace(re, to);
    if (t === before) break;
  }
  // stripTags and the collapse by hand, NOT plainText: that would decode a second time, and two layers
  // peeled is the very thing decodeEntities' `&amp;`-last rule exists to prevent.
  return stripTags(t.replace(/\\([\\`*_{}[\]()#+\-.!~>|])/g, '$1')).replace(/\s+/g, ' ').trim();
}

/** A description as the API answers it: plain text from whatever the source or the scanner wrote, '' for none. */
export const cleanDescription = (s?: string | null): string => (s ? stripMarkdown(s) : '');
