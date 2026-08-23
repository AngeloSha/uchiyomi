'use client';
// The translation context and the `useT()` hook.
//
// Kept apart from lib/i18n.ts so the pure parts -- locale detection, the dictionary lookup, the direction
// table -- stay importable from a plain unit test with no React in scope.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  DEFAULT_LOCALE, detectLocale, dirOf, isLocale, loadDict, setActiveDict, storeLocale, storedLocale,
  translate, type Locale,
} from './i18n';

type Ctx = {
  lang: Locale;
  dir: 'ltr' | 'rtl';
  setLang: (l: Locale) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
};

// The default translates by returning the key, which IS the English string -- so a component rendered
// outside the provider (a test, a stray portal) shows correct English rather than throwing or blanking.
const I18nCtx = createContext<Ctx>({
  lang: DEFAULT_LOCALE,
  dir: 'ltr',
  setLang: () => {},
  t: (k, v) => translate({}, k, v),
});

export function I18nProvider({ children }: { children: ReactNode }) {
  // Starts at the default rather than at the detected language, because the server rendered English into the
  // static HTML: picking a different one here would mismatch on hydration. The effect below switches on the
  // first client tick, which is soon enough not to be seen.
  const [lang, setLangState] = useState<Locale>(DEFAULT_LOCALE);
  const [dict, setDict] = useState<Record<string, string>>({});

  const apply = useCallback(async (next: Locale) => {
    const d = await loadDict(next);
    // Published to the module before the state update, so anything rendering in the same tick already sees
    // the new strings rather than one frame of the old ones.
    setActiveDict(d);
    setDict(d);
    setLangState(next);
    if (typeof document !== 'undefined') {
      // Both matter: `lang` drives hyphenation, spellcheck and screen-reader pronunciation, and `dir` is
      // what makes the Arabic layout mirror instead of merely rendering right-to-left text in a left-to-
      // right frame.
      document.documentElement.lang = next;
      document.documentElement.dir = dirOf(next);
    }
  }, []);

  // Pick up the stored choice, or the browser's, on the first client tick.
  useEffect(() => {
    void apply(storedLocale() ?? detectLocale());
  }, [apply]);

  // The server copy wins once it arrives, so a language chosen on a laptop follows to a phone. Deliberately
  // fire-and-forget and deliberately after the local read: waiting on the network to decide what language to
  // render would put a spinner in front of the login screen.
  useEffect(() => {
    let cancelled = false;
    import('./api').then(({ api }) => api<{ lang?: string }>('/api/settings'))
      .then((s) => { if (!cancelled && isLocale(s?.lang)) { storeLocale(s.lang); void apply(s.lang); } })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [apply]);

  const setLang = useCallback((next: Locale) => {
    storeLocale(next);
    void apply(next);
    import('./api').then(({ api }) => api('/api/settings', { method: 'PUT', json: { lang: next } })).catch(() => {});
  }, [apply]);

  const value = useMemo<Ctx>(() => ({
    lang,
    dir: dirOf(lang),
    setLang,
    t: (key, vars) => translate(dict, key, vars),
  }), [lang, dict, setLang]);

  // `key` remounts the subtree when the language changes. `t` is a plain import, so nothing is subscribed
  // to it and nothing would re-render otherwise. Blunt, and correct: this happens once per person, not per
  // interaction, and the alternative is threading a hook through 45 components.
  return <I18nCtx.Provider value={value}><div key={lang} className="contents">{children}</div></I18nCtx.Provider>;
}

export function useT() {
  return useContext(I18nCtx);
}
