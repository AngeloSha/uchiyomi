// The reviewable import (PR #52, v0.35.0): which rows the review screen flags, what the row shows, and the
// lifecycle the page wires up. Since v0.36.0 also the tracker intake (#48 point 1) and, because the same
// static reading applies, the add dialog's "also check the other sources" switch (#49) and the sheet's chip.
//
// The pure half (`lib/importBatch.ts`) is exercised directly, like wall.test.ts. The page half is read from
// source, like library.test.ts: whether Discard exists and calls DELETE, whether the matched title is on the
// row, whether Admin → Providers has one way in -- each a thing that shipped wrong or missing in the PR as
// reviewed, and each invisible to a type check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  needsAttention, containsDiverges, matchTitleDiffers, matchedViaAlt, openBatches, batchOriginLabel, runStatusLabel, runStatusColor,
  linkedCount, linkedLine,
  type ImportCandidate, type ImportBatchSummary,
} from '../lib/importBatch';
import { readTab } from '../lib/tabParam';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file with its comments removed -- several comments below quote the code they forbid. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const row = (p: Partial<ImportCandidate>): ImportCandidate => ({
  id: 'c1', batch_id: 'b1', ord: 0, backup_title: 'Solo Leveling',
  backup_source_id_unsigned: null, backup_source_id_signed: null, backup_url: null, in_library: false,
  decision: 'auto', confidence: 'exact', match_source: 'mangadex', match_source_id: 'x', match_title: 'Solo Leveling', match_cover: null,
  auto_source: 'mangadex', auto_source_id: 'x', auto_title: 'Solo Leveling', auto_cover: null, auto_confidence: 'exact', status: null,
  ...p,
});

test('a close match that differs by more than a trailing qualifier needs attention', () => {
  // The server calls any substring hit `contains` and the row paints it as a calm "close match". That is
  // right for "Solo Leveling (Official)" and wrong for "Boruto: Naruto Next Generations" holding "Naruto".
  // Reintroduce by dropping the `contains` clause from needsAttention (back to `fuzzy` only): "in front" fails.
  const c = (backup: string, match: string) => row({ backup_title: backup, match_title: match, confidence: 'contains' });
  assert.equal(needsAttention(c('Solo Leveling', 'Solo Leveling (Official)')), false, 'a bracketed suffix is how apps spell the same title');
  assert.equal(needsAttention(c('One Piece', 'One Piece Colored')), false, 'a short suffix');
  assert.equal(needsAttention(c('Naruto', 'Boruto: Naruto Next Generations')), true, 'in front');
  assert.equal(needsAttention(c('Beginning After the End', 'The Beginning After the End')), true, 'a word in front');
  assert.equal(needsAttention(c('Berserk', 'Berserk of Gluttony')), true, 'a suffix longer than the title is mostly another title');
  // The rule itself, so a wording change on the row cannot hide a regression in it.
  assert.equal(containsDiverges('Solo Leveling', 'solo-leveling!'), false, 'a spelling difference is no difference');
  assert.equal(containsDiverges('Solo Leveling', null), false, 'no match title, nothing to compare');
});

test('a close match that names a season, a part, a novel or a sequel needs attention; an edition does not', () => {
  // A cross-source `contains` is reached only when the source lacks the plain title, and a source with the
  // sequel almost always has the original -- so "Solo Leveling: Ragnarok" for "Solo Leveling" is the wrong
  // work far more often than a spelling, and the first cut left it calm, off the Needs attention filter and
  // inside "Select ready to import". Reintroduce by dropping `SEQUEL_MARK` from containsDiverges: "a sequel
  // by name" fails. Reintroduce the other half by dropping the `EDITION_WORD` strip: "an edition longer than
  // the title" fails, because "(Official Colored)" is longer than "Naruto" and the length rule takes it.
  const c = (backup: string, match: string) => row({ backup_title: backup, match_title: match, confidence: 'contains' });
  assert.equal(needsAttention(c('Solo Leveling', 'Solo Leveling: Ragnarok')), true, 'a sequel by name');
  assert.equal(needsAttention(c('Tower of God', 'Tower of God Season 2')), true, 'a season');
  assert.equal(needsAttention(c('The Beginning After The End', 'The Beginning After The End (Novel)')), true, 'a novel');
  assert.equal(needsAttention(c('Dragon Ball', 'Dragon Ball Super')), true, 'a sequel word');
  assert.equal(needsAttention(c('Re:Zero', 'Re:Zero Chapter 2')), true, 'a digit');
  assert.equal(needsAttention(c('Solo Leveling', 'Solo Leveling II')), true, 'a roman numeral on its own');
  assert.equal(needsAttention(c('Naruto', 'Naruto (Official Colored)')), false, 'an edition longer than the title');
  assert.equal(needsAttention(c('Bleach', 'Bleach (Full Color)')), false, 'a colour edition');
  assert.equal(needsAttention(c('Solo Leveling', 'Solo Leveling (Manhwa)')), false, 'a format');
  assert.equal(needsAttention(c('Tower of God', 'Tower of God (Webtoon)')), false, 'another format');
  // Either side may carry the suffix: a backup of the sequel matched to the original is the same wrong pick.
  assert.equal(needsAttention(c('Tower of God Season 2', 'Tower of God')), true, 'the backup carrying the season');
  assert.equal(needsAttention(c('The Beginning After The End (Novel)', 'The Beginning After The End')), true, 'the backup carrying the novel');
  assert.equal(needsAttention(c('Naruto (Official Colored)', 'Naruto')), false, 'the backup carrying the edition');
  assert.equal(containsDiverges('Solo Leveling', 'Solo Leveling (Official) Season 2'), true, 'an edition word does not hide a season behind it');
});

test('the other tiers keep their meaning: fuzzy and unmatched need attention, exact and manual do not', () => {
  // Reintroduce by returning true for `manual` -- a pick a person just made would be flagged back at them.
  assert.equal(needsAttention(row({ decision: 'unresolved', confidence: null, match_title: null })), true, 'no match found');
  assert.equal(needsAttention(row({ confidence: 'fuzzy' })), true, 'fuzzy');
  assert.equal(needsAttention(row({ confidence: 'exact' })), false, 'exact');
  assert.equal(needsAttention(row({ confidence: 'same_source' })), false, 'same source');
  assert.equal(needsAttention(row({ decision: 'skip', confidence: null })), false, 'skipped');
  assert.equal(needsAttention(row({ decision: 'manual', confidence: null, match_title: 'Something Else Entirely' })), false, 'manual');
});

test('the matched title stands out only when it says something the backup title does not', () => {
  // Reintroduce by comparing the raw strings: "SOLO LEVELING" against "Solo Leveling" would light up on
  // every row of a MangaDex list, and the line would stop meaning anything.
  assert.equal(matchTitleDiffers(row({ match_title: 'SOLO LEVELING!' })), false, 'same title, other spelling');
  assert.equal(matchTitleDiffers(row({ match_title: 'Solo Leveling: Ragnarok' })), true, 'a different title');
  assert.equal(matchTitleDiffers(row({ match_title: null })), false, 'nothing matched');
});

test('the Open imports list holds what a person can still act on', () => {
  // Reintroduce by returning the list unfiltered: a finished batch sits on the intake card as if it needed
  // something, until the sweep removes it a week later.
  const b = (state: ImportBatchSummary['state']): ImportBatchSummary => ({ id: state, origin: 'paste', state, total: 3, resolved: 3, added: 0, failed: 0, created_at: '2026-09-18T00:00:00Z' });
  assert.deepEqual(openBatches([b('done'), b('review'), b('cancelled'), b('resolving'), b('importing')]).map((x) => x.state), ['review', 'resolving', 'importing']);
});

