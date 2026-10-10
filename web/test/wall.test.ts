// One card per work on the Discover wall.
//
// The wall is several sources' newest lists in arrival order, and a popular title is on most of them, so it
// sat there three or four times under slightly different spellings (issue #36 item 4) while search, which
// the server folds itself, showed it once. `lib/wall.ts` folds the wall the same way, in the client, after the
// flatten -- by normalised title until v0.56.0, by the server's `work` since, and without what the library holds.
// Arithmetic on a list, so it is exercised here with no browser, like sourcePicker.test.ts; the rendering half
// is the same SourceCard the search path already uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  applyWorks, foldByWork, followWorks, mergeGroups, shownOnWall, unknownWorks, workKey, type WallItem, type WorkNow,
} from '../lib/wall';
import { normTitle } from '../lib/normTitle';

const ROOT = join(__dirname, '..');

const names: Record<string, string> = { a: 'Source A', b: 'Source B', c: 'Source C' };
const nameOf = (id: string) => names[id];
const row = (p: WallItem): WallItem => p;
const none: ReadonlySet<string> = new Set();

test('from an older server, with no work, the same title on two sources is one card that knows both', () => {
  // The fallback: a server before v0.56.0 sends no `work`, and the fold keys on normTitle as it always did.
  // Reintroduce by keying the fold on `${it.source}:${it.sourceId}` instead of workKey(it) -- the key the
  // pre-fold dedupe already uses, and the obvious wrong one: "two cards for one title" fails first; by making
  // workKey `it.work ?? ''` (no fallback): the same.
  const { items, groups } = foldByWork([
    row({ source: 'a', sourceId: '1', title: 'Solo Leveling', inLibrary: false }),
    row({ source: 'b', sourceId: '7', title: 'Tower of God' }),
    // A different spelling -- punctuation and case -- is the same title, which is what normTitle is for.
    row({ source: 'b', sourceId: '2', title: 'SOLO LEVELING!', coverUrl: 'https://b/solo.jpg', inLibrary: true, librarySeriesId: 'ser-9' }),
  ], nameOf);

  assert.deepEqual(items.map((it) => it.title), ['Solo Leveling', 'Tower of God'], 'two cards for one title, or the first arrival lost its place');
  const [card] = items;
  assert.deepEqual([card.source, card.sourceId], ['a', '1'], 'the card did not keep the ids it arrived with');
  assert.equal(card.coverUrl, 'https://b/solo.jpg', 'the cover was not taken from the first row that had one');
  // v0.52.0: owned on ONE source no longer makes the card owned -- see "a title held in one language" below.
  assert.equal(card.inLibrary, false, 'a card is owned only when every provider is held');
  assert.equal(card.librarySeriesId, 'ser-9', 'the card lost the library entry it should open');

  const key = normTitle('Solo Leveling');
  assert.deepEqual(groups[key]?.map((p) => `${p.source}:${p.sourceId}`), ['a:1', 'b:2'], 'groups[key] does not hold both providers');
  assert.deepEqual(groups[key].map((p) => p.name), ['Source A', 'Source B'], 'provider names were not resolved through nameOf');
  assert.equal(groups[key][1].title, 'SOLO LEVELING!', 'a provider must carry the title as its own source spells it');
  // Every keyed card has a groups entry, as every search hit does, so open() treats the two the same.
  assert.equal(groups[normTitle('Tower of God')]?.length, 1, 'a single-source card has no groups entry');
});

