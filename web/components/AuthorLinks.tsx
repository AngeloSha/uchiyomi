'use client';
import { Fragment } from 'react';
import Link from 'next/link';
import { t as tr } from '@/lib/i18n';
import { activeLocale, cached } from '@/lib/format';
import { authorHref, authorNames } from '@/lib/authorNames';

/** Where the names go in the translation's own words ("by {author}", "作：{author}", "تأليف {author}"). */
const SLOT = '\u0000';

/**
 * The names on an author line, joined the reader's way ("A, B and C", "A、B和C"), each name an element of its own. An
 * old WebView without Intl.ListFormat gets the names side by side with commas.
 */
function joinedParts(names: string[]): Array<{ name: boolean; value: string }> {
  try {
    const list = cached('authors:and', () => new Intl.ListFormat(activeLocale(), { type: 'conjunction' }));
    let next = 0;
    // By position, not by value: formatToParts hands each name back in order.
    return list.formatToParts(names).map((p) => (p.type === 'element' ? { name: true, value: names[next++] } : { name: false, value: p.value }));
  } catch {
    return names.flatMap((value, i) => [...(i ? [{ name: false, value: ', ' }] : []), { name: true, value }]);
  }
}

/**
 * "by Chugong (추공), Gi So-Ryeong (기소령) and h-goon (현군)" on a series page (v0.100.0, #338): each name opens the
 * Library showing every series by that person -- the whole name in any of its spellings (bff lib/ownedCatalog.ts
 * resolveAuthorNames), as each genre below opens the Library filtered by it. Each name is isolated for direction, so an
 * Arabic page keeps "Chugong (추공)" in one piece.
 */
export function AuthorLinks({ line }: { line: string }) {
  const names = authorNames(line);
  if (!names.length) return null;
  const [before, after = ''] = tr('by {author}', { author: SLOT }).split(SLOT);
  return (
    <span className="text-fog-300" data-series-authors>
      {before}
      {/* A computer's title block over the banner is pointer-events-none (app/series/page.tsx): each name takes its clicks
          back, as the edition chips there do. Reintroduce by dropping `pointer-events-auto`: authorWalk.mjs's click lands
          on the banner's shade and the page stays where it is. */}
      {joinedParts(names).map((p, i) => (p.name
        ? <Link key={i} href={authorHref(p.value)} data-series-author
            className="pointer-events-auto underline decoration-fog-500/40 underline-offset-[3px] transition-colors hover:text-fog-100 hover:decoration-accent focus-visible:text-fog-100 focus-visible:decoration-accent">
            <bdi>{p.value}</bdi>
          </Link>
        : <Fragment key={i}>{p.value}</Fragment>))}
      {after}
    </span>
  );
}
