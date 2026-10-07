// Every word the app shows goes through tr() (v0.55.7).
//
// localeCoverage.test.ts holds every key the app hands to tr() to all eight locale files. It cannot see a word that
// never reaches tr(), and that is how this release still found ~150 of them in English in every language: the
// Updates and History empty states, the sign-in screen, Admin → Members and Admin → Content → Art, a dozen toasts,
// the reader's page names, Home's greeting, the cards' NEW. This reads the source for the places such a word lives --
// text between JSX tags, a literal an expression between tags shows, what a toast (or a refusal's fallback, or the
// sign-in form's error) says, and a UI attribute -- and fails on any that is a bare English literal. A word with no
// business being translated (a brand, a key cap, a unit, a request shown as code) is named in an allowlist with why.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}
const SOURCES = ['app', 'components', 'lib'].flatMap((d) => walk(join(ROOT, d))).map((f) => relative(ROOT, f));

/**
 * Whether a `/` after `before` starts a regex literal rather than a division: after an operator, an arrow or `return`.
 * Never after `<` or before `>`: those are a closing tag's `</` and a self-closing `/>`.
 */
const regexMayStart = (before: string, after = ''): boolean =>
  after !== '>' && /(^|[(,=:[!&|?{};+\-*%~^]|=>|\breturn|\btypeof|\bcase)\s*$/.test(before.slice(-40));

/**
 * The index just past the string, template or regex literal at `i`, or -1 when none starts there. A template's
 * `${…}` is code, walked with the same rules, so a quote or a regex inside one cannot end it early.
 */
function skipLiteral(s: string, i: number): number {
  const c = s[i];
  if (c === "'" || c === '"') {
    let j = i + 1;
    while (j < s.length && s[j] !== c && s[j] !== '\n') j += s[j] === '\\' ? 2 : 1;
    return j + 1;
  }
  if (c === '`') {
    let j = i + 1;
    while (j < s.length && s[j] !== '`') {
      if (s[j] === '\\') { j += 2; continue; }
      if (s[j] === '$' && s[j + 1] === '{') { j = closeOf(s, j + 1) + 1; continue; }
      j++;
    }
    return j + 1;
  }
  if (c === '/' && s[i + 1] !== '/' && s[i + 1] !== '*' && regexMayStart(s.slice(0, i), s[i + 1])) return skipRegex(s, i);
  return -1;
}

/** The index just past the regex literal whose opening `/` is at `i`: to its closing slash, past escapes and classes. */
function skipRegex(s: string, i: number): number {
  let j = i + 1;
  let cls = false;
  while (j < s.length && s[j] !== '\n') {
    if (s[j] === '\\') { j += 2; continue; }
    if (s[j] === '[') cls = true;
    else if (s[j] === ']') cls = false;
    else if (s[j] === '/' && !cls) break;
    j++;
  }
  return j + 1;
}

/** The index of the bracket that closes the one at `open` (`(`, `[` or `{`), past literals. */
function closeOf(s: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < s.length) {
    const past = skipLiteral(s, i);
    if (past >= 0) { i = past; continue; }
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && --depth === 0) return i;
    i++;
  }
  return s.length;
}

/**
 * The source with its comments blanked to spaces (line numbers kept) and its literals left alone.
 *
 * ⚠️ Regex literals are read as literals: `/^https?:\/\//` holds a `//` that a plain comment stripper takes for a
 * comment, and blanking the rest of that line drops the `>` closing the JSX tag it sits in (app/admin/page.tsx's
 * Health links) -- after which every word to the end of the file reads as text between tags.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    // A literal is copied whole (a comment inside a template's `${…}` is rare enough to leave). Whether a `/` opens a
    // regex is read from what is left of the line once comments are gone.
    const past = c === '/' ? (regexMayStart(out, d) ? skipRegex(src, i) : -1) : skipLiteral(src, i);
    if (past >= 0) { out += src.slice(i, past); i = past; continue; }
    out += c;
    i++;
  }
  return out;
}

/**
 * Every run of text between JSX tags, with its line: a reader of the source just good enough for this app's TSX.
 * A `<` opens an element only where an expression may start (after `(`, `,`, `?`, `:`, `=`, `&&`, `return`…) and
 * not as a generic (`<T,>(…)`); an element's type arguments (`<Choice<Goal> …>`) and attributes are skipped, its
 * `{…}` children are code again, and its text runs to the next `<` or `{`.
 */
