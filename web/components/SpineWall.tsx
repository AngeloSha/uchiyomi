'use client';
import Link from 'next/link';
import { motion, useReducedMotion } from 'framer-motion';
import { img } from '@/lib/api';
import { Img } from '@/components/ui';
import { t as tr } from '@/lib/i18n';

/**
 * The covers you have actually been holding, stacked like books pulled halfway off a shelf.
 *
 * A row of overlapping spines rather than a grid because it is correct at every length: one cover is a
 * book, three are a short shelf, twelve are a shelf. A 2x2 mosaic holding one cover looks broken, which is
 * the state a new library spends its first week in.
 *
 * Everything directional is logical (`-ms`, `pe`, an `rtl:` shadow), so under Arabic the shelf stacks from
 * the other edge and still reads newest-in-front instead of tearing open on one side.
 */
export function SpineWall({ ids, label, titles, className = '', contained = false }: {
  /** series ids, most recently read first, deduped and capped by the caller */
  ids: string[];
  label: string;
  /** optional, same order as `ids`: an id cannot name a link, so without these each spine is just "series" */
  titles?: string[];
  className?: string;
  /**
   * Keep the shelf scrollable at desktop widths instead of letting it run.
   *
   * The default goes `lg:overflow-visible` so the hero's spines can lift out of their box on hover. Inside
   * a board card there is no room for that: eight overlapped covers are ~600px of content in a ~470px card,
   * and the spines carry a positive z-index, so they painted over the card beside them.
   */
  contained?: boolean;
}) {
  const still = useReducedMotion();
  if (!ids.length) return null;

  return (
    <div className={className}>
      {/* Empty label = the shelf sits under a heading that already says this, e.g. inside HouseBoard. */}
      {label && <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fog-500">{label}</p>}
      <div className={`-me-4 hide-scrollbar overflow-x-auto pe-4 ${contained ? '' : 'lg:me-0 lg:overflow-visible lg:pe-0'}`} data-lenis-prevent>
        <div className="flex">
          {ids.map((id, i) => (
            <motion.div
              key={id}
              // The inline z-index is what makes the newest cover the front one; a plain `hover:z-30` class
              // would lose to it, hence the important modifier.
              style={{ zIndex: ids.length - i }}
              className={`relative shrink-0 hover:!z-30 ${i ? '-ms-5 lg:-ms-6' : ''}`}
              initial={still ? false : { opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, delay: still ? 0 : 0.14 + i * 0.035, ease: [0.22, 0.61, 0.36, 1] }}
            >
              <Link href={`/series/?id=${encodeURIComponent(id)}`} aria-label={titles?.[i] || tr('Series')}
                className="block transition-transform duration-300 hover:-translate-y-2 hover:scale-[1.06]">
                <Img src={img.seriesThumb(id)} alt=""
                  className="aspect-[2/3] h-24 rounded-lg border border-white/10 shadow-[10px_0_22px_-8px_rgba(0,0,0,0.95)] lg:h-36 rtl:shadow-[-10px_0_22px_-8px_rgba(0,0,0,0.95)]" />
              </Link>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}
