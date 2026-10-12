'use client';
// Related works (v0.61.0): what AniList relates a series to, on its page ("Related", above More like this) and at the
// end of the reader ("Next in the story", the sequels alone).
//
// One answer for both (GET /api/series/:id/related, one query key), read from the copy the server keeps -- opening a
// page never asks AniList. A work the library holds is its own card (SeriesCard), opening the series; one it does not
// hold is AniList's cover (OutsideCard), which leads to Discover searching every source for it -- for an account that
// may add series. Without that permission it is not a link, and says it is not in the library: Discover would refuse it.
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth, canDownload } from '@/lib/auth';
import { t as tr } from '@/lib/i18n';
import { findHref, relationLabel, shownRows, type RelatedAnswer, type RelatedOutside } from '@/lib/related';
import { Img, Rail, SectionTitle } from '@/components/ui';
import { SeriesCard, sourceCover } from '@/components/cards';
import { IcPlus } from '@/components/icons';

/** The series' related works: one key, so the reader's end card reuses what the series page already asked. */
function useRelated(seriesId: string) {
  return useQuery({
    queryKey: ['related', seriesId],
    queryFn: () => api<RelatedAnswer>(`/api/series/${encodeURIComponent(seriesId)}/related`),
    enabled: !!seriesId,
    staleTime: 5 * 60_000,
  });
}

/**
 * A related work the library does not hold: AniList's cover, its score in the corner, the relation under the title.
 * With `mayAdd` the whole card is a link to Discover searching for it, with the add mark in the corner the trending
 * cards carry -- squared, as the app's keys are; without it a plain card whose cover says it is not in the library.
 */
export function OutsideCard({ item, note, mayAdd }: { item: RelatedOutside; note?: string; mayAdd: boolean }) {
  const face = (
    <>
      <div className={`grad-border relative aspect-[2/3] overflow-hidden rounded-2xl border border-ink-700/60 transition-all duration-300 ${
        mayAdd ? 'group-hover:-translate-y-1 group-hover:shadow-glow group-active:scale-[0.97]' : ''}`}>
        <Img src={sourceCover(undefined, item.cover)} alt={item.title} fallbackSrc={item.cover || undefined}
          className="h-full w-full" imgClassName={mayAdd ? 'transition-transform duration-500 group-hover:scale-[1.06]' : ''} />
        {item.score != null && (
          <span className="absolute end-1.5 top-1.5 rounded-md bg-ink-950/80 px-1.5 py-0.5 text-[10px] font-semibold text-accent backdrop-blur">
            <bdi dir="ltr">{item.score}%</bdi>
          </span>
        )}
        {mayAdd ? (
          <span aria-hidden data-find-mark
            className="absolute bottom-1.5 end-1.5 grid size-7 place-items-center rounded-lg bg-accent text-black shadow-glow transition group-hover:scale-110">
            <IcPlus width={15} height={15} />
          </span>
        ) : (
          <span data-not-held className="absolute inset-x-0 bottom-0 bg-ink-950/80 px-1 py-1.5 text-center text-[11px] font-semibold text-fog-200 backdrop-blur">
            {tr('Not in your library')}
          </span>
        )}
      </div>
      <p dir="auto" className="mt-2 line-clamp-2 px-0.5 text-start text-[13px] font-medium leading-tight text-fog-200 transition group-hover:text-fog-50">
        {item.title}
      </p>
      {note && <p data-card-note className="mt-0.5 truncate px-0.5 text-start text-[11px] leading-tight text-fog-500">{note}</p>}
    </>
  );
  const cls = 'group block w-32 shrink-0 [scroll-snap-align:start]';
  return mayAdd
    ? <Link href={findHref(item.title)} title={tr('Find it on your sources')} data-outside={item.anilistId} className={cls}>{face}</Link>
    : <div data-outside={item.anilistId} className={cls}>{face}</div>;
}

/** The series page's "Related", just above More like this: every relation the server keeps, held ones as themselves. */
export function RelatedRail({ seriesId }: { seriesId: string }) {
  const { user } = useAuth();
  const { data } = useRelated(seriesId);
  const rows = shownRows(data);
  if (!rows.length) return null;
  const mayAdd = canDownload(user);
  return (
    <section className="mt-10" data-related>
      <SectionTitle>{tr('Related')}</SectionTitle>
      <Rail>
        {rows.map((r) => (r.series
          ? <SeriesCard key={`s:${r.series.id}`} series={r.series} note={relationLabel(r.relation)} />
          : <OutsideCard key={`al:${r.outside!.anilistId}`} item={r.outside!} note={relationLabel(r.relation)} mayAdd={mayAdd} />))}
      </Rail>
    </section>
  );
}

/**
 * The reader's end card: what comes next in the story -- the sequels alone -- above "Because you finished this". The
 * reader mounts it only once the series is finished on the live list (never at the end of what is downloaded), so the
 * question is asked then and not before.
 */
export function NextInStory({ seriesId }: { seriesId: string }) {
  const { user } = useAuth();
  const { data } = useRelated(seriesId);
  const rows = shownRows(data, 'SEQUEL');
  if (!rows.length) return null;
  const mayAdd = canDownload(user);
  return (
    <div className="mt-12 text-start" data-next-in-story>
      <SectionTitle>{tr('Next in the story')}</SectionTitle>
      <Rail>
        {rows.map((r) => (r.series
          ? <SeriesCard key={`s:${r.series.id}`} series={r.series} />
          : <OutsideCard key={`al:${r.outside!.anilistId}`} item={r.outside!} mayAdd={mayAdd} />))}
      </Rail>
    </div>
  );
}
