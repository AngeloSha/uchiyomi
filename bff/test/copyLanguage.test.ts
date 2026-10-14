// The language rules of the release rules (v0.62.0, lib/copyLanguage.ts), case by case, without a database: which
// copies a series may take, when the series' language is trusted at all, and which copies continuity reorders.
// The real updater and routes are pinned in copyLanguage.int.test.ts.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

// The module reaches the database module, which validates the env on import; nothing here connects.
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';

let copyLang: typeof import('../src/lib/copyLanguage').copyLang;
let languageDeclared: typeof import('../src/lib/copyLanguage').languageDeclared;
let languageRules: typeof import('../src/lib/copyLanguage').languageRules;

const ES = 'clu-es';
const EN = 'clu-en';
const ALL = 'clu-all';
const SITE = 'clu-site';

let unregister: (id: string) => boolean;

before(async () => {
  ({ copyLang, languageDeclared, languageRules } = await import('../src/lib/copyLanguage'));
  const loader = await import('../src/lib/sources/loader');
  unregister = loader.unregisterAdapter;
  const adapter = (id: string, lang?: string) => ({
    id, name: id, ...(lang ? { lang } : {}),
    async search() { return []; }, async getSeries() { return null; }, async listChapters() { return []; },
    async getPageUrls() { return []; },
  });
  for (const [id, lang] of [[ES, 'es'], [EN, 'en'], [ALL, 'all'], [SITE, undefined]] as const) {
    loader.registerAdapter(adapter(id, lang) as any);
  }
});
after(() => { for (const id of [ES, EN, ALL, SITE]) unregister(id); });

test('a source declares one language, or nothing is known about it', () => {
  assert.equal(languageDeclared(ES), 'es');
  // A site that says nothing is NOT read as the unstated language here: nothing is known, so nothing is dropped.
  assert.equal(languageDeclared(SITE), null);
  // Every language is no single one.
  assert.equal(languageDeclared(ALL), null);
  assert.equal(languageDeclared('clu-not-loaded'), null);
  // A copy's own language (MangaDex rows) wins over its source's.
  assert.equal(copyLang({ lang: 'es-la', source: EN }), 'es-419');
  assert.equal(copyLang({ source: ES }), 'es');
});

test('an English series drops what it knows is Spanish, and keeps everything it does not know', () => {
  const { inLanguage } = languageRules({ lang: 'en', sameBaseSibling: false }, [ES, EN], []);
  assert.ok(inLanguage, 'a series one of whose sources serves English has a language rule');
  assert.equal(inLanguage({ source: ES }), false, 'a copy from a Spanish source');
  assert.equal(inLanguage({ lang: 'es-419', source: EN }), false, 'a Spanish MangaDex row, whatever its source says');
  assert.equal(inLanguage({ source: EN }), true);
  assert.equal(inLanguage({ lang: 'en', source: EN }), true);
  // Unknown is kept: the rule only drops what it knows.
  assert.equal(inLanguage({ source: SITE }), true, 'a site that declares nothing');
  assert.equal(inLanguage({ source: ALL }), true, 'a source in every language');
});

test('a language no source of the series has is not trusted, so nothing is dropped', () => {
  // Korean set by hand on a manhwa read in English. Reintroduce by dropping `served`: inLanguage drops every copy.
  assert.equal(languageRules({ lang: 'ko', sameBaseSibling: false }, [EN], []).inLanguage, undefined);
  // A source that declares nothing, or every language, may serve it: the rule stands.
  assert.ok(languageRules({ lang: 'ko', sameBaseSibling: false }, [EN, SITE], []).inLanguage);
  assert.ok(languageRules({ lang: 'ko', sameBaseSibling: false }, [EN, ALL], []).inLanguage);
  // The series' own source in its language is the plain case.
  assert.ok(languageRules({ lang: 'es', sameBaseSibling: false }, [ES], []).inLanguage);
});

test('codes compare like a follow: base language, exact beside a same-base edition', () => {
  const loose = languageRules({ lang: 'es-419', sameBaseSibling: false }, [ES], []).inLanguage!;
  assert.equal(loose({ source: ES }), true, 'es serves es-419 when no sibling edition needs them apart');
  const exact = languageRules({ lang: 'es-419', sameBaseSibling: true }, [ES, EN], []).inLanguage;
  // ES declares es, not es-419, so with exact codes neither source serves the series: no rule.
  assert.equal(exact, undefined);
  const exactServed = languageRules({ lang: 'es-419', sameBaseSibling: true }, [ES, SITE], []).inLanguage!;
  assert.equal(exactServed({ source: ES }), false, 'beside a same-base edition, es is not es-419');
});

test('continuity reorders copies of unknown language only, by the groups of the latest chapters', () => {
  const { continuity } = languageRules({ lang: 'en', sameBaseSibling: false }, [ALL], ['Eng Scans']);
  assert.ok(continuity);
  assert.equal(continuity({ source: ALL, scanlator: 'Eng Scans' }), 0);
  assert.equal(continuity({ source: ALL, scanlator: 'eng-scans' }), 0, 'group names compare normalised');
  assert.equal(continuity({ source: ALL, scanlator: 'Esp Scans' }), 1);
  assert.equal(continuity({ source: ALL }), 1, 'a copy naming no group is not the group on disk');
  // Known languages are never reordered by it. Reintroduce by dropping the copyLang check: a known English copy from
  // another group reads 1, and continuity starts outranking the date between ordinary copies.
  assert.equal(continuity({ source: EN, scanlator: 'Other' }), 0);
  // Nothing on disk names a group: no continuity at all.
  assert.equal(languageRules({ lang: 'en', sameBaseSibling: false }, [ALL], []).continuity, undefined);
});