test('a title held in one language folds with a provider in another to a card that is still addable', () => {
  // v0.52.0 (#72), p3t3t3's Blue Lock: the server says `inLibrary` per source, in that source's language, so the
  // English row is owned and the Spanish one is not. OR-ed, the card read "In library", opened the English series,
  // and the Spanish edition could not be added from Discover at all. Reintroduce by OR-ing `inLibrary` in
  // foldByWork: "an English item in the library and a Spanish one not in it fold to a card that is not owned" fails.
  const { items, groups } = foldByWork([
    row({ source: 'a', sourceId: '1', title: 'Blue Lock', lang: 'en', inLibrary: true, librarySeriesId: 'ser-en', libraryLangs: ['en'] }),
    row({ source: 'b', sourceId: '2', title: 'Blue Lock', lang: 'es-419', inLibrary: false, librarySeriesId: 'ser-en', libraryLangs: ['en'] }),
  ], nameOf);
  const [card] = items;
  assert.equal(card.inLibrary, false, 'an English item in the library and a Spanish one not in it fold to a card that is not owned');
  assert.deepEqual(card.libraryLangs, ['en'], 'the card does not say which language the library holds');
  assert.equal(card.librarySeriesId, 'ser-en', 'the card lost the entry its dialog opens');
  // The dialog marks each provider: the held one "in your library", the other as a new language.
  assert.deepEqual(groups[normTitle('Blue Lock')].map((p) => [p.source, p.lang, p.inLibrary]), [['a', 'en', true], ['b', 'es-419', false]]);
  // Held in every provider's language, it is owned.
  const both = foldByWork([
    row({ source: 'a', sourceId: '1', title: 'Blue Lock', inLibrary: true, libraryLangs: ['en'] }),
    row({ source: 'b', sourceId: '2', title: 'Blue Lock', inLibrary: true, libraryLangs: ['en', 'es-419'] }),
  ], nameOf).items[0];
  assert.equal(both.inLibrary, true, 'a card held in every provider\'s language is not owned');
  assert.deepEqual(both.libraryLangs, ['en', 'es-419'], 'the languages are not the union');
});

test("the providers of a folded card are in the page's order, not arrival order", () => {
  // The add dialog labels its first provider "preferred". The first source to ANSWER is the fastest one,
  // which is no reason to prefer it; the page ranks sources (budgetForMode) and search-all orders its
  // providers by that rank, so the fold does too. Reintroduce by dropping the sort after `providers.push`
  // in foldByWork: b arrived first and stays first, and "providers are not ranked" fails.
  const rank: Record<string, number> = { a: 0, b: 1 };
  const { groups } = foldByWork([
    row({ source: 'b', sourceId: '2', title: 'Solo Leveling' }),
    row({ source: 'a', sourceId: '1', title: 'Solo Leveling' }),
  ], nameOf, (id) => rank[id] ?? 99);
  assert.deepEqual(groups[normTitle('Solo Leveling')].map((p) => p.source), ['a', 'b'], 'providers are not ranked');
});

test('a source listing one title twice is still one place to add it from', () => {
  // Reintroduce by dropping the `providers.some((p) => p.source === it.source)` check: "one source listed as
  // two providers" fails, and the dialog would offer Source A as two rows (and its icon would sit there twice).
  const { items, groups } = foldByWork([
    row({ source: 'a', sourceId: '1', title: 'Omniscient Reader' }),
    row({ source: 'a', sourceId: '1-alt', title: 'Omniscient Reader' }),
  ], nameOf);
  assert.equal(items.length, 1, 'one title became two cards');
  assert.equal(groups[normTitle('Omniscient Reader')].length, 1, 'one source listed as two providers');
});

test('a row whose title normalises to nothing, and has no work, is passed through as it came', () => {
  // Reintroduce by removing the `if (!key)` early exit: every such row folds into one card keyed '' --
  // "two untitled rows were folded into each other" fails. Only an older server's rows get here: the server's
  // `work` is never empty (an unplaceable name is `s:<source>:<id>`, which never folds).
  const blank = row({ source: 'a', sourceId: '9', title: '???' });
  const other = row({ source: 'b', sourceId: '8', title: '!!!' });
  const { items, groups } = foldByWork([blank, other], nameOf);
  assert.equal(items.length, 2, 'two untitled rows were folded into each other');
  assert.equal(items[0], blank, 'the untitled row was copied rather than passed through');
  assert.deepEqual(Object.keys(groups), [], 'an empty key got a groups entry');
});

