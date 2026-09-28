#!/usr/bin/env node
// Re-capture suwayomi-<version>-schema.json from an extension engine, read-only.
//
//   node bff/test/fixtures/captureSuwayomiSchema.mjs http://127.0.0.1:4567 > bff/test/fixtures/suwayomi-vX-schema.json
//
// Point it at a THROWAWAY engine of the pinned image, never at one that holds somebody's library: e.g.
//   docker run -d --name engine-schema --network none ghcr.io/suwayomi/suwayomi-server:<pin>
//   docker run --rm --network container:engine-schema -v "$PWD:/w" -w /w node:24-alpine \
//     node bff/test/fixtures/captureSuwayomiSchema.mjs http://127.0.0.1:4567 > bff/test/fixtures/suwayomi-<pin>-schema.json
// Only one query is sent (aboutServer and __schema), and the output holds type SHAPES only: no settings values,
// no credentials, nothing the engine stores.
//
// ⚠️ `includeDeprecated: true` on fields, arguments, input fields and enum values is the point of this script.
// Introspection hides deprecated members by default, and the adapter selects several of them today
// (SourceType.isNsfw and baseUrl, Mutation.fetchManga and fetchChapters, ExtensionType.repo,
// SettingsType.extensionRepos, AboutServerPayload.revision). A capture without them made the fake engine
// refuse the shipping adapter's own queries, which the real engine answers.
//
// Dependency-free on purpose, like the fake engine it feeds (fakeSuwayomiEngine.mjs).

const base = (process.argv[2] || process.env.SUWAYOMI_URL || '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('usage: captureSuwayomiSchema.mjs <engine base url>');
  process.exit(2);
}
const auth = process.env.SUWAYOMI_USERNAME
  ? { authorization: 'Basic ' + Buffer.from(`${process.env.SUWAYOMI_USERNAME}:${process.env.SUWAYOMI_PASSWORD || ''}`).toString('base64') }
  : {};

const T = 'fragment T on __Type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } }';
const QUERY = `query {
  aboutServer { name version revision }
  __schema {
    queryType { name } mutationType { name } subscriptionType { name }
    types {
      kind name
      fields(includeDeprecated: true) {
        name isDeprecated deprecationReason type { ...T }
        args(includeDeprecated: true) { name defaultValue isDeprecated deprecationReason type { ...T } }
      }
      inputFields(includeDeprecated: true) { name defaultValue isDeprecated deprecationReason type { ...T } }
      enumValues(includeDeprecated: true) { name isDeprecated deprecationReason }
      possibleTypes { name }
      interfaces { name }
    }
  }
} ${T}`;

/** `{kind: NON_NULL, ofType: {kind: LIST, ...}}` → `[String!]!`, the notation the fixture stores. */
function typeString(t) {
  if (t.kind === 'NON_NULL') return typeString(t.ofType) + '!';
  if (t.kind === 'LIST') return `[${typeString(t.ofType)}]`;
  return t.name;
}

/** A member is its type string alone unless it carries a default, a deprecation or arguments. */
function member(m, withArgs) {
  const out = { type: typeString(m.type) };
  if (withArgs && m.args?.length) out.args = Object.fromEntries(m.args.map((a) => [a.name, member(a, false)]));
  if (m.defaultValue != null) out.default = m.defaultValue;
  if (m.isDeprecated) out.deprecated = m.deprecationReason ?? '';
  return Object.keys(out).length === 1 ? out.type : out;
}

const r = await fetch(`${base}/api/graphql`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json', ...auth },
  body: JSON.stringify({ query: QUERY }),
});
const j = await r.json();
if (!r.ok || j.errors?.length) {
  console.error('introspection failed:', r.status, JSON.stringify(j.errors ?? j).slice(0, 500));
  process.exit(1);
}
const { aboutServer, __schema: s } = j.data;

const types = {};
for (const t of [...s.types].sort((a, b) => a.name.localeCompare(b.name))) {
  if (t.name.startsWith('__')) continue; // the introspection system itself; the fake answers __typename only
  const out = { kind: t.kind };
  if (t.fields) out.fields = Object.fromEntries(t.fields.map((f) => [f.name, member(f, true)]));
  if (t.inputFields) out.inputFields = Object.fromEntries(t.inputFields.map((f) => [f.name, member(f, false)]));
  if (t.enumValues) {
    out.values = t.enumValues.map((v) => v.name);
    const dep = t.enumValues.filter((v) => v.isDeprecated);
    if (dep.length) out.deprecatedValues = Object.fromEntries(dep.map((v) => [v.name, v.deprecationReason ?? '']));
  }
  if (t.possibleTypes?.length) out.possibleTypes = t.possibleTypes.map((p) => p.name).sort();
  if (t.interfaces?.length) out.interfaces = t.interfaces.map((i) => i.name).sort();
  types[t.name] = out;
}

const doc = {
  _provenance: [
    `Introspected from ${aboutServer.name} ${aboutServer.version} (${aboutServer.revision}) by captureSuwayomiSchema.mjs.`,
    'Deprecated fields, arguments, input fields and enum values are included; introspection hides them by default.',
    'Type shapes only. Types named __* (introspection) are left out.',
  ],
  engine: { name: aboutServer.name, version: aboutServer.version, revision: aboutServer.revision },
  roots: { query: s.queryType?.name ?? null, mutation: s.mutationType?.name ?? null, subscription: s.subscriptionType?.name ?? null },
  types,
};

// One type per line and one member per line, so an engine upgrade reads as a reviewable diff.
const lines = ['{'];
lines.push(`  "_provenance": ${JSON.stringify(doc._provenance)},`);
lines.push(`  "engine": ${JSON.stringify(doc.engine)},`);
lines.push(`  "roots": ${JSON.stringify(doc.roots)},`);
lines.push('  "types": {');
const names = Object.keys(types);
names.forEach((name, i) => {
  const t = types[name];
  const parts = [];
  for (const [k, v] of Object.entries(t)) {
    if ((k === 'fields' || k === 'inputFields') && v && typeof v === 'object') {
      const ms = Object.entries(v).map(([n, m]) => `      ${JSON.stringify(n)}: ${JSON.stringify(m)}`);
      parts.push(`    ${JSON.stringify(k)}: {\n${ms.join(',\n')}\n    }`);
    } else {
      parts.push(`    ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
    }
  }
  lines.push(`   ${JSON.stringify(name)}: {\n${parts.join(',\n')}\n   }${i < names.length - 1 ? ',' : ''}`);
});
lines.push('  }');
lines.push('}');
process.stdout.write(lines.join('\n') + '\n');
