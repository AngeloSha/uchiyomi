'use client';
import { t as tr } from '@/lib/i18n';
import { moreFoldersText } from '@/lib/libraryFolders';

/**
 * A library's folders on one line (v0.55.1, #148): the first, then how many more -- "Manga/Seinen +2 more". The first
 * folder truncates and the count never does, so a long path cannot hide that there are others; every folder is in the
 * title. The default library holds none and says what it is instead. Admin → Library's cards and the Library page's
 * Move to library list both say it this way.
 */
export function LibraryFolders({ paths, className = '' }: { paths: readonly string[]; className?: string }) {
  // The sentence in the reader's type: a monospace face has no Arabic, and joined script fell apart in it.
  if (!paths.length) return <span className={`block truncate ${className}`}>{tr('everything not in another library')}</span>;
  const more = moreFoldersText(paths);
  return (
    <span className={`flex min-w-0 items-baseline gap-1.5 ${className}`} title={paths.join('\n')} data-library-folders={paths.length}>
      <bdi className="min-w-0 truncate font-mono">{paths[0]}</bdi>
      {more && <span className="shrink-0 text-fog-600" data-library-more>{more}</span>}
    </span>
  );
}