test('the review row shows what the title was matched TO', () => {
  // "Solo Leveling · MangaDex · close match" read the same whether the pick was Solo Leveling or Solo
  // Leveling: Ragnarok; the only hint was a 40-px cover. Reintroduce by deleting the `data-match-title`
  // line from ReviewRow.
  const src = code(read('app/admin/import/page.tsx'));
  assert.match(src, /data-match-title[\s\S]{0,200}\{c\.match_title\}/, 'ReviewRow no longer prints match_title');
  assert.match(src, /matchTitleDiffers\(c\) \? 'text-fog-200' : 'text-fog-600'/, 'the line is not dimmed when it repeats the backup title');
  // The chip goes amber with the row, whatever tier the server gave it, so a flagged `contains` looks flagged.
  assert.match(src, /attention \? 'text-amber-400' : confidenceColor\(c\.confidence\)/, 'a flagged close match still paints as a calm one');
  // A manual pick has no tier (the server nulls `confidence`), and confidenceLabel(null) is "unmatched": the
  // PR rendered "unmatched · manual", in amber, on the one row a person had just chosen by hand.
  // Reintroduce by rendering the confidence chip for every matched row again.
  assert.match(src, /c\.decision === 'manual'\s*\?[\s\S]{0,80}tr\('picked by hand'\)/, 'a manual pick reads as a confidence tier');
});

test('a batch can be discarded from every live state, and it is a DELETE', () => {
  // ⚠️ The PR had no DELETE call anywhere in the web: a batch stranded in `importing` by a restart, or a
  // review nobody wanted to finish, could only be left to the sweep. Reintroduce by removing the `canDiscard`
  // button from the header, or by turning the request into a POST to /cancel.
  const src = code(read('app/admin/import/page.tsx'));
  assert.match(src, /api\(`\/api\/admin\/import\/batches\/\$\{batchId\}`, \{ method: 'DELETE' \}\)/, 'Discard does not DELETE the batch');
  assert.match(src, /const canDiscard = !!batch && batch\.state !== 'done' && batch\.state !== 'cancelled'/, 'Discard is not offered in resolving, review AND importing');
  assert.match(src, /\{canDiscard && \([\s\S]{0,200}setDiscarding\(true\)/, 'the header has no Discard button');
  // Destructive, so through the shared ConfirmDialog -- never window.confirm, and never opened over the
  // match sheet (Modal z-50 sits under Sheet z-60).
  assert.match(src, /<ConfirmDialog[\s\S]{0,900}onConfirm=\{discard\}/, 'Discard has no confirmation');
  assert.doesNotMatch(src, /window\.confirm/, 'window.confirm is back');
});

test('the intake card lists open batches from the list route, so a closed tab does not orphan one', () => {
  // Reintroduce by dropping the `import-batches` query: the only way back to a half-reviewed batch is the
  // id in an address bar that was closed.
  const src = code(read('app/admin/import/page.tsx'));
  assert.match(src, /queryKey: \['import-batches'\][\s\S]{0,120}'\/api\/admin\/import\/batches'\)/, 'the page does not fetch the batch list');
  assert.match(src, /<OpenImports batches=\{open\} onOpen=\{onOpen\} \/>/, 'the intake card does not render the list');
  // The polling stops with the server's word: only resolving/importing poll, so a batch flipped to `review`
  // by GET (a stale run) lands on the review card rather than a progress bar that never moves.
  assert.match(src, /return st === 'resolving' \|\| st === 'importing' \? 1500 : false;/, 'the batch query polls in a state that never changes');
});

test('the match sheet keeps search at the top and the comparison in the pinned footer', () => {
  // On a 390 px phone the PR's sheet put search, the current pick, the new pick, the delta and both
  // buttons in ONE sticky block: 250-330 px of a 75 vh panel, and transparent (`bg-ink-950/0`, no z-index),
  // so the positioned result cards painted over it as the rails scrolled. Measured after the split: rails
  // 434 px tall, footer 622..755 above the nav. Reintroduce by moving `footer`'s content back under the
  // search field, or by dropping `z-10` / the opaque ground from the sticky header.
  const src = code(read('components/ImportMatchSheet.tsx'));
  assert.match(src, /<Sheet title=\{candidate\.backup_title\} onClose=\{onClose\} overBottomNav footer=\{footer\}>/, 'the sheet has no pinned footer');
  assert.match(src, /const footer = \([\s\S]*?tr\('Use this pick'\)[\s\S]*?tr\('Skip this one'\)[\s\S]*?\n  \);/, 'Use this pick / Skip are not in the footer');
  assert.match(src, /sticky top-0 z-10 -mx-4 mb-3 bg-ink-950\/90/, 'the search header is transparent or under the rails again');
  assert.doesNotMatch(src, /bg-ink-950\/0/, 'a fully transparent sticky block is back');
});

test('the intake copy names the button that commits, and the review copy tells the truth about time', () => {
  // Reintroduce by writing "until you press Continue" back: there is no Continue on this page.
  const src = read('app/admin/import/page.tsx');
  assert.ok(src.includes('nothing lands in your library until you press Import selected.'), 'the intake card promises a button that does not exist');
  assert.doesNotMatch(code(src), /press Continue/, '"Continue" is back');
  assert.ok(src.includes("tr('Import selected — {n}', { n: selectedIds.size })"), 'the commit button is no longer "Import selected — {n}"');
  // Adding with nothing downloaded still asks each source for the series, one title at a time.
  assert.doesNotMatch(src, /seconds of database work/, 'the copy calls a minutes-long add "seconds"');
  assert.match(src, /a long list takes a few minutes/, 'the review card does not say how long an import takes');
});

test('Admin → Providers has one way to import: the reviewed flow', () => {
  // The PR stacked the new button on top of the old textarea flow ("or, without a review step:"), which still
  // added the first cross-source hit with no review -- two ways to do one thing, one of them the bug the
  // other fixes. Reintroduce by putting the textarea and its POST /api/admin/import back on the card.
  const src = code(read('app/admin/page.tsx'));
  assert.equal((src.match(/router\.push\('\/admin\/import\/'\)/g) || []).length, 1, 'the Providers card does not link to /admin/import/ exactly once');
  assert.doesNotMatch(src, /'\/api\/admin\/import'[,)]/, 'the one-shot POST /api/admin/import is back in the UI');
  assert.doesNotMatch(src, /\/api\/admin\/import\/(parse|status)/, 'the old parse/status calls are back');
  assert.doesNotMatch(src, /without a review step/, 'the "or, without a review step" fork is back');
  assert.match(src, /import a list → review matches → add/, 'the card no longer says what the flow is');
});

/**
 * Every English string a file asks `tr()` for: the inline literals, plus the labels declared through
 * `keys(...)` and rendered as `tr(label)` (lib/i18n.ts) -- the import page's list-status checkboxes are
 * declared that way, and an extractor blind to `keys()` would have passed with "Plan to read" in no file.
 */
