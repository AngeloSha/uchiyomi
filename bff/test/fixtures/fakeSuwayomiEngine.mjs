// A fake Suwayomi-Server v2.3.2243 extension engine: GraphQL at POST /api/graphql, the REST image paths the
// adapter stores, and a /__mode switch. Dependency-free, so the same file serves two harnesses:
//
//   * bff tests, in-process, through fakeSuwayomi.ts (startFakeSuwayomi);
//   * the browser rig, as a container, through web/test/e2e/fakeEngine.mjs.
//
// WHY IT IS STRICT. The engine's schema is not ours and its documentation is wrong in places (the endpoint path,
// for one), so every query Uchiyomi sends has to be checked against the real thing. This fake validates each
// query against suwayomi-v2.3.2243-schema.json -- a full introspection of the pinned image, deprecated members
// included -- and answers an unknown field, argument, input field, enum value or type exactly as the engine
// does: HTTP 200, an `errors` array, no `data`, and graphql-java's own wording. A field that exists on the real
// engine but that this fake does not serve is refused LOUDLY ("FAKE ENGINE: ... not implemented"), never
// answered with a guess. ⚠️ extensionRepos.int.test.ts learned why: its first fake was lenient, every test
// passed, and the candidate shipped three real bugs, each hidden by one difference between fake and engine.
//
// WHAT WAS MEASURED. Each behaviour below was observed on a disposable, network-less container of
// ghcr.io/suwayomi/suwayomi-server:v2.3.2243 (2026-09-27), or read from its bytecode where no extension could
// be installed offline:
//   * validation errors: status 200, `{"errors":[{message, locations, extensions:{}}]}`, and no data key;
//   * a failing data fetcher: `{"data":{"<field>":null},"errors":[{message, locations, path}]}`, where the
//     message is "Exception while fetching data (/<path>) : <exception message>\r\n\r\n<stack trace>" -- the
//     stack trace is part of the message, and a null exception message prints as "null";
//   * a non-null root field that resolves null (source(id) for an unknown id): the long graphql-java
//     "was declared as a non null type" error, and no data at all;
//   * fetchChapters returns rows ordered by sourceOrder ascending, sourceOrder = index + 1 over the
//     extension's list reversed (the extension lists newest first, so 1 is the oldest post); an unparsed
//     chapter number is -1; pageCount is -1 until the pages were fetched; uploadDate is epoch milliseconds
//     and fetchedAt epoch SECONDS, both as strings (LongString);
//   * page paths are /api/v1/manga/<mangaId>/chapter/<sourceOrder>/page/<n> -- the chapter's sourceOrder,
//     not its id -- and thumbnails /api/v1/manga/<id>/thumbnail; source icons are the extension's
//     /api/v1/extension/icon/<pkgName>;
//   * fetchManga / fetchChapters / fetchChapterPages on an unknown id: "Collection is empty."
//     (java.util.NoSuchElementException); fetchSourceManga on an unknown source: a NullPointerException;
//   * updateSourcePreference (Source.setSourcePreference, v2.3.2243): the position indexes the preference
//     screen built by the LAST read of that source's preferences -- there is none before the first read, which
//     is a NullPointerException; an out-of-range position is an IndexOutOfBoundsException; a DISABLED
//     preference is silently left alone; the value is taken from the one state field matching the
//     preference's class, and a missing one is "Expected change to <Class>"; a list value is NOT checked
//     against entryValues; the answer rebuilds the screen;
//   * setSettings changes only the fields given non-null, and checks no URL.
//   * clearCachedImages deletes the directory of each kind asked for with `true` (cachedPages = manga-cache,
//     every page the engine has served) and answers `true` for it -- also when there was nothing to delete --
//     and `null` for each kind not asked for, `false` included; the other kinds are left alone.
// What is modelled rather than measured is marked where it happens (the extension's own stack frames, the
// Webtoons numbering rule, the image failure status).
//
// ⚠️ NOT FOR REPOSITORY FLOWS. setSettings stores extensionRepos, and fetchExtensions / extensions answer the
// seeded catalogue whatever the repositories say. The real engine applies an added repository asynchronously,
// lists its own spelling after a restart, and marks an installed extension no repository offers as obsolete --
// three behaviours extensionRepos.int.test.ts measured and models, each of which hid a shipped bug behind a
// fake that ignored it. A test of adding, removing or refreshing repositories uses that file's fake, not this.
//
// Not modelled either: graphql-java's overlap and uniqueness rules (FieldsConflict, duplicate arguments,
// fields, fragments, variables or directives, a directive in the wrong place). A query that breaks one is
// refused by the engine and answered here, so do not lean on the fake to catch those.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

export const SCHEMA_FILE = new URL('./suwayomi-v2.3.2243-schema.json', import.meta.url);

// ================================================================================================
// Schema
// ================================================================================================

/** `[String!]!` → {kind:'NON_NULL', of:{kind:'LIST', of:{kind:'NON_NULL', of:{kind:'NAMED', name:'String'}}}}. */
function parseTypeString(s) {
  if (s.endsWith('!')) return { kind: 'NON_NULL', of: parseTypeString(s.slice(0, -1)) };
  if (s.startsWith('[')) return { kind: 'LIST', of: parseTypeString(s.slice(1, -1)) };
  return { kind: 'NAMED', name: s };
}
function printType(t) {
  if (t.kind === 'NON_NULL') return printType(t.of) + '!';
  if (t.kind === 'LIST') return `[${printType(t.of)}]`;
  return t.name;
}
function namedType(t) {
  return t.kind === 'NAMED' ? t : namedType(t.of);
}

function toMember(name, raw) {
  const o = typeof raw === 'string' ? { type: raw } : raw;
  return {
    name,
    type: parseTypeString(o.type),
    typeString: o.type,
    args: new Map(Object.entries(o.args ?? {}).map(([n, a]) => [n, toMember(n, a)])),
    hasDefault: o.default !== undefined,
    defaultLiteral: o.default,
    deprecated: o.deprecated,
  };
}

export class Schema {
  constructor(json) {
    this.engine = json.engine;
    this.roots = json.roots;
    this.types = json.types;
    this.cache = new Map();
  }
  has(name) { return Object.hasOwn(this.types, name); }
  kind(name) { return this.types[name]?.kind; }
  members(name, key) {
    const k = `${key}:${name}`;
    let m = this.cache.get(k);
    if (!m) {
      m = new Map(Object.entries(this.types[name]?.[key] ?? {}).map(([n, v]) => [n, toMember(n, v)]));
      this.cache.set(k, m);
    }
    return m;
  }
  fields(name) { return this.members(name, 'fields'); }
  inputFields(name) { return this.members(name, 'inputFields'); }
  enumValues(name) { return this.types[name]?.values ?? []; }
  isLeaf(name) { const k = this.kind(name); return k === 'SCALAR' || k === 'ENUM'; }
  isComposite(name) { const k = this.kind(name); return k === 'OBJECT' || k === 'INTERFACE' || k === 'UNION'; }
  isInput(name) { const k = this.kind(name); return k === 'SCALAR' || k === 'ENUM' || k === 'INPUT_OBJECT'; }
  /** The object types a value of `name` can be at runtime. */
  possible(name) { return this.kind(name) === 'OBJECT' ? [name] : this.types[name]?.possibleTypes ?? []; }
}

let defaultSchema = null;
export function loadSchema(file = SCHEMA_FILE) {
  if (file === SCHEMA_FILE && defaultSchema) return defaultSchema;
  const s = new Schema(JSON.parse(readFileSync(file, 'utf8')));
  if (file === SCHEMA_FILE) defaultSchema = s;
  return s;
}

// ================================================================================================
// Parsing (the GraphQL executable-document grammar, enough of it for every query a client sends)
// ================================================================================================

export class GqlSyntaxError extends Error {
  constructor(message, loc) { super(message); this.loc = loc; }
}

const PUNCT = new Set(['!', '$', '&', '(', ')', ':', '=', '@', '[', ']', '{', '|', '}']);
const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;
const NAME = /[_A-Za-z][_0-9A-Za-z]*/y;

function lex(src) {
  const toks = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const bad = (text) => {
    throw new GqlSyntaxError(`Invalid syntax with ANTLR error 'token recognition error at: '${text}'' at line ${line} column ${i - lineStart + 1}`,
      { line, column: i - lineStart + 1 });
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { i++; line++; lineStart = i; continue; }
    if (c === '\r') { i++; if (src[i] === '\n') i++; line++; lineStart = i; continue; }
    if (c === ' ' || c === '\t' || c === ',' || c === '﻿') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++; continue; }
    const loc = { line, column: i - lineStart + 1 };
    if (c === '.') {
      if (!src.startsWith('...', i)) bad(c);
      toks.push({ kind: 'punct', value: '...', text: '...', loc }); i += 3; continue;
    }
    if (PUNCT.has(c)) { toks.push({ kind: 'punct', value: c, text: c, loc }); i++; continue; }
    NAME.lastIndex = i;
    const nm = NAME.exec(src);
    if (nm) { toks.push({ kind: 'name', value: nm[0], text: nm[0], loc }); i += nm[0].length; continue; }
    NUMBER.lastIndex = i;
    const num = NUMBER.exec(src);
    if (num) {
      toks.push({ kind: num[1] || num[2] ? 'float' : 'int', value: num[0], text: num[0], loc });
      i += num[0].length;
      continue;
    }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        const start = i;
        i += 3;
        let raw = '';
        while (i < src.length && !src.startsWith('"""', i)) {
          if (src.startsWith('\\"""', i)) { raw += '"""'; i += 4; continue; }
          if (src[i] === '\n') { line++; lineStart = i + 1; }
          raw += src[i++];
        }
        if (i >= src.length) bad('"""');
        i += 3;
        toks.push({ kind: 'string', value: blockString(raw), text: src.slice(start, i), loc });
        continue;
      }
      const start = i;
      i++;
      let out = '';
      for (;;) {
        if (i >= src.length || src[i] === '\n' || src[i] === '\r') bad('"');
        const ch = src[i];
        if (ch === '"') { i++; break; }
        if (ch === '\\') {
          const e = src[i + 1];
          const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (e in map) { out += map[e]; i += 2; continue; }
          if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) {
            out += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)); i += 6; continue;
          }
          bad('\\' + (e ?? ''));
        }
        out += ch;
        i++;
      }
      toks.push({ kind: 'string', value: out, text: src.slice(start, i), loc });
      continue;
    }
    bad(c);
  }
  toks.push({ kind: 'eof', value: '<EOF>', text: '<EOF>', loc: { line, column: i - lineStart + 1 } });
  return toks;
}

/** The spec's BlockStringValue: common indentation and blank first/last lines removed. */
function blockString(raw) {
  const lines = raw.split(/\r\n|\n|\r/);
  let common = null;
  for (const l of lines.slice(1)) {
    const ind = l.length - l.trimStart().length;
    if (ind < l.length && (common === null || ind < common)) common = ind;
  }
  const out = lines.map((l, i) => (i && common ? l.slice(common) : l));
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join('\n');
}

class Parser {
  constructor(src) { this.toks = lex(src); this.p = 0; }
  get tok() { return this.toks[this.p]; }
  fail(t = this.tok) {
    throw new GqlSyntaxError(`Invalid syntax with offending token '${t.text}' at line ${t.loc.line} column ${t.loc.column}`, t.loc);
  }
  isPunct(v) { return this.tok.kind === 'punct' && this.tok.value === v; }
  isName(v) { return this.tok.kind === 'name' && (v === undefined || this.tok.value === v); }
  punct(v) { if (!this.isPunct(v)) this.fail(); return this.toks[this.p++]; }
  name() { if (!this.isName()) this.fail(); return this.toks[this.p++]; }

