// What outlived the Providers panel's fold (lib/providerGroups.ts), and where its last protection went.
//
// Until v0.54.0 a multi-language extension's sources folded into one card per package -- 3Hentai alone is twenty-nine
// of them -- and MangaDex's languages into one card of their own. Admin → Sources lists every source one per row from
// one answer (GET /api/admin/sources/overview, lib/sourcesPanel.ts), its switched-off ones folded away, so the fold went
// with the panel; an extension's languages are a section of its sources' sheet, MangaDex's are chips in Add sources and
// in a MangaDex source's sheet. What stays here: MangaDex's source ids, and the rule the old panel's status capsule
// broke -- a source's state is said in the reader's words, never as the server's token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { mangadexSourceId } from '../lib/providerGroups';
import { setActiveLocale } from '../lib/format';
import { sourceSays, type OverviewSource } from '../lib/sourcesPanel';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const slice = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  const b = to ? src.indexOf(to, a + 1) : src.length;
  assert.ok(a >= 0 && b > a, `${from} … ${to} is not where this test looks`);
  return src.slice(a, b);
};

setActiveLocale('en');

test('MangaDex\'s source id in one language, as the server names it', () => {
  // The language chips find a language's source -- and how many series it would stop -- by this id (offCost).
  assert.equal(mangadexSourceId('en'), 'mangadex', 'English is not the plain MangaDex source');
  assert.equal(mangadexSourceId('es-419'), 'mangadex-es-419');
  assert.equal(mangadexSourceId('pt-BR'), 'mangadex-pt-br', 'a region is not lower-cased as the server does');
});

test('a source says its state in words: a word on its row, a mark in its sheet, never the server\'s token', () => {
  // v0.49.0 ("no more pills"): Providers' three status places went through one capsule printing the server's token
  // as sent -- "ok", "rate-limited", "quiet" -- in English in every language. Reintroduce `{s.state}` on the row, or a
  // label of the token in the sheet: these fail.
  const at = Date.parse('2026-10-03T12:00:00Z');
  const base: OverviewSource = { id: 'x', name: 'X', kind: 'builtin', lang: 'en', standing: 'usable', state: 'ok', main: 3, followed: 0, withBackup: 0 };
  assert.equal(sourceSays(base, null, at).word, 'Healthy');
  const cooling = sourceSays({ ...base, standing: 'cooling', state: 'blocked', cooldown: { status: 'rate_limited', until: '2026-10-03T12:20:00Z' } }, null, at);
  assert.equal(cooling.word, 'Rate-limited', 'a cooldown is said as its token');
  assert.equal(cooling.reason, 'trying again in 20 minutes');
  assert.equal(cooling.tone, 'warn');
  assert.notEqual(sourceSays({ ...base, state: 'empty' }, null, at).word, 'empty', 'a quiet source is said as its token');
  const panel = read('components/SourcesPanel.tsx');
  const row = slice(panel, 'function SourceRow(', 'function AddSources(');
  assert.match(row, /<span className=\{WORD\[says\.tone\] \?\? TONE_TEXT\.info\}>\{says\.word\}<\/span>/, 'the row does not say its state in words');
  assert.doesNotMatch(row, /\{s\.(state|standing)\}<|>\{s\.(state|standing)\}/, 'the row prints the server\'s token');
  assert.match(read('components/SourceSheet.tsx'), /<StatusMark tone=\{says\.tone\} label=\{says\.word\} size="md" \/>/, 'the sheet does not say its state as a mark');
  assert.doesNotMatch(panel + read('components/SourceSheet.tsx'), /'rate-limited'|\bSTATUS_STYLE\b/, 'the server\'s token, or the capsule tints, are back');
  // MangaDex's languages and the language of sites that do not say are offered where the cards were: Add sources, and
  // a MangaDex source's own sheet. Drop either: "… offered nowhere" fails.
  const add = slice(panel, 'function AddSources(', 'function AddSite(');
  assert.match(add, /<MangadexLanguages sources=\{\(overview\?\.sources \?\? \[\]\)\.filter\(\(s\) => s\.kind === 'mangadex'\)\}/, 'MangaDex\'s languages are offered nowhere');
  assert.match(add, /<UnstatedLanguageRow \/>/, 'the language of sites that do not say is offered nowhere');
  assert.match(read('components/SourceSheet.tsx'), /\{s\?\.kind === 'mangadex' && \(\s*<div[^>]*>\s*<MangadexLanguages open /, 'a MangaDex source\'s sheet has no languages');
});
