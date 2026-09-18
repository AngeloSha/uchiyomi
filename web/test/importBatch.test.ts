// The reviewable import (PR #52, v0.35.0): which rows the review screen flags, what the row shows, and the
// lifecycle the page wires up.
//
// The pure half (`lib/importBatch.ts`) is exercised directly, like wall.test.ts. The page half is read from
// source, like library.test.ts: whether Discard exists and calls DELETE, whether the matched title is on the
// row, whether Admin → Providers has one way in -- each a thing that shipped wrong or missing in the PR as
// reviewed, and each invisible to a type check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { needsAttention, containsDiverges, matchTitleDiffers, openBatches, runStatusLabel, runStatusColor, type ImportCandidate, type ImportBatchSummary } from '../lib/importBatch';

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

test('every string the import screens render is in all eight locale files', () => {
  // The PR touched no locale file: 62 of its 76 strings fell back to English in every other language, and
  // the parity test (library.test.ts) could not see it because it compares the files with each other, not
  // with the code. Reintroduce by deleting any one of these keys from es.json.
  const keys = new Set<string>();
  for (const f of ['app/admin/import/page.tsx', 'components/ImportMatchSheet.tsx', 'lib/importBatch.ts']) {
    const src = read(f);
    for (const m of src.matchAll(/\btr\(\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\'/g, "'"));
    for (const m of src.matchAll(/\btr\(\s*"((?:[^"\\]|\\.)*)"/g)) keys.add(m[1]);
  }
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
