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
 * `accept="image/*"` (series/page.tsx) as the start of a comment and deletes everything up to the next `*\/`
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
  // stripComments: series/page.tsx loses the strings after its `accept="image/*"` and "a key after
  // image/* in series/page.tsx" fails.
  const keys = appKeys();
  assert.ok(keys.size >= 1300, `only ${keys.size} keys found -- the scan is broken`);
  assert.ok(keys.get('Library')?.has('components/BottomNav.tsx (keys)'), 'the bottom nav\'s keys() labels are not scanned');
  assert.ok(keys.get('Needs attention')?.has('lib/status.ts (keys)'), 'a keys() array in lib/ is not scanned');
  assert.ok(keys.has('Up to {n} minutes'), 'an inline tr() in lib/ is not scanned');
  assert.ok(keys.has('Not asked: enough other sources already list this series'), 'an inline tr() in components/ is not scanned');
  const series = readFileSync(join(ROOT, 'app/series/page.tsx'), 'utf8');
  const after = series.slice(series.indexOf('accept="image/*"'));
  const later = after.match(/\btr\('((?:[^'\\\n]|\\.)*)'/);
  assert.ok(later && keys.has(unescape(later[1])), 'a key after image/* in series/page.tsx is not scanned');
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
/** Verbs and determiners that agree with the count, singular → plural. */
const AGREE: Record<string, string> = {
  has: 'have', is: 'are', was: 'were', needs: 'need', comes: 'come', does: 'do', keeps: 'keep', fails: 'fail',
  goes: 'go', lands: 'land', stays: 'stay', matches: 'match', qualifies: 'qualify', it: 'they', its: 'their', this: 'these',
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
  // One try has no "since" (i18n pass 1): the singular says when it was, the plural since when.
  'Tried once, at {time} · next try {when}': 'Tried {n} times since {time} · next try {when}',
};
/** Keys that look counted and are not a pair, each with why. Not a place to park a new key. */
const NOT_PAIRED: Record<string, string> = {
  '1 to 64 letters, digits, - or _': 'a range, not a count',
  'Up to {n} hours': 'etaLine says hours only past 90 minutes, rounded up: never 1',
  // One whole sentence per status (FindMissingDialog healthLine), each with its streak inside.
  'rate-limited us {n} times in a row': 'shown only when consecutive > 1; one time is the bare status',
  'refused us {n} times in a row': 'shown only when consecutive > 1; one time is the bare status',
  'did not answer {n} times in a row': 'shown only when consecutive > 1; one time is the bare status',
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
  'Delete {n} chapters from the server?', 'File {n} series',
  'From now on, an hourly job will permanently delete the file of any chapter that everyone who started it has finished, once it has been finished for {n} days. There is no undo and no recycle bin.',
  'Merge these {n} pairs?', 'Merged — {n} chapters moved', 'One pair merged, {m} chapters moved', 'Reading pace, busiest day {n} chapters',
  'Syncing {n} series you have already finished…',
  'This one stops working in {n} days. You can revoke it sooner.',
  'Tip: hide the languages you don’t read first — only {n} sources can be switched on at once.',
  '{n} chapters behind across {m} series', '{n} days', '{n} days of reading, {t} chapters in total', '{n} languages', '{n} notes',
  '{n} of {m} chapters match', '{n} of {m} sources answered · still asking {names}', '{n} of {m} sources answered · still asking {name}',
  '{n} pairs could not be merged', '{n} pairs merged, {m} chapters moved', '{n} series', '{n} series would move',
  '{n} sources in {m} providers', '{n} versions', 'quiet — no release in {n} days', 'waiting for {g} · {n} days left',
  'failed {n} times',
  '{n} titles matched', '{n} chapters', '{n} sources', '{n} pages', '{n} chapters listed', '{n} chapters listed · none fetched yet',
  '{n} chapters saved', '{n} chapters qualify right now.', '{n} chapters qualify today and would go on the first run.', '{n} saved pages',
  'Fetch {n} chapters again?', '{n} fewer chapters than the current pick',
];
/** What SHIPPED_UNPAIRED may hold at most: lower it with every entry fixed, never raise it. */
const SHIPPED_UNPAIRED_MAX = 43;

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
    if (NOT_PAIRED[k] || SHIPPED_UNPAIRED.includes(k)) continue;
    if (IRREGULAR_PAIRS[k]) { if (!keys.has(IRREGULAR_PAIRS[k])) lonely.push(`${k} has no plural (${IRREGULAR_PAIRS[k]})`); continue; }
    if (Object.values(IRREGULAR_PAIRS).includes(k)) continue;
    for (const c of counts(k)) {
      // A plural half is `{n}` before a plural noun; `{n} failed` pairs with "1 failed" but is not asked to.
      if (!c.one && !/^\p{Ll}+s$/u.test(c.word)) continue;
      if (!otherHalf(all, k, c.at, c.one)) lonely.push(`${k} has no ${c.one ? 'plural' : 'singular'}`);
    }
  }
  assert.deepEqual(lonely, [], `counted strings without their other half: ${lonely.join(' | ')}`);
  // The matcher itself: the whole key, not its first noun.
  const probe = ['1 chapter behind', '{n} chapters saved', '{n} chapters behind', '1 older chapter not here', '{n} older chapters not here',
    '1 source needs a look', '{n} sources need a look', '1 chapter saved.', '{n} chapters saved,'];
  assert.equal(otherHalf(probe, '{n} chapters saved', 0, false), undefined, 'the guard pairs keys that are not each other\'s');
  assert.equal(otherHalf(probe, '{n} chapters behind', 0, false), '1 chapter behind');
  assert.equal(otherHalf(probe, '{n} older chapters not here', 0, false), '1 older chapter not here', 'a two-word noun is not paired');
  assert.equal(otherHalf(probe, '{n} sources need a look', 0, false), '1 source needs a look', 'the verb agreeing with the count is not allowed for');
  assert.equal(otherHalf(probe, '1 chapter saved.', 0, true), undefined, 'punctuation that differs paired');
  // The lists only shrink: an entry whose key is gone (or was paired) is deleted, not kept as a hole.
  for (const k of [...Object.keys(NOT_PAIRED), ...SHIPPED_UNPAIRED, ...Object.keys(IRREGULAR_PAIRS)]) {
    assert.ok(keys.has(k), `${k} is no longer in the app: drop it from the list`);
  }
  for (const k of SHIPPED_UNPAIRED) {
    const c = counts(k).filter((x) => !x.one);
    assert.ok(c.length && c.some((x) => !otherHalf(all, k, x.at, false)), `${k} has its singular now: delete it from SHIPPED_UNPAIRED`);
  }
  // Frozen, and held to it: a new lone plural cannot be parked here. Lower this as entries are fixed.
  assert.ok(SHIPPED_UNPAIRED.length <= SHIPPED_UNPAIRED_MAX, `SHIPPED_UNPAIRED grew to ${SHIPPED_UNPAIRED.length}: give the new key its singular instead`);
});
