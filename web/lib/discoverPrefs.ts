/**
 * Which language of sources this reader browses, remembered.
 *
 * localStorage first and synchronously, so the source picker paints its remembered state on the first frame
 * instead of flashing a default and then correcting itself. The account copy is written behind it, debounced,
 * into `app_settings` -- free-form JSONB merged on write, so this touches nothing else in the blob and the
 * choice follows the reader to their phone with no migration. Exactly the shape `I18nProvider` uses for the
 * UI language.
 */
const KEY = 'yomi.discover';

export interface DiscoverPrefs {
  /** A BCP-47 code from the source list, or '' when no source declares a language. */
  lang: string;
}

export function loadDiscoverPrefs(): Partial<DiscoverPrefs> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

let timer: ReturnType<typeof setTimeout> | null = null;

export function saveDiscoverPrefs(p: DiscoverPrefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private mode; the account copy still works */ }
  if (timer) clearTimeout(timer);
  // Debounced: flicking along a row of language chips should not be a request per chip.
  timer = setTimeout(() => {
    import('./api')
      .then(({ api }) => api('/api/settings', { method: 'PUT', json: { discover: p } }))
      .catch(() => {});
  }, 1200);
}
