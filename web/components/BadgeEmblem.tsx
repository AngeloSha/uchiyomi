'use client';
import { useId, type ReactNode } from 'react';
import { t as tr } from '@/lib/i18n';
import { BADGE_METALS, type Badge } from '@/lib/badges';

/**
 * A badge's emblem (v0.75.0, the owner's approved design): drawn in code, so it is sharp at any size and needs nothing
 * downloaded. Chapter badges are hexagon medals that climb through metals -- Reader bronze with a book, Bookworm silver
 * with a stack of books and a worm, Centurion gold with 100 in a laurel, Legend an aurora with a crown and a slow halo.
 * Streak badges are round medals with one rim notch per day -- On a roll ember with a flame (7), Devoted moonlight with
 * a moon and stars (30). Locked, a medal is ink with its glyph outlined, and says how close the reader is: a ring in the
 * accent round a chapter badge, the days already done lit in the accent on a streak's rim. The geometry is the approved
 * page's generator, number for number, on a 120-unit view box.
 *
 * The sheen and Legend's turning halo move only when `still` is false: the caller says so from both of the app's motion
 * gates (Reduce effects and the system's reduced motion, BadgesCard). It is a prop rather than read here because their
 * stores answer `false` to a server render, which is where the tests draw this. Gradient, clip and mask ids come from
 * useId, so two emblems on a page never paint with each other's gradients.
 */

// light, mid, dark, edge, glow: lib/badges.ts, shared with the avatar frames (v0.89.0).
const METALS = BADGE_METALS;
const LOCK = ['#5d5d6c', '#30303b', '#1c1c24', '#2b2b35'];
/** The reader's accent, never a colour of its own: progress is the app's accent wherever the reader set it. */
const ACCENT = 'var(--color-accent)';
/** The ring a locked chapter badge fills: its circumference, at r = 57. */
export const RING = 2 * Math.PI * 57;

const f = (n: number) => n.toFixed(2);
const hexPts = (r: number) => Array.from({ length: 6 }, (_, i) => {
  const a = (Math.PI / 180) * (60 * i - 90);
  return `${f(60 + r * Math.cos(a))},${f(60 + r * Math.sin(a))}`;
}).join(' ');
const star = (cx: number, cy: number, r: number) =>
  `M${cx},${cy - r} Q${cx},${cy} ${cx + r},${cy} Q${cx},${cy} ${cx},${cy + r} Q${cx},${cy} ${cx - r},${cy} Q${cx},${cy} ${cx},${cy - r} Z`;

interface Ids { g: string; m: string; gem: string }