  document() {
    const definitions = [];
    do definitions.push(this.definition()); while (this.tok.kind !== 'eof');
    return { definitions };
  }
  definition() {
    const t = this.tok;
    if (this.isPunct('{')) {
      return { kind: 'operation', operation: 'query', name: null, variableDefinitions: [], directives: [], selectionSet: this.selectionSet(), loc: t.loc };
    }
    if (this.isName('query') || this.isName('mutation') || this.isName('subscription')) {
      this.p++;
      const name = this.isName() ? this.name().value : null;
      const variableDefinitions = this.isPunct('(') ? this.variableDefinitions() : [];
      const directives = this.directives();
      return { kind: 'operation', operation: t.value, name, variableDefinitions, directives, selectionSet: this.selectionSet(), loc: t.loc };
    }
    if (this.isName('fragment')) {
      this.p++;
      const n = this.name();
      if (n.value === 'on') this.fail(n);
      if (!this.isName('on')) this.fail();
      this.p++;
      const typeCondition = this.namedTypeRef();
      return { kind: 'fragment', name: n.value, typeCondition, directives: this.directives(), selectionSet: this.selectionSet(), loc: t.loc };
    }
    return this.fail();
  }
  variableDefinitions() {
    this.punct('(');
    const out = [];
    do {
      const d = this.punct('$');
      const name = this.name().value;
      this.punct(':');
      const type = this.typeRef();
      let defaultValue;
      if (this.isPunct('=')) { this.p++; defaultValue = this.value(true); }
      out.push({ name, type, defaultValue, directives: this.directives(), loc: d.loc });
    } while (!this.isPunct(')'));
    this.p++;
    return out;
  }
  namedTypeRef() { const t = this.name(); return { kind: 'NAMED', name: t.value, loc: t.loc }; }
  typeRef() {
    let t;
    if (this.isPunct('[')) {
      const open = this.punct('[');
      t = { kind: 'LIST', of: this.typeRef(), loc: open.loc };
      this.punct(']');
    } else {
      t = this.namedTypeRef();
    }
    if (this.isPunct('!')) { this.p++; t = { kind: 'NON_NULL', of: t, loc: t.loc }; }
    return t;
  }
  selectionSet() {
    this.punct('{');
    const out = [];
    do out.push(this.selection()); while (!this.isPunct('}'));
    this.p++;
    return out;
  }
  selection() {
    const t = this.tok;
    if (this.isPunct('...')) {
      this.p++;
      if (this.isName() && this.tok.value !== 'on') {
        const n = this.name();
        return { kind: 'spread', name: n.value, directives: this.directives(), loc: t.loc };
      }
      let typeCondition = null;
      if (this.isName('on')) { this.p++; typeCondition = this.namedTypeRef(); }
      return { kind: 'inline', typeCondition, directives: this.directives(), selectionSet: this.selectionSet(), loc: t.loc };
    }
    const first = this.name();
    let alias = null;
    let name = first.value;
    if (this.isPunct(':')) { this.p++; alias = first.value; name = this.name().value; }
    const args = this.isPunct('(') ? this.arguments(false) : [];
    const directives = this.directives();
    const selectionSet = this.isPunct('{') ? this.selectionSet() : null;
    return { kind: 'field', alias, name, arguments: args, directives, selectionSet, loc: first.loc };
  }
  arguments(isConst) {
    this.punct('(');
    const out = [];
    do {
      const n = this.name();
      this.punct(':');
      out.push({ name: n.value, value: this.value(isConst), loc: n.loc });
    } while (!this.isPunct(')'));
    this.p++;
    return out;
  }
  directives() {
    const out = [];
    while (this.isPunct('@')) {
      const at = this.punct('@');
      const name = this.name().value;
      out.push({ name, arguments: this.isPunct('(') ? this.arguments(false) : [], loc: at.loc });
    }
    return out;
  }
  value(isConst) {
    const t = this.tok;
    if (this.isPunct('$')) {
      if (isConst) this.fail();
      this.p++;
      return { kind: 'Variable', name: this.name().value, loc: t.loc };
    }
    if (t.kind === 'int') { this.p++; return { kind: 'Int', value: t.value, loc: t.loc }; }
    if (t.kind === 'float') { this.p++; return { kind: 'Float', value: t.value, loc: t.loc }; }
    if (t.kind === 'string') { this.p++; return { kind: 'String', value: t.value, loc: t.loc }; }
    if (t.kind === 'name') {
      this.p++;
      if (t.value === 'true' || t.value === 'false') return { kind: 'Boolean', value: t.value === 'true', loc: t.loc };
      if (t.value === 'null') return { kind: 'Null', loc: t.loc };
      return { kind: 'Enum', value: t.value, loc: t.loc };
    }
    if (this.isPunct('[')) {
      this.p++;
      const values = [];
      while (!this.isPunct(']')) values.push(this.value(isConst));
      this.p++;
      return { kind: 'List', values, loc: t.loc };
    }
    if (this.isPunct('{')) {
      this.p++;
      const fields = [];
      while (!this.isPunct('}')) {
        const n = this.name();
        this.punct(':');
        fields.push({ name: n.value, value: this.value(isConst), loc: n.loc });
      }
      this.p++;
      return { kind: 'Object', fields, loc: t.loc };
    }
    return this.fail();
  }
}

export function parse(src) {
  return new Parser(String(src)).document();
}

/** An AST value the way graphql-java's toString() prints it inside validation messages. */
function printAst(v) {
  switch (v.kind) {
    case 'Int': return `IntValue{value=${v.value}}`;
    case 'Float': return `FloatValue{value=${v.value}}`;
    case 'String': return `StringValue{value='${v.value}'}`;
    case 'Boolean': return `BooleanValue{value=${v.value}}`;
    case 'Null': return 'NullValue{}';
    case 'Enum': return `EnumValue{name='${v.value}'}`;
    case 'Variable': return `VariableReference{name='${v.name}'}`;
    case 'List': return `ArrayValue{values=[${v.values.map(printAst).join(', ')}]}`;
    case 'Object': return `ObjectValue{objectFields=[${v.fields.map((f) => `ObjectField{name='${f.name}', value=${printAst(f.value)}}`).join(', ')}]}`;
    default: return String(v.kind);
  }
}
const JAVA_AST = {
  Int: 'IntValue', Float: 'FloatValue', String: 'StringValue', Boolean: 'BooleanValue', Null: 'NullValue', Enum: 'EnumValue',
  List: 'ArrayValue', Object: 'ObjectValue', Variable: 'VariableReference',
};

// ================================================================================================
// Validation (graphql-java's rule names and messages, as the engine words them)
// ================================================================================================

const DIRECTIVES = { skip: { if: 'Boolean!' }, include: { if: 'Boolean!' } };

/** Which literal kinds each scalar accepts, as graphql-java's coercing does for these five. */
const SCALAR_LITERALS = {
  Int: ['Int'], Float: ['Int', 'Float'], String: ['String'], Boolean: ['Boolean'], LongString: ['String'], Cursor: ['String'],
};

/**
 * Every validation error for `doc`, in document order, each already shaped as the engine answers it. An empty
 * array means the engine would execute the query. `deprecated` (optional) collects the deprecated members the
 * query uses, which the real engine accepts silently.
 */
export function validate(schema, doc, deprecated = []) {
  const errors = [];
  const add = (rule, path, msg, loc) =>
    errors.push({ message: `Validation error (${rule}${path ? `@[${path.join('/')}]` : ''}) : ${msg}`, locations: loc ? [loc] : [], extensions: {} });

  const ops = doc.definitions.filter((d) => d.kind === 'operation');
  const fragments = new Map();
  for (const d of doc.definitions) if (d.kind === 'fragment' && !fragments.has(d.name)) fragments.set(d.name, d);

  /** Variable usages and spreads found while visiting one operation or fragment. */
  const scopes = new Map();

  const possibleOverlap = (a, b) => {
    const pb = new Set(schema.possible(b));
    return schema.possible(a).some((t) => pb.has(t));
  };

  function checkLiteral(value, type, argPath, path, loc, scope, locHasDefault) {
    if (value.kind === 'Variable') {
      scope.usages.push({ name: value.name, expected: type, locHasDefault, path, loc: value.loc });
      return;
    }
    if (type.kind === 'NON_NULL') {
      if (value.kind === 'Null') { add('WrongType', path, `argument '${argPath}' with value '${printAst(value)}' must not be null`, loc); return; }
      checkLiteral(value, type.of, argPath, path, loc, scope, false);
      return;
    }
    if (value.kind === 'Null') return;
    if (type.kind === 'LIST') {
      if (value.kind === 'List') value.values.forEach((v) => checkLiteral(v, type.of, argPath, path, loc, scope, false));
      else checkLiteral(value, type.of, argPath, path, loc, scope, false);
      return;
    }
    const name = type.name;
    const kind = schema.kind(name);
    if (kind === 'INPUT_OBJECT') {
      if (value.kind !== 'Object') { add('WrongType', path, `argument '${argPath}' with value '${printAst(value)}' must be an object type`, loc); return; }
      const fields = schema.inputFields(name);
      const extra = value.fields.find((f) => !fields.has(f.name));
      if (extra) {
        add('WrongType', path, `argument '${argPath}' with value '${printAst(value)}' contains a field not in '${name}': '${extra.name}'`, loc);
        return;
      }
      const missing = [...fields.values()]
        .filter((d) => d.type.kind === 'NON_NULL' && !d.hasDefault && !value.fields.some((f) => f.name === d.name))
        .map((d) => d.name);
      if (missing.length) {
        add('WrongType', path, `argument '${argPath}' with value '${printAst(value)}' is missing required fields '[${missing.join(', ')}]'`, loc);
        return;
      }
      for (const f of value.fields) {
        const d = fields.get(f.name);
        if (d.deprecated !== undefined) deprecated.push(`${name}.${f.name}`);
        checkLiteral(f.value, d.type, `${argPath}.${f.name}`, path, loc, scope, d.hasDefault);
      }
      return;
    }
    if (kind === 'ENUM') {
      const head = `argument '${argPath}' with value '${printAst(value)}' is not a valid '${name}'`;
      if (value.kind !== 'Enum') {
        add('WrongType', path, `${head} - Expected an AST type of 'EnumValue' but it was a '${JAVA_AST[value.kind]}'`, loc);
      } else if (!schema.enumValues(name).includes(value.value)) {
        add('WrongType', path, `${head} - Literal value not in allowable values for enum '${name}' - '${printAst(value)}'`, loc);
      }
      return;
    }
    const allowed = SCALAR_LITERALS[name];
    if (allowed && !allowed.includes(value.kind)) {
      const want = allowed.map((k) => `'${JAVA_AST[k]}'`).join(' or ');
      add('WrongType', path, `argument '${argPath}' with value '${printAst(value)}' is not a valid '${name}' - Expected an AST type of ${want} but it was a '${JAVA_AST[value.kind]}'`, loc);
      return;
    }
    if (name === 'Int' && value.kind === 'Int' && (Number(value.value) > 2147483647 || Number(value.value) < -2147483648)) {
      add('WrongType', path, `argument '${argPath}' with value '${printAst(value)}' is not a valid 'Int' - Expected value to be in the integer range, but it was a '${value.value}'`, loc);
    }
  }

  /** True when a constant (default) value fits `type`; used for variable defaults only. */
  function literalFits(value, type) {
    const probe = { usages: [] };
    const before = errors.length;
    checkLiteral(value, type, 'default', null, null, probe, false);
    const ok = errors.length === before;
    errors.length = before;
    return ok;
  }

  function visitDirectives(directives, path, scope) {
    for (const d of directives) {
      const spec = DIRECTIVES[d.name];
      if (!spec) { add('UnknownDirective', path, `Unknown directive '${d.name}'`, d.loc); continue; }
      for (const a of d.arguments) {
        if (!spec[a.name]) { add('UnknownDirectiveArgument', path, `Unknown directive argument '${a.name}'`, a.loc); continue; }
        checkLiteral(a.value, parseTypeString(spec[a.name]), a.name, path, a.loc, scope, false);
      }
      for (const req of Object.keys(spec)) {
        if (!d.arguments.some((a) => a.name === req)) add('MissingDirectiveArgument', path, `Missing directive argument '${req}'`, d.loc);
      }
    }
  }

  function visitSelections(selections, parent, path, scope) {
    for (const s of selections) {
      if (s.kind === 'field') {
        const fpath = [...path, s.name];
        visitDirectives(s.directives, fpath, scope);
        if (s.name === '__typename') {
          if (s.selectionSet) add('SubselectionNotAllowed', fpath, `Subselection not allowed on leaf type 'String!' of field '__typename'`, s.loc);
          if (s.arguments.length) add('UnknownArgument', fpath, `Unknown field argument '${s.arguments[0].name}'`, s.arguments[0].loc);
          continue;
        }
        // Introspection: the engine answers it and this fake does not serve it, so it is the fake's gap
        // (NotImplemented at execution), never a refusal worded as the engine's.
        if ((s.name === '__schema' || s.name === '__type') && parent === schema.roots.query) continue;
        const def = schema.kind(parent) === 'UNION' ? undefined : schema.fields(parent).get(s.name);
        if (!def) { add('FieldUndefined', fpath, `Field '${s.name}' in type '${parent}' is undefined`, s.loc); continue; }
        if (def.deprecated !== undefined) deprecated.push(`${parent}.${s.name}`);
        for (const [an, ad] of def.args) {
          if (ad.type.kind !== 'NON_NULL' || ad.hasDefault) continue;
          const given = s.arguments.find((a) => a.name === an);
          if (!given) add('MissingFieldArgument', fpath, `Missing field argument '${an}'`, s.loc);
          else if (given.value.kind === 'Null') add('NullValueForNonNullArgument', fpath, `Null value for non-null field argument '${an}'`, s.loc);
        }
        const named = namedType(def.type).name;
        if (schema.isLeaf(named) && s.selectionSet) {
          add('SubselectionNotAllowed', fpath, `Subselection not allowed on leaf type '${def.typeString}' of field '${s.name}'`, s.loc);
        } else if (!schema.isLeaf(named) && !s.selectionSet) {
          add('SubselectionRequired', fpath, `Subselection required for type '${def.typeString}' of field '${s.name}'`, s.loc);
        }
        for (const a of s.arguments) {
          const ad = def.args.get(a.name);
          if (!ad) { add('UnknownArgument', fpath, `Unknown field argument '${a.name}'`, a.loc); continue; }
          if (ad.deprecated !== undefined) deprecated.push(`${parent}.${s.name}(${a.name})`);
          checkLiteral(a.value, ad.type, a.name, fpath, a.loc, scope, ad.hasDefault);
        }
        if (s.selectionSet && !schema.isLeaf(named)) visitSelections(s.selectionSet, named, fpath, scope);
      } else if (s.kind === 'inline') {
        visitDirectives(s.directives, path, scope);
        let target = parent;
        if (s.typeCondition) {
          const cond = s.typeCondition.name;
          if (!schema.has(cond)) { add('UnknownType', path, `Unknown type '${cond}'`, s.typeCondition.loc); continue; }
          if (!schema.isComposite(cond)) {
            add('InlineFragmentTypeConditionInvalid', path, 'Inline fragment type condition is invalid, must be on Object/Interface/Union', s.loc);
            continue;
          }
          if (!possibleOverlap(parent, cond)) {
            add('InvalidFragmentType', path, `Fragment cannot be spread here as objects of type '${parent}' can never be of type '${cond}'`, s.loc);
            continue;
          }
          target = cond;
        }
        visitSelections(s.selectionSet, target, path, scope);
      } else {
        visitDirectives(s.directives, path, scope);
        const frag = fragments.get(s.name);
        if (!frag) { add('UndefinedFragment', path, `Undefined fragment '${s.name}'`, s.loc); continue; }
        scope.spreads.add(s.name);
        const cond = frag.typeCondition.name;
        if (schema.isComposite(cond) && !possibleOverlap(parent, cond)) {
          add('InvalidFragmentType', path, `Fragment '${s.name}' cannot be spread here as objects of type '${parent}' can never be of type '${cond}'`, s.loc);
        }
      }
    }
  }

  const anonymous = ops.filter((o) => !o.name).length;
  const opNames = new Set();
  for (const d of doc.definitions) {
    const scope = { usages: [], spreads: new Set() };
    scopes.set(d, scope);
    if (d.kind === 'operation') {
      if (d.name && anonymous) add('LoneAnonymousOperationViolation', null, `Operation '${d.name}' is following anonymous operation`, d.loc);
      else if (!d.name && ops.length > 1 && ops[0] !== d) add('LoneAnonymousOperationViolation', null, 'Anonymous operation with other operations.', d.loc);
      if (d.name && opNames.has(d.name)) add('DuplicateOperationName', null, `There can be only one operation named '${d.name}'`, d.loc);
      if (d.name) opNames.add(d.name);
      for (const v of d.variableDefinitions) {
        const named = namedType(v.type);
        if (!schema.has(named.name)) add('UnknownType', null, `Unknown type '${named.name}'`, named.loc);
        else if (!schema.isInput(named.name)) add('NonInputTypeOnVariable', null, `Input variable '${v.name}' type '${printType(v.type)}' is not an input type`, v.loc);
        else if (v.defaultValue && !literalFits(v.defaultValue, v.type)) {
          add('BadValueForDefaultArg', null, `Bad default value '${printAst(v.defaultValue)}' for type '${printType(v.type)}'`, v.loc);
        }
      }
      const root = schema.roots[d.operation];
      if (!root) { add('UnknownOperation', null, `The '${d.operation}' operation is not supported by the schema`, d.loc); continue; }
      visitDirectives(d.directives, null, scope);
      visitSelections(d.selectionSet, root, [], scope);
    } else {
      const cond = d.typeCondition.name;
      if (!schema.has(cond)) { add('UnknownType', [d.name], `Unknown type '${cond}'`, d.typeCondition.loc); continue; }
      if (!schema.isComposite(cond)) { add('FragmentTypeConditionInvalid', [d.name], `Fragment type condition is invalid, must be on Object/Interface/Union`, d.loc); continue; }
      visitDirectives(d.directives, [d.name], scope);
      visitSelections(d.selectionSet, cond, [d.name], scope);
    }
  }

  // Variables are judged per operation, through every fragment it reaches.
  const reached = new Set();
  const allowed = (varType, varDefault, loc) => {
    const sub = (a, b) => {
      if (b.kind === 'NON_NULL') return a.kind === 'NON_NULL' && sub(a.of, b.of);
      if (a.kind === 'NON_NULL') return sub(a.of, b);
      if (b.kind === 'LIST') return a.kind === 'LIST' && sub(a.of, b.of);
      if (a.kind === 'LIST') return false;
      return a.name === b.name;
    };
    if (loc.expected.kind === 'NON_NULL' && varType.kind !== 'NON_NULL') {
      const hasDefault = varDefault && varDefault.kind !== 'Null';
      if (!hasDefault && !loc.locHasDefault) return false;
      return sub(varType, loc.expected.of);
    }
    return sub(varType, loc.expected);
  };
  for (const op of ops) {
    const defs = new Map(op.variableDefinitions.map((v) => [v.name, v]));
    const used = new Set();
    const usages = [...scopes.get(op).usages];
    const queue = [...scopes.get(op).spreads];
    const seen = new Set();
    while (queue.length) {
      const f = queue.shift();
      if (seen.has(f)) continue;
      seen.add(f);
      reached.add(f);
      const fd = fragments.get(f);
      if (!fd) continue;
      usages.push(...scopes.get(fd).usages);
      queue.push(...scopes.get(fd).spreads);
    }
    for (const u of usages) {
      const d = defs.get(u.name);
      if (!d) { add('UndefinedVariable', u.path, `Undefined variable '${u.name}'`, u.loc); continue; }
      used.add(u.name);
      if (schema.has(namedType(d.type).name) && !allowed(d.type, d.defaultValue, u)) {
        add('VariableTypeMismatch', u.path, `Variable '${u.name}' of type '${printType(d.type)}' used in position expecting type '${printType(u.expected)}'`, u.loc);
      }
    }
    for (const d of op.variableDefinitions) if (!used.has(d.name)) add('UnusedVariable', null, `Unused variable '${d.name}'`, d.loc);
  }
  for (const [name, f] of fragments) if (!reached.has(name)) add('UnusedFragment', null, `Unused fragment '${name}'`, f.loc);
  return errors;
}

