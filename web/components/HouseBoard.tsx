'use client';
import { Avatar, type AvatarData } from '@/components/Avatar';
import { SpineWall } from '@/components/SpineWall';
import { t as tr } from '@/lib/i18n';

export interface HouseMember {
  id: string;
  display_name: string;
  avatar?: AvatarData | null;
  week: number;
  total: number;
}

/**
 * Who in the house is reading this week.
 *
 * The solo case is the common one on a self-hosted server, and a leaderboard of one is a joke at the
 * owner's expense -- so with a single account the card becomes "you, this week": your face, your count and
 * the covers you finished. A second account turns it into the leaderboard with no other code path.
 *
 * Covers appear for YOUR row only, and only from your own history. `/api/leaderboard` has no per-user
 * scoping, so putting "what they are reading" in it would broadcast every member's current series to
 * everyone on the server with no way to opt out. Faces and counts, exactly as today.
 */
export function HouseBoard({ members, youId, weekCovers = [], weekTitles = [], span = '' }: {
  members: HouseMember[];
  youId: string;
  /** your own finished-this-week series ids; the solo variant only */
  weekCovers?: string[];
  /** their titles, same order. Without them every spine is a link announced as the literal word "Series",
   *  and this is the variant that runs on a one-account server, which is most of them. */
  weekTitles?: string[];
  /** board span class, e.g. `wide` -- the card is the grid child, so it carries it itself */
  span?: string;
}) {
  if (!members.length) return null;
  const ranked = [...members].sort((a, b) => b.week - a.week);
  const solo = ranked.length === 1;
  const you = ranked.find((m) => m.id === youId) ?? ranked[0];

  return (
    <div className={`card grad-border p-4 ${span}`}>
      <h2 className="mb-3 font-display text-base font-semibold">{tr('This week in your library')}</h2>

      {solo ? (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
          <div className="flex items-center gap-3">
            <Avatar avatar={you.avatar} size={52} />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-fog-50">{you.display_name}</p>
              <p className="font-display text-xl font-bold tabular-nums text-accent">{you.week}</p>
            </div>
          </div>
          {/* No label: the card heading above it already is the label.
              `overflow-x-auto` even at lg, unlike the hero's shelf: eight overlapped covers are ~600px of
              content in a ~470px card, and SpineWall's own wrapper goes `lg:overflow-visible` because that
              is right in a hero with room to spare. Here it painted the shelf straight out of the card and
              over the one beside it, spines first because they carry a positive z-index. */}
          <SpineWall className="min-w-0 flex-1" contained ids={weekCovers} titles={weekTitles} label="" />
        </div>
      ) : (
        <div className="flex flex-wrap gap-5 sm:grid sm:grid-cols-4">
          {ranked.map((m, i) => (
            <div key={m.id} className="relative min-w-0">
              {/* The hollow numeral the Top 10 rail uses. One leader, so it marks the leader and nothing else. */}
              {i === 0 && (
                <span aria-hidden className="rank-numeral absolute -start-3 -top-4 select-none font-display text-[64px] font-black leading-none">1</span>
              )}
              <div className="relative flex items-center gap-3">
                <Avatar avatar={m.avatar} size={52} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-fog-100">
                    {m.display_name}
                    {m.id === youId && <span className="ms-2 rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-semibold text-accent">{tr('You')}</span>}
                  </p>
                  <p className="font-display text-xl font-bold tabular-nums text-accent">{m.week}</p>
                  {/* `total` comes back from /api/leaderboard already and was being thrown away. */}
                  <p className="text-[11px] tabular-nums text-fog-500">{m.total}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