/** What a badge's plate carries: filled with its metal when earned, outlined in ink when not. */
function Glyph({ badge, on, ids }: { badge: Badge; on: boolean; ids: Ids }): ReactNode {
  const fill = on ? `url(#${ids.g})` : 'none';
  const line = on ? 'none' : LOCK[0];
  const ink = on ? 'rgba(10,10,14,.55)' : 'none';
  const lite = on ? METALS[badge.metal][0] : 'none';
  const sw = { strokeWidth: 1.6, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const };
  switch (badge.glyph) {
    case 'book': return (
      <>
        <path d="M60,50 C53,45.5 44,44.5 37,46 L37,73 C44,71.8 53,72.6 60,77 Z" fill={fill} stroke={line} {...sw} />
        <path d="M60,50 C67,45.5 76,44.5 83,46 L83,73 C76,71.8 67,72.6 60,77 Z" fill={fill} stroke={line} {...sw} />
        <path d="M42,53.5 C47,52.5 51,53 55,55 M42,59.5 C47,58.5 51,59 55,61 M42,65.5 C47,64.5 51,65 55,67 M78,53.5 C73,52.5 69,53 65,55 M78,59.5 C73,58.5 69,59 65,61 M78,65.5 C73,64.5 69,65 65,67"
          fill="none" stroke={on ? ink : LOCK[0]} strokeWidth={1.4} strokeLinecap="round" opacity={on ? 1 : 0.6} />
        <path d="M60,50 L60,77" stroke={on ? ink : LOCK[0]} strokeWidth={1.4} />
      </>
    );
    case 'worm': return (
      <>
        <rect x="37" y="67" width="46" height="9" rx="2.2" fill={fill} stroke={line} {...sw} />
        <rect x="41" y="57" width="40" height="9" rx="2.2" fill={fill} stroke={line} {...sw} />
        <rect x="35" y="47" width="44" height="9" rx="2.2" fill={fill} stroke={line} {...sw} />
        <path d="M43,67 V76 M75,67 V76 M47,57 V66 M74,57 V66 M41,47 V56 M72,47 V56" stroke={on ? ink : LOCK[0]} strokeWidth={1.3} />
        <path d="M66,47 C65,41 70,37 75,38.5" fill="none" stroke={on ? `url(#${ids.g})` : LOCK[0]} strokeWidth={on ? 5.5 : 1.6} strokeLinecap="round" />
        <circle cx="78" cy="39.5" r={on ? 4 : 3} fill={on ? `url(#${ids.g})` : 'none'} stroke={on ? 'none' : LOCK[0]} strokeWidth={1.4} />
        <circle cx="79.3" cy="38.7" r={on ? 1.1 : 0.8} fill={on ? '#0a0a0e' : LOCK[0]} />
      </>
    );
    case 'flame': return (
      <>
        <path d="M60,37 C66,47 75,52 73,65.5 C72,76 66,82 60,82 C54,82 47,77 47,67 C47,59 52,55 55,49.5 C56,56 58,59 61,59 C60,52 58,44.5 60,37 Z" fill={fill} stroke={line} {...sw} />
        <path d="M60,60 C64,65 67,68 66,73 C65,78 63,80 60,80 C57,80 54,78 54,73 C54,69 57,67 58,64 C58,67 59,68 60,68 C60,65 59,63 60,60 Z" fill={on ? lite : 'none'} stroke={on ? 'none' : LOCK[0]} {...sw} />
      </>
    );
    case 'moon': return (
      <>
        <mask id={ids.m}><rect x="0" y="0" width="120" height="120" fill="#fff" /><circle cx="67" cy="54" r="17" fill="#000" /></mask>
        <circle cx="57" cy="61" r="20" fill={fill} stroke={line} strokeWidth={1.6} mask={`url(#${ids.m})`} />
        {!on && <circle cx="67" cy="54" r="17" fill="none" stroke={LOCK[0]} strokeWidth={1.6} strokeDasharray="2 3" opacity={0.35} />}
        <path d={`${star(77, 43, 5.2)} ${star(82, 60, 3.3)} ${star(71, 73, 2.4)}`} fill={on ? lite : 'none'} stroke={on ? 'none' : LOCK[0]} strokeWidth={1.2} strokeLinejoin="round" />
      </>
    );
    case 'laurel': {
      const leaves: ReactNode[] = [];
      for (const side of [-1, 1]) {
        for (let i = 0; i < 6; i++) {
          const deg = side < 0 ? 122 + i * 22 : 58 - i * 22;
          const a = (Math.PI / 180) * deg;
          const x = 60 + 28 * Math.cos(a), y = 62 + 28 * Math.sin(a);
          const rot = deg + (side < 0 ? 72 : 108);
          leaves.push(<ellipse key={`${side}${i}`} cx={f(x)} cy={f(y)} rx="4.6" ry="2" transform={`rotate(${f(rot)} ${f(x)} ${f(y)})`} fill={fill} stroke={line} strokeWidth={1.1} />);
        }
      }
      return (
        <>
          {leaves}
          <text x="60" y="68.5" textAnchor="middle" className="font-display" fontWeight={700} fontSize={19} letterSpacing={-0.5}
            fill={fill} stroke={line} strokeWidth={on ? 0 : 0.9}>100</text>
        </>
      );
    }
    case 'crown': return (
      <>
        <path d="M40,71 L43,47 L52,58 L60,41 L68,58 L77,47 L80,71 Z" fill={fill} stroke={line} {...sw} />
        <rect x="40" y="70" width="40" height="8" rx="2.5" fill={fill} stroke={line} {...sw} />
        {on && <><circle cx="50" cy="74" r="1.6" fill={ink} /><circle cx="60" cy="74" r="1.9" fill={ink} /><circle cx="70" cy="74" r="1.6" fill={ink} /></>}
        <circle cx="43" cy="46" r="3" fill={on ? `url(#${ids.gem})` : 'none'} stroke={on ? 'none' : LOCK[0]} strokeWidth={1.2} />
        <circle cx="60" cy="40" r="3.6" fill={on ? `url(#${ids.gem})` : 'none'} stroke={on ? 'none' : LOCK[0]} strokeWidth={1.2} />
        <circle cx="77" cy="46" r="3" fill={on ? `url(#${ids.gem})` : 'none'} stroke={on ? 'none' : LOCK[0]} strokeWidth={1.2} />
      </>
    );
  }
}

