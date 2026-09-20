// Forget (Admin → Library → Removed) and the token dialog's 18+ checkbox: the static shape of both.
//
// Forget is the one action in the admin console that rewrites other members' stats and Wrapped and has no
// Put back, so what matters here is the escalation order (Remove → Delete files → Forget) being visible in
// the markup, the dialog saying the OPPOSITE of the Delete-files reassurance, and every sentence reaching
// the locale files. The behaviour itself lives in bff/test/forgetSeries.int.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** Source with comments stripped, so a class or key in a comment cannot satisfy an assertion. */
const code = (src: string) => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');

test('Forget is offered only once nothing on disk could bring the series back', () => {
  // `live_books === 0`, not `filesGone` alone: a hidden row that never had a chapter cannot go through
  // Delete files ("no files on disk") and must not be stuck between the two steps. A live chapter row means
  // bytes on disk, and the server refuses those anyway -- but the chip must not invite the click.
  // Reintroduce by rendering the chip unconditionally, or under `!filesGone(r)`.
  const src = code(read('app/admin/page.tsx'));
  assert.match(src, /\{r\.live_books === 0 && \(\s*<button onClick=\{\(\) => setForget\(r\)\}/, 'the Forget chip is not gated on live_books === 0');
  // ⚠️ Delete files is its exact complement, so a row never carries three chips: at 390 px "Put back ·
  // Delete files · Forget" squeezed a title to 21 px. Reintroduce by gating Delete files on `!filesGone(r)`.
  assert.match(src, /\{r\.live_books > 0 && \(\s*<button onClick=\{\(\) => setPurge\(r\)\}/, 'Delete files must be offered only while a chapter row still claims a file');
  assert.match(src, /setForget\(r\)\}[^>]*className="chip[^"]*rose-500[^"]*"[^>]*>\{tr\('Forget'\)\}/, 'the Forget chip is not the rose one');
  // and it sits after Delete files in the same button group, so the order reads Put back → Delete files → Forget
  const group = src.slice(src.indexOf("tr('Delete files')"), src.lastIndexOf("tr('Forget')"));
  assert.ok(group.length > 0 && !group.includes('</div>'), 'Forget must sit in the same button group as Delete files, after it');
});

test('the Forget dialog is typed, dangerous, and says what the Delete-files dialog promises is kept', () => {
  // Reintroduce by dropping `confirmText`, `danger`, or either sentence.
  const src = code(read('app/admin/page.tsx'));
  const dlg = src.slice(src.indexOf('{forget && ('), src.indexOf('onClose={() => setForget(null)}'));
  assert.ok(dlg.length > 0, 'no Forget dialog');
  assert.match(dlg, /confirmText=\{forget\.title\}/, 'the title must be typed to confirm');
  assert.match(dlg, /\n\s*danger\n/, 'the confirm button must be the rose one');
  assert.match(dlg, /busy=\{forgetting\}/, 'the button must disable while the request runs');
  assert.ok(dlg.includes("tr(\"This erases the series and everyone's reading history on it — progress, bookmarks, notes, ratings, favourites, tracker links.\")"), 'the first sentence changed');
  assert.ok(dlg.includes("tr('Stats and Wrapped change. If the files ever reappear it comes back as a new series with no history. This cannot be undone.')"), 'the second sentence changed');
  // the refusal's fix reaches the toast, the way Delete files surfaces it
  const fn = src.slice(src.indexOf('const forgetSeries = async'), src.indexOf('setForgetting(false);'));
  assert.match(fn, /if \(b\.fix\) msg = `\$\{b\.message\} \$\{b\.fix\}`/, 'a 409 must show the message AND the fix');
  assert.match(fn, /json: \{ confirm: r\.title \}/, 'the typed title must be sent as the confirmation');
});

test('every string Forget and the token checkbox render is in the locale files, singulars included', () => {
  // Reintroduce by dropping any one of these from es.json (the parity test in library.test.ts then
  // catches the other seven).
  const es = JSON.parse(read('public/locales/es.json'));
  for (const label of ['Forget', 'Forget "{title}" for good?',
                       "This erases the series and everyone's reading history on it — progress, bookmarks, notes, ratings, favourites, tracker links.",
                       'Stats and Wrapped change. If the files ever reappear it comes back as a new series with no history. This cannot be undone.',
                       'Forgotten. Nobody had read it.', "Forgotten. 1 member's history on it is gone.", "Forgotten. {n} members' history on it is gone.",
                       'Could not forget it', 'Include 18+ libraries', '18+']) {
    assert.ok(label in es, `"${label}" renders through tr() but is in no locale file`);
  }
});

test('the typed confirmation label is one sentence with the title inside it, in every language', () => {
  // `tr('Type')` + title + a literal " to confirm" measured "TYPGONE FOR GOOD TO CONFIRM" in German and
  // "النوعGONE FOR GOOD TO CONFIRM" in Arabic: 'Type' translated as the noun (Typ, "the kind"), no space
  // before the title, and the tail in English in every language. One sentence key, split around the
  // placeholder, translates as a sentence. Reintroduce by going back to `{tr('Type')}<span>…</span> to
  // confirm`, or by dropping `{title}` (or the spaces around it) from any locale's translation.
  const src = code(read('components/ConfirmDialog.tsx'));
  assert.match(src, /const \[before, after\] = tr\('Type \{title\} to confirm'\)\.split\('\{title\}'\)/, 'the label is not built from the one sentence key');
  assert.match(src, /\{before\}<span className="[^"]*">\{confirmText\}<\/span>\{after\}/, 'the title must sit between the two halves of the sentence');
  assert.doesNotMatch(src, /tr\('Type'\)/, "the old 'Type' key is still rendered");
  assert.doesNotMatch(src, /<\/span> to confirm/, 'the tail of the sentence is still an English literal');
  const dir = join(ROOT, 'public/locales');
  const sentences = ['Type {title} to confirm', ...readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    return [f, d['Type {title} to confirm']] as const;
  }).map(([f, s]) => { assert.ok(s, `${f} has no translation for the typed-confirmation sentence`); return s as string; })];
  for (const s of sentences) {
    const [before, after] = s.split('{title}');
    assert.ok(after !== undefined, `"${s}" lost its {title} placeholder, so the title would not be shown at all`);
    assert.match(before, /\s$/, `"${s}": no space before the title, it would glue to the word before it`);
    assert.match(after, /^\s/, `"${s}": no space after the title`);
  }
});

test('the typed confirmation compares in NFC, like the route', () => {
  // A macOS-written folder carries "Cafe" + U+0301; a keyboard types U+00E9. Byte for byte they never match,
  // so the button never enabled. routes/admin.ts normalises the same way (its own test is in
  // bff/test/forgetSeries.int.test.ts). Reintroduce by comparing `.trim()` alone.
  const src = code(read('components/ConfirmDialog.tsx'));
  assert.match(src, /typed\.trim\(\)\.normalize\('NFC'\) === confirmText\.trim\(\)\.normalize\('NFC'\)/, 'the dialog compares bytes, not text');
});

test('every string on the Removed row and in the two dialogs is translated, and a long title is not cut to one line on a phone', () => {
  // Measured at 390 ar/de: "Put back", "5 chapters · removed 1d ago" and the intro paragraph were English
  // beside a translated Forget chip, and "Folder:" was English in both dialogs. Reintroduce by rendering any
  // of them as a literal again, or by dropping a key from es.json.
  const src = code(read('app/admin/page.tsx'));
  const panel = src.slice(src.indexOf('function LibraryPanel()'), src.indexOf('function Health()'));
  assert.match(panel, /\{busy === r\.id \? tr\('Restoring…'\) : tr\('Put back'\)\}/, 'the Put back chip is not translated');
  assert.match(panel, /tr\('1 chapter · removed \{when\}'/, 'the singular caption is not translated');
  assert.match(panel, /tr\('\{n\} chapters · removed \{when\}'/, 'the plural caption is not translated');
  assert.equal((panel.match(/\{tr\('Folder'\)\}: <span dir="ltr">\{(purge|forget)\.folder\}<\/span>/g) || []).length, 2, 'both dialogs must translate "Folder" and keep the path LTR');
  assert.match(panel, /\{tr\('Removing a series hides it from the library, search and the updater\./, 'the intro paragraph is not translated');
  assert.doesNotMatch(panel, /\bchapter\{r\.books_count === 1/, 'the caption is still pluralised in JS');
  // The title: two lines on a phone (line-clamp-2), one line with an ellipsis and a tooltip from lg up. A
  // 506 px title against a 168 px column at 390 lost everything after "Kaguya-sama: Love Is War – The",
  // and two long-prefix titles were indistinguishable.
  assert.match(panel, /<p className="[^"]*\bline-clamp-2\b[^"]*\blg:block\b[^"]*\blg:truncate\b[^"]*" title=\{r\.title\}>\{r\.title\}<\/p>/, 'the Removed row title must clamp to two lines on a phone and truncate with a tooltip on a desktop');

  const es = JSON.parse(read('public/locales/es.json'));
  for (const label of ['Type {title} to confirm', 'Put back', 'Restoring…', 'Folder', 'Working…',
                       '1 chapter · removed {when}', '{n} chapters · removed {when}',
                       'Removing a series hides it from the library, search and the updater. Its files are left exactly where they are, and everyone’s reading progress is kept, so putting it back changes nothing else.']) {
    assert.ok(label in es, `"${label}" renders through tr() but is in no locale file`);
  }
  // and the caption that NAMES the chip names its translated label, not the English one
  const gone = es['The chapter files are gone. Put back lists them as deleted from the server; Fetch again on the series page brings back the ones Uchiyomi downloaded.'];
  assert.ok(gone.includes(es['Put back']) && !gone.includes('Put back'), 'the files-gone caption still says «Put back» in English beside a translated chip');
});

test('the token form offers 18+ libraries, off by default, and sends it as showAdult', () => {
  // Without the flag a token -- and so the Komga-compatible API behind Mihon -- never sees the capped
  // libraries, which is the safe default and must stay the default. Reintroduce by `useState(true)`, by
  // dropping `showAdult` from the POST body, or by dropping the list-line marker.
  // Since v0.39.0 the form is the inline one under Profile → Connections → API tokens (ProfileConnections.tsx).
  const src = code(read('components/ProfileConnections.tsx'));
  assert.match(src, /const \[adult, setAdult\] = useState\(false\)/, 'the checkbox must start unchecked');
  assert.match(src, /json: \{ name: name\.trim\(\), scopes, showAdult: adult \}/, 'showAdult is not sent with the mint');
  assert.match(src, /checked=\{adult\}[\s\S]{0,140}?\/>\{tr\('Include 18\+ libraries'\)\}/, 'the checkbox has no label');
  assert.match(src, /t\.showAdult \? ` · \$\{tr\('18\+'\)\}` : ''/, 'the list does not show which tokens see 18+');
  assert.match(src, /setAdmin\(false\); setAdult\(false\); setOpen\(false\)/, 'the form must reset the checkbox after a mint');
});
