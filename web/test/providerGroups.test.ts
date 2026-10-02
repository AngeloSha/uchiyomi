// The fold behind the Providers panel, tested away from React.
//
// A multi-language extension exposes one source per language, and 3Hentai alone is twenty-nine of them;
// `groupProviders` is what turns those rows into one card. An off-by-one here does not fail, it renders
// twenty-nine cards again, which is exactly the wall this was written to remove.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { groupProviders, worstStatus, MANGADEX_GROUP, mangadexSourceId, type ProviderSrc, type SrcStatus } from '../lib/providerGroups';

const PKG = 'eu.kanade.tachiyomi.extension.all.hentai3';
const LANGS = ['all', 'en', 'ja', 'ko', 'zh', 'fr', 'de', 'es', 'it', 'pt-BR', 'ru', 'ar', 'tr', 'vi', 'th', 'id', 'pl', 'nl', 'sv',
  'fi', 'no', 'da', 'hu', 'cs', 'uk', 'el', 'he', 'hi', 'ms'];

const sw = (id: string, lang: string | null, over: Partial<ProviderSrc> = {}): ProviderSrc => ({
  id: `sw:${id}`, name: `3Hentai (${(lang ?? 'xx').toUpperCase()})`, lang, status: 'ok',
  extension: { pkgName: PKG, name: '3Hentai' }, ...over,
});
const variants = (): ProviderSrc[] => LANGS.map((l, i) => sw(String(100 + i), l));

test('29 variants fold into one card', () => {
  // Reintroduce by making groupKeyOf return null for every source (or by keying on `s.id` instead of the
  // package): "29 variants fold into one card" fails with 29 groups.
  const g = groupProviders(variants());
  assert.equal(g.length, 1, '29 variants fold into one card');
  assert.equal(g[0].name, '3Hentai');
  assert.equal(g[0].key, `sw-pkg:${PKG}`);
  assert.equal(g[0].sources.length, 29);
  assert.equal(g[0].languages.length, 29, 'every distinct language is counted once');
  assert.equal(g[0].on, 29);
});

test('a lone variant stays a single card', () => {
  const g = groupProviders([sw('1', 'en', { name: '1Manga.co (EN)', extension: { pkgName: 'eu.kanade.tachiyomi.extension.en.onemangaco', name: '1Manga.co' } })]);
  assert.equal(g.length, 1);
  assert.equal(g[0].sources.length, 1, 'one variant is one card, not a header over one row');
  assert.deepEqual(g[0].languages, ['en']);
});

test('engines, packs and custom sites are untouched', () => {
  // Reintroduce by dropping the `startsWith('sw:')` guard and keying on `name` for everything: the two
  // "Madara" sites below fold into one group.
  const list: ProviderSrc[] = [
    { id: 'mangadex', name: 'MangaDex', lang: null, status: 'ok', extension: null },
    { id: 'custom:abc', name: 'Madara', lang: 'en', status: 'ok', extension: null },
    { id: 'custom:def', name: 'Madara', lang: 'en', status: 'ok', extension: null },
    ...variants().slice(0, 3),
    { id: 'aqua', name: 'Aqua Manga', lang: 'en' },
  ];
  const g = groupProviders(list);
  assert.deepEqual(g.map((x) => x.key), ['mangadex', 'custom:abc', 'custom:def', `sw-pkg:${PKG}`, 'aqua'],
    'every non-extension source is its own card, in registry order, and the package sits where its first variant did');
  assert.equal(g[1].sources.length, 1, 'two sites with the same name do not fold');
  assert.deepEqual(g[0].languages, [], 'a source without a language adds none');
  assert.equal(g[4].worst, 'ok', 'a row with no status reads as ok');
});

test('MangaDex is one card however many languages are on, English alone included (v0.52.0, #123)', () => {
  // The server names the family (`extension: {pkgName: 'mangadex'}` on every MangaDex language). Reintroduce the
  // `sw:`-only guard in groupKeyOf: English alone is a plain card keyed `mangadex` with no languages to offer, and
  // three languages are three cards -- "English alone is the MangaDex card" fails first.
  const md = (code: string, over: Partial<ProviderSrc> = {}): ProviderSrc => ({
    id: mangadexSourceId(code), name: code === 'en' ? 'MangaDex' : `MangaDex (${code.toUpperCase()})`, lang: code, status: 'ok',
    extension: { pkgName: 'mangadex', name: 'MangaDex' }, ...over,
  });
  const alone = groupProviders([md('en'), { id: 'aqua', name: 'Aqua Manga', lang: 'en', extension: null }]);
  assert.equal(alone[0].key, MANGADEX_GROUP, 'English alone is the MangaDex card');
  assert.equal(alone[0].sources.length, 1);
  assert.equal(alone[1].key, 'aqua');
  // Registry order puts a language switched on live at the end, after other sources: it still joins the card.
  const three = groupProviders([md('en'), sw('1', 'en'), md('es-419', { status: 'rate_limited', used: 3 }), md('pt-BR')]);
  assert.deepEqual(three.map((g) => [g.key, g.sources.length]), [[MANGADEX_GROUP, 3], [`sw-pkg:${PKG}`, 1]]);
  assert.equal(three[0].name, 'MangaDex');
  assert.equal(three[0].worst, 'rate_limited', 'a language MangaDex refused colours the card');
  assert.equal(mangadexSourceId('es-419'), 'mangadex-es-419');
  assert.equal(mangadexSourceId('pt-BR'), 'mangadex-pt-br');
  // A built-in family and an extension package never share a key, whatever they are called.
  const both = groupProviders([md('en'), sw('2', 'en', { extension: { pkgName: 'mangadex', name: 'MangaDex' } })]);
  assert.equal(both.length, 2, 'the MangaDex extension folded into the built-in card');
});