export function BadgeEmblem({ badge, earned: on, have, size, detail = size > 40, still, delay = 0 }: {
  badge: Badge;
  earned: boolean;
  /** Where the reader stands on the badge's measure: chapters finished, or the longest streak in days. */
  have: number;
  /** In CSS pixels; the emblem is square. */
  size: number;
  /** The goal's tab under the medal ("10", "7 days"): only where there is room for it, above 40 px by default. */
  detail?: boolean;
  /** Reduce effects or the system's reduced motion: no sheen, and Legend's halo holds still. */
  still: boolean;
  /** Seconds before the sheen first passes, so a row of emblems does not shine in step. */
  delay?: number;
}) {
  // React's ids carry characters a url(#…) reference should not have to quote; the letters and digits are unique enough.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const ids = { g: `${uid}g`, rim: `${uid}r`, plate: `${uid}p`, clip: `${uid}c`, sheen: `${uid}s`, m: `${uid}m`, gem: `${uid}j` };
  const [L, M, D, E, glow] = METALS[badge.metal];
  const hex = badge.kind === 'chapters';
  const legend = badge.metal === 'aurora';

  // Streak rims: one notch per day. Locked, the days already done light in the accent.
  const notches: ReactNode[] = [];
  if (!hex) {
    const count = badge.goal, lit = on ? count : Math.min(Math.max(0, have), count);
    const len = count > 10 ? 5 : 6, w = count > 10 ? 2.2 : 5.5;
    for (let i = 0; i < count; i++) {
      const deg = -90 + (360 / count) * i;
      const isLit = i < lit;
      notches.push(
        <rect key={i} data-notch={isLit ? 'lit' : ''} x={f(60 - w / 2)} y={f(60 - 45.5 - len / 2)} width={w} height={len} rx={f(Math.min(w, len) / 2)}
          fill={on ? L : isLit ? undefined : LOCK[1]} style={!on && isLit ? { fill: ACCENT } : undefined}
          opacity={on ? 0.9 : 1} transform={`rotate(${f(deg + 90)} 60 60)`} />,
      );
    }
  }

  // Chapter badges, locked: a thin ring in the accent says how far along.
  const p = Math.max(0, Math.min(1, have / badge.goal));

  const tabText = badge.kind === 'streak' ? tr('{n} days', { n: badge.goal }) : String(badge.goal);
  const tabW = badge.kind === 'streak' ? Math.max(36, tabText.length * 4.3 + 6) : tabText.length * 6.4 + 12;

  const metalStops = on
    ? (legend
      ? <><stop offset="0" stopColor="#5ce1ff" /><stop offset=".5" stopColor="#9b7dff" /><stop offset="1" stopColor="#ff6ad5" /></>
      : <><stop offset="0" stopColor={L} /><stop offset=".55" stopColor={M} /><stop offset="1" stopColor={D} /></>)
    : <><stop offset="0" stopColor={LOCK[0]} /><stop offset="1" stopColor={LOCK[1]} /></>;
  const rimStops = on
    ? (legend
      ? <><stop offset="0" stopColor="#bfefff" /><stop offset=".35" stopColor="#9b7dff" /><stop offset=".7" stopColor="#5b3fd9" /><stop offset="1" stopColor="#ff6ad5" /></>
      : <><stop offset="0" stopColor={L} /><stop offset=".4" stopColor={M} /><stop offset=".75" stopColor={D} /><stop offset="1" stopColor={M} /></>)
    : <><stop offset="0" stopColor="#2a2a33" /><stop offset="1" stopColor="#16161c" /></>;

  return (
    <span data-emblem={on ? 'earned' : 'locked'} aria-hidden className="relative isolate inline-grid shrink-0 place-items-center"
      style={{ width: size, height: size }}>
      {/* Legend's halo: an aurora behind the medal, turning slowly, still under either motion switch. */}
      {legend && on && (
        <span data-emblem-halo className={`absolute -inset-[14%] -z-10 ${still ? '' : 'badge-halo'}`}
          style={{
            borderRadius: '50%', filter: 'blur(14px)',
            background: 'conic-gradient(from 0deg, rgba(92,225,255,.0), rgba(92,225,255,.35), rgba(155,125,255,.45), rgba(255,106,213,.35), rgba(92,225,255,.0))',
          }} />
      )}
      <svg viewBox="0 0 120 120" className="block h-full w-full overflow-visible"
        style={on ? { filter: `drop-shadow(0 6px 16px ${glow})` } : undefined}>
        <defs>
          <linearGradient id={ids.g} x1="0" y1="0" x2="1" y2="1">{metalStops}</linearGradient>
          <linearGradient id={ids.rim} x1="0.1" y1="0" x2="0.9" y2="1">{rimStops}</linearGradient>
          <radialGradient id={ids.plate} cx="50%" cy="38%" r="70%">
            <stop offset="0" stopColor={on ? '#20202b' : '#121218'} /><stop offset="1" stopColor={on ? '#08080c' : '#070709'} />
          </radialGradient>
          <radialGradient id={ids.gem} cx="35%" cy="35%" r="70%">
            <stop offset="0" stopColor="#ffffff" /><stop offset=".45" stopColor="#7fe9ff" /><stop offset="1" stopColor="#2a6cff" />
          </radialGradient>
          <linearGradient id={ids.sheen} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#fff" stopOpacity="0" /><stop offset=".5" stopColor="#fff" stopOpacity=".5" /><stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <clipPath id={ids.clip}>{hex ? <polygon points={hexPts(52.5)} strokeLinejoin="round" /> : <circle cx="60" cy="60" r="52" />}</clipPath>
        </defs>
        {hex && !on && (
          <>
            <circle cx="60" cy="60" r="57" fill="none" strokeWidth={3} style={{ stroke: 'var(--color-ink-700)' }} />
            <circle data-emblem-ring cx="60" cy="60" r="57" fill="none" strokeWidth={3} strokeLinecap="round"
              strokeDasharray={`${f(RING * p)} ${f(RING)}`} transform="rotate(-90 60 60)" style={{ stroke: ACCENT }} />
          </>
        )}
        {hex
          ? <polygon points={hexPts(50)} fill={`url(#${ids.rim})`} stroke={on ? E : LOCK[3]} strokeWidth={5} strokeLinejoin="round" />
          : <circle cx="60" cy="60" r="51" fill={`url(#${ids.rim})`} stroke={on ? E : LOCK[3]} strokeWidth={2} />}
        {notches}
        {hex
          ? <polygon points={hexPts(40)} fill={`url(#${ids.plate})`} stroke={on ? M : LOCK[1]} strokeOpacity={on ? 0.55 : 1} strokeWidth={1.4} strokeLinejoin="round" />
          : <circle cx="60" cy="60" r="37" fill={`url(#${ids.plate})`} stroke={on ? M : LOCK[1]} strokeOpacity={on ? 0.55 : 1} strokeWidth={1.4} />}
        <Glyph badge={badge} on={on} ids={ids} />
        {/* The sheen, as the approved page draws it: the animation's transform takes the place of the rotate while it runs,
            so the band sweeps upright across the medal; before its first pass it waits rotated, outside the clip. */}
        {on && !still && (
          <g clipPath={`url(#${ids.clip})`}>
            <rect data-emblem-sheen className="badge-sheen" style={{ animationDelay: `${delay}s` }} x="-70" y="-30" width="34" height="180"
              fill={`url(#${ids.sheen})`} transform="rotate(18 60 60)" />
          </g>
        )}
        {detail && (
          <g data-emblem-tab>
            <rect x={f(60 - tabW / 2)} y="99" width={f(tabW)} height="14" rx="7" fill={on ? `url(#${ids.g})` : LOCK[2]} stroke={on ? E : LOCK[3]} strokeWidth={1} />
            <text x="60" y="109" textAnchor="middle" fontWeight={700} fontSize={badge.kind === 'streak' ? 7.6 : 8.4}
              letterSpacing={0.2} fill={on ? '#14110c' : LOCK[0]}>{tabText}</text>
          </g>
        )}
      </svg>
    </span>
  );
}