test('the fold never writes into the rows it was given', () => {
  // The rows are React state -- `byId` on the Discover page. A card that gains a provider is a new object:
  // reintroduce by assigning onto `card` in place (`Object.assign(card, { inLibrary: … })`) instead of building
  // `out[i]` anew: "the first row was mutated" fails, since the first arrival IS the row it came as.
  const first = row({ source: 'a', sourceId: '1', title: 'Solo Leveling', inLibrary: true, libraryLangs: ['en'] });
  const before = { ...first };
  foldByWork([first, row({ source: 'b', sourceId: '2', title: 'Solo Leveling', inLibrary: false, libraryLangs: ['es'] })], nameOf);
  assert.deepEqual(first, before, 'the first row was mutated');
});

// ---------------------------------------------------------------- v0.56.0: by work, and nothing you have

test('two titles the server says are one work are one card, under the first arrival\'s title', () => {
  // The owner's "a lot of the series are duplicates from different sources": one site calls it "Solo Leveling",
  // another "Na Honjaman Level Up", and normTitle could never tell. The server names the work; the fold keys on
  // it. Reintroduce by keying the fold on normTitle(it.title) again: "two titles of one work are two cards" fails.
  const { items, groups } = foldByWork([
    row({ source: 'a', sourceId: '1', title: 'Solo Leveling', work: 'al:105398' }),
    row({ source: 'b', sourceId: '7', title: 'Tower of God', work: 'al:85143' }),
    row({ source: 'c', sourceId: '2', title: 'Na Honjaman Level Up', work: 'al:105398', coverUrl: 'https://c/solo.jpg' }),
  ], nameOf);
  assert.deepEqual(items.map((it) => it.title), ['Solo Leveling', 'Tower of God'], 'two titles of one work are two cards');
  assert.deepEqual(groups['al:105398'].map((p) => [p.source, p.title]), [['a', 'Solo Leveling'], ['c', 'Na Honjaman Level Up']],
    'the card does not hold both providers, each with its own title');
  assert.equal(items[0].coverUrl, 'https://c/solo.jpg', 'the cover was not taken from the first row that had one');
  assert.equal(workKey(items[0]), 'al:105398');
});

test('two works never fold, whatever their titles', () => {
  // One title, two works: a novel and its manhwa, or two series that happen to share a name. normTitle would
  // fold them; the work keeps them apart. Same reintroduction as above: "two works became one card" fails.
  const { items } = foldByWork([
    row({ source: 'a', sourceId: '1', title: 'The Beginning After the End', work: 'al:1' }),
    row({ source: 'b', sourceId: '2', title: 'The Beginning After The End', work: 'mu:2' }),
    row({ source: 'c', sourceId: '3', title: 'the beginning after the end', work: 'n:beginningaftertheend' }),
  ], nameOf);
  assert.equal(items.length, 3, 'two works became one card');
});

test('the wall shows nothing the library holds, in any language, and nothing added on this visit', () => {
  // The owner's call (v0.56.0): "why would I want to see stuff in Discover that I already have". `owned` is the
  // work held in any language -- unlike `inLibrary`, which is per language and keeps a new edition addable --
  // and the wall leaves those out; search keeps them (mergeGroups below drops nothing). Reintroduce by dropping
  // the `shownOnWall` line in foldByWork: "an owned row is on the wall" fails; by keying `added` on the title:
  // "a card added on this visit is still on the wall" fails.
  const owned = row({ source: 'a', sourceId: '1', title: 'Blue Lock', work: 'lib:ser-1', owned: true, libraryLangs: ['en'] });
  const spanish = row({ source: 'b', sourceId: '2', title: 'Blue Lock', work: 'lib:ser-1', owned: true, lang: 'es-419' });
  const fresh = row({ source: 'a', sourceId: '3', title: 'Lookism', work: 'al:3' });
  const addedNow = row({ source: 'c', sourceId: '4', title: 'Eleceed', work: 'al:4' });
  const { items, groups } = foldByWork([owned, spanish, fresh, addedNow], nameOf, undefined, new Set(['al:4']));
  assert.deepEqual(items.map((it) => it.title).filter((t) => t === 'Blue Lock'), [], 'an owned row is on the wall');
  assert.ok(!items.some((it) => it.title === 'Eleceed'), 'a card added on this visit is still on the wall');
  assert.deepEqual(items.map((it) => it.title), ['Lookism']);
  assert.equal(groups['lib:ser-1'], undefined, 'an owned work kept a provider list');
  assert.equal(shownOnWall(fresh, none), true);
  assert.equal(shownOnWall(owned, none), false);
  // An older server sends no `owned`: nothing is hidden for it, and `added` still works by title.
  assert.equal(shownOnWall(row({ source: 'a', sourceId: '1', title: 'Solo Leveling' }), new Set([normTitle('Solo Leveling')])), false);
  assert.equal(shownOnWall(row({ source: 'a', sourceId: '1', title: 'Solo Leveling' }), none), true);
});

