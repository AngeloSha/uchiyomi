'use client';
import { motion } from 'framer-motion';
import { img } from '@/lib/api';
import { Img } from './ui';

/**
 * A phone's hero art (UI refresh, phone pass): the series' cover, filling the hero -- real art, nothing blurred, the
 * 1600-px copy so a 3x screen gets every pixel. A 2:3 cover the screen's width is the shape of a phone held upright, so
 * the hero around it is `h-[min(150vw,82svh)]`: a wide banner, or the automatic strips, showed a slice of their middle
 * there. The series page's hero (v0.67.0) and Home's (v0.67.1). Drifting slowly closer and back, unless Reduce effects
 * or the system's reduced motion is on (`still`), where it is simply there.
 */
export function PhoneHeroCover({ id, version, still }: { id: string; version?: number; still: boolean }) {
  return (
    <motion.div className="absolute inset-0" initial={false}
      animate={still ? { scale: 1 } : { scale: [1, 1.07] }}
      transition={still ? { duration: 0 } : { duration: 24, ease: 'easeInOut', repeat: Infinity, repeatType: 'reverse' }}>
      <Img src={img.seriesThumb(id, version, 1600)} alt="" eager className="h-full w-full" imgClassName="object-cover object-top" />
    </motion.div>
  );
}
