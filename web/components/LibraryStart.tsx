'use client';
import Link from 'next/link';
import { canDownload, useAuth } from '@/lib/auth';
import { t as tr } from '@/lib/i18n';
import { DISCOVER_HREF, IMPORT_HREF, startKeys } from '@/lib/libraryStart';
import { IcImport, IcPlus } from './icons';

/**
 * Where an empty library starts (v0.55.4, #158): "Import your library" for an admin, with the one line that says what
 * it takes, and "Find series in Discover" for whoever may add series -- the same keys in the same order on the empty
 * Library and on Home's welcome, so a new owner meets them on whichever page the server opened on (lib/libraryStart.ts).
 * Keys rather than capsules (.btn-key, "no more pills"); the first is the accent one. Someone who may do neither is told
 * who can, never handed a key to a page that would refuse them.
 */
export function LibraryStart({ align = 'center' }: { align?: 'center' | 'start' }) {
  const { isAdmin, user, status } = useAuth();
  const keys = startKeys({ isAdmin, mayDownload: status === 'authed' && canDownload(user) });
  const at = align === 'center' ? 'items-center text-center' : 'items-start text-start';
  if (!keys.length) {
    return <p data-library-start="none" className={`text-sm text-fog-400 ${align === 'center' ? 'text-center' : 'text-start'}`}>{tr('Ask whoever runs this server to add some series.')}</p>;
  }
  // The import's line sits under the import key, at that key's width (`w-min` over a key that does not wrap): beside
  // Discover on a wide screen, and on a phone, where the keys stack, still under the key it describes rather than under
  // the last one.
  return (
    <div data-library-start className={`flex flex-wrap items-start gap-x-2 gap-y-3 ${align === 'center' ? 'justify-center' : 'justify-start'}`}>
      {keys.map((k, i) => {
        // A key's words may wrap (h-auto) -- a long language on a narrow phone -- except the import's, whose width sets
        // its line's.
        const cls = `btn-key h-auto min-h-10 px-4 py-2 text-sm ${i === 0 ? 'btn-key-primary' : ''}`;
        return k === 'import' ? (
          <div key={k} className={`flex w-min flex-col gap-1.5 ${at}`}>
            <Link href={IMPORT_HREF} className={`${cls} whitespace-nowrap`} data-start-key="import">
              <IcImport width={17} height={17} aria-hidden />{tr('Import your library')}
            </Link>
            <p className="text-[11px] leading-relaxed text-fog-500">
              {tr('From a Mihon or Tachiyomi backup, a MangaDex list, your AniList, MyAnimeList or Kitsu list, or pasted titles')}
            </p>
          </div>
        ) : (
          <Link key={k} href={DISCOVER_HREF} className={cls} data-start-key="discover">
            <IcPlus width={17} height={17} aria-hidden />{tr('Find series in Discover')}
          </Link>
        );
      })}
    </div>
  );
}