/**
 * Parse and validate one query, and return what the engine would refuse it with: [] when it would run it.
 * The quickest way to prove a query string in product code is shaped right, with no server at all.
 */
export function checkQuery(query, schema = loadSchema()) {
  let doc;
  try { doc = parse(query); } catch (e) {
    if (e instanceof GqlSyntaxError) return [e.message];
    throw e;
  }
  return validate(schema, doc).map((e) => e.message);
}

// ================================================================================================
// Execution
// ================================================================================================

/**
 * An exception thrown inside the engine or the extension, surfaced the way graphql-java surfaces a data
 * fetcher's exception. `javaMessage` null prints as "null", which is what a NullPointerException gives.
 */
export class EngineException extends Error {
  constructor(javaClass, javaMessage, frames = []) {
    super(javaMessage ?? 'null');
    this.javaClass = javaClass;
    this.javaMessage = javaMessage;
    this.frames = frames;
  }
}
/** A field or argument the REAL engine serves and this fake does not. Loud on purpose; see the header. */
export class NotImplemented extends Error {}
class FakeBug extends Error {}
const BUBBLE = Symbol('null bubbles to the parent');

// The coroutine frames every fetch-style mutation ends in on v2.3.2243, as observed.
const COROUTINE_FRAMES = [
  'kotlin.coroutines.jvm.internal.BaseContinuationImpl.resumeWith(ContinuationImpl.kt:34)',
  'kotlinx.coroutines.DispatchedTask.run(DispatchedTask.kt:100)',
  'kotlinx.coroutines.internal.LimitedDispatcher$Worker.run(LimitedDispatcher.kt:124)',
  'kotlinx.coroutines.scheduling.TaskImpl.run(Tasks.kt:89)',
  'kotlinx.coroutines.scheduling.CoroutineScheduler.runSafely(CoroutineScheduler.kt:586)',
  'kotlinx.coroutines.scheduling.CoroutineScheduler$Worker.executeTask(CoroutineScheduler.kt:798)',
  'kotlinx.coroutines.scheduling.CoroutineScheduler$Worker.runWorker(CoroutineScheduler.kt:717)',
  'kotlinx.coroutines.scheduling.CoroutineScheduler$Worker.run(CoroutineScheduler.kt:704)',
];

function fetchErrorMessage(path, e) {
  const head = e.javaMessage == null ? e.javaClass : `${e.javaClass}: ${e.javaMessage}`;
  const trace = [head, ...[...e.frames, ...COROUTINE_FRAMES].map((f) => `\tat ${f}`)].join('\n') + '\n';
  return `Exception while fetching data (/${path.join('/')}) : ${e.javaMessage ?? 'null'}\r\n\r\n${trace}`;
}

const JAVA_TYPE = (v) => (typeof v === 'string' ? 'String' : typeof v === 'boolean' ? 'Boolean'
  : typeof v === 'number' ? (Number.isInteger(v) ? 'Integer' : 'Double') : Array.isArray(v) ? 'ArrayList' : 'LinkedHashMap');

class VariableError extends Error {
  constructor(message, loc) { super(message); this.loc = loc; }
}

/** Runtime coercion of one JSON variable value, with graphql-java's messages. */
function coerceInput(schema, v, type, varName, loc, inList = false) {
  const invalid = (msg) => new VariableError(`Variable '${varName}' has an invalid value: ${msg}`, loc);
  if (type.kind === 'NON_NULL') {
    // A null inside a list is worded without the variable's name ("Coerced Null value for NonNull type
    // 'String!'"), a null variable with it -- both as the engine words them.
    if (v === null || v === undefined) {
      throw invalid(inList ? `Coerced Null value for NonNull type '${printType(type)}'` : `Variable '${varName}' has coerced Null value for NonNull type '${printType(type)}'`);
    }
    return coerceInput(schema, v, type.of, varName, loc, inList);
  }
  if (v === null || v === undefined) return null;
  if (type.kind === 'LIST') {
    return Array.isArray(v) ? v.map((x) => coerceInput(schema, x, type.of, varName, loc, true)) : [coerceInput(schema, v, type.of, varName, loc, true)];
  }
  const name = type.name;
  const kind = schema.kind(name);
  if (kind === 'INPUT_OBJECT') {
    if (typeof v !== 'object' || Array.isArray(v)) throw invalid(`Expected type 'Map' but was '${JAVA_TYPE(v)}'. Variables for input objects must be an instance of type 'Map'.`);
    const fields = schema.inputFields(name);
    for (const k of Object.keys(v)) {
      if (!fields.has(k)) throw new VariableError(`The variables input contains a field name '${k}' that is not defined for input object type '${name}' `, null);
    }
    const out = {};
    for (const [fn, fd] of fields) {
      if (Object.hasOwn(v, fn)) out[fn] = coerceInput(schema, v[fn], fd.type, varName, loc, inList);
      else if (fd.type.kind === 'NON_NULL' && !fd.hasDefault) throw invalid(`Field '${fn}' of variable '${varName}' has coerced Null value for NonNull type '${fd.typeString}'`);
    }
    return out;
  }
  if (kind === 'ENUM') {
    if (typeof v !== 'string' || !schema.enumValues(name).includes(v)) throw invalid(`Invalid input for enum '${name}'. No value found for name '${v}'`);
    return v;
  }
  switch (name) {
    case 'Int':
      if (Number.isInteger(v) && (v > 2147483647 || v < -2147483648)) throw invalid(`Expected value to be in the integer range, but it was a '${v}'`);
      if (typeof v !== 'number' || !Number.isInteger(v)) throw invalid(`Expected a value that can be converted to type 'Int' but it was a '${JAVA_TYPE(v)}'`);
      return v;
    case 'Float':
      if (typeof v !== 'number') throw invalid(`Expected a value that can be converted to type 'Float' but it was a '${JAVA_TYPE(v)}'`);
      return v;
    case 'Boolean':
      if (typeof v !== 'boolean') throw invalid(`Expected a Boolean input, but it was a '${JAVA_TYPE(v)}'`);
      return v;
    case 'String': case 'LongString': case 'Cursor':
      if (typeof v !== 'string') throw invalid(`Expected a String input, but it was a '${JAVA_TYPE(v)}'`);
      return v;
    default:
      return v;
  }
}

