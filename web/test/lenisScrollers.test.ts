// A panel that scrolls over the page has to opt out of Lenis.
//
// Lenis drives smooth wheel scrolling for the whole app (app/providers.tsx). It reads a wheel event, walks
// up from its target looking for `[data-lenis-prevent]`, and -- finding none -- scrolls the PAGE instead of
// whatever was under the pointer. So a dialog or sheet that is `overflow-y-auto` still cannot be scrolled
// with a wheel unless it carries that attribute: the CSS says it scrolls, the app says otherwise.
//
// It only shows up on a short window, which is what makes it easy to ship: the panel fits on the machine it
// was built on, and the rows past the fold are simply unreachable for everyone else. The reader's settings
// sheet lost its last three rows that way -- reading direction, repeated pages, and the per-source default.
//
// `Sheet` in components/ui.tsx says this in a comment ("not optional"); this is that comment as a test.
//
// ⚠️ Not only overlays, and not a list someone has to remember. Lenis 1.3 leaves `allowNestedScroll` off, so a
// short list INSIDE the page (a folder picker, "Add to collection") is just as dead to the wheel, and the list
// of files this test first checked missed v0.47.0's chapter preview a day after it shipped: the wheel scrolled
// the page behind a full-screen viewer and the chapter never moved. So every file under app/ and components/
// is read, and every element that scrolls must carry the attribute -- even one inside a panel that already
// does, where it changes nothing, because "covered by an ancestor" is exactly what a later move breaks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(__dirname, '..');

/** Surfaces that float over the page and scroll: each must still HAVE a scroller, or the scan below is vacuous for it. */
const OVERLAYS = [
  'components/PreviewReader.tsx',      // v0.47.0's chapter preview, which shipped without it
  'components/ui.tsx',                 // Sheet — the shared bottom sheet
  'components/ReaderSettings.tsx',     // the reader's own sheet, which is not the shared one
  'components/ConfirmDialog.tsx',
  'components/ConsoleNav.tsx',
  'components/DownloadsIndicator.tsx',
  'components/CommandPalette.tsx',
];

/** Source with comments removed: several of them quote the class names below. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

/**
 * The opening tags in a file.
 *
 * `=>` is neutralised first: an arrow function in an attribute (`onClick={(e) => ...}`) carries a `>` that
 * would otherwise end the tag early and hide every attribute after it -- including the one under test.
 */
const openingTags = (src: string): string[] =>
  // …and so is a comparison inside a template class (`${zoom > 1 ? … : …}`), for the same reason.
  code(src).replace(/=>/g, '==').replace(/ >=? /g, ' gt ').match(/<[A-Za-z][^>]*>/g) ?? [];

const scrolls = (tag: string) => /\boverflow-y-(auto|scroll)\b|\boverflow-(auto|scroll)\b/.test(tag);

function tsxUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : tsxUnder(p);
    return p.endsWith('.tsx') ? [p] : [];
  });
}

test('every overlay that scrolls opts out of Lenis', () => {
  for (const file of OVERLAYS) {
    const tags = openingTags(readFileSync(join(ROOT, file), 'utf8')).filter(scrolls);
    assert.ok(tags.length > 0, `${file} no longer has a scrolling panel — has it moved, or should it leave this list?`);
    for (const tag of tags) {
      // Reintroduce by deleting `data-lenis-prevent` from any panel here: the wheel then scrolls the page
      // behind it, and on a short window its lower rows cannot be reached at all.
      assert.ok(
        tag.includes('data-lenis-prevent'),
        `${file}: a panel scrolls without data-lenis-prevent, so the wheel will scroll the page behind it:\n${tag.slice(0, 220)}`,
      );
    }
  }
});

test('every element anywhere in the app that scrolls opts out of Lenis', () => {
  const files = [...tsxUnder(join(ROOT, 'app')), ...tsxUnder(join(ROOT, 'components'))];
  let seen = 0;
  const missing: string[] = [];
  for (const file of files) {
    for (const tag of openingTags(readFileSync(file, 'utf8')).filter(scrolls)) {
      seen++;
      // Reintroduce by removing `data-lenis-prevent` from PreviewReader.tsx's scroller: the wheel scrolls the
      // page behind the preview, and this names that file.
      if (!tag.includes('data-lenis-prevent')) missing.push(`${relative(ROOT, file)}: ${tag.slice(0, 160)}`);
    }
  }
  // A parser that stopped finding tags would pass everything; the app has well over a dozen scrollers.
  assert.ok(seen >= 15, `only ${seen} scrolling elements found -- is the tag parser still reading the files?`);
  assert.deepEqual(missing, [], `these scroll without data-lenis-prevent, so the wheel scrolls the page instead:\n${missing.join('\n')}`);
});
