'use client';
import { useId, type ReactNode } from 'react';
import { BADGE_METALS, type AvatarFrame as Frame } from '@/lib/badges';

/**
 * The frame round an avatar (v0.89.0, #267 part 3 by @CheetahDoesStuff): a badge's reward, cast in that badge's metal
 * (components/BadgeEmblem.tsx METALS), so a frame reads as the medal it came with. Reader's bronze ring is riveted,
 * Bookworm's silver one has its worm peeking over the rim, On a roll's ember ring burns with seven flames (one a day of
 * the streak), Centurion's gold one wears a laurel, Devoted's moonlight one a crescent and stars, and Legend's aurora
 * ring turns under a crown, in a halo.
 *
 * Drawn over the avatar and a little past it (12 % each side), so a framed avatar takes the room an unframed one does
 * and nothing around it moves. A view box of 120 units, the avatar's circle being r = 50 in it. Below 40 px only the
 * ring is drawn -- a comment's 22 px face has no room for a laurel -- and it moves only from 40 px up: the sheen that
 * passes over the metal now and then, the flames, Legend's turning ring and halo. Both of the app's motion switches stop
 * all of it, in CSS (app/globals.css `.frame-*`), so no avatar has to be told.
 */

export const FRAME_SCALE = 1.24;

const f = (n: number) => n.toFixed(2);
const at = (deg: number, r: number) => {
  const a = (Math.PI / 180) * deg;
  return { x: 60 + r * Math.cos(a), y: 60 + r * Math.sin(a) };
};
/** A four-point star, as the badges draw theirs. */
const star = (cx: number, cy: number, r: number) =>
  `M${f(cx)},${f(cy - r)} Q${f(cx)},${f(cy)} ${f(cx + r)},${f(cy)} Q${f(cx)},${f(cy)} ${f(cx)},${f(cy + r)} Q${f(cx)},${f(cy)} ${f(cx - r)},${f(cy)} Q${f(cx)},${f(cy)} ${f(cx)},${f(cy - r)} Z`;

/** Seconds into its cycle a frame's sheen starts, per metal: a board of framed faces does not shine in step. */
const SHEEN_DELAY: Record<Frame, number> = { bronze: 1.2, silver: 3.4, ember: 2.1, gold: 0.4, moon: 4.6, aurora: 2.8 };

interface Ids { rim: string; lite: string; gem: string; ring: string; sheen: string; flame: string; cut: string }

