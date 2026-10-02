// The language model (v0.52.0, #72 and #123): which language a code names, whether two codes name the same one,
// and MangaDex's own spellings. Pure -- no database, no registry -- so the rules are tested on their own;
// lib/seriesLang.ts applies them to series and sources.
//
// App codes are BCP-47, the codes Mihon and Suwayomi use: en, es, es-419, pt-BR, zh-Hans, zh-Hant. MangaDex spells
// five of its languages its own way (es-la, pt-br, zh, zh-hk, tl), and those spellings belong inside its queries:
// everything stored or compared goes through canonLang first, so "es-la" from a MangaDex feed and "es-419" from an
// extension are one language, and a series reads the same code in both apps.

/**
 * The languages MangaDex is offered in: the app code, and MangaDex's code for it. English is the first row and is
 * the plain `mangadex` adapter, always on; server_settings.mangadex_langs lists the others an admin turned on. The
 * five that differ are the Mihon MangaDex extension's own mapping (its dexLang). The romanized codes (ja-ro, ko-ro,
 * zh-ro) are not offered.
 */
export const MANGADEX_LANGS: ReadonlyArray<{ readonly code: string; readonly md: string }> = [
  { code: 'en', md: 'en' },
  { code: 'es-419', md: 'es-la' },
  { code: 'es', md: 'es' },
  { code: 'pt-BR', md: 'pt-br' },
  { code: 'pt', md: 'pt' },
  { code: 'fr', md: 'fr' },
  { code: 'de', md: 'de' },
  { code: 'it', md: 'it' },
  { code: 'ru', md: 'ru' },
  { code: 'uk', md: 'uk' },
  { code: 'pl', md: 'pl' },
  { code: 'tr', md: 'tr' },
  { code: 'ar', md: 'ar' },
  { code: 'id', md: 'id' },
  { code: 'vi', md: 'vi' },
  { code: 'th', md: 'th' },
  { code: 'ms', md: 'ms' },
  { code: 'fil', md: 'tl' },
  { code: 'zh-Hans', md: 'zh' },
  { code: 'zh-Hant', md: 'zh-hk' },
  { code: 'ja', md: 'ja' },
  { code: 'ko', md: 'ko' },
  { code: 'hu', md: 'hu' },
  { code: 'ro', md: 'ro' },
  { code: 'cs', md: 'cs' },
  { code: 'nl', md: 'nl' },
];

const FROM_MD = new Map(MANGADEX_LANGS.map((l) => [l.md, l.code]));
const TO_MD = new Map(MANGADEX_LANGS.map((l) => [l.code, l.md]));

/**
 * Codes that name no single language: Suwayomi's "all" (one source in every language) and "other" (what Mihon
 * files a source under when it fits no language). A declaration that is no language tag at all -- several codes in
 * one string -- reads the same way.
 */
const NO_SINGLE = new Set(['all', 'other']);

/** What a code says: nothing, no single language (kept as written, see sameLanguage), or one language. */
type Said = { kind: 'none' } | { kind: 'many'; raw: string } | { kind: 'one'; code: string };

function said(code: string | null | undefined): Said {
  const raw = (code ?? '').trim().toLowerCase().replace(/_/g, '-');
  if (!raw) return { kind: 'none' };
  if (NO_SINGLE.has(raw)) return { kind: 'many', raw };
  // MangaDex's spellings before Intl: to Intl "es-la" is valid, and means Spanish as written in Laos.
  const app = FROM_MD.get(raw);
  if (app) return { kind: 'one', code: app };
  try {
    // Intl writes the case BCP-47 does (pt-BR, zh-Hant) and replaces the retired codes (iw is he, in is id).
    return { kind: 'one', code: new Intl.Locale(raw).toString() };
  } catch {
    return { kind: 'many', raw };
  }
}

