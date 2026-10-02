// The language of a series and of a source (v0.52.0), read from the database and the registry: the facts the rules
// in lib/lang.ts are applied to. The same-language guard on every automatic follow (#123) and the editions of one
// work (#72) both start here.
import { q } from './db';
import { getSource } from './sources';
import { baseLang, canonLang, sameLanguage, setUnstatedLang, unstatedLang } from './lang';

/** The module's q, or a transaction's own (db.ts tx), so a caller inside one reads what it has written. */
type Qq = <R = any>(text: string, params?: any[]) => Promise<R[]>;

export interface SeriesLang {
  /** The language the series is in: its own (lib_series.lang), else its main source's, else unstatedLang(). */
  lang: string;
  /** `lang` is the series' own: stated when it was added, by the v0.52.0 data migration, or by an admin. */
  stated: boolean;
  /** The work it is an edition of (lib_series.work_id); null for a series on its own. */
  workId: string | null;
  /**
   * Another edition of the work has the same base language (es beside es-419): compare exact codes
   * (sameLanguage's `exact`), or a source in either language would pass for both editions.
   */
  sameBaseSibling: boolean;
}

async function readSeries(id: string, qq: Qq): Promise<SeriesLang & { sourceId: string | null }> {
  // Every other edition counts, a removed one too: it keeps its language slot (Put back restores it), so it still
  // decides whether codes must be exact. A series merged into another is no edition of anything any more.
  const [s] = await qq<{ lang: string | null; work_id: string | null; source_id: string | null; siblings: string[] }>(
    `SELECT s.lang, s.work_id, s.source_id,
            ARRAY(SELECT o.lang FROM lib_series o
                   WHERE o.work_id = s.work_id AND o.id <> s.id AND o.merged_into IS NULL AND o.lang IS NOT NULL) AS siblings
       FROM lib_series s WHERE s.id = $1`,
    [id],
  );
  const own = canonLang(s?.lang);
  // A main source in every language ("all") says nothing about which one THIS series is in: canonLang reads it as
  // null, and the series falls through to the unstated language.
  const lang = own ?? canonLang(s?.source_id ? getSource(s.source_id)?.lang : null) ?? unstatedLang();
  const base = baseLang(lang);
  return {
    lang,
    stated: own !== null,
    workId: s?.work_id ?? null,
    sameBaseSibling: (s?.siblings ?? []).some((l) => baseLang(l) === base),
    sourceId: s?.source_id ?? null,
  };
}

/**
 * The same rule over a row the caller has read already (v0.52.0, editions): every series DTO, the Discover
 * ownership check and an edition list read `lang` and `source_id` alongside everything else, and asking
 * seriesLanguage per row would be a query each.
 */
export function effectiveLang(lang: string | null | undefined, sourceId: string | null | undefined): string {
  return canonLang(lang) ?? canonLang(sourceId ? getSource(sourceId)?.lang : null) ?? unstatedLang();
}

/** A series' language, whether it is stated, and its work. A series that is not there reads as unstated. */
export async function seriesLanguage(id: string, qq: Qq = q): Promise<SeriesLang> {
  const { sourceId: _own, ...facts } = await readSeries(id, qq);
  return facts;
}

/**
 * The language a source serves: what it declares, else unstatedLang() -- the add-a-site engines declare nothing and
 * serve English, unless the admin says this server's sites do not. 'any' for a source that declares no single
 * language (Suwayomi's "all", "other", several codes): it may serve a series in any language. An id that is not
 * registered declares nothing.
 */
export function sourceLanguage(id: string): string | 'any' {
  const declared = getSource(id)?.lang;
  if (!declared?.trim()) return unstatedLang();
  return canonLang(declared) ?? 'any';
}

/**
 * The same-language rule (#123) on a series' facts already read: a source in the series' language passes (exactly,
 * when the work holds a same-base edition), and so does one that serves any. For a caller that holds the facts
 * rather than the id -- autoFollow's judgeCandidate; everything else filters with followGuard.
 */
export function languageFits(sourceId: string, series: Pick<SeriesLang, 'lang' | 'sameBaseSibling'>): boolean {
  const lang = sourceLanguage(sourceId);
  return lang === 'any' || sameLanguage(series.lang, lang, { exact: series.sameBaseSibling });
}

/**
 * Whether a source may be followed for this series without a person deciding: the same-language guard, built once
 * per series and applied as a filter over candidates. The series' own main source always passes: it is what the
 * series is, whatever either declares -- a MangaDex title that came in through the English adapter's Spanish
 * fallback is stated Spanish and still follows that adapter.
 */
export async function followGuard(seriesId: string): Promise<(sourceId: string) => boolean> {
  const s = await readSeries(seriesId, q);
  return (sourceId) => sourceId === s.sourceId || languageFits(sourceId, s);
}

/**
 * Fill lib/lang.ts's unstated language from server_settings: at boot (server.ts). A settings save that changes the
 * column calls setUnstatedLang with the new value as well, so no request waits for a re-read. Returns what it set.
 */
export async function loadUnstatedLang(): Promise<string> {
  const [row] = await q<{ unstated_lang: string | null }>('SELECT unstated_lang FROM server_settings WHERE id = 1');
  return setUnstatedLang(row?.unstated_lang);
}