test('a name the server places later joins the card its work already has (applyWorks)', () => {
  // Live re-keying: the server answered `n:…` for a name it had not placed, looked it up in the background, and
  // GET /api/discover/works now says it is al:105398 -- which another source's row already is. Laid over the rows,
  // the answer folds the two. Reintroduce by returning `it` unchanged from applyWorks: "a placed name did not join
  // its work's card" fails.
  const rows = [
    row({ source: 'a', sourceId: '1', title: 'Solo Leveling', work: 'al:105398' }),
    row({ source: 'b', sourceId: '2', title: 'Na Honjaman Level Up', work: 'n:nahonjamanlevelup' }),
    row({ source: 'c', sourceId: '3', title: 'Unknown Title', work: 'n:unknowntitle' }),
  ];
  const works: Record<string, WorkNow> = {
    'n:nahonjamanlevelup': { work: 'al:105398', owned: false },
    // Still looking: answered as itself.
    'n:unknowntitle': { work: 'n:unknowntitle', owned: false },
  };
  const now = applyWorks(rows, works);
  const { items, groups } = foldByWork(now, nameOf);
  assert.deepEqual(items.map((it) => it.title), ['Solo Leveling', 'Unknown Title'], 'a placed name did not join its work\'s card');
  assert.deepEqual(groups['al:105398'].map((p) => p.source), ['a', 'b']);
  // Only what changed is new; the rest are the very rows, and none is written into.
  assert.equal(now[0], rows[0], 'a row with no new answer was copied');
  assert.equal(now[2], rows[2], 'a row answered as itself was copied');
  assert.notEqual(now[1], rows[1]);
  assert.equal(rows[1].work, 'n:nahonjamanlevelup', 'applyWorks wrote into the row');
});

test('a name the server places as one the library holds leaves the wall (applyWorks)', () => {
  // The other half of re-keying: the name was the library's own series under another title. `lib:` and owned,
  // so the wall drops it without a reload. Reintroduce by copying only `work` in applyWorks (not `owned`): "a
  // name placed as owned is still on the wall" fails.
  const rows = [
    row({ source: 'a', sourceId: '1', title: 'Lookism', work: 'al:3' }),
    row({ source: 'b', sourceId: '2', title: 'Oejimo', work: 'n:oejimo' }),
  ];
  const { items } = foldByWork(applyWorks(rows, { 'n:oejimo': { work: 'lib:ser-7', owned: true } }), nameOf);
  assert.deepEqual(items.map((it) => it.title), ['Lookism'], 'a name placed as owned is still on the wall');
  // And a card added while it was still `n:` stays added once it is placed (followWorks): reintroduce by keying
  // the page's sets on `added` itself, and a card added as n:x comes back as al:9.
  const added = followWorks(new Set(['n:x']), { 'n:x': { work: 'al:9', owned: false } });
  assert.ok(added.has('al:9') && added.has('n:x'), 'an added card does not follow its work');
  assert.equal(foldByWork(applyWorks([row({ source: 'a', sourceId: '1', title: 'X', work: 'n:x' })], { 'n:x': { work: 'al:9', owned: false } }), nameOf, undefined, added).items.length, 0,
    'a card added as n:x came back once it was placed');
});

test('the page asks about each unplaced name once, and nothing else', () => {
  // unknownWorks feeds GET /api/discover/works: only `n:` keys -- `lib:`, `al:`, `mu:`, `md:` and `s:` are placed
  // for good -- and each once. Reintroduce by dropping the startsWith filter: "a placed work is asked about" fails.
  const keys = unknownWorks([
    { work: 'n:a' }, { work: 'al:1' }, { work: 'n:a' }, { work: 'lib:s1' }, { work: 's:aqua:9' }, {}, { work: 'n:b' },
  ]);
  assert.deepEqual(keys, ['n:a', 'n:b'], 'a placed work is asked about, or one is asked twice');
});

