// The series page after v0.34.0 folded its sources, groups and versions behind one line and a sheet.
//
// Read from source rather than driven in a browser, like library.test.ts: the two things that went -- the
// "Who scanlates this" card that sat open between Start reading and the chapter list, and the `{n} versions`
// strip that unfolded bordered lines inside the list -- are exactly what a later "just show it inline"
// change would bring back, and nothing in the behavioural suite would notice a card reappearing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** The file with its comments removed, so a comment that names the old code does not fail the scan. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('the series page has no Who-scanlates card and no version strip', () => {
  // Reintroduce by re-adding a `VersionStrip` identifier to the page (a component of that name rendered
  // under a row), by recreating components/WhoScanlates.tsx, or by dropping the SourcesSheet import: the
  // owner's complaint was the card open by default and the pills on every row, and this is the guard.
  assert.equal(existsSync(join(ROOT, 'components/WhoScanlates.tsx')), false, 'components/WhoScanlates.tsx is back');
  const page = code(read('app/series/page.tsx'));
  assert.doesNotMatch(page, /\bVersionStrip\b/, 'the series page renders a VersionStrip again');
  assert.doesNotMatch(page, /\bVersionList\b/, 'the series page renders a VersionList again');
  assert.doesNotMatch(page, /\bWhoScanlates\b/, 'the series page mounts the Who scanlates this card again');
  assert.match(page, /import \{[^}]*\bSourcesSheet\b[^}]*\} from '@\/components\/SourcesSheet'/, 'the series page no longer imports SourcesSheet');
  assert.match(page, /<SourcesSheet\b/, 'SourcesSheet is imported but never mounted');
  assert.match(page, /<SupplyLine\b/, 'the supply line is not mounted');
});

test('every sheet the series page opens clears the phone bottom nav', () => {
  // ⚠️ `Sheet` pads for the reader by default, which has no nav; opened from this page the last rows of a
  // sheet sit under the bar (the library's filters sheet hit this first). Reintroduce by dropping
  // `overBottomNav` from any of the four: the patience footer, the last group chip or the last copy's
  // Fetch is under the nav at 390 px.
  for (const f of ['components/SourcesSheet.tsx', 'components/ChapterFilterSheet.tsx', 'components/ChapterVersionsSheet.tsx', 'components/SourcesExplainer.tsx']) {
    const src = code(read(f));
    assert.match(src, /<Sheet\b[^>]*\boverBottomNav\b/s, `${f} opens a Sheet without overBottomNav`);
  }
});

test('the {n} versions caption is text inside the row opener, never a nested button', () => {
  // A button inside the opener <button> is invalid DOM that browsers un-nest unpredictably (the v0.33 strip
  // sat outside the opener for exactly this reason). Reintroduce by rendering the caption's versions part
  // as a <button>: the check finds a button tag inside RowCaption.
  const page = code(read('app/series/page.tsx'));
  const start = page.indexOf('function RowCaption(');
  const end = page.indexOf('function ChapterRow(');
  assert.ok(start > 0 && end > start, 'RowCaption and ChapterRow are where the scan expects them');
  assert.doesNotMatch(page.slice(start, end), /<button/, 'RowCaption renders a button inside the row opener');
});

/**
 * The body of one `const name = ...` arrow in the page: from its first line to the next line at the
 * component body's indent (its own closing `};`, or the next statement for a one-liner). ⚠️ Not "up to the
 * next `const`": the first cut ran past toggleRun into the reset effect beneath it, which also calls
 * setPickedGhosts, and the guard below passed with the fix removed.
 */
const fn = (page: string, name: string): string => {
  const start = page.indexOf(`  const ${name} = `);
  assert.ok(start > 0, `${name} is where the scan expects it`);
  const rest = page.slice(start + 1);
  const end = rest.search(/\n  \S/);
  return rest.slice(0, end > 0 ? end : undefined);
};

test('Fetch all posts its chunks one after the other, each after the previous job has ended', () => {
  // ⚠️ The route answers 409 `busy` while the series' job runs and `startJob` returns when a job has
  // STARTED, so chunks posted back to back are chunks refused: a 500-chapter run fetched 300 and toasted an
  // error for the rest. Reintroduce by deleting the `await awaitJob(` line from fetchMany (post the next
  // chunk at once): "waits for the job between chunks" fails. Or by chunking inline with `slice(i, i + 300)`
  // instead of chunkNumbers: "cuts with the tested helper" fails.
  const page = code(read('app/series/page.tsx'));
  const body = fn(page, 'fetchMany');
  assert.match(body, /\bchunkNumbers\(/, 'cuts with the tested helper');
  assert.match(body, /await awaitJob\(/, 'waits for the job between chunks');
  assert.doesNotMatch(body, /await startJob\(/, 'one toast for the run, not one per chunk');
  const wait = fn(page, 'awaitJob');
  assert.match(wait, /status !== 'downloading'/, 'the wait ends when the job is no longer downloading');
  assert.match(wait, /\['source-jobs'\]/, 'through the shared jobs key, so the pill reads the same answer');
});

test('a series with no chapters keeps its run open across Newest and Oldest', () => {
  // The `[id, asc]` reset folds every run; the default-open effect must re-apply per direction, or one tap
  // on the sort leaves a single folded run row as the whole page. Reintroduce by keying `defaultedRun` on
  // `id` alone (drop `:${asc}` and `asc` from the deps): "keyed by direction" fails.
  const page = code(read('app/series/page.tsx'));
  const start = page.indexOf('const defaultedRun = useRef');
  const effect = page.slice(start, page.indexOf('}, [', start) + 60);
  assert.match(effect, /`\$\{id\}:\$\{asc\}`/, 'keyed by direction');
  assert.match(effect, /\}, \[[^\]]*\basc\b[^\]]*\]/, 'and re-run when the direction changes');
});

