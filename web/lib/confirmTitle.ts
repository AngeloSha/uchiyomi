// web/lib/confirmTitle.ts -- the twin of bff/src/lib/confirmTitle.ts; every line below this one is byte-identical in both.
/**
 * The typed confirmation, folded down to what the eye can actually tell apart.
 *
 * Remove, Delete files and Forget all ask for the series title to be typed out, and until now the
 * comparison was the exact string on both sides (trimmed, NFC). A sixth of a real library cannot be typed
 * that way: 38 of the owner's 241 live series carry a curly apostrophe, an en or em dash, a literal HTML
 * entity the source never decoded, or a non-breaking space -- none of which a keyboard produces -- so the
 * button never enabled and the action was unreachable (issue #66). Loosening only the client would have
 * traded a dead button for a 400, which is why this rule is one file the route uses too.
 *
 * The principle is: fold only what the eye cannot distinguish, on BOTH sides.
 *
 *   1. One layer of HTML entities -- a bounded named set plus `&#NNN;` and `&#xHH;`. A title stored as
 *      `Aisu - Boosette &amp; Piranha Plant` SHOWS `&amp;` on the series page, so the five characters and
 *      the `&` they stand for both have to confirm it. ⚠️ ONE layer, by construction: `String.replace`
 *      resumes after each match, so `&amp;quot;` becomes `&quot;` and stops there. Peeling every layer
 *      would turn a title that deliberately shows `&quot;` into one showing `"` -- the trap
 *      bff/src/lib/htmlText.ts documents as the reason its own decoder does `&amp;` last.
 *   2. NFKC. The NFC half is the macOS case: a title read off a share is "Cafe" + U+0301 while every
 *      keyboard types U+00E9, and byte for byte those never match. The compatibility half brings fullwidth
 *      and circled letters, the ligatures and `…` back to the plain characters they are drawn as.
 *   3. The quote and dash families folded to their ASCII twins. This is the part NFKC will not do and the
 *      part real titles are full of: `Emperor’s Domination` is stored with U+2019, and a keyboard types
 *      U+0027.
 *   4. The invisibles out -- zero-width space, joiner and non-joiner, the bidi marks and embeddings, the
 *      word joiner, a soft hyphen, the BOM, the variation selectors -- and emoji, which a keyboard cannot
 *      reach at all.
 *   5. Every Unicode space to one ASCII space, runs collapsed, both ends trimmed: a title with a
 *      non-breaking space or a doubled space is confirmed with ordinary single ones.
 *
 * ⚠️ NO case folding, deliberately, and this is the line not to cross later. Case is visible, so folding it
 * would not be folding what the eye cannot distinguish -- and the same dialog confirms deleting a member
 * (web/app/admin/page.tsx) and revoking an API token (web/components/ProfileConnections.tsx), where "type
 * the name" has to keep meaning it. Folding harder in the other direction is safe: both sides go through
 * the same rules, and the dialog already names the single row it will act on, so a fold that brought two
 * different titles together cannot act on the wrong one.
 *
 * ⚠️ TWIN FILE, the `normTitle`/`norm` precedent. web/lib/confirmTitle.ts and bff/src/lib/confirmTitle.ts
 * are byte-identical below their first line, because the client enables the button (ConfirmDialog.tsx) and
 * the route re-checks the same string (routes/admin.ts `sameTitle`). Two spellings of the rule would be a
 * button that enables onto a 400. web/test/confirmTitle.test.ts holds the two files against each other as
 * text and fails naming both paths.
 */