function valueFromAst(schema, v, type, vars) {
  if (v.kind === 'Variable') return Object.hasOwn(vars, v.name) ? vars[v.name] : undefined;
  if (type.kind === 'NON_NULL') return valueFromAst(schema, v, type.of, vars);
  if (v.kind === 'Null') return null;
  if (type.kind === 'LIST') {
    return v.kind === 'List' ? v.values.map((x) => valueFromAst(schema, x, type.of, vars)) : [valueFromAst(schema, v, type.of, vars)];
  }
  const kind = schema.kind(type.name);
  if (kind === 'INPUT_OBJECT') {
    const fields = schema.inputFields(type.name);
    const out = {};
    for (const f of v.fields) {
      const x = valueFromAst(schema, f.value, fields.get(f.name).type, vars);
      if (x !== undefined) out[f.name] = x;
    }
    return out;
  }
  switch (v.kind) {
    case 'Int': return type.name === 'Float' ? Number(v.value) : Number.parseInt(v.value, 10);
    case 'Float': return Number(v.value);
    default: return v.value;
  }
}

async function execute(schema, doc, { operationName, variables, root }) {
  const ops = doc.definitions.filter((d) => d.kind === 'operation');
  let op;
  if (operationName) {
    op = ops.find((o) => o.name === operationName);
    if (!op) return { errors: [{ message: `Unknown operation named '${operationName}'.` }] };
  } else if (ops.length === 1) {
    op = ops[0];
  } else {
    return { errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
  }
  const fragments = new Map(doc.definitions.filter((d) => d.kind === 'fragment').map((d) => [d.name, d]));
  const vars = {};
  try {
    const given = variables && typeof variables === 'object' ? variables : {};
    for (const vd of op.variableDefinitions) {
      if (!Object.hasOwn(given, vd.name)) {
        if (vd.defaultValue) vars[vd.name] = valueFromAst(schema, vd.defaultValue, vd.type, {});
        else if (vd.type.kind === 'NON_NULL') {
          throw new VariableError(`Variable '${vd.name}' has an invalid value: Variable '${vd.name}' has coerced Null value for NonNull type '${printType(vd.type)}'`, vd.loc);
        }
        continue;
      }
      vars[vd.name] = coerceInput(schema, given[vd.name], vd.type, vd.name, vd.loc);
    }
  } catch (e) {
    if (e instanceof VariableError) return { errors: [e.loc ? { message: e.message, locations: [e.loc] } : { message: e.message }] };
    throw e;
  }

  const errors = [];
  const skip = (node) => node.directives.some((d) => {
    const cond = d.arguments.find((a) => a.name === 'if');
    const on = cond ? valueFromAst(schema, cond.value, parseTypeString('Boolean!'), vars) === true : false;
    return (d.name === 'skip' && on) || (d.name === 'include' && !on);
  });
  const applies = (cond, runtime) => !cond || cond.name === runtime || schema.possible(cond.name).includes(runtime);

  function collect(runtime, selections, into = new Map(), seen = new Set()) {
    for (const s of selections) {
      if (skip(s)) continue;
      if (s.kind === 'field') {
        const key = s.alias ?? s.name;
        if (!into.has(key)) into.set(key, []);
        into.get(key).push(s);
      } else if (s.kind === 'inline') {
        if (applies(s.typeCondition, runtime)) collect(runtime, s.selectionSet, into, seen);
      } else if (!seen.has(s.name)) {
        seen.add(s.name);
        const f = fragments.get(s.name);
        if (f && applies(f.typeCondition, runtime)) collect(runtime, f.selectionSet, into, seen);
      }
    }
    return into;
  }

  async function complete(type, value, nodes, path, threw, parentType) {
    if (type.kind === 'NON_NULL') {
      const r = await complete(type.of, value, nodes, path, threw, parentType);
      if (r === null) {
        if (!threw) {
          errors.push({
            message: `The field at path '/${path.join('/')}' was declared as a non null type, but the code involved in retrieving data `
              + 'has wrongly returned a null value.  The graphql specification requires that the parent field be set to null, or if that '
              + `is non nullable that it bubble up null to its parent and so on. The non-nullable type is '${printType(type.of)}' within `
              + `parent type '${parentType}'`,
            path,
          });
        }
        throw BUBBLE;
      }
      return r;
    }
    if (value === null || value === undefined) return null;
    if (type.kind === 'LIST') {
      if (!Array.isArray(value)) throw new FakeBug(`/${path.join('/')} resolved to a non-list`);
      const out = [];
      for (let i = 0; i < value.length; i++) out.push(await complete(type.of, value[i], nodes, [...path, i], false, parentType));
      return out;
    }
    const name = type.name;
    const kind = schema.kind(name);
    if (kind === 'ENUM') {
      if (!schema.enumValues(name).includes(value)) throw new FakeBug(`/${path.join('/')}: '${value}' is not a ${name}`);
      return value;
    }
    if (kind === 'SCALAR') {
      switch (name) {
        case 'Int': case 'Float':
          if (typeof value !== 'number' || (name === 'Int' && !Number.isInteger(value))) throw new FakeBug(`/${path.join('/')}: ${value} is not ${name}`);
          return value;
        case 'Boolean':
          if (typeof value !== 'boolean') throw new FakeBug(`/${path.join('/')}: ${value} is not Boolean`);
          return value;
        default:
          return String(value);
      }
    }
    const runtime = kind === 'OBJECT' ? name : value.__typename;
    if (!schema.possible(name).includes(runtime)) throw new FakeBug(`/${path.join('/')}: runtime type ${runtime} is not a ${name}`);
    const selections = nodes.flatMap((n) => n.selectionSet ?? []);
    return selectionSet(runtime, value, selections, path);
  }

  async function field(parentType, parent, nodes, path) {
    const node = nodes[0];
    if (node.name === '__typename') return parentType;
    if (node.name === '__schema' || node.name === '__type') throw new NotImplemented(`introspection (${node.name})`);
    const def = schema.fields(parentType).get(node.name);
    const args = {};
    for (const a of node.arguments) {
      const v = valueFromAst(schema, a.value, def.args.get(a.name).type, vars);
      if (v !== undefined) args[a.name] = v;
    }
    const where = `${parentType}.${node.name}`;
    if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, node.name)) throw new NotImplemented(where);
    let value;
    let threw = false;
    try {
      const r = parent[node.name];
      if (typeof r === 'function') value = await r(args);
      else if (Object.keys(args).length) throw new NotImplemented(`${where}(${Object.keys(args).join(', ')})`);
      else value = r;
    } catch (e) {
      if (!(e instanceof EngineException)) throw e;
      errors.push({ message: fetchErrorMessage(path, e), locations: [node.loc], path });
      value = null;
      threw = true;
    }
    return complete(def.type, value, nodes, path, threw, parentType);
  }

  async function selectionSet(runtime, value, selections, path) {
    const out = {};
    for (const [key, nodes] of collect(runtime, selections)) {
      const def = nodes[0].name === '__typename' ? null : schema.fields(runtime).get(nodes[0].name);
      try {
        out[key] = await field(runtime, value, nodes, [...path, key]);
      } catch (e) {
        if (e !== BUBBLE) throw e;
        if (def && def.type.kind === 'NON_NULL') throw e;
        out[key] = null;
      }
    }
    return out;
  }

  const rootType = schema.roots[op.operation];
  const rootValue = root[rootType];
  if (!rootValue) throw new NotImplemented(`${op.operation} operations`);
  let data;
  try {
    data = await selectionSet(rootType, rootValue, op.selectionSet, []);
  } catch (e) {
    if (e !== BUBBLE) throw e;
    data = null;
  }
  return data === null ? { errors } : errors.length ? { data, errors } : { data };
}

// ================================================================================================
// The engine's state: sources, their preferences, series and posts
// ================================================================================================

export const STAGES = ['search', 'manga', 'chapters', 'pages', 'images'];
export const MODES = ['up', 'down', 'slow', 'extension_error'];

/**
 * Ids are 64-bit on purpose. Mihon source ids routinely exceed Number.MAX_SAFE_INTEGER, which is why the
 * engine types them LongString; a fake with ids like "1" would hide every `Number(sourceId)` in product code.
 */
export const SOURCE_IDS = Object.freeze({
  local: '0',
  webtoons: '2522335540328470744',
  mangaBall: '6716343437498271985',
  nightShelf: '4630112867539114402',
});
export const PKG = Object.freeze({
  local: 'eu.kanade.tachiyomi.source.local',
  webtoons: 'eu.kanade.tachiyomi.extension.all.webtoons',
  mangaBall: 'eu.kanade.tachiyomi.extension.en.mangaball',
  nightShelf: 'eu.kanade.tachiyomi.extension.en.nightshelf',
  shelfTwo: 'eu.kanade.tachiyomi.extension.en.shelftwo',
});

/**
 * The Webtoons extension's "Use sequential chapter numbering" switch. ⚠️ The key string is illustrative: the
 * research quotes the title (Webtoons.kt:288-291), not the key, and nothing here may depend on its spelling --
 * product code finds a preference by what the engine reports.
 */
export const SEQUENTIAL_KEY = 'useSequentialChapterNumbering';

const DAY = 86_400_000;
const EPOCH = Date.UTC(2024, 0, 1);

/** A Kotlin Float as the engine serialises it: rounded to float32, printed as the shortest decimal that survives. */
export function f32(x) {
  const f = Math.fround(x);
  for (let p = 1; p <= 9; p++) {
    const s = Number(f.toPrecision(p));
    if (Math.fround(s) === f) return s;
  }
  return f;
}

/**
 * Istrevelia's shape (issue #116): 226 posts on 8 episode numbers -- 19/21/20/21/24/28/73/15 posts -- plus
 * five posts whose titles carry no number, which the extension gives the previous number + 0.01. Titles are
 * written the several ways the real series writes them ('Episode 1 - Page1 ', 'EP 1 - 29-31', 'E2 - 54-56',
 * 'Ee7 - 443-444'), with page ranges that run across the whole series. Generated, not copied: the shape is
 * what matters here, and postingOrder's own tests use the real title list. Returned OLDEST FIRST.
 */
export function istreveliaPosts() {
  const counts = [19, 21, 20, 21, 24, 28, 73, 15];
  const unnumberedAfter = new Map([[1, 'Q&A'], [3, 'Intermission'], [4, 'Special Illustration'], [5, "Author's Note"], [7, 'Bonus Art']]);
  const posts = [];
  let page = 1;
  const push = (title) => {
    const k = posts.length + 1;
    posts.push({ name: title, url: `/en/fantasy/istrevelia/post-${k}/viewer?title_no=4103&episode_no=${k}`, uploadDate: EPOCH + k * DAY, pages: 3 });
  };
  counts.forEach((n, i) => {
    const ep = i + 1;
    for (let j = 0; j < n; j++) {
      const len = 2 + ((posts.length + j) % 2);
      const range = `${page}-${page + len - 1}`;
      let title;
      if (ep === 1) title = j === 0 ? 'Episode 1 - Page1 ' : j < 8 ? `Episode 1 - Page ${range}` : `EP 1 - ${range}`;
      else if (ep === 7 && j % 2) title = `Ee7 - ${range}`;
      else title = `E${ep} - ${range}`;
      push(title);
      page += len;
    }
    if (unnumberedAfter.has(ep)) push(unnumberedAfter.get(ep));
  });
  return posts;
}

/** Walk Webtoon: six posts that number cleanly, the control case next to Istrevelia. OLDEST FIRST. */
function walkWebtoonPosts() {
  return Array.from({ length: 6 }, (_, i) => ({
    name: `Episode ${i + 1}`,
    url: `/en/drama/walk-webtoon/episode-${i + 1}/viewer?title_no=5501&episode_no=${i + 1}`,
    uploadDate: EPOCH + (i + 1) * 7 * DAY,
    pages: 3,
  }));
}

/**
 * The number the Webtoons extension gives each post, per the research's reading of Webtoons.kt (lib 1.6):
 * the LEFTMOST e / ep / episode / ch / chapter token in the title, else the previous number + 0.01 (in
 * float32); sequential (position, oldest = 1) when the switch is on or when more titles fail to parse than
 * parse. The name is the title plus " (ch. N)". Modelled, not measured: no extension can be installed offline.
 * `oldestFirst` is the posting order; the result is parallel to it.
 */
export function webtoonsNumbers(oldestFirst, sequential) {
  const EP = /(e(?:p(?:isode)?)?|ch(?:apter)?)\s*\.?\s*(\d+(?:\.\d+)?)/i;
  const parsed = oldestFirst.map((c) => EP.exec(c.name)?.[2]);
  const failing = parsed.filter((p) => p === undefined).length;
  const useSeq = sequential || failing > parsed.length - failing;
  let prev = 0;
  return oldestFirst.map((c, i) => {
    let n;
    if (useSeq) n = i + 1;
    else if (parsed[i] !== undefined) n = f32(Number(parsed[i]));
    else n = f32(Math.fround(prev) + Math.fround(0.01));
    prev = n;
    return { chapterNumber: n, name: `${c.name} (ch. ${n})` };
  });
}

