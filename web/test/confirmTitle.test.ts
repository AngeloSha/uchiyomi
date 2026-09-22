// The typed confirmation: one fold, kept in two files, that a keyboard can actually produce.
//
// Remove / Delete files / Forget ask for the series title to be typed out, and the comparison used to be
// the exact string on both sides. 38 of the owner's 241 live series carry a curly apostrophe, an en or em
// dash, a literal HTML entity the source never decoded, or a non-breaking space, so on a sixth of the
// library the button could never enable and the action was unreachable from a keyboard (#66).
//
// The rule is duplicated on purpose -- web/lib/confirmTitle.ts enables the button, bff/src/lib/confirmTitle.ts
// is what routes/admin.ts re-checks -- because loosening only the client would trade a dead button for a
// 400. So the first test here holds the two files against each other as text, the way wall.test.ts holds
// normTitle against the server's norm. The rest is the behaviour: what must now confirm, and what must
// still be refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { foldTitle, confirmsTitle } from '../lib/confirmTitle';

const ROOT = join(__dirname, '..');
const WEB = 'lib/confirmTitle.ts';
const BFF = '../bff/src/lib/confirmTitle.ts';
/** Source with comments stripped, so a rule quoted in a comment cannot satisfy an assertion. */
const code = (rel: string) =>
  readFileSync(join(ROOT, rel), 'utf8').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');

test('the client fold and the server fold are the same file', () => {
  // Two spellings of this rule would be a button that enables onto a 400 from the route, which is the exact
  // failure #66's fix exists to avoid. Everything below the first line must match byte for byte; the first
  // line is the one allowed difference, and it names the file and its twin so whoever opens one knows the
  // other is there. Reintroduce by editing one copy only -- drop the dash fold from web/lib/confirmTitle.ts
  // -- and "have drifted apart" fails naming both paths.
  const body = (rel: string, self: string, twin: string) => {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    const nl = src.indexOf('\n');
    assert.ok(nl > 0, `${rel} is empty`);
    const first = src.slice(0, nl);
    assert.ok(first.startsWith(`// ${self} `), `${rel} must open with a comment naming itself, not: ${first}`);
    assert.ok(first.includes(twin), `${rel}'s first line must name its twin ${twin}, or nobody editing it knows to edit both`);
    return src.slice(nl + 1);
  };
  const web = body(WEB, 'web/lib/confirmTitle.ts', 'bff/src/lib/confirmTitle.ts');
  const bff = body(BFF, 'bff/src/lib/confirmTitle.ts', 'web/lib/confirmTitle.ts');
  assert.equal(web, bff, 'web/lib/confirmTitle.ts and bff/src/lib/confirmTitle.ts have drifted apart: the dialog would enable its button onto a 400 from routes/admin.ts');
});

test('a title a keyboard cannot produce is confirmed by what a keyboard produces', () => {
  // Every case here is a shape a real row on this server has. Reintroduce by dropping the matching rule
  // from foldTitle (the quote fold, the dash fold, decodeEntities, NFKC, the whitespace collapse): the
  // line that names it fails.
  //
  // ⚠️ The invisible fixtures are written as `\u{...}` escapes and checked before they are used. A literal
  // non-breaking space or combining accent pasted into this file is invisible to whoever reads it next and
  // one editor's "tidy the whitespace" away from making its assertion vacuous -- it would then compare two
  // identical strings and pass forever, whatever the fold does.
  assert.notEqual('A\u{00a0}B', 'A B', 'the non-breaking space fixture decayed into an ordinary space');
  assert.notEqual('Cafe\u{0301} Story', 'Café Story', 'the NFD fixture decayed into NFC');
  assert.notEqual('Chapter\u{200b} 1', 'Chapter 1', 'the zero-width space fixture is gone');
  const ok = (typed: string, title: string, why: string) => assert.ok(confirmsTitle(typed, title), why);
  ok("Emperor's Domination", 'Emperor’s Domination', 'a straight apostrophe must confirm a curly one');
  ok('Emperor’s Domination', 'Emperor’s Domination', 'the title itself must still confirm');
  ok('“Quoted” Title', '"Quoted" Title', 'curly double quotes and straight ones are the same title');
  // The literal entity, from both sides: the series page SHOWS `&amp;`, so the five characters and the
  // ampersand they are drawn for both have to work.
  ok('Aisu - Boosette &amp; Piranha Plant[118MB-22photos]', 'Aisu – Boosette &amp; Piranha Plant[118MB-22photos]', 'typing the entity as shown must confirm');
  ok('Aisu - Boosette & Piranha Plant[118MB-22photos]', 'Aisu – Boosette &amp; Piranha Plant[118MB-22photos]', 'typing the ampersand the entity stands for must confirm');
  ok('Boosette &#38; Plant', 'Boosette & Plant', 'a numeric entity must decode too');
  ok('Boosette &#x26; Plant', 'Boosette & Plant', 'a hex entity must decode too');
  ok('Aisu - Boosette', 'Aisu — Boosette', 'a hyphen must confirm an em dash');
  ok('Aisu - Boosette', 'Aisu – Boosette', 'a hyphen must confirm an en dash');
  ok('A B', 'A\u{00a0}B', 'an ordinary space must confirm a non-breaking one');
  ok('A B', 'A  B', 'one space must confirm a doubled one');
  ok('  Gone ', 'Gone', 'the ends are still trimmed');
  ok('Café Story', 'Cafe\u{0301} Story', 'a typed NFC accent must confirm an NFD one off a macOS share');
  ok('Full', 'Ｆｕｌｌ', 'NFKC must bring fullwidth letters back to the ones they are drawn as');
  ok('Chapter 1', 'Chapter 1 🍜', 'an emoji nobody can type must not hold the title hostage');
  ok('Chapter 1', 'Chapter\u{200b} 1', 'a zero-width space must not hold the title hostage');
});