test('the header wears the worst status: a blocked variant colours the card, a disabled one does not', () => {
  // Reintroduce by ranking `disabled` above `ok` in SEVERITY, or by taking the FIRST variant's status:
  // "one blocked variant among healthy ones shows as blocked" fails.
  const list = variants();
  list[10] = sw('110', 'ru', { status: 'blocked' });
  list[3] = sw('103', 'ko', { status: 'disabled' });
  list[4] = sw('104', 'zh', { status: 'quiet' });
  const [g] = groupProviders(list);
  assert.equal(g.worst, 'blocked', 'one blocked variant among healthy ones shows as blocked');
  assert.equal(g.on, 28, 'the disabled variant is not counted as on');

  assert.equal(worstStatus(['disabled', 'ok']), 'ok', 'mostly-off with one healthy language is healthy, not off');
  assert.equal(worstStatus(['disabled', 'disabled']), 'disabled');
  assert.equal(worstStatus(['ok', 'quiet']), 'ok', 'quiet does not outrank ok; ties keep the first seen');
  assert.equal(worstStatus(['ok', 'rate_limited', 'down']), 'rate_limited', 'every blocked-ish status outranks ok, ties keep the first');
  assert.equal(worstStatus([]), 'ok');
  const all: SrcStatus[] = ['ok', 'disabled', 'quiet', 'rate_limited', 'down', 'blocked'];
  assert.equal(worstStatus(all), 'rate_limited');
});

test('variants of a package the engine never named fold on the stripped name', () => {
  // Rows remembered before the columns existed carry `pkgName: null` and the server's stripped name; the
  // fallback must still fold them, case-insensitively, and must not fold on an empty name.
  const noPkg = (id: string, lang: string, name: string): ProviderSrc =>
    sw(id, lang, { extension: { pkgName: null, name } });
  const g = groupProviders([noPkg('1', 'en', '3Hentai'), noPkg('2', 'ja', '3hentai'), noPkg('3', 'en', ''), noPkg('4', 'ko', '')]);
  assert.deepEqual(g.map((x) => [x.key, x.sources.length]), [['sw-name:3hentai', 2], ['sw:3', 1], ['sw:4', 1]]);
});

test('a group with a package name never merges with a nameless one', () => {
  // A stripped-name fallback that happened to equal a package's extension name would be a different key
  // space; keep them apart so an upgrade that fills pkg_name cannot silently double a card's row count.
  const g = groupProviders([sw('1', 'en'), sw('2', 'ja', { extension: { pkgName: null, name: '3Hentai' } })]);
  assert.equal(g.length, 2);
});

test('the panel says each status as a mark in words: the card, the folded header and every variant row', () => {
  // v0.49.0 ("no more pills"): the three places a status shows went through one capsule that printed the
  // server's token as sent -- "ok", "rate-limited", "quiet" -- in English in every language, with only the tint
  // telling a blocked source from a healthy one. Reintroduce by putting the capsule back
  // (`<span className={`rounded-full px-2 …`}>{st === 'rate_limited' ? 'rate-limited' : st}</span>`):
  // "the status is not a mark" fails; by passing a variant's own status to the folded header instead of
  // `g.worst`: "the folded header" fails.
  const src = readFileSync(join(__dirname, '..', 'app/admin/page.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const a = src.indexOf('function Providers(');
  const b = src.indexOf('function ExtensionsLink(', a);
  assert.ok(a >= 0 && b > a, 'function Providers moved');
  const panel = src.slice(a, b);
  assert.match(panel, /const statusMark = \(st: ProviderStatus\) => <StatusMark \{\.\.\.sourceMark\(st\)\} \/>;/, 'the status is not a mark');
  assert.equal([...panel.matchAll(/\{statusMark\(st\)\}/g)].length, 2, 'the source card and each variant row show their own status');
  assert.equal([...panel.matchAll(/\{statusMark\(g\.worst\)\}/g)].length, 1, 'the folded header does not wear the unhappiest variant\'s status');
  assert.doesNotMatch(panel, /'rate-limited'/, 'the server\'s token is shown as a word again');
  assert.doesNotMatch(src, /\bSTATUS_STYLE\b/, 'the capsule tints are back');
  // v0.52.0: the MangaDex family gets its own card, built from the same rows and marks as everything else here.
  // Reintroduce by rendering it as any other group (`g.sources.length === 1 ? sourceCard(…) : packageCard(g)`): the
  // languages are offered nowhere -- "MangaDex has no card of its own" fails.
  assert.match(panel, /g\.key === MANGADEX_GROUP\s*\?\s*<MangadexCard key=\{g\.key\} group=\{g\} row=\{variantRow\} mark=\{statusMark\}/,
    'MangaDex has no card of its own');
  assert.match(panel, /<UnstatedLanguageCard \/>/, 'the language of sites that do not say is offered nowhere');
});
