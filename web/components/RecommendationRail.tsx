'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { Img, Reveal } from '@/components/ui';
import { sourceCover } from '@/components/cards';
import { ScrollRail, CARD_RAIL } from '@/components/ScrollRail';
import { IcPlus } from '@/components/icons';
import { badgeOf, becauseOf, pollAfter, provenance, type Recommendation, type Recommendations } from '@/lib/recommendations';

function RecCard({ r, onPick }: { r: Recommendation; onPick: (r: Recommendation) => void }) {
  const because = becauseOf(r);
  return (
    <button type="button" onClick={() => onPick(r)} title={provenance(r)} className="group w-36 shrink-0 snap-start text-start lg:w-40">
      <div className="grad-border relative aspect-[2/3] overflow-hidden rounded-2xl border border-ink-700/60 transition-all duration-300 group-hover:-translate-y-1 group-hover:shadow-glow">
        <Img src={sourceCover(undefined, r.cover)} alt="" fallbackSrc={r.cover || undefined}
          className="h-full w-full" imgClassName="transition-transform duration-500 group-hover:scale-[1.06]" />
        <span className="absolute start-1.5 top-1.5 rounded-md bg-ink-950/80 px-1.5 py-0.5 text-[10px] font-semibold text-fog-100 backdrop-blur">{badgeOf(r)}</span>
        {r.score != null && (
          <span className="absolute end-1.5 top-1.5 rounded-md bg-ink-950/80 px-1.5 py-0.5 text-[11px] font-semibold text-accent backdrop-blur">{r.score}%</span>
        )}
        <span aria-hidden className="absolute bottom-1.5 end-1.5 grid size-7 place-items-center rounded-full bg-accent text-black shadow-glow transition group-hover:scale-110">
          <IcPlus width={15} height={15} />
        </span>
      </div>
      <p className="mt-1.5 line-clamp-2 text-xs font-medium leading-tight text-fog-300 transition group-hover:text-fog-100">{r.title}</p>
      {because && <p className="mt-0.5 line-clamp-1 text-[11px] leading-tight text-fog-500">{tr('Because you read {title}', { title: because })}</p>}
    </button>
  );
}

/**
 * Discover's "Recommended for you": titles AniList and MyAnimeList readers pair with the ones this person
 * rated highest, minus everything already on their lists or in the library. Shows nothing at all when no
 * tracker is connected or nothing is left to suggest, so an account that never connected one sees no change.
 * The server does the caching (a day's old answer is normal), so this asks once per visit and only polls
 * while a first-time refresh is still running there.
 */
export function RecommendationRail({ enabled, onPick }: {
  enabled: boolean;
  onPick: (title: string) => void;
}) {
  const { data } = useQuery({
    queryKey: ['discover-recommendations'],
    queryFn: () => api<Recommendations>('/api/discover/recommendations'),
    enabled,
    staleTime: 10 * 60_000,
    refetchInterval: (q) => pollAfter(q.state.data, q.state.dataUpdateCount),
  });
  const items = data?.content ?? [];
  if (!items.length) return null;
  return (
    <section className="pt-5 pb-1">
      <h2 className="mb-3 font-display text-lg font-semibold tracking-tight text-fog-50 lg:text-xl">{tr('Recommended for you')}</h2>
      <ScrollRail label={tr('Recommended for you')} className={CARD_RAIL}>
        {items.map((r, i) => (
          <Reveal key={r.title} delay={Math.min(i, 12) * 28}>
            <RecCard r={r} onPick={(x) => onPick(x.title)} />
          </Reveal>
        ))}
      </ScrollRail>
    </section>
  );
}
