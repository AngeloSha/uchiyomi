// v0.40.0: the surfaces of a chapter saved with pages missing.
//
// The server now keeps a chapter when at least 80 % of its pages arrived, with a flat placeholder at every
// hole and the hole numbers on the book (`missingPages`) and the page list (`missing: true`). None of that
// is visible unless the web draws it: the reader has to caption the placeholder in BOTH renderers, the series
// row has to say how many pages are short, the offline record has to keep the flag, the job cards have to
// say what was taken from elsewhere, and the admin has to be able to switch the hunt off. Each of those is
// a few lines in a large file that a type check cannot miss and a browser walk covers once -- so, like
// settingsConsole.test.ts, these read the source. Every guard names the edit that makes it fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { jobNoteLines } from '../lib/jobNotes';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file with its comments removed -- several comments quote the code they forbid. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
/** The source between two markers, so a guard reads ONE block and not its neighbours. */
const between = (src: string, from: string, to: string, what: string): string => {
  const a = src.indexOf(from);
  assert.notEqual(a, -1, `${what}: "${from}" is gone`);
  const b = src.indexOf(to, a + from.length);
  assert.notEqual(b, -1, `${what}: "${to}" is gone`);
  return src.slice(a, b);
};

// ---- the reader ----

test('the reader captions a missing page in both renderers, and the caption is not a control', () => {
  // The vertical column and the paged slide are two render trees with nothing in common but ReaderImg, so a
  // caption added to one is absent from the other and the page reads as a broken image there.
  // Reintroduce by deleting the `<MissingCaption` line from either renderer: the matching assertion fails.
  const src = code(read('app/reader/page.tsx'));
  // v0.61.0: a row of the vertical column is components/ReaderPage.tsx's ReaderPageRow, and MissingCaption lives there
  // too. The guard followed the code: the column hands each row its source's name, and the row draws the caption.
  const rowFile = code(read('components/ReaderPage.tsx'));
  const vertical = between(src, "{prefs.mode === 'vertical' ? (", 'hide-scrollbar flex h-screen-d snap-x', 'the vertical renderer');
  // `<AnimatePresence>` is where the chrome starts; the CHROME comment itself is stripped with the rest.
  const paged = between(src, 'hide-scrollbar flex h-screen-d snap-x', '<AnimatePresence>', 'the paged renderer');
  const row = between(rowFile, 'export const ReaderPageRow = memo(', '\n});\n', 'ReaderPageRow');
  assert.match(vertical, /<ReaderPageRow [\s\S]*?missingSource=\{p\.missing \? sourceNameOf\(chapters\[p\.ci\]\?\.sourceId\) : null\}/, 'the vertical column does not name the source to a missing page\'s row');
  assert.match(row, /item\.missing && !collapsed && <MissingCaption number=\{item\.number\} source=\{missingSource\} \/>/, 'the vertical column draws no caption on a missing page');
  assert.match(paged, /if \(p\.missing\) \{[\s\S]*?<MissingCaption number=\{p\.number\} source=\{sourceNameOf\(/, 'the paged slide draws no caption on a missing page');
  // In the slide the caption needs a box of its own, with a definite height, or the image's max-h-full is
  // no limit at all and the page overflows the viewport. Reintroduce by dropping `h-full` from that box.
  assert.match(paged, /<div key=\{p\.key\} className=\{`relative flex h-full items-center justify-center/, 'the paged caption box has no definite height');
  // The caption itself: passive, both sentences, the source named only when there is a name.
  const cap = between(rowFile, 'function MissingCaption(', '\n}\n', 'MissingCaption');
  assert.match(cap, /pointer-events-none/, 'the caption takes taps -- the chrome toggle and double-tap zoom stop working over a missing page');
  assert.doesNotMatch(cap, /<button|onClick/, 'the caption is a control; there is nothing to do by hand and the tap belongs to the scroll container');
  assert.match(cap, /tr\('Page \{n\} could not be fetched from \{source\}', \{ n: number, source \}\)/, 'the named sentence is gone');
  assert.match(cap, /tr\('Page \{n\} could not be fetched', \{ n: number \}\)/, 'the fallback sentence without a source is gone');
  assert.match(cap, /tr\('It will be retried automatically\.'\)/, 'the reader is not told the sweep refills the hole');
  assert.match(cap, /source \? tr\('Page \{n\} could not be fetched from \{source\}'/, 'a missing name is printed as an empty "from"');
});

test('the renderer cannot re-collapse or re-hide a missing placeholder that also carries junk', () => {
  // `buildFlow` is the single decision point. Recomputing collapse from `p.junk` in the renderer bypassed
  // its missing-page exception, leaving a protected placeholder as a 48 px strip with no readable caption.
  const src = code(read('app/reader/page.tsx'));
  assert.match(src, /const hs = flat\.map\(\(p\) => p\.collapsed\s*\? STRIP_H/, 'the height model bypasses buildFlow and can collapse a missing placeholder');
  // v0.61.0: the row is components/ReaderPage.tsx's ReaderPageRow, and is handed the flow's own item.
  assert.match(code(read('components/ReaderPage.tsx')), /const collapsed = !!item\.collapsed;/, 'the vertical renderer recomputes collapse from junk');
  assert.match(src, /<ReaderPageRow key=\{p\.key\} item=\{p\}/, 'the vertical renderer hands its rows something other than the flow\'s item');
  assert.match(src, /p\.junk && !p\.missing && !expanded\.has\(`\$\{ch\.id\}:\$\{p\.number\}`\)/, 'the hidden-page notice counts a visible missing placeholder');
  assert.match(src, /junk: !!p\.junk && !p\.missing && !p\.removed,[\s\S]*?missing: !!p\.missing,/, 'the page grid presents a missing placeholder as skipped');
  assert.match(code(read('components/PageGrid.tsx')), /onToggleJunk && !p\.missing && !p\.removed && \(/, 'the page grid lets a missing placeholder be marked for skipping');
});

test('the reader names the source from what it already has, and asks /api/sources only when allowed', () => {
  // /api/sources answers 403 to a member without download rights: asked unconditionally it is one failed
  // request per chapter opened, for a name the series' own `sources` usually carries anyway.
  // Reintroduce by dropping `&& canDownload(user)` from the query's `enabled`.
  const src = code(read('app/reader/page.tsx'));
  assert.match(src, /setSeriesSourceNames\(Object\.fromEntries\(\(s\?\.sources \?\? \[\]\)\.map\(\(x\) => \[x\.sourceId, x\.name\]\)\)\)/, 'the followed sources\' names are not taken from the series fetch');
  const q = between(src, "queryKey: ['sources'],", 'const sourceNameOf', 'the sources query');
  assert.match(q, /enabled: unnamedMissingSource && canDownload\(user\)/, 'the full source list is asked for by a viewer the route refuses, or with no missing page to name');
  assert.match(src, /const unnamedMissingSource = chapters\.some\(\(c\) => !!c\.sourceId && !seriesSourceNames\[c\.sourceId\] && c\.pages\.some\(\(p\) => p\.missing\)\)/, 'the gate no longer keys on an unnamed source with a missing page');
  // The flag and the source id both have to survive loadChapter, or the caption never renders online. (v0.77.0: the page
  // list is read by pageList, which carries #229's `join` beside them, and since v0.89.0 #262's `mark`.)
  assert.match(src, /junk: p\.junk, missing: p\.missing, removed: p\.removed, restorable: p\.restorable, contentVersion: p\.contentVersion, join: p\.join, mark: p\.mark \}\)\)/, 'loadChapter drops the missing flag from the page list');
  assert.match(src, /sourceId: b\.sourceId \?\? null,/, 'loadChapter drops the book\'s sourceId');
});

// ---- the series page ----

test('a chapter row says how many pages are missing, as an amber chip before the group, and in the title', () => {
  // The chip is a state like the tombstone's, not a caption part: "3 pages missing · Asura Scans" reads as
  // the group's fault. Singular for one. And a caption made of the chip alone must still render -- a
  // chapter with no group, no via and no versions used to return null before anything was drawn.
  // Reintroduce by dropping `!short` from the early return: a short chapter with no other caption shows nothing.
  const page = code(read('app/series/page.tsx'));
  const cap = between(page, 'function RowCaption(', 'function RowDate(', 'RowCaption');
  assert.match(cap, /missing === 1 \? tr\('1 page missing'\) : tr\('\{n\} pages missing', \{ n: missing \}\)/, 'the chip text or its singular is gone');
  assert.match(cap, /if \(!parts\.length && !pruned && !short\) return null;/, 'a caption that is only the chip is not drawn');
  assert.match(cap, /\.\.\.\(short \? \[short\] : \[\]\), \.\.\.plain\]\.join\(' · '\)/, 'the chip text is not in the hover title');
  assert.match(cap, /\{short && <span className="me-1 rounded-full border border-amber-500\/40 bg-amber-500\/10 px-1\.5 text-\[10px\] leading-4 text-amber-300">\{short\}<\/span>\}\s*\{parts\.map/, 'the chip is not an amber chip before the caption parts');
  assert.doesNotMatch(cap, /<button/, 'RowCaption renders a button inside the row opener');
  // And ChapterRow feeds it from the DTO.
  const row = between(page, 'function ChapterRow(', 'function GhostRow(', 'ChapterRow');
  assert.match(row, /<RowCaption group=\{book\.scanlator\} via=\{altSource\} versions=\{versions\} pruned=\{prunedWords\(book\)\} missing=\{book\.missingPages\?\.length\}(?: talk=\{talk\})? \/>/, 'ChapterRow does not pass the book\'s missingPages to the caption');
});

// ---- offline ----

test('the offline record keeps the missing flag beside junk', () => {
  // The reader consults the offline record BEFORE the server for a downloaded chapter, so a flag that only
  // lives in the manifest is one the reader never sees: online the caption, offline a blank grey page.
  // Reintroduce by dropping `missing: p.missing` from the pages map in saveChapter.
  const src = code(read('lib/downloads.ts'));
  // v0.77.0: #229's `join` rides beside them, for the same reason (bff routes/downloads.ts); v0.89.0, #262's `mark` too.
  assert.match(src, /pages: manifest\.pages\.map\(\(p\) => \(\{ number: p\.number, width: p\.width, height: p\.height, junk: p\.junk, missing: p\.missing, removed: p\.removed, restorable: p\.restorable, contentVersion: p\.contentVersion, join: p\.join, mark: p\.mark \}\)\)/, 'the offline record does not copy `missing` beside `junk`');
  assert.match(src, /junk\?: boolean; missing\?: true; removed\?: true; restorable\?: boolean; contentVersion\?: string; join\?: 'rtl' \| 'ltr'; mark\?: 'join' \| 'split' \}\[\];/, 'the OfflineChapter page type lost `missing`');
  // The manifest type it reads from carries the flag too, or the copy above is a type error at best.
  assert.match(code(read('lib/types.ts')), /bytes: number \| null; junk\?: boolean; missing\?: true; removed\?: true; restorable\?: boolean; contentVersion\?: string; join\?: 'rtl' \| 'ltr'; mark\?: 'join' \| 'split' \}\[\];/, 'DownloadManifest pages lost `missing`');
  assert.match(code(read('lib/types.ts')), /missingPages\?: number\[\] \| null;/, 'Book lost `missingPages`');
});

// ---- the job cards ----

test('the job card lines: chapters not pages, the slow-down sentence only for a rate limit, names when known', () => {
  // `partial` on the card counts CHAPTERS saved short. Reintroduce by wording it with "pages": the
  // two-chapter card below says "2 pages missing". And a switch without a `why` is a plain "took it from":
  // reintroduce by using the slow-down sentence for every switch.
  assert.deepEqual(jobNoteLines(undefined), [], 'no card, no lines');
  assert.deepEqual(jobNoteLines({}), [], 'an empty card, no lines');
  assert.deepEqual(jobNoteLines({ partial: 0 }), [], 'zero short chapters is not a line');
  const two = jobNoteLines({ partial: 2 });
  assert.doesNotMatch(two[0] ?? '', /\b2 pages\b/, 'the partial line counts pages');
  assert.deepEqual(two, ['2 chapters saved with pages missing'], 'the plural partial line');
  assert.deepEqual(jobNoteLines({ partial: 1 }), ['1 chapter saved with pages missing'], 'the singular partial line');
  const lines = jobNoteLines({
    switched: [{ number: 12, from: 'aqua', to: 'reaper' }, { number: 13, from: 'aqua', to: 'reaper', why: 'rate_limited' }],
    partial: 2,
  }, (id) => ({ aqua: 'Aqua Scans', reaper: 'Reaper' }[id] ?? id));
  assert.equal(lines[0], 'took chapter 12 from Reaper', 'a switch without a why is not the plain "took it from" line');
  assert.equal(lines[1], 'Aqua Scans asked us to slow down — continued from Reaper', 'a rate-limit switch is not the slow-down line');
  assert.equal(lines[2], '2 chapters saved with pages missing', 'the partial line does not come last');
  assert.equal(lines.length, 3, 'a line too many or too few');
  // No name known: the id is printed, never dropped -- a line with a nineteen-digit id still says what happened.
  assert.deepEqual(jobNoteLines({ switched: [{ number: 1, from: 'a', to: 'b' }] }), ['took chapter 1 from b'], 'an unnamed source is dropped from the line');
});

test('the three job-card readers all draw the lines through jobNoteLines', () => {
  // Each surface used to word its own sentences; one helper is what keeps them saying the same thing and
  // what lets the locale test see each sentence once. Reintroduce by inlining `tr('took chapter…')` in any
  // one of them: that file no longer calls the helper. Library -> Downloads took over from the pill (v0.49.0).
  for (const f of ['components/ServerDownloadsView.tsx', 'components/FindMissingDialog.tsx', 'components/AddSeriesDialog.tsx']) {
    const src = code(read(f));
    assert.match(src, /import \{ jobNoteLines, type JobCardNotes \} from '@\/lib\/jobNotes';/, `${f} does not import the helper`);
    assert.match(src, /interface Job extends JobCardNotes \{/, `${f}'s Job does not carry switched/partial`);
    assert.match(src, /jobNoteLines\(j(?:ob)?, /, `${f} does not render the lines`);
    assert.doesNotMatch(src, /tr\('took chapter|tr\('\{from\} asked us|saved with pages missing'/, `${f} words a job line itself`);
  }
  // The view asks for names only once a card has something to name, and only as a viewer who may download.
  const view = code(read('components/ServerDownloadsView.tsx'));
  assert.match(view, /enabled: mayAdd && jobs\.some\(\(j\) => !!j\.switched\?\.length\)/, 'the Downloads view asks /api/sources with nothing to name, or for a viewer the route refuses');
});

// ---- the admin switch ----

test('Admin → Settings has exactly one switch for the hunt, under Downloads, on unless told otherwise', () => {
  // The hunt is on by default (server column `auto_follow_on_failure NOT NULL DEFAULT true`), so the row
  // reads `!== false`: a server that does not send the key yet is a server that hunts, and the switch says
  // so. It lives outside the extensions block because the hunt asks every registered source.
  // v0.81.0: it is no longer a switch of its own -- "Finish downloads on their own" writes it with finish_downloads, the
  // one switch for everything automatic about downloads (finishDownloads.test.ts pins that row).
  // Reintroduce by a second `autoFollowOnFailure` anywhere in the file, or by `!!data.auto_follow_on_failure`.
  const src = code(read('components/AdminSettings.tsx'));
  assert.equal((src.match(/autoFollowOnFailure/g) ?? []).length, 1, 'the hunt switch is saved from more or fewer than one place');
  assert.match(src, /data\.auto_follow_on_failure !== false/, 'the hunt is not on unless told otherwise');
  // In Downloads (v0.86.0), and never behind the extensions' condition: an install without an engine still hunts.
  // Reintroduce by wrapping the row in `data.extensions_configured && (…)`: "the hunt switch is behind the extensions"
  // fails.
  const section = between(src, 'function SchedulesSection(', 'function MaintenanceSection(', 'SchedulesSection');
  assert.ok(section.includes('autoFollowOnFailure: next'), 'the hunt switch is not in Downloads');
  assert.ok(!section.includes('extensions_configured'), 'the hunt switch is behind the extensions');
});

test('Health keeps explanatory notes reachable when a check has no active findings', () => {
  // A readable partial correctly clears its active chapter-failure row. The repair note must still be an
  // operable disclosure when `items` is empty, or Health says everything is fine but hides how the hole is
  // repaired. The aria relationship makes the newly available disclosure understandable to assistive tech.
  const src = code(read('app/admin/page.tsx'));
  const health = between(src, 'function Health()', '\nfunction DesktopUpdateNote(', 'Health');
  // v0.49.0: a card with an action of its own (Scan the library now) opens too -- after the note, never instead.
  assert.match(health, /const expandable = !!c\.items\.length \|\| !!c\.note \|\| hasCardActions\(c\);/, 'a note without findings cannot make its Health card expandable');
  assert.match(health, /type="button"[\s\S]*?aria-expanded=\{expandable \? isOpen : undefined\}[\s\S]*?aria-controls=\{expandable \? `health-\$\{c\.id\}-details` : undefined\}[\s\S]*?disabled=\{!expandable\}/, 'the Health disclosure does not announce or control its note panel');
  assert.match(health, /id=\{`health-\$\{c\.id\}-details`\}[\s\S]*?data-health-note/, 'the Health note panel lost the id named by its disclosure');
});
