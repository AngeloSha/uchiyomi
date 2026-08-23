// Translation, for a statically exported app.
//
// Next's own i18n routing needs a server, and this ships as `output: 'export'` behind nginx or the API
// itself -- so locale lives in the client, not in the URL. That rules out next-intl's main value (routing
// and server components) and leaves a dictionary and a hook, which is all ~200 strings need.
//
// WHERE THE CHOICE LIVES. In `app_settings`, which is free-form JSONB merged on write, so a language follows
// someone to their phone with no migration. localStorage mirrors it because the login screen has to be
// translated before anyone is signed in, and because reading it synchronously on first paint is what stops
// the app flashing English and then swapping.
//
// English is the source. A key IS its English string, so a missing translation degrades to correct English
// rather than to `home.nav.library`, and adding a string never requires touching nine files at once.

export const LOCALES = [
  { code: 'en', name: 'English', dir: 'ltr' },
  { code: 'es', name: 'Español', dir: 'ltr' },
  { code: 'fr', name: 'Français', dir: 'ltr' },
  { code: 'de', name: 'Deutsch', dir: 'ltr' },
  { code: 'pt-BR', name: 'Português (Brasil)', dir: 'ltr' },
  { code: 'ru', name: 'Русский', dir: 'ltr' },
  { code: 'ja', name: '日本語', dir: 'ltr' },
  { code: 'zh', name: '中文', dir: 'ltr' },
  { code: 'ar', name: 'العربية', dir: 'rtl' },
] as const;

export type Locale = (typeof LOCALES)[number]['code'];
export const DEFAULT_LOCALE: Locale = 'en';

const KEY = 'uchiyomi.lang';

export const dirOf = (code: string): 'ltr' | 'rtl' =>
  LOCALES.find((l) => l.code === code)?.dir ?? 'ltr';

export const isLocale = (v: unknown): v is Locale =>
  typeof v === 'string' && LOCALES.some((l) => l.code === v);

/**
 * Best guess before anyone has chosen: what the browser asks for, narrowed to something we have.
 * `pt-BR` matches exactly; a bare `pt` falls back to it; anything unknown is English.
 */
export function detectLocale(): Locale {
  if (typeof navigator === 'undefined') return DEFAULT_LOCALE;
  for (const raw of navigator.languages ?? [navigator.language]) {
    if (!raw) continue;
    if (isLocale(raw)) return raw;
    const base = raw.split('-')[0];
    const hit = LOCALES.find((l) => l.code === base || l.code.split('-')[0] === base);
    if (hit) return hit.code;
  }
  return DEFAULT_LOCALE;
}

export function storedLocale(): Locale | null {
  if (typeof localStorage === 'undefined') return null;
  const v = localStorage.getItem(KEY);
  return isLocale(v) ? v : null;
}

export function storeLocale(code: Locale): void {
  try { localStorage.setItem(KEY, code); } catch { /* private mode; the server copy still works */ }
}

// ---------------------------------------------------------------------------------------------------

type Dict = Record<string, string>;
const loaded = new Map<string, Dict>();

/**
 * Load a locale's strings. English never fetches anything: it is the source, so its "translation" is the
 * identity function and a network hiccup can never leave the UI blank.
 */
export async function loadDict(code: Locale): Promise<Dict> {
  if (code === 'en') return {};
  const cached = loaded.get(code);
  if (cached) return cached;
  try {
    const r = await fetch(`/locales/${code}.json`, { cache: 'force-cache' });
    if (!r.ok) throw new Error(String(r.status));
    const raw = (await r.json()) as Dict & { _meta?: unknown };
    // `_meta` carries the "machine-assisted, corrections welcome" note that belongs in the file rather than
    // hidden in a commit message. It is not a string anyone renders.
    const { _meta, ...d } = raw;
    loaded.set(code, d as Dict);
    return d as Dict;
  } catch {
    // A missing or broken file must degrade to English, not to an empty screen.
    loaded.set(code, {});
    return {};
  }
}

/**
 * Translate. `vars` fills `{name}` placeholders.
 *
 * The key is the English string, so an untranslated entry renders as good English instead of a dotted path
 * a user should never see.
 */
export function translate(dict: Dict, key: string, vars?: Record<string, string | number>): string {
  let out = dict[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

// ---------------------------------------------------------------------------------------------------
// The ambient dictionary, and `t`.
//
// `t` is a PLAIN IMPORT rather than a hook, and that is a deliberate trade. Making it a hook would mean
// editing the body of all 45 components that display text -- adding `const { t } = useT()` in the right
// scope in each -- which is a large mechanical change to files full of nested render helpers and closures,
// and getting one wrong produces an app that compiles and is broken. A bare import means the change to each
// file is one line at the top and a wrapper around each string.
//
// The cost is that changing language does not re-render by itself, since no component is subscribed to a
// module variable. I18nProvider handles that by remounting its subtree on the language key: heavy, but
// completely reliable, and a person changes language approximately once.
let current: Dict = {};

export function setActiveDict(d: Dict): void {
  current = d;
}

/** Translate. The key IS the English string, so an untranslated entry renders as good English. */
export function t(key: string, vars?: Record<string, string | number>): string {
  return translate(current, key, vars);
}
