// A source's status as the admin screens read it, and MangaDex's source ids: the part of the old Providers panel that
// outlived it. Since v0.54.0 Admin → Sources lists every source one per row from one answer (lib/sourcesPanel.ts), so
// the fold of an extension's languages into one card per package -- and MangaDex's into one card -- went with the panel;
// an extension's languages are its sheet's section (components/ExtensionSheet.tsx), MangaDex's are chips.

import type { Src } from './sourceGroups';

export type SrcStatus = NonNullable<Src['status']>;

/**
 * What a source card can say: the public status, plus `failing` (#115, v0.49.0) -- a source whose Test or daily
 * check failed, or that failed at the same step three times running in normal use, while no cooldown holds it.
 * Admin-only: Discover's Src type is untouched, because GET /api/sources is one cache key for every account.
 */
export type ProviderStatus = SrcStatus | 'failing';

/** The admin row's part providerStatus reads: GET /api/admin/sources `failing`, the open confirmed failures. */
export interface AdminSourceRow {
  failing?: Array<{ stage: string }> | null;
}

/**
 * The status a source wears where only the public list and the admin rows are read -- an extension's language in its
 * sheet (lib/extensions.ts sourceHealth), as the Providers card did until v0.54.0. The public status knows only cooldowns, and any download or the nightly
 * lapsed-block reset puts it back to 'ok', which is how "Manga Ball (EN)" failed its Test under a card that said
 * "ok". A confirmed failure outranks 'ok' and 'quiet'; a cooldown and a switched-off source keep their own
 * words, which already say more than "failing" would.
 */
export function providerStatus(pub: SrcStatus | null | undefined, row?: AdminSourceRow | null): ProviderStatus {
  const st = pub ?? 'ok';
  if ((st === 'ok' || st === 'quiet') && row?.failing?.length) return 'failing';
  return st;
}

/** MangaDex's source id in one language, as the server names it: `mangadex` for English, `mangadex-es-419`, … */
export function mangadexSourceId(code: string): string {
  return code === 'en' ? 'mangadex' : `mangadex-${code.toLowerCase()}`;
}