/**
 * The app's code for any spelling of a language: BCP-47's case, MangaDex's codes mapped ("es-la" is "es-419", "zh"
 * is "zh-Hans"), "_" read as "-". Null for a code that names no single language ("all", "other", several at once)
 * and for an empty one -- both are "not one language"; seriesLang.ts sourceLanguage, which must tell them apart,
 * checks for empty first.
 */
export function canonLang(code: string | null | undefined): string | null {
  const s = said(code);
  return s.kind === 'one' ? s.code : null;
}

/** The language without its region or script: "es" for "es-419", "zh" for "zh-Hant". Null as canonLang is. */
export function baseLang(code: string | null | undefined): string | null {
  const c = canonLang(code);
  return c ? new Intl.Locale(c).language : null;
}

/** MangaDex's code for an app code, for its queries: "es-419" asks for "es-la". Null when MangaDex is not offered in it. */
export function mdLang(app: string | null | undefined): string | null {
  const c = canonLang(app);
  return (c && TO_MD.get(c)) ?? null;
}

/**
 * A language as a short label: "ES-419", "PT-BR", "ZH-HANT". For text that is never translated -- folder names,
 * "MangaDex (ES-419)", Komga titles -- so it is the code itself, upper-cased, and reads the same in every app
 * language. Empty for no single language.
 */
export function langLabel(code: string | null | undefined): string {
  return canonLang(code)?.toUpperCase() ?? '';
}

let unstated = 'en';

/**
 * The language of sources and series that do not say (server_settings.unstated_lang). English unless the admin
 * picks another: the sources that declare none are mostly the add-a-site engines, which serve English, and
 * lib/borrowNames.ts has counted an unknown language as English since v0.47.0. A synchronous read because it is
 * used inside filters: seriesLang.ts loadUnstatedLang fills it at boot, and the settings PATCH sets it as it saves.
 */
export function unstatedLang(): string {
  return unstated;
}

/** Set the unstated language. Anything that is not one language -- empty, "all" -- keeps English. Returns what was set. */
export function setUnstatedLang(code: string | null | undefined): string {
  unstated = canonLang(code) ?? 'en';
  return unstated;
}

/**
 * Whether two codes name the same language: the same base language in the same script. "es" is "es-419", "pt" is
 * "pt-BR", "en" is "en-US"; "zh-Hans" is not "zh-Hant" -- one language written two ways, and a scanlation is in
 * one of them. A code with no script takes the one BCP-47 makes likely ("zh" is Simplified, "zh-TW" Traditional);
 * a language with no likely script compares by base alone.
 *
 * An empty code is the unstated language, whichever side leaves it blank: a Spanish source's names must reach an
 * English series nowhere, and an unknown on one side is exactly how they would.
 *
 * `exact` compares whole codes, for a work that holds two editions in one base language (es and es-419): there,
 * "Spanish" does not say which edition a source belongs to.
 *
 * A code that names no single language ("all") is the same only as itself, as borrowNames' rule always had it.
 * Whether a source in every language may serve a series is the follow guard's question, and it says yes
 * (seriesLang.ts followGuard); whether a name from it is in this series' language, nothing here can tell.
 */
export function sameLanguage(
  a: string | null | undefined,
  b: string | null | undefined,
  opts: { exact?: boolean } = {},
): boolean {
  const x = orUnstated(said(a));
  const y = orUnstated(said(b));
  if (x.kind === 'many' || y.kind === 'many') return x.kind === 'many' && y.kind === 'many' && x.raw === y.raw;
  if (opts.exact) return x.code === y.code;
  const lx = new Intl.Locale(x.code);
  const ly = new Intl.Locale(y.code);
  if (lx.language !== ly.language) return false;
  const sx = lx.maximize().script;
  const sy = ly.maximize().script;
  return !sx || !sy || sx === sy;
}

function orUnstated(s: Said): Exclude<Said, { kind: 'none' }> {
  return s.kind === 'none' ? { kind: 'one', code: unstated } : s;
}
