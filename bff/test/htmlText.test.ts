// Descriptions from sources become plain text: HTML through plainText (the older half of this file), and
// since v0.34.0 Markdown through stripMarkdown, because MangaDex writes its descriptions in Markdown and
// the series page showed `**Year:** 1997 ---` with the asterisks in. Pure functions, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripMarkdown, cleanDescription, plainText } from '../src/lib/htmlText';

test('the MangaDex shape: bold, a link, a rule and a heading come out as their words', () => {
  assert.equal(stripMarkdown('**Bold** and [a link](https://x)\n\n---\n\n# Title'), 'Bold and a link Title');
});

test('a plain sentence is unchanged, stars and underscores inside words included', () => {
  const plain = 'A plain sentence, with 2*3*4 and snake_case_names and an e-mail a_b@c.d.';
  assert.equal(stripMarkdown(plain), plain);
});

test('stripping is idempotent: a summary cleaned on add and again on read does not change', () => {
  for (const s of [
    '**Bold** and [a link](https://x)\n\n---\n\n# Title',
    '**[Official](https://a.b)** and [**bold link**](https://c) and ![cover](https://img)',
    '> quoted\n- one\n- two\n1. three\n\n___\n\n`code`',
    'Sinbad has spent his life at sea.\n\n---\n**Links:**\n- [Official Site](https://x)\n\n**Year:** 1997',
    '&lt;b&gt;bold&lt;/b&gt; and &amp; more',
  ]) {
    const once = stripMarkdown(s);
    assert.equal(stripMarkdown(once), once, `changed on the second pass: ${JSON.stringify(s)}`);
  }
});

test('each construct alone', async (t) => {
  await t.test('links keep their text and lose the address; images keep their alt', () => {
    assert.equal(stripMarkdown('see [the wiki](https://w) and ![cover](https://img)'), 'see the wiki and cover');
    assert.equal(stripMarkdown('Links:\n[Wiki][1]\n\n[1]: https://wiki'), 'Links: Wiki', 'a reference link, and its definition line goes');
  });
  await t.test('emphasis markers are unwrapped where they read as emphasis', () => {
    assert.equal(stripMarkdown('__Under__ and _it_ and ~~gone~~ and *star* and `code`'), 'Under and it and gone and star and code');
  });
  await t.test('a dunder file name is not bold', () => {
    // `__init__.py` is bounded by whitespace on the left and `.py` on the right, which CommonMark would
    // read as emphasis but no reader would: the closing `__` is glued to a file extension. Reintroduce by
    // restoring the `__bold__` entry to `(?<![\w\\])__(?=[^\s_])([\s\S]*?[^\s_])__(?!\w)`: the first
    // assertion reads `see the file init.py here`, and the second `init__.py and __bold text` -- the lazy
    // span reaching past the file name to the next `__` -- which is why the entry also refuses to cross
    // a `__` on the way. A bold word that ENDS a sentence still unwraps: the `.` there has no word after it.
    assert.equal(stripMarkdown('see the file __init__.py here'), 'see the file __init__.py here', 'the file name survives');
    assert.equal(stripMarkdown('__init__.py and __bold__ text'), '__init__.py and bold text', 'and the real bold beside it still unwraps');
    assert.equal(stripMarkdown('obj.__dict__ is __important__.'), 'obj.__dict__ is important.', 'an attribute keeps its markers; a sentence-final bold loses them');
  });
  await t.test('line-start markers go: headings, quotes, bullets, numbering', () => {
    assert.equal(stripMarkdown('# Title\n> quoted\n- one\n* two\n1. three\n2) four'), 'Title quoted one two three four');
  });
  await t.test('a rule goes whether on its own line or at the end of one', () => {
    // The stored MangaDex rows look like the second: the scanner's `.trim()` keeps the rule on the line.
    assert.equal(stripMarkdown('above\n\n***\n\nbelow'), 'above below');
    assert.equal(stripMarkdown('**Year:** 1997 ---'), 'Year: 1997');
    assert.equal(stripMarkdown('**x** ---'), 'x');
  });
  await t.test('a rule inside a sentence is a dash, and stays', () => {
    // ` --- ` between words is a writer's em dash, not a thematic break; the rule regex used to take it
    // wherever whitespace followed, so `wait --- what` read `wait what`. Reintroduce by anchoring the rule
    // entry in stripMarkdown to `(?=\s|$)` again instead of `[ \t]*$` with the m flag: the dash is gone.
    assert.equal(stripMarkdown('wait --- what'), 'wait --- what', 'the dash inside the sentence stays');
    assert.equal(stripMarkdown('the rule --- is here\n---\nand **Year:** 1997 ---'), 'the rule --- is here and Year: 1997',
      'while a rule on its own line and one ending a line still go');
  });
  await t.test('a rule line is not read as the opening of a bold span', () => {
    // `***` is three stars to the emphasis rule, which used to open a span there and close it at the next
    // `**`, eating "Links:". Two things stop it, and EITHER is enough: the rule entry runs first, and the
    // bold rule refuses a marker glued to another star. Reintroduce by moving the horizontal-rule entry to
    // the end of `rules` in stripMarkdown AND loosening the bold rule's `(?=[^\s*])…[^\s*]` back to
    // `(?=\S)…\S`: the first assertion reads `above * **Links: here`.
    assert.equal(stripMarkdown('above\n\n***\n\n**Links:** here'), 'above Links: here');
    assert.equal(stripMarkdown('above\n\n___\n\nbelow'), 'above below', '`___` is not an italic underscore around one');
  });
  await t.test('nested markers come off layer by layer', () => {
    // The MangaDex shapes (`**[link](u)**`, `[**bold**](u)`) happen to fall out of one ordered pass; bold
    // around a bold link does not, because the outer span's first closing `**` is the inner one's.
    // Reintroduce by running the rules once (`guard < 1`) instead of to a fixed point: the last
    // assertion reads `a **b c**`, a layer left behind.
    assert.equal(stripMarkdown('**[Official](https://a.b)** and [**bold link**](https://c)'), 'Official and bold link');
    assert.equal(stripMarkdown('**a [**b**](u) c**'), 'a b c');
  });
  await t.test('an escaped marker is the literal character', () => {
    assert.equal(stripMarkdown('Escaped \\*not bold\\* and Dr\\. Stone'), 'Escaped *not bold* and Dr. Stone');
  });
});