const PREF_CLASS = { switch: 'SwitchPreferenceCompat', checkbox: 'CheckBoxPreference', edittext: 'EditTextPreference', list: 'ListPreference', multiselect: 'MultiSelectListPreference' };
const PREF_TYPENAME = { switch: 'SwitchPreference', checkbox: 'CheckBoxPreference', edittext: 'EditTextPreference', list: 'ListPreference', multiselect: 'MultiSelectListPreference' };
const PREF_STATE = { switch: 'switchState', checkbox: 'checkBoxState', edittext: 'editTextState', list: 'listState', multiselect: 'multiSelectState' };

/** Webtoons' screen: every one of the five preference kinds, plus a disabled switch. */
function webtoonsPreferences() {
  return [
    {
      kind: 'switch', key: SEQUENTIAL_KEY, title: 'Use sequential chapter numbering',
      summary: 'Number chapters by their position in the list instead of the number in their title', default: false,
    },
    { kind: 'checkbox', key: 'showAuthorsNotes', title: "Show author's notes", summary: null, default: false },
    { kind: 'list', key: 'imageQuality', title: 'Image quality', summary: '%s', entries: ['High', 'Medium', 'Low'], entryValues: ['high', 'medium', 'low'], default: 'high' },
    {
      kind: 'multiselect', key: 'hiddenGenres', title: 'Hide genres in browse', summary: null, entries: ['Romance', 'Horror', 'Comedy'],
      entryValues: ['romance', 'horror', 'comedy'], default: [], dialogTitle: 'Hide genres', dialogMessage: null,
    },
    {
      kind: 'edittext', key: 'customUserAgent', title: 'Custom user agent', summary: 'Leave empty for the default', default: '',
      dialogTitle: 'User agent', dialogMessage: 'Sent with every request to the site',
    },
    { kind: 'switch', key: 'legacyViewer', title: 'Legacy viewer', summary: 'Not available in this version', default: false, enabled: false },
  ];
}

/**
 * The standard installation. Chapters are listed the way the EXTENSION lists them: newest first. `numbering:
 * 'webtoons'` makes the source number its posts by webtoonsNumbers(); otherwise each chapter's own
 * chapterNumber is used (-1 is the engine's "no number").
 */
export function defaultSeed() {
  const newestFirst = (posts) => [...posts].reverse();
  return {
    sources: [
      { id: SOURCE_IDS.local, name: 'Local source', displayName: 'Local source', lang: 'localsourcelang', pkgName: PKG.local, supportsLatest: true, isNsfw: false, baseUrl: null, mangas: [] },
      {
        id: SOURCE_IDS.webtoons, name: 'Webtoons.com', lang: 'en', pkgName: PKG.webtoons, supportsLatest: false, isNsfw: false,
        baseUrl: 'https://www.webtoons.com', numbering: 'webtoons', preferences: webtoonsPreferences(),
        mangas: [
          {
            title: 'Istrevelia', url: '/en/fantasy/istrevelia/list?title_no=4103', realUrl: 'https://www.webtoons.com/en/fantasy/istrevelia/list?title_no=4103',
            author: 'June Kim', genre: ['Fantasy'], status: 'ONGOING', chapters: newestFirst(istreveliaPosts()),
          },
          {
            title: 'Walk Webtoon', url: '/en/drama/walk-webtoon/list?title_no=5501', realUrl: 'https://www.webtoons.com/en/drama/walk-webtoon/list?title_no=5501',
            genre: ['Drama'], status: 'COMPLETED', chapters: newestFirst(walkWebtoonPosts()),
          },
        ],
      },
      {
        id: SOURCE_IDS.mangaBall, name: 'Manga Ball', lang: 'en', pkgName: PKG.mangaBall, supportsLatest: true, isNsfw: false, baseUrl: 'https://mangaball.example',
        mangas: [
          {
            title: 'Ball Runner', url: '/title/ball-runner', realUrl: 'https://mangaball.example/title/ball-runner', description: 'A fixture series.',
            author: 'Someone', genre: ['Action', 'Sports'], status: 'ONGOING',
            chapters: [
              { name: 'Oneshot', url: '/title/ball-runner/oneshot', chapterNumber: -1, scanlator: null, uploadDate: EPOCH + 40 * DAY, pages: 2 },
              { name: 'Chapter 4', url: '/title/ball-runner/4', chapterNumber: 4, scanlator: 'Ball Team', uploadDate: EPOCH + 30 * DAY, pages: 3 },
              { name: 'Chapter 3', url: '/title/ball-runner/3-other', chapterNumber: 3, scanlator: 'Other Team', uploadDate: EPOCH + 21 * DAY, pages: 3 },
              { name: 'Chapter 3', url: '/title/ball-runner/3', chapterNumber: 3, scanlator: 'Ball Team', uploadDate: EPOCH + 20 * DAY, pages: 3 },
              { name: 'Chapter 2', url: '/title/ball-runner/2', chapterNumber: 2, scanlator: 'Ball Team', uploadDate: EPOCH + 10 * DAY, pages: 3 },
              { name: 'Chapter 1', url: '/title/ball-runner/1', chapterNumber: 1, scanlator: 'Ball Team', uploadDate: EPOCH, pages: 3 },
            ],
          },
        ],
      },
      {
        id: SOURCE_IDS.nightShelf, name: 'Night Shelf', lang: 'en', pkgName: PKG.nightShelf, supportsLatest: true, isNsfw: true, baseUrl: 'https://nightshelf.example',
        mangas: [
          { title: 'Night Walk', url: '/night-walk', realUrl: 'https://nightshelf.example/night-walk', genre: ['Drama'], status: 'ONGOING',
            chapters: [
              { name: 'Chapter 2', url: '/night-walk/2', chapterNumber: 2, scanlator: null, uploadDate: EPOCH + DAY, pages: 2 },
              { name: 'Chapter 1', url: '/night-walk/1', chapterNumber: 1, scanlator: null, uploadDate: EPOCH, pages: 2 },
            ] },
        ],
      },
    ],
    extensions: [
      { pkgName: PKG.webtoons, name: 'Webtoons.com', lang: 'all', versionName: '1.4.52', installed: true, isNsfw: false, repo: 'https://repo.example/repo.json' },
      { pkgName: PKG.mangaBall, name: 'Manga Ball', lang: 'en', versionName: '1.4.7', installed: true, isNsfw: false, repo: 'https://repo.example/repo.json' },
      { pkgName: PKG.nightShelf, name: 'Night Shelf', lang: 'en', versionName: '1.4.2', installed: true, isNsfw: true, repo: 'https://repo.example/repo.json' },
      { pkgName: PKG.shelfTwo, name: 'Shelf Two', lang: 'en', versionName: '1.4.1', installed: false, isNsfw: false, repo: 'https://repo.example/repo.json' },
    ],
    settings: {},
  };
}

/** Gap Scans (v0.55.0): a package not installed, in two languages; its English source carries Gap Only, all twelve. */
export const GAP_SCANS = Object.freeze({ pkg: 'eu.kanade.tachiyomi.extension.all.gapscans', en: '7000000000000055001', es: '7000000000000055002' });

/**
 * v0.55.1: what Fix everything tries in order of popularity, for Pop Walk -- a series no source carries and no
 * translation group names (autofixWalk.mjs). Six English packages, none installed, each with its apk and jar on the
 * repository's GitHub releases and how often each was downloaded (the fake's /__github answers it, a day after the
 * release): the most downloaded is Velvet Night, 18+, which carries Pop Walk -- never tried for a series that is not
 * 18+ -- then the five others, of which only the fifth, Grove Reader, carries it. One source each, in English.
 */
export const POP = Object.freeze([
  { key: 'rose', pkg: 'eu.kanade.tachiyomi.extension.en.velvetnight', name: 'Velvet Night', source: '7000000000000055100', downloads: 90_000, nsfw: true, carries: true },
  { key: 'one', pkg: 'eu.kanade.tachiyomi.extension.en.cometreader', name: 'Comet Reader', source: '7000000000000055101', downloads: 50_000 },
  { key: 'two', pkg: 'eu.kanade.tachiyomi.extension.en.deltacomics', name: 'Delta Comics', source: '7000000000000055102', downloads: 40_000 },
  { key: 'three', pkg: 'eu.kanade.tachiyomi.extension.en.echopages', name: 'Echo Pages', source: '7000000000000055103', downloads: 30_000 },
  { key: 'four', pkg: 'eu.kanade.tachiyomi.extension.en.fieldscans', name: 'Field Scans', source: '7000000000000055104', downloads: 20_000 },
  { key: 'five', pkg: 'eu.kanade.tachiyomi.extension.en.grovereader', name: 'Grove Reader', source: '7000000000000055105', downloads: 10_000, carries: true },
].map((p) => Object.freeze(p)));
/** Where the POP packages' files are, as a Keiyoushi index points at them: a GitHub release of the repository. */
const POP_RELEASE = 'https://github.com/keiyoushi/extensions/releases/download/fake-0';

/**
 * The standard installation with Gap Scans in the repository, not installed: what Health's Fix everything installs by
 * itself to fill a gap no installed source has (web/test/e2e/autofixWalk.mjs; fakeEngine.mjs --extra v55). Its sources
 * come FIRST in the engine's order, the POP packages' next, so that under the walk's source limit of two a series on
 * Webtoons.com is the one left over -- Free a slot's case -- while the packages a run keeps hold their places.
 */
export function autofixSeed() {
  const seed = defaultSeed();
  const chapters = Array.from({ length: 12 }, (_, i) => 12 - i).map((n) => ({
    name: `Chapter ${n}`, url: `/gap-only/${n}`, chapterNumber: n, scanlator: 'Gap Scans', uploadDate: EPOCH + n * DAY, pages: 3,
  }));
  const src = (id, lang, mangas) => ({
    id, name: 'Gap Scans', lang, pkgName: GAP_SCANS.pkg, supportsLatest: true, isNsfw: false, baseUrl: 'https://gapscans.example', mangas,
  });
  // v0.55.1: Pop Walk's twelve chapters, on the packages that carry it (POP).
  const popChapters = Array.from({ length: 12 }, (_, i) => 12 - i).map((n) => ({
    name: `Chapter ${n}`, url: `/pop-walk/${n}`, chapterNumber: n, uploadDate: EPOCH + n * DAY, pages: 3,
  }));
  const slug = (p) => p.pkg.split('.').slice(-2).join('.');
  return {
    ...seed,
    sources: [
      src(GAP_SCANS.en, 'en', [{ title: 'Gap Only', url: '/gap-only', realUrl: 'https://gapscans.example/gap-only', genre: ['Drama'], status: 'ONGOING', chapters }]),
      src(GAP_SCANS.es, 'es', []),
      // After Gap Scans' and before the standard installation's: under the walk's limit a series on Webtoons.com is
      // still the one left over (Free a slot) while the packages a run keeps register first.
      ...POP.map((p) => ({
        id: p.source, name: p.name, lang: 'en', pkgName: p.pkg, supportsLatest: true, isNsfw: !!p.nsfw, baseUrl: `https://${slug(p)}.example`,
        mangas: p.carries ? [{ title: 'Pop Walk', url: '/pop-walk', realUrl: `https://${slug(p)}.example/pop-walk`, genre: ['Drama'], status: 'ONGOING', chapters: popChapters }] : [],
      })),
      ...seed.sources,
    ],
    extensions: [
      ...seed.extensions,
      { pkgName: GAP_SCANS.pkg, name: 'Gap Scans', lang: 'all', versionName: '1.0.0', installed: false, isNsfw: false, repo: 'https://repo.example/repo.json' },
      ...POP.map((p) => ({
        pkgName: p.pkg, name: p.name, lang: 'en', versionName: '1.0.0', installed: false, isNsfw: !!p.nsfw, repo: 'https://repo.example/repo.json',
        apkUrl: `${POP_RELEASE}/tachiyomi-${slug(p)}-v1.0.0.apk`, jarUrl: `${POP_RELEASE}/tachiyomi-${slug(p)}-v1.0.0.jar`,
        // The apk most, the jar the rest: counted together.
        downloads: { apk: p.downloads - p.downloads / 4, jar: p.downloads / 4 },
      })),
    ],
  };
}

// A repository the size of the ones people add: the keiyoushi repository lists more than 1,300 extensions, and
// Admin → Extensions once stopped at "Showing 400 of 570 matches — narrow the search" on it (discussion #121).
// The names are made up, two words from the lists below; the languages, the one-in-five multi-language
// extensions and the one-in-seven 18+ ones are a spread, not a measurement.
const CATALOGUE_LANGS = ['en', 'en', 'en', 'en', 'es', 'pt-BR', 'fr', 'id', 'ja', 'ko', 'zh', 'ru', 'ar', 'de', 'it', 'tr', 'vi', 'es-419', 'th', 'pl'];
const MULTI_LANGS = ['en', 'es', 'pt-BR', 'fr', 'id', 'ja', 'ko', 'zh', 'ru', 'ar', 'de', 'it', 'tr', 'vi'];
const WORD_A = ['Amber', 'Azure', 'Birch', 'Cedar', 'Cinder', 'Coral', 'Dawn', 'Dusk', 'Ember', 'Fable', 'Fern', 'Frost', 'Gale',
  'Harbor', 'Hollow', 'Indigo', 'Ivory', 'Jade', 'Juniper', 'Kestrel', 'Lantern', 'Lotus', 'Maple', 'Meadow', 'Nova', 'Onyx', 'Opal',
  'Pebble', 'Quill', 'Raven', 'Saffron', 'Sable', 'Thistle', 'Tide', 'Umber', 'Velvet', 'Willow', 'Wren', 'Yarrow', 'Zephyr'];