const trKeys = (files: string[]): Set<string> => {
  const keys = new Set<string>();
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/\btr\(\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\'/g, "'"));
    for (const m of src.matchAll(/\btr\(\s*"((?:[^"\\]|\\.)*)"/g)) keys.add(m[1]);
    for (const decl of src.matchAll(/\bkeys\(([^)]*)\)/g)) {
      for (const m of decl[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\'/g, "'"));
    }
  }
  return keys;
};
const localeFiles = (): string[] => readdirSync(join(ROOT, 'public/locales')).filter((f) => f.endsWith('.json'));
const missingIn = (file: string, keys: Iterable<string>): string[] => {
  const d = JSON.parse(read(`public/locales/${file}`));
  return [...keys].filter((k) => !(k in d) || !String(d[k]).trim());
};

test('every string the import screens render is in all eight locale files', () => {
  // The PR touched no locale file: 62 of its 76 strings fell back to English in every other language, and
  // the parity test (library.test.ts) could not see it because it compares the files with each other, not
  // with the code. Reintroduce by deleting any one of these keys from es.json.
  const keys = trKeys(['app/admin/import/page.tsx', 'components/ImportMatchSheet.tsx', 'lib/importBatch.ts']);
  // The Providers entry card too: it is the door to the page.
  const admin = read('app/admin/page.tsx');
  for (const k of ['Import a list', 'Import and review matches →']) {
    assert.ok(admin.includes(`tr('${k}')`), `the Providers card no longer renders "${k}" through tr()`);
    keys.add(k);
  }
  assert.ok(keys.size >= 70, `only ${keys.size} tr() keys found on the import screens — the extractor lost them`);
  const dir = join(ROOT, 'public/locales');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 8);
  for (const f of files) {
    const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const missing = [...keys].filter((k) => !(k in d) || !String(d[k]).trim());
    assert.deepEqual(missing, [], `${f} is missing ${missing.length} import-screen keys, e.g. ${missing.slice(0, 3).join(' | ')}`);
  }
});

