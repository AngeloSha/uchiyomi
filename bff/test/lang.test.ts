// The language model (lib/lang.ts, v0.52.0): what the same-language guard (#123) and the editions of one work (#72)
// both stand on.
//
//   - one language is one base language in one script: es is es-419, zh-Hans is not zh-Hant;
//   - a code that says nothing is the server's unstated language, English unless the admin picks another;
//   - exact mode compares whole codes, for a work that holds es and es-419;
//   - "all" is the same only as itself, as borrowNames' rule had it;
//   - MangaDex's codes and the app's map both ways, and labels read the app's code.
//
// Pure: no database, no registry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MANGADEX_LANGS, canonLang, mdLang, langLabel, sameLanguage, setUnstatedLang, unstatedLang } from '../src/lib/lang';

test('sameLanguage: one base language in one script is one language', () => {
  for (const [a, b] of [['es', 'es-419'], ['pt', 'pt-BR'], ['en', 'en-US'], ['es-la', 'es-419'], ['zh', 'zh-Hans'], ['zh-TW', 'zh-Hant'], ['EN', 'en_GB']]) {
    assert.ok(sameLanguage(a, b), `${a} and ${b} are one language`);
  }
  // Reintroduce by comparing the base language alone (borrowNames' old rule): Simplified reads as Traditional.
  assert.equal(sameLanguage('zh-Hans', 'zh-Hant'), false, 'zh-Hans and zh-Hant are written differently');
  assert.equal(sameLanguage('zh', 'zh-Hant'), false, 'a bare zh is Simplified');
  assert.equal(sameLanguage('sr', 'sr-Latn'), false, 'a bare sr is Cyrillic');
  assert.equal(sameLanguage('es', 'en'), false);
});

test("sameLanguage: a code that says nothing is the server's unstated language", () => {
  try {
    assert.equal(unstatedLang(), 'en', 'English until the admin picks another');
    for (const blank of [null, undefined, '', '  ']) assert.ok(sameLanguage(blank, 'en-US'), `${JSON.stringify(blank)} is English`);
    assert.equal(sameLanguage(null, 'es'), false, 'an unknown language took a Spanish source for an English series');
    // Reintroduce by reading a blank as 'en' (borrowNames' old rule) instead of unstatedLang(): the Spanish server's
    // template sites stay English.
    assert.equal(setUnstatedLang('es-la'), 'es-419', 'the setting is kept in the app\'s code');
    assert.ok(sameLanguage(null, 'es'), 'a blank is the unstated language, not English');
    assert.ok(sameLanguage('es', ''), 'either side may be the blank one');
    assert.equal(sameLanguage(undefined, 'en'), false);
    assert.equal(setUnstatedLang('all'), 'en', '"all" cannot be the unstated language: English stays');
  } finally {
    setUnstatedLang('en');
  }
});

test('sameLanguage: exact compares whole codes', () => {
  // A work with both es and es-419: "Spanish" says nothing about which edition a source belongs to.
  // Reintroduce by ignoring `exact`: es passes for es-419.
  assert.equal(sameLanguage('es', 'es-419', { exact: true }), false, 'es passed for es-419 in exact mode');
  assert.ok(sameLanguage('es-la', 'es-419', { exact: true }), 'MangaDex\'s spelling is the same code');
  assert.ok(sameLanguage('pt-br', 'pt-BR', { exact: true }), 'case is not a different code');
  assert.ok(sameLanguage(null, 'en', { exact: true }), 'a blank is still the unstated language');
});

test('sameLanguage: a code naming no single language is the same only as itself', () => {
  // borrowNames' rule, kept: a donor "in every language" is no proof its names are in ours. Reintroduce by reading
  // "all" as a blank (the unstated language): an all-language donor names an English series.
  assert.equal(sameLanguage('all', 'en'), false, 'a source in every language passed for English');
  assert.equal(sameLanguage(null, 'all'), false, 'a source in every language passed for the unstated language');
  assert.ok(sameLanguage('all', 'ALL'));
  assert.equal(sameLanguage('all', 'other'), false);
  assert.equal(sameLanguage('en,es', 'en'), false, 'several codes in one string are no single language');
});

test("canonLang, mdLang and langLabel: MangaDex's codes and the app's map both ways", () => {
  assert.equal(MANGADEX_LANGS[0].code, 'en', 'English is the first row: the always-on adapter');
  for (const { code, md } of MANGADEX_LANGS) {
    // Reintroduce by dropping MangaDex's spellings from canonLang: es-la reads as es-LA (Spanish in Laos).
    assert.equal(canonLang(md), code, `MangaDex's ${md} is the app's ${code}`);
    assert.equal(canonLang(code), code, `${code} is already the app's code`);
    assert.equal(mdLang(code), md, `the app's ${code} asks MangaDex for ${md}`);
  }
  assert.equal(new Set(MANGADEX_LANGS.map((l) => l.code)).size, MANGADEX_LANGS.length, 'a code is listed twice');
  assert.equal(mdLang('pt-br'), 'pt-br', 'any spelling of a code MangaDex has');
  assert.equal(mdLang('zh-TW'), null, 'MangaDex is not offered in zh-TW');
  for (const none of ['all', 'other', 'Other', '', '  ', null, undefined]) assert.equal(canonLang(none), null, JSON.stringify(none));
  assert.equal(canonLang('en_us'), 'en-US');
  assert.equal(canonLang('iw'), 'he', 'a retired code reads as the current one');
  assert.equal(langLabel('es-la'), 'ES-419');
  assert.equal(langLabel('zh-Hant'), 'ZH-HANT');
  assert.equal(langLabel('all'), '');
});
