// Every string the app translates is translated, in all eight languages (v0.49.0).
//
// Until this, coverage was checked per feature: a test that knew its own file's keys (healthActions,
// addSeriesDialog, …) and nothing for the other hundred files. So 30 strings shipped as English in every
// language without a single test failing -- the reader's repeated-page controls, the Moments page's remove,
// Find missing's source-health line, the offline banner. This scans the whole app instead: every `tr('…')`
// literal and every `keys(…)` array under app/, components/ and lib/ must be a non-empty entry in every
// locale file, with its `{placeholders}` kept. A key IS its English string, so a missing one renders as
// English rather than breaking -- which is exactly why nobody notices without this.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * The source with its comments blanked and its strings left alone.
 *
 * ⚠️ Not the `code()` regex the other tests use. Its `/\*[\s\S]*?\*\/` reads the `/*` inside
 * `accept="image/*"` (components/SeriesEditor.tsx) as the start of a comment and deletes everything up to the next `*\/`
 * -- which, over the whole app, would silently drop real keys from this scan. This walks the characters
 * instead, so a `//` or `/*` inside a string is left as the string it is. Comments go because several quote
 * the code they forbid (ConfirmDialog.tsx says `tr('Type')` in one).
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (c === "'" || c === '"' || c === '`') {
      // A quoted string ends at its own quote, or (for ' and ") at the end of the line -- so an apostrophe in
      // JSX text can at worst hide the rest of its own line from comment blanking, never the file.
      let j = i + 1;
      while (j < src.length && src[j] !== c && (c === '`' || src[j] !== '\n')) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const unescape = (s: string): string =>
  s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\(['"\\])/g, '$1');
const LITERAL = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g;

/** Every key the app hands to tr(): inline literals, and the literals inside `keys(…)` declarations. */
function appKeys(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const add = (k: string, where: string) => { if (!found.has(k)) found.set(k, new Set()); found.get(k)!.add(where); };
  for (const dir of ['app', 'components', 'lib']) {
    for (const f of walk(join(ROOT, dir))) {
      const src = stripComments(readFileSync(f, 'utf8'));
      const rel = relative(ROOT, f);
      for (const m of src.matchAll(/\btr\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g)) add(unescape(m[1] ?? m[2]), rel);
      // `keys(` as a call of its own -- not `Object.keys(`, not `usePaletteHotkeys(` -- read to its closing
      // paren, which may be lines away.
      for (const m of src.matchAll(/(?<![.\w])keys\(/g)) {
        let depth = 1;
        let j = m.index! + m[0].length;
        const start = j;
        while (j < src.length && depth) {
          const ch = src[j];
          if (ch === "'" || ch === '"') { const q = ch; j++; while (j < src.length && src[j] !== q) j += src[j] === '\\' ? 2 : 1; }
          else if (ch === '(') depth++;
          else if (ch === ')') depth--;
          j++;
        }
        for (const lit of src.slice(start, j - 1).matchAll(LITERAL)) add(unescape(lit[1] ?? lit[2]), `${rel} (keys)`);
      }
    }
  }
  return found;
}

const placeholders = (s: string) => [...new Set(s.match(/\{\w+\}/g) ?? [])].sort().join(' ');

test('the scan itself sees the app: inline keys, keys() arrays, and nothing from comments', () => {
  // A scan that silently finds nothing passes everything. Reintroduce the naive block-comment regex in
  // stripComments: everything after an `accept="image/*"` up to the next comment's end is lost, and "a key after
  // image/* is not scanned" fails.
  const keys = appKeys();
  assert.ok(keys.size >= 1300, `only ${keys.size} keys found -- the scan is broken`);
  assert.ok(keys.get('Library')?.has('components/BottomNav.tsx (keys)'), 'the bottom nav\'s keys() labels are not scanned');
  assert.ok(keys.get('Needs attention')?.has('lib/status.ts (keys)'), 'a keys() array in lib/ is not scanned');
  assert.ok(keys.has('Up to {n} minutes'), 'an inline tr() in lib/ is not scanned');
  assert.ok(keys.has('Not asked: enough other sources already list this series'), 'an inline tr() in components/ is not scanned');
  // The case on a snippet of its own: the app's one such string (Edit details' file input, v0.53.0) is the last thing
  // in its file, where the naive regex finds no comment end to run to and so eats nothing a real scan would miss.
  const tricky = '<input accept="image/*" hidden />\n<p>{tr(\'After the accept\')}</p>\n{/* a comment */}\n';
  assert.match(stripComments(tricky), /tr\('After the accept'\)/, 'a key after image/* is not scanned');
  assert.doesNotMatch(stripComments(tricky), /a comment/, 'a comment after it is scanned as code');
  assert.ok(readFileSync(join(ROOT, 'components/SeriesEditor.tsx'), 'utf8').includes('accept="image/*"'), 'no file input left to make this case real');
  assert.ok(!keys.has('Type'), 'a key quoted only in a comment (ConfirmDialog.tsx) is scanned as if it were used');
});

test('every key the app translates is in all eight locale files, non-empty, with its placeholders kept', () => {
  // Reintroduce by deleting "Worth a look" (or any key) from public/locales/ar.json: "ar.json is missing 1
  // of the app's strings: Worth a look" fails. Rename `{n}` to `{count}` in one translation and "keeps the
  // key's placeholders" fails for it: the number would never be filled in.
  const keys = appKeys();
  const files = readdirSync(join(ROOT, 'public/locales')).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(files, ['ar.json', 'de.json', 'es.json', 'fr.json', 'ja.json', 'pt-BR.json', 'ru.json', 'zh.json']);
  for (const f of files) {
    const dict = JSON.parse(readFileSync(join(ROOT, 'public/locales', f), 'utf8')) as Record<string, unknown>;
    const missing: string[] = [];
    const broken: string[] = [];
    for (const k of keys.keys()) {
      const v = dict[k];
      if (typeof v !== 'string' || !v.trim()) { missing.push(k); continue; }
      if (placeholders(v) !== placeholders(k)) broken.push(`${k} => ${v}`);
    }
    assert.deepEqual(missing, [], `${f} is missing ${missing.length} of the app's strings: ${missing.slice(0, 15).map((k) => `${k} [${[...keys.get(k)!][0]}]`).join(' | ')}`);
    assert.deepEqual(broken, [], `${f} does not keep the key's placeholders: ${broken.slice(0, 10).join(' | ')}`);
  }
});

/*
 * Counted strings come in pairs, `n === 1 ? tr('1 chapter') : tr('{n} chapters', { n })` -- otherwise English
 * reads "1 chapters" and no translator ever sees the singular. A count that reads as a word is a standalone
 * `1` before a word, or `{n}` / `{m}` before a plural noun. Its pair is the WHOLE key with the count swapped:
 * the same words before it, and after it the same words but for one noun in its other number, within the
 * first three words ("1 chapter saved" / "{n} chapters saved", "1 older chapter" / "{n} older chapters"), and
 * one verb that agrees with it ("1 needs" / "{n} need"). Only the text before the count and the first noun
 * used to be compared, so "1 chapter behind" paired every "{n} chapters …" key in the app.
 */
const COUNT = /(^|[\s(+—·])(1|\{[nm]\}) (\p{L}+)/gu;
const counts = (k: string) => [...k.matchAll(COUNT)].map((m) => ({ at: m.index! + m[1].length, one: m[2] === '1', word: m[3] }));

/** English number: `one` singular, `many` its plural. */
const numberPair = (one: string, many: string) =>
  many === `${one}s` || many === `${one}es` || (one.endsWith('y') && many === `${one.slice(0, -1)}ies`)
  || (one.endsWith("'s") && many === `${one.slice(0, -2)}s'`);
/**
 * A count before a participle or "not" is asked for its pair too: English does not inflect "2 checked" or "3 not switched
 * on", but most of the eight languages agree them with the count ("1 vérifiés", "1 non activées" in French; the v0.49.1
 * translation review found both).
 */
const AGREES_ABROAD = /^(\p{Ll}+ed|not)$/u;
/**
 * So does a count before a state word that ends its phrase: "2 languages · 1 on" on Admin → Providers' cards read
 * "1 activadas", "1 activées", "1 ativas" (the v0.52.0 check pass). "{n} on server" is a place and agrees with nothing,
 * so the word must end the key or come before a separator.
 */
const STATE_WORD = /^(on|off)$/u;
const endsPhrase = (k: string, at: number): boolean => /^(?:1|\{[nm]\}) \p{L}+(?:$|\s*[·.,;:)!?—])/u.test(k.slice(at));
/** Whether a count asks for its other half: a plural noun, a participle or "not", or a state word ending the phrase. */
const asksPair = (k: string, c: { at: number; one: boolean; word: string }): boolean =>
  c.one || /^\p{Ll}+s$/u.test(c.word) || AGREES_ABROAD.test(c.word) || (STATE_WORD.test(c.word) && endsPhrase(k, c.at));
/**
 * Keys with such a count that shipped before that rule, each reading wrong at 1 in some language. ⚠️ Frozen like
 * SHIPPED_UNPAIRED: fix one by adding its singular and deleting it here, never by adding to it. Empty since v0.52.0,
 * which gave the last nine their singulars (web/lib/counted.ts), and kept so: a new one is a failure, not an entry.
 */
const AGREEING_UNPAIRED: string[] = [];
const AGREEING_UNPAIRED_MAX = 0;
/** Verbs and determiners that agree with the count, singular → plural. */
const AGREE: Record<string, string> = {
  has: 'have', is: 'are', was: 'were', needs: 'need', comes: 'come', does: 'do', keeps: 'keep', fails: 'fail',
  goes: 'go', lands: 'land', stays: 'stay', matches: 'match', qualifies: 'qualify', it: 'they', its: 'their', this: 'these',
  // v0.49.1, Health's own sentences (lib/said.ts).
  waits: 'wait', contains: 'contain', uses: 'use', appears: 'appear', shares: 'share', holds: 'hold', belongs: 'belong',
};
/** A word and the punctuation after it, apart. */
const split = (w: string) => { const m = /^(.*?)([.,;:!?…)]*)$/u.exec(w)!; return { core: m[1], tail: m[2] }; };
/** Does `many` read as `one` after its count went from 1 to more: word for word, but one noun's number and one agreeing verb. */
function tailsPair(one: string[], many: string[]): boolean {
  if (one.length !== many.length) return false;
  let noun = false; let verb = false;
  for (let i = 0; i < one.length; i++) {
    if (one[i] === many[i]) continue;
    const a = split(one[i]); const b = split(many[i]);
    if (a.tail !== b.tail) return false;
    if (!noun && i < 3 && numberPair(a.core, b.core)) { noun = true; continue; }
    if (!verb && AGREE[a.core] === b.core) { verb = true; continue; }
    return false;
  }
  return true;
}
/** The other half of `k`'s count at `at`: a key with the same text before the count and a tail that pairs. */
function otherHalf(all: readonly string[], k: string, at: number, one: boolean): string | undefined {
  const before = k.slice(0, at);
  const after = k.slice(at).replace(/^(1|\{[nm]\}) /, '').split(' ');
  return all.find((o) => {
    if (o === k || !o.startsWith(before)) return false;
    const m = /^(1|\{[nm]\}) /.exec(o.slice(at));
    if (!m || (m[1] === '1') === one) return false;
    const theirs = o.slice(at + m[0].length).split(' ');
    return one ? tailsPair(after, theirs) : tailsPair(theirs, after);
  });
}

/** Pairs English inflects around the count as well as after it, named explicitly: singular → plural. */
const IRREGULAR_PAIRS: Record<string, string> = {
  '1 is not listed yet and comes with the next check.': '{m} are not listed yet and come with the next check.',
  '1 chapter behind': '{n} chapters behind in 1 series',
  '{n} chapters behind in 1 series': '{n} chapters behind across {m} series',
  'Ch. {n} · 1 older chapter not here yet': 'Ch. {a}–{b} · {n} older chapters not here yet',
  '1 page is a placeholder; the chapter sweep re-fetches it': '{n} pages are placeholders; the chapter sweep re-fetches them',
  'Ch. {n} · 1 chapter being archived slowly': 'Ch. {a}–{b} · {n} chapters being archived slowly',
  'Ch. {n} · 1 chapter in a paused slow archive': 'Ch. {a}–{b} · {n} chapters in a paused slow archive',
  // One try has no "since" (i18n pass 1): the singular says when it was, the plural since when.
  'Tried once, at {time} · next try {when}': 'Tried {n} times since {time} · next try {when}',
  // v0.49.1, Health's own sentences (lib/said.ts): two or three words agree with the count.
  '1 lost its primary but still follows another': '{n} lost their primary but still follow another',
  'left out 1 folder or file it could not read': 'left out {n} folders or files it could not read',
  '1 folder belongs to series someone removed, and was left alone; Admin → Library puts a series back.':
    '{n} folders belong to series someone removed, and were left alone; Admin → Library puts a series back.',
  '1 folder is more than {max} levels deep and was not looked into (LIBRARY_MAX_DEPTH)':
    '{n} folders are more than {max} levels deep and were not looked into (LIBRARY_MAX_DEPTH)',
  '1 series that came from extensions keeps its chapters and gets no new ones until it is back':
    '{n} series that came from extensions keep their chapters and get no new ones until it is back',
  'the library still marks it deleted, and no scan has read the file since':
    'the library still marks these {n} deleted, and no scan has read the files since',
  // v0.50.0, The same chapter saved twice: the Fix all confirmation, "this series" against "these {n} series".
  'Delete the later copies in this series?': 'Delete the later copies in these {n} series?',
  // v0.53.0, Source health's Turn off all: what it asks first, "this source" against "these {n} sources" (v0.54.0: the
  // place it names is Admin → Sources).
  'Turn off this source? No series uses it. You can turn it back on in Admin → Sources.':
    'Turn off these {n} sources? No series uses them. You can turn them back on in Admin → Sources.',
  // v0.54.0, Admin → Sources: a source's Turn off, and the Replace dialog's head and plan, where "it" and "its" agree too.
  '1 series uses it. It stops getting new chapters from this source until you turn it back on. Nothing is deleted.':
    '{n} series use it. They stop getting new chapters from this source until you turn it back on. Nothing is deleted.',
  '1 series uses it as its main source': '{n} series use it as their main source',
  '1 already follows a working source: it becomes its main source.': '{n} already follow a working source: it becomes their main source.',
  '1 numbered by posting order stays as it is.': '{n} numbered by posting order stay as they are.',
  // v0.52.0, the last of AGREEING_UNPAIRED: one chapter is "the" chapter, not "all 1".
  'Delete the downloaded chapter of “{title}”?': 'Delete all {n} downloaded chapters of “{title}”?',
  'Delete the downloaded chapter on this device?': 'Delete all {n} downloaded chapters on this device?',
};
/** Keys that look counted and are not a pair, each with why. Not a place to park a new key. */
const NOT_PAIRED: Record<string, string> = {
  '1 to 64 letters, digits, - or _': 'a range, not a count',
  'Up to {n} hours': 'etaLine says hours only past 90 minutes, rounded up: never 1',
  // One whole sentence per status (FindMissingDialog healthLine), each with its streak inside.
  'rate-limited us {n} times in a row': 'shown only when consecutive > 1; one time is the bare status',
  'refused us {n} times in a row': 'shown only when consecutive > 1; one time is the bare status',
  'did not answer {n} times in a row': 'shown only when consecutive > 1; one time is the bare status',
  // v0.49.1 (lib/said.ts): a duplicate row names its copies only past two (bff lib/health.ts duplicateSeries).
  '{n} copies — merge them one pair at a time': 'said only for three copies or more: never 1',
  'Switched off after {n} failed deliveries in a row. Fix it, then switch it back on.':
    'a target switches itself off only at bff notify AUTO_DISABLE_AFTER (10) failures in a row: never 1',
  // v0.54.0: its singular, "1 language", was Providers' MangaDex group and the old MangaDex card's, both gone.
  '{n} languages': 'extLanguagesText names the one language instead (lib/extensions.ts): said only for two or more',
};
/**
 * Plural keys that shipped before this check with no singular. Each reads "1 …s" at a count of 1 (or its
 * count cannot reach 1). ⚠️ Frozen: fix one by adding its singular and deleting it here, never by adding to it.
 * The last twelve were hidden by the first version of this check, which paired them with an unrelated key
 * ("{n} chapters saved" with "1 chapter saved with pages missing"); they are as old as the rest.
 */
const SHIPPED_UNPAIRED = [
  '+{n} chapters vs the current pick', 'All {n} chapters are already in your library', 'Best {n} days',
  'Checking {n} sources — this can take a minute. You can close this; anything followed shows under Sources & translations.',
  'File {n} series',
  'From now on, an hourly job will permanently delete the file of any chapter that everyone who started it has finished, once it has been finished for {n} days. There is no undo and no recycle bin.',
  'Merge these {n} pairs?', 'Merged — {n} chapters moved', 'One pair merged, {m} chapters moved', 'Reading pace, busiest day {n} chapters',
  'Syncing {n} series you have already finished…',
  'This one stops working in {n} days. You can revoke it sooner.',
  '{n} chapters behind across {m} series', '{n} days', '{n} days of reading, {t} chapters in total',
  '{n} of {m} chapters match', '{n} of {m} sources answered · still asking {names}', '{n} of {m} sources answered · still asking {name}',
  '{n} pairs could not be merged', '{n} pairs merged, {m} chapters moved', '{n} series would move',
  '{n} versions', 'quiet — no release in {n} days', 'waiting for {g} · {n} days left',
  'failed {n} times',
  '{n} titles matched', '{n} chapters listed', '{n} chapters listed · none fetched yet',
  '{n} chapters saved', '{n} chapters qualify right now.', '{n} chapters qualify today and would go on the first run.',
  'Fetch {n} chapters again?', '{n} fewer chapters than the current pick',
];
/** What SHIPPED_UNPAIRED may hold at most: lower it with every entry fixed, never raise it. */
const SHIPPED_UNPAIRED_MAX = 33;

test('counted strings come in pairs: every "1 chapter" has its "{n} chapters", and back', () => {
  // Reintroduce by deleting the singular of a pair from the app -- `tr('Refreshed — 1 extension available')`
  // in admin/page.tsx becomes the plural for every count: "Refreshed — {n} extensions available has no
  // singular" fails; the reverse, a lone "1 …" key, fails as "has no plural". Reintroduce the old looser
  // match (the text before the count and the first noun only): "1 chapter behind" pairs every "{n} chapters
  // …" key again, and "the guard pairs keys that are not each other's" fails.
  const keys = appKeys();
  const all = [...keys.keys()];
  const lonely: string[] = [];
  for (const k of all) {
    if (NOT_PAIRED[k] || SHIPPED_UNPAIRED.includes(k) || AGREEING_UNPAIRED.includes(k)) continue;
    if (IRREGULAR_PAIRS[k]) { if (!keys.has(IRREGULAR_PAIRS[k])) lonely.push(`${k} has no plural (${IRREGULAR_PAIRS[k]})`); continue; }
    if (Object.values(IRREGULAR_PAIRS).includes(k)) continue;
    for (const c of counts(k)) {
      // A plural half is `{n}` before a plural noun; `{n} failed` pairs with "1 failed" but is not asked to.
      if (!asksPair(k, c)) continue;
      if (!otherHalf(all, k, c.at, c.one)) lonely.push(`${k} has no ${c.one ? 'plural' : 'singular'}`);
    }
  }
  assert.deepEqual(lonely, [], `counted strings without their other half: ${lonely.join(' | ')}`);
  // A state word asks for its pair only where it ends the phrase. Reintroduce the old rule (no STATE_WORD): "{n} on
  // is not asked for its 1-form" fails here, and without onText's '1 on' the loop above fails as "{n} on has no singular".
  const ask = (k: string) => counts(k).some((c) => !c.one && asksPair(k, c));
  assert.equal(ask('{n} on'), true, '{n} on is not asked for its 1-form');
  assert.equal(ask('2 languages · {n} on'), true);
  assert.equal(ask('{n} off · 2 sources'), true);
  assert.equal(ask('{n} on server'), false, 'a place ("on server") is asked to agree');
  // The matcher itself: the whole key, not its first noun.
  const probe = ['1 chapter behind', '{n} chapters saved', '{n} chapters behind', '1 older chapter not here', '{n} older chapters not here',
    '1 source needs a look', '{n} sources need a look', '1 chapter saved.', '{n} chapters saved,'];
  assert.equal(otherHalf(probe, '{n} chapters saved', 0, false), undefined, 'the guard pairs keys that are not each other\'s');
  assert.equal(otherHalf(probe, '{n} chapters behind', 0, false), '1 chapter behind');
  assert.equal(otherHalf(probe, '{n} older chapters not here', 0, false), '1 older chapter not here', 'a two-word noun is not paired');
  assert.equal(otherHalf(probe, '{n} sources need a look', 0, false), '1 source needs a look', 'the verb agreeing with the count is not allowed for');
  assert.equal(otherHalf(probe, '1 chapter saved.', 0, true), undefined, 'punctuation that differs paired');
  // The lists only shrink: an entry whose key is gone (or was paired) is deleted, not kept as a hole.
  for (const k of [...Object.keys(NOT_PAIRED), ...SHIPPED_UNPAIRED, ...AGREEING_UNPAIRED, ...Object.keys(IRREGULAR_PAIRS)]) {
    assert.ok(keys.has(k), `${k} is no longer in the app: drop it from the list`);
  }
  for (const k of SHIPPED_UNPAIRED) {
    const c = counts(k).filter((x) => !x.one);
    assert.ok(c.length && c.some((x) => !otherHalf(all, k, x.at, false)), `${k} has its singular now: delete it from SHIPPED_UNPAIRED`);
  }
  for (const k of AGREEING_UNPAIRED) {
    const c = counts(k).filter((x) => !x.one);
    assert.ok(c.length && c.some((x) => !otherHalf(all, k, x.at, false)), `${k} has its singular now: delete it from AGREEING_UNPAIRED`);
  }
  // Frozen, and held to it: a new lone plural cannot be parked here. Lower this as entries are fixed.
  assert.ok(SHIPPED_UNPAIRED.length <= SHIPPED_UNPAIRED_MAX, `SHIPPED_UNPAIRED grew to ${SHIPPED_UNPAIRED.length}: give the new key its singular instead`);
  assert.ok(AGREEING_UNPAIRED.length <= AGREEING_UNPAIRED_MAX, `AGREEING_UNPAIRED grew to ${AGREEING_UNPAIRED.length}: give the new key its singular instead`);
});
