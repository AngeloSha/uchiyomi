#!/usr/bin/env node
// schemaDiff.mjs <old schema.json> <new schema.json> [--json]
//
// What changed between two captures of the extension engine's schema (bff/test/fixtures/captureSuwayomiSchema.mjs):
// types added and removed, members (fields, arguments, input fields, enum values) added and removed, members whose
// type changed, and members newly deprecated. The weekly canary (.github/workflows/engine-canary.yml) runs it between
// the pinned engine's capture and a new engine's, and keeps the result with the run.
//
// The early warning is the deprecations: a member deprecated in a new engine is usually removed in a later one, and
// test/suwayomiOperations.test.ts fails for every one of them that Uchiyomi's documents use. This only lists them.
// Dependency-free; exits 0 whatever changed (2 for bad arguments).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `{type, args?, default?, deprecated?}` or a bare type string, as the capture stores a member. */
const shape = (m) => (typeof m === 'string' ? { type: m } : m);

/** Every member of a capture, flat: `Type.field`, `Type.field(arg)`, `Input.field`, `Enum.VALUE`. */
export function members(schema) {
  const out = new Map();
  for (const [name, t] of Object.entries(schema.types ?? {})) {
    for (const key of ['fields', 'inputFields']) {
      for (const [f, raw] of Object.entries(t[key] ?? {})) {
        const m = shape(raw);
        out.set(`${name}.${f}`, { type: m.type, deprecated: m.deprecated });
        for (const [a, rawArg] of Object.entries(m.args ?? {})) {
          const arg = shape(rawArg);
          out.set(`${name}.${f}(${a})`, { type: arg.type, deprecated: arg.deprecated });
        }
      }
    }
    for (const v of t.values ?? []) out.set(`${name}.${v}`, { type: name, deprecated: t.deprecatedValues?.[v] });
  }
  return out;
}

export function diff(before, after) {
  const typesA = new Set(Object.keys(before.types ?? {}));
  const typesB = new Set(Object.keys(after.types ?? {}));
  const a = members(before);
  const b = members(after);
  const inType = (m, types) => types.has(m.split('.')[0]);
  const out = {
    from: before.engine?.version ?? null,
    to: after.engine?.version ?? null,
    addedTypes: [...typesB].filter((t) => !typesA.has(t)).sort(),
    removedTypes: [...typesA].filter((t) => !typesB.has(t)).sort(),
    // Members of types both have: a whole new or whole removed type is said once, above.
    added: [...b.keys()].filter((m) => !a.has(m) && inType(m, typesA)).sort(),
    removed: [...a.keys()].filter((m) => !b.has(m) && inType(m, typesB)).sort(),
    changed: [...b.keys()].filter((m) => a.has(m) && a.get(m).type !== b.get(m).type)
      .sort().map((m) => ({ member: m, from: a.get(m).type, to: b.get(m).type })),
    deprecated: [...b.keys()].filter((m) => b.get(m).deprecated !== undefined && (!a.has(m) || a.get(m).deprecated === undefined))
      .sort().map((m) => ({ member: m, reason: b.get(m).deprecated })),
  };
  return out;
}

export function text(d) {
  const lines = [`Schema: ${d.from ?? '?'} -> ${d.to ?? '?'}`];
  const list = (title, xs) => { if (xs.length) lines.push(`${title} (${xs.length}):`, ...xs.map((x) => `  ${x}`)); };
  list('Types added', d.addedTypes);
  list('Types removed', d.removedTypes);
  list('Members added', d.added);
  list('Members removed', d.removed);
  list('Types changed', d.changed.map((c) => `${c.member}: ${c.from} -> ${c.to}`));
  list('Newly deprecated', d.deprecated.map((x) => `${x.member}${x.reason ? ` -- ${x.reason}` : ''}`));
  if (lines.length === 1) lines.push('No change.');
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [fa, fb] = process.argv.slice(2).filter((x) => !x.startsWith('--'));
  if (!fa || !fb) { console.error('usage: schemaDiff.mjs <old schema.json> <new schema.json> [--json]'); process.exit(2); }
  const d = diff(JSON.parse(readFileSync(fa, 'utf8')), JSON.parse(readFileSync(fb, 'utf8')));
  console.log(process.argv.includes('--json') ? JSON.stringify(d, null, 2) : text(d));
}
