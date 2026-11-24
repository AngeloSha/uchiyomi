# Source pack settings in the WebUI

Status: implemented (steps 1 and 2 of the rollout). Written 2026-11-24 against 0.109.0;
the core is server- and web-side only until a pack declares `preferences`.

This is the follow-up to the extension settings screen: source packs should get the same
**Admin → Sources → (source) → Settings** experience, plus a per-source **Auto Update?** switch
that every pack gets without declaring anything.

## Why

A pack has no extension engine, so nothing today can ask it for a preference screen. The packs that
have options already solve their own configuration with a hand-rolled chain, resolved on every call:

```
real env var  >  sources/.uchi.env  >  in-file constant
```

In the separately kept pack repository (the source pack is arm's length from this one, see
`.gitignore:12`), `.uchi.env` lives inside the read-only `SOURCES_PATH` bind mount. The README
states the consequence: the file must be edited on the host, and the loader skips dotfiles so it is
never mistaken for a source. Env vars cannot be refreshed without recreating the container. That is
exactly the friction a WebUI store removes.

The feature is therefore **not** "invent options for packs". It is "give the option names packs
already use a server-side store, with the WebUI as the highest layer, and keep env, file and
constants as fallbacks". An untouched pack installation behaves exactly as it does now.

## What exists today

Extension settings, to reuse rather than rebuild:

| Layer | Where |
|---|---|
| Preference model (wire + UI) | `web/lib/sourcePrefs.ts` |
| Settings body | `web/components/ExtensionSettings.tsx:109` (`ExtensionSettingsBody`) |
| Sheet section | `web/components/ExtensionSheet.tsx:61` (`ExtensionSection`), body at `:231` |
| Mounted only for extensions | `web/components/SourceSheet.tsx:351-359` |
| Read/write engine screen | `bff/src/lib/sources/suwayomi/prefs.ts` |
| Routes | `bff/src/routes/numbering.ts:81-140` (`GET`/`POST /api/admin/extensions/sources/:id/preferences`), registered from `bff/src/routes/admin.ts:657` |
| Overview contract | `bff/src/lib/sourcesOverview.ts:130-209` |

Packs today:

| Layer | Where |
|---|---|
| Contract | `bff/src/lib/sources/types.ts:105-227` (`SourceAdapter`), `:229-234` (`SourceHost`) |
| Loader | `bff/src/lib/sources/loader.ts` (registry, `fromPack`, `registerAdapter`, `loadSources`, `reloadSources`) |
| Reload | `bff/src/routes/admin.ts:1544` (`POST /api/admin/sources/reload` → `reloadAll()`) |
| Overview kind | `bff/src/lib/sourcesOverview.ts:164-171` (`kindOf`) |

Before this change, `SourceAdapter` had no preference member and `SourceHost` exposed only `cfGet`,
`cfPost` and `cfSession`. Most packs ignore the host argument; `likemanga.js`,
`talesdemonsandgods.js` and `mahouirexnohentaikarte.js` use `host.cfGet` for FlareSolverr.

An option inventory of the 11 files (15 adapters) in `uchi-sources`:

| Pack | Options today |
|---|---|
| schale | clearance, UA, bearer token, gateway URL, gateway-images switch, min/max interval, max wait, retries, no-updates switch |
| hdoujin | clearance, UA, optional token, min/max interval, max wait, retries |
| doujin | full cookie header, UA |
| exhentai | full cookie header or 7 individual cookie parts, min/max interval, max wait, retries |
| hentaiyi | page-image base URL (shared by its three adapters) |
| pandachaika | min interval |
| likemanga, rentagirlfriend, talesdemonsandgods, onepunchmanofficial, mahouirexnohentaikarte | none |

Everything is a boolean or a string; the numeric pacing values are already parsed by the packs. The
dominant fields are secrets (clearance tokens, cookie headers, bearer tokens).

## Decisions already taken

- Scope is **per adapter id**, not per pack file and not per user. Server-wide, admin-only.
- Secrets are encrypted at rest, reusing `bff/src/lib/secretbox.ts`.
- The new table is covered by backups automatically: `bff/src/lib/backup.ts` dumps the whole
  database with `pg_dump`, so no backup change is needed.
- A numbering option is **not required**. The descriptor may carry `numbering` for the day a pack
  changes chapter numbers, but no current pack does.
