// "Popular" as a listing every source family can answer.
//
// The point of this feature is that we do NOT compute a ranking. Each source already publishes its own,
// and it is the same page it serves "newest" from with a different sort. These tests pin that the right
// sort is asked for, per engine, because getting it wrong is invisible: a listing sorted the wrong way
// still parses, still fills the wall, and simply shows the wrong titles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', 'src');
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8');

test('every engine offers popular alongside latest', () => {
  for (const f of ['madara.ts', 'manganato.ts', 'mangathemesia.ts']) {
    const text = read('lib', 'sources', 'engines', f);
    assert.match(text, /async popular\(/, `${f} has no popular listing`);
    assert.match(text, /async latest\(/, `${f} lost its latest listing`);
  }
  assert.match(read('lib', 'sources', 'mangadex.ts'), /async popular\(/);
});

test('each engine asks for its own ranking, not ours', () => {
  // Reintroduce any of these by leaving the sort key as the "newest" one: the listing still parses and
  // still fills the wall, it just shows the wrong titles, which is why it needs pinning here.
  const madara = read('lib', 'sources', 'engines', 'madara.ts');
  const pop = madara.slice(madara.indexOf('async popular('));
  assert.match(pop, /m_orderby=views/, 'Madara popular must sort by views');
  assert.doesNotMatch(pop.slice(0, 400), /m_orderby=latest/, 'Madara popular is still asking for newest');

  const themesia = read('lib', 'sources', 'engines', 'mangathemesia.ts');
  const tp = themesia.slice(themesia.indexOf('async popular('));
  assert.match(tp, /order=popular/);

  const md = read('lib', 'sources', 'mangadex.ts');
  const mp = md.slice(md.indexOf('async popular('));
  assert.match(mp, /order\[followedCount\]=desc/, 'MangaDex popular must sort by followers');
});

test('the Manganato family keeps its candidate-address fallback', () => {
  // This family puts the sort in the path, so there is no single address that works everywhere and a wrong
  // guess is indistinguishable from an empty page. The fallback list is what makes that survivable: the
  // source drops out of Popular quietly instead of throwing.
  //
  // Reintroduce by hardcoding one path: a site that renames it loses Popular with no way to recover.
  const text = read('lib', 'sources', 'engines', 'manganato.ts');
  const pop = text.slice(text.indexOf('async popular('));
  const paths = pop.slice(pop.indexOf('const paths = ['), pop.indexOf('];'));
  assert.match(paths, /hot-manga/, 'no popular listing path is tried');
  assert.equal((paths.match(/`\//g) || []).length >= 2, true, 'a single path leaves no room to recover');
});

test('THE COLLISION: the two listings must not share a cache entry', () => {
  // `latestPage` caches for ten minutes and de-duplicates in-flight requests. Keyed without the mode, the
  // first listing asked for answers BOTH -- Popular would serve Newest's results, or the reverse, decided
  // only by which the reader happened to open first.
  //
  // Reintroduce by dropping `${mode}` from the key.
  const text = read('routes', 'sources.ts');
  const at = text.indexOf('async function latestPage(');
  const body = text.slice(at, at + 900);
  assert.match(body, /const key = `\$\{src\.id\}:\$\{mode\}:\$\{page\}`/, 'the cache key does not carry the listing mode');
});

test('only the newest listing is evidence about a source', () => {
  // An empty POPULAR page usually means the source has no popularity listing worth the name, not that its
  // parser has drifted. Feeding that into the empty-streak would mark working sources as broken.
  //
  // Reintroduce by calling reportLatest unconditionally.
  const text = read('routes', 'sources.ts');
  const at = text.indexOf('void reportLatest(');
  assert.ok(at > 0, 'reportLatest is no longer called at all');
  const before = text.slice(Math.max(0, at - 200), at);
  assert.match(before, /mode === 'latest'/, 'reportLatest is not gated on the listing mode');
});

test('THE CONSOLE NOISE: a source with no icon still gets an image, never a 404', () => {
  // The first version answered 404 for a source with no findable icon and let the browser fall back to a
  // tile. Behind an <img> a 404 is a console error, so every iconless source logged one in every visitor's
  // browser on every visit. The end-to-end run counts console errors and failed with six.
  //
  // Reintroduce by replying 404 instead of rendering the tile.
  const text = read('routes', 'images.ts');
  const at = text.indexOf("app.get('/img/sources/icon/:id'");
  assert.ok(at > 0, 'the source icon route is gone');
  const body = text.slice(at, text.indexOf('\n  });', at));
  assert.match(body, /letterTile\(/, 'no fallback tile is rendered, so an iconless source has nothing to return');
  // Only the RESOLUTION path matters. Answering 404 for an id that is not a source at all is correct and
  // stays -- nothing renders an <img> for a source that does not exist.
  const resolving = body.slice(body.indexOf('serveImage('));
  assert.doesNotMatch(resolving, /code\(404\)/, 'a 404 here becomes a console error in every visitor browser');
});