const WORD_B = ['Scans', 'Comics', 'Manga', 'Reader', 'Toons', 'Library', 'Shelf', 'Stories', 'Panels', 'Pages', 'Ink', 'Press', 'Studio',
  'Archive', 'Club', 'House', 'Lounge', 'Garden', 'Harbor', 'Works', 'Corner', 'Den', 'Tales', 'Novels', 'Streams', 'Hub', 'Box', 'Nest',
  'Vault', 'Atlas', 'Haven', 'Planet', 'Realm', 'Room'];
const GENERATED_ID_BASE = 7_000_000_000_000_000_000n;

/**
 * `n` made-up extensions with their sources -- one per language, two to six for a multi-language one -- none of
 * them installed. Deterministic: the same `n` gives the same catalogue, ids included, so a test can name one.
 */
export function catalogueExtensions(n) {
  const extensions = [];
  const sources = [];
  const span = WORD_A.length * WORD_B.length;
  let single = 0;
  for (let i = 0; i < n; i++) {
    const base = `${WORD_A[i % WORD_A.length]} ${WORD_B[Math.floor(i / WORD_A.length) % WORD_B.length]}`;
    const name = i < span ? base : `${base} ${Math.floor(i / span) + 1}`;
    const lang = i % 5 === 1 ? 'all' : CATALOGUE_LANGS[(single++ * 7 + 3) % CATALOGUE_LANGS.length];
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const pkgName = `eu.kanade.tachiyomi.extension.${lang === 'all' ? 'all' : lang.toLowerCase().replace(/[^a-z]/g, '')}.${slug}`;
    const isNsfw = i % 7 === 3;
    extensions.push({ pkgName, name, lang, versionName: `1.4.${(i * 13) % 97}`, installed: false, isNsfw, repo: 'https://repo.example/repo.json' });
    const langs = lang === 'all'
      ? Array.from({ length: 2 + (Math.floor(i / 5) % 5) }, (_, k) => MULTI_LANGS[(i + k * 3) % MULTI_LANGS.length]).filter((l, k, a) => a.indexOf(l) === k)
      : [lang];
    langs.forEach((l, j) => sources.push({
      id: String(GENERATED_ID_BASE + BigInt(i) * 100n + BigInt(j)), name, lang: l, pkgName, supportsLatest: true, isNsfw,
      baseUrl: `https://${slug}.example`, mangas: [],
    }));
  }
  return { extensions, sources };
}

/** The standard installation plus `n` made-up extensions: what the catalogue's paging is tested against. */
export function catalogueSeed(n) {
  const seed = defaultSeed();
  const more = catalogueExtensions(n);
  return { ...seed, sources: [...seed.sources, ...more.sources], extensions: [...seed.extensions, ...more.extensions] };
}

/** The settings a fresh v2.3.2243 reports, read off the disposable engine. Others are refused as not implemented. */
const DEFAULT_SETTINGS = {
  extensionRepos: [],
  flareSolverrEnabled: false,
  flareSolverrUrl: 'http://localhost:8191',
  flareSolverrTimeout: 60,
  flareSolverrSessionName: 'suwayomi',
  flareSolverrSessionTtl: 15,
  flareSolverrAsResponseFallback: false,
  maxSourcesInParallel: 6,
  socksProxyEnabled: false,
  authMode: 'NONE',
};

/** aboutServer, as the pinned image answers it. */
const ABOUT = {
  name: 'Suwayomi-Server', version: 'v2.3.2243', revision: 'r2243', buildType: 'Stable', buildTime: '1783967317',
  github: 'https://github.com/Suwayomi/Suwayomi-Server', discord: 'https://discord.gg/DDZdqZWaHA',
};

function buildState(seed) {
  const clone = structuredClone(seed);
  const st = {
    about: { ...ABOUT },
    settings: { ...DEFAULT_SETTINGS, ...(clone.settings ?? {}) },
    sources: new Map(),
    extensions: new Map(),
    mangas: new Map(),
    chapters: new Map(),
    chapterIds: new Map(),
    /** The engine's preferenceScreenMap: sourceId → the preference list built by the last read. */
    screens: new Map(),
    prefWrites: [],
    /**
     * What the engine keeps on disk for images it served: every page (tempMangaCacheRoot) and every cover
     * (tempThumbnailCacheRoot), by path. Only clearCachedImages empties them, as on the engine.
     */
    pageCache: new Set(),
    thumbnailCache: new Set(),
    /** Every clearCachedImages that ran: the three kinds as asked, null where not given. */
    cacheClears: [],
    nextManga: 1,
    nextChapter: 1,
  };
  for (const e of clone.extensions ?? []) st.extensions.set(e.pkgName, { hasUpdate: false, obsolete: false, versionCode: 1, ...e });
  for (const s of clone.sources ?? []) {
    s.preferences ??= [];
    s.prefValues ??= {};
    s.fail ??= {};
    s.reloads = 0;
    s.mangas ??= [];
    for (const m of s.mangas) {
      m.id = st.nextManga++;
      m.sourceId = s.id;
      m.chapters ??= [];
      // The engine re-parses the name of every chapter its extension left unnumbered (ChapterRecognition):
      // "Ch.10 Finale" at -1 comes back as 10, measured on the Local source. This fake does not model that
      // parser, so a seed that would need it is refused instead of answered -1 where the engine says 10.
      if (s.numbering !== 'webtoons') {
        for (const c of m.chapters) {
          if ((c.chapterNumber ?? -1) === -1 && /\d/.test(c.name)) {
            throw new FakeBug(`${m.title}: "${c.name}" has no chapterNumber, and the engine would parse one from its name; give it explicitly`);
          }
        }
      }
      st.mangas.set(m.id, m);
    }
    st.sources.set(s.id, s);
  }
  return st;
}

