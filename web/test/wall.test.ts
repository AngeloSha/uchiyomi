// One card per title on the Discover wall.
//
// The wall is several sources' newest lists in arrival order, and a popular title is on most of them, so it
// sat there three or four times under slightly different spellings (issue #36 item 4) while search, which
// the server folds by normalised title, showed it once with a badge. `lib/wall.ts` folds the wall the same
// way, in the client, after the flatten. Arithmetic on a list, so it is exercised here with no browser, like
// sourcePicker.test.ts; the rendering half is the same SourceCard the search path already uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { foldByTitle, type WallItem } from '../lib/wall';
import { normTitle } from '../lib/normTitle';

const ROOT = join(__dirname, '..');

const names: Record<string, string> = { a: 'Source A', b: 'Source B' };
const nameOf = (id: string) => names[id];
const row = (p: WallItem): WallItem => p;

test('the same title on two sources is one card that knows both', () => {
  // Reintroduce by keying the fold on `${it.source}:${it.sourceId}` instead of normTitle(it.title) -- the
  // key the pre-fold dedupe already uses, and the obvious wrong one: "two cards for one title" fails first,
  // then the badge count and the groups entry.
  const { items, groups } = foldByTitle([
    row({ source: 'a', sourceId: '1', title: 'Solo Leveling', inLibrary: false }),
    row({ source: 'b', sourceId: '7', title: 'Tower of God' }),
    // A different spelling -- punctuation and case -- is the same title, which is what normTitle is for.
    row({ source: 'b', sourceId: '2', title: 'SOLO LEVELING!', coverUrl: 'https://b/solo.jpg', inLibrary: true }),
  ], nameOf);

  assert.deepEqual(items.map((it) => it.title), ['Solo Leveling', 'Tower of God'], 'two cards for one title, or the first arrival lost its place');
  const [card] = items;
  assert.equal(card.providerCount, 2, 'the badge does not count both sources');
  assert.deepEqual([card.source, card.sourceId], ['a', '1'], 'the card did not keep the ids it arrived with');
  assert.equal(card.coverUrl, 'https://b/solo.jpg', 'the cover was not taken from the first row that had one');
  assert.equal(card.inLibrary, true, 'owned on one source did not read as owned');

  const key = normTitle('Solo Leveling');
  assert.deepEqual(groups[key]?.map((p) => `${p.source}:${p.sourceId}`), ['a:1', 'b:2'], 'groups[key] does not hold both providers');
  assert.deepEqual(groups[key].map((p) => p.name), ['Source A', 'Source B'], 'provider names were not resolved through nameOf');
  assert.equal(groups[key][1].title, 'SOLO LEVELING!', 'a provider must carry the title as its own source spells it');
  // Every keyed card has a groups entry, as every search hit does, so open() treats the two the same.
  assert.equal(groups[normTitle('Tower of God')]?.length, 1, 'a single-source card has no groups entry');
});

test("the providers of a folded card are in the page's order, not arrival order", () => {
  // The add dialog labels its first provider "preferred". The first source to ANSWER is the fastest one,
  // which is no reason to prefer it; the page ranks sources (budgetForMode) and search-all orders its
  // providers by that rank, so the fold does too. Reintroduce by dropping the sort after `providers.push`
  // in foldByTitle: b arrived first and stays first, and "providers are not ranked" fails.
  const rank: Record<string, number> = { a: 0, b: 1 };
  const { groups } = foldByTitle([
    row({ source: 'b', sourceId: '2', title: 'Solo Leveling' }),
    row({ source: 'a', sourceId: '1', title: 'Solo Leveling' }),
  ], nameOf, (id) => rank[id] ?? 99);
  assert.deepEqual(groups[normTitle('Solo Leveling')].map((p) => p.source), ['a', 'b'], 'providers are not ranked');
});

test('a source listing one title twice is still one place to add it from', () => {
  // Reintroduce by dropping the `providers.some((p) => p.source === it.source)` check: "one source counted
  // twice" fails, and the dialog would offer Source A as two rows.
  const { items, groups } = foldByTitle([
    row({ source: 'a', sourceId: '1', title: 'Omniscient Reader' }),
    row({ source: 'a', sourceId: '1-alt', title: 'Omniscient Reader' }),
  ], nameOf);
  assert.equal(items.length, 1, 'one title became two cards');
  assert.equal(items[0].providerCount, 1, 'one source counted twice');
  assert.equal(groups[normTitle('Omniscient Reader')].length, 1, 'one source listed as two providers');
});

test('a row whose title normalises to nothing is passed through as it came', () => {
  // Reintroduce by removing the `if (!key)` early exit: every such row folds into one card keyed '' --
  // "two untitled rows were folded into each other" fails.
  const blank = row({ source: 'a', sourceId: '9', title: '???' });
  const other = row({ source: 'b', sourceId: '8', title: '!!!' });
  const { items, groups } = foldByTitle([blank, other], nameOf);
  assert.equal(items.length, 2, 'two untitled rows were folded into each other');
  assert.equal(items[0], blank, 'the untitled row was copied rather than passed through');
  assert.equal(items[0].providerCount, undefined, 'an untitled row grew a badge');
  assert.deepEqual(Object.keys(groups), [], 'an empty key got a groups entry');
});

test('the fold never writes into the rows it was given', () => {
  // The rows are React state -- `byId` on the Discover page. The copy on first arrival is the guard:
  // reintroduce by pushing `it` itself there instead of `{ ...it, providerCount: 1 }` and assigning onto
  // `card` in place of building a new object: "the first row was mutated" fails. Assigning onto `card`
  // alone does NOT fail it -- the copy already protects the row -- which is why the copy is the thing named.
  const first = row({ source: 'a', sourceId: '1', title: 'Solo Leveling' });
  const before = { ...first };
  foldByTitle([first, row({ source: 'b', sourceId: '2', title: 'Solo Leveling' })], nameOf);
  assert.deepEqual(first, before, 'the first row was mutated');
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
  // `foldByTitle(out, nameOf)`: "the wall is not folded" fails; by reading `groupsRef.current[key]` alone in
  // open(): "open() does not read the wall's groups" fails and a two-source card would add from the first
  // source with no choice offered.
  const src = readFileSync(join(ROOT, 'app/discover/page.tsx'), 'utf8');
  assert.match(src, /return foldByTitle\(out, nameOf, rankOf\);/, 'the wall is not folded');
  assert.match(src, /wall\.groups\[key\] \?\? groupsRef\.current\[key\]/, "open() does not read the wall's groups");
  // The two local copies this replaced (the server keeps its own `norm` in bff/src/routes/sources.ts).
  for (const f of ['app/discover/page.tsx', 'components/AddSeriesDialog.tsx']) {
    assert.doesNotMatch(readFileSync(join(ROOT, f), 'utf8'), /const norm = /, `${f} grew its own copy of the title rule again`);
  }
});
