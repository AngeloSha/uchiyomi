// The shell's own sentences exist in every language the web app ships, with the same placeholders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { S, LANGS, pickLang, translator, pageStrings } = require('../src/i18n.js');
const here = path.dirname(fileURLToPath(import.meta.url));

test("the shell's languages are the web app's", () => {
  // Reintroduce by dropping a language from S: the web ships it and the shell does not.
  const web = fs.readdirSync(path.join(here, '..', '..', 'web', 'public', 'locales')).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  assert.deepEqual([...LANGS].filter((l) => l !== 'en').sort(), web.filter((l) => l !== 'en').sort());
});

test('every language has every key, the same {placeholders}, and no English left behind', () => {
  // Reintroduce by deleting one key from a language: it falls back to English silently, and this names it.
  const keys = Object.keys(S.en);
  const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');
  for (const l of LANGS) {
    assert.deepEqual(Object.keys(S[l]).sort(), [...keys].sort(), l);
    for (const k of keys) {
      assert.equal(ph(S[l][k]), ph(S.en[k]), `${l} ${k}`);
      if (l !== 'en' && !/^(restore\.pick|first\.free)$/.test(k)) assert.notEqual(S[l][k], S.en[k], `${l} ${k} is still English`);
    }
  }
});

test('OS locale -> shell language, and the page bundles', () => {
  // Reintroduce by mapping pt-* to English in pickLang: `pt-PT` is no longer pt-BR.
  assert.equal(pickLang('de-AT'), 'de');
  assert.equal(pickLang('pt-PT'), 'pt-BR');
  assert.equal(pickLang('zh-TW'), 'zh');
  assert.equal(pickLang('ko'), 'en');
  assert.equal(translator('fr')('tray.restartUpdate', { v: '0.45.0' }), 'Redémarrer pour passer à 0.45.0');
  assert.deepEqual(Object.keys(pageStrings('ja', 'first.')).sort(), Object.keys(S.en).filter((k) => k.startsWith('first.')).sort());
});
