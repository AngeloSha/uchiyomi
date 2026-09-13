// Which extension languages the operator reads, and the bulk switch that acts on it.
//
// Installing an extension switches on every source it provides, and a multi-language extension provides
// one per language -- thirty sources in languages nobody in the household reads, each of them a fan-out
// target for cross-source search and a step towards the SUWAYOMI_MAX_SOURCES cap (issue #38). The fix is a
// standing instruction, not a one-off: hiding a language turns its sources off now AND keeps them off when
// the next extension is installed. The per-language rows with one Hide/Show button, rather than a source
// list to comb through, are the layout contributor PR #39 proposed.
//
// Pure database helpers. Nothing here talks to the engine, so the rule is testable without one.
import { q, tx } from '../../db';
import { visibleToAll } from '../../visibility';

type Run = <R = any>(text: string, params?: any[]) => Promise<R[]>;

async function readHidden(run: Run, forUpdate = false): Promise<string[]> {
  // Inside setSourcesEnabled the row is locked for the read-modify-write: two languages hidden at once from
  // the panel (the busy state only covers the button that was pressed, and the first call sits in a reload
  // round-trip) each read the list, and the last writer would silently forget the other's language -- its
  // sources off, but the next install switching them back on.
  const rows = await run<{ hidden_langs: unknown }>(`SELECT hidden_langs FROM server_settings WHERE id = 1${forUpdate ? ' FOR UPDATE' : ''}`);
  const v = rows[0]?.hidden_langs;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** The codes the operator has hidden, as the engine reports them (en, ru, zh-Hans). */
export const getHiddenLangs = (): Promise<string[]> => readHidden(q);

export interface BulkArgs {
  ids?: string[];
  langs?: string[];
  enabled: boolean;
}

/**
 * Switch sources on or off, by id or by language, in one statement.
 *
 * `changed` counts rows that actually flipped: the `enabled <> $1` guard keeps a second press from reporting
 * thirty changes for nothing. A row whose lang is NULL (an extension that declares none) is reachable only
 * by id, because ANY() never matches NULL -- and "hide ru" must not touch a source that never said what
 * it was.
 *
 * Only a language selector records the standing preference. Toggling one source by id is an exception to
 * it, not a change of it: switching one Russian source back on to read a single series does not mean
 * Russian is wanted from the next extension.
 */
export async function setSourcesEnabled({ ids = [], langs = [], enabled }: BulkArgs): Promise<{ changed: number; hiddenLangs: string[] }> {
  return tx(async (qq) => {
    const flipped = await qq<{ source_id: string }>(
      `UPDATE suwayomi_sources SET enabled = $1
        WHERE (source_id = ANY($2::text[]) OR lang = ANY($3::text[])) AND enabled <> $1
        RETURNING source_id`,
      [enabled, ids, langs],
    );
    let hidden = await readHidden(qq, langs.length > 0);
    if (langs.length) {
      hidden = enabled ? hidden.filter((l) => !langs.includes(l)) : [...new Set([...hidden, ...langs])];
      await qq('UPDATE server_settings SET hidden_langs = $1::jsonb WHERE id = 1', [JSON.stringify(hidden)]);
    }
    return { changed: flipped.length, hiddenLangs: hidden };
  });
}

/**
 * Record the sources an extension provides, switched on unless their language is hidden (or `enable` is
 * false, on uninstall). This is the install loop that used to live in the route, moved here so the hidden
 * rule has one home and one test.
 */
export async function adoptExtensionSources(
  provided: Array<{ id: string; name: string; lang: string | null; nsfw?: boolean }>,
  enable: boolean,
): Promise<{ on: number; hidden: number }> {
  const hidden = new Set(enable ? await getHiddenLangs() : []);
  let on = 0;
  let left = 0;
  for (const s of provided) {
    const want = enable && !(s.lang && hidden.has(s.lang));
    if (want) on++;
    else if (enable) left++;
    await q(
      `INSERT INTO suwayomi_sources (source_id, name, lang, nsfw, enabled) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (source_id) DO UPDATE SET enabled = EXCLUDED.enabled, name = EXCLUDED.name,
         lang = EXCLUDED.lang, nsfw = EXCLUDED.nsfw`,
      [s.id, s.name, s.lang, !!s.nsfw, want],
    ).catch(() => {});
  }
  return { on, hidden: left };
}

export interface LangRow {
  lang: string | null;
  sources: number;
  enabled: number;
  /** series in the library that were added through a source of this language */
  used: number;
  hidden: boolean;
}

/** One row per language the engine has ever offered, with what hiding it would cost. */
export async function langOverview(): Promise<LangRow[]> {
  const hidden = new Set(await getHiddenLangs());
  const rows = await q<{ lang: string | null; sources: number; enabled: number; used: number }>(
    // `lib_series.source_id` holds the adapter id, which for an extension source is 'sw:' + the engine's
    // id (the same join routes/sources.ts counts usage by). `source_id` is the primary key, so a series
    // joins at most one row and count(ls.id) is a count of series, not of pairs.
    // NULLIF: an extension that declares no language is stored as '' by some paths and NULL by others; both
    // mean the same thing, and a Hide button on a blank row would post a code the route rejects.
    `SELECT NULLIF(ss.lang, '') AS lang,
            count(DISTINCT ss.source_id)::int AS sources,
            count(DISTINCT ss.source_id) FILTER (WHERE ss.enabled)::int AS enabled,
            count(ls.id)::int AS used
       FROM suwayomi_sources ss
       LEFT JOIN lib_series ls ON ls.source_id = 'sw:' || ss.source_id AND ${visibleToAll('ls')}
      GROUP BY NULLIF(ss.lang, '')
      ORDER BY 3 DESC, 2 DESC, 1 NULLS LAST`,
  );
  return rows.map((r) => ({ ...r, hidden: r.lang != null && hidden.has(r.lang) }));
}
