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
// Nested scrollers inside a panel need nothing: Lenis walks up, so the outermost one covers them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');

/** Every surface that floats over the page and scrolls. A new one belongs in this list. */
const OVERLAYS = [
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
const openingTags = (src: string): string[] => code(src).replace(/=>/g, '==').match(/<[A-Za-z][^>]*>/g) ?? [];

const scrolls = (tag: string) => /\boverflow-y-auto\b|\boverflow-auto\b/.test(tag);

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