/** What sits on a frame besides its ring, from 40 px up. */
function Trim({ frame, ids }: { frame: Frame; ids: Ids }): ReactNode {
  const [L, M, D, E] = BADGE_METALS[frame];
  switch (frame) {
    case 'bronze': return (
      <g data-frame-trim>
        {/* Four rivets, struck into the rim. */}
        {[-45, 45, 135, 225].map((d) => {
          const p = at(d, 52);
          return <circle key={d} cx={f(p.x)} cy={f(p.y)} r="3" fill={`url(#${ids.lite})`} stroke={E} strokeWidth="0.9" />;
        })}
      </g>
    );
    case 'silver': return (
      <g data-frame-trim>
        {/* Polished: a second, finer ring outside the first, and a glint on each side. */}
        <circle cx="60" cy="60" r="57.6" fill="none" stroke={`url(#${ids.rim})`} strokeWidth="1.5" />
        {[[-58, 4.6], [122, 3.4]].map(([d, r]) => {
          const p = at(d, 58.2);
          return <path key={d} d={star(p.x, p.y, r)} fill={L} />;
        })}
      </g>
    );
    case 'ember': return (
      <g data-frame-trim>
        {/* Seven tongues of flame round the top of the rim, each flickering on its own beat. */}
        {[-150, -130, -110, -90, -70, -50, -30].map((d, i) => {
          const p = at(d, 53.4);
          const big = i === 3 ? 1.25 : i === 2 || i === 4 ? 1.1 : 0.92;
          return (
            <g key={d} transform={`translate(${f(p.x)} ${f(p.y)}) rotate(${f(d + 90)}) scale(${big})`}>
              <path className="frame-flicker" style={{ animationDelay: `${(i * 0.37) % 1.3}s` }}
                d="M0,1 C-3.4,-2.2 -3.2,-6.6 0,-11.5 C3.2,-6.6 3.4,-2.2 0,1 Z" fill={`url(#${ids.flame})`} />
            </g>
          );
        })}
      </g>
    );
    case 'gold': {
      // A laurel up both sides from the bottom, as Centurion's medal wears one.
      const leaves: ReactNode[] = [];
      for (const side of [-1, 1]) {
        for (let i = 0; i < 7; i++) {
          const deg = side < 0 ? 104 + i * 15 : 76 - i * 15;
          const p = at(deg, 56.2);
          const rot = deg + (side < 0 ? 64 : 116);
          leaves.push(<ellipse key={`${side}${i}`} cx={f(p.x)} cy={f(p.y)} rx="4.6" ry="1.9" transform={`rotate(${f(rot)} ${f(p.x)} ${f(p.y)})`}
            fill={`url(#${ids.lite})`} stroke={D} strokeWidth="0.45" />);
        }
      }
      const b = at(90, 55.5);
      return (
        <g data-frame-trim>
          {leaves}
          <circle cx={f(b.x)} cy={f(b.y)} r="2.6" fill={M} stroke={D} strokeWidth="0.6" />
        </g>
      );
    }
    case 'moon': {
      // A crescent on the rim at the top right, and stars round it.
      // Its horns point away from the face: the bite is taken from the outer side.
      const m = at(-45, 57.5);
      return (
        <g data-frame-trim>
          <mask id={ids.cut}><rect x="-20" y="-20" width="160" height="160" fill="#fff" /><circle cx={f(m.x + 5.2)} cy={f(m.y - 5)} r="9.6" fill="#000" /></mask>
          <circle cx={f(m.x)} cy={f(m.y)} r="11" fill={`url(#${ids.lite})`} stroke={E} strokeWidth="0.5" mask={`url(#${ids.cut})`} />
          {[[-84, 58.5, 3.8], [-8, 58, 3], [-118, 57, 2.4], [160, 57.5, 2.2], [30, 57.5, 1.8]].map(([d, r, sz]) => {
            const p = at(d, r);
            return <path key={d} d={star(p.x, p.y, sz)} fill={L} />;
          })}
        </g>
      );
    }
    case 'aurora': {
      // A crown set on the rim, its three gems the badge's.
      return (
        <g data-frame-trim>
          <path d="M45.5,10.5 L44,-3.5 L52.5,3.5 L60,-7.5 L67.5,3.5 L76,-3.5 L74.5,10.5 Z"
            fill={`url(#${ids.rim})`} stroke="#1d1257" strokeWidth="0.9" strokeLinejoin="round" />
          <path d="M46,8.2 H74" stroke="#1d1257" strokeOpacity="0.55" strokeWidth="0.8" />
          {[[44, -3.5, 2.1], [60, -7.5, 2.6], [76, -3.5, 2.1]].map(([cx, cy, r]) => (
            <circle key={cx} cx={f(cx)} cy={f(cy)} r={r} fill={`url(#${ids.gem})`} />
          ))}
        </g>
      );
    }
  }
}