test('the fold refuses everything that is not the same title', () => {
  // The friction is the point: this dialog is what stands between a tap and someone's library. Reintroduce
  // by folding case into foldTitle (`toLowerCase()`): "case is visible" fails -- and the same dialog
  // confirms deleting a member and revoking a token, where "type the name" has to keep meaning it.
  const no = (typed: string, title: string, why: string) => assert.equal(confirmsTitle(typed, title), false, why);
  no('Tower of God', 'Emperor’s Domination', 'a different title confirmed');
  no('Emperor', 'Emperor’s Domination', 'a prefix of the title confirmed');
  no('Emperor’s Domination II', 'Emperor’s Domination', 'a longer title confirmed');
  no('', 'Emperor’s Domination', 'an empty box confirmed');
  no('   ', 'Emperor’s Domination', 'a box holding only spaces confirmed');
  no('gone', 'Gone', 'case is visible, so it is not folded');
  no('emperor’s domination', 'Emperor’s Domination', 'case is visible, so it is not folded');
  no('AB', 'A B', 'the space between two words is not noise');
});

test('a title made only of emoji folds to nothing, and only the exact string confirms it', () => {
  // The degenerate case, and the reason `confirmsTitle` does not simply compare two folds: an empty box
  // folds to '' as well, so a fold-only comparison would arm Forget on no input at all. Such a title falls
  // back to the exact string, which the Copy title button beside the field makes reachable. Reintroduce by
  // dropping the `want !== ''` guard from confirmsTitle: "an empty box confirmed an emoji title" fails.
  const emoji = '🍜🍜';
  assert.equal(foldTitle(emoji), '', 'the fixture is not an all-emoji title any more');
  assert.equal(confirmsTitle('', emoji), false, 'an empty box confirmed an emoji title');
  assert.equal(confirmsTitle(' ', emoji), false, 'a space confirmed an emoji title');
  assert.equal(confirmsTitle('🍕', emoji), false, 'a different emoji confirmed an emoji title');
  assert.equal(confirmsTitle(emoji, emoji), true, 'the exact title must still confirm, or the action is unreachable');
});

test('the fold decodes exactly one layer of entities', () => {
  // ⚠️ `&amp;quot;` must become `&quot;` and stop there. Peeling every layer would turn a title that
  // deliberately shows `&quot;` into one showing `"`, which is the trap bff/src/lib/htmlText.ts documents
  // as the reason its own decoder does `&amp;` last. Reintroduce by looping decodeEntities to a fixed
  // point: the first assertion reads `"`.
  assert.equal(foldTitle('&amp;quot;'), '&quot;', 'the second layer of escaping was peeled off too');
  assert.equal(foldTitle('&notanentity; x'), '&notanentity; x', 'an unknown entity is text and must be left alone');
  assert.equal(foldTitle('&#xD800;'), '&#xD800;', 'a lone surrogate is not a character; the text must be left as written');
  assert.equal(foldTitle('&#99999999;'), '&#99999999;', 'a code point outside Unicode must be left as written');
});

test('the fold keeps the digits and letters a title is made of', () => {
  // ⚠️ The emoji rule is `\p{Extended_Pictographic}`, never `\p{Emoji}`: the latter matches the ASCII
  // digits, `#` and `*` as well, because they are the bases of the keycap emoji. Reintroduce by swapping
  // the property: "Chapter 1" folds to "Chapter" and every numbered title becomes unconfirmable.
  assert.equal(foldTitle('Chapter 1 #2 *3'), 'Chapter 1 #2 *3', 'a digit, a # or a * was folded away as emoji');
  assert.equal(foldTitle('1\u{fe0f}\u{20e3} Start'), '1 Start', 'the keycap emoji must lose its box and keep its digit');
  assert.equal(foldTitle('Solo Leveling'), 'Solo Leveling', 'a plain ASCII title must come out as it went in');
});

test('the dialog offers Copy title, and only where a clipboard exists', () => {
  // The copy affordance is what makes a title the fold cannot rescue -- an all-emoji one, or simply a very
  // long one -- reachable at all, and it is what the reporter was already doing by hand.
  //
  // ⚠️ `navigator.clipboard` is undefined outside a secure context, and plain http over a LAN is how most
  // people reach this server. So the button is rendered from state an effect sets after mount: reading
  // `typeof navigator` during render would put the button in the statically exported HTML and not in the
  // first client render (a hydration mismatch), and calling `writeText` unguarded would throw on the tap.
  // Reintroduce by rendering `{navigator.clipboard && (` instead of `{canCopy && (`, or by dropping the
  // `?.writeText` check from the effect: the matching assertion fails.
  const src = code('components/ConfirmDialog.tsx');
  assert.match(src, /useEffect\(\(\) => \{ setCanCopy\(typeof navigator !== 'undefined' && typeof navigator\.clipboard\?\.writeText === 'function'\); \}, \[\]\);/, 'the clipboard is not probed after mount');
  assert.match(src, /\{canCopy && \(\s*<button/, 'the Copy title button is not gated on the probe');
  assert.match(src, /navigator\.clipboard\.writeText\(text\)\.then\(/, 'the copy does not go through the clipboard API');
  assert.match(src, /\{copied \? tr\('Copied'\) : tr\('Copy title'\)\}/, 'the button must say what it did, through tr()');
  // The label it sits beside is untouched: one translated sentence with the title inside it
  // (forgetSeries.test.ts holds that rule).
  assert.match(src, /\{before\}<span className="[^"]*">\{confirmText\}<\/span>\{after\}/, 'the typed-confirmation label lost its shape');
});