- **Auto Update?** is wanted for every pack, but is out of scope for the first implementation
  ([later](#later-auto-update-per-source)).

## Contract

### Descriptor on the adapter

```ts
// bff/src/lib/sources/types.ts
type PrefValue = boolean | string | string[];

interface SourcePreference {
  key: string;                 // stored key; use the pack's existing UCHI_* name
  type: 'switch' | 'checkbox' | 'list' | 'multiselect' | 'text';
  title: string;
  summary?: string;
  default?: PrefValue;
  entries?: string[];          // list / multiselect
  entryValues?: string[];      // list / multiselect, parallel to entries
  numbering?: boolean;         // changing it renumbers chapters; no pack needs it yet
  secret?: boolean;            // sealed at rest, never returned to the browser
}

interface SourceAdapter {
  // ...
  preferences?: SourcePreference[];
}
```

`PrefValue` currently lives in `bff/src/lib/sources/suwayomi/prefs.ts`. Move the union into
`types.ts` (or re-export it) so the pack SDK does not depend on the Suwayomi module.

Validation happens at `registerAdapter` time, like the loader's existing `isAdapter` check. An
invalid descriptor is logged and dropped; the source keeps working rather than disappearing over a
typo. Checked: unique keys, key shape (`[A-Za-z_][A-Za-z0-9_.-]{0,127}`, so the existing `UCHI_*`
and dotted names fit), type, that `entries`/`entryValues` are parallel for list types, and the text
length cap. A `default` that does not match its type is omitted from the screen; the descriptor
itself is kept so the admin can still set a valid value.

### Accessor on the host

```ts
interface SourceHost {
  // cfGet, cfPost, cfSession unchanged
  settings(id: string): Promise<Record<string, PrefValue>>;
}
```

`settings` returns **only stored values**, sparse, never the declared defaults and never the env or
file values. That is deliberate: the pack keeps its existing fallback chain and the WebUI becomes
one layer on top.

```js
const stored = await host.settings(id);                 // {} when nothing is stored
const clearance = firstSet(stored.UCHI_SCHALE_CLEARANCE, secret('UCHI_SCHALE_CLEARANCE'), CLEARANCE_CONST);
```

`firstSet` must treat `undefined` as unset. `secret()` returns `''`, so `??` alone is not enough;
the helper is a one-liner per pack and keeps booleans (where `false` is a real value) correct.

The precedence is therefore:

```
WebUI value (if stored)  >  real env var  >  .uchi.env  >  in-file constant
```

`settings` is async and reads the database per call. The packs already resolve configuration per
call, so this preserves the "no restart, next request" promise that `.uchi.env` has today. A pack
that calls `cfg()` in a loop should cache it per request, as it would cache anything else.

### Defaults and the fallback note

If a preference is unset in the WebUI, the screen shows the descriptor's declared default. The
deployment may actually be using a different env or file value, so the field must say so:

> Unset here. The pack falls back to its own configuration (environment or `.uchi.env`).

Do not try to make packs report their effective value. That would widen the contract for a cosmetic
gain and would still be stale for values computed at call time.

### Reset

Reset is mandatory for packs. The extension screen never needs it because the engine always holds
a concrete value; a pack preference saved once would otherwise shadow env and file forever.

Add a clear action, either `DELETE /api/admin/sources/:id/preferences/:key` or a write with a null
value. A per-field **Reset** control sends it. Keep the pack's own fallback as the visible result.

### Secrets

For a `secret` descriptor:

- `seal(value, 'sourcepref')` on write, `open()` on read. Add `sourcepref` to `SALTS` in
  `bff/src/lib/secretbox.ts`; the scrypt key is cached per purpose, so cost is one derivation per
  process and one AES operation per read.
- `GET` never returns the stored plaintext. Return `value: null` and `set: true`; the UI shows an
  empty input with a "stored" placeholder and the Reset button.
- A rotated `JWT_SECRET` makes `open()` return null (existing behaviour). Treat it as unset and tell
  the admin the stored value could not be read, rather than failing the whole screen.
- The audit entry records the key, the change and the length only, matching `source.extension_pref`;
  the value itself never reaches the log.

Encrypted values are still inside the database dump; `CONFIG_DIR` (which carries the generated
`JWT_SECRET`) is part of the backup too, so a restore works as long as both halves come back. This
is the same property tracker and notification secrets already have.

## Storage

New migration block in `bff/src/lib/migrate.ts`, next to `source_page_rules`:

```sql
CREATE TABLE IF NOT EXISTS source_settings (
  source_id  text NOT NULL,
  key        text NOT NULL,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, key)
);
```

- One row per stored key; writes are a single `INSERT ... ON CONFLICT (source_id, key) DO UPDATE`.
- Secret values are sealed strings inside the JSON, so the column stays `jsonb`.
- Rows for keys a pack no longer declares are ignored, not deleted. A pack swap should not lose the
  values the previous version stored.
- Name it `source_settings`, **not** `source_prefs`: `bff/src/lib/sourcePrefs.ts` already means
  source priority (which source a series should be taken from), and the two concepts must not be
  confused in code review.

Module: `bff/src/lib/sourceSettings.ts` with `readSourceSettings(id, prefs)`,
`writeSourceSetting(id, pref, value)` and `clearSourceSetting(id, key)`, plus descriptor-aware
validation. The Suwayomi module keeps its own engine-screen code unchanged.

## Server routes

`bff/src/routes/sourceSettings.ts`, registered from `bff/src/routes/admin.ts` next to
`numberingRoutes` (line 657), so the existing `authenticate` + `requireAdmin` hooks cover it.

```
GET    /api/admin/sources/:id/preferences
POST   /api/admin/sources/:id/preferences          { key, value }
DELETE /api/admin/sources/:id/preferences/:key
```

- Reject `sw:<id>` ids: extensions keep their existing route and their engine's semantics.
- Look up the loaded adapter and its descriptors. No descriptors: return an empty `preferences`
  list (the overview flag keeps the section hidden until Auto Update exists).
- Respond with the same shape the extension screen already consumes, so the web model is reused:
  `{ source, siblings: [], preferences, usedBy, renumbers }`, and on write
  `{ ok, changed, applied: true, remap: 0, preferences, usedBy, renumbers }`.
  `usedBy` counts visible `lib_series` on the adapter id; `renumbers` stays 0 until a `numbering`
  descriptor exists. `applied` is always true because the database write *is* the application.
- Validate against the descriptor, not a generic union. `unknown_pref` and `bad_value` reuse the
  wording the web's `prefErrorText` already prints.
- Audit `source.pack_pref` (and `source.pack_pref_reset` on clear) with the source, key and value
  shape; text and secret values are logged as `{ length }`, never verbatim.
- A changed value clears the adapter's detail cache, so the next request sees it without a reload.
  `numbering_pending` is written only when the descriptor says `numbering`, and the response's
  `remap` is the number of series queued; it stays 0 for every current pack.
- Add `settings: boolean` to `OverviewSource` in `bff/src/lib/sourcesOverview.ts`, computed from the
  adapter's descriptors (and, once Auto Update lands, true for every pack). The sheet needs this to
  decide whether to draw the section without an extra request per source.

## Web UI

- Reuse `web/lib/sourcePrefs.ts` types. Extend `SourcePref` with `secret?: boolean` and
  `set?: boolean` (or `hasValue`), which the extension backend simply never sends.
- Generalize `ExtensionSettingsBody` with an `endpoint` prop (and pack wording), or extract the
  control rendering into a `SettingsBody` used by both. Do not fork a second copy of the switch,
  list, multiselect and text rendering.
- Secret fields: password-style input, empty when stored, "stored" placeholder, Reset.
- Every text field keeps its own Save, as the extension screen does. A keystroke is not a change
  worth writing.
- Add a pack branch in `web/components/SourceSheet.tsx` next to the extension branch at
  `:351-359`, for `s.kind === 'pack'`.
- No deep-link change. `settingsTarget` in `web/lib/sourcesPanel.ts:147-150` keeps accepting only
  a numeric extension id, because pack settings already open from the source sheet
  (`?source=<packId>`). `extensionSettingsHref` stays extension-only rather than growing a second
  meaning.
- New strings (about 8) must land in all nine locale files, or
  `web/test/localeCoverage.test.ts` fails: Settings, no settings, Saved, Reset, stored placeholder,
  the fallback note, the unreadable-secret sentence, Auto Update (later).
- Pack-provided titles and summaries are not translated, exactly like Mihon extension preferences.

## Pack-side changes

Per file, about 15 lines:

1. Declare `preferences` on every adapter, using the existing `UCHI_*` names as keys and the current
   defaults in `default`.
2. Replace the top of `cfg()` with `await host.settings(id)` plus the `firstSet` helper.
3. Keep env, `.uchi.env` and the constants exactly as they are. `.uchi.env` remains supported and
   documented as the fallback.

Two files need a slightly larger change because they read `process.env` at module load:
`hentaiyi.js` (`IMG`) and `pandachaika.js` (`MIN_INTERVAL_MS`). Their value must move into a
per-call `cfg()` to be live. The others already resolve per call.

`exhentai.js` and `hentaiyi.js` export three adapters from one file, so the UI will show three
screens with identical cookie/UA or image-base fields. That follows the per-adapter decision; a
shared "pack" scope would fix it and is deliberately deferred.

Testing in `uchi-sources` is plain Node asserts with no build step, so a fake host is cheap:

```js
const adapter = require('../sources/schale.js').register({ settings: async () => ({ UCHI_SCHALE_UA: 'X' }) });
```

Assert precedence (stored beats env beats file beats constant), that a stored change is visible on
the next call, and that an unset key still falls through.

## Later: Auto Update per source

Requirement (2026-11-24): every source pack gets an **Auto Update?** toggle, so an admin can keep a
pack installed and searchable while it stops polling for new chapters. This is a server-owned
preference, not something a pack declares, so every pack shows it even with no `preferences`.

Semantics to settle before building:

- Only the automatic new-chapter sweep, or also source scout, fill-details and repair? The updater
  is the obvious scope; the rest should keep working unless asked.
- A series with copies from two packs should still update through the other one. The updater
  iterates source copies (`f.source` in `bff/src/lib/updater.ts`, skip point near `blockedNow` at
  `:419`), so the switch belongs on the copy, not the series.
- Health must say "updates paused", not "switched off": do **not** reuse
  `source_health.disabled`, which `bff/src/lib/sourceStanding.ts` reads as `off` for Replace, Find
  and Health. `bff/src/lib/health.ts:596` already has an `updates_paused` action for a paused series
  and is the model.
- Manual actions stay manual: Check now, Test, search and add must ignore the switch.

Storage recommendation: `source_health.auto_update boolean NOT NULL DEFAULT true`, because that
table already has one row per source (created lazily), already holds the `disabled` admin
preference, and the updater already reads it through the standings. The alternative is a reserved
key in `source_settings`, which keeps all per-source switches in one place but mixes server-owned
and pack-declared keys.

Once it exists, the pack settings section renders for every pack, so the overview flag becomes
`settings: true` for all pack sources.

## Rollout

| Step | Work | Status |
|---|---|---|
| 1 | Descriptor type, loader validation, `SourceHost.settings`, `source_settings` migration and module, GET/POST/DELETE routes, overview flag, audit, encryption. | Done in this tree. |
| 2 | Settings body endpoint prop, secret/reset support, pack branch in the sheet, locales. | Done in this tree. |
| 3 | Pilot `schale.js` in `uchi-sources`, then the remaining five files with options. ~90 lines across the pack repo. | Next, in the separately kept pack repository. |
| 4 | Docs: pack contract in `docs/CONFIGURATION.md` (the section at `:235-262`), routes in `docs/api.md`. | Done in this tree. |
| 5 | Tests: descriptor validation, route auth/validation/secret round-trip/reset, loader skip, overview flag; web control rendering and locale coverage; pack fake-host test. | Descriptor unit test and locale coverage landed; pack fake-host test travels with step 3. |
| 6 | Later: Auto Update toggle, migration, updater and Health wiring, string, overview change. | Deferred. |

The first step is inert: no pack declares descriptors, so no screen changes until step 3. A pack
that declares one gets the section without a server change.

## Open questions

- Auto Update scope and storage (above).
- Multi-line input for cookie headers? A single-line text input works but is unpleasant for a
  1 KB cookie string; a textarea variant could be added to the `text` type later.
- Group preferences by pack file rather than adapter id? Deferred; the three-adapter packs are the
  only case that feels it.
- Should a pack be able to read a *different* adapter's settings (shared credentials across
  `hentaiyi-en`/`-jp`/`-all`)? `host.settings(id)` can already be called with any id; document it as
  allowed only after the shared-scope question is decided.
- Orphan rows from removed keys are kept forever. They are tiny, and keeping them makes a pack
  downgrade lossless; no cleanup planned.