/**
 * The named entities scraped titles actually carry.
 *
 * Bounded on purpose: the HTML5 name table is 2,231 entries, of which a series title uses a dozen, and
 * anything missing from here is left exactly as written -- an unknown `&foo;` is text, and text is what the
 * eye sees, so leaving it alone is the same rule as decoding the ones below.
 */
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u{00a0}', shy: '\u{00ad}',
  hellip: '\u{2026}', ndash: '\u{2013}', mdash: '\u{2014}', horbar: '\u{2015}', minus: '\u{2212}',
  lsquo: '\u{2018}', rsquo: '\u{2019}', sbquo: '\u{201a}', ldquo: '\u{201c}', rdquo: '\u{201d}', bdquo: '\u{201e}',
  laquo: '\u{00ab}', raquo: '\u{00bb}', prime: '\u{2032}', Prime: '\u{2033}',
  middot: '\u{00b7}', bull: '\u{2022}', deg: '\u{00b0}', times: '\u{00d7}', divide: '\u{00f7}',
  copy: '\u{00a9}', reg: '\u{00ae}', trade: '\u{2122}', sect: '\u{00a7}', para: '\u{00b6}', star: '\u{2606}',
};

/**
 * One layer of entities, named or numeric.
 *
 * A code point outside Unicode, or inside the surrogate range, is not a character anybody can see: it is
 * left as the text it was written as rather than turned into a lone surrogate that no comparison survives.
 */
function decodeEntities(input: string): string {
  return input.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{0,31}));/g,
    (all: string, dec?: string, hex?: string, name?: string): string => {
      if (dec !== undefined || hex !== undefined) {
        const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex as string, 16);
        if (!Number.isFinite(cp) || cp < 1 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return all;
        return String.fromCodePoint(cp);
      }
      return (name !== undefined && ENTITIES[name]) || all;
    },
  );
}

/** A title reduced to the characters a person can see and type. '' when nothing typeable is left. */
export function foldTitle(s: string): string {
  return (
    decodeEntities(s)
      .normalize('NFKC')
      // The quote family: curly singles and doubles, the low quotes, the primes. NFKC leaves every one of
      // these alone, and they are what a source's own typesetting puts in a title.
      .replace(/[\u{2018}\u{2019}\u{201a}\u{201b}\u{2032}\u{2035}]/gu, "'")
      .replace(/[\u{201c}\u{201d}\u{201e}\u{201f}\u{2033}\u{2036}]/gu, '"')
      // The dash family, U+2010..U+2015 plus the minus sign. NFKC already folded the fullwidth forms.
      .replace(/[\u{2010}-\u{2015}\u{2212}]/gu, '-')
      // Invisibles. ⚠️ U+202F (narrow no-break space) is deliberately NOT in this range: it is a space, and
      // the collapse below turns it into one rather than deleting it and gluing two words together.
      .replace(/[\u{00ad}\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}\u{fe00}-\u{fe0f}\u{feff}]/gu, '')
      // Emoji. ⚠️ `\p{Extended_Pictographic}`, never `\p{Emoji}`: the latter also matches the ASCII digits,
      // `#` and `*` (they are the bases of the keycap emoji), which would fold `Chapter 1` to `Chapter`.
      // This does take © and ® with it, which are pictographs; both sides lose them equally, and neither is
      // on a keyboard anyone is going to find under a confirmation dialog.
      .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u{20e3}]/gu, '')
      // Every Unicode space to one: JS `\s` already covers U+00A0, U+1680, U+2000-200A, U+2028, U+2029,
      // U+202F, U+205F and U+3000, which is the whole set a scraped title can carry.
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Does what was typed confirm this title? The whole rule, so the button and the route cannot disagree.
 *
 * ⚠️ AN EMPTY FOLD NEVER CONFIRMS BY FOLD. A title made only of emoji folds to nothing -- and so does an
 * empty box, a stray space, or somebody else's emoji -- so comparing the two folds there would arm a
 * destructive button on no input at all. That title falls back to the exact string (trimmed, NFC), which
 * the Copy title control beside the field makes reachable. The fallback is also why typing a title exactly
 * always confirms it, whatever the fold does with it.
 */
export function confirmsTitle(typed: string, title: string): boolean {
  const want = foldTitle(title);
  if (want !== '' && foldTitle(typed) === want) return true;
  return typed.trim().normalize('NFC') === title.trim().normalize('NFC');
}