test('the rigs know the import page exists', () => {
  // CONTRIBUTING says screenshots come from the rig, and the browser checks visit a fixed list of pages.
  // A page in neither is a page nobody measures. Reintroduce by removing `/admin/import` from any one list.
  assert.match(read('test/e2e/layout.mjs'), /const PAGES = \(process\.env\.PAGES \|\| '[^']*\/admin\/import[,']/, 'layout.mjs does not measure /admin/import');
  assert.match(read('test/e2e/i18n.mjs'), /\['\/admin\/import', \[/, 'i18n.mjs does not visit /admin/import');
  assert.match(read('../scripts/shots/capture.mjs'), /want\('admin-import'\)/, 'capture.mjs has no admin-import shot');
});

test('a run status reads as a sentence, and a duplicate reads as "already in your library", not as a failure', () => {
  // /run writes the `error` code of addSeriesFromSource to the row verbatim, and the page printed it:
  // "Failed — duplicate", "Failed — no_chapters", in red, in every language. Reintroduce by returning the
  // generic `Failed — {reason}` line for every code but `added`/`already`: "duplicate" fails first.
  assert.equal(runStatusLabel('duplicate'), 'Already in your library', 'duplicate');
  assert.equal(runStatusLabel('already'), 'Already in your library', 'already');
  // Reintroduce by dropping the `linked` parameter: the review row of a tracker intake, whose owned rows carry
  // status `already` from the start, reads the bare label beside a link that is already there.
  assert.equal(runStatusLabel('already', true), 'Already in your library — linked for progress sync', 'a linked owned row says so on the review row too');
  assert.equal(runStatusLabel('duplicate', true), 'Already in your library', 'only an intake-linked row claims the link');
  assert.equal(runStatusLabel('added'), 'Added to your library', 'added');
  assert.equal(runStatusLabel('no_chapters'), 'No readable chapters on this source', 'no_chapters');
  assert.equal(runStatusLabel('disabled'), 'That source is switched off', 'disabled');
  assert.equal(runStatusLabel('blocked'), 'The source is blocking us right now', 'blocked');
  for (const code of ['undownloadable', 'disk_full', 'bad_request', 'no_title']) {
    assert.doesNotMatch(runStatusLabel(code), /Failed —|_/, `${code} still prints the code`);
  }
  // A code this table has never seen stays visible WITH the code, rather than a silent "failed".
  assert.equal(runStatusLabel('nothing_found'), 'Failed — nothing_found', 'an unknown code keeps the code on the row');
  // Colour follows meaning: a duplicate is quiet like `already`, not red like a failure.
  assert.equal(runStatusColor('duplicate'), runStatusColor('already'), 'a duplicate paints as a failure');
  assert.notEqual(runStatusColor('duplicate'), runStatusColor('no_chapters'), 'a duplicate paints like a failure');
  // Every branch is a literal, so the locale-parity test above sees each sentence.
  const src = code(read('lib/importBatch.ts'));
  assert.doesNotMatch(src, /runStatusLabel[\s\S]{0,900}tr\([a-z]/, 'runStatusLabel passes a variable to tr(), which no locale file can see');
});

test('the manual-search results are rails: one flex row per source, scrolling sideways', () => {
  // ScrollRail only adds `overflow-x-auto`; the caller makes it a row. Without `flex` the w-24 cards sat
  // as inline-blocks -- no gap, baseline-aligned so a two-line title lifted its cover 14 px, wrapping into a
  // 730 px block at 390 px with nothing to scroll. Reintroduce by removing `flex` from the className.
  const src = code(read('components/ImportMatchSheet.tsx'));
  const m = src.match(/<ScrollRail className="([^"]*)">/);
  assert.ok(m, 'the results are no longer in a ScrollRail');
  const cls = m![1].split(/\s+/);
  assert.ok(cls.includes('flex'), `the rail is not a flex row: "${m![1]}"`);
  assert.ok(!cls.includes('hide-scrollbar'), 'the rail hides the scrollbar ScrollRail exists to show');
  assert.ok(cls.some((c) => /^gap-/.test(c)), 'the cards have no gap');
});

test('the matched-title line wraps to two lines rather than cutting where the titles differ', () => {
  // At 390 px the line's column is ~140 px, and a one-line ellipsis cut every real pair exactly at its
  // suffix: "→ The Beginning After…" for the (Novel) pick, identical to the backup title above it, on the
  // calm rows the line exists for. Reintroduce by putting `truncate` back in place of `line-clamp-2`.
  const src = code(read('app/admin/import/page.tsx'));
  const line = src.match(/<p className=\{`([^`]*)`\}[^>]*data-match-title>/);
  assert.ok(line, 'the data-match-title line is gone');
  assert.match(line![1], /\bline-clamp-2\b/, 'the matched-title line is not clamped to two lines');
  assert.doesNotMatch(line![1], /\btruncate\b/, 'the matched-title line truncates to one line again');
});

test('a link to a batch that no longer exists goes back to the intake card and says so', () => {
  // A 404 on GET /batches/:id used to leave the intake card with the dead id in the address bar and,
  // because the list query is `enabled: !batchId`, no Open imports -- the one situation that list is for.
  // Reintroduce by removing the `batchError` effect (or its `startOver()` call).
  const src = code(read('app/admin/import/page.tsx'));
  assert.match(src, /retry: \(n, e\) => !\(e instanceof ApiError && e\.status === 404\)/, 'a 404 is retried like a hiccup');
  assert.match(src, /batchError instanceof ApiError && batchError\.status === 404\)\s*\{[\s\S]{0,200}tr\('That import is gone'\)[\s\S]{0,120}startOver\(\);/, 'a 404 does not clear the batch and say why');
  assert.match(src, /const startOver = \(\) => \{[\s\S]{0,400}qc\.invalidateQueries\(\{ queryKey: \['import-batches'\] \}\);[\s\S]{0,80}router\.replace\('\/admin\/import\/'\);/, 'startOver does not refresh the list and the URL');
});

test('an interrupted batch in Open imports reads as interrupted, not as matching', () => {
  // The list route computes `stale` like the GET route; without reading it the card said "Matching…
  // 12/40" after a restart while nothing was matching. Reintroduce by rendering batchStateLabel(b.state)
  // unconditionally.
  const src = code(read('app/admin/import/page.tsx'));
  assert.match(src, /b\.stale \? tr\('Interrupted — resume'\) : batchStateLabel\(b\.state\)/, 'OpenImports ignores `stale`');
});

test('the importing card counts the rows this run was sent, and the selection follows the rows', () => {
  // The card used to list every auto/manual row and count the batch total against it: select 2 of 8 and
  // it read "Importing… 2/8" with six pending rows that were never sent. Reintroduce by targeting
  // `items.filter(auto|manual)` again, or by dropping `runTotal` from the denominator.
  const src = code(read('app/admin/import/page.tsx'));
  assert.match(src, /const targeted = runIds\s*\?\s*items\.filter\(\(c\) => runIds\.has\(c\.id\)\)/, 'the importing list is not the ids this tab sent');
  assert.match(src, /const total = runTotal \?\? targeted\.length;/, 'the denominator is not the /run answer');
  assert.match(src, /setRunIds\(new Set\(ids\)\);\s*setRunTotal\(typeof r\?\.total === 'number' \? r\.total : ids\.length\);/, '/run\'s `total` is not kept');
  // Only ready rows go: "Select all" marks skipped and unmatched rows too, and the server drops them.
  assert.match(src, /const ids = items\.filter\(\(c\) => selectedReady\.has\(c\.id\)\)\.map\(\(c\) => c\.id\);/, '/run is sent ids the server will not take');
  // A row skipped from the sheet, or added by a run, leaves the selection on the next refetch: "6 selected"
  // used to keep a row Change → Skip had just removed. Reintroduce by deleting the `useEffect` on `items`.
  assert.match(src, /useEffect\(\(\) => \{\s*setSelected\(\(s\) => \{[\s\S]{0,400}items\.filter\(isReady\)[\s\S]{0,300}\}, \[items\]\);/, 'the selection is not pruned to ready rows on refetch');
});

test('the review filter finds a row by its matched title too', () => {
  // "Naruto → Boruto: Naruto Next Generations" is the row a person types "Boruto" to find, and the filter
  // found nothing. Reintroduce by matching `backup_title` alone.
  const src = code(read('app/admin/import/page.tsx'));
  assert.match(src, /c\.backup_title\.toLowerCase\(\)\.includes\(needle\) && !\(c\.match_title \|\| ''\)\.toLowerCase\(\)\.includes\(needle\)/, 'the filter ignores match_title');
});

test('the intake card tells the truth about what a backup gives up: title, source AND address', () => {
  // The matcher reads each entry's url (its address on the source) and uses it as the same-source proof;
  // the card and the docs said only the titles and their source were read. Reintroduce by restoring the
  // old sentence, in the page or in any locale file.
  const key = "A .tachibk backup stays on your server — only each entry's title, its source and its address on that source are read.";
  const src = read('app/admin/import/page.tsx');
  assert.ok(src.includes("only each entry\\'s title, its source and its address on that source are read."), 'the card no longer names the address');
  assert.doesNotMatch(src, /only the titles \(and, where available/, 'the old sentence is back on the card');
  const dir = join(ROOT, 'public/locales');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    assert.ok(typeof d[key] === 'string' && d[key].trim(), `${f} has no translation of the new sentence`);
    const old = Object.keys(d).find((k) => k.startsWith('A .tachibk backup stays on your server') && k !== key);
    assert.equal(old, undefined, `${f} still carries the old sentence: ${old}`);
  }
});

test('the selection-prune effect keys on the query result, never on an array minted per render', () => {
  // ⚠️ Found by the release walk, not by any harness: `data?.items ?? []` gave the prune effect a fresh
  // dependency on every render of the intake card, so typing into the paste box re-rendered the page, the
  // effect set state, React rendered again, and the browser threw "Maximum update depth exceeded" (React
  // #185) out of the textarea's onChange -- intermittently, because React's same-state bail-out sometimes
  // hides it. Reintroduce by replacing the useMemo with `const items = data?.items ?? [];`.
  const src = code(read('app/admin/import/page.tsx'));
  assert.match(src, /const items = useMemo\(\(\) => data\?\.items \?\? \[\], \[data\]\)/, 'items is not memoised on the query result');
  assert.doesNotMatch(src, /const items = data\?\.items \?\? \[\];/, 'a per-render empty array is back as the effect dependency');
});

// ---------------------------------------------------------------------------------------------------------
// v0.36.0: a tracker's reading list as the fourth way in (#48 point 1), and the add dialog's "also check
// the other sources" (#49).

test('a row matched under one of its other titles is judged against that title, and stays calm', () => {
  // The server searches a tracker row's alternates when the English title misses, and rightly grants
  // `contains` for "Shingeki no Kyojin (Official)" against the romaji. Judged against "Attack on Titan"
  // alone that hit has no overlap, so every alt-title match -- the feature's whole point -- landed under
  // Needs attention in amber. Reintroduce by testing `containsDiverges(c.backup_title, c.match_title)`
  // alone in needsAttention: "calm under its romaji" fails.
  const c = (alts: string[] | null, match: string) => row({ backup_title: 'Attack on Titan', alt_titles: alts, match_title: match, confidence: 'contains' });
  assert.equal(needsAttention(c(['Shingeki no Kyojin', '進撃の巨人'], 'Shingeki no Kyojin (Official)')), false, 'calm under its romaji');
  assert.equal(needsAttention(c(null, 'Shingeki no Kyojin (Official)')), true, 'without the alternates the same hit is a stranger');
  assert.equal(needsAttention(c(['Shingeki no Kyojin'], 'Shingeki no Kyojin: Before the Fall')), true, 'a sequel under the romaji still needs a look');
  assert.equal(needsAttention(c([], 'Attack on Titan (Colored)')), false, 'an empty list changes nothing');
  // The calmest verdict wins, whichever spelling gives it.
  assert.equal(needsAttention(c(['Shingeki no Kyojin'], 'Attack on Titan (Official Colored)')), false, 'calm under its own title');
  // The `→` line is dim for a match that equals any of the row's spellings; the dim "matched under its
  // other name" line then explains the different-looking title. Reintroduce the first by comparing
  // match_title with backup_title alone in matchTitleDiffers: "the romaji is not a different title" fails.
  assert.equal(matchTitleDiffers(row({ backup_title: 'Attack on Titan', alt_titles: ['Shingeki no Kyojin'], match_title: 'Shingeki no Kyojin' })), false, 'the romaji is not a different title');
  assert.equal(matchTitleDiffers(row({ backup_title: 'Attack on Titan', alt_titles: ['Shingeki no Kyojin'], match_title: 'Shingeki no Kyojin: Before the Fall' })), true, 'a sequel is');
  assert.equal(matchedViaAlt(row({ backup_title: 'Attack on Titan', matched_via: 'Shingeki no Kyojin' })), true, 'found under the alternate');
  assert.equal(matchedViaAlt(row({ backup_title: 'Attack on Titan', matched_via: 'attack on titan' })), false, 'found under its own title, spelt differently');
  assert.equal(matchedViaAlt(row({ backup_title: 'Attack on Titan', matched_via: null })), false, 'no term recorded');
  assert.equal(matchedViaAlt(row({ backup_title: 'Attack on Titan' })), false, 'an older server sends no field');
  // The term belongs to the AUTOMATIC match. A hand-picked row that kept it (an older server never clears
  // it) read "Attack on Titan → Berserk of Gluttony · matched under its other name · picked by hand": a
  // line explaining a match that no longer exists, under a title a person chose. Reintroduce by dropping
  // the `c.decision === 'auto'` guard from matchedViaAlt: "a manual pick keeps the automatic match's
  // note" fails.
  assert.equal(matchedViaAlt(row({ backup_title: 'Attack on Titan', matched_via: 'Shingeki no Kyojin', decision: 'manual', match_title: 'Berserk of Gluttony' })), false, "a manual pick keeps the automatic match's note");
  assert.equal(matchedViaAlt(row({ backup_title: 'Attack on Titan', matched_via: 'Shingeki no Kyojin', decision: 'auto' })), true, 'the automatic match still says it');
});

test('the review row says when a title was found under its other name, and when an in-library row was linked', () => {
  // Reintroduce the first by deleting the `data-matched-via` line from ReviewRow: "the row does not say
  // it was matched under its other name" fails. Reintroduce the second by rendering the plain "Already in
  // your library" for every in_library row: "a linked row reads like an unlinked one" fails -- and an admin
  // who already holds most of their list sees "0 added · N already had" with no sign that those N now sync.
  const src = code(read('app/admin/import/page.tsx'));
  assert.match(src, /\{matched && matchedViaAlt\(c\) && \([\s\S]{0,160}data-matched-via>\{tr\('matched under its other name'\)\}/, 'the row does not say it was matched under its other name');
  assert.match(src, /c\.in_library && c\.linked \? tr\('Already in your library — linked for progress sync'\) : c\.in_library \? tr\('Already in your library'\) : tr\('Skipped'\)/, 'a linked row reads like an unlinked one');
});

test('a tracker batch is named after its tracker in Open imports', () => {
  // Reintroduce by returning `Pasted titles` for the `tracker` origin (dropping the case): "AniList" fails.
  assert.equal(batchOriginLabel('tracker', 'anilist'), 'AniList list', 'AniList');
  assert.equal(batchOriginLabel('tracker', 'myanimelist'), 'MyAnimeList list', 'MyAnimeList');
  assert.equal(batchOriginLabel('tracker', 'kitsu'), 'Kitsu list', 'Kitsu');
  assert.equal(batchOriginLabel('tracker', null), 'Tracker list', 'a tracker the web does not know keeps a generic label');
  assert.equal(batchOriginLabel('paste'), 'Pasted titles', 'the other origins are unchanged');
  assert.equal(batchOriginLabel('backup', 'anilist'), 'Backup file', 'a tracker on a non-tracker origin is ignored');
  // The call site passes the batch's tracker, or the label can never be anything but generic.
  assert.match(code(read('app/admin/import/page.tsx')), /batchOriginLabel\(b\.origin, b\.tracker\)/, 'OpenImports does not pass the tracker');
});

test('every count on the tracker intake and the done step has a hand-written singular', () => {
  // The i18n layer has no plural rules, so "1 novels skipped", "Checking 1 sources…" and "Followed 1 of
  // 1 sources" are exactly what a count key without a one-form prints. Reintroduce by deleting any of the
  // singular keys from es.json, or by rendering the plural key for n === 1 in the page or the dialog.
  const singulars = ['1 novel skipped', 'Checking this source…', 'Followed the other source', 'Not followed'];
  const plurals = ['{n} novels skipped', 'Checking {n} sources — this can take a minute. You can close this; anything followed shows under Sources & translations.', 'Followed {n} of {m}'];
  assert.deepEqual(missingIn('es.json', [...singulars, ...plurals]), [], 'a count key is missing from es.json');
  const page = code(read('app/admin/import/page.tsx'));
  assert.match(page, /n\.skippedNovels === 1 \? tr\('1 novel skipped'\) : tr\('\{n\} novels skipped', \{ n: n\.skippedNovels \}\)/, 'the novels line has no singular');
  const dlg = code(read('components/AddSeriesDialog.tsx'));
  assert.match(dlg, /sentFollow === 1\s*\? tr\('Checking this source…'\)/, 'the checking line has no singular');
  assert.match(dlg, /m === 1\s*\? \(followed === 1 \? tr\('Followed the other source'\) : tr\('Not followed'\)\)\s*: tr\('Followed \{n\} of \{m\}', \{ n: followed, m \}\)/, 'the summary has no singular');
});

test('the tracker intake is a nested box, and the intake card still ends on its one accent button', () => {
  // The card's shape is "entrances, one accent button": backup and MangaDex start on a small control, the
  // paste box uses the accent button. A fourth block with its own full-width accent button made two
  // primary CTAs on one 390-px card. Reintroduce by giving Load list the `btn-accent` class, or by adding a
  // `btn-accent` anywhere in TrackerIntake / IntakeCard: "the intake card has more than one accent button" fails.
  const src = code(read('app/admin/import/page.tsx'));
  const from = src.indexOf('function TrackerIntake(');
  const to = src.indexOf('function noteText(');
  assert.ok(from > 0 && to > from, 'TrackerIntake / IntakeCard are not where this test looks');
  const intake = src.slice(from, to);
  assert.equal((intake.match(/btn-accent/g) || []).length, 1, 'the intake card has more than one accent button');
  assert.match(intake, /className="btn-ghost ms-auto px-3 py-1 text-xs disabled:opacity-50">\s*\{starting \? tr\('Starting…'\) : tr\('Load list'\)\}/, 'Load list is not a ghost control');
  // The same box style as Open imports, rendered between that list and the eyebrow.
  assert.match(intake, /<div className="mb-4 rounded-xl border border-ink-700 bg-ink-900\/50 p-2\.5" data-tracker-intake>/, 'the tracker intake is not the nested box');
  assert.match(intake, /<OpenImports batches=\{open\} onOpen=\{onOpen\} \/>\s*<TrackerIntake starting=\{starting\} onStart=\{onTracker\} \/>\s*<p className="mb-2 text-xs font-semibold uppercase tracking-wider text-fog-500">\{tr\('Bring your library over'\)\}<\/p>/, 'the box is not between Open imports and the eyebrow');
  // Not connected: one dim line that lands ON the Progress tracking card (tab + card, see the profile test).
  assert.match(intake, /<Link href="\/profile\/\?tab=Connections&card=tracking"[^>]*>\s*\{NOT_CONNECTED\(\)\}/, 'the not-connected line does not point at the tracking card');
  // Reading + Plan to read on by default; "Finished" is the read-state word, never the series status "Completed".
  assert.match(src, /const LIST_STATUS_LABELS = keys\('Reading', 'Plan to read', 'Finished', 'On hold', 'Dropped'\);/, 'the list buckets are not declared through keys()');
  assert.match(src, /\{ id: 'reading', label: LIST_STATUS_LABELS\[0\], on: true \},\s*\{ id: 'plan_to_read', label: LIST_STATUS_LABELS\[1\], on: true \},\s*\{ id: 'completed', label: LIST_STATUS_LABELS\[2\], on: false \}/, 'Reading and Plan to read are not the defaults, or completed is not labelled Finished');
  assert.doesNotMatch(src, /keys\([^)]*'Completed'/, '"Completed" (the series status) is used for the read state');
  // The body the server takes, and the three refusals in the person's words.
  assert.match(src, /start\(\{ origin: 'tracker', tracker, statuses \}\)/, 'Load list does not post the tracker body');
  assert.match(src, /body\.error === 'tracker_rejected'\) toast\(tr\('The tracker rejected the saved token — reconnect it under Profile'\), 'error'\)/, 'tracker_rejected has no sentence');
  assert.match(src, /body\.error === 'tracker_unavailable'\) toast\(tr\('Could not read your list right now'\), 'error'\)/, 'tracker_unavailable has no sentence');
  assert.match(src, /body\.error === 'not_connected'\) \{ qc\.invalidateQueries\(\{ queryKey: \['trackers'\] \}\); toast\(NOT_CONNECTED\(\), 'info'\); \}/, 'not_connected does not fall back to the dim line');
});

test('the profile page opens the tab named in ?tab=, under Suspense', () => {
  // `useSearchParams` needs a Suspense boundary in a static export (the build fails without one), and the
  // import page's tracker line points at `/profile/?tab=Connections` -- without this the link landed on
  // You, a tab away from Progress tracking. Since v0.39.0 the tab comes from `useTabParam` (lib/useTabParam.ts),
  // which reads the query ONCE in a lazy `useState` and never in an effect: an effect re-reading the params
  // would snap a person back to the URL's tab on the render after they tapped the rail. Reintroduce by
  // initialising `tab` with `useState<Tab>('You')` again: "the tab is not read from the query" fails; by
  // adding a `useEffect` to the hook that re-reads `params`: "the hook re-reads the query in an effect"
  // fails; or by dropping the Suspense wrapper: "no Suspense boundary" fails.
  const src = code(read('app/profile/page.tsx'));
  assert.match(src, /<Suspense fallback=\{<div className="min-h-screen-d" \/>\}>\s*<ProfileInner \/>\s*<\/Suspense>/, 'no Suspense boundary');
  assert.match(src, /const PROFILE_TABS = PROFILE_GROUPS\[0\]\.tabs;/, 'the tab list is not the first group\'s tabs');
  assert.match(src, /const \[tab, setTab\] = useTabParam<Tab>\(PROFILE_TABS, 'You'\);/, 'the tab is not read from the query');
  const hook = code(read('lib/useTabParam.ts'));
  assert.match(hook, /useState<T>\(\(\) => readTab\(params\.get\('tab'\), tabs, fallback\)\)/, 'the hook does not read the query once, lazily');
  assert.doesNotMatch(hook, /useEffect\(/, 'the hook re-reads the query in an effect');
  // The pure half, called: an arbitrary ?tab= value falls back rather than rendering an empty panel.
  assert.equal(readTab('Bogus', ['You', 'Settings'], 'You'), 'You', 'an arbitrary ?tab= value is not rejected');
  assert.equal(readTab('Settings', ['You', 'Settings'], 'You'), 'Settings', 'a real tab is not honoured');
  assert.equal(readTab(null, ['You', 'Settings'], 'You'), 'You', 'no ?tab= does not fall back');
});

test('the pointer lands ON the Progress tracking card: ?card=tracking scrolls it into view once the trackers are known', () => {
  // With `?tab=Reading` alone the tab opened and the card sat at document y≈1237 at 390×844 -- 400 px
  // below the fold, under the hero, the rail and four other cards -- so the "connect one under Profile"
  // line landed the person on a screen with no Progress tracking on it. The card is scrolled to after the
  // trackers query settles (it is null before that, and its height depends on the answer), once per
  // arrival, instantly under reduced motion, with a scroll margin for the sticky desktop bar.
  // Since v0.39.0 the card is the Progress tracking section of the Connections tab, in
  // components/ProfileConnections.tsx; the page hands it `focusTracking` and the section does the scroll.
  // Reintroduce by dropping the `focusTracking` prop from the ProfileConnections call: "the Connections
  // tab does not hand the section its focus" fails; by removing the `useEffect` in TrackerSection: "the
  // section never scrolls itself into view" fails; by scrolling before `isPending` is false: "the scroll
  // does not wait for the trackers" fails.
  const src = code(read('app/profile/page.tsx'));
  assert.match(src, /const \[focusTracking\] = useState<boolean>\(\(\) => params\.get\('card'\) === 'tracking'\);/, 'card=tracking is not read from the query');
  assert.match(src, /<ProfileConnections focusTracking=\{focusTracking && tab === 'Connections'\} \/>/, 'the Connections tab does not hand the section its focus');
  const conn = code(read('components/ProfileConnections.tsx'));
  const from = conn.indexOf('function TrackerSection(');
  const to = conn.indexOf('function TrackerRow(');
  assert.ok(from > 0 && to > from, 'TrackerSection / TrackerRow are not where this test looks');
  const card = conn.slice(from, to);
  assert.match(card, /useEffect\(\(\) => \{\s*if \(!focus \|\| isPending \|\| scrolled\.current \|\| !ref\.current\) return;\s*scrolled\.current = true;\s*ref\.current\.scrollIntoView\(\{ block: 'start', behavior: still \? 'auto' : 'smooth' \}\);\s*\}, \[focus, isPending, still\]\);/, 'the section never scrolls itself into view, or does not wait for the trackers, or ignores reduced motion');
  assert.match(card, /<Section ref=\{ref\} id="progress-tracking" className="scroll-mt-4 lg:scroll-mt-20" title=\{tr\('Progress tracking'\)\}/, 'the section has no id or no scroll margin for the sticky desktop bar');
  // The import page sends people there with both halves of the query.
  assert.match(code(read('app/admin/import/page.tsx')), /href="\/profile\/\?tab=Connections&card=tracking"/, 'the import page does not point at the card');
});

test('an all-owned tracker batch says what it did: the done card counts and names the rows linked for progress sync', () => {
  // Tracker rows the library already holds are written `already` at intake and linked on the spot, so a
  // batch of nothing but those closes to `done` on its first read and the review row's sentence is never
  // seen: "Done — 0 added · 5 already had · 0 failed" with five dotted titles, and the words "linked" /
  // "progress sync" nowhere -- exactly the "looks like nothing happened" outcome for an established
  // library connecting its tracker. Reintroduce by returning 0 from linkedCount: "an all-owned batch counts
  // its linked rows" fails; by returning null from linkedLine: "the count has no line" fails; by rendering
  // the plain truncated title for every row: "a linked row reads like an unlinked one on the done card"
  // fails; by dropping `<Note note={linked} />`: "the done headline does not carry the count" fails.
  const owned = (i: number, over: Partial<ImportCandidate> = {}) => row({ id: `c${i}`, backup_title: `Title ${i}`, in_library: true, decision: 'skip', confidence: null, match_source: null, match_source_id: null, match_title: null, status: 'already', linked: true, tracker: 'anilist', external_id: String(i), ...over });
  const all = [0, 1, 2, 3, 4].map((i) => owned(i));
  assert.equal(linkedCount(all), 5, 'an all-owned batch counts its linked rows');
  assert.equal(linkedCount([owned(0, { linked: false }), owned(1, { linked: null }), owned(2, { status: 'added', linked: true }), owned(3)]), 1, 'only rows that are both already-had and linked count');
  assert.equal(linkedCount([row({ status: 'already' })]), 0, 'a backup batch (no `linked` field) counts nothing');
  assert.match(linkedLine(5)!, /^5 linked for progress sync$/, 'the count has no line');
  assert.equal(linkedLine(1), '1 linked for progress sync', 'the singular is not hand-written');
  assert.equal(linkedLine(0), null, 'zero linked rows print a line');
  const src = code(read('app/admin/import/page.tsx'));
  const card = src.slice(src.indexOf('function RunCard('), src.indexOf('function ImportWizardInner('));
  assert.match(card, /const linked = batch\.state === 'done' \? linkedLine\(linkedCount\(items\)\) : null;/, 'the done card does not count the linked rows over the batch');
  assert.match(card, /tr\('Done — \{added\} added · \{already\} already had · \{failed\} failed'[^\n]*\n\s*<Note note=\{linked\} \/>/, 'the done headline does not carry the count');
  assert.match(card, /\{c\.status === 'already' && c\.linked \? \([\s\S]{0,400}data-linked-row>\s*\{c\.backup_title\} <span className="text-fog-500">— \{tr\('linked for progress sync'\)\}<\/span>/, 'a linked row reads like an unlinked one on the done card');
  assert.deepEqual(missingIn('es.json', ['1 linked for progress sync', '{n} linked for progress sync', 'linked for progress sync']), [], 'a linked key is missing from es.json');
});

test('the Discover strip tells the truth about a carrier card: a nothing-yet add that checked other sources never reads "Fetched"', () => {
  // A "Nothing yet" add with candidates leaves a job with `total: 0, status: 'done'` and the judgement on
  // it; the strip rendered every non-downloading, non-error card as "Fetched" in emerald, so the series a
  // person had just declined to fetch read as fetched for five minutes -- from the moment of the add, while
  // the check was still running. Reintroduce by deleting the `j.total === 0 && j.autoFollow` branch: "a
  // carrier card reads Fetched" fails; by rendering one sentence for both states: "the running check reads
  // as finished" fails.
  const src = code(read('app/discover/page.tsx'));
  assert.match(src, /\) : j\.total === 0 && j\.autoFollow \? \(\s*<p className="mt-1 text-\[11px\] text-fog-500">\{j\.autoFollow\.done \? tr\('Checked other sources'\) : tr\('Checking other sources…'\)\}<\/p>\s*\) : \(\s*<p className="mt-1 text-\[11px\] text-emerald-400">\{tr\('Fetched'\)\}<\/p>/, 'a carrier card reads Fetched, or the running check reads as finished');
  assert.match(src, /autoFollow\?: AutoFollow;/, "the strip's Job does not know the judgement");
  for (const f of localeFiles()) assert.deepEqual(missingIn(f, ['Checking other sources…', 'Checked other sources']), [], `${f} lacks a strip key`);
});

test('the switch is for admins: a member sees no "also check" switch, sends no alsoFollow, and is told who can', () => {
  // The manual follow route and the sheet's × are admin-only, so a member who was shown the switch could
  // follow two sources and never undo them; the doc said "(admins)" and the code did not. Discover passes
  // `isAdmin`; without `mayFollow` the switch is not rendered, `alsoFollow` stays undefined whatever the
  // device remembers, and the done step shows neither results nor "None of the other sources…" but one
  // dim line naming who can. Reintroduce by passing `mayFollow` for the switch but not for the body:
  // "a member's add still carries alsoFollow" fails; by dropping the `!mayFollow` line: "a member is not
  // told who can follow" fails; by passing `true` from Discover: "Discover does not pass isAdmin" fails.
  const src = code(read('components/AddSeriesDialog.tsx'));
  assert.match(src, /mayFollow: boolean;/, 'the dialog has no mayFollow prop');
  assert.match(src, /const alsoFollowBody = mayFollow && alsoFollow && others\.length \?/, "a member's add still carries alsoFollow");
  assert.match(src, /\{mayFollow && others\.length > 0 && \(\s*<div className="mt-3" data-also-follow>/, 'the switch renders for a member');
  const block = src.slice(src.indexOf('const followBlock = (() => {'), src.indexOf('if (others.length === 0) return'));
  assert.match(block, /if \(!mayFollow\) return <p[^>]*>\{tr\('Other sources: an admin can follow them from Sources & translations\.'\)\}<\/p>;/, 'a member is not told who can follow');
  assert.match(code(read('app/discover/page.tsx')), /<AddSeriesDialog\s+seed=\{seed\}\s+sources=\{budgetIds\}\s+mayFollow=\{isAdmin\}/, 'Discover does not pass isAdmin');
  for (const f of localeFiles()) assert.deepEqual(missingIn(f, ['Other sources: an admin can follow them from Sources & translations.']), [], `${f} lacks the member line`);
});

test('the intake note comes from the batch row, so a reload or an Open-imports tap keeps it', () => {
  // The note lived only in the tab that started the intake: reopen the batch and "Matching your titles…" /
  // "Done — …" carried no novel count and no 500 hint, while the CHANGELOG said the done line counts them.
  // GET /batches/:id now returns `skippedNovels` and `truncated` on the batch; the page reads them there and
  // uses the intake's answer only until the first GET (and on an older server). Reintroduce by reading
  // `noteText(intakeNote)` alone: "the note is read from page state, not the batch" fails.
  const src = code(read('app/admin/import/page.tsx'));
  assert.match(src, /const note = noteText\(batch\s*\? \{ skippedNovels: batch\.skippedNovels \?\? intakeNote\?\.skippedNovels \?\? 0, truncated: batch\.truncated \?\? intakeNote\?\.truncated \?\? false \}\s*: null\);/, 'the note is read from page state, not the batch');
  assert.match(read('lib/importBatch.ts'), /skippedNovels\?: number;\s*truncated\?: boolean;/, 'ImportBatch does not type the fields');
});

test('the five list checkboxes are thumb-sized rows', () => {
  // Measured at 390: the label rows were 16 px tall around a 14 px box, on the one new phone control,
  // while every chip on the page is ≥ 26 px. `min-h-7 py-1` makes the tap area 28 px without changing the
  // box. Reintroduce by dropping `min-h-7` or `py-1` from the label: this fails.
  const src = code(read('app/admin/import/page.tsx'));
  assert.match(src, /<label key=\{s\.id\} className="inline-flex min-h-7 items-center gap-1\.5 py-1 text-xs text-fog-300">/, 'the list checkboxes are not thumb-sized');
});

test('the add dialog offers the other sources only when it already holds a list, sends at most six, and never for a wall tap', () => {
  // A `result` seed (a single-source Discover-wall tile) has no provider list; a switch there would need a
  // search per registered source on every wall tap -- the one fan-out the plan forbids. The candidates are
  // what the dialog already found, one per source, the picked one left out, capped at six. Reintroduce by
  // seeding `others` from `/api/sources/find` for a result seed ("a result seed sends candidates" fails), by
  // dropping the `.slice(0, ALSO_FOLLOW_MAX)` ("more than six can ride" fails), or by sending `alsoFollow`
  // whatever the switch says ("alsoFollow rides with the switch off" fails).
  const src = code(read('components/AddSeriesDialog.tsx'));
  assert.match(src, /const ALSO_FOLLOW_MAX = 6;/, 'the cap is not six');
  const memo = src.slice(src.indexOf('const others = useMemo('), src.indexOf('}, [providers, picked]);'));
  assert.match(memo, /if \(!picked \|\| !providers\) return \[\];/, 'a result seed sends candidates (providers is null there)');
  assert.match(memo, /if \(seen\.has\(p\.source\)\) continue;/, 'the picked source, or a source twice, can be a candidate');
  assert.match(memo, /return out\.slice\(0, ALSO_FOLLOW_MAX\);/, 'more than six can ride');
  assert.doesNotMatch(memo, /api</, 'others is fetched rather than taken from the list the dialog already has');
  assert.match(src, /useState<Provider\[\] \| null>\(seed\.kind === 'group' \? seed\.providers : null\)/, 'providers is no longer null for a result seed');
  assert.match(src, /const alsoFollowBody = mayFollow && alsoFollow && others\.length \? others\.map\(\(\{ source, sourceId \}\) => \(\{ source, sourceId \}\)\) : undefined;/, 'alsoFollow rides with the switch off, or carries more than the identity');
  assert.match(src, /json: \{ source: picked\.source, sourceId: picked\.sourceId, chapterCount, chapterFrom, autoUpdate, force, alsoFollow: alsoFollowBody \}/, 'the add body does not carry alsoFollow');
  // The switch is on the options step only with candidates, remembered per device under one key.
  assert.match(src, /\{mayFollow && others\.length > 0 && \(\s*<div className="mt-3" data-also-follow>/, 'the switch shows without candidates');
  assert.match(src, /const ALSO_FOLLOW_KEY = 'uchiyomi\.alsoFollow';/, 'the per-device key changed');
  assert.match(src, /localStorage\.setItem\(ALSO_FOLLOW_KEY, v \? '1' : '0'\)/, 'the switch is not remembered');
  // The done step: results from the job card the dialog already polls; a result seed points at Find missing.
  assert.match(src, /if \(seed\.kind === 'result'\) return <p[^>]*>\{tr\('Other sources: Find missing chapters on the series page\.'\)\}<\/p>;/, 'a result seed is not pointed at Find missing chapters');
  assert.match(src, /if \(others\.length === 0\) return <p[^>]*>\{tr\('None of the other sources checked lists this title\.'\)\}<\/p>;/, 'zero others does not say "checked"');
  assert.doesNotMatch(src, /No other source carries this title/, 'the false verdict is back');
  assert.match(src, /enabled: !!done && \(!done\.nothing \|\| sentFollow > 0\)/, 'a nothing-yet add with candidates does not poll for its results');
  assert.match(src, /return j\?\.autoFollow\?\.done \? false : 2000;/, 'the nothing-yet poll never stops');
  // Every reason the server can give is a sentence; an unknown one stays visible as its code.
  for (const why of ['numbering_differs', 'title_differs', 'unreachable', 'too_few_listed', 'not_tried', 'cap', 'unavailable']) {
    assert.match(src, new RegExp(`case '${why}': return tr\\('[^']+'\\);`), `${why} has no sentence`);
  }
  assert.match(src, /function autoFollowWhy[\s\S]{0,900}default: return why;/, 'an unknown reason is swallowed');
});

test('the sources sheet marks an automatic follower in its one chip, not as a third span', () => {
  // At 390 px the name line is ~316 px: "also checked" + "followed automatically" + × left ~90 px for the
  // name, so "MangaKakalot" truncated on exactly the row whose name you read before pressing ×.
  // Reintroduce by adding a `{s.auto && <span …>}` beside the chip: "a third span is back" fails.
  const src = code(read('components/SourcesSheet.tsx'));
  const rowSrc = src.slice(src.indexOf('function SourceRow('), src.indexOf('function GroupRow('));
  assert.match(rowSrc, /<span className="chip shrink-0 px-2 py-0\.5 text-\[10px\]">\{s\.primary \? tr\('main'\) : s\.auto \? tr\('followed for you'\) : tr\('also checked'\)\}<\/span>/, 'the chip does not carry "followed for you"');
  assert.doesNotMatch(rowSrc, /s\.auto && <span/, 'a third span is back');
  assert.match(rowSrc, /aria-label=\{tr\('Stop following \{s\}', \{ s: s\.name \}\)\}/, 'the × label changed');
  assert.match(read('lib/types.ts'), /auto\?: boolean;/, 'SeriesSource has no `auto`');
});

test('every string the add dialog and the sources sheet render is in all eight locale files', () => {
  // The same net as the import screens', over the two components v0.36.0 added strings to. Reintroduce by
  // deleting "followed for you" or any dialog sentence from one locale file.
  const keys = trKeys(['components/AddSeriesDialog.tsx', 'components/SourcesSheet.tsx']);
  assert.ok(keys.size >= 90, `only ${keys.size} tr() keys found in the dialog and the sheet — the extractor lost them`);
  for (const f of localeFiles()) {
    const missing = missingIn(f, keys);
    assert.deepEqual(missing, [], `${f} is missing ${missing.length} dialog/sheet keys, e.g. ${missing.slice(0, 3).join(' | ')}`);
  }
});

test('the i18n rig leak word for the tracker box is a sentence word, not the eyebrow', () => {
  // The eyebrow is uppercased by CSS and innerText reports text as rendered, so `\bFrom your tracker\b`
  // could never match and the check would cover nothing new. Reintroduce by swapping the word for
  // 'From your tracker'.
  const rig = read('test/e2e/i18n.mjs');
  assert.match(rig, /\['\/admin\/import', \[[^\]]*'bring your list over'/, 'the rig does not look for the tracker line');
  assert.doesNotMatch(rig, /\['\/admin\/import', \[[^\]]*'From your tracker'/, 'the rig looks for the eyebrow');
});

test('the i18n rig visits the v0.39.0 consoles by their ?tab= address and looks for words that really translate', () => {
  // The rig's tab-row check only ever saw each console's first tab, so the rebuilt admin Settings tab and
  // the profile's Settings tab are visited by URL. And every word it looks for must have an es/de/fr
  // translation that differs from the English: "Badges" is "Badges" in French, so with it in the list a
  // correctly translated /profile counted one leak before a single real one -- and the profile tab row
  // no longer says "Reading" at all, so a rig still looking for it would be measuring nothing there.
  // Reintroduce by putting 'Badges' or 'Reading' back in the /profile list, or by dropping the
  // `?tab=Settings` entries.
  const rig = read('test/e2e/i18n.mjs');
  assert.match(rig, /\['\/profile', \['Connections', 'Account', 'Settings', 'Reading studio', 'Lists', 'Sign out'\]\]/, 'the /profile word list is not the v0.39.0 one');
  assert.doesNotMatch(rig, /\['\/profile', \[[^\]]*'(?:Badges|Reading|Moments)'/, 'the /profile list has a word that is the same in French, or the retired Reading tab');
  assert.match(rig, /\['\/profile\/\?tab=Settings', \[[^\]]*'Repeated pages'/, 'the rig does not visit the profile Settings tab');
  assert.match(rig, /\['\/admin\/\?tab=Settings', \[[^\]]*'Backup time'/, 'the rig does not visit the admin Settings tab');
  // GroupChips renders its labels as CSS-uppercase eyebrows, so innerText reads DEFAULT PRIORITY and a
  // case-sensitive \bDefault priority\b can never match -- the same trap the import page's 'From your tracker'
  // eyebrow set (above). Reintroduce by listing 'Default priority' for /admin/?tab=Settings.
  assert.doesNotMatch(rig, /\['\/admin\/\?tab=Settings', \[[^\]]*'(?:Default priority|Blocked groups|Patience)/, 'the admin Settings list looks for an uppercase eyebrow');
  // The words the rig relies on for the profile are ones the locale files translate today (the other two
  // lists lean on strings other v0.39.0 builders add, which test 14 of settingsConsole.test.ts covers).
  for (const f of ['es.json', 'de.json', 'fr.json']) {
    const d = JSON.parse(read(`public/locales/${f}`));
    for (const w of ['Account', 'Settings', 'Reading studio', 'Lists', 'Sign out', 'Weekly goal', 'Language', 'Accent', 'Offline downloads']) {
      assert.ok(d[w] && d[w] !== w, `${f}: "${w}" is missing or the same as the English, so the rig would count it as a leak`);
    }
  }
});