test('search keeps what you have, and merges two groups the server places as one work (mergeGroups)', () => {
  // Search shows owned works, with the "In library" ribbon (the owner's call), so nothing is dropped. And when a
  // re-keyed name makes two groups one work, they merge as the wall's fold merges: first keeps its place, title
  // and cover; one provider per source; held only when both are; 18+ when either is. Reintroduce by returning
  // `groups` unchanged: "two groups of one work are two cards" fails; by OR-ing inLibrary: "held in one language
  // only reads as held" fails.
  type G = Parameters<typeof mergeGroups>[0][number];
  const g = (p: Partial<G> & { title: string; providers: Array<{ source: string }> }): G => p as G;
  const merged = mergeGroups([
    g({ title: 'Solo Leveling', work: 'al:1', inLibrary: true, libraryLangs: ['en'], librarySeriesId: 'ser-1', owned: true, providers: [{ source: 'a' }] }),
    g({ title: 'Lookism', work: 'al:3', providers: [{ source: 'b' }] }),
    g({ title: 'Na Honjaman Level Up', work: 'al:1', inLibrary: false, coverUrl: 'https://c/x.jpg', rating: 'adult', providers: [{ source: 'a' }, { source: 'c' }] }),
  ]);
  assert.deepEqual(merged.map((x) => x.title), ['Solo Leveling', 'Lookism'], 'two groups of one work are two cards');
  const [solo] = merged;
  assert.deepEqual(solo.providers.map((p) => p.source), ['a', 'c'], 'the providers are not one per source');
  assert.equal(solo.inLibrary, false, 'held in one language only reads as held');
  assert.equal(solo.owned, true, 'an owned group lost its owned');
  assert.equal(solo.librarySeriesId, 'ser-1');
  assert.equal(solo.coverUrl, 'https://c/x.jpg');
  assert.equal(solo.rating, 'adult', 'an 18+ provider did not make the card 18+');
  // An older server's groups (no work) merge by title, as its groups already were.
  assert.equal(mergeGroups([g({ title: 'A', providers: [{ source: 'a' }] }), g({ title: 'a!', providers: [{ source: 'b' }] })]).length, 1);
});

test("normTitle is the server's norm, character for character", () => {
  // The server's inLibrary check and search grouping, and the client's fold and "already added" flip, all
  // key on this. Two spellings of the rule would be two answers to "is this the same title", so the two
  // files are held against each other as text. Reintroduce by changing either regex (say, letting `-`
  // through on one side): "have drifted apart" fails, naming both.
  const rule = (file: string, name: string) => {
    const src = readFileSync(join(ROOT, file), 'utf8');
    const m = src.match(new RegExp(`export const ${name} = \\(\\w+: string\\) => \\w+(\\.toLowerCase\\(\\)\\.replace\\(\\/.*?\\/[a-z]*, ''\\));`));
    assert.ok(m, `${file} no longer defines ${name} as the lowercase-and-strip rule`);
    return m[1];
  };
  const web = rule('lib/normTitle.ts', 'normTitle');
  const bff = rule('../bff/src/routes/sources.ts', 'norm');
  assert.equal(web, bff, `web/lib/normTitle.ts and bff/src/routes/sources.ts have drifted apart:\n  ${web}\n  ${bff}`);
  assert.equal(normTitle('SOLO LEVELING!'), 'sololeveling', 'the rule itself changed');
});