// ================================================================================================
// The engine
// ================================================================================================

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** A small, valid, deterministic PNG: covers, icons and pages all decode, and differ by seed. */
function png(seed) {
  const width = 8, height = 8;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let at = 0;
  for (let y = 0; y < height; y++) {
    raw[at++] = 0;
    for (let x = 0; x < width * 3; x++) raw[at++] = (x * 7 + y * 13 + seed * 31) & 0xff;
  }
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const name = Buffer.from(type);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); name.copy(out, 4); data.copy(out, 8);
    out.writeUInt32BE(crc(Buffer.concat([name, data])), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * One engine: its state, its mode and its request log, behind one HTTP handler. `startFakeEngine` puts it on
 * a port; tests usually want that, through fakeSuwayomi.ts.
 */
export function createFakeEngine({ seed = defaultSeed(), schema = loadSchema(), auth = null } = {}) {
  let st = buildState(seed);
  let mode = { mode: 'up' };
  const log = [];
  let seq = 0;

  const stageMethod = { search: 'searchMangaParse', manga: 'mangaDetailsParse', chapters: 'chapterListParse', pages: 'pageListParse', images: 'imageRequest' };
  // The engine frame each stage's mutation runs in, with the line numbers observed on v2.3.2243.
  const stageFrame = {
    search: 'suwayomi.tachidesk.graphql.mutations.SourceMutation$fetchSourceManga$1.invokeSuspend(SourceMutation.kt:259)',
    manga: 'suwayomi.tachidesk.graphql.mutations.MangaMutation$fetchManga$1.invokeSuspend(MangaMutation.kt:159)',
    chapters: 'suwayomi.tachidesk.graphql.mutations.ChapterMutation$fetchChapters$1.invokeSuspend(ChapterMutation.kt:177)',
    pages: 'suwayomi.tachidesk.graphql.mutations.ChapterMutation$fetchChapterPages$1.invokeSuspend(ChapterMutation.kt:411)',
    images: 'suwayomi.tachidesk.manga.impl.Page.getPageImage(Page.kt:1)',
  };
  /** The extension's own exception, as #115's screenshot shows it: the engine answered, the extension failed. */
  function extensionFailure(src, stage) {
    const forced = src.fail?.[stage];
    const moded = mode.mode === 'extension_error' && (!mode.source || mode.source === src.id) && (!mode.stage || mode.stage === stage);
    if (!forced && !moded) return null;
    const message = typeof forced === 'string' ? forced : moded && mode.message ? mode.message : 'java.lang.Exception';
    const cls = src.pkgName.split('.').pop();
    const klass = cls.charAt(0).toUpperCase() + cls.slice(1);
    // Modelled frames: the engine's head line and separator are measured, the extension's frames cannot be.
    return new EngineException('java.lang.Exception', message, [
      `${src.pkgName}.${klass}.${stageMethod[stage]}(${klass}.kt:1)`,
      stageFrame[stage],
    ]);
  }
  const failIf = (src, stage) => { const e = extensionFailure(src, stage); if (e) throw e; };
  /** A repository that does not answer, as the engine reports it (modelled: no repository can be reached offline). */
  const repositoryFailure = (frame) => new EngineException('java.net.UnknownHostException', 'repo.example: Name or service not known', [frame]);
  const noSuchElement = (frame) => new EngineException('java.util.NoSuchElementException', 'Collection is empty.', [
    'kotlin.collections.CollectionsKt___CollectionsKt.first(_Collections.kt:209)', frame,
  ]);
  const only = (args, allowed, where) => {
    for (const k of Object.keys(args)) if (!allowed.includes(k)) throw new NotImplemented(`${where}(${k})`);
  };
  const installed = (src) => src.pkgName === PKG.local || st.extensions.get(src.pkgName)?.installed === true;
  const visibleSources = () => [...st.sources.values()].filter(installed);
  const displayName = (src) => src.displayName ?? `${src.name} (${src.lang.toUpperCase()})`;
  const connection = (nodes) => ({ nodes, totalCount: nodes.length });

  function prefView(src, p) {
    const stored = Object.hasOwn(src.prefValues, p.key) ? src.prefValues[p.key] : undefined;
    const current = stored === undefined ? p.default : stored;
    const out = { __typename: PREF_TYPENAME[p.kind], key: p.key ?? null, title: p.title ?? null, summary: p.summary ?? null, visible: p.visible ?? true, enabled: p.enabled ?? true };
    if (p.kind === 'switch' || p.kind === 'checkbox') Object.assign(out, { currentValue: current ?? null, default: !!p.default });
    if (p.kind === 'list') Object.assign(out, { currentValue: current ?? null, default: p.default ?? null, entries: p.entries ?? [], entryValues: p.entryValues ?? [] });
    const dialog = { dialogTitle: p.dialogTitle ?? null, dialogMessage: p.dialogMessage ?? null };
    if (p.kind === 'multiselect') {
      Object.assign(out, { currentValue: current ?? null, default: p.default ?? null, entries: p.entries ?? [], entryValues: p.entryValues ?? [], ...dialog });
    }
    if (p.kind === 'edittext') Object.assign(out, { currentValue: current ?? null, default: p.default ?? null, text: current ?? null, ...dialog });
    return out;
  }
  /**
   * Source.getSourcePreferencesRaw: builds the screen AND remembers it for the next updateSourcePreference. An
   * extension whose setupPreferenceScreen throws (`fail.preferences`) fails the field with its own exception: the
   * engine answered, the extension failed -- the case #115 is about, on the settings sheet (modelled frames).
   */
  function readPreferences(src) {
    const forced = src.fail?.preferences;
    if (forced) {
      const cls = src.pkgName.split('.').pop();
      const klass = cls.charAt(0).toUpperCase() + cls.slice(1);
      throw new EngineException('java.lang.Exception', typeof forced === 'string' ? forced : 'java.lang.Exception', [
        `${src.pkgName}.${klass}.setupPreferenceScreen(${klass}.kt:1)`,
        'suwayomi.tachidesk.manga.impl.Source.getSourcePreferencesRaw(Source.kt:1)',
      ]);
    }
    const screen = [...src.preferences];
    if (screen.length) st.screens.set(src.id, screen);
    return screen.map((p) => prefView(src, p));
  }

  function extensionView(e) {
    return {
      pkgName: e.pkgName, name: e.name, lang: e.lang, versionName: e.versionName, iconUrl: `/api/v1/extension/icon/${e.pkgName}`,
      isInstalled: !!e.installed, hasUpdate: !!e.hasUpdate, isObsolete: !!e.obsolete, isNsfw: !!e.isNsfw,
      contentWarning: e.isNsfw ? 'NSFW' : 'SAFE', repo: e.repo ?? null, storeIndexUrl: e.repo ?? null,
      versionCode: e.versionCode, versionCodeLong: String(e.versionCode), apkName: `tachiyomi-${e.pkgName.split('.').slice(-2).join('.')}-v${e.versionName}.apk`,
      // Modelled, not measured (no network inside the measured container): the addresses a repository's index gives
      // its files -- Keiyoushi's put them on GitHub Releases -- as seeded, else none.
      apkUrl: e.apkUrl ?? null, jarUrl: e.jarUrl ?? null,
      source: () => connection(e.installed ? [...st.sources.values()].filter((s) => s.pkgName === e.pkgName).map(sourceView) : []),
    };
  }
  function sourceView(src) {
    const ext = st.extensions.get(src.pkgName);
    return {
      id: src.id, name: src.name, displayName: displayName(src), lang: src.lang, iconUrl: `/api/v1/extension/icon/${src.pkgName}`,
      supportsLatest: !!src.supportsLatest, isConfigurable: src.preferences.length > 0, isNsfw: !!src.isNsfw,
      contentWarning: src.isNsfw ? 'NSFW' : 'SAFE', baseUrl: src.baseUrl ?? null, homeUrl: src.baseUrl ?? null,
      extension: () => (ext ? extensionView(ext) : { pkgName: src.pkgName, name: 'Local Source fake extension', lang: 'localsourcelang', isInstalled: true, isNsfw: false, contentWarning: 'SAFE' }),
      preferences: () => readPreferences(src),
    };
  }
  function mangaView(m) {
    return {
      id: m.id, title: m.title, thumbnailUrl: `/api/v1/manga/${m.id}/thumbnail`, realUrl: m.realUrl ?? null, url: m.url,
      description: m.description ?? null, author: m.author ?? null, artist: m.artist ?? null, genre: m.genre ?? [],
      status: m.status ?? 'UNKNOWN', sourceId: m.sourceId, inLibrary: false, initialized: true,
      source: () => sourceView(st.sources.get(m.sourceId)),
      // What the engine's database holds: the rows the last fetchChapters wrote, in sourceOrder.
      chapters: () => connection([...st.chapters.values()].filter((c) => c.mangaId === m.id).sort((a, b) => a.sourceOrder - b.sourceOrder).map(chapterView)),
    };
  }
  function chapterView(row) {
    return {
      id: row.id, mangaId: row.mangaId, name: row.name, chapterNumber: row.chapterNumber, scanlator: row.scanlator,
      uploadDate: String(row.uploadDate), url: row.url, realUrl: row.realUrl, sourceOrder: row.sourceOrder,
      pageCount: row.pageCount, fetchedAt: String(row.fetchedAt), isRead: false, isBookmarked: false, isDownloaded: false,
      lastPageRead: 0, lastReadAt: '0',
      manga: () => mangaView(st.mangas.get(row.mangaId)),
    };
  }

  /**
   * fetchChapters: the extension's list (newest first) becomes the engine's rows. sourceOrder is index + 1 over
   * the reversed list; a row keeps its id for as long as its url is listed, and a post the site dropped is
   * dropped here too, the way the engine syncs.
   */
  function syncChapters(m) {
    const src = st.sources.get(m.sourceId);
    const oldestFirst = [...m.chapters].reverse();
    const numbered = src.numbering === 'webtoons' ? webtoonsNumbers(oldestFirst, src.prefValues[SEQUENTIAL_KEY] === true) : null;
    const now = Math.floor(Date.now() / 1000);
    const keep = new Set();
    const rows = oldestFirst.map((c, i) => {
      const key = `${m.id}\n${c.url}`;
      let id = st.chapterIds.get(key);
      if (id === undefined) { id = st.nextChapter++; st.chapterIds.set(key, id); }
      keep.add(id);
      const prev = st.chapters.get(id);
      const row = {
        id, mangaId: m.id, url: c.url, realUrl: c.realUrl ?? null,
        name: numbered ? numbered[i].name : c.name,
        chapterNumber: numbered ? numbered[i].chapterNumber : f32(c.chapterNumber ?? -1),
        scanlator: c.scanlator ?? null, uploadDate: c.uploadDate ?? 0, sourceOrder: i + 1,
        pages: c.pages ?? 3, pageCount: prev?.pageCount ?? -1, fetchedAt: now,
      };
      st.chapters.set(id, row);
      return row;
    });
    for (const [key, id] of st.chapterIds) {
      if (key.startsWith(`${m.id}\n`) && !keep.has(id)) { st.chapterIds.delete(key); st.chapters.delete(id); }
    }
    return rows;
  }

  function sourceOf(id) {
    const s = st.sources.get(String(id));
    return s && installed(s) ? s : null;
  }

  const root = {
    Query: {
      aboutServer: { ...st.about },
      settings: () => settingsView(),
      sources: (args) => { only(args, [], 'Query.sources'); return connection(visibleSources().map(sourceView)); },
      source: ({ id }) => { const s = sourceOf(id); return s ? sourceView(s) : null; },
      extensions: (args) => {
        only(args, [], 'Query.extensions');
        if (st.failList) throw repositoryFailure('suwayomi.tachidesk.graphql.queries.ExtensionQuery.extensions(ExtensionQuery.kt:1)');
        return connection([...st.extensions.values()].map(extensionView));
      },
      extension: ({ pkgName }) => { const e = st.extensions.get(pkgName); return e ? extensionView(e) : null; },
      manga: ({ id }) => { const m = st.mangas.get(id); return m && sourceOf(m.sourceId) ? mangaView(m) : null; },
      chapter: ({ id }) => { const c = st.chapters.get(id); return c ? chapterView(c) : null; },
    },
    Mutation: {
      fetchSourceManga: ({ input }) => {
        const src = sourceOf(input.source);
        if (!src) throw new EngineException('java.lang.NullPointerException', null, ['suwayomi.tachidesk.graphql.mutations.SourceMutation$fetchSourceManga$1.invokeSuspend(SourceMutation.kt:259)']);
        if (input.filters?.length) throw new NotImplemented('FetchSourceMangaInput.filters');
        failIf(src, 'search');
        if (input.type === 'LATEST' && !src.supportsLatest) throw new EngineException('java.lang.UnsupportedOperationException', 'Not used', [`${src.pkgName}.latestUpdatesRequest(Source.kt:1)`]);
        let list = [...src.mangas];
        if (input.type === 'SEARCH' && input.query) list = list.filter((m) => m.title.toLowerCase().includes(String(input.query).toLowerCase()));
        if (input.type === 'LATEST') list.sort((a, b) => Math.max(0, ...b.chapters.map((c) => c.uploadDate ?? 0)) - Math.max(0, ...a.chapters.map((c) => c.uploadDate ?? 0)));
        const size = 20;
        const page = Math.max(1, input.page);
        return { mangas: list.slice((page - 1) * size, page * size).map(mangaView), hasNextPage: list.length > page * size, clientMutationId: input.clientMutationId ?? null };
      },
      fetchManga: ({ input }) => {
        const m = st.mangas.get(input.id);
        if (!m || !sourceOf(m.sourceId)) throw noSuchElement('suwayomi.tachidesk.manga.impl.Manga.updateMangaAndChapters(Manga.kt:162)');
        failIf(st.sources.get(m.sourceId), 'manga');
        return { manga: mangaView(m), clientMutationId: input.clientMutationId ?? null };
      },
      fetchChapters: ({ input }) => {
        const m = st.mangas.get(input.mangaId);
        if (!m || !sourceOf(m.sourceId)) throw noSuchElement('suwayomi.tachidesk.manga.impl.Manga.updateMangaAndChapters(Manga.kt:162)');
        failIf(st.sources.get(m.sourceId), 'chapters');
        return { chapters: syncChapters(m).map(chapterView), clientMutationId: input.clientMutationId ?? null };
      },
      fetchChapterPages: ({ input }) => {
        const row = st.chapters.get(input.chapterId);
        if (!row) throw noSuchElement('suwayomi.tachidesk.manga.impl.chapter.ChapterForDownload.freshChapterEntry(ChapterForDownload.kt:210)');
        if (input.format != null) throw new NotImplemented('FetchChapterPagesInput.format');
        const m = st.mangas.get(row.mangaId);
        failIf(st.sources.get(m.sourceId), 'pages');
        row.pageCount = row.pages;
        const pages = Array.from({ length: row.pages }, (_, i) => `/api/v1/manga/${row.mangaId}/chapter/${row.sourceOrder}/page/${i}`);
        return { pages, chapter: chapterView(row), clientMutationId: input.clientMutationId ?? null, syncConflict: null };
      },
      clearCachedImages: ({ input }) => {
        const asked = (v) => v === true;
        st.cacheClears.push({ cachedPages: input.cachedPages ?? null, cachedThumbnails: input.cachedThumbnails ?? null, downloadedThumbnails: input.downloadedThumbnails ?? null });
        if (asked(input.cachedPages)) st.pageCache.clear();
        if (asked(input.cachedThumbnails)) st.thumbnailCache.clear();
        // The engine's downloaded thumbnails (its own library's covers) are not modelled: nothing Uchiyomi does
        // creates one. Deleting a directory that is not there answers true, as on the engine.
        return {
          cachedPages: asked(input.cachedPages) ? true : null,
          cachedThumbnails: asked(input.cachedThumbnails) ? true : null,
          downloadedThumbnails: asked(input.downloadedThumbnails) ? true : null,
          clientMutationId: input.clientMutationId ?? null,
        };
      },
      setSettings: ({ input }) => {
        const patch = input.settings ?? {};
        if (typeof patch.maxSourcesInParallel === 'number' && patch.maxSourcesInParallel < 1) {
          const msg = `Validation errors: maxSourcesInParallel: Value (${patch.maxSourcesInParallel}) must be at least 1`;
          throw new EngineException('java.lang.Exception', msg, ['suwayomi.tachidesk.graphql.mutations.SettingsMutation.updateSettings(SettingsMutation.kt:31)']);
        }
        for (const [k, v] of Object.entries(patch)) if (v !== null && v !== undefined) st.settings[k] = v;
        return { settings: settingsView(), clientMutationId: input.clientMutationId ?? null };
      },
      updateSourcePreference: ({ input }) => {
        const src = sourceOf(input.source);
        const screen = src ? st.screens.get(src.id) : undefined;
        if (!screen) throw new EngineException('java.lang.NullPointerException', null, ['suwayomi.tachidesk.manga.impl.Source.setSourcePreference(Source.kt:147)']);
        const { position } = input.change;
        if (position < 0 || position >= screen.length) {
          throw new EngineException('java.lang.IndexOutOfBoundsException', `Index ${position} out of bounds for length ${screen.length}`,
            ['suwayomi.tachidesk.manga.impl.Source.setSourcePreference(Source.kt:148)']);
        }
        const pref = screen[position];
        if (pref.enabled !== false) {
          let v = input.change[PREF_STATE[pref.kind]];
          if (v === null || v === undefined) {
            throw new EngineException('java.lang.Exception', `Expected change to ${PREF_CLASS[pref.kind]}`,
              ['suwayomi.tachidesk.graphql.mutations.SourceMutation.updateSourcePreference$lambda$0(SourceMutation.kt:334)']);
          }
          if (pref.kind === 'multiselect') v = [...new Set(v)];
          // `keeps`: the extension's OnPreferenceChangeListener answers false, so Android never stores the value --
          // and the engine answers the mutation as if it had (modelled; the listener is the extension's own code).
          if (!pref.keeps) {
            src.prefValues[pref.key] = v;
            src.reloads++; // GetSource.unregisterSource: the next call builds the source afresh with the new value
            st.prefWrites.push({ source: src.id, position, key: pref.key, value: v });
          }
        }
        return { preferences: readPreferences(src), source: sourceView(src), clientMutationId: input.clientMutationId ?? null };
      },
      fetchExtensions: ({ input }) => {
        if (st.failFetch) throw repositoryFailure('suwayomi.tachidesk.manga.impl.extension.ExtensionsList.fetchExtensions(ExtensionsList.kt:1)');
        return { extensions: [...st.extensions.values()].map(extensionView), extensionStores: [], clientMutationId: input.clientMutationId ?? null };
      },
      updateExtension: ({ input }) => {
        const e = st.extensions.get(input.id);
        if (!e) return { extension: null, clientMutationId: input.clientMutationId ?? null };
        const p = input.patch ?? {};
        if (p.install) e.installed = true;
        if (p.uninstall) e.installed = false;
        if (p.update && e.hasUpdate) { e.hasUpdate = false; e.versionCode += 1; }
        return { extension: extensionView(e), clientMutationId: input.clientMutationId ?? null };
      },
    },
  };
  function settingsView() {
    return { ...st.settings };
  }

  // ---- HTTP -------------------------------------------------------------------------------------------------

  const send = (res, status, type, body, headers = {}) => {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, { 'content-type': type, ...headers });
    res.end(body);
  };
  const json = (res, status, value) => send(res, status, 'application/json', JSON.stringify(value));
  const entry = (req, path, kind) => {
    const row = { seq: ++seq, at: new Date().toISOString(), method: req.method, path, kind, mode: mode.mode };
    log.push(row);
    if (log.length > 2000) log.splice(0, log.length - 2000);
    return row;
  };

  function setMode(next) {
    const m = typeof next === 'string' ? { mode: next } : { ...next };
    if (!MODES.includes(m.mode)) throw new Error(`unknown mode ${m.mode}`);
    if (m.stage !== undefined && !STAGES.includes(m.stage)) throw new Error(`unknown stage ${m.stage}`);
    if (m.ms !== undefined && (!Number.isInteger(m.ms) || m.ms < 0 || m.ms > 600_000)) throw new Error(`bad ms ${m.ms}`);
    if (m.source !== undefined && typeof m.source !== 'string') throw new Error('source must be a string id');
    if (m.mode === 'slow') m.ms ??= 15_000;
    mode = m;
    return mode;
  }
  /**
   * POST /__catalogue: `extensions` made-up extensions (catalogueExtensions) in place of the last ones it added, and
   * `set` changes to any extension by package -- an update waiting (`hasUpdate`), installed from the engine's own
   * page (`installed`), `obsolete`, a `versionName`. `empty` first takes every extension away, the seed's too: an
   * engine no repository has been added to. `failFetch` makes re-reading the repositories (fetchExtensions) fail as
   * an unreachable repository does, and `failList` the catalogue's own listing (`extensions`); false puts either back.
   * Never part of the engine; a bad body throws, and is a 400.
   */
  function catalogue({ extensions, set, empty, failFetch, failList } = {}) {
    if (failFetch !== undefined) st.failFetch = failFetch === true;
    if (failList !== undefined) st.failList = failList === true;
    if (empty === true) {
      for (const [id, s] of st.sources) if (s.pkgName !== PKG.local) st.sources.delete(id);
      st.extensions.clear();
      st.generated = new Set();
    }
    if (extensions !== undefined) {
      if (!Number.isInteger(extensions) || extensions < 0 || extensions > 5000) throw new Error(`bad extensions ${extensions}`);
      for (const [id, s] of st.sources) if (st.generated?.has(s.pkgName)) st.sources.delete(id);
      for (const pkg of st.generated ?? []) st.extensions.delete(pkg);
      const more = catalogueExtensions(extensions);
      st.generated = new Set(more.extensions.map((e) => e.pkgName));
      for (const e of more.extensions) st.extensions.set(e.pkgName, { hasUpdate: false, obsolete: false, versionCode: 1, ...e });
      for (const s of more.sources) st.sources.set(s.id, { ...s, preferences: [], prefValues: {}, fail: {}, reloads: 0, mangas: [] });
    }
    for (const [pkg, patch] of Object.entries(set ?? {})) {
      const e = st.extensions.get(pkg);
      if (!e) throw new Error(`no extension ${pkg}`);
      for (const k of ['hasUpdate', 'installed', 'obsolete', 'versionName']) if (patch?.[k] !== undefined) e[k] = patch[k];
    }
    return { extensions: st.extensions.size, sources: st.sources.size };
  }
  function reset(nextSeed = seed) {
    st = buildState(nextSeed);
    root.Query.aboutServer = { ...st.about };
    mode = { mode: 'up' };
    log.length = 0;
  }

  /** Run one GraphQL request body in-process; the HTTP handler and tests share it. */
  async function graphql(body, row = null) {
    const { query, variables, operationName } = body ?? {};
    let doc;
    try { doc = parse(typeof query === 'string' ? query : ''); } catch (e) {
      if (!(e instanceof GqlSyntaxError)) throw e;
      if (row) Object.assign(row, { status: 'rejected', error: e.message });
      return { errors: [{ message: e.message, locations: [e.loc] }] };
    }
    const deprecated = [];
    const invalid = validate(schema, doc, deprecated);
    const first = doc.definitions.find((d) => d.kind === 'operation' && (!operationName || d.name === operationName));
    if (row) {
      row.operation = first?.operation;
      row.fields = first ? first.selectionSet.filter((s) => s.kind === 'field').map((s) => s.name) : [];
      row.variables = variables ?? {};
      row.deprecated = [...new Set(deprecated)];
    }
    if (invalid.length) {
      if (row) Object.assign(row, { status: 'rejected', error: invalid[0].message });
      return { errors: invalid };
    }
    try {
      const out = await execute(schema, doc, { operationName, variables, root });
      if (row) Object.assign(row, out.errors?.length ? { status: 'error', error: out.errors[0].message.split('\r\n')[0] } : { status: 'ok' });
      return out;
    } catch (e) {
      if (!(e instanceof NotImplemented)) throw e;
      const message = `FAKE ENGINE: ${e.message} is valid on Suwayomi-Server v2.3.2243 but this fake does not implement it; add it to bff/test/fixtures/fakeSuwayomiEngine.mjs`;
      if (row) Object.assign(row, { status: 'unimplemented', error: message });
      return { errors: [{ message }] };
    }
  }

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
  }

  function authorized(req) {
    if (!auth) return true;
    const want = 'Basic ' + Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
    return req.headers.authorization === want;
  }

  /** Slow answers still waiting: timer → the wait's resolve, so closing the server can end them at once. */
  const pending = new Map();
  // ⚠️ Watches the RESPONSE's close, not the request's: a GET's IncomingMessage closes as soon as its (empty)
  // body is read, which would end every "slow" wait at once. The response closes early only when the caller
  // hangs up -- a client timeout -- and then nothing is sent.
  const wait = (ms, res) => new Promise((resolve) => {
    const done = () => { clearTimeout(t); pending.delete(t); resolve(); };
    const t = setTimeout(done, ms);
    pending.set(t, done);
    res.once('close', done);
  });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://fake-engine');
    const path = url.pathname;
    try {
      // ---- the test harness's own switches (never part of the engine) ----
      if (path.startsWith('/__')) {
        entry(req, path, 'control');
        if (req.method === 'POST' && path === '/__mode') {
          let body;
          try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'bad_json' }); }
          try { return json(res, 200, setMode(body)); } catch (e) { return json(res, 400, { error: 'bad_mode', message: e.message, modes: MODES, stages: STAGES }); }
        }
        if (req.method === 'GET' && path === '/__mode') return json(res, 200, mode);
        if (req.method === 'GET' && path === '/__log') return json(res, 200, { mode, content: log });
        if (req.method === 'POST' && path === '/__reset') { reset(); return json(res, 200, { ok: true }); }
        if (req.method === 'POST' && path === '/__catalogue') {
          let body;
          try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'bad_json' }); }
          try { return json(res, 200, catalogue(body)); } catch (e) { return json(res, 400, { error: 'bad_catalogue', message: e.message }); }
        }
        // GitHub's releases list for a repository, as GET /repos/{owner}/{repo}/releases answers it (v0.55.1): one release,
        // published a day ago, with a file for each seeded extension's apk and jar on that repository's releases that has
        // `downloads`. The app asks it here with GITHUB_API_URL=<this>/__github (up.sh, for the v55 walk): Fix everything
        // ranks the packages it tries by these counts (lib/extensionRank.ts). Anything else of GitHub's is a 404.
        const gh = /^\/__github\/repos\/([\w.-]+)\/([\w.-]+)\/releases$/.exec(path);
        if (req.method === 'GET' && gh) {
          const at = `https://github.com/${gh[1]}/${gh[2]}/releases/download/`;
          const assets = [...st.extensions.values()].flatMap((e) => [[e.apkUrl, e.downloads?.apk], [e.jarUrl, e.downloads?.jar]])
            .filter(([u, n]) => typeof u === 'string' && u.startsWith(at) && Number.isFinite(n))
            .map(([u, n]) => ({ name: u.slice(u.lastIndexOf('/') + 1), browser_download_url: u, download_count: n }));
          return json(res, 200, assets.length ? [{ tag_name: 'fake-0', published_at: new Date(Date.now() - DAY).toISOString(), assets }] : []);
        }
        if (req.method === 'GET' && path === '/__state') {
          return json(res, 200, {
            mode, settings: st.settings, prefWrites: st.prefWrites, extensions: [...st.extensions.values()],
            pageCache: st.pageCache.size, thumbnailCache: st.thumbnailCache.size, cacheClears: st.cacheClears,
          });
        }
        return json(res, 404, { error: 'not_found' });
      }

      const kind = path === '/api/graphql' ? 'graphql' : 'rest';
      const row = entry(req, path, kind);
      if (mode.mode === 'down') {
        // No answer at all: the caller sees its transport fail ("fetch failed"), as with an engine that is gone.
        row.status = 'dropped';
        req.socket.destroy();
        return;
      }
      if (mode.mode === 'slow') {
        await wait(mode.ms, res);
        if (res.destroyed || req.socket.destroyed) { row.status = 'abandoned'; return; }
      }
      if (!authorized(req)) {
        row.status = 'unauthorized';
        return send(res, 401, 'text/plain', 'Unauthorized', { 'www-authenticate': 'Basic realm="Suwayomi"' });
      }

      if (kind === 'graphql') {
        if (req.method !== 'POST') { row.status = 'refused'; return send(res, 405, 'text/plain', 'Method Not Allowed'); }
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { row.status = 'refused'; return send(res, 500, 'text/plain', 'Server Error'); }
        return json(res, 200, await graphql(body, row));
      }

      // ---- REST: only the paths Uchiyomi stores and fetches ----
      if (req.method === 'GET') {
        let m;
        if ((m = /^\/api\/v1\/manga\/(\d+)\/thumbnail$/.exec(path))) {
          const manga = st.mangas.get(Number(m[1]));
          row.status = manga ? 'ok' : 'missing';
          if (manga) st.thumbnailCache.add(path);
          return manga ? send(res, 200, 'image/png', png(manga.id)) : send(res, 404, 'text/plain', '');
        }
        if ((m = /^\/api\/v1\/manga\/(\d+)\/chapter\/(\d+)\/page\/(\d+)$/.exec(path))) {
          const mangaId = Number(m[1]);
          const chapter = [...st.chapters.values()].find((c) => c.mangaId === mangaId && c.sourceOrder === Number(m[2]));
          if (!chapter || Number(m[3]) >= chapter.pages) { row.status = 'missing'; return send(res, 404, 'text/plain', ''); }
          const failure = extensionFailure(st.sources.get(st.mangas.get(mangaId).sourceId), 'images');
          // Modelled: the engine's status for an image the extension could not fetch was not observable offline.
          if (failure) { row.status = 'error'; return send(res, 500, 'text/plain', `${failure.javaClass}: ${failure.javaMessage}`); }
          row.status = 'ok';
          st.pageCache.add(path);
          return send(res, 200, 'image/png', png(chapter.id * 100 + Number(m[3])));
        }
        if ((m = /^\/api\/v1\/extension\/icon\/([\w.]+)$/.exec(path))) {
          const known = m[1] === PKG.local || st.extensions.has(m[1]);
          row.status = known ? 'ok' : 'missing';
          return known ? send(res, 200, 'image/png', png(m[1].length)) : send(res, 404, 'text/plain', '');
        }
      }
      row.status = 'missing';
      return send(res, 404, 'text/plain', 'Not Found');
    } catch (error) {
      // The fake's own bug. The message goes to the test's output, never into a response body.
      console.error('[fake-engine] request failed', error);
      return send(res, 500, 'application/json', JSON.stringify({ error: 'fake_engine_bug' }));
    }
  }

  return {
    schema,
    handle,
    graphql,
    setMode,
    reset,
    catalogue,
    get mode() { return mode; },
    get state() { return st; },
    log,
    cancelPending() { for (const done of [...pending.values()]) done(); },
  };
}

/**
 * Put an engine on a port. `stop()` closes the port for real (connection refused, as while the engine's JVM is
 * still booting) and `start()` reopens the SAME port, so a SUWAYOMI_URL read once at import keeps working.
 */
export async function startFakeEngine({ port = 0, host = '127.0.0.1', ...opts } = {}) {
  const engine = createFakeEngine(opts);
  const sockets = new Set();
  const server = http.createServer((req, res) => { void engine.handle(req, res); });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  const listen = (p) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(p, host, () => { server.off('error', reject); resolve(); });
  });
  const closeAll = () => new Promise((resolve) => {
    engine.cancelPending();
    for (const s of sockets) s.destroy();
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
  await listen(port);
  const bound = server.address().port;
  const shownHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  return {
    engine,
    server,
    port: bound,
    url: `http://${shownHost}:${bound}`,
    stop: closeAll,
    start: () => (server.listening ? Promise.resolve() : listen(bound)),
    close: closeAll,
  };
}