test('HTML and entities still go: entities before the Markdown, tags after it', () => {
  assert.equal(cleanDescription('<b>**x**</b>'), 'x');
  assert.equal(stripMarkdown('**Bold**<br>and &amp; more<p>next</p>para'), 'Bold and & more next para', 'a break or a paragraph end is a space, not nothing');
});

test('an entity-encoded tag is gone on the first pass, so the stored text is what the page shows', () => {
  // With the entities decoded AFTER the tags were stripped (plainText's order), `&lt;b&gt;` came out as a
  // literal `<b>` from the add and as nothing from the read-time pass in seriesDto: two answers for one
  // column. Decoded first, the tag is a tag to this pass. Reintroduce by starting stripMarkdown from
  // `input.replace(...)` instead of `decodeEntities(input).replace(...)` and ending it with `plainText(...)`
  // again: the first assertion reads `<b>`.
  assert.equal(stripMarkdown('&lt;b&gt;'), '', 'stripped here, not on the next read');
  assert.equal(stripMarkdown('a&lt;br/&gt;b'), 'a b', 'and an encoded break is the same break');
  // One layer only, as decodeEntities decodes it: a double-encoded entity is the documented second pass.
  assert.equal(stripMarkdown('&amp;quot;'), '&quot;', 'the `&amp;`-last rule holds: not peeled to a quote');
});

test('cleanDescription answers the empty string for nothing', () => {
  assert.equal(cleanDescription(null), '');
  assert.equal(cleanDescription(undefined), '');
  assert.equal(cleanDescription(''), '');
});

test('plainText: tags out, entities decoded with &amp; last, whitespace collapsed', () => {
  // The older half of the file had no test of its own; pinned here so a change to it is noticed.
  assert.equal(plainText('<b>x</b> a &amp;quot; b   \n c'), 'x a &quot; b c', '&amp; decoded last, so one layer of escaping is not peeled');
  assert.ok(!/<[^>]*>/.test(plainText('<scr<b>ipt>alert(1)</script>')), 'nothing tag-shaped survives the fixed-point loop');
});
