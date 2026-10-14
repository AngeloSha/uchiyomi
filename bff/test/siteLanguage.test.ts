// A site's language from its own pages (v0.62.0, lib/sources/detect.ts and lib/lang.ts editionLang), case by case. The
// add and the sheet's edit are pinned against the real routes in siteLanguage.int.test.ts.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';

let editionLang: typeof import('../src/lib/lang').editionLang;
let pageLanguage: typeof import('../src/lib/sources/detect').pageLanguage;
let siteLanguage: typeof import('../src/lib/sources/detect').siteLanguage;
before(async () => {
  ({ editionLang } = await import('../src/lib/lang'));
  ({ pageLanguage, siteLanguage } = await import('../src/lib/sources/detect'));
});

test('a page\'s code is the language a source is in: base language, editions where scanlations differ', () => {
  // Reintroduce by storing canonLang's code as it is: "en-US" never equals a series' "en" where codes compare exactly.
  assert.equal(editionLang('en-US'), 'en');
  assert.equal(editionLang('fr_FR'), 'fr');
  assert.equal(editionLang('es-ES'), 'es');
  assert.equal(editionLang('es'), 'es');
  assert.equal(editionLang('es-MX'), 'es-419');
  assert.equal(editionLang('es-419'), 'es-419');
  assert.equal(editionLang('pt-BR'), 'pt-BR');
  assert.equal(editionLang('pt-PT'), 'pt');
  assert.equal(editionLang('pt'), 'pt');
  assert.equal(editionLang('zh-CN'), 'zh-Hans');
  assert.equal(editionLang('zh'), 'zh-Hans');
  assert.equal(editionLang('zh-TW'), 'zh-Hant');
  assert.equal(editionLang('zh-HK'), 'zh-Hant');
  assert.equal(editionLang('in'), 'id', 'a retired code is today\'s');
  assert.equal(editionLang('all'), null);
  assert.equal(editionLang(''), null);
});

test('a page says its language in <html lang>, else og:locale', () => {
  assert.equal(pageLanguage('<!DOCTYPE html><html lang="es-ES" class="no-js"><head>'), 'es');
  assert.equal(pageLanguage('<html dir="ltr" lang=\'es-MX\'>'), 'es-419');
  assert.equal(pageLanguage('<html xml:lang="pt-BR">'), 'pt-BR');
  assert.equal(pageLanguage('<html lang=tr>'), 'tr', 'unquoted');
  // A `lang` in the body is not the page's: only the html element's counts.
  assert.equal(pageLanguage('<html><body><p lang="ja">日本語</p>'), null);
  assert.equal(pageLanguage('<html><head><meta property="og:locale" content="id_ID" />'), 'id');
  assert.equal(pageLanguage('<html><head><meta content="fr_FR" property="og:locale">'), 'fr', 'attributes either way round');
  assert.equal(pageLanguage('<html><head><meta property="og:locale:alternate" content="de_DE"><meta property="og:title" content="es">'), null);
  assert.equal(pageLanguage('<html><head><title>x</title>'), null);
  assert.equal(pageLanguage(''), null);
});

test('English from a page is not stored: it is what WordPress says by default', () => {
  // Reintroduce by storing it: a Spanish site left at WordPress's default is read as English, on a server whose admin
  // said its sites are Spanish.
  assert.equal(siteLanguage('<html lang="en-US">'), null);
  assert.equal(siteLanguage('<html lang="es">'), 'es');
  assert.equal(siteLanguage('<html>'), null);
});