function jsxTexts(src: string): { line: number; text: string }[] {
  return jsxRead(src).texts;
}

/** The text runs between tags, and the source of every `{…}` child, each with its line. */
function jsxRead(src: string): { texts: { line: number; text: string }[]; children: { line: number; expr: string }[] } {
  const s = stripComments(src);
  const out: { line: number; text: string }[] = [];
  const children: { line: number; expr: string }[] = [];
  const lineAt = (i: number) => s.slice(0, i).split('\n').length;
  /** Code from `from` to `end`, entering every element it opens. */
  const code = (from: number, end: number): void => {
    let i = from;
    while (i < end) {
      const past = skipLiteral(s, i);
      if (past >= 0) {
        // A template's `${…}` may hold elements: walk them.
        if (s[i] === '`') for (let j = i + 1; j < past - 1; j++) if (s[j] === '$' && s[j + 1] === '{') { const c = closeOf(s, j + 1); code(j + 2, c); j = c; }
        i = past;
        continue;
      }
      if (s[i] === '<' && /[A-Za-z>]/.test(s[i + 1] ?? '')) {
        const before = s.slice(Math.max(0, i - 12), i).replace(/\s+$/, '');
        const generic = /^<[A-Za-z_$][\w$.]*\s*(,|extends\b)/.test(s.slice(i, i + 80));
        if (!generic && (before === '' || /[(),?:=&|>}{[;]$/.test(before) || /\b(return|default)$/.test(before))) {
          i = element(i);
          continue;
        }
      }
      i++;
    }
  };
  const element = (start: number): number => {
    let k = start + 1;
    const name = /^[A-Za-z_$][\w$.:-]*/.exec(s.slice(k, k + 80));
    if (name) {
      k += name[0].length;
      if (s[k] === '<') { let depth = 0; while (k < s.length) { if (s[k] === '<') depth++; else if (s[k] === '>' && --depth === 0) { k++; break; } k++; } }
    }
    while (k < s.length && s[k] !== '>') {
      if (s[k] === '{') { const c = closeOf(s, k); code(k + 1, c); k = c + 1; continue; }
      if (s[k] === '"' || s[k] === "'") { k = skipLiteral(s, k); continue; }
      k++;
    }
    if (s[k - 1] === '/') return k + 1;
    k++;
    while (k < s.length) {
      if (s[k] === '<') {
        if (s[k + 1] === '/') { while (k < s.length && s[k] !== '>') k++; return k + 1; }
        k = element(k);
        continue;
      }
      if (s[k] === '{') { const c = closeOf(s, k); children.push({ line: lineAt(k), expr: s.slice(k + 1, c) }); code(k + 1, c); k = c + 1; continue; }
      let m = k;
      while (m < s.length && s[m] !== '<' && s[m] !== '{') m++;
      const text = s.slice(k, m).replace(/\s+/g, ' ').trim();
      if (text) out.push({ line: lineAt(k), text });
      k = m;
    }
    return k;
  };
  code(0, s.length);
  return { texts: out, children };
}

/** Where `s` holds each top-level `?` (a conditional's), `:`, `||`, `??` and `&&`, past literals and brackets. */
function operators(s: string): { op: string; at: number }[] {
  const ops: { op: string; at: number }[] = [];
  let i = 0;
  while (i < s.length) {
    const past = skipLiteral(s, i);
    if (past >= 0) { i = past; continue; }
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') { i = closeOf(s, i) + 1; continue; }
    const two = s.slice(i, i + 2);
    if (two === '||' || two === '??' || two === '&&') { ops.push({ op: two, at: i }); i += 2; continue; }
    if (c === '?' && s[i + 1] !== '.') ops.push({ op: '?', at: i });
    else if (c === ':') ops.push({ op: ':', at: i });
    i++;
  }
  return ops;
}

/**
 * What an expression can evaluate to, where that is a literal: the branches of its conditionals, either side of its
 * `||` and `??`, the last of its `&&`. A call (`tr(…)`), a name or an element is no literal, so a condition such as
 * `t.scopes.includes('admin')` or `r.error === 'busy'` never counts -- only what would be shown. A template literal
 * is its text with every `${…}` taken out.
 */
function literalLeaves(expr: string): string[] {
  let e = expr.trim();
  while (e.startsWith('(') && closeOf(e, 0) === e.length - 1) e = e.slice(1, -1).trim();
  const ops = operators(e);
  const q = ops.find((o) => o.op === '?');
  if (q) {
    // Its `:` is the first one after it that no nested conditional claims.
    let depth = 0;
    let colon = -1;
    for (const o of ops) {
      if (o.at <= q.at) continue;
      if (o.op === '?') depth++;
      else if (o.op === ':') { if (depth === 0) { colon = o.at; break; } depth--; }
    }
    return colon < 0 ? [] : [...literalLeaves(e.slice(q.at + 1, colon)), ...literalLeaves(e.slice(colon + 1))];
  }
  const or = ops.filter((o) => o.op === '||' || o.op === '??');
  if (or.length) return [-2, ...or.map((o) => o.at)].map((at, n, all) => e.slice(at + 2, n + 1 < all.length ? all[n + 1] : e.length)).flatMap(literalLeaves);
  const and = ops.filter((o) => o.op === '&&');
  if (and.length) return literalLeaves(e.slice(and[and.length - 1].at + 2));
  if ((e[0] === "'" || e[0] === '"') && skipLiteral(e, 0) === e.length) return [e.slice(1, -1)];
  if (e[0] === '`' && skipLiteral(e, 0) === e.length) {
    let text = '';
    for (let j = 1; j < e.length - 1; j++) {
      if (e[j] === '$' && e[j + 1] === '{') { j = closeOf(e, j + 1); text += ' '; continue; }
      text += e[j];
    }
    return [text.trim()];
  }
  return [];
}

/** A brand and a unit, by their letters: the MangaDex card's `title="MangaDex"`, the reader's page gap in `px`. */
const NOT_WORDS = new Set(['MangaDex', 'px']);
/** The words an expression would show untranslated. */
const bareWords = (expr: string): string[] =>
  literalLeaves(expr).filter((w) => /[A-Za-z]{2,}/.test(w) && !NOT_WORDS.has(w.replace(/[^A-Za-z]/g, '')));

/** The arguments of every call to `name(` in `s`, as source, with where the call is. */
function callArgs(s: string, name: string): { at: number; args: string[] }[] {
  const found: { at: number; args: string[] }[] = [];
  for (const m of s.matchAll(new RegExp(`(?<![.\\w])${name}\\(`, 'g'))) {
    const open = m.index! + m[0].length - 1;
    const close = closeOf(s, open);
    const inner = s.slice(open + 1, close);
    const args: string[] = [];
    let from = 0;
    let i = 0;
    while (i < inner.length) {
      const past = skipLiteral(inner, i);
      if (past >= 0) { i = past; continue; }
      const c = inner[i];
      if (c === '(' || c === '[' || c === '{') { i = closeOf(inner, i) + 1; continue; }
      if (c === ',') { args.push(inner.slice(from, i)); from = i + 1; }
      i++;
    }
    args.push(inner.slice(from));
    found.push({ at: m.index!, args: args.map((a) => a.trim()) });
  }
  return found;
}

/** The `key: value` pairs of an object literal's source (`{ … }`), split at its top-level commas. */
function props(obj: string): { key: string; value: string }[] {
  const inner = obj.slice(1, closeOf(obj, 0));
  const out: { key: string; value: string }[] = [];
  let from = 0;
  let i = 0;
  const push = (end: number) => {
    const m = /^\s*['"]?([\w-]+)['"]?\s*:([\s\S]*)$/.exec(inner.slice(from, end));
    if (m) out.push({ key: m[1], value: m[2].trim() });
  };
  while (i < inner.length) {
    const past = skipLiteral(inner, i);
    if (past >= 0) { i = past; continue; }
    const c = inner[i];
    if (c === '(' || c === '[' || c === '{') { i = closeOf(inner, i) + 1; continue; }
    if (c === ',') { push(i); from = i + 1; }
    i++;
  }
  push(inner.length);
  return out;
}

/** Text between tags that is not a word to translate, with where and why. */
const NOT_TEXT: { file: string; text: string; why: string }[] = [
  { file: 'components/CommandPalette.tsx', text: 'esc', why: 'the key cap of the Escape key, as keyboards print it' },
  { file: 'components/Brand.tsx', text: 'uchiyomi', why: 'the wordmark' },
  { file: 'app/admin/page.tsx', text: 'Uchiyomi', why: 'the product name before its version at the foot of the admin menu' },
];

/** Literals a `{…}` child shows that are not words to translate, with where and why. */
const NOT_SHOWN: { file: string; text: string; why: string }[] = [
  { file: 'components/AdminSettings.tsx', text: 'POST', why: 'the install count\'s request, shown as the code it is' },
  { file: 'components/ProfileConnections.tsx', text: 'me', why: 'the username to type for OPDS when the account has none: a login, typed as is' },
];

test('the reader of the source finds text between tags, and only there', () => {
  // A scan that finds nothing passes everything. Each case is one this app's files have: reintroduce the comment
  // stripper without regex literals and "a regex holding // in a tag hides its text" fails; drop the generic check and
  // "a generic arrow is not an element" fails.
  const texts = (src: string) => jsxTexts(src).map((t) => t.text);
  assert.deepEqual(texts('const a = (<p className="x">Hello there <b>{name}</b> friend</p>);'), ['Hello there', 'friend']);
  assert.deepEqual(texts('const ok = /^https?:\\/\\//.test(h);\nconst a = (<a {...(ok ? {} : {})}>Open it</a>);'), ['Open it'], 'a regex holding // hides the text after it');
  assert.deepEqual(texts('const a = (<a {...(/^https?:\\/\\//.test(h) ? {} : {})}>Open it</a>);'), ['Open it'], 'a regex holding // in a tag hides its text');
  assert.deepEqual(texts('const f = useCallback(<T,>(r: Record<string, T>) => r, []);\nconst x = 1;'), [], 'a generic arrow is not an element');
  assert.deepEqual(texts('return (<Choice<Goal> label={tr("Goal")} value={g} />);'), [], 'type arguments are read as text');
  assert.deepEqual(texts('return <>{a ? <span>Yes</span> : <span>{tr("No")}</span>}</>;'), ['Yes']);
  assert.deepEqual(texts('for (let i = 0; i < n; i++) x = a<b ? 1 : 2;'), [], 'a comparison is read as a tag');
  // And on the app itself: the allowlisted words are found where they are, so the scan reaches those files.
  for (const w of NOT_TEXT) {
    assert.ok(jsxTexts(read(w.file)).some((t) => t.text.includes(w.text)), `${w.file}: "${w.text}" is not found -- the scan does not reach it`);
  }
  // What an expression shows, and what it only tests.
  assert.deepEqual(literalLeaves("r.error === 'busy' ? tr('Already running') : 'Failed'"), ['Failed'], 'a code compared against is a word');
  assert.deepEqual(literalLeaves("t.scopes.includes('admin') ? tr('admin') : null"), []);
  assert.deepEqual(literalLeaves('`${updated} · ${gone}`'), ['·']);
  assert.deepEqual(literalLeaves("next === null ? 'No age limit' : `Limited to ${next}+ and below`"), ['No age limit', 'Limited to  + and below']);
  assert.deepEqual(literalLeaves("String(e?.message || '').replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '') || tr('Could not')"), []);
  assert.deepEqual(literalLeaves("a ? 'One' : b ? 'Two' : 'Three'"), ['One', 'Two', 'Three']);
  assert.deepEqual(literalLeaves("ok && 'Shown'"), ['Shown']);
});

test('no text between JSX tags is bare English', () => {
  // Reintroduce any of this release's: `<h2 …>Cover &amp; banner health</h2>` in Admin → Art, `‹ Back` on the sign-in
  // screen, the cards' `NEW`: "bare English between tags" fails naming the file and line.
  const bare: string[] = [];
  for (const f of SOURCES.filter((p) => p.endsWith('.tsx'))) {
    for (const t of jsxTexts(read(f))) {
      if (!/[A-Za-z]{2,}/.test(t.text)) continue;
      if (NOT_TEXT.some((w) => w.file === f && t.text.replace(/[^A-Za-z]/g, '') === w.text)) continue;
      bare.push(`${f}:${t.line} ${t.text.slice(0, 60)}`);
    }
  }
  assert.deepEqual(bare, [], `bare English between tags: ${bare.join(' | ')}`);
});

test('no expression between JSX tags shows a bare English literal', () => {
  // `{busy ? 'Creating…' : 'Create account'}`, `{r.series_title || 'Unknown series'}`, `{mode === 'setup' ? 'Welcome —
  // create your admin account.' : 'Your library, your way.'}`: words chosen in code and shown as they are. Reintroduce
  // any of them: "shows English" fails naming the file and line.
  const bare: string[] = [];
  for (const f of SOURCES.filter((p) => p.endsWith('.tsx'))) {
    for (const c of jsxRead(read(f)).children) {
      const words = bareWords(c.expr).filter((w) => !NOT_SHOWN.some((n) => n.file === f && n.text === w.replace(/\\[nrt]/g, ' ').replace(/[^A-Za-z]/g, '')));
      if (words.length) bare.push(`${f}:${c.line} ${words.join(' / ').slice(0, 60)}`);
    }
  }
  assert.deepEqual(bare, [], `shows English: ${bare.join(' | ')}`);
});

test('every toast, refusal fallback and sign-in error is said through tr()', () => {
  // Reintroduce `toast('All caught up', 'success')` on Updates, `msgOf(e, 'Could not restore it')` in Admin →
  // Library, or `setErrMsg('Passwords do not match.')` on the sign-in screen: "says English" fails for it.
  const bare: string[] = [];
  const CALLS: { name: string; arg: number }[] = [{ name: 'toast', arg: 0 }, { name: 'msgOf', arg: 1 }, { name: 'setErrMsg', arg: 0 }];
  for (const f of SOURCES) {
    const s = stripComments(read(f));
    for (const { name, arg } of CALLS) {
      for (const c of callArgs(s, name)) {
        const words = c.args[arg] ? bareWords(c.args[arg]) : [];
        if (words.length) bare.push(`${f}:${s.slice(0, c.at).split('\n').length} ${name}(${words.join(' / ')})`);
      }
    }
  }
  assert.deepEqual(bare, [], `says English: ${bare.join(' | ')}`);
  // The walk reaches the calls it is about: one of each, from this release's own.
  const updates = stripComments(read('app/updates/page.tsx'));
  assert.ok(callArgs(updates, 'toast').some((c) => c.args[0] === "tr('All caught up')"), 'the toast scan does not reach Updates');
});

/** Placeholders that are examples of what to type, never words: a URL, an address, a Home Assistant service. */
const EXAMPLE = /^(https?:\/\/|notify\.)/;
/** Attributes that show or say words. `label`, `sub`, `help` and `body` are this app's own components'. */
const UI_ATTRS = ['aria-label', 'title', 'placeholder', 'alt', 'confirmLabel', 'label', 'sub', 'body', 'description', 'help', 'hint'];

test('no UI attribute is bare English', () => {
  // Reintroduce the reader's `aria-label={bookmarked ? 'Remove bookmark' : 'Bookmark this page'}`, the Updates empty
  // state's `title="You're all caught up"` or its `cta={{ href: '/library', label: 'Browse library' }}`, or the Remove
  // dialog's `confirmLabel="Remove"`: "bare English in an attribute" fails for it.
  const bare: string[] = [];
  let seen = 0;
  for (const f of SOURCES.filter((p) => p.endsWith('.tsx'))) {
    const s = stripComments(read(f));
    for (const m of s.matchAll(/\s([A-Za-z][\w-]*)=(["{])/g)) {
      const at = m.index! + m[0].length - 1;
      const value = m[2] === '"' ? s.slice(at, skipLiteral(s, at)) : s.slice(at + 1, closeOf(s, at));
      // An object handed over whole, as EmptyState's `cta={{ href, label }}`: its own words are its `label` and `title`.
      const object = m[2] === '{' && value.trim().startsWith('{') && closeOf(value.trim(), 0) === value.trim().length - 1;
      if (!UI_ATTRS.includes(m[1]) && !object) continue;
      seen++;
      const own = object ? props(value.trim()).filter((p) => /^(label|title|text)$/.test(p.key)).map((p) => p.value) : [value];
      const words = own.flatMap(bareWords).filter((w) => !EXAMPLE.test(w));
      if (words.length) bare.push(`${f}:${s.slice(0, m.index!).split('\n').length} ${m[1]}=${words.join(' / ')}`);
    }
  }
  assert.deepEqual(bare, [], `bare English in an attribute: ${bare.join(' | ')}`);
  assert.ok(seen > 300, `only ${seen} UI attributes found -- the scan is broken`);
});

test('a sentence is translated whole, never as a fragment glued to what follows it', () => {
  // `tr('Your power day was')<span>{day}</span>`, `tr('Currently')<span>{folder}</span>` and `tr('Series with')<strong>no
  // rating stay visible</strong>…` read "Your power day wasTuesday", "Currentlymanga/…" and "Series withno rating" in
  // English, and every other language had half a sentence. Each is one key now, split around its placeholder where a
  // part of it is styled. Reintroduce any of the three fragments: this fails.
  const wrapped = stripComments(read('app/wrapped/page.tsx'));
  const series = stripComments(read('app/series/page.tsx'));
  const admin = stripComments(read('app/admin/page.tsx'));
  assert.doesNotMatch(wrapped, /tr\('Your power day was'\)/, 'the power day is a fragment again');
  assert.match(wrapped, /const \[dayBefore, dayAfter\] = tr\('Your power day was \{day\}'\)\.split\('\{day\}'\)/);
  assert.match(wrapped, /\{dayBefore\}<span className="[^"]*">\{tr\(DOW\[data\.busiestDow\]\)\}<\/span>\{dayAfter\}/);
  assert.doesNotMatch(series, /tr\('Currently'\)/, 'the folder rename says "Currently" glued to the folder again');
  assert.match(series, /const \[currentlyBefore, currentlyAfter\] = tr\('Currently: \{folder\}'\)\.split\('\{folder\}'\)/);
  assert.doesNotMatch(admin, /tr\('Series with'\)/, 'the age limit note is a fragment again');
  assert.match(admin, /<strong className="text-fog-300">\{tr\('Series with no rating stay visible\.'\)\}<\/strong>\{' '\}/);
  // A split needs its placeholder exactly once in every language, or a part of the sentence is lost.
  for (const f of readdirSync(join(ROOT, 'public/locales')).filter((n) => n.endsWith('.json'))) {
    const d = JSON.parse(read(`public/locales/${f}`)) as Record<string, string>;
    for (const [k, p] of [['Your power day was {day}', '{day}'], ['Currently: {folder}', '{folder}']]) {
      assert.equal(d[k]?.split(p).length, 2, `${f}: "${k}" does not hold ${p} exactly once`);
    }
  }
});

test('words that reach tr() through a variable are declared, and said in the reader\'s language', () => {
  // Wrapped's weekdays were `tr(DOW[i])` over a plain array, so no locale had them: English in every language.
  // Reintroduce the plain array: "the weekdays are not declared" fails, and localeCoverage stops asking for them.
  assert.match(read('app/wrapped/page.tsx'), /const DOW = keys\('Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'\);/,
    'the weekdays are not declared through keys()');
  // The sign-in screen's SSO refusals were a table of English sentences; each is said through tr() when it is said.
  const login = stripComments(read('components/LoginScreen.tsx'));
  assert.doesNotMatch(login, /SSO_ERRORS/, 'the SSO refusals are an English table again');
  for (const reason of ['no_account', 'username_taken', 'disabled', 'expired', 'state_mismatch', 'exchange_failed', 'oidc_unavailable', 'access_denied']) {
    assert.match(login, new RegExp(`case '${reason}': return tr\\('`), `the SSO refusal "${reason}" is not said through tr()`);
  }
  // A series' status was `status.toLowerCase()` on the series page and the home hero: "ongoing" in every language.
  for (const f of ['app/series/page.tsx', 'components/HeroCarousel.tsx']) {
    const src = stripComments(read(f));
    assert.doesNotMatch(src, /status\.toLowerCase\(\)/, `${f} prints a series' status in English again`);
    assert.match(src, /statusText\((meta|cur\.metadata)\.status\)/, `${f} does not say the status through statusText`);
  }
});

test('a sign-in refusal is said by its code first, in the reader\'s words', () => {
  // The server's own sentence for a disabled or locked account and a wrong code is English, and it came first, so the
  // translated sentences after it were never shown. Reintroduce `body.message ||` ahead of the codes: this fails.
  const auth = stripComments(read('lib/auth.tsx'));
  const login = auth.slice(auth.indexOf("if (body.error === 'totp_required')"), auth.indexOf('return { ok: false, error: msg }'));
  assert.match(login, /const msg =\s*body\.error === 'invalid_credentials' \? tr\('Incorrect username or password\.'\)/, 'a sign-in refusal is not read by its code first');
  assert.match(login, /: body\.message \|\| tr\('Login failed — please try again\.'\);/, 'the server\'s sentence is not the last resort');
  const setup = auth.slice(auth.indexOf('const firstRunSetup'), auth.indexOf('const logout'));
  assert.match(setup, /body\.error === 'already_configured' \? tr\('This server is already set up\.'\)/);
  assert.match(setup, /: body\.message \|\| tr\('Setup failed — please try again\.'\);/);
});
