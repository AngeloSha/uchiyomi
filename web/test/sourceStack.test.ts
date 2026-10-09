// A Discover card's source icons (v0.56.0).
//
// The owner: "if one is multiple sources it shows once with the icons of the multiple sources". A card used to show
// one source's icon (in Newest, with more than one source on the wall) and a "3 sources" text badge; search showed
// neither. Now every card, in Newest, Popular and search, draws its providers as up to three overlapping icons and a
// "+2" for the rest -- one icon per extension, so MangaDex's languages are one. The arithmetic is lib/sourceGroups.ts
// `iconStack`; the card is rendered to markup here, as actionList.test.ts renders its rows, and the page's wiring is
// read from source like wall.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { iconStack, type StackSource } from '../lib/sourceGroups';
import { SourceCard, type SourceItem } from '../components/cards';

// Under tsx the components compile to the classic `React.createElement`, which they look up as a global.
(globalThis as any).React = React;

const ROOT = join(__dirname, '..');
const MANGADEX = { pkgName: 'mangadex', name: 'MangaDex' };
const src = (source: string, name = source, extension: StackSource['extension'] = null): StackSource => ({ source, name, extension });
const card = (item: Partial<SourceItem>, providers?: StackSource[]) => renderToStaticMarkup(createElement(SourceCard, {
  item: { source: 'a', sourceId: '1', title: 'Solo Leveling', ...item }, providers, onAdd: () => {},
}));
const icons = (html: string) => [...html.matchAll(/<img src="\/img\/sources\/icon\/([^"]+)"/g)].map((m) => decodeURIComponent(m[1]));

test("MangaDex's languages are one icon, named for MangaDex (iconStack)", () => {
  // MangaDex is an adapter per language (`mangadex`, `mangadex-es-419`), all one extension (GET /api/sources says
  // `extension: { pkgName: 'mangadex' }` for each). A title on both was drawn as the same icon twice. Reintroduce by
  // keying iconStack on `p.source` alone: "MangaDex's languages are two icons" fails.
  const s = iconStack([src('asura', 'Asura Scans'), src('mangadex', 'MangaDex', MANGADEX), src('mangadex-es-419', 'MangaDex (ES-419)', MANGADEX)]);
  assert.deepEqual(s.icons.map((i) => i.id), ['asura', 'mangadex'], "MangaDex's languages are two icons");
  assert.deepEqual(s.icons.map((i) => i.name), ['Asura Scans', 'MangaDex'], 'an icon for several languages is not named for the extension');
  assert.equal(s.names, 'Asura Scans, MangaDex', 'a screen reader does not hear the sources');
  // One language alone keeps its own name: it says which edition the card is.
  assert.equal(iconStack([src('mangadex-es-419', 'MangaDex (ES-419)', MANGADEX)]).names, 'MangaDex (ES-419)');
  // An extension the engine never named a package for meets its other languages by name (the server strips " (EN)").
  const guess = { pkgName: null, name: '3Hentai' };
  assert.equal(iconStack([src('sw:1', '3Hentai (EN)', guess), src('sw:2', '3Hentai (JA)', guess)]).icons.length, 1);
  // Built-ins and sites with no extension are one icon each; a source listed twice is still one.
  assert.equal(iconStack([src('a'), src('b'), src('a')]).icons.length, 2);
});

test('three icons at most, then "+N"; every name is said, the hidden ones too (iconStack)', () => {
  // Reintroduce by dropping the slice: "more than three icons in a 110-px corner" fails; by counting `more` from the
  // providers rather than the deduplicated icons: "+N counts MangaDex twice" fails.
  for (const [n, shown, more] of [[1, 1, 0], [2, 2, 0], [3, 3, 0], [5, 3, 2]] as const) {
    const s = iconStack(Array.from({ length: n }, (_, i) => src(`s${i}`, `Source ${i}`)));
    assert.equal(s.icons.length, shown, `more than three icons in a 110-px corner (${n} providers)`);
    assert.equal(s.more, more, `${n} providers`);
    assert.equal(s.names.split(', ').length, n, `${n} providers: not every name is said`);
  }
  const s = iconStack([src('a'), src('mangadex', 'MangaDex', MANGADEX), src('mangadex-fr', 'MangaDex (FR)', MANGADEX), src('b'), src('c')]);
  assert.equal(s.more, 1, '+N counts MangaDex twice');
});