test('the Discover page folds its wall and opens a card from the fold', () => {
  // The fold is only a fold if the page calls it, and only useful if the tap that follows offers the
  // providers it collected. Reintroduce by returning `out` from the wall memo instead of
  // `foldByWork(out, nameOf, rankOf, wallAdded)`: "the wall is not folded" fails; by reading anything but
  // `wall.groups[key]` in open(): "open() does not read the wall's groups" fails and a two-source card would add
  // from the first source with no choice offered. Search's groups are in `wall.groups` too (searchProviders).
  const src = readFileSync(join(ROOT, 'app/discover/page.tsx'), 'utf8');
  assert.match(src, /return foldByWork\(out, nameOf, rankOf, wallAdded\);/, 'the wall is not folded, or not without what was added');
  assert.match(src, /const key = workKey\(it\);[\s\S]{0,1200}?const providers = wall\.groups\[key\];/, "open() does not read the wall's groups by work");
  assert.match(src, /if \(mode === 'search'\) return \{ items: searchHits, groups: searchProviders \};/, "search's groups are not the wall's");
  // The two local copies this replaced (the server keeps its own `norm` in bff/src/routes/sources.ts).
  for (const f of ['app/discover/page.tsx', 'components/AddSeriesDialog.tsx']) {
    assert.doesNotMatch(readFileSync(join(ROOT, f), 'utf8'), /const norm = /, `${f} grew its own copy of the title rule again`);
  }
});

test('the page reads both views through the live answers, hides owned works on the wall only, and keys its adds by work', () => {
  // v0.56.0's wiring, read from source like the test above; the arithmetic is the functions tested above.
  // - The wall's rows are read through the answers before the flatten. Reintroduce by flattening `byId[key]` again:
  //   "the wall does not read its rows through the answers" fails. (The budget counted the same rows to ask one more
  //   source per emptied one until v0.58.0, which asks every source: v580Discover.test.ts.)
  // - Search merges its groups through its own answers, and never runs the wall's fold, which drops what you have.
  //   Reintroduce by folding the hits with foldByWork: "search drops what you have" fails.
  // - An add hides the card it came from, by work. Reintroduce `setAdded((prev) => new Set(prev).add(normTitle(r.title)))`:
  //   "an add is not keyed by the card's work" fails.
  const src = readFileSync(join(ROOT, 'app/discover/page.tsx'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(code, /const wallKeys = useMemo\(\(\) => unknownWorks\(mine\(byId\)\.flatMap\(\(\[, list\]\) => list\)\), \[byId, mine\]\);/);
  assert.match(code, /const wallWorks = useLiveWorks\(wallKeys, mayAdd && mode === 'newest'\);/, 'the wall is not asked about while it is on screen');
  assert.match(code, /const rows = useMemo\(\(\) => Object\.fromEntries\(mine\(byId\)\.map\(\(\[k, list\]\) => \[k, applyWorks\(list, wallWorks\)\]\)\), \[byId, mine, wallWorks\]\);/,
    'the wall does not read its rows through the answers');
  assert.match(code, /for \(const it of rows\[key\] \?\? \[\]\) \{/, 'the wall does not read its rows through the answers');
  assert.match(code, /const searchWorks = useLiveWorks\(searchKeys, mayAdd && mode === 'search'\);/, 'search is not asked about while it is on screen');
  assert.match(code, /const searchGroups = useMemo\(\(\) => mergeGroups\(applyWorks\(searchQ\.data\?\.content \?\? \[\], searchWorks\)\), \[searchQ\.data, searchWorks\]\);/);
  assert.equal((code.match(/foldByWork\(/g) ?? []).length, 1, 'search drops what you have: the wall\'s fold runs twice');
  assert.match(code, /const key = workKey\(it\);[\s\S]{0,600}?fromKey\.current = key \|\| null;/, 'open() does not remember which card the dialog is for');
  assert.match(code, /const keys = fromKey\.current \? \[fromKey\.current\] :/, 'an add is not keyed by the card\'s work');
  assert.doesNotMatch(code, /\.add\(normTitle\(r\.title\)\)/, 'an add is not keyed by the card\'s work');
  assert.match(code, /onClose=\{\(\) => \{ fromKey\.current = null; setSeed\(null\); \}\}/, 'a closed dialog leaves its card for the next add from the hero');
  assert.match(code, /item=\{\{ \.\.\.it, inLibrary: it\.inLibrary \|\| shownAdded\.has\(workKey\(it\)\) \}\}/, 'a search card added on this visit does not read In library');
});