export function AvatarFrameArt({ frame, size, locked = false }: {
  frame: Frame;
  /** The avatar's size in CSS pixels: the frame is drawn FRAME_SCALE times that, centred on it. */
  size: number;
  /** Shown as a frame not yet earned (the avatar editor): no glow, no movement, greyed. */
  locked?: boolean;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const ids: Ids = { rim: `${uid}r`, lite: `${uid}l`, gem: `${uid}g`, ring: `${uid}m`, sheen: `${uid}s`, flame: `${uid}f`, cut: `${uid}c` };
  const [L, M, D, E, glow] = BADGE_METALS[frame];
  const detail = size >= 40;
  const moving = detail && !locked;
  const aurora = frame === 'aurora';
  // Thin at a comment's size would vanish: the ring is a little bolder the smaller the face.
  const w = size < 28 ? 7 : size < 40 ? 5.6 : 4.8;
  const rimStops = aurora
    ? <><stop offset="0" stopColor="#bfefff" /><stop offset=".3" stopColor="#5ce1ff" /><stop offset=".55" stopColor="#9b7dff" /><stop offset=".8" stopColor="#ff6ad5" /><stop offset="1" stopColor="#5b3fd9" /></>
    : <><stop offset="0" stopColor={L} /><stop offset=".38" stopColor={M} /><stop offset=".72" stopColor={D} /><stop offset="1" stopColor={M} /></>;
  return (
    <span aria-hidden data-avatar-frame={frame} data-frame-locked={locked ? '' : undefined}
      className="pointer-events-none absolute isolate"
      style={{ inset: `${f(-((FRAME_SCALE - 1) / 2) * 100)}%`, ...(locked ? { filter: 'grayscale(1)', opacity: 0.38 } : {}) }}>
      {/* Legend's halo: an aurora behind the face, turning slowly. */}
      {aurora && moving && (
        <span data-frame-halo className="frame-halo absolute -inset-[6%] -z-10 rounded-full"
          style={{
            filter: 'blur(6px)',
            background: 'conic-gradient(from 0deg, rgba(92,225,255,.15), rgba(92,225,255,.85), rgba(155,125,255,.9), rgba(255,106,213,.85), rgba(92,225,255,.15))',
            // Round the face, never over it: the face is the middle 72 % of this span.
            maskImage: 'radial-gradient(closest-side, transparent 68%, #000 76%, #000 86%, transparent 100%)',
            WebkitMaskImage: 'radial-gradient(closest-side, transparent 68%, #000 76%, #000 86%, transparent 100%)',
          }} />
      )}
      <svg viewBox="0 0 120 120" className="block h-full w-full overflow-visible"
        style={!locked && size >= 28 ? { filter: `drop-shadow(0 0 ${size >= 40 ? 5 : 3}px ${glow})` } : undefined}>
        <defs>
          <linearGradient id={ids.rim} x1="0.1" y1="0" x2="0.9" y2="1">{rimStops}</linearGradient>
          <radialGradient id={ids.lite} cx="38%" cy="32%" r="75%">
            <stop offset="0" stopColor={L} /><stop offset=".55" stopColor={M} /><stop offset="1" stopColor={D} />
          </radialGradient>
          <radialGradient id={ids.gem} cx="35%" cy="35%" r="70%">
            <stop offset="0" stopColor="#ffffff" /><stop offset=".45" stopColor="#7fe9ff" /><stop offset="1" stopColor="#2a6cff" />
          </radialGradient>
          <linearGradient id={ids.flame} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor={D} /><stop offset=".5" stopColor={M} /><stop offset="1" stopColor={L} />
          </linearGradient>
          <linearGradient id={ids.sheen} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#fff" stopOpacity="0" /><stop offset=".5" stopColor="#fff" stopOpacity=".75" /><stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <mask id={ids.ring}><circle cx="60" cy="60" r="52" fill="none" stroke="#fff" strokeWidth={w} /></mask>
        </defs>
        {detail && <Trim frame={frame} ids={ids} />}
        {/* The ring: the metal, a dark edge outside it and a bright one inside, as a struck rim catches the light. */}
        <g className={aurora && moving ? 'frame-spin' : undefined} style={aurora && moving ? { transformOrigin: '60px 60px' } : undefined}>
          <circle data-frame-ring cx="60" cy="60" r="52" fill="none" stroke={`url(#${ids.rim})`} strokeWidth={w} />
        </g>
        <circle cx="60" cy="60" r={f(52 + w / 2)} fill="none" stroke={E} strokeOpacity="0.85" strokeWidth="0.8" />
        <circle cx="60" cy="60" r={f(52 - w / 2)} fill="none" stroke={L} strokeOpacity="0.55" strokeWidth="0.7" />
        {moving && (
          <g mask={`url(#${ids.ring})`}>
            <rect data-frame-sheen className="frame-sheen" style={{ animationDelay: `${SHEEN_DELAY[frame]}s` }}
              x="-80" y="-20" width="38" height="160" fill={`url(#${ids.sheen})`} />
          </g>
        )}
      </svg>
    </span>
  );
}