test('the card draws the stack in the top corner, "+2" for the rest, and the 18+ mark under it', () => {
  // Reintroduce by rendering the stack only for more than one provider: "one provider shows no icon" fails; by
  // leaving the 18+ mark at top-1.5 with icons shown: "the 18+ mark sits on the icons" fails; by dropping
  // aria-describedby: "a screen reader never hears the sources" fails.
  const five = [src('asura', 'Asura Scans'), src('mangadex', 'MangaDex', MANGADEX), src('mangadex-es-419', 'MangaDex (ES-419)', MANGADEX),
    src('flame', 'Flame Comics'), src('reaper', 'Reaper Scans'), src('aqua', 'Aqua Manga')];
  const html = card({ rating: 'adult' }, five);
  assert.deepEqual(icons(html), ['asura', 'mangadex', 'flame'], 'not the first three, one per extension');
  assert.match(html, /<bdi dir="ltr"[^>]*>\+2<\/bdi>/, 'the rest are not "+2", or "+2" reads "2+" in an Arabic line');
  assert.match(html, /data-source-stack="5"/);
  assert.match(html, /role="img" aria-label="Asura Scans, MangaDex, Flame Comics, Reaper Scans, Aqua Manga" title="Asura Scans, MangaDex, Flame Comics, Reaper Scans, Aqua Manga"/);
  const id = /<span id="([^"]+)" role="img"/.exec(html)?.[1];
  assert.ok(id && html.includes(`aria-describedby="${id}"`), 'a screen reader never hears the sources: the button is not described by the stack');
  assert.match(html, /class="absolute end-1\.5 top-1\.5 z-10 flex items-center gap-1 rounded-md bg-ink-950\/80 p-1 backdrop-blur"/, 'the stack left the top corner');
  assert.match(html, /data-rating-mark="true" class="absolute end-1\.5 top-9 /, 'the 18+ mark sits on the icons');
  // The badge it replaced is gone: the icons say it.
  assert.doesNotMatch(html, /\d+ sources/, 'the "{n} sources" badge is back');

  const one = card({}, [src('asura', 'Asura Scans')]);
  assert.deepEqual(icons(one), ['asura'], 'one provider shows no icon');
  assert.doesNotMatch(one, /\+\d/, 'one provider grew a "+N"');
  // No providers at all (nothing calls it so today): no box, and the 18+ mark takes the corner.
  const bare = card({ rating: 'adult' });
  assert.deepEqual(icons(bare), []);
  assert.match(bare, /data-rating-mark="true" class="absolute end-1\.5 top-1\.5 /);
  assert.doesNotMatch(bare, /aria-describedby/);
});

test('the "In library" ribbon and the "EN in library" mark keep their corners beside the stack', () => {
  // Search still shows what you have (the owner's call): an owned card is a link to its series, described by its
  // sources too; one held in another language keeps its bottom-start mark, away from the top-end stack.
  const owned = card({ inLibrary: true, librarySeriesId: 'ser-1' }, [src('asura', 'Asura Scans')]);
  const link = /^<a [^>]*>/.exec(owned)?.[0] ?? '';
  assert.ok(/href="\/series\/?\?id=ser-1"/.test(link) && link.includes('aria-label="Solo Leveling"') && /aria-describedby="[^"]+"/.test(link),
    'an owned search card is not its series, described by its sources');
  assert.match(owned, /In library/);
  const held = card({ libraryLangs: ['en', 'es'] }, [src('asura', 'Asura Scans')]);
  assert.match(held, /data-library-langs="true" class="absolute bottom-1\.5 start-1\.5 /);
});

test('the page gives every card its providers, in Newest, Popular and search alike, by extension', () => {
  // Today search got no icon and one source showed one only in Newest with more than one source on the wall.
  // Reintroduce `sourceName={mode === 'newest' && order.length > 1 ? …}`: "a mode or a single source draws no icons"
  // fails; by mapping providers without their extension: "MangaDex's languages are told apart on the page" fails.
  const page = readFileSync(join(ROOT, 'app/discover/page.tsx'), 'utf8');
  assert.match(page, /<SourceCard key=\{`\$\{it\.source\}:\$\{it\.sourceId\}`\} item=\{[^}]*\}\}\s*providers=\{stackOf\(it\)\}\s*onAdd=/, 'a mode or a single source draws no icons');
  assert.doesNotMatch(page, /sourceName=/, 'a mode or a single source draws no icons');
  assert.match(page, /const extOf = useMemo\(\(\) => new Map<string, SrcExtension \| null>\(sources\.map\(\(s\) => \[s\.id, s\.extension \?\? null\]\)\), \[sources\]\);/,
    "MangaDex's languages are told apart on the page");
  assert.match(page, /\.map\(\(p\) => \(\{ source: p\.source, name: p\.name, extension: extOf\.get\(p\.source\) \?\? null \}\)\);/, "MangaDex's languages are told apart on the page");
  // The wall's groups and search's are both what the stack reads, by work.
  assert.match(page, /\(wall\.groups\[workKey\(it\)\] \?\? \[\{ source: it\.source, name: nameOf\(it\.source\) \?\? it\.source \}\]\)/);
});