test('hiding an older-chapters run drops its ghosts from the selection', () => {
  // The same rule as the ghost switch: a row nobody can see cannot stay picked, or the bar keeps counting
  // and Fetch acts on it. Reintroduce by making toggleRun only flip `expandedRuns` (no setPickedGhosts):
  // "Hide un-picks the run's numbers" fails.
  const page = code(read('app/series/page.tsx'));
  assert.match(fn(page, 'toggleRun'), /setPickedGhosts\(/, 'Hide un-picks the run\'s numbers');
  assert.match(page, /toggleRun\(r\.from, numbers\)/, 'the row hands the run its numbers');
});

test('the admin footer of the sources sheet is one row, and a sheet with a footer may take 85vh', () => {
  // ⚠️ Measured at 390×667: a 172-px footer (two helper sentences, the field, the buttons) under a 75vh
  // sheet left the Translated by section -- the only place Prefer and Block live -- below the fold.
  // Reintroduce by rendering either sentence in a visible `<p>` again (not `sr-only`, not the field's
  // `title`): "the helper sentences are the field's description, not rows" fails; or by capping every
  // Sheet at `max-h-[75vh]`: "a footered sheet grows" fails.
  const sheet = code(read('components/SourcesSheet.tsx'));
  const footer = sheet.slice(sheet.indexOf('const footer = admin && ('), sheet.indexOf('return (', sheet.indexOf('const footer = admin && (')));
  assert.match(footer, /aria-describedby=\{`patience-help-/, 'the field points at its description');
  assert.doesNotMatch(footer.replace(/<p id=\{`patience-help-[^>]*sr-only[^>]*>[^<]*<\/p>/, ''), /<p\b/, 'the helper sentences are the field\'s description, not rows');
  const ui = code(read('components/ui.tsx'));
  assert.match(ui, /footer \? 'max-h-\[85vh\]' : 'max-h-\[75vh\]'/, 'a footered sheet grows');
});

test('a Modal keeps clear of the phone bottom nav', () => {
  // The nav is a root-level sibling over `main`, so it paints over the bottom 5.5 rem of a dialog capped
  // at 88vh: the add dialog's "Add to library", scrolled to its end, was under the bar at 390×740.
  // Reintroduce by dropping the `pb-[calc(5.5rem+…)]` from the backdrop or restoring a plain
  // `max-h-[88vh]` on the panel: the matching assertion fails.
  const modal = code(read('components/ConfirmDialog.tsx'));
  assert.match(modal, /pb-\[calc\(5\.5rem\+env\(safe-area-inset-bottom\)\)\] backdrop-blur-xs lg:pb-4/, 'the backdrop leaves the bar\'s band free below lg');
  assert.match(modal, /max-h-\[calc\(100dvh-7\.5rem-env\(safe-area-inset-bottom\)\)\] w-full lg:max-h-\[88vh\]/, 'the panel is capped under that band, 88vh from lg up');
});

test('a row caption carries its text as a title, and the desktop grid shows the short date', () => {
  // A 287-px grid cell leaves the caption ≈71 px beside "3d ago" and a group name is ≈90: the hover reads
  // what the ellipsis hid, and "3d" gives the caption the word back. Reintroduce by dropping `title=` from
  // RowCaption's <p>: "the caption has a title" fails; or by rendering one span with relativeTime in both
  // forms: "the grid gets the short form" fails.
  const page = code(read('app/series/page.tsx'));
  const cap = page.slice(page.indexOf('function RowCaption('), page.indexOf('function RowDate('));
  assert.match(cap, /<p className=\{`mt-0\.5 truncate[^>]*title=\{title\}/, 'the caption has a title');
  const date = page.slice(page.indexOf('function RowDate('), page.indexOf('function ChapterRow('));
  assert.match(date, /replace\(\/ ago\$\/, ''\)/, 'the short form drops the word');
  assert.match(date, /className="hidden lg:inline">\{short\}/, 'the grid gets the short form');
  assert.match(date, /className="lg:hidden">\{long\}/, 'the phone keeps the long one');
});
