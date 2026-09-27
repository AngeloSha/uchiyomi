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
  assert.ok(keys.has('Not asked: enough sources already had it'), 'an inline tr() in components/ is not scanned');
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
