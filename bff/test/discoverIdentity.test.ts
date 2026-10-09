// Which work a Discover item is, and whether the library holds it (v0.56.0, lib/discoverIdentity.ts): the pure rules.
// The names placed by online lookups (title_works) are discoverIdentity.int.test.ts's.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused@127.0.0.1:1/unused';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';

const load = () => import('../src/lib/discoverIdentity');

const held = (id: string, lang = 'en', work = `lib:${id}`) => ({ id, lang, work });

test('a series still matches after its site moved: a link is compared by its path', async () => {
  const { pairKey } = await load();
  // Reintroduce the whole link as the key: the two read as two series and the moved one shows in Discover as not held.
  assert.equal(pairKey('aqua', 'https://aquareader.net/manga/solo-leveling/'), pairKey('aqua', 'https://aquareader.org/manga/solo-leveling'));
  assert.notEqual(pairKey('aqua', 'https://aquareader.org/manga/solo-leveling'), pairKey('aqua', 'https://aquareader.org/manga/solo-leveling-ragnarok'));
  assert.notEqual(pairKey('aqua', 'https://x.org/manga/a'), pairKey('asura', 'https://x.org/manga/a'), 'the source is part of the key');
  assert.equal(pairKey('mangadex', 'ABC-123'), 'mangadex\u0001ABC-123', 'an id that is not a link is kept as given');
});

test('the strongest evidence first: the very source series, then a name, then a work', async () => {
  const { heldFor, noIndex, pairKey } = await load();
  const idx = noIndex();
  idx.byPair.set(pairKey('asura', 's-1'), [held('A')]);
  idx.byName.set('sololeveling', [held('B')]);
  assert.deepEqual(heldFor(idx, { source: 'asura', sourceId: 's-1', title: 'Solo Leveling' }).map((h) => h.id), ['A'],
    'the source series it is outranks a name');
  assert.deepEqual(heldFor(idx, { source: 'asura', sourceId: 'other', title: 'Solo Leveling' }).map((h) => h.id), ['B']);
  assert.deepEqual(heldFor(idx, { source: 'asura', sourceId: 'other', title: 'Ｓｏｌｏ Léveling (Webtoon)' }).map((h) => h.id), ['B'],
    'by nameKey: width, accents and a "(…)" aside set aside');
  assert.deepEqual(heldFor(idx, { source: 'asura', sourceId: 'other', title: 'Solo Leveling: Ragnarok' }), [],
    'never by containment: a spin-off is not the work');
  assert.deepEqual(heldFor(idx, { source: '', sourceId: '', title: 'Solo Leveling' }).map((h) => h.id), ['B'],
    'an item with no source series (a trending title) is found by its name');
});

test('the key a card folds by: the held work, else its name, never empty', async () => {
  const { workOf, noIndex } = await load();
  const idx = noIndex();
  idx.byName.set('sololeveling', [held('B', 'en', 'lib:W1')]);
  assert.equal(workOf(idx, { source: 'asura', sourceId: 'x', title: 'Solo Leveling' }), 'lib:W1', "a work's language editions share one key");
  assert.equal(workOf(idx, { source: 'asura', sourceId: 'x', title: 'The Player Who Can’t Level Up' }), 'n:playerwhocantlevelup',
    'a leading article and the apostrophe are set aside, as on AniList');
  assert.equal(workOf(idx, { source: 'asura', sourceId: 'x', title: '나 혼자만 레벨업' }), 'n:나혼자만레벨업', 'another script is kept, not dropped');
  assert.equal(workOf(idx, { source: 'asura', sourceId: 'x-9', title: '!!!' }), 's:asura:x-9',
    'a name that folds to nothing is its own card, never every such item on one');
});

test('a work key as it stands now: held works say so, unknown ones come back as they were', async () => {
  const { currentWork, noIndex } = await load();
  const idx = noIndex();
  idx.byName.set('sololeveling', [held('B', 'en', 'lib:W1')]);
  idx.byWork.set('al:151025', [held('C', 'en', 'lib:W2')]);
  assert.deepEqual(currentWork(idx, 'n:sololeveling'), { work: 'lib:W1', owned: true });
  assert.deepEqual(currentWork(idx, 'al:151025'), { work: 'lib:W2', owned: true });
  assert.deepEqual(currentWork(idx, 'n:unknown'), { work: 'n:unknown', owned: false });
  assert.deepEqual(currentWork(idx, 'md:abc'), { work: 'md:abc', owned: false });
  assert.deepEqual(currentWork(idx, 'lib:W9'), { work: 'lib:W9', owned: true });
});
