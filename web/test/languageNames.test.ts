// Admin → Extensions → Languages names a source language by the engine's bare code, and the v0.49.0 Hide/Show keys
// put that code into a translated sentence. In Spanish and French a bare "en" or "es" is a word of the sentence
// ("Ocultar en", "Masquer en ?"), so the translators of the final string pass asked for the language's name.
// Two of the same keys also joined their sentences with a plain space, a stray gap after a CJK full stop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { languageName, setActiveLocale } from '../lib/format';
import { joinSentences, sentenceGap } from '../lib/jobs';

const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

test('a language code reads as the language, in the reader\'s own language', () => {
  setActiveLocale('en');
  assert.equal(languageName('en'), 'English', 'the bare code is shown');
  assert.equal(languageName('zh-Hans'), 'Simplified Chinese');
  setActiveLocale('de');
  assert.equal(languageName('en'), 'Englisch', 'the name is not in the app\'s language');
  setActiveLocale('fr');
  assert.equal(languageName('es'), 'espagnol');
  setActiveLocale('en');
  // The engine's code for a source in every language, and a code Intl does not know.
  assert.equal(languageName('all'), 'All languages');
  assert.equal(languageName('not a code!'), 'not a code!', 'an unknown code must stay as it is');
});

test('the Hide and Show keys, and the question before hiding, name the language', () => {
  // v0.53.0: the Languages sheet (components/ExtensionLanguages.tsx). Every {lang} it fills is the language's name:
  // `lang` in the switch's toasts, `name` in the question, each made by languageName. Reintroduce by passing the code
  // (`{ lang: code }`, or `const lang = l.lang`): the assertions below name it.
  const sheet = src('components/ExtensionLanguages.tsx');
  assert.match(sheet, /const lang = languageName\(l\.lang \?\? ''\);/, 'the toasts are not given the language\'s name');
  assert.match(sheet, /const name = code \? languageName\(code\) : tr\('No language'\);/, 'the question is not given the language\'s name');
  const block = sheet.slice(sheet.indexOf('const toggleLang = async'), sheet.indexOf('</Sheet>'));
  const uses = (block.match(/\{ lang(?:: [^,}]*?)?\s*(?=[,}])/g) ?? []).map((u) => u.trim());
  assert.ok(uses.length >= 12, `the Hide/Show keys and the question pass {lang} (${uses.length} found)`);
  for (const u of uses) assert.match(u, /^\{ lang(?:: name)?$/, `a bare language code reaches a sentence: ${u}`);
});

test('two sentences never get a plain space after a CJK full stop', () => {
  assert.equal(sentenceGap('Done.'), ' ');
  assert.equal(sentenceGap('完了しました。'), '', 'a space after a CJK full stop');
  assert.equal(joinSentences('完了しました。', '次へ'), '完了しました。次へ');
  assert.equal(joinSentences('Done.', 'Next'), 'Done. Next');
  // The three places the final string pass found joining with a plain space.
  const sheet = src('components/ExtensionLanguages.tsx');
  assert.match(sheet, /\{joinSentences\(l\.enabled === 1/, 'the Hide question joins its sentences with a plain space');
  const archive = src('components/ArchiveSettings.tsx');
  assert.doesNotMatch(archive, /nothing queued is lost\.'\)\} \$\{tr\(/, 'the desktop archive help joins its sentences with a plain space');
  assert.match(archive, /joinSentences\(tr\('Off pauses every archive; nothing queued is lost\.'\)/);
  const prefs = src('components/ExtensionSettings.tsx');
  assert.doesNotMatch(prefs, /reading progress stays\.'\)\}\{' '\}/, 'the renumber warning joins its sentences with a plain space');
  assert.match(prefs, /\{warn\}\{sentenceGap\(warn\)\}/);
  // v0.53.0's extension sheet: the source count, then what is over the limit (a stray space after 。 in ja and zh).
  const ext = src('components/ExtensionSheet.tsx');
  assert.doesNotMatch(ext, /<span className="text-amber-300"> \{over\}<\/span>/, 'the sheet\'s limit line joins its sentences with a plain space');
  assert.match(ext, /\{over && <>\{sentenceGap\(across\)\}<span className="text-amber-300">\{over\}<\/span><\/>\}/);
});
